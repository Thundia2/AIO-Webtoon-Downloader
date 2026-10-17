// Offline test for UI-source/src/lib/chapterCoverage.js and the Search tab's
// coverage panel moved onto it (coverage plan C2,
// sync-temp/plans/find-sources-coverage.md).
// Run: node tools/_test_chapter_coverage.js   (from anywhere)
//
// Two oracles, both against the panel as it was BEFORE the split (git
// ORACLE_REF, default ecf8ec7 = the last commit before the split, file
// UI-source/src/components/SearchChapterMap.jsx):
//   1. markup: the old and the new component are bundled together (esbuild,
//      `@` → src like vite.config.js), both forced open (useState(false) →
//      true on load), rendered with react-dom/server, and the HTML must be
//      byte-identical for every map below EXCEPT the counts that changed on
//      purpose in C3 (user call 2026-10-17: "282 main +3" replaces "285 main /
//      286 entries", the header likewise): withoutCounts() blanks those spans
//      on both sides, and the new count text is asserted separately.
//   2. numbers: the old component's matrix + siteStats computation, copied
//      here verbatim, must equal coverageModel's per-site fields.
// Maps: the live multi-source payload saved in C1
// (tools/fixtures/search-torture-princess-multisource.json), the gallery's
// synthetic maps (src/dev/sync-fixtures/tab.json find rows: low match, empty
// list, licensed run, gaps), and edge cases built here.
// Then the count (main / extras) and the strip helpers: coverageRuns /
// coverageGaps / gapLabels / coverageLabel / mainCountTitle.
//
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const UI = path.join(ROOT, "UI-source");
const esbuild = require(path.join(UI, "node_modules", "esbuild"));
const REF = process.env.ORACLE_REF || "ecf8ec7";

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

// The old SearchChapterMap's numbers, verbatim (minus React).
function oldNumbers(chapterMap, buildBuckets) {
  const siteSet = new Set();
  const presence = {};
  const officialAt = {};
  const numSet = new Set();
  for (const entry of chapterMap.chapters) {
    numSet.add(entry.chapter_num);
    for (const s of entry.sources || []) {
      siteSet.add(s.site);
      if (!presence[s.site]) presence[s.site] = new Set();
      presence[s.site].add(entry.chapter_num);
      if (s.is_official) {
        if (!officialAt[s.site]) officialAt[s.site] = new Set();
        officialAt[s.site].add(entry.chapter_num);
      }
    }
  }
  const sites = [...siteSet].sort();
  const totalAligned = chapterMap.total_chapters_aligned || chapterMap.chapters.length;
  const collapseApplied = !!chapterMap.collapse_splits_applied;
  const effectiveAligned = chapterMap.effective_chapters_aligned ?? totalAligned;
  const siteStats = sites.map((site) => {
    const ch = presence[site]?.size || 0;
    const off = officialAt[site]?.size || 0;
    const diag = chapterMap.merge_diagnostics?.[site] || {};
    const totalChapters = diag.total_chapters ?? ch;
    const effective = diag.effective_chapters ?? totalChapters;
    const compatibility = diag.compatibility;
    const buckets = buildBuckets(diag.breakdown, collapseApplied);
    return { site, ch, totalChapters, effective, off, compatibility, buckets, present: [...(presence[site] || [])], official: [...(officialAt[site] || [])] };
  });
  return {
    chapterNums: [...numSet].sort((a, b) => a - b),
    totalAligned,
    effectiveAligned,
    hasInflation: effectiveAligned !== totalAligned,
    headlineDropped: Math.max(0, totalAligned - effectiveAligned),
    siteStats,
  };
}

// The per-site count is the first span of each summary row's stats div; the
// header count is the span with the header's classes. Both may hold one level
// of nested spans. Replaced by a marker on both sides so the rest compares.
const STATS_DIV = '<div class="flex items-center gap-2 text-[10px] tabular-nums flex-wrap">';
const SPAN = "<span[^>]*>(?:[^<]|<span[^>]*>[^<]*</span>)*</span>";
function withoutCounts(html) {
  return html
    .replace(new RegExp(`${STATS_DIV.replace(/[[\]]/g, "\\$&")}${SPAN}`, "g"), `${STATS_DIV}<COUNT/>`)
    .replace(new RegExp(`<span class="text-xs text-muted-foreground tabular-nums"[^>]*>(?:[^<]|<span[^>]*>[^<]*</span>)*</span>`, "g"), "<HEADCOUNT/>");
}
const text = (html) => html.replace(/<[^>]+>/g, "");

const diag = (o = {}) => ({ total_chapters: 3, effective_chapters: 3, compatibility: 1, breakdown: {}, ...o });
const entry = (n, ...sites) => ({ chapter_num: n, chapter_label: String(n), sources: sites.map((s) => (typeof s === "string" ? { site: s, is_official: false } : s)) });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aio-cov-"));
  const oldSrc = execFileSync("git", ["show", `${REF}:UI-source/src/components/SearchChapterMap.jsx`], { cwd: ROOT, encoding: "utf8" });
  if (!/function buildBuckets/.test(oldSrc)) {
    console.error(`${REF} doesn't hold the pre-split panel (no buildBuckets in SearchChapterMap.jsx); set ORACLE_REF`);
    process.exit(2);
  }
  const oldFile = path.join(tmp, "OldSearchChapterMap.jsx");
  fs.writeFileSync(oldFile, oldSrc);
  const entryFile = path.join(tmp, "entry.jsx");
  fs.writeFileSync(
    entryFile,
    `import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Old from ${JSON.stringify(oldFile.replace(/\\/g, "/"))};
import New from "@/components/SearchChapterMap";
export * from "@/lib/chapterCoverage";
export const renderOld = (m) => renderToStaticMarkup(<Old chapterMap={m} />);
export const renderNew = (m) => renderToStaticMarkup(<New chapterMap={m} />);
`
  );
  const forceOpen = {
    name: "force-open",
    setup(b) {
      b.onLoad({ filter: /SearchChapterMap\.jsx$/ }, (a) => ({
        contents: fs.readFileSync(a.path, "utf8").replace("useState(false)", "useState(true)"),
        loader: "jsx",
      }));
    },
  };
  const out = path.join(tmp, "bundle.cjs");
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: out,
    jsx: "automatic",
    alias: { "@": path.join(UI, "src") },
    nodePaths: [path.join(UI, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [forceOpen],
    logLevel: "error",
  });
  const M = require(out);
  fs.rmSync(tmp, { recursive: true, force: true });

  const maps = [];
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "fixtures", "search-torture-princess-multisource.json"), "utf8"));
  maps.push(["live 'Tis Time (7 sites, collapse on)", live.winner_chapter_map]);
  const TAB = require(path.join(UI, "src", "dev", "sync-fixtures", "tab.json")).data;
  for (const r of TAB.find.rows) {
    const m = r.candidates && r.candidates[0] && r.candidates[0].chapterMap;
    if (m) maps.push([`gallery ${r.folder}`, m]);
  }
  check("fixtures: the live map and both gallery maps are present", maps.length === 3, `${maps.length} maps`);
  maps.push(["edge: collapse off, decimals, no merge_diagnostics", { collapse_splits_applied: false, effective_chapters_aligned: 3, total_chapters_aligned: 4, chapters: [entry(0, "a"), entry(1, "a", "b"), entry(1.1, "a"), entry(2, "b")] }]);
  maps.push(["edge: breakdown chips every kind, collapse off", { collapse_splits_applied: false, chapters: [entry(1, "a", "b")], merge_diagnostics: { a: diag({ breakdown: { consensus_side_stories: 1, safe_decimals: 2, prologue_count: 1, source_only_latest: 1, source_only_orphans: 1, merged_split_fragments: 3, fragments_dropped: 2 } }), b: diag({ compatibility: 0.5, effective_chapters: 2 }) } }]);
  maps.push(["edge: licensed, an empty-list site, a zero-overlap low match", { collapse_splits_applied: true, effective_chapters_aligned: 2, chapters: [entry(1, { site: "a", is_official: true }, "b"), entry(2, "a")], merge_diagnostics: { a: diag({ role: "anchor" }), b: diag(), e: diag({ total_chapters: 0, effective_chapters: 0, compatibility: 0, skipped_reason: "empty chapter list" }), z: diag({ total_chapters: 40, compatibility: 0, skipped_reason: "compatibility 0% below 50% threshold; only overlapping chapters merged" }) } }]);
  maps.push(["edge: no chapters", { chapters: [] }]);

  for (const [label, m] of maps) {
    const a = M.renderOld(m);
    const b = M.renderNew(m);
    const a0 = withoutCounts(a);
    const b0 = withoutCounts(b);
    check(`markup identical outside the counts: ${label} (${a.length} chars)`, a0 === b0, firstDiff(a0, b0));
    if (m.chapters.length) {
      const nCounts = (a0.match(/<COUNT\/>/g) || []).length;
      check(`${label}: every summary row and the header had a count blanked`, nCounts === M.coverageModel(m).sites.filter((x) => x.ch > 0).length && (a0.match(/<HEADCOUNT\/>/g) || []).length === 1, `${nCounts} rows`);
    }
    if (!m.chapters.length) {
      check(`${label}: renders nothing`, a === "" && b === "");
      continue;
    }
    const o = oldNumbers(m, M.buildBuckets);
    const n = M.coverageModel(m);
    const drawn = n.sites.filter((s) => s.ch > 0);
    eq(`numbers: ${label}`, {
      chapterNums: n.chapterNums,
      totalAligned: n.totalAligned,
      effectiveAligned: n.effectiveAligned,
      hasInflation: n.hasInflation,
      headlineDropped: n.headlineDropped,
      siteStats: drawn.map((s) => ({ site: s.site, ch: s.ch, totalChapters: s.total, effective: s.effective, off: s.off, compatibility: s.compatibility, buckets: s.buckets, present: [...s.present], official: [...s.official] })),
    }, o);
  }

  // ── Model extras: sites the old panel never drew, flags ──
  const edge = M.coverageModel(maps.find(([l]) => l.startsWith("edge: licensed"))[1]);
  eq("every diagnosed site is in the model, alphabetical", edge.sites.map((s) => s.site), ["a", "b", "e", "z"]);
  eq("flags: anchor / empty / lowMatch", [edge.anchorSite, edge.sites.map((s) => [s.site, s.empty, s.lowMatch, s.ch])], ["a", [["a", false, false, 2], ["b", false, false, 1], ["e", true, false, 0], ["z", false, true, 0]]]);
  eq("no map → null", [M.coverageModel(null), M.coverageModel({}), M.coverageModel({ chapters: "x" })], [null, null, null]);
  const lm = M.coverageModel(live.winner_chapter_map);
  eq("live: anchor and counts", [lm.anchorSite, lm.totalAligned, lm.effectiveAligned, lm.sites.length], ["mangafire", 295, 292, 7]);

  // ── The count: main + extras (user call 2026-10-17) ──
  // Live: every site but mangadex (3 side stories only) carries the same 282
  // main chapters; extras = effective − main, the decimals each site keeps.
  eq(
    "live: [site, main, extras]",
    lm.sites.map((s) => [s.site, s.main, s.extras]),
    [["atsumaru", 282, 3], ["mangadex", 3, 0], ["mangafire", 282, 7], ["mangahub", 282, 6], ["mangakatana", 282, 3], ["mangapill", 282, 3], ["weebcentral", 282, 3]],
  );
  eq("live: header main / extras", [lm.mainAligned, lm.extrasAligned], [282, 10]);
  const liveHtml = text(M.renderNew(live.winner_chapter_map));
  check("live: the header reads 282 main +10 extras", /· 282 main \+10 extras/.test(liveHtml), liveHtml.slice(0, 160));
  check("live: mangafire's row reads 282 main +7", /mangafire282 main \+7/.test(liveHtml), liveHtml.slice(0, 400));
  check("live: mangadex's row has no extras", /mangadex3 main(?! \+)/.test(liveHtml));
  eq("main falls back to the distinct floors of what the site carries (no diagnostics)", M.coverageModel(maps.find(([l]) => l.startsWith("edge: collapse off"))[1]).sites.map((s) => [s.site, s.main, s.extras]), [["a", 2, 1], ["b", 2, 0]]);
  eq("count tooltip", M.mainCountTitle(M.siteCoverage(lm, "weebcentral")), "282 main chapters + 3 extras (side stories kept beyond one entry per chapter) · 286 entries listed");
  eq("count tooltip without extras", M.mainCountTitle(M.siteCoverage(lm, "mangadex")), "3 main chapters · 3 entries listed");

  // ── Strip helpers ──
  const csm = M.coverageModel(maps.find(([l]) => l === "gallery Chainsaw Man")[1]);
  const site = (k) => M.siteCoverage(csm, k);
  // weebcentral's 97.5 side story is on the axis, so every other site misses it.
  eq("gaps: mangapill's scattered gaps, capped at 3", M.gapLabels(csm, site("mangapill")), { labels: ["37", "60-61", "81"], more: 1 });
  eq("gaps: a larger cap", M.gapLabels(csm, site("mangapill"), 5), { labels: ["37", "60-61", "81", "97.5"], more: 0 });
  eq("gaps: a missing side story joins its neighbour's range", M.gapLabels(csm, site("mangadex")), { labels: ["97-98"], more: 0 });
  eq("gaps: the anchor has none", M.gapLabels(csm, site("weebcentral")), { labels: [], more: 0 });
  eq("gaps: a trailing range", M.gapLabels(csm, site("mangafire")).labels, ["97.5", "181"]);
  eq("runs: licensed chapters split the run", M.coverageRuns(csm, site("mangadex")).map((r) => [csm.chapterNums[r.from], csm.chapterNums[r.to], r.official]), [[1, 3, true], [4, 96, false], [99, 181, false]]);
  for (const s of [...csm.sites, ...lm.sites]) {
    const model = csm.sites.includes(s) ? csm : lm;
    const back = new Set(M.coverageRuns(model, s).flatMap((r) => model.chapterNums.slice(r.from, r.to + 1)));
    const off = new Set(M.coverageRuns(model, s).filter((r) => r.official).flatMap((r) => model.chapterNums.slice(r.from, r.to + 1)));
    check(`runs round-trip: ${s.site}`, back.size === s.present.size && [...s.present].every((x) => back.has(x)) && off.size === s.official.size && [...s.official].every((x) => off.has(x)));
  }
  const gapNums = (s) => M.coverageGaps(csm, s).map((g) => [csm.chapterNums[g.from], csm.chapterNums[g.to]]);
  eq("gap runs: mangapill", gapNums(site("mangapill")), [[37, 37], [60, 61], [81, 81], [97.5, 97.5]]);
  for (const s of csm.sites) {
    const cells = new Set([...M.coverageRuns(csm, s), ...M.coverageGaps(csm, s)].flatMap((r) => Array.from({ length: r.to - r.from + 1 }, (_, k) => r.from + k)));
    const nRuns = M.coverageRuns(csm, s).length + M.coverageGaps(csm, s).length;
    check(`runs + gaps tile the axis once: ${s.site}`, cells.size === csm.chapterNums.length && M.coverageRuns(csm, s).reduce((t, r) => t + r.to - r.from + 1, 0) + M.coverageGaps(csm, s).reduce((t, r) => t + r.to - r.from + 1, 0) === csm.chapterNums.length, `${cells.size} cells, ${nRuns} runs`);
  }
  eq("strip label: gaps capped, licensed", M.coverageLabel(csm, site("mangadex")), "179 of 182 chapters, missing 97-98, 3 licensed");
  eq("strip label: more than three ranges", M.coverageLabel(csm, site("mangapill")), "177 of 182 chapters, missing 37, 60-61, 81 and 1 more");
  eq("strip label: complete", M.coverageLabel(csm, site("weebcentral")), "182 of 182 chapters");
  eq("helpers tolerate a missing site", [M.coverageRuns(csm, null), M.coverageGaps(csm, null), M.gapLabels(csm, null), M.coverageLabel(csm, null), M.mainCountTitle(null), M.siteCoverage(csm, "nope")], [[], [], { labels: [], more: 0 }, "", "", null]);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall chapter coverage checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return `first difference at ${i}: old …${a.slice(Math.max(0, i - 60), i + 60)}… new …${b.slice(Math.max(0, i - 60), i + 60)}…`;
}
