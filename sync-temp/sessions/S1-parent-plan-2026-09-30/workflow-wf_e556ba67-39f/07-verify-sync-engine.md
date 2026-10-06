# Workflow wf_e556ba67-39f — verify:sync-engine (phase Verify)

```json
{
  "area": "sync-engine",
  "confirmed": [
    {
      "claim": "The alias table is complete: ALIASES_TABLET_TO_PC has exactly 14 tablet->PC entries, and all 14 values match the census list. sync_to_tablet inverts it (PC->tablet) and uses it only for naming.",
      "evidence": "CompareManga/push_all_to_tablet.py:74-92 (14 keys, values verbatim); sync_to_tablet.py:108-110, 226-227. Only 3 lines contain non-ASCII: tablet keys 'CØDEBREAKER' (77) and 'Makeine Make Hiroin ga Ōsugiru!' (86), and PC value 'SPY×FAMILY' (90). The JoJo apostrophes are ASCII 0x27 (od dump of lines 82 and 84)."
    },
    {
      "claim": "Naming policy is alias (KEEP_TABLET_NAME_FOR_ALIASES=True), then hid strip, then sanitize. Sanitize = NFKC, drop / \\ : * ? \" < > | and control chars, rstrip ' .', and reject '', '.' and '..'.",
      "evidence": "CompareManga/push_all_to_tablet.py:100, 404-406; sync_to_tablet.py:219-228; manga_ops.py:44, 70-83; compare_manga.py:107 (RE_HID_SUFFIX)."
    },
    {
      "claim": "sync CLI flags and defaults are complete as listed: 14 flags; --workers 8 (min 1); --pc-cache <script>/.pc_hash_cache.json; --state <script>/.sync_state-<device>.json; --log <script>/sync-log-%Y%m%d-%H%M%S.json. push_all (8 flags) and _watch_progress (5 flags) are also complete.",
      "evidence": "CompareManga/sync_to_tablet.py:1005-1033, 487-488, 1054, 1067, 1114; push_all_to_tablet.py:832-852; _watch_progress.py:44-48. Nuance: args.plan is parsed but never read in either main (sync 1037-1121, push_all 856-926), so --plan --apply still applies."
    },
    {
      "claim": "Change-detection contract: a file is 'good' iff the tablet listing size == PC size AND the journal sha256 == the fresh PC sha256. mtime is never used.",
      "evidence": "CompareManga/sync_to_tablet.py:586-596, 539-544."
    },
    {
      "claim": "Delete set = (journal keys under target/) UNION (live tablet keys under target/), depth-1 only, minus the desired names. Deletes run before pushes as a single rm -f call and never use -rf.",
      "evidence": "CompareManga/sync_to_tablet.py:598-612, 815-822, 394-403."
    },
    {
      "claim": "Orphaned vs preserved is decided by journal membership. Prune (rm -rf, 600 s timeout) requires BOTH --apply and --prune, and the confirmation line includes 'PRUNE N folder(s)'.",
      "evidence": "CompareManga/sync_to_tablet.py:617-634, 406-410, 876-887, 1100, 1107, 1117-1119."
    },
    {
      "claim": "Push routing and batching: files whose whole source path is ASCII go in batches capped at 50 files / 12,000 source-path chars into a pre-created dest_dir/. Any non-ASCII source path is pushed alone to an explicit dest_dir/<name>. Timeout = max(180, bytes/4e6 + 120) s.",
      "evidence": "CompareManga/sync_to_tablet.py:116-117, 417-479, 805, 833-856, 437, 456."
    },
    {
      "claim": "The journal schema and atomic flush match the live file. load_state validates only 'is a dict with files'; version, device and tablet_root are not checked.",
      "evidence": "Live head of CompareManga/.sync_state-A06B4A372090333.json: {\"version\": 1, \"device\": \"A06B4A372090333\", \"tablet_root\": \"/storage/self/primary/Documents\", \"files\": {\"'Tis Time for Torture, Princess/Ch.001 - Torture 1.cbz\": {\"size\": 7332980, \"sha256\": ...}}; tail ...\"updated_at_iso\": \"2026-07-15T02:37:40.568958\"}. Writer: sync_to_tablet.py:508-513 (tmp + os.replace). Flushes at 822, 843, 767, 885. Loader at 491-505."
    },
    {
      "claim": "PC hash cache schema is {entries: {abs path: {size, mtime, sha256}}}. --fast reuses an entry only on an exact size+mtime match, and the cache is always saved.",
      "evidence": "Live head of CompareManga/.pc_hash_cache.json: {\"entries\": {\"D:\\\\AIO\\\\manga\\\\'Tis Time for Torture, Princess\\\\Ch.001 - Torture 1.cbz\": {\"size\": 7332980, \"mtime\": 1782147052.985332, \"sha256\": ...}}}. Code: sync_to_tablet.py:244-259, 282-288, 303-305, 1069."
    },
    {
      "claim": "Exit codes and typed confirmation for sync and push_all are as described (sync 0/2/3; push_all 0/1/2/3; 'yes'/'y').",
      "evidence": "CompareManga/sync_to_tablet.py:1043-1051, 1074-1078, 1100-1112, 1121; push_all_to_tablet.py:862-875, 902-904, 910-918, 926."
    },
    {
      "claim": "transfer_runner behavior is confirmed as described: error_budget 3, global 'busy' interlock, the listed event vocabulary, 0.2 s throttle (100% always passes), queue 4096, heartbeat 15 s, 30 s blocking emit, last 3 errors, cancel during a failure reported as batch_cancelled. manga_manager uses the default budget and serves 409 busy, SSE and cancel routes.",
      "evidence": "CompareManga/transfer_runner.py:64, 71-77, 91, 99-102, 130, 161-178, 192-234, 256-264; manga_manager.py:760-813 (start_transfer at 771-776 has no error_budget override; 409 at 778-785)."
    },
    {
      "claim": "compare_manga constants and resolution order: DEFAULT_PC_ROOT D:\\AIO\\manga, DEFAULT_TABLET_ROOT /storage/self/primary/Documents, DEFAULT_DEVICE_SERIAL 3CEF42502E91537, KNOWN_ADB_PATH Scripts\\ADB\\platform-tools\\adb.exe, IGNORE_TOP_LEVEL, IGNORE_SERIES_FILES. adb: override, then PATH, then KNOWN_ADB_PATH. Device: override must be connected, else the single device, else the default serial, else an error.",
      "evidence": "CompareManga/compare_manga.py:55-58, 64, 66, 444-489."
    },
    {
      "claim": "The observed-failure evidence checks out: SPY×FAMILY mv failure (May); USB drop giving 9 ok / 107 failed (Bleach EOF plus 106 'device not found'); --verify planning 434 pushes / 434 deletes over 3 series; interrupted run with 131 deleted, 1 pushed, error null; repair run with 433 pushed / 303 deleted; Nano Machine 320 pushed / 318 deleted; full mirror 111 ok in 104.7 min; 15 chapter-loss series, worst -372.",
      "evidence": "CompareManga/transfer-log-20260524-015607.json:735-744; push_run.log:570-575; sync-log-20260706-221724.json (n_ok 9, n_fail 107; Bleach error at 92-98; grep -c 'not found' = 106); synclogs07.md:1643-1649; sync-log-20260707-013414.json; sync-log-20260707-013548.json; sync-log-20260709-015153.json; full_mirror_stderr.log (last lines); full-mirror-log.json n_ok 111; push_run.log:104-120."
    },
    {
      "claim": "manga_manager selective ops: push never overwrites (skips labels already on the tablet); delete matches by label or filename and skips nested paths; a new tablet folder = sanitize(canonical PC folder, INCLUDING the hid suffix, no alias).",
      "evidence": "CompareManga/manga_manager.py:503-527, 530-551, 554-566."
    },
    {
      "claim": "AIO-side facts hold. Branch fix/mangafire-cloudflare-challenge is 1 ahead / 0 behind at d1ae7d6. The desktop app has no adb code (\\badb\\b hits only android/ docs and Kotlin). series-merge.js explains the MangaDex retitle fork and defines PAYLOAD_EXTS / SINGLETON_FILES / METADATA_FILES. The cited AIO constants are at the stated lines. CompareManga is not a git repo.",
      "evidence": "git branch/rev-list/log in AIO; Grep \\badb\\b in AIO (excluding node_modules): 7 files, all under android/; AIO/UI-source/electron/series-merge.js:4-10, 44-68; AIO/aio_config.py:9-10; AIO/aio-dl.py:542, 952, 936, 949, 1036, 8355; AIO/UI-source/electron/downloader.js:393-395; AIO/UI-source/electron/library.js:735, 1118 (exports seriesIdentityKey, normalizeSeriesUrl, extractChaptersFromFiles); 'git rev-parse' in CompareManga -> 'fatal: not a git repository'."
    }
  ],
  "refuted": [
    {
      "claim": "sync --verify safety rail: 'Only after that folder's hash succeeds (a failure skips it and leaves entries intact, 758-762)'.",
      "correction": "Only EXCEPTIONS (timeout, path validation) take the skip path. hash_tablet_folder ignores adb's return code and stderr, and the device command runs with 2>/dev/null. So a device drop, offline/unauthorized state, or a failing find/sha256sum returns an empty or partial dict without raising. verify_rebuild_state then pops EVERY journal entry for that folder and flushes. A USB drop mid-verify silently empties the journal for all remaining folders, and the next apply re-pushes them in full.",
      "evidence": "CompareManga/sync_to_tablet.py:369-373 (rc and err unused), 758-767; push_all_to_tablet.py:176-183 and 234-235 (adb_shell returns rc and never raises on rc != 0)."
    },
    {
      "claim": "Preserved side-loaded folder example / hard-code: 'SHELTER (the one side-loaded, tablet-only series)' is PRESERVED and never touched; verify_push asserts it survives.",
      "correction": "This is outdated. SHELTER now has a PC source, and the sync engine treats it as MANAGED and JOURNALED, not preserved. If its PC folder disappears it becomes ORPHANED, and --prune would rm -rf it. verify_push's hard-coded SHELTER check is obsolete, and SHELTER in sync's self-test is only a synthetic fixture. An explicit preserve list is not what currently protects it.",
      "evidence": "D:\\AIO\\manga listing, entry 91 of 134 = 'SHELTER'; CompareManga/synclogs07.md:1635-1636 ('Verifying (hashing) 117 managed tablet folder(s)', '[88/117] SHELTER'), 1643, 1649 ('Folders preserved: 0'); .sync_state-A06B4A372090333.json holds 218 '\"SHELTER/...' keys; sync_to_tablet.py:617-627, 969-975; verify_push.py:128-135."
    },
    {
      "claim": "One-round-trip tablet enumeration 'falls back to -exec stat -c ... when -printf is unsupported' (and the lesson 'keep a stat fallback').",
      "correction": "As written, the fallback can never trigger. Both remote find commands end in 2>/dev/null, so find's -printf error never reaches the adb stderr that the detection inspects. On a device without -printf, stdout still holds the dir list plus the sentinel (non-empty), so no error is raised and the result is folders with ZERO files. For sync that means every file is 'not good' (full re-push), and deletes are driven by the journal alone. The stat fallback also never checks rc.",
      "evidence": "CompareManga/compare_manga.py:530-534 (2>/dev/null), 543 (stderr text match), 546-551, 554-568; consumed by sync_to_tablet.py:339-357."
    },
    {
      "claim": "Hard-code 'Other adb timeouts' — purpose: 'Bound every adb call'.",
      "correction": "Not every call is bounded. (1) Streamed pushes check the deadline only between blocking p.stdout.read(1024) calls, so an adb that hangs without output is never killed. This covers every sync push_batch/push_explicit and the push_all folder push. (2) manga_ops.push_chapter has no timeout at all and checks cancel only after a read returns, so a silent hang cannot even be cancelled. (3) _verify_chapters' adb calls have no timeout.",
      "evidence": "CompareManga/push_all_to_tablet.py:186-205; sync_to_tablet.py:438, 457; manga_ops.py:174-198, 225-227; _verify_chapters.py:24-25."
    },
    {
      "claim": "Alias validation: 'At plan time, an alias pointing to a non-existent PC folder is an alias error that ... aborts apply (exit 1)'.",
      "correction": "(1) push_all checks only aliases whose tablet-side KEY currently exists as a tablet folder, so a stale alias whose tablet folder is absent is never flagged at plan time; only --self-test checks all 14. (2) Alias errors exit 1 even in plan mode, because the check runs before the apply check. (3) They abort even when --only/--skip excludes the affected series. (4) sync_to_tablet never validates aliases at runtime: a stale alias is silently inert.",
      "evidence": "CompareManga/push_all_to_tablet.py:435-441, 804-819, 892-898, 902-904 vs 906; sync_to_tablet.py:226-227, 940-942."
    },
    {
      "claim": "Exit-code contract: 'verify_push: 0 all good, 1 discrepancies'.",
      "correction": "Exit 1 happens only when no transfer-log is found, SHELTER is missing, the log contains failures, or expected targets are MISSING. CHAPTER COUNT MISMATCHES and EXTRA ON TABLET are printed but never fail. alias_errors from the fresh plan are computed and ignored.",
      "evidence": "CompareManga/verify_push.py:40-42, 75, 85-98, 120-126, 128-142."
    },
    {
      "claim": "Integration note listing the uncommitted AIO work (main.js, preload.js, library.js, downloader.js, App.jsx, LibraryTab.jsx, utils.js, aio-dl.py, library_state.py; untracked series-merge.js, update-check-record.js, ChapterChips.jsx).",
      "correction": "The list is incomplete. Relevant to the tab and IPC work, git status also shows modified UI-source/src/components/UpdatesCenter.jsx, UI-source/src/hooks/useDownloader.js and UI-source/src/lib/downloadArgs.js, plus untracked UI-source/src/hooks/useUpdateCheck.js. Also modified: .github/workflows/release.yml, aio_android.py, sites/{base,browser_identity,comix,mangafire_vrf,search_orchestrator}.py, tests/* and android/*. Also untracked: sites/profile_lock.py, tests/test_series_folder_identity.py, tests/test_profile_lock.py, tests/test_fast_download_timeouts.py, tests/test_android_repair.py, .github/workflows/android.yml, and Android Kotlin files and wheels. The branch and the 1 unpushed commit (d1ae7d6) are correct.",
      "evidence": "`git status --short` and `git rev-list --left-right --count @{u}...HEAD` (0 1) in AIO."
    }
  ],
  "missed": [
    {
      "item": "Deletes are unbounded in one command line. rm_files sends ALL of a series' deletes in ONE `adb shell rm -f ...` with no chunking. Pushes, by contrast, are capped at 12,000 chars because of the Windows 32 KB CreateProcess limit. A mass rename in a long series (~1,000+ chapters) would exceed 32,767 chars and fail with WinError 206. Because deletes run before pushes, that series would fail on every run. The port must chunk deletes.",
      "category": "failure_mode",
      "evidence": "CompareManga/sync_to_tablet.py:394-403, 816-818 vs 112-117. Observed: 318 deletes in one series (sync-log-20260709-015153.json, Nano Machine)."
    },
    {
      "item": "PC hashing has no per-file error handling. Any exception in sha256_file (a file deleted or renamed between scan and hash, or a lock) propagates out of ex.map, and main does not catch it. The run dies with a traceback before save_pc_cache, so all hashing work is lost.",
      "category": "failure_mode",
      "evidence": "CompareManga/sync_to_tablet.py:296-307, 1065-1069."
    },
    {
      "item": "Emptying a PC series folder never clears its tablet folder. Empty PC folders are skipped from planning, but their target still counts as 'current' in all_targets_full, so the tablet folder is neither updated nor orphaned and its files stay forever. PDF/EPUB-only PC folders also count as 'empty' (only .cbz/cover.jpg/details.json are content) and are never synced, only warned about.",
      "category": "feature",
      "evidence": "CompareManga/sync_to_tablet.py:558-560, 625, 168-173."
    },
    {
      "item": "--prune ignores --only/--skip. 'orphaned' is computed from the full PC set and prune runs over every orphan, so `--apply --prune --only X` removes ALL orphaned folders on the device. A per-series sync in the UI must not implicitly prune others.",
      "category": "algorithm",
      "evidence": "CompareManga/sync_to_tablet.py:625-627, 1100, 1117-1119."
    },
    {
      "item": "Plan mode is not side-effect free. .pc_hash_cache.json is rewritten on every run, and --verify rewrites the journal even without --apply. A UI 'preview' that includes verify mutates local state.",
      "category": "other",
      "evidence": "CompareManga/sync_to_tablet.py:1069, 1080-1086, 767."
    },
    {
      "item": "Prune is not recorded in the per-run JSON log. prune_orphans writes only stderr and the journal, and _save_log is called only from apply_plan's per-series finally. With --prune and no plans, apply_plan prints 'Log: <path>' but writes no file. Prune failures are swallowed and do not affect the exit code.",
      "category": "state_file",
      "evidence": "CompareManga/sync_to_tablet.py:876-887, 862-865, 869-872, 1121."
    },
    {
      "item": "The run log has no planned-total or finished/cancelled marker, and completed_at_iso is rewritten after every series. A killed run is therefore indistinguishable from a smaller clean run. Example: sync-log-20260715-021752.json reports n_ok 6, n_fail 0, but a 0-byte .tmp at 02:18 shows the process died mid-rewrite, and a 27-series run followed at 02:20.",
      "category": "state_file",
      "evidence": "CompareManga/sync_to_tablet.py:890-904; sync-log-20260715-021752.json; sync-log-20260715-021752.json.tmp (0 bytes); sync-log-20260715-022050.json:2-7."
    },
    {
      "item": "The journal is keyed by device serial only, and load_state ignores the stored tablet_root. If the tablet root changes (e.g. a Komikku folder), journal-derived orphans and deletes resolve under the NEW root, so --prune could rm -rf an unrelated same-named folder there. The port should key the journal by (serial, root) and validate it on load.",
      "category": "failure_mode",
      "evidence": "CompareManga/sync_to_tablet.py:487-505, 617-627, 876-887."
    },
    {
      "item": "push_all mirrors EVERYTHING in the PC folder, recursively: all file types, nested subfolders, .cover.webp, download_params.json, and so on. It strips only 3 sidecars afterwards. sync mirrors only depth-1 .cbz/cover.jpg/details.json, so the two engines disagree on what gets mirrored. sync never sees nested content such as AIO image-folder chapters.",
      "category": "feature",
      "evidence": "CompareManga/push_all_to_tablet.py:375-396, 363-372; canary_stderr.log:8 ('133 files pushed' for 129 ch), :14 ('156 files pushed' for 151 ch); sync_to_tablet.py:176-216, 168-173; AIO/UI-source/electron/library.js:1118 (getImageChaptersOnDevice); series-merge.js:44-50."
    },
    {
      "item": "A stale docstring promises an explicit TABLET_PRESERVE list, but no such constant exists anywhere in CompareManga. Preservation is purely implicit. The UI likely needs an explicit, user-managed preserve/exclude list.",
      "category": "hardcode",
      "evidence": "CompareManga/push_all_to_tablet.py:13-15; grep TABLET_PRESERVE across CompareManga finds only this docstring."
    },
    {
      "item": "Neither engine has a --pc-root, --tablet-root or --adb flag. Roots are module constants captured at import, and both call cm.resolve_adb(None), even though resolve_adb's error text tells the user to 'Pass --adb'. TABLET_ROOT also differs: sync rstrips '/', push_all does not.",
      "category": "flag",
      "evidence": "CompareManga/sync_to_tablet.py:86-87, 1000-1034, 1044; push_all_to_tablet.py:109-110, 161, 827-853; compare_manga.py:51-54, 454-457."
    },
    {
      "item": "Alias edge cases. (a) sync looks up aliases by the RAW PC folder name including any hid suffix, so 'SPY×FAMILY (hid=x)' misses the alias and lands as 'SPY×FAMILY' beside 'SPY_x_FAMILY', with no collision warning because the targets differ. (b) push_all's 'keep tablet name' uses matched[0], the alphabetically first matched tablet folder, which is not necessarily the aliased one.",
      "category": "algorithm",
      "evidence": "CompareManga/sync_to_tablet.py:226, 549-573; push_all_to_tablet.py:460-469."
    },
    {
      "item": "The losing hid variant's unique chapters are never mirrored. push_all pushes only rank_hid_variants()[0] (ranked by chapter count, then valid JSON, then name), and sync keeps only the collision winner. Neither merges variants; AIO's series-merge.js is the existing tool for that.",
      "category": "algorithm",
      "evidence": "CompareManga/push_all_to_tablet.py:456, 727-729; compare_manga.py:850-856; sync_to_tablet.py:549-573."
    },
    {
      "item": "transfer_runner back-pressure. If the SSE consumer detaches, the transfer keeps running but the 4096-slot queue fills. Progress events are dropped, while every file_start/file_done blocks up to 30 s, adding about 60 s per remaining file.",
      "category": "failure_mode",
      "evidence": "CompareManga/transfer_runner.py:64, 136-137, 161-178, 203-216."
    },
    {
      "item": "Selective transfers (manga_manager/transfer_runner/manga_ops) never update the sync journal. A chapter pushed selectively has no journal entry, so the next sync treats it as not good and re-pushes it. The port needs one journal shared by bulk sync and per-chapter ops.",
      "category": "integration_point",
      "evidence": "No 'sync_state' references in CompareManga/manga_manager.py, manga_ops.py, transfer_runner.py or compare_manga.py (grep); sync_to_tablet.py:589-596."
    },
    {
      "item": "Bug in the selective-push source path. _aggregate_pc_chapter_map unions labels across ALL hid variants and keeps the larger file, but _make_push_op always builds pc_path from the CANONICAL variant's folder. A chapter that exists only in (or is larger in) a non-canonical variant gets a missing or wrong source: push_chapter raises 'PC source not found', or the canonical copy is pushed instead.",
      "category": "failure_mode",
      "evidence": "CompareManga/manga_manager.py:412-425, 554-556; manga_ops.py:153-154."
    },
    {
      "item": "AIO's own --komikku mode produces exactly the layout sync mirrors: per-chapter 'Vol.{vv} Ch.{ccc} - {title}.cbz' plus details.json and cover.jpg at the series root. It has a UI toggle and default and maps to the --komikku CLI flag. So the mirrored-type set is really 'AIO Komikku output', and PDF-format series are invisible to sync. The census frames Komikku only as the reader.",
      "category": "integration_point",
      "evidence": "AIO/aio-dl.py:4702-4716, 4958-4959, 5309-5326; AIO/UI-source/src/components/DownloadTab.jsx:121-126, 645-684; SettingsTab.jsx:361 (defaults.komikku false); electron/downloader.js:159-166."
    },
    {
      "item": "A second adb install exists at %LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe, besides the hard-coded Scripts\\ADB\\platform-tools\\adb.exe. The July runs resolved adb through PATH (the 'adb.EXE' casing comes from shutil.which), so PATH already contains the Scripts\\ADB folder. Autodetect should cover PATH, the SDK path and a user override.",
      "category": "integration_point",
      "evidence": "AIO/android/TESTING.md:37; CompareManga/compare_manga.py:58, 449-453; synclogs07.md:1628."
    },
    {
      "item": "resolve_device keeps only serials in state 'device'. 'unauthorized' (RSA prompt not accepted) and 'offline' devices are silently dropped, which gives a misleading 'No devices connected' or picks another device. The UI should surface these states.",
      "category": "failure_mode",
      "evidence": "CompareManga/compare_manga.py:468-474, 481-486."
    },
    {
      "item": "Resume granularity is a batch of up to 50 files, not a file. A batch is journaled only when push_batch returns cleanly, but adb prints per-file 'failed to read copy response: EOF' lines and keeps going before exiting rc=1. The files it did write in a failed batch go unjournaled and are re-pushed. The port could parse per-file results.",
      "category": "failure_mode",
      "evidence": "CompareManga/sync_to_tablet.py:851-853, 438-440; sync-log-20260706-221724.json:92-98 (Bleach: 600 journaled, then a batch tail full of interleaved EOF / '1 file pushed' lines, rc=1)."
    },
    {
      "item": "verify_push works only for push_all. It globs transfer-log-*.json, reads r['series'] (sync logs are named sync-log-* and have no 'series' key), and rebuilds expectations from push_all.build_plan. The current sync engine has no post-apply verifier other than re-running --verify.",
      "category": "feature",
      "evidence": "CompareManga/verify_push.py:29-35, 56, 75; sync_to_tablet.py:890-904."
    },
    {
      "item": "Sync-adjacent pre-flight tool missing from the census: _scan_pc_repack.ps1, a read-only diagnostic with D:\\AIO\\manga hard-coded that writes _pc_repack.json and is 'used to decide full-remirror vs metadata-only sync'. Its output shows every CBZ rewritten at 2026-06-14 21:48, i.e. a library repack right before the 22:59 full mirror.",
      "category": "other",
      "evidence": "CompareManga/_scan_pc_repack.ps1:1-6, 32; _pc_repack.json head (cbz_mtime_max 2026-06-14T21:48); full-mirror-log.json:3 (started 2026-06-14T22:59:50)."
    }
  ],
  "notes": "Legend: 'CompareManga/' means C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga (not a git repo). 'AIO/' means C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\AIO-Webtoon-Downloader.\n\nMethod: all six assigned files were re-read in full (sync_to_tablet.py 1125 lines, push_all_to_tablet.py 930, transfer_runner.py 294, verify_push.py 146, _verify_chapters.py 68, _watch_progress.py 69). I also re-read the dependencies the census relies on: manga_ops.py in full, compare_manga.py lines 40-119 and 440-634, and manga_manager.py lines 412-600 and 758-817. Nothing was executed except read-only listings, greps, heads and git status. No adb commands were run.\n\nOverall the census is accurate and thorough. The 14-entry alias table is complete and verbatim, and every CLI flag of every assigned script is accounted for.\n\nHighest-impact corrections for the planner:\n(1) A device drop during --verify silently wipes journal entries, because hash_tablet_folder ignores the adb rc.\n(2) SHELTER is no longer tablet-only. It is a managed, journaled PC series, and removing its PC folder would make it prune-able.\n(3) The -printf/stat fallback in the tablet listing is dead code.\n(4) Streamed adb pushes have no effective timeout on a silent hang.\n(5) The per-series rm -f command is unbounded and will hit the Windows 32 KB command-line limit on mass renames.\n(6) --prune ignores --only.\n(7) The journal is keyed by serial only, with tablet_root unchecked.\n(8) Bulk sync and selective per-chapter transfers keep separate state; there is no shared journal.\n(9) The mirrored-file set equals AIO's own --komikku output layout, which suggests making 'mirror types' a per-device setting tied to AIO's output format.\n\nTiming caveat: the git status comparison reflects the tree now (2026-09-30), which may differ from when the census was taken."
}
```
