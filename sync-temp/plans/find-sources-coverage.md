# Find sources (Device Sync): per-site chapter coverage (option A + B)

Status: rev 3, APPROVED 2026-10-17. C1-C4 done (C1 measurements under User
call 1, C2 notes under Decision 2, C3 and C4 under "as built"); approved by the user 2026-10-17; committed `99b1571` (2026-10-18). Oracle pinned to `ecf8ec7`. rev 2 → rev 3 = the user's answers (section "User calls"). Phases C1 → C4, report and
wait after each.
Memory pointer: `device-sync-feature.md` (Find-sources coverage sub-task line).
Mockups: shown in the session that wrote this plan (A = inline strips, B = details sheet).

## Goal

In the Sync tab's Find sources sheet, a user choosing which site downloads a series (and which
back it up) sees what the Search tab's "Chapter coverage" panel shows — each site's main-chapter
count, its extras, where its gaps are — without leaving the slide-in panel.

- **A** — the open site list (under the "weebcentral 0.97 +6 fallbacks" chip) gains a coverage
  strip and a main-chapter count per site.
- **B** — a "Coverage details" link under that list opens a second sheet over the first with the
  full per-site breakdown + grid, and the same radios.

## User calls (2026-10-17)

1. **Store the full `winner_chapter_map`, no compact summary** ("an insignificant gain; this way
   there's only one full summary"). So: no Python change, the runner keeps the map verbatim, and
   one renderer model reads it for both tabs.
   Cost on record: the current `find-sources.json` is 742 KB for 127 rows (read 2026-10-17);
   the review estimated ~150-200 KB of map per row, i.e. a file in the ~20-25 MB range rewritten
   after each row and sent whole by `get()` over IPC when the sheet opens. C1 measures the real
   number on a live search and reports it; the user's call stands unless it is far off.
   **Measured (C1):** 152 KB of map for the live 'Tis Time payload (295 chapters, 7 sites; 97 %
   of it is `chapters[]`, ~76 B per chapter-site cell). Projected over the target's 126 searched
   rows: ~8 MB (sites with a known count) to ~12 MB (every site of the top match); a synthetic
   13.6 MB file writes in ~75 ms through `WriteQueue` and reads + parses in ~82 ms.
2. **"Compare every site" is not a real problem — dropped.** Verified: `_filter_and_rank_alt_sources`
   admits a site whose SEED is ≥ 0.65 before looking at its measured score
   (`aio_search_cli.py:933-936`), and 26 of the 32 seeded sites are ≥ 0.65
   (`sites/quality_seed.json`). Under seeded-only search the only sites that can miss the map are
   manganato 0.60, manhuaplus/webtoonxyz/toonily 0.55, manhuaus/mangabuddy 0.50 — and only when
   their probe also scored < 0.4. The "not compared" state stays as the rare-case fallback.
3. **Rows searched before this change are left as they are**; they show one line asking to search
   again.
4. **(asked during C3) The count is distinct main chapters + extras, in BOTH tabs** ("282 +3", not
   the Search tab's old "285 main / 286 entries"). main = `unique_main_chapters` (distinct int()
   floors), extras = `effective_chapters − main` (side stories kept). On the live 'Tis Time map
   every full site reads 282 main and only extras differ (mangafire +7, mangahub +6, others +3),
   where the old count read 289/288/285. The Search tab header follows: "282 main +10 extras".

## Evidence (read 2026-10-17)

- **The map exists and is thrown away.** `_searchOptions` spreads saved `searchOpts` incl.
  `multiSource` (`find-sources.js:100`); `searcher.js` passes `--search-json` (+ `--multi-source`
  when on, never `--auto-pick`); `aio_search_cli.py` builds `winner_chapter_map` when
  `multi_source and candidates` (~625-718) and prints it (~787). `compactCandidates`
  (`find-sources.js:127`) keeps only `candidates`. `candidates[0]` is the map's winner.
- **Absent** when the row searched with multi-source off; covers candidate 0 only.
- **Low-match sites:** numbering overlap < 50 % with the anchor → only overlapping chapters reach
  `chapters[]` (`chapter_merger.py:686-715`, `merge_diagnostics[site].skipped_reason` set) while
  `effective_chapters` counts the full list. Empty-list sites live only in `merge_diagnostics`.
- **The anchor is the site with the most chapters**, not the user's pick; `compatibility` is
  measured against it (`chapter_merger.py:631-644`).
- **What the Search tab's panel reads** (`SearchChapterMap.jsx`): per-site present/official sets
  from `chapters[].sources` (alphabetical; empty-list sites never appear), `merge_diagnostics`
  `{total_chapters, effective_chapters, compatibility, breakdown}`, top-level
  `collapse_splits_applied` / `effective_chapters_aligned` / `total_chapters_aligned`. X axis =
  sorted chapter numbers (floats, may be negative). `SearchTab.jsx:350` separately reads
  `publisher/group_name` for the "★ publisher" badge (unaffected).
- **Search results aren't persisted** (`useDownloader.js`, memory only).
- **Overlays:** `overlay.jsx` `STACK` routes Escape + focus trap to the top entry; a sheet nested
  in the parent's children would close both on an outside click (parent scrim) and positions only
  because the panel's transform makes it a containing block.
- **Picker layout:** open list is local to `Picker` (`FindSourcesSheet.jsx:115`) in `FindRow`'s
  middle column (`:221-288`) → ≈ 80 px of strip. `tools/_e2e_device_sync_find.js:274-283` scopes
  `getByRole("radio")` to `data-testid="find-row"` and regexes labels (`/mangadex.*fallback 1/`).
- **`sync/ChapterStrip.jsx`** draws run-length segments with literal `.sync-seg-*` classes
  (`globals.css:179+`; built class names get purged). Same technique, different states.

## Decisions

1. **Runner keeps the map:** `compactCandidates` puts `json.winner_chapter_map` on
   `candidates[0].chapterMap`, verbatim. No file-version bump; absent = no coverage.
2. **One renderer model for both tabs.** New `src/lib/chapterCoverage.js`:
   `coverageModel(chapterMap)` → `{chapterNums, totalAligned, effectiveAligned, collapseApplied,
   anchorSite, sites: [{site, present:Set, official:Set, total, effective, compatibility, buckets,
   lowMatch, empty}]}` — the matrix + `siteStats` + `buildBuckets` logic moved out of
   `SearchChapterMap.jsx` unchanged, plus `lowMatch`/`empty` from `skipped_reason`, plus
   `runs(site)` (present/official as index runs over `chapterNums`) and `gapLabels(site, max)`
   (via `syncView.chLabel`). `SearchChapterMap` renders from it via two extracted pieces,
   `CoverageSummary` (per-site rows + chips + legend) and `CoverageGrid` (heatmap); it skips
   `empty` sites as today. Search tab output identical (oracle test, C2).
   **As built (C2):** `buildBuckets` moved into the model too; the helpers are
   `coverageRuns(model, site)` / `gapLabels(model, site, max)` / `siteCoverage(model, site)`;
   gap labels are plain chapter numbers ("37", "60-61"), not `chLabel`'s "Ch.037", to stay short
   in a strip's tooltip/aria-label. The Search tab draws only sites with a chapter in
   `chapters[]` (`ch > 0`), which also hides a zero-overlap low-match site, as before.
3. **A — full-width list.** `open` lifts from `Picker` into `FindRow`; the row becomes a vertical
   container (row line, then the list) still inside `data-testid="find-row"`. Columns: radio ·
   site · rating(+triangle; `SiteScore` variant without `ch.`) · strip (≈ 210 px at 600 px) ·
   `285 +4` (effective main + one amber "+N extras" chip; drops etc. in B) · role. Sites match
   the map by site name (the map has no URLs; one candidate carrying the same site twice is
   already collapsed by the aligner).
4. **States** (`findView.siteCoverage(row, source)`, `findView.rowCoverageState(row)`):
   covered → strip + count · `lowMatch` → "numbering differs (40 % match)" + count · `empty` →
   "no chapters listed" · site not in the map (rare, see User call 2) → muted "not compared"
   (title: still a fallback) + old `ch.N` · the chosen match has no map (a "Not this series?"
   pick → "Coverage is compared for the top match only"; an old row with `multiSource !== false`,
   incl. migrated `null` → "Search again to compare chapter coverage") · `multiSource === false`
   → "Turn on fallback sites in Search settings to compare chapter coverage". The last three drop
   the strip column and show one line. Pinned-URL rows unchanged.
5. **B — a sibling sheet.** `CoverageSheet.jsx` rendered next to the Find sources `<Sheet>`, with
   `coverageFolder` in `FindSourcesSheet` state; own scrim, so an outside click closes only it.
   Width = parent − 48 (a sliver of Find sources shows); `contained` passed through for the
   gallery. Header "292 main / 295 entries · −3 dropped · compared against weebcentral". Body:
   radios (own `name`, same `onPatch({pickUrl})` as the picker) + `CoverageSummary` +
   `CoverageGrid` expanded. Close → focus back to the link; the row's list stays open.
6. **`CoverageStrip`** (`components/sync/`): absolutely-positioned run segments, official runs in
   a token colour (`--warning`), literal class names, `role="img"` + `aria-label` "285 of 295
   chapters, missing 37, 60-61, 81 and 4 more". Rendered only in open lists.

## C3 as built (2026-10-17)

- Model (`lib/chapterCoverage.js`): per-site `main`/`extras`, `mainAligned`/`extrasAligned`,
  `coverageGaps`, `coverageLabel` (the strip's aria-label), `mainCountTitle`. `MainCount`
  (`ChapterCoverage.jsx`) draws "282 +3" for both tabs.
- `findView.rowCoverage(row)` → map / other-match / fallbacks-off / search-again (fallbacks-off
  checked first: it explains every missing map); `siteCoverageState(model, source)` → covered /
  low-match / empty / not-compared; `ratingText`. Plan names `siteCoverage`/`rowCoverageState`
  were taken by the model's `siteCoverage`, hence the new names.
- `FindRow` holds the list's open state; the list (`SitesPanel`) renders under the row line,
  full width, inside `data-testid="find-row"`. Columns: radio · site · rating · strip · count ·
  role, with a header row. Strip ≈ 205 px at 600 px.
- **Deviation from decision 6:** licensed runs are `bg-yellow-500`, not `--warning`: it matches
  B's grid legend, and `--warning` means "needs a decision" in the Sync tab. Missing chapters are
  drawn as notches with a 2 px minimum (one chapter in 300 is under a pixel).
- Known oddity: the Search tab row shows "282 main +3" next to the chip "+4 side". The chips
  classify the site's RAW list; extras count what the aligner kept (weebcentral lists one more
  decimal than reaches `chapters[]`). Not changed: the chips are C2-verbatim.
- Gallery: `tab-find-coverage` (both lists open), `tab-find-coverage-nomap` (search again /
  top match only / fallbacks off); seam `spec.findRows` in `syncFixtureSource.js`,
  `initial.findOpen` → `FindSourcesSheet openSites`. E2E: a strip-label check on the real app.
- **Open:** `_e2e_device_sync_find.js`'s Search-tab half ("Find source opens Search…",
  "Download → Queue…") flakes about 1 run in 3, at HEAD (`ecf8ec7`) too: the single-find search
  launches twice and no result renders. Cause not investigated; may be an app race in the
  banner's auto-search.

## C4 as built (2026-10-17)

- `components/sync/CoverageSheet.jsx`, rendered by `FindSourcesSheet` next to its `<Sheet>`;
  open state `coverage = {tid, folder}` there, the row read from the live rows (a pick in either
  place shows in both). Width parent − 48. Link "Coverage details →" sits on the list's last line
  (right of "Not this series?"), only when the row's match has a map.
- **Header reworded** to the count rule of User call 4: "Across 5 sites · 181 main +1 extras ·
  −N dropped · compared against weebcentral". The counts are one shared component,
  `CoverageHeadline` (`ChapterCoverage.jsx`), which the Search tab's header now uses too (same
  markup; the oracle still passes).
- Body: "Download from" radios (rating + role, no strip), then `CoverageSummary` + `CoverageGrid`
  over the sites with a chapter in the map (as the Search tab). So a "not compared" site appears
  in the radios but not in the summary or grid.
- The sheet closes itself when its row loses the map (a re-search without one).
- Radio group names are per instance (`useId`), in the list too: the DEV gallery draws each case
  twice and same-name radios in one document are one group (the light copy showed no pick).
- **Two shared overlay fixes** (`ui/overlay.jsx`), found by testing with real input:
  a scrim click now cancels the mousedown default, which moved focus to <body> after the
  closing overlay had returned it (every Sheet and Dialog); and the Tab trap counts a radio group
  as one stop, as the browser does (a panel ending in a radio group let one Tab escape).
- Gallery: `tab-find-coverage-details` (`initial.findCoverage` → `FindSourcesSheet openCoverage`,
  seeded once that row has its map). E2E: open, pick in the sheet → the list follows, Escape
  closes only it, focus back on the link, the list stays open.

## Phases

**C1 — Runner keeps the map.** `compactCandidates` + header comment (row/candidate shape).
`tools/_test_device_sync_service.js`: map on candidate 0 only, absent without one, old rows load
unchanged. Fixtures: `tools/_gen_sync_fixtures.js` fake payloads gain a map (regenerate
`src/dev/sync-fixtures/tab.json`); `tools/_e2e_device_sync_find.js`'s fake backend too. Live: one
real `aio-dl.py --search "<the screenshot's series>" --search-json --multi-source` saved as the
C2 fixture; report its map size and the projected `find-sources.json` size.

**C2 — Renderer model + Search tab on it.** `chapterCoverage.js`, `CoverageSummary`,
`CoverageGrid`, `SearchChapterMap` on the model. Offline `tools/_test_chapter_coverage.js` over
the C1 fixture: site list, counts, licensed counts, buckets, header numbers equal the old
component's (old computation kept in the test as oracle); runs/gapLabels round-trip. Live:
Search tab screenshot before/after, same series.

**C3 — A.** `FindRow`/`Picker` restructure, `CoverageStrip`, decision-4 states, `findView.js`
helpers + `tools/_test_device_sync_view.js` cases. Gallery (`/?gallery=sync`,
`tools/_shot_sync_gallery.js`) at 600 and 680 px: covered, low-match, not-compared, old row,
multi-source-off; then the E2E.

**C4 — B.** `CoverageSheet.jsx` + link (only when the match has a map). Live: open, pick another
site, close → list shows the new pick; Escape and outside click close only B; focus returns.

Then: verification suite 2, 3, 7; re-read every changed file and its neighbours; report.

## Review history

rev 2 adopted the adversarial review (2026-10-17): low-match/empty states, "not compared" copy,
no-map single-line states, `open` lifted into `FindRow` inside the E2E scope, B as a sibling with
its own radio `name`, token colour + aria-label, tests/fixtures/gallery listed. rev 3 removed the
compact summary and the Python change (User call 1), which also retired the review's url-keying
and `role`-in-summary points.

## Open decisions

None. The user kept every C3 and C4 default as built (2026-10-17): extras in amber-600 on light,
the list's header row, `ch.N` for a not-compared site, the sheet's reworded header, not-compared
sites in the sheet's radios only, radios with rating + role.
