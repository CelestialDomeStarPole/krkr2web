(function () {
  "use strict";

  // krkr2web click-next prefetch pipeline (page side).
  //
  // The engine is a single-threaded Wasm module: on a click-to-next it opens
  // the next voice (.ogg) and any changed sprite/background files from the
  // XP3 archive, inflates their segments and (for WebP images) decodes them
  // on the main thread. Each of those steps stalls the page, and the OpenAL
  // scheduler (a 25ms main-thread interval with a 100ms lookahead) drops
  // audio whenever a stall exceeds the lookahead.
  //
  // This module removes the click-path work instead of making it faster:
  //
  //  - a persistent inflate worker pool (krkr2webInflatePool) replaces the
  //    per-segment worker spawn the engine used to pay for every segment;
  //  - a segment park holds pre-inflated segments for files the engine
  //    predicted (numeric successor of the last opened storage), so a
  //    predicted voice open costs one memcpy instead of an IndexedDB read
  //    plus an inflate;
  //  - an image park holds BGRA already decoded by the browser's native
  //    WebP decoder inside a dedicated worker (createImageBitmap), so the
  //    engine's graphic loader can fill the layer with a single copy;
  //  - the same native decoder serves unpredictable first-seen images: the
  //    engine hands the compressed bytes over (Asyncify suspension), the
  //    browser decodes on its own thread pool and the main thread only pays
  //    the final memcpy (~2ms) - audio scheduling never starves.
  //
  // Everything is generic KRKR behavior: prediction is trailing-digit +1 on
  // whatever storage the engine opens (voices, numbered CGs, scenarios), and
  // the parks are keyed by content address (archive/index), never by game.

  // Runs on the page (baseline engine on the main thread) and inside the
  // dedicated engine worker (worker variant loads it via importScripts right
  // after the storage bridge), so every global must attach to self/window
  // generically and nothing may touch `document` unconditionally.
  var globalScope = (typeof window !== "undefined") ? window : self;
  var storageBridge = globalScope.krkr2StorageBridge;
  var deviceMemory = Number(navigator.deviceMemory || 0);
  var lowMemory = deviceMemory > 0 && deviceMemory <= 2;
  var cores = Number(navigator.hardwareConcurrency || 4);
  var INFLATE_WORKERS = Math.max(2, Math.min(4, cores - 2 || 2));
  var IMAGE_PARK_BYTES = lowMemory ? 24 * 1024 * 1024 : 48 * 1024 * 1024;
  var SEGMENT_PARK_BYTES = lowMemory ? 12 * 1024 * 1024 : 24 * 1024 * 1024;
  var PREFETCH_CONCURRENCY = 2;
  var PREFETCH_TIMEOUT_MS = 20000;

  var recentNames = [];
  var metrics = {
    notifyOpens: 0,
    predictedOpens: 0,
    prefetchedFiles: 0,
    segmentParkPuts: 0,
    segmentParkHits: 0,
    segmentParkBytes: 0,
    imageParkPuts: 0,
    imageParkHits: 0,
    nativeDecodes: 0,
    mainDecodes: 0,
    decodeFailures: 0,
    wasmFallbacks: 0,
    poolInflates: 0,
    errors: []
  };

  function noteError(where, error) {
    var text = where + ": " + (error && error.message ? error.message : String(error));
    if (metrics.errors.length < 12) { metrics.errors.push(text); }
  }

  // ---- persistent inflate pool ------------------------------------------
  // The engine's XP3 inflate (patch 0006) used to spawn and terminate a
  // worker for every segment. A warm pool removes the spawn cost and lets
  // prefetch inflates run in parallel with the engine's own suspensions.

  var INFLATE_WORKER_SRC = [
    "self.onmessage = function (event) {",
    "  var job = event.data;",
    "  function fail(error) {",
    "    self.postMessage({ id: job.id, error: String(error && error.message ? error.message : error) });",
    "  }",
    "  try {",
    "    if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream unavailable');",
    "    var stream = new Blob([job.bytes]).stream().pipeThrough(new DecompressionStream('deflate'));",
    "    new Response(stream).arrayBuffer().then(function (output) {",
    "      self.postMessage({ id: job.id, output: output }, [output]);",
    "    }, fail);",
    "  } catch (error) { fail(error); }",
    "};"
  ].join("\n");

  function InflatePool(limit) {
    var workers = [];
    var idle = [];
    var waiting = [];
    var jobs = Object.create(null);
    var seq = 0;
    var dead = false;

    function spawn() {
      try {
        var url = URL.createObjectURL(new Blob([INFLATE_WORKER_SRC], { type: "text/javascript" }));
        try {
          var worker = new Worker(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        worker.onmessage = function (event) { settle(event.data); };
        worker.onerror = function (event) {
          var message = event && event.message ? event.message : "inflate worker error";
          for (var id in jobs) {
            if (jobs[id] && jobs[id].worker === worker) {
              settle({ id: Number(id), error: message });
            }
          }
        };
        workers.push(worker);
        return worker;
      } catch (error) {
        dead = true;
        noteError("inflate-pool-spawn", error);
        return null;
      }
    }

    function settle(result) {
      var job = jobs[result.id];
      if (!job) { return; }
      delete jobs[result.id];
      if (result.error) {
        job.reject(new Error(result.error));
      } else {
        job.resolve(result.output);
      }
      if (job.worker) {
        idle.push(job.worker);
        pump();
      }
    }

    function dispatch(worker, id, bytes) {
      var job = jobs[id];
      job.worker = worker;
      // structured clone copies the view's bytes; the wasm heap is never transferred
      worker.postMessage({ id: id, bytes: bytes });
    }

    function pump() {
      while (waiting.length > 0 && idle.length > 0) {
        var next = waiting.shift();
        if (!jobs[next]) { continue; }
        dispatch(idle.shift(), next, jobs[next].bytes);
        jobs[next].bytes = null;
      }
    }

    this.inflate = function (bytes) {
      if (dead) { return Promise.reject(new Error("inflate pool unavailable")); }
      metrics.poolInflates += 1;
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        var timer = setTimeout(function () {
          settle({ id: id, error: "inflate timeout after " + PREFETCH_TIMEOUT_MS + " ms" });
        }, PREFETCH_TIMEOUT_MS);
        jobs[id] = {
          bytes: bytes,
          resolve: function (value) { clearTimeout(timer); resolve(value); },
          reject: function (error) { clearTimeout(timer); reject(error); }
        };
        var worker = idle.shift();
        if (!worker && workers.length < limit) { worker = spawn(); }
        if (worker) {
          dispatch(worker, id, bytes);
          jobs[id].bytes = null;
        } else {
          waiting.push(id);
        }
      });
    };

    this.terminate = function () {
      dead = true;
      workers.forEach(function (worker) { worker.terminate(); });
      workers = []; idle = []; waiting = [];
      for (var id in jobs) {
        if (jobs[id]) { jobs[id].reject(new Error("inflate pool terminated")); }
      }
      jobs = Object.create(null);
    };
  }

  var inflatePool = new InflatePool(INFLATE_WORKERS);
  globalScope.krkr2webInflatePool = inflatePool;

  // ---- LRU parks ---------------------------------------------------------
  // Both parks map keys to Uint8Array payloads with a total-bytes cap.

  function BytePark(capacity, label) {
    var entries = new Map();
    var bytes = 0;

    function evict() {
      while (bytes > capacity && entries.size > 0) {
        var oldest = entries.keys().next().value;
        var entry = entries.get(oldest);
        entries.delete(oldest);
        bytes -= entry.payload.length;
      }
    }

    this.put = function (key, payload) {
      if (!payload || payload.length > capacity) { return; }
      if (entries.has(key)) {
        bytes -= entries.get(key).payload.length;
      }
      entries.set(key, { payload: payload });
      bytes += payload.length;
      evict();
    };

    this.get = function (key) {
      var entry = entries.get(key);
      if (!entry) { return null; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.payload;
    };

    this.has = function (key) { return entries.has(key); };
    this.drop = function (key) {
      var entry = entries.get(key);
      if (!entry) { return false; }
      entries.delete(key);
      bytes -= entry.payload.length;
      return true;
    };
    this.clear = function () {
      entries.clear();
      bytes = 0;
    };
    this.stats = function () {
      return { entries: entries.size, bytes: bytes, capacity: capacity, label: label };
    };
  }

  var segmentPark = new BytePark(SEGMENT_PARK_BYTES, "segment");
  var imagePixels = new BytePark(IMAGE_PARK_BYTES, "image");
  var imageMeta = new Map();  // name -> {w,h}; cleared together with imagePixels

  function segmentKey(archive, storageIndex, segmentIndex) {
    return archive + "|" + storageIndex + "|" + segmentIndex;
  }

  // The engine reports archive names in virtual-URL form ("file://./data.xp3");
  // the page storage bridge's packageForPath matches the bare virtual path
  // ("data.xp3"). Strip the URL decoration once, here, so both the readRange
  // calls and the segment park keys agree (the engine's peekSegment passes
  // the same raw name through the same normalization).
  function normalizeArchive(name) {
    return String(name || "").toLowerCase().replace(/^file:\/\//, "").replace(/^\.\//, "");
  }

  // The graphic loader probes the image park with full in-archive storage
  // names ("file://./data.xp3>dir/pfbg0004.png") while predictions park under
  // the bare archive entry name ("dir/pfbg0004.png"); strip the archive part.
  function bareName(name) {
    var text = String(name || "").toLowerCase();
    var separator = text.lastIndexOf(">");
    return separator >= 0 ? text.slice(separator + 1) : text;
  }

  var imagePark = {
    put: function (name, info) {
      imagePixels.put(name, info.rgba);
      imageMeta.set(name, { w: info.w, h: info.h });
      metrics.imageParkPuts += 1;
    },
    probe: function (name) {
      var meta = imageMeta.get(bareName(name));
      if (!meta) { return null; }
      if (!imagePixels.has(bareName(name))) {
        imageMeta.delete(bareName(name));
        return null;
      }
      metrics.imageParkHits += 1;
      return meta;
    },
    // returns the parked pixel array or null (used from engine EM_ASM code
    // that performs the actual HEAPU8 copy in module scope)
    read: function (name) { return imagePixels.get(bareName(name)); },
    has: function (name) { return imagePixels.has(bareName(name)); }
  };
  globalScope.krkr2webImagePark = imagePark;

  // ---- native WebP decode worker -----------------------------------------
  // createImageBitmap decodes on the browser's internal thread pool, so the
  // page's main thread (and the suspended engine's audio scheduling) stays
  // responsive. Readback prefers WebGL with premultipliedAlpha:false for
  // pixel-exact straight alpha, falling back to 2D getImageData (at most a
  // +-1 rounding difference on semi-transparent edge pixels).

  var DECODE_WORKER_SRC = [
    "self.onmessage = async function (event) {",
    "  var job = event.data;",
    "  try {",
    "    if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unavailable');",
    "    var bmp = await createImageBitmap(new Blob([job.bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });",
    "    var w = bmp.width, h = bmp.height;",
    "    if (w <= 0 || h <= 0 || w * h * 4 > 64 * 1024 * 1024) throw new Error('unsupported bitmap size');",
    "    if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas unavailable');",
    "    var canvas = new OffscreenCanvas(w, h);",
    "    var rgba = null, flip = false;",
    "    try {",
    "      var gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false, alpha: true });",
    "      if (gl) {",
    "        var tex = gl.createTexture();",
    "        gl.bindTexture(gl.TEXTURE_2D, tex);",
    "        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);",
    "        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);",
    "        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);",
    "        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);",
    "        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);",
    "        var fb = gl.createFramebuffer();",
    "        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);",
    "        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);",
    "        rgba = new Uint8Array(w * h * 4);",
    "        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);",
    "        flip = true;",
    "      }",
    "    } catch (glError) { rgba = null; }",
    "    if (!rgba) {",
    "      var ctx = canvas.getContext('2d', { willReadFrequently: true });",
    "      if (!ctx) throw new Error('no canvas context');",
    "      ctx.drawImage(bmp, 0, 0);",
    "      rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data);",
    "    }",
    "    if (bmp.close) bmp.close();",
    "    if (flip) {",
    "      var row = w * 4, half = h >> 1;",
    "      for (var y = 0; y < half; y++) {",
    "        var top = y * row, bottom = (h - 1 - y) * row;",
    "        for (var x = 0; x < row; x++) {",
    "          var t = rgba[top + x]; rgba[top + x] = rgba[bottom + x]; rgba[bottom + x] = t;",
    "        }",
    "      }",
    "    }",
    "    if (job.bgra) {",
    "      var u32 = new Uint32Array(rgba.buffer);",
    "      for (var i = 0; i < u32.length; i++) {",
    "        var p = u32[i];",
    "        u32[i] = ((p & 0xff000000) | ((p & 0xff) << 16) | (p & 0xff00) | ((p & 0xff0000) >>> 16)) >>> 0;",
    "      }",
    "    }",
    "    var out = new Uint8Array(rgba.length);",
    "    out.set(rgba);",
    "    self.postMessage({ id: job.id, w: w, h: h, rgba: out.buffer }, [out.buffer]);",
    "  } catch (error) {",
    "    self.postMessage({ id: job.id, error: String(error && error.message ? error.message : String(error)) });",
    "  }",
    "};"
  ].join("\n");

  function ImageDecoder() {
    var worker = null;
    var workerBroken = false;
    var jobs = Object.create(null);
    var seq = 0;
    var self = this;
    // one-shot slot between the engine's async decode request and its
    // synchronous copy phase (see Krkr2WebDecodeOffThread in LoadWEBP.cpp)
    this.pending = null;

    function markWorkerBroken() {
      // TBS WebView (Chrome 89 kernel) has no OffscreenCanvas inside
      // workers, so the worker decode path throws on every job; hosts that
      // block blob workers fail at spawn. Either way the page must stop
      // posting to the dead worker and let decode() fall back to
      // decodeOnMain (baseline runtime) - posting to a worker that always
      // rejects left every image on the 40-100ms wasm main-thread decode
      // (field report: decodeFailures 281, nativeDecodes 0).
      workerBroken = true;
      var dead = worker;
      worker = null;
      if (dead) {
        try { dead.terminate(); } catch (ignored) {}
      }
      for (var id in jobs) {
        var job = jobs[id];
        delete jobs[id];
        clearTimeout(job.timer);
        job.reject(new Error("decode worker unavailable"));
      }
    }

    function ensureWorker() {
      if (workerBroken) { return null; }
      if (worker) { return worker; }
      try {
        var url = URL.createObjectURL(new Blob([DECODE_WORKER_SRC], { type: "text/javascript" }));
        try {
          worker = new Worker(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        worker.onmessage = function (event) {
          var data = event.data;
          var job = jobs[data.id];
          if (!job) { return; }
          delete jobs[data.id];
          clearTimeout(job.timer);
          if (data.error) {
            if (/OffscreenCanvas|createImageBitmap/.test(data.error)) { markWorkerBroken(); }
            job.reject(new Error(data.error));
          } else {
            job.resolve({ w: data.w, h: data.h, rgba: new Uint8Array(data.rgba) });
          }
        };
        worker.onerror = function (event) {
          var message = event && event.message ? event.message : "decode worker error";
          markWorkerBroken();
          noteError("decode-worker-error", new Error(message));
        };
      } catch (error) {
        workerBroken = true;
        noteError("decode-worker-spawn", error);
      }
      return worker;
    }

    function decodeOnMain(bytes, bgra) {
      // last resort: still async (the browser decodes off-thread); only the
      // readback runs on the calling thread. Unavailable inside the engine
      // worker (no DOM) - callers fall back to the engine's wasm decoder.
      if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
        return Promise.reject(new Error("no DOM fallback decoder"));
      }
      return createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none", premultiplyAlpha: "none" })
        .then(function (bmp) {
          var w = bmp.width, h = bmp.height;
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(bmp, 0, 0);
          if (bmp.close) { bmp.close(); }
          var rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data);
          if (bgra) {
            var u32 = new Uint32Array(rgba.buffer);
            for (var i = 0; i < u32.length; i++) {
              var p = u32[i];
              u32[i] = ((p & 0xff000000) | ((p & 0xff) << 16) | (p & 0xff00) | ((p & 0xff0000) >>> 16)) >>> 0;
            }
          }
          return { w: w, h: h, rgba: rgba };
        });
    }

    this.decode = function (name, bytes, bgra) {
      var active = ensureWorker();
      var self = this;
      if (!active) {
        if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
          return Promise.resolve(null);
        }
        return decodeOnMain(bytes, bgra).then(function (info) {
          metrics.mainDecodes += 1;
          return info;
        }).catch(function () { return null; });
      }
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        var timer = setTimeout(function () {
          delete jobs[id];
          reject(new Error("decode timeout after " + PREFETCH_TIMEOUT_MS + " ms"));
        }, PREFETCH_TIMEOUT_MS);
        jobs[id] = {
          timer: timer,
          resolve: function (info) { metrics.nativeDecodes += 1; resolve(info); },
          reject: function (error) { metrics.decodeFailures += 1; reject(error); }
        };
        active.postMessage({ id: id, bytes: bytes, bgra: !!bgra });
      });
    };
  }

  var imageDecoder = new ImageDecoder();
  globalScope.krkr2webImageDecoder = imageDecoder;

  // ---- prefetch orchestration --------------------------------------------

  var generation = 0;
  var inflight = Object.create(null);
  var activeJobs = 0;
  var pendingJobs = [];

  function enqueue(job) {
    pendingJobs.push(job);
    pumpJobs();
  }

  function pumpJobs() {
    while (activeJobs < PREFETCH_CONCURRENCY && pendingJobs.length > 0) {
      var job = pendingJobs.shift();
      activeJobs += 1;
      job().then(finish, finish);
      function finish() {
        activeJobs -= 1;
        pumpJobs();
      }
    }
  }

  function isWebp(bytes) {
    return bytes && bytes.length > 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }

  async function prefetchFile(archive, name, storageIndex, segments) {
    var myGeneration = generation;
    try {
      var contiguous = true;
      for (var i = 1; i < segments.length; i += 1) {
        if (segments[i - 1].start + segments[i - 1].arc !== segments[i].start) {
          contiguous = false;
          break;
        }
      }
      var start = -1;
      var total = 0;
      for (var i = 0; i < segments.length; i += 1) {
        if (start < 0) { start = segments[i].start; }
        total += segments[i].arc;
      }
      if (start < 0 || total <= 0 || total > 12 * 1024 * 1024) { return; }
      var raw = contiguous
        ? await storageBridge.readRange(archive, start, total)
        : null;
      if (myGeneration !== generation) { return; }
      if (raw && raw.length < total) { raw = null; }
      var offset = 0;
      var firstSegment = null;
      for (var s = 0; s < segments.length; s += 1) {
        var segment = segments[s];
        var view = raw
          ? raw.subarray(offset, offset + segment.arc)
          : null;
        offset += segment.arc;
        if (!view) {
          view = await storageBridge.readRange(archive, segment.start, segment.arc);
          if (myGeneration !== generation) { return; }
          if (!view || view.length < segment.arc) { return; }
        }
        var payload = null;
        if (segment.comp) {
          var inflated = await inflatePool.inflate(view);
          if (myGeneration !== generation) { return; }
          payload = new Uint8Array(inflated);
          metrics.segmentParkPuts += 1;
        } else {
          payload = view.slice();
          metrics.segmentParkPuts += 1;
        }
        segmentPark.put(segmentKey(archive, storageIndex, s), payload);
        if (s === 0) { firstSegment = payload; }
      }
      if (segments.length === 1 && firstSegment && isWebp(firstSegment)) {
        var info = await imageDecoder.decode(name, firstSegment, true);
        if (myGeneration !== generation) { return; }
        if (info && info.rgba && info.rgba.length === info.w * info.h * 4) {
          imagePark.put(name, info);
          metrics.nativeDecodes += 1;
        }
      }
      metrics.prefetchedFiles += 1;
    } catch (error) {
      noteError("prefetch " + name, error);
    }
  }

  globalScope.krkr2webPrefetch = {
    // the worker runtime imports this file after the storage bridge, but a
    // page-level import may have run before any bridge existed; allow late
    // rebinding so readRange always hits the live bridge
    bindStorage: function (bridge) {
      if (bridge && typeof bridge.readRange === "function") { storageBridge = bridge; }
    },
    notifyOpen: function (archiveName, fileName, storageIndex, isPrediction, segments) {
      metrics.notifyOpens += 1;
      var archive = normalizeArchive(archiveName);
      var name = String(fileName || "").toLowerCase();
      if (recentNames.length > 60) { recentNames.shift(); }
      recentNames.push((isPrediction ? "+" : "") + archive + ">" + name);
      if (!archive || !name || !segments || segments.length === 0) { return; }
      if (!isPrediction) {
        // The engine is opening this storage for real. Do NOT clear its
        // park entries here: the archive stream is created before the first
        // segment read, so clearing now would guarantee the EnsureSegment
        // park lookup misses. peekSegment hands each entry over (and frees
        // it) exactly when the engine consumes it.
        return;
      }
      metrics.predictedOpens += 1;
      if (imagePark.has(name)) { return; }
      var anySegment = false;
      for (var i = 0; i < segments.length && i < 64; i += 1) {
        if (segmentPark.has(segmentKey(archive, storageIndex, i))) { anySegment = true; break; }
      }
      if (anySegment || inflight[name]) { return; }
      inflight[name] = true;
      enqueue(function () {
        return prefetchFile(archive, name, storageIndex, segments).then(function () {
          delete inflight[name];
        }, function () {
          delete inflight[name];
        });
      });
    },
    // synchronous segment lookup from the engine's EnsureSegment miss path
    peekSegment: function (archive, storageIndex, segmentIndex) {
      var key = segmentKey(normalizeArchive(archive), storageIndex, segmentIndex);
      var payload = segmentPark.get(key);
      if (payload) {
        // handed over to the engine-side cache; free the page-side copy
        segmentPark.drop(key);
        metrics.segmentParkHits += 1;
        metrics.segmentParkBytes += payload.length;
      }
      return payload;
    },
    cancelAll: function () {
      generation += 1;
      pendingJobs = [];
      inflight = Object.create(null);
    },
    clearParks: function () {
      segmentPark.clear();
      imagePixels.clear();
      imageMeta.clear();
    },
    snapshot: function () {
      return {
        workers: INFLATE_WORKERS,
        parks: [segmentPark.stats(), imagePixels.stats()],
        metrics: JSON.parse(JSON.stringify(metrics)),
        recentNames: recentNames.slice(-30)
      };
    }
  };
}());
