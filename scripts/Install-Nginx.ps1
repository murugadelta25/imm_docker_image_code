# Configure nginx reverse proxy for din.eappms (Windows)
# nginx is installed under %ProgramData%\EAP-PMS\nginx-win (no spaces in path).
param(
    [string]$ProjectDir = (Split-Path $PSScriptRoot -Parent),
    [int]$BackendPort = 8040,
    [int]$FrontendPort = 5174
)

$ErrorActionPreference = "Stop"

$script:NginxRoot = Join-Path $env:ProgramData "EAP-PMS\nginx-win"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-NginxPrefixWritable {
    param([string]$Prefix)
    $confDir = Join-Path $Prefix "conf"
    New-Item -ItemType Directory -Force -Path $confDir | Out-Null
    $probe = Join-Path $confDir ".write_probe"
    try {
        [System.IO.File]::WriteAllText($probe, "ok", [System.Text.UTF8Encoding]::new($false))
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Repair-NginxPrefixAcl {
    param([string]$Prefix)
    if (-not (Test-IsAdministrator)) { return $false }
    New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
    $user = "$env:USERDOMAIN\$env:USERNAME"
    & icacls $Prefix /grant "Administrators:(OI)(CI)F" /T 2>$null | Out-Null
    & icacls $Prefix /grant "${user}:(OI)(CI)M" /T 2>$null | Out-Null
    & icacls $Prefix /grant "Users:(OI)(CI)M" /T 2>$null | Out-Null
    return (Test-NginxPrefixWritable -Prefix $Prefix)
}

function Clear-NginxConfReadOnly {
    param([string]$Prefix)
    $confFile = Join-Path $Prefix "conf\nginx.conf"
    if (Test-Path $confFile) {
        attrib -R $confFile 2>$null | Out-Null
    }
}

function Write-NginxStep {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor DarkGray
}

function Get-DomainConfig {
    param([string]$Root)
    $path = Join-Path $Root "deploy\domain.config.json"
    $domain = "din.eappms"
    $useHttps = $false
    if (Test-Path $path) {
        $raw = Get-Content $path -Raw | ConvertFrom-Json
        if ($raw.domain) { $domain = [string]$raw.domain }
        if ($raw.useHttps -eq $true) { $useHttps = $true }
    }
    $scheme = if ($useHttps) { "https" } else { "http" }
    return @{
        Domain   = $domain
        UseHttps = $useHttps
        Scheme   = $scheme
        Url      = "${scheme}://${domain}"
    }
}

function Ensure-NginxWin {
    param(
        [string]$TargetDir,
        [string]$ProjectDir
    )
    $nginxExe = Join-Path $TargetDir "nginx.exe"
    if (Test-Path $nginxExe) { return $nginxExe }

    $legacyDir = Join-Path $ProjectDir "deploy\nginx-win"
    if (Test-Path (Join-Path $legacyDir "nginx.exe")) {
        Write-NginxStep "Copying nginx to $TargetDir ..."
        New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
        Copy-Item -Path (Join-Path $legacyDir "*") -Destination $TargetDir -Recurse -Force
        if (Test-Path $nginxExe) { return $nginxExe }
    }

    Write-Host "  Downloading nginx for Windows (one-time)..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    $zipUrl = "https://nginx.org/download/nginx-1.24.0.zip"
    $zipPath = Join-Path $env:TEMP "nginx-1.24.0.zip"
    $extractRoot = Join-Path $env:TEMP "nginx-dl"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
    $extracted = Get-ChildItem $extractRoot -Directory | Select-Object -First 1
    Copy-Item -Path (Join-Path $extracted.FullName "*") -Destination $TargetDir -Recurse -Force
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    return $nginxExe
}

function Write-NginxConf {
    param(
        [string]$NginxPrefix,
        [hashtable]$DomainCfg,
        [int]$BackendPort,
        [int]$FrontendPort
    )
    $confDir = Join-Path $NginxPrefix "conf"
    New-Item -ItemType Directory -Force -Path $confDir | Out-Null
    $domain = $DomainCfg.Domain

    $serverBlock = @"
server {
    listen       80;
    server_name  $domain _;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:$FrontendPort;
        proxy_http_version 1.1;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_set_header Upgrade `$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:$BackendPort;
        proxy_http_version 1.1;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_read_timeout 120s;
    }

    location /ws {
        proxy_pass http://127.0.0.1:$BackendPort;
        proxy_http_version 1.1;
        proxy_set_header Upgrade `$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host `$host;
        proxy_read_timeout 86400;
    }

    location /static/ {
        proxy_pass http://127.0.0.1:$BackendPort;
        proxy_set_header Host `$host;
    }

    location /health {
        proxy_pass http://127.0.0.1:$BackendPort;
    }

    location /docs {
        proxy_pass http://127.0.0.1:$BackendPort;
    }

    location /openapi.json {
        proxy_pass http://127.0.0.1:$BackendPort;
    }
}
"@

    $mainConf = @"
worker_processes  1;
error_log  logs/error.log;
pid        logs/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile        on;
    keepalive_timeout  65;
    $serverBlock
}
"@
    $confFile = Join-Path $confDir "nginx.conf"
    try {
        [System.IO.File]::WriteAllText($confFile, $mainConf, [System.Text.UTF8Encoding]::new($false))
    } catch {
        Clear-NginxConfReadOnly -Prefix $NginxPrefix
        if (Repair-NginxPrefixAcl -Prefix $NginxPrefix) {
            [System.IO.File]::WriteAllText($confFile, $mainConf, [System.Text.UTF8Encoding]::new($false))
        } else {
            throw
        }
    }
}

function Ensure-HostsEntry {
    param([string]$Domain, [string]$Ip = "127.0.0.1")
    $hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
    $lines = @(Get-Content $hostsPath -ErrorAction SilentlyContinue)
    $escaped = [regex]::Escape($Domain)
    $filtered = $lines | Where-Object { $_ -notmatch "\s$escaped(\s|$)" }
    try {
        ($filtered + @("", "# EAP PMS IPC server (run.ps1)", "$Ip`t$Domain")) | Set-Content -Path $hostsPath -Encoding ASCII -ErrorAction Stop
        Write-Host "  [OK] Added hosts entry: $Ip $Domain" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "  [WARN] Could not update hosts file - run PowerShell as Administrator" -ForegroundColor Yellow
        Write-Host "  [WARN] Or on other PCs run: scripts\Register-ClientHost.ps1 -ServerIp <ipc-ip>" -ForegroundColor Yellow
        return $false
    }
}

function Ensure-NginxDirs {
    param([string]$Prefix)
    foreach ($sub in @('logs', 'temp', 'html')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Prefix $sub) | Out-Null
    }
}

function Stop-NginxInstance {
    param([string]$Exe, [string]$Prefix)
    $pidFile = Join-Path $Prefix "logs\nginx.pid"
    if (-not (Test-Path $pidFile)) { return }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Start-Process -FilePath $Exe -ArgumentList @('-p', $Prefix, '-s', 'quit') -WorkingDirectory $Prefix -WindowStyle Hidden -Wait
        Start-Sleep -Seconds 1
    } catch {
        # ignore stale pid
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Start-NginxInstance {
    param([string]$Exe, [string]$Prefix)
    # Start-Process avoids PowerShell blocking (nginx + paths with spaces).
    Start-Process -FilePath $Exe -ArgumentList @('-p', $Prefix) -WorkingDirectory $Prefix -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

function Test-NginxListening {
    param([int]$Port = 80)
    try {
        $r = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue
        return $r.TcpTestSucceeded
    } catch {
        return $false
    }
}

function Open-FirewallTcpPort {
    param(
        [string]$RuleName,
        [int]$Port
    )
    $existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    if ($existing) {
        # Ensure rule is enabled and still targets the expected port
        try {
            Set-NetFirewallRule -DisplayName $RuleName -Enabled True -ErrorAction SilentlyContinue | Out-Null
        } catch { }
        return
    }
    try {
        New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
        Write-Host ("  [OK] Firewall rule added for TCP {0}" -f $Port) -ForegroundColor Green
    } catch {
        Write-Host ("  [WARN] Could not add firewall rule for port {0} (Administrator?)" -f $Port) -ForegroundColor Yellow
    }
}

function Open-EapPmsFirewallPorts {
    param(
        [int]$BackendPort = 8040,
        [int]$FrontendPort = 5174
    )
    Open-FirewallTcpPort -RuleName "EAP PMS nginx HTTP 80" -Port 80
    Open-FirewallTcpPort -RuleName "EAP PMS Vite $FrontendPort" -Port $FrontendPort
    Open-FirewallTcpPort -RuleName "EAP PMS API $BackendPort" -Port $BackendPort

    # Stale rules from older Titan ports — disable if present (do not delete user custom rules)
    foreach ($stale in @("EAP-IMM Vite 5174", "EAP-IMM 8040", "EAP-PMS Vite 5174", "EAP-PMS 8010")) {
        $old = Get-NetFirewallRule -DisplayName $stale -ErrorAction SilentlyContinue
        if ($old) {
            try {
                Disable-NetFirewallRule -DisplayName $stale -ErrorAction SilentlyContinue | Out-Null
                Write-Host ("  [INFO] Disabled obsolete firewall rule: {0}" -f $stale) -ForegroundColor DarkGray
            } catch { }
        }
    }
}

Write-NginxStep "Using nginx root: $script:NginxRoot"
$domainCfg = Get-DomainConfig -Root $ProjectDir

if (-not (Test-IsAdministrator)) {
    Write-Host "  [WARN] Not running as Administrator - nginx needs port 80 and hosts file access." -ForegroundColor Yellow
    Write-Host "  [WARN] Right-click PowerShell -> Run as administrator, then: .\run.ps1" -ForegroundColor Yellow
    Write-Host "  [WARN] Or: deploy\Setup-Server-Host.bat (Run as administrator)" -ForegroundColor Yellow
    if (-not (Test-NginxPrefixWritable -Prefix $script:NginxRoot)) {
        throw "Cannot write nginx config under $script:NginxRoot (access denied). Run as Administrator once to fix permissions."
    }
}

Write-NginxStep "Ensuring nginx binaries..."
$nginxExe = Ensure-NginxWin -TargetDir $script:NginxRoot -ProjectDir $ProjectDir
if (-not (Test-Path $nginxExe)) {
    throw "nginx.exe not found at $nginxExe"
}

if (-not (Test-NginxPrefixWritable -Prefix $script:NginxRoot)) {
    Write-NginxStep "Repairing nginx folder permissions..."
    if (-not (Repair-NginxPrefixAcl -Prefix $script:NginxRoot)) {
        throw "Cannot write to $script:NginxRoot - run PowerShell as Administrator."
    }
}

Ensure-NginxDirs -Prefix $script:NginxRoot

Write-NginxStep "Stopping previous nginx instance (if any)..."
Stop-NginxInstance -Exe $nginxExe -Prefix $script:NginxRoot
Clear-NginxConfReadOnly -Prefix $script:NginxRoot

Write-NginxStep "Writing nginx.conf..."
Write-NginxConf -NginxPrefix $script:NginxRoot -DomainCfg $domainCfg -BackendPort $BackendPort -FrontendPort $FrontendPort

Write-NginxStep "Starting nginx on port 80..."
Start-NginxInstance -Exe $nginxExe -Prefix $script:NginxRoot

$nginxProc = Get-Process -Name nginx -ErrorAction SilentlyContinue
$portOpen = Test-NginxListening -Port 80
if (-not $nginxProc -and -not $portOpen) {
    $errLog = Join-Path $script:NginxRoot "logs\error.log"
    $tail = ""
    if (Test-Path $errLog) {
        $tail = (Get-Content $errLog -Tail 8 -ErrorAction SilentlyContinue) -join " | "
    }
    throw "nginx failed to start (is port 80 in use?). $tail Log: $errLog"
}

Write-NginxStep "Registering hosts entry..."
$hostsRegistered = Ensure-HostsEntry -Domain $domainCfg.Domain -Ip "127.0.0.1"
$domainCfg.HostsRegistered = $hostsRegistered
Write-NginxStep "Opening firewall for nginx / Vite / API..."
Open-EapPmsFirewallPorts -BackendPort $BackendPort -FrontendPort $FrontendPort

Write-Host "  [OK] nginx proxy active - $($domainCfg.Url)" -ForegroundColor Green
Write-Host "  [OK] nginx root: $script:NginxRoot" -ForegroundColor DarkGray
return $domainCfg
