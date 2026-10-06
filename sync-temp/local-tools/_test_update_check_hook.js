// Offline regression test for UI-source/src/hooks/useUpdateCheck.js — the
// renderer mirror of the library "Check All" sweep.
// Run: node tools/_test_update_check_hook.js   (from the repo root or tools/)
//
// Drives the REAL hook source (no logic duplicated here): the file is read,
// its single `import ... from "react"` line is stripped, and it is evaluated
// against the ~90-line hook runtime below. If the hook drifts, this fails.
// The runtime is deliberately minimal but faithful on the three behaviours
// the hook actually leans on: functional setState composing within one event,
// a value-equal setState bailing out, and useCallback identity stability
// (which is what keeps the subscribe effect from re-running).
//
// What it pins:
//   - state survives independently of any component (the tab-switch bug)
//   - start() REFUSES to restart a live sweep; only force preempts
//   - a refusal answer is adopted, so the UI resyncs instead of blanking
//   - the hydration snapshot and events that race it both survive
//   - badges CLEAR when a rescan finds a series up to date (the staleness
//     this fix would otherwise have made permanent)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "UI-source", "src", "hooks", "useUpdateCheck.js");

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

// ── Load the real hook against an injected React ─────────────────────────
function loadHook() {
  let src = fs.readFileSync(HOOK, "utf8");
  const importLine = /^import\s*\{[^}]*\}\s*from\s*"react";\s*$/m;
  if (!importLine.test(src)) {
    throw new Error("useUpdateCheck.js no longer opens with the expected react import — update this harness");
  }
  src = src.replace(importLine, "");
  src = src.replace(/^export function useUpdateCheck/m, "function useUpdateCheck");
  src = src.replace(/^export default useUpdateCheck;\s*$/m, "");
  // eslint-disable-next-line no-new-func
  return new Function(
    "useState", "useEffect", "useCallback", "useMemo", "useRef", "window", "console",
    `${src}\nreturn useUpdateCheck;`
  );
}

// ── Minimal hook runtime ─────────────────────────────────────────────────
function mount(hookFactory, windowStub, consoleStub, props) {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let pendingEffects = [];
  let result = null;

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((v, i) => Object.is(v, b[i]));

  function useState(init) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { v: typeof init === "function" ? init() : init };
    const slot = slots[i];
    const set = (next) => {
      const value = typeof next === "function" ? next(slot.v) : next;
      if (Object.is(value, slot.v)) return; // React bails on an identical value
      slot.v = value;
      dirty = true;
    };
    return [slot.v, set];
  }
  function useRef(init) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: init };
    return slots[i];
  }
  function useCallback(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    slots[i] = { value: fn, deps };
    return fn;
  }
  function useMemo(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    const value = fn();
    slots[i] = { value, deps };
    return value;
  }
  function useEffect(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && sameDeps(prev.deps, deps)) return;
    const slot = { deps, cleanup: prev ? prev.cleanup : undefined };
    slots[i] = slot;
    pendingEffects.push(() => {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = fn();
    });
  }

  const useUpdateCheck = hookFactory(
    useState, useEffect, useCallback, useMemo, useRef, windowStub, consoleStub
  );

  function renderOnce() {
    cursor = 0;
    dirty = false;
    result = useUpdateCheck(props);
    const effects = pendingEffects;
    pendingEffects = [];
    for (const run of effects) run();
  }

  function settle() {
    renderOnce();
    let guard = 0;
    while (dirty) {
      if (++guard > 50) throw new Error("render loop did not settle");
      renderOnce();
    }
    return result;
  }

  settle();
  return {
    get state() { return result; },
    // Run something external (an IPC callback, a user action), then let the
    // "component" re-render the way React would.
    act(fn) {
      const out = fn();
      settle();
      return out;
    },
    async actAsync(fn) {
      const out = await fn();
      // let any promise chains the hook started resolve
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      settle();
      return out;
    },
  };
}

// ── Test rig ─────────────────────────────────────────────────────────────
const hookFactory = loadHook();

function makeHarness({ snapshot = null, snapshotDelayed = false } = {}) {
  const listeners = [];
  const calls = { checkAll: [], cancel: 0, getState: 0, setIgnored: [] };
  // folderPath → the crossed-out list main would hold on disk.
  const ignoredByFolder = new Map();
  let releaseSnapshot;
  const snapshotPromise = snapshotDelayed
    ? new Promise((res) => { releaseSnapshot = () => res(snapshot); })
    : Promise.resolve(snapshot);

  let libraryEntries = [
    { folderPath: "F1", title: "One", seriesMeta: { status: "Ongoing", chapters_downloaded: ["1"] } },
    { folderPath: "F2", title: "Two", seriesMeta: { status: "Ongoing", chapters_downloaded: ["1"] } },
  ];
  const setLibraryEntries = (updater) => {
    libraryEntries = typeof updater === "function" ? updater(libraryEntries) : updater;
  };

  const windowStub = {
    electronAPI: {
      onUpdateCheckProgress(cb) {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      getUpdateCheckState() {
        calls.getState += 1;
        return snapshotPromise;
      },
      checkAllUpdates(opts) {
        calls.checkAll.push(opts);
        return Promise.resolve(harness.checkAllAnswer);
      },
      cancelCheckAllUpdates() {
        calls.cancel += 1;
        return Promise.resolve({ ok: true });
      },
      // Stands in for main's set-chapters-ignored, which owns the on-disk
      // list. Kept per-folder here so the answers the hook mirrors into the
      // library entry are the real accumulated list, not a fixed stub.
      setChaptersIgnored(folderPath, chapters, ignored) {
        calls.setIgnored.push({ folderPath, chapters, ignored });
        if (harness.setIgnoredAnswer) return Promise.resolve(harness.setIgnoredAnswer);
        const set = new Set(ignoredByFolder.get(folderPath) || []);
        for (const c of chapters) {
          if (ignored) set.add(c);
          else set.delete(c);
        }
        const chaptersIgnored = [...set].sort((a, b) => parseFloat(a) - parseFloat(b));
        ignoredByFolder.set(folderPath, chaptersIgnored);
        return Promise.resolve({ ok: true, chaptersIgnored });
      },
    },
  };
  const errors = [];
  const consoleStub = { error: (...a) => errors.push(a.join(" ")), log: () => {} };

  const harness = {
    calls,
    errors,
    checkAllAnswer: { status: "done" },
    // Set to force a failure answer out of setChaptersIgnored.
    setIgnoredAnswer: null,
    releaseSnapshot: () => releaseSnapshot && releaseSnapshot(),
    get libraryEntries() { return libraryEntries; },
    emit(event) { for (const cb of listeners.slice()) cb(event); },
    mounted: null,
  };
  harness.mounted = mount(hookFactory, windowStub, consoleStub, { setLibraryEntries });
  return harness;
}

const row = (folderPath, state, extra = {}) => ({
  folderPath, title: folderPath, cover: null, site: "s", state, enqueuedAt: 1, ...extra,
});

const settleAsync = () => new Promise((r) => setImmediate(r));

(async function run() {
  // ── 1. A live sweep drives the mirror ──────────────────────────────────
  console.log("\n[1] live sweep");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => {});
    eq("starts idle", h.mounted.state.scanState, "idle");
    eq("hydration was attempted once", h.calls.getState, 1);

    h.mounted.act(() => {
      h.emit({ kind: "queued", runId: 4, row: row("F1", "queued"), completed: 0, total: 2 });
      h.emit({ kind: "queued", runId: 4, row: row("F2", "queued"), completed: 0, total: 2 });
    });
    eq("a first event flips it to running", h.mounted.state.scanState, "running");
    eq("queued rows land", [...h.mounted.state.rows.keys()], ["F1", "F2"]);
    eq("total comes off the event", h.mounted.state.scanStats.total, 2);

    h.mounted.act(() => h.emit({
      kind: "completed", runId: 4,
      row: row("F1", "found", { newChapters: ["7", "8"], total: 20 }),
      updatedMeta: { status: "Releasing", cover: null },
      completed: 1, total: 2,
    }));
    eq("progress folds in", h.mounted.state.scanStats.completed, 1);
    eq("found badge appears", h.mounted.state.newChapterCounts, { F1: 2 });
    eq("foundCount tracks it", h.mounted.state.foundCount, 1);
    eq("updatedMeta splices into the library",
       h.libraryEntries.find((e) => e.folderPath === "F1").seriesMeta.status, "Releasing");
    check("the splice does not drop untouched fields",
          h.libraryEntries.find((e) => e.folderPath === "F1").seriesMeta.chapters_downloaded.length === 1);
    check("a null updatedMeta field is ignored",
          h.libraryEntries.find((e) => e.folderPath === "F1").seriesMeta.cover === undefined);

    h.mounted.act(() => h.emit({
      kind: "completed", runId: 4, row: row("F2", "uptodate", { total: 20 }),
      updatedMeta: null, completed: 2, total: 2,
    }));
    h.mounted.act(() => h.emit({
      kind: "done", runId: 4, completed: 2, total: 2, durationMs: 3300, aborted: false,
    }));
    eq("done closes the scan", h.mounted.state.scanState, "done");
    eq("duration lands", h.mounted.state.scanStats.durationMs, 3300);
    eq("aborted stays false", h.mounted.state.scanStats.aborted, false);
    eq("badges reflect only found rows", h.mounted.state.newChapterCounts, { F1: 2 });
  }

  // ── 2. The tab-switch bug: a live sweep is never restarted ─────────────
  console.log("\n[2] no implicit restart");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => {
      h.emit({ kind: "queued", runId: 1, row: row("F1", "queued"), completed: 0, total: 2 });
      h.emit({ kind: "running", runId: 1, row: row("F1", "running"), completed: 0, total: 2 });
    });
    const before = [...h.mounted.state.rows.keys()];

    // This is the click the user made after coming back from the Queue tab.
    const answer = await h.mounted.actAsync(() => h.mounted.state.start());
    eq("start() refuses while running", answer.status, "already-running");
    eq("...and never reaches the IPC", h.calls.checkAll.length, 0);
    eq("...and leaves the rows alone", [...h.mounted.state.rows.keys()], before);
    eq("...and stays running", h.mounted.state.scanState, "running");

    // Rescan is the explicit gesture, and it IS allowed through.
    await h.mounted.actAsync(() => h.mounted.state.start({ force: true }));
    eq("force reaches the IPC", h.calls.checkAll.length, 1);
    eq("force is forwarded", h.calls.checkAll[0], { force: true });
    eq("a forced start clears the old rows", h.mounted.state.rows.size, 0);
    eq("a forced start shows as running", h.mounted.state.scanState, "running");
  }

  // ── 3. Main refuses → adopt its snapshot instead of blanking ───────────
  console.log("\n[3] refusal resync");
  {
    const h = makeHarness();
    await settleAsync();
    h.checkAllAnswer = {
      status: "already-running",
      runId: 9,
      snapshot: {
        runId: 9, state: "running", completed: 1, total: 3, durationMs: 0, aborted: false,
        rows: [
          row("A", "found", { newChapters: ["3"], total: 12 }),
          row("B", "running"),
          row("C", "queued"),
        ],
      },
    };
    // The hook thinks it is idle (stale renderer), so its local guard lets
    // the call through — main's answer has to put it right.
    await h.mounted.actAsync(() => h.mounted.state.start());
    eq("the refusal snapshot is adopted", [...h.mounted.state.rows.keys()], ["A", "B", "C"]);
    eq("...with its scan state", h.mounted.state.scanState, "running");
    eq("...with its progress", [h.mounted.state.scanStats.completed, h.mounted.state.scanStats.total], [1, 3]);
    eq("...and its badges", h.mounted.state.newChapterCounts, { A: 1 });
  }

  // ── 4. Startup hydration + the event that races it ─────────────────────
  console.log("\n[4] hydration");
  {
    const h = makeHarness({
      snapshotDelayed: true,
      snapshot: {
        runId: 2, state: "running", completed: 1, total: 3, durationMs: 0, aborted: false,
        rows: [row("A", "found", { newChapters: ["1", "2"], total: 5 }), row("B", "running"), row("C", "queued")],
      },
    });
    // An event lands BEFORE the snapshot IPC resolves — the case that used
    // to be unrepresentable because nothing hydrated at all.
    h.mounted.act(() => h.emit({
      kind: "completed", runId: 2, row: row("B", "uptodate", { total: 5 }), completed: 2, total: 3,
    }));
    eq("pre-hydration events are buffered, not applied", h.mounted.state.rows.size, 0);

    await h.mounted.actAsync(() => h.releaseSnapshot());
    eq("the snapshot lands", [...h.mounted.state.rows.keys()].sort(), ["A", "B", "C"]);
    eq("the buffered event is applied ON TOP", h.mounted.state.rows.get("B").state, "uptodate");
    eq("...including its progress", h.mounted.state.scanStats.completed, 2);
    eq("snapshot badges survive", h.mounted.state.newChapterCounts, { A: 2 });
    eq("the adopted sweep is still running", h.mounted.state.scanState, "running");

    // And the run continues normally afterwards.
    h.mounted.act(() => h.emit({
      kind: "done", runId: 2, completed: 3, total: 3, durationMs: 900, aborted: false,
    }));
    eq("the adopted sweep can finish", h.mounted.state.scanState, "done");
  }

  // ── 5. A new runId supersedes the old rows ─────────────────────────────
  console.log("\n[5] supersede");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => {
      h.emit({ kind: "completed", runId: 1, row: row("OLD", "found", { newChapters: ["1"] }), completed: 1, total: 1 });
      h.emit({ kind: "done", runId: 1, completed: 1, total: 1, durationMs: 10, aborted: false });
    });
    eq("run 1 finished with a badge", h.mounted.state.newChapterCounts, { OLD: 1 });

    h.mounted.act(() => h.emit({
      kind: "queued", runId: 2, row: row("NEW", "queued"), completed: 0, total: 1,
    }));
    eq("a new runId drops the old rows", [...h.mounted.state.rows.keys()], ["NEW"]);
    eq("...and shows as running again", h.mounted.state.scanState, "running");
    eq("badges deliberately survive the reset", h.mounted.state.newChapterCounts, { OLD: 1 });

    // The staleness guard: OLD is checked again and is now up to date.
    h.mounted.act(() => h.emit({
      kind: "completed", runId: 2, row: row("OLD", "uptodate", { total: 9 }), completed: 1, total: 1,
    }));
    eq("a now-uptodate series LOSES its badge", h.mounted.state.newChapterCounts, {});
  }

  // ── 6. Queue / dismiss resolution ──────────────────────────────────────
  console.log("\n[6] resolveRows");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => {
      h.emit({ kind: "completed", runId: 1, row: row("A", "found", { newChapters: ["1", "2"] }), completed: 1, total: 3 });
      h.emit({ kind: "completed", runId: 1, row: row("B", "found", { newChapters: ["4"] }), completed: 2, total: 3 });
      h.emit({ kind: "completed", runId: 1, row: row("C", "uptodate", { total: 9 }), completed: 3, total: 3 });
      h.emit({ kind: "done", runId: 1, completed: 3, total: 3, durationMs: 5, aborted: false });
    });
    eq("two found rows", h.mounted.state.foundCount, 2);

    h.mounted.act(() => h.mounted.state.resolveRows(["A"]));
    eq("the actioned row drops to uptodate", h.mounted.state.rows.get("A").state, "uptodate");
    check("...and sheds its newChapters", !h.mounted.state.rows.get("A").newChapters);
    eq("...and its badge", h.mounted.state.newChapterCounts, { B: 1 });
    eq("...leaving the other found row alone", h.mounted.state.rows.get("B").state, "found");
    eq("the row stays visible in the panel", h.mounted.state.rows.size, 3);

    h.mounted.act(() => h.mounted.state.resolveRows(["B"]));
    eq("bulk resolution empties the badges", h.mounted.state.newChapterCounts, {});
    eq("foundCount hits zero", h.mounted.state.foundCount, 0);

    h.mounted.act(() => h.mounted.state.resolveRows([]));
    h.mounted.act(() => h.mounted.state.resolveRows(["nonexistent"]));
    check("resolving nothing / a missing row is a no-op", h.mounted.state.rows.size === 3);
  }

  // ── 7. Cancel ──────────────────────────────────────────────────────────
  console.log("\n[7] cancel");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => h.emit({
      kind: "queued", runId: 1, row: row("A", "queued"), completed: 0, total: 4,
    }));
    await h.mounted.actAsync(() => h.mounted.state.cancel());
    eq("cancel reaches the IPC", h.calls.cancel, 1);
    h.mounted.act(() => h.emit({
      kind: "done", runId: 1, completed: 1, total: 4, durationMs: 120, aborted: true,
    }));
    eq("an aborted sweep is flagged", h.mounted.state.scanStats.aborted, true);
    eq("...and is done, so a new scan is allowed", h.mounted.state.scanState, "done");
    const answer = await h.mounted.actAsync(() => h.mounted.state.start());
    check("start() after a cancel goes through", answer && answer.status !== "already-running");
    eq("...and reaches the IPC", h.calls.checkAll.length, 1);
    eq("...unforced", h.calls.checkAll[0], { force: false });
  }

  // ── 8. Malformed / unknown events don't wedge the mirror ───────────────
  console.log("\n[8] robustness");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => {
      h.emit(null);
      h.emit({});
      h.emit({ kind: "completed", runId: 1 });               // no row
      h.emit({ kind: "who-knows", runId: 1, row: row("A", "queued"), completed: 0, total: 1 });
    });
    eq("an unknown kind still stores its row", [...h.mounted.state.rows.keys()], ["A"]);
    eq("no console errors were raised", h.errors, []);
  }

  // ── 9. setRowIgnored: the per-chapter "×" ──────────────────────────────
  // Crossing a chapter out is the one action here that touches disk, and the
  // row it produces has to be indistinguishable from one a later sweep sends
  // — otherwise the panel renders one thing now and another after a rescan.
  console.log("\n[9] setRowIgnored");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => h.emit({
      kind: "completed", runId: 1,
      row: row("F1", "found", { newChapters: ["10", "11", "12"], total: 40 }),
      completed: 1, total: 1,
    }));
    eq("three downloadable chapters to start", h.mounted.state.newChapterCounts, { F1: 3 });

    await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("F1", ["11"], true));
    eq("the write reached main",
       h.calls.setIgnored, [{ folderPath: "F1", chapters: ["11"], ignored: true }]);
    let r = h.mounted.state.rows.get("F1");
    eq("the chapter leaves newChapters", r.newChapters, ["10", "12"]);
    eq("...and lands in ignoredChapters", r.ignoredChapters, ["11"]);
    eq("the row is still found", r.state, "found");
    eq("the badge counts only what is downloadable", h.mounted.state.newChapterCounts, { F1: 2 });
    eq("the library entry mirrors the on-disk list",
       h.libraryEntries.find((e) => e.folderPath === "F1").seriesMeta.chapters_ignored, ["11"]);

    // Crossing out the REST is the case that flips the row's meaning: nothing
    // is downloadable, so the series is up to date — but it must keep the
    // crossed-out list, or the undo below has nothing to act on.
    await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("F1", ["10", "12"], true));
    r = h.mounted.state.rows.get("F1");
    eq("crossing out the last chapters flips it to uptodate", r.state, "uptodate");
    check("...and it sheds newChapters entirely", !("newChapters" in r));
    eq("...but keeps all three crossed out", r.ignoredChapters, ["10", "11", "12"]);
    eq("...and the badge is gone", h.mounted.state.newChapterCounts, {});
    eq("...and it no longer counts as found", h.mounted.state.foundCount, 0);

    // Undo, from the uptodate row.
    await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("F1", ["11"], false));
    r = h.mounted.state.rows.get("F1");
    eq("restoring flips it back to found", r.state, "found");
    eq("...with the chapter downloadable again", r.newChapters, ["11"]);
    eq("...and the rest still crossed out", r.ignoredChapters, ["10", "12"]);
    eq("...and the badge returns", h.mounted.state.newChapterCounts, { F1: 1 });

    // Restoring everything must leave a plain found row, with no empty
    // ignoredChapters key lingering to make it differ from a fresh one.
    await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("F1", ["10", "12"], false));
    r = h.mounted.state.rows.get("F1");
    eq("everything restored", r.newChapters, ["10", "11", "12"]);
    check("no empty ignoredChapters key is left behind", !("ignoredChapters" in r));
    check("the library entry drops the key too",
          !("chapters_ignored" in h.libraryEntries.find((e) => e.folderPath === "F1").seriesMeta));
  }

  // ── 10. setRowIgnored refuses to lie ───────────────────────────────────
  console.log("\n[10] setRowIgnored guards");
  {
    const h = makeHarness();
    await settleAsync();
    h.mounted.act(() => h.emit({
      kind: "completed", runId: 1,
      row: row("F1", "found", { newChapters: ["10"], total: 40 }),
      completed: 1, total: 1,
    }));

    // A failed write must NOT strike the chapter through — the file is what
    // decides the next check, so a row that disagrees with it is the one
    // outcome worse than the click doing nothing.
    h.setIgnoredAnswer = { ok: false, error: "no_metadata" };
    const bad = await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("F1", ["10"], true));
    eq("a failed write is reported", bad.ok, false);
    eq("...and the row is untouched", h.mounted.state.rows.get("F1").newChapters, ["10"]);
    eq("...and the badge is untouched", h.mounted.state.newChapterCounts, { F1: 1 });
    h.setIgnoredAnswer = null;

    // An empty list short-circuits before the IPC.
    const none = await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("F1", [], true));
    eq("an empty chapter list is a no-op", none.ok, true);
    eq("...and never reaches main", h.calls.setIgnored.length, 1);

    // A row this renderer has never seen (crossed out from the detail view
    // before any sweep ran) still has to persist — there is just no row to
    // patch, and that must not throw.
    const orphan = await h.mounted.actAsync(
      () => h.mounted.state.setRowIgnored("NEVER-SCANNED", ["3"], true)
    );
    eq("a folder with no row still writes", orphan.ok, true);
    eq("...and reaches main", h.calls.setIgnored.length, 2);
    check("...without inventing a row", !h.mounted.state.rows.has("NEVER-SCANNED"));

    // Rows that carry no chapter list must keep their own state. Re-deriving
    // it from an empty list would rewrite a FAILED check as "uptodate" — the
    // detail view can cross a chapter out for a series whose panel row errored,
    // and laundering the error away is the one outcome that loses information.
    h.mounted.act(() => h.emit({
      kind: "completed", runId: 1,
      row: row("BROKE", "error", { error: "check_failed", errorMessage: "Timed out" }),
      completed: 1, total: 1,
    }));
    await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("BROKE", ["5"], true));
    const broke = h.mounted.state.rows.get("BROKE");
    eq("an errored row keeps its state", broke.state, "error");
    eq("...and its message", broke.errorMessage, "Timed out");
    check("...and grows no chapter lists",
          !("newChapters" in broke) && !("ignoredChapters" in broke));
    eq("...while the write still went through", h.calls.setIgnored.length, 3);

    // Same for a row still being checked — the sweep will overwrite it.
    h.mounted.act(() => h.emit({
      kind: "running", runId: 1, row: row("BUSY", "running"), completed: 1, total: 2,
    }));
    await h.mounted.actAsync(() => h.mounted.state.setRowIgnored("BUSY", ["5"], true));
    eq("an in-flight row is left alone", h.mounted.state.rows.get("BUSY").state, "running");

    eq("no console errors were raised", h.errors, []);
  }

  console.log(
    failures === 0
      ? "\nAll useUpdateCheck checks passed."
      : `\n${failures} check(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
