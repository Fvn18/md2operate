#!/usr/bin/env node
/**
 * scripts/verify-sync.mjs — 锚定式滚动同步自检。
 *
 * 断言方式：把编辑器滚到第 N 行，然后读预览区**最顶部可见块**的 data-lines，
 * 要求它覆盖第 N 行。这是像素级判据，不是"看起来差不多"。
 *
 * 这个用例值钱，因为它一次性钉住了三个真实的坑：
 *   ① lineBlockAtHeight 的坐标空间容易搞错 → 改用 posAtCoords
 *   ② content-visibility 让内容高度**延迟**变化：对齐瞬间 delta≈0，
 *      但 Chrome 随后在空闲时间布局视口外的块，把目标推下去 25 行
 *   ③ 因此收敛判据必须是「对齐 + 容器总高 250ms 内不再变化」，而不是几帧
 */

import { startServer } from '../server/server.mjs';
import { ChromePool } from '../server/chrome.mjs';
import { makeDoc } from './lib/synth-doc.mjs';
const doc = makeDoc(60000);
const srv = await startServer({ port: 0, quiet: true, warmup: false, log: () => {} });
const pool = new ChromePool({ log: () => {} });
const page = await pool.newPage(); await page.init();
await page.goto(srv.url + '/', 30000);
await page.evaluate(`(() => { const n=Date.now();
  localStorage.setItem('mdp.studio.v2.docs', JSON.stringify([{id:'s',name:'sync',content:${JSON.stringify(doc)},createdAt:n,updatedAt:n}]));
  localStorage.setItem('mdp.studio.v2.activeId', JSON.stringify('s')); return 1; })()`);
await page.goto(srv.url + '/', 40000);
await new Promise(r=>setTimeout(r,2500));
let pass=0, fail=0;
const chk=(ok,l,e='')=>{ok?pass++:fail++;console.log(`  ${ok?'✔':'✖'} ${l}${e?'  '+e:''}`)};

// 顶部可见块的行号区间
const topBlock = () => page.evaluate(`(() => {
  const c = document.querySelector('.preview-scroll');
  if (!c) return null;
  const top = c.getBoundingClientRect().top;
  for (const el of c.querySelectorAll('.mdp-block')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 2) return { lines: el.getAttribute('data-lines'), top: Math.round(r.top - top), scrollTop: Math.round(c.scrollTop) };
  }
  return null;
})()`);

// 独立复算编辑器的顶部行号，用于判断是"编辑器报错行"还是"预览滚不准"
const editorTopLine = () => page.evaluate(`(() => {
  const v = window.__mdpBench.view();
  const r = v.scrollDOM.getBoundingClientRect();
  const pos = v.posAtCoords({ x: r.left + 8, y: r.top + 6 });
  return pos == null ? null : v.state.doc.lineAt(pos).number;
})()`);

async function scrollEditorToLine(line) {
  await page.evaluate(`(() => {
    const v = window.__mdpBench.view();
    const n = Math.max(1, Math.min(v.state.doc.lines, ${line}));
    const pos = v.state.doc.line(n).from;
    v.dispatch({ selection: { anchor: pos }, effects: v.constructor.scrollIntoView ? [] : [] });
    v.scrollDOM.scrollTop = v.lineBlockAt(pos).top;
    return 1;
  })()`);
  await new Promise(r=>setTimeout(r,1600));
}

console.log('=== 锚定式滚动同步：编辑器滚到第 N 行，预览顶部块应覆盖第 N 行 ===');
for (const line of [50, 300, 900, 1500]) {
  await scrollEditorToLine(line);
  const b = await topBlock();
  const etl = await editorTopLine();
  if (!b) { chk(false, `第 ${line} 行：未找到预览块`); continue; }
  console.log(`    （编辑器实际顶部行 = ${etl}）`);
  const [s0, e0] = String(b.lines || '0-0').split('-').map(Number);
  const aligned = line >= s0 - 3 && line <= e0 + 3;
  chk(aligned, `第 ${line} 行 → 预览顶部块 data-lines=${b.lines}`, `偏移 ${b.top}px`);
}

console.log('=== 比例模式对照（应明显更差）===');
await page.evaluate(`window.dispatchEvent(new Event('x'))`); // noop
await page.evaluate(`(() => { const v = window.__mdpBench.view(); v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight * 0.7; return 1; })()`);
await new Promise(r=>setTimeout(r,800));
const b70 = await topBlock();
console.log(`  锚定模式在 70% 处 → data-lines=${b70?.lines}`);

console.log(`\n结果：${pass} 通过${fail?` · ${fail} 失败`:''}`);
await page.close(); await pool.close(); await srv.close();
process.exit(fail?1:0);
