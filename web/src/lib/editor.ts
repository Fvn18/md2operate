/**
 * web/src/lib/editor.ts — CodeMirror 6 编辑器装配。
 *
 * 选择 CodeMirror 而不是 Monaco 的理由：
 *   · 体积小一个数量级（Monaco 光加载器就 ~2MB），本地工具应当秒开；
 *   · 官方生态里就有成熟的 Vim 键位（@replit/codemirror-vim），而 Monaco 的
 *     vim 插件长期缺少维护；
 *   · 移动端 / 无 worker 环境更省心（Monaco 依赖 web worker）。
 *
 * 这里把「主题、字号、折行、行号、Vim」都做成 Compartment，运行时可即时切换
 * 而不重建文档状态（撤销历史、光标位置都保留）。
 */

import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
  placeholder as cmPlaceholder, highlightTrailingWhitespace,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
  foldGutter, foldKeymap,
} from '@codemirror/language';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { vim, getCM } from '@replit/codemirror-vim';

/** 只保留常用的代码语言，避免把 language-data 的全部动态 chunk 都打进产物。 */
const CURATED_LANGS = [
  'javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx', 'python', 'py',
  'c', 'c++', 'cpp', 'csharp', 'java', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala',
  'json', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'less',
  'bash', 'sh', 'shell', 'zsh', 'powershell', 'sql', 'r', 'julia', 'matlab', 'octave',
  'haskell', 'ocaml', 'lisp', 'scheme', 'lua', 'perl', 'dockerfile', 'makefile', 'nginx',
  'latex', 'tex', 'markdown', 'md', 'diff', 'wasm', 'nix', 'protobuf', 'graphql', 'vue',
];

const codeLanguages = languages.filter((l) => {
  const keys = [l.name, ...(l.alias || [])].map((s) => String(s).toLowerCase());
  return CURATED_LANGS.some((c) => keys.includes(c));
});

/* --------------------------------------------------------------- 主题 -- */

function editorTheme(fontSize: number): Extension {
  return EditorView.theme({
    '&': {
      fontSize: `${fontSize}px`,
      backgroundColor: 'var(--bg)',
      color: 'var(--fg)',
      height: '100%',
    },
    '.cm-content': {
      caretColor: 'var(--accent-hi)',
      padding: '14px 0 40vh',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.72',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'var(--fg-mute)',
      border: 'none',
      paddingRight: '6px',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.9em',
    },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-2)', color: 'var(--fg-dim)' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 4%, transparent)' },
    '&.cm-focused .cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-hi)', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
    },
    '.cm-panels': { backgroundColor: 'var(--bg-1)', color: 'var(--fg)', borderColor: 'var(--border)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font-ui)' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      background: 'var(--bg-2)', border: '1px solid var(--border-strong)',
      color: 'var(--fg)', borderRadius: '5px', padding: '2px 6px',
    },
    '.cm-panel.cm-search label': { color: 'var(--fg-dim)', fontSize: '11px' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 34%, transparent)', borderRadius: '2px' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 55%, transparent)' },
    '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)', outline: 'none' },
    '.cm-foldPlaceholder': { background: 'var(--bg-3)', border: 'none', color: 'var(--fg-mute)' },
    '.cm-tooltip': {
      background: 'var(--bg-2)', border: '1px solid var(--border-strong)',
      borderRadius: '8px', boxShadow: 'var(--shadow)', color: 'var(--fg)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--accent)', color: '#fff' },
    '.cm-vim-panel': {
      fontFamily: 'var(--font-mono)', fontSize: '11.5px',
      background: 'var(--bg-2)', color: 'var(--fg-dim)',
      borderTop: '1px solid var(--border)', padding: '3px 10px', minHeight: '22px',
    },
    '.cm-vim-panel input': {
      background: 'var(--bg-3)', border: '1px solid var(--accent)', color: 'var(--fg)', outline: 'none',
    },
    '.cm-vim-panel span': { color: 'var(--accent-hi)', fontWeight: '700' },
    '.cm-fat-cursor': { background: 'color-mix(in srgb, var(--accent) 60%, transparent)' },
  }, { dark: false });
}

/** Markdown + 数学 + 代码块的语法配色（跟随应用主题变量）。 */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--fg)' },
  { tag: t.heading2, fontSize: '1.28em', fontWeight: '700', color: 'var(--fg)' },
  { tag: t.heading3, fontSize: '1.13em', fontWeight: '700', color: 'var(--fg)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--fg-dim)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--accent-hi)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--fg)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--fg-mute)' },
  { tag: [t.link, t.url], color: 'var(--info)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--warn)', fontFamily: 'var(--font-mono)' },
  { tag: t.quote, color: 'var(--fg-dim)', fontStyle: 'italic' },
  { tag: [t.list, t.contentSeparator], color: 'var(--accent)' },
  { tag: t.meta, color: 'var(--fg-mute)' },
  { tag: t.processingInstruction, color: 'var(--accent)', fontWeight: '600' },
  { tag: t.comment, color: 'var(--fg-mute)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--accent-hi)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--ok)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--warn)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--info)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--accent-hi)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--fg)' },
  { tag: t.operator, color: 'var(--fg-dim)' },
  { tag: t.invalid, color: 'var(--err)' },
]);

/* ------------------------------------------------------------ 自定义命令 -- */

/** 用 Markdown 记号包裹选区（或插入占位符）。 */
export function wrapSelection(view: EditorView, before: string, after = before, placeholderText = ''): boolean {
  const changes = [];
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const body = selected || placeholderText;
  changes.push({ from: sel.from, to: sel.to, insert: `${before}${body}${after}` });
  const anchor = sel.from + before.length;
  view.dispatch({
    changes,
    selection: selected
      ? { anchor: sel.from, head: sel.from + before.length + body.length + after.length }
      : { anchor, head: anchor + body.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** 在行首插入/切换一个前缀（用于列表、引用、待办）。 */
export function toggleLinePrefix(view: EditorView, prefix: string, pattern?: RegExp): boolean {
  const { state } = view;
  const changes = [];
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from).number;
  const endLine = state.doc.lineAt(sel.to).number;
  const re = pattern || new RegExp(`^(\\s*)${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  let allHave = true;
  for (let n = startLine; n <= endLine; n++) {
    if (!re.test(state.doc.line(n).text)) { allHave = false; break; }
  }
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n);
    if (allHave) {
      const m = re.exec(line.text);
      if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: m[1] || '' });
    } else if (!re.test(line.text)) {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
  return true;
}

/* -------------------------------------------------------------- 工厂 -- */

export interface EditorHandle {
  view: EditorView;
  setVim: (on: boolean) => void;
  setWrap: (on: boolean) => void;
  setLineNumbers: (on: boolean) => void;
  setFontSize: (px: number) => void;
  setReadOnly: (on: boolean) => void;
  setDoc: (text: string) => void;
  insert: (text: string, caretMarker?: string) => void;
  /* ---- AI 能力需要的选区原语 ---- */
  getSelection: () => { text: string; from: number; to: number; empty: boolean };
  /** 用文本替换指定区间（一键应用 AI 结果的核心操作） */
  replaceRange: (from: number, to: number, text: string) => void;
  /** 选区的屏幕坐标（用于把浮动工具条贴在选区旁边） */
  selectionRect: () => { x: number; y: number; bottom: number } | null;
  /** 光标前后文（供续写补全使用），并按字符数截断，避免超长请求 */
  cursorContext: (before: number, after: number) => { before: string; after: string; pos: number };
  openSearch: () => void;
  focus: () => void;
  scrollToLine: (line: number) => void;
  scrollToId: (id: string) => boolean;
  cursorLine: () => number;
  scrollRatio: () => number;
  setScrollRatio: (r: number) => void;
  destroy: () => void;
}

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  vim: boolean;
  wrap: boolean;
  lineNumbers: boolean;
  fontSize: number;
  onChange: (value: string) => void;
  onSave?: () => void;
  onRender?: () => void;
  /** ratio = 0..1 滚动比例；topLine = 顶部可见行号（锚定式同步用它，比例同步会漂） */
  onScroll?: (ratio: number, topLine: number) => void;
  onCursor?: (line: number, col: number) => void;
  /** 选区变化（AI 浮动工具条据此显示/定位） */
  onSelection?: (sel: EditorSelection) => void;
  /** 粘贴了图片（截图转公式的入口） */
  onPasteImage?: (file: File) => void;
}

export interface EditorSelection {
  text: string;
  from: number;
  to: number;
  empty: boolean;
  /** 视口坐标，用于把浮动工具条贴在选区旁边；不可用时为 null */
  rect: { x: number; y: number; bottom: number } | null;
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const vimComp = new Compartment();
  const themeComp = new Compartment();
  const wrapComp = new Compartment();
  const gutterComp = new Compartment();
  const roComp = new Compartment();

  const saveKey = {
    key: 'Mod-s',
    preventDefault: true,
    run: () => { opts.onSave?.(); return true; },
  };
  const renderKey = {
    key: 'Mod-Enter',
    preventDefault: true,
    run: () => { opts.onRender?.(); return true; },
  };

  const mdKeymap = [
    { key: 'Mod-b', preventDefault: true, run: (v: EditorView) => wrapSelection(v, '**', '**', '粗体') },
    { key: 'Mod-i', preventDefault: true, run: (v: EditorView) => wrapSelection(v, '*', '*', '斜体') },
    { key: 'Mod-e', preventDefault: true, run: (v: EditorView) => wrapSelection(v, '`', '`', 'code') },
    { key: 'Mod-k', preventDefault: true, run: (v: EditorView) => wrapSelection(v, '[', '](https://)', '链接文字') },
    { key: 'Mod-Shift-m', preventDefault: true, run: (v: EditorView) => wrapSelection(v, '$$\n', '\n$$', 'x^2 + y^2 = z^2') },
    { key: 'Mod-Shift-t', preventDefault: true, run: (v: EditorView) => insertText(v, '::: theorem 定理名\n\n:::\n') },
    { key: 'Mod-Shift-p', preventDefault: true, run: (v: EditorView) => insertText(v, '::: 证明\n\n:::\n') },
    { key: 'Mod-Shift-k', preventDefault: true, run: (v: EditorView) => insertText(v, '```\n\n```\n') },
  ];

  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      gutterComp.of(opts.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, maxRenderedOptions: 24 }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightTrailingWhitespace(),
      search({ top: true }),
      markdown({
        base: markdownLanguage,
        codeLanguages,
        addKeymap: true,
      }),
      syntaxHighlighting(markdownHighlight),
      themeComp.of([editorTheme(opts.fontSize)]),
      wrapComp.of(opts.wrap ? EditorView.lineWrapping : []),
      roComp.of([]),
      vimComp.of(opts.vim ? vim() : []),
      keymap.of([
        saveKey, renderKey, ...mdKeymap,
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
        ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange(u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const sel = u.state.selection.main;
          const line = u.state.doc.lineAt(sel.head);
          opts.onCursor?.(line.number, sel.head - line.from + 1);
          if (opts.onSelection) {
            let rect: EditorSelection['rect'] = null;
            if (!sel.empty) {
              try {
                const a = u.view.coordsAtPos(sel.from);
                const b = u.view.coordsAtPos(sel.to);
                rect = a && b ? { x: b.left, y: a.top, bottom: a.bottom } : null;
              } catch { rect = null; }
            }
            opts.onSelection({
              text: u.state.sliceDoc(sel.from, sel.to),
              from: sel.from,
              to: sel.to,
              empty: sel.empty,
              rect,
            });
          }
        }
      }),
      EditorView.domEventHandlers({
        paste: (ev) => {
          const items = ev.clipboardData?.items;
          if (!items || !opts.onPasteImage) return false;
          for (const it of items) {
            if (it.kind === 'file' && it.type.startsWith('image/')) {
              const file = it.getAsFile();
              if (file) { ev.preventDefault(); opts.onPasteImage(file); return true; }
            }
          }
          return false;
        },
        scroll: (_ev, view) => {
          const el = view.scrollDOM;
          const max = el.scrollHeight - el.clientHeight;
          const ratio = max > 0 ? el.scrollTop / max : 0;
          // 锚定式同步的关键：给出**顶部可见行号**，预览据此把对应块对齐到顶部。
          // 只用比例的话，编辑器与预览的"密度"不同，长文档必然越滚越偏。
          let topLine = 1;
          try {
            // 用 posAtCoords（客户端坐标）而不是 lineBlockAtHeight：
            // 后者的坐标空间容易搞错（文档高度 vs 视口高度），实测会算出偏小的行号，
            // 于是预览总是滚不到位。
            const r = el.getBoundingClientRect();
            const pos = view.posAtCoords({ x: r.left + 8, y: r.top + 6 });
            if (pos != null) topLine = view.state.doc.lineAt(pos).number;
          } catch { /* 布局尚未就绪时忽略 */ }
          opts.onScroll?.(ratio, topLine);
          return false;
        },
      }),
    ],
  });

  const view = new EditorView({ state, parent: opts.parent });

  return {
    view,
    setVim: (on) => {
      const cm = getCM(view);
      if (!on && cm) cm.destroy?.();
      view.dispatch({ effects: vimComp.reconfigure(on ? vim() : []) });
    },
    setWrap: (on) => view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }),
    setLineNumbers: (on) => view.dispatch({
      effects: gutterComp.reconfigure(on ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
    }),
    setFontSize: (px) => view.dispatch({ effects: themeComp.reconfigure([editorTheme(px)]) }),
    setReadOnly: (on) => view.dispatch({ effects: roComp.reconfigure(on ? EditorState.readOnly.of(true) : []) }),
    setDoc: (text) => {
      if (view.state.doc.toString() === text) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
    },
    getSelection: () => {
      const sel = view.state.selection.main;
      return {
        text: view.state.sliceDoc(sel.from, sel.to),
        from: sel.from,
        to: sel.to,
        empty: sel.empty,
      };
    },
    replaceRange: (from, to, text) => {
      const a = Math.max(0, Math.min(from, view.state.doc.length));
      const b = Math.max(a, Math.min(to, view.state.doc.length));
      view.dispatch({
        changes: { from: a, to: b, insert: text },
        selection: { anchor: a + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    selectionRect: () => {
      const sel = view.state.selection.main;
      try {
        const a = view.coordsAtPos(sel.from);
        const b = view.coordsAtPos(sel.to);
        if (!a || !b) return null;
        const host = view.dom.getBoundingClientRect();
        void host;
        return { x: b.left, y: a.top, bottom: a.bottom };
      } catch {
        return null;
      }
    },
    cursorContext: (before, after) => {
      const pos = view.state.selection.main.head;
      const from = Math.max(0, pos - before);
      const to = Math.min(view.state.doc.length, pos + after);
      return { before: view.state.sliceDoc(from, pos), after: view.state.sliceDoc(pos, to), pos };
    },
    insert: (text, caretMarker) => {
      const sel = view.state.selection.main;
      const marker = caretMarker && text.includes(caretMarker) ? caretMarker : null;
      const clean = marker ? text.replace(marker, '') : text;
      const offset = marker ? text.indexOf(marker) : clean.length;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: clean },
        selection: { anchor: sel.from + offset },
        scrollIntoView: true,
      });
      view.focus();
    },
    openSearch: () => { openSearchPanel(view); },
    focus: () => view.focus(),
    scrollToLine: (line) => {
      const n = Math.max(1, Math.min(view.state.doc.lines, line));
      const pos = view.state.doc.line(n).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }) });
      view.focus();
    },
    scrollToId: () => false,
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    scrollRatio: () => {
      const el = view.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      return max > 0 ? el.scrollTop / max : 0;
    },
    setScrollRatio: (r) => {
      const el = view.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0) el.scrollTop = Math.max(0, Math.min(1, r)) * max;
    },
    destroy: () => view.destroy(),
  };
}

function insertText(view: EditorView, text: string): boolean {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export { undo, redo };
