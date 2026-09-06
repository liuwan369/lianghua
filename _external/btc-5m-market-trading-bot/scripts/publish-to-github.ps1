# Publish this project to a GitHub org repository.
# Usage: $env:GITHUB_TOKEN = 'ghp_...'; .\scripts\publish-to-github.ps1
param(
    [string]$Org = "codex-trading-ai",
    [string]$Repo = "polymarket-trading-bot",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $env:GITHUB_TOKEN) {
    Write-Error "Set GITHUB_TOKEN first: `$env:GITHUB_TOKEN = 'ghp_...'"
}

$description = "polymarket trading bot, polymarket trading bot, polymarket maket trading bot, polymarket btc 5m market, polymaket trading bot, polymarket trading bot, polymarket trading bot, polymarket arbitrage bot, polymarket btc 5m market, polymarket market maker bot polymarket trading bot, polymarket market maker bot, polymarket trading bot"
$topics = @(
    "polymarket",
    "polymarket-bot",
    "polymarket-trading-bot",
    "polymarket-market-maker",
    "polymarket-market-maker-bot",
    "polymarket-arbitrage-bot",
    "polymarket-btc-5m",
    "btc-5m-market",
    "market-maker-bot",
    "market-making-bot",
    "trading-bot",
    "prediction-markets",
    "bitcoin-trading",
    "btc-trading",
    "automated-trading",
    "algorithmic-trading",
    "crypto-trading-bot",
    "arbitrage-bot",
    "delta-neutral",
    "typescript"
)

$headers = @{
    Authorization = "Bearer $env:GITHUB_TOKEN"
    Accept        = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}

Write-Host "Creating repository $Org/$Repo (if not exists)..."
$body = @{
    name        = $Repo
    description = $description
    private     = $false
    has_issues  = $true
    has_wiki    = $false
} | ConvertTo-Json

try {
    Invoke-RestMethod -Method POST -Uri "https://api.github.com/orgs/$Org/repos" -Headers $headers -Body $body -ContentType "application/json" | Out-Null
    Write-Host "Repository created."
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 422) {
        Write-Host "Repository already exists - updating metadata..."
        $patch = @{ description = $description } | ConvertTo-Json
        Invoke-RestMethod -Method PATCH -Uri "https://api.github.com/repos/$Org/$Repo" -Headers $headers -Body $patch -ContentType "application/json" | Out-Null
    } else {
        throw
    }
}

Write-Host "Setting topics..."
$topicHeaders = $headers.Clone()
$topicHeaders.Accept = "application/vnd.github.mercy-preview+json"
$topicBody = @{ names = $topics } | ConvertTo-Json
Invoke-RestMethod -Method PUT -Uri "https://api.github.com/repos/$Org/$Repo/topics" -Headers $topicHeaders -Body $topicBody -ContentType "application/json" | Out-Null
Write-Host "Topics set: $($topics -join ', ')"

Write-Host "Configuring git remote..."
$remoteUrl = "https://github.com/$Org/$Repo.git"
$oldErrorAction = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
git remote remove origin 2>$null | Out-Null
$ErrorActionPreference = $oldErrorAction
git remote add origin $remoteUrl

Write-Host "Staging and committing..."
git add -A
$status = git status --porcelain
if ($status) {
    git commit -m "Publish Polymarket BTC 5m trading bot to $Org/$Repo."
} else {
    Write-Host "Nothing to commit - pushing existing history."
}

Write-Host "Pushing to $remoteUrl ..."
$pushUrl = "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/$Org/$Repo.git"
git push -u $pushUrl "HEAD:$Branch" --force

Write-Host ""
Write-Host "Done: https://github.com/$Org/$Repo" -ForegroundColor Green
