#!/usr/bin/env node
/**
 * scripts/bench.mjs — 可复现的性能基准（先测基线，再谈优化）。
 *
 * 为什么先建这个：本项目所有性能结论都必须能证伪。没有基线数字的"优化"只是
 * 说法。这个脚本把每一项体验指标都变成可重复测量、可前后对比的数：
 *
 *   boot          应用冷启动：导航 → #root 出现内容
 *   loadDoc       载入 10 万字符文档 → 编辑器可交互
 *   typeLatency   逐字符真实按键 → 下一帧绘制完成（p50 / p95 / max）
 *   renderFull    整篇 Markdown→HTML 全量渲染耗时（页内实测）
 *   scrollFps     预览区滚动帧率（均值 / 最低）
 *   exportPng     300 DPI PNG 端到端耗时（服务端实测）
 *   exportPdf     LaTeX PDF 端到端耗时
 *
 * 用法：
 *   node scripts/bench.mjs                     # 默认 10 万字符
 *   node scripts/bench.mjs --chars 300000
 *   node scripts/bench.mjs --json bench.json   # 落盘，便于前后 diff
 *   node scripts/bench.mjs --baseline bench.baseline.json   # 与基线对比
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

const { startServer } = await import('../server/server.mjs');
const { makeDoc, describeDoc } = await import('./lib/synth-doc.mjs');
const { ChromePool } = await import('../server/chrome.mjs');
const { executeRender, normalizeRequest } = await import('../server/render.mjs');
const { uid } = await import('../server/util.mjs');

/* ------------------------------------------------------------- 参数 --- */

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=').slice(1).join('=') : def;
};
const flag = (name) => argv.includes(`--${name}`);

const CHARS = Number(arg('chars', 100000));
const KEYSTROKES = Number(arg('keys', 30));
const JSON_OUT = arg('json', '');
const BASELINE = arg('baseline', '');
const QUIET = flag('quiet');

const C = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, y: (s) => s, d: (s) => s, b: (s) => s };

/* ----------------------------------------------------------- 测量工具 --- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(nums) {
  if (!nums.length) return { p50: 0, p95: 0, max: 0, min: 0, avg: 0 };
  const s = [...nums].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    min: +s[0].toFixed(1),
    p50: +at(0.5).toFixed(1),
    p95: +at(0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
}

/* -------------------------------------------------------------- 主流程 --- */

const doc = makeDoc(CHARS);
const results = { chars: doc.length, at: new Date().toISOString(), metrics: {} };

console.log(C.b(`MDP Studio 性能基准`));
console.log(C.d(`文档 ${doc.length.toLocaleString()} 字符 · 按键采样 ${KEYSTROKES} 次 · 节点 ${process.version}`));

const srv = await startServer({ port: 0, quiet: true, warmup: false, concurrency: 2, log: () => {} });
const pool = new ChromePool({ log: () => {} });
const page = await pool.newPage();
await page.init();

/* ---- 1. 应用冷启动：导航 → React 挂载（墙钟，含网络与解析） ---- */
{
  const wall0 = Date.now();
  await page.goto(srv.url + '/', 30000);
  const t = await page.evaluate(`(async () => {
    return new Promise((res) => {
      const tick = () => {
        const root = document.getElementById('root');
        if (root && root.children.length > 0) return res(1);
        requestAnimationFrame(tick);
      };
      tick();
    });
  })()`, { awaitPromise: true });
  void t;
  const ms = Date.now() - wall0;
  results.metrics.boot = { ms };
  console.log(`  boot        ${C.g(String(ms).padStart(6) + ' ms')}   导航 → 界面可用（墙钟）`);
}

/* ---- 2. 注入 10 万字符文档：墙钟计时到编辑器可交互 ---- */
{
  await page.evaluate(`(() => {
    const now = Date.now();
    localStorage.setItem('mdp.studio.v2.docs', JSON.stringify([{
      id: 'bench', name: 'bench-large', content: ${JSON.stringify(doc)}, createdAt: now, updatedAt: now,
    }]));
    localStorage.setItem('mdp.studio.v2.activeId', JSON.stringify('bench'));
    return true;
  })()`);
  const wall0 = Date.now();
  await page.goto(srv.url + '/', 40000);
  // 判据：编辑器已挂载，且热路径内容 store 里确实装进了这篇长文
  const info = await page.evaluate(`(async () => {
    const t0 = performance.now();
    return new Promise((res) => {
      const tick = () => {
        const hasEditor = !!document.querySelector('.cm-content');
        const len = window.__mdpBench ? window.__mdpBench.currentSource().length : 0;
        if (hasEditor && len > 1000) return res({ ms: performance.now() - t0, len });
        if (performance.now() - t0 > 60000) return res({ ms: -1, len });
        requestAnimationFrame(tick);
      };
      tick();
    });
  })()`, { awaitPromise: true });
  const ms = info.ms < 0 ? -1 : Math.round(info.ms) + 0;
  results.metrics.loadDoc = { ms: Date.now() - wall0, inPageMs: ms, chars: info.len };
  console.log(`  loadDoc     ${C.g(String(Date.now() - wall0).padStart(6) + ' ms')}   载入 ${info.len.toLocaleString()} 字符 → 编辑器可交互（墙钟）`);
}

/* ---- 3. 整篇渲染耗时（页内实测，走的是与导出同一个渲染器） ---- */
{
  const r = await page.evaluate(`(() => {
    const bench = window.__mdpBench;
    if (!bench) return null;
    const src = window.__mdpBench.currentSource();
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      bench.render(src);
      runs.push(performance.now() - t0);
    }
    return runs;
  })()`);
  if (r) {
    const s = stats(r);
    results.metrics.renderFull = s;
    console.log(`  renderFull  ${C.g(String(s.p50).padStart(6) + ' ms')}   全量渲染 p50 (p95 ${s.p95}ms, ${r.length} 次)`);
  } else {
    results.metrics.renderFull = null;
    console.log(`  renderFull  ${C.y('  n/a')}   （页面未暴露 __mdpBench 钩子）`);
  }
}

/* ---- 4. 真实按键延迟：dispatchKeyEvent → 双 rAF 完成 ---- */
{
  await page.evaluate(`document.querySelector('.cm-content')?.focus()`);
  await page.evaluate(`(() => {
    const v = window.__mdpBench?.view?.();
    if (v) v.dispatch({ selection: { anchor: Math.floor(v.state.doc.length / 2) } });
    return true;
  })()`);
  await sleep(200);
  const lat = [];
  for (let i = 0; i < KEYSTROKES; i++) {
    await page.evaluate('window.__t0 = performance.now()');
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'x', unmodifiedText: 'x' }, page.sessionId);
    const dt = await page.evaluate(`new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - window.__t0))))`, { awaitPromise: true });
    lat.push(Number(dt));
    await sleep(24);
  }
  const s = stats(lat);
  results.metrics.typeLatency = s;
  const verdict = s.p95 < 16 ? C.g('≤1 帧') : s.p95 < 33 ? C.y('≈2 帧') : C.r('>2 帧');
  console.log(`  typeLat     ${C.g(String(s.p50).padStart(6) + ' ms')}   p50 (p95 ${s.p95}ms / max ${s.max}ms) ${verdict}`);
}

/* ---- 5. 预览滚动帧率 ---- */
{
  const r = await page.evaluate(`(async () => {
    const el = document.querySelector('.preview-scroll');
    if (!el) return null;
    el.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(r));
    const frames = [];
    let last = performance.now();
    let stop = false;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const total = el.scrollHeight - el.clientHeight;
    const t0 = performance.now();
    // 双重上限（时间 + 帧数）：页面若卡住，rAF 可能长时间不回调，
    // 只按时间判断会让基准永远挂住（踩过这个坑）。
    let guard = 0;
    while (performance.now() - t0 < 2000 && guard < 400) {
      guard++;
      const p = (performance.now() - t0) / 2000;
      el.scrollTop = total * p;
      await new Promise((r) => {
        const to = setTimeout(r, 200);
        requestAnimationFrame(() => { clearTimeout(to); r(); });
      });
    }
    stop = true;
    frames.shift();
    return frames;
  })()`, { awaitPromise: true });
  if (r && r.length) {
    const avg = r.reduce((a, b) => a + b, 0) / r.length;
    const fps = 1000 / avg;
    const worst = 1000 / Math.max(...r);
    results.metrics.scrollFps = { avg: +fps.toFixed(1), worst: +worst.toFixed(1), frames: r.length };
    console.log(`  scrollFps   ${(fps >= 55 ? C.g : fps >= 40 ? C.y : C.r)(String(fps.toFixed(1)).padStart(6) + ' fps')}  均值（最低 ${worst.toFixed(1)} fps, ${r.length} 帧）`);
  } else {
    results.metrics.scrollFps = null;
    console.log(`  scrollFps   ${C.y('  n/a')}`);
  }
}

await page.close();

/* ---- 6. 导出耗时（服务端实测） ---- */
const smallDoc = makeDoc(4000);
async function timeExport(label, targets, extra = {}) {
  const spec = normalizeRequest({
    content: smallDoc,
    filename: `bench-${uid(4)}`,
    targets,
    doc: { card: false, theme: 'paper', ...(extra.doc || {}) },
    png: { dpi: 300, mode: 'page', engine: 'html', ...(extra.png || {}) },
    latex: { preset: 'draft', ...(extra.latex || {}) },
    markdown: { lineNumbers: true },
  });
  const t0 = Date.now();
  try {
    const res = await executeRender(spec, { log: () => {}, chromePool: pool, baseUrl: srv.url, jobId: uid(8) });
    const ms = Date.now() - t0;
    const a = res.artifacts[0];
    results.metrics[label] = { ms, bytes: a?.bytes ?? null, width: a?.width ?? null, height: a?.height ?? null };
    console.log(`  ${label.padEnd(11)} ${C.g(String(ms).padStart(6) + ' ms')}   ${a?.width ? a.width + '×' + a.height + ' · ' : ''}${a?.bytes ? (a.bytes / 1024).toFixed(0) + ' KB' : ''}`);
  } catch (err) {
    results.metrics[label] = { error: err.message };
    console.log(`  ${label.padEnd(11)} ${C.r('  失败')}   ${String(err.message).slice(0, 60)}`);
  }
}
await timeExport('exportPng', ['png']);
await timeExport('exportPdf', ['pdf'], { latex: { preset: 'draft', numbers: false, toc: false } });

/* ---- 7. 前端产物体积：区分「首屏」与「按需」 ---- */
{
  const dist = path.join(ROOT, 'web', 'dist');
  const assets = path.join(dist, 'assets');
  let files = [];
  try { files = await fsp.readdir(assets); } catch { /* 未构建 */ }

  let totalBytes = 0;
  let firstLoadBytes = 0;
  let fontsBytes = 0;
  for (const f of files) {
    const st = await fsp.stat(path.join(assets, f));
    totalBytes += st.size;
    if (/\.(woff2?|ttf|otf)$/i.test(f)) fontsBytes += st.size;
  }

  // 首屏 = index.html 里 modulepreload 的 chunk + entry + 全部 css
  let html = '';
  try { html = await fsp.readFile(path.join(dist, 'index.html'), 'utf8'); } catch { /* ignore */ }
  const preloaded = [...html.matchAll(/href="\/assets\/([^"]+)"/g)].map((m) => m[1]);
  for (const f of new Set(preloaded)) {
    try { firstLoadBytes += (await fsp.stat(path.join(assets, f))).size; } catch { /* ignore */ }
  }
  for (const f of files) {
    if (/\.css$/.test(f)) firstLoadBytes += (await fsp.stat(path.join(assets, f))).size;
  }

  results.metrics.bundle = {
    files: files.length,
    totalBytes,
    firstLoadBytes,
    fontsBytes,
  };
  console.log(`  bundle      ${C.g(String(files.length).padStart(6) + ' 个')}   首屏 ${(firstLoadBytes / 1024).toFixed(0)} KB（gzip≈${(firstLoadBytes / 1024 * 0.28).toFixed(0)} KB）· 全部 ${(totalBytes / 1024).toFixed(0)} KB（字体 ${(fontsBytes / 1024).toFixed(0)} KB）`);
}

await pool.close();
await srv.close();

/* -------------------------------------------------------------- 输出 --- */

if (JSON_OUT) {
  await fsp.writeFile(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(C.d(`\n已写入 ${JSON_OUT}`));
}

if (BASELINE) {
  try {
    const base = JSON.parse(await fsp.readFile(BASELINE, 'utf8'));
    console.log(C.b(`\n与基线对比 (${BASELINE})`));
    const rows = [];
    for (const [k, v] of Object.entries(results.metrics)) {
      const b = base.metrics?.[k];
      if (!b) continue;
      const pick = (x) => (typeof x === 'object' && x ? (x.p50 ?? x.ms ?? x.totalBytes ?? x.avg) : x);
      const bn = pick(b); const cn = pick(v);
      if (typeof bn !== 'number' || typeof cn !== 'number' || !bn) continue;
      const delta = ((cn - bn) / bn) * 100;
      rows.push([k, bn, cn, delta]);
    }
    for (const [k, bn, cn, d] of rows) {
      const good = d < -2; const bad = d > 2;
      const mark = good ? C.g('▼ ' + Math.abs(d).toFixed(1) + '%') : bad ? C.r('▲ ' + d.toFixed(1) + '%') : C.d('≈ 持平');
      console.log(`  ${k.padEnd(12)} ${String(bn).padStart(10)} → ${String(cn).padStart(10)}   ${mark}`);
    }
  } catch (err) {
    console.log(C.y(`\n无法读取基线 ${BASELINE}: ${err.message}`));
  }
}

if (!QUIET) console.log('');
