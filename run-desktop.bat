@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [LowCon] Node.js 22+ is required but was not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [LowCon] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [LowCon] npm install failed.
    pause
    exit /b 1
  )
)

echo [LowCon] Building production bundle for Desktop...
call npm run build
if errorlevel 1 (
  echo [LowCon] Build failed.
  pause
  exit /b 1
)

echo [LowCon] Launching LowCon Desktop App...
call "node_modules\.bin\electron.cmd" desktop/main.cjs
if errorlevel 1 (
  echo.
  echo [LowCon] Desktop app exited with an error.
  pause
  exit /b 1
)
