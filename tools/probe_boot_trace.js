"use strict";
// Single-round boot tracer: print engineLog evolution to find where it stalls.
const { chromium } = require("playwright-core");
(async () => {
  const context = await chromium.launchPersistentContext("E:\krkr2-audit-profile", {
    headless: false, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors"],
    viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true, serviceWorkers: "block",
    hasTouch: true
  });
  const page = await context.newPage();
  await page.goto("https://127.0.0.1:8443/?engineVariant=baseline", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.d4AppState && window.d4AppState().catalog, null, { timeout: 30000 });
  await page.locator(".game-card[data-game-id=\"senren-banka\"]").click({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "启动游戏" }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.d4PlayerState && window.d4PlayerState().ready, null, { timeout: 180000 });
  console.log("READY. rect check:");
  const rect = await page.evaluate(() => {
    const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log(JSON.stringify(rect));
  let seen = 0;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(3000);
    const lines = await page.evaluate(n2 => (window.d4PlayerState().engineLog || []).slice(-n2).map(x => String(x).replace(/^std(out|err): /, "")), 6);
    for (const l of lines) console.log("t+" + (i * 3 + 9) + "s", l);
  }
  await context.close();
})().catch(e => { console.error("FAIL: " + (e.stack || e.message)); process.exit(1); });