/**
 * scripts/lib/synth-doc.mjs — 合成测试文档生成器（无副作用，可被任意脚本 import）。
 *
 * 为什么单独成文件：性能基准、归因实验、增量渲染测试都需要同一份语料。如果把它
 * 放在 bench.mjs 里，任何 `import { makeDoc }` 都会把整个基准跑一遍——这个坑真踩过。
 *
 * 语料的取舍：必须包含真实的解析热点，否则测出来的数字没有意义。
 *   · 大量行内公式 `$…$` 与行间公式 `$$…$$`（KaTeX 是主要成本）
 *   · 代码块（highlight.js + 行号包装）
 *   · 表格、列表、容器（:::  的嵌套 token 结构）
 *   · **刻意重复的模板块**（同样的要点列表/代码块/表格在多节里重复出现）
 *     —— 这是真实文档的常态，也正是「块 key 必须唯一」那个 bug 的暴露点。
 */

const FILLER = '设函数 f 在紧集上连续 则存在最大值与最小值 由引理可得 梯度为零';

/**
 * 生成约 targetChars 字符的数学类 Markdown。
 * @param {number} targetChars
 * @returns {string}
 */
export function makeDoc(targetChars) {
  const parts = [];
  let n = 0;
  let section = 1;
  while (parts.join('').length < targetChars) {
    n++;
    parts.push(`## ${section}. 第 ${n} 节：二次型的标准形

设 $f(x_1,\\dots,x_n)=\\sum_{i\\le j}a_{ij}x_ix_j$ 为二次型，$A=(a_{ij})$ 对称。
由谱定理，存在正交阵 $Q$ 使 $A=Q\\Lambda Q^{\\mathsf T}$，于是

$$
f(x)=\\sum_{k=1}^{n}\\lambda_k y_k^2,\\qquad y=Q^{\\mathsf T}x
\\tag{${n}}
$$

::: lemma 引理 ${n}
若 $\\lambda_k\\neq 0$ 对一切 $k$ 成立，则 $A$ 可逆，且 $f$ 的极值点集为单点集。
:::

::: 证明
由 $\\nabla f(x)=Ax+\\beta$ 知临界点集是仿射子空间；若 $A$ 奇异则它无限，
与"极值点有限"矛盾。$\\square$
:::

正文补白：${FILLER.repeat(3)}。

\`\`\`python {1,2}
def symmetrize(A):
    return (A + A.T) / 2      # 对称化
\`\`\`

| 情形 | $A$ 的谱 | 极值点集 |
|:--|:--|:--|
| 正定 | $\\lambda_k>0$ | 单点 |
| 半正定奇异 | 含 $0$ | 仿射子空间 |

- 要点一：$S\\subseteq Z=\\nabla f^{-1}(0)$
- 要点二：$Z$ 有限 $\\Rightarrow$ $\\dim\\ker A=0$
- 要点三：$P_\\sigma p=p\\Rightarrow p=(b,\\dots,b)$

`);
    section++;
  }
  return parts.join('').slice(0, targetChars);
}

/** 语料统计（便于在报告里说明测的是什么） */
export function describeDoc(doc) {
  return {
    chars: doc.length,
    lines: doc.split('\n').length,
    displayMath: (doc.match(/\$\$/g) || []).length / 2,
    inlineMath: (doc.match(/(?<!\$)\$(?!\$)/g) || []).length / 2,
    fences: (doc.match(/```/g) || []).length / 2,
    callouts: (doc.match(/^:::/gm) || []).length / 2,
  };
}
