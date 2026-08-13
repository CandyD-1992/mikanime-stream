@echo off
setlocal
cd /d "%~dp0"

rem Find Node.js: system PATH -> common install dirs -> Codex runtime
set "NODE_BIN="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_BIN=node"
if defined NODE_BIN goto found

if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"
if defined NODE_BIN goto found

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_BIN goto found

if exist "C:\Users\cdd\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_BIN=C:\Users\cdd\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if defined NODE_BIN goto found

echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org
pause
exit /b 1

:found
echo Starting Mikan server (search proxy + wasmnet relay)
echo   Local:  http://127.0.0.1:3000/p2p/index.html
netsh advfirewall firewall delete rule name="Mikan Stream 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Mikan Stream 3000" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3000/p2p/index.html"
"%NODE_BIN%" server.mjs
pause
exit /b 0
