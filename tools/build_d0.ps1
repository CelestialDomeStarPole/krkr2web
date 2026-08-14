$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $projectRoot "toolchains\d0-toolchain.lock.json"
$lock = Get-Content -Raw -Encoding utf8 $lockPath | ConvertFrom-Json
$emsdkDirectory = if ($env:KRKR2_EMSDK_DIR) {
    $env:KRKR2_EMSDK_DIR
} else {
    Join-Path $projectRoot ".toolchains\emsdk"
}
$compiler = Join-Path $emsdkDirectory "upstream\emscripten\em++.bat"
$emscriptenDirectory = Join-Path $emsdkDirectory "upstream\emscripten"
$sourceDirectory = Join-Path $projectRoot "probes\d0-chrome89"
$outputDirectory = if ($env:KRKR2_D0_OUTPUT_DIR) {
    $env:KRKR2_D0_OUTPUT_DIR
} else {
    Join-Path $projectRoot "build\d0-chrome89"
}

if (-not (Test-Path $compiler)) {
    throw "D0 toolchain is missing. Run .\tools\setup_d0_toolchain.ps1 first."
}

if (Test-Path $outputDirectory) {
    Get-ChildItem -LiteralPath $outputDirectory -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

Copy-Item (Join-Path $sourceDirectory "web\index.html") $outputDirectory
Copy-Item (Join-Path $sourceDirectory "web\styles.css") $outputDirectory
Copy-Item (Join-Path $sourceDirectory "web\app.js") $outputDirectory

$arguments = @(
    (Join-Path $sourceDirectory "src\probe.cpp"),
    "-o", (Join-Path $outputDirectory "d0-probe.js"),
    "-O2", "-std=c++17", "-fno-exceptions", "--no-entry",
    "-s", "MIN_CHROME_VERSION=89",
    "-s", "ENVIRONMENT=web",
    "-s", "MODULARIZE=1",
    "-s", "EXPORT_NAME=createD0Module",
    "-s", "EXPORT_ES6=0",
    "-s", "FILESYSTEM=0",
    "-s", "DYNAMIC_EXECUTION=0",
    "-s", "ASSERTIONS=1",
    "-s", "DISABLE_EXCEPTION_CATCHING=1",
    "-s", "USE_PTHREADS=0",
    "-s", "ASYNCIFY=0",
    "-s", "WASM_BIGINT=1",
    "-s", "ALLOW_MEMORY_GROWTH=1",
    "-s", "INITIAL_MEMORY=33554432",
    "-s", "MAXIMUM_MEMORY=536870912",
    "-s", "STACK_SIZE=1048576",
    "-s", "MALLOC=emmalloc",
    "-s", "EXPORTED_FUNCTIONS=['_d0_core_self_test','_d0_echo_u64','_d0_offset_high','_d0_offset_low','_d0_pointer_bits','_d0_heap_bytes']"
)

& $compiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw "D0 compilation failed"
}

$oldPath = $env:PATH
try {
    $env:PATH = "$emscriptenDirectory;$oldPath"
    python (Join-Path $projectRoot "tools\check_d0_artifacts.py") `
        --wasm (Join-Path $outputDirectory "d0-probe.wasm") `
        --glue (Join-Path $outputDirectory "d0-probe.js") `
        --lock $lockPath `
        --source (Join-Path $sourceDirectory "src\probe.cpp") `
        --output (Join-Path $outputDirectory "d0-build.json") `
        --compiler (Join-Path $emscriptenDirectory "emcc.bat")
    if ($LASTEXITCODE -ne 0) {
        throw "D0 artifact compatibility gate failed"
    }
} finally {
    $env:PATH = $oldPath
}

Move-Item (Join-Path $outputDirectory "d0-probe.js") (Join-Path $outputDirectory "d0-module.js")

Write-Host "D0 build completed: $outputDirectory" -ForegroundColor Green
