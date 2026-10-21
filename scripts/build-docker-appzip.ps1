<#
.SYNOPSIS
  Build IMM Docker image, export tar, and pack App Management zip.

.EXAMPLE
  # NodePort / root URL (local & NodePort deploy)
  .\scripts\build-docker-appzip.ps1

  # App Management Ingress path
  .\scripts\build-docker-appzip.ps1 -ViteBase "/app/imm-pms/v1/imm-pms/" -Variant external-db
#>
param(
  [string]$ImageName = "imm-pms",
  [string]$ImageTag = "v1.0.1",
  [string]$ViteBase = "/",
  [ValidateSet("external-db", "with-mysql")]
  [string]$Variant = "external-db"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$FullImage = "${ImageName}:${ImageTag}"
$TarName = "imm-pms-${ImageTag}.tar"
$AppDir = Join-Path $Root "appzip\imm-pms-$Variant"
$OutZip = Join-Path $Root "appzip\imm-pms-$Variant-$ImageTag.zip"

Write-Host "==> Building $FullImage  (VITE_BASE=$ViteBase)" -ForegroundColor Cyan
docker build --build-arg "VITE_BASE=$ViteBase" -t $FullImage .

Write-Host "==> Saving $TarName" -ForegroundColor Cyan
$TarPath = Join-Path $AppDir $TarName
if (Test-Path $TarPath) { Remove-Item $TarPath -Force }
docker save -o $TarPath $FullImage

Write-Host "==> Packing App Management zip" -ForegroundColor Cyan
if (Test-Path $OutZip) { Remove-Item $OutZip -Force }
$files = @(
  (Join-Path $AppDir "metadata.json"),
  (Join-Path $AppDir "deployment.yaml"),
  (Join-Path $AppDir "service.yaml"),
  (Join-Path $AppDir "configmap.yaml"),
  $TarPath
)
Compress-Archive -Path $files -DestinationPath $OutZip -Force

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Image : $FullImage"
Write-Host "  Tar   : $TarPath"
Write-Host "  Zip   : $OutZip"
Write-Host ""
Write-Host "Next: edit configmap.yaml DATABASE_URL / secrets, re-zip if needed,"
Write-Host "then upload $OutZip in EAP+ App Management."
