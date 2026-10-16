@echo off
echo ========================================
echo   PMS - Starting All Services
echo ========================================
echo.
echo [1/2] Starting Backend (FastAPI)...
start "PMS Backend" cmd /k "cd /d "%~dp0backend" && python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

timeout /t 3 /nobreak >nul

echo [2/2] Starting Frontend (React)...
start "PMS Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

timeout /t 4 /nobreak >nul

echo.
echo ========================================
echo   Both services started!
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:5173
echo   API Docs: http://localhost:8000/docs
echo ========================================
echo.
echo Opening browser...
start http://localhost:5173
