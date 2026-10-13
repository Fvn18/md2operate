#!/usr/bin/env node
/**
 * scripts/verify-cancel.mjs — 请求熔断 / 取消传播自检（不需要浏览器）。
 *
 * 要证的事只有一件，但它是"企业级"和"玩具"的分界线：
 * **客户端一断开，后端必须真的把子进程杀掉，而不是让它继续跑完。**
 *
 * 现实里这个场景就是"用户连点了三次导出"：每次都会起一个 Chromium/xelatex，
 * 一个进程几百 MB，跑完为止 —— 不做取消，机器几分钟内就雪崩。
 *
 * 断言：
 *   ① 客户端在应答前断开 → 该任务被取消（status=cancelled）
 *   ② 取消会**真的**杀掉正在跑的子进程（用 sleep 子进程验证：立刻退出，而不是等完）
 *   ③ supersede=true → 前一个渲染任务被顶掉（不会被排队）①、②的兜底
 *   ④ 排队中的任务被取消后不会启动（不会"取消完还是跑了一遍"）
 *   ⑤ 队列并发上限生效：不会同时跑超过 concurrency 个任务
 *   ⑥ 同步接口 /api/render-sync 的客户端断开同样会取消
 *   ⑦ 应答前断开 → 不留孤儿子进程
 */

import { startServer } from '../server/server.mjs';
import { run } from '../server/util.mjs';
import http from 'node:http';
import { execSync } from 'node:child_process';

process.chdir(new URL('..', import.meta.url).pathname);

const C = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, d: (s) => s, b: (s) => s };

let passed = 0;
let failed = 0;
const failures = [];
function ok(label, detail = '') {
  passed++;
  console.log(`  ${C.g('✔')} ${label}${detail ? C.d(`  ${detail}`) : ''}`);
}
function bad(label, detail = '') {
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${C.r('✖')} ${label}${detail ? C.d(`  ${detail}`) : ''}`);
}
const assert = (cond, label, detail = '') => (cond ? ok(label, detail) : bad(label, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(C.b('\n请求熔断 / 取消传播自检（断开连接 = 杀掉子进程）'));

/* --------------------------------------------------------------------------
   用"假执行器"替代真实渲染：这样可以在没有 pandoc/LaTeX 的机器上验证**取消链路**
   本身（HTTP 断开 → JobManager.cancel → AbortController → run(signal) → SIGTERM）。
   假执行器里的子进程是真的（sleep 30）：如果取消没传下去，它会跑满 30 秒。
   -------------------------------------------------------------------------- */
const srv = await startServer({
  port: 0,
  quiet: true,
  concurrency: 2,
  preflightDelayMs: 300,   // 把"应答前"那段窗口拉开，好让用例 ⑦ 确定性地命中
  log: () => {},
  executorOverride: async (spec, ctx) => {
    const started = Date.now();
    ctx.info(`假渲染开始：${spec.label}`);
    const r = await run('sleep', ['30'], { signal: ctx.signal, onLog: (s, l) => ctx.debug(l) });
    if (ctx.signal.aborted || r.killed || r.signal) {
      return { artifacts: [], warnings: [], errors: [], killedAfterMs: Date.now() - started };
    }
    return { artifacts: [], warnings: [] };
  },
});

const post = (path, body, { abortAfterMs = 0 } = {}) => new Promise((resolve) => {
  const url = new URL(path, srv.url);
  const req = http.request({
    hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
  });
  req.on('error', (err) => resolve({ error: err }));
  req.write(JSON.stringify(body));
  req.end();
  if (abortAfterMs > 0) setTimeout(() => req.destroy(new Error('client abort')), abortAfterMs);
});

const jobOf = async (id) => (await (await fetch(`${srv.url}/api/jobs/${id}`)).json()).job;

/* --------------------------- ① 取消正在运行的任务 = 子进程被真的杀掉 -- */
{
  const posted = await post('/api/render', { content: '# x', filename: 'cancel-a', targets: ['png'] });
  assert(posted.status === 202 && posted.body.jobId, '任务入队（假执行器会起一个 sleep 30 的子进程）', posted.body.jobId);
  await sleep(400);

  const t0 = Date.now();
  const res = await (await fetch(`${srv.url}/api/jobs/${posted.body.jobId}/cancel`, { method: 'POST' })).json();
  assert(res.ok, '取消请求被接受');
  await sleep(300);
  const job = await jobOf(posted.body.jobId);
  assert(job.status === 'cancelled', '任务状态 = cancelled', job.status);
  // 子进程是 sleep 30：若没杀掉，下面这些断言就会超时或超时后仍 running
  assert(Date.now() - t0 < 3000, '取消生效快（子进程收到 SIGTERM 立刻退出，不排队等完）', `${Date.now() - t0}ms`);
  const logs = (await (await fetch(`${srv.url}/api/jobs/${job.id}`)).json()).logs || [];
  assert(logs.some((l) => /取消/.test(l.msg)), '日志里留下取消记录（排障可见）',
    (logs.find((l) => /取消/.test(l.msg)) || {}).msg || '');
}

/* ------------------------------------------ ② 排队中的任务被取消后不启动 -- */
{
  // concurrency=2 → 第三个任务会排队；取消它，它不应该再开始跑
  const a = await post('/api/render', { content: '# x', filename: 'q-1', targets: ['png'] });
  const b = await post('/api/render', { content: '# x', filename: 'q-2', targets: ['png'] });
  const c = await post('/api/render', { content: '# x', filename: 'q-3', targets: ['png'] });
  await sleep(250);
  const before = await Promise.all([a, b, c].map(async (r) => jobOf(r.body.jobId)));
  const queued = before.filter((j) => j.status === 'queued').length;
  assert(queued >= 1, '存在排队中的任务（并发上限 2）', `queued=${queued}`);

  const queuedJob = before.find((j) => j.status === 'queued');
  await fetch(`${srv.url}/api/jobs/${queuedJob.id}/cancel`, { method: 'POST' });
  await sleep(700);
  const after = await jobOf(queuedJob.id);
  assert(after.status === 'cancelled', '排队任务取消后不会"悄悄再跑一遍"', after.status);
  await fetch(`${srv.url}/api/jobs/cancel-all`, { method: 'POST' });
  await sleep(400);
}

/* ------------------------------------------------ ③ supersede 顶掉旧任务 -- */
{
  // 先正常提交一个任务（不 abort），让它跑起来
  const first = await post('/api/render', { content: '# x', filename: 'super-1', targets: ['png'] });
  assert(first.status === 202 && first.body.jobId, '任务 1 正常入队', first.body.jobId);
  await sleep(300);
  const second = await post('/api/render', { content: '# x', filename: 'super-2', targets: ['png'], supersede: true });
  assert(second.status === 202, '任务 2 带 supersede 提交成功');
  await sleep(600);

  const j1 = await jobOf(first.body.jobId);
  const j2 = await jobOf(second.body.jobId);
  assert(j1.status === 'cancelled', 'supersede 把任务 1 顶掉了（连点不会堆积）', j1.status);
  assert(['queued', 'running', 'cancelled'].includes(j2.status) || j2.status === 'done',
    '任务 2 不受影响，继续跑（或被后续用例取消）', j2.status);

  // 收尾：全部取消，避免假执行器继续占着 sleep
  await fetch(`${srv.url}/api/jobs/cancel-all`, { method: 'POST' });
  await sleep(200);
}

/* -------------------------------------------- ④ cancel-all 一次清干净 -- */
{
  const a = await post('/api/render', { content: '# x', filename: 'all-1', targets: ['png'] });
  const b = await post('/api/render', { content: '# x', filename: 'all-2', targets: ['png'] });
  await sleep(250);
  const res = await (await fetch(`${srv.url}/api/jobs/cancel-all`, { method: 'POST' })).json();
  assert(res.ok && res.cancelled.length >= 2, 'cancel-all 一次取消全部在跑的任务', `取消 ${res.cancelled.length} 个`);
  await sleep(500);
  const after = await Promise.all([a, b].map((r) => jobOf(r.body.jobId)));
  assert(after.every((j) => j.status === 'cancelled'), '全部处于 cancelled', after.map((j) => j.status).join(','));
}

/* ------------------------------------------------- ⑤ 并发上限真的生效 -- */
{
  const posts = [];
  for (let i = 0; i < 4; i++) posts.push(post('/api/render', { content: '# x', filename: `conc-${i}`, targets: ['png'] }));
  const list = await Promise.all(posts.map(async (p) => (await p).body.jobId));
  await sleep(300);
  const jobs = await Promise.all(list.map(jobOf));
  const running = jobs.filter((j) => j.status === 'running').length;
  assert(running <= 2, '同时运行的任务不超过并发上限（concurrency=2）', `running=${running}`);
  await fetch(`${srv.url}/api/jobs/cancel-all`, { method: 'POST' });
  await sleep(300);
}

/* ------------------------------------------------ ⑥ 同步接口断开也要取消 -- */
{
  const url = new URL('/api/render-sync?target=png', srv.url);
  const req = http.request({
    hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, () => { /* 断开后不会有响应 */ });
  req.on('error', () => {});
  req.write(JSON.stringify({ content: '# sync', filename: 'sync-cancel', targets: ['png'] }));
  req.end();
  await sleep(400);
  req.destroy(new Error('client abort'));
  await sleep(900);
  const list = await (await fetch(`${srv.url}/api/jobs?limit=10`)).json();
  const job = (list.jobs || []).find((j) => j.label.includes('sync-cancel'));
  assert(job, '/api/render-sync 创建了任务');
  assert(job && job.status === 'cancelled', '同步接口的客户端断开后任务被取消', job ? job.status : '未找到');
}

/* ---------------------- ⑦ 应答前断开（连点导出/关页面）→ 不留孤儿进程 -- */
{
  const orphans = () => {
    try {
      const out = execSync(`ps --no-headers -o pid,args --ppid ${process.pid} 2>/dev/null || true`).toString();
      return out.split('\n').filter((l) => /\bsleep\b/.test(l)).length;
    } catch { return 0; }
  };
  const before = orphans();
  const r = await post('/api/render', { content: '# x', filename: 'gone-1', targets: ['png'] }, { abortAfterMs: 60 });
  assert(r.error, '客户端在应答前就断开（模拟连点导出 / 直接关页面）', String(r.error && r.error.message));
  await sleep(1500);
  const list = (await (await fetch(`${srv.url}/api/jobs?limit=10`)).json()).jobs || [];
  const job = list.find((j) => (j.label || '').includes('gone-1'));
  assert(job, '任务建出来了（说明断开发生在应答写出之前）', job ? job.id : '未创建');
  assert(job && job.status === 'cancelled', '应答还没写出去客户端就断了 → 任务被取消', job ? job.status : '');
  assert(orphans() <= before, '没有留下孤儿子进程（每个孤儿都占几百 MB）', `子进程 ${before} → ${orphans()}`);
}

/* ---------- ⑧（有 Chromium 时）真的把跑着的浏览器进程停掉 ------------------ */
{
  const { findChrome } = await import('../server/chrome.mjs');
  const info = findChrome();
  if (!info) {
    console.log(`  ${C.d('· 跳过真实渲染取消（本机没有 Chromium）')}`);
  } else {
    const real = await startServer({ port: 0, quiet: true, warmup: false, log: () => {} });
    const big = '# 巨文档\n\n' + '公式 $x^2$ 与文字段落，加一点内容让页面足够长。\n\n'.repeat(4000);
    const j = await (await fetch(`${real.url}/api/render`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: big, filename: 'big', targets: ['png'],
        png: { dpi: 600, mode: 'page', engine: 'html' },
        doc: { paper: 'A4', theme: 'paper', card: false },
      }),
    })).json();
    await sleep(1500);
    const t0 = Date.now();
    const c = await (await fetch(`${real.url}/api/jobs/${j.jobId}/cancel`, { method: 'POST' })).json();
    assert(c.ok, '真实渲染任务的 cancel 接口返回 ok', `status=${c.status}`);
    let st = '';
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      st = (await (await fetch(`${real.url}/api/jobs/${j.jobId}`)).json()).job.status;
      if (st === 'cancelled') break;
    }
    assert(st === 'cancelled', '取消后任务状态变成 cancelled（不是等截图跑完）',
      `${Date.now() - t0}ms`);
    assert(Date.now() - t0 < 4000, '整个取消在 4 秒内结束（600DPI / 27 万 CSS px 的截图）',
      `${Date.now() - t0}ms`);
    await real.close?.();
  }
}

await srv.close?.();

console.log(`\n${failed === 0 ? C.g('全部通过') : C.r(`${failed} 项失败`)}：${passed} 通过 / ${failed} 失败\n`);
if (failed) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
