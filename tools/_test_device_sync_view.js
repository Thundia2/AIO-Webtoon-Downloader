// Offline test for UI-source/src/components/sync/syncView.js — the Sync
// tab's pure view model (UI pass U2).
// Run: node tools/_test_device_sync_view.js   (from anywhere)
//
// Bundles the REAL module with esbuild (UI-source/node_modules; `@` aliased
// to src like vite.config.js) into a temp ESM file and imports it. Inputs
// are the recorded fixtures (src/dev/sync-fixtures/tab.json, written off the
// real planner by tools/_gen_sync_fixtures.js) wherever one exists, so a
// planner shape change shows up here as well as in the gallery.
//
// What it pins:
//   - the row box (null / off / on / mixed) and what a click on it sends
//     (bulk series off when anything is ticked; on only when the plan had a
//     pre-selection; otherwise open the detail)
//   - tiles, the ledger split (held last, by name), sort + filter, dock totals
//   - settle countdown, throughput / ETA, the running-job classifier
//   - target status + picker order, last-run cards for every outcome
//   - lane fills across series, the Review gate's every reason, the apply
//     payload (loss op ids, mass acks only when required)
//   - detail grouping + group changes, cover/path indexes, chapter labels

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const UI = path.join(ROOT, "UI-source");
const esbuild = require(path.join(UI, "node_modules", "esbuild"));
const TAB = require(path.join(UI, "src", "dev", "sync-fixtures", "tab.json")).data;

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
  check(label, a === e, `got ${a}, want ${e}`);
}

(async () => {
  const out = path.join(os.tmpdir(), `aio-syncview-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(UI, "src", "components", "sync", "syncView.js")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: out,
    alias: { "@": path.join(UI, "src") },
    logLevel: "error",
  });
  const V = await import(pathToFileURL(out).href);
  fs.rmSync(out, { force: true });

  const planned = Object.values(TAB.snapshots.planned.plans)[0];
  const S = planned.summary;
  const row = (k) => S.series.find((r) => r.seriesKey === k);

  // ── Row box + click ──
  const mk = (counts, strip = [], state = "bound") => ({ seriesKey: "pc:X", state, counts: { offered: 0, preselected: 0, ...counts }, strip });
  eq("box: nothing offered → no box", V.rowView(mk({})).box, null);
  eq("box: offered, none ticked → off", V.rowView(mk({ offered: 3 })).box, false);
  eq("box: all ticked → on", V.rowView(mk({ offered: 3, push: 3 })).box, true);
  eq("box: some → mixed", V.rowView(mk({ offered: 3, push: 1 })).box, "mixed");
  eq("click ticked → series off", V.rowToggle(mk({ offered: 3, push: 1 })), { bulk: "series", seriesKey: "pc:X", selected: false });
  eq("click off with a pre-selection → back on", V.rowToggle(mk({ offered: 3, preselected: 2 })), { bulk: "series", seriesKey: "pc:X", selected: true });
  eq("click off, nothing pre-selected → open detail", V.rowToggle(mk({ offered: 1 })), { openDetail: true });
  eq("click with no box → nothing", V.rowToggle(mk({})), null);
  eq("warn pill = warn segment count", V.rowView(mk({ offered: 2 }, [{ state: "warn", count: 2 }, { state: "absent", count: 5 }])).warn, 2);
  // Recorded: Eleceed's replace is unticked by the plan (mixed), Dungeon
  // Meshi's loss removal is off with nothing pre-selected (opens detail).
  eq("recorded Eleceed box", V.rowView(row("pc:Eleceed")).box, "mixed");
  eq("recorded Dungeon Meshi click opens detail", V.rowToggle(row("pc:Dungeon Meshi")), { openDetail: true });
  check("recorded Eleceed attention names the unticked replace", V.rowView(row("pc:Eleceed")).attention.includes("replace-unticked"));

  // ── Tiles, ledger, dock ──
  const tiles = V.tileCounts(S);
  eq("tile push = push+update+replace totals", tiles.push.n, S.totals.push.count + S.totals.update.count + S.totals.replace.count);
  eq("tile delete", tiles.delete.n, S.totals.delete.count);
  eq("tile only = device-only folders", tiles.only.n, S.deviceOnly.length);
  eq("tile attn = rows with attention", tiles.attn.n, S.series.filter((r) => r.attention.length).length);
  const lr = V.ledgerRows(S, {});
  eq("held rows go last, by name", lr.held.map((r) => r.title), ["Blue Lock", "Tower of God"]);
  check("active rows exclude held", lr.active.every((r) => r.state !== "held"));
  const writes = lr.active.map((r) => V.rowView(r).writes);
  check("sort copy: most writes first", writes.every((w, i) => i === 0 || writes[i - 1] >= w), JSON.stringify(writes));
  eq("sort name", V.ledgerRows(S, { sort: "name" }).active.map((r) => r.title), lr.active.map((r) => r.title).sort((a, b) => a.localeCompare(b)));
  eq("filter matches title, case-insensitive", V.ledgerRows(S, { query: "  eLEce " }).active.map((r) => r.title), ["Eleceed"]);
  eq("tile only hides every series row", V.ledgerRows(S, { tile: "only" }), { active: [], held: [] });
  check("tile delete keeps only rows removing something", V.ledgerRows(S, { tile: "delete" }).active.every((r) => V.rowView(r).deletes > 0));
  const dock = V.dockTotals(S);
  eq("dock totals", [dock.files, dock.bytes, dock.removals], [S.totals.files, S.totals.bytes, S.totals.delete.count]);

  // ── Settle, throughput, jobs ──
  const settling = { settleAt: 10_000, series: [{ title: "A", counts: { settling: 2 } }] };
  eq("settle ahead", V.settleInfo(settling, 1_000), { seconds: 9, chapters: 2, titles: ["A"] });
  eq("settle passed → null", V.settleInfo(settling, 10_000), null);
  eq("settle with nothing settling → null", V.settleInfo({ settleAt: 10_000, series: [] }, 0), null);
  eq("settle line", V.settleLine({ seconds: 9, chapters: 1, titles: ["A"] }), "1 chapter of A is still downloading. They join the plan in 9 s.");
  eq("throughput over the window", V.throughput([{ at: 0, bytes: 0 }, { at: 1000, bytes: 500 }, { at: 2000, bytes: 1500 }]), 750);
  eq("throughput needs 500 ms", V.throughput([{ at: 0, bytes: 0 }, { at: 100, bytes: 9 }]), null);
  eq("eta", V.etaMs({ bytesTotal: 1000, bytesDone: 250 }, 250), 3000);
  eq("eta without a rate", V.etaMs({ bytesTotal: 1000 }, null), null);
  const job = (phase, targetId = "t1", state = "running") => ({ phase, targetId, state });
  eq("apply writes", V.jobOn(job("apply"), "t1").writing, true);
  eq("verify plans, doesn't write", [V.jobOn(job("verify"), "t1").writing, V.jobOn(job("verify"), "t1").planning], [false, true]);
  eq("other target's job → null", V.jobOn(job("apply", "t2"), "t1"), null);
  eq("finished job → null", V.jobOn(job("apply", "t1", "done"), "t1"), null);

  // ── Targets ──
  const folder = { id: "f", kind: "folder" };
  const tab = { id: "a", kind: "adb", serial: "S1" };
  eq("folder present", V.targetStatus(folder, [], { f: true }).connected, true);
  eq("folder missing label", V.targetStatus(folder, [], { f: false }).label, "Folder not found");
  eq("adb unplugged", V.targetStatus(tab, [], {}).connected, false);
  eq("adb device", V.targetStatus(tab, [{ serial: "S1", state: "device" }], {}).connected, true);
  eq("adb unauthorized isn't connected", V.targetStatus(tab, [{ serial: "S1", stateKind: "unauthorized" }], {}).connected, false);
  eq("picker: connected first, else config order", V.pickTargets([tab, folder], [], { f: true }).map((x) => x.target.id), ["f", "a"]);

  // ── Last-run cards ──
  const after = Object.values(TAB.snapshots.afterApply.plans)[0].lastRun;
  const lv = V.lastRunView(after, "Tab");
  eq("recorded apply card", [lv.tone, lv.title, lv.line], ["ok", "Synced to Tab", "20 files · 61 KB copied · 13 removed"]);
  const run = (status, summary, phase) => V.lastRunView({ runId: 1, phase, status, at: 0, summary }, "Tab", (k) => k.replace("pc:", "") + "!");
  eq("cancelled", [run("cancelled", { filesDone: 2, filesTotal: 5 }).tone, run("cancelled", { filesDone: 2, filesTotal: 5 }).title], ["muted", "Sync cancelled"]);
  eq("disconnected offers re-check", run("disconnected", {}).action, "recheck");
  eq("no-space offers free-up", run("failed", { reason: "no-space" }).action, "recheck-space");
  eq("failure names the first failed file", run("failed", { reason: "error-budget", failed: [{ folder: "F", name: "n.cbz" }] }).line, "Too many files failed at F / n.cbz");
  check("refused start carries the refusal", run("failed", { refusal: { code: "blocked", blocking: [] } }).refusal.code === "blocked");
  eq("skipped series named through titleOf", run("completed", { skippedSeries: [{ seriesKey: "pc:A", reason: "folder-reappeared" }] }).skipped, ["1 series skipped: A! (its folder came back on the target meanwhile)"]);
  eq("prune card", run("completed", { prune: { removed: 2 } }, "prune").line, "2 folders removed");

  // ── Lanes ──
  let r1 = V.laneFills({ runId: 7, state: "running", phase: "apply", progress: { lane: { seriesKey: "A", landed: 1, total: 4 } } }, null);
  eq("current lane fill", r1.fills, { A: 25 });
  r1 = V.laneFills({ runId: 7, state: "running", phase: "apply", progress: { lane: { seriesKey: "B", landed: 0, total: 2 } } }, r1.memo);
  eq("a left lane stays full", r1.fills, { B: 0, A: 100 });
  eq("a new run resets", V.laneFills({ runId: 8, state: "running", phase: "apply", progress: {} }, r1.memo).fills, {});
  eq("not an apply → no lanes", V.laneFills({ runId: 8, state: "running", phase: "verify" }, null).fills, {});

  // ── Review gate + payload (recorded reviews) ──
  const rv = TAB.review;
  const rl = TAB.reviewWithLoss;
  const gate = (review, acks, o) => V.reviewGate(review, acks, { settled: true, viewGen: review.gen, ...o });
  check("recorded review needs a mass-delete ack", rv.massDelete.required);
  eq("unacked → acks", gate(rv, {}).why, "acks");
  eq("acked → can start", gate(rv, { massDelete: rv.massDelete.count }).canStart, true);
  eq("an ack for a stale count doesn't count", gate(rv, { massDelete: rv.massDelete.count - 1 }).why, "acks");
  eq("stale", gate(rv, {}, { stale: true }).why, "stale");
  eq("busy", gate(rv, {}, { busy: true }).why, "busy");
  eq("saving", gate(rv, {}, { settled: false }).why, "saving");
  eq("changed gen", gate(rv, {}, { viewGen: rv.gen + 1 }).why, "changed");
  eq("doesn't fit", gate({ ...rv, capacity: { ...rv.capacity, fits: false } }, {}).why, "space");
  eq("nothing selected", gate({ ...rv, totals: { files: 0, delete: { count: 0 } } }, {}).why, "empty");
  check("recorded loss review has one loss series", rl.losses.length === 1);
  eq("loss counts as one confirmation", gate(rl, { massDelete: rl.massDelete.count }).left, 1);
  const lossKey = rl.losses[0].seriesKey;
  eq("payload: loss op ids + mass ack", V.applyPayload("t", rl, { losses: new Set([lossKey]), massDelete: rl.massDelete.count }), {
    targetId: "t",
    gen: rl.gen,
    ackLosses: rl.losses[0].lossOpIds,
    ackMassDelete: rl.massDelete.count,
  });
  eq("payload: no mass acks when not required", V.applyPayload("t", { gen: 1, losses: [], massDelete: { required: false } }, { massDelete: 3 }), { targetId: "t", gen: 1, ackLosses: [] });
  eq("loading", V.reviewGate(null, {}).why, "loading");

  // ── Detail ──
  const d = TAB.details["pc:Eleceed"];
  const groups = V.detailGroups(d.rows);
  eq("recorded Eleceed groups in display order", groups.map((g) => g.id), ["push", "delete", "in-sync"]);
  check("removals open, the rest closed", groups.find((g) => g.id === "delete").open && !groups.find((g) => g.id === "push").open && !groups.find((g) => g.id === "in-sync").open);
  eq("in-sync has no box", groups.find((g) => g.id === "in-sync").box, null);
  const push = groups.find((g) => g.id === "push");
  eq("group off sends only the ticked ops", V.groupChanges(push, false).length, push.rows.filter((r) => r.selected).length);
  check("a loss opens its group", V.detailGroups([{ kind: "push", opId: "o", loss: true }])[0].open);

  // ── Indexes, paths, labels ──
  const entries = [{ folderPath: "D:\\lib\\Eleceed", thumbPath: "D:\\c.jpg" }, { folderPath: "/lib/Frieren/" }];
  eq("cover index by folder name", [...V.coverIndex(entries)], [["Eleceed", "D:\\c.jpg"]]);
  eq("path index handles both separators", [...V.pcPathIndex(entries).keys()], ["Eleceed", "Frieren"]);
  eq("adb path stays POSIX", V.seriesPathLine({ folder: "E", deviceFolder: "E", pcPath: "D:\\lib\\E", root: "/sdcard/Komikku/", tn: "T" }), "D:\\lib\\E → /sdcard/Komikku/E");
  eq("folder target stays native", V.seriesPathLine({ folder: "E", deviceFolder: "E2", root: "E:\\Tablet\\", tn: "T" }), "E → E:\\Tablet\\E2");
  eq("not on the target yet", V.seriesPathLine({ folder: "E", tn: "T" }), "E → (not on T yet)");
  eq("chapter labels", ["7", "10.5", "-1", "Vol.2", "", null].map(V.chLabel), ["Ch.007", "Ch.010.5", "Ch.-001", "Vol.2", "", ""]);

  // ── Segment colour classes (ChapterStrip.jsx SEG_CLASS) ──
  // Tailwind keeps a globals.css utility only when src spells its full name,
  // so every strip state needs a literal class and nothing may build one.
  const stripSrc = fs.readFileSync(path.join(UI, "src", "components", "sync", "ChapterStrip.jsx"), "utf8");
  const segKeys = [...((stripSrc.match(/SEG_CLASS = Object\.freeze\(\{([\s\S]*?)\}\)/) || [])[1] || "").matchAll(/(\w+):\s*"sync-seg sync-seg-(\w+)"/g)];
  check("SEG_CLASS spells each class after its own key", segKeys.length > 0 && segKeys.every((m) => m[1] === m[2]), JSON.stringify(segKeys.map((m) => m.slice(1))));
  const copySrc = fs.readFileSync(path.join(UI, "src", "components", "sync", "copy.js"), "utf8");
  const stripStates = [...((copySrc.match(/STRIP_STATE_COPY = Object\.freeze\(\{([\s\S]*?)\}\)/) || [])[1] || "").matchAll(/^\s*"?(\w+)"?:/gm)].map((m) => m[1]);
  eq("SEG_CLASS covers every strip state", segKeys.map((m) => m[1]).sort(), [...stripStates].sort());
  const built = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(e.name) && /sync-seg-\$\{/.test(fs.readFileSync(p, "utf8"))) built.push(path.relative(UI, p));
    }
  };
  walk(path.join(UI, "src"));
  eq("no built sync-seg-${…} class names in src", built, []);

  if (failures) {
    console.error(`\n${failures} view check(s) failed`);
    process.exit(1);
  }
  console.log("\nall view checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
