// Screenshot of the Search tab's "Chapter coverage" panel (SearchChapterMap.jsx)
// on the real dev app, expanded, for a saved --search-json payload. Used for
// before/after shots when the panel's code moves (coverage plan C2,
// sync-temp/plans/find-sources-coverage.md).
// Run: node tools/_shot_search_coverage.js --out <png> [--payload <json>] [--theme dark|light]
//   Needs UI-source/dist (`npm run build`), Playwright via PLAYWRIGHT_PATH and
//   a `python` on PATH (PYTHON=<exe> overrides) for the fake backend: a script
//   that prints the payload for any `--search`. Isolated userData (temp dir);
//   nothing touches the network or the real settings.
//   Default payload: tools/fixtures/search-torture-princess-multisource.json
//   (a live multi-source search saved in C1). Also writes <out>.html, the
//   panel's outerHTML, so two runs can be diffed as text.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const REPO = path.resolve(__dirname, "..");
const APP = path.join(REPO, "UI-source");
const OUT = path.resolve(opt("--out", path.join(REPO, "tools", "_shot_search_coverage.png")));
const PAYLOAD = path.resolve(opt("--payload", path.join(REPO, "tools", "fixtures", "search-torture-princess-multisource.json")));
const THEME = opt("--theme", "dark");
const WIN = process.platform === "win32";
const ELECTRON = path.join(APP, "node_modules", "electron", "dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : WIN ? "electron.exe" : "electron");
const PYTHON = process.env.PYTHON || "python";
const { _electron } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const FAKE_PY = `import os, sys
if "--search" in sys.argv:
    with open(os.environ["AIO_SHOT_PAYLOAD"], encoding="utf-8") as f:
        sys.stdout.write(f.read())
sys.exit(0)
`;

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-shot-cov-"));
  const CFG = path.join(TMP, "config");
  const FAKE = path.join(TMP, "fake_aio.py");
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(FAKE, FAKE_PY);
  const query = JSON.parse(fs.readFileSync(PAYLOAD, "utf8")).query || "x";
  const env = { ...process.env, XDG_CONFIG_HOME: CFG, AIO_SHOT_PAYLOAD: PAYLOAD };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_ENV;
  const app = await _electron.launch({ executablePath: ELECTRON, args: ["--no-sandbox", `--user-data-dir=${CFG}`, APP], env, timeout: 60_000 });
  let code = 0;
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1280, height: 900 });
    await win.waitForFunction(() => !!window.electronAPI && document.querySelector("#root") && document.querySelector("#root").children.length > 0, null, { timeout: 30_000 });
    const s = await win.evaluate(() => window.electronAPI.getSettings());
    await win.evaluate((x) => window.electronAPI.saveSettings({ ...x.s, pythonCmd: x.py, scriptPath: x.fake, workingDir: x.wd, searchOpts: { ...(x.s.searchOpts || {}), multiSource: true } }), { s, py: PYTHON, fake: FAKE, wd: TMP });
    await win.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), THEME);
    await win.locator('nav.w-16 button[title="Search"]').click();
    await win.locator("#search-query").fill(query);
    await win.locator("#search-query").press("Enter");
    const head = win.getByRole("button", { name: /Chapter coverage across/ });
    await head.waitFor({ timeout: 30_000 });
    await head.click();
    const panel = head.locator("xpath=..");
    await panel.locator("table").waitFor({ timeout: 5_000 });
    await win.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), THEME);
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: OUT });
    fs.writeFileSync(`${OUT}.html`, await panel.evaluate((el) => el.outerHTML));
    console.log(`wrote ${OUT} (+ .html)`);
  } catch (e) {
    console.error(e);
    code = 1;
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  process.exit(code);
})();
