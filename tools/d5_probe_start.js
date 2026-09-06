"use strict";

// Probe: click 启动游戏, then dump d4PlayerState and screenshot to see whether
// the game surface appears and whether the engine reaches the title screen.
const { chromium } = require("playwright-core");

async function main() {
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
    const consoleLogs = [];
    page.on("console", function (m) { consoleLogs.push(m.type() + ": " + m.text()); });
    await page.goto("https://127.0.0.1:8443/?engineVariant=baseline", { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForFunction(function () { return window.d4AppState && window.d4AppState().catalog; }, null, { timeout: 30000 });
    await page.getByRole("button", { name: "游戏库", exact: true }).click();
    await page.locator('.game-card[data-game-id="senren-banka"]').click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "启动游戏" }).click();

    // Poll player state for up to 60s.
    const start = Date.now();
    let last = null;
    for (let i = 0; i < 60; i += 1) {
      const st = await page.evaluate(function () {
        try { return window.d4PlayerState(); } catch (e) { return { err: String(e) }; }
      });
      if (JSON.stringify(st) !== JSON.stringify(last)) {
        console.log("t+" + Math.round((Date.now() - start) / 1000) + "s state=" + JSON.stringify(st));
        last = st;
      }
      if (st && st.ready) { break; }
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: "build/d5-bench/probe-after-start.png" });
    const dims = await page.evaluate(function () {
      var c = document.getElementById("canvas");
      var r = c && c.getBoundingClientRect();
      var ifr = Array.prototype.map.call(document.querySelectorAll("iframe"), function (f) {
        return { src: (f.getAttribute("src") || "").slice(0, 60), id: f.id, w: f.clientWidth, h: f.clientHeight };
      });
      var canv = document.querySelectorAll("canvas").length;
      return { canvasRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, iframes: ifr, canvasCount: canv };
    });
    console.log("DIMS " + JSON.stringify(dims));
    console.log("CONSOLE_TAIL");
    console.log(consoleLogs.slice(-30).join("\n"));
  } finally {
    await context.close();
  }
}
main().catch(function (e) { console.error("PROBE FAIL: " + (e.stack || e.message)); process.exit(1); });
