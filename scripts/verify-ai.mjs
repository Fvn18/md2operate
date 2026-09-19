#!/usr/bin/env node
/**
 * scripts/verify-ai.mjs — AI 代理与配置安全（API 级，mock 模式，无需密钥）
 *
 * 为什么单独成脚本：verify.mjs 覆盖渲染与导出，这里覆盖 AI 与配置安全。
 * 两者都必须在 mock 模式下可跑——没有 API 密钥也要能把整条链路验证到，
 * 否则"AI 功能"就成了无法回归的黑盒。
 */

import { startServer } from '../server/server.mjs';
const srv = await startServer({ port: 0, quiet: true, warmup: false, log: () => {} });
const B = srv.url;
const j = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t }; }
};
let pass = 0, fail = 0;
const chk = (ok, label, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✔' : '✖'} ${label}${extra ? '  ' + extra : ''}`); };

console.log('=== 1. 配置：密钥必须永不回传 ===');
await j('PUT', '/api/config', { ai: { enabled: true, mock: true, apiKey: 'SECRET-TEST-KEY-12345' } });
const cfg = await j('GET', '/api/config');
const raw = JSON.stringify(cfg.json);
chk(!raw.includes('SECRET-TEST-KEY-12345'), '响应里不含密钥明文');
chk(cfg.json.ai.apiKeySet === true, '只暴露 apiKeySet=true');
chk(cfg.json.ai.apiKeySource === 'config', `来源标记正确 (${cfg.json.ai.apiKeySource})`);
chk(typeof cfg.json.path === 'string' && cfg.json.path.length > 0, `配置文件路径 ${cfg.json.path}`);

console.log('=== 2. AI 状态 ===');
const st = await j('GET', '/api/ai/status');
chk(st.json.enabled === true && st.json.ready === true, `enabled/ready (mock=${st.json.mock})`);
chk(st.json.model === 'gemini-3.8-flash', `模型 ${st.json.model}`);

console.log('=== 3. 流式任务：SSE 增量 ===');
async function sse(task, body) {
  const r = await fetch(`${B}/api/ai/${task}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.headers.get('content-type')?.includes('text/event-stream')) return { error: `content-type=${r.headers.get('content-type')}` };
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', events = [], done = null;
  for (;;) {
    const { value, done: d } = await reader.read(); if (d) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const blk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event:\s*(\S+)/.exec(blk)?.[1]; const da = /data:\s*(.*)/.exec(blk)?.[1];
      if (!ev) continue; events.push(ev);
      if (da) { const o = JSON.parse(da); if (ev === 'delta') text += o.text; if (ev === 'done') done = o; if (ev === 'error') done = o; }
    }
  }
  return { events, text, done };
}
const f = await sse('formula', { text: '二次型 f 的梯度等于 A x 加 beta' });
chk(f.events?.[0] === 'start', `首个事件 start`);
chk((f.events || []).includes('delta') && f.text.length > 0, `收到 ${(f.events||[]).filter(e=>e==='delta').length} 个 delta，拼接出 ${f.text.length} 字符`);
chk((f.events || []).includes('done'), '有 done 结束事件');
chk((f.text || '').includes('\\nabla') || f.text.includes('A'), `内容合理: ${JSON.stringify((f.text||'').slice(0,50))}`);

const c = await sse('complete', { before: '# 标题\n\n设 $f$ 为二次型，', after: '' });
chk(c.events?.[0] === 'start' && c.text.length > 0, `补全流式 OK (${c.text.length} 字符)`);
const p = await sse('polish', { text: '这个  定理 的 证明 是 对 的' });
chk(p.text.includes('已润色'), `润色走 mock 分支: ${JSON.stringify(p.text.slice(0,40))}`);

console.log('=== 4. 结构化任务 ===');
const img = await j('POST', '/api/ai/image', { image: 'aGVsbG8=', mimeType: 'image/png' });
chk(img.status === 200 && typeof img.json.structured?.latex === 'string', `截图转公式返回 latex: ${JSON.stringify(img.json.structured?.latex || '').slice(0,60)}`);
chk(img.json.structured?.display === true, 'display 字段存在且为布尔');
const fx = await j('POST', '/api/ai/fix', { tex: '\\frac{a}{b}', error: 'KaTeX parse error' });
chk(fx.status === 200 && typeof fx.json.structured?.fixed === 'string', `纠错返回 fixed: ${JSON.stringify(fx.json.structured?.fixed||'').slice(0,50)}`);
chk(typeof fx.json.structured?.explanation === 'string', '纠错返回 explanation');

console.log('=== 5. 护栏 ===');
const bad = await j('POST', '/api/ai/nosuchtask', {});
chk(bad.status === 404, `未知任务 → 404 (${bad.status})`);
const huge = await j('POST', '/api/ai/formula', { text: 'x'.repeat(5000) });
chk(huge.status === 413, `超长输入 → 413 (${huge.status})`);
await j('PUT', '/api/config', { ai: { tasks: { polish: false } } });
const off = await j('POST', '/api/ai/polish', { text: 'abc' });
chk(off.status === 409, `单项关闭后 → 409 (${off.status})`);
await j('PUT', '/api/config', { ai: { tasks: { polish: true } } });
await j('PUT', '/api/config', { ai: { enabled: false } });
const disabled = await j('POST', '/api/ai/formula', { text: 'x' });
chk(disabled.status === 409, `总开关关闭 → 409 (${disabled.status})`);

console.log(`\n结果：${pass} 通过${fail ? ` · ${fail} 失败` : ''}`);
await srv.close();
process.exit(fail ? 1 : 0);
