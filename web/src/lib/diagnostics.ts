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
import {
  previewEngineInfo, getPreviewSnapshot, __killWorkerForTest,
} from './preview-client';
import { getPersistStatus } from './persist';

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
  /**
   * 预览引擎诊断：跑在 Worker 还是降级到主线程、差量指标、块数。
   * 自检脚本据此断言"渲染真的离开了主线程"，而不是只看界面像不像。
   */
  preview: () => {
    mode: string; workerFailed: boolean; workerAlive: boolean;
    protocol: number; blocks: number; coalesced: number;
    metrics: Record<string, unknown>;
  };
  /** 打掉 Worker，用于验证降级路径（自检专用） */
  killWorker: () => void;
  /** 持久化状态：跑在 IndexedDB 还是降级、写了多少次、迁移是否完成 */
  persist: () => Record<string, unknown>;
  /**
   * 预览虚拟化的现场数据：挂载了哪些块、DOM 节点数、高度表的覆盖率。
   * 由 PreviewPane 每次渲染后写入（见 web/src/components/PreviewPane.tsx）。
   * 自检脚本据此断言"节点数有上限"以及"滚到哪里哪里才有块"。
   */
  virtual?: () => Record<string, unknown> | null;
}

declare global {
  interface Window {
    __mdpBench?: BenchHooks;
    __mdpBootAt?: number;
    __mdpVirtual?: Record<string, unknown>;
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
    preview: () => {
      const info = previewEngineInfo();
      const snap = getPreviewSnapshot();
      return {
        ...info,
        metrics: snap.metrics as unknown as Record<string, unknown>,
      };
    },
    virtual: () => window.__mdpVirtual || null,
    killWorker: () => __killWorkerForTest(),
    persist: () => getPersistStatus() as unknown as Record<string, unknown>,
  };
}
