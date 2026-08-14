(function () {
  "use strict";

  var ENGINE_WASM_URL = "/engine/krkrsdl2.wasm";
  var storageBridge = window.krkr2StorageBridge;
  var preloadPromise = null;
  var wasmBinary = null;
  var moduleInstance = null;
  var prepared = null;
  var activeProfile = null;
  var activeGameId = null;
  var ready = false;
  var visible = false;
  var saveSyncing = false;
  var saveSyncCount = 0;
  var errors = [];
  var engineLog = [];
  var firstDynamicError = null;
  var assetState = { status: "idle", bytes: 0, error: null };
  var launchEvidence = null;
  var elements = {
    view: document.getElementById("player-view"),
    back: document.getElementById("player-back-button"),
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

  function recordEngineLine(message, isError) {
    var line = String(message);
    engineLog.push((isError ? "stderr: " : "stdout: ") + line);
    if (engineLog.length > 64) { engineLog.shift(); }
    if (!firstDynamicError && (isError || /(?:error|exception|abort|cannot|failed|not found)/i.test(line))) {
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

  function preload() {
    if (assetState.status === "ready" && wasmBinary) { return Promise.resolve(snapshot()); }
    if (preloadPromise) { return preloadPromise; }
    assetState = { status: "loading", bytes: 0, error: null };
    notifyState();
    if (launchEvidence) { launchEvidence.networkFetches += 1; }
    preloadPromise = fetch(ENGINE_WASM_URL, { credentials: "same-origin" }).then(function (response) {
      if (!response.ok) { throw new Error("HTTP " + response.status); }
      return response.arrayBuffer();
    }).then(function (buffer) {
      if (!buffer.byteLength || !WebAssembly.validate(buffer)) { throw new Error("引擎文件无效"); }
      wasmBinary = new Uint8Array(buffer);
      assetState = { status: "ready", bytes: buffer.byteLength, error: null };
      notifyState();
      return snapshot();
    }).catch(function (error) {
      assetState = { status: "failed", bytes: 0, error: errorText(error) };
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

  function syncSaves() {
    if (saveSyncing || !moduleInstance || !moduleInstance.FS || typeof moduleInstance.FS.syncfs !== "function") { return Promise.resolve(); }
    saveSyncing = true;
    elements.save.textContent = "保存中";
    return new Promise(function (resolve) {
      moduleInstance.FS.syncfs(false, function (error) {
        saveSyncing = false;
        if (error) {
          errors.push("存档同步失败：" + errorText(error));
          elements.save.textContent = "保存失败";
        } else {
          saveSyncCount += 1;
          elements.save.textContent = "已保存";
        }
        persistEvidence();
        resolve();
      });
    });
  }

  function snapshot() {
    return {
      assets: Object.assign({}, assetState),
      gameId: activeGameId,
      contentVersion: prepared && prepared.version,
      engineProfile: activeProfile && activeProfile.id,
      ready: ready,
      visible: visible,
      href: location.href,
      storage: storageBridge.snapshot(),
      wasmMemoryBytes: moduleInstance && moduleInstance.HEAPU8 ? moduleInstance.HEAPU8.buffer.byteLength : null,
      saveSyncCount: saveSyncCount,
      launch: launchEvidence && Object.assign({}, launchEvidence),
      errors: errors.slice(-16),
      engineLog: engineLog.slice(-64),
      firstDynamicError: firstDynamicError,
      canvas: { width: elements.canvas.width, height: elements.canvas.height, clientWidth: elements.canvas.clientWidth, clientHeight: elements.canvas.clientHeight }
    };
  }

  function persistEvidence() {
    var evidence = snapshot();
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
    var audioContext = moduleInstance && moduleInstance.SDL2 && moduleInstance.SDL2.audioContext;
    if (audioContext && audioContext.state === "suspended") { audioContext.resume().catch(function () {}); }
    requestWakeLock();
    notifyState();
  }

  function hide() {
    visible = false;
    elements.view.hidden = true;
    elements.view.setAttribute("aria-hidden", "true");
    var audioContext = moduleInstance && moduleInstance.SDL2 && moduleInstance.SDL2.audioContext;
    if (audioContext && audioContext.state === "running") { audioContext.suspend().catch(function () {}); }
    syncSaves();
    notifyState();
  }

  async function start(gameId, title) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameId)) { throw new Error("游戏标识无效"); }
    if (moduleInstance) {
      if (activeGameId !== gameId) { throw new Error("请重新打开页面后再切换另一款游戏"); }
      show();
      return snapshot();
    }

    show();
    elements.title.textContent = title || gameId;
    setStatus("正在准备引擎", "本次启动不会改变页面地址", "loading");
    try {
      launchEvidence = {
        requestedAt: new Date().toISOString(),
        href: location.href,
        online: navigator.onLine,
        assetsReadyBeforeStart: assetState.status === "ready" && !!wasmBinary,
        networkFetches: 0
      };
      if (assetState.status !== "ready" || !wasmBinary) { await preload(); }
      prepared = await storageBridge.prepare(gameId);
      activeGameId = gameId;
      elements.title.textContent = prepared.manifest.title;
      activeProfile = resolveEngineProfile(prepared.manifest);
      launchEvidence.engineProfile = activeProfile.id;
      launchEvidence.mountedPackages = activeProfile.requiredPackages.slice();
      launchEvidence.autoPaths = activeProfile.autoPathPackages.slice();
      launchEvidence.plugins = Object.assign({}, activeProfile.plugins);
      launchEvidence.videoStrategy = activeProfile.videoStrategy;
      launchEvidence.firstDynamicError = null;
      setStatus("正在载入游戏", "从本机读取 " + prepared.manifest.title, "loading");
      var moduleOptions = {
        arguments: engineArguments(activeProfile, gameId),
        canvas: elements.canvas,
        krkr2Storage: storageBridge,
        wasmBinary: wasmBinary,
        noInitialRun: false,
        preRun: [function () {
          moduleOptions.addRunDependency("krkr2web-product-saves");
          mountSaves(moduleOptions, gameId).then(function () {
            elements.save.textContent = "存档已读取";
            moduleOptions.removeRunDependency("krkr2web-product-saves");
          }, function (error) {
            errors.push("存档读取失败：" + errorText(error));
            moduleOptions.removeRunDependency("krkr2web-product-saves");
          });
        }],
        print: function (message) {
          recordEngineLine(message, false);
          if (String(message).indexOf("Startup script ended.") !== -1 || String(message).indexOf("KRKR2WEB_D3_INTERACTIVE_READY") !== -1) {
            ready = true;
            setStatus("游戏已启动", "", "ready");
            persistEvidence();
          }
        },
        printErr: function (message) {
          recordEngineLine(message, true);
          errors.push(String(message));
          persistEvidence();
        },
        onRuntimeInitialized: function () { setStatus("正在执行游戏脚本", "请稍候", "loading"); },
        onAbort: function (reason) {
          recordEngineLine("Wasm abort: " + String(reason), true);
          errors.push("Wasm abort: " + String(reason));
          setStatus("引擎已停止", String(reason), "fail");
          persistEvidence();
        }
      };
      window.Module = moduleOptions;
      moduleInstance = await window.instantiate_krkrsdl2_module(moduleOptions);
      wasmBinary = null;
      if (activeProfile.allowStartupTimeoutReady) {
        setTimeout(function () {
          if (!ready) { ready = true; setStatus("游戏已启动", "", "ready"); persistEvidence(); }
        }, 1500);
      }
      return snapshot();
    } catch (error) {
      errors.push(errorText(error));
      setStatus("无法启动游戏", errorText(error), "fail");
      persistEvidence();
      throw error;
    }
  }

  elements.back.addEventListener("click", hide);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { syncSaves(); } else if (visible) { requestWakeLock(); }
  });
  window.addEventListener("pagehide", function () { syncSaves(); persistEvidence(); });
  setInterval(syncSaves, 30000);

  window.krkr2Player = { preload: preload, start: start, show: show, hide: hide, syncSaves: syncSaves, snapshot: snapshot };
  window.d4PlayerState = snapshot;
}());
