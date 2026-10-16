@echo off
echo ========================================
echo   PMS - First Time Setup
echo ========================================
echo.
echo This will create the MySQL database and tables.
echo Make sure MySQL service is running first!
echo.
cd /d "%~dp0backend"
python setup_db.py
echo.
pause
