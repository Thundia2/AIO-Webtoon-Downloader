// Offline regression for the Device Sync pure core
// (UI-source/electron/sync/: naming, chapter-labels, sync-settings, profiles,
// contract, provenance, analysis, planner, job-record).
//
// Covers the non-UI plan's "_test_device_sync_core.js" list (sync-temp/plans/
// c-users-legoc-claude-plans-add-this-scr-noble-truffle.md, Verification):
// names, labels and library.js recognition parity, settings, profiles, the
// provenance matrix and pending resolution, adopted-size, the gone-folder
// re-push (decision 10), per-slot planning, preselection, losses, rule 6's
// reconcile, rule 10, rule 12, rule 13, selection persistence, adoption,
// collisions and binding, refusals, and the job record.
//
//   node tools/_test_device_sync_core.js
//   ELECTRON_RUN_AS_NODE=1 UI-source/node_modules/electron/dist/electron tools/_test_device_sync_core.js
//
// tools/ is gitignored; this file is force-added on wip/device-sync-handoff
// only and never ships.

const assert = require("assert");
const path = require("path");

const SYNC = path.join(__dirname, "..", "UI-source", "electron", "sync");
const naming = require(path.join(SYNC, "naming.js"));
const labels = require(path.join(SYNC, "chapter-labels.js"));
const { resolveSyncSettings, SYNC_SETTING_SPECS, SYNC_SETTING_KEYS } = require(path.join(SYNC, "sync-settings.js"));
const profiles = require(path.join(SYNC, "profiles.js"));
const contract = require(path.join(SYNC, "contract.js"));
const prov = require(path.join(SYNC, "provenance.js"));
const analysis = require(path.join(SYNC, "analysis.js"));
const planner = require(path.join(SYNC, "planner.js"));
const { createJobRecord, COALESCE_MS } = require(path.join(SYNC, "job-record.js"));
const library = require(path.join(__dirname, "..", "UI-source", "electron", "library.js"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const OLD = NOW - 3_600_000;
const EPOCH = "epoch-1";

function target(over) {
  return profiles.resolveTargetConfig({
    id: "t1",
    name: "Galaxy Tab",
    kind: "adb",
    serial: "S1",
    root: "/storage/emulated/0/Komikku/local",
    profile: "komikku",
    ...over,
  });
}

const SETTINGS = resolveSyncSettings({});

// f("Ch.001.cbz", 100, "sha1") — a PC file, old enough not to be settling.
function f(name, size, sha, mtimeMs) {
  return { name, size, sha256: sha === undefined ? `sha:${name}:${size}` : sha, mtimeMs: mtimeMs == null ? OLD : mtimeMs, path: `/lib/x/${name}` };
}

function series(folder, files, extra) {
  const e = extra || {};
  return {
    folder,
    folderPath: `/lib/${folder}`,
    title: e.title || naming.stripHidSuffix(folder),
    identityKey: e.identityKey === undefined ? `hid:mangafire:${folder.toLowerCase().replace(/\W+/g, "")}` : e.identityKey,
    url: e.url === undefined ? `https://mangafire.to/manga/${encodeURIComponent(folder)}` : e.url,
    anilistId: e.anilistId == null ? null : e.anilistId,
    synonyms: e.synonyms || [],
    imageOnly: !!e.imageOnly,
    malformedJson: e.malformedJson || [],
    files,
  };
}

function pc(list) {
  return { ok: true, series: list };
}

// device({"Folder": [["Ch.001.cbz", 100, 500]]}, {meta, rootFiles})
function device(folders, extra) {
  const e = extra || {};
  const map = new Map();
  for (const [name, files] of Object.entries(folders)) {
    map.set(name, files === null ? { ok: false, error: "EACCES" } : { ok: true, files: files.map(([n, size, devMtime]) => ({ name: n, size, devMtime })) });
  }
  return {
    trusted: e.trusted === undefined ? true : e.trusted,
    dirs: Object.keys(folders).map((name) => ({ name })),
    rootFiles: e.rootFiles || [],
    folders: map,
    meta: new Map(Object.entries(e.meta || {})),
  };
}

// e("Ch.001.cbz", 100, "sha", 500, "pushed")
function e(name, size, sha, devMtime, origin) {
  return { name, size, sha256: sha, devMtime, origin: origin || "pushed" };
}

function shard(shardId, name, bindingFrom, entries, extra) {
  const x = extra || {};
  const files = {};
  for (const en of entries || []) files[en.name] = en;
  return {
    shardId,
    recordEpoch: x.recordEpoch || EPOCH,
    name,
    identityKey: bindingFrom.identityKey,
    urlKey: library.normalizeSeriesUrl(bindingFrom.url) || null,
    pcFolder: bindingFrom.folder,
    verifiedAt: x.verifiedAt === undefined ? 1 : x.verifiedAt,
    verifyMode: x.verifyMode || "device-hash",
    renameIntent: x.renameIntent || null,
    files,
  };
}

function view(shards, extra) {
  const x = extra || {};
  const t = x.target || target();
  const ci = x.ci === undefined ? true : x.ci;
  const header = x.noHeader ? null : { recordEpoch: EPOCH, ...profiles.recordIdentity(t), caseInsensitive: ci, ...(x.header || {}) };
  return prov.loadRecordView({ header, shards, selection: x.selection || null, target: t, measured: { caseInsensitive: ci } });
}

function plan(args) {
  const t = args.target || target();
  return planner.buildPlan({
    target: t,
    settings: args.settings || SETTINGS,
    pc: args.pc,
    device: args.device,
    view: args.view,
    opts: { now: NOW, ...(args.opts || {}) },
  });
}

function sel(p, stored) {
  return planner.effectiveSelection(p, stored || {});
}

function opsOf(p, seriesKey) {
  const sp = p.bySeriesKey.get(seriesKey);
  return sp.opIds.map((id) => p.ops.get(id));
}

function op(p, id) {
  const o = p.ops.get(id);
  assert.ok(o, `missing op ${id}; have ${[...p.ops.keys()].join(", ")}`);
  return o;
}

// A bound series "Alpha" with chapters 1..n in sync on the device.
function boundAlpha(n, opts) {
  const o = opts || {};
  const files = [];
  const entries = [];
  const devFiles = [];
  for (let i = 1; i <= n; i += 1) {
    const name = `Ch.${String(i).padStart(3, "0")}.cbz`;
    files.push(f(name, 1000 + i));
    entries.push(e(name, 1000 + i, `sha:${name}:${1000 + i}`, 500 + i, o.origin));
    devFiles.push([name, 1000 + i, 500 + i]);
  }
  const s = series("Alpha", files);
  return { s, entries, devFiles, sh: shard("sh-alpha", "Alpha", s, entries, o.shardExtra) };
}

// ── naming ────────────────────────────────────────────────────────────────

console.log("naming");

test("sanitizeSegment strips forbidden chars, NFKC, trailing dots/spaces", () => {
  assert.deepStrictEqual(naming.sanitizeSegment('A/B\\C:D*E?F"G<H>I|J'), { name: "ABCDEFGHIJ", error: null });
  assert.strictEqual(naming.sanitizeSegment("Ｆｕｌｌ").name, "Full");
  assert.strictEqual(naming.sanitizeSegment("Title... ").name, "Title");
  assert.strictEqual(naming.sanitizeSegment("...").error, "empty");
  assert.strictEqual(naming.sanitizeSegment("a\x00b\x7f").name, "ab");
});

test("255-byte segment limit counts UTF-8 bytes", () => {
  const jp = "あ".repeat(86); // 258 bytes
  assert.strictEqual(naming.sanitizeSegment(jp).error, "too-long");
  assert.strictEqual(naming.sanitizeSegment("あ".repeat(85)).error, null);
  assert.strictEqual(naming.segmentError(jp), "too-long");
  assert.strictEqual(naming.segmentError("a/b"), "forbidden-char");
  assert.strictEqual(naming.segmentError("ok name"), null);
});

test("stripHidSuffix mirrors aio-dl.py's clean_title", () => {
  assert.strictEqual(naming.stripHidSuffix("Solo Leveling (hid=abc123)"), "Solo Leveling");
  assert.strictEqual(naming.stripHidSuffix("Solo Leveling"), "Solo Leveling");
  assert.strictEqual(naming.stripHidSuffix("(hid=x)"), "(hid=x)");
});

test("slotKey: NFC always, lowercase only on case-insensitive targets", () => {
  const nfd = "Pokémon".normalize("NFD");
  assert.strictEqual(naming.slotKey(nfd, false), "Pokémon".normalize("NFC"));
  assert.notStrictEqual(naming.slotKey("ABC", false), naming.slotKey("abc", false));
  assert.strictEqual(naming.slotKey("ABC", true), naming.slotKey("abc", true));
});

test("compactKey folds case, accents, × and punctuation", () => {
  assert.strictEqual(naming.compactKey("SPY_x_FAMILY"), naming.compactKey("SPY×FAMILY"));
  assert.strictEqual(naming.compactKey("Shōnen"), naming.compactKey("Shonen"));
  assert.strictEqual(naming.compactKey("CØDEBREAKER"), naming.compactKey("Codebreaker"));
});

test("deriveSearchQuery follows batch_search's rules", () => {
  assert.strictEqual(naming.deriveSearchQuery("Hell's_Paradise (Official)"), "Hell's Paradise");
  assert.strictEqual(naming.deriveSearchQuery("-Song- of One-Punch"), "Song of One-Punch");
  assert.strictEqual(naming.deriveSearchQuery("Title (Colored) (hid=1)"), "Title (Colored)");
});

test("findSeriesEntry precedence: identity, then URL, then folder", () => {
  const s = { identityKey: "hid:a:1", url: "https://WWW.mangafire.to/m/x/", folder: "X" };
  const byFolder = { pcFolder: "X", tag: "folder" };
  const byUrl = { url: "https://mangafire.to/m/x", tag: "url" };
  const byId = { identityKey: "hid:a:1", tag: "id" };
  assert.strictEqual(naming.findSeriesEntry(s, [byFolder, byUrl, byId]).tag, "id");
  assert.strictEqual(naming.findSeriesEntry(s, [byFolder, byUrl]).tag, "url");
  assert.strictEqual(naming.findSeriesEntry(s, [byFolder]).tag, "folder");
});

test("resolveTargetName: alias byte-exact, else policy", () => {
  const s = { identityKey: "hid:a:1", url: null, folder: "Record of Ragnarok (hid=9)", title: "Shuumatsu no Valkyrie" };
  const cfg = target({ aliases: [{ identityKey: "hid:a:1", deviceFolder: "Record of Ragnarok." }] });
  assert.deepStrictEqual(naming.resolveTargetName(s, cfg), { name: "Record of Ragnarok.", source: "alias", error: null });
  assert.strictEqual(naming.resolveTargetName(s, target()).name, "Record of Ragnarok");
  assert.strictEqual(naming.resolveTargetName(s, target({ namingPolicy: "as-is" })).name, "Record of Ragnarok (hid=9)");
  assert.strictEqual(naming.resolveTargetName(s, target({ namingPolicy: "title" })).name, "Shuumatsu no Valkyrie");
});

// ── chapter labels ────────────────────────────────────────────────────────

console.log("chapter labels");

test("conservative labels: 5.10 ≠ 5.1, 005 = 5, 5.0 = 5, ~ = .", () => {
  assert.strictEqual(labels.conservativeLabel("005.10"), "5.10");
  assert.strictEqual(labels.conservativeLabel("005.1"), "5.1");
  assert.strictEqual(labels.conservativeLabel("005"), "5");
  assert.strictEqual(labels.conservativeLabel("5.0"), "5");
  assert.strictEqual(labels.conservativeLabel("5~5"), "5.5");
  assert.strictEqual(labels.conservativeLabel("012A"), "12a");
  assert.strictEqual(labels.conservativeLabel("000"), "0");
  assert.strictEqual(labels.conservativeLabel("-0"), "0");
  assert.strictEqual(labels.conservativeLabel("abc"), null);
});

test("labelFile: Komikku, legacy, ranges, conventions, volumes, whole, unknown", () => {
  const L = (n, folder) => labels.labelFile(n, folder || "Spy x Family", []);
  assert.deepStrictEqual([L("Ch.005.10 - Title.cbz").unit, L("Ch.005.10 - Title.cbz").label], ["chapter", "5.10"]);
  assert.strictEqual(L("Vol.02 Ch.012a.cbz").label, "12a");
  const legacy = L("Spy x Family Ch 5~5.pdf");
  assert.deepStrictEqual([legacy.label, legacy.convention, legacy.tilde], ["5.5", "legacy", true]);
  const range = L("Spy x Family Ch 1-50.pdf");
  assert.deepStrictEqual([range.unit, range.label, range.start, range.end], ["range", "1-50", "1", "50"]);
  assert.strictEqual(L("SPY_x_FAMILY_mangafire_Ch_12.cbz").label, "12");
  assert.strictEqual(L("Chapter 7.cbz").label, "7");
  assert.strictEqual(L("#12 - [Season 2] Ep. 3.cbz").label, "12");
  assert.deepStrictEqual([L("Vol 3 The Return.cbz").unit, L("Vol 3 The Return.cbz").label], ["volume", "3"]);
  assert.strictEqual(L("Spy x Family.pdf").unit, "whole");
  assert.strictEqual(L("SPY×FAMILY (hid=7).pdf", "SPY×FAMILY (hid=7)").unit, "whole");
  assert.strictEqual(L("extras.cbz").unit, "unknown");
});

test("custom patterns: named group ch; invalid lines reported, not thrown", () => {
  const parsed = labels.parseChapterPatterns("# comment\n^Episode (?<ch>\\d+)\n(unclosed\nno group\n");
  assert.strictEqual(parsed.patterns.length, 1);
  assert.strictEqual(parsed.errors.length, 2);
  assert.strictEqual(labels.labelFile("Episode 042.cbz", "X", parsed.patterns).label, "42");
  assert.ok(labels.labelPreview({ name: "a.cbz", patterns: "(bad" }).error);
  assert.deepStrictEqual(labels.labelPreview({ name: "Ch.003.cbz", folderName: "X" }), { unit: "chapter", label: "3" });
});

test("recognition parity with library.js extractChaptersFromFiles", () => {
  const corpus = [
    "Ch.001.cbz", "Ch.005.5 - Title.cbz", "Ch.012a.cbz", "Vol.01 Ch.003.cbz", "Vol.X Ch.004 - t.cbz",
    "Ch.005.10.cbz", "Title Ch 5.pdf", "Title Ch 5~5.pdf", "Title Ch 1-50.pdf", "Title Ch 1~5-50~5.pdf",
    "Title Ch 5 - Extra.pdf", "Title Ch -1.pdf", "Title Ch abc.pdf", "Title Ch .pdf", "random.cbz",
    "Chapter 7.cbz", "SPY_x_FAMILY_mangafire_Ch_12.cbz", "#3 - x.cbz", "Vol 2.cbz", "Ch.abc.cbz",
    "Ch.007 Ch 9.cbz", "A Ch B Ch 12.pdf", "Ch.000.cbz",
  ];
  for (const name of corpus) {
    const lib = library.extractChaptersFromFiles([{ name }]);
    const libHit = lib.chapters.size + lib.ranges.length > 0;
    const r = labels.labelFile(name, "Title", []);
    const ourHit = r.convention === "komikku" || r.convention === "legacy";
    assert.strictEqual(ourHit, libHit, `recognition differs for ${name}: library ${libHit}, ours ${r.convention}`);
    if (libHit && r.unit === "chapter") {
      const libNum = parseFloat([...lib.chapters][0]);
      assert.strictEqual(parseFloat(r.label), libNum, `numeric value differs for ${name}`);
    }
  }
});

test("compareLabels orders numerically, letters after their number", () => {
  const sorted = ["10", "2", "5b", "5a", "5", "5.10", "5.2"].sort(labels.compareLabels);
  assert.deepStrictEqual(sorted.slice(0, 2), ["2", "5"]);
  assert.strictEqual(sorted[sorted.length - 1], "10");
});

// ── settings, profiles, contract ─────────────────────────────────────────

console.log("settings, profiles, contract");

test("resolveSyncSettings: defaults and invalid-value fallback", () => {
  const d = resolveSyncSettings(undefined);
  for (const k of SYNC_SETTING_KEYS) assert.strictEqual(d[k], SYNC_SETTING_SPECS[k].default, k);
  const bad = resolveSyncSettings({ syncEnabled: "yes", syncDeletePolicy: "nuke", syncErrorBudget: 4, syncSizeWarnPct: 0, syncChapterPatterns: "(bad\n^E(?<ch>\\d+)" });
  assert.strictEqual(bad.syncEnabled, false);
  assert.strictEqual(bad.syncDeletePolicy, "guarded");
  assert.strictEqual(bad.syncErrorBudget, 3);
  assert.strictEqual(bad.syncSizeWarnPct, 0);
  assert.strictEqual(bad.chapterPatterns.length, 1);
  assert.strictEqual(bad.chapterPatternErrors.length, 1);
});

test("resolveTargetConfig fills null fields from the profile; a switch propagates", () => {
  const k = profiles.resolveTargetConfig({ profile: "komikku", formats: null, sidecars: null, nomedia: null });
  assert.deepStrictEqual(k.formats, ["cbz", "zip", "cbr", "rar", "epub"]);
  assert.deepStrictEqual(k.sidecars, ["cover.jpg", "details.json"]);
  assert.strictEqual(k.nomedia, true);
  const g = profiles.resolveTargetConfig({ profile: "generic", formats: null, sidecars: null, nomedia: null });
  assert.ok(g.formats.includes("pdf"));
  assert.deepStrictEqual(g.sidecars, ["cover.jpg"]);
  assert.strictEqual(g.nomedia, false);
  assert.strictEqual(k.namingPolicy, "strip-hid");
  assert.deepStrictEqual(k.cleanupNames, [".aio_series.json", ".mangafire_hid", ".series_hid", ".cover.webp"]);
});

test("validateTarget: folder root may not be inside or contain the library or userData", () => {
  const ctx = { libraryRoot: "D:\\Manga", userDataDir: "C:\\Users\\legoc\\AppData\\Roaming\\aio-downloader-ui", platform: "win32" };
  const base = { kind: "folder", profile: "generic" };
  assert.ok(profiles.validateTarget({ ...base, root: "d:\\manga\\_mirror" }, ctx).some((x) => x.field === "root"));
  assert.ok(profiles.validateTarget({ ...base, root: "D:\\" }, ctx).some((x) => x.field === "root"));
  assert.ok(profiles.validateTarget({ ...base, root: "C:\\Users\\legoc\\AppData" }, ctx).some((x) => x.field === "root"));
  assert.deepStrictEqual(profiles.validateTarget({ ...base, root: "E:\\Tablet" }, ctx), []);
  assert.ok(profiles.validateTarget({ kind: "adb", profile: "komikku", root: "/sdcard/../x", serial: "S" }, ctx).length);
  assert.ok(profiles.validateTarget({ kind: "adb", profile: "komikku", root: "/sdcard/x" }, ctx).some((x) => x.field === "serial"));
  assert.ok(profiles.validateTarget({ kind: "folder", profile: "generic", root: "E:\\T", cleanupNames: ["cover.jpg"] }, ctx).some((x) => x.field === "cleanupNames"));
});

test("contract: refuse() has one shape and rejects unknown codes", () => {
  assert.deepStrictEqual(contract.refuse("busy", "x", { job: 1 }), { job: 1, ok: false, code: "busy", message: "x" });
  assert.throws(() => contract.refuse("nope", "x"));
  assert.strictEqual(contract.CHANNEL_NAMES.length, 22);
  assert.ok(contract.CHANNELS_WHILE_DISABLED.has("sync:get-state"));
  assert.strictEqual(contract.CHANNELS_WHILE_DISABLED.size, 4);
});

// ── provenance ───────────────────────────────────────────────────────────

console.log("provenance");

test("matrix: pushed / adopted / adopted-size / partial ours; foreign; pending; changed", () => {
  const d = { size: 10, devMtime: 100 };
  for (const origin of ["pushed", "adopted", "adopted-size", "partial"]) {
    assert.strictEqual(prov.classifyDeviceFile(e("a", 10, "s", 100, origin), d), "ours", origin);
    assert.strictEqual(prov.classifyDeviceFile(e("a", 10, "s", 101, origin), d), "changed", origin);
  }
  assert.strictEqual(prov.classifyDeviceFile(e("a", 10, "s", 100, "foreign"), d), "foreign");
  assert.strictEqual(prov.classifyDeviceFile(e("a", 10, "s", 100, "pending"), d), "pending");
  assert.strictEqual(prov.classifyDeviceFile(undefined, d), "unverified");
  assert.strictEqual(prov.classifyDeviceFile(e("a", 10, "s", null, "pushed"), d), "changed");
});

test("pending resolution: every row of the table", () => {
  const prev = e("a.cbz", 10, "old", 100);
  const pend = { name: "a.cbz", size: 12, sha256: "new", origin: "pending", prev };
  assert.deepStrictEqual(prov.resolvePending(pend, null), { outcome: "absent", entry: null });
  assert.deepStrictEqual(prov.resolvePending(pend, { size: 10, devMtime: 100 }).entry, prev);
  assert.strictEqual(prov.resolvePending(pend, { size: 7, devMtime: 200 }).outcome, "partial");
  assert.strictEqual(prov.resolvePending(pend, { size: 12, devMtime: 200 }).outcome, "needs-recv");
  const pushed = prov.resolvePending(pend, { size: 12, devMtime: 200 }, { sha: "new" });
  assert.deepStrictEqual(pushed, { outcome: "pushed", entry: { name: "a.cbz", size: 12, sha256: "new", devMtime: 200, origin: "pushed" } });
  // Same-size update (details.json): one RECV is compared against both shas.
  const same = { name: "details.json", size: 10, sha256: "new", origin: "pending", prev: e("details.json", 10, "old", 100) };
  assert.strictEqual(prov.resolvePending(same, { size: 10, devMtime: 300 }).outcome, "needs-recv");
  assert.strictEqual(prov.resolvePending(same, { size: 10, devMtime: 300 }, { sha: "new" }).outcome, "pushed");
  const back = prov.resolvePending(same, { size: 10, devMtime: 300 }, { sha: "old" });
  assert.deepStrictEqual([back.outcome, back.entry.devMtime, back.entry.origin], ["restore-prev", 300, "pushed"]);
  const part = prov.resolvePending(same, { size: 10, devMtime: 300 }, { sha: "zzz" });
  assert.deepStrictEqual([part.outcome, part.entry.origin, part.entry.sha256], ["partial", "partial", "zzz"]);
  const failedRecv = prov.resolvePending(same, { size: 10, devMtime: 300 }, { error: "EIO" });
  assert.deepStrictEqual([failedRecv.outcome, failedRecv.entry.origin], ["unresolved", "pending"]);
});

test("a RECV failure plans as a pre-selected update, never a delete", () => {
  const { s, entries, devFiles } = boundAlpha(3);
  entries[1] = { name: "Ch.002.cbz", size: 1002, sha256: "sha:Ch.002.cbz:1002", origin: "pending", prev: entries[1] };
  const sh = shard("sh-alpha", "Alpha", s, entries);
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([sh]) });
  const o = op(p, "update:Alpha/Ch.002.cbz");
  assert.deepStrictEqual([o.reason, o.preselected], ["unresolved-pending", true]);
  assert.ok(![...p.ops.values()].some((x) => x.kind === "delete"));
});

test("a pushed entry without devMtime adopts the next listing's at an equal size", () => {
  const en = e("a", 10, "s", null);
  assert.deepStrictEqual(prov.adoptMissingDevMtime(en, { size: 10, devMtime: 77 }).devMtime, 77);
  assert.strictEqual(prov.adoptMissingDevMtime(en, { size: 11, devMtime: 77 }), null);
  const { s, entries, devFiles } = boundAlpha(2);
  entries[0] = { ...entries[0], devMtime: null };
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").counts.inSync, 2);
  assert.strictEqual(p.entryFixes.length, 1);
  assert.strictEqual(p.entryFixes[0].entry.devMtime, 501);
});

test("rename intents resolve from exact listing names", () => {
  const ri = { from: "Old", via: ".aio-rn", to: "New" };
  assert.strictEqual(prov.resolveRenameIntent(ri, ["New"]).state, "done");
  assert.strictEqual(prov.resolveRenameIntent(ri, ["Old"]).state, "not-started");
  assert.deepStrictEqual(prov.resolveRenameIntent(ri, [".aio-rn"]).finish, { src: ".aio-rn", dst: "New" });
  assert.strictEqual(prov.resolveRenameIntent(ri, ["Old", "New"]).state, "conflict");
  assert.strictEqual(prov.resolveRenameIntent(ri, []).state, "gone");
  // Case-only rename: exact names, not a case-folded lookup.
  assert.strictEqual(prov.resolveRenameIntent({ from: "alpha", to: "Alpha" }, ["Alpha"]).state, "done");
});

test("Verify merge: hash adopt/foreign; adopt-size stores the PC sha; failure keeps entries", () => {
  const pcFiles = [{ name: "Ch.001.cbz", size: 10, sha256: "p1" }, { name: "Ch.002.cbz", size: 20, sha256: "p2" }];
  const dev = [{ name: "Ch.001.cbz", size: 10, devMtime: 1 }, { name: "x.cbz", size: 5, devMtime: 2 }, { name: "Ch.002.cbz", size: 20, devMtime: 3 }];
  const hashes = new Map([["Ch.001.cbz", "p1"], ["x.cbz", "zz"], ["Ch.002.cbz", "p2"]]);
  const m = prov.mergeVerify({ entries: new Map(), deviceFiles: dev, hashes, pcFiles, mode: "device-hash", caseInsensitive: true });
  assert.strictEqual(m.get("ch.001.cbz").origin, "adopted");
  assert.strictEqual(m.get("x.cbz").origin, "foreign");
  const sz = prov.mergeVerify({ entries: new Map(), deviceFiles: dev, hashes: null, pcFiles, mode: "adopt-size", caseInsensitive: true });
  assert.deepStrictEqual([sz.get("ch.002.cbz").origin, sz.get("ch.002.cbz").sha256], ["adopted-size", "p2"]);
  assert.deepStrictEqual([sz.get("x.cbz").origin, sz.get("x.cbz").sha256], ["foreign", null]);
  assert.strictEqual(prov.verifyFailed({ deviceFiles: dev, hashes: new Map(), rc: 0 }), true);
  assert.strictEqual(prov.verifyFailed({ deviceFiles: dev, hashes, rc: 1 }), true);
  assert.strictEqual(prov.verifyFailed({ deviceFiles: dev, hashes, rc: 0 }), false);
  assert.strictEqual(prov.verifyFailed({ deviceFiles: [], hashes: new Map(), rc: 0 }), false);
});

test("rule 12: a new recordEpoch hides old shards and the old selection; header mismatch", () => {
  const t = target();
  const v = prov.loadRecordView({
    header: { recordEpoch: "E2", ...profiles.recordIdentity(t) },
    shards: [{ shardId: "a", recordEpoch: "E1", name: "A", files: {} }, { shardId: "b", recordEpoch: "E2", name: "B", files: {} }],
    selection: { recordEpoch: "E1", ops: { x: { sha: "s", selected: false } }, rebinds: {} },
    target: t,
    measured: { caseInsensitive: true },
  });
  assert.deepStrictEqual(v.shards.map((s) => s.shardId), ["b"]);
  assert.deepStrictEqual(v.staleShardIds, ["a"]);
  assert.deepStrictEqual(v.selection.ops, {});
  assert.ok(profiles.recordIdentityChanged(t, { ...t, root: "/sdcard/Other" }));
  assert.ok(profiles.recordIdentityChanged(t, { ...t, profile: "generic" }));
  assert.ok(!profiles.recordIdentityChanged(t, { ...t, name: "Renamed" }));
  const mism = prov.loadRecordView({ header: { recordEpoch: "E2", ...profiles.recordIdentity(t), serial: "OTHER" }, shards: [], selection: null, target: t });
  assert.deepStrictEqual(mism.mismatch, ["serial"]);
  const r = plan({ pc: pc([series("A", [f("Ch.001.cbz", 1)])]), device: device({}), view: mism });
  assert.deepStrictEqual([r.ok, r.code, r.fields], [false, "record-mismatch", ["serial"]]);
});

test("a re-probed caseInsensitive flag re-keys entries on load", () => {
  const sh = { shardId: "a", recordEpoch: EPOCH, name: "A", files: { "Ch.001.cbz": e("Ch.001.cbz", 1, "s", 1) } };
  const t = target();
  const h = { recordEpoch: EPOCH, ...profiles.recordIdentity(t), caseInsensitive: false };
  assert.ok(prov.loadRecordView({ header: h, shards: [sh], target: t, measured: { caseInsensitive: true } }).shards[0].files.has("ch.001.cbz"));
  assert.ok(prov.loadRecordView({ header: h, shards: [sh], target: t, measured: {} }).shards[0].files.has("Ch.001.cbz"));
});

// ── per-slot planning and preselection ───────────────────────────────────

console.log("per-slot planning");

test("in sync, update, replace (unticked), push, settling", () => {
  const { s, entries, devFiles } = boundAlpha(4);
  s.files[1] = f("Ch.002.cbz", 2222); // changed on the PC → update
  entries[2] = e("Ch.003.cbz", 1003, "other", 503, "foreign"); // foreign at a PC slot → replace
  s.files.push(f("Ch.005.cbz", 1005)); // missing on the device → push
  s.files.push(f("Ch.006.cbz", 1006, undefined, NOW - 5000)); // too young → settling
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  const sp = p.bySeriesKey.get("pc:Alpha");
  assert.strictEqual(sp.state, "bound");
  assert.strictEqual(sp.counts.inSync, 2);
  assert.strictEqual(op(p, "update:Alpha/Ch.002.cbz").preselected, true);
  const rep = op(p, "replace:Alpha/Ch.003.cbz");
  assert.deepStrictEqual([rep.preselected, rep.reason], [false, "foreign"]);
  assert.strictEqual(op(p, "push:Alpha/Ch.005.cbz").preselected, true);
  assert.strictEqual(sp.counts.settling, 1);
  assert.ok(!p.ops.has("push:Alpha/Ch.006.cbz"));
  assert.strictEqual(p.settleAt, NOW - 5000 + planner.SETTLE_MS);
});

test("changed on device (a Komikku custom cover) → replace, unticked", () => {
  const { s, entries, devFiles } = boundAlpha(1);
  s.files.push(f("cover.jpg", 50));
  entries.push(e("cover.jpg", 50, "sha:cover.jpg:50", 900));
  devFiles.push(["cover.jpg", 77, 901]);
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  const r = op(p, "replace:Alpha/cover.jpg");
  assert.deepStrictEqual([r.reason, r.preselected], ["changed-on-device", false]);
});

test("kept name: same bytes under another name → no op; rename toggle → rename op", () => {
  const { s, entries, devFiles } = boundAlpha(2);
  s.files[0] = f("Ch.001 - Pilot.cbz", 1001, "sha:Ch.001.cbz:1001");
  const v = view([shard("sh-alpha", "Alpha", s, entries)]);
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: v });
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").counts.kept, 1);
  assert.strictEqual(p.ops.size, 0);
  const p2 = plan({ target: target({ renameToMatch: true }), pc: pc([s]), device: device({ Alpha: devFiles }), view: v });
  const r = op(p2, "rename:Alpha/Ch.001.cbz->Ch.001 - Pilot.cbz");
  assert.deepStrictEqual([r.preselected, r.viaTemp], [true, false]);
});

test("case-only difference is one slot; rename-to-match goes via a temp name", () => {
  const { s, entries, devFiles } = boundAlpha(1);
  s.files[0] = f("CH.001.cbz", 1001, "sha:Ch.001.cbz:1001");
  const v = view([shard("sh-alpha", "Alpha", s, entries)]);
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: v });
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").counts.inSync, 1);
  assert.strictEqual(p.ops.size, 0);
  const p2 = plan({ target: target({ renameToMatch: true }), pc: pc([s]), device: device({ Alpha: devFiles }), view: v });
  assert.strictEqual(op(p2, "rename:Alpha/Ch.001.cbz->CH.001.cbz").viaTemp, true);
});

test("kept names need hash evidence: an adopted-size copy is not reused", () => {
  const { s, entries, devFiles } = boundAlpha(2);
  s.files[0] = f("Ch.001 - Pilot.cbz", 1001, "sha:Ch.001.cbz:1001");
  entries[0] = { ...entries[0], origin: "adopted-size" };
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").counts.kept, 0);
  assert.ok(p.ops.has("push:Alpha/Ch.001 - Pilot.cbz"));
  assert.strictEqual(op(p, "delete:Alpha/Ch.001.cbz").preselected, false);
});

test("slot guard: a device file at an unmirrored PC file's slot is never offered", () => {
  // Komikku doesn't mirror PDFs, but the PC still holds Ch.004.pdf.
  const { s, entries, devFiles } = boundAlpha(3);
  s.files.push(f("Ch.004.pdf", 44));
  entries.push(e("Ch.004.pdf", 44, "sha:Ch.004.pdf:44", 9));
  devFiles.push(["Ch.004.pdf", 44, 9]);
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  assert.ok(!p.ops.has("delete:Alpha/Ch.004.pdf"));
  assert.deepStrictEqual(p.bySeriesKey.get("pc:Alpha").rows.find((r) => r.name === "Ch.004.pdf").reason, "pc-slot");
});

test("unclaimed non-chapter types are unmanaged; dot-files invisible", () => {
  const { s, entries, devFiles } = boundAlpha(1);
  devFiles.push(["notes.txt", 5, 1], [".nomedia", 0, 1]);
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  const sp = p.bySeriesKey.get("pc:Alpha");
  assert.strictEqual(sp.counts.unmanaged, 1);
  assert.ok(!sp.rows.some((r) => r.name === ".nomedia"));
  assert.ok(![...p.ops.values()].some((o) => o.kind === "delete"));
});

console.log("rule 5 preselection");

function deleteFixture(mutate, planArgs) {
  // Device holds an old-name copy of chapter 2 (unclaimed) next to the PC's
  // file; the PC's Ch.002 is pushed or in sync depending on the case.
  const { s, entries, devFiles } = boundAlpha(12);
  const extra = { name: "Alpha Ch 2.pdf", size: 900, sha: "legacy2", devMtime: 700, origin: "pushed" };
  const ctx = { s, entries, devFiles, extra, planArgs: planArgs || {} };
  if (mutate) mutate(ctx);
  if (!ctx.extra.noEntry) ctx.entries.push(e(ctx.extra.name, ctx.extra.size, ctx.extra.sha, ctx.extra.devMtime, ctx.extra.origin));
  ctx.devFiles.push([ctx.extra.name, ctx.extra.size, ctx.extra.devMtime + (ctx.extra.devDelta || 0)]);
  const p = plan({
    target: ctx.planArgs.target,
    opts: ctx.planArgs.opts,
    pc: pc([ctx.s]),
    device: device({ Alpha: ctx.devFiles }),
    view: view([shard("sh-alpha", "Alpha", ctx.s, ctx.entries, ctx.planArgs.shardExtra)]),
  });
  return { p, d: p.ops.get(`delete:Alpha/${ctx.extra.name}`) };
}

test("ours + label covered by an in-sync PC file → pre-selected replacement", () => {
  const { d } = deleteFixture();
  assert.deepStrictEqual([d.reason, d.preselected], ["replacement", true]);
  assert.deepStrictEqual(d.gate, { label: "2", files: [{ name: "Ch.002.cbz", size: 1002 }] });
});

test("foreign / unverified / changed copies are never pre-selected", () => {
  assert.strictEqual(deleteFixture((c) => (c.extra.origin = "foreign")).d.preselected, false);
  assert.strictEqual(deleteFixture((c) => (c.extra.noEntry = true)).d.preselected, false);
  assert.strictEqual(deleteFixture((c) => (c.extra.devDelta = 1)).d.preselected, false);
  // Same fixture untouched is pre-selected, so the three above test the origin.
  assert.strictEqual(deleteFixture().d.preselected, true);
});

test("adopted-size: its delete is never pre-selected", () => {
  assert.strictEqual(deleteFixture((c) => (c.extra.origin = "adopted-size")).d.preselected, false);
});

test("adopted-size in sync never covers a label for another file's delete", () => {
  const { d } = deleteFixture((c) => {
    c.entries[1] = { ...c.entries[1], origin: "adopted-size" };
  });
  assert.strictEqual(d.reason, "replacement");
  assert.strictEqual(d.preselected, false);
});

test("covered only by a pre-selected push still pre-selects; an uncovered label is an extra", () => {
  const viaPush = deleteFixture((c) => {
    c.entries.splice(1, 1);
    c.devFiles.splice(1, 1);
  });
  assert.strictEqual(viaPush.p.ops.get("push:Alpha/Ch.002.cbz").preselected, true);
  assert.strictEqual(viaPush.d.preselected, true);
  const extra = deleteFixture((c) => {
    c.extra.name = "Alpha Ch 99.pdf";
  });
  assert.deepStrictEqual([extra.d.reason, extra.d.preselected], ["extra", false]);
});

test("ours mirrored sidecar the PC no longer has → pre-selected; add-only pre-selects none", () => {
  const sc = deleteFixture((c) => {
    c.extra.name = "details.json";
  });
  assert.deepStrictEqual([sc.d.reason, sc.d.preselected], ["sidecar", true]);
  const addOnly = deleteFixture(null, { opts: { deletePolicy: "add-only" } });
  assert.strictEqual(addOnly.d.preselected, false);
});

test("volume, range, whole and unknown units are never pre-selected", () => {
  for (const name of ["Vol 1.cbz", "Alpha Ch 1-5.pdf", "Alpha.cbz", "bonus.cbz"]) {
    const { d } = deleteFixture((c) => (c.extra.name = name));
    assert.strictEqual(d.preselected, false, name);
  }
});

test("delete-blocking tags suppress preselection (device-ahead)", () => {
  const { p, d } = deleteFixture((c) => {
    c.entries.push(e("Ch.050.cbz", 5, "x50", 1, "pushed"));
    c.devFiles.push(["Ch.050.cbz", 5, 1]);
  });
  assert.ok(p.bySeriesKey.get("pc:Alpha").tags.includes("device-ahead"));
  assert.strictEqual(d.preselected, false);
});

test("analysis tags: split, ch0, different-start, numbering-mismatch, volumes, mixed, gaps", () => {
  const lab = (names, folder) => names.map((n) => ({ ...labels.labelFile(n, folder || "T", []), name: n, size: 1, ext: "cbz" }));
  const ch = (nums) => nums.map((n) => `Ch.${n}.cbz`);
  assert.ok(analysis.deltaTags(lab(ch(["1", "2", "5"])), lab(ch(["1", "2", "5.1", "5.2"]))).includes("sub-chapter-split"));
  assert.ok(analysis.deltaTags(lab(ch(["0", "1", "2"])), lab(ch(["1", "2"]))).includes("ch0-asymmetry"));
  const off = analysis.deltaTags(lab(ch(["1", "2", "3", "4", "5", "6"])), lab(ch(["101", "102", "103", "104", "105", "106"])));
  assert.ok(off.includes("different-start") && off.includes("numbering-mismatch") && off.includes("device-ahead"));
  // A device that dropped its read chapters is not different-start.
  assert.ok(!analysis.deltaTags(lab(ch(["1", "2", "3", "4", "5"])), lab(ch(["4", "5"]))).includes("different-start"));
  assert.ok(analysis.deltaTags(lab(ch(["1", "2"])), lab(["Vol 1.cbz"])).includes("volumes-not-comparable"));
  assert.ok(analysis.deltaTags(lab(ch(["1"])), lab(["Ch.001.cbz", "T Ch 2.pdf"])).includes("mixed"));
  assert.ok(analysis.deltaTags(lab(ch(["1", "5"])), lab(ch(["1", "3", "5"]))).includes("pc-gaps"));
});

// ── losses, mass delete, selection ───────────────────────────────────────

console.log("losses and selection");

test("loss is a property of the selection: deselecting the replacement push", () => {
  const { p, d } = deleteFixture((c) => {
    c.entries.splice(1, 1);
    c.devFiles.splice(1, 1);
  });
  const sp = p.bySeriesKey.get("pc:Alpha");
  let s = sel(p);
  assert.strictEqual(planner.seriesLosses(p, sp, s).loss.size, 0);
  const pushId = "push:Alpha/Ch.002.cbz";
  const ch = planner.changeSelection(p, {}, { changes: [{ opId: pushId, selected: false }] });
  s = sel(p, ch.ops);
  assert.deepStrictEqual([...planner.seriesLosses(p, sp, s).loss], [d.id]);
  assert.deepStrictEqual(ch.changedSeries, ["pc:Alpha"]);
});

test("an unselected extra reports lossIfSelected; a covered one doesn't", () => {
  const extra = deleteFixture((c) => (c.extra.name = "Alpha Ch 99.pdf"));
  const l = planner.seriesLosses(extra.p, extra.p.bySeriesKey.get("pc:Alpha"), sel(extra.p));
  assert.ok(l.lossIfSelected.has(extra.d.id));
  const covered = deleteFixture((c) => (c.extra.origin = "foreign"));
  const l2 = planner.seriesLosses(covered.p, covered.p.bySeriesKey.get("pc:Alpha"), sel(covered.p));
  assert.ok(!l2.lossIfSelected.has(covered.d.id));
});

test("mass delete: ≥50% of ≥10 device chapter files, or ≥200 in total", () => {
  const { s, entries, devFiles } = boundAlpha(10);
  s.files = s.files.slice(0, 4).concat([f("Ch.020.cbz", 1)]); // 6 device chapters become extras
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  const dels = [...p.ops.values()].filter((o) => o.kind === "delete");
  assert.strictEqual(dels.length, 6);
  const all = planner.changeSelection(p, {}, { bulk: "group", group: "delete", selected: true });
  const ev = planner.evaluateSelection(p, sel(p, all.ops));
  assert.deepStrictEqual([ev.massDelete.required, ev.massDelete.count], [true, 6]);
  const four = planner.changeSelection(p, {}, { changes: dels.slice(0, 4).map((o) => ({ opId: o.id, selected: true })) });
  assert.strictEqual(planner.evaluateSelection(p, sel(p, four.ops)).massDelete.required, false);
});

test("selection persists by (op id, sha): a newer PC version is proposed again", () => {
  const { s, entries, devFiles } = boundAlpha(2);
  s.files[1] = f("Ch.002.cbz", 2002);
  const v = view([shard("sh-alpha", "Alpha", s, entries)]);
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: v });
  const id = "update:Alpha/Ch.002.cbz";
  const stored = planner.changeSelection(p, {}, { changes: [{ opId: id, selected: false }] }).ops;
  assert.strictEqual(sel(p, stored).get(id), false);
  s.files[1] = f("Ch.002.cbz", 3003);
  const p2 = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: v });
  assert.strictEqual(sel(p2, stored).get(id), true);
});

test("bulk: covered extras ticks foreign covered copies; split parts", () => {
  const { p, d } = deleteFixture((c) => (c.extra.origin = "foreign"));
  assert.strictEqual(d.preselected, false);
  const r = planner.changeSelection(p, {}, { bulk: "covered-extras", seriesKey: "pc:Alpha" });
  assert.strictEqual(sel(p, r.ops).get(d.id), true);
  const { s, entries, devFiles } = boundAlpha(4);
  s.files.push(f("Ch.005.cbz", 5));
  for (const part of ["5.1", "5.2"]) {
    const n = `Ch.${part}.cbz`;
    entries.push(e(n, 3, `p${part}`, 9));
    devFiles.push([n, 3, 9]);
  }
  const p2 = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  assert.ok(p2.bySeriesKey.get("pc:Alpha").tags.includes("sub-chapter-split"));
  const r2 = planner.changeSelection(p2, {}, { bulk: "split-parts", seriesKey: "pc:Alpha" });
  const s2 = sel(p2, r2.ops);
  assert.strictEqual(s2.get("delete:Alpha/Ch.5.1.cbz"), true);
  assert.strictEqual(planner.seriesLosses(p2, p2.bySeriesKey.get("pc:Alpha"), s2).loss.size, 2);
});

// ── rule 6 reconcile ─────────────────────────────────────────────────────

console.log("rule 6");

test("apply re-plan: changed and vanished ops dropped; new ops not run; new loss blocks", () => {
  const { s, entries, devFiles } = boundAlpha(3);
  s.files[0] = f("Ch.001.cbz", 5001);
  s.files.push(f("Ch.004.cbz", 1004));
  const v = view([shard("sh-alpha", "Alpha", s, entries)]);
  const reviewed = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: v });
  const s2 = JSON.parse(JSON.stringify(s));
  s2.files[0] = f("Ch.001.cbz", 6001); // changed since review
  s2.files = s2.files.filter((x) => x.name !== "Ch.004.cbz"); // vanished
  s2.files.push(f("Ch.009.cbz", 1009)); // new since review
  const fresh = plan({ pc: pc([s2]), device: device({ Alpha: devFiles }), view: v });
  const r = planner.reconcileForApply({ reviewed, fresh, storedOps: {} });
  assert.deepStrictEqual(r.dropped.map((x) => [x.opId, x.reason]).sort(), [["push:Alpha/Ch.004.cbz", "vanished"], ["update:Alpha/Ch.001.cbz", "changed"]]);
  assert.deepStrictEqual(r.ops.map((o) => o.id), []);
  assert.ok(r.ok);

  const lossCase = deleteFixture((c) => {
    c.entries.splice(1, 1);
    c.devFiles.splice(1, 1);
  });
  const rp = lossCase.p;
  // The fresh plan no longer has the PC file that covered the delete.
  const freshLoss = deleteFixture((c) => {
    c.entries.splice(1, 1);
    c.devFiles.splice(1, 1);
    c.s.files.splice(1, 1);
  }).p;
  const r2 = planner.reconcileForApply({ reviewed: rp, fresh: freshLoss, storedOps: {} });
  assert.ok(!r2.ok);
  assert.deepStrictEqual(r2.blocking[0], { kind: "loss", opIds: [lossCase.d.id] });
  const r3 = planner.reconcileForApply({ reviewed: rp, fresh: freshLoss, storedOps: {}, ackLosses: [lossCase.d.id] });
  assert.ok(r3.ok);
  assert.deepStrictEqual(r3.ops.map((o) => o.kind), ["delete"]);
});

test("a new folder with only sidecar pushes selected creates nothing", () => {
  const s = series("Beta", [f("Ch.001.cbz", 1), f("cover.jpg", 2), f("details.json", 3)]);
  const v = view([], { noHeader: true });
  const p = plan({ pc: pc([s]), device: device({}), view: v });
  const stored = planner.changeSelection(p, {}, { changes: [{ opId: "push:Beta/Ch.001.cbz", selected: false }] }).ops;
  const r = planner.reconcileForApply({ reviewed: p, fresh: p, storedOps: stored });
  assert.deepStrictEqual(r.ops, []);
  assert.deepStrictEqual(r.dropped.map((x) => x.reason), ["no-chapter", "no-chapter"]);
});

// ── adoption, collisions, binding ────────────────────────────────────────

console.log("adoption, collisions, binding");

test("first sync: an existing same-name folder is managed and needs verify", () => {
  const s = series("Alpha", [f("Ch.001.cbz", 1)]);
  const p = plan({ pc: pc([s]), device: device({ Alpha: [["Ch.001.cbz", 1, 5]] }), view: view([], { noHeader: true }) });
  assert.strictEqual(p.firstSync, true);
  const sp = p.bySeriesKey.get("pc:Alpha");
  assert.strictEqual(sp.state, "needs-verify");
  assert.deepStrictEqual(p.needsVerify.map((x) => x.folder), ["Alpha"]);
  assert.strictEqual(op(p, "replace:Alpha/Ch.001.cbz").preselected, false);
});

test("adoption ladder: identity, content ≥90%, name, similar", () => {
  const files = [];
  const dfiles = [];
  for (let i = 1; i <= 10; i += 1) {
    files.push(f(`Record of Ragnarok Ch ${i}.pdf`, 100 + i));
    dfiles.push([`Record of Ragnarok Ch ${i}.pdf`, 100 + i, 1]);
  }
  const s = series("Shuumatsu no Valkyrie", files, { url: "https://mangafire.to/manga/valk", anilistId: 123 });
  const gen = target({ profile: "generic" });
  const v = view([], { target: gen, noHeader: true });
  const content = plan({ target: gen, pc: pc([s]), device: device({ "Record of Ragnarok": dfiles }), view: v });
  const g = content.suggestions[0];
  assert.deepStrictEqual([g.tier, g.strong], ["content", true]);
  assert.ok(opsOf(content, s.seriesKey || "pc:Shuumatsu no Valkyrie").every((o) => !o.preselected));
  // 9 of 10 matching is still ≥90%; 8 of 10 isn't.
  dfiles[0] = ["other.pdf", 1, 1];
  assert.strictEqual(plan({ target: gen, pc: pc([s]), device: device({ "Record of Ragnarok": dfiles }), view: v }).suggestions[0].tier, "content");
  dfiles[1] = ["other2.pdf", 1, 1];
  assert.notStrictEqual((plan({ target: gen, pc: pc([s]), device: device({ "Record of Ragnarok": dfiles }), view: v }).suggestions[0] || {}).tier, "content");
  const ident = plan({
    target: gen,
    pc: pc([s]),
    device: device({ RoR: [["x.pdf", 1, 1]] }, { meta: { RoR: { details: { source_url: "https://www.mangafire.to/manga/valk/" } } } }),
    view: v,
  });
  assert.strictEqual(ident.suggestions[0].tier, "identity");
  const byAnilist = plan({ target: gen, pc: pc([s]), device: device({ RoR: [] }, { meta: { RoR: { details: { anilist_id: 123 } } } }), view: v });
  assert.strictEqual(byAnilist.suggestions[0].tier, "identity");
  const spy = series("SPY x FAMILY", [f("Ch.001.cbz", 1)]);
  const name = plan({ pc: pc([spy]), device: device({ SPY_x_FAMILY: [] }), view: view([], { noHeader: true }) });
  assert.deepStrictEqual([name.suggestions[0].tier, name.suggestions[0].strong], ["name", false]);
  const sim = plan({ pc: pc([series("Hell's Paradise Jigokuraku", [f("Ch.001.cbz", 1)])]), device: device({ "Hells Paradise": [] }), view: view([], { noHeader: true }) });
  assert.strictEqual(sim.suggestions[0].tier, "similar");
  const tbate = plan({ pc: pc([series("The Beginning After the End", [f("Ch.001.cbz", 1)])]), device: device({ "Beginning After The End (Official)": [] }), view: view([], { noHeader: true }) });
  assert.strictEqual(tbate.suggestions[0].tier, "similar");
  const unrelated = plan({ pc: pc([series("One Piece", [f("Ch.001.cbz", 1)])]), device: device({ "Two Kings": [] }), view: view([], { noHeader: true }) });
  assert.strictEqual(unrelated.suggestions.length, 0);
});

test("weak matches block only on a first sync; ignored suggestions don't block", () => {
  const spy = series("SPY x FAMILY", [f("Ch.001.cbz", 1)]);
  const first = plan({ pc: pc([spy]), device: device({ SPY_x_FAMILY: [] }), view: view([], { noHeader: true }) });
  assert.strictEqual(op(first, "push:SPY x FAMILY/Ch.001.cbz").preselected, false);
  const other = boundAlpha(1);
  const later = plan({ pc: pc([spy, other.s]), device: device({ SPY_x_FAMILY: [], Alpha: other.devFiles }), view: view([other.sh]) });
  assert.strictEqual(op(later, "push:SPY x FAMILY/Ch.001.cbz").preselected, true);
  const id = first.suggestions[0].id;
  const ign = plan({ target: target({ ignoredSuggestions: [id] }), pc: pc([spy]), device: device({ SPY_x_FAMILY: [] }), view: view([], { noHeader: true }) });
  assert.strictEqual(op(ign, "push:SPY x FAMILY/Ch.001.cbz").preselected, true);
});

test("names: verbatim also taken → name-taken; nothing left after sanitizing → name-invalid", () => {
  const { s, entries, devFiles } = boundAlpha(1);
  const sh = shard("sh-alpha", "Monster", s, entries);
  const c = series("Monster", [f("Ch.001.cbz", 1)], { identityKey: "hid:mf:m1" });
  const p = plan({ pc: pc([s, c]), device: device({ Monster: devFiles }), view: view([sh]) });
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").deviceFolder, "Monster");
  assert.strictEqual(p.bySeriesKey.get("pc:Monster").heldReason, "name-taken");
  const dots = plan({ pc: pc([series("...", [f("Ch.001.cbz", 1)])]), device: device({}), view: view([], { noHeader: true }) });
  assert.strictEqual(dots.bySeriesKey.get("pc:...").heldReason, "name-invalid");
  assert.strictEqual(dots.anomalies[0].kind, "name-invalid");
});

test("collisions: same identity is a fork; different identities go verbatim", () => {
  const a = series("Solo Leveling", [f("Ch.001.cbz", 1), f("Ch.002.cbz", 2)], { identityKey: "hid:mf:solo" });
  const b = series("Solo Leveling (hid=zz)", [f("Ch.003.cbz", 3)], { identityKey: "hid:mf:solo" });
  const fork = plan({ pc: pc([a, b]), device: device({}), view: view([], { noHeader: true }) });
  assert.deepStrictEqual([fork.bySeriesKey.get("pc:Solo Leveling (hid=zz)").state, fork.bySeriesKey.get("pc:Solo Leveling (hid=zz)").heldReason], ["held", "fork"]);
  assert.ok(fork.anomalies.some((x) => x.kind === "merge-in-library"));
  assert.strictEqual(fork.bySeriesKey.get("pc:Solo Leveling").deviceFolder, "Solo Leveling");
  const c = series("Monster", [f("Ch.001.cbz", 1)], { identityKey: "hid:mf:m1" });
  const d = series("Monster (hid=m2)", [f("Ch.001.cbz", 9)], { identityKey: "hid:mf:m2" });
  const diff = plan({ pc: pc([c, d]), device: device({}), view: view([], { noHeader: true }) });
  assert.strictEqual(diff.bySeriesKey.get("pc:Monster").deviceFolder, "Monster");
  assert.strictEqual(diff.bySeriesKey.get("pc:Monster (hid=m2)").deviceFolder, "Monster (hid=m2)");
});

test("sticky binding: a retitle keeps the bound device folder name", () => {
  const { s, entries, devFiles } = boundAlpha(2);
  const sh = shard("sh-alpha", "Alpha", s, entries);
  const retitled = { ...s, folder: "Alpha Reborn", title: "Alpha Reborn" };
  const p = plan({ pc: pc([retitled]), device: device({ Alpha: devFiles }), view: view([sh]) });
  const sp = p.bySeriesKey.get("pc:Alpha Reborn");
  assert.deepStrictEqual([sp.state, sp.deviceFolder, sp.counts.inSync], ["bound", "Alpha", 2]);
  assert.strictEqual(p.deviceOnly.length, 0);
});

test("binding survives a hid change through urlKey, and a URL change through pcFolder", () => {
  const { s, entries, devFiles } = boundAlpha(1);
  const sh = shard("sh-alpha", "Alpha", s, entries);
  const hidChanged = { ...s, identityKey: "hid:mangafire:new" };
  assert.strictEqual(plan({ pc: pc([hidChanged]), device: device({ Alpha: devFiles }), view: view([sh]) }).bySeriesKey.get("pc:Alpha").state, "bound");
  const urlChanged = { ...s, identityKey: "hid:mangafire:new", url: "https://comix.to/x" };
  assert.strictEqual(plan({ pc: pc([urlChanged]), device: device({ Alpha: devFiles }), view: view([sh]) }).bySeriesKey.get("pc:Alpha").state, "bound");
});

test("excluded series are held: no ops, no prune, never device-only", () => {
  const { s, entries, devFiles } = boundAlpha(2);
  s.files.push(f("Ch.003.cbz", 3));
  const p = plan({ target: target({ excludes: [{ identityKey: s.identityKey }] }), pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  const sp = p.bySeriesKey.get("pc:Alpha");
  assert.deepStrictEqual([sp.state, sp.heldReason, sp.opIds.length], ["held", "excluded", 0]);
  assert.strictEqual(p.deviceOnly.length, 0);
  const only = plan({ target: target({ selection: "only", only: [] }), pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  assert.strictEqual(only.bySeriesKey.get("pc:Alpha").heldReason, "excluded");
});

test("an excluded series keeps its unbound device folder from a same-name series", () => {
  const excluded = series("Monster", [f("Ch.001.cbz", 1)], { identityKey: "hid:mf:m1" });
  const other = series("Monster (hid=m2)", [f("Ch.001.cbz", 9)], { identityKey: "hid:mf:m2" });
  const p = plan({
    target: target({ excludes: [{ identityKey: "hid:mf:m1" }] }),
    pc: pc([excluded, other]),
    device: device({ Monster: [["Ch.001.cbz", 1, 1]] }),
    view: view([], { noHeader: true }),
  });
  const sp = p.bySeriesKey.get("pc:Monster (hid=m2)");
  assert.deepStrictEqual([sp.state, sp.deviceFolder], ["new", "Monster (hid=m2)"]);
  assert.strictEqual(p.bySeriesKey.get("pc:Monster").heldFolder, "Monster");
  assert.deepStrictEqual(p.deviceOnly, []);
  assert.deepStrictEqual(p.needsVerify, []);
});

test("image-only and empty PC folders are held with anomalies; no folder for sidecars alone", () => {
  const img = series("Img", [], { imageOnly: true });
  const empty = series("Empty", [f("cover.jpg", 1), f("details.json", 1)]);
  const p = plan({ pc: pc([img, empty]), device: device({}), view: view([], { noHeader: true }) });
  assert.strictEqual(p.bySeriesKey.get("pc:Img").heldReason, "image-only");
  assert.strictEqual(p.bySeriesKey.get("pc:Empty").heldReason, "empty-pc-folder");
  assert.strictEqual(p.ops.size, 0);
});

test("device-only folders: preserved vs orphaned; loose root files", () => {
  const orphan = shard("sh-gone-series", "Old Series", { identityKey: "hid:x:old", url: null, folder: "Old Series" }, [e("Ch.001.cbz", 1, "s", 1)]);
  const keep = boundAlpha(1);
  const p = plan({
    pc: pc([keep.s]),
    device: device({ Alpha: keep.devFiles, "Old Series": [["Ch.001.cbz", 1, 1]], Shelter: [["a.cbz", 5, 1]] }, { rootFiles: [{ name: "stray.cbz", size: 1, devMtime: 1 }] }),
    view: view([keep.sh, orphan]),
  });
  const byName = Object.fromEntries(p.deviceOnly.map((d) => [d.name, d]));
  assert.deepStrictEqual([byName["Old Series"].state, byName["Old Series"].ours], ["orphaned", 1]);
  assert.strictEqual(byName.Shelter.state, "preserved");
  assert.ok(p.anomalies.some((x) => x.kind === "loose-root-files"));
});

// ── gone bound folders (decision 10) ─────────────────────────────────────

console.log("gone bound folders");

function goneFixture(over) {
  const o = over || {};
  const { s, entries } = boundAlpha(3);
  // The device kept "Ch.002 - old.cbz" for chapter 2 (a kept name).
  entries[1] = e("Ch.002 - old.cbz", 1002, "sha:Ch.002.cbz:1002", 502);
  const sh = shard("sh-alpha", "Alpha", s, entries);
  const others = [];
  const shards = [sh];
  for (let i = 0; i < (o.otherBound || 0); i += 1) {
    const os = series(`Other ${i}`, [f("Ch.001.cbz", 1)]);
    others.push(os);
    shards.push(shard(`sh-o${i}`, `Other ${i}`, os, [e("Ch.001.cbz", 1, "sha:Ch.001.cbz:1", 1)]));
  }
  const dirs = { ...(o.dirs || {}) };
  for (let i = o.goneOthers || 0; i < others.length; i += 1) dirs[`Other ${i}`] = [["Ch.001.cbz", 1, 1]];
  const goneSet = new Set(["sh-alpha", ...others.slice(0, o.goneOthers || 0).map((_, i) => `sh-o${i}`)]);
  const defaultProbe = { Alpha: true };
  for (let i = 0; i < (o.goneOthers || 0); i += 1) defaultProbe[`Other ${i}`] = true;
  const probe = new Map(Object.entries(o.probe || defaultProbe));
  const args = {
    target: o.target,
    pc: pc([s, ...others]),
    device: device(dirs),
    view: view(shards, { selection: o.selection ? { recordEpoch: EPOCH, ops: {}, rebinds: o.selection } : null }),
    opts: { gone: goneSet, nameProbe: probe },
  };
  return { s, sh, args, p: plan(args) };
}

test("goneCandidates: absent shard names (and intent names) of included series", () => {
  const { s, entries } = boundAlpha(1);
  const sh = shard("sh-alpha", "Alpha", s, entries, { renameIntent: { from: "Alpha", via: ".rn", to: "Alpha2" } });
  const orphan = shard("sh-o", "Orphan", { identityKey: "hid:x", url: null, folder: "Orphan" }, []);
  const c = planner.goneCandidates({ view: view([sh, orphan]), pc: pc([s]), target: target(), device: device({}) });
  assert.deepStrictEqual(c, [{ shardId: "sh-alpha", names: ["Alpha", ".rn", "Alpha2"] }]);
  assert.deepStrictEqual(planner.goneCandidates({ view: view([sh]), pc: pc([s]), target: target(), device: device({ ".rn": [] }) }), []);
  assert.deepStrictEqual(planner.goneCandidates({ view: view([sh]), pc: pc([s]), target: target(), device: device({ alpha: [] }) }), []);
});

test("every PC file plans as a pre-selected push under the old name, kept names reused", () => {
  const { p } = goneFixture();
  const sp = p.bySeriesKey.get("pc:Alpha");
  assert.deepStrictEqual([sp.state, sp.deviceFolder, sp.nameSource], ["gone", "Alpha", "previous"]);
  const pushes = opsOf(p, "pc:Alpha");
  assert.deepStrictEqual(pushes.map((o) => o.id).sort(), ["push:Alpha/Ch.001.cbz", "push:Alpha/Ch.002 - old.cbz", "push:Alpha/Ch.003.cbz"]);
  assert.ok(pushes.every((o) => o.preselected && o.reason === "removed-on-device"));
  assert.strictEqual(op(p, "push:Alpha/Ch.002 - old.cbz").pcName, "Ch.002.cbz");
  assert.deepStrictEqual(p.needsProbe, []);
});

test("unprobed candidate names are listed; nothing is chosen until a STA2 says ENOENT", () => {
  const { p } = goneFixture({ probe: {} });
  assert.deepStrictEqual(p.needsProbe, ["Alpha"]);
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").heldReason, "name-taken");
});

test("rebind choices: derived only when its slot key differs; fallback order", () => {
  const aliasT = target({ aliases: [{ pcFolder: "Alpha", deviceFolder: "Alpha Alias" }] });
  const { p } = goneFixture({ target: aliasT, probe: { Alpha: false, "Alpha Alias": true } });
  const rb = p.bySeriesKey.get("pc:Alpha").rebind;
  assert.deepStrictEqual(rb.choices.map((c) => [c.source, c.name, c.available]), [["previous", "Alpha", false], ["derived", "Alpha Alias", true]]);
  assert.deepStrictEqual([rb.chosen.name, rb.fellBack], ["Alpha Alias", true]);
  // Derived equal to previous by slot key is not listed.
  const same = goneFixture({ target: target({ aliases: [{ pcFolder: "Alpha", deviceFolder: "ALPHA" }] }) }).p;
  assert.deepStrictEqual(same.bySeriesKey.get("pc:Alpha").rebind.choices.map((c) => c.source), ["previous"]);
  // Both taken → verbatim PC folder name (here equal to previous) → held.
  const held = goneFixture({ probe: { Alpha: false } }).p;
  assert.deepStrictEqual([held.bySeriesKey.get("pc:Alpha").heldReason, held.anomalies.some((a) => a.kind === "name-taken")], ["name-taken", true]);
});

test("a case variant in the listing means the folder is present, not gone", () => {
  const { p } = goneFixture({ dirs: { alpha: [] }, probe: { Alpha: true } });
  const sp = p.bySeriesKey.get("pc:Alpha");
  assert.deepStrictEqual([sp.state, sp.deviceFolder], ["bound", "alpha"]);
  assert.deepStrictEqual(p.shardNameFixes, [{ shardId: "sh-alpha", name: "alpha" }]);
});

test("fallback order previous → derived → verbatim; a listed name is unavailable", () => {
  const s = series("Alpha (hid=1)", [f("Ch.001.cbz", 1)]);
  const sh = shard("sh-a", "Alpha Tab", s, [e("Ch.001.cbz", 1, "sha:Ch.001.cbz:1", 1)]);
  const p = plan({
    pc: pc([s]),
    // "alpha" is an unrelated device folder holding the derived name's slot.
    device: device({ alpha: [] }),
    view: view([sh]),
    opts: { gone: new Set(["sh-a"]), nameProbe: new Map([["Alpha Tab", false], ["Alpha", true], ["Alpha (hid=1)", true]]) },
  });
  const rb = p.bySeriesKey.get("pc:Alpha (hid=1)").rebind;
  assert.deepStrictEqual(rb.choices.map((c) => [c.source, c.available]), [["previous", false], ["derived", false]]);
  assert.deepStrictEqual([rb.chosen.source, rb.chosen.name, rb.fellBack], ["verbatim", "Alpha (hid=1)", true]);
});

test("a reserved previous name can't be taken by a new series", () => {
  const { s, entries } = boundAlpha(1);
  const sh = shard("sh-alpha", "Alpha", s, entries);
  const newcomer = series("Alpha (hid=other)", [f("Ch.001.cbz", 5)], { identityKey: "hid:mf:other" });
  // Alpha's series is gone from the PC too: its name stays reserved anyway.
  const p = plan({ pc: pc([newcomer]), device: device({}), view: view([sh]) });
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha (hid=other)").deviceFolder, "Alpha (hid=other)");
});

test("a gone series can't take another shard's reserved name", () => {
  // The alias points at an orphaned shard's name, absent from the device and
  // answering ENOENT: still reserved, so Alpha falls through to held.
  const s = boundAlpha(1).s;
  const sh = shard("sh-alpha", "Alpha", s, [e("Ch.001.cbz", 1001, "sha:Ch.001.cbz:1001", 1)]);
  const orphan = shard("sh-old", "Old Series", { identityKey: "hid:x:old", url: null, folder: "Old Series" }, []);
  const p = plan({
    target: target({ aliases: [{ pcFolder: "Alpha", deviceFolder: "Old Series" }] }),
    pc: pc([s]),
    device: device({}),
    view: view([sh, orphan]),
    opts: { gone: new Set(["sh-alpha"]), nameProbe: new Map([["Alpha", false], ["Old Series", true]]) },
  });
  const rb = p.bySeriesKey.get("pc:Alpha").rebind;
  assert.deepStrictEqual(rb.choices.map((c) => [c.name, c.available]), [["Alpha", false], ["Old Series", false]]);
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").heldReason, "name-taken");
});

test("rebind switch re-keys op ids; a stale stored name is unset; declined sticks", () => {
  const aliasT = target({ aliases: [{ pcFolder: "Alpha", deviceFolder: "Alpha Alias" }] });
  const probe = { Alpha: true, "Alpha Alias": true };
  const base = goneFixture({ target: aliasT, probe }).p;
  const ch = planner.applyRebind(base, {}, { shardId: "sh-alpha", source: "derived" });
  assert.ok(ch.ok);
  const switched = goneFixture({ target: aliasT, probe, selection: ch.rebinds }).p;
  assert.ok(switched.ops.has("push:Alpha Alias/Ch.001.cbz"));
  assert.ok(!switched.ops.has("push:Alpha/Ch.001.cbz"));
  assert.strictEqual(switched.bySeriesKey.get("pc:Alpha").rebind.fellBack, false);
  // The alias changed since: the stored name no longer matches → default.
  const stale = goneFixture({ target: target({ aliases: [{ pcFolder: "Alpha", deviceFolder: "Alpha Other" }] }), probe: { ...probe, "Alpha Other": true }, selection: ch.rebinds }).p;
  assert.strictEqual(stale.bySeriesKey.get("pc:Alpha").deviceFolder, "Alpha");
  const dec = planner.applyRebind(base, {}, { shardId: "sh-alpha", declined: true });
  const declined = goneFixture({ selection: dec.rebinds }).p;
  assert.ok(opsOf(declined, "pc:Alpha").every((o) => !o.preselected));
  assert.strictEqual(planner.applyRebind(base, {}, { shardId: "sh-alpha", source: "nope" }).code, "invalid");
});

test("record / identity / content matches leave the pushes unticked and offer Link", () => {
  const { p } = goneFixture({ dirs: { "Alpha Renamed": [["Ch.001.cbz", 1001, 1], ["Ch.002 - old.cbz", 1002, 1], ["Ch.003.cbz", 1003, 1]] } });
  const g = p.suggestions.find((x) => x.seriesKey === "pc:Alpha");
  assert.ok(g && g.strong && (g.tier === "record" || g.tier === "content"), JSON.stringify(g));
  assert.ok(opsOf(p, "pc:Alpha").every((o) => !o.preselected));
  // record specifically: kept names that the PC doesn't have, so content can't match.
  const { s } = boundAlpha(3);
  const entries = [e("A1.cbz", 11, "q1", 1), e("A2.cbz", 12, "q2", 1), e("A3.cbz", 13, "q3", 1)];
  const sh = shard("sh-alpha", "Alpha", s, entries);
  const p2 = plan({
    pc: pc([s]),
    device: device({ Moved: [["A1.cbz", 11, 1], ["A2.cbz", 12, 1], ["A3.cbz", 13, 1]] }),
    view: view([sh]),
    opts: { gone: new Set(["sh-alpha"]), nameProbe: new Map([["Alpha", true]]) },
  });
  assert.strictEqual(p2.suggestions[0].tier, "record");
});

test("mass repush: ≥50% of ≥10 bound folders gone needs an ack and hides Sync now", () => {
  const { p } = goneFixture({ otherBound: 9, goneOthers: 4 });
  assert.strictEqual(p.goneTotal.bound, 10);
  assert.strictEqual(p.goneTotal.gone, 5);
  const s = sel(p);
  const ev = planner.evaluateSelection(p, s);
  assert.deepStrictEqual([ev.massRepush.required, ev.massRepush.count], [true, 5]);
  assert.ok(planner.syncNowEligibility(p, s).reasons.includes("mass-repush"));
  const r = planner.reconcileForApply({ reviewed: p, fresh: p, storedOps: {} });
  assert.ok(r.blocking.some((b) => b.kind === "mass-repush"));
  assert.ok(planner.reconcileForApply({ reviewed: p, fresh: p, storedOps: {}, ackMassRepush: true }).ok);
  const few = goneFixture({ otherBound: 9, goneOthers: 3 }).p;
  assert.strictEqual(planner.evaluateSelection(few, sel(few)).massRepush.required, false);
});

test("Sync now: eligible under the previous name, not after a fallback", () => {
  const ok = goneFixture({ otherBound: 1 }).p;
  assert.deepStrictEqual(planner.syncNowEligibility(ok, sel(ok)), { eligible: true, reasons: [] });
  const summary = planner.promptSummary(ok, sel(ok));
  assert.deepStrictEqual(summary.removedOnDevice, [{ series: "Alpha", name: "Alpha", fellBack: false, files: 3, bytes: 1001 + 1002 + 1003 }]);
  const aliasT = target({ aliases: [{ pcFolder: "Alpha", deviceFolder: "Alpha Alias" }] });
  const fb = goneFixture({ target: aliasT, probe: { Alpha: false, "Alpha Alias": true }, otherBound: 1 }).p;
  assert.ok(planner.syncNowEligibility(fb, sel(fb)).reasons.includes("fallback-name"));
});

test("a gone folder whose PC series is absent plans nothing", () => {
  const { s, entries } = boundAlpha(2);
  const sh = shard("sh-alpha", "Alpha", s, entries);
  const p = plan({ pc: pc([series("Other", [f("Ch.001.cbz", 1)])]), device: device({}), view: view([sh]), opts: { gone: new Set(["sh-alpha"]) } });
  assert.ok(!p.bySeriesKey.has("pc:Alpha"));
  assert.ok([...p.ops.keys()].every((id) => !id.includes("Alpha/")));
  assert.strictEqual(p.goneTotal.gone, 0);
});

test("planning writes nothing: the view and its shards are untouched", () => {
  const fx = goneFixture();
  const before = JSON.stringify([...fx.args.view.shards[0].files.entries()]);
  plan(fx.args);
  assert.strictEqual(JSON.stringify([...fx.args.view.shards[0].files.entries()]), before);
  assert.strictEqual(fx.args.view.shards[0].name, "Alpha");
});

test("absent and not confirmed gone → held folder-unreadable, never guessed", () => {
  const { s, entries } = boundAlpha(1);
  const p = plan({ pc: pc([s]), device: device({}), view: view([shard("sh-alpha", "Alpha", s, entries)]) });
  assert.strictEqual(p.bySeriesKey.get("pc:Alpha").heldReason, "folder-unreadable");
  assert.strictEqual(p.ops.size, 0);
});

// ── rule 10, rule 13, refusals ───────────────────────────────────────────

console.log("rule 10, rule 13, refusals");

test("Sync now: pushes only, verified record, no suggestions or error anomalies", () => {
  const { s, entries, devFiles, sh } = boundAlpha(2);
  s.files.push(f("Ch.003.cbz", 3));
  const p = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([sh]) });
  assert.strictEqual(planner.syncNowEligibility(p, sel(p)).eligible, true);
  const first = plan({ pc: pc([s]), device: device({}), view: view([], { noHeader: true }) });
  assert.ok(planner.syncNowEligibility(first, sel(first)).reasons.includes("first-sync"));
  const del = deleteFixture();
  assert.ok(planner.syncNowEligibility(del.p, sel(del.p)).reasons.includes("selected-delete"));
  const sizeV = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries, { verifyMode: "adopt-size" })]) });
  assert.ok(planner.syncNowEligibility(sizeV, sel(sizeV)).reasons.includes("adopt-size-folder"));
  const nv = plan({ pc: pc([s]), device: device({ Alpha: devFiles }), view: view([shard("sh-alpha", "Alpha", s, entries, { verifiedAt: null })]) });
  assert.ok(planner.syncNowEligibility(nv, sel(nv)).reasons.includes("needs-verify"));
  const spy = series("SPY x FAMILY", [f("Ch.001.cbz", 1)]);
  const sug = plan({ pc: pc([s, spy]), device: device({ Alpha: devFiles, SPY_x_FAMILY: [] }), view: view([sh]) });
  assert.ok(planner.syncNowEligibility(sug, sel(sug)).reasons.includes("suggestions"));
  const longName = series("あ".repeat(90), [f("Ch.001.cbz", 1)]);
  const err = plan({ pc: pc([s, longName]), device: device({ Alpha: devFiles }), view: view([sh]) });
  assert.ok(planner.syncNowEligibility(err, sel(err)).reasons.includes("error-anomalies"));
  const acked = plan({ target: target({ acknowledged: [`name-too-long:pc:${"あ".repeat(90)}`] }), pc: pc([s, longName]), device: device({ Alpha: devFiles }), view: view([sh]) });
  assert.strictEqual(planner.syncNowEligibility(acked, sel(acked)).eligible, true);
});

test("one prompt covers several targets on one device", () => {
  const a = { targetId: "a", nothingToDo: false, syncNow: { eligible: true } };
  const b = { targetId: "b", nothingToDo: false, syncNow: { eligible: false } };
  const c = { targetId: "c", nothingToDo: true, syncNow: { eligible: true } };
  const card = planner.promptCard("S1", [a, b, c]);
  assert.deepStrictEqual(card.targets.map((t) => t.targetId), ["a", "b"]);
  assert.strictEqual(card.syncNow, false);
  assert.strictEqual(planner.promptCard("S1", [a]).syncNow, true);
  assert.strictEqual(planner.promptCard("S1", [c]).empty, true);
});

test("rule 13: a series that just finished downloading never shows synced", () => {
  const { s, sh } = boundAlpha(3);
  const v = view([sh]);
  const st = planner.libraryStatus({ pc: pc([s]), view: v, target: target() });
  assert.deepStrictEqual(st.get("/lib/Alpha"), { state: "synced", pending: 0 });
  const grown = { ...s, files: [...s.files, f("Ch.004.cbz", 4, null)] };
  assert.deepStrictEqual(planner.libraryStatus({ pc: pc([grown]), view: v, target: target() }).get("/lib/Alpha"), { state: "pending", pending: 1 });
  const other = series("Beta", [f("Ch.001.cbz", 1)]);
  assert.strictEqual(planner.libraryStatus({ pc: pc([other]), view: v, target: target() }).get("/lib/Beta").state, "absent");
  const { p } = goneFixture();
  const removed = planner.libraryStatus({ pc: pc([s]), view: v, target: target(), lastPlan: p });
  assert.deepStrictEqual(removed.get("/lib/Alpha"), { state: "removed", pending: 3, asOf: NOW });
});

test("refusals: missing or empty library, suspect listing", () => {
  const { sh } = boundAlpha(1);
  assert.strictEqual(plan({ pc: { ok: false, error: "ENOENT" }, device: device({}), view: view([sh]) }).code, "library-missing");
  assert.strictEqual(plan({ pc: pc([]), device: device({}), view: view([sh]) }).code, "library-missing");
  assert.ok(plan({ pc: pc([]), device: device({}), view: view([], { noHeader: true }) }).ok);
  assert.strictEqual(plan({ pc: pc([series("A", [f("Ch.001.cbz", 1)])]), device: device({}, { trusted: false }), view: view([sh]) }).code, "device-listing-suspect");
});

test("rule 7 sanity: a managed folder listing 0 files while its record holds entries", () => {
  const { s, sh } = boundAlpha(2);
  const p = plan({ pc: pc([s]), device: device({ Alpha: [] }), view: view([sh]) });
  assert.deepStrictEqual(p.sanity.map((x) => x.folder), ["Alpha"]);
  assert.ok(planner.reconcileForApply({ reviewed: p, fresh: p, storedOps: {} }).blocking.some((b) => b.kind === "listing-sanity"));
});

test("anomalies: reader-compat, format-mismatch, unparsed, size-mismatch; stable ids", () => {
  const s = series("Gamma", [f("Ch.001.cbz", 100), f("Ch.002.cbz", 100), f("Gamma Ch 3~5.pdf", 5), f("weird.cbz", 1)]);
  const sh = shard("sh-g", "Gamma", s, []);
  const p = plan({ pc: pc([s]), device: device({ Gamma: [["Ch.001.cbz", 10, 1]] }), view: view([sh]) });
  const kinds = p.anomalies.map((a) => a.kind).sort();
  assert.deepStrictEqual(kinds, ["format-mismatch", "reader-compat", "size-mismatch", "unparsed-files"]);
  const rc = p.anomalies.find((a) => a.kind === "reader-compat");
  assert.deepStrictEqual([rc.id, rc.data.issues], ["reader-compat:pc:Gamma", ["no-cover", "pdf"]]);
  assert.strictEqual(p.anomalies.find((a) => a.kind === "size-mismatch").data.direction, "device-smaller");
  assert.throws(() => analysis.makeAnomaly("typo", "k"));
});

// ── strips, detail, summary ──────────────────────────────────────────────

console.log("strips and detail");

test("chapter strip: run-length segments with delete winning its label", () => {
  const { p } = deleteFixture((c) => {
    c.s.files.push(f("Ch.013.cbz", 13));
  });
  const sp = p.bySeriesKey.get("pc:Alpha");
  const strip = planner.chapterStrip(p, sp, sel(p));
  assert.deepStrictEqual(strip.map((x) => [x.state, x.count]), [["synced", 1], ["delete", 1], ["synced", 10], ["push", 1]]);
});

test("series detail rows carry selection and loss; device-only detail", () => {
  const { p, d } = deleteFixture();
  const det = planner.seriesDetail(p, "pc:Alpha", sel(p));
  const row = det.rows.find((r) => r.opId === d.id);
  assert.deepStrictEqual([row.selected, row.loss, row.reason], [true, false, "replacement"]);
  assert.strictEqual(planner.seriesDetail(p, "pc:Nope", sel(p)).code, "invalid");
  const keep = boundAlpha(1);
  const p2 = plan({ pc: pc([keep.s]), device: device({ Alpha: keep.devFiles, Shelter: [["Ch.001.cbz", 5, 1]] }), view: view([keep.sh]) });
  const dd = planner.seriesDetail(p2, "dev:Shelter", sel(p2));
  assert.deepStrictEqual([dd.ok, dd.rows[0].label], [true, "1"]);
  const sum = planner.planSummary(p, sel(p));
  assert.strictEqual(sum.series[0].counts.delete, 1);
  assert.doesNotThrow(() => JSON.stringify(sum));
});

// ── job record ───────────────────────────────────────────────────────────

console.log("job record");

function fakeClock() {
  let t = 0;
  const pending = [];
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const h = { fn, at: t + ms };
        pending.push(h);
        return h;
      },
      clearTimeout(h) {
        const i = pending.indexOf(h);
        if (i !== -1) pending.splice(i, 1);
      },
    },
    advance(ms) {
      t += ms;
      for (const h of pending.slice()) {
        if (h.at <= t) {
          pending.splice(pending.indexOf(h), 1);
          h.fn();
        }
      }
    },
  };
}

test("one lane: busy refusal with the snapshot; stale runId dropped", () => {
  const sent = [];
  const clock = fakeClock();
  const jr = createJobRecord({ send: (c, p) => sent.push([c, p]), now: clock.now, timers: clock.timers });
  const a = jr.begin({ phase: "plan", targetId: "t1" });
  assert.ok(a.ok);
  const b = jr.begin({ phase: "apply", targetId: "t1" });
  assert.deepStrictEqual([b.ok, b.code, b.job.runId], [false, "busy", a.runId]);
  assert.ok(jr.finish(a.runId, { status: "completed" }));
  const c = jr.begin({ phase: "apply", targetId: "t1" });
  assert.strictEqual(jr.progress(a.runId, { filesDone: 1 }), false);
  assert.strictEqual(jr.finish(a.runId, { status: "completed" }), false);
  assert.ok(jr.needsQuitAsk());
  assert.ok(sent.every(([ch, p]) => ch === "sync-event" && p.kind === "job" && typeof p.runId === "number"));
  assert.strictEqual(jr.snapshot().job.runId, c.runId);
});

test("progress coalesces to ≤10/s, latest wins, finish supersedes it", () => {
  const sent = [];
  const clock = fakeClock();
  const jr = createJobRecord({ send: (c, p) => sent.push(p), now: clock.now, timers: clock.timers });
  const { runId } = jr.begin({ phase: "apply", targetId: "t1" });
  sent.length = 0;
  for (let i = 1; i <= 50; i += 1) {
    jr.progress(runId, { filesDone: i });
    clock.advance(5);
  }
  // 250 ms of updates every 5 ms → about 3 events, not 50.
  assert.ok(sent.length <= 4 && sent.length >= 2, `sent ${sent.length}`);
  clock.advance(COALESCE_MS);
  assert.strictEqual(sent[sent.length - 1].progress.filesDone, 50);
  jr.progress(runId, { filesDone: 51 });
  jr.finish(runId, { status: "cancelled" });
  clock.advance(1000);
  const last = sent[sent.length - 1];
  assert.deepStrictEqual([last.state, last.status], ["done", "cancelled"]);
  assert.throws(() => jr.begin({ phase: "nope" }));
});

test("auto-plan queue: FIFO, one per target, dropped on device removal", () => {
  const jr = createJobRecord({ send: () => {} });
  const { runId } = jr.begin({ phase: "verify", targetId: "x" });
  assert.ok(jr.enqueueAuto({ targetId: "t1", serial: "S1" }));
  assert.ok(!jr.enqueueAuto({ targetId: "t1", serial: "S1" }));
  assert.ok(jr.enqueueAuto({ targetId: "t2", serial: "S2" }));
  assert.ok(jr.enqueueAuto({ targetId: "t3", serial: "S1" }));
  assert.strictEqual(jr.takeNextAuto(), null);
  assert.strictEqual(jr.dropDevice("S1"), 2);
  jr.finish(runId, { status: "completed" });
  assert.strictEqual(jr.takeNextAuto().targetId, "t2");
  assert.strictEqual(jr.takeNextAuto(), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const x of failures) console.error(`\n${x.name}\n`, x.err);
  process.exitCode = 1;
}
