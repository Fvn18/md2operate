/**
 * shared/persist.mjs — 本地持久化核心（IndexedDB 优先，localStorage 兜底）。
 *
 * 为什么必须换掉 localStorage（不是为了好看）：
 *   · **5MB 硬上限**。一篇带图/长公式的文档 + 多个标签页，超限后 `setItem` 直接抛
 *     QuotaExceededError，而旧代码是 `catch { /* 忽略 *\/ }` —— 也就是**静默丢数据**。
 *   · **同步 I/O 跑在主线程**。几百 KB 的 JSON 序列化 + 写盘就发生在按键路径上，
 *     文档一大就掉帧。
 *   · 只能存字符串（要 JSON.stringify 两份），没有事务，多标签页并发写会互相覆盖。
 *
 * 换到 IndexedDB 之后：容量按站点配额（通常 >1GB）、读写异步、支持结构化克隆
 * （对象直接存，省一次序列化）、有事务保证。
 *
 * 但 localStorage 也不是全丢：**保留一份"文档索引"**（id/标题/时间，不带正文）。
 * 因为它是同步的，首屏可以立刻渲染出标签页骨架，不必等 IDB 的异步打开——
 * "打开就有东西"和"大文档不丢"这两件事因此可以同时成立。
 *
 * 本文件不 import 任何平台 API：indexedDB / localStorage 由调用方注入，
 * 于是它能在 Node 里用 fake-indexeddb 完整跑一遍（见 scripts/verify-persist.mjs）。
 */

/** localStorage 里那份"没有正文的索引" */
export const INDEX_SUFFIX = ':index';

function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || /quota/i.test(String(err.message || '')));
}

/**
 * @param {object} deps
 * @param {IDBFactory|null} deps.idb          window.indexedDB（可为 null → 自动降级）
 * @param {Storage|null} deps.ls              window.localStorage
 * @param {string} deps.namespace             键前缀（与旧版 localStorage 前缀保持一致）
 * @param {number} [deps.version]             IDB schema 版本
 * @param {string} [deps.dbName]
 */
export function createPersistence({ idb, ls, namespace, version = 1, dbName }) {
  const dbNameFinal = dbName || `${namespace}#kv`;
  const storeName = 'kv';

  /** @type {IDBDatabase|null} */
  let db = null;
  let openPromise = null;
  /** 降级原因（供界面如实显示，而不是假装一切正常） */
  let degradedReason = null;
  let writes = 0;
  let lastError = null;
  let migrated = false;

  const status = () => ({
    mode: db ? 'indexeddb' : 'localstorage',
    store: db ? `${dbNameFinal}/${storeName}` : 'localStorage',
    degradedReason,
    writes,
    lastError: lastError ? String(lastError.message || lastError) : null,
    migrated,
  });

  /* ------------------------------------------------------------ LS 兜底 -- */

  const lsGet = (key, fallback = null) => {
    if (!ls) return fallback;
    try {
      const raw = ls.getItem(`${namespace}.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  };

  const lsSet = (key, value) => {
    if (!ls) return false;
    try {
      ls.setItem(`${namespace}.${key}`, JSON.stringify(value));
      return true;
    } catch (err) {
      lastError = err;
      return false;
    }
  };

  const lsDel = (key) => {
    try { ls?.removeItem(`${namespace}.${key}`); } catch { /* ignore */ }
  };

  /* -------------------------------------------------------- IndexedDB -- */

  function open() {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve) => {
      if (!idb) {
        degradedReason = '当前环境没有 indexedDB';
        resolve(null);
        return;
      }
      let req;
      try {
        req = idb.open(dbNameFinal, version);
      } catch (err) {
        // 隐私模式 / 被策略禁用：Safari 无痕、部分内置浏览器会直接抛错
        degradedReason = `indexedDB 打开失败：${err && err.message ? err.message : err}`;
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => {
        degradedReason = `indexedDB 打开失败：${req.error ? req.error.name : 'unknown'}`;
        resolve(null);
      };
      req.onblocked = () => {
        degradedReason = 'indexedDB 被其他标签页阻塞（旧版本正在关闭）';
        resolve(null);
      };
    });
    return openPromise;
  }

  /** 单个读请求 → Promise（直接用 IDBRequest 的事件，不做多余的包装层） */
  function request(fn) {
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(storeName, 'readonly');
      } catch (err) {
        reject(err);
        return;
      }
      let req;
      try {
        req = fn(t.objectStore(storeName));
      } catch (err) {
        reject(err);
        return;
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 读取失败'));
    });
  }

  /** 写事务 → Promise（等事务 complete，才算真的落盘） */
  function commit(fn) {
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(storeName, 'readwrite');
      } catch (err) {
        reject(err);
        return;
      }
      try {
        fn(t.objectStore(storeName));
      } catch (err) {
        reject(err);
        return;
      }
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error || new Error('IndexedDB 写入失败'));
      t.onabort = () => reject(t.error || new Error('IndexedDB 事务被中止'));
    });
  }

  /** 读一个键：IDB 优先，异常时回落到 localStorage。 */
  async function read(key) {
    const d = await open();
    if (!d) return lsGet(key);
    try {
      const value = await request((store) => store.get(key));
      if (value !== undefined) return value;
      // IDB 里没有 → 可能是老数据还在 localStorage 里（迁移尚未跑过）
      return lsGet(key);
    } catch (err) {
      lastError = err;
      return lsGet(key);
    }
  }

  /**
   * 写一个键。**永远不抛**：失败会记录在 status() 里，并尝试降级写 localStorage。
   * @returns {Promise<{ok:boolean, mode:'indexeddb'|'localstorage', error?:Error}>}
   */
  async function write(key, value) {
    const d = await open();
    if (d) {
      try {
        await commit((store) => { store.put(value, key); });
        writes++;
        return { ok: true, mode: 'indexeddb' };
      } catch (err) {
        lastError = err;
        if (isQuotaError(err)) {
          // 配额满：如实上报（界面提示清理产物/旧文档），同时留一份 LS 兜底
          lsSet(key, value);
          return { ok: false, mode: 'localstorage', error: err };
        }
      }
    }
    const ok = lsSet(key, value);
    writes++;
    return ok
      ? { ok: true, mode: 'localstorage' }
      : { ok: false, mode: 'localstorage', error: lastError || new Error('写入失败') };
  }

  async function remove(key) {
    const d = await open();
    if (d) {
      try { await commit((store) => { store.delete(key); }); } catch (err) { lastError = err; }
    }
    lsDel(key);
  }

  async function keys() {
    const d = await open();
    if (!d) return [];
    try {
      const keys = await request((store) => store.getAllKeys());
      return Array.isArray(keys) ? keys : [];
    } catch {
      return [];
    }
  }

  /* ----------------------------------------------------------- 迁移 -- */

  /**
   * 把 localStorage 里的老数据搬进 IndexedDB（只做一次，幂等）。
   *
   * 迁移完**必须**把 localStorage 里带正文的键挤掉，只留索引：否则 5MB 上限
   * 依然是悬在头上的刀，而且两份数据会各自演化（下次打开到底信谁？）。
   *
   * @param {string[]} keys 需要迁移/压缩的键
   * @param {Record<string, (key:string, value:any) => any>} [compactMap]
   *        键 → 压缩函数。返回的"小对象"会被写回 localStorage（正文留在 IDB）。
   *        不提供压缩函数的键就原样留在 localStorage（适合小配置）。
   */
  async function migrate(keys, compactMap) {
    const result = { moved: [], compacted: [], skipped: [] };
    const d = await open();
    if (!d) { result.skipped.push('no-indexeddb'); return result; }
    if (migrated) { result.skipped.push('already'); return result; }

    for (const key of keys) {
      const legacy = lsGet(key, null);
      if (legacy == null) continue;
      const existing = await readFromIdb(key);
      const fn = compactMap && compactMap[key];
      if (existing === undefined) {
        await writeToIdb(key, legacy);
        result.moved.push(key);
      } else {
        result.skipped.push(key);
      }
      if (fn) {
        const small = fn(key, legacy);
        // 只留索引：正文交给 IndexedDB
        lsSet(`${key}${INDEX_SUFFIX}`, small);
        lsDel(key);
        result.compacted.push(key);
      }
    }
    migrated = true;
    return result;
  }

  async function readFromIdb(key) {
    try {
      return await request((store) => store.get(key));
    } catch {
      return undefined;
    }
  }

  async function writeToIdb(key, value) {
    try {
      await commit((store) => { store.put(value, key); });
      return true;
    } catch (err) {
      lastError = err;
      return false;
    }
  }

  /** 读取"文档索引"（同步，用于首屏骨架）：优先 localStorage，缺失时从 IDB 现算。 */
  async function readIndex(key, build) {
    const cached = lsGet(`${key}${INDEX_SUFFIX}`, null);
    if (Array.isArray(cached) && cached.length) return cached;
    const full = await read(key);
    const built = build ? build(full) : null;
    if (built) lsSet(`${key}${INDEX_SUFFIX}`, built);
    return built;
  }

  return { open, read, write, remove, keys, migrate, readIndex, status, lsGet, lsSet };
}

/**
 * 文档数组的"索引"压缩：只保留标签页需要的最小字段（正文交给 IndexedDB）。
 * 一份 1MB 的文档 → 索引里约 120 字节，几十个标签页也就几 KB，永远撞不到 5MB。
 */
export function compactDocs(docs) {
  if (!Array.isArray(docs)) return [];
  return docs.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    dir: d.dir || undefined,
    chars: typeof d.content === 'string' ? d.content.length : 0,
  }));
}

/** 由索引还原成文档对象（正文先置空，等 IndexedDB 补上）。 */
export function expandDocs(index) {
  if (!Array.isArray(index)) return [];
  return index.map((d) => ({
    id: d.id,
    name: d.name || '未命名',
    content: '',
    createdAt: d.createdAt || Date.now(),
    updatedAt: d.updatedAt || Date.now(),
    dir: d.dir,
  }));
}
