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

if not exist "node_modules" (
  call npm install >nul 2>&1
  if errorlevel 1 (
    powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Failed to install LowCon dependencies (npm install).', 'LowCon', 0, 16)"
    exit /b 1
  )
)

call npm run build >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Failed to build LowCon desktop bundle (npm run build).', 'LowCon', 0, 16)"
  exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" desktop/main.cjs
  exit /b 0
)

call "node_modules\.bin\electron.cmd" desktop/main.cjs >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Failed to launch LowCon Desktop.', 'LowCon', 0, 16)"
  exit /b 1
)
