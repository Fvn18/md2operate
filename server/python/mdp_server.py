#!/usr/bin/env python3
"""
server/python/mdp_server.py — 方案 B：Python(FastAPI) 分发模式。

## 定位与设计取舍（重要，先读这段）

需求要求"保留原有的两种打包分发模式"：
  · 方案 A —— 纯 Node CLI：`mdp serve`（零运行时依赖）
  · 方案 B —— Python 后端 + npm 前端：FastAPI 挂载静态资源（本文件）

**本文件刻意不重新实现渲染引擎。** 渲染引擎包含三块重资产：Chrome DevTools
Protocol 驱动、pandoc/XeLaTeX 调用与档位映射、PDF→PNG 多级回退。把它们在
Python 里再写一遍意味着两套实现长期漂移——预览与导出的一致性、真 DPI 的字节级
校验、`md2pdf` 的 7 个档位，任何一处改动都要同步两遍。这个代价远大于"纯 Python"
带来的好处。

因此方案 B 的形态是：**FastAPI 负责进程/端口/静态资源/网关，渲染引擎仍走同一份
Node 实现**（由本进程作为子进程拉起）。它满足方案 B 的全部实际诉求：
  · Python 进程对外提供 HTTP 服务与 API
  · FastAPI 挂载 `web/dist` 静态资源，浏览器访问的是同一个工作台
  · CLI 接口不变（`mdp serve` 仍是入口，多一个 `--python` 开关）

如果你确实需要"零 Node 依赖"的 Python 实现，请先看 README「已知取舍」一节——
那是一个独立的大工程（约等于重写 render.mjs / chrome.mjs / raster.mjs），
而不是把本文件写长一点就能达到的。

## 运行

    python3 -m venv .venv
    .venv/bin/pip install -r server/python/requirements.txt
    .venv/bin/python server/python/mdp_server.py --port 8757

或从统一入口：

    mdp serve --python

依赖：fastapi、uvicorn、httpx（仅这三项；渲染依赖仍在 Node 侧）
"""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

try:
    import httpx
    import uvicorn
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, Response, StreamingResponse
    from fastapi.staticfiles import StaticFiles
except ModuleNotFoundError as exc:  # 给出可操作的提示，而不是一堆 traceback
    missing = exc.name
    sys.stderr.write(
        f"\n缺少 Python 依赖：{missing}\n\n"
        "请先安装：\n"
        "  python3 -m venv .venv\n"
        "  .venv/bin/pip install -r server/python/requirements.txt\n"
        "  .venv/bin/python server/python/mdp_server.py --port 8757\n\n"
        "或直接用方案 A（零依赖）：mdp serve\n"
    )
    raise SystemExit(4)

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "web" / "dist"
MDP_CLI = ROOT / "bin" / "mdp.mjs"


# --------------------------------------------------------------------------- #
# 引擎子进程（与方案 A 共用同一份实现）
# --------------------------------------------------------------------------- #

class Engine:
    """管理 Node 渲染引擎子进程，并做健康等待。"""

    def __init__(self, port: int, log=print) -> None:
        self.port = port
        self.proc: subprocess.Popen | None = None
        self.log = log

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 30.0) -> None:
        if not MDP_CLI.exists():
            raise RuntimeError(f"找不到 Node 引擎入口：{MDP_CLI}")
        env = {**os.environ, "MDP_EMBEDDED": "1"}
        self.log(f"[engine] 启动 Node 渲染引擎 → {self.base_url}")
        self.proc = subprocess.Popen(
            ["node", str(MDP_CLI), "serve",
             "--port", str(self.port), "--no-open", "--quiet"],
            cwd=str(ROOT), env=env,
            stdout=sys.stderr, stderr=sys.stderr,
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"引擎进程提前退出（code={self.proc.returncode}）")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    self.log("[engine] 已就绪")
                    return
            except OSError:
                time.sleep(0.15)
        raise RuntimeError(f"引擎在 {timeout}s 内未监听 {self.port}")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.log("[engine] 停止")
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def free_port(start: int, tries: int = 20) -> int:
    for p in range(start, start + tries):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise RuntimeError("找不到可用端口")


engine: Engine | None = None
args_ns: argparse.Namespace | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    if not args_ns.no_engine:
        engine = Engine(args_ns.engine_port)
        engine.start()
    try:
        yield
    finally:
        if engine:
            engine.stop()


app = FastAPI(title="MDP Studio (Python/FastAPI host)", lifespan=lifespan)

# 转发时不应原样透传的逐跳首部
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


@app.get("/api/health")
async def health() -> JSONResponse:
    """在引擎的健康信息上补一层"谁在对外服务"的说明。"""
    payload: dict = {"ok": True}
    if engine:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{engine.base_url}/api/health")
                payload = r.json()
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"ok": False, "error": f"引擎不可达：{exc}"}, status_code=502)
    payload["host"] = {
        "runtime": f"python {sys.version.split()[0]}",
        "framework": "fastapi",
        "engine": "node (bin/mdp.mjs)",
        "dist": str(DIST),
        "distBuilt": DIST.joinpath("index.html").exists(),
    }
    return JSONResponse(payload)


@app.api_route(
    "/api/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy_api(path: str, request: Request):
    """
    把 /api/* 流式转发给 Node 引擎。

    必须流式转发：`/api/jobs/:id/events` 与 `/api/ai/*` 是 SSE 长连接，
    缓冲式转发（先读完再返回）会把实时日志与流式 AI 输出变成"最后一次性吐出"。
    """
    if engine is None:
        return JSONResponse({"error": "引擎未启动（--no-engine）"}, status_code=503)

    url = f"{engine.base_url}/api/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    body = await request.body()

    client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))
    try:
        upstream = await client.send(
            client.build_request(request.method, url, headers=headers, content=body),
            stream=True,
        )
    except Exception as exc:  # noqa: BLE001
        await client.aclose()
        return JSONResponse({"error": f"引擎请求失败：{exc}"}, status_code=502)

    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP}

    async def body_iter():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        headers=out_headers,
        media_type=upstream.headers.get("content-type"),
    )


# --------------------------------------------------------------------------- #
# 静态资源（方案 B 的核心诉求：FastAPI 挂载 npm 构建产物）
# --------------------------------------------------------------------------- #

class SpaStatic(StaticFiles):
    """未命中文件时回落 index.html，支持前端路由。"""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        try:
            return await super().get_response(path, scope)
        except Exception:  # noqa: BLE001  —— 404 等
            return await super().get_response("index.html", scope)


def mount_frontend() -> None:
    if DIST.joinpath("index.html").exists():
        app.mount("/", SpaStatic(directory=str(DIST), html=True), name="web")
    else:
        @app.get("/")
        def _not_built():  # pragma: no cover - 仅在未构建时命中
            return JSONResponse(
                {
                    "error": "web/dist 尚未构建",
                    "hint": "在项目根目录执行 npm install && npm run build",
                    "engine": "mdp serve（方案 A）仍可直接使用",
                },
                status_code=503,
            )


mount_frontend()


# --------------------------------------------------------------------------- #

def main() -> int:
    global args_ns
    ap = argparse.ArgumentParser(
        description="MDP Studio —— Python/FastAPI 分发模式（渲染引擎仍为 Node）",
    )
    ap.add_argument("--port", type=int, default=8757, help="对外服务端口（默认 8757）")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅回环）")
    ap.add_argument("--engine-port", type=int, default=0,
                    help="Node 引擎内部端口（默认自动选一个空闲端口）")
    ap.add_argument("--no-engine", action="store_true",
                    help="外部已有引擎在跑时使用（配合 --engine-port）")
    ap.add_argument("--reload", action="store_true", help="uvicorn 热重载（开发用）")
    args_ns = ap.parse_args()

    if not args_ns.engine_port:
        args_ns.engine_port = free_port(8800)

    print()
    print("  MDP Studio · Python(FastAPI) 分发模式")
    print(f"  前端资源   {DIST}{'' if DIST.joinpath('index.html').exists() else '  ⚠ 尚未构建'}")
    print(f"  渲染引擎   Node  {MDP_CLI}  →  127.0.0.1:{args_ns.engine_port}")
    print(f"  访问地址   http://{args_ns.host}:{args_ns.port}")
    print("  停止       Ctrl-C")
    print()

    # uvicorn 自己接管 SIGINT/SIGTERM，退出时触发 lifespan 的 finally，
    # 由那里停止 Node 引擎子进程（所以这里不需要再挂信号处理）。
    uvicorn.run(app, host=args_ns.host, port=args_ns.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
