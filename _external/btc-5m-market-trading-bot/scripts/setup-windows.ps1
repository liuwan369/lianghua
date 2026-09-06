# One-time Windows setup: allow npm/npx in PowerShell and verify the toolchain.
$ErrorActionPreference = "Stop"

Write-Host "Configuring PowerShell for Node.js npm scripts..." -ForegroundColor Cyan

$current = Get-ExecutionPolicy -Scope CurrentUser
if ($current -eq "Undefined" -or $current -eq "Restricted") {
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
    Write-Host "Set CurrentUser execution policy to RemoteSigned." -ForegroundColor Green
} else {
    Write-Host "CurrentUser execution policy already OK: $current" -ForegroundColor Green
}

foreach ($cmd in @("node", "npm", "npx")) {
    $version = & $cmd --version
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: $cmd failed. Install Node.js >= 20 and reopen the terminal." -ForegroundColor Red
        exit 1
    }
    Write-Host "$cmd $version"
}

Write-Host ""
Write-Host "Windows setup complete. You can use npm normally in PowerShell." -ForegroundColor Green
