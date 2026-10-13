/**
 * server/render.mjs — 渲染管线（整个后台的心脏）。
 *
 * 三条产出路线，各自只做自己最擅长的事：
 *
 *   ① HTML 路线（默认，用于 PNG / PDF-HTML / HTML）
 *      shared/markdown.mjs 渲染 → shared/theme.mjs 出样式 → 把页面用内部
 *      URL 交给 Chrome（CDP），按 deviceScaleFactor = dpi/96 截图，或
 *      printToPDF 打印。因为预览与导出共用同一份渲染器与样式表，导出结果
 *      与右侧预览**结构上**一致。
 *
 *   ② LaTeX 路线（用于 PDF / TeX / DOCX）
 *      调用现有的 md2pdf 脚本，完整复用它的 7 个质量档位、ctex 中文排版、
 *      字体探测、增量缓存——不重写、不复制。
 *
 *   ③ 直通路线（Markdown 源文件）
 *
 * 所有外部命令都经过此处集中构造（buildMd2pdfArgs），因此网页端能**如实**
 * 显示将要执行的命令行——这既是调试便利，也是"保留终端操作感"的落点。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  MD2PDF, NODE_MODULES, PROJECT_ROOT, ARTIFACT_DIR, TMP_DIR,
  uid, run, pngSize, mimeFor, ensureDirs, formatBytes, os,
} from './util.mjs';
import { renderMarkdown, MARKDOWN_FLAGS, DEFAULT_MARKDOWN_OPTIONS } from '../shared/markdown.mjs';
import { createIncrementalRenderer, blocksToHtml } from '../shared/incremental.mjs';
import {
  documentCss, buildExportHtml, withDocMeta, tocHtml,
  DEFAULT_DOC_OPTIONS, PAPER_SIZES, mmToPx, DOC_THEMES,
} from '../shared/theme.mjs';
import { pdfToPng, bestRasterizer } from './raster.mjs';
import { estimateTiming, recordTiming } from './estimate.mjs';

const KATEX_DIST = path.join(NODE_MODULES, 'katex', 'dist');
const HLJS_STYLES = path.join(NODE_MODULES, 'highlight.js', 'styles');

/* ====================================================== 内部渲染页注册表 === */
/**
 * 交给 Chrome 加载的页面必须先能通过 HTTP 访问（KaTeX 字体是相对 CSS 的
 * 独立文件，data:/file: 下加载不可靠）。这里做一个极小的、带 TTL 的内存注册表。
 */
const renderPages = new Map();
const PAGE_TTL = 5 * 60 * 1000;

export function registerRenderPage(html) {
  const token = uid(12);
  renderPages.set(token, { html, at: Date.now() });
  if (renderPages.size > 40) {
    const now = Date.now();
    for (const [k, v] of renderPages) if (now - v.at > PAGE_TTL) renderPages.delete(k);
  }
  return token;
}

export function getRenderPage(token) {
  const entry = renderPages.get(token);
  if (!entry) return null;
  if (Date.now() - entry.at > PAGE_TTL) { renderPages.delete(token); return null; }
  return entry.html;
}

export function dropRenderPage(token) { renderPages.delete(token); }

/* ====================================================== highlight.js 主题 === */

const hljsCssCache = new Map();

export function listHljsThemes() {
  try {
    return fs.readdirSync(HLJS_STYLES)
      .filter((f) => f.endsWith('.css') && !f.endsWith('.min.css'))
      .map((f) => f.replace(/\.css$/, ''))
      .sort();
  } catch { return ['github', 'github-dark', 'atom-one-light', 'atom-one-dark']; }
}

export function hljsThemeFor(docOptions) {
  if (docOptions?.codeTheme) return docOptions.codeTheme;
  const theme = DOC_THEMES.find((t) => t.id === (docOptions?.theme || 'paper'));
  return theme?.dark ? 'github-dark' : 'github';
}

export function getHljsCss(themeName) {
  const name = String(themeName || 'github').replace(/[^A-Za-z0-9_-]/g, '');
  if (hljsCssCache.has(name)) return hljsCssCache.get(name);
  let css = '';
  for (const cand of [`${name}.min.css`, `${name}.css`]) {
    try {
      css = fs.readFileSync(path.join(HLJS_STYLES, cand), 'utf8');
      break;
    } catch { /* 试下一个 */ }
  }
  hljsCssCache.set(name, css);
  return css;
}

/* ==================================================== KaTeX 资源内联 ======= */

let katexCssInlineCache = null;

/**
 * 产出可离线双击打开的自包含 KaTeX 样式：
 *   · 只保留 woff2（现代浏览器全支持），去掉 woff/ttf 回退以把体积压到 ~1/3
 *   · 把字体文件以 data:URI 内联
 */
export function getKatexCssInlined() {
  if (katexCssInlineCache) return katexCssInlineCache;
  let css = '';
  try {
    css = fs.readFileSync(path.join(KATEX_DIST, 'katex.min.css'), 'utf8');
  } catch {
    katexCssInlineCache = '';
    return '';
  }
  // 去掉 woff / ttf 回退声明
  css = css.replace(/,\s*url\(fonts\/[^)]+\.woff\)\s*format\("woff"\)/g, '');
  css = css.replace(/,\s*url\(fonts\/[^)]+\.ttf\)\s*format\("truetype"\)/g, '');
  // 内联 woff2
  css = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (m, file) => {
    try {
      const buf = fs.readFileSync(path.join(KATEX_DIST, 'fonts', file));
      return `url(data:font/woff2;base64,${buf.toString('base64')})`;
    } catch {
      return m;
    }
  });
  katexCssInlineCache = css;
  return css;
}

/**
 * 把预置片段（文档信息块 / 正文内嵌目录）也包成 .mdp-block。
 * 这样它们与正文块共享同一套块间距规则——containment 之后外边距不再折叠，
 * 间距完全由包装元素决定，任何"裸"元素都会显得突兀。
 */
function wrapBlock(html) {
  if (!html) return '';
  const m = /^\s*<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html);
  const first = m ? m[1].toLowerCase() : 'div';
  return `<div class="mdp-block" data-first="${first}">${html}</div>\n`;
}

/* ================================================== Markdown → HTML 文档 === */

function safeJoinImage(base, src) {  if (!base) return null;
  const cleaned = src.replace(/^\.\//, '');
  const abs = path.resolve(base, cleaned);
  // 只允许读取工程根目录（避免把本机任意文件渲进文档）
  const root = path.resolve(PROJECT_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** 把 <img> 的本地文件替换成 data:URI，让 HTML 产物真正自包含。 */
function inlineImages(html, baseDir, warnings) {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (m, pre, src, post) => {
    if (/^(?:data:|https?:|\/\/)/i.test(src)) return m;
    const abs = safeJoinImage(baseDir, decodeURIComponent(src));
    if (!abs) return m;
    try {
      const st = fs.statSync(abs);
      if (st.size > 8 * 1024 * 1024) {
        warnings.push(`图片过大未内联(${formatBytes(st.size)}): ${src}`);
        return m;
      }
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml'
        : ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
      const b64 = fs.readFileSync(abs).toString('base64');
      return `${pre}data:${mime};base64,${b64}${post}`;
    } catch {
      return m;
    }
  });
}

/**
 * 渲染一份文档。
 * @param {object} o
 * @param {string} o.content       Markdown 源
 * @param {object} [o.markdown]    MARKDOWN_FLAGS 开关
 * @param {object} [o.doc]         排版（DEFAULT_DOC_OPTIONS）
 * @param {object} [o.meta]        {title, author, date}
 * @param {string} [o.assetBase]   图片基准目录
 * @param {'server'|'inline'} [o.assetMode]
 * @param {boolean} [o.forPrint]
 * @param {string} [o.printMarginMode] 'css' | 'chrome'
 */
export function buildDocument(o) {
  const markdown = { ...DEFAULT_MARKDOWN_OPTIONS, ...(o.markdown || {}) };
  const doc = { ...DEFAULT_DOC_OPTIONS, ...(o.doc || {}) };
  const meta = o.meta || {};
  const warnings = [];

  const title = meta.title || doc.title || '';
  const author = meta.author || doc.author || '';
  const date = meta.date || doc.date || '';
  Object.assign(doc, { title, author, date });

  const collector = [];
  const assetUrl = o.assetMode === 'server'
    ? (src) => {
        const abs = safeJoinImage(o.assetBase || PROJECT_ROOT, src);
        return abs ? `/api/asset?path=${encodeURIComponent(abs)}` : null;
      }
    : null;

  // 导出走**与预览同一个**增量渲染器：同样的分块、同样的包装标记，
  // 因此"预览所见"与"导出所得"在结构上不可能不一致。
  // 导出页面带 data-static="1"，会关闭 content-visibility 以保证完整布局。
  const incRenderer = createIncrementalRenderer({ ...markdown, collector, assetUrl });
  const rendered = incRenderer.render(o.content);

  let bodyHtml = blocksToHtml(rendered.blocks);
  if (doc.showMeta) bodyHtml = wrapBlock(withDocMeta('', doc)) + bodyHtml;
  if (markdown.tocEmbed) bodyHtml = wrapBlock(tocHtml(rendered.toc, { title: '目录' })) + bodyHtml;
  if (o.assetMode === 'inline' && o.assetBase) bodyHtml = inlineImages(bodyHtml, o.assetBase, warnings);

  const hljsTheme = hljsThemeFor(doc);
  const hljsCss = getHljsCss(hljsTheme);
  const forPrint = o.printMarginMode === 'chrome';
  const cssOptions = forPrint ? { ...doc, margin: 0 } : doc;
  const css = documentCss(cssOptions);

  const html = buildExportHtml({
    bodyHtml,
    css,
    hljsCss,
    // 服务端渲染页通过 http 提供，直接 <link> 到我们自己的 /vendor/katex/
    // （KaTeX 的字体在 CSS 内是相对 URL，因此必须让 CSS 走 URL 而不是内联）
    katexCssHref: o.assetMode === 'server' ? '/vendor/katex/katex.min.css' : '',
    options: { ...doc, transparent: Boolean(doc.transparent) },
    lang: /[\u4e00-\u9fff]/.test(o.content) ? 'zh-CN' : 'en',
    title: title || 'MDP Studio',
  });

  return { html, bodyHtml, toc: rendered.toc, stats: rendered.stats, errors: rendered.errors, warnings, hljsTheme, doc, markdown };
}

/* ======================================================== md2pdf 命令构造 === */

/**
 * 把网页端的 LaTeX 选项翻译成 md2pdf 命令行。
 * 这份构造同时被「命令预览」与「真实执行」使用，所以两者不可能不一致。
 * @param {object} latex
 * @param {{input:string, output:string, to:string}} io
 * @returns {string[]}
 */
export function buildMd2pdfArgs(latex = {}, io) {
  const { input, output, to = 'pdf' } = io;
  const a = ['-q', String(latex.preset || 'std'), '-t', String(to)];
  if (latex.engine) a.push('-e', String(latex.engine));
  a.push('-o', output);

  if (to === 'png') {
    a.push('--dpi', String(latex.dpi || 200));
    if (latex.pngPage) a.push('--page', String(latex.pngPage));
    if (latex.transparent) a.push('--png-transparent');
  }
  if (latex.keepTex && to === 'pdf') a.push('-k');

  if (latex.toc === true) a.push('--toc');
  else if (latex.toc === false) a.push('--no-toc');
  if (latex.tocDepth != null && latex.toc) a.push('--toc-depth', String(latex.tocDepth));
  if (latex.tocTitle) a.push('--toc-title', String(latex.tocTitle));

  if (latex.numbers === true) a.push('--numbers');
  else if (latex.numbers === false) a.push('--no-numbers');

  if (latex.fontsize) a.push('--fontsize', String(latex.fontsize));
  if (latex.margin) a.push('--margin', String(latex.margin));
  if (latex.linestretch) a.push('--linestretch', String(latex.linestretch));
  if (latex.mainfont) a.push('--mainfont', String(latex.mainfont));
  if (latex.cjkfont) a.push('--cjkfont', String(latex.cjkfont));
  if (latex.monofont) a.push('--monofont', String(latex.monofont));
  if (latex.cjk) a.push('--cjk', String(latex.cjk));
  if (latex.highlight) a.push('--highlight', String(latex.highlight));
  if (latex.colorlinks === true) a.push('--colorlinks');
  else if (latex.colorlinks === false) a.push('--no-colorlinks');
  if (latex.documentclass) a.push('--documentclass', String(latex.documentclass));
  for (const co of asList(latex.classoption)) a.push('--classoption', String(co));
  if (latex.lang) a.push('--lang', String(latex.lang));
  if (latex.template) a.push('--template', String(latex.template));
  for (const h of asList(latex.includeHeaders)) a.push('-H', String(h));
  for (const c of asList(latex.css)) a.push('--css', String(c));
  if (latex.bibliography) a.push('--bibliography', String(latex.bibliography));
  if (latex.csl) a.push('--csl', String(latex.csl));
  if (latex.citeproc) a.push('--citeproc');
  if (latex.metadataFile) a.push('--metadata-file', String(latex.metadataFile));
  if (latex.resourcePath) a.push('--resource-path', String(latex.resourcePath));
  for (const [k, v] of asPairs(latex.variables)) a.push('-s', `${k}=${v}`);
  for (const [k, v] of asPairs(latex.metadata)) a.push('-M', `${k}=${v}`);

  // 输入文件必须在 `--` 之前，`--` 之后的一切原样交给 pandoc
  a.push(input);
  const extra = asList(latex.extraArgs);
  if (extra.length) a.push('--', ...extra.map(String));
  return a;
}

function asList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '');
  return [v];
}

function asPairs(v) {
  const out = [];
  if (!v) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string' && item.includes('=')) {
        const i = item.indexOf('=');
        out.push([item.slice(0, i), item.slice(i + 1)]);
      } else if (item && typeof item === 'object') {
        for (const [k, val] of Object.entries(item)) out.push([k, val]);
      }
    }
  } else if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) out.push([k, val]);
  }
  return out;
}

/** 供网页端展示的命令行（带 shell 引号）。 */
export function formatCommand(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ');
}

/* ================================================================ 主流程 === */

/** 默认渲染请求（网页端与 API 的契约）。 */
export function normalizeRequest(body = {}) {
  const doc = { ...DEFAULT_DOC_OPTIONS, ...(body.doc || {}) };
  const markdown = { ...DEFAULT_MARKDOWN_OPTIONS, ...(body.markdown || {}) };
  const latex = { preset: 'std', ...(body.latex || {}) };
  const png = { dpi: 200, mode: 'page', transparent: false, engine: 'html', ...(body.png || {}) };
  const targets = asList(body.targets).map(String);
  return {
    content: String(body.content ?? ''),
    filename: sanitizeName(body.filename || (body.meta && body.meta.title) || 'document'),
    targets: targets.length ? targets : ['png'],
    png,
    doc,
    markdown,
    latex,
    meta: body.meta || {},
    assetBase: body.assetBase || PROJECT_ROOT,
    keepSource: body.keepSource !== false,
  };
}

export function sanitizeName(name) {
  const base = String(name || 'document')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (base || 'document').slice(0, 80);
}

/**
 * 执行一次渲染。
 * @param {object} req normalizeRequest 的结果
 * @param {{log:(level:string,msg:string)=>void, signal?:AbortSignal, jobId:string,
 *          chromePool:any, baseUrl:string, keepWorkDir?:boolean}} ctx
 */
export async function executeRender(req, ctx) {
  const { log, signal, jobId, chromePool, baseUrl } = ctx;
  await ensureDirs();

  const workDir = path.join(ARTIFACT_DIR, jobId);
  await fsp.mkdir(workDir, { recursive: true });

  const started = Date.now();
  const artifacts = [];
  const warnings = [];
  const errors = [];

  /* ---- 进度与耗时预估 ---------------------------------------------------
     每个 target 先按历史（或内置基线）估一个耗时，累加成总预算；
     每完成一个阶段就把该阶段的预算计入已完成量，于是进度条与 ETA 是**自洽**的：
     预估越准，进度越线性。真实耗时会在成功后被记录，下一次预估更准。 */
  const chars = req.content.length;
  const routeOf = (t) => (t === 'png' && req.png.engine === 'latex' ? 'pdf' : t);
  const budgets = new Map();
  let totalMs = 250;
  for (const t of req.targets) {
    const r = routeOf(t);
    const e = estimateTiming(r, chars);
    budgets.set(t, Math.max(60, e.ms));
    totalMs += Math.max(60, e.ms);
  }
  let spentMs = 0;
  /**
   * 统一的进度换算式。**必须只有一处**——之前初始值写死 2%，而第一个阶段算出来是
   * 1.8%（30ms/1657ms），进度条会肉眼可见地往回跳；另一处内联还用了 0.9 的封顶，
   * 与这里的 0.97 不一致，同样可能造成回退。这个 bug 是 scripts/verify-export.mjs
   * 的"进度单调不减"断言抓出来的。
   */
  const pctNow = () => Math.min(0.97, spentMs / totalMs);
  const etaNow = () => Math.max(150, totalMs - (Date.now() - started));
  const stage = (label, ms) => {
    spentMs += Math.max(0, ms);
    ctx.progress?.(pctNow(), label, etaNow());
  };
  stage('准备', 0);

  // 1) 源文件落盘（既是 pandoc 的输入，也是一个可下载产物）
  const sourceName = `${req.filename}.md`;
  const sourcePath = path.join(workDir, sourceName);
  await fsp.writeFile(sourcePath, req.content, 'utf8');
  log('info', `源文件 ${sourceName} · ${Buffer.byteLength(req.content, 'utf8')} 字节 · ${req.content.split('\n').length} 行`);
  stage('源文件已落盘', 30);

  // 2) 预渲染 Markdown（HTML 路线与统计信息共用）
  const needsHtml = req.targets.some((t) => ['png', 'pdf-html', 'html'].includes(t));
  let built = null;
  if (needsHtml) {
    const t0 = Date.now();
    built = buildDocument({
      content: req.content,
      markdown: req.markdown,
      doc: req.doc,
      meta: req.meta,
      assetBase: req.assetBase,
      assetMode: 'server',
    });
    log('info', `Markdown 渲染完成：${built.stats.words} 字 · ${built.toc.length} 个标题 · ${built.errors.length} 个公式错误 (${Date.now() - t0}ms)`);
    stage('Markdown 已渲染', 60);
    for (const e of built.errors) {
      log('warn', `公式错误${e.line ? ` 第${e.line}行` : ''}: ${e.message}`);
      errors.push({ kind: 'katex', message: e.message, line: e.line, tex: e.tex });
    }
    for (const w of built.warnings) { warnings.push(w); log('warn', w); }
  }

  const wantPngViaLatex = req.targets.includes('png') && req.png.engine === 'latex';
  const latexTargets = new Set();
  for (const t of req.targets) {
    if (t === 'pdf' || t === 'tex' || t === 'docx') latexTargets.add(t);
  }
  if (wantPngViaLatex) latexTargets.add('pdf');

  // 3) LaTeX 路线
  const latexResults = {};
  for (const t of latexTargets) {
    if (signal?.aborted) throw abortError();
    const ext = t;
    const outPath = path.join(workDir, `${req.filename}.${ext}`);
    const argv = buildMd2pdfArgs({ ...req.latex, keepTex: req.latex.keepTex }, {
      input: sourcePath, output: outPath, to: t,
    });
    log('cmd', `$ ${formatCommand([MD2PDF, ...argv])}`);
    const t0 = Date.now();
    const r = await run(MD2PDF, argv, {
      cwd: workDir,
      env: { SIG_CACHE_DIR: path.join(PROJECT_ROOT, '.cache', 'md2pdf'), MD2PDF_HOME: PROJECT_ROOT },
      signal,
      timeoutMs: 10 * 60 * 1000,
      onLog: (stream, line) => relayEngineLog(log, stream, line),
    });
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-12).join('\n');
      errors.push({ kind: 'engine', target: t, message: `md2pdf 退出码 ${r.code}`, detail });
      log('err', `✗ ${t} 生成失败（退出码 ${r.code}），耗时 ${Date.now() - t0}ms`);
      throw Object.assign(new Error(`${t.toUpperCase()} 生成失败（退出码 ${r.code}）`), { detail, errors });
    }
    log('ok', `✓ ${path.basename(outPath)} · ${formatBytes((await fsp.stat(outPath)).size)} · ${Date.now() - t0}ms`);
    latexResults[t] = outPath;
    stage(`${t.toUpperCase()} 已生成`, budgets.get(t) || 800);
    recordTiming(t, chars, Date.now() - t0);

    if (t === 'pdf' || t === 'tex' || t === 'docx') {
      artifacts.push(await artifactFor(outPath, { route: t, jobId, workDir }));
    }
    if (t === 'pdf' && req.latex.keepTex) {
      const texPath = path.join(workDir, `${req.filename}.tex`);
      if (fs.existsSync(texPath)) artifacts.push(await artifactFor(texPath, { route: 'tex', jobId, workDir }));
    }
  }

  // 4) PNG 路线
  if (req.targets.includes('png')) {
    if (signal?.aborted) throw abortError();
    const outPath = path.join(workDir, `${req.filename}.png`);
    if (wantPngViaLatex) {
      // LaTeX 排版 → PDF → 栅格化
      const pdfPath = latexResults.pdf;
      const raster = await pdfToPng({
        pdfPath,
        outPath,
        dpi: req.png.dpi,
        page: req.png.page || 1,
        transparent: req.png.transparent,
        signal,
        onLog: (s, l) => relayEngineLog(log, s, l),
      });
      if (!raster.ok) {
        errors.push({ kind: 'raster', message: raster.error });
        log('err', `✗ PNG 栅格化失败：${String(raster.error).split('\n')[0]}`);
        throw Object.assign(new Error('PNG 栅格化失败'), { detail: raster.error, errors });
      }
      if (raster.warning) { warnings.push(raster.warning); log('warn', raster.warning); }
      log('ok', `✓ ${path.basename(outPath)} · ${raster.width}×${raster.height} · ${formatBytes(raster.bytes)} · 工具 ${raster.tool}`);
      stage('PNG 已栅格化', Math.round((budgets.get('png') || 800) * 0.4));
      artifacts.push(await artifactFor(outPath, {
        route: 'png', jobId, workDir,
        extra: { tool: raster.tool, toolLabel: raster.toolLabel, quality: raster.quality, dpi: req.png.dpi, width: raster.width, height: raster.height },
      }));
    } else {
      const tp = Date.now();
      ctx.progress?.(pctNow(), 'Chromium 正在渲染并截图', etaNow());
      const shot = await abortable(signal, chromePool, log, () => renderHtmlToPng({
        pool: chromePool, baseUrl, built, req, outPath, log,
      }));
      stage('PNG 已生成', budgets.get('png') || 800);
      recordTiming('png', chars, Date.now() - tp);
      for (const w of shot.warnings) { warnings.push(w); log('warn', w); }
      artifacts.push(await artifactFor(outPath, {
        route: 'png', jobId, workDir,
        extra: { tool: 'chromium', toolLabel: 'Chromium CDP', quality: 'high', dpi: req.png.dpi, width: shot.width, height: shot.height },
      }));
    }
  }

  // 5) PDF(HTML) / HTML 路线
  if (req.targets.includes('pdf-html')) {
    if (signal?.aborted) throw abortError();
    const outPath = path.join(workDir, `${req.filename}.html.pdf`);
    const tph = Date.now();
    ctx.progress?.(pctNow(), 'Chromium 正在打印 PDF', etaNow());
    const buf = await abortable(signal, chromePool, log, () => renderHtmlToPdf({ pool: chromePool, baseUrl, built, req, log }));
    await fsp.writeFile(outPath, buf);
    stage('PDF 已打印', budgets.get('pdf-html') || 600);
    recordTiming('pdf-html', chars, Date.now() - tph);
    log('ok', `✓ ${path.basename(outPath)} · ${formatBytes(buf.length)}`);
    artifacts.push(await artifactFor(outPath, { route: 'pdf-html', jobId, workDir, name: `${req.filename}.pdf` }));
  }

  if (req.targets.includes('html')) {
    if (signal?.aborted) throw abortError();
    const outPath = path.join(workDir, `${req.filename}.html`);
    const standalone = buildDocument({
      content: req.content,
      markdown: req.markdown,
      doc: { ...req.doc, transparent: false },
      meta: req.meta,
      assetBase: req.assetBase,
      assetMode: 'inline',
    });
    const katexInline = getKatexCssInlined();
    const html = standalone.html.replace(
      '</head>',
      `<style>${katexInline}</style>\n<!-- 由 MDP Studio 生成 · KaTeX 字体已内联，可离线打开 -->\n</head>`,
    );
    await fsp.writeFile(outPath, html, 'utf8');
    for (const w of standalone.warnings) { warnings.push(w); log('warn', w); }
    log('ok', `✓ ${path.basename(outPath)} · ${formatBytes(Buffer.byteLength(html, 'utf8'))}（自包含）`);
    stage('HTML 已生成', budgets.get('html') || 300);
    recordTiming('html', chars, Date.now() - started);
    artifacts.push(await artifactFor(outPath, { route: 'html', jobId, workDir }));
  }

  if (req.targets.includes('md')) {
    artifacts.push(await artifactFor(sourcePath, { route: 'md', jobId, workDir }));
  }

  if (!req.keepWorkDir) {
    // 源文件与产物都在 workDir 内，产物已登记；保留目录以便用户按路径再加工
  }

  ctx.progress?.(1, '完成', 0);

  return {
    artifacts,
    warnings,
    errors,
    workDir,
    estimates: Object.fromEntries([...budgets].map(([k, v]) => [k, Math.round(v)])),
    elapsedMs: Date.now() - started,
    stats: built?.stats || null,
    toc: built?.toc || [],
    commands: buildPlanPreview(req),
  };
}

function abortError() {
  return Object.assign(new Error('任务已取消'), { aborted: true });
}

/**
 * 让"发出去就收不回来"的 Chromium 调用变可中断。
 *
 * CDP 的 Page.captureScreenshot / printToPDF 一旦发出**没有取消消息**：
 * 唯一能在半路停下的办法是把浏览器进程干掉 —— 连接一断，所有 pending 的 CDP
 * 请求立刻 reject（见 chrome.mjs 的 ws 'close' 处理）。
 *
 * 代价：这次浏览器实例作废，下一次渲染会自己重新拉起（chromePool.ensure() 会
 * 发现 cdp 已关闭并重启）。收益：用户点「取消」时立刻停住一个正跑在 10 万字
 * 文档上的截图，而不是干等十几秒 —— 取消的意义全在这里。
 */
async function abortable(signal, pool, log, fn) {
  if (!signal) return fn();
  if (signal.aborted) throw abortError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      log?.('warn', '取消已生效：终止 Chromium 会话（下次渲染会自动重启）');
      Promise.resolve(pool?.close?.()).catch(() => {});
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([fn(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** md2pdf 的输出重定向到任务日志，并做轻量着色提示。 */
function relayEngineLog(log, stream, line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  if (/^(error|!|.*Error:)/i.test(text)) log('err', text);
  else if (/warn|⚠|LaTeX Warning/i.test(text)) log('warn', text);
  else if (/^▸|^✓/.test(text)) log('info', text);
  else log(stream === 'err' ? 'debug' : 'out', text);
}

/** 生成命令预览（不执行），网页端「命令」面板直接展示。 */
export function buildPlanPreview(req) {
  const plans = [];
  const src = `<workdir>/${req.filename}.md`;
  for (const t of req.targets) {
    if (t === 'pdf' || t === 'tex' || t === 'docx') {
      const argv = buildMd2pdfArgs(req.latex, { input: src, output: `<workdir>/${req.filename}.${t}`, to: t });
      plans.push({ target: t, engine: 'md2pdf', command: formatCommand([MD2PDF, ...argv]) });
    } else if (t === 'png') {
      if (req.png.engine === 'latex') {
        const argv = buildMd2pdfArgs(req.latex, { input: src, output: `<workdir>/${req.filename}.pdf`, to: 'pdf' });
        const tool = bestRasterizer();
        plans.push({
          target: 'png',
          engine: 'md2pdf + rasterizer',
          command: `${formatCommand([MD2PDF, ...argv])}\n${tool ? tool.id : '(无栅格化工具)'}  --dpi ${req.png.dpi}  →  ${req.filename}.png`,
        });
      } else {
        const w = req.png.mode === 'card'
          ? `${req.doc.contentWidth}px 宽的内容卡片`
          : `${req.doc.paper} 整页`;
        plans.push({
          target: 'png',
          engine: 'chromium',
          command: `chrome-headless-shell --headless \\\n  Emulation.setDeviceMetricsOverride({ deviceScaleFactor: ${(req.png.dpi / 96).toFixed(4)} }) \\\n  Page.captureScreenshot({ clip: #mdp-root, format: 'png' })   # ${w}`,
        });
      }
    } else if (t === 'pdf-html') {
      plans.push({
        target: 'pdf-html',
        engine: 'chromium',
        command: `chrome-headless-shell --headless \\\n  Page.printToPDF({ paperWidth: ${(PAPER_SIZES[req.doc.paper]?.w / 25.4).toFixed(3)}in, printBackground: true })`,
      });
    } else if (t === 'html') {
      plans.push({ target: 'html', engine: 'built-in', command: `内联 KaTeX 字体 + 样式 → ${req.filename}.html (自包含)` });
    } else if (t === 'md') {
      plans.push({ target: 'md', engine: 'built-in', command: `原样写出 ${req.filename}.md` });
    }
  }
  return plans;
}

/* ================================================== HTML → PNG (Chrome) === */

async function renderHtmlToPng({ pool, baseUrl, built, req, outPath, log }) {
  const warnings = [];
  if (!pool || !pool.available) {
    throw Object.assign(new Error('未找到 Chromium/Chrome，无法使用 HTML 路线导出 PNG'), {
      detail: '设置 MDP_CHROME 指向 chrome/chromium 可执行文件，或安装 Chrome。\n也可以改用 LaTeX 引擎导出 PNG（需要 poppler）。',
    });
  }
  const doc = req.doc;
  const dpi = Math.max(36, Math.min(1200, Number(req.png.dpi) || 200));
  const dsf = dpi / 96;
  const mode = req.png.mode === 'card' ? 'card' : 'page';

  const html = buildDocument({
    content: req.content,
    markdown: req.markdown,
    doc: { ...doc, card: mode === 'card', transparent: Boolean(req.png.transparent) },
    meta: req.meta,
    assetBase: req.assetBase,
    assetMode: 'server',
  }).html;

  const token = registerRenderPage(html);
  const url = `${baseUrl}/render/${token}`;

  let width;
  if (mode === 'card') {
    const pad = Number(doc.cardPadding) || 32;
    const border = doc.cardBorder ? 2 : 0;
    width = Math.round((Number(doc.contentWidth) || 860) + pad * 2 + border);
  } else {
    const paper = PAPER_SIZES[doc.paper] || PAPER_SIZES.A4;
    width = Math.round(mmToPx(paper.w));
  }

  const t0 = Date.now();
  const page = await pool.newPage();
  try {
    await page.init();
    await page.setViewport(width, 1200, dsf);
    await page.setTransparentBackground(Boolean(req.png.transparent));
    await page.goto(url, 45000);
    const m = await page.measure('#mdp-root');
    if (!m || m.width < 1 || m.height < 1) throw new Error('页面测量失败：内容尺寸为 0');

    const clip = mode === 'card'
      ? { x: m.x, y: m.y, width: m.width, height: m.height }
      : { x: 0, y: 0, width: Math.max(m.scrollWidth, width), height: m.scrollHeight };

    log('info', `Chromium 截图：${Math.round(clip.width)}×${Math.round(clip.height)} CSS px @ ${dsf.toFixed(2)}x → 目标 ${Math.round(clip.width * dsf)}×${Math.round(clip.height * dsf)} px`);

    const shot = await page.screenshot({ ...clip, dsf });
    await fsp.writeFile(outPath, shot.buffer);

    const size = pngSize(shot.buffer) || { width: 0, height: 0 };
    const effectiveDpi = size.width > 0 && clip.width > 0 ? Math.round((size.width / clip.width) * 96) : dpi;
    if (size.width < clip.width * dsf * 0.95) {
      warnings.push(`实际输出 ${size.width}px 宽，低于目标 ${Math.round(clip.width * dsf)}px——超大页面可能被 Chromium 限制`);
    }
    log('ok', `✓ ${path.basename(outPath)} · ${size.width}×${size.height} · ${formatBytes(shot.buffer.length)} · 有效 ${effectiveDpi} DPI · ${Date.now() - t0}ms`);
    return { width: size.width, height: size.height, warnings, dpi: effectiveDpi };
  } finally {
    await page.close().catch(() => {});
    dropRenderPage(token);
  }
}

/* ================================================ HTML → PDF (Chrome) === */

async function renderHtmlToPdf({ pool, baseUrl, built, req, log }) {
  if (!pool || !pool.available) {
    throw Object.assign(new Error('未找到 Chromium/Chrome，无法使用 HTML 路线导出 PDF'), {
      detail: '设置 MDP_CHROME，或改用「PDF · LaTeX」路线。',
    });
  }
  const doc = req.doc;
  const paper = PAPER_SIZES[doc.paper] || PAPER_SIZES.A4;
  const marginIn = (Number(doc.margin) || 0) / 25.4;

  const html = buildDocument({
    content: req.content,
    markdown: req.markdown,
    doc: { ...doc, card: false, transparent: false },
    meta: req.meta,
    assetBase: req.assetBase,
    assetMode: 'server',
    printMarginMode: 'chrome',
  }).html;

  const token = registerRenderPage(html);
  const url = `${baseUrl}/render/${token}`;
  const contentWidth = Math.max(200, Math.round(((paper.w / 25.4) - marginIn * 2) * 96));

  const t0 = Date.now();
  const page = await pool.newPage();
  try {
    await page.init();
    // 打印布局受视口宽度影响：按纸张正文宽度设置，保证 100% 宽元素不溢出
    await page.setViewport(contentWidth, 1200, 1);
    await page.goto(url, 45000);
    const buf = await page.printToPdf({
      paperWidthIn: paper.w / 25.4,
      paperHeightIn: paper.h / 25.4,
      marginIn,
    });
    log('ok', `Chromium 打印完成 · ${formatBytes(buf.length)} · ${doc.paper} · 页边距 ${doc.margin}mm · ${Date.now() - t0}ms`);
    return buf;
  } finally {
    await page.close().catch(() => {});
    dropRenderPage(token);
  }
}

/* ================================================================ 产物 === */

async function artifactFor(file, { route, jobId, workDir, name, extra = {} }) {
  const st = await fsp.stat(file);
  const base = name || path.basename(file);
  const id = uid(12);
  const rec = {
    id,
    name: base,
    file,
    rel: path.relative(ARTIFACT_DIR, file),
    jobId,
    route,
    ext: path.extname(base).replace(/^\./, ''),
    mime: mimeFor(base),
    bytes: st.size,
    createdAt: new Date().toISOString(),
    ...extra,
  };
  if (rec.ext === 'png' && !rec.width) {
    try {
      const size = pngSize(await fsp.readFile(file));
      if (size) { rec.width = size.width; rec.height = size.height; }
    } catch { /* ignore */ }
  }
  return rec;
}

/** 目录扫描：把磁盘上的产物登记表恢复出来（服务重启后仍能看到历史产物）。 */
export async function scanArtifacts(limit = 200) {
  const out = [];
  let jobs = [];
  try { jobs = await fsp.readdir(ARTIFACT_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of jobs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ARTIFACT_DIR, d.name);
    let files = [];
    try { files = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile()) continue;
      if (/\.md2pdf\.\d+\./.test(f.name)) continue; // 中间件
      const full = path.join(dir, f.name);
      try {
        const st = await fsp.stat(full);
        out.push({
          id: `disk:${d.name}/${f.name}`,
          name: f.name,
          file: full,
          rel: path.relative(ARTIFACT_DIR, full),
          jobId: d.name,
          route: routeFromName(f.name),
          ext: path.extname(f.name).replace(/^\./, ''),
          mime: mimeFor(f.name),
          bytes: st.size,
          createdAt: new Date(st.mtimeMs).toISOString(),
          onDisk: true,
        });
      } catch { /* ignore */ }
    }
  }
  out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return out.slice(0, limit);
}

function routeFromName(name) {
  if (/\.html\.pdf$/.test(name)) return 'pdf-html';
  if (/\.tex$/.test(name)) return 'tex';
  if (/\.png$/.test(name)) return 'png';
  if (/\.pdf$/.test(name)) return 'pdf';
  if (/\.html$/.test(name)) return 'html';
  if (/\.docx$/.test(name)) return 'docx';
  if (/\.md$/.test(name)) return 'md';
  return 'other';
}

/** 构建期检查：产物目录是否可清理。 */
export async function cleanupArtifacts(keepJobIds = []) {
  let removed = 0;
  let dirs = [];
  try { dirs = await fsp.readdir(ARTIFACT_DIR, { withFileTypes: true }); } catch { return removed; }
  for (const d of dirs) {
    if (!d.isDirectory() || keepJobIds.includes(d.name)) continue;
    await fsp.rm(path.join(ARTIFACT_DIR, d.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export { MARKDOWN_FLAGS, DEFAULT_MARKDOWN_OPTIONS, DEFAULT_DOC_OPTIONS, DOC_THEMES };
