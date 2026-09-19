/**
 * web/src/lib/api.ts — 后台 API 客户端。
 * 同源访问（生产由 Node 后台直接托管 web/dist），开发模式走 Vite 代理。
 */

import type {
  CapsResponse, Job, LogEntry, MetaResponse, RenderAccepted, RenderSettings, Artifact,
} from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let payload: any = null;
    try { payload = await res.json(); } catch { /* 非 JSON 错误 */ }
    const err = new Error(payload?.error || `${res.status} ${res.statusText}`) as Error & {
      status?: number; blockers?: unknown; detail?: string;
    };
    err.status = res.status;
    err.blockers = payload?.blockers;
    err.detail = payload?.detail;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean; version: string; baseUrl: string; jobs: unknown; raster: unknown }>('/api/health'),

  caps: (force = false) => req<CapsResponse>(`/api/caps${force ? '?force=1' : ''}`),

  meta: () => req<MetaResponse>('/api/meta'),

  refresh: () => req<{ ok: boolean }>('/api/refresh', { method: 'POST' }),

  plan: (settings: Partial<RenderSettings> & { content?: string }) =>
    req<{ commands: Array<{ target: string; engine: string; command: string }> }>('/api/plan', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  render: (payload: Record<string, unknown>) =>
    req<RenderAccepted>('/api/render', { method: 'POST', body: JSON.stringify(payload) }),

  cancel: (jobId: string) => req<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, { method: 'POST' }),

  job: (jobId: string) => req<{ job: Job; logs: LogEntry[] }>(`/api/jobs/${jobId}`),

  jobs: (limit = 40) => req<{ jobs: Job[] }>(`/api/jobs?limit=${limit}`),

  artifacts: (limit = 120) => req<{ artifacts: Artifact[]; total: number }>(`/api/artifacts?limit=${limit}`),

  deleteArtifact: (rel: string) =>
    req<{ ok: boolean }>(`/api/file?path=${encodeURIComponent(rel)}`, { method: 'DELETE' }),

  cleanup: () => req<{ ok: boolean; removed: number }>('/api/cleanup', { method: 'POST', body: '{}' }),

  examples: () => req<{ examples: Array<{ name: string; size: number; mtime: string }> }>('/api/examples'),

  example: (name: string) => req<{ name: string; content: string }>(`/api/examples/${encodeURIComponent(name)}`),

  hljsCss: (theme: string) => fetch(`/api/hljs.css?theme=${encodeURIComponent(theme)}`).then((r) => r.text()),

  fileUrl: (rel: string, download = false) =>
    `/api/file?path=${encodeURIComponent(rel)}${download ? '&download=1' : ''}`,
};

/**
 * 订阅任务日志（SSE）。
 * @returns 取消订阅函数
 */
export function subscribeJob(
  jobId: string,
  handlers: {
    onLog?: (entry: LogEntry) => void;
    onState?: (job: Job) => void;
    onProgress?: (p: { pct: number; label: string; etaMs: number | null }) => void;
    onDone?: (job: Job) => void;
    onError?: (err: Event) => void;
  },
): () => void {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  let closed = false;
  const close = () => { if (!closed) { closed = true; es.close(); } };

  es.addEventListener('log', (ev) => {
    try { handlers.onLog?.(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ }
  });
  es.addEventListener('progress', (ev) => {
    try { handlers.onProgress?.(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ }
  });
  es.addEventListener('state', (ev) => {
    try {
      const job = JSON.parse((ev as MessageEvent).data) as Job;
      handlers.onState?.(job);
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        handlers.onDone?.(job);
        close();
      }
    } catch { /* ignore */ }
  });
  es.onerror = (err) => {
    if (closed) return;
    // 任务已结束时服务端会主动关闭连接，属正常
    handlers.onError?.(err);
    close();
  };
  return close;
}

/** 把 Markdown 源码与设置组装成后台请求体。 */
export function buildPayload(
  content: string,
  settings: RenderSettings,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    content,
    filename: settings.filename,
    targets: settings.targets,
    png: settings.png,
    doc: settings.doc,
    markdown: settings.markdown,
    latex: settings.latex,
    meta: settings.meta,
    ...extra,
  };
}
