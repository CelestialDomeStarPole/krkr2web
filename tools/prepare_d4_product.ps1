param(
    [switch]$SkipEngineBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$engineOutput = Join-Path $projectRoot "build\d3-engine"
$webSource = Join-Path $projectRoot "apps\web"
$output = Join-Path $projectRoot "build\d4-product"

if (-not $SkipEngineBuild) {
    & (Join-Path $PSScriptRoot "prepare_d3_probe.ps1")
    if ($LASTEXITCODE -ne 0) { throw "D3 engine preparation failed" }
}
foreach ($required in @(
    (Join-Path $engineOutput "krkrsdl2.js"),
    (Join-Path $engineOutput "krkrsdl2.wasm"),
    (Join-Path $engineOutput "catalog.json"),
    (Join-Path $engineOutput "resource-map.json"),
    (Join-Path $webSource "player.js")
)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "D4 dependency missing: $required" }
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

Copy-Item -LiteralPath (Join-Path $engineOutput "catalog.json") -Destination (Join-Path $output "catalog.json") -Force
Copy-Item -LiteralPath (Join-Path $engineOutput "games") -Destination $output -Recurse -Force
Copy-Item -LiteralPath (Join-Path $engineOutput "resource-map.json") -Destination (Join-Path $output "resource-map.json") -Force
python (Join-Path $PSScriptRoot "generate_engine_profiles.py") `
    --directory (Join-Path $projectRoot "engine\profiles") `
    --output (Join-Path $output "engine-profiles.js")
if ($LASTEXITCODE -ne 0) { throw "Engine profile generation failed" }

$catalogPath = Join-Path $output "catalog.json"
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($game in $catalog.games) {
    if ($game.gameId -eq "d3-test") {
        $game | Add-Member -NotePropertyName coverUrl -NotePropertyValue "/assets/default-cover.png" -Force
        $descriptionCodePoints = @(0x7528,0x4E8E,0x9A8C,0x8BC1,0x901A,0x7528,0x4EA7,0x54C1,0x6D41,0x7A0B,0x7684,0x20,0x4B,0x52,0x4B,0x52,0x32,0x20,0x5C0F,0x578B,0x6E38,0x620F,0x3002,0x5305,0x542B,0x5267,0x60C5,0x3001,0x58F0,0x97F3,0x3001,0x89E6,0x6478,0x548C,0x672C,0x673A,0x5B58,0x6863,0x3002)
        $description = -join ($descriptionCodePoints | ForEach-Object { [char]$_ })
        $game | Add-Member -NotePropertyName description -NotePropertyValue $description -Force
        # auto-catalog parity: the same metadata ships as meta.json inside the
        # version directory so servers with --auto-catalog render identically
        $metaDirectory = Join-Path $output (Join-Path "games" (Join-Path "d3-test" $game.version))
        [ordered]@{
            schemaVersion = 1
            description = $description
            coverUrl = "/assets/default-cover.png"
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $metaDirectory "meta.json") -Encoding UTF8
    }
}
$catalog | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $catalogPath -Encoding UTF8

python (Join-Path $PSScriptRoot "check_d4_artifacts.py") --directory $output
if ($LASTEXITCODE -ne 0) { throw "D4 artifact validation failed" }
Write-Host "D4 product prepared: $output" -ForegroundColor Green
