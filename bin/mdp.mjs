#!/usr/bin/env node
/**
 * bin/mdp.mjs — MDP Studio 统一命令行入口。
 *
 *   mdp serve                     启动网页工作台（后台 + 浏览器）
 *   mdp build note.md -t png      不开网页，直接出图
 *   mdp doctor                    环境体检
 *   mdp presets / routes          查看质量档位 / 导出路线
 *
 * 关于"双模"的设计取舍：
 *   · `-t pdf / tex / docx`（以及 `--via latex` 的 png）直接调用现有 POSIX 脚本
 *     md2pdf —— 复用它的档位、ctex 中文排版、字体探测与增量缓存，零重写。
 *   · `-t png / pdf-html / html`（HTML 路线）走 Node 管线：起一个**临时内部服务**
 *     把渲染页与 KaTeX 资源通过 http 暴露给 Chromium（字体是相对 URL 的独立文件，
 *     file:// 下不可靠），渲完即关。
 *   · 两条路线共用 shared/markdown.mjs 与 shared/theme.mjs，因此网页预览、
 *     PNG、HTML、LaTeX 四者的排版语义是同一份定义。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  MD2PDF, PROJECT_ROOT, ARTIFACT_DIR, run, uid, formatBytes, which, ensureDirs,
} from '../server/util.mjs';
import { startServer } from '../server/server.mjs';
import { executeRender, normalizeRequest, buildPlanPreview, formatCommand, sanitizeName } from '../server/render.mjs';
import { probeCaps } from '../server/caps.mjs';
import { getPresets, EXPORT_ROUTES } from '../server/presets.mjs';
import { DOC_THEMES, PAPER_SIZES, FONT_PRESETS, DEFAULT_DOC_OPTIONS } from '../shared/theme.mjs';
import { MARKDOWN_FLAGS, DEFAULT_MARKDOWN_OPTIONS } from '../shared/markdown.mjs';

const PROG = 'mdp';
const VERSION = '2.0.0';

/* --------------------------------------------------------------- 输出 --- */

const useColor = process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2'); const bold = c('1'); const red = c('31'); const green = c('32');
const yellow = c('33'); const cyan = c('36'); const magenta = c('35');

let QUIET = false;
const out = (...a) => { if (!QUIET) process.stdout.write(a.join(' ') + '\n'); };
const info = (...a) => { if (!QUIET) process.stderr.write(cyan('▸') + ' ' + a.join(' ') + '\n'); };
const warn = (...a) => process.stderr.write(yellow('!') + ' ' + a.join(' ') + '\n');
const fail = (...a) => process.stderr.write(red('✗') + ' ' + a.join(' ') + '\n');
const okmsg = (...a) => { if (!QUIET) process.stderr.write(green('✓') + ' ' + a.join(' ') + '\n'); };

/* ---------------------------------------------------------- 参数解析 --- */

function parseArgs(argv) {
  const o = {
    _: [], extra: [], variables: [], metadata: [], includeHeaders: [], classoption: [],
    via: null, json: false, open: true, force: false, dryRun: false, keep: false,
    stdin: false, keepPdf: false, download: false,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) { fail(`${name} 需要一个参数`); process.exit(2); }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([A-Za-z0-9-]+)=(.*)$/.exec(a);
    const key = eq ? `--${eq[1]}` : a;
    const val = eq ? eq[2] : null;
    const take = () => (val !== null ? val : need(i, key));
    const bump = () => { if (val === null) i++; };
    switch (key) {
      case '-h': case '--help': o.help = true; break;
      case '--version': o.version = true; break;
      case '-t': case '--to': o.to = take(); bump(); break;
      case '-o': case '--output': o.output = take(); bump(); break;
      case '-d': case '--outdir': o.outdir = take(); bump(); break;
      case '-q': case '--quality': case '--preset': o.quality = take(); bump(); break;
      case '-e': case '--engine': o.engine = take(); bump(); break;
      case '--via': o.via = take(); bump(); break;
      case '--dpi': o.dpi = Number(take()); bump(); break;
      case '--page': o.page = Number(take()); bump(); break;
      case '--transparent': o.transparent = true; break;
      case '--card': o.card = true; break;
      case '--no-card': o.card = false; break;
      case '--card-pad': o.cardPadding = Number(take()); bump(); break;
      case '--theme': o.theme = take(); bump(); break;
      case '--font-size': case '--fontsize-px': o.fontSize = Number(take()); bump(); break;
      case '--line-height': o.lineHeight = Number(take()); bump(); break;
      case '--width': o.contentWidth = Number(take()); bump(); break;
      case '--paper': o.paper = take(); bump(); break;
      case '--margin': o.margin = Number(take()); bump(); break;
      case '--font': o.fontBody = take(); bump(); break;
      case '--heading-font': o.fontHeading = take(); bump(); break;
      case '--code-theme': o.codeTheme = take(); bump(); break;
      case '--accent': o.accent = take(); bump(); break;
      case '--title': o.title = take(); bump(); break;
      case '--author': o.author = take(); bump(); break;
      case '--date': o.date = take(); bump(); break;
      case '--name': o.name = take(); bump(); break;
      case '--no-meta': o.showMeta = false; break;
      case '--toc': o.toc = true; break;
      case '--no-toc': o.toc = false; break;
      case '--toc-depth': o.tocDepth = take(); bump(); break;
      case '--numbers': o.numbers = true; break;
      case '--no-numbers': o.numbers = false; break;
      case '--linestretch': case '--line-stretch': o.linestretch = take(); bump(); break;
      case '--mainfont': case '--cjkfont': case '--monofont': {
        o[key.slice(2)] = take(); bump(); break;
      }
      case '--highlight': o.highlight = take(); bump(); break;
      case '--documentclass': o.documentclass = take(); bump(); break;
      case '--classoption': o.classoption.push(take()); bump(); break;
      case '-H': case '--include-in-header': o.includeHeaders.push(take()); bump(); break;
      case '-s': case '--var': o.variables.push(take()); bump(); break;
      case '-M': case '--metadata': o.metadata.push(take()); bump(); break;
      case '--citeproc': o.citeproc = true; break;
      case '--bibliography': o.bibliography = take(); bump(); break;
      case '--csl': o.csl = take(); bump(); break;
      case '--numbering': o.numbering = true; break;
      case '--breaks': o.breaks = true; break;
      case '--no-breaks': o.breaks = false; break;
      case '--line-numbers': o.lineNumbers = true; break;
      case '--embed-toc': o.tocEmbed = true; break;
      case '--justify': o.justify = true; break;
      case '--indent': o.paragraphIndent = take(); bump(); break;
      case '--port': o.port = Number(take()); bump(); break;
      case '--host': o.host = take(); bump(); break;
      case '--concurrency': o.concurrency = Number(take()); bump(); break;
      case '-j': case '--jobs': o.jobs = Number(take()); bump(); break;
      case '--python': o.python = true; break;
      case '--token': o.token = take(); bump(); break;
      case '--no-open': o.open = false; break;
      case '--open': o.open = true; break;
      case '-f': case '--force': o.force = true; break;
      case '-n': case '--dry-run': o.dryRun = true; break;
      case '-k': case '--keep': case '--keep-pdf': o.keep = true; break;
      case '--stdin': o.stdin = true; break;
      case '--json': o.json = true; break;
      case '-Q': case '--quiet': QUIET = true; break;
      case '-v': case '--verbose': o.verbose = true; break;
      case '--': o.extra.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('-') && a !== '-') { fail(`未知选项 ${a}  (帮助: ${PROG} help)`); process.exit(2); }
        o._.push(a);
    }
  }
  return o;
}

/* ------------------------------------------------------------- 帮助 --- */

function printHelp() {
  const p = (s) => out(s);
  p('');
  p(`${bold('MDP Studio')} ${dim('v' + VERSION)} — Markdown → PNG / TeX-PDF，终端与浏览器双模`);
  p('');
  p(`${bold('用法')}`);
  p('  mdp serve [--port 8757] [--no-open]     启动网页工作台（方案 A：Node，零依赖）');
  p('  mdp serve --python [--port 8757]        方案 B：Python/FastAPI 挂载同一前端');
  p('  mdp build <文件.md ...> [选项]          直接产出文件，不打开网页');
  p('  mdp doctor [--json]                     环境体检（pandoc/LaTeX/Chromium/栅格化器）');
  p('  mdp presets [--json]                    查看质量档位');
  p('  mdp routes                              查看导出路线');
  p('  mdp themes                              查看文档主题');
  p('  mdp clean                               清空 .artifacts 产物目录');
  p('');
  p(`${bold('build 选项')}`);
  p('  -t, --to FORMAT     png | pdf | pdf-html | tex | html | docx | md   (默认 png)');
  p('      --via ENGINE    html | latex     选产出引擎（png 默认 html，pdf 默认 latex）');
  p('  -q, --quality LVL   质量档位 draft|std|high|press|cn|screen|slides (LaTeX 路线)');
  p('  -e, --engine NAME   xelatex|lualatex|pdflatex|tectonic');
  p('  -o, --output FILE   输出文件        -d, --outdir DIR  输出目录');
  p('      --name NAME     文档基名（配合 --stdin）');
  p('  -j, --jobs N        多文件并发数（默认 min(CPU核数, 4)）');
  p('      --stdin         从标准输入读 Markdown');
  p('');
  p(`  ${dim('— PNG / HTML 路线 —')}`);
  p('      --dpi N         PNG 分辨率，默认 200（300 打印，600 印刷）');
  p('      --card / --no-card      分享卡片样式（默认整页）');
  p('      --card-pad N    卡片内边距 px        --transparent  透明背景');
  p('      --theme NAME    文档主题（见 mdp themes）');
  p('      --width N       正文宽度 px          --paper A4|A5|B5|Letter|Legal|A3');
  p('      --font-size N   正文字号 px          --line-height N');
  p('      --font NAME     正文字体预设         --code-theme NAME');
  p('      --accent COLOR  主题强调色');
  p('      --title/--author/--date STR         文档信息块（--no-meta 关闭）');
  p('');
  p(`  ${dim('— Markdown 行为 —')}`);
  p('      --toc / --no-toc           LaTeX 路线目录开关');
  p('      --numbers / --no-numbers   章节编号');
  p('      --numbering                定理/引理自动编号');
  p('      --breaks                   软换行即换行');
  p('      --embed-toc                正文内嵌目录（HTML 路线）');
  p('      --line-numbers             代码块显示行号');
  p('      --justify                  两端对齐');
  p('');
  p(`  ${dim('— 其它 —')}`);
  p('      --json           把产物信息以 JSON 输出到 stdout');
  p('  -n, --dry-run        只打印将要执行的命令');
  p('  -f, --force          忽略缓存');
  p('  -k, --keep           保留中间 PDF / .tex');
  p('  -Q, --quiet  -v, --verbose');
  p('      --               其余参数原样交给 pandoc');
  p('');
  p(`${bold('示例')}`);
  p('  mdp build 定理.md -t png --dpi 300 --card --theme ink --title 极值定理');
  p('  mdp build 论文.md -t pdf -q cn --toc --numbers');
  p('  mdp build 讲义.md -t pdf-html --theme academic --paper A4');
  p('  cat note.md | mdp build --stdin --name note -t png');
  p('  mdp serve --port 8757        # 然后浏览器里可视化编辑 / 批量导出');
  p('');
  p(`${dim('等价关系：mdp build … -t pdf 与 md2pdf … 完全一致；md2pdf serve 等价于 mdp serve。')}`);
  p('');
}

/* ------------------------------------------------------------ doctor --- */

async function cmdDoctor(o) {
  const caps = await probeCaps({ force: true });
  if (o.json) { out(JSON.stringify(caps, null, 2)); return caps.summary.fail ? 1 : 0; }
  out('');
  out(`${bold('MDP Studio 体检')}  ${dim(caps.generatedAt)}`);
  out(`${dim(`Node ${caps.runtime.node} · ${caps.runtime.platform}/${caps.runtime.arch} · ${caps.runtime.projectRoot}`)}`);
  out('');
  let group = '';
  const icon = { ok: green('✔'), warn: yellow('▲'), fail: red('✖') };
  for (const chk of caps.checks) {
    if (chk.group !== group) { group = chk.group; out(`  ${bold(group)}`); }
    out(`    ${icon[chk.status]} ${chk.label.padEnd(26, ' ')} ${dim(chk.detail || '')}`);
    if (chk.hint && chk.status !== 'ok') out(`      ${yellow('→')} ${chk.hint}`);
  }
  out('');
  out(`  ${green(caps.summary.ok + ' 项正常')} · ${yellow(caps.summary.warn + ' 项提醒')} · ${red(caps.summary.fail + ' 项缺失')}`);
  if (caps.raster.highQuality) {
    out(`  ${dim('PNG：HTML 路线由 Chromium 真 DPI 渲染；LaTeX 路线由 ' + caps.raster.bestLabel + ' 栅格化')}`);
  } else {
    out(`  ${yellow('提示')} ${caps.raster.hint}`);
  }
  out('');
  return caps.summary.fail ? 1 : 0;
}

/* ----------------------------------------------------------- presets --- */

async function cmdPresets(o) {
  const presets = await getPresets({ force: true, onLog: (l, m) => warn(m) });
  if (o.json) { out(JSON.stringify(presets, null, 2)); return 0; }
  out('');
  out(`${bold('质量档位')} ${dim(`(引擎 ${presets.engine} · pandoc ${presets.pandoc || '?'} · 栅格化 ${presets.rasterizer || '无'})`)}`);
  out('');
  out(`  ${'档位'.padEnd(8)} ${'字号'.padEnd(7)} ${'页边距'.padEnd(8)} ${'目录'} ${'编号'} ${'说明'}`);
  out(`  ${dim('-'.repeat(66))}`);
  for (const p of presets.presets) {
    out(`  ${p.id.padEnd(8)} ${String(p.fontsize || '-').padEnd(7)} ${String(p.margin || '-').padEnd(8)} ` +
        `${(p.toc ? 'Y' : '-').padEnd(4)} ${(p.numbers ? 'Y' : '-').padEnd(4)} ${p.desc}`);
  }
  out('');
  out(`  ${dim('别名：')} draft=fast=q0  std=normal=q1  high=hq=q2  press=print=q3  cn=thesis=q4  screen=web=q5  slides=beamer=q6`);
  out('');
  return 0;
}

function cmdRoutes() {
  out('');
  out(`${bold('导出路线')}`);
  out('');
  for (const r of EXPORT_ROUTES) {
    out(`  ${bold(r.id.padEnd(10))} ${dim(r.engine.padEnd(6))} ${r.label.padEnd(14)} ${dim(r.blurb)}`);
  }
  out('');
  out(`  ${dim('--via html  → KaTeX + Chromium（真 DPI 截图 / 打印）')}`);
  out(`  ${dim('--via latex → pandoc + XeLaTeX（复用 md2pdf 的 7 个档位）')}`);
  out('');
  return 0;
}

function cmdThemes() {
  out('');
  out(`${bold('文档主题')}`);
  out('');
  for (const t of DOC_THEMES) {
    out(`  ${bold(t.id.padEnd(10))} ${t.dark ? dim('dark ') : 'light'} ${t.label.padEnd(8)} ${dim(t.desc)}`);
  }
  out('');
  out(`  ${bold('字体预设')}  ${Object.keys(FONT_PRESETS).join(' · ')}`);
  out(`  ${bold('纸张')}      ${Object.keys(PAPER_SIZES).join(' · ')}`);
  out('');
  return 0;
}

/* ------------------------------------------------------------- build --- */

const LATEX_TARGETS = new Set(['pdf', 'tex', 'docx']);

function viaFor(o) {
  if (o.via) return o.via === 'latex' ? 'latex' : 'html';
  const to = o.to || 'png';
  if (to === 'png') return 'html';
  if (to === 'pdf') return 'latex';
  if (LATEX_TARGETS.has(to)) return 'latex';
  return 'html';
}

function buildDocOptions(o) {
  const doc = {};
  const set = (k, v) => { if (v !== undefined && v !== null && !Number.isNaN(v)) doc[k] = v; };
  set('theme', o.theme); set('fontSize', o.fontSize); set('lineHeight', o.lineHeight);
  set('contentWidth', o.contentWidth); set('fontBody', o.fontBody); set('fontHeading', o.fontHeading);
  set('paper', o.paper); set('margin', o.margin); set('codeTheme', o.codeTheme);
  set('accent', o.accent); set('cardPadding', o.cardPadding);
  if (o.card !== undefined) doc.card = o.card;
  if (o.transparent !== undefined) doc.transparent = o.transparent;
  if (o.showMeta !== undefined) doc.showMeta = o.showMeta;
  if (o.justify !== undefined) doc.justify = o.justify;
  if (o.paragraphIndent !== undefined) doc.paragraphIndent = o.paragraphIndent;
  return doc;
}

function buildMarkdownOptions(o) {
  const md = {};
  if (o.breaks !== undefined) md.breaks = o.breaks;
  if (o.numbering) md.numbering = true;
  if (o.lineNumbers) md.lineNumbers = true;
  if (o.tocEmbed) md.tocEmbed = true;
  return md;
}

function buildLatexOptions(o) {
  const latex = { preset: o.quality || 'std' };
  if (o.engine && !['html', 'latex'].includes(o.engine)) latex.engine = o.engine;
  if (o.toc !== undefined) latex.toc = o.toc;
  if (o.tocDepth) latex.tocDepth = Number(o.tocDepth);
  if (o.numbers !== undefined) latex.numbers = o.numbers;
  if (o.linestretch) latex.linestretch = o.linestretch;
  if (o.mainfont) latex.mainfont = o.mainfont;
  if (o.cjkfont) latex.cjkfont = o.cjkfont;
  if (o.monofont) latex.monofont = o.monofont;
  if (o.highlight) latex.highlight = o.highlight;
  if (o.documentclass) latex.documentclass = o.documentclass;
  if (o.classoption?.length) latex.classoption = o.classoption;
  if (o.includeHeaders?.length) latex.includeHeaders = o.includeHeaders;
  if (o.variables?.length) latex.variables = o.variables;
  if (o.metadata?.length) latex.metadata = o.metadata;
  if (o.citeproc) latex.citeproc = true;
  if (o.bibliography) latex.bibliography = o.bibliography;
  if (o.csl) latex.csl = o.csl;
  if (o.keep) latex.keepTex = true;
  if (o.extra?.length) latex.extraArgs = o.extra;
  return latex;
}

function defaultExt(to) {
  if (to === 'pdf-html') return 'pdf';
  return to;
}

async function cmdBuild(o) {
  if (!o._.length && !o.stdin) {
    // 与 md2pdf 一致的贴心默认：当前目录只有一个 .md 就用它
    const md = (await fsp.readdir(process.cwd()).catch(() => [])).filter((f) => /\.(md|markdown)$/i.test(f));
    if (md.length === 1) { o._.push(md[0]); }
    else { fail('缺少输入文件（用法: mdp build 文件.md -t png，或 --stdin）'); return 2; }
  }

  const to = o.to || 'png';
  const via = viaFor(o);
  const isLatexRoute = via === 'latex' && (LATEX_TARGETS.has(to) || (to === 'png'));

  await ensureDirs();

  /* ---------- LaTeX 路线：直接委托给现有的 md2pdf ---------- */
  if (isLatexRoute) {
    const argv = [];
    for (const f of o._) argv.push(f);
    if (o.stdin) argv.push('-');
    argv.push('-t', to === 'png' ? 'png' : to);
    if (o.quality) argv.push('-q', String(o.quality));
    if (o.engine) argv.push('-e', String(o.engine));
    if (o.output) argv.push('-o', String(o.output));
    if (o.outdir) argv.push('-d', String(o.outdir));
    if (to === 'png') {
      argv.push('--dpi', String(o.dpi || 200));
      if (o.page) argv.push('--page', String(o.page));
      if (o.transparent) argv.push('--png-transparent');
      if (o.keep) argv.push('--keep-pdf');
    }
    if (o.force) argv.push('-f');
    if (o.keep && to === 'pdf') argv.push('-k');
    if (o.toc === true) argv.push('--toc');
    if (o.toc === false) argv.push('--no-toc');
    if (o.tocDepth) argv.push('--toc-depth', String(o.tocDepth));
    if (o.numbers === true) argv.push('--numbers');
    if (o.numbers === false) argv.push('--no-numbers');
    if (o.linestretch) argv.push('--linestretch', String(o.linestretch));
    if (o.mainfont) argv.push('--mainfont', String(o.mainfont));
    if (o.cjkfont) argv.push('--cjkfont', String(o.cjkfont));
    if (o.monofont) argv.push('--monofont', String(o.monofont));
    if (o.highlight) argv.push('--highlight', String(o.highlight));
    if (o.documentclass) argv.push('--documentclass', String(o.documentclass));
    for (const co of o.classoption) argv.push('--classoption', co);
    for (const h of o.includeHeaders) argv.push('-H', h);
    for (const v of o.variables) argv.push('-s', v);
    for (const m of o.metadata) argv.push('-M', m);
    if (o.citeproc) argv.push('--citeproc');
    if (o.bibliography) argv.push('--bibliography', String(o.bibliography));
    if (o.csl) argv.push('--csl', String(o.csl));
    if (o.verbose) argv.push('--verbose');
    if (QUIET) argv.push('--quiet');
    if (o.extra.length) argv.push('--', ...o.extra);

    if (o.dryRun) { out(`${dim('$')} ${formatCommand([MD2PDF, ...argv])}`); return 0; }
    info(`${dim('$')} ${formatCommand([MD2PDF, ...argv])}`);
    const r = await run(MD2PDF, argv, {
      cwd: process.cwd(),
      env: { MD2PDF_HOME: PROJECT_ROOT, SIG_CACHE_DIR: path.join(PROJECT_ROOT, '.cache', 'md2pdf') },
      timeoutMs: 30 * 60 * 1000,
      onLog: (stream, line) => process.stderr.write(line + '\n'),
    });
    if (r.code !== 0) { fail(`md2pdf 退出码 ${r.code}`); return r.code || 1; }
    return 0;
  }

  /* ---------- HTML 路线：本地管线 + 临时内部服务 ---------- */
  let content;
  let baseName;
  if (o.stdin) {
    content = await readStdin();
    baseName = sanitizeName(o.name || o.title || 'stdin');
  } else {
    const onlyFiles = o._.length === 1;
    if (o._.length > 1) {
      // 多文件批处理：并发池。
      // 导出是 CPU 密集（XeLaTeX / Chromium），并发数默认 = min(CPU 核数, 4)，
      // 避免把机器打满反而变慢；`-j 1` 可退回串行。
      const cpus = Math.max(1, os.cpus()?.length || 2);
      const jobs = Math.max(1, Math.min(16, Number(o.jobs) || Math.min(cpus, 4)));
      const files = [...o._];
      const t0 = Date.now();
      info(`${files.length} 个文件 · 并发 ${jobs}${QUIET ? '' : `（CPU ${cpus} 核）`}`);
      // 整批共享一个服务 + 一个 Chromium：唯一的一次冷启动
      const needsServer = files.some(() => to === 'png' || to === 'pdf-html' || (to === 'pdf' && via === 'html'));
      const shared = needsServer
        ? await startServer({ port: 0, quiet: true, warmup: false, concurrency: jobs, log: () => {} })
        : null;
      if (shared && !o.json) info(dim(`共享内部服务 ${shared.url}（整批只起一次 Chromium）`));
      let next = 0;
      let doneCount = 0;
      let rc = 0;
      try {
        await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
          for (;;) {
            const idx = next++;
            if (idx >= files.length) return;
            const f = files[idx];
            const r = await cmdBuildOne(f, null, o, to, via, null, shared);
            if (r !== 0) rc = r;
            doneCount++;
            if (!o.json) info(`${doneCount}/${files.length} 完成`);
          }
        }));
      } finally {
        if (shared) await shared.close().catch(() => {});
      }
      if (!o.json) {
        const ms = Date.now() - t0;
        okmsg(`${files.length} 个文件完成 · ${(ms / 1000).toFixed(1)}s · 平均 ${Math.round(ms / files.length)}ms/个`);
      }
      return rc;
    }
    const f = o._[0];
    if (f === '-') { content = await readStdin(); baseName = sanitizeName(o.name || 'stdin'); }
    else {
      if (!fs.existsSync(f)) { fail(`文件不存在: ${f}`); return 4; }
      content = await fsp.readFile(f, 'utf8');
      baseName = sanitizeName(o.name || (onlyFiles ? path.basename(f).replace(/\.(md|markdown)$/i, '') : 'document'));
    }
  }
  return cmdBuildOne(null, content, o, to, via, baseName);
}

async function cmdBuildOne(file, content, o, to, via, baseName, sharedSrv = null) {
  if (content == null) {
    content = await fsp.readFile(file, 'utf8');
    baseName = sanitizeName(o.name || path.basename(file).replace(/\.(md|markdown)$/i, ''));
  }

  // `--via html -t pdf` 等价于 HTML 路线的 PDF（走 Chromium 打印）
  const target = to === 'pdf' && via === 'html' ? 'pdf-html' : to;

  const spec = normalizeRequest({
    content,
    filename: baseName,
    targets: [target],
    png: { dpi: o.dpi || 200, mode: o.card ? 'card' : 'page', transparent: Boolean(o.transparent), engine: via },
    doc: buildDocOptions(o),
    markdown: buildMarkdownOptions(o),
    latex: buildLatexOptions(o),
    meta: { title: o.title || '', author: o.author || '', date: o.date || '' },
    assetBase: file ? path.dirname(path.resolve(file)) : process.cwd(),
  });

  if (o.dryRun) {
    for (const plan of buildPlanPreview(spec)) out(`${dim('$')} ${plan.command}`);
    return 0;
  }

  // md（纯拷盘）与 html（自包含，不需要浏览器）可以完全离线完成
  const needsServer = target === 'png' || target === 'pdf-html';
  // 批处理时复用调用方给的服务（同一个 Chromium 进程），单文件时才自己起一个。
  // 之前每个文件都起一个临时服务 + 一个 Chromium，8 个文件的批处理几乎全耗在
  // 冷启动上——这是"静默批处理提速"最实在的一处。
  let srv = sharedSrv;
  let ownSrv = false;
  try {
    let result;
    if (needsServer) {
      if (!srv) {
        srv = await startServer({ port: 0, quiet: true, warmup: false, concurrency: 1, log: () => {} });
        ownSrv = true;
        info(dim(`内部服务 ${srv.url}（仅用于把渲染页交给 Chromium，完成后即关闭）`));
      }
      result = await executeRender(spec, {
        log: cliLog(o), chromePool: srv.chromePool, baseUrl: srv.url, jobId: uid(10),
      });
    } else {
      result = await executeRender(spec, { log: cliLog(o), chromePool: null, baseUrl: '', jobId: uid(10) });
    }

    // 把产物搬到用户要的位置
    const written = await placeArtifacts(result.artifacts, { file, o, to });
    if (o.json) {
      out(JSON.stringify({ ok: true, artifacts: written, stats: result.stats, toc: result.toc, elapsedMs: result.elapsedMs }, null, 2));
    }
    return 0;
  } catch (err) {
    if (!o.json) fail(err.message || String(err));
    else out(JSON.stringify({ ok: false, error: err.message, detail: err.detail || null }));
    if (err.detail && !o.json) for (const line of String(err.detail).split('\n').slice(0, 20)) process.stderr.write(dim('    ' + line) + '\n');
    return 1;
  } finally {
    if (srv && ownSrv) await srv.close().catch(() => {});
  }
}

function cliLog(o) {
  // 引擎日志里已经带了 ✓/✗/⚠ 前缀，这里去掉，避免输出「✓ ✓ …」
  const LEAD = /^[✓✗⚠!]\s*/;
  return (level, msg) => {
    if (o.json) return;
    const text = String(msg).replace(LEAD, '');
    switch (level) {
      case 'cmd': out(`${dim('$')} ${text}`); break;
      case 'err': fail(text); break;
      case 'warn': warn(text); break;
      case 'ok': okmsg(text); break;
      case 'debug': if (o.verbose) process.stderr.write(dim('· ' + text) + '\n'); break;
      case 'out': if (o.verbose) process.stderr.write(dim(text) + '\n'); break;
      default: info(text);
    }
  };
}

/** 按 -o / -d / 源文件同目录 的优先级，把产物放到用户期望的位置。 */
async function placeArtifacts(artifacts, { file, o, to }) {
  const written = [];
  const single = artifacts.length === 1;
  for (const a of artifacts) {
    let dest;
    if (o.output && single) {
      dest = path.resolve(o.output);
    } else if (o.outdir) {
      dest = path.resolve(o.outdir, a.name);
    } else if (file) {
      dest = path.join(path.dirname(path.resolve(file)), a.name);
    } else {
      dest = path.resolve(a.name);
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (path.resolve(a.file) !== dest) await fsp.copyFile(a.file, dest);
    const st = await fsp.stat(dest);
    written.push({ ...a, file: dest, bytes: st.size });
    if (!o.json) {
      const extra = a.width ? `${a.width}×${a.height} · ${a.dpi || ''}${a.dpi ? ' DPI · ' : ''}` : '';
      okmsg(`${dest} ${dim(`(${extra}${formatBytes(st.size)})`)}`);
    }
  }
  return written;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

/* ------------------------------------------------------------- serve --- */

async function cmdServe(o) {
  // 方案 B：Python(FastAPI) 分发模式。渲染引擎仍是同一份 Node 实现，
  // 由 Python 进程作为子进程拉起（理由见 server/python/mdp_server.py 顶部）。
  if (o.python) {
    const script = path.join(PROJECT_ROOT, 'server', 'python', 'mdp_server.py');
    if (!fs.existsSync(script)) { fail(`找不到 ${script}`); return 4; }
    const venvPy = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    const argv = [script, '--port', String(o.port ?? 8757)];
    if (o.host) argv.push('--host', String(o.host));
    info(`方案 B：${py} ${argv.join(' ')}`);
    if (!fs.existsSync(venvPy)) {
      warn('未找到 .venv，将使用系统 python3；若缺依赖请先：');
      warn('  python3 -m venv .venv && .venv/bin/pip install -r server/python/requirements.txt');
    }
    const { spawn } = await import('node:child_process');
    const child = spawn(py, argv, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    return await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code ?? 0));
      child.on('error', (err) => { fail(`启动失败：${err.message}`); resolve(4); });
    });
  }

  const srv = await startServer({
    port: o.port ?? 8757,
    host: o.host,
    quiet: QUIET,
    concurrency: o.concurrency ?? 2,
    token: o.token,
    log: (level, msg) => {
      if (level === 'err') fail(msg);
      else if (level === 'warn') warn(msg);
      else if (level === 'debug') { if (o.verbose) process.stderr.write(dim('· ' + msg) + '\n'); }
      else info(msg);
    },
  });

  const caps = await probeCaps().catch(() => null);
  out('');
  out(`  ${bold(magenta('MDP Studio'))} ${dim('v' + VERSION)}  ·  网页工作台已启动`);
  out('');
  out(`  ${bold('本地地址')}   ${cyan(srv.url)}`);
  out(`  ${bold('接口')}       ${dim(srv.url + '/api/health')}`);
  if (caps) {
    out(`  ${bold('引擎')}       pandoc ${caps.engines.pandoc.version || '?'} · LaTeX ${caps.engines.defaultEngine || '未找到'} · Chromium ${caps.chrome.found ? '就绪' : '未找到'}`);
    out(`  ${bold('PNG')}        HTML 路线（Chromium 真 DPI）${caps.raster.highQuality ? ' · LaTeX 路线（' + caps.raster.bestLabel + '）' : dim(' · LaTeX 路线降级为 sips')}`);
  }
  out(`  ${bold('退出')}       Ctrl-C`);
  out('');
  if (caps && (caps.summary.fail || caps.summary.warn)) {
    out(`  ${dim('提示')} ${yellow(`${caps.summary.warn} 项提醒 / ${caps.summary.fail} 项缺失`)}，可在网页「体检」面板或 ${cyan('mdp doctor')} 查看`);
    out('');
  }

  if (o.open && process.stdout.isTTY) {
    const { spawn } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', srv.url] : [srv.url];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
  }

  const shutdown = async () => {
    out('');
    info('正在关闭…');
    await srv.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {});
}

/* ------------------------------------------------------------- clean --- */

async function cmdClean() {
  let removed = 0;
  const dirs = await fsp.readdir(ARTIFACT_DIR, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    await fsp.rm(path.join(ARTIFACT_DIR, d.name), { recursive: true, force: true });
    removed++;
  }
  okmsg(`已清空 ${removed} 个产物目录 (${ARTIFACT_DIR})`);
  return 0;
}

/* -------------------------------------------------------------- main --- */

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const rest = cmd ? argv.slice(1) : argv;
  const o = parseArgs(rest);

  if (o.version || cmd === 'version' || argv.includes('--version')) { out(`${PROG} ${VERSION}`); return 0; }
  if (o.help || cmd === 'help' || (!cmd && !argv.length)) { printHelp(); return 0; }

  switch (cmd) {
    case 'serve': case 'web': case 'studio': return cmdServe(o);
    case 'build': case 'render': case 'make': return cmdBuild(o);
    case 'doctor': return cmdDoctor(o);
    case 'presets': case 'list': return cmdPresets(o);
    case 'routes': return cmdRoutes();
    case 'themes': return cmdThemes();
    case 'clean': return cmdClean();
    default:
      if (cmd) { fail(`未知子命令 ${cmd}`); printHelp(); return 2; }
      printHelp();
      return 0;
  }
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => { fail(err?.stack || String(err)); process.exitCode = 1; });
