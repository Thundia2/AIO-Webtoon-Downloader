// Offline regression test for UI-source/scripts/ci-date-version.js —
// the date-based app version stamped by .github/workflows/release.yml.
// Run: node tools/_test_date_version.js   (from the repo root or tools/)
//
// Drives the REAL script through its AIO_DATE_VERSION_EPOCH test seam
// (no formula duplication here — if the script drifts, this fails), then
// validates the outputs with the exact semver copy electron-updater
// resolves at runtime, so "valid + correctly ordered" means what the
// installed app will conclude, not what some other semver version would.

const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "UI-source", "scripts", "ci-date-version.js");

let semver;
try {
  // electron-updater's own copy (7.x) — the comparator that actually runs.
  semver = require(path.join(ROOT, "UI-source", "node_modules", "electron-updater", "node_modules", "semver"));
} catch {
  semver = require(path.join(ROOT, "UI-source", "node_modules", "semver"));
}

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function runScript(epoch) {
  return execFileSync("node", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, AIO_DATE_VERSION_EPOCH: String(epoch) },
  }).trim();
}

function runScriptExpectFail(epoch) {
  try {
    execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AIO_DATE_VERSION_EPOCH: String(epoch) },
    });
    return false; // should have exited nonzero
  } catch {
    return true;
  }
}

console.log("[1] fixed-epoch formula cases (UTC)");
const CASES = [
  [Date.UTC(2026, 0, 5, 0, 5) / 1000, "2026.105.5", "Jan 5 00:05 — leading-zero traps in month, hour, minute"],
  [Date.UTC(2026, 6, 12, 0, 0) / 1000, "2026.712.0", "Jul 12 midnight — zero patch"],
  [Date.UTC(2026, 6, 12, 23, 34) / 1000, "2026.712.2334", "Jul 12 23:34 — the doc example"],
  [Date.UTC(2026, 9, 1, 9, 7) / 1000, "2026.1001.907", "Oct 1 09:07 — 4-digit minor"],
  [Date.UTC(2026, 11, 31, 23, 59) / 1000, "2026.1231.2359", "Dec 31 23:59 — max components"],
  [Date.UTC(2027, 0, 1, 0, 0) / 1000, "2027.101.0", "Jan 1 00:00 — year rollover"],
];
const got = [];
for (const [epoch, expected, why] of CASES) {
  const v = runScript(epoch);
  got.push(v);
  check(`${why}: ${v}`, v === expected, `expected ${expected}`);
}

console.log("[2] semver validity (electron-updater's semver " + (semver.SEMVER_SPEC_VERSION || "?") + ")");
for (const v of got) {
  check(`valid('${v}')`, semver.valid(v) === v);
}

console.log("[3] strict ordering — each release must beat everything before it");
const chain = ["2.0.0", ...got]; // CASES are chronological; 2.0.0 = the static pre-date-era version
for (let i = 1; i < chain.length; i++) {
  check(`gt('${chain[i]}', '${chain[i - 1]}')`, semver.gt(chain[i], chain[i - 1]));
}

console.log("[4] prerelease-suffix inversion (the rejected design) really inverts");
check(
  "'2026.712.0-2334' sorts BELOW '2026.712.0' (why time is NOT a prerelease)",
  semver.lt("2026.712.0-2334", "2026.712.0")
);

console.log("[5] NSIS VIProductVersion bound — every dotted component <= 65535");
for (const v of got) {
  const parts = v.split(".").map(Number);
  check(`components of ${v} fit 16-bit`, parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 65535));
}

console.log("[6] garbage epochs fail loudly");
for (const bad of ["abc", "0", "-5", "12.5"]) {
  check(`epoch '${bad}' → nonzero exit`, runScriptExpectFail(bad));
}

console.log("[7] real repo HEAD (no override) — shape only");
const real = execFileSync("node", [SCRIPT], { encoding: "utf8", cwd: ROOT }).trim();
check(
  `HEAD version '${real}' matches YYYY.MDD.HMM and is valid semver`,
  /^\d{4}\.[1-9]\d{2,3}\.(0|[1-9]\d{0,3})$/.test(real) && semver.valid(real) === real
);
check(`HEAD version '${real}' > 2.0.0`, semver.gt(real, "2.0.0"));

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
