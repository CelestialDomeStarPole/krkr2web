"use strict";

const { chromium } = require("playwright");

const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const VK_PADLEFT = 0x1b5;
const VK_PADRIGHT = 0x1b7;
const VK_PAD1 = 0x1c0;
const VK_PAD2 = 0x1c1;

async function waitForReady(page) {
  await page.waitForFunction(function () {
    var report = window.d3ProbeReport && window.d3ProbeReport();
    return report && report.results.interactive.kag.textPhases.indexOf("intro") !== -1;
  }, null, { timeout: 60000 });
}

async function waitForChoice(page) {
  try {
    await page.waitForFunction(function () {
      var report = window.d3ProbeReport && window.d3ProbeReport();
      return report && report.results.interactive.kag.choiceReady;
    }, null, { timeout: 15000 });
  } catch (error) {
    throw new Error("choice timeout: " + JSON.stringify(await page.evaluate(function () { return window.d3ProbeReport(); })) + "\n" + error.message);
  }
}

async function waitForRightBranch(page) {
  await page.waitForFunction(function () {
    var report = window.d3ProbeReport && window.d3ProbeReport();
    return report && report.results.interactive.kag.branch === "right" && report.results.interactive.kag.stateSaved;
  }, null, { timeout: 15000 });
}

function includesEvery(values, expected) {
  return expected.every(function (value) { return values.indexOf(value) !== -1; });
}

function assertInput(result, kind, expectedKeys, expectedActions) {
  var interactive = result.results.interactive;
  var input = interactive.enhancedInput[kind];
  if (result.reportVersion !== 5 || interactive.kag.branch !== "right" || !interactive.kag.stateSaved || !result.results.stability) {
    throw new Error(kind + " did not select and save the right branch: " + JSON.stringify(result));
  }
  if (!includesEvery(input.downKeys, expectedKeys) || !includesEvery(input.upKeys, expectedKeys)) {
    throw new Error(kind + " did not deliver matching KRKR key down/up events: " + JSON.stringify(input));
  }
  if (!includesEvery(input.actions, expectedActions)) {
    throw new Error(kind + " did not deliver all input actions: " + JSON.stringify(input));
  }
  if (interactive.inputKinds.indexOf(kind) === -1) {
    throw new Error(kind + " was not recorded as an engine input kind: " + JSON.stringify(interactive.inputKinds));
  }
}

async function uploadReport(page) {
  return await page.evaluate(async function () {
    var response = await fetch("/api/diagnostics-reports", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(window.d3ProbeReport())
    });
    var result = await response.json();
    if (!response.ok) { throw new Error(result.error || "HTTP " + response.status); }
    return result.reportId;
  });
}

async function openProbe(browser, url, virtualGamepad) {
  var context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (virtualGamepad) {
    await context.addInitScript(function () {
      var buttons = [];
      for (var index = 0; index < 17; index += 1) {
        buttons.push({ pressed: false, touched: false, value: 0 });
      }
      var gamepad = {
        id: "KRKR2 Web Standard Test Gamepad",
        index: 0,
        connected: true,
        mapping: "standard",
        timestamp: 1,
        axes: [0, 0, 0, 0],
        buttons: buttons
      };
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: function () { return [gamepad]; }
      });
      window.__setTestGamepadButton = function (button, pressed) {
        gamepad.buttons[button].pressed = pressed;
        gamepad.buttons[button].touched = pressed;
        gamepad.buttons[button].value = pressed ? 1 : 0;
        gamepad.timestamp += 1;
      };
    });
  }
  var page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.click("#start-button");
  await waitForReady(page);
  await page.locator("#canvas").focus();
  await page.waitForTimeout(350);
  return { context, page };
}

async function pressGamepad(page, button) {
  await page.evaluate(function (index) { window.__setTestGamepadButton(index, true); }, button);
  await page.waitForTimeout(180);
  await page.evaluate(function (index) { window.__setTestGamepadButton(index, false); }, button);
  await page.waitForTimeout(320);
}

async function runKeyboard(browser, url) {
  var probe = await openProbe(browser, url, false);
  try {
    await probe.page.keyboard.press("Enter");
    await waitForChoice(probe.page);
    await probe.page.waitForTimeout(300);
    await probe.page.keyboard.press("Escape");
    await probe.page.waitForTimeout(300);
    await probe.page.keyboard.press("ArrowLeft");
    await probe.page.waitForTimeout(300);
    await probe.page.keyboard.press("ArrowRight");
    await probe.page.waitForTimeout(300);
    await probe.page.keyboard.press("Enter");
    await waitForRightBranch(probe.page);
    var result = await probe.page.evaluate(function () { return window.d3ProbeReport(); });
    assertInput(result, "keyboard", [VK_RETURN, VK_ESCAPE, VK_LEFT, VK_RIGHT], ["advance", "cancel", "move-left", "move-right", "confirm"]);
    result.reportId = await uploadReport(probe.page);
    return result;
  } finally {
    await probe.context.close();
  }
}

async function runGamepad(browser, url) {
  var probe = await openProbe(browser, url, true);
  try {
    await pressGamepad(probe.page, 0);
    await waitForChoice(probe.page);
    await pressGamepad(probe.page, 1);
    await pressGamepad(probe.page, 14);
    await pressGamepad(probe.page, 15);
    await pressGamepad(probe.page, 0);
    await waitForRightBranch(probe.page);
    var result = await probe.page.evaluate(function () { return window.d3ProbeReport(); });
    assertInput(result, "gamepad", [VK_PAD1, VK_PAD2, VK_PADLEFT, VK_PADRIGHT], ["advance", "cancel", "move-left", "move-right", "confirm"]);
    if (!result.results.interactive.enhancedInput.gamepadApiAvailable || result.results.interactive.enhancedInput.connectedGamepads !== 1) {
      throw new Error("standard Gamepad API was not visible in the report: " + JSON.stringify(result.results.interactive.enhancedInput));
    }
    result.reportId = await uploadReport(probe.page);
    return result;
  } finally {
    await probe.context.close();
  }
}

async function main() {
  var url = process.argv[2] || "http://127.0.0.1:8765/?gameId=d3-test";
  var executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  var browser = await chromium.launch({ headless: true, executablePath: executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    var keyboard = await runKeyboard(browser, url);
    var gamepad = await runGamepad(browser, url);
    process.stdout.write(JSON.stringify({
      keyboard: keyboard.results.interactive.enhancedInput.keyboard,
      keyboardBranch: keyboard.results.interactive.kag.branch,
      keyboardReportId: keyboard.reportId,
      gamepad: gamepad.results.interactive.enhancedInput.gamepad,
      gamepadBranch: gamepad.results.interactive.kag.branch,
      connectedGamepads: gamepad.results.interactive.enhancedInput.connectedGamepads,
      gamepadReportId: gamepad.reportId
    }, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
