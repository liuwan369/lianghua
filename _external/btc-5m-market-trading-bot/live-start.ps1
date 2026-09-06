# First supervised live session (Windows). Fund Polymarket wallet (pUSD) + POL first.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
    Write-Host "ERROR: .env missing. Copy .env.example to .env and set POLYMARKET_PRIVATE_KEY." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path "results/live" | Out-Null

& "$PSScriptRoot\scripts\invoke-npm.ps1" run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node dist/cli/live.js preflight
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = "results/live/live-$stamp.jsonl"

Write-Host ""
Write-Host "Starting LIVE session (real money). Log: $log" -ForegroundColor Yellow
Write-Host "Caps: `$2/order, 50 orders, `$10 total, 15 min max." -ForegroundColor Yellow
Write-Host "Ctrl+C to stop — resting orders are cancelled on exit." -ForegroundColor Yellow
Write-Host ""

node dist/cli/live.js run --live `
  --order-usd 2 `
  --max-orders 50 `
  --max-total-usd 10 `
  --duration-min 15 `
  --log-file $log `
  --traded-file results/live/traded.jsonl
