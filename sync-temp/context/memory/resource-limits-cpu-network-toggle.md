---
name: resource-limits-cpu-network-toggle
description: "Settings → Resource Limits (Max CPU / Max network usage) feature — hard-override presets, where each piece lives, why resume honors the current limit"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f025d7f-6ae7-4fd8-8bdc-a245b8017523
---

Settings → **Resource Limits** section: two discrete-preset dropdowns
(`Unlimited (default) · High · Balanced · Low`) — **Max network usage** + **Max CPU
usage**. Reduces download + search + CPU parallelism. Built 2026-07-05 on branch
`fix/whole-codebase-review-sweep`; **committed 9f4f505** (bundled with the Settings
two-pane redesign — they shared SettingsTab.jsx so couldn't be file-split; UNPUSHED/
UNMERGED). Semantics =
**hard override** (an active preset REPLACES the manual knobs; Unlimited = true no-op).
User chose: two separate controls, discrete presets, hard override, resume-uses-current.

Non-obvious decisions:
- **CPU throttle = new Python flag** `--max-cpu-percent` (env `AIO_MAX_CPU_PERCENT`) →
  `_CPU_POOL_PERCENT` global (set in `_apply_runtime_tunables`, so resume re-seeds it) →
  `_cpu_pool_budget()` swapped into the THREE CPU-bound `cpu = os.cpu_count() or 4` sites
  (grep `_cpu_pool_budget`: `process_chapter_images`, `save_final_images`,
  `_run_recompress_pool`). Scales workers AND `enc_threads = cpu//workers` together (total
  threads track budget). 100% == unchanged default. **Kept OUT of `_RESUME_GATING_DESTS`**
  (speed knob, like `modernize_effort`) — clamp uses `is not None` not `or` so 0→1 not →100.
- **Network throttle = NO Python change**; reuses existing `--image-concurrency` /
  `--image-workers` / `--image-prefetch-parallel` / `--image-prefetch-depth` /
  `--search-parallelism`.
- **Resolved in `main.js`** (the universal live-settings spawn chokepoint) via
  `electron/resource-limits.js` (canonical CJS): `applyNetworkLimit` + `cpuPercentForLevel`
  in start-download (sets `args.maxCpuPercent` only when <100), `searchParallelismForLevel`
  in search:run, `resumeThrottleFlags` in resume-download. `downloader.js` gains one flagMap
  entry (`maxCpuPercent`) + a `resourceFlags` param on `resume()` appended to its
  `--restore-parameters` spawn line.
- **Resume honors the CURRENT limit, not the persisted one** (user directive: different
  environment on resume). Leverages aio-dl.py's EXISTING restore precedence — the restore
  loop skips dests in `_user_set_dests` (explicit resume-CLI flags) and logs
  `[resume] Keeping fresh CLI override(s)`. `resumeThrottleFlags` emits concrete current
  values ALWAYS so was-limited→now-Unlimited overrides back UP. Zero restore-logic change.
- **UI**: `SettingsTab.jsx` owns top-level `networkLimit`/`cpuLimit` defaults ("unlimited").
  The 5 network-overridden inputs (imageWorkers, imageConcurrency, prefetch depth/parallel,
  searchParallelism) render `disabled` + show the EFFECTIVE preset value + a `Lock`, with an
  amber `ManagedBanner` in the all-overridden "Image Prefetch & Concurrency" section.
  "What you see == what runs"; stored manual values preserved + restored on Unlimited.
- **Twin**: `electron/resource-limits.js` (canonical — drives spawn) + `src/lib/resourceLimits.js`
  (renderer mirror — display/effect-preview/effective-value only). `// KEEP IN SYNC`; drift
  check = strip-`export`-and-`require` node script comparing the two preset tables.
- **NOT extended** (optional follow-up): DownloadTab per-download imageWorkers + SearchTab
  "Parallel sites" stay editable (overridden at spawn regardless; both in collapsed Advanced
  sections). Preset numbers are tunable starting points.

Verified: `--help` flag + exit0 + import, site count 303/42, `_cpu_pool_budget` scaling
(100→cpu, 50→½) + clamp table (0→1,None→100), real `buildCliArgs`+resolver flow (Low+Bal
emits full set, Unl+Unl emits nothing, CPU-only leaves network alone), `npm run build`
(1265 modules), preset-table drift sync, no torch / no conflict markers. Full plan:
`~/.claude/plans/make-a-toggle-in-twinkly-hare.md`.
