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

  var params = new URLSearchParams(location.search);
  var gameId = params.get("gameId") || "";
  var storageBridge = window.krkr2StorageBridge;
  var moduleInstance = null;
  var prepared = null;
  var activeProfile = null;
  var ready = false;
  var saveSyncing = false;
  var saveSyncCount = 0;
  var errors = [];
  var engineLog = [];
  var firstDynamicError = null;
  var elements = {
    title: document.getElementById("game-title"),
    status: document.getElementById("status"),
    detail: document.getElementById("detail"),
    save: document.getElementById("save-status"),
    restart: document.getElementById("restart-button"),
    canvas: document.getElementById("canvas")
  };

  function setStatus(title, detail, state) {
    elements.status.textContent = title;
    elements.detail.textContent = detail || "";
    document.body.dataset.state = state || "loading";
  }

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
    return profile;
  }

  function engineArguments(profile) {
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
    }
  }

  async function mountSaves(module) {
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

  function persistEvidence() {
    var storage = storageBridge.snapshot();
    var evidence = {
      recordedAt: new Date().toISOString(),
      gameId: gameId,
      contentVersion: prepared && prepared.version,
      engineProfile: activeProfile && activeProfile.id,
      ready: ready,
      online: navigator.onLine,
      storage: storage,
      wasmMemoryBytes: moduleInstance && moduleInstance.HEAPU8 ? moduleInstance.HEAPU8.buffer.byteLength : null,
      saveSyncCount: saveSyncCount,
      errors: errors.slice(-16),
      engineLog: engineLog.slice(-64),
      firstDynamicError: firstDynamicError,
      canvas: { width: elements.canvas.width, height: elements.canvas.height, clientWidth: elements.canvas.clientWidth, clientHeight: elements.canvas.clientHeight }
    };
    try { localStorage.setItem("krkr2web-d4-last-player", JSON.stringify(evidence)); } catch (error) {}
    return evidence;
  }

  async function requestWakeLock() {
    if (!navigator.wakeLock || document.visibilityState !== "visible") { return; }
    try { await navigator.wakeLock.request("screen"); } catch (error) {}
  }

  async function start() {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameId)) {
      setStatus("无法启动游戏", "游戏标识无效。", "fail");
      return;
    }
    try {
      prepared = await storageBridge.prepare(gameId);
      elements.title.textContent = prepared.manifest.title;
      activeProfile = resolveEngineProfile(prepared.manifest);
      setStatus("正在载入引擎", "从本机读取 " + prepared.manifest.title, "loading");
      window.Module = {
        arguments: engineArguments(activeProfile),
        canvas: elements.canvas,
        krkr2Storage: storageBridge,
        noInitialRun: false,
        preRun: [function () {
          window.Module.addRunDependency("krkr2web-product-saves");
          mountSaves(window.Module).then(function () {
            elements.save.textContent = "存档已读取";
            window.Module.removeRunDependency("krkr2web-product-saves");
          }, function (error) {
            errors.push("存档读取失败：" + errorText(error));
            window.Module.removeRunDependency("krkr2web-product-saves");
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
      moduleInstance = await window.instantiate_krkrsdl2_module(window.Module);
      await requestWakeLock();
      if (activeProfile.allowStartupTimeoutReady) {
        setTimeout(function () {
          if (!ready) { ready = true; setStatus("游戏已启动", "", "ready"); persistEvidence(); }
        }, 1500);
      }
    } catch (error) {
      errors.push(errorText(error));
      setStatus("无法启动游戏", errorText(error), "fail");
      persistEvidence();
    }
  }

  elements.restart.addEventListener("click", function () {
    syncSaves().then(function () { location.replace("/play/?gameId=" + encodeURIComponent(gameId) + "&restart=" + Date.now()); });
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { syncSaves(); } else { requestWakeLock(); }
  });
  window.addEventListener("pagehide", function () { syncSaves(); persistEvidence(); });
  setInterval(syncSaves, 30000);
  window.d4PlayerState = function () { return persistEvidence(); };
  start();
}());
