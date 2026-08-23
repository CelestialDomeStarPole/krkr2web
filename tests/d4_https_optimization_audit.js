"use strict";

// 2026-08 optimization round audit against a real TLS endpoint (self-signed
// certificate on the hotspot address, default HTTPS port). Verifies, through
// the shipped product only:
//   - TLS deployment integrity (no mixed content, styled library renders)
//   - P1-3 early log capture (?debugEarlyLogs=1)
//   - full install over HTTPS (range-mapped package download)
//   - P1-2 cross-tab engine singleton (Web Locks: held query, second-tab
//     refusal, release-on-close, relaunch in the surviving tab)
//   - P0-3 large-read LRU bypass via the product storage bridge (direct reads
//     leave the chunk LRU untouched; cached large reads still hit the cache)
//   - offline zero-request worker launch (preloaded script texts + wasm
//     transfer) with heartbeat liveness, input clicks and graceful force stop
//
// Usage: node tests/d4_https_optimization_audit.js [https-base]
// Defaults to https://192.168.137.1/ (tools/https_diagnostics_server.py on
// port 443 serving build/d4-product with --resource-map).

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const BASE = process.argv[2] || "https://192.168.137.1/";
const OUTPUT_DIR = path.resolve("build/d4-https-audit");

function check(condition, message, extra) {
  if (!condition) {
    throw new Error(message + (extra === undefined ? "" : " :: " + JSON.stringify(extra)));
  }
}

function assertLayout(layout) {
  check(layout.scrollWidth <= layout.width + 1 && layout.scrollHeight <= layout.height + 1,
    "library overflows the viewport", layout);
  ["topbar", "list", "detail"].forEach(function (name) {
    var box = layout[name];
    check(box && box.width > 0 && box.height > 0 && box.right <= layout.width + 1 && box.bottom <= layout.height + 1,
      "layout region invalid: " + name, box);
  });
  check(layout.list.right <= layout.detail.left + 1, "list overlaps detail panel", layout);
}

function trackPage(page, label, sinks) {
  page.on("request", function (request) { sinks.requests.push({ page: label, url: request.url(), at: Date.now() }); });
  page.on("console", function (message) { sinks.console.push(label + " " + message.type() + ": " + message.text()); });
  page.on("pageerror", function (error) { sinks.console.push(label + " pageerror: " + (error.stack || error.message)); });
}

async function playerState(page) {
  return page.evaluate(function () {
    var state = window.d4PlayerState();
    var worker = state.workerRuntime;
    return {
      ready: state.ready, running: state.running, visible: state.visible, crashed: state.crashed,
      generation: state.generation, forcedStopCount: state.forcedStopCount,
      runtimeVariant: state.runtimeVariant, runtimeFallbackReason: state.runtimeFallbackReason,
      workerPhase: worker ? worker.phase : null,
      lastHeartbeatAt: worker ? worker.lastHeartbeatAt : null,
      lastMessageAt: worker ? worker.lastMessageAt : null,
      workerStoragePresent: !!(worker && worker.storage),
      readCalls: state.storage && state.storage.metrics ? state.storage.metrics.readCalls : null,
      storageErrors: state.storage && state.storage.metrics ? state.storage.metrics.errors : null,
      canvas: state.canvas
    };
  });
}

async function waitLibraryReady(page) {
  await page.waitForFunction(function () {
    return window.d4AppState && window.d4AppState().catalog;
  }, null, { timeout: 30000 });
}

async function waitInstallReady(page) {
  var install = await page.evaluate(function () { return window.d4AppState().installs["d3-test"]; });
  if (!install || install.status !== "ready" || !install.complete) {
    await page.getByRole("button", { name: /完整下载|继续下载/ }).click();
  }
  await page.waitForFunction(function () {
    var current = window.d4AppState().installs["d3-test"];
    return current && current.status === "ready" && current.complete === true;
  }, null, { timeout: 120000 });
  await page.waitForFunction(function () {
    return window.d4AppState().samePageOffline.assets.status === "ready";
  }, null, { timeout: 60000 });
}

async function main() {
  const executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const launchArgs = ["--autoplay-policy=no-user-gesture-required"];
  if (BASE.indexOf("https://") === 0) { launchArgs.push("--ignore-certificate-errors"); }
  const browser = await chromium.launch({ headless: true, executablePath, args: launchArgs });
  const sinks = { requests: [], console: [] };
  const report = { base: BASE, startedAt: new Date().toISOString(), phases: {} };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      serviceWorkers: "block"
    });

    // ---- Phase 1: TLS integrity + P1-3 early logs + library layout ----
    const main = await context.newPage();
    trackPage(main, "main", sinks);
    const loadStartedAt = Date.now();
    const response = await main.goto(BASE + "/?debugEarlyLogs=1&source=https-audit", { waitUntil: "networkidle", timeout: 30000 });
    check(response && response.ok(), "library page did not load over HTTPS", response && response.status());
    await waitLibraryReady(main);
    const earlyLogs = await main.evaluate(function () {
      // A clean product load emits no console output of its own, so prove the
      // capture pipeline itself: the wrap installed by index.html must fold
      // these two calls into the ring buffer with level prefixes.
      console.log("krkr2web-audit-earlylog-marker");
      console.warn("krkr2web-audit-earlylog-warn");
      var logs = window.__krkr2webEarlyLogs;
      return { present: Array.isArray(logs), length: logs ? logs.length : 0, sample: logs ? logs.slice(0, 6) : null };
    });
    check(earlyLogs.present && earlyLogs.sample && earlyLogs.sample.some(function (line) { return line.indexOf("[log]") === 0 && line.indexOf("krkr2web-audit-earlylog-marker") !== -1; }) &&
      earlyLogs.sample.some(function (line) { return line.indexOf("[warn]") === 0 && line.indexOf("krkr2web-audit-earlylog-warn") !== -1; }),
      "P1-3: ?debugEarlyLogs=1 capture pipeline did not record console output", earlyLogs);
    const initialRequests = sinks.requests.filter(function (entry) { return entry.at >= loadStartedAt && entry.page === "main"; });
    const mixed = initialRequests.filter(function (entry) { return entry.url.indexOf("http://") === 0; });
    check(mixed.length === 0, "mixed content detected over HTTPS", mixed);
    const library = await main.evaluate(function () {
      function box(selector) {
        var rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      }
      return {
        cards: document.querySelectorAll(".game-card").length,
        title: document.querySelector(".detail-header h2").textContent,
        catalogStatus: document.getElementById("catalog-status").textContent,
        layout: {
          width: innerWidth, height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          topbar: box(".topbar"), list: box(".library-list"), detail: box(".game-detail")
        }
      };
    });
    assertLayout(library.layout);
    check(library.cards === 1 && library.title === "D3 self-test", "HTTPS library did not render the catalog", library);
    report.phases.tls = { status: "pass", requests: initialRequests.length, earlyLogLines: earlyLogs.length, catalogStatus: library.catalogStatus };

    // ---- Phase 2: full install over HTTPS ----
    await waitInstallReady(main);
    const installed = await main.evaluate(function () {
      var install = window.d4AppState().installs["d3-test"];
      return { status: install.status, complete: install.complete, version: install.activeVersion, assets: window.d4AppState().samePageOffline.assets.status };
    });
    check(installed.status === "ready" && installed.complete && installed.assets === "ready",
      "install did not complete over HTTPS", installed);
    await main.screenshot({ path: path.join(OUTPUT_DIR, "01-library-installed.png"), fullPage: true });
    report.phases.install = { status: "pass", detail: installed };

    // ---- Phase 3: P1-2 cross-tab engine singleton ----
    await main.getByRole("button", { name: "启动游戏" }).click();
    await main.waitForFunction(function () { return window.d4PlayerState && window.d4PlayerState().ready; }, null, { timeout: 90000 });
    const firstRun = await playerState(main);
    check(firstRun.runtimeVariant === "dedicated-worker-baseline" && firstRun.workerPhase === "running",
      "first tab did not launch the worker engine", firstRun);

    const tab2 = await context.newPage();
    trackPage(tab2, "tab2", sinks);
    await tab2.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    await waitLibraryReady(tab2);
    const heldLocks = await tab2.evaluate(async function () {
      var query = await navigator.locks.query();
      return { held: (query.held || []).map(function (lock) { return { name: lock.name, mode: lock.mode }; }), pending: (query.pending || []).length };
    });
    check(heldLocks.held.some(function (lock) { return lock.name === "krkr2web-engine-instance" && lock.mode === "exclusive"; }),
      "P1-2: engine lock is not visible to a second tab", heldLocks);

    await tab2.getByRole("button", { name: "启动游戏" }).click();
    await tab2.waitForFunction(function () {
      var node = document.getElementById("player-status");
      return node && node.textContent === "引擎已在其他标签页运行";
    }, null, { timeout: 20000 });
    const firstStillReady = await main.evaluate(function () { return window.d4PlayerState().ready; });
    check(firstStillReady, "P1-2: refused second tab disturbed the running engine");
    await tab2.screenshot({ path: path.join(OUTPUT_DIR, "02-singleton-refusal.png"), fullPage: true });

    await main.close();
    await tab2.waitForFunction(async function () {
      var query = await navigator.locks.query();
      return !(query.held || []).some(function (lock) { return lock.name === "krkr2web-engine-instance"; });
    }, null, { timeout: 10000 });
    await tab2.reload({ waitUntil: "networkidle", timeout: 30000 });
    await waitLibraryReady(tab2);
    await waitInstallReady(tab2);
    await tab2.getByRole("button", { name: "启动游戏" }).click();
    await tab2.waitForFunction(function () { return window.d4PlayerState && window.d4PlayerState().ready; }, null, { timeout: 90000 });
    const survivorRun = await playerState(tab2);
    check(survivorRun.runtimeVariant === "dedicated-worker-baseline" && survivorRun.workerPhase === "running",
      "P1-2: surviving tab could not relaunch after the holder closed", survivorRun);
    await tab2.close();
    report.phases.singleton = { status: "pass", heldLocks: heldLocks, refusalShown: true, relaunchVariant: survivorRun.runtimeVariant };

    // ---- Phase 4: P0-3 large-read LRU bypass (product storage bridge) ----
    const storagePage = await context.newPage();
    trackPage(storagePage, "storage", sinks);
    await storagePage.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    await waitLibraryReady(storagePage);
    const storageResult = await storagePage.evaluate(async function () {
      await new Promise(function (resolve, reject) {
        var script = document.createElement("script");
        script.src = "/play/storage.js";
        script.onload = resolve;
        script.onerror = function () { reject(new Error("storage.js failed to load")); };
        document.head.appendChild(script);
      });
      var bridge = window.krkr2StorageBridge;
      var prepared = await bridge.prepare("d3-test");
      var pkg = prepared.manifest.packages[0];
      var chunkSize = pkg.chunkSize;
      var pkgSize = pkg.size;
      var handle = bridge.open(pkg.virtualPath);
      if (!handle) { throw new Error("could not open package " + pkg.virtualPath); }
      var bigLen = Math.min(chunkSize, pkgSize);
      var smallLen = 64 * 1024;
      var big = new Uint8Array(bigLen);
      var small = new Uint8Array(smallLen);
      var out = { pkgPath: pkg.virtualPath, chunkSize: chunkSize, pkgSize: pkgSize, bigLen: bigLen, smallLen: smallLen };
      out.r1 = await bridge.readToHeap(handle, 0, bigLen, big, big);           // large, uncached -> direct
      out.s1 = bridge.snapshot();
      out.r2 = await bridge.readToHeap(handle, 0, smallLen, small, small);     // small -> LRU populate
      out.s2 = bridge.snapshot();
      out.r2b = await bridge.readToHeap(handle, 0, smallLen, small, small);    // small repeat -> LRU hit
      out.s2b = bridge.snapshot();
      out.r1b = await bridge.readToHeap(handle, 0, bigLen, big, big);          // large, now cached -> LRU hit
      out.s1b = bridge.snapshot();
      if (pkgSize - chunkSize >= 1024 * 1024) {                                // large in a later uncached chunk -> direct again
        var len6 = Math.min(chunkSize, pkgSize - chunkSize);
        var tail = new Uint8Array(len6);
        out.r6 = await bridge.readToHeap(handle, chunkSize, len6, tail, tail);
        out.len6 = len6;
      } else { out.r6 = null; }
      out.s6 = bridge.snapshot();
      return out;
    });
    check(storageResult.r1 === storageResult.bigLen && storageResult.r2 === storageResult.smallLen &&
      storageResult.r2b === storageResult.smallLen && storageResult.r1b === storageResult.bigLen,
      "P0-3: a read returned the wrong byte count", storageResult);
    check(storageResult.bigLen >= 1024 * 1024, "P0-3: package chunk smaller than the direct-read threshold; test needs a larger package", storageResult);
    check(storageResult.s1.metrics.directReads === 1 && storageResult.s1.metrics.directBytes === storageResult.bigLen,
      "P0-3: first large uncached read did not take the direct path", storageResult.s1.metrics);
    check(storageResult.s1.cacheEntries === 0 && storageResult.s1.metrics.cacheMisses === 0 && storageResult.s1.metrics.cacheHits === 0,
      "P0-3: direct read polluted the chunk LRU", storageResult.s1);
    check(storageResult.s2.metrics.cacheMisses === 1 && storageResult.s2.cacheEntries === 1,
      "P0-3: small read did not populate the LRU normally", storageResult.s2);
    check(storageResult.s2b.metrics.cacheHits === 1, "P0-3: repeated small read did not hit the LRU", storageResult.s2b.metrics);
    check(storageResult.s1b.metrics.directReads === 1 && storageResult.s1b.metrics.cacheHits >= 2,
      "P0-3: fully cached large read bypassed the LRU instead of hitting it", storageResult.s1b.metrics);
    if (storageResult.r6 !== null) {
      check(storageResult.r6 === storageResult.len6, "P0-3: tail large read returned the wrong byte count", storageResult);
      check(storageResult.s6.metrics.directReads === 2, "P0-3: second large uncached read did not go direct", storageResult.s6.metrics);
      check(storageResult.s6.cacheEntries === 1, "P0-3: second direct read polluted the LRU", storageResult.s6);
    }
    check(storageResult.s6.metrics.readCalls === (storageResult.r6 !== null ? 5 : 4) && storageResult.s6.metrics.errors.length === 0,
      "P0-3: unexpected read accounting", storageResult.s6.metrics);
    await storagePage.close();
    report.phases.directRead = {
      status: "pass", pkgPath: storageResult.pkgPath, chunkSize: storageResult.chunkSize, pkgSize: storageResult.pkgSize,
      directReads: storageResult.s6.metrics.directReads, directBytes: storageResult.s6.metrics.directBytes,
      lruEntriesAfterAllReads: storageResult.s6.cacheEntries, cacheHits: storageResult.s6.metrics.cacheHits
    };

    // ---- Phase 5: offline zero-request worker launch + liveness + force stop ----
    const offline = await context.newPage();
    trackPage(offline, "offline", sinks);
    await offline.goto(BASE + "/?source=https-audit-offline", { waitUntil: "networkidle", timeout: 30000 });
    await waitLibraryReady(offline);
    await waitInstallReady(offline);
    await context.setOffline(true);
    const networkBlocked = await offline.evaluate(function () {
      return fetch("/offline-audit-probe-" + Date.now(), { cache: "no-store" }).then(function () { return false; }, function () { return true; });
    });
    check(networkBlocked, "offline emulation did not block network access");
    const launchStartedAt = Date.now();
    await offline.getByRole("button", { name: "启动游戏" }).click();
    await offline.waitForFunction(function () { return window.d4PlayerState && window.d4PlayerState().ready; }, null, { timeout: 90000 });
    const offlineRun = await playerState(offline);
    const launchRequests = sinks.requests.filter(function (entry) {
      return entry.at >= launchStartedAt && entry.page === "offline" &&
        entry.url.indexOf("offline-audit-probe-") === -1 && entry.url.indexOf("blob:") !== 0;
    });
    check(launchRequests.length === 0, "offline launch issued server requests", launchRequests);
    check(offlineRun.runtimeVariant === "dedicated-worker-baseline" && offlineRun.workerPhase === "running",
      "offline launch did not use the worker engine", offlineRun);
    check(offlineRun.workerStoragePresent && offlineRun.storageErrors && offlineRun.storageErrors.length === 0,
      "offline worker storage reported errors", offlineRun);
    check(offlineRun.canvas && offlineRun.canvas.width > 0 && offlineRun.canvas.height > 0, "engine canvas has no size", offlineRun.canvas);
    await offline.screenshot({ path: path.join(OUTPUT_DIR, "03-offline-boot.png"), fullPage: true });

    const heartbeat1 = await offline.evaluate(function () { return window.d4PlayerState().workerRuntime.lastHeartbeatAt; });
    await offline.waitForTimeout(1600);
    const heartbeat2 = await offline.evaluate(function () { return window.d4PlayerState().workerRuntime.lastHeartbeatAt; });
    check(heartbeat2 > heartbeat1, "worker heartbeat stalled while running offline", { heartbeat1: heartbeat1, heartbeat2: heartbeat2 });

    const canvas = offline.locator("#canvas");
    await canvas.click({ position: { x: 640, y: 360 } });
    await offline.waitForTimeout(900);
    await canvas.click({ position: { x: 640, y: 360 } });
    await offline.waitForTimeout(1200);
    await offline.screenshot({ path: path.join(OUTPUT_DIR, "04-offline-after-clicks.png"), fullPage: true });
    const clickRequests = sinks.requests.filter(function (entry) {
      return entry.at >= launchStartedAt && entry.page === "offline" && entry.url.indexOf("offline-audit-probe-") === -1 && entry.url.indexOf("blob:") !== 0;
    });
    check(clickRequests.length === 0, "offline interaction issued server requests", clickRequests);

    const stopStartedAt = Date.now();
    await offline.getByRole("button", { name: "强制终止游戏", exact: true }).click();
    await offline.waitForFunction(function () {
      var state = window.d4PlayerState();
      return !state.running && !state.visible && state.forcedStopCount > 0;
    }, null, { timeout: 15000 });
    const stopped = await playerState(offline);
    const stopRequests = sinks.requests.filter(function (entry) {
      return entry.at >= stopStartedAt && entry.page === "offline" && entry.url.indexOf("offline-audit-probe-") === -1 && entry.url.indexOf("blob:") !== 0;
    });
    check(stopRequests.length === 0, "force stop issued server requests", stopRequests);
    await offline.screenshot({ path: path.join(OUTPUT_DIR, "05-after-force-stop.png"), fullPage: true });
    report.phases.offline = {
      status: "pass", variant: offlineRun.runtimeVariant, launchServerRequests: launchRequests.length,
      heartbeatAdvanced: heartbeat2 > heartbeat1, forcedStopCount: stopped.forcedStopCount,
      interactionServerRequests: clickRequests.length
    };

    const workerFatal = sinks.console.filter(function (line) { return line.indexOf("Worker fatal") !== -1; });
    check(workerFatal.length === 0, "worker runtime reported fatal errors", workerFatal);

    report.status = "pass";
    report.phases.summary = {
      requestsTotal: sinks.requests.length,
      consoleLines: sinks.console.length,
      screenshots: fs.readdirSync(OUTPUT_DIR).filter(function (name) { return name.endsWith(".png"); })
    };
  } finally {
    report.finishedAt = new Date().toISOString();
    if (!report.status) { report.status = "fail"; }
    report.consoleTail = sinks.console.slice(-40);
    fs.writeFileSync(path.join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    await browser.close().catch(function () {});
  }
  if (report.status !== "pass") { process.exitCode = 1; }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
