# MDP Studio 核心实现走读（源码展示版）

本文只挑**最吃性能、最需要优化、最能提升体感**的那部分实现，代码为逐字复制（保留原文注释）。
每节末尾给出 **优点** 与 **配合性**（它和别的模块怎么咬合、动它会伤到什么）。

三条链路贯穿全文：

```
① 打字热路径   CodeMirror ──► content.ts 外部 store ──► Worker 增量渲染
                 └────────► 差量协议 ──► 块级贴 DOM ──► 虚拟化 ──► 滚动锚定

② 导出热路径   同一份 markdown.mjs/theme.mjs ──► 导出 HTML ──► CDP ──► 真 DPI PNG
                                        └────► pandoc + XeLaTeX ──► 打印级 PDF

③ 内核热路径   md2pdf.sh ──► 惰性依赖解析 ──► 缓存签名 ──► pandoc ──► 栅格化回退链
                  └────► -j 滑动窗口 / -w 内核事件
```

---

# 一、内核：`md2pdf`（POSIX sh）

内核的全部价值集中在两件事：**每次调用少付一点固定成本**，以及**失败时优雅降级而不是罢工**。

## 1.1 惰性依赖解析：把 31ms 从每一次调用里拿掉

这是本次改造中**单项收益最大**的一处。原实现在 `main` 一进来就无条件解析 pandoc：

```sh
find_pandoc() {
    have pandoc || die "未找到 pandoc。安装: brew install pandoc" 2
    PANDOC=$(command -v pandoc)
    PANDOC_VER=$("$PANDOC" --version 2>/dev/null | head -1 | awk '{print $2}')
    [ -n "$PANDOC_VER" ] || PANDOC_VER='?'
}
```

关键在第三行：`pandoc --version` 会**真的启动一次 pandoc 进程**，实测 31.2ms。
而它拿到的版本号在这一整条渲染路径上**谁也没用** —— 签名里没有它，渲染只用 `$PANDOC` 这个路径。

改造后拆成两层：

```sh
# 惰性解析 pandoc。曾经 main 一进来就无条件 find_pandoc，于是**每一次**调用
# （包括"源文件没变、直接跳过"的那次）都要付一次完整的 pandoc 进程启动：
# 实测 31ms，占缓存命中端到端 62.6ms 的一半，也是 `md2pdf list` 要 48ms 的原因。
# 而缓存判定（mtime + 签名哈希）根本不需要 pandoc，签名里也没有 PANDOC_VER。
#
# 再拆一层：渲染路径只需要**可执行文件路径**，版本号只有"打印给人看"的地方要
# （list / doctor）。两者合在一起的话，每渲染一次文档都要多付一次 pandoc 进程
# 启动去问版本 —— 而那个版本号在这一整条路径上谁也没用。
ensure_pandoc() {
    [ -n "$PANDOC" ] && return 0
    have pandoc || die "未找到 pandoc。安装: brew install pandoc" 2
    PANDOC=$(command -v pandoc)
}

ensure_pandoc_version() {
    ensure_pandoc
    [ -n "$PANDOC_VER" ] && return 0
    PANDOC_VER=$("$PANDOC" --version 2>/dev/null | head -1 | awk '{print $2}')
    [ -n "$PANDOC_VER" ] || PANDOC_VER='?'
}
```

调用点收敛成三处，各自只索取自己真正需要的：

```sh
cmd_list() {
    ensure_pandoc_version  # list 要显示 pandoc 版本，这里才真正需要它
    …
}

build_and_run() {
    …
    ensure_pandoc          # 真正要渲染了才解析 pandoc（干跑/缓存命中都不走这里）
    dbg "pandoc $*"
    _errf=$(mktemp "${TMPDIR:-/tmp}/md2pdf-err.XXXXXX")
    "$PANDOC" "$@" 2>"$_errf"
```

**实测（同一台机器、同一份文档、PATH 打桩计数）**

| 指标 | 改造前 | 改造后 |
|:--|--:|--:|
| 渲染路径上 pandoc 被拉起次数 | 2 次（多一次版本探测） | **1 次** |
| 命令 → pandoc 真正拉起 | 79 ms | **35 ms** |
| 缓存命中端到端 | 65.4 ms | **23.6 ms** |

**优点**：把"每次都要付"的成本变成"用到了才付"。惰性化的对象不是探测函数（那些是 `command -v` 内建，单次 0.043ms），而是**真正 fork 进程的那一处**。

**配合性**：
- 缓存判定（`convert_one` 的 mtime + 签名）在 `build_and_run` 之前，因此**完全不经过** pandoc；
- `cmd_list` / `cmd_doctor` 仍要版本号，所以保留 `ensure_pandoc_version`，没有把功能削掉；
- 干跑（`-n`）在 `ensure_pandoc` **之前**返回，所以没有 pandoc 的机器也能看命令预览。

---

## 1.2 缓存签名：缓存键必须覆盖所有会改变产物的输入

缓存命中是"零感"体验的来源，但缓存键漏项的后果不是慢，是**发出陈旧产物**——用户改了一个选项，程序却说"未变更"，把上一版发给他。

```sh
# 缓存签名：**凡是会改变产物的输入都必须进来**。
# 漏一项的后果不是"慢"，是"发陈旧产物"：改了这个参数、产物却因为签名没变而被
# 判定为"未变更"，用户拿到的是上一版。之前漏了 --template / -H / --css /
# --bibliography / --csl / --lang / --toc-title / --colorlinks / --metadata-file /
# --resource-path 以及 --page（换页号不重建，直接发第 1 页）。
# 注意：改动本函数的输出格式会让已有的 .sig 全部失配 → 升级后第一次运行会全量重建一次。
signature() {
    # 用拼接而不是一长串 %s：参数有 33 个，格式串里少写一个 %s 不会报错，
    # 只会让 printf 把格式串循环复用、把某个字段悄悄挤掉 —— 那种错没人看得出来。
    _sig="$VERSION|$QUALITY|$ENGINE|$TO|$FONTSIZE|$MARGIN|$LINESTRETCH"
    _sig="$_sig|$MAIN_FONT|$RESOLVED_CJK|$USE_CJK_VAR|$MONO_FONT|$HIGHLIGHT"
    _sig="$_sig|$TOC|$TOCDEPTH|$NUMBERS|$DOCCLASS|$CLASSON|$USER_ARGS"
    _sig="$_sig|$PNG_MODE|$PNG_DPI|$PNG_TRANSPARENT|$PNG_PAGE"
    _sig="$_sig|$COLORLINKS|$O_TEMPLATE|$O_TOC_TITLE|$O_LANG"
    _sig="$_sig|$INCLUDE|$O_INCLUDE|$O_CSS|$O_BIB|$O_CSL"
    _sig="$_sig|$O_METADATA_FILE|$O_RESOURCE_PATH"
    printf '%s' "$_sig" | hash_str
}
```

**优点**：
- 第一行注释把"缓存键漏项"的后果写死在代码里，防止后人再删；
- 放弃 `printf '%s|%s|…'` 的 33 元格式串，改用拼接——**少写一个 `%s` 不会报错**，只会让 printf 循环复用格式串把某个字段悄悄挤掉，这类错误无法用肉眼发现。

**配合性**：`signature()` 的输出被写进 `$SIG_CACHE_DIR/<产物路径哈希>.sig`；`convert_one` 读它比对。
改动签名格式 = 已有 `.sig` 全部失配 = 升级后第一次运行全量重建一次（可接受，且已在注释里说明）。

---

## 1.3 零 fork 的缓存探测路径

缓存命中路径的每一毫秒都是"用户已经按了回车却发现还没退出提示符"的感受。这里把该路径上的 fork 一个一个拿掉：

```sh
pick_cache_dir() {
    # 第一个候选命中时不该付任何代价：老写法把 "$(id -u)" 写在 for 的列表里，
    # **每次运行都会被求值**（2.2ms 一次 fork），哪怕第一个目录本来就能用；
    # 而且总是先 mkdir -p（再 1.6ms），哪怕目录早就存在。
    # [ -d ] / [ -w ] 是 shell 内建，命中路径因此变成零 fork。
    if [ -n "${SIG_CACHE_DIR:-}" ]; then
        if [ -d "$SIG_CACHE_DIR" ] && [ -w "$SIG_CACHE_DIR" ]; then
            printf '%s\n' "$SIG_CACHE_DIR"; return 0
        fi
        if mkdir -p "$SIG_CACHE_DIR" 2>/dev/null && [ -w "$SIG_CACHE_DIR" ]; then
            printf '%s\n' "$SIG_CACHE_DIR"; return 0
        fi
    fi
    _fallback=${TMPDIR:-/tmp}/md2pdf-cache-$(id -u 2>/dev/null || echo 0)
    if mkdir -p "$_fallback" 2>/dev/null && [ -w "$_fallback" ]; then
        printf '%s\n' "$_fallback"; return 0
    fi
    printf '\n'
}
```

```sh
    if [ -n "$SIG_CACHE_DIR" ] && [ "$FORCE" != 1 ] && [ "$DRY" != 1 ] \
       && [ -f "$_out" ] && [ "$_out" -nt "$_in" ]; then
        _sigf=$SIG_CACHE_DIR/$(printf '%s' "$_out" | hash_str).sig
        # 用 read 内建代替 $(cat)：省一个进程。签名是单行的，语义等价。
        _stored=''
        [ -f "$_sigf" ] && IFS= read -r _stored < "$_sigf"
        if [ "$_stored" = "$(signature)" ]; then
            note "${C_D}跳过(未变更)${C_0} $_out"
            return 0
        fi
    fi
```

同一节里还修掉一个**边界 bug**（HEAD 版同样存在）：

```sh
convert_one() {
    _in=$1
    _out=$(out_for "$_in")
    # 输出名没有目录部分时（`-o out.pdf`），${_out%/*} 会原样返回文件名本身 ——
    # 于是 mkdir 建出一个**同名目录**，紧接着 mv 把产物搬进那个目录里，
    # 还对着一份不存在于指定路径的产物打印"✓"。out_for 里早就处理了这个边界
    # （`[ "$_d" = "$_in" ] && _d=.`），这里漏了。
    _dir=${_out%/*}
    [ "$_dir" = "$_out" ] && _dir=.
    [ -d "$_dir" ] || mkdir -p "$_dir" || { err "无法创建目录 $_dir"; return 1; }
```

**优点**：`[ -d ]` / `[ -w ]` / `read` 都是 shell 内建；把"先建目录再判断"改成"先判断再建"，命中路径上的 fork 数归零。而 `${_out%/*}` 的边界处理与 `out_for` 内部保持同一套约定，避免同类 bug 二次出现。

**配合性**：
- `SIG_CACHE_DIR` 现在**允许外部指定**（本次同时修掉了无条件覆盖的问题，`bin/mdp.mjs` 会传 `<项目>/.cache/md2pdf`，以前这个意图从来没生效）；
- `.sig` 文件是缓存唯一的持久状态，删掉即可安全重建。

---

## 1.4 栅格化回退链：真 DPI 与"诚实降级"

这是一处**静默质量事故**的修复现场。先看现在的代码：

```sh
rasterize_pdf() {   # $1 = 输入 PDF   $2 = 输出 PNG
    _rpdf=$1; _rpng=$2
    _dpi=${PNG_DPI:-200}; _page=${PNG_PAGE:-1}
    _base=${_rpng%.png}
    _extra=''
    [ "$PNG_TRANSPARENT" = 1 ] && _extra='-transp'

    if have pdftoppm; then
        if pdftoppm -png -r "$_dpi" -f "$_page" -l "$_page" $_extra -singlefile "$_rpdf" "$_base" 2>/dev/null && [ -s "$_rpng" ]; then
            RASTER_TOOL=pdftoppm; return 0
        fi
    fi
    …
    if have gs; then
        _dev=png16m; [ "$PNG_TRANSPARENT" = 1 ] && _dev=pngalpha
        # -r 的分辨率必须**贴着写**（-r200）。Ghostscript 10 起对 "-r 200"
        # 直接报错 `-r must be followed by <res>`：写了空格就 exit=1、不产出文件，
        # 于是这里静默失败、一路掉到最后的 sips 降级 —— 用户明明装了能出真 DPI 的
        # gs，却拿到 72dpi 放大图，还被提示去装 poppler。贴着写在新旧版本上都合法。
        if gs -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=$_dev -r"$_dpi" \
              -dFirstPage="$_page" -dLastPage="$_page" \
              -dTextAlphaBits=4 -dGraphicsAlphaBits=4 \
              -sOutputFile="$_rpng" "$_rpdf" 2>/dev/null && [ -s "$_rpng" ]; then
            RASTER_TOOL=gs; return 0
        fi
    fi
    …
    if have sips; then
        if sips -s format png "$_rpdf" --out "$_rpng" >/dev/null 2>&1 && [ -s "$_rpng" ]; then
            _w=$(sips -g pixelWidth "$_rpng" 2>/dev/null | awk '/pixelWidth/{print $2}')
            case $_w in ''|*[!0-9]*) _w=0 ;; esac
            if [ "$_w" -gt 0 ]; then
                _want=$(( _w * _dpi / 72 ))
                [ "$_want" -gt "$_w" ] && sips --resampleWidth "$_want" "$_rpng" >/dev/null 2>&1
            fi
            RASTER_TOOL=sips
            warn "PNG 使用 macOS 内置 sips 降级渲染（72dpi 放大），文字边缘会偏软"
            warn "如需真正高清：brew install poppler   然后重新运行"
            return 0
        fi
    fi
```

**事故链条**：`-r "$_dpi"` 在 Ghostscript ≥10 上直接 `exit=1` 且不产出文件 → 回退链继续往下 →
最终落到 `sips` → 输出 72dpi 位图放大 → 打印"文字边缘会偏软"并**建议用户去装 poppler**（而用户其实已经装了能出真 DPI 的 gs）。

**实测对照（同一份 A4 文档，同样 200 DPI）**

| 路径 | 像素 | 字节 |
|:--|:--|--:|
| 修复后 gs | 1654×2339（正好 A4@200dpi） | **20,430** |
| sips 降级 | 1653×2339 | **78,249** |

同尺寸下 3.8 倍字节 = 位图放大的模糊。

**优点**：
- 回退链**本身**就是"优雅降级"的正确形态（每一档都判 `$?` 与 `[ -s ]`，前一档失败继续下一档）；
- 降级时**如实告知**并把质量损失说清楚，而不是默默变糊。

**配合性**：
- 同一份工具优先级与 `server/raster.mjs` 保持一致（pdftoppm > pdftocairo > gs > mutool > sips），CLI 与网页导出的结果因此可预期地一致；
- Node 侧有**同一个 bug 的副本**（`'-r', String(d)` 与 `'-sDEVICE', 'png16m'` 分开传 argv），已同步修复——见 §2.4。

---

## 1.5 滑动窗口并发：不让槽位空转

```sh
    _sd=$(mktemp -d "${TMPDIR:-/tmp}/md2pdf-jobs.XXXXXX")
    # 滑动窗口而不是"批次屏障"。
    # 老写法是 `[ "$_run" -ge "$JOBS" ] && { wait; _run=0; }` —— 无参 wait 等的是
    # **全部**子进程，于是每凑满 JOBS 个就整体停一次：一批里只要有一个慢文件，
    # 同批其余已经跑完的槽位也一起空等。文件耗时越不均匀，浪费越大。
    # 现在改成 FIFO 完成信道：每完成一个就放行下一个，槽位不空转。
    # 用 FIFO 而不是管道，是为了让 convert_one 仍然跑在自己的子 shell 里
    # （管道会让循环体整体落进一个子 shell，PID 与退出码就不好收了）。
    _fifo=$_sd/done
    if mkfifo "$_fifo" 2>/dev/null; then
        exec 9<> "$_fifo"                      # 常驻读写端：写端退出也不会 EOF
        _i=0; _run=0
        _oldifs=$IFS; IFS=$NL
        for _f in $INPUTS; do
            _i=$((_i + 1))
            ( convert_one "$_f"; printf '%s' "$?" > "$_sd/$_i"; printf '\n' >&9 ) &
            _run=$((_run + 1))
            if [ "$_run" -ge "$JOBS" ]; then
                # 阻塞到"任意一个"完成即可，不等整批
                IFS= read -r _tok <&9
                _run=$((_run - 1))
            fi
        done
        IFS=$_oldifs
        wait
        exec 9>&-
    else
        # mkfifo 不可用（极少数文件系统）→ 退回原来的批次屏障，行为正确但慢一些
        warn "无法创建 FIFO，并发退回批次模式"
```

**优点**：POSIX sh 没有 `wait -n`（bash 4.3+ 才有），FIFO 完成信道是**唯一**能做到"任意一个完成就放行"的可移植办法；`exec 9<>`（读写打开）保证写端退出也不会 EOF，循环不会空转。

**实测（2 慢 + 6 快，`-j 4`）**：13.0s → **11.3s**；并发峰值 pandoc ≤ 4（上限守住）；无临时目录残留。

**配合性**：`bin/mdp.mjs` 以前**不转发** `-j`，LaTeX 路线实际是串行的（帮助里却写着"多文件并发数"）；现已转发，两侧并发语义才真正接通。

---

## 1.6 watch：内核事件 + 突发合并 + 整组 kill-and-restart

```sh
# 收掉上一次编译 —— **连它的整个进程组**。
# 为什么必须动进程组：pandoc 自己会拉起 xelatex，只杀外面那层 shell 的话子进程会
# 变成孤儿继续跑（实测：杀掉 wrapper 后 leaf 仍然活着）。高频保存时这正是"同时拉起
# 几十个 xelatex 把内存打爆"的来源。set -m 让每个后台任务独占一个进程组
# （sh 下实测 pgid == pid），于是可以整组发信号。
watch_kill_running() {
    [ -n "${_WATCH_CPID:-}" ] || return 0
    kill -TERM -"$_WATCH_CPID" 2>/dev/null || kill -TERM "$_WATCH_CPID" 2>/dev/null
    sleep 0.2                                   # 给 LaTeX 一点时间自己收拾临时文件
    kill -KILL -"$_WATCH_CPID" 2>/dev/null
    wait "$_WATCH_CPID" 2>/dev/null             # 回收，别留僵尸
    _WATCH_CPID=''
}
```

```sh
# 首选：内核文件事件（fswatch）。OS 层直接推事件，毫秒级，且不轮询。
# 用 FIFO 而不是管道把事件接进**当前 shell**：若是 `fswatch | while read`，
# 循环体跑在子 shell 里，编译的后台 PID 与 trap 都落在外层，无法干净收尾。
watch_events_fswatch() {
    _WATCH_DIR=$(mktemp -d "${TMPDIR:-/tmp}/md2pdf-watch.XXXXXX") || return 1
    _wfifo=$_WATCH_DIR/events
    mkfifo "$_wfifo" 2>/dev/null || { rm -rf "$_WATCH_DIR"; _WATCH_DIR=''; return 1; }
    exec 8<> "$_wfifo"                     # 常驻读写端：写端退出也不会 EOF，循环不会空转
    _WATCH_FD8=1
    # -o：按事件批次输出一行；-l：合并突发（编辑器一次保存往往触发多个事件）
    fswatch -o -l "$WATCH_LATENCY" -- "$INPUTS" > "$_wfifo" 2>/dev/null &
    _WATCH_FPID=$!
    while IFS= read -r _ev <&8; do watch_compile; done
    watch_teardown
    return 0
}
```

```sh
# 收摊：编译、事件源、FIFO、临时目录都要清干净。
# 漏掉 fswatch 的后果实测过：Ctrl-C 之后它还在后台跑，一直占着 inotify/FSEvents
# 的订阅不放（下次再开 watch 就会有两个 watcher 抢事件）。
watch_teardown() {
    watch_kill_running
    if [ -n "${_WATCH_FPID:-}" ]; then
        kill "$_WATCH_FPID" 2>/dev/null
        wait "$_WATCH_FPID" 2>/dev/null
        _WATCH_FPID=''
    fi
    # 只在真的开过 fd 8 时才关：exec 是特殊内建，重定向失败在非交互 shell 里
    # 会直接把整个脚本带走，不能裸写 exec 8>&-。
    if [ -n "${_WATCH_FD8:-}" ]; then exec 8>&-; _WATCH_FD8=''; fi
    [ -n "${_WATCH_DIR:-}" ] && rm -rf "$_WATCH_DIR"
    _WATCH_DIR=''
}
```

**实测（50ms 写一次、连写 60 次，约 3 倍人类极限）**

```
峰值 xelatex=1  pandoc=1        ← 不堆积
停止 1 秒后   xelatex=0  pandoc=0  ← 负载归零
最终产物 == 同内容独立编译（光栅化后逐字节一致，6582B vs 6582B）
```

**优点**：
- 有 fswatch 时走内核事件（毫秒级、零轮询），没有时退回轮询（默认间隔从 1s 调到 0.3s），**两条路都可用**；
- kill-and-restart 是按**进程组**做的，这是"不攒 xelatex"的关键；
- 退出的清理由同一个 `watch_teardown` 负责，trap 与正常收尾走同一条路径。

**配合性**：`SIGINT` 对**后台启动**的 shell 是被忽略的（POSIX 规定，`trap` 改不动），所以脚本化测试要用 `SIGTERM`——这是测试方的坑，不是脚本的坑，已写进自检注释。

---

# 二、后端：零运行时依赖的 Node

## 2.1 手写 CDP：不引 puppeteer/playwright

```js
class CdpConnection {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Map(); this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) for (const cb of [...cbs]) cb(msg.params, msg.sessionId);
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }
```

真 DPI 截图（而不是"放大了的位图"）：

```js
  async screenshot({ x, y, width, height, dsf = 1 }) {
    // 先按目标像素尺寸把视口撑开，避免 captureBeyondViewport 在超长页面上被裁切
    await this.setViewport(width, Math.min(Math.max(height, 1), 60000), dsf);
    await this.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', { awaitPromise: true });
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      optimizeForSpeed: false,
      clip: { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(1, width), height: Math.max(1, height), scale: 1 },
    });
    const buf = Buffer.from(data, 'base64');
    // deviceScaleFactor 由 Emulation 负责，这里校验一下产出像素是否与 dpi 一致
    return { buffer: buf, pixelRatio: dsf };
  }
```

启动参数里有一处**故意不写**的开关：

```js
const LAUNCH_ARGS = [
  '--headless',
  // 本机 / CI / 容器中 Chromium 自带的沙箱常常无法初始化（"sandbox initialization
  // failed: Operation not permitted"，随后 GPU 进程 FATAL 退出）。它只加载我们
  // 自己生成的本地页面，因此关闭 Chromium 沙箱是安全且必要的。
  '--no-sandbox',
  // 注意：这里**不**加 --disable-gpu / --disable-gpu-sandbox /
  // --disable-software-rasterizer。实测（scripts/bench.mjs，10 万字符文档）这些
  // 开关把每帧的 blocking 时间从数十毫秒推到 300~400ms：光栅化退化成纯 CPU 慢
  // 路径，测出来的交互延迟完全失真。保留默认光栅化不影响截图正确性。
  '--disable-dev-shm-usage',
  …
];
```

**优点**：`dependencies` 里只有 markdown-it / katex / highlight.js；CDP 驱动完全建立在
Node ≥22 的内置全局 `WebSocket` 上。npm 装坏了后台照样能渲染。

**配合性**：`ChromePool` 懒启动 + 空闲自杀 + 从 `DevToolsActivePort` 读端口；`ChromePage.screenshot` 的
`clip` 与 `shared/theme.mjs` 生成的导出页 CSS 由同一组参数驱动，所以"导出所见"与"预览所见"是同一个版面。

## 2.2 取消语义：为什么"杀掉浏览器"是唯一解

```js
/**
 * CDP 的 Page.captureScreenshot / printToPDF 一旦发出**没有取消消息**：
 * 唯一能在半路停下的办法是把浏览器进程干掉 —— 连接一断，所有 pending 的 CDP
 * 请求立刻 reject（见 chrome.mjs 的 ws 'close' 处理）。
 *
 * 代价：这次浏览器实例作废，下一次渲染会自己重新拉起（chromePool.ensure() 会
 * 发现 cdp 已关闭并重启）。收益：用户点「取消」时立刻停住一个正跑在 10 万字
 * 文档上的截图，而不是干等十几秒 —— 取消的意义全在这里。
 */
async function abortable(signal, pool, log, fn) {
  if (!signal) return fn();
  if (signal.aborted) throw abortError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      log?.('warn', '取消已生效：终止 Chromium 会话（下次渲染会自动重启）');
      Promise.resolve(pool?.close?.()).catch(() => {});
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([fn(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
```

**实测**：600 DPI / 27 万 CSS px 的截图，取消在 **158ms** 内结束，且**没有留下孤儿子进程**。

**配合性**：LaTeX 路线是另一套取消机制（`run(..., {signal})` 给子进程发 SIGTERM，逐工具透传），
两条路共用同一个 `AbortSignal`（来自 `JobManager` 的 `job.abort`）。

## 2.3 按路线判定依赖：不让无关依赖拦死整条路

```js
const ROUTE_DEPS = {
  // HTML 路线：只依赖 Chromium
  png: { chrome: true },
  html: { chrome: true },
  'pdf-html': { chrome: true },
  // LaTeX 路线：pandoc + md2pdf 脚本（+ LaTeX 引擎，见下）
  pdf: { pandoc: true, md2pdf: true, latex: true },
  tex: { pandoc: true, md2pdf: true },
  docx: { pandoc: true, md2pdf: true },
  md: { pandoc: true, md2pdf: true },
  'png-latex': { pandoc: true, md2pdf: true, latex: true },
};
```

```js
  for (const dep of Object.keys(DEP_META)) {
    if (!deps[dep]) continue;
    const ok = dep === 'pandoc' ? caps.engines.pandoc.found
      // md2pdf 的可用性只存在于 checks 表里（缓存对象上没有 md2pdf 字段）。
      // 曾经写成 Boolean(caps.md2pdf) → 恒为 false → 凡是声明了 md2pdf 的路线
      // （pdf / tex / docx / md / png-latex）全部被 409 拦死，而 doctor 却显示 ok。
      : dep === 'md2pdf' ? caps.checks.some((c) => c.id === 'md2pdf' && c.status === 'ok')
        : dep === 'latex' ? caps.engines.latexOrder.length > 0
          : caps.chrome.found;
    if (!ok) blockers.push({ id: dep, ...DEP_META[dep] });
  }
```

**这处修复的教训比代码本身重要**：探测把它写进 `checks`，预检却读另一个**不存在**的字段，
于是"探测说 OK、预检说不可用"。修复前的实测：

```
POST /api/render targets=["png"] → HTTP 202
POST /api/render targets=["pdf"] → HTTP 409 {"blockers":[{"id":"md2pdf","message":"md2pdf 脚本不可用"}]}
$ caps.checks[md2pdf]            → {"status":"ok","detail":"/Users/fubin/scripts/md2pdf"}
```

**配合性**：`ROUTE_DEPS` 让"没装 pandoc"不再一票否决 HTML 路线——而 HTML 路线正是本项目主打的即点即得路径。

## 2.4 同一处 GS≥10 缺陷在 Node 侧的副本

```js
    case 'gs':
      cmd = tool.path;
      args = [
        '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
        // Ghostscript ≥10 要求带值的选项必须**贴成一个 argv 元素**：
        //   '-sDEVICE', 'png16m'  → "Unknown device: "（名字空）
        //   '-r', '200'           → "-r must be followed by <res>"
        // 两者都是 exit=1 且不产出文件。分开写是老版本的习惯，新版本一律拒绝。
        // 注意 poppler(pdftoppm/pdftocairo) 与 mutool 不受影响 —— 它们接受分开写，
        // 所以下面几支保持原样，只有 gs 这一支必须贴。
        '-sDEVICE=' + (transparent ? 'pngalpha' : 'png16m'),
        '-r' + String(d),
        '-dFirstPage=' + page, '-dLastPage=' + page,
        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
        `-sOutputFile=${outPath}`, pdfPath,
      ];
      break;
```

以及被它**掩盖住**的第二个崩溃：

```js
  /* sips 分支自己就把活干完了（它要跑两次：先出图、再重采样放大），不能再落到
     下面那句共用的 run(cmd, args) —— 它没有 args，会以空参数再跑一次 sips，
     最后在拼 command 字符串时 `args.join` 抛 TypeError 把整个请求打崩。
     曾经因为 gs 分支也坏着（见上），sips 才是实际被选中的那一支，所以这个崩溃
     一直没暴露：gs 一修好，它就被永久藏起来了。 */
  let ran = false;
```

```js
      produced = outPath;
      // 只用于报告（command 字段），真正的执行已经在上面做完了
      args = ['-s', 'format', 'png', pdfPath, '--out', outPath];
      ran = true;
      break;
    }
    default:
      return { ok: false, error: '未知工具' };
  }

  if (!ran) {
    const res = await run(cmd, args, { timeoutMs, onLog, signal });
    if (res.code !== 0) {
      return { ok: false, error: (res.stderr || res.stdout || `退出码 ${res.code}`).trim().slice(0, 500) };
    }
  }
```

**优点**：两处修复互相印证——**"把一个坏掉的兜底修好，会让另一个坏掉的兜底永远不再被执行"**。
极端环境剥夺测试（§自检套件第 4 组）正是为这种"只有退到底才走到"的分支准备的。

---

# 三、前端：把 60fps 拆成三个可验证的断言

## 3.1 内容离开 React 顶层 state

```ts
/**
 * web/src/lib/content.ts — 编辑器内容的**热路径 store**。
 *
 * 为什么不能把内容放在 React 顶层 state 里：
 * 实测（scripts/bench.mjs，10 万字符）逐键延迟 1331ms，其中只有 ~170ms 是解析
 * 渲染，其余是「每次按键都让整棵组件树重渲染 + 预览整块 innerHTML 替换」。
 * 内容一旦进入 App 的 state，TopBar / 侧栏 / 导出面板 / 控制台都会陪着重渲染。
 */
let content = '';
let version = 0;
let snapshot: ContentSnapshot = { content, version };
const listeners = new Set<() => void>();

/** 写入新内容（编辑器每次变更调用）。相同内容不触发更新。 */
export function setContent(next: string): void {
  const text = String(next ?? '');
  if (text === content) return;
  content = text;
  version++;
  snapshot = { content, version };
  emit();
}
```

**配合性**：持久化是**旁路**——App 用 400ms 防抖把内容刷回 `docs`，所以"敲一个字"不会惊动整棵树。

## 3.2 按 token 流分块（不是按空行切文本）

```js
/**
 * 把顶层 token 流按"结构完整的块"分组。
 * @returns {Array<{tokens:Array, start:number, end:number}>} start/end 为行号（0 基、左闭右开）
 */
export function groupTokens(tokens) {
  const groups = [];
  let cur = [];
  let depth = 0;
  let start = null;
  let end = null;

  const flush = () => {
    if (!cur.length) return;
    groups.push({ tokens: cur, start: start ?? 0, end: end ?? (start ?? 0) });
    cur = []; start = null; end = null;
  };

  for (const t of tokens) {
    const m = t.map;
    // 深度回到 0 之后出现行号断层 → 上一个块结束
    if (m && depth === 0 && end !== null && m[0] > end) flush();
    if (m) {
      if (start === null) start = m[0];
      end = m[1];
    }
    cur.push(t);
    depth += t.nesting || 0;
    if (depth < 0) depth = 0; // 容错：不因畸形 token 流而错位
  }
  flush();
  return groups;
}
```

**优点**：按空行切会把松列表劈成两半、渲染出的标签不平衡。按 token 的 `nesting` 跟踪深度分组，
保证**每个分组自身结构完整**——这是"增量拼接 == 全量渲染（逐字节）"这条断言能成立的前提。

**配合性**：分出来的 `start/end` 行号就是滚动锚定用的 `data-lines`；`blocksToHtml` 用**同一套包装**
产出导出 HTML，于是预览与导出排版语义一致。

## 3.3 差量协议与"key 是继承的身份，不是内容哈希"

```js
 * ② **key 是"被继承的身份"，不是"内容哈希"**。早期版本直接把内容哈希（+重复序号）
 *    当 key，于是文档里只要有重复样板块（同一段代码、同一条列表项），改动第一处
 *    重复就会让后面 127 个重复块的序号整体挪一位 —— "改一行"被报成 128 块变化，
 *    84KB HTML 白白重传，127 个 DOM 节点被无谓重建。
 *    现在的规则是：本轮某块若与上一轮某块（同位置、或同内容哈希）匹配上，就**沿用
 *    它的 key**；只有真正的新块才拿新的 key。身份因此是稳定的，客户端 key → 本地
 *    块 id 的映射也是稳定的（React 原地更新，不卸载重建）。
```

```js
    for (let i = 0; i < src.length; i++) {
      const nb = src[i];
      fullBytes += bytes(nb.html);

      let match = null;

      // ① **先看同一位置**：同一位置的块 HTML 相同 → 就是同一个块（哪怕内容哈希变了）。
      //    顺序不能反：先按内容哈希匹配，会在"重复块序号漂移"时认领到另一个位置的
      //    旧块（内容一样、行区间不同），白送一堆行号补丁。实测这条顺序差异决定了
      //    "改一行 → 127 个块被标记位移"还是"0 个"。
      const idxHit = last ? last.list[i] : null;
      if (idxHit && idxHit.html === nb.html && !consumed.has(idxHit)) {
        match = idxHit;
      } else {
        // ② 位置对不上（插入/删除导致整体位移）→ 按内容哈希找回，只补行号区间
        const hashHit = last ? last.byKey.get(nb.key) : null;
        if (hashHit && hashHit.html === nb.html && !consumed.has(hashHit)) match = hashHit;
      }
```

客户端侧的两条不变量：

```js
/**
 * 应用一次差量，返回**新的有序块数组**。
 *
 * 两条不变量（自检脚本逐条断言）：
 *   ① 内容、行区间都没变的块，返回的是**同一个对象引用** → React.memo 直接跳过
 *   ② 块的 id 尽可能稳定 → React 原地更新该块，而不是卸载重建
 */
export function applyDelta(store, delta) {
  // ① 消失的块
  for (const key of delta.removed || []) store.byKey.delete(key);

  // ② 只位移了行号的块：换一个对象（新 props → React 更新 data-lines），
  //    但 html 是同一个字符串引用，innerHTML 不会被重写。
  for (const [key, range] of Object.entries(delta.ranges || {})) {
    const entry = store.byKey.get(key);
    if (!entry) continue;
    if (entry.start === range[0] && entry.end === range[1]) continue;
    store.byKey.set(key, { ...entry, start: range[0], end: range[1] });
  }
  …
```

**实测**：改一处只重渲 **1/347** 块、5.4ms（复用率 99.7%）；打字期间差量始终 **< 全量 1%**（0.13KB / 3671.7KB）。

## 3.4 Worker：最新优先

```ts
function pump() {
  if (busy || !pending) return;
  const job = pending;
  pending = null;
  busy = true;
  const t0 = performance.now();
  try {
    const res = engine.render(job.source);
    post({ type: 'result', id: job.id, sentAt: job.sentAt, workerMs: +(performance.now() - t0).toFixed(1), result: res });
  } catch (err) {
    post({ type: 'error', id: job.id, message: String((err as Error)?.message || err), stack: String((err as Error)?.stack || '') });
  } finally {
    busy = false;
    // 渲染期间累积的最新一份源码立刻跟进（微任务里做，避免递归过深）
    if (pending) queueMicrotask(pump);
  }
}
```

```ts
  if (msg.type === 'render') {
    // 最新优先：直接覆盖待处理项，中间态没有渲染价值
    pending = msg;
    pump();
  }
```

**优点**：单槽 + 覆盖 = 天然背压。打字快于渲染时**队列不会堆积**，界面永远显示最新输入的结果；
`coalesced` 计数把这个行为暴露给状态栏，而不是让它悄悄发生。

**配合性**：`render.worker.ts` 只做调度，真正的渲染在 `shared/preview-engine.mjs`——
与 Node 自检**共用同一份代码**，所以 `verify:preview` 才能在没有浏览器的情况下逐字节断言。

## 3.5 缩放用 transform，不用改宽

```ts
  /* ---- 坐标空间：这是本次改动最容易踩的坑 -------------------------------
     高度表、偏移表、data-lines 全部是**布局像素**（来自 offsetHeight，transform
     不影响 offset*）。但 `scrollTop` 是**视觉像素**：容器没被缩放，而它滚动的是
     被缩放的纸张，所以滚 1 个视觉像素 = 走 1/scale 个布局像素。
     …
     所以规则是：**只在读写 scrollTop 的边界上换算**，中间计算一律走布局空间。 */
  const toLayout = (scrollTopVisual: number) => scrollTopVisual / (scaleRef.current || 1);
  const toScroll = (yLayout: number) => yLayout * (scaleRef.current || 1);
```

```ts
  /* ---- 缩放：按导出宽度固定 + 自动等比适配 -------------------------------
     预览的价值在于"所见即所得"：它必须用**导出的真实宽度**排版，否则公式换行、
     标题折行都和产物不一样。面板窄的时候（打开导出面板后常只剩 300~400px）不能
     靠收窄宽度去适配——那是让预览重排一遍，用户看到的就是另一个版面。

     做法：纸张恒定 paperWidth，容器放不下时用 transform 整体等比缩小。 */
```

**配合性**：纸张宽度用 `documentCss()` 与导出共享；`measure()` 量的是未缩放的 `offsetHeight`，
所以高度表与缩放解耦——这正是需要 `toLayout/toScroll` 的原因。

## 3.6 CSS 层：两条互斥的性能路线

```css
.mdp-doc .mdp-block {
  display: block;
  margin: 0;
  /* 块间距用 padding 而不是 margin：虚拟化要"每块高度自包含"。
     offsetHeight 不包含外边距，若间距靠 margin，sum(块高) ≠ 内容总高，
     上下占位块就会错位（滚到中段越滚越偏）。padding 在盒内，量得准。 */
  padding-top: 0.85em;
  contain: layout style paint;
}
/* 只在预览（非静态渲染）里跳过视口外内容；导出必须完整布局，否则截图/分页会缺内容。 */
.mdp-doc:not([data-static="1"]) .mdp-block {
  content-visibility: auto;
  contain-intrinsic-size: auto 56px;
}
…
/* 虚拟化打开时，块本来就只挂载视口附近的几十个，不需要（也不该）再让
   content-visibility 延迟布局——那会让"测到的高度"和"最终高度"不一致，
   反而把滚动锚定搞歪。 */
.mdp-doc[data-virtual="1"]:not([data-static="1"]) .mdp-block {
  content-visibility: visible;
  contain-intrinsic-size: none;
}
```

**要点**：`content-visibility` 与虚拟化是**互斥的两条路线**（以 60 块为界二选一），不是叠加生效；
导出页带 `data-static="1"` 关闭 `content-visibility`，保证截图与分页不缺内容。
另外：`content-visibility` / `contain` 作用在 `display:contents` 元素上是 **no-op**——这个坑踩过一次，
所以包装元素必须是 `display:block`。

---

# 四、配合性总表

| 机制 | 依赖谁 | 谁依赖它 | 动它的风险 |
|:--|:--|:--|:--|
| `content.ts` 外部 store | 无 | 预览、防抖持久化 | 内容进 React state → 整棵树重渲 |
| `groupTokens` token 分块 | markdown-it token 流 | 差量渲染、`data-lines`、导出包装 | 标签不平衡 → 预览与导出不一致 |
| key 继承式身份 | 差量协议 | React key / DOM 复用 | 退回内容哈希 → 重复块批量重传 |
| `applyDelta` 引用不变 | 差量协议 | `React.memo` O(1) 跳过 | 重建对象 → 每次按键全量贴 DOM |
| Worker 最新优先 | `preview-client` 单槽 | 打字延迟 | 改成队列 → 打字快时延迟累积 |
| 虚拟化 + 占位块 | `scroll-map` 的 offsets 表 | 滚动锚定、查找 | 占位高度走 state → 布局级联长任务 |
| `toLayout/toScroll` | 高度表用布局像素 | 虚拟化、拖拽同步 | 漏换算 → 缩放下同步整体错位 |
| `signature()` 全量输入 | 所有输出相关选项 | 缓存跳过 | 漏项 → 发陈旧产物（不是慢） |
| `ensure_pandoc` 惰性 | 无 | 渲染路径启动开销 | 恢复无条件调用 → 每次 +31ms |
| gs `-r200` 贴写 | Ghostscript ≥10 | PNG 真 DPI | 分开写 → 静默降级到 72dpi 放大 |
| FIFO 完成信道 | `mkfifo` | `-j` 并发、watch 事件 | 改回 `wait` → 批次屏障，槽位空转 |
| 进程组 kill | `set -m` | watch 重启 | 只杀 shell → 孤儿 xelatex 堆积 |
| `ROUTE_DEPS` 按路线 | `caps.checks` | `/api/render` 预检 | 读错字段 → 整条路被 409 拦死 |

---

# 五、这套自检怎么证明上面每一条

| 套件 | 钉住的是 |
|:--|:--|
| `verify` | 渲染同构：增量拼接 == 全量渲染（逐字节）、真 DPI、TeX 合法 |
| `verify:preview` | 差量协议：重复块漂移不重传、插入后 1150/1153 保号、逐键 p95 |
| `verify:scrollmap` | 行 ↔ 像素往返、20 万次映射 12.3ms、5000 块只渲 32 块 |
| `verify:sync` | 编辑器滚到第 N 行 → 预览顶部块覆盖第 N 行 |
| `verify:persist` | localStorage 2.9MB → 366 字节、恢复副本不丢内容 |
| `verify:cancel` | 取消 158ms、无孤儿子进程、排队任务不会偷偷再跑 |
| `verify:export` | 1200 DPI 上限、耗时预估自学习 |
| **`verify:kernel`**（本次新增） | 惰性依赖、缓存命中零 pandoc、并发上限与加速比、watch 不堆积/负载归零/产物像素级一致、环境剥夺下的降级与字体回退 |

`verify:kernel` 的四组用例分别对应本文的 §1.1、§1.5、§1.6、§2.4 与 §1.4——
**每一组都是先有一个真实故障，才补上的判据**。
