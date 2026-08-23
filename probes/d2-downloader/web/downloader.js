(function () {
  "use strict";

  var MAX_CONCURRENCY = 4;
  var MAX_HASH_ATTEMPTS = 3;
  var MAX_NETWORK_ATTEMPTS = 6;
  var NETWORK_RETRY_BASE_MS = 2000;
  var NETWORK_RETRY_MAX_MS = 30000;
  var DELETE_BATCH_SIZE = 32;

  function codedError(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    if (cause) { error.cause = cause; }
    return error;
  }

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function sha256(data) {
    return crypto.subtle.digest("SHA-256", data).then(hex);
  }

  function cloneInstall(install) {
    return JSON.parse(JSON.stringify(install));
  }

  function nowIso() { return new Date().toISOString(); }

  function createMetrics() {
    return {
      startedAt: nowIso(),
      completedAt: null,
      networkRequests: 0,
      networkBytes: 0,
      networkRetries: 0,
      reusedBytes: 0,
      committedBytes: 0,
      hashFailures: 0,
      repairedChunks: 0,
      verifiedChunks: 0,
      pauseCount: 0,
      resumeCount: 0,
      maximumConcurrentRequests: 0,
      maximumInFlightBytes: 0,
      maximumResponseBytes: 0,
      deleteBatches: 0,
      maximumDeleteBatch: 0,
      errors: []
    };
  }

  function Downloader(callbacks, options) {
    this.callbacks = callbacks || {};
    this.options = options || {};
    this.gameId = this.options.gameId || null;
    this.catalogUrl = this.options.catalogUrl || "/catalog.json";
    this.catalog = null;
    this.game = null;
    this.manifest = null;
    this.install = null;
    this.tasks = [];
    this.paused = false;
    this.running = false;
    this.activeRequests = 0;
    this.inFlightBytes = 0;
    this.metrics = createMetrics();
    this.commitChain = Promise.resolve();
    this.repairMode = false;
  }

  Downloader.prototype.emit = function (name, value) {
    if (typeof this.callbacks[name] === "function") { this.callbacks[name](value); }
  };

  Downloader.prototype.snapshot = function () {
    return {
      catalog: this.catalog,
      game: this.game,
      manifest: this.manifest,
      install: this.install,
      metrics: this.metrics,
      paused: this.paused,
      running: this.running,
      pendingChunks: this.tasks.length,
      activeRequests: this.activeRequests
    };
  };

  Downloader.prototype.emitState = function () { this.emit("state", this.snapshot()); };

  Downloader.prototype.fetchJson = function (url) {
    return fetch(url, { cache: "no-store", credentials: "same-origin" }).then(function (response) {
      if (!response.ok) { throw codedError("E_NETWORK", "读取 " + url + " 失败：HTTP " + response.status); }
      var contentType = response.headers.get("Content-Type") || "";
      if (contentType.indexOf("json") === -1) { throw codedError("E_INVALID_MANIFEST", url + " 没有返回 JSON"); }
      return response.json();
    }).catch(function (error) {
      if (error.code) { throw error; }
      throw codedError("E_NETWORK", "读取 " + url + " 失败：" + errorText(error), error);
    });
  };

  Downloader.prototype.load = async function () {
    if (!window.indexedDB || !crypto || !crypto.subtle) {
      throw codedError("E_UNSUPPORTED", "IndexedDB 或 SHA-256 不可用");
    }
    var catalog;
    try {
      catalog = window.d2Storage.validateCatalog(await this.fetchJson(this.catalogUrl));
      await window.d2Storage.storeCatalog(catalog);
    } catch (catalogError) {
      if (catalogError.code !== "E_NETWORK") { throw catalogError; }
      catalog = await window.d2Storage.getLatestCatalog();
      if (!catalog) { throw catalogError; }
      catalog = window.d2Storage.validateCatalog(catalog);
    }
    var game = null;
    if (this.gameId) {
      game = catalog.games.find(function (candidate) { return candidate.gameId === this.gameId; }, this);
    } else {
      game = catalog.games[0];
    }
    if (!game) { throw codedError("E_INVALID_MANIFEST", "目录中不存在所选游戏"); }
    var manifest;
    try {
      manifest = window.d2Storage.validateManifest(await this.fetchJson(game.manifestUrl), game);
      await window.d2Storage.storeManifest(manifest);
    } catch (manifestError) {
      if (manifestError.code !== "E_NETWORK") { throw manifestError; }
      manifest = await window.d2Storage.getManifest(game.gameId, game.version);
      if (!manifest) { throw manifestError; }
      manifest = window.d2Storage.validateManifest(manifest, game);
    }
    this.catalog = catalog;
    this.game = game;
    this.manifest = manifest;
    this.install = await window.d2Storage.getInstall(game.gameId);
    await this.rebuildTasks();
    if (this.install && (
      this.install.pendingVersion === manifest.version || this.install.status === "deleting"
    ) && ["checking-space", "downloading", "verifying", "committing", "deleting"].indexOf(this.install.status) !== -1) {
      this.install.complete = !!this.install.activeVersion && this.install.activeVersion !== manifest.version;
      this.install.activeVersion = this.install.status === "deleting" ? null : this.install.activeVersion;
      this.install.status = this.install.status === "downloading" ? "paused" : "recoverable-error";
      this.install.committedBytes = this.metrics.reusedBytes;
      this.install.lastError = {
        code: "E_CANCELLED",
        message: "上次操作被页面关闭或进程结束中断，可以从已提交块继续",
        at: nowIso()
      };
      await window.d2Storage.putInstall(cloneInstall(this.install));
    }
    var packageBytes = manifest.packages.reduce(function (sum, pkg) { return sum + pkg.size; }, 0);
    if (
      this.install && this.install.activeVersion === manifest.version && this.install.complete === true &&
      this.metrics.reusedBytes !== packageBytes
    ) {
      this.install.complete = false;
      this.install.status = "recoverable-error";
      this.install.committedBytes = this.metrics.reusedBytes;
      this.install.lastError = {
        code: "E_CHUNK_MISSING",
        message: "已完成安装缺少一个或多个资源块",
        at: nowIso()
      };
      await window.d2Storage.putInstall(cloneInstall(this.install));
    }
    this.emitState();
    return this.snapshot();
  };

  Downloader.prototype.taskId = function (pkg, chunkIndex) { return pkg.id + ":" + chunkIndex; };

  Downloader.prototype.rebuildTasks = async function () {
    var manifest = this.manifest;
    var inventory = await window.d2Storage.listManifestInventory(manifest);
    var chunkKeys = {};
    inventory.chunkKeys.forEach(function (key) { chunkKeys[key[2] + ":" + key[3]] = true; });
    var validStates = {};
    inventory.states.forEach(function (state) {
      validStates[state.packageId + ":" + state.chunkIndex] = state;
    });

    var tasks = [];
    var reusedBytes = 0;
    var repairMode = this.repairMode;
    manifest.packages.forEach(function (pkg) {
      pkg.chunks.forEach(function (expectedHash, chunkIndex) {
        var id = pkg.id + ":" + chunkIndex;
        var state = validStates[id];
        var expectedLength = window.d2Storage.expectedChunkLength(pkg, chunkIndex);
        if (chunkKeys[id] && state && state.sha256 === expectedHash && state.length === expectedLength) {
          reusedBytes += expectedLength;
        } else {
          tasks.push({ pkg: pkg, chunkIndex: chunkIndex, repair: repairMode || !!state || !!chunkKeys[id] });
        }
      });
    });
    this.tasks = tasks;
    this.metrics.reusedBytes = reusedBytes;
    this.metrics.committedBytes = reusedBytes;
    if (this.install && this.install.pendingVersion === manifest.version) {
      this.install.committedBytes = reusedBytes;
      this.install.totalBytes = manifest.requiredBytes;
    }
    return tasks;
  };

  Downloader.prototype.checkSpace = async function () {
    if (!navigator.storage || typeof navigator.storage.estimate !== "function") {
      return { supported: false, enough: true, requiredBytes: this.manifest.requiredBytes - this.metrics.committedBytes };
    }
    // krkr2web: best-effort persistence upgrade before the quota check.
    // Non-persistent origins get a fraction-of-disk quota (a fresh desktop
    // profile reported 3 GiB against a 4.65 GiB install); persisted storage
    // is allowed the full disk group, and browsers that deny the request
    // simply keep the old quota, so the call is always safe to make.
    try {
      if (typeof navigator.storage.persist === "function" && !await navigator.storage.persisted()) {
        await navigator.storage.persist();
      }
    } catch (ignored) {}
    var estimate = await navigator.storage.estimate();
    var available = Math.max(0, Number(estimate.quota || 0) - Number(estimate.usage || 0));
    var remaining = Math.max(0, this.manifest.requiredBytes - this.metrics.committedBytes);
    var required = Math.ceil(remaining * 1.15);
    if (available < required) {
      throw codedError("E_QUOTA", "可用站点空间不足：需要约 " + required + " 字节，可用 " + available + " 字节");
    }
    return { supported: true, enough: true, quota: estimate.quota, usage: estimate.usage, available: available, requiredBytes: required };
  };

  Downloader.prototype.makePendingInstall = function (status) {
    var old = this.install || {};
    return {
      gameId: this.manifest.gameId,
      activeVersion: old.activeVersion || null,
      pendingVersion: this.manifest.version,
      status: status,
      complete: old.complete === true && !!old.activeVersion,
      committedBytes: this.metrics.committedBytes,
      totalBytes: this.manifest.requiredBytes,
      updatedAt: nowIso(),
      lastError: null
    };
  };

  Downloader.prototype.persistStatus = async function (status, error) {
    this.install.status = status;
    this.install.updatedAt = nowIso();
    this.install.lastError = error ? { code: error.code || "E_UNKNOWN", message: errorText(error), at: nowIso() } : null;
    await window.d2Storage.putInstall(cloneInstall(this.install));
    this.emitState();
  };

  Downloader.prototype.downloadChunk = async function (task) {
    var pkg = task.pkg;
    var start = task.chunkIndex * pkg.chunkSize;
    var length = window.d2Storage.expectedChunkLength(pkg, task.chunkIndex);
    var end = start + length - 1;
    this.activeRequests += 1;
    this.inFlightBytes += length;
    this.metrics.networkRequests += 1;
    this.metrics.maximumConcurrentRequests = Math.max(this.metrics.maximumConcurrentRequests, this.activeRequests);
    this.metrics.maximumInFlightBytes = Math.max(this.metrics.maximumInFlightBytes, this.inFlightBytes);
    this.emitState();
    var response;
    try {
      response = await fetch(pkg.url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Range: "bytes=" + start + "-" + end, "If-Match": '"sha256-' + pkg.sha256 + '"' }
      });
      if (response.status === 412) { throw codedError("E_VERSION_CHANGED", "服务器资源与 Manifest 版本不一致"); }
      if (response.status === 404 || response.status === 410) { throw codedError("E_VERSION_CHANGED", "Manifest 中的服务器资源已经不存在"); }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw codedError("E_NETWORK", "服务器暂时无法提供资源块：HTTP " + response.status);
      }
      if (response.status !== 206) { throw codedError("E_RANGE", "服务器没有按 Range 返回资源块：HTTP " + response.status); }
      var expectedRange = "bytes " + start + "-" + end + "/" + pkg.size;
      if ((response.headers.get("Content-Range") || "") !== expectedRange) {
        throw codedError("E_RANGE", "Content-Range 与请求不一致");
      }
      var data = await response.arrayBuffer();
      if (data.byteLength !== length) { throw codedError("E_RANGE", "资源块长度不正确"); }
      this.metrics.maximumResponseBytes = Math.max(this.metrics.maximumResponseBytes, data.byteLength);
      var actualHash = await sha256(data);
      if (actualHash !== pkg.chunks[task.chunkIndex]) {
        this.metrics.hashFailures += 1;
        task.hashAttempts = (task.hashAttempts || 0) + 1;
        if (task.hashAttempts < MAX_HASH_ATTEMPTS) { return { retry: true }; }
        throw codedError("E_VERSION_CHANGED", "资源块连续三次校验失败，服务器内容可能已变化");
      }
      this.metrics.networkBytes += data.byteLength;
      var self = this;
      var commit = this.commitChain.then(async function () {
        var nextCommittedBytes = self.metrics.committedBytes + data.byteLength;
        var nextInstall = cloneInstall(self.install);
        nextInstall.committedBytes = nextCommittedBytes;
        nextInstall.updatedAt = nowIso();
        await window.d2Storage.commitChunk(self.manifest, pkg, task.chunkIndex, data, nextInstall);
        self.metrics.committedBytes = nextCommittedBytes;
        if (task.repair) { self.metrics.repairedChunks += 1; }
        self.install = nextInstall;
        self.emit("progress", self.snapshot());
      });
      this.commitChain = commit.catch(function () {});
      await commit;
      return { retry: false };
    } catch (error) {
      if (error && error.name === "QuotaExceededError") { throw codedError("E_QUOTA", "IndexedDB 配额不足", error); }
      if (error.code) { throw error; }
      throw codedError("E_NETWORK", "下载资源块失败：" + errorText(error), error);
    } finally {
      this.activeRequests -= 1;
      this.inFlightBytes -= length;
      this.emitState();
    }
  };

  Downloader.prototype.worker = async function (shared) {
    var self = this;
    while (!shared.failure && !this.paused) {
      var task = this.tasks.shift();
      if (!task) { return; }
      try {
        var result = await this.downloadChunk(task);
        if (result.retry) { this.tasks.push(task); }
      } catch (error) {
        var retriable = error && error.code === "E_NETWORK" &&
          (task.networkAttempts || 0) < MAX_NETWORK_ATTEMPTS;
        if (retriable) {
          task.networkAttempts = (task.networkAttempts || 0) + 1;
          this.metrics.networkRetries += 1;
          this.tasks.unshift(task);
          var delay = Math.min(
            NETWORK_RETRY_BASE_MS * Math.pow(2, task.networkAttempts - 1),
            NETWORK_RETRY_MAX_MS
          );
          this.emit("retry", {
            packageId: task.pkg.id,
            chunkIndex: task.chunkIndex,
            attempt: task.networkAttempts,
            delayMs: delay,
            message: errorText(error)
          });
          await new Promise(function (resolve) { setTimeout(resolve, delay); });
        } else {
          this.tasks.unshift(task);
          shared.failure = error;
        }
      }
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
  };

  Downloader.prototype.start = async function () {
    if (this.running) { return this.snapshot(); }
    if (!this.manifest) { await this.load(); }
    if (this.install && this.install.activeVersion === this.manifest.version && this.install.complete) {
      return this.verify();
    }
    this.running = true;
    this.paused = false;
    this.metrics.resumeCount += this.install && ["paused", "recoverable-error"].indexOf(this.install.status) !== -1 ? 1 : 0;
    try {
      await this.rebuildTasks();
      this.install = this.makePendingInstall("checking-space");
      await window.d2Storage.putInstall(cloneInstall(this.install));
      this.emitState();
      var space = await this.checkSpace();
      this.emit("space", space);
      await this.persistStatus("downloading");
      var shared = { failure: null };
      var workers = [];
      for (var index = 0; index < MAX_CONCURRENCY; index += 1) {
        workers.push(this.worker(shared).catch(function (error) { shared.failure = shared.failure || error; }));
      }
      await Promise.all(workers);
      if (shared.failure) { throw shared.failure; }
      if (this.paused) {
        await this.persistStatus("paused");
        return this.snapshot();
      }
      if (this.tasks.length !== 0) { throw codedError("E_STORAGE", "下载任务意外中止"); }
      this.running = false;
      return await this.verify();
    } catch (error) {
      this.metrics.errors.push({ code: error.code || "E_UNKNOWN", message: errorText(error), at: nowIso() });
      var fatal = ["E_INVALID_MANIFEST", "E_VERSION_CHANGED", "E_RANGE"].indexOf(error.code) !== -1;
      await this.persistStatus(fatal ? "fatal-error" : "recoverable-error", error);
      throw error;
    } finally {
      this.running = false;
      this.emitState();
    }
  };

  Downloader.prototype.pause = function () {
    if (!this.running || this.paused) { return; }
    this.paused = true;
    this.metrics.pauseCount += 1;
    this.emitState();
  };

  Downloader.prototype.verify = async function () {
    if (this.running) { return this.snapshot(); }
    this.running = true;
    var broken = [];
    try {
      this.install = this.install || this.makePendingInstall("verifying");
      this.install.pendingVersion = this.manifest.version;
      if (!this.install.activeVersion || this.install.activeVersion === this.manifest.version) {
        this.install.complete = false;
      }
      await this.persistStatus("verifying");
      for (var packageIndex = 0; packageIndex < this.manifest.packages.length; packageIndex += 1) {
        var pkg = this.manifest.packages[packageIndex];
        for (var chunkIndex = 0; chunkIndex < pkg.chunks.length; chunkIndex += 1) {
          var record = await window.d2Storage.getChunk(this.manifest, pkg, chunkIndex);
          var expectedLength = window.d2Storage.expectedChunkLength(pkg, chunkIndex);
          var valid = record instanceof ArrayBuffer && record.byteLength === expectedLength;
          if (valid) { valid = await sha256(record) === pkg.chunks[chunkIndex]; }
          this.metrics.verifiedChunks += 1;
          if (!valid) {
            broken.push({ pkg: pkg, chunkIndex: chunkIndex, repair: true });
            await window.d2Storage.deleteChunk(this.manifest, pkg, chunkIndex);
          }
          this.emit("verifyProgress", {
            packageId: pkg.id,
            chunkIndex: chunkIndex,
            broken: broken.length,
            metrics: this.metrics
          });
          if (chunkIndex % 8 === 0) { await new Promise(function (resolve) { setTimeout(resolve, 0); }); }
        }
      }
      if (broken.length) {
        await this.rebuildTasks();
        this.tasks.forEach(function (task) { task.repair = true; });
        this.install.committedBytes = this.metrics.reusedBytes;
        var integrityError = codedError("E_INTEGRITY", "发现 " + broken.length + " 个损坏或缺失块，可单独修复");
        await this.persistStatus("recoverable-error", integrityError);
        throw integrityError;
      }
      await this.persistStatus("committing");
      this.install = {
        gameId: this.manifest.gameId,
        activeVersion: this.manifest.version,
        pendingVersion: null,
        status: "ready",
        complete: true,
        committedBytes: this.manifest.requiredBytes,
        totalBytes: this.manifest.requiredBytes,
        updatedAt: nowIso(),
        completedAt: nowIso(),
        lastError: null
      };
      await window.d2Storage.putInstall(cloneInstall(this.install));
      this.metrics.completedAt = nowIso();
      this.emitState();
      return this.snapshot();
    } catch (error) {
      if (!this.install || this.install.status !== "recoverable-error") {
        this.install = this.install || this.makePendingInstall("recoverable-error");
        await this.persistStatus("recoverable-error", error);
      }
      throw error;
    } finally {
      this.running = false;
      this.emitState();
    }
  };

  Downloader.prototype.repair = async function () {
    this.repairMode = true;
    try {
      await this.rebuildTasks();
      if (!this.tasks.length) { return this.verify(); }
      return await this.start();
    } finally {
      this.repairMode = false;
    }
  };

  Downloader.prototype.tamperFirstChunk = async function () {
    var pkg = this.manifest.packages[0];
    await window.d2Storage.tamperChunk(this.manifest, pkg, 0);
    return { packageId: pkg.id, chunkIndex: 0 };
  };

  Downloader.prototype.deleteGame = async function () {
    if (this.running) { throw codedError("E_CANCELLED", "下载或校验运行时不能删除"); }
    this.running = true;
    try {
      this.metrics.deleteBatches = 0;
      this.metrics.maximumDeleteBatch = 0;
      this.install = this.install || this.makePendingInstall("deleting");
      this.install.status = "deleting";
      this.install.complete = false;
      this.install.activeVersion = null;
      await window.d2Storage.putInstall(cloneInstall(this.install));
      var keys = await window.d2Storage.listGameChunkKeys(this.manifest.gameId);
      for (var index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
        var batch = keys.slice(index, index + DELETE_BATCH_SIZE);
        await window.d2Storage.deleteChunkBatch(batch);
        this.metrics.deleteBatches += 1;
        this.metrics.maximumDeleteBatch = Math.max(this.metrics.maximumDeleteBatch, batch.length);
        this.emit("deleteProgress", { deleted: Math.min(index + batch.length, keys.length), total: keys.length });
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
      this.install = {
        gameId: this.manifest.gameId,
        activeVersion: null,
        pendingVersion: null,
        status: "not-installed",
        complete: false,
        committedBytes: 0,
        totalBytes: this.manifest.requiredBytes,
        updatedAt: nowIso(),
        lastError: null
      };
      await window.d2Storage.putInstall(cloneInstall(this.install));
      this.tasks = [];
      this.metrics.committedBytes = 0;
      this.metrics.reusedBytes = 0;
      this.emitState();
      return {
        deletedChunks: keys.length,
        batches: this.metrics.deleteBatches,
        maximumBatch: this.metrics.maximumDeleteBatch
      };
    } finally {
      this.running = false;
      this.emitState();
    }
  };

  window.D2Downloader = Downloader;
}());
