#!/usr/bin/env sh
# 学习计划定制系统 —— macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[提示] 没有找到 .env，正在根据 .env.example 生成..."
  cp .env.example .env
  echo "[提示] 请先编辑 .env 填入 DEEPSEEK_API_KEY，然后重新运行本脚本。"
  exit 1
fi

PY=python3
command -v $PY >/dev/null 2>&1 || PY=python

echo "服务启动后请访问 http://127.0.0.1:8000/"
echo "按 Ctrl+C 停止服务"
exec $PY backend/server.py
