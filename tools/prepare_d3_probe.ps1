$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot "build\d3-engine"
$packageDirectory = Join-Path $projectRoot "build\d3-test-package"
$catalogMetadata = Join-Path $projectRoot "build\d3-test-metadata.json"
$resourceMap = Join-Path $output "resource-map.json"

& (Join-Path $projectRoot "tools\build_d3.ps1")
if ($LASTEXITCODE -ne 0) { throw "D3 engine build failed" }
New-Item -ItemType Directory -Force $packageDirectory | Out-Null
Copy-Item (Join-Path $output "data.xp3") (Join-Path $packageDirectory "data.xp3") -Force
python (Join-Path $projectRoot "tools\generate_d2_catalog.py") `
    --game-id d3-test --title "D3 self-test" --engine-profile d3-minimal `
    --source-directory $packageDirectory --package data.xp3 `
    --web-output $output --resource-map-output $resourceMap --metadata-output $catalogMetadata
if ($LASTEXITCODE -ne 0) { throw "D3 test catalog generation failed" }
Write-Host "D3 probe prepared: $output" -ForegroundColor Green

