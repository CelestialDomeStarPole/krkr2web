param(
    [string]$HostName,
    [int]$Port = 8443,
    [string]$BindAddress = "0.0.0.0",
    [switch]$Http
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot "build\d1-file-bridge"
$reportsDirectory = Join-Path $projectRoot "diagnostic-reports"
$server = Join-Path $PSScriptRoot "https_diagnostics_server.py"

if (-not (Test-Path (Join-Path $outputDirectory "d1-probe.wasm"))) {
    throw "D1 build output is missing. Run .\tools\build_d1.ps1 first."
}

if ($Http) {
    Write-Host "D1 probe: http://${BindAddress}:$Port/" -ForegroundColor Green
    python $server --bind $BindAddress --port $Port --directory $outputDirectory `
        --reports-directory $reportsDirectory --http
    exit $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($HostName)) {
    throw "HTTPS mode requires -HostName. Use -Http only for local computer testing."
}

$certificateDirectory = Join-Path $projectRoot "certs"
$generator = Join-Path $PSScriptRoot "generate_dev_certificate.py"
python $generator --host $HostName --output $certificateDirectory
if ($LASTEXITCODE -ne 0) { throw "Certificate generation failed" }

Write-Host "Install this CA on the target device: $(Join-Path $certificateDirectory 'krkr2-dev-ca.crt')" -ForegroundColor Yellow
Write-Host "D1 probe: https://${HostName}:$Port/" -ForegroundColor Green
python $server --bind $BindAddress --port $Port --directory $outputDirectory `
    --reports-directory $reportsDirectory `
    --cert (Join-Path $certificateDirectory "server.pem") `
    --key (Join-Path $certificateDirectory "server-key.pem")
