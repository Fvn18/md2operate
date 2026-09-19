/**
 * shared/incremental.mjs — 块级增量渲染（预览 1.3 秒卡顿的正面解法）。
 *
 * 实测归因（scripts/bench.mjs + 逐层关闭实验，10 万字符）：
 *   · 编辑器本身 40ms —— 不是瓶颈
 *   · markdown-it + KaTeX 全量渲染 170ms
 *   · 剩下的 ~1150ms 是「整块 innerHTML 替换 + 数万 KaTeX 节点重新 layout/paint」
 *
 * 因此这里同时解决两件事：
 *   1. **解析渲染层面**：只重渲发生变化的块，其余块直接复用缓存的 HTML。
 *   2. **DOM 层面**：把结果按块返回（每块一个稳定 key），交给 React 做按键复用，
 *      未变更的块一个 DOM 节点都不碰。
 *
 * 分块策略的关键取舍：**不按空行切文本，而是按 markdown-it 的 token 流切**。
 * 因为按空行切会把松列表（loose list）拆成两半，渲染时 HTML 标签就不平衡了。
 * 按 token 的 `nesting` 做深度跟踪分组，可以保证每个分组自身结构完整。
 * 全量 parse 仍然只做一次——parse 很便宜，而且引用式链接、脚注、定理编号
 * 这些**文档级语义**必须看到全文才对。
 */

import { createRenderer } from './markdown.mjs';

/* ------------------------------------------------------------ 字符串哈希 --- */

/** FNV-1a 32 位：足够做缓存键，比 crypto.subtle 快且是同步的。 */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/* ------------------------------------------------------------ token 分组 --- */

/**
 * 把顶层 token 流按"结构完整的块"分组。
 * @returns {Array<{tokens:Array, start:number, end:number}>} start/end 为行号（0 基、左闭右开）
 */
export function groupTokens(tokens) {
  const groups = [];
  let cur = [];
  let depth = 0;
  let start = null;
  let end = null;

  const flush = () => {
    if (!cur.length) return;
    groups.push({ tokens: cur, start: start ?? 0, end: end ?? (start ?? 0) });
    cur = [];
    start = null;
    end = null;
  };

  for (const t of tokens) {
    const m = t.map;
    // 深度回到 0 之后出现行号断层 → 上一个块结束
    if (m && depth === 0 && end !== null && m[0] > end) flush();
    if (m) {
      if (start === null) start = m[0];
      end = m[1];
    }
    cur.push(t);
    depth += t.nesting || 0;
    if (depth < 0) depth = 0; // 容错：不因畸形 token 流而错位
  }
  flush();
  return groups;
}

/* ---------------------------------------------------- 公式错误的行号定位 --- */

/**
 * 取块 HTML 的第一个顶层标签名。
 * 用途：预览与导出都靠 `data-first` 给包装元素定块间距——因为 containment 之后
 * 外边距不再折叠，块间距必须显式给出，而"下一块是什么"决定了该给多大间距。
 */
function firstTagOf(html) {
  const m = /^\s*<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html);
  return m ? m[1].toLowerCase() : 'div';
}

/**
 * 把块数组拼成导出用的 HTML：与预览**同一套包装标记**，因此排版语义一致。
 * 导出页面会带 data-static="1"，从而关闭 content-visibility（必须完整布局）。
 */
export function blocksToHtml(blocks) {
  return blocks
    .map((b) => `<div class="mdp-block" data-first="${b.first || firstTagOf(b.html)}">${b.html}</div>`)
    .join('\n');
}

/** 在块文本里找出某段 TeX 所在的行（行内公式没有 token.map，只能反查）。 */
function locateLine(blockText, tex, blockStartLine) {
  if (!tex) return null;
  const probe = String(tex).replace(/[\s\u2026]+$/, '').slice(0, 24);
  if (!probe) return null;
  const lines = blockText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(probe)) return blockStartLine + i + 1; // 转 1 基
  }
  return null;
}

/* ------------------------------------------------------- 增量渲染器 --- */

/**
 * @param {object} [options] 与 createRenderer 相同，另加：
 *        cacheSize — 缓存块上限（默认 600）
 *        onMetrics — (m:{mode,ms,blocks,reused,rendered}) => void，供基准与调优
 */
export function createIncrementalRenderer(options = {}) {
  const cacheSize = options.cacheSize ?? 600;
  const collector = [];
  const md = createRenderer({ ...options, collector });
  const env = {};
  const cache = new Map(); // key -> html

  // 选项指纹：任何影响输出的开关变化都要让缓存失效
  const optionsKey = hashStr(JSON.stringify({
    breaks: !!options.breaks,
    typographer: !!options.typographer,
    linkify: options.linkify !== false,
    numbering: options.numbering || false,
    footnotes: options.footnotes !== false,
    deflist: options.deflist !== false,
    taskLists: options.taskLists !== false,
    anchors: options.anchors !== false,
    tocEmbed: !!options.tocEmbed,
    lineNumbers: !!options.lineNumbers,
  }));

  function remember(key, html, blockErrors) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, html);
    errorByKey.set(key, blockErrors || []);
    if (cache.size > cacheSize) {
      // 简单 LRU：Map 的插入序即访问序；缓存淘汰时错误记录一起淘汰
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
      errorByKey.delete(oldest);
    }
  }

  function reset() {
    cache.clear();
    errorByKey.clear();
    lastSnapshot = null;
  }

  let errorByKey = new Map();
  let lastMetrics = { mode: 'idle', ms: 0, blocks: 0, reused: 0, rendered: 0 };
  /** 上一轮各块的 (行区间, 文本, 缓存键)，用于跳过未变更块的哈希 */
  let lastSnapshot = null;

  /**
   * 渲染（增量）。
   * @param {string} source
   * @param {{force?:boolean}} [opts]
   * @returns {{blocks:Array<{key:string,html:string,start:number,end:number}>,
   *            toc:Array,stats:object,errors:Array,mathCount:number,
   *            metrics:{mode:string,ms:number,blocks:number,reused:number,rendered:number}}}
   */
  function render(source, opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const text = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    const lines = text.split('\n');

    // 一次全量 parse：引用链接、脚注、定理编号等文档级语义都在这一步确定
    env.toc = [];
    env.mdpCounters = null;
    env.mdpWarnings = collector;
    const tokens = md.parse(text, env);

    const groups = groupTokens(tokens);
    const blocks = [];
    const snapshot = [];
    const errors = [];
    const seen = new Map(); // 内容键 → 本次渲染中第几次出现
    let reused = 0;
    let rendered = 0;

    // 上一次的块快照：用于**跳过未变更块的哈希计算**。
    // 每敲一个字符都要为全部 1151 个块算 FNV-1a（O(全文) 的字符循环），
    // 这在 10 万字符下占掉相当一部分 script 时间；而实际每次只有 1~2 个块变了。
    // 位置对上且文本完全相同时直接复用上一轮的键——字符串比较比逐字符哈希快得多，
    // 而且是精确比较（没有哈希碰撞导致陈旧 HTML 的风险）。
    const prevSnap = lastSnapshot;

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const blockText = lines.slice(g.start, g.end).join('\n');

      const prevBlock = prevSnap ? prevSnap[gi] : null;
      const reuseKey = prevBlock
        && prevBlock.startLine === g.start + 1
        && prevBlock.endLine === g.end
        && prevBlock.text === blockText
        ? prevBlock
        : null;

      // **两个键，解决两件事，绝不能混用**：
      //   cacheKey —— 按内容，让重复出现的相同块共享同一份渲染结果（缓存命中）
      //   reactKey —— 必须**在本次渲染内唯一**。若直接用内容哈希，文档里重复的
      //               样板块（同样的列表项/代码块/表格）会产生重复 key，React 的
      //               协调会错乱并不断堆积 DOM 节点（实测 10 万→17 万节点后卡死）。
      const cacheKey = reuseKey ? reuseKey.cacheKey : `${optionsKey}:${hashStr(blockText)}`;
      const nth = (seen.get(cacheKey) || 0) + 1;
      seen.set(cacheKey, nth);
      const reactKey = nth === 1 ? cacheKey : `${cacheKey}#${nth}`;

      const cached = cache.get(cacheKey);
      let html;

      if (cached !== undefined && !opts.force) {
        // 命中缓存：HTML 与"本块的公式错误"一起复用，
        // 否则只改别处时错误标注会闪没。
        html = cached;
        const prev = errorByKey.get(cacheKey);
        if (prev) errors.push(...prev);
        reused++;
        // 触碰一次，维持 LRU 顺序
        cache.delete(cacheKey); cache.set(cacheKey, cached);
      } else {
        collector.length = 0;
        try {
          html = md.renderer.render(g.tokens, md.options, env);
        } catch (err) {
          // 单块渲染失败绝不能拖垮整篇
          html = `<div class="mdp-callout mdp-callout-danger"><div class="mdp-callout-head">`
            + `<span class="mdp-callout-icon">✖</span><span class="mdp-callout-title">渲染失败</span></div>`
            + `<div class="mdp-callout-body"><pre>${String(err && err.message ? err.message : err)}</pre></div></div>`;
          errors.push({ kind: 'block', message: String(err && err.message ? err.message : err), line: g.start + 1 });
        }
        // 公式错误归位到全局行号：块级公式有 token.map，行内公式只能反查
        const blockErrors = collector.map((e) => ({
          ...e,
          line: e.line ?? locateLine(blockText, e.tex, g.start),
          blockStart: g.start + 1,
        }));
        errors.push(...blockErrors);
        remember(cacheKey, html, blockErrors);
        rendered++;
      }
      blocks.push({ key: reactKey, cacheKey, html, first: firstTagOf(html), start: g.start + 1, end: g.end });
      snapshot[gi] = { startLine: g.start + 1, endLine: g.end, text: blockText, cacheKey };
    }
    lastSnapshot = snapshot;

    // 自检：key 必须唯一。这条断言值千金——曾经因为内容哈希直接当 key，
    // 重复样板块让 React 协调错乱、DOM 无限堆积，页面直接冻死。
    if (options.debugKeys) {
      const keys = new Set(blocks.map((b) => b.key));
      if (keys.size !== blocks.length) {
        throw new Error(`块 key 不唯一：${blocks.length} 块 / ${keys.size} 个 key`);
      }
    }

    const stats = computeStats(text);
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const result = {
      blocks,
      toc: env.toc || [],
      counters: env.mdpCounters || null,
      stats,
      errors,
      mathCount: (blocks.reduce((n, b) => n + (b.html.match(/<span class="katex"/g) || []).length, 0)),
      metrics: {
        mode: reused > 0 && rendered < blocks.length ? 'incremental' : 'full',
        ms: +ms.toFixed(1),
        blocks: blocks.length,
        reused,
        rendered,
      },
    };
    if (typeof options.onMetrics === 'function') options.onMetrics(result.metrics);
    lastMetrics = result.metrics;
    return result;
  }

  return {
    render,
    reset,
    metrics: () => lastMetrics,
    cacheSize: () => cache.size,
    /** 把每块的错误按行号暴露给编辑器做行内标注 */
    errorsByLine: (res) => {
      const map = new Map();
      for (const e of res.errors || []) {
        if (e.line == null) continue;
        if (!map.has(e.line)) map.set(e.line, []);
        map.get(e.line).push(e);
      }
      return map;
    },
  };
}

/* ------------------------------------------------------------------ 统计 --- */

function computeStats(src) {
  const chars = src.length;
  let cjk = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  const latinWords = (src.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ')
    .match(/[A-Za-z0-9][A-Za-z0-9'’._-]*/g) || []).length;
  return {
    chars,
    cjk,
    words: cjk + latinWords,
    lines: src.split('\n').length,
    readingMinutes: Math.max(1, Math.round(Math.max(cjk / 400, latinWords / 220))),
  };
}
