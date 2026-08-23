"use strict";

// Multi-game deployment audit: server-side auto-catalog discovers every
// game dropped under games/<gameId>/<version>/, physically placed packages
// install through auto-derived Range entries, and per-game browser saves
// stay isolated (each game mounts /savedata/<gameId>/ as its own IDBFS
// database; the save manager only ever lists the selected game's files).
//
// Requires a server started with --auto-catalog serving a site that contains
// at least "d3-test" and "iso-check" (see docs/05-game-adaptation.md):
//   python tools/https_diagnostics_server.py --http --bind 127.0.0.1 \
//     --port 8791 --directory build/d4-multigame-site \
//     --resource-map build/d4-multigame-site/resource-map.json --auto-catalog
//
// The baseline engine variant (?engineVariant=baseline) is used because the
// save-writing stages drive window.Module, which only exists main-thread.

const path = require("path");
const { chromium } = require("playwright-core");

const BASE = process.argv[2] || "http://127.0.0.1:8791/";
const OUTPUT = path.resolve("build/d4-multigame-audit.png");

function check(condition, message, extra) {
  if (!condition) {
    throw new Error(message + (extra === undefined ? "" : " :: " + JSON.stringify(extra)));
  }
}

async function libraryState(page) {
  return page.evaluate(function () {
    var state = window.d4AppState();
    return {
      catalogIds: state.catalog.games.map(function (game) { return game.gameId; }),
      catalogTitles: state.catalog.games.map(function (game) { return game.title; }),
      catalogStatus: document.getElementById("catalog-status").textContent,
      cards: document.querySelectorAll(".game-card").length,
      detailTitle: document.querySelector(".detail-header h2").textContent
    };
  });
}

async function savesSnapshot(page) {
  return page.evaluate(function () { return window.krkr2SaveManager.snapshot(); });
}

async function waitLibraryReady(page) {
  await page.waitForFunction(function () {
    return window.d4AppState && window.d4AppState().catalog;
  }, null, { timeout: 30000 });
}

async function waitInstallReady(page, gameId) {
  await page.waitForFunction(function (id) {
    var install = window.d4AppState().installs[id];
    return install && install.status === "ready" && install.complete === true;
  }, gameId, { timeout: 120000 });
}

async function launchAndWait(page, gameId) {
  await page.getByRole("button", { name: "启动游戏" }).click();
  await page.waitForFunction(function (id) {
    var state = window.d4PlayerState();
    return state.ready && state.gameId === id;
  }, gameId, { timeout: 90000 });
  return page.evaluate(function () { return { running: !!window.Module, variant: window.d4PlayerState().runtimeVariant }; });
}

async function writeSaveAndReturn(page, gameId, name) {
  await page.evaluate(function (payload) {
    window.Module.FS.writeFile("/savedata/" + payload.gameId + "/" + payload.name, new Uint8Array([75, 82, 75, 82, 50]));
    return window.krkr2Player.syncSaves();
  }, { gameId: gameId, name: name });
  await page.getByRole("button", { name: "返回游戏库" }).click();
}

async function selectGameCard(page, gameId) {
  // game cards live on the library tab, which the saves tab hides
  await page.getByRole("button", { name: "游戏库", exact: true }).click();
  await page.locator(".game-card[data-game-id=" + JSON.stringify(gameId) + "]").click();
}

async function openSavesAndWait(page, gameId) {
  await selectGameCard(page, gameId);
  await page.getByRole("button", { name: "存档", exact: true }).click();
  await page.waitForFunction(function () {
    var snapshot = window.krkr2SaveManager.snapshot();
    return !snapshot.busy;
  }, null, { timeout: 20000 });
  return savesSnapshot(page);
}

async function main() {
  const executablePath = process.env.KRKR2_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const launchArgs = ["--autoplay-policy=no-user-gesture-required"];
  if (BASE.indexOf("https://") === 0) { launchArgs.push("--ignore-certificate-errors"); }
  const browser = await chromium.launch({ headless: true, executablePath, args: launchArgs });
  const report = { base: BASE, phases: {} };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const consoleLines = [];
    page.on("console", function (message) { consoleLines.push(message.type() + ": " + message.text()); });
    page.on("pageerror", function (error) { consoleLines.push("pageerror: " + (error.stack || error.message)); });

    // ---- Phase 1: auto-discovery of every game folder ----
    await page.goto(BASE + "?engineVariant=baseline&source=multigame-audit", { waitUntil: "networkidle", timeout: 30000 });
    await waitLibraryReady(page);
    const library = await libraryState(page);
    check(library.catalogIds.indexOf("d3-test") !== -1 && library.catalogIds.indexOf("iso-check") !== -1,
      "auto-catalog did not discover both games", library);
    check(library.cards === library.catalogIds.length, "library cards do not match discovered games", library);
    const isoTitle = library.catalogTitles[library.catalogIds.indexOf("iso-check")];
    check(isoTitle === "ISO 隔离验证", "iso-check meta title not applied", library);
    report.phases.discovery = { status: "pass", games: library.catalogIds, cards: library.cards };

    // ---- Phase 2: install the physically placed game (auto-derived ranges) ----
    await selectGameCard(page, "iso-check");
    var installButton = page.getByRole("button", { name: /完整下载|继续下载/ });
    if (await installButton.count()) { await installButton.click(); }
    await waitInstallReady(page, "iso-check");
    report.phases.install = { status: "pass", gameId: "iso-check" };

    // ---- Phase 3: per-game saves stay isolated ----
    await launchAndWait(page, "iso-check");
    check((await page.evaluate(function () { return !!window.Module; })), "baseline engine variant expected for save stages");
    await writeSaveAndReturn(page, "iso-check", "multi-audit-a.sav");
    var isoSaves = await openSavesAndWait(page, "iso-check");
    check(isoSaves.entries.length === 1 && isoSaves.entries[0].name === "multi-audit-a.sav",
      "iso-check save manager did not list exactly its own save", isoSaves);

    await selectGameCard(page, "d3-test");
    if (await installButton.count()) { await installButton.click(); }
    await waitInstallReady(page, "d3-test");
    await launchAndWait(page, "d3-test");
    await writeSaveAndReturn(page, "d3-test", "multi-audit-b.sav");
    var d3Saves = await openSavesAndWait(page, "d3-test");
    check(d3Saves.entries.length === 1 && d3Saves.entries[0].name === "multi-audit-b.sav",
      "d3-test save manager did not list exactly its own save", d3Saves);

    var backToIso = await openSavesAndWait(page, "iso-check");
    check(backToIso.entries.length === 1 && backToIso.entries[0].name === "multi-audit-a.sav",
      "SAVE LEAK: iso-check list shows foreign entries", backToIso);

    var databases = await page.evaluate(function () {
      return indexedDB.databases().then(function (list) { return list.map(function (item) { return item.name; }); });
    });
    check(databases.indexOf("/savedata/iso-check") !== -1 && databases.indexOf("/savedata/d3-test") !== -1,
      "per-game IDBFS databases not distinct", databases);
    report.phases.isolation = {
      status: "pass",
      isoEntries: isoSaves.entries.map(function (entry) { return entry.name; }),
      d3Entries: d3Saves.entries.map(function (entry) { return entry.name; }),
      saveDatabases: databases.filter(function (name) { return name.indexOf("/savedata/") === 0; })
    };

    // ---- Phase 4: deleting one game's save never touches the other ----
    await selectGameCard(page, "iso-check");
    await page.getByRole("button", { name: "存档", exact: true }).click();
    await page.waitForFunction(function () {
      return window.krkr2SaveManager.snapshot().entries.length === 1;
    }, null, { timeout: 20000 });
    await page.locator(".save-row input[type=checkbox]").check();
    await page.getByRole("button", { name: "删除选中", exact: true }).click();
    await page.getByRole("button", { name: "再次点击确认删除", exact: true }).click();
    await page.waitForFunction(function () {
      var snapshot = window.krkr2SaveManager.snapshot();
      return !snapshot.busy && snapshot.entries.length === 0;
    }, null, { timeout: 20000 });
    var afterDelete = await openSavesAndWait(page, "d3-test");
    check(afterDelete.entries.length === 1 && afterDelete.entries[0].name === "multi-audit-b.sav",
      "deleting iso-check's save removed d3-test's save too", afterDelete);
    report.phases.deleteIsolation = { status: "pass", d3EntriesAfterIsoDelete: afterDelete.entries.length };

    await page.screenshot({ path: OUTPUT, fullPage: true });
    report.status = "pass";
    report.consoleTail = consoleLines.slice(-15);
  } finally {
    if (!report.status) { report.status = "fail"; }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    await browser.close().catch(function () {});
  }
  if (report.status !== "pass") { process.exitCode = 1; }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
