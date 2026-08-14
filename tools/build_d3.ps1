param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$engineLockPath = Join-Path $projectRoot "engine\upstream.json"
$targetLockPath = Join-Path $projectRoot "toolchains\d0-toolchain.lock.json"
$engineLock = Get-Content -Raw -Encoding UTF8 $engineLockPath | ConvertFrom-Json
$upstream = Join-Path $projectRoot $engineLock.localCheckout
$referenceProjects = Split-Path -Parent $upstream
$probeFont = Join-Path $referenceProjects "kirikiroid2-web\ui\cocos-studio\DroidSansFallback.ttf"
$probeFontLicense = Join-Path $referenceProjects "kirikiroid2-web\ui\cocos-studio\DroidSansFallback.LICENSE.txt"
$workRoot = Join-Path $projectRoot "build\d3-engine-work"
$source = Join-Path $workRoot "source"
$cmakeBuild = Join-Path $workRoot "cmake"
$output = if ($env:KRKR2_D3_OUTPUT_DIR) { $env:KRKR2_D3_OUTPUT_DIR } else { Join-Path $projectRoot "build\d3-engine" }
$emsdk = if ($env:KRKR2_EMSDK_DIR) { $env:KRKR2_EMSDK_DIR } else { Join-Path $projectRoot ".toolchains\emsdk" }
$emcmake = Join-Path $emsdk "upstream\emscripten\emcmake.bat"
$emcc = Join-Path $emsdk "upstream\emscripten\emcc.bat"
$tools = Join-Path $projectRoot ".toolchains\d3-build-tools\Scripts"
$cmake = Join-Path $tools "cmake.exe"
$ninja = Join-Path $tools "ninja.exe"
$patches = @($engineLock.patches | ForEach-Object { Join-Path (Join-Path $projectRoot "engine") $_ })
$exportMarker = Join-Path $source ".krkr2web-export-complete"
$fingerprints = @($engineLock.commit)
foreach ($patch in $patches) {
    $fingerprints += (Get-FileHash -Algorithm SHA256 $patch).Hash.ToLowerInvariant()
}
foreach ($sourceImport in @($engineLock.sourceImports)) {
    $fingerprints += "$($sourceImport.commit):$($sourceImport.name)"
    foreach ($file in @($sourceImport.files)) {
        $importPath = Join-Path (Join-Path $projectRoot $sourceImport.localCheckout) $file.source
        $fingerprints += (Get-FileHash -Algorithm SHA256 $importPath).Hash.ToLowerInvariant()
    }
}
$expectedExportMarker = $fingerprints -join ":"

foreach ($required in @($upstream, $emcmake, $emcc, $cmake, $ninja, $probeFont, $probeFontLicense) + $patches) {
    if (-not (Test-Path $required)) { throw "D3 dependency missing: $required" }
}
$actualCommit = (git -C $upstream rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $engineLock.commit) {
    throw "krkrsdl2 checkout is $actualCommit; expected $($engineLock.commit)"
}
if (git -C $upstream status --porcelain) { throw "The locked krkrsdl2 checkout has local changes" }
foreach ($sourceImport in @($engineLock.sourceImports)) {
    $importRoot = Join-Path $projectRoot $sourceImport.localCheckout
    if (-not (Test-Path $importRoot)) { throw "D3 source import missing: $importRoot" }
    $importCommit = (git -C $importRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $importCommit -ne $sourceImport.commit) {
        throw "$($sourceImport.name) checkout is $importCommit; expected $($sourceImport.commit)"
    }
    if (git -C $importRoot status --porcelain) { throw "The locked $($sourceImport.name) checkout has local changes" }
}

if ($Clean -and (Test-Path $workRoot)) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
$actualExportMarker = ""
if (Test-Path $exportMarker) {
    $markerContent = Get-Content -Raw $exportMarker
    if ($null -ne $markerContent) { $actualExportMarker = $markerContent.Trim() }
}
if ((Test-Path $source) -and $actualExportMarker -ne $expectedExportMarker) {
    Remove-Item -LiteralPath $source -Recurse -Force
    if (Test-Path $cmakeBuild) { Remove-Item -LiteralPath $cmakeBuild -Recurse -Force }
}
if (-not (Test-Path $exportMarker)) {
    New-Item -ItemType Directory -Force $source | Out-Null
    $archivePath = Join-Path $workRoot "source.tar"
    git -C $upstream archive --format=tar --output=$archivePath HEAD
    if ($LASTEXITCODE -ne 0) { throw "Cannot export locked krkrsdl2 source" }
    tar -xf $archivePath -C $source
    if ($LASTEXITCODE -ne 0) { throw "Cannot extract locked krkrsdl2 source" }
    Remove-Item -LiteralPath $archivePath -Force
    $submodules = git -C $upstream submodule status --recursive
    foreach ($line in $submodules) {
        if ($line -match '^[-+ ]([0-9a-f]{40})\s+([^ ]+)') {
            $relative = $Matches[2]
            $submoduleSource = Join-Path $upstream $relative
            $submoduleTarget = Join-Path $source $relative
            New-Item -ItemType Directory -Force $submoduleTarget | Out-Null
            $archivePath = Join-Path $workRoot "submodule.tar"
            git -C $submoduleSource archive --format=tar --output=$archivePath HEAD
            if ($LASTEXITCODE -ne 0) { throw "Cannot export submodule: $relative" }
            tar -xf $archivePath -C $submoduleTarget
            if ($LASTEXITCODE -ne 0) { throw "Cannot extract submodule: $relative" }
            Remove-Item -LiteralPath $archivePath -Force
        }
    }
    git -C $source init --quiet
    if ($LASTEXITCODE -ne 0) { throw "Cannot initialize temporary D3 source repository" }
    foreach ($sourceImport in @($engineLock.sourceImports)) {
        $importRoot = Join-Path $projectRoot $sourceImport.localCheckout
        foreach ($file in @($sourceImport.files)) {
            $target = Join-Path $source $file.target
            New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
            Copy-Item -LiteralPath (Join-Path $importRoot $file.source) -Destination $target -Force
        }
    }
    foreach ($patch in $patches) {
        git -C $source apply --check --ignore-space-change $patch
        if ($LASTEXITCODE -ne 0) { throw "D3 engine patch does not apply: $patch" }
        git -C $source apply --ignore-space-change $patch
        if ($LASTEXITCODE -ne 0) { throw "D3 engine patch failed: $patch" }
    }
    Set-Content -LiteralPath $exportMarker -Value $expectedExportMarker -Encoding ASCII -NoNewline
}

if (-not (Test-Path (Join-Path $cmakeBuild "build.ninja"))) {
    New-Item -ItemType Directory -Force $cmakeBuild | Out-Null
    & $emcmake $cmake -S $source -B $cmakeBuild -G Ninja `
        "-DCMAKE_MAKE_PROGRAM=$ninja" `
        "-DCMAKE_BUILD_TYPE=MinSizeRel" `
        "-DOPTION_ENABLE_EXTERNAL_PLUGINS=OFF" `
        "-DOPTION_ENABLE_ASYNC_IMAGE_LOAD=OFF" `
        "-DKRKRSDL2_EMSCRIPTEN_ENABLE_THREADS=OFF" `
        "-DKRKRSDL2_EMSCRIPTEN_ENABLE_WASM_SIMD=OFF" `
        "-DKRKRSDL2_EMSCRIPTEN_ENABLE_JS_FALLBACK=OFF" `
        "-DKRKRSDL2_EMSCRIPTEN_ENABLE_BIGINT=ON" `
        "-DKRKRSDL2_EMSCRIPTEN_INITIAL_MEMORY=67108864"
    if ($LASTEXITCODE -ne 0) { throw "D3 CMake configuration failed" }
}
& $cmake --build $cmakeBuild --target krkrsdl2 --parallel
if ($LASTEXITCODE -ne 0) { throw "D3 engine compilation failed" }

if (Test-Path $output) { Get-ChildItem -LiteralPath $output -Force | Remove-Item -Recurse -Force } else { New-Item -ItemType Directory -Force $output | Out-Null }
Copy-Item (Join-Path $projectRoot "probes\d3-engine\web\*") $output -Recurse
Copy-Item (Join-Path $projectRoot "probes\d2-downloader\web\storage.js") (Join-Path $output "installer-storage.js")
Copy-Item (Join-Path $projectRoot "probes\d2-downloader\web\downloader.js") (Join-Path $output "installer.js")
Copy-Item (Join-Path $cmakeBuild "krkrsdl2.js") $output
Copy-Item (Join-Path $cmakeBuild "krkrsdl2.wasm") $output
$licenseOutput = Join-Path $output "licenses"
New-Item -ItemType Directory -Force $licenseOutput | Out-Null
Copy-Item -LiteralPath (Join-Path $upstream "LICENSE") -Destination (Join-Path $licenseOutput "krkrsdl2.LICENSE.txt") -Force
foreach ($sourceImport in @($engineLock.sourceImports)) {
    $importRoot = Join-Path $projectRoot $sourceImport.localCheckout
    Copy-Item -LiteralPath (Join-Path $importRoot $sourceImport.license) `
        -Destination (Join-Path $licenseOutput "$($sourceImport.name).LICENSE.txt") -Force
}
python (Join-Path $projectRoot "tools\generate_test_xp3.py") `
    --startup (Join-Path $projectRoot "probes\d3-engine\game\startup.tjs") `
    --file "scenario.ks=$(Join-Path $projectRoot 'probes\d3-engine\game\scenario.ks')" `
    --file "DroidSansFallback.ttf=$probeFont" `
    --file "DroidSansFallback.LICENSE.txt=$probeFontLicense" `
    --with-probe-media --output (Join-Path $output "data.xp3")
if ($LASTEXITCODE -ne 0) { throw "D3 test XP3 generation failed" }
python (Join-Path $projectRoot "tools\check_d3_artifacts.py") `
    --wasm (Join-Path $output "krkrsdl2.wasm") --glue (Join-Path $output "krkrsdl2.js") `
    --lock $targetLockPath --engine-lock $engineLockPath `
    $(foreach ($patch in $patches) { "--patch"; $patch }) `
    --compiler $emcc --output (Join-Path $output "d3-build.json")
if ($LASTEXITCODE -ne 0) { throw "D3 compatibility gate failed" }
Write-Host "D3 build completed: $output" -ForegroundColor Green
