/**
 * server/server.mjs — 零依赖 HTTP 后台。
 *
 * 一份进程同时承担三件事：
 *   1. 静态托管 web/dist（Vite 构建出的工作台单页）
 *   2. 渲染 API（任务队列 + SSE 实时日志 + 产物下载）
 *   3. 内部渲染页 / 资源托管（供 Chromium 加载 KaTeX 字体与文档页）
 *
 * 只监听回环地址：它会执行 pandoc / XeLaTeX / Chromium，不应该对外暴露。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ARTIFACT_DIR, NODE_MODULES, PROJECT_ROOT, WEB_DIST,
  ensureDirs, mimeFor, readJson, sendBuffer, sendError, sendJson, sendText,
  serveStatic, contentDisposition, uid, formatBytes,
} from './util.mjs';
import { probeCaps, preflight, invalidateCaps } from './caps.mjs';
import { getPresets, invalidatePresets, EXPORT_ROUTES } from './presets.mjs';
import { JobManager } from './jobs.mjs';
import {
  executeRender, normalizeRequest, buildPlanPreview, scanArtifacts,
  getRenderPage, listHljsThemes, getHljsCss, MARKDOWN_FLAGS,
  DEFAULT_MARKDOWN_OPTIONS, DEFAULT_DOC_OPTIONS, DOC_THEMES,
} from './render.mjs';
import { PAPER_SIZES, FONT_PRESETS } from '../shared/theme.mjs';
import { ChromePool } from './chrome.mjs';
import { publicConfig, writeConfig } from './config.mjs';
import { AI_TASKS, aiStatus, runTask, preflightAi, AiError } from './ai.mjs';
import { rasterSummary } from './raster.mjs';

const VERSION = '2.0.0';
const KATEX_DIST = path.join(NODE_MODULES, 'katex', 'dist');

/* ------------------------------------------------------------- 小工具 --- */

function jsonBody(handler) {
  return async (req, res) => {
    try {
      const body = await readJson(req, 64 * 1024 * 1024);
      await handler(body, req, res);
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message || '请求解析失败');
    }
  };
}

function resolveArtifactPath(relOrAbs) {
  const abs = path.resolve(ARTIFACT_DIR, String(relOrAbs || ''));
  if (abs !== ARTIFACT_DIR && !abs.startsWith(ARTIFACT_DIR + path.sep)) return null;
  return abs;
}

/** AI 错误的统一出口：把可读原因给前端，细节留在服务端日志。 */
function sendAiError(res, err) {
  const status = err instanceof AiError ? err.status : 500;
  sendJson(res, status, {
    error: err?.message || 'AI 调用失败',
    detail: err?.detail || null,
    retryable: Boolean(err?.retryable),
  });
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* 打不开就算了 */ }
}

/* --------------------------------------------------------------- 启动 --- */

/**
 * @param {{port?:number, host?:string, open?:boolean, concurrency?:number,
 *          quiet?:boolean, token?:string, assetRoots?:string[], log?:(l:string,m:string)=>void}} [opts]
 */
export async function startServer(opts = {}) {
  const quiet = Boolean(opts.quiet);
  const host = opts.host || '127.0.0.1';
  const token = opts.token || null;
  const log = opts.log || ((level, msg) => {
    if (quiet && level === 'debug') return;
    const prefix = { info: '▸', ok: '✓', warn: '!', err: '✗', debug: '·' }[level] || '·';
    process.stderr.write(`${prefix} ${msg}\n`);
  });

  await ensureDirs();

  const chromePool = new ChromePool({
    maxPages: Math.max(1, opts.concurrency ?? 2),
    log: (level, msg) => log('debug', msg),
  });

  let baseUrl = '';

  const jobs = new JobManager({ concurrency: opts.concurrency ?? 2 });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || host}`);
    } catch {
      sendError(res, 400, '非法 URL');
      return;
    }
    const p = url.pathname;

    // 极简 CORS：方便用 curl / 脚本 / 其它本地工具直接调 API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-MDP-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (token) {
      const given = req.headers['x-mdp-token'] || url.searchParams.get('token');
      if (given !== token) { sendError(res, 401, '缺少或错误的访问令牌'); return; }
    }

    try {
      /* ------------------------------------------------------- 静态资源 -- */
      if (p.startsWith('/vendor/katex/')) {
        const rel = p.slice('/vendor/katex/'.length);
        if (await serveStatic(req, res, KATEX_DIST, rel, { maxAge: 3600 })) return;
        sendError(res, 404, 'KaTeX 资源不存在');
        return;
      }

      if (p.startsWith('/render/')) {
        const tok = p.slice('/render/'.length);
        const html = getRenderPage(tok);
        if (!html) { sendText(res, 404, '渲染页已过期，请重新提交任务'); return; }
        sendBuffer(res, 200, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
        return;
      }

      /* ------------------------------------------------------------ API -- */
      if (p.startsWith('/api/')) {
        await handleApi(req, res, p, url);
        return;
      }

      /* ---------------------------------------------------------- 前端 --- */
      if (await serveStatic(req, res, WEB_DIST, p === '/' ? 'index.html' : p, { spa: true, maxAge: 0 })) return;

      // 没构建前端时的兜底页：把 API 用法直接写在页面上，工具不至于"打不开"
      if (p === '/' || p === '/index.html') {
        sendBuffer(res, 200, Buffer.from(FALLBACK_PAGE(port), 'utf8'), 'text/html; charset=utf-8');
        return;
      }
      sendError(res, 404, `未找到 ${p}`);
    } catch (err) {
      log('err', `${req.method} ${p} → ${err.message}`);
      if (!res.headersSent) sendError(res, 500, '服务器内部错误', err.stack || err.message);
      else res.end();
    } finally {
      if (!quiet && p.startsWith('/api/')) {
        log('debug', `${req.method} ${p} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  /* ------------------------------------------------------------ 路由 --- */

  async function handleApi(req, res, p, url) {
    /* ---- 健康检查 ---- */
    if (p === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        baseUrl,
        chrome: chromePool.available ? { available: true, version: chromePool.version } : { available: false },
        jobs: jobs.stats(),
        raster: rasterSummary(),
      });
      return;
    }

    /* ---- 能力体检 ---- */
    if (p === '/api/caps' && req.method === 'GET') {
      const caps = await probeCaps({ force: url.searchParams.get('force') === '1' });
      sendJson(res, 200, { ...caps, jobs: jobs.stats(), chromePoolRunning: Boolean(chromePool.proc) });
      return;
    }

    /* ---- 档位 / 路线 / 主题 等元数据 ---- */
    if (p === '/api/meta' && req.method === 'GET') {
      const [presets, caps] = await Promise.all([getPresets({ onLog: log }), probeCaps()]);
      sendJson(res, 200, {
        version: VERSION,
        presets,
        routes: EXPORT_ROUTES,
        docThemes: DOC_THEMES,
        paperSizes: PAPER_SIZES,
        fontPresets: FONT_PRESETS,
        markdownFlags: MARKDOWN_FLAGS,
        markdownDefaults: DEFAULT_MARKDOWN_OPTIONS,
        docDefaults: DEFAULT_DOC_OPTIONS,
        hljsThemes: listHljsThemes(),
        caps: { summary: caps.summary, engines: caps.engines, chrome: caps.chrome, raster: caps.raster },
      });
      return;
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      invalidateCaps(); invalidatePresets();
      const [presets, caps] = await Promise.all([getPresets({ force: true, onLog: log }), probeCaps({ force: true })]);
      sendJson(res, 200, { ok: true, presets: presets.presets?.length ?? 0, caps: caps.summary });
      return;
    }

    /* ---- 本地配置（**密钥永不回传浏览器**） ---- */
    if (p === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, publicConfig());
      return;
    }
    if (p === '/api/config' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = await readJson(req, 256 * 1024);
      // 白名单字段，避免把任意结构写进配置文件
      const patch = {};
      if (body.ui && typeof body.ui === 'object') patch.ui = body.ui;
      if (body.export && typeof body.export === 'object') patch.export = body.export;
      if (body.ai && typeof body.ai === 'object') {
        patch.ai = {};
        for (const k of ['enabled', 'model', 'thinkingLevel', 'apiKey', 'mock', 'tasks', 'baseUrl']) {
          if (body.ai[k] !== undefined) patch.ai[k] = body.ai[k];
        }
      }
      writeConfig(patch);
      log('debug', `配置已更新 → ${publicConfig().path}`);
      sendJson(res, 200, publicConfig());
      return;
    }

    /* ---- AI：状态与任务（密钥只在本机后台使用） ---- */
    if (p === '/api/ai/status' && req.method === 'GET') {
      sendJson(res, 200, aiStatus());
      return;
    }

    const aiMatch = /^\/api\/ai\/([a-z][a-z-]*)$/.exec(p);
    if (aiMatch && req.method === 'POST') {
      const taskId = aiMatch[1];
      const task = AI_TASKS[taskId];
      if (!task) { sendError(res, 404, `未知 AI 任务：${taskId}`); return; }
      const body = await readJson(req, 40 * 1024 * 1024); // 截图可能较大
      const ac = new AbortController();
      req.on('close', () => ac.abort());

      // **在写任何响应之前做前置校验**：这样"未启用/缺密钥/输入超长"能得到
      // 正确的 HTTP 状态码，而不是伪装成 200 的流内错误事件。
      let st;
      try {
        st = preflightAi(taskId, body).status;
      } catch (err) {
        sendAiError(res, err);
        return;
      }

      // 非流式：结构化输出，直接给 JSON（公式纠错/截图转公式要"一键替换"，必须确定）
      if (!task.stream) {
        try {
          const t0 = Date.now();
          const out = await runTask(taskId, body, { signal: ac.signal });
          log('debug', `AI ${taskId} 完成 ${Date.now() - t0}ms${out.mock ? ' (mock)' : ''}`);
          sendJson(res, 200, { ok: true, task: taskId, ...out });
        } catch (err) {
          sendAiError(res, err);
        }
        return;
      }

      // 流式：转发为 SSE，前端边生成边显示
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端已断开 */ }
      };
      send('start', { task: taskId, model: st.model, mock: st.mock });
      const t0 = Date.now();
      try {
        const out = await runTask(taskId, body, {
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.type === 'delta') send('delta', { text: ev.text });
            else if (ev.type === 'thinking') send('thinking', { text: ev.text });
          },
        });
        send('done', { model: out.model, mock: out.mock, chars: (out.text || '').length, ms: Date.now() - t0, usage: out.usage || null });
        log('debug', `AI ${taskId} 流式完成 ${Date.now() - t0}ms · ${(out.text || '').length} 字符${out.mock ? ' (mock)' : ''}`);
      } catch (err) {
        send('error', {
          message: err?.message || String(err),
          status: err?.status || 500,
          detail: err?.detail || null,
        });
        log('warn', `AI ${taskId} 失败：${err?.message}`);
      }
      res.end();
      return;
    }

    /* ---- highlight.js 主题 CSS ---- */
    if (p === '/api/hljs.css' && req.method === 'GET') {
      const theme = url.searchParams.get('theme') || 'github';
      sendBuffer(res, 200, Buffer.from(getHljsCss(theme), 'utf8'), 'text/css; charset=utf-8', { 'Cache-Control': 'public, max-age=600' });
      return;
    }

    /* ---- 图片等本地资源 ---- */
    if (p === '/api/asset' && req.method === 'GET') {
      const target = url.searchParams.get('path');
      if (!target) { sendError(res, 400, '缺少 path'); return; }
      const roots = [PROJECT_ROOT, ...(opts.assetRoots || [])].map((r) => path.resolve(r));
      const abs = path.resolve(target);
      const ok = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
      if (!ok) { sendError(res, 403, '该路径不在允许的资源根目录内'); return; }
      const served = await serveStatic(req, res, path.dirname(abs), path.basename(abs), { maxAge: 60 });
      if (!served) sendError(res, 404, '资源不存在');
      return;
    }

    /* ---- 示例库（examples/ 目录） ---- */
    if (p === '/api/examples' && req.method === 'GET') {
      const dir = path.join(PROJECT_ROOT, 'examples');
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const examples = [];
      for (const e of entries) {
        if (!e.isFile() || !/\.(md|markdown)$/i.test(e.name)) continue;
        const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
        if (st) examples.push({ name: e.name, size: st.size, mtime: st.mtime.toISOString() });
      }
      examples.sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, { examples });
      return;
    }

    const exMatch = /^\/api\/examples\/(.+)$/.exec(p);
    if (exMatch && req.method === 'GET') {
      const name = decodeURIComponent(exMatch[1]);
      // 只允许 examples/ 下的单层文件名，杜绝路径穿越
      if (name.includes('/') || name.includes('\\') || name.includes('..')) { sendError(res, 400, '非法文件名'); return; }
      const file = path.join(PROJECT_ROOT, 'examples', name);
      const st = await fsp.stat(file).catch(() => null);
      if (!st || !st.isFile()) { sendError(res, 404, '示例不存在'); return; }
      sendJson(res, 200, { name, content: await fsp.readFile(file, 'utf8') });
      return;
    }

    /* ---- 命令预览（不执行） ---- */
    if (p === '/api/plan' && req.method === 'POST') {
      const body = await readJson(req, 16 * 1024 * 1024);
      const reqSpec = normalizeRequest(body);
      sendJson(res, 200, { commands: buildPlanPreview(reqSpec) });
      return;
    }

    /* ---- 提交渲染任务 ---- */
    if (p === '/api/render' && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024 * 1024);
      const spec = normalizeRequest(body);
      const target = spec.targets[0];
      const targetKind = target === 'png' && spec.png.engine === 'latex' ? 'png-latex' : target;
      const pre = await preflight(targetKind);
      if (pre.blockers.length) {
        sendJson(res, 409, {
          error: '环境不具备该导出路线的条件',
          blockers: pre.blockers,
        });
        return;
      }
      const job = jobs.create({
        type: 'render',
        label: `${spec.filename} → ${spec.targets.join(' + ')}`,
        meta: { targets: spec.targets, filename: spec.filename },
        executor: (ctx) => executeRender(spec, {
          ...ctx,
          chromePool,
          baseUrl,
          keepWorkDir: body.keepWorkDir === true,
        }),
      });
      sendJson(res, 202, { jobId: job.id, status: job.status, targets: spec.targets, commands: buildPlanPreview(spec) });
      return;
    }

    /* ---- 同步渲染：一条 curl 就拿到二进制 ---- */
    if (p === '/api/render-sync' && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024 * 1024);
      const spec = normalizeRequest(body);
      if (url.searchParams.get('target')) spec.targets = [url.searchParams.get('target')];
      const target = spec.targets[0];
      const targetKind = target === 'png' && spec.png.engine === 'latex' ? 'png-latex' : target;
      const pre = await preflight(targetKind);
      if (pre.blockers.length) {
        sendJson(res, 409, { error: '环境不具备条件', blockers: pre.blockers });
        return;
      }
      const job = jobs.create({
        type: 'render-sync',
        label: `${spec.filename} → ${spec.targets.join(' + ')}`,
        executor: (ctx) => executeRender(spec, { ...ctx, chromePool, baseUrl }),
      });
      const timeoutMs = Math.max(5000, Math.min(900_000, Number(url.searchParams.get('timeout')) || 300_000));
      const finished = await jobs.waitFor(job.id, timeoutMs);
      if (!finished || finished.status === 'queued' || finished.status === 'running') {
        sendError(res, 504, '渲染超时，任务仍在后台运行', `jobId=${job.id}`);
        return;
      }
      if (finished.status !== 'done' || !finished.artifacts?.length) {
        sendJson(res, 500, {
          error: finished.error || '渲染失败',
          detail: finished.detail,
          jobId: job.id,
          logs: finished.logs.slice(-40).map((l) => `${l.level}: ${l.msg}`),
        });
        return;
      }
      const art = finished.artifacts.find((a) => a.route === target) || finished.artifacts[0];
      const buf = await fsp.readFile(art.file);
      sendBuffer(res, 200, buf, art.mime, {
        'Content-Disposition': contentDisposition(art.name, url.searchParams.get('download') !== '1'),
        'X-MDP-Job': job.id,
        'X-MDP-Route': art.route,
        'X-MDP-Tool': art.tool || '',
      });
      return;
    }

    /* ---- 任务 ---- */
    if (p === '/api/jobs' && req.method === 'GET') {
      sendJson(res, 200, { jobs: jobs.list(Number(url.searchParams.get('limit')) || 50), stats: jobs.stats() });
      return;
    }

    const jobMatch = /^\/api\/jobs\/([A-Za-z0-9_-]+)(\/events|\/cancel)?$/.exec(p);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) { sendError(res, 404, '任务不存在'); return; }

      if (jobMatch[2] === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 2000\n\n`);
        const send = (event, data) => {
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch { /* ignore */ }
        };
        const off = jobs.subscribe(job, (event, payload) => {
          if (event === 'log') send('log', payload);
          else if (event === 'progress') send('progress', payload);
          else send('state', payload);
        });
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
        const done = () => { clearInterval(ping); off(); try { res.end(); } catch { /* ignore */ } };
        req.on('close', done);
        if (['done', 'error', 'cancelled'].includes(job.status)) setTimeout(done, 120);
        return;
      }

      if (jobMatch[2] === '/cancel' && req.method === 'POST') {
        const ok = jobs.cancel(job.id);
        sendJson(res, 200, { ok, status: job.status });
        return;
      }

      if (req.method === 'GET') {
        sendJson(res, 200, { job: jobs.publicView(job), logs: job.logs.slice(-500) });
        return;
      }
    }

    /* ---- 产物 ---- */
    if (p === '/api/artifacts' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 200;
      const onDisk = await scanArtifacts(limit);
      const live = [];
      for (const j of jobs.list(200)) {
        for (const a of j.artifacts || []) live.push({ ...a, jobStatus: j.status });
      }
      const seen = new Set(live.map((a) => a.rel));
      const merged = [...live, ...onDisk.filter((a) => !seen.has(a.rel))]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);
      sendJson(res, 200, { artifacts: merged, total: merged.length });
      return;
    }

    if (p === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('path');
      const abs = resolveArtifactPath(rel);
      if (!abs) { sendError(res, 403, '路径越界'); return; }
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) { sendError(res, 404, '文件不存在'); return; }
      const headers = { 'Cache-Control': 'no-cache' };
      if (url.searchParams.get('download') === '1') {
        headers['Content-Disposition'] = contentDisposition(path.basename(abs));
      }
      if (st.size > 1024 * 1024) {
        res.writeHead(200, { 'Content-Type': mimeFor(abs), 'Content-Length': st.size, ...headers });
        fs.createReadStream(abs).pipe(res);
        return;
      }
      sendBuffer(res, 200, await fsp.readFile(abs), mimeFor(abs), headers);
      return;
    }

    if (p === '/api/file' && req.method === 'DELETE') {
      const rel = url.searchParams.get('path');
      const abs = resolveArtifactPath(rel);
      if (!abs) { sendError(res, 403, '路径越界'); return; }
      await fsp.rm(abs, { force: true });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/cleanup' && req.method === 'POST') {
      const body = await readJson(req, 4096).catch(() => ({}));
      const keep = new Set((jobs.list(50)).filter((j) => j.status === 'running' || j.status === 'queued').map((j) => j.id));
      for (const id of body.keep || []) keep.add(String(id));
      let removed = 0;
      for (const d of await fsp.readdir(ARTIFACT_DIR, { withFileTypes: true }).catch(() => [])) {
        if (!d.isDirectory() || keep.has(d.name)) continue;
        await fsp.rm(path.join(ARTIFACT_DIR, d.name), { recursive: true, force: true });
        removed++;
      }
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    sendError(res, 404, `未知接口 ${p}`);
  }

  /* ------------------------------------------------------------ 监听 --- */

  const startPort = Number(opts.port ?? 8757);
  const port = await listenWithFallback(server, host, startPort, 20);
  baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  // 预热：Chrome 进程与能力探测并行启动，第一次导出就不用等
  if (opts.warmup !== false) {
    setTimeout(() => {
      chromePool.ensure()
        .then(() => log('debug', `Chromium 已就绪 (${chromePool.version || 'unknown'})`))
        .catch((err) => log('warn', `Chromium 未就绪：${err.message}`));
      probeCaps().then((c) => {
        log('info', `引擎 ${c.engines.pandoc.version || 'pandoc?'} · LaTeX ${c.engines.defaultEngine || '未找到'} · 栅格化 ${c.raster.bestLabel || '无'}`);
      }).catch(() => {});
    }, 50).unref?.();
  }

  return {
    server,
    port,
    url: baseUrl,
    jobs,
    chromePool,
    close: async () => {
      // SSE 是长连接：只调 server.close() 会一直等它们自然断开，
      // 于是 `mdp serve` 按 Ctrl-C 之后进程赖着不走。先强制断开所有连接。
      try { server.closeAllConnections?.(); } catch { /* 老版本 Node 没有该方法 */ }
      await new Promise((r) => server.close(r));
      await chromePool.close();
    },
  };
}

function listenWithFallback(server, host, startPort, tries) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && attempt < tries) {
          attempt++;
          server.removeListener('error', onError);
          tryPort(port + 1);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : port);
      });
    };
    tryPort(startPort);
  });
}

/* ------------------------------------------------- 未构建前端时的兜底页 --- */

const FALLBACK_PAGE = (port) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MDP Studio · 后台已就绪</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:15px/1.7 -apple-system,"PingFang SC",sans-serif; background:#0f1116; color:#e6e8ee; }
  .wrap { max-width: 760px; margin: 8vh auto; padding: 0 24px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .tag { color:#7dd3fc; font-family: ui-monospace, monospace; font-size: 13px; }
  .card { background:#161a22; border:1px solid #262b36; border-radius:12px; padding:18px 20px; margin:18px 0; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; }
  pre { background:#0b0d12; border:1px solid #262b36; border-radius:8px; padding:12px; overflow:auto; }
  a { color:#7dd3fc; }
  .ok { color:#4ade80; } .warn { color:#fbbf24; }
</style></head>
<body><div class="wrap">
  <div class="tag">MDP STUDIO v${VERSION}</div>
  <h1>后台已就绪，但网页前端尚未构建</h1>
  <p>渲染 API 现在就可以用了。要让图形工作台出现，请在项目根目录执行：</p>
  <pre>npm install
npm run build        # 产出 web/dist
mdp serve            # 或在开发模式下：npm run dev</pre>
  <div class="card">
    <p class="ok">✔ 可用接口</p>
    <pre>GET  /api/health                     健康检查
GET  /api/caps                       环境体检（pandoc / LaTeX / Chromium / 栅格化器）
GET  /api/meta                       档位、导出路线、主题、Markdown 开关
POST /api/render                     提交渲染任务 → { jobId }
GET  /api/jobs/:id/events            SSE 实时日志
GET  /api/artifacts                  产物列表
POST /api/render-sync?target=png     同步渲染，直接返回二进制</pre>
  </div>
  <div class="card">
    <p class="warn">⌘ 一条命令导出 PNG（无需打开网页）</p>
    <pre>curl -s -X POST 'http://127.0.0.1:${port}/api/render-sync?target=png&amp;download=1' \\
  -H 'Content-Type: application/json' \\
  -d '{"content":"# 标题\\n\\n$a^2+b^2=c^2$","filename":"card","targets":["png"],
       "png":{"dpi":300,"mode":"card"},"doc":{"theme":"paper","card":true}}' \\
  -o card.png</pre>
  </div>
  <p>命令行等价操作：<code>mdp build note.md -t png --dpi 300</code> · <code>md2pdf -t png --dpi 300 note.md</code></p>
</div></body></html>`;
