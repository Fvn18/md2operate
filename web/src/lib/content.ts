/**
 * web/src/lib/content.ts — 编辑器内容的**热路径 store**。
 *
 * 为什么不能把内容放在 React 顶层 state 里：
 * 实测（scripts/bench.mjs，10 万字符）逐键延迟 1331ms，其中只有 ~170ms 是解析
 * 渲染，其余是「每次按键都让整棵组件树重渲染 + 预览整块 innerHTML 替换」。
 * 内容一旦进入 App 的 state，TopBar / 侧栏 / 导出面板 / 控制台都会陪着重渲染。
 *
 * 所以把内容单独放一个外部 store：
 *   · 编辑器写它（不进 React state）
 *   · 预览订阅它（useSyncExternalStore）
 *   · 其它组件完全不订阅
 * 于是「打字」这条热路径上只剩编辑器 + 预览两个组件。
 *
 * 持久化与文档 state 的同步是**旁路**：由 App 以 400ms 防抖把内容刷回 docs，
 * 这样每敲一个字都不会惊动整棵树。
 */

import { useSyncExternalStore } from 'react';

export interface ContentSnapshot {
  content: string;
  version: number;
}

let content = '';
let version = 0;
let snapshot: ContentSnapshot = { content, version };
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 单个订阅者出错不影响其它订阅者 */ }
  }
}

/** 写入新内容（编辑器每次变更调用）。相同内容不触发更新。 */
export function setContent(next: string): void {
  const text = String(next ?? '');
  if (text === content) return;
  content = text;
  version++;
  snapshot = { content, version };
  emit();
}

/** 同步读取（导出、保存等一次性读取场景，不需要订阅）。 */
export function getContent(): string {
  return content;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot(): ContentSnapshot {
  return snapshot;
}

/** 订阅内容变化的 Hook。只在需要实时反映内容的组件里使用。 */
export function useContent(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).content;
}

/** 内容版本号：想「内容变了就做点什么」但不需要内容本身时用。 */
export function useContentVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).version;
}

/** 供非 React 场景订阅（例如防抖持久化）。 */
export const subscribeContent = subscribe;
