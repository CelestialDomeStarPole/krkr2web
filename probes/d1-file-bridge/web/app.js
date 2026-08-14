(function () {
  "use strict";

  var REPORT_ENDPOINT = "/api/diagnostics-reports";
  var MINIMUM_OPERATIONS_PER_SECOND = 200;
  var MAXIMUM_EVENT_LOOP_GAP_MS = 250;
  var MAXIMUM_CACHE_BYTES = 16 * 1024 * 1024;
  var SOAK_DURATION_MS = (function () {
    var localDebug = location.hostname === "127.0.0.1" || location.hostname === "localhost";
    var requestedSeconds = Number(new URLSearchParams(location.search).get("soakSeconds"));
    return localDebug && Number.isFinite(requestedSeconds) && requestedSeconds >= 5
      ? requestedSeconds * 1000
      : 10 * 60 * 1000;
  }());
  var SOAK_BATCH_READS = 10;
  var PASS_ITEMS = [
    ["open-size", "打开与文件大小", "同步接口返回超过 5 GiB 的 64 位文件大小。"],
    ["low-offset", "普通偏移读取", "低位偏移内容逐字节正确。"],
    ["over-2gib", "2 GiB 后读取", "跨越 32 位有符号边界后仍可正确定位。"],
    ["over-4gib", "4 GiB 后读取", "跨越 32 位无符号边界后仍可正确定位。"],
    ["cross-block", "跨块读取", "2 GiB 和 4 GiB 边界附近均可跨 4 MiB 块读取。"],
    ["end-of-file", "文件尾读取", "越过文件尾时返回实际字节数。"],
    ["missing-block", "缺块错误", "缺块返回稳定错误，不伪造数据。"],
    ["storage-error", "存储错误", "IndexedDB 错误可传回同步文件接口。"],
    ["cancellation", "取消读取", "取消状态可恢复，不破坏后续读取。"],
    ["random-reads", "10,000 次随机读取", "冷热缓存混合读取逐字节校验。"],
    ["close", "关闭句柄", "关闭后继续读取会返回无效句柄错误。"]
  ];

  var state = {
    build: null,
    results: {},
    metrics: null,
    module: null,
    stability: {
      background: null,
      soak: null
    },
    completedAt: null,
    startedAt: null
  };

  var elements = {
    badge: document.getElementById("overall-badge"),
    summary: document.getElementById("summary-text"),
    logicalSize: document.getElementById("logical-size"),
    progressFill: document.getElementById("progress-fill"),
    progressTitle: document.getElementById("progress-title"),
    progressDetail: document.getElementById("progress-detail"),
    resultCount: document.getElementById("result-count"),
    list: document.getElementById("results-list"),
    elapsed: document.getElementById("elapsed-value"),
    operations: document.getElementById("ops-value"),
    throughput: document.getElementById("throughput-value"),
    gap: document.getElementById("gap-value"),
    indexedDb: document.getElementById("idb-value"),
    cache: document.getElementById("cache-value"),
    wasm: document.getElementById("wasm-value"),
    runtime: document.getElementById("runtime-details"),
    run: document.getElementById("run-button"),
    background: document.getElementById("background-button"),
    soak: document.getElementById("soak-button"),
    upload: document.getElementById("upload-button"),
    uploadStatus: document.getElementById("upload-status"),
    stabilityCount: document.getElementById("stability-count"),
    backgroundStatus: document.getElementById("background-status"),
    soakStatus: document.getElementById("soak-status")
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) { return "--"; }
    if (bytes >= 1024 * 1024 * 1024) { return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GiB"; }
    if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(2) + " MiB"; }
    if (bytes >= 1024) { return (bytes / 1024).toFixed(2) + " KiB"; }
    return bytes + " B";
  }

  function setProgress(percent, title, detail) {
    elements.progressFill.style.width = Math.max(0, Math.min(100, percent)) + "%";
    elements.progressTitle.textContent = title;
    elements.progressDetail.textContent = detail;
  }

  function setResult(id, name, status, detail) {
    state.results[id] = { name: name, status: status, detail: detail };
    renderResults();
  }

  function renderStability() {
    var completed = [state.stability.background, state.stability.soak].filter(function (item) {
      return item && item.status === "pass";
    }).length;
    elements.stabilityCount.textContent = completed + " / 2";
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }

  async function requestScreenWakeLock() {
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") {
      return { lock: null, supported: false, acquired: false, error: "API unavailable" };
    }
    try {
      var lock = await navigator.wakeLock.request("screen");
      return { lock: lock, supported: true, acquired: true, error: null };
    } catch (error) {
      return {
        lock: null,
        supported: true,
        acquired: false,
        error: error && error.message ? error.message : String(error)
      };
    }
  }

  function renderResults() {
    var ids = Object.keys(state.results);
    elements.list.textContent = "";
    ids.forEach(function (id) {
      var result = state.results[id];
      var row = document.createElement("li");
      row.className = "result-row result-" + result.status;
      row.innerHTML =
        '<span class="result-mark" aria-hidden="true"></span>' +
        '<span class="result-name"></span>' +
        '<span class="result-detail"></span>';
      row.querySelector(".result-name").textContent = result.name;
      row.querySelector(".result-detail").textContent = result.detail;
      elements.list.appendChild(row);
    });
    var passed = ids.filter(function (id) { return state.results[id].status === "pass"; }).length;
    elements.resultCount.textContent = passed + " / " + ids.length;
  }

  function initialResults() {
    state.results = {};
    PASS_ITEMS.forEach(function (item) {
      setResult(item[0], item[1], "pending", "等待测试。" );
    });
    setResult("responsiveness", "页面响应", "pending", "等待测量页面最长无响应间隔。" );
    setResult("memory-bound", "内存有界", "pending", "等待测量块缓存和 Wasm 堆。" );
    setResult("synthetic-performance", "20 FPS 可行性", "pending", "等待合成读取负载结果。" );
  }

  function startGapMonitor() {
    var active = true;
    var maximumGap = 0;
    var last = performance.now();
    function frame(now) {
      maximumGap = Math.max(maximumGap, now - last);
      last = now;
      if (active) { requestAnimationFrame(frame); }
    }
    requestAnimationFrame(frame);
    return {
      maximum: function () { return maximumGap; },
      stop: function () {
        active = false;
        return maximumGap;
      }
    };
  }

  function loadBuildInfo() {
    return fetch("./d1-build.json", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) { throw new Error("构建信息 HTTP " + response.status); }
        return response.json();
      })
      .then(function (build) {
        state.build = build;
        if (!build.compatibility || !build.compatibility.passed) {
          throw new Error(build.compatibility ? build.compatibility.summary : "静态门禁失败");
        }
      });
  }

  function applyFunctionalResults(mask) {
    PASS_ITEMS.forEach(function (item, index) {
      var passed = (mask & (1 << index)) !== 0;
      setResult(item[0], item[1], passed ? "pass" : "fail", passed ? item[2] : "该项未通过，请上传报告。" );
    });
  }

  function memorySnapshot() {
    if (performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)) {
      return performance.memory.usedJSHeapSize;
    }
    return null;
  }

  async function run() {
    elements.run.disabled = true;
    elements.background.disabled = true;
    elements.soak.disabled = true;
    elements.upload.disabled = true;
    elements.uploadStatus.textContent = "";
    elements.badge.className = "badge badge-running";
    elements.badge.textContent = "测试中";
    elements.summary.textContent = "正在准备独立测试数据；首次运行会写入约 40 MiB。";
    state.metrics = null;
    state.module = null;
    state.stability = { background: null, soak: null };
    elements.backgroundStatus.textContent = "等待快速测试通过。";
    elements.soakStatus.textContent = "等待快速测试通过。";
    renderStability();
    state.completedAt = null;
    state.startedAt = new Date().toISOString();
    initialResults();

    var preparationStart = performance.now();
    var beforeHeap = memorySnapshot();
    window.d1StorageBridge.onPreparation(function (completed, total, chunkIndex) {
      setProgress(completed / total * 10, "正在准备测试数据", "写入逻辑块 " + chunkIndex + "（" + (completed + 1) + " / " + total + "）");
    });
    window.d1StorageBridge.onProgress(function (completed, total) {
      setProgress(10 + completed / total * 88, "正在随机读取", completed.toLocaleString() + " / " + total.toLocaleString());
    });

    try {
      await loadBuildInfo();
      var preparation = await window.d1StorageBridge.prepare();
      setProgress(10, "测试数据就绪", preparation.reused ? "复用已保存的数据。" : "首次数据写入完成。" );

      if (typeof createD1Module !== "function") {
        throw new Error("D1 Wasm 模块加载器不存在");
      }
      var module = await createD1Module({
        locateFile: function (path) { return path.endsWith(".wasm") ? "./d1-probe.wasm" : path; },
        printErr: function (message) { console.error("[d1-wasm]", message); }
      });
      module.d1Storage = window.d1StorageBridge;
      state.module = module;
      window.d1StorageBridge.resetMetrics();

      var monitor = startGapMonitor();
      var suiteStart = performance.now();
      var suitePassed = await module.ccall(
        "d1_run_suite", "number", [], [], { async: true }
      );
      var suiteEnd = performance.now();
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      var maximumGap = monitor.stop();
      var mask = module._d1_pass_mask() >>> 0;
      var expectedMask = module._d1_expected_pass_mask() >>> 0;
      var randomReads = module._d1_random_reads() >>> 0;
      var verifiedBytes = Number(module._d1_verified_bytes());
      var logicalFileSize = Number(module._d1_logical_file_size());
      var storageMetrics = window.d1StorageBridge.metrics();
      var elapsedMs = suiteEnd - suiteStart;
      var operationsPerSecond = randomReads * 1000 / elapsedMs;
      var throughput = verifiedBytes * 1000 / elapsedMs;
      var wasmHeapBytes = module.HEAPU8.byteLength;
      var afterHeap = memorySnapshot();

      applyFunctionalResults(mask);
      var responsivenessPassed = maximumGap <= MAXIMUM_EVENT_LOOP_GAP_MS;
      var memoryPassed = storageMetrics.maximumCacheBytes <= MAXIMUM_CACHE_BYTES && wasmHeapBytes <= 128 * 1024 * 1024;
      var performancePassed = operationsPerSecond >= MINIMUM_OPERATIONS_PER_SECOND;
      setResult("responsiveness", "页面响应", responsivenessPassed ? "pass" : "fail",
        "最长页面间隔 " + maximumGap.toFixed(1) + " ms，门槛 " + MAXIMUM_EVENT_LOOP_GAP_MS + " ms。" );
      setResult("memory-bound", "内存有界", memoryPassed ? "pass" : "fail",
        "块缓存峰值 " + formatBytes(storageMetrics.maximumCacheBytes) + "，Wasm 堆 " + formatBytes(wasmHeapBytes) + "。" );
      setResult("synthetic-performance", "20 FPS 可行性", performancePassed ? "pass" : "fail",
        Math.round(operationsPerSecond).toLocaleString() + " 次读取/秒，合成门槛 " + MINIMUM_OPERATIONS_PER_SECOND + " 次/秒。" );

      var allPassed = suitePassed === 1 && mask === expectedMask && responsivenessPassed && memoryPassed && performancePassed;
      state.metrics = {
        preparationMs: suiteStart - preparationStart,
        suiteElapsedMs: elapsedMs,
        maximumEventLoopGapMs: maximumGap,
        randomReads: randomReads,
        verifiedBytes: verifiedBytes,
        operationsPerSecond: operationsPerSecond,
        effectiveThroughputBytesPerSecond: throughput,
        wasmHeapBytes: wasmHeapBytes,
        jsHeapBeforeBytes: beforeHeap,
        jsHeapAfterBytes: afterHeap,
        storage: storageMetrics,
        passMask: mask,
        expectedPassMask: expectedMask,
        lastError: module._d1_last_error(),
        thresholds: {
          minimumOperationsPerSecond: MINIMUM_OPERATIONS_PER_SECOND,
          maximumEventLoopGapMs: MAXIMUM_EVENT_LOOP_GAP_MS,
          maximumCacheBytes: MAXIMUM_CACHE_BYTES
        }
      };
      state.completedAt = new Date().toISOString();
      elements.logicalSize.textContent = formatBytes(logicalFileSize);
      elements.elapsed.textContent = (elapsedMs / 1000).toFixed(2) + " 秒";
      elements.operations.textContent = Math.round(operationsPerSecond).toLocaleString() + " 次/秒";
      elements.throughput.textContent = formatBytes(throughput) + "/秒";
      elements.gap.textContent = maximumGap.toFixed(1) + " ms";
      elements.indexedDb.textContent = formatBytes(storageMetrics.indexedDbBytes);
      elements.cache.textContent = formatBytes(storageMetrics.maximumCacheBytes);
      elements.wasm.textContent = formatBytes(wasmHeapBytes);
      elements.runtime.textContent = "UA: " + navigator.userAgent + " | deviceMemory: " +
        (navigator.deviceMemory || "unknown") + " GiB | cache hits/misses: " +
        storageMetrics.cacheHits + "/" + storageMetrics.cacheMisses;
      elements.badge.className = "badge " + (allPassed ? "badge-pass" : "badge-fail");
      elements.badge.textContent = allPassed ? "当前浏览器通过" : "未通过";
      elements.summary.textContent = allPassed
        ? "D1 合成文件读取门禁通过；目标 WebView 89 仍需上传实机报告。"
        : "至少一个正确性、响应、内存或性能门禁未通过。";
      setProgress(100, allPassed ? "测试完成" : "测试未通过", randomReads.toLocaleString() + " 次随机读取已结束。" );
      elements.upload.disabled = false;
      elements.background.disabled = !allPassed;
      elements.soak.disabled = !allPassed;
      if (allPassed) {
        elements.backgroundStatus.textContent = "可以开始。";
        elements.soakStatus.textContent = "可以开始。";
      }
    } catch (error) {
      state.completedAt = new Date().toISOString();
      elements.badge.className = "badge badge-fail";
      elements.badge.textContent = "运行失败";
      elements.summary.textContent = error && error.message ? error.message : String(error);
      setProgress(100, "运行失败", elements.summary.textContent);
      setResult("runtime", "运行时", "fail", elements.summary.textContent);
      elements.upload.disabled = false;
    } finally {
      elements.run.disabled = false;
      if (!state.module || !state.metrics) {
        elements.background.disabled = true;
        elements.soak.disabled = true;
      }
    }
  }

  async function runBackgroundTest() {
    if (!state.module) { return; }
    elements.run.disabled = true;
    elements.background.disabled = true;
    elements.soak.disabled = true;
    elements.upload.disabled = true;
    elements.backgroundStatus.textContent = "准备中。";
    window.d1StorageBridge.onBackground(function (stage, hiddenMs) {
      if (stage === "armed") {
        elements.backgroundStatus.textContent = "现在切到其他页面或桌面，等待至少 10 秒后再返回。";
      } else if (stage === "hidden") {
        elements.backgroundStatus.textContent = "页面已进入后台，10 秒后返回。";
      } else if (stage === "too-short") {
        elements.backgroundStatus.textContent = "后台仅停留 " + (hiddenMs / 1000).toFixed(1) + " 秒，请再次切到后台。";
      } else if (stage === "resumed") {
        elements.backgroundStatus.textContent = "已返回，正在从 IndexedDB 继续读取。";
      }
    });

    var startedAt = new Date().toISOString();
    var started = performance.now();
    try {
      var passed = await state.module.ccall(
        "d1_run_background_suite", "number", [], [], { async: true }
      );
      var storage = window.d1StorageBridge.metrics();
      var hiddenMs = storage.backgroundHiddenMs || 0;
      var verifiedBytes = Number(state.module._d1_background_verified_bytes());
      var success = passed === 1 && hiddenMs >= 10000 && verifiedBytes === 81920 &&
        state.module._d1_last_error() === 0;
      state.stability.background = {
        status: success ? "pass" : "fail",
        startedAt: startedAt,
        completedAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        hiddenMs: hiddenMs,
        verifiedBytes: verifiedBytes,
        lastError: state.module._d1_last_error()
      };
      elements.backgroundStatus.textContent = success
        ? "通过：后台 " + (hiddenMs / 1000).toFixed(1) + " 秒后恢复，继续校验 " + formatBytes(verifiedBytes) + "。"
        : "未通过，请上传当前报告。";
    } catch (error) {
      state.stability.background = {
        status: "fail",
        startedAt: startedAt,
        completedAt: new Date().toISOString(),
        error: error && error.message ? error.message : String(error)
      };
      elements.backgroundStatus.textContent = "失败：" + state.stability.background.error;
    } finally {
      renderStability();
      elements.run.disabled = false;
      elements.background.disabled = false;
      elements.soak.disabled = false;
      elements.upload.disabled = false;
    }
  }

  function soakSample(module, elapsedMs, maximumGapMs) {
    var storage = window.d1StorageBridge.metrics();
    return {
      elapsedMs: elapsedMs,
      recordedAt: new Date().toISOString(),
      reads: module._d1_soak_reads() >>> 0,
      verifiedBytes: Number(module._d1_soak_verified_bytes()),
      cacheBytes: storage.cacheBytes,
      maximumCacheBytes: storage.maximumCacheBytes,
      wasmHeapBytes: module.HEAPU8.byteLength,
      jsHeapBytes: memorySnapshot(),
      maximumEventLoopGapMs: maximumGapMs
    };
  }

  async function runSoakTest() {
    if (!state.module) { return; }
    elements.run.disabled = true;
    elements.background.disabled = true;
    elements.soak.disabled = true;
    elements.upload.disabled = true;
    elements.soakStatus.textContent = "稳定性测试运行中，正在尝试保持屏幕常亮。";
    state.module._d1_reset_soak_counters();
    window.d1StorageBridge.resetMetrics();

    var wakeLock = await requestScreenWakeLock();
    elements.soakStatus.textContent = wakeLock.acquired
      ? "屏幕常亮已启用，请保持此页面在前台。"
      : "无法自动保持屏幕常亮，请暂时避免设备息屏。";

    var startedAt = new Date().toISOString();
    var start = performance.now();
    var deadline = start + SOAK_DURATION_MS;
    var nextSampleAt = start + 60 * 1000;
    var gapMonitor = startGapMonitor();
    var samples = [soakSample(state.module, 0, 0)];
    var failure = null;
    var seed = 0x4d3c2b1a;
    var wasHidden = false;
    function onSoakVisibilityChange() {
      if (document.visibilityState !== "visible") {
        wasHidden = true;
      }
    }
    document.addEventListener("visibilitychange", onSoakVisibilityChange);

    try {
      while (performance.now() < deadline) {
        var now = performance.now();
        if (wasHidden || document.visibilityState !== "visible") {
          failure = "稳定性测试期间页面进入后台";
          break;
        }
        seed = (seed + 0x9e3779b9) >>> 0;
        var passed = await state.module.ccall(
          "d1_run_soak_batch", "number", ["number", "number"],
          [seed, SOAK_BATCH_READS], { async: true }
        );
        if (passed !== 1 || state.module._d1_last_error() !== 0) {
          failure = "文件读取批次失败，错误码 " + state.module._d1_last_error();
          break;
        }
        now = performance.now();
        var remainingMs = Math.max(0, deadline - now);
        elements.soakStatus.textContent = "剩余 " + Math.ceil(remainingMs / 60000) +
          " 分钟，已读取 " + state.module._d1_soak_reads().toLocaleString() + " 次。";
        if (now >= nextSampleAt) {
          samples.push(soakSample(state.module, now - start, gapMonitor.maximum()));
          nextSampleAt += 60 * 1000;
        }
        await sleep(Math.min(1000, Math.max(0, deadline - performance.now())));
      }
    } catch (error) {
      failure = error && error.message ? error.message : String(error);
    }
    document.removeEventListener("visibilitychange", onSoakVisibilityChange);
    if (wakeLock.lock) {
      try {
        await wakeLock.lock.release();
      } catch (error) {
        console.warn("[d1-wake-lock]", error);
      }
    }

    var elapsedMs = performance.now() - start;
    var maximumGap = gapMonitor.stop();
    var finalSample = soakSample(state.module, elapsedMs, maximumGap);
    samples.push(finalSample);
    var durationPassed = elapsedMs >= SOAK_DURATION_MS - 1000;
    var firstJsHeap = samples[0].jsHeapBytes;
    var jsHeapGrowth = firstJsHeap !== null && finalSample.jsHeapBytes !== null
      ? finalSample.jsHeapBytes - firstJsHeap
      : null;
    var jsHeapPassed = jsHeapGrowth === null || jsHeapGrowth <= 64 * 1024 * 1024;
    var responsivenessPassed = maximumGap <= 500;
    var memoryPassed = finalSample.maximumCacheBytes <= MAXIMUM_CACHE_BYTES &&
      finalSample.wasmHeapBytes <= 128 * 1024 * 1024 && jsHeapPassed;
    var success = !failure && durationPassed && memoryPassed && responsivenessPassed &&
      finalSample.reads > 0;
    state.stability.soak = {
      status: success ? "pass" : "fail",
      startedAt: startedAt,
      completedAt: new Date().toISOString(),
      requestedDurationMs: SOAK_DURATION_MS,
      elapsedMs: elapsedMs,
      reads: finalSample.reads,
      verifiedBytes: finalSample.verifiedBytes,
      maximumEventLoopGapMs: maximumGap,
      maximumAllowedEventLoopGapMs: 500,
      maximumCacheBytes: finalSample.maximumCacheBytes,
      wasmHeapBytes: finalSample.wasmHeapBytes,
      jsHeapGrowthBytes: jsHeapGrowth,
      wakeLock: {
        supported: wakeLock.supported,
        acquired: wakeLock.acquired,
        error: wakeLock.error
      },
      samples: samples,
      error: failure
    };
    elements.soakStatus.textContent = success
      ? "通过：持续测试完成 " + finalSample.reads.toLocaleString() + " 次读取，缓存峰值 " +
        formatBytes(finalSample.maximumCacheBytes) + "。"
      : "未通过：" + (failure || "持续时间或内存门禁不满足") + "。";
    renderStability();
    elements.run.disabled = false;
    elements.background.disabled = false;
    elements.soak.disabled = false;
    elements.upload.disabled = false;
  }

  function createReport() {
    return {
      reportVersion: 1,
      reportKind: "d1-indexeddb-file-bridge-probe",
      generatedAt: new Date().toISOString(),
      page: { origin: window.location.origin, path: window.location.pathname },
      environment: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        deviceMemory: navigator.deviceMemory || null,
        secureContext: window.isSecureContext
      },
      build: state.build,
      results: state.results,
      metrics: state.metrics,
      stability: state.stability,
      startedAt: state.startedAt,
      completedAt: state.completedAt
    };
  }

  function uploadReport() {
    elements.upload.disabled = true;
    elements.uploadStatus.textContent = "正在上传...";
    fetch(REPORT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createReport())
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) { throw new Error(body.error || "HTTP " + response.status); }
        return body;
      });
    }).then(function (body) {
      elements.uploadStatus.textContent = "上传成功，报告编号：" + body.reportId;
    }).catch(function (error) {
      elements.uploadStatus.textContent = "上传失败：" + error.message;
    }).then(function () {
      elements.upload.disabled = false;
    });
  }

  initialResults();
  elements.run.addEventListener("click", run);
  elements.background.addEventListener("click", runBackgroundTest);
  elements.soak.addEventListener("click", runSoakTest);
  elements.upload.addEventListener("click", uploadReport);
}());
