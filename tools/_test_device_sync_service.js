// End-to-end regression for UI-source/electron/sync/service.js (deviceSync
// P4): the service driven through a fake ipcMain, as the renderer would,
// against FolderTransport (real temp folders) and tools/fake-adb-server.js.
//
// Covers the non-UI plan's Verification → "Service E2E": disabled means
// inert; turning sync off mid-job; the one refusal shape; a facade that never
// throws; rename as a quit-ask job; config ops; the main flow (plan →
// selection → apply → PC edits → re-plan → both delete policies → verify →
// prune → library unplugged); quit (shutdown within 5 s, shutdownNow twice);
// find-sources with a fake Searcher; and the P4 additions (sync:link, the
// connect prompt, the adb flow, library status, pre-warm, a device refusal
// ending its job with summary.refusal).
//
//   node tools/_test_device_sync_service.js
//   ELECTRON_RUN_AS_NODE=1 UI-source/node_modules/electron/dist/electron tools/_test_device_sync_service.js
//   TEST_ONLY=<regex> runs the matching tests only.
//
// tools/ is gitignored; this file is force-added on wip/device-sync-handoff
// only and never ships.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SYNC = path.join(__dirname, "..", "UI-source", "electron", "sync");
const service = require(path.join(SYNC, "service.js"));
const contract = require(path.join(SYNC, "contract.js"));
const { FakeAdbServer } = require(path.join(__dirname, "fake-adb-server.js"));

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-sync-service-"));
let dirSeq = 0;
function mkdir(tag) {
  const d = path.join(TMP, `${String(++dirSeq).padStart(3, "0")}-${tag || "t"}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const OLD_S = Math.floor(Date.now() / 1000) - 3600;
const SERIAL = "A06B4A372090333";
const CANON = "/storage/emulated/0/Komikku/local";

function bytes(name, size, v = 1) {
  const seed = Buffer.from(`${name}#${v}|`);
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = seed[i % seed.length];
  return out;
}
function writeOld(p, data, mtimeS = OLD_S) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  fs.utimesSync(p, mtimeS, mtimeS);
}
function series(lib, folder, files, url) {
  const dir = path.join(lib, folder);
  fs.mkdirSync(dir, { recursive: true });
  writeOld(path.join(dir, ".aio_series.json"), JSON.stringify({ url: url || `https://mangafire.to/manga/${encodeURIComponent(folder.toLowerCase())}.x1`, title: folder }));
  for (const [name, size] of Object.entries(files)) writeOld(path.join(dir, name), bytes(name, size));
}

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function assertRefusal(r, code) {
  assert.ok(r && r.ok === false, `expected a refusal, got ${JSON.stringify(r)}`);
  assert.ok(contract.REFUSAL_CODES.includes(r.code), `unknown code ${r.code}`);
  assert.strictEqual(typeof r.message, "string");
  if (code) assert.strictEqual(r.code, code, `${r.code}: ${r.message}`);
}

class FakeSearcher {
  constructor(ctl) {
    this.ctl = ctl;
    this.pending = null;
  }
  runSearch({ query }) {
    this.ctl.calls.push(query);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      if (this.ctl.mode === "auto") {
        this.pending = null;
        if (this.ctl.fail && this.ctl.fail.test(query)) reject(new Error(`search failed for ${query}`));
        else resolve(this.ctl.result(query));
      }
    });
  }
  cancel() {
    if (!this.pending) return false;
    const p = this.pending;
    this.pending = null;
    p.reject(Object.assign(new Error("Search cancelled"), { cancelled: true }));
    return true;
  }
  async cancelAndWait() {
    return { wasRunning: this.cancel() };
  }
  cancelNow() {
    this.ctl.nowCalls += 1;
    return this.cancel();
  }
}

function searchResult(query) {
  const cands = [];
  for (let i = 0; i < 7; i += 1) {
    cands.push({
      canonical_title: `${query} ${i}`,
      canonical_year: 2020,
      sources: [{ site: "mangafire", url: `https://mangafire.to/manga/${encodeURIComponent(query)}.${i}`, title: `${query} ${i}`, composite_score: 1 - i / 10, actual_chapter_count: 10 + i, quality_basis: "seed" }],
    });
  }
  return { candidates: cands };
}

/**
 * One app: library, userData, settings, fake electron deps, the service.
 * o.enabled (default true), o.adb (start a fake adb server), o.prewarmDelayMs.
 */
async function app(o = {}) {
  const dir = mkdir(o.tag || "app");
  const a = {
    dir,
    lib: path.join(dir, "lib"),
    userData: path.join(dir, "ud", "sync"),
    events: [],
    handlers: new Map(),
    focusCbs: [],
    focused: o.focused !== false,
    checkAll: false,
    searching: false,
    downloads: [],
    settings: { syncEnabled: o.enabled !== false, cpuLimit: "unlimited", ...(o.settings || {}) },
    search: { mode: "auto", calls: [], nowCalls: 0, result: searchResult, fail: null },
    saved: [],
  };
  fs.mkdirSync(a.lib, { recursive: true });
  if (o.adb) {
    a.srv = new FakeAdbServer();
    a.port = await a.srv.listen();
  }
  a.deps = {
    ipcMain: { handle: (ch, fn) => a.handlers.set(ch, fn) },
    send: (ch, p) => {
      assert.strictEqual(ch, contract.EVENT_CHANNEL);
      a.events.push(p);
    },
    userDataDir: a.userData,
    getSettings: () => a.settings,
    getLibraryRoot: () => a.lib,
    getRunningDownloads: () => a.downloads,
    isCheckAllRunning: () => a.checkAll,
    isSearchRunning: () => a.searching,
    resolveSpawnPaths: () => ({ pythonCmd: "python", scriptPath: "aio-dl.py", workingDir: dir }),
    extraEnv: {},
    onFocus: (cb) => a.focusCbs.push(cb),
    isFocused: () => a.focused,
    getWindow: () => null,
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, "report.json") }),
    _test: {
      clientOpts: { port: a.port || 1, recheckMs: 20, idleMs: 5000, connectTimeoutMs: 500 },
      locateAdb: async () => ({ resolved: null, candidates: [] }),
      ensureServer: async (client) => {
        try {
          return { ok: true, version: await client.version(), started: false };
        } catch (e) {
          return { ok: false, error: e, started: false };
        }
      },
      makeSearcher: () => new FakeSearcher(a.search),
      prewarmDelayMs: o.prewarmDelayMs != null ? o.prewarmDelayMs : 60 * 60 * 1000,
      replanDebounceMs: 30,
      busyPollMs: 40,
      bootEpoch: 1,
      connectWaitMs: 2000,
      timers: {
        setTimeout: (f, ms) => setTimeout(f, Math.max(1, ms / 100)),
        clearTimeout: (t) => clearTimeout(t),
        setInterval: (f, ms) => setInterval(f, Math.max(1, ms / 100)),
        clearInterval: (t) => clearInterval(t),
      },
      executorDeps: o.executorDeps,
      ...(o.test || {}),
    },
  };
  a.svc = service.initDeviceSync(a.deps);
  a.call = (name, payload) => {
    const h = a.handlers.get(`sync:${name}`);
    assert.ok(h, `no handler for sync:${name}`);
    return h({}, payload);
  };
  a.since = () => a.events.length;
  a.waitEvent = (pred, ms = 8000, from = 0, what = "event") => waitFor(() => a.events.slice(from).find(pred), ms, what);
  /** Wait for job runId to end; returns its done event. */
  a.job = (runId, ms = 15000) => a.waitEvent((e) => e.kind === "job" && e.runId === runId && e.state === "done", ms, 0, `job ${runId}`);
  /** Wait until the lane is idle and no auto plan is queued. */
  a.idle = async (ms = 15000) => {
    await waitFor(() => {
      const d = a.svc._debug();
      return !d.current;
    }, ms, "idle lane");
    await sleep(30);
    await waitFor(() => !a.svc._debug().current, ms, "idle lane (2)");
  };
  a.addFolderTarget = async (extra = {}) => {
    a.target = path.join(dir, "device");
    fs.mkdirSync(a.target, { recursive: true });
    const r = await a.call("config-op", { op: "add-target", target: { name: "Folder", kind: "folder", root: a.target, profile: "komikku", ...extra } });
    assert.ok(r.ok, JSON.stringify(r));
    return r.targetId;
  };
  a.plan = async (targetId, overrides) => {
    await a.idle();
    const r = await a.call("plan", { targetId, overrides });
    assert.ok(r.ok, `plan refused: ${JSON.stringify(r)}`);
    const done = await a.job(r.runId);
    return done;
  };
  a.state = () => a.call("get-state");
  a.summary = async (targetId) => (await a.state()).plans[targetId].summary;
  a.close = async () => {
    await a.svc.shutdown({ timeoutMs: 2000 });
    if (a.srv) await a.srv.close();
  };
  return a;
}

function devNames(a, rel) {
  try {
    return fs.readdirSync(rel ? path.join(a.target, rel) : a.target).sort();
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- deps

test("initDeviceSync throws loudly on a missing or mistyped dependency", async () => {
  const a = await app({ enabled: false });
  for (const k of Object.keys(service.DEPS)) {
    const d = { ...a.deps };
    delete d[k];
    assert.throws(() => service.initDeviceSync(d), new RegExp(`missing or mistyped deps: .*${k}`));
  }
  assert.throws(() => service.initDeviceSync({ ...a.deps, getSettings: "nope" }), /getSettings/);
  assert.throws(() => service.initDeviceSync({ ...a.deps, ipcMain: {} }), /ipcMain\.handle/);
});

test("every contract channel gets a handler", async () => {
  const a = await app({ enabled: false });
  assert.deepStrictEqual([...a.handlers.keys()].sort(), Object.values(contract.CHANNELS).sort());
  assert.ok(contract.CHANNEL_NAMES.includes("link"));
});

// ---------------------------------------------------------------- disabled

test("disabled is inert: no socket, no userData/sync, every channel but four answers disabled", async () => {
  const a = await app({ enabled: false, adb: true });
  const st = await a.call("get-state");
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.enabled, false);
  assert.strictEqual(st.config, null);
  for (const name of contract.CHANNEL_NAMES) {
    const r = await a.call(name, { targetId: "x", name: "Ch.001.cbz", folderName: "A" });
    if (contract.CHANNELS_WHILE_DISABLED.has(contract.CHANNELS[name])) {
      assert.strictEqual(r.ok, true, `${name} should work while off: ${JSON.stringify(r)}`);
    } else assertRefusal(r, "disabled");
  }
  const lp = await a.call("label-preview", { name: "Ch.012.cbz", folderName: "A" });
  assert.deepStrictEqual([lp.unit, lp.label], ["chapter", "12"]);
  a.svc.notifyLibraryChanged("download");
  await sleep(100);
  assert.strictEqual(a.srv.log.length, 0, "port 5037 (the fake) was never touched");
  assert.strictEqual(fs.existsSync(a.userData), false, "nothing under userData/sync");
  assert.strictEqual(a.svc.needsQuitAsk(), false);
  assert.strictEqual(a.svc.quitInfo(), null);
  await a.svc.shutdown();
  a.svc.shutdownNow();
  assert.strictEqual(fs.existsSync(a.userData), false, "quit writes nothing either");
  await a.srv.close();
});

test("refusals have one shape; a bad payload is invalid, not a throw", async () => {
  const a = await app();
  try {
    assertRefusal(await a.call("plan", "nope"), "invalid");
    assertRefusal(await a.call("plan", { targetId: "missing" }), "invalid");
    assertRefusal(await a.call("config-op", { op: "explode" }), "invalid");
    assertRefusal(await a.call("series-detail", { targetId: "x", seriesKey: "y" }), "invalid");
    assertRefusal(await a.call("link", { targetId: "x" }), "invalid");
    assertRefusal(await a.call("prompt-response", { promptId: "p", action: "review" }), "invalid");
    assertRefusal(await a.call("browse-remote", { serial: "S", path: "/sdcard/../etc" }), "invalid");
  } finally {
    await a.close();
  }
});

// ---------------------------------------------------------------- facade isolation

test("the facade never throws and never rejects, even when its deps do", async () => {
  const a = await app();
  await a.call("get-state");
  const boom = () => {
    throw new Error("boom");
  };
  a.deps.getSettings = boom;
  a.deps.getRunningDownloads = boom;
  a.deps.isCheckAllRunning = boom;
  a.deps.getLibraryRoot = boom;
  a.deps.send = boom;
  const calls = [
    () => a.svc.applySettings(null),
    () => a.svc.applySettings({ syncEnabled: true, cpuLimit: {} }),
    () => a.svc.notifyLibraryChanged(),
    () => a.svc.needsQuitAsk(),
    () => a.svc.quitInfo(),
    () => a.svc.isJobRunning(),
    () => a.svc.cancelFindSources(),
  ];
  for (const c of calls) {
    let v;
    assert.doesNotThrow(() => {
      v = c();
    });
    if (v && typeof v.then === "function") await v;
  }
  // A handler whose internals throw answers an internal `invalid`.
  const r = await a.call("library-status");
  assertRefusal(r, "invalid");
  assert.strictEqual(r.internal, true);
  await sleep(80);
  await a.svc.shutdown();
  a.svc.shutdownNow();
  a.svc.shutdownNow();
});

// ---------------------------------------------------------------- config ops

test("config ops: validation incl. root containment, versioning, broadcast", async () => {
  const a = await app();
  try {
    const st0 = await a.state();
    assert.strictEqual(st0.config.targets.length, 0);
    const inLib = await a.call("config-op", { op: "add-target", target: { kind: "folder", root: path.join(a.lib, "_mirror"), profile: "komikku" } });
    assertRefusal(inLib, "invalid");
    assert.ok(inLib.errors.some((e) => e.field === "root"));
    const holdsUd = await a.call("config-op", { op: "add-target", target: { kind: "folder", root: a.dir, profile: "komikku" } });
    assertRefusal(holdsUd, "invalid");
    assertRefusal(await a.call("config-op", { op: "add-target", target: { kind: "adb", root: "relative", profile: "komikku", serial: "S" } }), "invalid");
    const id = await a.addFolderTarget();
    const st = await a.state();
    const v = st.config.version;
    assert.ok(a.events.some((e) => e.kind === "config" && e.config.targets.some((t) => t.id === id)));
    assertRefusal(await a.call("config-op", { op: "add-alias", targetId: id, expectVersion: v - 1, alias: { pcFolder: "A", deviceFolder: "A" } }), "version-conflict");
    const ok = await a.call("config-op", { op: "add-alias", targetId: id, expectVersion: v, alias: { pcFolder: "A", deviceFolder: "A dev" } });
    assert.ok(ok.ok);
    assert.strictEqual(ok.config.version, v + 1);
    assert.deepStrictEqual(ok.config.targets[0].aliases, [{ pcFolder: "A", deviceFolder: "A dev" }]);
    assertRefusal(await a.call("config-op", { op: "add-alias", targetId: id, alias: { pcFolder: "A", deviceFolder: "a/b" } }), "invalid");
    assertRefusal(await a.call("config-op", { op: "update-target", targetId: id, patch: { cleanupNames: ["cover.jpg"] } }), "invalid");
    const onDisk = JSON.parse(fs.readFileSync(path.join(a.userData, "sync-targets.json"), "utf8"));
    assert.strictEqual(onDisk.version, v + 1);
    assert.strictEqual(onDisk.targets[0].aliases.length, 1);
    assert.ok((await a.call("config-op", { op: "remove-alias", targetId: id, index: 0 })).ok);
    assert.ok((await a.call("config-op", { op: "ignore-suggestion", targetId: id, suggestionId: "link:x=>y" })).ok);
    assert.ok((await a.call("config-op", { op: "set-selection-mode", targetId: id, mode: "only", only: [{ pcFolder: "A" }] })).ok);
    assertRefusal(await a.call("config-op", { op: "set-selection-mode", targetId: id, mode: "some" }), "invalid");
  } finally {
    await a.close();
  }
});

// ---------------------------------------------------------------- main flow

test("main flow on a folder target: connect prompt → plan → apply → PC edits → both delete policies → verify → prune → library unplugged", async () => {
  const a = await app();
  try {
    series(a.lib, "Alpha", { "Ch.001.cbz": 3000, "Ch.002.cbz": 3100, "cover.jpg": 500 });
    series(a.lib, "Beta", { "Ch.001.cbz": 2000 });
    const id = await a.addFolderTarget();
    // The watcher sees the folder → automatic plan → prompt (focused).
    const shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "connect prompt");
    assert.deepStrictEqual(shown.prompt.targetIds, [id]);
    assert.strictEqual(shown.prompt.card.targets[0].firstSync, true);
    assert.strictEqual(shown.prompt.card.syncNow, false, "a first sync is never one click");
    assert.ok((await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "review" })).ok);
    await a.idle();
    let sum = await a.summary(id);
    assert.strictEqual(sum.totals.push.count, 4);
    // Deselect Beta's push, apply: Beta stays off the device.
    const det = await a.call("series-detail", { targetId: id, seriesKey: sum.series.find((s) => s.folder === "Beta").seriesKey });
    const betaPush = det.rows.find((r) => r.opId && r.opId.startsWith("push:"));
    const sel = await a.call("set-selection", { targetId: id, changes: [{ opId: betaPush.opId, selected: false }] });
    assert.ok(sel.ok);
    assert.strictEqual(sel.totals.push.count, 3);
    const ap = await a.call("apply", { targetId: id });
    assert.ok(ap.ok, JSON.stringify(ap));
    const done = await a.job(ap.runId);
    assert.strictEqual(done.status, "completed", JSON.stringify(done.summary));
    assert.deepStrictEqual(devNames(a, "Alpha"), ["Ch.001.cbz", "Ch.002.cbz", "cover.jpg"]);
    assert.strictEqual(devNames(a, "Beta"), null);
    assert.ok(devNames(a).includes(".nomedia"));
    await a.idle();
    // Library status: Alpha synced, Beta absent.
    const ls = await a.call("library-status");
    assert.strictEqual(ls.bySeries[path.join(a.lib, "Alpha")][0].state, "synced");
    assert.strictEqual(ls.bySeries[path.join(a.lib, "Beta")][0].state, "absent");

    // PC edits: change Ch.001, rename the series folder, rename Ch.002 (a covered extra).
    const oldDir = path.join(a.lib, "Alpha");
    writeOld(path.join(oldDir, "Ch.001.cbz"), bytes("Ch.001.cbz", 3000, 2), OLD_S + 10);
    // A new release of Ch.002 under another name (other bytes: identical
    // bytes would be satisfied under the kept device name, rule 4).
    fs.rmSync(path.join(oldDir, "Ch.002.cbz"));
    writeOld(path.join(oldDir, "Ch.002 (v2).cbz"), bytes("Ch.002 (v2).cbz", 3200));
    fs.renameSync(oldDir, path.join(a.lib, "Alpha Renamed"));
    a.svc.notifyLibraryChanged("scan");
    await sleep(80);
    await a.idle();
    let plan = await a.plan(id);
    assert.strictEqual(plan.status, "completed", JSON.stringify(plan.summary));
    sum = plan.summary.plan;
    const alpha = sum.series.find((s) => s.folder === "Alpha Renamed");
    assert.strictEqual(alpha.deviceFolder, "Alpha", "a bound folder keeps its name (rule 1)");
    const det2 = await a.call("series-detail", { targetId: id, seriesKey: alpha.seriesKey });
    const kinds = det2.rows.filter((r) => r.opId).map((r) => `${r.opId.split(":")[0]}:${r.preselected}`);
    assert.ok(kinds.includes("update:true"), `update pre-selected: ${kinds}`);
    assert.ok(kinds.includes("push:true"));
    assert.ok(kinds.includes("delete:true"), `guarded: the covered old Ch.002 delete is pre-selected: ${kinds}`);
    // add-only pre-selects no delete.
    const addOnly = await a.plan(id, { deletePolicy: "add-only" });
    const det3 = await a.call("series-detail", { targetId: id, seriesKey: alpha.seriesKey });
    assert.ok(!det3.rows.some((r) => r.opId && r.opId.startsWith("delete:") && r.preselected), "add-only");
    assert.ok(addOnly.summary.plan.totals.update.count === 1);
    // Back to guarded and apply.
    await a.plan(id);
    const ap2 = await a.call("apply", { targetId: id });
    assert.ok(ap2.ok, JSON.stringify(ap2));
    const d2 = await a.job(ap2.runId);
    assert.strictEqual(d2.status, "completed", JSON.stringify(d2.summary));
    assert.deepStrictEqual(devNames(a, "Alpha"), ["Ch.001.cbz", "Ch.002 (v2).cbz", "cover.jpg"]);
    assert.ok(fs.readFileSync(path.join(a.target, "Alpha", "Ch.001.cbz")).equals(bytes("Ch.001.cbz", 3000, 2)));
    await a.idle();

    // Verify.
    const vr = await a.call("verify", { targetId: id });
    assert.ok(vr.ok, JSON.stringify(vr));
    const vd = await a.job(vr.runId);
    assert.strictEqual(vd.status, "completed", JSON.stringify(vd.summary));
    assert.ok(vd.summary.folders.every((f) => f.outcome === "verified"), JSON.stringify(vd.summary.folders));

    // Delete the series on the PC: its device folder becomes orphaned → prune.
    fs.rmSync(path.join(a.lib, "Alpha Renamed"), { recursive: true });
    await a.idle();
    plan = await a.plan(id);
    const orphan = plan.summary.plan.deviceOnly.find((d) => d.name === "Alpha");
    assert.strictEqual(orphan.state, "orphaned");
    fs.writeFileSync(path.join(a.target, "Alpha", "notes.txt"), "mine");
    const pr = await a.call("prune", { targetId: id });
    assert.ok(pr.ok);
    const pd = await a.job(pr.runId);
    assert.strictEqual(pd.status, "completed");
    assert.deepStrictEqual(devNames(a, "Alpha"), ["notes.txt"], "files of ours deleted; the foreign one is a leftover");
    assert.deepStrictEqual(pd.summary.prune[0].leftovers, ["notes.txt"]);

    // Library root unplugged: refused before any device or record write.
    await a.idle();
    fs.renameSync(a.lib, `${a.lib}.gone`);
    assertRefusal(await a.call("plan", { targetId: id }), "library-missing");
    fs.renameSync(`${a.lib}.gone`, a.lib);
    const report = await a.call("export-report", { targetId: id });
    assert.ok(report.ok);
    assert.ok(JSON.parse(fs.readFileSync(report.path, "utf8")).summary.targetId === id);
  } finally {
    await a.close();
  }
});

test("a device refusal ends the plan job `failed` with summary.refusal, and get-state keeps it", async () => {
  const a = await app();
  try {
    series(a.lib, "Alpha", { "Ch.001.cbz": 3000 });
    const id = await a.addFolderTarget();
    await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "connect prompt");
    await a.idle();
    const ap = await a.call("apply", { targetId: id });
    assert.ok(ap.ok, JSON.stringify(ap));
    assert.strictEqual((await a.job(ap.runId)).status, "completed");
    await a.idle();
    // The device root empties while the record manages a folder.
    for (const n of fs.readdirSync(a.target)) fs.rmSync(path.join(a.target, n), { recursive: true, force: true });
    const r = await a.call("plan", { targetId: id });
    assert.ok(r.ok, "the invoke answers {ok, runId}; the device refusal comes at the end");
    const done = await a.job(r.runId);
    assert.strictEqual(done.status, "failed");
    assert.strictEqual(done.summary.refusal.ok, false);
    assert.strictEqual(done.summary.refusal.code, "device-listing-suspect", JSON.stringify(done.summary));
    const st = await a.state();
    assert.strictEqual(st.plans[id].refusal.code, "device-listing-suspect");
    assert.strictEqual(st.plans[id].summary, null);
    // The folder comes back: the next plan clears the refusal.
    series(a.target, "Alpha", { "Ch.001.cbz": 3000 });
    const ok = await a.plan(id);
    assert.strictEqual(ok.status, "completed", JSON.stringify(ok.summary));
    assert.strictEqual((await a.state()).plans[id].refusal, null);
  } finally {
    await a.close();
  }
});

test("apply re-checks: an unacknowledged loss blocks with the one refusal shape", async () => {
  const a = await app();
  try {
    series(a.lib, "Gamma", { "Ch.001.cbz": 1000, "Ch.002.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    let done = await a.job((await a.call("apply", { targetId: id })).runId);
    assert.strictEqual(done.status, "completed");
    // Ch.002 disappears from the PC and its device copy is selected for delete → loss.
    fs.rmSync(path.join(a.lib, "Gamma", "Ch.002.cbz"));
    await a.idle();
    const plan = await a.plan(id);
    const s = plan.summary.plan.series[0];
    const det = await a.call("series-detail", { targetId: id, seriesKey: s.seriesKey });
    const del = det.rows.find((r) => r.opId && r.opId.startsWith("delete:"));
    assert.strictEqual(del.preselected, false, "an uncovered chapter is never pre-selected");
    const sel = await a.call("set-selection", { targetId: id, changes: [{ opId: del.opId, selected: true }] });
    assert.deepStrictEqual(sel.losses, [del.opId]);
    const r = await a.call("apply", { targetId: id });
    assertRefusal(r, "blocked");
    assert.strictEqual(r.blocking[0].kind, "loss");
    const ok = await a.call("apply", { targetId: id, ackLosses: [del.opId] });
    assert.ok(ok.ok);
    done = await a.job(ok.runId);
    assert.strictEqual(done.status, "completed");
    assert.deepStrictEqual(devNames(a, "Gamma"), ["Ch.001.cbz"]);
  } finally {
    await a.close();
  }
});

// ---------------------------------------------------------------- jobs while running

function gate() {
  let open;
  const g = { hits: 0 };
  g.wait = new Promise((r) => (open = r));
  g.open = open;
  g.reached = new Promise((r) => (g._hit = r));
  return g;
}

test("rename-device-folder runs as a `rename` job in the quit-ask set; identity ops and link are busy meanwhile", async () => {
  const g = gate();
  const a = await app({ executorDeps: { hooks: (pt) => (pt === "rename-before-mv" ? (g._hit(), g.wait) : undefined) } });
  try {
    series(a.lib, "Delta", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const ap = await a.call("apply", { targetId: id });
    assert.strictEqual((await a.job(ap.runId)).status, "completed");
    await a.idle();
    const st = await a.state();
    const sk = st.plans[id].summary.series[0].seriesKey;
    const r = await a.call("rename-device-folder", { targetId: id, seriesKey: sk, to: "Delta (new)" });
    assert.ok(r.ok, JSON.stringify(r));
    await g.reached;
    assert.strictEqual(a.svc.needsQuitAsk(), true);
    const qi = a.svc.quitInfo();
    assert.deepStrictEqual([qi.target, qi.phase], ["Folder", "rename"]);
    assert.strictEqual(a.svc.isJobRunning(), true);
    assertRefusal(await a.call("config-op", { op: "forget-record", targetId: id }), "busy");
    assertRefusal(await a.call("config-op", { op: "update-target", targetId: id, patch: { root: path.join(a.dir, "elsewhere") } }), "busy");
    assertRefusal(await a.call("link", { targetId: id, suggestionIds: ["x"] }), "busy");
    assertRefusal(await a.call("plan", { targetId: id }), "busy");
    assert.ok((await a.call("config-op", { op: "add-exclude", targetId: id, entry: { pcFolder: "Zeta" } })).ok, "non-identity edits are accepted");
    g.open();
    const d = await a.job(r.runId);
    assert.strictEqual(d.status, "completed", JSON.stringify(d.summary));
    assert.deepStrictEqual(devNames(a).filter((n) => !n.startsWith(".")), ["Delta (new)"]);
    assert.strictEqual(a.svc.needsQuitAsk(), false);
  } finally {
    await a.close();
  }
});

test("a plan or verify is not in the quit-ask set", async () => {
  const a = await app();
  try {
    series(a.lib, "Eps", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    for (const ch of ["plan", "verify"]) {
      const r = await a.call(ch, { targetId: id });
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(a.svc.isJobRunning(), true, `${ch} runs`);
      assert.strictEqual(a.svc.needsQuitAsk(), false, `${ch} is cancelled on quit, not asked about`);
      await a.job(r.runId);
      await a.idle();
    }
  } finally {
    await a.close();
  }
});

test("turning sync off mid-job cancels the job and find-sources first; both cancels still answer while off", async () => {
  const g = gate();
  let a = null;
  // Held at the first SEND until the job's own signal aborts (a real push
  // observes the signal through its socket).
  const held = () =>
    new Promise((r) => {
      g._hit();
      const sig = a.svc._debug().current.signal;
      if (sig.aborted) return r();
      sig.addEventListener("abort", () => r(), { once: true });
    });
  a = await app({ executorDeps: { hooks: (pt) => (pt === "before-send" ? held() : undefined) } });
  try {
    series(a.lib, "Zeta", { "Ch.001.cbz": 1000 });
    fs.mkdirSync(path.join(a.dir, "device", "Orphan Old"), { recursive: true });
    fs.writeFileSync(path.join(a.dir, "device", "Orphan Old", "x.cbz"), "x");
    const id = await a.addFolderTarget();
    await a.idle();
    a.search.mode = "hold";
    const fsr = await a.call("find-sources:start", { targetId: id });
    assert.ok(fsr.ok && fsr.started, JSON.stringify(fsr));
    await waitFor(() => a.search.calls.length === 1, 3000, "search started");
    // A held job: the apply's executor waits in a hook we never open... use cancel path instead.
    const ap = await a.call("apply", { targetId: id });
    assert.ok(ap.ok);
    await g.reached;
    a.settings = { ...a.settings, syncEnabled: false };
    const t0 = Date.now();
    await a.svc.applySettings(a.settings);
    assert.ok(Date.now() - t0 < 5500, "stop waits ≤ 5 s");
    const d = await a.job(ap.runId);
    assert.strictEqual(d.status, "cancelled");
    assert.ok(a.events.some((e) => e.kind === "find" && e.state === "cancelled"), "find-sources cancelled");
    assert.strictEqual((await a.call("cancel")).ok, true);
    assert.strictEqual((await a.call("find-sources:cancel")).ok, true);
    assertRefusal(await a.call("plan", { targetId: id }), "disabled");
    assert.strictEqual((await a.call("get-state")).enabled, false);
    g.open();
  } finally {
    await a.close();
  }
});

// ---------------------------------------------------------------- quit

test("quit: shutdown() finishes within 5 s with a job held; shutdownNow is synchronous, idempotent and flushes the hash cache", async () => {
  const g = gate();
  const a = await app({ executorDeps: { hooks: (pt) => (pt === "rename-before-mv" ? (g._hit(), new Promise(() => {})) : undefined) } });
  series(a.lib, "Eta", { "Ch.001.cbz": 1000 });
  const id = await a.addFolderTarget();
  await a.idle();
  assert.strictEqual((await a.job((await a.call("apply", { targetId: id })).runId)).status, "completed");
  await a.idle();
  const sk = (await a.state()).plans[id].summary.series[0].seriesKey;
  const r = await a.call("rename-device-folder", { targetId: id, seriesKey: sk, to: "Eta 2" });
  await g.reached;
  const t0 = Date.now();
  await a.svc.shutdown({ timeoutMs: 5000 });
  const dt = Date.now() - t0;
  assert.ok(dt < 5600, `shutdown took ${dt} ms`);
  assert.ok(fs.existsSync(path.join(a.userData, "pc-hash-cache.json")), "hash cache flushed");
  // The held rename's intent is in the shard: the record stays recoverable.
  const shards = fs.readdirSync(path.join(a.userData, "targets", id, "folders"));
  const body = JSON.parse(fs.readFileSync(path.join(a.userData, "targets", id, "folders", shards[0]), "utf8"));
  assert.strictEqual(body.renameIntent.to, "Eta 2");
  a.svc.shutdownNow();
  a.svc.shutdownNow();
  assertRefusal(await a.call("get-state"), "disabled");
  void r;
});

test("shutdownNow mid-run: synchronous, kills find-sources' search, leaves whole JSON files", async () => {
  const a = await app();
  series(a.lib, "Theta", { "Ch.001.cbz": 1000 });
  fs.mkdirSync(path.join(a.dir, "device", "Old One"), { recursive: true });
  fs.writeFileSync(path.join(a.dir, "device", "Old One", "a.cbz"), "a");
  const id = await a.addFolderTarget();
  await a.idle();
  a.search.mode = "hold";
  await a.call("find-sources:start", { targetId: id });
  await waitFor(() => a.search.calls.length === 1, 3000, "search");
  const t0 = Date.now();
  a.svc.shutdownNow();
  assert.ok(Date.now() - t0 < 200, "synchronous");
  assert.strictEqual(a.search.nowCalls, 1, "the search got the synchronous tree kill");
  a.svc.shutdownNow();
  assert.strictEqual(a.search.nowCalls, 1, "idempotent");
  await sleep(100);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(a.userData)) {
    if (f.endsWith(".json")) JSON.parse(fs.readFileSync(f, "utf8"));
  }
});

// ---------------------------------------------------------------- find-sources

test("find-sources: top 5 per row, waits while Check All runs, edited query re-queues, rows persist", async () => {
  const a = await app();
  try {
    series(a.lib, "Iota", { "Ch.001.cbz": 1000 });
    for (const n of ["Kappa_(hid=abc)", "Lambda"]) {
      fs.mkdirSync(path.join(a.dir, "device", n), { recursive: true });
      fs.writeFileSync(path.join(a.dir, "device", n, "Ch.001.cbz"), "x");
    }
    const id = await a.addFolderTarget();
    await a.idle();
    a.checkAll = true;
    a.search.fail = /Lambda/;
    const r = await a.call("find-sources:start", { targetId: id });
    assert.ok(r.ok && r.started);
    await a.waitEvent((e) => e.kind === "find" && e.state === "waiting" && e.waiting === "check-all", 3000, 0, "waiting");
    assert.strictEqual(a.search.calls.length, 0);
    a.checkAll = false;
    await a.waitEvent((e) => e.kind === "find" && e.state === "done", 8000, 0, "done");
    assert.deepStrictEqual(a.search.calls.sort(), ["Kappa", "Lambda"]);
    let got = await a.call("find-sources:get", { targetId: id });
    const kappa = got.rows.find((x) => x.folder === "Kappa_(hid=abc)");
    const lambda = got.rows.find((x) => x.folder === "Lambda");
    assert.strictEqual(kappa.state, "done");
    assert.strictEqual(kappa.candidates.length, 5);
    assert.strictEqual(kappa.candidates[0].best.site, "mangafire");
    assert.strictEqual(kappa.pick, 0);
    assert.strictEqual(lambda.state, "error");
    // Retry with an edited query; the done row isn't searched again.
    a.search.fail = null;
    const up = await a.call("find-sources:update-row", { targetId: id, folder: "Lambda", patch: { query: "Lambda Official" } });
    assert.strictEqual(up.row.state, "queued");
    assertRefusal(await a.call("find-sources:update-row", { targetId: id, folder: "Lambda", patch: { pinnedUrl: "javascript:x" } }), "invalid");
    assertRefusal(await a.call("find-sources:update-row", { targetId: id, folder: "Lambda", patch: { state: "done" } }), "invalid");
    const from = a.since();
    await a.call("find-sources:start", { targetId: id });
    await a.waitEvent((e) => e.kind === "find" && e.state === "done", 8000, from, "done 2");
    assert.deepStrictEqual(a.search.calls.slice(2), ["Lambda Official"]);
    const file = JSON.parse(fs.readFileSync(path.join(a.userData, "targets", id, "find-sources.json"), "utf8"));
    assert.strictEqual(file.rows.length, 2);
    assert.ok(file.rows.every((x) => x.state === "done"));
    got = await a.call("find-sources:get", { targetId: id });
    assert.strictEqual(got.running, false);
  } finally {
    await a.close();
  }
});

// ---------------------------------------------------------------- adb flow

async function adbApp(o = {}) {
  const a = await app({ adb: true, ...o });
  a.dev = a.srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" } } });
  a.dev.fs.mkdirs(CANON);
  return a;
}

test("adb: attached device → automatic plan → prompt; list/browse; Link a content match; unplug withdraws", async () => {
  const a = await adbApp({ focused: false });
  try {
    series(a.lib, "Mu", { "Ch.001.cbz": 1500, "Ch.002.cbz": 1500 });
    series(a.lib, "Nu", { "Ch.001.cbz": 1200 });
    // The tablet already holds Mu under another name (an old sync).
    for (const n of ["Ch.001.cbz", "Ch.002.cbz"]) a.dev.fs.writeFile(`${CANON}/Mu Old Name/${n}`, bytes(n, 1500), { mtime: OLD_S });
    a.dev.fs.mkdirs(`${CANON}/Mu Old Name`);
    for (const n of ["Ch.001.cbz", "Ch.002.cbz"]) a.dev.fs.writeFile(`${CANON}/Mu Old Name/${n}`, bytes(n, 1500), { mtime: OLD_S });
    const ld = await a.call("list-devices");
    assert.ok(ld.ok, JSON.stringify(ld));
    assert.deepStrictEqual(ld.devices.map((d) => d.serial), [SERIAL]);
    const br = await a.call("browse-remote", { serial: SERIAL, path: "/sdcard/Komikku" });
    assert.ok(br.ok, JSON.stringify(br));
    assert.strictEqual(br.path, "/storage/emulated/0/Komikku");
    assert.deepStrictEqual(br.entries.map((e) => e.name), ["local"]);
    assert.ok(br.presets.find((p) => p.path === "/sdcard/Komikku/local").exists);
    const r = await a.call("config-op", { op: "add-target", target: { name: "Tab", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    assert.ok(r.ok, JSON.stringify(r));
    const id = r.targetId;
    // Unfocused: the plan runs, the prompt waits for focus.
    await waitFor(() => a.events.some((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan" && e.job.auto), 15000, "auto plan");
    await sleep(50);
    assert.ok(!a.events.some((e) => e.kind === "prompt" && e.action === "show"));
    a.focused = true;
    for (const cb of a.focusCbs) cb();
    const shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 3000, 0, "prompt on focus");
    assert.strictEqual(shown.prompt.serial, SERIAL);
    const st = await a.state();
    assert.strictEqual(st.prompt.promptId, shown.prompt.promptId);
    const sum = st.plans[id].summary;
    const mu = sum.series.find((s) => s.folder === "Mu");
    assert.strictEqual(mu.state, "new");
    assert.strictEqual(mu.suggestions, 1, "a content match is suggested");
    const det = await a.call("series-detail", { targetId: id, seriesKey: mu.seriesKey });
    const sug = det.suggestions[0];
    assert.strictEqual(sug.tier, "content");
    assert.ok(det.rows.filter((x) => x.opId && x.opId.startsWith("push:")).every((x) => !x.preselected), "a strong match unticks the pushes");
    assert.ok((await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "not-now" })).ok);
    // Link: binds, then the queued re-plan verifies the folder and finds it in sync.
    const from = a.since();
    const lk = await a.call("link", { targetId: id, suggestionIds: [sug.id] });
    assert.ok(lk.ok, JSON.stringify(lk));
    assert.strictEqual(lk.linked[0].deviceFolder, "Mu Old Name");
    await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan", 15000, from, "re-plan after link");
    await a.idle();
    const after = (await a.summary(id)).series.find((s) => s.folder === "Mu");
    assert.strictEqual(after.deviceFolder, "Mu Old Name");
    assert.strictEqual(after.counts.push || 0, 0, JSON.stringify(after.counts));
    assert.strictEqual(after.counts.inSync, 2, JSON.stringify(after.counts));
    // Apply pushes Nu; then unplug withdraws nothing open, and a re-plug prompts again.
    const ap = await a.call("apply", { targetId: id });
    assert.ok(ap.ok, JSON.stringify(ap));
    const d = await a.job(ap.runId);
    assert.strictEqual(d.status, "completed", JSON.stringify(d.summary));
    assert.ok(a.dev.fs.names(`${CANON}/Nu`).includes("Ch.001.cbz"));
    await a.idle();
    const from2 = a.since();
    await a.srv.unplug(SERIAL, { order: "eof-first" });
    await a.waitEvent((e) => e.kind === "device" && !e.devices.some((x) => x.serial === SERIAL), 3000, from2, "unplug seen");
    assertRefusal(await a.call("plan", { targetId: id }), "disconnected");
    writeOld(path.join(a.lib, "Nu", "Ch.002.cbz"), bytes("Nu Ch.002.cbz", 1300));
    a.srv.replug(a.dev);
    const again = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, from2, "re-plug prompt");
    assert.notStrictEqual(again.prompt.promptId, shown.prompt.promptId);
  } finally {
    await a.close();
  }
});

test("adb: an unplug while a prompt is shown withdraws it", async () => {
  const a = await adbApp();
  try {
    series(a.lib, "Xi", { "Ch.001.cbz": 1000 });
    await a.call("config-op", { op: "add-target", target: { name: "Tab", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    const shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "prompt");
    await a.srv.unplug(SERIAL, { order: "frame-first" });
    const w = await a.waitEvent((e) => e.kind === "prompt" && e.action === "withdraw", 3000, 0, "withdraw");
    assert.strictEqual(w.prompt.promptId, shown.prompt.promptId);
    assert.strictEqual((await a.state()).prompt, null);
  } finally {
    await a.close();
  }
});

test("sync-now from the prompt applies an eligible target in one click", async () => {
  const a = await app();
  try {
    series(a.lib, "Omi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    let shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "prompt");
    await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "review" });
    await a.idle();
    assert.strictEqual((await a.job((await a.call("apply", { targetId: id })).runId)).status, "completed");
    await a.idle();
    // A new chapter, then the folder reconnects: the prompt offers Sync now.
    writeOld(path.join(a.lib, "Omi", "Ch.002.cbz"), bytes("Ch.002.cbz", 1000));
    const tgt = a.target;
    fs.renameSync(tgt, `${tgt}.off`);
    await waitFor(() => a.events.some((e) => e.kind === "device" && e.folderPresence[id] === false), 3000, "folder gone");
    const from = a.since();
    fs.renameSync(`${tgt}.off`, tgt);
    shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, from, "second prompt");
    assert.strictEqual(shown.prompt.card.syncNow, true, JSON.stringify(shown.prompt.card));
    assert.ok((await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "sync-now" })).ok);
    await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "apply", 15000, from, "sync-now apply");
    assert.deepStrictEqual(devNames(a, "Omi"), ["Ch.001.cbz", "Ch.002.cbz"]);
  } finally {
    await a.close();
  }
});

// ---------------------------------------------------------------- pre-warm, forget

test("pre-warm hashes what targets mirror, pauses while a download runs, then finishes", async () => {
  const a = await app({ prewarmDelayMs: 0 });
  try {
    series(a.lib, "Pi", { "Ch.001.cbz": 2000, "Ch.002.cbz": 2000, "notes.txt": 10 });
    a.downloads = [{ downloadId: "d1" }];
    await a.addFolderTarget();
    await a.waitEvent((e) => e.kind === "prewarm" && e.prewarm.state === "paused" && e.prewarm.reason === "download", 5000, 0, "paused");
    a.downloads = [];
    const done = await a.waitEvent((e) => e.kind === "prewarm" && e.prewarm.state === "done", 8000, 0, "prewarm done");
    assert.strictEqual(done.prewarm.total, 2, "only mirrored files (two chapters)");
    await a.svc.shutdown();
    const cache = JSON.parse(fs.readFileSync(path.join(a.userData, "pc-hash-cache.json"), "utf8"));
    assert.strictEqual(Object.keys(cache.entries).length >= 2, true);
  } finally {
    await a.close();
  }
});

test("forget-record clears through a new epoch; the next plan is a first sync again", async () => {
  const a = await app();
  try {
    series(a.lib, "Rho", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    assert.strictEqual((await a.job((await a.call("apply", { targetId: id })).runId)).status, "completed");
    await a.idle();
    const before = JSON.parse(fs.readFileSync(path.join(a.userData, "targets", id, "header.json"), "utf8"));
    assert.ok((await a.call("config-op", { op: "forget-record", targetId: id })).ok);
    const after = JSON.parse(fs.readFileSync(path.join(a.userData, "targets", id, "header.json"), "utf8"));
    assert.notStrictEqual(after.recordEpoch, before.recordEpoch);
    assert.strictEqual(after.firstApplyAt, undefined);
    await a.idle();
    const p = await a.plan(id);
    assert.strictEqual(p.summary.plan.firstSync, true);
    const hdr = JSON.parse(fs.readFileSync(path.join(a.userData, "targets", id, "header.json"), "utf8"));
    assert.ok(hdr.canonicalRoot, "the first probe after a clear fills the measured fields");
  } finally {
    await a.close();
  }
});

test("enable at runtime starts the service; applySettings(off) stops the monitor", async () => {
  const a = await app({ enabled: false });
  try {
    assertRefusal(await a.call("plan", { targetId: "x" }), "disabled");
    a.settings = { ...a.settings, syncEnabled: true };
    await a.svc.applySettings(a.settings);
    const st = await a.state();
    assert.strictEqual(st.enabled, true);
    assert.ok(fs.existsSync(a.userData));
    await a.addFolderTarget();
    a.settings = { ...a.settings, syncEnabled: false };
    await a.svc.applySettings(a.settings);
    assert.strictEqual(a.svc._debug().started, false);
  } finally {
    await a.close();
  }
});

(async () => {
  const only = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
  for (const t of tests) {
    if (only && !only.test(t.name)) continue;
    const started = Date.now();
    try {
      await Promise.race([Promise.resolve().then(t.fn), sleep(60000).then(() => Promise.reject(new Error("test timed out (60 s)")))]);
      passed += 1;
      const dt = Date.now() - started;
      console.log(`  ok   ${t.name}${dt > 1000 ? ` (${dt} ms)` : ""}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL ${t.name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 8).join("\n       ")}`);
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed (node ${process.versions.node})`);
  process.exit(failed ? 1 : 0);
})();
