# -*- coding: utf-8 -*-
"""
学习计划定制系统 —— 后端服务。

只用 Python 标准库实现（http.server + urllib），不需要 pip 安装任何东西，
直接 `python backend/server.py` 即可启动，同时它会托管前端静态页面。

接口：
    GET  /                  前端页面
    GET  /api/health        健康检查（是否配置了 Key、当前模型）
    POST /api/plan          非流式：一次性返回完整学习计划
    POST /api/plan/stream   流式（SSE）：边生成边返回，前端可以打字机式渲染
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import time
import traceback
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

# 让 `python backend/server.py` 与 `python -m backend.server` 都能正常 import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
import deepseek  # noqa: E402
import prompt as prompt_builder  # noqa: E402
import storage  # noqa: E402

MAX_BODY_BYTES = 1 << 20  # 1MB，表单文本足够用

# /api/plans/<id>
PLAN_ITEM_RE = re.compile(r"^/api/plans/([A-Za-z0-9_-]{1,64})$")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class StudyPlanHandler(BaseHTTPRequestHandler):
    server_version = "StudyPlanServer/1.0"
    protocol_version = "HTTP/1.1"
    # 关闭 Nagle 算法，保证每个 SSE 片段立刻发出
    disable_nagle_algorithm = True
    # 不使用写缓冲，配合 flush() 实现实时输出
    wbufsize = 0

    # ------------------------------------------------------------ 基础工具
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        sys.stdout.write(f"[{_now()}] {self.address_string()} {fmt % args}\n")
        sys.stdout.flush()

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        allow = "*"
        if config.ALLOW_ORIGINS and "*" not in config.ALLOW_ORIGINS:
            allow = origin if origin in config.ALLOW_ORIGINS else config.ALLOW_ORIGINS[0]
        self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_json(self, payload: Dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求体不是合法的 JSON") from exc
        return data if isinstance(data, dict) else {}

    # -------------------------------------------------------------- 路由
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/health":
            info = storage.stats()
            self._send_json({
                "ok": True,
                "service": "学习计划定制系统",
                "model": config.DEEPSEEK_MODEL,
                "model_alias": "DeepSeek-V4.1-Flash",
                "base_url": config.DEEPSEEK_BASE_URL,
                "api_key_configured": bool(config.DEEPSEEK_API_KEY),
                "saved_plans": info["total"],
                "time": _now(),
            })
            return
        if path == "/api/plans":
            self._handle_list_plans()
            return
        if path == "/api/plans/export":
            self._handle_export_plans()
            return
        match = PLAN_ITEM_RE.match(path)
        if match:
            self._handle_get_plan(match.group(1))
            return
        if path.startswith("/api/"):
            self._send_json({"ok": False, "error": "接口不存在"}, status=404)
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/plan":
            self._handle_plan()
            return
        if path == "/api/plan/stream":
            self._handle_plan_stream()
            return
        if path == "/api/plans":
            self._handle_save_plan()
            return
        self._send_json({"ok": False, "error": "接口不存在"}, status=404)

    def do_PATCH(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        match = PLAN_ITEM_RE.match(path)
        if match:
            self._handle_update_plan(match.group(1))
            return
        self._send_json({"ok": False, "error": "接口不存在"}, status=404)

    def do_DELETE(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        match = PLAN_ITEM_RE.match(path)
        if match:
            self._handle_delete_plan(match.group(1))
            return
        self._send_json({"ok": False, "error": "接口不存在"}, status=404)

    # ------------------------------------------------------------ 静态资源
    def _serve_static(self, path: str) -> None:
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        target = (config.FRONTEND_DIR / rel).resolve()

        # 防目录穿越
        try:
            target.relative_to(config.FRONTEND_DIR.resolve())
        except ValueError:
            self._send_json({"ok": False, "error": "非法路径"}, status=403)
            return

        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            body = (
                "<!doctype html><meta charset='utf-8'>"
                "<h2>404 找不到页面</h2>"
                "<p>请确认 <code>frontend/</code> 目录存在，或访问 "
                "<a href='/'>首页</a>。</p>"
            ).encode("utf-8")
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"

        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    # -------------------------------------------------------------- 业务
    def _prepare(self) -> Optional[Dict[str, Any]]:
        """解析并校验请求体；失败时已回复响应并返回 None。"""
        try:
            payload = self._read_json()
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=400)
            return None

        profile, errors = prompt_builder.validate(payload)
        if errors:
            self._send_json(
                {"ok": False, "error": "表单校验未通过，请检查填写内容。", "fields": errors},
                status=422,
            )
            return None

        messages = prompt_builder.build_messages(profile)
        return {
            "profile": profile,
            "messages": messages,
            "thinking": bool(payload.get("thinking", True)),
            "reasoning_effort": str(payload.get("reasoning_effort") or "high"),
        }

    def _handle_plan(self) -> None:
        ctx = self._prepare()
        if ctx is None:
            return

        started = time.time()
        self.log_message("生成学习计划（非流式）学员=%s", ctx["profile"]["name"])
        try:
            result = deepseek.chat(
                ctx["messages"],
                thinking=ctx["thinking"],
                reasoning_effort=ctx["reasoning_effort"],
            )
        except deepseek.DeepSeekError as exc:
            self.log_message("大模型调用失败: %s %s", exc.message, exc.detail[:200])
            self._send_json(
                {"ok": False, "error": exc.message, "detail": exc.detail[:800]},
                status=exc.status if 400 <= exc.status < 600 else 502,
            )
            return
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            self._send_json({"ok": False, "error": f"服务器内部错误：{exc}"}, status=500)
            return

        self._send_json({
            "ok": True,
            "plan": result["content"],
            "reasoning": result["reasoning"],
            "meta": {
                "model": result["model"],
                "model_alias": "DeepSeek-V4.1-Flash",
                "elapsed": round(time.time() - started, 2),
                "usage": result["usage"],
                "finish_reason": result["finish_reason"],
                "generated_at": _now(),
                "student": ctx["profile"]["name"],
            },
        })

    def _handle_plan_stream(self) -> None:
        ctx = self._prepare()
        if ctx is None:
            return

        # SSE 无法预知长度：显式使用 Connection: close，客户端读到连接关闭为止
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self._cors_headers()
        self.end_headers()

        started = time.time()
        model_name = config.DEEPSEEK_MODEL
        usage: Dict[str, Any] = {}
        content_chars = 0
        self.log_message("生成学习计划（流式）学员=%s", ctx["profile"]["name"])

        def emit(event: str, data: Any) -> None:
            chunk = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            self.wfile.write(chunk.encode("utf-8"))
            self.wfile.flush()

        try:
            emit("start", {
                "model": model_name,
                "model_alias": "DeepSeek-V4.1-Flash",
                "student": ctx["profile"]["name"],
                "thinking": ctx["thinking"],
                "started_at": _now(),
            })
            for kind, payload in deepseek.chat_stream(
                ctx["messages"],
                thinking=ctx["thinking"],
                reasoning_effort=ctx["reasoning_effort"],
            ):
                if kind == "reasoning":
                    emit("reasoning", {"delta": payload})
                elif kind == "content":
                    content_chars += len(payload)
                    emit("content", {"delta": payload})
                elif kind == "usage":
                    usage = payload
                elif kind == "finish":
                    emit("finish", {"reason": payload})

            emit("done", {
                "elapsed": round(time.time() - started, 2),
                "chars": content_chars,
                "usage": usage,
                "model": model_name,
                "model_alias": "DeepSeek-V4.1-Flash",
                "generated_at": _now(),
            })
        except deepseek.DeepSeekError as exc:
            self.log_message("流式调用失败: %s", exc.message)
            try:
                emit("error", {"error": exc.message, "detail": exc.detail[:800]})
            except Exception:
                pass
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # 前端点了“停止生成”或关闭页面，正常结束即可
            self.log_message("客户端已断开，停止生成")
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            try:
                emit("error", {"error": f"服务器内部错误：{exc}", "detail": ""})
            except Exception:
                pass


    # -------------------------------------------- 计划的保存与管理（SQLite）
    def _handle_save_plan(self) -> None:
        try:
            payload = self._read_json()
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=400)
            return

        plan_md = str(payload.get("plan") or "").strip()
        if not plan_md:
            self._send_json(
                {"ok": False, "error": "没有可保存的计划内容，请先生成学习计划。"},
                status=422,
            )
            return

        # 学员信息原样存档（用于「我的计划」里展示），不做强校验
        profile: Dict[str, Any] = {}
        for key in list(prompt_builder.REQUIRED_FIELDS) + list(prompt_builder.OPTIONAL_FIELDS):
            value = payload.get(key, "")
            profile[key] = "" if value is None else value

        if not str(profile.get("name") or "").strip():
            profile["name"] = "学员"

        try:
            age = int(float(profile.get("age") or 0))
        except (TypeError, ValueError):
            age = None
        profile["age"] = age

        meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}

        try:
            result = storage.save_plan(
                profile, plan_md, str(payload.get("reasoning") or ""), meta
            )
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=422)
            return
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            self._send_json({"ok": False, "error": f"保存失败：{exc}"}, status=500)
            return

        self.log_message("保存计划 id=%s 重复=%s", result["id"], result["duplicated"])
        self._send_json({
            "ok": True,
            "id": result["id"],
            "saved_at": result["created_at"],
            "duplicated": result["duplicated"],
            "message": "该计划之前已经保存过，已为你定位到原记录。" if result["duplicated"]
                       else "计划已保存。",
            "total": storage.count_plans(),
        })

    def _handle_list_plans(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        keyword = (query.get("keyword") or [""])[0]
        try:
            limit = int((query.get("limit") or ["100"])[0])
        except ValueError:
            limit = 100
        try:
            offset = int((query.get("offset") or ["0"])[0])
        except ValueError:
            offset = 0

        items = storage.list_plans(keyword, limit, offset)
        self._send_json({
            "ok": True,
            "items": items,
            "total": storage.count_plans(keyword),
            "stats": storage.stats(),
        })

    def _handle_get_plan(self, plan_id: str) -> None:
        item = storage.get_plan(plan_id)
        if not item:
            self._send_json({"ok": False, "error": "找不到这份计划，可能已被删除。"}, status=404)
            return
        self._send_json({"ok": True, "item": item})

    def _handle_update_plan(self, plan_id: str) -> None:
        try:
            payload = self._read_json()
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if "starred" not in payload:
            self._send_json({"ok": False, "error": "没有需要更新的字段。"}, status=422)
            return

        starred = bool(payload.get("starred"))
        if not storage.set_starred(plan_id, starred):
            self._send_json({"ok": False, "error": "找不到这份计划，可能已被删除。"}, status=404)
            return
        self._send_json({"ok": True, "id": plan_id, "starred": starred})

    def _handle_delete_plan(self, plan_id: str) -> None:
        if not storage.delete_plan(plan_id):
            self._send_json({"ok": False, "error": "找不到这份计划，可能已被删除。"}, status=404)
            return
        self.log_message("删除计划 id=%s", plan_id)
        self._send_json({"ok": True, "id": plan_id, "total": storage.count_plans()})

    def _handle_export_plans(self) -> None:
        body = storage.export_all().encode("utf-8")
        filename = f"study-plans-{datetime.now().strftime('%Y%m%d_%H%M')}.json"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    # Windows 控制台默认 GBK，做一层容错，避免个别字符导致启动崩溃
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass

    storage.init_db()
    saved = storage.stats()

    banner = f"""
============================================================
  学习计划定制系统  ·  后端服务
------------------------------------------------------------
  模型      : {config.DEEPSEEK_MODEL}  (DeepSeek-V4.1-Flash)
  接口地址  : {config.DEEPSEEK_BASE_URL}
  API Key   : {'已配置' if config.DEEPSEEK_API_KEY else '未配置 -> 请在 .env 中填写 DEEPSEEK_API_KEY'}
  计划存储  : {saved['db_path']}（已保存 {saved['total']} 份）
  前端页面  : http://{config.HOST}:{config.PORT}/
  健康检查  : http://{config.HOST}:{config.PORT}/api/health
  按 Ctrl+C 停止服务
============================================================
"""
    print(banner, flush=True)
    server = ThreadingHTTPServer((config.HOST, config.PORT), StudyPlanHandler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
