@echo off
echo ========================================
echo   PMS - Backend Server
echo ========================================
cd /d "%~dp0backend"
echo Starting FastAPI backend on http://localhost:8000
echo API Docs available at http://localhost:8000/docs
echo Press Ctrl+C to stop
echo.
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
pause
