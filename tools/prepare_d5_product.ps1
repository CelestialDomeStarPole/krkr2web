param(
    [switch]$SkipEngineBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$engineOutput = Join-Path $projectRoot "build\d3-engine"
$d2Output = Join-Path $projectRoot "build\d2-downloader"
$d2Metadata = Join-Path $projectRoot "build\d2-metadata"
$webSource = Join-Path $projectRoot "apps\web"
$output = Join-Path $projectRoot "build\d5-product"

if (-not $SkipEngineBuild) {
    & (Join-Path $PSScriptRoot "prepare_d3_probe.ps1")
    if ($LASTEXITCODE -ne 0) { throw "D5 engine preparation failed" }
}
foreach ($required in @(
    (Join-Path $engineOutput "krkrsdl2.js"),
    (Join-Path $engineOutput "krkrsdl2.wasm"),
    (Join-Path $d2Output "catalog.json"),
    (Join-Path $d2Output "games"),
    (Join-Path $d2Metadata "resource-map.json"),
    (Join-Path $webSource "player.js")
)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "D5 dependency missing: $required" }
}

if (Test-Path -LiteralPath $output) {
    Get-ChildItem -LiteralPath $output -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $output -Force | Out-Null
}
Copy-Item (Join-Path $webSource "*") $output -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "probes\d2-downloader\web\storage.js") -Destination (Join-Path $output "storage.js") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "probes\d2-downloader\web\downloader.js") -Destination (Join-Path $output "downloader.js") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "probes\d3-engine\web\storage.js") -Destination (Join-Path $output "play\storage.js") -Force

$engineDirectory = Join-Path $output "engine"
New-Item -ItemType Directory -Path $engineDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $engineOutput "krkrsdl2.js") -Destination $engineDirectory -Force
Copy-Item -LiteralPath (Join-Path $engineOutput "krkrsdl2.wasm") -Destination $engineDirectory -Force
Copy-Item -LiteralPath (Join-Path $d2Output "catalog.json") -Destination (Join-Path $output "catalog.json") -Force
Copy-Item -LiteralPath (Join-Path $d2Output "games") -Destination $output -Recurse -Force
Copy-Item -LiteralPath (Join-Path $d2Metadata "resource-map.json") -Destination (Join-Path $output "resource-map.json") -Force
$compatDirectory = Join-Path $output "compat"
New-Item -ItemType Directory -Path $compatDirectory -Force | Out-Null
Copy-Item (Join-Path $projectRoot "probes\d5-compat\web\*") $compatDirectory -Recurse -Force

python (Join-Path $PSScriptRoot "generate_engine_profiles.py") `
    --directory (Join-Path $projectRoot "engine\profiles") `
    --output (Join-Path $output "engine-profiles.js")
if ($LASTEXITCODE -ne 0) { throw "D5 engine profile generation failed" }

$catalogPath = Join-Path $output "catalog.json"
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($game in $catalog.games) {
    if ($game.gameId -eq "senren-banka") {
        $game | Add-Member -NotePropertyName coverUrl -NotePropertyValue "/assets/default-cover.png" -Force
        $game | Add-Member -NotePropertyName description -NotePropertyValue "D5 compatibility and performance development build." -Force
    }
}
$catalog | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $catalogPath -Encoding UTF8

python (Join-Path $PSScriptRoot "check_d4_artifacts.py") --directory $output
if ($LASTEXITCODE -ne 0) { throw "D5 product shell validation failed" }
python (Join-Path $PSScriptRoot "check_d5_artifacts.py") `
    --directory $output `
    --profile (Join-Path $projectRoot "engine\profiles\senren-banka-v1.json")
if ($LASTEXITCODE -ne 0) { throw "D5 artifact validation failed" }
Write-Host "D5 product prepared: $output" -ForegroundColor Green
