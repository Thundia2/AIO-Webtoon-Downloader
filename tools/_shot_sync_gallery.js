// ============================================================
// Screenshot the DEV Device Sync gallery (UI-source/src/dev/SyncGallery.jsx)
// and, optionally, the approved mockup, one PNG per case × width × theme.
//
// Needs the Vite dev server running (npm --prefix UI-source run dev, :5173)
// and Playwright (not a project dependency; on this PC it lives in the npx
// cache — pass it via PLAYWRIGHT_PATH, memory electron-app-local-e2e-testing).
//
//   node tools/_shot_sync_gallery.js --out <dir> [--cases a,b,…] [--prefix tab-]
//        [--mockup screen1,screen2,…] [--url http://localhost:5173]
//        [--browser <chromium exe>]   (default: the Playwright build's own;
//                                      pass one when that copy isn't installed)
//
// Gallery shots crop to the case frame (light frame first, dark second), so
// a 735 px shot is exactly what the app shows at the window minimum. Mockup
// shots click the mockup's own Theme/Width/Screen controls (data-k/data-v,
// data-screen) and capture the whole page. Read-only: writes only under --out.
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = path.resolve(opt("--out", "shots"));
const URL = opt("--url", "http://localhost:5173");
const MOCKUP = path.resolve(__dirname, "..", "sync-temp", "design", "approved", "device-sync-ui.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = opt("--browser", process.env.SHOT_BROWSER || null);
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 1300, height: 1500 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  let cases = opt("--cases", "");
  cases = cases ? cases.split(",") : null;
  if (!cases) {
    await page.goto(`${URL}/?gallery=sync`);
    await page.waitForSelector("li a");
    cases = await page.$$eval("li > a:first-child", (as) => as.map((a) => new URL(a.href).searchParams.get("case")));
    const prefix = opt("--prefix", "");
    if (prefix) cases = cases.filter((c) => c.startsWith(prefix));
  }
  for (const c of cases) {
    for (const w of ["735", "wide"]) {
      const n0 = errors.length;
      await page.goto(`${URL}/?gallery=sync&case=${c}${w === "wide" ? "&w=wide" : ""}`);
      await sleep(1600); // hydrate + fake replies + the overlay entrance
      const frames = await page.$$("div.relative.overflow-hidden.border");
      for (let i = 0; i < frames.length; i++) {
        await frames[i].screenshot({ path: path.join(OUT, `${c}-${w}-${i ? "dark" : "light"}.png`) });
      }
      if (errors.length > n0) console.log(`  ${c} ${w}: ${errors.slice(n0).join(" | ")}`);
    }
    console.log(`shot ${c}`);
  }

  const screens = opt("--mockup", "");
  if (screens) {
    await page.goto(`file:///${MOCKUP.replace(/\\/g, "/")}`);
    await sleep(500);
    for (const s of screens.split(",")) {
      for (const w of ["735", "wide"]) {
        await page.click(`[data-screen="${s}"]`);
        await page.click(`[data-k="width"][data-v="${w === "wide" ? "wide" : "narrow"}"]`).catch(() => {});
        await page.click(`[data-k="theme"][data-v="both"]`).catch(() => {});
        await sleep(400);
        await page.screenshot({ path: path.join(OUT, `mock-${s}-${w}.png`), fullPage: true });
      }
      console.log(`mock ${s}`);
    }
  }
  await browser.close();
  console.log(errors.length ? `${errors.length} page error(s)` : "no page errors");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
