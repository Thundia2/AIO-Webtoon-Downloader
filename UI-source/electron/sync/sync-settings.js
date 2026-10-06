// ============================================================
// DEVICE SYNC — GLOBAL SETTINGS (pure)
//
// Owns the seven global sync settings: their defaults, the presets the UI may
// offer (SYNC_SETTING_SPECS), and resolveSyncSettings(saved), which turns
// whatever settings.json holds into a complete, valid set. Per-target fields
// live in sync-targets.json and resolve in profiles.js.
//
// NOT IN get-settings YET: service.js reads history.getSettings() and resolves
// here. The UI pass adds these keys to main.js's get-settings together with
// SettingsTab.jsx's DEFAULT_SETTINGS and a twin test; adding them earlier
// would let every Settings Save persist defaults the UI pass may still
// change (non-UI plan, "Settings and presets"; history.js's
// appAutoUpdate migration is that cost paid once already).
//
// Read by: service.js, planner.js (deletePolicy, sizeWarnPct, patterns).
// ============================================================

const { parseChapterPatterns } = require("./chapter-labels");

/**
 * Every global sync key: its default and the values the UI may offer.
 * `presets` doubles as the accepted set for enum keys; a stored value
 * outside it resolves to the default (a hand-edited or stale settings.json
 * must never produce an engine state no UI can show).
 */
const SYNC_SETTING_SPECS = Object.freeze({
  syncEnabled: { type: "boolean", default: false },
  syncPromptOnConnect: { type: "boolean", default: true },
  syncDeletePolicy: { type: "enum", default: "guarded", presets: Object.freeze(["guarded", "add-only"]) },
  syncHashMode: { type: "enum", default: "cached", presets: Object.freeze(["cached", "rehash"]) },
  // Consecutive failures before a run aborts (CompareManga transfer_runner's 3).
  syncErrorBudget: { type: "enum", default: 3, presets: Object.freeze([1, 3, 5, 10]) },
  // Size-mismatch anomaly threshold in percent; 0 is "off".
  syncSizeWarnPct: { type: "enum", default: 30, presets: Object.freeze([0, 15, 30, 50]) },
  // One regex per line with a named group `ch` (chapter-labels.js).
  syncChapterPatterns: { type: "patterns", default: "" },
});

const SYNC_SETTING_KEYS = Object.freeze(Object.keys(SYNC_SETTING_SPECS));

function _resolveOne(spec, value) {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? value : spec.default;
    case "enum":
      return spec.presets.includes(value) ? value : spec.default;
    case "patterns":
      // Kept as text even when some lines are invalid: the labeler uses the
      // valid lines and label-preview reports the rest, so one typo can't
      // silently discard every other pattern.
      return typeof value === "string" ? value : spec.default;
    default:
      return spec.default;
  }
}

/**
 * The complete global sync settings for `saved` (history.getSettings()).
 * Absent, mistyped or out-of-set values resolve to their defaults.
 * `chapterPatterns` is the parsed form of syncChapterPatterns for the engine.
 */
function resolveSyncSettings(saved) {
  const src = saved && typeof saved === "object" ? saved : {};
  const out = {};
  for (const key of SYNC_SETTING_KEYS) out[key] = _resolveOne(SYNC_SETTING_SPECS[key], src[key]);
  const parsed = parseChapterPatterns(out.syncChapterPatterns);
  out.chapterPatterns = parsed.patterns;
  out.chapterPatternErrors = parsed.errors;
  return out;
}

module.exports = { SYNC_SETTING_SPECS, SYNC_SETTING_KEYS, resolveSyncSettings };
