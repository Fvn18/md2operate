#!/usr/bin/env node
/**
 * scripts/verify-docs.mjs — 规格文档的 CI 门禁（把文档变成可执行的东西）。
 *
 * 为什么文档也需要门禁：规格里最贵的错误不是错别字，是**不可证伪的措辞**和
 * **没有验收字段的需求**。前者让评审无法裁定，后者让实施无法判断"做完了没有"。
 * 这两类问题靠人眼评审会漏，靠扫描不会。
 *
 * 三条规则（对应评审意见 §3.5 / REV-22 / REV-01）：
 *   1. 禁用词：彻底 / 完美 / 零成本 / 永远 / 毫秒级 / 亚毫秒级 / 自动补齐 / 智能判定
 *      —— 都是无法证伪的形容词或分辨率承诺。
 *   2. 每条 `REQ-<域>-<三位>` 必须带「验收」字段；缺了就等于这条需求没有完成判据。
 *   3. 每条待验证假设（`AH-n`）必须带实验方案或替代路径。
 *
 * 只扫 docs/ 下的规格文档；技术报告与本走读文档属"记述已发生的事实"，
 * 允许引用历史措辞，不纳入扫描。
 *
 * 用法：node scripts/verify-docs.mjs
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPEC_DIR = path.join(ROOT, 'docs', 'enterprise-spec');

/** 被扫描的文档。新增规格文档时加进这里。 */
const TARGETS = [
  path.join(SPEC_DIR, 'spec.md'),
  path.join(SPEC_DIR, 'revision-log.md'),
];

/** 禁用词：无法证伪的形容词，或把分辨率当成精度承诺的说法。 */
const BANNED = [
  '彻底', '完美', '零成本', '永远', '毫秒级', '亚毫秒级', '自动补齐', '智能判定',
];

/**
 * 扫描前先剥掉**引用**：`「…」`、`『…』`、`"…"`、`'…'`、反引号代码span。
 * 理由：门禁要区分"使用"和"提及"。修订记录必须引用原文的错误措辞才能说明改了什么，
 * 那是**提及**；而正文里出现就是**使用**。用引号把这条界线画出来，比维护一份例外清单
 * 可靠——例外清单会腐烂，引号不会。
 */
function stripQuoted(text) {
  // 用等长空格替换：扫描的索引必须与原文字符位置一一对应，否则报出来的行号是错的
  const blank = (m) => ' '.repeat(m.length);
  return text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/「[^」\n]*」/g, blank)
    .replace(/『[^』\n]*』/g, blank)
    .replace(/"[^"\n]*"/g, blank)
    .replace(/'[^'\n]*'/g, blank);
}

let pass = 0, fail = 0;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const chk = (cond, label, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? ok('✔') : bad('✖')} ${label}${extra ? `  ${dim(extra)}` : ''}`);
};

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

console.log('\x1b[1m规格文档门禁（docs-lint）\x1b[0m');

/* ------------------------------------------------------------ 1. 禁用词 -- */
{
  const hits = [];
  for (const file of TARGETS) {
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const base = path.basename(file);
    const text = stripQuoted(raw);            // 与 raw 等长，索引可直接回查原文取上下文
    for (const word of BANNED) {
      let i = text.indexOf(word);
      while (i >= 0) {
        hits.push(`${base}:${lineOf(text, i)} 「${word}」  ${raw.slice(Math.max(0, i - 24), i + 24).replace(/\n/g, ' ')}`);
        i = text.indexOf(word, i + 1);
      }
    }
  }
  chk(hits.length === 0, '没有不可证伪的禁用词', hits.length ? `${hits.length} 处` : '零处');
  for (const h of hits.slice(0, 12)) console.log(`      ${h}`);
}

/* ------------------------------------------------------ 2. REQ 验收字段 -- */
{
  const missing = [];
  let total = 0;
  for (const file of TARGETS) {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const base = path.basename(file);
    // 需求块的形状：`#### REQ-<域>-<三位>　标题` 之后到下一个标题之前
    const re = /^#{3,4}\s+(REQ-[A-Z]+-\d{3})[^\n]*\n([\s\S]*?)(?=^#{3,4}\s|\Z)/gm;
    for (const m of text.matchAll(re)) {
      total++;
      const body = m[2];
      if (!/验收/.test(body)) missing.push(`${base} ${m[1]} 缺「验收」`);
      if (!/状态/.test(body)) missing.push(`${base} ${m[1]} 缺「状态」`);
    }
  }
  chk(total > 0, '扫描到需求条目', `${total} 条`);
  chk(missing.length === 0, `每条需求都带「验收」与「状态」字段`, missing.length ? missing.join('；') : `${total}/${total}`);
}

/* -------------------------------------------------------- 3. AH 实验卡 -- */
{
  const missing = [];
  let total = 0;
  for (const file of TARGETS) {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const base = path.basename(file);
    const re = /^#{2,4}\s+(AH-\d+)[^\n]*\n([\s\S]*?)(?=^#{2,4}\s|\Z)/gm;
    for (const m of text.matchAll(re)) {
      total++;
      const body = m[2];
      // 待验证假设必须给出"怎么验"或"验不成怎么办"，否则它只是一句托词
      if (!/实验|复测|判据|替代路径/.test(body)) missing.push(`${base} ${m[1]} 缺实验方案或替代路径`);
    }
  }
  chk(missing.length === 0, `待验证假设都带实验方案或替代路径`, missing.length ? missing.join('；') : `${total} 条`);
}

/* ------------------------------------------------------- 4. 文档存在性 -- */
{
  const exists = [];
  for (const f of TARGETS) {
    try { await fsp.access(f); exists.push(path.relative(ROOT, f)); } catch { exists.push(`缺失:${path.relative(ROOT, f)}`); }
  }
  chk(exists.every((e) => !e.startsWith('缺失')), '规格文档齐备', exists.join(' · '));
}

console.log('');
if (fail === 0) console.log(`${ok(`全部通过：${pass} 项`)}`);
else console.log(`${bad(`${fail} 项失败`)} / ${pass + fail} 项`);
process.exit(fail === 0 ? 0 : 1);
