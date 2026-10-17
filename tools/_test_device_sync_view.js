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
//   - U4: the Library chip / Sync line / Open in Sync target (libraryView.js)
//     and the find-sources rows, Linked, queue args and status (findView.js)

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
  // Tower of God is the recorded "Remove from <target>" series: held
  // `excluded` by the planner but with removals pending, so it stays in the
  // main list (U2-12, review low "removing series sorted into dimmed").
  eq("held rows go last, by name", lr.held.map((r) => r.title), ["Blue Lock"]);
  check("active rows exclude held, except a series being removed", lr.active.every((r) => r.state !== "held" || r.removing));
  check("the removing series is in the main list", lr.active.some((r) => r.title === "Tower of God" && r.removing));
  const writes = lr.active.map((r) => V.rowView(r).writes);
  check("sort copy: most writes first", writes.every((w, i) => i === 0 || writes[i - 1] >= w), JSON.stringify(writes));
  eq("sort name", V.ledgerRows(S, { sort: "name" }).active.map((r) => r.title), lr.active.map((r) => r.title).sort((a, b) => a.localeCompare(b)));
  eq("filter matches title, case-insensitive", V.ledgerRows(S, { query: "  eLEce " }).active.map((r) => r.title), ["Eleceed"]);
  eq("tile only hides every series row", V.ledgerRows(S, { tile: "only" }), { active: [], held: [] });
  check("tile delete keeps only rows removing something", V.ledgerRows(S, { tile: "delete" }).active.every((r) => V.rowView(r).deletes > 0));
  const dock = V.dockTotals(S);
  eq("dock totals", [dock.files, dock.bytes, dock.removals], [S.totals.files, S.totals.bytes, S.totals.delete.count]);
  eq("dock counts renames (R5)", V.dockTotals({ totals: { files: 0, rename: { count: 2 } }, series: [] }).renames, 2);
  eq("work counts files, removals and renames", V.workCount({ files: 1, delete: { count: 2 }, rename: { count: 3 } }), 6);

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
  // executor.js verify counts series folders in filesDone.
  eq("verify card counts series", [run("completed", { filesDone: 1 }, "verify").line, run("completed", { filesDone: 24 }, "verify").line], ["1 series checked", "24 series checked"]);

  // ── Average-rate time left (the loading screen's read-back line) ──
  const smp = (at, bytes) => ({ at, bytes });
  eq("eta: needs 3 samples over 15 s", [V.averageEta([smp(0, 0), smp(20000, 10)], { bytesTotal: 100, bytesDone: 10 }), V.averageEta([smp(0, 0), smp(5000, 5), smp(10000, 10)], { bytesTotal: 100, bytesDone: 10 })], [null, null]);
  eq("eta: average rate over the step", V.averageEta([smp(0, 0), smp(10000, 5), smp(20000, 10)], { bytesTotal: 100, bytesDone: 10 }), 180000);
  eq("eta: no movement or no total → null", [V.averageEta([smp(0, 5), smp(10000, 5), smp(20000, 5)], { bytesTotal: 100, bytesDone: 5 }), V.averageEta([smp(0, 0), smp(10000, 5), smp(20000, 10)], { bytesTotal: 0 })], [null, null]);
  eq("eta: done → 0", V.averageEta([smp(0, 0), smp(10000, 50), smp(20000, 100)], { bytesTotal: 100, bytesDone: 100 }), 0);

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
  eq("a rename-only selection can start (R5)", gate({ ...rv, massDelete: { required: false }, totals: { files: 0, delete: { count: 0 }, rename: { count: 1 } } }, {}).why, null);
  eq("review behind the latest selection → changed (R6)", gate({ ...rv, selSeq: 3 }, {}, { viewSelSeq: 4 }).why, "changed");
  eq("undismissed plan-changed notice blocks (R7)", gate(rv, { massDelete: rv.massDelete.count }, { changedNotice: true }).why, "notice");
  check("recorded review carries selSeq (null before any change)", "selSeq" in rv, "re-run tools/_gen_sync_fixtures.js");
  check("recorded loss review has one loss series", rl.losses.length === 1);
  eq("loss counts as one confirmation", gate(rl, { massDelete: rl.massDelete.count }).left, 1);
  const loss = rl.losses[0];
  const ticked = { losses: new Map([[loss.seriesKey, V.lossSig(loss.lossOpIds)]]), massDelete: rl.massDelete.count };
  eq("a tick over the current loss ids counts", gate(rl, ticked).left, 0);
  // R3: a selection change that adds a loss to the ticked series re-opens it.
  const grown = { ...rl, losses: [{ ...loss, lossOpIds: [...loss.lossOpIds, "delete:X/new.cbz"] }] };
  eq("a tick doesn't cover a loss added after it", gate(grown, ticked).left, 1);
  eq("payload: a stale tick sends no loss ids", V.applyPayload("t", grown, ticked).ackLosses, []);
  eq("payload: loss op ids + mass ack", V.applyPayload("t", rl, ticked), {
    targetId: "t",
    gen: rl.gen,
    ackLosses: loss.lossOpIds,
    selSeq: rl.selSeq,
    ackMassDelete: rl.massDelete.count,
  });
  eq("payload: no mass acks when not required", V.applyPayload("t", { gen: 1, losses: [], massDelete: { required: false } }, { massDelete: 3 }), { targetId: "t", gen: 1, ackLosses: [] });
  eq("payload: a null selSeq is still sent", V.applyPayload("t", { gen: 1, selSeq: null, losses: [] }, {}).selSeq, null);
  eq("loading", V.reviewGate(null, {}).why, "loading");
  // reviewSig: a re-plan that only moves gen/asOf/selSeq asks nothing new.
  eq("sig ignores gen, asOf, selSeq", V.reviewSig({ ...rl, gen: rl.gen + 1, asOf: 1, selSeq: 99 }), V.reviewSig(rl));
  const flipped = { ...rl, groups: rl.groups.map((g, i) => (i ? g : { ...g, ops: g.ops.map((o, j) => (j ? o : { ...o, selected: !o.selected })) })) };
  check("sig sees a changed tick", V.reviewSig(flipped) !== V.reviewSig(rl));
  check("sig sees a grown loss", V.reviewSig(grown) !== V.reviewSig(rl));
  eq("sig of a refusal is null", V.reviewSig({ ok: false }), null);

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
  // ── Connect cards + rail badge (connectView.js, UI pass U3) ──
  const out2 = path.join(os.tmpdir(), `aio-connectview-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(UI, "src", "components", "sync", "connectView.js")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: out2,
    alias: { "@": path.join(UI, "src") },
    logLevel: "error",
  });
  const C = await import(pathToFileURL(out2).href);
  fs.rmSync(out2, { force: true });
  {
    // The first read-back (executor.js verify): series + byte progress.
    const vj = (progress) => ({ runId: 3, state: "running", phase: "plan", targetId: "a", progress: { step: "verify", ...progress } });
    const w = C.workLine(vj({ filesDone: 24, filesTotal: 130, bytesDone: 50, bytesTotal: 200, current: { folder: "Blue Lock" } }), "a");
    eq("read-back line: series and byte %", [w.text, w.pct, w.current], ["Reading back what's already there (24 of 130 series, 25%)", 25, "Blue Lock"]);
    const w0 = C.workLine(vj({ filesDone: 1, filesTotal: 4, bytesDone: 0, bytesTotal: 0 }), "a");
    eq("read-back line: no bytes → series %", [w0.text, w0.pct], ["Reading back what's already there (1 of 4 series, 25%)", 25]);
    eq("read-back line before any count", C.workLine(vj({}), "a").text, "Reading back what's already there");
    eq("another target's job → no line", C.workLine(vj({ filesTotal: 2 }), "b"), null);
  }
  {
    const T0 = 1_000_000;
    const tgt = (id, extra = {}) => ({ id, name: id === "a" ? "Tab" : "Folder", kind: "folder", root: "/x", ...extra });
    const live = { ...S, gen: 5 };
    const frozen = { targetId: "a", gen: 5, series: 9, files: 452, bytes: 6.8e9, deletions: 4, renames: 0, losses: 0, verifyFolders: 0, nothingToDo: false };
    const prompt = (card, ids = ["a"]) => ({ promptId: "p1", connKey: "folder:a", serial: null, targetIds: ids, card, createdAt: T0 });
    const base = { targets: [tgt("a")], devices: [], plans: {}, job: null, now: T0, pending: [], prompts: [] };

    // Frozen card until the live plan arrives; then the live one (gen floor).
    let r = C.connectCards({ ...base, prompts: [prompt({ targets: [frozen], attention: [] })] });
    eq("card: frozen numbers before the plan push", [r.cards[0].title, r.cards[0].rows[0].v, r.cards[0].primary.label], ["Tab connected", "452 chapters in 9 series", "Review"]);
    check("card: deletions get the Review note", /4 files would be removed/.test(r.cards[0].note || ""), r.cards[0].note);
    const liveFiles = live.totals.files;
    r = C.connectCards({ ...base, prompts: [prompt({ targets: [frozen], attention: [] })], plans: { a: { summary: live } } });
    check("card: live summary at the card's gen wins", r.cards[0].rows[0].v.startsWith(`${liveFiles} chapter`), r.cards[0].rows[0].v);
    r = C.connectCards({ ...base, prompts: [prompt({ targets: [frozen], attention: [] })], plans: { a: { summary: { ...live, gen: 4 } } } });
    eq("card: an older live summary than the card is ignored", r.cards[0].rows[0].v, "452 chapters in 9 series");

    // needs-mode → Set up with the bytes; the card follows the read-back job.
    const att = { targetId: "a", targetName: "Tab", code: "needs-mode", firstSync: true, folders: ["A", "B"], bytes: 9.4e9 };
    r = C.connectCards({ ...base, prompts: [prompt({ targets: [], attention: [att] })] });
    eq("card: first sync → Set up (reads ~N)", [r.cards[0].title, r.cards[0].primary.action, r.cards[0].primary.label, r.cards[0].rows[0].v], ["Tab is new here", "setup", "Set up (reads ~9.4 GB)", "2 folders already on it"]);
    r = C.connectCards({ ...base, prompts: [prompt({ targets: [], attention: [{ ...att, firstSync: false }] })] });
    eq("card: a non-first needs-mode says Check", r.cards[0].primary.label, "Check (reads ~9.4 GB)");
    const verifying = { state: "running", runId: 3, phase: "plan", auto: true, targetId: "a", progress: { step: "verify", filesDone: 31, filesTotal: 50 } };
    r = C.connectCards({ ...base, prompts: [prompt({ targets: [], attention: [att] })], job: verifying });
    eq("card: Set up's re-plan shows the read-back progress", [r.cards[0].body, r.cards[0].progress, r.cards[0].primary], ["Reading back what's already there (31 of 50 series, 62%)", 62, null]);
    r = C.connectCards({ ...base, prompts: [prompt({ targets: [], attention: [att] })], plans: { a: { summary: live } } });
    check("card: after the read-back the live plan makes it ready", r.cards[0].primary && r.cards[0].primary.label === "Review", JSON.stringify(r.cards[0].primary));

    // Other refusals and failures: attention, Open Sync.
    r = C.connectCards({ ...base, prompts: [prompt({ targets: [], attention: [{ targetId: "a", code: "device-listing-suspect" }] })] });
    eq("card: a refusal → attention + Open Sync", [r.cards[0].tone, r.cards[0].primary.label, r.cards[0].body], ["bad", "Open Sync", "Tab listed far fewer files than expected"]);

    // Two targets: one row each; Review lands on the one with changes.
    const two = { ...base, targets: [tgt("a"), tgt("b")] };
    r = C.connectCards({ ...two, prompts: [prompt({ targets: [frozen], attention: [{ targetId: "b", code: "record-mismatch" }] }, ["a", "b"])] });
    eq("card: two targets → a row each, warn on the refused one", r.cards[0].rows.map((x) => [x.k, !!x.warn]), [["Tab", false], ["Folder", true]]);
    eq("card: Review lands on the target with changes", r.cards[0].primary, { action: "review", targetId: "a", label: "Review" });

    // Preparing: only after the grace, with the job's step.
    const pd = { promptId: "p2", connKey: "folder:a", serial: null, targetIds: ["a"], since: T0 };
    eq("preparing: hidden inside the grace", C.connectCards({ ...base, pending: [pd], now: T0 + 500 }).cards.length, 0);
    r = C.connectCards({ ...base, pending: [pd], now: T0 + C.PREPARE_GRACE_MS, job: { ...verifying, progress: { step: "hashing", filesDone: 1, filesTotal: 4 } } });
    eq("preparing: after the grace, with progress", [r.cards[0].kind, r.cards[0].body, r.cards[0].progress], ["preparing", "Preparing: fingerprinting PC files (25%)", 25]);

    // Tablet cards: configured tablets only; spinners wait out the grace.
    const adbBase = { ...base, targets: [tgt("a", { kind: "adb", serial: "S1" })] };
    const dev = (stateKind) => ({ serial: "S1", state: stateKind === "no-permissions" ? "unauthorized" : stateKind, stateKind, model: "SM_X710" });
    r = C.connectCards({ ...adbBase, devices: [dev("unauthorized")] });
    eq("tablet: unauthorized → red card + I've allowed it", [r.cards[0].tone, r.cards[0].title, r.cards[0].primary.label], ["bad", "Tab needs permission", "I've allowed it"]);
    r = C.connectCards({ ...adbBase, devices: [dev("no-permissions")] });
    eq("tablet: no-permissions → Re-check", [r.cards[0].title, r.cards[0].primary.label], ["Tab can't be reached", "Re-check"]);
    eq("tablet: an unconfigured tablet gets no card", C.connectCards({ ...base, devices: [dev("unauthorized")] }).cards.length, 0);
    eq("tablet: prompt-on-connect off → no tablet card", C.connectCards({ ...adbBase, devices: [dev("unauthorized")], promptOnConnect: false }).cards.length, 0);
    eq("tablet: dismissed per serial + state", C.connectCards({ ...adbBase, devices: [dev("unauthorized")], dismissedDevices: new Set(["dev:S1:unauthorized"]) }).cards.length, 0);
    eq("tablet: connecting inside the grace → nothing", C.connectCards({ ...adbBase, devices: [dev("connecting")], deviceSince: { "dev:S1:connecting": T0 - 100 } }).cards.length, 0);
    r = C.connectCards({ ...adbBase, devices: [dev("authorizing")], deviceSince: { "dev:S1:authorizing": T0 - 5000 } });
    eq("tablet: authorizing past the grace → spinner", r.cards[0].spinner, "Waiting for you to allow USB debugging on the tablet…");

    // The Sync tab's own target hides its cards; stacking caps at MAX_CARDS.
    eq("hidden: the target the Sync tab shows", C.connectCards({ ...base, prompts: [prompt({ targets: [frozen], attention: [] })], hiddenTargetId: "a" }).cards.length, 0);
    const many = ["p1", "p2", "p3"].map((id, i) => ({ ...prompt({ targets: [frozen], attention: [] }), promptId: id, createdAt: T0 + i }));
    r = C.connectCards({ ...base, prompts: many });
    eq("stack: two cards and +1 more", [r.cards.length, r.more], [2, 1]);

    // Rail badge.
    const conn = { targets: [tgt("a")], folderPresence: { a: true }, devices: [], job: null, dismissed: {} };
    const sel = S.series.filter((x) => V.rowView(x).selected > 0).length;
    check("rail: the fixture has ticked series", sel > 0, String(sel));
    eq("rail: count = series with ticked changes on connected targets", C.railBadge({ ...conn, plans: { a: { summary: S } } }), { count: sel, dot: null });
    eq("rail: a disconnected target doesn't count", C.railBadge({ ...conn, folderPresence: { a: false }, plans: { a: { summary: S } } }).count, 0);
    eq("rail: a stale summary still counts", C.railBadge({ ...conn, plans: { a: { summary: S, stale: true } } }).count, sel);
    eq("rail: an automatic plan doesn't pulse", C.railBadge({ ...conn, plans: {}, job: { state: "running", phase: "plan", auto: true } }).dot, null);
    eq("rail: a user's job pulses", C.railBadge({ ...conn, plans: {}, job: { state: "running", phase: "plan", auto: false } }).dot, "pulse");
    eq("rail: a refusal is red (and beats the pulse)", C.railBadge({ ...conn, plans: { a: { refusal: { code: "record-mismatch" } } }, job: { state: "running", phase: "apply" } }).dot, "red");
    eq("rail: needs-mode is a question, not red", C.railBadge({ ...conn, plans: { a: { refusal: { code: "needs-mode" } } } }).dot, null);
    const failedRun = { runId: 7, phase: "apply", status: "failed", summary: { reason: "no-space" } };
    eq("rail: a failed last run is red", C.railBadge({ ...conn, plans: { a: { lastRun: failedRun } } }).dot, "red");
    eq("rail: …until dismissed", C.railBadge({ ...conn, plans: { a: { lastRun: failedRun } }, dismissed: { a: 7 } }).dot, null);
    eq("rail: a plan-changed block isn't red", C.railBadge({ ...conn, plans: { a: { lastRun: { ...failedRun, summary: { refusal: { code: "blocked", blocking: [{ kind: "plan-changed" }] } } } } } }).dot, null);
    eq("rail: an unauthorized configured tablet is red", C.railBadge({ ...conn, targets: [tgt("a", { kind: "adb", serial: "S1" })], devices: [dev("unauthorized")], plans: {} }).dot, "red");
    eq("rail: 99+", [C.badgeText(99), C.badgeText(100)], ["99", "99+"]);
  }

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

  // ── Library chip + find sources (libraryView.js / findView.js, UI pass U4) ──
  const bundle = async (name) => {
    const o = path.join(os.tmpdir(), `aio-${name}-${process.pid}.mjs`);
    await esbuild.build({ entryPoints: [path.join(UI, "src", "components", "sync", `${name}.js`)], bundle: true, format: "esm", platform: "neutral", outfile: o, alias: { "@": path.join(UI, "src") }, logLevel: "error" });
    const m = await import(pathToFileURL(o).href);
    fs.rmSync(o, { force: true });
    return m;
  };
  {
    const L = await bundle("libraryView");
    const targets = [
      { id: "a", name: "Galaxy Tab S9", kind: "adb" },
      { id: "b", name: "Komikku folder", kind: "folder" },
    ];
    eq("seriesKey from a Windows path", L.librarySeriesKey("D:\\AIO\\manga\\Eleceed"), "pc:Eleceed");
    eq("seriesKey from a posix path", L.librarySeriesKey("/x/manga/Solo Leveling/"), "pc:Solo Leveling");
    eq("no rows → no chip (not mirrored)", L.seriesSyncChip(undefined, targets), null);
    eq("rows only for removed targets → no chip", L.seriesSyncChip([{ targetId: "zz", state: "pending", pending: 4 }], targets), null);
    const mixed = [
      { targetId: "b", state: "synced", pending: 0 },
      { targetId: "a", state: "pending", pending: 15 },
    ];
    const chip = L.seriesSyncChip(mixed, targets);
    eq("count = most missing among targets holding it", [chip.kind, chip.n], ["count", 15]);
    check("tooltip names each target", /Galaxy Tab S9: 15 to copy/.test(chip.tip) && /Komikku folder: in sync/.test(chip.tip), chip.tip);
    eq("removed counts as present", L.seriesSyncChip([{ targetId: "a", state: "removed", pending: 3 }], targets).n, 3);
    eq("synced + absent → check", L.seriesSyncChip([{ targetId: "a", state: "synced", pending: 0 }, { targetId: "b", state: "absent", pending: 9 }], targets).kind, "ok");
    eq("absent everywhere → dim", L.seriesSyncChip([{ targetId: "a", state: "absent", pending: 9 }], targets).kind, "dim");
    eq(
      "lines in config order with tones",
      L.seriesSyncLines(mixed, targets).map((l) => [l.name, l.kind, l.text, l.tone]),
      [["Galaxy Tab S9", "tablet", "15 to copy", "push"], ["Komikku folder", "folder", "in sync", "ok"]],
    );
    eq("Open in Sync → first target with chapters to copy", L.openInSyncTarget([{ targetId: "a", state: "synced" }, { targetId: "b", state: "pending", pending: 1 }], targets), "b");
    eq("Open in Sync → else the first", L.openInSyncTarget([{ targetId: "b", state: "absent" }, { targetId: "a", state: "synced" }], targets), "a");
    eq("Open in Sync with no rows", L.openInSyncTarget(null, targets), null);
  }
  {
    const F = await bundle("findView");
    const items = [
      { key: "dev:Dungeon Meshi", name: "Dungeon Meshi", query: "Dungeon Meshi" },
      { key: "dev:Hunter_x_Hunter", name: "Hunter_x_Hunter", query: "Hunter x Hunter" },
      { key: "dev:SHELTER", name: "SHELTER", query: "SHELTER" },
      { key: "dev:Linked", name: "Linked", query: "Linked" },
      { key: "dev:New", name: "New", query: "New" },
    ];
    const cand = (site, url, rating, basis) => {
      const best = { site, url, title: site, rating, chapters: 97, qualityBasis: basis };
      return { title: site, best, sources: [best] };
    };
    const rows = {
      "Dungeon Meshi": { folder: "Dungeon Meshi", query: "Dungeon Meshi", state: "done", candidates: [cand("mangadex", "https://a/1", 0.92, "chapter_probe"), cand("weeb", "https://b/2", 0.5, "seed")], pickUrl: "https://b/2", pinnedUrl: null, skip: false },
      Hunter_x_Hunter: { folder: "Hunter_x_Hunter", query: "HxH", state: "done", candidates: [], pickUrl: null, pinnedUrl: "https://pin/x", skip: false },
      SHELTER: { folder: "SHELTER", query: "SHELTER", state: "done", candidates: [cand("mf", "https://c/3", 0.8, "chapter_probe")], pickUrl: null, pinnedUrl: null, skip: true },
      Linked: { folder: "Linked", query: "Linked", state: "done", candidates: [cand("mf", "https://d/4", 0.8, "chapter_probe")], pickUrl: null, pinnedUrl: null, skip: false },
      Gone: { folder: "Gone", state: "done", candidates: [] },
    };
    const target = { id: "a", profile: "komikku", aliases: [{ url: "https://d/4", deviceFolder: "Linked" }] };
    const v = F.findRows(items, rows, target);
    eq("one view row per current device-only folder", v.map((r) => r.folder), ["Dungeon Meshi", "Hunter_x_Hunter", "SHELTER", "Linked", "New"]);
    eq("url = the picked site", v[0].url, "https://b/2");
    eq("a pinned URL wins", v[1].url, "https://pin/x");
    eq("queueable: not skipped, not linked, has a url", v.map((r) => r.queueable), [true, true, false, false, false]);
    eq("Linked is read from the target's aliases", [v[3].linked, v[0].linked], ["https://d/4", null]);
    eq("a folder without a row: unsearched, the entry's query", [v[4].state, v[4].query], ["unsearched", "New"]);
    eq("searchable: not done, not skipped, not linked", F.searchable(v).map((r) => r.folder), ["New"]);
    eq("candidate score", F.candidateScore(rows["Dungeon Meshi"].candidates[0]), "0.92 · ch.97");
    eq("unmeasured rating flagged", [F.unmeasured(rows["Dungeon Meshi"].candidates[0]), F.unmeasured(rows["Dungeon Meshi"].candidates[1])], [false, true]);
    eq("komikku reader → komikku download", F.findQueueArgs(target), { komikku: true });
    eq("other readers → the defaults", [F.findQueueArgs({ profile: "everything" }), F.findQueueArgs(null)], [{}, {}]);
    eq("status while this target runs", F.findStatusLine({ targetId: "a", done: 1, total: 3, waiting: null }, "a", v), "Searching 2 of 3…");
    eq("status while waiting", F.findStatusLine({ targetId: "a", done: 0, total: 3, waiting: "check-all" }, "a", v), "Waiting for Library Check All to finish");
    eq("status after a run", F.findStatusLine(null, "a", v), "3 of 5 found a source.");
    eq("no status before any search", F.findStatusLine(null, "a", F.findRows(items, {}, target)), null);
    eq("score = rating; a row saved with only the old composite (= title match) shows chapters only", [F.candidateScore({ rating: 0.7, composite: 1, chapters: 3 }), F.candidateScore({ composite: 1, chapters: 3 })], ["0.70 · ch.3", "ch.3"]);
    eq("score/unmeasured take a site too", [F.candidateScore(rows["Dungeon Meshi"].candidates[1].best), F.unmeasured(rows["Dungeon Meshi"].candidates[1].best)], ["0.50 · ch.97", true]);

    // ── what a queued row downloads (rowQueueArgs = the Search tab's rules) ──
    const site = (s, extra) => ({ site: s, url: `https://${s}.test/x`, title: `T ${s}`, cover: null, rating: 0.8, chapters: 9, qualityBasis: "chapter_probe", titleMatch: 0.9, ...(extra || {}) });
    const series = (title, ...sites) => ({ title, canonicalTitle: title, year: 2018, best: sites[0], sources: sites });
    const multi = series("Chainsaw Man", site("mangadex"), site("mangafire", { cover: "https://c/1.jpg" }), site("mangakatana", { title: null }), site("mangapill"), site("mangahub"), site("atsumaru"));
    const shared = series("Other", site("dynasty"), site("mangafire"));
    const row = (o) => ({ folder: "F", candidates: [multi, shared, series("Solo", site("weebcentral"))], pickUrl: null, pinnedUrl: null, multiSource: true, ...o });
    const altSites = (a) => a.prefetchedAlts.alternatives.map((x) => x.site);
    let q = F.rowQueueArgs(row());
    eq("default pick: match 0's top site, the other 5 sites as fallbacks in rank order", [F.rowUrl(row()), q.multiSource, q.prefetchedAlts.primary, altSites(q)], ["https://mangadex.test/x", true, { site: "mangadex", url: "https://mangadex.test/x" }, ["mangafire", "mangakatana", "mangapill", "mangahub", "atsumaru"]]);
    eq("payload title/year are the search's canonical ones", [q.prefetchedAlts.title, q.prefetchedAlts.year], ["Chainsaw Man", 2018]);
    eq("absent title/cover ride as undefined (dropped by JSON), like the Search tab", JSON.parse(JSON.stringify(q.prefetchedAlts.alternatives.slice(0, 2))), [{ site: "mangafire", url: "https://mangafire.test/x", title: "T mangafire", cover: "https://c/1.jpg" }, { site: "mangakatana", url: "https://mangakatana.test/x" }]);
    q = F.rowQueueArgs(row({ pickUrl: "https://mangapill.test/x" }));
    eq("a picked site is the primary and leaves the fallbacks", [q.prefetchedAlts.primary.site, altSites(q)], ["mangapill", ["mangadex", "mangafire", "mangakatana", "mangahub", "atsumaru"]]);
    q = F.rowQueueArgs(row({ pickUrl: "https://mangafire.test/x" }));
    eq("a URL listed by two matches belongs to the FIRST", [F.rowCandidate(row({ pickUrl: "https://mangafire.test/x" })).title, q.prefetchedAlts.title], ["Chainsaw Man", "Chainsaw Man"]);
    q = F.rowQueueArgs(row({ pickUrl: "https://dynasty.test/x" }));
    eq("picking another match's site falls back over THAT match", [q.prefetchedAlts.title, altSites(q)], ["Other", ["mangafire"]]);
    eq("a single-site match: multiSource true, no fallbacks (aio-dl.py finds its own)", F.rowQueueArgs(row({ pickUrl: "https://weebcentral.test/x" })), { multiSource: true });
    eq("multi-source off: multiSource false, no fallbacks", F.rowQueueArgs(row({ multiSource: false })), { multiSource: false });
    eq("a stale pickUrl: match 0's top site", [F.rowUrl(row({ pickUrl: "https://nowhere/x" })), F.rowQueueArgs(row({ pickUrl: "https://nowhere/x" })).prefetchedAlts.primary.site], ["https://mangadex.test/x", "mangadex"]);
    eq("pinned: the pin, nothing added (download defaults)", [F.rowUrl(row({ pinnedUrl: "https://pin/y" })), F.rowQueueArgs(row({ pinnedUrl: "https://pin/y" })), F.rowSource(row({ pinnedUrl: "https://pin/y" }))], ["https://pin/y", {}, null]);
    eq("not yet re-searched since v1 (multiSource unknown): nothing added", F.rowQueueArgs(row({ multiSource: null })), {});
    eq("nothing found / no row: nothing added", [F.rowQueueArgs({ candidates: [], multiSource: true }), F.rowQueueArgs(null)], [{}, {}]);
    const vr = F.findRows([{ key: "k", name: "F" }], { F: { ...row(), state: "done", skip: false } }, { aliases: [] })[0];
    eq("findRows carries what rowQueueArgs reads", [vr.pickUrl, vr.multiSource, F.rowQueueArgs(vr).prefetchedAlts.primary.site], [null, true, "mangadex"]);

    // ── the picker (F2): Ready / Check match, sites in order, other matches ──
    const tm = (title, ...scores) => ({ title, best: { url: `https://${title}/0` }, sources: scores.map((t, i) => ({ site: `s${i}`, url: `https://${title}/${i}`, titleMatch: t })) });
    const R = (cands, o) => ({ candidates: cands, pickUrl: null, pinnedUrl: null, ...o });
    eq("title score = the match's best site", [F.matchTitleScore(tm("a", 0.7, 0.9)), F.matchTitleScore(tm("a")), F.matchTitleScore({ sources: [{ titleMatch: null }] })], [0.9, null, null]);
    eq(
      "ready: >= 0.85 and a 0.10 lead (or no rival)",
      [R([tm("a", 0.85)]), R([tm("a", 0.95), tm("b", 0.85)]), R([tm("a", 0.95), tm("b", 0.86)]), R([tm("a", 0.84)]), R([tm("a")]), R([])].map(F.matchReady),
      [true, true, false, false, false, false],
    );
    const fv = F.findRows(
      [{ key: "1", name: "sure" }, { key: "2", name: "close" }, { key: "3", name: "picked" }, { key: "4", name: "pinned" }, { key: "5", name: "skipped" }],
      {
        sure: { ...R([tm("a", 1), tm("b", 0.8)]), state: "done" },
        close: { ...R([tm("a", 0.87), tm("b", 0.8)]), state: "done" },
        picked: { ...R([tm("a", 0.87), tm("b", 0.8)], { pickUrl: "https://b/0" }), state: "done" },
        pinned: { ...R([], { pinnedUrl: "https://pin/z" }), state: "done" },
        skipped: { ...R([tm("a", 0.87), tm("b", 0.8)], { skip: true }), state: "done" },
      },
      { aliases: [] },
    );
    eq(
      "[ready, confirmed, needsCheck, queueable]: a close call waits for the user",
      fv.map((r) => [r.ready, r.confirmed, r.needsCheck, r.queueable]),
      [[true, false, false, true], [false, false, true, false], [false, true, false, true], [false, true, false, true], [false, false, false, false]],
    );
    const sitesOf = (r) => F.rowSites(r).map((x) => [x.source.site, x.picked, x.fallback]);
    eq("sites: picked + fallback ranks in search order", sitesOf(row({ pickUrl: "https://mangapill.test/x" })), [["mangadex", false, 1], ["mangafire", false, 2], ["mangakatana", false, 3], ["mangapill", true, null], ["mangahub", false, 4], ["atsumaru", false, 5]]);
    eq("sites with fallback sites off: no ranks", sitesOf(row({ multiSource: false })).map((x) => x[2]), [null, null, null, null, null, null]);
    eq("sites: the fallback ranks are rowQueueArgs' alternatives order", F.rowSites(row()).filter((x) => x.fallback).map((x) => x.source.site), altSites(F.rowQueueArgs(row())));
    eq("sites: none when pinned or nothing found", [F.rowSites(row({ pinnedUrl: "https://p/1" })), F.rowSites({ candidates: [] })], [[], []]);
    eq("other matches: every match but the picked one", [F.otherMatches(row()).map((c) => c.title), F.otherMatches(row({ pickUrl: "https://dynasty.test/x" })).map((c) => c.title)], [["Other", "Solo"], ["Chainsaw Man", "Solo"]]);
  }

  // ── one fallback payload for both tabs (src/lib/prefetchedAlts.js) ──
  // OLD_SEARCH_CARD_BUILD is SearchSourceCard.handleDownload's inline builder
  // as it was before the extraction (commit d89e092), verbatim: the shared
  // builder must reproduce it exactly, and the sync path (find-sources.js
  // compactCandidates → findView.rowQueueArgs) must send the same payload the
  // Search tab would for the same search result.
  {
    const o = path.join(os.tmpdir(), `aio-prefetchedAlts-${process.pid}.mjs`);
    await esbuild.build({ entryPoints: [path.join(UI, "src", "lib", "prefetchedAlts.js")], bundle: true, format: "esm", platform: "neutral", outfile: o, logLevel: "error" });
    const P = await import(pathToFileURL(o).href);
    fs.rmSync(o, { force: true });
    const F = await bundle("findView");
    const { compactCandidates } = require(path.join(UI, "electron", "sync", "find-sources.js"));
    const OLD_SEARCH_CARD_BUILD = (candidate, source) => {
      if (candidate?.sources?.length > 1) {
        const alternatives = candidate.sources
          .filter((s) => s.url !== source.url)
          .map((s) => ({
            site: s.site,
            url: s.url,
            title: s.title || undefined,
            cover: s.cover || undefined,
          }));
        if (alternatives.length > 0) {
          return {
            primary: { site: source.site, url: source.url },
            alternatives,
            title: candidate.canonical_title || "",
            year: candidate.canonical_year || null,
          };
        }
      }
      return null;
    };
    const raw = (s, extra) => ({ site: s, url: `https://${s}.test/r`, title: `R ${s}`, cover: `https://${s}.test/c.jpg`, composite_score: 0.7, actual_chapter_count: 50, quality_basis: "seed", title_match: 0.95, ...(extra || {}) });
    const json = {
      candidates: [
        { canonical_title: "Raw One", canonical_year: 2019, sources: [raw("a"), raw("b", { title: "" }), raw("c", { cover: null }), raw("d"), raw("e"), raw("f"), raw("g")] },
        { canonical_title: null, canonical_year: null, sources: [raw("h"), raw("i", { title: undefined, cover: undefined })] },
        { canonical_title: "Solo", canonical_year: 2001, sources: [raw("j")] },
        { canonical_title: "", sources: [raw("k"), raw("l")] },
      ],
    };
    const compact = compactCandidates(json);
    const cases = [];
    json.candidates.forEach((c, ci) => c.sources.forEach((s, si) => cases.push([ci, si])));
    const mismatch = [];
    for (const [ci, si] of cases) {
      const c = json.candidates[ci];
      const s = c.sources[si];
      const old = OLD_SEARCH_CARD_BUILD(c, s);
      const shared = P.buildPrefetchedAlts(c.sources, s, c.canonical_title, c.canonical_year);
      const sync = F.rowQueueArgs({ candidates: compact, pickUrl: s.url, pinnedUrl: null, multiSource: true }).prefetchedAlts || null;
      const j = (x) => JSON.stringify(x);
      if (j(old) !== j(shared) || j(old) !== j(sync)) mismatch.push({ ci, si, old, shared, sync });
      // undefined keys are dropped by JSON: also compare the in-memory shape.
      try {
        require("assert").deepStrictEqual(shared, old);
      } catch (_) {
        mismatch.push({ ci, si, inMemory: true });
      }
    }
    eq(`Search-tab builder == shared builder == sync path, ${cases.length} picks`, mismatch, []);
  }

  if (failures) {
    console.error(`\n${failures} view check(s) failed`);
    process.exit(1);
  }
  console.log("\nall view checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
