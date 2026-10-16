# Backup current eap_pms database before restore/migration
param(
    [string]$MySqlBin = "C:\Program Files\MySQL\MySQL Server 8.0\bin",
    [string]$DbName = "eap_pms",
    [string]$DbUser = "root",
    [string]$DbPassword = ""
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path $PSScriptRoot -Parent
$BackupDir = Join-Path $PSScriptRoot "backups"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

if (-not $DbPassword) {
    $configFile = Join-Path $ProjectDir "database\db.config.json"
    if (Test-Path $configFile) {
        $raw = Get-Content $configFile -Raw | ConvertFrom-Json
        $DbUser = [string]$raw.mysql.user
        $DbPassword = [string]$raw.mysql.password
        if (-not $DbName -or $DbName -eq "eap_pms") {
            $DbName = [string]$raw.database
        }
    } else {
        $envFile = Join-Path $ProjectDir "backend\.env"
        if (Test-Path $envFile) {
            $line = Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
            if ($line -match '//([^:]+):([^@]+)@[^/]+/([^?]+)') {
                $DbUser = $Matches[1]
                $DbPassword = [uri]::UnescapeDataString($Matches[2])
                $DbName = $Matches[3]
            }
        }
    }
}

if (-not $DbPassword) {
    $secure = Read-Host "MySQL password for $DbUser" -AsSecureString
    $DbPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outFile = Join-Path $BackupDir "${DbName}_backup_${stamp}.sql"
$mysqldump = Join-Path $MySqlBin "mysqldump.exe"

if (-not (Test-Path $mysqldump)) {
    throw "mysqldump not found at $mysqldump"
}

Write-Host "Backing up $DbName to $outFile ..."
$env:MYSQL_PWD = $DbPassword
& $mysqldump --user=$DbUser --host=localhost --routines --triggers --single-transaction $DbName |
    Set-Content -Path $outFile -Encoding utf8
Remove-Item Env:MYSQL_PWD

if ($LASTEXITCODE -ne 0) { throw "mysqldump failed with exit code $LASTEXITCODE" }
Write-Host "Backup complete: $outFile"
