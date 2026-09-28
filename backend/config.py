# -*- coding: utf-8 -*-
"""
全局配置。

配置优先级：真实环境变量 > 项目根目录下的 .env 文件 > 代码里的默认值。
这样既能开箱即用（.env 已带好 Key），也方便部署时用环境变量覆盖。
"""

import os
import pathlib

# ---------------------------------------------------------------- 路径
BASE_DIR = pathlib.Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
ENV_FILE = BASE_DIR / ".env"


def _load_env_file(path: pathlib.Path) -> None:
    """极简 .env 解析器：KEY=VALUE，支持 # 注释与引号，不覆盖已有环境变量。"""
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file(ENV_FILE)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


# ------------------------------------------------------- DeepSeek 大模型
# 官方文档：https://api-docs.deepseek.com/zh-cn/
# OpenAI 兼容格式的 base_url 为 https://api.deepseek.com
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip().rstrip("/")

# 界面上的 DeepSeek-V4.1-Flash（DeepSeek V4.1 Flash），在 API 里对应的模型 ID 是 deepseek-flash。
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-flash").strip()

# 生成一份完整学习计划耗时较长，超时给宽一些（秒）。
DEEPSEEK_TIMEOUT = _env_int("DEEPSEEK_TIMEOUT", 300)
DEEPSEEK_MAX_TOKENS = _env_int("DEEPSEEK_MAX_TOKENS", 8192)
DEEPSEEK_TEMPERATURE = _env_float("DEEPSEEK_TEMPERATURE", 1.0)

# ------------------------------------------------------------ 本地服务
HOST = os.getenv("HOST", "127.0.0.1").strip()
PORT = _env_int("PORT", 8000)

# 允许跨域的来源；前端若由本服务托管则同源，无需跨域。
ALLOW_ORIGINS = [
    o.strip() for o in os.getenv("ALLOW_ORIGINS", "*").split(",") if o.strip()
]
