/**
 * server/jobs.mjs — 渲染任务队列 + 日志广播。
 *
 * 设计目标：
 *   · 网页端点「导出」后立刻拿到 jobId，随后用 SSE 实时看到 pandoc / XeLaTeX 的
 *     **原始输出**——这就是"保留终端操作感"的另一半：图形界面并不掩盖底层命令。
 *   · 并发受控（默认 2），避免同时起多个 XeLaTeX 把机器打满。
 *   · 每个任务持有 AbortController，可随时取消。
 *   · 日志环形缓冲，晚订阅的客户端会先收到历史日志再收增量，刷新页面不丢现场。
 */

import { uid, nowIso } from './util.mjs';

const MAX_LOGS = 5000;
const MAX_JOBS = 200;

export const LOG_LEVELS = ['debug', 'cmd', 'out', 'info', 'ok', 'warn', 'err'];

export class JobManager {
  /**
   * @param {{concurrency?:number, onUpdate?:(job:object, event:string)=>void}} [opts]
   */
  constructor(opts = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.onUpdate = opts.onUpdate || (() => {});
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
  }

  /**
   * 建任务并入队。
   * @param {{type:string, label?:string, meta?:object, executor:(ctx:object)=>Promise<any>}} spec
   */
  create(spec) {
    const job = {
      id: uid(12),
      type: spec.type || 'render',
      label: spec.label || '',
      status: 'queued',
      cancelling: false,
      meta: spec.meta || {},
      logs: [],
      logCount: 0,
      subscribers: new Set(),
      artifacts: [],
      errors: [],
      warnings: [],
      commands: [],
      stats: null,
      toc: null,
      progress: 0,
      progressLabel: '',
      etaMs: null,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      elapsedMs: null,
      error: null,
      detail: null,
      queuePosition: this.queue.length + 1,
      abort: new AbortController(),
      _executor: spec.executor,
      _cancelRequested: false,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.#trim();
    this.#emit(job, 'created');
    this.#pump();
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  list(limit = 50) {
    return [...this.jobs.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit)
      .map((j) => this.publicView(j));
  }

  /** 去掉内部字段，供 HTTP 输出。 */
  publicView(job) {
    const { subscribers, _executor, abort, logs, ...rest } = job;
    return { ...rest, logCount: job.logs.length };
  }

  /** 上报进度（0..1）+ 阶段标签 + 预估剩余毫秒；前端据此画进度条与 ETA。 */
  progress(job, pct, label, etaMs) {
    if (!job) return;
    const clamped = Math.max(0, Math.min(1, Number(pct) || 0));
    job.progress = clamped;
    if (label) job.progressLabel = label;
    if (Number.isFinite(etaMs)) job.etaMs = Math.max(0, Math.round(etaMs));
    this.#emit(job, 'progress', { pct: clamped, label: job.progressLabel, etaMs: job.etaMs });
  }

  log(job, level, msg) {
    if (!job) return;
    const text = String(msg ?? '');
    const entry = { seq: ++job.logCount, t: Date.now(), level, msg: text.slice(0, 20000) };
    job.logs.push(entry);
    if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
    this.#emit(job, 'log', entry);
  }

  /** 订阅任务事件；返回取消订阅函数。 */
  subscribe(job, fn, { replay = true } = {}) {
    job.subscribers.add(fn);
    if (replay) for (const entry of job.logs) fn('log', entry);
    fn('state', this.publicView(job));
    return () => job.subscribers.delete(fn);
  }

  /**
   * 批量取消：按条件挑出还在排队/运行的**渲染**任务并全部取消。
   *
   * 用途是"用户又点了一次导出"：新请求必须让旧请求立刻让路，否则后端会同时
   * 跑多个 TeX/Chromium 子进程（每个都吃几百 MB），几分钟内就把机器拖垮。
   * 取消走的是 AbortController → 子进程收 SIGTERM，见 server/util.mjs 的 run()。
   *
   * @param {(job:object)=>boolean} [predicate] 默认：所有排队/运行中的任务
   * @returns {string[]} 被取消的任务 id
   */
  cancelWhere(predicate) {
    const cancelled = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' && job.status !== 'running') continue;
      if (predicate && !predicate(job)) continue;
      if (this.cancel(job.id)) cancelled.push(job.id);
    }
    return cancelled;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return false;
    job._cancelRequested = true;
    try { job.abort.abort(); } catch { /* ignore */ }
    if (job.status === 'queued') {
      const i = this.queue.indexOf(job);
      if (i >= 0) this.queue.splice(i, 1);
      job.status = 'cancelled';
      job.endedAt = nowIso();
      this.log(job, 'warn', '任务在排队中被取消');
      this.#emit(job, 'state');
    } else {
      // 立刻打上"正在取消"标记：真正停下要等子进程/浏览器退出（几十到几百毫秒），
      // 前端需要立刻把按钮切到"取消中"而不是继续显示"运行中"。
      job.cancelling = true;
      this.log(job, 'warn', '正在取消…（等待当前子进程退出）');
      this.#emit(job, 'state');
    }
    return true;
  }

  /** 等待任务结束（供同步接口使用）。 */
  waitFor(id, timeoutMs = 15 * 60 * 1000) {
    const job = this.jobs.get(id);
    if (!job) return Promise.resolve(null);
    if (['done', 'error', 'cancelled'].includes(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const t = setTimeout(() => { off(); resolve(job); }, timeoutMs);
      const off = this.subscribe(job, (event) => {
        if (event === 'state' && ['done', 'error', 'cancelled'].includes(job.status)) {
          clearTimeout(t);
          off();
          resolve(job);
        }
      }, { replay: false });
    });
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (job._cancelRequested) continue;
      this.running++;
      this.#run(job).finally(() => {
        this.running--;
        this.#pump();
      });
    }
    // 队列位置提示
    this.queue.forEach((j, i) => { j.queuePosition = i + 1; });
    for (const j of this.queue) this.#emit(j, 'state');
  }

  async #run(job) {
    job.status = 'running';
    job.startedAt = nowIso();
    job.queuePosition = 0;
    this.#emit(job, 'state');
    const t0 = Date.now();
    const ctx = {
      log: (level, msg) => this.log(job, level, msg),
      info: (msg) => this.log(job, 'info', msg),
      ok: (msg) => this.log(job, 'ok', msg),
      warn: (msg) => this.log(job, 'warn', msg),
      err: (msg) => this.log(job, 'err', msg),
      cmd: (msg) => this.log(job, 'cmd', msg),
      debug: (msg) => this.log(job, 'debug', msg),
      signal: job.abort.signal,
      jobId: job.id,
      job,
      progress: (pct, label, etaMs) => this.progress(job, pct, label, etaMs),
    };
    try {
      const result = await job._executor(ctx);
      job.artifacts = result?.artifacts || [];
      job.warnings = result?.warnings || [];
      job.errors = result?.errors || [];
      job.commands = result?.commands || [];
      job.stats = result?.stats || null;
      job.toc = result?.toc || null;
      job.workDir = result?.workDir || null;
      job.cancelling = false;
      job.status = job._cancelRequested ? 'cancelled' : 'done';
      job.progress = 1;
      if (job.status === 'cancelled') this.log(job, 'warn', '任务已取消');
      else this.log(job, 'ok', `完成：${job.artifacts.length} 个产物 · ${Date.now() - t0}ms`);
    } catch (err) {
      const aborted = err?.aborted || job.abort.signal.aborted || job._cancelRequested;
      job.cancelling = false;
      job.status = aborted ? 'cancelled' : 'error';
      job.error = aborted ? '任务已取消' : (err?.message || String(err));
      job.detail = err?.detail ? String(err.detail).slice(0, 8000) : null;
      if (err?.errors) job.errors = err.errors;
      if (!aborted) {
        this.log(job, 'err', `任务失败：${job.error}`);
        if (job.detail) for (const line of job.detail.split('\n')) this.log(job, 'err', `  ${line}`);
      } else {
        this.log(job, 'warn', '任务已取消');
      }
    } finally {
      job.endedAt = nowIso();
      job.elapsedMs = Date.now() - t0;
      this.#emit(job, 'state');
      // 任务结束后稍后释放订阅者，避免内存泄漏
      setTimeout(() => { job.subscribers.clear(); }, 60_000).unref?.();
    }
  }

  #emit(job, event, payload) {
    // 契约：'state' 事件**永远**携带完整的 publicView。
    // 曾经这里在 pump/cancel 路径上传的是 undefined，导致 SSE 出现
    // `data: undefined`——JSON.parse 直接抛错，客户端只能靠 catch 兜住。
    const data = event === 'state' && payload === undefined ? this.publicView(job) : payload;
    for (const fn of [...job.subscribers]) {
      try { fn(event, data); } catch { /* 客户端已断开 */ }
    }
    try { this.onUpdate(job, event); } catch { /* ignore */ }
  }

  #trim() {
    if (this.jobs.size <= MAX_JOBS) return;
    const finished = [...this.jobs.values()]
      .filter((j) => ['done', 'error', 'cancelled'].includes(j.status))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    while (this.jobs.size > MAX_JOBS && finished.length) {
      this.jobs.delete(finished.shift().id);
    }
  }

  stats() {
    const all = [...this.jobs.values()];
    return {
      total: all.length,
      running: all.filter((j) => j.status === 'running').length,
      queued: all.filter((j) => j.status === 'queued').length,
      done: all.filter((j) => j.status === 'done').length,
      failed: all.filter((j) => j.status === 'error').length,
      concurrency: this.concurrency,
    };
  }
}
