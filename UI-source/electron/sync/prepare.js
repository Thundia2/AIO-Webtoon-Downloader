// ============================================================
// DEVICE SYNC — PLAN PREPARATION (main process)
//
// Owns everything between "plan this target" and a plan the user can
// review: the device I/O and record repairs the pure planner can't do
// itself (P3 decision: its own module; service.js only calls it). One call,
// in the plan's fixed order ("Provenance": rename intents, then gone
// detection, then pending resolution, coverage Verify and the zero-files
// sanity check; each later step skips gone folders):
//    1. probe the target (case, caps, canonical root, volume id)
//    2. load the record; walk the library; refuse on input refusals
//       (library-missing, record-mismatch) BEFORE any device or record write
//    3. record upkeep: the measured case flag into the header; GC of stale
//       shards, only against a valid header (a missing or corrupt header
//       makes every shard read as stale, and GC would wipe the record)
//    4. list the root; refuse when it is empty while the record manages
//       folders (a locked or half-mounted storage lists as empty)
//    5. folder rename intents, from the root listing's exact names
//    6. gone detection: planner.goneCandidates → STA2 of every name (all
//       ENOENT) → on adb, the rc-checked `find -type d` must list the same
//       directories as LIS2; anything else refuses device-listing-suspect
//    7. list every root folder (FolderTransport sweeps its dot-temps first);
//       read details.json / .aio_series.json for adoption
//    8. file rename intents, then `pending` entries (listing, then one RECV)
//    9. hash the PC files the target mirrors (hash-pool.js cache), last, so
//       a refused plan never pays for it
//   10. buildPlan; STA2 the names it asks about (needsProbe); again
//   11. coverage Verify of plan.needsVerify (executor.verify), reload, plan
//   12. persist the final plan's entryFixes / shardNameFixes
//
// ERRORS: a refusal comes back as {ok:false, code} (contract.js). A device
// fault, a record-write failure or a cancel throws (AdbError, StoreError or
// executor RunStop); service.js maps it with executor.policyFor. Device
// calls wait out `connecting` like the executor (withConnectWait).
//
// Read by: service.js (P4). Depends on: transports.js (through the
// interface), store.js, hash-pool.js, pc-inventory.js, planner.js,
// provenance.js, executor.js (Verify, the connect wait), profiles.js,
// naming.js, contract.js.
// ============================================================

const wire = require("./adb/wire");
const { refuse } = require("./contract");
const { slotKey } = require("./naming");
const { isMirrored } = require("./profiles");
const { loadRecordView, resolvePending, resolveRenameIntent } = require("./provenance");
const planner = require("./planner");
const { walkLibrary } = require("./pc-inventory");
const { Executor, RunStop, withConnectWait, CONNECT_WAIT_MS } = require("./executor");
const { segmentProblem } = require("./transports");

const ENOENT = wire.ERRNO.ENOENT;
// Device-side series metadata read for adoption (parent rule 2: ≤256 KB).
const META_MAX_BYTES = 256 * 1024;
const DEVICE_META = Object.freeze({ details: "details.json", aio: ".aio_series.json" });
// buildPlan asks for name probes; a gone series' verbatim fallback is only
// asked for once its earlier candidates were probed, so a few passes.
const PROBE_PASSES = 4;

/**
 * Prepare one target's plan.
 * @param {object} c
 * @param {object} c.transport        AdbTransport | FolderTransport
 * @param {import('./store').RecordStore} c.store
 * @param {import('./hash-pool').HashPool} c.hashPool
 * @param {object} c.target           resolveTargetConfig() result
 * @param {object} c.settings         resolveSyncSettings() result
 * @param {string} c.libraryRoot      getConfiguredOutputRoot()
 * @param {object} [c.opts]
 * @param {'read-back'|'adopt-size'} [c.opts.verifyMode]  for a device without sha256sum
 * @param {'cached'|'rehash'} [c.opts.hashMode]           default settings.syncHashMode
 * @param {string} [c.opts.deletePolicy]
 * @param {AbortSignal} [c.signal]
 * @param {(ev:object)=>void} [c.onProgress]  {phase:'probe'|'hashing'|'listing'|'verify'|'planning', ...}
 * @param {() => number} [c.now]
 * @param {Function} [c.walk]         walkLibrary, injectable
 * @param {object} [c.executorDeps]   extra Executor deps for the coverage Verify (tests: hooks)
 * @param {number} [c.connectWaitMs]
 * @returns {Promise<object>} {ok:true, plan, device, pc, view, probe, target,
 *   verify, warnings} or a refusal
 */
async function preparePlan(c) {
  const transport = c.transport;
  const store = c.store;
  const signal = c.signal || null;
  const now = c.now || Date.now;
  const opts = c.opts || {};
  const settings = c.settings || {};
  const progress = c.onProgress || (() => {});
  const warnings = [];
  const waitOpts = { timeoutMs: c.connectWaitMs != null ? c.connectWaitMs : CONNECT_WAIT_MS, signal };
  const dev = (fn) => withConnectWait(transport, fn, waitOpts);
  const checkCancel = () => {
    if (signal && signal.aborted) throw new RunStop("cancelled", "cancelled");
  };

  // 1. probe
  progress({ phase: "probe" });
  const probe = await dev(() => transport.probe());
  checkCancel();
  // A folder target's identity carries the volume measured now, so a
  // different disk at the same drive letter is a record-mismatch.
  const target = c.target.kind === "folder" && probe.volumeId != null ? { ...c.target, volumeId: String(probe.volumeId) } : c.target;

  // 2. record, library, input refusals
  const loaded = await store.load();
  for (const x of loaded.corrupt) warnings.push({ kind: "shard-corrupt", shardId: x.shardId, error: x.error });
  if (loaded.headerState === "corrupt") warnings.push({ kind: "header-corrupt" });
  const pc = await (c.walk || walkLibrary)(c.libraryRoot);
  checkCancel();
  const measured = { canonicalRoot: probe.canonicalRoot || null };
  // Unmeasured case (nothing to flip): a stored flag wins; with no record
  // the probe's assumed case-insensitive stands.
  if (probe.caseMeasured || !loaded.header) measured.caseInsensitive = !!probe.caseInsensitive;
  const viewOf = (l) => loadRecordView({ header: l.header, shards: l.shards, selection: l.selection, target, measured });
  let view = viewOf(loaded);
  const early = planner.inputRefusal(pc, view);
  if (early) return { ...early, warnings };
  if (pc.warnings && pc.warnings.length) warnings.push(...pc.warnings);

  // 3. record upkeep (only against a valid header)
  if (view.epoch) {
    const h = loaded.header;
    if (probe.caseMeasured && (h.caseInsensitive !== !!probe.caseInsensitive || !h.caseMeasured)) {
      await store.updateHeader({ caseInsensitive: !!probe.caseInsensitive, caseMeasured: true });
    }
    if (view.staleShardIds.length) await store.gc(view.staleShardIds);
  }

  // 4. root listing
  progress({ phase: "listing", done: 0, total: null });
  let root = await dev(() => transport.listRoot());
  if (!root.ok) return { ...refuse("device-listing-suspect", "the target folder can't be listed", { detail: root.error }), warnings };
  if (root.undecodable.length) warnings.push({ kind: "undecodable-names", folder: null, names: root.undecodable.map((u) => u.display) });
  const visibleDirs = (l) => l.dirs.filter((d) => !d.name.startsWith("."));
  if (view.shards.length && !visibleDirs(root).length) {
    return {
      ...refuse("device-listing-suspect", "the device lists no folders while this target has synced series (locked or not mounted?)", { detail: "empty-root" }),
      warnings,
    };
  }

  // 5. folder rename intents
  if (await _folderIntents(view, root, { dev, transport, store, warnings })) {
    root = await dev(() => transport.listRoot());
    if (!root.ok) return { ...refuse("device-listing-suspect", "the target folder can't be listed", { detail: root.error }), warnings };
  }
  checkCancel();

  // 6. gone detection
  const gone = new Set();
  const cands = planner.goneCandidates({ view, pc, target, device: { dirs: root.dirs } });
  for (const cand of cands) {
    let absent = true;
    for (const name of cand.names) {
      if (segmentProblem(name)) {
        absent = false;
        break;
      }
      const st = await dev(() => transport.stat(name));
      if (st.exists && st.type === "dir") {
        return { ...refuse("device-listing-suspect", "a folder the device listing left out exists", { detail: "listing-missed-folder", folder: name }), warnings };
      }
      if (st.exists) {
        absent = false; // something else holds the name: not gone, held
        break;
      }
      if (st.error !== ENOENT) {
        return { ...refuse("device-listing-suspect", "a folder's state can't be read", { detail: `stat-errno-${st.error}`, folder: name }), warnings };
      }
    }
    if (absent) gone.add(cand.shardId);
  }
  if (gone.size && transport.kind === "adb") {
    // A readdir error ends LIS2 early without an error (quiet failures): a
    // second, rc-checked listing must agree before anything reads as gone.
    let alt;
    try {
      alt = await dev(() => transport.listRootDirsAlt());
    } catch (e) {
      if (!(e && e.kind === "remote-fail")) throw e;
      alt = { ok: false, error: "find-failed" };
    }
    if (!alt.ok || !_sameKeys(alt.keys, root.dirKeys)) {
      return { ...refuse("device-listing-suspect", "two listings of the device disagree", { detail: alt.ok ? "listings-differ" : alt.error }), warnings };
    }
  }

  // 7. folder listings and device metadata
  const device = { trusted: true, dirs: root.dirs, rootFiles: root.files, folders: new Map(), meta: new Map() };
  const ci = view.caseInsensitive;
  const boundSlots = new Set(view.shards.map((sh) => slotKey(sh.name, ci)));
  const dirs = visibleDirs(root);
  for (let i = 0; i < dirs.length; i += 1) {
    checkCancel();
    const name = dirs[i].name;
    progress({ phase: "listing", done: i, total: dirs.length, folder: name });
    if (typeof transport.sweepLeftovers === "function") await transport.sweepLeftovers(name);
    const l = await dev(() => transport.listFolder(name));
    device.folders.set(name, l.ok ? { ok: true, files: l.files } : { ok: false, files: [], error: l.error });
    if (!l.ok) continue;
    if (l.undecodable.length) warnings.push({ kind: "undecodable-names", folder: name, names: l.undecodable.map((u) => u.display) });
    const meta = await _readMeta(name, l, { dev, transport, bound: boundSlots.has(slotKey(name, ci)) });
    if (meta) device.meta.set(name, meta);
  }
  progress({ phase: "listing", done: dirs.length, total: dirs.length });

  // 8. file rename intents, then pending entries (gone folders aren't listed)
  for (const sh of view.shards) {
    checkCancel();
    const listed = device.folders.get(sh.name);
    if (!listed || !listed.ok) continue;
    let changed = false;
    if (sh.renameIntent && sh.renameIntent.scope === "file") {
      const r = await _fileIntent(sh, listed, { dev, transport, warnings, ci });
      changed = true;
      if (r.moved) {
        const l = await dev(() => transport.listFolder(sh.name));
        device.folders.set(sh.name, l.ok ? { ok: true, files: l.files } : { ok: false, files: [], error: l.error });
        if (!l.ok) {
          await store.writeShard(sh);
          continue;
        }
      }
    }
    if (await _resolvePendingIn(sh, device.folders.get(sh.name), { dev, transport, warnings, ci, signal })) changed = true;
    if (changed) await store.writeShard(sh);
  }

  // 9. PC hashes: last, so a device that refuses never costs a first-time
  // hash of the whole library
  await _hashPc(c.hashPool, pc, target, {
    mode: opts.hashMode || settings.syncHashMode || "cached",
    signal,
    progress,
    warnings,
  });
  checkCancel();

  // 10-11. plan, name probes, coverage Verify, plan again
  const nameProbe = new Map();
  const planOpts = { now: now(), deletePolicy: opts.deletePolicy, gone, nameProbe };
  progress({ phase: "planning" });
  let plan = await _planWithProbes({ target, settings, pc, device, view, opts: planOpts }, { dev, transport });
  if (plan.ok === false) return { ...plan, warnings };

  let verify = null;
  if (plan.needsVerify.length) {
    const mode = transport.kind === "folder" || (probe.caps && probe.caps.sha256sum) ? "device-hash" : opts.verifyMode;
    if (mode !== "read-back" && mode !== "adopt-size" && mode !== "device-hash") {
      return {
        ...refuse("needs-mode", "this device can't hash files: choose how to verify", {
          folders: plan.needsVerify.map((v) => v.folder),
          modes: ["read-back", "adopt-size"],
        }),
        warnings,
      };
    }
    const pcByKey = new Map(pc.series.map((s) => [planner.pcSeriesKey(s.folder), s]));
    const ex = new Executor({
      transport,
      store,
      hashPool: c.hashPool,
      target,
      settings,
      probe,
      view,
      signal,
      now,
      connectWaitMs: waitOpts.timeoutMs,
      onProgress: (ev) => progress({ ...ev, phase: "verify" }),
      ...(c.executorDeps || {}),
    });
    verify = await ex.verify({
      mode,
      folders: plan.needsVerify.map((v) => {
        const s = pcByKey.get(v.seriesKey);
        return {
          folder: v.folder,
          shardId: v.shardId,
          binding: v.binding,
          pcFiles: s ? s.files.filter((f) => f.sha256 && isMirrored(f.name, target)) : [],
        };
      }),
    });
    if (verify.status !== "completed") throw verify.cause || new RunStop(verify.status, verify.reason);
    for (const row of verify.folders) {
      if (row.outcome !== "verified") warnings.push({ kind: "verify-failed", folder: row.folder, reason: row.reason });
    }
    view = viewOf(await store.load());
    plan = await _planWithProbes({ target, settings, pc, device, view, opts: planOpts }, { dev, transport });
    if (plan.ok === false) return { ...plan, warnings, verify };
  }

  // 12. what the plan read off the listing becomes the record's
  await _persistFixes(plan, view, store);
  if (c.hashPool) await c.hashPool.flush().catch(() => {});
  return { ok: true, plan, device, pc, view, probe, target, verify, warnings };
}

// ------------------------------------------------------------------ steps

async function _hashPc(hashPool, pc, target, { mode, signal, progress, warnings }) {
  if (!hashPool) return;
  const files = [];
  for (const s of pc.series) {
    if (s.imageOnly || !planner.isIncluded(s, target)) continue;
    for (const f of s.files) if (isMirrored(f.name, target)) files.push(f);
  }
  progress({ phase: "hashing", done: 0, total: files.length, bytesDone: 0, bytesTotal: null });
  const res = await hashPool.hashFiles(files, {
    mode,
    signal,
    onProgress: (done, total, bytesDone, bytesTotal) => progress({ phase: "hashing", done, total, bytesDone, bytesTotal }),
  });
  for (const f of files) {
    const r = res.get(f.path);
    // The sha must belong to the stat the plan uses: a file that changed
    // since the walk stays unhashed (no op) until the next plan.
    if (r && r.sha256 && r.size === f.size && String(r.mtimeNs) === String(f.mtimeNs)) f.sha256 = r.sha256;
    else warnings.push({ kind: "pc-unhashed", path: f.path, error: (r && r.error) || "changed-since-walk" });
  }
  // A walk that skipped anything doesn't prune: the cache would lose
  // entries of files that still exist.
  const complete = !pc.series.some((s) => s.readError) && !(pc.warnings || []).length;
  if (complete) hashPool.prune(pc.series.flatMap((s) => s.files.map((f) => f.path)));
}

function _sameKeys(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * Finish or revert leftover folder renames (executor.renameFolder) from the
 * root listing's exact names. A gone intent stays: gone detection STA2s
 * every name it holds.
 * @returns {Promise<boolean>} whether a folder was moved (re-list the root)
 */
async function _folderIntents(view, root, { dev, transport, store, warnings }) {
  const present = new Set(root.dirs.map((d) => d.name));
  let moved = false;
  for (const sh of view.shards) {
    const ri = sh.renameIntent;
    if (!ri || ri.scope === "file") continue;
    const r = resolveRenameIntent(ri, present);
    if (r.state === "gone") continue;
    if (r.state === "done") sh.name = ri.to;
    else if (r.state === "not-started") sh.name = ri.from;
    else if (r.state === "conflict") {
      sh.name = ri.from;
      warnings.push({ kind: "rename-conflict", scope: "folder", from: ri.from, to: ri.to });
    } else if (r.state === "mid") {
      const fin = await dev(() => transport.move(ri.via, ri.to));
      moved = true;
      if (fin.ok) sh.name = ri.to;
      else {
        const back = await dev(() => transport.move(ri.via, ri.from));
        if (back.ok) sh.name = ri.from;
        else {
          warnings.push({ kind: "rename-unresolved", scope: "folder", via: ri.via, from: ri.from, to: ri.to, reason: fin.reason });
          continue;
        }
      }
    }
    sh.renameIntent = null;
    await store.writeShard(sh);
  }
  return moved;
}

/**
 * Finish or revert a leftover rename-to-match inside one folder, from the
 * folder listing's exact names; the entry follows the file. Mutates sh.
 * @returns {Promise<{moved:boolean}>}
 */
async function _fileIntent(sh, listed, { dev, transport, warnings, ci }) {
  const ri = sh.renameIntent;
  const present = new Set(listed.files.map((f) => f.name));
  const r = resolveRenameIntent(ri, present);
  const follow = () => {
    const from = slotKey(ri.from, ci);
    const e = sh.files.get(from);
    sh.files.delete(from);
    if (e) sh.files.set(slotKey(ri.to, ci), { ...e, name: ri.to });
  };
  let moved = false;
  if (r.state === "done") follow();
  else if (r.state === "conflict") warnings.push({ kind: "rename-conflict", scope: "file", folder: sh.name, from: ri.from, to: ri.to });
  else if (r.state === "mid") {
    moved = true;
    const fin = await dev(() => transport.move(`${sh.name}/${ri.via}`, `${sh.name}/${ri.to}`));
    if (fin.ok) follow();
    else {
      const back = await dev(() => transport.move(`${sh.name}/${ri.via}`, `${sh.name}/${ri.from}`));
      if (!back.ok) {
        warnings.push({ kind: "rename-unresolved", scope: "file", folder: sh.name, via: ri.via, from: ri.from, to: ri.to, reason: fin.reason });
        return { moved };
      }
    }
  }
  // not-started and gone: the entry stays where it was; the listing decides.
  sh.renameIntent = null;
  return { moved };
}

/**
 * Pending resolution for one listed folder (the plan's table): the listing
 * first, then one RECV hashed on the PC when the size fits. A RECV that
 * fails leaves the entry pending (it plans as a pre-selected update).
 * @returns {Promise<boolean>} whether an entry changed
 */
async function _resolvePendingIn(sh, listed, { dev, transport, warnings, ci, signal }) {
  if (!listed || !listed.ok) return false;
  const bySlot = new Map(listed.files.map((f) => [slotKey(f.name, ci), f]));
  let changed = false;
  for (const [slot, e] of [...sh.files]) {
    if (!e || e.origin !== "pending") continue;
    const f = bySlot.get(slot) || null;
    let r = resolvePending(e, f, undefined);
    if (r.outcome === "needs-recv") {
      let recv;
      try {
        const rb = await dev(() => transport.readBack(`${sh.name}/${f.name}`, { signal }));
        recv = rb.ok && rb.size === f.size ? { sha: rb.sha256 } : { error: rb.ok ? "size-changed" : rb.error || "recv-failed" };
      } catch (err) {
        if (!(err && err.kind === "remote-fail")) throw err;
        recv = { error: err.message };
      }
      r = resolvePending(e, f, recv);
    }
    if (r.outcome === "unresolved") {
      warnings.push({ kind: "pending-unresolved", folder: sh.name, name: e.name });
      continue;
    }
    if (r.entry) sh.files.set(slot, r.entry);
    else sh.files.delete(slot);
    changed = true;
  }
  return changed;
}

/** details.json for every folder; .aio_series.json (a leftover) for unbound ones. */
async function _readMeta(name, listing, { dev, transport, bound }) {
  const meta = {};
  let any = false;
  for (const [key, file] of Object.entries(DEVICE_META)) {
    if (key === "aio" && bound) continue;
    const f = listing.files.find((x) => x.name === file);
    if (!f || f.size > META_MAX_BYTES) continue;
    const buf = await dev(() => transport.readSmall(`${name}/${file}`, META_MAX_BYTES));
    if (!buf) continue;
    any = true;
    try {
      const v = JSON.parse(buf.toString("utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) meta[key] = v;
      else if (key === "details") meta.malformed = true;
    } catch (_) {
      if (key === "details") meta.malformed = true;
    }
  }
  return any ? meta : null;
}

/** buildPlan until every name it asks about has a STA2 answer. */
async function _planWithProbes(input, { dev, transport }) {
  let plan = null;
  for (let pass = 0; pass < PROBE_PASSES; pass += 1) {
    plan = planner.buildPlan(input);
    if (plan.ok === false) return plan;
    const ask = plan.needsProbe.filter((n) => !input.opts.nameProbe.has(n));
    if (!ask.length) return plan;
    for (const n of ask) {
      if (segmentProblem(n)) {
        input.opts.nameProbe.set(n, false);
        continue;
      }
      const st = await dev(() => transport.stat(n));
      input.opts.nameProbe.set(n, !st.exists && st.error === ENOENT);
    }
  }
  return planner.buildPlan(input);
}

/** Persist the final plan's entryFixes and shardNameFixes (and mirror them in the view). */
async function _persistFixes(plan, view, store) {
  const byId = new Map(view.shards.map((sh) => [sh.shardId, sh]));
  const touched = new Set();
  for (const fx of plan.entryFixes || []) {
    const sh = byId.get(fx.shardId);
    if (!sh) continue;
    sh.files.set(fx.slot, fx.entry);
    touched.add(sh);
  }
  for (const fx of plan.shardNameFixes || []) {
    const sh = byId.get(fx.shardId);
    if (!sh || sh.name === fx.name) continue;
    sh.name = fx.name;
    touched.add(sh);
  }
  for (const sh of touched) await store.writeShard(sh);
}

module.exports = { preparePlan, META_MAX_BYTES, PROBE_PASSES };
