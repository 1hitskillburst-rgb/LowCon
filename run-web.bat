@echo off
setlocal
cd /d "%~dp0"

if /i "%~1" NEQ "--hidden" (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList '--hidden' -WindowStyle Hidden"
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Node.js 22+ is required to run LowCon, but was not found in PATH.', 'LowCon', 0, 16)"
  exit /b 1
)

netstat -ano | findstr /R ":3000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  start "" http://localhost:3000
  exit /b 0
)

if not exist "node_modules" (
  call npm install >nul 2>&1
  if errorlevel 1 (
    powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Failed to install LowCon dependencies (npm install).', 'LowCon', 0, 16)"
    exit /b 1
  )
)

start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
call npm run dev >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('LowCon web server exited unexpectedly.', 'LowCon', 0, 16)"
  exit /b 1
)
