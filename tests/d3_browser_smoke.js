"use strict";

const path = require("path");
const { chromium } = require("playwright");

function assertFramePixels(pixels) {
  const colorful = pixels.filter(function (pixel) {
    const maximum = Math.max(pixel[0], pixel[1], pixel[2]);
    const minimum = Math.min(pixel[0], pixel[1], pixel[2]);
    return maximum >= 90 && maximum - minimum >= 35;
  });
  if (colorful.length < 3) {
    throw new Error("D3 canvas did not expose the expected decoded image colors: " + JSON.stringify(pixels));
  }
}

async function readPage(page) {
  return page.evaluate(function () {
    var canvas = document.getElementById("canvas");
    var aside = document.querySelector("aside");
    var toolbar = document.querySelector(".toolbar");
    var actions = document.querySelector(".actions");
    var button = document.getElementById("upload-button");
    var rect = button.getBoundingClientRect();
    var target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    function bounds(element) {
      var elementRect = element.getBoundingClientRect();
      return {
        left: elementRect.left,
        top: elementRect.top,
        right: elementRect.right,
        bottom: elementRect.bottom,
        width: elementRect.width,
        height: elementRect.height,
        display: getComputedStyle(element).display,
        visibility: getComputedStyle(element).visibility
      };
    }
    return {
      report: window.d3ProbeReport(),
      status: document.getElementById("status").textContent,
      detail: document.getElementById("detail").textContent,
      uploadButtonAvailable: rect.width > 0 && rect.height > 0 && (target === button || button.contains(target)),
      canvas: { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight },
      layout: {
        viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
        canvas: bounds(canvas),
        aside: bounds(aside),
        toolbar: bounds(toolbar),
        actions: bounds(actions)
      }
    };
  });
}

async function sampleCanvas(page, canvasImage) {
  return page.evaluate(async function (pngBytes) {
    var blob = new Blob([new Uint8Array(pngBytes)], { type: "image/png" });
    var bitmap = await createImageBitmap(blob);
    var sample = document.createElement("canvas");
    sample.width = 5;
    sample.height = 3;
    var context = sample.getContext("2d");
    context.drawImage(bitmap, 0, 0, sample.width, sample.height);
    var data = context.getImageData(0, 0, sample.width, sample.height).data;
    var pixels = [];
    for (var offset = 0; offset < data.length; offset += 4) {
      pixels.push([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]);
    }
    bitmap.close();
    return pixels;
  }, Array.from(canvasImage));
}

function assertStorageAndCanvas(result) {
  var storage = result.report.results.storage;
  if (storage.metrics.readCalls === 0 || storage.metrics.indexedDbBytes === 0) {
    throw new Error("D3 did not read XP3 bytes from IndexedDB: " + JSON.stringify(result));
  }
  if (storage.metrics.maximumCacheBytes > 16 * 1024 * 1024) {
    throw new Error("D3 XP3 cache exceeded 16 MiB: " + storage.metrics.maximumCacheBytes);
  }
  if (result.canvas.width < 640 || result.canvas.height < 360 || result.canvas.clientWidth === 0 || result.canvas.clientHeight === 0) {
    throw new Error("D3 canvas dimensions are invalid: " + JSON.stringify(result.canvas));
  }
  if (!result.uploadButtonAvailable) {
    throw new Error("D3 upload button is hidden behind the engine canvas");
  }
  var layout = result.layout;
  var visible = function (bounds) {
    return bounds.display !== "none" && bounds.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
  };
  if (!visible(layout.aside) || layout.aside.right > layout.viewport.width + 1 || layout.aside.bottom > layout.viewport.height + 1) {
    throw new Error("D3 status panel is not visible inside the viewport: " + JSON.stringify(layout));
  }
  if (!visible(layout.toolbar) || !visible(layout.actions)) {
    throw new Error("D3 toolbar controls disappeared after engine boot: " + JSON.stringify(layout));
  }
  if (layout.canvas.right > layout.aside.left + 1) {
    throw new Error("D3 canvas overlaps the status panel: " + JSON.stringify(layout));
  }
  if (layout.viewport.scrollWidth > layout.viewport.width + 1) {
    throw new Error("D3 host layout overflows horizontally: " + JSON.stringify(layout));
  }
}

async function boot(page) {
  await page.click("#start-button");
  await waitForBoot(page);
}

async function waitForBoot(page) {
  try {
    await page.waitForFunction(function () {
      return document.body.dataset.state === "ready" || document.body.dataset.state === "pass" || document.body.dataset.state === "fail";
    }, null, { timeout: 60000 });
  } catch (error) {
    var diagnostics = await page.evaluate(function () {
      return {
        state: document.body.dataset.state,
        status: document.getElementById("status").textContent,
        detail: document.getElementById("detail").textContent,
        report: window.d3ProbeReport ? window.d3ProbeReport() : null
      };
    });
    throw new Error("D3 boot timeout: " + JSON.stringify(diagnostics) + "\n" + error.message);
  }
  await page.waitForTimeout(500);
}

async function main() {
  const url = process.argv[2] || "http://127.0.0.1:8765/?gameId=d3-test";
  const output = process.argv[3] || path.resolve("build/d3-browser-smoke.png");
  const executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(message.type() + ": " + message.text()));
  page.on("pageerror", (error) => consoleLines.push("pageerror: " + error.stack));
  page.on("dialog", async (dialog) => { consoleLines.push("dialog: " + dialog.message()); await dialog.dismiss(); });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await boot(page);
    const before = await readPage(page);
    const canvas = page.locator("#canvas");
    const beforeImage = await canvas.screenshot();
    const sampledPixels = await sampleCanvas(page, beforeImage);
    assertStorageAndCanvas(before);
    assertFramePixels(sampledPixels);
    var initialKag = before.report.results.interactive.kag;
    if (!before.report.results.interactive.ready || !before.report.results.interactive.imageTextReady || !initialKag.ready || initialKag.textPhases.indexOf("intro") === -1) {
      throw new Error("D3 KAG intro scene was not ready: " + JSON.stringify(before));
    }

    await canvas.click({ position: { x: 640, y: 360 } });
    try {
      await page.waitForFunction(function () {
        var report = window.d3ProbeReport && window.d3ProbeReport();
        return report && report.results.interactive.kag.choiceReady;
      }, null, { timeout: 15000 });
    } catch (error) {
      throw new Error("D3 KAG choice timeout: " + JSON.stringify(await readPage(page)) + "\n" + consoleLines.join("\n") + "\n" + error.message);
    }
    const afterChoice = await readPage(page);
    const choiceImage = await canvas.screenshot();
    if (Buffer.compare(beforeImage, choiceImage) === 0) {
      throw new Error("D3 scene did not change when the KAG choice opened");
    }

    await page.waitForTimeout(350);
    await canvas.click({ position: { x: 250, y: 440 } });
    try {
      await page.waitForFunction(function () {
        var report = window.d3ProbeReport && window.d3ProbeReport();
        return report && report.results.interactive.kag.stateSaved;
      }, null, { timeout: 15000 });
    } catch (error) {
      throw new Error("D3 KAG branch/save timeout: " + JSON.stringify(await readPage(page)) + "\n" + consoleLines.join("\n") + "\n" + error.message);
    }
    await page.waitForTimeout(1500);
    const afterInput = await readPage(page);
    const afterImage = await canvas.screenshot();
    const interactive = afterInput.report.results.interactive;
    const selectedKag = interactive.kag;
    if (afterInput.report.results.status !== "pass" || !interactive.inputReady || !interactive.audioOpened || !interactive.audioPlayed || !interactive.saveWritten || interactive.audioError || !selectedKag.choiceReady || selectedKag.branch !== "left" || !selectedKag.stateSaved || selectedKag.textPhases.indexOf("condition") === -1 || selectedKag.textPhases.indexOf("branch") === -1) {
      throw new Error("D3 KAG branch/audio/save phase failed: " + JSON.stringify(afterInput) + "\n" + consoleLines.join("\n"));
    }
    if (Buffer.compare(choiceImage, afterImage) === 0) {
      throw new Error("D3 scene did not change after the KAG branch choice");
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }),
      page.click("#reload-button")
    ]);
    if (!(new URL(page.url())).searchParams.get("restart")) {
      throw new Error("D3 restart did not navigate to a unique URL: " + page.url());
    }
    await waitForBoot(page);
    try {
      // The restored KAG text phase is emitted a few engine ticks after the
      // save-restore tag; wait for it explicitly so sampling cannot land
      // between the two events (frame gate widens that window).
      await page.waitForFunction(function () {
        var report = window.d3ProbeReport && window.d3ProbeReport();
        return report && report.results.interactive.saveRestored
          && report.results.interactive.kag.textPhases.indexOf("restored") !== -1;
      }, null, { timeout: 15000 });
    } catch (error) {
      throw new Error("D3 save restore timeout: " + JSON.stringify(await readPage(page)) + "\n" + consoleLines.join("\n") + "\n" + error.message);
    }
    const afterReload = await readPage(page);
    assertStorageAndCanvas(afterReload);
    var restored = afterReload.report.results.interactive;
    var requiredPhases = ["intro", "condition", "branch", "restored"];
    var hasAllPhases = requiredPhases.every(function (phase) {
      return restored.kag.textPhases.indexOf(phase) !== -1;
    });
    if (afterReload.report.results.status !== "pass" || !restored.saveRestored || !restored.saveSynced || !restored.restartRequested || !restored.inputReady || !restored.audioPlayed || !restored.saveWritten || !restored.kag.restored || restored.kag.branch !== "left" || !hasAllPhases) {
      throw new Error("D3 KAG parser state was not restored after reload: " + JSON.stringify(afterReload) + "\n" + consoleLines.join("\n"));
    }

    await page.screenshot({ path: output, fullPage: true });
    await page.click("#upload-button");
    await page.waitForFunction(function () { return document.getElementById("upload-button").textContent === "报告已上传"; }, null, { timeout: 10000 });
    const uploadResult = await page.evaluate(function () {
      return { button: document.getElementById("upload-button").textContent, detail: document.getElementById("detail").textContent };
    });
    process.stdout.write(JSON.stringify({ before, afterChoice, afterInput, afterReload, sampledPixels, uploadResult, consoleLines }, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
