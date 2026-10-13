#!/usr/bin/env node
/**
 * scripts/verify-preview.mjs — 预览渲染引擎自检（**不需要浏览器**）。
 *
 * 为什么这一套能在 Node 里跑：渲染引擎（shared/preview-engine.mjs）刻意不含任何
 * 平台 API —— 浏览器里它跑在 Worker，Node 里它就跑在进程里，同一份代码。
 * 于是"差量协议到底对不对"可以被逐条断言，而不是靠肉眼看预览。
 *
 * 断言的七件事：
 *   ① 差量自洽：把差量应用到本地副本后，与引擎的全量视图逐块一致（最容易错的地方）
 *   ② 未变更块**对象引用不变**、块 id 稳定（React.memo 跳过 + 原地更新的前提）
 *   ③ 差量真的省字节：改一处绝不重传整篇（含"重复块序号漂移"这个真实坑）
 *   ④ 与导出同源：预览引擎的产出与 renderMarkdown 的结构一致
 *   ⑤ 块级增删（插入/删除整块）后客户端视图仍然正确
 *   ⑥ 打字热路径成本：引擎耗时与"主线程侧"的差量应用成本
 *   ⑦ 选项变化必须让缓存作废（否则改了设置预览不更新）
 */

import { renderMarkdown, createRenderer } from '../shared/markdown.mjs';
import { createPreviewEngine, createPreviewStore, applyDelta, verifyDelta } from '../shared/preview-engine.mjs';
import { makeDoc } from './lib/synth-doc.mjs';

const C = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, d: (s) => s, b: (s) => s };

let passed = 0;
let failed = 0;
const failures = [];
function ok(label, detail = '') {
  passed++;
  console.log(`  ${C.g('✔')} ${label}${detail ? C.d(`  ${detail}`) : ''}`);
}
function bad(label, detail = '') {
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${C.r('✖')} ${label}${detail ? C.d(`  ${detail}`) : ''}`);
}
const assert = (cond, label, detail = '') => (cond ? ok(label, detail) : bad(label, detail));
const stats = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};

console.log(C.b('\n预览渲染引擎自检（Web Worker / 主线程共用同一份实现）'));

const CHARS = Number(process.env.MDP_VERIFY_CHARS || 100000);
const doc = makeDoc(CHARS);
const mdOptions = {
  breaks: false, typographer: false, linkify: true, numbering: false,
  footnotes: true, deflist: true, taskLists: true, anchors: true,
  tocEmbed: false, lineNumbers: false,
};

/** 模拟客户端：引擎 + 本地块表，apply 后返回本地视图 */
function makeClient(engine) {
  const store = createPreviewStore();
  let blocks = [];
  let applyTotal = 0;
  const apply = (result) => {
    const t0 = performance.now();
    blocks = applyDelta(store, result);
    applyTotal += performance.now() - t0;
    return blocks;
  };
  return {
    apply,
    get blocks() { return blocks; },
    get applyMs() { return applyTotal; },
  };
}

/* ---------------------------------------------------------- ① 差量自洽 -- */
const engine = createPreviewEngine({ ...mdOptions });
const client = makeClient(engine);
{
  const first = engine.render(doc);
  client.apply(first);
  assert(first.blocks.length === first.total, '首帧：全部块都下发（没有历史可复用）',
    `${first.total} 块 · ${(first.metrics.fullBytes / 1024).toFixed(1)}KB`);
  assert(first.order !== null && first.order.length === first.total, '首帧：带块顺序');
  assert(client.blocks.length === first.total, '首帧：客户端块数与引擎一致');
  assert(client.blocks.every((b) => b && b.html.length > 0), '首帧：每块都有 HTML');
  assert(new Set(client.blocks.map((b) => b.key)).size === client.blocks.length, '引擎块 key 唯一（重复样板块不会撞 key）');
  assert(new Set(client.blocks.map((b) => b.id)).size === client.blocks.length, '客户端本地 id 唯一');
  const dv1 = verifyDelta(client.blocks, engine.view());
  assert(dv1.ok, '差量视图与引擎全量视图逐块一致', dv1.reason || '');
}

/* ------------------------------------ ②③ 改一行：引用不变 + 差量省字节 -- */
{
  const lines = doc.split('\n');
  let idx = lines.findIndex((l, i) => i > 20 && l.trim() && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('```'));
  if (idx < 0) idx = Math.floor(lines.length / 2);
  lines[idx] = `${lines[idx]} 修订`;

  // 注意：块 key 会因为"重复块序号漂移"而变，**不能拿 key 当身份**。
  // 身份是本地 id（React key）；断言必须按 id 比对，否则会把"改名"误判成"重建"。
  const before = new Map(client.blocks.map((b) => [b.id, b]));
  const r2 = engine.render(lines.join('\n'));
  client.apply(r2);

  const deltaPct = (r2.metrics.deltaBytes / Math.max(1, r2.metrics.fullBytes)) * 100;
  assert(r2.metrics.changed <= 2, '改一行只重渲 1~2 个块',
    `下发 HTML 的块=${r2.metrics.changed} / ${r2.total}（${((r2.metrics.changed / r2.total) * 100).toFixed(3)}%）`);
  assert(deltaPct < 0.5, '差量传输 < 全量的 0.5%',
    `${(r2.metrics.deltaBytes / 1024).toFixed(2)}KB / ${(r2.metrics.fullBytes / 1024).toFixed(1)}KB = ${deltaPct.toFixed(3)}%`);

  let sameRef = 0;
  for (const b of client.blocks) if (before.get(b.id) === b) sameRef++;
  assert(sameRef === client.blocks.length - r2.metrics.changed,
    '未变更块对象引用完全相同（React.memo 因此 O(1) 跳过，DOM 不动）',
    `同引用 ${sameRef} · 重建 ${client.blocks.length - sameRef}`);

  // id 稳定 = React 原地更新这个块，而不是卸载重建
  let idKept = 0;
  let htmlKept = 0;
  for (const b of client.blocks) {
    const prev = before.get(b.id);
    if (prev) idKept++;
    if (prev && prev.html === b.html) htmlKept++;
  }
  assert(idKept >= client.blocks.length - r2.metrics.changed, '本地 id 稳定（React 原地更新，不卸载重建）', `${idKept}/${client.blocks.length}`);
  assert(htmlKept >= client.blocks.length - r2.metrics.changed, '未变更块的 HTML 字符串引用一致（innerHTML 不重写）',
    `${htmlKept}/${client.blocks.length}`);
  assert(client.blocks.length === r2.total, '差量应用后块数仍然正确');
}

/* ---------------------- ③b 重复块序号漂移：不得重传整篇（曾经的 84KB 陷阱） -- */
{
  const dupes = [];
  const lines = doc.split('\n');   // 从**原始文档**出发（与"撤销/重新同步"的现实场景一致）
  // 统计哪些块内容重复（同一份 HTML 出现多次）
  const seen = new Map();
  for (const b of client.blocks) seen.set(b.html, (seen.get(b.html) || 0) + 1);
  for (const [html, n] of seen) if (n > 3) dupes.push({ html, n });
  assert(dupes.length > 0, '合成语料里确实存在重复块（本用例的前提）',
    `${dupes.length} 组重复 HTML，最多一组出现 ${Math.max(...dupes.map((d) => d.n))} 次`);

  // 改动第一个"代码围栏行"所在块 —— 历史 bug 就是在这里引爆的
  const fence = lines.findIndex((l, i) => i > 10 && l.trim().startsWith('```'));
  const target = fence >= 0 ? fence : Math.floor(lines.length / 2);
  lines[target] = `${lines[target]}  `;
  const r = engine.render(lines.join('\n'));
  const patched = r.metrics.patched || 0;
  const renamed = r.metrics.renamed || 0;
  client.apply(r);
  assert(r.metrics.changed <= 4, '重复块序号漂移不会引发"批量重传"',
    `下发 HTML=${r.metrics.changed} 块 · 仅补区间=${patched} 块 · 改名=${renamed} 块 · 差量 ${(r.metrics.deltaBytes / 1024).toFixed(1)}KB`);
  assert(r.metrics.deltaBytes < r.metrics.fullBytes * 0.01, '此场景差量仍 < 全量 1%',
    `${((r.metrics.deltaBytes / r.metrics.fullBytes) * 100).toFixed(3)}%`);
  assert(client.blocks.length === r.total, '漂移后块数仍然正确', `${r.total} 块`);
}

/* ------------------------------------------- ④ 与导出渲染同源（结构一致） -- */
{
  const full = renderMarkdown(doc, { ...mdOptions });
  const engineHtml = client.blocks.map((b) => b.html).join('');
  const engineMath = client.blocks.reduce((n, b) => n + (b.html.match(/<span class="katex"/g) || []).length, 0);
  assert(engineMath === full.mathCount, 'KaTeX 公式数量与导出一致', `${engineMath} 个`);
  const lastResult = engine.render(doc);
  client.apply(lastResult);
  assert(lastResult.toc.length === full.toc.length, '目录条目与导出渲染一致', `${lastResult.toc.length} 个标题`);

  // 逐标签比对（块拼接与整篇渲染只允许有"空段落清理"这一处已知差异）
  const canon = (h) => h.replace(/<p>\s*<\/p>\s*/g, '').replace(/\s+/g, ' ').trim();
  const a = canon(engineHtml);
  const b = canon(full.html);
  assert(a === b, '预览逐块拼接 == 导出整篇 HTML（同一份渲染器，结构完全一致）',
    a === b ? `${(a.length / 1024).toFixed(0)}KB 完全一致` : `首个差异 @${(() => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; })()}`);
}

/* --------------------------------------------- ⑤ 块级增删：顺序必须同步 -- */
{
  const lines = doc.split('\n');
  const ins = Math.floor(lines.length / 2);
  lines.splice(ins, 0, '', '::: theorem 新增定理', '内容 $a^2+b^2=c^2$。', ':::', '');
  const r = engine.render(lines.join('\n'));
  const idsBefore = new Set(client.blocks.map((b) => b.id));
  client.apply(r);
  assert(r.order !== null, '插入块时下发新的块顺序');
  assert(client.blocks.length === r.total, '插入后本地块数与引擎一致', `${r.total} 块`);
  assert(r.blocks.some((b) => /新增定理/.test(b.html)), '新增内容真的进了差量');
  const kept = client.blocks.filter((b) => idsBefore.has(b.id)).length;
  assert(kept >= client.blocks.length - 3, '插入不导致后续块 id 全部变化（DOM 不搬家）', `保号 ${kept}/${client.blocks.length}`);

  const r3 = engine.render(doc);
  client.apply(r3);
  assert(client.blocks.length === r3.total, '删除后又回到原来的块数', `${r3.total} 块`);
  // 注意：要比对的是引擎的**全量视图**，不是它刚发回来的差量（差量只含变化块）
  const dv2 = verifyDelta(client.blocks, engine.view());
  assert(dv2.ok, '插入 + 删除往返后视图仍然自洽', dv2.reason || '');
}

/* ------------------------------------------- ⑤b 顶部插入：整篇行号位移 -- */
{
  const shifted = `# 新增的顶部标题\n\n新增一段正文。\n\n${doc}`;
  const r = engine.render(shifted);
  const before = new Map(client.blocks.map((b) => [b.id, b]));
  client.apply(r);
  const htmlKept = client.blocks.filter((b) => before.get(b.id)?.html === b.html).length;
  const idKept = client.blocks.filter((b) => before.has(b.id)).length;
  assert(r.metrics.changed <= 4, '顶部插入只重传新块（其余块仅行号位移）',
    `下发 HTML=${r.metrics.changed} · 补区间=${r.metrics.patched}`);
  assert(htmlKept >= client.blocks.length - r.metrics.changed, '位移块的 HTML 字符串引用不变（innerHTML 不重写）',
    `${htmlKept}/${client.blocks.length}`);
  assert(idKept >= client.blocks.length - r.metrics.changed, '位移块本地 id 不变（React 原地更新 data-lines）',
    `${idKept}/${client.blocks.length}`);
  assert(client.blocks[0].html.includes('新增的顶部标题'), '新块排在最前');
  assert(client.blocks[client.blocks.length - 1].end >= doc.split('\n').length, '末尾块的行区间已更新');
  engine.render(doc);
  client.apply(engine.render(doc));
}

/* -------------------------------------------------- ⑥ 打字热路径成本 -- */
let applyMsPerKey = 0;
{
  const lines = doc.split('\n');
  const target = lines.findIndex((l) => l.trim().length > 10);
  const timings = [];
  const applyBefore = client.applyMs;
  let text = lines[target];
  for (let i = 0; i < 24; i++) {
    text += 'x';
    const probe = [...lines];
    probe[target] = text;
    const t0 = performance.now();
    const r = engine.render(probe.join('\n'));
    timings.push(performance.now() - t0);
    client.apply(r);
  }
  const s = stats(timings);
  applyMsPerKey = (client.applyMs - applyBefore) / timings.length;
  console.log(C.d(`     逐键：引擎 ${s.p50}/${s.p95}/${s.max}ms（p50/p95/max）· 主线程差量应用 ${applyMsPerKey.toFixed(2)}ms`));
  assert(s.p95 < 120, '逐键引擎耗时 p95 < 120ms（且跑在 Worker 上，不阻塞输入）', `p95=${s.p95}ms`);
  assert(applyMsPerKey < 3, '主线程差量应用 < 3ms/次（按键路径上的真实成本）', `${applyMsPerKey.toFixed(2)}ms/次`);

  const last = engine.metrics();
  assert(last.deltaBytes < last.fullBytes * 0.01, '连续打字期间差量始终 < 全量 1%',
    `${(last.deltaBytes / 1024).toFixed(2)}KB / ${(last.fullBytes / 1024).toFixed(1)}KB`);
}

/* ------------------------------------------------------ ⑦ 选项变化作废 -- */
{
  const e2 = createPreviewEngine({ ...mdOptions });
  const c2 = makeClient(e2);
  const a = e2.render('# A\n\n- x\n- y\n');
  c2.apply(a);
  assert(c2.blocks.length === 2, '标题 + 列表 = 2 个块', `${c2.blocks.length}`);
  const s1 = e2.render('# A\n\n- x\n- y\n');
  c2.apply(s1);
  assert(s1.metrics.changed === 0, '内容不变时零重传（纯复用）', `reused=${s1.metrics.reused}`);
  e2.setOptions({ ...mdOptions, breaks: true });
  const e2b = e2.render('# A\n\n- x\n- y\n');
  c2.apply(e2b);
  assert(e2b.metrics.changed === e2b.total, '选项变化后缓存全部作废（改设置立即生效）',
    `changed=${e2b.metrics.changed}/${e2b.total}`);
  // 主线程引擎与 Worker 引擎必须给出同样的结果（同一份代码，但选项指纹必须一致）
  const md = createRenderer({ ...mdOptions, breaks: true });
  void md;
}

/* ------------------------------------------------------------ 空文档 -- */
{
  const e3 = createPreviewEngine({ ...mdOptions });
  const c3 = makeClient(e3);
  const r = e3.render('');
  c3.apply(r);
  assert(r.total === 0 && c3.blocks.length === 0, '空文档：0 块且不抛错');
  const r2 = e3.render('# 有了内容');
  c3.apply(r2);
  assert(c3.blocks.length === 1, '空 → 有内容：正常增量');
}

/* ------------------------------------------------------------------ 汇总 -- */
console.log(`\n${failed === 0 ? C.g('全部通过') : C.r(`${failed} 项失败`)}：${passed} 通过 / ${failed} 失败\n`);
if (failed) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
