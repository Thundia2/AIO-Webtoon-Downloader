// ============================================================
// DEVICE SYNC — FIND SOURCES (main process, runner only)
//
// Owns batch find-sources for a target's device-only folders (parent
// "Batch find-sources"): one search per included row, sequential, on its OWN
// Searcher (the Search tab's searcher is never shared), keeping the top
// TOP_CANDIDATES candidates per row. Rows persist per target in
// userData/sync/targets/<id>/find-sources.json, written after every row, so
// a run is resumable: start() runs every included row that isn't `done`.
// Editing a row's query (update-row) sends it back to `queued`, which is the
// "retry with an edited query" path for rows that errored or found nothing.
//
// NOT HERE (P4 decision, UI pass): "Queue N downloads". The renderer queues
// each accepted row through the existing download IPC and adds the alias
// URL → device folder with sync:config-op add-alias.
//
// WAITS while Library Check All or a Search-tab search runs (isBlocked):
// Check All holds the shared mangafire/comix browser profile, and two
// searches at once double the site load.
//
// SEARCH OPTIONS mirror the Search tab's (useDownloader.runSearch): the
// saved searchOpts, collapseSplits === true, disabledSites, then the
// Resource Limits network cap on searchParallelism (main.js search:run).
//
// LIFECYCLE: cancel() / cancelAndWait() tree-kill the search (proc-kill.js
// through Searcher); cancelNow() is the synchronous kill for shutdownNow().
//
// Row: {folder, query, include, state, candidates[≤5], pick, pinnedUrl,
//       skip, error, searchedAt}
//   state: queued | searching | done | error | cancelled
//   candidate: {title, year, best:{site, url, title, cover, composite,
//               chapters, qualityBasis}, sources:[same, ≤5]}
//
// Read by: service.js. Depends on: ../searcher.js (Searcher, injectable),
// ../resource-limits.js, store.js (WriteQueue, readJson), naming.js
// (deriveSearchQuery).
// ============================================================

const path = require("path");
const { WriteQueue, readJson } = require("./store");
const { deriveSearchQuery } = require("./naming");

const TOP_CANDIDATES = 5;
const BLOCKED_POLL_MS = 2000;
const FILE = "find-sources.json";
const ROW_PATCH_KEYS = Object.freeze(["query", "pick", "pinnedUrl", "skip", "include"]);

function _searchOptions(settings, seededOnly) {
  const s = settings || {};
  let parallelism;
  try {
    const { searchParallelismForLevel } = require("../resource-limits");
    parallelism = searchParallelismForLevel(s.searchOpts ? s.searchOpts.searchParallelism : undefined, s.networkLimit);
  } catch (_) {
    parallelism = s.searchOpts ? s.searchOpts.searchParallelism : undefined;
  }
  return {
    ...(s.searchOpts || {}),
    collapseSplits: s.collapseSplits === true,
    ...(Array.isArray(s.disabledSites) && s.disabledSites.length ? { disabledSites: s.disabledSites } : {}),
    ...(seededOnly != null ? { seededOnly: !!seededOnly } : {}),
    searchParallelism: parallelism,
  };
}

function _num(v) {
  return Number.isFinite(v) ? v : null;
}

function _source(s) {
  return {
    site: s.site || null,
    url: s.url || null,
    title: s.title || null,
    cover: s.cover || null,
    composite: _num(s.composite_score),
    chapters: _num(s.actual_chapter_count) != null ? s.actual_chapter_count : _num(s.chapter_count_hint),
    qualityBasis: s.quality_basis || null,
  };
}

/** --search-json payload → at most TOP_CANDIDATES compact candidates. */
function compactCandidates(json) {
  const list = json && Array.isArray(json.candidates) ? json.candidates : [];
  return list.slice(0, TOP_CANDIDATES).map((c) => {
    const sources = (Array.isArray(c.sources) ? c.sources : []).slice(0, TOP_CANDIDATES).map(_source);
    return { title: c.canonical_title || (sources[0] && sources[0].title) || null, year: _num(c.canonical_year), best: sources[0] || null, sources };
  });
}

class FindSources {
  /**
   * @param {object} d
   * @param {string} d.targetsDir        userData/sync/targets
   * @param {() => object} d.getSettings
   * @param {() => {pythonCmd, scriptPath, workingDir}} d.spawnPaths
   * @param {() => (string|null)} d.isBlocked  why a search must wait, or null
   * @param {(ev:object) => void} d.emit       `find` events (service adds kind)
   * @param {() => object} d.makeSearcher      a Searcher-like {runSearch, cancel, cancelAndWait, cancelNow}
   * @param {WriteQueue} [d.queue]
   * @param {object} [d.timers]
   * @param {() => number} [d.now]
   */
  constructor(d) {
    this.targetsDir = d.targetsDir;
    this.getSettings = d.getSettings;
    this.spawnPaths = d.spawnPaths;
    this.isBlocked = d.isBlocked || (() => null);
    this.emit = d.emit || (() => {});
    this.makeSearcher = d.makeSearcher;
    this.queue = d.queue || new WriteQueue();
    this.timers = d.timers || { setTimeout, clearTimeout };
    this.now = d.now || Date.now;
    this.rows = new Map(); // targetId → Map(folder → row)
    this.run = null; // {targetId, cancelled, done, total, waiting}
    this.searcher = null;
  }

  _file(targetId) {
    return path.join(this.targetsDir, targetId, FILE);
  }

  async _load(targetId) {
    if (this.rows.has(targetId)) return this.rows.get(targetId);
    const r = await readJson(this._file(targetId));
    const m = new Map();
    const list = r.state === "ok" && r.value && Array.isArray(r.value.rows) ? r.value.rows : [];
    for (const row of list) {
      if (!row || typeof row.folder !== "string") continue;
      // A run killed mid-search left the row `searching`: it never finished.
      m.set(row.folder, { ...row, state: row.state === "searching" ? "queued" : row.state });
    }
    this.rows.set(targetId, m);
    return m;
  }

  _save(targetId) {
    const m = this.rows.get(targetId);
    return this.queue.write(this._file(targetId), { version: 1, rows: [...(m ? m.values() : [])] });
  }

  _newRow(folder, query) {
    return { folder, query: query || deriveSearchQuery(folder), include: true, state: "queued", candidates: [], pick: null, pinnedUrl: null, skip: false, error: null, searchedAt: null };
  }

  isRunning() {
    return !!this.run;
  }

  /** {running, targetId, waiting, done, total, rows} for one target (rows in folder order). */
  async get(targetId) {
    const m = await this._load(targetId);
    const r = this.run && this.run.targetId === targetId ? this.run : null;
    return {
      ok: true,
      running: !!r,
      targetId,
      waiting: r ? r.waiting : null,
      done: r ? r.done : 0,
      total: r ? r.total : 0,
      rows: [...m.values()],
    };
  }

  /** Snapshot for get-state: the running batch, or null. */
  status() {
    const r = this.run;
    return r ? { targetId: r.targetId, waiting: r.waiting, done: r.done, total: r.total } : null;
  }

  /**
   * Make the target's rows match its device-only folders (new folders get a
   * row; rows of folders no longer device-only are dropped) and run every
   * included row that isn't done. Resolves when the run ends; the service
   * doesn't await it (find events carry the progress).
   * @param {{targetId:string, folders:string[], seededOnly?:boolean}} a
   * @returns {Promise<{ok:true, started:boolean}|{ok:false, code:string, message:string}>}
   */
  async start({ targetId, folders, seededOnly }) {
    if (this.run) return { ok: false, code: "busy", message: "a find-sources run is already going" };
    const m = await this._load(targetId);
    const want = new Set(folders || []);
    for (const f of want) if (!m.has(f)) m.set(f, this._newRow(f));
    for (const f of [...m.keys()]) if (!want.has(f)) m.delete(f);
    await this._save(targetId).catch(() => {});
    const todo = [...m.values()].filter((r) => r.include && !r.skip && r.state !== "done");
    if (!todo.length) {
      this.emit({ targetId, state: "done", done: 0, total: 0 });
      return { ok: true, started: false };
    }
    const run = { targetId, cancelled: false, done: 0, total: todo.length, waiting: null };
    this.run = run;
    this.searcher = this.makeSearcher();
    this.emit({ targetId, state: "running", done: 0, total: run.total });
    this._loop(run, todo, seededOnly).catch(() => {});
    return { ok: true, started: true };
  }

  async _loop(run, todo, seededOnly) {
    try {
      for (const row of todo) {
        if (run.cancelled) break;
        await this._waitUnblocked(run);
        if (run.cancelled) break;
        row.state = "searching";
        row.error = null;
        this.emit({ targetId: run.targetId, state: "running", done: run.done, total: run.total, row: { ...row } });
        try {
          const settings = this.getSettings() || {};
          const json = await this.searcher.runSearch({ ...this.spawnPaths(settings), query: row.query, opts: _searchOptions(settings, seededOnly) });
          row.candidates = compactCandidates(json);
          row.state = "done";
          if (row.pick == null || row.pick >= row.candidates.length) row.pick = row.candidates.length ? 0 : null;
        } catch (e) {
          if (e && e.cancelled) {
            row.state = "queued";
            run.cancelled = true;
          } else {
            row.state = "error";
            row.error = String((e && e.message) || e).slice(0, 500);
          }
        }
        row.searchedAt = row.state === "queued" ? row.searchedAt : this.now();
        if (row.state !== "queued") run.done += 1;
        await this._save(run.targetId).catch(() => {});
        this.emit({ targetId: run.targetId, state: "running", done: run.done, total: run.total, row: { ...row } });
      }
    } finally {
      this.run = null;
      this.searcher = null;
      this.emit({ targetId: run.targetId, state: run.cancelled ? "cancelled" : "done", done: run.done, total: run.total });
    }
  }

  async _waitUnblocked(run) {
    for (;;) {
      let why = null;
      try {
        why = this.isBlocked();
      } catch (_) {
        why = null;
      }
      if (!why || run.cancelled) {
        if (run.waiting) {
          run.waiting = null;
          this.emit({ targetId: run.targetId, state: "running", done: run.done, total: run.total, waiting: null });
        }
        return;
      }
      if (run.waiting !== why) {
        run.waiting = why;
        this.emit({ targetId: run.targetId, state: "waiting", done: run.done, total: run.total, waiting: why });
      }
      await new Promise((r) => {
        run.wake = r;
        this.timers.setTimeout(r, BLOCKED_POLL_MS);
      });
    }
  }

  /** Patch a row's editable fields. A changed query re-queues the row. */
  async updateRow({ targetId, folder, patch }) {
    const m = await this._load(targetId);
    const row = m.get(folder);
    if (!row) return { ok: false, code: "invalid", message: "unknown row" };
    if (this.run && this.run.targetId === targetId && row.state === "searching") {
      return { ok: false, code: "busy", message: "that row is being searched" };
    }
    const p = patch || {};
    for (const k of Object.keys(p)) if (!ROW_PATCH_KEYS.includes(k)) return { ok: false, code: "invalid", message: `can't edit ${k}` };
    if ("query" in p) {
      const q = String(p.query == null ? "" : p.query).trim();
      if (!q) return { ok: false, code: "invalid", message: "empty query" };
      if (q !== row.query) {
        row.query = q;
        row.state = "queued";
        row.candidates = [];
        row.pick = null;
        row.error = null;
      }
    }
    if ("pick" in p) {
      if (p.pick != null && !(Number.isInteger(p.pick) && p.pick >= 0 && p.pick < row.candidates.length)) {
        return { ok: false, code: "invalid", message: "pick out of range" };
      }
      row.pick = p.pick;
    }
    if ("pinnedUrl" in p) {
      if (p.pinnedUrl != null && !/^https?:\/\/\S+$/i.test(String(p.pinnedUrl))) return { ok: false, code: "invalid", message: "not an http(s) URL" };
      row.pinnedUrl = p.pinnedUrl == null ? null : String(p.pinnedUrl);
    }
    if ("skip" in p) row.skip = !!p.skip;
    if ("include" in p) row.include = !!p.include;
    await this._save(targetId);
    this.emit({ targetId, state: this.run && this.run.targetId === targetId ? "running" : "idle", row: { ...row } });
    return { ok: true, row: { ...row } };
  }

  /** Stop the batch. Returns {wasRunning}; the search is tree-killed. */
  cancel() {
    const run = this.run;
    if (!run) return { wasRunning: false };
    run.cancelled = true;
    if (run.wake) run.wake();
    if (this.searcher) this.searcher.cancel();
    return { wasRunning: true };
  }

  /** cancel(), then wait for the search process tree to close (≤ ~6 s). */
  async cancelAndWait() {
    const run = this.run;
    if (!run) return { wasRunning: false };
    run.cancelled = true;
    if (run.wake) run.wake();
    if (this.searcher && this.searcher.cancelAndWait) await this.searcher.cancelAndWait();
    return { wasRunning: true };
  }

  /** Synchronous kill for shutdownNow(). */
  cancelNow() {
    const run = this.run;
    if (!run) return false;
    run.cancelled = true;
    try {
      return this.searcher && this.searcher.cancelNow ? this.searcher.cancelNow() : false;
    } catch (_) {
      return false;
    }
  }

  /** Drop a target's rows (forget-record / remove-target). */
  async forget(targetId) {
    this.rows.delete(targetId);
  }
}

module.exports = { FindSources, compactCandidates, TOP_CANDIDATES, BLOCKED_POLL_MS, FIND_SOURCES_FILE: FILE };
