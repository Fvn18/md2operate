# 二次型极值点集的对称性

::: theorem 主定理
设 $f(x_1,x_2,\dots,x_n)$ 是**次数恰好等于 $2$** 的 $n$ 元实系数多项式，$S$ 是使 $f$ 取到最大值或最小值的点集。已知

1. $f$ 是**对称多项式**；
2. $S$ 是**有限、非空**集合。

则存在实数 $b$，使得
$$S=\{(b,b,\dots,b)\}.$$
:::

下面给出完整证明。整条证明只有一个核心思想：**$\nabla f$ 是仿射映射**，所以临界点集是一个仿射子空间；再用「$S$ 有限」把它压成单点，最后用对称性把这一点压到对角线上。

---

## 1. 二次函数的矩阵表示

因为 $f$ 的次数恰为 $2$，可把 $f$ 写成
$$
f(x)=\tfrac12\,x^{\mathsf T}Ax+\beta^{\mathsf T}x+c,
\qquad x\in\mathbb R^n,
\tag{1}
$$
其中 $A\in\mathbb R^{n\times n}$ 是**实对称**矩阵，$\beta\in\mathbb R^n$，$c\in\mathbb R$。

::: remark 为什么可以这样写，以及 $A\neq 0$
把 $f$ 按多重指标展开，二次部分 $\sum_{1\le i\le j\le n}a_{ij}x_ix_j$ 中：对 $i<j$ 令 $A_{ij}=A_{ji}=a_{ij}$，对 $i=j$ 令 $A_{ii}=a_{ii}$。这样得到的 $A$ 对称且唯一，并满足 $x^{\mathsf T}Ax=2\sum_{i<j}a_{ij}x_ix_j+\sum_i a_{ii}x_i^2$，于是 $(1)$ 成立。

「次数恰好等于 $2$」$\iff$「某个 $a_{ij}\neq0$」$\iff A\neq 0$。**这一点在后面每一步都要用到**。
:::

于是梯度是**仿射映射**：
$$
\nabla f(x)=Ax+\beta .
\tag{2}
$$

---

## 2. 引理一：极值点必是临界点，临界点集是仿射子空间

::: lemma 引理 1
记 $Z=\{x\in\mathbb R^n:\nabla f(x)=0\}$ 为临界点集，则

1. $S\subseteq Z$；
2. $Z$ 或者是空集，或者是一个仿射子空间 $x_0+\ker A$。
:::

::: 证明
**（1）** 设 $p\in S$。若 $f(p)$ 是 $f$ 的最小值，则 $p$ 是 $f$ 的全局极小点；若 $f(p)$ 是最大值，则 $p$ 是全局极大点。无论哪种情形，$p$ 都是内点（$\mathbb R^n$ 没有边界），$f$ 在 $p$ 处可微，故一阶必要条件给出 $\nabla f(p)=0$，即 $p\in Z$。

**（2）** 由 $(2)$，$Z=\{x:Ax=-\beta\}$ 是线性方程组 $Ax=-\beta$ 的解集。若它非空、取定一个特解 $x_0$，则
$$Z=x_0+\{h:Ah=0\}=x_0+\ker A,$$
即 $\mathbb R^n$ 中的一个仿射子空间。$\square$
:::

::: remark 关键之处
$Z$ **不是**一片随便的曲面，而是"平"的：它要么是空集，要么是某个点、某条直线、某个平面……。因此"$Z$ 无限"与"$Z$ 是单点集"穷尽了非空的情形，这正是下一步能把「$S$ 有限」用上的原因。
:::

---

## 3. 引理二：$A$ 必须半正定或半负定

::: lemma 引理 2
若 $A$ 既非半正定也非半负定（即 $A$ **不定**），则 $f$ 既无最大值也无最小值，从而 $S=\varnothing$。
:::

::: 证明
$A$ 不定，故存在 $u,v\in\mathbb R^n$ 使
$$u^{\mathsf T}Au>0,\qquad v^{\mathsf T}Av<0 .$$
（理由：不定矩阵有正特征值 $\lambda_+>0$ 与负特征值 $\lambda_-<0$，取对应的特征向量即可。）

固定任意 $x\in\mathbb R^n$，沿方向 $u$ 作一元函数
$$
g_u(t)=f(x+tu)=f(x)+t\,\bigl(u^{\mathsf T}Ax+\beta^{\mathsf T}u\bigr)+\frac{t^2}{2}\,u^{\mathsf T}Au .
$$
这是开口向上的抛物线（二次项系数 $\tfrac12u^{\mathsf T}Au>0$），故 $g_u(t)\to+\infty\ (t\to\pm\infty)$。于是 $f$ 在 $\mathbb R^n$ 上无上界。

同理，$g_v$ 是开口向下的抛物线，$f$ 无下界。

既无上界又无下界的函数既取不到最大值也取不到最小值，所以 $S=\varnothing$，与假设 $S\neq\varnothing$ 矛盾。$\square$
:::

由引理 2，以下只需讨论两种情形：$A$ 半正定，或 $A$ 半负定。

---

## 4. 引理三：半定 + 极值集有限 $\Longrightarrow$ 定

::: lemma 引理 3
设 $A\neq0$ 半正定或半负定。若 $S$ 非空且有限，则

* 当 $A$ 半正定时，$A$ **正定**，且 $S=Z$；
* 当 $A$ 半负定时，$A$ **负定**，且 $S=Z$。
:::

::: 证明
只证半正定的情形，半负定情形把 $f$ 换成 $-f$ 即可（$-f$ 仍是对称多项式、次数恰为 $2$，且极值点集不变）。

**第一步：$A$ 半正定时 $f$ 取不到最大值。**
反设 $f$ 在某点 $q$ 取到最大值 $f(q)$。由于 $A\neq0$ 且半正定，存在 $u$ 使 $u^{\mathsf T}Au>0$（否则 $A$ 的二次型恒为 $0$，由对称性推出 $A=0$）。沿 $u$ 展开
$$f(q+tu)=f(q)+t\bigl(u^{\mathsf T}Aq+\beta^{\mathsf T}u\bigr)+\frac{t^{2}}{2}\,u^{\mathsf T}Au\xrightarrow[t\to+\infty]{}+\infty,$$
与 $f(q)$ 是最大值矛盾。

**第二步：$S=Z$。**
$S$ 中的点不可能给出最大值，所以 $S$ 中的点都给出最小值，即 $S=\operatorname{argmin} f$。由引理 1，$S\subseteq Z$。另一方面，$f$ 是凸函数（$A$ 半正定），凸函数在临界点处取到全局最小值，故 $Z\subseteq\operatorname{argmin}f=S$。于是 $S=Z$。

**第三步：有限性迫使 $A$ 可逆。**
由 $S\neq\varnothing$ 知 $Z\neq\varnothing$，由引理 1 有 $Z=x_0+\ker A$。若 $\ker A\neq\{0\}$，则 $Z$ 是正维数的仿射子空间，含有无限多个点（沿任一非零 $h\in\ker A$，$x_0+th$ 全在 $Z$ 中），与 $S=Z$ 有限矛盾。故 $\ker A=\{0\}$，即 $A$ 正定。$\square$
:::

::: remark 为什么凸性那一步是对的
$A$ 半正定时 $f$ 是凸函数。若 $\nabla f(x_0)=0$，则对任意 $y$，
$$f(y)-f(x_0)=\tfrac12 (y-x_0)^{\mathsf T}A(y-x_0)\ \ge\ 0,$$
所以 $x_0$ 是全局最小点。这是纯粹的配方计算，不需要任何微分几何假设。
:::

---

## 5. 收尾：对称性把唯一的临界点压到对角线上

由引理 2、引理 3：$A$ **可逆**（正定或负定），$S=Z$，而
$$
Z=\{x:Ax=-\beta\}=\{-A^{-1}\beta\}
$$
是**单点集**。记
$$
p=-A^{-1}\beta,\qquad S=\{p\}.
\tag{3}
$$

::: theorem 收尾命题
设 $f$ 是对称多项式，$p$ 是 $f$ 的唯一临界点，则 $p=(b,b,\dots,b)$ 对某个 $b\in\mathbb R$ 成立。
:::

::: 证明
设 $\sigma\in S_n$ 是任意置换，$P_\sigma$ 为对应的置换矩阵，即 $(P_\sigma x)_i=x_{\sigma^{-1}(i)}$。

**（1）对称性给出梯度的等变性。**
「$f$ 是对称多项式」的意思是：对一切 $\sigma\in S_n$ 与一切 $x$，
$$f(P_\sigma x)=f(x).$$
两边对 $x$ 求梯度。左边用链式法则，右边用 $\nabla f$：
$$P_\sigma^{\mathsf T}\,\nabla f(P_\sigma x)=\nabla f(x).$$
置换矩阵是正交矩阵且 $P_\sigma^{\mathsf T}=P_\sigma^{-1}$，于是
$$
\nabla f(P_\sigma x)=P_\sigma\,\nabla f(x),
\qquad \forall \sigma\in S_n,\ \forall x\in\mathbb R^n.
\tag{4}
$$
（也可直接对 $(1)$ 验证：$(4)$ 等价于 $P_\sigma^{\mathsf T}AP_\sigma=A$ 且 $P_\sigma^{\mathsf T}\beta=\beta$。）

**（2）唯一临界点必被每个置换固定。**
在 $(4)$ 中取 $x=p$。由 $\nabla f(p)=0$ 得
$$\nabla f(P_\sigma p)=P_\sigma\,\nabla f(p)=P_\sigma\,0=0,$$
即 $P_\sigma p$ 也是 $f$ 的临界点。由 $(3)$ 中临界点的唯一性，$P_\sigma p=p$。

**（3）被所有置换固定的向量必为常向量。**
$P_\sigma p=p$ 对一切 $\sigma\in S_n$ 成立，特别地对换位 $\sigma=(i\ j)$ 成立，而 $(i\ j)$ 只交换第 $i,j$ 个坐标，故 $p_i=p_j$。由 $i,j$ 的任意性，
$$p_1=p_2=\cdots=p_n=:b .$$
于是 $p=(b,b,\dots,b)$。$\square$
:::

结合 $(3)$ 即得
$$
S=\{p\}=\{(b,b,\dots,b)\},
$$
这正是主定理的结论。$\blacksquare$

---

## 6. 显式解：$b$ 到底等于多少

上面的证明是"结构性"的，但它其实给出了闭式公式。与所有置换矩阵交换的矩阵恰为 $I$ 与全 $1$ 矩阵 $J=\mathbf 1\mathbf 1^{\mathsf T}$ 的线性组合，所以由 $(4)$ 中 $P_\sigma^{\mathsf T}AP_\sigma=A$ 得

$$
A=\alpha I+\gamma J,\qquad \beta=\beta_0\mathbf 1
$$

对某 $\alpha,\gamma,\beta_0\in\mathbb R$ 成立（$\beta$ 的形式来自 $P_\sigma^{\mathsf T}\beta=\beta$，即各行和相等）。$A$ 的特征值是

* $\alpha$，重数 $n-1$（特征子空间 $\mathbf 1^{\perp}$）；
* $\alpha+n\gamma$，重数 $1$（特征向量 $\mathbf 1$）。

$A$ 正定 $\iff \alpha>0$ 且 $\alpha+n\gamma>0$；负定 $\iff \alpha<0$ 且 $\alpha+n\gamma<0$。把 $x=t\mathbf 1$ 代入 $\nabla f(x)=0$：

$$
\alpha t+\gamma nt+\beta_0=0
\quad\Longrightarrow\quad
t=-\frac{\beta_0}{\alpha+n\gamma}.
$$

::: remark 显式结论
在上述记号下
$$
\boxed{\,S=\Bigl\{\Bigl(-\frac{\beta_0}{\alpha+n\gamma},\dots,-\frac{\beta_0}{\alpha+n\gamma}\Bigr)\Bigr\}\,}
$$
即 $b=-\dfrac{\beta_0}{\alpha+n\gamma}$。例如 $n\ge1$、$f=\sum_i x_i^2$ 时 $\alpha=2,\gamma=0,\beta_0=0$，得 $S=\{(0,\dots,0)\}$；而 $f=(\sum_i x_i)^2$ 时 $\alpha=0$，$A$ 奇异，$S=\{\sum_ix_i=0\}$ 无限，恰好落在引理 3 的边界之外。
:::

---

## 7. 三个反例：每个条件都不能省

| 被去掉的条件 | 反例 | 现象 |
|:--|:--|:--|
| $S\neq\varnothing$ | $f(x_1,x_2)=x_1x_2$ | 对称、次数恰 $2$，但 $f$ 无界，$S=\varnothing$ |
| $S$ 有限 | $f(x)=\bigl(\sum_{i=1}^n x_i\bigr)^2$ | 对称、次数恰 $2$、$S=\{\sum_i x_i=0\}$ 是超平面，无限 |
| 次数恰为 $2$ | $f\equiv c$（常数） | 对称，但 $S=\mathbb R^n$，无限 |

::: remark 逐条核对
* $f=x_1x_2$ 时 $A=\begin{pmatrix}0&1\\1&0\end{pmatrix}$ 不定，正对应引理 2 的情形：$S=\varnothing$。这说明「$S$ 非空」不是装饰性假设。
* $f=(\sum_ix_i)^2$ 时 $A=2J$ 半正定但奇异，$\ker A=\{\sum_ix_i=0\}$ 维数为 $n-1\ge1$，正对应引理 3 第三步中被排除的情形：$S=Z$ 无限。
* 常函数说明「次数恰为 $2$」保证了 $A\neq0$，否则结论不仅不成立，而且 $S$ 连有限都做不到（或者根本不存在极值）。

因此主定理的三个条件互相独立，缺一不可。
:::

---

## 8. 评注与推广

::: remark 更强的结论
证明中用到的只有两件事：$\nabla f$ 是仿射映射，以及 $f$ 对称。于是：

1. **局部极值也成立。** 若把 $S$ 换成"局部极值点集"，由于二次函数的凸性，$A$ 半正定时局部极小点恰是全局极小点（集合 $Z$），故同样的论证给出相同的结论：局部极值点集有限非空时必为 $\{(b,\dots,b)\}$。
2. **任意对称群作用也成立。** 把 $S_n$ 换成任一有限群 $G\subseteq O(n)$（例如二面体群、Weyl 群），只要 $f$ 在 $G$ 下不变且临界点唯一，则 $p$ 被 $G$ 固定。$S_n$ 的特殊之处在于"被 $S_n$ 固定的向量恰是常向量"，这来自 $S_n$ 在 $\mathbb R^n$ 上的作用是不可约的（等价地，置换表示的中心化子是 $\{I,J\}$ 的线性组合）。
3. **复系数情形失效。** 若把"最大值/最小值"换成"实部极值"，二次型不再有实对称矩阵的谱定理支撑，需要另作讨论；本证明用到的对称性与正定性都是实结构。
:::

::: remark 一句话总结
$Z$ 是仿射子空间 $\Rightarrow$ 有限性把 $Z$ 压成单点 $p$；梯度等变性 $\nabla f(Px)=P\nabla f(x)$ $\Rightarrow$ 唯一性把 $p$ 压到对角线。两句话，各自用掉一个假设。
:::
