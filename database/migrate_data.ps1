# Copy data from legacy DB into the current client DB (uses db.config.json settings).
# Tip: set "migrate": true in db.config.json and run init_database.ps1 instead.
param(
    [string]$ProjectDir = (Split-Path $PSScriptRoot -Parent),
    [string]$SourceDb = "",
    [string]$TargetDb = "",
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "DbConfig.ps1")

$cfg = Get-DbConfig -ProjectDir $ProjectDir
if (-not $SourceDb) { $SourceDb = $cfg.LegacyDatabase }
if (-not $TargetDb) { $TargetDb = $cfg.Database }

& (Join-Path $PSScriptRoot "migrate_legacy_db.ps1") `
    -ProjectDir $ProjectDir -SourceDb $SourceDb -TargetDb $TargetDb -SkipBackup:$SkipBackup

$mysqlExe = Get-MySqlExe
$dbEscaped = $TargetDb.Replace('`', '``')
$pairMigrate = Join-Path $PSScriptRoot "migrate_pair_to_station.sql"
if ((Test-Path $pairMigrate) -and $mysqlExe) {
    $sql = (Get-Content $pairMigrate -Raw) -replace '(?i)USE\s+\w+\s*;', "USE ``$dbEscaped``;"
    $temp = [System.IO.Path]::GetTempFileName()
    try {
        Set-Content -Path $temp -Value $sql -Encoding utf8
        $env:MYSQL_PWD = [string]$cfg.Password
        $null = Get-Content $temp -Raw | & $mysqlExe "--user=$([string]$cfg.User)" --host=localhost 2>&1
        Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
        Write-Host "[OK] pair -> station upgrade applied" -ForegroundColor Green
    } finally {
        Remove-Item $temp -ErrorAction SilentlyContinue
    }
}

$schemaFile = Join-Path $PSScriptRoot "schema.sql"
if (Test-Path $schemaFile) {
    $schemaSql = (Get-Content $schemaFile -Raw) -replace '(?i)USE\s+\w+\s*;', "USE ``$dbEscaped``;"
    $temp = [System.IO.Path]::GetTempFileName()
    try {
        Set-Content -Path $temp -Value $schemaSql -Encoding utf8
        $env:MYSQL_PWD = [string]$cfg.Password
        $null = Get-Content $temp -Raw | & $mysqlExe "--user=$([string]$cfg.User)" --host=localhost 2>&1
        Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
        Write-Host "[OK] schema.sql applied (missing tables/columns filled)" -ForegroundColor Green
    } finally {
        Remove-Item $temp -ErrorAction SilentlyContinue
    }
}

Write-Host "Data migration complete: $SourceDb -> $TargetDb" -ForegroundColor Green
