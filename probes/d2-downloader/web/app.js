(function () {
  "use strict";

  var REPORT_ENDPOINT = "/api/diagnostics-reports";
  var resultDefinitions = [
    ["catalog", "目录与清单", "Catalog 和 Manifest 结构、版本与路径校验通过。"],
    ["range", "HTTP Range", "所有资源块均以严格 206 Range 响应取得。"],
    ["bounded-memory", "有界内存", "单块 4 MiB、最多两个并发，不随游戏总大小增长。"],
    ["resume", "暂停与断点恢复", "已提交块可在暂停、断网或关闭 App 后复用。"],
    ["integrity", "逐块完整性", "每块 SHA-256 正确后才提交 IndexedDB。"],
    ["atomic-complete", "原子完成标记", "全量复核后才将安装标记为可用。"],
    ["repair", "坏块单独修复", "只重下损坏或缺失的块。"],
    ["version-isolation", "版本隔离", "服务器内容变化不会与当前版本混用。"],
    ["delete", "分批删除", "游戏块按有限批次删除并关闭启动状态。"]
  ];
  var results = {};
  var state = { startedAt: new Date().toISOString(), completedAt: null, space: null, tampered: null, deletion: null };
  var downloader;
  var busyAction = false;
  var deleteConfirmationExpiresAt = 0;

  var elements = {
    badge: document.getElementById("overall-badge"),
    gameTitle: document.getElementById("game-title"),
    summary: document.getElementById("summary-text"),
    total: document.getElementById("total-size"),
    packages: document.getElementById("package-count"),
    fill: document.getElementById("progress-fill"),
    progressTitle: document.getElementById("progress-title"),
    progressDetail: document.getElementById("progress-detail"),
    resultList: document.getElementById("results-list"),
    resultCount: document.getElementById("result-count"),
    status: document.getElementById("status-value"),
    saved: document.getElementById("saved-value"),
    network: document.getElementById("network-value"),
    requests: document.getElementById("requests-value"),
    concurrency: document.getElementById("concurrency-value"),
    inflight: document.getElementById("inflight-value"),
    repair: document.getElementById("repair-value"),
    runtime: document.getElementById("runtime-details"),
    start: document.getElementById("start-button"),
    pause: document.getElementById("pause-button"),
    verify: document.getElementById("verify-button"),
    tamper: document.getElementById("tamper-button"),
    repairButton: document.getElementById("repair-button"),
    deleteButton: document.getElementById("delete-button"),
    upload: document.getElementById("upload-button"),
    actionStatus: document.getElementById("action-status")
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) { return "--"; }
    if (bytes >= 1024 * 1024 * 1024) { return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GiB"; }
    if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(2) + " MiB"; }
    if (bytes >= 1024) { return (bytes / 1024).toFixed(2) + " KiB"; }
    return bytes + " B";
  }

  function errorText(error) { return error && error.message ? error.message : String(error); }

  function setResult(id, status, detail) {
    var definition = resultDefinitions.find(function (item) { return item[0] === id; });
    results[id] = { name: definition[1], status: status, detail: detail || definition[2] };
    renderResults();
  }

  function renderResults() {
    elements.resultList.textContent = "";
    var passed = 0;
    resultDefinitions.forEach(function (definition) {
      var result = results[definition[0]] || { name: definition[1], status: "pending", detail: "等待验证。" };
      if (result.status === "pass") { passed += 1; }
      var row = document.createElement("li");
      row.className = "result-row result-" + result.status;
      row.innerHTML = '<span class="result-mark" aria-hidden="true"></span><span class="result-name"></span><span class="result-detail"></span>';
      row.querySelector(".result-name").textContent = result.name;
      row.querySelector(".result-detail").textContent = result.detail;
      elements.resultList.appendChild(row);
    });
    elements.resultCount.textContent = passed + " / " + resultDefinitions.length;
  }

  function setBadge(kind, text) {
    elements.badge.className = "badge badge-" + kind;
    elements.badge.textContent = text;
  }

  function statusLabel(status) {
    return {
      "not-installed": "未安装", "checking-space": "检查空间", downloading: "下载中", paused: "已暂停",
      verifying: "完整校验", committing: "提交完成", ready: "可用", "recoverable-error": "可恢复错误",
      "fatal-error": "已阻止", deleting: "删除中"
    }[status] || status || "未安装";
  }

  function updateButtons(snapshot) {
    var install = snapshot.install || {};
    var ready = install.status === "ready" && install.complete;
    var recoverable = ["paused", "recoverable-error", "not-installed"].indexOf(install.status) !== -1 || !install.status;
    elements.start.disabled = busyAction || snapshot.running || !(recoverable || install.status === "downloading");
    elements.start.textContent = install.committedBytes > 0 ? "继续下载" : "开始完整下载";
    elements.pause.disabled = !snapshot.running || snapshot.paused || install.status !== "downloading";
    elements.verify.disabled = busyAction || snapshot.running || !ready;
    elements.tamper.disabled = busyAction || snapshot.running || !ready;
    elements.repairButton.disabled = busyAction || snapshot.running || install.status !== "recoverable-error";
    elements.deleteButton.disabled = busyAction || snapshot.running || !(install.committedBytes > 0 || ready);
    elements.upload.disabled = !downloader || snapshot.running;
  }

  function renderSnapshot(snapshot) {
    var install = snapshot.install || {};
    var metrics = snapshot.metrics || {};
    var total = snapshot.manifest ? snapshot.manifest.requiredBytes : 0;
    var saved = Number(install.committedBytes || metrics.committedBytes || 0);
    var percent = total ? Math.min(100, saved / total * 100) : 0;
    elements.fill.style.width = percent.toFixed(3) + "%";
    elements.progressTitle.textContent = statusLabel(install.status);
    elements.progressDetail.textContent = formatBytes(saved) + " / " + formatBytes(total) + "（" + percent.toFixed(2) + "%）";
    elements.status.textContent = statusLabel(install.status);
    elements.saved.textContent = formatBytes(saved);
    elements.network.textContent = formatBytes(metrics.networkBytes || 0);
    elements.requests.textContent = String(metrics.networkRequests || 0);
    elements.concurrency.textContent = String(metrics.maximumConcurrentRequests || 0) + " / 2";
    elements.inflight.textContent = formatBytes(metrics.maximumInFlightBytes || 0);
    elements.repair.textContent = String(metrics.repairedChunks || 0) + " 块";
    updateButtons(snapshot);

    if (install.status === "ready" && install.complete) {
      setBadge("pass", "资源可用");
      elements.summary.textContent = "所有资源已经逐块复核并保存到本机。现在允许引擎从缓存读取。";
    } else if (install.status === "fatal-error") {
      setBadge("fail", "已阻止");
    } else if (install.status === "recoverable-error" || install.status === "paused") {
      setBadge("warn", statusLabel(install.status));
      elements.summary.textContent = install.status === "paused" ? "下载已安全暂停，已保存的数据不会重复下载。" : "资源目前不可启动，请按下方状态继续下载或修复。";
    } else if (snapshot.running) {
      setBadge("running", statusLabel(install.status));
    } else {
      setBadge("idle", statusLabel(install.status));
      elements.summary.textContent = "本页会把服务端配置的游戏完整保存到设备，并验证暂停、继续、坏块修复和删除。";
    }
  }

  function setBusy(value) {
    busyAction = value;
    if (downloader) { updateButtons(downloader.snapshot()); }
  }

  function report() {
    var snapshot = downloader ? downloader.snapshot() : {};
    return {
      reportVersion: 1,
      probe: "d2-downloader",
      createdAt: new Date().toISOString(),
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      location: { origin: location.origin, href: location.href, secureContext: window.isSecureContext },
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      catalog: snapshot.catalog ? { catalogVersion: snapshot.catalog.catalogVersion } : null,
      game: snapshot.manifest ? {
        gameId: snapshot.manifest.gameId,
        version: snapshot.manifest.version,
        requiredBytes: snapshot.manifest.requiredBytes,
        packages: snapshot.manifest.packages.map(function (pkg) { return { id: pkg.id, size: pkg.size, chunks: pkg.chunks.length }; })
      } : null,
      install: snapshot.install || null,
      metrics: snapshot.metrics || null,
      space: state.space,
      tampered: state.tampered,
      deletion: state.deletion,
      results: results
    };
  }

  async function runAction(label, action) {
    if (busyAction) { return; }
    setBusy(true);
    elements.actionStatus.textContent = label + "…";
    try {
      await action();
      elements.actionStatus.textContent = label + "完成。";
    } catch (error) {
      elements.actionStatus.textContent = (error.code ? error.code + " · " : "") + errorText(error);
      if (error.code === "E_RANGE") { setResult("range", "fail", errorText(error)); }
      if (error.code === "E_VERSION_CHANGED") { setResult("version-isolation", "pass", "检测到服务器资源变化并阻止版本混用。" ); }
      if (error.code === "E_INTEGRITY") { setResult("integrity", "pass", "完整校验发现坏块，未提前保留可用状态。" ); }
    } finally {
      setBusy(false);
      if (downloader) { renderSnapshot(downloader.snapshot()); }
    }
  }

  async function upload() {
    elements.upload.disabled = true;
    elements.actionStatus.textContent = "正在上传报告…";
    try {
      var response = await fetch(REPORT_ENDPOINT, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report())
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body.ok) { throw new Error(body.error || "HTTP " + response.status); }
      elements.actionStatus.textContent = "报告已上传，编号：" + body.reportId;
    } catch (error) {
      elements.actionStatus.textContent = "上传失败：" + errorText(error);
    } finally {
      elements.upload.disabled = false;
    }
  }

  downloader = new window.D2Downloader({
    state: renderSnapshot,
    progress: function (snapshot) {
      setResult("range", "pass");
      setResult("bounded-memory", snapshot.metrics.maximumConcurrentRequests <= 2 && snapshot.metrics.maximumResponseBytes <= window.d2Storage.CHUNK_SIZE ? "pass" : "fail");
      setResult("integrity", "pass");
      renderSnapshot(snapshot);
    },
    space: function (space) {
      state.space = space;
      elements.runtime.textContent = "站点配额 " + formatBytes(space.quota) + " · 已用 " + formatBytes(space.usage) + " · 本次预留 " + formatBytes(space.requiredBytes);
    },
    verifyProgress: function (progress) {
      elements.actionStatus.textContent = "正在校验 " + progress.packageId + " 第 " + (progress.chunkIndex + 1) + " 块，已发现 " + progress.broken + " 个坏块。";
    },
    deleteProgress: function (progress) {
      elements.actionStatus.textContent = "正在分批删除 " + progress.deleted + " / " + progress.total + " 块。";
    }
  });

  elements.start.addEventListener("click", function () {
    runAction("下载与完整校验", async function () {
      var before = downloader.metrics.reusedBytes;
      await downloader.start();
      var snapshot = downloader.snapshot();
      if (snapshot.install.status === "ready" && snapshot.install.complete) {
        state.completedAt = new Date().toISOString();
        setResult("atomic-complete", "pass");
        setResult("version-isolation", "pass", "资源 URL 使用内容版本并由 If-Match 锁定。" );
        if (before > 0 || snapshot.metrics.resumeCount > 0) { setResult("resume", "pass"); }
      }
    });
  });

  elements.pause.addEventListener("click", function () {
    downloader.pause();
    setResult("resume", "warn", "暂停已请求；当前两个块提交完成后停止，可再次继续。" );
    elements.actionStatus.textContent = "正在完成已收到的资源块，然后暂停。";
  });

  elements.verify.addEventListener("click", function () {
    runAction("重新完整校验", async function () {
      await downloader.verify();
      setResult("integrity", "pass");
      setResult("atomic-complete", "pass");
    });
  });

  elements.tamper.addEventListener("click", function () {
    runAction("模拟坏块", async function () {
      state.tampered = Object.assign({ at: new Date().toISOString() }, await downloader.tamperFirstChunk());
      try { await downloader.verify(); } catch (error) {
        if (error.code !== "E_INTEGRITY") { throw error; }
        setResult("integrity", "pass", "完整校验正确发现模拟坏块，并取消可用状态。" );
        elements.actionStatus.textContent = "坏块已被发现。点击“修复坏块”继续。";
      }
    });
  });

  elements.repairButton.addEventListener("click", function () {
    runAction("修复坏块", async function () {
      var requestsBefore = downloader.metrics.networkRequests;
      await downloader.repair();
      var requestDelta = downloader.metrics.networkRequests - requestsBefore;
      setResult("repair", requestDelta === 1 ? "pass" : "fail", "本次修复新增 " + requestDelta + " 个网络请求。" );
      setResult("atomic-complete", "pass");
    });
  });

  elements.deleteButton.addEventListener("click", function () {
    if (Date.now() > deleteConfirmationExpiresAt) {
      deleteConfirmationExpiresAt = Date.now() + 10000;
      elements.deleteButton.textContent = "再次点击确认删除";
      elements.actionStatus.textContent = "确认后只删除游戏资源，存档区不会被删除。";
      setTimeout(function () {
        if (!busyAction && Date.now() >= deleteConfirmationExpiresAt) {
          deleteConfirmationExpiresAt = 0;
          elements.deleteButton.textContent = "删除游戏数据";
        }
      }, 10100);
      return;
    }
    deleteConfirmationExpiresAt = 0;
    elements.deleteButton.textContent = "删除游戏数据";
    runAction("删除游戏数据", async function () {
      var storageBefore = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      var deletion = await downloader.deleteGame();
      await new Promise(function (resolve) { setTimeout(resolve, 1000); });
      var storageAfter = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      state.deletion = Object.assign({
        at: new Date().toISOString(),
        storageBefore: storageBefore,
        storageAfter: storageAfter
      }, deletion);
      var expectedBatches = Math.ceil(state.deletion.deletedChunks / 32);
      var deletionPassed = state.deletion.deletedChunks > 0 && state.deletion.maximumBatch <= 32 && state.deletion.batches === expectedBatches;
      var usageDetail = storageBefore && storageAfter ? "站点用量 " + formatBytes(storageBefore.usage) + " -> " + formatBytes(storageAfter.usage) + "。" : "";
      setResult("delete", deletionPassed ? "pass" : "fail", "已分 " + state.deletion.batches + " 批删除 " + state.deletion.deletedChunks + " 块，单批最多 " + state.deletion.maximumBatch + " 块。" + usageDetail );
    });
  });

  elements.upload.addEventListener("click", upload);
  renderResults();

  downloader.load().then(function (snapshot) {
    elements.gameTitle.textContent = snapshot.manifest.title;
    elements.total.textContent = formatBytes(snapshot.manifest.requiredBytes);
    elements.packages.textContent = snapshot.manifest.packages.length + " 个 / " + snapshot.manifest.packages.reduce(function (sum, pkg) { return sum + pkg.chunks.length; }, 0) + " 块";
    setResult("catalog", "pass");
    setResult("version-isolation", "pass", "Catalog 与 Manifest 的游戏和内容版本一致。" );
    if (snapshot.metrics.reusedBytes > 0) { setResult("resume", "pass", "重新进入页面后识别到 " + formatBytes(snapshot.metrics.reusedBytes) + " 已提交数据。" ); }
    if (snapshot.install && snapshot.install.status === "ready" && snapshot.install.complete) {
      setResult("atomic-complete", "pass");
    }
    elements.runtime.textContent = navigator.userAgent;
    renderSnapshot(snapshot);
    elements.actionStatus.textContent = "清单已就绪。";
  }).catch(function (error) {
    setResult("catalog", "fail", (error.code ? error.code + " · " : "") + errorText(error));
    setBadge("fail", "初始化失败");
    elements.progressTitle.textContent = "无法开始";
    elements.progressDetail.textContent = errorText(error);
    elements.actionStatus.textContent = "请上传页面错误或联系开发者。";
  });
}());
