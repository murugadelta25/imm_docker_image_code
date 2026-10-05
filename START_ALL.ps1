# START_ALL.ps1 — Start EAP IMM PMS on Windows
# Run from project root: .\START_ALL.ps1
# IMM ports: frontend 5174, backend 8040 (PMS uses 5173 / 8030)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend  = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

Write-Host "Starting Backend on :8040..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", @"
  cd '$backend'
  if (Test-Path '.venv\Scripts\Activate.ps1') { .\.venv\Scripts\Activate.ps1 }
  elseif (Test-Path 'venv\Scripts\Activate.ps1') { .\venv\Scripts\Activate.ps1 }
  else { python -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt }
  uvicorn app.main:app --host 0.0.0.0 --port 8040 --reload
"@

Start-Sleep -Seconds 2

Write-Host "Starting Frontend on :5174..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", @"
  cd '$frontend'
  if (-not (Test-Path 'node_modules')) { npm install }
  npm run dev -- --host 0.0.0.0 --port 5174
"@

Write-Host ""
Write-Host "EAP IMM PMS starting..." -ForegroundColor Green
Write-Host "   Frontend : http://localhost:5174" -ForegroundColor Yellow
Write-Host "   Backend  : http://localhost:8040" -ForegroundColor Yellow
Write-Host "   API Docs : http://localhost:8040/docs" -ForegroundColor Yellow
