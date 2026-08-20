(function () {
  "use strict";

  var STORE_NAME = "FILE_DATA";
  var currentGame = null;
  var entries = [];
  var selectedPaths = {};
  var busy = false;
  var confirmation = null;
  var lastError = null;
  var elements = {
    title: document.getElementById("save-game-title"),
    summary: document.getElementById("save-summary"),
    status: document.getElementById("save-manager-status"),
    list: document.getElementById("save-list"),
    refresh: document.getElementById("refresh-saves"),
    importSaves: document.getElementById("import-saves"),
    deleteSelected: document.getElementById("delete-selected-saves"),
    deleteAll: document.getElementById("delete-all-saves")
  };

  function errorText(error) { return error && error.message ? error.message : String(error); }
  function databaseName(gameId) { return "/savedata/" + gameId; }
  function prefix(gameId) { return databaseName(gameId) + "/"; }

  function formatBytes(bytes) {
    var value = Number(bytes || 0);
    if (value >= 1024 * 1024) { return (value / (1024 * 1024)).toFixed(2) + " MiB"; }
    if (value >= 1024) { return (value / 1024).toFixed(1) + " KiB"; }
    return value + " B";
  }

  function formatTime(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (!value || Number.isNaN(date.getTime())) { return "时间未知"; }
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function categoryFor(path) {
    var name = path.toLowerCase().split("/").pop();
    if (/(?:quick|qsave|qload|auto)/.test(name)) { return "quick"; }
    if (/(?:system|config|global|datasc|datasu|env|persist)/.test(name)) { return "system"; }
    if (/(?:save|data|bookmark|slot)[_-]?\d+/.test(name) || /\.(?:sav|save|ksd)$/.test(name)) { return "story"; }
    return "other";
  }

  function categoryLabel(category) {
    return { story: "剧情存档", quick: "快速存档", system: "系统与进度", other: "其他" }[category] || "其他";
  }

  function isFileMode(mode) {
    return (Number(mode || 0) & 61440) === 32768;
  }

  function contentSize(contents) {
    if (!contents) { return 0; }
    if (typeof contents.byteLength === "number") { return contents.byteLength; }
    if (typeof contents.length === "number") { return contents.length; }
    return 0;
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB 操作失败")); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error("存档事务失败")); };
      transaction.onabort = function () { reject(transaction.error || new Error("存档事务被中止")); };
    });
  }

  function openDatabase(gameId) {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(databaseName(gameId));
      request.onupgradeneeded = function () {
        var database = request.result;
        var store;
        if (database.objectStoreNames.contains(STORE_NAME)) {
          store = request.transaction.objectStore(STORE_NAME);
        } else {
          store = database.createObjectStore(STORE_NAME);
        }
        if (!store.indexNames.contains("timestamp")) {
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("无法打开存档数据库")); };
      request.onblocked = function () { reject(new Error("存档正在被旧引擎占用，请强制重启后再试")); };
    });
  }

  async function readEntries(gameId) {
    var database = await openDatabase(gameId);
    try {
      if (!database.objectStoreNames.contains(STORE_NAME)) { return []; }
      var transaction = database.transaction(STORE_NAME, "readonly");
      var store = transaction.objectStore(STORE_NAME);
      var result = [];
      await new Promise(function (resolve, reject) {
        var request = store.openCursor();
        request.onerror = function () { reject(request.error || new Error("无法读取存档列表")); };
        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor) { resolve(); return; }
          var path = String(cursor.key);
          var value = cursor.value || {};
          if (path.indexOf(prefix(gameId)) === 0 && isFileMode(value.mode)) {
            result.push({
              path: path,
              name: path.slice(prefix(gameId).length),
              category: categoryFor(path),
              bytes: contentSize(value.contents),
              timestamp: value.timestamp
            });
          }
          cursor.continue();
        };
      });
      return result.sort(function (left, right) {
        var leftTime = new Date(left.timestamp || 0).getTime();
        var rightTime = new Date(right.timestamp || 0).getTime();
        return rightTime - leftTime || left.name.localeCompare(right.name);
      });
    } finally {
      database.close();
    }
  }

  async function deleteEntries(gameId, paths) {
    var allowedPrefix = prefix(gameId);
    var safePaths = paths.filter(function (path) { return String(path).indexOf(allowedPrefix) === 0; });
    if (!safePaths.length) { return; }
    await window.krkr2Player.stop({ sync: true });
    var database = await openDatabase(gameId);
    try {
      var transaction = database.transaction(STORE_NAME, "readwrite");
      var store = transaction.objectStore(STORE_NAME);
      safePaths.forEach(function (path) { store.delete(path); });
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  // Import a cleared-save set from the development server (/savedata-import/).
  // Records are written in Emscripten IDBFS shape ({timestamp, mode,
  // contents}) so the engine picks them up through FS.syncfs on next start.
  async function importClearedSaves(game) {
    var manifestResponse = await fetch("/savedata-import/manifest.json", { cache: "no-store" });
    if (!manifestResponse.ok) { throw new Error("通关存档清单不存在（HTTP " + manifestResponse.status + "）"); }
    var manifest = await manifestResponse.json();
    var files = (manifest && Array.isArray(manifest.files)) ? manifest.files : [];
    if (!files.length) { throw new Error("通关存档目录为空"); }
    // Download every file before touching IndexedDB: an IDB transaction
    // auto-commits once the task queue drains, so awaiting a fetch inside a
    // live transaction aborts it ("transaction has finished").
    var records = [];
    var totalBytes = 0;
    // Non-save artifacts from the source environment: data.cfu is the desktop
    // exe's per-user config (the engine would consume it as injected engine
    // arguments) and krkr.console.log is a debug-console log; neither belongs
    // in the web savedata.
    var skippedArtifacts = ["data.cfu", "krkr.console.log"];
    for (var index = 0; index < files.length; index += 1) {
      var name = String(files[index].name || "");
      if (!name || name.indexOf("/") >= 0 || name.indexOf("\\") >= 0) { continue; }
      if (skippedArtifacts.indexOf(name) >= 0) { continue; }
      var response = await fetch("/savedata-import/" + encodeURIComponent(name), { cache: "no-store" });
      if (!response.ok) { throw new Error("下载存档失败：" + name); }
      var contents = new Uint8Array(await response.arrayBuffer());
      records.push({ name: name, contents: contents });
      totalBytes += contents.length;
    }
    if (!records.length) { throw new Error("通关存档清单中没有可导入的文件"); }
    await window.krkr2Player.stop({ sync: true });
    var database = await openDatabase(game.gameId);
    try {
      var transaction = database.transaction(STORE_NAME, "readwrite");
      var store = transaction.objectStore(STORE_NAME);
      records.forEach(function (record) {
        store.put({
          timestamp: new Date(),
          mode: 33206,
          contents: record.contents
        }, prefix(game.gameId) + record.name);
      });
      await transactionDone(transaction);
    } finally {
      database.close();
    }
    return { imported: records.length, bytes: totalBytes };
  }

  function selectedCount() {
    return Object.keys(selectedPaths).filter(function (path) { return selectedPaths[path]; }).length;
  }

  function render() {
    var totalBytes = entries.reduce(function (sum, entry) { return sum + entry.bytes; }, 0);
    elements.title.textContent = currentGame ? currentGame.title : "未选择游戏";
    elements.summary.textContent = entries.length + " 个文件 · " + formatBytes(totalBytes);
    elements.list.textContent = "";
    elements.refresh.disabled = busy || !currentGame;
    if (elements.importSaves) {
      elements.importSaves.disabled = busy || !currentGame;
      elements.importSaves.textContent = confirmation === "import" ? "再次点击确认导入" : "导入通关存档";
    }
    elements.deleteSelected.disabled = busy || selectedCount() === 0;
    elements.deleteAll.disabled = busy || entries.length === 0;
    elements.deleteSelected.textContent = confirmation === "selected" ? "再次点击确认删除" : "删除选中";
    elements.deleteAll.textContent = confirmation === "all" ? "再次点击确认全部删除" : "删除全部";

    if (busy) {
      elements.status.textContent = "正在处理存档";
      return;
    }
    if (lastError) {
      elements.status.textContent = "读取失败：" + lastError;
    } else {
      elements.status.textContent = entries.length ? "删除存档会先安全停止正在运行的游戏" : "尚无本机存档";
    }
    if (!entries.length) {
      var empty = document.createElement("div");
      empty.className = "save-empty";
      empty.textContent = currentGame ? "这个游戏还没有产生存档。" : "请先在游戏库选择游戏。";
      elements.list.appendChild(empty);
      return;
    }

    entries.forEach(function (entry) {
      var row = document.createElement("label");
      row.className = "save-row";
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!selectedPaths[entry.path];
      checkbox.addEventListener("change", function () {
        selectedPaths[entry.path] = checkbox.checked;
        confirmation = null;
        render();
      });
      var category = document.createElement("span");
      category.className = "save-category " + entry.category;
      category.textContent = categoryLabel(entry.category);
      var copy = document.createElement("span");
      copy.className = "save-copy";
      var name = document.createElement("strong");
      name.textContent = entry.name;
      var time = document.createElement("span");
      time.textContent = formatTime(entry.timestamp);
      copy.appendChild(name);
      copy.appendChild(time);
      var size = document.createElement("span");
      size.className = "save-size";
      size.textContent = formatBytes(entry.bytes);
      row.appendChild(checkbox);
      row.appendChild(category);
      row.appendChild(copy);
      row.appendChild(size);
      elements.list.appendChild(row);
    });
  }

  async function refresh(game) {
    if (game) { currentGame = game; }
    if (!currentGame || busy) { render(); return snapshot(); }
    busy = true;
    lastError = null;
    render();
    try {
      entries = await readEntries(currentGame.gameId);
      selectedPaths = {};
    } catch (error) {
      entries = [];
      lastError = errorText(error);
    }
    busy = false;
    render();
    return snapshot();
  }

  function confirmThenDelete(kind, paths) {
    if (busy || !currentGame || !paths.length) { return; }
    if (confirmation !== kind) {
      confirmation = kind;
      render();
      setTimeout(function () {
        if (confirmation === kind) { confirmation = null; render(); }
      }, 8000);
      return;
    }
    confirmation = null;
    busy = true;
    render();
    deleteEntries(currentGame.gameId, paths).then(function () {
      busy = false;
      return refresh();
    }).catch(function (error) {
      busy = false;
      lastError = errorText(error);
      render();
    });
  }

  function importSaves() {
    if (busy || !currentGame) { return; }
    if (confirmation !== "import") {
      confirmation = "import";
      elements.status.textContent = "再次点击以确认导入（覆盖同名存档文件）";
      setTimeout(function () {
        if (confirmation === "import") { confirmation = null; render(); }
      }, 8000);
      return;
    }
    confirmation = null;
    busy = true;
    render();
    importClearedSaves(currentGame).then(function (result) {
      busy = false;
      return refresh().then(function () {
        elements.status.textContent = "已导入 " + result.imported + " 个通关存档文件（" + formatBytes(result.bytes) + "），下次启动生效";
      });
    }).catch(function (error) {
      busy = false;
      lastError = errorText(error);
      render();
    });
  }

  function setGame(game) {
    if (!game || (currentGame && currentGame.gameId === game.gameId)) { return; }
    currentGame = game;
    entries = [];
    selectedPaths = {};
    confirmation = null;
    lastError = null;
    render();
  }

  function snapshot() {
    return {
      gameId: currentGame && currentGame.gameId,
      entries: entries.map(function (entry) {
        return { path: entry.path, name: entry.name, category: entry.category, bytes: entry.bytes, timestamp: entry.timestamp };
      }),
      selectedCount: selectedCount(),
      busy: busy,
      error: lastError
    };
  }

  elements.refresh.addEventListener("click", function () { refresh(); });
  if (elements.importSaves) {
    elements.importSaves.addEventListener("click", importSaves);
  }
  elements.deleteSelected.addEventListener("click", function () {
    var paths = Object.keys(selectedPaths).filter(function (path) { return selectedPaths[path]; });
    confirmThenDelete("selected", paths);
  });
  elements.deleteAll.addEventListener("click", function () {
    confirmThenDelete("all", entries.map(function (entry) { return entry.path; }));
  });

  render();
  window.krkr2SaveManager = { setGame: setGame, refresh: refresh, snapshot: snapshot };
}());
