# Windows-safe npm wrapper.
# PowerShell resolves bare "npm" to npm.ps1, which fails when script execution is restricted.
# npm.cmd is a batch file and always works.
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$NpmArgs
)

$nodeDir = Split-Path -Parent (Get-Command node -ErrorAction Stop).Source
$npmCmd = Join-Path $nodeDir "npm.cmd"

if (Test-Path $npmCmd) {
    & $npmCmd @NpmArgs
} else {
    & npm @NpmArgs
}

exit $LASTEXITCODE
