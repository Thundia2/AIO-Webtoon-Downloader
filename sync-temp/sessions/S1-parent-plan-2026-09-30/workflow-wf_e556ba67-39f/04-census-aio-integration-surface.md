# Workflow wf_e556ba67-39f — census:aio-integration-surface (phase Census)

```json
{
  "area": "aio-integration-surface",
  "summary": "AIO's desktop app has three layers:\n- an Electron shell (UI-source/electron: main process, preload bridge, subprocess managers),\n- a React + Vite + Tailwind renderer (UI-source/src),\n- the Python backend, aio-dl.py.\n\n**No device code exists today.** The desktop app, aio-dl.py and sites/ never talk to a phone or tablet: there is no adb, MTP or Perfect Viewer code. adb appears only in the android/TESTING.md developer notes, so tablet sync is built from scratch.\n\n**Left rail.** It is a static five-entry TABS array in App.jsx: New, Search, Queue, Logs, Settings. Library is reached through the app icon. Tab bodies are rendered conditionally, so a tab unmounts on every switch. Any long-running scan or transfer state must therefore live in the main process or in a hook mounted inside useDownloader.\n\n**Settings.** They are stored in %APPDATA%/aio-downloader-ui/settings.json by history.js, which saves by shallow merge and migrates by schema version. SettingsTab owns every default and edits a local draft that a Save button commits; Reset returns the draft to defaults. It already has a 'Library' category (renderLibrary), which is where the opt-in switch belongs.\n\n**PC library root.** It is never fixed: it is workingDir plus the output dir, resolved as AIO_OUTPUT_DIR, then aio_config.json output_dir, then 'manga' (getConfiguredOutputRoot). On this machine that is D:\\AIO\\manga, laid out Komikku-style (Ch.NNN - Title.cbz).\n\n**Building blocks to reuse:**\n- library.js: library scan, parsers for both AIO chapter-filename formats, series identity.\n- series-merge.js: dry-run plan, then confirm, then move; never overwrites.\n- update-check-record.js + useUpdateCheck.js: long-job state that survives tab unmounts.\n- Downloader / Searcher: streaming child processes, Windows tree-kill, log classification.\n- runMetadataCli: short JSON helper call.\n- The Komikku writer, whose comment tells users to copy manga/<Series>/ into <Komikku-SAF>/local/ themselves. That manual step is exactly what this tab replaces.\n\n**Main risk.** The main working tree carries about 1.8k lines of uncommitted changes plus four untracked UI files, in exactly the files this feature must edit (App.jsx, main.js, preload.js, useDownloader.js). The agent worktrees do not have these changes.",
  "features": [
    {
      "name": "Library scan (PC-side inventory)",
      "description": "Walks the configured library root and returns one entry per series folder. Fields: title (the folder name), folderPath, files[{name,path,ext,size,modifiedAt}], chapterCount, totalSize, lastModified, seriesMeta (parsed .aio_series.json), seriesKey, anilistId, isImageOnly/imageChapters, coverPdfPath/thumbPath, and duplicate when a forked folder exists. The renderer keeps the result in useDownloader, so any tab can read it.",
      "source": "UI-source/electron/library.js:616-807; UI-source/electron/main.js:965-1049 (scan-library; root = getConfiguredOutputRoot(workingDir); thumbnails in userData/thumb-cache at 969); UI-source/src/hooks/useDownloader.js:247,1031",
      "durable": true,
      "notes": "Provides the PC side of a PC-vs-tablet comparison. The scan also renders mupdf thumbnails and fetches missing covers. A compare should reuse dl.libraryEntries or do a lighter readdir walk rather than calling scan-library repeatedly."
    },
    {
      "name": "Chapter-number extraction from filenames (both AIO naming formats)",
      "description": "extractChaptersFromFiles tries the Komikku format first (KOMIKKU_CH_RE, '[Vol.X ]Ch.NNN[.f][a-z]'). It then falls back to the legacy '<Series> Ch <label>' format via lastIndexOf(' Ch '), including split ranges 'A-B' and the '~' decimal encoding (converted back to '.'). _normalizeChapterToken strips zero padding: 005 -> 5, 005.5 -> 5.5, 005a -> 5a. getChaptersOnDevice combines this with a site's chapter list.",
      "source": "UI-source/electron/library.js:148 (KOMIKKU_CH_RE), 159-217 (extractChaptersFromFiles; legacy split at 187), 231-241 (_normalizeChapterToken), 255-273 (getChaptersOnDevice); exported at 1118",
      "durable": true,
      "notes": "This is the parser a PC<->tablet chapter diff needs on both sides. The Python twin (library_state.py:15-18 CHAPTER_FILE_RE) only handles the legacy 'Ch <n>' form and misses Komikku 'Ch.005' names."
    },
    {
      "name": "Image-only series support",
      "description": "Detects series downloaded as raw image folders (images/Chapter_N or ch_N), counts them and gives each a chapter token.",
      "source": "UI-source/electron/library.js:292-295 (_imageChapterToken), 299-311 (countImageChapterDirs), 316-396 (scanImagesTree), 408-425 (getImageChaptersOnDevice)",
      "durable": true
    },
    {
      "name": "Series identity and duplicate/forked-folder detection",
      "description": "A series is identified as 'hid:<site>:<hid>' or 'url:<normalized url>', taken from .aio_series.json and never from the folder title. groupEntriesBySeries clusters the folders of one series. findDuplicateSeries flags forks with reason same-series or same-anilist.",
      "source": "UI-source/electron/library.js:460-467 (normalizeSeriesUrl), 480-487 (seriesIdentityKey), 494-511 (primary ranking), 524-544 (groupEntriesBySeries), 560-603 (findDuplicateSeries); scanLibrary adds seriesKey/anilistId/duplicate at 777-805 (uncommitted)",
      "durable": true,
      "notes": "The tablet only exposes folder names unless .aio_series.json is copied over, so matching PC folders to tablet folders needs a name-level alias table. The anilist_synonyms field in .aio_series.json can seed alias suggestions."
    },
    {
      "name": "Forked-folder merge with dry-run plan",
      "description": "Moves chapters from source folders into a target series folder. Rules: never overwrite; both folders must be direct children of the library root; identity (site+hid/URL) or anilist_id must match; refused while a related download runs. Files move first, then metadata merges, then the emptied source is removed. Cross-device moves fall back to copy + remove (EXDEV). The UI shows the plan (moves, collisions, redundant files, leftovers) before a confirm click runs it.",
      "source": "UI-source/electron/series-merge.js:1-39 (rules), 180-273 (planFolderMerge), 284-341 (mergeSeriesMetaObjects), 343-355 (moveEntry; EXDEV at 351), 369-494 (mergeSeriesFolders); UI-source/electron/main.js:1759-1775 (merge-series-folders IPC); UI-source/src/components/LibraryTab.jsx:487-744 (MergeDuplicatesDialog), 749-764 (mergeErrorText)",
      "durable": true,
      "notes": "The house model for any file-moving action: compute a plan, show it, confirm, run it, report typed error codes. series-merge.js is untracked (not in git yet)."
    },
    {
      "name": "Library-wide update-check sweep with a main-process job record",
      "description": "check-all-updates runs --list-chapters for each series. Concurrency is bounded at 1-8 (default 4), and mangafire/comix run serially. Every event carries a runId and re-entry is refused. The main process keeps the canonical record, so the renderer can re-adopt the state after remounting. useUpdateCheck buffers push events until the snapshot arrives. UpdatesCenter is the slide-out dashboard.",
      "source": "UI-source/electron/main.js:1094-1377 (_checkSeriesUpdates), 1433-1677 (check-all-updates), 1683 (get-update-check-state), 1691 (cancel-check-all-updates); UI-source/electron/update-check-record.js:83-161; UI-source/src/hooks/useUpdateCheck.js:59-423; UI-source/src/components/UpdatesCenter.jsx:852-1044",
      "durable": true,
      "notes": "Template for a long-running device scan or sync whose progress must survive the tab unmounting. update-check-record.js and useUpdateCheck.js are untracked."
    },
    {
      "name": "Per-chapter ignore (cross-out) persisted to .aio_series.json",
      "description": "Chapter chips can be ticked (a transient selection) or crossed out. A cross-out is saved as chapters_ignored in the series metadata. The chip rows come with a legend.",
      "source": "UI-source/electron/main.js:1713 (set-chapters-ignored); UI-source/src/components/ChapterChips.jsx:44-115 (ChapterChip), 127-154 (legend), 170-209 (ChapterChips), 217-221 (selectedChapters)",
      "durable": true,
      "notes": "Ready-made UI vocabulary for including or excluding individual chapters in a sync diff. ChapterChips.jsx is untracked."
    },
    {
      "name": "Komikku/Mihon output mode",
      "description": "--komikku writes one CBZ per chapter, named '[Vol.NN ]Ch.NNN[ - Title].cbz', each with a ComicInfo.xml, plus cover.jpg and details.json at the series root. Output stays at <workingDir>/manga/<Series>/. Both the code and the Settings text tell the user to copy that into <Komikku-SAF>/local/ themselves.",
      "source": "aio-dl.py:9297-9306 (--komikku), 4958-5039 (_komikku_chapter_filename), 12982-12991 (per-chapter filename); UI-source/electron/downloader.js:159-166; UI-source/src/components/SettingsTab.jsx:1470-1492 (renderKomikku; hint at 1483-1484), 361 (defaults.komikku:false)",
      "durable": true,
      "notes": "This is exactly the manual step a tablet-sync tab replaces."
    },
    {
      "name": "Settings persistence with schema migrations",
      "description": "settings.json lives in userData. Writes are atomic (tmp + rename, with a copy fallback on EBUSY/EACCES/EPERM). Saving is a shallow merge, with a volatile-path filter for pythonCmd/scriptPath/workingDir. settingsSchemaVersion drives migrations.",
      "source": "UI-source/electron/history.js:23 (SETTINGS_SCHEMA_VERSION=1), 54-71 (_migrateSettings), 102-137 (_saveJson; EBUSY at 111), 175-177 (getSettings), 202-231 (saveSettings; merge at 230); UI-source/electron/main.js:648-672 (get-settings), 694-710 (save-settings)",
      "durable": true
    },
    {
      "name": "Settings screen: category nav, draft + Save, Reset, deep links",
      "description": "SettingsTab owns DEFAULT_SETTINGS and edits a local draft. It counts dirty keys for the Save button, resets to defaults, and can be opened on a specific category from another tab.",
      "source": "UI-source/src/components/SettingsTab.jsx:166-408 (DEFAULT_SETTINGS), 419-437 (CATEGORIES; library at 435-436), 469-494 (countDirtySettings), 544-657 (SaveSettingsButton), 913-916 (handleSave), 918-936 (handleReset), 2687-2763 (renderLibrary), 2770-2788 (SECTIONS), 2794-2889 (layout); UI-source/src/App.jsx:40, 216-219, 258 (settingsCategory deep link)",
      "durable": true
    },
    {
      "name": "Editable list UI (chips + add-by-name)",
      "description": "Settings -> Search Sources shows removable rounded chips with an X, a list of flagged rows, and an Input plus secondary Button that adds an item by name on Enter. disabledSites saves immediately instead of going through the draft.",
      "source": "UI-source/src/components/SettingsTab.jsx:2555-2684 (renderSearchSources), 851-858 (disabledSites immediate persist)",
      "durable": true,
      "notes": "The closest existing pattern for editing alias, skip and exception lists without inventing new UI."
    },
    {
      "name": "Short JSON helper-CLI call",
      "description": "runMetadataCli spawns python metadata_cli.py with PYTHONPATH set, writes JSON to stdin and parses JSON from stdout. It rejects on a non-zero exit and guards stdin against EPIPE. The helper forces UTF-8 stdio.",
      "source": "UI-source/electron/main.js:247-289; metadata_cli.py:8-23 (UTF-8 reconfigure), 28-44 (read/update subcommands)",
      "durable": true,
      "notes": "The model to follow if alias resolution or compare logic is written in Python."
    },
    {
      "name": "Streaming child processes, cancellation and log classification",
      "description": "Downloader._spawn streams stdout/stderr lines into the Logs tab and the progress display. cancel runs 'taskkill /pid <pid> /f /t' on Windows, and cancelAll is bounded at 5 s. Searcher collects JSON from stdout and passes stderr through stripAnsi, the noisy-line filter and classifyLogLevel.",
      "source": "UI-source/electron/downloader.js:721-931 (_spawn), 942-962 (cancel; taskkill at 952), 972 (runningCount), 981-993 (getRunning), 1004-1015 (cancelAll); UI-source/electron/searcher.js:119-248, 255-263; UI-source/electron/log-filter.js:41-65, 84-86, 113-133; UI-source/src/components/LogPanel.jsx:7, 19",
      "durable": true,
      "notes": "The model for spawning adb for long pull, push or list runs with live logs."
    },
    {
      "name": "Native folder/file pickers and reveal-in-Explorer",
      "description": "open-folder reveals a path. pick-folder and pick-file(filters) open OS dialogs.",
      "source": "UI-source/electron/main.js:882-904; UI-source/electron/preload.js:46-48",
      "durable": true,
      "notes": "Useful for choosing adb.exe or a PC folder. Folders on the tablet cannot be picked with an OS dialog over adb, so a remote folder browser (adb shell ls) would be needed."
    },
    {
      "name": "localfile:// protocol for local images",
      "description": "Serves local covers and thumbnails to the renderer.",
      "source": "UI-source/electron/main.js:109-117 (register), 1891-1899 (handler); UI-source/src/components/LibraryTab.jsx:46-50 (fileToUrl)",
      "durable": true
    },
    {
      "name": "Quit gate and pre-quit child cleanup",
      "description": "Closing the window prompts only if downloader.runningCount() > 0, and quit:confirm proceeds. Applying an app update and window-all-closed both await downloader.cancelAll(), so no child process outlives Electron.",
      "source": "UI-source/electron/main.js:555-569, 869-879, 1857-1873, 1953-1961",
      "durable": true,
      "notes": "None of these can see a running adb transfer today."
    },
    {
      "name": "Separate userData JSON state file",
      "description": "The download queue lives in its own download_queue.json ({queue, running, savedAt}) with dedicated get/save IPC, outside settings.json.",
      "source": "UI-source/electron/history.js:11, 30, 234-260; UI-source/electron/preload.js:42-43",
      "durable": true,
      "notes": "A pattern for storing tablet profiles, alias tables and exception lists without the side effects of the Save draft, Reset or shallow merge."
    },
    {
      "name": "Immediate-persist UI options with stale-merge guard",
      "description": "LibraryTab keeps libraryOpts in a ref, so each partial update merges onto the latest saved object before calling onSaveSettings.",
      "source": "UI-source/src/components/LibraryTab.jsx:1599-1608",
      "durable": true
    },
    {
      "name": "AIO for Android library location",
      "description": "The Android build downloads to getExternalFilesDir(null)/manga by default, which needs no permission and is visible over USB/MTP. With MANAGE_EXTERNAL_STORAGE granted it uses AppSettings.libraryPath instead (the Komikku/Mihon case), falling back safely if that path cannot be written.",
      "source": "android/app/src/main/java/com/aio/downloader/core/Aio.kt:36-53, 80-99; android/TESTING.md:170, 642",
      "durable": true,
      "notes": "The tablet may already run AIO for Android, writing into the same Komikku folder a PC sync pushes to."
    },
    {
      "name": "Writer-side folder and filename rules",
      "description": "Series folders are named by _sanitize_folder_component. Legacy chapter files are '<Series> Ch <label>.<ext>', with the last decimal dot written as '~'. Split parts are 'Ch A-B'. Canonical labels are f'{num:g}'.",
      "source": "aio-dl.py:496-503, 1346-1357, 6164-6165, 7065-7087, 10317-10365, 12982-12991",
      "durable": true
    }
  ],
  "hardcodes": [
    {
      "script": "UI-source/src/App.jsx",
      "name": "TABS (left rail)",
      "value": "[{id:'new',label:'New',icon:Download},{id:'search',label:'Search',icon:Search},{id:'queue',label:'Queue',icon:ListOrdered},{id:'logs',label:'Logs',icon:Terminal},{id:'settings',label:'Settings',icon:Settings}]. Library is not in TABS; it is the app-icon button at App.jsx:85-101.",
      "purpose": "The rail is static and supports no conditional entries. The opt-in tab must be inserted before 'settings' whenever a settings flag is on.",
      "source": "UI-source/src/App.jsx:25-31, 104-157, 165-167",
      "should_be_user_setting": true
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "DEV_WORKING_DIR / DEV_SCRIPT_PATH / DEV_PYTHON_CMD",
      "value": "DEV_WORKING_DIR = path.resolve(__dirname,'..','..') (the repo root). DEV_SCRIPT_PATH = <repo>/aio-dl.py. DEV_PYTHON_CMD = <repo>/venv/Scripts/python.exe on win32 or <repo>/venv/bin/python if that exists; otherwise 'python' on Windows and 'python3' elsewhere.",
      "purpose": "Spawn defaults in dev mode",
      "source": "UI-source/electron/main.js:61-73",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "Packaged default working dir",
      "value": "<Documents>/AIO Downloader",
      "purpose": "workingDir used when settings.workingDir is empty in packaged builds",
      "source": "UI-source/electron/main.js:215",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "Library output root resolution (getConfiguredOutputRoot)",
      "value": "Priority: env AIO_OUTPUT_DIR, then <workingDir>/aio_config.json output_dir, then 'manga'. A relative value resolves against workingDir. The CLI uses the same priority for -o/--output-dir.",
      "purpose": "The PC library root. The sync's PC side must derive from this and must never re-hard-code a path.",
      "source": "UI-source/electron/main.js:220-233, 361-367; aio-dl.py:8952-8957",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "Thumbnail cache dir",
      "value": "app.getPath('userData')/thumb-cache",
      "purpose": "Library thumbnails",
      "source": "UI-source/electron/main.js:969",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/history.js",
      "name": "userData state files",
      "value": "download_history.json, settings.json, download_queue.json in app.getPath('userData') (%APPDATA%/aio-downloader-ui on this machine)",
      "purpose": "Persistent history, preferences and queue snapshot",
      "source": "UI-source/electron/history.js:9-11, 28-30",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/library.js",
      "name": "OUTPUT_EXTENSIONS (and twins)",
      "value": "library.js OUTPUT_EXTENSIONS = pdf, epub, cbz. series-merge.js PAYLOAD_EXTS = .pdf, .epub, .cbz. library_state.py SUPPORTED_BOOK_EXTS = .cbz, .pdf, .epub.",
      "purpose": "Decides which files count as chapter payloads",
      "source": "UI-source/electron/library.js:45; UI-source/electron/series-merge.js:54; library_state.py:13",
      "should_be_user_setting": true
    },
    {
      "script": "UI-source/electron/library.js",
      "name": "IMAGE_EXTENSIONS",
      "value": "jpg, jpeg, png, webp, avif, gif",
      "purpose": "Detects image-only series",
      "source": "UI-source/electron/library.js:52",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/library.js",
      "name": "Chapter filename parsers",
      "value": "KOMIKKU_CH_RE = /^(?:Vol\\.\\S+\\s+)?Ch\\.(\\d+(?:\\.\\d+)?[a-z]?)/i. Legacy format: split on the last ' Ch ', then match ranges with /^(\\d+(?:~\\d+)?)\\s*-\\s*(\\d+(?:~\\d+)?)$/ and convert '~' back to '.'. Image dirs: /^(?:Chapter_|ch_)(-?\\d+(?:\\.\\d+)?)/i.",
      "purpose": "Parses both AIO filename formats; mirrors the aio-dl.py writers",
      "source": "UI-source/electron/library.js:148, 159-217, 292-295",
      "should_be_user_setting": false
    },
    {
      "script": "library_state.py",
      "name": "Python library-scanner constants",
      "value": "SAVED_PARAMS_FILE = download_params.json. SERIES_META_FILE = .aio_series.json. SUPPORTED_BOOK_EXTS = {.cbz,.pdf,.epub}. SUPPORTED_COVER_EXTS = {.jpg,.jpeg,.png,.webp,.gif}. CHAPTER_FILE_RE = (?:^|[ _])Ch[ _]([0-9]+(?:[.~][0-9]+)?)(?:-([0-9]+(?:[.~][0-9]+)?))? (IGNORECASE). RAW_IMAGE_DIR_RE = ^Chapter_([0-9]+(?:[.~][0-9]+)?)$ (IGNORECASE).",
      "purpose": "Library scanning for the Python, Android and CLI builds. CHAPTER_FILE_RE does NOT match Komikku 'Ch.005' names.",
      "source": "library_state.py:11-19",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/series-merge.js",
      "name": "SINGLETON_FILES",
      "value": "cover.jpg, cover.jpeg, cover.png, cover.webp, details.json, .cover.jpg, download_params.json",
      "purpose": "Per-series sidecar files, at most one per folder. They move when the target has none and are dropped otherwise. As a sync setting, this list would say which sidecars travel with the chapters; Komikku reads cover.jpg and details.json.",
      "source": "UI-source/electron/series-merge.js:59-62",
      "should_be_user_setting": true
    },
    {
      "script": "UI-source/electron/series-merge.js",
      "name": "METADATA_FILES",
      "value": ".aio_series.json, .series_hid, .mangafire_hid, .DS_Store",
      "purpose": "Identity and bookkeeping files that are never moved. Natural default skip list for a sync; the user may still want .aio_series.json copied so identity survives on the tablet.",
      "source": "UI-source/electron/series-merge.js:66-68",
      "should_be_user_setting": true
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "_SERIAL_BROWSER_SITES",
      "value": "mangafire, comix",
      "purpose": "Sites the update sweep checks one at a time",
      "source": "UI-source/electron/main.js:1433",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "Check-all concurrency clamp",
      "value": "Clamped to 1-8, default 4 (DEFAULT_SETTINGS.checkAllConcurrency: 4; UI shows a Badge '1-8')",
      "purpose": "Bounded parallelism. Precedent for a numeric setting such as a transfer concurrency.",
      "source": "UI-source/electron/main.js:1509-1512; UI-source/src/components/SettingsTab.jsx:266, 2737-2761",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "--list-chapters timeout",
      "value": "60 s per series",
      "purpose": "Bounds one update check",
      "source": "UI-source/electron/main.js:1188-1192",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/electron/main.js",
      "name": "Window size",
      "value": "1100x750 default, minimum 800x550",
      "purpose": "Layout limit: with the 64px (w-16) rail at App.jsx:83, the tab body must work at about 736px wide",
      "source": "UI-source/electron/main.js:525-528",
      "should_be_user_setting": false
    },
    {
      "script": "android/TESTING.md",
      "name": "adb executable location (developer docs only)",
      "value": "$env:LOCALAPPDATA\\Android\\Sdk\\platform-tools\\adb.exe (PowerShell); /c/Users/legoc/AppData/Local/Android/Sdk/platform-tools/adb.exe (Git Bash)",
      "purpose": "How the developer reaches the tablet. The desktop app has no adb path or adb code at all.",
      "source": "android/TESTING.md:37, 142",
      "should_be_user_setting": true
    },
    {
      "script": "android/app/src/main/java/com/aio/downloader/core/Aio.kt",
      "name": "AIO for Android default library dir",
      "value": "/storage/emulated/0/Android/data/com.aio.downloader/files/manga, which is getExternalFilesDir(null)/manga (TESTING.md:572 uses the /sdcard/... alias). A custom AppSettings.libraryPath is used when MANAGE_EXTERNAL_STORAGE is granted.",
      "purpose": "Where AIO on the tablet writes; one candidate target root among several",
      "source": "android/app/src/main/java/com/aio/downloader/core/Aio.kt:52-53, 80-99; android/TESTING.md:170, 403, 642",
      "should_be_user_setting": true
    },
    {
      "script": "aio-dl.py",
      "name": "Komikku chapter filename",
      "value": "'{Vol.NN }Ch.{label}{ - Title}.cbz'. The label is zero-padded to 3 digits below 1000 and keeps decimals (005.5); non-numeric labels are sanitized, or become '000'. 'Vol.{int:02d} ' is omitted when vol is None, '', 0 or '0'. ' - Title' appears only when the title differs from the label.",
      "purpose": "The writer format the tablet-side parser must accept",
      "source": "aio-dl.py:4958-5039, 12982-12987",
      "should_be_user_setting": false
    },
    {
      "script": "aio-dl.py",
      "name": "Legacy chapter filename",
      "value": "'<safe_title> Ch <label>.<ext>'. The last decimal dot becomes '~' via _DECIMAL_DOT_LAST_RE = (\\d)\\.(\\d)(?!.*\\d\\.\\d). Split parts are 'Ch A-B'. sanitize_filename also turns '_' into a space.",
      "purpose": "The writer format for non-Komikku output",
      "source": "aio-dl.py:10317-10365, 12988-12991, 6164-6165",
      "should_be_user_setting": false
    },
    {
      "script": "aio-dl.py",
      "name": "_sanitize_folder_component",
      "value": "Removes \\ / * ? : \" < > |, collapses whitespace, strips trailing ' .', and falls back to 'comic'",
      "purpose": "Series folder naming, i.e. what PC folder names look like",
      "source": "aio-dl.py:496-503",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/src/components/SettingsTab.jsx",
      "name": "countDirtySettings special keys",
      "value": "SKIP_TOP = {isPackaged, disabledSites}; NESTED = [defaults, searchOpts]",
      "purpose": "Dirty counting for the Save button. Any new immediate-persist or nested tablet-config key must be added here.",
      "source": "UI-source/src/components/SettingsTab.jsx:469-494 (SKIP_TOP at 476)",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/scripts/prepare-src.js",
      "name": "Packaged root Python helper whitelist",
      "value": "aio_search_cli.py, aio_config.py, library_state.py, metadata_editor.py, metadata_cli.py, migrate_library.py, api.py (sites/ is copied recursively at 140-150)",
      "purpose": "Only these root helpers ship in python-src. The list must be extended if a new Python helper is added.",
      "source": "UI-source/scripts/prepare-src.js:98-106",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/package.json",
      "name": "lucide-react version pin",
      "value": "^0.263.1 (0.263.1 installed). Funnel does not exist. Device/sync icons that do exist: Tablet, Tablets, Smartphone, Usb, Cable, Plug, FolderSync, FolderTree, HardDrive, HardDriveUpload, HardDriveDownload, GitCompare, FileDiff, ArrowLeftRight, ArrowRightLeft, RefreshCw, RefreshCcw, ListChecks, CheckCheck, Link2, Link2Off, Send, Upload, Scan, Radar.",
      "purpose": "Icon set for the rail entry and tab UI",
      "source": "UI-source/package.json; UI-source/src/components/LibraryTab.jsx:41-43",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/index.html",
      "name": "Google Fonts link",
      "value": "DM Sans + JetBrains Mono from fonts.googleapis.com",
      "purpose": "App typography (network dependency)",
      "source": "UI-source/index.html:8-12",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/src/components/DownloadTab.jsx",
      "name": "'Tablet reading' format label",
      "value": "{ value: 'pdf', label: 'PDF', desc: 'Tablet reading' }",
      "purpose": "Cosmetic; the only 'tablet' string in the desktop UI",
      "source": "UI-source/src/components/DownloadTab.jsx:130",
      "should_be_user_setting": false
    },
    {
      "script": "UI-source/src/components/UpdatesCenter.jsx",
      "name": "Hard-coded zinc-* side-sheet palette",
      "value": "The side sheet uses bg-[hsl(var(--card))], border-white/[0.06] and zinc-* utility colors instead of theme tokens",
      "purpose": "A dark-leaning exception to the token system. Copy its structure, not its colors.",
      "source": "UI-source/src/components/UpdatesCenter.jsx:852-867",
      "should_be_user_setting": false
    }
  ],
  "integration_notes": [
    "[rail] App.jsx:25-31 TABS is a module-level constant. The rail renders it at App.jsx:104-157, and the header label comes from TABS.find(...) at App.jsx:165-167. An opt-in tab needs a derived list (e.g. useMemo over TABS plus a dl.settings flag) with the new entry placed before 'settings', and the header lookup must use the same list. Pass the tab dl.settings and dl.saveSettings the same way LibraryTab gets them (App.jsx:174-185).",
    "[rail] Tab bodies are rendered conditionally (App.jsx:172-261: activeTab === 'x' && <...>), so the tablet tab unmounts on every switch. State for any running scan or transfer must live in main and/or in a hook mounted inside useDownloader (return object at useDownloader.js:1165-1198); see [job-state].",
    "[rail] activeTab (useState at App.jsx:34) is never reset when a tab disappears. Add a fallback effect for the case where the flag is turned off while the tablet tab is active. The user normally toggles the flag from Settings, so activeTab is usually 'settings' at that moment.",
    "[rail] Button anatomy to copy exactly (App.jsx:104-157): w-12 h-12 rounded-lg. Active state is bg-primary/10 text-primary with a 3px left bar (130-132). Icon is w-[18px] h-[18px]. The label is text-[9px], so it must be short (e.g. 'Tablet' or 'Sync'). The count badge (135-139) and red alert dot (145-154) are ready-made status indicators, e.g. for pending changes or a device error. The rail container is App.jsx:83 (w-16).",
    "[rail] Settings deep link: App.jsx:40 holds settingsCategory. SearchTab sets it to 'search' and then switches to Settings (App.jsx:216-219), and SettingsTab receives it as initialCategory (App.jsx:258, SettingsTab.jsx:676). The tablet tab can open Settings -> Library the same way, e.g. from an empty or 'not configured' state.",
    "[settings] The opt-in switch belongs in SettingsTab renderLibrary (SettingsTab.jsx:2687-2763; the 'library' category is at 435-436 and its section at 2787). Existing rows there use Checkbox + Label + ml-6 helper text (2689-2705). Elsewhere, the Switch-row idiom puts Label and description on the left and the Switch on the right. A separate SECTIONS entry {group:'library', title:'Tablet Sync', render: ...} also works, since nav counts derive from SECTIONS (2811).",
    "[settings] New keys must be added to DEFAULT_SETTINGS (SettingsTab.jsx:166-408), the single owner of defaults (CLAUDE.md:124, the 'UI architectural triad'). main.js and useDownloader should not carry their own defaults; useDownloader.js:196-202 shows the only exception, a pre-load placeholder.",
    "[settings] A new flag needs no main-process change to round-trip. get-settings (main.js:648-672) returns every saved key, and save-settings (main.js:694-710) persists any key; history.js:202-231 filters only pythonCmd/scriptPath/workingDir. useDownloader.saveSettings (useDownloader.js:1012-1017) merges into dl.settings immediately, so the rail updates right after Save.",
    "[settings] How the draft behaves:\n- handleSave writes the whole draft minus isPackaged (SettingsTab.jsx:913-916), so every DEFAULT_SETTINGS key becomes a stored value after the first save.\n- handleReset (918-936) replaces the draft with DEFAULT_SETTINGS.\n- countDirtySettings (469-494) compares top-level values by reference. Only defaults and searchOpts are treated as nested, and SKIP_TOP = {isPackaged, disabledSites}.\nAlias tables, device profiles or exception lists placed in the draft would be wiped by Reset + Save and miscounted as dirty unless they are added to SKIP_TOP/NESTED or stored elsewhere.",
    "[settings] Two immediate-persist precedents bypass the draft: disabledSites (SettingsTab.jsx:851-858, excluded via SKIP_TOP at 476) and libraryOpts (LibraryTab.jsx:1599-1608, merged through a ref so it never saves onto a stale object). history.saveSettings is a shallow merge (history.js:230), so a nested config object is replaced wholesale on every save; always merge onto the latest value.",
    "[settings] Stale keys persist forever. The user's settings.json still holds updateChecksUseSeededRating, which nothing in UI-source references. If a key is renamed later, migrations run through SETTINGS_SCHEMA_VERSION (history.js:23, 54-71).",
    "[pc-root] Compute the PC library root in main as getConfiguredOutputRoot(resolveSpawnPaths(history.getSettings()).workingDir) (main.js:220-233, 361-367), the same way scan-library does (main.js:965+). On this machine settings.json has workingDir 'D:\\AIO' and there is no D:\\AIO\\aio_config.json, so the root is D:\\AIO\\manga: 134 series folders with Komikku names like 'Ch.001 - Episode 1.cbz' (also named in CLAUDE.md:304). Never hard-code it.",
    "[pc-root] Handlers in main should read config from history.getSettings() at call time rather than trust paths sent by the renderer. The existing handlers follow this rule; merge-series-folders, for example, injects libraryRoot and runningDownloads itself (main.js:1759-1775).",
    "[ipc] Every channel is ipcMain.handle / ipcRenderer.invoke; there is no ipcMain.on. Push events go through sendToUI(channel, data) (main.js:415) to preload on* subscribers that return an unsubscribe function (preload.js:55-78 onDownloadLog, 191-195 onUpdateCheckProgress). Everything is exposed on window.electronAPI (preload.js:17).",
    "[ipc] Naming: newer feature families use a colon namespace (search:, metadata:, quit:, app-update:; see the comment at main.js:1845-1846). Names like tablet:devices, tablet:list, tablet:plan, tablet:apply, tablet:cancel and tablet:get-state, plus a 'tablet-sync-progress' push channel, would fit.",
    "[job-state] Pattern for long jobs:\n- update-check-record.js:83-161, createUpdateCheckRecord(send), provides isRunning, runId, snapshot, begin, rowFor, and emit, which drops events from stale runIds. The record is held in main (main.js:161).\n- useUpdateCheck.js is mounted inside useDownloader (useDownloader.js:258). It buffers push events until get-*-state resolves (useUpdateCheck.js:191-233) and re-adopts the snapshot on remount (92-113).\nReuse this shape for device scans and transfers so progress survives tab switches.",
    "[subprocess] adb is a native binary, so main can spawn it directly the way Downloader._spawn does (downloader.js:721-931: windowsHide, piped stdio, line buffering), with no Python hop. Cancellation must use the Windows tree kill ('taskkill /pid <pid> /f /t', downloader.js:942-962). Searcher's kill('SIGTERM') (searcher.js:255-263) does not kill child trees on Windows.",
    "[subprocess] Decode adb output as UTF-8 explicitly, because series names contain non-ASCII characters. Electron-spawned Python falls back to cp1252 on Windows (metadata_cli.py:8-23). To show sync output in the Logs tab, reuse log-filter.js stripAnsi/classifyLogLevel (84-86, 113-133) and the log entry shape {downloadId, line, level, timestamp} (useDownloader.js:18).",
    "[subprocess] If any logic goes into a new Python helper instead:\n- put it at the repo root;\n- whitelist it in UI-source/scripts/prepare-src.js:98-106, or it will not ship in python-src;\n- force UTF-8 stdio (metadata_cli.py:16-23);\n- call it like runMetadataCli (main.js:247-289, with PYTHONPATH = dirname(scriptPath)).",
    "[quit] A running transfer must be registered with the quit gate, which today only knows about the downloader:\n- the close listener checks only downloader.runningCount() (main.js:555-569);\n- app-update:apply-now sets quitConfirmed and awaits downloader.cancelAll() (main.js:1862-1873);\n- window-all-closed awaits downloader.cancelAll() (main.js:1953-1961).\nOtherwise, quitting mid-push leaves partial files on the tablet and orphaned adb children.",
    "[destructive] House rules for anything that deletes or overwrites: either a dry-run plan followed by an explicit confirm (MergeDuplicatesDialog, LibraryTab.jsx:487-744), or a two-click confirm with auto-cancel (SettingsTab.jsx:952-962 at 4000 ms; DetailView delete at LibraryTab.jsx:1253-1274 and 1385-1400). Never use window.confirm, which breaks Electron renderer focus (ResumeBar.jsx:43-44, LibraryTab.jsx:1225). series-merge never overwrites (series-merge.js:1-39).",
    "[parsing] Reuse library.js extractChaptersFromFiles/_normalizeChapterToken (library.js:159-241) for both the PC and the tablet file lists; they handle Komikku names and legacy '~' names. For consistency:\n- canonicalize labels like chapterLabel (series-merge.js:76-79; same as aio-dl.py _chap_label_str f'{num:g}' at 1346-1357);\n- sort with compareChapterLabels (series-merge.js:83-91) or naturalCompare (library.js:69, utils.js:42);\n- display chapter lists with chaptersToRangeString (utils.js:91-111).",
    "[aliases] Series identity is site+hid/URL (library.js:480-487), which the tablet side does not have unless .aio_series.json is copied too. Matching by name therefore needs a user-editable alias table.\n- JS has no title normalizer; LibraryTab facetKey is only trim + lowercase (LibraryTab.jsx:168-170).\n- The Python normalizer is sites/search_orchestrator.py:5194-5211 (_normalize_title: lowercase, drop parentheticals, non-alphanumerics to spaces, collapse whitespace).\n- Fuzzy scoring lives only in sites/fuzzy_match.py (CLAUDE.md:155).\n- anilist_synonyms in .aio_series.json can seed alias suggestions.",
    "[design] Tokens are HSL CSS variables for light and dark (globals.css:17-47, 50-76), mapped in tailwind.config.js:15-56, which also defines success/warning/info.\n- primary: 220 75% 50% (light) / 217 75% 58% (dark)\n- success: 142 60% 40%; warning: 38 92% 50%; info: 200 80% 50%\n- radius: 0.5rem; darkMode 'class' (tailwind.config.js:5)\nType is DM Sans for body text (globals.css:86) and JetBrains Mono for .log-text (154-158). Animations are slide-in 0.2s, slide-up 0.15s and pulse-subtle 2s (tailwind.config.js:65-83).",
    "[design] Primitives in UI-source/src/components/ui/primitives.jsx:\n- Button (14): variants default/secondary/destructive/ghost/outline; sizes sm/default/lg/icon\n- Input (56), Textarea (74), Label (92), Switch (107), Slider (136)\n- Select (157) is a native select; Checkbox (177); Card (211)\n- Badge (223) does not spread props, so it cannot take onClick; LibraryTab MetaChip (214-229) hand-rolls clickable chips\n- SectionHeader (246), Collapsible (258)\nThere is no Dialog, Tooltip or Tabs primitive; dialogs are hand-built overlays (e.g. ConfirmQuitDialog.jsx, MergeDuplicatesDialog).",
    "[design] Accent meanings:\n- orange = new chapters (UpdatesCenter SECTION_THEME 69-98; ChapterChips 44-115)\n- amber = advisory/managed/duplicate (ManagedBanner SettingsTab.jsx:98-118; DuplicateBadge LibraryTab.jsx:366-393; the dirty Save ring at 544-657)\n- emerald = success (the Save sweep); sky = in progress; red = error; violet = images/AniList\nA sync diff maps naturally onto these: orange = missing on tablet, emerald = in sync, amber = alias needed or conflict, red = error.",
    "[design] Layout idioms to reuse:\n- tab toolbar 'flex items-center gap-2 px-4 py-2.5 border-b bg-card/20' (LibraryTab.jsx:2042-2198)\n- chip rows with staggered animate-slide-up (2205-2245)\n- card grid 'grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-4' (2268) with skeletons (2279-2289)\n- section headings 'text-xs font-semibold text-muted-foreground uppercase tracking-wider'\n- file rows 'bg-card/40 border border-border/30 hover:border-primary/30' (1443-1447)\n- modal overlay 'fixed inset-0 z-50 ... bg-background/80 backdrop-blur-sm' with a 'max-w-lg max-h-[85vh]' card (487-744)\n- right side sheet max-w-[480px] (UpdatesCenter.jsx:852-867)\n- Settings two-pane nav with a sticky footer (SettingsTab.jsx:2794-2889)\nUpdatesCenter hard-codes zinc-* colors, so copy its structure but take colors from theme tokens.",
    "[design] The window minimum is 800x550 (main.js:527-528) and the rail takes 64px (App.jsx:83), so the tab body must work at about 736px wide.",
    "[komikku-target] downloader.js:159-166 and aio-dl.py:9297-9306 both say output stays at <workingDir>/manga/<Series>/ and the user copies it into <Komikku-SAF>/local/ themselves. SettingsTab.jsx:1483-1484 repeats this in the UI. The sync tab replaces that manual step, so this helper text is a natural place to point to the tab when it is enabled.",
    "[greenfield] There is no adb, MTP or Perfect Viewer code in UI-source, aio-dl.py or sites/ ('Perfect Viewer' has zero hits). The only device knowledge is in android/TESTING.md and Aio.kt:36-99. TESTING.md gives the adb path (37), notes that 'unauthorized' means the tablet is showing the USB-debugging prompt (41), and gives the device library path (170).",
    "[in-flight] Branch fix/mangafire-cloudflare-challenge is at d1ae7d6, ahead of fork by 1 commit.\n- Uncommitted UI-source diff: 10 files, +1787/-544 (main.js, preload.js, library.js, downloader.js, App.jsx, LibraryTab.jsx, UpdatesCenter.jsx, useDownloader.js, downloadArgs.js, utils.js).\n- Untracked UI files: electron/series-merge.js, electron/update-check-record.js, src/components/ChapterChips.jsx, src/hooks/useUpdateCheck.js.\n- Also modified: aio-dl.py, library_state.py, sites/*, android/*, tests/*.\nThe tablet tab must touch the same files (App.jsx, main.js, preload.js, useDownloader.js).",
    "[in-flight] Four agent worktrees under .claude/worktrees/ (agent-a4c28bab5f3ff5c7f, agent-a70ab5579168503df, agent-ae93ca7458b4792cd, agent-aef9367a777af1246) and a scratchpad baseline worktree are all at d1ae7d6 with Android-only changes. None of them contains the main tree's uncommitted UI-source work. Implementing in a fresh worktree or branch would silently build on stale copies of App.jsx, main.js and preload.js.",
    "[in-flight] Per CLAUDE.md:61-64, run git status and 'gh pr list --state all --author Thundia2' before doing anything, and leave unrecognized modified files alone or ask. Per CLAUDE.md:218-278, commit or push only after the work is verified and the user agrees. If a PR is open, stack onto its branch; otherwise branch fresh off upstream/main.",
    "[verification] UI verification is 'cd UI-source; npm run build' (CLAUDE.md:157-187). Offline JS tests for pure main-process logic live in the gitignored /tools/ folder (e.g. tools/_test_series_merge.js, tools/_test_update_check_record.js). An alias resolver or diff planner written as a pure module can get a tools/_test_*.js the same way.",
    "[risk] Git warns 'LF will be replaced by CRLF' on the modified UI files, so keep line endings consistent when editing them."
  ],
  "state_files": [
    {
      "file": "%APPDATA%/aio-downloader-ui/settings.json",
      "schema": "Flat JSON object of top-level settings keys, e.g. pythonCmd, scriptPath, workingDir, verboseAlways, collapseSplits, checkAllConcurrency, checkAllIncludeCompleted, useFileBasedChapterCheck, disabledSites[], libraryOpts{sortBy, filters}, defaults{... komikku ...}, searchOpts{}, settingsSchemaVersion. It also keeps legacy keys such as updateChecksUseSeededRating.",
      "purpose": "User preferences; the natural home for the opt-in flag",
      "writer": "UI-source/electron/history.js:202-231 (saveSettings), 54-71 (migration)",
      "reader": "UI-source/electron/main.js:648-672 (get-settings); UI-source/src/hooks/useDownloader.js:349; SettingsTab hydration 734-828"
    },
    {
      "file": "%APPDATA%/aio-downloader-ui/download_queue.json",
      "schema": "{queue: [...], running: [...], savedAt}",
      "purpose": "Queue snapshot restored at launch. Model for a separate tablet-sync config/state file.",
      "writer": "UI-source/electron/history.js:254-260",
      "reader": "UI-source/electron/history.js:250-252; main.js queue:get (854)"
    },
    {
      "file": "%APPDATA%/aio-downloader-ui/download_history.json",
      "schema": "Array of past download records",
      "purpose": "Download history",
      "writer": "UI-source/electron/history.js:170",
      "reader": "UI-source/electron/main.js:846 (get-history)"
    },
    {
      "file": "<library root>/<Series>/.aio_series.json",
      "schema": "url, hid, title, site, format, language, download_volumes, status, authors, cover, genres, chapters_downloaded, chapters_skipped_fragments, total_available_at_download, last_downloaded_at, anilist_id, mal_id, country_of_origin, media_format, anilist_synonyms, anilist_tags, anilist_spoiler_tags; optionally chapters_ignored and final_file_chapters",
      "purpose": "Per-series identity and chapter bookkeeping. Source of seriesKey and anilistId; anilist_synonyms can seed alias hints.",
      "writer": "aio-dl.py; UI-source/electron/main.js:1713 (set-chapters-ignored), 1781 (save-series-meta); UI-source/electron/series-merge.js:284-341",
      "reader": "UI-source/electron/library.js:711-715 (scanLibrary)"
    },
    {
      "file": "<library root>/<Series>/.series_hid and .mangafire_hid",
      "schema": "Plain-text hid marker",
      "purpose": "Legacy and per-site identity markers",
      "writer": "aio-dl.py",
      "reader": "UI-source/electron/main.js:235-245 (readHidMarker)"
    },
    {
      "file": "<workingDir>/aio_config.json",
      "schema": "{output_dir: string, ...}",
      "purpose": "Overrides the library folder location (read only if AIO_OUTPUT_DIR is unset)",
      "writer": "user",
      "reader": "UI-source/electron/main.js:220-233; aio_config.py (see prepare-src.js:118-129)"
    },
    {
      "file": "<library root>/<Series>/cover.jpg + details.json (Komikku mode)",
      "schema": "Cover image; details.json holding status/genres/authors as a JSON object",
      "purpose": "Komikku LocalSource metadata that must travel with the chapter CBZs",
      "writer": "aio-dl.py --komikku (9297-9306)",
      "reader": "Komikku/Mihon on the device"
    },
    {
      "file": "app.getPath('userData')/thumb-cache",
      "schema": "JPEG thumbnails (THUMB_WIDTH 180, quality 75)",
      "purpose": "Library cover thumbnails",
      "writer": "UI-source/electron/library.js:77-81, 827-911",
      "reader": "LibraryTab via localfile://"
    }
  ],
  "external_deps": [
    "Electron ^40.6.1: main/preload/renderer split with contextIsolation true and nodeIntegration false (main.js:523-573)",
    "React ^18.2.0, Vite ^7.3.1 and Tailwind CSS ^3.4.1 (no Tailwind plugins)",
    "lucide-react pinned at 0.263.1 (no Funnel icon; see LibraryTab.jsx:41-43)",
    "clsx + tailwind-merge (cn in utils.js:8-10) and class-variance-authority",
    "mupdf ^1.27.0 for PDF thumbnails (library.js)",
    "electron-updater ^6.6.2 and electron-builder ^26.8.1 (NSIS; python-src shipped via extraResources)",
    "Python: the dev venv, or the embedded Python bundled in packaged builds, runs aio-dl.py and the helper CLIs",
    "Google Fonts fetched over the network (UI-source/index.html:8-12)",
    "adb (Android platform-tools): neither used nor bundled by the desktop app today; documented only at android/TESTING.md:37 as %LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe"
  ],
  "cli_flags": [
    {
      "script": "aio-dl.py",
      "flag": "-o / --output-dir",
      "meaning": "Directory for library outputs. Priority: this flag, then AIO_OUTPUT_DIR, then aio_config.json, then 'manga'.",
      "default": "None (falls through to 'manga' under the working dir)",
      "source": "aio-dl.py:8952-8957"
    },
    {
      "script": "aio-dl.py",
      "flag": "--series-dir",
      "meaning": "Write into an existing folder instead of deriving one from the title. Ignored with a warning unless the path is an existing directory inside --output-dir that holds the same series or is empty. The UI maps seriesDir to this flag (uncommitted).",
      "default": "None",
      "source": "aio-dl.py:8958-8969; UI-source/electron/downloader.js:66"
    },
    {
      "script": "aio-dl.py",
      "flag": "--komikku",
      "meaning": "Writes Komikku/Mihon/Tachiyomi per-chapter CBZs with ComicInfo.xml, plus cover.jpg and details.json. Forces --format cbz --keep-chapters --no-final-file. Output stays at <workingDir>/manga/<Series>/ for the user to copy to the device.",
      "default": "off (DEFAULT_SETTINGS.defaults.komikku = false)",
      "source": "aio-dl.py:9297-9306; UI-source/electron/downloader.js:159-166; UI-source/src/components/SettingsTab.jsx:361"
    },
    {
      "script": "aio-dl.py",
      "flag": "--list-chapters",
      "meaning": "Prints the chapter list and series metadata as JSON, then exits. Update checks call it with --verbose and optionally --language, --site and --collapse-splits.",
      "default": "off",
      "source": "aio-dl.py:8843-8845; UI-source/electron/main.js:1094-1377"
    }
  ],
  "destructive_ops": [
    {
      "op": "delete-series: recursive delete of a series folder (fs.rmSync)",
      "source": "UI-source/electron/main.js:1059",
      "safety_rails": "Two-step confirm in DetailView (LibraryTab.jsx:1253-1274, 1385-1400); never a native confirm."
    },
    {
      "op": "merge-series-folders: moves files between series folders, then removes the emptied source",
      "source": "UI-source/electron/series-merge.js:369-494; UI-source/electron/main.js:1759-1775",
      "safety_rails": "The dry-run plan is shown first and an explicit confirm is required. Existing files are never overwritten; collisions are reported. Both folders must be direct children of the library root, and identity or anilist_id must match. Refused while a related download runs. Files move before metadata, and the source is removed last. Errors are typed: no_target, no_library_root, no_sources, outside_library, missing_folder, target_is_source, identity_mismatch, download_running, unreadable_source."
    },
    {
      "op": "delete-temp: removes a resumable tmp_<hid> folder",
      "source": "UI-source/electron/main.js:817",
      "safety_rails": "Per-item confirm held in ResumeBar React state (ResumeBar.jsx:42-45)."
    },
    {
      "op": "reinstall-python: wipes and re-downloads the bundled Python environment",
      "source": "UI-source/electron/main.js:1824",
      "safety_rails": "Two-click confirm that auto-cancels after 4000 ms (SettingsTab.jsx:952-962)."
    },
    {
      "op": "Settings Reset: replaces the draft with DEFAULT_SETTINGS",
      "source": "UI-source/src/components/SettingsTab.jsx:918-936",
      "safety_rails": "Affects only the draft; nothing persists until Save. Any tablet config kept in the draft would be wiped by Reset followed by Save."
    },
    {
      "op": "Quit / apply app update: kills running downloader child processes",
      "source": "UI-source/electron/main.js:555-569, 1862-1873, 1953-1961",
      "safety_rails": "Quit prompt while downloads run; cancelAll is bounded at 5 s (downloader.js:1004-1015). adb children are not covered today."
    }
  ],
  "algorithms": [
    {
      "name": "Chapter token normalization",
      "description": "Strips zero padding and keeps suffix letters: '005' -> '5', '005.5' -> '5.5', '005a' -> '5a'.",
      "source": "UI-source/electron/library.js:231-241"
    },
    {
      "name": "Canonical chapter label",
      "description": "Numeric labels are printed in their shortest form (Number(c) -> String in JS; f'{num:g}' in Python), so '4.0' equals '4'. Non-numeric labels pass through unchanged.",
      "source": "UI-source/electron/series-merge.js:76-79; aio-dl.py:1346-1357"
    },
    {
      "name": "Chapter comparators",
      "description": "compareChapterLabels orders by parseFloat, with non-numeric labels last among themselves. aio-dl.py _chapter_label_sort_key returns (main, 0|1, sub, lower), so 8 < 8~5 < 9, and empty or non-numeric labels sort at 10**9. naturalCompare is an Intl.Collator with numeric ordering.",
      "source": "UI-source/electron/series-merge.js:83-91; aio-dl.py:7067-7087; UI-source/electron/library.js:69-72; UI-source/src/lib/utils.js:42-45"
    },
    {
      "name": "Chapter range compression",
      "description": "chaptersToRangeString turns a chapter list into a string like '1-5, 7, 9.5'. It gains an opts.excluding option in the uncommitted diff.",
      "source": "UI-source/src/lib/utils.js:91-111"
    },
    {
      "name": "Series identity key and grouping",
      "description": "The key is hid:<site>:<hid> when both are known, else url:<normalized url>, else null. Folders are grouped as duplicates by key or by anilist_id.",
      "source": "UI-source/electron/library.js:460-487, 524-603"
    },
    {
      "name": "Folder merge planning",
      "description": "Classifies every source file as a move, collision, redundant file or leftover, using chapter numbers (ranges capped at 5000) and the singleton/metadata sets. images/Chapter_* dirs are included.",
      "source": "UI-source/electron/series-merge.js:112-273"
    },
    {
      "name": "Job record with runId superseding",
      "description": "Each sweep gets a runId and events from older runs are dropped. The renderer adopts a snapshot, then applies the events it buffered meanwhile.",
      "source": "UI-source/electron/update-check-record.js:83-161; UI-source/src/hooks/useUpdateCheck.js:92-233"
    },
    {
      "name": "Title normalization (Python only)",
      "description": "Lowercase, drop parentheticals, turn non-alphanumerics into spaces, collapse whitespace. JS has no equivalent.",
      "source": "sites/search_orchestrator.py:5194-5211"
    },
    {
      "name": "Filename decimal encoding",
      "description": "The last decimal dot in a legacy chapter label is written as '~' via (\\d)\\.(\\d)(?!.*\\d\\.\\d). Readers convert it back to '.'.",
      "source": "aio-dl.py:10339-10365; UI-source/electron/library.js:159-217"
    }
  ],
  "open_questions": [
    "Where should the tablet configuration live (adb path, device serial(s), tablet root folders per reader app, alias table, skip/exception lists)? Option A is settings.json, in which case countDirtySettings SKIP_TOP/NESTED, handleReset and the shallow merge all need handling. Option B is a dedicated userData JSON file with its own IPC, like download_queue.json.",
    "Should the 'show tab' switch in Settings -> Library go through the Save draft, consistent with the other Library options? Or should it persist immediately like disabledSites, so the rail updates without pressing Save?",
    "How should adb be found? Option A is a user setting with auto-detect (PATH, %LOCALAPPDATA%\\Android\\Sdk\\platform-tools, ANDROID_HOME/ANDROID_SDK_ROOT) plus a Browse button. Option B is bundling platform-tools with the app, which raises size and licensing questions.",
    "Should Node spawn adb directly, needing no packaging change? Or should a Python helper own the compare logic, which needs the prepare-src.js whitelist and UTF-8 stdio?",
    "Which tablet targets must work out of the box: a Perfect Viewer folder, Komikku's <SAF root>/local/<Series>/, the AIO for Android library (/storage/emulated/0/Android/data/com.aio.downloader/files/manga), or several per device?",
    "Is the sync one-way, PC -> tablet (copy missing chapters)? Or should it also report or pull chapters that exist only on the tablet? May it ever delete or overwrite on the tablet, and if so behind which confirm?",
    "Should several connected devices (adb serials) be supported and remembered per device?",
    "What should happen if the app is quit during a transfer: block with the existing quit prompt, or cancel and clean up partial files?",
    "Which branch or worktree should get this work, given the large uncommitted and untracked UI-source changes in the main tree that the agent worktrees do not have?"
  ],
  "observed_failures": [
    {
      "what": "A hard-coded absolute developer path in the renderer's default settings was silently created with mkdirSync on other machines. Dev spawn paths once showed users a stranger's home path in Settings.",
      "evidence": "UI-source/src/hooks/useDownloader.js:168-172; UI-source/electron/main.js:56-57",
      "lesson": "Derive every tablet and PC path from settings or runtime discovery. Ship no absolute paths."
    },
    {
      "what": "Native window.confirm breaks focus and input in the Electron renderer.",
      "evidence": "UI-source/src/components/ResumeBar.jsx:43-44; UI-source/src/components/LibraryTab.jsx:1225",
      "lesson": "Use React-state two-click confirms or a plan-then-confirm dialog."
    },
    {
      "what": "Fire-and-forget taskkill let Python children outlive Electron and keep tmp_<hid> locks.",
      "evidence": "UI-source/electron/main.js:1954-1958, 1857-1859",
      "lesson": "On quit or update, await a bounded tree-kill of any adb child."
    },
    {
      "what": "An old opt-in default stored an explicit false for every user who saved, which left the app updater off until a schema migration cleared it.",
      "evidence": "UI-source/electron/main.js:1942-1944; UI-source/electron/history.js:54-71",
      "lesson": "handleSave writes every DEFAULT_SETTINGS key, so defaults become sticky stored values. Changing a tablet default later needs a migration. Keep complex tablet config out of DEFAULT_SETTINGS."
    },
    {
      "what": "Python spawned by Electron falls back to cp1252 on Windows and crashes on non-ASCII JSON.",
      "evidence": "metadata_cli.py:8-23",
      "lesson": "Force UTF-8 in any helper, and decode adb output as UTF-8."
    },
    {
      "what": "lucide-react 0.263.1 lacks newer icon names, and importing a missing one renders undefined.",
      "evidence": "UI-source/src/components/LibraryTab.jsx:41-43",
      "lesson": "Check icon names against 0.263.1 (e.g. use Filter, not Funnel)."
    },
    {
      "what": "The Python library_state CHAPTER_FILE_RE does not match Komikku 'Ch.005' filenames, while library.js does.",
      "evidence": "library_state.py:15-18 vs UI-source/electron/library.js:148",
      "lesson": "Compare Komikku libraries with the JS parser, or extend the Python regex first."
    }
  ]
}
```
