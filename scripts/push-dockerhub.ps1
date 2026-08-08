# Build and push Docker image to Docker Hub.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\push-dockerhub.ps1
param(
  [string]$ImageName = "mikanime-stream",
  [string]$Tag = "latest",
  [string]$User = ""
)

$ErrorActionPreference = 'Stop'

$user = $User
if ([string]::IsNullOrWhiteSpace($user)) {
  $user = Read-Host "Docker Hub username"
}
if ([string]::IsNullOrWhiteSpace($user)) {
  Write-Host "Username cannot be empty" -ForegroundColor Red
  exit 1
}

$full = "$user/$ImageName`:$Tag"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> docker login" -ForegroundColor Cyan
docker login
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> docker build -t $full" -ForegroundColor Cyan
Push-Location $root
try {
  docker build -t $full .
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

Write-Host "==> docker push $full" -ForegroundColor Cyan
docker push $full
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done: $full" -ForegroundColor Green
