/**
 * server/chrome.mjs — 零依赖 Chrome DevTools Protocol 驱动。
 *
 * 为什么手写 CDP 而不是装 puppeteer/playwright：
 *   · 本机已有 Playwright 缓存的 `chrome-headless-shell`，但版本与任何 npm 包都不必
 *     匹配——我们只要 URL、协议是稳定的；
 *   · Node ≥22 内置了全局 `WebSocket`，连"需要一个 WebSocket 库"的理由也没有了；
 *   · 后台是常驻进程，依赖为 0 意味着 npm 装坏了也照样能渲染。
 *
 * 提供的能力（正是高质量 PNG 导出所需）：
 *   · 真 DPI 截图：`Emulation.setDeviceMetricsOverride({deviceScaleFactor})`
 *   · 精确裁剪：把 `#mdp-root` 的 border-box 作为 clip，导出「数学卡片」尺寸恰好
 *   · 透明背景：`Emulation.setDefaultBackgroundColorOverride` alpha=0
 *   · 超长页面：`captureBeyondViewport`
 *   · HTML → PDF：`Page.printToPDF`，纸张尺寸/页边距与 CSS 由同一组参数驱动
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TMP_DIR, IS_MAC, IS_LINUX, which, uid, run } from './util.mjs';

/* --------------------------------------------------------- 二进制定位 --- */

function globOne(dir, pattern, depth = 3) {
  // 极简 glob：只支持 * 与 ** 的目录展开，够用且不引依赖。
  const walk = (d, parts, level) => {
    if (level > depth) return null;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    const [head, ...rest] = parts;
    if (!head) return null;
    const re = new RegExp(`^${head.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    for (const e of entries) {
      if (!re.test(e.name)) continue;
      const full = path.join(d, e.name);
      if (rest.length === 0) return full;
      const found = walk(full, rest, level + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(dir, pattern.split('/'), 0);
}

function existing(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      const st = fs.statSync(c);
      if (st.isFile()) { fs.accessSync(c, fs.constants.X_OK); return c; }
    } catch { /* 换下一个 */ }
  }
  return null;
}

const HOME = os.homedir();

/**
 * 按优先级寻找 Chromium 系浏览器。
 * @returns {{path:string, source:string, kind:'headless-shell'|'full'} | null}
 */
export function findChrome() {
  const envPath = process.env.MDP_CHROME || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    const p = existing(envPath);
    if (p) return { path: p, source: 'MDP_CHROME 环境变量', kind: 'full' };
  }

  // 1) Playwright 缓存（本机已有）
  const pwRoots = IS_MAC
    ? [path.join(HOME, 'Library', 'Caches', 'ms-playwright')]
    : [path.join(HOME, '.cache', 'ms-playwright')];
  for (const root of pwRoots) {
    if (!fs.existsSync(root)) continue;
    let versions;
    try { versions = fs.readdirSync(root); } catch { continue; }
    // 新版本优先
    versions.sort().reverse();
    for (const v of versions) {
      if (!v.startsWith('chromium')) continue;
      const dir = path.join(root, v);
      const rels = [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
      ];
      const hit = existing(...rels.map((r) => path.join(dir, r)));
      if (hit) return { path: hit, source: `Playwright 缓存 (${v})`, kind: hit.includes('headless-shell') ? 'headless-shell' : 'full' };
    }
  }

  // 2) Puppeteer 缓存
  const ppRoot = IS_MAC ? path.join(HOME, '.cache', 'puppeteer') : path.join(HOME, '.cache', 'puppeteer');
  if (fs.existsSync(ppRoot)) {
    const hit = globOne(ppRoot, 'chrome/*/chrome-*/**/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 5)
      || globOne(ppRoot, 'chrome/*/chrome-*/chrome-*/chrome', 5);
    const p = existing(hit);
    if (p) return { path: p, source: 'Puppeteer 缓存', kind: 'full' };
  }

  // 3) 系统安装的浏览器
  const appPaths = IS_MAC
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
        path.join(HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ]
    : [
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
        '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
      ];
  const app = existing(...appPaths);
  if (app) return { path: app, source: '系统安装', kind: 'full' };

  // 4) PATH
  for (const name of ['chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    const p = which(name);
    if (p) return { path: p, source: 'PATH', kind: name === 'chrome-headless-shell' ? 'headless-shell' : 'full' };
  }
  return null;
}

export async function chromeVersion(binary) {
  try {
    const r = await run(binary, ['--version'], { timeoutMs: 6000 });
    return (r.stdout || r.stderr).trim().split('\n')[0] || null;
  } catch { return null; }
}

/* ---------------------------------------------------------- CDP 客户端 --- */

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) for (const cb of [...cbs]) cb(msg.params, msg.sessionId);
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(`CDP 连接失败: ${e?.message || 'unknown'}`)); }, { once: true });
    });
    return new CdpConnection(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); } catch (err) { this.pending.delete(id); reject(err); }
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(cb);
    return () => this.listeners.get(method)?.delete(cb);
  }

  waitFor(method, timeoutMs = 15000, sessionId) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, sid) => {
        if (sessionId && sid && sid !== sessionId) return;
        clearTimeout(t); off(); resolve(params);
      });
      const t = setTimeout(() => { off(); reject(new Error(`等待 CDP 事件超时: ${method}`)); }, timeoutMs);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------ 浏览器 --- */

const LAUNCH_ARGS = [
  '--headless',
  // 本机 / CI / 容器中 Chromium 自带的沙箱常常无法初始化（"sandbox initialization
  // failed: Operation not permitted"，随后 GPU 进程 FATAL 退出）。它只加载我们
  // 自己生成的本地页面，因此关闭 Chromium 沙箱是安全且必要的。
  '--no-sandbox',
  // 注意：这里**不**加 --disable-gpu / --disable-gpu-sandbox /
  // --disable-software-rasterizer。实测（scripts/bench.mjs，10 万字符文档）这些
  // 开关把每帧的 blocking 时间从数十毫秒推到 300~400ms：光栅化退化成纯 CPU 慢
  // 路径，测出来的交互延迟完全失真。保留默认光栅化不影响截图正确性。
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-translate',
  '--mute-audio',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  '--user-data-dir=',
];

export class ChromePool {
  /**
   * @param {{maxPages?:number, idleShutdownMs?:number, log?:(level:string,msg:string)=>void}} [opts]
   */
  constructor(opts = {}) {
    this.maxPages = opts.maxPages ?? 3;
    this.idleShutdownMs = opts.idleShutdownMs ?? 10 * 60 * 1000;
    this.log = opts.log || (() => {});
    this.info = findChrome();
    this.proc = null;
    this.cdp = null;
    this.port = null;
    this.userDataDir = null;
    this.launching = null;
    this.active = 0;
    this.idleTimer = null;
    this.version = null;
  }

  get available() { return Boolean(this.info); }

  async ensure() {
    if (this.cdp && !this.cdp.closed && this.proc && this.proc.exitCode === null) return this;
    if (this.launching) { await this.launching; return this; }
    this.launching = this.#launch().finally(() => { this.launching = null; });
    await this.launching;
    return this;
  }

  async #launch() {
    if (!this.info) throw new Error('未找到 Chromium/Chrome 可执行文件（可用 MDP_CHROME 指定路径）');
    await fsp.mkdir(TMP_DIR, { recursive: true });
    this.userDataDir = await fsp.mkdtemp(path.join(TMP_DIR, 'chrome-'));
    const args = [
      ...LAUNCH_ARGS,
      // 允许用环境变量追加启动参数，便于在不同机器上复现性能差异
      ...(process.env.MDP_CHROME_ARGS ? process.env.MDP_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${this.userDataDir}`,
      'about:blank',
    ];
    this.log('debug', `启动 Chrome: ${this.info.path}`);
    this.proc = spawn(this.info.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (c) => {
      const text = c.toString('utf8').trim();
      if (text && /error|fail/i.test(text)) this.log('debug', `chrome: ${text.slice(0, 400)}`);
    });
    this.proc.on('exit', (code) => {
      this.log('debug', `Chrome 退出 code=${code}`);
      this.cdp = null;
      this.proc = null;
      this.port = null;
    });

    const portFile = path.join(this.userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    let content = null;
    while (Date.now() < deadline) {
      try {
        content = await fsp.readFile(portFile, 'utf8');
        if (content.trim()) break;
      } catch { /* 还没写出来 */ }
      if (this.proc.exitCode !== null) throw new Error(`Chrome 启动即退出 (code=${this.proc.exitCode})`);
      await sleep(120);
    }
    if (!content) throw new Error('Chrome 未能在 20s 内开启调试端口');
    const [port, wsPath] = content.trim().split('\n');
    this.port = Number(port);
    this.cdp = await CdpConnection.connect(`ws://127.0.0.1:${this.port}${wsPath}`);
    try {
      const v = await this.cdp.send('Browser.getVersion');
      this.version = v.product;
    } catch { /* 可选 */ }
    return this;
  }

  /** 新建一个页面（独立 target/session），用完必须 close()。 */
  async newPage() {
    await this.ensure();
    this.#cancelIdle();
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.active++;
    return new ChromePage(this, targetId, sessionId);
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) this.#scheduleIdle();
  }

  #scheduleIdle() {
    this.#cancelIdle();
    if (this.idleShutdownMs <= 0) return;
    this.idleTimer = setTimeout(() => { this.close().catch(() => {}); }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  #cancelIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  async close() {
    this.#cancelIdle();
    try { this.cdp?.close(); } catch { /* ignore */ }
    this.cdp = null;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref?.();
    }
    if (this.userDataDir) {
      const dir = this.userDataDir;
      this.userDataDir = null;
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export class ChromePage {
  constructor(pool, targetId, sessionId) {
    this.pool = pool;
    this.cdp = pool.cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.closed = false;
  }

  send(method, params) { return this.cdp.send(method, params, this.sessionId); }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable').catch(() => {});
    // 页面里的 console 错误转发到日志，方便排错
    this.cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid !== this.sessionId) return;
      if (p.type === 'error' || p.type === 'warning') {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.pool.log('debug', `page ${p.type}: ${text.slice(0, 300)}`);
      }
    });
    return this;
  }

  async setViewport(width, height, dsf) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      deviceScaleFactor: dsf,
      mobile: false,
      screenWidth: Math.round(width),
      screenHeight: Math.round(height),
    });
  }

  async setTransparentBackground(transparent) {
    if (transparent) {
      await this.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    } else {
      await this.send('Emulation.setDefaultBackgroundColorOverride');
    }
  }

  async goto(url, timeoutMs = 30000) {
    const loaded = this.cdp.waitFor('Page.loadEventFired', timeoutMs, this.sessionId).catch(() => null);
    await this.send('Page.navigate', { url });
    await loaded;
    // 等字体（KaTeX 需要）与两帧渲染
    await this.send('Runtime.evaluate', {
      expression: `(async () => {
        if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return this;
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate 失败');
    }
    return res.result?.value;
  }

  /** 测量 #mdp-root 的 border-box 与整页高度。 */
  async measure(selector = '#mdp-root') {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const de = document.documentElement;
      const body = document.body;
      const r = el ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 };
      const scrollH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
      const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
      return {
        x: r.left + window.scrollX, y: r.top + window.scrollY,
        width: r.width, height: r.height,
        scrollWidth: scrollW, scrollHeight: scrollH,
        devicePixelRatio: window.devicePixelRatio,
        fontsReady: !document.fonts || document.fonts.status === 'ready',
      };
    })()`);
  }

  /**
   * 截图。
   * @param {{x:number,y:number,width:number,height:number,dsf:number}} clip
   */
  async screenshot({ x, y, width, height, dsf = 1 }) {
    // 先按目标像素尺寸把视口撑开，避免 captureBeyondViewport 在超长页面上被裁切
    await this.setViewport(width, Math.min(Math.max(height, 1), 60000), dsf);
    await this.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', { awaitPromise: true });
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      optimizeForSpeed: false,
      clip: { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(1, width), height: Math.max(1, height), scale: 1 },
    });
    const buf = Buffer.from(data, 'base64');
    // deviceScaleFactor 由 Emulation 负责，这里校验一下产出像素是否与 dpi 一致
    return { buffer: buf, pixelRatio: dsf };
  }

  /**
   * HTML → PDF。
   * @param {{paperWidthIn:number, paperHeightIn:number, marginIn:number}} o
   */
  async printToPdf(o) {
    const { data } = await this.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: false,
      paperWidth: o.paperWidthIn,
      paperHeight: o.paperHeightIn,
      marginTop: o.marginIn,
      marginBottom: o.marginIn,
      marginLeft: o.marginIn,
      marginRight: o.marginIn,
      scale: o.scale ?? 1,
      transferMode: 'ReturnAsBase64',
    });
    return Buffer.from(data, 'base64');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* ignore */ }
    try { await this.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }); } catch { /* ignore */ }
    this.pool.release();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
