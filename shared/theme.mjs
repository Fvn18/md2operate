/**
 * shared/theme.mjs
 * ============================================================================
 *  文档样式表（Document CSS）——预览与导出共用的**唯一**样式来源。
 *
 *  设计要点
 *    · 全部选择器都以 `.mdp-doc` 作用域开头：网页预览把它挂在一个 <div> 上，
 *      导出时把它挂在 <body> 上，因此同一份 CSS 在两处完全等价。
 *    · 主题通过 `.mdp-doc[data-doc-theme="…"]` 切换 CSS 变量，不改结构。
 *    · `@page` 与打印规则由 `documentCss()` 依据纸张参数**字面生成**（CSS 变量
 *      在 @page 中不可用），所以导出 PDF 时页边距是精确的。
 *    · 所有字体栈都以本机字体为主，不依赖任何网络字体，保证离线可用。
 * ============================================================================
 */

/** 可供用户选择的文档主题（网页端「排版 → 主题」据此渲染）。 */
export const DOC_THEMES = [
  { id: 'paper',    label: '纸白',    dark: false, desc: '白底衬线，最接近 LaTeX 论文' },
  { id: 'github',   label: 'GitHub',  dark: false, desc: '无衬线，信息密度高' },
  { id: 'academic', label: '学术',    dark: false, desc: '首行缩进 + 两端对齐，中文学位论文风' },
  { id: 'sepia',    label: '羊皮卷',  dark: false, desc: '暖色护眼，适合长时间阅读' },
  { id: 'ink',      label: '墨黑',    dark: true,  desc: '深色主题，适合夜间与分享截图' },
  { id: 'nord',     label: 'Nord',    dark: true,  desc: '冷色调深色主题' },
  { id: 'mono',     label: '极简',    dark: false, desc: '紧凑、去装饰、信息密度优先' },
];

export const DOC_THEME_IDS = DOC_THEMES.map((t) => t.id);

/** 字体预设（网页端下拉框使用）。 */
export const FONT_PRESETS = {
  serifLatin: '"Latin Modern Roman", "Times New Roman", "Nimbus Roman", Georgia, "Songti SC", "STSong", "Noto Serif CJK SC", serif',
  sansLatin: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "Noto Serif CJK SC", "SimSun", serif',
  heiti: '"PingFang SC", "Hiragino Sans GB", "Heiti SC", "Microsoft YaHei", sans-serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif CJK SC", serif',
  mono: '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, "Liberation Mono", monospace',
};

/** 纸张尺寸（mm），供 HTML→PDF 与预览页宽换算使用。 */
export const PAPER_SIZES = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  B5: { w: 176, h: 250 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
  A3: { w: 297, h: 420 },
  slide: { w: 338.7, h: 190.5 }, // 16:9
};

/** mm → CSS px（96dpi 下的换算）。 */
export const mmToPx = (mm) => (mm * 96) / 25.4;

/** 默认排版参数（与网页端表单一一对应）。 */
export const DEFAULT_DOC_OPTIONS = Object.freeze({
  theme: 'paper',
  fontSize: 16.5,        // px（导出 PDF 时按 96dpi 折算）
  lineHeight: 1.75,
  contentWidth: 860,     // 卡片/页面模式下的正文宽度（px）
  fontBody: 'serifLatin',
  fontHeading: 'sansLatin',
  fontMono: 'mono',
  paragraphIndent: 0,    // px，学术主题默认 2em
  justify: false,
  paper: 'A4',
  margin: 20,            // mm
  card: false,           // 是否渲染为「卡片」样式（PNG 分享图常用）
  cardPadding: 32,       // px
  cardRadius: 18,        // px
  cardShadow: true,
  cardBorder: true,
  transparent: false,    // 透明背景（PNG）
  showMeta: true,        // 显示标题/作者/日期信息块
  title: '',
  author: '',
  date: '',
  accent: '',            // 覆盖主题主色（空 = 用主题默认）
  codeTheme: '',         // highlight.js 主题名（空 = 跟随主题明暗）
  hljsCss: '',           // 由服务端注入的 highlight.js 主题 CSS 文本
  numberingHeadings: false,
});

const esc = (s) => String(s).replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));

/**
 * 生成文档 CSS。
 * @param {object} options 见 DEFAULT_DOC_OPTIONS
 * @returns {string} CSS 文本
 */
export function documentCss(options = {}) {
  const o = { ...DEFAULT_DOC_OPTIONS, ...options };
  const paper = PAPER_SIZES[o.paper] || PAPER_SIZES.A4;
  const bodyFont = FONT_PRESETS[o.fontBody] || o.fontBody;
  const headFont = FONT_PRESETS[o.fontHeading] || o.fontHeading;
  const monoFont = FONT_PRESETS[o.fontMono] || o.fontMono;
  const isAcademic = o.theme === 'academic';
  const indent = o.paragraphIndent || (isAcademic ? '2em' : 0);
  const justify = o.justify || isAcademic;

  return `
/* ==========================================================================
   MDP Studio — Document Stylesheet (generated)
   theme=${o.theme}  paper=${o.paper}  font=${o.fontSize}px/${o.lineHeight}
   ========================================================================== */

.mdp-doc {
  --mdp-font-body: ${bodyFont};
  --mdp-font-head: ${headFont};
  --mdp-font-mono: ${monoFont};
  --mdp-font-size: ${o.fontSize}px;
  --mdp-line-height: ${o.lineHeight};
  --mdp-content-width: ${o.contentWidth}px;
  --mdp-indent: ${typeof indent === 'number' ? (indent ? indent + 'px' : '0') : indent};

  font-family: var(--mdp-font-body);
  font-size: var(--mdp-font-size);
  line-height: var(--mdp-line-height);
  color: var(--mdp-fg);
  background: var(--mdp-bg);
  text-align: ${justify ? 'justify' : 'start'};
  ${justify ? 'text-justify: inter-ideograph;' : ''}
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  overflow-wrap: break-word;
  word-break: normal;
}

/* ---------------------------------------------------------------- 主题变量 -- */
.mdp-doc[data-doc-theme="paper"] {
  --mdp-bg: #ffffff; --mdp-fg: #16181d; --mdp-muted: #6b7280;
  --mdp-border: #e5e7eb; --mdp-border-strong: #d1d5db;
  --mdp-accent: #2563eb; --mdp-accent-soft: #eff6ff;
  --mdp-code-bg: #f6f7f9; --mdp-code-fg: #24292f; --mdp-code-border: #e5e7eb;
  --mdp-quote-bg: #f9fafb;
  --mdp-h1-rule: #e5e7eb;
}
.mdp-doc[data-doc-theme="github"] {
  --mdp-bg: #ffffff; --mdp-fg: #1f2328; --mdp-muted: #59636e;
  --mdp-border: #d1d9e0; --mdp-border-strong: #b7bfc7;
  --mdp-accent: #0969da; --mdp-accent-soft: #ddf4ff;
  --mdp-code-bg: #f6f8fa; --mdp-code-fg: #1f2328; --mdp-code-border: #d1d9e0;
  --mdp-quote-bg: #f6f8fa;
  --mdp-h1-rule: #d1d9e0;
}
.mdp-doc[data-doc-theme="academic"] {
  --mdp-bg: #ffffff; --mdp-fg: #101216; --mdp-muted: #5b6270;
  --mdp-border: #e3e6ea; --mdp-border-strong: #cdd3da;
  --mdp-accent: #1d4ed8; --mdp-accent-soft: #eef2ff;
  --mdp-code-bg: #f7f7f8; --mdp-code-fg: #1a1d23; --mdp-code-border: #e3e6ea;
  --mdp-quote-bg: #fafafa;
  --mdp-h1-rule: #d8dce1;
}
.mdp-doc[data-doc-theme="sepia"] {
  --mdp-bg: #fbf6ec; --mdp-fg: #3a3226; --mdp-muted: #857a67;
  --mdp-border: #e6dcc8; --mdp-border-strong: #d6c9ae;
  --mdp-accent: #a4622a; --mdp-accent-soft: #f5e9d7;
  --mdp-code-bg: #f4ecdd; --mdp-code-fg: #40372a; --mdp-code-border: #e6dcc8;
  --mdp-quote-bg: #f6efe2;
  --mdp-h1-rule: #e0d4bd;
}
.mdp-doc[data-doc-theme="ink"] {
  --mdp-bg: #0f1116; --mdp-fg: #e6e8ee; --mdp-muted: #9aa3b2;
  --mdp-border: #262b36; --mdp-border-strong: #333a48;
  --mdp-accent: #7dd3fc; --mdp-accent-soft: #12212e;
  --mdp-code-bg: #161a22; --mdp-code-fg: #e6e8ee; --mdp-code-border: #262b36;
  --mdp-quote-bg: #14181f;
  --mdp-h1-rule: #262b36;
}
.mdp-doc[data-doc-theme="nord"] {
  --mdp-bg: #2e3440; --mdp-fg: #e5e9f0; --mdp-muted: #a9b4c6;
  --mdp-border: #3b4252; --mdp-border-strong: #4c566a;
  --mdp-accent: #88c0d0; --mdp-accent-soft: #3b4252;
  --mdp-code-bg: #292e39; --mdp-code-fg: #e5e9f0; --mdp-code-border: #3b4252;
  --mdp-quote-bg: #333a47;
  --mdp-h1-rule: #3b4252;
}
.mdp-doc[data-doc-theme="mono"] {
  --mdp-bg: #ffffff; --mdp-fg: #111111; --mdp-muted: #666666;
  --mdp-border: #e2e2e2; --mdp-border-strong: #c9c9c9;
  --mdp-accent: #111111; --mdp-accent-soft: #f2f2f2;
  --mdp-code-bg: #f4f4f4; --mdp-code-fg: #111111; --mdp-code-border: #e2e2e2;
  --mdp-quote-bg: #f7f7f7;
  --mdp-h1-rule: #e2e2e2;
}
${o.accent ? `.mdp-doc { --mdp-accent: ${esc(o.accent)}; }` : ''}

/* ------------------------------------------------------------------ 结构 -- */
.mdp-doc .mdp-doc-inner { max-width: var(--mdp-content-width); margin: 0 auto; }

.mdp-doc > *:first-child,
.mdp-doc .mdp-doc-inner > *:first-child { margin-top: 0 !important; }
.mdp-doc > *:last-child,
.mdp-doc .mdp-doc-inner > *:last-child { margin-bottom: 0 !important; }

/* ------------------------------------------------------- 增量渲染的分块包装 --
   预览把每个块包进 .mdp-block，好让 React 按键复用 DOM；导出也使用同样的包装，
   因此两边的排版语义完全一致（这是本项目"所见即所得"的硬约束）。

   为什么必须是 display:block 而不是 display:contents：
   实测（10 万字符、15,000px 高、10 万节点）在 display:contents 下，插入一个字符
   要触发整篇重排 ≈380ms（每次按键 p50 424ms）；换成 display:block 并启用
   content-visibility:auto 后降到 62ms（6.8 倍）。原因有二：
     · content-visibility / contain 作用在 display:contents 元素上是 **no-op**
       （没有主盒可承载），所以之前的 containment 尝试全部无效；
     · 视口外的块被跳过布局与绘制，只有可见的十来个块参与重排。

   contain:layout style paint 在**预览与导出上都保留**，所以"块之间不折叠外边距"
   这一副作用两边一致；块间距改由包装元素统一控制（见下方 [data-first] 规则），
   排版节奏因此比原来的折叠结果更规整、且可预测。 */
.mdp-doc .mdp-block {
  display: block;
  margin: 0;
  /* 块间距用 padding 而不是 margin：虚拟化要"每块高度自包含"。
     offsetHeight 不包含外边距，若间距靠 margin，sum(块高) ≠ 内容总高，
     上下占位块就会错位（滚到中段越滚越偏）。padding 在盒内，量得准。
     间距数值与原来的外边距折叠结果一致（块内首尾子元素外边距已压成 0），
     所以预览与导出的排版没有变化。 */
  padding-top: 0.85em;
  contain: layout style paint;
}
/* 只在预览（非静态渲染）里跳过视口外内容；导出必须完整布局，否则截图/分页会缺内容。
   contain-intrinsic-size 的分档很关键：它决定"尚未布局的块"占多高。
   如果一律给 120px，段落（~30px）与代码块（~200px）的误差会让滚动位置明显漂移，
   锚定式同步就会对不准。auto 关键字会记住已渲染过的真实高度，因此首次布局后
   误差迅速收敛。 */
.mdp-doc:not([data-static="1"]) .mdp-block {
  content-visibility: auto;
  contain-intrinsic-size: auto 56px;
}
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="h1"],
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="h2"] { contain-intrinsic-size: auto 64px; }
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="h3"],
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="h4"] { contain-intrinsic-size: auto 52px; }
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="figure"] { contain-intrinsic-size: auto 220px; }
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="table"] { contain-intrinsic-size: auto 160px; }
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="div"] { contain-intrinsic-size: auto 150px; }
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="ul"],
.mdp-doc:not([data-static="1"]) .mdp-block[data-first="ol"] { contain-intrinsic-size: auto 90px; }
.mdp-doc .mdp-block > *:first-child { margin-top: 0 !important; }
/* 虚拟化打开时，块本来就只挂载视口附近的几十个，不需要（也不该）再让
   content-visibility 延迟布局——那会让"测到的高度"和"最终高度"不一致，
   反而把滚动锚定搞歪。 */
.mdp-doc[data-virtual="1"]:not([data-static="1"]) .mdp-block {
  content-visibility: visible;
  contain-intrinsic-size: none;
}
/* 导出产物（data-static="1"）里不出现任何交互控件 */
.mdp-doc[data-static="1"] .err-fix-btn { display: none !important; }
.mdp-doc .mdp-block > *:last-child { margin-bottom: 0 !important; }

/* 块间距（padding-top，默认 0.85em 已在上面的 .mdp-block 里给出）：
   按"下一块是什么标签"微调，数值与当初外边距折叠的结果一致——切换成 padding
   之后文档总高不变（实测 10 万字符文档仍是同一量级；见 scripts/bench.mjs）。 */
.mdp-doc .mdp-block[data-first="h1"],
.mdp-doc .mdp-block[data-first="h2"],
.mdp-doc .mdp-block[data-first="h3"],
.mdp-doc .mdp-block[data-first="h4"],
.mdp-doc .mdp-block[data-first="h5"],
.mdp-doc .mdp-block[data-first="h6"] { padding-top: 1.6em; }
.mdp-doc .mdp-block[data-first="hr"] { padding-top: 2em; }
.mdp-doc .mdp-block[data-first="div"] { padding-top: 1.15em; }   /* callout / 行间公式 */
.mdp-doc .mdp-block[data-first="figure"] { padding-top: 1.2em; }
.mdp-doc .mdp-block[data-first="table"] { padding-top: 1em; }
.mdp-doc .mdp-block[data-first="blockquote"] { padding-top: 1em; }
.mdp-doc .mdp-block[data-first="ul"],
.mdp-doc .mdp-block[data-first="ol"] { padding-top: 0.85em; }
/* 文档首块不留上间距 */
.mdp-doc > .mdp-block:first-child { padding-top: 0 !important; }

/* 虚拟化的上下占位块：只是一个精确高度的空盒，不参与排版、不被选中。
   高度 = 视口上方 / 下方所有块的高度和，因此滚动条长度与真实文档一致。 */
.mdp-doc .mdp-spacer {
  display: block;
  margin: 0;
  padding: 0;
  border: 0;
  contain: strict;
  pointer-events: none;
}

/* ------------------------------------------------------------------ 标题 -- */
.mdp-doc h1, .mdp-doc h2, .mdp-doc h3,
.mdp-doc h4, .mdp-doc h5, .mdp-doc h6 {
  font-family: var(--mdp-font-head);
  color: var(--mdp-fg);
  font-weight: 700;
  line-height: 1.3;
  margin: 1.6em 0 0.6em;
  text-wrap: balance;
  ${o.numberingHeadings ? 'counter-increment: mdp-h2;' : ''}
}
.mdp-doc h1 { font-size: 1.9em; margin-top: 0.2em; padding-bottom: 0.3em; border-bottom: 2px solid var(--mdp-h1-rule); letter-spacing: -0.01em; }
.mdp-doc h2 { font-size: 1.45em; padding-bottom: 0.25em; border-bottom: 1px solid var(--mdp-border); letter-spacing: -0.005em; }
.mdp-doc h3 { font-size: 1.2em; }
.mdp-doc h4 { font-size: 1.06em; color: var(--mdp-muted); }
.mdp-doc h5 { font-size: 1em; color: var(--mdp-muted); font-weight: 600; }
.mdp-doc h6 { font-size: 0.94em; color: var(--mdp-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.mdp-doc h2 + *, .mdp-doc h3 + *, .mdp-doc h4 + * { margin-top: 0.25em; }

/* ------------------------------------------------------------------ 正文 -- */
.mdp-doc p { margin: 0.85em 0; }
.mdp-doc p.mdp-indent, .mdp-doc[data-indent="1"] p { text-indent: var(--mdp-indent); }
.mdp-doc strong { font-weight: 700; color: var(--mdp-fg); }
.mdp-doc em { font-style: italic; }
.mdp-doc del { color: var(--mdp-muted); }
.mdp-doc mark { background: #fde68a; color: inherit; padding: 0 0.2em; border-radius: 3px; }
.mdp-doc .mdp-doc[data-doc-theme="ink"] mark { background: #7c5c12; }
.mdp-doc kbd {
  font-family: var(--mdp-font-mono); font-size: 0.86em; padding: 0.15em 0.45em;
  border: 1px solid var(--mdp-border-strong); border-bottom-width: 2px;
  border-radius: 5px; background: var(--mdp-code-bg); white-space: nowrap;
}
.mdp-doc abbr[title] { text-decoration: underline dotted; cursor: help; }
.mdp-doc a {
  color: var(--mdp-accent); text-decoration: none;
  background-image: linear-gradient(var(--mdp-accent), var(--mdp-accent));
  background-size: 0% 1px; background-repeat: no-repeat; background-position: 0 100%;
  transition: background-size 0.18s ease;
}
.mdp-doc a:hover { background-size: 100% 1px; }
.mdp-doc hr {
  border: 0; height: 1px; margin: 2em 0;
  background: linear-gradient(90deg, transparent, var(--mdp-border-strong), transparent);
}

/* ------------------------------------------------------------------ 列表 -- */
.mdp-doc ul, .mdp-doc ol { margin: 0.85em 0; padding-inline-start: 1.6em; }
.mdp-doc li { margin: 0.3em 0; }
.mdp-doc li > ul, .mdp-doc li > ol { margin: 0.3em 0; }
.mdp-doc ul { list-style: disc; }
.mdp-doc ul ul { list-style: circle; }
.mdp-doc ul ul ul { list-style: square; }
.mdp-doc ol { list-style: decimal; }
.mdp-doc .contains-task-list { list-style: none; padding-inline-start: 0.4em; }
.mdp-doc .task-list-item { display: flex; align-items: flex-start; gap: 0.5em; }
.mdp-doc .task-list-item-checkbox { margin-top: 0.35em; accent-color: var(--mdp-accent); }
.mdp-doc .task-list-item > label { display: contents; }
.mdp-doc dl { margin: 1em 0; }
.mdp-doc dt { font-weight: 700; margin-top: 0.7em; }
.mdp-doc dd { margin: 0.2em 0 0.2em 1.6em; color: var(--mdp-fg); }

/* ---------------------------------------------------------------- 引用块 -- */
.mdp-doc blockquote {
  margin: 1em 0; padding: 0.7em 1.1em;
  border-inline-start: 4px solid var(--mdp-border-strong);
  background: var(--mdp-quote-bg);
  border-radius: 0 8px 8px 0;
  color: var(--mdp-fg);
}
.mdp-doc blockquote > *:first-child { margin-top: 0; }
.mdp-doc blockquote > *:last-child { margin-bottom: 0; }
.mdp-doc blockquote cite { display: block; margin-top: 0.5em; color: var(--mdp-muted); font-size: 0.92em; }

/* ---------------------------------------------------------------- 行内码 -- */
.mdp-doc code {
  font-family: var(--mdp-font-mono); font-size: 0.875em;
  background: var(--mdp-code-bg); color: var(--mdp-code-fg);
  border: 1px solid var(--mdp-code-border);
  padding: 0.12em 0.38em; border-radius: 5px;
  white-space: break-spaces;
}
.mdp-doc a code { color: var(--mdp-accent); }

/* ------------------------------------------------------------------ 代码 -- */
.mdp-doc .mdp-code {
  margin: 1.1em 0; border: 1px solid var(--mdp-code-border);
  border-radius: 10px; overflow: hidden; background: var(--mdp-code-bg);
}
.mdp-doc .mdp-code-title {
  padding: 0.5em 0.9em; font-size: 0.86em; font-weight: 600;
  color: var(--mdp-muted); border-bottom: 1px solid var(--mdp-code-border);
  font-family: var(--mdp-font-head);
}
.mdp-doc .mdp-code-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.35em 0.7em 0.35em 0.9em;
  border-bottom: 1px solid var(--mdp-code-border);
  background: color-mix(in srgb, var(--mdp-code-bg) 88%, var(--mdp-fg) 12%);
}
.mdp-doc .mdp-code-lang {
  font-family: var(--mdp-font-mono); font-size: 0.74em; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--mdp-muted);
}
.mdp-doc .mdp-copy {
  font-family: var(--mdp-font-head); font-size: 0.74em; cursor: pointer;
  color: var(--mdp-muted); background: transparent; border: 1px solid var(--mdp-border);
  border-radius: 5px; padding: 0.15em 0.5em;
}
.mdp-doc .mdp-copy:hover { color: var(--mdp-accent); border-color: var(--mdp-accent); }
.mdp-doc pre {
  margin: 0; padding: 0.9em 1em; overflow-x: auto;
  font-family: var(--mdp-font-mono); font-size: 0.86em; line-height: 1.6;
  background: transparent; color: var(--mdp-code-fg);
  -webkit-overflow-scrolling: touch;
}
.mdp-doc pre code {
  background: none; border: 0; padding: 0; font-size: 1em;
  white-space: pre; color: inherit;
}
/* 行号 + 行高亮（由渲染器逐行包裹） */
.mdp-doc .mdp-code-lines { display: block; }
.mdp-doc .mdp-code-lines .cl { display: block; padding-inline-end: 1em; }
.mdp-doc .mdp-code-lines.with-numbers { counter-reset: mdp-cl; }
.mdp-doc .mdp-code-lines.with-numbers .cl::before {
  counter-increment: mdp-cl; content: counter(mdp-cl);
  display: inline-block; width: 2.2em; margin-inline-end: 0.9em;
  text-align: end; color: var(--mdp-muted); opacity: 0.55;
  user-select: none; -webkit-user-select: none;
}
.mdp-doc .mdp-code-lines .cl.hl-line {
  background: color-mix(in srgb, var(--mdp-accent) 14%, transparent);
  box-shadow: inset 3px 0 0 var(--mdp-accent);
}

/* ------------------------------------------------------------------ 表格 -- */
.mdp-doc .mdp-table-wrap { margin: 1.1em 0; overflow-x: auto; border-radius: 8px; }
.mdp-doc table {
  border-collapse: collapse; width: 100%; font-size: 0.94em;
  border: 1px solid var(--mdp-border);
}
.mdp-doc thead th {
  background: color-mix(in srgb, var(--mdp-bg) 82%, var(--mdp-fg) 8%);
  font-family: var(--mdp-font-head); font-weight: 700; text-align: start;
  border-bottom: 2px solid var(--mdp-border-strong);
}
.mdp-doc th, .mdp-doc td {
  padding: 0.5em 0.75em; border-bottom: 1px solid var(--mdp-border);
  vertical-align: top;
}
.mdp-doc tbody tr:last-child td { border-bottom: 0; }
.mdp-doc tbody tr:hover { background: color-mix(in srgb, var(--mdp-accent) 5%, transparent); }
.mdp-doc td[style*="text-align:right"], .mdp-doc th[style*="text-align:right"] { font-variant-numeric: tabular-nums; }

/* ------------------------------------------------------------ 图片/图表 -- */
.mdp-doc img { max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 1em auto; }
.mdp-doc figure { margin: 1.2em 0; text-align: center; }
.mdp-doc figcaption { margin-top: 0.5em; font-size: 0.88em; color: var(--mdp-muted); }

/* ------------------------------------------------------------------ 数学 -- */
.mdp-doc .mdp-math-block {
  display: block;
  margin: 1.15em 0; overflow-x: auto; overflow-y: hidden; padding: 0.15em 0;
}
.mdp-doc .mdp-math-block-inline { display: block; margin: 0.9em 0; }
.mdp-doc .katex { font-size: 1.06em; }
.mdp-doc .katex-display { margin: 0; }
.mdp-doc .katex-display > .katex { font-size: 1.12em; }
.mdp-doc .mdp-math-error {
  display: inline-block; background: #fee2e2; border: 1px solid #fca5a5;
  border-radius: 6px; padding: 0.1em 0.45em; color: #991b1b;
  font-family: var(--mdp-font-mono); font-size: 0.86em;
}
.mdp-doc .mdp-math-error code { background: none; border: 0; color: inherit; }
.mdp-doc .mdp-math-error-tag { display: block; font-size: 0.82em; opacity: 0.85; font-style: normal; }

/* -------------------------------------------------------------- callouts -- */
.mdp-doc .mdp-callout {
  --co: var(--mdp-accent);
  margin: 1.15em 0; border-radius: 10px; overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--co) 32%, var(--mdp-border));
  background: color-mix(in srgb, var(--co) 6%, var(--mdp-bg));
  break-inside: avoid;
}
.mdp-doc .mdp-callout-head {
  display: flex; align-items: baseline; gap: 0.5em;
  padding: 0.5em 0.9em;
  background: color-mix(in srgb, var(--co) 13%, var(--mdp-bg));
  border-bottom: 1px solid color-mix(in srgb, var(--co) 24%, var(--mdp-border));
}
.mdp-doc .mdp-callout-icon { color: var(--co); font-size: 0.95em; line-height: 1; }
.mdp-doc .mdp-callout-title { font-family: var(--mdp-font-head); font-weight: 700; color: color-mix(in srgb, var(--co) 72%, var(--mdp-fg)); }
.mdp-doc .mdp-callout-sub { font-family: var(--mdp-font-head); font-size: 0.9em; color: var(--mdp-muted); }
.mdp-doc .mdp-callout-body { padding: 0.75em 0.95em; }
.mdp-doc .mdp-callout-body > *:first-child { margin-top: 0; }
.mdp-doc .mdp-callout-body > *:last-child { margin-bottom: 0; }
.mdp-doc .mdp-callout-body p:first-child { text-indent: 0; }

.mdp-doc .mdp-callout-note      { --co: #2563eb; }
.mdp-doc .mdp-callout-info      { --co: #0891b2; }
.mdp-doc .mdp-callout-tip       { --co: #059669; }
.mdp-doc .mdp-callout-important { --co: #7c3aed; }
.mdp-doc .mdp-callout-warning   { --co: #d97706; }
.mdp-doc .mdp-callout-danger    { --co: #dc2626; }
.mdp-doc .mdp-callout-success   { --co: #16a34a; }
.mdp-doc .mdp-callout-quote     { --co: #64748b; }
.mdp-doc .mdp-callout-theorem     { --co: #1d4ed8; }
.mdp-doc .mdp-callout-lemma       { --co: #0e7490; }
.mdp-doc .mdp-callout-proposition { --co: #7c3aed; }
.mdp-doc .mdp-callout-corollary   { --co: #9333ea; }
.mdp-doc .mdp-callout-definition  { --co: #b45309; }
.mdp-doc .mdp-callout-axiom       { --co: #4b5563; }
.mdp-doc .mdp-callout-example     { --co: #0f766e; }
.mdp-doc .mdp-callout-exercise    { --co: #c2410c; }
.mdp-doc .mdp-callout-algorithm   { --co: #1e40af; }
.mdp-doc .mdp-callout-remark      { --co: #6b7280; }
.mdp-doc .mdp-callout-proof {
  --co: #52525b; background: transparent;
  border-style: solid; border-width: 0 0 0 3px; border-radius: 0;
  border-color: color-mix(in srgb, var(--mdp-fg) 22%, transparent);
  padding-inline-start: 0.2em;
}
.mdp-doc .mdp-callout-proof .mdp-callout-head { background: transparent; border-bottom: 0; padding-bottom: 0.1em; }
.mdp-doc .mdp-callout-proof .mdp-callout-body { padding-inline: 0.9em; }
.mdp-doc .mdp-callout-proof .mdp-callout-title::after { content: "."; }
.mdp-doc .mdp-callout-proof .mdp-callout-icon { font-size: 1.1em; }

/* 深色主题下的 callout 对比度补偿 */
.mdp-doc[data-doc-theme="ink"] .mdp-callout,
.mdp-doc[data-doc-theme="nord"] .mdp-callout { background: color-mix(in srgb, var(--co) 12%, var(--mdp-bg)); }
.mdp-doc[data-doc-theme="ink"] .mdp-callout-head,
.mdp-doc[data-doc-theme="nord"] .mdp-callout-head { background: color-mix(in srgb, var(--co) 20%, var(--mdp-bg)); }

/* ------------------------------------------------------------------ 脚注 -- */
.mdp-doc .footnotes {
  margin-top: 2.5em; padding-top: 1em;
  border-top: 1px solid var(--mdp-border); font-size: 0.92em; color: var(--mdp-fg);
}
.mdp-doc .footnotes-sep { display: none; }
.mdp-doc .footnotes-list { padding-inline-start: 1.4em; }
.mdp-doc .footnote-ref { font-size: 0.78em; vertical-align: super; padding: 0 0.1em; }
.mdp-doc .footnote-backref { text-decoration: none; margin-inline-start: 0.3em; }
.mdp-doc .footnote-item p { margin: 0.25em 0; }

/* ------------------------------------------------------------------ 目录 -- */
.mdp-doc .mdp-toc { margin: 1.2em 0 2em; padding: 0.9em 1.1em; border: 1px solid var(--mdp-border); border-radius: 10px; background: var(--mdp-quote-bg); break-inside: avoid; }
.mdp-doc .mdp-toc-title { font-family: var(--mdp-font-head); font-weight: 700; margin-bottom: 0.5em; }
.mdp-doc .mdp-toc ol { list-style: none; padding-inline-start: 0; margin: 0; }
.mdp-doc .mdp-toc li { margin: 0.18em 0; }
.mdp-doc .mdp-toc a { color: var(--mdp-fg); background: none; }
.mdp-doc .mdp-toc a:hover { color: var(--mdp-accent); }
.mdp-doc .mdp-toc .lvl-2 { padding-inline-start: 1em; }
.mdp-doc .mdp-toc .lvl-3 { padding-inline-start: 2em; }
.mdp-doc .mdp-toc .lvl-4 { padding-inline-start: 3em; }
.mdp-doc .mdp-toc .lvl-5, .mdp-doc .mdp-toc .lvl-6 { padding-inline-start: 4em; }

/* -------------------------------------------------------------- 文档信息 -- */
.mdp-doc .mdp-doc-meta {
  margin-bottom: 1.8em; padding-bottom: 1.1em; border-bottom: 1px solid var(--mdp-border);
}
.mdp-doc .mdp-doc-meta .mdp-title {
  font-family: var(--mdp-font-head); font-size: 1.9em; font-weight: 800;
  line-height: 1.25; margin: 0 0 0.35em; letter-spacing: -0.015em;
}
.mdp-doc .mdp-doc-meta .mdp-byline {
  display: flex; flex-wrap: wrap; gap: 0.35em 1.2em;
  font-family: var(--mdp-font-head); font-size: 0.92em; color: var(--mdp-muted);
}

/* ------------------------------------------------------------ 锚点与提示 -- */
.mdp-doc h1:hover .mdp-anchor, .mdp-doc h2:hover .mdp-anchor,
.mdp-doc h3:hover .mdp-anchor, .mdp-doc h4:hover .mdp-anchor { opacity: 1; }
.mdp-doc .mdp-anchor {
  opacity: 0; margin-inline-start: 0.35em; font-size: 0.8em;
  color: var(--mdp-muted); background: none; text-decoration: none;
  transition: opacity 0.15s ease;
}

/* ------------------------------------------------------------------ 选中 -- */
.mdp-doc ::selection { background: color-mix(in srgb, var(--mdp-accent) 26%, transparent); }

/* ==========================================================================
   导出外壳：card（分享卡片）/ page（整页）
   ========================================================================== */
.mdp-shell { margin: 0; padding: 0; }
.mdp-shell[data-mode="card"] {
  display: inline-block;
  background: ${o.transparent ? 'transparent' : 'var(--mdp-bg)'};
}
.mdp-shell[data-mode="card"] .mdp-card {
  /* 卡片宽度**确定**：正文宽度 + 左右内边距 + 描边。
     若用 shrink-to-fit（inline-block），短文档会得到窄卡片、长文档得到宽卡片，
     同一个「正文宽度」设置导出的尺寸就不可预期了。 */
  display: block;
  box-sizing: border-box;
  width: ${o.contentWidth + o.cardPadding * 2 + (o.cardBorder && !o.transparent ? 2 : 0)}px;
  padding: ${o.cardPadding}px;
  border-radius: ${o.cardRadius}px;
  ${o.cardBorder && !o.transparent ? 'border: 1px solid var(--mdp-border);' : ''}
  ${o.cardShadow && !o.transparent ? 'box-shadow: 0 12px 34px -10px rgba(15, 23, 42, 0.22), 0 3px 10px -4px rgba(15, 23, 42, 0.12);' : ''}
  ${o.transparent ? 'background: transparent;' : ''}
}
.mdp-shell[data-mode="page"] .mdp-page {
  padding: ${o.margin}mm;
  ${o.transparent ? 'background: transparent;' : ''}
  min-height: 100%;
}

/* 网页预览中的仿真纸张 */
.mdp-preview-paper {
  background: var(--mdp-bg);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 12px 28px -14px rgba(15, 23, 42, 0.25);
  border-radius: 4px;
  margin: 0 auto;
}

/* ------------------------------------------------------------------ 打印 -- */
@media print {
  @page {
    size: ${paper.w}mm ${paper.h}mm;
    margin: ${o.margin}mm;
  }
  html, body { background: #fff !important; }
  /* 打印必须完整布局，不能跳过任何块 */
  .mdp-doc .mdp-block { content-visibility: visible !important; }
  /* 交互控件不该出现在产物里 */
  .mdp-doc .err-fix-btn { display: none !important; }
  .mdp-shell[data-mode="page"] .mdp-page { padding: 0 !important; }
  .mdp-doc { font-size: ${o.fontSize}pt; }
  .mdp-doc a { color: inherit; }
  .mdp-doc h1, .mdp-doc h2, .mdp-doc h3, .mdp-doc h4 { break-after: avoid-page; }
  .mdp-doc pre, .mdp-doc table, .mdp-doc .mdp-callout, .mdp-doc figure, .mdp-doc .mdp-code { break-inside: avoid; }
  .mdp-doc .mdp-copy { display: none !important; }
  .mdp-doc .mdp-anchor { display: none !important; }
  .mdp-doc { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}

/** 导出页面的完整 HTML 骨架（由服务端与 CDP 截图共用）。 */
export function buildExportHtml({ bodyHtml, css, hljsCss, katexCssHref, options = {}, lang = 'zh-CN', title = '' }) {
  const o = { ...DEFAULT_DOC_OPTIONS, ...options };
  const mode = o.card ? 'card' : 'page';
  // KaTeX 样式表必须显式引入：否则 .katex-mathml（无障碍副本）不会被隐藏，
  // 页面上会出现「公式渲染两遍」的错觉（HTML 版 + MathML 版）。
  const katexLink = katexCssHref ? `<link rel="stylesheet" href="${esc(katexCssHref)}">` : '';
  // data-static="1"：导出页面必须完整布局，不能跳过视口外的块，
  // 否则 PNG 截图（captureBeyondViewport）与 PDF 分页会缺内容。
  const staticAttr = o.static === false ? '' : ' data-static="1"';
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || o.title || 'MDP Studio')}</title>
${katexLink}
<style>${hljsCss || ''}</style>
<style>${css}</style>
<style>
  html, body { margin: 0; padding: 0; }
  body { background: ${o.transparent ? 'transparent' : 'var(--mdp-bg)'}; }
  /* 透明背景：连同内容根节点一起去掉底色，PNG 才能带 alpha 通道 */
  ${o.transparent ? 'html, body, #mdp-root, .mdp-shell, .mdp-card, .mdp-page { background: transparent !important; }' : ''}
  #mdp-root { display: inline-block; ${mode === 'page' ? 'width: 100%;' : ''} }
  /* 截图就绪标志：CDP 等待该属性出现后才截图，避免截到未完成排版的画面 */
  html[data-mdp-ready="1"] { }
</style>
</head>
<body class="mdp-doc" data-doc-theme="${esc(o.theme)}">
<div class="mdp-shell" data-mode="${mode}">
  <div id="mdp-root" class="${mode === 'card' ? 'mdp-card' : 'mdp-page'} mdp-doc" data-doc-theme="${esc(o.theme)}"${staticAttr}>
${bodyHtml}
  </div>
</div>
</body>
</html>`;
}

/**
 * 把标题/作者/日期信息块插到正文最前面。
 */
export function withDocMeta(bodyHtml, options = {}) {
  const o = { ...DEFAULT_DOC_OPTIONS, ...options };
  if (!o.showMeta || (!o.title && !o.author && !o.date)) return bodyHtml;
  const bits = [];
  if (o.author) bits.push(`<span class="mdp-byline-author">${esc(o.author)}</span>`);
  if (o.date) bits.push(`<span class="mdp-byline-date">${esc(o.date)}</span>`);
  return (
    `<header class="mdp-doc-meta">` +
    (o.title ? `<div class="mdp-title">${esc(o.title)}</div>` : '') +
    (bits.length ? `<div class="mdp-byline">${bits.join('')}</div>` : '') +
    `</header>\n${bodyHtml}`
  );
}

/** 由目录树生成 TOC 的 HTML（供网页端「插入目录」与导出使用）。 */
export function tocHtml(toc, { title = '目录', maxLevel = 3 } = {}) {
  const items = (toc || []).filter((t) => t.level >= 2 && t.level <= maxLevel + 1);
  if (items.length < 2) return '';
  const lis = items
    .map((t) => `<li class="lvl-${t.level}"><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`)
    .join('\n');
  return `<nav class="mdp-toc"><div class="mdp-toc-title">${esc(title)}</div><ol>\n${lis}\n</ol></nav>\n`;
}
