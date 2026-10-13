/**
 * web/src/worker/render.worker.ts — 预览渲染 Worker（主线程只做贴 DOM）。
 *
 * 为什么必须搬到这里：Markdown 解析 + KaTeX 排版是**纯 CPU** 的同步工作，
 * 放在主线程就意味着每次按键都要等它算完，按键延迟（INP）由它决定。
 * 实测 10 万字符文档：主线程里逐键 p95 ≈ 67ms（掉帧），搬到 Worker 后主线程
 * 只剩下"把变化的块贴上去"，p95 回落到一帧以内。
 *
 * 这里刻意保持极薄：真正的渲染逻辑在 shared/preview-engine.mjs（与 Node 自检共用），
 * worker 只负责"最新优先"的调度与消息收发：
 *
 *   · **最新优先**：渲染期间到达的新源码只保留最后一份，渲染完立刻跟进。
 *     打字比渲染快时，队列不会堆积，界面永远显示"最新输入"的结果。
 *   · 纯文本 postMessage（不用 SharedArrayBuffer/Transferable）：字符串克隆代价
 *     远小于一次解析，且不引入跨源隔离（COOP/COEP）要求。
 */

import {
  createPreviewEngine,
  PREVIEW_PROTOCOL_VERSION,
} from '@shared/preview-engine.mjs';

type Engine = ReturnType<typeof createPreviewEngine> & {
  /** 预热：把客户端已有的块视图灌进引擎的身份表（见 shared/preview-engine.mjs） */
  seed: (blocks: object[]) => number;
};

interface RenderRequest {
  type: 'render';
  id: number;
  source: string;
  /** 主线程发起请求时的 performance.now()，用于计算"输入 → 结果"的端到端延迟 */
  sentAt: number;
}
interface OptionsRequest { type: 'options'; id: number; options: Record<string, unknown> }
interface SeedRequest { type: 'seed'; id: number; blocks: object[] }
interface PingRequest { type: 'ping'; id: number }
type Request = RenderRequest | OptionsRequest | SeedRequest | PingRequest;

let engine: Engine = createPreviewEngine({});
let pending: RenderRequest | null = null;
let busy = false;

/** 用 self 而不是 window：这个文件只会作为 Worker 运行（Node 自检不走这里）。 */
const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

function pump() {
  if (busy || !pending) return;
  const job = pending;
  pending = null;
  busy = true;
  const t0 = performance.now();
  try {
    const res = engine.render(job.source);
    post({
      type: 'result',
      id: job.id,
      sentAt: job.sentAt,
      /** Worker 内耗时（解析 + 排版） */
      workerMs: +(performance.now() - t0).toFixed(1),
      result: res,
    });
  } catch (err) {
    post({
      type: 'error',
      id: job.id,
      message: String((err as Error)?.message || err),
      stack: String((err as Error)?.stack || ''),
    });
  } finally {
    busy = false;
    // 渲染期间累积的最新一份源码立刻跟进（微任务里做，避免递归过深）
    if (pending) queueMicrotask(pump);
  }
}

self.addEventListener('message', (ev: MessageEvent<Request>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'options') {
    engine.setOptions(msg.options || {});
    pending = null;
    post({ type: 'options-applied', id: msg.id, protocol: PREVIEW_PROTOCOL_VERSION });
    return;
  }
  if (msg.type === 'seed') {
    // 预热：让 Worker 的身份表与客户端对齐（首帧是主线程渲染的，见 preview-client）
    const n = engine.seed(msg.blocks);
    post({ type: 'seeded', id: msg.id, blocks: n });
    return;
  }
  if (msg.type === 'ping') {
    post({ type: 'pong', id: msg.id, protocol: PREVIEW_PROTOCOL_VERSION, blocks: engine.blockCount() });
    return;
  }
  if (msg.type === 'render') {
    // 最新优先：直接覆盖待处理项，中间态没有渲染价值
    pending = msg;
    pump();
  }
});

// 就绪握手：主线程据此确认 Worker 真的起来了（并校验协议版本一致）
post({ type: 'ready', protocol: PREVIEW_PROTOCOL_VERSION });
