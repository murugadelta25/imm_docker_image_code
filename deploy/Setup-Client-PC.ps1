# Client PC setup - maps din.eappms to the IPC server IP in the Windows hosts file.
#
# EASIEST: copy deploy\Setup-Client-PC.bat to the client PC (the .ps1 file is optional).
#   Right-click Setup-Client-PC.bat -> Run as administrator
#
# Or copy BOTH Setup-Client-PC.bat and Setup-Client-PC.ps1 to the same folder.
#
# Or PowerShell as Administrator:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-Client-PC.ps1 -ServerIp 10.151.47.6

param(
    [string]$ServerIp = "10.151.47.6",
    [string]$Domain = "din.eappms"
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-Host "[FAIL] Run PowerShell as Administrator." -ForegroundColor Red
    exit 1
}

if ($ServerIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    Write-Host "[FAIL] Invalid IP: $ServerIp" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  EAP PMS - Client PC setup" -ForegroundColor Cyan
Write-Host "  This PC   : $((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^127\.' } | Select-Object -First 1 -ExpandProperty IPAddress))" -ForegroundColor White
Write-Host "  IPC server: $ServerIp" -ForegroundColor White
Write-Host "  URL       : http://$Domain" -ForegroundColor White
Write-Host ""

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$lines = @(Get-Content $hostsPath -ErrorAction SilentlyContinue)
$escaped = [regex]::Escape($Domain)
$filtered = $lines | Where-Object { $_ -notmatch "\s$escaped(\s|$)" }
($filtered + @("", "# EAP PMS client - Setup-Client-PC.ps1", "$ServerIp`t$Domain")) |
    Set-Content -Path $hostsPath -Encoding ASCII

ipconfig /flushdns | Out-Null

Write-Host "[OK] Hosts: $ServerIp -> $Domain" -ForegroundColor Green

$ping = Test-Connection -ComputerName $ServerIp -Count 1 -Quiet -ErrorAction SilentlyContinue
if ($ping) {
    Write-Host "[OK] Ping to IPC server succeeded" -ForegroundColor Green
} else {
    Write-Host "[WARN] Cannot ping $ServerIp - check network/VLAN routing (10.151.32.x to 10.151.47.x)" -ForegroundColor Yellow
}

$port = Test-NetConnection -ComputerName $ServerIp -Port 80 -WarningAction SilentlyContinue
if ($port.TcpTestSucceeded) {
    Write-Host "[OK] Port 80 on IPC server is reachable" -ForegroundColor Green
} else {
    Write-Host "[WARN] Port 80 not reachable on $ServerIp" -ForegroundColor Yellow
    Write-Host "       On IPC server: run run.ps1 as Administrator (nginx + firewall)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Open: http://$Domain" -ForegroundColor Green
Write-Host ""

Start-Process "http://$Domain"
