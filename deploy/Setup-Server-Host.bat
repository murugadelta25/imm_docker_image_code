@echo off
REM EAP PMS - register din.eappms on the IPC SERVER (this PC).
REM Right-click -> Run as administrator  (or double-click and approve UAC)

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting Administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Server-Host.ps1"
pause
