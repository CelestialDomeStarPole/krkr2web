"use strict";

// One-time installer: populates the shared audit profile (E:\krkr2-audit-profile)
// with the senren-banka content so tests/d5_throttled_bench.js can run.
// The benchmark's persistent profile is expected to ALREADY hold the installed
// content; this script performs that install by driving the product's
// "完整下载" button.

const fs = require("fs");
const { chromium } = require("playwright-core");

const BASE = process.argv[2] || "https://127.0.0.1:8443/";
const PROFILE = "E:\\krkr2-audit-profile";
const TIMEOUT_MS = 60 * 60 * 1000; // 1h absolute ceiling

async function main() {
  const executablePath = process.env.KRKR2_CHROME_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath,
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors"],
    viewport: { width: 1280, height: 720 },
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

    // The detail panel shows "完整下载" (or "继续下载") until content is present.
    const installBtn = page.getByRole("button", { name: /完整下载|继续下载/ });
    const btnCount = await installBtn.count();
    if (btnCount === 0) {
      // Possibly already installed; check state before deciding.
      const st = await page.evaluate(function () {
        var a = window.d4AppState();
        return a && a.installs && a.installs["senren-banka"];
      });
      console.log("no download button; install state = " + JSON.stringify(st, null, 2));
      if (st && st.status === "ready" && st.complete) {
        console.log("INSTALL_ALREADY_PRESENT");
        return;
      }
      throw new Error("expected a download button but none found; state=" + JSON.stringify(st));
    }

    console.log("clicking download button");
    await installBtn.first().click();

    const deadline = Date.now() + TIMEOUT_MS;
    let lastLog = 0;
    for (;;) {
      if (Date.now() > deadline) { throw new Error("install timed out"); }
      const st = await page.evaluate(function () {
        var a = window.d4AppState();
        return a && a.installs && a.installs["senren-banka"];
      }).catch(function () { return null; });
      const status = st && st.status;
      const complete = st && st.complete === true;
      const bytes = st ? Number(st.committedBytes || 0) : 0;
      const total = st ? Number(st.totalBytes || 0) : 0;
      const pct = total ? (100 * bytes / total).toFixed(1) : "?";
      const now = Date.now();
      if (now - lastLog > 5000) {
        console.log("status=" + status + " complete=" + complete + " " + bytes + "/" + total + " (" + pct + "%)");
        lastLog = now;
      }
      if (status === "ready" && complete) {
        console.log("INSTALL_COMPLETE " + bytes + "/" + total);
        return;
      }
      if (status === "fatal-error") {
        throw new Error("install hit fatal-error: " + JSON.stringify(st));
      }
      await page.waitForTimeout(3000);
    }
  } finally {
    await context.close();
  }
}

main().catch(function (error) {
  console.error("INSTALL FAIL: " + (error.stack || error.message));
  process.exit(1);
});
