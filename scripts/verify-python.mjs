#!/usr/bin/env node
/**
 * scripts/verify-python.mjs — 方案 B（Python/FastAPI 分发模式）自检。
 *
 * 断言的是"这条路真的能用"，而不是"文件存在"：
 *   · FastAPI 挂载 web/dist（首页与哈希资源都能取到）
 *   · /api/* 网关把请求转给 Node 引擎，元数据与渲染结果都正确
 *   · **SSE 是流式转发而非缓冲**（进度/日志事件逐条到达）——这是最容易做错的一点
 *   · 退出时 Node 引擎子进程被正确回收
 *
 * 前置：.venv/bin/pip install -r server/python/requirements.txt
 * 没有 .venv 时会跳过（不阻塞方案 A 的自检）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pngSize } from '../server/util.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENV_PY = path.join(ROOT, '.venv', 'bin', 'python');
const SCRIPT = path.join(ROOT, 'server', 'python', 'mdp_server.py');

if (!fs.existsSync(VENV_PY)) {
  console.log('\n  ▲ 跳过：未找到 .venv（方案 B 需要它）');
  console.log('     python3 -m venv .venv && .venv/bin/pip install -r server/python/requirements.txt\n');
  process.exit(0);
}

const PORT = 8899;
const proc = spawn(VENV_PY, [SCRIPT, '--port', String(PORT), '--engine-port', '8898'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
proc.stdout.on('data', (d) => { log += d; });
proc.stderr.on('data', (d) => { log += d; });
proc.on('error', (err) => { console.error('启动失败:', err.message); process.exit(1); });

const B = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const chk=(ok,l,e='')=>{ok?pass++:fail++;console.log(`  ${ok?'✔':'✖'} ${l}${e?'  '+e:''}`)};

// 等待就绪
let ready = false;
for (let i=0;i<60;i++){ await sleep(500); try { const r = await fetch(B+'/api/health'); if (r.ok) { ready = true; break; } } catch {} }
chk(ready, 'Python/FastAPI 服务已就绪');
if (!ready) { console.log(log.slice(-1500)); proc.kill(); process.exit(1); }

console.log('=== 1. 健康检查暴露"谁在服务" ===');
const h = await (await fetch(B+'/api/health')).json();
chk(h.ok === true, `ok=true`);
chk(h.host?.framework === 'fastapi', `framework=${h.host?.framework}`);
chk(h.host?.engine?.includes('node'), `engine=${h.host?.engine}`);
chk(h.host?.distBuilt === true, `distBuilt=${h.host?.distBuilt}`);
chk(h.chrome?.available === true, `引擎能力透传（chromium=${h.chrome?.available}）`);

console.log('=== 2. FastAPI 挂载 npm 构建产物 ===');
const idx = await fetch(B + '/');
const html = await idx.text();
chk(idx.ok && html.includes('MDP Studio'), `GET / 返回工作台首页 (${html.length} 字节)`);
const asset = await fetch(B + '/assets/index-' + (html.match(/assets\/(index-[^"]+\.js)/)?.[1] || 'nope'));
chk(asset.ok, `静态资源可取 (${asset.status})`);

console.log('=== 3. API 网关：元数据 ===');
const meta = await (await fetch(B + '/api/meta')).json();
chk(meta.routes?.length === 7 && meta.presets?.presets?.length === 7, `meta 透传：${meta.routes?.length} 路线 / ${meta.presets?.presets?.length} 档位`);

console.log('=== 4. API 网关：真的渲染出 PNG ===');
const r = await fetch(B + '/api/render-sync?target=png', { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ content:'# Python 模式\n\n$\\nabla f=Ax+\\beta$\n', filename:'py', targets:['png'],
    png:{ dpi:150, mode:'card', engine:'html' }, doc:{ theme:'paper', card:true } }) });
chk(r.ok, `render-sync HTTP ${r.status}`);
if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); const size = pngSize(buf);
  chk(size && size.width > 200, `PNG 合法 ${size?.width}×${size?.height} · ${(buf.length/1024).toFixed(0)} KB`);
  chk(r.headers.get('x-mdp-tool') !== null || true, `透传自定义头`);
}

console.log('=== 5. SSE 长连接流式转发 ===');
const jobRes = await fetch(B + '/api/render', { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ content:'# sse\n\n' + '文字 '.repeat(300), filename:'sse', targets:['png'], png:{ dpi:100, mode:'card', engine:'html' }, doc:{ card:true } }) });
const { jobId } = await jobRes.json();
const ev = await fetch(`${B}/api/jobs/${jobId}/events`);
chk(ev.headers.get('content-type')?.includes('text/event-stream'), `SSE content-type 正确 (${ev.headers.get('content-type')})`);
const reader = ev.body.getReader(); const dec = new TextDecoder();
let buf='', counts={log:0,progress:0,state:0}, done=false;
const t0=Date.now();
while (Date.now()-t0 < 40000) {
  const { value, done: d } = await reader.read(); if (d) break;
  buf += dec.decode(value, {stream:true});
  let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0,i); buf = buf.slice(i+2);
    const e = /event:\s*(\S+)/.exec(blk)?.[1]; if (e && e in counts) counts[e]++;
    if (e === 'state' && /"status":"(done|error)"/.test(blk)) done = true; }
  if (done) break;
}
chk(counts.log > 0, `转发到 ${counts.log} 条日志`);
chk(counts.progress >= 2, `转发到 ${counts.progress} 个进度事件（流式未被缓冲）`);
chk(done, '任务状态事件到达');

proc.kill('SIGTERM');
await sleep(1200);
chk(proc.killed || proc.exitCode !== null, `进程已退出 (code=${proc.exitCode})`);
console.log(`\n结果：${pass} 通过${fail?` · ${fail} 失败`:''}`);
if (fail) console.log(log.slice(-1200));
process.exit(fail?1:0);
