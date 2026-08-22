param(
    [string]$BindAddress = "0.0.0.0",
    [int]$Port = 443,
    [string]$HostName = "game.example.com",
    [switch]$SkipBuild,
    [switch]$Http
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot "build\d4-product"
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot "prepare_d4_product.ps1") }
if ($LASTEXITCODE -ne 0) { throw "D4 product build failed" }

$arguments = @(
    (Join-Path $PSScriptRoot "https_diagnostics_server.py"),
    "--bind", $BindAddress,
    "--port", $Port,
    "--directory", $output,
    "--reports-directory", (Join-Path $projectRoot "diagnostic-reports"),
    "--resource-map", (Join-Path $output "resource-map.json")
)
if ($Http) {
    $arguments += "--http"
    Write-Host "D4 product: http://${BindAddress}:$Port/" -ForegroundColor Green
} else {
    $certificateDirectory = Join-Path $projectRoot "certs"
    python (Join-Path $PSScriptRoot "generate_dev_certificate.py") --host $HostName --output $certificateDirectory
    if ($LASTEXITCODE -ne 0) { throw "Certificate generation failed" }
    $arguments += @("--cert", (Join-Path $certificateDirectory "server.pem"), "--key", (Join-Path $certificateDirectory "server-key.pem"))
    Write-Host "D4 product: https://${HostName}:$Port/" -ForegroundColor Green
}
python @arguments
