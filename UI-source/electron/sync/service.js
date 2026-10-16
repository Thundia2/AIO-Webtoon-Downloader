// ============================================================
// DEVICE SYNC — SERVICE (main process entry point)
//
// Owns the feature's runtime: initDeviceSync(deps) registers every sync:*
// handler and returns the facade main.js calls from its hooks. It wires the
// engine (prepare.js, executor.js, store.js, hash-pool.js, transports.js),
// the monitor (monitor.js), find-sources and the job lane (job-record.js).
//
// FAILURE ISOLATION (review #2; second review #1, #18):
//   * initDeviceSync validates `deps` and THROWS LOUDLY on a missing or
//     mistyped dependency (main.js catches and logs it; sync stays off).
//   * After that nothing escapes: every facade method and every handler
//     catches, logs and resolves. A handler fault answers
//     refuse('invalid', 'internal error: …', {internal:true}).
//
// OFF MEANS INERT. While syncEnabled is false: no socket (port 5037 is
// never touched, get-state included), no read or write under userData/sync,
// no timers, and every channel answers `disabled` except get-state,
// label-preview and both cancels (contract.js CHANNELS_WHILE_DISABLED).
// Turning sync off mid-job cancels the job and the find-sources run first,
// then stops the monitor (applySettings).
//
// JOBS. One lane (job-record.js): plan, verify, apply, prune, rename. A
// job-starting handler answers {ok, runId} at once, or a refusal it can
// decide without device I/O (busy, disconnected, library-missing, blocked
// against the reviewed plan, invalid). Refusals that need the device
// (record-mismatch, device-listing-suspect, needs-mode, a `blocked` found
// on the fresh re-plan) end the job `failed` with summary.refusal set, and
// get-state's plans[targetId].refusal keeps it (P4 call: a plan can take
// minutes, so its device refusals can't be the invoke's answer). Earlier
// than that, every job that prepares a plan sends ONE immediate progress
// line once the device checks are done: progress.step 'device-ready' with
// progress.preflight {kind, caps, canonicalRoot, caseInsensitive,
// caseMeasured, canHash, mayNeedMode, refusal|null} (deviation 14; grep
// preflightSent, prepare.js deviceReady).
//
// CONNECT FLOW (rule 10): a device or folder appearing → PromptMachine →
// one automatic plan per target, queued FIFO behind any running job
// (job-record enqueueAuto) → promptCard → shown now if focused, else on
// the next focus. The prompt offers Review or Not now, never a one-click
// apply (approved design D2): every apply goes through Review's Start.
//
// LINK (P4 decision): sync:link {targetId, suggestionIds} binds each
// suggestion's device folder to its series (RecordStore.bindFolder), refused
// `busy` while any job runs; the folder is then verified by the re-plan it
// queues.
//
// PRE-WARM (P4 decision): hashes what the targets mirror PREWARM_DELAY_MS
// after launch (or at once when sync is switched on), and pauses while a
// download, Check All, a Search-tab search or a sync job runs.
// Throttle (deviation 3): one hash worker while a download or Check All runs.
//
// SERVICE LOG (deviation 15; diag-log.js): userData/sync/logs/service.log
// gets a `start`, `prewarm` (done / error), `stop` or `quit-now` line and a
// copy of every [deviceSync] stderr line, while sync is on and
// syncDiagnosticLog is true. The installed app has no console; this is
// where its sync faults can be read, and P5's packaged smoke reads it as
// its marker. grep: slog
//
// SELECTION. The op choices live in memory per target and are written to
// selection.json on every change. A target never applied to gets its
// identity-only record header written first, so the selection has an epoch
// to belong to (deviation 14; grep _persistSelection).
//
// UI-PASS CONTRACT (U0, plan sync-temp/plans/device-sync-ui-pass.md):
//   * PUSHED, NOT RE-READ. Every change to a target's plan state calls
//     _planChanged(id) → one coalesced `plans` event per target per tick
//     {targetId, summary, refusal, stale, lastRun, gen, removed?}. `adb`
//     and `settings` events cover the rest. get-state is the first read only.
//   * GEN IS THE REVIEW CONTRACT. Every adopted plan gets a new gen
//     (summary.gen). apply {gen} must name the gen the user looked at; a
//     mismatch refuses `blocked` with
//     blocking [{kind:'plan-changed'}]. Without it, an automatic re-plan that
//     landed while the review was open ran its own pre-selections unseen.
//   * PLANNING OPTIONS ARE TARGET FIELDS OR ONE-SHOT (approved design D4/D5,
//     sync-temp/design/approved/spec.md). The removal policy is the target's
//     own `deletePolicy` field, and its stored `verifyMode` (the needs-mode
//     answer) is its baseline: both reach EVERY prepare of it, apply's
//     included (grep _planOpts). Re-check's Re-hash / Read back are one-shot
//     inputs to that one plan or verify job; there is no runtime override
//     state a later automatic re-plan could silently reuse or lose.
//   * LAST RUN: each verify/apply/prune/rename leaves rt.lastRun, so a result
//     outlives the re-plan its own job queues.
//   * DOWNLOAD GUARD: the executor skips a series folder a running download
//     writes (grep _busyCheck).
//
// HANDOFF OBLIGATIONS FOR THE UI PASS (non-UI plan, Integration edits):
//   * render payload.sync in ConfirmQuitDialog (a sync-only close would say
//     "0 downloads are still running", ConfirmQuitDialog.jsx);
//   * mount useDeviceSync in App.jsx;
//   * choose which presets to expose;
//   * draw the name choice for a re-pushed gone folder (rebind,
//     removedOnDevice; decision 10);
//   * add the sync keys to get-settings together with DEFAULT_SETTINGS and
//     the settings-twin test;
//   * "Queue N downloads" for find-sources rows: the existing download IPC,
//     plus config-op add-alias (URL → device folder) per accepted row;
//   * the dev and installed builds can no longer run side by side
//     (single-instance lock): memory electron-app-local-e2e-testing.
//
// Read by: main.js (grep deviceSync). Depends on: everything in sync/,
// ../searcher.js (find-sources' own Searcher), ../resource-limits.js.
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const contract = require("./contract");
const { CHANNELS, CHANNEL_NAMES, CHANNELS_WHILE_DISABLED, EVENT_CHANNEL, VERIFY_MODES, QUIT_ASK_PHASES, refuse } = contract;
const { createJobRecord } = require("./job-record");
const { resolveSyncSettings, SYNC_SETTING_SPECS } = require("./sync-settings");
const profiles = require("./profiles");
const planner = require("./planner");
const { loadRecordView } = require("./provenance");
const { labelPreview } = require("./chapter-labels");
const { segmentProblem, spaceNeeded, AdbTransport, FolderTransport, shq } = require("./transports");
const { WriteQueue, RecordStore, readJson, sweepTmp, newShardId } = require("./store");
const { HashPool, workerCountFor } = require("./hash-pool");
const { walkLibrary } = require("./pc-inventory");
const { preparePlan } = require("./prepare");
const { Executor, RunStop, policyFor, RESERVE_BYTES } = require("./executor");
const { normalizeSeriesUrl } = require("../library");
const mon = require("./monitor");
const { FindSources } = require("./find-sources");
const { AdbClient } = require("./adb/client");
const locate = require("./adb/locate");
const { ServiceLog, insideAsar } = require("./diag-log");

const PREWARM_DELAY_MS = 30 * 1000;
const REPLAN_DEBOUNCE_MS = 10 * 1000;
const BUSY_POLL_MS = 5000;
const SHUTDOWN_MS = 5000;
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const CONFIG_FILE = "sync-targets.json";
const HASH_CACHE_FILE = "pc-hash-cache.json";
const BROWSE_PRESETS = Object.freeze([
  { label: "Komikku local source", path: "/sdcard/Komikku/local" },
  { label: "Mihon local source", path: "/sdcard/Mihon/local" },
  { label: "Downloads", path: "/sdcard/Download" },
  { label: "Internal storage", path: "/sdcard" },
]);
// Stored per-target fields add-target / update-target accept (profiles.js
// resolveTargetConfig reads them; null = profile default).
const TARGET_FIELDS = Object.freeze([
  "name",
  "kind",
  "serial",
  "root",
  "profile",
  "formats",
  "sidecars",
  "nomedia",
  "namingPolicy",
  "renameToMatch",
  "cleanupNames",
  "selection",
  "only",
  "verifyMode", // the needs-mode answer (profiles.js STORED_VERIFY_MODES)
  "deletePolicy", // Removals (profiles.js DELETE_POLICIES; add-target stamps the global)
]);
// Settings whose change alters what a plan offers: applySettings re-plans
// every planned, connected target when one of them changes.
const PLANNING_SETTINGS = Object.freeze(["syncDeletePolicy", "syncHashMode", "syncChapterPatterns", "syncSizeWarnPct"]);
const DEPS = Object.freeze({
  ipcMain: "object",
  send: "function",
  userDataDir: "string",
  getSettings: "function",
  getLibraryRoot: "function",
  getRunningDownloads: "function",
  isCheckAllRunning: "function",
  isSearchRunning: "function",
  resolveSpawnPaths: "function",
  extraEnv: "object",
  onFocus: "function",
  isFocused: "function",
  getWindow: "function",
  showSaveDialog: "function",
});

/** Throws a TypeError naming every missing or mistyped dependency. */
function validateDeps(deps) {
  const d = deps || {};
  const bad = [];
  for (const [k, type] of Object.entries(DEPS)) {
    const v = d[k];
    if (type === "object" ? !v || typeof v !== "object" : typeof v !== type) bad.push(`${k} (${type})`);
  }
  if (d.ipcMain && typeof d.ipcMain.handle !== "function") bad.push("ipcMain.handle (function)");
  if (bad.length) throw new TypeError(`initDeviceSync: missing or mistyped deps: ${bad.join(", ")}`);
}

function _isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function _stderr(...a) {
  try {
    console.error("[deviceSync]", ...a);
  } catch (_) {
    // stderr closed during quit
  }
}

/**
 * @param {object} deps  see DEPS; `_test` (optional) injects
 *   {clientOpts, timers, now, bootEpoch, makeSearcher, prewarmDelayMs,
 *    replanDebounceMs, busyPollMs, platform, locateAdb, ensureServer,
 *    connectWaitMs, executorDeps}
 * @returns {object} the facade (never throws, never rejects)
 */
function initDeviceSync(deps) {
  validateDeps(deps);
  const T = deps._test || {};
  const now = T.now || Date.now;
  const root = deps.userDataDir;
  const configPath = path.join(root, CONFIG_FILE);
  const initAt = now();

  const emit = (kind, payload) => {
    try {
      deps.send(EVENT_CHANNEL, { kind, ...(payload || {}) });
    } catch (e) {
      _log("send failed", e && e.message);
    }
  };
  const jobs = createJobRecord({ send: (ch, p) => {
    try {
      deps.send(ch, p);
    } catch (_) {
      // a destroyed window
    }
  }, now });

  // PLANS PUSH. Callers mark a target dirty; one `plans` event per target
  // goes out on the next tick with the whole per-target view (_planView),
  // so a burst (adopt + lastRun + stale mark in one job end) is one event
  // and the renderer only ever overwrites. grep: _planChanged
  const planDirty = new Set();
  let planFlush = null;
  function _planChanged(targetId) {
    if (!targetId) return;
    planDirty.add(targetId);
    if (planFlush) return;
    planFlush = setImmediate(() => {
      planFlush = null;
      const ids = [...planDirty];
      planDirty.clear();
      for (const id of ids) emit("plans", { targetId: id, ..._planView(id) });
    });
  }
  // Monotonic for the process (start/stop cycles included), so a gen the
  // renderer kept from before a restart of the service can't match a new plan.
  let genSeq = 0;

  let settings = resolveSyncSettings(_safe(() => deps.getSettings(), {}));
  let rawSettings = _safe(() => deps.getSettings(), {}) || {};
  let enabled = settings.syncEnabled;
  let started = false;
  let startP = null;
  let stopP = null;
  let shut = false;

  // The service log (diag-log.js): open from the start's mkdir to the end of
  // a stop or shutdownNow, so nothing is written while sync is off; the
  // closing line is written before it shuts. syncDiagnosticLog gates every
  // line. _log mirrors each stderr line into it.
  let slogOpen = false;
  const slog = new ServiceLog({ dir: path.join(root, "logs"), now, active: () => slogOpen && settings.syncDiagnosticLog !== false });
  function _log(...a) {
    _stderr(...a);
    slog.error(a);
  }
  // Live only while started:
  let queue = null;
  let config = null;
  let hashPool = null;
  let marks = null;
  let prompts = null;
  let tracker = null;
  let watcher = null;
  let findSources = null;
  let client = null;
  let devices = [];
  let adbInfo = { binary: null, serverVersion: null, error: null, candidates: null, at: null };
  let current = null; // {runId, phase, targetId, ac, promise, transport}
  let busyTimer = null;
  let prewarmTimer = null;
  let replanTimer = null;
  let prewarm = { state: "idle", done: 0, total: 0, bytesDone: 0, bytesTotal: 0, at: null };
  let prewarmAc = null;
  let libStatus = null;
  // targetId → {id, store, prep, plan, gen, selOps, selRebinds, selEpoch,
  //   selDeferred, summary, refusal, stale, lastRun}
  const rts = new Map();
  const autoBatches = new Map(); // connKey → {serial, waiting:Set<targetId>, summaries:[]}
  const folderTransports = new Map(); // targetId → FolderTransport (presence only)
  const connected = { adb: new Set(), folder: new Set() }; // connKeys

  function _safe(fn, fallback) {
    try {
      return fn();
    } catch (_) {
      return fallback;
    }
  }

  // ---------------------------------------------------------- config

  function _targets() {
    return (config && config.targets) || [];
  }

  function _target(id) {
    return _targets().find((t) => t.id === id) || null;
  }

  function _cfg(t) {
    return profiles.resolveTargetConfig(t);
  }

  function _rt(id) {
    let r = rts.get(id);
    if (!r) {
      r = {
        id,
        store: new RecordStore({ root, targetId: id, queue, now }),
        prep: null,
        plan: null,
        gen: null,
        selOps: null,
        selRebinds: {},
        selEpoch: null,
        selDeferred: false,
        summary: null,
        refusal: null,
        stale: false,
        lastRun: null,
      };
      rts.set(id, r);
    }
    return r;
  }

  /** What `plans` events and get-state's plans[targetId] carry. */
  function _planView(id) {
    if (!_target(id)) return { removed: true, summary: null, refusal: null, stale: false, lastRun: null, gen: null };
    const rt = rts.get(id);
    if (!rt) return { summary: null, refusal: null, stale: false, lastRun: null, gen: null };
    return { summary: rt.summary, refusal: rt.refusal, stale: rt.stale, lastRun: rt.lastRun, gen: rt.summary ? rt.gen : null };
  }

  async function _loadConfig() {
    const r = await readJson(configPath);
    const v = r.state === "ok" && _isObj(r.value) ? r.value : {};
    const targets = Array.isArray(v.targets) ? v.targets.filter((t) => _isObj(t) && typeof t.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t.id)) : [];
    if (r.state === "corrupt") _log("sync-targets.json unreadable; starting empty:", r.error);
    return { version: Number.isInteger(v.version) ? v.version : 0, adbPath: typeof v.adbPath === "string" ? v.adbPath : null, targets };
  }

  // The `config` event is NOT sent here: config-op sends it after the op's
  // `after` step (an identity clear), so a renderer reacting to it never
  // sees the new config beside the old record's plan.
  async function _saveConfig(next) {
    const body = { ...next, version: (config.version || 0) + 1 };
    await queue.write(configPath, body);
    config = body;
    _syncWatchers();
    // A new or edited target may mirror files the pre-warm hasn't hashed.
    if (prewarm.state !== "running") _schedulePrewarm(Math.max(0, initAt + (T.prewarmDelayMs != null ? T.prewarmDelayMs : PREWARM_DELAY_MS) - now()));
    return config;
  }

  function _publicConfig() {
    if (!config) return null;
    return { version: config.version, adbPath: config.adbPath, targets: config.targets.map((t) => ({ ...t })) };
  }

  // ---------------------------------------------------------- start / stop

  function _ensureStarted() {
    if (!enabled || shut) return Promise.resolve(false);
    if (started) return Promise.resolve(true);
    if (!startP) {
      startP = _start().then(
        () => {
          startP = null;
          return started;
        },
        (e) => {
          startP = null;
          _log("start failed", e && e.stack);
          return false;
        },
      );
    }
    return startP;
  }

  async function _start() {
    if (stopP) await stopP;
    queue = new WriteQueue();
    await fs.promises.mkdir(root, { recursive: true });
    slogOpen = true;
    await sweepTmp(root).catch(() => 0);
    config = await _loadConfig();
    hashPool = new HashPool({ cachePath: path.join(root, HASH_CACHE_FILE), workers: _workers(), queue });
    await hashPool.load();
    marks = new mon.PromptMarks({ dir: root, now, bootEpoch: T.bootEpoch, queue });
    await marks.load();
    prompts = new mon.PromptMachine({
      marks,
      now,
      isFocused: () => deps.isFocused(),
      onPrompt: (ev) => emit("prompt", { action: ev.action, prompt: ev.prompt, prompts: prompts.shown() }),
    });
    client = new AdbClient({ ...(T.clientOpts || {}) });
    findSources = new FindSources({
      targetsDir: path.join(root, "targets"),
      getSettings: () => _safe(() => deps.getSettings(), {}),
      spawnPaths: (s) => deps.resolveSpawnPaths(s),
      isBlocked: () => (_safe(() => deps.isCheckAllRunning(), false) ? "check-all" : _safe(() => deps.isSearchRunning(), false) ? "search" : null),
      emit: (ev) => emit("find", ev),
      makeSearcher: T.makeSearcher || (() => new (require("../searcher").Searcher)({ extraEnv: deps.extraEnv, onLog: () => {} })),
      queue,
      now,
    });
    started = true;
    if (!enabled || shut) {
      // Switched off (or quitting) while starting: undo at once.
      await _stop({ reason: shut ? "shutdown" : "disabled" });
      return;
    }
    // P5's marker reads `module` / `inAsar` (the packaged build loads sync/
    // from inside app.asar) and `workers` (the pre-warm's pool size).
    slog.event("start", {
      module: __filename,
      inAsar: insideAsar(__filename),
      electron: process.versions.electron || null,
      node: process.versions.node,
      platform: process.platform,
      pid: process.pid,
      workers: hashPool.limit,
      targets: _targets().length,
    });
    _syncWatchers();
    const busyMs = T.busyPollMs || BUSY_POLL_MS;
    busyTimer = setInterval(() => _busyTick(), busyMs);
    if (busyTimer.unref) busyTimer.unref();
    const delay = T.prewarmDelayMs != null ? T.prewarmDelayMs : PREWARM_DELAY_MS;
    _schedulePrewarm(Math.max(0, initAt + delay - now()));
    emit("config", { config: _publicConfig() });
  }

  function _workers() {
    try {
      const { cpuPercentForLevel } = require("../resource-limits");
      return workerCountFor(cpuPercentForLevel(rawSettings.cpuLimit));
    } catch (_) {
      return 1;
    }
  }

  /**
   * Stop everything; the job and find-sources are cancelled FIRST.
   * `reason` ('disabled' | 'shutdown') goes into the service log's stop line.
   */
  async function _stop({ timeoutMs = SHUTDOWN_MS, reason = "disabled" } = {}) {
    if (!started) return;
    started = false;
    const t0 = now();
    const hadJob = current ? current.phase : null;
    const hadFind = !!(findSources && _safe(() => findSources.isRunning(), false));
    const waits = [];
    if (current) {
      current.ac.abort();
      waits.push(current.promise);
    }
    if (findSources) waits.push(findSources.cancelAndWait());
    const settled = await _within(Promise.allSettled(waits).then(() => true), timeoutMs);
    const hadTracker = !!tracker;
    if (tracker) tracker.stop();
    tracker = null;
    if (hadTracker) _emitAdb();
    if (watcher) watcher.stop();
    watcher = null;
    for (const t of folderTransports.values()) t.destroy();
    folderTransports.clear();
    clearInterval(busyTimer);
    clearTimeout(prewarmTimer);
    clearTimeout(replanTimer);
    busyTimer = prewarmTimer = replanTimer = null;
    if (prewarmAc) prewarmAc.abort();
    if (prompts) for (const p of prompts.shown()) emit("prompt", { action: "withdraw", prompt: p, prompts: [] });
    for (const k of ["adb", "folder"]) connected[k].clear();
    autoBatches.clear();
    for (const q of jobs.snapshot().queue) jobs.dropTarget(q.targetId);
    devices = [];
    if (hashPool) {
      await hashPool.flush().catch(() => {});
      hashPool.close();
    }
    const flushed = queue ? !!(await _within(queue.whenIdle().then(() => true), timeoutMs)) : true;
    hashPool = null;
    emit("device", _devicePayload());
    // The clean-quit evidence P5 reads: the job and the search ended inside
    // the wait (`settled`) and every record write landed (`flushed`).
    slog.event("stop", { reason, ms: now() - t0, hadJob, hadFind, settled: !!settled, flushed });
    slogOpen = false;
  }

  function _within(p, ms) {
    let t;
    return Promise.race([p, new Promise((r) => (t = setTimeout(r, ms)))]).finally(() => clearTimeout(t));
  }

  // ---------------------------------------------------------- monitors

  function _syncWatchers() {
    if (!started) return;
    const adbTargets = _targets().filter((t) => t.kind === "adb");
    if (adbTargets.length && !tracker) {
      tracker = new mon.DeviceTracker({
        client,
        timers: T.timers,
        ensureServer: () => _ensureServer(),
        onDevices: (rows, info) => _onDevices(rows, info),
        onState: () => _emitAdb(),
      });
      tracker.start();
      _emitAdb();
    } else if (!adbTargets.length && tracker) {
      tracker.stop();
      tracker = null;
      _onDevices([], { source: "lost" });
      _emitAdb();
    }
    const folderTargets = _targets().filter((t) => t.kind === "folder");
    for (const [id, tp] of [...folderTransports]) {
      const t = _target(id);
      if (!t || t.kind !== "folder" || t.root !== tp.root) {
        tp.destroy();
        folderTransports.delete(id);
      }
    }
    for (const t of folderTargets) if (!folderTransports.has(t.id)) folderTransports.set(t.id, new FolderTransport({ root: t.root }));
    if (!watcher && folderTargets.length) watcher = new mon.FolderWatcher({ onChange: (id, present) => _onFolder(id, present), timers: T.timers });
    if (watcher) watcher.setTargets(folderTargets.map((t) => ({ targetId: t.id, transport: folderTransports.get(t.id) })));
    // An adb target edited onto another device: its connection is re-derived.
    _onDevices(devices, { source: "config" });
  }

  function _devicePayload() {
    return { devices: devices.map((d) => ({ serial: d.serial, state: d.state, stateKind: d.stateKind, model: d.model, product: d.product, transportId: d.transportId, targetable: d.targetable })), folderPresence: watcher ? watcher.presence() : {} };
  }

  function _onDevices(rows, info) {
    if (!started) return;
    if (info.source === "lost") {
      prompts.lostAdb();
      for (const k of connected.adb) autoBatches.delete(k);
      connected.adb.clear();
      for (const d of devices) jobs.dropDevice(d.serial);
    }
    devices = rows || [];
    const live = new Map();
    for (const r of devices) {
      if (r.state !== "device" || !r.targetable) continue;
      const tids = _targets().filter((t) => t.kind === "adb" && t.serial === r.serial).map((t) => t.id);
      if (tids.length) live.set(mon.adbConnKey(r), { serial: r.serial, tids });
    }
    for (const k of [...connected.adb]) {
      if (live.has(k)) continue;
      connected.adb.delete(k);
      autoBatches.delete(k);
      prompts.disconnected(k);
      jobs.dropDevice(k.slice(0, k.lastIndexOf("#")));
    }
    for (const [k, v] of live) {
      if (connected.adb.has(k)) continue;
      connected.adb.add(k);
      _connected(k, v.serial, v.tids);
    }
    emit("device", _devicePayload());
  }

  function _onFolder(id, present) {
    if (!started) return;
    const k = mon.folderConnKey(id);
    if (present && !connected.folder.has(k)) {
      connected.folder.add(k);
      _connected(k, null, [id]);
    } else if (!present && connected.folder.has(k)) {
      connected.folder.delete(k);
      autoBatches.delete(k);
      prompts.disconnected(k);
      jobs.dropTarget(id);
    }
    emit("device", _devicePayload());
  }

  function _connected(connKey, serial, targetIds) {
    if (!settings.syncPromptOnConnect) return;
    if (!prompts.connected({ connKey, serial, targetIds })) return;
    autoBatches.set(connKey, { serial, waiting: new Set(targetIds), summaries: [] });
    for (const id of targetIds) jobs.enqueueAuto({ targetId: id, serial });
    _pump();
  }

  /** Is this target's device or folder attached now? */
  function _isConnected(t) {
    if (!t) return false;
    if (t.kind === "adb") return devices.some((d) => d.serial === t.serial && d.state === "device");
    return connected.folder.has(mon.folderConnKey(t.id));
  }

  function _connKeyOf(t) {
    if (t.kind === "folder") return mon.folderConnKey(t.id);
    const d = devices.find((x) => x.serial === t.serial && x.state === "device");
    return d ? mon.adbConnKey(d) : null;
  }

  async function _ensureServer() {
    const bin = await _adbBinary();
    const fn = T.ensureServer || ((c, b) => locate.ensureServer(c, b));
    const r = await fn(client, bin);
    const next = { serverVersion: r.ok ? r.version : null, error: r.ok ? null : String((r.error && r.error.message) || r.error || "no adb server") };
    const changed = next.serverVersion !== adbInfo.serverVersion || next.error !== adbInfo.error;
    adbInfo = { ...adbInfo, ...next };
    if (changed) _emitAdb();
    return r;
  }

  async function _adbBinary({ rescan = false } = {}) {
    if (adbInfo.candidates && !rescan) return adbInfo.binary;
    const fn = T.locateAdb || ((o) => locate.locateAdb(o));
    const r = await fn({ configured: config ? config.adbPath : null });
    adbInfo = { ...adbInfo, binary: r.resolved, candidates: r.candidates, at: now() };
    _emitAdb();
    return r.resolved;
  }

  /** get-state's `adb` and the `adb` event's payload. */
  function _adbView() {
    return {
      binary: adbInfo.binary,
      serverVersion: adbInfo.serverVersion,
      error: adbInfo.error,
      candidates: adbInfo.candidates,
      tracking: tracker ? tracker.mode : "stopped",
      trackingError: tracker ? tracker.error || null : null,
      at: adbInfo.at,
    };
  }

  // Deduplicated: the tracker reports its state on every reconnect attempt.
  let lastAdbSig = null;
  function _emitAdb() {
    const adb = _adbView();
    const sig = JSON.stringify(adb);
    if (sig === lastAdbSig) return;
    lastAdbSig = sig;
    emit("adb", { adb });
  }

  // ---------------------------------------------------------- busy / throttle / pre-warm

  function _externallyBusy() {
    const dl = (_safe(() => deps.getRunningDownloads(), []) || []).length > 0;
    const ca = !!_safe(() => deps.isCheckAllRunning(), false);
    const se = !!_safe(() => deps.isSearchRunning(), false);
    return { heavy: dl || ca, any: dl || ca || se, why: dl ? "download" : ca ? "check-all" : se ? "search" : null };
  }

  function _busyTick() {
    if (!started || !hashPool) return;
    const b = _externallyBusy();
    hashPool.setConcurrency(b.heavy ? 1 : _workers());
    if ((b.any || current) && prewarmAc) prewarmAc.abort();
  }

  function _schedulePrewarm(ms) {
    if (!started) return;
    clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null;
      _prewarm().catch((e) => _log("prewarm", e && e.message));
    }, ms);
    if (prewarmTimer.unref) prewarmTimer.unref();
  }

  function _prewarmEmit(patch) {
    prewarm = { ...prewarm, ...patch, at: now() };
    emit("prewarm", { prewarm });
  }

  async function _prewarm() {
    if (!started || prewarmAc) return;
    const cfgs = _targets().map(_cfg);
    if (!cfgs.length) return _prewarmEmit({ state: "idle", done: 0, total: 0 });
    const b = _externallyBusy();
    if (b.any || current) {
      _prewarmEmit({ state: "paused", reason: b.why || "sync-job" });
      return _schedulePrewarm(T.busyPollMs || BUSY_POLL_MS);
    }
    const ac = new AbortController();
    prewarmAc = ac;
    const t0 = now();
    const s0 = { ...hashPool.stats };
    // P5's marker. `run` is THIS pre-warm's share of the pool's counters (a
    // plan may have hashed before it): run.hashed − run.mainThread ran in the
    // eval'd workers. `spawned` is the pool's lifetime worker count.
    const logEnd = (state, files, reason) => {
      const s = hashPool ? hashPool.stats : s0;
      const run = {};
      for (const k of ["hashed", "hits", "mainThread", "workerDeaths"]) run[k] = s[k] - s0[k];
      slog.event("prewarm", { state, files, ms: now() - t0, reason: reason || null, workers: hashPool ? hashPool.limit : null, fallback: hashPool ? hashPool.fallback : null, spawned: s.spawned, run });
    };
    try {
      const pc = await walkLibrary(deps.getLibraryRoot());
      if (!pc.ok) {
        logEnd("error", 0, pc.error);
        return _prewarmEmit({ state: "error", reason: pc.error });
      }
      const files = [];
      const seen = new Set();
      for (const s of pc.series) {
        if (s.imageOnly) continue;
        for (const f of s.files) {
          if (seen.has(f.path)) continue;
          if (cfgs.some((c) => planner.isIncluded(s, c) && profiles.isMirrored(f.name, c))) {
            seen.add(f.path);
            files.push(f);
          }
        }
      }
      _prewarmEmit({ state: "running", done: 0, total: files.length, reason: null });
      let last = 0;
      await hashPool.hashFiles(files, {
        signal: ac.signal,
        onProgress: (done, total, bytesDone, bytesTotal) => {
          if (now() - last < 500 && done < total) return;
          last = now();
          _prewarmEmit({ state: "running", done, total, bytesDone, bytesTotal });
        },
      });
      await hashPool.flush().catch(() => {});
      logEnd("done", files.length);
      _prewarmEmit({ state: "done" });
    } catch (e) {
      // A pause isn't logged: it repeats every busy poll while a download runs.
      if (ac.signal.aborted) {
        _prewarmEmit({ state: "paused", reason: _externallyBusy().why || "sync-job" });
        _schedulePrewarm(T.busyPollMs || BUSY_POLL_MS);
      } else {
        logEnd("error", null, String((e && e.message) || e));
        _prewarmEmit({ state: "error", reason: String((e && e.message) || e) });
      }
    } finally {
      if (prewarmAc === ac) prewarmAc = null;
    }
  }

  // ---------------------------------------------------------- jobs

  function _transportFor(cfg) {
    if (cfg.kind === "adb") return new AdbTransport({ client, serial: cfg.serial, root: cfg.root });
    return new FolderTransport({ root: cfg.root, hashPool });
  }

  /**
   * Run `fn(runId, signal, transport)` as the lane's one job. Answers
   * {ok, runId} at once; the job ends with status completed / cancelled /
   * failed / disconnected and `summary`.
   */
  function _runJob(spec, fn) {
    if (prewarmAc) prewarmAc.abort();
    const b = jobs.begin(spec);
    if (!b.ok) return b;
    const runId = b.runId;
    const ac = new AbortController();
    const t = _target(spec.targetId);
    const cfg = _cfg(t);
    const transport = _transportFor(cfg);
    const job = { runId, phase: spec.phase, targetId: spec.targetId, ac, transport, promise: null, auto: !!spec.auto };
    current = job;
    job.promise = (async () => {
      let status = "completed";
      let summary = null;
      try {
        const out = await fn(runId, ac.signal, transport, cfg);
        status = (out && out.status) || "completed";
        summary = (out && out.summary) || null;
      } catch (e) {
        const pol = policyFor(e);
        status = pol.action === "stop" ? pol.status : "failed";
        summary = { reason: pol.reason || (e && e.kind) || "failed", message: e && e.message };
        if (pol.reason === "internal") _log(`${spec.phase} job`, e && e.stack);
      } finally {
        try {
          await transport.close();
        } catch (_) {
          // the device left
        }
        transport.destroy();
      }
      if (ac.signal.aborted && status === "completed") status = "cancelled";
      jobs.finish(runId, { status, summary });
      if (current === job) current = null;
      _afterJob(job, status, summary);
    })().catch((e) => _log("job wrapper", e && e.stack));
    return { ok: true, runId };
  }

  function _afterJob(job, status, summary) {
    const lrt = rts.get(job.targetId);
    if (lrt && job.phase !== "plan") {
      // The result outlives the re-plan this job queued (the job event's
      // summary is overwritten by the next begin). A verify's adopted plan
      // already went out as the summary; lastRun doesn't repeat it.
      const { plan: _omit, ...rest } = summary || {};
      lrt.lastRun = { runId: job.runId, phase: job.phase, status, auto: !!job.auto, at: now(), summary: rest };
    }
    _planChanged(job.targetId);
    // Prompt bookkeeping for automatic connect plans.
    if (job.phase === "plan") {
      for (const [k, batch] of autoBatches) {
        if (!batch.waiting.has(job.targetId)) continue;
        batch.waiting.delete(job.targetId);
        const rt = rts.get(job.targetId);
        if (status === "completed" && rt && rt.plan) {
          batch.summaries.push({ ...planner.promptSummary(rt.plan, _selection(rt), rt.prep && rt.prep.device), gen: rt.gen });
        }
        if (!batch.waiting.size) {
          autoBatches.delete(k);
          prompts.planned(k, planner.promptCard(batch.serial, batch.summaries));
        }
      }
      _refreshLibraryStatus();
    }
    // A selection change made during this job on a header-less target.
    const srt = rts.get(job.targetId);
    if (srt && srt.selDeferred) _persistSelection(srt, job.targetId).catch((e) => _log("selection write", e && e.message));
    // A pre-warm that a job paused resumes once the lane is free.
    if (prewarm.state === "paused") _schedulePrewarm(0);
    setImmediate(_pump);
  }

  function _pump() {
    if (!started || current) return;
    for (;;) {
      const next = jobs.takeNextAuto();
      if (!next) return;
      const t = _target(next.targetId);
      if (!t || !_isConnected(t)) continue;
      const r = _startPlan(next.targetId, { auto: true });
      if (r.ok) return;
    }
  }

  function _selection(rt) {
    return planner.effectiveSelection(rt.plan, rt.selOps || {});
  }

  // PERSIST ALWAYS (deviation 14, user decision 2026-10-10). selection.json
  // is tied to the record's epoch, and a target never applied to has no
  // header, so the first selection change writes the identity-only header
  // (sync:link does the same before binding). First-sync rules key on
  // header.firstApplyAt, not on the header existing, so this changes nothing
  // else. While a job runs on this target the header write is deferred
  // (selDeferred, flushed by _afterJob): that job's prepare reloads the store,
  // and a load racing the header write could drop the new epoch.
  async function _persistSelection(rt, targetId) {
    if (!rt.store.epoch) await rt.store.load();
    if (!rt.store.epoch) {
      if (current && current.targetId === targetId) {
        rt.selDeferred = true;
        return false;
      }
      const t = _target(targetId);
      if (!t || !rt.prep) return false;
      const ex = new Executor({ transport: { kind: t.kind }, store: rt.store, target: rt.prep.target, settings, probe: rt.prep.probe, view: rt.prep.view, now });
      await ex.ensureHeader();
      rt.selEpoch = rt.store.epoch;
    }
    rt.selDeferred = false;
    await rt.store.writeSelection({ ops: rt.selOps || {}, rebinds: rt.selRebinds || {} });
    return true;
  }

  // The device-ready line (prepare.js deviceReady; deviation 14) goes out
  // once per job, immediately, as progress.preflight. A job can prepare
  // twice (a verify job, a plan with verifyFirst); only the first counts.
  // It stays in job.progress, so a renderer re-adopting the job through
  // get-state still sees it.
  let preflightSent = 0; // runId

  function _progressOf(runId) {
    return (ev) => {
      if (ev.phase === "device-ready") {
        if (preflightSent === runId) return;
        preflightSent = runId;
        jobs.progress(runId, { step: "device-ready", preflight: ev.preflight || null }, { immediate: true });
        return;
      }
      const p = { step: ev.phase || null };
      if (ev.filesDone != null) Object.assign(p, { filesDone: ev.filesDone, filesTotal: ev.filesTotal, bytesDone: ev.bytesDone, bytesTotal: ev.bytesTotal, current: ev.current || null });
      else if (ev.done != null) Object.assign(p, { filesDone: ev.done, filesTotal: ev.total, bytesDone: ev.bytesDone || 0, bytesTotal: ev.bytesTotal || 0, current: ev.folder || null });
      jobs.progress(runId, p);
    };
  }

  /**
   * The planning options one prepare uses: the target's stored verifyMode
   * (its needs-mode answer), with `extra` (this call's one-shot choice: a
   * Verify's mode, a Re-check's rehash) winning where it is set. Undefined
   * falls through to settings inside prepare. The removal policy isn't an
   * option: buildPlan reads it off the target config.
   */
  function _planOpts(cfg, extra) {
    const out = { hashMode: undefined, verifyMode: cfg.verifyMode || undefined };
    for (const [k, v] of Object.entries(extra || {})) if (v !== undefined) out[k] = v;
    return out;
  }

  async function _prepare(rt, cfg, transport, signal, runId, extra) {
    const opts = _planOpts(cfg, extra);
    const prep = await preparePlan({
      transport,
      store: rt.store,
      hashPool,
      target: cfg,
      settings,
      libraryRoot: deps.getLibraryRoot(),
      opts,
      signal,
      onProgress: _progressOf(runId),
      now,
      connectWaitMs: T.connectWaitMs,
      executorDeps: T.executorDeps,
    });
    if (prep && prep.ok) prep.usedOpts = opts;
    return prep;
  }

  /**
   * What a summary was built with: Review's read-only "Planned with…" line
   * (design D6). hashMode/verifyMode are what THIS plan's prepare used, so a
   * one-shot Re-hash shows on its own plan and is gone from the next.
   */
  function _policyOf(rt) {
    const used = (rt.prep && rt.prep.usedOpts) || {};
    return {
      deletePolicy: rt.plan ? rt.plan.deletePolicy : null,
      hashMode: used.hashMode || settings.syncHashMode || "cached",
      verifyMode: used.verifyMode || null,
    };
  }

  /**
   * Capacity for the gauge (user decision 2): `free` is prepare's one
   * reading; `needed` follows the selection through spaceNeeded, the same
   * formula as the executor's pre-flight. `freeableEarly` is what the
   * executor may delete before pushing (gate-free deletes); `fits` mirrors
   * its refusal test, null while free space is unknown.
   */
  function _capacity(rt, sel) {
    const ops = planner.selectedOps(rt.plan, sel);
    const kind = rt.prep && rt.prep.target ? rt.prep.target.kind : "folder";
    const fsr = (rt.prep && rt.prep.freeSpace) || { bytes: null, asOf: null };
    const delBytes = (o) => (o.devFile && o.devFile.size) || 0;
    const deletes = ops.filter((o) => o.kind === "delete");
    const freeable = deletes.reduce((n, o) => n + delBytes(o), 0);
    const freeableEarly = deletes.filter((o) => !o.gate).reduce((n, o) => n + delBytes(o), 0);
    const needed = spaceNeeded(kind, ops);
    const free = fsr.bytes;
    return {
      free,
      needed,
      reserve: RESERVE_BYTES,
      freeable,
      freeableEarly,
      fits: free == null ? null : needed <= 0 || needed <= free - RESERVE_BYTES + freeableEarly,
      asOf: fsr.asOf,
    };
  }

  /**
   * The target's summary under the current selection: the planner's ledger
   * plus gen, capacity, policy and every warning (prepare's AND the
   * planner's own plan.warnings, which never reached the renderer before).
   * The one builder: adopt, set-selection and a rebind all call it.
   */
  function _summarize(rt) {
    const sel = _selection(rt);
    const s = planner.planSummary(rt.plan, sel);
    s.gen = rt.gen;
    s.warnings = [...((rt.prep && rt.prep.warnings) || []), ...(rt.plan.warnings || [])];
    s.capacity = _capacity(rt, sel);
    s.policy = _policyOf(rt);
    return s;
  }

  /** Adopt a successful prepare as the target's current plan (a new gen). */
  function _adopt(rt, prep) {
    rt.prep = prep;
    rt.plan = prep.plan;
    rt.gen = ++genSeq;
    rt.refusal = null;
    rt.stale = false;
    const epoch = prep.view.epoch;
    if (rt.selOps == null || rt.selEpoch !== epoch) rt.selOps = { ...(prep.view.selection.ops || {}) };
    rt.selRebinds = { ...(prep.view.selection.rebinds || {}) };
    rt.selEpoch = epoch;
    rt.summary = _summarize(rt);
    _planChanged(rt.id);
    return rt.summary;
  }

  function _refused(rt, r) {
    rt.refusal = r;
    rt.summary = null;
    _planChanged(rt.id);
    return { status: "failed", summary: { refusal: r } };
  }

  /** overrides: one-shot {hashMode, verifyMode, verifyFirst} for this plan only. */
  function _startPlan(targetId, { auto = false, overrides = {} } = {}) {
    const t = _target(targetId);
    return _runJob({ phase: "plan", targetId, serial: t.serial, auto }, async (runId, signal, transport, cfg) => {
      const rt = _rt(targetId);
      const opts = { hashMode: overrides.hashMode, verifyMode: overrides.verifyMode };
      let prep = await _prepare(rt, cfg, transport, signal, runId, opts);
      if (!prep.ok) return _refused(rt, prep);
      if (overrides.verifyFirst) {
        const v = await _verifyFolders(rt, prep, transport, signal, runId, overrides.verifyMode || cfg.verifyMode, null);
        if (v.status !== "completed") return { status: v.status, summary: { reason: v.reason } };
        prep = await _prepare(rt, cfg, transport, signal, runId, opts);
        if (!prep.ok) return _refused(rt, prep);
      }
      return { status: "completed", summary: { plan: _adopt(rt, prep) } };
    });
  }

  function _executor(rt, prep, transport, signal, runId) {
    return new Executor({
      transport,
      store: rt.store,
      hashPool,
      target: prep.target,
      settings,
      probe: prep.probe,
      view: prep.view,
      signal,
      now,
      connectWaitMs: T.connectWaitMs,
      onProgress: _progressOf(runId),
      isPathBusy: _busyCheck(prep),
      ...(T.executorDeps || {}),
    });
  }

  // Folder identity for the busy check: resolved, and case-folded on win32
  // (NTFS), so "D:\AIO\manga\X" and "d:/aio/manga/X" are one folder.
  function _pathKey(p) {
    const r = path.resolve(String(p));
    return (T.platform || process.platform) === "win32" ? r.toLowerCase() : r;
  }

  /**
   * DOWNLOAD GUARD (UI-pass design decision 11): the executor's isPathBusy.
   * A series folder is busy while a running download writes it: matched by
   * the download's --series-dir (update-check downloads name the folder),
   * else by its URL against the series' .aio_series.json url through
   * library.js normalizeSeriesUrl. A brand-new series has no PC folder yet;
   * the settle age (planner SETTLE_MS) holds its first files. Evaluated per
   * file at apply time (executor _guard), so a download that starts mid-apply
   * still holds its folder. Rows come from downloader.js getRunning.
   */
  function _busyCheck(prep) {
    const urlByPath = new Map();
    for (const s of (prep.pc && prep.pc.series) || []) {
      const u = s.folderPath && s.url ? normalizeSeriesUrl(s.url) : "";
      if (u) urlByPath.set(_pathKey(s.folderPath), u);
    }
    return (folderPath) => {
      if (!folderPath) return false;
      const key = _pathKey(folderPath);
      const url = urlByPath.get(key) || null;
      for (const d of _safe(() => deps.getRunningDownloads(), []) || []) {
        if (!d) continue;
        if (d.seriesDir && _pathKey(d.seriesDir) === key) return true;
        if (url && d.url && normalizeSeriesUrl(d.url) === url) return true;
      }
      return false;
    };
  }

  async function _verifyFolders(rt, prep, transport, signal, runId, mode, folders) {
    const want = folders ? new Set(folders) : null;
    const pcByKey = new Map(prep.pc.series.map((s) => [planner.pcSeriesKey(s.folder), s]));
    const list = [];
    for (const sp of prep.plan.series) {
      if (!sp.shardId || !sp.deviceFolder || (want && !want.has(sp.deviceFolder))) continue;
      if (sp.state === "gone" || sp.state === "held") continue;
      const s = pcByKey.get(sp.seriesKey);
      list.push({ folder: sp.deviceFolder, shardId: sp.shardId, binding: sp.binding, pcFiles: s ? s.files.filter((f) => f.sha256 && profiles.isMirrored(f.name, prep.target)) : [] });
    }
    const m = transport.kind === "folder" || (prep.probe.caps && prep.probe.caps.sha256sum) ? "device-hash" : mode;
    if (!VERIFY_MODES.includes(m)) return { status: "failed", reason: "needs-mode" };
    return _executor(rt, prep, transport, signal, runId).verify({ folders: list, mode: m, runId: String(runId) });
  }

  // A run's result as jobs and lastRun carry it. `skipped` lists files and
  // deletes the executor passed over with their reason (downloading,
  // settling, changed-since-review, listing-failed, …) and `skippedSeries`
  // whole series (invalid-folder-*, folder-reappeared): without them a run
  // that copied less than the review promised looked like a plain success.
  function _runSummary(r) {
    const count = (arr, k) => (arr || []).reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});
    const skipped = [
      ...(r.files || []).filter((f) => f.outcome === "skipped").map((f) => ({ kind: f.kind || "write", folder: f.folder, name: f.name, reason: f.reason || null })),
      ...(r.deletes || []).filter((d) => d.outcome === "skipped").map((d) => ({ kind: "delete", folder: d.folder, name: d.name, reason: d.reason || null })),
    ];
    return {
      skipped: skipped.slice(0, 50),
      skippedReasons: count(skipped, "reason"),
      skippedSeries: (r.skippedSeries || []).slice(0, 50),
      reason: r.reason || null,
      message: r.message || null,
      filesDone: r.filesDone,
      filesTotal: r.filesTotal,
      bytesDone: r.bytesDone,
      bytesTotal: r.bytesTotal,
      charged: r.charged,
      files: count(r.files, "outcome"),
      failed: (r.files || []).filter((f) => f.outcome === "failed").slice(0, 20).map((f) => ({ folder: f.folder, name: f.name, reason: f.reason })),
      deletes: count(r.deletes, "outcome"),
      renames: count(r.renames, "outcome"),
      evictions: r.evictions && r.evictions.length ? r.evictions : undefined,
      prune: r.prune || undefined,
      folders: r.folders || undefined,
      warnings: (r.warnings || []).slice(0, 50),
    };
  }

  /** Queue a fresh plan of this target behind the current job (after an edit or a run). */
  function _replanSoon(targetId) {
    const rt = rts.get(targetId);
    if (rt && !rt.stale) {
      rt.stale = true;
      _planChanged(targetId);
    }
    const t = _target(targetId);
    if (!t || !_isConnected(t)) return;
    jobs.enqueueAuto({ targetId, serial: t.serial || null });
    setImmediate(_pump);
  }

  // ---------------------------------------------------------- library status

  async function _computeLibraryStatus() {
    const pc = await walkLibrary(deps.getLibraryRoot());
    const bySeries = {};
    if (!pc.ok) return { asOf: now(), bySeries, error: pc.error };
    for (const s of pc.series) for (const f of s.files) f.sha256 = hashPool ? hashPool.lookup(f.path, f.size, f.mtimeNs) : null;
    for (const t of _targets()) {
      const cfg = _cfg(t);
      const rt = _rt(t.id);
      const l = await rt.store.load();
      const view = loadRecordView({ header: l.header, shards: l.shards, selection: l.selection, target: cfg, measured: {} });
      const m = planner.libraryStatus({ pc, view, target: cfg, lastPlan: rt.plan });
      for (const [key, v] of m) (bySeries[key] = bySeries[key] || []).push({ targetId: t.id, ...v });
    }
    return { asOf: now(), bySeries };
  }

  function _refreshLibraryStatus() {
    if (!started) return;
    _computeLibraryStatus().then(
      (s) => {
        libStatus = s;
        emit("library-status", { status: s });
      },
      (e) => _log("library status", e && e.message),
    );
  }

  // ---------------------------------------------------------- handlers

  const H = {};

  // Settings as the renderer sees them: chapterPatterns holds RegExps.
  function _publicSettings() {
    const { chapterPatterns, ...rest } = settings;
    return rest;
  }

  H["get-state"] = async () => {
    if (!enabled) {
      return { ok: true, enabled: false, settings: _publicSettings(), specs: SYNC_SETTING_SPECS, config: null, adb: null, devices: [], folderPresence: {}, job: jobs.snapshot(), plans: {}, prompt: null, prompts: [], find: null, prewarm: null };
    }
    if (!(await _ensureStarted())) return refuse("disabled", "sync could not start");
    const plans = {};
    for (const t of _targets()) plans[t.id] = _planView(t.id);
    const shown = prompts.shown();
    return {
      ok: true,
      enabled: true,
      settings: _publicSettings(),
      specs: SYNC_SETTING_SPECS,
      config: _publicConfig(),
      adb: _adbView(),
      ..._devicePayload(),
      job: jobs.snapshot(),
      plans,
      prompt: shown[0] || null,
      prompts: shown,
      find: findSources.status(),
      prewarm,
    };
  };

  H["label-preview"] = async (p) => {
    const patterns = p.patterns != null ? p.patterns : settings.syncChapterPatterns;
    return { ok: true, ...labelPreview({ name: p.name, folderName: p.folderName, patterns }) };
  };

  H.cancel = async () => {
    if (!current) return { ok: true, wasRunning: false };
    current.ac.abort();
    return { ok: true, wasRunning: true };
  };

  H["find-sources:cancel"] = async () => {
    if (!findSources) return { ok: true, wasRunning: false };
    return { ok: true, ...findSources.cancel() };
  };

  // --- config ops

  const OPS = {};

  function _cleanTarget(src, base) {
    const out = { ...(base || {}) };
    for (const k of TARGET_FIELDS) if (k in src) out[k] = src[k] == null ? null : src[k];
    if (out.root && out.kind === "adb") out.root = String(out.root).replace(/\/+$/, "") || "/";
    return out;
  }

  function _validate(t) {
    return profiles.validateTarget(t, { libraryRoot: _safe(() => deps.getLibraryRoot(), null), userDataDir: root, platform: T.platform });
  }

  function _jobOn(targetId) {
    return !!current && current.targetId === targetId;
  }

  function _listEdit(p, field, fn) {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    const list = Array.isArray(t[field]) ? t[field].slice() : [];
    const r = fn(list);
    if (r && r.ok === false) return r;
    return { patch: { [field]: r || list } };
  }

  async function _identityClear(targetId, cfg) {
    const rt = _rt(targetId);
    const l = await rt.store.load();
    const keep = l.header && !profiles.recordIdentityChanged(l.header, cfg) ? l.header : null;
    const id = profiles.recordIdentity(cfg);
    if (cfg.kind === "folder") {
      // The header pins the volume measured now (prepare.js compares it).
      const tp = new FolderTransport({ root: cfg.root });
      const pr = await tp.probe().catch(() => null);
      id.volumeId = pr && pr.volumeId != null ? String(pr.volumeId) : keep ? keep.volumeId || null : null;
    }
    await rt.store.clear({
      version: 1,
      ...id,
      canonicalRoot: null,
      caseInsensitive: keep ? !!keep.caseInsensitive : true,
      caseMeasured: keep ? !!keep.caseMeasured : false,
      caps: {},
    });
    rt.prep = rt.plan = rt.summary = rt.refusal = rt.gen = null;
    rt.selOps = null;
    rt.selRebinds = {};
    if (findSources) await findSources.forget(targetId);
    _planChanged(targetId);
  }

  OPS["add-target"] = async (p) => {
    if (!_isObj(p.target)) return refuse("invalid", "target required");
    // A new target starts with the global "Removals for new targets"
    // (design D5); changing that setting later never moves this target.
    const t = _cleanTarget(p.target, {
      id: `t${crypto.randomBytes(5).toString("hex")}`,
      deletePolicy: settings.syncDeletePolicy || "guarded",
      excludes: [],
      aliases: [],
      ignoredSuggestions: [],
      acknowledged: [],
    });
    const errors = _validate(t);
    if (errors.length) return refuse("invalid", errors[0].message, { errors });
    return { next: { ...config, targets: [..._targets(), t] }, targetId: t.id };
  };

  OPS["update-target"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    if (!_isObj(p.patch)) return refuse("invalid", "patch required");
    const next = _cleanTarget(p.patch, t);
    const errors = _validate(next);
    if (errors.length) return refuse("invalid", errors[0].message, { errors });
    const identity = profiles.recordIdentityChanged(_cfg(t), _cfg(next));
    if (identity && _jobOn(t.id)) return refuse("busy", "that target's job is running");
    return { next: { ...config, targets: _targets().map((x) => (x.id === t.id ? next : x)) }, after: identity ? () => _identityClear(t.id, _cfg(next)) : null, targetId: t.id, replan: !identity };
  };

  OPS["remove-target"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    if (_jobOn(t.id)) return refuse("busy", "that target's job is running");
    return {
      next: { ...config, targets: _targets().filter((x) => x.id !== t.id) },
      after: async () => {
        jobs.dropTarget(t.id);
        rts.delete(t.id);
        _planChanged(t.id); // → {removed:true}
        if (findSources) await findSources.forget(t.id);
        const dir = path.join(root, "targets", t.id);
        await fs.promises.rm(dir, { recursive: true, force: true }).catch((e) => _log("remove-target rm", e && e.message));
      },
    };
  };

  OPS["forget-record"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    if (_jobOn(t.id)) return refuse("busy", "that target's job is running");
    return { next: null, after: () => _identityClear(t.id, _cfg(t)), targetId: t.id, replan: true };
  };

  OPS["set-adb-path"] = async (p) => {
    const v = p.path == null || p.path === "" ? null : String(p.path);
    if (v != null && (!path.isAbsolute(v) || /[\0\r\n]/.test(v))) return refuse("invalid", "the adb path must be absolute");
    adbInfo = { ...adbInfo, candidates: null };
    return { next: { ...config, adbPath: v } };
  };

  const _seriesRef = (e) => _isObj(e) && (typeof e.identityKey === "string" || typeof e.url === "string" || typeof e.pcFolder === "string");
  const _pick = (e, keys) => Object.fromEntries(keys.filter((k) => typeof e[k] === "string" && e[k]).map((k) => [k, e[k]]));

  OPS["add-alias"] = async (p) =>
    _listEdit(p, "aliases", (list) => {
      const a = p.alias;
      if (!_seriesRef(a) || typeof a.deviceFolder !== "string") return refuse("invalid", "an alias needs a series and a device folder");
      const why = segmentProblem(a.deviceFolder);
      if (why) return refuse("invalid", `invalid device folder name (${why})`);
      list.push(_pick(a, ["identityKey", "url", "pcFolder", "deviceFolder"]));
      return list;
    });
  OPS["remove-alias"] = async (p) =>
    _listEdit(p, "aliases", (list) => {
      if (!Number.isInteger(p.index) || p.index < 0 || p.index >= list.length) return refuse("invalid", "no alias at that index");
      list.splice(p.index, 1);
      return list;
    });
  OPS["add-exclude"] = async (p) =>
    _listEdit(p, "excludes", (list) => {
      if (!_seriesRef(p.entry)) return refuse("invalid", "an exclude needs a series");
      const e = _pick(p.entry, ["identityKey", "url", "pcFolder"]);
      if (p.entry.removeFiles === true) e.removeFiles = true;
      list.push(e);
      return list;
    });
  OPS["remove-exclude"] = async (p) =>
    _listEdit(p, "excludes", (list) => {
      if (!Number.isInteger(p.index) || p.index < 0 || p.index >= list.length) return refuse("invalid", "no exclude at that index");
      list.splice(p.index, 1);
      return list;
    });
  /** The series a plan names as a stored list entry (excludes, only). */
  function _planSeriesRef(targetId, seriesKey) {
    const rt = rts.get(targetId);
    const sp = rt && rt.plan ? rt.plan.bySeriesKey.get(String(seriesKey)) : null;
    if (!sp) return null;
    return _pick({ identityKey: sp.identityKey, url: sp.urlKey, pcFolder: sp.folder }, ["identityKey", "url", "pcFolder"]);
  }

  /**
   * True when a stored list entry refers to `ref`'s series by any one key:
   * looser than naming.findSeriesEntry's precedence on purpose, so removing
   * or including a series clears every entry that could still match it.
   */
  function _sameSeries(entry, ref) {
    if (!entry) return false;
    if (ref.identityKey && entry.identityKey === ref.identityKey) return true;
    if (ref.url && entry.url && normalizeSeriesUrl(entry.url) === normalizeSeriesUrl(ref.url)) return true;
    return !!ref.pcFolder && entry.pcFolder === ref.pcFolder;
  }

  // "Remove from <target>" (approved design D7): stop syncing the series
  // there AND remove its files, through Review. One saved exclude entry
  // carries both (removeFiles; planner.js 8b turns it into delete ops), so an
  // automatic re-plan can't drop the pending removal. In `only` mode the
  // series also leaves the only-list, or the exclude would mean nothing.
  OPS["remove-series"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    const ref = _planSeriesRef(t.id, p.seriesKey);
    if (!ref) return refuse("invalid", "that series isn't in this target's plan");
    const excludes = (t.excludes || []).filter((e) => !_sameSeries(e, ref));
    excludes.push({ ...ref, removeFiles: true });
    const only = (t.only || []).filter((e) => !_sameSeries(e, ref));
    return { patch: { excludes, only } };
  };
  // The ledger's Include (design D8) and the undo of remove-series: every
  // exclude of the series goes (its removeFiles mark with it), and in `only`
  // mode it joins the only-list.
  OPS["include-series"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    const ref = _planSeriesRef(t.id, p.seriesKey);
    if (!ref) return refuse("invalid", "that series isn't in this target's plan");
    const excludes = (t.excludes || []).filter((e) => !_sameSeries(e, ref));
    const only = (t.only || []).slice();
    if (_cfg(t).selection === "only" && !only.some((e) => _sameSeries(e, ref))) only.push(ref);
    return { patch: { excludes, only } };
  };

  OPS["set-selection-mode"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    if (!profiles.SELECTION_MODES.includes(p.mode)) return refuse("invalid", "unknown series selection mode");
    const only = Array.isArray(p.only) ? p.only.filter(_seriesRef).map((e) => _pick(e, ["identityKey", "url", "pcFolder"])) : t.only || [];
    return { patch: { selection: p.mode, only } };
  };
  const _idList = (field, key, add) => async (p) =>
    _listEdit(p, field, (list) => {
      const id = p[key];
      if (typeof id !== "string" || !id) return refuse("invalid", `${key} required`);
      const has = list.includes(id);
      if (add && !has) list.push(id);
      if (!add && has) list.splice(list.indexOf(id), 1);
      return list;
    });
  OPS["ack-anomaly"] = _idList("acknowledged", "anomalyId", true);
  OPS["unack-anomaly"] = _idList("acknowledged", "anomalyId", false);
  OPS["ignore-suggestion"] = _idList("ignoredSuggestions", "suggestionId", true);
  OPS["unignore-suggestion"] = _idList("ignoredSuggestions", "suggestionId", false);

  H["config-op"] = async (p) => {
    const fn = OPS[p.op];
    if (!fn) return refuse("invalid", `unknown config op ${p.op}`);
    if (p.expectVersion != null && p.expectVersion !== config.version) {
      return refuse("version-conflict", "the sync settings changed meanwhile", { config: _publicConfig() });
    }
    let r = await fn(p);
    if (r && r.ok === false) return r;
    if (r.patch) {
      const t = _target(p.targetId);
      const next = { ...t, ...r.patch };
      r = { next: { ...config, targets: _targets().map((x) => (x.id === t.id ? next : x)) }, targetId: t.id, replan: true };
    }
    if (r.next) await _saveConfig(r.next);
    if (r.after) await r.after();
    if (r.next) emit("config", { config: _publicConfig() });
    if (r.targetId && r.replan) _replanSoon(r.targetId);
    return { ok: true, config: _publicConfig(), ...(r.targetId && p.op === "add-target" ? { targetId: r.targetId } : {}) };
  };

  // --- adb

  H["locate-adb"] = async (p) => {
    await _adbBinary({ rescan: !!p.rescan });
    let serverVersion = null;
    if (adbInfo.binary) {
      const s = await _ensureServer();
      serverVersion = s.ok ? s.version : null;
    }
    return { ok: true, candidates: adbInfo.candidates || [], resolved: adbInfo.binary, serverVersion, error: adbInfo.error };
  };

  H["list-devices"] = async () => {
    const s = await _ensureServer();
    if (!s.ok) return refuse("disconnected", `no adb server: ${adbInfo.error}`);
    const rows = await client.devices();
    return { ok: true, devices: rows.map((d) => ({ serial: d.serial, state: d.state, stateKind: d.stateKind, model: d.model, product: d.product, transportId: d.transportId, targetable: d.targetable })) };
  };

  function _validRemote(p) {
    return typeof p === "string" && p.startsWith("/") && !/[\0\r\n]/.test(p) && !p.split("/").includes("..") && Buffer.byteLength(p) <= 1018;
  }

  H["browse-remote"] = async (p) => {
    if (typeof p.serial !== "string" || !p.serial) return refuse("invalid", "serial required");
    const want = p.path == null ? "/sdcard" : String(p.path);
    if (!_validRemote(want)) return refuse("invalid", "an absolute device path without '..'");
    const s = await _ensureServer();
    if (!s.ok) return refuse("disconnected", `no adb server: ${adbInfo.error}`);
    const dev = client.device(p.serial);
    const session = dev.sync();
    try {
      let canonical = want.replace(/\/+$/, "") || "/";
      try {
        const rp = await dev.shell(`realpath ${shq(canonical)}`);
        const out = rp.stdout.toString("utf8").replace(/\r?\n$/, "");
        if (rp.exitCode === 0 && _validRemote(out)) canonical = out;
      } catch (e) {
        if (e && (e.kind === "device-lost" || e.kind === "offline" || e.kind === "unauthorized")) return refuse("disconnected", e.message);
      }
      const l = await session.list(canonical);
      const entries = (l.entries || l.dirs || [])
        .filter((e) => e && e.name && e.name !== "." && e.name !== ".." && (e.type === "dir" || e.isDir))
        .map((e) => ({ name: e.name, isDir: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // /sdcard is a symlink: STA2 the presets under its real path.
      let sdcard = "/sdcard";
      try {
        const rs = await dev.shell("realpath /sdcard");
        const out = rs.stdout.toString("utf8").replace(/\r?\n$/, "");
        if (rs.exitCode === 0 && _validRemote(out)) sdcard = out;
      } catch (_) {
        // keep /sdcard
      }
      const presets = [];
      for (const pr of BROWSE_PRESETS) {
        const real = pr.path === "/sdcard" ? sdcard : pr.path.startsWith("/sdcard/") ? sdcard + pr.path.slice(7) : pr.path;
        const st = await session.stat(real).catch(() => ({ ok: false }));
        presets.push({ ...pr, exists: !!st.ok && st.type === "dir" });
      }
      const parent = canonical === "/" ? null : canonical.slice(0, canonical.lastIndexOf("/")) || "/";
      return { ok: true, path: canonical, parent, entries, presets };
    } catch (e) {
      if (e && ["device-lost", "offline", "unauthorized", "connecting", "server-unavailable"].includes(e.kind)) return refuse("disconnected", e.message);
      throw e;
    } finally {
      await session.close().catch(() => {});
    }
  };

  // --- jobs

  function _jobPre(p) {
    const t = _target(p.targetId);
    if (!t) return { refusal: refuse("invalid", "unknown target") };
    if (current) return { refusal: refuse("busy", "another sync job is running", { job: jobs.snapshot().job }) };
    if (!_isConnected(t)) return { refusal: refuse("disconnected", t.kind === "adb" ? "the device isn't connected" : "the folder isn't available") };
    return { t };
  }

  async function _libraryPresent() {
    try {
      return (await fs.promises.stat(deps.getLibraryRoot())).isDirectory();
    } catch (_) {
      return false;
    }
  }

  H.plan = async (p) => {
    const pre = _jobPre(p);
    if (pre.refusal) return pre.refusal;
    if (!(await _libraryPresent())) return refuse("library-missing", "the library folder can't be read");
    const o = _isObj(p.overrides) ? p.overrides : {};
    // Removals are a target field now (design D5): an override would be a
    // second, invisible policy. Refused loudly so a stale caller can't think
    // it re-planned add-only.
    if ("deletePolicy" in o || "clearOverrides" in o) return refuse("invalid", "removals are a target setting: update-target {deletePolicy}");
    const overrides = {
      hashMode: ["cached", "rehash"].includes(o.hashMode) ? o.hashMode : undefined,
      verifyFirst: o.verifyFirst === true,
      verifyMode: ["read-back", "adopt-size"].includes(o.verifyMode) ? o.verifyMode : undefined,
    };
    const rt = _rt(pre.t.id);
    const stored = _cfg(pre.t).verifyMode;
    if (rt.prep && rt.prep.probe && pre.t.kind === "adb" && !(rt.prep.probe.caps || {}).sha256sum && overrides.verifyFirst && !overrides.verifyMode && !stored) {
      return refuse("needs-mode", "this device can't hash files: choose how to verify", { modes: ["read-back", "adopt-size"] });
    }
    return _startPlan(pre.t.id, { overrides });
  };

  H["series-detail"] = async (p) => {
    const rt = rts.get(p.targetId);
    if (!rt || !rt.plan) return refuse("invalid", "no plan for that target");
    return planner.seriesDetail(rt.plan, String(p.seriesKey), _selection(rt));
  };

  // The Start review (contract.js "review"): planner.planReview plus what
  // only the service knows. `gen` is what apply must send back; `busy` says
  // a writing job holds the target (the review is read-only meanwhile).
  H.review = async (p) => {
    if (!_target(p.targetId)) return refuse("invalid", "unknown target");
    const rt = rts.get(p.targetId);
    if (!rt || !rt.plan || !rt.summary) return refuse("invalid", "plan this target first");
    const sel = _selection(rt);
    return {
      ...planner.planReview(rt.plan, sel),
      gen: rt.gen,
      stale: rt.stale,
      capacity: _capacity(rt, sel),
      policy: _policyOf(rt),
      warnings: rt.summary.warnings,
      busy: !!current && current.targetId === p.targetId && QUIT_ASK_PHASES.has(current.phase),
    };
  };

  H["set-selection"] = async (p) => {
    const rt = rts.get(p.targetId);
    if (!rt || !rt.plan) return refuse("invalid", "no plan for that target");
    // An apply/prune/rename on this target has already taken its op list:
    // a toggle now would show as applied and do nothing (UI-pass decision 9).
    // A plan job may run: its adopt keeps the selection (same epoch).
    if (current && current.targetId === p.targetId && QUIT_ASK_PHASES.has(current.phase)) {
      return refuse("busy", "that target's sync is running", { job: jobs.snapshot().job });
    }
    let changedSeries = [];
    if (_isObj(p.rebind)) {
      if (current) return refuse("busy", "another sync job is running");
      const r = planner.applyRebind(rt.plan, rt.selRebinds, p.rebind);
      if (!r.ok) return r;
      rt.selRebinds = r.rebinds;
      await _persistSelection(rt, p.targetId);
      // Re-plan from the cached input: the folder name is part of every op id.
      const prep = rt.prep;
      const view = { ...prep.view, selection: { ops: rt.selOps || {}, rebinds: rt.selRebinds } };
      const plan = planner.buildPlan({ target: prep.target, settings, pc: prep.pc, device: prep.device, view, opts: { ...prep.planOpts, now: now() } });
      if (plan.ok === false) return plan;
      if (plan.needsProbe.some((n) => !prep.planOpts.nameProbe.has(n))) {
        _replanSoon(p.targetId);
      } else {
        // A new plan (the folder name is in every op id): a new gen.
        rt.plan = plan;
        rt.prep = { ...prep, plan, view };
        rt.gen = ++genSeq;
        rt.summary = _summarize(rt);
      }
    } else {
      const r = planner.changeSelection(rt.plan, rt.selOps, p);
      if (!r.ok) return r;
      rt.selOps = r.ops;
      await _persistSelection(rt, p.targetId).catch((e) => _log("selection write", e && e.message));
      rt.summary = _summarize(rt);
      changedSeries = r.changedSeries;
    }
    _planChanged(p.targetId);
    const ev = planner.evaluateSelection(rt.plan, _selection(rt));
    return {
      ok: true,
      gen: rt.gen,
      seq: p.seq == null ? null : p.seq,
      totals: ev.totals,
      losses: ev.losses,
      lossIfSelected: ev.lossIfSelected,
      massDelete: ev.massDelete,
      massRepush: ev.massRepush,
      changedSeries,
      stale: rt.stale,
    };
  };

  H.verify = async (p) => {
    const pre = _jobPre(p);
    if (pre.refusal) return pre.refusal;
    if (p.mode != null && !VERIFY_MODES.includes(p.mode)) return refuse("invalid", "unknown verify mode");
    const rt = _rt(pre.t.id);
    const caps = rt.prep && rt.prep.probe && rt.prep.probe.caps;
    // No mode named: the target's stored needs-mode answer.
    const mode = p.mode != null ? p.mode : _cfg(pre.t).verifyMode || undefined;
    if (pre.t.kind === "adb" && caps && !caps.sha256sum && (!mode || mode === "device-hash")) {
      return refuse("needs-mode", "this device can't hash files: choose how to verify", { modes: ["read-back", "adopt-size"] });
    }
    const folders = Array.isArray(p.folders) ? p.folders.map(String) : null;
    return _runJob({ phase: "verify", targetId: pre.t.id, serial: pre.t.serial }, async (runId, signal, transport, cfg) => {
      let prep = await _prepare(rt, cfg, transport, signal, runId, { verifyMode: mode === "device-hash" ? undefined : mode });
      if (!prep.ok) return _refused(rt, prep);
      const v = await _verifyFolders(rt, prep, transport, signal, runId, mode, folders);
      if (v.status === "failed" && v.reason === "needs-mode") return _refused(rt, refuse("needs-mode", "this device can't hash files: choose how to verify", { modes: ["read-back", "adopt-size"] }));
      if (v.status !== "completed") return { status: v.status, summary: _runSummary(v) };
      prep = await _prepare(rt, cfg, transport, signal, runId, { verifyMode: mode === "device-hash" ? undefined : mode });
      if (!prep.ok) return _refused(rt, prep);
      return { status: "completed", summary: { ..._runSummary(v), plan: _adopt(rt, prep) } };
    });
  };

  function _ackArgs(p) {
    return { ackLosses: Array.isArray(p.ackLosses) ? p.ackLosses.map(String) : [], ackMassDelete: p.ackMassDelete === true, ackMassRepush: p.ackMassRepush === true };
  }

  H.apply = async (p) => {
    const pre = _jobPre(p);
    if (pre.refusal) return pre.refusal;
    const rt = rts.get(pre.t.id);
    if (!rt || !rt.plan) return refuse("invalid", "plan this target first");
    if (!Number.isInteger(p.gen)) return refuse("invalid", "gen required: the plan generation the review showed");
    if (!(await _libraryPresent())) return refuse("library-missing", "the library folder can't be read");
    // After the await: a rebind may have swapped the plan meanwhile.
    const changed = _genMismatch(rt, p.gen);
    if (changed) return changed;
    const acks = _ackArgs(p);
    // Against the reviewed plan first: what the user can fix without a re-plan.
    const pre2 = planner.reconcileForApply({ reviewed: rt.plan, fresh: rt.plan, storedOps: rt.selOps, ...acks });
    if (!pre2.ok) return refuse("blocked", "the selection needs acknowledgments first", { blocking: pre2.blocking, dropped: pre2.dropped });
    return _startApply(pre.t.id, acks, rt.plan);
  };

  /** The `plan-changed` refusal when `gen` isn't the target's current plan, else null. */
  function _genMismatch(rt, gen) {
    if (rt.plan && rt.summary && rt.gen === gen) return null;
    return refuse("blocked", "the plan changed since you reviewed it", { blocking: [{ kind: "plan-changed", gen: rt.summary ? rt.gen : null, reviewedGen: gen }] });
  }

  /**
   * `reviewed` is the plan whose gen the caller just matched, captured
   * synchronously before the job starts: apply runs only its selected ops
   * that the fresh re-plan still holds unchanged (reconcileForApply).
   */
  function _startApply(targetId, acks, reviewed) {
    const t = _target(targetId);
    return _runJob({ phase: "apply", targetId, serial: t.serial }, async (runId, signal, transport, cfg) => {
      const rt = _rt(targetId);
      const fresh = await _prepare(rt, cfg, transport, signal, runId, {});
      if (!fresh.ok) return _refused(rt, fresh);
      const rc = planner.reconcileForApply({ reviewed, fresh: fresh.plan, storedOps: rt.selOps, ...acks });
      if (!rc.ok) {
        _adopt(rt, fresh);
        return { status: "failed", summary: { refusal: refuse("blocked", "the device or library changed since the review", { blocking: rc.blocking, dropped: rc.dropped }) } };
      }
      const r = await _executor(rt, fresh, transport, signal, runId).apply({ plan: fresh.plan, ops: rc.ops, device: fresh.device, pc: fresh.pc, ackLosses: acks.ackLosses, runId: String(runId) });
      await _clearEvictionMarks(targetId, fresh.plan, r.evictions).catch((e) => _log("eviction mark", e && e.message));
      _replanSoon(targetId);
      if (r.ok === false) return { status: "failed", summary: { refusal: r, dropped: rc.dropped } };
      return { status: r.status, summary: { ..._runSummary(r), dropped: rc.dropped } };
    });
  }

  /**
   * A removal whose folder is gone has done its job: its exclude entry stays
   * (the series stays off the target) but loses removeFiles, so a folder of
   * that name appearing later isn't offered for deletion on the old click.
   */
  async function _clearEvictionMarks(targetId, plan, evictions) {
    const done = (evictions || []).filter((x) => x.removed);
    const t = _target(targetId);
    if (!done.length || !t) return;
    const refs = done.map((x) => plan.bySeriesKey.get(x.seriesKey)).filter(Boolean).map((sp) => ({ identityKey: sp.identityKey, url: sp.urlKey, pcFolder: sp.folder }));
    let changed = false;
    const excludes = (t.excludes || []).map((e) => {
      if (!e.removeFiles || !refs.some((r) => _sameSeries(e, r))) return e;
      changed = true;
      const { removeFiles: _drop, ...rest } = e;
      return rest;
    });
    if (!changed) return;
    await _saveConfig({ ...config, targets: _targets().map((x) => (x.id === t.id ? { ...t, excludes } : x)) });
    emit("config", { config: _publicConfig() });
  }

  H.prune = async (p) => {
    const pre = _jobPre(p);
    if (pre.refusal) return pre.refusal;
    // Always an explicit list (UI-pass decision 3): "no list = every orphan"
    // turned one click on an empty selection into removing them all.
    if (!Array.isArray(p.folders) || !p.folders.length) return refuse("invalid", "name the device folders to remove");
    const want = new Set(p.folders.map(String));
    return _runJob({ phase: "prune", targetId: pre.t.id, serial: pre.t.serial }, async (runId, signal, transport, cfg) => {
      const rt = _rt(pre.t.id);
      const prep = await _prepare(rt, cfg, transport, signal, runId, {});
      if (!prep.ok) return _refused(rt, prep);
      const folders = prep.plan.deviceOnly.filter((d) => d.state === "orphaned" && d.shardId && want.has(d.name)).map((d) => ({ name: d.name, shardId: d.shardId }));
      // A named folder that isn't orphaned on the fresh listing is reported,
      // never silently dropped.
      const taken = new Set(folders.map((f) => f.name));
      const notOrphaned = [...want].filter((n) => !taken.has(n));
      const r = await _executor(rt, prep, transport, signal, runId).prune({ folders, runId: String(runId) });
      _replanSoon(pre.t.id);
      return { status: r.status, summary: { ..._runSummary(r), notOrphaned } };
    });
  };

  H["rename-device-folder"] = async (p) => {
    const pre = _jobPre(p);
    if (pre.refusal) return pre.refusal;
    if (typeof p.to !== "string" || segmentProblem(p.to)) return refuse("invalid", "invalid device folder name");
    if (typeof p.seriesKey !== "string") return refuse("invalid", "seriesKey required");
    return _runJob({ phase: "rename", targetId: pre.t.id, serial: pre.t.serial }, async (runId, signal, transport, cfg) => {
      const rt = _rt(pre.t.id);
      const prep = await _prepare(rt, cfg, transport, signal, runId, {});
      if (!prep.ok) return _refused(rt, prep);
      const sp = prep.plan.bySeriesKey.get(p.seriesKey);
      if (!sp || !sp.shardId || sp.state === "gone" || sp.state === "held") throw new RunStop("failed", "not-a-bound-folder");
      if (sp.deviceFolder === p.to) return { status: "completed", summary: { reason: "same-name" } };
      const r = await _executor(rt, prep, transport, signal, runId).renameFolder({ shardId: sp.shardId, to: p.to, runId: String(runId) });
      _replanSoon(pre.t.id);
      return { status: r.status, summary: _runSummary(r) };
    });
  };

  H.link = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    if (current) return refuse("busy", "another sync job is running", { job: jobs.snapshot().job });
    const rt = rts.get(t.id);
    if (!rt || !rt.plan) return refuse("invalid", "plan this target first");
    const ids = Array.isArray(p.suggestionIds) ? p.suggestionIds.map(String) : [];
    if (!ids.length) return refuse("invalid", "suggestionIds required");
    const picks = [];
    const folders = new Set();
    const series = new Set();
    for (const id of ids) {
      const g = rt.plan.suggestions.find((x) => x.id === id);
      if (!g) return refuse("invalid", `unknown suggestion ${id}`);
      const sp = rt.plan.bySeriesKey.get(g.seriesKey);
      if (!sp || (sp.state !== "new" && sp.state !== "gone")) return refuse("invalid", `${g.seriesKey} is already bound`);
      if (folders.has(g.deviceFolder) || series.has(g.seriesKey)) return refuse("invalid", "one device folder and one series per link");
      folders.add(g.deviceFolder);
      series.add(g.seriesKey);
      picks.push({ g, sp });
    }
    const ex = new Executor({ transport: { kind: t.kind }, store: rt.store, target: rt.prep.target, settings, probe: rt.prep.probe, view: rt.prep.view, now });
    await ex.ensureHeader();
    const linked = [];
    for (const { g, sp } of picks) {
      // A gone series' shard is rebound in place (store.bindFolder), so a
      // series never holds two shards on one target.
      const shardId = await rt.store.bindFolder({ name: g.deviceFolder, binding: sp.binding, shardId: sp.state === "gone" ? sp.shardId : newShardId() });
      linked.push({ suggestionId: g.id, seriesKey: g.seriesKey, deviceFolder: g.deviceFolder, shardId });
    }
    _replanSoon(t.id);
    return { ok: true, linked };
  };

  // Review opens the Sync tab on the prompt's targets (renderer side);
  // Not now only closes the prompt. Neither starts a job (design D2).
  H["prompt-response"] = async (p) => {
    if (!["review", "not-now"].includes(p.action)) return refuse("invalid", "unknown action");
    const id = String(p.promptId);
    const pr = prompts.respond(id);
    if (!pr) return refuse("invalid", "that prompt is no longer open");
    emit("prompt", { action: "answered", prompt: pr, response: p.action, prompts: prompts.shown() });
    return { ok: true };
  };

  H["library-status"] = async () => {
    if (!libStatus) libStatus = await _computeLibraryStatus();
    return { ok: true, ...libStatus };
  };

  H["export-report"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    const rt = rts.get(t.id);
    if (!rt || !rt.plan) return refuse("invalid", "plan this target first");
    const sel = _selection(rt);
    const stamp = new Date(now()).toISOString().slice(0, 10);
    const r = await deps.showSaveDialog({
      title: "Export sync report",
      defaultPath: `sync-report-${(t.name || t.id).replace(/[^A-Za-z0-9 _-]/g, "_")}-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!r || r.canceled || !r.filePath) return { ok: false, code: "invalid", message: "cancelled", cancelled: true };
    const report = {
      generatedAt: new Date(now()).toISOString(),
      target: { ...t },
      summary: planner.planSummary(rt.plan, sel),
      series: rt.plan.series.map((sp) => planner.seriesDetail(rt.plan, sp.seriesKey, sel)),
      deviceOnly: rt.plan.deviceOnly.map((d) => ({ ...d, rows: rt.plan.deviceOnlyRows.get(d.key) || [] })),
      anomalies: rt.plan.anomalies,
      suggestions: rt.plan.suggestions,
      warnings: (rt.prep && rt.prep.warnings) || [],
    };
    await fs.promises.writeFile(r.filePath, JSON.stringify(report, null, 2));
    return { ok: true, path: r.filePath };
  };

  H["device-cover"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    const folder = String(p.folder || "");
    if (segmentProblem(folder)) return refuse("invalid", "invalid folder name");
    const rt = rts.get(t.id);
    const known = rt && rt.plan && (rt.plan.deviceOnly.some((d) => d.name === folder) || rt.plan.series.some((sp) => sp.deviceFolder === folder));
    if (!known) return refuse("invalid", "unknown device folder");
    const file = path.join(rt.store.coversDir, `${crypto.createHash("sha1").update(folder).digest("hex")}.jpg`);
    try {
      if ((await fs.promises.stat(file)).size > 0) return { ok: true, path: file };
    } catch (_) {
      // not cached yet
    }
    if (!_isConnected(t)) return refuse("disconnected", "the device isn't connected");
    const tp = _transportFor(_cfg(t));
    try {
      await tp.probe();
      const buf = await tp.readSmall(`${folder}/cover.jpg`, COVER_MAX_BYTES);
      if (!buf || !buf.length) return { ok: true, path: null };
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
      return { ok: true, path: file };
    } finally {
      await tp.close().catch(() => {});
      tp.destroy();
    }
  };

  H["find-sources:start"] = async (p) => {
    const t = _target(p.targetId);
    if (!t) return refuse("invalid", "unknown target");
    const rt = rts.get(t.id);
    if (!rt || !rt.plan) return refuse("invalid", "plan this target first");
    const only = Array.isArray(p.folders) ? new Set(p.folders.map(String)) : null;
    const folders = rt.plan.deviceOnly.filter((d) => !only || only.has(d.name)).map((d) => d.name);
    const r = await findSources.start({ targetId: t.id, folders, seededOnly: p.seededOnly });
    if (!r.ok) return refuse(r.code === "busy" ? "busy" : "invalid", r.message);
    return { ok: true, started: r.started };
  };

  H["find-sources:get"] = async (p) => {
    if (!_target(p.targetId)) return refuse("invalid", "unknown target");
    return findSources.get(p.targetId);
  };

  H["find-sources:update-row"] = async (p) => {
    if (!_target(p.targetId)) return refuse("invalid", "unknown target");
    const r = await findSources.updateRow({ targetId: p.targetId, folder: String(p.folder || ""), patch: p.patch });
    if (!r.ok) return refuse(r.code === "busy" ? "busy" : "invalid", r.message);
    return r;
  };

  // ---------------------------------------------------------- dispatch

  async function dispatch(name, payload) {
    const ch = CHANNELS[name];
    try {
      if (payload != null && !_isObj(payload)) return refuse("invalid", "the request must be an object");
      const p = payload || {};
      if (shut) return refuse("disabled", "the app is quitting");
      if (!enabled && !CHANNELS_WHILE_DISABLED.has(ch)) return refuse("disabled", "device sync is off");
      if (enabled && name !== "label-preview" && !(await _ensureStarted())) {
        if (!CHANNELS_WHILE_DISABLED.has(ch)) return refuse("disabled", "device sync could not start");
      }
      const h = H[name];
      if (!h) return refuse("invalid", `no handler for ${name}`);
      return await h(p);
    } catch (e) {
      _log(`handler ${name}`, e && e.stack);
      return refuse("invalid", `internal error: ${(e && e.message) || e}`, { internal: true });
    }
  }

  for (const name of CHANNEL_NAMES) {
    deps.ipcMain.handle(CHANNELS[name], (_event, payload) => dispatch(name, payload));
  }

  deps.onFocus(() => {
    try {
      if (started && prompts) prompts.focus();
    } catch (e) {
      _log("focus", e && e.message);
    }
  });

  if (enabled) _ensureStarted();

  // ---------------------------------------------------------- facade

  const facade = {
    /** save-settings hook: start or stop with syncEnabled; the job is cancelled first. */
    applySettings(merged) {
      try {
        rawSettings = merged || {};
        const next = resolveSyncSettings(rawSettings);
        const was = enabled;
        const prev = settings;
        settings = next;
        enabled = next.syncEnabled;
        // The renderer learns `enabled` from here, not from re-reading
        // get-state after its save (UI-pass push model).
        emit("settings", { enabled, settings: _publicSettings() });
        if (was && enabled && started) {
          const same = (k) => JSON.stringify(prev[k]) === JSON.stringify(next[k]);
          if (!PLANNING_SETTINGS.every(same)) {
            for (const t of _targets()) if (rts.get(t.id) && rts.get(t.id).plan) _replanSoon(t.id);
          }
        }
        if (was && !enabled) {
          stopP = _stop().catch((e) => _log("stop", e && e.stack)).finally(() => {
            stopP = null;
          });
          return stopP;
        }
        if (!was && enabled) {
          return _ensureStarted().then(() => {
            if (started) _schedulePrewarm(0);
          });
        }
        if (started && hashPool) hashPool.setConcurrency(_workers());
      } catch (e) {
        _log("applySettings", e && e.stack);
      }
      return Promise.resolve();
    },

    /** A download finished, a scan / merge / delete / metadata edit changed the library. */
    notifyLibraryChanged(reason) {
      try {
        if (!started) return;
        libStatus = null;
        clearTimeout(replanTimer);
        replanTimer = setTimeout(() => {
          replanTimer = null;
          for (const t of _targets()) if (_isConnected(t) && rts.get(t.id) && rts.get(t.id).plan) _replanSoon(t.id);
          _refreshLibraryStatus();
          _schedulePrewarm(0);
        }, T.replanDebounceMs != null ? T.replanDebounceMs : REPLAN_DEBOUNCE_MS);
        if (replanTimer.unref) replanTimer.unref();
      } catch (e) {
        _log("notifyLibraryChanged", reason, e && e.message);
      }
    },

    /** True while an apply, prune or rename runs (the close listener asks). */
    needsQuitAsk() {
      return _safe(() => jobs.needsQuitAsk(), false);
    },

    /** confirm-quit's payload.sync, or null. */
    quitInfo() {
      return _safe(() => {
        const j = jobs.snapshot().job;
        if (!j || j.state !== "running") return null;
        const t = _target(j.targetId);
        // done/total count files for an apply, folders for a prune or rename
        // (executor.js prune/renameFolder progress).
        return { target: t ? t.name || t.id : j.targetId, phase: j.phase, unit: j.phase === "apply" ? "files" : "folders", done: j.progress.filesDone, total: j.progress.filesTotal };
      }, null);
    },

    isJobRunning() {
      return !!current;
    },

    /** reinstall-python: stop the search tree before python-env is deleted. */
    cancelFindSources() {
      try {
        return findSources ? findSources.cancelAndWait().then((r) => r, () => ({ wasRunning: false })) : Promise.resolve({ wasRunning: false });
      } catch (_) {
        return Promise.resolve({ wasRunning: false });
      }
    },

    /** Quit: cancel and wait (≤ timeoutMs), flush. Never rejects. */
    shutdown({ timeoutMs = SHUTDOWN_MS } = {}) {
      try {
        if (shut) return Promise.resolve();
        const p = _within(_stop({ timeoutMs, reason: "shutdown" }), timeoutMs + 500).catch((e) => _log("shutdown", e && e.stack));
        return p.then(() => {
          shut = true;
        });
      } catch (e) {
        _log("shutdown", e && e.stack);
        return Promise.resolve();
      }
    },

    /**
     * app.on("quit") / app.exit(): synchronous and idempotent. Aborts the
     * job, kills the search's tree synchronously (proc-kill.js
     * killTreeNow; ≤2 s on win32), abandons queued record
     * writes (each file on disk is whole: atomic renames) and flushes the PC
     * hash cache synchronously.
     */
    shutdownNow() {
      if (shut && !started) return;
      shut = true;
      // Reached with the service still up only when shutdown() didn't run
      // first: app.exit() (reinstall-python) or a quit that skipped
      // window-all-closed. hadJob: the job this kill aborts. hadFind: a
      // find-sources run is still registered (reinstall-python's awaited
      // cancel can leave it registered while its last save settles);
      // searchProc: its search process is still attached, i.e. this kill
      // is the one that has to end the tree.
      if (started) {
        const s = findSources && findSources.searcher;
        slog.event("quit-now", { hadJob: current ? current.phase : null, hadFind: !!(findSources && _safe(() => findSources.isRunning(), false)), searchProc: !!(s && _safe(() => s.isRunning(), false)) });
      }
      try {
        if (current) current.ac.abort();
        if (current && current.transport) current.transport.destroy();
      } catch (_) {}
      try {
        if (findSources) findSources.cancelNow();
      } catch (_) {}
      try {
        if (tracker) tracker.stop();
        if (watcher) watcher.stop();
      } catch (_) {}
      try {
        clearInterval(busyTimer);
        clearTimeout(prewarmTimer);
        clearTimeout(replanTimer);
        if (prewarmAc) prewarmAc.abort();
      } catch (_) {}
      try {
        if (queue) queue.abandon();
      } catch (_) {}
      try {
        if (hashPool) {
          hashPool.flushSync();
          hashPool.close();
        }
      } catch (e) {
        _log("shutdownNow flush", e && e.message);
      }
      started = false;
      slogOpen = false;
    },

    // For tools/ tests: the state get-state reports, without IPC.
    _debug() {
      return { started, enabled, current: current ? { runId: current.runId, phase: current.phase, targetId: current.targetId, signal: current.ac.signal } : null, rts, prompts, tracker, findSources, hashPool };
    },
  };
  return facade;
}

module.exports = { initDeviceSync, validateDeps, DEPS, PREWARM_DELAY_MS, REPLAN_DEBOUNCE_MS, SHUTDOWN_MS, CONFIG_FILE };
