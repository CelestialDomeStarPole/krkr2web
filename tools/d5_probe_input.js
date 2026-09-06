"use strict";

// Discriminating probe: on the first-boot screens (fresh profile goes
// custom.ks *logo -> *caution -> ... -> title menu), find out which input
// channel actually advances the scenario: mouse click vs touchscreen tap.
// Reads the engine scenario state purely from engineLog LABEL/SCENARIO
// markers, so no screenshots are involved.

const { chromium } = require("playwright-core");

const BASE = process.argv[2] || "https://127.0.0.1:8443/";

async function main() {
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
    const base = BASE.replace(/\/+$/, "");
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

    const rect = await page.evaluate(function () {
      var r = document.getElementById("canvas").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    console.log("CANVAS " + JSON.stringify(rect));

    const logTail = () => page.evaluate(function () {
      var el = (window.d4PlayerState().engineLog || []);
      return el.filter(function (l) {
        return /LABEL|SCENARIO|DRAW|caution|title|langselect|first/.test(l);
      }).slice(-6);
    });

    // Wait for the game to settle somewhere past boot (caution screen on a
    // fresh profile; title menu on a warm one).
    await page.waitForTimeout(6000);
    console.log("SETTLED:");
    (await logTail()).forEach(function (l) { console.log("  " + l); });

    // Experiment 1: three mouse clicks at canvas center.
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.click(cx, cy).catch(function () {});
      await page.waitForTimeout(1500);
    }
    console.log("AFTER MOUSE x3:");
    (await logTail()).forEach(function (l) { console.log("  " + l); });

    // Experiment 2: three touchscreen taps at canvas center.
    for (let i = 0; i < 3; i += 1) {
      await page.touchscreen.tap(cx, cy).catch(function (e) { console.log("tap err " + e); });
      await page.waitForTimeout(1500);
    }
    console.log("AFTER TAP x3:");
    (await logTail()).forEach(function (l) { console.log("  " + l); });

    // Experiment 3: taps at the 新游戏 spot (155,231) in case we are on the
    // title menu already.
    await page.touchscreen.tap(rect.x + 155, rect.y + 231).catch(function () {});
    await page.waitForTimeout(2500);
    console.log("AFTER TAP(155,231):");
    (await logTail()).forEach(function (l) { console.log("  " + l); });

    const audio = await page.evaluate(function () {
      var p = window.d4PlayerState().audio;
      return { starts: p && p.probe ? p.probe.starts : null };
    });
    console.log("AUDIO_STARTS " + JSON.stringify(audio));
  } finally {
    await context.close();
  }
}
main().catch(function (e) { console.error("INPUT PROBE FAIL: " + (e.stack || e.message)); process.exit(1); });
