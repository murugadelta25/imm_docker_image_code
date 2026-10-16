# Shared database configuration helpers for EAP PMS deployment scripts.
# Source this file: . (Join-Path $PSScriptRoot "DbConfig.ps1")

function Write-Utf8NoBomFile {
    param(
        [string]$Path,
        [string[]]$Lines
    )
    $content = ($Lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Get-DbConfigPath {
    param([string]$ProjectDir = (Split-Path $PSScriptRoot -Parent))
    Join-Path $ProjectDir "database\db.config.json"
}

function Get-DbConfig {
    param([string]$ProjectDir = (Split-Path $PSScriptRoot -Parent))

    $configPath = Get-DbConfigPath -ProjectDir $ProjectDir
    if (-not (Test-Path $configPath)) {
        throw "Database config not found: $configPath`nCopy database\db.config.example.json to database\db.config.json and edit it."
    }

    $raw = Get-Content $configPath -Raw | ConvertFrom-Json
    $dbName = [string]$raw.database
    if (-not $dbName) { throw "database is required in db.config.json" }
    $migrate = $false
    if ($raw.PSObject.Properties.Name -contains 'migrate') {
        $migrate = [bool]$raw.migrate
    } elseif ($raw.PSObject.Properties.Name -contains 'autoMigrateFromLegacy') {
        $migrate = [bool]$raw.autoMigrateFromLegacy
    }

    $legacyDb = 'titan_oee'
    if ($raw.PSObject.Properties.Name -contains 'legacyDatabase' -and $raw.legacyDatabase) {
        $legacyDb = [string]$raw.legacyDatabase
    }

    return [ordered]@{
        ClientName      = [string]$raw.clientName
        Host            = if ($raw.PSObject.Properties.Name -contains 'host' -and $raw.host) { [string]$raw.host } else { 'localhost' }
        Port            = if ($raw.PSObject.Properties.Name -contains 'port' -and $raw.port) { [int]$raw.port } else { 3306 }
        User            = if ($raw.PSObject.Properties.Name -contains 'user' -and $raw.user) { [string]$raw.user } else { 'root' }
        Password        = [string]$raw.password
        Database        = $dbName
        Migrate         = $migrate
        LegacyDatabase  = $legacyDb
        ConfigPath      = $configPath
        ProjectDir      = $ProjectDir
    }
}

function Get-DatabaseUrl {
    param($DbConfig)
    $encodedPw = [uri]::EscapeDataString($DbConfig.Password)
    return "mysql+pymysql://$($DbConfig.User):$encodedPw@$($DbConfig.Host):$($DbConfig.Port)/$($DbConfig.Database)"
}

function Sync-BackendEnv {
    param(
        $DbConfig,
        [switch]$PreserveSmtp
    )

    $envFile = Join-Path $DbConfig.ProjectDir "backend\.env"
    $databaseUrl = Get-DatabaseUrl -DbConfig $DbConfig
    $secretKey = "eap_pms_$($DbConfig.ClientName -replace '[^a-zA-Z0-9_]','_')_secret"

    $smtp = @{
        SMTP_HOST  = "smtp.gmail.com"
        SMTP_PORT  = "587"
        SMTP_USER  = ""
        SMTP_PASS  = ""
        SMTP_FROM  = ""
    }

    if ($PreserveSmtp -and (Test-Path $envFile)) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASS|SMTP_FROM)=(.*)$') {
                $smtp[$Matches[1]] = $Matches[2]
            }
        }
    }

    Write-Utf8NoBomFile -Path $envFile -Lines @(
        "DATABASE_URL=$databaseUrl"
        "SECRET_KEY=$secretKey"
        "ACCESS_TOKEN_EXPIRE_MINUTES=480"
        "SMTP_HOST=$($smtp.SMTP_HOST)"
        "SMTP_PORT=$($smtp.SMTP_PORT)"
        "SMTP_USER=$($smtp.SMTP_USER)"
        "SMTP_PASS=$($smtp.SMTP_PASS)"
        "SMTP_FROM=$($smtp.SMTP_FROM)"
    )
}

function Get-MySqlExe {
    param([string]$MySqlBin = "")
    if ($MySqlBin) {
        $candidate = Join-Path $MySqlBin "mysql.exe"
        if (Test-Path $candidate) { return $candidate }
    }
    $candidates = @(
        "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe",
        "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe",
        "C:\xampp\mysql\bin\mysql.exe"
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    $cmd = Get-Command mysql -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-MySqlDumpExe {
    param([string]$MySqlExe)
    $dir = Split-Path $MySqlExe -Parent
    $dump = Join-Path $dir "mysqldump.exe"
    if (Test-Path $dump) { return $dump }
    return $null
}

function Invoke-MySqlQuery {
    param(
        [string]$MySqlExe,
        [string]$User,
        [string]$Password,
        [string]$Query,
        [string]$Database = ""
    )
    $env:MYSQL_PWD = $Password
    $args = @("--user=$User", "--host=localhost", "--batch", "--skip-column-names")
    if ($Database) { $args += $Database }
    $args += "-e", $Query
    $output = & $MySqlExe @args 2>&1
    Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
    return $output
}

function Invoke-MySqlQueryFromConfig {
    param($DbConfig, [string]$MySqlExe, [string]$Query, [string]$Database = "")
    Invoke-MySqlQuery -MySqlExe $MySqlExe -User ([string]$DbConfig.User) -Password ([string]$DbConfig.Password) `
        -Query $Query -Database $Database
}

function Test-DatabaseExists {
    param($DbConfig, [string]$DatabaseName, [string]$MySqlExe)
    $escaped = $DatabaseName.Replace("'", "''")
    $result = Invoke-MySqlQueryFromConfig -DbConfig $DbConfig -MySqlExe $MySqlExe `
        -Query "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$escaped'"
    return [int]$result -gt 0
}

function Get-DatabaseTableCount {
    param($DbConfig, [string]$MySqlExe)
    $escaped = ([string]$DbConfig.Database).Replace("'", "''")
    return [int](Invoke-MySqlQueryFromConfig -DbConfig $DbConfig -MySqlExe $MySqlExe `
        -Query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$escaped'")
}
