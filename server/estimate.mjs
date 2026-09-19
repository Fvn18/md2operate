/**
 * server/estimate.mjs — 导出耗时预估（用真实历史，而不是拍脑袋的常数）。
 *
 * 思路：每次成功导出都把 (路线, 文档字符数, 实际耗时) 记进 `.cache/timings.json`，
 * 预测时取同一路线最近若干次的 **每千字符耗时中位数** 再乘以当前文档规模。
 * 这样预估会随本机性能与文档风格自动收敛，不需要维护一张魔法常数表。
 *
 * 为什么用中位数而不是均值：LaTeX 首跑要生成字体缓存，偶尔会慢 3~5 倍；
 * 中位数能把这些离群值挡掉。
 *
 * 冷启动（没有历史）时退回内置基线——这些基线来自 scripts/bench.mjs 的实测，
 * 不是凭空写的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './util.mjs';

const FILE = path.join(CACHE_DIR, 'timings.json');
const MAX_SAMPLES = 12;

/** 冷启动基线：每千字符毫秒数（来自本机 bench 实测的量级） */
const BASELINE = {
  // 路由 id → { perKChar, fixedMs }
  png: { perKChar: 14, fixedMs: 260 },        // HTML + Chromium 截图
  'pdf-html': { perKChar: 14, fixedMs: 420 }, // HTML → printToPDF
  html: { perKChar: 6, fixedMs: 120 },        // 自包含 HTML（内联字体）
  tex: { perKChar: 4, fixedMs: 380 },         // pandoc → latex
  docx: { perKChar: 4, fixedMs: 420 },
  pdf: { perKChar: 9, fixedMs: 1400 },        // pandoc + XeLaTeX
  md: { perKChar: 0.05, fixedMs: 5 },
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch { /* 缓存不可写就退化为纯基线预估，不影响导出 */ }
}

/** 记录一次真实耗时。 */
export function recordTiming(route, chars, ms) {
  if (!route || !Number.isFinite(ms) || ms <= 0) return;
  const c = load();
  const list = c[route] || (c[route] = []);
  list.push({ chars: Math.max(1, chars | 0), ms: Math.round(ms), at: Date.now() });
  while (list.length > MAX_SAMPLES) list.shift();
  persist();
}

/**
 * 最小二乘拟合 ms = a + b·(千字符)，要求 a ≥ 0。
 * 为什么要拟合而不是取 ms/千字的中位数：小文档里固定开销占绝对主导
 * （100 字符的 PNG 也要 ~400ms → 折算 4000ms/千字），这些样本会把中位数
 * 彻底带偏。真实测过一次：中位数算出来 1049ms/千字，纯属荒谬。
 * @returns {{a:number,b:number}|null} 尺寸没有差异时返回 null（无法分辨固定项与斜率）
 */
function fitLine(list) {
  const n = list.length;
  if (n < 3) return null;
  const xs = list.map((s) => Math.max(0.05, s.chars / 1000));
  const ys = list.map((s) => s.ms);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den < 1e-6) return null;
  const b = Math.max(0.02, num / den);
  const a = Math.max(0, my - b * mx);
  return { a, b };
}

/**
 * 预估某路线在给定文档规模下的耗时。
 *
 * 关键设计：把「本机速度」与「文档规模」分开建模，而不是直接对 ms/千字取中位数。
 * 直接取中位数会被小文档彻底带偏——100 字符的 PNG 也要 ~400ms，折算成
 * 4000ms/千字。真实踩过这个坑（中位数算出 1049ms/千字）。
 *
 * 两级策略：
 *   1. 样本足够且规模有差异 → 最小二乘拟合 ms = a + b·千字；
 *      但斜率必须落在基线的 [0.25×, 4×] 内才采信，否则退回策略 2。
 *   2. 否则 → 用「相对基线的速度因子」：factor = median(实测 / 基线预测)，
 *      预估 = 基线预测 × factor。**一个样本就能用**，而且不会荒谬。
 *
 * 无论如何，结果都会被夹在基线预测的 [0.5×, 6×] 区间内：一次异常慢跑
 * （比如机器同时在编译别的东西）不该让下一次预估离谱。
 *
 * @returns {{ms:number, perKChar:number, source:'history'|'baseline', samples:number}}
 */
export function estimateTiming(route, chars) {
  const c = load();
  const list = (c[route] || []).filter((x) => x && x.chars > 0 && x.ms > 0);
  const base = BASELINE[route] || { perKChar: 8, fixedMs: 400 };
  const k = Math.max(0.2, (chars || 0) / 1000);
  const baselineMs = base.fixedMs + k * base.perKChar;
  const clamp = (ms) => Math.round(Math.min(baselineMs * 6, Math.max(baselineMs * 0.5, ms)));

  if (!list.length) {
    return { ms: Math.round(baselineMs), perKChar: base.perKChar, source: 'baseline', samples: 0 };
  }

  // ---- 策略 1：最小二乘（样本足够、规模有差异、斜率可信） ----
  const line = fitLine(list);
  if (line && line.b >= base.perKChar * 0.25 && line.b <= base.perKChar * 4) {
    return { ms: clamp(line.a + k * line.b), perKChar: +line.b.toFixed(2), source: 'history', samples: list.length };
  }

  // ---- 策略 2：相对基线的速度因子 ----
  const factors = list
    .map((x) => x.ms / (base.fixedMs + Math.max(0.2, x.chars / 1000) * base.perKChar))
    .sort((a, b) => a - b);
  const factor = factors[Math.floor(factors.length / 2)] || 1;
  return {
    ms: clamp(baselineMs * factor),
    perKChar: +(base.perKChar * factor).toFixed(2),
    source: 'history',
    samples: list.length,
    factor: +factor.toFixed(2),
  };
}

/** 供 doctor / UI 展示：与 estimateTiming 用同一套拟合，避免两处口径不一致。 */
export function timingSummary() {
  const c = load();
  const out = {};
  for (const [route, list] of Object.entries(c)) {
    if (!list?.length) continue;
    const e = estimateTiming(route, 10000);
    const line = fitLine(list);
    out[route] = {
      samples: list.length,
      perKChar: e.perKChar,
      factor: e.factor ?? null,
      fixedMs: line ? Math.round(line.a) : null,
      lastMs: list[list.length - 1].ms,
      predicted10kMs: e.ms,
    };
  }
  return out;
}

export function clearTimings() {
  cache = {};
  persist();
}
