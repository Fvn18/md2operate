/**
 * web/src/lib/preview-client.ts — 预览的**外部 store**：Worker 渲染 + 差量应用。
 *
 * 主线程与渲染之间的关系被收敛到这里，PreviewPane 只做两件事：
 *   ① 订阅快照，把变化过的块交给 React（未变更块引用不变 → 不动 DOM）
 *   ② 把"行号 → 块"的映射用在滚动同步上
 *
 * 三条硬性要求：
 *   · **首屏不空**：挂载时先用主线程引擎同步渲一帧（和旧行为一样的首帧），
 *     再启动 Worker 接管后续。用户看到的是"立刻有内容"，而不是等 Worker 起来。
 *   · **Worker 挂了不能白屏**：构造失败、脚本 404、运行中抛错 —— 全部自动降级到
 *     主线程引擎，并标记 `mode`，界面上如实显示。宁可慢，不可坏。
 *   · **快照必须稳定**：useSyncExternalStore 要求 getSnapshot 返回稳定引用，
 *     所以这里只在真正产生新块数组时才换 snapshot 对象。
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  createPreviewEngine,
  createPreviewStore,
  applyDelta,
  PREVIEW_PROTOCOL_VERSION,
} from '@shared/preview-engine.mjs';

export interface PreviewBlock {
  /** 本地稳定 id：React 的 key 用它（引擎的 key 只用于差量寻址） */
  id: number;
  key: string;
  html: string;
  first?: string;
  start: number;
  end: number;
}

export interface PreviewMetrics {
  /** 引擎渲染耗时（解析 + 排版） */
  ms: number;
  /** Worker 内耗时；主线程降级时等于 ms */
  workerMs: number;
  /** 端到端：输入 → 结果回到主线程（含排队与传输） */
  latencyMs: number;
  blocks: number;
  /** 下发 HTML 的块数（真正需要重建 DOM 的块） */
  changed: number;
  /** 只补了源码行区间的块数（HTML 未变，只更新 data-lines） */
  patched: number;
  reused: number;
  removed: number;
  /** 差量传输的 HTML 字节 / 全量 HTML 字节 */
  deltaBytes: number;
  fullBytes: number;
  sourceChars: number;
  /** 最近一次渲染是否真的走了增量 */
  mode: string;
  /** 'worker' | 'main'（降级） */
  engine: 'worker' | 'main';
  /** Worker 端"最新优先"丢弃掉的中间态请求数（打字快于渲染时会 > 0） */
  coalesced: number;
}

export interface PreviewSnapshot {
  blocks: PreviewBlock[];
  toc: Array<{ level: number; text: string; id: string }>;
  errors: Array<{ kind: string; message: string; tex?: string; line?: number | null; blockStart?: number }>;
  stats: { chars: number; cjk: number; words: number; lines: number; readingMinutes: number };
  mathCount: number;
  metrics: PreviewMetrics;
  revision: number;
}

const EMPTY_STATS = { chars: 0, cjk: 0, words: 0, lines: 0, readingMinutes: 0 };
const EMPTY_METRICS: PreviewMetrics = {
  ms: 0, workerMs: 0, latencyMs: 0, blocks: 0, changed: 0, patched: 0, reused: 0, removed: 0,
  deltaBytes: 0, fullBytes: 0, sourceChars: 0, mode: 'idle', engine: 'main', coalesced: 0,
};

let snapshot: PreviewSnapshot = {
  blocks: [], toc: [], errors: [], stats: EMPTY_STATS, mathCount: 0,
  metrics: EMPTY_METRICS, revision: 0,
};

const listeners = new Set<() => void>();
/** 差量应用器（shared/preview-engine.mjs）：key → 本地带 id 的块 */
const store = createPreviewStore();
let engineMode: 'worker' | 'main' = 'main';
let coalesced = 0;
let lastHtmlBytes = 0;

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 单个订阅者出错不影响其它 */ }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getPreviewSnapshot(): PreviewSnapshot { return snapshot; }

/** 当前块数组（滚动同步直接读，不必进 React）。 */
export function getPreviewBlocks(): PreviewBlock[] { return snapshot.blocks; }

export function usePreviewSnapshot(): PreviewSnapshot {
  return useSyncExternalStore(subscribe, getPreviewSnapshot, getPreviewSnapshot);
}

/* ------------------------------------------------------------ 引擎两态 -- */

type PreviewEngine = ReturnType<typeof createPreviewEngine>;
interface EngineResult {
  blocks: PreviewBlock[];
  toc: PreviewSnapshot['toc'];
  errors: PreviewSnapshot['errors'];
  stats: PreviewSnapshot['stats'];
  mathCount: number;
  revision: number;
  metrics: Partial<PreviewMetrics> & { ms?: number };
}

/** 主线程引擎：首帧渲染 + Worker 不可用时的降级路径。 */
let mainEngine: PreviewEngine | null = null;
function getMainEngine(options: Record<string, unknown>): PreviewEngine {
  if (!mainEngine) mainEngine = createPreviewEngine({ ...options });
  return mainEngine;
}

let worker: Worker | null = null;
let workerAlive = false;
let workerFailed = false;
let workerSendId = 0;
/** 最近一次发送的请求 id（只认它的回包，迟到的旧回包直接丢弃） */
let latestId = 0;
let inFlight = false;
let pendingSource: string | null = null;
let pendingSentAt = 0;
let currentOptions: Record<string, unknown> = {};
let rafHandle: number | null = null;

/* -------------------------------------------------------- 快照发布 -- */

function publish(result: EngineResult, engine: 'worker' | 'main', latencyMs: number, workerMs: number) {
  const blocks = applyDelta(store, result as Parameters<typeof applyDelta>[1]);
  lastHtmlBytes = result.metrics?.fullBytes || lastHtmlBytes;
  snapshot = {
    blocks,
    toc: result.toc || [],
    errors: result.errors || [],
    stats: result.stats || EMPTY_STATS,
    mathCount: result.mathCount || 0,
    metrics: {
      ms: result.metrics?.ms ?? workerMs,
      workerMs,
      latencyMs: +latencyMs.toFixed(1),
      blocks: blocks.length,
      changed: result.metrics?.changed ?? 0,
      patched: result.metrics?.patched ?? 0,
      reused: result.metrics?.reused ?? 0,
      removed: result.metrics?.removed ?? 0,
      deltaBytes: result.metrics?.deltaBytes ?? 0,
      fullBytes: result.metrics?.fullBytes ?? lastHtmlBytes,
      sourceChars: result.metrics?.sourceChars ?? 0,
      mode: result.metrics?.mode || 'full',
      engine,
      coalesced,
    },
    revision: result.revision ?? snapshot.revision + 1,
  };
  emit();
}

function publishError(err: unknown) {
  const msg = String((err as Error)?.message || err);
  snapshot = {
    ...snapshot,
    errors: [{ kind: 'fatal', message: msg }],
    metrics: { ...snapshot.metrics, mode: 'error' },
    revision: snapshot.revision + 1,
  };
  emit();
}

/** 主线程同步渲染（首帧 / 降级）。 */
function renderOnMain(source: string, options: Record<string, unknown>) {
  const engine = getMainEngine(options);
  const t0 = performance.now();
  const result = engine.render(source) as unknown as EngineResult;
  publish(result, 'main', performance.now() - t0, result.metrics?.ms ?? 0);
}

/* ---------------------------------------------------------- Worker 收发 -- */

function handleWorkerMessage(ev: MessageEvent) {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ready') {
    if (msg.protocol !== PREVIEW_PROTOCOL_VERSION) {
      // 协议不一致（多半是浏览器缓存了旧的 worker 产物）：降级比出错好
      workerFailed = true;
      workerAlive = false;
      try { worker?.terminate(); } catch { /* ignore */ }
      worker = null;
      flushPending();
      return;
    }
    workerAlive = true;
    // 把主线程首帧渲染出的块"交接"给 Worker：否则 Worker 的第一次渲染会把整篇
    // HTML 再传一遍（实测 3.7MB）。大文档下超过阈值就跳过预热，退化为一次全量。
    seedWorker();
    flushPending();
    return;
  }
  if (msg.type === 'result') {
    inFlight = false;
    if (msg.id !== latestId) { flushPending(); return; }  // 迟到的旧结果，丢弃
    const latency = (typeof msg.sentAt === 'number' ? performance.now() - msg.sentAt : 0);
    try {
      publish(msg.result, 'worker', latency, msg.workerMs || 0);
    } catch (err) {
      publishError(err);
    }
    flushPending();
    return;
  }
  if (msg.type === 'error') {
    inFlight = false;
    publishError(new Error(msg.message));
    flushPending();
  }
}

/** 交接首帧状态（有阈值保护，避免超大文档克隆出几十 MB）。 */
function seedWorker(force = false) {
  if (!worker || !workerAlive) return 0;
  const blocks = snapshot.blocks;
  if (!blocks.length) return 0;
  let total = 0;
  for (const b of blocks) total += b.html.length;
  if (!force && (blocks.length > 4000 || total > 8 * 1024 * 1024)) return 0;
  try {
    worker.postMessage({ type: 'seed', id: ++workerSendId, blocks });
    return blocks.length;
  } catch {
    return 0;
  }
}

function flushPending() {
  if (pendingSource === null) return;
  if (worker && workerAlive) {
    if (inFlight) return;                    // 等这一轮回来再发，天然背压
    const source = pendingSource;
    const sentAt = pendingSentAt;
    pendingSource = null;
    inFlight = true;
    latestId = ++workerSendId;
    try {
      worker.postMessage({ type: 'render', id: latestId, source, sentAt });
    } catch {
      inFlight = false;
      degradeToMain();
    }
    return;
  }
  // Worker 不可用：主线程兜底（同一次调用里同步完成）
  const source = pendingSource;
  pendingSource = null;
  renderOnMain(source, currentOptions);
}

function degradeToMain() {
  workerFailed = true;
  workerAlive = false;
  engineMode = 'main';
  try { worker?.terminate(); } catch { /* ignore */ }
  worker = null;
  flushPending();
}

function ensureWorker() {
  if (worker || workerFailed) return;
  if (typeof Worker === 'undefined') { workerFailed = true; return; }
  try {
    worker = new Worker(new URL('../worker/render.worker.ts', import.meta.url), { type: 'module' });
    engineMode = 'worker';
    worker.onmessage = handleWorkerMessage;
    worker.onerror = () => degradeToMain();
    worker.onmessageerror = () => degradeToMain();
  } catch {
    degradeToMain();
  }
}

/* -------------------------------------------------------------- 对外 API -- */

/**
 * 提交一次渲染请求。同帧内的多次调用会合并（打字的连击只发最后一次）。
 * 不阻塞：立即返回，结果通过订阅到达。
 */
export function requestPreview(source: string, options?: Record<string, unknown>) {
  if (options) setPreviewOptions(options);
  pendingSource = source;
  pendingSentAt = performance.now();
  coalesced++;
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    ensureWorker();
    flushPending();
  });
}

/**
 * Markdown 选项变化：换引擎（缓存随旧选项一起作废）。
 *
 * 选项一变，块 key 的前缀（选项指纹）就变了 → 旧块全部作废。本地 store 必须
 * 一起清空，否则下一轮差量会因为"找不到 key"而报错（这条断言在 applyDelta 里）。
 */
export function setPreviewOptions(options: Record<string, unknown>) {
  const key = JSON.stringify(options);
  if (key === JSON.stringify(currentOptions)) return;
  currentOptions = { ...options };
  if (mainEngine) mainEngine.setOptions(currentOptions);
  // 选项一变，块 key 的前缀（选项指纹）就变了 → 本地块表必须整体作废，
  // 否则下一轮差量会因为"找不到 key"而报错（这条断言在 applyDelta 里）。
  store.byKey.clear();
  store.order = [];
  if (worker && workerAlive) {
    inFlight = false;
    latestId = ++workerSendId;
    try { worker.postMessage({ type: 'options', id: latestId, options: currentOptions }); } catch { degradeToMain(); }
  }
}

/**
 * 首帧：主线程同步渲染一次，保证"打开就有内容"；随后由 Worker 接管。
 * 只应在挂载时调用一次。
 */
export function primePreview(source: string, options: Record<string, unknown>) {
  currentOptions = { ...options };
  try {
    renderOnMain(source, currentOptions);
  } catch (err) {
    publishError(err);
  }
  ensureWorker();
}

/** 诊断用：当前引擎形态与版本信息。 */
export function previewEngineInfo() {
  return {
    mode: engineMode,
    workerFailed,
    workerAlive,
    protocol: PREVIEW_PROTOCOL_VERSION,
    blocks: snapshot.blocks.length,
    coalesced,
  };
}

/** 测试/诊断用：把 Worker 打掉，验证降级路径真的可用。 */
export function __killWorkerForTest() {
  degradeToMain();
}

/** React 便捷 Hook：挂载时初始化 + 订阅内容变化。 */
export function usePreviewEngine(content: string, options: Record<string, unknown>) {
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    primePreview(content, JSON.parse(optionsKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    requestPreview(content, JSON.parse(optionsKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, optionsKey]);
}
