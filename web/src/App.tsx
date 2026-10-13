/**
 * web/src/App.tsx — 工作台总装：布局、快捷键、任务生命周期、拖放导入。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StudioProvider, useStudio, baseNameFrom } from './lib/store';
import { api, buildPayload, subscribeJob } from './lib/api';
import { parseCommand } from './lib/commandbar';
import { getContent as getContentStore, subscribeContent } from './lib/content';
import { usePreviewState, subscribePreviewState, getPreviewState } from './lib/preview-state';
import { usePersistStatus } from './lib/persist';
import { useCursor } from './lib/cursor';
import { aiApi } from './lib/ai';
import type { AiStatus, CapsResponse, Job, LogEntry, MetaResponse, RenderSettings, Target } from './lib/types';
import { Icon } from './components/Icons';
import TopBar from './components/TopBar';
import SidePanel from './components/SidePanel';
import EditorPane, { type EditorPaneHandle } from './components/EditorPane';
import PreviewPane, { type PreviewPaneHandle } from './components/PreviewPane';
import ExportDrawer from './components/ExportDrawer';
import ConsolePanel from './components/ConsolePanel';
import CommandBar from './components/CommandBar';
import { Toasts, ShortcutsModal } from './components/Toasts';
import AiToolbar, { type AiToolbarHandle } from './components/AiToolbar';
import AiSettings from './components/AiSettings';

const MOD = navigator.platform.toLowerCase().includes('mac') ? 'metaKey' : 'ctrlKey';
const mod = (e: KeyboardEvent) => (MOD === 'metaKey' ? e.metaKey : e.ctrlKey);

/* ------------------------------------------------------------- 拖拽分割 -- */

function Splitter({ orientation, onDelta }: { orientation: 'v' | 'h'; onDelta: (d: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    last.current = orientation === 'v' ? e.clientX : e.clientY;
    const move = (ev: MouseEvent) => {
      const cur = orientation === 'v' ? ev.clientX : ev.clientY;
      onDelta(cur - last.current);
      last.current = cur;
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = orientation === 'v' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className={`${orientation === 'v' ? 'splitter' : 'splitter-h'} ${dragging ? 'dragging' : ''}`}
      onMouseDown={onDown}
      role="separator"
      aria-orientation={orientation === 'v' ? 'vertical' : 'horizontal'}
    />
  );
}

/* ----------------------------------------------------------------- 状态栏 -- */

/**
 * 状态栏**自己订阅**预览派生数据（统计 / 错误 / 光标 / 增量指标）。
 * 这些数字每次按键都在变，如果让 App 持有就会把整棵树拖进热路径——这正是
 * 实测 1330ms 延迟的成因之一。
 */
function StatusBar({ job, caps, artifacts }: {
  job: Job | null;
  caps: CapsResponse | null;
  artifacts: number;
}) {
  const { settings, ui } = useStudio();
  // 光标来自**独立** store：目录树在 preview-state 里，两者不能同源，
  // 否则每次按键都会重渲染整棵目录（实测 +16ms/键）。
  const { stats, errors, metrics } = usePreviewState();
  const cursor = useCursor();
  const persist = usePersistStatus();
  const running = job?.status === 'running' || job?.status === 'queued';
  return (
    <footer className="statusbar">
      <span className="row" style={{ gap: 5 }}>
        <span className={`dot ${running ? 'busy' : job?.status === 'error' ? 'err' : 'ok'}`} />
        {running ? '渲染中…' : job ? (job.status === 'done' ? '就绪' : job.status) : '就绪'}
      </span>
      <span className="sep">|</span>
      <span>{stats.lines ? `${stats.chars} 字符 · ${stats.words} 字 · ${stats.lines} 行 · 约 ${stats.readingMinutes} 分钟` : '—'}</span>
      {errors.length > 0 && <><span className="sep">|</span><span style={{ color: 'var(--err)' }}>{errors.length} 个公式错误</span></>}
      <span className="sep">|</span>
      <span>Ln {cursor.line}, Col {cursor.col}</span>
      <span className="sep">|</span>
      <span title={`预览渲染（${metrics.engine === 'worker' ? 'Web Worker' : '主线程'}）：本次重渲 ${metrics.rendered} 块 / 复用 ${metrics.reused} 块 / 共 ${metrics.blocks} 块\n`
        + `引擎耗时 ${metrics.ms}ms · 端到端 ${metrics.latencyMs ?? 0}ms · 差量 ${((metrics.deltaBytes ?? 0) / 1024).toFixed(1)}KB / 全量 ${((metrics.fullBytes ?? 0) / 1024).toFixed(1)}KB`}>
        {metrics.engine === 'worker' ? 'Worker' : '主线程'} 增量 {metrics.rendered}/{metrics.blocks} · {metrics.ms}ms
      </span>
      <span className="grow" />
      <span>{settings.targets.join('+')} · {settings.filename}</span>
      <span className="sep">|</span>
      <span title={persist.mode === 'indexeddb'
        ? `文档正文存在 ${persist.store}（无 5MB 上限、异步写、不阻塞输入）${persist.degradedReason ? `\n注意：${persist.degradedReason}` : ''}`
        : `已降级到 localStorage：${persist.degradedReason || 'IndexedDB 不可用'}\n小文档不受影响，大文档请检查浏览器隐私设置`}
        style={{ color: persist.mode === 'indexeddb' ? undefined : 'var(--warn)' }}>
        {persist.mode === 'indexeddb' ? 'IndexedDB' : 'localStorage（降级）'}
      </span>
      <span className="sep">|</span>
      <span>{caps ? `pandoc ${caps.engines.pandoc.version?.replace(/^pandoc\s+/, '') || '?'}` : '…'}</span>
      <span className="sep">|</span>
      <span>{caps?.chrome.found ? 'chromium ✓' : 'chromium ✗'}</span>
      <span className="sep">|</span>
      <span>{artifacts} 个产物</span>
      <span className="sep">|</span>
      <span>{ui.vim ? 'VIM' : 'INSERT'}</span>
    </footer>
  );
}

/* ------------------------------------------------------------------- App -- */

function Studio() {
  const { state, activeDoc, dispatch, patchSettings, patchUi, addDoc, pushToast, toasts, dismissToast, saveNow } = useStudio();
  const { settings, ui } = state;

  const editorRef = useRef<EditorPaneHandle>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<PreviewPaneHandle>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const syncingRef = useRef(false);
  const workAreaRef = useRef<HTMLDivElement | null>(null);

  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [caps, setCaps] = useState<CapsResponse | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [commands, setCommands] = useState<Array<{ target: string; engine: string; command: string }>>([]);
  const [commandMsg, setCommandMsg] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [artifactCount, setArtifactCount] = useState(0);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [showAi, setShowAi] = useState(false);
  const aiRef = useRef<AiToolbarHandle>(null);
  /** 上一次成功的渲染请求：失败后"重试"直接重放它，不依赖当前编辑器状态 */
  const lastPayloadRef = useRef<Record<string, unknown> | null>(null);
  /**
   * 请求熔断（企业级防雪崩）：
   *   · submitRef  —— 正在提交中的那次 POST，新的一次提交前先 abort 它，避免
   *                   串行的重复任务；
   *   · jobIdRef    —— 正在后端跑的渲染任务，新任务发起前显式 cancel，让后端
   *                   立刻 SIGTERM 掉 TeX/Chromium 子进程（否则连点三次就有
   *                   三个 Chromium 各吃几百 MB）。
   */
  const submitRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = jobId;

  const busy = Boolean(jobId && (job?.status === 'running' || job?.status === 'queued'));

  /* 目录只镜像进 ref：jumpTo 需要它，但目录变化不该让 App 重渲染 */
  const tocRef = useRef<Array<{ level: number; text: string; id: string }>>([]);
  useEffect(() => subscribePreviewState(() => { tocRef.current = getPreviewState().toc; }), []);

  /* 热路径旁路：内容变化以 400ms 防抖刷回文档 state（用于持久化、标签名、导出），
     打字本身完全不碰 React state。切换文档时由 EditorPane 调 onFlush 立即落盘，
     保证防抖窗口内不会丢字。 */
  const activeIdRef = useRef<string | null>(activeDoc?.id ?? null);
  activeIdRef.current = activeDoc?.id ?? null;

  const flushContent = useCallback((docId?: string, content?: string) => {
    const id = docId || activeIdRef.current;
    if (!id) return;
    dispatch({ type: 'docs/patch', id, patch: { content: content ?? getContentStore() } });
  }, [dispatch]);

  useEffect(() => {
    let timer: number | null = null;
    let dirty = false;
    const unsub = subscribeContent(() => {
      dirty = true;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (!dirty) return;
        dirty = false;
        flushContent();
      }, 400);
    });
    return () => {
      unsub();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [flushContent]);

  /* ------------------------------------------------------------ 初始化 -- */
  const loadCaps = useCallback((force = false) => {
    api.caps(force).then(setCaps).catch(() => setCaps(null));
  }, []);

  useEffect(() => {
    api.meta().then(setMeta).catch((err) => pushToast('err', '无法连接后台', (err as Error).message));
    loadCaps();
    api.artifacts(1).then((r) => setArtifactCount(r.total || 0)).catch(() => {});
    aiApi.status().then(setAiStatus).catch(() => setAiStatus(null));
  }, [loadCaps, pushToast]);

  /* 导出文件名跟随当前文档：每个文档记住自己的导出名（首次从文件名推导），
     切换标签页时恢复，而不是沿用上一个文档的名字。 */
  const nameByDoc = useRef<Record<string, string>>({});
  const prevDocId = useRef<string | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (!activeDoc) return;
    const id = activeDoc.id;
    if (prevDocId.current === id) return;
    // 离开旧文档前，把它当前的导出名存档
    if (prevDocId.current) nameByDoc.current[prevDocId.current] = settingsRef.current.filename;
    prevDocId.current = id;
    const saved = nameByDoc.current[id];
    patchSettings({ filename: saved || baseNameFrom(activeDoc.name) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDoc?.id]);

  useEffect(() => {
    if (activeDoc) nameByDoc.current[activeDoc.id] = settings.filename;
  }, [settings.filename, activeDoc?.id]);

  /* -------------------------------------------------------- 任务订阅 -- */
  const attachJob = useCallback((id: string) => {
    unsubRef.current?.();
    unsubRef.current = subscribeJob(id, {
      onLog: (entry) => setLogs((prev) => (prev.length > 3000 ? [...prev.slice(-2000), entry] : [...prev, entry])),
      onState: (j) => setJob(j),
      onProgress: (pr) => setJob((j) => (j ? { ...j, progress: pr.pct, progressLabel: pr.label, etaMs: pr.etaMs } : j)),
      onDone: (j) => {
        setJob(j);
        setJobId(null);
        setArtifactCount((c) => c + (j.artifacts?.length || 0));
        if (j.status === 'done') {
          const png = (j.artifacts || []).find((a) => a.ext === 'png');
          pushToast('ok', '导出完成', (j.artifacts || []).map((a) => a.name).join(' · '));
          if (png) previewScrollRef.current?.scrollTo({ top: 0 });
        } else if (j.status === 'error') {
          pushToast('err', '导出失败', j.error || '见控制台');
        }
      },
    });
  }, [pushToast]);

  useEffect(() => () => { unsubRef.current?.(); }, []);

  /* ------------------------------------------------------------ 渲染 -- */
  /**
   * 提交渲染。
   *
   * `override` 支持"只这一次"覆盖导出路线（快捷导出用）。关键在于**不写回设置**：
   * 用户点一次「分享长图」不应该把他面板里精心配好的多选路线改掉。
   */
  const doRender = useCallback(async (override?: {
    targets?: Target[];
    png?: Partial<RenderSettings['png']>;
    doc?: Partial<RenderSettings['doc']>;
  }) => {
    if (!activeDoc) return;
    const targets = override?.targets?.length ? override.targets : settings.targets;
    if (!targets.length) { pushToast('warn', '没有选择导出目标'); patchUi({ showExport: true, drawerTab: 'output' }); return; }

    // ---- 熔断：先掐掉上一次提交与上一次任务，再发新的 ----
    if (submitRef.current) {
      submitRef.current.abort();
      submitRef.current = null;
    }
    const previousJob = jobIdRef.current;
    if (previousJob) {
      api.cancel(previousJob).catch(() => { /* 任务可能刚好结束了 */ });
      pushToast('info', '已中止上一次导出', '新的导出优先');
    }
    setLogs([]);
    setCommands([]);
    try {
      // 快捷导出只改这一次请求，不动 settings
      const effective: RenderSettings = {
        ...settings,
        targets,
        png: { ...settings.png, ...override?.png },
        doc: { ...settings.doc, ...override?.doc },
      };
      const payload = buildPayload(getContentStore(), effective, { assetBase: activeDoc.dir });
      lastPayloadRef.current = payload;
      const controller = new AbortController();
      submitRef.current = controller;
      // supersede：服务端再兜一层，防止上一次的 cancel 在半路丢了
      const res = await api.render({ ...payload, supersede: true }, { signal: controller.signal });
      submitRef.current = null;
      setCommands(res.commands || []);
      setJob({
        id: res.jobId, type: 'render', label: `${settings.filename} → ${targets.join(' + ')}`,
        status: res.status, artifacts: [], warnings: [], errors: [], commands: res.commands || [],
        stats: null, toc: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
        elapsedMs: null, error: null, detail: null, queuePosition: 0, logCount: 0, progress: 0,
      });
      setJobId(res.jobId);
      attachJob(res.jobId);
      patchUi({ showConsole: true });
    } catch (err) {
      const e = err as Error & { blockers?: Array<{ message: string; hint?: string }>; detail?: string };
      if (e.name === 'AbortError') return;   // 被新的一次导出顶掉，不是错误
      if (e.blockers?.length) {
        pushToast('err', '环境不具备该导出条件', e.blockers.map((b) => `${b.message}${b.hint ? `（${b.hint}）` : ''}`).join('；'));
        setLogs((prev) => [...prev,
          ...e.blockers!.map((b, i) => ({ seq: Date.now() + i, t: Date.now(), level: 'err' as const, msg: `✗ ${b.message}${b.hint ? `  →  ${b.hint}` : ''}` })),
        ]);
        patchUi({ showConsole: true, sideTab: 'doctor', showSide: true });
      } else {
        pushToast('err', '提交失败', e.message);
      }
    }
  }, [activeDoc, settings, attachJob, pushToast, patchUi]);

  /** 重试上一次导出（用于 Chromium 崩溃、LaTeX 偶发失败等瞬时问题）。 */
  const doRetry = useCallback(async () => {
    const payload = lastPayloadRef.current;
    if (!payload) { pushToast('warn', '没有可重试的任务'); return; }
    setLogs([]);
    setCommands([]);
    try {
      const res = await api.render({ ...(payload as Record<string, unknown>), supersede: true });
      setCommands(res.commands || []);
      setJob({
        id: res.jobId, type: 'render', label: `${settings.filename} → ${settings.targets.join(' + ')}`,
        status: res.status, artifacts: [], warnings: [], errors: [], commands: res.commands || [],
        stats: null, toc: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
        elapsedMs: null, error: null, detail: null, queuePosition: 0, logCount: 0, progress: 0,
      });
      setJobId(res.jobId);
      attachJob(res.jobId);
      patchUi({ showConsole: true });
      pushToast('info', '已重试上一次导出');
    } catch (err) {
      pushToast('err', '重试失败', (err as Error).message);
    }
  }, [attachJob, patchUi, pushToast, settings.filename, settings.targets]);

  const doCancel = useCallback(async () => {
    if (!jobId) return;
    try { await api.cancel(jobId); pushToast('warn', '已请求取消'); } catch { /* ignore */ }
  }, [jobId, pushToast]);

  /* -------------------------------------------------------- 插入 / 跳转 -- */
  const insertText = useCallback((text: string, caretMarker?: string) => {
    editorRef.current?.insert(text, caretMarker);
  }, []);

  /**
   * 大纲跳转：预览锚点 + 编辑器对应行。
   * 目录项从预览派生总线读取（不再经 App state）。
   */
  const jumpTo = useCallback((id: string) => {
    const item = tocRef.current.find((t) => t.id === id);
    let line = -1;
    if (item) {
      const lines = getContentStore().split('\n');
      const needle = item.text.trim();
      const idx = lines.findIndex((l) => l.replace(/^#{1,6}\s*/, '').replace(/\s*\{#[^}]*\}\s*$/, '').trim() === needle);
      if (idx >= 0) line = idx + 1;
    }
    /* 预览侧走偏移表跳转：虚拟化下目标块很可能没挂载，DOM 里根本找不到那个锚点。
       先按行号定位（会顺带把它挂起来），再对已挂载的元素做一次平滑微调。 */
    if (line > 0) {
      syncingRef.current = true;
      syncLock.current = { dir: 'editor', until: performance.now() + 400 };
      previewRef.current?.scrollToLine(line, 20);
      const container = previewScrollRef.current;
      if (container) {
        const el = container.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
        if (el) {
          const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 20;
          container.scrollTo({ top, behavior: 'smooth' });
        }
      }
      window.setTimeout(() => { syncingRef.current = false; }, 360);
    }
    if (line > 0) editorRef.current?.scrollToLine(line);
  }, []);

  /* ------------------------------------------------------------ 导入 -- */
  const importFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files).slice(0, 12)) {
      const text = await f.text();
      addDoc(f.name.replace(/\.(md|markdown|txt)$/i, ''), text);
    }
    pushToast('ok', `已导入 ${Math.min(files.length, 12)} 个文件`);
  }, [addDoc, pushToast]);

  /* -------------------------------------------------- 拖放 .md 导入 -- */
  useEffect(() => {
    const onOver = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
    const onLeave = (e: DragEvent) => { if (e.relatedTarget === null) setDragOver(false); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importFiles]);

  /* ------------------------------------------------------- 命令栏处理 -- */
  const runCommand = useCallback((input: string) => {
    const res = parseCommand(input, {
      presets: (meta?.presets?.presets || []).map((p) => p.id),
      themes: (meta?.docThemes || []).map((t) => t.id),
      papers: Object.keys(meta?.paperSizes || { A4: {} }),
    });
    setCommandMsg(res.ok ? `✓ ${res.message}` : `✗ ${res.message}`);
    if (!res.ok) { if (res.message) pushToast('warn', '命令未生效', res.message); return; }
    if (res.patch) patchSettings(res.patch);
    if (res.ui) patchUi(res.ui);
    if (res.targets) patchSettings({ targets: res.targets });
    if (res.insert) insertText(res.insert, res.carets);
    switch (res.action) {
      case 'render': doRender(); break;
      case 'clear': setLogs([]); break;
      case 'save': saveNow(); break;
      case 'new': addDoc(); break;
      case 'doctor': patchUi({ sideTab: 'doctor', showSide: true }); loadCaps(true); break;
      case 'examples': patchUi({ sideTab: 'examples', showSide: true }); break;
      case 'cleanup':
        api.cleanup().then((r) => { pushToast('ok', `已清理 ${r.removed} 个目录`); setArtifactCount(0); });
        break;
      case 'help': setShowHelp(true); break;
      default: break;
    }
  }, [meta, patchSettings, patchUi, doRender, insertText, addDoc, saveNow, pushToast, loadCaps]);

  /* -------------------------------------------------------- 快捷键 -- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!mod(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'enter') { e.preventDefault(); doRender(); return; }
      if (k === 's') { e.preventDefault(); saveNow(); pushToast('info', '已保存到浏览器本地'); return; }
      if (k === 'j') { e.preventDefault(); setCmdOpen((v) => !v); return; }
      if (k === '/') { e.preventDefault(); setShowHelp((v) => !v); return; }
      if (e.shiftKey && k === 'b') { e.preventDefault(); patchUi({ showSide: !ui.showSide }); return; }
      if (e.shiftKey && k === 'e') { e.preventDefault(); patchUi({ showExport: !ui.showExport }); return; }
      if (e.shiftKey && k === 'c') { e.preventDefault(); patchUi({ showConsole: !ui.showConsole }); return; }
      if (e.shiftKey && k === 'n') { e.preventDefault(); addDoc(); return; }
      if (e.shiftKey && k === 'f') { e.preventDefault(); editorRef.current?.openSearch(); return; }
      if (e.shiftKey && k === ' ') { e.preventDefault(); aiRef.current?.run('complete'); return; }
      if (e.shiftKey && k === 'a') { e.preventDefault(); setShowAi(true); return; }
      if (e.shiftKey && k === 'l') {
        e.preventDefault();
        const order = ['anchor', 'ratio', 'off'] as const;
        const next = order[(order.indexOf(ui.scrollSync) + 1) % order.length];
        patchUi({ scrollSync: next });
        pushToast('info', `滚动同步：${next === 'anchor' ? '锚定' : next === 'ratio' ? '比例' : '关闭'}`);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doRender, saveNow, patchUi, addDoc, ui.showSide, ui.showExport, ui.showConsole, pushToast]);

  /* -------------------------------------------------- 预览滚动同步 --
     两种模式：
       anchor（默认）—— 把编辑器顶部可见**行**对应的预览块对齐到顶部。
         块自带 start/end 行号，所以这是精确映射；比例同步在"编辑器行密度 ≠
         预览块高度"时必然越滚越偏，长文档尤其明显。
       ratio —— 老的按比例方式，保留给"我就想大致跟着"的场景。 */
  const syncModeRef = useRef(ui.scrollSync);
  syncModeRef.current = ui.scrollSync;
  /* 双向同步的"防打架"锁：谁先动谁说了算，180ms 内不让另一边反过来拽。
     没有它就会看到经典的抖动——编辑器滚一下把预览拽过去，预览的 scroll 事件
     又把编辑器拽回来，两边来回跳。 */
  const syncLock = useRef<{ dir: 'editor' | 'preview' | null; until: number }>({ dir: null, until: 0 });

  const onEditorScroll = useCallback((ratio: number, topLine: number) => {
    if (syncingRef.current) return;
    const mode = syncModeRef.current;
    if (mode === 'off') return;
    syncLock.current = { dir: 'editor', until: performance.now() + 180 };

    if (mode === 'anchor') {
      previewRef.current?.scrollToLine(topLine || 1);
      return;
    }
    const el = previewScrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    syncingRef.current = true;
    el.scrollTop = ratio * max;
    window.setTimeout(() => { syncingRef.current = false; }, 60);
  }, []);

  /* ---- 预览 → 编辑器（反向同步） ----------------------------------------
     设计文档要求"双向插值锚定"：编辑器滚到某行，预览跟着；预览滚到某处，
     编辑器也要跟到**同一行**（不是同一比例）。这里把视口顶部像素反解成
     行号 + 行内比例（yToLine），再用静默滚动落到编辑器——不抢焦点、不动光标，
     所以用户可以一边看预览一边继续打字。 */
  useEffect(() => {
    const el = previewScrollRef.current;
    if (!el) return undefined;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (syncingRef.current) return;
        const mode = syncModeRef.current;
        if (mode !== 'anchor') return;                       // 只有锚定模式做双向
        const now = performance.now();
        if (syncLock.current.dir === 'editor' && now < syncLock.current.until) return;
        const hit = previewRef.current?.topLine();
        if (!hit) return;
        syncLock.current = { dir: 'preview', until: now + 180 };
        editorRef.current?.scrollToLineQuiet(hit.line, hit.frac);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const cleanup = useCallback(() => {
    api.cleanup().then((r) => { pushToast('ok', `已清理 ${r.removed} 个产物目录`); setArtifactCount(0); })
      .catch((e) => pushToast('err', '清理失败', (e as Error).message));
  }, [pushToast]);

  const doneArtifacts = useMemo(() => job?.artifacts || [], [job]);

  return (
    <div className="app">
      <TopBar
        busy={busy}
        job={job}
        capsSummary={caps?.summary || null}
        onRender={doRender}
        onCancel={doCancel}
        onShortcuts={() => setShowHelp(true)}
        onImport={importFiles}
        onCleanup={cleanup}
        aiStatus={aiStatus}
        onAi={(task) => {
          if (task === 'settings') setShowAi(true);
          else aiRef.current?.run(task);
        }}
      />

      <div className="workbench">
        <SidePanel
          onJump={jumpTo}
          onInsert={insertText}
          caps={caps}
          onRefreshCaps={() => loadCaps(true)}
          onToast={pushToast}
        />
        {ui.showSide && (
          <Splitter orientation="v" onDelta={(d) => patchUi({ sideWidth: Math.max(200, Math.min(480, ui.sideWidth + d)) })} />
        )}

        <div
          ref={workAreaRef}
          className="work-area"
          data-preview={ui.showPreview ? '1' : '0'}
        >
          <div className="work-editor" style={{ flexBasis: ui.showPreview ? `${ui.splitRatio * 100}%` : '100%' }}>
            <EditorPane
              ref={editorRef}
              onSave={() => { flushContent(); saveNow(); pushToast('info', '已保存到浏览器本地'); }}
              onRender={doRender}
              onScroll={onEditorScroll}
              onFlush={flushContent}
              onCaretLine={(line) => {
                if (syncModeRef.current === 'anchor') previewRef.current?.revealLine(line);
              }}
            />
          </div>

          {ui.showPreview && (
            <>
              <Splitter
                orientation="v"
                onDelta={(d) => {
                  const w = workAreaRef.current?.clientWidth || 1;
                  patchUi({ splitRatio: Math.max(0.2, Math.min(0.8, ui.splitRatio + d / w)) });
                }}
              />
              <div className="work-preview">
                <PreviewPane ref={previewRef} scrollRef={previewScrollRef} />
              </div>
            </>
          )}
        </div>

        {ui.showExport && (
          <>
            <Splitter orientation="v" onDelta={(d) => patchUi({ drawerWidth: Math.max(280, Math.min(560, ui.drawerWidth - d)) })} />
            <ExportDrawer
              meta={meta}
              job={job}
              busy={busy}
              running={job?.status === 'running'}
              onRender={doRender}
              onCancel={doCancel}
              onRetry={doRetry}
              onToast={pushToast}
            />
          </>
        )}
      </div>

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <CommandBar
          open={cmdOpen}
          onToggle={setCmdOpen}
          onSubmit={runCommand}
          lastMessage={commandMsg}
          commands={commands}
        />
        {ui.showConsole && (
          <Splitter orientation="h" onDelta={(d) => patchUi({ consoleHeight: Math.max(80, Math.min(520, ui.consoleHeight - d)) })} />
        )}
        <ConsolePanel logs={logs} job={job} onClear={() => setLogs([])} onCancel={doCancel} onRetry={doRetry} />
      </div>

      <StatusBar
        job={job}
        caps={caps}
        artifacts={artifactCount || doneArtifacts.length}
      />

      <AiToolbar
        ref={aiRef}
        editorRef={editorRef}
        status={aiStatus}
        onToast={pushToast}
        onOpenSettings={() => setShowAi(true)}
      />
      {showAi && (
        <AiSettings
          status={aiStatus}
          onClose={() => setShowAi(false)}
          onSaved={(next) => setAiStatus(next)}
          onToast={pushToast}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
      {showHelp && <ShortcutsModal onClose={() => setShowHelp(false)} />}
      {dragOver && <div className="drop-overlay"><div className="drop-card">松开以导入 .md 文件</div></div>}
    </div>
  );
}

export default function App() {
  return <Studio />;
}
