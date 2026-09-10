$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$port = 8765
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "Dashboard already running at http://127.0.0.1:$port/console/"
    exit 0
}
Start-Process -FilePath "python" `
    -ArgumentList "scripts/system-dashboard-server.py --host 127.0.0.1 --port $port" `
    -WorkingDirectory $root `
    -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/console/" -TimeoutSec 2 | Out-Null
        Write-Output "Dashboard started at http://127.0.0.1:$port/console/"
        exit 0
    } catch {
        Start-Sleep -Milliseconds 250
    }
}
throw "Dashboard did not become ready"
