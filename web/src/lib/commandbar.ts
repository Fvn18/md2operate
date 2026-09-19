/**
 * web/src/lib/commandbar.ts — 把 md2pdf / mdp 风格的命令行**原样搬进网页**。
 *
 * 这是"保留终端代码式操作"的落点：图形界面提供全部能力，但熟悉 CLI 的人可以
 * 直接在命令栏敲 `-q cn --toc --dpi 400 -t png,pdf`，或 `:render` / `:clear`。
 * 解析结果只产出「设置补丁」，不直接改状态，因此命令栏与表单永远同源。
 */

import type { Target } from './types';

export interface CommandResult {
  ok: boolean;
  message: string;
  patch?: Record<string, any>;
  ui?: Record<string, any>;
  action?: 'render' | 'clear' | 'doctor' | 'cleanup' | 'help' | 'save' | 'new' | 'clean' | 'examples';
  targets?: Target[];
  insert?: string;
  /** 需要插入到光标处并删除的占位标记 */
  carets?: string;
}

const TARGET_ALIASES: Record<string, Target> = {
  png: 'png', image: 'png', img: 'png',
  pdf: 'pdf',
  'pdf-html': 'pdf-html', htmlpdf: 'pdf-html', chromium: 'pdf-html',
  tex: 'tex', latex: 'tex',
  html: 'html', htm: 'html',
  docx: 'docx', word: 'docx',
  md: 'md', markdown: 'md',
};

/** 拆分参数，支持单/双引号。 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * 解析一行命令。
 * @param input 原始输入
 * @param known 已加载的档位 id 列表（用于友好报错）
 */
export function parseCommand(input: string, known: { presets: string[]; themes: string[]; papers: string[] }): CommandResult {
  const raw = input.trim();
  if (!raw) return { ok: false, message: '' };

  /* ---- 冒号动作 ---- */
  if (raw.startsWith(':')) {
    const [head, ...restArgs] = tokenize(raw.slice(1));
    const cmd = head.toLowerCase();
    const arg = restArgs.join(' ');
    switch (cmd) {
      case 'render': case 'r': case 'build': case 'w': case 'write':
        return { ok: true, message: '开始渲染…', action: 'render' };
      case 'clear': case 'cls':
        return { ok: true, message: '已清空控制台', action: 'clear' };
      case 'doctor': case 'caps':
        return { ok: true, message: '打开环境体检', action: 'doctor' };
      case 'cleanup': case 'clean':
        return { ok: true, message: '清理产物目录', action: 'cleanup' };
      case 'examples': case 'example':
        return { ok: true, message: '打开示例库', action: 'examples' };
      case 'save':
        return { ok: true, message: '已保存到浏览器本地', action: 'save' };
      case 'new':
        return { ok: true, message: '新建文档', action: 'new' };
      case 'help': case 'h': case '?':
        return { ok: true, message: '', action: 'help' };
      case 'theme': {
        if (!arg) return { ok: false, message: '用法: :theme paper|github|academic|sepia|ink|nord|mono' };
        if (!known.themes.includes(arg)) return { ok: false, message: `未知主题 ${arg}（可用: ${known.themes.join(' ')}）` };
        return { ok: true, message: `文档主题 → ${arg}`, patch: { doc: { theme: arg } } };
      }
      case 'app': {
        if (!['dark', 'light', 'sepia'].includes(arg)) return { ok: false, message: '用法: :app dark|light|sepia' };
        return { ok: true, message: `界面主题 → ${arg}`, ui: { appTheme: arg } };
      }
      case 'target': {
        const targets = arg.split(/[,\s]+/).map((s) => TARGET_ALIASES[s.toLowerCase()]).filter(Boolean) as Target[];
        if (!targets.length) return { ok: false, message: '用法: :target png,pdf' };
        return { ok: true, message: `导出目标 → ${targets.join(' + ')}`, targets };
      }
      case 'name':
        if (!arg) return { ok: false, message: '用法: :name 我的文档' };
        return { ok: true, message: `文件名 → ${arg}`, patch: { filename: arg } };
      default:
        return { ok: false, message: `未知命令 :${cmd}（可用 :render :clear :doctor :theme :app :target :name :save :new :help）` };
    }
  }

  /* ---- 参数式（md2pdf 风格）---- */
  const toks = tokenize(raw);
  const patch: Record<string, any> = { doc: {}, png: {}, latex: {}, markdown: {}, meta: {} };
  const ui: Record<string, any> = {};
  let targets: Target[] | undefined;
  const messages: string[] = [];

  const setDoc = (k: string, v: any) => { patch.doc[k] = v; };
  const setPng = (k: string, v: any) => { patch.png[k] = v; };
  const setTex = (k: string, v: any) => { patch.latex[k] = v; };
  const setMd = (k: string, v: any) => { patch.markdown[k] = v; };
  const setMeta = (k: string, v: any) => { patch.meta[k] = v; };

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const eq = /^--?([A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(tok);
    const key = eq ? `--${eq[1]}` : tok;
    const inline = eq ? eq[2] : undefined;
    const val = () => (inline !== undefined ? inline : toks[++i]);
    const missing = (name: string): CommandResult => ({ ok: false, message: `${name} 需要一个值` });

    switch (key) {
      case '-t': case '--to': {
        const v = val();
        if (v === undefined) return missing(key);
        const list = v.split(',').map((s) => TARGET_ALIASES[s.toLowerCase()]).filter(Boolean) as Target[];
        if (!list.length) return { ok: false, message: `未知输出格式 ${v}（可用: png pdf pdf-html tex html docx md）` };
        targets = list;
        break;
      }
      case '-q': case '--quality': case '--preset': {
        const v = val();
        if (v === undefined) return missing(key);
        if (known.presets.length && !known.presets.includes(v)) {
          return { ok: false, message: `未知档位 ${v}（可用: ${known.presets.join(' ')}）` };
        }
        setTex('preset', v);
        break;
      }
      case '-e': case '--engine': {
        const v = val();
        if (v === undefined) return missing(key);
        if (v === 'html' || v === 'latex') setPng('engine', v);
        else setTex('engine', v);
        break;
      }
      case '--via': {
        const v = val();
        if (v !== 'html' && v !== 'latex') return { ok: false, message: '--via 只接受 html | latex' };
        setPng('engine', v);
        break;
      }
      case '--dpi': {
        const v = num(val());
        if (v === undefined) return missing(key);
        setPng('dpi', Math.max(36, Math.min(1200, v)));
        messages.push(`${v} DPI`);
        break;
      }
      case '--page': {
        const v = num(val());
        if (v === undefined) return missing(key);
        setPng('page', Math.max(1, v));
        break;
      }
      case '--card': setPng('mode', 'card'); setDoc('card', true); break;
      case '--page-mode': case '--no-card': setPng('mode', 'page'); setDoc('card', false); break;
      case '--transparent': setPng('transparent', true); setDoc('transparent', true); break;
      case '--opaque': setPng('transparent', false); setDoc('transparent', false); break;
      case '--theme': {
        const v = val();
        if (v === undefined) return missing(key);
        if (!known.themes.includes(v)) return { ok: false, message: `未知主题 ${v}（可用: ${known.themes.join(' ')}）` };
        setDoc('theme', v);
        break;
      }
      case '--paper': {
        const v = val();
        if (v === undefined) return missing(key);
        if (!known.papers.includes(v)) return { ok: false, message: `未知纸张 ${v}（可用: ${known.papers.join(' ')}）` };
        setDoc('paper', v);
        break;
      }
      case '--margin': { const v = num(val()); if (v === undefined) return missing(key); setDoc('margin', v); break; }
      case '--width': { const v = num(val()); if (v === undefined) return missing(key); setDoc('contentWidth', v); break; }
      case '--font-size': case '--fontsize-px': { const v = num(val()); if (v === undefined) return missing(key); setDoc('fontSize', v); break; }
      case '--line-height': { const v = num(val()); if (v === undefined) return missing(key); setDoc('lineHeight', v); break; }
      case '--card-pad': { const v = num(val()); if (v === undefined) return missing(key); setDoc('cardPadding', v); break; }
      case '--accent': { const v = val(); if (v === undefined) return missing(key); setDoc('accent', v); break; }
      case '--code-theme': { const v = val(); if (v === undefined) return missing(key); setDoc('codeTheme', v); break; }
      case '--justify': setDoc('justify', true); break;
      case '--indent': { const v = val(); if (v === undefined) return missing(key); setDoc('paragraphIndent', Number.isFinite(Number(v)) ? Number(v) : v); break; }
      case '--title': { const v = val(); if (v === undefined) return missing(key); setMeta('title', v); setDoc('title', v); break; }
      case '--author': { const v = val(); if (v === undefined) return missing(key); setMeta('author', v); setDoc('author', v); break; }
      case '--date': { const v = val(); if (v === undefined) return missing(key); setMeta('date', v); setDoc('date', v); break; }
      case '--no-meta': setDoc('showMeta', false); break;
      case '--meta': setDoc('showMeta', true); break;
      case '--name': { const v = val(); if (v === undefined) return missing(key); patch.filename = v; break; }
      case '--toc': setTex('toc', true); break;
      case '--no-toc': setTex('toc', false); break;
      case '--toc-depth': { const v = num(val()); if (v === undefined) return missing(key); setTex('tocDepth', v); break; }
      case '--embed-toc': setMd('tocEmbed', true); break;
      case '--numbers': setTex('numbers', true); break;
      case '--no-numbers': setTex('numbers', false); break;
      case '--numbering': setMd('numbering', true); break;
      case '--breaks': setMd('breaks', true); break;
      case '--no-breaks': setMd('breaks', false); break;
      case '--line-numbers': setMd('lineNumbers', true); break;
      case '--typographer': setMd('typographer', true); break;
      case '--linestretch': { const v = val(); if (v === undefined) return missing(key); setTex('linestretch', v); break; }
      case '--mainfont': { const v = val(); if (v === undefined) return missing(key); setTex('mainfont', v); break; }
      case '--cjkfont': { const v = val(); if (v === undefined) return missing(key); setTex('cjkfont', v); break; }
      case '--monofont': { const v = val(); if (v === undefined) return missing(key); setTex('monofont', v); break; }
      case '--highlight': { const v = val(); if (v === undefined) return missing(key); setTex('highlight', v); break; }
      case '--documentclass': { const v = val(); if (v === undefined) return missing(key); setTex('documentclass', v); break; }
      case '--colorlinks': setTex('colorlinks', true); break;
      case '--no-colorlinks': setTex('colorlinks', false); break;
      case '--keep': setTex('keepTex', true); break;
      case '--vim': ui.vim = true; break;
      case '--no-vim': ui.vim = false; break;
      case '--preview': ui.showPreview = true; break;
      case '--no-preview': ui.showPreview = false; break;
      case '--app-theme': { const v = val(); if (v === undefined) return missing(key); ui.appTheme = v; break; }
      case '--insert': { const v = val(); if (v === undefined) return missing(key); return { ok: true, message: '已插入', insert: v }; }
      case '--': break;
      default:
        return { ok: false, message: `未知参数 ${tok}（输入 :help 查看可用参数）` };
    }
  }

  const summary: string[] = [];
  if (targets) summary.push(`目标 ${targets.join('+')}`);
  if (patch.png?.dpi) summary.push(`${patch.png.dpi} DPI`);
  if (patch.png?.mode) summary.push(patch.png.mode === 'card' ? '卡片' : '整页');
  if (patch.latex?.preset) summary.push(`档位 ${patch.latex.preset}`);
  if (patch.doc?.theme) summary.push(`主题 ${patch.doc.theme}`);
  if (patch.latex?.toc === true) summary.push('目录');

  return {
    ok: true,
    message: summary.length ? `已应用：${summary.join(' · ')}` : '已应用',
    patch,
    ui: Object.keys(ui).length ? ui : undefined,
    targets,
  };
}

/** 命令提示（命令栏下方的小按钮）。 */
export const COMMAND_HINTS = [
  '-q cn --toc --numbers',
  '--dpi 600 --card --theme ink',
  '-t png,pdf --via latex',
  '--dpi 150 --page-mode --paper A4',
  '--numbering --embed-toc',
  ':target png,pdf,tex',
  ':theme academic',
  ':render',
];
