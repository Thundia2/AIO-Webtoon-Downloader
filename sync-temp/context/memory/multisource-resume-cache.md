---
name: multisource-resume-cache
description: "--multi-source alternatives cached in run_params.json (72h TTL) so resume skips the cross-site search"
metadata: 
  node_type: memory
  type: project
  originSessionId: 056f010d-75b5-4c57-9a3d-837584458808
---

2026-07-06: added a resume cache for the direct-URL `--multi-source` discovery so
resuming an interrupted download doesn't re-run the ~30-80s cross-site title
search. Persists the resolved `(site, url)` alternatives + `saved_at` epoch into
`run_params.json` under a **top-level `multi_source_cache` key** (NOT in `params`
→ `gating_hash` unaffected). On resume the closure reads it and rebuilds via
`aio_search_cli.build_alternatives_from_payload` — the SAME code the UI's
`--multi-source-prefetched` file uses (re-fetches chapter lists + re-aligns, only
the search is skipped). 72h TTL, env override `AIO_MULTISOURCE_CACHE_TTL_HOURS`
(<=0 disables).

**Why the design is the way it is (non-obvious):**
- The in-memory `_multi_source_alternatives` holds live scraper/handler/context
  objects → not JSON-serializable; only `(site, url)` can be cached, hence the
  prefetched-path reuse (that's exactly what it's for). This is why "doesn't
  re-probe" still does a cheap chapter-list re-fetch, not a full skip.
- **Two write triggers** because run_params.json is written ONCE (`if not
  resume_mode`) and discovery is eager OR lazy: EAGER runs before the tmp dir
  exists → payload rides `_ms_resume_cache_payload` into the write block; LAZY
  (the UI default) fires mid-run AFTER the write block → `_persist_multi_source_
  cache` read-modify-writes the file. Chapter loop is sequential on the main
  thread (`for ch_idx, ch in enumerate(chapters)`), so that write is race-free.
- Cache HIT preserves the original `saved_at` (TTL counts from first discovery,
  not each resume). Fresh search / prefetched-file runs also persist (so even UI
  search-tab downloads get a resume cache — their temp file is unlinked + not
  passed on resume).

**Where:** `aio-dl.py` helpers `_read_multi_source_resume_cache` /
`_persist_multi_source_cache` / `_build_multi_source_cache_payload` /
`_multi_source_cache_ttl_seconds` (near `gating_hash`); consumed in
`_discover_multi_source_alternatives`; folded in at the run_params write block.
`aio_search_cli.py`: split `build_alternatives_from_prefetched` → thin file
reader + new `build_alternatives_from_payload(payload, ...)`; both direct-URL
helpers now return `resolved_sources`. Offline regression:
`tools/_test_multisource_resume_cache.py` (37 checks, gitignored).

**Scope boundary:** the `--search --auto-pick --multi-source` CLI path (line
~8575, sets `_multi_source_alternatives` directly) is NOT cached — on resume it
becomes a direct-URL run and self-heals (one fresh search on first resume, then
cached). Offered to extend but left out to keep scope tight.

**Files:** `aio-dl.py`, `aio_search_cli.py`, `sites/tapas.py`, `DownloadTab.jsx`
— landed alongside the tapas premium/`_locked` → multi-source fill feature (they
intermix per-file), see [[tapas-locked-multisource-rescue]]. Composes with
[[lazy-multisource-update-downloads]] (the `--multi-source-lazy` opt-out this
cache pairs with) and [[tapas-motion-audio-local-feature]] (aux_veto chapters
still skip alt rescue).
