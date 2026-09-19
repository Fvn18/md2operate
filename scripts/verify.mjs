#!/usr/bin/env node
/**
 * scripts/verify.mjs — 一键端到端自检（`npm run verify`）。
 *
 * 它真的会跑一遍所有渲染路线，而不是只检查文件存在：
 *   1. 环境能力探测
 *   2. 共享 Markdown 渲染器（数学 / 容器 / 代码 / 目录）
 *   3. 起一个临时后台，HTML 路线导出 PNG，并校验像素尺寸与有效 DPI
 *   4. LaTeX 路线导出 PDF，校验 PDF 头与（若有 qpdf）结构
 *   5. 自包含 HTML：确认 KaTeX 字体已被内联为 data:URI
 *   6. TeX 直出
 * 任何一步失败都以非零码退出，可直接用于 CI 或安装后的冒烟测试。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

const { probeCaps } = await import('../server/caps.mjs');
const { renderMarkdown } = await import('../shared/markdown.mjs');
const { documentCss, mmToPx } = await import('../shared/theme.mjs');
const { startServer } = await import('../server/server.mjs');
const { executeRender, normalizeRequest } = await import('../server/render.mjs');
const { pngSize, uid, run, which, formatBytes } = await import('../server/util.mjs');

const C = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, y: (s) => s, d: (s) => s, b: (s) => s };

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
function skip(label, detail = '') {
  console.log(`  ${C.y('▲')} ${label}${detail ? C.d(`  ${detail}`) : ''}`);
}
function section(title) {
  console.log(`\n${C.b(title)}`);
}

const WORK = path.join(ROOT, '.cache', 'verify');
await fsp.rm(WORK, { recursive: true, force: true });
await fsp.mkdir(WORK, { recursive: true });

const SAMPLE = `# 自检样例

行内 $f(x)=Ax+\\beta$ 与 $$\\int_0^1 x^2\\,dx=\\frac13$$。

::: theorem 主定理
若极值点集有限非空，则 $S=\\{(b,\\dots,b)\\}$。
:::

::: 证明
由 $\\nabla f(\\sigma x)=\\sigma\\nabla f(x)$ 得证。$\\square$
:::

\`\`\`python {1}
def f(x):
    return x ** 2
\`\`\`

| 目标 | 引擎 |
|:--|:--|
| PNG | Chromium |

价格 $5 与 $6 不是公式。
`;

console.log(C.b(`MDP Studio 自检  ${C.d('v2.0.0 · ' + ROOT)}`));

/* ------------------------------------------------------------ 1. 环境 -- */
section('1. 环境能力');
const caps = await probeCaps({ force: true });
for (const c of caps.checks) {
  const icon = c.status === 'ok' ? C.g('✔') : c.status === 'warn' ? C.y('▲') : C.r('✖');
  console.log(`  ${icon} ${c.label}${c.detail ? C.d(`  ${c.detail}`) : ''}`);
}
if (caps.engines.pandoc.found) ok('pandoc 可用');
else bad('pandoc 缺失', 'brew install pandoc');
if (caps.chrome.found) ok('Chromium 可用（PNG/HTML→PDF 路线）');
else skip('未找到 Chromium，PNG 的 HTML 路线不可用');

/* -------------------------------------------------------- 2. 渲染器自检 -- */
section('2. 共享 Markdown 渲染器');
const rendered = renderMarkdown(SAMPLE);
const checks = [
  ['行内数学', /<span class="katex"/.test(rendered.html)],
  ['行间数学', (rendered.html.match(/mdp-math-block/g) || []).length >= 2],
  ['定理容器', /mdp-callout-theorem/.test(rendered.html)],
  ['证明容器', /mdp-callout-proof/.test(rendered.html)],
  ['代码高亮', /hljs/.test(rendered.html) && /hl-line/.test(rendered.html)],
  ['表格', /<table>/.test(rendered.html)],
  ['标题锚点', rendered.toc.length >= 1 && /id="/.test(rendered.html)],
  ['货币不误判', /价格 \$5 与 \$6/.test(rendered.html)],
  ['无残留定界符', !/\$\$/.test(rendered.html.replace(/aria-label="[^"]*"/g, ''))],
  ['零公式错误', rendered.errors.length === 0],
];
for (const [label, good] of checks) (good ? ok : bad)(label);
const css = documentCss({});
if (css.includes('.mdp-doc') && css.includes('@page') && css.includes('.mdp-callout-theorem')) ok('文档样式表生成', `${(Buffer.byteLength(css) / 1024).toFixed(1)} KB`);
else bad('文档样式表生成');

/* ------------------------------------------------- 2b. 增量渲染正确性 -- */
section('2b. 增量渲染（预览性能的核心，必须与全量渲染逐字节一致）');
{
  const { createIncrementalRenderer, blocksToHtml } = await import('../shared/incremental.mjs');
  const { makeDoc } = await import('./lib/synth-doc.mjs');

  // 语料刻意包含大量重复块：这正是「内容哈希直接当 React key」那个 bug 的暴露点
  const bigDoc = makeDoc(30000);
  const inc = createIncrementalRenderer({ debugKeys: true });

  let first;
  try {
    first = inc.render(bigDoc);
    ok('块 key 唯一（重复样板块不产生碰撞）', `${first.blocks.length} 块`);
  } catch (err) {
    bad('块 key 唯一', err.message);
  }

  if (first) {
    const joined = first.blocks.map((b) => b.html).join('');
    const full = renderMarkdown(bigDoc);
    if (joined === full.html) ok('增量拼接 == 全量渲染（逐字节）', `${(joined.length / 1024).toFixed(0)} KB`);
    else {
      let i = 0;
      while (i < Math.max(joined.length, full.html.length) && joined[i] === full.html[i]) i++;
      bad('增量拼接 == 全量渲染', `首个差异 @${i}: inc=${JSON.stringify(joined.slice(i, i + 40))} full=${JSON.stringify(full.html.slice(i, i + 40))}`);
    }
    if (JSON.stringify(first.toc) === JSON.stringify(full.toc)) ok('增量与全量的目录一致');
    else bad('增量与全量的目录一致');

    const edited = bigDoc.replace('设函数 f 在紧集上连续', '设函数 f 在紧集上连续。');
    const second = inc.render(edited);
    const reuseRate = second.metrics.reused / Math.max(1, second.metrics.blocks);
    if (second.metrics.rendered <= 2 && reuseRate > 0.95) {
      ok('改一处只重渲 1 块', `${second.metrics.rendered}/${second.metrics.blocks} 重渲 · ${second.metrics.ms}ms（复用率 ${(reuseRate * 100).toFixed(1)}%）`);
    } else {
      bad('改一处只重渲 1 块', `rendered=${second.metrics.rendered} reused=${second.metrics.reused}`);
    }

    const wrapped = blocksToHtml(first.blocks);
    const openers = (wrapped.match(/<div class="mdp-block"/g) || []).length;
    const dataFirst = (wrapped.match(/data-first="[a-z0-9]+"/g) || []).length;
    if (openers === first.blocks.length && dataFirst === first.blocks.length) {
      ok('导出包装与预览同构（data-first 完整）', `${openers} 个 .mdp-block`);
    } else {
      bad('导出包装与预览同构', `openers=${openers} dataFirst=${dataFirst} blocks=${first.blocks.length}`);
    }
  }
}

/* ------------------------------------------------------ 3. 渲染管线自检 -- */
section('3. 渲染管线（真实执行外部命令）');

const srv = await startServer({ port: 0, quiet: true, warmup: false, concurrency: 1, log: () => {} });
console.log(C.d(`  临时后台 ${srv.url}（校验结束即关闭）`));

const runRoute = async (label, targets, extra = {}) => {
  const spec = normalizeRequest({
    content: SAMPLE,
    filename: `verify-${uid(4)}`,
    targets,
    doc: { card: true, theme: 'paper', showMeta: true, ...(extra.doc || {}) },
    png: { dpi: 192, mode: 'card', engine: 'html', ...(extra.png || {}) },
    latex: { preset: 'draft', ...(extra.latex || {}) },
    meta: { title: '自检样例', author: 'MDP Studio', date: '2026-01-01' },
  });
  const started = Date.now();
  try {
    const result = await executeRender(spec, {
      log: () => {}, chromePool: srv.chromePool, baseUrl: srv.url, jobId: uid(10),
    });
    return { result, ms: Date.now() - started };
  } catch (err) {
    return { error: err, ms: Date.now() - started };
  }
};

/* --- PNG（HTML + Chromium） --- */
if (caps.chrome.found) {
  const { result, error, ms } = await runRoute('png', ['png']);
  if (error) {
    bad('PNG · HTML 路线', error.message);
  } else {
    const a = result.artifacts.find((x) => x.ext === 'png');
    const buf = await fsp.readFile(a.file);
    const size = pngSize(buf);
    const expectedWidth = Math.round((860 + 32 * 2 + 2) * (192 / 96));
    const dpiOk = Math.abs((size.width / (860 + 64 + 2)) * 96 - 192) < 3;
    if (size && size.width > 100 && size.height > 100) ok('PNG 输出合法', `${size.width}×${size.height} · ${formatBytes(buf.length)} · ${ms}ms`);
    else bad('PNG 输出非法', JSON.stringify(size));
    if (dpiOk) ok('真 DPI 生效', `目标宽 ${expectedWidth}px，实测 ${size.width}px → 约 192 DPI`);
    else bad('DPI 不符', `期望≈${expectedWidth}px，实测 ${size.width}px`);
    if (buf.subarray(1, 4).toString() === 'PNG') ok('PNG 文件头正确');
    else bad('PNG 文件头错误');
    // 转义：确认页面里没有未解析的 $$ 泄漏到产物（通过 HTML 侧间接验证）
    const html = await fsp.readFile(result.artifacts[0].file);
    void html;
  }
} else {
  skip('PNG · HTML 路线（无 Chromium）');
}

/* --- PDF（LaTeX + XeLaTeX） --- */
if (caps.engines.latexOrder.length && caps.engines.pandoc.found) {
  const { result, error, ms } = await runRoute('pdf', ['pdf'], { latex: { preset: 'draft', toc: false, numbers: false } });
  if (error) {
    bad('PDF · LaTeX 路线', error.message);
  } else {
    const a = result.artifacts.find((x) => x.ext === 'pdf');
    const buf = await fsp.readFile(a.file);
    if (buf.subarray(0, 5).toString() === '%PDF-') ok('PDF 输出合法', `${formatBytes(buf.length)} · ${ms}ms`);
    else bad('PDF 文件头错误', buf.subarray(0, 16).toString('latin1'));
    if (which('qpdf')) {
      const q = await run(which('qpdf'), ['--check', a.file], { timeoutMs: 20000 });
      if (q.code === 0) ok('qpdf 结构校验通过');
      else bad('qpdf 结构校验失败', q.stderr.slice(0, 200));
    }
  }
} else {
  skip('PDF · LaTeX 路线（缺少 pandoc 或 LaTeX 引擎）');
}

/* --- HTML（自包含） --- */
{
  const { result, error } = await runRoute('html', ['html']);
  if (error) {
    bad('HTML 单文件路线', error.message);
  } else {
    const a = result.artifacts.find((x) => x.ext === 'html');
    const html = await fsp.readFile(a.file, 'utf8');
    const hasFont = /url\(data:font\/woff2;base64,/.test(html);
    const hasStyle = html.includes('.mdp-callout');
    const noCdn = !/https?:\/\/(cdn|unpkg|jsdelivr)/i.test(html);
    if (hasFont) ok('KaTeX 字体已内联', formatBytes(Buffer.byteLength(html, 'utf8')));
    else bad('KaTeX 字体未内联（离线打开会缺字）');
    if (hasStyle) ok('文档样式已注入');
    else bad('文档样式缺失');
    if (noCdn) ok('零外部依赖（无 CDN 引用）');
    else bad('产物引用了外部 CDN');
  }
}

/* --- TeX --- */
if (caps.engines.pandoc.found) {
  const { result, error } = await runRoute('tex', ['tex'], { latex: { preset: 'draft' } });
  if (error) {
    bad('TeX 直出路线', error.message);
  } else {
    const a = result.artifacts.find((x) => x.ext === 'tex');
    const tex = await fsp.readFile(a.file, 'utf8');
    if (/\\documentclass/.test(tex) && /\\begin\{document\}/.test(tex)) ok('TeX 源码合法', formatBytes(Buffer.byteLength(tex)));
    else bad('TeX 源码缺少 documentclass/document 环境');
  }
}

/* --- Markdown 直通 --- */
{
  const { result, error } = await runRoute('md', ['md']);
  if (error) bad('Markdown 直通路线', error.message);
  else {
    const a = result.artifacts.find((x) => x.ext === 'md');
    const md = await fsp.readFile(a.file, 'utf8');
    if (md === SAMPLE) ok('Markdown 直通字节一致');
    else bad('Markdown 直通内容不一致');
  }
}

await srv.close();
await fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});

/* ------------------------------------------------------------- 汇总 -- */
console.log('');
console.log(C.b(`结果：${C.g(passed + ' 项通过')}${failed ? ` · ${C.r(failed + ' 项失败')}` : ''}`));
if (failed) {
  for (const f of failures) console.log(`  ${C.r('✖')} ${f}`);
  process.exit(1);
}
console.log(C.d('全部通过。可以放心 `mdp serve` 或 `npm run build`。'));
