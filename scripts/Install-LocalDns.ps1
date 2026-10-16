# Start LAN DNS so din.eappms resolves for all devices that use this IPC as DNS server.
param(
    [string]$ProjectDir = (Split-Path $PSScriptRoot -Parent),
    [string]$LanIp = ""
)

$ErrorActionPreference = "Continue"

function Get-DomainSettings {
    param([string]$Root)
    $path = Join-Path $Root "deploy\domain.config.json"
    $domain = "din.eappms"
    $dnsEnabled = $true
    $lanIp = ""
    if (Test-Path $path) {
        $raw = Get-Content $path -Raw | ConvertFrom-Json
        if ($raw.domain) { $domain = [string]$raw.domain }
        if ($null -ne $raw.dnsEnabled) { $dnsEnabled = [bool]$raw.dnsEnabled }
        if ($raw.lanIp) { $lanIp = [string]$raw.lanIp }
    }
    return @{ Domain = $domain; DnsEnabled = $dnsEnabled; LanIp = $lanIp }
}

function Get-NetworkIPs {
    $ips = [System.Collections.Generic.List[string]]::new()
    try {
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -notmatch '^127\.' -and
                $_.IPAddress -notmatch '^169\.254\.' -and
                $_.PrefixOrigin -ne 'WellKnown'
            } |
            ForEach-Object { [void]$ips.Add($_.IPAddress) }
    } catch {
        [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq 'InterNetwork' -and $_.ToString() -notmatch '^127\.' } |
            ForEach-Object { [void]$ips.Add($_.ToString()) }
    }
    return @($ips | Select-Object -Unique)
}

function Resolve-LanIp {
    param([string]$Configured, [string[]]$NetworkIPs)
    if ($Configured) { return $Configured }
    $ten = $NetworkIPs | Where-Object { $_ -match '^10\.151\.' } | Select-Object -First 1
    if ($ten) { return $ten }
    if ($NetworkIPs.Count -gt 0) { return $NetworkIPs[0] }
    return "127.0.0.1"
}

$settings = Get-DomainSettings -Root $ProjectDir
if (-not $settings.DnsEnabled) {
    Write-Host "  [SKIP] LAN DNS disabled in deploy\domain.config.json" -ForegroundColor Yellow
    return $settings
}

$networkIPs = Get-NetworkIPs
$resolvedIp = Resolve-LanIp -Configured $(if ($LanIp) { $LanIp } else { $settings.LanIp }) -NetworkIPs $networkIPs
$ipArg = if ($settings.LanIp) { $settings.LanIp } else { "auto" }

$venvCandidates = @(
    (Join-Path $ProjectDir "backend\.venv\Scripts\python.exe"),
    (Join-Path $ProjectDir "backend\venv\Scripts\python.exe")
)
$venvPython = $venvCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $venvPython) {
    Write-Host "  [WARN] Python venv not found - skipping LAN DNS" -ForegroundColor Yellow
    return $settings
}

$dnsScript = Join-Path $ProjectDir "scripts\local_dns.py"
$ruleName = "EAP PMS LAN DNS 53"

$dnslibOk = $false
& $venvPython -c "import dnslib" 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { $dnslibOk = $true }

if (-not $dnslibOk) {
    & $venvPython -m pip install dnslib 2>&1 | Out-Null
    & $venvPython -c "import dnslib" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $dnslibOk = $true }
}

if (-not $dnslibOk) {
    Write-Host "  [WARN] Could not install dnslib - skipping LAN DNS" -ForegroundColor Yellow
    Write-Host "  [INFO] Use deploy\Setup-Client-PC.bat on each PC instead" -ForegroundColor DarkGray
    return @{
        Domain     = $settings.Domain
        LanIp      = $resolvedIp
        Url        = "http://$($settings.Domain)"
        DnsEnabled = $false
    }
}
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
    try {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol UDP -LocalPort 53 -Action Allow | Out-Null
        New-NetFirewallRule -DisplayName "$ruleName TCP" -Direction Inbound -Protocol TCP -LocalPort 53 -Action Allow | Out-Null
        Write-Host "  [OK] Firewall opened for DNS port 53" -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Could not open firewall for port 53 (Administrator?)" -ForegroundColor Yellow
    }
}

Get-Process -Name python -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
        if ($cmd -match 'local_dns\.py') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
}

Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$ProjectDir'; & '$venvPython' '$dnsScript' --domain '$($settings.Domain)' --ip '$ipArg'"
) -WindowStyle Minimized

if ($ipArg -eq "auto") {
    Write-Host "  [OK] LAN DNS running (auto IP) - $($settings.Domain)" -ForegroundColor Green
    Write-Host "  [INFO] DNS re-detects LAN IP every 30s when DHCP changes" -ForegroundColor DarkGray
} else {
    Write-Host "  [OK] LAN DNS running (pinned IP) - $($settings.Domain) -> $ipArg" -ForegroundColor Green
}
Write-Host "  [INFO] For ALL devices (PC/Android): set router DHCP DNS to $resolvedIp" -ForegroundColor Yellow
Write-Host "  [INFO] Or per-PC: use deploy\Setup-Client-PC.bat if router cannot be changed" -ForegroundColor DarkGray

return @{
    Domain   = $settings.Domain
    LanIp    = $resolvedIp
    Url      = "http://$($settings.Domain)"
    DnsEnabled = $true
}
