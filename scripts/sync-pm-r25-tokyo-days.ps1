param(
    [string]$Server = "13.115.254.211",
    [string]$Key = "C:\Users\Administrator\.ssh\id_ed25519_tokyo",
    [string]$RemoteDir = "/root/pm-system/data/pm-r25-live/days",
    [string]$LocalDir = "data\pm-r25-live\archive"
)

$ErrorActionPreference = "Stop"
$destination = Join-Path (Get-Location) $LocalDir
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$files = ssh -i $Key -o BatchMode=yes "root@$Server" "find '$RemoteDir' -maxdepth 1 -type f -name 'tokyo-evidence-*.sqlite3' -printf '%f\n' | sort"

foreach ($name in $files) {
    if (-not $name -or $name -eq "tokyo-evidence-$today.sqlite3") {
        continue
    }
    $local = Join-Path $destination $name
    $remoteHash = (ssh -i $Key -o BatchMode=yes "root@$Server" "sha256sum '$RemoteDir/$name'").Split(' ')[0]
    $localHash = if (Test-Path $local) { (Get-FileHash -Algorithm SHA256 $local).Hash.ToLowerInvariant() } else { "" }
    if ($localHash -ne $remoteHash) {
        scp -i $Key "root@${Server}:$RemoteDir/$name" $local
        $localHash = (Get-FileHash -Algorithm SHA256 $local).Hash.ToLowerInvariant()
    }
    if ($localHash -ne $remoteHash) {
        throw "Hash mismatch after download: $name"
    }
    Write-Output "verified $name $localHash"
}
