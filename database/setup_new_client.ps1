# Interactive setup for a new client database
param(
    [string]$ProjectDir = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "DbConfig.ps1")

$configPath = Get-DbConfigPath -ProjectDir $ProjectDir
if (-not (Test-Path $configPath)) {
    Copy-Item (Join-Path $PSScriptRoot "db.config.example.json") $configPath
}

Write-Host "EAP PMS - New Client Database Setup" -ForegroundColor Cyan
Write-Host ""
Write-Host "Config file: database\db.config.json" -ForegroundColor DarkGray
Write-Host "  clientName      - display name for this plant/client" -ForegroundColor DarkGray
Write-Host "  password        - MySQL root password" -ForegroundColor DarkGray
Write-Host "  database        - new database name" -ForegroundColor DarkGray
Write-Host "  migrate         - true = copy data from titan_oee, false = tables only" -ForegroundColor DarkGray
Write-Host "  legacyDatabase  - source DB when migrate=true (default: titan_oee)" -ForegroundColor DarkGray
Write-Host ""

$clientName = Read-Host "Client name (e.g. Delta_BLR_Plant)"
if (-not $clientName) { throw "Client name is required." }

$defaultDb = ("eap_pms_" + ($clientName -replace '[^a-zA-Z0-9_]','_')).ToLower()
$dbName = Read-Host "Database name [$defaultDb]"
if (-not $dbName) { $dbName = $defaultDb }

$secure = Read-Host "MySQL password (root user)" -AsSecureString
$dbPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$migrateAnswer = Read-Host "Migrate data from titan_oee? [y/N]"
$migrate = $migrateAnswer -match '^(y|yes|true|1)$'

$legacyDb = 'titan_oee'
if ($migrate) {
    $legacyInput = Read-Host "Legacy source database [$legacyDb]"
    if ($legacyInput) { $legacyDb = $legacyInput }
}

@{
    clientName       = $clientName
    password         = $dbPassword
    database         = $dbName
    migrate          = $migrate
    legacyDatabase   = $legacyDb
} | ConvertTo-Json | Set-Content -Path $configPath -Encoding utf8

Write-Host ""
Write-Host "Saved $configPath" -ForegroundColor Green
Write-Host "  migrate = $migrate" -ForegroundColor $(if ($migrate) { 'Yellow' } else { 'Green' })

& (Join-Path $PSScriptRoot "init_database.ps1") -ProjectDir $ProjectDir

Write-Host ""
if ($migrate) {
    Write-Host "Client '$clientName' is ready WITH data migrated from $legacyDb." -ForegroundColor Green
} else {
    Write-Host "Client '$clientName' is ready (all tables, no business data)." -ForegroundColor Green
    Write-Host "Default login: operator1 / op123" -ForegroundColor Yellow
}
Write-Host "Run .\run.ps1 to start the application." -ForegroundColor Yellow
