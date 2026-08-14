param(
    [string]$SourceDirectory,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
    $dataPackages = @(Get-ChildItem -LiteralPath $projectRoot -Recurse -File -Filter "data.xp3" -ErrorAction Stop)
    $matchingDirectories = @($dataPackages | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_.DirectoryName "adult.xp3")) -and
        (Test-Path -LiteralPath (Join-Path $_.DirectoryName "video.xp3"))
    } | ForEach-Object { $_.DirectoryName } | Select-Object -Unique)
    if ($matchingDirectories.Count -ne 1) {
        throw "Could not uniquely locate data.xp3, adult.xp3, and video.xp3. Pass -SourceDirectory explicitly."
    }
    $SourceDirectory = $matchingDirectories[0]
}
$sourceDirectoryPath = [System.IO.Path]::GetFullPath($SourceDirectory)
$webSource = Join-Path $projectRoot "probes\d2-downloader\web"
$outputDirectory = Join-Path $projectRoot "build\d2-downloader"
$metadataDirectory = Join-Path $projectRoot "build\d2-metadata"
$resourceMap = Join-Path $metadataDirectory "resource-map.json"
$metadata = Join-Path $metadataDirectory "package-hashes.json"
$generator = Join-Path $PSScriptRoot "generate_d2_catalog.py"
$gameTitle = -join ([char[]](0x5343, 0x604B, 0x4E07, 0x82B1))

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $metadataDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $webSource "index.html") -Destination $outputDirectory -Force
Copy-Item -LiteralPath (Join-Path $webSource "styles.css") -Destination $outputDirectory -Force
Copy-Item -LiteralPath (Join-Path $webSource "storage.js") -Destination $outputDirectory -Force
Copy-Item -LiteralPath (Join-Path $webSource "downloader.js") -Destination $outputDirectory -Force
Copy-Item -LiteralPath (Join-Path $webSource "app.js") -Destination $outputDirectory -Force

$arguments = @(
    $generator,
    "--game-id", "senren-banka",
    "--title", $gameTitle,
    "--engine-profile", "senren-banka-v1",
    "--source-directory", $sourceDirectoryPath,
    "--package", "data.xp3",
    "--package", "adult.xp3",
    "--package", "video.xp3",
    "--web-output", $outputDirectory,
    "--resource-map-output", $resourceMap,
    "--metadata-output", $metadata,
    "--compatibility", "development"
)
if ($Force) { $arguments += "--force" }
python @arguments
if ($LASTEXITCODE -ne 0) { throw "D2 catalog generation failed" }

python (Join-Path $PSScriptRoot "check_d2_artifacts.py") `
    --web-directory $outputDirectory `
    --resource-map $resourceMap
if ($LASTEXITCODE -ne 0) { throw "D2 artifact validation failed" }

Write-Host "D2 probe prepared: $outputDirectory" -ForegroundColor Green
Write-Host "Large XP3 files were not copied; the server maps their exact URLs." -ForegroundColor DarkGray
