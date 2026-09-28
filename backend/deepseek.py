# -*- coding: utf-8 -*-
"""
DeepSeek 大模型客户端（仅使用 Python 标准库，无需安装任何第三方包）。

接口地址：POST {DEEPSEEK_BASE_URL}/chat/completions
请求格式与 OpenAI Chat Completions 完全兼容，SSE 流式以 `data: [DONE]` 结尾。
文档：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

import config


class DeepSeekError(Exception):
    """调用大模型失败。message 是给前端看的中文提示。"""

    def __init__(self, message: str, status: int = 502, detail: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.detail = detail


def _build_request(messages: List[Dict[str, str]], *, stream: bool,
                   thinking: bool, reasoning_effort: str,
                   temperature: float, max_tokens: int) -> urllib.request.Request:
    if not config.DEEPSEEK_API_KEY:
        raise DeepSeekError(
            "服务端未配置 DEEPSEEK_API_KEY，请在项目根目录的 .env 中填写后重启服务。",
            status=500,
        )

    payload: Dict[str, Any] = {
        "model": config.DEEPSEEK_MODEL,
        "messages": messages,
        "stream": stream,
        "max_tokens": max_tokens,
        # 思考模式：enabled 更细致但更慢，disabled 更快。
        "thinking": {"type": "enabled" if thinking else "disabled"},
    }
    if thinking:
        # 思考模式下 temperature 不生效，改用思考强度控制质量。
        payload["reasoning_effort"] = reasoning_effort
    else:
        payload["temperature"] = temperature

    if stream:
        # 让最后一个数据块带上 token 用量。
        payload["stream_options"] = {"include_usage": True}

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return urllib.request.Request(
        url=f"{config.DEEPSEEK_BASE_URL}/chat/completions",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
            "Authorization": f"Bearer {config.DEEPSEEK_API_KEY}",
        },
    )


def _open(request: urllib.request.Request, timeout: int):
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:  # pragma: no cover - 读取失败不影响主流程
            pass
        hint = {
            401: "API Key 无效或已失效，请检查 .env 中的 DEEPSEEK_API_KEY。",
            402: "账户余额不足，请前往 DeepSeek 开放平台充值。",
            422: "请求参数不合法，请检查模型名与参数设置。",
            429: "请求过于频繁，请稍后重试。",
            500: "DeepSeek 服务端异常，请稍后重试。",
            503: "DeepSeek 服务繁忙，请稍后重试。",
        }.get(exc.code, f"调用 DeepSeek 接口失败（HTTP {exc.code}）。")
        raise DeepSeekError(hint, status=exc.code, detail=detail) from exc
    except urllib.error.URLError as exc:
        raise DeepSeekError(
            f"无法连接 DeepSeek 服务（{config.DEEPSEEK_BASE_URL}），请检查网络或代理设置。",
            status=504,
            detail=str(exc.reason),
        ) from exc
    except TimeoutError as exc:  # pragma: no cover
        raise DeepSeekError("连接 DeepSeek 超时，请稍后重试。", status=504, detail=str(exc)) from exc


def chat(messages: List[Dict[str, str]], *, thinking: bool = True,
         reasoning_effort: str = "high", temperature: float = 1.0,
         max_tokens: Optional[int] = None,
         timeout: Optional[int] = None) -> Dict[str, Any]:
    """非流式调用，一次性返回完整结果。"""
    request = _build_request(
        messages,
        stream=False,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        temperature=temperature,
        max_tokens=max_tokens or config.DEEPSEEK_MAX_TOKENS,
    )
    with _open(request, timeout or config.DEEPSEEK_TIMEOUT) as response:
        raw = response.read().decode("utf-8", "replace")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DeepSeekError("无法解析 DeepSeek 返回的数据。", detail=raw[:500]) from exc

    choices = data.get("choices") or []
    if not choices:
        raise DeepSeekError("DeepSeek 未返回任何内容，请重试。", detail=raw[:500])

    message = choices[0].get("message") or {}
    return {
        "content": (message.get("content") or "").strip(),
        "reasoning": (message.get("reasoning_content") or "").strip(),
        "usage": data.get("usage") or {},
        "model": data.get("model") or config.DEEPSEEK_MODEL,
        "finish_reason": choices[0].get("finish_reason"),
    }


def chat_stream(messages: List[Dict[str, str]], *, thinking: bool = True,
                reasoning_effort: str = "high", temperature: float = 1.0,
                max_tokens: Optional[int] = None,
                timeout: Optional[int] = None
                ) -> Iterator[Tuple[str, Any]]:
    """
    流式调用，逐块产出事件：

        ("reasoning", "思考片段")   思考过程增量
        ("content",   "正文片段")   学习计划正文增量
        ("usage",     {...})         token 用量（最后一个数据块）
        ("finish",    "stop")        结束原因
    """
    request = _build_request(
        messages,
        stream=True,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        temperature=temperature,
        max_tokens=max_tokens or config.DEEPSEEK_MAX_TOKENS,
    )
    response = _open(request, timeout or config.DEEPSEEK_TIMEOUT)
    try:
        for raw_line in _iter_lines(response):
            line = raw_line.strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue

            usage = chunk.get("usage")
            if usage:
                yield "usage", usage

            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                reasoning = delta.get("reasoning_content")
                if reasoning:
                    yield "reasoning", reasoning
                content = delta.get("content")
                if content:
                    yield "content", content
                if choice.get("finish_reason"):
                    yield "finish", choice["finish_reason"]
    finally:
        response.close()


def _iter_lines(response, chunk_size: int = 4096) -> Iterable[str]:
    """
    按行读取 SSE。

    优先用 read1()：它最多触发一次底层读取，拿到多少返回多少，
    这样模型每吐出一个片段就能立刻转发给前端，而不是等缓冲区填满。
    """
    pull = getattr(response, "read1", None) or response.read
    buffer = b""
    while True:
        block = pull(chunk_size)
        if not block:
            break
        buffer += block
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            yield line.decode("utf-8", "replace")
    if buffer:
        yield buffer.decode("utf-8", "replace")
