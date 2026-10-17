# Find sources (Device Sync): show every site, queue the way the Search tab does

Status: rev 2, approved 2026-10-17 (supersedes rev 1). Phases F1 → F2 → F3, report and wait after each.
Memory pointer: `device-sync-feature.md` (Find-sources sub-task line).

## Context

The Sync tab's "Find sources" sheet searches each tablet-only folder's name and queues a download
for the chosen result. The user saw only atsu / dynasty / mangahub offered even when the series
is also on mangafire, mangakatana, etc.

Verified cause (2026-10-17): the search is the same pipeline as the Search tab and DOES find those
sites — the saved `find-sources.json` has, for "2.5 Dimensional Seduction", one series match
carrying atsumaru, mangafire, mangakatana, mangapill, mangahub. The sync side loses them:
- `compactCandidates` (`UI-source/electron/sync/find-sources.js`) trims each match's sites to 5
  (reuses `TOP_CANDIDATES`), so sites past the 5th are gone for good.
- `FindSourcesSheet.jsx` shows one `<select>` option per *series match*, labelled with only its
  top site; `findView.rowUrl` queues only that top site. Sites 2..N are never shown or used.
- The "duplicate mangahub" options are different, unrelated series (weak title matches the
  search keeps by design), each found only on mangahub.
- The queue sends only the URL (+ komikku), never the other sites as fallbacks.

User direction: scope is the sync feature only — no change to the Python downloader, the search,
the Search tab's behaviour, or saved settings. Fallbacks reuse what the Search tab already does.

What the Search tab does (read: `SearchSourceCard.jsx:110-150`, `SearchTab.jsx:305-315,814,1011,1236-1240`,
`downloader.js:start`): the download's `multiSource` defaults to the multi-source toggle THE
SEARCH RAN WITH (`searchState.opts.multiSource`, a snapshot), and the download dialog lets the
user flip it per download. When on, the candidate's other sources (site, url, title, cover;
primary excluded; search rank order; no quality filter in JS) ride as `prefetchedAlts`, which
`downloader.js` writes to a temp file → `--multi-source-prefetched`. When off, `prefetchedAlts`
is stripped. A single-site candidate still sends `multiSource: true` (Python then finds
fallbacks itself). The sync sheet has no per-download dialog, so the dialog's untouched default
is the analogue: the toggle value the row's own search ran with.

Known, accepted differences (not changed here): the Search dialog also sets `language` from
`searchOpts.searchLanguage` when `defaults.language` is empty; the sync queue keeps spreading
defaults only.

## Approach

### F1 — runner, view model, queue (report + wait after)

1. `UI-source/electron/sync/find-sources.js`
   - `compactCandidates`: keep ALL sites per series match; `TOP_CANDIDATES` caps only matches.
     Add per-site `titleMatch` (from `title_match`). Header row-shape comment updated.
   - Store the pick as a URL: row field `pickUrl` replaces `pick`. Its series match = the
     candidate containing it; missing/unknown → candidate 0's top site. Index picks went stale
     across re-searches (the runner keeps `pick` while still in range, ~line 255).
   - `ROW_PATCH_KEYS`: `pick` → `pickUrl` (`pick` now rejected), validated as a URL present in
     the row's stored sources; a query change and a re-search clear it. Same URL in two matches →
     the first match wins. `pick` is dropped from rows on load and save.
   - Each search records `multiSource` on the row (the value `_searchOptions` ran with), so the
     queue can follow "what this search ran with", like the Search tab.
   - Load-time migration (file `version: 2`): `pickUrl = candidates[pick].best.url`, and v1 `done`
     rows go back to `queued` (candidates kept, so the pick stays visible) — `start()` skips `done`
     rows and nothing else re-searches a finished row with an unchanged query, and their site
     lists were cut at 5.
   - Note: with multi-source on, each find-sources search already aligns chapter lists for its
     top match (same cost the Search tab pays); unchanged.
2. Shared helper so sync reuses the Search tab's payload instead of copying it:
   `UI-source/src/lib/prefetchedAlts.js` — `buildPrefetchedAlts(sources, primary, title, year)`
   returning `{primary:{site,url}, alternatives:[…], title: title || "", year: year || null}` or
   null when there are no others (keeps the original `||` rules and `undefined` for absent
   title/cover). `SearchSourceCard.handleDownload` switches to it, passing
   `candidate.canonical_title/canonical_year` (pure refactor; a test compares old vs new payloads
   on a recorded search JSON). The sync runner stores `canonicalTitle` separately from its
   display title so the payload title matches the Search tab's.
3. `UI-source/src/components/sync/findView.js`
   - `rowSource(row)` (picked site, or null when pinned), `rowCandidate(row)`, `rowUrl` on top.
   - `rowQueueArgs(row)`: pinned → `{}` (unchanged: follows the download defaults); else
     `{multiSource: row.multiSource}` plus `prefetchedAlts` only when that is true and the match
     has other sites — the Search tab's rules, including `multiSource: true` with no alternatives
     for a single-site match.
4. `FindSourcesSheet.jsx` queue: `onQueueDownload(row.url, {...rowQueueArgs(row), ...findQueueArgs(target)})`.
   `App.jsx` adds `multiSource: dl.settings?.searchOpts?.multiSource` to the sheet's
   `searchSettings` prop; the "Your search settings:" line adds "fallback sites on/off"
   (`SyncGallery.jsx` fixed prop gets the field too).
5. `UI-source/src/dev/syncFixtureSource.js`: patch keys, query-change reset, and the replay copy
   (`rec.pick`, ~line 270) move to `pickUrl`; regenerate `src/dev/sync-fixtures/tab.json` in F1
   (it holds `pick: 0` rows that bypass `_load`).
6. Tests: `tools/_test_device_sync_service.js` (multi-site fixture, sites uncapped, matches
   capped, `pickUrl` validation/reset, v1→v2 migration); `tools/_test_device_sync_view.js`
   (`rowQueueArgs`: pinned, single site, multi-site on/off, stale pickUrl, migrated rows);
   a payload-equality check for the extracted helper.

### F2 — picker UI (mockup first, user picks, then build; report + wait after)

- Mockup via the visualize widget, in the app's tokens: a compact row (folder, picked site chip
  `site · rating · ch.N` + red triangle when unmeasured, "+N other sites"), expandable to the
  full site list of the matched series (click a site = make it the download source), and
  "Not this series? (N other matches)" folding the unrelated matches away instead of mixing them
  into one dropdown. Optional variant for the user to accept or drop: a Ready/Review badge (Ready
  = top match's title match ≥ 0.85 with a 0.10 lead — the orchestrator's
  `EXPENSIVE_PROBE_QUICK_THRESHOLD` / `TIEBREAKER_WINDOW`, to be re-read before use).
- Build the chosen design in `FindSourcesSheet.jsx` (+ view helpers in findView.js); regenerate
  gallery fixtures with multi-site candidates (`tools/_gen_sync_fixtures.js`).

### F3 — live check

Re-search the 2 rows saved under the old 5-site cap; confirm every site shows; queue one with the
Search tab's multi-source toggle on and confirm the spawn line carries `--multi-source
--multi-source-prefetched` and the folder alias lands; with the toggle off, no alternatives.

## Files

- `UI-source/electron/sync/find-sources.js`, `UI-source/src/components/sync/findView.js`,
  `FindSourcesSheet.jsx`, `UI-source/src/App.jsx` (prop only), `UI-source/src/dev/syncFixtureSource.js`
- new `UI-source/src/lib/prefetchedAlts.js`; `SearchSourceCard.jsx` (refactor onto it, no behaviour change)
- tests under `tools/` (force-added on `wip/device-sync-handoff`)
- Durable copy of this plan: `sync-temp/plans/find-sources-all-sites.md` (replace rev 1);
  memory `device-sync-feature.md` pointer updated at each phase.

## Verification

- `node tools/_test_device_sync_service.js`, `node tools/_test_device_sync_view.js`,
  `node tools/_e2e_device_sync_find.js` (fake Python backend; extend its search answer with
  multi-site candidates, set `searchOpts.multiSource: true`, assert the queued args; note
  `downloader.js` writes the alternatives temp file under the real `~/.aio-dl/cache` and removes
  it on process close), `npm --prefix UI-source run build`.
- Gallery screenshot `/?gallery=sync` of the new row (F2).
- F3 live run as above. Commit + push to `fork` `wip/device-sync-handoff` at each phase stop once green.
