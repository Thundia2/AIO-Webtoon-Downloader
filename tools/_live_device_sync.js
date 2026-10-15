// LIVE tablet measurements for Device Sync (non-UI plan, "P5. Packaged smoke
// and live tablet"). Talks to a REAL device through the real adb server.
//
//   node tools/_live_device_sync.js <step> [<step> …] [--serial S] [--fresh]
//   node tools/_live_device_sync.js --self-test      (offline, fake adb server)
//
//   steps: probe names mtime drain interrupt throughput e2e unplug reboot
//          cleanup checklist; "auto" = probe names mtime drain interrupt
//          throughput e2e. unplug and reboot need hands on the cable.
//
// RUN ONLY WITH THE USER'S OK, with their hands on the cable. Default serial
// A06B4A372090333 (the user's tablet).
//
// SAFETY: every device write is under SCRATCH and nowhere else.
//   * scratch() is the only way this script names a device path, and it
//     refuses anything outside SCRATCH; the transports add their own
//     containment check (validatePath);
//   * a step aborts unless the device's realpath of its folder is the folder
//     itself, so a symlink can't redirect the writes;
//   * `cleanup` removes SCRATCH and nothing else;
//   * PC side: a temp library and userData under LIVE_UD (os.tmpdir()); the
//     user's library (D:\AIO\manga) and %APPDATA% are never opened. The
//     e2e / unplug / reboot steps share LIVE_UD's userData so the record
//     survives between invocations; `--fresh` resets it.
//
// Manual steps don't read the keyboard: they print an instruction and poll
// the adb server until the device state changes, so they work from a
// terminal tab or a Claude session. --self-test performs those actions on
// the fake server instead (unplug/replug, locked storage for "reboot") and
// shrinks every size, so the script's own logic is tested before it ever
// meets the tablet. Results print as they come and are appended as JSON
// lines to LIVE_UD/results.jsonl.
//
// What each step measures (the plan's list):
//   probe      device features (ls_v2, stat_v2, shell_v2, sendrecv_v2),
//              toybox capabilities, the case probe, realpath /sdcard, Android
//              version, free space
//   names      byte-exact UTF-8 names round-trip (SPY×FAMILY, Hell's Paradise,
//              curly quote, CJK, emoji)
//   mtime      device mtime at OKAY, in a listing, after 60 s, after a fresh
//              adb connection (review #4), with and without a DONE mtime
//   drain      wait between the last DATA and OKAY on large files, against the
//              client's allowance (adb/client.js drainAllowanceMs on top of
//              the idle watchdog)
//   interrupt  what an aborted push of a NEW file leaves (expect nothing:
//              adbd unlinks the partial) and of an UPDATE (expect an empty
//              slot)
//   throughput this client's per-file-ack pushes vs adb.exe push of the same
//              directory (pipelined), MB/s
//   e2e        the real service (sync/service.js, fake ipcMain) against the
//              device: three series incl. the SPY×FAMILY and Hell's Paradise
//              name shapes; plan (device-ready timing), apply, re-plan all in
//              sync, verify, the device layout
//   unplug     an apply aborted by pulling the cable, then resumed: files
//              acknowledged before the unplug must re-plan as in sync, not
//              as replaces (second review #7)
//   reboot     a plan after a reboot, before the first unlock (review #3):
//              it must refuse, not propose deletes or re-pushes
//   checklist  prints the two app-level checks no script can drive
//
// tools/ is gitignored; force-added on wip/device-sync-handoff only.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const SYNC = path.join(__dirname, "..", "UI-source", "electron", "sync");
const { AdbClient, DEFAULTS: CLIENT_DEFAULTS, drainAllowanceMs } = require(path.join(SYNC, "adb", "client.js"));
const locate = require(path.join(SYNC, "adb", "locate.js"));
const { AdbTransport, shq } = require(path.join(SYNC, "transports.js"));
const service = require(path.join(SYNC, "service.js"));

const SCRATCH = "/storage/emulated/0/Download/aio-sync-test";
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const SELF = argv.includes("--self-test");
const SERIAL = opt("--serial", "A06B4A372090333");
const STEPS = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--serial");
const LIVE_UD = path.join(os.tmpdir(), SELF ? `aio-live-selftest-${process.pid}` : "aio-live-device-sync");
const MiB = 1024 * 1024;
// Sizes: real ones for the tablet, small ones for the in-memory fake.
const Z = SELF
  ? { mtimeWaitMs: 1000, drainMb: [2, 8], interruptMb: 8, tpFiles: 3, tpMb: 2, chapterMb: 1, longChapters: 12, longMb: 1 }
  : { mtimeWaitMs: 60_000, drainMb: [64, 512], interruptMb: 256, tpFiles: 10, tpMb: 32, chapterMb: 6, longChapters: 12, longMb: 40 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(...a);
const results = [];
function record(step, data) {
  fs.mkdirSync(LIVE_UD, { recursive: true });
  const row = { t: new Date().toISOString(), serial: SERIAL, step, ...data };
  results.push(row);
  fs.appendFileSync(path.join(LIVE_UD, "results.jsonl"), JSON.stringify(row) + "\n");
  say(`  = ${step}: ${JSON.stringify(data)}`);
}
/** The only way this script names a device path. */
function scratch(rel) {
  const p = rel ? `${SCRATCH}/${rel}` : SCRATCH;
  if (p !== SCRATCH && !p.startsWith(`${SCRATCH}/`)) throw new Error(`refusing a path outside the scratch root: ${p}`);
  if (/(^|\/)\.\.?(\/|$)/.test(p.slice(SCRATCH.length))) throw new Error(`refusing a dot segment: ${p}`);
  return p;
}
function pattern(size, seed) {
  const out = Buffer.allocUnsafe(size);
  const block = crypto.createHash("sha256").update(String(seed)).digest();
  for (let i = 0; i < size; i += block.length) block.copy(out, i, 0, Math.min(block.length, size - i));
  return out;
}
function tmpFile(name, size, seed) {
  const dir = path.join(LIVE_UD, "pc-files");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  if (!fs.existsSync(p) || fs.statSync(p).size !== size) {
    // 8 MiB slices, so a 512 MiB file doesn't need 512 MiB of RAM.
    const fd = fs.openSync(p, "w");
    try {
      for (let off = 0; off < size; off += 8 * MiB) fs.writeSync(fd, pattern(Math.min(8 * MiB, size - off), `${seed}:${off}`));
    } finally {
      fs.closeSync(fd);
    }
  }
  return p;
}

// ------------------------------------------------------------------ connect and manual actions

let PORT = null; // --self-test: the fake server's port
let fake = null; // --self-test: {srv, dev}
let adbBin = null;
let client = null;

async function connect() {
  if (client) return client;
  client = new AdbClient(PORT ? { port: PORT } : {});
  if (!PORT) {
    const loc = await locate.locateAdb({});
    adbBin = loc.resolved;
    const es = await locate.ensureServer(client, adbBin);
    if (!es.ok) throw new Error(`no adb server: ${es.error && es.error.message}`);
  }
  const row = (await client.devices()).find((d) => d.serial === SERIAL);
  if (!row || row.state !== "device") throw new Error(`device ${SERIAL} is not attached in state "device" (got ${row ? row.state : "absent"})`);
  say(`adb ${PORT ? `fake server :${PORT}` : adbBin || "(server already running)"}; ${SERIAL} ${row.model || ""} transport ${row.transportId}`);
  return client;
}

function dropClient() {
  try {
    if (client && client.close) client.close();
  } catch (_) {}
  client = null;
}

async function waitDevice(want, ms) {
  const c = new AdbClient(PORT ? { port: PORT } : {});
  const end = Date.now() + ms;
  for (;;) {
    let row = null;
    try {
      row = (await c.devices()).find((d) => d.serial === SERIAL) || null;
    } catch (_) {
      // server restarting: keep polling
    }
    const state = row ? row.state : "absent";
    if (want === "absent" ? state === "absent" : state === want) return row;
    if (Date.now() > end) throw new Error(`timed out waiting for the device to be ${want} (last: ${state})`);
    await sleep(500);
  }
}

/** A manual instruction: shouted on the tablet run, performed on the fake. */
async function manual(what) {
  const text = {
    unplug: "UNPLUG THE USB CABLE NOW",
    replug: "PLUG THE CABLE BACK IN (allow USB debugging if asked)",
    reboot: "REBOOT THE TABLET NOW and DON'T unlock it after it starts",
    unlock: "UNLOCK THE TABLET NOW",
  }[what];
  say(`\n>>>>>>>> ${text} <<<<<<<<\n`);
  if (!SELF) return;
  if (what === "unplug") await fake.srv.unplug(SERIAL);
  if (what === "replug") fake.srv.replug(fake.dev);
  if (what === "reboot") {
    await fake.srv.unplug(SERIAL);
    // Before the first unlock, FBE keeps /storage/emulated/0 unreadable.
    fake.dev.inject.locked = { prefix: "/storage/emulated/0", errno: 13 };
    await sleep(300);
    fake.srv.replug(fake.dev);
  }
  if (what === "unlock") fake.dev.inject.locked = null;
}

// SCRATCH's parent: always present on Android, and checked canonical before
// anything is created under it.
const SCRATCH_PARENT = SCRATCH.slice(0, SCRATCH.lastIndexOf("/"));

/** The device's realpath of `p`, or null when it fails (missing, or no realpath). */
async function realpathOf(p) {
  const r = await client.device(SERIAL).shell(`realpath ${shq(p)}`);
  const out = r.stdout.toString("utf8").trim();
  return r.exitCode === 0 && out.startsWith("/") && !out.includes("\n") ? out : null;
}

/**
 * A transport on SCRATCH/<rel>, refusing to run if anything on the way is
 * a redirect. Checked BEFORE the mkdir, so a symlinked folder can't steer
 * even an empty directory elsewhere: the parent must resolve to itself
 * (which also proves the device has a working realpath), then each existing
 * level from SCRATCH down must too; below the first missing level mkdir
 * creates plain folders. The transport's own probe is not enough on its
 * own: it falls back to the configured root when realpath fails.
 */
async function transportAt(rel) {
  await connect();
  const target = scratch(rel);
  const parentRp = await realpathOf(SCRATCH_PARENT);
  if (parentRp !== SCRATCH_PARENT) throw new Error(`the device resolves ${SCRATCH_PARENT} to ${parentRp}; refusing (a redirect, or no working realpath)`);
  const segs = rel ? rel.split("/") : [];
  for (let i = 0; i <= segs.length; i += 1) {
    const p = i ? `${SCRATCH}/${segs.slice(0, i).join("/")}` : SCRATCH;
    const rp = await realpathOf(p);
    if (rp == null) break;
    if (rp !== p) throw new Error(`the device resolves ${p} to ${rp}; refusing to write through a redirect`);
  }
  const mk = await client.device(SERIAL).shell(`mkdir -p ${shq(target)}`);
  if (mk.exitCode !== 0) throw new Error(`mkdir ${target} failed: ${mk.stderr}`);
  if ((await realpathOf(target)) !== target) throw new Error(`${target} doesn't resolve to itself after mkdir; refusing`);
  const tp = new AdbTransport({ client, serial: SERIAL, root: target });
  const pr = await tp.probe();
  if (pr.canonicalRoot !== target) {
    tp.destroy();
    throw new Error(`the device resolves ${target} to ${pr.canonicalRoot}; refusing to write through a redirect`);
  }
  return tp;
}

// ------------------------------------------------------------------ steps

const steps = {};

steps.probe = async () => {
  const tp = await transportAt("");
  try {
    const feats = [...(await client.features(SERIAL))].sort();
    const pr = await tp.probe();
    const sh = async (c) => (await client.device(SERIAL).shell(c)).stdout.toString("utf8").trim();
    record("probe", {
      features: feats.filter((f) => /^(ls_v2|stat_v2|shell_v2|sendrecv_v2.*|delayed_ack|fixed_push_mkdir|abb_exec)$/.test(f)),
      featureCount: feats.length,
      caps: pr.caps,
      caseInsensitive: pr.caseInsensitive,
      caseMeasured: pr.caseMeasured,
      canonicalRoot: pr.canonicalRoot,
      realpathSdcard: await sh("realpath /sdcard"),
      android: await sh("getprop ro.build.version.release"),
      sdk: await sh("getprop ro.build.version.sdk"),
      toybox: await sh("toybox --version"),
      freeSpace: await tp.freeSpace().catch((e) => ({ error: e.message })),
    });
  } finally {
    tp.destroy();
  }
};

steps.names = async () => {
  const tp = await transportAt("names");
  try {
    const names = ["SPY×FAMILY Ch.001.cbz", "Hell's Paradise - Jigokuraku Ch.001.cbz", "Hell’s Paradise (curly) Ch.001.cbz", "地獄楽 第1話.cbz", "Café ▸ Ch.1.cbz", "emoji 📚 Ch.1.cbz"];
    for (const n of names) await tp.pushBuffer(n, Buffer.from(n, "utf8"));
    const l = await tp.session.list(scratch("names"));
    const got = new Map(l.entries.map((e) => [Buffer.from(e.raw).toString("hex"), e]));
    const rows = names.map((n) => {
      const e = got.get(Buffer.from(n, "utf8").toString("hex"));
      return { name: n, exact: !!e, size: e ? e.size : null };
    });
    record("names", { allExact: rows.every((r) => r.exact && r.size === Buffer.byteLength(r.name)), rows, errored: l.errored.length });
  } finally {
    tp.destroy();
  }
};

steps.mtime = async () => {
  let tp = await transportAt("mtime");
  const pcMtime = Math.floor(Date.UTC(2024, 0, 1) / 1000);
  const buf = pattern(256 * 1024, "mtime");
  const out = {};
  try {
    for (const [label, mtime] of [["explicit", pcMtime], ["default", null]]) {
      const rel = `${label}.cbz`;
      const pushStart = Math.floor(Date.now() / 1000);
      await tp.session.push({ remotePath: scratch(`mtime/${rel}`), open: () => buf, ...(mtime != null ? { mtime } : {}) });
      const okay = Math.floor(Date.now() / 1000);
      const atOkay = (await tp.session.stat(scratch(`mtime/${rel}`))).mtime;
      const inList = ((await tp.session.list(scratch("mtime"))).entries.find((e) => e.name === rel) || {}).mtime;
      out[label] = { sentMtime: mtime, pushStart, okay, atOkay, inList };
    }
    say(`  .. waiting ${Z.mtimeWaitMs / 1000} s`);
    await sleep(Z.mtimeWaitMs);
    for (const label of Object.keys(out)) out[label].afterWait = (await tp.session.stat(scratch(`mtime/${label}.cbz`))).mtime;
    tp.destroy();
    dropClient();
    tp = await transportAt("mtime");
    for (const label of Object.keys(out)) out[label].afterReconnect = (await tp.session.stat(scratch(`mtime/${label}.cbz`))).mtime;
    for (const v of Object.values(out)) v.stable = v.atOkay === v.inList && v.inList === v.afterWait && v.afterWait === v.afterReconnect;
    record("mtime", out);
  } finally {
    tp.destroy();
  }
};

steps.drain = async () => {
  const tp = await transportAt("drain");
  try {
    for (const mb of Z.drainMb) {
      const size = mb * MiB;
      const pcPath = tmpFile(`drain-${mb}.bin`, size, `drain${mb}`);
      let tLast = null;
      const t0 = Date.now();
      const r = await tp.push({
        rel: `drain-${mb}.bin`,
        pcPath,
        onProgress: (sent) => {
          if (sent >= size && tLast == null) tLast = Date.now();
        },
      });
      const tOk = Date.now();
      // What the client allows past the last DATA (adb/client.js): the idle
      // watchdog plus the drain allowance.
      const allowanceMs = CLIENT_DEFAULTS.idleMs + drainAllowanceMs(size);
      record("drain", { mb, totalMs: tOk - t0, lastDataToOkayMs: tLast != null ? tOk - tLast : null, allowanceMs, mbPerSec: +(mb / Math.max(0.001, (tOk - t0) / 1000)).toFixed(1), bytes: r && r.bytes });
    }
  } finally {
    tp.destroy();
  }
};

steps.interrupt = async () => {
  const tp = await transportAt("interrupt");
  const size = Z.interruptMb * MiB;
  const pcPath = tmpFile(`interrupt-${Z.interruptMb}.bin`, size, "interrupt");
  const abortAt = async (rel, frac) => {
    const ac = new AbortController();
    let err = null;
    await tp
      .push({
        rel,
        pcPath,
        signal: ac.signal,
        onProgress: (sent) => {
          if (sent > size * frac && !ac.signal.aborted) ac.abort();
        },
      })
      .catch((e) => (err = e));
    await sleep(1500); // adbd notices the closed socket
    const st = await tp.session.stat(scratch(`interrupt/${rel}`));
    return { aborted: !!err, errKind: err && err.kind, exists: st.ok, size: st.ok ? st.size : null };
  };
  try {
    const fresh = await abortAt("new.bin", 0.4);
    await tp.pushBuffer("update.bin", pattern(MiB, "orig"));
    const before = await tp.session.stat(scratch("interrupt/update.bin"));
    const upd = await abortAt("update.bin", 0.4);
    record("interrupt", { newFile: fresh, updateOf1MiB: { before: before.ok ? before.size : null, ...upd } });
  } finally {
    tp.destroy();
  }
};

steps.throughput = async () => {
  const tp = await transportAt("tp");
  const size = Z.tpMb * MiB;
  const dir = path.join(LIVE_UD, "pc-files", "tp");
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < Z.tpFiles; i += 1) {
    const p = path.join(dir, `f${i}.bin`);
    if (!fs.existsSync(p) || fs.statSync(p).size !== size) fs.copyFileSync(tmpFile(`tp-src-${i}.bin`, size, `tp${i}`), p);
    files.push(p);
  }
  try {
    await tp.mkdirp("ours");
    let t0 = Date.now();
    for (const p of files) await tp.push({ rel: `ours/${path.basename(p)}`, pcPath: p });
    const oursMs = Date.now() - t0;
    const mb = (Z.tpFiles * size) / MiB;
    const row = { files: Z.tpFiles, mbEach: Z.tpMb, ours: { ms: oursMs, mbPerSec: +(mb / Math.max(0.001, oursMs / 1000)).toFixed(1) } };
    // adb.exe talks to the real server, so the fake run skips it.
    if (adbBin && !SELF) {
      let adbErr = null;
      t0 = Date.now();
      await new Promise((res) =>
        execFile(adbBin, ["-s", SERIAL, "push", dir, `${scratch("tp")}/adbexe`], { windowsHide: true, timeout: 600_000 }, (e) => {
          adbErr = e ? String(e.message).slice(0, 200) : null;
          res();
        }),
      );
      const adbMs = Date.now() - t0;
      row.adbExe = { ms: adbMs, mbPerSec: +(mb / (adbMs / 1000)).toFixed(1), error: adbErr };
    } else row.adbExe = SELF ? "skipped (fake server)" : "no adb.exe located";
    record("throughput", row);
  } finally {
    tp.destroy();
  }
};

// ------------------------------------------------------------------ service-driven steps

const LIB = path.join(LIVE_UD, "library");
const UD = path.join(LIVE_UD, "userData", "sync");
const TARGET_ROOT = scratch("library");

function writeOld(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  const t = Date.now() / 1000 - 3600;
  fs.utimesSync(p, t, t);
}
function series(folder, chapters, mb) {
  const dir = path.join(LIB, folder);
  if (fs.existsSync(path.join(dir, ".aio_series.json"))) return;
  writeOld(path.join(dir, ".aio_series.json"), JSON.stringify({ url: `https://mangafire.to/manga/${encodeURIComponent(folder.toLowerCase())}.live`, title: folder }));
  writeOld(path.join(dir, "details.json"), JSON.stringify({ title: folder, author: "Live Test", artist: "", description: "", genre: [], status: "1" }));
  writeOld(path.join(dir, "cover.jpg"), pattern(64 * 1024, `${folder}-cover`));
  for (let i = 1; i <= chapters; i += 1) writeOld(path.join(dir, `Ch.${String(i).padStart(3, "0")}.cbz`), pattern(mb * MiB, `${folder}-${i}`));
}

async function startService() {
  fs.mkdirSync(LIB, { recursive: true });
  fs.mkdirSync(UD, { recursive: true });
  const a = { events: [], handlers: new Map(), settings: { syncEnabled: true, cpuLimit: "unlimited" } };
  a.svc = service.initDeviceSync({
    ipcMain: { handle: (ch, fn) => a.handlers.set(ch, fn) },
    send: (ch, p) => a.events.push(p),
    userDataDir: UD,
    getSettings: () => a.settings,
    getLibraryRoot: () => LIB,
    getRunningDownloads: () => [],
    isCheckAllRunning: () => false,
    isSearchRunning: () => false,
    resolveSpawnPaths: () => ({ pythonCmd: "python", scriptPath: "aio-dl.py", workingDir: LIVE_UD }),
    extraEnv: {},
    onFocus: () => {},
    isFocused: () => true,
    getWindow: () => null,
    showSaveDialog: async () => ({ canceled: true }),
    ...(PORT
      ? {
          _test: {
            clientOpts: { port: PORT },
            locateAdb: async () => ({ resolved: null, candidates: [] }),
            ensureServer: async (c) => ({ ok: true, version: await c.version(), started: false }),
          },
        }
      : {}),
  });
  a.call = (name, p) => a.handlers.get(`sync:${name}`)({}, p);
  a.waitJob = async (runId, ms = 30 * 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const ev = a.events.find((e) => e.kind === "job" && e.runId === runId && e.state === "done");
      if (ev) return ev;
      if (Date.now() > end) throw new Error(`job ${runId} didn't end`);
      await sleep(100);
    }
  };
  a.idle = async () => {
    while (a.svc._debug().current) await sleep(100);
  };
  /** The adb target on TARGET_ROOT (added once), after the service's tracker sees the device. */
  a.target = async () => {
    const st = await a.call("get-state");
    let id = (((st.config && st.config.targets) || []).find((x) => x.kind === "adb" && x.serial === SERIAL && x.root === TARGET_ROOT) || {}).id;
    if (!id) {
      const r = await a.call("config-op", { op: "add-target", target: { name: "Live tablet", kind: "adb", serial: SERIAL, root: TARGET_ROOT, profile: "komikku" } });
      if (!r.ok) throw new Error(`add-target refused: ${JSON.stringify(r)}`);
      id = r.targetId;
    }
    // A job against a device the tracker hasn't reported yet is refused
    // `disconnected`, as in the app right after launch.
    const end = Date.now() + 30_000;
    for (;;) {
      const s = await a.call("get-state");
      if ((s.devices || []).some((d) => d.serial === SERIAL && d.state === "device")) return id;
      if (Date.now() > end) throw new Error("the service never saw the device");
      await sleep(200);
    }
  };
  /** Plan; returns {done, ms, readyMs (the device-ready line), summary, refusal}. */
  a.plan = async (id, overrides) => {
    await a.idle();
    const t0 = Date.now();
    const r = await a.call("plan", { targetId: id, overrides });
    if (!r.ok) return { done: { status: "refused" }, ms: 0, readyMs: null, summary: null, refusal: r };
    let readyMs = null;
    const watch = setInterval(() => {
      if (readyMs == null && a.events.some((e) => e.kind === "job" && e.runId === r.runId && e.progress && e.progress.step === "device-ready")) readyMs = Date.now() - t0;
    }, 10);
    const done = await a.waitJob(r.runId);
    clearInterval(watch);
    const st = await a.call("get-state");
    const pl = st.plans && st.plans[id];
    const ready = [...a.events].reverse().find((e) => e.kind === "job" && e.runId === r.runId && e.progress && e.progress.preflight);
    return { done, ms: Date.now() - t0, readyMs, preflight: ready ? ready.progress.preflight : null, summary: pl && pl.summary, refusal: (pl && pl.refusal) || (done.summary && done.summary.refusal) || null };
  };
  return a;
}

function countsOf(summary) {
  const c = { inSync: 0, push: 0, update: 0, replace: 0, delete: 0, rename: 0 };
  for (const s of (summary && summary.series) || []) for (const k of Object.keys(c)) c[k] += (s.counts && s.counts[k]) || 0;
  return c;
}

steps.e2e = async () => {
  (await transportAt("library")).destroy();
  series("SPY×FAMILY", 5, Z.chapterMb);
  series("Hell's Paradise - Jigokuraku", 4, Z.chapterMb);
  series("Plain Series", 3, Z.chapterMb);
  const a = await startService();
  try {
    const id = await a.target();
    const p1 = await a.plan(id);
    record("e2e.plan", { status: p1.done.status, ms: p1.ms, deviceReadyMs: p1.readyMs, preflight: p1.preflight, counts: countsOf(p1.summary), firstSync: p1.summary && p1.summary.firstSync, refusal: p1.refusal });
    if (p1.done.status !== "completed") throw new Error("the first plan didn't complete");
    const t0 = Date.now();
    const ap = await a.call("apply", { targetId: id });
    if (!ap.ok) throw new Error(`apply refused: ${JSON.stringify(ap)}`);
    const done = await a.waitJob(ap.runId);
    const sec = (Date.now() - t0) / 1000;
    const bytes = p1.summary && p1.summary.totals ? p1.summary.totals.bytes : null;
    record("e2e.apply", { status: done.status, ms: Date.now() - t0, mbPerSec: bytes ? +(bytes / MiB / sec).toFixed(1) : null, files: done.summary && { done: done.summary.filesDone, total: done.summary.filesTotal, failed: (done.summary.failed || []).length } });
    const p2 = await a.plan(id);
    const c2 = countsOf(p2.summary);
    record("e2e.replan", { status: p2.done.status, ms: p2.ms, counts: c2, allInSync: c2.push + c2.update + c2.replace + c2.delete + c2.rename === 0 });
    await a.idle();
    const v = await a.call("verify", { targetId: id });
    const vd = v.ok ? await a.waitJob(v.runId) : null;
    record("e2e.verify", v.ok ? { status: vd.status, summary: vd.summary } : { refused: v });
    const tp = await transportAt("library");
    const top = await tp.session.list(TARGET_ROOT);
    record("e2e.layout", { folders: top.entries.filter((e) => e.type === "dir").map((e) => e.name).sort(), nomedia: top.entries.some((e) => e.name === ".nomedia") });
    tp.destroy();
  } finally {
    await a.svc.shutdown({ timeoutMs: 5000 });
  }
};

steps.unplug = async () => {
  (await transportAt("library")).destroy();
  series("Long Series", Z.longChapters, Z.longMb);
  // The fake pushes instantly; throttle it so a few files land before the "unplug".
  if (SELF) fake.dev.inject.bytesPerSec = 2 * MiB;
  const a = await startService();
  try {
    const id = await a.target();
    const p1 = await a.plan(id);
    if (p1.done.status !== "completed") throw new Error(`plan ${p1.done.status}: ${JSON.stringify(p1.refusal)}`);
    const ap = await a.call("apply", { targetId: id });
    if (!ap.ok) throw new Error(`apply refused: ${JSON.stringify(ap)}`);
    for (;;) {
      const ev = [...a.events].reverse().find((e) => e.kind === "job" && e.runId === ap.runId && e.progress);
      if (ev && ev.progress.filesDone >= 3) break;
      if (a.events.some((e) => e.kind === "job" && e.runId === ap.runId && e.state === "done")) throw new Error("the apply finished before the unplug; give it more files");
      await sleep(100);
    }
    await manual("unplug");
    const done = await a.waitJob(ap.runId, 10 * 60_000);
    record("unplug.apply", { status: done.status, filesDone: done.summary && done.summary.filesDone });
    await manual("replug");
    await waitDevice("device", 10 * 60_000);
    if (SELF) fake.dev.inject.bytesPerSec = 0;
    await sleep(2000);
    dropClient();
    const tp = await transportAt("library");
    let filesOnDevice = 0;
    for (const d of (await tp.session.list(TARGET_ROOT)).entries.filter((e) => e.type === "dir")) filesOnDevice += (await tp.session.list(`${TARGET_ROOT}/${d.name}`)).entries.filter((e) => e.type === "file").length;
    tp.destroy();
    const p2 = await a.plan(id);
    const c2 = countsOf(p2.summary);
    record("unplug.resume-plan", { status: p2.done.status, counts: c2, filesOnDevice, ok: p2.done.status === "completed" && c2.replace === 0 && c2.update === 0 && c2.push > 0 });
    const ap2 = await a.call("apply", { targetId: id });
    const d2 = ap2.ok ? await a.waitJob(ap2.runId) : null;
    const p3 = await a.plan(id);
    const c3 = countsOf(p3.summary);
    record("unplug.finish", { apply: ap2.ok ? d2.status : ap2, filesDone: d2 && d2.summary && d2.summary.filesDone, counts: c3, allInSync: c3.push + c3.update + c3.replace + c3.delete + c3.rename === 0 });
  } finally {
    await a.svc.shutdown({ timeoutMs: 5000 });
  }
};

steps.reboot = async () => {
  await connect();
  await manual("reboot");
  if (!SELF) await waitDevice("absent", 5 * 60_000);
  await waitDevice("device", 10 * 60_000);
  await sleep(SELF ? 200 : 5000);
  dropClient();
  await connect();
  const ses = client.device(SERIAL).sync();
  const st = await ses.stat(SCRATCH);
  const l = await ses.list(SCRATCH);
  await ses.close().catch(() => {});
  record("reboot.locked-listing", { scratchStat: { ok: st.ok, error: st.error }, entries: l.entries.length, errored: l.errored.length });
  const a = await startService();
  try {
    const id = await a.target();
    const p = await a.plan(id);
    const c = countsOf(p.summary);
    record("reboot.locked-plan", { status: p.done.status, refusal: p.refusal && { code: p.refusal.code, message: p.refusal.message }, counts: c, ok: p.done.status !== "completed" || c.delete + c.push + c.replace === 0 });
    await manual("unlock");
    const end = Date.now() + 10 * 60_000;
    for (;;) {
      const s2 = client.device(SERIAL).sync();
      const ok = (await s2.stat(SCRATCH)).ok;
      await s2.close().catch(() => {});
      if (ok) break;
      if (Date.now() > end) throw new Error("the scratch root never became readable");
      await sleep(1000);
    }
    await sleep(SELF ? 200 : 2000);
    const p2 = await a.plan(id);
    const c2 = countsOf(p2.summary);
    record("reboot.unlocked-plan", { status: p2.done.status, counts: c2, allInSync: c2.push + c2.update + c2.replace + c2.delete + c2.rename === 0 });
  } finally {
    await a.svc.shutdown({ timeoutMs: 5000 });
  }
};

steps.cleanup = async () => {
  (await transportAt("")).destroy();
  const r = await client.device(SERIAL).shell(`rm -r -- ${shq(SCRATCH)}`);
  record("cleanup", { rc: r.exitCode, stderr: r.stderr.toString("utf8").trim() });
};

steps.checklist = async () => {
  say(`App-level checks (no script can drive these):
  1. Fast Startup connect prompt: with the app CLOSED, Windows Start -> Shut down (not Restart),
     power on, start the app, plug the tablet in. The connect prompt must appear (second review #9).
  2. Komikku: after "e2e", point Komikku's local source at ${TARGET_ROOT}. The three series must
     list with covers and chapters, and ${TARGET_ROOT}/.nomedia must keep the pages out of the
     gallery (review #25).`);
};

steps.auto = async () => {
  for (const s of ["probe", "names", "mtime", "drain", "interrupt", "throughput", "e2e"]) {
    say(`\n== ${s}`);
    await steps[s]();
  }
};

/** Every step against the fake server; asserts on the recorded rows. */
async function selfTest() {
  const { FakeAdbServer } = require(path.join(__dirname, "fake-adb-server.js"));
  const srv = new FakeAdbServer();
  PORT = await srv.listen();
  const dev = srv.addDevice({ serial: SERIAL, inject: { symlinks: { "/sdcard": "/storage/emulated/0" } } });
  fake = { srv, dev };
  let bad = 0;
  const expect = (label, ok, row) => {
    if (!ok) bad += 1;
    say(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : ` — ${JSON.stringify(row)}`}`);
  };
  try {
    // A real device always has the Download folder.
    await connect();
    await client.device(SERIAL).shell(`mkdir -p ${shq(SCRATCH_PARENT)}`);
    for (const s of ["probe", "names", "mtime", "drain", "interrupt", "throughput", "e2e", "unplug", "reboot", "cleanup"]) {
      say(`\n== ${s} (fake)`);
      try {
        await steps[s]();
      } catch (e) {
        record(s, { error: String((e && e.stack) || e).split("\n").slice(0, 4).join(" | ") });
      }
    }
    // transportAt's refusals: a symlinked scratch folder is refused before
    // the mkdir (nothing created at either end), and so is a device whose
    // realpath doesn't work.
    // SCRATCH is recreated for it (a symlink inside a missing folder can't
    // exist on a real device), so the cleanup result is taken first.
    const cleanedUp = !srv.device(SERIAL).fs.lookup(SCRATCH).node;
    say("\n== safety (fake)");
    const elsewhere = "/storage/emulated/0/Elsewhere";
    await client.device(SERIAL).shell(`mkdir -p ${shq(elsewhere)} ${shq(SCRATCH)}`);
    dev.inject.symlinks[`${SCRATCH}/evil`] = elsewhere;
    const refused = async (rel) => {
      try {
        (await transportAt(rel)).destroy();
        return null;
      } catch (e) {
        return String(e.message);
      }
    };
    const redirect = await refused("evil/inner");
    delete dev.inject.symlinks[`${SCRATCH}/evil`];
    dev.inject.tools.realpath = false;
    const noRealpath = await refused("plain");
    dev.inject.tools.realpath = true;
    const fsys = srv.device(SERIAL).fs;
    expect("safety: a symlinked scratch folder is refused", /refusing to write through a redirect/.test(redirect || ""), redirect);
    expect("safety: ...before anything was created", !fsys.lookup(`${elsewhere}/inner`).node && !fsys.lookup(`${SCRATCH}/evil`).node, null);
    expect("safety: a device without realpath is refused", /no working realpath/.test(noRealpath || "") && !fsys.lookup(`${SCRATCH}/plain`).node, noRealpath);
    const row = (step) => results.filter((r) => r.step === step).pop() || {};
    expect("no step errored", !results.some((r) => r.error), results.filter((r) => r.error));
    expect("probe: canonical scratch root, case measured", row("probe").canonicalRoot === SCRATCH && row("probe").caseMeasured !== undefined, row("probe"));
    expect("names: byte-exact", row("names").allExact === true, row("names"));
    expect("mtime: explicit DONE mtime lands", row("mtime").explicit && row("mtime").explicit.atOkay === Math.floor(Date.UTC(2024, 0, 1) / 1000), row("mtime"));
    expect("drain: both sizes measured", results.filter((r) => r.step === "drain" && r.lastDataToOkayMs != null).length === 2, results.filter((r) => r.step === "drain"));
    expect("interrupt: a new file leaves nothing", row("interrupt").newFile && row("interrupt").newFile.aborted && row("interrupt").newFile.exists === false, row("interrupt"));
    expect("throughput: measured", row("throughput").ours && row("throughput").ours.ms >= 0, row("throughput"));
    expect("e2e: plan completed with a device-ready line", row("e2e.plan").status === "completed" && row("e2e.plan").deviceReadyMs != null, row("e2e.plan"));
    expect("e2e: apply completed", row("e2e.apply").status === "completed", row("e2e.apply"));
    expect("e2e: re-plan all in sync", row("e2e.replan").allInSync === true, row("e2e.replan"));
    expect("e2e: verify completed", row("e2e.verify").status === "completed", row("e2e.verify"));
    expect("e2e: the three series on the device", (row("e2e.layout").folders || []).length >= 3, row("e2e.layout"));
    expect("unplug: the apply ended disconnected", row("unplug.apply").status === "disconnected", row("unplug.apply"));
    expect("unplug: the resumed plan has no replaces", row("unplug.resume-plan").ok === true, row("unplug.resume-plan"));
    expect("unplug: finishing leaves all in sync", row("unplug.finish").allInSync === true, row("unplug.finish"));
    expect("reboot: the locked plan proposes no deletes or pushes", row("reboot.locked-plan").ok === true, row("reboot.locked-plan"));
    expect("reboot: unlocked, all in sync", row("reboot.unlocked-plan").allInSync === true, row("reboot.unlocked-plan"));
    expect("cleanup: scratch removed", row("cleanup").rc === 0 && cleanedUp, row("cleanup"));
  } finally {
    dropClient();
    await srv.close();
    fs.rmSync(LIVE_UD, { recursive: true, force: true });
  }
  say(bad ? `\n${bad} self-test failure(s)` : "\nself-test passed");
  return bad;
}

(async () => {
  if (SELF) process.exit((await selfTest()) ? 1 : 0);
  if (argv.includes("--fresh")) fs.rmSync(path.join(LIVE_UD, "userData"), { recursive: true, force: true });
  if (!STEPS.length || STEPS.some((s) => !steps[s])) {
    say(`usage: node tools/_live_device_sync.js <${Object.keys(steps).join("|")}>… [--serial S] [--fresh] | --self-test`);
    process.exit(2);
  }
  say(`serial ${SERIAL}; scratch ${SCRATCH}; PC state ${LIVE_UD}`);
  for (const s of STEPS) {
    say(`\n== ${s}`);
    try {
      await steps[s]();
    } catch (e) {
      record(s, { error: String((e && e.stack) || e).split("\n").slice(0, 4).join(" | ") });
      process.exitCode = 1;
    }
  }
  dropClient();
  process.exit(process.exitCode || 0);
})();
