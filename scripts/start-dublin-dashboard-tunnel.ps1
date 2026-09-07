$ErrorActionPreference = "Stop"
$port = 18765
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try {
        Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/system-dashboard.html" -TimeoutSec 3 | Out-Null
        Write-Output "Dublin dashboard already available at http://127.0.0.1:$port/system-dashboard.html"
        exit 0
    } catch {
        throw "Port $port is occupied by another program. Stop it before starting the Dublin tunnel."
    }
}

Start-Process ssh -ArgumentList @(
    "-N", "-L", "${port}:127.0.0.1:18766", "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3",
    "-i", "$env:USERPROFILE\.ssh\id_ed25519_dublin_pm", "root@34.242.206.196"
) -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/system-dashboard.html" -TimeoutSec 2 | Out-Null
        Write-Output "Dublin dashboard available at http://127.0.0.1:$port/system-dashboard.html"
        exit 0
    } catch {
        Start-Sleep -Milliseconds 300
    }
}
throw "Dublin dashboard tunnel did not become ready"
