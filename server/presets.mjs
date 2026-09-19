/**
 * server/presets.mjs — 质量档位的**唯一事实来源**桥接层。
 *
 * 档位定义本来就写在 md2pdf 的 `preset_load()` 里。与其在 Node 侧抄一份（必然
 * 会漂移），不如让脚本自己吐 JSON：`md2pdf list --json`。没有 node 或脚本不可用
 * 时，才退回下面这份兜底表，保证网页仍能打开。
 */

import { MD2PDF, run } from './util.mjs';

/** 兜底表：字段与 `md2pdf list --json` 对齐。 */
const FALLBACK = {
  version: '1.0.0',
  defaultQuality: 'std',
  engine: 'xelatex',
  pandoc: null,
  rasterizer: null,
  targets: ['pdf', 'png', 'html', 'docx', 'tex', 'epub', 'pptx'],
  presets: [
    { id: 'draft', aliases: 'fast q0', desc: '极速草稿', fontsize: '10pt', margin: '0.8in', linestretch: '1.0', toc: false, tocDepth: 2, numbers: false, colorlinks: 0, documentclass: 'article', classoption: '', highlight: 'kate', geomExtra: '', include: '', beamer: false },
    { id: 'std', aliases: 'standard normal q1', desc: '标准(默认)', fontsize: '11pt', margin: '1.2in', linestretch: '', toc: false, tocDepth: 2, numbers: true, colorlinks: 0, documentclass: 'article', classoption: '', highlight: 'tango', geomExtra: '', include: '', beamer: false },
    { id: 'high', aliases: 'hq q2', desc: '高质量论文', fontsize: '11pt', margin: '1.0in', linestretch: '1.25', toc: true, tocDepth: 3, numbers: true, colorlinks: 1, documentclass: 'article', classoption: '', highlight: 'tango', geomExtra: 'headheight=15pt', include: '', beamer: false },
    { id: 'press', aliases: 'print q3', desc: '印刷排版(双面)', fontsize: '12pt', margin: '1.0in', linestretch: '1.3', toc: true, tocDepth: 2, numbers: true, colorlinks: 2, documentclass: 'article', classoption: 'twoside', highlight: 'tango', geomExtra: 'bindingoffset=0.2in,headheight=16pt', include: '', beamer: false },
    { id: 'cn', aliases: 'paper thesis q4', desc: '中文论文 (ctex)', fontsize: '', margin: '1.1in', linestretch: '', toc: true, tocDepth: 2, numbers: true, colorlinks: 1, documentclass: 'ctexart', classoption: 'zihao=-4', highlight: 'tango', geomExtra: '', include: '', beamer: false },
    { id: 'screen', aliases: 'web ebook q5', desc: '屏幕阅读', fontsize: '11pt', margin: '0.9in', linestretch: '1.35', toc: true, tocDepth: 3, numbers: true, colorlinks: 1, documentclass: 'article', classoption: '', highlight: 'tango', geomExtra: '', include: '', beamer: false },
    { id: 'slides', aliases: 'beamer q6', desc: 'Beamer 幻灯片', fontsize: '', margin: '', linestretch: '', toc: false, tocDepth: 2, numbers: false, colorlinks: 1, documentclass: 'beamer', classoption: '', highlight: 'tango', geomExtra: '', include: '', beamer: true },
  ],
  engines: ['xelatex', 'lualatex', 'pdflatex'],
};

let cache = null;
let cacheAt = 0;
const TTL = 60_000;

/**
 * 读取档位表（带缓存）。
 * @param {{force?:boolean, onLog?:(s:'out'|'err',l:string)=>void}} [opts]
 */
export async function getPresets(opts = {}) {
  if (!opts.force && cache && Date.now() - cacheAt < TTL) return cache;
  let data = null;
  try {
    const r = await run(MD2PDF, ['list', '--json'], { timeoutMs: 15000 });
    if (r.code === 0) {
      const line = r.stdout.trim().split('\n').filter(Boolean).pop();
      data = JSON.parse(line);
    } else if (opts.onLog) {
      opts.onLog('err', `md2pdf list --json 失败(code=${r.code})，使用内置兜底档位表`);
    }
  } catch (err) {
    if (opts.onLog) opts.onLog('err', `读取档位表失败：${err.message}，使用内置兜底档位表`);
  }
  cache = data && Array.isArray(data.presets) && data.presets.length ? data : FALLBACK;
  cacheAt = Date.now();
  return cache;
}

export function findPreset(presets, id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  return (presets?.presets || []).find(
    (p) => p.id === want || String(p.aliases || '').split(/\s+/).includes(want),
  ) || null;
}

export function invalidatePresets() { cache = null; cacheAt = 0; }

/**
 * 网页工作台支持的导出路线。
 * 与「质量档位」正交：档位决定 **LaTeX 侧**排版，路线决定 **用什么引擎产出什么**。
 */
export const EXPORT_ROUTES = [
  {
    id: 'png',
    label: 'PNG 图片',
    icon: 'image',
    ext: 'png',
    engine: 'html',
    blurb: 'KaTeX + Chromium 真 DPI 截图，质量最高，适合分享与插入 PPT',
    supports: ['dpi', 'card', 'transparent', 'theme'],
  },
  {
    id: 'pdf',
    label: 'PDF · LaTeX',
    icon: 'file-text',
    ext: 'pdf',
    engine: 'latex',
    blurb: 'pandoc + XeLaTeX，最专业的排版，论文/讲义首选',
    supports: ['preset', 'engine', 'toc', 'numbers', 'fonts', 'paper'],
  },
  {
    id: 'pdf-html',
    label: 'PDF · HTML',
    icon: 'file-text',
    ext: 'pdf',
    engine: 'html',
    blurb: 'Chromium 打印，秒级出稿，样式与预览完全一致',
    supports: ['paper', 'card', 'theme', 'dpi'],
  },
  {
    id: 'tex',
    label: 'TeX 源码',
    icon: 'code',
    ext: 'tex',
    engine: 'latex',
    blurb: '只做 pandoc 转换，产出可继续手工编辑的 .tex',
    supports: ['preset', 'toc', 'numbers'],
  },
  {
    id: 'html',
    label: 'HTML 单文件',
    icon: 'globe',
    ext: 'html',
    engine: 'html',
    blurb: '自包含（内联 KaTeX 字体与样式），双击即可离线打开',
    supports: ['theme'],
  },
  {
    id: 'docx',
    label: 'Word 文档',
    icon: 'file-type',
    ext: 'docx',
    engine: 'latex',
    blurb: '交给 Word 继续修改，注意 LaTeX 专属排版会丢失',
    supports: [],
  },
  {
    id: 'md',
    label: 'Markdown 源文件',
    icon: 'file-code',
    ext: 'md',
    engine: 'none',
    blurb: '把当前编辑器内容原样存盘（等价于「另存为」）',
    supports: [],
  },
];

export function findRoute(id) {
  return EXPORT_ROUTES.find((r) => r.id === id) || null;
}
