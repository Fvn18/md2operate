/**
 * web/src/lib/persist.ts — 浏览器侧的持久化胶水层。
 *
 * 真正的逻辑在 shared/persist.mjs（不碰平台 API，可在 Node 里用 fake-indexeddb
 * 完整自检）。这里只做两件事：
 *   ① 把 window 上的 indexedDB / localStorage **安全地**取出来（隐私模式会抛错）
 *   ② 提供一个外部 store，让界面能如实显示"现在是 IndexedDB 还是降级的 localStorage"
 *
 * 为什么状态要暴露到界面：持久化降级是**用户必须知道**的事（接下来写的东西可能
 * 只活在这个标签页里），而不是只在 console 里留一行。
 */

import { useSyncExternalStore } from 'react';
import { createPersistence, compactDocs, expandDocs } from '@shared/persist.mjs';

export const NS = 'mdp.studio.v2';

function safeIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  } catch {
    // 某些沙箱 iframe / 严格隐私模式下访问本身就是异常
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (!ls) return null;
    // 探测可写性：Safari 无痕下 localStorage 存在但 setItem 会抛
    ls.setItem(`${NS}.__probe`, '1');
    ls.removeItem(`${NS}.__probe`);
    return ls;
  } catch {
    return null;
  }
}

export const persistence = createPersistence({
  idb: safeIndexedDB(),
  ls: safeLocalStorage(),
  namespace: NS,
});

export interface PersistStatus {
  mode: 'indexeddb' | 'localstorage';
  store: string;
  degradedReason: string | null;
  writes: number;
  lastError: string | null;
  migrated: boolean;
  /** 历史版本遗留的"带正文的 localStorage 文档"是否已经搬走 */
  ready: boolean;
}

const rawStatus = () => persistence.status() as unknown as Omit<PersistStatus, 'ready'>;

let snapshot: PersistStatus = { ...rawStatus(), ready: false };
const listeners = new Set<() => void>();

function refresh() {
  const next: PersistStatus = { ...rawStatus(), ready: snapshot.ready };
  const changed = next.mode !== snapshot.mode
    || next.degradedReason !== snapshot.degradedReason
    || next.writes !== snapshot.writes
    || next.lastError !== snapshot.lastError
    || next.migrated !== snapshot.migrated
    || next.ready !== snapshot.ready;
  snapshot = next;
  if (changed) for (const fn of listeners) { try { fn(); } catch { /* ignore */ } }
}

export function markPersistReady() {
  snapshot = { ...snapshot, ready: true };
  refresh();
}

export function getPersistStatus(): PersistStatus { return snapshot; }

export function usePersistStatus(): PersistStatus {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getPersistStatus,
    getPersistStatus,
  );
}

/* --------------------------------------------------------------- 便捷封装 -- */

export const KEYS = {
  docs: 'docs',
  /** 不含正文的文档索引：同步可读，首屏骨架用它 */
  docsIndex: 'docs:index',
  activeId: 'activeId',
  settings: 'settings',
  ui: 'ui',
} as const;

/** 首屏同步读：文档索引（可能是老版本留下的"带正文的 docs"）。 */
export function readLocalDocs(): { docs: Array<Record<string, unknown>>; legacy: boolean } {
  const legacyRaw = persistence.lsGet(KEYS.docs, null);
  if (Array.isArray(legacyRaw) && legacyRaw.length && typeof legacyRaw[0]?.content === 'string') {
    return { docs: legacyRaw, legacy: true };
  }
  const index = persistence.lsGet(KEYS.docsIndex, null);
  if (Array.isArray(index) && index.length) {
    return { docs: expandDocs(index) as Array<Record<string, unknown>>, legacy: false };
  }
  return { docs: [], legacy: false };
}

export function readLocalSettings(): unknown { return persistence.lsGet(KEYS.settings, null); }
export function readLocalUi(): unknown { return persistence.lsGet(KEYS.ui, null); }
export function readLocalActiveId(): string | null { return persistence.lsGet(KEYS.activeId, null); }

/** 把文档写入 IndexedDB（异步），同时把"没有正文的索引"写回 localStorage。 */
export async function writeDocs(docs: Array<Record<string, unknown>>): Promise<{ ok: boolean; mode: string; error?: Error }> {
  const res = await persistence.write(KEYS.docs, docs);
  persistence.lsSet(KEYS.docsIndex, compactDocs(docs));
  refresh();
  return res;
}

export function writeSmall(key: 'settings' | 'ui' | 'activeId', value: unknown) {
  persistence.lsSet(key, value);
}

export { compactDocs, expandDocs };
