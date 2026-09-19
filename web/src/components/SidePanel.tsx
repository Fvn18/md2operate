/**
 * web/src/components/SidePanel.tsx
 * 侧栏：大纲 / 模板 / 示例 / 产物 / 体检 五个面板。
 */

import React, { useEffect, useState } from 'react';
import { useStudio } from '../lib/store';
import { api } from '../lib/api';
import { usePreviewState } from '../lib/preview-state';
import { Icon, type IconName } from './Icons';
import { TEMPLATES, TEMPLATE_GROUPS } from '../lib/templates';
import type { Artifact, CapsResponse } from '../lib/types';

interface Props {
  onJump: (id: string) => void;
  onInsert: (text: string, caret?: string) => void;
  caps: CapsResponse | null;
  onRefreshCaps: () => void;
  onToast: (kind: 'ok' | 'err' | 'warn' | 'info', title: string, msg?: string) => void;
}

const TABS: Array<{ id: 'outline' | 'templates' | 'examples' | 'artifacts' | 'doctor'; icon: IconName; label: string }> = [
  { id: 'outline', icon: 'list', label: '大纲' },
  { id: 'templates', icon: 'grid', label: '模板' },
  { id: 'examples', icon: 'book', label: '示例' },
  { id: 'artifacts', icon: 'package', label: '产物' },
  { id: 'doctor', icon: 'activity', label: '体检' },
];

export function SidePanel({ onJump, onInsert, caps, onRefreshCaps, onToast }: Props) {
  const { state, patchUi, setContent, activeDoc, addDoc, pushToast } = useStudio();
  // 大纲直接订阅预览派生总线：目录变化不该让 App 重渲染
  const { toc: outline } = usePreviewState();
  const [examples, setExamples] = useState<Array<{ name: string; size: number }>>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);

  const tab = state.ui.sideTab;

  useEffect(() => {
    api.examples().then((r) => setExamples(r.examples || [])).catch(() => setExamples([]));
  }, []);

  const loadArtifacts = () => {
    setLoadingArtifacts(true);
    api.artifacts(200)
      .then((r) => setArtifacts(r.artifacts || []))
      .catch(() => setArtifacts([]))
      .finally(() => setLoadingArtifacts(false));
  };

  useEffect(() => {
    if (tab === 'artifacts') loadArtifacts();
  }, [tab]);

  // 渲染完成后自动刷新产物列表
  useEffect(() => {
    if (tab === 'artifacts' && state.job?.status === 'done') loadArtifacts();
  }, [state.job?.status, tab]);

  return (
    <div className="row" style={{ alignItems: 'stretch', minHeight: 0, flex: '0 0 auto' }}>
      <div className="rail">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`rail-btn ${tab === t.id && state.ui.showSide ? 'active' : ''}`}
            title={t.label}
            onClick={() => {
              if (tab === t.id && state.ui.showSide) patchUi({ showSide: false });
              else patchUi({ sideTab: t.id, showSide: true });
            }}
          >
            <Icon name={t.icon} size={16} />
            {t.id === 'artifacts' && artifacts.length > 0 && <span className="badge">{artifacts.length}</span>}
            {t.id === 'doctor' && caps && caps.summary.fail > 0 && <span className="badge" style={{ background: 'var(--err)' }}>{caps.summary.fail}</span>}
          </button>
        ))}
      </div>

      {state.ui.showSide && (
        <div className="side-panel" style={{ width: state.ui.sideWidth, flexBasis: state.ui.sideWidth }}>
          <div className="pane-head" style={{ height: 30 }}>
            <Icon name={TABS.find((t) => t.id === tab)!.icon} size={12} />
            <span>{TABS.find((t) => t.id === tab)!.label}</span>
            <span className="spacer" />
            {tab === 'artifacts' && (
              <button className="btn btn-ghost btn-sm" title="刷新" onClick={loadArtifacts}>
                <Icon name="refresh" size={12} className={loadingArtifacts ? 'spin' : ''} />
              </button>
            )}
            {tab === 'doctor' && (
              <button className="btn btn-ghost btn-sm" title="重新探测" onClick={onRefreshCaps}>
                <Icon name="refresh" size={12} />
              </button>
            )}
            <button className="btn btn-ghost btn-sm" title="收起" onClick={() => patchUi({ showSide: false })}>
              <Icon name="chevronRight" size={12} />
            </button>
          </div>

          <div className="side-body">
            {tab === 'outline' && (
              <>
                <div className="side-section-title">
                  <Icon name="hash" size={11} /> 文档结构
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 10 }}>{outline.length}</span>
                </div>
                {outline.length === 0 && <div className="empty-note">还没有标题。用 <code>#</code> 开头的行会出现在这里。</div>}
                {outline.map((t, i) => (
                  <button key={`${t.id}-${i}`} className={`outline-item lvl-${t.level}`} onClick={() => onJump(t.id)} title={t.text}>
                    {t.text || '(空标题)'}
                  </button>
                ))}
              </>
            )}

            {tab === 'templates' && (
              <>
                {TEMPLATE_GROUPS.map((g) => (
                  <React.Fragment key={g}>
                    <div className="side-section-title"><Icon name="wand" size={11} /> {g}</div>
                    <div className="tpl-grid">
                      {TEMPLATES.filter((t) => t.group === g).map((t) => (
                        <button key={t.id} className="tpl-btn" title={t.hint} onClick={() => onInsert(t.insert, t.caret)}>
                          <span className="truncate">{t.label}</span>
                        </button>
                      ))}
                    </div>
                  </React.Fragment>
                ))}
              </>
            )}

            {tab === 'examples' && (
              <>
                <div className="side-section-title"><Icon name="folder" size={11} /> examples/</div>
                {examples.length === 0 && <div className="empty-note">没有找到示例文件。</div>}
                {examples.map((ex) => (
                  <div key={ex.name} className="col" style={{ gap: 4, marginBottom: 6 }}>
                    <button
                      className="outline-item"
                      onClick={async () => {
                        try {
                          const r = await api.example(ex.name);
                          addDoc(ex.name.replace(/\.(md|markdown)$/i, ''), r.content);
                          pushToast('ok', '已载入示例', ex.name);
                        } catch (err) {
                          pushToast('err', '载入失败', (err as Error).message);
                        }
                      }}
                    >
                      {ex.name}
                    </button>
                    <div className="row" style={{ gap: 4, paddingLeft: 7 }}>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>{formatBytes(ex.size)}</span>
                      <span style={{ flex: 1 }} />
                      <button
                        className="btn btn-ghost btn-sm"
                        title="追加到当前文档末尾"
                        onClick={async () => {
                          try {
                            const r = await api.example(ex.name);
                            setContent(`${activeDoc?.content || ''}\n\n${r.content}`);
                            pushToast('ok', '已追加到当前文档');
                          } catch (err) { pushToast('err', '载入失败', (err as Error).message); }
                        }}
                      >追加</button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === 'artifacts' && (
              <>
                <div className="side-section-title">
                  <Icon name="package" size={11} /> 最近产出
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 10 }}>{artifacts.length}</span>
                </div>
                {artifacts.length === 0 && <div className="empty-note">还没有产物。点右上角「导出」或按 ⌘↵ 开始渲染。</div>}
                {artifacts.map((a) => (
                  <div className="artifact" key={a.rel}>
                    <div className="artifact-thumb">
                      {a.ext === 'png'
                        ? <img src={api.fileUrl(a.rel)} alt={a.name} loading="lazy" />
                        : <Icon name={a.ext === 'pdf' ? 'file' : a.ext === 'tex' ? 'code' : 'file'} size={18} />}
                    </div>
                    <div className="artifact-meta">
                      <div className="artifact-name" title={a.file}>{a.name}</div>
                      <div className="artifact-sub">
                        {a.width ? `${a.width}×${a.height} · ` : ''}{formatBytes(a.bytes)} · {a.route}
                        {a.tool ? ` · ${a.tool}` : ''}
                      </div>
                      <div className="row" style={{ gap: 4, marginTop: 5 }}>
                        <a className="btn btn-sm" href={api.fileUrl(a.rel, true)} download={a.name}>下载</a>
                        <a className="btn btn-sm btn-ghost" href={api.fileUrl(a.rel)} target="_blank" rel="noreferrer">打开</a>
                        <button
                          className="btn btn-sm btn-ghost"
                          title="复制服务器路径"
                          onClick={() => { navigator.clipboard?.writeText(a.file); onToast('ok', '已复制路径', a.file); }}
                        ><Icon name="copy" size={11} /></button>
                        <span style={{ flex: 1 }} />
                        <button
                          className="btn btn-sm btn-ghost btn-danger"
                          title="删除"
                          onClick={async () => {
                            try { await api.deleteArtifact(a.rel); setArtifacts((list) => list.filter((x) => x.rel !== a.rel)); }
                            catch (err) { onToast('err', '删除失败', (err as Error).message); }
                          }}
                        ><Icon name="trash" size={11} /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === 'doctor' && <DoctorPanel caps={caps} onRefresh={onRefreshCaps} />}
          </div>
        </div>
      )}
    </div>
  );
}

function DoctorPanel({ caps, onRefresh }: { caps: CapsResponse | null; onRefresh: () => void }) {
  if (!caps) return <div className="empty-note">正在探测环境…</div>;
  const groups = [...new Set(caps.checks.map((c) => c.group))];
  const icon = { ok: 'check', warn: 'alert', fail: 'x' } as const;
  const color = { ok: 'var(--ok)', warn: 'var(--warn)', fail: 'var(--err)' } as const;
  return (
    <>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="chip ok">{caps.summary.ok} 正常</span>
        {caps.summary.warn > 0 && <span className="chip warn">{caps.summary.warn} 提醒</span>}
        {caps.summary.fail > 0 && <span className="chip err">{caps.summary.fail} 缺失</span>}
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm btn-ghost" onClick={onRefresh}><Icon name="refresh" size={11} /> 重探</button>
      </div>
      <div className="empty-note" style={{ paddingTop: 0 }}>
        <span className="mono" style={{ fontSize: 10 }}>{caps.runtime.projectRoot}</span><br />
        Node {caps.runtime.node} · {caps.runtime.platform}/{caps.runtime.arch}
      </div>
      {groups.map((g) => (
        <React.Fragment key={g}>
          <div className="check-group">{g}</div>
          {caps.checks.filter((c) => c.group === g).map((c) => (
            <div className="check-row" key={c.id}>
              <span style={{ color: color[c.status], paddingTop: 1 }}><Icon name={icon[c.status]} size={13} /></span>
              <div>
                <div>{c.label}</div>
                {c.detail && <div className="check-detail">{c.detail}</div>}
                {c.hint && c.status !== 'ok' && <div className="check-hint">→ {c.hint}</div>}
              </div>
            </div>
          ))}
        </React.Fragment>
      ))}
      {caps.rasterizers?.length > 0 && (
        <>
          <div className="check-group">栅格化后端优先级</div>
          {caps.rasterizers.map((r, i) => (
            <div className="check-row" key={r.id}>
              <span style={{ color: i === 0 ? 'var(--ok)' : 'var(--fg-mute)', paddingTop: 1 }}>
                <Icon name={i === 0 ? 'check' : 'info'} size={13} />
              </span>
              <div>
                <div>{r.label} {i === 0 && <span className="chip ok" style={{ marginLeft: 4 }}>当前</span>}</div>
                <div className="check-detail">{r.path}</div>
                <div className="check-detail" style={{ color: r.realDpi ? 'var(--ok)' : 'var(--warn)' }}>{r.note}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function formatBytes(n: number) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export default SidePanel;
