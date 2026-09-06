"use strict";

// D5 stability soak: drives the senren-banka product through 60 minutes of
// typical dialogue play on the local audit profile and gates the run on the
// D3 acceptance criteria (page visible + heartbeat alive + event-loop stall
// < 5 s), plus the D5-specific health signals:
//
//   - frameGateTicks rate            engine tick pace (20 fps gate => ~100/5s)
//   - PERF ticks/avg/max/slow50/heap engine-side per-5s telemetry
//   - TICK_EXCEPTION count           must stay 0 locally (frame rescue日志 + errors)
//   - wasm heap + storage caches     growth trend (leak watch)
//   - WebAudio starts                sound-alive proxy (0095 victory metric)
//   - scenario movement              LABEL/SCENARIO lines keep appearing
//
// Usage:
//   node tools/d5_stability_soak.js [BASE] [--minutes N] [--label name]
//        [--tap-ms 3000] [--sample-ms 30000]
//
// Input contract identical to tests/d5_throttled_bench.js (hasTouch +
// touchscreen.tap only; first-boot screens skipped via engineLog gating).
// NOT throttled: this is a stability soak, the perf A/B bench is a separate
// tool. Never run two instances against the same profile.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const firstArg = process.argv[2];
const BASE_URL = (firstArg && !firstArg.startsWith("--")) ? firstArg : "https://127.0.0.1:8443/";

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const MINUTES = Number(argValue("--minutes", "60"));
const LABEL = argValue("--label", "soak-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16));
const TAP_MS = Number(argValue("--tap-ms", "3000"));
const SAMPLE_MS = Number(argValue("--sample-ms", "30000"));
const OUT_DIR = path.resolve("build/d5-soak");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executablePath = process.env.KRKR2_CHROME_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const context = await chromium.launchPersistentContext("E:\\krkr2-audit-profile", {
    headless: true, executablePath,
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors"],
    viewport: { width: 1280, height: 720 },
    hasTouch: true,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block"
  });
  try {
    const page = await context.newPage();
    const consoleErrs = [];
    page.on("pageerror", function (e) { consoleErrs.push(String(e)); });

    await context.addInitScript(function () {
      var soak = { rafCount: 0, maxGapMs: 0, gaps250: 0, gaps2500: 0, gaps5000: 0,
        recentGaps: [], longTasks: 0, longTaskMs: 0, audioStarts: 0 };
      window.__soak = soak;
      var lastRaf = 0;
      var nativeRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) {
        return nativeRaf(function (ts) {
          if (lastRaf) {
            var gap = ts - lastRaf;
            soak.rafCount += 1;
            if (gap > soak.maxGapMs) { soak.maxGapMs = gap; }
            if (gap > 250) { soak.gaps250 += 1; }
            if (gap > 2500) { soak.gaps2500 += 1; }
            if (gap > 5000) { soak.gaps5000 += 1; }
            soak.recentGaps.push(gap);
            if (soak.recentGaps.length > 3000) { soak.recentGaps.splice(0, 1500); }
          }
          lastRaf = ts;
          return cb(ts);
        });
      };
      try {
        var po = new PerformanceObserver(function (list) {
          var e = list.getEntries();
          for (var i = 0; i < e.length; i += 1) {
            soak.longTasks += 1; soak.longTaskMs += e[i].duration;
          }
        });
        po.observe({ entryTypes: ["longtask"] });
      } catch (e) {}
      var origStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function () {
        soak.audioStarts += 1;
        return origStart.apply(this, arguments);
      };
    });

    // ---------- boot to title (first-boot screens skipped via taps) ----------
    const bootT0 = Date.now();
    const base = BASE_URL.replace(/\/+$/, "");
    const join = base.indexOf("?") !== -1 ? "&" : "?";
    await page.goto(base + join + "engineVariant=baseline", { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForFunction(function () {
      return window.d4AppState && window.d4AppState().catalog;
    }, null, { timeout: 30000 });
    await page.getByRole("button", { name: "游戏库", exact: true }).click();
    await page.locator('.game-card[data-game-id="senren-banka"]').click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "启动游戏" }).click();
    await page.waitForFunction(function () { return window.d4PlayerState().ready; }, null, { timeout: 180000 });

    // Uncapped file-open counter: voices/sprites open on every dialogue
    // advance, so this is the gameplay-movement proxy for stall detection
    // (engineLog LABEL lines are too sparse mid-scene). Same hook style as
    // the bench's predictionLog wrapper.
    await page.evaluate(function () {
      window.__soak = window.__soak || {};
      window.__soak.opens = 0;
      var bridge = window.krkr2webPrefetch;
      if (!bridge) { return; }
      var original = bridge.notifyOpen.bind(bridge);
      bridge.notifyOpen = function (a, b, c, d, e) {
        window.__soak.opens += 1;
        return original(a, b, c, d, e);
      };
    });

    const rect = await page.evaluate(function () {
      var r = document.getElementById("canvas").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;

    for (var t = 0; t < 120; t += 1) {
      const up = await page.evaluate(function () {
        var el = window.d4PlayerState().engineLog || [];
        var seenTitle = false;
        for (var i = 0; i < el.length; i += 1) {
          if (el[i].indexOf("SCENARIO title.ks") !== -1) { seenTitle = true; }
          if (seenTitle && el[i].indexOf("LABEL *wait") !== -1) { return true; }
        }
        return false;
      });
      if (up) { break; }
      await page.touchscreen.tap(cx, cy).catch(function () {});
      await page.waitForTimeout(1500);
    }
    const titleAt = Date.now();

    // ---------- new game ----------
    await page.touchscreen.tap(rect.x + 155, rect.y + 231);
    await page.waitForTimeout(3200);
    let started = false;
    for (var w = 0; w < 24 && !started; w += 1) {
      started = await page.evaluate(function () {
        var el = window.d4PlayerState().engineLog || [];
        for (var i = 0; i < el.length; i += 1) {
          if (el[i].indexOf("SCENARIO start.ks") !== -1) { return true; }
        }
        return false;
      });
      if (started) { break; }
      await page.touchscreen.tap(cx, cy).catch(function () {});
      await page.waitForTimeout(1200);
    }
    if (!started) { throw new Error("new game never started (no SCENARIO start.ks)"); }
    console.log("BOOT+NEWGAME OK " + (titleAt - bootT0) + "ms to title, +" + (Date.now() - titleAt) + "ms into game");

    // ---------- soak ----------
    const soakT0 = Date.now();
    const soakEnd = soakT0 + MINUTES * 60 * 1000;
    const samples = [];
    const stallFallbacks = [
      [cx, rect.y + 250], [cx, rect.y + 360], [cx, rect.y + 470],
      [rect.x + 500, cy], [rect.x + 780, cy]
    ];
    let stallIdx = 0;
    let lastMovement = { at: soakT0, opens: -1 };
    const stallEvents = [];
    let wasStalled = false;
    let nextTap = Date.now(), nextSample = Date.now();

    while (Date.now() < soakEnd) {
      if (Date.now() >= nextTap) {
        const stalled = Date.now() - lastMovement.at > 180000;
        if (stalled) {
          const spot = stallFallbacks[(stallIdx++) % stallFallbacks.length];
          await page.touchscreen.tap(spot[0], spot[1]).catch(function () {});
          if (!wasStalled) {
            stallEvents.push({ at: Date.now() - soakT0, kind: "scenario-stall-fallback" });
            console.log("STALL-FALLBACK t+" + Math.round((Date.now() - soakT0) / 1000) + "s");
          }
          wasStalled = true;
        } else {
          wasStalled = false;
          await page.touchscreen.tap(cx, cy).catch(function () {});
        }
        nextTap = Date.now() + TAP_MS;
      }
      if (Date.now() >= nextSample) {
        const s = await collectSample(page, soakT0);
        if (s.opens > lastMovement.opens) {
          lastMovement = { at: Date.now(), opens: s.opens };
        }
        samples.push(s);
        const perfTail = s.perf.slice(-1)[0] || {};
        console.log("SAMPLE t+" + Math.round(s.uptimeMs / 1000) + "s ticks/5s=" + perfTail.ticks +
          " heap=" + perfTail.heap_mb + "MB rafGapMax=" + s.raf.maxGapMs +
          " audio=" + s.audioStarts + " opens=" + s.opens +
          " stall=" + (wasStalled ? "Y" : "n"));
        nextSample = Date.now() + SAMPLE_MS;
      }
      await page.waitForTimeout(250);
    }

    // ---------- report ----------
    const final = await collectSample(page, soakT0);
    const report = {
      label: LABEL, base: BASE_URL, minutes: MINUTES,
      startedAt: new Date(soakT0).toISOString(), endedAt: new Date().toISOString(),
      bootMs: titleAt - bootT0, samples: samples, final: final,
      stallEvents: stallEvents, pageErrors: consoleErrs.slice(-20),
      perf: summarizePerf(samples), gate: null
    };
    report.gate = evaluateGate(report);
    const outPath = path.join(OUT_DIR, LABEL + ".json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log("SOAK REPORT " + outPath);
    console.log("GATE " + JSON.stringify(report.gate));
    if (!report.gate.passed) { process.exitCode = 2; }
  } finally {
    await context.close();
  }
}

async function collectSample(page, soakT0) {
  return page.evaluate(function (arg) {
    var st = window.d4PlayerState();
    var el = st.engineLog || [];
    var perf = [];
    var cacheN = null, lastScenarioLine = "";
    var tickExc = 0;
    for (var i = 0; i < el.length; i += 1) {
      var l = el[i];
      if (l.indexOf("D5_PERF ") !== -1) {
        var o = { ticks: null, avg_ms: null, max_ms: null, slow50: null, heap_mb: null };
        var m = l.match(/ticks=(\d+)/); if (m) { o.ticks = +m[1]; }
        m = l.match(/avg_ms=(\d+)/); if (m) { o.avg_ms = +m[1]; }
        m = l.match(/max_ms=(\d+)/); if (m) { o.max_ms = +m[1]; }
        m = l.match(/slow50=(\d+)/); if (m) { o.slow50 = +m[1]; }
        m = l.match(/heap_mb=(\d+)/); if (m) { o.heap_mb = +m[1]; }
        perf.push(o);
      }
      if (l.indexOf("cacheN=") !== -1) {
        var c = l.match(/cacheN=(\d+)/); if (c) { cacheN = +c[1]; }
      }
      if (l.indexOf("LABEL") !== -1 || l.indexOf("SCENARIO") !== -1) { lastScenarioLine = l; }
      if (l.indexOf("TICK_EXCEPTION") !== -1) { tickExc += 1; }
    }
    var soak = window.__soak || {};
    var gaps = (soak.recentGaps || []).slice().sort(function (a, b) { return a - b; });
    var errTickExc = (st.errors || []).filter(function (e) {
      return e.indexOf("TICK_EXCEPTION") !== -1;
    }).length;
    return {
      uptimeMs: Date.now() - arg.soakT0,
      opens: soak.opens || 0,
      visibility: document.visibilityState,
      rafAlive: st.rafAlive, rafSilentMs: st.rafSilentMs,
      raf: {
        count: soak.rafCount || 0, maxGapMs: soak.maxGapMs || 0,
        gaps250: soak.gaps250 || 0, gaps2500: soak.gaps2500 || 0, gaps5000: soak.gaps5000 || 0,
        p95GapMs: gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] : 0
      },
      longTasks: soak.longTasks || 0, longTaskMs: Math.round(soak.longTaskMs || 0),
      audioStarts: soak.audioStarts || 0,
      frameGateTicks: st.frameGateTicks, frameGateSkips: st.frameGateSkips,
      tickRescueConsecutive: st.tickRescueConsecutive,
      tickExcRing: tickExc, tickExcErrors: errTickExc,
      crashed: st.crashed, fatal: st.fatalMessage, forcedStop: st.forcedStopCount,
      stopReason: st.stopReason, saveSyncCount: st.saveSyncCount,
      engineDialogCount: st.engineDialogCount,
      engineDialogTexts: st.engineDialogTexts,
      wasmMemoryBytes: st.wasmMemoryBytes,
      storageCacheBytes: st.storage && st.storage.cacheBytes,
      storageCacheEntries: st.storage && st.storage.cacheEntries,
      cacheN: cacheN, perf: perf.slice(-12), lastScenarioLine: lastScenarioLine,
      jsHeapUsedMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
    };
  }, { soakT0: soakT0 });
}

function summarizePerf(samples) {
  const ticks = [], heaps = [], slow = [], maxms = [];
  samples.forEach(function (s) {
    (s.perf || []).forEach(function (p) {
      if (p.ticks !== null) { ticks.push(p.ticks); }
      if (p.heap_mb !== null) { heaps.push(p.heap_mb); }
      if (p.slow50 !== null) { slow.push(p.slow50); }
      if (p.max_ms !== null) { maxms.push(p.max_ms); }
    });
  });
  ticks.sort(function (a, b) { return a - b; });
  const pick = function (arr, q) { return arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null; };
  return {
    perfWindows: ticks.length,
    ticksPer5s: { p05: pick(ticks, 0.05), p50: pick(ticks, 0.5), p95: pick(ticks, 0.95), min: ticks[0] || null, max: ticks[ticks.length - 1] || null },
    slow50Total: slow.reduce(function (a, c) { return a + c; }, 0),
    maxMsMax: maxms.length ? Math.max.apply(null, maxms) : null,
    heapMB: { first: heaps[0] || null, last: heaps[heaps.length - 1] || null, max: heaps.length ? Math.max.apply(null, heaps) : null }
  };
}

function evaluateGate(report) {
  const s = report.samples;
  const f = report.final;
  const problems = [];
  const invis = s.filter(function (x) { return x.visibility !== "visible"; }).length;
  if (invis) { problems.push("visibility!=visible x" + invis); }
  const rafDead = s.filter(function (x) { return !x.rafAlive; }).length;
  if (rafDead) { problems.push("rafAlive=false x" + rafDead); }
  const rafSilentMax = s.reduce(function (a, x) { return Math.max(a, x.rafSilentMs); }, 0);
  if (rafSilentMax >= 5000) { problems.push("rafSilentMs max " + rafSilentMax); }
  if (f.raf.gaps5000 > 0) { problems.push("rAF gaps>=5s x" + f.raf.gaps5000); }
  if (f.crashed || f.fatal) { problems.push("crashed/fatal: " + (f.fatal || "")); }
  if (f.forcedStop > 0) { problems.push("forcedStop=" + f.forcedStop); }
  if (f.stopReason) { problems.push("stopReason=" + f.stopReason); }
  const tickExc = Math.max(f.tickExcRing, f.tickExcErrors);
  if (tickExc > 0) { problems.push("TICK_EXCEPTION x" + tickExc); }
  if (f.tickRescueConsecutive > 0) { problems.push("tickRescueConsecutive=" + f.tickRescueConsecutive); }
  const perf = report.perf;
  if (perf.perfWindows > 0 && perf.ticksPer5s.p05 !== null && perf.ticksPer5s.p05 < 50) {
    problems.push("engine pace p05 " + perf.ticksPer5s.p05 + " ticks/5s (10fps)");
  }
  const audioStartsDeltas = s.length > 1 ? (s[s.length - 1].audioStarts - s[0].audioStarts) : 0;
  return {
    passed: problems.length === 0,
    problems: problems,
    visibility: { invisibleSamples: invis },
    heartbeat: { rafSilentMaxMs: rafSilentMax, maxGapMs: f.raf.maxGapMs, gaps250: f.raf.gaps250, gaps2500: f.raf.gaps2500, gaps5000: f.raf.gaps5000 },
    perf: perf,
    memory: { wasmHeapMB: f.wasmMemoryBytes ? Math.round(f.wasmMemoryBytes / 1048576) : null, jsHeapUsedMB: f.jsHeapUsedMB, engineHeapMB: perf.heapMB, storageCacheMB: f.storageCacheBytes ? Math.round(f.storageCacheBytes / 1048576) : null, cacheN: f.cacheN },
    audio: { startsTotal: f.audioStarts, startsDuringSoak: audioStartsDeltas },
    gameplay: { samples: s.length, saveSyncCount: f.saveSyncCount, stallEvents: report.stallEvents.length, lastScenarioLine: f.lastScenarioLine }
  };
}

main().catch(function (error) {
  console.error("SOAK FAIL: " + (error.stack || error.message));
  process.exit(1);
});
