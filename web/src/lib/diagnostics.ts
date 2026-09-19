/**
 * web/src/lib/diagnostics.ts — 基准/排错钩子。
 *
 * `scripts/bench.mjs` 需要在**真实页面里**测量全量渲染耗时与逐键延迟，因此这里
 * 把编辑器的 view 与当前源码登记到一个模块级注册表，并挂到 `window.__mdpBench`。
 *
 * 刻意保持极小：不带任何业务逻辑，不写磁盘，不发网络请求；它只是让"性能数字"
 * 可以被外部脚本复现，而不是只能靠肉眼看。
 */

import type { EditorView } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';
import { renderMarkdown, DEFAULT_MARKDOWN_OPTIONS } from '@shared/markdown.mjs';

interface BenchHooks {
  /** 用与预览/导出完全相同的渲染器跑一次全量渲染，返回 HTML */
  render: (src: string) => unknown;
  /** 当前编辑器里的源码 */
  currentSource: () => string;
  /** CodeMirror 的 EditorView（用于定位光标、派发事务） */
  view: () => EditorView | null;
  /** 由应用层注入的一次"增量渲染"耗时探针（可选） */
  lastRender?: () => { mode: string; ms: number; blocks: number; reused: number } | null;
  /** Vim 适配器（自检脚本据此读取当前模式：normal / insert） */
  vimCM?: () => unknown;
}

declare global {
  interface Window {
    __mdpBench?: BenchHooks;
    __mdpBootAt?: number;
  }
}

let cmView: EditorView | null = null;
let currentSource = '';

export function setBenchView(view: EditorView | null) {
  cmView = view;
}

export function setBenchSource(src: string) {
  currentSource = src;
}

export function installBenchHooks() {
  window.__mdpBench = {
    render: (src: string) => renderMarkdown(src, { ...DEFAULT_MARKDOWN_OPTIONS }),
    currentSource: () => currentSource,
    view: () => cmView,
    vimCM: () => (cmView ? getCM(cmView) : null),
  };
}
