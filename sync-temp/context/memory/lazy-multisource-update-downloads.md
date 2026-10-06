---
name: lazy-multisource-update-downloads
description: "--multi-source-lazy defers cross-site discovery to first chapter failure; global opt-out via defaults.multiSourceLazy; 2026-07-07 removed seeded-rating-only + made library update-checks FORCE lazy via buildLibraryDownloadArgs"
metadata: 
  node_type: memory
  type: project
  originSessionId: dba6afa5-be82-49ae-8dab-bb2e8754cd51
---

Multi-source downloads used to pay the full eager discovery (~30-80 s
cross-site title search + chapter-list fetches) before downloading — on a
1-5 chapter update delta that costs more than the whole download. Fixed with
`--multi-source-lazy` (2026-07-01), then redesigned 2026-07-02 per user: GLOBAL
opt-out nested inside the multi-source opt-in (not an update-check-only setting).

**2026-07-07 UPDATE — seeded-rating-only DELETED, library update-checks FORCE lazy.**
The old `--seeded-rating-only` / `updateChecksUseSeededRating` / `seededRatingOnly`
feature (Updates-Center-only flag that skipped the multi-source image-quality
probe, ranking off sites/quality_seed.json priors) is GONE end-to-end: removed
the argparse flag (aio-dl.py), the probe-skip branch (aio_search_cli.py — img_cache
is now unconditionally `ImageQualityCache()`), the downloader.js boolMap entry,
the SettingsTab default + UI toggle, and the LibraryTab injection. Replaced by:
`lib/downloadArgs.js:buildLibraryDownloadArgs` now sets `args.multiSourceLazy = true`
whenever `def.multiSource === true`. Because the builder's result wins over the
settings.defaults spread (App.jsx onStartDownload) and over queueDownload's own
spread, this OVERRIDES a global `multiSourceLazy:false` opt-out for BOTH update-check
download paths (detail-view "Download Missing Chapters" + Updates Center per-row/
queue-all). Net: a library update download always uses lazy multi-source when
multi-source is on; New-tab/Search downloads still honor the global toggle. Removal
is resume-safe (seeded_rating_only was auto-persisted to run_params.json but only
`setattr`'d back, never re-parsed as argv, and not in _RESUME_GATING_DESTS).
Verified: node harness on buildLibraryDownloadArgs (3 scenarios), UI build clean,
both CLIs parse, seeded-rating-only absent from --help. Touches 6 files: aio-dl.py's
2 seeded-rating-only hunks, aio_search_cli.py, downloader.js, downloadArgs.js,
LibraryTab.jsx, SettingsTab.jsx.

**Why:** measured mangakatana 1-chapter download: lazy 8.1 s vs eager 52.4 s.
Discovery is pure fallback prep for direct-URL runs — wasted unless a chapter
fails.

**How to apply:**
- Python (unchanged since v1): eager block in `aio-dl.py:main()` is closure
  `_discover_multi_source_alternatives()`; `_ms_lazy_pending` arms under
  `--multi-source-lazy` (direct-URL, non-prefetched) and fires ONCE in
  `_process_chapter_strict` right after the primary `ChapterSkippedError`
  (disarm-before-run). CLI default stays EAGER — the flag is opt-in at the
  CLI; the UI is what injects it by default.
- UI model (v2): `defaults.multiSourceLazy` (SettingsTab DEFAULT defaults +
  reset, default true). Emission happens at ONE chokepoint —
  `downloader.js:buildCliArgs`, NOT in boolMap: emits `--multi-source-lazy`
  when `args.multiSource === true && args.multiSourceLazy !== false`.
  ABSENT-MEANS-ON is load-bearing: library/search paths spread SAVED
  settings.defaults (App.jsx), and dicts saved before the field existed must
  not revert to eager. Only explicit false (user unticked) suppresses.
- Nested toggles ("only appears when multi-source is on"): Settings →
  Default Multi-source Fallback (above the quality-floor slider) and
  DownloadTab's Multi-source section (per-job override). BOTH master
  multi-source switches force-reset `multiSourceLazy: true` on enable —
  "turning on multi-source turns lazy on"; a prior opt-out doesn't survive a
  fresh opt-in. LibraryTab (via buildLibraryDownloadArgs) now FORCE-injects
  `multiSourceLazy: true` when multiSource is on — see the 2026-07-07 update
  above — so update-check downloads override even a global opt-out.
- SearchTab untouched: prefetched downloads emit lazy too but Python's
  arming excludes --multi-source-prefetched (inert, harmless).
- Tests: chokepoint matrix via node shim (scratchpad test_chokepoint.js
  pattern — copy downloader.js, append buildCliArgs export, 7 cases);
  Python live tests: healthy lazy run (defer note, no search), eager
  control, forced-failure fire (`--chapter-deadline-seconds 2
  --inline-chapter-retries 0`).

COMMITTED 2026-07-02 in the user-directed mega commit `9146120` (amended from
`36045df` to drop tools/ + sanitize series names; branch
`feat/archival-aux-and-lazy-multisource`, upstream PR #56), bundled with
[[tapas-motion-audio-local-feature]], the animated-image guard, and the
modernize effort/avif-speed UI. The offline rank/sidecar/modernize test
scripts stay LOCAL in untracked tools/.

2026-07-03 interaction: aux-bearing chapters (BGM/motion — grep `aux_veto`)
no longer trigger the lazy discovery on failure (`_ms_lazy_pending` stays
armed for the next aux-free failure) because they're excluded from alt-source
rescue entirely. Also fixed the gate that made rescues fire on COMPLETE
chapters ("incomplete: N/N reason=time_budget" — prefetch wait burned the
watchdog budget). See CLAUDE.md "Chapter watchdog scope" invariant +
`tools/_test_budget_veto.py`.
