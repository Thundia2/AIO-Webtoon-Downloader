// Offline regression test for UI-source/electron/update-check-record.js —
// the main-process record behind the library "Check All" sweep.
// Run: node tools/_test_update_check_record.js   (from the repo root or tools/)
//
// What it pins, and why each one is a bug that actually shipped:
//   - resultRow is the ONE reducer. The renderer used to own a second copy,
//     so a snapshot handed to a remounting Library tab could disagree with a
//     live event about the same series.
//   - Rows never inherit: a series that was "found" and is later "uptodate"
//     must not still carry newChapters.
//   - Superseded runs are silent. A forced rescan preempts workers still
//     awaiting Python; their late "completed"/"done" emissions would land in
//     the NEW run's rows and flip it to done at ~0% progress.
//   - isRunning()/snapshot() are what main.js's re-entrancy guard answers
//     with instead of restarting a live sweep — the whole point of the fix.

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createUpdateCheckRecord, resultRow } = require(
  path.join(ROOT, "UI-source", "electron", "update-check-record")
);

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

// A recording sink in place of main.js's sendToUI.
function makeRecord() {
  const sent = [];
  const rec = createUpdateCheckRecord((channel, payload) => sent.push({ channel, payload }));
  return { rec, sent };
}

const BASE = Object.freeze({
  folderPath: "D:\\AIO\\manga\\Tekyuu",
  title: "Tekyuu",
  cover: "https://example.invalid/c.jpg",
  site: "mangadex",
  enqueuedAt: 1000,
});

// ── 1. resultRow derivation ──────────────────────────────────────────────
console.log("\n[1] resultRow");
{
  const aborted = resultRow(BASE, { error: "aborted" });
  eq("aborted → error/cancelled", [aborted.state, aborted.error, aborted.errorMessage],
     ["error", "aborted", "cancelled"]);

  const failed = resultRow(BASE, { error: "check_failed", message: "Timed out after 60 seconds" });
  eq("error keeps its message", [failed.state, failed.errorMessage],
     ["error", "Timed out after 60 seconds"]);

  const bare = resultRow(BASE, { error: "no_url" });
  eq("message-less error falls back to the code", [bare.state, bare.errorMessage],
     ["error", "no_url"]);

  const found = resultRow(BASE, { ok: true, newChapters: ["12", "13"], total: 40 });
  eq("newChapters → found", [found.state, found.newChapters, found.total],
     ["found", ["12", "13"], 40]);

  const clean = resultRow(BASE, { ok: true, newChapters: [], total: 40 });
  eq("empty newChapters → uptodate", [clean.state, clean.total], ["uptodate", 40]);
  check("uptodate carries NO newChapters key", !("newChapters" in clean),
        `keys: ${Object.keys(clean).join(",")}`);

  check("identity fields survive every branch",
        [aborted, failed, found, clean].every(
          (r) => r.folderPath === BASE.folderPath && r.title === BASE.title &&
                 r.cover === BASE.cover && r.site === BASE.site && r.enqueuedAt === 1000
        ));

  // The no-inherit rule: re-deriving from the same base after a "found"
  // result must not smuggle newChapters into the new row.
  const second = resultRow(BASE, { ok: true, newChapters: [], total: 41 });
  check("found → uptodate does not leak newChapters", !("newChapters" in second));

  const nullish = resultRow(BASE, null);
  eq("a null result degrades to uptodate, not a crash", nullish.state, "uptodate");
}

// ── 1b. Crossed-out chapters ─────────────────────────────────────────────
// The user's per-chapter "×" writes .aio_series.json:chapters_ignored, and
// main.js splits those out of newChapters into ignoredChapters. Two rules the
// panel depends on, and they pull in opposite directions:
//   - they must NOT make a series "found" (nothing there is downloadable, so
//     the badge, the section count and "Queue all" would all overstate), yet
//   - they must still RIDE the uptodate row, because the undo lives on that
//     row and a fully-crossed-out series has nowhere else to offer it.
console.log("\n[1b] ignoredChapters");
{
  const mixed = resultRow(BASE, {
    ok: true, newChapters: ["12"], ignoredChapters: ["11.5"], total: 40,
  });
  eq("downloadable + crossed out → found",
     [mixed.state, mixed.newChapters, mixed.ignoredChapters],
     ["found", ["12"], ["11.5"]]);

  const allIgnored = resultRow(BASE, {
    ok: true, newChapters: [], ignoredChapters: ["11.5", "12"], total: 40,
  });
  eq("ONLY crossed out → uptodate, not found", allIgnored.state, "uptodate");
  eq("...but the crossed-out list survives so it can be undone",
     allIgnored.ignoredChapters, ["11.5", "12"]);
  check("...and it carries no newChapters", !("newChapters" in allIgnored));

  const none = resultRow(BASE, { ok: true, newChapters: [], ignoredChapters: [], total: 40 });
  check("an empty crossed-out list is omitted, not stored as []",
        !("ignoredChapters" in none), `keys: ${Object.keys(none).join(",")}`);

  const legacy = resultRow(BASE, { ok: true, newChapters: ["3"], total: 40 });
  check("a result with no ignoredChapters key at all is fine",
        !("ignoredChapters" in legacy) && legacy.state === "found");

  // The no-inherit rule again, for the second list: restoring every chapter
  // must not leave a stale ignoredChapters on the row.
  const restored = resultRow(BASE, { ok: true, newChapters: ["11.5", "12"], total: 40 });
  check("found → no crossed-out does not leak ignoredChapters",
        !("ignoredChapters" in restored));

  const failed = resultRow(BASE, { error: "check_failed", ignoredChapters: ["9"] });
  check("an errored row carries neither list",
        !("ignoredChapters" in failed) && !("newChapters" in failed));
}

// ── 2. Record lifecycle ──────────────────────────────────────────────────
console.log("\n[2] lifecycle");
{
  const { rec, sent } = makeRecord();
  check("no sweep yet → snapshot() is null", rec.snapshot() === null);
  check("no sweep yet → isRunning() false", rec.isRunning() === false);
  eq("no sweep yet → runId() 0", rec.runId(), 0);

  const a = rec.begin(3);
  eq("begin() hands back runId 1", a.runId, 1);
  check("begin() hands back a startedAt", typeof a.startedAt === "number" && a.startedAt > 0);
  check("begin() → isRunning()", rec.isRunning() === true);
  eq("fresh run snapshot", rec.snapshot().state, "running");
  eq("fresh run has no rows", rec.snapshot().rows.length, 0);
  eq("fresh run carries its total", rec.snapshot().total, 3);

  const queued = (n) => ({
    kind: "queued",
    row: { folderPath: `F${n}`, title: `T${n}`, cover: null, site: "s", state: "queued", enqueuedAt: 1000 },
    completed: 0,
    total: 3,
  });
  check("emit() reports it landed", rec.emit(a.runId, queued(1)) === true);
  rec.emit(a.runId, queued(2));
  rec.emit(a.runId, queued(3));
  eq("rows accumulate in emission order",
     rec.snapshot().rows.map((r) => r.folderPath), ["F1", "F2", "F3"]);
  eq("forwarded on the progress channel", sent.map((s) => s.channel),
     ["update-check-progress", "update-check-progress", "update-check-progress"]);
  eq("forwarded payload is stamped with runId", sent[0].payload.runId, 1);
  eq("forwarded payload keeps the event body", sent[0].payload.kind, "queued");

  rec.emit(a.runId, {
    kind: "completed",
    row: resultRow({ ...BASE, folderPath: "F2", enqueuedAt: 1000 }, { ok: true, newChapters: ["5"], total: 9 }),
    updatedMeta: { status: "Ongoing" },
    completed: 1,
    total: 3,
  });
  const mid = rec.snapshot();
  eq("a completed row REPLACES its queued row (no duplicate)", mid.rows.length, 3);
  eq("the replaced row keeps its slot", mid.rows.map((r) => r.folderPath), ["F1", "F2", "F3"]);
  eq("the replaced row is now found", mid.rows[1].state, "found");
  eq("progress folds in", [mid.completed, mid.total], [1, 3]);
  check("rowFor() reads the row back", rec.rowFor(a.runId, "F2").state === "found");
  check("rowFor() misses are null", rec.rowFor(a.runId, "nope") === null);

  rec.emit(a.runId, { kind: "done", completed: 3, total: 3, durationMs: 4200, aborted: false });
  const done = rec.snapshot();
  eq("done closes the run", done.state, "done");
  eq("done records duration", done.durationMs, 4200);
  eq("done records aborted:false", done.aborted, false);
  check("done → isRunning() false", rec.isRunning() === false);
  check("rows survive completion", done.rows.length === 3);

  rec.emit(a.runId, { kind: "done", completed: 3, total: 3, durationMs: 1, aborted: true });
  eq("a closed run still accepts its own late emissions", rec.snapshot().aborted, true);
}

// ── 3. Cancelled sweep ───────────────────────────────────────────────────
console.log("\n[3] cancel");
{
  const { rec } = makeRecord();
  const run = rec.begin(5);
  rec.emit(run.runId, { kind: "done", completed: 2, total: 5, durationMs: 900, aborted: true });
  const snap = rec.snapshot();
  eq("aborted flag reaches the snapshot", snap.aborted, true);
  eq("partial progress is preserved", [snap.completed, snap.total], [2, 5]);
  check("a cancelled sweep no longer blocks a new one", rec.isRunning() === false);
}

// ── 4. Supersede: the forced-rescan race ─────────────────────────────────
console.log("\n[4] supersede");
{
  const { rec, sent } = makeRecord();
  const a = rec.begin(2);
  rec.emit(a.runId, {
    kind: "queued",
    row: { folderPath: "OLD", title: "old", state: "queued", enqueuedAt: 1 },
    completed: 0, total: 2,
  });
  const sentAfterA = sent.length;

  const b = rec.begin(7);
  eq("a second begin() mints a new runId", b.runId, a.runId + 1);
  eq("the new run starts empty", rec.snapshot().rows.length, 0);
  eq("the new run carries its own total", rec.snapshot().total, 7);

  // Run A's workers are still unwinding: a late completed + its done.
  check("stale completed is refused", rec.emit(a.runId, {
    kind: "completed",
    row: { folderPath: "OLD", title: "old", state: "found", newChapters: ["1"], enqueuedAt: 1 },
    completed: 1, total: 2,
  }) === false);
  check("stale done is refused", rec.emit(a.runId, {
    kind: "done", completed: 2, total: 2, durationMs: 10, aborted: true,
  }) === false);

  eq("nothing stale was forwarded to the renderer", sent.length, sentAfterA);
  const snap = rec.snapshot();
  eq("stale rows never entered the new run", snap.rows.length, 0);
  eq("the new run is still running", snap.state, "running");
  eq("the new run's progress is untouched", [snap.completed, snap.total], [0, 7]);
  check("rowFor() on a stale runId is null", rec.rowFor(a.runId, "OLD") === null);
  check("the new run is what isRunning() reports", rec.isRunning() === true);

  // And the live run still works normally afterwards.
  check("the live run still accepts its own events", rec.emit(b.runId, {
    kind: "queued",
    row: { folderPath: "NEW", title: "new", state: "queued", enqueuedAt: 2 },
    completed: 0, total: 7,
  }) === true);
  eq("live rows land", rec.snapshot().rows.map((r) => r.folderPath), ["NEW"]);
}

// ── 5. Snapshot is a copy, not a handle ──────────────────────────────────
console.log("\n[5] snapshot isolation");
{
  const { rec } = makeRecord();
  const run = rec.begin(1);
  rec.emit(run.runId, {
    kind: "queued",
    row: { folderPath: "A", title: "a", state: "queued", enqueuedAt: 1 },
    completed: 0, total: 1,
  });
  const snap = rec.snapshot();
  snap.rows.push({ folderPath: "INJECTED" });
  snap.completed = 999;
  eq("mutating a snapshot cannot corrupt the record", rec.snapshot().rows.length, 1);
  eq("...including its counters", rec.snapshot().completed, 0);
}

console.log(
  failures === 0
    ? "\nAll update-check-record checks passed."
    : `\n${failures} check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
