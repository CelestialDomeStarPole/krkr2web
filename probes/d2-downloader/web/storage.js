(function () {
  "use strict";

  var DATABASE_NAME = "krkr2web";
  var DATABASE_VERSION = 1;
  var CHUNK_SIZE = 4 * 1024 * 1024;
  var GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var HEX_256 = /^[0-9a-f]{64}$/;

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB 请求失败")); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onabort = function () { reject(transaction.error || new Error("IndexedDB 事务已中止")); };
      transaction.onerror = function () {};
    });
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains("catalog")) {
          database.createObjectStore("catalog", { keyPath: "catalogVersion" });
        }
        if (!database.objectStoreNames.contains("manifests")) {
          database.createObjectStore("manifests", { keyPath: ["gameId", "version"] });
        }
        if (!database.objectStoreNames.contains("chunks")) {
          database.createObjectStore("chunks");
        }
        if (!database.objectStoreNames.contains("chunkState")) {
          database.createObjectStore("chunkState", { keyPath: ["gameId", "version", "packageId", "chunkIndex"] });
        }
        if (!database.objectStoreNames.contains("installs")) {
          database.createObjectStore("installs", { keyPath: "gameId" });
        }
        if (!database.objectStoreNames.contains("saves")) {
          database.createObjectStore("saves", { keyPath: ["gameId", "profile", "path"] });
        }
        if (!database.objectStoreNames.contains("diagnostics")) {
          database.createObjectStore("diagnostics", { keyPath: "id" });
        }
      };
      request.onsuccess = function () {
        request.result.onversionchange = function () { request.result.close(); };
        resolve(request.result);
      };
      request.onerror = function () { reject(request.error || new Error("无法打开 IndexedDB")); };
      request.onblocked = function () { reject(new Error("IndexedDB 升级被其他页面阻止")); };
    });
  }

  function failManifest(message) {
    var error = new Error(message);
    error.code = "E_INVALID_MANIFEST";
    throw error;
  }

  function isSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function requireString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
      failManifest(name + " 必须是非空字符串");
    }
  }

  function validatePath(path, name) {
    requireString(path, name);
    if (path.charAt(0) === "/" || path.indexOf("\\") !== -1 || path.split("/").indexOf("..") !== -1 || /[\u0000-\u001f]/.test(path)) {
      failManifest(name + " 不是安全的相对路径");
    }
  }

  function validateServerPath(path, name, jsonOnly) {
    requireString(path, name);
    if (path.charAt(0) !== "/" || path.indexOf("//") === 0 || path.indexOf("\\") !== -1 || path.indexOf("..") !== -1 || path.indexOf("?") !== -1 || path.indexOf("#") !== -1) {
      failManifest(name + " 必须是同源绝对路径");
    }
    if (jsonOnly && path.slice(-5) !== ".json") {
      failManifest(name + " 必须指向 JSON 文件");
    }
  }

  function validateCatalog(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { failManifest("Catalog 不是对象"); }
    if (value.schemaVersion !== 1) { failManifest("不支持的 Catalog schemaVersion"); }
    requireString(value.catalogVersion, "catalogVersion");
    if (!Array.isArray(value.games) || value.games.length === 0) { failManifest("games 必须是非空数组"); }
    var ids = {};
    value.games.forEach(function (game, index) {
      if (!game || typeof game !== "object" || Array.isArray(game)) { failManifest("games[" + index + "] 不是对象"); }
      if (!GAME_ID.test(game.gameId || "") || ids[game.gameId]) { failManifest("gameId 非法或重复"); }
      ids[game.gameId] = true;
      requireString(game.title, "title");
      requireString(game.version, "version");
      requireString(game.compatibility, "compatibility");
      validateServerPath(game.manifestUrl, "manifestUrl", true);
      if (!isSafeInteger(game.requiredBytes) || game.requiredBytes <= 0) { failManifest("requiredBytes 非法"); }
    });
    return value;
  }

  function validateManifest(value, expectedGame) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { failManifest("Manifest 不是对象"); }
    if (value.schemaVersion !== 1) { failManifest("不支持的 Manifest schemaVersion"); }
    if (!GAME_ID.test(value.gameId || "")) { failManifest("Manifest gameId 非法"); }
    requireString(value.version, "version");
    requireString(value.title, "title");
    requireString(value.engineProfile, "engineProfile");
    if (expectedGame && (value.gameId !== expectedGame.gameId || value.version !== expectedGame.version)) {
      var changed = new Error("Catalog 与 Manifest 的游戏或版本不一致");
      changed.code = "E_VERSION_CHANGED";
      throw changed;
    }
    if (!isSafeInteger(value.requiredBytes) || value.requiredBytes <= 0) { failManifest("requiredBytes 非法"); }
    if (expectedGame && value.requiredBytes !== expectedGame.requiredBytes) {
      var sizeChanged = new Error("Catalog 与 Manifest 的资源总大小不一致");
      sizeChanged.code = "E_VERSION_CHANGED";
      throw sizeChanged;
    }
    if (!Array.isArray(value.packages) || value.packages.length === 0) { failManifest("packages 必须是非空数组"); }
    if (!Array.isArray(value.mediaOverrides)) { failManifest("mediaOverrides 必须是数组"); }

    var ids = {};
    var paths = {};
    var totalBytes = 0;
    value.packages.forEach(function (pkg, packageIndex) {
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) { failManifest("package 不是对象"); }
      requireString(pkg.id, "package.id");
      validatePath(pkg.id, "package.id");
      validatePath(pkg.virtualPath, "package.virtualPath");
      validateServerPath(pkg.url, "package.url", false);
      if (ids[pkg.id] || paths[pkg.virtualPath]) { failManifest("包 ID 或虚拟路径重复"); }
      ids[pkg.id] = true;
      paths[pkg.virtualPath] = true;
      if (!isSafeInteger(pkg.size) || pkg.size <= 0) { failManifest("package.size 非法"); }
      if (pkg.chunkSize !== CHUNK_SIZE) { failManifest("schema 1 的 chunkSize 必须为 4 MiB"); }
      if (!HEX_256.test(pkg.sha256 || "")) { failManifest("package.sha256 非法"); }
      if (!Array.isArray(pkg.chunks) || pkg.chunks.length !== Math.ceil(pkg.size / CHUNK_SIZE)) {
        failManifest("package.chunks 数量错误");
      }
      pkg.chunks.forEach(function (hash, chunkIndex) {
        if (!HEX_256.test(hash || "")) { failManifest("第 " + packageIndex + " 个包的第 " + chunkIndex + " 个块哈希非法"); }
      });
      totalBytes += pkg.size;
      if (!Number.isSafeInteger(totalBytes)) { failManifest("包总大小超过安全整数范围"); }
    });
    if (value.requiredBytes < totalBytes) { failManifest("requiredBytes 小于包总大小"); }
    return value;
  }

  function getRecord(storeName, key) {
    return openDatabase().then(function (database) {
      var transaction = database.transaction(storeName, "readonly");
      var result = requestResult(transaction.objectStore(storeName).get(key));
      return result.then(function (value) { database.close(); return value; }, function (error) { database.close(); throw error; });
    });
  }

  function putRecord(storeName, value) {
    return openDatabase().then(function (database) {
      var transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      return transactionDone(transaction).then(function () { database.close(); }, function (error) { database.close(); throw error; });
    });
  }

  function storeCatalog(catalog) {
    return putRecord("catalog", {
      catalogVersion: catalog.catalogVersion,
      fetchedAt: new Date().toISOString(),
      value: catalog
    });
  }

  function getLatestCatalog() {
    return openDatabase().then(function (database) {
      var transaction = database.transaction("catalog", "readonly");
      return requestResult(transaction.objectStore("catalog").getAll()).then(function (records) {
        database.close();
        records.sort(function (left, right) {
          return String(right.fetchedAt || "").localeCompare(String(left.fetchedAt || ""));
        });
        return records.length ? records[0].value : null;
      }, function (error) { database.close(); throw error; });
    });
  }

  function storeManifest(manifest) {
    return putRecord("manifests", {
      gameId: manifest.gameId,
      version: manifest.version,
      fetchedAt: new Date().toISOString(),
      value: manifest
    });
  }

  function getManifest(gameId, version) {
    return getRecord("manifests", [gameId, version]).then(function (record) {
      return record && record.value ? record.value : null;
    });
  }

  function getInstall(gameId) { return getRecord("installs", gameId); }
  function putInstall(install) { return putRecord("installs", install); }

  function chunkKey(manifest, pkg, chunkIndex) {
    return [manifest.gameId, manifest.version, pkg.id, chunkIndex];
  }

  function expectedChunkLength(pkg, chunkIndex) {
    return Math.min(CHUNK_SIZE, pkg.size - chunkIndex * CHUNK_SIZE);
  }

  function getChunkState(manifest, pkg, chunkIndex) {
    return getRecord("chunkState", chunkKey(manifest, pkg, chunkIndex));
  }

  function getChunk(manifest, pkg, chunkIndex) {
    return getRecord("chunks", chunkKey(manifest, pkg, chunkIndex));
  }

  function collectKeys(store, range) {
    return new Promise(function (resolve, reject) {
      var keys = [];
      var request = store.openKeyCursor(range);
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) { resolve(keys); return; }
        keys.push(cursor.primaryKey);
        cursor.continue();
      };
      request.onerror = function () { reject(request.error || new Error("无法枚举 IndexedDB 键")); };
    });
  }

  function listManifestInventory(manifest) {
    return openDatabase().then(function (database) {
      var lower = [manifest.gameId, manifest.version, "", 0];
      var upper = [manifest.gameId, manifest.version, "\uffff", Number.MAX_SAFE_INTEGER];
      var range = IDBKeyRange.bound(lower, upper);
      var transaction = database.transaction(["chunks", "chunkState"], "readonly");
      return Promise.all([
        collectKeys(transaction.objectStore("chunks"), range),
        requestResult(transaction.objectStore("chunkState").getAll(range))
      ]).then(function (values) {
        return transactionDone(transaction).then(function () {
          database.close();
          return { chunkKeys: values[0], states: values[1] };
        });
      }, function (error) { database.close(); throw error; });
    });
  }

  function listGameChunkKeys(gameId) {
    return openDatabase().then(function (database) {
      var lower = [gameId, "", "", 0];
      var upper = [gameId, "\uffff", "\uffff", Number.MAX_SAFE_INTEGER];
      var range = IDBKeyRange.bound(lower, upper);
      var transaction = database.transaction(["chunks", "chunkState"], "readonly");
      return Promise.all([
        collectKeys(transaction.objectStore("chunks"), range),
        collectKeys(transaction.objectStore("chunkState"), range)
      ]).then(function (values) {
        var unique = {};
        values[0].concat(values[1]).forEach(function (key) { unique[JSON.stringify(key)] = key; });
        return transactionDone(transaction).then(function () {
          database.close();
          return Object.keys(unique).map(function (key) { return unique[key]; });
        });
      }, function (error) { database.close(); throw error; });
    });
  }

  function commitChunk(manifest, pkg, chunkIndex, data, install) {
    return openDatabase().then(function (database) {
      var transaction = database.transaction(["chunks", "chunkState", "installs"], "readwrite");
      var keyFields = {
        gameId: manifest.gameId,
        version: manifest.version,
        packageId: pkg.id,
        chunkIndex: chunkIndex
      };
      transaction.objectStore("chunks").put(data, chunkKey(manifest, pkg, chunkIndex));
      transaction.objectStore("chunkState").put(Object.assign({
        length: data.byteLength,
        sha256: pkg.chunks[chunkIndex],
        completedAt: new Date().toISOString()
      }, keyFields));
      transaction.objectStore("installs").put(install);
      return transactionDone(transaction).then(function () { database.close(); }, function (error) { database.close(); throw error; });
    });
  }

  function deleteChunk(manifest, pkg, chunkIndex) {
    return openDatabase().then(function (database) {
      var transaction = database.transaction(["chunks", "chunkState"], "readwrite");
      var key = chunkKey(manifest, pkg, chunkIndex);
      transaction.objectStore("chunks").delete(key);
      transaction.objectStore("chunkState").delete(key);
      return transactionDone(transaction).then(function () { database.close(); }, function (error) { database.close(); throw error; });
    });
  }

  function deleteChunkBatch(keys) {
    return openDatabase().then(function (database) {
      var transaction = database.transaction(["chunks", "chunkState"], "readwrite");
      keys.forEach(function (key) {
        transaction.objectStore("chunks").delete(key);
        transaction.objectStore("chunkState").delete(key);
      });
      return transactionDone(transaction).then(function () { database.close(); }, function (error) { database.close(); throw error; });
    });
  }

  function tamperChunk(manifest, pkg, chunkIndex) {
    return getChunk(manifest, pkg, chunkIndex).then(function (record) {
      if (!(record instanceof ArrayBuffer)) { throw new Error("没有可损坏的已保存块"); }
      var data = record.slice(0);
      var bytes = new Uint8Array(data);
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      return openDatabase().then(function (database) {
        var transaction = database.transaction("chunks", "readwrite");
        transaction.objectStore("chunks").put(data, chunkKey(manifest, pkg, chunkIndex));
        return transactionDone(transaction).then(function () { database.close(); }, function (error) { database.close(); throw error; });
      });
    });
  }

  window.d2Storage = {
    CHUNK_SIZE: CHUNK_SIZE,
    validateCatalog: validateCatalog,
    validateManifest: validateManifest,
    storeCatalog: storeCatalog,
    getLatestCatalog: getLatestCatalog,
    storeManifest: storeManifest,
    getManifest: getManifest,
    getInstall: getInstall,
    putInstall: putInstall,
    getChunkState: getChunkState,
    getChunk: getChunk,
    listManifestInventory: listManifestInventory,
    listGameChunkKeys: listGameChunkKeys,
    commitChunk: commitChunk,
    deleteChunk: deleteChunk,
    deleteChunkBatch: deleteChunkBatch,
    tamperChunk: tamperChunk,
    expectedChunkLength: expectedChunkLength,
    chunkKey: chunkKey
  };
}());
