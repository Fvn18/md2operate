/**
 * server/util.mjs — 零依赖基础工具层。
 *
 * 这里刻意不引入任何第三方包：后台是长期驻留的守护进程，依赖越少启动越快、
 * 越不容易坏。所有子进程调用、路径解析、HTTP 小工具都收敛在此。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/* --------------------------------------------------------------- 路径 --- */

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.dirname(SERVER_DIR);
export const WEB_DIST = path.join(PROJECT_ROOT, 'web', 'dist');
export const ARTIFACT_DIR = path.join(PROJECT_ROOT, '.artifacts');
export const CACHE_DIR = path.join(PROJECT_ROOT, '.cache');
export const TMP_DIR = path.join(CACHE_DIR, 'tmp');
export const MD2PDF = path.join(PROJECT_ROOT, 'md2pdf');
export const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');

export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/* --------------------------------------------------------------- 杂项 --- */

export const uid = (n = 10) => crypto.randomBytes(24).toString('base64url').slice(0, n);

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDirs() {
  for (const d of [ARTIFACT_DIR, CACHE_DIR, TMP_DIR]) {
    await fsp.mkdir(d, { recursive: true });
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function humanDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/** 在 PATH 中查找可执行文件。 */
export function which(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch { return null; }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const full = path.join(d, cmd + e);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        }
      } catch { /* 继续找 */ }
    }
  }
  return null;
}

/** 读取 PNG 的宽高（解析 IHDR），避免引入图像库。 */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* ------------------------------------------------------------ 子进程 --- */

/**
 * 运行一个子进程，按行回调日志。
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, onLog?:(stream:'out'|'err', line:string)=>void,
 *          timeoutMs?:number, input?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, killed:boolean, error?:Error, ms:number}>}
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd, env, onLog, timeoutMs = 0, input, signal } = opts;
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: String(error.message), timedOut: false, killed: false, error, ms: 0 });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const MAX_CAPTURE = 2 * 1024 * 1024;
    const lineSplitter = (stream) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (onLog) onLog(stream, line);
        }
        if (buf.length > 8192) { if (onLog) onLog(stream, buf); buf = ''; }
      };
    };
    const onOut = lineSplitter('out');
    const onErr = lineSplitter('err');
    const flush = () => { onOut('\n'); onErr('\n'); };

    child.stdout.on('data', (c) => { if (stdout.length < MAX_CAPTURE) stdout += c.toString('utf8'); onOut(c); });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_CAPTURE) stderr += c.toString('utf8'); onErr(c); });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref?.();
      }, timeoutMs);
    }
    const onAbort = () => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      flush();
      resolve({ code: null, signal: null, stdout, stderr: stderr + String(error.message), timedOut, killed, error, ms: Date.now() - started });
    });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      flush();
      resolve({ code, signal: sig, stdout, stderr, timedOut, killed, ms: Date.now() - started });
    });

    if (input !== undefined && input !== null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** 运行并只取 stdout（用于探测版本等）。 */
export async function capture(cmd, args, opts = {}) {
  const r = await run(cmd, args, { ...opts, timeoutMs: opts.timeoutMs ?? 8000 });
  return r.stdout.trim();
}

/* -------------------------------------------------------------- HTTP --- */

export function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limitBytes) {
  const raw = await readBody(req, limitBytes);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw Object.assign(new Error(`JSON 解析失败: ${err.message}`), { statusCode: 400 });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.tex': 'application/x-tex; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, ...extraHeaders });
  res.end(body);
}

export function sendBuffer(res, status, buf, contentType, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length, ...extraHeaders });
  res.end(buf);
}

export function sendError(res, status, message, detail) {
  sendJson(res, status, { error: message, detail: detail ? String(detail).slice(0, 4000) : undefined });
}

/* ------------------------------------------------------ 静态文件服务 --- */

/**
 * 把一个目录挂到某个 URL 前缀下，带路径穿越防护与 ETag 缓存。
 * @returns {Promise<boolean>} 是否已处理
 */
export async function serveStatic(req, res, rootDir, urlPath, { spa = false, maxAge = 0 } = {}) {
  let rel = decodeURIComponent(urlPath);
  if (rel.includes('\0')) return false;
  rel = rel.replace(/^\/+/, '');
  const target = path.resolve(rootDir, rel);
  if (target !== rootDir && !target.startsWith(rootDir + path.sep)) return false;

  let stat = null;
  try { stat = await fsp.stat(target); } catch { /* not found */ }

  if (stat && stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    try { stat = await fsp.stat(index); } catch { stat = null; }
    if (stat) return serveFile(req, res, index, stat, maxAge);
  } else if (stat && stat.isFile()) {
    return serveFile(req, res, target, stat, maxAge);
  }

  if (spa) {
    const index = path.join(rootDir, 'index.html');
    try {
      const st = await fsp.stat(index);
      return serveFile(req, res, index, st, 0);
    } catch { return false; }
  }
  return false;
}

async function serveFile(req, res, file, stat, maxAge) {
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  const headers = {
    'Content-Type': mimeFor(file),
    'Content-Length': stat.size,
    'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-cache',
    ETag: etag,
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on('error', () => { res.destroy(); resolve(); });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

/** 为下载设置 Content-Disposition（兼容中文文件名）。 */
export function contentDisposition(filename, inline = false) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export { fs, fsp, path, os };
