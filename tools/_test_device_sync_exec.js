// Offline regression for the Device Sync engine below the service
// (UI-source/electron/sync/: store, hash-pool, pc-inventory, transports,
// executor, prepare) against tools/fake-adb-server.js and real temp folders.
//
// Covers the non-UI plan's P3 test list (sync-temp/plans/c-users-legoc-
// claude-plans-add-this-scr-noble-truffle.md, Phases and Verification): the
// record's atomicity and recovery, the hash pool, the inventory, listing
// trust, both transports, and the executor's crash windows. A crash is
// simulated with a hook that never resolves (nothing after that point runs);
// the test then drops every instance and plans again from what is on disk,
// as a restarted app would.
//
//   node tools/_test_device_sync_exec.js
//   ELECTRON_RUN_AS_NODE=1 UI-source/node_modules/electron/dist/electron tools/_test_device_sync_exec.js
//   TEST_ONLY=<regex> runs the matching tests only.
//
// tools/ is gitignored; this file is force-added on wip/device-sync-handoff
// only and never ships.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SYNC = path.join(__dirname, "..", "UI-source", "electron", "sync");
const store = require(path.join(SYNC, "store.js"));
const hp = require(path.join(SYNC, "hash-pool.js"));
const inv = require(path.join(SYNC, "pc-inventory.js"));
const tr = require(path.join(SYNC, "transports.js"));
const ex = require(path.join(SYNC, "executor.js"));
const prep = require(path.join(SYNC, "prepare.js"));
const planner = require(path.join(SYNC, "planner.js"));
const prov = require(path.join(SYNC, "provenance.js"));
const profiles = require(path.join(SYNC, "profiles.js"));
const { resolveSyncSettings } = require(path.join(SYNC, "sync-settings.js"));
const { AdbClient, AdbError } = require(path.join(SYNC, "adb", "client.js"));
const wire = require(path.join(SYNC, "adb", "wire.js"));
const { FakeAdbServer, DEFAULT_FEATURES, tokenize } = require(path.join(__dirname, "fake-adb-server.js"));

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SERIAL = "A06B4A372090333";
const LINK_ROOT = "/sdcard/Komikku/local";
const CANON = "/storage/emulated/0/Komikku/local";
const OLD_S = Math.floor(Date.now() / 1000) - 3600;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-sync-exec-"));
let dirSeq = 0;
function mkdir(tag) {
  const d = path.join(TMP, `${String(++dirSeq).padStart(3, "0")}-${tag || "t"}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Bytes for a chapter file: deterministic per (name, size, version). */
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

/**
 * Library folder: {"Alpha": {url, files: {"Ch.001.cbz": 3000 | Buffer}}}.
 * Each series gets .aio_series.json (url, title) unless meta === null.
 */
function buildLibrary(root, spec) {
  fs.mkdirSync(root, { recursive: true });
  for (const [folder, s] of Object.entries(spec)) {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    if (s.meta !== null) {
      const meta = s.meta || { url: `https://mangafire.to/manga/${encodeURIComponent(folder.toLowerCase())}.x${folder.length}`, title: folder };
      writeOld(path.join(dir, ".aio_series.json"), JSON.stringify(meta));
    }
    for (const [name, v] of Object.entries(s.files || {})) {
      writeOld(path.join(dir, name), Buffer.isBuffer(v) ? v : bytes(name, v));
    }
  }
}

/** A never-resolving hook at `point` (a process kill there). */
function killAt(point, pred) {
  let hit;
  const reached = new Promise((r) => {
    hit = r;
  });
  const hooks = (pt, ctx) => {
    if (pt === point && (!pred || pred(ctx))) {
      hit(ctx);
      return new Promise(() => {});
    }
    return undefined;
  };
  return { hooks, reached };
}

async function within(promise, ms, what) {
  let t;
  const r = await Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} did not happen within ${ms} ms`)), ms)))]);
  clearTimeout(t);
  return r;
}

let runSeq = 0;

/**
 * One target world: a library, a device (fake adb or a temp folder), the
 * record under a temp userData, and helpers to plan and apply. fresh()
 * stands for an app restart: new store, pool and transport, same disk.
 */
async function world(o = {}) {
  const kind = o.kind || "adb";
  const dir = mkdir(o.tag || kind);
  const libRoot = path.join(dir, "lib");
  buildLibrary(libRoot, o.lib || {});
  const userData = path.join(dir, "ud", "sync");
  const w = { kind, dir, libRoot, userData, transport: null, srv: null, dev: null, client: null };
  let targetRoot;
  if (kind === "adb") {
    w.srv = new FakeAdbServer(o.server || {});
    const port = await w.srv.listen();
    w.dev = w.srv.addDevice({
      serial: SERIAL,
      caseInsensitive: !!o.ci,
      features: o.features,
      inject: { symlinks: { "/sdcard": "/storage/emulated/0" }, ...(o.inject || {}) },
    });
    w.dev.fs.mkdirs(CANON);
    w.client = new AdbClient({ port, recheckMs: 20, idleMs: 5000 });
    targetRoot = LINK_ROOT;
  } else {
    targetRoot = path.join(dir, "target");
    fs.mkdirSync(targetRoot, { recursive: true });
    w.targetRoot = targetRoot;
  }
  w.target = profiles.resolveTargetConfig({
    id: "t1",
    name: "Tab",
    kind,
    serial: kind === "adb" ? SERIAL : null,
    root: targetRoot,
    profile: "komikku",
    ...(o.target || {}),
  });
  w.settings = resolveSyncSettings(o.settings || {});
  w.fresh = () => {
    if (w.transport) w.transport.destroy();
    if (w.pool) w.pool.close();
    w.queue = new store.WriteQueue(o.queueOps ? { ops: o.queueOps } : {});
    w.store = new store.RecordStore({ root: userData, targetId: "t1", queue: w.queue });
    w.pool = new hp.HashPool({ cachePath: path.join(userData, "pc-hash-cache.json"), workers: 2, queue: w.queue });
    w.transport =
      kind === "adb"
        ? new tr.AdbTransport({ client: w.client, serial: SERIAL, root: LINK_ROOT })
        : new tr.FolderTransport({ root: targetRoot, hashPool: w.pool, ...(o.folderOpts || {}) });
  };
  w.prepare = (extra = {}) =>
    prep.preparePlan({
      transport: w.transport,
      store: w.store,
      hashPool: w.pool,
      target: w.target,
      settings: w.settings,
      libraryRoot: libRoot,
      connectWaitMs: 2000,
      ...extra,
    });
  w.executor = (p, extra = {}) =>
    new ex.Executor({
      transport: w.transport,
      store: w.store,
      hashPool: w.pool,
      target: p.target,
      settings: w.settings,
      probe: p.probe,
      view: p.view,
      connectWaitMs: 2000,
      ...extra,
    });
  /** The default selection (or `select` changes) reconciled against the same plan. */
  w.ops = (p, { select, ack } = {}) => {
    const stored = select ? planner.changeSelection(p.plan, {}, { changes: select }).ops : {};
    return planner.reconcileForApply({ reviewed: p.plan, fresh: p.plan, storedOps: stored, ackLosses: ack, ackMassDelete: true, ackMassRepush: true });
  };
  w.apply = (p, { select, ack, ops, ...extra } = {}) => {
    const list = ops || w.ops(p, { select, ack }).ops;
    return w.executor(p, extra).apply({ plan: p.plan, ops: list, device: p.device, pc: p.pc, ackLosses: ack, runId: `r${++runSeq}` });
  };
  /** Plan and apply the default selection; asserts both went through. */
  w.sync = async (extra = {}) => {
    const p = await w.prepare();
    assert.ok(p.ok, `prepare refused: ${p.code} ${p.message} ${JSON.stringify(p.detail || "")}`);
    const r = await w.apply(p, extra);
    assert.strictEqual(r.status, "completed", `apply ${r.status} ${r.reason} ${r.message || ""} ${r.error || ""}`);
    return { p, r };
  };
  /** Simulated restart after a kill: let in-flight record writes land, then new instances. */
  w.restart = async () => {
    await w.queue.whenIdle();
    w.fresh();
  };
  w.devAbs = (rel) => (kind === "adb" ? `${CANON}/${rel}` : path.join(targetRoot, ...rel.split("/")));
  w.devRead = (rel) => {
    if (kind === "adb") return w.dev.fs.readFile(w.devAbs(rel));
    try {
      return fs.readFileSync(w.devAbs(rel));
    } catch (_) {
      return null;
    }
  };
  w.devNames = (rel) => {
    if (kind === "adb") return w.dev.fs.names(rel ? w.devAbs(rel) : CANON);
    try {
      return fs.readdirSync(rel ? w.devAbs(rel) : targetRoot).sort();
    } catch (_) {
      return null;
    }
  };
  w.devWrite = (rel, data, mtime = OLD_S) => {
    if (kind === "adb") return w.dev.fs.writeFile(w.devAbs(rel), data, { mtime });
    writeOld(w.devAbs(rel), data, mtime);
    return null;
  };
  w.devRmTree = (rel) => {
    if (kind === "adb") {
      for (const n of w.dev.fs.names(w.devAbs(rel)) || []) w.dev.fs.unlink(`${w.devAbs(rel)}/${n}`);
      w.dev.fs.rmdir(w.devAbs(rel));
    } else fs.rmSync(w.devAbs(rel), { recursive: true, force: true });
  };
  w.load = async () => {
    const s = new store.RecordStore({ root: userData, targetId: "t1" });
    return s.load();
  };
  /** The live shard whose name is `name` (from disk). */
  w.shard = async (name) => {
    const l = await w.load();
    return l.shards.find((s) => s.name === name && s.recordEpoch === (l.header && l.header.recordEpoch)) || null;
  };
  w.sends = () => (w.srv ? w.srv.log.filter((x) => x.kind === "sync" && x.id === "SEND").map((x) => x.sendPath) : []);
  w.close = async () => {
    if (w.transport) w.transport.destroy();
    if (w.pool) w.pool.close();
    if (w.srv) await w.srv.close();
  };
  w.fresh();
  return w;
}

function opIds(plan, kind) {
  return [...plan.ops.values()].filter((x) => !kind || x.kind === kind).map((x) => x.id).sort();
}

/** A plan with nothing to do for the default selection (re-plan stability). */
function assertSettled(p, what) {
  assert.ok(p.ok, `${what}: refused ${p.code}`);
  const pre = [...p.plan.ops.values()].filter((x) => x.preselected).map((x) => x.id);
  assert.deepStrictEqual(pre, [], `${what}: pre-selected ops remain`);
}

// =====================================================================
// store.js
// =====================================================================

console.log("store");

/** File ops with injectable faults, recording every tmp name in flight. */
function faultyOps({ renameFails = 0, code = "EBUSY", writeFails = false } = {}) {
  const log = { renames: 0, tmps: [], inFlight: new Set(), collisions: 0 };
  let left = renameFails;
  const ops = {
    ...store.REAL_OPS,
    async writeTmp(tmp, data) {
      if (writeFails) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      if (log.inFlight.has(tmp)) log.collisions += 1;
      log.inFlight.add(tmp);
      log.tmps.push(tmp);
      await sleep(1);
      return store.REAL_OPS.writeTmp(tmp, data);
    },
    async rename(a, b) {
      log.renames += 1;
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error(`${code}: busy`), { code });
      }
      log.inFlight.delete(a);
      return store.REAL_OPS.rename(a, b);
    },
    sleep: async () => {},
  };
  return { ops, log };
}

test("writeJsonAtomic: content lands, no tmp left, overwrite is whole", async () => {
  const d = mkdir("atomic");
  const f = path.join(d, "a", "x.json");
  await store.writeJsonAtomic(f, { v: 1, s: "x".repeat(10000) });
  await store.writeJsonAtomic(f, { v: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { v: 2 });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ["x.json"]);
});

test("writeJsonAtomic: EBUSY/EPERM/EACCES retried, then record-write-failed with the tmp removed", async () => {
  const d = mkdir("retry");
  const f = path.join(d, "x.json");
  const a = faultyOps({ renameFails: 4, code: "EPERM" });
  await store.writeJsonAtomic(f, { ok: 1 }, a.ops);
  assert.strictEqual(a.log.renames, 5);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ok: 1 });
  const b = faultyOps({ renameFails: 5, code: "EBUSY" });
  await assert.rejects(store.writeJsonAtomic(f, { ok: 2 }, b.ops), (e) => e instanceof store.StoreError && e.kind === "record-write-failed" && e.charges === 0);
  assert.strictEqual(b.log.renames, store.RENAME_TRIES);
  assert.deepStrictEqual(fs.readdirSync(d), ["x.json"], "tmp removed, old content kept");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ok: 1 });
  const c = faultyOps({ renameFails: 1, code: "ENOENT" });
  await assert.rejects(store.writeJsonAtomic(f, { ok: 3 }, c.ops), /record|replacing/);
  assert.strictEqual(c.log.renames, 1, "a non-retry code fails at once");
  const sync = { ...store.REAL_OPS_SYNC, rename: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, sleep: () => {} };
  assert.throws(() => store.writeJsonAtomicSync(f, { ok: 4 }, sync), (e) => e.code === "record-write-failed");
  assert.deepStrictEqual(fs.readdirSync(d), ["x.json"]);
});

test("WriteQueue: a burst coalesces to the latest content; tmp names never collide", async () => {
  const d = mkdir("queue");
  const f = path.join(d, "s.json");
  const g = path.join(d, "t.json");
  const a = faultyOps();
  const q = new store.WriteQueue({ ops: a.ops });
  const ps = [];
  for (let i = 0; i < 50; i += 1) {
    ps.push(q.write(f, { i }));
    ps.push(q.write(g, { i }));
  }
  await Promise.all(ps);
  await q.whenIdle();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { i: 49 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(g, "utf8")), { i: 49 });
  assert.ok(q.writes <= 6, `coalesced: ${q.writes} writes for 100 calls`);
  assert.strictEqual(a.log.collisions, 0);
  assert.strictEqual(new Set(a.log.tmps).size, a.log.tmps.length);
  q.abandon();
  await assert.rejects(q.write(f, { late: 1 }), (e) => e.code === "record-write-failed");
});

test("sweepTmp removes only the store's own tmp names", async () => {
  const d = mkdir("sweep");
  fs.mkdirSync(path.join(d, "targets", "t1", "folders"), { recursive: true });
  const keep = ["a.json", "a.json.corrupt", "x.tmp", "b.json.12.tmp.json"];
  const gone = ["a.json.123.4.tmp", path.join("targets", "t1", "folders", "0123456789abcdef.json.9.77.tmp")];
  for (const n of [...keep, ...gone]) fs.writeFileSync(path.join(d, n), "x");
  assert.strictEqual(await store.sweepTmp(d), 2);
  for (const n of keep) assert.ok(fs.existsSync(path.join(d, n)), n);
  for (const n of gone) assert.ok(!fs.existsSync(path.join(d, n)), n);
});

test("RecordStore: zero-length and unparsable shards set aside; no epoch, no shard write; logs keep 30", async () => {
  const d = mkdir("record");
  const s = new store.RecordStore({ root: d, targetId: "t1" });
  await assert.rejects(s.writeShard({ shardId: "0123456789abcdef", name: "A", files: new Map() }), (e) => e.code === "record-write-failed");
  assert.throws(() => new store.RecordStore({ root: d, targetId: "../x" }), TypeError);
  await s.writeHeader({ recordEpoch: "E1", kind: "adb" });
  await s.writeShard({ shardId: "aaaaaaaaaaaaaaaa", name: "A", files: new Map([["ch.001.cbz", { name: "Ch.001.cbz", size: 1 }]]) });
  fs.writeFileSync(s.shardPath("bbbbbbbbbbbbbbbb"), "");
  fs.writeFileSync(s.shardPath("cccccccccccccccc"), "{not json");
  const l = await new store.RecordStore({ root: d, targetId: "t1" }).load();
  assert.deepStrictEqual(l.shards.map((x) => x.shardId), ["aaaaaaaaaaaaaaaa"]);
  assert.strictEqual(l.shards[0].recordEpoch, "E1");
  assert.deepStrictEqual(l.corrupt.map((x) => x.shardId).sort(), ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"]);
  assert.ok(fs.existsSync(`${s.shardPath("bbbbbbbbbbbbbbbb")}.corrupt`));
  for (let i = 0; i < 33; i += 1) await s.writeLog({ runId: `r${i}`, startedAt: Date.UTC(2026, 0, 1, 0, 0, i) });
  assert.strictEqual(fs.readdirSync(s.logsDir).length, store.LOGS_KEPT);
  assert.ok(!fs.readdirSync(s.logsDir).some((n) => n.endsWith("-r0.json")), "oldest dropped");
  await s.updateHeader({ firstApplyAt: 5 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.headerPath, "utf8")), { recordEpoch: "E1", kind: "adb", firstApplyAt: 5 });
});

// =====================================================================
// hash-pool.js
// =====================================================================

console.log("hash pool");

function libFiles(dir, specs) {
  return specs.map(([name, size]) => {
    const p = path.join(dir, name);
    writeOld(p, bytes(name, size));
    const st = fs.statSync(p, { bigint: true });
    return { path: p, size, mtimeNs: String(st.mtimeNs), data: bytes(name, size) };
  });
}

test("workers hash like crypto; the cache answers by (size, mtimeNs); rehash re-reads; flush/load/prune", async () => {
  const d = mkdir("pool");
  const files = libFiles(d, [["a.cbz", 0], ["b.cbz", 1], ["c.cbz", 3 * 1024 * 1024 + 7], ["d.cbz", 1024 * 1024]]);
  const cache = path.join(d, "cache.json");
  const pool = new hp.HashPool({ cachePath: cache, workers: 3 });
  const r1 = await pool.hashFiles(files);
  for (const f of files) assert.strictEqual(r1.get(f.path).sha256, sha(f.data), f.path);
  assert.strictEqual(pool.stats.hashed, 4);
  assert.strictEqual(pool.stats.mainThread, 0, "workers did the work");
  const r2 = await pool.hashFiles(files);
  assert.strictEqual(pool.stats.hits, 4);
  assert.strictEqual(r2.get(files[2].path).size, files[2].size);
  await pool.hashFiles(files, { mode: "rehash" });
  assert.strictEqual(pool.stats.hashed, 8);
  await pool.flush();
  pool.close();
  const pool2 = new hp.HashPool({ cachePath: cache, workers: 1 });
  await pool2.load();
  assert.strictEqual(pool2.lookup(files[1].path, files[1].size, files[1].mtimeNs), sha(files[1].data));
  assert.strictEqual(pool2.lookup(files[1].path, files[1].size, "1"), null, "another mtime misses");
  pool2.prune([files[0].path]);
  assert.strictEqual(pool2.lookup(files[1].path, files[1].size, files[1].mtimeNs), null);
  pool2.recordObserved(files[3].path, { size: 9, mtimeNs: "77", sha256: "f".repeat(64) });
  assert.strictEqual(pool2.lookup(files[3].path, 9, "77"), "f".repeat(64));
  pool2.close();
});

test("a worker that can't start or dies: the main thread finishes every task; per-file errors stay per file", async () => {
  const d = mkdir("fallback");
  const files = libFiles(d, [["a.cbz", 100], ["b.cbz", 200], ["c.cbz", 300]]);
  const missing = { path: path.join(d, "missing.cbz"), size: 5, mtimeNs: "1" };
  // One task alone (folder read-back): nothing else would flush the queue.
  const p0 = new hp.HashPool({ workers: 1, workerFactory: () => { throw new Error("no threads"); } });
  const one = await within(p0.hashFile(files[0].path), 5000, "a single task after a failed worker start");
  assert.strictEqual(one.sha256, sha(files[0].data));
  p0.close();
  const p1 = new hp.HashPool({ workers: 2, workerFactory: () => { throw new Error("no threads"); } });
  const r1 = await within(p1.hashFiles([...files, missing]), 10000, "fallback hashing");
  for (const f of files) assert.strictEqual(r1.get(f.path).sha256, sha(f.data));
  assert.strictEqual(r1.get(missing.path).error, "ENOENT");
  assert.strictEqual(p1.fallback, true);
  p1.close();
  const { Worker } = require("worker_threads");
  const p2 = new hp.HashPool({ workers: 1, workerFactory: () => new Worker("process.exit(3)", { eval: true }) });
  const r2 = await within(p2.hashFiles(files), 10000, "hashing after a worker death");
  for (const f of files) assert.strictEqual(r2.get(f.path).sha256, sha(f.data));
  assert.ok(p2.stats.workerDeaths >= 1 && p2.stats.mainThread >= 1);
  p2.close();
  assert.strictEqual(hp.workerCountFor(50, 8), 4);
  assert.strictEqual(hp.workerCountFor(10, 4), 1);
});

test("a file that changes while hashed answers 'changed' and isn't cached; an abort throws cancelled", async () => {
  const d = mkdir("changed");
  const files = libFiles(d, [["a.cbz", 10]]);
  const fakeWorker = () => {
    const EventEmitter = require("events");
    const w = new EventEmitter();
    w.postMessage = (m) => setImmediate(() => w.emit("message", { id: m.id, changed: true, sha256: "0".repeat(64), size: 10, mtimeNs: files[0].mtimeNs }));
    w.terminate = () => {};
    return w;
  };
  const pool = new hp.HashPool({ workers: 1, workerFactory: fakeWorker });
  const r = await pool.hashFiles(files);
  assert.strictEqual(r.get(files[0].path).error, "changed");
  assert.strictEqual(pool.lookup(files[0].path, 10, files[0].mtimeNs), null);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(pool.hashFiles(files, { signal: ac.signal }), (e) => e.kind === "cancelled");
  pool.close();
});

// =====================================================================
// pc-inventory.js
// =====================================================================

console.log("inventory");

test("walkLibrary: shape, dot files skipped, identity from .aio_series.json, image-only, malformed JSON, failures", async () => {
  const d = mkdir("inv");
  buildLibrary(d, {
    "Alpha [mf-ab12]": { meta: { url: ["https://mangafire.to/manga/alpha.ab12", "x"], title: " Alpha ", anilist_id: 77, anilist_synonyms: ["A", 3] }, files: { "Ch.001.cbz": 10, "cover.jpg": 5 } },
    Imgs: { files: {} },
    Bad: { meta: null, files: { "details.json": Buffer.from("{oops"), "Ch.002.cbz": 4 } },
  });
  fs.writeFileSync(path.join(d, "Alpha [mf-ab12]", ".mangafire_hid"), "x");
  fs.mkdirSync(path.join(d, "Alpha [mf-ab12]", "sub"));
  fs.mkdirSync(path.join(d, "Imgs", "images"));
  fs.writeFileSync(path.join(d, "Bad", ".aio_series.json"), "[1,2]");
  fs.mkdirSync(path.join(d, ".hidden"));
  fs.writeFileSync(path.join(d, "loose.cbz"), "x");
  const r = await inv.walkLibrary(d);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.series.map((s) => s.folder), ["Alpha [mf-ab12]", "Bad", "Imgs"]);
  const a = r.series[0];
  assert.deepStrictEqual(a.files.map((f) => f.name), ["Ch.001.cbz", "cover.jpg"]);
  assert.strictEqual(a.url, "https://mangafire.to/manga/alpha.ab12");
  assert.strictEqual(a.title, "Alpha");
  assert.strictEqual(a.anilistId, "77");
  assert.deepStrictEqual(a.synonyms, ["A"]);
  assert.ok(a.identityKey, "identity key derived");
  assert.ok(/^\d+$/.test(a.files[0].mtimeNs) && a.files[0].size === 10 && a.files[0].path === path.join(d, "Alpha [mf-ab12]", "Ch.001.cbz"));
  assert.deepStrictEqual(r.series[1].malformedJson.sort(), [".aio_series.json", "details.json"]);
  assert.strictEqual(r.series[2].imageOnly, true);
  assert.strictEqual((await inv.walkLibrary(path.join(d, "nope"))).error, "missing");
  assert.strictEqual((await inv.walkLibrary(path.join(d, "loose.cbz"))).error, "not-a-directory");
  assert.strictEqual((await inv.walkLibrary("")).error, "no-root");
  const fsp = { ...fs.promises, readdir: async (p, o) => (p.endsWith("Bad") ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) : fs.promises.readdir(p, o)) };
  const r2 = await inv.walkLibrary(d, { fsp });
  const bad = r2.series.find((s) => s.folder === "Bad");
  assert.strictEqual(bad.readError, "EACCES");
  assert.deepStrictEqual(bad.files, []);
  assert.ok(r2.warnings.some((w) => w.kind === "folder-unreadable"));
});

// =====================================================================
// transports.js — paths, quoting, probe, listings
// =====================================================================

console.log("transports");

test("validatePath / segmentProblem / shq against hostile names", () => {
  const hostile = ["a'b", "$(reboot)", "`id`", "a b", "x;rm -rf /", "-rf", "日本語 'quote' \"dq\"", "back\\slash", "*?[]"];
  for (const h of hostile) {
    const toks = tokenize(`echo ${tr.shq(h)}`);
    assert.deepStrictEqual(toks.map((t) => t.w), ["echo", h], h);
  }
  assert.throws(() => tr.shq("a\0b"));
  for (const bad of ["", ".", "..", "a/b", "a\nb", "a\0b", "x".repeat(256)]) assert.ok(tr.segmentProblem(bad), JSON.stringify(bad));
  assert.strictEqual(tr.segmentProblem("é".repeat(127)), null, "254 bytes is fine");
  assert.ok(tr.segmentProblem("é".repeat(128)), "256 bytes is not");
  assert.strictEqual(tr.validatePath(CANON, `${CANON}/A/b.cbz`), null);
  assert.ok(tr.validatePath(CANON, `${CANON}/../x`));
  assert.ok(tr.validatePath(CANON, `/other/x`));
  assert.ok(tr.validatePath(CANON, `${CANON}X/a.cbz`), "a sibling sharing the root's prefix (DocumentsX)");
  assert.ok(tr.validatePath(CANON, `${CANON}/a\nb`));
  assert.ok(tr.validatePath(CANON, `${CANON}/${"a".repeat(1020)}`));
  assert.strictEqual(tr.flipAsciiCase("Ab1"), "aB1");
  assert.strictEqual(tr.flipAsciiCase("123"), null);
});

async function adbOnly(o = {}) {
  const w = await world({ kind: "adb", ...o });
  return w;
}

test("probe: realpath canonical root, caps, read-only case probe (CS, CI, empty root assumed CI)", async () => {
  for (const ci of [false, true]) {
    const w = await adbOnly({ ci });
    try {
      w.dev.fs.writeFile(`${CANON}/Alpha/Ch.001.cbz`, "x", { mtime: OLD_S });
      const before = w.srv.log.length;
      const p = await w.transport.probe();
      assert.strictEqual(p.canonicalRoot, CANON);
      assert.deepStrictEqual(p.caps, { lsV2: true, statV2: true, shellV2: true, sha256sum: true, findPrintf: false, statC: false, statF: true, df: false });
      assert.strictEqual(p.caseInsensitive, ci);
      assert.strictEqual(p.caseMeasured, true);
      const after = w.srv.log.slice(before);
      assert.ok(!after.some((x) => x.kind === "sync" && x.id === "SEND"), "no SEND");
      const shells = after.filter((x) => x.kind === "shell").map((x) => x.cmd || x.command || "");
      assert.ok(!shells.some((c) => /\b(mkdir|mv|rm|touch|rmdir)\b/.test(c)), `no writing command: ${shells.join(" | ")}`);
      assert.deepStrictEqual(w.dev.fs.names(CANON), ["Alpha"]);
    } finally {
      await w.close();
    }
  }
  const e = await adbOnly({ ci: false });
  try {
    const p = await e.transport.probe();
    assert.strictEqual(p.caseInsensitive, true, "nothing to flip: assumed case-insensitive");
    assert.strictEqual(p.caseMeasured, false);
  } finally {
    await e.close();
  }
});

test("caps fall back: no sha256sum, no ls_v2 → find -printf, then stat -c; no stat -f → df; neither → null", async () => {
  const noLs = DEFAULT_FEATURES.filter((f) => f !== "ls_v2");
  const cases = [
    { features: noLs, tools: {}, method: "find-printf" },
    { features: noLs, tools: { findPrintf: false }, method: "stat-c" },
  ];
  for (const c of cases) {
    const w = await adbOnly({ features: c.features, inject: { tools: { sha256sum: false, statF: false, ...c.tools } } });
    try {
      w.dev.fs.writeFile(`${CANON}/A/Ch.001.cbz`, bytes("x", 70000), { mtime: OLD_S });
      w.dev.fs.writeFile(`${CANON}/A/it's | odd.cbz`, "", { mtime: OLD_S });
      const p = await w.transport.probe();
      assert.strictEqual(p.caps.sha256sum, false);
      assert.strictEqual(p.caps.df, true);
      const l = await w.transport.listFolder("A");
      assert.ok(l.ok, l.error);
      assert.strictEqual(l.method, c.method);
      assert.deepStrictEqual(l.files.map((f) => [f.name, f.size, f.devMtime]), [["Ch.001.cbz", 70000, OLD_S], ["it's | odd.cbz", 0, OLD_S]]);
      assert.ok((await w.transport.freeSpace()) > 0);
    } finally {
      await w.close();
    }
  }
  const w = await adbOnly({ inject: { tools: { statF: false, df: false } } });
  try {
    assert.strictEqual(await w.transport.freeSpace(), null);
  } finally {
    await w.close();
  }
});

test("quiet failures: a missing or locked folder lists as not ok (STA2 first), never as empty", async () => {
  const w = await adbOnly({ inject: { locked: { prefix: `${CANON}/Locked`, errno: wire.ERRNO.EACCES } } });
  try {
    w.dev.fs.mkdirs(`${CANON}/Locked`);
    w.dev.fs.writeFile(`${CANON}/Locked/Ch.001.cbz`, "x");
    assert.strictEqual((await w.transport.listFolder("Missing")).ok, false);
    const l = await w.transport.listFolder("Locked");
    assert.strictEqual(l.ok, false);
    assert.strictEqual(l.error, `errno-${wire.ERRNO.EACCES}`);
  } finally {
    await w.close();
  }
});

test("shell listing right after a push sees the DONE mtime (same-session STA2 waits for lutimes)", async () => {
  const noLs = DEFAULT_FEATURES.filter((f) => f !== "ls_v2");
  // The fake's clock stamps creation at 1000 s; DONE carries the host's
  // now, which adbd applies with lutimes after OKAY (300 ms late here).
  const w = await adbOnly({ features: noLs, inject: { lutimesDelayMs: 300 }, server: { now: () => 1000 } });
  try {
    const src = path.join(w.dir, "src.cbz");
    writeOld(src, bytes("p", 5000));
    await w.transport.probe();
    w.dev.fs.mkdirs(`${CANON}/A`);
    const t0 = Math.trunc(Date.now() / 1000);
    await w.transport.push({ rel: "A/Ch.001.cbz", pcPath: src });
    const l = await w.transport.listFolder("A", { afterPush: true });
    assert.strictEqual(l.method, "find-printf");
    assert.ok(l.files[0].devMtime >= t0, `listing reflects lutimes: ${l.files[0].devMtime}`);
    // Without the same-session STA2 the shell would have seen the creation time.
    w.dev.fs.writeFile(`${CANON}/A/x.cbz`, "x", { mtime: 1000 });
    const raw = await w.transport._sh(`find ${tr.shq(`${CANON}/A`)} -mindepth 1 -maxdepth 1 -printf '%T@ %f\\n'`);
    assert.ok(/^1000\.0+ x\.cbz$/m.test(raw.stdout.toString()), raw.stdout.toString());
  } finally {
    await w.close();
  }
});

test("chunked rm stays under the shell cap and removes every file; move refuses an existing destination", async () => {
  const w = await adbOnly();
  try {
    await w.transport.probe();
    const names = [];
    for (let i = 0; i < 60; i += 1) {
      const n = `Long chapter name number ${i} ${"x".repeat(60)}.cbz`;
      names.push(`F/${n}`);
      w.dev.fs.writeFile(`${CANON}/F/${n}`, "x");
    }
    const before = w.srv.log.length;
    const r = await w.transport.remove(names);
    assert.ok(r.ok && r.sent, JSON.stringify(r));
    const cmds = w.srv.log.slice(before).filter((x) => x.kind === "shell").map((x) => x.cmd || x.command);
    assert.ok(cmds.length >= 2, `chunked: ${cmds.length} commands`);
    for (const c of cmds) assert.ok(Buffer.byteLength(c) <= tr.SHELL_CMD_MAX, `command of ${Buffer.byteLength(c)} bytes`);
    assert.deepStrictEqual(w.dev.fs.names(`${CANON}/F`), []);
    w.dev.fs.writeFile(`${CANON}/F/a.cbz`, "a");
    w.dev.fs.writeFile(`${CANON}/F/b.cbz`, "b");
    assert.deepStrictEqual(await w.transport.move("F/a.cbz", "F/b.cbz"), { ok: false, reason: "destination-exists" });
    assert.strictEqual(w.dev.fs.readFile(`${CANON}/F/b.cbz`).toString(), "b");
    assert.deepStrictEqual(await w.transport.move("F/zz.cbz", "F/c.cbz"), { ok: false, reason: "source-missing" });
    const missing = await w.transport.remove(["F/nope.cbz"]);
    assert.strictEqual(missing.ok, false, "rm without -f reports a missing file");
  } finally {
    await w.close();
  }
});

test("freeSpaceNeeded: adb counts growth; a folder adds the largest update's temp", () => {
  const ops = [
    { kind: "push", size: 100 },
    { kind: "update", size: 300, devFile: { size: 250 } },
    { kind: "replace", size: 50, devFile: { size: 80 } },
  ];
  const adb = Object.create(tr.AdbTransport.prototype);
  const folder = Object.create(tr.FolderTransport.prototype);
  assert.strictEqual(adb.freeSpaceNeeded(ops), 150);
  assert.strictEqual(folder.freeSpaceNeeded(ops), 450);
});

test("FolderTransport: temp + rename, failed source leaves no temp, sweep, presence single-flight and timeout", async () => {
  const d = mkdir("folder");
  const root = path.join(d, "t");
  fs.mkdirSync(path.join(root, "A"), { recursive: true });
  const pool = new hp.HashPool({ workers: 1 });
  const t = new tr.FolderTransport({ root, hashPool: pool });
  const src = path.join(d, "s.cbz");
  writeOld(src, bytes("s", 3 * 1024 * 1024 + 3));
  const p = await t.probe();
  assert.strictEqual(p.canonicalRoot, fs.realpathSync(root));
  assert.ok(p.volumeId);
  const r = await t.push({ rel: "A/Ch.001.cbz", pcPath: src });
  assert.strictEqual(r.sha256, sha(fs.readFileSync(src)));
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "A")), ["Ch.001.cbz"]);
  await assert.rejects(t.push({ rel: "A/Ch.002.cbz", pcPath: path.join(d, "missing") }), (e) => e.source === true);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "A")), ["Ch.001.cbz"]);
  fs.writeFileSync(path.join(root, "A", `${tr.FOLDER_TMP_PREFIX}deadbeef`), "x");
  assert.strictEqual(await t.sweepLeftovers("A"), 1);
  const l = await t.listFolder("A");
  assert.deepStrictEqual(l.files.map((f) => f.name), ["Ch.001.cbz"]);
  const vb = await t.readBack("A/Ch.001.cbz");
  assert.deepStrictEqual([vb.ok, vb.sha256], [true, r.sha256]);
  let stats = 0;
  const slow = new tr.FolderTransport({
    root,
    presenceTimeoutMs: 100,
    fsp: { ...fs.promises, stat: () => { stats += 1; return new Promise(() => {}); } },
  });
  const [a, b] = [slow.checkPresence(), slow.checkPresence()];
  assert.strictEqual(a, b, "one check in flight");
  assert.deepStrictEqual(await a, { present: false, timedOut: true });
  assert.strictEqual(stats, 1);
  assert.deepStrictEqual(await t.checkPresence(), { present: true, timedOut: false });
  pool.close();
});

// =====================================================================
// executor.js + prepare.js — end to end against the fake device
// =====================================================================

console.log("executor + prepare");

const LIB = {
  Alpha: { files: { "Ch.001.cbz": 3000, "Ch.002.cbz": 5000, "cover.jpg": 400, "details.json": Buffer.from('{"title":"Alpha"}') } },
  Beta: { files: { "Ch.001.cbz": 2000, "Ch.002.cbz": 2100 } },
};

/** The entry recorded for `name` in a shard read from disk. */
function entry(sh, name) {
  return sh ? Object.values(sh.files || {}).find((e) => e.name === name) || null : null;
}

function pcPath(w, folder, name) {
  return path.join(w.libRoot, folder, name);
}

/** Rewrite a PC file (new content), keeping it old enough to plan. */
function pcWrite(w, folder, name, data, mtimeS = OLD_S + 60) {
  writeOld(pcPath(w, folder, name), data, mtimeS);
}

for (const kind of ["adb", "folder"]) {
  test(`${kind}: first sync pushes everything, .nomedia, created shards; the re-plan is settled`, async () => {
    const w = await world({ kind, lib: LIB });
    try {
      const p = await w.prepare();
      assert.ok(p.ok, p.code);
      assert.strictEqual(p.plan.firstSync, true);
      assert.deepStrictEqual(opIds(p.plan, "push"), [
        "push:Alpha/Ch.001.cbz",
        "push:Alpha/Ch.002.cbz",
        "push:Alpha/cover.jpg",
        "push:Alpha/details.json",
        "push:Beta/Ch.001.cbz",
        "push:Beta/Ch.002.cbz",
      ]);
      const r = await w.apply(p);
      assert.strictEqual(r.status, "completed", `${r.reason} ${r.error || ""}`);
      assert.strictEqual(r.filesDone, 6);
      assert.strictEqual(r.bytesDone, 3000 + 5000 + 400 + 17 + 2000 + 2100);
      for (const [f, n] of [["Alpha", "Ch.002.cbz"], ["Beta", "Ch.001.cbz"], ["Alpha", "details.json"]]) {
        assert.ok(w.devRead(`${f}/${n}`).equals(fs.readFileSync(pcPath(w, f, n))), `${f}/${n}`);
      }
      assert.ok(w.devRead(".nomedia") !== null, ".nomedia written");
      const l = await w.load();
      assert.ok(l.header.firstApplyAt > 0);
      assert.strictEqual(l.header.kind, kind);
      if (kind === "folder") assert.strictEqual(l.header.volumeId, String(fs.statSync(w.targetRoot).dev));
      const a = await w.shard("Alpha");
      assert.strictEqual(a.verifyMode, "created");
      const e = entry(a, "Ch.002.cbz");
      assert.deepStrictEqual([e.origin, e.size, e.sha256, typeof e.devMtime], ["pushed", 5000, sha(fs.readFileSync(pcPath(w, "Alpha", "Ch.002.cbz"))), "number"]);
      assert.ok(fs.readdirSync(path.join(w.userData, "targets", "t1", "logs")).length >= 1, "run log");
      await w.restart();
      const p2 = await w.prepare();
      assertSettled(p2, "re-plan");
      assert.strictEqual(p2.plan.firstSync, false);
      assert.ok(w.pool.stats.hits >= 6, "PC hashes came from the cache");
    } finally {
      await w.close();
    }
  });
}

test("a coverage Verify on a first sync doesn't end the first sync (weak matches still block)", async () => {
  const w = await world({ lib: { Alpha: LIB.Alpha, "SPY x FAMILY": { files: { "Ch.001.cbz": 900 } } } });
  try {
    for (const n of ["Ch.001.cbz", "Ch.002.cbz"]) w.devWrite(`Alpha/${n}`, fs.readFileSync(pcPath(w, "Alpha", n)));
    w.dev.fs.mkdirs(`${CANON}/SPY_x_FAMILY`);
    const p = await w.prepare();
    assert.ok(p.ok, p.code);
    assert.ok(p.verify && p.verify.folders.some((x) => x.folder === "Alpha" && x.outcome === "verified"));
    assert.strictEqual(p.plan.firstSync, true, "still the first sync after Verify wrote shards");
    assert.strictEqual(p.plan.ops.get("push:SPY x FAMILY/Ch.001.cbz").preselected, false, "the name match blocks");
    const sh = await w.shard("Alpha");
    assert.strictEqual(entry(sh, "Ch.001.cbz").origin, "adopted");
  } finally {
    await w.close();
  }
});

test("an interrupted in-place update leaves the slot empty; the re-plan re-pushes it", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    pcWrite(w, "Alpha", "Ch.002.cbz", bytes("Ch.002.cbz", 6000, 2));
    await w.restart();
    const p = await w.prepare();
    const up = p.plan.ops.get("update:Alpha/Ch.002.cbz");
    assert.ok(up && up.preselected, "update pre-selected");
    w.dev.inject.unplugAfterBytes = w.dev.dataBytes + 1500;
    const r = await w.apply(p);
    assert.strictEqual(r.status, "disconnected");
    const mid = await w.shard("Alpha");
    assert.strictEqual(entry(mid, "Ch.002.cbz").origin, "pending");
    assert.strictEqual(w.devRead("Alpha/Ch.002.cbz"), null, "adbd unlinked the partial");
    w.dev.inject.unplugAfterBytes = 0;
    w.srv.replug(w.dev);
    await w.restart();
    const p2 = await w.prepare();
    assert.ok(p2.ok, p2.code);
    const op = p2.plan.ops.get("push:Alpha/Ch.002.cbz");
    assert.ok(op && op.preselected, "re-push pre-selected");
    assert.strictEqual(entry(await w.shard("Alpha"), "Ch.002.cbz"), null, "pending entry dropped");
    await w.apply(p2);
    assert.ok(w.devRead("Alpha/Ch.002.cbz").equals(bytes("Ch.002.cbz", 6000, 2)));
    await w.restart();
    assertSettled(await w.prepare(), "after re-push");
  } finally {
    await w.close();
  }
});

test("kill before SEND on a replace of a file the app never wrote: the slot reads as before, never as ours (prevObserved)", async () => {
  const w = await world({ lib: { Alpha: { files: { "Ch.001.cbz": 3000 } } } });
  try {
    // A foreign file Verify recorded (prev is that entry), and an unverified
    // one that appeared on the device after the folder was verified (no prev).
    w.devWrite("Alpha/Ch.001.cbz", bytes("foreign", 2500));
    const p0 = await w.prepare();
    assert.ok(p0.ok, p0.code);
    assert.strictEqual(entry(await w.shard("Alpha"), "Ch.001.cbz").origin, "foreign");
    pcWrite(w, "Alpha", "Ch.002.cbz", bytes("Ch.002.cbz", 4000));
    w.devWrite("Alpha/Ch.002.cbz", bytes("tablet", 3500));
    await w.restart();
    const p = await w.prepare();
    const ids = ["replace:Alpha/Ch.001.cbz", "replace:Alpha/Ch.002.cbz"];
    for (const id of ids) assert.ok(p.plan.ops.get(id) && !p.plan.ops.get(id).preselected, id);
    for (const [i, id] of ids.entries()) {
      const k = killAt("before-send", (c) => c.opId === id);
      w.apply(i === 0 ? p : await w.prepare(), { select: [{ opId: id, selected: true }], hooks: k.hooks });
      await within(k.reached, 5000, `before-send ${id}`);
      await w.restart();
    }
    const q = await w.prepare();
    const sh = await w.shard("Alpha");
    assert.strictEqual(entry(sh, "Ch.001.cbz").origin, "foreign", "restored, not partial");
    assert.strictEqual(entry(sh, "Ch.002.cbz"), null, "still unrecorded (unverified), not partial");
    for (const id of ids) assert.strictEqual(q.plan.ops.get(id).preselected, false, id);
    assert.ok(!w.sends().some((x) => /Alpha\/Ch\.00[12]\.cbz$/.test(x)), "nothing was sent");
  } finally {
    await w.close();
  }
});

test("kill after OKAY: the pending entry resolves by one RECV to pushed", async () => {
  const w = await world({ lib: LIB });
  try {
    const p = await w.prepare();
    const k = killAt("after-okay", (c) => c.name === "Ch.002.cbz" && c.folder === "Beta");
    w.apply(p, { hooks: k.hooks });
    await within(k.reached, 10000, "after-okay");
    await w.restart();
    const recvBefore = w.srv.log.filter((x) => x.kind === "sync" && x.id === "RECV").length;
    const p2 = await w.prepare();
    assert.ok(p2.ok, p2.code);
    // details.json reads are the adoption metadata, not pending resolution.
    const recvs = w.srv.log.filter((x) => x.kind === "sync" && x.id === "RECV").slice(recvBefore).filter((x) => !x.path.endsWith(".json"));
    assert.deepStrictEqual(recvs.map((x) => x.path), [`${CANON}/Beta/Ch.002.cbz`]);
    const e = entry(await w.shard("Beta"), "Ch.002.cbz");
    assert.strictEqual(e.origin, "pushed");
    assert.strictEqual(typeof e.devMtime, "number");
    assertSettled(p2, "after RECV resolution");
  } finally {
    await w.close();
  }
});

test("kill after the pushed write (before the listing): the next listing adopts devMtime; settled", async () => {
  const w = await world({ lib: LIB });
  try {
    const p = await w.prepare();
    const k = killAt("before-listing", (c) => c.folder === "Alpha");
    w.apply(p, { hooks: k.hooks });
    await within(k.reached, 10000, "before-listing");
    await w.restart();
    const mid = await w.shard("Alpha");
    assert.ok(Object.values(mid.files).every((e) => e.origin === "pushed" && e.devMtime == null));
    const p2 = await w.prepare();
    assert.ok(p2.plan.entryFixes.length >= 4);
    const fixed = await w.shard("Alpha");
    assert.ok(Object.values(fixed.files).every((e) => typeof e.devMtime === "number"), "fixes persisted");
    const pre = [...p2.plan.ops.values()].filter((x) => x.preselected).map((x) => x.id);
    assert.deepStrictEqual(pre, ["push:Beta/Ch.001.cbz", "push:Beta/Ch.002.cbz"], "only the series never reached");
  } finally {
    await w.close();
  }
});

test("cancel mid-file: run cancelled, entry pending, the re-plan re-pushes it", async () => {
  const w = await world({ lib: { Alpha: { files: { "Ch.001.cbz": 6 * 1024 * 1024 } } }, inject: { bytesPerSec: 8 * 1024 * 1024 } });
  try {
    const p = await w.prepare();
    const ac = new AbortController();
    const run = w.apply(p, { signal: ac.signal, onProgress: (ev) => ev.bytesDone > 1024 * 1024 && ac.abort() });
    const r = await within(run, 10000, "cancel");
    assert.strictEqual(r.status, "cancelled");
    await w.restart();
    w.dev.inject.bytesPerSec = 0;
    const p2 = await w.prepare();
    assert.ok(p2.plan.ops.get("push:Alpha/Ch.001.cbz").preselected);
    await w.apply(p2);
    assert.strictEqual(w.devRead("Alpha/Ch.001.cbz").length, 6 * 1024 * 1024);
  } finally {
    await w.close();
  }
});

test("a zero-length shard is set aside; its folder is verified again and adopted; stale epochs are GC'd, never against a bad header", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    const a = await w.shard("Alpha");
    const file = path.join(w.userData, "targets", "t1", "folders", `${a.shardId}.json`);
    fs.writeFileSync(file, "");
    const stale = path.join(w.userData, "targets", "t1", "folders", "0000000000000001.json");
    fs.writeFileSync(stale, JSON.stringify({ recordEpoch: "old", name: "Zed", files: {} }));
    await w.restart();
    const p = await w.prepare();
    assert.ok(p.ok, p.code);
    assert.ok(p.warnings.some((x) => x.kind === "shard-corrupt"));
    assert.ok(fs.existsSync(`${file}.corrupt`));
    assert.ok(!fs.existsSync(stale), "stale shard GC'd");
    const again = await w.shard("Alpha");
    assert.ok(again && again.shardId !== a.shardId);
    assert.strictEqual(entry(again, "Ch.001.cbz").origin, "adopted");
    assertSettled(p, "after re-verify");
    fs.writeFileSync(stale, JSON.stringify({ recordEpoch: "old", name: "Zed", files: {} }));
    fs.writeFileSync(path.join(w.userData, "targets", "t1", "header.json"), "{broken");
    await w.restart();
    const p2 = await w.prepare();
    assert.ok(p2.warnings.some((x) => x.kind === "header-corrupt"));
    assert.ok(fs.existsSync(stale), "no GC without a valid header");
    assert.ok(fs.existsSync(path.join(w.userData, "targets", "t1", "folders", `${again.shardId}.json`)), "live shards kept too");
  } finally {
    await w.close();
  }
});

test("folder rename intents: killed before the mv → reverted; after the mv → finished", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    for (const [point, name] of [["rename-before-mv", "Alpha"], ["rename-after-mv", "Alpha2"]]) {
      const p = await w.prepare();
      const sh = await w.shard("Alpha");
      const k = killAt(point);
      w.executor(p, { hooks: k.hooks }).renameFolder({ shardId: sh.shardId, to: "Alpha2" });
      await within(k.reached, 5000, point);
      await w.restart();
      const p2 = await w.prepare();
      assert.ok(p2.ok, p2.code);
      const now = (await w.load()).shards.find((x) => x.shardId === sh.shardId);
      assert.strictEqual(now.name, name, point);
      assert.ok(!now.renameIntent, "intent cleared");
      assertSettled(p2, point);
      if (name === "Alpha2") break;
    }
    assert.ok(w.devNames("").includes("Alpha2"));
  } finally {
    await w.close();
  }
});

test("case-only folder rename on case-insensitive storage goes through a temp; killed mid-way, the next plan finishes it", async () => {
  const w = await world({ ci: true, lib: LIB });
  try {
    await w.sync();
    const p = await w.prepare();
    const sh = await w.shard("Alpha");
    const k = killAt("rename-mid");
    w.executor(p, { hooks: k.hooks }).renameFolder({ shardId: sh.shardId, to: "ALPHA" });
    const ctx = await within(k.reached, 5000, "rename-mid");
    assert.ok(/^\.aio-rename-[0-9a-f]{12}$/.test(ctx.via));
    assert.ok(w.devNames("").includes(ctx.via));
    await w.restart();
    const p2 = await w.prepare();
    assert.ok(p2.ok, p2.code);
    assert.ok(w.devNames("").includes("ALPHA") && !w.devNames("").includes(ctx.via));
    assert.strictEqual((await w.load()).shards.find((x) => x.shardId === sh.shardId).name, "ALPHA");
    assertSettled(p2, "after finishing");
    const busy = await w.executor(p2).renameFolder({ shardId: sh.shardId, to: "Beta" });
    assert.strictEqual(busy.status, "failed");
    assert.strictEqual(busy.reason, "rename-refused-destination-exists");
    const after = (await w.load()).shards.find((x) => x.shardId === sh.shardId);
    assert.strictEqual(after.name, "ALPHA");
    assert.ok(!after.renameIntent);
  } finally {
    await w.close();
  }
});

test("rename-to-match: intent first; a kill before or mid-way (case-only via temp) resolves from the folder listing", async () => {
  const w = await world({ ci: true, lib: LIB, target: { renameToMatch: true } });
  try {
    await w.sync();
    // A PC-side rename keeping the content: the device copy is kept under its old name.
    fs.renameSync(pcPath(w, "Alpha", "Ch.002.cbz"), pcPath(w, "Alpha", "Ch.002 (v2).cbz"));
    // A case-only rename: same slot on this storage, so through a temp name.
    fs.renameSync(pcPath(w, "Beta", "Ch.001.cbz"), pcPath(w, "Beta", "tmp"));
    fs.renameSync(pcPath(w, "Beta", "tmp"), pcPath(w, "Beta", "CH.001.cbz"));
    await w.restart();
    const p = await w.prepare();
    const ren = opIds(p.plan, "rename");
    assert.deepStrictEqual(ren, ["rename:Alpha/Ch.002.cbz->Ch.002 (v2).cbz", "rename:Beta/Ch.001.cbz->CH.001.cbz"]);
    assert.strictEqual(p.plan.ops.get(ren[1]).viaTemp, true);
    const select = ren.map((id) => ({ opId: id, selected: true }));
    const k1 = killAt("rename-before-mv", (c) => c.folder === "Alpha");
    w.apply(p, { select, hooks: k1.hooks });
    await within(k1.reached, 5000, "rename-before-mv");
    await w.restart();
    let q = await w.prepare();
    assert.ok(!(await w.shard("Alpha")).renameIntent, "not started: cleared");
    assert.ok(w.devNames("Alpha").includes("Ch.002.cbz"));
    const k2 = killAt("rename-mid", (c) => c.folder === "Beta");
    w.apply(q, { select, hooks: k2.hooks });
    const ctx = await within(k2.reached, 5000, "rename-mid");
    assert.ok(w.devNames("Beta").includes(ctx.via));
    await w.restart();
    q = await w.prepare();
    assert.ok(q.ok, q.code);
    assert.deepStrictEqual(w.devNames("Beta"), ["CH.001.cbz", "Ch.002.cbz"]);
    const b = await w.shard("Beta");
    assert.ok(!b.renameIntent);
    assert.strictEqual(entry(b, "CH.001.cbz").origin, "pushed");
    assert.deepStrictEqual(w.devNames("Alpha").filter((n) => n.startsWith("Ch.002")), ["Ch.002 (v2).cbz"], "the Alpha rename ran before the kill");
    assert.strictEqual(entry(await w.shard("Alpha"), "Ch.002 (v2).cbz").origin, "pushed");
    assertSettled(q, "renames resolved");
  } finally {
    await w.close();
  }
});

test("a failed record write stops the SEND (no push without intent)", async () => {
  let failFolders = false;
  const queueOps = {
    ...store.REAL_OPS,
    async rename(a, b) {
      if (failFolders && /folders/.test(b)) throw Object.assign(new Error("locked by AV"), { code: "EBUSY" });
      return store.REAL_OPS.rename(a, b);
    },
    sleep: async () => {},
  };
  const w = await world({ lib: LIB, queueOps });
  try {
    await w.sync();
    pcWrite(w, "Alpha", "Ch.003.cbz", bytes("Ch.003.cbz", 1000));
    await w.restart();
    const p = await w.prepare();
    failFolders = true;
    const sent = w.sends().length;
    const r = await w.apply(p);
    assert.strictEqual(r.status, "failed");
    assert.strictEqual(r.reason, "record-write-failed");
    assert.strictEqual(w.sends().length, sent, "no SEND");
  } finally {
    await w.close();
  }
});

test("gone folder: re-pushed ticked into a re-created folder; the shard is rewritten in place", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    const before = await w.shard("Beta");
    w.devRmTree("Beta");
    await w.restart();
    const p = await w.prepare();
    assert.ok(p.ok, p.code);
    assert.deepStrictEqual(p.plan.gone.map((g) => [g.previous, g.chosen, g.source]), [["Beta", "Beta", "previous"]]);
    const op = p.plan.ops.get("push:Beta/Ch.001.cbz");
    assert.ok(op.preselected && op.reason === "removed-on-device");
    await w.apply(p);
    const after = await w.shard("Beta");
    assert.strictEqual(after.shardId, before.shardId);
    assert.strictEqual(after.verifyMode, "created");
    assert.deepStrictEqual(w.devNames("Beta"), ["Ch.001.cbz", "Ch.002.cbz"]);
    assert.strictEqual((await w.load()).shards.length, 2);
  } finally {
    await w.close();
  }
});

test("gone detection refuses on a truncated listing: the STA2 contradiction, and two listings that disagree", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    // "." ".." .nomedia Alpha → Beta hidden, but it exists.
    w.dev.inject.truncateList = [{ path: CANON, after: 4 }];
    await w.restart();
    const p = await w.prepare();
    assert.strictEqual(p.code, "device-listing-suspect");
    assert.strictEqual(p.detail, "listing-missed-folder");
    // Beta really gone, a device-only folder hidden by the truncation.
    w.devRmTree("Beta");
    w.dev.fs.mkdirs(`${CANON}/Gamma`);
    await w.restart();
    const p2 = await w.prepare();
    assert.strictEqual(p2.code, "device-listing-suspect");
    assert.strictEqual(p2.detail, "listings-differ");
    w.dev.inject.truncateList = [];
    await w.restart();
    const p3 = await w.prepare();
    assert.ok(p3.ok && p3.plan.gone.length === 1, "untruncated: gone");
    // An empty listing while the record manages folders: locked storage.
    w.dev.inject.truncateList = [{ path: CANON, after: 3 }];
    await w.restart();
    const p4 = await w.prepare();
    assert.strictEqual(p4.code, "device-listing-suspect");
    assert.strictEqual(p4.detail, "empty-root");
    w.dev.inject.truncateList = [];
    w.dev.inject.locked = { prefix: CANON, errno: wire.ERRNO.ENOENT };
    await w.restart();
    assert.strictEqual((await w.prepare()).code, "device-listing-suspect");
  } finally {
    await w.close();
  }
});

test("gone folder: one that reappeared is skipped; kills after the shard rewrite or the mkdir recover", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    w.devRmTree("Beta");
    await w.restart();
    let p = await w.prepare();
    w.dev.fs.mkdirs(`${CANON}/Beta`);
    const r = await w.apply(p);
    assert.deepStrictEqual(r.skippedSeries.map((x) => [x.folder, x.reason]), [["Beta", "folder-reappeared"]]);
    assert.deepStrictEqual(w.devNames("Beta"), []);
    w.dev.fs.rmdir(`${CANON}/Beta`);
    for (const point of ["after-shard-rewrite", "after-mkdir"]) {
      await w.restart();
      p = await w.prepare();
      assert.ok(p.ok, `${point}: ${p.code}`);
      const k = killAt(point);
      w.apply(p, { hooks: k.hooks });
      await within(k.reached, 5000, point);
      await w.restart();
      const q = await w.prepare();
      assert.ok(q.ok, `${point} re-plan: ${q.code}`);
      assert.deepStrictEqual(q.plan.sanity, [], "an empty re-created folder never trips the sanity check");
      const op = q.plan.ops.get("push:Beta/Ch.001.cbz");
      assert.ok(op && op.preselected, point);
      if (point === "after-mkdir") {
        await w.apply(q);
        assert.deepStrictEqual(w.devNames("Beta"), ["Ch.001.cbz", "Ch.002.cbz"]);
      } else {
        w.dev.fs.rmdir(`${CANON}/Beta`);
      }
    }
  } finally {
    await w.close();
  }
});

test("a new folder needs a chapter: sidecars alone are dropped and no folder is made", async () => {
  const w = await world({ lib: { Alpha: LIB.Alpha } });
  try {
    const p = await w.prepare();
    const sel = w.ops(p, { select: ["push:Alpha/Ch.001.cbz", "push:Alpha/Ch.002.cbz"].map((id) => ({ opId: id, selected: false })) });
    assert.deepStrictEqual(sel.ops, []);
    assert.deepStrictEqual(sel.dropped.map((x) => x.reason).sort(), ["no-chapter", "no-chapter"]);
    const r = await w.apply(p, { ops: sel.ops });
    assert.strictEqual(r.status, "completed");
    assert.strictEqual(w.devNames("Alpha"), null);
  } finally {
    await w.close();
  }
});

test("Link on a gone series rewrites its shard onto the linked folder; it is verified, one shard per series", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    const beta = await w.shard("Beta");
    w.dev.fs.rename(`${CANON}/Beta`, `${CANON}/Beta (tablet)`);
    await w.restart();
    const p = await w.prepare();
    const sug = p.plan.suggestions.find((s) => s.deviceFolder === "Beta (tablet)");
    // Same (name, size) files: content (checked before record), both strong.
    assert.ok(sug && sug.strong, JSON.stringify(sug));
    assert.strictEqual(p.plan.ops.get("push:Beta/Ch.001.cbz").preselected, false, "a strong match blocks the re-push");
    const sp = p.plan.bySeriesKey.get("pc:Beta");
    await w.store.bindFolder({ name: "Beta (tablet)", binding: sp.binding, shardId: beta.shardId });
    await w.restart();
    const q = await w.prepare();
    assert.ok(q.ok, q.code);
    const shards = (await w.load()).shards.filter((s) => s.pcFolder === "Beta");
    assert.deepStrictEqual(shards.map((s) => [s.shardId, s.name]), [[beta.shardId, "Beta (tablet)"]]);
    assert.strictEqual(entry(shards[0], "Ch.001.cbz").origin, "adopted");
    assertSettled(q, "after Link");
  } finally {
    await w.close();
  }
});

test("delete gate: the replacement's delete runs only once the new file landed", async () => {
  for (const land of [true, false]) {
    const w = await world({ lib: { Alpha: { files: { "Ch.001.cbz": 3000, "Ch.002.cbz": 3100 } } } });
    try {
      await w.sync();
      fs.unlinkSync(pcPath(w, "Alpha", "Ch.001.cbz"));
      pcWrite(w, "Alpha", "Ch.001 v2.cbz", bytes("v2", 3333));
      await w.restart();
      const p = await w.prepare();
      const del = p.plan.ops.get("delete:Alpha/Ch.001.cbz");
      assert.ok(del && del.gate && del.preselected, JSON.stringify(del));
      if (!land) w.dev.inject.failPaths = [{ pattern: /Ch\.001 v2/, op: "send", at: "open", errno: wire.ERRNO.EACCES }];
      const r = await w.apply(p);
      const rec = r.deletes.find((x) => x.opId === del.id);
      if (land) {
        assert.strictEqual(rec.outcome, "deleted");
        assert.deepStrictEqual(w.devNames("Alpha"), ["Ch.001 v2.cbz", "Ch.002.cbz"]);
      } else {
        assert.deepStrictEqual([rec.outcome, rec.reason], ["kept", "replacement-did-not-land"]);
        assert.ok(w.devNames("Alpha").includes("Ch.001.cbz"));
      }
    } finally {
      await w.close();
    }
  }
});

test("slot guard: never a slot a PC file holds (case-only on CI) nor one pushed this run; a delete needs the plan's (size, devMtime)", async () => {
  const w = await world({ ci: true, lib: LIB });
  try {
    await w.sync();
    const p = await w.prepare();
    const listed = p.device.folders.get("Alpha").files.find((f) => f.name === "Ch.001.cbz");
    const base = { kind: "delete", seriesKey: "pc:Alpha", reason: "extra", gate: null };
    const ops = [
      { ...base, id: "delete:Alpha/ch.001.cbz", name: "Ch.001.cbz", devFile: { size: listed.size, devMtime: listed.devMtime } },
      { ...base, id: "delete:Alpha/cover.jpg", name: "cover.jpg", devFile: { size: 1, devMtime: 1 } },
    ];
    const r = await w.executor(p).apply({ plan: p.plan, ops, device: p.device, pc: p.pc });
    assert.deepStrictEqual(r.deletes.map((x) => [x.name, x.outcome, x.reason]), [["Ch.001.cbz", "skipped", "slot-guard"], ["cover.jpg", "skipped", "changed-since-plan"]]);
    assert.ok(w.devNames("Alpha").includes("Ch.001.cbz"));
  } finally {
    await w.close();
  }
});

test("device loss ends the run once (disconnected); the error budget stops consecutive failures; a success resets it", async () => {
  const files = {};
  for (let i = 1; i <= 5; i += 1) files[`Ch.00${i}.cbz`] = 2000 + i;
  const w = await world({ lib: { Alpha: { files } } });
  try {
    let p = await w.prepare();
    w.dev.inject.unplugAfterBytes = 3000;
    const r = await w.apply(p);
    assert.deepStrictEqual([r.status, r.charged], ["disconnected", 0]);
    assert.strictEqual(r.files.length, 2, "nothing attempted after the loss");
    w.dev.inject.unplugAfterBytes = 0;
    w.srv.replug(w.dev);
    await w.restart();
    w.devRmTree("Alpha");
    fs.rmSync(path.join(w.userData, "targets"), { recursive: true, force: true });
    await w.restart();
    p = await w.prepare();
    w.dev.inject.failPaths = [1, 2, 4, 5].map((i) => ({ pattern: new RegExp(`Ch\\.00${i}`), op: "send", at: "data", errno: wire.ERRNO.EIO }));
    const r2 = await w.apply(p);
    assert.deepStrictEqual([r2.status, r2.charged], ["completed", 4], `${r2.status} ${r2.reason}`);
    assert.deepStrictEqual(r2.files.map((f) => f.outcome), ["failed", "failed", "done", "failed", "failed"]);
    w.dev.inject.failPaths = [1, 2, 4, 5].map((i) => ({ pattern: new RegExp(`Ch\\.00${i}`), op: "send", at: "data", errno: wire.ERRNO.EIO }));
    w.settings = { ...w.settings, syncErrorBudget: 2 };
    await w.restart();
    p = await w.prepare();
    const r3 = await w.apply(p);
    assert.deepStrictEqual([r3.status, r3.reason], ["failed", "error-budget"]);
  } finally {
    await w.close();
  }
});

test("apply's guards: a PC file changed since review, a running download, a settling file", async () => {
  const w = await world({ lib: LIB });
  try {
    const p = await w.prepare();
    pcWrite(w, "Alpha", "Ch.001.cbz", bytes("Ch.001.cbz", 3000), OLD_S + 5);
    const r = await w.apply(p, { isPathBusy: (fp) => fp.endsWith(`${path.sep}Beta`) });
    const why = Object.fromEntries(r.files.filter((f) => f.outcome !== "done").map((f) => [`${f.folder}/${f.name}`, f.reason]));
    assert.deepStrictEqual(why, { "Alpha/Ch.001.cbz": "changed-since-review", "Beta/Ch.001.cbz": "downloading", "Beta/Ch.002.cbz": "downloading" });
    await w.restart();
    const q = await w.prepare();
    const r2 = await w.apply(q, { now: () => (OLD_S + 10) * 1000 });
    assert.ok(r2.files.every((f) => f.reason === "settling"), JSON.stringify(r2.files));
  } finally {
    await w.close();
  }
});

test("rule 7's sanity check: a bound folder listing zero files blocks Start", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    for (const n of w.devNames("Alpha")) w.dev.fs.unlink(`${CANON}/Alpha/${n}`);
    await w.restart();
    const p = await w.prepare();
    assert.deepStrictEqual(p.plan.sanity.map((x) => x.folder), ["Alpha"]);
    const sel = w.ops(p);
    assert.strictEqual(sel.ok, false);
    assert.ok(sel.blocking.some((b) => b.kind === "listing-sanity"));
  } finally {
    await w.close();
  }
});

test("Verify: managed folders only; a failed hash keeps the entries; read-back and adopt-size without sha256sum; scaled timeout", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    w.dev.fs.writeFile(`${CANON}/Zeta/x.cbz`, "z");
    const a = await w.shard("Alpha");
    const file = path.join(w.userData, "targets", "t1", "folders", `${a.shardId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...a, shardId: undefined, verifiedAt: null }));
    w.dev.inject.locked = { prefix: `${CANON}/Alpha/Ch.002`, errno: wire.ERRNO.EACCES };
    await w.restart();
    const p = await w.prepare();
    assert.ok(p.ok, p.code);
    assert.deepStrictEqual(p.verify.folders.map((x) => [x.folder, x.outcome]), [["Alpha", "failed"]]);
    assert.ok(p.warnings.some((x) => x.kind === "verify-failed" && x.folder === "Alpha"));
    const kept = await w.shard("Alpha");
    assert.strictEqual(kept.verifiedAt, null);
    assert.strictEqual(entry(kept, "Ch.002.cbz").origin, "pushed", "entries kept");
    assert.ok(!(await w.load()).shards.some((s) => s.name === "Zeta"), "unmanaged folder never verified");
    const hf = await w.transport.hashFolder("Alpha", { largest: 80 * 1024 * 1024 });
    assert.strictEqual(hf.idleMs, 60000 + 10000);
  } finally {
    await w.close();
  }
  for (const mode of ["read-back", "adopt-size"]) {
    const v = await world({ lib: { Alpha: LIB.Alpha }, inject: { tools: { sha256sum: false } } });
    try {
      for (const n of ["Ch.001.cbz", "Ch.002.cbz"]) v.devWrite(`Alpha/${n}`, fs.readFileSync(pcPath(v, "Alpha", n)));
      const refused = await v.prepare();
      assert.strictEqual(refused.code, "needs-mode");
      assert.deepStrictEqual(refused.folders, ["Alpha"]);
      const recv = v.srv.log.filter((x) => x.id === "RECV").length;
      const p = await v.prepare({ opts: { verifyMode: mode } });
      assert.ok(p.ok, p.code);
      const sh = await v.shard("Alpha");
      assert.strictEqual(sh.verifyMode, mode);
      assert.strictEqual(entry(sh, "Ch.001.cbz").origin, mode === "read-back" ? "adopted" : "adopted-size");
      assert.strictEqual(v.srv.log.filter((x) => x.id === "RECV").length - recv, mode === "read-back" ? 2 : 0);
    } finally {
      await v.close();
    }
  }
});

test("prune: deletes only hash-proven files of ours, keeps foreign and adopted-size, rmdir only when empty", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    const beta = await w.shard("Beta");
    const file = path.join(w.userData, "targets", "t1", "folders", `${beta.shardId}.json`);
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    const slot = Object.keys(body.files).find((k) => body.files[k].name === "Ch.002.cbz");
    body.files[slot].origin = "adopted-size";
    fs.writeFileSync(file, JSON.stringify(body));
    w.devWrite("Beta/mine-not.cbz", "foreign");
    fs.rmSync(path.join(w.libRoot, "Beta"), { recursive: true });
    await w.restart();
    const p = await w.prepare();
    const row = p.plan.deviceOnly.find((x) => x.name === "Beta");
    assert.deepStrictEqual([row.state, row.shardId], ["orphaned", beta.shardId]);
    const r = await w.executor(p).prune({ folders: [{ name: "Beta", shardId: beta.shardId }] });
    assert.strictEqual(r.status, "completed");
    assert.deepStrictEqual(r.prune[0].deleted, ["Ch.001.cbz"]);
    assert.deepStrictEqual(r.prune[0].leftovers.sort(), ["Ch.002.cbz", "mine-not.cbz"]);
    assert.strictEqual(r.prune[0].removed, false);
    assert.deepStrictEqual(w.devNames("Beta"), ["Ch.002.cbz", "mine-not.cbz"]);
    w.dev.fs.unlink(`${CANON}/Beta/Ch.002.cbz`);
    w.dev.fs.unlink(`${CANON}/Beta/mine-not.cbz`);
    await w.restart();
    const q = await w.prepare();
    const r2 = await w.executor(q).prune({ folders: [{ name: "Beta", shardId: beta.shardId }] });
    assert.strictEqual(r2.prune[0].removed, true);
    assert.strictEqual(w.devNames("Beta"), null);
    assert.ok(!(await w.load()).shards.some((s) => s.shardId === beta.shardId), "shard gone with the folder");
  } finally {
    await w.close();
  }
});

test("hash-while-push: a file changed without a new size or mtime reaches the record and the cache; the next plan is stable", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    pcWrite(w, "Alpha", "Ch.003.cbz", bytes("Ch.003.cbz", 4000), OLD_S + 100);
    await w.restart();
    const p = await w.prepare();
    pcWrite(w, "Alpha", "Ch.003.cbz", bytes("Ch.003.cbz", 4000, 9), OLD_S + 100);
    const r = await w.apply(p);
    assert.strictEqual(r.mismatches.length, 1);
    const truth = sha(bytes("Ch.003.cbz", 4000, 9));
    assert.strictEqual(r.mismatches[0].sent, truth);
    assert.strictEqual(entry(await w.shard("Alpha"), "Ch.003.cbz").sha256, truth);
    await w.pool.flush();
    await w.restart();
    const q = await w.prepare();
    assertSettled(q, "after the mismatch");
  } finally {
    await w.close();
  }
});

test("connecting during a run: waits for the device, uncharged; one that stays connecting ends it disconnected", async () => {
  const w = await world({ lib: LIB });
  try {
    let p = await w.prepare();
    w.srv.setState(SERIAL, "connecting");
    setTimeout(() => w.srv.setState(SERIAL, "device"), 400);
    const r = await w.apply(p);
    assert.deepStrictEqual([r.status, r.charged], ["completed", 0]);
    pcWrite(w, "Gamma", "Ch.001.cbz", bytes("g", 100));
    await w.restart();
    p = await w.prepare();
    w.srv.setState(SERIAL, "connecting");
    const r2 = await w.apply(p, { connectWaitMs: 300 });
    assert.deepStrictEqual([r2.status, r2.reason], ["disconnected", "still-connecting"]);
    w.srv.setState(SERIAL, "device");
  } finally {
    await w.close();
  }
});

test("batched intent (built, off by default): one pending write per batch; a kill mid-batch resolves per file", async () => {
  const files = {};
  for (let i = 1; i <= 5; i += 1) files[`Ch.00${i}.cbz`] = 1500 + i;
  const w = await world({ lib: { Alpha: { files } } });
  try {
    const p = await w.prepare();
    const k = killAt("after-okay", (c) => c.name === "Ch.002.cbz");
    w.apply(p, { intentBatch: 3, hooks: k.hooks });
    await within(k.reached, 5000, "after-okay");
    await w.restart();
    const mid = await w.shard("Alpha");
    assert.deepStrictEqual(Object.values(mid.files).map((e) => e.origin).sort(), ["pending", "pending", "pending"]);
    const q = await w.prepare();
    const sh = await w.shard("Alpha");
    assert.deepStrictEqual(["Ch.001.cbz", "Ch.002.cbz"].map((n) => entry(sh, n).origin), ["pushed", "pushed"]);
    assert.strictEqual(entry(sh, "Ch.003.cbz"), null, "never sent: dropped");
    const writes0 = w.queue.writes;
    const r = await w.apply(q, { intentBatch: 3 });
    assert.strictEqual(r.status, "completed");
    assert.ok(w.queue.writes - writes0 <= 6, `batched writes: ${w.queue.writes - writes0}`);
    await w.restart();
    assertSettled(await w.prepare(), "batched");
  } finally {
    await w.close();
  }
});

test("run policy: pushes that don't fit refuse as blocked; ENOSPC and EROFS end the run; unknown free space warns", async () => {
  const w = await world({ lib: LIB, inject: { capacityBytes: 8000 } });
  try {
    const p = await w.prepare();
    const r = await w.apply(p, { reserveBytes: 0 });
    assert.deepStrictEqual([r.ok, r.code], [false, "blocked"]);
    assert.strictEqual(r.blocking[0].kind, "free-space");
    assert.deepStrictEqual(w.sends(), []);
    const r2 = await w.apply(p, { reserveBytes: -1e9 });
    assert.deepStrictEqual([r2.status, r2.reason], ["failed", "no-space"]);
  } finally {
    await w.close();
  }
  const ro = await world({ lib: LIB, inject: { readOnly: true } });
  try {
    const p = await ro.prepare();
    const r = await ro.apply(p);
    assert.deepStrictEqual([r.status, r.reason], ["failed", "read-only"]);
  } finally {
    await ro.close();
  }
  const nf = await world({ lib: LIB, inject: { tools: { statF: false, df: false } } });
  try {
    const { r } = await nf.sync();
    assert.ok(r.warnings.some((x) => x.kind === "free-space-unknown"));
  } finally {
    await nf.close();
  }
});

test("free space: pushes that fit only after gate-free deletes run those deletes first", async () => {
  const w = await world({ lib: { Alpha: { files: { "Ch.001.cbz": 4096, "cover.jpg": 8192 } } } });
  try {
    await w.sync();
    fs.unlinkSync(pcPath(w, "Alpha", "cover.jpg"));
    pcWrite(w, "Alpha", "Ch.002.cbz", bytes("Ch.002.cbz", 12288));
    w.dev.inject.capacityBytes = w.dev.fs.used + 8192;
    await w.restart();
    const p = await w.prepare();
    const del = p.plan.ops.get("delete:Alpha/cover.jpg");
    assert.ok(del && del.preselected && !del.gate, JSON.stringify(del));
    const r = await w.apply(p, { reserveBytes: 0 });
    assert.strictEqual(r.status, "completed", `${r.status} ${r.reason} ${r.code || ""}`);
    assert.ok(r.warnings.some((x) => x.kind === "deletes-first"));
    assert.deepStrictEqual(w.devNames("Alpha"), ["Ch.001.cbz", "Ch.002.cbz"]);
  } finally {
    await w.close();
  }
});

test("a non-UTF-8 device name is listed as undecodable and never planned", async () => {
  const w = await world({ lib: LIB });
  try {
    await w.sync();
    w.dev.fs.writeFile(Buffer.concat([Buffer.from(`${CANON}/Alpha/`), Buffer.from([0x43, 0x68, 0xff, 0x2e, 0x63, 0x62, 0x7a])]), "x");
    await w.restart();
    const p = await w.prepare();
    assertSettled(p, "with an undecodable name");
    assert.ok(p.warnings.some((x) => x.kind === "undecodable-names" && x.folder === "Alpha"));
    assert.ok(![...p.plan.ops.values()].some((o) => /Ch.\.cbz|�/.test(o.name)));
  } finally {
    await w.close();
  }
});

test("folder target: another disk at the same path is a record-mismatch; an interrupted push resolves by hashing the copy", async () => {
  const w = await world({ kind: "folder", lib: LIB });
  try {
    const p = await w.prepare();
    const k = killAt("after-okay", (c) => c.name === "Ch.002.cbz" && c.folder === "Alpha");
    w.apply(p, { hooks: k.hooks });
    await within(k.reached, 5000, "after-okay");
    await w.restart();
    const q = await w.prepare();
    assert.ok(q.ok, q.code);
    assert.strictEqual(entry(await w.shard("Alpha"), "Ch.002.cbz").origin, "pushed");
    const hp2 = path.join(w.userData, "targets", "t1", "header.json");
    fs.writeFileSync(hp2, JSON.stringify({ ...JSON.parse(fs.readFileSync(hp2, "utf8")), volumeId: "999" }));
    await w.restart();
    const m = await w.prepare();
    assert.strictEqual(m.code, "record-mismatch");
    assert.deepStrictEqual(m.fields, ["volumeId"]);
  } finally {
    await w.close();
  }
});

// =====================================================================
// RUNNER-MARKER
// =====================================================================

(async () => {
  const only = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
  for (const t of tests) {
    if (only && !only.test(t.name)) continue;
    const started = Date.now();
    try {
      await Promise.race([t.fn(), sleep(30000).then(() => Promise.reject(new Error("test timed out (30 s)")))]);
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
  } catch (_) {
    // a locked temp file on Windows; the OS cleans its temp folder
  }
  console.log(`\n${passed} passed, ${failed} failed (node ${process.versions.node})`);
  process.exit(failed ? 1 : 0);
})();
