(function () {
  "use strict";

  // The engine delivers TJS Debug.message tags (KRKR2WEB_*) to the raw
  // browser console through its emval bridge; Module.print only carries
  // C++ stdout. Forward tagged console lines into record() so the state
  // machine observes them.
  var nativeConsoleLog = console.log.bind(console);
  console.log = function () {
    var joined = "";
    for (var i = 0; i < arguments.length; i += 1) {
      var part = arguments[i];
      joined += (i ? ", " : "") + (typeof part === "string" ? part : String(part));
    }
    if (joined.indexOf("KRKR2WEB_") !== -1) {
      record("console", joined);
    }
    return nativeConsoleLog.apply(null, arguments);
  };

  var REPORT_ENDPOINT = "/api/diagnostics-reports";
  var params = new URLSearchParams(location.search);
  var gameId = params.get("gameId") || "d3-test";
  var requestedSoakSeconds = Number(params.get("soakSeconds"));
  var SOAK_TARGET_DURATION_MS = Number.isFinite(requestedSoakSeconds) && requestedSoakSeconds > 0
    ? Math.min(60 * 60, requestedSoakSeconds) * 1000 : 30 * 60 * 1000;
  var SOAK_SAMPLE_INTERVAL_MS = Math.min(60 * 1000, Math.max(1000, SOAK_TARGET_DURATION_MS / 3));
  var SOAK_HEARTBEAT_FRESH_MS = 3000;
  var SOAK_MAX_CACHE_BYTES = 16 * 1024 * 1024;
  var SOAK_MAX_WASM_BYTES = 128 * 1024 * 1024;
  var SOAK_MAX_JS_GROWTH_BYTES = 64 * 1024 * 1024;
  var SOAK_MAX_ACTIVE_GAP_MS = 5000;
  var SOAK_MINIMUM_SEGMENT_MS = Math.min(10 * 60 * 1000, SOAK_TARGET_DURATION_MS * 0.4);
  var pageSessionId = Date.now().toString(36) + "-" + Math.random().toString(16).slice(2);
  var evidenceKey = "krkr2web-d3-evidence-" + gameId;
  var soakKey = "krkr2web-d3-soak-v1-" + gameId + "-" + SOAK_TARGET_DURATION_MS;
  var evidence = {};
  try { evidence = JSON.parse(sessionStorage.getItem(evidenceKey) || "{}"); } catch (error) { evidence = {}; }
  var logs = [];
  var startedAt = new Date().toISOString();
  var engineStarted = false;
  var scriptFrameReady = false;
  var interactiveReady = false;
  var imageTextReady = false;
  var inputReady = false;
  var inputKinds = [];
  var keyboardDownKeys = [];
  var keyboardUpKeys = [];
  var keyboardActions = [];
  var gamepadDownKeys = [];
  var gamepadUpKeys = [];
  var gamepadActions = [];
  var audioOpened = false;
  var audioPlayed = false;
  var audioError = null;
  var saveWritten = false;
  var saveSynced = false;
  var saveSyncPending = false;
  var saveRestored = false;
  var kagReady = false;
  var kagTextPhases = Array.isArray(evidence.kagTextPhases) ? evidence.kagTextPhases.slice() : [];
  var kagChoiceReady = false;
  var kagBranch = null;
  var kagStateSaved = false;
  var kagRestored = false;
  var heartbeatCount = 0;
  var heartbeatEngineTick = null;
  var heartbeatReceivedAt = null;
  var previousHeartbeatAt = null;
  var accountingActive = false;
  var accountingTickAt = performance.now();
  var lastSoakPersistAt = 0;
  var lastStorageErrorCount = 0;
  var wakeLockSentinel = null;
  var moduleInstance = null;
  var storageBridge = window.krkr2StorageBridge;
  var legacyStorageProbeErrors = [
    "Uncaught TypeError: Cannot read property 'snapshot' of undefined",
    "Uncaught TypeError: Cannot read properties of undefined (reading 'snapshot')"
  ];
  var elements = {
    status: document.getElementById("status"),
    detail: document.getElementById("detail"),
    start: document.getElementById("start-button"),
    soak: document.getElementById("soak-button"),
    reload: document.getElementById("reload-button"),
    upload: document.getElementById("upload-button"),
    actions: document.querySelector(".actions"),
    game: document.getElementById("game-id"),
    cache: document.getElementById("cache-value"),
    soakProgress: document.getElementById("soak-progress"),
    soakHeartbeat: document.getElementById("soak-heartbeat"),
    soakSegments: document.getElementById("soak-segments")
  };

  function defaultSoakState() {
    return {
      schemaVersion: 1,
      contentVersion: null,
      targetDurationMs: SOAK_TARGET_DURATION_MS,
      status: "idle",
      desiredActive: false,
      accumulatedVisibleMs: 0,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      segments: [],
      samples: [],
      visibilityEvents: [],
      heartbeatEvents: 0,
      maximumHeartbeatGapMs: 0,
      maximumActiveGapMs: 0,
      excludedLongGapMs: 0,
      observedStorageErrors: [],
      fatalErrors: [],
      wakeLock: { supported: !!navigator.wakeLock, requests: 0, acquired: 0, releases: 0, errors: [] },
      gate: null
    };
  }

  function loadSoakState() {
    var loaded = null;
    try { loaded = JSON.parse(localStorage.getItem(soakKey) || "null"); } catch (error) {}
    if (!loaded || loaded.schemaVersion !== 1 || loaded.targetDurationMs !== SOAK_TARGET_DURATION_MS) {
      return defaultSoakState();
    }
    var state = defaultSoakState();
    Object.keys(state).forEach(function (key) {
      if (loaded[key] !== undefined) { state[key] = loaded[key]; }
    });
    state.segments = Array.isArray(state.segments) ? state.segments : [];
    state.samples = Array.isArray(state.samples) ? state.samples : [];
    state.visibilityEvents = Array.isArray(state.visibilityEvents) ? state.visibilityEvents : [];
    state.observedStorageErrors = Array.isArray(state.observedStorageErrors) ? state.observedStorageErrors : [];
    state.fatalErrors = Array.isArray(state.fatalErrors) ? state.fatalErrors : [];
    state.fatalErrors = state.fatalErrors.filter(function (message) {
      return legacyStorageProbeErrors.indexOf(message) === -1;
    });
    var unfinished = state.segments.length ? state.segments[state.segments.length - 1] : null;
    if (unfinished && !unfinished.endedAt) {
      unfinished.endedAt = state.updatedAt || new Date().toISOString();
      unfinished.endReason = "页面关闭或重新载入";
    }
    if (state.status === "running") { state.status = "paused"; }
    return state;
  }

  var soakState = loadSoakState();

  function setStatus(title, detail, kind) {
    elements.status.textContent = title;
    elements.detail.textContent = detail || "";
    document.body.dataset.state = kind || "idle";
  }

  function trimList(list, maximum) {
    if (list.length > maximum) { list.splice(0, list.length - maximum); }
  }

  function persistSoak(force) {
    var now = Date.now();
    if (!force && now - lastSoakPersistAt < 1000) { return; }
    soakState.updatedAt = new Date().toISOString();
    try { localStorage.setItem(soakKey, JSON.stringify(soakState)); } catch (error) {
      if (soakState.fatalErrors.indexOf("无法持久化稳定性进度") === -1) {
        soakState.fatalErrors.push("无法持久化稳定性进度");
      }
    }
    lastSoakPersistAt = now;
  }

  function formatDuration(milliseconds) {
    var seconds = Math.max(0, Math.floor(milliseconds / 1000));
    var minutes = Math.floor(seconds / 60);
    return String(minutes).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }

  function memorySnapshot() {
    if (performance.memory && typeof performance.memory.usedJSHeapSize === "number") {
      return performance.memory.usedJSHeapSize;
    }
    return null;
  }

  function latestSoakSample() {
    return soakState.samples.length ? soakState.samples[soakState.samples.length - 1] : null;
  }

  function updateSoakGate() {
    var jsHeapBySession = {};
    soakState.samples.forEach(function (sample) {
      if (sample.jsHeapBytes === null || !sample.pageSessionId) { return; }
      var session = jsHeapBySession[sample.pageSessionId] || { first: sample.jsHeapBytes, last: sample.jsHeapBytes };
      session.last = sample.jsHeapBytes;
      jsHeapBySession[sample.pageSessionId] = session;
    });
    var jsHeapGrowthValues = Object.keys(jsHeapBySession).map(function (sessionId) {
      var session = jsHeapBySession[sessionId];
      return session.last - session.first;
    });
    var jsHeapGrowthBytes = jsHeapGrowthValues.length ? Math.max.apply(Math, jsHeapGrowthValues) : null;
    var maximumCacheBytes = soakState.samples.reduce(function (maximum, sample) {
      return Math.max(maximum, sample.maximumCacheBytes || 0);
    }, 0);
    var maximumWasmBytes = soakState.samples.reduce(function (maximum, sample) {
      return Math.max(maximum, sample.wasmMemoryBytes || 0);
    }, 0);
    var longestSegmentMs = soakState.segments.reduce(function (maximum, segment) {
      return Math.max(maximum, segment.visibleMs || 0);
    }, 0);
    var durationPassed = soakState.accumulatedVisibleMs >= SOAK_TARGET_DURATION_MS;
    var minimumSegmentPassed = longestSegmentMs >= SOAK_MINIMUM_SEGMENT_MS;
    var heartbeatPassed = soakState.heartbeatEvents > 0 && soakState.segments.length > 0;
    var memoryPassed = maximumCacheBytes <= SOAK_MAX_CACHE_BYTES &&
      maximumWasmBytes <= SOAK_MAX_WASM_BYTES &&
      (jsHeapGrowthBytes === null || jsHeapGrowthBytes <= SOAK_MAX_JS_GROWTH_BYTES);
    var errorsPassed = soakState.fatalErrors.length === 0 && soakState.observedStorageErrors.length === 0;
    soakState.gate = {
      passed: durationPassed && minimumSegmentPassed && heartbeatPassed && memoryPassed && errorsPassed,
      durationPassed: durationPassed,
      minimumSegmentPassed: minimumSegmentPassed,
      longestSegmentMs: longestSegmentMs,
      requiredMinimumSegmentMs: SOAK_MINIMUM_SEGMENT_MS,
      heartbeatPassed: heartbeatPassed,
      memoryPassed: memoryPassed,
      errorsPassed: errorsPassed,
      accumulatedVisibleMs: soakState.accumulatedVisibleMs,
      requiredVisibleMs: SOAK_TARGET_DURATION_MS,
      maximumCacheBytes: maximumCacheBytes,
      maximumAllowedCacheBytes: SOAK_MAX_CACHE_BYTES,
      maximumWasmMemoryBytes: maximumWasmBytes,
      maximumAllowedWasmMemoryBytes: SOAK_MAX_WASM_BYTES,
      jsHeapGrowthBytes: jsHeapGrowthBytes,
      maximumAllowedJsHeapGrowthBytes: SOAK_MAX_JS_GROWTH_BYTES,
      maximumHeartbeatGapMs: soakState.maximumHeartbeatGapMs,
      maximumActiveGapMs: soakState.maximumActiveGapMs,
      maximumCountedGapMs: SOAK_MAX_ACTIVE_GAP_MS,
      excludedLongGapMs: soakState.excludedLongGapMs
    };
    if (soakState.gate.passed) {
      soakState.status = "pass";
      soakState.desiredActive = false;
      soakState.completedAt = soakState.completedAt || new Date().toISOString();
    } else if (durationPassed && minimumSegmentPassed) {
      soakState.status = "fail";
      soakState.desiredActive = false;
      soakState.completedAt = soakState.completedAt || new Date().toISOString();
    }
  }

  function renderSoak() {
    updateSoakGate();
    elements.soakProgress.textContent = formatDuration(soakState.accumulatedVisibleMs) +
      " / " + formatDuration(SOAK_TARGET_DURATION_MS);
    elements.soakSegments.textContent = soakState.segments.length + " 段";
    elements.soakHeartbeat.textContent = heartbeatReceivedAt === null ? "等待引擎" :
      (performance.now() - heartbeatReceivedAt <= SOAK_HEARTBEAT_FRESH_MS ? "正常 #" + heartbeatCount : "已暂停");
    if (soakState.status === "pass") {
      elements.soak.textContent = "稳定性测试通过";
      elements.soak.disabled = true;
    } else if (soakState.status === "fail") {
      elements.soak.textContent = "重置稳定性测试";
      elements.soak.disabled = false;
    } else if (soakState.desiredActive && document.visibilityState === "visible") {
      elements.soak.textContent = "暂停稳定性测试";
      elements.soak.disabled = !interactiveReady;
    } else if (soakState.accumulatedVisibleMs > 0) {
      elements.soak.textContent = "继续稳定性测试";
      elements.soak.disabled = !interactiveReady;
    } else {
      elements.soak.textContent = "开始稳定性测试";
      elements.soak.disabled = !interactiveReady;
    }
  }

  function soakSample(reason) {
    var storage = storageBridge.snapshot();
    var sample = {
      recordedAt: new Date().toISOString(),
      pageSessionId: pageSessionId,
      reason: reason,
      accumulatedVisibleMs: Math.round(soakState.accumulatedVisibleMs),
      heartbeatCount: heartbeatCount,
      heartbeatEngineTick: heartbeatEngineTick,
      cacheBytes: storage.cacheBytes,
      maximumCacheBytes: storage.metrics.maximumCacheBytes,
      storageReadCalls: storage.metrics.readCalls,
      storageErrors: storage.metrics.errors.length,
      wasmMemoryBytes: moduleInstance && moduleInstance.HEAPU8 ? moduleInstance.HEAPU8.buffer.byteLength : null,
      jsHeapBytes: memorySnapshot(),
      canvasWidth: elements.game.ownerDocument.getElementById("canvas").width,
      canvasHeight: elements.game.ownerDocument.getElementById("canvas").height
    };
    soakState.samples.push(sample);
    trimList(soakState.samples, 64);
    if (storage.metrics.errors.length > lastStorageErrorCount) {
      soakState.observedStorageErrors = soakState.observedStorageErrors.concat(
        storage.metrics.errors.slice(lastStorageErrorCount)
      );
      trimList(soakState.observedStorageErrors, 32);
    }
    lastStorageErrorCount = storage.metrics.errors.length;
    updateSoakGate();
    persistSoak(true);
    renderSoak();
  }

  async function requestWakeLock() {
    if (!navigator.wakeLock || wakeLockSentinel || document.visibilityState !== "visible") { return; }
    soakState.wakeLock.requests += 1;
    try {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      soakState.wakeLock.acquired += 1;
      wakeLockSentinel.addEventListener("release", function () {
        wakeLockSentinel = null;
        soakState.wakeLock.releases += 1;
        persistSoak(true);
      });
    } catch (error) {
      soakState.wakeLock.errors.push(error && error.message ? error.message : String(error));
      trimList(soakState.wakeLock.errors, 8);
    }
    persistSoak(true);
  }

  function closeSoakSegment(reason) {
    var segment = soakState.segments.length ? soakState.segments[soakState.segments.length - 1] : null;
    if (segment && !segment.endedAt) {
      segment.endedAt = new Date().toISOString();
      segment.endReason = reason;
      segment.accumulatedVisibleMs = Math.round(soakState.accumulatedVisibleMs);
      segment.visibleMs = Math.round(segment.visibleMs || 0);
      segment.lastHeartbeat = heartbeatCount;
    }
  }

  function setSoakAccounting(active, reason) {
    if (active === accountingActive) { return; }
    if (accountingActive) {
      closeSoakSegment(reason);
      soakSample(reason);
    }
    accountingActive = active;
    accountingTickAt = performance.now();
    if (active) {
      soakState.status = "running";
      soakState.startedAt = soakState.startedAt || new Date().toISOString();
      soakState.segments.push({
        pageSessionId: pageSessionId,
        startedAt: new Date().toISOString(),
        startedAccumulatedVisibleMs: Math.round(soakState.accumulatedVisibleMs),
        firstHeartbeat: heartbeatCount,
        visibleMs: 0,
        endedAt: null,
        endReason: null
      });
      trimList(soakState.segments, 64);
      soakSample(reason);
      setStatus("稳定性测试运行中", "累计进度会自动保存；息屏、后台或退出期间不计时。", "running");
    } else if (soakState.status !== "pass") {
      soakState.status = soakState.accumulatedVisibleMs > 0 ? "paused" : "idle";
    }
    persistSoak(true);
    renderSoak();
  }

  function canCountSoak(now) {
    return soakState.desiredActive && interactiveReady && moduleInstance &&
      document.visibilityState === "visible" && heartbeatReceivedAt !== null &&
      now - heartbeatReceivedAt <= SOAK_HEARTBEAT_FRESH_MS && soakState.status !== "pass";
  }

  function soakTick() {
    var now = performance.now();
    var gap = Math.max(0, now - accountingTickAt);
    if (accountingActive) {
      soakState.maximumActiveGapMs = Math.max(soakState.maximumActiveGapMs, gap);
      if (gap <= SOAK_MAX_ACTIVE_GAP_MS) {
        soakState.accumulatedVisibleMs = Math.min(SOAK_TARGET_DURATION_MS, soakState.accumulatedVisibleMs + gap);
        var activeSegment = soakState.segments.length ? soakState.segments[soakState.segments.length - 1] : null;
        if (activeSegment && !activeSegment.endedAt) { activeSegment.visibleMs += gap; }
      } else {
        soakState.excludedLongGapMs += gap;
      }
    }
    accountingTickAt = now;
    setSoakAccounting(canCountSoak(now), document.visibilityState === "visible" ? "心跳暂停" : "页面进入后台");
    if (accountingActive) {
      var lastSample = latestSoakSample();
      var lastSampleTime = lastSample ? Date.parse(lastSample.recordedAt) : 0;
      var reachedAllTimeGates = soakState.accumulatedVisibleMs >= SOAK_TARGET_DURATION_MS &&
        soakState.segments.some(function (segment) {
          return (segment.visibleMs || 0) >= SOAK_MINIMUM_SEGMENT_MS;
        });
      if (!lastSample || Date.now() - lastSampleTime >= SOAK_SAMPLE_INTERVAL_MS ||
          reachedAllTimeGates) {
        soakSample(reachedAllTimeGates ? "达到全部时间门槛" : "定时采样");
        if (soakState.status === "pass" && accountingActive) {
          accountingActive = false;
          closeSoakSegment("达到全部门槛");
          persistSoak(true);
          renderSoak();
        }
      } else {
        persistSoak(false);
        renderSoak();
      }
    } else {
      renderSoak();
    }
  }

  function toggleSoak() {
    if (!interactiveReady || soakState.status === "pass") { return; }
    if (soakState.status === "fail") {
      soakState = defaultSoakState();
      accountingActive = false;
      accountingTickAt = performance.now();
      lastSoakPersistAt = 0;
      lastStorageErrorCount = storageBridge.snapshot().metrics.errors.length;
      persistSoak(true);
      renderSoak();
      setStatus("稳定性测试已重置", "点击“开始稳定性测试”重新计时。", "ready");
      return;
    }
    soakState.desiredActive = !soakState.desiredActive;
    soakState.visibilityEvents.push({
      at: new Date().toISOString(),
      state: document.visibilityState,
      action: soakState.desiredActive ? "start-or-resume" : "manual-pause"
    });
    trimList(soakState.visibilityEvents, 64);
    if (soakState.desiredActive) {
      requestWakeLock();
      setStatus("稳定性测试运行中", "可让设备息屏或退出 WebView，返回后点击“继续稳定性测试”。", "running");
    } else {
      setSoakAccounting(false, "手动暂停");
      setStatus("稳定性测试已暂停", "累计进度已保存在本机，可稍后继续。", "ready");
    }
    persistSoak(true);
    renderSoak();
  }

  function exposeActions() {
    document.body.appendChild(elements.actions);
    elements.actions.style.display = "flex";
  }

  function remember(name, value) {
    evidence[name] = value;
    try { sessionStorage.setItem(evidenceKey, JSON.stringify(evidence)); } catch (error) {}
  }

  function appendEvidence(name, target, value) {
    if (target.indexOf(value) === -1) { target.push(value); }
    remember(name, target.slice());
  }

  function evidenceList(name, target) {
    return target.length ? target.slice() : (Array.isArray(evidence[name]) ? evidence[name].slice() : []);
  }

  function restartUrl() {
    return "/?gameId=" + encodeURIComponent(gameId) + "&restart=" + Date.now();
  }

  function revealRestart() {
    if (!inputReady || !audioPlayed || !saveWritten || !saveSynced) { return; }
    exposeActions();
    elements.reload.href = restartUrl();
    elements.reload.hidden = false;
    setStatus("交互测试已完成", "声音与本机存档均已确认。请点击右上角“重开验存档”。", "pass");
  }

  function syncSavesForRestart(attempt) {
    var module = moduleInstance || window.Module;
    if (!module || !module.FS || typeof module.FS.syncfs !== "function") {
      if (attempt < 5) { setTimeout(function () { syncSavesForRestart(attempt + 1); }, 300); }
      return;
    }
    saveSyncPending = true;
    setStatus("正在完成本机存档", "存档写入完成后会显示重开按钮。", "running");
    module.FS.syncfs(false, function (error) {
      saveSyncPending = false;
      if (error) {
        record("save-sync-error", error && error.message ? error.message : error);
        if (attempt < 3) {
          setTimeout(function () { syncSavesForRestart(attempt + 1); }, 500);
          return;
        }
        setStatus("本机存档同步失败", "请上传报告，不要关闭页面。", "fail");
        return;
      }
      saveSynced = true;
      remember("saveSynced", true);
      revealRestart();
    });
  }

  function record(kind, value) {
    var message = String(value);
    var isHeartbeat = message.indexOf("KRKR2WEB_D3_HEARTBEAT") !== -1;
    if (isHeartbeat) {
      var heartbeatArguments = logArguments(message, "KRKR2WEB_D3_HEARTBEAT");
      var receivedAt = performance.now();
      heartbeatCount = parseInt(heartbeatArguments[0], 10) || heartbeatCount + 1;
      heartbeatEngineTick = parseInt(heartbeatArguments[1], 10);
      if (previousHeartbeatAt !== null && document.visibilityState === "visible") {
        soakState.maximumHeartbeatGapMs = Math.max(
          soakState.maximumHeartbeatGapMs, receivedAt - previousHeartbeatAt
        );
      }
      previousHeartbeatAt = receivedAt;
      heartbeatReceivedAt = receivedAt;
      soakState.heartbeatEvents += 1;
    }
    if (!isHeartbeat || heartbeatCount === 1 || heartbeatCount % 60 === 0) {
      logs.push({ at: new Date().toISOString(), kind: kind, value: String(value) });
      if (logs.length > 300) { logs.shift(); }
    }
    if (message.indexOf("KRKR2WEB_D3_FRAME_OK") !== -1 || message.indexOf("KRKR2WEB_D3_INTERACTIVE_READY") !== -1) {
      scriptFrameReady = true;
    }
    if (message.indexOf("KRKR2WEB_D3_IMAGE_TEXT_OK") !== -1) {
      imageTextReady = true;
    }
    if (message.indexOf("KRKR2WEB_D3_KAG_READY") !== -1) { kagReady = true; }
    if (message.indexOf("KRKR2WEB_D3_KAG_TEXT") !== -1) {
      var phase = logArgument(message, "KRKR2WEB_D3_KAG_TEXT");
      if (phase && kagTextPhases.indexOf(phase) === -1) { kagTextPhases.push(phase); }
      remember("kagTextPhases", kagTextPhases.slice());
    }
    if (message.indexOf("KRKR2WEB_D3_KAG_CHOICE") !== -1) {
      kagChoiceReady = true;
      remember("kagChoiceReady", true);
      setStatus("请选择一条路线", "请直接轻触游戏画面中的左侧或右侧选项。", "ready");
    }
    if (message.indexOf("KRKR2WEB_D3_KAG_BRANCH") !== -1) {
      kagBranch = logArgument(message, "KRKR2WEB_D3_KAG_BRANCH");
      remember("kagBranch", kagBranch);
    }
    if (message.indexOf("KRKR2WEB_D3_KAG_STATE_SAVED") !== -1) {
      kagStateSaved = true;
      remember("kagStateSaved", true);
    }
    if (message.indexOf("KRKR2WEB_D3_KAG_RESTORED") !== -1) {
      kagRestored = true;
      kagBranch = logArgument(message, "KRKR2WEB_D3_KAG_RESTORED") || kagBranch;
      remember("kagRestored", true);
      remember("kagBranch", kagBranch);
    }
    if (message.indexOf("KRKR2WEB_D3_INTERACTIVE_READY") !== -1) {
      interactiveReady = true;
      exposeActions();
      elements.soak.disabled = soakState.status === "pass";
      renderSoak();
      if (soakState.desiredActive && soakState.status !== "pass") {
        setStatus("正在恢复稳定性测试", "引擎心跳恢复后会自动继续累计。", "running");
      } else if (!saveRestored) {
        setStatus("等待一次画面操作", "请在游戏画面任意位置轻触一次。", "ready");
      }
    }
    if (message.indexOf("KRKR2WEB_D3_SAVE_ERROR") !== -1) {
      soakState.fatalErrors.push(message);
      trimList(soakState.fatalErrors, 32);
      persistSoak(true);
    }
    if (message.indexOf("KRKR2WEB_D3_INPUT_OK") !== -1) {
      inputReady = true;
      if (message.indexOf("touch") !== -1 && inputKinds.indexOf("touch") === -1) { inputKinds.push("touch"); }
      if (message.indexOf("click") !== -1 && inputKinds.indexOf("click") === -1) { inputKinds.push("click"); }
      if (message.indexOf("keyboard") !== -1 && inputKinds.indexOf("keyboard") === -1) { inputKinds.push("keyboard"); }
      if (message.indexOf("gamepad") !== -1 && inputKinds.indexOf("gamepad") === -1) { inputKinds.push("gamepad"); }
      remember("inputReady", true);
      remember("inputKinds", inputKinds.slice());
    }
    if (message.indexOf("KRKR2WEB_D3_KEY_DOWN") !== -1 || message.indexOf("KRKR2WEB_D3_KEY_UP") !== -1) {
      var keyMarker = message.indexOf("KRKR2WEB_D3_KEY_DOWN") !== -1 ? "KRKR2WEB_D3_KEY_DOWN" : "KRKR2WEB_D3_KEY_UP";
      var keyArguments = logArguments(message, keyMarker);
      var keyKind = keyArguments[0];
      var keyCode = parseInt(keyArguments[1], 10);
      if (!isNaN(keyCode) && keyKind === "keyboard") {
        appendEvidence(keyMarker.indexOf("DOWN") !== -1 ? "keyboardDownKeys" : "keyboardUpKeys", keyMarker.indexOf("DOWN") !== -1 ? keyboardDownKeys : keyboardUpKeys, keyCode);
      } else if (!isNaN(keyCode) && keyKind === "gamepad") {
        appendEvidence(keyMarker.indexOf("DOWN") !== -1 ? "gamepadDownKeys" : "gamepadUpKeys", keyMarker.indexOf("DOWN") !== -1 ? gamepadDownKeys : gamepadUpKeys, keyCode);
      }
    }
    if (message.indexOf("KRKR2WEB_D3_INPUT_ACTION") !== -1) {
      var actionArguments = logArguments(message, "KRKR2WEB_D3_INPUT_ACTION");
      if (actionArguments[0] === "keyboard" && actionArguments[1]) {
        appendEvidence("keyboardActions", keyboardActions, actionArguments[1]);
      } else if (actionArguments[0] === "gamepad" && actionArguments[1]) {
        appendEvidence("gamepadActions", gamepadActions, actionArguments[1]);
      }
    }
    if (message.indexOf("KRKR2WEB_D3_AUDIO_OPEN") !== -1) { audioOpened = true; remember("audioOpened", true); }
    if (message.indexOf("KRKR2WEB_D3_AUDIO_OK") !== -1) { audioPlayed = true; remember("audioPlayed", true); }
    if (message.indexOf("KRKR2WEB_D3_AUDIO_ERROR") !== -1) { audioError = message; }
    if (message.indexOf("KRKR2WEB_D3_SAVE_WRITTEN") !== -1) {
      saveWritten = true;
      remember("saveWritten", true);
      if (!saveSynced && !saveSyncPending) {
        setTimeout(function () { syncSavesForRestart(0); }, 400);
      }
    }
    if (message.indexOf("KRKR2WEB_D3_SAVE_RESTORED") !== -1) {
      saveRestored = true;
      saveSynced = true;
      remember("saveRestored", true);
      remember("saveSynced", true);
      exposeActions();
      elements.reload.textContent = "再次重开";
      elements.reload.href = restartUrl();
      elements.reload.hidden = false;
      setStatus("本机存档已恢复", "重开页面后已从 IndexedDB 恢复剧情进度，可以上传报告。", "pass");
    } else {
      revealRestart();
    }
  }

  function logArgument(message, marker) {
    var tail = message.slice(message.indexOf(marker) + marker.length);
    return tail.replace(/^[,\s]+/, "").split(",")[0].trim();
  }

  function logArguments(message, marker) {
    var tail = message.slice(message.indexOf(marker) + marker.length);
    return tail.replace(/^[,\s]+/, "").split(",").map(function (value) { return value.trim(); });
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

  async function start() {
    if (engineStarted) { return; }
    engineStarted = true;
    elements.start.disabled = true;
    setStatus("正在检查本地游戏", "只允许启动 D2 已完整校验的版本。", "running");
    try {
      var prepared = null;
      var downloader = null;
      var catalogState = null;
      if (gameId === "d3-test" && typeof window.D2Downloader === "function") {
        downloader = new window.D2Downloader({
          state: function (snapshot) {
            if (snapshot && snapshot.manifest) {
              elements.detail.textContent = "已缓存 " + snapshot.metrics.committedBytes + " / " + snapshot.manifest.requiredBytes + " 字节";
            }
          }
        });
        catalogState = await downloader.load();
      }
      try { prepared = await storageBridge.prepare(gameId); } catch (notInstalled) {}
      if (!prepared || (catalogState && prepared.version !== catalogState.manifest.version)) {
        if (!downloader) { throw new Error("所选游戏尚未完整安装"); }
        setStatus("正在安装测试游戏", "测试包很小，只用于证明 XP3 与 TJS 运行链。", "running");
        await downloader.start();
        prepared = await storageBridge.prepare(gameId);
      }
      elements.game.textContent = prepared.manifest.title + " / " + prepared.version;
      if (soakState.contentVersion && soakState.contentVersion !== prepared.version) {
        soakState = defaultSoakState();
      }
      soakState.contentVersion = prepared.version;
      persistSoak(true);
      renderSoak();
      window.Module = {
        arguments: ["/data.xp3", "-datapath=/savedata/" + gameId + "/"],
        canvas: document.getElementById("canvas"),
        krkr2Storage: storageBridge,
        noInitialRun: false,
        preRun: [function () {
          window.Module.addRunDependency("krkr2web-saves");
          mountSaves(window.Module).then(function () {
            window.Module.removeRunDependency("krkr2web-saves");
          }, function (error) {
            record("save-error", error && error.message ? error.message : error);
            window.Module.removeRunDependency("krkr2web-saves");
          });
        }],
        print: function (text) { record("stdout", text); },
        printErr: function (text) { record("stderr", text); },
        onRuntimeInitialized: function () {
          setStatus("引擎已载入", "正在解析 IndexedDB 中的 XP3 并执行脚本。", "running");
        },
        onAbort: function (reason) {
          soakState.fatalErrors.push("Wasm abort: " + String(reason));
          trimList(soakState.fatalErrors, 32);
          persistSoak(true);
          setStatus("引擎启动失败", String(reason), "fail");
        }
      };
      moduleInstance = await window.instantiate_krkrsdl2_module(window.Module);
    } catch (error) {
      record("boot-error", error && error.stack ? error.stack : error);
      setStatus("无法启动", error && error.message ? error.message : String(error), "fail");
      elements.start.disabled = false;
      engineStarted = false;
    }
  }

  function report() {
    var storage = storageBridge.snapshot();
    elements.cache.textContent = (storage.cacheBytes / (1024 * 1024)).toFixed(2) + " MiB";
    return {
      reportVersion: 5,
      probe: "d3-engine",
      startedAt: startedAt,
      completedAt: new Date().toISOString(),
      environment: { userAgent: navigator.userAgent, online: navigator.onLine, gameId: gameId },
      results: {
        status: document.body.dataset.state || "idle",
        storage: storage,
        engineStarted: engineStarted,
        scriptFrameReady: scriptFrameReady,
        interactive: {
          ready: interactiveReady,
          imageTextReady: imageTextReady,
          inputReady: inputReady || evidence.inputReady === true,
          inputKinds: inputKinds.length ? inputKinds.slice() : (evidence.inputKinds || []).slice(),
          enhancedInput: {
            gamepadApiAvailable: typeof navigator.getGamepads === "function",
            connectedGamepads: typeof navigator.getGamepads === "function" ? Array.prototype.filter.call(navigator.getGamepads() || [], function (pad) { return !!pad; }).length : 0,
            keyboard: {
              downKeys: evidenceList("keyboardDownKeys", keyboardDownKeys),
              upKeys: evidenceList("keyboardUpKeys", keyboardUpKeys),
              actions: evidenceList("keyboardActions", keyboardActions)
            },
            gamepad: {
              downKeys: evidenceList("gamepadDownKeys", gamepadDownKeys),
              upKeys: evidenceList("gamepadUpKeys", gamepadUpKeys),
              actions: evidenceList("gamepadActions", gamepadActions)
            }
          },
          audioOpened: audioOpened || evidence.audioOpened === true,
          audioPlayed: audioPlayed || evidence.audioPlayed === true,
          audioError: audioError,
          saveWritten: saveWritten || evidence.saveWritten === true,
          saveSynced: saveSynced || evidence.saveSynced === true,
          saveRestored: saveRestored,
          restartRequested: evidence.restartRequested === true,
          restartToken: params.get("restart"),
          kag: {
            ready: kagReady,
            textPhases: kagTextPhases.length ? kagTextPhases.slice() : (evidence.kagTextPhases || []).slice(),
            choiceReady: kagChoiceReady || evidence.kagChoiceReady === true,
            branch: kagBranch || evidence.kagBranch || null,
            stateSaved: kagStateSaved || evidence.kagStateSaved === true,
            restored: kagRestored
          }
        },
        canvas: {
          width: document.getElementById("canvas").width,
          height: document.getElementById("canvas").height,
          clientWidth: document.getElementById("canvas").clientWidth,
          clientHeight: document.getElementById("canvas").clientHeight
        },
        wasmMemoryBytes: moduleInstance && moduleInstance.HEAPU8 ? moduleInstance.HEAPU8.buffer.byteLength : null,
        stability: JSON.parse(JSON.stringify(soakState)),
        logs: logs
      }
    };
  }

  async function upload() {
    elements.upload.disabled = true;
    try {
      var response = await fetch(REPORT_ENDPOINT, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(report())
      });
      var result = await response.json();
      if (!response.ok) { throw new Error(result.error || "HTTP " + response.status); }
      elements.detail.textContent = "测试报告已上传，编号：" + result.reportId;
      elements.upload.textContent = "报告已上传";
    } catch (error) {
      elements.detail.textContent = "报告上传失败：" + (error && error.message ? error.message : error);
      elements.upload.textContent = "上传失败，请重试";
    } finally {
      elements.upload.disabled = false;
    }
  }

  elements.start.addEventListener("click", start);
  elements.soak.addEventListener("click", toggleSoak);
  elements.reload.href = restartUrl();
  elements.reload.addEventListener("click", function () {
    remember("restartRequested", true);
    elements.reload.href = restartUrl();
    setStatus("正在重开引擎", "页面会自动重新启动并读取本机存档。", "running");
  });
  elements.upload.addEventListener("click", upload);
  elements.game.textContent = gameId;
  window.d3ProbeReport = report;
  window.d3ProbeSoakState = function () { return JSON.parse(JSON.stringify(soakState)); };
  document.addEventListener("visibilitychange", function () {
    soakState.visibilityEvents.push({ at: new Date().toISOString(), state: document.visibilityState });
    trimList(soakState.visibilityEvents, 64);
    previousHeartbeatAt = null;
    if (document.visibilityState !== "visible") {
      setSoakAccounting(false, "页面进入后台或息屏");
    } else if (soakState.desiredActive) {
      requestWakeLock();
    }
    persistSoak(true);
    renderSoak();
  });
  window.addEventListener("error", function (event) {
    soakState.fatalErrors.push(event.message || "未处理的页面错误");
    trimList(soakState.fatalErrors, 32);
    persistSoak(true);
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    soakState.fatalErrors.push("未处理 Promise: " + (reason && reason.message ? reason.message : String(reason)));
    trimList(soakState.fatalErrors, 32);
    persistSoak(true);
  });
  window.addEventListener("pagehide", function () {
    setSoakAccounting(false, "页面关闭或重新载入");
    persistSoak(true);
  });
  setInterval(function () {
    var snapshot = storageBridge.snapshot();
    elements.cache.textContent = (snapshot.cacheBytes / (1024 * 1024)).toFixed(2) + " MiB";
  }, 1000);
  setInterval(soakTick, 250);
  renderSoak();
  if (params.get("restart")) { setTimeout(start, 0); }
}());
