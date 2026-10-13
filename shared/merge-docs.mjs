/**
 * shared/merge-docs.mjs — 启动时的文档合并（localStorage 首屏态 ⨯ IndexedDB 持久态）。
 *
 * 为什么单独抽一个文件、而且要用它自检：这是"丢数据"最容易发生的地方。
 * 真正会出现的情形是：
 *   · 首屏为了不等 I/O，先用 localStorage 里的索引把界面画出来（正文是空的）；
 *   · IndexedDB 的数据随后才到 —— 如果这时用户已经往编辑器里敲了字，
 *     直接 dispatch 就会把他刚写的东西覆盖掉。
 *
 * 所以规则很明确：**用户正在写的那一份永远赢**，远端那一份降级为「恢复副本」。
 * 宁可让用户看到多出来的一个副本，也绝不静默丢掉他写的内容。
 */

/**
 * @param {Array<{id:string,name:string,content:string,createdAt:number,updatedAt:number,dir?:string}>} local
 *        首屏同步读到的文档（可能只有索引、没有正文）
 * @param {Array<object>} remote  IndexedDB 里的文档（正文完整）
 * @param {string|null} activeId  当前活动文档 id
 * @param {string} editorText     编辑器此刻的文本（用户是否已经打过字的判据）
 * @returns {{docs:Array<object>, recovered:Array<{name:string,content:string}>}}
 */
export function mergeDocs(local, remote, activeId, editorText) {
  const byId = new Map((remote || []).map((d) => [d.id, d]));
  const out = [];
  const recovered = [];
  const seen = new Set();

  for (const l of local || []) {
    seen.add(l.id);
    const r = byId.get(l.id);
    if (!r) { out.push(l); continue; }

    // 选哪一份？按优先级：
    //   ① 谁手里有正文就用谁（首屏那份通常只有索引、没有正文 —— 这是正常状态，
    //      不是"本地更新"）
    //   ② 都有正文（或都没有）时取 updatedAt 新的那一份
    //   ③ 时间戳相同（迁移后的同一份）→ 取 IndexedDB 的（它是权威副本）
    let pick;
    if (!l.content && r.content) pick = r;
    else if (l.content && !r.content) pick = l;
    else if ((r.updatedAt || 0) >= (l.updatedAt || 0)) pick = r;
    else pick = l;

    // 用户已经在这个文档里打过字：编辑器里的文本就是唯一真相
    const userTyped = l.id === activeId && editorText !== '' && editorText !== l.content;
    if (userTyped) {
      out.push({ ...pick, content: editorText });
      if (r.content && r.content !== editorText) {
        recovered.push({ name: r.name || '未命名', content: r.content });
      }
    } else {
      out.push(pick);
    }
  }

  // 只在 IndexedDB 里存在的文档（例如本地索引被清过）→ 补进来，别丢标签页
  for (const r of remote || []) if (!seen.has(r.id)) out.push(r);

  return { docs: out, recovered };
}
