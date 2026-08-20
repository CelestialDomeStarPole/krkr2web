/* krkr2web Dedicated Worker runtime (Chrome 89 compatible, no SAB required). */
(function () {
  "use strict";

  var CHANNEL = "krkr2web-engine-worker";
  var PROTOCOL_VERSION = 1;
  var sessionId = 0;
  var phase = "idle";
  var moduleInstance = null;
  var engineCanvas = null;
  var documentTarget = null;
  var canvasTarget = null;
  var currentGameId = null;
  var heartbeatAt = 0;
  var audioSampleRate = 48000;
  var nextAudioSourceId = 1;
  var videoSerial = 0;
  var completedVideoSerial = 0;
  var pendingVideoCompletionSerial = 0;

  function errorText(error) {
    if (!error) { return "Unknown error"; }
    return error.stack || error.message || String(error);
  }

  function send(type, detail, transfer) {
    var message = detail || {};
    message.channel = CHANNEL;
    message.protocolVersion = PROTOCOL_VERSION;
    message.sessionId = sessionId;
    message.type = type;
    try {
      self.postMessage(message, transfer || []);
    } catch (error) {
      self.postMessage({
        channel: CHANNEL,
        protocolVersion: PROTOCOL_VERSION,
        sessionId: sessionId,
        type: "stderr",
        message: "Worker postMessage failed: " + errorText(error)
      });
    }
  }

  function createStyleDeclaration() {
    var style = {};
    style.setProperty = function (name, value) { style[name] = String(value); };
    style.removeProperty = function (name) {
      var previous = style[name] || "";
      delete style[name];
      return previous;
    };
    style.getPropertyValue = function (name) { return style[name] || ""; };
    return style;
  }

  function VirtualEventTarget(name) {
    this.name = name;
    this.nodeName = String(name || "element").toUpperCase();
    this.listeners = {};
    this.style = createStyleDeclaration();
    this.children = [];
    this.parentNode = null;
  }

  VirtualEventTarget.prototype.addEventListener = function (type, listener) {
    if (!listener) { return; }
    var list = this.listeners[type] || (this.listeners[type] = []);
    if (list.indexOf(listener) === -1) { list.push(listener); }
  };

  VirtualEventTarget.prototype.removeEventListener = function (type, listener) {
    var list = this.listeners[type];
    if (!list) { return; }
    var index = list.indexOf(listener);
    if (index >= 0) { list.splice(index, 1); }
  };

  VirtualEventTarget.prototype.dispatch = function (event) {
    var list = (this.listeners[event.type] || []).slice();
    event.target = event.target || this;
    event.currentTarget = this;
    for (var index = 0; index < list.length; index += 1) {
      try {
        if (typeof list[index] === "function") { list[index].call(this, event); }
        else if (list[index] && list[index].handleEvent) { list[index].handleEvent(event); }
      } catch (error) {
        send("stderr", { message: "Input listener failed: " + errorText(error) });
      }
    }
    return !event.defaultPrevented;
  };

  VirtualEventTarget.prototype.dispatchEvent = function (event) {
    return this.dispatch(event);
  };

  VirtualEventTarget.prototype.appendChild = function (child) {
    if (child && child.parentNode && child.parentNode !== this && child.parentNode.removeChild) {
      child.parentNode.removeChild(child);
    }
    if (child && this.children.indexOf(child) === -1) { this.children.push(child); }
    if (child) { defineValue(child, "parentNode", this); }
    return child;
  };
  VirtualEventTarget.prototype.insertBefore = function (child, before) {
    if (!child) { return child; }
    if (child.parentNode && child.parentNode !== this && child.parentNode.removeChild) {
      child.parentNode.removeChild(child);
    }
    var current = this.children.indexOf(child);
    if (current >= 0) { this.children.splice(current, 1); }
    var index = this.children.indexOf(before);
    this.children.splice(index >= 0 ? index : this.children.length, 0, child);
    defineValue(child, "parentNode", this);
    return child;
  };
  VirtualEventTarget.prototype.removeChild = function (child) {
    var index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); }
    if (child && child.parentNode === this) { defineValue(child, "parentNode", null); }
    return child;
  };
  VirtualEventTarget.prototype.setAttribute = function () {};
  VirtualEventTarget.prototype.getAttribute = function () { return null; };
  VirtualEventTarget.prototype.focus = function () {};
  VirtualEventTarget.prototype.blur = function () {};
  VirtualEventTarget.prototype.requestFullscreen = function () {
    send("host-command", { command: "fullscreen" });
    return Promise.resolve();
  };

  function defineValue(object, name, value) {
    try {
      Object.defineProperty(object, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: value
      });
    } catch (error) {
      try { object[name] = value; } catch (ignored) {}
    }
  }

  function decorateCanvas(canvas) {
    var target = new VirtualEventTarget("canvas");
    defineValue(canvas, "id", "canvas");
    defineValue(canvas, "nodeName", "CANVAS");
    defineValue(canvas, "__krkrEventTarget", target);
    defineValue(canvas, "addEventListener", function (type, listener) {
      target.addEventListener(type, listener);
    });
    defineValue(canvas, "removeEventListener", function (type, listener) {
      target.removeEventListener(type, listener);
    });
    defineValue(canvas, "__krkrDispatch", function (event) {
      event.target = canvas;
      event.currentTarget = canvas;
      return target.dispatch(event);
    });
    if (!canvas.style || typeof canvas.style.setProperty !== "function") {
      defineValue(canvas, "style", createStyleDeclaration());
    }
    try {
      Object.defineProperty(canvas, "clientWidth", {
        configurable: true,
        get: function () { return canvas.width; }
      });
      Object.defineProperty(canvas, "clientHeight", {
        configurable: true,
        get: function () { return canvas.height; }
      });
    } catch (error) {}
    defineValue(canvas, "getBoundingClientRect", function () {
      return {
        left: 0, top: 0, right: canvas.width, bottom: canvas.height,
        width: canvas.width, height: canvas.height
      };
    });
    defineValue(canvas, "focus", function () {
      send("host-command", { command: "focus-canvas" });
    });
    defineValue(canvas, "blur", function () {});
    defineValue(canvas, "requestPointerLock", function () {
      send("host-command", { command: "pointer-lock" });
    });
    defineValue(canvas, "requestFullscreen", function () {
      send("host-command", { command: "fullscreen" });
      return Promise.resolve();
    });
    defineValue(canvas, "toDataURL", function () { return "data:image/png;base64,"; });
    defineValue(canvas, "onwheel", null);
    return target;
  }

  function createDocument() {
    var doc = new VirtualEventTarget("document");
    var body = new VirtualEventTarget("body");
    var root = new VirtualEventTarget("documentElement");
    doc.body = body;
    doc.documentElement = root;
    doc.currentScript = null;
    doc.hidden = false;
    doc.visibilityState = "visible";
    doc.fullscreenEnabled = false;
    doc.webkitFullscreenEnabled = false;
    doc.fullscreenElement = null;
    doc.webkitFullscreenElement = null;
    doc.mozFullScreenElement = null;
    doc.msFullscreenElement = null;
    doc.pointerLockElement = null;
    doc.webkitPointerLockElement = null;
    doc.mozPointerLockElement = null;
    doc.msPointerLockElement = null;
    doc.title = "krkr2web";
    doc.getElementById = function (id) { return id === "canvas" ? engineCanvas : null; };
    doc.querySelector = function (selector) {
      return selector === "canvas" || selector === "#canvas" ? engineCanvas : null;
    };
    doc.createElement = function (tagName) {
      var tag = String(tagName || "").toLowerCase();
      if (tag === "canvas" && typeof OffscreenCanvas === "function") {
        var canvas = new OffscreenCanvas(1, 1);
        decorateCanvas(canvas);
        return canvas;
      }
      return new VirtualEventTarget(tag || "element");
    };
    doc.exitPointerLock = function () {
      send("host-command", { command: "exit-pointer-lock" });
    };
    body.appendChild(engineCanvas);
    return doc;
  }

  function FakeAudioParam(value) {
    this.value = value == null ? 0 : Number(value);
  }

  FakeAudioParam.prototype.setValueAtTime = function (value) { this.value = Number(value); return this; };
  FakeAudioParam.prototype.linearRampToValueAtTime = function (value) { this.value = Number(value); return this; };
  FakeAudioParam.prototype.exponentialRampToValueAtTime = function (value) { this.value = Number(value); return this; };
  FakeAudioParam.prototype.setTargetAtTime = function (value) { this.value = Number(value); return this; };
  FakeAudioParam.prototype.cancelScheduledValues = function () { return this; };

  function FakeAudioNode() {
    this.connections = [];
  }

  FakeAudioNode.prototype.connect = function (target) {
    if (target && this.connections.indexOf(target) === -1) { this.connections.push(target); }
    return target;
  };
  FakeAudioNode.prototype.disconnect = function () { this.connections = []; };

  function FakeAudioBuffer(channels, length, rate) {
    this.numberOfChannels = Math.max(1, Number(channels || 1));
    this.length = Math.max(0, Number(length || 0));
    this.sampleRate = Math.max(8000, Number(rate || audioSampleRate));
    this.duration = this.length / this.sampleRate;
    this.data = [];
    for (var index = 0; index < this.numberOfChannels; index += 1) {
      this.data.push(new Float32Array(this.length));
    }
  }

  FakeAudioBuffer.prototype.getChannelData = function (channel) { return this.data[channel]; };
  FakeAudioBuffer.prototype.copyToChannel = function (source, channel, offset) {
    this.data[channel].set(source, offset || 0);
  };

  function connectedGain(node, visited) {
    if (!node || visited.indexOf(node) >= 0) { return 1; }
    visited.push(node);
    var value = node.gain && isFinite(node.gain.value) ? Number(node.gain.value) : 1;
    if (node.connections && node.connections.length) { value *= connectedGain(node.connections[0], visited); }
    return value;
  }

  function copyAudioChannels(buffer) {
    var channels = [];
    var transfer = [];
    for (var index = 0; index < buffer.numberOfChannels; index += 1) {
      var copy = buffer.getChannelData(index).slice().buffer;
      channels.push(copy);
      transfer.push(copy);
    }
    return { channels: channels, transfer: transfer };
  }

  function FakeBufferSource(context) {
    FakeAudioNode.call(this);
    this.context = context;
    this.id = nextAudioSourceId++;
    this.buffer = null;
    this.playbackRate = new FakeAudioParam(1);
    this.detune = new FakeAudioParam(0);
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.onended = null;
  }

  FakeBufferSource.prototype = Object.create(FakeAudioNode.prototype);
  FakeBufferSource.prototype.constructor = FakeBufferSource;
  FakeBufferSource.prototype.start = function (when, offset) {
    if (!this.buffer) { return; }
    var copied = copyAudioChannels(this.buffer);
    send("audio", {
      action: "buffer-start",
      sourceId: this.id,
      sampleRate: this.buffer.sampleRate,
      channels: copied.channels,
      delay: Math.max(0, Number(when || 0) - this.context.currentTime),
      offset: Math.max(0, Number(offset || 0)),
      playbackRate: Number(this.playbackRate.value || 1),
      gain: connectedGain(this, []),
      loop: !!this.loop,
      loopStart: Number(this.loopStart || 0),
      loopEnd: Number(this.loopEnd || 0)
    }, copied.transfer);
  };
  FakeBufferSource.prototype.stop = function () { send("audio", { action: "source-stop", sourceId: this.id }); };
  FakeBufferSource.prototype.noteOn = FakeBufferSource.prototype.start;
  FakeBufferSource.prototype.noteOff = FakeBufferSource.prototype.stop;

  function FakeScriptProcessor(context, bufferSize, outputChannels) {
    FakeAudioNode.call(this);
    this.context = context;
    this.bufferSize = Math.max(256, Number(bufferSize || 4096));
    this.outputChannels = Math.max(1, Number(outputChannels || 2));
    this.onaudioprocess = null;
    this.timer = 0;
    this.id = nextAudioSourceId++;
  }

  FakeScriptProcessor.prototype = Object.create(FakeAudioNode.prototype);
  FakeScriptProcessor.prototype.constructor = FakeScriptProcessor;
  FakeScriptProcessor.prototype.pump = function () {
    if (typeof this.onaudioprocess !== "function") { return; }
    var buffer = new FakeAudioBuffer(this.outputChannels, this.bufferSize, this.context.sampleRate);
    this.onaudioprocess({ outputBuffer: buffer });
    var copied = copyAudioChannels(buffer);
    send("audio", {
      action: "stream-chunk",
      sourceId: this.id,
      sampleRate: buffer.sampleRate,
      channels: copied.channels,
      gain: connectedGain(this, [])
    }, copied.transfer);
  };
  FakeScriptProcessor.prototype.connect = function (target) {
    FakeAudioNode.prototype.connect.call(this, target);
    if (!this.timer) {
      var processor = this;
      var interval = Math.max(4, Math.round(this.bufferSize / this.context.sampleRate * 1000));
      this.timer = setInterval(function () { processor.pump(); }, interval);
    }
    return target;
  };
  FakeScriptProcessor.prototype.disconnect = function () {
    FakeAudioNode.prototype.disconnect.call(this);
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  };

  function FakeAudioContext(options) {
    options = options || {};
    this.sampleRate = Math.max(8000, Number(options.sampleRate || audioSampleRate));
    this.state = "running";
    this.startedAt = performance.now() / 1000;
    this.destination = new FakeAudioNode();
    this.listener = {
      positionX: new FakeAudioParam(0), positionY: new FakeAudioParam(0), positionZ: new FakeAudioParam(0),
      forwardX: new FakeAudioParam(0), forwardY: new FakeAudioParam(0), forwardZ: new FakeAudioParam(-1),
      upX: new FakeAudioParam(0), upY: new FakeAudioParam(1), upZ: new FakeAudioParam(0),
      setPosition: function () {}, setOrientation: function () {}
    };
  }

  Object.defineProperty(FakeAudioContext.prototype, "currentTime", {
    get: function () { return Math.max(0, performance.now() / 1000 - this.startedAt); }
  });
  FakeAudioContext.prototype.createBuffer = function (channels, length, rate) {
    return new FakeAudioBuffer(channels, length, rate);
  };
  FakeAudioContext.prototype.createBufferSource = function () { return new FakeBufferSource(this); };
  FakeAudioContext.prototype.createGain = function () {
    var node = new FakeAudioNode();
    node.gain = new FakeAudioParam(1);
    return node;
  };
  FakeAudioContext.prototype.createGainNode = FakeAudioContext.prototype.createGain;
  FakeAudioContext.prototype.createPanner = function () {
    var node = new FakeAudioNode();
    node.positionX = new FakeAudioParam(0); node.positionY = new FakeAudioParam(0); node.positionZ = new FakeAudioParam(0);
    node.orientationX = new FakeAudioParam(1); node.orientationY = new FakeAudioParam(0); node.orientationZ = new FakeAudioParam(0);
    node.setPosition = function (x, y, z) { node.positionX.value = x; node.positionY.value = y; node.positionZ.value = z; };
    node.setOrientation = function (x, y, z) { node.orientationX.value = x; node.orientationY.value = y; node.orientationZ.value = z; };
    return node;
  };
  FakeAudioContext.prototype.createScriptProcessor = function (size, inputChannels, outputChannels) {
    return new FakeScriptProcessor(this, size, outputChannels);
  };
  FakeAudioContext.prototype.createMediaStreamSource = function () { return new FakeAudioNode(); };
  FakeAudioContext.prototype.resume = function () { this.state = "running"; return Promise.resolve(); };
  FakeAudioContext.prototype.suspend = function () { this.state = "suspended"; return Promise.resolve(); };
  FakeAudioContext.prototype.close = function () { this.state = "closed"; return Promise.resolve(); };

  function installWorkerPlatform(message) {
    self.window = self;
    self.devicePixelRatio = Math.max(0.25, Number(message.devicePixelRatio || 1));
    if (typeof self.requestAnimationFrame !== "function") {
      self.requestAnimationFrame = function (callback) {
        return setTimeout(function () { callback(performance.now()); }, 16);
      };
      self.cancelAnimationFrame = function (handle) { clearTimeout(handle); };
    }
    if (typeof self.screen === "undefined") {
      self.screen = { width: 1280, height: 720, availWidth: 1280, availHeight: 720 };
    }
    self.innerWidth = engineCanvas ? engineCanvas.width : 1280;
    self.innerHeight = engineCanvas ? engineCanvas.height : 720;
    self.pageXOffset = 0;
    self.pageYOffset = 0;
    self.scrollX = 0;
    self.scrollY = 0;
    self.alert = function (message) {
      send("alert", { message: String(message) });
    };
    self.prompt = function (message, fallback) {
      send("alert", { message: String(message), prompt: true });
      return fallback == null ? "i" : String(fallback);
    };
    self.open = function (url, target) {
      send("host-command", { command: "open-url", url: String(url || ""), target: target || "_blank" });
      return null;
    };
    self.krkr2webEngineQuit = function () { send("engine-quit", {}); };
    self.krkr2webEngineHeartbeat = function () {
      var now = Date.now();
      if (now - heartbeatAt >= 250) {
        heartbeatAt = now;
        send("heartbeat", { at: now });
      }
    };
    self.krkr2webVideoOpen = function (name) {
      videoSerial += 1;
      completedVideoSerial = 0;
      pendingVideoCompletionSerial = 0;
      send("video", { action: "open", name: String(name || ""), videoSerial: videoSerial });
    };
    self.krkr2webVideoPlay = function () { send("video", { action: "play", videoSerial: videoSerial }); };
    self.krkr2webVideoStop = function () { send("video", { action: "stop", videoSerial: videoSerial }); };
    self.krkr2webVideoPause = function (pause) {
      send("video", { action: pause ? "pause" : "resume", videoSerial: videoSerial });
    };
    self.AudioContext = FakeAudioContext;
    self.webkitAudioContext = FakeAudioContext;
    documentTarget = createDocument();
    self.document = documentTarget;
  }

  function makeEvent(data) {
    var event = {};
    Object.keys(data || {}).forEach(function (key) {
      if (key !== "target") { event[key] = data[key]; }
    });
    event.type = String(event.type || "");
    event.timeStamp = Number(event.timeStamp || performance.now());
    event.defaultPrevented = false;
    event.preventDefault = function () { event.defaultPrevented = true; };
    event.stopPropagation = function () {};
    event.stopImmediatePropagation = function () {};
    return event;
  }

  function dispatchNativeGlobal(event) {
    try {
      var nativeEvent = new Event(event.type, { cancelable: true });
      Object.keys(event).forEach(function (key) {
        if (typeof event[key] === "function" || key === "type") { return; }
        try { Object.defineProperty(nativeEvent, key, { configurable: true, value: event[key] }); }
        catch (error) {}
      });
      self.dispatchEvent(nativeEvent);
    } catch (error) {
      send("stderr", { message: "Global input dispatch failed: " + errorText(error) });
    }
  }

  function dispatchInput(data) {
    if (!engineCanvas) { return; }
    var event = makeEvent(data);
    var type = event.type;
    if (type === "keydown" || type === "keyup" || type === "keypress" ||
        type === "focus" || type === "blur" || type === "resize") {
      dispatchNativeGlobal(event);
      return;
    }
    if (type === "visibilitychange") {
      documentTarget.hidden = !!event.hidden;
      documentTarget.visibilityState = event.visibilityState || (event.hidden ? "hidden" : "visible");
      documentTarget.dispatch(event);
      return;
    }
    if (engineCanvas.__krkrDispatch) { engineCanvas.__krkrDispatch(event); }
  }

  function syncFileSystem(populate) {
    return new Promise(function (resolve, reject) {
      if (!moduleInstance || !moduleInstance.FS || typeof moduleInstance.FS.syncfs !== "function") {
        reject(new Error("Engine filesystem is unavailable"));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error("IDBFS sync timed out")); }
      }, 15000);
      moduleInstance.FS.syncfs(!!populate, function (error) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        if (error) { reject(error); } else { resolve(); }
      });
    });
  }

  function mountSaves(moduleOptions, gameId) {
    var root = "/savedata";
    var gameRoot = root + "/" + gameId;
    try { moduleOptions.FS.mkdir(root); } catch (error) {}
    try { moduleOptions.FS.mkdir(gameRoot); } catch (error) {}
    moduleOptions.FS.mount(moduleOptions.IDBFS, {}, gameRoot);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error("Initial IDBFS sync timed out")); }
      }, 20000);
      moduleOptions.FS.syncfs(true, function (error) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        if (error) { reject(error); } else { resolve(); }
      });
    });
  }

  function response(requestId, ok, value, error) {
    send("response", {
      requestId: requestId,
      ok: !!ok,
      value: value == null ? null : value,
      error: error ? errorText(error) : null
    });
  }

  function deliverVideoCompletion() {
    if (!moduleInstance || typeof moduleInstance.krkr2webVideoEnded !== "function") {
      pendingVideoCompletionSerial = videoSerial || -1;
      return;
    }
    pendingVideoCompletionSerial = 0;
    moduleInstance.krkr2webVideoEnded();
  }

  async function startEngine(message) {
    if (phase !== "idle") { throw new Error("Worker engine already started"); }
    sessionId = Number(message.sessionId || 0);
    audioSampleRate = Math.max(8000, Number(message.audioSampleRate || 48000));
    currentGameId = String(message.gameId || "");
    if (!currentGameId) { throw new Error("Missing gameId"); }
    if (!message.canvas) { throw new Error("Missing OffscreenCanvas"); }
    engineCanvas = message.canvas;
    if (message.width > 0) { engineCanvas.width = message.width; }
    if (message.height > 0) { engineCanvas.height = message.height; }
    canvasTarget = decorateCanvas(engineCanvas);
    installWorkerPlatform(message);
    phase = "loading-storage";
    send("phase", { phase: phase });

    var storageScriptUrl = message.storageScriptUrl || "/storage.js";
    documentTarget.currentScript = { src: storageScriptUrl };
    importScripts(storageScriptUrl);
    var storage = self.krkr2StorageBridge;
    if (!storage || typeof storage.prepare !== "function") {
      throw new Error("Worker storage bridge did not initialize");
    }
    await storage.prepare(currentGameId);
    send("storage-ready", { snapshot: storage.snapshot ? storage.snapshot() : null });

    phase = "loading-engine";
    send("phase", { phase: phase });
    var engineScriptUrl = message.engineScriptUrl || "/engine/krkrsdl2.js";
    documentTarget.currentScript = { src: engineScriptUrl };
    importScripts(engineScriptUrl);
    var factoryName = message.factoryName || "instantiate_krkrsdl2_module";
    var factory = self[factoryName];
    if (typeof factory !== "function") { throw new Error("Missing engine factory: " + factoryName); }

    var generation = sessionId;
    var readySent = false;
    var moduleOptions = {
      arguments: Array.isArray(message.arguments) ? message.arguments.slice() : [],
      canvas: engineCanvas,
      krkr2Storage: storage,
      noInitialRun: false,
      locateFile: function (path) {
        if (/\.wasm(?:$|[?#])/.test(path) && message.wasmUrl) { return message.wasmUrl; }
        try { return new URL(path, engineScriptUrl).href; }
        catch (error) { return path; }
      },
      preRun: [function () {
        var dependency = "krkr2web-worker-saves-" + generation;
        moduleOptions.addRunDependency(dependency);
        mountSaves(moduleOptions, currentGameId).then(function () {
          send("saves-ready", {});
          moduleOptions.removeRunDependency(dependency);
        }, function (error) {
          send("stderr", { message: "Initial save sync failed: " + errorText(error) });
          moduleOptions.removeRunDependency(dependency);
        });
      }],
      print: function (messageText) {
        var text = String(messageText);
        send("stdout", { message: text });
        if (text.indexOf("Startup script ended.") !== -1 || text.indexOf("KRKR2WEB_D3_INTERACTIVE_READY") !== -1) {
          send("interactive-ready", {});
        }
      },
      printErr: function (messageText) { send("stderr", { message: String(messageText) }); },
      setStatus: function (status) { send("status", { status: String(status || "") }); },
      monitorRunDependencies: function (count) { send("dependencies", { count: count }); },
      onRuntimeInitialized: function () {
        phase = "runtime-initialized";
        moduleInstance = moduleOptions;
        send("phase", { phase: phase });
        if (!readySent) {
          readySent = true;
          send("ready", { phase: phase });
        }
      },
      onAbort: function (reason) {
        phase = "aborted";
        send("abort", { reason: String(reason) });
      },
      onExit: function (status) {
        phase = "exited";
        send("exit", { status: Number(status || 0) });
      }
    };
    if (message.wasmBinary) { moduleOptions.wasmBinary = new Uint8Array(message.wasmBinary); }
    self.Module = moduleOptions;
    phase = "starting";
    send("phase", { phase: phase });
    moduleInstance = await factory(moduleOptions);
    phase = "running";
    if (pendingVideoCompletionSerial &&
        (pendingVideoCompletionSerial === -1 || pendingVideoCompletionSerial === videoSerial)) {
      try { deliverVideoCompletion(); }
      catch (error) { send("stderr", { message: "Deferred video completion failed: " + errorText(error) }); }
    }
  }

  async function handleRequest(message) {
    var requestId = message.requestId;
    try {
      if (message.command === "sync-saves") {
        await syncFileSystem(false);
        response(requestId, true, { syncedAt: Date.now() });
      } else if (message.command === "storage-snapshot") {
        var bridge = self.krkr2StorageBridge;
        response(requestId, true, bridge && bridge.snapshot ? bridge.snapshot() : null);
      } else if (message.command === "runtime-snapshot") {
        response(requestId, true, {
          phase: phase,
          gameId: currentGameId,
          canvas: engineCanvas ? { width: engineCanvas.width, height: engineCanvas.height } : null
        });
      } else {
        throw new Error("Unknown worker request: " + message.command);
      }
    } catch (error) {
      response(requestId, false, null, error);
    }
  }

  self.addEventListener("message", function (event) {
    var message = event.data || {};
    if (message.channel !== CHANNEL || message.protocolVersion !== PROTOCOL_VERSION) { return; }
    if (message.type === "start") {
      startEngine(message).catch(function (error) {
        phase = "failed";
        send("fatal", { error: errorText(error) });
      });
      return;
    }
    if (Number(message.sessionId || 0) !== sessionId) { return; }
    if (message.type === "input") {
      dispatchInput(message.event);
    } else if (message.type === "resize" && engineCanvas) {
      if (message.width > 0 && message.height > 0) {
        engineCanvas.width = message.width;
        engineCanvas.height = message.height;
        self.innerWidth = message.width;
        self.innerHeight = message.height;
        dispatchInput({ type: "resize" });
      }
    } else if (message.type === "visibility") {
      dispatchInput({
        type: "visibilitychange",
        hidden: !!message.hidden,
        visibilityState: message.hidden ? "hidden" : "visible"
      });
    } else if (message.type === "video-ended") {
      try {
        if (message.videoSerial && Number(message.videoSerial) !== videoSerial) { return; }
        if (videoSerial && completedVideoSerial === videoSerial) { return; }
        completedVideoSerial = videoSerial;
        deliverVideoCompletion();
      } catch (error) { send("stderr", { message: "Video completion failed: " + errorText(error) }); }
    } else if (message.type === "request") {
      handleRequest(message);
    }
  });

  self.addEventListener("error", function (event) {
    send("fatal", { error: event.message || "Worker error" });
  });

  self.addEventListener("unhandledrejection", function (event) {
    send("fatal", { error: errorText(event.reason) });
  });
}());
