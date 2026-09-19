#!/usr/bin/env node
/**
 * scripts/verify-export.mjs — 导出体验自检（进度 / 预估 / 1200 DPI）。
 *
 * 覆盖三件容易"看起来做了但其实没通"的事：
 *   1. 进度事件真的经 SSE 逐阶段到达，且单调不减、最终 100%
 *   2. 耗时预估会从真实耗时里学习，而且学习后**仍然落在合理区间**
 *      （曾经用 ms/千字中位数，小文档把斜率带到 1049ms/千字）
 *   3. 1200 DPI 真的能出图，且像素宽度与 DPI 吻合
 */

import { startServer } from '../server/server.mjs';
import { estimateTiming, timingSummary } from '../server/estimate.mjs';
import { pngSize } from '../server/util.mjs';
import fsp from 'node:fs/promises';

const srv = await startServer({ port: 0, quiet: true, warmup: false, log: () => {} });
const B = srv.url;
let pass = 0, fail = 0;
const chk = (ok, l, e='') => { ok?pass++:fail++; console.log(`  ${ok?'✔':'✖'} ${l}${e?'  '+e:''}`); };

console.log('=== 1. 预估（冷启动基线，且必须在合理区间） ===');
for (const r of ['png', 'pdf', 'html']) {
  const e = estimateTiming(r, 10000);
  chk(e.ms > 50 && e.ms < 30000, `${r}: ${e.ms}ms (${e.source}, ${e.perKChar}ms/千字)`);
}

console.log('=== 2. 进度事件经 SSE 到达前端 ===');
const doc = '# 进度测试\n\n' + '设 $f$ 为二次型，'.repeat(60) + '\n\n$$\\nabla f=Ax+\\beta$$\n';
const payload = { content: doc, filename: 'prog', targets: ['png'], png: { dpi: 150, mode: 'card', engine: 'html' }, doc: { theme: 'paper', card: true }, latex: { preset: 'draft' } };
const r = await fetch(B + '/api/render', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
const { jobId } = await r.json();
const res = await fetch(`${B}/api/jobs/${jobId}/events`);
const reader = res.body.getReader(); const dec = new TextDecoder();
let buf = '', prog = [], state = null;
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const blk = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /event:\s*(\S+)/.exec(blk)?.[1]; const da = /data:\s*(.*)/.exec(blk)?.[1];
    if (!ev || !da) continue;
    let o; try { o = JSON.parse(da); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (ev === 'progress') prog.push(o);
    if (ev === 'state') { state = o; if (['done','error'].includes(o.status)) { /* 结束 */ } }
  }
  if (state && ['done','error','cancelled'].includes(state.status)) break;
}
chk(prog.length >= 2, `收到 ${prog.length} 个 progress 事件`);
{
  const raw = prog.map((p) => p.pct);
  const bad = raw.findIndex((v, i) => i > 0 && v < raw[i - 1] - 1e-9);
  chk(bad < 0,
    `进度单调不减: ${raw.map((v) => (v * 100).toFixed(1) + '%').join(' → ')}`,
    bad < 0 ? '' : `第 ${bad} 项回退（原始值 ${JSON.stringify(raw)}）`);
}
chk(prog.length > 0 && prog[prog.length-1].pct === 1, '最终 100%');
chk(prog.some(p => p.label && p.label.length > 0), `阶段标签: ${[...new Set(prog.map(p=>p.label))].slice(0,5).join(' / ')}`);
chk(prog.some(p => p.etaMs != null), `ETA 有值: ${prog.find(p=>p.etaMs!=null)?.etaMs}ms`);
chk(state?.status === 'done', `任务完成 (${state?.status})`);

console.log('=== 3. 预估被真实耗时纠正（学习） ===');
const after = estimateTiming('png', doc.length);
chk(after.source === 'history', `转为历史预估 (${after.ms}ms, ${after.samples} 样本)`);
// 关键：学习后仍然落在合理区间（旧实现会算出 1049ms/千字这种荒谬值）
const big = estimateTiming('png', 100000);
chk(big.perKChar < 200, `斜率合理: ${big.perKChar}ms/千字 → 10 万字预估 ${big.ms}ms`);
const sum = timingSummary();
chk(Object.keys(sum).includes('png'), `timings.json 已记录: ${JSON.stringify(sum.png)}`);

console.log('=== 4. 1200 DPI 上限实测 ===');
const small = { content: '# 高 DPI\n\n$e^{i\\pi}+1=0$\n', filename: 'hidpi', targets: ['png'], png: { dpi: 1200, mode: 'card', engine: 'html' }, doc: { theme: 'paper', card: true, contentWidth: 600 }, latex: { preset: 'draft' } };
const r2 = await fetch(B + '/api/render-sync?target=png', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(small) });
if (r2.ok) {
  const buf = Buffer.from(await r2.arrayBuffer());
  const size = pngSize(buf);
  const expectedW = Math.round((600 + 64) * (1200/96));
  chk(size && size.width >= expectedW * 0.97, `1200 DPI 输出 ${size?.width}×${size?.height}（期望宽 ≈${expectedW}）`);
  chk(buf.length > 1000, `文件大小 ${(buf.length/1024).toFixed(0)} KB`);
} else {
  chk(false, `1200 DPI 失败: HTTP ${r2.status} ${(await r2.text()).slice(0,160)}`);
}

console.log(`\n结果：${pass} 通过${fail?` · ${fail} 失败`:''}`);
await srv.close();
process.exit(fail ? 1 : 0);
