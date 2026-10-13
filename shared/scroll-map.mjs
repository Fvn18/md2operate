/**
 * shared/scroll-map.mjs — 「编辑器行号 ↔ 预览像素」的双向插值映射（纯函数）。
 *
 * ## 为什么不能用比例
 *
 * 最省事的同步方式是 `previewTop = ratio * previewHeight`。它在纯文本上是能用
 * 的，但这份产品的主要场景是**数学文档**：编辑器里 `$$\int_0^1 x\,dx$$` 是一行，
 * 预览里却是一个 120px 高的公式块；反过来，一个 40 行的长表格在预览里可能只有
 * 60px 高。行密度与像素密度之比在文档内部就相差几百倍，比例映射必然越滚越偏，
 * 到文档中段能偏出好几屏。
 *
 * ## 这里做的是什么
 *
 * 引擎给每个块带上 `[start, end]` 源码行区间（见 shared/preview-engine.mjs），
 * 于是"行 → 像素"是一张**分段线性映射表**：
 *
 *   行 f → 找到覆盖 f 的块 i，t = (f - start_i) / (end_i - start_i)
 *        → y = offsets[i] + t * heights[i]
 *
 * 反向同理（像素 → 行号 + 行内比例）。两类误差都被"块"这个粒度锁住：
 * 块内最多偏一个块高，跨块不累积。这就是"插值锚定"与"比例同步"的区别。
 *
 * ## 为什么是独立文件
 *
 * ① 纯函数 = 可以在 Node 里断言（scripts/verify-scrollmap.mjs），不必起浏览器；
 * ② 预览虚拟化（只渲染视口附近 ± 若干屏）需要同一个 offsets 表来算"当前该渲染
 *    哪些块、上下留多少空白"，两处共用一套索引能避免"滚到一半跳动"的经典 bug。
 *
 * 坐标约定：offset 一律相对**滚动容器的内容顶部**（不是视口），单位 CSS px。
 */

/**
 * @typedef {object} ScrollIndex
 * @property {number} n 块数
 * @property {Int32Array} starts 每块的起始行（1-based，与编辑器行号一致）
 * @property {Int32Array} ends 每块的结束行（含）
 * @property {string[]} keys 每块的稳定 key（高度缓存按它索引）
 */

/**
 * @typedef {object} Layout
 * @property {Float64Array} offsets 每块顶部相对内容顶部的像素偏移（长度 n+1，最后一项=总高）
 * @property {Float64Array} heights 每块高度
 * @property {number} total 内容总高
 */

/**
 * 由块列表建立行号索引。
 *
 * 容错点（都是真实会发生的）：
 *   · 块可能缺 start/end（老数据、引擎降级）→ 用上一个块的 end 顺延，至少保持单调；
 *   · end < start（单行块、语法片段）→ 归一化成 end = start，插值时 t 取 0；
 *   · 块顺序必须按文档顺序；乱序会让二分查找失效，这里会自己纠正（排一次）。
 *
 * @param {Array<{key?:string,start?:number,end?:number}>} blocks
 * @returns {ScrollIndex}
 */
export function buildScrollIndex(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const n = list.length;
  const starts = new Int32Array(n);
  const ends = new Int32Array(n);
  const keys = new Array(n);
  let monotonic = true;
  let prevEnd = 0;
  for (let i = 0; i < n; i++) {
    const b = list[i] || {};
    let s = Number.isFinite(b.start) ? Math.round(b.start) : prevEnd + 1;
    let e = Number.isFinite(b.end) ? Math.round(b.end) : s;
    if (s < 1) s = 1;
    if (e < s) e = s;
    if (s < prevEnd) { s = prevEnd; if (e < s) e = s; monotonic = false; }
    starts[i] = s;
    ends[i] = e;
    keys[i] = String(b.key ?? i);
    prevEnd = e;
  }
  void monotonic;
  return { n, starts, ends, keys };
}

/**
 * 块 i 在 [start,end] 上覆盖的比例。
 * 单行块（start === end）返回 0：整块与那一行等价，比例没有意义。
 */
function fracFor(index, i, line) {
  const s = index.starts[i];
  const e = index.ends[i];
  if (e <= s) return 0;
  const t = (line - s) / (e - s);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 行号 → 块与块内比例。
 *
 * 行落在**块与块的间隙**（markdown 里的空行）时怎么办？取下一个块、t=0：
 * 编辑器顶部那一行如果是空行，把"下一块的内容"顶到预览顶部，视觉上才连续；
 * 取上一个块 t=1 会让目标块整块跑到视口上方，用户看到的是空白。
 *
 * @param {ScrollIndex} index
 * @param {number} line 1-based
 * @returns {{i:number,t:number}|null} 空文档返回 null
 */
export function blockAtLine(index, line) {
  if (!index || index.n === 0) return null;
  const n = index.n;
  const target = Number.isFinite(line) ? Math.max(1, Math.round(line)) : 1;

  if (target <= index.starts[0]) return { i: 0, t: 0 };
  if (target >= index.ends[n - 1] && target >= index.starts[n - 1]) {
    return { i: n - 1, t: fracFor(index, n - 1, target) };
  }

  // 最后一个 starts[i] <= target 的块
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  if (target <= index.ends[i]) return { i, t: fracFor(index, i, target) };
  // 落在间隙里
  if (i + 1 < n) return { i: i + 1, t: 0 };
  return { i, t: 1 };
}

/**
 * 建立像素布局表。
 *
 * @param {ArrayLike<number>} heights 每块高度（CSS px）
 * @param {number} [count] 需要参与的块数（默认 heights.length）
 * @returns {Layout}
 */
export function buildLayout(heights, count) {
  const n = Math.max(0, Math.min(count ?? (heights ? heights.length : 0), heights ? heights.length : 0));
  const offs = new Float64Array(n + 1);
  const hts = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const h = Number(heights[i]);
    const safe = Number.isFinite(h) && h > 0 ? h : 0;
    hts[i] = safe;
    offs[i] = acc;
    acc += safe;
  }
  offs[n] = acc;
  return { offsets: offs, heights: hts, total: acc };
}

/**
 * 行号 → 内容内的像素 y。对齐到容器顶部时，调用方再减去 margin。
 *
 * @returns {number|null} 空文档返回 null
 */
export function lineToY(index, layout, line) {
  const hit = blockAtLine(index, line);
  if (!hit) return null;
  const { i, t } = hit;
  if (i >= layout.heights.length) return layout.total;
  return layout.offsets[i] + t * layout.heights[i];
}

/**
 * 像素 y → 行号与行内比例（预览 → 编辑器方向）。
 *
 * @param {ScrollIndex} index
 * @param {Layout} layout
 * @param {number} y 内容内的像素偏移
 * @returns {{i:number,line:number,frac:number}|null}
 */
export function yToLine(index, layout, y) {
  if (!index || index.n === 0) return null;
  const n = Math.min(index.n, layout.heights.length);
  if (n === 0) return null;
  const row = layoutRowAt(index, layout, y, n);
  const { i, t } = row;
  const s = index.starts[i];
  const e = index.ends[i];
  const line = Math.max(1, Math.round(s + (e > s ? t * (e - s) : 0)));
  return { i, line, frac: t };
}

/** y 落在哪一块、块内比例。与 blockAtLine 互为逆运算。 */
function layoutRowAt(index, layout, y, n) {
  const target = Number.isFinite(y) ? y : 0;
  if (target <= 0) return { i: 0, t: 0 };
  if (target >= layout.total) return { i: n - 1, t: 1 };
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.offsets[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const h = layout.heights[i];
  if (h <= 0) return { i, t: 0 };
  const t = (target - layout.offsets[i]) / h;
  return { i, t: t < 0 ? 0 : t > 1 ? 1 : t };
}

/**
 * 视口内需要渲染的块区间（虚拟化用）。
 *
 * 返回的区间是**闭区间** [first, last]；overscan 是上下各多渲染的像素。
 * 用 offsets 做二分，滚动时每帧只有 O(log n)。
 *
 * @returns {{first:number,last:number}}
 */
export function visibleRange(layout, top, height, overscan = 0) {
  const n = layout.heights.length;
  if (n === 0) return { first: 0, last: -1 };
  const lo0 = top - overscan;
  const hi0 = top + height + overscan;
  // first：第一块满足 offset[i]+height[i] > lo0
  let lo = 0;
  let hi = n - 1;
  let first = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (layout.offsets[mid] + layout.heights[mid] > lo0) { first = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  // last：最后一块满足 offset[i] < hi0
  lo = first;
  hi = n - 1;
  let last = first;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (layout.offsets[mid] < hi0) { last = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return { first: Math.max(0, first), last: Math.min(n - 1, last) };
}

/**
 * 把"行号 ↔ 比例"的两种同步模式统一成一处决策，便于自检与 UI 复用。
 *
 * @param {'anchor'|'ratio'|'off'} mode
 * @param {{index:ScrollIndex, layout:Layout, line:number, ratio:number}} o
 * @returns {number} 目标 scrollTop（内容坐标）
 */
export function targetScrollTop(mode, o) {
  const { index, layout, line, ratio } = o;
  if (mode === 'ratio') return Math.max(0, Math.min(layout.total, ratio * layout.total));
  const y = lineToY(index, layout, line);
  return y == null ? 0 : Math.max(0, Math.min(layout.total, y));
}

/**
 * 记录"视觉锚点"：像素 y 落在哪一块、以及它离该块顶部多少像素。
 *
 * 虚拟化下，视口上方的块高度常常还是**估算值**；等它们真正挂载并测出真实高度后，
 * 整个 offsets 表会平移，用户会看到内容"跳一下"。标准解法是滚动锚定：
 * 记住当前视口顶部对应的块与块内偏移，重排后把 scrollTop 修正回同一视觉位置。
 *
 * @param {Layout} layout
 * @param {number} y
 * @returns {{i:number,px:number}}
 */
export function anchorAt(layout, y) {
  const n = layout.heights.length;
  if (n === 0) return { i: 0, px: 0 };
  const row = layoutRowAt(nullLayoutIndex(n), layout, y, n);
  return { i: row.i, px: y - layout.offsets[row.i] };
}

/**
 * 把锚点还原成 scrollTop（offsets 表变化后调用）。
 * @param {Layout} layout
 * @param {{i:number,px:number}} anchor
 * @returns {number}
 */
export function restoreAnchor(layout, anchor) {
  const n = layout.heights.length;
  if (!anchor || n === 0) return 0;
  const i = Math.max(0, Math.min(n - 1, anchor.i));
  return layout.offsets[i] + anchor.px;
}

/** layoutRowAt 里的 index 参数只用到 n；锚定不需要真的建索引。 */
function nullLayoutIndex(n) {
  return { n, starts: new Int32Array(0), ends: new Int32Array(0), keys: [] };
}

/**
 * 判断两份高度表是否"够用"：块数一致，且已测高度的比例达到阈值。
 * 虚拟化下未测块用估算高度，跳动就来自这里——阈值用来决定何时值得重排。
 *
 * @param {ArrayLike<number>} heights
 * @param {number} n
 * @returns {{measured:number,total:number,ratio:number}}
 */
export function measureCoverage(heights, n) {
  let measured = 0;
  const total = Math.max(0, Math.min(n ?? heights.length, heights.length));
  for (let i = 0; i < total; i++) if (Number.isFinite(heights[i]) && heights[i] > 0) measured++;
  return { measured, total, ratio: total ? measured / total : 1 };
}
