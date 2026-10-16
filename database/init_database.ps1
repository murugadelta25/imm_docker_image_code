# Create database, apply full schema (same tables as titan_oee), optionally copy data from legacy DB.
param(
    [string]$ProjectDir = (Split-Path $PSScriptRoot -Parent),
    [switch]$SkipMigrate,
    [switch]$ForceSchema
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "DbConfig.ps1")

$cfg = Get-DbConfig -ProjectDir $ProjectDir
$mysqlExe = Get-MySqlExe
if (-not $mysqlExe) { throw "mysql.exe not found. Install MySQL 8.x." }

# Core tables required (same set as titan_oee / eap_pms production schema)
$RequiredTables = @(
    'users', 'stations', 'pairs', 'machines', 'oee_entries', 'oee_defect_log',
    'model_change_requests', 'breakdown_tickets', 'production_plans',
    'machine_status_log', 'site_config', 'email_groups', 'email_recipients',
    'email_schedules', 'email_logs', 'email_smtp_config'
)

function Invoke-SqlFile {
    param([string]$SqlFile, [string]$DatabaseName = "")
    $sql = (Get-Content $SqlFile -Raw) -replace '(?i)USE\s+\w+\s*;', "USE ``$dbEscaped``;"
    $temp = [System.IO.Path]::GetTempFileName()
    try {
        Set-Content -Path $temp -Value $sql -Encoding utf8
        $env:MYSQL_PWD = [string]$cfg.Password
        if ($DatabaseName) {
            $out = Get-Content $temp -Raw | & $mysqlExe "--user=$([string]$cfg.User)" --host=localhost $DatabaseName 2>&1
        } else {
            $out = Get-Content $temp -Raw | & $mysqlExe "--user=$([string]$cfg.User)" --host=localhost 2>&1
        }
        Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
    } finally {
        Remove-Item $temp -ErrorAction SilentlyContinue
    }
}

function Invoke-PairToStationUpgrade {
    $pairMigrate = Join-Path $PSScriptRoot "migrate_pair_to_station.sql"
    if (-not (Test-Path $pairMigrate)) { return }
    $hasPairs = Invoke-MySqlQueryFromConfig -DbConfig $cfg -MySqlExe $mysqlExe -Database $cfg.Database `
        -Query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='pairs'"
    if ([int]$hasPairs -gt 0) {
        Write-Host "Upgrading pair -> station terminology ..." -ForegroundColor Yellow
        Invoke-SqlFile -SqlFile $pairMigrate -DatabaseName $cfg.Database
        Write-Host "[OK] migrate_pair_to_station.sql" -ForegroundColor Green
    }
}

function Get-MissingRequiredTables {
    $missing = @()
    foreach ($t in $RequiredTables) {
        if ($t -eq 'pairs' -or $t -eq 'stations') { continue }
        $esc = $t.Replace("'", "''")
        $exists = Invoke-MySqlQueryFromConfig -DbConfig $cfg -MySqlExe $mysqlExe -Database $cfg.Database `
            -Query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='$esc'"
        if ([int]$exists -eq 0) { $missing += $t }
    }
    $hasPairs = Invoke-MySqlQueryFromConfig -DbConfig $cfg -MySqlExe $mysqlExe -Database $cfg.Database `
        -Query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='pairs'"
    $hasStations = Invoke-MySqlQueryFromConfig -DbConfig $cfg -MySqlExe $mysqlExe -Database $cfg.Database `
        -Query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='stations'"
    if ([int]$hasPairs -eq 0 -and [int]$hasStations -eq 0) { $missing += 'stations' }
    return $missing
}

Write-Host "EAP PMS database setup" -ForegroundColor Cyan
Write-Host "  Client   : $($cfg.ClientName)"
Write-Host "  Database : $($cfg.Database)"
Write-Host "  Migrate  : $($cfg.Migrate) (data from $($cfg.LegacyDatabase))"
Write-Host ""

# 1) Create target database
$dbEscaped = $cfg.Database.Replace('`', '``')
Invoke-MySqlQueryFromConfig -DbConfig $cfg -MySqlExe $mysqlExe `
    -Query "CREATE DATABASE IF NOT EXISTS ``$dbEscaped`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
Write-Host "[OK] Database ensured: $($cfg.Database)" -ForegroundColor Green

$tableCount = 0
if (Test-DatabaseExists -DbConfig $cfg -DatabaseName $cfg.Database -MySqlExe $mysqlExe) {
    $tableCount = Get-DatabaseTableCount -DbConfig $cfg -MySqlExe $mysqlExe
}

$doDataMigrate = (-not $SkipMigrate) -and $cfg.Migrate -and $cfg.LegacyDatabase -and ($cfg.LegacyDatabase -ne $cfg.Database)

# 2) Path A - copy ALL data from legacy (titan_oee) into client DB
if ($doDataMigrate) {
    $legacyExists = Test-DatabaseExists -DbConfig $cfg -DatabaseName $cfg.LegacyDatabase -MySqlExe $mysqlExe
    if (-not $legacyExists) {
        Write-Host "[WARN] migrate=true but '$($cfg.LegacyDatabase)' not found - using schema-only setup" -ForegroundColor Yellow
        $doDataMigrate = $false
    } else {
        Write-Host "Migrating DATA from $($cfg.LegacyDatabase) -> $($cfg.Database) ..." -ForegroundColor Yellow
        & (Join-Path $PSScriptRoot "migrate_legacy_db.ps1") -ProjectDir $ProjectDir `
            -SourceDb $cfg.LegacyDatabase -TargetDb $cfg.Database
        Invoke-PairToStationUpgrade
        # Ensure any newer tables/columns from schema.sql exist after legacy restore
        $schemaFile = Join-Path $PSScriptRoot "schema.sql"
        if (Test-Path $schemaFile) {
            Invoke-SqlFile -SqlFile $schemaFile
            Write-Host "[OK] schema.sql applied (fills any missing tables/columns)" -ForegroundColor Green
        }
    }
}

# 3) Path B - schema only (no business data copied)
if (-not $doDataMigrate) {
    $schemaFile = Join-Path $PSScriptRoot "schema.sql"
    if (-not (Test-Path $schemaFile)) { throw "schema.sql not found: $schemaFile" }
    if ($ForceSchema -or $tableCount -lt 15) {
        Invoke-SqlFile -SqlFile $schemaFile
        Write-Host "[OK] schema.sql applied (all tables, no business data)" -ForegroundColor Green
    } else {
        Write-Host "[OK] schema already present ($tableCount tables)" -ForegroundColor Green
    }

    Invoke-PairToStationUpgrade

    # Incremental upgrades for very old DBs only
    if ($tableCount -ge 5 -and $tableCount -lt 15) {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        foreach ($name in @('migrate_email_logs.sql', 'migrate_machines.sql', 'migrate_plans.sql')) {
            $migratePath = Join-Path $PSScriptRoot $name
            if (-not (Test-Path $migratePath)) { continue }
            try { Invoke-SqlFile -SqlFile $migratePath -DatabaseName $cfg.Database; Write-Host "[OK] $name" -ForegroundColor Green }
            catch { Write-Host "[SKIP] $name" -ForegroundColor DarkYellow }
        }
        $ErrorActionPreference = $prevEap
    }

    # Default logins only when NOT migrating data and users table is empty
    $hasUsersTable = Invoke-MySqlQueryFromConfig -DbConfig $cfg -MySqlExe $mysqlExe -Database $cfg.Database `
        -Query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'"
    if ([int]$hasUsersTable -gt 0) {
        $users = Invoke-MySqlQueryFromConfig -DbConfig $cfg -MySqlExe $mysqlExe -Database $cfg.Database `
            -Query "SELECT COUNT(*) FROM users"
        if ([int]$users -eq 0) {
            $seedFile = Join-Path $PSScriptRoot "seed_minimal.sql"
            if (Test-Path $seedFile) {
                Invoke-SqlFile -SqlFile $seedFile -DatabaseName $cfg.Database
                Write-Host "[OK] seed_minimal.sql (default logins only)" -ForegroundColor Green
            }
        }
    }
}

# 4) Verify required tables
$missing = Get-MissingRequiredTables
$tableCount = Get-DatabaseTableCount -DbConfig $cfg -MySqlExe $mysqlExe
if ($missing.Count -gt 0) {
    Write-Host "[WARN] Missing tables: $($missing -join ', ')" -ForegroundColor Yellow
} else {
    Write-Host "[OK] All required tables present ($tableCount tables)" -ForegroundColor Green
}

# 5) Sync backend/.env
Sync-BackendEnv -DbConfig $cfg -PreserveSmtp
Write-Host "[OK] backend\.env synced from database\db.config.json" -ForegroundColor Green
Write-Host ""
if ($doDataMigrate) {
    Write-Host "Database ready with migrated data: $($cfg.Database)" -ForegroundColor Green
} else {
    Write-Host "Database ready (schema only): $($cfg.Database)" -ForegroundColor Green
}
