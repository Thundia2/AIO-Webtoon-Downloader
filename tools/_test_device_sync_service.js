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
  /**
   * apply with the gen the target's current summary carries (the review
   * contract: service.js _genMismatch). The contract itself is tested by
   * calling a.call("apply") directly. One tick first, so a `plans` push
   * already queued has landed.
   */
  a.apply = async (payload) => {
    await new Promise((r) => setImmediate(r));
    const st = await a.state();
    const v = st.plans[payload.targetId];
    return a.call("apply", { gen: v ? v.gen : null, ...payload });
  };
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
    assertRefusal(await a.call("config-op", { op: "update-target", targetId: id, patch: { profile: "custom", cleanupNames: ["cover.jpg"] } }), "invalid");
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
    assert.ok(!("syncNow" in shown.prompt.card), "design D2: the prompt never offers a one-click apply");
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
    const ap = await a.apply({ targetId: id });
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
    // add-only (the target's Removals field, design D5) pre-selects no delete.
    assert.ok((await a.call("config-op", { op: "update-target", targetId: id, patch: { deletePolicy: "add-only" } })).ok);
    const addOnly = await a.plan(id);
    const det3 = await a.call("series-detail", { targetId: id, seriesKey: alpha.seriesKey });
    assert.ok(!det3.rows.some((r) => r.opId && r.opId.startsWith("delete:") && r.preselected), "add-only");
    assert.ok(addOnly.summary.plan.totals.update.count === 1);
    assert.strictEqual(addOnly.summary.plan.policy.deletePolicy, "add-only");
    assert.ok((await a.call("config-op", { op: "update-target", targetId: id, patch: { deletePolicy: "guarded" } })).ok);
    await a.plan(id);
    const ap2 = await a.apply({ targetId: id });
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
    assertRefusal(await a.call("prune", { targetId: id }), "invalid");
    assertRefusal(await a.call("prune", { targetId: id, folders: [] }), "invalid");
    const pr = await a.call("prune", { targetId: id, folders: ["Alpha"] });
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
    const ap = await a.apply({ targetId: id });
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

// ---------------------------------------------------------------- deviation 14

/** This run's device-ready progress events, in order. */
function readyEvents(a, runId, from = 0) {
  return a.events.slice(from).filter((e) => e.kind === "job" && e.runId === runId && e.progress && e.progress.step === "device-ready");
}

test("device-ready: one immediate line per job once the device checks pass, before the listings; a verify's second preparation doesn't repeat it", async () => {
  const a = await app();
  try {
    series(a.lib, "Alpha", { "Ch.001.cbz": 3000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const from = a.since();
    const r = await a.call("plan", { targetId: id });
    assert.ok(r.ok);
    const done = await a.job(r.runId);
    assert.strictEqual(done.status, "completed");
    const ready = readyEvents(a, r.runId, from);
    assert.strictEqual(ready.length, 1, "exactly one device-ready line");
    const pf = ready[0].progress.preflight;
    assert.deepStrictEqual(
      { kind: pf.kind, canHash: pf.canHash, mayNeedMode: pf.mayNeedMode, refusal: pf.refusal },
      { kind: "folder", canHash: true, mayNeedMode: false, refusal: null },
    );
    assert.strictEqual(typeof pf.caseInsensitive, "boolean");
    // Before any later preparation step of this run.
    const runEvents = a.events.slice(from).filter((e) => e.kind === "job" && e.runId === r.runId);
    const at = runEvents.indexOf(ready[0]);
    assert.ok(!runEvents.slice(0, at).some((e) => e.progress && ["planning", "hashing"].includes(e.progress.step)), "nothing past step 6 came first");
    assert.deepStrictEqual(done.job.progress.preflight, pf, "it stays in the job's progress for a re-adopting renderer");
    // Verify prepares twice (before and after verifying): still one line.
    await a.idle();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    await a.idle();
    const from2 = a.since();
    const vr = await a.call("verify", { targetId: id });
    assert.ok(vr.ok, JSON.stringify(vr));
    assert.strictEqual((await a.job(vr.runId)).status, "completed");
    assert.strictEqual(readyEvents(a, vr.runId, from2).length, 1, "verify sends one line");
  } finally {
    await a.close();
  }
});

test("device-ready carries a device refusal at once; the job still ends failed with summary.refusal", async () => {
  const a = await app();
  try {
    series(a.lib, "Alpha", { "Ch.001.cbz": 3000 });
    const id = await a.addFolderTarget();
    await a.idle();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    await a.idle();
    for (const n of fs.readdirSync(a.target)) fs.rmSync(path.join(a.target, n), { recursive: true, force: true });
    const from = a.since();
    const r = await a.call("plan", { targetId: id });
    const done = await a.job(r.runId);
    assert.strictEqual(done.status, "failed");
    const ready = readyEvents(a, r.runId, from);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].progress.preflight.refusal.code, "device-listing-suspect");
    assert.ok(a.events.indexOf(ready[0]) < a.events.indexOf(done), "the line precedes the job end");
    assert.strictEqual(done.summary.refusal.code, "device-listing-suspect");
  } finally {
    await a.close();
  }
});

test("device-ready on a device without sha256sum flags mayNeedMode", async () => {
  const a = await app({ adb: true });
  try {
    a.dev = a.srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" }, tools: { sha256sum: false } } });
    a.dev.fs.mkdirs(CANON);
    a.dev.fs.writeFile(`${CANON}/Old/Ch.001.cbz`, bytes("Ch.001.cbz", 900), { mtime: OLD_S });
    series(a.lib, "Mu", { "Ch.001.cbz": 1500 });
    const t = await a.call("config-op", { op: "add-target", target: { name: "Tab", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    assert.ok(t.ok, JSON.stringify(t));
    const auto = await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan", 15000, 0, "auto plan");
    const pf = readyEvents(a, auto.runId)[0].progress.preflight;
    assert.deepStrictEqual({ kind: pf.kind, canHash: pf.canHash, mayNeedMode: pf.mayNeedMode, sha: pf.caps.sha256sum }, { kind: "adb", canHash: false, mayNeedMode: true, sha: false });
  } finally {
    await a.close();
  }
});

test("selection persists on a never-applied target: the first change writes the header, survives a restart, keeps first sync", async () => {
  const a = await app();
  try {
    series(a.lib, "Alpha", { "Ch.001.cbz": 3000 });
    series(a.lib, "Beta", { "Ch.001.cbz": 2000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const tdir = path.join(a.userData, "targets", id);
    assert.ok(!fs.existsSync(path.join(tdir, "header.json")), "a plan alone writes no header");
    const sum = await a.summary(id);
    const det = await a.call("series-detail", { targetId: id, seriesKey: sum.series.find((s) => s.folder === "Beta").seriesKey });
    const betaPush = det.rows.find((r) => r.opId && r.opId.startsWith("push:"));
    assert.ok((await a.call("set-selection", { targetId: id, changes: [{ opId: betaPush.opId, selected: false }] })).ok);
    await waitFor(() => fs.existsSync(path.join(tdir, "selection.json")), 3000, "selection.json");
    const header = JSON.parse(fs.readFileSync(path.join(tdir, "header.json"), "utf8"));
    const sel = JSON.parse(fs.readFileSync(path.join(tdir, "selection.json"), "utf8"));
    assert.strictEqual(sel.recordEpoch, header.recordEpoch);
    assert.ok(!header.firstApplyAt, "no apply happened");
    // Restart the service on the same userData: the choice is still there.
    await a.svc.shutdown({ timeoutMs: 2000 });
    a.svc = service.initDeviceSync(a.deps);
    await a.idle();
    // runIds restart at 1 in the new service: only look at its own events.
    const from = a.since();
    const r = await a.call("plan", { targetId: id });
    assert.ok(r.ok, JSON.stringify(r));
    const plan = await a.waitEvent((e) => e.kind === "job" && e.runId === r.runId && e.state === "done", 15000, from, "plan after restart");
    assert.strictEqual(plan.status, "completed", JSON.stringify(plan.summary));
    assert.strictEqual(plan.summary.plan.firstSync, true, "still a first sync");
    assert.strictEqual(plan.summary.plan.totals.push.count, 1, "Beta's push stays unticked");
  } finally {
    await a.close();
  }
});

test("selection on a header-less target while its job runs is written when the job ends", async () => {
  const a = await app({ adb: true });
  try {
    a.dev = a.srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" } } });
    a.dev.fs.mkdirs(CANON);
    series(a.lib, "Mu", { "Ch.001.cbz": 1500 });
    series(a.lib, "Nu", { "Ch.001.cbz": 1200 });
    const t = await a.call("config-op", { op: "add-target", target: { name: "Tab", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    const id = t.targetId;
    await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan", 15000, 0, "auto plan");
    await a.idle();
    const tdir = path.join(a.userData, "targets", id);
    const sum = await a.summary(id);
    const det = await a.call("series-detail", { targetId: id, seriesKey: sum.series.find((s) => s.folder === "Nu").seriesKey });
    const nuPush = det.rows.find((r) => r.opId && r.opId.startsWith("push:"));
    // Slow the device so the next plan is still running when the selection changes.
    a.dev.inject.shellDelayMs = 150;
    const r = await a.call("plan", { targetId: id });
    assert.ok(r.ok);
    assert.strictEqual(a.svc.isJobRunning(), true);
    assert.ok((await a.call("set-selection", { targetId: id, changes: [{ opId: nuPush.opId, selected: false }] })).ok);
    assert.ok(!fs.existsSync(path.join(tdir, "header.json")), "no header written under a running job");
    await a.job(r.runId);
    a.dev.inject.shellDelayMs = 0;
    await waitFor(() => fs.existsSync(path.join(tdir, "selection.json")), 3000, "deferred selection.json");
    const header = JSON.parse(fs.readFileSync(path.join(tdir, "header.json"), "utf8"));
    const sel = JSON.parse(fs.readFileSync(path.join(tdir, "selection.json"), "utf8"));
    assert.strictEqual(sel.recordEpoch, header.recordEpoch);
    assert.ok(Object.keys(sel.ops).length >= 1, JSON.stringify(sel));
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
    let done = await a.job((await a.apply({ targetId: id })).runId);
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
    const r = await a.apply({ targetId: id });
    assertRefusal(r, "blocked");
    assert.strictEqual(r.blocking[0].kind, "loss");
    const ok = await a.apply({ targetId: id, ackLosses: [del.opId] });
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
    const ap = await a.apply({ targetId: id });
    assert.strictEqual((await a.job(ap.runId)).status, "completed");
    await a.idle();
    const st = await a.state();
    const sk = st.plans[id].summary.series[0].seriesKey;
    const r = await a.call("rename-device-folder", { targetId: id, seriesKey: sk, to: "Delta (new)" });
    assert.ok(r.ok, JSON.stringify(r));
    await g.reached;
    assert.strictEqual(a.svc.needsQuitAsk(), true);
    const qi = a.svc.quitInfo();
    assert.deepStrictEqual([qi.target, qi.phase, qi.unit, qi.done, qi.total], ["Folder", "rename", "folders", 0, 1]);
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
    const ap = await a.apply({ targetId: id });
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
  assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
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

    // U4: rows follow the device-only folders. A folder that appears gets a
    // queued row from get() alone (editable before any search), and a start
    // narrowed to it keeps the other rows.
    for (const n of ["Mu", "Nu"]) {
      fs.mkdirSync(path.join(a.dir, "device", n), { recursive: true });
      fs.writeFileSync(path.join(a.dir, "device", n, "Ch.001.cbz"), "x");
    }
    await a.call("plan", { targetId: id });
    await a.idle();
    got = await a.call("find-sources:get", { targetId: id });
    assert.deepStrictEqual(got.rows.map((x) => [x.folder, x.state]).sort(), [["Kappa_(hid=abc)", "done"], ["Lambda", "done"], ["Mu", "queued"], ["Nu", "queued"]]);
    const skip = await a.call("find-sources:update-row", { targetId: id, folder: "Nu", patch: { skip: true } });
    assert.strictEqual(skip.ok, true, "an unsearched row takes edits");
    const from3 = a.since();
    await a.call("find-sources:start", { targetId: id, folders: ["Mu"] });
    await a.waitEvent((e) => e.kind === "find" && e.state === "done", 8000, from3, "done 3");
    assert.deepStrictEqual(a.search.calls.slice(3), ["Mu"]);
    got = await a.call("find-sources:get", { targetId: id });
    assert.strictEqual(got.rows.length, 4, "a narrowed start keeps every row");
    assert.strictEqual(got.rows.find((x) => x.folder === "Nu").skip, true);
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
    const ap = await a.apply({ targetId: id });
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

// ---------------------------------------------------------------- service log (deviation 15)

const diagLog = require(path.join(SYNC, "diag-log.js"));
function slogLines(a) {
  try {
    return fs
      .readFileSync(path.join(a.userData, "logs", diagLog.FILE), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

test("service log: start (module path, not in asar), pre-warm in workers, clean stop; closed afterwards", async () => {
  const a = await app({ prewarmDelayMs: 0, tag: "slog" });
  series(a.lib, "Rho", { "Ch.001.cbz": 3000, "Ch.002.cbz": 3000 });
  await a.addFolderTarget();
  await a.waitEvent((e) => e.kind === "prewarm" && e.prewarm.state === "done", 8000, 0, "prewarm done");
  await a.idle();
  await a.svc.shutdown({ timeoutMs: 2000 });
  const lines = slogLines(a);
  const evs = lines.map((l) => l.ev);
  assert.strictEqual(evs[0], "start", evs.join(","));
  assert.strictEqual(lines[0].module, path.join(SYNC, "service.js"));
  assert.strictEqual(lines[0].inAsar, false);
  assert.strictEqual(lines[0].node, process.versions.node);
  assert.ok(lines[0].workers >= 1);
  const pw = lines.find((l) => l.ev === "prewarm");
  assert.ok(pw, evs.join(","));
  assert.strictEqual(pw.state, "done");
  assert.strictEqual(pw.files, 2);
  assert.ok(pw.spawned >= 1, JSON.stringify(pw));
  // The connect plan may hash first; the pre-warm's own share is hashed + hits.
  assert.strictEqual(pw.run.hashed + pw.run.hits, 2, JSON.stringify(pw.run));
  assert.strictEqual(pw.run.mainThread, 0, "nothing on the main thread");
  assert.strictEqual(pw.fallback, false);
  const stop = lines[lines.length - 1];
  assert.deepStrictEqual([stop.ev, stop.reason, stop.settled, stop.flushed, stop.hadJob, stop.hadFind], ["stop", "shutdown", true, true, null, false]);
  for (const l of lines) assert.ok(!Number.isNaN(Date.parse(l.t)), l.t);
  // Closed: a later quit adds nothing.
  const n = lines.length;
  a.svc.shutdownNow();
  assert.strictEqual(slogLines(a).length, n);
});

test("service log: a [deviceSync] error line while on lands in the log; nothing while off", async () => {
  const a = await app({ enabled: false, tag: "slog-err" });
  try {
    // Off: an unreadable sync-targets.json is never even read.
    fs.mkdirSync(a.userData, { recursive: true });
    fs.writeFileSync(path.join(a.userData, "sync-targets.json"), "{not json");
    a.svc.notifyLibraryChanged("download");
    await sleep(50);
    assert.strictEqual(fs.existsSync(path.join(a.userData, "logs")), false, "nothing while off");
    a.settings = { ...a.settings, syncEnabled: true };
    await a.svc.applySettings(a.settings);
    const errs = slogLines(a).filter((l) => l.ev === "error");
    assert.strictEqual(errs.length, 1, JSON.stringify(slogLines(a)));
    assert.match(errs[0].text, /^sync-targets\.json unreadable; starting empty:/);
    a.settings = { ...a.settings, syncEnabled: false };
    await a.svc.applySettings(a.settings);
    const last = slogLines(a).pop();
    assert.deepStrictEqual([last.ev, last.reason], ["stop", "disabled"]);
    const n = slogLines(a).length;
    // Off again: facade faults go to stderr only.
    a.svc.notifyLibraryChanged("download");
    await a.call("plan", { targetId: "x" });
    assert.strictEqual(slogLines(a).length, n, "nothing after the stop line");
  } finally {
    await a.close();
  }
});

test("service log: syncDiagnosticLog false writes no file at all, and switching it on mid-run starts logging", async () => {
  const a = await app({ prewarmDelayMs: 0, tag: "slog-off", settings: { syncDiagnosticLog: false } });
  try {
    series(a.lib, "Sigma", { "Ch.001.cbz": 1000 });
    await a.addFolderTarget();
    await a.waitEvent((e) => e.kind === "prewarm" && e.prewarm.state === "done", 8000, 0, "prewarm done");
    assert.ok(fs.existsSync(a.userData), "sync itself runs");
    assert.strictEqual(fs.existsSync(path.join(a.userData, "logs")), false, "no log dir");
    a.settings = { ...a.settings, syncDiagnosticLog: true };
    await a.svc.applySettings(a.settings);
    await a.svc.shutdown({ timeoutMs: 2000 });
    assert.deepStrictEqual(slogLines(a).map((l) => l.ev), ["stop"]);
  } finally {
    await a.close();
  }
});

test("service log: shutdownNow with the service up writes quit-now naming the running job", async () => {
  const g = gate();
  const a = await app({ tag: "slog-now", executorDeps: { hooks: (pt) => (pt === "rename-before-mv" ? (g._hit(), new Promise(() => {})) : undefined) } });
  series(a.lib, "Tau", { "Ch.001.cbz": 1000 });
  const id = await a.addFolderTarget();
  await a.idle();
  assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
  await a.idle();
  const sk = (await a.state()).plans[id].summary.series[0].seriesKey;
  await a.call("rename-device-folder", { targetId: id, seriesKey: sk, to: "Tau 2" });
  await g.reached;
  a.svc.shutdownNow();
  const last = slogLines(a).pop();
  assert.deepStrictEqual([last.ev, last.hadJob, last.hadFind, last.searchProc], ["quit-now", "rename", false, false]);
  const n = slogLines(a).length;
  a.svc.shutdownNow();
  await a.svc.shutdown();
  assert.strictEqual(slogLines(a).length, n, "idempotent, and closed");
});

test("diag-log: rotates past maxBytes into one old file, truncates long lines, never throws", async () => {
  const dir = path.join(mkdir("diag"), "logs");
  let on = true;
  const log = new diagLog.ServiceLog({ dir, active: () => on, maxBytes: 2000 });
  for (let i = 0; i < 60; i += 1) assert.strictEqual(log.event("x", { i, pad: "p".repeat(40) }), true);
  const cur = fs.readFileSync(path.join(dir, diagLog.FILE), "utf8");
  const old = fs.readFileSync(path.join(dir, diagLog.OLD_FILE), "utf8");
  assert.ok(cur.length <= 2000 && old.length <= 2000, `${cur.length} / ${old.length}`);
  const lastI = JSON.parse(cur.trim().split("\n").pop()).i;
  assert.strictEqual(lastI, 59, "newest line in the current file");
  assert.strictEqual(fs.readdirSync(dir).length, 2, "at most two files");
  // A huge error is truncated, not dropped.
  log.error(["boom", "x".repeat(20000)]);
  const big = JSON.parse(fs.readFileSync(path.join(dir, diagLog.FILE), "utf8").trim().split("\n").pop());
  assert.strictEqual(big.ev, "error");
  assert.ok(big.text.startsWith("boom x") && big.text.length <= 8 * 1024);
  // Escaping can double a stack's length; the line still keeps the start.
  log.error(["stack", "at f\n".repeat(4000)]);
  const esc = JSON.parse(fs.readFileSync(path.join(dir, diagLog.FILE), "utf8").trim().split("\n").pop());
  assert.deepStrictEqual([esc.ev, esc.truncated, esc.text.slice(0, 10)], ["error", undefined, "stack at f"]);
  on = false;
  assert.strictEqual(log.event("y"), false);
  // An unwritable dir (a file in its place) only loses lines.
  const blocked = path.join(mkdir("diag2"), "logs");
  fs.writeFileSync(blocked, "a file");
  const bad = new diagLog.ServiceLog({ dir: blocked, active: () => true });
  assert.strictEqual(bad.event("z"), false);
  assert.strictEqual(bad.error(["e"]), false);
  assert.strictEqual(bad.event("z", { cyc: (() => { const c = {}; c.c = c; return c; })() }), false, "unserializable fields");
  // Deleted while running. The file: the rotation check that finds it gone
  // resets the size, so the fresh file isn't rotated one line later. The
  // folder: recreated, instead of every later line being lost.
  const hd = path.join(mkdir("diag3"), "logs");
  const heal = new diagLog.ServiceLog({ dir: hd, active: () => true, maxBytes: 300 });
  for (let i = 0; i < 2; i += 1) heal.event("a", { pad: "p".repeat(60) }); // ~240 B, under the cap
  fs.rmSync(path.join(hd, diagLog.FILE));
  for (let i = 0; i < 2; i += 1) assert.strictEqual(heal.event("b", { i, pad: "p".repeat(60) }), true);
  const healed = fs.readFileSync(path.join(hd, diagLog.FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepStrictEqual(healed.map((l) => `${l.ev}${l.i}`), ["b0", "b1"], "both lines in the fresh file");
  fs.rmSync(hd, { recursive: true, force: true });
  assert.strictEqual(heal.event("c"), true, "folder recreated");
  assert.deepStrictEqual(fs.readFileSync(path.join(hd, diagLog.FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l).ev), ["c"]);
  assert.strictEqual(diagLog.insideAsar("C:\\Program Files\\AIO\\resources\\app.asar\\electron\\sync\\service.js"), true);
  assert.strictEqual(diagLog.insideAsar("/opt/AIO/resources/app.asar.unpacked/x.js"), false);
  assert.strictEqual(diagLog.insideAsar(path.join(SYNC, "service.js")), false);
});

test("a reader switch keeps the record; into custom seeds the preset's values, out of custom clears them", async () => {
  const a = await app();
  try {
    series(a.lib, "Sigma", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    await a.idle();
    const hdrPath = path.join(a.userData, "targets", id, "header.json");
    const before = JSON.parse(fs.readFileSync(hdrPath, "utf8"));
    assert.ok(!("profile" in before), "new headers don't pin the reader");
    assertRefusal(await a.call("config-op", { op: "update-target", targetId: id, patch: { nomedia: false } }), "invalid");
    const toCustom = await a.call("config-op", { op: "update-target", targetId: id, patch: { profile: "custom" } });
    assert.ok(toCustom.ok, JSON.stringify(toCustom));
    const ct = toCustom.config.targets.find((t) => t.id === id);
    assert.deepStrictEqual([ct.formats, ct.sidecars, ct.nomedia, ct.namingPolicy], [["cbz", "zip", "cbr", "rar", "epub"], ["cover.jpg", "details.json"], true, "strip-hid"]);
    assert.ok((await a.call("config-op", { op: "update-target", targetId: id, patch: { nomedia: false } })).ok, "custom may change .nomedia");
    const toPdf = await a.call("config-op", { op: "update-target", targetId: id, patch: { profile: "pdf" } });
    assert.ok(toPdf.ok, JSON.stringify(toPdf));
    const pt = toPdf.config.targets.find((t) => t.id === id);
    for (const f of ["formats", "sidecars", "nomedia", "namingPolicy", "renameToMatch", "cleanupNames"]) assert.strictEqual(pt[f], null, f);
    assertRefusal(await a.call("config-op", { op: "update-target", targetId: id, patch: { profile: "komikku", nomedia: false } }), "invalid");
    await a.idle();
    const after = JSON.parse(fs.readFileSync(hdrPath, "utf8"));
    assert.strictEqual(after.recordEpoch, before.recordEpoch, "no reader switch cleared the record");
    const p = await a.plan(id);
    assert.strictEqual(p.summary.plan.firstSync, false);
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
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
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

// ---------------------------------------------------------------- UI pass U0

/** The latest `plans` event for a target, after one tick (they coalesce). */
async function lastPlans(a, id, from = 0) {
  await sleep(5);
  return [...a.events.slice(from)].reverse().find((e) => e.kind === "plans" && e.targetId === id) || null;
}

test("U0 gen: apply needs the reviewed gen; a re-plan between review and Start refuses plan-changed", async () => {
  const a = await app();
  try {
    series(a.lib, "Kappa", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const reviewed = (await a.state()).plans[id];
    assert.ok(Number.isInteger(reviewed.gen), JSON.stringify(reviewed));
    assert.strictEqual(reviewed.summary.gen, reviewed.gen, "the summary carries its gen");
    assertRefusal(await a.call("apply", { targetId: id }), "invalid");
    // An automatic re-plan lands while the review is open (a download ended).
    writeOld(path.join(a.lib, "Kappa", "Ch.002.cbz"), bytes("Ch.002.cbz", 1000));
    a.svc.notifyLibraryChanged("download");
    await waitFor(() => a.events.some((e) => e.kind === "plans" && e.targetId === id && e.gen > reviewed.gen), 15000, "re-plan's plans event");
    await a.idle();
    const r = await a.call("apply", { targetId: id, gen: reviewed.gen });
    assertRefusal(r, "blocked");
    assert.strictEqual(r.blocking[0].kind, "plan-changed");
    assert.ok(r.blocking[0].gen > reviewed.gen);
    assert.strictEqual(devNames(a, "Kappa"), null, "nothing ran");
    // Start against the new review works.
    const ok = await a.call("apply", { targetId: id, gen: r.blocking[0].gen });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.strictEqual((await a.job(ok.runId)).status, "completed");
    assert.deepStrictEqual(devNames(a, "Kappa"), ["Ch.001.cbz", "Ch.002.cbz"]);
  } finally {
    await a.close();
  }
});

test("U0 push model: plans events carry summary, gen, stale and lastRun; forget-record and remove-target announce themselves", async () => {
  const a = await app();
  try {
    series(a.lib, "Lambda", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    let ev = await lastPlans(a, id);
    assert.ok(ev && ev.summary && Number.isInteger(ev.gen) && ev.stale === false, JSON.stringify(ev && { gen: ev.gen, stale: ev.stale }));
    const from = a.since();
    const ap = await a.apply({ targetId: id });
    const done = await a.job(ap.runId);
    await a.idle();
    ev = await lastPlans(a, id, from);
    assert.strictEqual(ev.lastRun.phase, "apply");
    assert.strictEqual(ev.lastRun.status, "completed");
    assert.strictEqual(ev.lastRun.runId, done.runId);
    assert.strictEqual(ev.lastRun.summary.filesDone, 1, "the run's result survives the re-plan it queued");
    assert.ok(a.events.slice(from).some((e) => e.kind === "plans" && e.targetId === id && e.stale === true), "the queued re-plan marked it stale first");
    assert.strictEqual((await a.state()).plans[id].lastRun.runId, done.runId, "get-state agrees");
    // forget-record: the clear is pushed (summary gone, gen gone); config isn't changed.
    const f2 = a.since();
    assert.ok((await a.call("config-op", { op: "forget-record", targetId: id })).ok);
    ev = await waitFor(() => a.events.slice(f2).find((e) => e.kind === "plans" && e.targetId === id && e.summary === null), 3000, "forget plans event");
    assert.strictEqual(ev.gen, null);
    await a.idle();
    const f3 = a.since();
    assert.ok((await a.call("config-op", { op: "remove-target", targetId: id })).ok);
    ev = await waitFor(() => a.events.slice(f3).find((e) => e.kind === "plans" && e.targetId === id && e.removed), 3000, "removed plans event");
    assert.ok(a.events.slice(f3).some((e) => e.kind === "config" && e.config.targets.length === 0));
  } finally {
    await a.close();
  }
});

test("U0b removals are a target field: add-target stamps the global, a later global change doesn't move it, plan overrides are refused", async () => {
  const a = await app();
  try {
    series(a.lib, "Mu", { "Ch.001.cbz": 1000, "Ch.002.cbz": 1000 });
    const id = await a.addFolderTarget();
    assert.strictEqual((await a.state()).config.targets[0].deletePolicy, "guarded", "stamped from the global default");
    await a.idle();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    await a.idle();
    a.settings = { ...a.settings, syncDeletePolicy: "add-only" };
    await a.svc.applySettings(a.settings);
    await a.idle();
    assert.strictEqual((await a.state()).config.targets[0].deletePolicy, "guarded", "the global is only for NEW targets");
    assert.strictEqual((await a.summary(id)).policy.deletePolicy, "guarded");
    assertRefusal(await a.call("plan", { targetId: id, overrides: { deletePolicy: "add-only" } }), "invalid");
    assertRefusal(await a.call("plan", { targetId: id, overrides: { clearOverrides: true } }), "invalid");
    assertRefusal(await a.call("config-op", { op: "update-target", targetId: id, patch: { deletePolicy: "bogus" } }), "invalid");
    // add-only on the target: a covered extra stays, through an automatic
    // re-plan and apply's own re-plan alike.
    assert.ok((await a.call("config-op", { op: "update-target", targetId: id, patch: { deletePolicy: "add-only" } })).ok);
    writeOld(path.join(a.target, "Mu", "Ch.002 (old).cbz"), bytes("x", 900));
    const p = await a.plan(id);
    assert.strictEqual(p.summary.plan.totals.delete.count, 0);
    const gen0 = p.summary.plan.gen;
    a.svc.notifyLibraryChanged("scan");
    await waitFor(() => a.events.some((e) => e.kind === "plans" && e.targetId === id && e.gen > gen0), 15000, "auto re-plan");
    await a.idle();
    assert.strictEqual((await a.summary(id)).policy.deletePolicy, "add-only");
    const ap = await a.apply({ targetId: id });
    assert.ok(ap.ok, JSON.stringify(ap));
    assert.strictEqual((await a.job(ap.runId)).status, "completed");
    assert.ok(devNames(a, "Mu").includes("Ch.002 (old).cbz"));
    // Re-check's Re-hash is one-shot (design D4): on its own plan only.
    await a.idle();
    const rh = await a.plan(id, { hashMode: "rehash" });
    assert.strictEqual(rh.summary.plan.policy.hashMode, "rehash");
    const next = await a.plan(id);
    assert.strictEqual(next.summary.plan.policy.hashMode, "cached");
    assert.ok(!("overrides" in next.summary.plan.policy));
    const t2 = await a.call("config-op", { op: "add-target", target: { name: "Second", kind: "folder", root: path.join(a.dir, "device2"), profile: "everything" } });
    assert.strictEqual(t2.config.targets.find((t) => t.id === t2.targetId).deletePolicy, "add-only", "a new target takes the changed global");
  } finally {
    await a.close();
  }
});

test("U0b remove from target: a saved mark survives re-plans, goes through Review, removes the folder and its record; Include starts fresh", async () => {
  const a = await app();
  try {
    series(a.lib, "Rho", { "Ch.001.cbz": 1000, "Ch.002.cbz": 1000, "Ch.003.cbz": 1000, "cover.jpg": 100 });
    series(a.lib, "Sigma", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    await a.idle();
    assert.deepStrictEqual(devNames(a, "Rho"), ["Ch.001.cbz", "Ch.002.cbz", "Ch.003.cbz", "cover.jpg"]);
    const rhoKey = (await a.summary(id)).series.find((s) => s.folder === "Rho").seriesKey;
    assertRefusal(await a.call("config-op", { op: "remove-series", targetId: id, seriesKey: "pc:nope" }), "invalid");
    let from = a.since();
    const rm = await a.call("config-op", { op: "remove-series", targetId: id, seriesKey: rhoKey });
    assert.ok(rm.ok, JSON.stringify(rm));
    const ex = rm.config.targets[0].excludes;
    assert.strictEqual(ex.length, 1);
    assert.strictEqual(ex[0].removeFiles, true);
    await waitFor(() => a.events.slice(from).some((e) => e.kind === "plans" && e.targetId === id && e.summary), 15000, "re-plan after remove");
    await a.idle();
    // An automatic re-plan (a library change) keeps the pending removal.
    const gen0 = (await a.state()).plans[id].gen;
    a.svc.notifyLibraryChanged("scan");
    await waitFor(() => a.events.some((e) => e.kind === "plans" && e.targetId === id && e.gen > gen0), 15000, "auto re-plan");
    await a.idle();
    const sum = await a.summary(id);
    const rho = sum.series.find((s) => s.seriesKey === rhoKey);
    assert.deepStrictEqual([rho.state, rho.heldReason, rho.removing], ["held", "excluded", true]);
    assert.strictEqual(sum.totals.delete.count, 4);
    const rv = await a.call("review", { targetId: id });
    const g = rv.groups.find((x) => x.kind === "delete" && x.reason === "removed-from-target");
    assert.deepStrictEqual([g.count, g.selectedCount], [4, 4]);
    assert.deepStrictEqual(rv.losses, [], "the PC keeps every chapter: no loss");
    // Start: the folder and its record go, the mark is cleared, the series stays off.
    from = a.since();
    const ap = await a.apply({ targetId: id });
    assert.ok(ap.ok, JSON.stringify(ap));
    const done = await a.job(ap.runId);
    assert.strictEqual(done.status, "completed", JSON.stringify(done.summary));
    assert.deepStrictEqual(done.summary.evictions, [{ seriesKey: rhoKey, folder: "Rho", removed: true }]);
    assert.strictEqual(devNames(a, "Rho"), null, "the folder is gone");
    assert.deepStrictEqual(devNames(a, "Sigma"), ["Ch.001.cbz"], "other series untouched");
    assert.ok(fs.existsSync(path.join(a.lib, "Rho", "Ch.001.cbz")), "the PC keeps its copy");
    const cfg = (await a.state()).config.targets[0];
    assert.deepStrictEqual(cfg.excludes.map((e) => e.removeFiles), [undefined], "the mark is cleared; the exclude stays");
    const shards = fs.readdirSync(path.join(a.userData, "targets", id, "folders")).filter((n) => n.endsWith(".json"));
    assert.strictEqual(shards.length, 1, `only Sigma's shard is left: ${shards}`);
    await a.idle();
    const after = (await a.summary(id)).series.find((s) => s.seriesKey === rhoKey);
    assert.deepStrictEqual([after.state, after.removing, after.counts.delete || 0], ["held", false, 0]);
    // Include: a new series again (no shard), not a gone folder asking for a name.
    from = a.since();
    assert.ok((await a.call("config-op", { op: "include-series", targetId: id, seriesKey: rhoKey })).ok);
    assert.deepStrictEqual((await a.state()).config.targets[0].excludes, []);
    await waitFor(() => a.events.slice(from).some((e) => e.kind === "plans" && e.targetId === id && e.summary), 15000, "re-plan after include");
    await a.idle();
    const back = (await a.summary(id)).series.find((s) => s.seriesKey === rhoKey);
    assert.deepStrictEqual([back.state, back.counts.push], ["new", 4]);
  } finally {
    await a.close();
  }
});

test("U0 needs-mode: a stored verifyMode lets automatic plans of a non-hashing device complete", async () => {
  const a = await app({ adb: true });
  try {
    a.dev = a.srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" }, tools: { sha256sum: false } } });
    a.dev.fs.mkdirs(CANON);
    a.dev.fs.writeFile(`${CANON}/Nu/Ch.001.cbz`, bytes("Ch.001.cbz", 1500), { mtime: OLD_S });
    series(a.lib, "Nu", { "Ch.001.cbz": 1500 });
    const t = await a.call("config-op", { op: "add-target", target: { name: "Tab", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    const id = t.targetId;
    const auto = await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan", 15000, 0, "auto plan");
    assert.strictEqual(auto.summary.refusal && auto.summary.refusal.code, "needs-mode", JSON.stringify(auto.summary));
    await a.idle();
    assertRefusal(await a.call("config-op", { op: "update-target", targetId: id, patch: { verifyMode: "bogus" } }), "invalid");
    const from = a.since();
    const up = await a.call("config-op", { op: "update-target", targetId: id, patch: { verifyMode: "adopt-size" } });
    assert.ok(up.ok, JSON.stringify(up));
    assert.strictEqual(up.config.targets[0].verifyMode, "adopt-size");
    // The edit queues an automatic re-plan; it completes now.
    const again = await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan", 30000, from, "re-plan");
    assert.strictEqual(again.status, "completed", JSON.stringify(again.summary));
    const st = await a.state();
    assert.strictEqual(st.plans[id].refusal, null);
    assert.strictEqual(st.plans[id].summary.policy.verifyMode, "adopt-size");
    const ld = await a.call("list-devices");
    assert.ok(ld.ok && ld.devices[0].stateKind != null, JSON.stringify(ld));
  } finally {
    await a.close();
  }
});

test("U0b prompt: Review or Not now only (design D2); anything else is refused and leaves the prompt open", async () => {
  const a = await app();
  try {
    series(a.lib, "Xi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    let shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "prompt");
    assertRefusal(await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "sync-now", gens: { [id]: 1 } }), "invalid");
    assert.ok(!a.events.some((e) => e.kind === "prompt" && e.action === "answered"), "not consumed");
    assert.strictEqual((await a.state()).prompts.length, 1);
    assert.ok((await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "review" })).ok);
    await a.idle();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    await a.idle();
    // Reconnect with a new chapter: the prompt shows it, and Not now starts nothing.
    writeOld(path.join(a.lib, "Xi", "Ch.002.cbz"), bytes("Ch.002.cbz", 1000));
    const tgt = a.target;
    fs.renameSync(tgt, `${tgt}.off`);
    await waitFor(() => a.events.some((e) => e.kind === "device" && e.folderPresence[id] === false), 3000, "folder gone");
    const from = a.since();
    fs.renameSync(`${tgt}.off`, tgt);
    shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, from, "second prompt");
    assert.strictEqual(shown.prompt.card.targets[0].files, 1);
    assert.ok((await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "not-now" })).ok);
    await a.idle();
    assert.ok(!a.events.slice(from).some((e) => e.kind === "job" && e.job && e.job.phase === "apply"), "no apply without Review");
    assert.deepStrictEqual(devNames(a, "Xi"), ["Ch.001.cbz"]);
    assertRefusal(await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "review" }), "invalid");
  } finally {
    await a.close();
  }
});

test("U3 connect: the Preparing list carries the card's promptId, and empties when the card shows", async () => {
  const a = await app();
  try {
    series(a.lib, "Xi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    const pend = await a.waitEvent((e) => e.kind === "prompt" && e.action === "pending" && e.pending.length === 1, 15000, 0, "pending");
    assert.deepStrictEqual(pend.pending[0].targetIds, [id]);
    assert.strictEqual(pend.pending[0].connKey, `folder:${id}`);
    const shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "prompt");
    assert.strictEqual(shown.prompt.promptId, pend.pending[0].promptId, "one id from planning to the card");
    assert.deepStrictEqual(shown.pending, []);
    const st = await a.state();
    assert.deepStrictEqual(st.pending, []);
    assert.deepStrictEqual(shown.prompt.card.attention, []);
  } finally {
    await a.close();
  }
});

test("U3 connect: with prompt-on-connect off a connect still plans, and no card opens", async () => {
  const a = await app({ settings: { syncPromptOnConnect: false } });
  try {
    series(a.lib, "Xi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    const done = await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan" && e.job.targetId === id, 15000, 0, "connect plan");
    assert.strictEqual(done.status, "completed");
    await a.idle();
    assert.ok((await a.summary(id)).totals.series >= 1);
    assert.ok(!a.events.some((e) => e.kind === "prompt"), "no prompt event at all");
  } finally {
    await a.close();
  }
});

test("U3 connect: an open card whose target is synced from the tab is withdrawn `nothing-to-do`", async () => {
  const a = await app();
  try {
    series(a.lib, "Xi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    const shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "prompt");
    await a.idle();
    const from = a.since();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    const w = await a.waitEvent((e) => e.kind === "prompt" && e.action === "withdraw", 15000, from, "withdraw");
    assert.strictEqual(w.prompt.promptId, shown.prompt.promptId);
    assert.strictEqual(w.reason, "nothing-to-do");
    assert.deepStrictEqual((await a.state()).prompts, []);
    assertRefusal(await a.call("prompt-response", { promptId: shown.prompt.promptId, action: "review" }), "invalid");
  } finally {
    await a.close();
  }
});

test("U3 connect: a target removed while its connect plan waits doesn't hold back the device's card", async () => {
  // Two adb targets on one tablet share one card. The lane is busy (a held
  // apply on a folder target) when the tablet connects, so both connect
  // plans queue; removing one must not leave the card waiting for a plan
  // that will never run (the device stays connected, so no disconnect
  // clears the batch).
  const g = gate();
  const a = await app({ adb: true, executorDeps: { hooks: (pt) => (pt === "before-send" ? (g._hit(), g.wait) : undefined) } });
  try {
    series(a.lib, "Rho", { "Ch.001.cbz": 1000 });
    const fid = await a.addFolderTarget();
    await a.idle();
    const ap = await a.apply({ targetId: fid });
    await g.reached; // the lane is held by this apply
    const ta = await a.call("config-op", { op: "add-target", target: { name: "TabA", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    const tb = await a.call("config-op", { op: "add-target", target: { name: "TabB", kind: "adb", serial: SERIAL, root: "/sdcard/Mihon/local", profile: "komikku" } });
    assert.ok(ta.ok && tb.ok, JSON.stringify([ta, tb]));
    a.dev = a.srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" } } });
    a.dev.fs.mkdirs(CANON);
    a.dev.fs.mkdirs("/storage/emulated/0/Mihon/local");
    await waitFor(() => [...a.svc._debug().autoBatches.keys()].some((k) => k.startsWith(`${SERIAL}#`)), 5000, "the tablet's connect batch");
    const rm = await a.call("config-op", { op: "remove-target", targetId: tb.targetId });
    assert.ok(rm.ok, JSON.stringify(rm));
    const from = a.since();
    g.open();
    assert.strictEqual((await a.job(ap.runId)).status, "completed");
    const shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show" && e.prompt.serial === SERIAL, 15000, from, "the tablet's card");
    assert.deepStrictEqual(shown.prompt.card.targets.map((x) => x.targetId), [ta.targetId]);
  } finally {
    await a.close();
  }
});

test("U3 needs-mode on connect: the card lists the target for attention with the read-back bytes", async () => {
  const a = await app({ adb: true });
  try {
    a.dev = a.srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" }, tools: { sha256sum: false } } });
    a.dev.fs.mkdirs(CANON);
    a.dev.fs.writeFile(`${CANON}/Nu/Ch.001.cbz`, bytes("Ch.001.cbz", 1500), { mtime: OLD_S });
    series(a.lib, "Nu", { "Ch.001.cbz": 1500 });
    const t = await a.call("config-op", { op: "add-target", target: { name: "Tab", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    const shown = await a.waitEvent((e) => e.kind === "prompt" && e.action === "show", 15000, 0, "prompt");
    const att = shown.prompt.card.attention;
    assert.strictEqual(att.length, 1, JSON.stringify(shown.prompt.card));
    assert.deepStrictEqual([att[0].targetId, att[0].code, att[0].targetName, att[0].firstSync, att[0].bytes], [t.targetId, "needs-mode", "Tab", true, 1500]);
    assert.deepStrictEqual(att[0].folders, ["Nu"]);
    assert.strictEqual((await a.state()).plans[t.targetId].refusal.bytes, 1500, "the plan view's refusal names the bytes too");
  } finally {
    await a.close();
  }
});

test("U0 download guard: a running download's folder is skipped with reason `downloading` (series-dir, then url)", async () => {
  const a = await app();
  try {
    series(a.lib, "Omicron", { "Ch.001.cbz": 1000 }, "https://mangafire.to/manga/omicron.x9");
    series(a.lib, "Pi", { "Ch.001.cbz": 1000 }, "https://mangafire.to/manga/pi.x7");
    const id = await a.addFolderTarget();
    await a.idle();
    // Omicron by its folder (an update-check download), Pi by its URL (www. and a trailing slash differ).
    a.downloads = [
      { downloadId: "d1", url: "https://elsewhere.example/x", seriesDir: path.join(a.lib, "Omicron") },
      { downloadId: "d2", url: "https://www.MANGAFIRE.to/manga/pi.x7/", seriesDir: null },
    ];
    const ap = await a.apply({ targetId: id });
    const done = await a.job(ap.runId);
    assert.strictEqual(done.status, "completed", JSON.stringify(done.summary));
    assert.deepStrictEqual(devNames(a, "Omicron") || [], [], "nothing of Omicron landed");
    assert.deepStrictEqual(devNames(a, "Pi") || [], []);
    assert.strictEqual(done.summary.skippedReasons.downloading, 2, JSON.stringify(done.summary.skipped));
    assert.ok(done.summary.skipped.every((s) => s.reason === "downloading"));
    a.downloads = [];
    await a.idle();
    const ap2 = await a.apply({ targetId: id });
    assert.strictEqual((await a.job(ap2.runId)).status, "completed");
    assert.deepStrictEqual(devNames(a, "Pi"), ["Ch.001.cbz"]);
  } finally {
    await a.close();
  }
});

test("U0 selection lock: set-selection is busy while an apply runs on that target; the review answers meanwhile", async () => {
  const g = gate();
  const a = await app({ executorDeps: { hooks: (pt) => (pt === "before-send" ? (g._hit(), g.wait) : undefined) } });
  try {
    series(a.lib, "Rho", { "Ch.001.cbz": 1000, "Ch.002.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const rv = await a.call("review", { targetId: id });
    const push = rv.groups.find((x) => x.kind === "push").ops[0];
    const ap = await a.apply({ targetId: id });
    await g.reached;
    assertRefusal(await a.call("set-selection", { targetId: id, changes: [{ opId: push.opId, selected: false }] }), "busy");
    const during = await a.call("review", { targetId: id });
    assert.strictEqual(during.busy, true);
    g.open();
    assert.strictEqual((await a.job(ap.runId)).status, "completed");
  } finally {
    await a.close();
  }
});

test("U0 review: groups by (kind, reason), bulk by reason, push rows name their reason, capacity follows the selection", async () => {
  const a = await app();
  try {
    series(a.lib, "Sigma", { "Ch.001.cbz": 1000, "Ch.002.cbz": 2000, "cover.jpg": 300 });
    const id = await a.addFolderTarget();
    await a.idle();
    const rv = await a.call("review", { targetId: id });
    assert.ok(rv.ok, JSON.stringify(rv));
    const sum = await a.summary(id);
    assert.strictEqual(rv.gen, sum.gen);
    const g = rv.groups.find((x) => x.kind === "push" && x.reason === "new");
    assert.ok(g, JSON.stringify(rv.groups.map((x) => [x.kind, x.reason])));
    assert.strictEqual(g.count, 3);
    assert.strictEqual(g.selectedBytes, 3300);
    // Capacity: needed = the selected pushes; free measured on the folder's volume.
    assert.strictEqual(rv.capacity.needed, 3300);
    assert.ok(rv.capacity.free == null || rv.capacity.free > 0, JSON.stringify(rv.capacity));
    assert.strictEqual(rv.capacity.reserve, 1024 * 1024 * 1024);
    assert.ok(Array.isArray(sum.warnings));
    const det = await a.call("series-detail", { targetId: id, seriesKey: sum.series[0].seriesKey });
    assert.ok(det.rows.filter((r) => r.kind === "push").every((r) => r.reason === "new"), "push rows carry the op's reason");
    // Untick the whole (push, new) group; a reason that matches nothing touches nothing.
    const none = await a.call("set-selection", { targetId: id, bulk: "group", group: "push", reason: "missing", selected: false });
    assert.strictEqual(none.totals.push.count, 3);
    const off = await a.call("set-selection", { targetId: id, bulk: "group", group: "push", reason: "new", selected: false });
    assert.strictEqual(off.totals.push.count, 0);
    assert.strictEqual(off.gen, sum.gen, "a selection change keeps the gen");
    const rv2 = await a.call("review", { targetId: id });
    assert.strictEqual(rv2.capacity.needed, 0);
    assert.strictEqual(rv2.groups.find((x) => x.kind === "push").selectedCount, 0);
    assertRefusal(await a.call("review", { targetId: "nope" }), "invalid");
  } finally {
    await a.close();
  }
});

test("U0 prune and rename report progress: quitInfo counts folders", async () => {
  const g = gate();
  const a = await app({ executorDeps: { hooks: (pt) => (pt === "prune-before-folder" ? (g._hit(), g.wait) : undefined) } });
  try {
    series(a.lib, "Tau", { "Ch.001.cbz": 1000 });
    series(a.lib, "Upsilon", { "Ch.001.cbz": 1000 });
    series(a.lib, "Chi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    assert.strictEqual((await a.job((await a.apply({ targetId: id })).runId)).status, "completed");
    fs.rmSync(path.join(a.lib, "Tau"), { recursive: true });
    fs.rmSync(path.join(a.lib, "Upsilon"), { recursive: true });
    await a.idle();
    const pl = await a.plan(id);
    const orphans = pl.summary.plan.deviceOnly.filter((d) => d.state === "orphaned").map((d) => d.name).sort();
    assert.deepStrictEqual(orphans, ["Tau", "Upsilon"], JSON.stringify(pl.summary.plan.deviceOnly));
    const pr = await a.call("prune", { targetId: id, folders: ["Tau", "Upsilon", "Nope"] });
    assert.ok(pr.ok, JSON.stringify(pr));
    await waitFor(() => a.svc.quitInfo() && a.svc.quitInfo().total === 2, 5000, "prune progress");
    const qi = a.svc.quitInfo();
    assert.deepStrictEqual([qi.phase, qi.unit, qi.done, qi.total], ["prune", "folders", 0, 2]);
    g.open();
    const d = await a.job(pr.runId);
    assert.strictEqual(d.status, "completed", JSON.stringify(d.summary));
    assert.deepStrictEqual(d.summary.notOrphaned, ["Nope"]);
    assert.strictEqual(d.summary.filesDone, 2);
  } finally {
    await a.close();
  }
});

test("U0 settings: applySettings pushes `settings`; a planning setting change re-plans; get-state while off has specs", async () => {
  const a = await app();
  try {
    series(a.lib, "Phi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const gen0 = (await a.summary(id)).gen;
    const from = a.since();
    a.settings = { ...a.settings, syncSizeWarnPct: 15 };
    await a.svc.applySettings(a.settings);
    const ev = a.events.slice(from).find((e) => e.kind === "settings");
    assert.ok(ev && ev.enabled === true && ev.settings.syncSizeWarnPct === 15, JSON.stringify(ev));
    assert.ok(!("chapterPatterns" in ev.settings), "no RegExps over IPC");
    await waitFor(() => a.events.slice(from).some((e) => e.kind === "plans" && e.targetId === id && e.gen > gen0), 15000, "re-plan after a planning setting");
    await a.idle();
    const f2 = a.since();
    a.settings = { ...a.settings, syncErrorBudget: 5 };
    await a.svc.applySettings(a.settings);
    await sleep(50);
    assert.ok(!a.events.slice(f2).some((e) => e.kind === "plans" && e.stale), "a non-planning setting doesn't re-plan");
    a.settings = { ...a.settings, syncEnabled: false };
    await a.svc.applySettings(a.settings);
    const off = await a.state();
    assert.strictEqual(off.enabled, false);
    assert.ok(off.specs && off.specs.syncEnabled, "specs while off");
    assert.ok(a.events.some((e) => e.kind === "settings" && e.enabled === false));
  } finally {
    await a.close();
  }
});

test("U2 plan ifNeeded: the service decides; a cancelled plan holds it off until something changes", async () => {
  const a = await app({ adb: true });
  try {
    a.dev = a.srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" }, shellDelayMs: 150 } });
    a.dev.fs.mkdirs(CANON);
    series(a.lib, "Omicron", { "Ch.001.cbz": 1000 });
    const t = await a.call("config-op", { op: "add-target", target: { name: "Tab", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    const id = t.targetId;
    // The add queued an automatic plan; asking now joins it.
    await waitFor(() => a.svc._debug().current, 8000, "auto plan running");
    const running = await a.call("plan", { targetId: id, ifNeeded: true });
    assert.deepStrictEqual([running.ok, running.planned, running.why], [true, false, "running"]);
    const from = a.since();
    assert.strictEqual((await a.call("cancel")).ok, true);
    const done = await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan", 15000, from, "cancelled plan");
    assert.strictEqual(done.status, "cancelled");
    await a.idle();
    const v = (await lastPlans(a, id)) || {};
    assert.strictEqual(v.summary, null);
    assert.strictEqual(v.refusal, null);
    assert.strictEqual(v.lastPlan && v.lastPlan.status, "cancelled", JSON.stringify(v.lastPlan));
    // The old renderer rule ("no summary, no refusal") would re-plan here forever.
    const held = await a.call("plan", { targetId: id, ifNeeded: true });
    assert.deepStrictEqual([held.planned, held.why], [false, "held"]);
    await sleep(100);
    assert.ok(!a.svc._debug().current, "nothing started");
    // A config edit is a change: the hold lifts and the edit's own re-plan runs.
    a.dev.inject.shellDelayMs = 0;
    const from2 = a.since();
    assert.ok((await a.call("config-op", { op: "update-target", targetId: id, patch: { name: "Tab 2" } })).ok);
    const again = await a.waitEvent((e) => e.kind === "job" && e.state === "done" && e.job.phase === "plan", 15000, from2, "re-plan");
    assert.strictEqual(again.status, "completed");
    await a.idle();
    const fresh = await a.call("plan", { targetId: id, ifNeeded: true });
    assert.deepStrictEqual([fresh.planned, fresh.why], [false, "fresh"]);
  } finally {
    await a.close();
  }
});

test("U2 plan ifNeeded: a fresh summary doesn't re-plan; a disconnected folder says so; a reconnect plans", async () => {
  const a = await app({ settings: { syncPromptOnConnect: false } });
  try {
    series(a.lib, "Pi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    // Prompt-on-connect is off: the add's re-plan may have found the folder
    // not yet watched, so the first plan can come from ifNeeded itself.
    await waitFor(async () => {
      await a.idle();
      const r = await a.call("plan", { targetId: id, ifNeeded: true });
      return r.why === "fresh";
    }, 15000, "a fresh plan");
    const g0 = (await a.state()).plans[id].gen;
    fs.rmSync(a.target, { recursive: true, force: true });
    await waitFor(async () => (await a.call("plan", { targetId: id, ifNeeded: true })).why === "disconnected", 8000, "folder gone");
    // While away, something marks the plan stale (a download landed).
    a.svc.notifyLibraryChanged("download");
    await waitFor(async () => (await a.state()).plans[id].stale === true, 8000, "stale mark");
    fs.mkdirSync(a.target, { recursive: true });
    // Prompt-on-connect is off, so only ifNeeded re-plans the stale summary.
    await waitFor(async () => (await a.call("plan", { targetId: id, ifNeeded: true })).why !== "disconnected", 8000, "folder back");
    await waitFor(async () => {
      const v = (await a.state()).plans[id];
      return v.gen > g0 && !v.stale;
    }, 15000, "re-planned after reconnect");
  } finally {
    await a.close();
  }
});

test("U2 selection: seq is echoed in the plan view; an old gen is refused plan-changed; bulk series", async () => {
  const a = await app();
  try {
    series(a.lib, "Rho", { "Ch.001.cbz": 1000, "Ch.002.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const s0 = await a.summary(id);
    const row = s0.series[0];
    assert.deepStrictEqual([row.counts.offered, row.counts.preselected], [2, 2]);
    const from = a.since();
    const off = await a.call("set-selection", { targetId: id, gen: s0.gen, seq: 7, bulk: "series", seriesKey: row.seriesKey, selected: false });
    assert.ok(off.ok, JSON.stringify(off));
    assert.strictEqual(off.seq, 7);
    assert.strictEqual(off.totals.push.count, 0);
    const ev = await a.waitEvent((e) => e.kind === "plans" && e.targetId === id && e.selSeq === 7, 4000, from, "plans with selSeq 7");
    assert.strictEqual(ev.summary.totals.push.count, 0);
    const on = await a.call("set-selection", { targetId: id, gen: s0.gen, seq: 8, bulk: "series", seriesKey: row.seriesKey, selected: true });
    assert.strictEqual(on.totals.push.count, 2);
    const stale = await a.call("set-selection", { targetId: id, gen: s0.gen - 1, seq: 9, changes: [] });
    assertRefusal(stale, "blocked");
    assert.strictEqual(stale.blocking[0].kind, "plan-changed");
    assert.strictEqual((await lastPlans(a, id)).selSeq, 8, "a refused request leaves selSeq alone");
  } finally {
    await a.close();
  }
});

test("U2 capacity carries total and after; apply progress carries `at` and the series lane", async () => {
  // Each landed file waits 150 ms, so progress isn't coalesced into the
  // job's end (job-record COALESCE_MS drops the last pending update).
  const a = await app({ executorDeps: { hooks: (pt) => (pt === "after-pushed" ? sleep(150) : undefined) } });
  try {
    series(a.lib, "Tau", { "Ch.001.cbz": 1000, "Ch.002.cbz": 2000, "Ch.003.cbz": 3000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const c = (await a.summary(id)).capacity;
    if (c.free != null) {
      assert.ok(c.total >= c.free, JSON.stringify(c));
      assert.strictEqual(c.after, c.free - c.needed + c.freeable);
    } else assert.strictEqual(c.after, null);
    const from = a.since();
    const ap = await a.apply({ targetId: id });
    assert.ok(ap.ok, JSON.stringify(ap));
    assert.strictEqual((await a.job(ap.runId)).status, "completed");
    const prog = a.events.slice(from).filter((e) => e.kind === "job" && e.runId === ap.runId && e.progress && e.progress.lane);
    assert.ok(prog.length, "a progress event carried the lane");
    for (const e of prog) {
      assert.ok(Number.isFinite(e.progress.at));
      assert.ok(e.progress.lane.landed <= e.progress.lane.total && e.progress.lane.total === 3, JSON.stringify(e.progress.lane));
    }
  } finally {
    await a.close();
  }
});

test("U2 settling: a plan holding a young file re-plans itself after settleAt", async () => {
  const a = await app();
  try {
    series(a.lib, "Upsilon", { "Ch.001.cbz": 1000 });
    // 28 s old: inside the 30 s settle age, out of it ~2 s from now.
    writeOld(path.join(a.lib, "Upsilon", "Ch.002.cbz"), bytes("Ch.002.cbz", 1000), Date.now() / 1000 - 28);
    const id = await a.addFolderTarget();
    await a.idle();
    const s0 = await a.summary(id);
    assert.ok(s0.settleAt != null, "a file is settling");
    const g0 = s0.gen;
    await waitFor(() => a.events.some((e) => e.kind === "plans" && e.targetId === id && e.gen > g0), 15000, "self re-plan");
    await a.idle();
    const s1 = await a.summary(id);
    assert.strictEqual(s1.settleAt, null);
    assert.strictEqual(s1.totals.push.count, 2);
  } finally {
    await a.close();
  }
});

test("U2 exclude: remove-series {removeFiles:false} stops syncing without offering deletes", async () => {
  const a = await app();
  try {
    series(a.lib, "Phi", { "Ch.001.cbz": 1000 });
    const id = await a.addFolderTarget();
    await a.idle();
    const ap = await a.apply({ targetId: id });
    await a.job(ap.runId);
    await a.idle();
    const key = (await a.summary(id)).series[0].seriesKey;
    const r = await a.call("config-op", { op: "remove-series", targetId: id, seriesKey: key, removeFiles: false });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.config.targets[0].excludes.length, 1);
    assert.ok(!("removeFiles" in r.config.targets[0].excludes[0]));
    await a.idle();
    const row = (await a.summary(id)).series.find((x) => x.seriesKey === key);
    assert.deepStrictEqual([row.state, row.heldReason, row.removing], ["held", "excluded", false]);
    assert.strictEqual(row.counts.offered, 0);
    assert.deepStrictEqual(devNames(a, "Phi"), ["Ch.001.cbz"], "files stay");
  } finally {
    await a.close();
  }
});

test("U2 mass acknowledgement over IPC: `true` is not accepted, the shown count is", async () => {
  const a = await app();
  try {
    const files = {};
    for (let i = 1; i <= 12; i += 1) files[`Ch.${String(i).padStart(3, "0")}.cbz`] = 1000 + i;
    series(a.lib, "Chi", files);
    const id = await a.addFolderTarget();
    await a.idle();
    const ap = await a.apply({ targetId: id });
    await a.job(ap.runId);
    await a.idle();
    const key = (await a.summary(id)).series[0].seriesKey;
    assert.ok((await a.call("config-op", { op: "remove-series", targetId: id, seriesKey: key })).ok);
    await a.idle();
    const s = await a.summary(id);
    assert.ok(s.massDelete.required, JSON.stringify(s.massDelete));
    const n = s.massDelete.count;
    const bad = await a.call("apply", { targetId: id, gen: s.gen, ackMassDelete: true });
    assertRefusal(bad, "blocked");
    assert.ok(bad.blocking.some((b) => b.kind === "mass-delete"));
    assertRefusal(await a.call("apply", { targetId: id, gen: s.gen, ackMassDelete: n - 1 }), "blocked");
    const ok = await a.call("apply", { targetId: id, gen: s.gen, ackMassDelete: n });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.strictEqual((await a.job(ok.runId)).status, "completed");
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
