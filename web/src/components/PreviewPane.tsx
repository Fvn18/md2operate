/**
 * web/src/components/PreviewPane.tsx — 实时预览（块级增量渲染）。
 *
 * 这个组件是上一版 1330ms 逐键延迟的唯一来源，也是这次优化的主战场。两个关键改动：
 *
 * 1. **不再整体 innerHTML 替换**。渲染结果按"结构完整的块"返回，每块一个稳定
 *    key 交给 React；未变更的块是 React.memo 的，`html` 字符串引用不变 → 一个
 *    DOM 节点都不碰。上一版每次按键都要重建数万个 KaTeX 节点并重新 layout/paint。
 *
 * 2. **内容不再经过 App state**。这里直接订阅 `lib/content.ts` 的外部 store，
 *    所以打字只惊动「编辑器 + 预览」两个组件，TopBar / 侧栏 / 导出面板 / 控制台
 *    完全不参与。
 *
 * 预览与导出仍然共用同一份渲染器（shared/markdown.mjs）与样式表
 * （shared/theme.mjs），只是预览额外做了缓存与分块。
 */

import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useStudio } from '../lib/store';
import { api } from '../lib/api';
import { useContent } from '../lib/content';
import { publishPreview, publishStats } from '../lib/preview-state';
import { createIncrementalRenderer } from '@shared/incremental.mjs';
import { documentCss, PAPER_SIZES, mmToPx } from '@shared/theme.mjs';
import { Icon } from './Icons';
import type { RenderError } from '../lib/preview-state';

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export interface PreviewPaneHandle {
  /** 把「第 line 行」所在的块滚到容器顶部（锚定式同步的核心） */
  scrollToLine: (line: number, margin?: number) => boolean;
  /** 只在目标行不在可视区时才滚动（光标跟随用，避免抖动） */
  revealLine: (line: number) => boolean;
  /** 当前渲染出的块数（自检/诊断用） */
  blockCount: () => number;
}

/**
 * 单块渲染结果。memo 的比较器只看 html 字符串——而增量渲染器对未变更的块
 * 返回的是**同一个字符串引用**，所以比较是 O(1)，未变更的块直接跳过。
 *
 * `data-first` 供 CSS 决定块间距（containment 之后外边距不再折叠，间距必须显式
 * 给出，而"下一块是什么标签"决定该给多大间距）。
 */
const Block = React.memo(
  function Block({ html, first, lines }: { html: string; first?: string; lines?: string }) {
    // data-lines 记录该块对应的源码行区间：锚定式滚动同步据此做映射，
    // 同时也让"同步是否真的对准了"这件事可以被自动化测试断言。
    return <div className="mdp-block" data-first={first} data-lines={lines} dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (a, b) => a.html === b.html && a.first === b.first && a.lines === b.lines,
);

interface PreviewResult {
  blocks: Array<{ key: string; html: string; first?: string; start: number; end: number }>;
  toc: Array<{ level: number; text: string; id: string }>;
  stats: { chars: number; cjk: number; words: number; lines: number; readingMinutes: number };
  errors: RenderError[];
  mathCount: number;
  metrics: { mode: string; ms: number; blocks: number; reused: number; rendered: number };
}

export const PreviewPane = forwardRef<PreviewPaneHandle, Props>(function PreviewPane({ scrollRef }, ref) {
  const { state, patchUi } = useStudio();
  const content = useContent();
  const innerRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<PreviewResult['blocks']>([]);
  /** 滚动跳转的世代号：新的跳转会作废上一轮还没跑完的收敛循环 */
  const scrollToken = useRef(0);
  /** 光标跟随：上一次已揭示的行 + rAF 合并标志（打字热路径保护） */
  const lastRevealed = useRef<number | null>(null);
  const revealPending = useRef(false);
  const [hljsCss, setHljsCss] = React.useState('');

  const docTheme = state.settings.doc.theme;
  const codeTheme = state.settings.doc.codeTheme
    || (['ink', 'nord'].includes(docTheme) ? 'github-dark' : 'github');
  const markdownOptions = state.settings.markdown;

  /* 代码高亮主题 CSS 由后台从 highlight.js 自身样式表读取，保证与导出一致 */
  useEffect(() => {
    let alive = true;
    api.hljsCss(codeTheme)
      .then((css) => { if (alive) setHljsCss(css); })
      .catch(() => { if (alive) setHljsCss(''); });
    return () => { alive = false; };
  }, [codeTheme]);

  /* Markdown 选项变化必须换渲染器实例（缓存随之作废） */
  const optionsKey = useMemo(() => JSON.stringify(markdownOptions), [markdownOptions]);
  const renderer = useMemo(
    () => createIncrementalRenderer(markdownOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [optionsKey],
  );

  /* ---- 热路径：渲染在 render 阶段同步完成（毫秒量级），不做二次渲染 ---- */
  const result = useMemo<PreviewResult>(() => {
    try {
      return renderer.render(content) as PreviewResult;
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      return {
        blocks: [{
          key: 'fatal',
          html: `<div class="mdp-callout mdp-callout-danger"><div class="mdp-callout-head">`
            + `<span class="mdp-callout-icon">✖</span><span class="mdp-callout-title">预览渲染失败</span></div>`
            + `<div class="mdp-callout-body"><pre>${msg}</pre></div></div>`,
          start: 1,
          end: 1,
        }],
        toc: [],
        stats: { chars: content.length, cjk: 0, words: 0, lines: content.split('\n').length, readingMinutes: 1 },
        errors: [{ kind: 'fatal', message: msg }],
        mathCount: 0,
        metrics: { mode: 'error', ms: 0, blocks: 1, reused: 0, rendered: 1 },
      };
    }
  }, [renderer, content]);

  blocksRef.current = result.blocks;

  /* ---- 锚定式滚动同步：行号 → 块（块自带 start/end 行号，所以是精确映射，
        不是按像素比例猜） ---- */
  const lineToIndex = (line: number): number => {
    const blocks = blocksRef.current;
    if (!blocks.length) return -1;
    const hit = blocks.findIndex((b) => line >= b.start && line <= b.end);
    if (hit >= 0) return hit;
    const next = blocks.findIndex((b) => b.start >= line);
    return next >= 0 ? next : blocks.length - 1;
  };

  useImperativeHandle(ref, () => ({
    scrollToLine: (line, margin = 8) => {
      const host = innerRef.current;
      const container = scrollRef.current;
      if (!host || !container) return false;
      const idx = lineToIndex(line);
      const el = host.children[idx] as HTMLElement | undefined;
      if (!el) return false;

      // 远距离跳转必须**迭代收敛**，原因是 content-visibility：
      // 目标块上方的块在跳转前只有估算高度（contain-intrinsic-size），
      // 我们每向下滚一点，就又有几块被真实布局、上方总高度变大，目标被继续推下去。
      // 好在这不会无限循环——`contain-intrinsic-size: auto` 会记住已渲染块的真实
      // 高度，所以每轮误差单调减小，几帧内必然收敛到 |delta| ≤ 1。
      // 诊断计数：让"同步到底有没有被调用"可被自动化断言，而不是靠肉眼猜
      const dbg = (window as any).__mdpBench;
      if (dbg) {
        dbg.syncCalls = (dbg.syncCalls || 0) + 1;
        dbg.syncLastLine = line;
        dbg.syncTargetIdx = idx;
        dbg.syncTargetLines = host.children[idx]?.getAttribute('data-lines') ?? null;
        dbg.syncBlockCount = blocksRef.current.length;
        dbg.syncChildCount = host.children.length;
        // 找到"此刻视觉上最顶部的块"的索引，用于对比
        const cRect = container.getBoundingClientRect();
        let topIdx = -1;
        for (let i = 0; i < host.children.length; i++) {
          if (host.children[i].getBoundingClientRect().bottom > cRect.top + 2) { topIdx = i; break; }
        }
        dbg.syncTopIdx = topIdx;
        dbg.syncTopLines = host.children[topIdx]?.getAttribute('data-lines') ?? null;
      }

      const token = ++scrollToken.current;
      const deltaOf = () => el.getBoundingClientRect().top - container.getBoundingClientRect().top - margin;
      const apply = () => {
        const delta = deltaOf();
        if (Math.abs(delta) > 1) container.scrollTop = Math.max(0, container.scrollTop + delta);
        return delta;
      };

      // 先粗定位
      container.scrollTop = Math.max(0,
        el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - margin);

      // 关键：**不能一到 delta≈0 就收工，也不能只看几帧**。
      // 实测证据（诊断计数）：对齐瞬间 targetIdx=231、topIdx=231、delta=-0.33，
      // 三帧内 delta 与容器总高都不变——看起来已经收敛；但随后 Chrome 继续在
      // 空闲时间布局视口外的块（content-visibility 的固有行为），上方内容变高，
      // 目标块被推下去 25 行（约 650px），最终顶部块变成 872-874。
      // 因此收敛判据必须是「对齐 **且** 容器总高在 250ms 内没再变」。
      const deadline = performance.now() + 900;
      let lastH = container.scrollHeight;
      let lastChange = performance.now();
      const record = (delta: number) => {
        const dbg = (window as any).__mdpBench;
        if (!dbg) return;
        dbg.syncLanded = line;
        dbg.syncDelta = +delta.toFixed(2);
        dbg.syncFrames = frames;
        dbg.syncStable = stable;
      };
      let frames = 0;
      let stable = 0;
      const step = () => {
        if (token !== scrollToken.current) return; // 已被更新的跳转取代
        frames++;
        const h = container.scrollHeight;
        if (h !== lastH) { lastH = h; lastChange = performance.now(); }
        const delta = apply();
        const quiet = performance.now() - lastChange > 250;
        if (Math.abs(delta) <= 1 && quiet) stable++; else stable = 0;
        if (stable >= 2 || performance.now() > deadline) { record(delta); return; }
        requestAnimationFrame(step);
      };
      step();
      return true;
    },
    revealLine: (line) => {
      const host = innerRef.current;
      const container = scrollRef.current;
      if (!host || !container) return false;
      // **热路径保护**：光标行每次按键都会变。这里做两件事避免把打字拖慢：
      //  ① 行号只挪 1 行（正常打字）直接跳过——需要时才读布局
      //  ② 合并到一帧内只执行一次（getBoundingClientRect 会强制同步布局，
      //     在 10 万节点的文档上每帧读多次代价很高）
      if (lastRevealed.current !== null && Math.abs(line - lastRevealed.current) <= 1) return true;
      lastRevealed.current = line;
      if (revealPending.current) return true;
      revealPending.current = true;
      requestAnimationFrame(() => {
        revealPending.current = false;
        const h = innerRef.current;
        const c = scrollRef.current;
        if (!h || !c) return;
        const i = lineToIndex(lastRevealed.current ?? line);
        const target = h.children[i] as HTMLElement | undefined;
        if (!target) return;
        const top = target.getBoundingClientRect().top - c.getBoundingClientRect().top;
        const bottom = top + target.offsetHeight;
        if (top >= 0 && bottom <= c.clientHeight) return;   // 已可见，不动
        c.scrollTop = Math.max(0, c.scrollTop + top - 12);
      });
      return true;
    },
    blockCount: () => blocksRef.current.length,
  }), [scrollRef]);

  /* ---- 目录与错误：结构性数据，立即发布（内部做相等比较，不会误报） ---- */
  useEffect(() => {
    publishPreview({ toc: result.toc, errors: result.errors });
  }, [result]);

  /* ---- 统计与增量指标：高频数据，250ms 节流，避免状态栏带着整棵树抖 ---- */
  const pending = useRef<{ stats: PreviewResult['stats']; metrics: PreviewResult['metrics'] } | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    pending.current = { stats: result.stats, metrics: result.metrics };
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (pending.current) publishStats(pending.current.stats, pending.current.metrics);
    }, 250);
  }, [result]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  /* 文档样式：与导出共用同一函数，只是这里把它注入到预览容器里 */
  const css = useMemo(
    () => documentCss({ ...state.settings.doc, card: false, transparent: false, margin: 0 }),
    [state.settings.doc],
  );

  /* 预览纸张宽度 = 导出时的实际宽度，所见即所得 */
  const paperWidth = useMemo(() => {
    const d = state.settings.doc;
    if (state.settings.png.mode === 'card') {
      return Math.round(d.contentWidth + d.cardPadding * 2 + (d.cardBorder ? 2 : 0));
    }
    const paper = (PAPER_SIZES as Record<string, { w: number; h: number }>)[d.paper] || PAPER_SIZES.A4;
    return Math.round(mmToPx(paper.w));
  }, [state.settings.doc, state.settings.png.mode]);

  /* 预览内的锚点跳转不应改变地址栏，也不该把整页滚动 */
  const onPaperClick = (ev: React.MouseEvent) => {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      ev.preventDefault();
      const el = innerRef.current?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  const errorCount = result.errors.length;

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <Icon name="eye" size={12} />
        <span>预览</span>
        <span className="spacer" />
        {errorCount > 0 && (
          <span className="chip err" title={result.errors.map((e) => e.message).join('\n')}>
            <Icon name="alert" size={11} /> {errorCount} 个公式错误
          </span>
        )}
        <span
          className="chip"
          title={`增量渲染：本次重渲 ${result.metrics.rendered} 块 / 复用 ${result.metrics.reused} 块，耗时 ${result.metrics.ms}ms`}
        >
          {result.metrics.rendered}/{result.metrics.blocks} 块 · {result.metrics.ms}ms
        </span>
        <span className="chip" title="文档主题影响预览与所有导出">{docTheme}</span>
        <button
          className="btn btn-ghost btn-sm"
          title="切换预览宽度"
          onClick={() => patchUi({ previewZoom: state.ui.previewZoom === 'z-100' ? 'z-90' : state.ui.previewZoom === 'z-90' ? 'z-75' : 'z-100' })}
        >
          {state.ui.previewZoom.replace('z-', '')}%
        </button>
      </div>
      <div className="pane-body preview-scroll" ref={scrollRef}>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <style dangerouslySetInnerHTML={{ __html: hljsCss }} />
        <div className={`preview-paper preview-${state.ui.previewZoom}`} style={{ maxWidth: `min(100%, ${paperWidth}px)` }}>
          <div
            ref={innerRef}
            className="mdp-doc"
            data-doc-theme={docTheme}
            onClick={onPaperClick}
            onClickCapture={onPaperClickCapture}
            onMouseDown={onPaperMouseDown}
          >
            {result.blocks.map((b) => (
              <Block key={b.key} html={b.html} first={b.first} lines={`${b.start}-${b.end}`} />
            ))}
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
