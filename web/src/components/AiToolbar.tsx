/**
 * web/src/components/AiToolbar.tsx — AI 浮动工具条 + 流式结果卡片。
 *
 * 交互设计取舍：
 *   · 选中文字后，工具条贴在选区右下角浮出（不占用固定屏幕空间）。
 *   · 长文本任务（公式/润色/续写）**边生成边显示**，随时可中断。
 *   · 结果卡片给的是"可执行动作"而不是一段只读文本：公式给 KaTeX 实时预览 +
 *     [替换选区]，润色给 [替换选区]，续写给 [插入到光标]——落到文档里才算完成。
 *
 * 之所以能这么轻：AI 状态与密钥全在本机后台，前端只面对 `/api/ai/*`；
 * 而选区来自 editor-bridge（外部 store），不经过 App，所以移动选区不会引发全局重渲染。
 */

import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import katex from 'katex';
import { aiStream, aiStructured, fileToBase64, MAX_IMAGE_BYTES } from '../lib/ai';
import { useEditorBridge, locateInDoc } from '../lib/editor-bridge';
import { getContent } from '../lib/content';
import type { EditorPaneHandle } from './EditorPane';
import type { AiStatus } from '../lib/types';
import { Icon } from './Icons';

export interface AiToolbarHandle {
  /** 由外部（菜单/快捷键）触发一个任务 */
  run: (task: AiTaskId, seed?: { text?: string }) => void;
  busy: () => boolean;
}

export type AiTaskId = 'complete' | 'formula' | 'polish' | 'fix' | 'image';

interface Props {
  editorRef: React.RefObject<EditorPaneHandle | null>;
  status: AiStatus | null;
  onToast: (kind: 'ok' | 'err' | 'warn' | 'info', title: string, msg?: string) => void;
  onOpenSettings: () => void;
}

interface Result {
  task: AiTaskId;
  text: string;
  streaming: boolean;
  model: string;
  mock: boolean;
  error?: string | null;
  /** fix 任务的结构化结果 */
  structured?: Record<string, unknown> | null;
  targetRange?: { from: number; to: number } | null;
}

const TASK_LABEL: Record<AiTaskId, string> = {
  complete: '智能补全',
  formula: '文本转公式',
  polish: '润色',
  fix: '公式纠错',
  image: '截图转公式',
};

export const AiToolbar = forwardRef<AiToolbarHandle, Props>(function AiToolbar(
  { editorRef, status, onToast, onOpenSettings }, ref,
) {
  const { selection } = useEditorBridge();
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const enabled = Boolean(status?.enabled);
  const ready = Boolean(status?.ready);

  /* ------------------------------------------------------------ 执行 -- */
  const run = useCallback(async (task: AiTaskId, seed?: { text?: string }) => {
    if (!ready) {
      onToast('warn', 'AI 未就绪', status?.hasKey ? '请在「AI 设置」里启用' : '请先在「AI 设置」里填入 Gemini 密钥');
      onOpenSettings();
      return;
    }
    const handle = editorRef.current;
    if (!handle) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const sel = handle.getSelection();
    let params: Record<string, unknown> = {};
    let targetRange: { from: number; to: number } | null = null;

    if (task === 'complete') {
      const ctx = handle.cursorContext(4000, 1200);
      params = { before: ctx.before, after: ctx.after };
      targetRange = { from: ctx.pos, to: ctx.pos };
    } else if (task === 'formula' || task === 'polish') {
      const text = seed?.text ?? sel.text;
      if (!text.trim()) { onToast('warn', '请先选中一段文本'); return; }
      params = { text };
      targetRange = seed?.text ? null : { from: sel.from, to: sel.to };
    } else if (task === 'fix') {
      onToast('info', '公式纠错请从预览区的错误提示发起');
      return;
    }

    setResult({ task, text: '', streaming: true, model: status?.model || '', mock: Boolean(status?.mock), targetRange });

    try {
      const text = await aiStream(task, params, {
        onStart: (info) => setResult((r) => (r ? { ...r, model: info.model, mock: info.mock } : r)),
        onDelta: (_d, full) => setResult((r) => (r ? { ...r, text: full } : r)),
        onDone: () => setResult((r) => (r ? { ...r, streaming: false } : r)),
      }, ac.signal);
      setResult((r) => (r ? { ...r, text, streaming: false } : r));
    } catch (err) {
      if ((err as Error).name === 'AbortError') { setResult(null); return; }
      const msg = (err as Error).message;
      setResult((r) => (r ? { ...r, streaming: false, error: msg } : r));
      onToast('err', `${TASK_LABEL[task]}失败`, msg);
    }
  }, [editorRef, onOpenSettings, onToast, ready, status]);

  /* ---- 截图转公式：不依赖选区，全流程结构化，成功后直接替换/插入 ---- */
  const runImage = useCallback(async (file: Blob) => {
    if (!ready) { onToast('warn', 'AI 未就绪'); onOpenSettings(); return; }
    if (file.size > MAX_IMAGE_BYTES) {
      onToast('err', '图片过大', `${(file.size / 1048576).toFixed(1)} MB > 上限 ${MAX_IMAGE_BYTES / 1048576} MB`);
      return;
    }
    const handle = editorRef.current;
    if (!handle) return;
    setResult({ task: 'image', text: '', streaming: true, model: status?.model || '', mock: Boolean(status?.mock) });
    try {
      const { data, mimeType } = await fileToBase64(file);
      const out = await aiStructured<{ latex: string; display?: boolean; note?: string }>('image', { image: data, mimeType });
      const latex = String(out.structured?.latex || '').trim();
      if (!latex) {
        setResult(null);
        onToast('warn', '没识别到公式', out.structured?.note || '换一张更清晰的截图试试');
        return;
      }
      const sel = handle.getSelection();
      const wrapped = out.structured?.display ? `\n$$\n${latex}\n$$\n` : `$${latex}$`;
      setResult({
        task: 'image', text: latex, streaming: false, model: out.model, mock: out.mock,
        targetRange: { from: sel.from, to: sel.to },
        structured: { ...out.structured, wrapped },
      });
    } catch (err) {
      setResult(null);
      onToast('err', '截图转公式失败', (err as Error).message);
    }
  }, [editorRef, onOpenSettings, onToast, ready, status]);

  /* ---- 公式错误一键修复（由预览区错误提示发起） ---- */
  const runFix = useCallback(async (tex: string, error: string, line?: number | null) => {
    if (!ready) { onToast('warn', 'AI 未就绪'); onOpenSettings(); return; }
    const handle = editorRef.current;
    if (!handle) return;
    const range = locateInDoc(getContent(), tex, line);
    setResult({ task: 'fix', text: '', streaming: true, model: status?.model || '', mock: Boolean(status?.mock), targetRange: range });
    try {
      const out = await aiStructured<{ fixed: string; explanation?: string; impossible?: boolean }>('fix', { tex, error });
      setResult({
        task: 'fix',
        text: String(out.structured?.fixed || ''),
        streaming: false,
        model: out.model,
        mock: out.mock,
        targetRange: range,
        structured: out.structured,
      });
    } catch (err) {
      setResult(null);
      onToast('err', '公式纠错失败', (err as Error).message);
    }
  }, [editorRef, onOpenSettings, onToast, ready, status]);

  useImperativeHandle(ref, () => ({
    run: (task, seed) => { void run(task, seed); },
    busy: () => Boolean(result?.streaming),
  }), [run, result]);

  /* 全局事件：预览区的错误提示、顶栏菜单、编辑器头部的按钮都通过它发起 */
  useEffect(() => {
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.kind === 'settings') { onOpenSettings(); return; }
      if (d.kind === 'fix') void runFix(d.tex, d.error, d.line);
      else if (d.kind === 'image' && d.file) void runImage(d.file);
      else if (d.kind) void run(d.kind, d.seed);
    };
    const onPaste = (e: Event) => {
      const file = (e as CustomEvent).detail?.file;
      if (file) void runImage(file);
    };
    window.addEventListener('mdp:ai', onEvent);
    window.addEventListener('mdp:ai-image', onPaste);
    return () => {
      window.removeEventListener('mdp:ai', onEvent);
      window.removeEventListener('mdp:ai-image', onPaste);
    };
  }, [run, runFix, runImage]);

  /* ESC 关闭结果卡片 */
  useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { abortRef.current?.abort(); setResult(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result]);

  /* ------------------------------------------------------------ 应用 -- */
  const applyReplace = () => {
    const handle = editorRef.current;
    if (!handle || !result) return;
    const text = result.task === 'image'
      ? String(result.structured?.wrapped ?? `$${result.text}$`)
      : result.text;
    const range = result.targetRange ?? handle.getSelection();
    handle.replaceRange(range.from, range.to, text);
    onToast('ok', '已应用', TASK_LABEL[result.task]);
    setResult(null);
  };

  const applyInsert = () => {
    const handle = editorRef.current;
    if (!handle || !result) return;
    const text = result.task === 'image'
      ? String(result.structured?.wrapped ?? `$${result.text}$`)
      : result.text;
    handle.replaceRange(result.targetRange?.to ?? handle.getSelection().to, result.targetRange?.to ?? handle.getSelection().to, text);
    onToast('ok', '已插入');
    setResult(null);
  };

  /* ------------------------------------------------------- 公式预览 -- */
  const formulaHtml = useMemo(() => {
    if (!result || (result.task !== 'formula' && result.task !== 'fix' && result.task !== 'image')) return '';
    const tex = result.text.trim();
    if (!tex) return '';
    try {
      return katex.renderToString(tex, { displayMode: result.task !== 'formula' ? false : false, throwOnError: true, strict: 'ignore' });
    } catch {
      return '';
    }
  }, [result]);

  const showSelectionBar = enabled && ready && !result && !selection.empty && selection.rect;

  return (
    <>
      {/* 浮动选区工具条 */}
      {showSelectionBar && (
        <div
          className="ai-float"
          style={{
            left: Math.max(8, Math.min(window.innerWidth - 260, selection.rect!.x - 40)),
            top: Math.min(window.innerHeight - 48, selection.rect!.bottom + 8),
          }}
        >
          <button className="ai-chip" title="把选中的描述转成 LaTeX 公式" onClick={() => run('formula')}>
            <Icon name="sparkle" size={11} /> 公式
          </button>
          <button className="ai-chip" title="润色选中段落（保留公式与结构）" onClick={() => run('polish')}>
            <Icon name="wand" size={11} /> 润色
          </button>
          <button
            className="ai-chip"
            title="把选中的描述转成行间公式并替换"
            onClick={() => run('formula')}
            style={{ display: 'none' }}
          >行间</button>
        </div>
      )}

      {/* 结果卡片 */}
      {result && (
        <div className="ai-card" ref={cardRef}>
          <div className="ai-card-head">
            <Icon name="sparkle" size={12} />
            <span style={{ fontWeight: 700 }}>{TASK_LABEL[result.task]}</span>
            {result.mock && <span className="chip warn" title="当前是 mock 模式（无密钥），输出为占位内容">mock</span>}
            {result.streaming && <span className="dot busy" />}
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>{result.model}</span>
            <button className="btn btn-ghost btn-sm" title="关闭 (Esc)" onClick={() => { abortRef.current?.abort(); setResult(null); }}>
              <Icon name="x" size={12} />
            </button>
          </div>

          {result.error && <div className="ai-card-body" style={{ color: 'var(--err)' }}>{result.error}</div>}

          {!result.error && (
            <>
              {formulaHtml && (
                <div className="ai-card-preview" dangerouslySetInnerHTML={{ __html: formulaHtml }} />
              )}
              <pre className="ai-card-body">{result.text || (result.streaming ? '…' : '')}</pre>
              {result.task === 'fix' && typeof result.structured?.explanation === 'string' && (
                <div className="ai-card-note">
                  {String(result.structured.explanation)}
                  {result.structured.impossible ? '（KaTeX 可能无法表达该公式）' : ''}
                </div>
              )}
              {result.task === 'image' && typeof result.structured?.note === 'string' && result.structured.note && (
                <div className="ai-card-note">{String(result.structured.note)}</div>
              )}
            </>
          )}

          <div className="ai-card-foot">
            <button className="btn btn-sm btn-primary" disabled={result.streaming || !result.text} onClick={applyReplace}>
              <Icon name="check" size={11} /> {result.task === 'complete' ? '在光标处插入' : '替换选区'}
            </button>
            {result.task !== 'complete' && (
              <button className="btn btn-sm" disabled={result.streaming || !result.text} onClick={applyInsert}>
                <Icon name="plus" size={11} /> 插入
              </button>
            )}
            <button
              className="btn btn-sm btn-ghost"
              disabled={!result.text}
              onClick={() => { navigator.clipboard?.writeText(result.text); onToast('ok', '已复制'); }}
            >
              <Icon name="copy" size={11} /> 复制
            </button>
            <span style={{ flex: 1 }} />
            {result.streaming && (
              <button className="btn btn-sm btn-danger" onClick={() => { abortRef.current?.abort(); setResult(null); }}>
                停止
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
});

export default AiToolbar;
