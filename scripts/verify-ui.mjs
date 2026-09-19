#!/usr/bin/env node
/**
 * scripts/verify-ui.mjs — AI 前端全链路（真实浏览器，mock 模式）
 *
 * 为什么单独成脚本：verify.mjs 覆盖渲染与导出，这里覆盖 AI 与配置安全。
 * 两者都必须在 mock 模式下可跑——没有 API 密钥也要能把整条链路验证到，
 * 否则"AI 功能"就成了无法回归的黑盒。
 */

import { startServer } from '../server/server.mjs';
import { ChromePool } from '../server/chrome.mjs';
const srv = await startServer({ port: 0, quiet: true, warmup: false, log: () => {} });
const B = srv.url;
// 打开 AI（mock 模式）：无需密钥即可跑通整条链路
await fetch(B + '/api/config', { method: 'PUT', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ ai: { enabled: true, mock: true, apiKey: '' } }) });

const pool = new ChromePool({ log: () => {} });
const page = await pool.newPage(); await page.init();
const errs = [];
page.cdp.on('Runtime.exceptionThrown', (p, sid) => { if (sid === page.sessionId) errs.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text); });
await page.setViewport(1560, 940, 1);
await page.goto(B + '/', 30000);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
await sleep(1800);

const doc = `# 二次型极值点

设 f 的梯度等于 A x 加 beta，且 A 为对称矩阵。

下面这个公式是坏的：$\\badcmd{1}$

还有一段需要润色的文字：这个  定理 的 证明 是 对 的
`;
await page.evaluate(`(() => { const n=Date.now();
  localStorage.setItem('mdp.studio.v2.docs', JSON.stringify([{id:'ai',name:'ai-test',content:${JSON.stringify(doc)},createdAt:n,updatedAt:n}]));
  localStorage.setItem('mdp.studio.v2.activeId', JSON.stringify('ai'));
  localStorage.setItem('mdp.studio.v2.ui', JSON.stringify({ appTheme:'dark', vim:false, showPreview:true, showConsole:false, showExport:true, showSide:true, sideTab:'outline', drawerTab:'output', editorFontSize:13.5, editorWrap:true, editorLineNumbers:true, previewZoom:'z-100', consoleHeight:168, sideWidth:262, drawerWidth:344, autoScrollConsole:true }));
  return 1; })()`);
await page.goto(B + '/', 30000);
await sleep(2000);

let pass = 0, fail = 0;
const chk = (ok, label, extra='') => { ok ? pass++ : fail++; console.log(`  ${ok?'✔':'✖'} ${label}${extra?'  '+extra:''}`); };

// 1) AI 入口就绪
const aiBtn = await page.evaluate(`document.querySelector('.topbar .btn[title*="AI"]')?.textContent?.trim()`);
chk(Boolean(aiBtn), `顶栏 AI 入口存在 (${aiBtn})`);
const st = await (await fetch(B + '/api/ai/status')).json();
chk(st.ready && st.mock, `后台 AI ready+mock`);

// 2) 公式错误块里有 AI 修复按钮
const fixBtns = await page.evaluate(`document.querySelectorAll('.err-fix-btn').length`);
chk(fixBtns > 0, `错误块含 AI 修复按钮 (${fixBtns} 个)`);

// 3) 选中文字 → 浮动工具条出现
await page.evaluate(`(() => { const v = window.__mdpBench.view();
  const text = v.state.doc.toString();
  const from = text.indexOf('f 的梯度'); const to = from + 'f 的梯度等于 A x 加 beta'.length;
  v.dispatch({ selection: { anchor: from, head: to } }); v.focus(); return 1; })()`);
await sleep(500);
const chips = await page.evaluate(`[...document.querySelectorAll('.ai-chip')].map(c=>c.textContent.trim())`);
chk(chips.length >= 2, `选区工具条浮出: ${JSON.stringify(chips)}`);

// 4) 点「公式」→ 流式结果卡片
await page.evaluate(`[...document.querySelectorAll('.ai-chip')].find(c=>c.textContent.includes('公式'))?.click()`);
await sleep(300);
const streamingSeen = await page.evaluate(`!!document.querySelector('.ai-card')`);
chk(streamingSeen, '结果卡片出现（流式中）');
await sleep(1200);
const cardText = await page.evaluate(`document.querySelector('.ai-card-body')?.textContent || ''`);
chk(cardText.includes('\\nabla') || cardText.includes('A'), `流式内容已到: ${JSON.stringify(cardText.slice(0,54))}`);
chk(await page.evaluate(`!!document.querySelector('.ai-card-preview .katex')`), '卡片里有 KaTeX 实时预览');

// 5) 替换选区 → 文档真的变了
const before = await page.evaluate(`window.__mdpBench.view().state.doc.toString()`);
await page.evaluate(`document.querySelector('.ai-card-foot .btn-primary')?.click()`);
await sleep(500);
const after = await page.evaluate(`window.__mdpBench.view().state.doc.toString()`);
chk(before !== after && after.includes('\\nabla'), `「替换选区」写回文档 (${before.length} → ${after.length} 字符)`);
chk(!(await page.evaluate(`!!document.querySelector('.ai-card')`)), '应用后卡片自动关闭');

// 6) 公式纠错：点错误块里的 AI 修复
await page.evaluate(`document.querySelector('.err-fix-btn')?.click()`);
await sleep(1500);
const fixText = await page.evaluate(`document.querySelector('.ai-card-body')?.textContent || ''`);
const fixLabel = await page.evaluate(`document.querySelector('.ai-card-head')?.textContent || ''`);
chk(fixLabel.includes('公式纠错'), `纠错卡片标题: ${fixLabel.slice(0,20)}`);
chk(fixText.length > 0, `纠错返回内容: ${JSON.stringify(fixText.slice(0,40))}`);
chk(await page.evaluate(`!!document.querySelector('.ai-card-note')`), '显示 explanation 说明');
await page.evaluate(`document.querySelector('.ai-card-head .btn')?.click()`);

// 7) 智能补全（无选区，光标处）
await page.evaluate(`(() => { const v = window.__mdpBench.view(); v.dispatch({ selection: { anchor: v.state.doc.length } }); return 1; })()`);
await sleep(300);
await page.evaluate(`window.dispatchEvent(new CustomEvent('mdp:ai', { detail: { kind: 'complete' } }))`);
await sleep(1400);
const compText = await page.evaluate(`document.querySelector('.ai-card-body')?.textContent || ''`);
chk(compText.length > 0, `智能补全返回: ${JSON.stringify(compText.slice(0,40))}`);

// 8) AI 设置弹窗
await page.evaluate(`document.querySelector('.ai-card-head .btn')?.click()`);
await sleep(200);
await page.evaluate(`window.dispatchEvent(new CustomEvent('mdp:ai', { detail: { kind: 'settings' } }))`);
await sleep(400);
const modalTitle = await page.evaluate(`document.querySelector('.modal-head')?.textContent || ''`);
chk(modalTitle.includes('AI 设置'), `设置弹窗可打开: ${modalTitle.slice(0,16)}`);
const hasKeyField = await page.evaluate(`!!document.querySelector('.modal input[type=password]')`);
chk(hasKeyField, '含密钥输入框');
const modelOpts = await page.evaluate(`[...document.querySelectorAll('.modal select')].map(s=>s.options.length).join('/')`);
chk(modelOpts.startsWith('4'), `模型下拉有 4 个现行模型 (${modelOpts})`);

console.log(`\n页面异常: ${errs.length ? errs.slice(0,2) : '无'}`);
console.log(`结果：${pass} 通过${fail?` · ${fail} 失败`:''}`);
await page.close(); await pool.close(); await srv.close();
process.exit(fail ? 1 : 0);
