// Generates the Device Sync DEV fixtures (UI-source/src/dev/sync-fixtures/*.json)
// by RECORDING the real service, not by hand-writing its shapes (plan
// decision 10, "fixtures cannot drift"): it boots electron/sync/service.js
// against temp folders and tools/fake-adb-server.js — the same harness as
// tools/_test_device_sync_service.js — and saves what the sync:* handlers and
// sync-event pushes actually answer. Re-run it after any backend change to a
// payload the UI reads:
//
//   node tools/_gen_sync_fixtures.js
//
// What is synthetic, and why (everything else is a recorded answer):
//   * adb candidates: the real locator probes this PC's disks; the fixture
//     must not carry the user's paths, so the locate stub returns two made-up
//     Windows paths (shape = service.js `locate-adb`);
//   * adb tracking variants (adb-states.json): the recorded `tracking` view
//     with `tracking` / `trackingError` / `error` swapped for each state
//     monitor.js reports, since the fake server can't be all five at once;
//   * the temp-folder prefix is rewritten to D:\Sync-fixture so no local
//     user name lands in the fixtures.
//
// Consumer: UI-source/src/dev/syncFixtureSource.js (the DEV seam's fake
// electronAPI) → src/dev/SyncGallery.jsx. Neither ships: main.jsx imports the
// gallery only under import.meta.env.DEV, and `npm run build` is checked for
// fixture strings (grep SYNC_FIXTURE_MARKER).
//
// tools/ is gitignored; this file is force-added on wip/device-sync-handoff
// only and never ships.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SYNC = path.join(ROOT, "UI-source", "electron", "sync");
const OUT = path.join(ROOT, "UI-source", "src", "dev", "sync-fixtures");
const service = require(path.join(SYNC, "service.js"));
const contract = require(path.join(SYNC, "contract.js"));
const { FakeAdbServer } = require(path.join(__dirname, "fake-adb-server.js"));

// Every fixture file carries this key; the build check greps dist/ for it.
const SYNC_FIXTURE_MARKER = "__aioSyncFixture";
const FAKE_ROOT = "D:\\Sync-fixture";
const SERIAL = "R5CW71ABCDE";
const OFFLINE_SERIAL = "2A161FDH200ABC";
const UNAUTH_SERIAL = "RZ8N40XYZ12";
const CANON = "/storage/emulated/0/Komikku/local";
const OLD_S = Math.floor(Date.now() / 1000) - 3600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function bytes(name, size) {
  const seed = Buffer.from(`${name}|`);
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = seed[i % seed.length];
  return out;
}

function series(lib, folder, files) {
  const dir = path.join(lib, folder);
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(OLD_S * 1000);
  const write = (p, d) => {
    fs.writeFileSync(p, d);
    fs.utimesSync(p, old, old);
  };
  write(path.join(dir, ".aio_series.json"), JSON.stringify({ url: `https://mangafire.to/title/${folder.toLowerCase().replace(/\W+/g, "-")}`, title: folder }));
  for (const [name, size] of Object.entries(files)) write(path.join(dir, name), bytes(name, size));
}

// Rewrite the temp prefix (both slash flavours) in every string.
function scrub(v, tmp) {
  const variants = [tmp, tmp.replace(/\\/g, "/")];
  const walk = (x) => {
    if (typeof x === "string") {
      let s = x;
      for (const t of variants) s = s.split(t).join(FAKE_ROOT);
      return s;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aio-sync-fixtures-"));
  const lib = path.join(tmp, "manga");
  const userData = path.join(tmp, "ud", "sync");
  const folderRoot = path.join(tmp, "Komikku", "local");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(folderRoot, { recursive: true });
  series(lib, "Eleceed", { "Ch.001 - Eleceed.cbz": 4000, "Ch.002 - Eleceed.cbz": 4200 });
  series(lib, "Dungeon Meshi", { "Ch.001 - Dungeon Meshi.cbz": 5000 });

  const srv = new FakeAdbServer();
  const port = await srv.listen();
  const dev = srv.addDevice({ serial: SERIAL, model: "SM-X710", product: "gts9wifi", inject: { symlinks: { "/sdcard": "/storage/emulated/0" } } });
  dev.fs.mkdirs(CANON);
  for (const d of ["Berserk", "Chainsaw Man", "Dungeon Meshi", "Eleceed"]) dev.fs.mkdirs(`${CANON}/${d}`);
  dev.fs.mkdirs("/storage/emulated/0/Mihon/local");
  dev.fs.mkdirs("/storage/emulated/0/Download");
  srv.addDevice({ serial: UNAUTH_SERIAL, state: "unauthorized", model: "", product: "" });

  const events = [];
  const handlers = new Map();
  let settings = { syncEnabled: true, cpuLimit: "unlimited", syncChapterPatterns: "Episode\\s*(?<ch>\\d+(?:\\.\\d+)?)" };
  const deps = {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    send: (ch, p) => {
      assert.strictEqual(ch, contract.EVENT_CHANNEL);
      events.push(p);
    },
    userDataDir: userData,
    getSettings: () => settings,
    getLibraryRoot: () => lib,
    getRunningDownloads: () => [],
    isCheckAllRunning: () => false,
    isSearchRunning: () => false,
    resolveSpawnPaths: () => ({ pythonCmd: "python", scriptPath: "aio-dl.py", workingDir: tmp }),
    extraEnv: {},
    onFocus: () => {},
    isFocused: () => true,
    getWindow: () => null,
    showSaveDialog: async () => ({ canceled: true }),
    _test: {
      clientOpts: { port, recheckMs: 20, idleMs: 5000, connectTimeoutMs: 500 },
      locateAdb: async () => ({
        resolved: "C:\\platform-tools\\adb.exe",
        candidates: [
          { path: "C:\\platform-tools\\adb.exe", source: "configured", ok: true, version: "1.0.41", build: "35.0.2-12147458" },
          { path: "C:\\Users\\Reader\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe", source: "LOCALAPPDATA", ok: true, version: "1.0.41", build: "34.0.5-10900879" },
        ],
      }),
      ensureServer: async (client) => {
        try {
          return { ok: true, version: await client.version(), started: false };
        } catch (e) {
          return { ok: false, error: e, started: false };
        }
      },
      prewarmDelayMs: 60 * 60 * 1000,
      replanDebounceMs: 30,
      busyPollMs: 40,
      bootEpoch: 1,
      connectWaitMs: 2000,
    },
  };
  const svc = service.initDeviceSync(deps);
  const call = async (name, payload) => {
    const r = await handlers.get(`sync:${name}`)({}, payload || {});
    assert.ok(r && r.ok !== false, `sync:${name} refused: ${JSON.stringify(r)}`);
    return r;
  };
  const out = {};
  try {
    out.locate = await call("locate-adb", { rescan: true });
    const tab = await call("config-op", { op: "add-target", target: { name: "Galaxy Tab S9", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    await call("config-op", { op: "add-target", target: { name: "Komikku folder", kind: "folder", root: folderRoot, profile: "everything" } });
    await call("config-op", { op: "add-target", target: { name: "Pixel 7", kind: "adb", serial: OFFLINE_SERIAL, root: "/storage/emulated/0/Mihon/local", profile: "custom", formats: ["cbz", "pdf"], sidecars: ["cover.jpg"], nomedia: false, namingPolicy: "title" } });
    let st = await call("get-state");
    const v = st.config.version;
    await call("config-op", { op: "add-alias", targetId: tab.targetId, expectVersion: v, alias: { pcFolder: "Tonikaku Kawaii", deviceFolder: "Fly Me to the Moon" } });
    st = await call("get-state");
    await call("config-op", { op: "add-exclude", targetId: tab.targetId, expectVersion: st.config.version, entry: { pcFolder: "Blue Lock" } });
    await waitFor(async () => (await call("get-state")).adb.tracking === "tracking", 5000, "adb tracking");
    out.stateOn = await call("get-state");
    out.devices = await call("list-devices");
    out.browse = {};
    for (const p of ["/sdcard", "/sdcard/Komikku/local", "/storage/emulated/0"]) out.browse[p] = await call("browse-remote", { serial: SERIAL, path: p });
    out.labelPreview = {};
    for (const name of ["Episode 42 - Eleceed.cbz", "Ch.118.5 Extra.cbz", "Vol.03 Ch.021.cbz", "Omake (bonus).cbz", "Eleceed Ch 12~5.cbz"]) {
      out.labelPreview[name] = {
        custom: await call("label-preview", { name, folderName: "Eleceed", patterns: settings.syncChapterPatterns }),
        builtin: await call("label-preview", { name, folderName: "Eleceed", patterns: "" }),
      };
    }
    out.labelPreviewBadPattern = await call("label-preview", { name: "Episode 42.cbz", folderName: "Eleceed", patterns: "Episode (\\d+" });
    // A refusal the editor must render: a stale expectVersion.
    out.versionConflict = await handlers.get("sync:config-op")({}, { op: "update-target", targetId: tab.targetId, expectVersion: 1, patch: { name: "x" } });
    out.invalidField = await handlers.get("sync:config-op")({}, { op: "update-target", targetId: tab.targetId, patch: { nomedia: false } });
    settings = { ...settings, syncEnabled: false };
    await svc.applySettings(settings);
    await waitFor(async () => !(await handlers.get("sync:get-state")({}, {})).enabled, 5000, "sync off");
    out.stateOff = await handlers.get("sync:get-state")({}, {});
    out.events = events.filter((e) => e.kind === "adb" || e.kind === "settings" || e.kind === "config").slice(-12);
  } finally {
    await svc.shutdown({ timeoutMs: 2000 });
    await srv.close();
  }

  const adb = out.stateOn.adb;
  out.adbStates = {
    tracking: adb,
    connecting: { ...adb, tracking: "connecting", serverVersion: null },
    polling: { ...adb, tracking: "polling" },
    stopped: { ...adb, tracking: "stopped" },
    error: { ...adb, tracking: "stopped", binary: "C:\\platform-tools\\adb.exe", serverVersion: null, error: "C:\\platform-tools\\adb.exe exited with code 1", trackingError: "connect ECONNREFUSED 127.0.0.1:5037" },
    missing: { ...adb, tracking: "stopped", binary: null, serverVersion: null, candidates: [], error: "no adb binary to start the server with" },
  };

  fs.mkdirSync(OUT, { recursive: true });
  const files = {
    "state-off.json": out.stateOff,
    "state-on.json": out.stateOn,
    "devices.json": out.devices,
    "locate-adb.json": out.locate,
    "browse-remote.json": out.browse,
    "label-preview.json": { byName: out.labelPreview, badPattern: out.labelPreviewBadPattern },
    "refusals.json": { versionConflict: out.versionConflict, invalidField: out.invalidField },
    "adb-states.json": out.adbStates,
    "events.json": out.events,
  };
  for (const [name, data] of Object.entries(files)) {
    const body = { [SYNC_FIXTURE_MARKER]: name, generatedBy: "tools/_gen_sync_fixtures.js", data: scrub(data, tmp) };
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(body, null, 2) + "\n");
  }
  const leaked = Object.keys(files).filter((n) => fs.readFileSync(path.join(OUT, n), "utf8").includes(os.userInfo().username));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (leaked.length) throw new Error(`fixture carries the local user name: ${leaked.join(", ")}`);
  console.log(`wrote ${Object.keys(files).length} fixtures to ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
