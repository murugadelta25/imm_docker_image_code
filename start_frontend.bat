@echo off
echo ========================================
echo   PMS - Frontend (React)
echo ========================================
cd /d "%~dp0frontend"
echo Starting React frontend on http://localhost:5173
echo Press Ctrl+C to stop
echo.
npm run dev
pause
