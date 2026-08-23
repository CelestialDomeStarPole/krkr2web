(function () {
  "use strict";

  // krkr2web: WebGL shader precision fix. The engine's GL translation layer
  // emits uniform declarations without precision qualifiers; fragment
  // shaders default to mediump on mobile GPUs, which degrades transformed
  // coordinates on those devices. Promote precision-less uniform
  // declarations to highp (same fix as kirikiroid2-web's shell.html).
  (function () {
    var typePattern = /uniform\s+(?!highp\s|mediump\s|lowp\s)(mat[234]|vec[234]|float|int)\s/g;
    function fixPrecision(source) {
      return source.replace(typePattern, "uniform highp $1 ");
    }
    function patchPrototype(proto) {
      if (!proto || proto.__krkr2webPrecisionFixed) { return; }
      var original = proto.shaderSource;
      proto.shaderSource = function (shader, source) {
        return original.call(this, shader, fixPrecision(source));
      };
      proto.__krkr2webPrecisionFixed = true;
    }
    patchPrototype(typeof WebGLRenderingContext !== "undefined" && WebGLRenderingContext.prototype);
    patchPrototype(typeof WebGL2RenderingContext !== "undefined" && WebGL2RenderingContext.prototype);
  })();

  var ENGINE_VARIANTS = {
    baseline: {
      id: "baseline",
      wasmUrl: "/engine/krkrsdl2.wasm",
      factory: "instantiate_krkrsdl2_module"
    }
  };
  var storageBridge = window.krkr2StorageBridge;
  var nativeAlert = window.alert;
  var preloadPromise = null;
  var startPromise = null;
  var stopPromise = null;
  var restartPromise = null;
  var stopSerial = 0;
  var wasmBinary = null;
  var workerScriptTexts = null;
  var engineManifest = null;
  var engineVariant = null;
  var runtimeFallbackReason = null;
  var moduleInstance = null;
  var prepared = null;
  var activeProfile = null;
  var activeGameId = null;
  var activeTitle = null;
  var moduleGeneration = 0;
  var engineSessionActive = false;
  var restartSerial = 0;
  var forcedStopCount = 0;
  var stoppedAt = null;
  var stopReason = null;
  var ready = false;
  var visible = false;
  var crashed = false;
  var saveSyncing = false;
  var saveSyncPromise = null;
  var saveSyncFrozen = false;
  var saveSyncCount = 0;
  var fatalMessage = null;
  var fatalAt = null;
  var alerts = [];
  var errors = [];
  var engineLog = [];
  var firstDynamicError = null;
  var assetState = { status: "idle", bytes: 0, error: null, variant: null };
  var launchEvidence = null;
  var pendingAudioContext = null;
  var activeAudioContext = null;
  var nativeAudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  var audioContextBridgeRestore = null;
  var elements = {
    view: document.getElementById("player-view"),
    back: document.getElementById("player-back-button"),
    restart: document.getElementById("player-restart-button"),
    stop: document.getElementById("player-stop-button"),
    title: document.getElementById("game-title"),
    status: document.getElementById("player-status"),
    detail: document.getElementById("player-detail"),
    save: document.getElementById("save-status"),
    canvas: document.getElementById("canvas")
  };

  function errorText(error) { return error && error.message ? error.message : String(error); }

  function packageByPath(manifest, path) {
    var wanted = String(path).toLowerCase();
    return manifest.packages.find(function (pkg) {
      return String(pkg.virtualPath).toLowerCase() === wanted;
    });
  }

  function resolveEngineProfile(manifest) {
    var registry = window.krkr2EngineProfiles;
    var profile = registry && registry.schemaVersion === 1 && registry.profiles && registry.profiles[manifest.engineProfile];
    if (!profile || profile.schemaVersion !== 1 || profile.id !== manifest.engineProfile) {
      throw new Error("缺少引擎配置：" + manifest.engineProfile);
    }
    profile.requiredPackages.forEach(function (path) {
      if (!packageByPath(manifest, path) || !storageBridge.exists("/" + path)) {
        throw new Error("游戏资源包未完整安装：" + path);
      }
    });
    if (!packageByPath(manifest, profile.entryPackage)) {
      throw new Error("引擎主资源包不存在：" + profile.entryPackage);
    }
    return profile;
  }

  function engineArguments(profile, gameId) {
    var args = [
      "/" + profile.entryPackage,
      "-datapath=/savedata/" + gameId + "/",
      "-krkr2web-profile=" + profile.id
    ];
    profile.autoPathPackages.forEach(function (path) {
      args.push("-krkr2web-autopath=/" + path + ">");
    });
    return args.concat(profile.engineArguments);
  }

  function isDiagnosticNoise(message) {
    // 引擎侧遥测（Motion NodeTree 的 CREATESITE 计数、KRKR2WEB_* 性能日志）
    // 走 stderr 输出，属于正常诊断信息而非运行错误。
    return /^(?:CREATESITE|KRKR2WEB_)/.test(String(message));
  }

  function recordEngineLine(message, isError) {
    var line = String(message);
    engineLog.push((isError ? "stderr: " : "stdout: ") + line);
    if (engineLog.length > 2000) { engineLog.shift(); }
    if (!firstDynamicError && !isDiagnosticNoise(line) &&
        (isError || /(?:error|exception|abort|cannot|failed|not found)/i.test(line))) {
      firstDynamicError = line;
      if (launchEvidence) { launchEvidence.firstDynamicError = line; }
    }
  }

  function notifyState() {
    window.dispatchEvent(new CustomEvent("krkr2-player-state", { detail: snapshot() }));
  }

  function setStatus(title, detail, state) {
    elements.status.textContent = title;
    elements.detail.textContent = detail || "";
    elements.view.dataset.state = state || "loading";
  }

  function isFatalAlert(message) {
    return /(?:致命|エラー|例外|exception|cannot convert|fatal|\berror\b|行\s*:\s*\d+)/i.test(message);
  }

  function captureAlert(message) {
    var text = String(message);
    alerts.push({ message: text, at: new Date().toISOString() });
    if (alerts.length > 16) { alerts.shift(); }
    recordEngineLine("Browser alert: " + text, isFatalAlert(text));
    if ((engineSessionActive || moduleInstance) && isFatalAlert(text)) {
      crashed = true;
      ready = false;
      fatalMessage = text;
      fatalAt = new Date().toISOString();
      errors.push("游戏致命错误：" + text);
      setStatus("游戏发生错误", "可点击上方停止按钮立即终止，或返回游戏库重新启动。", "fail");
      persistEvidence();
      notifyState();
    }
  }

  window.alert = function (message) {
    captureAlert(message);
    return nativeAlert.apply(window, arguments);
  };

  function threadCapability() {
    return { supported: false, reason: "retired-dedicated-worker" };
  }

  function workerCapability() {
    if (typeof window.Krkr2EngineWorkerHost !== "function" ||
        typeof window.Krkr2EngineWorkerHost.capability !== "function") {
      return { supported: false, reason: "worker-host" };
    }
    return window.Krkr2EngineWorkerHost.capability();
  }

  // ---- engine integrity (engine-manifest.json, generated by prepare) ----
  // The engine js/wasm pair must be replaced together: a stale page (old js
  // glue) paired with a fresh wasm fails instantiation with zero engine
  // output whenever the glue interface changes. The manifest lets us verify
  // the wasm we actually downloaded and re-pull with a buster; the page meta
  // lets us detect a stale page against the server and self-heal by
  // reloading once (WebView session restore / cache reuse bypasses HTTP
  // revalidation, so headers alone cannot fix this).
  function fetchEngineManifest() {
    if (engineManifest) { return Promise.resolve(engineManifest); }
    return fetch("/engine-manifest.json", { credentials: "same-origin", cache: "no-store" }).then(function (response) {
      if (!response.ok) { throw new Error("manifest HTTP " + response.status); }
      return response.json();
    }).then(function (manifest) {
      if (!manifest || manifest.schemaVersion !== 1 || !manifest.build || !manifest.files) {
        throw new Error("invalid engine manifest");
      }
      engineManifest = manifest;
      return manifest;
    });
  }

  function bufferSha256Hex(buffer) {
    if (!window.crypto || !window.crypto.subtle || !window.crypto.subtle.digest) {
      return Promise.resolve(null);  // insecure context: byte-size check only
    }
    return window.crypto.subtle.digest("SHA-256", buffer).then(function (digest) {
      var bytes = new Uint8Array(digest);
      var parts = [];
      for (var i = 0; i < bytes.length; i += 1) {
        parts.push((bytes[i] < 16 ? "0" : "") + bytes[i].toString(16));
      }
      return parts.join("");
    });
  }

  function verifyWasmAgainstManifest(buffer, manifest) {
    // Match by suffix: the build stamper rewrites URL-looking string
    // literals in this file (including this key), so an exact lookup would
    // silently miss and skip verification.
    var entry = null;
    Object.keys(manifest.files).some(function (key) {
      if (/\/krkrsdl2\.wasm(\?|$)/.test(key)) { entry = manifest.files[key]; return true; }
      return false;
    });
    if (!entry) { return Promise.resolve(null); }
    if (buffer.byteLength !== entry.bytes) {
      return Promise.resolve("字节数 " + buffer.byteLength + " != " + entry.bytes);
    }
    return bufferSha256Hex(buffer).then(function (hex) {
      if (hex === null || hex === entry.sha256) { return null; }
      return "sha256 不匹配";
    });
  }

  function ensurePageEngineBuild(manifest) {
    var meta = document.querySelector('meta[name="krkr2-engine-build"]');
    var pageBuild = meta && meta.getAttribute("content");
    if (pageBuild === manifest.build) { return; }
    // The running page predates the server's engine: reload to pull the new
    // script chain. Guard with sessionStorage so a page that still mismatches
    // after one reload keeps running instead of looping.
    var key = "krkr2-engine-reload";
    var already;
    try { already = window.sessionStorage.getItem(key) === manifest.build; } catch (error) { already = false; }
    if (!already) {
      try { window.sessionStorage.setItem(key, manifest.build); } catch (error) {}
      window.location.reload();
      return new Promise(function () {});  // page is unloading; stay pending
    }
  }

  function preload() {
    if (assetState.status === "ready" && wasmBinary) { return Promise.resolve(snapshot()); }
    if (preloadPromise) { return preloadPromise; }
    assetState = { status: "loading", bytes: 0, error: null, variant: null };
    notifyState();
    preloadPromise = (async function () {
      // krkr2web: capture the texts of every script the dedicated worker
      // loads (its own bootstrap plus storage/prefetch/engine) so an
      // offline launch can import them from Blob URLs: Chrome's offline
      // emulation aborts worker script loads (new Worker and importScripts
      // alike) even when HTTP cache entries exist.
      if (workerScriptTexts === null) {
        workerScriptTexts = Promise.all([
          "/engine-worker.js", "/play/storage.js", "/play/prefetch.js", "/engine/krkrsdl2.js"
        ].map(function (url) {
          return fetch(url, { credentials: "same-origin" })
            .then(function (response) { return response.ok ? response.text() : null; })
            .catch(function () { return null; });
        })).then(function (texts) {
          return {
            worker: texts[0], storage: texts[1], prefetch: texts[2], engine: texts[3]
          };
        });
      }
      var capability = workerCapability();
      var candidates = [ENGINE_VARIANTS.baseline];
      runtimeFallbackReason = capability.supported ? null : capability.reason;
      // Manifest fetch and page-build check must not block launches against
      // an older server without the manifest (fall back to no verification).
      var manifest = null;
      try { manifest = await fetchEngineManifest(); } catch (error) {
        errors.push("引擎清单不可用（跳过完整性校验）：" + errorText(error));
      }
      if (manifest) {
        var healing = ensurePageEngineBuild(manifest);
        if (healing) { await healing; }
      }
      var lastError = null;
      for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index];
        try {
          if (launchEvidence) { launchEvidence.networkFetches += 1; }
          var response = await fetch(candidate.wasmUrl, { credentials: "same-origin" });
          if (!response.ok) { throw new Error("HTTP " + response.status); }
          var buffer = await response.arrayBuffer();
          if (!buffer.byteLength || !WebAssembly.validate(buffer)) { throw new Error("invalid wasm feature set"); }
          if (manifest) {
            var mismatch = await verifyWasmAgainstManifest(buffer, manifest);
            if (mismatch) {
              // Stale cache entry under this URL: force a network re-pull.
              if (launchEvidence) { launchEvidence.networkFetches += 1; }
              var bustUrl = candidate.wasmUrl + (candidate.wasmUrl.indexOf("?") === -1 ? "?" : "&") +
                "krkr2bust=" + Date.now();
              response = await fetch(bustUrl, { credentials: "same-origin", cache: "reload" });
              if (!response.ok) { throw new Error("bust HTTP " + response.status); }
              buffer = await response.arrayBuffer();
              var stillBad = await verifyWasmAgainstManifest(buffer, manifest);
              if (stillBad) { throw new Error("引擎文件校验失败（" + stillBad + "）"); }
            }
          }
          if (!capability.supported && typeof window[candidate.factory] !== "function") {
            throw new Error("missing module factory");
          }
          wasmBinary = new Uint8Array(buffer);
          var forcedBaseline = new URLSearchParams(location.search).get("engineVariant") === "baseline";
          engineVariant = capability.supported && !forcedBaseline ? Object.assign({}, candidate, {
            id: "dedicated-worker-baseline",
            worker: true
          }) : candidate;
          assetState = { status: "ready", bytes: buffer.byteLength, error: null, variant: engineVariant.id };
          notifyState();
          return snapshot();
        } catch (error) {
          lastError = error;
          runtimeFallbackReason = "baseline-load: " + errorText(error);
        }
      }
      throw lastError || new Error("No compatible engine variant");
    }()).catch(function (error) {
      assetState = { status: "failed", bytes: 0, error: errorText(error), variant: null };
      preloadPromise = null;
      notifyState();
      throw error;
    });
    return preloadPromise;
  }

  async function mountSaves(module, gameId) {
    var root = "/savedata";
    var gameRoot = root + "/" + gameId;
    try { module.FS.mkdir(root); } catch (error) {}
    try { module.FS.mkdir(gameRoot); } catch (error) {}
    module.FS.mount(module.IDBFS, {}, gameRoot);
    await new Promise(function (resolve, reject) {
      module.FS.syncfs(true, function (error) { error ? reject(error) : resolve(); });
    });
  }

  function syncSaves(options) {
    var force = options && options.force;
    var instance = moduleInstance;
    var workerSync = instance && typeof instance.syncSaves === "function";
    var directSync = instance && instance.FS && typeof instance.FS.syncfs === "function";
    if ((!force && saveSyncFrozen) || !instance || (!workerSync && !directSync)) {
      return Promise.resolve({ skipped: true });
    }
    if (saveSyncing && saveSyncPromise) { return saveSyncPromise; }
    saveSyncing = true;
    elements.save.textContent = "保存中";
    saveSyncPromise = new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish(new Error("存档同步超时")); }, 8000);
      function finish(error) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        saveSyncing = false;
        saveSyncPromise = null;
        if (error) {
          errors.push("存档同步失败：" + errorText(error));
          elements.save.textContent = "保存失败";
        } else {
          saveSyncCount += 1;
          elements.save.textContent = "已保存";
        }
        persistEvidence();
        resolve({ error: error ? errorText(error) : null });
      }
      try {
        if (workerSync) {
          Promise.resolve(instance.syncSaves()).then(function () { finish(); }, finish);
        } else {
          instance.FS.syncfs(false, finish);
        }
      } catch (error) { finish(error); }
    });
    return saveSyncPromise;
  }

  function audioContextOf(instance) {
    return (instance && instance.audioContext) ||
      (instance && instance.SDL2 && instance.SDL2.audioContext) || activeAudioContext;
  }

  function restoreAudioContextBridge() {
    if (!audioContextBridgeRestore) { return; }
    audioContextBridgeRestore();
    audioContextBridgeRestore = null;
  }

  function armAudioContextBridge(context) {
    restoreAudioContextBridge();
    if (!context || !nativeAudioContextConstructor) { return false; }
    var previousAudioContext = window.AudioContext;
    var previousWebkitAudioContext = window.webkitAudioContext;
    function BridgedAudioContext(options) {
      if (context.state !== "closed") { return context; }
      return new nativeAudioContextConstructor(options);
    }
    BridgedAudioContext.prototype = nativeAudioContextConstructor.prototype;
    try { Object.setPrototypeOf(BridgedAudioContext, nativeAudioContextConstructor); } catch (error) {}
    window.AudioContext = BridgedAudioContext;
    if (previousWebkitAudioContext) { window.webkitAudioContext = BridgedAudioContext; }
    audioContextBridgeRestore = function () {
      if (window.AudioContext === BridgedAudioContext) { window.AudioContext = previousAudioContext; }
      if (window.webkitAudioContext === BridgedAudioContext) { window.webkitAudioContext = previousWebkitAudioContext; }
    };
    return true;
  }

  function createGestureAudioContext(forceNew) {
    var current = !forceNew && (pendingAudioContext || audioContextOf(moduleInstance));
    if (current && current.state !== "closed") {
      if (current.state === "suspended") { current.resume().catch(function () {}); }
      return current;
    }
    if (!nativeAudioContextConstructor) { return null; }
    try {
      current = new nativeAudioContextConstructor();
      if (current.state === "suspended") { current.resume().catch(function () {}); }
      return current;
    } catch (error) {
      errors.push("音频初始化失败：" + errorText(error));
      return null;
    }
  }

  function closeAudioContext(instance) {
    var context = audioContextOf(instance);
    if (context && context.state !== "closed") {
      try { context.close().catch(function () {}); } catch (error) {}
    }
    if (context === activeAudioContext) { activeAudioContext = null; }
    restoreAudioContextBridge();
  }

  function usesDirectKag(profile) {
    return !!(profile && profile.runtimeCompatibility && profile.runtimeCompatibility.directKagScenario);
  }

  function applyRuntimeCompatibility(instance, generation) {
    if (!instance || generation !== moduleGeneration || !usesDirectKag(activeProfile) || typeof instance.evalTJS !== "function") {
      return false;
    }
    if (launchEvidence) { launchEvidence.directKagAttempts += 1; }
    try {
      var result = instance.evalTJS("(function(){ if(typeof world_object != 'undefined') { world_object.playerExecMode = false; return true; } return false; })()");
      if (result === true || result === 1) {
        if (launchEvidence) { launchEvidence.directKagApplied = true; }
        return true;
      }
    } catch (error) {
      if (launchEvidence) { launchEvidence.directKagLastError = errorText(error); }
    }
    return false;
  }

  function scheduleRuntimeCompatibility(instance, generation) {
    if (!usesDirectKag(activeProfile)) { return; }
    var attempts = 0;
    function attempt() {
      if (generation !== moduleGeneration || instance !== moduleInstance) { return; }
      attempts += 1;
      if (!applyRuntimeCompatibility(instance, generation) && attempts < 240) {
        setTimeout(attempt, 250);
      } else {
        persistEvidence();
      }
    }
    setTimeout(attempt, 0);
  }

  function installCanvasCompatibilityBridge(canvas) {
    function apply() { applyRuntimeCompatibility(moduleInstance, moduleGeneration); }
    canvas.addEventListener("pointerdown", apply, true);
    canvas.addEventListener("touchstart", apply, { capture: true, passive: true });
    canvas.addEventListener("mousedown", apply, true);
  }

  function replaceCanvas() {
    var replacement = elements.canvas.cloneNode(false);
    elements.canvas.parentNode.replaceChild(replacement, elements.canvas);
    elements.canvas = replacement;
    installCanvasCompatibilityBridge(replacement);
  }

  function snapshot() {
    var audioContext = audioContextOf(moduleInstance);
    return {
      assets: Object.assign({}, assetState, { verifiedBuild: engineManifest && engineManifest.build || null }),
      gameId: activeGameId,
      contentVersion: prepared && prepared.version,
      engineProfile: activeProfile && activeProfile.id,
      runtimeVariant: engineVariant && engineVariant.id,
      runtimeFallbackReason: runtimeFallbackReason,
      threadCapability: threadCapability(),
      workerCapability: workerCapability(),
      generation: moduleGeneration,
      running: engineSessionActive || !!moduleInstance,
      ready: ready,
      visible: visible,
      crashed: crashed,
      fatalMessage: fatalMessage,
      fatalAt: fatalAt,
      restarting: !!restartPromise,
      stopping: !!stopPromise,
      forcedStopCount: forcedStopCount,
      stoppedAt: stoppedAt,
      stopReason: stopReason,
      href: location.href,
      storage: moduleInstance && moduleInstance.storageSnapshot || storageBridge.snapshot(),
      prefetch: window.krkr2webPrefetch && typeof window.krkr2webPrefetch.snapshot === "function"
        ? window.krkr2webPrefetch.snapshot() : null,
      workerRuntime: moduleInstance && typeof moduleInstance.snapshot === "function" ? moduleInstance.snapshot() : null,
      wasmMemoryBytes: moduleInstance && moduleInstance.HEAPU8 ? moduleInstance.HEAPU8.buffer.byteLength : null,
      audio: {
        supported: !!nativeAudioContextConstructor,
        active: !!audioContext,
        state: audioContext ? audioContext.state : null,
        sampleRate: audioContext ? audioContext.sampleRate : null,
        bridgeArmed: !!audioContextBridgeRestore
      },
      saveSyncCount: saveSyncCount,
      launch: launchEvidence && Object.assign({}, launchEvidence),
      alerts: alerts.slice(-16),
      errors: errors.slice(-24),
      engineLog: engineLog.slice(-2000),
      firstDynamicError: firstDynamicError,
      canvas: { width: elements.canvas.width, height: elements.canvas.height, clientWidth: elements.canvas.clientWidth, clientHeight: elements.canvas.clientHeight }
    };
  }

  function persistEvidence() {
    var evidence = snapshot();
    // krkr2web: fold the ?debugEarlyLogs=1 console capture (installed as the
    // first inline script in index.html) into the persisted failure session
    // so boot problems that predate the shell are visible in the evidence.
    if (window.__krkr2webEarlyLogs && window.__krkr2webEarlyLogs.length) {
      evidence.earlyLogs = window.__krkr2webEarlyLogs.slice(-200);
    }
    try { localStorage.setItem("krkr2web-d4-last-player", JSON.stringify(evidence)); } catch (error) {}
    return evidence;
  }

  async function requestWakeLock() {
    if (!navigator.wakeLock || document.visibilityState !== "visible") { return; }
    try { await navigator.wakeLock.request("screen"); } catch (error) {}
  }

  function show() {
    visible = true;
    elements.view.hidden = false;
    elements.view.setAttribute("aria-hidden", "false");
    var audioContext = pendingAudioContext || audioContextOf(moduleInstance);
    if (audioContext && audioContext.state === "suspended") { audioContext.resume().catch(function () {}); }
    requestWakeLock();
    notifyState();
  }

  function hide() {
    visible = false;
    elements.view.hidden = true;
    elements.view.setAttribute("aria-hidden", "true");
    var audioContext = audioContextOf(moduleInstance);
    if (audioContext && audioContext.state === "running") { audioContext.suspend().catch(function () {}); }
    syncSaves();
    notifyState();
  }

  // krkr2web: cross-tab engine singleton via Web Locks. Two engine instances
  // on one origin would fight over the shared IndexedDB resource database and
  // the save space. The lock is held only while a session is active:
  // terminateInstance() releases it and a restart re-acquires through its own
  // startFresh(). Locks are tied to the document, so a closed or crashed tab
  // releases automatically without heartbeats. Chrome 89 and the target
  // WebView ship Web Locks; when the API is absent the guard is disabled
  // instead of misreporting a capability gap as a conflicting instance.
  var ENGINE_LOCK_NAME = "krkr2web-engine-instance";
  var engineLockRelease = null;

  function acquireEngineSingleton() {
    if (!(navigator.locks && typeof navigator.locks.request === "function")) {
      return Promise.resolve(true);
    }
    return new Promise(function (resolve) {
      navigator.locks.request(ENGINE_LOCK_NAME, { mode: "exclusive", ifAvailable: true },
        function (lock) {
          if (!lock) { return undefined; }
          resolve(true);
          // Keep this returned promise pending to hold the lock;
          // releaseEngineSingleton() settles it.
          return new Promise(function (holdResolve) {
            engineLockRelease = function () {
              engineLockRelease = null;
              holdResolve();
            };
          });
        })
        .then(function (held) { if (held === undefined) { resolve(false); } })
        .catch(function () { resolve(false); });
    });
  }

  function releaseEngineSingleton() {
    if (!engineLockRelease) { return; }
    var release = engineLockRelease;
    engineLockRelease = null;
    try { release(); } catch (error) {}
  }

  function terminateInstance(instance, reason, forced) {
    try {
      // preserve the frozen-session tail across restarts so a post-freeze
      // relaunch cannot overwrite the evidence in the engineLog ring buffer
      localStorage.setItem("krkr2web-d4-last-session", JSON.stringify({
        stoppedAt: new Date().toISOString(),
        stopReason: reason || "stop",
        crashed: crashed,
        stalledAt: engineStallSince,
        stallSilentMs: engineStallSilentMs,
        lastLog: engineLog.slice(-40)
      }));
    } catch (error) {}
    saveSyncFrozen = true;
    engineSessionActive = false;
    releaseEngineSingleton();
    moduleGeneration += 1;
    engineHeartbeatAt = 0;
    engineStallSince = null;
    try {
      if (instance && typeof instance.forceTerminate === "function") {
        instance.forceTerminate();
      }
    } catch (error) {
      errors.push("取消引擎主循环失败：" + errorText(error));
    }
    try {
      if (instance && instance.IDBFS && typeof instance.IDBFS.quit === "function") { instance.IDBFS.quit(); }
    } catch (error) {}
    closeAudioContext(instance);
    window.krkr2webVideoStop();
    if (storageBridge.releaseAll) { storageBridge.releaseAll(); }
    // cancel queued prefetches for the dying engine instance (parks stay:
    // they are keyed by content address and remain valid across restarts)
    if (window.krkr2webPrefetch && typeof window.krkr2webPrefetch.cancelAll === "function") {
      try { window.krkr2webPrefetch.cancelAll(); } catch (error) {}
    }
    if (moduleInstance === instance) { moduleInstance = null; }
    window.Module = null;
    ready = false;
    crashed = false;
    fatalMessage = null;
    fatalAt = null;
    stoppedAt = new Date().toISOString();
    stopReason = reason || "stop";
    if (forced) { forcedStopCount += 1; }
    if (instance && instance.replacementCanvas) {
      if (elements.canvas !== instance.replacementCanvas) {
        elements.canvas = instance.replacementCanvas;
        installCanvasCompatibilityBridge(elements.canvas);
      }
    } else {
      replaceCanvas();
    }
  }

  async function stop(options) {
    if (stopPromise) { return stopPromise; }
    var shouldSync = !options || options.sync !== false;
    var requestSerial = ++stopSerial;
    stopPromise = (async function () {
      setStatus("正在停止引擎", "正在保存本机进度，页面地址不会改变", "loading");
      notifyState();
      var pendingStart = startPromise;
      if (pendingStart) {
        try { await pendingStart; } catch (error) {}
      }
      var instance = moduleInstance;
      if (!instance) {
        engineSessionActive = false;
        return snapshot();
      }
      if (shouldSync && !crashed) { await syncSaves({ force: true }); }
      if (requestSerial !== stopSerial) { return snapshot(); }
      terminateInstance(instance, options && options.reason || "stop", false);
      setStatus("引擎已停止", "可以返回游戏库或重新启动", "fail");
      persistEvidence();
      notifyState();
      return snapshot();
    }());
    return stopPromise.then(function (value) {
      stopPromise = null;
      return value;
    }, function (error) {
      stopPromise = null;
      throw error;
    });
  }

  function forceStop(reason) {
    stopSerial += 1;
    restartSerial += 1;
    restartPromise = null;
    stopPromise = null;
    setStatus("正在强制终止", "不会等待游戏脚本或存档同步", "loading");
    var instance = moduleInstance;
    terminateInstance(instance, reason || "user-force-stop", true);
    setStatus("游戏已强制终止", "尚未同步的进度可能丢失", "fail");
    persistEvidence();
    notifyState();
    return Promise.resolve(snapshot());
  }

  async function startFresh(gameId, title, audioContext) {
    engineSessionActive = true;
    activeAudioContext = audioContext || null;
    var audioBridgeArmed = armAudioContextBridge(activeAudioContext);
    show();
    elements.title.textContent = title || gameId;
    setStatus("正在准备引擎", "本次启动不会改变页面地址", "loading");
    var generation = moduleGeneration + 1;
    moduleGeneration = generation;
    ready = false;
    crashed = false;
    fatalMessage = null;
    fatalAt = null;
    saveSyncFrozen = false;
    firstDynamicError = null;
    var singletonHeld = await acquireEngineSingleton();
    if (!singletonHeld) {
      engineSessionActive = false;
      setStatus("引擎已在其他标签页运行", "同一站点同时只能运行一个引擎实例；请关闭其他标签页后重试", "fail");
      persistEvidence();
      notifyState();
      throw new Error("Engine singleton conflict: another tab holds the engine lock");
    }
    try {
      launchEvidence = {
        requestedAt: new Date().toISOString(),
        href: location.href,
        online: navigator.onLine,
        generation: generation,
        assetsReadyBeforeStart: assetState.status === "ready" && !!wasmBinary,
        networkFetches: 0,
        audioContextCreatedFromLaunch: !!audioContext,
        audioContextBridgeArmed: audioBridgeArmed,
        runtimeVariant: engineVariant && engineVariant.id,
        runtimeFallbackReason: runtimeFallbackReason,
        directKagAttempts: 0,
        directKagApplied: false
      };
      if (assetState.status !== "ready" || !wasmBinary) { await preload(); }
      launchEvidence.runtimeVariant = engineVariant && engineVariant.id;
      launchEvidence.runtimeFallbackReason = runtimeFallbackReason;
      prepared = await storageBridge.prepare(gameId);
      activeGameId = gameId;
      activeTitle = prepared.manifest.title || title || gameId;
      elements.title.textContent = activeTitle;
      activeProfile = resolveEngineProfile(prepared.manifest);
      // game-native render resolution: the canvas is stretched to the player
      // stage by CSS, so rendering at the game's native 720p cuts per-frame
      // pixel work ~2.25x versus full-screen composition on 1080p-class
      // devices while matching the game's own output size
      if (activeProfile.display && activeProfile.display.mode === "720p") {
        elements.canvas.width = 1280;
        elements.canvas.height = 720;
      }
      launchEvidence.engineProfile = activeProfile.id;
      launchEvidence.mountedPackages = activeProfile.requiredPackages.slice();
      launchEvidence.autoPaths = activeProfile.autoPathPackages.slice();
      launchEvidence.plugins = Object.assign({}, activeProfile.plugins);
      launchEvidence.videoStrategy = activeProfile.videoStrategy;
      launchEvidence.firstDynamicError = null;
      setStatus("正在载入游戏", "从本机读取 " + activeTitle, "loading");
      if (engineVariant && engineVariant.worker) {
        var scripts = await workerScriptTexts;
        var host = new window.Krkr2EngineWorkerHost({
          canvas: elements.canvas,
          audioContext: audioContext,
          onCanvasReplaced: function (detail) {
            if (!detail || !detail.canvas) { return; }
            elements.canvas = detail.canvas;
            installCanvasCompatibilityBridge(elements.canvas);
          },
          onStdout: function (message) {
            if (generation !== moduleGeneration) { return; }
            recordEngineLine(message, false);
            if (String(message).indexOf("Startup script ended.") !== -1 ||
                String(message).indexOf("KRKR2WEB_D3_INTERACTIVE_READY") !== -1) {
              ready = true;
              setStatus("游戏已启动", "", "ready");
              persistEvidence();
            }
          },
          onStderr: function (message) {
            if (generation !== moduleGeneration) { return; }
            recordEngineLine(message, true);
            if (isDiagnosticNoise(message)) { return; }
            errors.push(String(message));
            persistEvidence();
          },
          onInteractiveReady: function () {
            if (generation !== moduleGeneration) { return; }
            ready = true;
            setStatus("游戏已启动", "", "ready");
            persistEvidence();
            notifyState();
          },
          onHeartbeat: function () {
            if (generation === moduleGeneration) { window.krkr2webEngineHeartbeat(); }
          },
          onSavesReady: function () {
            if (generation === moduleGeneration) { elements.save.textContent = "存档已读取"; }
          },
          onFatal: function (detail) {
            if (generation !== moduleGeneration) { return; }
            var reason = detail && detail.error ? errorText(detail.error) : "Worker engine failed";
            crashed = true;
            ready = false;
            recordEngineLine("Worker fatal: " + reason, true);
            errors.push("Worker fatal: " + reason);
            setStatus("引擎已停止", reason, "fail");
            persistEvidence();
            notifyState();
          },
          onExit: function (message) {
            if (generation !== moduleGeneration) { return; }
            ready = false;
            if (Number(message && message.status || 0) !== 0) { crashed = true; }
            persistEvidence();
            notifyState();
          },
          onEngineQuit: function () {
            if (generation === moduleGeneration) { window.krkr2webEngineQuit(); }
          }
        });
        moduleInstance = host;
        window.Module = host;
        notifyState();
        await host.start({
          gameId: gameId,
          arguments: engineArguments(activeProfile, gameId),
          workerUrl: "/engine-worker.js",
          workerScript: scripts.worker,
          scriptTexts: {
            storage: scripts.storage,
            prefetch: scripts.prefetch,
            engine: scripts.engine
          },
          engineScriptUrl: "/engine/krkrsdl2.js",
          wasmUrl: engineVariant.wasmUrl,
          storageScriptUrl: "/play/storage.js",
          prefetchScriptUrl: "/play/prefetch.js",
          factoryName: engineVariant.factory,
          wasmBinary: wasmBinary,
          audioContext: audioContext,
          width: elements.canvas.width,
          height: elements.canvas.height,
          startTimeoutMs: 120000
        });
        if (generation !== moduleGeneration) {
          host.forceTerminate("superseded-start");
          return snapshot();
        }
        pendingAudioContext = null;
        if (activeProfile.allowStartupTimeoutReady) {
          setTimeout(function () {
            if (generation === moduleGeneration && !ready) {
              ready = true;
              setStatus("游戏已启动", "", "ready");
              persistEvidence();
            }
          }, 1500);
        }
        notifyState();
        return snapshot();
      }
      var moduleOptions = {
        arguments: engineArguments(activeProfile, gameId),
        canvas: elements.canvas,
        krkr2Storage: storageBridge,
        wasmBinary: wasmBinary,
        noInitialRun: false,
        preRun: [function () {
          moduleOptions.addRunDependency("krkr2web-product-saves");
          mountSaves(moduleOptions, gameId).then(function () {
            if (generation === moduleGeneration) { elements.save.textContent = "存档已读取"; }
            moduleOptions.removeRunDependency("krkr2web-product-saves");
          }, function (error) {
            errors.push("存档读取失败：" + errorText(error));
            moduleOptions.removeRunDependency("krkr2web-product-saves");
          });
        }],
        print: function (message) {
          if (generation !== moduleGeneration) { return; }
          recordEngineLine(message, false);
          if (String(message).indexOf("Startup script ended.") !== -1 || String(message).indexOf("KRKR2WEB_D3_INTERACTIVE_READY") !== -1) {
            ready = true;
            setStatus("游戏已启动", "", "ready");
            persistEvidence();
          }
        },
        printErr: function (message) {
          if (generation !== moduleGeneration) { return; }
          recordEngineLine(message, true);
          if (isDiagnosticNoise(message)) { return; }
          errors.push(String(message));
          persistEvidence();
        },
        onRuntimeInitialized: function () {
          if (generation === moduleGeneration) { setStatus("正在执行游戏脚本", "请稍候", "loading"); }
        },
        onAbort: function (reason) {
          if (generation !== moduleGeneration) { return; }
          crashed = true;
          ready = false;
          releaseEngineSingleton();
          recordEngineLine("Wasm abort: " + String(reason), true);
          errors.push("Wasm abort: " + String(reason));
          setStatus("引擎已停止", String(reason), "fail");
          persistEvidence();
          notifyState();
        },
        onExit: function (status) {
          if (generation !== moduleGeneration) { return; }
          ready = false;
          releaseEngineSingleton();
          if (status !== 0) {
            crashed = true;
            setStatus("引擎已停止", "退出状态：" + status, "fail");
          }
          persistEvidence();
          notifyState();
        }
      };
      if (audioContext) { moduleOptions.SDL2 = { audioContext: audioContext }; }
      window.Module = moduleOptions;
      var factory = engineVariant && window[engineVariant.factory];
      if (typeof factory !== "function") { throw new Error("Selected engine factory is unavailable"); }
      var instance = await factory(moduleOptions);
      if (generation !== moduleGeneration) {
        try {
          if (typeof instance.forceTerminate === "function") {
            instance.forceTerminate();
          }
        } catch (error) {}
        return snapshot();
      }
      moduleInstance = instance;
      pendingAudioContext = null;
      scheduleRuntimeCompatibility(moduleInstance, generation);
      if (activeProfile.allowStartupTimeoutReady) {
        setTimeout(function () {
          if (generation === moduleGeneration && !ready) {
            ready = true;
            setStatus("游戏已启动", "", "ready");
            persistEvidence();
          }
        }, 1500);
      }
      notifyState();
      return snapshot();
    } catch (error) {
      pendingAudioContext = null;
      if (generation !== moduleGeneration) { return snapshot(); }
      engineSessionActive = false;
      releaseEngineSingleton();
      crashed = true;
      if (engineVariant && engineVariant.worker && moduleInstance) {
        try { moduleInstance.forceTerminate("startup-failed"); } catch (ignored) {}
        moduleInstance = null;
        window.Module = null;
      }
      closeAudioContext(moduleInstance);
      errors.push(errorText(error));
      setStatus("无法启动游戏", errorText(error), "fail");
      persistEvidence();
      notifyState();
      throw error;
    }
  }

  function start(gameId, title) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameId)) { return Promise.reject(new Error("游戏标识无效")); }
    var audioContext = createGestureAudioContext(false);
    if (moduleInstance) {
      if (activeGameId !== gameId) {
        // krkr2web: switching to another game from a multi-game library stops
        // the running session gracefully first — its saves are synced and the
        // engine lock released — instead of dead-ending on a manual force
        // stop. Same-tab switch; a second tab still hits the singleton guard.
        return stop({ sync: !crashed, reason: "switch-game" }).then(function () {
          return beginStart(gameId, title, audioContext);
        });
      }
      if (crashed) { return restart(gameId, title, createGestureAudioContext(true)); }
      show();
      return Promise.resolve(snapshot());
    }
    if (startPromise) { return startPromise; }
    return beginStart(gameId, title, audioContext);
  }

  function beginStart(gameId, title, audioContext) {
    pendingAudioContext = audioContext;
    startPromise = startFresh(gameId, title, audioContext);
    return startPromise.then(function (value) {
      startPromise = null;
      return value;
    }, function (error) {
      startPromise = null;
      throw error;
    });
  }

  function restart(gameId, title, primedContext) {
    var targetGameId = gameId || activeGameId;
    var targetTitle = title || activeTitle || targetGameId;
    if (!targetGameId) { return Promise.reject(new Error("没有可重启的游戏")); }
    if (restartPromise) { return restartPromise; }
    var requestSerial = ++restartSerial;
    var audioContext = primedContext || createGestureAudioContext(true);
    pendingAudioContext = audioContext;
    restartPromise = (async function () {
      await stop({ sync: !crashed, reason: "restart" });
      if (requestSerial !== restartSerial) { throw new Error("重启已被强制终止取消"); }
      pendingAudioContext = audioContext;
      return startFresh(targetGameId, targetTitle, audioContext);
    }());
    return restartPromise.then(function (value) {
      restartPromise = null;
      notifyState();
      return value;
    }, function (error) {
      restartPromise = null;
      notifyState();
      throw error;
    });
  }

  installCanvasCompatibilityBridge(elements.canvas);
  elements.back.addEventListener("click", hide);
  elements.restart.addEventListener("click", function () {
    restart().catch(function (error) { setStatus("无法重启游戏", errorText(error), "fail"); });
  });
  elements.stop.addEventListener("click", function () {
    forceStop("player-toolbar").then(hide);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { syncSaves(); } else if (visible) { requestWakeLock(); }
  });
  window.addEventListener("pagehide", function () { syncSaves(); persistEvidence(); });
  setInterval(syncSaves, 30000);
  var engineHeartbeatAt = 0;
  var engineStallSince = null;
  var engineStallSilentMs = 0;
  var stallToastTimer = 0;
  function showStallToast(text, sticky) {
    var toast = document.getElementById("toast");
    if (!toast) { return; }
    toast.textContent = text;
    toast.hidden = false;
    if (stallToastTimer) { clearTimeout(stallToastTimer); }
    // A stalled-looking engine is usually suspended in an Asyncify load
    // burst; the notice must never cover or block the game canvas, because
    // in-game dialogs still need touch input the moment the engine resumes.
    if (!sticky) { stallToastTimer = setTimeout(function () { toast.hidden = true; }, 6000); }
  }
  function hideStallToast() {
    var toast = document.getElementById("toast");
    if (toast) { toast.hidden = true; }
    if (stallToastTimer) { clearTimeout(stallToastTimer); stallToastTimer = 0; }
  }
  window.krkr2webEngineHeartbeat = function () { engineHeartbeatAt = Date.now(); };
  // ---- engine modal dialog bridge (win32dialog shim messageBox) ----
  // The engine's krkr2webAskMessageBox (patch 0078) shows a real question
  // here instead of answering a canned IDNO, so game confirm dialogs
  // (exit / replay-quit / scene-skip) actually reach their YES branch and a
  // confirmed exit returns the page to the library.
  var engineDialogSeq = 0;
  var engineDialogs = {};  // token -> { result: 0|1(idok/idyes/idno), node }
  function engineDialogButtons(flags) {
    // Win32: MB_YESNO (0x4) renders 是/否, anything else a single OK.
    return (flags & 4) ? [["是", 6], ["否", 7]] : [["确定", 1]];
  }
  window.krkr2webDialogAsk = function (text, caption, flags) {
    var token = ++engineDialogSeq;
    var node = document.createElement("div");
    node.className = "engine-dialog";
    var panel = document.createElement("div");
    panel.className = "engine-dialog-panel";
    var title = document.createElement("strong");
    title.textContent = caption || "确认";
    var body = document.createElement("span");
    body.textContent = text || "";
    var row = document.createElement("div");
    row.className = "engine-dialog-actions";
    engineDialogButtons(flags | 0).forEach(function (entry) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = entry[0];
      button.addEventListener("click", function () {
        engineDialogs[token].result = entry[1];
      });
      row.appendChild(button);
    });
    panel.appendChild(title);
    panel.appendChild(body);
    panel.appendChild(row);
    node.appendChild(panel);
    (document.querySelector(".player-stage") || document.body).appendChild(node);
    engineDialogs[token] = { result: 0, node: node };
    return token;
  };
  window.krkr2webDialogPoll = function (token) {
    var dialog = engineDialogs[token];
    if (!dialog) { return -2; }
    return dialog.result > 0 ? dialog.result : -1;
  };
  window.krkr2webDialogDismiss = function (token) {
    var dialog = engineDialogs[token];
    if (!dialog) { return; }
    delete engineDialogs[token];
    if (dialog.node.parentNode) { dialog.node.parentNode.removeChild(dialog.node); }
  };
  window.krkr2webEngineQuit = function () {
    // the engine terminated itself (game exit / System shutdown): stop the
    // session cleanly instead of letting the watchdog flag it as stalled.
    // No forced save sync here: the engine already flushes savedata with its
    // own FS.syncfs during shutdown (Application.cpp), and a second syncfs
    // would contend on the same IDB transactions until the 8s timeout.
    if (!engineSessionActive) { return; }
    errors.push("KRKR2WEB_ENGINE_QUIT 引擎正常退出");
    stop({ sync: false, reason: "engine-quit" }).then(function () { hide(); }, function () { hide(); });
  };
  setInterval(function () {
    if (!engineSessionActive || document.visibilityState !== "visible") { engineStallSince = null; return; }
    var silentMs = Date.now() - engineHeartbeatAt;
    if (engineHeartbeatAt > 0 && silentMs > 40000) {
      if (!engineStallSince) {
        engineStallSince = new Date().toISOString();
        engineStallSilentMs = silentMs;
        // this timer firing proves the JS event loop is alive: the engine is
        // suspended between frames (Asyncify await) rather than the main
        // thread being blocked by a synchronous engine task.
        var pendingOp = null;
        try { pendingOp = window.krkr2webAsyncTrace || window.krkr2webStorageTrace || null; } catch (error) {}
        var pendingText = "";
        if (pendingOp) {
          pendingText = "；挂起操作: " + pendingOp.op + " " + pendingOp.detail +
            " 已 " + Math.round((Date.now() - pendingOp.startedAt) / 1000) + " 秒";
        }
        errors.push("KRKR2WEB_D5_STALL 引擎主循环停跳 " + Math.round(silentMs / 1000) + " 秒（页面可见，JS 事件循环存活 → 引擎挂起等待中" + pendingText + "）");
        setStatus("游戏运行中（加载停顿）", "主循环已停跳 " + Math.round(silentMs / 1000) + " 秒，多为场景加载；游戏画面仍可点击", "ready");
        showStallToast("引擎停跳 " + Math.round(silentMs / 1000) + " 秒（加载中）。若长时间无响应可点右上角 ■ 强制终止。", true);
        notifyState();
        persistEvidence();
      }
    } else if (engineStallSince && silentMs < 3000) {
      engineStallSince = null;
      errors.push("KRKR2WEB_D5_STALL 引擎主循环已恢复（此前停跳约 " + Math.round(engineStallSilentMs / 1000) + " 秒）");
      if (!crashed && ready) { setStatus("游戏已启动", "", "ready"); }
      showStallToast("引擎已恢复（此前停跳约 " + Math.round(engineStallSilentMs / 1000) + " 秒）", false);
      notifyState();
    }
  }, 2000);

  // Generic KRKR video bridge: prefer hardware-decoded H.264/AAC MP4. Keep
  // WebM as a migration fallback for transcodes created by older builds.
  var videoElement = null;
  var videoName = null;
  var videoFailed = false;
  var videoEndedNotified = false;
  function webVideoSources(name) {
    if (!activeGameId || !name) { return null; }
    var stem = name.split("?")[0];
    var slash = stem.lastIndexOf("/");
    if (slash >= 0) { stem = stem.slice(slash + 1); }
    var dot = stem.lastIndexOf(".");
    if (dot > 0) { stem = stem.slice(0, dot); }
    if (!/^[A-Za-z0-9_().-]+$/.test(stem)) { return null; }
    var base = "/videos/" + activeGameId + "/" + encodeURIComponent(stem);
    return [
      { url: base + ".mp4", type: "video/mp4" },
      { url: base + ".webm", type: "video/webm" }
    ];
  }
  function webVideoBounds() {
    if (!videoElement) { return; }
    var rect = elements.canvas.getBoundingClientRect();
    videoElement.style.left = rect.left + "px";
    videoElement.style.top = rect.top + "px";
    videoElement.style.width = rect.width + "px";
    videoElement.style.height = rect.height + "px";
  }
  function webVideoErrorDetail(error) {
    var mediaError = videoElement && videoElement.error;
    return "name=" + (error && error.name ? error.name : "") +
      " message=" + errorText(error || "") +
      " mediaCode=" + (mediaError ? mediaError.code : 0) +
      " networkState=" + (videoElement ? videoElement.networkState : -1) +
      " readyState=" + (videoElement ? videoElement.readyState : -1);
  }
  function webVideoEnded(reason) {
    if (videoElement) { videoElement.style.display = "none"; videoElement.pause(); }
    if (videoEndedNotified) { return; }
    videoEndedNotified = true;
    recordEngineLine("KRKR2WEB_VIDEO_END reason=" + (reason || "ended") + " name=" + String(videoName || ""), false);
    try {
      if (moduleInstance && typeof moduleInstance.krkr2webVideoEnded === "function") {
        moduleInstance.krkr2webVideoEnded();
      }
    } catch (error) { errors.push("视频结束回调失败：" + errorText(error)); }
  }
  window.krkr2webVideoOpen = function (name) {
    videoName = name;
    videoFailed = false;
    videoEndedNotified = false;
    recordEngineLine("KRKR2WEB_VIDEO_OPEN name=" + String(name || ""), false);
  };
  window.krkr2webVideoPlay = function () {
    var sources = webVideoSources(videoName);
    var primaryUrl = sources && sources.length ? sources[0].url : "";
    recordEngineLine("KRKR2WEB_VIDEO_PLAY name=" + String(videoName || "") +
      " sources=" + (sources ? sources.map(function (source) { return source.url; }).join(",") : ""), false);
    if (!sources) { webVideoEnded("invalid-name"); return; }
    if (!videoElement) {
      videoElement = document.createElement("video");
      videoElement.setAttribute("playsinline", "playsinline");
      videoElement.setAttribute("webkit-playsinline", "webkit-playsinline");
      videoElement.preload = "auto";
      videoElement.style.position = "absolute";
      videoElement.style.objectFit = "contain";
      videoElement.style.background = "#000";
      videoElement.style.zIndex = "40";
      // clicks must reach the canvas so the game's own skip handling works
      videoElement.style.pointerEvents = "none";
      videoElement.style.display = "none";
      videoElement.addEventListener("ended", function () { webVideoEnded("ended"); });
      videoElement.addEventListener("error", function (event) {
        videoFailed = true;
        recordEngineLine("KRKR2WEB_VIDEO_ERROR url=" + String(videoElement.currentSrc || videoElement.src || "") +
          " " + webVideoErrorDetail(event), true);
        webVideoEnded("media-error");
      });
      elements.view.appendChild(videoElement);
      window.addEventListener("resize", webVideoBounds);
    }
    webVideoBounds();
    videoElement.loop = false;
    videoElement.muted = false;
    videoElement.removeAttribute("src");
    while (videoElement.firstChild) { videoElement.removeChild(videoElement.firstChild); }
    sources.forEach(function (candidate) {
      var source = document.createElement("source");
      source.src = candidate.url;
      source.type = candidate.type;
      videoElement.appendChild(source);
    });
    videoElement.load();
    videoElement.style.display = "block";
    videoElement.play().then(function () {
      recordEngineLine("KRKR2WEB_VIDEO_STARTED mode=audio url=" +
        String(videoElement.currentSrc || primaryUrl), false);
    }).catch(function (error) {
      recordEngineLine("KRKR2WEB_VIDEO_PLAY_REJECTED url=" +
        String(videoElement.currentSrc || primaryUrl) + " " + webVideoErrorDetail(error), true);
      if (!videoFailed && error && error.name === "NotAllowedError") {
        // Some Android WebViews lose transient user activation while the
        // engine boots. Preserve the OP/ED visuals instead of skipping them.
        videoElement.muted = true;
        videoElement.play().then(function () {
          recordEngineLine("KRKR2WEB_VIDEO_STARTED mode=muted-autoplay-fallback url=" +
            String(videoElement.currentSrc || primaryUrl), false);
        }).catch(function (fallbackError) {
          videoFailed = true;
          recordEngineLine("KRKR2WEB_VIDEO_FALLBACK_FAILED url=" + url + " " +
            webVideoErrorDetail(fallbackError), true);
          webVideoEnded("play-failed");
        });
        return;
      }
      if (!videoFailed) { videoFailed = true; }
      webVideoEnded("play-failed");
    });
  };
  window.krkr2webVideoStop = function () {
    recordEngineLine("KRKR2WEB_VIDEO_STOP name=" + String(videoName || ""), false);
    if (videoElement) { videoElement.style.display = "none"; videoElement.pause(); }
  };
  window.krkr2webVideoPause = function (pause) {
    if (!videoElement) { return; }
    if (pause) { videoElement.pause(); } else { videoElement.play().catch(function () {}); }
  };

  window.krkr2Player = {
    preload: preload,
    start: start,
    restart: restart,
    stop: stop,
    forceStop: forceStop,
    show: show,
    hide: hide,
    syncSaves: syncSaves,
    snapshot: snapshot
  };
  window.d4PlayerState = snapshot;
}());
