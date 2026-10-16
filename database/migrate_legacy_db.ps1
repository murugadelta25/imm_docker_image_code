# Copy all tables/data from a legacy database (e.g. titan_oee) into the target EAP PMS database.
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

if (-not $SourceDb) { throw "Source database not set. Pass -SourceDb or set legacyDatabase in db.config.json." }
if ($SourceDb -eq $TargetDb) { throw "Source and target database must be different." }

$mysqlExe = Get-MySqlExe
$mysqldumpExe = Get-MySqlDumpExe -MySqlExe $mysqlExe
if (-not $mysqlExe -or -not $mysqldumpExe) { throw "mysql.exe / mysqldump.exe not found." }

if (-not (Test-DatabaseExists -DbConfig $cfg -DatabaseName $SourceDb -MySqlExe $mysqlExe)) {
    throw "Source database '$SourceDb' does not exist."
}

$targetEscaped = $TargetDb.Replace('`', '``')
$createCfg = [ordered]@{ User = [string]$cfg.User; Password = [string]$cfg.Password; Database = $TargetDb }
Invoke-MySqlQueryFromConfig -DbConfig $createCfg -MySqlExe $mysqlExe `
    -Query "CREATE DATABASE IF NOT EXISTS ``$targetEscaped`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

if (-not $SkipBackup) {
    & (Join-Path $PSScriptRoot "backup_current_db.ps1") `
        -MySqlBin (Split-Path $mysqlExe -Parent) `
        -DbName $TargetDb `
        -DbUser $cfg.User `
        -DbPassword $cfg.Password
}

Write-Host "Dumping $SourceDb and restoring into $TargetDb ..." -ForegroundColor Cyan
$dbUser = [string]$cfg.User
$dbPassword = [string]$cfg.Password
$env:MYSQL_PWD = $dbPassword
try {
    & $mysqldumpExe "--user=$dbUser" --host=localhost --routines --triggers --single-transaction --set-gtid-purged=OFF $SourceDb |
        & $mysqlExe "--user=$dbUser" --host=localhost $TargetDb
    if ($LASTEXITCODE -ne 0) { throw "Migration failed during restore." }
} finally {
    Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}

$migrateCfg = [ordered]@{
    User     = $dbUser
    Password = $dbPassword
    Database = $TargetDb
}
$tableCount = Get-DatabaseTableCount -DbConfig $migrateCfg -MySqlExe $mysqlExe

Write-Host "[OK] Migrated $SourceDb -> $TargetDb ($tableCount tables)" -ForegroundColor Green
