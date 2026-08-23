"use strict";

const { chromium } = require("playwright");

async function main() {
  const url = process.argv[2] || "http://127.0.0.1:8767/?gameId=d3-test&soakSeconds=5";
  const executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  // https:// bases point at the self-signed device-grade endpoints; bypass
  // cert errors at launch level so every page inherits it.
  const launchArgs = ["--autoplay-policy=no-user-gesture-required"];
  if (url.indexOf("https://") === 0) { launchArgs.push("--ignore-certificate-errors"); }
  const browser = await chromium.launch({ headless: true, executablePath, args: launchArgs });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(message.type() + ": " + message.text()));
  page.on("pageerror", (error) => consoleLines.push("pageerror: " + error.stack));
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.click("#start-button");
    try {
      await page.waitForFunction(function () {
        return window.d3ProbeReport && window.d3ProbeReport().results.interactive.ready;
      }, null, { timeout: 60000 });
    } catch (error) {
      var bootDiagnostics = await page.evaluate(function () {
        return {
          status: document.getElementById("status").textContent,
          detail: document.getElementById("detail").textContent,
          report: window.d3ProbeReport ? window.d3ProbeReport() : null
        };
      });
      throw new Error("D3 stability boot timeout: " + JSON.stringify(bootDiagnostics) + "\n" + consoleLines.join("\n") + "\n" + error.message);
    }
    try {
      await page.waitForFunction(function () {
        return document.getElementById("soak-heartbeat").textContent.indexOf("正常") === 0;
      }, null, { timeout: 10000 });
    } catch (error) {
      var diagnostics = await page.evaluate(function () {
        return {
          status: document.getElementById("status").textContent,
          detail: document.getElementById("detail").textContent,
          heartbeat: document.getElementById("soak-heartbeat").textContent,
          report: window.d3ProbeReport()
        };
      });
      throw new Error("D3 heartbeat timeout: " + JSON.stringify(diagnostics) + "\n" + consoleLines.join("\n") + "\n" + error.message);
    }
    await page.evaluate(function () { window.krkr2StorageBridge = undefined; });
    await page.waitForTimeout(1200);
    const bridgeLifecycle = await page.evaluate(function () { return window.d3ProbeReport(); });
    if (bridgeLifecycle.results.storage.metrics.readCalls === 0 || bridgeLifecycle.results.stability.fatalErrors.length !== 0) {
      throw new Error("D3 lost its captured storage bridge after engine boot: " + JSON.stringify(bridgeLifecycle));
    }
    await page.click("#soak-button");
    await page.waitForTimeout(2300);
    await page.click("#soak-button");
    const paused = await page.evaluate(function () { return window.d3ProbeSoakState(); });
    if (paused.status !== "paused" || paused.accumulatedVisibleMs < 1000 || paused.segments.length !== 1) {
      throw new Error("D3 stability manual pause did not persist: " + JSON.stringify(paused));
    }
    await page.evaluate(function () {
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && key.indexOf("krkr2web-d3-soak-v1-") === 0) {
          var saved = JSON.parse(localStorage.getItem(key));
          saved.fatalErrors = ["Uncaught TypeError: Cannot read property 'snapshot' of undefined"];
          localStorage.setItem(key, JSON.stringify(saved));
        }
      }
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.click("#start-button");
    await page.waitForFunction(function () {
      return window.d3ProbeReport && window.d3ProbeReport().results.interactive.ready;
    }, null, { timeout: 60000 });
    await page.waitForFunction(function () {
      return document.getElementById("soak-button").textContent === "继续稳定性测试";
    }, null, { timeout: 10000 });
    const migrated = await page.evaluate(function () { return window.d3ProbeSoakState(); });
    if (migrated.fatalErrors.length !== 0 || migrated.accumulatedVisibleMs < paused.accumulatedVisibleMs) {
      throw new Error("D3 did not preserve progress while migrating legacy probe errors: " + JSON.stringify(migrated));
    }
    await page.click("#soak-button");
    await page.waitForFunction(function () {
      var state = window.d3ProbeSoakState();
      return state.status === "pass" && state.gate && state.gate.passed;
    }, null, { timeout: 15000 });
    const result = await page.evaluate(function () { return window.d3ProbeReport(); });
    const stability = result.results.stability;
    if (result.reportVersion !== 5 || stability.segments.length < 2 || stability.samples.length < 3 ||
        stability.accumulatedVisibleMs < 5000 || !stability.gate.durationPassed ||
        !stability.gate.minimumSegmentPassed || !stability.gate.heartbeatPassed ||
        !stability.gate.memoryPassed || !stability.gate.errorsPassed) {
      throw new Error("D3 stability gate failed: " + JSON.stringify(stability));
    }
    await page.click("#upload-button");
    await page.waitForFunction(function () {
      return document.getElementById("upload-button").textContent === "报告已上传";
    }, null, { timeout: 10000 });
    var uploadDetail = await page.locator("#detail").textContent();
    process.stdout.write(JSON.stringify({
      status: stability.status,
      accumulatedVisibleMs: stability.accumulatedVisibleMs,
      segments: stability.segments.length,
      samples: stability.samples.length,
      gate: stability.gate,
      uploadDetail: uploadDetail
    }, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
