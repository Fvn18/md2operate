/**
 * web/src/components/ExportDrawer.tsx — 导出面板。
 *
 * 五个标签页分别对应导出时真正会变化的四组参数 + 产物：
 *   输出（产出什么）/ 排版（HTML 路线的样式）/ LaTeX（套哪个档位）/ 命令（将要执行的
 *   真实命令行）/ 产物（这次生成了什么）。设置与 CLI 参数一一对应，不做隐藏魔法。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useStudio } from '../lib/store';
import { api, buildPayload } from '../lib/api';
import { Icon, type IconName } from './Icons';
import type { Artifact, Job, MetaResponse, Target } from '../lib/types';

interface Props {
  meta: MetaResponse | null;
  job: Job | null;
  busy: boolean;
  running: boolean;
  onRender: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onToast: (kind: 'ok' | 'err' | 'warn' | 'info', title: string, msg?: string) => void;
}

const ROUTE_ICON: Record<string, IconName> = {
  png: 'image', pdf: 'file', 'pdf-html': 'globe', tex: 'code', html: 'globe', docx: 'word', md: 'file',
};

export function ExportDrawer({ meta, job, busy, running, onRender, onCancel, onRetry, onToast }: Props) {
  const { state, activeDoc, patchSettings, patchUi, pushToast, addDoc } = useStudio();
  const { settings, ui } = state;
  const [plan, setPlan] = useState<Array<{ target: string; engine: string; command: string }>>([]);
  const [recent, setRecent] = useState<Artifact[]>([]);

  /* 「产物」页：显示本次任务的产物；刷新页面后回退到服务端产物目录，
     这样历史成果不会因为一次刷新就“消失”。 */
  useEffect(() => {
    if (ui.drawerTab !== 'artifacts') return;
    api.artifacts(60).then((r) => setRecent(r.artifacts || [])).catch(() => setRecent([]));
  }, [ui.drawerTab, job?.status]);

  const jobArtifacts = job?.artifacts || [];
  const shown = useMemo(() => {
    const seen = new Set(jobArtifacts.map((a) => a.rel));
    return [...jobArtifacts, ...recent.filter((a) => !seen.has(a.rel))];
  }, [jobArtifacts, recent]);

  /* 「命令」页实时反映当前设置 → 真实命令行（400ms 防抖） */
  useEffect(() => {
    if (ui.drawerTab !== 'command') return;
    const t = window.setTimeout(() => {
      api.plan(buildPayload(activeDoc?.content || '', settings))
        .then((r) => setPlan(r.commands || []))
        .catch(() => setPlan([]));
    }, 400);
    return () => window.clearTimeout(t);
  }, [ui.drawerTab, settings, activeDoc?.content]);

  const routes = meta?.routes || [];
  const presets = meta?.presets?.presets || [];
  const themes = meta?.docThemes || [];
  const papers = Object.keys(meta?.paperSizes || { A4: { w: 210, h: 297 } });

  const toggleTarget = (id: Target) => {
    const has = settings.targets.includes(id);
    const next = has ? settings.targets.filter((t) => t !== id) : [...settings.targets, id];
    patchSettings({ targets: next.length ? next : [id] });
  };

  const pngWidth = useMemo(() => {
    if (settings.png.mode === 'card') {
      return Math.round(settings.doc.contentWidth + settings.doc.cardPadding * 2 + (settings.doc.cardBorder ? 2 : 0));
    }
    const paper = meta?.paperSizes?.[settings.doc.paper] || { w: 210 };
    return Math.round((paper.w * 96) / 25.4);
  }, [settings.png.mode, settings.doc, meta]);

  const hasPng = settings.targets.includes('png');
  const hasLatex = settings.targets.some((t) => t === 'pdf' || t === 'tex' || t === 'docx')
    || (hasPng && settings.png.engine === 'latex');

  return (
    <aside className="drawer" style={{ width: ui.drawerWidth, flexBasis: ui.drawerWidth }}>
      <div className="drawer-tabs">
        {([
          ['output', '输出'],
          ['layout', '排版'],
          ['latex', 'LaTeX'],
          ['command', '命令'],
          ['artifacts', '产物'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            className={`drawer-tab ${ui.drawerTab === id ? 'active' : ''}`}
            onClick={() => patchUi({ drawerTab: id })}
          >{label}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" title="收起导出面板" onClick={() => patchUi({ showExport: false })}>
          <Icon name="chevronRight" size={12} />
        </button>
      </div>

      <div className="drawer-body">
        {/* ------------------------------------------------------- 输出 -- */}
        {ui.drawerTab === 'output' && (
          <>
            <label className="field">
              <span className="field-label">文件名<span className="val">不含扩展名</span></span>
              <input
                className="input"
                value={settings.filename}
                onChange={(e) => patchSettings({ filename: e.target.value })}
                placeholder="document"
              />
            </label>

            <div className="side-section-title" style={{ marginTop: 4 }}><Icon name="layers" size={11} /> 导出路线（可多选）</div>
            <div className="col" style={{ gap: 6 }}>
              {routes.map((r) => (
                <label key={r.id} className={`route-card ${settings.targets.includes(r.id) ? 'active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={settings.targets.includes(r.id)}
                    onChange={() => toggleTarget(r.id)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="route-title">
                      <Icon name={ROUTE_ICON[r.id] || 'file'} size={13} />
                      {r.label}
                      <span className="chip" style={{ marginLeft: 'auto', fontSize: 10 }}>{r.engine}</span>
                    </div>
                    <div className="route-blurb">{r.blurb}</div>
                  </div>
                </label>
              ))}
            </div>

            {hasPng && (
              <>
                <div className="side-section-title"><Icon name="image" size={11} /> PNG 参数</div>
                <label className="field">
                  <span className="field-label">分辨率<span className="val">{settings.png.dpi} DPI</span></span>
                  <input
                    type="range" min={72} max={1200} step={6}
                    value={settings.png.dpi}
                    onChange={(e) => patchSettings({ png: { dpi: Number(e.target.value) } })}
                  />
                  <div className="row" style={{ gap: 4 }}>
                    {[150, 300, 600, 1200].map((d) => (
                      <button key={d} className={`btn btn-sm ${settings.png.dpi === d ? 'active' : ''}`} onClick={() => patchSettings({ png: { dpi: d } })}>
                        {d}
                      </button>
                    ))}
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
                      宽 ≈ {Math.round((pngWidth * settings.png.dpi) / 96)} px
                    </span>
                  </div>
                  <span className="field-hint">150 屏幕 · 300 打印 · 600 印刷 · 1200 极致（注意 1200 DPI 会生成很大的 PNG，超长文档可能触及浏览器位图上限）。高度由内容长度决定。</span>
                </label>

                <label className="field">
                  <span className="field-label">版式</span>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className={`btn btn-sm ${settings.png.mode === 'card' ? 'active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => patchSettings({ png: { mode: 'card' }, doc: { card: true } })}
                    >卡片</button>
                    <button
                      className={`btn btn-sm ${settings.png.mode === 'page' ? 'active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => patchSettings({ png: { mode: 'page' }, doc: { card: false } })}
                    >整页</button>
                  </div>
                  <span className="field-hint">卡片 = 紧贴内容的分享图；整页 = 按纸张宽度的长图。</span>
                </label>

                <label className="field">
                  <span className="field-label">PNG 渲染引擎</span>
                  <select
                    className="select"
                    value={settings.png.engine}
                    onChange={(e) => patchSettings({ png: { engine: e.target.value } })}
                  >
                    <option value="html">HTML + Chromium（推荐，KaTeX 真 DPI）</option>
                    <option value="latex">LaTeX 排版 → 栅格化（复用 md2pdf 档位）</option>
                  </select>
                  {settings.png.engine === 'latex' && meta?.caps?.raster && !meta.caps.raster.highQuality && (
                    <span className="field-hint" style={{ color: 'var(--warn)' }}>
                      ⚠ 当前栅格化器是 {meta.caps.raster.bestLabel}（降级）。{meta.caps.raster.hint}
                    </span>
                  )}
                </label>

                <label className="switch">
                  <input type="checkbox" checked={settings.png.transparent}
                    onChange={(e) => patchSettings({ png: { transparent: e.target.checked }, doc: { transparent: e.target.checked } })} />
                  <span className="switch-track" />
                  <span className="switch-label">透明背景</span>
                </label>
              </>
            )}
          </>
        )}

        {/* ------------------------------------------------------- 排版 -- */}
        {ui.drawerTab === 'layout' && (
          <>
            <div className="side-section-title" style={{ marginTop: 0 }}><Icon name="palette" size={11} /> 文档主题</div>
            <div className="grid-2">
              {themes.map((t) => (
                <button
                  key={t.id}
                  className={`btn btn-sm ${settings.doc.theme === t.id ? 'active' : ''}`}
                  title={t.desc}
                  onClick={() => patchSettings({ doc: { theme: t.id } })}
                >
                  <Icon name={t.dark ? 'moon' : 'sun'} size={11} /> {t.label}
                </button>
              ))}
            </div>

            <div className="side-section-title"><Icon name="type" size={11} /> 字体与字号</div>
            <label className="field">
              <span className="field-label">正文字体</span>
              <select className="select" value={settings.doc.fontBody} onChange={(e) => patchSettings({ doc: { fontBody: e.target.value } })}>
                {Object.keys(meta?.fontPresets || { serifLatin: '' }).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">标题字体</span>
              <select className="select" value={settings.doc.fontHeading} onChange={(e) => patchSettings({ doc: { fontHeading: e.target.value } })}>
                {Object.keys(meta?.fontPresets || { sansLatin: '' }).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <div className="grid-2">
              <label className="field">
                <span className="field-label">字号<span className="val">{settings.doc.fontSize}px</span></span>
                <input type="range" min={12} max={26} step={0.5} value={settings.doc.fontSize}
                  onChange={(e) => patchSettings({ doc: { fontSize: Number(e.target.value) } })} />
              </label>
              <label className="field">
                <span className="field-label">行距<span className="val">{settings.doc.lineHeight}</span></span>
                <input type="range" min={1.2} max={2.4} step={0.05} value={settings.doc.lineHeight}
                  onChange={(e) => patchSettings({ doc: { lineHeight: Number(e.target.value) } })} />
              </label>
            </div>
            <label className="field">
              <span className="field-label">代码高亮主题</span>
              <select className="select" value={settings.doc.codeTheme} onChange={(e) => patchSettings({ doc: { codeTheme: e.target.value } })}>
                <option value="">跟随文档主题</option>
                {(meta?.hljsThemes || []).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">强调色<span className="val">{settings.doc.accent || '主题默认'}</span></span>
              <div className="row">
                <input type="color" value={settings.doc.accent || '#6366f1'} onChange={(e) => patchSettings({ doc: { accent: e.target.value } })} style={{ width: 34, height: 26, padding: 0, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent' }} />
                <input className="input" value={settings.doc.accent} placeholder="#6366f1" onChange={(e) => patchSettings({ doc: { accent: e.target.value } })} />
                <button className="btn btn-sm" onClick={() => patchSettings({ doc: { accent: '' } })}>清除</button>
              </div>
            </label>

            <div className="side-section-title"><Icon name="ruler" size={11} /> 页面与卡片</div>
            <div className="grid-2">
              <label className="field">
                <span className="field-label">正文宽度<span className="val">{settings.doc.contentWidth}px</span></span>
                <input type="range" min={420} max={1400} step={10} value={settings.doc.contentWidth}
                  onChange={(e) => patchSettings({ doc: { contentWidth: Number(e.target.value) } })} />
              </label>
              <label className="field">
                <span className="field-label">纸张</span>
                <select className="select" value={settings.doc.paper} onChange={(e) => patchSettings({ doc: { paper: e.target.value } })}>
                  {papers.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            </div>
            <div className="grid-2">
              <label className="field">
                <span className="field-label">页边距<span className="val">{settings.doc.margin}mm</span></span>
                <input type="range" min={0} max={50} step={1} value={settings.doc.margin}
                  onChange={(e) => patchSettings({ doc: { margin: Number(e.target.value) } })} />
              </label>
              <label className="field">
                <span className="field-label">卡片内边距<span className="val">{settings.doc.cardPadding}px</span></span>
                <input type="range" min={8} max={80} step={2} value={settings.doc.cardPadding}
                  onChange={(e) => patchSettings({ doc: { cardPadding: Number(e.target.value) } })} />
              </label>
            </div>
            <div className="grid-3">
              <label className="field">
                <span className="field-label">圆角</span>
                <input type="number" className="input" min={0} max={60} value={settings.doc.cardRadius}
                  onChange={(e) => patchSettings({ doc: { cardRadius: Number(e.target.value) } })} />
              </label>
              <label className="switch" style={{ alignSelf: 'end', paddingBottom: 8 }}>
                <input type="checkbox" checked={settings.doc.cardBorder} onChange={(e) => patchSettings({ doc: { cardBorder: e.target.checked } })} />
                <span className="switch-track" /><span className="switch-label">描边</span>
              </label>
              <label className="switch" style={{ alignSelf: 'end', paddingBottom: 8 }}>
                <input type="checkbox" checked={settings.doc.cardShadow} onChange={(e) => patchSettings({ doc: { cardShadow: e.target.checked } })} />
                <span className="switch-track" /><span className="switch-label">阴影</span>
              </label>
            </div>

            <div className="side-section-title"><Icon name="type" size={11} /> 文档信息</div>
            <label className="switch">
              <input type="checkbox" checked={settings.doc.showMeta} onChange={(e) => patchSettings({ doc: { showMeta: e.target.checked } })} />
              <span className="switch-track" /><span className="switch-label">显示标题 / 作者 / 日期</span>
            </label>
            <div className="grid-2" style={{ marginTop: 8 }}>
              <input className="input" placeholder="标题" value={settings.meta.title}
                onChange={(e) => patchSettings({ meta: { title: e.target.value }, doc: { title: e.target.value } })} />
              <input className="input" placeholder="作者" value={settings.meta.author}
                onChange={(e) => patchSettings({ meta: { author: e.target.value }, doc: { author: e.target.value } })} />
            </div>
            <input className="input" style={{ marginTop: 8 }} placeholder="日期（如 2026-01-01）" value={settings.meta.date}
              onChange={(e) => patchSettings({ meta: { date: e.target.value }, doc: { date: e.target.value } })} />

            <div className="side-section-title"><Icon name="sliders" size={11} /> Markdown 行为</div>
            {(meta?.markdownFlags || []).map((f) => (
              <label className="switch" key={f.key} title={f.hint}>
                <input
                  type="checkbox"
                  checked={Boolean((settings.markdown as any)[f.key])}
                  onChange={(e) => patchSettings({ markdown: { [f.key]: e.target.checked } })}
                />
                <span className="switch-track" />
                <span className="switch-label">{f.label}</span>
              </label>
            ))}
          </>
        )}

        {/* ------------------------------------------------------ LaTeX -- */}
        {ui.drawerTab === 'latex' && (
          <>
            <div className="side-section-title" style={{ marginTop: 0 }}><Icon name="zap" size={11} /> 质量档位</div>
            <div className="col" style={{ gap: 6 }}>
              {presets.map((p) => (
                <button
                  key={p.id}
                  className={`route-card ${settings.latex.preset === p.id ? 'active' : ''}`}
                  onClick={() => patchSettings({ latex: { preset: p.id } })}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="route-title">
                      {p.id}
                      <span className="chip" style={{ fontSize: 10 }}>{p.documentclass}</span>
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
                        {p.fontsize || '—'} / {p.margin || '—'}
                      </span>
                    </div>
                    <div className="route-blurb">{p.desc} · {p.aliases.split(' ').join(' / ')}</div>
                  </div>
                </button>
              ))}
            </div>

            <div className="side-section-title"><Icon name="settings" size={11} /> 引擎与结构</div>
            <label className="field">
              <span className="field-label">LaTeX 引擎</span>
              <select className="select" value={settings.latex.engine} onChange={(e) => patchSettings({ latex: { engine: e.target.value } })}>
                <option value="">自动（{meta?.caps?.engines?.defaultEngine || 'xelatex'}）</option>
                {(meta?.caps?.engines?.latexOrder || []).map((e) => <option key={e} value={e}>{e}</option>)}
                <option value="tectonic">tectonic</option>
                <option value="typst">typst</option>
              </select>
            </label>
            <div className="grid-2">
              <label className="switch">
                <input type="checkbox" checked={settings.latex.toc} onChange={(e) => patchSettings({ latex: { toc: e.target.checked } })} />
                <span className="switch-track" /><span className="switch-label">目录</span>
              </label>
              <label className="switch">
                <input type="checkbox" checked={settings.latex.numbers} onChange={(e) => patchSettings({ latex: { numbers: e.target.checked } })} />
                <span className="switch-track" /><span className="switch-label">章节编号</span>
              </label>
            </div>
            <div className="grid-2">
              <label className="field">
                <span className="field-label">目录深度</span>
                <input type="number" className="input" min={1} max={5} value={settings.latex.tocDepth}
                  onChange={(e) => patchSettings({ latex: { tocDepth: Number(e.target.value) } })} />
              </label>
              <label className="field">
                <span className="field-label">文档类</span>
                <input className="input" placeholder="article / ctexart" value={settings.latex.documentclass}
                  onChange={(e) => patchSettings({ latex: { documentclass: e.target.value } })} />
              </label>
            </div>
            <div className="grid-3">
              <label className="field">
                <span className="field-label">字号</span>
                <input className="input" placeholder="11pt" value={settings.latex.fontsize}
                  onChange={(e) => patchSettings({ latex: { fontsize: e.target.value } })} />
              </label>
              <label className="field">
                <span className="field-label">页边距</span>
                <input className="input" placeholder="1.2in" value={settings.latex.margin}
                  onChange={(e) => patchSettings({ latex: { margin: e.target.value } })} />
              </label>
              <label className="field">
                <span className="field-label">行距</span>
                <input className="input" placeholder="1.25" value={settings.latex.linestretch}
                  onChange={(e) => patchSettings({ latex: { linestretch: e.target.value } })} />
              </label>
            </div>

            <div className="side-section-title"><Icon name="type" size={11} /> 字体</div>
            <label className="field">
              <span className="field-label">正文字体 (mainfont)</span>
              <input className="input" placeholder="Times New Roman" value={settings.latex.mainfont}
                onChange={(e) => patchSettings({ latex: { mainfont: e.target.value } })} />
            </label>
            <label className="field">
              <span className="field-label">中文字体 (CJKmainfont)<span className="val">{meta?.caps?.engines ? '' : ''}</span></span>
              <input className="input" placeholder="自动（PingFang SC）" value={settings.latex.cjkfont}
                onChange={(e) => patchSettings({ latex: { cjkfont: e.target.value } })} />
            </label>
            <div className="grid-2">
              <label className="field">
                <span className="field-label">等宽字体</span>
                <input className="input" placeholder="Menlo" value={settings.latex.monofont}
                  onChange={(e) => patchSettings({ latex: { monofont: e.target.value } })} />
              </label>
              <label className="field">
                <span className="field-label">代码高亮</span>
                <select className="select" value={settings.latex.highlight} onChange={(e) => patchSettings({ latex: { highlight: e.target.value } })}>
                  {['tango', 'kate', 'pygments', 'breezedark', 'espresso', 'zenburn', 'monochrome', 'haddock'].map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="switch">
              <input type="checkbox" checked={settings.latex.colorlinks} onChange={(e) => patchSettings({ latex: { colorlinks: e.target.checked } })} />
              <span className="switch-track" /><span className="switch-label">彩色链接</span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={settings.latex.keepTex} onChange={(e) => patchSettings({ latex: { keepTex: e.target.checked } })} />
              <span className="switch-track" /><span className="switch-label">保留中间 .tex / PDF</span>
            </label>
            <label className="field" style={{ marginTop: 10 }}>
              <span className="field-label">附加 pandoc 参数<span className="val">原样透传</span></span>
              <textarea
                className="textarea"
                rows={3}
                placeholder={'--citeproc\n--bibliography=refs.bib\n--number-offset=5'}
                value={settings.latex.extraArgs.join('\n')}
                onChange={(e) => patchSettings({ latex: { extraArgs: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) } })}
              />
              <span className="field-hint">等价于 CLI 里 <code>--</code> 之后的参数。</span>
            </label>
          </>
        )}

        {/* ------------------------------------------------------- 命令 -- */}
        {ui.drawerTab === 'command' && (
          <>
            <div className="side-section-title" style={{ marginTop: 0 }}><Icon name="terminal" size={11} /> 将要执行的命令</div>
            {plan.length === 0 && <div className="empty-note">选择导出目标后，这里会显示真实的命令行。</div>}
            {plan.map((c, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="chip accent">{c.target}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>{c.engine}</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-sm btn-ghost" onClick={() => { navigator.clipboard?.writeText(c.command); onToast('ok', '已复制命令'); }}>
                    <Icon name="copy" size={11} />
                  </button>
                </div>
                <pre className="cmd-box">{c.command}</pre>
              </div>
            ))}
            <div className="empty-note" style={{ marginTop: 12 }}>
              这些命令与终端里的等价操作完全一致：
              <pre className="cmd-box" style={{ marginTop: 6 }}>mdp serve{"\n"}mdp build note.md -t png --dpi 300{"\n"}md2pdf -q cn --toc note.md</pre>
            </div>
          </>
        )}

        {/* ------------------------------------------------------- 产物 -- */}
        {ui.drawerTab === 'artifacts' && (
          <>
            {job && (
              <>
                <div className="side-section-title" style={{ marginTop: 0 }}>
                  <Icon name="clock" size={11} /> 本次任务
                  <span style={{ flex: 1 }} />
                  <span className={`chip ${job.status === 'done' ? 'ok' : job.status === 'error' ? 'err' : 'warn'}`}>{job.status}</span>
                </div>
                <div className="empty-note" style={{ paddingTop: 0 }}>
                  <span className="mono" style={{ fontSize: 10 }}>
                    {job.label} · {job.elapsedMs != null ? `${(job.elapsedMs / 1000).toFixed(1)}s` : '进行中'}
                  </span>
                </div>
                {job.stats && (
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className="chip">{job.stats.words} 字</span>
                    <span className="chip">{job.stats.lines} 行</span>
                    <span className="chip">约 {job.stats.readingMinutes} 分钟</span>
                  </div>
                )}
                {(job.warnings || []).map((w, i) => (
                  <div key={i} className="check-hint" style={{ marginBottom: 6 }}>⚠ {w}</div>
                ))}
                {(job.errors || []).map((e, i) => (
                  <div key={i} className="check-row" style={{ borderColor: 'transparent' }}>
                    <span style={{ color: 'var(--err)' }}><Icon name="alert" size={12} /></span>
                    <div>
                      <div>{e.line ? `第 ${e.line} 行：` : ''}{e.message}</div>
                      {e.tex && <div className="check-detail">{e.tex}</div>}
                    </div>
                  </div>
                ))}
              </>
            )}
            <div className="side-section-title"><Icon name="package" size={11} /> 产物
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10 }}>{shown.length}</span>
            </div>
            {!shown.length && <div className="empty-note">暂无产物。点下方「开始渲染」。</div>}
            {shown.map((a) => (
              <div className="artifact" key={a.rel}>
                <div className="artifact-thumb">
                  {a.ext === 'png'
                    ? <img src={api.fileUrl(a.rel)} alt={a.name} />
                    : <Icon name={a.ext === 'pdf' ? 'file' : 'code'} size={18} />}
                </div>
                <div className="artifact-meta">
                  <div className="artifact-name" title={a.file}>{a.name}</div>
                  <div className="artifact-sub">
                    {a.width ? `${a.width}×${a.height}` : ''} {a.dpi ? `· ${a.dpi} DPI` : ''} · {formatBytes(a.bytes)}
                  </div>
                  {a.tool && <div className="artifact-sub">引擎 {a.toolLabel || a.tool}{a.quality === 'low' ? ' ⚠ 降级' : ''}</div>}
                  <div className="row" style={{ gap: 4, marginTop: 5 }}>
                    <a className="btn btn-sm btn-primary" href={api.fileUrl(a.rel, true)} download={a.name}>下载</a>
                    <a className="btn btn-sm btn-ghost" href={api.fileUrl(a.rel)} target="_blank" rel="noreferrer">打开</a>
                    <button className="btn btn-sm btn-ghost" title="复制服务器路径"
                      onClick={() => { navigator.clipboard?.writeText(a.file); onToast('ok', '已复制路径', a.file); }}>
                      <Icon name="copy" size={11} />
                    </button>
                    <span style={{ flex: 1 }} />
                    <button className="btn btn-sm btn-ghost" title="据此新建文档"
                      onClick={() => { addDoc(a.name, activeDoc?.content || ''); pushToast('info', '已据当前内容新建文档'); }}>
                      <Icon name="plus" size={11} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="drawer-foot">
        {running && (
          <>
            <div className="progress-track" style={{ marginBottom: 6 }}>
              <div className="progress-fill" style={{ width: `${Math.round((job?.progress || 0) * 100)}%` }} />
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
                {Math.round((job?.progress || 0) * 100)}% · {job?.progressLabel || '准备中'}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
                {job?.etaMs != null ? `预计还需 ${job.etaMs < 1000 ? '即将完成' : Math.ceil(job.etaMs / 1000) + ' 秒'}` : ''}
              </span>
            </div>
          </>
        )}
        {job?.status === 'error' && (
          <button className="btn" style={{ width: '100%', marginBottom: 8 }} onClick={onRetry}>
            <Icon name="refresh" size={12} /> 重试上一次导出
          </button>
        )}
        <div className="row">
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy && !running} onClick={busy ? onCancel : onRender}>
            <Icon name={busy ? 'x' : 'download'} size={13} />
            {busy ? '取消渲染' : `开始渲染 · ${settings.targets.length} 个产物`}
          </button>
          <button className="btn btn-icon" title="在浏览器打开产物目录说明" onClick={() => patchUi({ drawerTab: 'command' })}>
            <Icon name="terminal" size={13} />
          </button>
        </div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)', marginTop: 6 }}>
          {settings.targets.join(' + ')} · {settings.filename} · {settings.png.engine === 'latex' && hasPng ? 'LaTeX 栅格化' : ''}
        </div>
      </div>
    </aside>
  );
}

function formatBytes(n: number) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export default ExportDrawer;
