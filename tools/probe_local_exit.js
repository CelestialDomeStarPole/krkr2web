"use strict";
// State-driven exit verification: reaches title by watching the scenario log,
// taps exit->yes, accumulates every engineLog line, reports outcome.
const { chromium } = require("playwright-core");
const ROUNDS = parseInt(process.env.ROUNDS || "4", 10);

(async () => {
  const context = await chromium.launchPersistentContext("E:\krkr2-audit-profile", {
    headless: false, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors"],
    viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true, serviceWorkers: "block",
    hasTouch: true
  });
  await context.addInitScript(() => {
    globalThis.__audioStarts = 0;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx.prototype.createBufferSource.__hooked) {
      const orig = Ctx.prototype.createBufferSource;
      orig.__hooked = true;
      Ctx.prototype.createBufferSource = function () {
        const s = orig.call(this);
        const st = s.start.bind(s);
        s.start = function () { globalThis.__audioStarts++; return st.apply(s, arguments); };
        return s;
      };
    }
  });
  const page = await context.newPage();
  await page.goto("https://127.0.0.1:8443/?engineVariant=baseline", { waitUntil: "domcontentloaded", timeout: 60000 });

  let prev = [];
  let all = [];
  const grab = async () => {
    const cur = await page.evaluate(() => (window.d4PlayerState().engineLog || []).map(x => String(x)));
    if (!cur.length) return;
    let startIdx = cur.length - prev.length; if (startIdx < 0) startIdx = 0;
    // exact continuation?
    let cont = true;
    for (let i = 0; i < prev.length; i++) { if (cur[startIdx + i] !== prev[i]) { cont = false; break; } }
    if (cont) {
      for (let i = prev.length - startIdx + startIdx; i < cur.length; i++) {}
      for (let i = cur.length - 1; i >= 0; i--) {
        if (prev.length && cur[i] === prev[prev.length - 1]) {
          for (let k = i + 1; k < cur.length; k++) all.push(cur[k]);
          prev = cur; return;
        }
      }
      for (const l of cur) all.push(l);
      prev = cur; return;
    }
    // fallback: append all unseen by simple set-of-tail heuristic
    const lastOld = prev[prev.length - 1];
    let from = 0;
    if (lastOld != null) {
      for (let i = cur.length - 1; i >= 0; i--) { if (cur[i] === lastOld) { from = i + 1; break; } }
    }
    for (let i = from; i < cur.length; i++) all.push(cur[i]);
    prev = cur;
  };
  const have = async (marker) => {
    await grab();
    return all.some(l => l.indexOf(marker) >= 0);
  };
  const gotoLibAndLaunch = async () => {
    await page.waitForFunction(() => window.d4AppState && window.d4AppState().catalog, null, { timeout: 30000 });
    await page.locator(".game-card[data-game-id=\"senren-banka\"]").click({ timeout: 20000 });
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "启动游戏" }).click({ timeout: 30000 });
    await page.waitForFunction(() => window.d4PlayerState && window.d4PlayerState().ready, null, { timeout: 180000 });
  };

  const results = [];
  for (let round = 1; round <= ROUNDS; round++) {
    console.log("== ROUND", round, "==");
    all = []; prev = [];
    try {
      await gotoLibAndLaunch();
      const rect = await page.evaluate(() => {
        const r = document.getElementById("canvas").getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const px = (gx, gy) => [rect.x + (80 + gx) * rect.w / 1440, rect.y + (180 + gy) * rect.h / 1080];

      // skip-any-overlay pump until title reached (max 120s)
      const a0 = await page.evaluate(() => globalThis.__audioStarts);
      let atTitle = false;
      const tTitle = Date.now();
      while (Date.now() - tTitle < 120000) {
        await page.waitForTimeout(3000);
        await grab();
        const hasWaitLabel = all.some(l => l.indexOf("KRKR2WEB_LABEL *wait") >= 0);
        const titleAssets = all.some(l => l.indexOf("title_cn.pimg") >= 0) && all.some(l => l.indexOf("KRKR2WEB_LABEL *title") >= 0);
        if (hasWaitLabel && titleAssets) { atTitle = true; break; }
        await page.touchscreen.tap(...px(640, 360)); // advance logos/notices
      }
      if (!atTitle) throw new Error("title not reached in 120s");
      const a1 = await page.evaluate(() => globalThis.__audioStarts);
      const bgmFlow = a1 - a0;
      console.log("title reached; bgmFlow(last segment incl.) =", bgmFlow);

      // measure steady BGM flow for 10s at idle title
      const b0 = await page.evaluate(() => globalThis.__audioStarts);
      await page.waitForTimeout(10000);
      const b1 = await page.evaluate(() => globalThis.__audioStarts);
      const bgmIdleFlow = b1 - b0;

      await page.touchscreen.tap(...px(155, 776)); // 退出游戏
      // wait adaptively until the confirm dialog asset is actually loaded
      const tDlg = Date.now();
      let dlgSeen = false;
      while (Date.now() - tDlg < 15000) {
        await page.waitForTimeout(400);
        await grab();
        const marker = "dialog_cn.pimg";
        const startAt = Math.max(0, all.length - 40);
        if (all.slice(startAt).some(l => l.indexOf(marker) >= 0)) { dlgSeen = true; break; }
      }
      console.log("dialog seen:", dlgSeen);
      await page.touchscreen.tap(...px(573, 379)); // 是

      let outcome = "timeout", quitAtMs = null;
      const tExit = Date.now();
      while (Date.now() - tExit < 45000) {
        await page.waitForTimeout(700);
        await grab();
        const st = await page.evaluate(() => {
          const s = window.d4PlayerState();
          return { quit: (s.errors || []).some(e => e.indexOf("KRKR2WEB_ENGINE_QUIT") >= 0), ready: s.ready };
        });
        if (st.quit) { outcome = "quit"; quitAtMs = Date.now() - tExit; break; }
        if (!st.ready) { outcome = "stopped"; break; }
      }

      const count = (m) => all.filter(l => l.indexOf(m) >= 0).length;
      const nonPerfTail = all.filter(l => l.indexOf("PERF") < 0).slice(-30);
      const rec = { round, bgmIdleFlow, outcome, quitAtMs,
        drainStall: count("DRAIN_STALL"), flipStop: count("BEAT_FLIP_STOP"),
        naturalEnd: count("NATURAL_END"), statusAsync: count("SB_STATUS_ASYNC"),
        endHookSeen: all.some(l => l.indexOf("*end_hook") >= 0),
        closeSeen: all.some(l => l.indexOf("[close") >= 0) };
      results.push(rec);
      console.log("RESULT", JSON.stringify(rec));
      if (outcome === "timeout") console.log("TAIL:", JSON.stringify(nonPerfTail, null, 1));

      // back to library for the next round
      const backBtn = page.getByRole("button", { name: "返回游戏库" });
      if (await backBtn.count().catch(() => 0)) { await backBtn.click({ timeout: 5000 }).catch(() => {}); }
      else { await page.goto("https://127.0.0.1:8443/?engineVariant=baseline", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{}); }
      await page.waitForTimeout(2500);
    } catch (e) {
      console.log("ROUND-FAIL", round, String(e).slice(0, 160));
      results.push({ round, error: String(e).slice(0, 200) });
      await page.goto("https://127.0.0.1:8443/?engineVariant=baseline", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
      await page.waitForTimeout(2500);
    }
  }
  const pass = results.filter(r => r.outcome === "quit").length;
  console.log("SUMMARY pass=" + pass + "/" + ROUNDS +
    " outcomes=" + JSON.stringify(results.map(r => r.outcome || r.error)) +
    " bgmIdle=" + JSON.stringify(results.map(r => r.bgmIdleFlow)));
  require("fs").writeFileSync("build/tmp-exitquant-results.json", JSON.stringify(results, null, 2));
  await context.close();
})().catch(e => { console.error("FAIL: " + (e.stack || e.message)); process.exit(1); });