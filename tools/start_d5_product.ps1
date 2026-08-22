param(
    [string]$BindAddress = "192.168.137.1",
    [int]$Port = 443,
    [string]$HostName = "game.example.com",
    [switch]$SkipBuild,
    [switch]$Http
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot "build\d5-product"
$videoDirectory = Join-Path $projectRoot "build\video-transcode"
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "prepare_d5_product.ps1")
    if ($LASTEXITCODE -ne 0) { throw "D5 product build failed" }
}

$arguments = @(
    (Join-Path $PSScriptRoot "https_diagnostics_server.py"),
    "--bind", $BindAddress,
    "--port", $Port,
    "--directory", $output,
    "--reports-directory", (Join-Path $projectRoot "diagnostic-reports"),
    "--resource-map", (Join-Path $output "resource-map.json"),
    "--video-directory", $videoDirectory,
    "--savedata-directory", (Join-Path $projectRoot "参考资料\savedata")
)
if ($Http) {
    $arguments += "--http"
    Write-Host "D5 product: http://${BindAddress}:$Port/" -ForegroundColor Green
} else {
    $certificateDirectory = Join-Path $projectRoot "certs"
    $certificate = Join-Path $certificateDirectory "server.pem"
    $privateKey = Join-Path $certificateDirectory "server-key.pem"
    if (-not ((Test-Path -LiteralPath $certificate -PathType Leaf) -and (Test-Path -LiteralPath $privateKey -PathType Leaf))) {
        python (Join-Path $PSScriptRoot "generate_dev_certificate.py") --host $BindAddress --host $HostName --output $certificateDirectory
        if ($LASTEXITCODE -ne 0) { throw "Certificate generation failed" }
    } else {
        Write-Host "Reusing existing development certificate: $certificate" -ForegroundColor DarkGray
    }
    $arguments += @("--cert", $certificate, "--key", $privateKey)
    Write-Host "D5 product: https://${BindAddress}:$Port/" -ForegroundColor Green
}
python @arguments
