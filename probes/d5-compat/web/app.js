(function () {
  "use strict";

  var CHUNK_SIZE = 4 * 1024 * 1024;
  var CACHE_LIMIT = 4;
  var PROFILE_ID = "senren-banka-v1";
  var CONTENT_ROOT = "/games/senren-banka/content-ebe5177821a6917c7a80/";
  var packages = {
    "data.xp3": { path: "data.xp3", size: 2312777571 },
    "adult.xp3": { path: "adult.xp3", size: 306995899 },
    "video.xp3": { path: "video.xp3", size: 1424495513 }
  };
  var handles = {};
  var nextHandle = 1;
  var cache = new Map();
  var cacheBytes = 0;
  var networkBytes = 0;
  var readCalls = 0;
  var completedReads = 0;
  var lastRead = null;
  var lastReadAdler = null;
  var moduleInstance = null;
  var firstError = null;
  var logLines = [];
  var elements = {
    start: document.getElementById("start"),
    canvas: document.getElementById("canvas"),
    status: document.getElementById("status"),
    bytes: document.getElementById("bytes"),
    cache: document.getElementById("cache"),
    memory: document.getElementById("memory"),
    read: document.getElementById("read"),
    error: document.getElementById("error"),
    log: document.getElementById("log")
  };

  function formatBytes(value) {
    if (value >= 1024 * 1024 * 1024) { return (value / (1024 * 1024 * 1024)).toFixed(2) + " GiB"; }
    if (value >= 1024 * 1024) { return (value / (1024 * 1024)).toFixed(2) + " MiB"; }
    if (value >= 1024) { return (value / 1024).toFixed(2) + " KiB"; }
    return value + " B";
  }

  function normalize(path) {
    return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  }

  function render() {
    elements.bytes.textContent = formatBytes(networkBytes);
    elements.cache.textContent = cache.size + " / " + CACHE_LIMIT + " · " + formatBytes(cacheBytes);
    elements.memory.textContent = moduleInstance && moduleInstance.HEAPU8 ? formatBytes(moduleInstance.HEAPU8.buffer.byteLength) : "--";
    elements.read.textContent = lastRead ? (lastRead.path + " @" + lastRead.offset + " +" + lastRead.length + " · " + completedReads + "/" + readCalls) : "--";
    elements.error.textContent = firstError || "无";
    elements.log.textContent = logLines.slice(-100).join("\n");
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function log(message, isError) {
    var line = String(message);
    logLines.push((isError ? "ERR " : "") + line);
    if (isError && !firstError) { firstError = line; }
    if (logLines.length > 2000) { logLines.shift(); }
    render();
  }

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
  }

  function adler32(bytes) {
    var first = 1;
    var second = 0;
    var offset = 0;
    while (offset < bytes.length) {
      var end = Math.min(bytes.length, offset + 5552);
      while (offset < end) {
        first += bytes[offset++];
        second += first;
      }
      first %= 65521;
      second %= 65521;
    }
    return ((second << 16) | first) >>> 0;
  }

  async function loadChunk(pkg, chunkIndex) {
    var key = pkg.path + ":" + chunkIndex;
    if (cache.has(key)) {
      var cached = cache.get(key);
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    var start = chunkIndex * CHUNK_SIZE;
    var end = Math.min(pkg.size, start + CHUNK_SIZE) - 1;
    var response = await fetch(CONTENT_ROOT + pkg.path, {
      cache: "no-store",
      headers: { "Range": "bytes=" + start + "-" + end }
    });
    if (response.status !== 206) { throw new Error(pkg.path + " Range HTTP " + response.status); }
    var buffer = await response.arrayBuffer();
    if (buffer.byteLength !== end - start + 1) { throw new Error(pkg.path + " Range 长度错误"); }
    networkBytes += buffer.byteLength;
    putCache(key, buffer);
    render();
    return buffer;
  }

  var storage = {
    open: function (path) {
      var pkg = packages[normalize(path)];
      if (!pkg) { return 0; }
      var handle = nextHandle++;
      handles[handle] = pkg;
      return handle;
    },
    exists: function (path) { return !!packages[normalize(path)]; },
    size: function (handle) { return handles[handle] ? handles[handle].size : -1; },
    close: function (handle) { delete handles[handle]; },
    readToHeap: async function (handle, offset, length, destination, heap) {
      var pkg = handles[handle];
      if (!pkg || offset < 0 || length < 0 || offset > pkg.size) { return -5; }
      var requestOffset = offset;
      var heapStart = destination;
      readCalls += 1;
      lastRead = { path: pkg.path, offset: offset, length: length };
      render();
      var remaining = Math.min(length, pkg.size - offset);
      var total = remaining;
      try {
        while (remaining > 0) {
          var chunkIndex = Math.floor(offset / CHUNK_SIZE);
          var inChunk = offset - chunkIndex * CHUNK_SIZE;
          var chunk = await loadChunk(pkg, chunkIndex);
          var available = Math.min(remaining, chunk.byteLength - inChunk);
          if (available <= 0) { return -5; }
          heap.set(new Uint8Array(chunk, inChunk, available), destination);
          offset += available;
          destination += available;
          remaining -= available;
        }
        if (pkg.path === "data.xp3" && requestOffset === 2311816778 && total === 960793) {
          lastReadAdler = adler32(heap.subarray(heapStart, heapStart + total));
          log("KRKR2WEB_D5_BRIDGE_ADLER32 " + lastReadAdler, false);
        }
        completedReads += 1;
        render();
        return total;
      } catch (error) {
        log(error && error.message ? error.message : String(error), true);
        return -5;
      }
    }
  };

  function engineArguments(profile) {
    var args = ["/" + profile.entryPackage, "-datapath=/savedata/d5-compat/", "-krkr2web-profile=" + profile.id];
    profile.autoPathPackages.forEach(function (path) {
      args.push("-krkr2web-autopath=/" + path + ">");
    });
    return args.concat(profile.engineArguments);
  }

  async function start() {
    elements.start.disabled = true;
    elements.status.textContent = "正在读取 XP3 索引";
    var registry = window.krkr2EngineProfiles;
    var profile = registry && registry.profiles && registry.profiles[PROFILE_ID];
    if (!profile) { throw new Error("缺少 " + PROFILE_ID); }
    var options = {
      arguments: engineArguments(profile),
      canvas: elements.canvas,
      krkr2Storage: storage,
      noInitialRun: false,
      preRun: [function () {
        try { options.FS.mkdir("/savedata"); } catch (error) {}
        try { options.FS.mkdir("/savedata/d5-compat"); } catch (error) {}
      }],
      print: function (message) {
        log(message, false);
        if (String(message).indexOf("Startup script ended.") !== -1) {
          elements.status.textContent = "启动脚本已完成";
        }
      },
      printErr: function (message) { log(message, true); },
      onRuntimeInitialized: function () { elements.status.textContent = "正在执行真实启动脚本"; },
      onAbort: function (reason) {
        elements.status.textContent = "引擎已停止";
        log("Wasm abort: " + String(reason), true);
      }
    };
    window.Module = options;
    moduleInstance = await window.instantiate_krkrsdl2_module(options);
    render();
  }

  elements.start.addEventListener("click", function () {
    start().catch(function (error) {
      elements.status.textContent = "启动失败";
      log(error && error.stack ? error.stack : String(error), true);
    });
  });
  window.d5CompatState = function () {
    return { networkBytes: networkBytes, cacheBytes: cacheBytes, cacheEntries: cache.size, readCalls: readCalls, completedReads: completedReads, lastRead: lastRead, lastReadAdler: lastReadAdler, firstError: firstError, log: logLines.slice(-2000) };
  };
  render();
}());
