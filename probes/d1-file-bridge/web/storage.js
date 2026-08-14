(function () {
  "use strict";

  var DATABASE_NAME = "krkr2web-d1-probe";
  var DATABASE_VERSION = 1;
  var DATASET_VERSION = "d1-sparse-v1";
  var CHUNK_SIZE = 4 * 1024 * 1024;
  var LOGICAL_FILE_SIZE = 5 * 1024 * 1024 * 1024 + 12345;
  var CACHE_LIMIT = 4;
  var SEEDED_CHUNKS = [0, 1, 2, 511, 512, 513, 1023, 1024, 1025, 1279, 1280];
  var ERROR_RANGE = -1;
  var ERROR_CHUNK_MISSING = -2;
  var ERROR_STORAGE = -3;
  var ERROR_CANCELLED = -4;
  var ERROR_INVALID_HANDLE = -5;

  var database = null;
  var cache = new Map();
  var cacheBytes = 0;
  var maximumCacheBytes = 0;
  var readCalls = 0;
  var cacheHits = 0;
  var cacheMisses = 0;
  var indexedDbBytes = 0;
  var copiedBytes = 0;
  var failureMode = 0;
  var progressListener = null;
  var preparationListener = null;
  var backgroundListener = null;
  var backgroundHiddenMs = 0;

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB 请求失败")); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onabort = function () { reject(transaction.error || new Error("IndexedDB 事务中止")); };
      transaction.onerror = function () { reject(transaction.error || new Error("IndexedDB 事务失败")); };
    });
  }

  function openDatabase() {
    if (database) {
      return Promise.resolve(database);
    }
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks");
        }
        if (!db.objectStoreNames.contains("metadata")) {
          db.createObjectStore("metadata");
        }
      };
      request.onsuccess = function () {
        database = request.result;
        database.onversionchange = function () {
          database.close();
          database = null;
        };
        resolve(database);
      };
      request.onerror = function () {
        reject(request.error || new Error("无法打开 D1 IndexedDB"));
      };
      request.onblocked = function () {
        reject(new Error("D1 IndexedDB 被另一个页面占用"));
      };
    });
  }

  function getMetadata() {
    var transaction = database.transaction("metadata", "readonly");
    return requestResult(transaction.objectStore("metadata").get("dataset"));
  }

  function clearStores() {
    var transaction = database.transaction(["chunks", "metadata"], "readwrite");
    transaction.objectStore("chunks").clear();
    transaction.objectStore("metadata").clear();
    return transactionDone(transaction);
  }

  function chunkLength(chunkIndex) {
    var start = chunkIndex * CHUNK_SIZE;
    return Math.min(CHUNK_SIZE, LOGICAL_FILE_SIZE - start);
  }

  function createChunk(chunkIndex) {
    var length = chunkLength(chunkIndex);
    var bytes = new Uint8Array(length);
    var chunkTerm = chunkIndex * 29;
    for (var index = 0; index < length; index += 1) {
      bytes[index] = (chunkTerm + index * 17 + (index >>> 8) * 13) & 255;
    }
    return bytes.buffer;
  }

  function storeChunk(chunkIndex, buffer) {
    var transaction = database.transaction("chunks", "readwrite");
    transaction.objectStore("chunks").put(buffer, chunkIndex);
    return transactionDone(transaction);
  }

  function storeMetadata() {
    var transaction = database.transaction("metadata", "readwrite");
    transaction.objectStore("metadata").put({
      datasetVersion: DATASET_VERSION,
      chunkSize: CHUNK_SIZE,
      logicalFileSize: LOGICAL_FILE_SIZE,
      seededChunks: SEEDED_CHUNKS.slice(),
      createdAt: new Date().toISOString()
    }, "dataset");
    return transactionDone(transaction);
  }

  async function seedDataset() {
    await clearStores();
    for (var index = 0; index < SEEDED_CHUNKS.length; index += 1) {
      var chunkIndex = SEEDED_CHUNKS[index];
      if (preparationListener) {
        preparationListener(index, SEEDED_CHUNKS.length, chunkIndex);
      }
      var buffer = createChunk(chunkIndex);
      await storeChunk(chunkIndex, buffer);
      buffer = null;
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
    }
    await storeMetadata();
  }

  async function prepare() {
    await openDatabase();
    var metadata = await getMetadata();
    if (!metadata || metadata.datasetVersion !== DATASET_VERSION ||
        metadata.chunkSize !== CHUNK_SIZE || metadata.logicalFileSize !== LOGICAL_FILE_SIZE) {
      await seedDataset();
      return { reused: false, storedBytes: SEEDED_CHUNKS.length * CHUNK_SIZE - (CHUNK_SIZE - 12345) };
    }
    return { reused: true, storedBytes: SEEDED_CHUNKS.length * CHUNK_SIZE - (CHUNK_SIZE - 12345) };
  }

  function cacheChunk(chunkIndex, buffer) {
    if (cache.has(chunkIndex)) {
      cacheBytes -= cache.get(chunkIndex).byteLength;
      cache.delete(chunkIndex);
    }
    cache.set(chunkIndex, buffer);
    cacheBytes += buffer.byteLength;
    while (cache.size > CACHE_LIMIT) {
      var oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).byteLength;
      cache.delete(oldest);
    }
    maximumCacheBytes = Math.max(maximumCacheBytes, cacheBytes);
  }

  async function loadChunk(chunkIndex) {
    if (cache.has(chunkIndex)) {
      var cached = cache.get(chunkIndex);
      cache.delete(chunkIndex);
      cache.set(chunkIndex, cached);
      cacheHits += 1;
      return cached;
    }

    cacheMisses += 1;
    var transaction = database.transaction("chunks", "readonly");
    var buffer = await requestResult(transaction.objectStore("chunks").get(chunkIndex));
    if (!(buffer instanceof ArrayBuffer)) {
      return null;
    }
    indexedDbBytes += buffer.byteLength;
    cacheChunk(chunkIndex, buffer);
    return buffer;
  }

  async function readToHeap(handle, offset, requestedLength, destination, heap) {
    readCalls += 1;
    if (handle !== 1) {
      return ERROR_INVALID_HANDLE;
    }
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(requestedLength) || requestedLength < 0 ||
        requestedLength > 64 * 1024 || offset > LOGICAL_FILE_SIZE) {
      return ERROR_RANGE;
    }
    if (failureMode === 1) {
      failureMode = 0;
      return ERROR_STORAGE;
    }
    if (failureMode === 2) {
      failureMode = 0;
      return ERROR_CANCELLED;
    }

    var length = Math.min(requestedLength, LOGICAL_FILE_SIZE - offset);
    var remaining = length;
    var currentOffset = offset;
    var writeOffset = destination;
    try {
      while (remaining > 0) {
        var chunkIndex = Math.floor(currentOffset / CHUNK_SIZE);
        var inChunk = currentOffset - chunkIndex * CHUNK_SIZE;
        var buffer = await loadChunk(chunkIndex);
        if (!buffer) {
          return ERROR_CHUNK_MISSING;
        }
        var available = Math.min(remaining, buffer.byteLength - inChunk);
        if (available <= 0) {
          return ERROR_STORAGE;
        }
        heap.set(new Uint8Array(buffer, inChunk, available), writeOffset);
        copiedBytes += available;
        remaining -= available;
        currentOffset += available;
        writeOffset += available;
      }
      if ((readCalls % 50) === 0) {
        await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      }
      return length;
    } catch (error) {
      console.error("[d1-storage]", error);
      return ERROR_STORAGE;
    }
  }

  function resetMetrics() {
    cache.clear();
    cacheBytes = 0;
    maximumCacheBytes = 0;
    readCalls = 0;
    cacheHits = 0;
    cacheMisses = 0;
    indexedDbBytes = 0;
    copiedBytes = 0;
    failureMode = 0;
  }

  function metrics() {
    return {
      readCalls: readCalls,
      cacheHits: cacheHits,
      cacheMisses: cacheMisses,
      indexedDbBytes: indexedDbBytes,
      copiedBytes: copiedBytes,
      cacheBytes: cacheBytes,
      maximumCacheBytes: maximumCacheBytes,
      cacheEntries: cache.size,
      backgroundHiddenMs: backgroundHiddenMs,
      logicalFileSize: LOGICAL_FILE_SIZE,
      chunkSize: CHUNK_SIZE
    };
  }

  function waitForBackgroundResume() {
    backgroundHiddenMs = 0;
    return new Promise(function (resolve) {
      var hiddenAt = null;
      var localDebug = location.hostname === "127.0.0.1" || location.hostname === "localhost";
      var simulatedSeconds = Number(
        new URLSearchParams(location.search).get("simulateBackgroundSeconds")
      );

      function notify(stage, hiddenMs) {
        if (backgroundListener) {
          backgroundListener(stage, hiddenMs || 0);
        }
      }

      function onVisibilityChange() {
        if (document.visibilityState === "hidden") {
          hiddenAt = Date.now();
          notify("hidden", 0);
          return;
        }
        if (hiddenAt === null) {
          return;
        }
        var hiddenMs = Date.now() - hiddenAt;
        hiddenAt = null;
        if (hiddenMs < 10000) {
          notify("too-short", hiddenMs);
          return;
        }
        backgroundHiddenMs = hiddenMs;
        document.removeEventListener("visibilitychange", onVisibilityChange);
        notify("resumed", hiddenMs);
        resolve(1);
      }

      if (localDebug && Number.isFinite(simulatedSeconds) && simulatedSeconds >= 1) {
        notify("armed", 0);
        notify("hidden", 0);
        setTimeout(function () {
          backgroundHiddenMs = 10000;
          notify("resumed", backgroundHiddenMs);
          resolve(1);
        }, simulatedSeconds * 1000);
        return;
      }

      document.addEventListener("visibilitychange", onVisibilityChange);
      notify("armed", 0);
    });
  }

  window.d1StorageBridge = {
    prepare: prepare,
    readToHeap: readToHeap,
    resetMetrics: resetMetrics,
    metrics: metrics,
    waitForBackgroundResume: waitForBackgroundResume,
    setFailureMode: function (mode) { failureMode = mode; },
    reportProgress: function (completed, total) {
      if (progressListener) {
        progressListener(completed, total);
      }
    },
    onProgress: function (listener) { progressListener = listener; },
    onPreparation: function (listener) { preparationListener = listener; },
    onBackground: function (listener) { backgroundListener = listener; }
  };
}());
