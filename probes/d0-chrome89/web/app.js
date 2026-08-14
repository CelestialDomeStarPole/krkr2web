(function () {
  "use strict";

  var REPORT_ENDPOINT = "/api/diagnostics-reports";
  var OFFSET_PROBE = "6442455041";
  var state = {
    build: null,
    results: {},
    completedAt: null
  };

  var elements = {
    badge: document.getElementById("overall-badge"),
    summary: document.getElementById("summary-text"),
    buildVersion: document.getElementById("build-version"),
    compilerVersion: document.getElementById("compiler-version"),
    progress: document.getElementById("progress-text"),
    list: document.getElementById("results-list"),
    canvas: document.getElementById("render-canvas"),
    fps: document.getElementById("fps-value"),
    runtime: document.getElementById("runtime-details"),
    rerun: document.getElementById("rerun-button"),
    upload: document.getElementById("upload-button"),
    uploadStatus: document.getElementById("upload-status")
  };

  function setResult(id, name, status, detail) {
    state.results[id] = {
      name: name,
      status: status,
      detail: detail
    };
    renderResults();
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
    var finished = ids.filter(function (id) {
      return state.results[id].status !== "running";
    }).length;
    elements.progress.textContent = finished + " / " + ids.length;
  }

  function parseChromiumVersion() {
    var match = navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)\./);
    return match ? Number(match[1]) : null;
  }

  function testEnvironment() {
    var chromeVersion = parseChromiumVersion();
    var versionDetail = chromeVersion === null
      ? "UA 中没有 Chromium 版本：" + navigator.userAgent
      : "检测到 Chromium " + chromeVersion + "；目标设备必须为 89。";
    setResult(
      "browser",
      "浏览器版本",
      chromeVersion === null ? "warn" : (chromeVersion >= 89 ? "pass" : "fail"),
      versionDetail
    );

    setResult(
      "wasm",
      "WebAssembly 核心",
      typeof WebAssembly === "object" ? "pass" : "fail",
      typeof WebAssembly === "object" ? "WebAssembly API 可用。" : "WebAssembly API 不存在。"
    );

    setResult(
      "bigint",
      "Wasm i64 / BigInt",
      typeof BigInt === "function" ? "running" : "fail",
      typeof BigInt === "function" ? "等待 Wasm 64 位往返验证。" : "BigInt API 不存在。"
    );

    var forbiddenAvailable = [
      typeof SharedArrayBuffer === "function" ? "SharedArrayBuffer" : null,
      typeof WebAssembly.Suspending === "function" ? "JSPI" : null
    ].filter(Boolean);
    setResult(
      "forbidden-runtime",
      "禁用能力隔离",
      "pass",
      forbiddenAvailable.length
        ? "浏览器提供 " + forbiddenAvailable.join("、") + "，但本构建不会使用它们。"
        : "当前环境未提供共享内存或 JSPI；本构建不依赖这些能力。"
    );

    setResult(
      "secure-context",
      "HTTPS 安全上下文",
      window.isSecureContext ? "pass" : "warn",
      window.isSecureContext
        ? "当前页面处于安全上下文。"
        : "本地 HTTP 可用于电脑调试；目标 WebView 必须通过 HTTPS 验证。"
    );
  }

  function testWebGl() {
    var gl = elements.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true
    });
    if (!gl) {
      setResult("webgl2", "WebGL 2", "fail", "无法创建 WebGL 2 上下文。");
      return Promise.resolve();
    }

    gl.viewport(0, 0, elements.canvas.width, elements.canvas.height);
    gl.clearColor(0.07, 0.36, 0.48, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    var pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    var rendered = pixel[1] > 70 && pixel[2] > 90 && pixel[3] === 255;
    setResult(
      "webgl2",
      "WebGL 2",
      rendered ? "pass" : "fail",
      rendered
        ? "画布创建、清屏和像素回读成功：" + Array.prototype.join.call(pixel, ", ")
        : "上下文存在，但像素结果异常：" + Array.prototype.join.call(pixel, ", ")
    );

    return new Promise(function (resolve) {
      var frames = 0;
      var start = performance.now();
      function frame(now) {
        frames += 1;
        if (now - start < 500) {
          requestAnimationFrame(frame);
          return;
        }
        var fps = Math.round(frames * 1000 / (now - start));
        elements.fps.textContent = fps + " FPS";
        resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  function testWasm(module) {
    var corePassed = module._d0_core_self_test() === 1;
    setResult(
      "core-self-test",
      "Wasm32 核心自检",
      corePassed ? "pass" : "fail",
      corePassed ? "64 位整数和 32 位指针约束正确。" : "编译目标的数据模型不符合要求。"
    );

    var expected = BigInt(OFFSET_PROBE);
    var echoed = module._d0_echo_u64(expected);
    var high = module._d0_offset_high() >>> 0;
    var low = module._d0_offset_low() >>> 0;
    var splitValue = (BigInt(high) << BigInt(32)) | BigInt(low);
    var i64Passed = echoed === expected && splitValue === expected;
    setResult(
      "bigint",
      "Wasm i64 / BigInt",
      i64Passed ? "pass" : "fail",
      i64Passed
        ? "超过 2 GiB 的偏移 " + expected.toString() + " 在 JS 与 Wasm 间往返正确。"
        : "64 位往返失败：echo=" + String(echoed) + "，split=" + splitValue.toString()
    );

    var pointerBits = module._d0_pointer_bits();
    var heapBytes = module._d0_heap_bytes();
    setResult(
      "memory-model",
      "内存模型",
      pointerBits === 32 && heapBytes <= 64 * 1024 * 1024 ? "pass" : "fail",
      "指针 " + pointerBits + " 位，初始 Wasm 堆 " + Math.round(heapBytes / 1048576) + " MiB。"
    );
    elements.runtime.textContent =
      "UA: " + navigator.userAgent + " | logical processors: " +
      (navigator.hardwareConcurrency || "unknown") + " | deviceMemory: " +
      (navigator.deviceMemory || "unknown") + " GiB";
  }

  function loadBuildInfo() {
    return fetch("./d0-build.json", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then(function (build) {
        state.build = build;
        elements.buildVersion.textContent = build.buildVersion || "unknown";
        elements.compilerVersion.textContent = build.emscriptenVersion || "unknown";
        setResult(
          "static-gate",
          "静态特性门禁",
          build.compatibility && build.compatibility.passed ? "pass" : "fail",
          build.compatibility && build.compatibility.summary
            ? build.compatibility.summary
            : "构建记录缺少静态检查结果。"
        );
      });
  }

  function finalize() {
    state.completedAt = new Date().toISOString();
    var values = Object.keys(state.results).map(function (id) {
      return state.results[id];
    });
    var hasFailure = values.some(function (result) { return result.status === "fail"; });
    elements.badge.className = "badge " + (hasFailure ? "badge-fail" : "badge-pass");
    elements.badge.textContent = hasFailure ? "未通过" : "当前浏览器通过";
    elements.summary.textContent = hasFailure
      ? "至少一个构建或运行能力未通过，请上传报告后停止进入下一阶段。"
      : "D0 产物已在当前浏览器完成运行检查；目标 WebView 89 仍需单独上传实机报告。";
    elements.upload.disabled = false;
  }

  function failRun(error) {
    setResult("wasm-load", "Wasm 加载", "fail", error && error.message ? error.message : String(error));
    finalize();
  }

  function run() {
    state.results = {};
    state.completedAt = null;
    elements.upload.disabled = true;
    elements.uploadStatus.textContent = "";
    elements.badge.className = "badge badge-running";
    elements.badge.textContent = "检测中";
    elements.summary.textContent = "正在载入 Wasm 并验证运行环境。";
    elements.fps.textContent = "等待";
    elements.runtime.textContent = "尚未开始运行。";

    testEnvironment();
    loadBuildInfo()
      .then(function () {
        if (typeof createD0Module !== "function") {
          throw new Error("Emscripten 模块加载器不存在。");
        }
        return createD0Module({
          locateFile: function (path) {
            return path.endsWith(".wasm") ? "./d0-probe.wasm" : path;
          },
          printErr: function (message) {
            console.error("[d0-wasm]", message);
          }
        });
      })
      .then(function (module) {
        setResult("wasm-load", "Wasm 加载", "pass", "Emscripten 模块已实例化。产物不使用 pthreads 或 JSPI。");
        testWasm(module);
        return testWebGl();
      })
      .then(finalize)
      .catch(failRun);
  }

  function createReport() {
    return {
      reportVersion: 1,
      reportKind: "d0-chrome89-build-probe",
      generatedAt: new Date().toISOString(),
      page: {
        origin: window.location.origin,
        path: window.location.pathname
      },
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
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) {
            throw new Error(body.error || "HTTP " + response.status);
          }
          return body;
        });
      })
      .then(function (body) {
        elements.uploadStatus.textContent = "上传成功，报告编号：" + body.reportId;
      })
      .catch(function (error) {
        elements.uploadStatus.textContent = "上传失败：" + error.message;
      })
      .then(function () {
        elements.upload.disabled = false;
      });
  }

  elements.rerun.addEventListener("click", run);
  elements.upload.addEventListener("click", uploadReport);
  run();
}());
