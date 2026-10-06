// Offline regression for UI-source/electron/series-merge.js.
//
// This is the one module in the app that DELETES user data, so every guard
// gets a test: containment, identity, live-download refusal, and the
// never-overwrite rule. Runs against real temp folders (the module is
// filesystem code — mocking fs would test the mock).
//
//   node tools/_test_series_merge.js
//
// tools/ is gitignored and not shipped; this is the local fast loop, same as
// tools/_test_update_check_record.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  mergeSeriesFolders,
  mergeSeriesMetaObjects,
  planFolderMerge,
} = require("../UI-source/electron/series-merge.js");

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aio-merge-"));
}

function mkSeries(root, name, { chapters = [], meta = {}, extra = {}, imageChapters = [] } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of chapters) {
    fs.writeFileSync(path.join(dir, `Ch.${String(c).padStart(3, "0")}.cbz`), `chapter ${c}`);
  }
  for (const c of imageChapters) {
    const cdir = path.join(dir, "images", `Chapter_${c}`);
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "0001.webp"), "page");
  }
  for (const [file, body] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, file), body);
  }
  if (meta !== null) {
    fs.writeFileSync(path.join(dir, ".series_hid"), String(meta.hid || "H"));
    fs.writeFileSync(
      path.join(dir, ".aio_series.json"),
      JSON.stringify(
        {
          url: "https://mangadex.org/title/544240b7",
          hid: "544240b7",
          site: "mangadex",
          chapters_downloaded: chapters.map(String),
          ...meta,
        },
        null,
        2
      )
    );
  }
  return dir;
}

const readMeta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".aio_series.json"), "utf8"));
const ls = (dir) => fs.readdirSync(dir).sort();

// ── the real-world case ───────────────────────────────────────────────────

async function main() {
  console.log("series-merge");

  await test("merges a rename fork: files move, metadata unions, husk removed", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "Isekai de Slow Life o (Ganbou)", {
      chapters: Array.from({ length: 59 }, (_, i) => i + 1),
      meta: { title: "Isekai de Slow Life o (Ganbou)", last_downloaded_at: "2026-05-23T21:08:45Z" },
    });
    const fork = mkSeries(root, "Isekai de Slow Life wo (Ganbou)", {
      chapters: [60, 61, 62, 63, 64],
      meta: { title: "Isekai de Slow Life wo (Ganbou)", last_downloaded_at: "2026-08-20T00:18:41Z" },
      extra: { "cover.jpg": "COVER", "details.json": "{}" },
    });

    const res = await mergeSeriesFolders({
      targetFolder: target,
      sourceFolders: [fork],
      dryRun: false,
      libraryRoot: root,
    });

    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.chaptersBefore, 59);
    assert.strictEqual(res.chaptersAfter, 64);
    assert.deepStrictEqual(res.removed, [fork]);
    assert.ok(!fs.existsSync(fork), "husk folder should be gone");

    const files = ls(target);
    for (const c of [1, 59, 60, 64]) {
      assert.ok(files.includes(`Ch.${String(c).padStart(3, "0")}.cbz`), `Ch ${c} missing`);
    }
    assert.ok(files.includes("cover.jpg"), "cover.jpg should move in (target had none)");
    assert.ok(files.includes("details.json"), "details.json should move in");

    const meta = readMeta(target);
    assert.strictEqual(meta.chapters_downloaded.length, 64);
    assert.strictEqual(meta.hid, "544240b7", "identity stays the target's");
    // Freshest member wins the display fields — for a rename fork that IS the fork.
    assert.strictEqual(meta.title, "Isekai de Slow Life wo (Ganbou)");
  });

  await test("dry run touches absolutely nothing", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1, 2] });
    const fork = mkSeries(root, "A renamed", { chapters: [3] });
    const before = { t: ls(target), f: ls(fork) };

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: true, libraryRoot: root,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.dryRun, true);
    assert.deepStrictEqual(res.plans[0].moves, ["Ch.003.cbz"]);
    assert.strictEqual(res.plans[0].willRemoveSource, true);
    assert.strictEqual(res.chaptersAfter, 3);
    assert.deepStrictEqual(ls(target), before.t, "target unchanged");
    assert.deepStrictEqual(ls(fork), before.f, "source unchanged");
  });

  await test("dryRun defaults to true when omitted", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const fork = mkSeries(root, "A2", { chapters: [2] });
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], libraryRoot: root,
    });
    assert.strictEqual(res.dryRun, true);
    assert.ok(fs.existsSync(path.join(fork, "Ch.002.cbz")), "nothing moved");
  });

  // ── never overwrite ─────────────────────────────────────────────────────

  await test("a chapter in both folders is a collision: source copy survives", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1, 2] });
    const fork = mkSeries(root, "A2", { chapters: [2, 3] });
    fs.writeFileSync(path.join(fork, "Ch.002.cbz"), "FORK COPY");

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: false, libraryRoot: root,
    });

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.plans[0].collisions, ["Ch.002.cbz"]);
    assert.strictEqual(
      fs.readFileSync(path.join(target, "Ch.002.cbz"), "utf8"), "chapter 2",
      "target's copy must not be overwritten"
    );
    assert.ok(fs.existsSync(fork), "source kept: it still holds a colliding file");
    assert.deepStrictEqual(res.kept, [fork]);
    assert.ok(fs.existsSync(path.join(target, "Ch.003.cbz")), "non-colliding chapter still moved");
  });

  // The bug a dry run against the real library caught: filename matching alone
  // is not enough, because the SAME series does not keep one naming style.
  await test("same chapter under a DIFFERENT filename is still a collision", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [] });
    // Titled style, as the older half of the real fork was written.
    fs.writeFileSync(path.join(target, "Ch.060 - Learning Alchemy.cbz"), "TARGET");
    const fork = mkSeries(root, "A2", { chapters: [60] }); // bare "Ch.060.cbz"

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: false, libraryRoot: root,
    });

    assert.deepStrictEqual(res.plans[0].collisions, ["Ch.060.cbz"]);
    assert.deepStrictEqual(res.plans[0].moves, []);
    assert.ok(!fs.existsSync(path.join(target, "Ch.060.cbz")), "must not land a second copy");
    assert.ok(fs.existsSync(fork), "source kept — it still holds the duplicate");
  });

  await test("two sources holding the same chapter: only the first moves", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const forkA = mkSeries(root, "A2", { chapters: [2] });
    const forkB = mkSeries(root, "A3", { chapters: [2, 3] });

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [forkA, forkB], dryRun: true, libraryRoot: root,
    });

    assert.deepStrictEqual(res.plans[0].moves, ["Ch.002.cbz"]);
    assert.deepStrictEqual(res.plans[1].collisions, ["Ch.002.cbz"], "second source sees the claim");
    assert.deepStrictEqual(res.plans[1].moves, ["Ch.003.cbz"]);
  });

  await test("a combined range file blocks the chapters it already covers", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [], meta: { chapters_downloaded: [] } });
    fs.writeFileSync(path.join(target, "A Ch 1-50.pdf"), "COMBINED");
    const fork = mkSeries(root, "A2", { chapters: [] });
    fs.writeFileSync(path.join(fork, "A Ch 25.pdf"), "single");
    fs.writeFileSync(path.join(fork, "A Ch 60.pdf"), "single");

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: true, libraryRoot: root,
    });
    assert.deepStrictEqual(res.plans[0].collisions, ["A Ch 25.pdf"], "25 is inside 1-50");
    assert.deepStrictEqual(res.plans[0].moves, ["A Ch 60.pdf"]);
  });

  await test("image chapter dirs collide on number, not on directory spelling", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { imageChapters: ["5"], meta: { chapters_downloaded: ["5"] } });
    const fork = mkSeries(root, "A2", { imageChapters: ["5.0", "6"], meta: { chapters_downloaded: ["5", "6"] } });

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: true, libraryRoot: root,
    });
    assert.deepStrictEqual(res.plans[0].collisions, ["images/Chapter_5.0"]);
    assert.deepStrictEqual(res.plans[0].moves, ["images/Chapter_6"]);
  });

  await test("an unrecognized file keeps the source folder alive", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const fork = mkSeries(root, "A2", { chapters: [2], extra: { "notes.txt": "mine" } });

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: false, libraryRoot: root,
    });

    assert.deepStrictEqual(res.plans[0].leftovers, ["notes.txt"]);
    assert.strictEqual(res.plans[0].willRemoveSource, false);
    assert.ok(fs.existsSync(path.join(fork, "notes.txt")), "unknown file untouched");
    assert.ok(fs.existsSync(path.join(target, "Ch.002.cbz")), "chapter still moved");
  });

  await test("a redundant cover is dropped, not moved, and does not block removal", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1], extra: { "cover.jpg": "TARGET COVER" } });
    const fork = mkSeries(root, "A2", { chapters: [2], extra: { "cover.jpg": "FORK COVER" } });

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: false, libraryRoot: root,
    });

    assert.deepStrictEqual(res.plans[0].redundant, ["cover.jpg"]);
    assert.strictEqual(fs.readFileSync(path.join(target, "cover.jpg"), "utf8"), "TARGET COVER");
    assert.ok(!fs.existsSync(fork), "redundant singletons must not keep the husk alive");
  });

  await test("image-only series merge one chapter dir at a time", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { imageChapters: [1, 2], meta: { chapters_downloaded: ["1", "2"] } });
    const fork = mkSeries(root, "A2", { imageChapters: [2, 3], meta: { chapters_downloaded: ["2", "3"] } });

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: false, libraryRoot: root,
    });

    assert.deepStrictEqual(res.plans[0].moves, ["images/Chapter_3"]);
    assert.deepStrictEqual(res.plans[0].collisions, ["images/Chapter_2"]);
    assert.ok(fs.existsSync(path.join(target, "images", "Chapter_3", "0001.webp")));
    assert.ok(fs.existsSync(path.join(fork, "images", "Chapter_2")), "collision stays put");
  });

  // ── refusals ────────────────────────────────────────────────────────────

  await test("refuses a folder outside the library root", async () => {
    const root = mkRoot();
    const elsewhere = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const outside = mkSeries(elsewhere, "B", { chapters: [2] });

    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [outside], dryRun: false, libraryRoot: root,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "outside_library");
    assert.ok(fs.existsSync(path.join(outside, "Ch.002.cbz")));
  });

  await test("refuses a nested path that is not a direct child of the root", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const nested = path.join(root, "A", "images");
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [nested], dryRun: true, libraryRoot: root,
    });
    assert.strictEqual(res.error, "outside_library");
  });

  await test("refuses two unrelated series", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const other = mkSeries(root, "B", {
      chapters: [1],
      meta: { url: "https://mangadex.org/title/OTHER", hid: "OTHER", site: "mangadex" },
    });
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [other], dryRun: false, libraryRoot: root,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "identity_mismatch");
    assert.ok(fs.existsSync(path.join(other, "Ch.001.cbz")));
  });

  await test("refuses a same-hid pair from DIFFERENT sites", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1], meta: { hid: "gvHMj", site: "atsumaru", url: "https://atsu.moe/manga/gvHMj" } });
    const other = mkSeries(root, "B", { chapters: [2], meta: { hid: "gvHMj", site: "comix", url: "https://comix.to/title/gvHMj-x" } });
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [other], dryRun: true, libraryRoot: root,
    });
    assert.strictEqual(res.error, "identity_mismatch");
  });

  await test("allows a cross-provider pair that shares an anilist_id", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "No More Love With the Girls", {
      chapters: [1],
      meta: { url: "https://mangakatana.com/manga/x.1", hid: "x.1", site: "mangakatana", anilist_id: 146858 },
    });
    const other = mkSeries(root, "Rom-Com", {
      chapters: [2],
      meta: { url: "https://atsu.moe/manga/kVGsS", hid: "kVGsS", site: "atsumaru", anilist_id: 146858 },
    });
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [other], dryRun: true, libraryRoot: root,
    });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.deepStrictEqual(res.plans[0].moves, ["Ch.002.cbz"]);
  });

  await test("refuses while a download for this series is running", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const fork = mkSeries(root, "A2", { chapters: [2] });
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: false, libraryRoot: root,
      // www./trailing slash differences must still match — same page.
      runningDownloads: [{ title: "A", url: "https://www.mangadex.org/title/544240b7/" }],
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "download_running");
    assert.ok(fs.existsSync(path.join(fork, "Ch.002.cbz")));
  });

  await test("refuses when a running download's URL is unknown", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const fork = mkSeries(root, "A2", { chapters: [2] });
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: true, libraryRoot: root,
      runningDownloads: [{ title: "something", url: "" }],
    });
    assert.strictEqual(res.error, "download_running");
  });

  await test("an unrelated running download does not block the merge", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const fork = mkSeries(root, "A2", { chapters: [2] });
    const res = await mergeSeriesFolders({
      targetFolder: target, sourceFolders: [fork], dryRun: false, libraryRoot: root,
      runningDownloads: [{ title: "Other", url: "https://mangadex.org/title/UNRELATED" }],
    });
    assert.strictEqual(res.ok, true);
    assert.ok(!fs.existsSync(fork));
  });

  await test("refuses missing folders, empty input, and target-as-source", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    assert.strictEqual(
      (await mergeSeriesFolders({ targetFolder: target, sourceFolders: [], libraryRoot: root })).error,
      "no_sources"
    );
    assert.strictEqual(
      (await mergeSeriesFolders({ sourceFolders: [target], libraryRoot: root })).error,
      "no_target"
    );
    assert.strictEqual(
      (await mergeSeriesFolders({ targetFolder: target, sourceFolders: [target], libraryRoot: root })).error,
      "target_is_source"
    );
    assert.strictEqual(
      (await mergeSeriesFolders({
        targetFolder: target, sourceFolders: [path.join(root, "nope")], libraryRoot: root,
      })).error,
      "missing_folder"
    );
    assert.strictEqual(
      (await mergeSeriesFolders({ targetFolder: target, sourceFolders: [target] })).error,
      "no_library_root"
    );
  });

  // ── metadata merge ──────────────────────────────────────────────────────

  await test("metadata: unions chapters, keeps target identity, takes freshest display", () => {
    const merged = mergeSeriesMetaObjects(
      {
        url: "https://a/1", hid: "H", site: "mangadex", title: "Old",
        chapters_downloaded: ["1", "2"], status: "Releasing",
        last_downloaded_at: "2026-01-01T00:00:00Z",
        total_available_at_download: 10,
      },
      [
        {
          url: "https://a/1", hid: "H", site: "mangadex", title: "New",
          chapters_downloaded: ["3"], status: "Finished",
          last_downloaded_at: "2026-08-20T00:00:00Z",
          total_available_at_download: null,
          anilist_id: 115455,
        },
      ]
    );
    assert.deepStrictEqual(merged.chapters_downloaded, ["1", "2", "3"]);
    assert.strictEqual(merged.hid, "H");
    assert.strictEqual(merged.title, "New");
    assert.strictEqual(merged.status, "Finished");
    assert.strictEqual(merged.anilist_id, 115455);
    assert.strictEqual(merged.total_available_at_download, 10, "largest KNOWN total wins over null");
  });

  await test("metadata: normalizes labels and sorts numerically", () => {
    const merged = mergeSeriesMetaObjects(
      { chapters_downloaded: ["4.0", "10", "2"] },
      [{ chapters_downloaded: [4, "5.50", "extra"] }]
    );
    assert.deepStrictEqual(merged.chapters_downloaded, ["2", "4", "5.5", "10", "extra"]);
  });

  await test("metadata: skipped/ignored stay disjoint from downloaded", () => {
    const merged = mergeSeriesMetaObjects(
      { chapters_downloaded: ["1"], chapters_skipped_fragments: ["1.1"], chapters_ignored: ["2"] },
      [{ chapters_downloaded: ["1.1", "2"], chapters_ignored: ["3"] }]
    );
    assert.deepStrictEqual(merged.chapters_downloaded, ["1", "1.1", "2"]);
    assert.deepStrictEqual(merged.chapters_skipped_fragments, [], "1.1 is downloaded now");
    assert.deepStrictEqual(merged.chapters_ignored, ["3"], "2 is downloaded now");
  });

  await test("metadata: an emptied chapters_ignored drops the key entirely", () => {
    const merged = mergeSeriesMetaObjects(
      { chapters_downloaded: ["1"], chapters_ignored: ["1"] }, [{}]
    );
    assert.ok(!("chapters_ignored" in merged));
  });

  await test("metadata: final_file_chapters unions per format", () => {
    const merged = mergeSeriesMetaObjects(
      { final_file_chapters: { cbz: ["1", "2"] } },
      [{ final_file_chapters: { cbz: ["3"], pdf: ["1"] } }]
    );
    assert.deepStrictEqual(merged.final_file_chapters, { cbz: ["1", "2", "3"], pdf: ["1"] });
  });

  await test("metadata: all-unknown totals stay null rather than becoming 0", () => {
    const merged = mergeSeriesMetaObjects({ total_available_at_download: null }, [{}]);
    assert.strictEqual(merged.total_available_at_download, null);
  });

  // ── plan shape ──────────────────────────────────────────────────────────

  await test("plan: metadata/marker files are neither moved nor leftovers", async () => {
    const root = mkRoot();
    const target = mkSeries(root, "A", { chapters: [1] });
    const fork = mkSeries(root, "A2", { chapters: [2] });
    fs.writeFileSync(path.join(fork, ".mangafire_hid"), "544240b7");
    const plan = await planFolderMerge(target, fork);
    assert.deepStrictEqual(plan.moves.map((m) => m.name), ["Ch.002.cbz"]);
    assert.deepStrictEqual(plan.leftovers, []);
    assert.strictEqual(plan.canRemoveSource, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.error(`\n${f.name}\n`, f.err);
    process.exitCode = 1;
  }
}

main();
