"use strict";

const path = require("path");
const { chromium } = require("playwright-core");

function assertLayout(layout) {
  if (layout.scrollWidth > layout.width + 1 || layout.scrollHeight > layout.height + 1) {
    throw new Error("D4 library overflows the viewport: " + JSON.stringify(layout));
  }
  ["topbar", "list", "detail"].forEach(function (name) {
    var box = layout[name];
    if (!box || box.width <= 0 || box.height <= 0 || box.right > layout.width + 1 || box.bottom > layout.height + 1) {
      throw new Error("D4 layout region is invalid: " + name + " " + JSON.stringify(layout));
    }
  });
  if (layout.list.right > layout.detail.left + 1) {
    throw new Error("D4 library list overlaps the detail panel: " + JSON.stringify(layout));
  }
}

async function libraryState(page) {
  return page.evaluate(function () {
    function box(selector) {
      var rect = document.querySelector(selector).getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }
    return {
      app: window.d4AppState(),
      catalogStatus: document.getElementById("catalog-status").textContent,
      gameCards: document.querySelectorAll(".game-card").length,
      detailTitle: document.querySelector(".detail-header h2").textContent,
      layout: {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        topbar: box(".topbar"),
        list: box(".library-list"),
        detail: box(".game-detail")
      }
    };
  });
}

async function playerState(page) {
  return page.evaluate(function () {
    var state = window.d4PlayerState();
    var canvas = document.getElementById("canvas");
    var rect = canvas.getBoundingClientRect();
    return {
      state: state,
      playerState: document.getElementById("player-view").dataset.state,
      playerVisible: !document.getElementById("player-view").hidden,
      title: document.getElementById("game-title").textContent,
      canvas: { width: canvas.width, height: canvas.height, clientWidth: rect.width, clientHeight: rect.height },
      viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }
    };
  });
}

async function main() {
  const baseUrl = process.argv[2] || "http://127.0.0.1:8768";
  const output = process.argv[3] || path.resolve("build/d4-browser-smoke.png");
  const executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const consoleLines = [];
  const requests = [];
  const dialogs = [];
  page.on("console", function (message) { consoleLines.push(message.type() + ": " + message.text()); });
  page.on("pageerror", function (error) { consoleLines.push("pageerror: " + error.stack); });
  page.on("request", function (request) { requests.push({ url: request.url(), at: Date.now() }); });
  page.on("dialog", async function (dialog) { dialogs.push(dialog.message()); await dialog.accept(); });
  try {
    // The save/crash stages below drive the engine through window.Module,
    // which only exists in the main-thread baseline variant; the dedicated
    // worker variant (default when supported) has its offline zero-request
    // launch covered by dedicated checks instead.
    var response = await page.goto(baseUrl + "/library/deep/page.html?source=smoke&engineVariant=baseline", { waitUntil: "networkidle", timeout: 30000 });
    if (!response || response.status() !== 200 || new URL(page.url()).pathname !== "/") {
      throw new Error("D4 deep route did not reach the library: " + page.url());
    }
    await page.waitForFunction(function () { return window.d4AppState && window.d4AppState().catalog; }, null, { timeout: 30000 });
    var before = await libraryState(page);
    assertLayout(before.layout);
    if (before.gameCards !== 1 || before.detailTitle !== "D3 self-test") {
      throw new Error("D4 library did not render the server catalog: " + JSON.stringify(before));
    }

    var install = before.app.installs["d3-test"];
    if (!install || install.status !== "ready" || !install.complete) {
      await page.getByRole("button", { name: /完整下载|继续下载/ }).click();
      await page.waitForFunction(function () {
        var state = window.d4AppState();
        var current = state.installs["d3-test"];
        return current && current.status === "ready" && current.complete === true;
      }, null, { timeout: 60000 });
    }

    await page.waitForFunction(function () {
      return window.d4AppState && window.d4AppState().samePageOffline.assets.status === "ready";
    }, null, { timeout: 30000 });
    var installed = await libraryState(page);
    assertLayout(installed.layout);

    var stableUrl = page.url();
    await context.setOffline(true);
    var networkUnavailable = await page.evaluate(function () {
      return fetch("/offline-network-probe-" + Date.now(), { cache: "no-store" }).then(function () {
        return false;
      }, function () { return true; });
    });
    if (!networkUnavailable) {
      throw new Error("D4 offline test did not actually disable network access");
    }
    var launchStartedAt = Date.now();
    await page.getByRole("button", { name: "启动游戏" }).click();
    await page.waitForFunction(function () {
      return window.d4PlayerState && window.d4PlayerState().ready;
    }, null, { timeout: 60000 });
    var offlinePlayer = await playerState(page);
    // blob: loads are in-memory (worker/scripts materialized from preloaded
    // text for offline launches); only server requests count against the
    // offline zero-request contract.
    var launchRequests = requests.filter(function (entry) { return entry.at >= launchStartedAt && entry.url.indexOf("offline-network-probe-") === -1 && entry.url.indexOf("blob:") !== 0; });
    if (page.url() !== stableUrl || offlinePlayer.state.href !== stableUrl || !offlinePlayer.playerVisible ||
        offlinePlayer.state.storage.metrics.readCalls === 0 || offlinePlayer.state.storage.metrics.errors.length !== 0 ||
        offlinePlayer.playerState !== "ready" || launchRequests.length !== 0) {
      throw new Error("D4 player did not start offline in the current document: " + JSON.stringify({ stableUrl, currentUrl: page.url(), offlinePlayer, launchRequests }));
    }

    await page.evaluate(function () {
      window.Module.FS.writeFile("/savedata/d3-test/shell-save-test.sav", new Uint8Array([75, 82, 75, 82, 50]));
      return window.krkr2Player.syncSaves();
    });

    await page.getByRole("button", { name: "返回游戏库" }).click();
    var offlineLibrary = await libraryState(page);
    assertLayout(offlineLibrary.layout);
    if (page.url() !== stableUrl || !offlineLibrary.app.installs["d3-test"].complete || offlineLibrary.app.samePageOffline.visible) {
      throw new Error("D4 current-document return did not preserve the library: " + JSON.stringify(offlineLibrary));
    }

    await page.getByRole("button", { name: "存档", exact: true }).click();
    await page.waitForFunction(function () {
      return window.krkr2SaveManager.snapshot().entries.length > 0;
    }, null, { timeout: 10000 });
    var saveManager = await page.evaluate(function () {
      return {
        state: window.krkr2SaveManager.snapshot(),
        rows: document.querySelectorAll(".save-row").length,
        visible: !document.getElementById("saves-view").hidden
      };
    });
    if (!saveManager.visible || saveManager.rows < 1 || saveManager.state.entries[0].bytes <= 0) {
      throw new Error("D4 save manager did not expose the IDBFS save: " + JSON.stringify(saveManager));
    }

    await page.getByRole("button", { name: "游戏库", exact: true }).click();
    var restartStartedAt = Date.now();
    var firstGeneration = offlinePlayer.state.generation;
    await page.getByRole("button", { name: "强制重启", exact: true }).click();
    await page.waitForFunction(function (generation) {
      var state = window.d4PlayerState();
      return state.ready && state.visible && state.generation > generation;
    }, firstGeneration, { timeout: 60000 });
    var restartedPlayer = await playerState(page);
    var restartRequests = requests.filter(function (entry) { return entry.at >= restartStartedAt; });
    if (page.url() !== stableUrl || restartedPlayer.state.crashed || restartedPlayer.state.generation <= firstGeneration || restartRequests.length !== 0) {
      throw new Error("D4 same-document forced restart failed: " + JSON.stringify({ restartedPlayer, restartRequests }));
    }

    var crashRestartStartedAt = Date.now();
    var restartedGeneration = restartedPlayer.state.generation;
    await page.evaluate(function () { window.alert("fatal error: browser smoke"); });
    await page.waitForFunction(function () { return window.d4PlayerState().crashed; });
    await page.getByRole("button", { name: "返回游戏库" }).click();
    await page.getByRole("button", { name: "重新启动游戏", exact: true }).click();
    await page.waitForFunction(function (generation) {
      var state = window.d4PlayerState();
      return state.ready && state.visible && !state.crashed && state.generation > generation;
    }, restartedGeneration, { timeout: 60000 });
    var crashRestartedPlayer = await playerState(page);
    var crashRestartRequests = requests.filter(function (entry) { return entry.at >= crashRestartStartedAt; });
    if (page.url() !== stableUrl || crashRestartRequests.length !== 0) {
      throw new Error("D4 fatal-alert recovery failed: " + JSON.stringify({ crashRestartedPlayer, crashRestartRequests }));
    }

    var forceStopStartedAt = Date.now();
    await page.getByRole("button", { name: "强制终止游戏", exact: true }).click();
    await page.waitForFunction(function () {
      var state = window.d4PlayerState();
      return !state.running && !state.visible && state.forcedStopCount > 0;
    }, null, { timeout: 10000 });
    var forceStoppedPlayer = await playerState(page);
    var forceStopRequests = requests.filter(function (entry) { return entry.at >= forceStopStartedAt; });
    if (page.url() !== stableUrl || forceStopRequests.length !== 0) {
      throw new Error("D4 immediate force stop failed: " + JSON.stringify({ forceStoppedPlayer, forceStopRequests }));
    }

    await page.getByRole("button", { name: "存档", exact: true }).click();
    await page.waitForFunction(function () { return window.krkr2SaveManager.snapshot().entries.length > 0; });
    await page.screenshot({ path: output, fullPage: true });
    await page.locator(".save-row input[type=checkbox]").check();
    await page.getByRole("button", { name: "删除选中", exact: true }).click();
    await page.getByRole("button", { name: "再次点击确认删除", exact: true }).click();
    await page.waitForFunction(function () {
      var state = window.krkr2SaveManager.snapshot();
      return !state.busy && state.entries.length === 0;
    }, null, { timeout: 20000 });
    var afterDelete = await page.evaluate(function () { return window.krkr2SaveManager.snapshot(); });
    process.stdout.write(JSON.stringify({ before, installed, stableUrl, offlinePlayer, launchRequests, offlineLibrary, saveManager, restartedPlayer, restartRequests, crashRestartedPlayer, crashRestartRequests, forceStoppedPlayer, forceStopRequests, dialogs, afterDelete, consoleLines }, null, 2) + "\n");
  } finally {
    await context.setOffline(false).catch(function () {});
    await browser.close();
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
