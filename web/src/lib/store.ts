/**
 * web/src/lib/store.ts — 应用状态（文档 / 设置 / 界面 / 产物）与本地持久化。
 *
 * 用 React Context + useReducer 的轻量组合，不引第三方状态库：
 * 这个工作台的状态形状是固定的，手写更透明，也更容易把「哪些东西会被持久化」
 * 讲清楚。所有键都带版本前缀，升级时旧数据不会污染新结构。
 */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef,
} from 'react';
import type { Artifact, Job, RenderSettings, Target } from './types';
import { getContent } from './content';
import {
  KEYS as PERSIST_KEYS, persistence, readLocalDocs, readLocalSettings, readLocalUi,
  readLocalActiveId, writeDocs, writeSmall, markPersistReady, compactDocs,
} from './persist';
import { mergeDocs as mergeDocsImpl } from '@shared/merge-docs.mjs';

/** 合并逻辑在 shared/merge-docs.mjs（纯函数，Node 自检直接复用同一份实现） */
const mergeDocs = mergeDocsImpl as unknown as (
  local: Doc[], remote: Doc[], activeId: string | null, editorText: string,
) => { docs: Doc[]; recovered: Array<{ name: string; content: string }> };

const NS = 'mdp.studio.v2';

/* ------------------------------------------------------------ 默认文档 -- */

export const WELCOME_DOC = `# MDP Studio · 快速上手

在左边写 Markdown，右边立刻看到**与导出完全一致**的排版。

## 数学

行内 $f(x_1,\\dots,x_n)=\\sum_{i\\le j}a_{ij}x_ix_j$，行间：

$$\\nabla f(x)=Ax+\\beta\\mathbf{1}=0
\\quad\\Longrightarrow\\quad
S=\\{p\\},\\qquad p=A^{-1}(-\\beta\\mathbf{1})$$

::: theorem 极值点对称性
设 $f$ 是次数恰为 $2$ 的 $n$ 元实系数**对称**多项式。若 $f$ 取到最大值或最小值的
点集 $S$ 有限且非空，则存在 $b\\in\\mathbb R$ 使 $S=\\{(b,\\dots,b)\\}$。
:::

::: 证明
$\\nabla f$ 是仿射映射，故临界点集是仿射子空间；$S$ 有限迫使它是单点 $\\{p\\}$。
又 $f(\\sigma x)=f(x)$ 给出 $\\nabla f(\\sigma x)=\\sigma\\nabla f(x)$，于是 $\\sigma p$ 也是
临界点，由唯一性 $\\sigma p=p$ 对一切 $\\sigma\\in S_n$ 成立，故 $p=(b,\\dots,b)$。$\\square$
:::

## 代码与表格

\`\`\`python {1,2}
def symmetrize(A):
    return (A + A.T) / 2      # 对称化
\`\`\`

| 目标 | 引擎 | 说明 |
|:--|:--|:--|
| PNG | Chromium | 真 DPI 截图，适合分享 |
| PDF | XeLaTeX | 复用 md2pdf 的 7 个档位 |

## 待办

- [x] 打开左侧「示例」载入完整证明
- [ ] 试试右上角的导出面板
- [ ] 在命令栏输入 \`-q cn --toc\` 把导出切成中文论文档

> 提示：本页所有排版（主题 / 字体 / 卡片样式）都会原样进入 PNG 与 PDF。
`;

/* --------------------------------------------------------------- 类型 -- */

export interface Doc {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** 图片等相对资源的基准目录（绝对路径，可空） */
  dir?: string;
}

export interface UIState {
  appTheme: 'dark' | 'light' | 'sepia';
  vim: boolean;
  showPreview: boolean;
  showConsole: boolean;
  showExport: boolean;
  showSide: boolean;
  sideTab: 'outline' | 'templates' | 'examples' | 'artifacts' | 'doctor';
  drawerTab: 'output' | 'layout' | 'latex' | 'command' | 'artifacts';
  editorFontSize: number;
  editorWrap: boolean;
  editorLineNumbers: boolean;
  /**
   * 预览缩放。
   *
   * `z-fit`（默认）不是"缩放百分比"，而是**按导出宽度固定 + 自动等比适配**：
   * 预览始终用导出的真实宽度（卡片 860px / A4 页宽）排版，面板不够宽时整体等比
   * 缩小显示。这样公式换行、标题折行与导出产物逐字一致；改用 max-width 压缩宽度
   * 会让预览自己重排一遍，看到的就不是导出的样子了。
   */
  previewZoom: 'z-fit' | 'z-100' | 'z-75' | 'z-50';
  /** 滚动同步模式：锚定（按行对齐，默认）/ 比例 / 关闭 */
  scrollSync: 'anchor' | 'ratio' | 'off';
  /**
   * 预览视口虚拟化：只把视口附近的块挂进 DOM。
   *
   * 默认开。10 万字符文档有 1150 个块、约 10 万个节点，全挂上 DOM 会让"打字时
   * 的样式重算/重排"随文档长度线性增长；虚拟化后 DOM 节点稳定在千级以内
   * （SLO：≤1500），打字延迟与文档长度解耦。
   *
   * 代价：浏览器自带的「页内查找」只能找到已挂载的块。需要全文查找时，
   * 状态栏的开关可以临时关掉（关掉后回到 content-visibility 懒布局）。
   */
  virtualize: boolean;
  consoleHeight: number;
  sideWidth: number;
  drawerWidth: number;
  /**
   * 编辑区占「编辑 + 预览」工作区的比例（0.2~0.8），预览拿剩下的。
   *
   * 为什么需要它：预览要按导出宽度排版，面板越窄缩放越小（1440px 屏上右侧还有
   * 侧栏和导出面板时预览只剩 ~380px，自适应后仅 37%，基本没法读）。让用户能把
   * 分割条往左拖、把宽度让给预览，比强迫他在"看不见"和"关掉面板"之间二选一好。
   */
  splitRatio: number;
  autoScrollConsole: boolean;
}

export interface Toast { id: string; kind: 'ok' | 'err' | 'warn' | 'info'; title: string; msg?: string }

export const DEFAULT_SETTINGS: RenderSettings = {
  filename: 'document',
  targets: ['png'],
  png: { dpi: 300, mode: 'card', transparent: false, engine: 'html', page: 1 },
  doc: {
    theme: 'paper',
    fontSize: 16.5,
    lineHeight: 1.75,
    contentWidth: 860,
    fontBody: 'serifLatin',
    fontHeading: 'sansLatin',
    fontMono: 'mono',
    paragraphIndent: 0,
    justify: false,
    paper: 'A4',
    margin: 20,
    card: true,
    cardPadding: 32,
    cardRadius: 18,
    cardShadow: true,
    cardBorder: true,
    transparent: false,
    showMeta: true,
    title: '',
    author: '',
    date: '',
    accent: '',
    codeTheme: '',
    numberingHeadings: false,
  },
  markdown: {
    breaks: false,
    typographer: false,
    linkify: true,
    numbering: false,
    footnotes: true,
    deflist: true,
    taskLists: true,
    anchors: true,
    tocEmbed: false,
    lineNumbers: false,
  },
  latex: {
    preset: 'std',
    engine: '',
    toc: false,
    tocDepth: 2,
    numbers: true,
    fontsize: '',
    margin: '',
    linestretch: '',
    mainfont: '',
    cjkfont: '',
    monofont: '',
    cjk: 'auto',
    highlight: 'tango',
    colorlinks: false,
    documentclass: '',
    classoption: [],
    lang: '',
    template: '',
    includeHeaders: [],
    extraArgs: [],
    citeproc: false,
    bibliography: '',
    csl: '',
    keepTex: false,
  },
  meta: { title: '', author: '', date: '' },
};

export const DEFAULT_UI: UIState = {
  appTheme: 'dark',
  vim: false,
  showPreview: true,
  showConsole: true,
  showExport: true,
  showSide: true,
  sideTab: 'outline',
  drawerTab: 'output',
  editorFontSize: 13.5,
  editorWrap: true,
  editorLineNumbers: true,
  previewZoom: 'z-fit',
  scrollSync: 'anchor',
  virtualize: true,
  consoleHeight: 168,
  sideWidth: 262,
  drawerWidth: 344,
  splitRatio: 0.5,
  autoScrollConsole: true,
};

/* --------------------------------------------------------- 持久化工具 -- */

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${NS}.${key}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !Array.isArray(fallback)) {
      return { ...(fallback as object), ...(parsed as object) } as T;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`${NS}.${key}`, JSON.stringify(value));
  } catch { /* 配额满或隐私模式，忽略 */ }
}

/**
 * 校正旧版本遗留的 UI 设置值。
 *
 * 缩放档位从 z-100/z-90/z-75 改成了 z-fit/z-100/z-75/z-50：老用户 localStorage
 * 里的 z-90 已经不是合法档位，直接喂给界面会渲染出一个不存在的 class（表现为
 * "按了缩放没反应"）。这里统一归一，而不是让每个读取点自己防御。
 */
const PREVIEW_ZOOMS = new Set(['z-fit', 'z-100', 'z-75', 'z-50']);
function normalizeUi(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const next = { ...(raw as Record<string, unknown>) };
  if (typeof next.previewZoom === 'string' && !PREVIEW_ZOOMS.has(next.previewZoom)) {
    next.previewZoom = DEFAULT_UI.previewZoom;
  }
  // 手改过的 localStorage 或旧版本可能留下越界/非数值的比例，钳到合法区间，
  // 否则预览会被挤成 0 宽（表现为"预览不见了"）。
  const ratio = Number(next.splitRatio);
  next.splitRatio = Number.isFinite(ratio)
    ? Math.max(0.2, Math.min(0.8, ratio))
    : DEFAULT_UI.splitRatio;
  return next;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function newDoc(name?: string, content = ''): Doc {
  const now = Date.now();
  return {
    id: uid(),
    name: name || '未命名',
    content,
    createdAt: now,
    updatedAt: now,
  };
}

/** 深合并（只处理普通对象，数组整体替换）。 */
export function mergeDeep<T>(base: T, patch: any): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object') return patch as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = mergeDeep((base as any)[k], v);
  }
  return out;
}

/* --------------------------------------------------------------- Reducer */

interface State {
  /** 首屏文档是否来自老版本 localStorage（含正文）→ 需要在挂载后迁移进 IndexedDB */
  legacyLocalDocs?: boolean;
  docs: Doc[];
  activeId: string | null;
  settings: RenderSettings;
  ui: UIState;
  job: Job | null;
  busyJobId: string | null;
  artifacts: Artifact[];
  inspecting: Artifact | null;
}

type Action =
  | { type: 'docs/set'; docs: Doc[]; activeId?: string | null }
  | { type: 'docs/add'; doc: Doc }
  | { type: 'docs/close'; id: string }
  | { type: 'docs/patch'; id: string; patch: Partial<Doc> }
  | { type: 'docs/active'; id: string }
  | { type: 'settings/patch'; patch: any }
  | { type: 'settings/set'; settings: RenderSettings }
  | { type: 'ui/patch'; patch: Partial<UIState> }
  | { type: 'job/set'; job: Job | null }
  | { type: 'job/busy'; id: string | null }
  | { type: 'artifacts/set'; artifacts: Artifact[] }
  | { type: 'inspect'; artifact: Artifact | null }
  | {
      type: 'state/hydrate';
      docs?: Doc[];
      activeId?: string | null;
      settings?: RenderSettings;
      ui?: UIState;
      /** 与水合并时"用户已经动手打过字"的文档：留作恢复副本，绝不覆盖 */
      recovered?: Array<{ name: string; content: string }>;
    };

function init(): State {
  // 首屏**同步**读 localStorage：老版本留下的 docs（含正文）或新的"文档索引"。
  // 索引里没有正文 —— 那是 IndexedDB 的事，异步补进来（见 hydrateFromIdb）。
  // 这样"打开就有界面"与"大文档不丢"同时成立。
  const { docs: stored, legacy } = readLocalDocs();
  let docs: Doc[] = Array.isArray(stored) && stored.length
    ? stored.map((raw) => {
      const d = raw as Partial<Doc>;
      return {
        id: d.id || uid(),
        name: d.name || '未命名',
        content: typeof d.content === 'string' ? d.content : '',
        createdAt: d.createdAt || Date.now(),
        updatedAt: d.updatedAt || Date.now(),
        dir: d.dir,
      };
    })
    : [newDoc('快速上手', WELCOME_DOC)];
  const activeId = readLocalActiveId();
  return {
    docs,
    activeId: docs.some((d) => d.id === activeId) ? activeId : docs[0].id,
    settings: mergeDeep(DEFAULT_SETTINGS, readLocalSettings() || {}),
    ui: mergeDeep(DEFAULT_UI, normalizeUi(readLocalUi())),
    /** 首屏那批文档是否来自"带正文的老格式"（决定迁移时要不要压缩 localStorage） */
    legacyLocalDocs: legacy,
    job: null,
    busyJobId: null,
    artifacts: [],
    inspecting: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'docs/set':
      return { ...state, docs: action.docs, activeId: action.activeId ?? state.activeId };
    case 'docs/add':
      return { ...state, docs: [...state.docs, action.doc], activeId: action.doc.id };
    case 'docs/close': {
      const idx = state.docs.findIndex((d) => d.id === action.id);
      if (idx < 0) return state;
      const docs = state.docs.filter((d) => d.id !== action.id);
      if (!docs.length) {
        const fresh = newDoc();
        return { ...state, docs: [fresh], activeId: fresh.id };
      }
      const activeId = state.activeId === action.id
        ? docs[Math.min(idx, docs.length - 1)].id
        : state.activeId;
      return { ...state, docs, activeId };
    }
    case 'docs/patch':
      return {
        ...state,
        docs: state.docs.map((d) => (d.id === action.id ? { ...d, ...action.patch, updatedAt: Date.now() } : d)),
      };
    case 'docs/active':
      return { ...state, activeId: action.id };
    case 'settings/patch':
      return { ...state, settings: mergeDeep(state.settings, action.patch) };
    case 'settings/set':
      return { ...state, settings: action.settings };
    case 'ui/patch':
      return { ...state, ui: { ...state.ui, ...action.patch } };
    case 'job/set':
      return { ...state, job: action.job };
    case 'job/busy':
      return { ...state, busyJobId: action.id };
    case 'artifacts/set':
      return { ...state, artifacts: action.artifacts };
    case 'inspect':
      return { ...state, inspecting: action.artifact };
    case 'state/hydrate': {
      const extras: Doc[] = (action.recovered || []).map((r) => newDoc(`${r.name} · 恢复副本`, r.content));
      const docs = action.docs ? [...action.docs, ...extras] : [...state.docs, ...extras];
      const activeId = action.activeId && docs.some((d) => d.id === action.activeId)
        ? action.activeId
        : state.activeId;
      return {
        ...state,
        docs,
        activeId,
        settings: action.settings ? mergeDeep(DEFAULT_SETTINGS, action.settings) : state.settings,
        ui: action.ui ? mergeDeep(DEFAULT_UI, action.ui) : state.ui,
      };
    }
    default:
      return state;
  }
}

/* ------------------------------------------------------------- Context -- */

export interface StudioApi {
  state: State;
  activeDoc: Doc;
  /** 快捷访问器：等价于 state.settings / state.ui，避免调用方误从 context 直接解构 */
  settings: RenderSettings;
  ui: UIState;
  dispatch: React.Dispatch<Action>;
  patchSettings: (patch: any) => void;
  patchUi: (patch: Partial<UIState>) => void;
  setContent: (content: string, docId?: string) => void;
  addDoc: (name?: string, content?: string, dir?: string) => Doc;
  closeDoc: (id: string) => void;
  renameDoc: (id: string, name: string) => void;
  duplicateDoc: (id: string) => void;
  selectDoc: (id: string) => void;
  toasts: Toast[];
  pushToast: (kind: Toast['kind'], title: string, msg?: string) => void;
  dismissToast: (id: string) => void;
  saveNow: () => void;
}

const StudioCtx = createContext<StudioApi | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const saveTimer = useRef<number | null>(null);
  const stateRef = useRef(state);

  const activeDoc = useMemo(
    () => state.docs.find((d) => d.id === state.activeId) || state.docs[0],
    [state.docs, state.activeId],
  );

  /* --- 持久化：正文进 IndexedDB（异步、无 5MB 上限），小的设置项仍走 localStorage ---
     设置/界面小到几百字节，同步写不会造成可感知的卡顿，且能让"下次打开立刻是
     上次的样子"这件事不依赖异步读。正文（可能几 MB）必须异步：它正是旧版本
     卡顿与静默丢数据（QuotaExceededError）的来源。 */
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void writeDocs(state.docs as unknown as Array<Record<string, unknown>>); }, 500);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [state.docs]);

  /* 关标签页 / 切到后台：把防抖窗口里的内容立刻落盘（不等 500ms） */
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== 'hidden') return;
      void writeDocs(stateRef.current.docs as unknown as Array<Record<string, unknown>>);
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  useEffect(() => { writeSmall('activeId', state.activeId); }, [state.activeId]);
  useEffect(() => { writeSmall('settings', state.settings); }, [state.settings]);
  useEffect(() => { writeSmall('ui', state.ui); }, [state.ui]);

  /* --- 挂载后：迁移老数据 + 从 IndexedDB 补齐正文 ---
     迁移是**幂等**的：只在 IDB 里还没有 docs 时才把 localStorage 的老数据搬过去，
     搬完把 localStorage 压缩成"没有正文的索引"。否则 5MB 上限那把刀一直悬着。 */
  stateRef.current = state;

  useEffect(() => {
    let alive = true;
    (async () => {
      const db = await persistence.open();
      if (!alive) return;
      const migration = await persistence.migrate([PERSIST_KEYS.docs], {
        [PERSIST_KEYS.docs]: (_k: string, v: unknown) => compactDocs(Array.isArray(v) ? v as never[] : []),
      });
      const stored = await persistence.read(PERSIST_KEYS.docs);
      const activeId = persistence.lsGet(PERSIST_KEYS.activeId, null);
      const settings = persistence.lsGet(PERSIST_KEYS.settings, null);
      const ui = persistence.lsGet(PERSIST_KEYS.ui, null);
      if (!alive) return;

      if (!Array.isArray(stored) || !stored.length) {
        // IDB 里还没有数据：首屏那批（老格式）就是最新，写一次让两份一致
        await writeDocs(stateRef.current.docs as unknown as Array<Record<string, unknown>>);
        markPersistReady();
        return;
      }
      const merged = mergeDocs(
        stateRef.current.docs,
        stored as Doc[],
        stateRef.current.activeId,
        getContent(),
      );
      const recovered = merged.recovered;
      dispatch({
        type: 'state/hydrate',
        docs: merged.docs,
        activeId: activeId || stateRef.current.activeId,
        settings: settings || undefined,
        ui: ui || undefined,
        recovered,
      });
      markPersistReady();
      if (recovered.length) {
        pushToastRef.current?.('warn', '检测到未落盘的编辑，已保留为恢复副本',
          recovered.map((r) => r.name).join(' · '));
      }
      void db;
      void migration;
    })().catch(() => { markPersistReady(); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- 应用主题写到 <html> 上 --- */
  useEffect(() => {
    document.documentElement.dataset.appTheme = state.ui.appTheme;
  }, [state.ui.appTheme]);

  const pushToast = useCallback((kind: Toast['kind'], title: string, msg?: string) => {
    const id = uid();
    setToasts((t) => [...t.slice(-5), { id, kind, title, msg }]);
    const ttl = kind === 'err' ? 9000 : 4200;
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  /* 挂载期的异步流程（数据迁移）也要能提示用户，故用 ref 转发 */
  const pushToastRef = useRef<StudioApi['pushToast'] | null>(null);
  pushToastRef.current = pushToast;

  const api: StudioApi = useMemo(() => ({
    state,
    activeDoc,
    settings: state.settings,
    ui: state.ui,
    dispatch,
    patchSettings: (patch: any) => dispatch({ type: 'settings/patch', patch }),
    patchUi: (patch: Partial<UIState>) => dispatch({ type: 'ui/patch', patch }),
    setContent: (content: string, docId?: string) => {
      dispatch({ type: 'docs/patch', id: docId || state.activeId || state.docs[0].id, patch: { content } });
    },
    addDoc: (name?: string, content = '', dir?: string) => {
      const doc = newDoc(name, content);
      if (dir) doc.dir = dir;
      dispatch({ type: 'docs/add', doc });
      return doc;
    },
    closeDoc: (id: string) => dispatch({ type: 'docs/close', id }),
    renameDoc: (id: string, name: string) => dispatch({ type: 'docs/patch', id, patch: { name } }),
    duplicateDoc: (id: string) => {
      const src = state.docs.find((d) => d.id === id);
      if (!src) return;
      dispatch({ type: 'docs/add', doc: newDoc(`${src.name} 副本`, src.content) });
    },
    selectDoc: (id: string) => dispatch({ type: 'docs/active', id }),
    toasts,
    pushToast,
    dismissToast,
    saveNow: () => {
      // 热路径内容 store 才是最新内容的真相：400ms 防抖窗口内 state.docs 可能
      // 还是旧的，因此落盘时用它覆盖当前文档，保证 ⌘S 永不丢字。
      const id = state.activeId;
      const fresh = getContent();
      const docs = !id
        ? state.docs
        : state.docs.map((d) => (d.id === id ? { ...d, content: fresh } : d));
      save('docs', docs);
      save('activeId', state.activeId);
    },
  }), [state, activeDoc, toasts, pushToast, dismissToast]);

  return React.createElement(StudioCtx.Provider, { value: api }, children);
}

export function useStudio(): StudioApi {
  const ctx = useContext(StudioCtx);
  if (!ctx) throw new Error('useStudio 必须在 <StudioProvider> 内使用');
  return ctx;
}

/** 从文件名猜一个合适的基名（导出用）。 */
export function baseNameFrom(name: string): string {
  const base = String(name || 'document')
    .replace(/\.(md|markdown|txt)$/i, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .trim();
  return base || 'document';
}

/** 导出目标的中文短名。 */
export const TARGET_LABEL: Record<Target, string> = {
  png: 'PNG',
  pdf: 'PDF · LaTeX',
  'pdf-html': 'PDF · HTML',
  tex: 'TeX',
  html: 'HTML',
  docx: 'Word',
  md: 'Markdown',
};
