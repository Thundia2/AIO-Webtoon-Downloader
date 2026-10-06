---
name: tapas-locked-multisource-rescue
description: Tapas premium/locked episodes now ride the chapter list as _locked placeholders so --multi-source fills them from the highest-rated alt site; DownloadTab amber nudge callout.
metadata: 
  node_type: memory
  type: project
  originSessionId: 5e56d6f0-3825-4cf7-9b81-06b2c6574539
---

2026-07-06: Tapas serves only some episodes free; premium/wait-to-unlock ones
were DROPPED in `sites/tapas.py:get_chapters` (`_skip_reason`=="locked"), so
they never reached the per-chapter multi-source rescue → permanent gaps. Fixed
by making locked episodes ride the list as bare placeholders and reusing the
existing rescue machinery. User directive: "paid/unavailable chapter +
--multi-source → download from the next highest rated site."

**How it works (grep `_locked`):**
- `sites/tapas.py`: `_episode_to_chapter(ep, locked=True)` emits a placeholder
  with `_locked=True` and **NO** `_bgm_url`/`_has_bgm`/`_bgm_title` — aux-free so
  `_chapter_carries_aux` stays False and `aux_veto` does NOT block the rescue
  (we can't fetch tapas BGM logged-out anyway → nothing to lose). `get_chapter_images`
  short-circuits `_locked` → `IncompleteChapterError(reason="locked")` (no request).
- `aio-dl.py`: `"locked"` added to `_PERMANENT_SKIP_REASONS`. `_process_chapter_strict`
  tries the best-rated alt on reason="locked" (alt list already ranked); if none
  delivers → `ChapterPermanentSkipError` (clean skip + continue, NEVER abort).
  Download-path filter (right after the `--list-chapters` sys.exit) drops `_locked`
  from `pool` when `--multi-source` is OFF (restores clean single-source behavior);
  KEEPS them when ON so alignment includes their scene numbers. Rescue-success path
  prints `✓ Chapter N (premium/locked on tapas) filled from <alt>` (per-fill log).
- `aio_search_cli.py`: `_fetch_chapters_for_winner` drops `_locked` from ALT lists
  (a site as an alt must never offer a chapter it can't serve).
- `--list-chapters` output gained a **`locked_chapters`** list (separate from
  `chapters`; NOT in `total` or the "+N new" diff, so no perpetual "+N new").

**UI (DownloadTab.jsx):** `TapasPremiumCallout` + `hasTapasUrl` (regex `/\btapas\.io/i`).
Slides in under the URL textarea when a tapas.io URL is present. Amber "Tapas locks
premium episodes" + one-click **Enable Multi-source** button (the anti-silent-no-op
nudge); cross-fades to a green "Premium episodes will be filled in" state when
multi-source is on. Uses `--warning`/`--success` tokens, `Lock`/`Sparkles` lucide
icons. Playwright-verified dark+light, both states.

**Caveat (user chose "plain numeric match" 2026-07-06):** tapas `chap`=`scene`
counts Extras, so scene N may not equal chapter N on a manga-style alt → possible
wrong-content fill. Fine for webtoon-mirror alts (usual case). Mitigation = the
per-fill log line for spot-checking. NOT consensus-gated. See [[tapas-motion-audio-local-feature]]
(aux_veto), [[lazy-multisource-update-downloads]].

**Status:** DONE + verified (build 1265 modules; `tools/_test_tapas_locked_multisource.py`
27 checks; adjacent `_test_sidecar_aux`/`_test_budget_veto` still green). NOT yet
committed. 4 files: sites/tapas.py, aio-dl.py, aio_search_cli.py, UI-source/src/components/DownloadTab.jsx.
Library-card locked indicator (consume `locked_chapters` in main.js→LibraryTab) is a
possible follow-up, deliberately not done.
