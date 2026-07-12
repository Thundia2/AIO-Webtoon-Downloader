#!/usr/bin/env node
// ============================================================
// CI DATE-BASED APP VERSION — single source of truth.
//
// Prints the app version for the HEAD commit, derived from its
// COMMITTER timestamp in UTC:
//
//     YYYY.MDD.HMM
//     └┬─┘ └┬┘ └┬┘
//      │    │   └── hour*100 + minute  (23:34 → 2334, 00:05 → 5)
//      │    └────── month*100 + day    (Jul 12 → 712, Dec 31 → 1231)
//      └─────────── UTC year           (2026)
//
// e.g. a commit at 2026-07-12 23:34 UTC → 2026.712.2334
//
// Consumed by .github/workflows/release.yml twice (grep
// ci-date-version): the build jobs stamp it into package.json
// before electron-builder runs (so app.getVersion() and the
// latest*.yml update feeds both carry it), and the release job
// names auto-generated draft tags with it. The repo's checked-in
// package.json version (2.0.0) is never bumped — local
// `npm run dist:*` builds keep it, and only CI builds are
// releases. Cross-file: UI-source/electron/updater.js compares
// stamped version vs stamped version via semver; release tag
// names play no part (they're labels — any naming works).
//
// Why this exact shape:
//   - Valid semver by construction: month*100+day is 101..1231
//     and hour*100+minute is 0..2359, emitted as plain integers,
//     so no component ever has a leading zero (semver forbids
//     them — "2026.07.12" would be invalid and electron-updater
//     would reject the feed).
//   - NOT one big YYYYMMDD major (20260712.x.y): Windows version
//     resources (NSIS VIProductVersion) cap each dotted component
//     at 65535, which 20260712 blows past. 2026 / 1231 / 2359
//     all fit.
//   - NOT a prerelease suffix for the time part: semver sorts
//     prereleases LOWER than the release ("2026.712.0-2334" <
//     "2026.712.0"), which would invert update ordering.
//   - Committer time (%ct), not build time: all three release
//     matrix platforms derive the same version from the same
//     commit with no cross-job coordination, and rebuilding an
//     old commit reproduces its version instead of minting a
//     fake-newer one — a rebuild is not an update. Committer
//     time (unlike author time) is set at merge, so successive
//     release commits on main have increasing versions and
//     electron-updater's gt() sees each new release. Two release
//     commits in the same UTC minute would collide; real release
//     cadence makes that moot.
//   - Any date version > 2.x, so installs from the static-2.0.0
//     era all see the first date-based release as an update.
// ============================================================

const { execSync } = require("child_process");

// Test seam: tools/_test_date_version.js drives the formula with fixed
// epochs through this override. CI never sets it.
const raw =
  process.env.AIO_DATE_VERSION_EPOCH ||
  execSync("git log -1 --format=%ct", { encoding: "utf8" }).trim();
const epoch = Number(raw);
if (!Number.isInteger(epoch) || epoch <= 0) {
  console.error(`ci-date-version: bad committer timestamp: ${JSON.stringify(raw)}`);
  process.exit(1);
}

const d = new Date(epoch * 1000);
const version = [
  d.getUTCFullYear(),
  (d.getUTCMonth() + 1) * 100 + d.getUTCDate(),
  d.getUTCHours() * 100 + d.getUTCMinutes(),
].join(".");

// Tripwire, not a validator: the arithmetic above cannot produce a
// leading zero or an out-of-range component, so if this fires, an edit
// broke the script itself. npm version's strict semver parsing is the
// second backstop in the workflow.
if (!/^\d{4}\.[1-9]\d{2,3}\.(0|[1-9]\d{0,3})$/.test(version)) {
  console.error(`ci-date-version: computed '${version}' is not the expected YYYY.MDD.HMM shape`);
  process.exit(1);
}

console.log(version);
