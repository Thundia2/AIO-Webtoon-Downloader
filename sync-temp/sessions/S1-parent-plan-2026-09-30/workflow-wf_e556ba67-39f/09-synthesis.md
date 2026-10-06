# Workflow wf_e556ba67-39f — synthesis (phase Synthesis)

# CompareManga → AIO: consolidated research brief for porting the suite into an opt-in "Tablet" tab

**Legend, sources and method**

- **CM/** is `C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga\`. It is not a git repo, so there is no history or diff to lean on.
- **AIO/** is `C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\`, branch `fix/mangafire-cloudflare-challenge` at `d1ae7d6`.
- **SPEC** is the Komikku local-source spec that AIO deleted in commit `1f17a20`. It is still readable with `git show 1f17a20^:komikkuspec.md` (346 lines, cited as `SPEC:<line>`). That commit is on no branch, and AIO/aio-dl.py:7818 still cites it.
- **PC library on this machine** is `D:\AIO\manga`. That is AIO workingDir `D:\AIO` plus the default `manga` (`%APPDATA%\aio-downloader-ui\settings.json:4`; AIO/UI-source/electron/main.js:220-233). It holds 134 directories. The root contains `.aio_folder_alloc.lock`.
- **Inputs.** This brief folds together 4 census reports and 4 adversarial verifications. Where a verification refuted a census claim, the verification wins. Every "missed" item is included.
- **Files re-read in full by this synthesis:**
  - CM/compare_manga.py (1524 lines)
  - CM/sync_to_tablet.py (1125)
  - CM/push_all_to_tablet.py (930)
  - CM/manga_ops.py (368)
  - CM/verify_push.py (146)
  - CM/_verify_chapters.py (68)
  - CM/_watch_progress.py (69)
  - the alias and mapping tables in CM/_compare_tablet_vs_pc.py, CM/_delta_findings.py and CM/batch_search.py
  - SPEC
- **Nothing was executed** except read-only listings, greps and `git status/diff/log/show`. No adb was run.

---

## 1. What the CompareManga suite does end-to-end

Timeline, from CM directory mtimes and the logs:
- 2026-05-11: dashboard.
- 2026-05-12: batch search.
- 2026-05-23: PDF-to-Komikku forensic analysis.
- 2026-05-24: first whole-folder push.
- 2026-06-14: library repack, canary run, then a full mirror (111 series in 104.7 min, CM/full_mirror_stderr.log:553).
- 2026-06-15: verify report.
- 2026-07-06..15: file-level sync runs on a new device.

**C1. Read-only PC-vs-tablet comparator and report (CM/compare_manga.py). DURABLE.**

It documents itself as never writing to either library (:1-6).

- **PC side.** Scans the PC root one level deep, skipping dot entries plus `.aio_coord` and `.aio_folder_alloc.lock` (:63-64, 336-351). Reads each series' `.aio_series.json`: title, status, site, format and chapters_downloaded (:366-381). Counts only depth-1 `.pdf`/`.cbz` files (:398-400).
- **Tablet side.** Lists the tablet in ONE `adb shell` call: depth-1 dirs, a sentinel, then `find -type f -printf` size, mtime and path (:521-551). The listing is cached as JSON v2, validated by device, root and a 24 h TTL (:571-625, 59).
- **Matching.** Series are matched only by normalized folder name: strip ` (hid=…)`, NFKC, casefold, `_`→space, delete apostrophes, other punctuation→space (:292-307, 762-793). PC hid variants collapse into one series. The canonical member is the one with most chapters, then valid JSON, then name (:850-856).
- **Chapter diff and anomalies.** Diffs chapter labels parsed by six filename patterns (:71-103, 280-289). Flags seven anomaly kinds (:216-224, 859-1079).
- **Output.** Writes a console summary (ANSI colour only on a TTY, :1455-1460), a text report and a JSON report (:1117-1347). Exit codes: 2 on errors, 1 if any anomaly exists, 0 otherwise (:1462-1520).
- **Why durable:** this becomes the tab's Compare view.
- **Lesson:** it has no alias table and no Komikku `Ch.NNN` pattern. On the Komikku-layout tablet, the 2026-06-15 run reported:
  - 14 PC-only and 15 tablet-only series that are really alias pairs;
  - 97 "orphan" warnings that are only `cover.jpg`/`details.json` (CM/_verify_report.txt:7-15, 53-57; CM/_verify_report.json:1490-1503).

  As a result it exits 1 on every run against a Komikku tablet.

**C2. Local web dashboard (CM/manga_manager.py, CM/templates/*, CM/static/app.js). DURABLE capability, ONE-OFF shell.**

The shell is Flask + waitress on 127.0.0.1:5000 and auto-opens the browser (CM/manga_manager.py:58-59, 879-941). It uses compare_manga as a library (:49) and memoizes the view for 120 s (:61-63, 155-170).

UI pieces:
- **Catalog strip** with six counters (templates/partials/dashboard_root.html:3-19; manga_manager.py:217-238).
- **Fixed sections:** Tablet missing / Only on tablet / Shared · gaps, plus collapsed Synced and Anomalies folds (dashboard_root.html:21-78; manga_manager.py:186-211, 257-341).
- **Detail card** with cover, stats and "Select all N to push/delete" (series_detail.html:1-68; manga_manager.py:344-409).
- **Per-chapter PC-vs-tablet table** with suggested push/delete (_chapter_table.html:1-44; manga_manager.py:353-437).
- **Client-side selection** with a sticky action bar (static/app.js:8-129).
- **Preview/confirm modal** (manga_manager.py:445-551, 712-758; confirm_modal.html:1-77).
- **SSE progress modal** with Cancel (manga_manager.py:760-813; progress_modal.html:1-45; app.js:133-225).
- **Refresh**, which forces a fresh adb scan (manga_manager.py:815-822).
- **Cover proxy** with a disk cache (manga_manager.py:602-664, 824-857).

There are no search, filter or sort controls; ordering is fixed (manga_manager.py:202-211). The Flask/htmx shell itself is replaced by the Electron tab. Its UI bugs are lessons, listed in §6.

**C3. Selective per-chapter push/delete (manga_manager op resolution + CM/transfer_runner.py + CM/manga_ops.py). DURABLE.**

- **Resolving a selection.** Pushes only chapter labels missing on the tablet, so it never intentionally overwrites. Deletes match by label or filename (including unlabelled orphans), depth-1 only (CM/manga_manager.py:445-599).
- **Job runner.** A daemon worker runs ONE batch at a time globally; a second request gets HTTP 409 "busy".
  - Events: `batch_start`, `file_start`, `file_progress` (throttled 0.2 s), `file_done`, `batch_done`, `batch_cancelled`, `batch_aborted_due_to_errors`, plus 15 s heartbeats.
  - Cancel is cooperative. The batch aborts after 3 consecutive failures (CM/transfer_runner.py:64-117, 130-242; manga_manager.py:760-813).
- **Push** = `adb shell mkdir -p` + `adb push <file> <dir>/`, with `NN%` parsing and terminate-then-kill cancel (CM/manga_ops.py:110-264).
- **Delete** = one `rm -f` per file (:267-287). Folder delete is a deliberate `NotImplementedError` stub (:290-302).

**C4. Incremental, content-hash, resumable file-level sync (CM/sync_to_tablet.py). DURABLE; this is the core engine.**

- **What it hashes.** SHA-256 of every mirrorable PC file, and only these: `*.cbz`, exact `cover.jpg`, exact `details.json` (:99-102, 168-173). Hashing uses an 8-thread pool with 1 MiB reads (:236-241, 262-320).
- **Comparison.** Lists the tablet once (reusing compare_manga's find, :332-357) and compares against a per-device journal `.sync_state-<serial>.json` (:487-513). A file is "good" only if the tablet size matches AND the journal hash equals the fresh PC hash. mtime is never used (:539-544, 586-596).
- **Plan (the default mode, :653-726)** prints:
  - totals;
  - a per-series table: push count, GB, delete count, NEW;
  - ORPHANED folders (journaled, PC series gone) and PRESERVED folders (never journaled, no PC target);
  - a first-run note recommending `--verify`.
- **Apply, per series:**
  1. `mkdir -p`;
  2. best-effort sidecar `rm -f`;
  3. delete removed files FIRST;
  4. push. Files with an all-ASCII source path go in batches of ≤50 files / ≤12,000 path chars. Any non-ASCII source path is pushed alone to an explicit remote file path.
  5. The journal is flushed after every delete batch and every push batch (:776-873, 112-117, 417-479).
- **Options:**
  - `--verify` runs `sha256sum` on managed tablet folders and rebuilds their journal entries (:360-387, 734-768).
  - `--fast` trusts a (size, mtime) PC cache (:244-320).
  - `--prune` with `--apply` runs `rm -rf` on orphans (:876-887, 1117-1119).
  - `--only`/`--skip` filter by raw PC folder name (:554-557).
- **Safety and bookkeeping.** Typed yes/y confirm (:1104-1112). Exit codes 0/2/3 (:1043-1121). An atomic JSON log is rewritten after every series (:890-904).
- **Observed runs:**
  - resume after a USB drop: 107 series / 18,231 files / 133.45 GB in 71.4 min (CM/sync-log-20260706-223001.json; CM/synclogs07.md:1626);
  - incremental run: 27 series / 1,348 files / 10.3 GB in ~5.7 min (CM/sync-log-20260715-022050.json:2-7).

**C5. Whole-folder wipe-and-re-push mirror (CM/push_all_to_tablet.py). ONE-OFF (superseded).**

Per PC norm group (canonical = most chapters):
1. `rm -rf` every matched tablet folder;
2. pre-clean stale landings;
3. `adb push` the whole PC folder recursively into the tablet root (4 h timeout);
4. find the landed basename using the adb-truncation model plus a byte-length-pinned listing fallback;
5. `mv` it to the target name;
6. strip 3 sidecars.

Failures are logged, the loop continues, and the log is persisted per series (:1-40, 319-396, 676-796). sync_to_tablet states it replaces this tool (CM/sync_to_tablet.py:5-7).

- **Lesson:** never wipe-then-push. It is not transactional, and its own plan showed 15 series losing ≥20 tablet-only chapters, worst −372 (CM/push_run.log:104-120).
- **Keep from it:** the folder-adoption matching (C6), the chapter-loss warning (C7) and the landed-name model (:319-360).

**C6. Adopting existing tablet folders under different names (push_all `build_plan`). DURABLE, and missing from sync.**

Groups PC folders by norm key. Maps each tablet folder through the 14 aliases or its own norm. The plan prints EXPLICIT ALIAS MAPPINGS, TABLET-SIDE RENAME, NEW SERIES and TABLET-ONLY PRESERVED sections (CM/push_all_to_tablet.py:413-504, 544-668).

sync_to_tablet cannot do this: its target naming ignores existing tablet folder names (CM/sync_to_tablet.py:219-228, 577-579). A device with differently named folders therefore gets duplicates, and the old folder is classified "preserved".

**C7. Chapter-loss warning. DURABLE.**

push_all flags series where the tablet has ≥20 more depth-1 pdf/cbz than the PC (CM/push_all_to_tablet.py:521-541, 598-639). The analysis docs used −50 as a "refresh the PC copy first" shortfall threshold (CM/REDOWNLOAD_FOR_KOMIKKU.md:154-169). They also hand-listed three real content-loss series (CM/DELTA_FINDINGS.md:387-400).

**C8. Post-apply verification (CM/verify_push.py, CM/_verify_chapters.py). DURABLE capability, ONE-OFF scripts.**

- **verify_push.py** prints failures from the newest `transfer-log-*.json`, rescans, and reports:
  - MISSING and EXTRA tablet folders;
  - chapter-count mismatches;
  - a hard-coded SHELTER check (CM/verify_push.py:29-142).
- **_verify_chapters.py** compares per-folder `.cbz` counts, alias- and hid-aware through `build_plan`, and prints PASS/FAIL (CM/_verify_chapters.py:1-68).
- **Script limitations:**
  - verify_push only understands push_all logs (:29-35, 56) and fails only on some discrepancies (:128-142);
  - _verify_chapters uses the default serial directly (:19) and has no timeouts (:24-25).

**C9. Progress watcher (CM/_watch_progress.py). ONE-OFF.**

Tails push_all's append-only stderr trace and exits on fail / done / batch / heartbeat (:1-69).

- **Lesson:** stream progress events. Never read the atomically rewritten JSON log mid-run; it can collide with `os.replace` on Windows (:4-6).

**C10. Canary subset run. DURABLE, as "run selected series first".**

The two riskiest non-ASCII series (Hell's Paradise, SPY×FAMILY) were pushed alone first (CM/canary-log.json:1-31; CM/canary_stderr.log:6-17). The 111-series mirror followed (CM/full-mirror-log.json:2-3).

**C11. Tablet path-safety and name sanitizing (CM/manga_ops.py). DURABLE.**

- **Path validator.** Every device path is checked before `shlex.quote`: non-empty, ≤4096 chars, no CR/LF/NUL, not the root itself, strictly under root+`/` (which blocks `DocumentsX`), no `..` segment (:86-107).
- **Segment sanitizer.** NFKC; strips `/ \ : * ? " < > |` and U+0000-001F; trims trailing ` .`; rejects `''`, `.` and `..` (:41-47, 70-83).
- **Self-test** at :308-363.
- **Duplicate:** push_all re-implements a weaker validator (ValueError, no 4096 cap; CM/push_all_to_tablet.py:238-255).

**C12. adb and device resolution (CM/compare_manga.py:444-489). DURABLE.**

- adb: explicit override, then PATH, then `KNOWN_ADB_PATH`.
- Device: the override must be connected; else the single connected device; else the default serial if it is connected; else error. Only devices in state `device` count.

**C13. Batch cross-site source search (CM/batch_search.py). DURABLE capability, ONE-OFF implementation.**

- For 64 hard-coded (tablet folder → query) pairs it calls AIO's `search_all(seeded_only=True)` in-process.
- It saves the top-5 `SeriesCandidate.to_json()` per folder to `seed_links.json` atomically after every query, and resumes by skipping entries that have no error (:164-284).
- **Why the implementation is one-off:** it `chdir`s into a checkout path that no longer exists, imports private AIO helpers, and monkey-patches the probe deadline (:35-64).

**C14. Seed-link manual overrides (CM/fixup_seed_links.py). DURABLE concept, ONE-OFF data.**

Three in-place edits (:34-111):
- a pinned URL for SHELTER;
- promote-by-URL-substring for Tensura;
- promote-the-official-site for Eleceed.

The generalizable features are a per-series pinned source URL and a per-series preferred source.

**C15. Seed-link reports (CM/render_seed_links.py; batch_search.render_txt). ONE-OFF.**

Markdown and TXT tables (render_seed_links.py:1-105; batch_search.py:181-206). AIO's Search result cards already show ranked sources.

**C16. Reader-compatibility classification of the device (CM/_classify_tablet.py). DURABLE concept, ONE-OFF script.**

- Per device series it counts archive extensions and checks for exact `cover.jpg`. Actions: pdf-only → redownload; pdf+cbz → redownload_pdfs; cbz without cover → add_cover; cbz with cover → ok; otherwise → empty (:8-11, 26-28, 59-90).
- 2026-05-23 result: 59 redownload, 1 redownload_pdfs, 6 add_cover, 1 ok (CM/tablet_classify.json).
- **Lesson:** drive this from a "reader profile". The script ignored zip/cbr/rar/epub when deciding (:64-65, 73-82).

**C17. Device→PC matching plus remediation recommendation (CM/_compare_tablet_vs_pc.py). DURABLE concept, ONE-OFF script.**

- Matching: a 9-entry alias table first, then the normalized name; empty PC variants are dropped; counts are aggregated across variants.
- Recommendations: download / push / push-no-cover / push-pdfs / push-mixed / push-empty (:43-181).
- Result: 13 download, 53 push (CM/tablet_vs_pc.json).

**C18. Chapter-label diff with cause tags (CM/_delta_findings.py). DURABLE concept, ONE-OFF script.**

- Parses labels on both sides with six regexes (:109-131).
- Computes device-only, PC-only and shared sets.
- Tags causes: sub-chapter splits, Ch 0 prologues, PC ahead, tablet ahead, numbering differences (:186-293).
- Result: 43 of 50 mapped series had non-zero deltas (CM/delta_findings.json).
- **Lessons** are in §6 (volume files parsed as chapters, content loss indistinguishable from numbering mismatch).

**C19. Migration decision documents (CM/REDOWNLOAD_FOR_KOMIKKU.md, CM/DELTA_FINDINGS.md). ONE-OFF.**

- The 66-series plan: 51 push, 15 fresh download.
- Content-loss and shortfall lists; per-series narratives; manual revisions.
- **Lesson:** decisions must be persisted, editable overrides that every computation reads. Here they lived in code comments and hand-edited Markdown.

**C20. PC inventory scans (CM/_scan_pc_sizes.ps1, CM/_scan_pc_repack.ps1). ONE-OFF.**

- Size, format, cover and metadata inventory; repack-scope histogram.
- **Lesson:** a library repack on 2026-06-14 rewrote every CBZ in 110 of 111 series (CM/_pc_repack.json). mtime-based sync is therefore useless, and a metadata-only sync path is worth having.

**C21. Pure-function self-tests. ONE-OFF as user features; port as unit tests.**

- CM/compare_manga.py:1355-1411
- CM/sync_to_tablet.py:912-992, including the non-ASCII-folder regression
- CM/push_all_to_tablet.py:804-819 (live alias validation)
- CM/manga_ops.py:308-363

---

## 2. Master CLI-flag table (every script, deduplicated)

UI-home key, reused in §3:
- **[S-TS]** — new "Tablet Sync" section in Settings > Library (a `SECTIONS` entry with group `library`, AIO/UI-source/src/components/SettingsTab.jsx:2770-2788).
- **[S-TS-Adv]** — a Collapsible "Advanced" block inside it.
- **[T-Dev]** — the new tab's per-device profile panel.
- **[T-Run]** — the tab's Preview/Apply dialog.
- **[T-Ovr]** — per-series override editor.
- **[T-Aliases]** — list view of all aliases and overrides.
- **[Derived]** — computed from AIO, not editable.
- **[Internal]** — implementation constant.

| Script(s) | Flag | Default | Meaning | Source | UI home |
|---|---|---|---|---|---|
| compare_manga, manga_manager | `--pc-root PATH` | `D:\AIO\manga` (DEFAULT_PC_ROOT) | PC library root; missing → exit 2 | CM/compare_manga.py:1424, 55, 1473-1475; CM/manga_manager.py:899, 918-920 | [Derived] AIO output root |
| compare_manga, manga_manager | `--tablet-root PATH` | `/storage/self/primary/Documents` | Device library root; also the path-safety root for every write | CM/compare_manga.py:1425, 56; CM/manga_manager.py:900 | [T-Dev] destination folder |
| compare_manga, manga_manager, sync_to_tablet, push_all_to_tablet | `--device SERIAL` | auto: the only connected device, else `3CEF42502E91537` if connected, else error | adb serial; override must be in state `device` | CM/compare_manga.py:1426-1427, 460-489; CM/manga_manager.py:901, 913-917; CM/sync_to_tablet.py:1024, 1045; CM/push_all_to_tablet.py:845-847 | [T-Dev] device picker |
| compare_manga, manga_manager | `--adb PATH` | auto: PATH, then `KNOWN_ADB_PATH` | adb binary (must exist) | CM/compare_manga.py:1428-1429, 444-457; CM/manga_manager.py:902, 908-912 | [S-TS] adb path + Auto-detect |
| compare_manga | `--refresh-cache` | off | Ignore the cached listing and rescan the device | CM/compare_manga.py:1430, 639-642 | Tab toolbar "Rescan device" |
| compare_manga, manga_manager | `--cache-file PATH` | `<script dir>/.tablet_cache.json` | Device listing cache | CM/compare_manga.py:1431-1432; CM/manga_manager.py:903 | [Internal] |
| compare_manga, manga_manager | `--cache-ttl-hours H` | 24.0 | Max cache age | CM/compare_manga.py:1433, 59, 588-591; CM/manga_manager.py:904 | [Internal] / [S-TS-Adv] |
| compare_manga | `--report-file PATH` | `<script dir>/report-<YYYYMMDD-HHMMSS>.txt` | Text report ("# Compare Manga Report v1", ANSI stripped), non-atomic write | CM/compare_manga.py:1434-1435, 1496, 1247-1248, 1506-1508 | Compare view "Export report" |
| compare_manga | `--json-out PATH` | `<script dir>/report-<ts>.json` | JSON report v1 | CM/compare_manga.py:1436-1437, 1497, 1509-1518, 1313-1347 | Compare view "Export report" |
| compare_manga, manga_manager | `--size-threshold PCT` | 30.0 (manga_manager uses a literal 30.0, not the constant) | size_mismatch threshold; cross-format pairs skipped | CM/compare_manga.py:1438-1440, 60, 947-1025; CM/manga_manager.py:905 | [S-TS-Adv] |
| compare_manga | `--no-color` | off (colour only when stdout is a TTY) | Disable ANSI | CM/compare_manga.py:1441, 1455-1460 | n/a (GUI) |
| compare_manga | `-q`, `--quiet` | off | Print header + SUMMARY only | CM/compare_manga.py:1442, 1160 | n/a (summary strip) |
| compare_manga | `-v`, `--verbose` | off | List every shared series in the gaps section, including synced ones, and always print "extra on tablet" | CM/compare_manga.py:1443, 1202-1203, 1214 | Compare view "Show synced" filter |
| compare_manga, sync_to_tablet, push_all_to_tablet | `--self-test` | off | compare_manga: normalize/parse/sort cases. sync: naming, `is_content_file`, alias bijection, diff, preserve/orphan, chunk caps, ASCII routing. push_all: every alias PC target exists in the live library | CM/compare_manga.py:1444, 1355-1411; CM/sync_to_tablet.py:1032-1033, 912-992; CM/push_all_to_tablet.py:851-852, 804-819 | Unit tests (gitignored `tools/_test_*.js`); alias validity becomes a live warning in [T-Aliases] |
| manga_manager | `--host` | `127.0.0.1` | Bind address | CM/manga_manager.py:58, 895-896 | n/a |
| manga_manager | `--port` | 5000 | HTTP port | CM/manga_manager.py:59, 897 | n/a |
| manga_manager | `--no-browser` | off | Don't auto-open the browser | CM/manga_manager.py:898, 935-936 | n/a |
| sync_to_tablet, push_all_to_tablet | `--plan` | implicit default. Parsed but never read, so `--plan --apply` still applies | Print plan and exit | CM/sync_to_tablet.py:1005-1006, 1097-1098; CM/push_all_to_tablet.py:832, 906-907 | Tab "Preview" (always first) |
| sync_to_tablet, push_all_to_tablet | `--apply` | off | Execute after confirmation | CM/sync_to_tablet.py:1007-1008, 1097-1115; CM/push_all_to_tablet.py:833-834, 906-925 | [T-Run] Apply |
| sync_to_tablet, push_all_to_tablet | `--yes`, `-y` | off | Skip the typed yes/y prompt; abort → exit 3 | CM/sync_to_tablet.py:1009-1010, 1104-1112; CM/push_all_to_tablet.py:835-836, 910-918 | Confirm dialog (always shown) |
| sync_to_tablet, push_all_to_tablet | `--only PC_FOLDER` (repeatable) | [] | sync: raw PC folder name, filtered BEFORE planning (orphan/preserve/verify still use the full set; prune ignores it). push_all: canonical PC folder, filtered AFTER planning | CM/sync_to_tablet.py:1020-1021, 554-555, 625, 1083; CM/push_all_to_tablet.py:837-840, 893-895 | Tab series checkboxes, "Sync selected" |
| sync_to_tablet, push_all_to_tablet | `--skip PC_FOLDER` (repeatable) | [] | Inverse of `--only`, with the same split semantics | CM/sync_to_tablet.py:1022-1023, 556-557; CM/push_all_to_tablet.py:841-844, 896-898 | Selection + persistent "Exclude" in [T-Ovr] |
| sync_to_tablet, push_all_to_tablet | `--log PATH` | sync: `<script dir>/sync-log-YYYYMMDD-HHMMSS.json`. push_all: `<script dir>/transfer-log-<ts>.json` (full-mirror-log.json and canary-log.json were made via `--log`) | Per-run apply log | CM/sync_to_tablet.py:1031, 1114; CM/push_all_to_tablet.py:848-850, 920-923 | [Internal] run history + "Open run log" |
| sync_to_tablet | `--verify` | off | sha256sum managed tablet folders and rebuild their journal before planning | CM/sync_to_tablet.py:1011-1013, 1080-1086 | [T-Run] "Verify device (hash)"; auto-offered for a new device |
| sync_to_tablet | `--fast` | off | Trust the (size, mtime) PC hash cache | CM/sync_to_tablet.py:1014-1016, 1064-1068 | [S-TS] change-detection mode + per-run override |
| sync_to_tablet | `--prune` | off | With `--apply`, `rm -rf` orphaned folders | CM/sync_to_tablet.py:1017-1019, 1100, 1117-1119 | [T-Run] checkbox listing each orphan |
| sync_to_tablet | `--workers N` | 8 (min 1) | Hashing threads | CM/sync_to_tablet.py:1025-1026, 1067 | [S-TS-Adv] (auto = CPU count) |
| sync_to_tablet | `--state PATH` | `<script dir>/.sync_state-<device>.json` | Journal path | CM/sync_to_tablet.py:1027-1028, 487-488, 1054 | [Internal] (userData, per device + root) |
| sync_to_tablet | `--pc-cache PATH` | `<script dir>/.pc_hash_cache.json` | PC hash cache; read only with `--fast`, always written | CM/sync_to_tablet.py:1029-1030, 1064-1069 | [Internal] |
| _watch_progress | `--log PATH` (required) | — | stderr trace to tail | CM/_watch_progress.py:44 | n/a (live events) |
| _watch_progress | `--target N` (required) | — | Exit when N series have completed | CM/_watch_progress.py:45, 59-61 | n/a |
| _watch_progress | `--seen-fails N` | 0 | Exit when the `!! ERROR:` count exceeds N | CM/_watch_progress.py:46, 53-55 | n/a |
| _watch_progress | `--max-seconds N` | 1500 | Heartbeat exit | CM/_watch_progress.py:47, 62-64 | n/a |
| _watch_progress | `--poll N` | 15 | Seconds between reads | CM/_watch_progress.py:48, 65 | n/a |
| _classify_tablet | `<dump_path>` (positional argv[1]) | `/tmp/tablet_files.txt` | Device path dump to classify; JSON to stdout | CM/_classify_tablet.py:92, 96-97 | n/a (live "Reader compatibility" view) |
| (documented operator step) | `adb -s 3CEF42502E91537 shell "find /storage/self/primary/Documents -mindepth 1 -type f -printf '%p\n'"` | — | Produced tablet_files.txt | CM/REDOWNLOAD_FOR_KOMIKKU.md:175-179 | n/a (the tab lists the device itself) |

**Scripts with no flags:**
- CM/_compare_tablet_vs_pc.py, CM/_delta_findings.py (CWD-relative inputs, JSON to stdout; :113-115, 183 / :32, 293).
- CM/verify_push.py (`main()` takes no arguments, :38, 145-146).
- CM/_verify_chapters.py (module-level script).
- CM/batch_search.py (no argparse; resume is implicit, :164-171, 209-284).
- CM/fixup_seed_links.py and CM/render_seed_links.py (render at :92-105).
- CM/_scan_pc_repack.ps1, CM/_scan_pc_sizes.ps1.
- CM/manga_ops.py (running it runs the self-test, :366-368).
- CM/transfer_runner.py (library only: `start_transfer(error_budget=3)`, :85-92).

**Flags that do not exist but matter:** sync and push_all have no `--pc-root`, `--tablet-root` or `--adb`.
- Roots are module constants captured at import (CM/sync_to_tablet.py:86-87; CM/push_all_to_tablet.py:109-110).
- Both call `resolve_adb(None)` (CM/sync_to_tablet.py:1044; CM/push_all_to_tablet.py:161), even though its error text says "Pass --adb" (CM/compare_manga.py:454-457).
- sync strips the trailing `/` from TABLET_ROOT; push_all does not (CM/sync_to_tablet.py:87 vs CM/push_all_to_tablet.py:110).

---

## 3. Master hard-code table → user configuration

### 3.1 Roots, device and adb

| Hard-coded value | Where | Purpose | Proposed UI home | Auto-detect? |
|---|---|---|---|---|
| PC root `D:\AIO\manga`. Older root `C:\Users\legoc\OneDrive\Belgeler\AIO-Webtoon-Downloader\mangas` (no longer exists) | CM/compare_manga.py:51-55; CM/_scan_pc_repack.ps1:6. Old root: CM/_compare_tablet_vs_pc.py:34, CM/_delta_findings.py:31, CM/_scan_pc_sizes.ps1:1, seen in CM/push_run.log:9 | PC side of every compare/sync | [Derived] `getConfiguredOutputRoot(resolveSpawnPaths(settings).workingDir)` (AIO/UI-source/electron/main.js:220-233, 361-367). Show read-only in [T-Dev] with a link to Settings > General > Paths. No IPC exposes it today (main.js:682-688) | **Yes** |
| Tablet root `/storage/self/primary/Documents` | CM/compare_manga.py:56; CM/_classify_tablet.py:26; CM/_delta_findings.py:33; CM/_verify_report.json:5 | Destination root; also the path-safety root | [T-Dev] "Destination folder on device" per profile. Presets: Perfect Viewer `/storage/self/primary/Documents`; Komikku `<SAF root>/local`, e.g. `/storage/emulated/0/Komikku/local` (SPEC:30, 242); AIO for Android `/storage/emulated/0/Android/data/com.aio.downloader/files/manga` (AIO/android/app/src/main/java/com/aio/downloader/core/Aio.kt:52-53). Plus a remote folder browser (adb `ls`) | **Partly.** Candidates can be probed; the reader app's configured root cannot be read |
| Device serial `3CEF42502E91537` (preferred when several are connected; used unconditionally by _verify_chapters). A second device `A06B4A372090333` was used by every July sync run | CM/compare_manga.py:57, 485-486; CM/_verify_chapters.py:19; CM/synclogs07.md:1629; journal filename `.sync_state-A06B4A372090333.json` | Which device to target | [T-Dev] device picker. Profiles keyed by serial; "preferred device" replaces the hard-coded fallback | **Yes** (`adb devices -l`). Must surface unauthorized/offline, which `resolve_device` silently drops (CM/compare_manga.py:468-474) |
| adb path `KNOWN_ADB_PATH = C:\Users\legoc\OneDrive\Belgeler\Scripts\ADB\platform-tools\adb.exe` | CM/compare_manga.py:58, 444-457 | Fallback after PATH | [S-TS] "adb executable": Auto-detect + Browse. pick-file defaults to a `*.py` filter, so pass an explicit `.exe` filter (AIO/UI-source/electron/main.js:897-904) | **Yes.** Both this path and `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` exist (read-only `ls`; SDK path documented at AIO/android/TESTING.md:37). PATH contains the Scripts\ADB entry (CM/synclogs07.md:1628 shows `adb.EXE`, resolved via PATH). Order: PATH → ANDROID_HOME/ANDROID_SDK_ROOT → %LOCALAPPDATA% SDK → override |

### 3.2 Alias / rename / folder-mapping tables (IN FULL)

**3.2.1 `ALIASES_TABLET_TO_PC`: 14 entries, tablet folder → PC folder** (CM/push_all_to_tablet.py:74-92).
- sync_to_tablet inverts it into `PC_TO_TABLET_ALIAS` and uses it for naming only (CM/sync_to_tablet.py:104-110, 226-227; self-test examples :924-927).
- It is gated by `KEEP_TABLET_NAME_FOR_ALIASES = True`, a user decision on 2026-05-24: aliased pairs keep the tablet's name (CM/push_all_to_tablet.py:94-100).
- The July verify still listed every alias's tablet-side name on the device (CM/synclogs07.md:1636).

| # | Tablet folder (key) | PC folder (value) | Also in the May 9-entry table? | Why normalization can't bridge it |
|---|---|---|---|---|
| 1 | A Certain Scientific Railgun | Toaru Majutsu no Index Gaiden Toaru Kagaku no Railgun | yes | EN vs JP title |
| 2 | CØDEBREAKER | Code Breaker | yes | Stylized `Ø` |
| 3 | Every Day Is a Holiday (Colored) | Kinenbi Manga | no | EN vs JP |
| 4 | Fullmetal Alchemist | FULL METAL ALCHEMIST | no | "fullmetal" vs "full metal" |
| 5 | Ghost Sore wa rei no Shiwaza desu | Sore wa rei no Shiwaza desu | no | Extra leading word |
| 6 | Is_the_order_a_rabbit | Gochuumon wa Usagi desu ka | yes | EN vs JP |
| 7 | JoJo's Bizarre Adventure Part 5 Golden Wind | JoJo no Kimyou na Bouken Part 5 - Ougon no Kaze | yes | EN vs JP |
| 8 | JoJo's_Bizarre_Adventure_Part_4_Diamond_is_Unbreakable | JoJo no Kimyou na Bouken Part 4 - Diamond wa Kudakenai | no. Deliberately NOT aliased in May (CM/_compare_tablet_vs_pc.py:50-54); later reversed | EN vs JP |
| 9 | Makeine Make Hiroin ga Ōsugiru! | Too Many Losing Heroines! | yes | Romaji vs EN |
| 10 | No Longer Allowed In Another World | Isekai Shikkaku | yes | EN vs JP |
| 11 | One-Punch_Man_(Official) | One-Punch Man | yes | `(Official)` suffix |
| 12 | Record of Ragnarok | Shuumatsu no Valkyrie | yes | EN vs JP |
| 13 | SPY_x_FAMILY | SPY×FAMILY | yes | `×` is U+00D7 (CM/REDOWNLOAD_FOR_KOMIKKU.md:197) |
| 14 | Slow Life In Another World (I Wish!) | Isekai de Slow Life o (Ganbou) | no | EN vs JP. This PC folder was forked by a MangaDex retitle (AIO/UI-source/electron/series-merge.js:4-8) |

**3.2.2 `TABLET_TO_PC_ALIAS` (May, 9 entries)** is a strict subset of the 14: rows 1, 2, 6, 7, 9, 10, 11, 12, 13 (CM/_compare_tablet_vs_pc.py:43-60; duplicated in CM/REDOWNLOAD_FOR_KOMIKKU.md:189-197). The table comment says JoJo Parts 4 and 6 were deliberately left out (:50-54).

**3.2.3 `PUSH_MAP`: 50 entries, tablet folder → PC folder** (CM/_delta_findings.py:42-107). It equals REDOWNLOAD sections B.1 (44) + B.2 (1) + B.3 (6) minus Dragon Ball. "(same)" means the names are identical.

| # | Tablet | PC | # | Tablet | PC |
|---|---|---|---|---|---|
| 1 | 'Tis Time for Torture, Princess | (same) | 26 | Lycoris_Recoil | Lycoris Recoil |
| 2 | A Certain Scientific Railgun | Toaru Majutsu no Index Gaiden Toaru Kagaku no Railgun | 27 | Makeine Make Hiroin ga Ōsugiru! | Too Many Losing Heroines! |
| 3 | A Couple of Cuckoos | (same) | 28 | My youth romantic comedy is wrong as I expected | My Youth Romantic Comedy Is Wrong, As I Expected |
| 4 | Angel Beats! Heaven's Door | Angel Beats! - Heaven's Door | 29 | No Longer Allowed In Another World | Isekai Shikkaku |
| 5 | Attack_on_Titan | Attack on Titan | 30 | One-Punch_Man_(Official) | One-Punch Man |
| 6 | Berserk | (same) | 31 | Pandora Hearts | (same) |
| 7 | Bleach | (same) | 32 | Pandora Seven | (same) |
| 8 | Bungo Stray Dogs | Bungo Stray Dogs (hid=PW1SJ) | 33 | Record of Ragnarok | Shuumatsu no Valkyrie |
| 9 | Chainsaw Man | (same) | 34 | Rinjin-chan ga Shinpai | (same) |
| 10 | Claymore | (same) | 35 | Sakamoto Days | (same) |
| 11 | CØDEBREAKER | Code Breaker | 36 | Sentenced to Be a Hero The Prison Records of Penal Hero Unit 9004 | (same) |
| 12 | Demon_Slayer_Kimetsu_no_Yaiba | Demon Slayer Kimetsu no Yaiba | 37 | Shiunji-ke no Kodomotachi | (same) |
| 13 | EDENS ZERO | (same) | 38 | Sleepy Princess in the Demon Castle | (same) |
| 14 | Fly Me to the Moon | (same) | 39 | Solo Leveling | (same) |
| 15 | Horimiya | (same) | 40 | SPY_x_FAMILY | SPY×FAMILY |
| 16 | I Was Supposed to Never Fall in Love with You | (same) | 41 | Talentless Nana | (same) |
| 17 | Is_the_order_a_rabbit | Gochuumon wa Usagi desu ka | 42 | That Time I Got Reincarnated as a Slime | (same) |
| 18 | JoJo's Bizarre Adventure Part 5 Golden Wind | JoJo no Kimyou na Bouken Part 5 - Ougon no Kaze | 43 | The Angel Next Door Spoils Me Rotten | (same) |
| 19 | JoJo's_Bizarre_Adventure_Part_1_Phantom_Blood | JoJo's Bizarre Adventure Part 1 Phantom Blood | 44 | The Angel Next Door Spoils Me Rotten After the Rain | (same) |
| 20 | JoJo's_Bizarre_Adventure_Part_2_Battle_Tendency | JoJo's Bizarre Adventure Part 2 Battle Tendency | 45 | The Legend of the Northern Blade | (same) |
| 21 | JoJo's_Bizarre_Adventure_Part_3_Stardust_Crusaders | JoJo's Bizarre Adventure Part 3 Stardust Crusaders | 46 | Tower of God | (same) |
| 22 | Kagurabachi | (same) | 47 | Undead Unluck | (same) |
| 23 | Komi_Can't_Communicate | Komi Can't Communicate | 48 | Vivy_-Fluorite_Eye's_Song- | Vivy -Fluorite Eye's Song- |
| 24 | Konosuba God's Blessing on This Wonderful World! | Konosuba God's Blessing on This Wonderful World! (hid=gvHMj) | 49 | You and I are Polar Opposites | You and I Are Polar Opposites |
| 25 | Link Click | (same) | 50 | You are Ms. Servant | You Are Ms. Servant |

**3.2.4 batch_search `SERIES`: 64 (tablet folder → search query) pairs** (CM/batch_search.py:74-141, guarded by `assert len == 64`).
- Stated derivation rules (:66-73): underscores → spaces; drop `(Official)`; keep `(Colored)`; drop Vivy's wrapping dashes; add `?` for Is the order a rabbit.
- Only these queries differ from their folder name. Asterisked entries can't be derived by rule:
  - 2.5_Dimensional_Seduction → 2.5 Dimensional Seduction
  - Attack_on_Titan → Attack on Titan
  - Demon_Slayer_Kimetsu_no_Yaiba → Demon Slayer Kimetsu no Yaiba
  - *Frieren Beyond Journey’s End (curly ’) → Frieren Beyond Journey's End (straight ')
  - *Is_the_order_a_rabbit → Is the order a rabbit?
  - JoJo's_Bizarre_Adventure_Part_1_Phantom_Blood → JoJo's Bizarre Adventure Part 1 Phantom Blood
  - JoJo's_Bizarre_Adventure_Part_2_Battle_Tendency → …Part 2 Battle Tendency
  - JoJo's_Bizarre_Adventure_Part_3_Stardust_Crusaders → …Part 3 Stardust Crusaders
  - JoJo's_Bizarre_Adventure_Part_4_Diamond_is_Unbreakable → …Part 4 Diamond is Unbreakable
  - Komi_Can't_Communicate → Komi Can't Communicate
  - Lycoris_Recoil → Lycoris Recoil
  - Made_in_Abyss → Made in Abyss
  - *One-Punch_Man_(Official) → One-Punch Man
  - SPY_x_FAMILY → SPY x FAMILY
  - *Vivy_-Fluorite_Eye's_Song- → Vivy Fluorite Eye's Song
- The other 49 are searched verbatim: 'Tis Time for Torture, Princess; A Certain Scientific Railgun; A Couple of Cuckoos; Angel Beats! Heaven's Door; Berserk; Bleach; Blue Box; Bungo Stray Dogs; Chainsaw Man; Claymore; CØDEBREAKER; Dragon Ball; EDENS ZERO; Eleceed; Every Day Is a Holiday (Colored); Fly Me to the Moon; Fullmetal Alchemist; Horimiya; I Was Supposed to Never Fall in Love with You; JoJo's Bizarre Adventure Part 5 Golden Wind; JoJo's Bizarre Adventure Part 6 Stone Ocean; Kagurabachi; Konosuba God's Blessing on This Wonderful World!; Link Click; Makeine Make Hiroin ga Ōsugiru!; My youth romantic comedy is wrong as I expected; No Longer Allowed In Another World; No More Love With the Girls; Pandora Hearts; Pandora Seven; Pandora's Box; Record of Ragnarok; Rinjin-chan ga Shinpai; SHELTER; Sakamoto Days; Sentenced to Be a Hero The Prison Records of Penal Hero Unit 9004; Shiunji-ke no Kodomotachi; Sleepy Princess in the Demon Castle; Solo Leveling; Talentless Nana; That Time I Got Reincarnated as a Slime; The Angel Next Door Spoils Me Rotten; The Angel Next Door Spoils Me Rotten After the Rain; The Apothecary Diaries; The Legend of the Northern Blade; Tower of God; Undead Unluck; You and I are Polar Opposites; You are Ms. Servant.

**3.2.5 Alias non-entries, reversals and naming flags**
- **JoJo Parts 4 and 6 "deliberately NOT aliased"** because of different numbering systems (CM/_compare_tablet_vs_pc.py:50-54). The later suite re-added Part 4 (CM/push_all_to_tablet.py:84-85). Leaving out an alias never excluded Part 6 anyway, because hid-stripping matched it (see §8).
- **`KEEP_TABLET_NAME_FOR_ALIASES = True`** (CM/push_all_to_tablet.py:100).

| Table | UI home | Auto-detect? |
|---|---|---|
| All alias / folder-mapping tables above | [T-Aliases] list (chip/row editor modelled on Settings > Search Sources, AIO/UI-source/src/components/SettingsTab.jsx:2555-2684) plus [T-Ovr] fields "Device folder name" and "Matches existing device folder". A one-time "Import CompareManga aliases" seeds the 14. Keys should be stable identity (`seriesIdentityKey`, AIO/UI-source/electron/library.js:480-487), with folder name as fallback | **Partly: suggestions only.** Sources: normalization; `anilist_synonyms` in `.aio_series.json` (present in all 132 metadata files per verification); device-side `.aio_series.json`/`.mangafire_hid` (15 / 22 series on the May dump). The user confirms each |
| batch_search queries | [T-Ovr] "Search query override"; default derived from the folder name by the rules above | **Yes for derivable ones**; the 4 asterisked entries need manual overrides |

### 3.3 Ignore / sidecar / mirrored-set / extension lists (IN FULL)

| List (full contents) | Where | Purpose | UI home | Auto-detect? |
|---|---|---|---|---|
| `IGNORE_TOP_LEVEL = {.aio_coord, .aio_folder_alloc.lock}` + every dot-prefixed entry. Duplicate `IGNORE_TOP` with the same values. `_scan_pc_sizes.ps1` excludes only `.aio_coord` | CM/compare_manga.py:63-64, 342; CM/sync_to_tablet.py:187; CM/_compare_tablet_vs_pc.py:35, 83; CM/_scan_pc_sizes.ps1:3 | PC-root entries that are never series | [Derived] from AIO: lock at AIO/aio-dl.py:952, coord dir at :8355. AIO's scanner already skips every dot entry (AIO/UI-source/electron/library.js:629-630) | **Yes** |
| `IGNORE_SERIES_FILES = {.aio_series.json, .mangafire_hid}` + dotfiles | CM/compare_manga.py:65-66, 389-392, 676-678 | Compare-side sidecars | [Derived] | **Yes** |
| sync `SIDECARS = (.aio_series.json, .mangafire_hid, .series_hid, .cover.webp)` | CM/sync_to_tablet.py:92-97, 807-813 | Never mirrored; `rm -f`'d from every target folder on each apply | [S-TS-Adv] "Never send / always remove from device". Default = AIO `METADATA_FILES` ∪ `.cover.*` | **Yes** (derive) |
| push_all `SIDECARS_ON_TABLET = (.aio_series.json, .mangafire_hid, .series_hid)` | CM/push_all_to_tablet.py:102-107, 363-372 | Removed after a whole-folder push | Same as above | **Yes** |
| _classify_tablet `IGNORE_FILES = {.aio_series.json, .mangafire_hid, details.json, .nomedia}` + dotfiles | CM/_classify_tablet.py:28, 50 | Kept out of chapter counts | Reader-profile sidecar whitelist | **Yes** |
| _compare_tablet_vs_pc `IGNORE_FILES = {.aio_series.json, .mangafire_hid, .nomedia}` + dotfiles | CM/_compare_tablet_vs_pc.py:36, 97 | Same | Same | **Yes** |
| _delta_findings `SKIP_BASENAMES = {.aio_series.json, .mangafire_hid, .nomedia, details.json, cover.jpg}` + dotfiles; only `.pdf`/`.cbz` counted | CM/_delta_findings.py:35-37, 134-138 | Kept out of the diff | Same | **Yes** |
| AIO `METADATA_FILES = {.aio_series.json, .series_hid, .mangafire_hid, .DS_Store}`; `SINGLETON_FILES = {cover.jpg, cover.jpeg, cover.png, cover.webp, details.json, .cover.jpg, download_params.json}` | AIO/UI-source/electron/series-merge.js:59-68 (untracked file) | AIO's own never-move vs one-per-folder split | Default source for the lists above | — |
| Other AIO non-chapter files: `<base> (missed chapters).json`; `.cover.<ext>` caches; `download_params.json`. HID marker names can also be configured via `aio_config.json` `supported_hid_markers` | AIO/aio-dl.py:13992; AIO/library_state.py:197-206, 11; AIO/aio_config.py:55-64. On this machine: two "(missed chapters).json" files and one `.cover.webp` (verification) | Must never be sent | [Derived] | **Yes** |
| Mirrored set: `*.cbz` (case-insensitive) + exactly `cover.jpg` + exactly `details.json`; never dotfiles | CM/sync_to_tablet.py:99-102, 168-173 | Defines what is pushed AND, through the delete set, what gets deleted | [T-Dev] reader profile: "Chapter formats to send" + "Series files to send". Komikku preset: cbz (Komikku also reads zip/cbr/rar/epub, SPEC:63) + cover.jpg + details.json. Perfect Viewer preset: pdf + cbz | **Default from profile** |
| Chapter-extension sets, every copy: compare_manga pdf/cbz (CM/compare_manga.py:398-400, 1035, 1069); push_all and verify_push depth-1 pdf/cbz (CM/push_all_to_tablet.py:521-541; CM/verify_push.py:111-114, 130-131); _classify_tablet `{pdf, cbz, zip, cbr, rar, epub}` (CM/_classify_tablet.py:27); _compare_tablet_vs_pc the same six (:101); _delta_findings `.pdf`/`.cbz` (:134-138); AIO `OUTPUT_EXTENSIONS` pdf/epub/cbz (AIO/UI-source/electron/library.js:45), `PAYLOAD_EXTS` (series-merge.js:54), `SUPPORTED_BOOK_EXTS` (AIO/library_state.py:13), `OUTPUT_EXTS` (AIO/UI-source/electron/main.js:1261) | as listed | What counts as a chapter | [T-Dev] profile | **Default from profile** |
| Cover rule: exact, case-sensitive `cover.jpg` in the scripts, vs AIO accepting cover.jpg/png/webp/jpeg. Komikku documents `cover.jpg`; `cover.<ext>` is best-effort | CM/_classify_tablet.py:66; CM/_compare_tablet_vs_pc.py:95; CM/sync_to_tablet.py:101; AIO/UI-source/electron/library.js:735-741; SPEC:89-90 | Cover detection | [T-Dev] profile "Cover filename" | **Default from profile** |

### 3.4 Per-series exceptions and overrides (IN FULL)

| Exception | Where | UI home | Auto-detect? |
|---|---|---|---|
| JoJo Part 4 (`JoJo's_Bizarre_Adventure_Part_4_Diamond_is_Unbreakable`): force fresh download. Tablet has 546 mangafire-scan PDFs up to Ch 439.1 vs PC `JoJo no Kimyou na Bouken Part 4 - Diamond wa Kudakenai` with 174 published chapters. Later reversed by the Part 4 alias | CM/REDOWNLOAD_FOR_KOMIKKU.md:60-67, 209-214; CM/push_all_to_tablet.py:84-85 | [T-Ovr] "Force re-download (source, numbering, target name)" | **No** (the app can pre-flag numbering mismatch) |
| JoJo Part 6 (`JoJo's Bizarre Adventure Part 6 Stone Ocean`): force fresh download. 494 PDFs up to Ch 752.1 vs PC `… (hid=t4U07)` with 158 | CM/REDOWNLOAD_FOR_KOMIKKU.md:67, 209-214 | Same | **No** |
| JoJo Part 5: keep the push despite a numbering mismatch, "per user direction" | CM/DELTA_FINDINGS.md:64-66, 87-95 | [T-Ovr] "Accept PC numbering / accept loss" | **No** |
| Is the Order a Rabbit: "treat like JoJo Part 5" | CM/DELTA_FINDINGS.md:124-132; CM/REDOWNLOAD_FOR_KOMIKKU.md:192 | Same | **No** |
| Dragon Ball: excluded because the PC copy was mid-re-download ("in flux") | CM/_delta_findings.py:105-106; CM/REDOWNLOAD_FOR_KOMIKKU.md:207-219 | [T-Ovr] "Exclude from sync" (temporary) | **Partly.** Could auto-skip while an AIO download for the series is running (precedent: AIO/UI-source/electron/series-merge.js:415-426) |
| Eleceed: skip, already compliant | CM/_compare_tablet_vs_pc.py:121-122; CM/REDOWNLOAD_FOR_KOMIKKU.md:148-150 | Computed state, not an override | **Yes** |
| Pandora Hearts: PC re-downloaded, delta went from −170 to 0 | CM/REDOWNLOAD_FOR_KOMIKKU.md:207-219 | Computed | **Yes** |
| Content-loss series ("refresh the PC copy first"): Horimiya (device-only Ch 128-201, 74 chapters); Sentenced to Be a Hero (Ch 11, 12, 13); Fly Me to the Moon (Ch 168, 215) | CM/DELTA_FINDINGS.md:387-400 | Plan warning + [T-Ovr] "Accept loss" | **Yes (detect)**; the decision is manual |
| Shortfall ≤ −50 (tablet / PC / delta): JoJo 5 324/155/−169; Horimiya 254/142/−112; Fly Me to the Moon 460/370/−90; Is the Order a Rabbit 184/97/−87; One-Punch Man 299/245/−54; SPY×FAMILY 204/150/−54 | CM/REDOWNLOAD_FOR_KOMIKKU.md:162-169 | Plan warning with a "Check for updates" link (AIO update check) | **Yes** |
| A.1 fresh-download list (not on the PC in May; tablet PDF counts): DARLING in the FRANXX 8; Daughter of the Spirit King 170; Every Day Is a Holiday (Colored) 310; Fullmetal Alchemist 311; Ghost Sore wa rei no Shiwaza desu 7; Let's do it already 9; Like a Butterfly 12; My Dress-Up Darling 14; No More Love With the Girls 143; SHELTER 210; Slow Life In Another World (I Wish!) 8; The Reincarnation Magician of the Inferior Eyes 16; Zom 100 Bucket List of the Dead 18. Several are `Vol N.pdf` volumes, and 4 later matched via aliases | CM/REDOWNLOAD_FOR_KOMIKKU.md:44-58 | "Device only" section → "Find source" | **Yes** (computed) |
| Seed overrides: (1) SHELTER pinned to `https://www.webtoons.com/en/canvas/shelter/list?title_no=194264` (linewebtoon, `manual_override`, reason text); (2) That Time I Got Reincarnated as a Slime: promote the first source whose URL contains `tensei-shitara-slime-datta-kenn` to rank 0; (3) Eleceed: promote the first source with site `linewebtoon` and `webtoons.com` in the URL; explicit NON-override for Solo Leveling | CM/fixup_seed_links.py:34-63, 65-84, 86-108 | [T-Ovr] "Pinned source URL" / "Preferred source (site or URL contains…)" | **No.** The Eleceed case is now handled by AIO's is_official tiebreak (AIO/sites/search_orchestrator.py:6185-6201; see §8) |
| Preserve: `SHELTER` asserted to survive (obsolete: SHELTER is now a PC series, `D:\AIO\manga\SHELTER`, with 218 journal keys). `TABLET_PRESERVE` is promised in a docstring but never defined. Implicit preserve = device folders never journaled and with no PC target | CM/verify_push.py:12-14, 128-135; CM/push_all_to_tablet.py:13-15; CM/sync_to_tablet.py:629-634 | [T-Dev] "Never touch these device folders" (explicit list, seeded from the plan's implicit "preserved" list) | **Partly** |

### 3.5 Thresholds, timeouts and parallelism

| Value | Where | UI home | Auto-detect? |
|---|---|---|---|
| Chapter-loss warning: delta ≤ −20 | CM/push_all_to_tablet.py:627-628, 633-639 | [S-TS] "Warn when the device has ≥ N chapters the PC lacks" (default 20) | No |
| Shortfall "refresh PC first": delta ≤ −50 | CM/REDOWNLOAD_FOR_KOMIKKU.md:154-160 | [S-TS] second threshold, or merged with the one above | No |
| Size mismatch 30 %. Fixed rules: truncated stub = tablet < 1024 B while PC > 100,000 B; error if tablet is smaller by > 2× threshold; ≥ 3 warns consolidated per series | CM/compare_manga.py:60, 957-961, 982-1006 | [S-TS-Adv] % only; rules [Internal] | — |
| Delta heuristics: [−50, −1] ≈ sub-chapter splits; ≤ −85 ≈ different numbering system; positive ≈ PC re-downloaded | CM/DELTA_FINDINGS.md:14-29 | [Internal] numbering-mismatch flag; threshold in [S-TS-Adv] | — |
| Tablet-listing cache TTL 24 h; dashboard memo 120 s | CM/compare_manga.py:59; CM/manga_manager.py:61-63 | [Internal] (always relist before plan/apply) | — |
| Error budget: 3 consecutive failures | CM/transfer_runner.py:91, 225-232 | [S-TS-Adv] (default 3), plus immediate abort on device-loss signals | — |
| Hashing threads 8 | CM/sync_to_tablet.py:1025-1026 | [S-TS-Adv] | **Yes** (CPU count, capped) |
| Push batch caps: 50 files, 12,000 source-path chars (Windows 32 KB command line) | CM/sync_to_tablet.py:112-117 | [Internal] | — |
| Push timeout `max(180 s, bytes / 4 MB/s + 120 s)` (assumes a USB-2 floor) | CM/sync_to_tablet.py:436-437, 456 | [Internal] (optionally [S-TS-Adv] "assumed minimum USB speed") | — |
| Other adb timeouts. **sync:** tablet sha256 per folder 7200 s (:373); rm -f 120 s (:401); prune rm -rf 600 s (:408). **push_all:** folder push 14400 s (:393); rm -rf 300 (:279); mkdir 30 (:290); mv 60 (:302); exists 30 (:314); list 30 (:267); sidecars 30 (:372); adb_shell default 60 (:234). **compare_manga:** adb devices 15 (:464); find 180 (:539); stat fallback 600 (:564). **manga_ops:** mkdir 30 (:120); rm -f 30 (:280); kill grace 5 s (:259); `push_chapter` has NO timeout (:174-179) | as listed | [Internal]. Must actually bound hangs (§6) | — |
| Hash progress cadence: every 200 files | CM/sync_to_tablet.py:308 | [Internal] | — |
| Runner tuning: throttle 0.2 s; queue 4096; heartbeat 15 s; blocking emit 30 s; keep last 3 errors | CM/transfer_runner.py:64, 77, 130, 161-178, 213-215 | [Internal] | — |
| Concurrency: pushes strictly serial; one transfer batch globally | CM/transfer_runner.py:97-104; CM/sync_to_tablet.py:851-856 | [Internal] | — |

### 3.6 Filename patterns and normalization

- **compare_manga CHAPTER_PATTERNS**, first match wins, all IGNORECASE (CM/compare_manga.py:71-103):
  ```
  A ^(?P<prefix>.+?)\s+Ch\s+(?P<label>\d+(?:[.~]\d+)?)\s*\.(?P<ext>pdf|cbz)$
  B ^(?P<prefix>.+?)_(?P<site>[a-z]+)_Ch_(?P<label>\d+(?:[.~]\d+)?)\s*\.(?P<ext>pdf|cbz)$
  C ^Chap\s+(?P<label>\d+(?:[.~]\d+)?)\b.*\.(?P<ext>pdf|cbz)$
  D ^Chapter\s+(?P<label>\d+(?:[.~]\d+)?)\s*\.(?P<ext>pdf|cbz)$
  E ^#(?P<label>\d+)\s*-.*\.(?P<ext>pdf|cbz)$
  F ^Vol\s+(?P<label>\d+)\s*\.(?P<ext>pdf|cbz)$
  ```
  None of these matches the Komikku form `Ch.NNN - Title.cbz`.
- **_delta_findings regexes**, tried in this order: search() for the first two, match() for the rest; then `~`→`.` (CM/_delta_findings.py:112-131):
  ```
  _(?:mangafire|comix|comickfun|mangadex|asura|asurascans)_Ch_(\d+(?:[.~]\d+)?)\s*\.(?:pdf|cbz)$
   Ch\s+(\d+(?:[.~]\d+)?)\s*\.(?:pdf|cbz)$
  ^Ch\.0*(\d+(?:\.\d+)?)\s*(?:-.*)?\.(?:pdf|cbz)$
  ^Chap(?:ter)?\s+(\d+(?:\.\d+)?)\b
  ^#(\d+(?:\.\d+)?)\s*-
  ^Vol\s+(\d+(?:\.\d+)?)\s*\.(?:pdf|cbz)$
  ```
- **AIO's own parsers:**
  - `KOMIKKU_CH_RE = /^(?:Vol\.\S+\s+)?Ch\.(\d+(?:\.\d+)?[a-z]?)/i` (AIO/UI-source/electron/library.js:148).
  - Legacy `<Series> Ch <label>` split on the last ` Ch `, with `A-B` ranges and `~` decimals (:159-217).
  - Image dirs `/^(?:Chapter_|ch_)(-?\d+(?:\.\d+)?)/i` (:292-295).
  - The Python `CHAPTER_FILE_RE` / `RAW_IMAGE_DIR_RE` miss Komikku names (AIO/library_state.py:15-19).
- **hid suffix:** `^(.+?)\s*\(hid=(.*?)\)\s*$` (CM/compare_manga.py:107; duplicate at CM/_compare_tablet_vs_pc.py:62). Prefer AIO's own regex (AIO/aio-dl.py:949, 10127).
- **Name normalization tables:**
  - apostrophes `' ’ ‘` are deleted;
  - `" “ ” , . ! ? : ; ( ) [ ] - – — /` map to space;
  - plus NFKC, casefold, `_`→space, whitespace collapse (CM/compare_manga.py:113-116, 292-307).
- **Label canonicalization:** `~`→`.`; integer leading zeros stripped; `N.0`→`N`; decimals kept verbatim, so 315.01 ≠ 315.1 (CM/compare_manga.py:258-277). AIO equivalents: `chapterLabel` (AIO/UI-source/electron/series-merge.js:76-79) and `_normalizeChapterToken` (library.js:231-241).
- **Sort key:** full chapters before partials, 8 < 8~5 < 8.5 < 9 (CM/compare_manga.py:232-255). It is a port of AIO/aio-dl.py:7065-7087.
- **Device naming conventions seen.**
  - In the May dump:
    - underscored `<Series>_mangafire_Ch_N` (3,717 files) and `_comix_Ch_` (28), across 15 series;
    - spaced `<Series> Ch N~M` in 31 series, 750 files containing `~`;
    - `Chap N title` in 8 series;
    - `#N - title` (Tower of God, SHELTER);
    - `Vol N` in 12 series;
    - unparseable `Vol N <title>` (My Dress-Up Darling, 8 files);
    - Komikku `Ch.001 - Episode 1.cbz` (Eleceed only).
    - Source: CM/tablet_files.txt, per the analysis verification.
  - Today 19,574 of 20,007 device paths are `Ch.NNN - …` (CM/.tablet_cache.json, per the dashboard verification).
- **UI home:** [S-TS-Adv] "Device filename patterns": presets per reader profile (AIO Komikku, AIO legacy, mangafire underscored, Chap/Chapter/#N/Vol) plus user-added regexes, and a per-series "Unparsed files" viewer. **Auto:** AIO's own outputs are auto-recognized; legacy device formats need presets.

### 3.7 Folder-naming policy

- **sync:** alias (when KEEP is on) → strip hid → sanitize (CM/sync_to_tablet.py:219-228).
- **push_all:** aliased → `matched[0]`, the alphabetically first matched tablet folder; otherwise hid-stripped PC name (CM/push_all_to_tablet.py:460-471).
- **dashboard:** a new folder = sanitize(canonical PC folder INCLUDING the hid suffix, no alias) (CM/manga_manager.py:557-566).
- **Sanitizers:**
  - CompareManga: removes `/ \ : * ? " < > |` and control chars, trims ` .`, NFKC (CM/manga_ops.py:44, 70-83).
  - AIO's folder sanitizer: removes the same set, collapses whitespace, falls back to `comic` (AIO/aio-dl.py:496-503).
  - Komikku, when it writes: replaces those chars with `_`; filenames capped at 240 bytes (SPEC:47, 49).
- **UI home:** [T-Dev] "Device folder names" default (PC folder without hid | series title from `.aio_series.json` | keep existing device name), plus the [T-Ovr] per-series name. **Auto:** the default is computed; overrides are manual.

### 3.8 Batch-search configuration

- `AIO_DIR = C:\Users\legoc\OneDrive\Belgeler\AIO-Webtoon-Downloader`. This path is dead (CM/batch_search.py:35, 40-42).
- `PROBE_PHASE_DEADLINE_S` is monkey-patched to 45.0 (CM/batch_search.py:56-64). The module value is 240.0 (AIO/sites/search_orchestrator.py:284) and has no CLI flag. The env overrides that do exist are `AIO_SEARCH_SLOW_PROBE_S` (search_orchestrator.py:348) and `AIO_PROBE_BREADTH_CONCURRENCY` (AIO/sites/base.py:521).
- `search_all` arguments (CM/batch_search.py:211-214, 228-240; AIO/sites/search_orchestrator.py:160, 183):
  - language `en`, parallelism 6, per-site timeout 8.0, min_match 0.55, seeded_only True;
  - `ProbeFailureCache(record_cooldown=None)`, `ImageQualityCache()`;
  - request factory with attempts 2.
- The AIO CLI defaults differ: `--search-timeout` 20.0, parallelism 6, min-match 0.55 (AIO/aio-dl.py:8535-8553).
- Top-5 candidates are kept (:267), although the docstring says top-3 (:18).
- **UI home:** a batch "Find sources" dialog that uses Settings > Search defaults, with per-run overrides. A shorter probe deadline needs a new aio-dl.py flag or env var.

### 3.9 Dashboard / infra constants (NOT user settings)

- `HOST_DEFAULT`/`PORT_DEFAULT`; cover fetch 5 s with UA `CompareManga/1.0`; `COVERS_DIR`; `ANOMALY_KIND_ORDER`; SSE heartbeat 15 s; cover max_age 86400; SVG placeholder; 0.5 s browser-open delay (CM/manga_manager.py:58-81, 650-664, 800, 839, 847, 879-887).
- CDN fonts and htmx (CM/templates/base.html:7-12).
- The old "editorial manga noir" design tokens (CM/static/styles.css:1-49). Do not port these.
- Label and counter literals `111` (CM/_verify_chapters.py:64; CM/_watch_progress.py:32-34).
- Fixed section sort orders (CM/manga_manager.py:202-211). The new tab should offer real sort and filter controls instead.

---

## 4. State and cache files, and what the app needs instead

| File | Schema | Purpose | Writer → Reader | App equivalent needed |
|---|---|---|---|---|
| `CM/.sync_state-<serial>.json` (observed `…-A06B4A372090333.json`: 3.37 MB, updated 2026-07-15T02:37:40, 129 top-level folders, 218 `SHELTER/` keys) | Single-line JSON `{version:1, device, tablet_root, files:{"<tablet folder>/<file>":{size, sha256}}, updated_at_iso}`, keys like `'Tis Time for Torture, Princess/Ch.001 - Torture 1.cbz` | Incremental baseline + resume journal + orphan-vs-preserved discriminator | `save_state` (CM/sync_to_tablet.py:508-513) after every delete batch (:822), push batch (:843), verified folder (:767) and prune (:885) → `load_state` (:491-505). version/device/tablet_root are NOT validated | A journal per (device serial, target root) in AIO userData. Atomic writes, validated on load. Shared by bulk sync AND per-chapter ops (today they are separate: there is no `sync_state` in manga_manager/manga_ops/transfer_runner, per verification). Optional one-time import of this file to skip a slow first verify |
| `CM/.pc_hash_cache.json` (4.5 MB) | `{entries:{"<absolute Windows path>":{size, mtime, sha256}}}` | Lets `--fast` skip re-hashing. Keyed by absolute path, so it misses silently after a root move; never pruned | `hash_pc_files`/`save_pc_cache` (CM/sync_to_tablet.py:244-320, 1069) → `load_pc_cache`, used only with `--fast` | userData hash cache keyed by library-relative path + size + mtime, pruned of deleted files; importable |
| `CM/sync-log-<ts>.json` (7 files, 2026-07-06..07-15) | `{started_at_iso, completed_at_iso, n_ok, n_fail, pushed_files, pushed_bytes, deleted_files, results:[{target, pushed_files, pushed_bytes, deleted_files, duration_sec, ok, error}]}` | Per-run audit, rewritten after each series. No planned totals, no final status; prune not recorded | `_save_log` (CM/sync_to_tablet.py:890-904) → read by humans only | Run history in userData: planned totals, final status (completed / cancelled / failed / device-lost), prune results, retention limit; shown in the tab |
| `CM/transfer-log-<ts>.json`, `full-mirror-log.json`, `canary-log.json` | `{started_at_unix, started_at_iso, completed_at_iso, n_ok, n_fail, results:[{series, target, deleted[], pushed_bytes, pushed_files, duration_sec, ok, error}]}`. `pushed_files` is the PC chapter count, not the files pushed (CM/push_all_to_tablet.py:760-761) | push_all run results | `_save_log` (:784-796) → `verify_push.latest_log`, which globs only `transfer-log-*` (CM/verify_push.py:29-35) | The same run history, if a re-mirror action is kept |
| `CM/.tablet_cache.json` (2.5 MB, 2026-06-15) | `{version:2, device, tablet_root, scanned_at_unix, scan_duration_sec, file_count, dir_count, files:[{p,s,m}], dirs:[…]}` (CM/compare_manga.py:602-625). The current file: device `3CEF42502E91537`, 20,007 files, 112 dirs | Device listing cache, 24 h TTL. push_all and verify_push force a fresh scan | `save_cache` → `load_cache` (:571-599); the dashboard memo checks its mtime (CM/manga_manager.py:160-166) | A short-lived per-device listing in main-process memory. Always relisted before plan/apply and patched with completed ops afterwards |
| `report-<ts>.txt/.json`; `CM/_verify_report.txt/.json`, `_verify_console.txt`, `_verify_stderr.txt` | Text `# Compare Manga Report v1`. JSON `{report_version:1, generated_at_iso, pc_root, tablet_root, device, cache_status, tablet_file_count_total, totals{pc_folders, pc_logical_series, tablet_folders, matched, pc_only, tablet_only, pc_chapter_files, pc_total_bytes, tablet_chapter_files, tablet_total_bytes, anomalies}, tablet_missing_series[], pc_missing_series[], shared_series[], anomalies[{kind, severity, series, detail, payload}]}` (CM/compare_manga.py:1247-1248, 1313-1347) | Comparator output | `render_*` → humans | Optional export (JSON/Markdown) from the Compare view |
| transfer_runner in-memory `_TRANSFERS` | `{id(16-hex): TransferState{ops[TransferOp{op, series_key, label, pc_path, tablet_path, bytes, display}], status queued\|running\|done\|cancelled\|aborted_errors, current_index, succeeded, failed, cancel_event, _q}}`, never evicted (CM/transfer_runner.py:18-19, 85-117) | Job registry + event queue | `start_transfer` → `iter_events` / SSE | Main-process job record with runId superseding (AIO/UI-source/electron/update-check-record.js:83-161) + a renderer hook mounted in useDownloader (AIO/UI-source/src/hooks/useUpdateCheck.js:190-233; useDownloader.js:258). Persist a last-run summary |
| `CM/static/covers/<sha1(norm_key)[:12]>.jpg` (9 files) | Image bytes; never invalidated; always served as image/jpeg | Dashboard covers | `_fetch_cover` (CM/manga_manager.py:607-647) → `/api/cover` (:835-848) | Reuse AIO `cover.jpg` + thumb-cache (AIO/UI-source/electron/library.js:735, 827-911; main.js:969). Device-side covers would need pulling into a userData cache, because `localfile://` only serves local paths (main.js:109-117, 1891-1899) |
| `CM/seed_links.json` (+ `.txt`, `.md`, `_full.md`). **ABSENT now** | `{folder:{query, elapsed_sec, candidates:[top-5 SeriesCandidate.to_json()], error?, manual_override?, override_reason?}}` | Best source per tablet series | batch_search (CM/batch_search.py:174-178, 264-268) and fixup (CM/fixup_seed_links.py:110-111) → render | Persisted "found sources" + per-series pinned/preferred source in app state |
| `CM/tablet_files.txt`, `tablet_classify.json`, `tablet_vs_pc.json`, `delta_findings.json`, `_pc_sizes.json` (UTF-8 BOM), `_pc_repack.json` | Snapshot schemas (analysis census). `tablet_vs_pc.json` is stale: still "push" for JoJo 4 and 6 (:495-512, 571-588) | One-off forensics | Scripts → humans | None as files; the tab computes compatibility and diff live. Any reader of `_pc_sizes.json` needs utf-8-sig |
| Shell traces: `push_run.log`, `full_mirror_stdout/stderr.log`, `canary_stderr.log`, `push_plan_stderr.log`, `synclogs07.md` | Lines like `[ i/N] <target>`, `!! ERROR: …`, `… a/b GB (p% of run)`, `Done. X ok, Y failed` (CM/push_all_to_tablet.py:697-699, 766, 776-780; CM/sync_to_tablet.py:800-803, 846-849, 861, 869-872) | Live progress, forensics | stderr → `_watch_progress` | Logs-tab entries (AIO/UI-source/electron/log-filter.js:84-86, 113-133) + structured progress events |
| `CM/sync-log-20260715-021752.json.tmp` (0 bytes) | — | Left by a kill mid-rewrite | — | Sweep stale `*.tmp` in the app's state dir at startup |
| Device-side AIO sidecars in the May dump: `.aio_series.json` in 15 series, `.mangafire_hid` in 22 | AIO identity JSON / hid stub | Identity on the device | AIO → stripped by sync (CM/sync_to_tablet.py:807-813) | Optionally read before stripping, to adopt folders by identity |
| AIO state the tab touches | `settings.json` (flat keys; AIO/UI-source/electron/history.js:202-231); `download_queue.json` (separate-file precedent, :234-260); `<Series>/.aio_series.json` (present in 132 of 134 folders; `chapters_ignored` in 11); `.series_hid`/`.mangafire_hid` (main.js:235-245); `cover.jpg`/`details.json` (Komikku mode); `aio_config.json` `output_dir` (main.js:220-233) | — | — | Tablet profiles, aliases and overrides need a home; see §7.4 and §9 |

---

## 5. Destructive operations and their existing safety rails

| # | Operation | Source | Existing rails | Gaps observed | Rails the port must keep, and gaps it must close |
|---|---|---|---|---|---|
| 1 | Sync chapter deletes: one `adb shell rm -f …` per series | CM/sync_to_tablet.py:394-403, 598-612, 815-822 | Plan preview; `--apply` + typed yes/y; `_validate_tablet_path` + `shlex.quote`; files only; depth-1 only; only in folders that are current PC targets; journal flushed | (a) Deletes every non-mirrored type in managed folders (pdf/epub/user files). (b) Runs BEFORE pushes: an interrupted run left 131 deleted / 1 pushed (CM/sync-log-20260707-013414.json). (c) No mass-delete guard: 434 deletes planned (CM/synclogs07.md:1648). (d) One unbounded command line → WinError 206 risk on mass renames (vs the 12,000-char cap for pushes, :112-117). (e) No rename detection: Nano Machine had 320 pushed / 318 deleted (CM/sync-log-20260709-015153.json) | Keep all rails. Restrict deletes to the profile's mirrored types. Delete only after the replacement has landed (or only files without a replacement). Count/size threshold with explicit confirmation. Chunk deletes. Hash-matched renames become a device-side `mv` |
| 2 | Sync sidecar cleanup `rm -f` | CM/sync_to_tablet.py:807-813 | Fixed names; validated; errors swallowed | — | Keep; derive names from AIO constants |
| 3 | Sync prune: `rm -rf` of orphaned folders | CM/sync_to_tablet.py:406-410, 876-887, 1017-1019, 1100, 1107, 1117-1119 | Needs BOTH `--apply` and `--prune`; only journaled folders whose PC target is gone; confirm line says "PRUNE N folder(s)"; validated; side-loaded folders are never journaled, so never pruned (:617-634) | Ignores `--only`/`--skip`. Failures are swallowed, don't affect the exit code, and aren't logged. A PC-side rename or merge turns the old device folder into an orphan. Journal is keyed by serial only, so after a root change orphans resolve under the new root (:487-505) | Per-folder list in the confirm dialog; scope to the current selection; log the results; identity-based rename detection; key the journal by (serial, root) and validate it on load |
| 4 | Sync `--verify` journal rewrite | CM/sync_to_tablet.py:734-768 | A folder's entries are cleared and rewritten only after its hash call returns; flushed per folder; only managed folders | The remote command ends in `2>/dev/null` and rc/stderr are ignored (:369-373). A USB drop or unauthorized state returns `{}`, and every journal entry for that folder is popped (:763-767) | Treat non-zero rc, device loss, or "empty while the listing shows files" as a failure and keep the entries |
| 5 | push_all: `rm -rf` matched device folders, then push | CM/push_all_to_tablet.py:274-282, 702-707 | Plan lists replacements, aliases, renames, new and preserved folders; "CHAPTER LOSSES ≥ 20" (:627-639); alias errors abort (:902-904); confirm text "DELETE the matched tablet folders" (:910-918); validator (:238-255) | Not transactional; no backup; tablet-only chapters destroyed (−372 on JoJo 4, CM/push_run.log:107) | Don't port this as a default. If a "full re-mirror" maintenance action exists: push to a temp name, then swap, with per-series loss warnings |
| 6 | push_all pre-clean: `rm -rf` of target + stale landings | CM/push_all_to_tablet.py:709-721 | Skips matched names and paths equal to the target | — | Only relevant if row 5 survives |
| 7 | push_all device `mv` (landed → target) | CM/push_all_to_tablet.py:296-305, 740-755 | Landed name is computed; listing fallback with a byte-length pin (:319-360); validated | Failed on SPY×FAMILY before the model existed (CM/transfer-log-20260524-015607.json:735-744) | Any device rename must warn that reader progress and library entries are keyed on names (SPEC:230-231) |
| 8 | push_all sidecar `rm -f` | CM/push_all_to_tablet.py:363-372, 757-758 | Fixed names; best-effort | — | Fold into row 2 |
| 9 | Dashboard single-file delete (`rm -f`) | CM/manga_ops.py:267-287; CM/transfer_runner.py:280-284; CM/manga_manager.py:514-526, 579-599 | Validator; files only; depth-1; per-chapter checkboxes only for tablet-only labels (templates/partials/_chapter_table.html:22-26); confirm modal lists each file with its size; server re-resolves on apply; Cancel; abort after 3 failures; one batch at a time | No typed or second confirmation. The server doesn't enforce "tablet-only" for crafted requests. With a stale listing a repeat delete "succeeds", because `rm -f` of a missing file exits 0 | Structured op ids end-to-end; server-side checks; relist after apply |
| 10 | Dashboard whole-series delete ("Delete all" / "Delete extras") | templates/partials/_series_row.html:2-8; CM/manga_manager.py:539-550 | Preview modal | Expands to EVERY depth-1 device file: chapters that are also on the PC, plus `cover.jpg`/`details.json` (111 of each on the device, per verification). Alias pairs appear as "Only on tablet" with "Delete all" offered | Scope to device-only chapters; always protect profile sidecars; apply aliases before classifying |
| 11 | Folder delete | CM/manga_ops.py:290-302 | Deliberately `NotImplementedError` | Emptied folders stay on the device | If ever enabled: a stronger confirmation |
| 12 | Push overwrite | CM/manga_ops.py:130-249; CM/manga_manager.py:503-513, 530-538 | Server skips labels already on the device | Defeated by a stale listing: a re-push silently overwrites | Always relist before apply |
| 13 | Planned migration ops: "delete device folder then push" (51 series) and "download then replace" (15 series, incl. JoJo 4/6 discarding 546 and 494 PDFs) | CM/REDOWNLOAD_FOR_KOMIKKU.md:11-15, 38-42, 66-67, 71-75 | Manual only: delta column, shortfall table, content-loss list, "spot-check one per series" (CM/DELTA_FINDINGS.md:55-56, 387-400) | No automated guard | Automated loss detection + a per-series decision before any replace |
| 14 | Local writes | Atomic tmp + `os.replace`: journal, cache, logs, seed_links.json (CM/sync_to_tablet.py:255-259, 508-513, 901-904; CM/compare_manga.py:621-625; CM/batch_search.py:174-178). NON-atomic: compare_manga reports (:1506-1518), fixup's in-place rewrite (CM/fixup_seed_links.py:110-111), `.ps1` Out-File (CM/_scan_pc_repack.ps1:32; CM/_scan_pc_sizes.ps1:21) | — | — | Use AIO's atomic `_saveJson` pattern (AIO/UI-source/electron/history.js:102-137) |
| 15 | AIO ops that interact with sync | `delete-series` rm -rf with no library-root containment check (AIO/UI-source/electron/main.js:1059-1068). `metadata:update` rewrites ComicInfo inside archives, no confirm on "Apply to all" (main.js:910-915; LibraryTab.jsx:1144-1166, 1200-1203). `--refresh-library-metadata` / `--refresh-rewrite-cbz` rewrite details/cover/.aio_series and optionally every CBZ (AIO/aio-dl.py:9372-9384, 8040-8067). The June repack rewrote every CBZ (CM/_pc_repack.json) | — | Byte changes make a hash sync re-push everything affected | The plan must show byte totals so a mass re-push is visible before apply |

**Cross-cutting rails to keep:**
- Plan first; never `window.confirm` (AIO/UI-source/src/components/ResumeBar.jsx:43-44; LibraryTab.jsx:1225).
- Two-click confirms with auto-cancel (SettingsTab.jsx:952-962; LibraryTab.jsx:1253-1274, 1385-1400).
- Plan-then-confirm dialogs with typed error codes (LibraryTab.jsx:487-744, 749-764).
- Refuse while a related download runs (AIO/UI-source/electron/series-merge.js:415-426).
- Register device transfers with the quit gate (main.js:555-569, 1862-1873, 1953-1961).
- Port the path validator with unit tests (CM/manga_ops.py:86-107, 333-354).

---

## 6. Observed failure modes and lessons

### 6.1 adb and transport

| Failure | Evidence | Lesson |
|---|---|---|
| adb 36.x on Windows truncates a non-ASCII DESTINATION FOLDER leaf (first char-count bytes of the UTF-8), so the rename failed and SPY×FAMILY was lost | CM/transfer-log-20260524-015607.json:735-744; CM/push_run.log:570-575; model at CM/push_all_to_tablet.py:319-360 | Never let adb derive a non-ASCII leaf. Pre-create folders and push to explicit remote file paths |
| Same truncation at FILE level for ASCII names inside non-ASCII folders: `--verify` then planned 434 re-pushes + 434 deletes over 3 series | CM/synclogs07.md:1643-1656; fix at CM/sync_to_tablet.py:824-834, 983-989; repair run CM/sync-log-20260707-013548.json (433 pushed / 303 deleted) | Route by the WHOLE source path. Verify after apply. Test non-ASCII folders and files |
| USB drop: 9 ok / 107 failed, with 106 `device … not found` errors; the loop never aborts | CM/sync-log-20260706-221724.json:4-5, 92-98; CM/sync_to_tablet.py:858-861 | Detect device loss (rc plus `not found`/`no devices`/`offline`/`EOF`), abort, offer "reconnect and resume". The resume was cheap: 107 ok / 18,231 files / 133.45 GB in 71.4 min |
| adb 36.0.2 rejects `push --progress` | CM/manga_ops.py:157-162; CM/_screens/dash-05-progress.png | Parse the default `[ NN%]` lines; record the adb version. Unverified risk: whether adb prints `NN%` when stdout is a pipe (dashboard verification note) |
| The `-printf` → `stat` fallback can never trigger: both finds end in `2>/dev/null`, so detection at :543 never sees the error. A device without `-printf` yields folders with zero files → full re-push and journal-only deletes | CM/compare_manga.py:530-534, 543-551, 554-568; consumed at CM/sync_to_tablet.py:339-357 | Feature-detect the device shell explicitly and check rc |
| toybox `find` lacks `-printf %h` | CM/_verify_chapters.py:37-38 | Derive the folder from the full path |
| Pushes are not really bounded. The stream loop checks the deadline only between blocking `read(1024)` calls; `push_chapter` has no timeout and checks cancel only after a read returns; _verify_chapters has no timeouts | CM/push_all_to_tablet.py:197-205; CM/sync_to_tablet.py:438, 457; CM/manga_ops.py:174-198, 225-227; CM/_verify_chapters.py:24-25 | Use a no-output watchdog. Cancel must kill the process tree |
| Unbounded `rm -f` command line | CM/sync_to_tablet.py:394-403, 816-818 | Chunk deletes like pushes |
| `resolve_device` silently drops `unauthorized` and `offline` devices | CM/compare_manga.py:468-474, 481-486; AIO/android/TESTING.md:41-43 | Show each device's state ("accept the USB-debugging prompt") |
| Resume granularity is a batch: files that adb wrote inside a failed batch are unjournaled and re-pushed | CM/sync_to_tablet.py:851-853, 438-440; Bleach tail at CM/sync-log-20260706-221724.json:92-98 | Parse per-file results, or shrink batches after a failure |
| The device changed (3CEF… → A06B…); a new device needs adopting | CM/push_run.log:2; CM/synclogs07.md:1629; CM/sync_to_tablet.py:722-726 | Per-device profiles; prompt "verify / adopt" for an unseen device |
| Two adb installs exist | read-only `ls` of both paths; AIO/android/TESTING.md:37 | Auto-detect order plus an override |
| Performance baseline: ~25-34 MB/s per file; 104.7 min for a 111-series re-mirror; 71.4 min for 133.5 GB; 10.3 GB in ~5.7 min; non-ASCII singles 130-154 files in 40-45 s; PC re-hash of 152.7 GB at ~6.1 GB/s | CM/full_mirror_stderr.log:553; CM/synclogs07.md:1626, 1632-1633; CM/sync-log-20260715-022050.json:2-7; CM/sync-log-20260707-013548.json | USB is the bottleneck: serial pushes are fine; show byte-based progress and ETA. A full re-hash is cheap only on NVMe |
| The dashboard does 2 adb round trips per chapter (1,197 mkdirs for One Piece) | CM/transfer_runner.py:266-279 | Batch like sync does |

### 6.2 Sync engine correctness and state

| Failure | Evidence | Lesson |
|---|---|---|
| `--verify` silently empties journal entries on a device drop | CM/sync_to_tablet.py:369-373, 758-767 | Check rc and device state |
| Interrupted run logged `ok:false, error:null` after deleting 131 files and pushing 1 (KeyboardInterrupt isn't caught; `finally` still writes the log) | CM/sync-log-20260707-013414.json; CM/sync_to_tablet.py:858-865 | Model cancellation explicitly; cancel between batches; push before delete |
| 0-byte stray `.tmp` | directory listing; CM/sync_to_tablet.py:901-904 | Keep atomic writes; sweep `.tmp` files |
| Reading the JSON log mid-run can collide with `os.replace` | CM/_watch_progress.py:4-6 | Progress via IPC events only |
| PC hashing has no per-file error handling: one vanished or locked file kills the run before the cache is saved | CM/sync_to_tablet.py:296-307, 1065-1069 | Per-file errors; save partial work |
| Emptying a PC folder never clears its device folder; PDF/EPUB-only PC folders are "empty" and never synced | CM/sync_to_tablet.py:558-560, 625, 168-173 | Explicit handling for empty and unsupported-type series |
| `--prune` ignores `--only` | CM/sync_to_tablet.py:625-627, 1100, 1117-1119 | Scope prune to the selection |
| "Plan" is not side-effect free: it rewrites the PC cache, and `--verify` rewrites the journal | CM/sync_to_tablet.py:1069, 1080-1086, 767 | Preview must not mutate state (or must say so) |
| Prune is not recorded in the run log | CM/sync_to_tablet.py:876-887, 862-865 | Log every destructive action |
| The run log has no planned totals or final marker, so a killed run looks like a small clean one | CM/sync_to_tablet.py:890-904; CM/sync-log-20260715-021752.json + its 0-byte `.tmp` | Record plan, status and end reason |
| Journal keyed by serial only; `tablet_root` unchecked | CM/sync_to_tablet.py:487-505 | Key by (serial, root) |
| push_all mirrors EVERYTHING recursively (133 files for 129 chapters), while sync mirrors depth-1 cbz/cover/details only; nested content (AIO image-folder chapters) is invisible to sync | CM/push_all_to_tablet.py:375-396; CM/canary_stderr.log:8, 14; CM/sync_to_tablet.py:176-216 | Define the mirrored set explicitly per profile |
| A losing hid variant's unique chapters are never mirrored | CM/push_all_to_tablet.py:456, 727-729; CM/compare_manga.py:850-856; CM/sync_to_tablet.py:549-573 | Warn, and point to AIO's merge (series-merge.js) |
| PC-side chapter rename causes a full delete + re-push of identical bytes | CM/sync-log-20260709-015153.json:65-70 | Hash-matched rename → device `mv` |
| Library-wide repack rewrote every CBZ on 2026-06-14 (110 of 111 series) | CM/_pc_repack.json:6-7; CM/_scan_pc_repack.ps1:1-4 | Content hashing; metadata-only sync mode |
| Mixed GB units in one run (decimal in progress, binary in the summary) | CM/synclogs07.md:1632-1633; CM/sync_to_tablet.py:312-316 vs 644-650 | Reuse one app-wide byte formatter |
| Selective per-chapter ops never update the sync journal | no `sync_state` in manga_manager/manga_ops/transfer_runner (verification) | One journal for all device writes |
| transfer_runner back-pressure: with no SSE consumer the queue fills and every `file_start`/`file_done` blocks up to 30 s | CM/transfer_runner.py:64, 136-137, 161-178, 203-216 | Main-process record; drop-oldest for progress events |
| A stale listing defeats "never overwrite" and fakes delete success | CM/manga_manager.py:155-170, 509-512; CM/compare_manga.py:639-645; CM/manga_ops.py:274-287; CM/static/app.js:170-181 | Relist or patch after every batch |

### 6.3 Naming and matching

| Failure | Evidence | Lesson |
|---|---|---|
| Aliases keyed by PC folder name break when AIO forks or renames folders on site retitles | AIO/UI-source/electron/series-merge.js:4-8 vs CM/push_all_to_tablet.py:91 | Key on identity; a stale alias is a warning, not an abort |
| Alias validation gaps: only aliases whose tablet key is present get checked; alias errors exit 1 even in plan mode; `--only` is ignored; sync never validates at all | CM/push_all_to_tablet.py:435-441, 804-819, 892-906; CM/sync_to_tablet.py:226-227, 940-942 | Live, non-blocking alias health |
| Aliases are looked up by the RAW PC folder, so `SPY×FAMILY (hid=x)` would miss the alias and land beside `SPY_x_FAMILY`. push_all uses `matched[0]`, the alphabetically first match | CM/sync_to_tablet.py:226, 549-573; CM/push_all_to_tablet.py:460-469 | Resolve aliases on identity, after hid-strip |
| Alias-unaware compare/dashboard shows each alias pair twice ("Tablet missing" + "Only on tablet" with "Delete all") | CM/compare_manga.py:292-307, 762-793; CM/manga_manager.py:261-317, 539-550; CM/_verify_report.txt:17-48 | One shared resolver for plan, diff, sync and verify |
| Contradictory naming rules. 6 live PC series exist ONLY as hid folders: Bungo Stray Dogs, Daughter of the Spirit King, Fatestrange Fake, JoJo Part 6, Konosuba, Sentenced to Be a Hero | CM/manga_manager.py:557-566 vs CM/push_all_to_tablet.py:94-100, 469-471; D:\AIO\manga listing | One `resolveTabletName()` |
| hid collapse can merge DIFFERENT series: AIO adds `(hid=…)` only on genuine title collisions, and ` (k)` suffixes are not stripped | AIO/aio-dl.py:936-937, 1025-1026, 1036-1041, 949; CM/_compare_tablet_vs_pc.py:62, 68-70, 123-148 | Use identity (site + hid / url) |
| Folder names ≠ titles for 25 of 132 series (7 through a hid suffix), e.g. `Code Breaker` from "Code: Breaker", `Fatestrange Fake (hid=…)` from "Fate/strange Fake" | AIO/aio-dl.py:496-503, 936, 949; AIO/UI-source/electron/library.js:767 | Name-level matching must normalize, or use identity |
| Raw PC folder names in maps go stale fast (bare `Sentenced…` had 0 cbz by 05-24). Empty placeholders on 05-24: Daughter of the Spirit King, Fatestrange Fake, Sentenced… | CM/_delta_findings.py:86-87; CM/_pc_sizes.json:99-104, ~155-160, 443-448 | Re-resolve every run; ignore empty placeholder folders |
| Tablet folders that normalize to the same key: first wins, the rest are ignored | CM/compare_manga.py:774-787 | Show collisions to the user |
| A missing mapped folder yields a bogus one-sided diff | CM/_delta_findings.py:169-171, 265 | Report "folder missing" |
| An alias has no fallback, and its normalized target matches every hid variant | CM/_compare_tablet_vs_pc.py:124-128, 133-137 | Explicit precedence |
| Leaving out an alias never excluded JoJo 6 (hid-strip matched it) | CM/tablet_vs_pc.json:495-511 | Exclusions are explicit overrides |
| The JoJo 4 decision was reversed later | CM/push_all_to_tablet.py:84-85 vs CM/REDOWNLOAD_FOR_KOMIKKU.md:60-67 | Overrides must be editable over time |

### 6.4 Parsing, labels and counts

| Failure | Evidence | Lesson |
|---|---|---|
| Komikku names are invisible to the compare/dashboard parser: 19,574 of 20,007 device paths are `Ch.NNN - …`, so label = None. They are hidden from tables, every PC chapter shows "missing", and whole-series delete sweeps them. Device counts include sidecars (213 vs 215) | CM/compare_manga.py:71-103; CM/manga_manager.py:220, 307, 331, 402, 428-437; CM/_verify_report.json:227-240 | Reuse AIO's parser (AIO/UI-source/electron/library.js:148, 159-217); count only chapter archives |
| An apostrophe in a filename-label breaks the dashboard's Apply (single-quoted `hx-vals`); 684 device filenames contain `'` | CM/templates/partials/confirm_modal.html:71; CM/manga_manager.py:589, 748-757 | Pass ops as structured IPC data |
| Volume files parsed as chapters (Sakamoto Days `Vol 1-24` minus 21 read as "skipped Ch 21"); 12 of 67 device series use `Vol N` | CM/_delta_findings.py:122, 126-127; CM/DELTA_FINDINGS.md:79-85 | Every label carries a unit (chapter / volume / whole-series / unknown); never diff across units |
| Whole-series dump PDFs counted as chapters (6 files → off-by-one totals) | CM/_classify_tablet.py:56-57; CM/tablet_classify.json vs CM/delta_findings.json | Same as above |
| Seven device naming conventions, mixed inside folders (SPY_x_FAMILY: 21 spaced + 183 underscored). 14 device files match none of the six regexes, not 6 | CM/tablet_files.txt (analysis verification) | Ordered, extensible pattern list; "Unparsed files" view |
| `#N - [Season X] Ep. Y` yields the running index, not the episode (Tower of God) | CM/_delta_findings.py:121 | Choose the label group per pattern or per series |
| Labels compared as raw strings (`5.50` ≠ `5.5`, device `01` ≠ `1`); an empty side's max/min default to 0.0 | CM/_delta_findings.py:110-111, 117-118, 126-127, 202-205 | Canonicalize numerically |
| Duplicate labels collapse into one row; the confirm list shows the label, not the filename | CM/manga_manager.py:428-437, 480-484, 521-525, 730-733 | Show filenames; flag duplicates |
| Doc and code disagree on the delta definition | CM/DELTA_FINDINGS.md:11 vs CM/_delta_findings.py:272 | Unique labels; surface duplicates |
| The tagger can't separate content loss from a numbering mismatch; `tablet_ahead_only` never fires on real data, so the loss lists were hand-made | CM/_delta_findings.py:212, 223-226; CM/delta_findings.json | Compute device-only integers above vs inside the PC range, separately from partials |
| Different numbering systems can't be reconciled: JoJo 5 up to 594 vs 155; JoJo 4 Ch 439.1 vs 174; JoJo 6 752.1 vs 158; Is the Order a Rabbit | CM/DELTA_FINDINGS.md:87-95, 124-132; CM/REDOWNLOAD_FOR_KOMIKKU.md:66-67 | Heuristic flag + explicit per-series decision |
| What a partial means depends on the source: device mangafire `.1/.2/.3` are scan splits; PC `.5` are real omake | CM/DELTA_FINDINGS.md:52-56, 193-200, 217-224, 259-272 | PC-only partials are real content |
| Prologue (Ch 0) loss: Bleach, SPY×FAMILY, CØDEBREAKER, Konosuba, Bungo Stray Dogs, Undead Unluck | CM/DELTA_FINDINGS.md:57-60 | A separate warning class |
| zip/cbr/rar/epub ignored in decisions (classifier `empty`, recommender `push-empty`) | CM/_classify_tablet.py:27, 64-65, 73-82; CM/_compare_tablet_vs_pc.py:101, 133, 149-160 | Drive decisions from the reader profile |
| Cover check is exact-case `cover.jpg` and actually any-depth in the classifier | CM/_classify_tablet.py:44-49, 66; CM/_compare_tablet_vs_pc.py:95 | Profile setting; warn on near-misses |
| AIO side: `extractChaptersFromFiles` silently drops unmatched names and leaves legacy tokens unnormalized (`05`, `5 - Extra`). `scanLibrary` chapterCount is an image-dir count, 0 for every CBZ series. Python `CHAPTER_FILE_RE` misses Komikku names | AIO/UI-source/electron/library.js:175-212, 297-311, 699-702; AIO/library_state.py:15-18 | Add an "unparsed" channel; don't trust chapterCount |
| compare_manga exits 1 whenever any anomaly exists, which is always on a Komikku device (cover/details flagged) | CM/compare_manga.py:1035-1043, 1520 | Whitelist profile sidecars |
| A 0-chapter PC-only folder is listed under "Only on tablet"; its delete resolves to nothing | CM/manga_manager.py:261-284, 379-383, 539-541 | Classify empty folders separately |

### 6.5 UI lessons from the dashboard

| Failure | Evidence | Lesson |
|---|---|---|
| Server errors never reach the user: htmx 1.9 doesn't swap non-2xx and there is no error handler. The observed 400 left an idle modal | CM/.playwright-mcp/console-2026-05-11T15-29-30-010Z.log:1-2; page-2026-05-11T15-30-18-464Z.yml:688-708; CM/static/app.js:78-129, 229-236 | Render every error explicitly |
| The progress modal can hang forever: no reconnect handling, empty streams, zombie consumers | CM/transfer_runner.py:130-155, 236-242; CM/static/app.js:170-181, 221-235 | Job state lives in main; the tab re-adopts a snapshot |
| Scans run synchronously under a global lock on any request (180/600 s); errors → invisible 500 | CM/manga_manager.py:155-180; CM/compare_manga.py:536-565 | Async scan with progress and error state |
| The "tablet-pulse" dot is decoration; the device is never re-checked | CM/templates/base.html:20; CM/static/styles.css:153-158; CM/manga_manager.py:913-923 | Live device status |
| Before the fix, a whole-series delete of an unlabelled orphan resolved to 0 ops | CM/_screens/dash-08-deletepreview.png; CM/manga_manager.py:539-549 | Orphan files must be addressable by filename |
| The view stays stale after a transfer | CM/static/app.js:170-181 | Refresh or patch after apply |

### 6.6 Reader semantics (Komikku spec) and environment

| Failure / fact | Evidence | Lesson |
|---|---|---|
| Komikku's LocalSource reads exactly one root, `<SAF root>/local/` (lowercase `local`). A loose archive there is not a manga. The spec warns against putting the SAF root inside `Documents/`. Every CompareManga script targets `/storage/self/primary/Documents` | SPEC:15, 30, 35, 41; CM/compare_manga.py:56 | Target root per reader profile. Which reader reads what is an open question (§9) |
| Renaming a chapter file breaks Komikku read progress; renaming a series folder forks a new library entry; progress is keyed on (folder name, filename) | SPEC:230-231, 328 | Any device rename (alias change, hid strip, adoption `mv`, rename detection) costs reading history. This is why `KEEP_TABLET_NAME_FOR_ALIASES` exists |
| Komikku writes a user's custom cover as `cover.jpg`, overwriting ours | SPEC:94 | Cover sync must not clobber a device cover blindly |
| Komikku detects changes by mtime only; no hashing | SPEC:229 | adb push sets device mtime to push time, so changes are seen |
| Nested sub-folders become ONE chapter; 240-byte filename cap; `.nomedia` recommended in `local/` | SPEC:49, 51-52, 182, 258 | Validate layout per profile |
| AIO `--komikku` output IS the mirrored set, so PDF-format series are invisible to sync | AIO/aio-dl.py:4702-4716, 4958-4959, 9297-9306; AIO/UI-source/src/components/SettingsTab.jsx:361 (`defaults.komikku: false`) | Mirrored types follow the reader profile |
| The PC root moved (OneDrive → `D:\AIO\manga`) | CM/push_run.log:9 vs CM/synclogs07.md:1641 | Root = AIO setting |
| PowerShell pitfalls: wildcard `-Path` with SilentlyContinue; no `.aio_coord` exclusion plus `Stop`; `_pc_sizes.json` has a BOM | CM/_scan_pc_sizes.ps1:3, 5, 21; CM/_scan_pc_repack.ps1:5, 8-9 | Literal paths; utf-8-sig |

### 6.7 Search helpers

| Failure | Evidence | Lesson |
|---|---|---|
| batch_search can't run: the AIO path is dead | CM/batch_search.py:35, 41 | Use AIO's own spawn paths |
| `seed_links.*` results were lost | no seed_links files in CM or AIO | Persist results in app state |
| Constants and docs drifted: probe deadline "120 s" (now 240); "top-3" vs top-5; fixup says 2 edits but does 3 | CM/batch_search.py:18, 56-60, 267; AIO/sites/search_orchestrator.py:284; CM/fixup_seed_links.py:5-16 | Derive values at runtime |
| 0-candidate results are never retried | CM/batch_search.py:222-224 | Allow retry |
| One process shared the MangaFire browser session; spawning per query pays warm-up. `profile_lock` makes processes wait; searcher is single-flight | CM/batch_search.py:4-6; AIO/sites/profile_lock.py:9-27; AIO/UI-source/electron/searcher.js:101-104, 122-123 | Serialize a batch; own cancel/resume; contends with the update sweep |
| Pinned webtoons.com URLs can't go through `--search` seed mode (mangafire/comix only) | AIO/aio_search_cli.py:82-85, 537-549 | Store as a direct URL and queue a normal download |
| Results via `aio-dl --search` differ from the old batch (probe_candidate_limit=2, fetch_memo, 1 h host suppression) | AIO/aio_search_cli.py:276-313, 551-607 | Expect different rankings |

---

## 7. AIO integration map

### 7.1 Files and functions to touch

**AIO/UI-source/src/App.jsx**
- **Rail.** `TABS` is a module-level constant (:25-31, `settings` last at :30). The opt-in entry must come from a derived list placed immediately before `settings`.
- **Header.** The header label uses `TABS.find` (:165-167), so it must use the same derived list.
- **Tab bodies** render conditionally (:172-261). The tab unmounts on every switch, so long-running state must live in main plus a hook mounted inside useDownloader.
- **Fallback.** `activeTab` (:34) has no fallback if the flag turns off.
- **Rail button anatomy** (:104-157):
  - `w-12 h-12`; active bar at :130-132;
  - count badge at :135-139; red alert dot at :145-154;
  - label is `text-[9px]`, so it must be very short.
- **Props** follow LibraryTab's pattern (`dl.settings`, `dl.saveSettings`, :174-185).
- **Deep link to Settings** via `settingsCategory` (:40, 216-219, 258; SettingsTab `initialCategory` :676).
- ResumeBar renders under every tab (:263-276). ConfirmQuitDialog is at :282.
- **Uncommitted:** a 2-line prop swap near :181-184.

**AIO/UI-source/src/components/SettingsTab.jsx** (clean: no local modifications)
- `CATEGORIES` has a `library` entry, desc "Update checks and how the library is scanned." (:435-436). `renderLibrary` uses Checkbox + Label + `ml-6` helper rows (:2687-2763).
- `SECTIONS` (:2770-2788): adding `{group:"library", title:"Tablet Sync", render}` updates nav counts automatically (:2811).
- **Defaults.** `DEFAULT_SETTINGS` (:166-408) is the owner of download defaults (AIO/CLAUDE.md:124). main.js also resolves some top-level defaults itself (main.js:657-667).
- **Dirty counting** (:469-494): top-level reference equality; `SKIP_TOP = {isPackaged, disabledSites}` (:476); `NESTED = [defaults, searchOpts]` (:477). A new `DEFAULT_SETTINGS` key causes a one-time phantom "1 changed" for existing users (:460-465, 480-483, 796-802).
- **Save/Reset.** `handleSave` writes the whole draft (:913-916). `handleReset` clones `DEFAULT_SETTINGS` (:918-936).
- **Immediate-persist precedent:** `disabledSites` (:851-858).
- `renderKomikku`'s hint tells users to copy into `<Komikku-SAF>/local` manually (:1470-1492, hint :1483-1484). This is the natural place to point at the tab.
- **Reusable idioms:** the list editor in `renderSearchSources` (:2555-2684); Switch rows (:1449-1462, 1471-1491, 1500-1516); two-click confirm with a 4 s auto-cancel (:952-962).

**AIO/UI-source/electron/main.js** (455-line uncommitted diff)
- **IPC.** Only `ipcMain.handle` is used (:498-1862). Newer families use colon namespaces (:1845-1846). Push events go through `sendToUI` (:409-417).
- **PC root:** `getConfiguredOutputRoot` (:220-233) + `resolveSpawnPaths` (:361-367). `get-resolved-paths` doesn't expose it (:682-688).
- **Handler pattern:** read config from `history.getSettings()` at call time and inject `libraryRoot`/`runningDownloads`, like `merge-series-folders` does (:1759-1775).
- **Long-job pattern:** `createUpdateCheckRecord(sendToUI)` (:41, 161).
- **Quit gate** only knows about downloads (:555-569, 869-879, 1862-1873, 1953-1961). Its dialog payload is download-shaped (AIO/UI-source/electron/preload.js:80-92; downloader.js:981-993) and it has a 15 s safety valve.
- **Pickers:** `pick-file` defaults to `*.py` (:897-904); `pick-folder` (:888); `open-folder` is `shell.openPath` (:882-885).
- **scan-library** (:965-1049) calls a synchronous `scanLibrary` on the main thread; check-all calls it again (:1464).
- **Other handlers:** `delete-series` (:1059-1068), `metadata:update` (:910-915), `set-chapters-ignored` (:1713-1752), `save-series-meta` (:1781-1808), `OUTPUT_EXTS` (:1261), dotfile skip (:1271), `localfile://` (:109-117, 1891-1899).
- **Window:** 1100×750, minimum 800×550 (:525-528). With the 64 px rail, the tab body must work at about 736 px.

**AIO/UI-source/electron/preload.js** (56-line diff)
- Everything is exposed on `window.electronAPI` (:17).
- `on*` subscriptions return an unsubscribe function (:55-78, 191-195).
- Pickers (:46-48); queue (:42-43); search (:98-99); chapters-ignored (:167).

**AIO/UI-source/src/hooks/useDownloader.js** (21-line diff)
- Return object (:1165-1198); `useUpdateCheck` is mounted once (:258).
- `saveSettings` merges into state immediately (:1012-1017).
- Pre-load placeholder (:166-203).
- High-frequency state is kept out of settings (`searchSiteHealth`, :223-237).
- Log entry shape `{downloadId, line, level, timestamp}` (:18); `libraryEntries` (:247, 1031).

**New main-process module(s)**
- Follow `series-merge.js`'s standalone, dependency-injected, offline-testable style (AIO/UI-source/electron/series-merge.js:12-33, 44-50).
- Tests go in the gitignored `tools/_test_*.js` (AIO/CLAUDE.md:109).
- UI verification is `cd UI-source; npm run build` (AIO/CLAUDE.md:183).

### 7.2 Reusable utilities

- **Chapter parsing:** `extractChaptersFromFiles` (library.js:159-217; exported at :1118) handles Komikku and legacy names. `KOMIKKU_CH_RE` (:148) and `_normalizeChapterToken` (:231-241) are NOT exported. Unmatched names are silently dropped (:187-188).
- **Label canonicalization and sort:** `chapterLabel` / `compareChapterLabels` (series-merge.js:76-91); `naturalCompare` (library.js:69-72; AIO/UI-source/src/lib/utils.js:42-45); aio-dl `_chapter_label_sort_key` (AIO/aio-dl.py:7065-7087); `chaptersToRangeString` (utils.js:91-111).
- **Series identity:**
  - JS: `seriesIdentityKey` (library.js:480-487), `normalizeSeriesUrl` (:460-467), `groupEntriesBySeries` (:524-544), `findDuplicateSeries` (:560-603).
  - Python twins: AIO/library_state.py:360-396, 435-464.
  - Uncommitted Python identity block + `find_matching_series_folders`: AIO/aio-dl.py:505-534, 985-1010.
  - `anilist_synonyms` in `.aio_series.json` can seed alias suggestions.
- **Library scan:** `scanLibrary` (library.js:616-807) is synchronous.
  - `chapterCount` is an image-dir count (:699-702).
  - It drops payload-less folders (:683-694), so it sees 132 of 134 on this machine.
  - It skips dot entries (:629-630, 646), probes cover names (:735-741), and attaches `seriesKey`/`anilistId`/`duplicate` (:777-805).
  - For hashing, a lighter async walk is needed.
- **File classes:** `PAYLOAD_EXTS` / `SINGLETON_FILES` / `METADATA_FILES` (series-merge.js:54-68); HID markers (main.js:235-245; AIO/aio_config.py:55-64).
- **Plan → confirm → execute** for destructive work: `planFolderMerge` / `mergeSeriesFolders` + MergeDuplicatesDialog (series-merge.js:180-273, 369-494; LibraryTab.jsx:487-744). It is also the fix for the "losing hid variant" case.
- **Long-job record:** update-check-record.js:83-161 + useUpdateCheck.js:59-423.
- **Chapter chips:** ChapterChips.jsx:44-221. Its wording is download-specific (:7-19, 69-75, 97-101, 133-150), so it must be parameterized for "don't sync".
- **Logs:** log-filter.js `stripAnsi` / `classifyLogLevel` (:84-86, 113-133).
- **Subprocess:**
  - `Downloader._spawn` (downloader.js:721-931).
  - Tree kill: `taskkill /pid <pid> /f /t` (:942-962); `cancelAll` bounded at 5 s (:1004-1015).
  - Searcher and check-all do NOT tree-kill (searcher.js:251-263; main.js:1174-1204).
- **Komikku writers** for add-cover/metadata remediation: `_komikku_chapter_filename`, details.json and ComicInfo writers (AIO/aio-dl.py:4958-5039, 4711-4723, 4762-4771, 5309-5377).
- **Hashing:** nothing exists in AIO (the only `createHash` is an md5 cache key at library.js:94-100). This is new code.

### 7.3 Subprocess and helper patterns

- **adb from Node directly.** No Python hop and no packaging change. Follow the `_spawn` pattern: `windowsHide`, piped stdio, line buffering, explicit UTF-8 decoding (the library has non-ASCII names such as `Hell’s Paradise Jigokuraku`, `SPY×FAMILY`, `The Café Terrace and Its Goddesses`), tree-kill on cancel, and registration with the quit gate.
- **If a Python helper is used instead:**
  - put it at the repo root and add it to the `prepare-src.js` whitelist (AIO/UI-source/scripts/prepare-src.js:98-106), or it won't ship;
  - force UTF-8 stdio (AIO/metadata_cli.py:8-23);
  - call it like `runMetadataCli` (main.js:247-289: JSON on stdin/stdout, `PYTHONPATH = dirname(scriptPath)`). Note that it has no timeout or cancel and ignores `settings.scriptPath` (:248-252, 259).
  - The Android/Chaquopy build shares aio-dl.py, where adb is meaningless.
- **aio-dl.py CLI hooks:**
  - `-o/--output-dir` priority: flag → `AIO_OUTPUT_DIR` → `aio_config.json` → `manga` (AIO/aio-dl.py:8952-8957);
  - `--scan-library` (:8853-8863); `--komikku` (:9297-9306); `--list-chapters` (:8843-8845); search flags (:8535-8553).
  - There is no flag for the probe deadline.
- **Search IPC for a batch "Find sources":** `search:run` / `search:cancel` (main.js:753-786) and `buildSearchArgs` (searcher.js:38-81).

### 7.4 Settings persistence

- `history.js` stores `%APPDATA%/aio-downloader-ui/settings.json`:
  - atomic tmp+rename with a copy fallback (AIO/UI-source/electron/history.js:102-137);
  - shallow top-level merge (:230), filtering only pythonCmd/scriptPath/workingDir (:208);
  - `SETTINGS_SCHEMA_VERSION = 1` with migrations (:23, 54-71);
  - write failures are swallowed, and `save-settings` always returns `{ok:true}` (history.js:102-137, 230-231; main.js:694-710).
- **An opt-in boolean** round-trips with no main-process change (main.js:648-672, 694-710).
- **Complex config** (profiles, aliases, overrides) placed in the draft interacts badly with Save:
  - it triggers the reference-equality dirty count;
  - Reset + Save wipes it only if the key is declared in `DEFAULT_SETTINGS`; undeclared keys survive Reset but are re-sent on every Save (SettingsTab.jsx:796-802, 913-916, 932-935).
- **Precedents:** immediate-persist (`disabledSites`; `libraryOpts` merged through a ref at LibraryTab.jsx:1599-1608) and a separate userData JSON file (`download_queue.json`, history.js:234-260).
- **Stale-key lesson:** the unused key `updateChecksUseSeededRating` persists forever (settings.json:63). Changing a default later needs a migration (main.js:1942-1944).

### 7.5 Design system

- **Tokens:** HSL CSS variables for light and dark (AIO/UI-source/src/styles/globals.css:17-47, 50-76). Tailwind maps them, including success/warning/info (AIO/UI-source/tailwind.config.js:15-56). Radius 0.5rem; darkMode `class` (:5).
- **Type and motion:** DM Sans body (globals.css:86); JetBrains Mono `.log-text` (:154-158). Animations slide-in 0.2 s, slide-up 0.15 s, pulse-subtle 2 s (tailwind.config.js:59-83). Google Fonts via CDN (AIO/UI-source/index.html:8-12).
- **Primitives** (AIO/UI-source/src/components/ui/primitives.jsx):
  - Button (:14; default/secondary/destructive/ghost/outline; sm/default/lg/icon), Input (:56), Textarea (:74), Label (:92), Switch (:107), Slider (:136), native Select (:157), Checkbox (:177), Card (:211);
  - Badge (:223-243) does not spread props, so it can't be clickable; a hand-rolled MetaChip exists (LibraryTab.jsx:214-229);
  - SectionHeader (:246), Collapsible (:258).
  - There is no Dialog, Tooltip or Tabs primitive. Overlays are hand-built: `fixed inset-0 z-50 … bg-background/80 backdrop-blur-sm` with a `max-w-lg max-h-[85vh]` card (LibraryTab.jsx:487-744).
- **Accent meanings:** orange = new chapters (UpdatesCenter.jsx:69-98; ChapterChips.jsx:44-115); amber = advisory/duplicate/dirty (SettingsTab.jsx:98-118, 544-657; LibraryTab.jsx:366-393); emerald = success; sky = in progress; red = error; violet = images/AniList.
- **Caveats:**
  - theme success/warning/info tokens are used only in DownloadTab.jsx;
  - Badge success/warning use raw green/yellow (primitives.jsx:223-230);
  - FORMAT_COLORS already paints CBZ badges orange (LibraryTab.jsx:53-60);
  - some surfaces are dark-only (ChapterChips.jsx:55, 79; LibraryTab.jsx:2141-2142);
  - the UpdatesCenter side sheet hard-codes zinc-* colours (UpdatesCenter.jsx:852-867): copy its structure, not its colours.
- **Layout idioms:**
  - toolbar `flex items-center gap-2 px-4 py-2.5 border-b bg-card/20` (LibraryTab.jsx:2042-2198);
  - chip rows with staggered slide-up (:2205-2245);
  - card grid `grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-4` (:2268) with skeletons (:2279-2289);
  - file rows `bg-card/40 border border-border/30 hover:border-primary/30` (:1443-1447);
  - side sheet `max-w-[480px]`;
  - Settings two-pane nav with a sticky footer (SettingsTab.jsx:2794-2889).
- **Icons:** lucide-react is pinned at 0.263.1 (AIO/UI-source/package.json).
  - Present: Tablet, Tablets, Smartphone, MonitorSmartphone, Usb, Cable, Plug, FolderSync, FolderTree, FolderInput, FolderOutput, HardDrive, HardDriveUpload, HardDriveDownload, GitCompare, FileDiff, ArrowLeftRight, ArrowRightLeft, RefreshCw, RefreshCcw, ListChecks, CheckCheck, Link2, Link2Off, Send, Upload, Scan, Radar, Merge, Filter.
  - Absent: Funnel, TabletSmartphone (LibraryTab.jsx:40-43).
- **Wording clash:** "device" already means the PC disk in AIO (library.js:243-273, 398-425; SettingsTab.jsx:2694-2696 "Check chapters against files on device"; LibraryTab.jsx:980-982, 1047). The tab needs distinct terms.

### 7.6 In-flight uncommitted work that must not be clobbered

- **Branch:** `fix/mangafire-cloudflare-challenge` at `d1ae7d6`, ahead 1 of `fork/fix/mangafire-cloudflare-challenge` (`git status -sb`). No stashes.
- **36 modified files:**
  - .github/workflows/release.yml
  - UI-source/electron/{downloader,library,main,preload}.js
  - UI-source/src/App.jsx
  - UI-source/src/components/{LibraryTab,UpdatesCenter}.jsx
  - UI-source/src/hooks/useDownloader.js
  - UI-source/src/lib/{downloadArgs,utils}.js
  - aio-dl.py, aio_android.py, library_state.py
  - android/app/build.gradle.kts, AndroidManifest.xml, and 9 Kotlin files (DownloadService, MainActivity, DownloadRepository, LogFilter, LogTail, ResumeRepository, LogsScreen, QueueScreen)
  - android/wheels/README.md
  - sites/{base,browser_identity,comix,mangafire_vrf,search_orchestrator}.py
  - tests/test_{android_argv,android_metadata,android_resource_limits,android_search,comix_pagination,mangafire_vrf}.py
- **Diff size:** UI-source is 10 files, +1787/−544 (LibraryTab 1058, UpdatesCenter 500, main.js 455, library.js 197, preload 56, utils 23, useDownloader 21, downloadArgs 10, downloader 9, App.jsx 2). The whole tree is 36 files, +6865/−831.
- **21 untracked entries:**
  - .github/workflows/android.yml
  - UI-source/electron/series-merge.js, UI-source/electron/update-check-record.js
  - UI-source/src/components/ChapterChips.jsx, UI-source/src/hooks/useUpdateCheck.js
  - Android AppUpdater.kt, RunPersistence.kt, RunStore.kt and 3 tests
  - 4 android/wheels/*.whl and android/wheels/recipes/
  - sites/profile_lock.py
  - tests/test_{android_repair,fast_download_timeouts,profile_lock,series_folder_identity}.py
- **Worktrees:** 4 agent worktrees (`.claude/worktrees/agent-a4c28bab5f3ff5c7f`, `-a70ab5579168503df`, `-ae93ca7458b4792cd`, `-aef9367a777af1246`) plus a detached scratchpad baseline, all at `d1ae7d6`. None of them contain the main tree's UI-source changes (verification). A fresh worktree or branch would therefore build on stale copies of App.jsx, main.js, preload.js and useDownloader.js.
- **Other risks:**
  - Git warns LF→CRLF on the modified UI files.
  - The reusable pieces (series-merge.js, update-check-record.js, useUpdateCheck.js, ChapterChips.jsx, the library.js identity exports) are themselves uncommitted, so the tab would depend on unmerged work.
- **Repo process rules:** run `git status` and `gh pr list --state all --author Thundia2` first (AIO/CLAUDE.md:61-64). An open PR means commit onto its branch; otherwise cut fresh from `upstream/main` (:82, 229).

---

## 8. Refuted census claims (do not build on these)

| # | Area | Claim | Correction | Evidence |
|---|---|---|---|---|
| 1 | sync | A failing `--verify` hash skips the folder and leaves its entries intact | Only exceptions skip. rc and stderr are ignored and the remote command uses `2>/dev/null`, so a device drop returns `{}` and the folder's entries are popped and flushed | CM/sync_to_tablet.py:369-373, 758-767 |
| 2 | sync | SHELTER is the side-loaded, tablet-only, preserved folder | SHELTER now has a PC source (`D:\AIO\manga\SHELTER`, 225 entries). It was verified as managed folder `[88/117]`, the plan showed "Folders preserved: 0", and the journal holds 218 `SHELTER/` keys. It would be pruned if its PC folder disappeared. The verify_push check is obsolete | CM/synclogs07.md:1635-1636, 1649; read-only `ls`; CM/verify_push.py:128-135 |
| 3 | sync | The listing falls back to `-exec stat` when `-printf` is unsupported | Dead code: `2>/dev/null` hides find's error from the stderr check, so the result is folders with zero files | CM/compare_manga.py:530-534, 543-551 |
| 4 | sync | adb timeouts "bound every adb call" | Streamed pushes check the deadline only between blocking reads; `push_chapter` has no timeout; _verify_chapters has none | CM/push_all_to_tablet.py:197-205; CM/manga_ops.py:174-198; CM/_verify_chapters.py:24-25 |
| 5 | sync | A stale alias aborts apply (exit 1) | Only aliases whose tablet key currently exists are checked. Errors exit 1 even in plan mode and ignore `--only`/`--skip`. sync never validates aliases | CM/push_all_to_tablet.py:435-441, 804-819, 892-906; CM/sync_to_tablet.py:226-227 |
| 6 | sync | verify_push exits 1 on any discrepancy | Exits 1 only when there is no log, SHELTER is missing, the log has failures, or targets are missing. Count mismatches and extras never fail; `alias_errors` are ignored | CM/verify_push.py:40-42, 75, 85-142 |
| 7 | sync, analysis | The in-flight list is main.js … ChapterChips.jsx; "4 untracked" | 36 modified + 21 untracked (full list in §7.6) | `git status --short` |
| 8 | dashboard | The Eleceed fixup is handled by `search_orchestrator.py:440-444` | :444 is just the field. The tiebreak is in `_cmp` (:6189-6201), gated by `IS_OFFICIAL_REQUIRES_TITLE_MATCH = 0.85` (:251), after the dmca/count sink (:6185-6188); linewebtoon has `OFFICIAL_PUBLISHER = True` | AIO/sites/search_orchestrator.py:238-251, 444, 6185-6201; AIO/sites/linewebtoon.py:182 |
| 9 | dashboard | Preview "silently skips" pushes already on the tablet | Only `*` expansion is silent. A single-chapter push is listed under Skipped as "no push candidate for <label>" | CM/manga_manager.py:490-493, 503-513, 533-537 |
| 10 | dashboard | batch_search's `make_args` fields (language, parallelism, timeouts, seeded_only…) are its search options | They have no effect; only `cookies` reaches the scraper. The real settings are the explicit `search_all` arguments + request factory (timeout 8.0, attempts 2) | CM/batch_search.py:144-161, 210-240; AIO/aio_search_cli.py:276-313 |
| 11 | analysis | `_pc_sizes.json`: all 84 folders have a cover and `.aio_series.json` | 3 empty placeholders have neither: Daughter of the Spirit King, Fatestrange Fake, Sentenced to Be a Hero | CM/_pc_sizes.json:99-104, ~155-160, 443-448 |
| 12 | analysis | `komikkuspec.md` has no git history | Deleted in `1f17a20`; the full 346 lines are readable from `1f17a20^`, but the commit is on no branch (unreachable object) | `git cat-file -t 1f17a20`; AIO/aio-dl.py:7818 |
| 13 | analysis | "no chapters → push-empty" | 0-chapter matches are dropped, so they become `download`. `push-empty` happens only when the PC has zip/cbr/rar/epub only | CM/_compare_tablet_vs_pc.py:101, 133, 135-137, 149-160 |
| 14 | analysis | The classifier checks `cover.jpg` at the series root | It checks basenames at ANY depth | CM/_classify_tablet.py:44-49, 66 |
| 15 | analysis | Not aliasing JoJo 4 and 6 prevented their push | Only Part 4 was excluded. Part 6 matched its `(hid=t4U07)` folder through hid-strip and was still recommended `push` | CM/_compare_tablet_vs_pc.py:62-76, 128, 133; CM/tablet_vs_pc.json:495-511 |
| 16 | aio | `DEFAULT_SETTINGS` is the single owner of defaults | That rule covers download defaults. main.js resolves appAutoUpdate, verboseAlways, logUpdateInterval and defaults itself; useDownloader's placeholder has several keys | AIO/UI-source/electron/main.js:657-667; useDownloader.js:166-203; AIO/CLAUDE.md:124 |
| 17 | aio | `_normalizeChapterToken` is exported | Neither it nor `KOMIKKU_CH_RE` is exported; reuse goes through `extractChaptersFromFiles` | AIO/UI-source/electron/library.js:148, 231, 1118 |
| 18 | aio | No child process outlives Electron | Only Downloader children are cancelled. Check-all and search processes are not, and those use a plain kill, not a tree kill | main.js:1174-1204, 1862-1873, 1953-1961; searcher.js:251-258 |
| 19 | aio | useUpdateCheck re-adopts the snapshot on tab remount | It is mounted once for the renderer's lifetime; tabs just read its live state | useUpdateCheck.js:190-233; useDownloader.js:258 |
| 20 | aio | D:\AIO\manga holds 134 series | 134 dirs, but 132 are visible to scanLibrary. `One Piece (hid=one-piece.49)` and `The Café Terrace and Its Goddesses` are husks | AIO/UI-source/electron/library.js:683-694; read-only `ls` |
| 21 | aio | Draft-held tables are wiped by Reset + Save | Only if declared in `DEFAULT_SETTINGS`; undeclared keys (e.g. `libraryOpts`) survive and are re-sent on every Save | SettingsTab.jsx:796-802, 913-916, 932-935; history.js:230 |
| 22 | aio | `open-folder` reveals a path | It is `shell.openPath`, which opens the folder; there is no reveal-file IPC | main.js:882-885 |

---

## 9. Open questions only the user can answer

**A. Scope**
1. Which CompareManga capabilities belong in v1 of the tab?
   - (a) Compare/report view;
   - (b) file-level sync: preview / apply / verify / prune;
   - (c) selective per-chapter send/remove from the compare view;
   - (d) batch "Find sources" for device-only series;
   - (e) reader-compatibility check and remediation (the PDF→Komikku migration);
   - (f) post-apply verification;
   - (g) run history.
2. Should the wipe-and-re-push mode (push_all) be dropped entirely? Or kept as a "Full re-mirror" maintenance action (safer temp-then-swap form), or reduced to a one-time "adopt/rename existing device folders" step?
3. Is sync strictly one-way (PC → device)? Should device-only chapters ever be pulled back to the PC, or only reported?

**B. Devices, readers and targets**

4. Which reader(s) read which folder on the tablet today?
   - The scripts all target `/storage/self/primary/Documents` and call its CBZ + cover.jpg + details.json layout "Komikku-compatible".
   - The recovered Komikku spec says Komikku only scans `<SAF root>/local/`, and warns against using `Documents/` as the SAF root (SPEC:15, 30, 35).
   - Is Perfect Viewer the reader for Documents, and does Komikku read somewhere else?
5. Should one device support several targets (e.g. a Perfect Viewer folder AND a Komikku `local/`), or one target per device?
6. Which device is current: `3CEF42502E91537` (May/June runs) or `A06B4A372090333` (July runs)? Should several devices be remembered as profiles? Is wireless adb (`adb connect`) wanted?
7. adb: auto-detect plus a user override (both installs exist on this PC), or bundle platform-tools with the app?

**C. What gets mirrored and deleted**

8. Which file types go to the device? Today only `.cbz` + `cover.jpg` + `details.json` are sent, so PDF/EPUB-format series never sync and any PDFs in managed device folders get deleted. Should there be Perfect Viewer / Komikku presets?
9. Default delete policy: mirror deletes (today), additive-only, or ask every run? Should device files that are not of a mirrored type, or were user-added, always be protected? Is a mass-delete threshold wanted, and at what size?
10. Orphan prune: opt-in per run (today), or allow "always prune"? Is an explicit "never touch these device folders" list wanted, beyond the automatic "never synced = preserved" rule?
11. Renames. A chapter renamed on the PC can be moved on the device instead of re-pushed. Is it acceptable that reader progress keyed on the filename resets either way (SPEC:230)? For series-folder renames (alias change, hid strip, adopting an old device name), should the device folder be moved (Komikku forks a new entry, SPEC:231) or keep its old name?
12. `cover.jpg` / `details.json`: overwrite device copies when the PC version changes (clobbering Komikku custom covers, SPEC:94), or only push when missing?

**D. Aliases, naming and existing data**

13. Should aliases be only "PC series → device folder name" overrides? Or also "this existing device folder is that PC series" bridges, so existing device libraries are adopted instead of duplicated? Is it OK to key them on AIO series identity (site + hid / URL / AniList id) with the folder name as fallback?
14. Default name for NEW device folders: PC folder without `(hid=…)` (sync's rule), the series title from `.aio_series.json`, or something else? Should "keep the existing device name for aliased series" stay the global default (the 2026-05-24 decision)?
15. On first run, should existing CompareManga data be imported:
    - the 14 aliases;
    - the `.sync_state-A06B4A372090333.json` journal (skips a slow first full-device hash verify);
    - `.pc_hash_cache.json`?
16. Where should tablet config live: in `settings.json` behind the Save button, or in its own immediately-saved file? Should the Settings > Library opt-in toggle take effect immediately or on Save?

**E. Safety and behaviour**

17. Change detection: re-hash the whole library every run (the script default; ~25 s for 152.7 GB on this NVMe), or trust the size + mtime cache by default with an occasional full re-hash? When should the device-side hash verify run: first run per device only, manually, or a quick size check after every apply?
18. While AIO downloads or the update sweep are running: skip the affected series, refuse to sync, or wait for the queue to drain?
19. Quitting during a transfer: block with the existing quit prompt, or cancel and clean up partial files?
20. Should the "stop after N consecutive failures" budget (3) and the chapter-loss / shortfall thresholds (20 / 50) be user-editable?

**F. Analysis and search features**

21. Which per-series overrides do you want? Candidates: exclude from sync; never delete on device; accept chapter loss; force re-download (from which source / numbering, under which folder name); pinned source URL; preferred source; search-query override; keep device folder name. Any others?
22. Device series numbered by volume, single whole-series files, or a different numbering system (e.g. JoJo 4/5/6, Is the Order a Rabbit): show them as "not comparable" and require a per-series decision?
23. Batch "Find sources": which series should it cover (device-only, PC-missing, user-picked)? Should results be one-click "queue download"? Is adding an aio-dl.py flag for a shorter probe deadline acceptable (the old batch used 45 s vs 240 s)?
24. Sub-chapter splits that exist only on the device (mangafire `.1/.5` pieces): drop silently on sync, confirm per series, or preview first?
25. Run history: how many runs to keep? Is an exportable report (JSON/Markdown, like the old REDOWNLOAD/verify reports) wanted?

**G. Process and naming**

26. Which branch should this work go on, given 36 modified + 21 untracked files in the main tree, several of which the tab depends on (series-merge.js, update-check-record.js, useUpdateCheck.js, ChapterChips.jsx)? Should that in-flight work be committed or PR'd first?
27. Rail label and wording: the label is 9 px, so something like "Tablet", "Sync" or "Device". "Device" already means the PC disk elsewhere in AIO's UI text.
28. Should `komikkuspec.md` be restored into the repo? It currently exists only as an unreachable git object that `git gc --prune` could delete.
