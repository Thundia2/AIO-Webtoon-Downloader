// ============================================================
// RESOURCE LIMITS — renderer mirror (display only)
//
// Powers the Settings → "Resource Limits" section:
//   - the two <Select> option lists (NETWORK_LEVELS / CPU_LEVELS),
//   - the live "effect preview" line under each dropdown,
//   - the EFFECTIVE value + disabled/"managed" state of the five inputs a Max-
//     network preset hard-overrides (imageConcurrency, imageWorkers,
//     imagePrefetchParallel, imagePrefetchDepth, searchParallelism).
//
// KEEP IN SYNC with ../../electron/resource-limits.js — that CommonJS module is
// the SOURCE OF TRUTH (it drives the actual spawn args in main.js). This mirror
// exists only because the Vite renderer bundle can't import the electron module
// across the process boundary. The two preset tables MUST stay identical; a
// drift guard asserting equality runs in the verification suite.
// ============================================================

// Python argparse defaults for the network knobs (aio-dl.py). Mirror of
// electron NET_DEFAULTS. Used as the "manual" fallback when a stored knob is
// unset, so an Unlimited preview / effective value still shows a concrete number.
export const NET_DEFAULTS = {
  imageConcurrency: 8,
  imageWorkers: 3,
  imagePrefetchParallel: 2,
  imagePrefetchDepth: 2,
  searchParallelism: 6,
};

// Hard-override presets. MUST match electron/resource-limits.js NETWORK_PRESETS.
export const NETWORK_PRESETS = {
  high: { imageConcurrency: 6, imageWorkers: 3, imagePrefetchParallel: 2, imagePrefetchDepth: 2, searchParallelism: 5 },
  balanced: { imageConcurrency: 4, imageWorkers: 2, imagePrefetchParallel: 1, imagePrefetchDepth: 1, searchParallelism: 3 },
  low: { imageConcurrency: 2, imageWorkers: 1, imagePrefetchParallel: 1, imagePrefetchDepth: 1, searchParallelism: 2 },
};

// Max-CPU presets → --max-cpu-percent value. MUST match electron CPU_PRESETS.
export const CPU_PRESETS = { high: 75, balanced: 50, low: 25 };

// Dropdown option lists. "unlimited" first (the default / no-op).
export const NETWORK_LEVELS = [
  { value: "unlimited", label: "Unlimited" },
  { value: "high", label: "High" },
  { value: "balanced", label: "Balanced" },
  { value: "low", label: "Low" },
];
export const CPU_LEVELS = NETWORK_LEVELS;

function normLevel(level) {
  const v = typeof level === "string" ? level.toLowerCase() : "unlimited";
  return v === "high" || v === "balanced" || v === "low" ? v : "unlimited";
}

// A Max-network preset is active → the five download/search inputs are managed
// (disabled, showing their effective preset value). Drives the lock affordance
// + amber "managed" banner in SettingsTab.
export function isNetworkManaged(level) {
  return normLevel(level) !== "unlimited";
}

// Effective value to DISPLAY in a managed (disabled) input: the preset value
// when a network level is active, else the caller's stored manual value (which
// is preserved untouched and restored the instant the user returns to Unlimited
// — hard override never erases manual settings). `key` is one of the five
// NET_DEFAULTS keys.
export function networkEffective(level, key, storedValue) {
  const lvl = normLevel(level);
  if (lvl === "unlimited") return storedValue;
  return NETWORK_PRESETS[lvl][key];
}

// One-line effect preview under the Max-network dropdown, e.g.
// "curl_cffi 2 · workers 1 · prefetch 1×1 · search 2". null when Unlimited.
export function networkPreviewText(level) {
  const lvl = normLevel(level);
  if (lvl === "unlimited") return null;
  const p = NETWORK_PRESETS[lvl];
  return `curl_cffi ${p.imageConcurrency} · workers ${p.imageWorkers} · prefetch ${p.imagePrefetchParallel}×${p.imagePrefetchDepth} · search ${p.searchParallelism}`;
}

// One-line effect preview under the Max-CPU dropdown, e.g. "~50% of CPU cores".
// null when Unlimited.
export function cpuPreviewText(level) {
  const lvl = normLevel(level);
  if (lvl === "unlimited") return null;
  return `~${CPU_PRESETS[lvl]}% of CPU cores`;
}

// Human label for a level (for the managed banner text), e.g. "Low".
export function levelLabel(level) {
  const lvl = normLevel(level);
  const found = NETWORK_LEVELS.find((o) => o.value === lvl);
  return found ? found.label : "Unlimited";
}
