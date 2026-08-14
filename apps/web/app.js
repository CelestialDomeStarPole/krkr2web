(function () {
  "use strict";

  var catalog = null;
  var selectedGameId = null;
  var installs = {};
  var downloaders = {};
  var actionPending = false;
  var deleteConfirmation = null;
  var bootError = null;
  var elements = {
    network: document.getElementById("network-label"),
    storage: document.getElementById("storage-usage"),
    catalogStatus: document.getElementById("catalog-status"),
    gameList: document.getElementById("game-list"),
    detail: document.getElementById("game-detail"),
    downloads: document.getElementById("download-list"),
    offlineReady: document.getElementById("offline-ready-status"),
    input: document.getElementById("input-mode"),
    runtime: document.getElementById("runtime-version"),
    upload: document.getElementById("upload-diagnostics"),
    diagnosticsStatus: document.getElementById("diagnostics-status"),
    toast: document.getElementById("toast")
  };

  function formatBytes(bytes) {
    var value = Number(bytes || 0);
    if (value >= 1024 * 1024 * 1024) { return (value / (1024 * 1024 * 1024)).toFixed(2) + " GiB"; }
    if (value >= 1024 * 1024) { return (value / (1024 * 1024)).toFixed(2) + " MiB"; }
    if (value >= 1024) { return (value / 1024).toFixed(2) + " KiB"; }
    return value + " B";
  }

  function statusLabel(install) {
    var status = install && install.status;
    return {
      "checking-space": "检查空间", downloading: "下载中", paused: "已暂停", verifying: "正在校验",
      committing: "正在完成", ready: "已安装", "recoverable-error": "可继续", "fatal-error": "版本错误",
      deleting: "删除中", "not-installed": "未安装"
    }[status] || "未安装";
  }

  function coverUrl(game) { return game.coverUrl || "/assets/default-cover.png"; }
  function description(game) { return game.description || "KRKR2 游戏资源由服务端提供，完整安装后可从本机启动。"; }
  function isReady(game) {
    var install = installs[game.gameId];
    return !!install && install.complete === true && install.status === "ready" && install.activeVersion === game.version;
  }

  function notify(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(function () { elements.toast.hidden = true; }, 3200);
  }

  function renderOfflineReady() {
    var assets = window.krkr2Player.snapshot().assets;
    if (assets.status === "ready") {
      elements.offlineReady.textContent = "已准备 · 保持本页可断网启动";
    } else if (assets.status === "loading") {
      elements.offlineReady.textContent = "正在准备引擎";
    } else if (assets.status === "failed") {
      elements.offlineReady.textContent = "准备失败 · 请联网重试";
    } else {
      elements.offlineReady.textContent = "尚未准备";
    }
  }

  async function loadCatalog() {
    try {
      var response = await fetch("/catalog.json", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) { throw new Error("HTTP " + response.status); }
      catalog = window.d2Storage.validateCatalog(await response.json());
      await window.d2Storage.storeCatalog(catalog);
      elements.catalogStatus.textContent = navigator.onLine ? "在线目录" : "本机目录";
    } catch (error) {
      catalog = await window.d2Storage.getLatestCatalog();
      if (!catalog) { throw error; }
      catalog = window.d2Storage.validateCatalog(catalog);
      elements.catalogStatus.textContent = "本机目录";
    }
    for (var index = 0; index < catalog.games.length; index += 1) {
      var game = catalog.games[index];
      installs[game.gameId] = await window.d2Storage.getInstall(game.gameId);
    }
    selectedGameId = selectedGameId || catalog.games[0].gameId;
  }

  function selectedGame() {
    return catalog && catalog.games.find(function (game) { return game.gameId === selectedGameId; });
  }

  function renderLibrary() {
    elements.gameList.textContent = "";
    if (!catalog || !catalog.games.length) { return; }
    catalog.games.forEach(function (game) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "game-card" + (game.gameId === selectedGameId ? " selected" : "");
      button.dataset.gameId = game.gameId;
      var image = document.createElement("img");
      image.className = "game-cover";
      image.src = coverUrl(game);
      image.alt = "";
      var copy = document.createElement("span");
      copy.className = "game-card-copy";
      var title = document.createElement("strong");
      title.textContent = game.title;
      var status = document.createElement("span");
      status.textContent = statusLabel(installs[game.gameId]) + " · " + formatBytes(game.requiredBytes);
      copy.appendChild(title);
      copy.appendChild(status);
      button.appendChild(image);
      button.appendChild(copy);
      button.addEventListener("click", function () { selectedGameId = game.gameId; render(); });
      elements.gameList.appendChild(button);
    });
  }

  function actionButton(text, className, action, disabled) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.disabled = !!disabled;
    button.addEventListener("click", action);
    return button;
  }

  function renderDetail() {
    var game = selectedGame();
    if (!game) { return; }
    var install = installs[game.gameId] || {};
    var saved = Number(install.committedBytes || 0);
    var percent = game.requiredBytes ? Math.min(100, saved / game.requiredBytes * 100) : 0;
    elements.detail.textContent = "";
    var image = document.createElement("img");
    image.className = "detail-cover";
    image.src = coverUrl(game);
    image.alt = "";
    elements.detail.appendChild(image);
    var header = document.createElement("div");
    header.className = "detail-header";
    var heading = document.createElement("div");
    heading.innerHTML = "<h2></h2><p></p>";
    heading.querySelector("h2").textContent = game.title;
    heading.querySelector("p").textContent = formatBytes(game.requiredBytes) + " · " + statusLabel(install);
    var badge = document.createElement("span");
    badge.className = "compatibility";
    badge.textContent = game.compatibility === "verified" ? "已验证" : "开发验证";
    header.appendChild(heading);
    header.appendChild(badge);
    elements.detail.appendChild(header);
    var descriptionNode = document.createElement("p");
    descriptionNode.className = "detail-description";
    descriptionNode.textContent = description(game);
    elements.detail.appendChild(descriptionNode);
    var track = document.createElement("div");
    track.className = "progress-track";
    track.innerHTML = '<div class="progress-fill"></div>';
    track.firstChild.style.width = percent.toFixed(3) + "%";
    elements.detail.appendChild(track);
    var meta = document.createElement("div");
    meta.className = "progress-meta";
    meta.innerHTML = "<span></span><span></span>";
    meta.children[0].textContent = formatBytes(saved) + " / " + formatBytes(game.requiredBytes);
    meta.children[1].textContent = percent.toFixed(1) + "%";
    elements.detail.appendChild(meta);
    var actions = document.createElement("div");
    actions.className = "detail-actions";
    if (isReady(game)) {
      var play = actionButton("启动游戏", "primary", function () {
        var originalHref = location.href;
        window.krkr2Player.start(game.gameId, game.title).then(function () {
          if (location.href !== originalHref) { throw new Error("启动游戏时页面地址发生了变化"); }
        }).catch(function (error) { notify(error.message || String(error)); });
      }, actionPending);
      actions.appendChild(play);
      actions.appendChild(actionButton("重新校验", "secondary", function () { verifyGame(game); }, actionPending));
    } else if (install.status === "downloading") {
      actions.appendChild(actionButton("暂停下载", "secondary", function () { pauseGame(game); }, false));
    } else {
      actions.appendChild(actionButton(saved > 0 ? "继续下载" : "完整下载", "primary", function () { downloadGame(game); }, actionPending));
    }
    if (saved > 0 || isReady(game)) {
      actions.appendChild(actionButton(deleteConfirmation === game.gameId ? "确认删除" : "删除资源", "danger", function () { deleteGame(game); }, actionPending));
    }
    elements.detail.appendChild(actions);
  }

  function renderDownloads() {
    elements.downloads.textContent = "";
    if (!catalog) { return; }
    catalog.games.forEach(function (game) {
      var install = installs[game.gameId] || {};
      var saved = Number(install.committedBytes || 0);
      var percent = game.requiredBytes ? Math.min(100, saved / game.requiredBytes * 100) : 0;
      var row = document.createElement("div");
      row.className = "download-row";
      row.innerHTML = '<div><strong></strong><span></span></div><div class="download-progress"><div class="progress-track"><div class="progress-fill"></div></div><div class="progress-meta"><span></span><span></span></div></div><span></span>';
      row.querySelector("strong").textContent = game.title;
      row.querySelector("div > span").textContent = statusLabel(install);
      row.querySelector(".progress-fill").style.width = percent.toFixed(3) + "%";
      row.querySelector(".progress-meta").children[0].textContent = formatBytes(saved);
      row.querySelector(".progress-meta").children[1].textContent = percent.toFixed(1) + "%";
      row.lastChild.textContent = formatBytes(game.requiredBytes);
      elements.downloads.appendChild(row);
    });
  }

  function render() { renderLibrary(); renderDetail(); renderDownloads(); }

  function callbacksFor(game) {
    return {
      state: function (snapshot) {
        installs[game.gameId] = snapshot.install;
        render();
      },
      progress: function (snapshot) {
        installs[game.gameId] = snapshot.install;
        render();
      },
      verifyProgress: function (progress) {
        notify("正在校验 " + progress.packageId + " · 第 " + (progress.chunkIndex + 1) + " 块");
      },
      deleteProgress: function (progress) { notify("正在删除 " + progress.deleted + " / " + progress.total + " 块"); }
    };
  }

  async function getDownloader(game) {
    if (!downloaders[game.gameId]) {
      var downloader = new window.D2Downloader(callbacksFor(game), { gameId: game.gameId });
      downloaders[game.gameId] = downloader;
      var snapshot = await downloader.load();
      installs[game.gameId] = snapshot.install;
    }
    return downloaders[game.gameId];
  }

  async function runAction(action) {
    if (actionPending) { return; }
    actionPending = true;
    render();
    try { await action(); } catch (error) { notify((error.code ? error.code + " · " : "") + (error.message || String(error))); }
    actionPending = false;
    render();
    updateStorage();
  }

  function downloadGame(game) {
    runAction(async function () {
      notify("正在准备 " + game.title);
      var downloader = await getDownloader(game);
      await downloader.start();
      installs[game.gameId] = downloader.snapshot().install;
      if (isReady(game)) { notify(game.title + " 已安装"); }
    });
  }

  function pauseGame(game) {
    var downloader = downloaders[game.gameId];
    if (downloader) { downloader.pause(); notify("正在完成已收到的资源块"); }
  }

  function verifyGame(game) {
    runAction(async function () {
      var downloader = await getDownloader(game);
      await downloader.verify();
      installs[game.gameId] = downloader.snapshot().install;
      notify(game.title + " 校验通过");
    });
  }

  function deleteGame(game) {
    if (deleteConfirmation !== game.gameId) {
      deleteConfirmation = game.gameId;
      render();
      notify("再次点击确认，只删除游戏资源");
      setTimeout(function () { if (deleteConfirmation === game.gameId) { deleteConfirmation = null; render(); } }, 8000);
      return;
    }
    deleteConfirmation = null;
    runAction(async function () {
      var downloader = await getDownloader(game);
      await downloader.deleteGame();
      installs[game.gameId] = downloader.snapshot().install;
      notify(game.title + " 的资源已删除");
    });
  }

  async function updateStorage() {
    if (!navigator.storage || !navigator.storage.estimate) { elements.storage.textContent = "可用"; return; }
    try {
      var estimate = await navigator.storage.estimate();
      elements.storage.textContent = formatBytes(estimate.usage) + " / " + formatBytes(estimate.quota);
    } catch (error) { elements.storage.textContent = "可用"; }
  }

  function updateNetwork() { elements.network.textContent = navigator.onLine ? "在线" : "离线"; }

  async function uploadDiagnostics() {
    elements.upload.disabled = true;
    elements.diagnosticsStatus.textContent = "正在上传";
    var estimate = null;
    try { estimate = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (error) {}
    var lastPlayer = null;
    try { lastPlayer = JSON.parse(localStorage.getItem("krkr2web-d4-last-player") || "null"); } catch (error) {}
    var report = {
      reportVersion: 1,
      probe: "d4-product",
      createdAt: new Date().toISOString(),
      environment: { userAgent: navigator.userAgent, online: navigator.onLine, href: location.href },
      results: {
        catalogVersion: catalog && catalog.catalogVersion,
        selectedGameId: selectedGameId,
        installs: JSON.parse(JSON.stringify(installs)),
        samePageOffline: window.krkr2Player.snapshot(),
        storageEstimate: estimate,
        lastPlayer: lastPlayer
      }
    };
    try {
      var response = await fetch("/api/diagnostics-reports", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report)
      });
      var body = await response.json();
      if (!response.ok || !body.ok) { throw new Error(body.error || "HTTP " + response.status); }
      elements.diagnosticsStatus.textContent = "编号 " + body.reportId;
    } catch (error) {
      elements.diagnosticsStatus.textContent = "上传失败：" + (error.message || String(error));
    } finally {
      elements.upload.disabled = false;
    }
  }

  function setupTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (item) { item.classList.toggle("active", item === tab); });
        Array.prototype.forEach.call(document.querySelectorAll("[data-view-panel]"), function (panel) {
          panel.hidden = panel.dataset.viewPanel !== tab.dataset.view;
        });
      });
    });
  }

  async function boot() {
    setupTabs();
    elements.upload.addEventListener("click", uploadDiagnostics);
    window.addEventListener("krkr2-player-state", renderOfflineReady);
    updateNetwork();
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    elements.input.textContent = /Android|Mobile/i.test(navigator.userAgent) ? "触摸" : "鼠标与键盘";
    var chrome = navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/);
    elements.runtime.textContent = "Chrome " + (chrome ? chrome[1] : "--");
    renderOfflineReady();
    window.krkr2Player.preload().catch(function () {});
    await loadCatalog();
    await updateStorage();
    render();
  }

  window.d4AppState = function () {
    return {
      catalog: catalog,
      selectedGameId: selectedGameId,
      installs: JSON.parse(JSON.stringify(installs)),
      samePageOffline: window.krkr2Player.snapshot(),
      bootError: bootError
    };
  };
  boot().catch(function (error) {
    bootError = error && error.stack ? error.stack : (error.message || String(error));
    if (window.console && console.error) { console.error(bootError); }
    elements.catalogStatus.textContent = "目录不可用";
    elements.detail.innerHTML = '<div class="empty-state"><strong>无法读取游戏目录</strong><span></span></div>';
    elements.detail.querySelector("span").textContent = error.message || String(error);
  });
}());
