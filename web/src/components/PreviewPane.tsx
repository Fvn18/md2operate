/**
 * web/src/components/PreviewPane.tsx — 实时预览（Worker 渲染 + 块级差量 + 视口虚拟化）。
 *
 * 四层职责，界线必须清楚：
 *   · **算**：解析 + KaTeX 排版在 Web Worker（web/src/worker/render.worker.ts），
 *     主线程一次都不参与。见 shared/preview-engine.mjs 的差量协议。
 *   · **贴**：只把"变化过的块"交给 React。未变更的块对象引用不变，React.memo
 *     比较是 O(1)，因此一个 DOM 节点都不碰（这是 60FPS 的关键）。
 *   · **量**：把挂载块的 offsetHeight 记进高度表（key → px），据此算出**每块的
 *     像素偏移**——这是虚拟化与滚动同步共用的同一张表（shared/scroll-map.mjs）。
 *   · **对**：滚动同步走"行 → 块 → 块内插值"，双向（编辑器 ↔ 预览）都用同一套
 *     映射；比例同步只是保留的可选项。
 *
 * 虚拟化的取舍（写在明处）：
 *   · 只挂载视口 ± 900px 的块。10 万字符文档 1150 块 / 10 万节点 → 稳定在千级
 *     节点，打字延迟与文档长度解耦（SLO：DOM 节点 ≤1500）。
 *   · 代价：浏览器自带的页内查找找不到未挂载的块。状态栏有开关（`ui.virtualize`），
 *     需要全文查找时可临时关闭；关闭后回退到 content-visibility 懒布局。
 *   · 未挂载块的高度用"已测块的平均高度"估算，实测后会做**滚动锚定**修正
 *     （anchorAt / restoreAnchor），所以看不到内容跳动。
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../lib/store';
import { api } from '../lib/api';
import { useContent } from '../lib/content';
import { publishPreview, publishStats } from '../lib/preview-state';
import {
  usePreviewSnapshot, usePreviewEngine, previewEngineInfo, type PreviewBlock,
} from '../lib/preview-client';
import { documentCss, PAPER_SIZES, mmToPx } from '@shared/theme.mjs';
import {
  buildScrollIndex, buildLayout, lineToY, yToLine, visibleRange, anchorAt, restoreAnchor, measureCoverage,
} from '@shared/scroll-map.mjs';

/* 这些类型来自 JSDoc（checkJs 关闭时 TS 看不到 typedef），用 ReturnType 取即可。 */
type ScrollIndex = ReturnType<typeof buildScrollIndex>;
type Layout = ReturnType<typeof buildLayout>;
import { Icon } from './Icons';

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export interface PreviewPaneHandle {
  /** 把「第 line 行」所在的位置滚到容器顶部（锚定式同步 + 块内插值） */
  scrollToLine: (line: number, margin?: number) => boolean;
  /** 只在目标行不在可视区时才滚动（光标跟随用，避免抖动） */
  revealLine: (line: number) => boolean;
  /** 当前渲染出的块数（引擎侧，含未挂载的） */
  blockCount: () => number;
  /** 当前真正挂载在 DOM 里的块数（虚拟化诊断用） */
  mountedCount: () => number;
  /** 视口顶部对应的源码行与行内比例（预览 → 编辑器方向的同步用） */
  topLine: () => { line: number; frac: number } | null;
  /** 虚拟化是否生效 */
  virtual: () => boolean;
}

/** 视口上下各多渲染的高度：够滑一小段不出白，又不会把 DOM 撑大 */
const OVERSCAN_PX = 900;
/** 超过这个块数才值得虚拟化（短文档直接全渲染，行为与老版本一致） */
const VIRTUAL_MIN_BLOCKS = 60;

/**
 * 单块渲染结果。memo 的比较器只看 html/lines 字符串——而差量协议保证未变更的块
 * **连对象都不重建**，所以比较是 O(1)，未变更的块直接跳过。
 *
 * `data-first` 供 CSS 决定块间距（containment 之后外边距不再折叠，间距必须显式
 * 给出，而"下一块是什么标签"决定该给多大间距）。
 * `data-lines` 是该块对应的源码行区间：滚动同步与自检断言都依赖它。
 * `data-key` 给高度表做索引（虚拟化用）。
 */
const Block = React.memo(
  function Block({ html, first, lines, vkey }: { html: string; first?: string; lines?: string; vkey: string }) {
    return (
      <div
        className="mdp-block"
        data-first={first}
        data-lines={lines}
        data-key={vkey}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  },
  (a, b) => a.html === b.html && a.first === b.first && a.lines === b.lines && a.vkey === b.vkey,
);

export const PreviewPane = forwardRef<PreviewPaneHandle, Props>(function PreviewPane({ scrollRef }, ref) {
  const { state, patchUi } = useStudio();
  const content = useContent();
  const snapshot = usePreviewSnapshot();
  const innerRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<PreviewBlock[]>([]);
  blocksRef.current = snapshot.blocks;

  /* ---- 布局表：key → 实测高度，再折算成每块的像素偏移 -------------------
     这是虚拟化与滚动同步共用的唯一事实来源。offsetHeight 不含外边距，所以
     CSS 里块间距用 padding-top 而不是 margin（见 shared/theme.mjs），
     这样 sum(块高) === 内容总高，上下占位块才能给准。 */
  const heightsRef = useRef(new Map<string, number>());
  /* 未挂载块的高度估算：按"块的首个标签"分档统计均值（段落 ≈30px、代码块 ≈200px…）。
     只用一个全局均值会出事：这份 10 万字符的样本文档里既有 20px 的段落也有 4000px
     的长代码块，均值被拉大后，虚拟化会以为一屏只放得下一两块，实际只挂 4 块，
     滚动时白屏。分档 + 兜底默认值就稳了。 */
  const estTotalRef = useRef(56);
  const estByTagRef = useRef(new Map<string, number>());
  const indexRef = useRef<ScrollIndex | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const rangeRef = useRef({ first: 0, last: 0 });
  const [range, setRange] = useState({ first: 0, last: 0 });
  /* 上下占位块用命令式更新（直接写 style.height），不走 React 渲染。
     原因：占位高度依赖高度表，而高度表又依赖"挂载块的实测高度"——如果让占位
     高度走 state，就会形成 布局→测量→setState→再布局 的级联，一帧里能叠好几轮，
     实测出现过 190ms 的长任务。命令式写高度把这个环断开了。 */
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const measuredCount = useRef(0);

  const scrollToken = useRef(0);
  const lastRevealed = useRef<number | null>(null);
  const revealPending = useRef(false);
  const [hljsCss, setHljsCss] = React.useState('');

  const docTheme = state.settings.doc.theme;
  const codeTheme = state.settings.doc.codeTheme
    || (['ink', 'nord'].includes(docTheme) ? 'github-dark' : 'github');

  /* ---- 渲染：内容与 Markdown 选项交给预览引擎（Worker） ------------------
     首帧由引擎在主线程同步渲一次（打开即有内容），之后一律走 Worker。 */
  const markdownOptions = state.settings.markdown;
  usePreviewEngine(content, markdownOptions as unknown as Record<string, unknown>);

  const virtualWanted = state.ui.virtualize !== false && snapshot.blocks.length >= VIRTUAL_MIN_BLOCKS;

  /** 用当前高度表重建索引 + 偏移表（O(块数)，1150 块约 0.05ms）。 */
  const rebuild = useCallback(() => {
    const bs = blocksRef.current;
    const heights = new Float64Array(bs.length);
    const fallback = estTotalRef.current;
    for (let i = 0; i < bs.length; i++) {
      const h = heightsRef.current.get(bs[i].key);
      heights[i] = h && h > 0 ? h : (estByTagRef.current.get(bs[i].first || '') ?? fallback);
    }
    indexRef.current = buildScrollIndex(bs);
    layoutRef.current = buildLayout(heights, bs.length);
  }, []);

  /** 把偏移表写进上下占位块（命令式，不触发 React 渲染）。 */
  const applyPads = useCallback(() => {
    const layout = layoutRef.current;
    const top = topSpacerRef.current;
    const bottom = bottomSpacerRef.current;
    if (!layout) return;
    const r = rangeRef.current;
    if (top) top.style.height = `${Math.max(0, layout.offsets[r.first] ?? 0)}px`;
    if (bottom) {
      const end = Math.min(layout.heights.length, (r.last ?? -1) + 1);
      bottom.style.height = `${Math.max(0, layout.total - (layout.offsets[end] ?? layout.total))}px`;
    }
  }, []);

  /* ---- 测量：把当前挂载块的真实高度写回高度表 ---------------------------
     只读挂载中的几十个块，一次布局即可；高度有变化时重建偏移表，并按"滚动锚定"
     把视口顶部的视觉位置修正回去（否则视口上方刚测准的块会把内容顶跑）。 */
  const measure = useCallback(({ anchor = true } = {}) => {
    const host = innerRef.current;
    const container = scrollRef.current;
    if (!host) return false;
    const prevLayout = layoutRef.current;
    const hold = anchor && prevLayout && container
      ? anchorAt(prevLayout, container.scrollTop)
      : null;
    let changed = false;
    let sum = 0;
    let n = 0;
    const tagSum = new Map<string, { sum: number; n: number }>();
    const els = host.querySelectorAll<HTMLElement>('.mdp-block');
    for (const el of els) {
      const key = el.dataset.key;
      if (!key) continue;
      const h = el.offsetHeight;
      sum += h; n++;
      const tag = blocksRef.current.find((b) => b.key === key)?.first || '';
      const acc = tagSum.get(tag) || { sum: 0, n: 0 };
      acc.sum += h; acc.n++;
      tagSum.set(tag, acc);
      const prev = heightsRef.current.get(key);
      if (prev === undefined || Math.abs(prev - h) > 0.5) { heightsRef.current.set(key, h); changed = true; }
    }
    measuredCount.current = heightsRef.current.size;
    if (n) {
      estTotalRef.current = sum / n;
      for (const [tag, acc] of tagSum) {
        const prev = estByTagRef.current.get(tag);
        // 指数滑动平均：单次采样不至于把某档的估值带偏
        estByTagRef.current.set(tag, prev === undefined ? acc.sum / acc.n : prev * 0.6 + (acc.sum / acc.n) * 0.4);
      }
    }
    if (!changed) return false;
    rebuild();
    applyPads();
    if (hold && container && layoutRef.current) {
      const next = restoreAnchor(layoutRef.current, hold);
      if (Math.abs(next - container.scrollTop) > 0.5) container.scrollTop = next;
    }
    return true;
  }, [rebuild, scrollRef, applyPads]);

  /* ---- 缩放：按导出宽度固定 + 自动等比适配 -------------------------------
     预览的价值在于"所见即所得"：它必须用**导出的真实宽度**排版，否则公式换行、
     标题折行都和产物不一样。面板窄的时候（打开导出面板后常只剩 300~400px）不能
     靠收窄宽度去适配——那是让预览重排一遍，用户看到的就是另一个版面。

     做法：纸张恒定 paperWidth，容器放不下时用 transform 整体等比缩小。量测必须
     在**外层 .preview-scroll** 上做，不能量被缩放的节点自己（那会自指）。

     这段声明必须排在 syncRange / useImperativeHandle 之前：滚动数学依赖 scale
     （见 viewportLayoutH），把 scale 放到组件后半段会让那些回调拿到未初始化的值。 */
  const [availW, setAvailW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const read = () => {
      const cs = getComputedStyle(el);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      setAvailW(Math.max(0, el.clientWidth - pad));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);

  /* 预览纸张宽度 = 导出时的实际宽度 */
  const paperWidth = useMemo(() => {
    const d = state.settings.doc;
    if (state.settings.png.mode === 'card') {
      return Math.round(d.contentWidth + d.cardPadding * 2 + (d.cardBorder ? 2 : 0));
    }
    const paper = (PAPER_SIZES as Record<string, { w: number; h: number }>)[d.paper] || PAPER_SIZES.A4;
    return Math.round(mmToPx(paper.w));
  }, [state.settings.doc, state.settings.png.mode]);

  const fitScale = availW > 0 ? Math.min(1, availW / paperWidth) : 1;
  const zoom = state.ui.previewZoom;
  const scale = zoom === 'z-fit' ? fitScale
    : zoom === 'z-100' ? 1
      : zoom === 'z-75' ? 0.75
        : 0.5;

  /* 滚动数学全在「布局空间」里做：块高表存的是 offsetHeight，.preview-paper 被
     transform 缩放后 getBoundingClientRect 给的是**视觉**像素，两者差一个 scale。
     滚动容器自身没被缩放，所以它的 clientHeight 是视觉像素，而 scrollTop 与高度表
     是布局像素 —— "容器能显示多少布局像素" = clientHeight / scale。
     漏掉这一步的表现：缩到 37% 时可见区间被算大 2.7 倍，虚拟化会挂错块，
     滚过去一片空白。
     用 ref 而非把 scale 塞进依赖：滚动是热路径，不想因缩放变化重挂监听。 */
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const viewportLayoutH = useCallback(() => {
    const c = scrollRef.current;
    if (!c) return 0;
    return c.clientHeight / (scaleRef.current || 1);
  }, [scrollRef]);

  /* ---- 坐标空间：这是本次改动最容易踩的坑 -------------------------------
     高度表、偏移表、data-lines 全部是**布局像素**（来自 offsetHeight，transform
     不影响 offset*）。但 `scrollTop` 是**视觉像素**：容器没被缩放，而它滚动的是
     被缩放的纸张，所以滚 1 个视觉像素 = 走 1/scale 个布局像素。

     scale === 1 时两者重合，一切正常；一旦缩放就会错位：
       · 想把布局位置 y 滚到视口顶部，必须写 scrollTop = y * scale；
       · 想从布局位置 y 反推它在哪，必须比较 (scrollTop / scale)。
     漏掉换算的后果是同步整体偏移 —— 缩到 43% 时"跳到第 300 行"会落到第 1000 行
     附近，而且虚拟化会挂载错误区间，滚过去一片空白。

     所以规则是：**只在读写 scrollTop 的边界上换算**，中间计算一律走布局空间。 */
  const toLayout = (scrollTopVisual: number) => scrollTopVisual / (scaleRef.current || 1);
  const toScroll = (yLayout: number) => yLayout * (scaleRef.current || 1);

  /** 视口 → 该挂载哪些块（滚动热路径，每帧最多一次）。 */
  const syncRange = useCallback((topLayout?: number) => {
    const container = scrollRef.current;
    const layout = layoutRef.current;
    if (!container || !layout) return;
    const t = topLayout ?? toLayout(container.scrollTop);
    const h = viewportLayoutH() || 800;
    const next = layout.heights.length === 0 ? { first: 0, last: -1 } : visibleRange(layout, t, h, OVERSCAN_PX);
    if (next.first !== rangeRef.current.first || next.last !== rangeRef.current.last) {
      rangeRef.current = next;
      setRange(next);
      applyPads();
    }
  }, [scrollRef, applyPads, viewportLayoutH]);

  /* 内容变了（含切换文档）：重置高度表里已消失的键，然后重建 */
  useEffect(() => {
    const alive = new Set(snapshot.blocks.map((b) => b.key));
    if (heightsRef.current.size > alive.size * 2) {
      for (const k of [...heightsRef.current.keys()]) if (!alive.has(k)) heightsRef.current.delete(k);
    }
    rebuild();
    syncRange();
  }, [snapshot.revision, rebuild, syncRange, snapshot.blocks]);

  /* ---- 只渲染视口附近的块（虚拟化） -------------------------------------
     没开虚拟化时退化成原来的行为：所有块都在 DOM 里，靠 content-visibility
     让视口外的块跳过布局与绘制。 */
  const total = snapshot.blocks.length;
  const first = virtualWanted ? Math.max(0, Math.min(range.first, Math.max(0, total - 1))) : 0;
  const last = virtualWanted ? Math.max(first, Math.min(range.last, total - 1)) : Math.max(0, total - 1);
  const layout = layoutRef.current;
  const topPad = virtualWanted && layout ? layout.offsets[first] ?? 0 : 0;
  const bottomPad = virtualWanted && layout
    ? Math.max(0, layout.total - (layout.offsets[last + 1] ?? layout.total))
    : 0;
  // 虚拟化关闭时不渲染占位块（高度为 0，占位元素本身也省掉）
  const useSpacers = virtualWanted && total >= VIRTUAL_MIN_BLOCKS;

  /* 挂载/滚动/尺寸变化后：先摆好占位高度，再测本轮新挂载的块 */
  useLayoutEffect(() => {
    applyPads();
    measure({ anchor: false });
    syncRange();
  }, [snapshot.revision, range.first, range.last, measure, syncRange, applyPads]);

  /* 自检钩子：虚拟化的现场数据（节点数、挂载块数、已测比例） */
  useEffect(() => {
    const host = innerRef.current;
    if (host) {
      window.__mdpVirtual = {
        virtual: virtualWanted,
        total: blocksRef.current.length,
        mounted: host.querySelectorAll('.mdp-block').length,
        nodes: host.querySelectorAll('*').length,
        first: range.first,
        last: range.last,
        firstKey: blocksRef.current[range.first]?.key ?? null,
        lastKey: blocksRef.current[range.last]?.key ?? null,
        firstLines: blocksRef.current[range.first] ? `${blocksRef.current[range.first].start}-${blocksRef.current[range.first].end}` : null,
        lastLines: blocksRef.current[range.last] ? `${blocksRef.current[range.last].start}-${blocksRef.current[range.last].end}` : null,
        topPad: Math.round(topPad),
        bottomPad: Math.round(bottomPad),
        layoutTotal: Math.round(layoutRef.current?.total ?? 0),
        measuredKeys: measuredCount.current,
        coverageRatio: Number((blocksRef.current.length ? measuredCount.current / blocksRef.current.length : 1).toFixed(3)),
      };
    }
  });

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; syncRange(); });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => { syncRange(); });
    ro.observe(container);
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scrollRef, syncRange]);

  /* 代码高亮主题 CSS 由后台从 highlight.js 自身样式表读取，保证与导出一致 */
  useEffect(() => {
    let alive = true;
    api.hljsCss(codeTheme)
      .then((css) => { if (alive) setHljsCss(css); })
      .catch(() => { if (alive) setHljsCss(''); });
    return () => { alive = false; };
  }, [codeTheme]);

  /* ---- 定位原语：全部走偏移表，不再逐帧读 getBoundingClientRect ---------
     旧实现每次滚动都要读 DOM 几何（强制同步布局），10 万节点上代价很高；
     现在"行 → 像素"是一次二分查找（见 shared/scroll-map.mjs）。 */
  const dbg = (win: Window & typeof globalThis) => (win as unknown as { __mdpBench?: Record<string, unknown> }).__mdpBench;

  const scrollToLine = useCallback((line: number, margin = 8): boolean => {
    const container = scrollRef.current;
    const index = indexRef.current;
    if (!container || !index || !layoutRef.current) return false;
    const y = lineToY(index, layoutRef.current, line);
    if (y == null) return false;

    const token = ++scrollToken.current;
    const bench = dbg(window);
    if (bench) {
      bench.syncCalls = ((bench.syncCalls as number) || 0) + 1;
      bench.syncLastLine = line;
      bench.syncBlockCount = index.n;
    }

    const target = Math.max(0, y - margin);
    container.scrollTop = toScroll(target);   // 布局 → 视觉
    syncRange(target);

    /* 收敛循环：新挂载的块高度可能与估算不同，量准之后按锚点修正。
       判据是"目标像素位置连续两帧不动"，最多 10 帧——这条路径只在跳转时跑，
       不在打字路径上。 */
    let frames = 0;
    let stable = 0;
    let lastDelta = Number.NaN;
    const step = () => {
      if (token !== scrollToken.current) return;
      frames++;
      measure();
      const lay = layoutRef.current;
      const idx = indexRef.current;
      if (!lay || !idx) return;
      const want = lineToY(idx, lay, line);
      // 两边都要换算到同一个空间再比较：want 是布局像素，scrollTop 是视觉像素
      const delta = want == null ? 0 : want - margin - toLayout(container.scrollTop);
      if (Math.abs(delta) > 0.5) container.scrollTop = toScroll(Math.max(0, toLayout(container.scrollTop) + delta));
      syncRange();
      stable = Math.abs(delta - lastDelta) < 0.5 ? stable + 1 : 0;
      lastDelta = delta;
      if (bench) {
        bench.syncLanded = line;
        bench.syncDelta = +delta.toFixed(2);
        bench.syncFrames = frames;
        bench.syncTopLines = topLines();
      }
      if ((stable >= 2 && Math.abs(delta) <= 1) || frames >= 10) return;
      requestAnimationFrame(step);
    };
    step();
    return true;
  }, [scrollRef, measure, syncRange]);

  /** 容器顶部当前显示的是哪一块（自检与预览→编辑器都靠它）。 */
  const topLines = useCallback((): string | null => {
    const container = scrollRef.current;
    const index = indexRef.current;
    const layout = layoutRef.current;
    if (!container || !index || !layout) return null;
    const hit = yToLine(index, layout, toLayout(container.scrollTop) + 2);
    if (!hit) return null;
    return `${index.starts[hit.i]}-${index.ends[hit.i]}`;
  }, [scrollRef]);

  useImperativeHandle(ref, () => ({
    scrollToLine,
    revealLine: (line) => {
      const container = scrollRef.current;
      const index = indexRef.current;
      const layout = layoutRef.current;
      if (!container || !index || !layout) return false;
      // 热路径保护：光标行每次按键都会变，这里只做纯算术判断，不碰 DOM 几何
      if (lastRevealed.current !== null && Math.abs(line - lastRevealed.current) <= 1) return true;
      lastRevealed.current = line;
      const y = lineToY(index, layout, line);
      if (y == null) return false;
      const top = y - toLayout(container.scrollTop);          // 同一空间（布局）比较
      if (top >= 0 && top <= viewportLayoutH()) return true;   // 已可见，不动
      if (revealPending.current) return true;
      revealPending.current = true;
      requestAnimationFrame(() => {
        revealPending.current = false;
        const c = scrollRef.current;
        const l = layoutRef.current;
        const i = indexRef.current;
        if (!c || !l || !i) return;
        const at = lineToY(i, l, lastRevealed.current ?? line);
        if (at == null) return;
        c.scrollTop = toScroll(Math.max(0, at - viewportLayoutH() * 0.35));
        syncRange();
      });
      return true;
    },
    blockCount: () => blocksRef.current.length,
    mountedCount: () => innerRef.current?.querySelectorAll('.mdp-block').length ?? 0,
    topLine: () => {
      const container = scrollRef.current;
      const index = indexRef.current;
      const layout = layoutRef.current;
      if (!container || !index || !layout) return null;
      const hit = yToLine(index, layout, toLayout(container.scrollTop) + 2);
      return hit ? { line: hit.line, frac: hit.frac } : null;
    },
    virtual: () => virtualWanted,
  }), [scrollRef, scrollToLine, syncRange, virtualWanted]);

  /* ---- 目录与错误：结构性数据，立即发布（内部做相等比较，不会误报） ---- */
  useEffect(() => {
    publishPreview({ toc: snapshot.toc, errors: snapshot.errors });
  }, [snapshot]);

  /* ---- 统计与增量指标：高频数据，250ms 节流，避免状态栏带着整棵树抖 ---- */
  const pending = useRef<{ stats: typeof snapshot.stats; metrics: typeof snapshot.metrics } | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    pending.current = { stats: snapshot.stats, metrics: snapshot.metrics };
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const p = pending.current;
      if (!p) return;
      // 引擎指标 → 总线指标：字段名在这一处对齐，避免两套命名在组件间乱窜
      publishStats(p.stats, {
        mode: p.metrics.mode,
        ms: p.metrics.ms,
        blocks: p.metrics.blocks,
        reused: p.metrics.reused,
        rendered: p.metrics.changed,
        latencyMs: p.metrics.latencyMs,
        deltaBytes: p.metrics.deltaBytes,
        fullBytes: p.metrics.fullBytes,
        engine: p.metrics.engine,
        coalesced: p.metrics.coalesced,
      });
    }, 250);
  }, [snapshot]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  /* 文档样式：与导出共用同一函数，只是这里把它注入到预览容器里 */
  const css = useMemo(
    () => documentCss({ ...state.settings.doc, card: false, transparent: false, margin: 0 }),
    [state.settings.doc],
  );

  /* 缩放后的真实高度：transform 不影响布局，只能实测 paper 的高度再乘缩放 */
  const paperRef = useRef<HTMLDivElement>(null);
  const [paperHeight, setPaperHeight] = useState(0);
  useLayoutEffect(() => {
    const el = paperRef.current;
    if (!el) return undefined;
    const read = () => setPaperHeight(el.offsetHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [snapshot.revision, paperWidth, css]);

  const scaledH = Math.max(0, Math.round(paperHeight * scale));

  const zoomPct = Math.round(scale * 100);
  const nextZoom = () => {
    const order = ['z-fit', 'z-100', 'z-75', 'z-50'] as const;
    return order[(order.indexOf(zoom) + 1) % order.length];
  };

  /* 预览内的锚点跳转不应改变地址栏，也不该把整页滚动。
     虚拟化下目标块可能没挂载，所以先把它换算成源码行再走 scrollToLine。 */
  const onPaperClick = (ev: React.MouseEvent) => {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      ev.preventDefault();
      const id = href.slice(1);
      const mounted = innerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
      if (mounted) { mounted.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const host = snapshot.blocks.find((b) => b.html.includes(`id="${id}"`));
      if (host) scrollToLine(host.start, 8);
      return;
    }
    if (/^https?:/.test(href)) return;
    ev.preventDefault();
  };

  /* 公式错误里的「AI 修复」：事件委托，交给 AiToolbar 处理 */
  const onPaperClickCapture = (ev: React.MouseEvent) => {
    const btn = (ev.target as HTMLElement).closest('[data-mdp-fix]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    window.dispatchEvent(new CustomEvent('mdp:ai', {
      detail: {
        kind: 'fix',
        tex: btn.getAttribute('data-tex') || '',
        error: btn.getAttribute('data-err') || '',
      },
    }));
  };

  /* 代码块「复制」按钮：事件委托，不给每个块挂 handler */
  const onPaperMouseDown = (ev: React.MouseEvent) => {
    const btn = (ev.target as HTMLElement).closest('[data-mdp-copy]');
    if (btn) {
      const figure = btn.closest('.mdp-code');
      const code = figure?.querySelector('pre code')?.textContent ?? '';
      navigator.clipboard?.writeText(code);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    }
  };

  const errorCount = snapshot.errors.length;
  const { metrics } = snapshot;
  const info = previewEngineInfo();
  const deltaPct = metrics.fullBytes > 0
    ? Math.round((metrics.deltaBytes / metrics.fullBytes) * 1000) / 10
    : 0;

  /* 滚动同步模式：锚定 / 比例 / 关闭。从快捷键挪到界面上了——
     它是个"设一次就不动"的开关，占用热键不划算，而状态可视化更值钱。 */
  const cycleSync = () => {
    const order = ['anchor', 'ratio', 'off'] as const;
    patchUi({ scrollSync: order[(order.indexOf(state.ui.scrollSync) + 1) % order.length] });
  };
  const syncLabel = state.ui.scrollSync === 'anchor' ? '锚定' : state.ui.scrollSync === 'ratio' ? '比例' : '关闭';

  const cov = { measured: measuredCount.current, total, ratio: total ? measuredCount.current / total : 1 };

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <Icon name="eye" size={12} />
        <span>预览</span>
        <span className="spacer" />
        {errorCount > 0 && (
          <span className="chip err" title={snapshot.errors.map((e) => e.message).join('\n')}>
            <Icon name="alert" size={11} /> {errorCount} 个公式错误
          </span>
        )}
        <span
          className="chip"
          data-mdp-engine={metrics.engine}
          title={`渲染引擎：${metrics.engine === 'worker' ? 'Web Worker（主线程不参与解析与排版）' : '主线程降级模式'}${info.workerFailed ? '（Worker 不可用，已自动降级）' : ''}\n`
            + `本次重渲 ${metrics.changed} 块 / 复用 ${metrics.reused} 块 / 共 ${metrics.blocks} 块\n`
            + `引擎耗时 ${metrics.ms}ms · 端到端 ${metrics.latencyMs}ms（含排队与传输）\n`
            + `差量传输 ${(metrics.deltaBytes / 1024).toFixed(1)}KB / 全量 ${(metrics.fullBytes / 1024).toFixed(1)}KB（${deltaPct}%）`}
        >
          <Icon name={metrics.engine === 'worker' ? 'cpu' : 'alert'} size={11} />
          {' '}{metrics.changed}/{metrics.blocks} 块 · {metrics.ms}ms
        </span>
        <button
          className="chip"
          style={{ cursor: 'pointer' }}
          data-mdp-virtual={virtualWanted ? '1' : '0'}
          title={`视口虚拟化：${virtualWanted ? '开' : '关'}\n`
            + `当前挂载 ${Math.max(0, last - first + 1)} / ${total} 块 · 已测高度 ${cov.measured}/${cov.total}（${(cov.ratio * 100).toFixed(0)}%）\n`
            + '关掉后所有块都会挂进 DOM（浏览器页内查找能命中未显示的块，但节点数随文档长度增长）'}
          onClick={() => patchUi({ virtualize: !virtualWanted })}
        >
          虚拟 {virtualWanted ? `${last - first + 1}/${total}` : '关'}
        </button>
        <button
          className="chip"
          style={{ cursor: 'pointer' }}
          title="滚动同步模式：锚定（按行插值，推荐）/ 比例 / 关闭"
          onClick={cycleSync}
        >
          同步 {syncLabel}
        </button>
        <span className="chip" title="文档主题影响预览与所有导出">{docTheme}</span>
        <button
          className="btn btn-ghost btn-sm"
          data-mdp-zoom={zoom}
          title={`预览缩放：${zoom === 'z-fit' ? `自适应（等比适配到面板，当前 ${zoomPct}%）` : `固定 ${zoomPct}%`}\n`
            + `预览恒定按导出宽度 ${paperWidth}px 排版，因此公式换行与导出产物一致。\n`
            + '点击在 自适应 → 100% → 75% → 50% 之间循环。'}
          onClick={() => patchUi({ previewZoom: nextZoom() })}
        >
          {zoom === 'z-fit' ? `自适应 ${zoomPct}%` : `${zoomPct}%`}
        </button>
      </div>
      <div className="pane-body preview-scroll" ref={scrollRef}>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <style dangerouslySetInnerHTML={{ __html: hljsCss }} />
        {/* 外层撑起"缩放后"的高度（transform 不参与布局），内层恒定导出宽度。
            宽度用 paperWidth 而不是 min(100%, …)：靠收窄宽度适配会让预览重排，
            就不是导出的版面了。 */}
        <div
          className="preview-scale-wrap"
          data-zoom={zoom}
          data-scale={scale.toFixed(4)}
          style={{ width: `${Math.round(paperWidth * scale)}px`, height: scaledH ? `${scaledH}px` : undefined }}
        >
          <div className="preview-paper" ref={paperRef} style={{ width: `${paperWidth}px`, transform: `scale(${scale})` }}>
            <div
              ref={innerRef}
              className="mdp-doc"
              data-doc-theme={docTheme}
              data-render-engine={metrics.engine}
              data-virtual={virtualWanted ? '1' : '0'}
              onClick={onPaperClick}
              onClickCapture={onPaperClickCapture}
              onMouseDown={onPaperMouseDown}
            >
              {useSpacers && (
                <div ref={topSpacerRef} className="mdp-spacer" style={{ height: `${Math.round(topPad)}px` }} aria-hidden="true" />
              )}
              {snapshot.blocks.slice(first, last + 1).map((b) => (
                <Block key={b.key} vkey={b.key} html={b.html} first={b.first} lines={`${b.start}-${b.end}`} />
              ))}
              {useSpacers && (
                <div ref={bottomSpacerRef} className="mdp-spacer" style={{ height: `${Math.round(bottomPad)}px` }} aria-hidden="true" />
              )}
            </div>
          </div>
        </div>
        {!content.trim() && (
          <div className="preview-empty">
            在左侧开始书写，或从「模板 / 示例」插入内容
          </div>
        )}
      </div>
    </div>
  );
});

export default React.memo(PreviewPane);
