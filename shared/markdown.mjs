/**
 * shared/markdown.mjs
 * ============================================================================
 *  MDP Studio 的核心渲染器：**同一份代码同时运行在浏览器与 Node 服务端**。
 *
 *  这是整个项目 WYSIWYG 保证的关键：网页右侧的实时预览、导出 PNG/PDF/HTML
 *  所用的 HTML，都由这里的 `renderMarkdown()` 产生，只是注入的样式表和作用域
 *  不同。因此「预览里长什么样，导出来就是什么样」不是靠两套代码对齐，而是
 *  结构上不可能不一致。
 *
 *  本文件必须保持 **纯 ESM + 无平台 API**：不得 import node:*，不得触碰 DOM。
 *
 *  功能一览：
 *    · 数学：$$…$$ / \[…\]（块级），$…$ / \(…\)（行内），带货币符号防误判
 *    · 代码：highlight.js 高亮 + 语言标签 + 复制按钮 + 可选行号
 *    · 容器：::: note / tip / theorem / proof / 定理 / 证明 … 中英双语别名
 *    · 自动编号：定理/引理/命题/推论/定义/例 可自动编号
 *    · 标题锚点 + 目录树提取（供侧栏大纲与 TOC 使用）
 *    · 统计信息与错误收集（KaTeX 报错不会打断整篇渲染）
 * ============================================================================
 */

import MarkdownIt from 'markdown-it';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import hljsLatex from 'highlight.js/lib/languages/latex';
import hljsJulia from 'highlight.js/lib/languages/julia';
import hljsMatlab from 'highlight.js/lib/languages/matlab';
import hljsFortran from 'highlight.js/lib/languages/fortran';
import hljsHaskell from 'highlight.js/lib/languages/haskell';
import hljsOcaml from 'highlight.js/lib/languages/ocaml';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsPowershell from 'highlight.js/lib/languages/powershell';
import hljsNginx from 'highlight.js/lib/languages/nginx';
import footnote from 'markdown-it-footnote';
import deflist from 'markdown-it-deflist';
import taskLists from 'markdown-it-task-lists';

hljs.registerLanguage('latex', hljsLatex);
hljs.registerLanguage('tex', hljsLatex);
hljs.registerLanguage('julia', hljsJulia);
hljs.registerLanguage('matlab', hljsMatlab);
hljs.registerLanguage('fortran', hljsFortran);
hljs.registerLanguage('haskell', hljsHaskell);
hljs.registerLanguage('ocaml', hljsOcaml);
hljs.registerLanguage('dockerfile', hljsDockerfile);
hljs.registerLanguage('powershell', hljsPowershell);
hljs.registerLanguage('nginx', hljsNginx);

/* ------------------------------------------------------------------ 常量 --- */

/** 容器（callout）种类定义：中英别名 → 规范化种类。 */
const CALLOUT_ALIASES = {
  // 提示类
  note: 'note', 注: 'note', 注记: 'note', 备注: 'note', 说明: 'note',
  info: 'info', 信息: 'info',
  tip: 'tip', 提示: 'tip', 技巧: 'tip',
  important: 'important', 重要: 'important',
  warning: 'warning', warn: 'warning', 警告: 'warning', 注意: 'warning',
  danger: 'danger', error: 'danger', 危险: 'danger', 错误: 'danger',
  success: 'success', 成功: 'success', 结论: 'success',
  quote: 'quote', 引用: 'quote',
  // 数学写作
  theorem: 'theorem', 定理: 'theorem',
  lemma: 'lemma', 引理: 'lemma',
  proposition: 'proposition', prop: 'proposition', 命题: 'proposition',
  corollary: 'corollary', 推论: 'corollary',
  definition: 'definition', def: 'definition', 定义: 'definition',
  axiom: 'axiom', 公理: 'axiom',
  proof: 'proof', 证明: 'proof', 证: 'proof',
  remark: 'remark', 注2: 'remark', 评注: 'remark',
  example: 'example', 例: 'example', 例子: 'example', 例题: 'example',
  exercise: 'exercise', 练习: 'exercise', 习题: 'exercise',
  algorithm: 'algorithm', 算法: 'algorithm',
  solution: 'solution', 解: 'solution', 解答: 'solution',
};

/** 种类 → 视觉与文案。icon 用朴素字符，避免额外字体依赖。 */
const CALLOUT_META = {
  note:        { cls: 'note',        zh: '注',       en: 'Note',        icon: '✎', numberable: false },
  info:        { cls: 'info',        zh: '信息',     en: 'Info',        icon: 'i', numberable: false },
  tip:         { cls: 'tip',         zh: '提示',     en: 'Tip',         icon: '✦', numberable: false },
  important:   { cls: 'important',   zh: '重要',     en: 'Important',   icon: '★', numberable: false },
  warning:     { cls: 'warning',     zh: '注意',     en: 'Warning',     icon: '!', numberable: false },
  danger:      { cls: 'danger',      zh: '危险',     en: 'Danger',      icon: '✖', numberable: false },
  success:     { cls: 'success',     zh: '结论',     en: 'Result',      icon: '✓', numberable: false },
  quote:       { cls: 'quote',       zh: '引用',     en: 'Quote',       icon: '❝', numberable: false },
  theorem:     { cls: 'theorem',     zh: '定理',     en: 'Theorem',     icon: '◆', numberable: true  },
  lemma:       { cls: 'lemma',       zh: '引理',     en: 'Lemma',       icon: '◇', numberable: true  },
  proposition: { cls: 'proposition', zh: '命题',     en: 'Proposition', icon: '◈', numberable: true  },
  corollary:   { cls: 'corollary',   zh: '推论',     en: 'Corollary',   icon: '◊', numberable: true  },
  definition:  { cls: 'definition',  zh: '定义',     en: 'Definition',  icon: '≡', numberable: true  },
  axiom:       { cls: 'axiom',       zh: '公理',     en: 'Axiom',       icon: '⊢', numberable: true  },
  example:     { cls: 'example',     zh: '例',       en: 'Example',     icon: '∴', numberable: true  },
  exercise:    { cls: 'exercise',    zh: '练习',     en: 'Exercise',    icon: '✍', numberable: true  },
  algorithm:   { cls: 'algorithm',   zh: '算法',     en: 'Algorithm',   icon: '⚙', numberable: true  },
  proof:       { cls: 'proof',       zh: '证明',     en: 'Proof',       icon: '□', numberable: false },
  remark:      { cls: 'remark',      zh: '评注',     en: 'Remark',      icon: '※', numberable: false },
  solution:    { cls: 'solution',    zh: '解',       en: 'Solution',    icon: '→', numberable: false },
};

/** 有编号的种类的计数顺序（决定了「定理 1 / 引理 2」的编号布局）。 */
const NUMBERING_ORDER = [
  'theorem', 'lemma', 'proposition', 'corollary',
  'definition', 'axiom', 'example', 'exercise', 'algorithm',
];

/** UI 中暴露的 Markdown 行为开关（网页端「排版」面板据此渲染控件）。 */
export const MARKDOWN_FLAGS = [
  { key: 'breaks',     label: '软换行即换行',      hint: '单个换行渲染成 <br>，写中文笔记更顺手', def: false },
  { key: 'typographer', label: '智能标点',          hint: '直引号转弯引号、(c) 转 ©、-- 转破折号', def: false },
  { key: 'linkify',    label: '自动识别链接',      hint: '裸 http(s):// 文本自动变成链接',        def: true  },
  { key: 'numbering',  label: '定理自动编号',      hint: '定理/引理/命题/推论/定义/例 自动编号',  def: false },
  { key: 'footnotes',  label: '脚注',              hint: '支持 [^1] 脚注语法',                    def: true  },
  { key: 'deflist',    label: '定义列表',          hint: '支持 PHP-Markdown-Extra 定义列表',      def: true  },
  { key: 'taskLists',  label: '任务列表',          hint: '支持 - [x] 复选框',                     def: true  },
  { key: 'anchors',    label: '标题锚点与目录',    hint: '为标题生成 id，并抽取目录树',           def: true  },
  { key: 'tocEmbed',   label: '正文内嵌目录',      hint: '导出时在正文开头插入目录（取 h2 起，最多三级）', def: false },
  { key: 'lineNumbers', label: '代码块行号',       hint: '代码块左侧显示行号',                    def: false },
];

export const DEFAULT_MARKDOWN_OPTIONS = Object.freeze(
  Object.fromEntries(MARKDOWN_FLAGS.map((f) => [f.key, f.def])),
);

/* ------------------------------------------------------------ 工具函数 --- */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 极简转义（不依赖 md 实例，便于在插件内部使用）。 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** 生成 URL slug：保留 CJK，去掉标点，空格转连字符。 */
export function slugify(text) {
  const base = String(text)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

/** 把 Markdown 标题文本粗略地转为纯文本（用于目录显示）。 */
function toPlainText(src) {
  return String(src)
    .replace(/\$+([^$]*)\$+/g, '$1')          // 行内/块级数学 → 原文
    .replace(/\\\(([^)]*)\\\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')  // 图片 → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接 → 文本
    .replace(/[*_~`]{1,3}/g, '')               // 强调标记
    .replace(/<[^>]+>/g, '')                   // 内联 HTML
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统计字符/词数（CJK 按字计，拉丁按词计）。 */
function computeStats(src) {
  const chars = [...src].length;
  const cjk = (src.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
  const latinWords = (src.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ')
    .match(/[A-Za-z0-9][A-Za-z0-9'’._-]*/g) || []).length;
  const lines = src.split('\n').length;
  // 中文阅读速度约 400 字/分，英文约 220 词/分，取较慢的一条作为估算
  const minutes = Math.max(cjk / 400, latinWords / 220);
  return {
    chars,
    cjk,
    words: cjk + latinWords,
    lines,
    readingMinutes: Math.max(1, Math.round(minutes)) ,
  };
}

/* --------------------------------------------------------- KaTeX 渲染 --- */

/**
 * 渲染一段 TeX。失败时**不抛异常**，而是产出可读的错误块并把错误收集到
 * `collector`，这样一篇文档里一个公式写错不会让整篇预览失败。
 */
function renderTex(tex, displayMode, katexOptions, collector, token) {
  const options = {
    displayMode,
    // 故意抛错：由我们捕获并同时产出「可见错误块 + 结构化错误记录」，
    // 这样一篇文档里写坏一个公式不会中断整篇渲染，用户还能在面板里看到行号。
    throwOnError: true,
    errorColor: '#dc2626',
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml',
    macros: katexOptions?.macros || {},
    ...(katexOptions?.globalGroup ? { globalGroup: true } : {}),
  };
  try {
    return katex.renderToString(tex, options);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (collector) {
      collector.push({
        kind: 'katex',
        message,
        tex: tex.length > 160 ? `${tex.slice(0, 160)}…` : tex,
        line: token && token.map ? token.map[0] + 1 : null,
        displayMode,
      });
    }
    const label = displayMode ? 'display math' : 'inline math';
    // 「AI 修复」按钮只在预览里出现（导出页是 data-static="1"，CSS 会隐藏它）。
    // 这样预览与导出仍然共用同一份渲染器，不需要分叉。
    return (
      `<span class="mdp-math-error" title="${escapeHtml(message)}">` +
      `<code>${escapeHtml(tex)}</code>` +
      `<em class="mdp-math-error-tag">${label} 渲染失败：${escapeHtml(message)}</em>` +
      `<button class="err-fix-btn" type="button" data-mdp-fix="1"` +
      ` data-tex="${escapeHtml(tex)}" data-err="${escapeHtml(message)}">AI 修复</button>` +
      `</span>`
    );
  }
}

/* ---------------------------------------------------------- 数学插件 --- */

/**
 * 数学语法插件。
 *   块级：`$$ … $$`（可跨行）与 `\[ … \]`
 *   行内：`$ … $` 与 `\( … \)`
 * 行内 `$` 有一组保守的启发式规则，避免把「价格 $5 与 $6」当成公式。
 */
function mathPlugin(md, katexOptions, collector) {
  const CLOSE_FOR = { '$$': '$$', '\\[': '\\]' };

  // alt 数组是**必须**的：markdown-it 的 paragraph 规则只会向声明了
  // alt: ['paragraph', …] 的规则询问"这一行是否要中断段落"。
  // 少了它，紧跟在正文后面的 `$$…$$` 会被吸进上一段，退化成行内解析
  // （表现为公式以纯文本出现、并吃掉一个定界符）。
  md.block.ruler.before('fence', 'mdp_math_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const begin = state.bMarks[startLine] + state.tShift[startLine];
    const end = state.eMarks[startLine];
    const line = state.src.slice(begin, end);

    let open = null;
    if (line.startsWith('$$')) open = '$$';
    else if (line.startsWith('\\[')) open = '\\[';
    if (!open) return false;
    const close = CLOSE_FOR[open];

    let body = line.slice(open.length);
    let lastLine = startLine;
    let closed = false;

    const sameLine = body.indexOf(close);
    if (sameLine >= 0) {
      if (body.slice(sameLine + close.length).trim() !== '') return false; // 交给行内规则
      body = body.slice(0, sameLine);
      closed = true;
    } else {
      const parts = [body];
      for (let l = startLine + 1; l < endLine; l++) {
        const p = state.bMarks[l] + state.tShift[l];
        const m = state.eMarks[l];
        const text = state.src.slice(p, m);
        const i = text.indexOf(close);
        if (i >= 0) {
          parts.push(text.slice(0, i));
          lastLine = l;
          closed = true;
          break;
        }
        parts.push(text);
      }
      body = parts.join('\n');
    }
    if (!closed) return false;
    if (silent) return true;

    const token = state.push('mdp_math_block', 'math', 0);
    token.block = true;
    token.markup = open;
    token.content = body.trim();
    token.map = [startLine, lastLine + 1];
    state.line = lastLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  md.inline.ruler.before('escape', 'mdp_math_inline', (state, silent) => {
    const start = state.pos;
    const src = state.src;
    const code = src.charCodeAt(start);
    const next = src.charCodeAt(start + 1);

    // 四种定界符：`$$…$$` / `\[…\]` 为行间（display），`$…$` / `\(…\)` 为行内。
    // 行间公式出现在段落中间（`… 与 $$…$$。`）是极常见的写法，块级规则只在
    // 行首生效，因此这里必须也能识别 `$$`，否则会退化成纯文本。
    let open;
    let close;
    let display;
    if (code === 0x24 && next === 0x24) {
      open = '$$'; close = '$$'; display = true;
    } else if (code === 0x5c && next === 0x5b) {
      open = '\\['; close = '\\]'; display = true;
    } else if (code === 0x24) {
      if (src.charCodeAt(start - 1) === 0x5c) return false; // 转义的 \$
      if (src.charCodeAt(start - 1) === 0x24) return false; // 已是 `$$` 的后半
      open = '$'; close = '$'; display = false;
    } else if (code === 0x5c && next === 0x28) {
      open = '\\('; close = '\\)'; display = false;
    } else {
      return false;
    }
    const isDollar = open === '$';

    let pos = start + open.length;
    let found = -1;
    while (pos < state.posMax) {
      const c = src.charCodeAt(pos);
      if (close === '$$') {
        if (c === 0x5c) { pos += 2; continue; }
        if (c === 0x24 && src.charCodeAt(pos + 1) === 0x24) { found = pos; break; }
      } else if (close === '$') {
        if (c === 0x0a) return false;            // 行内公式不跨行
        if (c === 0x5c) { pos += 2; continue; }   // 跳过转义字符
        if (c === 0x24) { found = pos; break; }
      } else if (c === 0x5c && src.charCodeAt(pos + 1) === (close === '\\]' ? 0x5d : 0x29)) {
        found = pos; break;
      }
      pos++;
    }
    if (found < 0) return false;

    const content = src.slice(start + open.length, found);
    if (!content.trim()) return false;
    if (isDollar) {
      // 货币防误判：`$5 与 $6`、`$ 100` 之类不作为公式。
      // 判据只用「定界符内侧不得是空白」+「闭定界符后面不得紧跟数字」——
      // 这两条已覆盖现实中的货币写法，同时不会误伤 `$2$`、`$100$` 这类
      // 数学里很常见的纯数字公式（在 `**…$2$…**` 里尤其常见）。
      if (/^\s/.test(content) || /\s$/.test(content)) return false;
      const after = src[found + 1];
      if (after !== undefined && /[0-9]/.test(after)) return false;
    }
    if (silent) return true;

    // 段中行间公式用 <span> 承载（div 不能出现在 <p> 里，会被浏览器强行截断）
    const token = state.push(display ? 'mdp_math_display' : 'mdp_math_inline', 'math', 0);
    token.markup = open;
    token.content = content;
    state.pos = found + close.length;
    return true;
  });

  md.renderer.rules.mdp_math_inline = (tokens, idx) =>
    renderTex(tokens[idx].content, false, katexOptions, collector, tokens[idx]);
  md.renderer.rules.mdp_math_block = (tokens, idx) =>
    `<div class="mdp-math-block">${renderTex(tokens[idx].content, true, katexOptions, collector, tokens[idx])}</div>\n`;
  md.renderer.rules.mdp_math_display = (tokens, idx) =>
    `<span class="mdp-math-block mdp-math-block-inline">${renderTex(tokens[idx].content, true, katexOptions, collector, tokens[idx])}</span>`;
}

/* -------------------------------------------------------- 容器插件 --- */

/** `::: theorem 勾股定理` … `:::` —— 中英双语别名，可选自动编号。 */
function calloutPlugin(md) {
  md.block.ruler.before('fence', 'mdp_callout', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const begin = state.bMarks[startLine] + state.tShift[startLine];
    const end = state.eMarks[startLine];
    const line = state.src.slice(begin, end);

    const m = /^:::[ \t]*([^\s:]+)[ \t]*(.*)$/.exec(line);
    if (!m) return false;
    const key = m[1].toLowerCase();
    const kind = CALLOUT_ALIASES[key] || CALLOUT_ALIASES[m[1]];
    if (!kind) return false;
    const title = m[2].replace(/\s*\{#[^}]*\}\s*$/, '').trim();

    let nextLine = startLine;
    let hasEnd = false;
    for (;;) {
      nextLine++;
      if (nextLine >= endLine) break;
      const p = state.bMarks[nextLine] + state.tShift[nextLine];
      const e = state.eMarks[nextLine];
      if (p < e && state.sCount[nextLine] < state.blkIndent) break;
      if (/^:::[ \t]*$/.test(state.src.slice(p, e))) { hasEnd = true; break; }
    }
    if (silent) return true;
    if (nextLine <= startLine) return false;

    const oldParent = state.parentType;
    const oldLineMax = state.lineMax;
    state.parentType = 'mdp_callout';
    // 让内部段落/列表正常解析，但不越过容器边界
    state.lineMax = nextLine;

    let token = state.push('mdp_callout_open', 'div', 1);
    token.block = true;
    token.info = kind;
    token.markup = ':::';
    token.map = [startLine, nextLine];
    // 标题里也允许数学：解析期就用 inline 渲染器把它变成 HTML，
    // 这样 `::: remark 关于 $A\neq0$` 的公式不会被当作纯文本转义掉。
    token.meta = {
      kind,
      title,
      titleHtml: title ? state.md.renderInline(title) : '',
      number: null,
    };

    state.md.block.tokenize(state, startLine + 1, nextLine);

    token = state.push('mdp_callout_close', 'div', -1);
    token.markup = ':::';

    state.parentType = oldParent;
    state.lineMax = oldLineMax;
    state.line = nextLine + (hasEnd ? 1 : 0);
    return true;
  });

  const renderOpen = (tokens, idx) => {
    const t = tokens[idx];
    const meta = CALLOUT_META[t.info] || CALLOUT_META.note;
    const custom = (t.meta && t.meta.title) || '';
    const num = t.meta && t.meta.number != null ? ` ${t.meta.number}` : '';
    const label = `${meta.zh}${num}`;
    const secondary = custom ? (t.meta.titleHtml || escapeHtml(custom)) : '';
    const aria = escapeHtml(`${meta.zh}${num}${custom ? ` ${custom}` : ` ${meta.en}`}`);
    return (
      `<div class="mdp-callout mdp-callout-${meta.cls}" role="note" aria-label="${aria}">` +
      `<div class="mdp-callout-head">` +
      `<span class="mdp-callout-icon" aria-hidden="true">${meta.icon}</span>` +
      `<span class="mdp-callout-title">${label}</span>` +
      `<span class="mdp-callout-sub">${secondary}</span>` +
      `</div><div class="mdp-callout-body">\n`
    );
  };

  md.renderer.rules.mdp_callout_open = renderOpen;
  md.renderer.rules.mdp_callout_close = () => '</div></div>\n';
}

/* ------------------------------------------------- 标题锚点 / 目录 --- */

function anchorsPlugin(md, collector) {
  md.core.ruler.before('inline', 'mdp_heading_anchors', (state) => {
    const toc = [];
    const used = Object.create(null);
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      if (!inline) continue;

      let raw = inline.content;
      let id = null;
      const explicit = /\s*\{#([A-Za-z0-9_\-:.]+)\}\s*$/.exec(raw);
      if (explicit) {
        id = explicit[1];
        raw = raw.slice(0, explicit.index).trim();
        inline.content = raw;
      }
      const level = Number(tokens[i].tag.slice(1));
      const text = toPlainText(raw);
      if (!id) id = slugify(text);
      if (used[id]) {
        used[id] += 1;
        id = `${id}-${used[id]}`;
      } else {
        used[id] = 1;
      }
      tokens[i].attrSet('id', id);
      toc.push({ level, text, id });
    }
    state.env.toc = toc;
    state.env.mdpWarnings = collector;
  });
}

/* --------------------------------------------------- 代码块渲染器 --- */

function makeFenceRenderer(md, options) {
  const lineNumbers = Boolean(options.lineNumbers);

  return (tokens, idx) => {
    const token = tokens[idx];
    const info = (token.info || '').trim();
    let lang = info;
    let lineSpec = '';
    const specMatch = /\{([\d,\s-]+)\}\s*$/.exec(lang);
    if (specMatch) {
      lineSpec = specMatch[1];
      lang = lang.slice(0, specMatch.index).trim();
    }
    const titleMatch = /(?:^|\s)title="([^"]*)"/.exec(lang);
    const title = titleMatch ? titleMatch[1] : '';
    if (titleMatch) lang = lang.replace(titleMatch[0], '').trim();

    const code = token.content.replace(/\n$/, '');
    let body;
    let detected = lang;
    try {
      if (lang && hljs.getLanguage(lang)) {
        body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } else if (lang === 'text' || lang === 'plaintext' || lang === 'none') {
        body = escapeHtml(code);
        detected = 'text';
      } else {
        const auto = hljs.highlightAuto(code);
        body = auto.value;
        detected = auto.language || 'text';
      }
    } catch (err) {
      collector_push(options, { kind: 'highlight', message: String(err && err.message) });
      body = escapeHtml(code);
      detected = 'text';
    }

    const highlighted = new Set();
    if (lineSpec) {
      for (const part of lineSpec.split(',')) {
        const p = part.trim();
        if (!p) continue;
        const range = /^(\d+)\s*-\s*(\d+)$/.exec(p);
        if (range) {
          for (let n = Number(range[1]); n <= Number(range[2]); n++) highlighted.add(n);
        } else if (/^\d+$/.test(p)) {
          highlighted.add(Number(p));
        }
      }
    }

    let codeHtml;
    if (highlighted.size || lineNumbers) {
      // 逐行包裹：hljs 的多行 span 会被拆开，这里在行内补齐未闭合标签，
      // 使每行都是自洽的 HTML 片段，从而支持行号与行高亮。
      codeHtml = wrapCodeLines(body, { lineNumbers, highlighted });
    } else {
      codeHtml = body;
    }

    const langLabel = escapeHtml(detected || 'text');
    const caption = title
      ? `<figcaption class="mdp-code-title">${escapeHtml(title)}</figcaption>`
      : '';
    return (
      `<figure class="mdp-code"${lineSpec ? ` data-highlight-lines="${escapeHtml(lineSpec)}"` : ''}>` +
      caption +
      `<div class="mdp-code-bar"><span class="mdp-code-lang">${langLabel}</span>` +
      `<button class="mdp-copy" type="button" data-mdp-copy aria-label="复制代码">复制</button></div>` +
      `<pre class="hljs"><code class="language-${langLabel}">${codeHtml}</code></pre>` +
      `</figure>\n`
    );
  };
}

function collector_push(options, item) {
  if (options && options.collector) options.collector.push(item);
}

/**
 * 按行包裹代码，并保持 hljs 的 span 平衡：
 * 统计每行结束时未闭合的 `<span …>`，在行尾补 `</span>`、在下一行行首重新打开。
 */
function wrapCodeLines(html, { lineNumbers, highlighted }) {
  const lines = html.split('\n');
  const openStack = [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // 行首重开上一行未闭合的标签
    let prefix = openStack.map((s) => s).join('');
    // 统计本行的开合
    const tagRe = /<span\b[^>]*>|<\/span>/g;
    let m;
    while ((m = tagRe.exec(line)) !== null) {
      if (m[0] === '</span>') openStack.pop();
      else openStack.push(m[0]);
    }
    line = prefix + line + '</span>'.repeat(openStack.length);
    const cls = highlighted.has(i + 1) ? ' class="hl-line"' : '';
    out.push(`<span class="cl"${cls}>${line === '' ? '&nbsp;' : line}</span>`);
  }
  const attrs = ` class="mdp-code-lines${lineNumbers ? ' with-numbers' : ''}"`;
  return `<span${attrs}>${out.join('\n')}</span>`;
}

/* ------------------------------------------------------------ 主入口 --- */

/**
 * 创建一个渲染器实例。
 * @param {object} [options] 见 DEFAULT_MARKDOWN_OPTIONS，另支持：
 *        katex      — { macros, globalGroup }
 *        assetUrl   — (src, token) => string，用于把图片相对路径改写成可访问 URL
 *        collector  — 错误收集数组
 */
export function createRenderer(options = {}) {
  const opts = { ...DEFAULT_MARKDOWN_OPTIONS, ...options };
  const collector = options.collector || [];

  const md = new MarkdownIt({
    html: true,
    xhtmlOut: false,
    breaks: opts.breaks,
    langPrefix: 'language-',
    linkify: opts.linkify,
    typographer: opts.typographer,
    quotes: '“”‘’',
    highlight: null,
  });

  mathPlugin(md, opts.katex, collector);
  calloutPlugin(md);
  if (opts.anchors !== false) anchorsPlugin(md, collector);

  if (opts.footnotes !== false) md.use(footnote);
  if (opts.deflist !== false) md.use(deflist);
  if (opts.taskLists !== false) md.use(taskLists, { label: true, labelAfter: true });

  md.renderer.rules.fence = makeFenceRenderer(md, { ...opts, collector });
  md.renderer.rules.code_block = makeFenceRenderer(md, { ...opts, collector });

  // 自动编号：给可编号的容器按种类累加序号
  if (opts.numbering) {
    md.core.ruler.after('mdp_heading_anchors', 'mdp_callout_numbering', (state) => {
      const counters = Object.create(null);
      for (const t of state.tokens) {
        if (t.type !== 'mdp_callout_open') continue;
        const meta = CALLOUT_META[t.info];
        if (!meta || !meta.numberable) continue;
        counters[t.info] = (counters[t.info] || 0) + 1;
        t.meta.number = counters[t.info];
      }
      // 若文档同时使用多种可编号容器，则统一成「全局递增」更接近中文教材习惯
      const kinds = NUMBERING_ORDER.filter((k) => counters[k]);
      if (kinds.length > 1 && opts.numbering === 'unified') {
        let n = 0;
        for (const t of state.tokens) {
          if (t.type !== 'mdp_callout_open') continue;
          const meta = CALLOUT_META[t.info];
          if (!meta || !meta.numberable) continue;
          t.meta.number = ++n;
        }
      }
      state.env.mdpCounters = counters;
    });
  }

  // 图片路径改写（浏览器预览时需要把相对路径变成 /api/asset?path=…）
  if (typeof opts.assetUrl === 'function') {
    const defaultImage = md.renderer.rules.image || ((tokens, idx, o, env, self) => self.renderToken(tokens, idx, o));
    md.renderer.rules.image = (tokens, idx, o, env, self) => {
      const token = tokens[idx];
      const src = token.attrGet('src');
      if (src && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src)) {
        const next = opts.assetUrl(src, token);
        if (next) token.attrSet('src', next);
      }
      return defaultImage(tokens, idx, o, env, self);
    };
  }

  // 外链统一在新标签页打开，并加上安全的 rel
  const defaultLinkOpen = md.renderer.rules.link_open
    || ((tokens, idx, o, env, self) => self.renderToken(tokens, idx, o));
  md.renderer.rules.link_open = (tokens, idx, o, env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:/i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, o, env, self);
  };

  md.__mdpOptions = opts;
  md.__mdpCollector = collector;
  return md;
}

/**
 * 渲染 Markdown 源码。
 * @returns {{html:string, toc:Array, stats:object, errors:Array, headings:number, mathCount:number}}
 */
export function renderMarkdown(source, options = {}) {
  const md = options.md instanceof MarkdownIt ? options.md : createRenderer(options);
  const collector = options.collector || md.__mdpCollector || [];

  const text = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ');

  const env = {};
  let html = md.render(text, env);
  // 连续空行产生的占位空段落清理
  html = html.replace(/<p>\s*<\/p>\s*/g, '');

  // 只统计最外层包装 <span class="katex">，避免把 KaTeX 内部嵌套类计入
  const mathCount = (html.match(/<span class="katex"/g) || []).length
    + (html.match(/mdp-math-error/g) || []).length;

  return {
    html,
    toc: env.toc || [],
    counters: env.mdpCounters || null,
    stats: computeStats(text),
    errors: collector.slice(),
    mathCount,
  };
}

export { hljs };
