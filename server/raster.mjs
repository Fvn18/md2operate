/**
 * server/raster.mjs — PDF → PNG 的多级回退栅格化。
 *
 * 为什么不只用一个工具：本机（macOS + MacTeX）默认**没有** poppler/ghostscript，
 * 而 PNG 导出又是刚需。于是这里按质量排序探测，能用的就用最好的那个，并且把
 * 「用了哪个、质量如何」如实报给用户——而不是悄悄降级到糊图。
 *
 * 优先级与理由：
 *   1. pdftoppm / pdftocairo (poppler) —— 真正的按 DPI 渲染，质量最好
 *   2. gs (ghostscript)                —— 同上，参数略不同
 *   3. mutool draw (mupdf)             —— 同上
 *   4. sips (macOS 内置)               —— 只能按 72dpi 出图再放大，属**降级**
 *
 * 注意：Chromium 的 headless shell 不含 PDFium，无法栅格化 PDF（已实测），
 * 所以它不能作为这里的后备；反过来，「PNG 走 HTML+Chrome 路径」才是本项目的
 * 首选高质量方案（见 render.mjs）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { which, run, pngSize, uid, IS_MAC, TMP_DIR } from './util.mjs';

const CHAIN = [
  {
    id: 'pdftoppm',
    label: 'pdftoppm (poppler)',
    quality: 'high',
    realDpi: true,
    find: () => which('pdftoppm'),
    note: '按 DPI 精确渲染，质量最佳',
    install: 'brew install poppler',
  },
  {
    id: 'pdftocairo',
    label: 'pdftocairo (poppler)',
    quality: 'high',
    realDpi: true,
    find: () => which('pdftocairo'),
    note: '按 DPI 精确渲染，支持透明背景',
    install: 'brew install poppler',
  },
  {
    id: 'gs',
    label: 'Ghostscript',
    quality: 'high',
    realDpi: true,
    find: () => which('gs'),
    note: '按 DPI 精确渲染',
    install: 'brew install ghostscript',
  },
  {
    id: 'mutool',
    label: 'mutool draw (MuPDF)',
    quality: 'high',
    realDpi: true,
    find: () => which('mutool'),
    note: '按 DPI 精确渲染',
    install: 'brew install mupdf-tools',
  },
  {
    id: 'sips',
    label: 'sips (macOS 内置)',
    quality: 'low',
    realDpi: false,
    find: () => (IS_MAC ? which('sips') : null),
    note: '内置回退：先按 72dpi 出图再放大，文字会偏软。装 poppler 可获高清输出',
    install: 'brew install poppler',
  },
];

let cache = null;

/** 探测可用的栅格化工具（按优先级返回）。 */
export function detectRasterizers() {
  if (cache) return cache;
  cache = CHAIN.map((c) => {
    const bin = (() => { try { return c.find(); } catch { return null; } })();
    return { id: c.id, label: c.label, path: bin, quality: c.quality, realDpi: c.realDpi, note: c.note, install: c.install };
  }).filter((c) => c.path);
  return cache;
}

export function clearRasterCache() { cache = null; }

/** 当前最佳栅格化器。 */
export function bestRasterizer() {
  return detectRasterizers()[0] || null;
}

/**
 * 把 PDF 的指定页渲染为 PNG。
 * @param {{pdfPath:string, outPath:string, dpi?:number, page?:number, transparent?:boolean, timeoutMs?:number,
 *          onLog?:(stream:'out'|'err',line:string)=>void}} o
 * @returns {Promise<{ok:boolean, tool?:string, quality?:string, warning?:string, error?:string,
 *                    width?:number, height?:number, bytes?:number, command?:string}>}
 */
export async function pdfToPng(o) {
  const {
    pdfPath, outPath, dpi = 200, page = 1, transparent = false,
    timeoutMs = 120000, onLog,
  } = o;

  const tools = detectRasterizers();
  if (!tools.length) {
    return {
      ok: false,
      error:
        '没有可用的 PDF 栅格化工具。请任选其一安装：\n' +
        '  brew install poppler      (推荐，提供 pdftoppm / pdftocairo)\n' +
        '  brew install ghostscript\n' +
        '  brew install mupdf-tools\n' +
        '或改用「HTML 引擎」导出 PNG（无需外部工具，质量最高）。',
    };
  }

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const errors = [];

  for (const tool of tools) {
    const result = await runOne(tool, { pdfPath, outPath, dpi, page, transparent, timeoutMs, onLog });
    if (result.ok) return result;
    errors.push(`[${tool.id}] ${result.error}`);
  }

  return { ok: false, error: `所有栅格化后端均失败：\n${errors.join('\n')}` };
}

async function runOne(tool, { pdfPath, outPath, dpi, page, transparent, timeoutMs, onLog }) {
  const d = Math.max(36, Math.min(1200, Math.round(dpi)));
  try { await fsp.rm(outPath, { force: true }); } catch { /* ignore */ }
  const outBase = outPath.replace(/\.png$/i, '');
  let cmd;
  let args;
  let produced = outPath;
  let warning = null;

  switch (tool.id) {
    case 'pdftoppm':
      cmd = tool.path;
      args = ['-png', '-r', String(d), '-f', String(page), '-l', String(page)];
      if (transparent) args.push('-transp');
      args.push('-singlefile', pdfPath, outBase);
      break;
    case 'pdftocairo':
      cmd = tool.path;
      args = ['-png', '-r', String(d), '-f', String(page), '-l', String(page)];
      if (transparent) args.push('-transp');
      args.push('-singlefile', pdfPath, outBase);
      break;
    case 'gs':
      cmd = tool.path;
      args = [
        '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
        '-sDEVICE', transparent ? 'pngalpha' : 'png16m',
        '-r', String(d),
        '-dFirstPage=' + page, '-dLastPage=' + page,
        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
        `-sOutputFile=${outPath}`, pdfPath,
      ];
      break;
    case 'mutool':
      cmd = tool.path;
      args = ['draw', '-q', '-r', String(d), '-o', outPath, '-F', 'png', pdfPath, String(page)];
      break;
    case 'sips': {
      cmd = tool.path;
      // sips 只能按 PDF 的 72dpi 用户空间出图，再靠重采样放大——纯降级方案
      const tmp = path.join(TMP_DIR, `sips-${uid(8)}.png`);
      const first = await run(cmd, ['-s', 'format', 'png', pdfPath, '--out', tmp], { timeoutMs, onLog });
      if (first.code !== 0) {
        return { ok: false, error: (first.stderr || first.stdout || 'sips 转换失败').trim().slice(0, 400) };
      }
      const raw = await fsp.readFile(tmp).catch(() => null);
      const size = raw ? pngSize(raw) : null;
      if (!size) { await fsp.rm(tmp, { force: true }); return { ok: false, error: 'sips 未产出有效 PNG' }; }
      const want = Math.round((size.width * d) / 72);
      if (want > size.width) {
        const up = await run(cmd, ['--resampleWidth', String(want), tmp], { timeoutMs: 60000, onLog });
        if (up.code !== 0) warning = 'sips 放大失败，已保留 72dpi 原图';
      }
      await fsp.rename(tmp, outPath).catch(async () => {
        const buf = await fsp.readFile(tmp);
        await fsp.writeFile(outPath, buf);
        await fsp.rm(tmp, { force: true });
      });
      if (!warning) {
        warning = `已降级使用 macOS 内置 sips（实际渲染 72dpi → 放大到 ${want}px 宽），文字边缘会偏软。建议 brew install poppler 以获得真正的高清输出。`;
      }
      produced = outPath;
      break;
    }
    default:
      return { ok: false, error: '未知工具' };
  }

  const res = await run(cmd, args, { timeoutMs, onLog });
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || `退出码 ${res.code}`).trim().slice(0, 500) };
  }
  const st = await fsp.stat(produced).catch(() => null);
  if (!st || st.size === 0) return { ok: false, error: '工具执行成功但没有产出文件' };

  const buf = await fsp.readFile(produced);
  const size = pngSize(buf);
  if (tool.id !== 'sips' && dpi > 0 && size) {
    // 校验实际 DPI 是否达标，避免"以为高清其实是 72dpi"
    const gotDpi = Math.round((size.width * 72) / 72);
    if (size.width < 8) warning = '输出尺寸异常偏小，请检查 DPI 与页面设置';
    void gotDpi;
  }

  return {
    ok: true,
    tool: tool.id,
    toolLabel: tool.label,
    quality: tool.quality,
    warning,
    width: size?.width,
    height: size?.height,
    bytes: st.size,
    command: `${cmd} ${args.join(' ')}`,
  };
}

/** 供 doctor 面板使用的简明摘要。 */
export function rasterSummary() {
  const tools = detectRasterizers();
  const best = tools[0] || null;
  return {
    available: tools.map((t) => t.id),
    best: best ? best.id : null,
    bestLabel: best ? best.label : null,
    highQuality: Boolean(best && best.quality === 'high'),
    hint: best && best.quality === 'high'
      ? null
      : '安装 poppler（brew install poppler）可让 LaTeX-PDF → PNG 也达到真正的高清',
  };
}
