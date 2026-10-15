// Packaged-build smoke for Device Sync (non-UI plan P5), sync ON with a
// folder target. Windows-first (the installed app's platform).
//
//   cd UI-source && npx electron-builder --dir --publish never \
//     -c.electronDist=node_modules/electron/dist -c.directories.output=<out>
//   node tools/_smoke_device_sync_packaged.js --exe "<out>/win-unpacked/AIO Downloader.exe" [--python <exe>]
//   PLAYWRIGHT_PATH overrides where `playwright` is required from.
//
// Three launches, each on its own temp userData (--user-data-dir; Electron
// honors it and keys the single-instance lock on it) and temp library
// (AIO_OUTPUT_DIR), so the installed app's %APPDATA%\aio-downloader-ui is
// never opened. The temp profile is pre-marked set up (python-env/
// .setup-complete), so the packaged first-run wizard doesn't download Python.
// Settings point pythonCmd at real python and scriptPath at a fake search
// that writes its pid, starts a sleeping grandchild (a process TREE, like
// aio-dl → Playwright → Chromium) and sleeps.
//
// Per launch: wait for the connect plan, add a series the plan never saw
// (so the 30 s pre-warm has files of its own to hash), wait for the pre-warm,
// start find-sources on the device-only folder, then quit while the search
// tree runs:
//   A. a normal close (BrowserWindow.close → window-all-closed → shutdown);
//   B. the real reinstall-python handler (awaits find-sources' tree kill,
//      then app.exit(0), which skips window-all-closed);
//   C. a bare app.exit(0) with the search still running, so shutdownNow's
//      kill is the only one (deviation 8's guarantee).
// Checks: the service log (userData/sync/logs/service.log, deviation 15)
// says sync/service loaded from inside app.asar, the pre-warm hashed in its
// eval'd workers, and how the service ended (A: `stop` settled+flushed with
// the search running; B, C: `quit-now`); no process of the search tree
// survives any of the three.
//
// tools/ is gitignored; force-added on wip/device-sync-handoff only.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const EXE = opt("--exe");
if (!EXE || !fs.existsSync(EXE)) {
  console.log(`FAIL  --exe not found: ${EXE}`);
  process.exit(1);
}
const PY = opt("--python") || "python";
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
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function writeOld(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  const t = Date.now() / 1000 - 3600;
  fs.utimesSync(p, t, t);
}
function series(lib, folder, nCh, size) {
  writeOld(path.join(lib, folder, ".aio_series.json"), JSON.stringify({ url: `https://mangafire.to/manga/${folder.toLowerCase().replace(/\W+/g, "-")}.x1`, title: folder }));
  for (let i = 1; i <= nCh; i += 1) writeOld(path.join(lib, folder, `Ch.${String(i).padStart(3, "0")}.cbz`), Buffer.alloc(size, `${folder}${i}`));
}

// The fake search: pid line for itself and its grandchild, then sleep.
const FAKE_SEARCH = `import os, subprocess, sys, time
d = os.environ["AIO_SMOKE_PIDS"]
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
with open(os.path.join(d, str(os.getpid()) + ".txt"), "w") as f:
    f.write("%d %d" % (os.getpid(), child.pid))
time.sleep(300)
`;

async function launch(label, quit) {
  console.log(`\n${label}`);
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-p5-"));
  const UD = path.join(TMP, "userData");
  const LIB = path.join(TMP, "library");
  const DEV = path.join(TMP, "device");
  const PIDS = path.join(TMP, "pids");
  for (const d of [UD, LIB, DEV, PIDS]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(UD, "python-env"), { recursive: true });
  fs.writeFileSync(path.join(UD, "python-env", ".setup-complete"), "smoke");
  const fakeSearch = path.join(TMP, "fake_search.py");
  fs.writeFileSync(fakeSearch, FAKE_SEARCH);
  fs.writeFileSync(path.join(UD, "settings.json"), JSON.stringify({ syncEnabled: true, pythonCmd: PY, scriptPath: fakeSearch, workingDir: TMP }));
  fs.mkdirSync(path.join(UD, "sync"), { recursive: true });
  fs.writeFileSync(path.join(UD, "sync", "sync-targets.json"), JSON.stringify({ version: 1, adbPath: null, targets: [{ id: "t1", name: "Folder", kind: "folder", root: DEV, profile: "komikku" }] }));
  series(LIB, "Alpha", 3, 4 << 20);
  series(LIB, "Beta", 2, 4 << 20);
  writeOld(path.join(DEV, "Old One", "a.cbz"), "a");

  const env = { ...process.env, AIO_OUTPUT_DIR: LIB, AIO_SMOKE_PIDS: PIDS };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_ENV;
  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UD}`], env, timeout: 60_000 });
  const exited = new Promise((r) => app.process().on("exit", (c, s) => r({ c, s })));
  const win = await app.firstWindow();
  await win.waitForFunction(() => !!window.electronAPI && document.querySelector("#root") && document.querySelector("#root").children.length > 0, null, { timeout: 30_000 });
  const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  check("userData is the temp profile", path.resolve(userData) === path.resolve(UD), userData);
  check("packaged", await app.evaluate(({ app: a }) => a.isPackaged));

  const LOG = path.join(UD, "sync", "logs", "service.log");
  const lines = () => {
    try {
      return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  };
  const st = () => win.evaluate(() => window.electronAPI.syncGetState());
  await waitFor(async () => {
    const s = await st();
    return s.ok && s.plans && s.plans.t1 && s.plans.t1.summary && !(s.job && s.job.job && s.job.job.state === "running");
  }, 60_000, "the connect plan");
  check("connect plan ran", true);
  // Files the plan never hashed, so the pre-warm hashes some itself.
  series(LIB, "Gamma", 4, 4 << 20);
  const tPre = Date.now();
  const pw = await waitFor(() => lines().find((l) => l.ev === "prewarm"), 75_000, "the pre-warm line");
  console.log(`  ..  pre-warm line ${Math.round((Date.now() - tPre) / 1000)} s after adding Gamma: ${JSON.stringify(pw)}`);

  const fsr = await win.evaluate(() => window.electronAPI.syncFindSourcesStart({ targetId: "t1" }));
  check("find-sources started", fsr && fsr.ok && fsr.started, JSON.stringify(fsr));
  const pids = await waitFor(() => {
    const f = fs.readdirSync(PIDS);
    return f.length ? fs.readFileSync(path.join(PIDS, f[0]), "utf8").trim().split(" ").map(Number) : null;
  }, 30_000, "the fake search's pids");
  check("search tree is up (python + grandchild)", pids.length === 2 && pids.every(alive), JSON.stringify(pids));

  const tq = Date.now();
  await quit(app);
  const ex = await Promise.race([exited, sleep(20_000).then(() => "timeout")]);
  check("app exited", ex !== "timeout", JSON.stringify(ex));
  console.log(`  ..  quit took ${Date.now() - tq} ms`);
  // Slack only: killTreeNow is synchronous, but a survivor seen at once
  // could still be mid-exit. 3 s is far past that, not a race we rely on.
  await sleep(3000);
  check("no process of the search tree survives", pids.every((p) => !alive(p)), pids.map((p) => `${p}:${alive(p) ? "alive" : "gone"}`).join(" "));
  for (const p of pids) if (alive(p)) execFileSync("taskkill", ["/pid", String(p), "/t", "/f"], { stdio: "ignore" });

  const L = lines();
  console.log(`  ..  service.log: ${L.map((l) => l.ev).join(", ")}`);
  const start = L.find((l) => l.ev === "start");
  check("start: sync/service loaded from inside app.asar", start && start.inAsar === true && /app\.asar[\\/]electron[\\/]sync[\\/]service\.js$/.test(start.module), start && start.module);
  const p = L.find((l) => l.ev === "prewarm");
  check("pre-warm: done, hashed in the eval'd workers", p && p.state === "done" && p.run.hashed >= 4 && p.run.mainThread === 0 && p.run.workerDeaths === 0 && p.spawned >= 1 && p.fallback === false, JSON.stringify(p));
  const errs = L.filter((l) => l.ev === "error");
  check("no error lines", errs.length === 0, JSON.stringify(errs).slice(0, 400));
  const last = L[L.length - 1];
  return { last, L, TMP };
}

(async () => {
  console.log(`exe: ${EXE}`);
  const a = await launch("A. normal close", (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()));
  check("A ends with a clean stop that cancelled the search", a.last && a.last.ev === "stop" && a.last.reason === "shutdown" && a.last.settled === true && a.last.flushed === true && a.last.hadFind === true, JSON.stringify(a.last));
  check("A writes no quit-now", !a.L.some((l) => l.ev === "quit-now"));
  // The real reinstall-python handler: it awaits find-sources' tree kill,
  // deletes the (temp) python-env, then app.exit(0). app.relaunch is stubbed
  // so the relaunched app can't start the first-run wizard and fetch Python.
  // The exit kills the main process mid-call: a closed target is expected.
  const b = await launch("B. reinstall-python (awaited cancel, then app.exit)", async (app) => {
    await app.evaluate(({ app: x }) => {
      x.relaunch = () => {};
    });
    const win = await app.firstWindow();
    await win.evaluate(() => window.electronAPI.reinstallPython()).catch(() => {});
  });
  check("B ends with the service still up at quit (quit-now)", b.last && b.last.ev === "quit-now", JSON.stringify(b.last));
  check("B: no search process was left for quit-now to kill", b.last && b.last.searchProc === false, JSON.stringify(b.last));
  check("B deleted the temp python-env", !fs.existsSync(path.join(b.TMP, "userData", "python-env")));
  // A bare app.exit with the search alive: shutdownNow is the only kill.
  const c = await launch("C. bare app.exit(0) with the search running", (app) => app.evaluate(({ app: x }) => setTimeout(() => x.exit(0), 50)).catch(() => {}));
  check("C ends with quit-now that had to kill the search", c.last && c.last.ev === "quit-now" && c.last.searchProc === true, JSON.stringify(c.last));
  for (const t of [a.TMP, b.TMP, c.TMP]) {
    try {
      fs.rmSync(t, { recursive: true, force: true });
    } catch (_) {}
  }
  console.log(failures ? `\n${failures} failure(s)` : "\npackaged smoke passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log(`FAIL  smoke: ${e && e.stack}`);
  process.exit(1);
});
