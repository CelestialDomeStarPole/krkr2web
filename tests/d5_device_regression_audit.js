"use strict";

// Device-regression audit: reproduces the TB-X802F / TBS-046299 field report
// (diagnostic-reports/20260823-084346-0389f883.json) on desktop Chrome and
// proves the three fixes for its findings:
//
//   RC1  predictedOpens 0 / prefetchedFiles 0  -> the numeric-successor
//        predictor in patch 0079 scanned the raw name tail, which is the
//        extension ("g" of ".ogg"), so predictions never fired. Fixed to
//        split the extension first. PASS = predictedOpens > 0,
//        prefetchedFiles > 0 and the engine consuming a park
//        (segmentParkHits or imageParkHits/Puts > 0).
//   RC2  decodeFailures 281 / nativeDecodes 0  -> TBS WebView has no
//        OffscreenCanvas inside workers, so the decode worker throws on
//        every job and ensureWorker kept handing out the broken worker
//        instead of falling back to decodeOnMain. Fixed with
//        markWorkerBroken. PASS = decodeFailures <= 2 (the first failing
//        job kills the worker) and mainDecodes > 0.
//   RC3  40s untraced engine stall             -> the WebP decode await had
//        no timeout and no async trace. Fixed in LoadWEBP.cpp (8s race +
//        krkr2webAsyncTrace). PASS = no KRKR2WEB_D5_STALL error and the
//        engine perf counters keep printing.
//
// Runs the d3 self-test game (its scenario loads pfbg0001..0006.webp in
// order, exercising the full prediction -> prefetch -> park -> consume
// chain) on the baseline variant (?engineVariant=baseline) exactly like the
// device. The decode worker is emulated to behave like the TBS WebView by
// intercepting decode-shaped jobs ({id, bytes, bgra}) and answering with
// "OffscreenCanvas unavailable"; inflate jobs ({id, bytes}) still run in a
// real worker, as they do on the device (poolInflates worked there).
//
// Usage (server must be up, product rebuilt with the fixes):
//   node tests/d5_device_regression_audit.js [base]
//     base defaults to https://192.168.137.1/
//   KRKR2_AUDIT_GAME overrides the game under test (default d3-test).

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const BASE = process.argv[2] || "https://192.168.137.1/";
const GAME_ID = process.env.KRKR2_AUDIT_GAME || "d3-test";
const OUTPUT_DIR = path.resolve("build/d5-device-regression-audit");

function check(condition, message, extra) {
  if (!condition) {
    throw new Error(message + (extra === undefined ? "" : " :: " + JSON.stringify(extra)));
  }
}

async function waitLibraryReady(page) {
  await page.waitForFunction(function () {
    return window.d4AppState && window.d4AppState().catalog;
  }, null, { timeout: 30000 });
}

async function playerSnapshot(page) {
  return page.evaluate(function () {
    var state = window.d4PlayerState();
    return {
      ready: state.ready,
      running: state.running,
      crashed: state.crashed,
      variant: state.runtimeVariant,
      fallbackReason: state.runtimeFallbackReason,
      errors: state.errors || [],
      engineLog: state.engineLog || [],
      prefetch: window.krkr2webPrefetch ? window.krkr2webPrefetch.snapshot() : null
    };
  });
}

async function main() {
  const executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const launchArgs = ["--autoplay-policy=no-user-gesture-required"];
  if (BASE.indexOf("https://") === 0) { launchArgs.push("--ignore-certificate-errors"); }
  // Persistent context on the roomiest drive: Chrome sizes the per-origin
  // temporary-storage quota from the profile disk's free space (a C: profile
  // reported 3 GiB against a 4.65 GiB install and failed the preflight
  // quota check); installs also survive across audit re-runs.
  const userDataDir = process.env.KRKR2_AUDIT_PROFILE || "E:\\krkr2-audit-profile";
  if (!/^[A-Za-z]:[\\/\\]?$/.test(path.dirname(userDataDir))) {
    fs.mkdirSync(path.dirname(userDataDir), { recursive: true });
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true, executablePath, args: launchArgs,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    serviceWorkers: "block"
  });
  const browser = { close: function () { return context.close(); } };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const report = { base: BASE, game: GAME_ID, startedAt: new Date().toISOString(), phases: {} };
  const consoleLines = [];

  try {
    await context.addInitScript(function () {
      // ---- TBS WebView emulation -------------------------------------------
      // Intercept decode-shaped worker jobs ({id, bytes, bgra}) and answer
      // "OffscreenCanvas unavailable", exactly like a TBS WebView worker
      // scope. Matching happens at postMessage time (not construction),
      // because prefetch.js revokes the worker's blob URL immediately and
      // the source cannot be re-fetched afterwards. Inflate jobs
      // ({id, bytes}) keep running in a real worker, as on the device.
      var RealWorker = window.Worker;
      function TbsWorker(url, options) {
        var real = new RealWorker(url, options);
        var realPost = real.postMessage.bind(real);
        real.postMessage = function (data, transfer) {
          if (data && typeof data === "object" && "bgra" in data && "bytes" in data) {
            setTimeout(function () {
              if (typeof real.onmessage === "function") {
                real.onmessage({ data: { id: data.id, error: "OffscreenCanvas unavailable" } });
              }
            }, 5);
            return;
          }
          return realPost(data, transfer);
        };
        return real;
      }
      TbsWorker.prototype = RealWorker.prototype;
      window.Worker = TbsWorker;
    });

    const page = await context.newPage();
    page.on("console", function (message) { consoleLines.push(message.type() + ": " + message.text()); });
    page.on("pageerror", function (error) { consoleLines.push("pageerror: " + (error.stack || error.message)); });

    // ---- Phase 1: library + install ----
    await page.goto(BASE + "/?engineVariant=baseline", { waitUntil: "networkidle", timeout: 60000 });
    await waitLibraryReady(page);
    await page.getByRole("button", { name: "游戏库", exact: true }).click();
    await page.locator(".game-card[data-game-id=" + JSON.stringify(GAME_ID) + "]").click();
    await page.waitForTimeout(1000);
    var catalogVersion = await page.evaluate(function (id) {
      var game = window.d4AppState().catalog.games.filter(function (entry) { return entry.gameId === id; })[0];
      return game && game.version;
    }, GAME_ID);
    // wipe any previous run's KAG progress first: the d3 probe game persists
    // its parser position (kag-progress.dat in IDBFS), and a stale save makes
    // the engine restore STRAIGHT TO THE END, skipping the numbered-image
    // sequence. The save manager delete is the product's own save-removal
    // path (deleting the install alone keeps saves by design).
    await page.getByRole("button", { name: "存档", exact: true }).click();
    await page.waitForFunction(function () {
      return !window.krkr2SaveManager.snapshot().busy;
    }, null, { timeout: 20000 });
    var staleSaves = await page.evaluate(function () {
      return window.krkr2SaveManager.snapshot().entries.length;
    });
    if (staleSaves > 0) {
      await page.locator(".save-row input[type=checkbox]").first().check();
      await page.getByRole("button", { name: "删除选中", exact: true }).click();
      await page.getByRole("button", { name: "再次点击确认删除", exact: true }).click();
      await page.waitForFunction(function () {
        var snapshot = window.krkr2SaveManager.snapshot();
        return !snapshot.busy && snapshot.entries.length === 0;
      }, null, { timeout: 20000 });
    }
    await page.getByRole("button", { name: "游戏库", exact: true }).click();
    await page.locator(".game-card[data-game-id=" + JSON.stringify(GAME_ID) + "]").click();
    await page.waitForTimeout(1000);
    const installState = await page.evaluate(function (id) { return window.d4AppState().installs[id]; }, GAME_ID);
    if (!installState || installState.complete !== true || installState.activeVersion !== catalogVersion) {
      await page.getByRole("button", { name: /完整下载|继续下载/ }).click();
    }
    const installDeadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < installDeadline) {
      const install = await page.evaluate(function (payload) {
        var raw = window.d4AppState().installs[payload.id] || {};
        return {
          status: raw.status,
          complete: raw.complete === true,
          version: raw.activeVersion || null,
          committedBytes: raw.committedBytes || 0,
          requiredBytes: raw.requiredBytes || 0,
          error: raw.error || raw.lastError || null
        };
      }, { id: GAME_ID });
      fs.writeFileSync(path.join(OUTPUT_DIR, "install-progress.json"),
        JSON.stringify(Object.assign({ catalogVersion: catalogVersion }, install), null, 2));
      if (install.complete && install.status === "ready" && install.version === catalogVersion) { break; }
      if (install.status === "error" || install.error) {
        throw new Error("install errored: " + JSON.stringify(install));
      }
      await page.waitForTimeout(5000);
    }
    const finalInstall = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, "install-progress.json"), "utf8"));
    check(finalInstall.complete && finalInstall.status === "ready" && finalInstall.version === catalogVersion,
      "install did not complete", finalInstall);
    report.phases.install = { status: "pass", detail: finalInstall };

    // ---- Phase 2: baseline launch (the device's runtime variant) ----
    await page.getByRole("button", { name: "启动游戏" }).click();
    const launchDeadline = Date.now() + 180000;
    while (Date.now() < launchDeadline) {
      const boot = await page.evaluate(function () {
        var state = window.d4PlayerState();
        return {
          ready: state.ready,
          variant: state.runtimeVariant,
          fallback: state.runtimeFallbackReason,
          build: state.assets && state.assets.verifiedBuild,
          errors: (state.errors || []).slice(-4),
          logTail: (state.engineLog || []).slice(-3)
        };
      }).catch(function () { return null; });
      if (boot) { fs.writeFileSync(path.join(OUTPUT_DIR, "launch-progress.json"), JSON.stringify(boot, null, 2)); }
      if (boot && boot.ready) { break; }
      await page.waitForTimeout(4000);
    }
    await page.waitForFunction(function (id) {
      var state = window.d4PlayerState();
      return state.ready && state.gameId === id;
    }, GAME_ID, { timeout: 30000 });
    const launchState = await page.evaluate(function () {
      var state = window.d4PlayerState();
      return { variant: state.runtimeVariant, fallback: state.runtimeFallbackReason };
    });
    check(launchState.variant === "baseline", "engine did not run the baseline variant", launchState);
    report.phases.launch = { status: "pass", detail: launchState };

    // instrument the notify bridge so a failing RC1 check shows whether the
    // engine ever emitted a prediction (isPrediction=true) at all
    await page.evaluate(function () {
      window.krkr2webPredictionDebug = true;  // engine-side per-open diagnosis (patch 0079)
      window.__predictionLog = [];
      var bridge = window.krkr2webPrefetch;
      if (!bridge) { return; }
      var original = bridge.notifyOpen.bind(bridge);
      bridge.notifyOpen = function (archiveName, fileName, storageIndex, isPrediction, segments) {
        window.__predictionLog.push({
          archive: String(archiveName), name: String(fileName),
          prediction: !!isPrediction, segments: segments ? segments.length : 0
        });
        if (window.__predictionLog.length > 200) { window.__predictionLog.shift(); }
        return original(archiveName, fileName, storageIndex, isPrediction, segments);
      };
    });

    // ---- Phase 3: click past the intro [wait]; the numbered sequence then
    // self-advances. Poll until parks show engine consumption. ----
    const canvas = page.locator("#canvas");
    let snapshot = null;
    for (var round = 0; round < 20; round += 1) {
      await canvas.click({ position: { x: 480, y: 270 }, timeout: 10000 }).catch(function () {});
      await page.waitForTimeout(1200);
      snapshot = await playerSnapshot(page);
      var finished = (snapshot.engineLog || []).some(function (line) {
        return line.indexOf("KRKR2WEB_D3_KAG_TEXT") !== -1 && line.indexOf("prefetch") !== -1;
      });
      var loopMetrics = snapshot.prefetch && snapshot.prefetch.metrics;
      if (finished && loopMetrics && loopMetrics.predictedOpens > 0 &&
          loopMetrics.prefetchedFiles > 0 &&
          (loopMetrics.segmentParkHits > 0 || loopMetrics.imageParkHits > 0 || loopMetrics.imageParkPuts > 0) &&
          loopMetrics.mainDecodes > 0) {
        break;
      }
    }
    const sequenceDone = (snapshot.engineLog || []).some(function (line) {
      return line.indexOf("KRKR2WEB_D3_PREFETCH_IMAGE_ERROR") !== -1;
    });
    check(!sequenceDone, "scenario image loads threw inside the engine", snapshot.engineLog.slice(-6));
    await page.screenshot({ path: path.join(OUTPUT_DIR, "01-baseline-after-clicks.png"), fullPage: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, "notify-log.json"), JSON.stringify(
      await page.evaluate(function () { return window.__predictionLog || []; }), null, 2));
    const metrics = snapshot.prefetch.metrics;
    const predDbg = (snapshot.engineLog || []).filter(function (line) {
      return line.indexOf("KRKR2WEB_PRED") !== -1;
    });
    fs.writeFileSync(path.join(OUTPUT_DIR, "prediction-debug.json"),
      JSON.stringify(predDbg.concat(["--- engine tail ---"].concat(
        (snapshot.engineLog || []).slice(-40))), null, 2));
    check(metrics.notifyOpens > 0, "engine never notified the page of archive opens", metrics);
    check(metrics.predictedOpens > 0,
      "RC1: numeric-successor predictions never fired (predictor still extension-blind)", metrics);
    check(metrics.prefetchedFiles > 0,
      "RC1: predicted storages were never prefetched into the parks", metrics);
    check(metrics.segmentParkPuts > 0 || metrics.imageParkPuts > 0,
      "RC1: prefetch never stored segments or images in the parks", metrics);
    check(metrics.imageParkHits > 0,
      "RC1: engine never consumed a parked image (park probe mismatch?)", metrics);
    report.phases.prefetch = { status: "pass", metrics: metrics, recentNames: snapshot.prefetch.recentNames };

    // ---- Phase 4: TBS decode-worker fallback must engage early ----
    // decodeFailures counts worker-path rejects until markWorkerBroken stops
    // the worker (a couple of in-flight jobs may reject with it); mainDecodes
    // proves the page-level fallback then served every later decode. The
    // uncompressed d3-test archive exercises the image park only; segment
    // park hits need compressed archives (the real games) and stay 0 here.
    check(metrics.decodeFailures <= 4,
      "RC2: the broken decode worker kept receiving jobs instead of falling back", metrics);
    check(metrics.mainDecodes > 0,
      "RC2: decodeOnMain fallback never served a decode after the worker broke", metrics);
    report.phases.decode = {
      status: "pass",
      decodeFailures: metrics.decodeFailures,
      mainDecodes: metrics.mainDecodes,
      nativeDecodes: metrics.nativeDecodes
    };

    // ---- Phase 5: no stall; engine keeps ticking ----
    const errors = snapshot.errors.filter(function (line) { return String(line).indexOf("KRKR2WEB_D5_STALL") !== -1; });
    check(errors.length === 0, "RC3: engine stalled during the audit session", errors);
    const perfLines = consoleLines.filter(function (line) { return line.indexOf("KRKR2WEB_D5_PERF") !== -1; })
      .concat(snapshot.engineLog.filter(function (line) { return line.indexOf("KRKR2WEB_D5_PERF") !== -1; }));
    check(perfLines.length >= 2, "engine perf counters did not keep reporting", perfLines.slice(-3));
    report.phases.stability = {
      status: "pass",
      perfSamples: perfLines.slice(-6),
      stallErrors: errors.length,
      engineErrors: snapshot.errors
    };

    // ---- Phase 6: graceful stop ----
    await page.getByRole("button", { name: "强制终止游戏", exact: true }).click();
    await page.waitForFunction(function () {
      var state = window.d4PlayerState();
      return !state.running;
    }, null, { timeout: 30000 });
    report.phases.stop = { status: "pass" };

    report.status = "pass";
    report.finishedAt = new Date().toISOString();
  } finally {
    fs.writeFileSync(path.join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUTPUT_DIR, "console.txt"), consoleLines.slice(-400).join("\n"));
    await browser.close();
  }
  console.log("D5 device-regression audit PASS (" + GAME_ID + ")");
  console.log(JSON.stringify(report.phases.prefetch.metrics, null, 1));
}

main().catch(function (error) {
  console.error("D5 device-regression audit FAIL: " + error.message);
  process.exit(1);
});
