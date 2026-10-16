// Dev-app smoke for the Device Sync integration, with sync OFF (plan P4).
// Run: node tools/_smoke_device_sync_dev.js [--app <UI-source dir>] [--baseline] [--python <exe>]
//   Linux without a display: prefix with `xvfb-run -a`. Needs UI-source/dist (npm run build).
//   PLAYWRIGHT_PATH overrides where `playwright` is required from (on the
//   Windows PC it lives only in the npx cache: %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\playwright).
//
// Launches the real dev app (electron + UI-source, renderer from dist/) with
// an isolated userData and library (AIO_OUTPUT_DIR), then:
//   1. after one UI Save on the fresh profile, settings load with 0 changed
//      ("Up to date") and Save round-trips;
//   2. a series merge works, dry run then real;
//   3. a second launch focuses the first window and exits (skipped with
//      --baseline: the pre-P4 tree has no single-instance lock);
//   4. the close-with-download dialog is unchanged, and quit time is
//      measured from "Quit anyway" to process exit (compare against
//      --baseline on the previous tree);
//   5. no userData/sync/ folder appears, and main logs no [deviceSync] line
//      (checked before step 6, which turns sync on);
//   6. turning sync on in Settings → Sync shows the Sync rail tab just above
//      Settings, creates userData/sync/ and opens the placeholder Sync tab;
//      turning it off hides the tab again (UI pass U1; skipped with
//      --baseline).
// Steps run 1, 2, 3, 5, 6, 4: the quit in step 4 ends the app.
// userData isolation is Chromium's --user-data-dir switch: Electron honors it
// for app.getPath("userData") from the first line of main, and the
// single-instance lock is keyed on it (measured on Windows, Electron 40).
// XDG_CONFIG_HOME is set as well for Linux. The real
// %APPDATA%\aio-downloader-ui is never opened.
// The "download" never reaches aio-dl: the app spawns
// `<pythonCmd> -u <scriptPath> ...` and the smoke points scriptPath at a
// sleep script. pythonCmd is an sh script that execs sleep on Linux/macOS, and
// real python (--python, default "python") on Windows, which has no sh;
// node.exe can't stand in there because it rejects `-u`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const BASELINE = argv.includes("--baseline");
const REPO = path.resolve(__dirname, "..");
const APP = path.resolve(opt("--app") || path.join(REPO, "UI-source"));
const WIN = process.platform === "win32";
const ELECTRON = path.join(APP, "node_modules", "electron", "dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : WIN ? "electron.exe" : "electron");
const { _electron } = require(process.env.PLAYWRIGHT_PATH || "playwright");

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-smoke-"));
  const CFG = path.join(TMP, "config");
  const LIB = path.join(TMP, "library");
  fs.mkdirSync(CFG, { recursive: true });
  fs.mkdirSync(LIB, { recursive: true });
  const sleepScript = path.join(TMP, "sleep.py");
  fs.writeFileSync(sleepScript, "import time\ntime.sleep(120)\n");
  let fakePy = opt("--python") || "python";
  if (!WIN) {
    fakePy = path.join(TMP, "fakepy.sh");
    fs.writeFileSync(fakePy, "#!/bin/sh\nexec sleep 120\n");
    fs.chmodSync(fakePy, 0o755);
  }
  const A = path.join(LIB, "Alpha");
  const B = path.join(LIB, "Alpha (2)");
  for (const [dir, ch] of [[A, "1"], [B, "2"]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".aio_series.json"), JSON.stringify({ title: "Alpha", anilist_id: 77, chapters_downloaded: [ch] }));
    fs.writeFileSync(path.join(dir, `Ch.00${ch}.cbz`), ch);
  }

  const env = { ...process.env, XDG_CONFIG_HOME: CFG, AIO_OUTPUT_DIR: LIB };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_ENV;
  const args = ["--no-sandbox", `--user-data-dir=${CFG}`, APP];
  console.log(`app: ${APP}${BASELINE ? " (baseline)" : ""}`);

  const app = await _electron.launch({ executablePath: ELECTRON, args, env, timeout: 60_000 });
  let stderr = "";
  app.process().stderr.on("data", (d) => (stderr += d));
  app.process().stdout.on("data", (d) => (stderr += d));
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.electronAPI && document.querySelector("#root") && document.querySelector("#root").children.length > 0, null, { timeout: 30_000 });
  const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  check("isolated userData", userData.startsWith(CFG), userData);

  // 1. settings. A fresh settings.json counts backfilled defaults as changed
  // until the first Save (SettingsTab.jsx countDirtySettings), so: Save once
  // through the UI, reload (re-hydrates from disk), and expect 0 changed.
  const saveLabel = () => win.locator("button", { hasText: /Up to date|changed|Save Settings|Saved/ }).first();
  const openSettings = async () => {
    await win.getByRole("button", { name: "Settings" }).first().click();
    await saveLabel().waitFor({ timeout: 15_000 });
  };
  await openSettings();
  const fresh = (await saveLabel().textContent()).trim();
  console.log(`  ..  fresh profile: "${fresh}"`);
  if (/changed/.test(fresh)) {
    await saveLabel().click();
    await win.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /Up to date/.test(b.textContent)), null, { timeout: 15_000 });
  }
  await win.reload();
  await win.waitForFunction(() => !!window.electronAPI && document.querySelector("#root") && document.querySelector("#root").children.length > 0, null, { timeout: 30_000 });
  await openSettings();
  const label = (await saveLabel().textContent()).trim();
  check("settings load with 0 changed", /Up to date/.test(label), label);
  const before = await win.evaluate(() => window.electronAPI.getSettings());
  const saved = await win.evaluate((s) => window.electronAPI.saveSettings(s), before);
  const after = await win.evaluate(() => window.electronAPI.getSettings());
  check("save answers ok", saved && saved.ok === true, JSON.stringify(saved));
  check("Save round-trips", JSON.stringify(after) === JSON.stringify(before));
  await win.reload();
  await win.waitForFunction(() => !!window.electronAPI && document.querySelector("#root") && document.querySelector("#root").children.length > 0, null, { timeout: 30_000 });
  await openSettings();
  const label2 = (await saveLabel().textContent()).trim();
  check("still 0 changed after the round-trip", /Up to date/.test(label2), label2);

  // 2. merge
  const dry = await win.evaluate((o) => window.electronAPI.mergeSeriesFolders(o), { targetFolder: A, sourceFolders: [B], dryRun: true });
  check("dry merge", dry.ok === true && dry.dryRun === true, JSON.stringify(dry).slice(0, 200));
  check("dry merge moved nothing", fs.existsSync(B));
  const real = await win.evaluate((o) => window.electronAPI.mergeSeriesFolders(o), { targetFolder: A, sourceFolders: [B], dryRun: false });
  check("real merge", real.ok === true && real.dryRun === false, JSON.stringify(real).slice(0, 200));
  check("real merge moved the chapter", fs.existsSync(path.join(A, "Ch.002.cbz")) && !fs.existsSync(B));

  // 3. second launch
  if (!BASELINE) {
    await app.evaluate(({ app: a, BrowserWindow }) => {
      global.__secondInstance = 0;
      a.on("second-instance", () => (global.__secondInstance += 1));
      BrowserWindow.getAllWindows()[0].minimize();
    });
    await sleep(500);
    const minimized = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
    const t0 = Date.now();
    const second = spawn(ELECTRON, args, { env, stdio: "ignore" });
    const code = await new Promise((r) => {
      const t = setTimeout(() => {
        second.kill("SIGKILL");
        r("timeout");
      }, 20_000);
      second.on("exit", (c) => {
        clearTimeout(t);
        r(c);
      });
    });
    check("second launch exits", code === 0, `exit ${code} after ${Date.now() - t0} ms`);
    await sleep(500);
    const st = await app.evaluate(({ BrowserWindow }) => ({
      n: BrowserWindow.getAllWindows().length,
      si: global.__secondInstance,
      min: BrowserWindow.getAllWindows()[0].isMinimized(),
      vis: BrowserWindow.getAllWindows()[0].isVisible(),
    }));
    check("first instance got second-instance", st.si === 1, JSON.stringify(st));
    check("still one window, visible", st.n === 1 && st.vis, JSON.stringify(st));
    if (minimized) check("the minimized window was restored", !st.min, JSON.stringify(st));
    else console.log("  --  minimize not observable under this window manager; restore not checked");
  }

  // 5. inert while off (before step 6 turns sync on)
  check("no userData/sync/", !fs.existsSync(path.join(userData, "sync")));
  check("no [deviceSync] line in main's output", !/\[deviceSync\]/.test(stderr), stderr.split("\n").filter((l) => /deviceSync/.test(l)).join(" | "));

  // 6. sync on, then off, through the UI. The rail is App.jsx's w-16 <nav>;
  // SettingsTab's category list is the other <nav>.
  if (!BASELINE) {
    const railSync = win.locator('nav.w-16 button[title="Sync"]');
    const railTitles = () => win.locator("nav.w-16 button[title]").evaluateAll((bs) => bs.map((b) => b.title));
    const toggleSync = async () => {
      await openSettings();
      await win.locator("nav:not(.w-16) button", { hasText: /^Sync/ }).first().click();
      await win.getByRole("switch").first().click();
      await saveLabel().click();
    };
    check("no Sync rail tab while off", (await railSync.count()) === 0);
    await toggleSync();
    await railSync.waitFor({ timeout: 20_000 }).catch(() => {});
    const titles = await railTitles();
    const at = titles.indexOf("Sync");
    check("Sync rail tab appears just above Settings", at >= 0 && at === titles.indexOf("Settings") - 1, JSON.stringify(titles));
    check("userData/sync/ exists once on", fs.existsSync(path.join(userData, "sync")));
    await win.locator("text=No targets yet").first().waitFor({ timeout: 10_000 }).catch(() => {});
    check("Settings → Sync shows the Targets section", (await win.locator("text=No targets yet").count()) > 0);
    await railSync.click();
    check("Sync tab opens", (await win.locator("text=The Sync tab isn't built yet").count()) > 0);
    await toggleSync();
    await win.waitForFunction(() => !document.querySelector('nav.w-16 button[title="Sync"]'), null, { timeout: 20_000 }).catch(() => {});
    check("Sync rail tab gone once off", (await railSync.count()) === 0);
  }

  // 4. close with a running download
  // workingDir too: the app creates it on download start, and its default can
  // sit outside the temp dir (Documents\AIO Downloader when packaged).
  await win.evaluate((p) => window.electronAPI.saveSettings({ ...p.s, pythonCmd: p.py, scriptPath: p.script, workingDir: p.wd }), { s: after, py: fakePy, script: sleepScript, wd: TMP });
  const started = await win.evaluate(() => window.electronAPI.startDownload({ url: "https://example.test/series/alpha", args: [] }));
  check("fake download started", !!started, JSON.stringify(started));
  await sleep(1000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const title = win.locator("#confirm-quit-title");
  await title.waitFor({ timeout: 10_000 });
  check("close-with-download dialog shown", /A download is still running/.test(await title.textContent()));
  const closed = new Promise((r) => app.process().on("exit", (c, s) => r({ c, s })));
  const tq = Date.now();
  // The app quits while the click settles, so a closed target is the expected outcome.
  await win.getByRole("button", { name: "Quit anyway" }).click({ noWaitAfter: true }).catch((e) => {
    if (!/closed/.test(String(e && e.message))) throw e;
  });
  const ex = await Promise.race([closed, sleep(20_000).then(() => "timeout")]);
  const quitMs = Date.now() - tq;
  check("app exits after Quit anyway", ex !== "timeout", JSON.stringify(ex));
  console.log(`  ..  quit time: ${quitMs} ms`);

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  console.log(failures ? `\n${failures} failure(s)` : "\nsmoke passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log(`FAIL  smoke: ${e && e.stack}`);
  process.exit(1);
});
