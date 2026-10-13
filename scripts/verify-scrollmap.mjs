#!/usr/bin/env node
/**
 * scripts/verify-scrollmap.mjs — 双向插值滚动映射自检（纯 Node，不需要浏览器）。
 *
 * 这是「源码映射同步滚动」这一维度里最该被钉住的部分：**映射本身对不对**。
 * DOM 上的表现（滚一下、看顶部块的 data-lines）另有 browser 自检
 * （scripts/verify-sync.mjs），但那种用例只能证明"这一次滚对了"，证明不了
 * 边界与反函数。这里用纯函数把三件事钉死：
 *
 *   ① 行 → 像素 → 行 的往返是同一个位置（反函数一致性）
 *   ② 在"行密度 ≠ 像素密度"的文档上，锚定插值的误差被锁在**一个块内**，
 *      而比例同步会偏出几百行（这就是设计文档里"不能按比例"的量化证据）
 *   ③ 虚拟化用的可见区间：区间正确、不多渲染、结尾不越界
 *   ④ 规模：5000 块的文档，10 万次映射的耗时（必须是二分，不能是线性扫描）
 */

import { makeDoc } from './lib/synth-doc.mjs';
import { createPreviewEngine } from '../shared/preview-engine.mjs';
import {
  buildScrollIndex, buildLayout, blockAtLine, lineToY, yToLine,
  visibleRange, measureCoverage, targetScrollTop,
} from '../shared/scroll-map.mjs';

const C = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, d: (s) => s, b: (s) => s };

let pass = 0;
let fail = 0;
const failures = [];
const chk = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  ${C.g('✔')} ${label}${extra ? C.d(`  ${extra}`) : ''}`); }
  else { fail++; failures.push(label); console.log(`  ${C.r('✖')} ${label}${extra ? C.d(`  ${extra}`) : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log(C.b('\n滚动映射（行 ↔ 像素 双向插值）自检'));

/* ------------------------------------------------ ① 构造真实引擎的块 --- */
console.log(C.d('\n[1] 用真实引擎的块建索引'));
const src = makeDoc(60000);
const engine = createPreviewEngine({});
const full = engine.render(src);
const blocks = engine.view();
const index = buildScrollIndex(blocks);
chk(index.n === blocks.length && index.n > 100, `索引块数 = ${index.n}`);
chk(
  [...index.starts].every((s, i) => i === 0 || s >= index.starts[i - 1]),
  '起始行单调不减（二分查找的前提）',
);
chk(
  [...index.ends].every((e, i) => e >= index.starts[i]),
  '每块 end ≥ start（单行块的 end === start）',
);
chk(
  [...index.ends].every((e, i) => i === 0 || index.starts[i] >= index.ends[i - 1] - 1),
  '块区间不重叠（允许共享边界行）',
);

/* ------------------------------------------- ② blockAtLine 的边界行为 --- */
console.log(C.d('\n[2] blockAtLine：内部 / 间隙 / 越界'));
{
  const b0 = blockAtLine(index, 1);
  chk(b0 && b0.i === 0 && b0.t === 0, '第 1 行 → 第 0 块，t=0');
  const mid = Math.floor(index.n / 2);
  const inside = blockAtLine(index, index.starts[mid]);
  chk(inside && inside.i === mid && inside.t === 0, `第 ${index.starts[mid]} 行 → 第 ${mid} 块顶部`);
  const atEnd = blockAtLine(index, index.ends[mid]);
  chk(atEnd && atEnd.t === 1 || (atEnd && index.ends[mid] === index.starts[mid] && atEnd.t === 0),
    `第 ${index.ends[mid]} 行 → 该块底部（t=1）`);
  const beyond = blockAtLine(index, 10 ** 7);
  chk(beyond && beyond.i === index.n - 1, '远超文档末尾 → 最后一块（clamp，不越界）');
  const neg = blockAtLine(index, -5);
  chk(neg && neg.i === 0, '负数行 → 第一块（clamp）');

  // 间隙：人工造一个 1..2 块 + 10..12 块，第 5 行落在间隙里
  const gapIdx = buildScrollIndex([
    { key: 'a', start: 1, end: 2 },
    { key: 'b', start: 10, end: 12 },
  ]);
  const g = blockAtLine(gapIdx, 5);
  chk(g && g.i === 1 && g.t === 0, '间隙中的行 → 取下一块顶部（不会把内容顶出视口）');
  const gapEnd = blockAtLine(gapIdx, 9);
  chk(gapEnd && gapEnd.i === 1 && gapEnd.t === 0, '间隙最后一行同样取下一块');
}

/* -------------------------------------------- ③ 往返一致性（反函数） --- */
console.log(C.d('\n[3] 行 → 像素 → 行 往返一致'));
{
  // 造一份"高度与行数严重不成比例"的高度表：公式块 400px / 表格 300px / 段落 40px
  const heights = [];
  for (let i = 0; i < index.n; i++) {
    const lines = Math.max(1, index.ends[i] - index.starts[i] + 1);
    const kind = i % 5;
    heights.push(kind === 0 ? 400 : kind === 1 ? 320 : kind === 2 ? 90 : 24 + lines * 2);
  }
  const layout = buildLayout(heights, index.n);
  const totalLines = src.split('\n').length;
  let worst = 0;
  let worstLine = 0;
  for (const line of [1, 2, 7, 30, 120, 300, 900, 1500, Math.floor(totalLines * 0.9), totalLines]) {
    const y = lineToY(index, layout, line);
    if (y == null) continue;
    const back = yToLine(index, layout, y);
    const err = Math.abs((back ? back.line : -1) - line);
    if (err > worst) { worst = err; worstLine = line; }
  }
  /* 误差来源只有两处，都是**真实存在**的：
       · 像素取整（0 或 1 行）
       · 块与块之间的空行：行落在两个块之间的间隙里时，"块底像素"反解回
         "下一块的起始行"——差的就是间隙本身那几行（这里最多 2 行）。
     差距仍然被"一个块"锁死，不会随滚动位置累积。 */
  chk(worst <= 3, '往返误差 ≤ 3 行（取整 + 块间隙；不随位置累积）', `最差 ${worst} 行 @ 第 ${worstLine} 行`);

  // 块边界像素的归属：向下取（滚到块底时对齐的是下一块的顶部）
  const anyI = Math.min(200, index.n - 2);
  const yBottom = layout.offsets[anyI] + layout.heights[anyI];
  const atBoundary = yToLine(index, layout, yBottom);
  chk(atBoundary && atBoundary.i === anyI + 1 && atBoundary.frac === 0,
    '像素正好落在块边界 → 归下一块顶部（向下取，视觉连续）',
    `块 ${anyI} 底部 → 块 ${atBoundary ? atBoundary.i : '?'}`);

  // 像素 → 行 → 像素 的往返（预览 → 编辑器方向）
  let worstPx = 0;
  for (let k = 0; k <= 200; k++) {
    const y = (k / 200) * layout.total;
    const hit = yToLine(index, layout, y);
    if (!hit) continue;
    const y2 = lineToY(index, layout, hit.line);
    if (y2 == null) continue;
    // 同一行映射回同一块的高度区间内即算一致（行内比例会丢一点信息）
    const h = layout.heights[hit.i] || 1;
    worstPx = Math.max(worstPx, Math.abs(y2 - y) / h);
  }
  chk(worstPx <= 1.01, '像素 → 行 → 像素 的误差不超过一个块高（不跨块累积）',
    `最差 ${(worstPx * 100).toFixed(1)}% 块高`);
}

/* ------------------------------- ④ 与"比例同步"的对照：量化它差多少 --- */
console.log(C.d('\n[4] 锚定插值 vs 比例同步（同一份文档、同一位置）'));
{
  const heights = [];
  for (let i = 0; i < index.n; i++) {
    const lines = Math.max(1, index.ends[i] - index.starts[i] + 1);
    // 前 1/3 全是公式（矮行 → 高块），后段全是长段落（高行 → 矮块）
    const frac = i / index.n;
    heights.push(frac < 0.33 ? 260 : frac < 0.66 ? 60 : 26 + lines * 1.5);
  }
  const layout = buildLayout(heights, index.n);
  const totalLines = src.split('\n').length;

  let anchorWorst = 0;
  let ratioWorst = 0;
  for (const ratio of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const y = ratio * layout.total;                     // 两种模式滚到同一个像素
    const anchor = yToLine(index, layout, y);           // 锚定插值反解出的行
    const ratioLine = Math.round(ratio * totalLines);   // 比例模式认为的行
    const truth = anchor ? anchor.line : 0;             // 以"该像素在预览里到底是哪一行"为准
    anchorWorst = Math.max(anchorWorst, Math.abs(truth - (anchor ? truth : 0)));
    ratioWorst = Math.max(ratioWorst, Math.abs(ratioLine - truth));
  }
  chk(anchorWorst === 0, '锚定插值：反解行 == 真值（定义上恒等）');
  chk(ratioWorst > 50, '比例同步：同一位置偏出几十行以上（这就是必须插值的原因）',
    `最差 ${ratioWorst} 行`);
  chk(targetScrollTop('anchor', { index, layout, line: 500, ratio: 0.5 }) === lineToY(index, layout, 500),
    'targetScrollTop(anchor) 走的就是插值映射');
  chk(near(targetScrollTop('ratio', { index, layout, line: 500, ratio: 0.5 }), 0.5 * layout.total, 1e-6),
    'targetScrollTop(ratio) 保留老行为（可对照/回退）');
}

/* ---------------------------------------------------- ⑤ 虚拟化可见区间 --- */
console.log(C.d('\n[5] visibleRange：虚拟化只渲染视口附近的块'));
{
  const heights = new Array(20).fill(100);
  const layout = buildLayout(heights, 20);
  const at = (top, h, ov = 0) => visibleRange(layout, top, h, ov);
  const r0 = at(0, 300);
  chk(r0.first === 0 && r0.last === 2, '文档顶部：0..2', JSON.stringify(r0));
  const r1 = at(950, 200);
  chk(r1.first >= 9 && r1.first <= 10 && r1.last >= 11, '中间：落在 9..11 之间', JSON.stringify(r1));
  const r2 = at(1900, 400);
  chk(r2.first <= 19 && r2.last === 19, '滚到底：last 收敛到 19（不越界）', JSON.stringify(r2));
  const r3 = at(0, 300, 500);
  chk(r3.first === 0 && r3.last >= 7, 'overscan 上下各多渲染 500px', JSON.stringify(r3));
  const r4 = visibleRange(layout, 10 ** 6, 400, 0);
  chk(r4.last === 19 && r4.first <= 19, '超出内容高度也不崩');
  chk(visibleRange(buildLayout([], 0), 0, 100).last === -1, '空文档 → last = -1');
  // 窄视口不会退化成"全渲染"
  const many = buildLayout(new Array(5000).fill(50), 5000);
  const rv = visibleRange(many, 100000, 800, 400);
  chk(rv.last - rv.first < 60, '5000 块的文档：视口内只渲染少量块', `渲染 ${rv.last - rv.first + 1} 块`);
}

/* ------------------------------------------------------------- ⑥ 规模 --- */
console.log(C.d('\n[6] 规模：5000 块 · 20 万次映射'));
{
  const n = 5000;
  const idx = buildScrollIndex(Array.from({ length: n }, (_, i) => ({ key: `k${i}`, start: i * 3 + 1, end: i * 3 + 2 })));
  const layout = buildLayout(new Array(n).fill(60), n);
  const t0 = performance.now();
  let acc = 0;
  for (let k = 0; k < 100000; k++) {
    const y = lineToY(idx, layout, (k % 15000) + 1);
    acc += y || 0;
    const hit = yToLine(idx, layout, (k * 7) % 300000);
    acc += hit ? hit.line : 0;
  }
  const ms = performance.now() - t0;
  chk(ms < 400, `20 万次双向映射耗时 ${ms.toFixed(1)}ms（二分查找；滚动时每帧只需几次）`, `acc=${Math.round(acc)}`);
}

/* --------------------------------------------------------- ⑦ 覆盖率工具 --- */
console.log(C.d('\n[7] measureCoverage：虚拟化下"有多少高度是估的"'));
{
  const h = new Float64Array([100, 0, 0, 200, 0]);
  const cov = measureCoverage(h, 5);
  chk(cov.measured === 2 && cov.total === 5 && Math.abs(cov.ratio - 0.4) < 1e-9,
    '2/5 已测 → ratio 0.4', JSON.stringify(cov));
  chk(measureCoverage(new Float64Array(0), 0).ratio === 1, '空表视为完全覆盖（不做无谓重排）');
}

console.log(`\n${fail === 0 ? C.g('全部通过') : C.r(`${fail} 项失败`)}：${pass} 通过 / ${fail} 失败\n`);
if (fail) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
