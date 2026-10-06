// ============================================================
// DEVICE SYNC — READER PROFILES AND TARGET CONFIG (pure)
//
// Owns what a target mirrors and how its fields default:
//   * PROFILES — which chapter formats and sidecars a reader reads;
//   * resolveTargetConfig(target) — every per-target field filled in. A null
//     field means "profile default", so switching a target's profile
//     propagates instead of freezing the old profile's values;
//   * isMirrored / isChapterFormat / isSidecar — the per-file questions the
//     planner asks;
//   * validateTarget — what sync:config-op refuses (root containment, field
//     sets);
//   * recordIdentity / recordIdentityChanged — parent rule 12: a record
//     describes one place, so a device, root, volume or profile change clears
//     it (service.js writes a new recordEpoch).
//
// Read by: planner.js, service.js (config ops), pc-inventory.js.
// The Komikku facts come from sync-temp/plans/komikkuspec.md (LocalSource).
// ============================================================

const path = require("path");
const { NAMING_POLICIES } = require("./naming");

// Every archive a reader might treat as a chapter. Unclaimed device files of
// these types are delete candidates whatever the profile mirrors (parent
// rule 4); anything else on the device is unmanaged and never offered.
const CHAPTER_FORMATS = Object.freeze(["pdf", "cbz", "zip", "cbr", "rar", "epub"]);

const SIDECAR_NAMES = Object.freeze(["cover.jpg", "details.json"]);

// CompareManga sync_to_tablet SIDECARS: AIO bookkeeping removed from every
// managed device folder before its pushes. Dot-files only (validateTarget):
// a mirrored name here would be deleted and re-pushed on every sync.
const DEFAULT_CLEANUP_NAMES = Object.freeze([".aio_series.json", ".mangafire_hid", ".series_hid", ".cover.webp"]);

const PROFILES = Object.freeze({
  // Komikku/Mihon LocalSource: archives plus cover.jpg and details.json; PDF
  // isn't a LocalSource format, a "~" decimal breaks its ChapterRecognition,
  // and a series without cover.jpg shows no cover.
  komikku: Object.freeze({
    formats: Object.freeze(["cbz", "zip", "cbr", "rar", "epub"]),
    sidecars: Object.freeze(["cover.jpg", "details.json"]),
    nomedia: true,
    flags: Object.freeze({ pdf: true, tilde: true, missingCover: true }),
  }),
  // Perfect Viewer and other folder readers: every chapter format, cover only.
  generic: Object.freeze({
    formats: CHAPTER_FORMATS,
    sidecars: Object.freeze(["cover.jpg"]),
    nomedia: false,
    flags: Object.freeze({}),
  }),
  // Formats and sidecars come from the target itself.
  custom: Object.freeze({
    formats: Object.freeze([]),
    sidecars: Object.freeze([]),
    nomedia: false,
    flags: Object.freeze({}),
  }),
});

const TARGET_KINDS = Object.freeze(["adb", "folder"]);
const SELECTION_MODES = Object.freeze(["all-except", "only"]);

function _arr(v) {
  return Array.isArray(v) ? v.slice() : [];
}

/**
 * Every per-target field resolved. The returned object is what the planner
 * and executor read; the stored target keeps its nulls.
 */
function resolveTargetConfig(target) {
  const t = target && typeof target === "object" ? target : {};
  const profileId = PROFILES[t.profile] ? t.profile : "generic";
  const p = PROFILES[profileId];
  const formats = Array.isArray(t.formats) && t.formats.length ? t.formats : p.formats;
  const sidecars = Array.isArray(t.sidecars) ? t.sidecars : p.sidecars;
  return {
    id: t.id,
    name: t.name || "",
    kind: TARGET_KINDS.includes(t.kind) ? t.kind : "folder",
    serial: t.serial || null,
    root: t.root || "",
    volumeId: t.volumeId == null ? null : t.volumeId,
    profile: profileId,
    formats: formats.map((f) => String(f).toLowerCase()),
    sidecars: sidecars.slice(),
    flags: p.flags,
    nomedia: typeof t.nomedia === "boolean" ? t.nomedia : p.nomedia,
    namingPolicy: NAMING_POLICIES.includes(t.namingPolicy) ? t.namingPolicy : "strip-hid",
    renameToMatch: t.renameToMatch === true,
    cleanupNames: Array.isArray(t.cleanupNames) ? t.cleanupNames.slice() : DEFAULT_CLEANUP_NAMES.slice(),
    selection: SELECTION_MODES.includes(t.selection) ? t.selection : "all-except",
    only: _arr(t.only),
    excludes: _arr(t.excludes),
    aliases: _arr(t.aliases),
    ignoredSuggestions: _arr(t.ignoredSuggestions),
    acknowledged: _arr(t.acknowledged),
  };
}

function _ext(name) {
  const m = String(name).match(/\.([^./\\]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function isChapterFormat(name) {
  return CHAPTER_FORMATS.includes(_ext(name));
}

// Sidecar names are exact: Komikku looks for "cover.jpg", not "Cover.JPG".
function isSidecar(name, cfg) {
  return cfg.sidecars.includes(String(name));
}

/** True when a depth-1 PC file is part of what this target mirrors. */
function isMirrored(name, cfg) {
  const n = String(name);
  if (!n || n.startsWith(".")) return false;
  return isSidecar(n, cfg) || cfg.formats.includes(_ext(n));
}

/**
 * True when `child` is `parent` or lies inside it. `platform` picks the path
 * flavor so the test suite can check Windows rules on Linux; Windows paths
 * compare case-insensitively, as NTFS does.
 */
function pathContains(parent, child, platform) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const fold = (s) => (platform === "win32" ? s.toLowerCase() : s);
  const a = fold(P.resolve(String(parent)));
  const b = fold(P.resolve(String(child)));
  if (a === b) return true;
  const rel = P.relative(a, b);
  return !!rel && !rel.startsWith("..") && !P.isAbsolute(rel);
}

/**
 * Field errors for a target about to be saved (sync:config-op add-target /
 * update-target). Empty array when valid.
 *
 * A folder target's root may not be inside, or contain, the library root or
 * userData: a target at <library>/_mirror would copy the library into itself
 * on every sync, and one containing userData would mirror into the app's own
 * state (non-UI plan, review #20).
 *
 * @param {object} target
 * @param {{libraryRoot?:string, userDataDir?:string, platform?:string}} ctx
 * @returns {Array<{field:string, message:string}>}
 */
function validateTarget(target, ctx) {
  const errors = [];
  const t = target || {};
  const c = ctx || {};
  const platform = c.platform || process.platform;
  if (!TARGET_KINDS.includes(t.kind)) errors.push({ field: "kind", message: "kind must be adb or folder" });
  if (!PROFILES[t.profile]) errors.push({ field: "profile", message: "pick a reader profile" });
  if (!t.root || typeof t.root !== "string") {
    errors.push({ field: "root", message: "pick the folder to sync into" });
  } else if (t.kind === "adb") {
    if (!t.root.startsWith("/") || /[\x00\r\n]/.test(t.root) || t.root.split("/").includes("..")) {
      errors.push({ field: "root", message: "the device folder must be an absolute path without '..'" });
    }
    if (!t.serial) errors.push({ field: "serial", message: "pick a device" });
  } else if (t.kind === "folder") {
    for (const [label, other] of [["the library", c.libraryRoot], ["the app's data folder", c.userDataDir]]) {
      if (!other) continue;
      if (pathContains(other, t.root, platform) || pathContains(t.root, other, platform)) {
        errors.push({ field: "root", message: `the sync folder can't be inside or contain ${label}` });
      }
    }
  }
  if (t.profile === "custom") {
    const f = Array.isArray(t.formats) ? t.formats : [];
    if (!f.length) errors.push({ field: "formats", message: "a custom profile needs at least one chapter format" });
  }
  if (Array.isArray(t.formats) && t.formats.some((f) => !CHAPTER_FORMATS.includes(String(f).toLowerCase()))) {
    errors.push({ field: "formats", message: `formats must be among ${CHAPTER_FORMATS.join(", ")}` });
  }
  if (Array.isArray(t.sidecars) && t.sidecars.some((s) => !SIDECAR_NAMES.includes(s))) {
    errors.push({ field: "sidecars", message: `sidecars must be among ${SIDECAR_NAMES.join(", ")}` });
  }
  if (
    Array.isArray(t.cleanupNames) &&
    t.cleanupNames.some((n) => typeof n !== "string" || !n.startsWith(".") || n.includes("/") || n.length < 2)
  ) {
    errors.push({ field: "cleanupNames", message: "cleanup names must be dot-files" });
  }
  if (t.namingPolicy != null && !NAMING_POLICIES.includes(t.namingPolicy)) {
    errors.push({ field: "namingPolicy", message: "unknown naming policy" });
  }
  if (t.selection != null && !SELECTION_MODES.includes(t.selection)) {
    errors.push({ field: "selection", message: "unknown series selection mode" });
  }
  return errors;
}

/**
 * The fields a record header pins (parent rule 3 / rule 12): a record is
 * only meaningful for this kind, device or folder (and its volume), root and
 * profile. canonicalRoot is measured by the transport and compared
 * separately.
 */
function recordIdentity(target) {
  const t = target || {};
  return {
    kind: t.kind || null,
    serial: t.kind === "adb" ? t.serial || null : null,
    root: t.root || null,
    volumeId: t.kind === "folder" && t.volumeId != null ? String(t.volumeId) : null,
    profile: t.profile || null,
  };
}

/** Rule 12: true when an edit moves the target to another place or reader. */
function recordIdentityChanged(before, after) {
  const a = recordIdentity(before);
  const b = recordIdentity(after);
  return a.kind !== b.kind || a.serial !== b.serial || a.root !== b.root || a.profile !== b.profile;
}

module.exports = {
  CHAPTER_FORMATS,
  SIDECAR_NAMES,
  DEFAULT_CLEANUP_NAMES,
  PROFILES,
  TARGET_KINDS,
  SELECTION_MODES,
  resolveTargetConfig,
  isChapterFormat,
  isSidecar,
  isMirrored,
  pathContains,
  validateTarget,
  recordIdentity,
  recordIdentityChanged,
};
