$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $projectRoot "toolchains\d0-toolchain.lock.json"
$lock = Get-Content -Raw -Encoding utf8 $lockPath | ConvertFrom-Json
$emsdkDirectory = if ($env:KRKR2_EMSDK_DIR) {
    $env:KRKR2_EMSDK_DIR
} else {
    Join-Path $projectRoot ".toolchains\emsdk"
}

if (-not (Test-Path (Join-Path $emsdkDirectory ".git"))) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $emsdkDirectory) | Out-Null
    git clone --branch $lock.emsdk.version --depth 1 $lock.emsdk.repository $emsdkDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to clone the D0 Emscripten SDK"
    }
}

$actualCommit = (git -C $emsdkDirectory rev-parse HEAD).Trim()
if ($actualCommit -ne $lock.emsdk.commit) {
    throw "Unexpected emsdk commit: $actualCommit (expected $($lock.emsdk.commit))"
}

$compilerPackage = "releases-$($lock.emsdk.releasesCommit)-64bit"
& (Join-Path $emsdkDirectory "emsdk.bat") install $lock.emsdk.nodePackage $compilerPackage
if ($LASTEXITCODE -ne 0) {
    throw "D0 Emscripten SDK installation failed"
}

& (Join-Path $emsdkDirectory "emsdk.bat") activate $lock.emsdk.nodePackage $compilerPackage
if ($LASTEXITCODE -ne 0) {
    throw "D0 Emscripten SDK activation failed"
}

& (Join-Path $emsdkDirectory "upstream\emscripten\emcc.bat") --version
if ($LASTEXITCODE -ne 0) {
    throw "D0 Emscripten compiler check failed"
}

Write-Host "D0 toolchain ready at $emsdkDirectory" -ForegroundColor Green
