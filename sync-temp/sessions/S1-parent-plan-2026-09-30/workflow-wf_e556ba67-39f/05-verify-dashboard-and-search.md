# Workflow wf_e556ba67-39f — verify:dashboard-and-search (phase Verify)

```json
{
  "area": "dashboard-and-search",
  "confirmed": [
    {
      "claim": "manga_manager.py has exactly 10 CLI flags. Defaults: --host 127.0.0.1, --port 5000, --no-browser, --pc-root (cm.DEFAULT_PC_ROOT = D:\\AIO\\manga), --tablet-root /storage/self/primary/Documents, --device auto, --adb auto, --cache-file <script dir>/.tablet_cache.json, --cache-ttl-hours 24.0, --size-threshold 30.0 (a literal, not cm.DEFAULT_SIZE_THRESHOLD_PCT). Any adb, device or PC-root resolution failure exits with code 2.",
      "evidence": "CM/manga_manager.py:895-905, 908-920; CM/compare_manga.py:55-60. adb order is override → PATH → KNOWN_ADB_PATH (CM/compare_manga.py:444-457). Device order is: the override must be connected, else the only device, else DEFAULT_DEVICE_SERIAL 3CEF42502E91537, else error (CM/compare_manga.py:460-489). D:\\AIO\\manga exists with 134 folders."
    },
    {
      "claim": "There is no alias, rename or folder map anywhere in the dashboard path. Series are matched by normalize_series_name only. The alias tables live in the sync/push scripts.",
      "evidence": "CM/compare_manga.py:292-307, 762-793. A grep for alias|rename|_MAP|OVERRIDE over manga_manager.py, manga_ops.py, transfer_runner.py and compare_manga.py finds no table. I enumerated every module-level constant in the assigned files: manga_manager.py:58-81, manga_ops.py:39-47, batch_search.py:35-38 and 74, fixup_seed_links.py:26-27, render_seed_links.py:18-21. The census pointer is correct: CM/push_all_to_tablet.py:74-92 ALIASES_TABLET_TO_PC (14 entries) and CM/sync_to_tablet.py:108-110 PC_TO_TABLET_ALIAS (its inverse)."
    },
    {
      "claim": "batch_search SERIES is a 64-entry (tablet_folder → query) table. The census lists it completely and correctly. The only query exceptions that cannot be derived by rule are #20 Frieren (curly → straight apostrophe), #24 Is_the_order_a_rabbit (adds '?'), #41 One-Punch_Man_(Official) (drops the suffix) and #62 Vivy_-Fluorite_Eye's_Song- (drops the dashes).",
      "evidence": "Checked line by line: CM/batch_search.py:75-138, assert at :141, rule comment at :66-73, exceptions at :94, :98, :115, :136."
    },
    {
      "claim": "batch_search can no longer run. It chdirs into a hard-coded AIO path that no longer exists, imports private AIO internals in-process, and monkey-patches PROBE_PHASE_DEADLINE_S to 45.0. AIO's value is now 240.0, with no CLI flag or env override.",
      "evidence": "CM/batch_search.py:35, 40-54, 62-64. `ls C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader` returns 'No such file or directory'. AIO/sites/search_orchestrator.py:284 is 240.0 (bump history at :253-283). The only env overrides in AIO *.py are AIO_SEARCH_SLOW_PROBE_S (search_orchestrator.py:348) and AIO_PROBE_BREADTH_CONCURRENCY (sites/base.py:521)."
    },
    {
      "claim": "The search config batch_search actually uses: search_all(language='en', parallelism=6, per_site_timeout_s=8.0, min_match=0.55, seeded_only=True, ProbeFailureCache(record_cooldown=None), ImageQualityCache()); request factory timeout 8.0, attempts 2; top-5 candidates kept per folder. The CLI --search-timeout default is 20.0. The current search_all signature still accepts all of these kwargs.",
      "evidence": "CM/batch_search.py:211-214, 228-240, 267. AIO/sites/search_orchestrator.py:160 (0.55), :183 (8.0), :5517-5537 (signature). AIO/aio-dl.py:8535-8538 (parallelism 6), :8541-8544 (timeout 20.0), :8551-8553 (min-match 0.55)."
    },
    {
      "claim": "fixup_seed_links applies 3 overrides and marks them with manual_override/override_reason: (1) SHELTER is replaced by a pinned linewebtoon Canvas URL (title_no=194264); (2) Tensura promotes the first source whose URL contains 'tensei-shitara-slime-datta-kenn'; (3) Eleceed promotes the first source with site=='linewebtoon' and 'webtoons.com' in the URL. It rewrites seed_links.json in place, non-atomically. Its docstring lists only 2 edits.",
      "evidence": "CM/fixup_seed_links.py:5-16 (docstring), 34-63, 65-84, 86-108, 110-111 (plain open('w'))."
    },
    {
      "claim": "Tablet deletes run only as `adb -s <serial> shell rm -f <shlex-quoted path>` (30 s timeout), always after _validate_tablet_path. The validator rejects: empty paths, over 4096 chars, \\n \\r \\0, the root itself (with or without a trailing slash), anything not under root+'/', and any '..' segment. There is no -rf anywhere. delete_tablet_dir validates the path, then raises NotImplementedError.",
      "evidence": "CM/manga_ops.py:86-107, 267-287, 290-302; self-test cases at :333-354."
    },
    {
      "claim": "Whole-series delete ('Delete all' on Only-on-tablet rows, 'Delete extras' on extras-only shared rows) expands to EVERY depth-1 tablet file, regardless of whether the chapter is on the PC, including reader sidecars.",
      "evidence": "CM/templates/partials/_series_row.html:2-8. CM/manga_manager.py:539-550 excludes only nested ('/') paths and has no PC filter. CM/compare_manga.py:676-678 filters only dot-files and .aio_series.json/.mangafire_hid. Data: a targeted grep of CM/.tablet_cache.json finds 111 depth-1 cover.jpg and 111 details.json entries, all of which such a delete would sweep."
    },
    {
      "claim": "How transfers work. One batch runs at a time globally; a second request raises RuntimeError('busy'), returned as HTTP 409 with active_transfer_id. A daemon worker runs, per op, mkdir -p then `adb -s <dev> push <file> <dir>/` without --progress. Progress is the last 'NN%' on each line (output split on \\r and \\n), throttled to 0.2 s. Events: batch_start, file_start, file_progress, file_done, batch_done, batch_cancelled, batch_aborted_due_to_errors. The batch aborts after 3 consecutive failures. Cancel is cooperative; adb is terminated, then killed after 5 s.",
      "evidence": "CM/transfer_runner.py:77, 85-117, 181-242, 245-294. CM/manga_ops.py:157-169 (command), 186-227 (parsing and cancel checks), 252-264 (_kill). CM/manga_manager.py:760-813."
    },
    {
      "claim": ".tablet_cache.json schema v2 is {version, device, tablet_root, scanned_at_unix, scan_duration_sec, file_count, dir_count, files[{p,s,m}], dirs[]}. It is validated by version, device, root and TTL, and written atomically. The current file is Komikku-named.",
      "evidence": "CM/compare_manga.py:143, 571-599, 602-625. The file header shows version 2, device 3CEF42502E91537, file_count 20007, dir_count 112, first entry 'Talentless Nana/Ch.001 - Chapter 1.cbz'. A targeted grep finds 19,574 of the 20,007 paths are 'Ch.NNN - …' (Komikku) and 0 match the old ' Ch N.pdf' form."
    },
    {
      "claim": "Integration points: the left-rail TABS array (settings last); Settings has a 'library' category (renderLibrary is defined at :2687 and registered at :2787); search IPC 'search:run'/'search:cancel', throttled by networkLimit, is exposed via preload; searcher.js is single-flight; KOMIKKU_CH_RE exists in library.js; library.js prefers cover.jpg.",
      "evidence": "AIO/UI-source/src/App.jsx:25-31. AIO/UI-source/src/components/SettingsTab.jsx:435-436, 2687, 2787. AIO/UI-source/electron/main.js:753-786 (throttle at :758-767). AIO/UI-source/electron/preload.js:98-99. AIO/UI-source/electron/searcher.js:38-78, 122-123, 255-258. AIO/UI-source/electron/library.js:148, 175, 728-735."
    },
    {
      "claim": "In-flight local work: branch fix/mangafire-cloudflare-challenge is ahead 1 of fork, with 36 modified tracked files (+6865/-831). These include LibraryTab.jsx (1058 lines changed), main.js (455), library.js (197), preload.js (56), search_orchestrator.py (86) and App.jsx (2): a prop swap from setLibraryEntries to updateCheck at App.jsx:181-184.",
      "evidence": "git status -sb shows '[ahead 1]'. git diff --stat reports '36 files changed, 6865 insertions(+), 831 deletions(-)'. git diff UI-source/src/App.jsx shows hunk @@ -181,7 +181,7."
    },
    {
      "claim": "Observed failure: Apply on the fixed webp_test delete got HTTP 400 from /api/transfer, and a later retry succeeded.",
      "evidence": "CM/.playwright-mcp/console-2026-05-11T15-29-30-010Z.log:1-2 logs the 400 and htmx's 'Response Status Error Code 400 from /api/transfer'. CM/.playwright-mcp/page-2026-05-11T15-30-18-464Z.yml:688-708 still shows the 'Confirm transfer.' modal with 'Apply transfer →' [active]; CM/_screens/dash-10-delete-done.png shows the same unchanged modal. The success is at page-2026-05-11T15-32-23-778Z.yml:688-702 ('[06:32:22 PM] ok webp_test · _pdftoppm_out-01.ppm')."
    },
    {
      "claim": "For a series not yet on the tablet, the new folder is tablet_root + '/' + sanitize_tablet_segment(canonical PC folder_name), which keeps any '(hid=X)' suffix. This is live today.",
      "evidence": "CM/manga_manager.py:557-566. sanitize only strips /\\:*?\"<>| and control characters (CM/manga_ops.py:44, 70-83). In the D:\\AIO\\manga listing, 6 series exist ONLY as hid folders: Bungo Stray Dogs (hid=PW1SJ) 137 ch; Daughter of the Spirit King (hid=9o8ym) 170; Fatestrange Fake (hid=9f7530e3-…) 22; JoJo's Bizarre Adventure Part 6 Stone Ocean (hid=t4U07) 158; Konosuba… (hid=gvHMj) 137; Sentenced to Be a Hero… (hid=sentenced-…) 10."
    }
  ],
  "refuted": [
    {
      "claim": "The Eleceed fixup is now handled by AIO's is_official tiebreak at sites/search_orchestrator.py:440-444.",
      "correction": "The conclusion holds but the citation is wrong. Line 444 is only the SourceEntry.is_official field. The tiebreak is in _cmp at search_orchestrator.py:6189-6201. It is gated by IS_OFFICIAL_REQUIRES_TITLE_MATCH=0.85 (:251) plus TIEBREAKER_WINDOW, and runs after the dmca/count_outlier sink check (:6185-6188). linewebtoon sets OFFICIAL_PUBLISHER=True (sites/linewebtoon.py:182), and the comment at :246-247 names the webtoons-vs-toonily case explicitly.",
      "evidence": "AIO/sites/search_orchestrator.py:238-251, 444, 6185-6201; AIO/sites/linewebtoon.py:182"
    },
    {
      "claim": "The preview 'silently skips pushes whose label is already on the tablet'.",
      "correction": "Only whole-series ('*') expansion skips those silently. For a single-chapter push of a label already on the tablet, _resolve_single returns None, and the caller lists it under 'Skipped (N)' with the misleading generic reason 'no push candidate for <label>'. The comment at :511 says 'skip silently', but the caller does report it.",
      "evidence": "CM/manga_manager.py:490-493, 503-513 (single path), 533-537 (expansion)"
    },
    {
      "claim": "The make_args Namespace fields (cookies, language/search_language, search_parallelism=6, search_timeout=8.0, search_min_match=0.55, auto_pick, search_json, seeded_only, multi_source=False, collapse_splits=True) are the batch's search options and should become user settings.",
      "correction": "These fields have no effect in batch_search. `args` only reaches _scraper_factory_for, which calls _build_scraper (reads cookies only) and handler.configure_session. No site handler reads the search_*, auto_pick, search_json, seeded_only, multi_source, collapse_splits or language attributes; the only field any configure_session reads is madara's comic_url. The real settings are the explicit search_all kwargs and the request factory (timeout 8.0, attempts 2). Routing through `aio-dl.py --search` would add run_search_mode behaviour that batch_search bypassed: probe_candidate_limit=2, fetch_memo, URL-seed mode, exclude_sites and diagnostics, plus ProbeFailureCache(record_cooldown=record_rate_limit), which gives a 1 h host suppression (the batch passed None). Results can therefore differ from the old batch.",
      "evidence": "CM/batch_search.py:144-161, 210-214, 228-240. AIO/aio_search_cli.py:276-313, 551-607. A grep of AIO/sites for args.<attr> or getattr(args,'<attr>') on those names finds nothing. AIO/sites/madara.py:723-725."
    }
  ],
  "missed": [
    {
      "item": "Server errors never reach the user. htmx 1.9 does not swap non-2xx responses, and app.js has no htmx:responseError handler. So the 400s ('payload.ops must be a list', 'no resolvable ops' with its skipped list), the 409 'busy' with active_transfer_id, the 404 from cancel, and the 500 from a failed adb scan on Refresh all leave the UI unchanged. The 'friendlier busy message' is never shown; after the observed 400 the user saw only an idle modal. The port must render errors explicitly.",
      "category": "failure_mode",
      "evidence": "CM/manga_manager.py:718-719, 766-769, 777-785, 812-813. CM/static/app.js:78-129, 229-236 has only change/afterSettle/beforeRequest/keydown listeners. hx-post without an error target: CM/templates/base.html:24-31, 50-55 and CM/templates/partials/confirm_modal.html:66-71. Proof: CM/.playwright-mcp/console-2026-05-11T15-29-30-010Z.log:1-2 together with page-2026-05-11T15-30-18-464Z.yml:688-708 and CM/_screens/dash-10-delete-done.png."
    },
    {
      "item": "The Apply button breaks for any op label containing an apostrophe. The confirm modal puts the resolved ops as {{ ops_json|safe }} inside a SINGLE-quoted hx-vals attribute, and json.dumps does not escape '. Delete ops for unlabelled tablet files use the raw filename as the label, so the first ' ends the attribute and truncates the js: expression. The live tablet has 684 Komikku filenames containing ', for example 'A Certain Scientific Railgun/Ch.042 - Rainbow's End.cbz', and every one is unlabelled under the 6 patterns. Any whole-series delete that includes one leaves a dead Apply button. Found by reading the code, not by running it. The port should pass ops as structured IPC data, never as string-built attributes.",
      "category": "failure_mode",
      "evidence": "CM/templates/partials/confirm_modal.html:71; CM/manga_manager.py:589 (filename used as label), 748-757 (ops_json). CM/compare_manga.py:71-103 has no Komikku pattern. A targeted grep of CM/.tablet_cache.json finds 684 'Ch.NNN - …' paths containing a straight apostrophe."
    },
    {
      "item": "Latent wrong-source push for series with several hid variants. _aggregate_pc_chapter_map keeps the LARGEST file per label across all variants. _make_push_op then builds pc_path from the CANONICAL variant's folder plus that file's name, ignoring ChapterFile.series_folder. If the chosen copy lives in a non-canonical variant, the push either fails with 'PC source not found' or silently pushes the canonical copy while reporting the larger byte count. It is latent today because the only multi-variant series, One Piece, has an empty second folder.",
      "category": "algorithm",
      "evidence": "CM/manga_manager.py:412-425, 554-556, 574. CM/compare_manga.py:155, 409-411 (series_folder is recorded per variant). CM/manga_ops.py:153-154. D:\\AIO\\manga listing: 'One Piece' has 1194 ch, 'One Piece (hid=one-piece.49)' has 0 ch."
    },
    {
      "item": "Aliased series are split in two, and the tablet copy is offered a one-click delete. The dashboard never reads ALIASES_TABLET_TO_PC, so each of its 14 pairs appears twice. The PC side is listed under 'Tablet missing', where 'Push all' would create a second tablet folder named after the PC folder. The tablet side is listed under 'Only on tablet', where 'Delete all' queues every file of the reader's copy. None of the 14 pairs normalize to the same key, e.g. 'Record of Ragnarok'↔'Shuumatsu no Valkyrie', 'SPY_x_FAMILY'↔'SPY×FAMILY', 'Fullmetal Alchemist'↔'FULL METAL ALCHEMIST', 'One-Punch_Man_(Official)'↔'One-Punch Man'. The port's matcher must apply the user alias map before classifying.",
      "category": "failure_mode",
      "evidence": "CM/push_all_to_tablet.py:74-92; CM/compare_manga.py:292-307, 762-793; CM/manga_manager.py:261-317 (side classification), 539-550; CM/templates/partials/_series_row.html:2-3."
    },
    {
      "item": "The Komikku state is worse than the census says. The tablet is now fully Komikku: 19,574 of 20,007 files are 'Ch.NNN - Title.cbz', 0 are old-style ' Ch N.pdf', and every series folder holds cover.jpg and details.json (111 of each). With the dashboard's parser, every shared series shows ALL of its PC chapters as missing. 'Push all' or 'Select all N to push' would copy duplicate content under different names next to the Komikku files; the never-overwrite guard can't catch it because the labels never match. 'Delete all' removes cover.jpg and details.json, which the sibling scripts deliberately keep because Komikku reads them. The tablet counters ('N on tab.', '<n> ch. on tablet') are file counts that include those sidecars.",
      "category": "failure_mode",
      "evidence": "Targeted greps of CM/.tablet_cache.json (counts above). CM/manga_manager.py:220, 307, 331, 402 (len(chapter_files) counts every file), 509-512, 533-537. CM/push_all_to_tablet.py:102-107 and CM/sync_to_tablet.py:99-102 keep cover.jpg and details.json for Komikku."
    },
    {
      "item": "The dashboard's naming rule for new tablet folders contradicts the sibling push script. The dashboard uses the raw canonical PC folder name: hid suffix kept, no alias. push_all_to_tablet uses sanitize(PC base name with the hid stripped). For aliased pairs it keeps the tablet's existing name (KEEP_TABLET_NAME_FOR_ALIASES=True, recorded as a user decision on 2026-05-24). The port needs one rule: default to the hid-stripped, sanitized name, overridable per series in the UI alias map.",
      "category": "algorithm",
      "evidence": "CM/manga_manager.py:557-566; CM/push_all_to_tablet.py:5, 94-100, 404, 469-471. Six live PC series exist only as hid-suffixed folders (see the D:\\AIO\\manga listing in confirmed)."
    },
    {
      "item": "The stale tablet listing defeats the never-overwrite rule and fakes delete success. Nothing updates .tablet_cache.json after a batch, and view rebuilds re-read it for up to 24 h. Chapters just pushed stay 'missing', can be selected and pushed again, and adb push silently overwrites the same-named file. Files just deleted stay listed, and deleting them again reports 'ok' because rm -f exits 0 when the file is missing.",
      "category": "failure_mode",
      "evidence": "CM/manga_manager.py:155-170, 509-512, 533-537; CM/compare_manga.py:639-645; CM/manga_ops.py:274-287; CM/static/app.js:170-181."
    },
    {
      "item": "The progress modal can get stuck with no way out. It closes only after a terminal SSE event: × stays disabled until finish() runs, and Esc is ignored mid-transfer. EventSource reconnects on its own because onerror does nothing. After a server restart, iter_events returns immediately for the unknown id, giving an empty 200 stream and an endless reconnect loop. If a reconnect happens after the terminal event or sentinel was already consumed, the generator sends heartbeats forever on the empty queue. All connections share one queue, so a zombie connection can steal events. Only a page reload escapes. Found by reading the code, not by running it.",
      "category": "failure_mode",
      "evidence": "CM/transfer_runner.py:130-155, 236-242; CM/static/app.js:170-181, 221-224, 229-235; CM/templates/partials/progress_modal.html:8-10; CM/manga_manager.py:795-808."
    },
    {
      "item": "Cancel and stall handling in push_chapter is weak. The cancel flag is checked only after proc.stdout.read(256) returns, and adb push has no timeout. A stalled push (cable pulled, device asleep) therefore blocks the worker indefinitely, and Cancel does nothing. Separately, when no SSE client is connected, once 4,096 events have queued every non-progress event blocks for up to 30 s, so the batch slows to a crawl.",
      "category": "failure_mode",
      "evidence": "CM/manga_ops.py:174-198, 225-227 (Popen with no timeout); CM/transfer_runner.py:64, 161-178."
    },
    {
      "item": "Scans run synchronously inside ordinary requests, under a global lock. _get_comparison holds an RLock while it rebuilds. When the 120 s view is stale and the 24 h cache has expired, ANY request (page load, series click, cover image, preview, apply) runs the adb find inline, with a 180 s timeout or 600 s for the stat fallback, and blocks every other route. An adb failure raises RuntimeError, which becomes an HTTP 500 that htmx discards without showing it. The port needs an async scan with progress and error state.",
      "category": "failure_mode",
      "evidence": "CM/manga_manager.py:155-170, 173-180, 695, 705, 714, 762, 827; CM/compare_manga.py:536-549, 561-565, 639-645."
    },
    {
      "item": "The header's 'tablet-pulse' dot is decoration, not a connection check. It is a static span with an infinite CSS animation. The device is resolved once at startup and never re-checked. With a valid cache, the dashboard keeps showing tablet state and offering pushes/deletes while the tablet is unplugged; the problem only shows up as per-file adb errors and the abort-after-3 rule.",
      "category": "other",
      "evidence": "CM/templates/base.html:20; CM/static/styles.css:153-158, 1108; CM/manga_manager.py:913-917, 922-923; CM/transfer_runner.py:225-232."
    },
    {
      "item": "A 0-chapter PC-only folder is listed under 'Only on tablet' as '0 files · 0 B'. Its 'Delete all' checkbox resolves to nothing (Skipped: 'no chapters available for this op'). Its detail card recomputes the side as tablet_missing and says '<folder> · not on tablet', contradicting the list.",
      "category": "feature",
      "evidence": "CM/manga_manager.py:261-284, 379-383, 539-541; CM/templates/partials/_series_row.html:2-3, 42-45; CM/templates/partials/series_detail.html:10-11."
    },
    {
      "item": "Duplicate labels on the tablet collapse into one. If two depth-1 files parse to the same label (e.g. 'X Ch 5.pdf' and 'X Ch 5.cbz'): the chapter table shows only the first, a single delete removes only the first match, and whole-series expansion dedupes on op|series|label, so the second file is dropped from the batch. The confirm list shows 'no. <label>' rather than the filename, so the user can't see which file will go.",
      "category": "failure_mode",
      "evidence": "CM/manga_manager.py:428-437, 480-484, 521-525, 730-733; CM/templates/partials/confirm_modal.html:44, 51."
    },
    {
      "item": "The census's list of in-flight local work is incomplete. Missing untracked files: UI-source/src/hooks/useUpdateCheck.js (the uncommitted App.jsx prop updateCheck={dl.updateCheck} and the modified LibraryTab.jsx/UpdatesCenter.jsx depend on it), sites/profile_lock.py, tests/test_series_folder_identity.py, tests/test_profile_lock.py, tests/test_fast_download_timeouts.py, tests/test_android_repair.py, plus Android Kotlin files and wheels. There are also 4 Claude agent worktrees under .claude/worktrees with their own uncommitted changes: agent-a4c28bab5f3ff5c7f (12 entries), agent-a70ab5579168503df (5), agent-ae93ca7458b4792cd (6), agent-aef9367a777af1246 (6). A detached 'scratchpad/baseline' worktree also exists; all are at d1ae7d6. Do not prune, reset or stash any of them.",
      "category": "integration_point",
      "evidence": "git status --short (AIO); git worktree list; git -C <worktree> status --short for each; AIO/UI-source/src/components/LibraryTab.jsx:34, 1545-1548; AIO/UI-source/src/components/UpdatesCenter.jsx:9."
    },
    {
      "item": "AIO already has a per-series chapter skip list and chapter-label helpers the port should reuse. The in-flight set-chapters-ignored IPC writes .aio_series.json:chapters_ignored, and the update check honours it. The dashboard's .aio_series.json reader ignores that key, so ignored chapters would still show as 'to push'. The label helpers chapterLabel and compareChapterLabels live in the UNTRACKED series-merge.js and are already used by main.js; reuse them instead of porting compare_manga's _canonicalize_label and chapter_label_sort_key.",
      "category": "integration_point",
      "evidence": "AIO/UI-source/electron/main.js:1327-1330, 1699-1745; AIO/UI-source/electron/series-merge.js:76-83, 302; AIO/UI-source/electron/preload.js:167; CM/compare_manga.py:366-381."
    },
    {
      "item": "Batch search: concurrency and browser warm-up. batch_search deliberately looped in ONE process so all 64 queries shared the MangaFire Playwright session and caches. Spawning `aio-dl.py --search` per query pays browser warm-up every time. The new untracked sites/profile_lock.py makes processes WAIT for the shared Chromium profile, and the library update sweep runs up to 8 concurrent aio-dl.py processes. A batch 'find sources' run must therefore be serialized (searcher.js is single-flight) and will contend with the update sweep.",
      "category": "integration_point",
      "evidence": "CM/batch_search.py:4-6, 56-61; AIO/sites/profile_lock.py:9-27 (header comment); AIO/UI-source/electron/searcher.js:122-123."
    },
    {
      "item": "Pinned-URL overrides can't go through --search. run_search_mode's URL-seed mode accepts only mangafire.to and comix.to URLs. A pinned webtoons.com URL like SHELTER's must be stored as a per-series direct URL and queued as a normal download, not searched.",
      "category": "integration_point",
      "evidence": "AIO/aio_search_cli.py:82-85 (_URL_SEED_HOSTS), 537-549; CM/fixup_seed_links.py:45-62."
    },
    {
      "item": "manga_ops is shared with another area: push_all_to_tablet.py imports sanitize_tablet_segment from it. The path-safety and sanitize layer serves both the dashboard and the bulk push, so port it once.",
      "category": "integration_point",
      "evidence": "CM/push_all_to_tablet.py:36, 60, 469-471; CM/manga_ops.py:70-107."
    },
    {
      "item": "Two adb round trips per chapter. Every push op runs its own `adb shell mkdir -p` and then its own `adb push`, so a whole-series push of One Piece means 1,197 mkdirs. The sibling sync batches up to 50 files or 12,000 argument characters per `adb push f1 … dest/`, staying under the Windows 32 KB command-line limit.",
      "category": "algorithm",
      "evidence": "CM/transfer_runner.py:266-279; CM/sync_to_tablet.py:112-117."
    },
    {
      "item": "Cover-cache details the census omits: SeriesRow.has_cover is computed but never used, since the detail card always requests /api/cover. Cached covers are keyed by norm_key and never invalidated. Every cached cover is served as image/jpeg, whatever its real type.",
      "category": "other",
      "evidence": "CM/manga_manager.py:105, 283, 340, 607-609, 835-848; CM/templates/partials/series_detail.html:32."
    }
  ],
  "notes": "Path prefixes: CM = C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga; AIO = C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\AIO-Webtoon-Downloader.\n\nI read every assigned file in full: manga_manager.py (945 lines), manga_ops.py (368), static/app.js (237), batch_search.py (284), fixup_seed_links.py (117), render_seed_links.py (105), and all 8 templates. I also read transfer_runner.py and the parts of compare_manga.py the census cites. Everything was read-only. adb and the scripts were never run. The large data files were only grepped, never dumped.\n\nOverall the census is accurate. Its features, CLI flags, hard-code tables and the full 64-entry SERIES list all check out. The real gaps are:\n1. Errors are invisible in the old UI (htmx drops non-2xx responses). The observed 400 proves it.\n2. The apostrophe break in the confirm modal's Apply button, live against 684 Komikku filenames.\n3. The latent hid-variant source-path bug in _make_push_op.\n4. The dangerous interaction with ALIASES_TABLET_TO_PC: aliased series show up as tablet-only with a 'Delete all' offered.\n5. The tablet is now 100% Komikku-named, so the dashboard's gap logic is effectively broken: every PC chapter shows as missing, and whole-series deletes would remove cover.jpg/details.json.\n6. More in-flight local state than the census listed: useUpdateCheck.js, profile_lock.py, and 4 agent worktrees with their own uncommitted changes.\n\nUnverified risk (adb was not run): manga_ops assumes adb prints '[ NN%]' lines when stdout is a pipe (manga_ops.py:35-38, 157-162). If adb only prints them to a TTY, the per-file bar would jump straight to the synthetic 100% (manga_manager-side fallback at manga_ops.py:244-249). The port's progress design should be checked against real adb output before relying on it.\n\nSmall documentation drift: the manga_ops docstring still says 'adb push --progress' (manga_ops.py:11, 142). render_seed_links claims to use the same order as batch_search (render_seed_links.py:31-33), but batch_search iterates the SERIES list in ASCII order (batch_search.py:121-123: 'SHELTER', 'SPY_x_FAMILY', 'Sakamoto Days'), not casefold order."
}
```
