/** 与后台 server/*.mjs 的请求/响应契约（前端侧镜像）。 */

export type Target = 'png' | 'pdf' | 'pdf-html' | 'tex' | 'html' | 'docx' | 'md';

export interface DocOptions {
  theme: string;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  fontBody: string;
  fontHeading: string;
  fontMono: string;
  paragraphIndent: number | string;
  justify: boolean;
  paper: string;
  margin: number;
  card: boolean;
  cardPadding: number;
  cardRadius: number;
  cardShadow: boolean;
  cardBorder: boolean;
  transparent: boolean;
  showMeta: boolean;
  title: string;
  author: string;
  date: string;
  accent: string;
  codeTheme: string;
  numberingHeadings: boolean;
}

export interface MarkdownOptions {
  breaks: boolean;
  typographer: boolean;
  linkify: boolean;
  numbering: boolean;
  footnotes: boolean;
  deflist: boolean;
  taskLists: boolean;
  anchors: boolean;
  tocEmbed: boolean;
  lineNumbers: boolean;
}

export interface LatexOptions {
  preset: string;
  engine: string;
  toc: boolean;
  tocDepth: number;
  numbers: boolean;
  fontsize: string;
  margin: string;
  linestretch: string;
  mainfont: string;
  cjkfont: string;
  monofont: string;
  cjk: string;
  highlight: string;
  colorlinks: boolean;
  documentclass: string;
  classoption: string[];
  lang: string;
  template: string;
  includeHeaders: string[];
  extraArgs: string[];
  citeproc: boolean;
  bibliography: string;
  csl: string;
  keepTex: boolean;
}

export interface PngOptions {
  dpi: number;
  mode: 'card' | 'page';
  transparent: boolean;
  engine: 'html' | 'latex';
  page: number;
}

export interface RenderSettings {
  filename: string;
  targets: Target[];
  png: PngOptions;
  doc: DocOptions;
  markdown: MarkdownOptions;
  latex: LatexOptions;
  meta: { title: string; author: string; date: string };
}

export interface Artifact {
  id: string;
  name: string;
  file: string;
  rel: string;
  jobId: string;
  route: string;
  ext: string;
  mime: string;
  bytes: number;
  createdAt: string;
  width?: number;
  height?: number;
  dpi?: number;
  tool?: string;
  toolLabel?: string;
  quality?: string;
  onDisk?: boolean;
}

export type LogLevel = 'debug' | 'cmd' | 'out' | 'info' | 'ok' | 'warn' | 'err';

export interface LogEntry { seq: number; t: number; level: LogLevel; msg: string }

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: string;
  type: string;
  label: string;
  status: JobStatus;
  artifacts: Artifact[];
  warnings: string[];
  errors: Array<{ kind: string; message: string; line?: number; tex?: string }>;
  commands: Array<{ target: string; engine: string; command: string }>;
  stats: { chars: number; cjk: number; words: number; lines: number; readingMinutes: number } | null;
  toc: TocItem[] | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  elapsedMs: number | null;
  error: string | null;
  detail: string | null;
  queuePosition: number;
  logCount: number;
  progress?: number;
  progressLabel?: string;
  etaMs?: number | null;
}

export interface TocItem { level: number; text: string; id: string }

export interface Preset {
  id: string;
  aliases: string;
  desc: string;
  fontsize: string;
  margin: string;
  linestretch: string;
  toc: boolean;
  tocDepth: number;
  numbers: boolean;
  colorlinks: number;
  documentclass: string;
  classoption: string;
  highlight: string;
  geomExtra: string;
  include: string;
  beamer: boolean;
}

export interface PresetTable {
  version: string;
  defaultQuality: string;
  engine: string;
  pandoc: string | null;
  rasterizer: string | null;
  targets: string[];
  presets: Preset[];
  engines: string[];
}

export interface ExportRoute {
  id: Target;
  label: string;
  icon: string;
  ext: string;
  engine: 'html' | 'latex' | 'none';
  blurb: string;
  supports: string[];
}

export interface DocThemeMeta { id: string; label: string; dark: boolean; desc: string }

export interface MetaResponse {
  version: string;
  presets: PresetTable;
  routes: ExportRoute[];
  docThemes: DocThemeMeta[];
  paperSizes: Record<string, { w: number; h: number }>;
  fontPresets: Record<string, string>;
  markdownFlags: Array<{ key: string; label: string; hint: string; def: boolean }>;
  markdownDefaults: Record<string, boolean>;
  docDefaults: Partial<DocOptions>;
  hljsThemes: string[];
  caps: {
    summary: { ok: number; warn: number; fail: number };
    engines: { pandoc: { version: string | null; found: boolean }; latexOrder: string[]; defaultEngine: string | null };
    chrome: { found: boolean; version?: string | null; source?: string };
    raster: { available: string[]; best: string | null; bestLabel: string | null; highQuality: boolean; hint: string | null };
  };
}

export interface Check { id: string; group: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string | null; hint: string | null }

export interface CapsResponse {
  generatedAt: string;
  runtime: {
    node: string; platform: string; arch: string; pid: number; hostname: string;
    projectRoot: string; artifactDir: string; cacheDir: string; webBuilt: boolean; uptimeSec: number;
  };
  engines: {
    pandoc: { found: boolean; path: string | null; version: string | null };
    latex: Record<string, { found: boolean; path: string | null; version: string | null }>;
    latexOrder: string[];
    defaultEngine: string | null;
  };
  chrome: { found: boolean; path?: string; source?: string; kind?: string; version?: string | null };
  raster: { available: string[]; best: string | null; bestLabel: string | null; highQuality: boolean; hint: string | null };
  rasterizers: Array<{ id: string; label: string; path: string; quality: string; realDpi: boolean; note: string; install: string }>;
  fonts: { fcList: boolean; cjk: string[] };
  tools: Record<string, { found: boolean; path?: string }>;
  checks: Check[];
  summary: { ok: number; warn: number; fail: number };
  jobs?: { total: number; running: number; queued: number; done: number; failed: number; concurrency: number };
}

export interface RenderAccepted {
  jobId: string;
  status: JobStatus;
  targets: Target[];
  commands: Array<{ target: string; engine: string; command: string }>;
}

export interface Blocker { id: string; message: string; hint?: string }

/* ------------------------------------------------------------------ AI --- */

export interface AiTaskFlags {
  complete: boolean;
  formula: boolean;
  image: boolean;
  polish: boolean;
  fix: boolean;
}

export interface AiStatus {
  enabled: boolean;
  ready: boolean;
  mock: boolean;
  hasKey: boolean;
  keySource: 'env' | 'config' | null;
  model: string;
  thinkingLevel: string;
  baseUrl: string;
  tasks: AiTaskFlags;
}

export interface PublicConfig {
  path: string;
  ui: Record<string, unknown>;
  export: Record<string, unknown>;
  ai: {
    enabled: boolean;
    model: string;
    thinkingLevel: string;
    mock: boolean;
    tasks: AiTaskFlags;
    apiKeySet: boolean;
    apiKeySource: 'env' | 'config' | null;
  };
}
