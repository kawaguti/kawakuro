@echo off
chcp 65001 >nul
cd /d %~dp0

rem node_modules はPCごとに作る（Dropboxでは同期しない）
if not exist node_modules (
  mkdir node_modules
  powershell -NoProfile -Command "Set-Content -Path node_modules -Stream com.dropbox.ignored -Value 1"
  echo 初回なので npm ci を実行します...
  call npm ci --no-audit --no-fund
)

if not exist .env (
  echo .env がありません。.env.example をコピーして .env を作ってください。
  pause
  exit /b 1
)

call npm start
pause
