(function () {
  "use strict";

  var DATABASE_NAME = "krkr2web";
  var DATABASE_VERSION = 1;
  var CACHE_LIMIT = 4;
  var MAX_READ_BYTES = 64 * 1024 * 1024;
  var ERROR_STORAGE = -5;
  var ERROR_CHUNK_MISSING = -4;
  var state = null;
  var handles = {};
  var nextHandle = 1;
  var cache = new Map();
  var cacheBytes = 0;
  var metrics = {
    openCalls: 0, readCalls: 0, closeCalls: 0, cacheHits: 0,
    cacheMisses: 0, indexedDbBytes: 0, copiedBytes: 0,
    maximumCacheBytes: 0, errors: []
  };

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB request failed")); };
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
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("Cannot open resource database")); };
      request.onblocked = function () { reject(new Error("Resource database is blocked by another page")); };
    });
  }

  function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
  }

  function cacheKey(pkg, chunkIndex) { return pkg.id + ":" + chunkIndex; }

  function putCache(key, buffer) {
    if (cache.has(key)) {
      cacheBytes -= cache.get(key).byteLength;
      cache.delete(key);
    }
    cache.set(key, buffer);
    cacheBytes += buffer.byteLength;
    while (cache.size > CACHE_LIMIT) {
      var oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).byteLength;
      cache.delete(oldest);
    }
    metrics.maximumCacheBytes = Math.max(metrics.maximumCacheBytes, cacheBytes);
  }

  async function loadChunk(pkg, chunkIndex) {
    var key = cacheKey(pkg, chunkIndex);
    if (cache.has(key)) {
      var cached = cache.get(key);
      cache.delete(key);
      cache.set(key, cached);
      metrics.cacheHits += 1;
      return cached;
    }
    metrics.cacheMisses += 1;
    var database = await openDatabase();
    try {
      var transaction = database.transaction("chunks", "readonly");
      var chunk = await requestResult(transaction.objectStore("chunks").get([
        state.gameId, state.version, pkg.id, chunkIndex
      ]));
      if (!(chunk instanceof ArrayBuffer)) { return null; }
      metrics.indexedDbBytes += chunk.byteLength;
      putCache(key, chunk);
      return chunk;
    } finally {
      database.close();
    }
  }

  function packageForPath(path) {
    if (!state) { return null; }
    var wanted = normalizePath(path);
    for (var index = 0; index < state.manifest.packages.length; index += 1) {
      var pkg = state.manifest.packages[index];
      if (normalizePath(pkg.virtualPath) === wanted) { return pkg; }
    }
    return null;
  }

  async function prepare(gameId) {
    var database = await openDatabase();
    try {
      if (!database.objectStoreNames.contains("installs") ||
          !database.objectStoreNames.contains("manifests") ||
          !database.objectStoreNames.contains("chunks")) {
        throw new Error("D2 resource database is incomplete");
      }
      var install = await requestResult(database.transaction("installs", "readonly").objectStore("installs").get(gameId));
      if (!install || install.status !== "ready" || install.complete !== true || !install.activeVersion) {
        throw new Error("The selected game is not fully installed");
      }
      var record = await requestResult(database.transaction("manifests", "readonly").objectStore("manifests").get([
        gameId, install.activeVersion
      ]));
      var manifest = record && record.value;
      if (!manifest || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
        throw new Error("The installed game manifest is missing");
      }
      state = { gameId: gameId, version: install.activeVersion, install: install, manifest: manifest };
      return state;
    } finally {
      database.close();
    }
  }

  function open(path) {
    var pkg = packageForPath(path);
    if (!pkg) { return 0; }
    var handle = nextHandle++;
    handles[handle] = pkg;
    metrics.openCalls += 1;
    return handle;
  }

  function exists(path) { return !!packageForPath(path); }
  function size(handle) { return handles[handle] ? handles[handle].size : -1; }

  async function readToHeap(handle, offset, requestedLength, destination, heap) {
    metrics.readCalls += 1;
    var pkg = handles[handle];
    if (!pkg || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(requestedLength) || requestedLength < 0 ||
        requestedLength > MAX_READ_BYTES || offset > pkg.size) {
      return ERROR_STORAGE;
    }
    var length = Math.min(requestedLength, pkg.size - offset);
    var remaining = length;
    var currentOffset = offset;
    var writeOffset = destination;
    try {
      while (remaining > 0) {
        var chunkIndex = Math.floor(currentOffset / pkg.chunkSize);
        var inChunk = currentOffset - chunkIndex * pkg.chunkSize;
        var chunk = await loadChunk(pkg, chunkIndex);
        if (!chunk) { return ERROR_CHUNK_MISSING; }
        var available = Math.min(remaining, chunk.byteLength - inChunk);
        if (available <= 0) { return ERROR_STORAGE; }
        heap.set(new Uint8Array(chunk, inChunk, available), writeOffset);
        metrics.copiedBytes += available;
        remaining -= available;
        currentOffset += available;
        writeOffset += available;
      }
      return length;
    } catch (error) {
      metrics.errors.push({ message: error && error.message ? error.message : String(error), at: new Date().toISOString() });
      return ERROR_STORAGE;
    }
  }

  function close(handle) {
    if (handles[handle]) { delete handles[handle]; metrics.closeCalls += 1; }
  }

  function snapshot() {
    return {
      gameId: state && state.gameId, version: state && state.version,
      packages: state ? state.manifest.packages.map(function (pkg) {
        return { id: pkg.id, virtualPath: pkg.virtualPath, size: pkg.size };
      }) : [],
      cacheBytes: cacheBytes, cacheEntries: cache.size,
      metrics: JSON.parse(JSON.stringify(metrics))
    };
  }

  window.krkr2StorageBridge = {
    prepare: prepare, open: open, exists: exists, size: size,
    readToHeap: readToHeap, close: close, snapshot: snapshot
  };
}());
