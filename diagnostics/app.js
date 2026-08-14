(function () {
  'use strict';

  var BUILD_VERSION = '2026-08-12.8';
  var SHELL_CACHE_NAME = 'krkr2-diagnostics-v9';
  var AUTO_DB_PREFIX = 'krkr2-diagnostics-auto-v1';
  var STRESS_DB = 'krkr2-diagnostics-stress-v1';
  var MiB = 1024 * 1024;
  var tests = [];
  var testMap = {};
  var results = {};
  var stressCancelled = false;
  var stressRunning = false;
  var stressConfirmation = null;

  var elements = {
    overall: document.getElementById('overall'),
    overallText: document.getElementById('overallText'),
    summaryText: document.getElementById('summaryText'),
    originText: document.getElementById('originText'),
    runButton: document.getElementById('runButton'),
    copyButton: document.getElementById('copyButton'),
    uploadButton: document.getElementById('uploadButton'),
    uploadStatus: document.getElementById('uploadStatus'),
    testList: document.getElementById('testList'),
    progressText: document.getElementById('progressText'),
    coreMetric: document.getElementById('coreMetric'),
    quotaMetric: document.getElementById('quotaMetric'),
    writeMetric: document.getElementById('writeMetric'),
    graphicsMetric: document.getElementById('graphicsMetric'),
    stressSize: document.getElementById('stressSize'),
    stressButton: document.getElementById('stressButton'),
    cancelStressButton: document.getElementById('cancelStressButton'),
    stressState: document.getElementById('stressState'),
    stressProgress: document.getElementById('stressProgress'),
    stressDetail: document.getElementById('stressDetail'),
    report: document.getElementById('report'),
    buildVersion: document.getElementById('buildVersion')
  };

  function addTest(id, name, critical, runner) {
    var test = { id: id, name: name, critical: critical, runner: runner };
    tests.push(test);
    testMap[id] = test;
  }

  function pass(detail, data) { return { state: 'pass', detail: detail, data: data }; }
  function warn(detail, data) { return { state: 'warn', detail: detail, data: data }; }
  function fail(detail, data) { return { state: 'fail', detail: detail, data: data }; }

  function formatBytes(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '未知';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var size = value;
    var unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    var digits = unit > 1 ? 2 : unit === 1 ? 1 : 0;
    return size.toFixed(digits) + ' ' + units[unit];
  }

  function formatRate(bytes, milliseconds) {
    if (!milliseconds) return '--';
    return ((bytes / MiB) / (milliseconds / 1000)).toFixed(1) + ' MiB/s';
  }

  function errorText(error) {
    if (!error) return '未知错误';
    return String(error.name ? error.name + ': ' + error.message : error.message || error);
  }

  function timeout(promise, milliseconds, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(label + ' 超时')); }, milliseconds);
      promise.then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function isCertificateError(error) {
    return /certificate|\bcert\b|ssl|证书/i.test(errorText(error));
  }

  function waitForWorkerActivation(registration) {
    var worker = registration.installing || registration.waiting || registration.active;
    if (!worker) return Promise.reject(new Error('Service Worker 注册后没有可用实例'));
    if (worker.state === 'activated') return Promise.resolve(worker.state);
    return new Promise(function (resolve, reject) {
      worker.addEventListener('statechange', function () {
        if (worker.state === 'activated') resolve(worker.state);
        if (worker.state === 'redundant') reject(new Error('Service Worker 安装失败并进入 redundant 状态'));
      });
    });
  }

  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB 请求失败')); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error('IndexedDB 事务失败')); };
      transaction.onabort = function () { reject(transaction.error || new Error('IndexedDB 事务中止')); };
    });
  }

  function openChunkDatabase(name) {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(name, 1);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () { db.close(); };
        resolve(db);
      };
      request.onerror = function () { reject(request.error || new Error('无法打开 IndexedDB')); };
      request.onblocked = function () { reject(new Error('IndexedDB 被其他页面占用')); };
    });
  }

  function deleteDatabase(name) {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.deleteDatabase(name);
      var blocked = false;
      var timer = setTimeout(function () {
        reject(new Error(blocked ? '测试数据库仍被其他页面占用；请关闭其他检测页' : '删除测试数据库超时'));
      }, 5000);
      request.onsuccess = function () { clearTimeout(timer); resolve(); };
      request.onerror = function () { clearTimeout(timer); reject(request.error || new Error('无法删除测试数据库')); };
      request.onblocked = function () { blocked = true; };
    });
  }

  async function inspectIsolationHeaders() {
    var data = { coop: null, coep: null, error: null };
    try {
      var response = await timeout(fetch(location.href, {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'same-origin'
      }), 10000, '隔离响应头检测');
      data.coop = response.headers.get('Cross-Origin-Opener-Policy');
      data.coep = response.headers.get('Cross-Origin-Embedder-Policy');
    } catch (error) {
      data.error = errorText(error);
    }
    return data;
  }

  function makePatternChunk(size, index) {
    var bytes = new Uint8Array(size);
    var cryptoObject = window.crypto || window.msCrypto;
    if (!cryptoObject || !cryptoObject.getRandomValues) throw new Error('安全随机数 API 不可用');
    for (var offset = 0; offset < size; offset += 65536) {
      cryptoObject.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
    }
    var view = new DataView(bytes.buffer);
    view.setUint32(0, index >>> 0, true);
    view.setUint32(size - 4, (index ^ 0xa5a5a5a5) >>> 0, true);
    return bytes;
  }

  function verifyPatternChunkMarkers(buffer, size, index) {
    var bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== size) return false;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(0, true) === (index >>> 0) &&
      view.getUint32(size - 4, true) === ((index ^ 0xa5a5a5a5) >>> 0);
  }

  async function digestHex(buffer) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('Web Crypto SHA-256 不可用');
    var digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', buffer));
    var parts = [];
    for (var i = 0; i < digest.length; i += 1) parts.push(digest[i].toString(16).padStart(2, '0'));
    return parts.join('');
  }

  async function makeStoredChunk(size, index) {
    var bytes = makePatternChunk(size, index);
    return { data: bytes.buffer, sha256: await digestHex(bytes.buffer) };
  }

  async function verifyStoredChunk(value, size, index) {
    return !!value && value.data instanceof ArrayBuffer &&
      verifyPatternChunkMarkers(value.data, size, index) &&
      value.sha256 === await digestHex(value.data);
  }

  function parseUserAgent() {
    var ua = navigator.userAgent;
    var chrome = /(?:Chrome|CriOS)\/(\d+(?:\.\d+)*)/.exec(ua);
    var android = /Android\s+([^;\)]+)/.exec(ua);
    var webView = /;\s*wv\)/.test(ua) || /\bVersion\/4\.0\b/.test(ua) && /\bChrome\//.test(ua);
    return {
      ua: ua,
      chromeVersion: chrome ? chrome[1] : null,
      androidVersion: android ? android[1].trim() : null,
      appearsToBeWebView: webView
    };
  }

  function renderRows() {
    elements.testList.innerHTML = '';
    tests.forEach(function (test) {
      var row = document.createElement('div');
      row.className = 'test-row';
      row.id = 'test-' + test.id;
      row.setAttribute('data-state', 'idle');
      row.innerHTML = '<span class="status-icon">·</span>' +
        '<span class="test-name"></span>' +
        '<span class="test-detail">尚未检测</span>' +
        '<span class="badge neutral">等待</span>';
      row.querySelector('.test-name').textContent = test.name;
      elements.testList.appendChild(row);
    });
    elements.progressText.textContent = '0 / ' + tests.length;
  }

  function setRowState(id, state, detail) {
    var row = document.getElementById('test-' + id);
    if (!row) return;
    row.setAttribute('data-state', state);
    row.querySelector('.status-icon').textContent = state === 'pass' ? '✓' : state === 'warn' ? '!' : state === 'fail' ? '×' : state === 'running' ? '…' : '·';
    row.querySelector('.test-detail').textContent = detail || '';
    var badge = row.querySelector('.badge');
    badge.className = 'badge ' + (state === 'running' || state === 'idle' ? 'neutral' : state);
    badge.textContent = state === 'pass' ? '通过' : state === 'warn' ? '注意' : state === 'fail' ? '失败' : state === 'running' ? '检测中' : '等待';
  }

  function updateOverall() {
    var completed = Object.keys(results).length;
    var criticalFailures = tests.filter(function (test) {
      return test.critical && results[test.id] && results[test.id].state === 'fail';
    });
    var failures = tests.filter(function (test) { return results[test.id] && results[test.id].state === 'fail'; });
    var warnings = tests.filter(function (test) { return results[test.id] && results[test.id].state === 'warn'; });

    elements.progressText.textContent = completed + ' / ' + tests.length;
    if (completed < tests.length) return;

    if (criticalFailures.length) {
      elements.overall.dataset.state = 'fail';
      elements.overallText.textContent = '存在阻断项';
      elements.summaryText.textContent = '检测发现 ' + criticalFailures.length + ' 个核心阻断项，请把报告发给开发者。';
    } else if (failures.length || warnings.length) {
      elements.overall.dataset.state = 'warn';
      elements.overallText.textContent = '需要实机验证';
      elements.summaryText.textContent = '核心能力可继续验证；仍有 ' + (failures.length + warnings.length) + ' 项风险。';
    } else {
      elements.overall.dataset.state = 'pass';
      elements.overallText.textContent = '基础能力通过';
      elements.summaryText.textContent = '基础能力已通过，请继续执行 64 MB 和 5 GB 存储压力测试。';
    }

    var criticalPassed = tests.filter(function (test) {
      return test.critical && results[test.id] && results[test.id].state === 'pass';
    }).length;
    var criticalTotal = tests.filter(function (test) { return test.critical; }).length;
    elements.coreMetric.textContent = criticalPassed + ' / ' + criticalTotal;

    var storage = results.storage;
    if (storage && storage.data && typeof storage.data.quota === 'number') elements.quotaMetric.textContent = formatBytes(storage.data.quota);
    var idb = results.indexeddb;
    if (idb && idb.data) elements.writeMetric.textContent = idb.data.writeRate || '--';
    var graphics = results.graphics;
    if (graphics && graphics.data) elements.graphicsMetric.textContent = graphics.data.webgl2 ? 'WebGL 2' : graphics.data.webgl1 ? 'WebGL 1' : '不可用';
  }

  function deviceSnapshot() {
    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        pixelRatio: window.devicePixelRatio,
        orientation: screen.orientation ? screen.orientation.type : null
      },
      viewport: { width: innerWidth, height: innerHeight },
      connection: connection ? {
        effectiveType: connection.effectiveType,
        downlink: connection.downlink,
        rtt: connection.rtt,
        saveData: connection.saveData
      } : null,
      origin: location.origin,
      href: location.origin + location.pathname,
      urlParametersRedacted: !!(location.search || location.hash),
      protocol: location.protocol,
      secureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      timestamp: new Date().toISOString()
    };
  }

  function buildReport() {
    return {
      reportVersion: 1,
      diagnosticsBuild: BUILD_VERSION,
      device: deviceSnapshot(),
      parsedUserAgent: parseUserAgent(),
      results: results,
      stress: window.__krkr2StressResult || null
    };
  }

  function refreshReport() {
    elements.report.value = JSON.stringify(buildReport(), null, 2);
    elements.copyButton.disabled = false;
    elements.uploadButton.disabled = Object.keys(results).length !== tests.length;
  }

  async function copyReport() {
    var text = elements.report.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        elements.report.focus();
        elements.report.select();
        if (!document.execCommand('copy')) throw new Error('复制命令失败');
      }
      elements.copyButton.textContent = '已复制';
      setTimeout(function () { elements.copyButton.textContent = '复制报告'; }, 1500);
    } catch (error) {
      elements.copyButton.textContent = '请长按报告复制';
      elements.report.focus();
      elements.report.select();
    }
  }

  async function uploadReport() {
    if (elements.uploadButton.disabled) return;
    var originalText = elements.uploadButton.textContent;
    elements.uploadButton.disabled = true;
    elements.uploadButton.textContent = '正在上传';
    elements.uploadStatus.dataset.state = '';
    elements.uploadStatus.textContent = '正在将当前检测结果发送到本机检测服务器…';
    try {
      var response = await timeout(fetch('/api/diagnostics-reports', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReport())
      }), 15000, '报告上传');
      var responseText = await response.text();
      var payload;
      try { payload = JSON.parse(responseText); } catch (ignoredJson) { payload = null; }
      if (!response.ok || !payload || !payload.ok) {
        throw new Error(payload && payload.error ? payload.error : '服务器返回 HTTP ' + response.status);
      }
      elements.uploadButton.textContent = '上传成功';
      elements.uploadStatus.dataset.state = 'pass';
      elements.uploadStatus.textContent = '报告编号：' + payload.reportId;
      setTimeout(function () { elements.uploadButton.textContent = originalText; }, 2500);
    } catch (error) {
      elements.uploadButton.textContent = '重新上传';
      elements.uploadStatus.dataset.state = 'fail';
      elements.uploadStatus.textContent = '上传失败：' + errorText(error);
    } finally {
      elements.uploadButton.disabled = false;
    }
  }

  addTest('environment', 'HTTPS 与页面环境', true, async function () {
    var data = {
      protocol: location.protocol,
      secureContext: window.isSecureContext,
      origin: location.origin,
      crossOriginIsolated: window.crossOriginIsolated === true
    };
    data.isolationHeaders = await inspectIsolationHeaders();
    if (location.protocol !== 'https:' || !window.isSecureContext) return fail('页面不是受信任的 HTTPS 安全上下文', data);
    return pass('HTTPS 安全上下文已建立；origin=' + location.origin, data);
  });

  addTest('browser', 'WebView 与系统信息', false, async function () {
    var parsed = parseUserAgent();
    var data = { parsed: parsed, snapshot: deviceSnapshot() };
    var version = parsed.chromeVersion ? parseInt(parsed.chromeVersion.split('.')[0], 10) : null;
    var detail = 'Chromium ' + (parsed.chromeVersion || '未知') + ' · Android ' + (parsed.androidVersion || '未知') + ' · ' + (parsed.appearsToBeWebView ? 'WebView' : '未识别为 WebView');
    if (version !== 89) return warn(detail, data);
    return pass(detail, data);
  });

  addTest('serviceworker', '离线应用壳', true, async function () {
    var data = { serviceWorker: 'serviceWorker' in navigator, caches: 'caches' in window };
    if (!data.caches) return fail('Cache Storage API 不可用', data);

    var probeCacheName = 'krkr2-diagnostics-probe-' + Date.now();
    try {
      var cache = await caches.open(probeCacheName);
      var request = new Request('/cache-probe-' + Date.now());
      var response = new Response('krkr2-cache-ok', { headers: { 'Content-Type': 'text/plain' } });
      await cache.put(request, response);
      var hit = await cache.match(request);
      var body = hit ? await hit.text() : '';
      if (body !== 'krkr2-cache-ok') return fail('Cache Storage 写入后读取不一致', data);
      data.cacheStorageReadWrite = true;
    } catch (error) {
      data.cacheStorageError = errorText(error);
      return fail('Cache Storage 读写失败：' + data.cacheStorageError, data);
    } finally {
      try { await caches.delete(probeCacheName); } catch (ignoredCacheDelete) {}
    }

    if (!data.serviceWorker) return fail('Cache Storage 读写通过，但 Service Worker API 不可用', data);

    try {
      var scriptUrl = '/sw.js?v=' + encodeURIComponent(BUILD_VERSION);
      var registration = await timeout(navigator.serviceWorker.register(scriptUrl, { scope: '/' }), 10000, 'Service Worker 注册');
      data.scope = registration.scope;
      data.scriptUrl = scriptUrl;
      data.workerState = await timeout(waitForWorkerActivation(registration), 15000, 'Service Worker 激活');
      data.shellCaches = await caches.keys();
      data.shellCachePresent = data.shellCaches.indexOf(SHELL_CACHE_NAME) !== -1;
      if (!data.shellCachePresent) return fail('Service Worker 已激活，但离线应用壳缓存未生成', data);
      return pass('Service Worker 已激活，Cache Storage 与离线应用壳均正常', data);
    } catch (error) {
      data.serviceWorkerError = errorText(error);
      if (isCertificateError(error)) {
        data.certificateBlocked = true;
        return warn('Cache Storage 通过；测试证书被 Service Worker 拒绝，需用受系统信任的证书复测', data);
      }
      return fail('Cache Storage 通过；Service Worker 失败：' + data.serviceWorkerError, data);
    }
  });

  addTest('storage', '站点配额与持久化', true, async function () {
    var data = { estimateSupported: !!(navigator.storage && navigator.storage.estimate) };
    if (!data.estimateSupported) return fail('StorageManager.estimate 不可用', data);
    try {
      var estimate = await navigator.storage.estimate();
      data.quota = estimate.quota;
      data.usage = estimate.usage;
      data.available = typeof estimate.quota === 'number' && typeof estimate.usage === 'number' ? estimate.quota - estimate.usage : null;
      if (navigator.storage.persisted) data.persistedBefore = await navigator.storage.persisted();
      if (!data.persistedBefore && navigator.storage.persist) data.persistRequest = await navigator.storage.persist();
      if (navigator.storage.persisted) data.persistedAfter = await navigator.storage.persisted();
      var detail = '配额 ' + formatBytes(data.quota) + ' · 已用 ' + formatBytes(data.usage) + ' · 持久化 ' + (data.persistedAfter ? '是' : '否');
      if (typeof data.available === 'number' && data.available < 5 * 1024 * MiB) return fail(detail + '；不足 5 GiB 压力测试', data);
      if (!data.persistedAfter) return warn(detail + '；必须完成关闭 App 和重启保留测试', data);
      return pass(detail, data);
    } catch (error) {
      data.error = errorText(error);
      return fail(data.error, data);
    }
  });

  addTest('indexeddb', 'IndexedDB 分块读写', true, async function () {
    var data = { supported: 'indexedDB' in window, bytes: 32 * MiB, chunkBytes: 4 * MiB };
    if (!data.supported) return fail('IndexedDB 不可用', data);
    var databaseName = AUTO_DB_PREFIX + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var db;
    try {
      db = await openChunkDatabase(databaseName);
      var chunkCount = data.bytes / data.chunkBytes;
      var writeStarted = performance.now();
      for (var index = 0; index < chunkCount; index += 1) {
        var storedChunk = await makeStoredChunk(data.chunkBytes, index);
        var transaction = db.transaction('chunks', 'readwrite');
        transaction.objectStore('chunks').put(storedChunk, index);
        await transactionDone(transaction);
      }
      data.writeMs = Math.round(performance.now() - writeStarted);
      var readStarted = performance.now();
      var readOrder = [chunkCount - 1, 0, Math.floor(chunkCount / 2)];
      for (var i = 0; i < readOrder.length; i += 1) {
        var readTransaction = db.transaction('chunks', 'readonly');
        var readTransactionDone = transactionDone(readTransaction);
        var storedChunk = await requestPromise(readTransaction.objectStore('chunks').get(readOrder[i]));
        await readTransactionDone;
        if (!await verifyStoredChunk(storedChunk, data.chunkBytes, readOrder[i])) throw new Error('第 ' + readOrder[i] + ' 块 SHA-256 校验失败');
      }
      data.readMs = Math.round(performance.now() - readStarted);
      data.writeRate = formatRate(data.bytes, data.writeMs);
      data.randomReadRate = formatRate(readOrder.length * data.chunkBytes, data.readMs);
      db.close(); db = null;
      await deleteDatabase(databaseName);
      return pass('32 MiB 校验通过 · 写 ' + data.writeRate + ' · 随机读 ' + data.randomReadRate, data);
    } catch (error) {
      if (db) db.close();
      try { await deleteDatabase(databaseName); } catch (ignoredDelete) {}
      data.error = errorText(error);
      return fail(data.error, data);
    }
  });

  addTest('sharedmemory', '共享内存与跨源隔离', true, async function () {
    var data = {
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      crossOriginIsolated: window.crossOriginIsolated === true,
      atomicsWait: typeof Atomics === 'object' && typeof Atomics.wait === 'function',
      atomicsNotify: typeof Atomics === 'object' && typeof Atomics.notify === 'function'
    };
    data.isolationHeaders = await inspectIsolationHeaders();
    if (!data.sharedArrayBuffer || !data.atomicsWait || !data.atomicsNotify || !data.crossOriginIsolated) {
      if (data.isolationHeaders.coop === 'same-origin' && data.isolationHeaders.coep === 'require-corp') {
        return fail('COOP/COEP 响应头正确，但此 WebView 未开放跨源隔离或共享内存', data);
      }
      return fail('共享内存不可用；COOP=' + (data.isolationHeaders.coop || '缺失') + ' · COEP=' + (data.isolationHeaders.coep || '缺失'), data);
    }
    return pass('SharedArrayBuffer、Atomics 和跨源隔离均可用', data);
  });

  addTest('atomicsworker', 'Worker 同步等待桥', true, async function () {
    var data = { worker: typeof Worker === 'function' };
    if (!data.worker || typeof SharedArrayBuffer !== 'function') return fail('Worker 或 SharedArrayBuffer 不可用', data);
    var source = [
      "self.onmessage=function(event){",
      "var view=new Int32Array(event.data);",
      "self.postMessage({phase:'ready'});",
      "var result=Atomics.wait(view,0,0,3000);",
      "self.postMessage({phase:'done',result:result,value:Atomics.load(view,0)});",
      "};"
    ].join('');
    var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    var worker = new Worker(url);
    try {
      var shared = new SharedArrayBuffer(4);
      var view = new Int32Array(shared);
      var outcome = await timeout(new Promise(function (resolve, reject) {
        worker.onerror = function (event) { reject(new Error(event.message || 'Worker 执行失败')); };
        worker.onmessage = function (event) {
          if (event.data.phase === 'ready') {
            setTimeout(function () {
              Atomics.store(view, 0, 37);
              data.notified = Atomics.notify(view, 0, 1);
            }, 50);
          } else if (event.data.phase === 'done') resolve(event.data);
        };
        worker.postMessage(shared);
      }), 5000, 'Atomics Worker');
      data.outcome = outcome;
      if (outcome.result !== 'ok' || outcome.value !== 37) return fail('Worker 未被正确唤醒', data);
      return pass('I/O Worker 可唤醒等待中的引擎 Worker', data);
    } catch (error) {
      data.error = errorText(error);
      return fail(data.error, data);
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });

  addTest('wasm', 'WebAssembly 与线程内存', true, async function () {
    var data = { webAssembly: typeof WebAssembly === 'object' };
    if (!data.webAssembly) return fail('WebAssembly 不可用', data);
    try {
      var bytes = new Uint8Array([0,97,115,109,1,0,0,0]);
      var module = await WebAssembly.compile(bytes);
      await WebAssembly.instantiate(module);
      data.core = true;
      var memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
      data.sharedMemory = typeof SharedArrayBuffer === 'function' && memory.buffer instanceof SharedArrayBuffer;
      data.memoryBytes = memory.buffer.byteLength;
      if (!data.sharedMemory) return fail('Wasm 共享内存创建失败', data);
      return pass('Wasm 核心和共享线性内存可用', data);
    } catch (error) {
      data.error = errorText(error);
      return fail(data.error, data);
    }
  });

  addTest('graphics', 'WebGL 图形能力', true, async function () {
    var canvas = document.createElement('canvas');
    var options = { alpha: true, antialias: false, preserveDrawingBuffer: false };
    var gl2 = canvas.getContext('webgl2', options);
    var gl = gl2 || canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
    var data = { webgl2: !!gl2, webgl1: !!gl, renderer: null, vendor: null };
    if (!gl) return fail('WebGL 不可用', data);
    try {
      data.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      data.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
      data.version = gl.getParameter(gl.VERSION);
      data.shadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
      var debug = gl.getExtension('WEBGL_debug_renderer_info');
      if (debug) {
        data.renderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
        data.vendor = gl.getParameter(debug.UNMASKED_VENDOR_WEBGL);
      }
    } catch (ignored) {}
    return pass((data.webgl2 ? 'WebGL 2' : 'WebGL 1') + ' · 最大纹理 ' + (data.maxTextureSize || '未知') + ' · ' + (data.renderer || '渲染器未知'), data);
  });

  addTest('audio', 'Web Audio 与音频格式', true, async function () {
    var AudioContextType = window.AudioContext || window.webkitAudioContext;
    var audio = document.createElement('audio');
    var data = {
      webAudio: !!AudioContextType,
      oggVorbis: audio.canPlayType('audio/ogg; codecs="vorbis"'),
      opusOgg: audio.canPlayType('audio/ogg; codecs="opus"'),
      opusWebm: audio.canPlayType('audio/webm; codecs="opus"'),
      aacMp4: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"')
    };
    if (!data.webAudio) return fail('Web Audio 不可用', data);
    var supported = [data.oggVorbis, data.opusOgg, data.opusWebm, data.aacMp4].filter(function (value) { return !!value; }).length;
    if (!supported) return warn('Web Audio 可用，但未报告常见音频格式支持', data);
    return pass('Web Audio 可用 · OGG ' + (data.oggVorbis || '否') + ' · Opus ' + (data.opusOgg || data.opusWebm || '否'), data);
  });

  addTest('video', '未来视频解码能力', false, async function () {
    var video = document.createElement('video');
    var data = {
      h264Baseline: video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      h264Main: video.canPlayType('video/mp4; codecs="avc1.4D401F"'),
      vp8: video.canPlayType('video/webm; codecs="vp8, vorbis"'),
      vp9: video.canPlayType('video/webm; codecs="vp9"'),
      wmv: video.canPlayType('video/x-ms-wmv')
    };
    if (!data.h264Baseline && !data.h264Main && !data.vp8 && !data.vp9) return warn('未报告 MP4/WebM 解码支持；未来视频方案需要专项验证', data);
    return pass('H.264 ' + (data.h264Baseline || data.h264Main || '否') + ' · VP8 ' + (data.vp8 || '否') + ' · WMV ' + (data.wmv || '否'), data);
  });

  addTest('input', '横屏与输入设备', false, async function () {
    var coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
    var data = {
      touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
      maxTouchPoints: navigator.maxTouchPoints,
      coarsePointer: coarse,
      keyboardEvents: 'KeyboardEvent' in window,
      pointerEvents: 'PointerEvent' in window,
      gamepadApi: !!navigator.getGamepads,
      orientationApi: !!screen.orientation,
      landscapeNow: innerWidth >= innerHeight
    };
    var detail = '触摸 ' + (data.touch ? '是' : '否') + ' · Pointer Events ' + (data.pointerEvents ? '是' : '否') + ' · 手柄 API ' + (data.gamepadApi ? '是' : '否') + ' · 当前' + (data.landscapeNow ? '横屏' : '竖屏');
    if (!data.touch) return warn(detail, data);
    return pass(detail, data);
  });

  async function runTests() {
    if (stressRunning) return;
    results = {};
    elements.runButton.disabled = true;
    elements.copyButton.disabled = true;
    elements.uploadButton.disabled = true;
    elements.uploadStatus.dataset.state = '';
    elements.uploadStatus.textContent = '';
    elements.overall.dataset.state = 'running';
    elements.overallText.textContent = '正在检测';
    elements.summaryText.textContent = '请保持页面在前台，自动检测通常需要数秒。';
    elements.coreMetric.textContent = '--';
    elements.quotaMetric.textContent = '--';
    elements.writeMetric.textContent = '--';
    elements.graphicsMetric.textContent = '--';
    tests.forEach(function (test) { setRowState(test.id, 'idle', '尚未检测'); });

    for (var i = 0; i < tests.length; i += 1) {
      var test = tests[i];
      setRowState(test.id, 'running', '正在检测…');
      try {
        results[test.id] = await test.runner();
      } catch (error) {
        results[test.id] = fail(errorText(error), { error: errorText(error) });
      }
      setRowState(test.id, results[test.id].state, results[test.id].detail);
      updateOverall();
      refreshReport();
    }

    elements.runButton.disabled = false;
    refreshReport();
  }

  async function writeStressDatabase(totalMiB) {
    var chunkSize = 4 * MiB;
    var totalBytes = totalMiB * MiB;
    var chunkCount = Math.ceil(totalBytes / chunkSize);
    var db;
    var started = performance.now();
    try {
      try { await deleteDatabase(STRESS_DB); } catch (ignored) {}
      db = await openChunkDatabase(STRESS_DB);
      var metaTx = db.transaction('meta', 'readwrite');
      metaTx.objectStore('meta').put({ state: 'writing', totalBytes: totalBytes, chunkSize: chunkSize, startedAt: new Date().toISOString() }, 'test');
      await transactionDone(metaTx);

      for (var index = 0; index < chunkCount; index += 1) {
        if (stressCancelled) throw new Error('用户取消');
        var size = Math.min(chunkSize, totalBytes - index * chunkSize);
        var storedChunk = await makeStoredChunk(size, index);
        var tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put(storedChunk, index);
        await transactionDone(tx);
        var completed = Math.min(totalBytes, (index + 1) * chunkSize);
        elements.stressProgress.style.width = ((completed / totalBytes) * 100).toFixed(2) + '%';
        elements.stressDetail.textContent = '已写入 ' + formatBytes(completed) + ' / ' + formatBytes(totalBytes) + ' · ' + formatRate(completed, performance.now() - started);
        if (index % 16 === 0) await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }

      var completedTx = db.transaction('meta', 'readwrite');
      completedTx.objectStore('meta').put({ state: 'complete', totalBytes: totalBytes, chunkSize: chunkSize, chunkCount: chunkCount, completedAt: new Date().toISOString() }, 'test');
      await transactionDone(completedTx);

      var checkIndexes = [0, Math.floor(chunkCount / 2), chunkCount - 1];
      for (var i = 0; i < checkIndexes.length; i += 1) {
        var checkIndex = checkIndexes[i];
        var expectedSize = Math.min(chunkSize, totalBytes - checkIndex * chunkSize);
        var readTx = db.transaction('chunks', 'readonly');
        var readTxDone = transactionDone(readTx);
        var value = await requestPromise(readTx.objectStore('chunks').get(checkIndex));
        await readTxDone;
        if (!await verifyStoredChunk(value, expectedSize, checkIndex)) throw new Error('随机 SHA-256 校验第 ' + checkIndex + ' 块失败');
      }
      var durationMs = Math.round(performance.now() - started);
      return { state: 'pass', totalBytes: totalBytes, chunkBytes: chunkSize, durationMs: durationMs, writeRate: formatRate(totalBytes, durationMs), retainedForRestartTest: totalMiB >= 1024 };
    } finally {
      if (db) db.close();
    }
  }

  async function cleanupStress() {
    try {
      await deleteDatabase(STRESS_DB);
      return true;
    } catch (error) {
      elements.stressDetail.textContent += ' · 清理失败：' + errorText(error);
      return false;
    }
  }

  async function runStressTest() {
    if (stressRunning) return;
    var totalMiB = parseInt(elements.stressSize.value, 10);
    var now = Date.now();
    if (!stressConfirmation || stressConfirmation.totalMiB !== totalMiB || stressConfirmation.expiresAt < now) {
      stressConfirmation = { totalMiB: totalMiB, expiresAt: now + 15000 };
      elements.stressButton.textContent = '确认写入 ' + (totalMiB >= 1024 ? (totalMiB / 1024) + ' GB' : totalMiB + ' MB');
      elements.stressState.className = 'badge warn';
      elements.stressState.textContent = '等待确认';
      elements.stressDetail.textContent = '再次点击确认开始。' + (totalMiB >= 1024 ? '完成后会保留数据，用于关闭 App 或重启设备后的校验。' : '完成后会自动删除测试数据。');
      setTimeout(function () {
        if (!stressRunning && stressConfirmation && stressConfirmation.expiresAt <= Date.now()) {
          stressConfirmation = null;
          elements.stressButton.textContent = '运行压力测试';
          elements.stressState.className = 'badge neutral';
          elements.stressState.textContent = '未运行';
          elements.stressDetail.textContent = '确认已过期，请重新选择测试。';
        }
      }, 15100);
      return;
    }
    stressConfirmation = null;
    elements.stressButton.textContent = '运行压力测试';

    stressRunning = true;
    stressCancelled = false;
    elements.runButton.disabled = true;
    elements.stressButton.disabled = true;
    elements.cancelStressButton.disabled = false;
    elements.stressState.className = 'badge neutral';
    elements.stressState.textContent = '运行中';
    elements.stressProgress.style.width = '0%';
    elements.stressDetail.textContent = '正在准备测试数据库…';

    try {
      var result = await writeStressDatabase(totalMiB);
      window.__krkr2StressResult = result;
      elements.stressState.className = 'badge pass';
      elements.stressState.textContent = '通过';
      elements.stressProgress.style.width = '100%';
      elements.stressDetail.textContent = '写入与随机校验通过 · ' + result.writeRate + (result.retainedForRestartTest ? ' · 数据已保留，请关闭 App 或重启设备后重新打开本页' : ' · 正在清理测试数据');
      if (!result.retainedForRestartTest) {
        if (await cleanupStress()) elements.stressDetail.textContent += ' · 已清理';
      }
    } catch (error) {
      window.__krkr2StressResult = { state: stressCancelled ? 'cancelled' : 'fail', totalMiB: totalMiB, error: errorText(error), timestamp: new Date().toISOString() };
      elements.stressState.className = 'badge ' + (stressCancelled ? 'warn' : 'fail');
      elements.stressState.textContent = stressCancelled ? '已取消' : '失败';
      elements.stressDetail.textContent = (stressCancelled ? '测试已取消' : '测试失败') + ' · ' + errorText(error) + ' · 正在清理';
      if (await cleanupStress()) elements.stressDetail.textContent += ' · 已清理';
    } finally {
      stressRunning = false;
      elements.runButton.disabled = false;
      elements.stressButton.disabled = false;
      elements.cancelStressButton.disabled = true;
      refreshReport();
    }
  }

  async function inspectRetainedStress() {
    if (!('indexedDB' in window)) return;
    var db;
    try {
      db = await openChunkDatabase(STRESS_DB);
      var tx = db.transaction('meta', 'readonly');
      var txDone = transactionDone(tx);
      var meta = await requestPromise(tx.objectStore('meta').get('test'));
      await txDone;
      if (!meta || meta.state !== 'complete') { db.close(); return; }
      var indexes = [0, Math.floor(meta.chunkCount / 2), meta.chunkCount - 1];
      for (var i = 0; i < indexes.length; i += 1) {
        var index = indexes[i];
        var expectedSize = Math.min(meta.chunkSize, meta.totalBytes - index * meta.chunkSize);
        var readTx = db.transaction('chunks', 'readonly');
        var readTxDone = transactionDone(readTx);
        var stored = await requestPromise(readTx.objectStore('chunks').get(index));
        await readTxDone;
        if (!await verifyStoredChunk(stored, expectedSize, index)) throw new Error('保留数据第 ' + index + ' 块 SHA-256 校验失败');
      }
      window.__krkr2StressResult = { state: 'retained-pass', totalBytes: meta.totalBytes, completedAt: meta.completedAt, verifiedAt: new Date().toISOString() };
      elements.stressState.className = 'badge pass';
      elements.stressState.textContent = '重启保留通过';
      elements.stressProgress.style.width = '100%';
      elements.stressDetail.textContent = '发现并校验了上次保留的 ' + formatBytes(meta.totalBytes) + ' 测试数据。复制报告后，再次运行任意压力测试会先清理它。';
      db.close(); db = null;
      refreshReport();
    } catch (error) {
      if (db) db.close();
      window.__krkr2StressResult = { state: 'retained-fail', error: errorText(error), verifiedAt: new Date().toISOString() };
      elements.stressState.className = 'badge fail';
      elements.stressState.textContent = '保留校验失败';
      elements.stressDetail.textContent = errorText(error);
      refreshReport();
    }
  }

  elements.runButton.addEventListener('click', runTests);
  elements.copyButton.addEventListener('click', copyReport);
  elements.uploadButton.addEventListener('click', uploadReport);
  elements.stressButton.addEventListener('click', runStressTest);
  elements.stressSize.addEventListener('change', function () {
    stressConfirmation = null;
    elements.stressButton.textContent = '运行压力测试';
  });
  elements.cancelStressButton.addEventListener('click', function () {
    stressCancelled = true;
    elements.cancelStressButton.disabled = true;
    elements.stressDetail.textContent = '正在取消并清理测试数据…';
  });

  elements.buildVersion.textContent = 'build ' + BUILD_VERSION;
  elements.originText.textContent = '当前地址：' + location.origin + ' · ' + (window.isSecureContext ? '安全上下文' : '非安全上下文');
  renderRows();
  refreshReport();
  inspectRetainedStress();
})();
