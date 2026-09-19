#!/bin/sh
# =============================================================================
#  install.sh —— 把 md2pdf 接入终端
#
#  做三件事：
#    1. 在 ~/.local/bin 建立 md2pdf / m2p 软链接（脚本升级后自动生效）
#    2. 在 ~/.zshrc 写入一段受管块（MD2PDF_HOME + PATH），幂等、可回滚
#    3. 可选安装 zsh 补全
#
#  用法:
#    ./install.sh                 # 安装
#    ./install.sh --dry-run       # 只显示将要做什么
#    ./install.sh --uninstall     # 卸载（软链 + .zshrc 中的受管块）
#    ./install.sh --prefix DIR    # 自定义 bin 目录（默认 ~/.local/bin）
#    ./install.sh --rc FILE       # 自定义 rc 文件（默认 ~/.zshrc）
#    ./install.sh --no-rc         # 不改 rc 文件，只建软链
#    ./install.sh --with-completion
# =============================================================================
set -u

NL='
'
BEGIN_MARK='# >>> md2pdf >>>'
END_MARK='# <<< md2pdf <<<'
SDKMAN_MARK='^#THIS MUST BE AT THE END'

PREFIX=${HOME}/.local/bin
RC=${HOME}/.zshrc
DO_RC=1
DO_COMPLETION=0
UNINSTALL=0
DRY=0

while [ $# -gt 0 ]; do
    case $1 in
        --dry-run|-n)  DRY=1; shift ;;
        --uninstall)   UNINSTALL=1; shift ;;
        --prefix)      [ $# -ge 2 ] || { echo "缺少参数" >&2; exit 1; }; PREFIX=$2; shift 2 ;;
        --rc)          [ $# -ge 2 ] || { echo "缺少参数" >&2; exit 1; }; RC=$2; shift 2 ;;
        --no-rc)       DO_RC=0; shift ;;
        --with-completion) DO_COMPLETION=1; shift ;;
        -h|--help)     sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)             echo "未知选项: $1" >&2; exit 1 ;;
    esac
done

# --- 定位脚本目录（跟随软链）-------------------------------------------------
_resolve() {
    _rp=$1
    while [ -L "$_rp" ]; do
        _rd=$(cd -P "$(dirname "$_rp")" >/dev/null 2>&1 && pwd) || return 1
        _rp=$(readlink "$_rp")
        case $_rp in /*) ;; *) _rp=$_rd/$_rp ;; esac
    done
    _rd=$(cd -P "$(dirname "$_rp")" >/dev/null 2>&1 && pwd)
    printf '%s/%s\n' "$_rd" "${_rp##*/}"
}
SELF=$(_resolve "$0")
HOME_DIR=$(dirname "$SELF")

G=$(printf '\033[32m'); Y=$(printf '\033[33m'); R=$(printf '\033[31m')
B=$(printf '\033[36m'); D=$(printf '\033[2m');  Z=$(printf '\033[0m')
[ -t 1 ] || { G=; Y=; R=; B=; D=; Z=; }

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$Z" "$*"; }
skip() { printf '  %s·%s %s\n' "$D" "$Z" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$Z" "$*"; }
die()  { printf '%serror:%s %s\n' "$R" "$Z" "$*" >&2; exit 1; }

run() {   # 演示模式只打印
    if [ "$DRY" = 1 ]; then printf '  %s$%s %s\n' "$D" "$Z" "$*"; else "$@"; fi
}

[ -f "$HOME_DIR/md2pdf" ] || die "同目录下找不到 md2pdf（当前: $HOME_DIR）"
chmod +x "$HOME_DIR/md2pdf" 2>/dev/null

# --------------------------------------------------------------- 受管块 ------
write_block() {
    _tmp=$1
    {
        printf '%s\n' "$BEGIN_MARK"
        printf '%s\n' "# 由 md2pdf/install.sh 写入；删除本块即可卸载。"
        printf 'export MD2PDF_HOME="%s"\n' "$HOME_DIR"
        printf '%s\n' 'case ":$PATH:" in'
        printf '%s\n' '    *":$MD2PDF_HOME:"*) ;;'
        printf '%s\n' '    *) export PATH="$MD2PDF_HOME:$PATH" ;;'
        printf '%s\n' 'esac'
        printf '%s\n' 'case ":$PATH:" in'
        printf '%s\n' '    *":$HOME/.local/bin:"*) ;;'
        printf '%s\n' '    *) export PATH="$HOME/.local/bin:$PATH" ;;'
        printf '%s\n' 'esac'
        if [ "$DO_COMPLETION" = 1 ]; then
            printf '%s\n' '# zsh 补全（可选）'
            printf '%s\n' 'if [ -n "${ZSH_VERSION:-}" ]; then'
            printf '%s\n' '    fpath=("$MD2PDF_HOME/completions" $fpath)'
            printf '%s\n' '    autoload -Uz compinit && compinit -C'
            printf '%s\n' 'fi'
        fi
        printf '%s\n' "$END_MARK"
    } > "$_tmp"
}

strip_block() {   # stdin → stdout，去掉受管块
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        !skip   { print }
    '
}

extract_block() {   # 取出文件里已有的受管块（含首尾标记）
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
        $0 == b { inb = 1 }
        inb     { print }
        $0 == e { inb = 0 }
    ' "$1"
}

trim_trailing_blanks() {   # 去掉末尾空行，避免反复安装堆积空行
    awk '{ l[NR] = $0 } END { last = NR; while (last > 0 && l[last] == "") last--
                               for (i = 1; i <= last; i++) print l[i] }'
}

patch_rc() {
    [ "$DO_RC" = 1 ] || { skip "未改动 $RC (--no-rc)"; return 0; }
    [ -f "$RC" ] || { warn "$RC 不存在，将创建"; [ "$DRY" = 1 ] || : > "$RC"; }

    _block=$(mktemp "${TMPDIR:-/tmp}/md2pdf-block.XXXXXX")
    _base=$(mktemp "${TMPDIR:-/tmp}/md2pdf-rc.XXXXXX")
    _new=$(mktemp "${TMPDIR:-/tmp}/md2pdf-rcnew.XXXXXX")
    write_block "$_block"

    # 幂等判定：已有受管块且内容一致 → 什么都不做
    if grep -qF "$BEGIN_MARK" "$RC" 2>/dev/null; then
        _cur=$(mktemp "${TMPDIR:-/tmp}/md2pdf-cur.XXXXXX")
        extract_block "$RC" > "$_cur"
        if cmp -s "$_block" "$_cur"; then
            skip "$RC 已是目标状态（受管块存在且内容一致）"
            rm -f "$_block" "$_base" "$_new" "$_cur"
            return 0
        fi
        rm -f "$_cur"
    fi

    strip_block < "$RC" | trim_trailing_blanks > "$_base"

    # 在 SDKMAN 约束行之前插入，保持 "SDKMAN 必须在文件末尾" 的前提
    _ln=$(grep -n "$SDKMAN_MARK" "$_base" | head -1 | cut -d: -f1)
    if [ -n "$_ln" ]; then
        head -n $((_ln - 1)) "$_base" > "$_new"
        printf '\n' >> "$_new"
        cat "$_block" >> "$_new"
        printf '\n' >> "$_new"
        tail -n +"$_ln" "$_base" >> "$_new"
    else
        cat "$_base" > "$_new"
        printf '\n\n' >> "$_new"
        cat "$_block" >> "$_new"
    fi

    if cmp -s "$RC" "$_new"; then
        skip "$RC 已是目标状态"
    elif [ "$DRY" = 1 ]; then
        say "  ${D}\$ patch $RC${Z} （将备份为 ${RC}.md2pdf.bak）"
        sed 's/^/      /' "$_block"
    else
        cp "$RC" "${RC}.md2pdf.bak" || die "备份 $RC 失败"
        cat "$_new" > "$RC" || die "写入 $RC 失败"
        ok "已更新 $RC ${D}(备份: ${RC}.md2pdf.bak)${Z}"
    fi
    rm -f "$_block" "$_base" "$_new"
}

# --------------------------------------------------------------- 卸载 --------
do_uninstall() {
    say "${B}卸载 md2pdf / MDP Studio${Z}"
    for n in md2pdf m2p mdp; do
        _l=$PREFIX/$n
        if [ ! -L "$_l" ]; then
            skip "$_l 不存在或不是软链"
        elif [ "$DRY" = 1 ]; then
            run rm -f "$_l"
        else
            rm -f "$_l" && ok "已删除软链 $_l"
        fi
    done
    if [ -f "$RC" ] && grep -qF "$BEGIN_MARK" "$RC"; then
        _base=$(mktemp "${TMPDIR:-/tmp}/md2pdf-rc.XXXXXX")
        strip_block < "$RC" > "$_base"
        if [ "$DRY" = 1 ]; then
            say "  ${D}\$ 从 $RC 移除受管块${Z}"
        else
            cp "$RC" "${RC}.md2pdf.bak" && cat "$_base" > "$RC"
            ok "已从 $RC 移除受管块"
        fi
        rm -f "$_base"
    else
        skip "$RC 中没有受管块"
    fi
    printf '\n'
    say "完成。新开终端或执行: ${B}source $RC${Z}"
}

# --------------------------------------------------------------- 安装 --------
do_install() {
    printf '\n'
    say "${B}安装 md2pdf${Z}  ${D}(脚本目录: $HOME_DIR)${Z}"
    printf '\n'

    [ -x "$HOME_DIR/md2pdf" ] || die "md2pdf 不可执行"
    command -v pandoc >/dev/null 2>&1 || warn "未检测到 pandoc：brew install pandoc"
    if ! command -v xelatex >/dev/null 2>&1 && ! command -v lualatex >/dev/null 2>&1 \
       && ! command -v tectonic >/dev/null 2>&1; then
        warn "未检测到 LaTeX 引擎：brew install --cask mactex-no-gui"
    fi

    # 1) 软链接
    if [ ! -d "$PREFIX" ]; then
        run mkdir -p "$PREFIX" || die "无法创建 $PREFIX（试试 sudo 或 --prefix 指定其它目录）"
    fi
    for n in md2pdf m2p mdp; do
        # mdp 是统一入口（网页工作台 + 批量导出），是一个会自行解析软链的 sh 壳
        case $n in
            mdp) _target=$HOME_DIR/mdp ;;
            *)   _target=$HOME_DIR/md2pdf ;;
        esac
        [ -f "$_target" ] || { skip "$_target 不存在，跳过 $n"; continue; }
        _link=$PREFIX/$n
        if [ -L "$_link" ] && [ "$(readlink "$_link")" = "$_target" ]; then
            skip "$_link 已指向 $_target"
            continue
        fi
        if [ -e "$_link" ] && [ ! -L "$_link" ]; then
            warn "$_link 已存在且不是软链，跳过（请手工处理）"
            continue
        fi
        if [ "$DRY" = 1 ]; then
            run ln -sfn "$_target" "$_link"
        elif ln -sfn "$_target" "$_link" 2>/dev/null; then
            ok "$n → $_target"
        else
            warn "创建软链失败: $_link（目录不可写？）"
        fi
    done

    # 2) rc
    patch_rc

    # 3) 自检
    if [ "$DRY" != 1 ]; then
        say ''
        if command -v pandoc >/dev/null 2>&1; then
            "$HOME_DIR/md2pdf" doctor 2>/dev/null | sed 's/^/  /' || warn "doctor 执行失败"
        fi
    fi

    printf '\n'
    say "${G}安装完成${Z}"
    say "  新开终端，或执行: ${B}source $RC${Z}"
    say "  然后试试:         ${B}md2pdf -h${Z}   ${B}md2pdf -q high 你的文件.md${Z}"
    printf '\n'
}

if [ "$UNINSTALL" = 1 ]; then do_uninstall; else do_install; fi
