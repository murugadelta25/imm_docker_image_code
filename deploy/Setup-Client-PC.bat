@echo off
REM EAP PMS - register din.eappms on this client PC.
REM Copy this .bat to any PC (Setup-Client-PC.ps1 optional - same folder).
REM Right-click -> Run as administrator

set "SERVER_IP=10.151.47.6"
if not "%~1"=="" set "SERVER_IP=%~1"

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting Administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%SERVER_IP%' -Verb RunAs"
    exit /b
)

if not "%~1"=="" set "SERVER_IP=%~1"

if exist "%~dp0Setup-Client-PC.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Client-PC.ps1" -ServerIp %SERVER_IP%
    goto :done
)

echo [INFO] Setup-Client-PC.ps1 not found - using built-in setup (single .bat is OK)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$ServerIp='%SERVER_IP%';" ^
  "$Domain='din.eappms';" ^
  "$id=[Security.Principal.WindowsIdentity]::GetCurrent();" ^
  "$p=New-Object Security.Principal.WindowsPrincipal($id);" ^
  "if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Write-Host '[FAIL] Run as Administrator' -ForegroundColor Red; exit 1};" ^
  "if($ServerIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$'){Write-Host '[FAIL] Invalid IP' -ForegroundColor Red; exit 1};" ^
  "Write-Host '';" ^
  "Write-Host '  EAP PMS - Client PC setup' -ForegroundColor Cyan;" ^
  "Write-Host ('  IPC server: ' + $ServerIp) -ForegroundColor White;" ^
  "Write-Host ('  URL       : http://' + $Domain) -ForegroundColor White;" ^
  "Write-Host '';" ^
  "$hostsPath=Join-Path $env:SystemRoot 'System32\drivers\etc\hosts';" ^
  "$lines=@(Get-Content $hostsPath -ErrorAction SilentlyContinue);" ^
  "$escaped=[regex]::Escape($Domain);" ^
  "$filtered=$lines | Where-Object { $_ -notmatch ('\s' + $escaped + '(\s|$)') };" ^
  "$row=$ServerIp + [char]9 + $Domain;" ^
  "($filtered + @('','# EAP PMS client - Setup-Client-PC.bat',$row)) | Set-Content -Path $hostsPath -Encoding ASCII;" ^
  "ipconfig /flushdns | Out-Null;" ^
  "Write-Host ('[OK] Hosts: ' + $ServerIp + ' -^> ' + $Domain) -ForegroundColor Green;" ^
  "$t=Test-NetConnection -ComputerName $ServerIp -Port 80 -WarningAction SilentlyContinue;" ^
  "if($t.TcpTestSucceeded){Write-Host '[OK] Port 80 on IPC server is reachable' -ForegroundColor Green}else{Write-Host '[WARN] Port 80 not reachable - check IPC server and firewall' -ForegroundColor Yellow};" ^
  "Write-Host '';" ^
  "Write-Host ('  Open: http://' + $Domain) -ForegroundColor Green;" ^
  "Write-Host '';" ^
  "Start-Process ('http://' + $Domain)"

:done
pause
