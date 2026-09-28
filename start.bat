@echo off
chcp 65001 >nul
title 学习计划定制系统
cd /d "%~dp0"

echo ============================================================
echo   学习计划定制系统  -  正在启动
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 python 命令，请先安装 Python 3.8+ 并加入 PATH。
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [提示] 没有找到 .env，正在根据 .env.example 生成...
  copy /y ".env.example" ".env" >nul
  echo [提示] 请打开 .env 填入你的 DEEPSEEK_API_KEY 后重新运行本脚本。
  echo.
  pause
  exit /b 1
)

rem 3 秒后自动打开浏览器（此时服务已就绪）
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:8000/'"

echo   即将打开浏览器：http://127.0.0.1:8000/
echo   按 Ctrl+C 可停止服务
echo.
python backend\server.py

echo.
echo 服务已停止。
pause
