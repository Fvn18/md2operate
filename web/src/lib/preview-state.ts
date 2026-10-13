/**
 * web/src/lib/preview-state.ts — 状态栏 / 侧栏的数据总线。
 *
 * 内容：预览派生的低频数据（统计 / 目录 / 公式错误 / 增量指标）+ 编辑器光标。
 * 消费方是状态栏与侧栏。
 *
 * 为什么不放回 App 的 state：打字时它们每次都会变，一旦进 App 就把整棵树带上
 * 重渲染——那正是实测 1330ms 延迟里的大头。放在这里，只有真正订阅的组件更新。
 * 统计类数字不需要 60fps，250ms 一次人眼完全无感。
 */

import { useSyncExternalStore } from 'react';

export interface RenderError {
  kind: string;
  message: string;
  tex?: string;
  line?: number | null;
  blockStart?: number;
}

export interface PreviewMetrics {
  mode: string;
  /** 引擎渲染耗时（解析 + KaTeX 排版） */
  ms: number;
  blocks: number;
  /** 复用的块数（未变更，DOM 完全不动） */
  reused: number;
  /** 重渲的块数（差量里真正传输与替换的块） */
  rendered: number;
  /** 端到端延迟：输入 → 结果回到主线程（含排队与传输） */
  latencyMs?: number;
  /** 差量传输字节 / 全量 HTML 字节 */
  deltaBytes?: number;
  fullBytes?: number;
  /** 'worker' | 'main' —— 渲染跑在哪条线程上 */
  engine?: 'worker' | 'main';
  coalesced?: number;
}

export interface PreviewState {
  stats: { chars: number; cjk: number; words: number; lines: number; readingMinutes: number };
  toc: Array<{ level: number; text: string; id: string }>;
  errors: RenderError[];
  metrics: PreviewMetrics;
  /** 每次结构性变化自增 */
  revision: number;
}

const EMPTY: PreviewState = {
  stats: { chars: 0, cjk: 0, words: 0, lines: 0, readingMinutes: 0 },
  toc: [],
  errors: [],
  metrics: { mode: 'idle', ms: 0, blocks: 0, reused: 0, rendered: 0 },
  revision: 0,
};

let state: PreviewState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot(): PreviewState {
  return state;
}

/** 立即发布（目录、错误这类结构性变化必须及时，行内标注依赖它）。 */
export function publishPreview(patch: Partial<PreviewState>): void {
  const unchanged =
    (patch.toc === undefined || shallowTocEqual(patch.toc, state.toc))
    && (patch.errors === undefined || errorsEqual(patch.errors, state.errors))
    && (patch.stats === undefined
        || (patch.stats.chars === state.stats.chars && patch.stats.lines === state.stats.lines));

  if (unchanged) {
    // 内部状态照常更新，但不惊动订阅者
    state = { ...state, ...patch };
    return;
  }
  state = { ...state, ...patch, revision: state.revision + 1 };
  emit();
}

/** 只更新统计与指标（高频，走节流）。 */
export function publishStats(
  stats: PreviewState['stats'],
  metrics: PreviewMetrics,
): void {
  if (
    stats.chars === state.stats.chars
    && stats.lines === state.stats.lines
    && stats.words === state.stats.words
    && metrics.ms === state.metrics.ms
    && metrics.reused === state.metrics.reused
    && metrics.engine === state.metrics.engine
    && metrics.latencyMs === state.metrics.latencyMs
  ) {
    state = { ...state, stats, metrics };
    return;
  }
  state = { ...state, stats, metrics, revision: state.revision + 1 };
  emit();
}

function shallowTocEqual(a: PreviewState['toc'], b: PreviewState['toc']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].level !== b[i].level || a[i].text !== b[i].text) return false;
  }
  return true;
}

function errorsEqual(a: RenderError[], b: RenderError[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].line !== b[i].line || a[i].message !== b[i].message) return false;
  }
  return true;
}

export function usePreviewState(): PreviewState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 非 React 订阅：把状态镜像进 ref，从而**不触发重渲染**。
 * App 需要读目录做跳转，但绝不该因为目录变化而重渲染整棵树。
 */
export function subscribePreviewState(fn: () => void): () => void {
  return subscribe(fn);
}

export function getPreviewState(): PreviewState {
  return state;
}

/** 切换文档时清空，避免上一个文档的目录/错误残留 */
export function resetPreviewState(): void {
  state = { ...EMPTY, revision: state.revision + 1 };
  emit();
}
