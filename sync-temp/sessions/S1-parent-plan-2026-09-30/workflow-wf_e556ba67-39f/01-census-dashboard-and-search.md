# Workflow wf_e556ba67-39f — census:dashboard-and-search (phase Census)

```json
{
  "area": "dashboard-and-search",
  "summary": "This area covers the local web dashboard, its adb helper layers, and the batch search / seed-link scripts.\n\n(1) manga_manager.py is a Flask + waitress web app bound to 127.0.0.1:5000. It opens the browser automatically (manga_manager.py:1-22, 879-941). It does not scan anything itself. It imports compare_manga.py as a library (manga_manager.py:49) to scan the PC library (os.scandir) and the tablet. The tablet scan is one `adb shell find ... -printf` call, cached in .tablet_cache.json with a 24h TTL (compare_manga.py:521-754). It then matches series by normalized folder name only. There is no alias table anywhere in the dashboard path (compare_manga.py:292-307, 762-793). It also detects anomalies.\n\nIt flattens the result into a view-model that is memoized for 120 s (manga_manager.py:155-254). The page is rendered with Jinja + HTMX (base.html, partials/*) and one vanilla JS file (static/app.js). Layout: a 'Catalog.' summary strip with 6 counters and a two-column layout. The left column holds fixed sections: Tablet missing / Only on tablet / Shared · gaps, plus collapsible Synced and Anomalies folds. The right column is a detail card: cover, stats, a per-chapter table of PC vs tablet size, format and suggested push/delete, and 'Select all N to push/delete' buttons.\n\nEvery row and chapter has a checkbox that adds to a client-side selection set. Keys are op|series_key|label, and label '*' means the whole series (app.js:8-73). A sticky action bar appears with a count, Clear and 'Preview transfer'. The preview POSTs the selection. The server resolves it into concrete TransferOps and returns a confirm modal grouped by series, with push/delete counts, bytes and skipped reasons. 'Apply transfer' starts a background batch (transfer_runner.py) and shows a progress modal fed by Server-Sent Events: batch bar, file bar, a newest-first log, and Cancel. transfer_runner calls manga_ops.py, which runs `adb -s <serial> shell mkdir -p`, `adb push <file> <dir>/` and `adb shell rm -f <file>`. Every path passes a validator (must be under the tablet root, never the root itself, no '..', no control characters, max 4096 chars). There is no rm -rf, and folder delete is a stub.\n\nThere are no search/filter/sort controls in the UI. Ordering is fixed (manga_manager.py:204-211).\n\nScreenshots:\n- dash-01: the empty dashboard.\n- dash-02: the One Piece detail.\n- dash-03: one chapter selected, with the action bar.\n- dash-04: the confirm modal.\n- dash-05: a failed push, caused by adb 36 rejecting --progress.\n- dash-06: a successful push in the progress modal.\n- dash-07: the bottom of 'Only on tablet', showing the user's leftover `webp_test` folder, and 'Shared · gaps'.\n- dash-08: whole-series delete of webp_test resolving to 0 ops ('Skipped (1) no chapters available for this op'), the bug before orphan support.\n- dash-09/10: after the fix, the confirm modal lists `_pdftoppm_out-01.ppm` (2.5 MB). Despite its name, dash-10 still shows the confirm step.\n- dash-11: the delete succeeded.\n\n(2) batch_search.py does NOT call the AIO CLI. It os.chdir()s into a hard-coded AIO checkout path, which no longer exists. It then imports AIO's Python internals in-process: sites.search_orchestrator.search_all, ProbeFailureCache, ImageQualityCache and the constants, plus aio_search_cli's private _scraper_factory_for / _search_make_request_factory. It monkey-patches PROBE_PHASE_DEADLINE_S to 45 s. It then loops over a hard-coded 64-entry (tablet_folder -> search query) table with seeded_only=True, language en, parallelism 6, per-site timeout 8 s and min_match 0.55. The top-5 SeriesCandidate.to_json() results per folder are saved incrementally and atomically to seed_links.json, plus a seed_links.txt summary. Reruns resume by skipping entries that have no error.\n\nA 'seed link' is the best source URL per tablet series, used to (re)download that series with AIO. fixup_seed_links.py hand-patches 3 entries: SHELTER gets a pinned Webtoon Canvas URL, and Tensura and Eleceed get a preferred source promoted to rank 0. render_seed_links.py renders seed_links.md (top pick per series) and seed_links_full.md (up to 5 ranked sources per series). None of the seed_links.* files exist any more.\n\nDurable: the compare / preview / push / delete / progress dashboard and a 'find the best source for each series' batch search. One-off: the concrete 64-series table, the 3 fixups and the markdown renderers.",
  "features": [
    {
      "name": "Catalog summary strip",
      "description": "Heading 'Catalog.' + 6 counters: PC folders, Tablet folders, matched, tablet missing (=totals.pc_only), PC missing (=totals.tablet_only), anomalies; plus a line '<n> ch. (<size>) on PC · <n> ch. (<size>) on tablet'.",
      "source": "templates/partials/dashboard_root.html:3-19; manga_manager.py:217-238",
      "durable": true,
      "notes": "dash-01.png shows 41 / 54 / 23 / 18 / 31 / 15 and '8675 ch. (134.6 GB) on PC · 11823 ch. (143.2 GB) on tablet'. Quirk: 'tablet missing' counts every PC-only series, including 0-chapter PC folders that the list moves to 'Only on tablet' (manga_manager.py:229 vs 265), so the counter can disagree with the list length. Totals also computed but never displayed: pc_logical_series, cache_status, tablet_file_count (manga_manager.py:222-226, 246-247)."
    },
    {
      "name": "Sectioned series list (Tablet missing / Only on tablet / Shared · gaps / Synced fold / Anomalies fold)",
      "description": "Left column (40% of the 40/60 grid). Each matched series becomes a row. Rows are classified tablet_missing (PC only, >0 chapters), pc_missing (tablet only, or a PC folder with 0 chapters), or shared. Shared series with no missing and no extra chapters go to a collapsed 'Synced (N)' <details>. Anomalies are grouped by kind in a collapsed <details>. Row content: checkbox (whole-series op), title (.aio_series.json title or folder name), status badge ('完' hanko stamp if Completed, italic 'ongoing', 'hiatus' if status contains hiatus), and meta. Meta per side: tablet_missing 'no. N ch. · size'; pc_missing 'no. N files · size'; shared 'N ch. / M on tab.' with chips 'N missing' (vermillion), 'N extra' (gold) or 'synced'. Clicking a row loads its detail via HTMX GET.",
      "source": "templates/partials/dashboard_root.html:21-78; templates/partials/series_list.html:1-14; templates/partials/_series_row.html:1-60; manga_manager.py:186-211, 257-341",
      "durable": true,
      "notes": "No search box, filter or sort control exists. The only 'filters' are the fixed sections. Fixed ordering (manga_manager.py:204-211): tablet_missing by PC chapter count desc then title; pc_missing by tablet file count desc then title; shared = series with missing first, then extras-only, then synced, each by -missing count then title. Row checkbox op (_series_row.html:2-8): push ('Push all') for tablet_missing/shared, delete ('Delete all') for pc_missing, and delete ('Delete extras') for shared rows with only extras. The row hover edge bar is the only 'active' cue; aria-selected is styled but never set (styles.css:314-328). Quirk: tablet-only EMPTY folders render as shared+synced (manga_manager.py:286-300). dash-07.png shows the bottom of 'Only on tablet' (Sakamoto Days 23 files 1.2 GB ... Vivy_-Fluorite_Eye's_Song-, Makeine..., webp_test 1 files 2.5 MB) and 'SHARED · GAPS (12)' (One Piece 1197/1 [1196 MISSING], Frieren HIATUS 152/0, Apothecary Diaries 85/14 [71 MISSING], Kagurabachi 125/97 [32 MISSING][4 EXTRA], Blue Box 239/212 [27 MISSING])."
    },
    {
      "name": "Series detail card",
      "description": "Right column. Contents: title; byline '<pc folder> · tab. <tablet folder>' or '· not on tablet' / 'not on PC'; big status badge; cover image (/api/cover); stats: on PC N ch. (size), on tablet N ch. (size), 'to push' N (red), 'to delete' N, 'last download' = mtime of the PC .aio_series.json. Buttons 'Select all N to push' and 'Select all N to delete' toggle every matching checkbox in the table. The card's left edge colour encodes the side: gold = shared, vermillion = tablet_missing, grey = pc_missing.",
      "source": "templates/partials/series_detail.html:1-68; manga_manager.py:344-409, 702-710; static/styles.css:466-482; static/app.js:59-70",
      "durable": true,
      "notes": "dash-02-onepiece.png: ONE PIECE, 'One Piece · not on tablet', ONGOING, cover, ON PC 1197 ch. (8.3 GB), ON TABLET 0 ch. (-), TO PUSH 1197 ch., LAST DOWNLOAD 2026-04-26, 'SELECT ALL 1197 TO PUSH'. Display title and folder come from the canonical hid variant (most chapters, then valid JSON, then name; compare_manga.py:850-856). A Refresh replaces #dashboard-root, so the detail resets to 'Pick a title from the catalog.'."
    },
    {
      "name": "Per-chapter comparison table",
      "description": "One row per chapter label in the union of PC and tablet labels, sorted AIO-style (8 < 8~5 < 8.5 < 9). Columns: checkbox (only when suggested op is push or delete), chapter label, fmt (shows 'pdf→cbz' when PC and tablet formats differ), PC size, tablet size, action mark ('push' red / 'delete' on a vermillion wash). Suggested op: label only on PC → push; label only on tablet → delete.",
      "source": "templates/partials/_chapter_table.html:1-44; manga_manager.py:353-377, 412-437; compare_manga.py:232-255",
      "durable": true,
      "notes": "PC side: union across hid variants, keeping the LARGEST file per label (manga_manager.py:412-425). This differs from compare_manga's first-wins rule (compare_manga.py:796-808). Tablet side: depth-1, labelled files only (manga_manager.py:428-437), so unlabelled or nested tablet files never appear in the table. Every row is rendered (1197 rows for One Piece), with no virtualization or pagination."
    },
    {
      "name": "Selection model + sticky action bar",
      "description": "Client-side Set of 'op|series_key|label' keys ('*' = whole series). Checkbox changes are captured by event delegation. State is restored onto checkboxes after every HTMX swap. body.has-selection slides up a fixed action bar showing 'no. N selected · N push · N delete · (K whole-series)' with Clear and 'Preview transfer' buttons. The Apply button plays a one-shot shake animation when a request starts.",
      "source": "static/app.js:8-129; templates/base.html:43-59; static/styles.css:736-778, 720-723",
      "durable": true,
      "notes": "dash-03-selected.png: chapter 0 checked, bar 'no. 1 selected · 1 push'. dash-08: webp_test row checked (red check = delete), '1 delete · (1 whole-series)'. A whole-series pick counts as 1 in the bar; the preview expands it. Keys are split on '|' (app.js:37-40), so a label containing '|' would break."
    },
    {
      "name": "Transfer preview / confirm modal",
      "description": "POST /api/preview with {ops:[{op,series_key,label}]}. The server resolves the ops: dedupes, expands '*', silently skips pushes whose label is already on the tablet, and resolves deletes by label OR filename. It renders a modal: totals (N push (bytes), N delete (bytes), N files total (bytes)); a 'Skipped (N)' box listing reasons; one <details> per series sorted by title (first 4 open), each listing 'push/delete no. <label> <size>'. Buttons: Cancel, and 'Apply transfer →' (only when files > 0), which re-sends the exact resolved op list. The overlay closes on ×, Cancel or Esc.",
      "source": "manga_manager.py:445-551, 712-758; templates/partials/confirm_modal.html:1-77; static/app.js:229-236",
      "durable": true,
      "notes": "dash-04-modal.png: 1 push (6.0 MB) / 0 delete (0 B) / 1 file total; group 'One Piece push 1: PUSH no. 0 6.0 MB'. dash-08-deletepreview.png: 0/0/0 and 'SKIPPED (1) no chapters available for this op', with only Cancel. dash-09/dash-10: 1 delete (2.5 MB), 'webp_test delete 1: DELETE no. _pdftoppm_out-01.ppm 2.5 MB'. Skip reasons: 'not an object', 'missing op/series_key/label', 'unknown series …', 'no chapters available for this op', 'no <op> candidate for <label>' (manga_manager.py:463-499). This modal is the ONLY confirmation step: no typed confirmation and no separate warning for deletes."
    },
    {
      "name": "Push chapters PC → tablet",
      "description": "Each push op: mkdir -p the tablet series dir, then `adb -s <serial> push <pc_file> <dir>/` (the trailing slash keeps the source filename). Progress is parsed from 'NN%' in merged stdout+stderr, splitting on \\r|\\n. Cancel terminates adb, then kills it after 5 s. A missing final 100% is synthesized. For a series not yet on the tablet, the folder is <tablet_root>/<sanitize_tablet_segment(canonical PC folder name)>.",
      "source": "manga_manager.py:503-513, 530-538, 554-576; transfer_runner.py:245-294; manga_ops.py:110-264",
      "durable": true,
      "notes": "The PC source is the canonical variant's folder + the chosen file (manga_manager.py:556). A PC folder with a '(hid=X)' suffix would create a tablet folder carrying that suffix, because sanitize only strips /\\:*?\"<>| and control chars (manga_ops.py:44, 70-83). The user can't choose the tablet folder name; this is where a configurable folder/alias map must plug in. dash-06-pushing.png: 'PUSH One Piece Ch 1', 1 of 1 · 19.8 MB, 1 ok · 0 failed. The detail behind it now reads 'One Piece · tab. One Piece', 1 ch. on tablet."
    },
    {
      "name": "Delete tablet-only chapters / orphan files",
      "description": "Single-file delete `adb -s <serial> shell rm -f '<path>'`, depth-1 files only. Per-chapter checkboxes are offered only for labels that exist on the tablet but not on the PC. A whole-series delete ('Delete all' on Only-on-tablet rows, 'Delete extras' on extras-only shared rows) expands to EVERY depth-1 tablet file in that series, including unlabelled orphans; the op label is then the filename.",
      "source": "manga_manager.py:514-526, 539-550, 579-599; manga_ops.py:267-302; templates/partials/_series_row.html:2-8",
      "durable": true,
      "notes": "'webp test' is not a feature. It is the user's leftover tablet folder `webp_test` holding `_pdftoppm_out-01.ppm` (code comments also mention webp_test/0.webp, manga_manager.py:518-520, 542-543), used to exercise orphan deletes. dash-08 shows the pre-fix failure, dash-09/10 the fixed preview, and dash-11 'DELETE webp_test · _pdftoppm_out-01.ppm' 1 ok. Folders are never removed: delete_tablet_dir raises NotImplementedError (manga_ops.py:290-302). See destructive_ops for the 'Delete extras' over-reach."
    },
    {
      "name": "Live progress modal with cancel (SSE)",
      "description": "POST /api/transfer starts one background batch (only one at a time globally; a second returns 409 with active_transfer_id) and returns a modal subscribed to GET /api/transfer/<id>/stream (Server-Sent Events, 15 s heartbeat comments). Events: batch_start{total_files,total_bytes}; file_start{label,op,bytes}; file_progress{label,pct,bytes_done} (throttled to 0.2 s); file_done{label,ok,error?}; batch_done{succeeded,failed}; batch_cancelled; batch_aborted_due_to_errors{consecutive_failures,errors}. The UI shows 'X of N · bytes', 'N ok · N failed', a batch bar, a current-file label 'PUSH/DELETE <display>' with its own bar, and a newest-first log '[hh:mm:ss] ok|fail|start|cancel|abort <label> ← <error>'. Cancel does POST /api/transfer/<id>/cancel (cooperative). The × close is disabled until a terminal event; Esc does nothing mid-transfer. On 'done' the selection is cleared.",
      "source": "manga_manager.py:760-813; transfer_runner.py:85-242; templates/partials/progress_modal.html:1-45; static/app.js:89-102, 133-225",
      "durable": true,
      "notes": "Aborts after 3 consecutive failures (error_budget=3, transfer_runner.py:91, 225-232). If the SSE client disconnects the transfer keeps running with no re-attach (transfer_runner.py:136-138). Completed transfers stay in memory until restart (transfer_runner.py:18-19). dash-05-progress.png: failure log '[06:20:21 PM] fail One Piece Ch 0 ← adb push failed (exit 1) for One Piece Ch 0…'. dash-06 / dash-11: success runs. Nothing re-scans after a batch (app.js:170-181), so the view stays stale until Refresh."
    },
    {
      "name": "Refresh / rescan with cached tablet listing",
      "description": "Header 'Refresh' button: POST /api/refresh forces a fresh adb scan (bypassing the 24h .tablet_cache.json) and re-renders the whole dashboard. Otherwise the view model is rebuilt when older than 120 s or when the cache file's mtime is newer than the view; those rebuilds re-read the cached tablet listing and re-scan the PC.",
      "source": "templates/base.html:24-32; manga_manager.py:155-170, 173-184, 815-822; compare_manga.py:571-754",
      "durable": true,
      "notes": "The tablet scan is one adb round-trip: depth-1 dirs, a sentinel, then `find -type f -printf '%s|%T@|%p\\n'`, with a `stat -c` fallback when -printf is unsupported (compare_manga.py:521-568). Timeouts are 180 s / 600 s. Empty tablet series dirs are kept (cache v2)."
    },
    {
      "name": "Anomalies panel",
      "description": "Collapsed fold 'Anomalies (N)' grouped by kind in the order hid_variants, format_mismatch, size_mismatch, single_bundled_file, orphan, empty_pc_folder, malformed_json. Each item shows its severity (info grey / warn gold / error vermillion) and a detail string.",
      "source": "templates/partials/dashboard_root.html:52-76; manga_manager.py:71-79, 182-184, 213-215; compare_manga.py:859-1079",
      "durable": true,
      "notes": "Only size_threshold_pct is configurable (--size-threshold, default 30). The truncation-stub rule (tablet <1 KiB while PC >100 000 B) and the error-if-shrink>2×threshold rule are fixed (compare_manga.py:957-961). Warns are consolidated per series when there are ≥3 (compare_manga.py:982)."
    },
    {
      "name": "Cover proxy with disk cache",
      "description": "GET /api/cover/<norm_key>: serve static/covers/<sha1(norm_key)[:12]>.jpg if cached. Otherwise read the 'cover' URL from the canonical PC .aio_series.json and fetch it server-side (UA 'CompareManga/1.0', 5 s timeout, image/* only, atomic write). If that fails, 302 to the CDN URL so the browser fetches it. With no URL, return a cream SVG placeholder with the title.",
      "source": "manga_manager.py:602-664, 824-857",
      "durable": true,
      "notes": "The AIO library already manages covers (cover.jpg in the series root, UI-source/electron/library.js:729 comment), so the port should reuse those. 9 cached covers exist in static/covers."
    },
    {
      "name": "adb + device resolution and startup validation",
      "description": "adb: --adb override → PATH → KNOWN_ADB_PATH. Device: `adb devices`; the --device override must be connected; with one device use it; with several prefer DEFAULT_DEVICE_SERIAL, else error. Also checks that the PC root exists. Exits with code 2 on any failure. The resolved serial is shown in the header with a pulse dot. PC root, tablet root and render time are shown in the footer colophon.",
      "source": "manga_manager.py:890-941; compare_manga.py:444-489; templates/base.html:16-35, 61-67",
      "durable": true,
      "notes": "Resolution happens once at startup; there is no reconnect or device switching while running. dash-03 colophon: 'C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas · /storage/self/primary/Documents · 2026-05-11 18:16'."
    },
    {
      "name": "Tablet path safety layer",
      "description": "_validate_tablet_path runs before every adb call. It rejects: empty paths, >4096 chars, \\n \\r NUL, the root itself (with or without a trailing slash), anything not under root+'/' (which blocks prefix tricks like DocumentsX), and any '..' segment. Arguments are shlex.quote'd for shell commands. sanitize_tablet_segment: NFKC, strip /\\:*?\"<>| and control chars, trim trailing dots/spaces, reject ''/'.'/'..'. A self-test is included.",
      "source": "manga_ops.py:41-47, 70-107, 305-368",
      "durable": true,
      "notes": "Port these as main-process guards plus unit tests. The self-test root '/storage/self/primary/Documents' is test-only (manga_ops.py:310)."
    },
    {
      "name": "Batch cross-site search → best seed URL per tablet series",
      "description": "For each (tablet_folder, query) in a fixed list, call AIO's search_all with seeded_only=True and persist the top-5 candidates per folder to seed_links.json after every query (atomic tmp + replace). seed_links.txt is regenerated each time. Progress goes to stderr as '[i/64] searching ...' plus orchestrator status lines and '=> N candidates in Xs; top=<site> <url>'. Rerunning resumes, skipping folders already present without an error. Errors are recorded per folder and the loop continues.",
      "source": "batch_search.py:1-284",
      "durable": true,
      "notes": "This is a durable capability ('find sources for my tablet-only / missing series'), but the implementation is not reusable. It imports private AIO internals in-process from a dead hard-coded path (batch_search.py:35, 41-54) and monkey-patches PROBE_PHASE_DEADLINE_S (batch_search.py:62-64). The inputs should come from the live comparison (e.g. the tablet-only list), with per-series query overrides. Folders without a query override should get the derived query (underscores→spaces). Entries with 0 candidates but no error are never retried (batch_search.py:222-224)."
    },
    {
      "name": "Seed-link report rendering",
      "description": "render_seed_links.py → seed_links.md: table '# | Tablet folder | Best site | Match | Composite | Top URL' (ERROR / (none) rows). seed_links_full.md: per series its search query, top candidate title/year/source count, and up to 5 sources 'Rank | Site | Match | Seed | Img | Composite | Chapters | DMCA | URL'. batch_search.render_txt → seed_links.txt 'folder | url | site | composite | title'.",
      "source": "render_seed_links.py:1-105; batch_search.py:181-206",
      "durable": false,
      "notes": "The Markdown/text formats are one-off. The durable part is the data view (ranked sources per series with match, seed, image quality, composite, chapter count, DMCA), which AIO's Search tab result cards already render (SearchSourceCard per search_orchestrator.py:478-482)."
    },
    {
      "name": "Manual seed-link overrides",
      "description": "fixup_seed_links.py rewrites seed_links.json in place. It replaces SHELTER with a hand-curated Webtoon Canvas source, and promotes the mangafire main-series URL (Tensura) and the official linewebtoon URL (Eleceed) to source rank 0, marking manual_override + override_reason.",
      "source": "fixup_seed_links.py:1-117",
      "durable": false,
      "notes": "The three concrete edits are one-off data patches. The generalizable features: (a) per-series pinned URL; (b) per-series 'prefer site X / URL containing Y'. The Eleceed case is now handled by AIO's is_official tiebreak (search_orchestrator.py:440-444)."
    },
    {
      "name": "Local web server shell",
      "description": "Flask app factory + waitress on 127.0.0.1:5000. It auto-opens the default browser 0.5 s after start (unless --no-browser). Static assets and Google-free font CDN (fonts.bunny.net), htmx 1.9.12 + json-enc from unpkg.",
      "source": "manga_manager.py:672-691, 879-941; templates/base.html:1-13",
      "durable": false,
      "notes": "Replaced by an Electron tab + IPC in the port. Nothing to keep except the route semantics."
    }
  ],
  "hardcodes": [
    {
      "script": "manga_manager.py",
      "name": "HOST_DEFAULT / PORT_DEFAULT",
      "value": "'127.0.0.1' / 5000",
      "purpose": "Flask/waitress bind address",
      "source": "manga_manager.py:58-59",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "COMPARISON_TTL_SEC",
      "value": "120.0",
      "purpose": "How long the memoized comparison view is reused before re-scanning the PC and re-reading the tablet cache",
      "source": "manga_manager.py:61-63, 155-170",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "COVER_FETCH_TIMEOUT / COVER_USER_AGENT",
      "value": "5.0 s / 'CompareManga/1.0'",
      "purpose": "Server-side cover download",
      "source": "manga_manager.py:65-67",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "ANOMALY_KIND_ORDER",
      "value": "('hid_variants','format_mismatch','size_mismatch','single_bundled_file','orphan','empty_pc_folder','malformed_json') — duplicate of compare_manga._ANOMALY_KIND_ORDER (compare_manga.py:216-224)",
      "purpose": "Display order of anomaly groups",
      "source": "manga_manager.py:69-79",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "COVERS_DIR",
      "value": "<SCRIPT_DIR>/static/covers ; file name = sha1(norm_key)[:12] + '.jpg'",
      "purpose": "Cover cache location",
      "source": "manga_manager.py:81, 607-609",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "_State defaults",
      "value": "pc_root=cm.DEFAULT_PC_ROOT; tablet_root=cm.DEFAULT_TABLET_ROOT; size_threshold=30.0 (does NOT use cm.DEFAULT_SIZE_THRESHOLD_PCT); cache_file=<SCRIPT_DIR>/.tablet_cache.json; cache_ttl_hours=cm.DEFAULT_CACHE_TTL_HOURS (24.0)",
      "purpose": "Runtime config, overridable by CLI flags",
      "source": "manga_manager.py:135-142, 899-905",
      "should_be_user_setting": true
    },
    {
      "script": "manga_manager.py",
      "name": "Section sort rules",
      "value": "tablet_missing: (-pc_chapters, title.casefold()); pc_missing: (-tablet_chapters, title.casefold()); shared: (0 if missing else 1 if extra else 2, -len(missing), title.casefold())",
      "purpose": "Fixed list ordering (no UI sort control)",
      "source": "manga_manager.py:202-211",
      "should_be_user_setting": true
    },
    {
      "script": "manga_manager.py",
      "name": "Whole-series sentinel and op key format",
      "value": "label '*' = whole series; key 'op|series_key|label' (also in app.js:15)",
      "purpose": "Selection/op identity",
      "source": "manga_manager.py:375-376, 478-488; static/app.js:9-15",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "SSE heartbeat / cover HTTP cache",
      "value": "heartbeat_sec=15.0; cover max_age=86400",
      "purpose": "Stream keep-alive; browser cover caching",
      "source": "manga_manager.py:800, 839, 847",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "SVG placeholder cover",
      "value": "280x420 rect fill #ebe1cf stroke #2a2520; text Cormorant SC 22px #1a1614; title truncated at 60 chars",
      "purpose": "Cover fallback",
      "source": "manga_manager.py:650-664",
      "should_be_user_setting": false
    },
    {
      "script": "manga_manager.py",
      "name": "Browser auto-open delay",
      "value": "0.5 s",
      "purpose": "Opens the dashboard URL after start",
      "source": "manga_manager.py:879-887",
      "should_be_user_setting": false
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "DEFAULT_PC_ROOT",
      "value": "D:\\AIO\\manga (moved from C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas on 2026-06-14 per comment; the May screenshots still show the old path)",
      "purpose": "PC library root = AIO's download folder",
      "source": "compare_manga.py:51-55; _screens/dash-03-selected.png footer",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "DEFAULT_TABLET_ROOT",
      "value": "/storage/self/primary/Documents",
      "purpose": "Tablet library root (Perfect Viewer folder)",
      "source": "compare_manga.py:56",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "DEFAULT_DEVICE_SERIAL",
      "value": "3CEF42502E91537 (a second serial A06B4A372090333 appears in .sync_state-A06B4A372090333.json)",
      "purpose": "Preferred adb device when several are connected",
      "source": "compare_manga.py:57, 485-486",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "KNOWN_ADB_PATH",
      "value": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\ADB\\platform-tools\\adb.exe",
      "purpose": "adb fallback when not on PATH",
      "source": "compare_manga.py:58, 444-457",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "DEFAULT_CACHE_TTL_HOURS / DEFAULT_SIZE_THRESHOLD_PCT",
      "value": "24.0 h / 30.0 %",
      "purpose": "Tablet listing cache TTL; size-mismatch anomaly threshold",
      "source": "compare_manga.py:59-60",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "IGNORE_TOP_LEVEL / IGNORE_SERIES_FILES",
      "value": "IGNORE_TOP_LEVEL = {'.aio_coord', '.aio_folder_alloc.lock'} (plus any dot-prefixed entry); IGNORE_SERIES_FILES = {'.aio_series.json', '.mangafire_hid'} (plus any dot-prefixed file). The PC scan only counts .pdf/.cbz; the tablet scan counts every non-dot, non-ignored file, INCLUDING cover.jpg/details.json",
      "purpose": "Skip lists for PC and tablet scans",
      "source": "compare_manga.py:63-66, 342, 389-400, 676-678",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "CHAPTER_PATTERNS (first match wins)",
      "value": "A RE_CH_SPACES ^(?P<prefix>.+?)\\s+Ch\\s+(?P<label>\\d+(?:[.~]\\d+)?)\\s*\\.(?P<ext>pdf|cbz)$ ; B RE_CH_UNDERSCORED ^(?P<prefix>.+?)_(?P<site>[a-z]+)_Ch_(?P<label>\\d+(?:[.~]\\d+)?)\\s*\\.(?P<ext>pdf|cbz)$ ; C RE_CH_CHAP_TITLE ^Chap\\s+(?P<label>\\d+(?:[.~]\\d+)?)\\b.*\\.(?P<ext>pdf|cbz)$ ; D RE_CH_CHAPTER ^Chapter\\s+(?P<label>\\d+(?:[.~]\\d+)?)\\s*\\.(?P<ext>pdf|cbz)$ ; E RE_CH_HASH ^#(?P<label>\\d+)\\s*-.*\\.(?P<ext>pdf|cbz)$ ; F RE_CH_VOL ^Vol\\s+(?P<label>\\d+)\\s*\\.(?P<ext>pdf|cbz)$ (all IGNORECASE). NO Komikku pattern (e.g. 'Ch.001 - Chapter 1.cbz'), which the current tablet cache is full of.",
      "purpose": "Chapter label extraction on both sides",
      "source": "compare_manga.py:68-103, 280-289",
      "should_be_user_setting": true
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "Name normalization tables",
      "value": "RE_HID_SUFFIX ^(.+?)\\s*\\(hid=(.*?)\\)\\s*$ ; apostrophes deleted: ' ’ ‘ ; mapped to space: \" “ ” , . ! ? : ; ( ) [ ] - – — / ; plus NFKC, casefold, '_'→' ', collapse whitespace",
      "purpose": "The ONLY series-matching mechanism (no alias map exists in the dashboard path)",
      "source": "compare_manga.py:105-116, 292-307",
      "should_be_user_setting": false
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "Tablet scan constants",
      "value": "CACHE_VERSION=2; _DIR_SENTINEL='---COMPARE_MANGA_DIRS_END---'; adb find timeout 180 s; stat fallback timeout 600 s; adb devices timeout 15 s",
      "purpose": "adb enumeration and cache",
      "source": "compare_manga.py:143, 492, 539, 564, 464",
      "should_be_user_setting": false
    },
    {
      "script": "compare_manga.py (consumed by manga_manager.py)",
      "name": "Size-anomaly rules",
      "value": "truncated_stub = tablet < 1024 B AND pc > 100000 B; error if shrink_pct > 2×threshold; ≥3 warns consolidated into one per-series warn",
      "purpose": "size_mismatch severity",
      "source": "compare_manga.py:957-961, 982-1006",
      "should_be_user_setting": false
    },
    {
      "script": "manga_ops.py",
      "name": "Path/segment safety constants",
      "value": "_FORBIDDEN_SEGMENT_CHARS = [/\\\\:*?\"<>|\\x00-\\x1f]; _BAD_PATH_CHARS = ('\\n','\\r','\\x00'); _MAX_PATH_LEN = 4096; _PERCENT_RE = (\\d{1,3})%",
      "purpose": "Tablet path validation and adb progress parsing",
      "source": "manga_ops.py:35-47",
      "should_be_user_setting": false
    },
    {
      "script": "manga_ops.py",
      "name": "adb command timeouts / kill escalation",
      "value": "mkdir -p timeout 30 s; rm -f timeout 30 s; push has no timeout; terminate→kill after 5 s; stderr tail 4096 chars / 64 lines",
      "purpose": "Subprocess robustness",
      "source": "manga_ops.py:120-127, 211-212, 240, 252-264, 280-287",
      "should_be_user_setting": false
    },
    {
      "script": "manga_ops.py",
      "name": "No --progress flag on adb push",
      "value": "cmd = [adb, -s, device, push, pc_path, dest/] (adb 36.0.2 rejects --progress)",
      "purpose": "Compatibility with platform-tools 36",
      "source": "manga_ops.py:157-169",
      "should_be_user_setting": false
    },
    {
      "script": "transfer_runner.py",
      "name": "error_budget",
      "value": "3 consecutive failures → batch_aborted_due_to_errors",
      "purpose": "Stop runaway failing batches",
      "source": "transfer_runner.py:91, 225-232",
      "should_be_user_setting": true
    },
    {
      "script": "transfer_runner.py",
      "name": "Worker tunables",
      "value": "_PROGRESS_MIN_INTERVAL=0.2 s; queue maxsize 4096; non-progress events block ≤30 s; one running batch globally; transfer id = secrets.token_hex(8)",
      "purpose": "Event throughput and concurrency",
      "source": "transfer_runner.py:64, 75-77, 97-104, 161-178",
      "should_be_user_setting": false
    },
    {
      "script": "batch_search.py",
      "name": "AIO_DIR",
      "value": "C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader (NO LONGER EXISTS; the repo is now at C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\AIO-Webtoon-Downloader)",
      "purpose": "chdir + sys.path so AIO modules import",
      "source": "batch_search.py:35, 40-42",
      "should_be_user_setting": false
    },
    {
      "script": "batch_search.py",
      "name": "OUT_JSON / OUT_TXT",
      "value": "<SCRIPT_DIR>/seed_links.json, <SCRIPT_DIR>/seed_links.txt (tmp: seed_links.json.tmp)",
      "purpose": "Result persistence",
      "source": "batch_search.py:37-38, 174-178",
      "should_be_user_setting": false
    },
    {
      "script": "batch_search.py",
      "name": "PROBE_PHASE_DEADLINE_S override",
      "value": "45.0 (the module default is now 240.0 at search_orchestrator.py:284; the comment claims 120 s)",
      "purpose": "Shorten the image-quality probe phase per query in batch runs",
      "source": "batch_search.py:56-64",
      "should_be_user_setting": true
    },
    {
      "script": "batch_search.py",
      "name": "SERIES (tablet_folder → search query) table",
      "value": "64 entries ('(same)' = query identical to the folder name): 1 'Tis Time for Torture, Princess → (same); 2 2.5_Dimensional_Seduction → 2.5 Dimensional Seduction; 3 A Certain Scientific Railgun → (same); 4 A Couple of Cuckoos → (same); 5 Angel Beats! Heaven's Door → (same); 6 Attack_on_Titan → Attack on Titan; 7 Berserk → (same); 8 Bleach → (same); 9 Blue Box → (same); 10 Bungo Stray Dogs → (same); 11 Chainsaw Man → (same); 12 Claymore → (same); 13 CØDEBREAKER → (same); 14 Demon_Slayer_Kimetsu_no_Yaiba → Demon Slayer Kimetsu no Yaiba; 15 Dragon Ball → (same); 16 EDENS ZERO → (same); 17 Eleceed → (same); 18 Every Day Is a Holiday (Colored) → (same); 19 Fly Me to the Moon → (same); 20 Frieren Beyond Journey’s End [curly ’] → Frieren Beyond Journey's End [straight ']; 21 Fullmetal Alchemist → (same); 22 Horimiya → (same); 23 I Was Supposed to Never Fall in Love with You → (same); 24 Is_the_order_a_rabbit → Is the order a rabbit?; 25 JoJo's Bizarre Adventure Part 5 Golden Wind → (same); 26 JoJo's Bizarre Adventure Part 6 Stone Ocean → (same); 27 JoJo's_Bizarre_Adventure_Part_1_Phantom_Blood → JoJo's Bizarre Adventure Part 1 Phantom Blood; 28 JoJo's_Bizarre_Adventure_Part_2_Battle_Tendency → JoJo's Bizarre Adventure Part 2 Battle Tendency; 29 JoJo's_Bizarre_Adventure_Part_3_Stardust_Crusaders → JoJo's Bizarre Adventure Part 3 Stardust Crusaders; 30 JoJo's_Bizarre_Adventure_Part_4_Diamond_is_Unbreakable → JoJo's Bizarre Adventure Part 4 Diamond is Unbreakable; 31 Kagurabachi → (same); 32 Komi_Can't_Communicate → Komi Can't Communicate; 33 Konosuba God's Blessing on This Wonderful World! → (same); 34 Link Click → (same); 35 Lycoris_Recoil → Lycoris Recoil; 36 Made_in_Abyss → Made in Abyss; 37 Makeine Make Hiroin ga Ōsugiru! → (same); 38 My youth romantic comedy is wrong as I expected → (same); 39 No Longer Allowed In Another World → (same); 40 No More Love With the Girls → (same); 41 One-Punch_Man_(Official) → One-Punch Man; 42 Pandora Hearts → (same); 43 Pandora Seven → (same); 44 Pandora's Box → (same); 45 Record of Ragnarok → (same); 46 Rinjin-chan ga Shinpai → (same); 47 SHELTER → (same); 48 SPY_x_FAMILY → SPY x FAMILY; 49 Sakamoto Days → (same); 50 Sentenced to Be a Hero The Prison Records of Penal Hero Unit 9004 → (same); 51 Shiunji-ke no Kodomotachi → (same); 52 Sleepy Princess in the Demon Castle → (same); 53 Solo Leveling → (same); 54 Talentless Nana → (same); 55 That Time I Got Reincarnated as a Slime → (same); 56 The Angel Next Door Spoils Me Rotten → (same); 57 The Angel Next Door Spoils Me Rotten After the Rain → (same); 58 The Apothecary Diaries → (same); 59 The Legend of the Northern Blade → (same); 60 Tower of God → (same); 61 Undead Unluck → (same); 62 Vivy_-Fluorite_Eye's_Song- → Vivy Fluorite Eye's Song; 63 You and I are Polar Opposites → (same); 64 You are Ms. Servant → (same). Derivation rules (comment): underscores→spaces; drop '(Official)'; keep '(Colored)'; drop Vivy's wrapping dashes; add '?' for Is the order a rabbit. Non-derivable exceptions needing per-series overrides: #20, #24, #41, #62. Guarded by assert len(SERIES) == 64.",
      "purpose": "Input list for the batch search: every tablet folder plus the query to search for it",
      "source": "batch_search.py:66-141",
      "should_be_user_setting": true
    },
    {
      "script": "batch_search.py",
      "name": "make_args Namespace (search options)",
      "value": "cookies='', language='en', search_language='en', search_parallelism=6, search_timeout=DEFAULT_PER_SITE_TIMEOUT_S (8.0; the AIO CLI default is 20.0), search_min_match=DEFAULT_MIN_MATCH (0.55), auto_pick=False, search_json=True, seeded_only=True, multi_source=False, collapse_splits=True",
      "purpose": "Mimics aio-dl.py search flags for the scraper factory",
      "source": "batch_search.py:144-161; sites/search_orchestrator.py:160, 183; aio-dl.py:8541-8544",
      "should_be_user_setting": true
    },
    {
      "script": "batch_search.py",
      "name": "search_all call kwargs",
      "value": "language='en', parallelism=6, per_site_timeout_s=8.0, min_match=0.55, probe_failure_cache=ProbeFailureCache(record_cooldown=None), img_quality_cache=ImageQualityCache(), seeded_only=True; request factory attempts=2",
      "purpose": "Per-query search configuration",
      "source": "batch_search.py:211-214, 228-240",
      "should_be_user_setting": true
    },
    {
      "script": "batch_search.py",
      "name": "Candidates persisted per folder",
      "value": "top 5 (the docstring says top-3)",
      "purpose": "Keeps seed_links.json lean",
      "source": "batch_search.py:18, 267",
      "should_be_user_setting": false
    },
    {
      "script": "fixup_seed_links.py",
      "name": "Override 1 — SHELTER (pinned source)",
      "value": "d['SHELTER'] = {query:'SHELTER', elapsed_sec:0.0, manual_override:true, override_reason:'AIO search returned no usable candidates; web search identified the series as the Webtoon Canvas SHELTER by wufargia (title_no=194264). Chapter naming #NN - Arc Name [N].pdf matches the Canvas episode list', candidates:[{canonical_title:'SHELTER', canonical_year:null, sources:[{site:'linewebtoon', url:'https://www.webtoons.com/en/canvas/shelter/list?title_no=194264', title:'SHELTER', cover:null, title_match:1.0, seed_quality:1.0, img_quality_score:null, img_quality_metadata:null, composite_score:1.0, chapter_count_hint:null, actual_chapter_count:null, dmca_likely:false}]}]}",
      "purpose": "Manual source when auto-search fails",
      "source": "fixup_seed_links.py:34-63",
      "should_be_user_setting": true
    },
    {
      "script": "fixup_seed_links.py",
      "name": "Override 2 — That Time I Got Reincarnated as a Slime (promote by URL substring)",
      "value": "In candidates[0].sources move the first source whose url contains 'tensei-shitara-slime-datta-kenn' (mangafire main series, 141 ch) to index 0; reason: the img_quality tiebreak put mangakatana 'tensura-short-stories' spinoff first",
      "purpose": "Fix a mis-ranked top pick",
      "source": "fixup_seed_links.py:65-84",
      "should_be_user_setting": true
    },
    {
      "script": "fixup_seed_links.py",
      "name": "Override 3 — Eleceed (promote official site)",
      "value": "In candidates[0].sources move the first source with site=='linewebtoon' and 'webtoons.com' in url to index 0 (Toonily is an unofficial mirror). Explicit NON-override: Solo Leveling left alone (no LINE Webtoon official; official English on Tappytoon, unsupported by AIO)",
      "purpose": "Prefer the licensed source",
      "source": "fixup_seed_links.py:86-108",
      "should_be_user_setting": true
    },
    {
      "script": "render_seed_links.py",
      "name": "IN/OUT paths and limits",
      "value": "IN seed_links.json; OUT seed_links.md, seed_links_full.md; up to 5 sources per series; order = folder name casefold",
      "purpose": "Markdown reports",
      "source": "render_seed_links.py:18-33, 77",
      "should_be_user_setting": false
    },
    {
      "script": "templates/base.html",
      "name": "CDN assets",
      "value": "fonts.bunny.net cormorant-sc:600,700 | eb-garamond:400,500,600 | fragment-mono:400; unpkg htmx.org@1.9.12; htmx-ext-json-enc@2.0.0",
      "purpose": "Old tool look and HTMX runtime",
      "source": "templates/base.html:7-12",
      "should_be_user_setting": false
    },
    {
      "script": "static/styles.css",
      "name": "Design tokens (old look, not to be ported)",
      "value": "paper #f4ede0/#ebe1cf/#ddd1ba, ink #1a1614/#4a3f38/#8a7d72, vermillion #c8362f (dim #a32d28), gold #b08d4c, rule #2a2520; fonts Cormorant SC / EB Garamond / Fragment Mono; 8px spacing scale; 8×8 halftone SVG; 40/60 column grid; max-width 1280",
      "purpose": "'Editorial manga noir' styling",
      "source": "static/styles.css:1-49, 229-240; static/halftone.svg",
      "should_be_user_setting": false
    }
  ],
  "algorithms": [
    {
      "name": "Series matching by normalized folder name",
      "description": "Key = strip '(hid=X)' → NFKC → casefold → '_'→' ' → delete apostrophes → punctuation→space → collapse whitespace. PC folders sharing a key collapse into a hid-variant list. For tablet collisions the first folder wins and an 'orphan' warn is raised. No alias/rename map exists anywhere in this path.",
      "source": "compare_manga.py:292-307, 762-793"
    },
    {
      "name": "Canonical hid-variant pick",
      "description": "Sort variants by chapter count desc, then valid JSON first, then folder name. [0] provides the display title/status/cover and is the push source folder.",
      "source": "compare_manga.py:850-856; manga_manager.py:262, 320, 555"
    },
    {
      "name": "Chapter label parse / canonicalize / sort",
      "description": "Six regexes (A-F), first match wins. '~'→'.', integers lose leading zeros, 'N.0'→'N', and a decimal part is kept verbatim (315.01 ≠ 315.1). The sort key puts full chapters before partials of the same number (8 < 8~5 < 8.5 < 9) and unlabelled last.",
      "source": "compare_manga.py:232-289"
    },
    {
      "name": "Side classification + synced flag",
      "description": "PC only with >0 chapters → tablet_missing. PC only with 0 chapters → pc_missing (quirk). Tablet only → pc_missing, but an empty tablet-only folder → shared+synced. Both sides → shared, with missing = labels only on PC and extra = labels only on the tablet (depth-1, labelled). Synced = neither.",
      "source": "manga_manager.py:257-341"
    },
    {
      "name": "Per-chapter suggested op",
      "description": "Union of labels. PC-only → 'push' (op key push|series|label); tablet-only → 'delete'. PC side keeps the largest file per label across variants. Tablet side is depth-1, labelled, first wins.",
      "source": "manga_manager.py:344-437"
    },
    {
      "name": "Selection → TransferOp resolution",
      "description": "Validate each entry, dedupe on op|series|label, and expand '*' (push: every PC label not on the tablet, sorted; delete: every depth-1 tablet file including unlabelled, sorted). Single push is skipped if the label is already on the tablet (never overwrite). Single delete matches label OR filename. Unresolvable entries return with a reason. Runs at both preview and apply time, against the current memo.",
      "source": "manga_manager.py:445-551"
    },
    {
      "name": "Tablet destination naming",
      "description": "Existing tablet folder if the series is matched; else tablet_root + '/' + sanitize_tablet_segment(canonical PC folder_name). The display string is '<title> Ch <label>', or '<title> · <filename>' for unlabelled deletes.",
      "source": "manga_manager.py:554-599; manga_ops.py:70-83"
    },
    {
      "name": "Batch transfer worker",
      "description": "Daemon thread per batch (one at a time). For each op: check cancel → file_start → push (mkdir -p + adb push with throttled progress) or delete (rm -f + synthetic 100%) → file_done. Stop after error_budget consecutive failures. A failure during cancel is reported as a cancel. A sentinel ends the stream.",
      "source": "transfer_runner.py:85-294"
    },
    {
      "name": "adb push progress parsing",
      "description": "Read merged stdout+stderr in 256-byte chunks, split on \\r\\n|\\r|\\n, take the last 'NN%' per line, emit on change as (pct, pct*size//100). Check cancel between chunks. Emit 100% at the end if adb skipped it.",
      "source": "manga_manager.py (n/a); manga_ops.py:171-249"
    },
    {
      "name": "Comparison memo invalidation",
      "description": "Rebuild when there is no view, the view is older than 120 s, the tablet cache file mtime is newer than the view, or force=True (Refresh, which also bypasses the tablet cache).",
      "source": "manga_manager.py:155-170"
    },
    {
      "name": "One-round-trip tablet scan with cache",
      "description": "adb shell: depth-1 dirs; echo sentinel; find -type f -printf '%s|%T@|%p\\n' (stat fallback). Grouped by first path segment; loose root files → orphan anomaly; nested files are kept but excluded from gaps. Cached as JSON with version/device/root/TTL validation.",
      "source": "compare_manga.py:492-754"
    },
    {
      "name": "Cover resolution chain",
      "description": "Disk cache → server fetch of the .aio_series.json 'cover' URL (image/* only, atomic) → 302 to the CDN URL → SVG placeholder.",
      "source": "manga_manager.py:602-664, 824-857"
    },
    {
      "name": "Batch search with resume and incremental persistence",
      "description": "Load the existing JSON. For each series, skip if present without an error. Otherwise search_all(query, seeded_only) and store the top 5 as to_json(), or {error}. Atomically save JSON + re-render TXT after every series. Final ok/error summary.",
      "source": "batch_search.py:164-280"
    },
    {
      "name": "Search-query derivation from folder name",
      "description": "underscores→spaces; drop '(Official)'; keep '(Colored)'; strip wrapping dashes (Vivy); curly→straight apostrophe (Frieren); add a missing '?' (Is the order a rabbit?). The rest is identical.",
      "source": "batch_search.py:66-73, 94, 98, 115, 136"
    },
    {
      "name": "Seed override: promote-by-predicate",
      "description": "Find the first source in candidates[0].sources matching a predicate (URL substring, or site + domain) and move it to index 0; set manual_override + override_reason. Or replace the whole entry with a pinned source.",
      "source": "fixup_seed_links.py:34-108"
    }
  ],
  "cli_flags": [
    {
      "script": "manga_manager.py",
      "flag": "--host",
      "meaning": "Bind address (help: do not expose publicly)",
      "default": "127.0.0.1",
      "source": "manga_manager.py:895-896"
    },
    {
      "script": "manga_manager.py",
      "flag": "--port",
      "meaning": "HTTP port",
      "default": "5000",
      "source": "manga_manager.py:897"
    },
    {
      "script": "manga_manager.py",
      "flag": "--no-browser",
      "meaning": "Don't auto-open the dashboard in the default browser",
      "default": "false",
      "source": "manga_manager.py:898, 935-936"
    },
    {
      "script": "manga_manager.py",
      "flag": "--pc-root",
      "meaning": "PC manga library root (must exist, else exit 2)",
      "default": "compare_manga.DEFAULT_PC_ROOT = D:\\AIO\\manga",
      "source": "manga_manager.py:899, 918-920; compare_manga.py:55"
    },
    {
      "script": "manga_manager.py",
      "flag": "--tablet-root",
      "meaning": "Tablet library root; also the path-safety root for every adb write/delete",
      "default": "/storage/self/primary/Documents",
      "source": "manga_manager.py:900; compare_manga.py:56"
    },
    {
      "script": "manga_manager.py",
      "flag": "--device",
      "meaning": "adb serial. Must be connected. When omitted: the sole device, else DEFAULT_DEVICE_SERIAL if connected, else error",
      "default": "None (auto)",
      "source": "manga_manager.py:901, 913-917; compare_manga.py:460-489"
    },
    {
      "script": "manga_manager.py",
      "flag": "--adb",
      "meaning": "adb.exe path. When omitted: PATH, else KNOWN_ADB_PATH",
      "default": "None (auto)",
      "source": "manga_manager.py:902, 908-912; compare_manga.py:444-457"
    },
    {
      "script": "manga_manager.py",
      "flag": "--cache-file",
      "meaning": "Tablet listing cache JSON",
      "default": "<script dir>/.tablet_cache.json",
      "source": "manga_manager.py:903"
    },
    {
      "script": "manga_manager.py",
      "flag": "--cache-ttl-hours",
      "meaning": "Max age before the tablet listing is re-scanned via adb",
      "default": "24.0",
      "source": "manga_manager.py:904"
    },
    {
      "script": "manga_manager.py",
      "flag": "--size-threshold",
      "meaning": "Percent size delta for size_mismatch anomalies",
      "default": "30.0",
      "source": "manga_manager.py:905"
    },
    {
      "script": "manga_ops.py",
      "flag": "(none; `python manga_ops.py`)",
      "meaning": "Runs the path-validator / sanitizer self-test; exit 1 on any failure",
      "default": "",
      "source": "manga_ops.py:305-368"
    },
    {
      "script": "transfer_runner.py",
      "flag": "(none; library only)",
      "meaning": "start_transfer(error_budget=3) is a function kwarg, not a CLI flag",
      "default": "error_budget=3",
      "source": "transfer_runner.py:85-92"
    },
    {
      "script": "batch_search.py",
      "flag": "(none)",
      "meaning": "No argparse. The series list, output paths, AIO path and every search option are hard-coded. Resume is implicit via the existing seed_links.json",
      "default": "",
      "source": "batch_search.py:35-64, 144-161, 209-284"
    },
    {
      "script": "fixup_seed_links.py",
      "flag": "(none)",
      "meaning": "No arguments; applies the 3 hard-coded edits to seed_links.json",
      "default": "",
      "source": "fixup_seed_links.py:30-117"
    },
    {
      "script": "render_seed_links.py",
      "flag": "(none)",
      "meaning": "No arguments; renders seed_links.md and seed_links_full.md",
      "default": "",
      "source": "render_seed_links.py:92-105"
    }
  ],
  "destructive_ops": [
    {
      "op": "Delete a single tablet file: `adb -s <serial> shell rm -f '<tablet_root>/<series>/<file>'`",
      "source": "manga_ops.py:267-287; transfer_runner.py:280-284; manga_manager.py:514-526, 579-599",
      "safety_rails": "_validate_tablet_path: under root, not the root itself, no '..', no \\n\\r\\0, ≤4096 chars (manga_ops.py:86-107). shlex.quote. rm -f only, never -rf (manga_ops.py:274). Depth-1 files only; nested/anthology files are never targeted (manga_manager.py:433-434, 522-523, 546-548). Per-chapter checkboxes only for tablet-only labels (_chapter_table.html:22-26). Confirm modal lists every file with its size and totals before Apply (confirm_modal.html:13-57). The server re-resolves the op list on Apply (manga_manager.py:760-769). Cancel button. Abort after 3 consecutive failures. There is NO typed confirmation, NO separate delete warning, NO trash/backup, and the server does not enforce 'tablet-only' for crafted single-delete requests."
    },
    {
      "op": "Whole-series delete ('Delete all' on Only-on-tablet rows; 'Delete extras' on shared rows with only extras)",
      "source": "templates/partials/_series_row.html:2-8; manga_manager.py:539-550",
      "safety_rails": "Same rails as single delete, plus the preview modal. LATENT OVER-REACH: the delete branch of _expand_whole_series ignores pc_chapters and emits a delete for EVERY depth-1 tablet file. 'Delete extras' on a shared series therefore also queues chapters that exist on the PC, plus sidecars such as cover.jpg/details.json, which the tablet scan does not filter (compare_manga.py:676-678). Only the preview counts would reveal this."
    },
    {
      "op": "Whole tablet folder delete",
      "source": "manga_ops.py:290-302",
      "safety_rails": "Deliberately not implemented. delete_tablet_dir validates, then raises NotImplementedError, so emptied series folders remain on the tablet."
    },
    {
      "op": "Push (can overwrite a same-named tablet file)",
      "source": "manga_ops.py:130-249; manga_manager.py:503-513, 530-538, 554-576",
      "safety_rails": "The server skips a push whose label already exists in the tablet series (manga_manager.py:510-512, 536-537), so the tool never intentionally overwrites. Destination validated under the root. New folder names sanitized (manga_ops.py:70-83). mkdir -p is idempotent. Push itself has no timeout."
    },
    {
      "op": "Tablet cache / cover cache writes",
      "source": "compare_manga.py:602-625; manga_manager.py:626-647",
      "safety_rails": "Atomic tmp + os.replace. The cache is keyed and validated by version, device and root."
    },
    {
      "op": "batch_search writes seed_links.json/.txt and chdirs into the AIO checkout; the AIO search persists ~/.aio-dl/cache/probe_failures.json and img_quality.json",
      "source": "batch_search.py:41, 174-178, 205-206; sites/search_orchestrator.py:594, 773",
      "safety_rails": "Atomic JSON write. Resume never overwrites successful entries, but 0-candidate results are never retried."
    },
    {
      "op": "fixup_seed_links rewrites seed_links.json in place; render_seed_links overwrites seed_links.md / seed_links_full.md",
      "source": "fixup_seed_links.py:110-111; render_seed_links.py:94-97",
      "safety_rails": "None: non-atomic write, no backup. Overrides are only marked via manual_override/override_reason."
    }
  ],
  "state_files": [
    {
      "file": "CompareManga/.tablet_cache.json",
      "schema": "{version:2, device:'3CEF42502E91537', tablet_root:'/storage/self/primary/Documents', scanned_at_unix, scan_duration_sec, file_count (20007 in the current file), dir_count (112), files:[{p:<abs tablet path>, s:<bytes>, m:<mtime>}], dirs:[<abs depth-1 dir>]}. Current entries are Komikku-style, e.g. 'Talentless Nana/Ch.001 - Chapter 1.cbz'.",
      "purpose": "Tablet listing cache (TTL 24 h); its mtime also invalidates the dashboard memo",
      "writer": "compare_manga.save_cache (compare_manga.py:602-625) via scan_tablet_library",
      "reader": "compare_manga.load_cache (compare_manga.py:571-599); manga_manager._get_comparison mtime check (manga_manager.py:160-166)"
    },
    {
      "file": "CompareManga/static/covers/<sha1(norm_key)[:12]>.jpg",
      "schema": "raw image bytes (9 files present)",
      "purpose": "Cover cache for the detail card",
      "writer": "manga_manager._fetch_cover (manga_manager.py:626-647)",
      "reader": "GET /api/cover (manga_manager.py:835-840)"
    },
    {
      "file": "<PC root>/<series>/.aio_series.json",
      "schema": "AIO series sidecar; the dashboard reads title, status, site, format, chapters_downloaded, cover (URL); its mtime is shown as 'last download'",
      "purpose": "Display title/status/cover/last-download source (read-only)",
      "writer": "AIO aio-dl.py",
      "reader": "compare_manga._scan_pc_series (compare_manga.py:358-383); manga_manager.py:385-391, 612-623"
    },
    {
      "file": "(in-memory) transfer_runner._TRANSFERS",
      "schema": "id → TransferState{id, ops[TransferOp{op,series_key,label,pc_path,tablet_path,bytes,display}], status queued|running|done|cancelled|aborted_errors, current_index, succeeded, failed, started_at, finished_at, cancel_event, _q}",
      "purpose": "Batch registry + event queue; never evicted",
      "writer": "transfer_runner.start_transfer/_worker_main (transfer_runner.py:85-242)",
      "reader": "iter_events / cancel_transfer / manga_manager busy check (manga_manager.py:781-784)"
    },
    {
      "file": "CompareManga/seed_links.json (+ .json.tmp) — currently ABSENT",
      "schema": "{<tablet_folder>: {query, elapsed_sec, candidates:[SeriesCandidate.to_json(): {canonical_title, canonical_year, sources:[{site,url,title,cover,title_match,seed_quality,img_quality_score,img_quality_metadata,composite_score,chapter_count_hint,actual_chapter_count,dmca_likely}]}] (top 5)} | {query, error, elapsed_sec, candidates:[]}; optional manual_override:bool, override_reason:str}. Current AIO to_json also emits quality_basis and is_official (search_orchestrator.py:501-524).",
      "purpose": "Best source URLs per tablet series (seed links)",
      "writer": "batch_search.save_results (batch_search.py:174-178); fixup_seed_links.py:110-111",
      "reader": "batch_search resume (batch_search.py:164-171); render_seed_links.load (render_seed_links.py:24-28); fixup_seed_links.py:31-32"
    },
    {
      "file": "CompareManga/seed_links.txt, seed_links.md, seed_links_full.md — currently ABSENT",
      "schema": "txt: 'folder | url | site | composite | title' lines; md: tables (see render_seed_links.py:36-89)",
      "purpose": "Human-readable seed-link reports",
      "writer": "batch_search.render_txt (batch_search.py:181-206); render_seed_links.py:92-101",
      "reader": "user"
    },
    {
      "file": "~/.aio-dl/cache/probe_failures.json and ~/.aio-dl/cache/img_quality.json",
      "schema": "AIO-owned caches (host suppression; (site, series_url) → image-quality score)",
      "purpose": "Shared across AIO search runs, including batch_search",
      "writer": "AIO ProbeFailureCache / ImageQualityCache (sites/search_orchestrator.py:560-594, 674-773)",
      "reader": "AIO search_all"
    }
  ],
  "external_deps": [
    "flask>=3.0,<4.0 (requirements.txt:1)",
    "waitress>=3.0,<4.0 (requirements.txt:2)",
    "adb / Android platform-tools, observed v36.0.2, which rejects `push --progress` (manga_ops.py:157-162)",
    "htmx 1.9.12 + htmx-ext-json-enc 2.0.0 from unpkg CDN (templates/base.html:10-11)",
    "fonts.bunny.net: Cormorant SC, EB Garamond, Fragment Mono (templates/base.html:7-8)",
    "Python 3.10+ (compare_manga.py:27); __pycache__ shows CPython 3.13",
    "compare_manga.py as a library (manga_manager.py:49): scan_pc_library, scan_tablet_library, build_series_index, detect_anomalies, normalize_series_name, format_size, rank_hid_variants, compute_chapter_gaps, chapter_label_sort_key, resolve_adb, resolve_device; types Anomaly, MatchedSeries, PCSeries, TabletSeries, ChapterFile; constants DEFAULT_PC_ROOT, DEFAULT_TABLET_ROOT, DEFAULT_CACHE_TTL_HOURS, SCRIPT_DIR (manga_manager.py:81, 138-142, 176-184, 222, 233, 262, 322, 355, 909, 914)",
    "transfer_runner.py + manga_ops.py (manga_manager.py:50-51, 564)",
    "batch_search: AIO internals sites.search_orchestrator {DEFAULT_MIN_MATCH, DEFAULT_PER_SITE_TIMEOUT_S, ImageQualityCache, ProbeFailureCache, search_all, PROBE_PHASE_DEADLINE_S} and aio_search_cli {_scraper_factory_for, _search_make_request_factory} (batch_search.py:44-64), transitively requests/cloudscraper/rapidfuzz/Playwright-Patchright (MangaFire VRF)",
    "batch_search, fixup_seed_links and render_seed_links do NOT import compare_manga; manga_ops and transfer_runner do not either (grep of CompareManga imports)"
  ],
  "integration_notes": [
    "Left icon rail is the TABS array at UI-source/src/App.jsx:25-31 (new, search, queue, logs, settings). The opt-in tab goes before {id:'settings'} (App.jsx:30), gated by a setting.",
    "Settings has a 'library' category (UI-source/src/components/SettingsTab.jsx:435-436, 'Update checks and how the library is scanned.'), rendered by renderLibrary in the group table (SettingsTab.jsx:2787). This is where the opt-in toggle and the tablet config (adb path, device, tablet root, folder/alias maps, skip lists, thresholds) would live.",
    "Reuse AIO's existing search path instead of batch_search's in-process imports. UI-source/electron/searcher.js:38-81 buildSearchArgs → `aio-dl.py -u --search <q> --search-json` with --search-language/--search-timeout/--search-min-match/--search-parallelism/--seeded-only/--multi-source/--collapse-splits/--enable-ml-rating/--disable-sites. IPC 'search:run' / 'search:cancel' are at UI-source/electron/main.js:753-786 (parallelism throttled by networkLimit, main.js:758-767). Searcher is single-flight: it cancels any prior run (searcher.js:101-104, 119-124), so a batch must run queries serially and needs its own cancel/resume state.",
    "The batch run's shorter probe deadline has no CLI equivalent. PROBE_PHASE_DEADLINE_S=240.0 is a module constant (sites/search_orchestrator.py:284) that batch_search monkey-patched to 45 s (batch_search.py:62-64). Matching that speed from the Electron side needs a new aio-dl.py flag or env var. Also, the CLI --search-timeout default is 20.0 (aio-dl.py:8541-8544), while batch_search used 8.0 (sites/search_orchestrator.py:183).",
    "run_search_mode (aio_search_cli.py:481-600) wraps search_all with probe_candidate_limit, fetch_memo, seed-URL handling and site diagnostics that batch_search bypassed. The JSON contract is {candidates:[...]} plus site health (searcher.js:216-245; aio-dl.py:8613-8614). SeriesCandidate.to_json now includes quality_basis and is_official (sites/search_orchestrator.py:501-524). The official-publisher tiebreak (sites/search_orchestrator.py:440-444) makes the Eleceed fixup obsolete.",
    "Komikku chapter-name parsing already exists in AIO: KOMIKKU_CH_RE at UI-source/electron/library.js:148 (with a legacy-format branch nearby at library.js:119-177). compare_manga's CHAPTER_PATTERNS (compare_manga.py:96-103) lack it, and the current tablet cache is Komikku-named. The port's tablet parser should reuse or extend AIO's parser, not port compare_manga's six regexes alone.",
    "Covers: AIO already keeps cover.jpg in the series root (UI-source/electron/library.js:729 comment). Prefer that over the dashboard's cover proxy (manga_manager.py:824-857).",
    "In-flight local work risk: the AIO repo is on branch fix/mangafire-cloudflare-challenge, ahead 1 of fork. It has 36 modified, uncommitted files (+6865/-831), including UI-source/src/components/LibraryTab.jsx (~1058 lines changed), UI-source/electron/main.js (455), library.js (197), preload.js (56), App.jsx (2, a prop swap near App.jsx:181-184) and sites/search_orchestrator.py (86; search_all signature and batch-relevant constants unchanged). Untracked: UI-source/electron/series-merge.js, UI-source/electron/update-check-record.js, UI-source/src/components/ChapterChips.jsx, .github/workflows/android.yml (git status / git diff --stat). Any port must build on top of these without resetting or stashing them.",
    "The Flask/SSE route set maps naturally onto Electron IPC: invoke handlers for scan/refresh/series-detail/preview/start-transfer/cancel, plus a push-event channel for batch_start/file_start/file_progress/file_done/batch_* (the same pattern searcher.js uses for 'search-log'). transfer_runner's event names and fields (transfer_runner.py:190-234) can be kept verbatim as the event contract.",
    "The user's 'stop hard-coding tablet folders and aliases' concern is NOT visible in the dashboard: it has no alias map, and matching is pure normalization (compare_manga.py:292-307, 762-793). The alias and folder-rename hard-codes live in the sync_to_tablet.py / push_all_to_tablet.py area. The dashboard's matching (build_series_index) and new-folder naming (manga_manager.py:557-566) are the two places a user-editable alias/folder map must plug in."
  ],
  "observed_failures": [
    {
      "what": "First push attempt failed: adb push exit 1 for One Piece Ch 0",
      "evidence": "_screens/dash-05-progress.png log '[06:20:21 PM] fail One Piece Ch 0 ← adb push failed (exit 1) for One Piece Ch 0…', 0 ok · 1 failed. The code comment explains adb 36.0.2 rejects --progress with 'unrecognized option', so the flag was removed (manga_manager.py n/a; manga_ops.py:157-162). dash-06 (06:25 PM) shows a successful push after the fix.",
      "lesson": "Don't pass --progress. Parse the default '[ NN%]' output. Surface the adb stderr tail in the UI (it was the only diagnostic)."
    },
    {
      "what": "Whole-series delete of the tablet-only folder webp_test resolved to zero ops",
      "evidence": "_screens/dash-08-deletepreview.png 'SKIPPED (1) no chapters available for this op' with 0 files and no Apply button; .playwright-mcp/page-2026-05-11T15-27-42-310Z.yml:718 'Skipped (1)'. The folder's only file (_pdftoppm_out-01.ppm) had no parsed label. Fixed by expanding to ALL depth-1 tablet files (manga_manager.py:539-549 comment).",
      "lesson": "Unlabelled/orphan tablet files must be addressable (by filename) in the selection and delete model."
    },
    {
      "what": "Apply of the fixed webp_test delete returned HTTP 400 from /api/transfer before succeeding (inferred)",
      "evidence": ".playwright-mcp/console-2026-05-11T15-29-30-010Z.log:1-2 (400 BAD REQUEST @ /api/transfer, ~18:30). The comment at manga_manager.py:517-520 says delete resolution now matches by label OR filename 'so the round-trip works'. dash-11-delete-done.png (18:32) shows 'ok webp_test · _pdftoppm_out-01.ppm'.",
      "lesson": "Preview and Apply must use the same, stable op identity. Structured ids beat re-resolving string labels."
    },
    {
      "what": "batch_search.py can no longer run: its AIO path is gone",
      "evidence": "AIO_DIR = C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader (batch_search.py:35) → `ls` reports 'No such file or directory'. os.chdir at batch_search.py:41 would raise. The repo now lives under ...\\Scripts\\AIO-Webtoon-Downloader.",
      "lesson": "The port must run inside AIO using its own spawn paths (resolveSpawnPaths in main.js), never a hard-coded checkout path."
    },
    {
      "what": "Seed-link results were not preserved",
      "evidence": "find over CompareManga and the AIO repo (maxdepth 3) returned no seed_links.* files, although batch_search/fixup/render all read or write them (batch_search.py:37-38; render_seed_links.py:19-21).",
      "lesson": "Persist batch-search results and overrides in app state/settings with a UI, not loose files next to a script."
    },
    {
      "what": "Stale docs and constants drift in the search helpers",
      "evidence": "batch_search says the probe deadline default is 120 s (batch_search.py:56-60) but it is now 240.0 (sites/search_orchestrator.py:284). The docstring says top-3 but the code keeps top-5 (batch_search.py:18 vs 267). The fixup docstring lists 2 edits but the code applies 3 (fixup_seed_links.py:5-16 vs 86-108).",
      "lesson": "Derive values from AIO at runtime. Avoid copying constants or private helpers."
    },
    {
      "what": "PC library root moved under the dashboard",
      "evidence": "Screenshots (2026-05-11) show PC root C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas (dash-03 footer). compare_manga.DEFAULT_PC_ROOT is now D:\\AIO\\manga, 'moved off OneDrive … on 2026-06-14' (compare_manga.py:51-55). The dashboard's --pc-root default silently follows it (manga_manager.py:138, 899).",
      "lesson": "The PC root should default to AIO's configured output folder and stay user-editable."
    },
    {
      "what": "Komikku-named tablet files are invisible to the dashboard's parser (code-evident, not run)",
      "evidence": ".tablet_cache.json:1 entries such as '/storage/self/primary/Documents/Talentless Nana/Ch.001 - Chapter 1.cbz'. None of the six CHAPTER_PATTERNS match 'Ch.NNN - …' (compare_manga.py:71-103). Only the one-off _delta_findings.py:118 has a Komikku regex. Result: label=None → hidden from chapter tables and gap counts (manga_manager.py:428-437), and swept up by whole-series delete.",
      "lesson": "The tablet parser must understand Komikku LocalSource names (reuse UI-source/electron/library.js:148)."
    },
    {
      "what": "'Delete extras' over-reach (latent)",
      "evidence": "_series_row.html:5-8 picks row op 'delete' with label '*' for extras-only shared series. _expand_whole_series(delete) emits a delete for every depth-1 tablet file, ignoring pc_chapters (manga_manager.py:530-550), including files also on the PC and sidecars not filtered by compare_manga.py:676-678.",
      "lesson": "Scope whole-series deletes to tablet-only items, exclude reader sidecars (cover.jpg, details.json), and show a clear count in the confirm step."
    },
    {
      "what": "View stays stale after a transfer (code-evident)",
      "evidence": "finish() only clears the selection (static/app.js:170-181). Nothing updates .tablet_cache.json after pushes or deletes, and memo rebuilds re-read the ≤24 h cache (compare_manga.py:639-642; manga_manager.py:173-180). Pushed chapters keep showing as missing until the user clicks Refresh (dash-06 shows the user refreshed between pushes).",
      "lesson": "After a batch, patch the cached listing with the completed ops, or auto-rescan the affected series."
    },
    {
      "what": "Multiple tablets over time",
      "evidence": "DEFAULT_DEVICE_SERIAL 3CEF42502E91537 (compare_manga.py:57; .tablet_cache.json device), while the sync area keeps .sync_state-A06B4A372090333.json (directory listing).",
      "lesson": "Settings need a device picker plus per-device profiles (tablet root, reader app, folder map), not a single serial."
    }
  ],
  "open_questions": [
    "Should whole-series 'Delete extras' be fixed to delete only tablet-only chapters (current code deletes every depth-1 file in the series), and should reader sidecars (cover.jpg, details.json) always be protected?",
    "Should the port add empty-folder removal on the tablet (the script deliberately stubbed delete_tablet_dir), perhaps behind a stronger confirmation?",
    "Do you want a typed or second confirmation for deletes above some size or count? The old dashboard relied only on the preview modal.",
    "Which series should the batch 'find sources' run cover: tablet-only series, PC-missing chapters, a user-picked subset, or all tablet folders? Should results be one-click 'queue download in AIO' actions?",
    "Should per-series search-query overrides and pinned or preferred source URLs (the SHELTER / Tensura / Eleceed kinds of fixes) be stored in AIO settings and shown in the tab?",
    "Is a faster batch-search mode needed (a shorter probe deadline, as batch_search used 45 s)? That needs a new aio-dl.py flag, because PROBE_PHASE_DEADLINE_S has no CLI option.",
    "Default for new tablet folder names when pushing a series not yet on the tablet: canonical PC folder name (current; may carry a '(hid=X)' suffix), the .aio_series.json title, or a user-set per-series alias?",
    "Should the tab auto-rescan (or patch the cache) after each transfer, instead of requiring a manual Refresh?",
    "Should there be list search, filter and sort controls? The old dashboard had only fixed sections and fixed ordering.",
    "Support several devices at once (a device picker and per-device roots/profiles), given two serials appear in the script data?",
    "Keep the 'one batch at a time' and 'abort after 3 consecutive failures' policies, and should the failure budget be user-editable?",
    "Covers: reuse AIO library covers (cover.jpg) only, or keep the remote cover-URL fetch fallback from .aio_series.json?"
  ]
}
```
