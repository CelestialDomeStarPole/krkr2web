$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $projectRoot "toolchains\d0-toolchain.lock.json"
$emsdkDirectory = if ($env:KRKR2_EMSDK_DIR) {
    $env:KRKR2_EMSDK_DIR
} else {
    Join-Path $projectRoot ".toolchains\emsdk"
}
$compiler = Join-Path $emsdkDirectory "upstream\emscripten\em++.bat"
$emscriptenDirectory = Join-Path $emsdkDirectory "upstream\emscripten"
$sourceDirectory = Join-Path $projectRoot "probes\d1-file-bridge"
$outputDirectory = if ($env:KRKR2_D1_OUTPUT_DIR) {
    $env:KRKR2_D1_OUTPUT_DIR
} else {
    Join-Path $projectRoot "build\d1-file-bridge"
}

if (-not (Test-Path $compiler)) {
    throw "D1 toolchain is missing. Run .\tools\setup_d0_toolchain.ps1 first."
}

if (Test-Path $outputDirectory) {
    Get-ChildItem -LiteralPath $outputDirectory -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

Copy-Item (Join-Path $sourceDirectory "web\index.html") $outputDirectory
Copy-Item (Join-Path $sourceDirectory "web\styles.css") $outputDirectory
Copy-Item (Join-Path $sourceDirectory "web\storage.js") $outputDirectory
Copy-Item (Join-Path $sourceDirectory "web\app.js") $outputDirectory

$arguments = @(
    (Join-Path $sourceDirectory "src\probe.cpp"),
    "-o", (Join-Path $outputDirectory "d1-probe.js"),
    "-O2", "-std=c++17", "-fno-exceptions", "--no-entry",
    "-s", "MIN_CHROME_VERSION=89",
    "-s", "ENVIRONMENT=web",
    "-s", "MODULARIZE=1",
    "-s", "EXPORT_NAME=createD1Module",
    "-s", "EXPORT_ES6=0",
    "-s", "FILESYSTEM=0",
    "-s", "DYNAMIC_EXECUTION=0",
    "-s", "ASSERTIONS=1",
    "-s", "DISABLE_EXCEPTION_CATCHING=1",
    "-s", "USE_PTHREADS=0",
    "-s", "ASYNCIFY=1",
    "-s", "ASYNCIFY_STACK_SIZE=65536",
    "-s", "WASM_BIGINT=1",
    "-s", "ALLOW_MEMORY_GROWTH=1",
    "-s", "INITIAL_MEMORY=67108864",
    "-s", "MAXIMUM_MEMORY=536870912",
    "-s", "STACK_SIZE=1048576",
    "-s", "MALLOC=emmalloc",
    "-s", "EXPORTED_RUNTIME_METHODS=['ccall']",
    "-s", "EXPORTED_FUNCTIONS=['_d1_run_suite','_d1_run_background_suite','_d1_run_soak_batch','_d1_reset_soak_counters','_d1_pass_mask','_d1_expected_pass_mask','_d1_random_reads','_d1_verified_bytes','_d1_logical_file_size','_d1_last_error','_d1_background_verified_bytes','_d1_soak_reads','_d1_soak_verified_bytes']"
)

& $compiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw "D1 compilation failed"
}

$oldPath = $env:PATH
try {
    $env:PATH = "$emscriptenDirectory;$oldPath"
    python (Join-Path $projectRoot "tools\check_d1_artifacts.py") `
        --wasm (Join-Path $outputDirectory "d1-probe.wasm") `
        --glue (Join-Path $outputDirectory "d1-probe.js") `
        --lock $lockPath `
        --source (Join-Path $sourceDirectory "src\probe.cpp") `
        --output (Join-Path $outputDirectory "d1-build.json") `
        --compiler (Join-Path $emscriptenDirectory "emcc.bat")
    if ($LASTEXITCODE -ne 0) {
        throw "D1 artifact compatibility gate failed"
    }
} finally {
    $env:PATH = $oldPath
}

Move-Item (Join-Path $outputDirectory "d1-probe.js") (Join-Path $outputDirectory "d1-module.js")
Write-Host "D1 build completed: $outputDirectory" -ForegroundColor Green
