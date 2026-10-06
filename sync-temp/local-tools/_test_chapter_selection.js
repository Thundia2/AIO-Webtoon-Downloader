// Offline regression test for the two pure helpers behind the update-check's
// per-chapter controls:
//   - utils.chaptersToRangeString(chapters, { excluding })
//   - ChapterChips.selectedChapters(chapters, deselected)
// Run: node tools/_test_chapter_selection.js   (from the repo root or tools/)
//
// Both are driven from the REAL sources (imports stripped, no logic copied
// here), so drift fails this rather than passing quietly.
//
// WHY THE RANGE SPLITTING MATTERS ENOUGH TO PIN: the string these produce is
// not a label, it is the `--chapters` argument, and aio-dl.py's
// is_chapter_wanted reads "10-11" as a CLOSED INTERVAL. A run that merges 10
// and 11 therefore also downloads a 10.5 sitting between them — which is
// exactly the chapter the user just crossed out or unticked. Section [2] is
// that bug; the rest guard the promise that nothing else changed.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UTILS = path.join(ROOT, "UI-source", "src", "lib", "utils.js");
const CHIPS = path.join(ROOT, "UI-source", "src", "components", "ChapterChips.jsx");

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

// ── Load chaptersToRangeString out of the real utils.js ──────────────────
// The module's own imports (clsx / tailwind-merge) are only reachable from
// `cn`, which nothing here calls, so dropping the import lines is enough to
// evaluate the file.
function loadRangeFn() {
  let src = fs.readFileSync(UTILS, "utf8");
  const before = src;
  src = src.replace(/^import\s.*$/gm, "");
  if (src === before) {
    throw new Error("utils.js no longer opens with imports — update this harness");
  }
  if (!/export function chaptersToRangeString/.test(src)) {
    throw new Error("utils.js no longer exports chaptersToRangeString — update this harness");
  }
  src = src.replace(/^export /gm, "");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn chaptersToRangeString;`)();
}

// ── Load selectedChapters out of the real ChapterChips.jsx ───────────────
// The rest of that file is JSX and won't parse here, so slice from the
// function's own marker to the end (it is deliberately the last export).
function loadSelectFn() {
  const src = fs.readFileSync(CHIPS, "utf8");
  const marker = "export function selectedChapters";
  const at = src.indexOf(marker);
  if (at === -1) {
    throw new Error("ChapterChips.jsx no longer exports selectedChapters last — update this harness");
  }
  const body = src.slice(at).replace(/^export /, "");
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn selectedChapters;`)();
}

const chaptersToRangeString = loadRangeFn();
const selectedChapters = loadSelectFn();

// ── 1. Unchanged without exclusions ──────────────────────────────────────
// Every pre-existing caller passes no options, so these must read exactly as
// they did before `excluding` existed.
console.log("\n[1] no exclusions — byte-identical to the old behavior");
{
  eq("empty", chaptersToRangeString([]), "");
  eq("missing", chaptersToRangeString(null), "");
  eq("single", chaptersToRangeString(["7"]), "7");
  eq("a run collapses", chaptersToRangeString(["51", "52", "53"]), "51-53");
  eq("gaps split", chaptersToRangeString(["51", "52", "53", "55", "60"]), "51-53, 55, 60");
  eq("decimals join their neighbor", chaptersToRangeString(["60", "60.1"]), "60-60.1");
  eq("unsorted input is sorted", chaptersToRangeString(["9", "3", "10"]), "3, 9-10");
  eq("numbers work like strings", chaptersToRangeString([3, 9, 10]), "3, 9-10");
  eq("an empty excluding list changes nothing",
     chaptersToRangeString(["51", "52", "53"], { excluding: [] }), "51-53");
}

// ── 2. THE BUG: a range must never span an excluded chapter ──────────────
console.log("\n[2] exclusions cut ranges");
{
  // 10 and 11 would merge; 10.5 sits between them and must not be swept up.
  eq("a crossed-out decimal splits the run",
     chaptersToRangeString(["10", "11"], { excluding: ["10.5"] }), "10, 11");
  check("...and the un-excluded form really did merge",
        chaptersToRangeString(["10", "11"]) === "10-11");

  eq("only the straddled pair splits",
     chaptersToRangeString(["10", "11", "12", "13"], { excluding: ["10.5"] }), "10, 11-13");
  eq("several exclusions cut several times",
     chaptersToRangeString(["10", "11", "12", "13"], { excluding: ["10.5", "12.5"] }),
     "10, 11-12, 13");
  eq("an exclusion outside every run is inert",
     chaptersToRangeString(["10", "11", "12"], { excluding: ["99"] }), "10-12");
  eq("an exclusion below the first chapter is inert",
     chaptersToRangeString(["10", "11"], { excluding: ["1"] }), "10-11");

  // Endpoints: an excluded value EQUAL to a selected one means the caller
  // handed us contradictory lists. The selection wins (strict inequalities),
  // because dropping a chapter the caller explicitly asked to download would
  // be the worse failure.
  eq("an exclusion equal to an endpoint does not split",
     chaptersToRangeString(["10", "11"], { excluding: ["10"] }), "10-11");

  // Non-numeric junk in `excluding` is dropped rather than turning every
  // comparison into NaN (which would silently disable all splitting).
  eq("unparseable exclusions are ignored, not fatal",
     chaptersToRangeString(["10", "11"], { excluding: ["extra", null] }), "10-11");
  eq("...and don't mask a real one",
     chaptersToRangeString(["10", "11"], { excluding: ["extra", "10.5"] }), "10, 11");

  // The real shape from the panel: chapter 22.1 crossed out between 22 and 23.
  eq("a live-shaped case",
     chaptersToRangeString(["21", "22", "23"], { excluding: ["22.1"] }), "21-22, 23");
}

// ── 3. selectedChapters ──────────────────────────────────────────────────
console.log("\n[3] selectedChapters");
{
  eq("no deselection → everything", selectedChapters(["1", "2", "3"]), ["1", "2", "3"]);
  eq("an empty Set → everything",
     selectedChapters(["1", "2", "3"], new Set()), ["1", "2", "3"]);
  eq("deselected chapters drop out",
     selectedChapters(["1", "2", "3"], new Set(["2"])), ["1", "3"]);
  eq("everything deselected → empty",
     selectedChapters(["1", "2"], new Set(["1", "2"])), []);
  eq("a deselection for a chapter that isn't offered is inert",
     selectedChapters(["1", "2"], new Set(["9"])), ["1", "2"]);
  eq("no chapters → empty", selectedChapters([], new Set(["1"])), []);
  eq("missing chapters → empty", selectedChapters(null), []);

  const src = ["1", "2", "3"];
  const out = selectedChapters(src);
  out.push("4");
  eq("the result is a copy, not the caller's array", src, ["1", "2", "3"]);
}

// ── 4. The two composed, as the queue paths use them ──────────────────────
// LibraryTab.buildDownloadArgsForRow builds `excluding` from (offered minus
// selected) plus the crossed-out list, then feeds both to the range builder.
// This reproduces that so the seam itself is pinned, not just the halves.
console.log("\n[4] composed: what a queue click actually sends");
{
  // 10.5 is crossed out and sits BETWEEN two ticked chapters — the only
  // arrangement in which a compact range would leak. 12 is merely unticked and
  // sits past the end, where it costs nothing.
  const offered = ["10", "11", "12"];
  const ignored = ["10.5"];
  const deselected = new Set(["12"]);

  const selected = selectedChapters(offered, deselected);
  eq("ticked chapters", selected, ["10", "11"]);

  const excluding = [...offered.filter((c) => !selected.includes(c)), ...ignored];
  eq("exclusions are unticked + crossed out", excluding, ["12", "10.5"]);

  eq("the straddling cross-out forces the split",
     chaptersToRangeString(selected, { excluding }), "10, 11");

  // And the whole point: neither excluded chapter is inside the spec.
  const spec = chaptersToRangeString(selected, { excluding });
  const covers = (spec, n) =>
    spec.split(",").some((part) => {
      const p = part.trim();
      if (p.includes("-")) {
        const [lo, hi] = p.split("-").map(Number);
        return n >= lo && n <= hi;
      }
      return Number(p) === n;
    });
  check("the crossed-out 10.5 is NOT covered", !covers(spec, 10.5));
  check("the unticked 12 is NOT covered", !covers(spec, 12));
  check("the ticked 10 IS covered", covers(spec, 10));
  check("the ticked 11 IS covered", covers(spec, 11));
}

console.log(
  failures === 0
    ? "\nAll chapter-selection checks passed."
    : `\n${failures} check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
