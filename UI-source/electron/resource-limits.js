// ============================================================
// RESOURCE LIMITS RESOLVER (canonical, main-process)
//
// Owns the discrete "Max network usage" / "Max CPU usage" presets and the pure
// functions that resolve a level ("unlimited" | "high" | "balanced" | "low")
// into concrete throttle values. Consumed by electron/main.js at the three
// spawn chokepoints: start-download, search:run, resume-download.
//
// SEMANTICS = HARD OVERRIDE. When a level is active (!= "unlimited") the preset
// REPLACES the manual concurrency knobs entirely (not a min()/ceiling);
// "unlimited" is a true no-op that leaves the user's manual knobs alone.
//   - Network level  → --image-concurrency / --image-workers /
//                       --image-prefetch-parallel / --image-prefetch-depth
//                       (download) + --search-parallelism (search).
//   - CPU level      → --max-cpu-percent (aio-dl.py:_cpu_pool_budget).
//
// KEEP IN SYNC with ../src/lib/resourceLimits.js — the renderer mirror used for
// the Settings dropdowns, the effect-preview lines, and the effective values
// shown in the disabled ("managed") inputs. THESE tables are the source of
// truth; the renderer copy exists only because Vite (renderer bundle) and
// Node require() (main process) can't share one module across that boundary.
// A drift guard lives in the verification suite (assert the tables are equal).
// ============================================================

// Python argparse defaults for the network knobs (aio-dl.py --image-*). Used as
// the "current effective" value on resume when a manual knob is unset, so the
// resume CLI always carries a CONCRETE number that overrides the persisted
// run_params value (grep resumeThrottleFlags).
const NET_DEFAULTS = Object.freeze({
  imageConcurrency: 8,
  imageWorkers: 3,
  imagePrefetchParallel: 2,
  imagePrefetchDepth: 2,
  searchParallelism: 6,
});

// Hard-override presets. A level != "unlimited" REPLACES these knobs.
// Numbers are starting points (tunable). MUST match src/lib/resourceLimits.js.
const NETWORK_PRESETS = Object.freeze({
  high: { imageConcurrency: 6, imageWorkers: 3, imagePrefetchParallel: 2, imagePrefetchDepth: 2, searchParallelism: 5 },
  balanced: { imageConcurrency: 4, imageWorkers: 2, imagePrefetchParallel: 1, imagePrefetchDepth: 1, searchParallelism: 3 },
  low: { imageConcurrency: 2, imageWorkers: 1, imagePrefetchParallel: 1, imagePrefetchDepth: 1, searchParallelism: 2 },
});

// Max-CPU presets → --max-cpu-percent value. 100 == prior behaviour (the pool
// budget equals os.cpu_count()). MUST match src/lib/resourceLimits.js.
const CPU_PRESETS = Object.freeze({ high: 75, balanced: 50, low: 25 });

// Normalize any stored level to a known key; unrecognized/absent → "unlimited".
function _normLevel(level) {
  const v = typeof level === "string" ? level.toLowerCase() : "unlimited";
  return v === "high" || v === "balanced" || v === "low" ? v : "unlimited";
}

// True when a network preset is active (used to gate the search cap + resume).
function isNetworkLimited(level) {
  return _normLevel(level) !== "unlimited";
}

// Hard-override the four DOWNLOAD concurrency knobs. When a network level is
// active, return a CLONE of args with the preset values; when unlimited return
// args unchanged (same reference — caller may pass it straight through).
// searchParallelism is NOT set here (it belongs to the separate search path).
function applyNetworkLimit(args, level) {
  const lvl = _normLevel(level);
  if (lvl === "unlimited") return args;
  const p = NETWORK_PRESETS[lvl];
  return {
    ...args,
    imageConcurrency: p.imageConcurrency,
    imageWorkers: p.imageWorkers,
    imagePrefetchParallel: p.imagePrefetchParallel,
    imagePrefetchDepth: p.imagePrefetchDepth,
  };
}

// Max-CPU level → percent. main.js emits args.maxCpuPercent only when < 100 so
// default (unlimited) spawns stay clean.
function cpuPercentForLevel(level) {
  const lvl = _normLevel(level);
  return lvl === "unlimited" ? 100 : CPU_PRESETS[lvl];
}

// Search fan-out: the preset value when a network level is active, else the
// caller's current value (which itself falls back to the Python default 6
// downstream when null).
function searchParallelismForLevel(currentValue, level) {
  const lvl = _normLevel(level);
  return lvl === "unlimited" ? currentValue : NETWORK_PRESETS[lvl].searchParallelism;
}

// Resume: build the CLI-flag array that makes the CURRENT throttle win over the
// values persisted in run_params.json. Emits CONCRETE current values ALWAYS
// (the four network knobs + --max-cpu-percent) so "current wins" holds in every
// direction — including was-limited-now-Unlimited, where the persisted preset
// must be overridden back UP. When unlimited, the network values are the user's
// current manual knobs (NET_DEFAULTS when unset). aio-dl.py keeps these explicit
// resume-CLI dests over --restore-parameters (grep _user_set_dests) and none are
// in _RESUME_GATING_DESTS, so overriding them never re-downloads. searchParallelism
// is omitted — resume is a download, not a search.
function resumeThrottleFlags(settings) {
  const s = settings || {};
  const nested = s.defaults || {};
  const pick = (v, dflt) => (v === null || v === undefined ? dflt : v);
  const withDefaults = {
    imageConcurrency: pick(s.imageConcurrency, NET_DEFAULTS.imageConcurrency),
    imageWorkers: pick(nested.imageWorkers, NET_DEFAULTS.imageWorkers),
    imagePrefetchParallel: pick(s.imagePrefetchParallel, NET_DEFAULTS.imagePrefetchParallel),
    imagePrefetchDepth: pick(s.imagePrefetchDepth, NET_DEFAULTS.imagePrefetchDepth),
  };
  const eff = applyNetworkLimit(withDefaults, s.networkLimit);
  return [
    "--image-concurrency", String(eff.imageConcurrency),
    "--image-workers", String(eff.imageWorkers),
    "--image-prefetch-parallel", String(eff.imagePrefetchParallel),
    "--image-prefetch-depth", String(eff.imagePrefetchDepth),
    "--max-cpu-percent", String(cpuPercentForLevel(s.cpuLimit)),
  ];
}

module.exports = {
  NET_DEFAULTS,
  NETWORK_PRESETS,
  CPU_PRESETS,
  isNetworkLimited,
  applyNetworkLimit,
  cpuPercentForLevel,
  searchParallelismForLevel,
  resumeThrottleFlags,
};
