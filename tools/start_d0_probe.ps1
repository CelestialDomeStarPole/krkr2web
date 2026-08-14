param(
    [string]$HostName,
    [int]$Port = 8443,
    [switch]$Http
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot "build\d0-chrome89"
$reportsDirectory = Join-Path $projectRoot "diagnostic-reports"
$server = Join-Path $PSScriptRoot "https_diagnostics_server.py"

if (-not (Test-Path (Join-Path $outputDirectory "d0-probe.wasm"))) {
    throw "D0 build output is missing. Run .\tools\build_d0.ps1 first."
}

if ($Http) {
    Write-Host "D0 probe: http://localhost:$Port/" -ForegroundColor Green
    python $server `
        --bind "0.0.0.0" `
        --port $Port `
        --directory $outputDirectory `
        --reports-directory $reportsDirectory `
        --http
    exit $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($HostName)) {
    throw "HTTPS mode requires -HostName. Use -Http only for local computer testing."
}

$certificateDirectory = Join-Path $projectRoot "certs"
$generator = Join-Path $PSScriptRoot "generate_dev_certificate.py"
python $generator --host $HostName --output $certificateDirectory
if ($LASTEXITCODE -ne 0) {
    throw "Certificate generation failed"
}

$serverCertificate = Join-Path $certificateDirectory "server.pem"
$serverKey = Join-Path $certificateDirectory "server-key.pem"
$caCertificate = Join-Path $certificateDirectory "krkr2-dev-ca.crt"

Write-Host "Install this CA on the target device: $caCertificate" -ForegroundColor Yellow
Write-Host "D0 probe: https://${HostName}:$Port/" -ForegroundColor Green
python $server `
    --bind "0.0.0.0" `
    --port $Port `
    --directory $outputDirectory `
    --reports-directory $reportsDirectory `
    --cert $serverCertificate `
    --key $serverKey
