---
title: "MDP Studio 用户手册"
subtitle: "把 Markdown 排成拿得出手的 PDF 与高清长图"
author: "MDP 工程组"
date: "2026-10-13"
---

# 1. 这是什么

MDP Studio 把 Markdown 变成**出版级 PDF** 和**高清长图**。它有两种用法，能力完全一样：

| 用法 | 适合 | 入口 |
|:--|:--|:--|
| 命令行 | 批量、脚本、CI | `mdp build` 或 `md2pdf` |
| 网页工作台 | 边写边看、调版式、导出前预览 | `mdp serve` |

两条用法共用同一套排版引擎与同一份渲染代码，所以**命令行出的图和网页里看到的是同一个版面**。

::: tip 一句话选路线
要**打印或投稿** → PDF（LaTeX 路线，字体嵌入、分页正确）。
要**发群、发推、贴公众号** → PNG 长图（浏览器路线，真分辨率、可透明）。
要在**网页里嵌** → HTML（自带样式，零外部依赖）。
:::

---

# 2. 安装与体检

## 2.1 依赖

必需：

- **Node ≥ 20**（网页工作台、CLI 包装、`mdp` 命令）
- **pandoc** —— 转成 PDF / DOCX / TeX 时必需

可选，按需装：

| 工具 | 换来的能力 | 安装 |
|:--|:--|:--|
| XeLaTeX（TeX Live / MacTeX） | LaTeX 路线的 PDF | `brew install --cask mactex-no-gui` |
| Chromium / Chrome | PNG 与 HTML 路线（真分辨率截图） | `brew install --cask google-chrome` |
| poppler | 高清栅格化（`pdftoppm`） | `brew install poppler` |
| Ghostscript | 高清栅格化备选、PDF 处理 | `brew install ghostscript` |
| fswatch | 监听模式从"轮询"升级为内核事件 | `brew install fswatch` |

## 2.2 体检

装完先跑一次体检，它会告诉你**哪些路线现在能用、哪些缺什么**：

```sh
mdp doctor
```

输出会分三档：`ok` 可用、`warn` 可用但有折损、`fail` 不可用，每项都附安装命令。

想给脚本消费，加 `--json`：

```sh
mdp doctor --json
```

---

# 3. 五分钟上手

写一个 `笔记.md`：

```markdown
# 我的第一份文档

公式可以这样写：$e^{i\pi} + 1 = 0$。

$$
\int_0^1 x^2\,\mathrm{d}x = \frac{1}{3}
$$

::: 定理 勾股定理
直角三角形两直角边的平方和等于斜边的平方。
:::
```

然后：

```sh
mdp build 笔记.md -t pdf -q cn --toc      # 出一份中文 PDF
mdp build 笔记.md -t png --dpi 300        # 出一张 300 DPI 长图
mdp serve                                 # 打开网页工作台
```

`mdp build` 的 `-t` **默认是 `png`**；`md2pdf` 命令的默认是 `pdf`。两者参数一致，习惯哪个用哪个。

---

# 4. 写作：Markdown 该怎么写

## 4.1 基础语法

标准 Markdown 全支持（标题、列表、表格、引用、代码块、链接、图片）。

## 4.2 数学公式

行内用 `$...$`，独立成块用 `$$...$$`。内部是完整的 LaTeX 数学语法。

$$
f(x) = \sum_{k=1}^{n} \lambda_k y_k^2, \qquad y = Q^{\mathsf{T}} x
$$

::: note 公式写错了会怎样
预览会在公式位置标出错误，并在状态栏汇总错误数量；导出时会跳过这一处而不是整篇失败。
:::

## 4.3 容器：把"定理""提示"写出来

用三个冒号包一段内容。容器有**中英双语别名**，写中文更自然：

```markdown
::: 定理 勾股定理
直角三角形两直角边的平方和等于斜边的平方。
:::
```

支持的种类（左列英文名，右列等价的中文写法）：

| 用途 | 英文别名 | 中文别名 |
|:--|:--|:--|
| 提示 | `note` / `info` | 注 / 注记 / 备注 / 说明 / 信息 |
| 提醒 | `tip` / `important` / `warning` / `danger` | 提示 / 技巧 / 重要 / 警告 / 注意 / 危险 |
| 结论 | `success` | 成功 / 结论 |
| 引用 | `quote` | 引用 |
| 数学结构 | `theorem` / `lemma` / `proposition` / `corollary` / `definition` / `axiom` | 定理 / 引理 / 命题 / 推论 / 定义 / 公理 |
| 证明与例题 | `proof` / `remark` / `example` / `exercise` / `algorithm` / `solution` | 证明 / 评注 / 例 / 练习 / 算法 / 解 |

标题可以省略，也可以带副标题（如上面例子里「勾股定理」）。

::: important 自动编号
数学结构类容器（定理、引理、命题、推论、定义、公理、例）会**自动编号**。
用 `--numbering` 显式打开；`cn` 与 `high` 等档位已默认开启。
:::

## 4.4 其他扩展语法

**脚注**：`这里有个说法[^1]`，在文末写 `[^1]: 出处`。

**定义列表**：

```markdown
渲染
: 一次"输入 → 产物"的执行
```

**任务列表**：

```markdown
- [x] 已经做完的
- [ ] 还没做的
```

**表格、代码块**：标准语法。代码块可以要求显示行号（命令行加 `--line-numbers`），
也可以指定语言以获得高亮。

---

# 5. 导出

## 5.1 三条路线怎么选

| 目标 | 命令 | 引擎 | 什么时候用 |
|:--|:--|:--|:--|
| PDF（打印级） | `-t pdf` | pandoc + XeLaTeX | 投稿、打印、需要目录与交叉引用 |
| PDF（秒级） | `-t pdf-html` | 浏览器打印 | 只是要看内容，不在意 LaTeX 排版 |
| PNG 长图 | `-t png` | 默认浏览器截图 | 分享、贴图 |
| PNG（LaTeX 版面） | `-t png --via latex` | LaTeX 排版后栅格化 | 要 LaTeX 版面又要位图 |
| HTML | `-t html` | 浏览器 / pandoc | 嵌入网页 |
| DOCX / TeX / MD | `-t docx` / `-t tex` / `-t md` | pandoc | 交给别人继续编辑 |

### 一次出多种格式

`-t` 接受逗号分隔的多条路线：

```sh
mdp build 论文.md -t png,pdf,html
```

::: warning 多路线要时间
`png,pdf` 意味着渲染两遍（浏览器一遍、LaTeX 一遍）。批量时建议分开跑或配合并发 `-j`。
:::

## 5.2 质量档位（LaTeX 路线）

七档，覆盖从"边写边看"到"印刷交付"：

| 档位 | 字号 | 页边距 | 目录 | 编号 | 说明 |
|:--|:--|:--|:--|:--|:--|
| `draft` | 10pt | 0.8in | — | — | 极速草稿 |
| `std` | 11pt | 1.2in | — | ✓ | 标准（默认） |
| `high` | 11pt | 1.0in | ✓ | ✓ | 高质量论文 |
| `press` | 12pt | 1.0in | ✓ | ✓ | 印刷排版（双面） |
| `cn` | — | 1.1in | ✓ | ✓ | 中文论文（ctex，宋体/黑体/楷体） |
| `screen` | 11pt | 0.9in | ✓ | ✓ | 屏幕阅读（大行距） |
| `slides` | — | — | — | — | Beamer 幻灯片 |

```sh
mdp build 论文.md -t pdf -q cn
```

::: tip 中文文档请用 cn
其他档位也能出中文（会自动挑中文字体），但 `cn` 走 ctex，中文标点、首行缩进、
断行规则都按中文排版惯例来。
:::

## 5.3 PNG：分辨率与版式

**分辨率**用 `--dpi`（默认 200）：

| DPI | 典型用途 |
|:--|:--|
| 150 | 屏幕查看 |
| 300 | 打印 |
| 600 | 印刷 |
| 1200 | 极致（单页最大，超长文档慎用） |

**版式**用 `--card`：

```sh
# 整页长图（默认）
mdp build 长文.md -t png --dpi 300

# 分享卡片：内容宽度自适应，四周留白
mdp build 摘录.md -t png --dpi 300 --card --theme ink

# 透明背景（叠加到别的图上用）
mdp build 公式.md -t png --transparent
```

::: warning 超长文档 × 超高 DPI
一张 A4 页面在 1200 DPI 下是 8325×2013 像素；**长图**按同样分辨率解码需要 GB 级内存。
超长文档建议 300 DPI，或拆成多份。
:::

## 5.4 文档主题

主题影响配色、字号、间距，命令行与网页共用同一套：

```sh
mdp themes                # 看全部主题
mdp build 笔记.md -t png --theme ink
```

## 5.5 网页端参数（HTML 路线）

HTML 与 PNG 路线有一套独立的版式参数，和 LaTeX 路线互不干扰：

```sh
mdp build 文章.md -t png \
  --theme paper --width 800 --font-size 17 --line-height 1.8 \
  --title "文章标题" --author "作者" --date "2026-10-13" \
  --line-numbers --justify
```

| 参数 | 作用 |
|:--|:--|
| `--width N` | 正文宽度（像素）。卡片宽度 = 正文宽度 + 内边距 |
| `--paper NAME` | 纸张：`A4` / `A5` / `B5` / `Letter` / `Legal` / `A3` |
| `--font-size N` / `--line-height N` | 字号与行距 |
| `--margin N` | 页边距（毫米） |
| `--card-pad N` | 卡片内边距 |
| `--font NAME` / `--heading-font NAME` | 正文字体与标题字体预设 |
| `--code-theme NAME` | 代码高亮主题 |
| `--accent COLOR` | 强调色，如 `#6366f1` |
| `--title` / `--author` / `--date` / `--no-meta` | 顶部信息块 |
| `--toc` / `--embed-toc` | 目录（后者把目录嵌进正文） |
| `--line-numbers` / `--justify` / `--indent` | 代码行号 / 两端对齐 / 首行缩进 |
| `--breaks` | 软换行即换行（不合成一段） |

---

# 6. 网页工作台

## 6.1 启动

```sh
mdp serve                 # 默认 http://127.0.0.1:8757
mdp serve --port 9000 --no-open
mdp serve --token 我的口令  # 对外暴露时加一层口令
```

## 6.2 界面分区

| 区域 | 作用 |
|:--|:--|
| 左侧编辑区 | 写 Markdown（支持 Vim 模式） |
| 右侧预览区 | 实时渲染结果，与导出同构 |
| 顶部工具栏 | 导出、保存、文档切换、主题 |
| 底部状态栏 | 字数、渲染引擎、增量指标、持久化状态 |
| 导出抽屉 | 右侧，选路线与参数 |
| 输出控制台 | 底部，实时日志与进度 |

## 6.3 快捷键

| 键 | 作用 |
|:--|:--|
| `⌘S` / `Ctrl+S` | 立即保存 |
| `⌘K` / `Ctrl+K` | 打开命令栏 |
| `⇧⌘E` | 打开 / 收起导出抽屉 |
| `⌘B` | 加粗 |

## 6.4 命令栏

按 `⌘K` 打开，输入即搜。终端里的常用操作在网页里都有对应命令，
包括切换主题、切换缩放、开关虚拟化、切换滚动同步模式。

::: note 滚动同步
编辑器滚到第 N 行，预览会滚到对应位置——按**行号锚定**，不是按比例。
数学文档里公式块很高、表格很扁，按比例会因为行密度差异越滚越偏。
:::

## 6.5 数据放在哪

文档正文存在浏览器的 **IndexedDB**，localStorage 只留索引（id、标题、字数）。
没有 IndexedDB 时（如 Safari 无痕）自动降级到 localStorage，并在状态栏如实显示"降级"。

---

# 7. 批量与自动化

## 7.1 多文件与并发

```sh
mdp build a.md b.md c.md -t pdf -d ./out -j 4
```

`-j` 是并发数。并发采用**滑动窗口**：谁先完成谁先接下一个文件，
不会因为某个慢文件而让整批槽位空等。

## 7.2 增量缓存

同一个文件、同一套参数，第二次编译会直接跳过：

```
▸ 跳过(未变更) ./论文.pdf
```

改了任何**会影响产物**的参数（档位、页边距、模板、参考文献……）都会让缓存失效并重建。

```sh
mdp build 论文.md -t pdf -f     # -f 忽略缓存，强制重建
```

::: warning 缓存判据
缓存判定看两件事：产物比源文件新，且参数指纹一致。
**只改文件内容而不改时间戳**（少见，但某些工具会这么做）不会触发重建——用 `-f`。
:::

## 7.3 监听模式

```sh
mdp build 笔记.md -t pdf -w
```

改了源文件就自动重编译。装了 `fswatch` 时走**内核文件事件**（毫秒级触发）；
没装则退回轮询（默认间隔 0.3 秒，可用 `MD2PDF_WATCH_INTERVAL` 调整）。

::: important 高频保存是安全的
监听采用"杀掉上一次编译再开新的"，并且是**按进程组**杀——不会堆积出一串
`xelatex` 把内存吃光。实测每 50 毫秒保存一次连写 60 次，并发编译进程数峰值为 1。
:::

## 7.4 标准输入

```sh
cat note.md | mdp build --stdin --name note -t png
```

`--name` 用来决定输出文件名，`--stdin` 时必须给。

## 7.5 脚本化

**干跑**：只打印将要执行的命令，不渲染。

```sh
mdp build 论文.md -t pdf -n
```

**JSON 输出**：产物信息给脚本消费。

```sh
mdp build 论文.md -t pdf --json
```

**安静 / 详细**：

```sh
mdp build 论文.md -t pdf -Q      # 只出错误
mdp build 论文.md -t pdf -v      # 详细日志
```

---

# 8. 配置与自定义

## 8.1 配置文件

生成模板：

```sh
md2pdf init-config
```

它会写到 `~/.config/md2pdf/config.sh`（或 `$XDG_CONFIG_HOME/md2pdf/config.sh`）。
这个文件**就是 shell**，可以写逻辑：

```sh
MD2PDF_QUALITY=high
MD2PDF_ENGINE=xelatex
MD2PDF_CJK_FONT=auto
MD2PDF_JOBS=1
```

指定另一份配置：

```sh
md2pdf --config 我的配置.sh 论文.md
```

优先级：**命令行 > 配置文件 > 内置默认值**。

## 8.2 环境变量

| 变量 | 作用 |
|:--|:--|
| `MD2PDF_QUALITY` | 默认质量档位 |
| `MD2PDF_TO` | 默认输出格式 |
| `MD2PDF_ENGINE` | 默认引擎 |
| `MD2PDF_JOBS` | 默认并发数 |
| `MD2PDF_WATCH_INTERVAL` | 轮询间隔（秒） |
| `MD2PDF_WATCH_LATENCY` | `fswatch` 的突发合并窗口（秒） |
| `MD2PDF_PNG_DPI` / `MD2PDF_PNG_PAGE` | PNG 默认分辨率与页码 |
| `MD2PDF_CONFIG` | 指定配置文件 |
| `MD2PDF_HOME` | 项目根目录（自动推断） |
| `SIG_CACHE_DIR` | 缓存目录（默认 `~/.cache/md2pdf`） |
| `MDP_CHROME` | 指定 Chromium / Chrome 可执行文件 |
| `MDP_CHROME_ARGS` | 追加浏览器启动参数（排查性能时用） |

## 8.3 模板与 LaTeX 头部

```sh
# 换模板
mdp build 论文.md -t pdf --template 我的模板.tex

# 追加导言区（可重复）
mdp build 论文.md -t pdf -H 导言.tex

# 透传变量给 pandoc 模板
mdp build 论文.md -t pdf -s geometry:margin=2cm -s fontsize=12pt
```

## 8.4 参考文献

```sh
mdp build 论文.md -t pdf --citeproc --bibliography refs.bib --csl 样式.csl
```

---

# 9. HTTP API

网页工作台本质上是一个本地 HTTP 服务，可以当 API 用。

| 方法 | 路径 | 作用 |
|:--|:--|:--|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/caps` | 环境体检（等价于 `mdp doctor --json`） |
| `GET` | `/api/meta` | 档位、路线、主题、Markdown 开关 |
| `POST` | `/api/plan` | 只算要执行什么命令，不渲染 |
| `POST` | `/api/render` | 提交渲染任务 → 返回 `jobId` |
| `GET` | `/api/jobs/:id/events` | 实时日志（SSE） |
| `POST` | `/api/jobs/:id/cancel` | 取消单个任务 |
| `POST` | `/api/jobs/cancel-all` | 取消全部在跑的任务 |
| `GET` | `/api/artifacts` | 产物列表 |
| `GET` | `/api/file` | 下载产物 |
| `POST` | `/api/render-sync?target=png` | **同步渲染**，直接返回二进制 |

一条命令出图，不用打开网页：

```sh
curl -s -X POST 'http://127.0.0.1:8757/api/render-sync?target=png&download=1' \
  -H 'content-type: application/json' \
  -d '{"content":"# 标题\n\n$$e^{i\\pi}+1=0$$","filename":"demo","png":{"dpi":300,"mode":"page"}}' \
  -o demo.png
```

::: tip 客户端断开 = 任务取消
`render-sync` 在客户端断开时会立刻取消任务。这是为了修掉"连点导出会在后台堆一串
渲染"的问题——如果调用方超时退出，服务器不会继续空跑。
:::

---

# 10. 故障排查

## 10.1 先跑体检

```sh
mdp doctor
```

绝大多数"导不出来"都能在这里看到原因。

## 10.2 常见情况

| 现象 | 原因 | 处理 |
|:--|:--|:--|
| PDF 路线报缺 pandoc | 未安装或不在 PATH | `brew install pandoc` |
| PDF 报缺 LaTeX 引擎 | 未安装 TeX | `brew install --cask mactex-no-gui` |
| PNG 出图偏软 | 高清栅格化工具缺失，降级到系统内置工具 | `brew install poppler` |
| PNG 出图空白 / 报找不到浏览器 | 未找到 Chromium | 装 Chrome，或设 `MDP_CHROME` 指向可执行文件 |
| 中文变成方框 | 字体缺失 | 用 `-q cn`，或 `--cjkfont` 指定字体 |
| 公式没渲染 | 语法错误 | 预览会标出位置，看状态栏错误计数 |
| 改了参数但产物没变 | 缓存判定认为未变更 | 加 `-f` 强制重建 |
| 网页打不开 | 端口被占 | `mdp serve --port 9000` |

## 10.3 想看清楚它在干什么

```sh
mdp build 论文.md -t pdf -n       # 只打印命令
mdp build 论文.md -t pdf -v       # 详细日志
mdp build 论文.md -t pdf -k       # 保留中间 .tex，便于对照
```

## 10.4 清理

```sh
md2pdf --clean      # 清转换缓存
mdp clean           # 清产物目录
```

---

# 11. 附录：常用参数总表

| 参数 | 简写 | 作用 |
|:--|:--|:--|
| `--to` | `-t` | 输出格式 |
| `--via` | | 用哪条引擎出图（`html` / `latex`） |
| `--quality` | `-q` | 质量档位 |
| `--engine` | `-e` | LaTeX 引擎 |
| `--output` | `-o` | 输出文件 |
| `--outdir` | `-d` | 输出目录 |
| `--jobs` | `-j` | 多文件并发数 |
| `--dpi` | | PNG 分辨率 |
| `--page` | | PNG 取第几页 |
| `--card` | | 卡片版式 |
| `--theme` | | 文档主题 |
| `--force` | `-f` | 忽略缓存 |
| `--dry-run` | `-n` | 只打印命令 |
| `--keep` | `-k` | 保留中间文件 |
| `--watch` | `-w` | 监听重建 |
| `--stdin` | | 从标准输入读 |
| `--json` | | 产物信息 JSON |
| `--quiet` | `-Q` | 安静模式 |
| `--verbose` | `-v` | 详细日志 |

完整参数表（含 56 项）：`mdp help build --all`

---

# 12. 进阶：它内部是怎么做到的

不需要懂也能用，但知道一点有助于判断"什么时候该等、什么时候该查"。

**实时预览为什么这么快。** 解析与公式排版跑在浏览器的 Web Worker 里，
主线程只负责把**变化过的块**贴进页面。改一个段落，通常只有 1 个块需要重画。

**预览为什么和导出长得一样。** 两者用的是同一份渲染代码与同一份样式表，
导出页只是多了一个"关闭视口外跳过"的标记，以保证截图和分页不缺内容。

**滚动同步为什么按行号。** 数学文档里公式块很高、表格很扁，按比例同步会越滚越偏。
本系统给每个块记了它对应的源码行区间，按行号锚定并做块内插值。

**取消为什么是即时的。** 浏览器的截图与打印一旦发出就无法中途撤销，
所以"取消"的做法是终止该浏览器实例（实测 158 毫秒完成，无残留进程），
下一次渲染会自动重启一个新实例。
