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

echo [LowCon] Starting LowCon Web App on http://localhost:3000 ...
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
call npm run dev
if errorlevel 1 (
  echo.
  echo [LowCon] Web server exited with an error.
  pause
  exit /b 1
)
