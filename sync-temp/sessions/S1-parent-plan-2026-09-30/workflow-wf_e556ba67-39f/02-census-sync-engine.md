# Workflow wf_e556ba67-39f — census:sync-engine (phase Census)

```json
{
  "area": "sync-engine",
  "summary": "Legend: 'CompareManga/' = C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga (NOT a git repo: `git status` fails there, so there is no history or diff to lean on); 'AIO/' = C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\AIO-Webtoon-Downloader. All six assigned sources were read in full. Actual sizes are larger than the task listed: sync_to_tablet.py ~1125 lines, push_all_to_tablet.py ~930, transfer_runner.py ~294, verify_push.py ~146, _verify_chapters.py ~68, _watch_progress.py ~69. manga_ops.py (~368) was also read in full because it is the engine's adb/path-safety layer.\n\nWHAT IT IS: the part of CompareManga that writes to the USB-attached Android tablet with adb. There are two generations.\n(1) push_all_to_tablet.py (May-Jun 2026) mirrors by wiping and re-pushing whole folders. For each PC series (hid variants collapsed to the one with the most chapters) it rm -rf's every matching tablet folder, then adb-pushes the whole PC folder into the tablet root. Matching uses compare_manga.normalize_series_name or a 14-entry hand-written tablet->PC alias table. It then finds the landed folder name (adb truncates non-ASCII names), mv's it to the target name and deletes AIO sidecar files.\n(2) sync_to_tablet.py (Jul 2026) is the current engine. It imports push_all's alias table and adb helpers, and works file by file with SHA-256 hashes and a resumable journal. It hashes every mirrorable PC file (only *.cbz + cover.jpg + details.json), lists the tablet in one adb round-trip (find -printf), and compares both against a per-device journal (.sync_state-<serial>.json) of what it pushed before. A file counts as up to date only if the tablet size matches AND the journal hash equals the fresh PC hash; mtime is never used.\nThe plan has, per series: files to push, files to delete (in the journal or on the tablet but no longer on the PC), and whether the folder is new. It also lists ORPHANED folders (in the journal, PC series gone; removed only with --apply --prune) and PRESERVED folders (never journaled, no PC source; never touched).\nApply runs per series: mkdir -p, rm -f sidecars, rm -f removed chapters (deletes come BEFORE pushes), then adb push. Files with an all-ASCII source path go in batches of up to 50 files / 12,000 arg chars per adb call; any non-ASCII source path gets one push per file to an explicit remote file path (the workaround for adb's UTF-8 truncation). The journal is atomically flushed after every delete batch and every push batch, so a killed run resumes with zero re-push.\n--verify runs sha256sum on the device over every managed tablet folder to rebuild the journal from ground truth (use it on the first run with a device, or to catch corruption). --fast trusts a (size, mtime) PC hash cache instead of re-hashing.\nSUPPORTING PIECES:\n- transfer_runner.py: a threaded per-chapter push/delete job queue with progress events, cooperative cancel, one batch at a time, and an abort after 3 consecutive failures. It is driven by the Flask manga_manager.py dashboard (SSE).\n- verify_push.py: post-push report covering failures from the newest transfer-log, missing/extra tablet folders, chapter-count mismatches, and a hard-coded check that the side-loaded 'SHELTER' folder survived.\n- _verify_chapters.py: one-off check of .cbz counts per folder, PC vs tablet.\n- _watch_progress.py: agent helper that tails the stderr trace and exits on a failure, a batch, Done, or a heartbeat.\nThere is NO format conversion, repacking, compression or tar-over-adb anywhere. Transfer is plain `adb push`, pushes are strictly serial, and the only parallelism is PC hashing (8 threads).\nEverything user-specific is hard-coded: PC root D:\\AIO\\manga (earlier C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas), tablet root /storage/self/primary/Documents, device serial 3CEF42502E91537, the adb path, the 14 aliases, three drifting sidecar lists, the mirrored-file set, batch caps, timeouts, the SHELTER preserve check, and the chapter-loss threshold.\nOBSERVED HISTORY:\n- 2026-05-24: a push_all run lost SPY×FAMILY to adb name truncation (mv failed).\n- 2026-06-14: a 2-series canary, then a full 111-series mirror (104.7 min), both clean on device 3CEF42502E91537.\n- 2026-07-06: first sync on a new device (A06B4A372090333). A USB drop made 107 series fail in a row because the loop never aborts. It resumed cleanly (107 ok, 133.5 GB, 71.4 min).\n- A follow-up --verify exposed file-level truncation in 3 non-ASCII series, which led to the whole-source-path ASCII routing fix.\n- Later incremental runs (07-09, 07-15) were clean. One interrupted run shows deletes-before-pushes leaving a series short until the next run.",
  "features": [
    {
      "name": "Incremental file-level mirror (content-hash diff)",
      "description": "Diffs every mirrorable PC file against the tablet one file at a time using SHA-256. Pushes only new or content-changed files and deletes files the PC no longer has. mtime is deliberately ignored: adb push does not preserve it, and AIO metadata rewrites (ComicInfo.xml, cover.jpg, details.json) can change bytes without the user-visible mtime changing.",
      "source": "CompareManga/sync_to_tablet.py:1-31, 521-615",
      "durable": true
    },
    {
      "name": "Plan / dry-run preview (default mode)",
      "description": "Without --apply it prints SYNC PLAN: PC root, tablet root, PC series and tablet folder counts. The summary shows series with changes (new vs updated), files to push (+bytes), files to delete, preserved and orphaned counts, and warnings. It then prints a per-series table (tablet folder, push count, GB, delete count, NEW), the ORPHANED list, the PRESERVED list, and a first-run note recommending --verify when there is no journal for the device.",
      "source": "CompareManga/sync_to_tablet.py:653-726, 1093-1098",
      "durable": true
    },
    {
      "name": "Resumable per-device state journal",
      "description": ".sync_state-<serial>.json records every file believed to be on the tablet as {size, sha256}, keyed 'tabletFolder/filename'. It is atomically rewritten (tmp + os.replace) after every delete batch and every push batch, so a killed run (USB flicker, reboot, Ctrl+C) resumes with no re-push of confirmed files. It is also the baseline that makes runs incremental.",
      "source": "CompareManga/sync_to_tablet.py:11-14, 487-513, 815-849",
      "durable": true,
      "notes": "Resume demonstrated: sync-log-20260706-221724.json (9 ok / 107 failed after a USB drop) followed by sync-log-20260706-223001.json (107 ok, 18,231 files, 133.45 GB)."
    },
    {
      "name": "Verify / adopt tablet ground truth (--verify)",
      "description": "Runs `find <folder> -type f ! -name '.*' -exec sha256sum {} +` on the device for every MANAGED tablet folder (one whose name equals a current PC target, unfiltered by --only/--skip). It clears that folder's journal entries, rewrites them from the real hashes, and flushes per folder, so a killed verify keeps finished folders. Uses: adopt already-present files on a new device instead of re-pushing, and detect corruption, partial pushes or manual edits. It deliberately never journals side-loaded folders, so they stay 'preserved' rather than becoming prune candidates.",
      "source": "CompareManga/sync_to_tablet.py:24-30, 360-387, 734-768, 1080-1086",
      "durable": true
    },
    {
      "name": "PC hash cache (--fast)",
      "description": "Cache of absolute PC path -> {size, mtime, sha256}. The default run re-hashes everything (the honest answer to 'did the content change?') but always refreshes the cache. --fast trusts cache entries whose size and mtime match, skipping the re-hash.",
      "source": "CompareManga/sync_to_tablet.py:244-320, 1014-1016, 1064-1071",
      "durable": true
    },
    {
      "name": "Parallel PC hashing with progress",
      "description": "ThreadPoolExecutor with --workers threads (default 8) and a 1 MiB read buffer. Progress is written every 200 files: files done/total, GB done/total, %, MB/s.",
      "source": "CompareManga/sync_to_tablet.py:236-241, 296-320, 1025-1026",
      "durable": true,
      "notes": "Observed ~6.1 GB/s over 20,834 files / 152.7 GB with 0 cache hits (synclogs07.md:1632-1633). That is NVMe/OS-cache speed; slower disks would make the default full re-hash expensive."
    },
    {
      "name": "Chapter deletion (mirror semantics)",
      "description": "Under each managed target folder, any depth-1 file that the journal OR the live tablet listing has but the PC's desired set lacks is rm -f'd. Deletes run BEFORE pushes to free space. Nested files are never deleted, and dot-files are excluded from the tablet listing.",
      "source": "CompareManga/sync_to_tablet.py:598-612, 815-822, 347",
      "durable": true,
      "notes": "The desired set is only .cbz + cover.jpg + details.json, so this ALSO deletes PDFs/EPUBs, user-added files and truncated-name leftovers inside managed folders."
    },
    {
      "name": "Orphan detection + opt-in prune",
      "description": "Orphaned = a top-level folder present in the journal whose PC series (target) no longer exists. It is listed in the plan and removed (rm -rf, journal entries dropped, flushed) only when BOTH --apply and --prune are given. The confirmation line states 'PRUNE N folder(s)'.",
      "source": "CompareManga/sync_to_tablet.py:617-627, 876-887, 1017-1019, 1100-1119",
      "durable": true
    },
    {
      "name": "Preserve side-loaded tablet folders",
      "description": "Tablet folders with no PC target and no journal entry (e.g. SHELTER) are listed as PRESERVED and never touched. push_all likewise leaves 'tablet-only' folders alone.",
      "source": "CompareManga/sync_to_tablet.py:36-37, 629-634; push_all_to_tablet.py:13-15, 499-502, 662-667",
      "durable": true
    },
    {
      "name": "Target folder naming policy (alias -> hid-strip -> sanitize)",
      "description": "Maps a PC folder name to a tablet folder name. If the series is aliased (and KEEP_TABLET_NAME_FOR_ALIASES is on) the alias's tablet name is used; otherwise the ' (hid=...)' suffix is stripped. The result always goes through sanitize_tablet_segment: NFKC; remove slash, backslash, colon, *, ?, double quote, <, >, | and control chars; trim trailing spaces/dots; reject empty, '.' and '..'.",
      "source": "CompareManga/sync_to_tablet.py:219-228; push_all_to_tablet.py:94-100, 404-406, 465-473; manga_ops.py:70-83; compare_manga.py:107",
      "durable": true
    },
    {
      "name": "Explicit alias table (PC <-> tablet name bridge)",
      "description": "14 hand-maintained tablet-name -> PC-folder pairs for series normalize_series_name cannot bridge: translated titles, Unicode ×, the '(Official)' suffix, underscores. push_all uses it both to MATCH existing tablet folders and to keep the tablet's name. sync_to_tablet inverts it (PC -> tablet) and only uses it for naming.",
      "source": "CompareManga/push_all_to_tablet.py:67-92; sync_to_tablet.py:104-110",
      "durable": true,
      "notes": "Keyed by PC folder NAME, which is brittle: AIO folder names change on site retitles or merges (AIO/UI-source/electron/series-merge.js:4-8)."
    },
    {
      "name": "Alias table validation",
      "description": "At plan time, an alias pointing to a non-existent PC folder is an 'alias error' that is printed and aborts apply (exit 1). push_all --self-test checks every alias's PC target exists in the live PC library. sync self-test asserts the inversion is a bijection.",
      "source": "CompareManga/push_all_to_tablet.py:437-441, 562-566, 804-819, 902-904; sync_to_tablet.py:940-942",
      "durable": true
    },
    {
      "name": "Target-name collision detection",
      "description": "If two PC folders resolve to the same tablet name (e.g. a duplicate hid variant), the one with more content files is kept and a warning is emitted.",
      "source": "CompareManga/sync_to_tablet.py:549-573",
      "durable": true
    },
    {
      "name": "Empty PC folder skip",
      "description": "PC folders with no content files are skipped with a warning (sync). In push_all, norm groups whose canonical variant has 0 chapters are skipped.",
      "source": "CompareManga/sync_to_tablet.py:558-560; push_all_to_tablet.py:457-459",
      "durable": true
    },
    {
      "name": "Batched adb push",
      "description": "Many local files go into ONE `adb push f1 f2 ... dest_dir/` call to spread the per-invocation adb round-trip over a series. Batches are capped at 50 files and 12,000 cumulative source-path chars to stay under the Windows CreateProcess 32 KB limit. dest_dir is mkdir -p'd first so adb never creates the folder.",
      "source": "CompareManga/sync_to_tablet.py:112-117, 417-440, 465-479, 851-853",
      "durable": true
    },
    {
      "name": "Non-ASCII path routing (adb UTF-8 truncation workaround)",
      "description": "adb 36.x on Windows truncates the leaf it writes by (UTF-8 bytes - chars) of the SOURCE path. This hits folder names when pushing a directory and file names when pushing files, even an ASCII filename inside a non-ASCII folder. Any file whose full source path has a non-ASCII char is therefore pushed alone to an explicit remote file path (dest_dir/<name>, no trailing slash), which adb writes verbatim.",
      "source": "CompareManga/sync_to_tablet.py:417-462, 824-834, 854-856, 983-989; push_all_to_tablet.py:319-360",
      "durable": true
    },
    {
      "name": "Tablet sidecar cleanup",
      "description": "Best-effort rm -f of AIO sidecars in each target folder: .aio_series.json, .mangafire_hid, .series_hid and .cover.webp (sync), or the first three after a whole-folder push (push_all). cover.jpg and details.json are intentionally kept because Komikku reads them.",
      "source": "CompareManga/sync_to_tablet.py:92-102, 807-813; push_all_to_tablet.py:102-107, 363-372, 757-758",
      "durable": true
    },
    {
      "name": "Per-run JSON apply log",
      "description": "sync-log-<YYYYMMDD-HHMMSS>.json holds run totals plus per-series results (target, pushed_files, pushed_bytes, deleted_files, duration_sec, ok, error). It is atomically rewritten after every series so a killed run still leaves a readable record.",
      "source": "CompareManga/sync_to_tablet.py:862-865, 890-904, 1114",
      "durable": true
    },
    {
      "name": "adb + device resolution",
      "description": "adb path: explicit override (compare_manga only), then PATH, then KNOWN_ADB_PATH. Device: an override must be among connected devices; otherwise the single connected device; otherwise DEFAULT_DEVICE_SERIAL if it is among several; otherwise an error asking for --device.",
      "source": "CompareManga/compare_manga.py:444-489; sync_to_tablet.py:1043-1048; push_all_to_tablet.py:160-165, 862-871",
      "durable": true
    },
    {
      "name": "Series include/exclude filters (--only / --skip)",
      "description": "Both are repeatable. sync filters by the RAW PC folder name (including any hid suffix) before planning, while orphan/preserve classification and --verify still use the full PC set. push_all filters by the canonical PC folder AFTER planning.",
      "source": "CompareManga/sync_to_tablet.py:554-557, 625, 1020-1023, 1081-1083; push_all_to_tablet.py:837-844, 892-898",
      "durable": true
    },
    {
      "name": "Typed confirmation gate",
      "description": "--apply prints totals ('This will PUSH n file(s), DELETE m file(s)[, PRUNE k folder(s)] on device X' in sync; 'This will DELETE the matched tablet folders and PUSH...' in push_all) and requires typing yes/y unless --yes is given. Aborting exits with code 3. 'Nothing to apply' exits 0.",
      "source": "CompareManga/sync_to_tablet.py:1097-1112; push_all_to_tablet.py:906-918",
      "durable": true
    },
    {
      "name": "Exit-code contract",
      "description": "sync: 0 ok/no-op; 2 for adb/device/PC-root/tablet-listing errors or any failed series; 3 aborted at the prompt. push_all: 0; 1 alias errors; 2 adb/device/PC-root errors or failed ops; 3 aborted. verify_push: 0 all good, 1 discrepancies.",
      "source": "CompareManga/sync_to_tablet.py:1043-1051, 1074-1078, 1110-1121; push_all_to_tablet.py:862-875, 902-904, 916-918, 926; verify_push.py:137-142",
      "durable": true
    },
    {
      "name": "Whole-folder wipe-and-re-push mirror (push_all_to_tablet)",
      "description": "Per PC norm group: rm -rf every matched tablet folder; rm -rf the target name and any stale landing (the PC basename and its adb-truncated form); `adb push <PC folder> <tablet root>/` (4 h timeout); locate the landed basename (computed truncation, falling back to a listing with a byte-length pin); mv to the target name; strip sidecars. Failures are logged and the loop continues; the log is persisted after every series.",
      "source": "CompareManga/push_all_to_tablet.py:1-40, 375-396, 676-781",
      "durable": false,
      "notes": "Superseded by sync_to_tablet (sync_to_tablet.py:5-7). Worth keeping: its folder-adoption matching and chapter-loss warning (next two features)."
    },
    {
      "name": "Adopt existing tablet folders under different names",
      "description": "Groups PC folders by normalize_series_name (canonical = rank_hid_variants()[0], i.e. the most chapters). Each tablet folder gets a norm key from its alias target or its own name. The plan prints EXPLICIT ALIAS MAPPINGS, TABLET-SIDE RENAME (hid strip / sanitization / alias), NEW SERIES PUSHED and TABLET-ONLY PRESERVED sections.",
      "source": "CompareManga/push_all_to_tablet.py:413-504, 544-668; compare_manga.py:292, 850",
      "durable": true,
      "notes": "sync_to_tablet has NO equivalent: resolve_target_name ignores existing tablet folder names (sync_to_tablet.py:219-228, 577-579). A tablet that already holds differently-named folders (e.g. 'Attack_on_Titan') would get a duplicate pushed, and the old folder would be marked 'preserved'."
    },
    {
      "name": "Chapter-loss warning",
      "description": "The plan lists series where the tablet has at least 20 more depth-1 pdf/cbz chapters than the PC ('push will reduce the count'), sorted by loss.",
      "source": "CompareManga/push_all_to_tablet.py:136-140, 521-541, 598-639",
      "durable": true,
      "notes": "Real output: 15 series flagged, worst -372 (push_run.log:105-120)."
    },
    {
      "name": "Post-push verification report (verify_push)",
      "description": "Loads the newest transfer-log-*.json and prints its failures. It then rescans PC and tablet (fresh), rebuilds the expected target set (plan targets + preserved), and reports MISSING ON TABLET and EXTRA ON TABLET folders. It also reports chapter-count mismatches (depth-1 pdf/cbz) sorted by |delta| and checks that 'SHELTER' still exists.",
      "source": "CompareManga/verify_push.py:1-146",
      "durable": true,
      "notes": "SHELTER is hard-coded (verify_push.py:128-135). Only transfer-log-*.json is globbed, so logs written via --log (full-mirror-log.json, canary-log.json) are never picked up (verify_push.py:29-35)."
    },
    {
      "name": "Chapter-exact .cbz count check (_verify_chapters)",
      "description": "One-off, read-only. Compares PC .cbz count per canonical folder with the tablet's depth-2 *.cbz count per target folder (mapped through push_all.build_plan, so it is alias- and hid-aware). Prints mismatches, totals and tablet-only totals, then PASS/FAIL.",
      "source": "CompareManga/_verify_chapters.py:1-68",
      "durable": false,
      "notes": "Capability folds into the verify report. Uses DEFAULT_DEVICE_SERIAL directly without resolve_device (19)."
    },
    {
      "name": "Per-chapter push/delete job runner (transfer_runner)",
      "description": "Daemon worker thread runs a list of TransferOps: push = file into a tablet DIRECTORY; delete = rm -f of a full tablet file path. Only one batch runs globally (RuntimeError('busy')). Cancel is cooperative through a threading.Event. Events go on a bounded queue: batch_start, file_start, file_progress (throttled to 0.2 s, always at 100%), file_done, batch_done, batch_cancelled, batch_aborted_due_to_errors, plus a heartbeat every 15 s. The batch aborts after error_budget (3) consecutive failures. A cancel that kills the subprocess is reported as a clean cancellation. State is in memory only.",
      "source": "CompareManga/transfer_runner.py:1-294",
      "durable": true,
      "notes": "Consumer: manga_manager.py Flask routes POST /api/transfer (409 'busy' with active id), GET /api/transfer/<id>/stream (SSE), POST /api/transfer/<id>/cancel (manga_manager.py:760-813)."
    },
    {
      "name": "Selective chapter push/delete from a compare view (manga_manager op resolution)",
      "description": "The user selects chapters or a whole series (label '*'). Push only includes chapters whose label is missing on the tablet (never overwrites). Delete matches by label or filename, including unlabeled orphan files, and skips nested paths. A confirm modal shows grouped totals before apply.",
      "source": "CompareManga/manga_manager.py:445-599, 740-758",
      "durable": true,
      "notes": "Naming inconsistency: a new tablet folder is named after the sanitized canonical PC folder INCLUDING any '(hid=...)' suffix and ignoring aliases (manga_manager.py:554-566), which differs from sync's resolve_target_name."
    },
    {
      "name": "adb push progress parsing + cancel",
      "description": "manga_ops.push_chapter runs `adb -s <dev> push <file> <dest>/`. It streams merged stdout/stderr in binary, splits on CR/LF, takes the last 'NN%' per line, and calls on_progress(pct, pct*size//100). It checks the cancel event between reads (terminate, then kill after 5 s) and synthesizes a final 100%. It keeps a ~64-line tail for the error message.",
      "source": "CompareManga/manga_ops.py:130-264",
      "durable": true
    },
    {
      "name": "Tablet path safety layer",
      "description": "Every adb path is validated before shell quoting: non-empty, at most 4096 chars, no CR/LF/NUL, strictly under the tablet root (not the root itself, not a prefix look-alike such as DocumentsX), and no '..' segment. It is then shlex.quote'd. delete_tablet_dir is a deliberate NotImplementedError stub, so per-chapter deletes can never become rm -rf.",
      "source": "CompareManga/manga_ops.py:86-107, 290-302; push_all_to_tablet.py:238-255",
      "durable": true
    },
    {
      "name": "Progress watcher for long runs (_watch_progress)",
      "description": "Tails push_all's append-only stderr trace and exits when: new '!! ERROR:' lines exceed --seen-fails, --target series are complete, 'Done.' appears, or --max-seconds elapse. It prints TRIGGER=fail|done|batch|heartbeat with completed/n_fail/total.",
      "source": "CompareManga/_watch_progress.py:1-69",
      "durable": false,
      "notes": "Tooling for an AI agent watching a run. The durable lesson is to stream progress events rather than read the JSON log."
    },
    {
      "name": "Canary run before a full mirror",
      "description": "Before the full mirror, push_all was run on only the two riskiest (non-ASCII) series, Hell's Paradise and SPY×FAMILY, to prove the truncation handling. The full 111-series mirror started 2 minutes later.",
      "source": "CompareManga/canary-log.json:1-31; canary_stderr.log:6-17; full-mirror-log.json:2-3",
      "durable": true,
      "notes": "Product equivalent: 'test run on selected series' / run a subset first."
    },
    {
      "name": "Pure-function self-tests",
      "description": "sync --self-test covers naming (alias / hid / plain), is_content_file, alias bijection, the diff logic (push = changed + new, delete = removed), preserve vs orphan, chunk caps, and ASCII routing on the full source path. manga_ops self-test covers path validation and sanitize cases.",
      "source": "CompareManga/sync_to_tablet.py:912-992; manga_ops.py:308-363",
      "durable": false,
      "notes": "Port as unit tests (including the non-ASCII folder regression), not as a user feature."
    }
  ],
  "hardcodes": [
    {
      "script": "compare_manga.py (consumed by sync_to_tablet.py:86, push_all_to_tablet.py:109, _verify_chapters.py:30)",
      "name": "DEFAULT_PC_ROOT",
      "value": "D:\\AIO\\manga  (the 2026-05-24 run used C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas, per push_run.log:9)",
      "purpose": "PC library root that is scanned, hashed and mirrored",
      "source": "CompareManga/compare_manga.py:55",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by sync_to_tablet.py:87, push_all_to_tablet.py:110, _verify_chapters.py:20; also manga_ops.py:310 self-test)",
      "name": "DEFAULT_TABLET_ROOT",
      "value": "/storage/self/primary/Documents",
      "purpose": "Destination root on the tablet (the Perfect Viewer library). Every adb path is validated to stay strictly under it.",
      "source": "CompareManga/compare_manga.py:56",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by resolve_device, push_all --device help, _verify_chapters)",
      "name": "DEFAULT_DEVICE_SERIAL",
      "value": "3CEF42502E91537  (a second device, A06B4A372090333, is the one the sync runs used: .sync_state-A06B4A372090333.json, synclogs07.md:1629)",
      "purpose": "Fallback device when several are connected; used unconditionally by _verify_chapters.py:19",
      "source": "CompareManga/compare_manga.py:57, 485-486; push_all_to_tablet.py:845-847; _verify_chapters.py:19",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (via resolve_adb, used by all sync scripts)",
      "name": "KNOWN_ADB_PATH",
      "value": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\ADB\\platform-tools\\adb.exe",
      "purpose": "adb fallback when adb is not on PATH (PATH is tried first)",
      "source": "CompareManga/compare_manga.py:58, 444-457",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by sync_to_tablet.scan_pc)",
      "name": "IGNORE_TOP_LEVEL",
      "value": "{'.aio_coord', '.aio_folder_alloc.lock'}, plus any entry whose name starts with '.'",
      "purpose": "PC-root entries never treated as series (AIO coordination and lock files)",
      "source": "CompareManga/compare_manga.py:64; sync_to_tablet.py:187",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by push_all_to_tablet._strip_hid, and sync via resolve_target_name)",
      "name": "RE_HID_SUFFIX",
      "value": "^(.+?)\\s*\\(hid=(.*?)\\)\\s*$",
      "purpose": "Strips AIO's ' (hid=...)' collision suffix to derive the tablet folder name",
      "source": "CompareManga/compare_manga.py:107; push_all_to_tablet.py:404-406; sync_to_tablet.py:228",
      "should_be_user_setting": false
    },
    {
      "script": "push_all_to_tablet.py (also imported by sync_to_tablet.py, verify_push.py, _verify_chapters.py)",
      "name": "ALIASES_TABLET_TO_PC (14 entries, tablet folder => PC folder)",
      "value": "1) A Certain Scientific Railgun => Toaru Majutsu no Index Gaiden Toaru Kagaku no Railgun | 2) CØDEBREAKER => Code Breaker | 3) Every Day Is a Holiday (Colored) => Kinenbi Manga | 4) Fullmetal Alchemist => FULL METAL ALCHEMIST | 5) Ghost Sore wa rei no Shiwaza desu => Sore wa rei no Shiwaza desu | 6) Is_the_order_a_rabbit => Gochuumon wa Usagi desu ka | 7) JoJo's Bizarre Adventure Part 5 Golden Wind => JoJo no Kimyou na Bouken Part 5 - Ougon no Kaze | 8) JoJo's_Bizarre_Adventure_Part_4_Diamond_is_Unbreakable => JoJo no Kimyou na Bouken Part 4 - Diamond wa Kudakenai | 9) Makeine Make Hiroin ga Ōsugiru! => Too Many Losing Heroines! | 10) No Longer Allowed In Another World => Isekai Shikkaku | 11) One-Punch_Man_(Official) => One-Punch Man | 12) Record of Ragnarok => Shuumatsu no Valkyrie | 13) SPY_x_FAMILY => SPY×FAMILY | 14) Slow Life In Another World (I Wish!) => Isekai de Slow Life o (Ganbou)",
      "purpose": "Bridges tablet folder names that normalize_series_name cannot match to PC folders. In push_all it also keeps the tablet's name. Every PC target must exist or apply aborts.",
      "source": "CompareManga/push_all_to_tablet.py:67-92",
      "should_be_user_setting": true
    },
    {
      "script": "sync_to_tablet.py",
      "name": "PC_TO_TABLET_ALIAS",
      "value": "Computed inverse of ALIASES_TABLET_TO_PC: the same 14 pairs as PC folder => tablet folder (e.g. SPY×FAMILY => SPY_x_FAMILY; Code Breaker => CØDEBREAKER; Isekai Shikkaku => No Longer Allowed In Another World)",
      "purpose": "Chooses the tablet folder name for an aliased PC series in the file-level sync",
      "source": "CompareManga/sync_to_tablet.py:104-110, 226-227",
      "should_be_user_setting": true
    },
    {
      "script": "push_all_to_tablet.py (read by sync_to_tablet.py:226)",
      "name": "KEEP_TABLET_NAME_FOR_ALIASES",
      "value": "True",
      "purpose": "Aliased pairs land under the tablet's (more readable) name. Non-aliased norm matches take the PC name with hid stripped, which renames e.g. Attack_on_Titan to Attack on Titan (a user decision on 2026-05-24).",
      "source": "CompareManga/push_all_to_tablet.py:94-100, 468-471",
      "should_be_user_setting": true
    },
    {
      "script": "sync_to_tablet.py",
      "name": "SIDECARS",
      "value": "('.aio_series.json', '.mangafire_hid', '.series_hid', '.cover.webp')",
      "purpose": "AIO sidecars that are never mirrored and are rm -f'd from every target folder on each apply",
      "source": "CompareManga/sync_to_tablet.py:92-97, 807-813",
      "should_be_user_setting": true
    },
    {
      "script": "push_all_to_tablet.py",
      "name": "SIDECARS_ON_TABLET",
      "value": "('.aio_series.json', '.mangafire_hid', '.series_hid')",
      "purpose": "Sidecars removed after a whole-folder push (second, drifting copy of the sidecar list)",
      "source": "CompareManga/push_all_to_tablet.py:102-107, 363-372",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py",
      "name": "IGNORE_SERIES_FILES",
      "value": "{'.aio_series.json', '.mangafire_hid'}",
      "purpose": "Third drifting copy of the sidecar list (comparator side). Should become one shared list derived from AIO's constants.",
      "source": "CompareManga/compare_manga.py:66",
      "should_be_user_setting": true
    },
    {
      "script": "sync_to_tablet.py",
      "name": "Mirrored file set (COVER_NAME, DETAILS_NAME, is_content_file)",
      "value": "*.cbz (case-insensitive) + exactly 'cover.jpg' + exactly 'details.json'; dot-files never; everything else ignored",
      "purpose": "Defines what is pushed. Because deletions are computed against this set, any other file type (pdf, epub, user files) in a managed tablet folder is deleted.",
      "source": "CompareManga/sync_to_tablet.py:99-102, 168-173, 598-612",
      "should_be_user_setting": true
    },
    {
      "script": "push_all_to_tablet.py / verify_push.py",
      "name": "Chapter extensions for counting",
      "value": "pdf, cbz (depth-1 files only)",
      "purpose": "Chapter counts used for deltas, the loss warning and post-push mismatch checks",
      "source": "CompareManga/push_all_to_tablet.py:521-524, 536-541; verify_push.py:111-114, 130-131",
      "should_be_user_setting": true
    },
    {
      "script": "sync_to_tablet.py",
      "name": "MAX_BATCH_FILES",
      "value": "50",
      "purpose": "Maximum files per `adb push` call",
      "source": "CompareManga/sync_to_tablet.py:112-116",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py",
      "name": "MAX_BATCH_ARGLEN",
      "value": "12000",
      "purpose": "Cumulative source-path characters per adb push call (Windows CreateProcess 32 KB command-line limit)",
      "source": "CompareManga/sync_to_tablet.py:112-117, 465-479",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py",
      "name": "--workers default",
      "value": "8",
      "purpose": "Number of PC hashing threads",
      "source": "CompareManga/sync_to_tablet.py:1025-1026",
      "should_be_user_setting": true
    },
    {
      "script": "sync_to_tablet.py",
      "name": "Push timeout formula",
      "value": "max(180 s, total_bytes / 4,000,000 + 120 s) per adb push call (assumes a pessimistic 4 MB/s USB-2 floor)",
      "purpose": "Keeps a hung adb push from blocking forever",
      "source": "CompareManga/sync_to_tablet.py:436-437, 456",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py / push_all_to_tablet.py / compare_manga.py / manga_ops.py",
      "name": "Other adb timeouts",
      "value": "sync: tablet sha256 per folder 7200 s (373); rm -f batch 120 s (401); prune rm -rf 600 s (408). push_all: whole-folder push 14400 s, sized for One Piece at 11 GB (393); rm -rf 300 (279); mkdir 30 (290); mv 60 (302); exists 30 (314); list folders 30 (267); sidecars 30 (372); adb_shell default 60 (234). compare_manga: find listing 180 (539); stat fallback 600 (564); adb devices 15 (464). manga_ops: mkdir 30 (120); rm -f 30 (280); kill grace 5 (259).",
      "purpose": "Bound every adb call",
      "source": "CompareManga/sync_to_tablet.py:373, 401, 408; push_all_to_tablet.py:234, 267, 279, 290, 302, 314, 372, 393; compare_manga.py:464, 539, 564; manga_ops.py:120, 259, 280",
      "should_be_user_setting": false
    },
    {
      "script": "push_all_to_tablet.py",
      "name": "Chapter-loss warning threshold",
      "value": "chapter delta <= -20 (tablet has at least 20 more chapters than the PC)",
      "purpose": "Flags series where a push would reduce the tablet's chapter count",
      "source": "CompareManga/push_all_to_tablet.py:627-639",
      "should_be_user_setting": true
    },
    {
      "script": "transfer_runner.py",
      "name": "error_budget default",
      "value": "3 consecutive failures",
      "purpose": "Aborts a batch (batch_aborted_due_to_errors) after N consecutive failed ops",
      "source": "CompareManga/transfer_runner.py:91, 192-232",
      "should_be_user_setting": true
    },
    {
      "script": "transfer_runner.py",
      "name": "Runner tuning constants",
      "value": "_PROGRESS_MIN_INTERVAL 0.2 s; event queue maxsize 4096; SSE heartbeat 15 s; blocking emit timeout 30 s; last 3 errors kept for the abort event",
      "purpose": "Event throttling and back-pressure",
      "source": "CompareManga/transfer_runner.py:64, 77, 130, 161-178, 213-215",
      "should_be_user_setting": false
    },
    {
      "script": "manga_ops.py (push_all duplicates part of it)",
      "name": "Path-safety rules",
      "value": "Forbidden in a segment: slash, backslash, colon, *, ?, double quote, <, >, |, control chars U+0000-U+001F. NFKC-normalize; trim trailing ' .'. Full path at most 4096 chars, no CR/LF/NUL, no '..', strictly under the tablet root.",
      "purpose": "Tablet-safe names for Perfect Viewer / MTP and defense-in-depth against shell or path escapes",
      "source": "CompareManga/manga_ops.py:41-47, 70-107; push_all_to_tablet.py:238-255",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py",
      "name": "STATE_VERSION",
      "value": "1",
      "purpose": "Journal schema version (written but not checked on load)",
      "source": "CompareManga/sync_to_tablet.py:90, 491-505",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py / push_all_to_tablet.py / verify_push.py",
      "name": "State/log file names and location (script directory)",
      "value": ".sync_state-<device>.json; .pc_hash_cache.json; sync-log-%Y%m%d-%H%M%S.json; transfer-log-%Y%m%d-%H%M%S.json; .tablet_cache.json. All live in SCRIPT_DIR (CompareManga/).",
      "purpose": "Persistence locations",
      "source": "CompareManga/sync_to_tablet.py:88, 487-488, 1029-1030, 1114; push_all_to_tablet.py:111, 882, 920-923; verify_push.py:68",
      "should_be_user_setting": false
    },
    {
      "script": "verify_push.py",
      "name": "Preserved-folder assertion",
      "value": "'SHELTER' (the one side-loaded, tablet-only series, 210 files: push_run.log:227)",
      "purpose": "Verification fails (exit 1) if this tablet-only folder disappeared",
      "source": "CompareManga/verify_push.py:12-14, 128-135",
      "should_be_user_setting": true
    },
    {
      "script": "verify_push.py",
      "name": "Log discovery glob",
      "value": "newest (by mtime) transfer-log-*.json in the script directory",
      "purpose": "Chooses which run to verify",
      "source": "CompareManga/verify_push.py:29-35",
      "should_be_user_setting": false
    },
    {
      "script": "_verify_chapters.py",
      "name": "Hard-coded series count label",
      "value": "'tablet cbz across 111 mirrored'",
      "purpose": "One-off report label tied to the June library size",
      "source": "CompareManga/_verify_chapters.py:64",
      "should_be_user_setting": false
    },
    {
      "script": "_watch_progress.py",
      "name": "Watcher defaults",
      "value": "total fallback 111 when no header has been seen yet; --max-seconds 1500; --poll 15",
      "purpose": "Heartbeat and polling cadence for the agent watcher",
      "source": "CompareManga/_watch_progress.py:32-34, 47-48",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py",
      "name": "Hash progress cadence",
      "value": "every 200 files (and at the end)",
      "purpose": "stderr progress granularity while hashing",
      "source": "CompareManga/sync_to_tablet.py:308",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py / push_all_to_tablet.py",
      "name": "Confirmation tokens",
      "value": "'yes' or 'y' (case-insensitive)",
      "purpose": "CLI apply gate (becomes a UI confirm dialog)",
      "source": "CompareManga/sync_to_tablet.py:1110; push_all_to_tablet.py:916",
      "should_be_user_setting": false
    },
    {
      "script": "sync_to_tablet.py",
      "name": "Delete-depth policy",
      "value": "Only depth-1 files ('/' not in the relative name) inside a managed target folder are ever deleted; nested files never",
      "purpose": "Limits the blast radius of mirror deletions",
      "source": "CompareManga/sync_to_tablet.py:604, 610",
      "should_be_user_setting": false
    },
    {
      "script": "push_all_to_tablet.py / verify_push.py",
      "name": "Tablet scan freshness",
      "value": "scan_tablet_library(..., refresh=True, ttl_hours=0) written to .tablet_cache.json",
      "purpose": "Always rescan before planning or verifying",
      "source": "CompareManga/push_all_to_tablet.py:882-885; verify_push.py:66-70",
      "should_be_user_setting": false
    }
  ],
  "algorithms": [
    {
      "name": "Change-detection contract",
      "description": "A desired PC file is already good on the tablet iff the tablet listing has 'target/rel' at the SAME size AND the journal entry for 'target/rel' has sha256 == the fresh PC sha256. Otherwise it is pushed. Without --verify the journal is trusted for the tablet-side hash; with --verify the journal was just rebuilt from device sha256sum, so the same comparison becomes ground truth. mtime never participates.",
      "source": "CompareManga/sync_to_tablet.py:539-544, 586-596"
    },
    {
      "name": "Delete-set computation",
      "description": "For each managed target: (journal keys under 'target/') UNION (live tablet file keys under 'target/'), restricted to depth-1 names, minus the PC's desired names, de-duplicated.",
      "source": "CompareManga/sync_to_tablet.py:598-612"
    },
    {
      "name": "Orphaned vs preserved classification",
      "description": "all_targets = resolve_target_name over ALL PC folders (unfiltered); recorded = top-level folder names in the journal. orphaned = recorded minus all_targets (prune candidates). preserved = live tablet dirs minus all_targets minus recorded (never touched). This is why --verify must never journal non-managed folders.",
      "source": "CompareManga/sync_to_tablet.py:617-634, 745-747"
    },
    {
      "name": "Target name resolution",
      "description": "If KEEP_TABLET_NAME_FOR_ALIASES and the PC folder is in PC_TO_TABLET_ALIAS: sanitize(alias). Else: sanitize(strip_hid(pc_folder)). sanitize = NFKC, drop forbidden chars, rstrip ' .', strip, reject ''/'.'/'..'.",
      "source": "CompareManga/sync_to_tablet.py:219-228; manga_ops.py:70-83; push_all_to_tablet.py:404-406"
    },
    {
      "name": "Target collision resolution",
      "description": "When several PC folders map to one target, keep the one with more content files and emit a warning naming the loser.",
      "source": "CompareManga/sync_to_tablet.py:549-573"
    },
    {
      "name": "Push routing + batching",
      "description": "Split to_push by whether str(abs source path) is pure ASCII. ASCII files are chunked (a new chunk starts when count >= 50 or cumulative len(path)+1 would exceed 12000) and each chunk is sent as `adb push f1..fn dest_dir/`. Non-ASCII files are pushed one per call to 'dest_dir/<name>'. Journal update + flush after every chunk or file.",
      "source": "CompareManga/sync_to_tablet.py:465-479, 824-856"
    },
    {
      "name": "adb landed-basename truncation model",
      "description": "The folder adb creates for a non-ASCII source basename = the first len(name_in_chars) BYTES of utf-8(name), or None if the cut splits a multibyte char. If that path doesn't exist, fall back to listing the root: accept an exact match, or a folder whose utf-8 is a byte-prefix of the source AND whose byte length equals the source char count. The length pin stops a match on an unrelated shorter series that shares a prefix.",
      "source": "CompareManga/push_all_to_tablet.py:319-360, 740-747"
    },
    {
      "name": "Timeout scaling",
      "description": "timeout = max(180, bytes/4e6 + 120) seconds per adb push call.",
      "source": "CompareManga/sync_to_tablet.py:436-437, 456"
    },
    {
      "name": "Tablet content hashing",
      "description": "`find <folder> -type f ! -name '.*' -exec sha256sum {} + 2>/dev/null`, one shell per series folder. Parse lines of length >= 68 with two spaces at [64:66]: digest = [0:64], path = [66:]. Strip the root prefix and skip dot-basenames.",
      "source": "CompareManga/sync_to_tablet.py:360-387"
    },
    {
      "name": "One-round-trip tablet enumeration",
      "description": "A single adb shell call: `find root -mindepth 1 -maxdepth 1 -type d; echo SENTINEL; find root -type f -printf '%s|%T@|%p'` (newline-terminated). It falls back to `-exec stat -c '%s|%Y|%n' {} +` when -printf is unsupported. sync keeps depth-1 dirs and non-dot files as rel path -> size.",
      "source": "CompareManga/compare_manga.py:492-568; sync_to_tablet.py:332-357"
    },
    {
      "name": "PC hashing with cache",
      "description": "Collect all content files. With --fast, reuse a cache hit when size and mtime match exactly. Hash the rest in a thread pool (1 MiB chunks) and always write fresh results back to the cache keyed by absolute path.",
      "source": "CompareManga/sync_to_tablet.py:262-320"
    },
    {
      "name": "push_all plan: norm grouping + canonical variant",
      "description": "Group PC folders by normalize_series_name. Each tablet folder's norm key comes from its alias target (recording an alias error if that PC folder is missing) or its own name. Per group: canonical = rank_hid_variants(variants)[0] (skip if 0 chapters). matched = tablet folders with the same norm. target = matched[0] if via alias and the KEEP flag is set, else strip_hid(canonical). needs_rename = (canonical basename != target). Tablet-only = tablet norms never used.",
      "source": "CompareManga/push_all_to_tablet.py:413-504; compare_manga.py:292, 850"
    },
    {
      "name": "Chapter delta and loss detection",
      "description": "delta = PC canonical chapter count minus the sum over matched tablet folders of depth-1 pdf/cbz files. Losses are listed when delta <= -20.",
      "source": "CompareManga/push_all_to_tablet.py:136-140, 527-541, 603-639"
    },
    {
      "name": "Runner progress throttling + error budget",
      "description": "on_progress drops repeated percents and anything within 0.2 s of the last emit (100% always passes). Consecutive failures reset on success; reaching error_budget emits batch_aborted_due_to_errors with the last 3 errors. A failure while cancel is set is reported as a cancel.",
      "source": "CompareManga/transfer_runner.py:192-232, 253-264"
    },
    {
      "name": "adb push percent parsing",
      "description": "Read merged output in 256-byte chunks, split on CR LF / CR / LF, and take the last '(\\d{1,3})%' per line. bytes_done = pct*size//100. Cancel is checked before and after each chunk. A final 100% is synthesized if adb skipped it.",
      "source": "CompareManga/manga_ops.py:35-39, 181-249"
    },
    {
      "name": "Progress-watch parse",
      "description": "From the stderr trace: headers '^\\[\\s*(\\d+)/(\\d+)\\]' give latest i and total N. completed = N if '^Done\\.' is present, else latest-1. n_fail = count of '!! ERROR:'.",
      "source": "CompareManga/_watch_progress.py:22-39"
    }
  ],
  "cli_flags": [
    {
      "script": "sync_to_tablet.py",
      "flag": "--plan",
      "meaning": "Print the plan and exit (also the behaviour when --apply is absent)",
      "source": "CompareManga/sync_to_tablet.py:1005-1006, 1097-1098",
      "default": "on (implicit)"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--apply",
      "meaning": "Execute the plan after the typed confirmation",
      "source": "CompareManga/sync_to_tablet.py:1007-1008, 1097-1115",
      "default": "off"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--yes / -y",
      "meaning": "Skip the apply confirmation prompt",
      "source": "CompareManga/sync_to_tablet.py:1009-1010, 1104",
      "default": "off"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--verify",
      "meaning": "Before planning, sha256sum every managed tablet file and rebuild the journal from ground truth (slow; use on the first run for a device and periodically)",
      "source": "CompareManga/sync_to_tablet.py:1011-1013, 1080-1086",
      "default": "off"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--fast",
      "meaning": "Trust the (size, mtime) PC hash cache instead of re-hashing the whole PC library",
      "source": "CompareManga/sync_to_tablet.py:1014-1016, 1065-1068",
      "default": "off"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--prune",
      "meaning": "With --apply, also rm -rf orphaned folders (journaled, PC series gone)",
      "source": "CompareManga/sync_to_tablet.py:1017-1019, 1117-1119",
      "default": "off"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--only PC_FOLDER (repeatable)",
      "meaning": "Only sync these raw PC folder names",
      "source": "CompareManga/sync_to_tablet.py:1020-1021, 554-555",
      "default": "[] (all)"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--skip PC_FOLDER (repeatable)",
      "meaning": "Skip these raw PC folder names",
      "source": "CompareManga/sync_to_tablet.py:1022-1023, 556-557",
      "default": "[]"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--device SERIAL",
      "meaning": "adb device serial override (must be connected)",
      "source": "CompareManga/sync_to_tablet.py:1024, 1045",
      "default": "auto: single connected device, else DEFAULT_DEVICE_SERIAL"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--workers N",
      "meaning": "PC hashing thread count (min 1)",
      "source": "CompareManga/sync_to_tablet.py:1025-1026, 1067",
      "default": "8"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--state PATH",
      "meaning": "Journal path",
      "source": "CompareManga/sync_to_tablet.py:1027-1028, 1054",
      "default": "<script dir>/.sync_state-<device>.json"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--pc-cache PATH",
      "meaning": "PC hash cache path (read with --fast, always written)",
      "source": "CompareManga/sync_to_tablet.py:1029-1030, 1064-1069",
      "default": "<script dir>/.pc_hash_cache.json"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--log PATH",
      "meaning": "Apply log path",
      "source": "CompareManga/sync_to_tablet.py:1031, 1114",
      "default": "<script dir>/sync-log-YYYYMMDD-HHMMSS.json"
    },
    {
      "script": "sync_to_tablet.py",
      "flag": "--self-test",
      "meaning": "Run pure-function self-tests (no device) and exit",
      "source": "CompareManga/sync_to_tablet.py:1032-1033, 1040-1041",
      "default": "off"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--plan",
      "meaning": "Print the plan and exit (default)",
      "source": "CompareManga/push_all_to_tablet.py:832, 906-907",
      "default": "on (implicit)"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--apply",
      "meaning": "Execute the plan (rm -rf matched tablet folders, push, rename, strip sidecars) after confirmation",
      "source": "CompareManga/push_all_to_tablet.py:833-834, 909-925",
      "default": "off"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--yes / -y",
      "meaning": "Skip the apply confirmation prompt",
      "source": "CompareManga/push_all_to_tablet.py:835-836, 910",
      "default": "off"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--only PC_FOLDER (repeatable)",
      "meaning": "Only push series whose CANONICAL PC folder matches (filter applied after planning)",
      "source": "CompareManga/push_all_to_tablet.py:837-840, 893-895",
      "default": "[]"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--skip PC_FOLDER (repeatable)",
      "meaning": "Skip series whose canonical PC folder matches",
      "source": "CompareManga/push_all_to_tablet.py:841-844, 896-898",
      "default": "[]"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--device SERIAL",
      "meaning": "adb device serial",
      "source": "CompareManga/push_all_to_tablet.py:845-847",
      "default": "single connected device, else 3CEF42502E91537"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--log PATH",
      "meaning": "Apply log path (used to produce full-mirror-log.json and canary-log.json)",
      "source": "CompareManga/push_all_to_tablet.py:848-850, 920-923",
      "default": "<script dir>/transfer-log-YYYYMMDD-HHMMSS.json"
    },
    {
      "script": "push_all_to_tablet.py",
      "flag": "--self-test",
      "meaning": "Validate the alias table against the live PC library and exit",
      "source": "CompareManga/push_all_to_tablet.py:851-852, 859-860",
      "default": "off"
    },
    {
      "script": "_watch_progress.py",
      "flag": "--log PATH (required)",
      "meaning": "The append-only stderr trace to tail",
      "source": "CompareManga/_watch_progress.py:44"
    },
    {
      "script": "_watch_progress.py",
      "flag": "--target N (required)",
      "meaning": "Exit once N series have completed",
      "source": "CompareManga/_watch_progress.py:45, 59-61"
    },
    {
      "script": "_watch_progress.py",
      "flag": "--seen-fails N",
      "meaning": "Exit as soon as the '!! ERROR:' count exceeds N",
      "source": "CompareManga/_watch_progress.py:46, 53-55",
      "default": "0"
    },
    {
      "script": "_watch_progress.py",
      "flag": "--max-seconds N",
      "meaning": "Heartbeat exit after N seconds",
      "source": "CompareManga/_watch_progress.py:47, 62-64",
      "default": "1500"
    },
    {
      "script": "_watch_progress.py",
      "flag": "--poll N",
      "meaning": "Seconds between re-reads of the trace",
      "source": "CompareManga/_watch_progress.py:48, 65",
      "default": "15"
    },
    {
      "script": "verify_push.py / _verify_chapters.py / transfer_runner.py",
      "flag": "(none)",
      "meaning": "verify_push.main() takes no arguments; _verify_chapters.py is a module-level script; transfer_runner is a library driven by manga_manager.py",
      "source": "CompareManga/verify_push.py:38, 145-146; _verify_chapters.py:18-68; transfer_runner.py:7-13"
    }
  ],
  "destructive_ops": [
    {
      "op": "sync: rm -f of chapter files that are no longer on the PC (to_delete batch per series)",
      "source": "CompareManga/sync_to_tablet.py:394-403, 598-612, 815-822",
      "safety_rails": "Plan preview first. --apply plus a typed yes (or --yes). Each path goes through _validate_tablet_path (root-bounded, not the root, no '..', no CR/LF/NUL) and shlex.quote. Files only, never -rf. Only depth-1 names inside a folder that is a current PC target. Journal entries are dropped and flushed. GAPS: (a) anything in a managed folder outside the desired set (.cbz/cover.jpg/details.json) is deleted, including PDFs/EPUBs or user-added files. (b) Deletes run BEFORE pushes, so an interruption leaves the series short until the next run (sync-log-20260707-013414.json: 131 deleted, 1 pushed). (c) There is no mass-delete guard (e.g. 434 deletes planned in synclogs07.md:1648). (d) There is no rename detection: a renamed chapter is deleted and fully re-pushed."
    },
    {
      "op": "sync: best-effort rm -f of AIO sidecars in every target folder on each apply",
      "source": "CompareManga/sync_to_tablet.py:807-813",
      "safety_rails": "Fixed name list, path validation, errors swallowed."
    },
    {
      "op": "sync: prune = rm -rf of orphaned tablet folders",
      "source": "CompareManga/sync_to_tablet.py:406-410, 876-887, 1017-1019, 1117-1119",
      "safety_rails": "Needs BOTH --apply and --prune. Only folders present in the journal (previously pushed by this tool) whose PC target no longer exists. Side-loaded folders can never become orphans because --verify never journals non-managed folders (617-624, 745-747). The confirmation line includes 'PRUNE N folder(s)' (1107). Path validation. GAP: a PC-side rename or merge of a series folder turns the old tablet folder into an orphan, so --prune deletes it and the new name is pushed from scratch."
    },
    {
      "op": "sync --verify: journal entries for a folder are cleared and rewritten",
      "source": "CompareManga/sync_to_tablet.py:755-767",
      "safety_rails": "Only after that folder's hash succeeds (a failure skips it and leaves entries intact, 758-762). Flushed per folder. Local state only."
    },
    {
      "op": "push_all: rm -rf of every matched tablet folder before pushing the PC folder",
      "source": "CompareManga/push_all_to_tablet.py:274-282, 702-707",
      "safety_rails": "The plan lists replacements, alias mappings, renames, new and preserved folders. CHAPTER LOSSES >= 20 warning (627-639). Alias errors abort before apply (902-904). Typed confirmation that explicitly says 'DELETE the matched tablet folders' (910-918). _validate_tablet_path (238-255). Tablet-only folders are never matched. GAPS: not transactional (if the push fails after rm -rf, the tablet copy is gone); no backup; tablet-only chapters are destroyed (e.g. -372 for JoJo Part 4, push_run.log:107)."
    },
    {
      "op": "push_all: pre-clean rm -rf of the target name and stale push landings (the PC basename and its adb-truncated form)",
      "source": "CompareManga/push_all_to_tablet.py:709-721",
      "safety_rails": "Skips names that are in the matched set and paths equal to the target; path validation; rm -rf is silent on ENOENT."
    },
    {
      "op": "push_all: adb shell mv of the landed folder to the target name",
      "source": "CompareManga/push_all_to_tablet.py:296-305, 740-755",
      "safety_rails": "Path validation. Landed name computed, else discovered by listing with a byte-length pin; raises if not found. Failed once on SPY×FAMILY before the truncation model existed (transfer-log-20260524-015607.json:743-744)."
    },
    {
      "op": "push_all: rm -f of sidecars after each push",
      "source": "CompareManga/push_all_to_tablet.py:363-372, 757-758",
      "safety_rails": "Fixed names; best-effort."
    },
    {
      "op": "transfer_runner/manga_ops: rm -f of individual tablet files selected in the web UI",
      "source": "CompareManga/manga_ops.py:267-287; transfer_runner.py:280-284; manga_manager.py:514-526, 539-550",
      "safety_rails": "_validate_tablet_path. Single file only; delete_tablet_dir is an intentional NotImplementedError stub (manga_ops.py:290-302). Nested paths are skipped. A confirm modal with grouped totals comes before apply (manga_manager.py:740-758). Cooperative cancel. Abort after 3 consecutive failures. Only one batch runs at a time."
    }
  ],
  "state_files": [
    {
      "file": "CompareManga/.sync_state-<device serial>.json  (observed: .sync_state-A06B4A372090333.json, ~3.37 MB)",
      "schema": "Single-line JSON (ensure_ascii=False): {\"version\": 1, \"device\": \"A06B4A372090333\", \"tablet_root\": \"/storage/self/primary/Documents\", \"files\": {\"<tablet folder>/<filename>\": {\"size\": <int bytes>, \"sha256\": \"<64-hex>\"}, ...}, \"updated_at_iso\": \"2026-07-15T02:37:40.568958\"}. Keys look like \"'Tis Time for Torture, Princess/Ch.001 - Torture 1.cbz\" and \"Yumemiru Danshi wa Genjitsushugisha/cover.jpg\". Written atomically via a .tmp sibling and os.replace.",
      "purpose": "Record of what is believed to be on the tablet: the incremental baseline, the resume journal, and the orphan-vs-preserved discriminator (journal membership).",
      "writer": "sync_to_tablet.save_state (508-513), called from apply_plan after every delete batch (822) and push batch (843), verify_rebuild_state per folder (767), and prune_orphans (885)",
      "reader": "sync_to_tablet.load_state (491-505). Missing or corrupt -> empty journal. version/device/tablet_root are NOT validated on load."
    },
    {
      "file": "CompareManga/.pc_hash_cache.json (~4.5 MB)",
      "schema": "Single-line JSON: {\"entries\": {\"<absolute Windows PC path, e.g. D:\\\\AIO\\\\manga\\\\<series>\\\\Ch.001 - x.cbz>\": {\"size\": <int>, \"mtime\": <float epoch>, \"sha256\": \"<64-hex>\"}, ...}}. Written atomically.",
      "purpose": "Lets --fast skip re-hashing unchanged PC files. Keyed by absolute path, so a PC-root move invalidates it silently. Never pruned (entries for deleted files persist).",
      "writer": "sync_to_tablet.hash_pc_files updates entries (303-305); save_pc_cache (255-259) after every hash pass (1069)",
      "reader": "sync_to_tablet.load_pc_cache (244-252), consulted only with --fast (282-288)"
    },
    {
      "file": "CompareManga/sync-log-<YYYYMMDD-HHMMSS>.json (7 observed, 2026-07-06..07-15)",
      "schema": "{\"started_at_iso\", \"completed_at_iso\", \"n_ok\", \"n_fail\", \"pushed_files\", \"pushed_bytes\", \"deleted_files\", \"results\": [{\"target\", \"pushed_files\", \"pushed_bytes\", \"deleted_files\", \"duration_sec\", \"ok\", \"error\" (string or null)}]}, indent=2. Atomically rewritten after every series. A 0-byte stray .tmp exists from a killed run (sync-log-20260715-021752.json.tmp).",
      "purpose": "Per-run apply results / audit trail",
      "writer": "sync_to_tablet._save_log (890-904), from apply_plan's finally (862-865)",
      "reader": "none in code (human)"
    },
    {
      "file": "CompareManga/transfer-log-<YYYYMMDD-HHMMSS>.json, full-mirror-log.json, canary-log.json",
      "schema": "{\"started_at_unix\", \"started_at_iso\", \"completed_at_iso\", \"n_ok\", \"n_fail\", \"results\": [{\"series\" (canonical PC folder), \"target\" (absolute tablet path), \"deleted\": [tablet folder names rm -rf'd], \"pushed_bytes\", \"pushed_files\", \"duration_sec\", \"ok\", \"error\"}]}, indent=2, atomically rewritten after every series.",
      "purpose": "Per-run results of the whole-folder mirror",
      "writer": "push_all_to_tablet._save_log (784-796), called at 770-772",
      "reader": "verify_push.latest_log / main (29-59). Only the transfer-log-*.json glob is read."
    },
    {
      "file": "CompareManga/.tablet_cache.json (~2.5 MB)",
      "schema": "Per compare_manga.save_cache: {\"version\": 2, \"device\", \"tablet_root\", \"scanned_at_unix\", \"scan_duration_sec\", \"file_count\", \"dir_count\", \"files\": [{\"p\": path, \"s\": size, \"m\": mtime}], \"dirs\": [paths]}",
      "purpose": "Tablet listing cache shared with the comparator. push_all and verify_push always force a fresh scan (refresh=True, ttl_hours=0).",
      "writer": "compare_manga.scan_tablet_library (compare_manga.py:602-628), as called by push_all_to_tablet.py:882-885 and verify_push.py:66-70",
      "reader": "compare_manga.load_cache (compare_manga.py:571-599)"
    },
    {
      "file": "CompareManga/push_run.log, full_mirror_stderr.log, full_mirror_stdout.log, canary_stderr.log, push_plan_stderr.log, synclogs07.md (shell-redirected traces)",
      "schema": "Human text. stdout = the plan block. stderr = 'adb: <path>', 'device: <serial>', '[ i/N] <target>  (...)', '  rm -rf  <path>', '  push    <src>  ->  <root>/', adb per-file lines ('<file>: 1 file pushed, 0 skipped. X MB/s (...)'), '  mv  <landed>  ->  <target>  (adb-truncated push)', '  !! ERROR: <msg>', sync's '  … a/b GB (p% of run)', and 'Done. X ok, Y failed. Total ...'.",
      "purpose": "Live progress and forensic trace",
      "writer": "stderr writes in push_all_to_tablet.py:697-699, 705, 724-726, 749-754, 766, 776-780 and sync_to_tablet.py:800-803, 846-849, 861, 869-872",
      "reader": "_watch_progress.parse (22-39)"
    },
    {
      "file": "transfer_runner in-memory registry _TRANSFERS (no file)",
      "schema": "{id(16-hex): TransferState{id, ops[TransferOp{op, series_key, label, pc_path, tablet_path, bytes, display}], status queued|running|done|cancelled|aborted_errors, current_index, succeeded, failed, started_at, finished_at, cancel_event, _q(max 4096)}}. Events: batch_start{total_files, total_bytes}, file_start{label, op, bytes}, file_progress{label, pct, bytes_done}, file_done{label, ok, error?}, batch_done{succeeded, failed}, batch_cancelled, batch_aborted_due_to_errors{consecutive_failures, errors}, heartbeat; None sentinel ends the stream.",
      "purpose": "Job state and event stream for the web UI's selective transfers. Never evicted, never persisted.",
      "writer": "transfer_runner.start_transfer / _worker_main (85-117, 181-242)",
      "reader": "transfer_runner.get_transfer / iter_events (80-82, 130-155) -> manga_manager SSE (manga_manager.py:795-808)"
    }
  ],
  "observed_failures": [
    {
      "what": "adb push truncates a non-ASCII DESTINATION FOLDER name when pushing a directory (it keeps the first char-count bytes of the UTF-8), so the post-push rename failed and SPY×FAMILY was lost from that run.",
      "evidence": "transfer-log-20260524-015607.json:735-744 ('mv: bad /storage/self/primary/Documents/SPY×FAMILY: No such file or directory'); push_run.log:574-575. After the landed-name model was added: canary_stderr.log:9, 15 and full_mirror_stderr.log:192, 440, 546 ('SPY×FAMIL' -> 'SPY_x_FAMILY', 'Hell’s Paradise Jigokura' -> ..., 'You Can’t Be ... Childhood Friend' -> ..., all tagged '(adb-truncated push)').",
      "lesson": "Never let adb derive a non-ASCII leaf name from the source path: push to explicit remote file paths into pre-created folders, and verify landed names afterwards."
    },
    {
      "what": "The same truncation at FILE level on the first sync_to_tablet run: ASCII filenames inside non-ASCII series folders landed with clipped names (e.g. '…Mission 1.cb'), so a follow-up --verify planned 434 re-pushes and 434 deletes across 3 series.",
      "evidence": "synclogs07.md:1627-1656 (Hell’s Paradise Jigokuraku 131/131, SPY_x_FAMILY 154/154, You Can’t Be In a Rom-Com... 149/149). Fix and regression test: sync_to_tablet.py:824-834, 983-989. Repair run: sync-log-20260707-013548.json (433 pushed, 303 deleted).",
      "lesson": "Route by the WHOLE source path, not the filename. Always run a post-apply verification (listing + size, optionally hash). Include non-ASCII folders and files in tests."
    },
    {
      "what": "USB device dropped mid-push, and the run kept going: every one of the remaining 106 series failed instantly with 'device not found' instead of the run aborting.",
      "evidence": "sync-log-20260706-221724.json:4-5 (n_ok 9, n_fail 107); :92-98 (Bleach: 'adb: error: failed to read copy response: EOF', 600 files already pushed); 106 'device A06B4A372090333 not found' errors from :107 on. apply_plan catches per series and continues (sync_to_tablet.py:858-861).",
      "lesson": "Detect device loss (adb rc plus 'not found' / 'no devices' / 'EOF') and abort the whole run at once, like transfer_runner's consecutive-failure budget (transfer_runner.py:225-232). Offer 'reconnect and resume'. The per-batch journal made the resume cheap: sync-log-20260706-223001.json:4-7 (107 ok, 18,231 files, 133.45 GB) in 71.4 min (synclogs07.md:1626)."
    },
    {
      "what": "An interrupted run logged ok:false with error:null, after deleting 131 files and pushing only 1 in 2.8 s.",
      "evidence": "sync-log-20260707-013414.json (n_fail 1, deleted_files 131, pushed_files 1, error null). Only 'except Exception' is caught (sync_to_tablet.py:858-861), so KeyboardInterrupt escapes it while the finally block still writes the log (862-865).",
      "lesson": "Model cancellation explicitly (a 'cancelled' status with a reason) and make cancel cooperative between batches. Consider pushing replacements before deleting (or deleting only files that have no replacement) so an interrupted series isn't left short."
    },
    {
      "what": "A zero-byte stray temp log was left next to a valid log (the process was killed mid-rewrite).",
      "evidence": "Directory listing: sync-log-20260715-021752.json.tmp is 0 bytes (02:18) beside the 1,451-byte sync-log-20260715-021752.json. Writer pattern: sync_to_tablet.py:901-904.",
      "lesson": "Keep the tmp + os.replace atomic writes (they protected the real log) and sweep stale *.tmp files on startup."
    },
    {
      "what": "Reading the atomically rewritten JSON log mid-run can collide with the writer's os.replace on Windows and crash the run.",
      "evidence": "_watch_progress.py:4-6 (the reason it tails the stderr trace instead).",
      "lesson": "The UI must receive progress through an event stream (stdout JSON lines / IPC) and never poll or open the log file while a run is writing it."
    },
    {
      "what": "adb 36.0.2 rejects `adb push --progress` ('unrecognized option'), while older builds needed it.",
      "evidence": "manga_ops.py:157-162",
      "lesson": "Don't pass --progress; parse the default '[ NN%]' lines. Record the adb version in diagnostics."
    },
    {
      "what": "Device toybox `find` lacks some -printf directives (%h), and some builds lack -printf entirely.",
      "evidence": "_verify_chapters.py:37-38; compare_manga.py:543-545 (switch to the stat fallback), 554-568",
      "lesson": "Feature-detect device shell capabilities and keep a stat fallback."
    },
    {
      "what": "The target device changed (3CEF42502E91537 for the push_all runs, A06B4A372090333 for the sync runs). The journal is per serial, and a new device must be adopted with --verify.",
      "evidence": "push_run.log:2, canary_stderr.log:2, full_mirror_stderr.log:2 vs synclogs07.md:1629 and the .sync_state-A06B4A372090333.json filename; first-run note in sync_to_tablet.py:722-726",
      "lesson": "Use per-device profiles (serial -> tablet root, aliases, preserve list, journal). Prompt for 'verify / adopt' when an unseen device connects. Never rely on a hard-coded serial."
    },
    {
      "what": "The PC library root moved between runs.",
      "evidence": "push_run.log:9 (C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas) vs full_mirror_stdout.log:5 and synclogs07.md:1641 (D:\\AIO\\manga)",
      "lesson": "Roots must be settings (default = AIO's library root). The PC hash cache is keyed by absolute path (sync_to_tablet.py:282, 303) and misses silently after a move."
    },
    {
      "what": "The whole-folder replace mode destroys tablet-only chapters: its plan flagged 15 series where the tablet had at least 20 more chapters than the PC.",
      "evidence": "push_run.log:105-120 (e.g. push_run.log:107: -372 for JoJo's_Bizarre_Adventure_Part_4_Diamond_is_Unbreakable)",
      "lesson": "Show chapter-loss warnings with explicit confirmation, prefer file-level sync, and treat 'tablet has more' as needing review rather than silent deletion."
    },
    {
      "what": "PC-side chapter renames cause full delete + re-push even when the bytes are identical (there is no rename detection by hash).",
      "evidence": "sync-log-20260709-015153.json:65-70 (Nano Machine: 320 files / 3.28 GB pushed, 318 deleted, 111.66 s)",
      "lesson": "When a deleted tablet file's journal sha256 equals a to-push file's sha256 in the same folder, do a tablet-side mv instead of re-pushing."
    },
    {
      "what": "Aliases keyed by PC folder name break when AIO folder names change (site retitles fork or rename folders). push_all aborts the whole apply on any stale alias.",
      "evidence": "AIO/UI-source/electron/series-merge.js:4-8 (MangaDex retitled 'Isekai de Slow Life o (Ganbou)', forking a folder) vs alias entry push_all_to_tablet.py:91; abort path push_all_to_tablet.py:437-441, 902-904",
      "lesson": "Key aliases on stable series identity (.aio_series.json site+hid, .series_hid, anilist_id), with the folder name as a fallback. Surface stale aliases as warnings in the UI rather than blocking every sync."
    },
    {
      "what": "Mixed GB units for the same bytes in one run: progress uses decimal GB, the summary uses binary GiB labelled 'GB'.",
      "evidence": "synclogs07.md:1632-1633 ('152.7 GB' in progress vs 'hashed 20834 file(s) (142.3GB)'); sync_to_tablet.py:312-316 (divides by 1e9) vs 644-650 (divides by 1024)",
      "lesson": "Use one unit convention in the UI (reuse the app's existing byte formatter)."
    },
    {
      "what": "Performance baseline (not a failure): USB is the bottleneck, not adb call overhead.",
      "evidence": "Per-file push rates ~25-34 MB/s (synclogs07.md:3-150; push_run.log tail). Full re-mirror of 111 series: 104.7 min (full_mirror_stderr.log:553). Full sync of 133.5 GB: 71.4 min (synclogs07.md:1626). Incremental run of 27 series / 1,348 files / 10.3 GB in ~5.7 min (sync-log-20260715-022050.json:2-7). The one-call-per-file non-ASCII path moved 130-154 files in 40-45 s (sync-log-20260707-013548.json). PC re-hash of 20,834 files / 152.7 GB at ~6.1 GB/s (synclogs07.md:1632-1633).",
      "lesson": "Serial pushes are fine. Show byte-based progress and ETA. The default full re-hash is cheap only on fast or cached storage, so make cache trust (--fast) a setting with a periodic full re-hash."
    }
  ],
  "external_deps": [
    "Android platform-tools adb (observed at C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\ADB\\platform-tools\\adb.EXE, version 36.x). Known 36.x quirks: Windows UTF-8 leaf truncation on push (sync_to_tablet.py:420-429); --progress rejected by 36.0.2 (manga_ops.py:159-162); '[ NN%]' progress lines on stdout.",
    "A USB-debugging-enabled Android tablet (serials seen: 3CEF42502E91537, A06B4A372090333). Reader apps: Perfect Viewer (reason for tablet-safe name sanitizing, manga_ops.py:73-74) and Komikku (reads cover.jpg + details.json at the series root, sync_to_tablet.py:99-102; push_all_to_tablet.py:105-106).",
    "Device shell (toybox) utilities: find (with -printf, else -exec stat), sha256sum, rm -f / rm -rf, mkdir -p, mv, '[ -e ]', echo.",
    "Python 3.10+ standard library: argparse, concurrent.futures, hashlib, json, os, shlex, subprocess, threading, queue, secrets, dataclasses, unicodedata, re, datetime, pathlib.",
    "Sibling module compare_manga.py: DEFAULT_PC_ROOT, DEFAULT_TABLET_ROOT, DEFAULT_DEVICE_SERIAL, KNOWN_ADB_PATH, IGNORE_TOP_LEVEL, RE_HID_SUFFIX, resolve_adb, resolve_device, _run_adb_find, scan_pc_library, scan_tablet_library, normalize_series_name, rank_hid_variants, PCSeries/TabletSeries.",
    "Sibling module manga_ops.py: sanitize_tablet_segment, _validate_tablet_path, TransferError, mkdir_p_on_tablet, push_chapter, delete_tablet_file.",
    "Flask >=3.0,<4.0 and waitress >=3.0,<4.0 (requirements.txt), needed only by manga_manager.py, the web consumer of transfer_runner."
  ],
  "integration_notes": [
    "Nothing to reuse on the tablet side: the AIO working tree has no adb, tablet or Perfect Viewer code. A word-bounded grep over AIO/UI-source (excluding node_modules) only hits unrelated 'alias' uses (vite.config.js:8, electron/downloader.js:278, electron/searcher.js:58) and a 'PDF - Tablet reading' label (AIO/UI-source/src/components/DownloadTab.jsx:130). aio-dl.py has no adb or tablet hits. The sync engine has to be built from scratch in the app; there are no existing hard-coded tablet folders in the app to remove.",
    "What these scripts take from compare_manga, and what they duplicate:\n- sync_to_tablet uses cm.DEFAULT_PC_ROOT and DEFAULT_TABLET_ROOT (86-87), cm.IGNORE_TOP_LEVEL (187), cm._run_adb_find (339) and cm.resolve_adb/resolve_device (1044-1045). It does NOT use cm.scan_pc_library, normalize_series_name or the chapter patterns; it has its own scan_pc (176-216) keyed on .cbz/cover/details.\n- push_all uses cm.scan_pc_library (409-410), scan_tablet_library (883-885), normalize_series_name (427, 442, 445), rank_hid_variants (456), RE_HID_SUFFIX (405), resolve_adb/resolve_device (160-165) and DEFAULT_DEVICE_SERIAL (847).\n- verify_push uses scan_tablet_library (66-70) and normalize_series_name (103). _verify_chapters uses resolve_adb, DEFAULT_DEVICE_SERIAL, DEFAULT_TABLET_ROOT and scan_pc_library (18-20, 30).\n- Duplicates: push_all._validate_tablet_path (238-255) re-implements manga_ops._validate_tablet_path (86-107), raising ValueError and without the 4096-char cap. The sidecar list exists in three drifting copies (compare_manga.py:66, push_all_to_tablet.py:107, sync_to_tablet.py:97). _fmt_bytes appears twice (sync 644-650, push_all 512-518).",
    "Take sidecar and ignore names from AIO's own constants instead of copying them: AIO/aio_config.py:9-10 (.series_hid canonical, .mangafire_hid legacy), AIO/aio-dl.py:542 (_SERIES_META_FILENAME = .aio_series.json), AIO/aio-dl.py:952 (.aio_folder_alloc.lock), AIO/aio-dl.py:8355 (.aio_coord). The in-flight AIO/UI-source/electron/series-merge.js:52-68 already sorts series-folder files into SINGLETON_FILES (cover.jpg/jpeg/png/webp, details.json, .cover.jpg, download_params.json) and METADATA_FILES (.aio_series.json, .series_hid, .mangafire_hid, .DS_Store); reuse that split for 'mirror vs never mirror'.",
    "AIO creates '(hid=...)' suffixed folders on title collisions (AIO/aio-dl.py:936, 949, 1036), and the renderer parses 'Title (hid=xxx)' (AIO/UI-source/electron/downloader.js:393-395). The sync's hid-strip naming (compare_manga.py:107; push_all_to_tablet.py:404-406) exists because of this, so share one regex and one naming function.",
    "File-type gap to fix in the port: AIO writes .pdf/.epub/.cbz payloads (AIO/UI-source/electron/series-merge.js:54 PAYLOAD_EXTS; DownloadTab.jsx:130). sync_to_tablet mirrors only .cbz + cover.jpg + details.json (CompareManga/sync_to_tablet.py:168-173), and its delete-set would remove every other file type from a managed tablet folder (598-612). The port needs a configurable mirrored-types set per device/reader profile, and non-mirrored types must be left out of deletion.",
    "The app already has a pattern for destructive operations, in-flight in untracked AIO/UI-source/electron/series-merge.js:12-33. It always starts as a dry run the user confirms, never overwrites, only touches direct children of the library root, refuses while a download for that series is running, and lives in a standalone module with data-injected dependencies so it can be tested offline (tools/_test_series_merge.js). Tablet deletes and prune should follow the same rails, including skipping or refusing series with an active download.",
    "Series identity helpers exist for alias keys and for matching existing tablet folders: AIO/UI-source/electron/library.js exports seriesIdentityKey, normalizeSeriesUrl and extractChaptersFromFiles (imported by series-merge.js:44-50), and library.js:735 lists the cover filenames.",
    "Uncommitted local work touches the likely integration points. git status in AIO shows modified UI-source/electron/main.js, preload.js, library.js, downloader.js, src/App.jsx, src/components/LibraryTab.jsx, src/lib/utils.js, aio-dl.py and library_state.py, plus untracked UI-source/electron/series-merge.js, update-check-record.js and src/components/ChapterChips.jsx. The current branch is fix/mangafire-cloudflare-challenge with 1 unpushed commit (d1ae7d6). Adding the tab and IPC must not clobber these.",
    "Event model to port: transfer_runner's vocabulary (batch_start, file_start, file_progress, file_done, batch_done, batch_cancelled, batch_aborted_due_to_errors, heartbeat; CompareManga/transfer_runner.py:71-73, 161-242) plus sync's per-series header and run-percent lines (sync_to_tablet.py:800-803, 844-849) map directly onto Electron IPC progress events. Never poll the JSON log (_watch_progress.py:4-6).",
    "Use one naming function. Today the scripts disagree: sync uses alias -> hid-strip -> sanitize (sync_to_tablet.py:219-228), while manga_manager's selective push names new folders after the sanitized canonical PC folder INCLUDING the hid suffix and without aliases (manga_manager.py:554-566). The port should have a single resolveTabletName() shared by sync, selective push and verify.",
    "The shared push primitive needs the non-ASCII fix. manga_ops.push_chapter still pushes to 'dest/' with a trailing slash (manga_ops.py:157-169), which is exposed to the adb UTF-8 truncation that sync_to_tablet works around (sync_to_tablet.py:417-462).",
    "Folder adoption is missing from the newer engine. push_all could match existing differently-named tablet folders (normalize + aliases) and mv them into place (push_all_to_tablet.py:296-305, 413-504); sync_to_tablet cannot (219-228, 577-579). The port should put an 'adopt/rename existing tablet folder' step into the plan so existing tablet libraries don't end up with duplicates.",
    "Existing CompareManga state can be imported to skip a slow first verify: .sync_state-A06B4A372090333.json (per-file size + sha256 keyed 'tabletFolder/filename') and .pc_hash_cache.json (absolute PC path -> size/mtime/sha256). Schemas are in state_files."
  ],
  "open_questions": [
    "Where should the engine live? Node in the Electron main process (spawning adb directly; testable like series-merge.js), or a Python module / aio-dl.py subcommand? The Android/Chaquopy build shares aio-dl.py, where adb makes no sense.",
    "Retire push_all's wipe-and-re-push model entirely in favour of file-level sync, keeping only its 'adopt/rename existing tablet folders' matching as a one-time step? Or also offer a 'full re-mirror' maintenance action?",
    "Which file types should be mirrored per device/reader? Today it is only .cbz + cover.jpg + details.json, and everything else in managed folders gets deleted. Should PDFs and EPUBs from AIO be mirrored? Should there be Perfect Viewer and Komikku presets?",
    "Tablet root per reader: /storage/self/primary/Documents today (Perfect Viewer). Komikku's local source usually uses its own folder. Should one device support several destination roots or profiles?",
    "How should aliases work in the UI? As 'PC series -> tablet folder name' overrides only, or also as 'existing tablet folder <-> PC series' match bridges for adopting folders? Should they be keyed on stable identity (site+hid / .series_hid / anilist_id) instead of the PC folder name, which changes on retitles?",
    "Default delete policy: mirror deletes (current behaviour), additive-only, or ask on every run? What should happen to tablet-only files inside managed folders (user-added, or chapters AIO removed)? Is a mass-delete threshold guard wanted?",
    "Should orphaned-folder prune stay opt-in per run, or allow 'always prune'? Beyond automatic 'never-journaled = preserved' detection, should users keep an explicit preserve list (e.g. SHELTER) that verification checks?",
    "Hashing policy: re-hash the whole library every run (the script default, tuned for NVMe), or trust the (size, mtime) cache by default with a manual or periodic full re-hash? When should a tablet-side sha256 verify run: manually, on a schedule, or only for a new device?",
    "Devices: multiple profiles keyed by serial? Wireless adb (adb connect host:port)? Bundle platform-tools with the app, or auto-detect on PATH and let the user set a path?",
    "While AIO downloads are running, should sync skip or refuse the affected series (the series-merge.js precedent) or wait for the queue to drain?",
    "Is the selective per-chapter push/delete (manga_manager + transfer_runner) in scope for the new tab, or only whole-library / per-series sync?",
    "Should the existing CompareManga state (.sync_state-A06B4A372090333.json, .pc_hash_cache.json, the 14 aliases) be imported on first run?",
    "Run history: keep per-run logs in app data with a retention limit and show them in the tab?",
    "After every apply, run an automatic quick verify (listing + sizes) with an optional full hash verify? Should chapter renames be detected by hash and applied with a tablet-side mv instead of a re-push?"
  ]
}
```
