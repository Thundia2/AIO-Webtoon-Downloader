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

// Rewrite the temp prefix (both slash flavours) in every string, object
// KEYS included: library-status is keyed by folder path.
function scrub(v, tmp) {
  const variants = [tmp, tmp.replace(/\\/g, "/")];
  const str = (x) => {
    let s = x;
    for (const t of variants) s = s.split(t).join(FAKE_ROOT);
    return s;
  };
  const walk = (x) => {
    if (typeof x === "string") return str(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [str(k), walk(y)]));
    return x;
  };
  return walk(v);
}


// ---------------------------------------------------------------- Sync tab
//
// recordTab (UI-pass U2-15): one FOLDER target driven through the states the
// Sync tab renders, every answer recorded off the real service:
//   * a first apply, then edits that give the second plan: new chapters
//     (push), a changed chapter (update), a foreign same-label file on the
//     target (replace candidate), a PC chapter deleted (removal + loss), a
//     series whose folder vanished from the target (gone, rebind choice), an
//     excluded series, a series marked "remove from target", a new series
//     with a name-match suggestion, a young file (settling), a series gone
//     from the PC (orphaned) and a folder the app never wrote (preserved);
//   * that plan's series-detail for every row and device-only folder, the
//     review, real set-selection replies with the `plans` push after each;
//   * an apply's job events with their timing (each landed file is slowed so
//     the progress isn't coalesced away) and the lastRun it leaves;
//   * refusals: plan-changed, busy, record-mismatch, device-listing-suspect,
//     library-missing, disconnected; needs-mode comes from a fake-adb
//     device without sha256sum;
//   * U4: library-status for that plan, and a find-sources run over its
//     device-only folders (rows, one mid-run `find` event) plus the config
//     after one folder is linked. The SEARCH RESULTS ARE SYNTHETIC (a real
//     search hits the network): FAKE_SEARCH answers by query in the
//     --search-json shape, and the real find-sources.js compacts them.
// Snapshots are whole get-state answers, so the gallery feeds them as is.
// recordLink adds the `linking` / `verifying` snapshots (its doc comment).

function writeYoung(p, data, ageS) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  const t = new Date(Date.now() - ageS * 1000);
  fs.utimesSync(p, t, t);
}

// --search-json payloads for the find-sources recording, by query. Berserk
// fails (an error row), Kagurabachi finds nothing. Chainsaw Man's first match
// has SIX sites (the runner used to cut sites past the 5th; the sheet shows
// and falls back over all of them) and a weak one-site second match, far
// enough behind to read Ready. The princess folder's two matches are close
// on title, so it reads "Check match" (findView.matchReady).
const FAKE_SEARCH = {
  "Chainsaw Man": {
    candidates: [
      { canonical_title: "Chainsaw Man", canonical_year: 2018, sources: [
        { site: "mangadex", url: "https://mangadex.org/title/a77742b1/chainsaw-man", title: "Chainsaw Man", composite_score: 0.91, actual_chapter_count: 181, quality_basis: "chapter_probe", title_match: 1 },
        { site: "weebcentral", url: "https://weebcentral.com/series/01J76XY/chainsaw-man", title: "Chainsaw Man", composite_score: 0.84, actual_chapter_count: 181, quality_basis: "chapter_probe", title_match: 1 },
        { site: "mangafire", url: "https://mangafire.to/title/k2d9-chainsaw-man", title: "Chainsaw Man", composite_score: 0.82, actual_chapter_count: 180, quality_basis: "chapter_probe", title_match: 1 },
        { site: "mangakatana", url: "https://mangakatana.com/manga/chainsaw-man.21", title: "Chainsaw Man", composite_score: 0.78, chapter_count_hint: 179, quality_basis: "cover", title_match: 1 },
        { site: "mangapill", url: "https://mangapill.com/manga/2/chainsaw-man", title: "Chainsaw Man", composite_score: 0.74, actual_chapter_count: 181, quality_basis: "chapter_probe", title_match: 1 },
        { site: "mangahub", url: "https://mangahub.io/manga/chainsaw-man", title: "Chainsaw Man", composite_score: 0.7, chapter_count_hint: 181, quality_basis: "seed", title_match: 1 },
      ] },
      { canonical_title: "Chainsaw Man (Colored)", canonical_year: 2021, sources: [
        { site: "mangafire", url: "https://mangafire.to/title/x9c2-chainsaw-man-colored", title: "Chainsaw Man (Colored)", composite_score: 0.62, chapter_count_hint: 97, quality_basis: "seed", title_match: 0.82 },
      ] },
    ],
  },
  Kagurabachi: { candidates: [] },
  "Tis Time for Torture Princess": {
    candidates: [
      { canonical_title: "'Tis Time for \"Torture,\" Princess", canonical_year: 2019, sources: [
        { site: "mangadex", url: "https://mangadex.org/title/5e1b/tis-time-for-torture-princess", title: "'Tis Time for \"Torture,\" Princess", composite_score: 0.88, actual_chapter_count: 212, quality_basis: "chapter_probe", title_match: 0.87 },
        { site: "mangafire", url: "https://mangafire.to/title/p7q1-tis-time-for-torture-princess", title: "'Tis Time for Torture, Princess", composite_score: 0.83, actual_chapter_count: 210, quality_basis: "chapter_probe", title_match: 0.87 },
        { site: "atsumaru", url: "https://atsu.moe/manga/tis-time-for-torture-princess", title: "Tis Time for Torture Princess", composite_score: 0.8, chapter_count_hint: 212, quality_basis: "seed", title_match: 0.86 },
      ] },
      { canonical_title: "Princess Princess", canonical_year: 2002, sources: [
        { site: "mangahub", url: "https://mangahub.io/manga/princess-princess", title: "Princess Princess", composite_score: 0.66, chapter_count_hint: 34, quality_basis: "seed", title_match: 0.8 },
      ] },
    ],
  },
};
// winner_chapter_map for a fake payload, in aio_search_cli.py's shape
// (chapter_merger.align_chapter_lists output). `sites` = {site: {nums,
// official?, total?, compatibility?, skipped?, latest?}}; `nums` are the
// chapters the site reaches chapters[] with (for a low-match site only its
// overlapping ones, as the merger does), `total` its full list length. The
// anchor is the first key (the merger's is the longest list). Breakdown
// counts are only roughly consistent: the gallery shows them, nothing checks
// them against chapters[].
function fakeChapterMap(title, sites) {
  const nums = [...new Set(Object.values(sites).flatMap((x) => x.nums))].sort((a, b) => a - b);
  const names = Object.keys(sites);
  const diag = {};
  names.forEach((site, i) => {
    const x = sites[site];
    const total = x.total != null ? x.total : x.nums.length;
    const side = x.nums.filter((n) => !Number.isInteger(n)).length;
    diag[site] = {
      role: i === 0 ? "anchor" : "alternative",
      total_chapters: total,
      unique_main_chapters: total - side,
      effective_chapters: total,
      matched_with_anchor: x.nums.length,
      compatibility: x.compatibility != null ? x.compatibility : 1,
      breakdown: { consensus_main: total - side - (x.latest || 0), source_only_latest: x.latest || 0, consensus_side_stories: side, safe_decimals: 0, prologue_count: 0, merged_split_fragments: 0, source_only_orphans: 0, fragments_dropped: 0, unparseable_passthrough: 0 },
      consensus_threshold_sources: 2,
      ...(x.skipped ? { skipped_reason: x.skipped } : {}),
    };
  });
  return {
    canonical_title: title,
    merge_diagnostics: diag,
    collapse_splits_applied: true,
    effective_chapters_aligned: nums.length,
    consensus_set: nums.filter((n) => names.filter((s) => sites[s].nums.includes(n)).length >= 2),
    consensus_max: Math.max(...nums),
    chapters: nums.map((n) => ({
      chapter_num: n,
      chapter_label: String(n),
      sources: names.filter((s) => sites[s].nums.includes(n)).map((s) => {
        const off = (sites[s].official || []).includes(n);
        return { site: s, is_official: off, publisher: off ? sites[s].publisher || null : null, group_name: off ? sites[s].publisher || null : null };
      }),
    })),
    total_chapters_aligned: nums.length,
  };
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const without = (list, ...drop) => list.filter((n) => !drop.includes(n));
const LOW_MATCH = "compatibility 38% below 50% threshold; only overlapping chapters merged";

// Chainsaw Man's map (coverage plan C1): weebcentral anchors with a side
// story; mangadex has gaps and three official chapters; mangakatana's
// numbering differs (low match, only its overlap merged); mangapill has
// scattered gaps; mangahub is absent (the search didn't compare it). The
// princess map has an empty-list site (atsumaru). The other states the sheet
// renders (an old row, multi-source off, a "Not this series?" pick) come
// from these rows minus their map, in the gallery.
FAKE_SEARCH["Chainsaw Man"].winner_chapter_map = fakeChapterMap("Chainsaw Man", {
  weebcentral: { nums: [...range(1, 181), 97.5].sort((a, b) => a - b) },
  mangadex: { nums: without(range(1, 181), 97, 98), official: [1, 2, 3], publisher: "MANGA Plus" },
  mangafire: { nums: range(1, 180) },
  mangakatana: { nums: range(1, 68), total: 179, compatibility: 0.38, skipped: LOW_MATCH },
  mangapill: { nums: without(range(1, 181), 37, 60, 61, 81) },
});
FAKE_SEARCH["Tis Time for Torture Princess"].winner_chapter_map = fakeChapterMap("'Tis Time for \"Torture,\" Princess", {
  mangadex: { nums: range(1, 212), latest: 2 },
  mangafire: { nums: range(1, 210) },
  atsumaru: { nums: [], total: 0, compatibility: 0, skipped: "empty chapter list" },
});

// The real --search-json: composite_score IS the title match, and the rating
// the UI shows is img_quality_score (measured) else seed_quality. The data
// above writes the intended rating as composite_score; asJson moves it to
// where the real search puts it, so a UI reading composite would show 1.00s.
function asJson(payload) {
  for (const c of payload.candidates) {
    for (const s of c.sources) {
      const rating = s.composite_score;
      if (s.quality_basis === "seed") Object.assign(s, { img_quality_score: null, seed_quality: rating });
      else Object.assign(s, { img_quality_score: rating, seed_quality: 0.7 });
      s.composite_score = s.title_match;
    }
  }
  return payload;
}
function fakeSearcher() {
  return {
    runSearch: async ({ query }) => {
      await sleep(40);
      if (!(query in FAKE_SEARCH)) throw new Error("search exited with code 1");
      return asJson(JSON.parse(JSON.stringify(FAKE_SEARCH[query])));
    },
    cancel() {},
    cancelAndWait: async () => {},
    cancelNow: () => false,
  };
}

async function recordTab(tmp) {
  const lib = path.join(tmp, "tab-manga");
  const userData = path.join(tmp, "tab-ud", "sync");
  const root = path.join(tmp, "Tablet", "Komikku");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const ch = (title, from, to, size = 3000) => {
    const o = {};
    for (let i = from; i <= to; i += 1) o[`Ch.${String(i).padStart(3, "0")} - ${title}.cbz`] = size + i;
    return o;
  };
  series(lib, "Eleceed", { ...ch("Eleceed", 1, 6), "cover.jpg": 900 });
  series(lib, "Dungeon Meshi", ch("Dungeon Meshi", 1, 4));
  series(lib, "Solo Leveling", ch("Solo Leveling", 1, 12));
  series(lib, "Blue Lock", ch("Blue Lock", 1, 3));
  series(lib, "Berserk", ch("Berserk", 1, 5));
  // 12 chapters: "remove from target" then trips the mass-delete acknowledgement.
  series(lib, "Tower of God", ch("Tower of God", 1, 12));

  let libRoot = lib;
  const events = [];
  const handlers = new Map();
  let slow = 0;
  // searchOpts.multiSource: the find rows record it, and their queue
  // follows it (fallback sites as prefetchedAlts).
  const settings = { syncEnabled: true, cpuLimit: "unlimited", syncPromptOnConnect: false, searchOpts: { multiSource: true } };
  const deps = {
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    send: (c, p) => events.push({ at: Date.now(), ev: p }),
    userDataDir: userData,
    getSettings: () => settings,
    getLibraryRoot: () => libRoot,
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
      clientOpts: { port: 1, recheckMs: 20, idleMs: 5000, connectTimeoutMs: 500 },
      locateAdb: async () => ({ resolved: null, candidates: [] }),
      ensureServer: async () => ({ ok: false, error: new Error("no adb in this recording"), started: false }),
      prewarmDelayMs: 60 * 60 * 1000,
      replanDebounceMs: 30,
      busyPollMs: 40,
      bootEpoch: 1,
      connectWaitMs: 2000,
      executorDeps: { hooks: (pt) => (pt === "after-pushed" && slow ? sleep(slow) : undefined) },
      makeSearcher: fakeSearcher,
    },
  };
  const svc = service.initDeviceSync(deps);
  const raw = (name, payload) => handlers.get(`sync:${name}`)({}, payload || {});
  const call = async (name, payload) => {
    const r = await raw(name, payload);
    assert.ok(r && r.ok !== false, `sync:${name} refused: ${JSON.stringify(r)}`);
    return r;
  };
  const state = () => raw("get-state");
  const idle = async () => {
    await waitFor(() => !svc._debug().current, 30000, "idle lane");
    await sleep(60);
    await waitFor(() => !svc._debug().current, 30000, "idle lane (2)");
  };
  const jobDone = (runId) => waitFor(() => (events.find((e) => e.ev.kind === "job" && e.ev.runId === runId && e.ev.state === "done") || {}).ev, 60000, `job ${runId}`);
  const planNow = async (id) => {
    await idle();
    const r = await call("plan", { targetId: id });
    await jobDone(r.runId);
    await idle();
    return (await state()).plans[id];
  };
  const out = { snapshots: {}, details: {}, selection: [], refusals: {} };
  try {
    const t = await call("config-op", { op: "add-target", target: { name: "Galaxy Tab", kind: "folder", root, profile: "komikku" } });
    const id = t.targetId;
    out.targetId = id;
    await waitFor(async () => (await raw("plan", { targetId: id, ifNeeded: true })).why === "fresh" || null, 30000, "first plan");
    await idle();
    out.snapshots.firstSync = await state();
    const first = await call("apply", { targetId: id, gen: (await state()).plans[id].gen });
    await jobDone(first.runId);
    await idle();

    // The edits behind the second plan.
    const dev = (rel) => path.join(root, rel);
    const touchOld = (p, d) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, d);
      const o = new Date(OLD_S * 1000);
      fs.utimesSync(p, o, o);
    };
    for (const [n, s] of Object.entries(ch("Eleceed", 7, 9))) touchOld(path.join(lib, "Eleceed", n), bytes(n, s));
    touchOld(path.join(lib, "Eleceed", "Ch.002 - Eleceed.cbz"), bytes("Ch.002 v2", 3402));
    touchOld(dev("Eleceed/Ch.004 [Asura].cbz"), bytes("asura 4", 2900));
    fs.rmSync(path.join(lib, "Dungeon Meshi", "Ch.003 - Dungeon Meshi.cbz"));
    fs.rmSync(dev("Solo Leveling"), { recursive: true, force: true });
    fs.rmSync(path.join(lib, "Berserk"), { recursive: true, force: true });
    touchOld(dev("Chainsaw Man/Ch.001.cbz"), bytes("csm 1", 2500));
    touchOld(dev("Chainsaw Man/Ch.002.cbz"), bytes("csm 2", 2600));
    series(lib, "Frieren", ch("Frieren", 1, 3));
    touchOld(dev("Frieren/Ch.001 - Frieren.cbz"), bytes("Ch.001 - Frieren.cbz", 3001));
    series(lib, "Kagurabachi", ch("Kagurabachi", 1, 2));
    writeYoung(path.join(lib, "Kagurabachi", "Ch.003 - Kagurabachi.cbz"), bytes("kb3", 3003), 5);
    // A folder the app never wrote whose name matches a new series once
    // punctuation is dropped (planner compactKey): a weak ("name" tier) link
    // suggestion. Not a case-only variant: on NTFS that IS the same folder.
    touchOld(dev("Kagurabachi_/Ch.001.cbz"), bytes("kb other", 2100));
    // F2: a device-only folder whose search is too close to call (Check match).
    touchOld(dev("Tis Time for Torture Princess/Ch.001.cbz"), bytes("ttp 1", 2700));
    let st = await state();
    const keyOf = (title) => st.plans[id].summary.series.find((x) => x.title === title || x.folder === title).seriesKey;
    await call("config-op", { op: "add-exclude", targetId: id, expectVersion: st.config.version, entry: { pcFolder: "Blue Lock" } });
    st = await state();
    await call("config-op", { op: "remove-series", targetId: id, seriesKey: keyOf("Tower of God") });
    const planned = await planNow(id);
    assert.ok(planned.summary, JSON.stringify(planned.refusal));
    out.snapshots.planned = await state();
    st = out.snapshots.planned;
    const sum = st.plans[id].summary;
    for (const row of sum.series) out.details[row.seriesKey] = await call("series-detail", { targetId: id, seriesKey: row.seriesKey });
    for (const d of sum.deviceOnly) out.details[d.key] = await call("series-detail", { targetId: id, seriesKey: d.key });
    out.review = await call("review", { targetId: id });

    // U4: the Library chip's input, and find-sources over the device-only
    // folders (no config change, so the plan below is untouched).
    out.libraryStatus = await call("library-status");
    const findFrom = events.length;
    await call("find-sources:start", { targetId: id });
    await waitFor(() => events.slice(findFrom).find((e) => e.ev.kind === "find" && e.ev.state === "done"), 15000, "find-sources done");
    out.find = await call("find-sources:get", { targetId: id });
    out.findRunning = (events.slice(findFrom).find((e) => e.ev.kind === "find" && e.ev.row && e.ev.row.state === "searching") || {}).ev || null;

    // Selection: each request with its reply and the `plans` push after it.
    const recordSel = async (label, req) => {
      const from = events.length;
      const reply = await raw("set-selection", { targetId: id, ...req });
      // A refused request changes nothing and pushes nothing.
      let view = null;
      if (reply.ok) {
        await waitFor(() => events.slice(from).find((e) => e.ev.kind === "plans" && e.ev.targetId === id), 4000, `plans after ${label}`);
        view = events.slice(from).reverse().find((e) => e.ev.kind === "plans" && e.ev.targetId === id).ev;
      }
      out.selection.push({ label, request: req, reply, view });
      return reply;
    };
    const gen = sum.gen;
    const el = sum.series.find((x) => x.title === "Eleceed");
    const elPush = out.details[el.seriesKey].rows.find((r) => r.kind === "push");
    await recordSel("untick one push", { gen, seq: 1, changes: [{ opId: elPush.opId, selected: false }] });
    await recordSel("series off", { gen, seq: 2, bulk: "series", seriesKey: el.seriesKey, selected: false });
    await recordSel("series back to pre-selection", { gen, seq: 3, bulk: "series", seriesKey: el.seriesKey, selected: true });
    await recordSel("stale gen", { gen: gen - 1, seq: 4, changes: [] });
    // Tick the removal of a chapter the PC no longer has: a loss to acknowledge.
    const dm = sum.series.find((x) => x.title === "Dungeon Meshi");
    const dmDel = out.details[dm.seriesKey].rows.find((r) => r.kind === "delete");
    await recordSel("tick a loss", { gen, seq: 5, changes: [{ opId: dmDel.opId, selected: true }] });
    out.reviewWithLoss = await call("review", { targetId: id });
    out.snapshots.withLoss = await state();

    // Refusals that need no state change first.
    out.refusals.planChanged = await raw("apply", { targetId: id, gen: gen - 1 });

    // Apply with timing (acks as the review shows them).
    const rv = out.reviewWithLoss;
    const ackLosses = rv.losses.flatMap((l) => l.lossOpIds);
    slow = 120;
    const from = events.length;
    const t0 = Date.now();
    const ap = await call("apply", { targetId: id, gen, ackLosses, ackMassDelete: rv.massDelete.count, ackMassRepush: rv.massRepush.count });
    await waitFor(() => svc._debug().current, 5000, "apply running");
    await sleep(150);
    out.snapshots.applying = await state();
    out.refusals.busy = await raw("plan", { targetId: id });
    await jobDone(ap.runId);
    slow = 0;
    out.applyEvents = events.slice(from).filter((e) => e.ev.kind === "job" && e.ev.runId === ap.runId).map((e) => ({ t: e.at - t0, ev: e.ev }));
    await idle();
    out.snapshots.afterApply = await state();

    // record-mismatch: the record names another folder.
    const hp = path.join(userData, "targets", id, "header.json");
    const header = JSON.parse(fs.readFileSync(hp, "utf8"));
    fs.writeFileSync(hp, JSON.stringify({ ...header, root: path.join(tmp, "Old Tablet", "Komikku") }));
    await planNow(id).catch(() => null);
    out.snapshots.recordMismatch = await state();
    fs.writeFileSync(hp, JSON.stringify(header));

    // device-listing-suspect: the target folder suddenly almost empty.
    const parked = path.join(tmp, "parked");
    fs.renameSync(root, parked);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".nomedia"), "");
    await planNow(id).catch(() => null);
    out.snapshots.listingSuspect = await state();
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(parked, root);

    // library-missing, then disconnected (both answered by the call itself).
    await idle();
    libRoot = path.join(tmp, "unplugged-drive", "manga");
    out.refusals.libraryMissing = await raw("plan", { targetId: id });
    libRoot = lib;
    fs.renameSync(root, parked);
    await waitFor(async () => (await raw("plan", { targetId: id, ifNeeded: true })).why === "disconnected", 15000, "target gone");
    out.refusals.disconnected = await raw("plan", { targetId: id });
    out.snapshots.disconnected = await state();
    fs.renameSync(parked, root);

    // U4: a folder linked by a queued find (what Queue N downloads writes).
    const csm = out.find.rows.find((r) => r.folder === "Chainsaw Man");
    st = await state();
    await call("config-op", { op: "add-alias", targetId: id, expectVersion: st.config.version, alias: { url: csm.candidates[0].best.url, deviceFolder: "Chainsaw Man" } });
    out.findConfig = (await state()).config;
  } finally {
    await svc.shutdown({ timeoutMs: 2000 });
  }

  // needs-mode: a non-hashing tablet's automatic plan.
  const srv = new FakeAdbServer();
  const port = await srv.listen();
  const d2 = srv.addDevice({ serial: SERIAL, model: "SM-T290", inject: { symlinks: { "/sdcard": "/storage/emulated/0" }, tools: { sha256sum: false } } });
  d2.fs.mkdirs(CANON);
  d2.fs.writeFile(`${CANON}/Eleceed/Ch.001 - Eleceed.cbz`, bytes("Ch.001 - Eleceed.cbz", 3001), { mtime: OLD_S });
  const h2 = new Map();
  const svc2 = service.initDeviceSync({
    ...deps,
    userDataDir: path.join(tmp, "tab-ud2", "sync"),
    ipcMain: { handle: (c, fn) => h2.set(c, fn) },
    send: () => {},
    _test: { ...deps._test, clientOpts: { port, recheckMs: 20, idleMs: 5000, connectTimeoutMs: 500 }, ensureServer: async (client) => ({ ok: true, version: await client.version(), started: false }) },
  });
  try {
    const r = await h2.get("sync:config-op")({}, { op: "add-target", target: { name: "Old tablet", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    // Prompt-on-connect is off here: the tab's own ifNeeded asks for the plan.
    await waitFor(async () => {
      await h2.get("sync:plan")({}, { targetId: r.targetId, ifNeeded: true });
      const s = await h2.get("sync:get-state")({}, {});
      return s.plans[r.targetId] && s.plans[r.targetId].refusal ? s : null;
    }, 30000, "needs-mode refusal");
    out.snapshots.needsMode = await h2.get("sync:get-state")({}, {});
  } finally {
    await svc2.shutdown({ timeoutMs: 2000 });
    await srv.close();
  }
  return out;
}
/**
 * tab.json snapshots `linking` and `verifying` (plan sync-temp/plans/
 * device-sync-cheap-replans.md §7): a Link landing without a full re-plan,
 * in a world of its own so recordTab's plan (and everything recorded off it)
 * stays as it was. A folder target with two series that are also on the
 * target under older folder names, same bytes (two content-match
 * suggestions), and one new series.
 *   linking    a Link clicked while a plan job runs: queued, the plan view
 *              carries it in `links` (bound:false) with updating
 *   verifying  then the second suggestion's Link with no job running: bound
 *              at once, the interim plan shows that series needs-verify
 *              while its refresh is still to come (the first `plans` push
 *              after the Link, taken from the events: the refresh lands
 *              moments later)
 * Each is a whole get-state answer; details for its rows are merged into the
 * returned `details` (keys don't collide with recordTab's series).
 */
async function recordLink(tmp) {
  const { FolderTransport } = require(path.join(SYNC, "transports.js"));
  const lib = path.join(tmp, "link-manga");
  const userData = path.join(tmp, "link-ud", "sync");
  const root = path.join(tmp, "Tablet4", "Komikku");
  fs.mkdirSync(root, { recursive: true });
  const old = new Date(OLD_S * 1000);
  const pair = (title, deviceFolder, files) => {
    series(lib, title, files);
    for (const [n, s] of Object.entries(files)) {
      const p = path.join(root, deviceFolder, n);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, bytes(n, s));
      fs.utimesSync(p, old, old);
    }
  };
  pair("Hajime no Ippo", "Hajime no Ippo (old)", { "Ch.001 - Hajime.cbz": 3101, "Ch.002 - Hajime.cbz": 3102 });
  pair("Mob Psycho 100", "Mob Psycho (2019)", { "Ch.001 - Mob.cbz": 2901, "Ch.002 - Mob.cbz": 2902, "Ch.003 - Mob.cbz": 2903 });
  series(lib, "Kaiju No. 8", { "Ch.001 - Kaiju.cbz": 2801 });
  const events = [];
  const handlers = new Map();
  const settings = { syncEnabled: true, cpuLimit: "unlimited", syncPromptOnConnect: false };
  const svc = service.initDeviceSync({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    send: (c, p) => events.push(p),
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
      clientOpts: { port: 1, recheckMs: 20, idleMs: 5000, connectTimeoutMs: 500 },
      locateAdb: async () => ({ resolved: null, candidates: [] }),
      ensureServer: async () => ({ ok: false, error: new Error("no adb in this recording"), started: false }),
      prewarmDelayMs: 60 * 60 * 1000,
      replanDebounceMs: 30,
      busyPollMs: 40,
      bootEpoch: 1,
      connectWaitMs: 2000,
    },
  });
  const raw = (name, payload) => handlers.get(`sync:${name}`)({}, payload || {});
  const call = async (name, payload) => {
    const r = await raw(name, payload);
    assert.ok(r && r.ok !== false, `sync:${name} refused: ${JSON.stringify(r)}`);
    return r;
  };
  const state = () => raw("get-state");
  const idle = async () => {
    await waitFor(() => !svc._debug().current, 30000, "idle lane");
    await sleep(60);
    await waitFor(() => !svc._debug().current, 30000, "idle lane (2)");
  };
  const out = { snapshots: {}, details: {} };
  try {
    const t = await call("config-op", { op: "add-target", target: { name: "Galaxy Tab", kind: "folder", root, profile: "komikku" } });
    const id = t.targetId;
    await waitFor(async () => (await raw("plan", { targetId: id, ifNeeded: true })).why === "fresh" || null, 30000, "first plan");
    await idle();
    const sum0 = (await state()).plans[id].summary;
    const sugOf = (folder) => {
      const r = sum0.series.find((x) => x.folder === folder);
      return sum0.suggestionList.find((g) => g.seriesKey === r.seriesKey);
    };
    const sug = sugOf("Hajime no Ippo");
    const sug2 = sugOf("Mob Psycho 100");
    assert.ok(sug && sug2, "the world has two link suggestions");

    // linking: hold the plan job at its probe, Link, read the state.
    let open;
    const wait = new Promise((r) => (open = r));
    let reached;
    const hit = new Promise((r) => (reached = r));
    const probe = FolderTransport.prototype.probe;
    FolderTransport.prototype.probe = async function (...args) {
      FolderTransport.prototype.probe = probe;
      reached();
      await wait;
      return probe.apply(this, args);
    };
    try {
      await call("plan", { targetId: id });
      await hit;
      const lk = await call("link", { targetId: id, suggestionIds: [sug.id] });
      assert.ok(lk.queued, JSON.stringify(lk));
      out.snapshots.linking = await state();
      const v = out.snapshots.linking.plans[id];
      assert.deepStrictEqual([v.updating, v.links.map((l) => l.bound)], [true, [false]]);
      for (const row of v.summary.series) out.details[row.seriesKey] = await call("series-detail", { targetId: id, seriesKey: row.seriesKey });
      for (const d of v.summary.deviceOnly) out.details[d.key] = await call("series-detail", { targetId: id, seriesKey: d.key });
    } finally {
      FolderTransport.prototype.probe = probe;
      open();
    }
    // The queued Link lands after that plan (a refresh verifies it).
    await waitFor(async () => {
      const p = (await state()).plans[id];
      return !p.stale && !p.links.length && p.summary.series.some((r) => r.seriesKey === sug.seriesKey && r.state === "bound") ? p : null;
    }, 30000, "the queued Link landed");
    await idle();

    // verifying: the second Link with the lane idle; the first push after
    // it is the interim plan (needs-verify, refresh to come).
    const from = events.length;
    await call("link", { targetId: id, suggestionIds: [sug2.id] });
    // Pushes are coalesced to the next tick (service.js _planChanged).
    const interim = await waitFor(
      () => events.slice(from).find((e) => e.kind === "plans" && e.targetId === id && e.summary && e.summary.series.some((r) => r.seriesKey === sug2.seriesKey && r.state === "needs-verify")),
      5000,
      "the interim needs-verify plan"
    );
    assert.ok(interim && interim.updating, "an interim needs-verify plan was pushed with updating");
    await idle();
    const after = await state();
    const { kind, targetId, ...view } = interim; // eslint-disable-line no-unused-vars
    out.snapshots.verifying = { ...after, plans: { ...after.plans, [id]: view } };
    // Detail sheets answer from the linking snapshot's recordings (the
    // interim plan's own details are gone once the refresh adopts).
  } finally {
    await svc.shutdown({ timeoutMs: 2000 });
  }
  return out;
}

/**
 * prompts.json (UI pass U3): the connect card's inputs as main sends them.
 *   ready     a folder target appearing with prompt-on-connect on: the
 *             `pending` event (Preparing card), the running connect plan's
 *             job with its progress, the `show` event and get-state at show
 *   needsMode a non-hashing tablet's first connect: the card carries it as
 *             an `attention` entry with the read-back bytes
 * The device-state cards (unauthorized, no-permissions, authorizing,
 * connecting) need no recording: they are devices[] rows (devices.json)
 * with another stateKind.
 */
async function recordPrompts(tmp) {
  const lib = path.join(tmp, "prompt-manga");
  const root = path.join(tmp, "Tablet3", "Komikku");
  fs.mkdirSync(root, { recursive: true });
  const ch = (title, from, to, size = 3000) => {
    const o = {};
    for (let i = from; i <= to; i += 1) o[`Ch.${String(i).padStart(3, "0")} - ${title}.cbz`] = size + i;
    return o;
  };
  series(lib, "Eleceed", ch("Eleceed", 1, 6));
  series(lib, "Frieren", ch("Frieren", 1, 4));
  series(lib, "Kagurabachi", ch("Kagurabachi", 1, 3));
  const events = [];
  const handlers = new Map();
  const settings = { syncEnabled: true, cpuLimit: "unlimited", syncPromptOnConnect: true };
  const baseTest = {
    clientOpts: { port: 1, recheckMs: 20, idleMs: 5000, connectTimeoutMs: 500 },
    locateAdb: async () => ({ resolved: null, candidates: [] }),
    ensureServer: async () => ({ ok: false, error: new Error("no adb in this recording"), started: false }),
    prewarmDelayMs: 60 * 60 * 1000,
    replanDebounceMs: 30,
    busyPollMs: 40,
    bootEpoch: 1,
    connectWaitMs: 2000,
  };
  const deps = {
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    send: (c, p) => events.push(p),
    userDataDir: path.join(tmp, "prompt-ud", "sync"),
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
    _test: baseTest,
  };
  const out = {};
  const svc = service.initDeviceSync(deps);
  try {
    const r = await handlers.get("sync:config-op")({}, { op: "add-target", target: { name: "Galaxy Tab", kind: "folder", root, profile: "komikku" } });
    assert.ok(r.ok, JSON.stringify(r));
    const show = await waitFor(() => events.find((e) => e.kind === "prompt" && e.action === "show"), 30000, "ready prompt");
    out.ready = {
      pending: events.find((e) => e.kind === "prompt" && e.action === "pending" && e.pending.length),
      show,
      state: await handlers.get("sync:get-state")({}, {}),
    };
    // The connect plan's job as the hook holds it mid-run: the begin event's
    // job with the last progress that carried a file count.
    const begin = events.find((e) => e.kind === "job" && e.job && e.job.phase === "plan" && e.job.state === "running");
    const prog = events.filter((e) => e.kind === "job" && begin && e.runId === begin.runId && e.progress && e.progress.filesTotal);
    out.ready.job = begin ? { ...begin.job, progress: { ...(begin.job.progress || {}), ...((prog[Math.floor(prog.length / 2)] || {}).progress || {}) } } : null;
  } finally {
    await svc.shutdown({ timeoutMs: 2000 });
  }

  const srv = new FakeAdbServer();
  const port = await srv.listen();
  const d2 = srv.addDevice({ serial: SERIAL, model: "SM-T290", inject: { symlinks: { "/sdcard": "/storage/emulated/0" }, tools: { sha256sum: false } } });
  d2.fs.mkdirs(CANON);
  for (const [n, s] of Object.entries(ch("Eleceed", 1, 3))) d2.fs.writeFile(`${CANON}/Eleceed/${n}`, bytes(n, s), { mtime: OLD_S });
  const ev2 = [];
  const h2 = new Map();
  const svc2 = service.initDeviceSync({
    ...deps,
    userDataDir: path.join(tmp, "prompt-ud2", "sync"),
    ipcMain: { handle: (c, fn) => h2.set(c, fn) },
    send: (c, p) => ev2.push(p),
    _test: { ...baseTest, clientOpts: { port, recheckMs: 20, idleMs: 5000, connectTimeoutMs: 500 }, ensureServer: async (client) => ({ ok: true, version: await client.version(), started: false }) },
  });
  try {
    const r = await h2.get("sync:config-op")({}, { op: "add-target", target: { name: "Old tablet", kind: "adb", serial: SERIAL, root: "/sdcard/Komikku/local", profile: "komikku" } });
    assert.ok(r.ok, JSON.stringify(r));
    const show = await waitFor(() => ev2.find((e) => e.kind === "prompt" && e.action === "show"), 30000, "needs-mode prompt");
    assert.ok(show.prompt.card.attention.length, JSON.stringify(show.prompt.card));
    out.needsMode = { show, state: await h2.get("sync:get-state")({}, {}) };
  } finally {
    await svc2.shutdown({ timeoutMs: 2000 });
    await srv.close();
  }
  return out;
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
  out.tab = await recordTab(tmp);
  {
    const link = await recordLink(tmp);
    Object.assign(out.tab.snapshots, link.snapshots);
    Object.assign(out.tab.details, link.details);
  }
  out.prompts = await recordPrompts(tmp);

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
    "tab.json": out.tab,
    "prompts.json": out.prompts,
  };
  for (const [name, data] of Object.entries(files)) {
    const body = { [SYNC_FIXTURE_MARKER]: name, generatedBy: "tools/_gen_sync_fixtures.js", data: scrub(data, tmp) };
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(body, null, 2) + "\n");
  }
  // The account name and the profile folder can differ (this PC: account
  // "Thundia", profile C:\Users\legoc), so check both, and the temp root.
  const needles = [os.userInfo().username, path.basename(os.homedir()), "aio-sync-fixtures-"].filter((x) => x && x.length > 2).map((x) => x.toLowerCase());
  const leaked = Object.keys(files).filter((n) => {
    const body = fs.readFileSync(path.join(OUT, n), "utf8").toLowerCase();
    return needles.some((x) => body.includes(x));
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (leaked.length) throw new Error(`fixture carries the local user name: ${leaked.join(", ")}`);
  console.log(`wrote ${Object.keys(files).length} fixtures to ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
