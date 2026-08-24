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
$motionPlayerTargetRelative = "external\krkrz\plugin\motionplayer"
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
$allPatches = @($patches)
$exportMarker = Join-Path $source ".krkr2web-export-complete"
$fingerprints = @($engineLock.commit, (Get-FileHash -Algorithm SHA256 $PSCommandPath).Hash.ToLowerInvariant())
foreach ($patch in $allPatches) {
    $fingerprints += (Get-FileHash -Algorithm SHA256 $patch).Hash.ToLowerInvariant()
}
foreach ($sourceImport in @($engineLock.sourceImports)) {
    $fingerprints += "$($sourceImport.commit):$($sourceImport.name)"
    $importRoot = Join-Path $projectRoot $sourceImport.localCheckout
    foreach ($file in @($sourceImport.files)) {
        $importPath = Join-Path $importRoot $file.source
        $fingerprints += (Get-FileHash -Algorithm SHA256 $importPath).Hash.ToLowerInvariant()
    }
    foreach ($directory in @($sourceImport.directories | Where-Object { $null -ne $_ })) {
        $importDirectory = Join-Path $importRoot $directory.source
        foreach ($importFile in @(Get-ChildItem -LiteralPath $importDirectory -Recurse -File | Sort-Object FullName)) {
            $fingerprints += (Get-FileHash -Algorithm SHA256 $importFile.FullName).Hash.ToLowerInvariant()
        }
    }
}
$expectedExportMarker = $fingerprints -join ":"

foreach ($required in @($upstream, $emcmake, $emcc, $cmake, $ninja, $probeFont, $probeFontLicense) + $allPatches) {
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
    foreach ($file in @($sourceImport.files)) {
        $importPath = Join-Path $importRoot $file.source
        if (-not (Test-Path -LiteralPath $importPath -PathType Leaf)) {
            throw "$($sourceImport.name) source file is missing: $importPath"
        }
    }
    foreach ($directory in @($sourceImport.directories | Where-Object { $null -ne $_ })) {
        $importPath = Join-Path $importRoot $directory.source
        if (-not (Test-Path -LiteralPath $importPath -PathType Container)) {
            throw "$($sourceImport.name) source directory is missing: $importPath"
        }
    }
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
    # Clear leftovers from a previously failed export before re-exporting.
    if (Test-Path $source) { Remove-Item -LiteralPath $source -Recurse -Force }
    New-Item -ItemType Directory -Force $source | Out-Null
    # Extract with tools/extract_tar.py: both GNU tar (Git Bash) and bsdtar
    # fail to create the repo's android-project symlinks on Windows. The
    # python extractor materializes symlinks as text, like git's
    # core.symlinks=false checkouts. Note: git archive --output must stay
    # absolute -- relative paths resolve inside the -C directory.
    $archivePath = Join-Path $workRoot "source.tar"
    git -C $upstream archive --format=tar --output=$archivePath HEAD
    if ($LASTEXITCODE -ne 0) { throw "Cannot export locked krkrsdl2 source" }
    python (Join-Path $projectRoot "tools\extract_tar.py") --archive $archivePath --dest $source
    if ($LASTEXITCODE -ne 0) { throw "Cannot extract locked krkrsdl2 source" }
    Remove-Item -LiteralPath $archivePath -Force
    # git-submodule is a shell wrapper and is not usable in the restricted
    # Windows build environment. Resolve gitlinks recursively using git's
    # native config/ls-tree/archive commands instead.
    function Get-LockedSubmodules([string]$repository, [string]$prefix) {
        $gitmodules = Join-Path $repository ".gitmodules"
        if (-not (Test-Path -LiteralPath $gitmodules)) { return }
        $entries = @(git -C $repository config --file .gitmodules --get-regexp '^submodule\..*\.path$')
        if ($LASTEXITCODE -notin @(0, 1)) { throw "Cannot inspect submodules: $repository" }
        foreach ($entry in $entries) {
            if ($entry -notmatch '^\S+\s+(.+)$') { continue }
            $childRelative = $Matches[1].Trim()
            $childSource = Join-Path $repository $childRelative
            $treeEntry = (git -C $repository ls-tree HEAD -- $childRelative | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $treeEntry -notmatch '^160000 commit ([0-9a-f]{40})\s+') {
                throw "Cannot resolve submodule gitlink: $repository/$childRelative"
            }
            $childCommit = $Matches[1]
            $actualChildCommit = (git -C $childSource rev-parse HEAD).Trim()
            if ($LASTEXITCODE -ne 0 -or $actualChildCommit -ne $childCommit) {
                throw "Submodule $childSource is $actualChildCommit; expected $childCommit"
            }
            $outputRelative = if ($prefix) { Join-Path $prefix $childRelative } else { $childRelative }
            [pscustomobject]@{
                Source = $childSource
                Relative = $outputRelative
                Commit = $childCommit
            }
            Get-LockedSubmodules $childSource $outputRelative
        }
    }
    foreach ($submodule in @(Get-LockedSubmodules $upstream "")) {
        $submoduleTarget = Join-Path $source $submodule.Relative
        New-Item -ItemType Directory -Force $submoduleTarget | Out-Null
        $archivePath = Join-Path $workRoot "submodule.tar"
        git -C $submodule.Source archive --format=tar --output=$archivePath $submodule.Commit
        if ($LASTEXITCODE -ne 0) { throw "Cannot export submodule: $($submodule.Relative)" }
        python (Join-Path $projectRoot "tools\extract_tar.py") --archive $archivePath --dest $submoduleTarget
        if ($LASTEXITCODE -ne 0) { throw "Cannot extract submodule: $($submodule.Relative)" }
        Remove-Item -LiteralPath $archivePath -Force
    }
    # NOTE: do NOT `git init` here. In the DSH sandbox, git apply misreads
    # file contents whenever a .git directory is present (patch context fails
    # to match even byte-identical lines). git apply works fine without a repo.
    foreach ($sourceImport in @($engineLock.sourceImports)) {
        $importRoot = Join-Path $projectRoot $sourceImport.localCheckout
        # Copy directory units first. Some imports intentionally overlay a
        # compatibility header inside an imported directory (for example the
        # Motion RenderManager ABI); replacing the directory after individual
        # files would silently delete that overlay.
        foreach ($directory in @($sourceImport.directories | Where-Object { $null -ne $_ })) {
            $target = Join-Path $source $directory.target
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force
            }
            New-Item -ItemType Directory -Force $target | Out-Null
            Copy-Item (Join-Path (Join-Path $importRoot $directory.source) "*") `
                -Destination $target -Recurse -Force
        }
        foreach ($file in @($sourceImport.files)) {
            $target = Join-Path $source $file.target
            New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
            Copy-Item -LiteralPath (Join-Path $importRoot $file.source) -Destination $target -Force
        }
    }

    # The locked kirikiroid2-web unit uses krkr2's narrow AsStdString name.
    # krkrsdl2 exposes the ABI-equivalent conversion as AsNarrowStdString.
    foreach ($pluginSourceRoot in @(
        (Join-Path $source $motionPlayerTargetRelative),
        (Join-Path $source "external\krkrz\plugin\psbfile")
    )) {
        foreach ($pluginSourceFile in @(Get-ChildItem -LiteralPath $pluginSourceRoot -Recurse -File | Where-Object { $_.Extension -in @(".cpp", ".h") })) {
            $pluginSourceText = Get-Content -Raw -Encoding UTF8 $pluginSourceFile.FullName
            $adaptedPluginSourceText = $pluginSourceText.Replace(".AsStdString()", ".AsNarrowStdString()")
            if ($adaptedPluginSourceText -ne $pluginSourceText) {
                Set-Content -LiteralPath $pluginSourceFile.FullName -Value $adaptedPluginSourceText -Encoding UTF8 -NoNewline
            }
        }
    }

    # krkr2web: apply patches with python, NOT git apply.  In the DSH sandbox
    # git.exe sees a different file view (reads/writes never reach the files
    # other processes see), so git apply silently misapplies everything.
    foreach ($patch in $patches) {
        python (Join-Path $projectRoot "tools\apply_patch.py") --dir $source --check $patch
        if ($LASTEXITCODE -ne 0) { throw "D3 engine patch does not apply: $patch" }
        python (Join-Path $projectRoot "tools\apply_patch.py") --dir $source $patch
        if ($LASTEXITCODE -ne 0) { throw "D3 engine patch failed: $patch" }
    }
    Set-Content -LiteralPath $exportMarker -Value $expectedExportMarker -Encoding ASCII -NoNewline
}

# krkr2web ADR-008: copy project-owned web shims (spdlog stub + storage/file compat)
# into the build tree on every build, so shim edits take effect without re-exporting.
$webShimSource = Join-Path $projectRoot "engine\web"
$webShimTarget = Join-Path $source "external\krkrz\web"
if (Test-Path $webShimSource) {
    New-Item -ItemType Directory -Force $webShimTarget | Out-Null
    Copy-Item (Join-Path $webShimSource "*") -Destination $webShimTarget -Recurse -Force
}

# krkrsdl2 has no RenderManager abstraction. The imported Motion unit keeps
# the reference ABI while this adapter binds it to the existing Layer path.
$motionCompatSource = Join-Path $projectRoot "engine\plugins\motionplayer-web\MotionRenderCompat.cpp"
$motionCompatTarget = Join-Path $source "$motionPlayerTargetRelative\MotionRenderCompat.cpp"
Copy-Item -LiteralPath $motionCompatSource -Destination $motionCompatTarget -Force

# krkr2web ADR-008: copy libwebp (WebP decode) + WebP graphic loader (from kirikiroid2-web)
# into the build tree on every build. The game stores most images as WebP with
# .png/.jpg/.tlg extensions, so a WebP decoder is required for rendering.
$webpSource = Join-Path $referenceProjects "libwebp\src"
$webpTarget = Join-Path $source "external\webp\src"
if (Test-Path $webpSource) {
    New-Item -ItemType Directory -Force $webpTarget | Out-Null
    Copy-Item (Join-Path $webpSource "*") -Destination $webpTarget -Recurse -Force
}
$loadWebpSource = Join-Path $projectRoot "engine\webp\LoadWEBP.cpp"
$loadWebpTarget = Join-Path $source "external\krkrz\visual\LoadWEBP.cpp"
Copy-Item -LiteralPath $loadWebpSource -Destination $loadWebpTarget -Force

# krkr2web: built-in streamed Ogg Vorbis decoder. It reads through the existing
# virtual XP3 stream, so decoded voice data does not require a whole-file copy.
$vorbisDecoderSource = Join-Path $projectRoot "engine\audio\OggVorbisDecoder.cpp"
$vorbisDecoderTarget = Join-Path $source "external\krkrz\sound\OggVorbisDecoder.cpp"
Copy-Item -LiteralPath $vorbisDecoderSource -Destination $vorbisDecoderTarget -Force

# Generate a minimal libwebp config.h (generic C, no SIMD, no threads) for Emscripten.
$webpConfigDir = Join-Path $source "external\webp\src\webp"
New-Item -ItemType Directory -Force $webpConfigDir | Out-Null
$webpConfig = @"
/* krkr2web: minimal libwebp config (generic C, no SIMD, no threads). */
#define PACKAGE_VERSION "1.3.2"
#define VERSION "1.3.2"
"@
Set-Content -LiteralPath (Join-Path $webpConfigDir "config.h") -Value $webpConfig -Encoding ASCII

# krkr2web ADR-008: copy the saveStruct plugin (adapted: no fmt, +StorageIntf/UtilStreams includes).
$saveStructSource = Join-Path $projectRoot "engine\plugins\saveStruct.cpp"
$saveStructTarget = Join-Path $source "external\krkrz\plugin\saveStruct.cpp"
Copy-Item -LiteralPath $saveStructSource -Destination $saveStructTarget -Force

# krkr2web ADR-008: copy the textrender + layerExImage visual plugins (project-owned adapted copies).
$textRenderSource = Join-Path $projectRoot "engine\plugins\textrender"
$textRenderTarget = Join-Path $source "external\krkrz\plugin\textrender"
New-Item -ItemType Directory -Force $textRenderTarget | Out-Null
Copy-Item (Join-Path $textRenderSource "*") -Destination $textRenderTarget -Force
$layerExImageSource = Join-Path $projectRoot "engine\plugins\layerExImage"
$layerExImageTarget = Join-Path $source "external\krkrz\plugin\layerExImage"
New-Item -ItemType Directory -Force $layerExImageTarget | Out-Null
Copy-Item (Join-Path $layerExImageSource "*") -Destination $layerExImageTarget -Force

# krkr2web ADR-008: copy layerExRaster + layerExBTOA + PackinOne plugins from kirikiroid2-web.
foreach($extra in @("layerExRaster.cpp", "layerExBTOA.cpp", "PackinOne.cpp")) {
    $extraSource = Join-Path $referenceProjects ("kirikiroid2-web\cpp\plugins\" + $extra)
    $extraTarget = Join-Path $source ("external\krkrz\plugin\" + $extra)
    Copy-Item -LiteralPath $extraSource -Destination $extraTarget -Force
}

# krkr2web ADR-008: copy the minimal layerExDraw stub (real one needs libgdiplus/Cocos2D).
$layerExDrawSource = Join-Path $projectRoot "engine\plugins\layerExDraw.cpp"
$layerExDrawTarget = Join-Path $source "external\krkrz\plugin\layerExDraw.cpp"
Copy-Item -LiteralPath $layerExDrawSource -Destination $layerExDrawTarget -Force

# Web platform module for the Window notification contract. The complete
# Windows plugin registers MenuItem/Pad/Debug hooks that do not exist in the
# browser and can leave NCB half-registered when one attachment fails.
$windowExWebSource = Join-Path $projectRoot "engine\plugins\windowEx-web.cpp"
$windowExWebTarget = Join-Path $source "external\krkrz\plugin\windowEx-web.cpp"
Copy-Item -LiteralPath $windowExWebSource -Destination $windowExWebTarget -Force

if (-not (Test-Path (Join-Path $cmakeBuild "build.ninja"))) {
    New-Item -ItemType Directory -Force $cmakeBuild | Out-Null
    & $emcmake $cmake -S $source -B $cmakeBuild -G Ninja `
        "-DCMAKE_MAKE_PROGRAM=$ninja" `
        "-DCMAKE_BUILD_TYPE=Release" `
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
python (Join-Path $projectRoot "tools\check_worker_contract.py") `
    --contract (Join-Path $projectRoot "engine\worker-runtime-contract.json") `
    --build-plan (Join-Path $cmakeBuild "build.ninja") `
    --glue (Join-Path $cmakeBuild "krkrsdl2.js")
if ($LASTEXITCODE -ne 0) { throw "D3 baseline violates the Dedicated Worker contract" }

# krkr2web: standalone wasm libwebp decoder for the page's WebP decode worker
# (play/prefetch.js). WebView kernels without OffscreenCanvas inside workers
# cannot read pixels back through a canvas, so their decodes fell onto the
# page's main thread and starved the OpenAL scheduler. Compiled from the same
# libwebp sources as the engine (decoder-only subset, generic C: no SIMD, no
# threads) so the worker can decode without any canvas API.
$webpWorkerShim = Join-Path $projectRoot "engine\webp\WebpWorker.c"
$webpBase = Join-Path $source "external\webp"
$webpRoot = Join-Path $webpBase "src"
$webpDecSources = @("alpha_dec.c", "buffer_dec.c", "frame_dec.c", "idec_dec.c", "io_dec.c", "quant_dec.c", "tree_dec.c", "vp8_dec.c", "vp8l_dec.c", "webp_dec.c") | ForEach-Object { Join-Path $webpRoot ("dec\" + $_) }
$webpDspSources = @("alpha_processing.c", "cpu.c", "dec.c", "dec_clip_tables.c", "filters.c", "lossless.c", "rescaler.c", "upsampling.c", "yuv.c") | ForEach-Object { Join-Path $webpRoot ("dsp\" + $_) }
$webpUtilSources = @("bit_reader_utils.c", "color_cache_utils.c", "filters_utils.c", "huffman_utils.c", "palette.c", "quant_levels_dec_utils.c", "rescaler_utils.c", "random_utils.c", "thread_utils.c", "utils.c") | ForEach-Object { Join-Path $webpRoot ("utils\" + $_) }
& $emcc $webpWorkerShim $webpDecSources $webpDspSources $webpUtilSources `
    -O3 -I $webpBase -I $webpRoot -o (Join-Path $cmakeBuild "webp-worker.js") `
    -s MODULARIZE=1 -s EXPORT_NAME=Krkr2WebWebpWorker `
    -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=worker `
    -s EXPORTED_FUNCTIONS=_krkr2web_webp_decode,_krkr2web_webp_free,_malloc,_free `
    -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPU32
if ($LASTEXITCODE -ne 0) { throw "WebP worker decoder compilation failed" }

if (Test-Path $output) { Get-ChildItem -LiteralPath $output -Force | Remove-Item -Recurse -Force } else { New-Item -ItemType Directory -Force $output | Out-Null }
Copy-Item (Join-Path $projectRoot "probes\d3-engine\web\*") $output -Recurse
Copy-Item (Join-Path $projectRoot "probes\d2-downloader\web\storage.js") (Join-Path $output "installer-storage.js")
Copy-Item (Join-Path $projectRoot "probes\d2-downloader\web\downloader.js") (Join-Path $output "installer.js")
Copy-Item (Join-Path $cmakeBuild "krkrsdl2.js") $output
Copy-Item (Join-Path $cmakeBuild "krkrsdl2.wasm") $output
Copy-Item (Join-Path $cmakeBuild "webp-worker.js") $output
Copy-Item (Join-Path $cmakeBuild "webp-worker.wasm") $output
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
    $(foreach ($patch in $allPatches) { "--patch"; $patch }) `
    --compiler $emcc --output (Join-Path $output "d3-build.json")
if ($LASTEXITCODE -ne 0) { throw "D3 compatibility gate failed" }
Write-Host "D3 build completed: $output" -ForegroundColor Green
