# 生成用于上传到群晖的发布 zip（排除 Windows 专用和超大目录）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$parent = Split-Path -Parent $root
$out = Join-Path $root 'mikanime-stream-release.zip'

if (Test-Path $out) { Remove-Item -LiteralPath $out -Force }

tar -a -c -f $out -C $parent --exclude=node_modules --exclude=bin --exclude=.esb-test --exclude=.debug --exclude=scripts/testdata --exclude=p2p/mse-test.html --exclude=vendor/node_modules --exclude=vendor/node --exclude=vendor/node-arm64.tar.gz mikanime-stream

if ($LASTEXITCODE -eq 0) {
  $size = [math]::Round((Get-Item $out).Length / 1MB, 1)
  Write-Host "已生成: $out ($size MB) —— 上传到群晖后解压即可构建"
} else {
  Write-Host '打包失败' -ForegroundColor Red
}
