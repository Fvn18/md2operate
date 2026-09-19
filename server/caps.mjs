/**
 * server/caps.mjs — 能力探测（相当于 `md2pdf doctor` 的机器可读版本）。
 *
 * 网页端的「体检」面板、CLI 的 `mdp doctor`、以及渲染前的预检都走这里，
 * 保证「实际会用到的工具链」和「用户看到的报告」是同一份事实。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_DIR, CACHE_DIR, MD2PDF, PROJECT_ROOT, WEB_DIST, which, run, capture, IS_MAC,
} from './util.mjs';
import { findChrome, chromeVersion } from './chrome.mjs';
import { detectRasterizers, rasterSummary } from './raster.mjs';

const FIRST_LINE = (s) => (s || '').trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 160);

async function toolVersion(cmd, args = ['--version'], timeoutMs = 8000) {
  if (!cmd) return null;
  const r = await run(cmd, args, { timeoutMs });
  const text = FIRST_LINE(r.stdout) || FIRST_LINE(r.stderr);
  return text || null;
}

/** LaTeX 引擎清单（与 md2pdf 的 pick_engine 保持一致）。 */
const LATEX_ENGINES = ['xelatex', 'lualatex', 'pdflatex', 'tectonic'];

const CJK_CANDIDATES = [
  'PingFang SC', 'Songti SC', 'Heiti SC', 'Kaiti SC', 'Hiragino Sans GB',
  'Noto Sans CJK SC', 'Noto Serif CJK SC', 'Source Han Sans SC', 'Microsoft YaHei', 'SimSun', 'WenQuanYi Micro Hei',
];

let cache = null;
let cacheAt = 0;
const TTL = 20000;

/**
 * @param {{force?:boolean}} [opts]
 */
export async function probeCaps(opts = {}) {
  if (!opts.force && cache && Date.now() - cacheAt < TTL) return cache;

  const [
    pandocPath, latexPaths, chromeInfo, md2pdfVersion,
  ] = await Promise.all([
    Promise.resolve(which('pandoc')),
    Promise.all(LATEX_ENGINES.map(async (e) => [e, which(e)])),
    Promise.resolve(findChrome()),
    Promise.resolve(MD2PDF),
  ]);

  const [pandocVersion, latexVersions, chromeVer] = await Promise.all([
    toolVersion(pandocPath),
    Promise.all(latexPaths.map(async ([e, p]) => [e, p, p ? await toolVersion(p) : null])),
    chromeInfo ? chromeVersion(chromeInfo.path) : Promise.resolve(null),
  ]);

  const engines = {};
  for (const [name, p, v] of latexVersions) engines[name] = { found: Boolean(p), path: p, version: v };
  const engineOrder = LATEX_ENGINES.filter((e) => engines[e]?.found);

  const tools = {};
  for (const t of ['qpdf', 'dvipng', 'dvisvgm', 'fswatch', 'sips', 'img2pdf', 'python3', 'fc-list', 'mdls']) {
    tools[t] = which(t);
  }

  // CJK 字体：macOS 上 PingFang SC 由 CoreText 提供，fontconfig 常常看不到
  let cjkFonts = [];
  if (tools['fc-list']) {
    const r = await run(tools['fc-list'], [':', 'family'], { timeoutMs: 10000 });
    const families = new Set(
      r.stdout.split('\n').flatMap((l) => l.split(',')).map((s) => s.trim()).filter(Boolean),
    );
    cjkFonts = CJK_CANDIDATES.filter((f) => families.has(f));
  }
  if (!cjkFonts.length && IS_MAC) cjkFonts = ['PingFang SC', 'Songti SC', 'Heiti SC', 'Kaiti SC'].filter((f) => {
    // 粗判：macOS 10.11+ 一定有 PingFang SC；其它按 /System/Library/Fonts 粗查
    if (f === 'PingFang SC') return true;
    return false;
  });

  const md2pdfExists = (() => { try { fs.accessSync(MD2PDF, fs.constants.X_OK); return true; } catch { return false; } })();
  const webBuilt = fs.existsSync(path.join(WEB_DIST, 'index.html'));

  let artifactsWritable = false;
  try {
    await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
    await fsp.access(ARTIFACT_DIR, fs.constants.W_OK);
    artifactsWritable = true;
  } catch { /* 只读 */ }

  const rasterizers = detectRasterizers();
  const raster = rasterSummary();

  /* ------------------------------------------------------------ 检查项 -- */
  const checks = [];
  const add = (id, group, label, status, detail, hint) =>
    checks.push({ id, group, label, status, detail: detail || null, hint: hint || null });

  add('node', '运行时', 'Node.js', Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'warn',
    `v${process.versions.node} · ${process.platform}/${process.arch}`,
    Number(process.versions.node.split('.')[0]) >= 20 ? null : '需要 Node ≥ 20（内置全局 WebSocket）');

  add('pandoc', '引擎', 'pandoc', pandocPath ? 'ok' : 'fail',
    pandocVersion || (pandocPath ? pandocPath : '未找到'),
    pandocPath ? null : 'brew install pandoc');

  add('md2pdf', '引擎', 'md2pdf 脚本', md2pdfExists ? 'ok' : 'fail',
    md2pdfExists ? `${MD2PDF}${md2pdfVersion ? '' : ''}` : '未找到或不可执行',
    md2pdfExists ? null : '确认 md2pdf 存在且 chmod +x');

  add('latex', '引擎', 'LaTeX 引擎', engineOrder.length ? 'ok' : 'fail',
    engineOrder.length ? engineOrder.map((e) => `${e} (${engines[e].version || '?'})`).join(' · ') : '未找到任何 LaTeX 引擎',
    engineOrder.length ? null : 'brew install --cask mactex-no-gui  或  brew install tectonic');

  add('chrome', '光栅化', 'Chromium (PNG 首选引擎)', chromeInfo ? 'ok' : 'warn',
    chromeInfo ? `${chromeVer || 'Chrome'} · ${chromeInfo.source}` : '未找到 Chromium/Chrome',
    chromeInfo ? null : 'HTML 路线的高清 PNG/PDF 需要它；可设 MDP_CHROME 指定路径，或 npm i -D playwright && npx playwright install chromium-headless-shell');

  add('raster', '光栅化', 'PDF → PNG 栅格化器', raster.highQuality ? 'ok' : (rasterizers.length ? 'warn' : 'warn'),
    rasterizers.length
      ? `当前使用：${raster.bestLabel}${raster.highQuality ? '（精确 DPI）' : '（降级：72dpi 放大）'}`
      : '无可用栅格化器',
    raster.hint);

  add('cjk', '排版', '中文字体', cjkFonts.length ? 'ok' : 'warn',
    cjkFonts.length ? cjkFonts.join(' · ') : '未检测到常见中文字体',
    cjkFonts.length ? null : '中文文档建议安装 Noto Sans CJK 或使用 macOS 自带 PingFang SC');

  add('web', '前端', '网页资源 (web/dist)', webBuilt ? 'ok' : 'warn',
    webBuilt ? '已构建' : '尚未构建（npm run build）',
    webBuilt ? null : '运行 npm run build 生成 web/dist，或使用 npm run dev 开发模式');

  add('artifacts', '存储', '产物目录可写', artifactsWritable ? 'ok' : 'fail',
    ARTIFACT_DIR, artifactsWritable ? null : '检查目录权限');

  add('cache', '存储', '缓存/临时目录', (() => { try { fs.accessSync(CACHE_DIR, fs.constants.W_OK); return 'ok'; } catch { return 'warn'; } })(),
    CACHE_DIR, null);

  add('qpdf', '排版', 'qpdf（PDF 校验）', tools.qpdf ? 'ok' : 'warn',
    tools.qpdf || '未安装（可选）', tools.qpdf ? null : 'brew install qpdf');

  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };

  cache = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      hostname: os.hostname(),
      projectRoot: PROJECT_ROOT,
      artifactDir: ARTIFACT_DIR,
      cacheDir: CACHE_DIR,
      webBuilt,
      uptimeSec: Math.round(process.uptime()),
    },
    engines: {
      pandoc: { found: Boolean(pandocPath), path: pandocPath, version: pandocVersion },
      latex: engines,
      latexOrder: engineOrder,
      defaultEngine: engineOrder[0] || null,
      tectonic: engines.tectonic?.found ? engines.tectonic.version : null,
    },
    chrome: chromeInfo ? { found: true, path: chromeInfo.path, source: chromeInfo.source, kind: chromeInfo.kind, version: chromeVer } : { found: false },
    raster,
    rasterizers,
    fonts: { fcList: Boolean(tools['fc-list']), cjk: cjkFonts },
    tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v ? { found: true, path: v } : { found: false }])),
    checks,
    summary,
  };
  cacheAt = Date.now();
  return cache;
}

/** 渲染前的硬性预检：返回阻止渲染的原因数组。 */
export async function preflight(target) {
  const caps = await probeCaps();
  const blockers = [];
  if (!caps.engines.pandoc.found) blockers.push({ id: 'pandoc', message: '未找到 pandoc，无法渲染任何格式', hint: 'brew install pandoc' });

  if (target === 'pdf' || target === 'png-latex' || target === 'tex') {
    if (!caps.md2pdf) blockers.push({ id: 'md2pdf', message: 'md2pdf 脚本不可用', hint: '检查 md2pdf 权限' });
  }
  if (target === 'pdf' || target === 'png-latex') {
    if (!caps.engines.latexOrder.length) blockers.push({ id: 'latex', message: '未找到 LaTeX 引擎，无法生成 TeX 级 PDF', hint: 'brew install --cask mactex-no-gui' });
  }
  if (target === 'png' || target === 'pdf-html') {
    if (!caps.chrome.found) blockers.push({ id: 'chrome', message: '未找到 Chromium/Chrome，HTML 路线不可用', hint: '设置 MDP_CHROME 或安装 Chrome' });
  }
  return { caps, blockers };
}

export function invalidateCaps() { cache = null; cacheAt = 0; }
