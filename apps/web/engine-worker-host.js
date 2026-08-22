/* Main-thread host for the krkr2web Dedicated Worker runtime. */
(function (global) {
  "use strict";

  var CHANNEL = "krkr2web-engine-worker";
  var PROTOCOL_VERSION = 1;
  var nextSessionId = 1;

  function errorText(error) {
    return error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  }

  function capability() {
    if (typeof Worker !== "function") { return { supported: false, reason: "worker" }; }
    if (typeof OffscreenCanvas !== "function") { return { supported: false, reason: "offscreen-canvas" }; }
    if (typeof HTMLCanvasElement === "undefined" ||
        typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
      return { supported: false, reason: "canvas-transfer" };
    }
    if (typeof indexedDB === "undefined") { return { supported: false, reason: "indexeddb" }; }
    try {
      var probe = new OffscreenCanvas(1, 1);
      var context = probe.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false
      });
      if (!context) { return { supported: false, reason: "offscreen-webgl" }; }
      var loseContext = context.getExtension && context.getExtension("WEBGL_lose_context");
      if (loseContext) { loseContext.loseContext(); }
    } catch (error) {
      return { supported: false, reason: "offscreen-webgl" };
    }
    return { supported: true, reason: null };
  }

  function Krkr2EngineWorkerHost(options) {
    options = options || {};
    this.options = options;
    this.canvas = options.canvas || null;
    this.worker = null;
    this.offscreenCanvas = null;
    this.sessionId = 0;
    this.phase = "idle";
    this.started = false;
    this.terminated = false;
    this.gameId = null;
    this.lastHeartbeatAt = 0;
    this.lastMessageAt = 0;
    this.storageSnapshot = null;
    this.dependencies = 0;
    this.listeners = {};
    this.domListeners = [];
    this.pendingRequests = {};
    this.nextRequestId = 1;
    this.pendingMotion = null;
    this.motionFrame = 0;
    this.suppressMouseUntil = 0;
    this.startResolve = null;
    this.startReject = null;
    this.startTimer = 0;
    this.replacementCanvas = null;
    this.audioContext = options.audioContext || null;
    this.audioContextOwned = false;
    this.audioSources = {};
    this.audioStreamTime = 0;
    this.nextAudioChunkId = 1;
    this.activeVideoSerial = 0;
    this.completedVideoSerial = 0;
    this.boundMessage = this.handleWorkerMessage.bind(this);
    this.boundError = this.handleWorkerError.bind(this);
    this.boundMessageError = this.handleWorkerMessageError.bind(this);
  }

  Krkr2EngineWorkerHost.capability = capability;
  Krkr2EngineWorkerHost.isSupported = function () { return capability().supported; };

  Krkr2EngineWorkerHost.prototype.addEventListener = function (type, listener) {
    if (!listener) { return; }
    var list = this.listeners[type] || (this.listeners[type] = []);
    if (list.indexOf(listener) === -1) { list.push(listener); }
  };

  Krkr2EngineWorkerHost.prototype.removeEventListener = function (type, listener) {
    var list = this.listeners[type];
    if (!list) { return; }
    var index = list.indexOf(listener);
    if (index >= 0) { list.splice(index, 1); }
  };

  Krkr2EngineWorkerHost.prototype.emit = function (type, detail) {
    var list = (this.listeners[type] || []).slice();
    for (var index = 0; index < list.length; index += 1) {
      try { list[index]({ type: type, detail: detail, target: this }); }
      catch (error) { setTimeout(function () { throw error; }, 0); }
    }
    var callbackName = "on" + type.charAt(0).toUpperCase() + type.slice(1).replace(/-([a-z])/g, function (_, c) {
      return c.toUpperCase();
    });
    var callback = this.options[callbackName];
    if (typeof callback === "function") {
      try { callback(detail, this); }
      catch (error) { setTimeout(function () { throw error; }, 0); }
    }
  };

  Krkr2EngineWorkerHost.prototype.snapshot = function () {
    return {
      runtimeVariant: "dedicated-worker-baseline",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      gameId: this.gameId,
      phase: this.phase,
      started: this.started,
      terminated: this.terminated,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastMessageAt: this.lastMessageAt,
      dependencies: this.dependencies,
      storage: this.storageSnapshot,
      prefetch: this.prefetchSnapshot,
      audio: this.audioContext ? {
        state: this.audioContext.state,
        sampleRate: this.audioContext.sampleRate,
        currentTime: this.audioContext.currentTime,
        scheduledUntil: this.audioStreamTime,
        activeSources: Object.keys(this.audioSources).length
      } : { state: "unavailable" },
      canvas: this.canvas ? {
        width: this.canvas.width,
        height: this.canvas.height,
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight
      } : null
    };
  };

  Krkr2EngineWorkerHost.prototype.addDomListener = function (target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.domListeners.push({ target: target, type: type, listener: listener, options: options });
  };

  Krkr2EngineWorkerHost.prototype.removeDomListeners = function () {
    for (var index = 0; index < this.domListeners.length; index += 1) {
      var item = this.domListeners[index];
      try { item.target.removeEventListener(item.type, item.listener, item.options); }
      catch (error) {}
    }
    this.domListeners = [];
    if (this.motionFrame) { cancelAnimationFrame(this.motionFrame); this.motionFrame = 0; }
    this.pendingMotion = null;
  };

  Krkr2EngineWorkerHost.prototype.restoreTransferredCanvas = function () {
    if (!this.offscreenCanvas) { return this.canvas; }
    var previous = this.canvas;
    var replacement = Krkr2EngineWorkerHost.replaceTransferredCanvas(previous);
    this.offscreenCanvas = null;
    if (!replacement) { return previous; }
    this.canvas = replacement;
    this.replacementCanvas = replacement;
    this.emit("canvas-replaced", { previous: previous, canvas: replacement });
    return replacement;
  };

  Krkr2EngineWorkerHost.prototype.disposeTransport = function (restoreCanvas) {
    if (this.worker) {
      this.worker.removeEventListener("message", this.boundMessage);
      this.worker.removeEventListener("error", this.boundError);
      this.worker.removeEventListener("messageerror", this.boundMessageError);
      try { this.worker.terminate(); } catch (error) {}
      this.worker = null;
    }
    this.removeDomListeners();
    if (restoreCanvas) { this.restoreTransferredCanvas(); }
  };

  Krkr2EngineWorkerHost.prototype.post = function (type, detail, transfer) {
    if (!this.worker || this.terminated) { return false; }
    var message = detail || {};
    message.channel = CHANNEL;
    message.protocolVersion = PROTOCOL_VERSION;
    message.sessionId = this.sessionId;
    message.type = type;
    this.worker.postMessage(message, transfer || []);
    return true;
  };

  Krkr2EngineWorkerHost.prototype.canvasPoint = function (clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    var width = this.canvas.width || 1;
    var height = this.canvas.height || 1;
    var scaleX = rect.width > 0 ? width / rect.width : 1;
    var scaleY = rect.height > 0 ? height / rect.height : 1;
    return {
      x: Math.max(0, Math.min(width, (clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(height, (clientY - rect.top) * scaleY)),
      scaleX: scaleX,
      scaleY: scaleY
    };
  };

  Krkr2EngineWorkerHost.prototype.mouseData = function (event) {
    var point = this.canvasPoint(event.clientX, event.clientY);
    return {
      type: event.type,
      timeStamp: performance.now(),
      screenX: point.x,
      screenY: point.y,
      clientX: point.x,
      clientY: point.y,
      pageX: point.x,
      pageY: point.y,
      movementX: Number(event.movementX || event.mozMovementX || event.webkitMovementX || 0) * point.scaleX,
      movementY: Number(event.movementY || event.mozMovementY || event.webkitMovementY || 0) * point.scaleY,
      button: Number(event.button || 0),
      buttons: Number(event.buttons == null ? (event.type === "mouseup" ? 0 : 1) : event.buttons),
      ctrlKey: !!event.ctrlKey,
      shiftKey: !!event.shiftKey,
      altKey: !!event.altKey,
      metaKey: !!event.metaKey
    };
  };

  Krkr2EngineWorkerHost.prototype.touchList = function (touches) {
    var result = [];
    for (var index = 0; index < touches.length; index += 1) {
      var touch = touches[index];
      var point = this.canvasPoint(touch.clientX, touch.clientY);
      result.push({
        identifier: touch.identifier,
        screenX: point.x,
        screenY: point.y,
        clientX: point.x,
        clientY: point.y,
        pageX: point.x,
        pageY: point.y,
        force: Number(touch.force || 0),
        radiusX: Number(touch.radiusX || 1),
        radiusY: Number(touch.radiusY || 1),
        rotationAngle: Number(touch.rotationAngle || 0)
      });
    }
    return result;
  };

  Krkr2EngineWorkerHost.prototype.touchData = function (event) {
    return {
      type: event.type,
      timeStamp: performance.now(),
      touches: this.touchList(event.touches || []),
      targetTouches: this.touchList(event.targetTouches || []),
      changedTouches: this.touchList(event.changedTouches || []),
      ctrlKey: !!event.ctrlKey,
      shiftKey: !!event.shiftKey,
      altKey: !!event.altKey,
      metaKey: !!event.metaKey
    };
  };

  Krkr2EngineWorkerHost.prototype.keyData = function (event) {
    return {
      type: event.type,
      timeStamp: performance.now(),
      key: event.key || "",
      code: event.code || "",
      char: event.key && event.key.length === 1 ? event.key : "",
      locale: event.locale || "",
      keyCode: Number(event.keyCode || 0),
      charCode: Number(event.charCode || 0),
      which: Number(event.which || event.keyCode || 0),
      location: Number(event.location || 0),
      repeat: !!event.repeat,
      ctrlKey: !!event.ctrlKey,
      shiftKey: !!event.shiftKey,
      altKey: !!event.altKey,
      metaKey: !!event.metaKey
    };
  };

  Krkr2EngineWorkerHost.prototype.queueMotion = function (data) {
    var selfHost = this;
    this.pendingMotion = data;
    if (this.motionFrame) { return; }
    this.motionFrame = requestAnimationFrame(function () {
      selfHost.motionFrame = 0;
      if (selfHost.pendingMotion) {
        selfHost.post("input", { event: selfHost.pendingMotion });
        selfHost.pendingMotion = null;
      }
    });
  };

  Krkr2EngineWorkerHost.prototype.installInput = function () {
    var selfHost = this;
    var passiveFalse = { passive: false };
    function mouse(event) {
      if (Date.now() < selfHost.suppressMouseUntil) { return; }
      if (event.type === "mousedown") {
        selfHost.unlockAudio();
        try { selfHost.canvas.focus({ preventScroll: true }); } catch (error) { try { selfHost.canvas.focus(); } catch (ignored) {} }
      }
      event.preventDefault();
      var data = selfHost.mouseData(event);
      if (event.type === "mousemove") { selfHost.queueMotion(data); }
      else { selfHost.post("input", { event: data }); }
    }
    function touch(event) {
      selfHost.suppressMouseUntil = Date.now() + 900;
      if (event.type === "touchstart") { selfHost.unlockAudio(); }
      event.preventDefault();
      var data = selfHost.touchData(event);
      if (event.type === "touchmove") { selfHost.queueMotion(data); }
      else { selfHost.post("input", { event: data }); }
    }
    function wheel(event) {
      event.preventDefault();
      var data = selfHost.mouseData(event);
      data.deltaX = Number(event.deltaX || 0);
      data.deltaY = Number(event.deltaY || 0);
      data.deltaZ = Number(event.deltaZ || 0);
      data.deltaMode = Number(event.deltaMode || 0);
      data.wheelDelta = Number(event.wheelDelta || -data.deltaY || 0);
      selfHost.post("input", { event: data });
    }
    function key(event) {
      if (event.type === "keydown") { selfHost.unlockAudio(); }
      selfHost.post("input", { event: selfHost.keyData(event) });
    }
    this.addDomListener(this.canvas, "mousedown", mouse, passiveFalse);
    this.addDomListener(this.canvas, "mouseup", mouse, passiveFalse);
    this.addDomListener(this.canvas, "mousemove", mouse, passiveFalse);
    this.addDomListener(this.canvas, "touchstart", touch, passiveFalse);
    this.addDomListener(this.canvas, "touchend", touch, passiveFalse);
    this.addDomListener(this.canvas, "touchmove", touch, passiveFalse);
    this.addDomListener(this.canvas, "touchcancel", touch, passiveFalse);
    this.addDomListener(this.canvas, "wheel", wheel, passiveFalse);
    this.addDomListener(this.canvas, "contextmenu", function (event) { event.preventDefault(); }, false);
    this.addDomListener(global, "keydown", key, false);
    this.addDomListener(global, "keyup", key, false);
    this.addDomListener(global, "blur", function () {
      selfHost.post("input", { event: { type: "blur", timeStamp: performance.now() } });
    }, false);
    this.addDomListener(global, "focus", function () {
      selfHost.post("input", { event: { type: "focus", timeStamp: performance.now() } });
    }, false);
    this.addDomListener(document, "visibilitychange", function () {
      selfHost.post("visibility", { hidden: !!document.hidden });
    }, false);
  };

  Krkr2EngineWorkerHost.prototype.ensureAudioContext = function (provided) {
    if (provided) { this.audioContext = provided; this.audioContextOwned = false; }
    if (!this.audioContext) {
      var Constructor = global.AudioContext || global.webkitAudioContext;
      if (typeof Constructor !== "function") { return null; }
      try { this.audioContext = new Constructor({ latencyHint: "interactive" }); }
      catch (error) { this.audioContext = new Constructor(); }
      this.audioContextOwned = true;
    }
    if (this.audioContext.state === "suspended" && typeof this.audioContext.resume === "function") {
      this.audioContext.resume().catch(function () {});
    }
    return this.audioContext;
  };

  Krkr2EngineWorkerHost.prototype.unlockAudio = function () {
    var context = this.ensureAudioContext();
    if (!context || context.state !== "suspended" || typeof context.resume !== "function") { return; }
    var selfHost = this;
    context.resume().then(function () {
      selfHost.audioStreamTime = context.currentTime + 0.03;
    }).catch(function () {});
  };

  Krkr2EngineWorkerHost.prototype.start = function (config) {
    config = config || {};
    var supported = capability();
    if (!supported.supported) { return Promise.reject(new Error("Worker runtime unavailable: " + supported.reason)); }
    if (this.started || this.worker) { return Promise.reject(new Error("Worker runtime already started")); }
    if (!this.canvas) { return Promise.reject(new Error("Worker runtime requires a canvas")); }
    if (!config.gameId) { return Promise.reject(new Error("Worker runtime requires gameId")); }

    this.started = true;
    this.terminated = false;
    this.gameId = String(config.gameId);
    this.sessionId = Date.now() * 100 + (nextSessionId++ % 100);
    this.phase = "creating-worker";
    this.replacementCanvas = null;
    this.ensureAudioContext(config.audioContext || this.options.audioContext);
    try {
      this.worker = new Worker(config.workerUrl || this.options.workerUrl || "/engine-worker.js");
      this.offscreenCanvas = this.canvas.transferControlToOffscreen();
      this.worker.addEventListener("message", this.boundMessage);
      this.worker.addEventListener("error", this.boundError);
      this.worker.addEventListener("messageerror", this.boundMessageError);
      this.installInput();
    } catch (error) {
      this.disposeTransport(true);
      this.started = false;
      this.phase = "failed";
      return Promise.reject(error);
    }

    var selfHost = this;
    var startPromise = new Promise(function (resolve, reject) {
      selfHost.startResolve = resolve;
      selfHost.startReject = reject;
      selfHost.startTimer = setTimeout(function () {
        if (selfHost.startReject) {
          var timeoutError = new Error("Worker engine startup timed out");
          selfHost.phase = "failed";
          selfHost.rejectStart(timeoutError);
          selfHost.disposeTransport(true);
          selfHost.emit("fatal", { error: timeoutError, timeout: true });
          selfHost.emit("state", selfHost.snapshot());
        }
      }, Number(config.startTimeoutMs || this.options.startTimeoutMs || 60000));
    }.bind(this));

    var message = {
      gameId: this.gameId,
      canvas: this.offscreenCanvas,
      width: Number(config.width || this.canvas.width || 1280),
      height: Number(config.height || this.canvas.height || 720),
      arguments: Array.isArray(config.arguments) ? config.arguments.slice() : [],
      workerUrl: config.workerUrl || this.options.workerUrl || "/engine-worker.js",
      engineScriptUrl: config.engineScriptUrl || this.options.engineScriptUrl || "/engine/krkrsdl2.js",
      wasmUrl: config.wasmUrl || this.options.wasmUrl || "/engine/krkrsdl2.wasm",
      storageScriptUrl: config.storageScriptUrl || this.options.storageScriptUrl || "/storage.js",
      factoryName: config.factoryName || this.options.factoryName || "instantiate_krkrsdl2_module",
      audioSampleRate: this.audioContext ? this.audioContext.sampleRate : 48000,
      devicePixelRatio: Number(config.devicePixelRatio || this.options.devicePixelRatio || 1)
    };
    var transfer = [this.offscreenCanvas];
    if (config.wasmBinary) {
      var source = config.wasmBinary instanceof Uint8Array ? config.wasmBinary : new Uint8Array(config.wasmBinary);
      var copy = source.slice().buffer;
      message.wasmBinary = copy;
      transfer.push(copy);
    }
    try {
      this.post("start", message, transfer);
    } catch (error) {
      this.phase = "failed";
      this.started = false;
      this.rejectStart(error);
      this.disposeTransport(true);
      return startPromise;
    }
    this.emit("state", this.snapshot());
    return startPromise;
  };

  Krkr2EngineWorkerHost.prototype.resolveStart = function () {
    if (!this.startResolve) { return; }
    var resolve = this.startResolve;
    this.startResolve = null;
    this.startReject = null;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = 0; }
    resolve(this);
  };

  Krkr2EngineWorkerHost.prototype.rejectStart = function (error) {
    if (!this.startReject) { return; }
    var reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = 0; }
    reject(error instanceof Error ? error : new Error(String(error)));
  };

  Krkr2EngineWorkerHost.prototype.handleWorkerMessage = function (event) {
    var message = event.data || {};
    if (message.channel !== CHANNEL || message.protocolVersion !== PROTOCOL_VERSION ||
        Number(message.sessionId || 0) !== this.sessionId) { return; }
    this.lastMessageAt = Date.now();
    if (message.type === "phase") {
      this.phase = message.phase;
      this.emit("phase", message);
    } else if (message.type === "ready") {
      this.phase = "running";
      this.resolveStart();
      this.emit("ready", message);
    } else if (message.type === "interactive-ready") {
      this.emit("interactive-ready", message);
    } else if (message.type === "stdout") {
      this.emit("stdout", message.message);
    } else if (message.type === "stderr") {
      this.emit("stderr", message.message);
    } else if (message.type === "status") {
      this.emit("status", message.status);
    } else if (message.type === "dependencies") {
      this.dependencies = Number(message.count || 0);
      this.emit("dependencies", this.dependencies);
    } else if (message.type === "storage-ready") {
      this.storageSnapshot = message.snapshot || null;
      this.emit("storage-ready", message.snapshot);
    } else if (message.type === "saves-ready") {
      this.emit("saves-ready", message);
    } else if (message.type === "prefetch-stats") {
      this.prefetchSnapshot = message.prefetch || null;
    } else if (message.type === "heartbeat") {
      this.lastHeartbeatAt = Number(message.at || Date.now());
      this.emit("heartbeat", message);
    } else if (message.type === "video") {
      this.handleVideo(message);
    } else if (message.type === "audio") {
      this.handleAudio(message);
    } else if (message.type === "alert") {
      this.handleAlert(message);
    } else if (message.type === "host-command") {
      this.handleHostCommand(message);
    } else if (message.type === "engine-quit") {
      this.emit("engine-quit", message);
    } else if (message.type === "response") {
      this.handleResponse(message);
    } else if (message.type === "abort" || message.type === "fatal") {
      this.phase = message.type === "abort" ? "aborted" : "failed";
      var fatalError = new Error(message.reason || message.error || "Worker engine failed");
      this.rejectStart(fatalError);
      this.emit("fatal", { error: fatalError, message: message });
      this.disposeTransport(true);
    } else if (message.type === "exit") {
      this.phase = "exited";
      this.emit("exit", message);
    }
    this.emit("state", this.snapshot());
  };

  Krkr2EngineWorkerHost.prototype.handleWorkerError = function (event) {
    var error = new Error(event.message || "Engine worker failed");
    this.phase = "failed";
    this.rejectStart(error);
    this.emit("fatal", { error: error, event: event });
    this.disposeTransport(true);
    this.emit("state", this.snapshot());
  };

  Krkr2EngineWorkerHost.prototype.handleWorkerMessageError = function () {
    this.handleWorkerError({ message: "Engine worker sent an unreadable message" });
  };

  Krkr2EngineWorkerHost.prototype.handleVideo = function (message) {
    if (message.action === "open") {
      this.activeVideoSerial = Number(message.videoSerial || (this.activeVideoSerial + 1));
      this.completedVideoSerial = 0;
    }
    this.emit("video", message);
    var handlers = this.options.video || {};
    var handler = handlers[message.action];
    if (typeof handler === "function") { handler(message, this); return; }
    var globals = {
      open: "krkr2webVideoOpen",
      play: "krkr2webVideoPlay",
      stop: "krkr2webVideoStop",
      pause: "krkr2webVideoPause",
      resume: "krkr2webVideoPause"
    };
    var bridge = global[globals[message.action]];
    if (typeof bridge === "function") {
      if (message.action === "open") { bridge(message.name); }
      else if (message.action === "pause") { bridge(1); }
      else if (message.action === "resume") { bridge(0); }
      else { bridge(); }
    }
  };

  Krkr2EngineWorkerHost.prototype.handleAlert = function (message) {
    this.emit("alert", message);
    if (typeof this.options.onAlert === "function") { return; }
    var alertFunction = this.options.alert || global.alert;
    if (typeof alertFunction === "function") {
      setTimeout(function () { alertFunction.call(global, message.message); }, 0);
    }
  };

  Krkr2EngineWorkerHost.prototype.createAudioBuffer = function (message) {
    var context = this.audioContext;
    var channels = message.channels || [];
    if (!context || !channels.length) { return null; }
    var first = new Float32Array(channels[0]);
    var buffer = context.createBuffer(channels.length, first.length, Number(message.sampleRate || context.sampleRate));
    buffer.getChannelData(0).set(first);
    for (var index = 1; index < channels.length; index += 1) {
      buffer.getChannelData(index).set(new Float32Array(channels[index]));
    }
    return buffer;
  };

  Krkr2EngineWorkerHost.prototype.playAudioBuffer = function (message, stream) {
    var context = this.ensureAudioContext();
    if (!context || context.state === "closed") { return; }
    if (stream && context.state === "suspended") {
      this.audioStreamTime = 0;
      return;
    }
    var buffer = this.createAudioBuffer(message);
    if (!buffer) { return; }
    var source = context.createBufferSource();
    var gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = Number(message.playbackRate || 1);
    source.loop = !!message.loop;
    if (message.loopStart > 0) { source.loopStart = Number(message.loopStart); }
    if (message.loopEnd > 0) { source.loopEnd = Number(message.loopEnd); }
    gain.gain.value = isFinite(message.gain) ? Number(message.gain) : 1;
    source.connect(gain);
    gain.connect(context.destination);
    var when;
    if (stream) {
      if (this.audioStreamTime < context.currentTime - 0.1 || this.audioStreamTime > context.currentTime + 0.75) {
        this.audioStreamTime = context.currentTime + 0.03;
      }
      when = this.audioStreamTime;
      this.audioStreamTime += buffer.duration / Math.max(0.01, source.playbackRate.value);
    } else {
      when = context.currentTime + Math.max(0, Math.min(2, Number(message.delay || 0)));
    }
    var baseSourceId = String(message.sourceId);
    var sourceId = stream ? baseSourceId + ":chunk:" + this.nextAudioChunkId++ : baseSourceId;
    var previous = this.audioSources[sourceId];
    if (previous && !stream) { try { previous.stop(); } catch (error) {} }
    this.audioSources[sourceId] = source;
    var selfHost = this;
    source.onended = function () {
      if (selfHost.audioSources[sourceId] === source && !source.loop) { delete selfHost.audioSources[sourceId]; }
    };
    try { source.start(when, Math.max(0, Number(message.offset || 0))); }
    catch (error) {
      delete this.audioSources[sourceId];
      this.emit("stderr", "Audio schedule failed: " + errorText(error));
    }
  };

  Krkr2EngineWorkerHost.prototype.handleAudio = function (message) {
    if (message.action === "buffer-start") {
      this.playAudioBuffer(message, false);
    } else if (message.action === "stream-chunk") {
      this.playAudioBuffer(message, true);
    } else if (message.action === "source-stop") {
      var sourceId = String(message.sourceId);
      Object.keys(this.audioSources).forEach(function (key) {
        if (key === sourceId || key.indexOf(sourceId + ":chunk:") === 0) {
          try { this.audioSources[key].stop(); } catch (error) {}
          delete this.audioSources[key];
        }
      }, this);
    }
    this.emit("audio", {
      action: message.action,
      sourceId: message.sourceId,
      currentTime: this.audioContext ? this.audioContext.currentTime : 0,
      scheduledUntil: this.audioStreamTime
    });
  };

  Krkr2EngineWorkerHost.prototype.handleHostCommand = function (message) {
    try {
      if (message.command === "focus-canvas") {
        this.canvas.focus();
      } else if (message.command === "pointer-lock" && this.canvas.requestPointerLock) {
        this.canvas.requestPointerLock();
      } else if (message.command === "exit-pointer-lock" && document.exitPointerLock) {
        document.exitPointerLock();
      } else if (message.command === "fullscreen" && this.canvas.requestFullscreen) {
        this.canvas.requestFullscreen().catch(function () {});
      } else if (message.command === "open-url" && message.url) {
        global.open(message.url, message.target || "_blank", "noopener");
      }
    } catch (error) {
      this.emit("stderr", "Host command failed: " + errorText(error));
    }
  };

  Krkr2EngineWorkerHost.prototype.handleResponse = function (message) {
    var pending = this.pendingRequests[message.requestId];
    if (!pending) { return; }
    delete this.pendingRequests[message.requestId];
    clearTimeout(pending.timer);
    if (message.ok) { pending.resolve(message.value); }
    else { pending.reject(new Error(message.error || "Worker request failed")); }
  };

  Krkr2EngineWorkerHost.prototype.request = function (command, timeoutMs) {
    if (!this.worker || this.terminated) { return Promise.reject(new Error("Engine worker is not running")); }
    var requestId = this.nextRequestId++;
    var selfHost = this;
    var promise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete selfHost.pendingRequests[requestId];
        reject(new Error(command + " timed out"));
      }, Number(timeoutMs || 15000));
      selfHost.pendingRequests[requestId] = { resolve: resolve, reject: reject, timer: timer };
    });
    this.post("request", { command: command, requestId: requestId });
    return promise;
  };

  Krkr2EngineWorkerHost.prototype.syncSaves = function () { return this.request("sync-saves", 20000); };
  Krkr2EngineWorkerHost.prototype.runtimeSnapshot = function () { return this.request("runtime-snapshot", 5000); };
  Krkr2EngineWorkerHost.prototype.refreshStorageSnapshot = function () {
    var selfHost = this;
    return this.request("storage-snapshot", 5000).then(function (value) {
      selfHost.storageSnapshot = value;
      return value;
    });
  };

  Krkr2EngineWorkerHost.prototype.krkr2webVideoEnded = function () {
    if (this.activeVideoSerial && this.completedVideoSerial === this.activeVideoSerial) { return false; }
    this.completedVideoSerial = this.activeVideoSerial;
    return this.post("video-ended", { videoSerial: this.activeVideoSerial });
  };

  Krkr2EngineWorkerHost.prototype.resize = function (width, height) {
    return this.post("resize", { width: Number(width), height: Number(height) });
  };

  Krkr2EngineWorkerHost.prototype.terminate = function (reason) {
    if (this.terminated) { return this.snapshot(); }
    this.terminated = true;
    this.phase = "terminated";
    this.disposeTransport(true);
    this.rejectStart(new Error("Engine worker terminated: " + (reason || "terminated")));
    Object.keys(this.pendingRequests).forEach(function (key) {
      var pending = this.pendingRequests[key];
      clearTimeout(pending.timer);
      pending.reject(new Error("Engine worker terminated"));
    }, this);
    this.pendingRequests = {};
    Object.keys(this.audioSources).forEach(function (key) {
      try { this.audioSources[key].stop(); } catch (error) {}
    }, this);
    this.audioSources = {};
    this.audioStreamTime = 0;
    this.nextAudioChunkId = 1;
    if (this.audioContextOwned && this.audioContext && typeof this.audioContext.close === "function") {
      try { this.audioContext.close(); } catch (error) {}
      this.audioContext = null;
      this.audioContextOwned = false;
    }
    var stopVideo = this.options.video && this.options.video.stop;
    if (typeof stopVideo === "function") { try { stopVideo({ action: "stop" }, this); } catch (error) {} }
    else if (typeof global.krkr2webVideoStop === "function") { try { global.krkr2webVideoStop(); } catch (error) {} }
    this.emit("terminated", { reason: reason || "terminated", snapshot: this.snapshot() });
    this.emit("state", this.snapshot());
    return this.snapshot();
  };

  Krkr2EngineWorkerHost.prototype.forceTerminate = Krkr2EngineWorkerHost.prototype.terminate;

  Krkr2EngineWorkerHost.replaceTransferredCanvas = function (canvas) {
    if (!canvas || !canvas.parentNode) { return null; }
    var replacement = canvas.cloneNode(false);
    replacement.width = canvas.width;
    replacement.height = canvas.height;
    canvas.parentNode.replaceChild(replacement, canvas);
    return replacement;
  };

  global.Krkr2EngineWorkerHost = Krkr2EngineWorkerHost;
  global.krkr2EngineWorkerCapability = capability;
}(window));
