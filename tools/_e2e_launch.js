// Shared Electron launcher for the tools/ E2E harnesses: launches the app with
// an isolated profile and PROVES which renderer it loaded.
//
// Used by: _e2e_device_sync_find.js, _e2e_device_sync_tab.js,
// _e2e_device_sync_prompt.js, _smoke_device_sync_dev.js,
// _smoke_device_sync_packaged.js, _shot_search_coverage.js (grep launchApp).
// Depends on: Playwright's _electron (PLAYWRIGHT_PATH, else `playwright`),
// UI-source/node_modules/{electron,vite}, and electron/main.js's rule that the
// dev server is loaded only when AIO_DEV_SERVER_URL names it (grep devServerUrl).
//
// Why this exists: until 2026-10-18 main.js loaded http://localhost:5173
// whenever the app was unpackaged, so with any Vite running on 5173 (often
// another checkout's) every harness tested that live source in dev React, not
// the dist it claimed. The find E2E's 1-in-3 flake came from that. Now each
// launch states its renderer and fails when the window shows anything else.
//
// Renderer modes (CLI: --renderer dist|dev, --no-build, --exe <path>):
//   dist (default)  runs `vite build` for --app first (once per process), so
//                   the run never tests a stale dist; --no-build skips it.
//   dev             starts THIS checkout's own Vite on a free port with its
//                   own optimizer cache (node_modules/.vite-e2e, never the
//                   dev server's), and points the app at it. Dev React keeps
//                   StrictMode's double effects: the only mode that exercises
//                   them deterministically.
//   --exe           a packaged build: expects resources/app.asar/dist and
//                   pre-marks the profile set up so the first-run Python
//                   wizard (setup.html) doesn't open.
// Window (CLI: --show, or env AIO_E2E_SHOW=1): unpackaged runs open their
// windows off-screen, unfocused and off the taskbar (tools/_e2e_offscreen.js,
// loaded into main with `electron -r`), so a run doesn't flash on the
// desktop or take focus. --show keeps the normal window, for watching a run.
// --exe always shows its window (see _e2e_offscreen.js for why).
// tools/ is gitignored; force-added on wip/device-sync-handoff.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { fileURLToPath, pathToFileURL } = require("url");

const WIN = process.platform === "win32";
const REPO = path.resolve(__dirname, "..");
const OFFSCREEN = path.join(__dirname, "_e2e_offscreen.js");

// Parse the shared flags. Harness-specific flags are left for the caller.
function cliOptions(argv, { app } = {}) {
  const opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : null;
  };
  const renderer = opt("--renderer") || "dist";
  if (renderer !== "dist" && renderer !== "dev") throw new Error(`--renderer must be dist or dev, got ${renderer}`);
  return {
    app: path.resolve(opt("--app") || app || path.join(REPO, "UI-source")),
    exe: opt("--exe") ? path.resolve(opt("--exe")) : null,
    renderer,
    build: !argv.includes("--no-build"),
    show: argv.includes("--show") || process.env.AIO_E2E_SHOW === "1",
  };
}

function electronBinary(app) {
  return path.join(app, "node_modules", "electron", "dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : WIN ? "electron.exe" : "electron");
}

const built = new Set();
function buildDist(app) {
  if (built.has(app)) return;
  const t0 = Date.now();
  // Vite's own CLI through node: no npm/shell resolution differences on Windows.
  execFileSync(process.execPath, [path.join(app, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "error"], { cwd: app, stdio: ["ignore", "ignore", "inherit"] });
  built.add(app);
  console.log(`  ..  built ${path.join(app, "dist")} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

const devServers = new Map(); // app → Promise<{server, url}>
function devServer(app) {
  if (!devServers.has(app)) {
    devServers.set(app, (async () => {
      // Vite 7 is ESM-only; import its entry by file URL from the app's own copy.
      const { createServer } = await import(pathToFileURL(path.join(app, "node_modules", "vite", "dist", "node", "index.js")).href);
      const server = await createServer({
        root: app,
        cacheDir: path.join(app, "node_modules", ".vite-e2e"),
        clearScreen: false,
        logLevel: "warn",
        // Off the usual 5173 range; Vite moves up when the port is taken.
        server: { port: 5390, strictPort: false },
      });
      await server.listen();
      const url = server.resolvedUrls && server.resolvedUrls.local[0];
      if (!url) throw new Error("Vite reported no local URL");
      // Crawl the entry's static imports now so the dep optimizer finishes
      // before the window loads; otherwise a first run can trigger Vite's
      // "new dependencies optimized" full reload mid-test.
      await server.transformRequest("/src/main.jsx");
      await server.waitForRequestsIdle("/src/main.jsx");
      console.log(`  ..  vite dev server ${url}`);
      return { server, url };
    })());
  }
  return devServers.get(app);
}

// Close any dev server this process started. Harnesses that call
// process.exit don't need it (the server lives in this process).
async function stopDevServers() {
  for (const p of devServers.values()) {
    try {
      (await p).server.close();
    } catch (_) {}
  }
  devServers.clear();
}

// Wait until the renderer has mounted (#root has children) and the preload ran.
function waitReady(win, timeout = 30_000) {
  return win.waitForFunction(() => !!window.electronAPI && document.querySelector("#root") && document.querySelector("#root").children.length > 0, null, { timeout });
}

const samePath = (a, b) => (WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// Throws unless the window shows the expected renderer. Call after waitReady:
// right after firstWindow() the URL can still be about:blank.
async function assertRenderer(win, expected) {
  const url = win.url();
  let ok;
  if (expected.kind === "url") {
    ok = url.startsWith("http") && new URL(url).origin === new URL(expected.url).origin;
  } else {
    ok = url.startsWith("file:") && samePath(fileURLToPath(url), expected.file);
  }
  if (!ok) throw new Error(`renderer is ${url}, expected ${expected.kind === "url" ? expected.url : expected.file}`);
  console.log(`  ..  renderer: ${url}`);
  // The page's CSS must carry Tailwind's utilities. A renderer whose Tailwind
  // scanned no sources still loads and mounts, but unstyled: every check that
  // clicks a sized control then times out somewhere unrelated (the sync tab
  // E2E's 0x0 chapter checkbox, 2026-10-18: a Vite started outside UI-source
  // found no Tailwind config and no sources; fixed in UI-source/postcss.config.js
  // and tailwind.config.js, grep relative). `hidden` and `flex` are used across
  // src, so both exist in any correct build.
  const css = await win.evaluate(() => {
    const probe = (cls) => {
      const d = document.createElement("div");
      d.className = cls;
      document.body.appendChild(d);
      const v = getComputedStyle(d).display;
      d.remove();
      return v;
    };
    return { hidden: probe("hidden"), flex: probe("flex") };
  });
  if (css.hidden !== "none" || css.flex !== "flex") throw new Error(`renderer CSS has no Tailwind utilities (.hidden → ${css.hidden}, .flex → ${css.flex})`);
}

/**
 * Launch the app and wait for its first window to be ready, renderer checked.
 * @param {object} o
 * @param {string} o.app          UI-source dir (unpackaged runs)
 * @param {string|null} o.exe     packaged executable, or null
 * @param {"dist"|"dev"} o.renderer
 * @param {boolean} o.build       dist mode: run vite build first
 * @param {boolean} o.show        unpackaged: a normal window instead of off-screen
 * @param {string} o.userDataDir  passed as --user-data-dir (the isolated profile)
 * @param {object} o.env          extra env (merged over process.env)
 * @param {string[]} o.extraArgs  extra Chromium switches
 * @returns {Promise<{app, win, output: () => string, executablePath, args, env}>}
 *   output: main's stdout+stderr so far. executablePath/args/env: what was
 *   launched, for harnesses that start a second instance themselves.
 */
async function launchApp({ app, exe = null, renderer = "dist", build = true, show = process.env.AIO_E2E_SHOW === "1", userDataDir, env: extra = {}, extraArgs = [], timeout = 60_000 }) {
  const { _electron } = require(process.env.PLAYWRIGHT_PATH || "playwright");
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AIO_DEV_SERVER_URL;
  let expected;
  let executablePath;
  let args;
  if (exe) {
    if (renderer !== "dist") throw new Error("--exe runs the packaged renderer; --renderer dev doesn't apply");
    fs.mkdirSync(path.join(userDataDir, "python-env"), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, "python-env", ".setup-complete"), "e2e");
    delete env.NODE_ENV;
    const resources = process.platform === "darwin" ? path.join(path.dirname(exe), "..", "Resources") : path.join(path.dirname(exe), "resources");
    expected = { kind: "file", file: path.join(resources, "app.asar", "dist", "index.html") };
    executablePath = exe;
    args = [...extraArgs, `--user-data-dir=${userDataDir}`];
  } else {
    if (renderer === "dev") {
      const { url } = await devServer(app);
      env.NODE_ENV = "development";
      env.AIO_DEV_SERVER_URL = url;
      expected = { kind: "url", url };
    } else {
      if (build) buildDist(app);
      env.NODE_ENV = "production";
      expected = { kind: "file", file: path.join(app, "dist", "index.html") };
    }
    executablePath = electronBinary(app);
    args = ["--no-sandbox", ...(show ? [] : ["-r", OFFSCREEN]), ...extraArgs, `--user-data-dir=${userDataDir}`, app];
  }
  console.log(`app: ${exe || app} (renderer ${exe ? "packaged" : renderer}, window ${exe || show ? "shown" : "off-screen"})`);
  const electronApp = await _electron.launch({ executablePath, args, env, timeout });
  let out = "";
  electronApp.process().stderr.on("data", (d) => (out += d));
  electronApp.process().stdout.on("data", (d) => (out += d));
  const win = await electronApp.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await waitReady(win);
  await assertRenderer(win, expected);
  return { app: electronApp, win, output: () => out, executablePath, args, env };
}

module.exports = { cliOptions, launchApp, waitReady, assertRenderer, stopDevServers, electronBinary };
