(function () {
  "use strict";

  var DATABASE_NAME = "krkr2web";
  var DATABASE_VERSION = 1;
  // krkr2web: raw XP3 chunk cache. Raised tiers: the click-next path reads
  // the next voice/sprite segments from these chunks, so a hit removes an
  // entire IndexedDB round-trip (an Asyncify suspension) from the click.
  // Prefetched files also land here first, which is what makes the engine's
  // own later read of a predicted file a guaranteed cache hit.
  var deviceMemory = Number(navigator.deviceMemory || 0);
  var CACHE_LIMIT_BYTES = deviceMemory > 0 && deviceMemory <= 2
    ? 64 * 1024 * 1024
    : (deviceMemory >= 8 ? 256 * 1024 * 1024 : 128 * 1024 * 1024);
  var MAX_READ_BYTES = 64 * 1024 * 1024;
  // krkr2web: engine reads at or above this length bypass the chunk LRU and
  // are assembled from one direct IndexedDB transaction. Large one-shot
  // resources (video / archive payloads) are streamed once and rarely
  // re-read; letting their chunks enter the LRU would evict the hot
  // prefetched voice/sprite chunks the click-next path depends on. A large
  // read whose chunks are already fully cached still takes the cache path,
  // so a prefetched file remains a pure hit.
  var DIRECT_READ_THRESHOLD = 1024 * 1024;
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
    prefetchReads: 0, prefetchBytes: 0,
    directReads: 0, directBytes: 0,
    maximumCacheBytes: 0, errors: []
  };

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      var transaction = request.transaction;
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB 请求失败")); };
      if (transaction) {
        // an aborted transaction never fires request onerror/on success in
        // some Chrome builds; without this the promise hangs forever and the
        // engine's Asyncify suspension never resumes (observed as the
        // idle freeze on device)
        transaction.onabort = function () { reject(transaction.error || new Error("IndexedDB 事务已中止")); };
      }
    });
  }
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) { return; }
        settled = true;
        reject(new Error(label + " timed out after " + ms + "ms"));
      }, ms);
      promise.then(function (value) {
        if (settled) { return; }
        settled = true; clearTimeout(timer); resolve(value);
      }, function (error) {
        if (settled) { return; }
        settled = true; clearTimeout(timer); reject(error);
      });
    });
  }
  // single persistent connection: reopening IndexedDB per chunk read caused
  // rapid open/close cycles that can hang the open request in WebView
  var sharedDatabase = null;
  async function getDatabase() {
    if (sharedDatabase) { return sharedDatabase; }
    sharedDatabase = await withTimeout(openDatabase(), 20000, "IndexedDB open");
    sharedDatabase.onversionchange = function () {
      sharedDatabase.close(); sharedDatabase = null;
    };
    return sharedDatabase;
  }
  var pendingTrace = null;
  function traceStart(op, detail) {
    pendingTrace = { op: op, detail: detail || "", startedAt: Date.now() };
    // krkr2web: publish unconditionally. The old `!== undefined` guard was
    // dead code (nothing pre-declared the property), so a storage read that
    // hung never showed up in the player's stall-detector pending text.
    globalThis.krkr2webStorageTrace = pendingTrace;
  }
  function traceEnd() { pendingTrace = null; globalThis.krkr2webStorageTrace = null; }

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
      request.onerror = function () { reject(request.error || new Error("无法打开本机资源数据库")); };
      request.onblocked = function () { reject(new Error("本机资源数据库被其他页面占用，请关闭其他打开的页面后重试")); };
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
    while (cacheBytes > CACHE_LIMIT_BYTES && cache.size > 1) {
      var oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).byteLength;
      cache.delete(oldest);
    }
    metrics.maximumCacheBytes = Math.max(metrics.maximumCacheBytes, cacheBytes);
  }

  async function loadChunkRange(pkg, firstChunk, lastChunk) {
    var result = [];
    var missing = [];
    for (var chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
      var key = cacheKey(pkg, chunkIndex);
      if (cache.has(key)) {
        var cached = cache.get(key);
        cache.delete(key);
        cache.set(key, cached);
        metrics.cacheHits += 1;
        result[chunkIndex - firstChunk] = cached;
      } else {
        metrics.cacheMisses += 1;
        missing.push(chunkIndex);
      }
    }
    if (missing.length === 0) { return result; }

    traceStart("loadChunkRange", pkg.id + ":" + firstChunk + "-" + lastChunk);
    var database = await getDatabase();
    try {
      var transaction = database.transaction("chunks", "readonly");
      var store = transaction.objectStore("chunks");
      var requests = missing.map(function (index) {
        return requestResult(store.get([state.gameId, state.version, pkg.id, index]));
      });
      var chunks = await withTimeout(Promise.all(requests), 20000,
        "IndexedDB chunk range " + pkg.id + ":" + firstChunk + "-" + lastChunk);
      chunks.forEach(function (chunk, index) {
        var actualIndex = missing[index];
        if (!(chunk instanceof ArrayBuffer)) { return; }
        metrics.indexedDbBytes += chunk.byteLength;
        putCache(cacheKey(pkg, actualIndex), chunk);
        result[actualIndex - firstChunk] = chunk;
      });
      return result;
    } finally {
      traceEnd();
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

  function allChunksCached(pkg, firstChunk, lastChunk) {
    for (var chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
      if (!cache.has(cacheKey(pkg, chunkIndex))) { return false; }
    }
    return true;
  }

  // krkr2web: cache-bypassing twin of loadChunkRange. Same single-transaction
  // IndexedDB fetch, but the returned chunks neither populate the LRU nor
  // touch recency of existing entries, so a large streaming read cannot
  // evict or reorder the hot small-file chunks.
  async function loadChunkRangeDirect(pkg, firstChunk, lastChunk) {
    var result = [];
    traceStart("loadChunkRangeDirect", pkg.id + ":" + firstChunk + "-" + lastChunk);
    var database = await getDatabase();
    try {
      var transaction = database.transaction("chunks", "readonly");
      var store = transaction.objectStore("chunks");
      var requests = [];
      for (var chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
        requests.push(requestResult(store.get([state.gameId, state.version, pkg.id, chunkIndex])));
      }
      var chunks = await withTimeout(Promise.all(requests), 20000,
        "IndexedDB chunk range " + pkg.id + ":" + firstChunk + "-" + lastChunk);
      chunks.forEach(function (chunk, index) {
        if (chunk instanceof ArrayBuffer) {
          metrics.indexedDbBytes += chunk.byteLength;
          result[index] = chunk;
        }
      });
      return result;
    } finally {
      traceEnd();
    }
  }

  async function prepare(gameId) {
    var database = await getDatabase();
    try {
      if (!database.objectStoreNames.contains("installs") ||
          !database.objectStoreNames.contains("manifests") ||
          !database.objectStoreNames.contains("chunks")) {
        throw new Error("本机资源数据库不完整，请返回游戏库重新校验或重新下载");
      }
      var install = await requestResult(database.transaction("installs", "readonly").objectStore("installs").get(gameId));
      if (!install || install.status !== "ready" || install.complete !== true || !install.activeVersion) {
        throw new Error("游戏资源尚未完整安装，请先完成下载");
      }
      var record = await requestResult(database.transaction("manifests", "readonly").objectStore("manifests").get([
        gameId, install.activeVersion
      ]));
      var manifest = record && record.value;
      if (!manifest || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
        throw new Error("已安装游戏的资源清单缺失，请返回游戏库重新校验");
      }
      state = { gameId: gameId, version: install.activeVersion, install: install, manifest: manifest };
      return state;
    } catch (error) {
      sharedDatabase.close(); sharedDatabase = null;
      throw error;
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
      if (remaining === 0) { return 0; }
      var firstChunk = Math.floor(currentOffset / pkg.chunkSize);
      var lastChunk = Math.floor((currentOffset + remaining - 1) / pkg.chunkSize);
      // Fetch one logical engine read in one IndexedDB transaction. Large XP3
      // entries otherwise pay a transaction round-trip for every 4 MiB chunk.
      var chunks;
      if (length >= DIRECT_READ_THRESHOLD && !allChunksCached(pkg, firstChunk, lastChunk)) {
        metrics.directReads += 1;
        metrics.directBytes += length;
        chunks = await loadChunkRangeDirect(pkg, firstChunk, lastChunk);
      } else {
        chunks = await loadChunkRange(pkg, firstChunk, lastChunk);
      }
      while (remaining > 0) {
        var chunkIndex = Math.floor(currentOffset / pkg.chunkSize);
        var inChunk = currentOffset - chunkIndex * pkg.chunkSize;
        var chunk = chunks[chunkIndex - firstChunk];
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

  // krkr2web: page-side range reads for the prefetch pipeline. The engine's
  // own readToHeap needs a wasm destination; prefetch works on plain JS
  // buffers so predicted files can be pulled out of IndexedDB while the
  // engine keeps running. Both share the same chunk LRU, so a prefetched
  // range turns the engine's later read into a pure cache hit.
  async function readRange(packagePath, offset, length) {
    var pkg = packageForPath(packagePath);
    if (!pkg || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length <= 0 ||
        length > MAX_READ_BYTES || offset > pkg.size) {
      return null;
    }
    length = Math.min(length, pkg.size - offset);
    if (length <= 0) { return null; }
    metrics.prefetchReads += 1;
    metrics.prefetchBytes += length;
    var firstChunk = Math.floor(offset / pkg.chunkSize);
    var lastChunk = Math.floor((offset + length - 1) / pkg.chunkSize);
    try {
      var chunks = await loadChunkRange(pkg, firstChunk, lastChunk);
      var out = new Uint8Array(length);
      var remaining = length;
      var currentOffset = offset;
      var writeOffset = 0;
      while (remaining > 0) {
        var chunkIndex = Math.floor(currentOffset / pkg.chunkSize);
        var inChunk = currentOffset - chunkIndex * pkg.chunkSize;
        var chunk = chunks[chunkIndex - firstChunk];
        if (!chunk) { return null; }
        var available = Math.min(remaining, chunk.byteLength - inChunk);
        if (available <= 0) { return null; }
        out.set(new Uint8Array(chunk, inChunk, available), writeOffset);
        remaining -= available;
        currentOffset += available;
        writeOffset += available;
      }
      return out;
    } catch (error) {
      metrics.errors.push({ message: error && error.message ? error.message : String(error), at: new Date().toISOString() });
      return null;
    }
  }

  function prefetchRange(packagePath, offset, length) {
    return readRange(packagePath, offset, length).then(function (value) { return value; });
  }

  function releaseAll() {
    handles = {};
    if (sharedDatabase) { try { sharedDatabase.close(); } catch (error) {} sharedDatabase = null; }
  }

  function snapshot() {
    return {
      gameId: state && state.gameId, version: state && state.version,
      packages: state ? state.manifest.packages.map(function (pkg) {
        return { id: pkg.id, virtualPath: pkg.virtualPath, size: pkg.size };
      }) : [],
      cacheBytes: cacheBytes, cacheEntries: cache.size,
      cacheLimitBytes: CACHE_LIMIT_BYTES,
      metrics: JSON.parse(JSON.stringify(metrics))
    };
  }

  window.krkr2StorageBridge = {
    prepare: prepare, open: open, exists: exists, size: size,
    readToHeap: readToHeap, close: close, releaseAll: releaseAll, snapshot: snapshot,
    readRange: readRange, prefetchRange: prefetchRange
  };
}());
