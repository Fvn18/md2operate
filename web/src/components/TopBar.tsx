/** web/src/components/TopBar.tsx — 顶栏：文档标签页、视图开关、导出入口。 */

import React, { useEffect, useRef, useState } from 'react';
import { useStudio } from '../lib/store';
import { Icon } from './Icons';
import type { AiStatus, Job } from '../lib/types';

interface Props {
  busy: boolean;
  aiStatus: AiStatus | null;
  onAi: (task: 'settings' | 'complete' | 'polish' | 'formula') => void;
  job: Job | null;
  capsSummary: { ok: number; warn: number; fail: number } | null;
  onRender: () => void;
  onCancel: () => void;
  onShortcuts: () => void;
  onImport: (files: FileList | null) => void;
  onCleanup: () => void;
}

export function TopBar({ busy, job, capsSummary, onRender, onCancel, onShortcuts, onImport, onCleanup, aiStatus, onAi }: Props) {
  const { state, activeDoc, selectDoc, closeDoc, addDoc, renameDoc, patchUi, duplicateDoc, pushToast } = useStudio();
  const fileRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const close = () => setMenu(false);
    if (menu) {
      window.addEventListener('click', close);
      return () => window.removeEventListener('click', close);
    }
  }, [menu]);

  const cycleTheme = () => {
    const order = ['dark', 'light', 'sepia'] as const;
    const i = order.indexOf(state.ui.appTheme);
    patchUi({ appTheme: order[(i + 1) % order.length] });
  };

  const themeIcon = state.ui.appTheme === 'dark' ? 'moon' : state.ui.appTheme === 'light' ? 'sun' : 'palette';

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">M</div>
        <div style={{ lineHeight: 1.1 }}>
          <div className="brand-name">MDP Studio</div>
          <div className="brand-ver">markdown → png / pdf</div>
        </div>
      </div>

      <div className="tabs">
        {state.docs.map((d) => (
          <div
            key={d.id}
            className={`tab ${d.id === activeDoc?.id ? 'active' : ''}`}
            onClick={() => selectDoc(d.id)}
            onDoubleClick={() => setRenaming(d.id)}
            title={d.name}
          >
            <Icon name="file" size={12} />
            {renaming === d.id ? (
              <input
                className="input"
                style={{ height: 20, padding: '0 4px', width: 110 }}
                defaultValue={d.name}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => { renameDoc(d.id, e.target.value || d.name); setRenaming(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { renameDoc(d.id, (e.target as HTMLInputElement).value || d.name); setRenaming(null); }
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="tab-name">{d.name}</span>
            )}
            {d.id === activeDoc?.id && <span className="tab-dot" />}
            <button
              className="tab-close"
              title="关闭"
              onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }}
            >×</button>
          </div>
        ))}
        <button className="tab-add" title="新建文档 (⌘⇧N)" onClick={() => addDoc()}>
          <Icon name="plus" size={13} />
        </button>
      </div>

      <div className="row" style={{ flex: '0 0 auto', gap: 4 }}>
        <button
          className={`btn btn-icon btn-ghost ${state.ui.showSide ? 'active' : ''}`}
          title="侧栏：大纲 / 模板 / 示例 / 产物 / 体检"
          onClick={() => patchUi({ showSide: !state.ui.showSide })}
        >
          <Icon name="sidebar" />
        </button>
        <button
          className={`btn btn-icon btn-ghost ${state.ui.showPreview ? 'active' : ''}`}
          title="预览开关"
          onClick={() => patchUi({ showPreview: !state.ui.showPreview })}
        >
          <Icon name={state.ui.showPreview ? 'eye' : 'eyeOff'} />
        </button>
        <button
          className={`btn btn-icon btn-ghost ${state.ui.showConsole ? 'active' : ''}`}
          title="控制台：实时查看 pandoc / XeLaTeX 原始输出"
          onClick={() => patchUi({ showConsole: !state.ui.showConsole })}
        >
          <Icon name="terminal" />
        </button>
        <button className="btn btn-icon btn-ghost" title="切换界面主题" onClick={cycleTheme}>
          <Icon name={themeIcon} />
        </button>

        <div style={{ position: 'relative' }}>
          <button className="btn btn-icon btn-ghost" title="更多" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}>
            <Icon name="sliders" />
          </button>
          {menu && (
            <div
              className="col"
              style={{
                position: 'absolute', right: 0, top: 32, zIndex: 60, minWidth: 210, gap: 2,
                background: 'var(--bg-2)', border: '1px solid var(--border-strong)',
                borderRadius: 10, padding: 6, boxShadow: 'var(--shadow-lg)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={13} /> 导入 .md 文件
              </button>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => downloadDoc(activeDoc?.name || 'doc', activeDoc?.content || '')}>
                <Icon name="download" size={13} /> 导出 Markdown 源文件
              </button>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => activeDoc && duplicateDoc(activeDoc.id)}>
                <Icon name="copy" size={13} /> 复制当前文档
              </button>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => patchUi({ sideTab: 'examples', showSide: true })}>
                <Icon name="book" size={13} /> 打开示例库
              </button>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={onCleanup}>
                <Icon name="trash" size={13} /> 清理产物目录
              </button>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={onShortcuts}>
                <Icon name="keyboard" size={13} /> 快捷键
              </button>
              <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
              <button
                className="btn btn-ghost"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => onAi('complete')}
                title="在光标处续写（⌘⇧Space）"
              >
                <Icon name="sparkle" size={13} /> AI 智能补全
              </button>
              <button
                className="btn btn-ghost"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => onAi('settings')}
                title="模型、密钥与能力开关（⌘⇧A）"
              >
                <Icon name="sliders" size={13} /> AI 设置
                <span style={{ flex: 1 }} />
                <span className={`chip ${aiStatus?.ready ? 'ok' : aiStatus?.enabled ? 'warn' : ''}`} style={{ fontSize: 10 }}>
                  {aiStatus?.ready ? (aiStatus.mock ? 'mock' : '就绪') : aiStatus?.enabled ? '缺密钥' : '关'}
                </span>
              </button>
              <button
                className="btn btn-ghost"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => pushToast('info', '截图转公式', '在编辑器里直接粘贴截图（⌘V）即可，或把图片文件拖进来')}
              >
                <Icon name="image" size={13} /> 截图转公式怎么用
              </button>
              <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => patchUi({ showExport: !state.ui.showExport })}>
                <Icon name="panelRight" size={13} /> {state.ui.showExport ? '隐藏' : '显示'}导出面板
              </button>
              <button
                className="btn btn-ghost"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => { pushToast('info', '终端等价命令', 'mdp serve 启动本工作台；mdp build note.md -t png 可脱离浏览器导出'); }}
              >
                <Icon name="terminal" size={13} /> 终端等价命令
              </button>
            </div>
          )}
        </div>

        {capsSummary && (capsSummary.fail > 0 || capsSummary.warn > 0) && (
          <button
            className={`chip ${capsSummary.fail ? 'err' : 'warn'}`}
            title="环境体检：点击查看详情"
            onClick={() => patchUi({ sideTab: 'doctor', showSide: true })}
          >
            <Icon name="activity" size={11} />
            {capsSummary.fail ? `${capsSummary.fail} 项缺失` : `${capsSummary.warn} 项提醒`}
          </button>
        )}

        <button
          className={`btn ${aiStatus?.ready ? '' : 'btn-ghost'}`}
          title={aiStatus?.ready ? 'AI 智能补全（⌘⇧Space）' : 'AI 未就绪：点击打开设置'}
          onClick={() => (aiStatus?.ready ? onAi('complete') : onAi('settings'))}
        >
          <Icon name="sparkle" size={13} /> AI
        </button>

        <button
          className={`btn ${busy ? '' : 'btn-primary'}`}
          style={{ minWidth: 104 }}
          onClick={busy ? onCancel : onRender}
          title={busy ? '取消当前任务' : '渲染并导出 (⌘↵)'}
        >
          <Icon name={busy ? 'x' : 'play'} size={13} className={busy ? '' : ''} />
          {busy ? '取消' : '导出'}
        </button>

        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { onImport(e.target.files); e.target.value = ''; }}
        />
      </div>
    </header>
  );
}

function downloadDoc(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default TopBar;
