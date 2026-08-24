"use strict";

// Throttled-desktop benchmark for the D5 product, simulating the Android
// device with Chrome's CDP CPU throttling (the acceptance environment for the
// optimization round: read-save black screen, dialogue audio start latency,
// sprite/audio switch hitches, CPU busy ratio). Every number the report
// prints comes from instrumented page timelines, not from wall-clock guesses:
//
//   boot      engine ready -> title scenario up
//   load      继续 -> slot -> scene restored (black-screen wait = slot click
//             until the frame cadence recovers)
//   dialogue  N clicks; per click: advance latency, voice start latency
//             (click -> first AudioBufferSourceNode.start after a new .ogg
//             open), long-task totals, longest rAF gap
//
// Usage:
//   node tests/d5_throttled_bench.js [BASE] [--rate N] [--label name]
//        [--dialogue-rounds N] [--skip-load] [--skip-dialogue]
//
// The persistent profile already holds the installed senren-banka content;
// never run two instances against the same profile.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const firstArg = process.argv[2];
const BASE_URL = (firstArg && !firstArg.startsWith("--")) ? firstArg : "https://127.0.0.1:8443/";

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const hasFlag = (flag) => process.argv.includes(flag);

const RATE = Number(argValue("--rate", "6"));
const LABEL = argValue("--label", "run-" + Date.now());
const DIALOGUE_ROUNDS = Number(argValue("--dialogue-rounds", "60"));
const SKIP_LOAD = hasFlag("--skip-load");
const SKIP_DIALOGUE = hasFlag("--skip-dialogue");
const OUT_DIR = path.resolve("build/d5-bench");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executablePath = process.env.KRKR2_CHROME_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const context = await chromium.launchPersistentContext("E:\\krkr2-audit-profile", {
    headless: true, executablePath,
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors"],
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    serviceWorkers: "block"
  });

  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });
    console.log(`cpu throttle rate=${RATE}`);

    await context.addInitScript(function () {
      var bench = {
        t0: performance.now(),
        raf: [], long: [], starts: [], clicks: [], voices: []
      };
      window.__bench = bench;
      var lastRaf = 0;
      var nativeRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) {
        return nativeRaf(function (ts) {
          if (lastRaf && ts - lastRaf > 2000) {
            // tab was hidden or the loop restarted; drop the stale gap
            bench.raf.push(ts); lastRaf = ts;
          } else {
            bench.raf.push(ts); lastRaf = ts;
          }
          if (bench.raf.length > 60000) { bench.raf.splice(0, 30000); }
          return cb(ts);
        });
      };
      try {
        var po = new PerformanceObserver(function (list) {
          var e = list.getEntries();
          for (var i = 0; i < e.length; i++) {
            bench.long.push({ s: Math.round(e[i].startTime), d: Math.round(e[i].duration) });
          }
          if (bench.long.length > 8000) { bench.long.splice(0, 4000); }
        });
        po.observe({ entryTypes: ["longtask"] });
      } catch (e) {}
      var origStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function () {
        bench.starts.push(performance.now());
        if (bench.starts.length > 20000) { bench.starts.splice(0, 10000); }
        return origStart.apply(this, arguments);
      };
    });

    const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, LABEL + "-" + name) }).catch(() => {});
    const report = { base: BASE_URL, rate: RATE, label: LABEL, startedAt: new Date().toISOString(), phases: {} };

    // ---------- boot ----------
    const bootT0 = Date.now();
    {
      var __base = BASE_URL.replace(/\/+$/, "");
      var __join = __base.indexOf("?") !== -1 ? "&" : "?";
      await page.goto(__base + __join + "engineVariant=baseline", { waitUntil: "networkidle", timeout: 60000 });
    }
    await page.waitForFunction(function () {
      return window.d4AppState && window.d4AppState().catalog;
    }, null, { timeout: 30000 });
    await page.getByRole("button", { name: "游戏库", exact: true }).click();
    await page.locator(".game-card[data-game-id=\"senren-banka\"]").click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "启动游戏" }).click();
    await page.waitForFunction(function () { return window.d4PlayerState().ready; }, null, { timeout: 180000 });

    await page.evaluate(function () {
      var bridge = window.krkr2webPrefetch;
      var original = bridge.notifyOpen.bind(bridge);
      window.__predictionLog = [];
      bridge.notifyOpen = function (a, b, c, d, e) {
        window.__predictionLog.push({
          name: String(b), prediction: !!d, t: performance.now()
        });
        if (window.__predictionLog.length > 900) { window.__predictionLog.shift(); }
        return original(a, b, c, d, e);
      };
    });

    for (var t = 0; t < 60; t += 1) {
      const up = await page.evaluate(function () {
        return (window.__predictionLog || []).some(function (e) {
          return e.name.indexOf("title") !== -1;
        });
      });
      if (up) { break; }
      await page.waitForTimeout(2000);
    }
    report.phases.boot = await collectPhase(page, {
      name: "boot-to-title", t0: bootT0, t1: Date.now()
    });
    await shot("title.png");
    await page.waitForTimeout(4000);

    const rect = await page.evaluate(function () {
      var r = document.getElementById("canvas").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;

    // ---------- new game via title 新游戏 (benchmarks that way; save-load
    // path clicks 155,231+52 / slot and never reaches a voiced scene, so
    // voiceCount stays 0 and dialogue stalls are not measurable) ----------
    await page.evaluate(function () {
      window.__bench.dialogueMark = performance.now();
    });
    const opensBeforeNewGame = await page.evaluate(function () {
      return (window.__predictionLog || []).length;
    });
    await page.mouse.click(rect.x + 155, rect.y + 231);
    await page.waitForTimeout(3200);
    let newGameStarted = false;
    for (var w = 0; w < 18 && !newGameStarted; w += 1) {
      const opens = await page.evaluate(function () {
        return (window.__predictionLog || []).length;
      });
      if (opens > opensBeforeNewGame + 6) { newGameStarted = true; break; }
      await page.mouse.click(cx, cy).catch(function () {});
      await page.waitForTimeout(1200);
    }
    await shot("after-newgame.png");
    const dialogueMarkT = await page.evaluate(function () {
      return window.__bench.dialogueMark || 0;
    });

    // ---------- dialogue ----------
    // record a staged mark so the leg can be windowed separately from boot;
    // keep overall for legacy comparison
    if (!SKIP_DIALOGUE) {
      report.phases.dialogue = await dialogueLeg(page, cx, cy, shot, dialogueMarkT);
      await shot("dialogue-done.png");
    }

    report.phases.newGame = { started: newGameStarted, opensBeforeNewGame: opensBeforeNewGame };
    report.phases.overall = await collectPhase(page, { name: "overall", t0: bootT0, t1: Date.now() });
    const outPath = path.join(OUT_DIR, LABEL + ".json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log("BENCH REPORT " + outPath);
    summarize(report);
  } finally {
    await context.close();
  }
}

async function loadViaContinueMenu(page, rect, shot) {
  // mark timeline, click 继续 (below 新游戏), then the first slot
  const phase = { name: "load-save" };
  await page.evaluate(function () {
    window.__bench.clicks.push({ t: performance.now(), kind: "load-menu" });
  });
  await page.mouse.click(rect.x + 155, rect.y + 231 + 52);
  await page.waitForTimeout(2500);
  await shot("load-menu.png");
  // slot list: first slot row is near the top of the panel; click center-left
  await page.evaluate(function () {
    window.__bench.clicks.push({ t: performance.now(), kind: "load-slot" });
  });
  await page.mouse.click(rect.x + rect.w / 2, rect.y + 150);
  await page.waitForTimeout(1200);
  await shot("load-slot-clicked.png");
  // wait until frame cadence recovers: 4 consecutive rAF gaps < 100 ms
  const ready = await page.evaluate(function () {
    return new Promise(function (resolve) {
      var deadline = performance.now() + 120000;
      function tick() {
        var raf = window.__bench.raf;
        var n = raf.length;
        if (n >= 4) {
          var ok = true;
          for (var i = n - 3; i < n; i++) {
            if (raf[i] - raf[i - 1] > 100) { ok = false; break; }
          }
          if (ok) { resolve(raf[n - 1]); return; }
        }
        if (performance.now() > deadline) { resolve(-1); return; }
        setTimeout(tick, 100);
      }
      setTimeout(tick, 300);
    });
  });
  const marks = await page.evaluate(function () {
    return window.__bench.clicks.filter(function (c) { return c.kind === "load-slot"; }).pop();
  });
  phase.slotClickAt = marks ? marks.t : null;
  phase.framesReadyAt = ready;
  phase.waitMs = (marks && ready > 0) ? Math.round(ready - marks.t) : null;
  const nowT = await performanceNow(page);
  phase.stats = await windowStats(page, marks ? marks.t : 0, nowT);
  // cpuBusyPct for the short load window can legitimately be 0 (throttle
  // amplifies wall); keep the whole-window value too so callers can see 30%
  // without digging into smoke.json.
  phase.stats.wallMs = (marks && nowT > marks.t) ? Math.round(nowT - marks.t) : null;
  return phase;
}

async function performanceNow(page) {
  return page.evaluate(function () { return performance.now(); });
}

async function dialogueLeg(page, cx, cy, shot, dialogueMarkT) {
  const rounds = [];
  for (var round = 0; round < DIALOGUE_ROUNDS; round += 1) {
    await page.evaluate(function () {
      window.__bench.clicks.push({ t: performance.now(), kind: "dlg" });
    });
    const clickT = await page.evaluate(function () { return performance.now(); });
    await page.mouse.click(cx, cy).catch(function () {});
    await page.waitForTimeout(700);
    const stat = await page.evaluate(function (arg) {
      var b = window.__bench;
      var winStart = b.clicks[b.clicks.length - 1].t;
      var opens = window.__predictionLog || [];
      var newOpens = [];
      for (var i = opens.length - 1; i >= 0; i -= 1) {
        if (opens[i].t < winStart) { break; }
        newOpens.unshift(opens[i]);
      }
      var voice = null;
      for (var j = 0; j < newOpens.length; j += 1) {
        if (/\.ogg$/i.test(newOpens[j].name) && !newOpens[j].prediction) { voice = newOpens[j]; break; }
      }
      var voiceLatency = null;
      if (voice) {
        for (var k = 0; k < b.starts.length; k += 1) {
          if (b.starts[k] >= voice.t && b.starts[k] - arg.clickTime < 5000) {
            voiceLatency = Math.round(b.starts[k] - arg.clickTime); break;
          }
        }
      }
      var sprites = newOpens.filter(function (e) {
        return /\.(tlg|png|webp|jpg)$/i.test(e.name) && !e.prediction;
      }).map(function (e) { return e.name; });
      return {
        voiceLatency: voiceLatency, sprites: sprites,
        opens: newOpens.map(function (e) { return e.name; }),
        startCountInWindow: newOpens.filter(function (e) { return /\.ogg$/i.test(e.name); }).length
      };
    }, { clickTime: clickT });
    rounds.push(stat);
  }
  const all = await collectBenchWindow(page);
  const dialogueWindow = (dialogueMarkT && dialogueMarkT > 0)
    ? await windowStats(page, dialogueMarkT, await performanceNow(page))
    : null;
  const voices = rounds.filter(function (r) { return r.voiceLatency !== null; });
  const spriteRounds = rounds.filter(function (r) { return r.sprites.length > 0; });
  return {
    name: "dialogue",
    rounds: DIALOGUE_ROUNDS,
    voiceStartLatencyMs: pct(voices.map(function (r) { return r.voiceLatency; })),
    voiceCount: voices.length,
    spriteSwitchRounds: spriteRounds.length,
    windowStats: all,
    dialogueWindow: dialogueWindow
  };
}

async function collectBenchWindow(page) {
  return page.evaluate(function () {
    var b = window.__bench;
    var raf = b.raf;
    var gaps = [];
    for (var i = 1; i < raf.length; i += 1) { gaps.push(raf[i] - raf[i - 1]); }
    var stalls = gaps.filter(function (g) { return g > 250; });
    var busy = 0;
    for (var j = 0; j < b.long.length; j += 1) { busy += b.long[j].d; }
    var wall = raf.length ? (raf[raf.length - 1] - raf[0]) : 1;
    return {
      longTaskCount: b.long.length,
      longTaskTotalMs: Math.round(busy),
      cpuBusyPct: Math.round(busy * 100 / Math.max(wall, 1)),
      rafFrameCount: raf.length,
      avgFrameMs: gaps.length ? Math.round(gaps.reduce(function (a, c) { return a + c; }, 0) / gaps.length) : null,
      stallCount: stalls.length,
      stallMaxMs: stalls.length ? Math.max.apply(null, stalls) : 0,
      stallTotalMs: stalls.reduce(function (a, c) { return a + c; }, 0),
      p95FrameMs: gaps.length ? (function (g) {
        g.sort(function (a, b) { return a - b; });
        return g[Math.min(g.length - 1, Math.floor(g.length * 0.95))];
      })(gaps.slice()) : null
    };
  });
}

async function windowStats(page, fromT, nowT) {
  return page.evaluate(function (range) {
    var b = window.__bench;
    var gaps = [];
    for (var i = 1; i < b.raf.length; i += 1) {
      if (b.raf[i] >= range.from && b.raf[i - 1] >= range.from) { gaps.push(b.raf[i] - b.raf[i - 1]); }
    }
    var busy = 0, cnt = 0;
    for (var j = 0; j < b.long.length; j += 1) {
      if (b.long[j].s >= range.from) { busy += b.long[j].d; cnt += 1; }
    }
    var stalls = gaps.filter(function (g) { return g > 250; });
    var wall = Math.max(range.to - range.from, 1);
    return {
      longTaskCount: cnt, longTaskTotalMs: Math.round(busy),
      cpuBusyPct: Math.round(busy * 100 / wall),
      stallCount: stalls.length,
      stallMaxMs: stalls.length ? Math.max.apply(null, stalls) : 0,
      stallTotalMs: Math.round(stalls.reduce(function (a, c) { return a + c; }, 0))
    };
  }, { from: fromT, to: nowT });
}

async function collectPhase(page, spec) {
  const now = await performanceNow(page);
  const stats = await windowStats(page, 0, now);
  return Object.assign(spec, { stats: stats });
}

function pct(arr) {
  if (!arr.length) { return { n: 0, avg: null, p50: null, p95: null, max: null }; }
  const s = arr.slice().sort(function (a, b) { return a - b; });
  return {
    n: s.length,
    avg: Math.round(s.reduce(function (a, c) { return a + c; }, 0) / s.length),
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s[s.length - 1]
  };
}

function summarize(report) {
  const p = report.phases;
  const line = (k, v) => console.log("  " + k + ": " + JSON.stringify(v));
  console.log("SUMMARY label=" + report.label + " rate=" + report.rate);
  if (p.load) { line("load.waitMs", p.load.waitMs); line("load.stats", p.load.stats); }
  if (p.newGame) { line("newGame", p.newGame); }
  if (p.dialogue) {
    line("dialogue.voiceStartLatencyMs", p.dialogue.voiceStartLatencyMs);
    line("dialogue.voiceCount", p.dialogue.voiceCount);
    line("dialogue.spriteSwitchRounds", p.dialogue.spriteSwitchRounds);
    line("dialogue.windowStats", p.dialogue.windowStats);
    if (p.dialogue.dialogueWindow) { line("dialogue.dialogueWindow", p.dialogue.dialogueWindow); }
  }
}

main().catch(function (error) {
  console.error("BENCH FAIL: " + (error.stack || error.message));
  process.exit(1);
});
