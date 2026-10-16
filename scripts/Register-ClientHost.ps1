# Register din.eappms on THIS PC so the browser can resolve the EAP PMS server.
# Run on every operator/supervisor PC (not only the IPC server).
#
# Usage (PowerShell as Administrator):
#   .\scripts\Register-ClientHost.ps1 -ServerIp 192.168.1.116
#
# Or let the script prompt for the IPC server IP.

param(
    [string]$ServerIp = "",
    [string]$Domain = ""
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path $PSScriptRoot -Parent
$domainConfig = Join-Path $ProjectDir "deploy\domain.config.json"
if (-not $Domain -and (Test-Path $domainConfig)) {
    $Domain = [string]((Get-Content $domainConfig -Raw | ConvertFrom-Json).domain)
}
if (-not $Domain) { $Domain = "din.eappms" }

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-Host "[FAIL] Run PowerShell as Administrator." -ForegroundColor Red
    Write-Host "  Right-click PowerShell -> Run as administrator" -ForegroundColor Yellow
    exit 1
}

if (-not $ServerIp) {
    Write-Host ""
    Write-Host "  EAP PMS - register hostname on this PC" -ForegroundColor Cyan
    Write-Host "  Domain : $Domain" -ForegroundColor White
    Write-Host ""
    $ServerIp = Read-Host "  Enter IPC server IP (e.g. 192.168.1.116)"
    $ServerIp = $ServerIp.Trim()
}

if ($ServerIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    Write-Host "[FAIL] Invalid IP address: $ServerIp" -ForegroundColor Red
    exit 1
}

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$lines = @(Get-Content $hostsPath -ErrorAction SilentlyContinue)
$escaped = [regex]::Escape($Domain)
$filtered = $lines | Where-Object { $_ -notmatch "\s$escaped(\s|$)" -and $_ -notmatch "^\s*#" }
$newLines = $filtered + @("", "# EAP PMS - added by Register-ClientHost.ps1", "$ServerIp`t$Domain")
$newLines | Set-Content -Path $hostsPath -Encoding ASCII

Write-Host ""
Write-Host "[OK] Hosts file updated:" -ForegroundColor Green
Write-Host "     $ServerIp   $Domain" -ForegroundColor White
Write-Host ""
Write-Host "  Open in browser: http://$Domain" -ForegroundColor Green
Write-Host ""

# Quick connectivity check
try {
    $r = Test-NetConnection -ComputerName $ServerIp -Port 80 -WarningAction SilentlyContinue
    if ($r.TcpTestSucceeded) {
        Write-Host "[OK] IPC server port 80 is reachable" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Cannot reach $ServerIp`:80 - check IPC firewall and run.ps1 on server" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[WARN] Could not test port 80 on $ServerIp" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Tip: flush DNS cache if the browser still fails:" -ForegroundColor DarkGray
Write-Host "       ipconfig /flushdns" -ForegroundColor DarkGray
Write-Host ""

try {
    Start-Process "http://$Domain"
} catch { }
