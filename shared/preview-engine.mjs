/**
 * shared/preview-engine.mjs — 预览渲染引擎（**不含任何 DOM/平台 API**）。
 *
 * 这一层的存在理由，是把"渲染"从"渲染完成后怎么贴到页面上"里彻底摘出来：
 *
 *   · 它可以直接跑在 Web Worker 里（浏览器主线程只拿结果、贴 DOM）
 *   · 它可以直接跑在 Node 里（自检脚本逐条断言，不需要浏览器）
 *
 * 上一版把「解析 + KaTeX 渲染 + 贴 DOM」全放在主线程的一次 render 里，10 万字符
 * 文档下每次按键 ~140ms 的解析排版时间直接吃掉主线程，按键延迟被拉到 55ms+。
 * 现在解析排版在 Worker 里做，主线程只剩"把变化的块贴上去"。
 *
 * ---------------------------------------------------------------------------
 * 差量协议（对外只发变化的部分，且必须经得起自检）：revision
 *   order    string[]|null   块的 key 序列；键集合或顺序变了才下发
 *   blocks   Block[]         新增或 HTML 变化的块（完整内容）
 *   ranges   {key:[s,e]}     HTML 没变、只是源码行区间变了（插入/删除行导致位移）
 *   removed  string[]        消失的 key
 *
 * 两个被**真实的坑**逼出来的设计：
 *
 * ① `ranges`：插入/删除行会让后面所有块的源码行区间整体位移。若按"行区间变了 = 块
 *    变了"处理，插一行就要重传整篇；实际只需要发 [start,end] 这样的十来个字节。
 *
 * ② **key 是"被继承的身份"，不是"内容哈希"**。早期版本直接把内容哈希（+重复序号）
 *    当 key，于是文档里只要有重复样板块（同一段代码、同一条列表项），改动第一处
 *    重复就会让后面 127 个重复块的序号整体挪一位 —— "改一行"被报成 128 块变化，
 *    84KB HTML 白白重传，127 个 DOM 节点被无谓重建。
 *    现在的规则是：本轮某块若与上一轮某块（同位置、或同内容哈希）匹配上，就**沿用
 *    它的 key**；只有真正的新块才拿新的 key。身份因此是稳定的，客户端 key → 本地
 *    块 id 的映射也是稳定的（React 原地更新，不卸载重建）。
 *
 * 客户端侧用 applyDelta() 把差量合成有序块数组，并**保持未变更块的对象引用不变** ——
 * 这是 React.memo 能 O(1) 跳过、一个 DOM 节点都不碰的前提。
 */

import { createIncrementalRenderer } from './incremental.mjs';

/** 协议版本：worker 与主线程各自构建产物可能不同步，用它一眼看出"版本对不上"。 */
export const PREVIEW_PROTOCOL_VERSION = 2;

/** 块的字节数（UTF-8 近似，用于量化"差量到底省了多少"）。 */
function bytes(str) {
  if (!str) return 0;
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

/**
 * 创建预览引擎。
 *
 * @param {object} [options] 与 createIncrementalRenderer 相同（markdown 选项）
 * @returns {{
 *   render(source:string): object, reset(): void, seed(blocks:Array<object>): number,
 *   setOptions(next:object): void, blockCount(): number, metrics(): object|null,
 *   view(): Array<object>,
 * }}
 */
export function createPreviewEngine(options = {}) {
  let opts = { ...options };
  let renderer = createIncrementalRenderer({ ...opts, debugKeys: true });
  /** @type {{keys:string[], byKey:Map<string,object>, list:object[]}|null} */
  let last = null;
  let revision = 0;
  let lastMetrics = null;

  function reset() {
    renderer.reset();
    renderer = createIncrementalRenderer({ ...opts, debugKeys: true });
    last = null;
    revision = 0;
    lastMetrics = null;
  }

  function render(source) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const res = renderer.render(source);
    const src = res.blocks;

    const byKey = new Map();
    const list = new Array(src.length);
    const keys = new Array(src.length);
    const blocks = [];
    const ranges = {};
    /** 已经被本轮认领的旧条目：一个旧块只能对应一个新位置，否则会丢内容 */
    const consumed = new Set();
    /** 本轮已发出的 key（必须唯一，否则客户端映射会错乱） */
    const taken = new Set();

    let deltaBytes = 0;
    let fullBytes = 0;
    let rangePatches = 0;

    /** 取一个本轮唯一的 key：优先沿用继承来的 key，撞车时加后缀（极罕见）。 */
    const claimKey = (base) => {
      if (!taken.has(base)) { taken.add(base); return base; }
      let n = 2;
      while (taken.has(`${base}+${n}`)) n++;
      const k = `${base}+${n}`;
      taken.add(k);
      return k;
    };

    for (let i = 0; i < src.length; i++) {
      const nb = src[i];
      fullBytes += bytes(nb.html);

      let match = null;

      // ① **先看同一位置**：同一位置的块 HTML 相同 → 就是同一个块（哪怕内容哈希变了）。
      //    顺序不能反：先按内容哈希匹配，会在"重复块序号漂移"时认领到另一个位置的
      //    旧块（内容一样、行区间不同），白送一堆行号补丁。实测这条顺序差异决定了
      //    "改一行 → 127 个块被标记位移"还是"0 个"。
      const idxHit = last ? last.list[i] : null;
      if (idxHit && idxHit.html === nb.html && !consumed.has(idxHit)) {
        match = idxHit;
      } else {
        // ② 位置对不上（插入/删除导致整体位移）→ 按内容哈希找回，只补行号区间
        const hashHit = last ? last.byKey.get(nb.key) : null;
        if (hashHit && hashHit.html === nb.html && !consumed.has(hashHit)) match = hashHit;
      }

      /* 复用旧块的前提：**客户端手上确实有一个同键的块**。
         所以键一律"继承旧键"（match.key），而不是用这一轮的内容哈希：
         继承出来的键一定在客户端存在，未发送的块就不会出现"客户端没有这个键"。
         唯一的例外见下面 taken.has(key) 分支。 */
      if (match && !taken.has(match.key)) {
        consumed.add(match);
        const key = match.key;
        taken.add(key);
        if (match.start !== nb.start || match.end !== nb.end) {
          ranges[key] = [nb.start, nb.end];
          deltaBytes += 12;
          rangePatches++;
        }
        // 引擎侧就地更新（这个对象不会再发给客户端，只用于下一轮比较）
        match.start = nb.start;
        match.end = nb.end;
        byKey.set(key, match);
        list[i] = match;
        keys[i] = key;
      } else {
        /* 走到这里有两种情况：
           ① 这块内容变了（或新插入）——整块下发；
           ② 匹配到的旧块的键**本轮已被占用**（同内容的块出现了两次，序号漂移时
              会撞名）。这时不能悄悄给它加后缀：客户端看不到那个后缀，会直接报
              "缺少块"。整块下发最稳，代价只是这几块重传一次 HTML。 */
        if (match) consumed.add(match);
        const key = claimKey(match ? match.key : nb.key);
        const block = { key, html: nb.html, first: nb.first, start: nb.start, end: nb.end };
        byKey.set(key, block);
        list[i] = block;
        keys[i] = key;
        blocks.push(block);
        deltaBytes += bytes(nb.html);
      }
    }

    // 消失的块：上一轮有、这一轮没被任何块继承
    const removed = [];
    if (last) {
      for (const k of last.byKey.keys()) if (!byKey.has(k)) removed.push(k);
    }

    const orderChanged = !last || last.keys.length !== keys.length || keys.some((k, i) => last.keys[i] !== k);
    last = { keys, byKey, list };
    revision++;

    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const metrics = {
      /** 引擎内耗时（Worker 里测的，不含传输与贴 DOM） */
      ms: +ms.toFixed(1),
      blocks: keys.length,
      /** 下发 HTML 的块数（真正需要重建 DOM 的块） */
      changed: blocks.length,
      /** 仅行号位移、只发元数据补丁的块数 */
      patched: rangePatches,
      removed: removed.length,
      reused: keys.length - blocks.length,
      /** 差量传输字节 / 全量 HTML 字节 —— 用来证明"差量"不是口号 */
      deltaBytes,
      fullBytes,
      sourceChars: String(source ?? '').length,
      mode: res.metrics?.mode || 'full',
      revision,
    };
    lastMetrics = metrics;
    if (typeof opts.onMetrics === 'function') opts.onMetrics(metrics);

    return {
      revision,
      blocks,
      ranges,
      removed,
      order: orderChanged ? keys : null,
      total: keys.length,
      toc: res.toc || [],
      counters: res.counters || null,
      stats: res.stats,
      errors: res.errors || [],
      mathCount: res.mathCount || 0,
      metrics,
    };
  }

  /**
   * 用一份既有的块视图**预热**引擎的身份表。
   *
   * 场景：首帧为了"打开即有内容"是主线程渲染的，随后交给 Worker。Worker 的缓存
   * 是冷的，第一次渲染必然要重新解析排版（这部分无法避免，但它在 Worker 里，
   * 不阻塞输入）；不过如果它不知道客户端手上已经有哪些块、内容是什么，这次渲染
   * 就会把整篇 HTML **再传一遍**（实测 3.7MB / 一次按键）。seed 之后，Worker 的
   * 第一次渲染与客户端完全对齐：差量为零，只补必要的行号区间。
   *
   * @param {Array<{key:string,html:string,first?:string,start:number,end:number}>} blocks
   */
  function seed(blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return 0;
    const byKey = new Map();
    const list = new Array(blocks.length);
    const keys = new Array(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b || typeof b.key !== 'string' || typeof b.html !== 'string') return 0;
      const entry = { key: b.key, html: b.html, first: b.first, start: b.start, end: b.end };
      byKey.set(entry.key, entry);
      list[i] = entry;
      keys[i] = entry.key;
    }
    last = { keys, byKey, list };
    return keys.length;
  }

  return {
    render,
    reset,
    seed,
    get options() { return opts; },
    setOptions(next) {
      opts = { ...next };
      reset();
    },
    blockCount: () => (last ? last.keys.length : 0),
    metrics: () => lastMetrics,
    /**
     * 引擎侧的**全量**块视图（有序）。生产路径不用它（差量就够），
     * 但自检需要"标准答案"来比对差量应用的结果，见 scripts/verify-preview.mjs。
     */
    view: () => (last ? last.list.map((b) => ({ ...b })) : []),
  };
}

/* ------------------------------------------------------------------------ */
/*  客户端状态：差量 → 有序块数组                                            */
/* ------------------------------------------------------------------------ */

/**
 * 客户端块表的初始状态。每一块带一个**本地 id**（自增整数）：
 * React 的 key 用它而不是用引擎的 key —— 引擎的 key 会因为重复块序号漂移而变化，
 * 直接当 React key 会让"内容没变、只是 id 变了"的块被卸载重建。
 */
export function createPreviewStore() {
  return { byKey: new Map(), order: [], nextId: 1, revision: 0 };
}

/**
 * 应用一次差量，返回**新的有序块数组**。
 *
 * 两条不变量（自检脚本逐条断言）：
 *   ① 内容、行区间都没变的块，返回的是**同一个对象引用** → React.memo 直接跳过
 *   ② 块的 id 尽可能稳定 → React 原地更新该块，而不是卸载重建
 *
 * @param {ReturnType<typeof createPreviewStore>} store
 * @param {object} delta 引擎返回的差量
 * @returns {Array<{id:number,key:string,html:string,first?:string,start:number,end:number}>}
 */
export function applyDelta(store, delta) {
  // ① 消失的块
  for (const key of delta.removed || []) store.byKey.delete(key);

  // ② 只位移了行号的块：换一个对象（新 props → React 更新 data-lines），
  //    但 html 是同一个字符串引用，innerHTML 不会被重写。
  for (const [key, range] of Object.entries(delta.ranges || {})) {
    const entry = store.byKey.get(key);
    if (!entry) continue;
    if (entry.start === range[0] && entry.end === range[1]) continue;
    store.byKey.set(key, { ...entry, start: range[0], end: range[1] });
  }

  // ③ 新增 / HTML 变化的块
  for (const b of delta.blocks || []) {
    const prev = store.byKey.get(b.key);
    store.byKey.set(b.key, {
      id: prev?.id ?? store.nextId++,
      key: b.key,
      html: b.html,
      first: b.first,
      start: b.start,
      end: b.end,
    });
  }

  // ④ 按顺序拼装
  const order = delta.order || store.order;
  store.order = order;
  store.revision = delta.revision ?? store.revision + 1;
  const out = new Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const entry = store.byKey.get(order[i]);
    if (!entry) throw new Error(`差量与本地状态不一致：缺少块 ${order[i]}`);
    out[i] = entry;
  }
  return out;
}

/**
 * 差量自洽断言（自检用，生产路径不调用）：
 * 把差量应用后的客户端视图，与"引擎全量重渲"的结果逐块比对。
 * 这是最容易出错的地方，所以宁可多一份显式的校验代码。
 */
export function verifyDelta(clientBlocks, freshEngineFull) {
  if (clientBlocks.length !== freshEngineFull.length) {
    return { ok: false, reason: `块数不一致：客户端 ${clientBlocks.length} ≠ 引擎 ${freshEngineFull.length}` };
  }
  if (bytes(clientBlocks.map((b) => b.html).join('')) !== bytes(freshEngineFull.map((b) => b.html).join(''))) {
    return { ok: false, reason: 'HTML 总字节数不一致' };
  }
  for (let i = 0; i < clientBlocks.length; i++) {
    if (clientBlocks[i].html !== freshEngineFull[i].html) {
      return { ok: false, reason: `第 ${i} 块内容与引擎不一致（行 ${clientBlocks[i].start}-${clientBlocks[i].end}）` };
    }
    if (clientBlocks[i].start !== freshEngineFull[i].start || clientBlocks[i].end !== freshEngineFull[i].end) {
      return { ok: false, reason: `第 ${i} 块行区间不一致：${clientBlocks[i].start}-${clientBlocks[i].end} vs ${freshEngineFull[i].start}-${freshEngineFull[i].end}` };
    }
  }
  const ids = new Set(clientBlocks.map((b) => b.id));
  if (ids.size !== clientBlocks.length) return { ok: false, reason: '本地 id 不唯一' };
  return { ok: true };
}
