/**
 * server/config.mjs — 本地配置持久化。
 *
 * 需求里的「主题、快捷键、默认 DPI、AI 密钥本地保存」都落在这里。
 *
 * 两条安全与工程约束：
 *   1. **API 密钥永不回传浏览器**。`GET /api/config` 只会给出 `apiKeySet: true/false`，
 *      前端拿不到明文。密钥只在本机后台进程内使用。
 *   2. 配置文件写入权限收紧到 0600（含密钥，必须）。
 *
 * 路径选择沿用 md2pdf 的"多候选、取第一个可写的"策略，便于在沙箱/只读环境下降级：
 *   $MDP_CONFIG → $XDG_CONFIG_HOME/mdp-studio/config.json
 *   → ~/.config/mdp-studio/config.json → <PROJECT_ROOT>/.cache/config.json
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, CACHE_DIR } from './util.mjs';

const DEFAULTS = {
  version: 1,
  // 界面偏好：新会话的初始状态（之后浏览器本地存储优先级更高）
  ui: {
    appTheme: 'dark',
    vim: false,
    showPreview: true,
    showConsole: true,
    showExport: true,
    editorFontSize: 13.5,
    editorWrap: true,
    previewZoom: 'z-100',
    defaultDpi: 300,
    shortcuts: {},
  },
  // 导出默认值：CLI 批处理与网页新建会话都会读它
  export: {
    targets: ['png'],
    pngMode: 'card',
    transparent: false,
    theme: 'paper',
    paper: 'A4',
    preset: 'std',
  },
  ai: {
    enabled: false,
    // 依据：官方文档现行模型名为 gemini-3.8-flash 这一代；
    // gemini-2.5-* / 1.5-* 已废弃（见 .agents/skills/gemini-api-dev）。
    model: 'gemini-3.8-flash',
    thinkingLevel: 'low',
    apiKey: '',
    mock: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // 每项能力可单独开关
    tasks: { complete: true, formula: true, image: true, polish: true, fix: true },
  },
};

let cachedPath = null;

function candidatePaths() {
  const env = process.env.MDP_CONFIG;
  const out = [];
  if (env) out.push(path.resolve(env));
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) out.push(path.join(xdg, 'mdp-studio', 'config.json'));
  if (process.env.HOME) out.push(path.join(process.env.HOME, '.config', 'mdp-studio', 'config.json'));
  out.push(path.join(CACHE_DIR, 'config.json'));
  return out;
}

/** 找到（并可写）配置文件路径；都不行时返回工作区内的兜底路径。 */
export function configPath() {
  if (cachedPath) return cachedPath;
  for (const p of candidatePaths()) {
    const dir = path.dirname(p);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      if (fs.existsSync(p)) fs.accessSync(p, fs.constants.W_OK);
      cachedPath = p;
      return p;
    } catch { /* 试下一个 */ }
  }
  cachedPath = path.join(CACHE_DIR, 'config.json');
  return cachedPath;
}

/** 深合并（只处理普通对象，数组整体替换） */
function merge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch;
  if (typeof patch !== 'object') return patch;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}

/** 读取完整配置（含密钥，仅服务端使用）。 */
export function readConfig() {
  const p = configPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return merge(DEFAULTS, JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

/** 写入配置（深合并补丁），权限 0600。 */
export function writeConfig(patch) {
  const p = configPath();
  const next = merge(readConfig(), patch);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
  return next;
}

/**
 * 面向浏览器的安全视图：**剥掉密钥**，只暴露"是否已设置"。
 * 任何把 key 放进 HTTP 响应的改动都是 bug。
 */
export function publicConfig() {
  const c = readConfig();
  const key = resolveApiKey();
  return {
    path: configPath(),
    ui: c.ui,
    export: c.export,
    ai: {
      enabled: c.ai.enabled,
      model: c.ai.model,
      thinkingLevel: c.ai.thinkingLevel,
      mock: c.ai.mock || process.env.MDP_AI_MOCK === '1',
      tasks: c.ai.tasks,
      apiKeySet: Boolean(key),
      // 只给出密钥来源，永远不回传密钥本身
      apiKeySource: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        ? 'env' : (c.ai.apiKey ? 'config' : null),
    },
  };
}

/**
 * 解析可用的 API 密钥。
 * 优先级：环境变量 > 配置文件（环境变量更适合临时/CI 场景，且不落盘）。
 */
export function resolveApiKey() {
  const env = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (env && String(env).trim()) return String(env).trim();
  const c = readConfig();
  if (c.ai.apiKey && String(c.ai.apiKey).trim()) return String(c.ai.apiKey).trim();
  return null;
}

export { DEFAULTS as CONFIG_DEFAULTS };
