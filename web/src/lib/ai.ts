/**
 * web/src/lib/ai.ts — AI 能力的前端客户端。
 *
 * 两条硬约束决定了这里的形状：
 *   1. **密钥永不出现在浏览器**。前端只调 `/api/ai/*`，由本机后台进程去持有密钥；
 *      连 `/api/config` 的响应里也只有 `apiKeySet: true/false`。
 *   2. **流式优先**。长文本任务（续写/公式/润色）走 SSE 边生成边显示；而需要
 *      "一键整段替换"的两项（截图转公式、公式纠错）走结构化输出，保证只有一个
 *      确定答案。这个取舍在 server/ai.mjs 的 AI_TASKS 里定义，前端按 `stream` 分派。
 *
 * 用 fetch + ReadableStream 手写 SSE 解析（而不是 EventSource），因为要 POST 大
 * 载荷（选区文本、截图 base64），而 EventSource 只能 GET。
 */

import type { AiStatus, PublicConfig } from './types';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!res.ok) {
    const err = new Error(payload?.error || `${res.status} ${res.statusText}`) as Error & {
      status?: number; detail?: string; retryable?: boolean;
    };
    err.status = res.status;
    err.detail = payload?.detail;
    err.retryable = payload?.retryable;
    throw err;
  }
  return payload as T;
}

export interface AiStreamHandlers {
  onStart?: (info: { model: string; mock: boolean }) => void;
  onDelta?: (text: string, full: string) => void;
  onThinking?: (text: string) => void;
  onDone?: (info: { chars: number; ms: number; model: string; mock: boolean }) => void;
}

/** 流式任务：解析后台转发过来的 SSE。 */
export async function aiStream(
  task: string,
  params: Record<string, unknown>,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`/api/ai/${task}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    let payload: any = null;
    try { payload = JSON.parse(text); } catch { /* 非 JSON */ }
    const err = new Error(payload?.error || `${res.status} ${res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (!res.body) throw new Error('后台未返回可读流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let streamError: Error | null = null;

  const handleBlock = (block: string) => {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let payload: any;
    try { payload = JSON.parse(dataLines.join('\n')); } catch { return; }
    switch (event) {
      case 'start': handlers.onStart?.({ model: payload.model, mock: payload.mock }); break;
      case 'delta': full += payload.text || ''; handlers.onDelta?.(payload.text || '', full); break;
      case 'thinking': handlers.onThinking?.(payload.text || ''); break;
      case 'done': handlers.onDone?.(payload); break;
      case 'error':
        streamError = Object.assign(new Error(payload.message || 'AI 调用失败'), { status: payload.status });
        break;
      default: break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) handleBlock(block);
    }
  }
  if (buf.trim()) handleBlock(buf);
  if (streamError) throw streamError;
  return full;
}

/** 非流式（结构化）任务。 */
export async function aiStructured<T = Record<string, unknown>>(
  task: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ structured: T; model: string; mock: boolean }> {
  return json<{ structured: T; model: string; mock: boolean }>(`/api/ai/${task}`, {
    method: 'POST',
    body: JSON.stringify(params),
    signal,
  });
}

export const aiApi = {
  status: () => json<AiStatus>('/api/ai/status'),
  config: () => json<PublicConfig>('/api/config'),
  saveConfig: (patch: Record<string, unknown>) =>
    json<PublicConfig>('/api/config', { method: 'PUT', body: JSON.stringify(patch) }),
  stream: aiStream,
  structured: aiStructured,
};

/** 把文件/剪贴板图片读成 base64（不含 data: 前缀，官方 inline 格式要求裸 base64）。 */
export function fileToBase64(file: Blob): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve({
        data: comma >= 0 ? result.slice(comma + 1) : result,
        mimeType: file.type || 'image/png',
      });
    };
    reader.readAsDataURL(file);
  });
}

/** 单张图片的大小上限（官方 inline 请求体限制约 20MB，这里留足余量）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
