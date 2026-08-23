"use strict";

// P0-1 verification (docs/10-migration-log.md): the engine main loop runs
// behind a RAF frame-rate gate (patch 0082). Asserts the configured rate
// takes effect (?fps= URL parameter, krkr2webTargetFps global override,
// 20 FPS default) and that the gate actually skips display frames.

const path = require("path");
const { chromium } = require("playwright");

async function readGateStats(page, windowMS) {
  return page.evaluate(function (windowMs) {
    return new Promise(function (resolve) {
      var started = performance.now();
      var ticksBefore = globalThis.krkr2webFrameGateTicks | 0;
      var skipsBefore = globalThis.krkr2webFrameGateSkips | 0;
      setTimeout(function () {
        resolve({
          configuredFps: globalThis.krkr2webFrameGateFps,
          ticks: (globalThis.krkr2webFrameGateTicks | 0) - ticksBefore,
          skips: (globalThis.krkr2webFrameGateSkips | 0) - skipsBefore,
          elapsedMS: performance.now() - started
        });
      }, windowMs);
    });
  }, windowMS);
}

async function measure(page, url, targetFpsOverride, windowMS) {
  if (targetFpsOverride) {
    await page.addInitScript(function (fps) {
      window.krkr2webTargetFps = fps;
    }, targetFpsOverride);
  }
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.click("#start-button");
  await page.waitForFunction(function () {
    return document.body.dataset.state === "ready" || document.body.dataset.state === "pass" || document.body.dataset.state === "fail";
  }, null, { timeout: 60000 });
  var state = await page.evaluate(function () { return document.body.dataset.state; });
  if (state === "fail") {
    throw new Error("D3 probe reported failure before the frame-gate measurement: " +
      await page.evaluate(function () { return document.getElementById("detail").textContent; }));
  }
  await page.waitForTimeout(1000);
  return readGateStats(page, windowMS);
}

function assertRate(label, stats, expectedFps) {
  var rate = stats.ticks / (stats.elapsedMS / 1000);
  var bounds = [expectedFps * 0.45, expectedFps * 1.6];
  if (stats.configuredFps !== expectedFps) {
    throw new Error(label + ": configured fps " + stats.configuredFps + " != " + expectedFps);
  }
  if (!(rate >= bounds[0] && rate <= bounds[1])) {
    throw new Error(label + ": tick rate " + rate.toFixed(2) + "/s outside [" + bounds[0].toFixed(1) + ", " + bounds[1].toFixed(1) + "] for target " + expectedFps + " FPS (" + JSON.stringify(stats) + ")");
  }
  if (stats.skips < stats.ticks) {
    throw new Error(label + ": gate skipped " + stats.skips + " frames but ran " + stats.ticks + " ticks; throttling inactive? " + JSON.stringify(stats));
  }
  return rate;
}

async function main() {
  const url = process.argv[2] || "http://127.0.0.1:8765/?gameId=d3-test";
  const executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
  const consoleLines = [];
  try {
    // 1. ?fps=10 URL parameter.
    var page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("console", function (message) { consoleLines.push(message.type() + ": " + message.text()); });
    page.on("pageerror", function (error) { consoleLines.push("pageerror: " + error.stack); });
    var at10 = await measure(page, url + "&fps=10", null, 4000);
    await page.close();
    var rate10 = assertRate("fps=10", at10, 10);

    // 2. Default (no parameter): 20 FPS.
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("console", function (message) { consoleLines.push(message.type() + ": " + message.text()); });
    page.on("pageerror", function (error) { consoleLines.push("pageerror: " + error.stack); });
    var atDefault = await measure(page, url, null, 4000);
    await page.close();
    var rateDefault = assertRate("default", atDefault, 20);

    // 3. krkr2webTargetFps global beats the URL parameter.
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("console", function (message) { consoleLines.push(message.type() + ": " + message.text()); });
    page.on("pageerror", function (error) { consoleLines.push("pageerror: " + error.stack); });
    var atOverride = await measure(page, url + "&fps=10", 30, 4000);
    await page.close();
    var rateOverride = assertRate("global override", atOverride, 30);

    if (!(rateOverride > rate10)) {
      throw new Error("global override rate " + rateOverride.toFixed(2) + " did not exceed ?fps=10 rate " + rate10.toFixed(2));
    }
    process.stdout.write(JSON.stringify({
      fps10: { rate: rate10, stats: at10 },
      default20: { rate: rateDefault, stats: atDefault },
      override30: { rate: rateOverride, stats: atOverride },
      consoleLines: consoleLines.slice(-10)
    }, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
