# Backup current DB, restore eap_pms_FULL_PACKAGE dump, copy static assets
param(
    [string]$MySqlBin = "C:\Program Files\MySQL\MySQL Server 8.0\bin",
    [string]$DbName = "eap_pms",
    [string]$DbUser = "root",
    [string]$DbPassword = "",
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path $PSScriptRoot -Parent
$PackageDir = Join-Path $ProjectDir "eap_pms_FULL_PACKAGE"
$DumpFile = Join-Path $PackageDir "database\eap_pms_backup.sql"
$StaticSrc = Join-Path $PackageDir "backend\static\machines"
$StaticDst = Join-Path $ProjectDir "backend\static\machines"

if (-not (Test-Path $DumpFile)) {
    throw "Package dump not found: $DumpFile"
}

if (-not $SkipBackup) {
    & (Join-Path $PSScriptRoot "backup_current_db.ps1") -MySqlBin $MySqlBin -DbName $DbName -DbUser $DbUser -DbPassword $DbPassword
}

if (-not $DbPassword) {
    $envFile = Join-Path $ProjectDir "backend\.env"
    $line = Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
    if ($line -match '//[^:]+:([^@]+)@') {
        $DbPassword = [uri]::UnescapeDataString($Matches[1])
    }
}

$mysql = Join-Path $MySqlBin "mysql.exe"
if (-not (Test-Path $mysql)) { throw "mysql not found at $mysql" }

Write-Host "Restoring $DbName from package dump..."
$env:MYSQL_PWD = $DbPassword
& $mysql --user=$DbUser --host=localhost --execute="DROP DATABASE IF EXISTS ``$DbName``; CREATE DATABASE ``$DbName`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
if ($LASTEXITCODE -ne 0) { Remove-Item Env:MYSQL_PWD; throw "Failed to recreate database" }

Get-Content $DumpFile -Raw | & $mysql --user=$DbUser --host=localhost $DbName
if ($LASTEXITCODE -ne 0) { Remove-Item Env:MYSQL_PWD; throw "Restore failed" }
Remove-Item Env:MYSQL_PWD
Write-Host "Database restored successfully."

if (Test-Path $StaticSrc) {
    New-Item -ItemType Directory -Force -Path $StaticDst | Out-Null
    Copy-Item -Path (Join-Path $StaticSrc "*") -Destination $StaticDst -Force
    Write-Host "Copied machine images to $StaticDst"
}

Write-Host ""
Write-Host "Done. Restart the backend and login with operator1 / op123"
