/** web/src/lib/templates.ts — 插入片段库（含数学写作常用结构）。 */

export interface Template {
  id: string;
  label: string;
  hint: string;
  group: string;
  insert: string;
  /** 插入后把光标放到这个标记处（标记会被删除） */
  caret?: string;
}

export const TEMPLATES: Template[] = [
  {
    id: 'theorem',
    label: '定理',
    hint: '::: theorem 名称',
    group: '数学',
    insert: '::: theorem «名称»\n设 $f$ 满足 …，则 …。\n:::\n',
    caret: '«名称»',
  },
  {
    id: 'proof',
    label: '证明',
    hint: '::: 证明',
    group: '数学',
    insert: '::: 证明\n由引理 1 知 …，故结论成立。$\\square$\n:::\n',
  },
  {
    id: 'definition',
    label: '定义',
    hint: '::: definition',
    group: '数学',
    insert: '::: definition «术语»\n称 $X$ 为 …，若 …。\n:::\n',
    caret: '«术语»',
  },
  {
    id: 'lemma',
    label: '引理',
    hint: '::: lemma',
    group: '数学',
    insert: '::: lemma\n…\n:::\n',
  },
  {
    id: 'remark',
    label: '评注',
    hint: '::: remark',
    group: '数学',
    insert: '::: remark\n…\n:::\n',
  },
  {
    id: 'align',
    label: '多行公式',
    hint: '$$\\begin{aligned} …',
    group: '数学',
    insert: '$$\n\\begin{aligned}\n  a &= b + c \\\\\n    &= d\n\\end{aligned}\n$$\n',
  },
  {
    id: 'cases',
    label: '分段函数',
    hint: '\\begin{cases}',
    group: '数学',
    insert: '$$\nf(x)=\\begin{cases}\n  1, & x>0,\\\\\n  0, & x=0,\\\\\n -1, & x<0.\n\\end{cases}\n$$\n',
  },
  {
    id: 'matrix',
    label: '矩阵',
    hint: 'pmatrix',
    group: '数学',
    insert: '$$\nA=\\begin{pmatrix}\n a_{11} & a_{12} \\\\\n a_{21} & a_{22}\n\\end{pmatrix}\n$$\n',
  },
  {
    id: 'sympy',
    label: '对称化矩阵',
    hint: '常用二次型记号',
    group: '数学',
    insert: '设 $A=(a_{ij})$ 对称，$f(x)=\\tfrac12 x^{\\mathsf T}Ax+\\beta\\mathbf 1^{\\mathsf T}x+c$，则\n$\\nabla f(x)=Ax+\\beta\\mathbf 1$。\n',
  },
  {
    id: 'table',
    label: '表格',
    hint: '带对齐的表格',
    group: '结构',
    insert: '| 列 1 | 列 2 | 列 3 |\n|:--|:--:|--:|\n| 左对齐 | 居中 | 右对齐 |\n|  |  |  |\n',
  },
  {
    id: 'code',
    label: '代码块',
    hint: '带语言与高亮行',
    group: '结构',
    insert: '```python {1}\ndef f(x):\n    return x ** 2\n```\n',
  },
  {
    id: 'toc',
    label: '目录',
    hint: '正文内嵌目录',
    group: '结构',
    insert: '[[TOC]]\n',
  },
  {
    id: 'note',
    label: '提示框',
    hint: '::: tip',
    group: '结构',
    insert: '::: tip «标题»\n…\n:::\n',
    caret: '«标题»',
  },
  {
    id: 'warning',
    label: '注意',
    hint: '::: warning',
    group: '结构',
    insert: '::: warning\n…\n:::\n',
  },
  {
    id: 'figure',
    label: '图片',
    hint: '带题注',
    group: '结构',
    insert: '![«题注»](«路径»)\n',
    caret: '«题注»',
  },
  {
    id: 'footnote',
    label: '脚注',
    hint: '[^1]',
    group: '结构',
    insert: '…结论成立[^1]。\n\n[^1]: 这里的补充说明。\n',
  },
  {
    id: 'task',
    label: '待办',
    hint: '- [ ]',
    group: '结构',
    insert: '- [ ] 待办事项\n- [x] 已完成\n',
  },
  {
    id: 'meta',
    label: '文档信息',
    hint: '标题/作者/日期',
    group: '结构',
    insert: '---\ntitle: «标题»\nauthor: «作者»\ndate: 2026-01-01\n---\n\n',
    caret: '«标题»',
  },
];

export const TEMPLATE_GROUPS = ['数学', '结构'];

/** 完整证明示例：一键载入用户提出的那定理。 */
export const THEOREM_SNIPPET = `::: theorem 二次型极值点的对称性
设 $f(x_1,\\dots,x_n)$ 是次数恰好等于 $2$ 的 $n$ 元实系数对称多项式，
$S$ 是使 $f$ 取到最大值或最小值的点集。若 $S$ 有限且非空，则存在 $b\\in\\mathbb R$ 使
$$S=\\{(b,b,\\dots,b)\\}.$$
:::
`;
