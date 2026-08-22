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
# krkr2web: build into a staging directory and swap it in with renames at the
# very end. The old clear-then-copy left multi-second windows where the live
# 443 server 404ed every request (device refreshes inside a redeploy rendered
# unstyled pages). Directory renames on the same volume are near-atomic, and a
# leftover -old tree is removed on the next run if a transient file handle
# keeps it locked now.
$staging = Join-Path $projectRoot "build\d5-product-next"
$stale = Join-Path $projectRoot "build\d5-product-old"

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

if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Recurse -Force }
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
Copy-Item (Join-Path $webSource "*") $staging -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "probes\d2-downloader\web\storage.js") -Destination (Join-Path $staging "storage.js") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "probes\d2-downloader\web\downloader.js") -Destination (Join-Path $staging "downloader.js") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "probes\d3-engine\web\storage.js") -Destination (Join-Path $staging "play\storage.js") -Force

$engineDirectory = Join-Path $staging "engine"
New-Item -ItemType Directory -Path $engineDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $engineOutput "krkrsdl2.js") -Destination $engineDirectory -Force
Copy-Item -LiteralPath (Join-Path $engineOutput "krkrsdl2.wasm") -Destination $engineDirectory -Force
Copy-Item -LiteralPath (Join-Path $d2Output "catalog.json") -Destination (Join-Path $staging "catalog.json") -Force
Copy-Item -LiteralPath (Join-Path $d2Output "games") -Destination $staging -Recurse -Force
Copy-Item -LiteralPath (Join-Path $d2Metadata "resource-map.json") -Destination (Join-Path $staging "resource-map.json") -Force
$compatDirectory = Join-Path $staging "compat"
New-Item -ItemType Directory -Path $compatDirectory -Force | Out-Null
Copy-Item (Join-Path $projectRoot "probes\d5-compat\web\*") $compatDirectory -Recurse -Force

python (Join-Path $PSScriptRoot "generate_engine_profiles.py") `
    --directory (Join-Path $projectRoot "engine\profiles") `
    --output (Join-Path $staging "engine-profiles.js")
if ($LASTEXITCODE -ne 0) { throw "D5 engine profile generation failed" }

$catalogPath = Join-Path $staging "catalog.json"
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($game in $catalog.games) {
    if ($game.gameId -eq "senren-banka") {
        $game | Add-Member -NotePropertyName coverUrl -NotePropertyValue "/assets/default-cover.png" -Force
        $game | Add-Member -NotePropertyName description -NotePropertyValue "D5 compatibility and performance development build." -Force
    }
}
$catalog | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $catalogPath -Encoding UTF8

# krkr2web: stamp local asset references with content hashes so a revalidated
# index.html can only pull matching scripts (Android WebView has served stale
# no-cache subresources after redeployments, breaking engine-profiles.js).
python (Join-Path $PSScriptRoot "stamp_build_versions.py") --directory $staging
if ($LASTEXITCODE -ne 0) { throw "D5 build version stamping failed" }

$nodeForCheck = Join-Path $projectRoot (Join-Path ".toolchains" (Join-Path "emsdk" (Join-Path "node" (Join-Path "18.20.3_64bit" (Join-Path "bin" "node.exe")))))
$checkArgs = @(Join-Path $PSScriptRoot "check_d4_artifacts.py"), "--directory", $staging
if (Test-Path $nodeForCheck) { $checkArgs += @("--node", $nodeForCheck) }
python @checkArgs
if ($LASTEXITCODE -ne 0) { throw "D5 product shell validation failed" }
python (Join-Path $PSScriptRoot "check_d5_artifacts.py") `
    --directory $staging `
    --profile (Join-Path $projectRoot "engine\profiles\senren-banka-v1.json")
if ($LASTEXITCODE -ne 0) { throw "D5 artifact validation failed" }

# swap the finished tree in: current -> -old, staged -> current. Retry the
# first rename in case the live server still holds a read handle on a file.
$swapped = $false
for ($attempt = 0; $attempt -lt 5 -and -not $swapped; $attempt += 1) {
    try {
        if (Test-Path -LiteralPath $output) { Rename-Item -LiteralPath $output -NewName "d5-product-old" }
        Rename-Item -LiteralPath $staging -NewName "d5-product"
        $swapped = $true
    } catch {
        Start-Sleep -Milliseconds 200
    }
}
if (-not $swapped) { throw "d5-product swap failed: directory handles stayed busy" }
try { Remove-Item -LiteralPath $stale -Recurse -Force -ErrorAction SilentlyContinue } catch { }
Write-Host "D5 product prepared: $output" -ForegroundColor Green
