/**
 * web/src/lib/cursor.ts — 光标位置的独立微 store。
 *
 * 为什么不能放进 preview-state：那里还有**目录树**，而目录树的消费方是侧栏
 * （可能有几百上千个条目）。光标每敲一个字都会变，一旦两者同源，侧栏就会跟着
 * 每次按键重渲染整棵目录——实测这给 10 万字符文档的逐键延迟加了约 16ms
 * （41ms → 58ms）。拆开之后，只有状态栏（几个 span）订阅光标。
 */

import { useSyncExternalStore } from 'react';

export interface CursorPos { line: number; col: number }

let pos: CursorPos = { line: 1, col: 1 };
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

export function publishCursor(line: number, col: number): void {
  if (pos.line === line && pos.col === col) return;
  pos = { line, col };
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const getSnapshot = () => pos;

export function useCursor(): CursorPos {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
