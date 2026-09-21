@echo off
rem ============================================================
rem  Shi Wei Shu Ji - start the game server (just double-click)
rem  Port 8787, data: data\osm\osm.sqlite
rem  Keep this window open; closing it stops the server.
rem  Then open http://127.0.0.1:8787/ in your browser.
rem  (ASCII only on purpose: Chinese text in .cmd breaks on some codepages)
rem ============================================================
cd /d "%~dp0"
title Shi Wei Shu Ji - server (8787)

rem --- make sure node is reachable even if it is not in PATH ---
set "NODE_EXE="
for %%D in (
  "C:\Users\Steve-Game\AppData\Roaming\io.github.hairyf.deepseek-harness-desktop\runtime"
  "%ProgramFiles%\nodejs"
  "%ProgramFiles(x86)%\nodejs"
  "%LOCALAPPDATA%\Programs\nodejs"
  "%APPDATA%\nvm"
) do (
  if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
)
if not defined NODE_EXE (
  for /f "delims=" %%P in ('where node 2^>nul') do set "NODE_EXE=%%P"
)
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install Node 20+ from https://nodejs.org/
  pause
  exit /b 1
)

echo Node: %NODE_EXE%
echo Starting server on http://127.0.0.1:8787/ ...
echo First start takes about 10-15 seconds (building the road graph).
echo The page shows a progress bar while it initializes.
echo Press Ctrl+C to stop the server (world data is saved automatically).
echo.
"%NODE_EXE%" server\index.js %*
echo.
echo Server exited (see the reason above). Press any key to close.
pause >nul
