# package.ps1 — Create a clean eap-pms.zip for Ubuntu deployment
# Run from project root: .\package.ps1

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$appName = "eap-pms"
$zipName = "$appName.zip"
$zipPath = Join-Path $root $zipName

# Top-level names to exclude entirely
$excludeDirs = @(
    ".cursor", ".git", ".vscode", ".claude", ".codex",
    "backend\venv", "backend\__pycache__",
    "frontend\node_modules", "frontend\dist",
    "new_theme", "TITAN_OEE_FULL_PACKAGE", "demo", "update_fixes",
    "database\backups", "old_v1", "deploy\nginx-win"
)

# Path patterns (anywhere in tree)
$excludePatterns = @(
    "__pycache__", "*.pyc", "*.log",
    "backend\.env", "frontend\.env",
    "database\db.config.json",
    ".backend.pid", ".frontend.pid",
    "gemini_*", "old_*", "bug_*",
    "*.xlsx", "*.zip"
)

# Dev-only docs at root (keep DEPLOY-UBUNTU.md, README.md)
$excludeRootFiles = @(
    "AGENTS.md", "CLAUDE.md", "SKILLS-PORTING-GUIDE.md",
    "TITAN-CPLM-INTEGRATION.md", "UBUNTU_SETUP.md",
    "README_system_serivce_manager_ubuntu.md",
    "PACKAGE.ps1"
)

function Should-Exclude($relPath) {
    $rel = $relPath -replace '/', '\'

    foreach ($d in $excludeDirs) {
        if ($rel -eq $d -or $rel.StartsWith("$d\")) { return $true }
    }

    $name = Split-Path -Leaf $rel
  foreach ($p in $excludePatterns) {
        if ($name -like $p) { return $true }
        if ($rel -like "*\$p") { return $true }
        if ($rel -like "*\$p\*") { return $true }
    }

    if ($rel -notmatch '\\') {
        foreach ($f in $excludeRootFiles) {
            if ($rel -eq $f) { return $true }
        }
        if ($rel -like "*.md" -and $rel -ne "README.md" -and $rel -ne "DEPLOY-UBUNTU.md") {
            return $true
        }
    }

    return $false
}

Write-Host "Packaging $appName for Ubuntu..." -ForegroundColor Cyan

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$files = Get-ChildItem -Path $root -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($root.Length + 1)
    -not (Should-Exclude $rel)
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
foreach ($file in $files) {
    $entryName = "$appName/" + ($file.FullName.Substring($root.Length + 1) -replace '\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName) | Out-Null
}
$zip.Dispose()

$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host ""
Write-Host "Package created: $zipPath ($sizeMB MB)" -ForegroundColor Green
Write-Host ""
Write-Host "Transfer to Ubuntu:" -ForegroundColor Yellow
Write-Host "  scp $zipName user@<server-ip>:~/" -ForegroundColor White
Write-Host ""
Write-Host "On Ubuntu:" -ForegroundColor Yellow
Write-Host "  unzip $zipName && cd $appName" -ForegroundColor White
Write-Host "  chmod +x run.sh scripts/*.sh" -ForegroundColor White
Write-Host "  ./run.sh" -ForegroundColor White
