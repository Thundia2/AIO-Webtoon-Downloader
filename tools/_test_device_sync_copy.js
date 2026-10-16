// Drift guard for the Device Sync copy map.
// Run: node tools/_test_device_sync_copy.js   (from anywhere)
//
// UI-source/src/components/sync/copy.js turns every code the sync backend
// sends into words. This pins that it has an entry for every code the
// backend can emit, read from the backend itself:
//   - exported lists (profiles, naming, contract, planner, analysis,
//     adb/wire.js, sync-settings presets) must equal the copy keys;
//   - lists the backend never exports (warning kinds, blocked-refusal kinds,
//     adb candidate sources, link tiers) are scraped from the source at the
//     exact construction sites (`warnings.push({ kind: "…"`, …), so a new
//     kind at one of those sites fails here;
//   - op reasons and job reasons are checked one way only (every copy key
//     appears in the backend source): they are built in too many shapes to
//     scrape reliably. A new reason there shows on screen as its raw code
//     until copy.js gains it.
//   - the custom-reader defaults equal profiles.js PROFILES.custom.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UI = path.join(ROOT, "UI-source");
const SYNC = path.join(UI, "electron", "sync");
const profiles = require(path.join(SYNC, "profiles.js"));
const naming = require(path.join(SYNC, "naming.js"));
const contract = require(path.join(SYNC, "contract.js"));
const planner = require(path.join(SYNC, "planner.js"));
const analysis = require(path.join(SYNC, "analysis.js"));
const wire = require(path.join(SYNC, "adb", "wire.js"));
const { SYNC_SETTING_SPECS } = require(path.join(SYNC, "sync-settings.js"));

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function sameSet(label, actual, expected) {
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  const missing = e.filter((x) => !a.includes(x));
  const extra = a.filter((x) => !e.includes(x));
  check(label, !missing.length && !extra.length, `missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`);
}
const src = (f) => fs.readFileSync(path.join(SYNC, f), "utf8");
const scrape = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

(async () => {
  const code = fs.readFileSync(path.join(UI, "src", "components", "sync", "copy.js"), "utf8");
  check("copy.js is import-free", !/^\s*import\s/m.test(code));
  const c = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  const keysOf = (fn, list, ...args) => list.filter((k) => fn(k, ...args) != null);

  // Exported lists.
  sameSet("reader presets", Object.keys(c.PROFILE_COPY), profiles.PROFILE_IDS);
  check("reader order", JSON.stringify(c.PROFILE_ORDER) === JSON.stringify(profiles.PROFILE_IDS));
  sameSet("removal policies", Object.keys(c.DELETE_POLICY_COPY), profiles.DELETE_POLICIES);
  sameSet("selection modes", Object.keys(c.SELECTION_MODE_COPY), profiles.SELECTION_MODES);
  sameSet("stored verify modes", Object.keys(c.VERIFY_MODE_COPY), profiles.STORED_VERIFY_MODES);
  sameSet("kinds", Object.keys(c.KIND_COPY), profiles.TARGET_KINDS);
  sameSet("naming policies", Object.keys(c.NAMING_POLICY_COPY), naming.NAMING_POLICIES);
  sameSet("hash modes", Object.keys(c.HASH_MODE_COPY), SYNC_SETTING_SPECS.syncHashMode.presets);
  sameSet("chapter formats", c.CHAPTER_FORMATS, profiles.CHAPTER_FORMATS);
  sameSet("sidecars", c.SIDECAR_NAMES, profiles.SIDECAR_NAMES);
  check("default clean-up names", JSON.stringify(c.DEFAULT_CLEANUP_NAMES) === JSON.stringify(profiles.DEFAULT_CLEANUP_NAMES));
  const custom = profiles.resolveTargetConfig({ profile: "custom" });
  for (const k of ["formats", "sidecars", "nomedia", "namingPolicy", "renameToMatch", "cleanupNames"]) {
    const a = c.CUSTOM_DEFAULTS[k];
    const e = custom[k];
    const same = Array.isArray(e) ? JSON.stringify([...a].sort()) === JSON.stringify([...e].sort()) : a === e;
    check(`custom default ${k}`, same, `got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`);
  }
  sameSet("refusal titles", keysOf(c.refusalTitle, contract.REFUSAL_CODES, "T"), contract.REFUSAL_CODES);
  sameSet("series states (every state known)", Object.keys({ bound: 1, "needs-verify": 1, new: 1, gone: 1, held: 1 }), planner.SERIES_STATES);
  sameSet("held reasons", keysOf(c.heldReasonCopy, planner.HELD_REASONS, "T"), planner.HELD_REASONS);
  sameSet("tags", Object.keys(c.TAG_COPY), analysis.TAG_KINDS);
  sameSet("anomaly kinds", keysOf(c.anomalyCopy, Object.keys(analysis.ANOMALY_KINDS), "T"), Object.keys(analysis.ANOMALY_KINDS));
  sameSet("tablet states", Object.keys(c.DEVICE_STATE_COPY), [...wire.DEVICE_STATES, "no-permissions"]);
  sameSet("op kinds with reasons", Object.keys(c.OP_REASONS), contract.OP_KINDS);

  // Scraped at their construction sites.
  const warnSrc = ["prepare.js", "planner.js", "executor.js", "pc-inventory.js"].map(src).join("\n");
  const warnKinds = scrape(warnSrc, /warnings\.push\(\{\s*kind:\s*"([a-z-]+)"/g);
  check("found warning sites", warnKinds.length > 10, String(warnKinds.length));
  sameSet("warning kinds", warnKinds.filter((k) => c.warningCopy({ kind: k }, "T") != null), warnKinds);
  const blockSrc = ["planner.js", "service.js", "executor.js"].map(src).join("\n");
  const blockKinds = [
    ...scrape(blockSrc, /blocking\.push\(\{\s*kind:\s*"([a-z-]+)"/g),
    ...scrape(blockSrc, /blocking:\s*\[\{\s*kind:\s*"([a-z-]+)"/g),
  ];
  sameSet("blocked-refusal kinds", c.BLOCKING_KINDS, blockKinds);
  const locate = src(path.join("adb", "locate.js"));
  // The candidate list's documented union (locate.js @returns); the add()
  // calls build paths with nested parentheses, too awkward to scrape.
  const union = (locate.match(/source:((?:'[A-Za-z_]+'\|?)+)\}/) || [])[1] || "";
  const sources = scrape(union, /'([A-Za-z_]+)'/g);
  for (const sname of sources) check(`adb source ${sname} is produced in locate.js`, locate.includes(`"${sname}"`));
  sameSet("adb candidate sources", Object.keys(c.ADB_SOURCE_COPY), sources);
  const tierLine = (src("planner.js").match(/const TIER_ORDER = Object\.freeze\(\[([^\]]*)\]\)/) || [])[1] || "";
  sameSet("link suggestion tiers", Object.keys(c.SUGGESTION_TIER_COPY), scrape(tierLine, /"([a-z-]+)"/g));
  const stripSrc = src("planner.js");
  for (const s of Object.keys(c.STRIP_STATE_COPY)) check(`strip state ${s} exists in planner.js`, stripSrc.includes(`"${s}"`));

  // One-way: every copy key is a string the backend actually uses.
  const all = fs.readdirSync(SYNC).filter((f) => f.endsWith(".js")).map(src).join("\n");
  for (const [kind, reasons] of Object.entries(c.OP_REASONS)) {
    for (const r of reasons) {
      check(`op reason ${kind}/${r} has copy and exists`, c.opReasonCopy(kind, r, "T") != null && all.includes(`"${r}"`));
    }
  }
  for (const r of c.JOB_REASONS) check(`job reason ${r} exists in the backend`, all.includes(`"${r}"`) && c.jobReasonCopy(r, "T") !== r);
  for (const r of Object.keys(c.SKIP_REASON_COPY)) check(`skip reason ${r} exists`, all.includes(`"${r}"`));

  if (failures) {
    console.error(`\n${failures} copy check(s) failed`);
    process.exit(1);
  }
  console.log("\nall copy checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
