# Backup local deploy settings (no secrets) and optional DB snapshot.
# Usage: .\scripts\backup-settings.ps1
param(
    [switch]$SkipDbBackup
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

$venvPy = Join-Path $ProjectDir "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { $venvPy = "python" }

Write-Host "[..] Exporting app config templates for Git..." -ForegroundColor Cyan
& $venvPy (Join-Path $ProjectDir "scripts\export_app_config.py")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupRoot = Join-Path $ProjectDir "database\backups\settings"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

$toCopy = @(
    @{ Src = "deploy\domain.config.json"; Dest = "domain.config.json" },
    @{ Src = "deploy.env.example"; Dest = "deploy.env.example" }
)
foreach ($item in $toCopy) {
    $src = Join-Path $ProjectDir $item.Src
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $backupRoot "$stamp-$($item.Dest)") -Force
    }
}

if (-not $SkipDbBackup) {
    $dbCfg = Join-Path $ProjectDir "database\db.config.json"
    if (Test-Path $dbCfg) {
        . (Join-Path $ProjectDir "database\DbConfig.ps1")
        $cfg = Get-DbConfig -ProjectDir $ProjectDir
        $dump = Get-Command mysqldump -ErrorAction SilentlyContinue
        if ($dump) {
            $out = Join-Path $backupRoot "$stamp-$($cfg.Database).sql"
            $env:MYSQL_PWD = $cfg.Password
            & mysqldump -u $cfg.User -h localhost $cfg.Database | Set-Content -Encoding utf8 $out
            Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
            Write-Host "[OK] DB backup -> $out" -ForegroundColor Green
        }
    }
}

Write-Host "[OK] Settings backup complete. Commit deploy/config-templates/ after review." -ForegroundColor Green
