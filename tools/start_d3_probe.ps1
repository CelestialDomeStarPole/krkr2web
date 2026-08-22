param(
    [string]$BindAddress = "0.0.0.0",
    [int]$Port = 8446,
    [string]$HostName = "game.example.com",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot "build\d3-engine"
if (-not $SkipBuild) { & (Join-Path $projectRoot "tools\prepare_d3_probe.ps1") }
$certificateDirectory = Join-Path $projectRoot "certs"
python (Join-Path $projectRoot "tools\generate_dev_certificate.py") --host $HostName --output $certificateDirectory
if ($LASTEXITCODE -ne 0) { throw "Certificate generation failed" }
Write-Host "D3 probe: https://${HostName}:$Port/?gameId=d3-test" -ForegroundColor Green
python (Join-Path $projectRoot "tools\https_diagnostics_server.py") `
    --bind $BindAddress --port $Port --directory $output `
    --reports-directory (Join-Path $projectRoot "diagnostic-reports") `
    --resource-map (Join-Path $output "resource-map.json") `
    --cert (Join-Path $certificateDirectory "server.pem") `
    --key (Join-Path $certificateDirectory "server-key.pem")
