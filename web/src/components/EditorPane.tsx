/** web/src/components/EditorPane.tsx — CodeMirror 宿主，负责与 store 同步。 */

import React, { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { createEditor, type EditorHandle } from '../lib/editor';
import { useStudio } from '../lib/store';
import { setBenchSource, setBenchView } from '../lib/diagnostics';
import { publishDoc, publishSelection } from '../lib/editor-bridge';
import { setContent as setContentStore, getContent as getContentStore } from '../lib/content';
import { publishCursor } from '../lib/cursor';
import { Icon } from './Icons';

export interface EditorPaneHandle {
  insert: (text: string, caretMarker?: string) => void;
  focus: () => void;
  scrollToLine: (line: number) => void;
  /** 只滚动、不抢焦点不动光标（预览 → 编辑器同步） */
  scrollToLineQuiet: (line: number, frac?: number) => void;
  setScrollRatio: (r: number) => void;
  scrollRatio: () => number;
  openSearch: () => void;
  /* ---- 选区原语：AI 能力（转公式 / 润色 / 纠错 / 补全）依赖它们 ---- */
  getSelection: () => { text: string; from: number; to: number; empty: boolean };
  replaceRange: (from: number, to: number, text: string) => void;
  cursorContext: (before: number, after: number) => { before: string; after: string; pos: number };
}

interface Props {
  onSave: () => void;
  onRender: () => void;
  onScroll: (ratio: number, topLine: number) => void;
  /** 光标所在行变化（预览用它做"光标位置对应预览位置"） */
  onCaretLine: (line: number) => void;
  /** 切换文档前把「即将离开的文档」的最新内容立即落盘，防抖窗口内不丢字 */
  onFlush: (docId: string, content: string) => void;
}

export const EditorPane = forwardRef<EditorPaneHandle, Props>(function EditorPane(
  { onSave, onRender, onScroll, onFlush, onCaretLine }, ref,
) {
  const { state, activeDoc, patchUi } = useStudio();
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const docIdRef = useRef<string | null>(null);
  const cbRef = useRef({ onSave, onRender, onScroll, onFlush, onCaretLine });
  cbRef.current = { onSave, onRender, onScroll, onFlush, onCaretLine };

  /* 编辑器只创建一次；文档切换、选项变化都通过 handle 重配置，
     这样撤销历史、光标位置在切换设置时不会丢。 */
  useEffect(() => {
    if (!hostRef.current) return;
    const initial = getContentStore() || activeDoc?.content || '';
    const handle = createEditor({
      parent: hostRef.current,
      doc: initial,
      vim: state.ui.vim,
      wrap: state.ui.editorWrap,
      lineNumbers: state.ui.editorLineNumbers,
      fontSize: state.ui.editorFontSize,
      // 热路径：只写外部 store，不进 React state（否则整棵树陪着重渲染）
      onChange: (value) => { setBenchSource(value); setContentStore(value); publishDoc(value); },
      onSave: () => cbRef.current.onSave(),
      onRender: () => cbRef.current.onRender(),
      onScroll: (r, topLine) => cbRef.current.onScroll(r, topLine),
      onCursor: (l, c) => { publishCursor(l, c); cbRef.current.onCaretLine(l); },
      onSelection: (sel) => publishSelection(sel),
      // 粘贴截图 → 交给 AI 做「截图转公式」（App 里的 AiToolbar 监听该事件）
      onPasteImage: (file) => window.dispatchEvent(new CustomEvent('mdp:ai-image', { detail: { file } })),
    });
    handleRef.current = handle;
    setBenchView(handle.view);
    setBenchSource(initial);
    setContentStore(initial);
    publishDoc(initial);
    docIdRef.current = activeDoc?.id ?? null;
    return () => {
      handle.destroy();
      handleRef.current = null;
      setBenchView(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 切换文档：先落盘旧文档，再整体替换内容 */
  useEffect(() => {
    if (!handleRef.current || !activeDoc) return;
    if (docIdRef.current === activeDoc.id) return;
    const prevId = docIdRef.current;
    if (prevId) {
      cbRef.current.onFlush(prevId, handleRef.current.view.state.doc.toString());
    }
    docIdRef.current = activeDoc.id;
    handleRef.current.setDoc(activeDoc.content);
    setContentStore(activeDoc.content);
    publishDoc(activeDoc.content);
    handleRef.current.focus();
  }, [activeDoc?.id, activeDoc?.content]);

  /* 外部直接设置内容（导入 / 载入示例） */
  useEffect(() => {
    if (!handleRef.current || !activeDoc) return;
    if (handleRef.current.view.state.doc.toString() !== activeDoc.content) {
      handleRef.current.setDoc(activeDoc.content);
    }
  }, [activeDoc?.content]);

  useEffect(() => { handleRef.current?.setVim(state.ui.vim); }, [state.ui.vim]);
  useEffect(() => { handleRef.current?.setWrap(state.ui.editorWrap); }, [state.ui.editorWrap]);
  useEffect(() => { handleRef.current?.setLineNumbers(state.ui.editorLineNumbers); }, [state.ui.editorLineNumbers]);
  useEffect(() => { handleRef.current?.setFontSize(state.ui.editorFontSize); }, [state.ui.editorFontSize]);

  useImperativeHandle(ref, () => ({
    insert: (text, caretMarker) => handleRef.current?.insert(text, caretMarker),
    getSelection: () => handleRef.current?.getSelection() ?? { text: '', from: 0, to: 0, empty: true },
    replaceRange: (from, to, text) => handleRef.current?.replaceRange(from, to, text),
    cursorContext: (before, after) => handleRef.current?.cursorContext(before, after) ?? { before: '', after: '', pos: 0 },
    focus: () => handleRef.current?.focus(),
    scrollToLine: (line) => handleRef.current?.scrollToLine(line),
    scrollToLineQuiet: (line, frac) => handleRef.current?.scrollToLineQuiet(line, frac),
    setScrollRatio: (r) => handleRef.current?.setScrollRatio(r),
    scrollRatio: () => handleRef.current?.scrollRatio() ?? 0,
    openSearch: () => handleRef.current?.openSearch(),
  }), []);

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <Icon name="file" size={12} />
        <span>{activeDoc?.name || '未命名'}</span>
        <span className="spacer" />
        <button
          className={`btn btn-ghost btn-sm ${state.ui.vim ? 'active' : ''}`}
          title="Vim 键位 (Vim 模式下 :w 保存、:q 无效)"
          onClick={() => patchUi({ vim: !state.ui.vim })}
        >
          VIM {state.ui.vim ? 'ON' : 'OFF'}
        </button>
        <button
          className={`btn btn-ghost btn-sm ${state.ui.editorWrap ? 'active' : ''}`}
          title="自动折行"
          onClick={() => patchUi({ editorWrap: !state.ui.editorWrap })}
        >
          <Icon name="list" size={12} />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title="放大字号"
          onClick={() => patchUi({ editorFontSize: Math.min(22, state.ui.editorFontSize + 1) })}
        >A+</button>
        <button
          className="btn btn-ghost btn-sm"
          title="缩小字号"
          onClick={() => patchUi({ editorFontSize: Math.max(10, state.ui.editorFontSize - 1) })}
        >A−</button>
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  );
});

export default EditorPane;
