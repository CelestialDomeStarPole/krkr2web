param(
    [Parameter(Mandatory = $true)]
    [string]$HostName,
    [int]$Port = 8443
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$certificateDirectory = Join-Path $projectRoot "certs"
$diagnosticsDirectory = Join-Path $projectRoot "diagnostics"
$reportsDirectory = Join-Path $projectRoot "diagnostic-reports"
$generator = Join-Path $PSScriptRoot "generate_dev_certificate.py"
$server = Join-Path $PSScriptRoot "https_diagnostics_server.py"

python $generator --host $HostName --output $certificateDirectory
if ($LASTEXITCODE -ne 0) {
    throw "Certificate generation failed"
}

$caCertificate = Join-Path $certificateDirectory "krkr2-dev-ca.crt"
$serverCertificate = Join-Path $certificateDirectory "server.pem"
$serverKey = Join-Path $certificateDirectory "server-key.pem"

Write-Host ""
Write-Host "Install and trust this CA certificate on the Android device:" -ForegroundColor Yellow
Write-Host "  $caCertificate"
Write-Host ""
Write-Host "Configure DNS hijack:" -ForegroundColor Yellow
Write-Host "  $HostName -> this computer's hotspot IP"
Write-Host ""
Write-Host "Open this URL in the target WebView:" -ForegroundColor Green
if ($Port -eq 443) {
    Write-Host "  https://$HostName/"
} else {
    Write-Host "  https://${HostName}:$Port/"
}
Write-Host ""
Write-Host "Uploaded reports will be saved to:" -ForegroundColor Yellow
Write-Host "  $reportsDirectory"
Write-Host ""

python $server `
    --bind "0.0.0.0" `
    --port $Port `
    --directory $diagnosticsDirectory `
    --reports-directory $reportsDirectory `
    --cert $serverCertificate `
    --key $serverKey
