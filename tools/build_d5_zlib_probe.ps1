$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot "probes\d5-zlib"
$engineSource = Join-Path $projectRoot "build\d3-engine-work\source"
$zlib = Join-Path $engineSource "external\zlib"
$output = Join-Path $projectRoot "build\d5-zlib-probe"
$productOutput = Join-Path $projectRoot "build\d5-product\zlib-probe"
$compiler = Join-Path $projectRoot ".toolchains\emsdk\upstream\emscripten\emcc.bat"

foreach ($required in @($compiler, (Join-Path $zlib "zlib.h"), (Join-Path $sourceRoot "src\probe.c"))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "D5 zlib probe dependency missing: $required" }
}
if (Test-Path -LiteralPath $output) {
    Get-ChildItem -LiteralPath $output -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $output -Force | Out-Null
}
Copy-Item (Join-Path $sourceRoot "web\*") $output -Force

$zlibSources = @("adler32.c", "crc32.c", "inffast.c", "inflate.c", "inftrees.c", "uncompr.c", "zutil.c") |
    ForEach-Object { Join-Path $zlib $_ }
$common = @(
    (Join-Path $sourceRoot "src\probe.c")
) + $zlibSources + @(
    "-I$zlib", "-O2", "--no-entry",
    "-s", "MIN_CHROME_VERSION=89",
    "-s", "ENVIRONMENT=web",
    "-s", "MODULARIZE=1",
    "-s", "FILESYSTEM=0",
    "-s", "DYNAMIC_EXECUTION=0",
    "-s", "ALLOW_MEMORY_GROWTH=1",
    "-s", "INITIAL_MEMORY=33554432",
    "-s", "MAXIMUM_MEMORY=134217728",
    "-s", "EXPORTED_RUNTIME_METHODS=['ccall']"
)

$baseline = $common + @(
    "-o", (Join-Path $output "baseline.js"),
    "-s", "EXPORT_NAME=createD5ZlibBaseline",
    "-s", "ASYNCIFY=0",
    "-s", "EXPORTED_FUNCTIONS=['_malloc','_free','_d5_zlib_adler','_d5_zlib_uncompress']"
)
& $compiler @baseline
if ($LASTEXITCODE -ne 0) { throw "D5 baseline zlib probe compilation failed" }

$asyncify = $common + @(
    "-DD5_ZLIB_ASYNC=1",
    "-o", (Join-Path $output "asyncify.js"),
    "-s", "EXPORT_NAME=createD5ZlibAsyncify",
    "-s", "ASYNCIFY=1",
    "-s", "ASYNCIFY_STACK_SIZE=65536",
    "-s", "EXPORTED_FUNCTIONS=['_malloc','_free','_d5_zlib_adler','_d5_zlib_uncompress','_d5_zlib_adler_after_pause','_d5_zlib_uncompress_after_pause']"
)
& $compiler @asyncify
if ($LASTEXITCODE -ne 0) { throw "D5 Asyncify zlib probe compilation failed" }

if (Test-Path -LiteralPath $productOutput) {
    Get-ChildItem -LiteralPath $productOutput -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $productOutput -Force | Out-Null
}
Copy-Item (Join-Path $output "*") $productOutput -Recurse -Force
Write-Host "D5 zlib probe built: $productOutput" -ForegroundColor Green
