// Main-process isolation test for the Device Sync hooks in electron/main.js.
// Run: node tools/_test_device_sync_main_isolation.js   (from the repo root or tools/)
//      ELECTRON_RUN_AS_NODE=1 <electron> tools/_test_device_sync_main_isolation.js
//
// Loads the REAL main.js under a stub `electron` module, once per scenario in
// a child process (main.js holds module state and registers app listeners):
//   real     the real sync/service, spied: initDeviceSync is called exactly
//            once with every dependency present and of the right type, the
//            23 sync:* handlers register, sync stays inert while off, and each
//            hook fires with the right reason (merge only for a REAL merge).
//   loadfail sync/service throws at require time: main.js still loads.
//   initfail initDeviceSync throws: main.js still loads, no sync handler.
//   hostile  a deviceSync whose sync methods throw and async ones reject.
//   hostsync every method throws synchronously, async ones included.
//   ask      needsQuitAsk() true but quitInfo() throws: the close is held
//            with payload.sync null and `running` unchanged.
// In every scenario the shared paths behave as they do without sync:
// get-settings, save-settings, the close listener (with and without a
// running download), onComplete, metadata:update, scan-library,
// delete-series, save-series-meta, merge-series-folders (dry and real),
// second-instance, window-all-closed and the `quit` hook. No unhandled
// rejection and no uncaught exception may occur.
//
// NOT COVERED HERE (dev-mode guards return before the hook): reinstall-python
// (installed mode only) and app-update:apply-now (needs a downloaded update).
// metadata:update needs a fake `python` (an sh script), so it is skipped on
// win32.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ELECTRON_DIR = path.join(ROOT, "UI-source", "electron");
const MAIN = path.join(ELECTRON_DIR, "main.js");
const SERVICE = path.join(ELECTRON_DIR, "sync", "service.js");
const DOWNLOADER = path.join(ELECTRON_DIR, "downloader.js");
const SCENARIOS = ["real", "loadfail", "initfail", "hostile", "hostsync", "ask"];

// ───────────────────────────────────────────────────────────── parent
if (!process.argv[2]) {
  let failed = 0;
  for (const sc of SCENARIOS) {
    const r = spawnSync(process.execPath, [__filename, sc], { encoding: "utf8", env: process.env, timeout: 60_000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const fails = out.split("\n").filter((l) => l.startsWith("FAIL"));
    const oks = out.split("\n").filter((l) => l.startsWith("  ok")).length;
    const good = r.status === 0 && fails.length === 0 && /^DONE$/m.test(out);
    console.log(`${good ? "  ok " : "FAIL "} [${sc}] ${oks} checks${good ? "" : ` (exit ${r.status}${r.signal ? ` ${r.signal}` : ""})`}`);
    if (!good) {
      failed++;
      console.log(out.split("\n").map((l) => `      ${l}`).join("\n"));
    }
  }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nall ${SCENARIOS.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
}

// ───────────────────────────────────────────────────────────── child
const SC = process.argv[2];
let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

const unhandled = [];
process.on("unhandledRejection", (r) => unhandled.push(`rejection: ${(r && r.message) || r}`));
process.on("uncaughtException", (e) => unhandled.push(`uncaught: ${(e && e.message) || e}`));

const errors = [];
const realError = console.error;
console.error = (...a) => {
  errors.push(a.map((x) => (x && x.message) || String(x)).join(" "));
};
console.warn = () => {};
console.log = ((log) => (...a) => log(...a))(console.log);

// Temp layout. AIO_OUTPUT_DIR pins the library root (getConfiguredOutputRoot)
// so nothing under the repo is ever touched.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-main-iso-"));
const USERDATA = path.join(TMP, "userData");
const LIB = path.join(TMP, "library");
fs.mkdirSync(USERDATA, { recursive: true });
fs.mkdirSync(LIB, { recursive: true });
process.env.AIO_OUTPUT_DIR = LIB;
process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

// ── stub electron ──
const appListeners = {};
const sent = [];
const handlers = new Map();
const windows = [];
let readyP = null;
const calls = { quit: 0, exit: 0, focus: 0 };

class BrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.listeners = {};
    this.destroyed = false;
    this.minimized = false;
    this.webContents = {
      send: (ch, data) => sent.push({ ch, data }),
      executeJavaScript: () => Promise.resolve(),
      on: () => {},
    };
    windows.push(this);
  }
  loadURL() {
    return Promise.resolve();
  }
  loadFile() {
    return Promise.resolve();
  }
  on(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
  once(ev, fn) {
    this.on(ev, fn);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {}
  show() {}
  focus() {
    calls.focus += 1;
  }
  close() {}
  static getAllWindows() {
    return windows.filter((w) => !w.destroyed);
  }
  static getFocusedWindow() {
    return null;
  }
}

const electronStub = {
  app: {
    isPackaged: false,
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    on(ev, fn) {
      (appListeners[ev] ||= []).push(fn);
    },
    whenReady() {
      return {
        then(cb) {
          readyP = Promise.resolve().then(cb);
          return readyP;
        },
      };
    },
    isReady: () => true,
    getPath: (n) => {
      const p = path.join(TMP, n);
      fs.mkdirSync(p, { recursive: true });
      return n === "userData" ? USERDATA : p;
    },
    getVersion: () => "0.0.0-test",
    getName: () => "aio-test",
    quit() {
      calls.quit += 1;
    },
    exit() {
      calls.exit += 1;
    },
    relaunch() {},
    dock: undefined,
  },
  BrowserWindow,
  ipcMain: {
    handle(ch, fn) {
      if (handlers.has(ch)) throw new Error(`duplicate handler ${ch}`);
      handlers.set(ch, fn);
    },
    on() {},
    removeHandler(ch) {
      handlers.delete(ch);
    },
  },
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  dialog: {
    showSaveDialog: () => Promise.resolve({ canceled: true }),
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showMessageBox: () => Promise.resolve({ response: 0 }),
  },
  shell: { openPath: () => Promise.resolve(""), openExternal: () => Promise.resolve() },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  net: { fetch: () => Promise.resolve() },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} } } },
};

// ── module interception ──
let downloaderOpts = null;
let downloadsRunning = 0;
const spy = { initCalls: [], facade: null, calls: [] };

function hostileFacade(mode) {
  const syncNames = ["needsQuitAsk", "quitInfo", "isJobRunning", "notifyLibraryChanged", "shutdownNow"];
  const asyncNames = ["applySettings", "shutdown", "cancelFindSources"];
  const f = {};
  for (const n of syncNames) {
    f[n] = () => {
      if (mode === "ask" && n === "needsQuitAsk") return true;
      throw new Error(`hostile ${n}`);
    };
  }
  for (const n of asyncNames) {
    f[n] = mode === "hostsync" ? () => { throw new Error(`hostile ${n}`); } : () => Promise.reject(new Error(`hostile ${n}`));
  }
  return f;
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (_) {}
  if (resolved === SERVICE) {
    if (SC === "loadfail") throw new Error("simulated load-time throw in sync/");
    const real = realLoad.apply(this, arguments);
    return {
      ...real,
      initDeviceSync(deps) {
        spy.initCalls.push(deps);
        if (SC === "initfail") throw new TypeError("simulated init failure");
        if (SC !== "real") return hostileFacade(SC);
        const facade = real.initDeviceSync(deps);
        // Spy every facade method; results pass through untouched.
        spy.facade = facade;
        return new Proxy(facade, {
          get(t, k) {
            const v = t[k];
            if (typeof v !== "function") return v;
            return (...a) => {
              spy.calls.push([k, ...a]);
              return v.apply(t, a);
            };
          },
        });
      },
    };
  }
  if (resolved === DOWNLOADER) {
    const real = realLoad.apply(this, arguments);
    class SpyDownloader extends real.Downloader {
      constructor(opts) {
        super(opts);
        downloaderOpts = opts;
      }
      runningCount() {
        return downloadsRunning;
      }
      getRunning() {
        return downloadsRunning ? [{ downloadId: "d1", title: "T", url: "https://x/y", startedAt: 1 }] : [];
      }
      cancelAll() {
        return Promise.resolve();
      }
    }
    return { ...real, Downloader: SpyDownloader };
  }
  return realLoad.apply(this, arguments);
};

const syncCalls = (name) => spy.calls.filter((c) => c[0] === name);
const notified = () => syncCalls("notifyLibraryChanged").map((c) => c[1]);

function writeMeta(folder, meta) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, ".aio_series.json"), JSON.stringify(meta), "utf8");
}

function emitClose() {
  let prevented = false;
  const e = { preventDefault: () => (prevented = true) };
  for (const fn of windows[0].listeners.close || []) fn(e);
  return prevented;
}

async function invoke(ch, ...args) {
  const fn = handlers.get(ch);
  if (!fn) throw new Error(`no handler ${ch}`);
  return fn({ sender: {} }, ...args);
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

(async function run() {
  console.log(`\n[${SC}]`);
  let loadErr = null;
  try {
    require(MAIN);
  } catch (e) {
    loadErr = e;
  }
  check("main.js loads", !loadErr, loadErr && loadErr.stack);
  check("whenReady registered", !!readyP);
  try {
    await readyP;
  } catch (e) {
    check("whenReady callback completes", false, e && e.stack);
  }
  await settle();
  eq("main window created", windows.length, 1);
  check("downloader initialised", !!downloaderOpts);

  const syncHandlers = [...handlers.keys()].filter((k) => k.startsWith("sync:"));
  if (SC === "real") {
    eq("initDeviceSync called exactly once", spy.initCalls.length, 1);
    const deps = spy.initCalls[0] || {};
    const { DEPS, validateDeps } = require(SERVICE);
    let vErr = null;
    try {
      validateDeps(deps);
    } catch (e) {
      vErr = e;
    }
    check("every dependency present and of the right type", !vErr, vErr && vErr.message);
    for (const [k, type] of Object.entries(DEPS)) check(`dep ${k} is ${type}`, type === "object" ? !!deps[k] && typeof deps[k] === "object" : typeof deps[k] === type);
    eq("userDataDir is userData/sync", deps.userDataDir, path.join(USERDATA, "sync"));
    eq("getLibraryRoot() is the configured output root", deps.getLibraryRoot(), LIB);
    eq("getRunningDownloads() is an array", Array.isArray(deps.getRunningDownloads()), true);
    eq("isCheckAllRunning() is false", deps.isCheckAllRunning(), false);
    eq("isSearchRunning() is false", deps.isSearchRunning(), false);
    eq("isFocused() is a boolean", typeof deps.isFocused(), "boolean");
    check("getWindow() reads the window lazily", deps.getWindow() === windows[0]);
    check("getSettings() returns the saved settings", deps.getSettings() && typeof deps.getSettings() === "object");
    check("resolveSpawnPaths() resolves a workingDir", typeof deps.resolveSpawnPaths({}).workingDir === "string");
    eq("23 sync:* handlers registered", syncHandlers.length, 23);
    const gs = await invoke("sync:get-state");
    eq("sync:get-state answers enabled:false while off", [gs.ok, gs.enabled], [true, false]);
    const off = await invoke("sync:plan", { targetId: "x" });
    eq("a job channel answers disabled while off", off.code, "disabled");
    check("inert while off: no userData/sync", !fs.existsSync(path.join(USERDATA, "sync")));
  } else {
    eq("no sync:* handler registered", syncHandlers.length, 0);
    if (SC === "loadfail") check("load failure logged", errors.some((e) => e.includes("[deviceSync] load failed")));
    if (SC === "initfail") check("init failure logged", errors.some((e) => e.includes("[deviceSync] init failed")));
  }

  // get-settings / save-settings
  const settings = await invoke("get-settings");
  check("get-settings answers an object", settings && typeof settings === "object");
  let fakePy = null;
  if (process.platform !== "win32") {
    fakePy = path.join(TMP, "fakepy.sh");
    fs.writeFileSync(fakePy, "#!/bin/sh\ncat >/dev/null\necho '{\"ok\":true}'\n");
    fs.chmodSync(fakePy, 0o755);
  }
  const saved = await invoke("save-settings", { ...settings, ...(fakePy ? { pythonCmd: fakePy } : {}) });
  eq("save-settings answers ok", saved, { ok: true });
  await settle();
  if (SC === "real") {
    eq("applySettings got the merged settings", syncCalls("applySettings").length, 1);
    eq("applySettings saw the saved pythonCmd", fakePy ? syncCalls("applySettings")[0][1].pythonCmd : null, fakePy);
  }

  // close listener
  downloadsRunning = 0;
  sent.length = 0;
  const heldIdle = emitClose();
  if (SC === "ask") {
    check("ask: close held for a sync-only blocker", heldIdle);
    const cq = sent.find((s) => s.ch === "confirm-quit");
    eq("ask: payload keeps running, sync null when quitInfo throws", cq && cq.data, { running: [], sync: null });
  } else {
    check("close not held with nothing running", !heldIdle);
  }
  downloadsRunning = 1;
  sent.length = 0;
  const heldBusy = emitClose();
  check("close held while a download runs", heldBusy);
  const cq = sent.find((s) => s.ch === "confirm-quit");
  eq("confirm-quit payload", cq && cq.data, { running: [{ downloadId: "d1", title: "T", url: "https://x/y", startedAt: 1 }], sync: null });
  downloadsRunning = 0;

  // onComplete
  sent.length = 0;
  let ocErr = null;
  try {
    downloaderOpts.onComplete("d1", { status: "completed" });
  } catch (e) {
    ocErr = e;
  }
  check("onComplete does not throw", !ocErr, ocErr && ocErr.message);
  check("download-complete still sent", sent.some((s) => s.ch === "download-complete"));

  // metadata:update
  if (fakePy) {
    const md = await invoke("metadata:update", path.join(LIB, "x.cbz"), { title: "x" }, null);
    eq("metadata:update answers the CLI's JSON", md, { ok: true });
  } else {
    console.log("  --  metadata:update not run (win32: no fake python)");
  }

  // library: a same-series pair (same anilist_id) for the merge
  const A = path.join(LIB, "Alpha");
  const B = path.join(LIB, "Alpha (2)");
  writeMeta(A, { title: "Alpha", anilist_id: 77, chapters_downloaded: ["1"] });
  writeMeta(B, { title: "Alpha", anilist_id: 77, chapters_downloaded: ["2"] });
  fs.writeFileSync(path.join(A, "Ch.001.cbz"), "a");
  fs.writeFileSync(path.join(B, "Ch.002.cbz"), "b");

  const scan = await invoke("scan-library");
  check("scan-library answers a list", Array.isArray(scan), JSON.stringify(scan).slice(0, 200));

  const ssm = await invoke("save-series-meta", A, { url: "https://example.test/alpha" });
  eq("save-series-meta ok", ssm && ssm.ok, true);

  const dry = await invoke("merge-series-folders", { targetFolder: A, sourceFolders: [B], dryRun: true });
  eq("dry merge ok and dry", [dry.ok, dry.dryRun], [true, true]);
  const omitted = await invoke("merge-series-folders", { targetFolder: A, sourceFolders: [B] });
  eq("merge without the flag is a dry run", [omitted.ok, omitted.dryRun], [true, true]);
  if (SC === "real") eq("no library hook for dry merges", notified().filter((r) => r === "merge").length, 0);
  const real = await invoke("merge-series-folders", { targetFolder: A, sourceFolders: [B], dryRun: false });
  eq("real merge ok and not dry", [real.ok, real.dryRun], [true, false]);
  check("real merge moved the chapter", fs.existsSync(path.join(A, "Ch.002.cbz")) && !fs.existsSync(B));

  const del = path.join(LIB, "Gone");
  fs.mkdirSync(del);
  const ds = await invoke("delete-series", del);
  eq("delete-series ok", [ds.ok, fs.existsSync(del)], [true, false]);

  if (SC === "real") {
    await settle();
    const want = ["download", ...(fakePy ? ["metadata"] : []), "scan", "series-meta", "merge", "delete"];
    eq("library hooks fired with their reasons, merge once", notified(), want);
  }

  // second-instance
  const focusBefore = calls.focus;
  for (const fn of appListeners["second-instance"] || []) fn({}, [], TMP);
  eq("second-instance focuses the window", calls.focus, focusBefore + 1);

  // window-all-closed, then the quit hook
  const wac = appListeners["window-all-closed"] || [];
  eq("one window-all-closed listener", wac.length, 1);
  await wac[0]();
  eq("window-all-closed quits", calls.quit, 1);
  if (SC === "real") eq("shutdown awaited with the 5 s bound", syncCalls("shutdown").map((c) => c[1]), [{ timeoutMs: 5000 }]);
  let qErr = null;
  try {
    for (const fn of appListeners.quit || []) fn();
  } catch (e) {
    qErr = e;
  }
  check("quit hook does not throw", !qErr, qErr && qErr.message);
  if (SC === "real") eq("shutdownNow called from the quit hook", syncCalls("shutdownNow").length, 1);

  // A second launch after quit began opens nothing.
  windows[0].destroyed = true;
  const before = windows.length;
  for (const fn of appListeners["second-instance"] || []) fn({}, [], TMP);
  eq("second-instance during quit opens no window", windows.length, before);

  await settle();
  eq("no unhandled rejection or uncaught exception", unhandled, []);
  if (SC === "real") eq("nothing logged to console.error", errors, []);
  console.log(failures ? `\n${failures} failure(s)` : "DONE");
  console.error = realError;
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log(`FAIL  harness: ${e && e.stack}`);
  process.exit(1);
});
