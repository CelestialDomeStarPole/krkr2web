"use strict";

const path = require("path");
const { chromium } = require("playwright");

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
  page.on("console", function (message) { consoleLines.push(message.type() + ": " + message.text()); });
  page.on("pageerror", function (error) { consoleLines.push("pageerror: " + error.stack); });
  page.on("request", function (request) { requests.push({ url: request.url(), at: Date.now() }); });
  try {
    var response = await page.goto(baseUrl + "/library/deep/page.html?source=smoke", { waitUntil: "networkidle", timeout: 30000 });
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
    var launchRequests = requests.filter(function (entry) { return entry.at >= launchStartedAt && entry.url.indexOf("offline-network-probe-") === -1; });
    if (page.url() !== stableUrl || offlinePlayer.state.href !== stableUrl || !offlinePlayer.playerVisible ||
        offlinePlayer.state.storage.metrics.readCalls === 0 || offlinePlayer.state.storage.metrics.errors.length !== 0 ||
        offlinePlayer.playerState !== "ready" || launchRequests.length !== 0) {
      throw new Error("D4 player did not start offline in the current document: " + JSON.stringify({ stableUrl, currentUrl: page.url(), offlinePlayer, launchRequests }));
    }

    await page.getByRole("button", { name: "返回游戏库" }).click();
    var offlineLibrary = await libraryState(page);
    assertLayout(offlineLibrary.layout);
    if (page.url() !== stableUrl || !offlineLibrary.app.installs["d3-test"].complete || offlineLibrary.app.samePageOffline.visible) {
      throw new Error("D4 current-document return did not preserve the library: " + JSON.stringify(offlineLibrary));
    }
    await page.screenshot({ path: output, fullPage: true });
    process.stdout.write(JSON.stringify({ before, installed, stableUrl, offlinePlayer, launchRequests, offlineLibrary, consoleLines }, null, 2) + "\n");
  } finally {
    await context.setOffline(false).catch(function () {});
    await browser.close();
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
