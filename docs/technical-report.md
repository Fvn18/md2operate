# MDP Studio 技术报告

**主题**：架构复核 · 端到端实测 · 缺陷定位与修复
**日期**：2026-10-13
**基线**：`main` @ `fd78ccc`（工作区含未提交改动，见下）
**调试内核**：`/Users/fubin/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`（Google Chrome for Testing 155.0.8059.39）

---

## 0. 摘要

本次工作用本地 chrome-headless-shell 对 MDP Studio 做了一次完整的端到端复核：跑通 11 个自检脚本、用 CDP 真实驱动浏览器测了三组性能归因实验，并把架构描述逐条对到代码。

**结论：架构描述基本成立，但发现 1 个阻断级缺陷、2 个性能缺陷、若干处文档与实测不符。**

| # | 级别 | 问题 | 状态 |
|:--|:--|:--|:--|
| 1 | **P0** | `preflight()` 读了一个不存在的字段，导致 **PDF / TeX / docx / md / PNG(LaTeX) 全部被 409 拦死** —— 网页端根本导不出 PDF | **已修复并验证** |
| 2 | P1 | `fitScale` 没有下限：面板一窄，整篇文档被缩到 `scale=0.02`，虚拟化被迫挂 154 个块，滚动跌到 34fps | 已定位，方案见 §4.2 |
| 3 | P1 | `measure()` 每轮把**所有**已挂载块的 `offsetHeight` 重读一遍，触发整纸张强制同步布局；滚动期间占 CPU 43% | 已定位，方案见 §4.3 |
| 4 | P2 | `.gitignore` 里残留未解决的合并冲突标记 | **已修复** |
| 5 | P2 | `bench.mjs` 的 `scrollFps` 强依赖窗口尺寸，两个 JSON 之间不可比 | **已修复**（新增 `--viewport`） |
| 6 | P2 | README 有 4 处数字/描述与实测不符 | 见 §4.6 |
| 7 | P3 | 补全脚本陈旧、`--page` 不在帮助表、`notices` 无人消费 | 见 §4.7 |

**性能实况**：逐键延迟 p50 **24.4ms**（正常窗口）—— 优于 README 声称的 41.2ms；滚动帧率 **55.7fps**（正常窗口）/ **35.1fps**（800×600 且抽屉打开）—— 低于 README 声称的 60fps。差值全部来自窗口几何，机制已在 §4.2 定量说明。

---

## 1. 验证环境与方法

### 1.1 环境事实

```
node          v22.23.3
内核          chrome-headless-shell 155.0.8059.39（本机唯一可用浏览器）
软件光栅      ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)))
```

本机**没有** Playwright / Puppeteer 缓存，**没有** `/Applications` 下的任何 Chromium 系浏览器。因此 `findChrome()` 的前三条路径（Playwright 缓存 → Puppeteer 缓存 → 系统安装）全部落空，只能靠第 0 条：`MDP_CHROME` 环境变量。本次所有实测都在：

```sh
export MDP_CHROME=/Users/fubin/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

> **小瑕疵**：`findChrome()` 在 `server/chrome.mjs:69` 对 `MDP_CHROME` 分支硬编码 `kind: 'full'`，
> 而实际传入的是 headless-shell。目前 `kind` 字段在整个仓库里没有任何消费点（已 grep 确认），
> 所以不影响行为，但会误导将来读 `caps.chrome.kind` 的人。

### 1.2 方法论：为什么必须先固定窗口尺寸

这是本次复查最重要的方法论发现，后面 §4.2 会展开：**`bench.mjs` 的 `scrollFps` 测的不是"帧率"，而是"2 秒内能挂载多少块"**，而后者由预览面板宽度间接决定：

```
面板越窄 → fitScale 越小 → 可见的布局像素 = clientHeight / scale 越多
        → 虚拟化要挂的块越多 → 每轮 measure() 的强制布局越贵
```

`bench.mjs` 默认用 Chromium 默认窗口 800×600，而 `ui.showExport` 与 `ui.showConsole` **默认都是 `true`**（`store.ts:211`）。在 800×600 下实测：

```
win 800  →  drawer 344  →  workArea 124  →  editor 62, preview 57  →  .preview-scroll 56px
availW = 56 - 36(padding) = 20  →  fitScale = 20/926 = 0.0216
```

预览面板只剩 56 像素宽。此时整篇 116,729 布局像素高的文档被压进 2623 像素的滚动高度，2 秒内会被完整遍历一遍（1151 块全部过一遍视口）。**测出来的是最坏情况，不是日常体验。**

因此本次给 `bench.mjs` 加了 `--viewport WxH`（默认行为不变），并把窗口尺寸写进结果 JSON —— 不记尺寸的两个 JSON 之间没有可比性。

---

## 2. 自检矩阵（实测结果）

全部 11 个脚本实跑，`verify-python` 因缺 `.venv` 按设计跳过：

| 套件 | 命令 | 结果 |
|:--|:--|:--|
| 核心渲染 | `npm run verify` | **27 项通过** |
| 增量预览 | `verify:preview` | **39 通过 / 0 失败** |
| 滚动映射 | `verify:scrollmap` | **28 通过 / 0 失败** |
| 持久化 | `verify:persist` | **29 通过 / 0 失败** |
| 取消/熔断 | `verify:cancel` | **23 通过 / 0 失败** |
| 导出链 | `verify:export` | **14 通过** |
| UI | `verify:ui` | **16 通过**（页面异常：无） |
| AI | `verify:ai` | **20 通过** |
| Vim | `verify:vim` | **13 通过**（1 项标注"待人工确认"） |
| 滚动同步 | `verify:sync` | **4 通过** |
| Python(方案B) | `verify:python` | 跳过（未找到 `.venv`） |

### 2.1 最有分量的几条断言（原文摘录）

**同构性 —— 这是整个项目最硬的一条约束，且确实守住了：**

```
✔ 预览逐块拼接 == 导出整篇 HTML（同一份渲染器，结构完全一致）   3598KB 完全一致
✔ 增量拼接 == 全量渲染（逐字节）                                1087 KB
✔ 导出包装与预览同构（data-first 完整）                          347 个 .mdp-block
✔ KaTeX 公式数量与导出一致                                       2553 个
```

**增量渲染的实际效率：**

```
✔ 改一处只重渲 1 块                          1/347 重渲 · 5.4ms（复用率 99.7%）
✔ 重复块序号漂移不会引发"批量重传"            下发 HTML=1 块 · 补区间=0 块
✔ 顶部插入只重传新块（其余块仅行号位移）        下发 HTML=3 · 补区间=1150
✔ 位移块的 HTML 字符串引用不变                1150/1153
✔ 插入不导致后续块 id 全部变化（DOM 不搬家）    保号 1150/1153
   逐键：引擎 18.4/19.2/20.7ms（p50/p95/max）· 主线程差量应用 0.06ms
✔ 连续打字期间差量始终 < 全量 1%               0.13KB / 3671.7KB
```

**真 DPI 与导出：**

```
✔ 真 DPI 生效            目标宽 1852px，实测 1852px → 约 192 DPI
✔ 1200 DPI 输出          8325×2013（期望宽 ≈8300）
✔ KaTeX 字体已内联       396 KB（零外部依赖，无 CDN 引用）
```

**取消语义（真实渲染任务，不是 mock）：**

```
✔ 取消后任务状态变成 cancelled（不是等截图跑完）   158ms
✔ 整个取消在 4 秒内结束（600DPI / 27 万 CSS px 的截图）  158ms
✔ 没有留下孤儿子进程                              子进程 0 → 0
```

**滚动映射：**

```
✔ 20 万次双向映射耗时 12.3ms（二分查找）
✔ 5000 块的文档：视口内只渲染少量块    渲染 32 块
✔ 比例同步：同一位置偏出几十行以上（这就是必须插值的原因）  最差 1085 行
```

**持久化：**

```
✔ localStorage 占用从 MB 级降到 KB 级    2.9MB → 366 字节
✔ 用户正在编辑的内容没有被覆盖
✔ 远端那一份被保留为「恢复副本」（宁可多一份，也不静默丢）
```

---

## 3. 架构复核：把描述逐条对到代码

### 3.1 同构渲染核心 —— 成立，且比描述的更严格

描述：「浏览器实时预览、Chromium 导出的 PNG/PDF 以及 md2pdf 导出的产物，在 Markdown 语义解析、KaTeX 公式渲染、代码高亮和文档样式表上完全共用同一份代码。」

代码事实：

- `shared/markdown.mjs`（714 行）承载解析 + KaTeX + highlight.js；`shared/theme.mjs`（683 行）的 `documentCss()` 同时供给预览（`PreviewPane.tsx:522` 注入 `<style>`）与导出（`buildExportHtml()`）。
- 分块包装也是同构的：预览与导出都走**同一套** `.mdp-block` 包装，块间距由 `data-first` 按"下一块是什么标签"显式给出（`theme.mjs:254+`），而不是靠外边距折叠。
- 实测证据就是 §2.1 那条「预览逐块拼接 == 导出整篇 HTML，3598KB 完全一致」。

**一处需要修正的表述**：`content-visibility` 并非"预览里始终开启"。真实的规则是（`theme.mjs:226-246`）：

```css
/* 默认（未开虚拟化） */
.mdp-doc:not([data-static="1"]) .mdp-block { content-visibility: auto; contain-intrinsic-size: auto 56px; }
/* 虚拟化打开时，显式关掉 —— 避免"测到的高度"与最终高度不一致，把滚动锚定搞歪 */
.mdp-doc[data-virtual="1"]:not([data-static="1"]) .mdp-block { content-visibility: visible; contain-intrinsic-size: none; }
/* 导出页（data-static="1"）关闭，保证截图/分页不缺内容 */
```

也就是说 **`content-visibility:auto` 与虚拟化是二选一的两条路线**，不是叠加生效。≥60 块（`VIRTUAL_MIN_BLOCKS`）时走虚拟化、`content-visibility` 被关掉；<60 块时才靠 `content-visibility` 偷懒。本次实测在 10 万字符文档下 `.mdp-block` 的 computed `content-visibility` 就是 `visible` —— 这**不是缺陷**，是设计如此（`theme.mjs:240-242` 有明确注释）。

### 3.2 双轨导出 —— 成立

- **PNG**：`server/render.mjs` 的 `renderHtmlToPng()`，`dsf = dpi / 96`，`Emulation.setDeviceMetricsOverride` 撑视口 + `Page.captureScreenshot({captureBeyondViewport:true, clip})`。DPI 钳制在 `[36, 1200]`，并回算 `effectiveDpi` 做校验。透明背景走 `Emulation.setDefaultBackgroundColorOverride`。
- **PDF**：`pandoc + XeLaTeX`，`ctex` 由 `includes/press.tex` 提供；另有 `pdf-html` 路线（Chromium `Page.printToPDF`）。
- 实测：PNG 1852×1848 / 192 DPI / 390ms；PDF 33KB / 3727ms；1200 DPI 上限 8325×2013。

### 3.3 缩放补偿 —— 成立，但缺一个下限（详见 §4.2）

`PreviewPane.tsx:245`：

```ts
const fitScale = availW > 0 ? Math.min(1, availW / paperWidth) : 1;
```

纸张宽度恒定（`paperWidth` = 导出真实宽度），容器放不下时整体 `transform: scale()`，外层 `.preview-scale-wrap` 的宽高按缩放补齐，滚动条因此准确。坐标空间的处理很克制，全在 `toLayout()` / `toScroll()` 两个函数里换算（`PreviewPane.tsx:279-280`），中间计算一律走布局空间 —— 这个设计是对的，注释里也写了漏掉换算的后果（"缩到 43% 时跳到第 300 行会落到第 1000 行附近"）。

### 3.4 增量渲染管线 —— 成立，且实测比描述更细

描述的"AST 级分块 + FNV-1a 哈希缓存"是事实（`shared/incremental.mjs`，319 行，基于 markdown-it token 流分块，规避松列表标签失衡）。

但**当前的 key 机制已经超越了"内容哈希 + 出现序号"**。`shared/preview-engine.mjs:108-160` 的实现是：

1. **优先按位置匹配**：`last.list[i]` 的 HTML 与本轮相同 → 判定为同一个块，**继承它的 key**。
2. 位置对不上（插入/删除导致整体位移）→ 按内容哈希找回，**只补 `[start,end]` 行号区间**（约 12 字节），不发 HTML。
3. 只有真正的新块才拿新 key。

注释（`preview-engine.mjs:114-117`）明确写了为什么顺序不能反：先按哈希匹配会在"重复块序号漂移"时认领到另一个位置的旧块，白送一堆行号补丁 —— 实测这条顺序差异决定了「改一行 → 127 个块被标记位移」还是「0 个」。

差量协议本身也很干净（`order` / `blocks` / `ranges` / `removed`），并且有一个 `verifyDelta()` 把"差量应用后的客户端视图"与"引擎全量重渲"逐块比对 —— 这是最容易出错的地方，宁可多写一份校验代码，这个取舍是对的。

`seed()` 预热机制值得一提：首帧为"打开即有内容"由主线程同步渲染，随后交给 Worker；Worker 缓存是冷的，如果不预热就会把整篇 HTML（实测 3.7MB）再传一遍。`seed()` 把客户端已有的块视图灌进引擎身份表，让 Worker 的第一次渲染差量为零。

### 3.5 状态隔离 —— 成立

- `web/src/lib/content.ts`：模块级外部 store + `useSyncExternalStore`，文档正文完全不在 React 顶层 state 里。同步是旁路：`subscribeContent` 内 400ms 防抖才 `dispatch`。
- `web/src/lib/preview-state.ts`：第二条总线，TOC/错误立即发布、统计 250ms 节流。注释里写了动机——否则每次按键重渲整棵目录树，实测 +16ms/键。
- `web/src/lib/cursor.ts`：独立的光标 store（README:591 提到的"光标目录树热路径污染"就是被这个拆掉的）。
- 预览侧 `web/src/lib/preview-client.ts`：`usePreviewSnapshot()` + 模块级 snapshot，块数组只在真正产生新数组时换引用。

### 3.6 虚拟化与 DOM —— 成立，参数如实测

```
OVERSCAN_PX       = 900     视口上下各多挂载的布局像素
VIRTUAL_MIN_BLOCKS= 60      低于此不虚拟化
```

高度表用 `offsetHeight` 实测 + 按"首个标签"分档估值（`estByTagRef`，指数滑动平均 0.6/0.4）；占位块用**命令式**写 `style.height`（`applyPads`），注释说明若走 state 会形成"布局→测量→setState→再布局"级联，实测出现过 190ms 长任务 —— 这个判断是对的，本次 profile 也印证了级联布局的代价。

块本身是 `React.memo`，比较器只看 `html/first/lines/vkey` 四个字符串（`PreviewPane.tsx:86`），配合差量协议"未变更块连对象都不重建"，比较是 O(1)。

### 3.7 零依赖后端 —— 成立

`server/chrome.mjs`（504 行）手写 CDP 客户端：`CdpConnection`（基于 Node ≥22 全局 `WebSocket`）、`ChromePool`（懒启动 + 空闲自杀 + 从 `DevToolsActivePort` 读端口）、`ChromePage`（viewport / 透明背景 / clip / `printToPDF`）。仓库 `dependencies` 里只有 markdown-it / katex / highlight.js 及其插件，**没有 puppeteer / playwright / @google/genai**。

`LAUNCH_ARGS` 里有一段值得保留的实测记录（`chrome.mjs:222-225`）：**故意不加** `--disable-gpu` 系列，因为实测会把每帧 blocking 从数十毫秒推到 300~400ms，测出来的交互延迟完全失真。

AI 侧走 Node 内置 `fetch` 直连 Gemini Interactions API，密钥只在服务端 —— `verify:ai` 的 20 项里包含未知任务 404、超长输入 413、单项关闭 409、总开关关闭 409 四道护栏实测。

### 3.8 滚动锚定 —— 成立，但精度低于 README 声称

`data-lines="起始-结束"` 由分块器写入，编辑器侧给出行号，预览侧用 `yToLine()`（二分）反解，块内再插值。双向都有，用 `syncLock`（180ms）防打架。

`verify:sync` 的实测输出：

```
编辑器顶部行 = 50   → 预览顶部块 data-lines=46-47     偏移 -26px
编辑器顶部行 = 300  → 预览顶部块 data-lines=295-297   偏移 -22px
编辑器顶部行 = 900  → 预览顶部块 data-lines=897-900   偏移 -41px
编辑器顶部行 = 1500 → 预览顶部块 data-lines=1497-1500 偏移 -17px
```

**偏移是 17~41px，不是 README:557 说的"稳定在 8px"**（见 §4.6）。

### 3.9 性能护栏 —— 成立，但不止 7 个

README:282 写"7 个自检套件"，实际 `scripts/verify*.mjs` 有 **11 个**（10 个子套件 + `verify.mjs` 主控）。

---

## 4. 发现与修复

### 4.1 【P0，已修复】`preflight` 把 md2pdf 判死 → 整个 LaTeX/文档路线被 409 拦断

#### 症状（端到端复现）

```
POST /api/render  targets=["png"]  → HTTP 202  （正常建任务）
POST /api/render  targets=["pdf"]  → HTTP 409
   {"error":"环境不具备该导出路线的条件",
    "blockers":[{"id":"md2pdf","message":"md2pdf 脚本不可用","hint":"检查 md2pdf 权限"}]}
```

而同一台机器上：

```
$ ls -l md2pdf                        → -rwxr-xr-x  （存在且可执行）
$ caps.checks[md2pdf]                 → {"id":"md2pdf","status":"ok","detail":"/Users/fubin/scripts/md2pdf"}
$ preflight('pdf').blockers           → ["md2pdf"]     ← 自相矛盾
```

**影响面**：`ROUTE_DEPS` 里声明了 `md2pdf: true` 的路线全部命中 —— `pdf` / `tex` / `docx` / `md` / `png-latex`。也就是说**网页端无法导出 PDF、TeX、Word、Markdown、LaTeX 栅格化 PNG**；CLI（`mdp build`）不受影响，因为它直接调 `executeRender`，不走 HTTP 预检。自检套件也没抓到，因为 `verify-export` 与 `bench` 同样直接调 `executeRender`。

#### 根因

`server/caps.mjs` 的 `probeCaps()` 返回的缓存对象上有 `engines / chrome / raster / fonts / tools / checks / summary`，**没有 `md2pdf` 字段** —— md2pdf 的可用性只存在于 `checks[]` 里（由 `add('md2pdf', '引擎', ...)` 在第 110 行写入）。而 `preflight()` 读的是：

```js
: dep === 'md2pdf' ? Boolean(caps.md2pdf)   // ← 恒为 undefined → 恒为 false
```

`Boolean(undefined) === false`，于是每次预检都无条件塞进一个 blocker。这是**典型的"两处各算一遍"**：探测写进 checks，预检读另一个不存在的字段。

#### 修复

`server/caps.mjs:219-228`，改为从唯一事实来源 `checks` 取：

```js
: dep === 'md2pdf' ? caps.checks.some((c) => c.id === 'md2pdf' && c.status === 'ok')
```

#### 验证

修复后逐路线端到端（走 `/api/render-sync`，直接拿二进制，能同时校验产物合法性）：

```
pdf    HTTP 200 | 路线 pdf  | 22310 B | 3840ms | 头 "%PDF"
tex    HTTP 200 | 路线 tex  |  2149 B |  119ms | 头 "% Op"
docx   HTTP 200 | 路线 docx | 10880 B |  130ms | 头 "PK\u0003\u0004"
png    HTTP 200 | 路线 png  | 31937 B |  366ms | 头 "PNG"（工具 chromium）
```

四条路线的**文件头魔数全部正确**（`%PDF` / TeX 源码 / docx 的 zip 魔数 `PK` / PNG 签名）。回归：`verify`(27) / `verify-export`(14) / `verify-ui`(16) / `verify-ai`(20) 全部仍然通过。

---

### 4.2 【P1，已定位】`fitScale` 没有下限 → 缩放崩塌 + 虚拟化挂载爆炸

#### 现象

视口扫描（同一份 10 万字符文档、同一滚动脚本、只改窗口尺寸）：

| 窗口 | scale | 纸张布局高 | scrollHeight | 挂载块数 | 滚动 fps | 2s 内长任务 |
|:--|--:|--:|--:|--:|--:|--:|
| **800×600** | **0.0216** | 116,729 | **2,623** | **154** | **34.0** | **743ms / 7 次** |
| 1000×700 | 0.1296 | 116,844 | 15,244 | 50 | 49.9 | 101ms / 2 次 |
| 1200×800 | 0.2376 | 116,511 | 27,882 | 27 | 52.9 | 0 |
| 1400×900 | 0.3456 | 116,741 | 40,444 | 24 | 56.5 | 0 |
| 1920×1080 | 0.6263 | 116,453 | 73,042 | 30 | 58.0 | 0 |

#### 机制（可算术验证）

`scale = 0.0216` 意味着纸张被缩到 926 × 0.0216 ≈ **20 像素宽**。面板为什么这么窄：

```
win 800 → drawer 344（showExport 默认 true）+ workArea 500 → editor/preview 各约 57px
availW = 57 - 36(padding) = 21  →  fitScale = 21/926 = 0.0227  ✓ 与实测 0.0216 吻合
```

于是虚拟化的视口高度计算（`viewportLayoutH = clientHeight / scale`）爆炸：

```
viewportLayoutH = 325 / 0.0216 = 15,046 布局像素
挂载区间 = OVERSCAN(900) + 15,046 + OVERSCAN(900) = 16,846 布局像素
块均高 ≈ 111px  →  需挂载 ≈ 152 块   ✓ 与实测 154 吻合
```

**虚拟化的全部意义就是"只挂视口附近的几十个块"**，而在这里它被迫挂了 154 个 —— 因为缩放到 2% 之后，"可见内容"按布局像素算确实有 1.5 万像素高。这不是虚拟化算错了，是上游的 `fitScale` 允许了一个荒谬的缩放值。

反过来，`scrollHeight` 从 40,444（1400×900）塌到 2,623（800×600），意味着 2 秒的滚动脚本会**把整篇文档从头到尾走一遍**（覆盖率 100%），1151 个块全部经历一次挂载+卸载。

#### 影响判定

- 这是**退化路径**（极端窄面板），不是日常路径：窗口 ≥1200px 时零长任务、fps 52-58。
- 但它**污染了性能结论**：`bench.mjs` 默认就用 800×600，所以它报的 `scrollFps` 一直是这个最坏值。README 的"60.0 fps（最低 56）"与存档基线 `docs/bench-final.json` 的 `avg 60, worst 56.2` 用的是同一套脚本却拿到完全不同的数字，说明**该指标在历史上就不稳定**。
- 同时它也是真实的 UX 缺陷：56px 宽的文档列不是"自适应"，是坏掉。

#### 建议方案（未实施，涉及 UX 取舍）

最小改动是在 `PreviewPane.tsx:245` 给一个下限：

```ts
const fitScale = availW > 0 ? Math.min(1, Math.max(0.25, availW / paperWidth)) : 1;
```

实测效果（800×600，同脚本）：`scale=0.5` 时 **60 fps / 0 长任务**，`scale=1` 时 **60.3 fps / 0 长任务**，对比 `scale=0.02` 的 34-53 fps / 241-792ms 长任务。代价是面板过窄时会出现横向滚动条。

更根本的做法是**不让面板塌掉**（`.work-preview` 加 `min-width`，或窄窗口下把抽屉改成覆盖层）。这属于布局策略变更，需要你决定。

---

### 4.3 【P1，已定位】`measure()` 每轮重读全部 `offsetHeight` → 整纸张强制同步布局

#### 证据链

**① CPU profile**（800×600，滚动 2 秒，`Profiler.setSamplingInterval(100)`）：

```
滚动时长 2103ms · 采样 15329 个 · 间隔 ≈0.14ms

     745.8ms  35.5%  (idle)
     586.2ms  27.9%  get offsetHeight        ← 强制同步布局
     324.2ms  15.4%  get offsetHeight        ← 同上（另一调用点）
     196.2ms   9.3%  (program)
      44.0ms   2.1%  (anonymous)  index-*.js:711
      35.1ms   1.7%  $            react-*.js:9   ← React 协调
      23.7ms   1.1%  removeChild
      22.1ms   1.1%  $
      16.6ms   0.8%  removeChild
```

**`get offsetHeight` 合计 910ms，占 43%。** V8 的采样会把整次布局 flush 记到叶子帧上，所以这 910ms 实际是"因为读 offsetHeight 而被迫做的布局"。

**② 调用计数**（劫持 `HTMLElement.prototype.offsetHeight` 的 getter）：

```
滚动 65 帧 / 2000ms
offsetHeight 读取次数        14,366      ≈ 86 轮（每轮 ≈ 167 个已挂载块）
getBoundingClientRect 次数   335
```

86 轮 × 每轮一次整纸张布局 ≈ 910ms —— 与 profile 完全吻合。

**③ 调用点**（完整调用栈归因）：

```
×11   get offsetHeight ← index:4003 ← index:5978 ← El ← vu ← Lu ← vu ← Lu
      （React commit 的 layout effect → measure() 的循环）
× 1   ResizeObserver
```

`measure()` 在 `PreviewPane.tsx` 里只有两个调用点：`useLayoutEffect`（第 324 行，依赖 `snapshot.revision / range.first / range.last`）与 `scrollToLine()` 的收敛循环（第 412 行，每帧一次、最多 10 帧）。

#### 根因

`measure()`（`PreviewPane.tsx:166-208`）每被调用一次，就遍历**全部**已挂载块：

```ts
const els = host.querySelectorAll<HTMLElement>('.mdp-block');
for (const el of els) {
  const h = el.offsetHeight;                                    // ← 强制布局
  const tag = blocksRef.current.find((b) => b.key === key)?.first || '';  // ← O(块总数) 线性扫描
  ...
}
```

两个问题叠加：

1. **重复测量**：已经量过的块高度不会变（`.mdp-block` 有 `contain: layout style paint`，高度只依赖自身内容 + 纸张宽度 + 字体），下一轮却仍然重读一遍。真正需要量的只有"本轮新挂载的块"。
2. **线性扫描**：`blocksRef.current.find(...)` 在每个块上扫一遍全部 1151 个块 —— 167 × 1151 ≈ 19 万次比较/轮 × 86 轮 ≈ 1600 万次。这是纯粹的浪费（应改为 `key → first` 的 Map）。

而昂贵的不只是读的次数，是**每次读触发的那一次布局 flush**：`applyPads()` 刚写过占位块高度 → 布局失效 → 紧接着 `offsetHeight` 把整张 926 × 116,729 的纸重新布局一遍。

#### 建议方案（未实施）

按收益排序，三条互不冲突：

1. **只量新块**：维护 `measuredKeys: Set<string>`，`measure()` 里 `if (measuredKeys.has(key)) continue;`。纸张宽度 / 主题 / 字体变化时清空该 Set（这些是唯一能让已量块高度变化的条件，可挂在 `paperWidth`、`css`、`document.fonts.ready` 上）。
2. **`find` 换 Map**：`rebuild()` 里顺手建 `keyFirst = new Map(blocks.map(b => [b.key, b.first]))`。
3. **合并同帧多次 measure**：在 layout effect 里用一个 `pendingMeasure` 标志 + rAF 合并，避免一次提交内多轮 flush。

> 保守估计：改动 1 单独就能把滚动期间的 layout 轮数从 86 降到"本轮新挂载块数"（个位数），即 910ms → 百毫秒量级。改动本身不触碰差量协议与虚拟化逻辑，风险低，但需要重跑 `verify:preview` / `verify:scrollmap` / `verify:sync` 三套断言（它们对块高与 `data-lines` 敏感）。

---

### 4.4 【P2，已修复】`.gitignore` 残留合并冲突

文件里带着未解决的冲突标记，一侧是本项目的忽略规则，另一侧是一段 **Dynamics 365 Business Central（AL 语言）模板**（`.alcache/`、`*.app`、`rad.json`、`*.bclicense`…），显然是 `f3b3c69` 那次提交误带进来的。

保留本项目规则、删掉 AL 模板与冲突标记。已重新读取确认。（效果：`.vscode/`、`*.app` 等无关忽略项不再生效。）

---

### 4.5 【P2，已修复】`bench.mjs` 的滚动帧率不可复现

`scrollFps` 的测量方式是"在 2 秒内把 `scrollTop` 从 0 线性推到 `scrollHeight - clientHeight`"，而 `scrollHeight` 由 `scale` 决定（§4.2）。同一个脚本在 800×600 与 1400×900 下测的**根本不是同一件事**。

已做两处改动（默认行为不变）：

1. 新增 `--viewport WxH`，`page.init()` 后立刻 `setViewport`。
2. 结果 JSON 里写入 `viewport` 字段 —— 不记尺寸的两个 JSON 之间没有可比性。
3. 文件头的用法说明里写清了这个陷阱。

复现：

```sh
node scripts/bench.mjs                     # 800x600（历史基线口径）
node scripts/bench.mjs --viewport 1400x900 # 正常窗口
```

---

### 4.6 【P2】README 与实测不符（4 处）

| README | 实测 | 说明 |
|:--|:--|:--|
| :557 「偏移稳定在 **8px**」 | `verify:sync` 实测 **-17 ~ -41px** | 断言本身是"往返误差 ≤ 3 行"，像素偏移没有阈值；8px 这个数字在当前代码上不成立 |
| :592 「预览滚动帧率 **60.0 fps**（最低 56）」 | 多轮实跑未能复现：800×600 得 35.1，1400×900 得 55.7 | 与存档基线 `bench-final.json`(60) 同脚本不同果，见 §4.2 |
| :282 「**7 个**自检套件」 | 实际 **11 个** `verify*.mjs` | 新增了 preview/scrollmap/persist/cancel 四个 |
| :581 「再用 **Long Animation Frame** 把每帧拆成 script / style+layout / render」 | `bench.mjs` 里没有任何 `PerformanceObserver` / LoAF 代码 | 描述的是没实现的测量方法 |
| :600 「dist 总体积 **2909 KB / 139 文件**」 | 实测 140 文件 / 3495 KB（`du` 3768 KB） | 首屏 1192 KB（gzip≈334 KB）与 README 的 1360 KB 也对不上 |

> 注：第 2 行不是"代码变慢了"，而是**指标本身没有被固定**。README 的 60fps 与本次的 35fps 很可能都是真实测量，只是窗口几何不同。建议在写进 README 时同时标注数据来源的窗口尺寸与抽屉开合状态。

### 4.7 【P3】其它

- **`--page` 不在帮助表**：`bin/mdp.mjs:82` 解析 `--page`、`:628` 会向下传，但它既不在 `FLAG_HELP` 也不在 build 的 `flags` 里，`mdp help build --all` 看不到它（56 个参数里没有）。
- **`notices` 无人消费**：`caps.mjs:231-235` 生产 `notices`，但 `server.mjs:117` 只把它当占位返回空数组，409/202 响应只带 `blockers`。前端拿不到这个字段。
- **补全脚本陈旧**：`completions/_md2pdf:80` 仍建议 `(doctor list init-config)`，而 `init-config` 已不在 `COMMANDS` 表里；新增的 `serve/build/routes/themes/clean/help` 与别名（`ls`/`check`/`cleanup`）都没进补全。
- **`verify:vim` 有 1 项"待人工确认"**：宏回放（`q` 录制 + `@` 回放）在合成按键下不进待回放状态，脚本自己标注了"独立诊断中同样的最小序列回放成功，真人键盘操作不受影响"。这类"测试环境限制"应显式标注而不是算通过 —— 它已经这么做了，只是别让它在整体绿里被忽略。

---

## 5. 性能实测汇总

### 5.1 两套视口对照（`bench.mjs`，10 万字符，30 次按键采样）

| 指标 | 800×600（历史基线口径） | 1400×900（正常使用） |
|:--|--:|--:|
| boot（导航 → 界面可用） | 200 ms | 190 ms |
| loadDoc（载入 10 万字符 → 可交互） | 283 ms | 151 ms |
| renderFull p50（全量渲染） | 74.6 ms（p95 98.3） | 74.8 ms（p95 94） |
| **typeLat p50（逐键 → 下一帧）** | **28.9 ms**（p95 86 / max 105）**>2 帧** | **24.4 ms**（p95 25.6 / max 31.5）**≈2 帧** |
| **scrollFps 均值（最低）** | **35.1 fps（6.3）** | **55.7 fps（22.9）** |
| exportPng（300 DPI） | 1037 ms · 2953×16719 · 2352 KB | 1091 ms · 同 |
| exportPdf | 3659 ms · 59 KB | 3265 ms · 59 KB |
| bundle | 140 文件 · 首屏 1192 KB（gzip≈334）· 全部 3495 KB · 字体 250 KB | 同 |

### 5.2 与 README / 存档基线的对比

| 指标 | README 声称 | 存档基线(2026-09-18) | **本次实测** | 判断 |
|:--|--:|--:|--:|:--|
| 逐键延迟 p50 | 41.2 ms | 41.0 ms | **24.4 ~ 28.9 ms** | **优于**声称值 |
| 全量渲染 p50 | 136–161 ms | 96.4~140.6 ms | **74.6 ~ 74.8 ms** | **优于**声称值 |
| 冷启动 | 283–330 ms | 295~1385 ms | **190 ~ 200 ms** | 优于 |
| 预览滚动帧率 | 60.0 fps | 60.0 fps | **35.1 / 55.7 fps** | **未复现**，见 §4.2 |
| 导出声称耗时 | — | PNG 1234~1850ms / PDF 3827~6046ms | PNG 1037~1091ms / PDF 3265~3659ms | 优于 |

**逐键延迟比宣传的更好**，这一点值得更新到 README。滚动帧率则相反 —— 但根因是窗口几何而非渲染管线退化，需要与 4.2 的建议一起修。

### 5.3 环境对测量的影响（重要caveat）

所有 fps 数字来自 **SwiftShader 软件光栅**（无 GPU、无真实 display，`CVDisplayLinkCreateWithCGDisplay failed`）。作为对照，同一浏览器里滚动一个空白 overlay 可以稳定跑到 **60 fps / 0 长任务**，说明"60fps"这个上限在该环境下是可达的、数字有区分度；但绝对 fps 不能直接外推到有 GPU 的真机。**本次所有结论都建立在"同环境内部对照"上**（空白 overlay vs 预览、z-fit vs z-100、800×600 vs 1400×900），而不是绝对数值。

---

## 6. 建议的后续动作（按优先级）

| 优先级 | 动作 | 涉及文件 | 风险 |
|:--|:--|:--|:--|
| **P0** | 已修复：md2pdf 预检 | `server/caps.mjs` | — |
| **P1** | `measure()` 只量新块 + `find`→Map + 同帧合并 | `web/src/components/PreviewPane.tsx` | 中（需重跑 preview/scrollmap/sync 三套） |
| **P1** | 给 `fitScale` 加下限，或给 `.work-preview` 加 `min-width` | `PreviewPane.tsx:245` / `styles.css` | 低～中（UX 取舍） |
| **P2** | README 数字校准（§4.6 五处）+ 补上"窗口尺寸"这个前提 | `README.md` | 低 |
| **P2** | 把 800×600 这种"面板塌掉"的场景做成一条自检断言 | `scripts/verify-*.mjs` | 低 |
| **P3** | 补全脚本重写、`--page` 进帮助表、接上 `notices` | `completions/`、`bin/mdp.mjs`、`server/server.mjs` | 低 |
| **P3** | `findChrome()` 的 `kind` 按实际二进制判定 | `server/chrome.mjs:69` | 低 |

**关于"护栏是否够用"**：本次的 P0 缺陷（§4.1）**所有 11 个自检套件都没有抓到**。原因是自检与基准都绕过了 HTTP 层直接调 `executeRender` —— 预检是 HTTP 层独有的。建议补一个"逐路线 POST `/api/render` 断言不是 409"的冒烟用例，这是当前整套护栏里唯一的系统性盲区。

---

## 7. 复现方式

```sh
# 唯一前置：指定本地内核
export MDP_CHROME=/Users/fubin/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell

# 1) 全量自检（11 套）
npm run verify:all

# 2) 性能基准（务必两个视口都跑，并对比同一视口的历史 JSON）
node scripts/bench.mjs                       # 800x600
node scripts/bench.mjs --viewport 1400x900   # 正常窗口

# 3) 端到端导出冒烟（本次发现 P0 靠的就是它）
node --input-type=module -e '
  const { startServer } = await import("./server/server.mjs");
  const srv = await startServer({ port: 0, quiet: true, warmup: false, concurrency: 2, log: () => {} });
  for (const t of ["png","pdf","tex","docx"]) {
    const r = await fetch(srv.url + "/api/render-sync?target=" + t, { method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({ content: "# 探针\n\n$$x^2$$\n", filename: "probe-" + t }) });
    const b = Buffer.from(await r.arrayBuffer());
    console.log(t, r.status, b.length, JSON.stringify(b.subarray(0,4).toString("latin1")));
  }
  process.exit(0);'
```

### 本次新增的诊断脚本（均在 `.artifacts/`，已被 `.gitignore` 忽略）

| 脚本 | 用途 |
|:--|:--|
| `diag-scrollfps.mjs` | 滚动帧率的三组对照（空白 overlay / 预览 / 编辑器） |
| `diag-profile.mjs` | CDP `Profiler` 采样滚动热路径，按函数聚合 self time |
| `diag-measure.mjs` | 劫持 `offsetHeight` getter，统计强制同步布局轮数与调用栈 |
| `diag-callers.mjs` | 完整调用栈归因 + z-fit/z-100/同步开关三配置对照 |
| `diag-geometry.mjs` | 打印预览几何真值（scale / 纸张高 / 占位块 / 高度表覆盖率） |
| `diag-isolate.mjs` | 缩放 vs 内容的隔离实验 + 文档规模扫描 |
| `diag-viewport.mjs` | 视口扫描，产出 §4.2 的主表 |

---

## 附录 A：本次改动的文件清单

```
M server/caps.mjs            md2pdf 预检改读 checks 表（P0 修复）
M scripts/bench.mjs          新增 --viewport；结果 JSON 记录窗口尺寸
M .gitignore                 清除合并冲突标记与误入的 AL 模板
A docs/technical-report.md   本报告
A .artifacts/diag-*.mjs      7 个诊断脚本（gitignore 覆盖）
```

## 附录 B：讨论中的两点观察

1. **`content-visibility` 与虚拟化是互斥的两条路线**，README 与架构描述把它们说成"同时生效"，实际是 `VIRTUAL_MIN_BLOCKS=60` 为界二选一（`theme.mjs:226-246`）。这个设计本身是合理的（两者同时生效反而会让"测到的高度"与最终高度不一致），但**描述需要更正**。

2. **`verify:preview` 的"逐字节相同"是全项目最有价值的一条护栏**。它把"增量渲染"这个最容易悄悄退化的部分钉死成了可证伪的命题（实测 3598KB 完全一致、1150/1153 保号）。本次 P0 缺陷能溜过所有套件，恰恰是因为它不在这些套件的覆盖范围内（HTTP 层），而不是因为这些套件不够严。
