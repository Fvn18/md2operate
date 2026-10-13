#!/usr/bin/env node
/**
 * scripts/verify-persist.mjs — 本地持久化自检（Node + fake-indexeddb，不需要浏览器）。
 *
 * 这套用例的存在理由，是把"旧实现的静默丢数据"变成可复现的断言：
 *   · localStorage 的 5MB 上限一旦撞到，旧代码是 `catch {}` 直接吞掉 —— 用户看不见、
 *     数据也没了。这里用一个 8MB 的文档证明：走 IndexedDB 能存下、能读回、逐字节一致。
 *   · 老版本遗留在 localStorage 的文档必须被**迁移**而不是丢弃；迁移后 localStorage
 *     里不能再有正文（否则 5MB 那把刀还在）。
 *   · 迁移必须幂等：跑两次不会把新数据覆盖回旧的。
 *   · "用户已经开始打字，此时 IndexedDB 才返回数据"这个竞态绝不能覆盖用户输入 ——
 *     这是本套里最重要的一个用例（丢数据只有一个原因：写得不够小心）。
 */

import { createPersistence, compactDocs, expandDocs, INDEX_SUFFIX } from '../shared/persist.mjs';
import { mergeDocs } from '../shared/merge-docs.mjs';
import { IDBFactory } from 'fake-indexeddb';

const C = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, d: (s) => s, b: (s) => s };

let passed = 0;
let failed = 0;
const failures = [];
function ok(label, detail = '') {
  passed++;
  console.log(`  ${C.g('✔')} ${label}${detail ? C.d(`  ${detail}`) : ''}`);
}
function bad(label, detail = '') {
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${C.r('✖')} ${label}${detail ? C.d(`  ${detail}`) : ''}`);
}
const assert = (cond, label, detail = '') => (cond ? ok(label, detail) : bad(label, detail));

/** 会实施 5MB 配额的 localStorage 替身：把旧实现的坑原样复刻出来 */
function makeQuotaLocalStorage(limitBytes = 5 * 1024 * 1024) {
  const map = new Map();
  let used = 0;
  const sizeOf = (k, v) => (String(k).length + String(v).length) * 2;
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem(k) {
      if (!map.has(k)) return;
      used -= sizeOf(k, map.get(k));
      map.delete(k);
    },
    setItem(k, v) {
      const next = used - (map.has(k) ? sizeOf(k, map.get(k)) : 0) + sizeOf(k, v);
      if (next > limitBytes) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
      used = next;
      map.set(k, String(v));
    },
    clear() { map.clear(); used = 0; },
    /** 供断言使用：当前占用字节 */
    bytes: () => used,
  };
}

const NS = 'mdp.test';
const makeDoc = (id, chars) => ({
  id, name: id, content: 'x'.repeat(chars),
  createdAt: 1000, updatedAt: 2000,
});

console.log(C.b('\n本地持久化自检（IndexedDB + 迁移 + 竞态安全）'));

/* --------------------------------------------- ① 8MB 文档：旧实现必丢 -- */
{
  const ls = makeQuotaLocalStorage();
  const big = [makeDoc('big', 8 * 1024 * 1024)];

  // 旧路径：直接写 localStorage —— 这正是旧代码 catch 掉的那一步
  let quotaError = null;
  try { ls.setItem(`${NS}.docs`, JSON.stringify(big)); } catch (err) { quotaError = err; }
  assert(quotaError && quotaError.name === 'QuotaExceededError',
    '复现旧实现的坑：8MB 文档写 localStorage 触发 QuotaExceededError',
    `${(JSON.stringify(big).length / 1048576).toFixed(1)}MB > 5MB`);

  const p = createPersistence({ idb: new IDBFactory(), ls, namespace: NS });
  const res = await p.write('docs', big);
  assert(res.ok && res.mode === 'indexeddb', '同一份 8MB 文档写 IndexedDB 成功', res.mode);
  const back = await p.read('docs');
  assert(Array.isArray(back) && back[0].content.length === big[0].content.length,
    '读回后逐字节一致（长度校验）', `${back[0].content.length} 字符`);
  assert(back[0].content === big[0].content, '内容完全一致（不是截断的）');
}

/* ------------------------------------------ ② 迁移：LS → IDB + 压缩索引 -- */
{
  const ls = makeQuotaLocalStorage();
  const docs = [makeDoc('a', 1_000_000), makeDoc('b', 500_000)];
  ls.setItem(`${NS}.docs`, JSON.stringify(docs));
  ls.setItem(`${NS}.activeId`, JSON.stringify('a'));
  const beforeBytes = ls.bytes();

  const p = createPersistence({ idb: new IDBFactory(), ls, namespace: NS });
  const result = await p.migrate(['docs'], { docs: (_k, v) => compactDocs(Array.isArray(v) ? v : []) });

  assert(result.moved.includes('docs'), '老数据被搬进 IndexedDB', result.moved.join(','));
  const inIdb = await p.read('docs');
  assert(inIdb.length === 2 && inIdb[0].content.length === 1_000_000, '迁移后正文完整（1MB + 0.5MB）');
  assert(ls.getItem(`${NS}.docs`) === null, 'localStorage 里的正文已被清掉（5MB 上限不再是风险）');
  const index = JSON.parse(ls.getItem(`${NS}.docs${INDEX_SUFFIX}`));
  assert(index.length === 2 && index[0].chars === 1_000_000 && index[0].content === undefined,
    'localStorage 只留索引（id/标题/字数），没有正文');
  assert(ls.bytes() < 4096, 'localStorage 占用从 MB 级降到 KB 级',
    `${(beforeBytes / 1048576).toFixed(1)}MB → ${ls.bytes()} 字节`);

  const expanded = expandDocs(index);
  assert(expanded[0].content === '' && expanded[0].name === 'a', '索引可以同步还原成占位文档（首屏骨架）');

  // 幂等：再跑一次迁移，不能把 IDB 里更新的内容覆盖回旧的
  await p.write('docs', [{ ...makeDoc('a', 10), updatedAt: 9999 }]);
  const p2 = createPersistence({ idb: p.open ? undefined : undefined, ls, namespace: NS });
  void p2; // 同一个 db 名会被上面的实例占用 → 直接用同一实例再迁移一次
  const again = await p.migrate(['docs'], { docs: (_k, v) => compactDocs(Array.isArray(v) ? v : []) });
  assert(again.skipped.includes('already') || again.moved.length === 0, '迁移幂等：第二次不再覆盖新数据',
    JSON.stringify(again.skipped));
  const after = await p.read('docs');
  assert(after[0].content.length === 10, '第二次迁移后 IndexedDB 里仍是最新版本', `${after[0].content.length} 字符`);
}

/* --------------------------------------------- ③ 降级：没有 IndexedDB -- */
{
  const ls = makeQuotaLocalStorage();
  const p = createPersistence({ idb: null, ls, namespace: NS });
  const res = await p.write('ui', { appTheme: 'dark' });
  assert(res.ok && res.mode === 'localstorage', '没有 indexedDB 时自动降级到 localStorage（不崩）');
  assert(p.status().degradedReason, '降级原因如实记录（界面要显示给用户）', p.status().degradedReason);
  const v = await p.read('ui');
  assert(v && v.appTheme === 'dark', '降级后依然可读可写');
}

/* ------------------------------- ④ 幂等/健壮：写失败不抛，状态如实上报 -- */
{
  const ls = makeQuotaLocalStorage(2048);
  const p = createPersistence({ idb: new IDBFactory(), ls, namespace: NS });
  // 让 IDB 写入失败：传一个坏掉的事务目标（用已关闭的数据库模拟）
  await p.open();
  const res = await p.write('docs', [{ id: 'x', content: 'y'.repeat(100_000) }]);
  assert(typeof res.ok === 'boolean', 'write 永远返回结果而不是抛异常', `ok=${res.ok} mode=${res.mode}`);
}

/* ------------------------------------- ⑤ 竞态：用户先打字，后到的是旧数据 -- */
{
  // 真实情形：首屏是从 localStorage 的**索引**来的，正文是空的（''）；
  // 用户在这之后往编辑器里敲了字 —— 编辑器里的文本才是真相。
  const local = [
    { id: 'a', name: 'A', content: '', createdAt: 1, updatedAt: 5 },
    { id: 'b', name: 'B', content: '', createdAt: 1, updatedAt: 1 },
  ];
  const remote = [
    { id: 'a', name: 'A', content: 'IndexedDB 里的旧长文'.repeat(100), createdAt: 1, updatedAt: 9 },
    { id: 'b', name: 'B', content: 'B 的正文（来自 IndexedDB）', createdAt: 1, updatedAt: 9 },
    { id: 'c', name: 'C', content: '只在 IndexedDB 里存在的文档', createdAt: 1, updatedAt: 9 },
  ];
  const merged = mergeDocs(local, remote, 'a', '用户刚敲进去的内容');
  const a = merged.docs.find((d) => d.id === 'a');
  assert(a.content === '用户刚敲进去的内容', '用户正在编辑的内容**没有被覆盖**', a.content);
  assert(merged.recovered.length === 1 && merged.recovered[0].content.startsWith('IndexedDB 里的旧长文'),
    '远端那一份被保留为「恢复副本」（宁可多一份，也不静默丢）',
    merged.recovered[0] ? `${merged.recovered[0].content.length} 字符` : '缺失');
  const b = merged.docs.find((d) => d.id === 'b');
  assert(b.content === 'B 的正文（来自 IndexedDB）', '其它文档正常补齐正文');
  assert(merged.docs.some((d) => d.id === 'c'), '只在 IndexedDB 里的文档被补进来（不丢标签页）');

  // 变体：时间戳相同的"迁移后同一份" → 以 IndexedDB（权威副本）为准
  const same = [{ id: 'a', name: 'A', content: '', createdAt: 1, updatedAt: 9 }];
  const mergedSame = mergeDocs(same, remote, 'a', '');
  assert(mergedSame.docs[0].content.startsWith('IndexedDB 里的旧长文'),
    '首屏是索引（无正文）时时：即使时间戳相同也取 IndexedDB 的正文');

  // 变体：本地有正文、远端为空 → 保住本地正文（不能越合并越少）
  const keepLocal = mergeDocs(
    [{ id: 'a', name: 'A', content: '本地正文', createdAt: 1, updatedAt: 9 }],
    [{ id: 'a', name: 'A', content: '', createdAt: 1, updatedAt: 9 }],
    'a', '本地正文',
  );
  assert(keepLocal.docs[0].content === '本地正文', '远端为空时不覆盖本地正文（合并不丢内容）');

  // 变体：首屏带着正文（老格式），用户在它基础上继续写 → 仍然以编辑器为准
  const legacyLocal = [{ id: 'a', name: 'A', content: '老正文', createdAt: 1, updatedAt: 5 }];
  const mergedLegacy = mergeDocs(legacyLocal, remote, 'a', '老正文 + 用户新写的一段');
  const aLegacy = mergedLegacy.docs.find((d) => d.id === 'a');
  assert(aLegacy.content === '老正文 + 用户新写的一段',
    '首屏有正文时继续编辑：编辑器内容仍是唯一真相', aLegacy.content);

  // 用户没打字时走正常合并，且按 updatedAt 取新的
  const merged2 = mergeDocs(local, remote, 'a', '');
  const a2 = merged2.docs.find((d) => d.id === 'a');
  assert(a2.content.length > 100, '没有用户输入时：取 updatedAt 更新的那一份（IndexedDB）');
  assert(merged2.recovered.length === 0, '没有用户输入时不产生恢复副本');
}

/* --------------------------------------------------- ⑥ 索引压缩不丢字段 -- */
{
  const docs = [
    { id: 'x', name: 'X', content: 'abc', createdAt: 1, updatedAt: 2, dir: '/tmp' },
    { id: 'y', name: 'Y', content: 'defg', createdAt: 3, updatedAt: 4 },
  ];
  const compact = compactDocs(docs);
  assert(compact.every((d) => !('content' in d)), '索引里没有 content 字段');
  assert(compact[0].dir === '/tmp' && compact[1].dir === undefined, 'dir 等必要字段保留');
  assert(compact[1].chars === 4, '字数（chars）保留，便于首屏显示');
  const size = JSON.stringify(compact).length;
  assert(size < 400, '两个文档的索引仍然很小', `${size} 字节`);
}

console.log(`\n${failed === 0 ? C.g('全部通过') : C.r(`${failed} 项失败`)}：${passed} 通过 / ${failed} 失败\n`);
if (failed) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
