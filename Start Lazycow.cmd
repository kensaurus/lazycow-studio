@echo off
rem Lazycow Studio: double-click me. The first time I install everything (scripts\bootstrap\windows.ps1);
rem after that I just open the studio. Read README.TXT first. It is 1997 in there.
title Lazycow Studio
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\Lazycow\node\node.exe" if exist "%~dp0.env" (
  "%LOCALAPPDATA%\Lazycow\node\node.exe" "%~dp0scripts\app.mjs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap\windows.ps1"
