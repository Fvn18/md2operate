---
title: "黎曼–勒贝格定理"
subtitle: "从测度论到傅里叶级数的一个应用"
author: "张三"
date: "2026-01-01"
---

# 引言

黎曼可积函数与勒贝格可积函数之间的关系，是实分析中最具启发性的问题之一。
设 $f \in \mathcal{R}[a,b]$，则 $f \in \mathcal{L}^1[a,b]$，且两种积分值相等。

> **定理（黎曼–勒贝格引理）** 设 $f \in L^1(\mathbb{T})$，则其傅里叶系数
> $$\hat{f}(n) = \frac{1}{2\pi}\int_{-\pi}^{\pi} f(t)\,e^{-int}\,\mathrm{d}t \longrightarrow 0 \qquad (|n| \to \infty).$$

## 记号与约定

本节使用的记号如下表所示。

| 记号 | 含义 | 备注 |
|:-----|:-----|:-----|
| $\mathcal{R}[a,b]$ | 黎曼可积函数类 | 有界 |
| $L^1(\mathbb{T})$ | 圆周上可积函数类 | 等价类 |
| $\hat{f}(n)$ | 第 $n$ 个傅里叶系数 | $n \in \mathbb{Z}$ |

## 证明思路

证明分三步走，核心是"用好的函数逼近坏的函数"：

1. 对三角多项式直接计算，得到 $\hat f(n) = 0$（$|n|$ 充分大）；
2. 用三角多项式在 $L^1$ 范数下逼近任意 $L^1$ 函数；
3. 用一致范数控制误差，令 $\varepsilon \to 0$ 即得结论。

```python
import numpy as np

def fourier_coeff(f, n, m=20000, T=2 * np.pi):
    """数值计算第 n 个傅里叶系数。"""
    t = np.linspace(0, T, m, endpoint=False)
    return np.trapezoid(f(t) * np.exp(-1j * n * t), t) / T

print(fourier_coeff(lambda t: np.sign(np.sin(t)), 5))
```

# 主要结果

## 连续情形的推论

由黎曼–勒贝格引理可以推出：连续函数的傅里叶级数在 $L^1$ 意义下收敛，
但一致收敛并不成立（例如 Fejér 反例）。

## 与勒贝格控制收敛定理的比较

两者的共同点是都依赖"逼近"思想；不同之处在于
黎曼–勒贝格引理给出的是**衰减速率**的下界（只是 $o(1)$，没有定量速率）。

| 定理 | 假设 | 结论 |
|:-----|:-----|:-----|
| 黎曼–勒贝格 | $f \in L^1$ | $\hat f(n) \to 0$ |
| 控制收敛 | $f \in L^1$ | 交换极限与积分 |

# 结论

若 $f$ 绝对连续且 $f' \in L^1$，则 $\hat f(n) = O(1/|n|)$，这是可定量化的情形。
一般情形下 $o(1)$ 已是最优，见附录中的反例构造。

# 参考文献

1. Stein, E. M., Shakarchi, R. *Fourier Analysis: An Introduction*. Princeton, 2003.
2. Rudin, W. *Real and Complex Analysis*. McGraw-Hill, 1987.
