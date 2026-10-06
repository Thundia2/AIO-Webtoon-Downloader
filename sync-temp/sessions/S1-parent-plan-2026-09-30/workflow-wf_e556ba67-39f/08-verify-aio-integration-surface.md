# Workflow wf_e556ba67-39f — verify:aio-integration-surface (phase Verify)

```json
{
  "area": "aio-integration-surface",
  "confirmed": [
    {
      "claim": "No device code exists today. There is no adb, MTP or Perfect Viewer code in UI-source, aio-dl.py or sites/. adb appears only in the developer notes.",
      "evidence": "A case-insensitive grep for \\badb\\b|perfect ?viewer|\\bmtp\\b over the repo (node_modules excluded) hits only android/TESTING.md (adb path at :37, 'unauthorized' means the USB-debugging prompt at :41-43, device library pull at :170) and docs/Widevine.md:28. No *.py file contains 'tablet'. The only 'tablet' string in the UI is UI-source/src/components/DownloadTab.jsx:130."
    },
    {
      "claim": "The left rail is a static module-level TABS array (new, search, queue, logs, settings). Library is the app-icon button. The header label comes from TABS.find. Tab bodies render conditionally, and activeTab has no fallback when a tab disappears.",
      "evidence": "UI-source/src/App.jsx:25-31 (TABS), 85-101 (library icon), 104-157 (rail map: active bar 130-132, queue badge 135-139, logs red dot 145-154), 165-167 (header lookup), 172-261 (activeTab==='x' && ...), 34 (useState('new'); nothing in the file resets it)."
    },
    {
      "claim": "The opt-in switch belongs in the Settings 'library' category, rendered by renderLibrary (Checkbox + Label + ml-6 helper rows). Nav counts derive from the SECTIONS registry. A Switch-row idiom (label left, Switch right) exists elsewhere.",
      "evidence": "UI-source/src/components/SettingsTab.jsx:435-436 (CATEGORIES library), 2687-2763 (renderLibrary; rows 2689-2705 and 2713-2729), 2770-2788 (SECTIONS; library at 2787), 2811 (count = SECTIONS.filter(...).length). Switch rows at 1449-1462, 1471-1491, 1500-1516."
    },
    {
      "claim": "How the Settings draft behaves: DEFAULT_SETTINGS seeds the draft and is the Reset target. handleSave writes the whole draft minus isPackaged. countDirtySettings compares top-level keys by reference, with SKIP_TOP={isPackaged, disabledSites} and NESTED=[defaults, searchOpts].",
      "evidence": "SettingsTab.jsx:166-408, 666 (structuredClone(DEFAULT_SETTINGS)), 469-494 (SKIP_TOP 476, NESTED 477, walks only the draft's keys 480-483), 913-916 (handleSave), 918-936 (handleReset keeps prev.isPackaged)."
    },
    {
      "claim": "A new settings key round-trips with no main-process change. get-settings spreads every saved key. save-settings persists any key. history.saveSettings is a shallow top-level merge that filters only pythonCmd, scriptPath and workingDir. useDownloader.saveSettings merges into dl.settings after the IPC resolves.",
      "evidence": "UI-source/electron/main.js:648-672 (...saved), 694-710. UI-source/electron/history.js:202-231 (PATH_KEYS at 208, merge at 230). UI-source/src/hooks/useDownloader.js:1012-1017."
    },
    {
      "claim": "There are precedents for settings that save immediately, bypassing the draft: disabledSites saves through onSave from the settings prop, and libraryOpts merges onto a ref so two quick writes can't land on a stale base. Diff-aware hydration protects unsaved draft edits.",
      "evidence": "SettingsTab.jsx:851-858, 784-826. UI-source/src/components/LibraryTab.jsx:1599-1608."
    },
    {
      "claim": "The PC library root is getConfiguredOutputRoot(workingDir): AIO_OUTPUT_DIR, then <workingDir>/aio_config.json output_dir, then 'manga'. Python resolves the same file relative to its cwd, and main spawns Python with cwd set to workingDir. On this machine workingDir is D:\\AIO, there is no aio_config.json, and the root D:\\AIO\\manga holds Komikku-named CBZs.",
      "evidence": "main.js:220-233, 361-367, 965-968, 1175 (cwd: workingDir). aio_config.py:15-16 (Path.cwd()), 32-52. %APPDATA%\\aio-downloader-ui\\settings.json:4 \"workingDir\": \"D:\\\\AIO\". D:\\AIO\\aio_config.json is absent. Sample file: D:\\AIO\\manga\\'Tis Time for Torture, Princess\\Ch.001 - Torture 1.cbz. There are 22,491 *.cbz files at depth 2."
    },
    {
      "claim": "The chapter parsers handle both AIO filename formats. KOMIKKU_CH_RE covers Komikku names. The legacy format splits on ' Ch ', with A-B ranges and '~' decimals. Komikku tokens are normalized (005 -> 5, 005.5 -> 5.5, 005a -> 5a). The Python CHAPTER_FILE_RE does not match 'Ch.005'.",
      "evidence": "UI-source/electron/library.js:148, 159-217 (lastIndexOf(' Ch ') at 187, range regex 195-197, '~' to '.' at 201-208), 231-241. library_state.py:15-18 requires a space or underscore after 'Ch'. Nuance: library_state.scan_library still unions chapters_downloaded (482-485), so Komikku series don't show up empty in the Python scanner."
    },
    {
      "claim": "Series identity is site+hid first, then the normalized URL, never the title. groupEntriesBySeries picks the richest folder as primary. findDuplicateSeries reports same-series separately from same-anilist.",
      "evidence": "library.js:460-467, 480-487, 495-511, 524-543, 560-603. scanLibrary attaches seriesKey and anilistId at 782-783 and duplicate at 801-805. Python twin: library_state.py:360-396, 435-464."
    },
    {
      "claim": "Folder-merge safety rails:\n- dryRun defaults to true;\n- containment: path.dirname(folder) must equal the library root;\n- target_is_source is refused;\n- identity or anilist_id must match;\n- refused while a related download runs (a running job with an unknown URL counts as related);\n- never overwrites: collisions are decided by chapter NUMBER first, then by filename;\n- order is files, then metadata, then source removal;\n- cross-device moves fall back to copy + remove (EXDEV);\n- errors are typed codes.\nThe UI shows the dry-run plan before the confirm.",
      "evidence": "UI-source/electron/series-merge.js:1-39, 112-152, 180-273 (number-first collision 211-223), 343-355 (EXDEV at 351), 369-494 (dryRun 372, containment 389-392, identity 401-412, running downloads 415-426, order 460-491). main.js:1759-1775 injects libraryRoot and runningDownloads after spreading the renderer's opts. LibraryTab.jsx:487-744, 749-764."
    },
    {
      "claim": "Long-job pattern: main holds the record, supersedes old runs by runId, drops stale emissions and serves a snapshot. A re-entrant start gets the snapshot back unless force is set. The renderer hook lives in useDownloader and buffers events until the snapshot resolves.",
      "evidence": "UI-source/electron/update-check-record.js:83-161 (emit drops stale runIds at 137-150). main.js:161, 1435-1447, 1493-1500, 1659-1674 (done is emitted in a finally), 1683, 1691-1696. UI-source/src/hooks/useUpdateCheck.js:191-233. useDownloader.js:258."
    },
    {
      "claim": "IPC conventions: only ipcMain.handle / ipcRenderer.invoke are used. Pushes go through sendToUI to preload on* subscribers that return an unsubscribe function. Everything is exposed on window.electronAPI. Newer families use colon namespaces. contextIsolation is on and nodeIntegration is off.",
      "evidence": "A grep of ipcMain in UI-source/electron finds only .handle and one .removeHandler (main.js:498-1862). main.js:409-417 (sendToWindow/sendToUI). UI-source/electron/preload.js:17, 55-78, 191-195. main.js:1845-1846 (namespace comment), 533-536."
    },
    {
      "claim": "The quit gate knows only about downloads. The close listener prompts only when downloader.runningCount()>0 and has a 15 s safety valve. apply-now sets quitConfirmed, then awaits downloader.cancelAll(). window-all-closed awaits downloader.cancelAll(), which is bounded at 5 s and uses taskkill /f /t on Windows.",
      "evidence": "main.js:555-569, 869-879, 1862-1873, 1953-1961. UI-source/electron/downloader.js:942-962 (taskkill at 952), 972-974, 1004-1015 (QUIT_TIMEOUT_MS 5000)."
    },
    {
      "claim": "The .aio_series.json schema is as the census lists it, with chapters_ignored and final_file_chapters optional.",
      "evidence": "Key tally over D:\\AIO\\manga\\*\\.aio_series.json (132 files):\n- in all 132: url, hid, title, site, format, language, status, authors, cover, genres, chapters_downloaded, total_available_at_download, last_downloaded_at, anilist_id, mal_id, country_of_origin, media_format, anilist_synonyms, anilist_tags, anilist_spoiler_tags;\n- download_volumes in 91, chapters_skipped_fragments in 61, chapters_ignored in 11, final_file_chapters in 0.\nReaders and writers: library.js:714-720; main.js:1713-1752, 1781-1808; series-merge.js:284-341."
    },
    {
      "claim": "settings.json writes use tmp + rename, with a copy fallback on EBUSY/EACCES/EPERM. SETTINGS_SCHEMA_VERSION=1 drives migrations. The stale key updateChecksUseSeededRating persists even though nothing references it.",
      "evidence": "history.js:23, 54-71, 102-137. settings.json:63 ('updateChecksUseSeededRating': true) and :75 (settingsSchemaVersion 1). A repo-wide grep (node_modules excluded) finds no file referencing updateChecksUseSeededRating."
    },
    {
      "claim": "House rules for destructive UI: two-click confirms that auto-cancel after 4 s (delete series, reinstall Python), and no window.confirm.",
      "evidence": "LibraryTab.jsx:1224-1227, 1253-1274, 1385-1400. SettingsTab.jsx:952-962. ResumeBar.jsx:43. There is no window.confirm call anywhere in UI-source/src."
    },
    {
      "claim": "lucide-react 0.263.1 is installed. Funnel does not exist. Every device/sync icon the census lists is exported.",
      "evidence": "UI-source/node_modules/lucide-react/package.json reports 0.263.1. Checked against the dist/esm/lucide-react.mjs exports: Tablet, Tablets, Smartphone, Usb, Cable, Plug, FolderSync, FolderTree, HardDrive, HardDriveUpload, HardDriveDownload, GitCompare, FileDiff, ArrowLeftRight, ArrowRightLeft, RefreshCw, RefreshCcw, ListChecks, CheckCheck, Link2, Link2Off, Send, Upload, Scan and Radar are all present, as are MonitorSmartphone, FolderInput, FolderOutput, Merge and Filter. Funnel and TabletSmartphone are absent. See also LibraryTab.jsx:40-43."
    },
    {
      "claim": "In-flight work:\n- branch fix/mangafire-cloudflare-challenge at d1ae7d6, ahead 1 of its fork tracking branch;\n- UI-source diff of 10 files, +1787/-544;\n- untracked: series-merge.js, update-check-record.js, ChapterChips.jsx, useUpdateCheck.js;\n- the four .claude/worktrees agent worktrees have no UI-source changes;\n- git warns LF->CRLF on the modified UI files.",
      "evidence": "git status -sb (…fork/fix/mangafire-cloudflare-challenge [ahead 1]); git diff --stat -- UI-source; the '??' entries in git status --short; git -C <each worktree> status --short | grep UI-source returns nothing."
    },
    {
      "claim": "Design tokens and primitives are as described:\n- HSL variables for light and dark, radius 0.5rem, darkMode 'class', DM Sans and JetBrains Mono, three animations;\n- no Dialog, Tooltip or Tabs primitive;\n- Badge does not spread props.",
      "evidence": "UI-source/src/styles/globals.css:17-47, 50-76, 86, 154-158. UI-source/tailwind.config.js:5, 15-56, 59-83. UI-source/src/components/ui/primitives.jsx:14-281 (Badge at 223-243 destructures only className, variant and children)."
    }
  ],
  "refuted": [
    {
      "claim": "SettingsTab's DEFAULT_SETTINGS is the single owner of defaults, and main.js and useDownloader carry none (useDownloader.js:196-202 being the only exception).",
      "correction": "CLAUDE.md:124's 'triad' rule covers the download-defaults dict only. main.js get-settings itself resolves several defaults:\n- appAutoUpdate (!== false; documented as main-owned because the updater arms before the renderer exists);\n- verboseAlways (!== false);\n- logUpdateInterval (|| 100);\n- defaults (|| {});\nand it injects isPackaged. useDownloader's pre-load placeholder carries pythonCmd, verboseAlways, collapseSplits, prefetchImageWorkers and disabledSites, not just disabledSites. An opt-in boolean (absent means off) needs no main-side default. Any tablet setting that main must read before the renderer mounts would need main-side resolution, as appAutoUpdate has.",
      "evidence": "main.js:657-667; SettingsTab.jsx:179-185; useDownloader.js:166-203; CLAUDE.md:124."
    },
    {
      "claim": "_normalizeChapterToken is exported at library.js:1118, so extractChaptersFromFiles/_normalizeChapterToken can be reused as-is.",
      "correction": "Neither _normalizeChapterToken nor KOMIKKU_CH_RE is exported. module.exports lists scanLibrary, saveThumbnail, generateMissingThumbnails, downloadMissingCovers, cleanupOrphanCovers, extractChaptersFromFiles, getChaptersOnDevice, getImageChaptersOnDevice, imageChapterToken, seriesIdentityKey, groupEntriesBySeries, findDuplicateSeries and normalizeSeriesUrl. Reuse has to go through extractChaptersFromFiles, which calls the normalizer internally, or add a new export.",
      "evidence": "UI-source/electron/library.js:148, 231, 1118."
    },
    {
      "claim": "Applying an app update and window-all-closed both await downloader.cancelAll(), so no child process outlives Electron.",
      "correction": "Only Downloader children are cancelled. In-flight Check All --list-chapters Python processes (tracked only through _checkAllAbortCtrl) and a running search are aborted by neither window-all-closed nor app-update:apply-now, and the close prompt ignores them. Those spawns are also killed with a plain proc.kill() / SIGTERM, not a tree kill. The guarantee is scoped to downloads.",
      "evidence": "main.js:556, 1862-1873, 1953-1961 (only downloader.cancelAll()), 1174-1179, 1189-1191, 1200-1204 (check-all spawn and proc.kill()), 1691-1696 (abort only via IPC). UI-source/electron/searcher.js:251-258."
    },
    {
      "claim": "useUpdateCheck re-adopts the snapshot on remount, so the renderer re-adopts state after a tab remount.",
      "correction": "The hook is mounted once inside useDownloader for the renderer's lifetime, so a tab switch never remounts it. The snapshot is adopted once per renderer load (window load or reload), and again when main refuses a start with already-running. A tab only needs to read the hook's live state; it does not re-fetch on each mount.",
      "evidence": "useUpdateCheck.js:1-14, 190-233 (effect deps [applyEvent, adoptSnapshot] are stable callbacks), 257-259; useDownloader.js:258."
    },
    {
      "claim": "D:\\AIO\\manga holds 134 series folders.",
      "correction": "134 directories exist, but two of them contain only .series_hid, cover.jpg and details.json, with no chapters and no .aio_series.json: 'One Piece (hid=one-piece.49)' (a separate real 'One Piece' folder also exists) and 'The Café Terrace and Its Goddesses'. scanLibrary drops folders with no payload, so the Library, and any compare built on dl.libraryEntries, sees 132.",
      "evidence": "library.js:683-694 (image-only branch; chapterCount 0 leads to continue). `ls -A` of each of those two folders shows 3 entries. .aio_series.json is present in 132 of the 134 folders."
    },
    {
      "claim": "Alias tables, device profiles or exception lists placed in the Settings draft would be wiped by Reset + Save.",
      "correction": "That holds only for keys declared in DEFAULT_SETTINGS. A saved key missing from DEFAULT_SETTINGS (libraryOpts is the live example) survives Reset + Save, because handleReset clones DEFAULT_SETTINGS and history.saveSettings is a shallow merge that keeps keys the payload omits. Such a key is still re-sent verbatim on every normal Save, because the first hydration spreads every saved key into the draft.",
      "evidence": "SettingsTab.jsx:796-802 (first hydration spreads ...migrated), 913-916, 932-935; history.js:230; settings.json:55 holds libraryOpts, which DEFAULT_SETTINGS (166-408) does not declare."
    },
    {
      "claim": "open-folder reveals a path.",
      "correction": "open-folder calls shell.openPath, which opens the folder itself rather than selecting an item in its parent. showItemInFolder is not used anywhere, and there is no 'reveal file' IPC.",
      "evidence": "main.js:882-885; preload.js:46."
    }
  ],
  "missed": [
    {
      "item": "scanLibrary's chapterCount for archive series is the number of images/Chapter_* folders, not the number of chapter files. It is therefore 0 for every Komikku CBZ-only series, and D:\\AIO\\manga has no images/ folders at all. The grid shows 'N files' instead, and the merge dialog and peerOf fall back to this 0.",
      "category": "failure_mode",
      "evidence": "library.js:699-702 (else-branch calls countImageChapterDirs), 297-311, 582. LibraryTab.jsx:452-462, 497-498. `find D:/AIO/manga -mindepth 2 -maxdepth 2 -type d` returns nothing."
    },
    {
      "item": "extractChaptersFromFiles silently returns nothing for names that match neither format. It also leaves legacy tokens unnormalized: 'X Ch 05.pdf' gives '05', and 'X Ch 5 - Extra.pdf' gives '5 - Extra'. Tablet files named by another tool would read as missing or mismatched.",
      "category": "failure_mode",
      "evidence": "library.js:175-182 (only the Komikku branch normalizes), 187-188 (continue), 207-212 (raw chPart is added)."
    },
    {
      "item": "PC folder names differ from series titles in two ways: a ' (hid=<hid>)' collision suffix, and sanitizing (\\ / * ? : \" < > | removed, trailing ' .' stripped). As a result the folder name differs from the .aio_series.json title for 25 of the 132 series here, 7 of them with a hid suffix. Examples: 'Bungo Stray Dogs (hid=PW1SJ)'; 'Fatestrange Fake (hid=…)' from 'Fate/strange Fake'; 'Code Breaker' from 'Code: Breaker'. entry.title is the raw folder name, so name-level alias matching must strip and normalize these.",
      "category": "hardcode",
      "evidence": "aio-dl.py:496-503 (_sanitize_folder_component), 936 (the root/<title> (hid=<hid>) rule), 949 (the regex that strips the suffix). library.js:767. Read-only comparison of D:\\AIO\\manga folder names against .aio_series.json titles."
    },
    {
      "item": "AIO writes non-chapter files into the library that a sync skip list must know about:\n- '.aio_folder_alloc.lock' at the root;\n- '<base> (missed chapters).json' per series;\n- '.cover.<ext>' caches.\nSINGLETON_FILES knows only '.cover.jpg'. All three appear on this machine: D:\\AIO\\manga\\.aio_folder_alloc.lock, two '(missed chapters).json' files, one '.cover.webp'.",
      "category": "hardcode",
      "evidence": "aio-dl.py:952, 13992; library_state.py:197-206; series-merge.js:59-62; `find D:/AIO/manga -maxdepth 2 -type f` for non-chapter files."
    },
    {
      "item": "The de-facto ignore rule: scanLibrary skips every folder and file whose name starts with '.', and the file-based update check skips dot-files too. This matters for Android files such as .nomedia.",
      "category": "hardcode",
      "evidence": "library.js:629-630, 646; main.js:1271."
    },
    {
      "item": "A fourth copy of the payload-extension set lives inside _checkSeriesUpdates (OUTPUT_EXTS = pdf, epub, cbz). The census lists only three twins.",
      "category": "hardcode",
      "evidence": "main.js:1261."
    },
    {
      "item": "parse_chapter_number maps 'oneshot' and 'one-shot' to chapter 1. It is the only chapter-label exception table in the assigned files. The Python range expansion is capped at 1000 chapters, while the JS merge caps at 5000.",
      "category": "hardcode",
      "evidence": "library_state.py:28-29, 62-69; series-merge.js:117, 148."
    },
    {
      "item": "The HID marker filenames (.series_hid, .mangafire_hid) are hard-coded in main.js readHidMarker and in series-merge METADATA_FILES, while aio_config.json supports a user 'supported_hid_markers' list.",
      "category": "hardcode",
      "evidence": "main.js:235-245; series-merge.js:66-68; aio_config.py:55-64."
    },
    {
      "item": "Three sidecar and cover definitions have drifted apart:\n- library.js probes cover.jpg, .png, .webp and .jpeg;\n- series-merge SINGLETON_FILES differs;\n- library_state SUPPORTED_COVER_EXTS adds .gif and accepts any '.cover*' / 'cover*' prefix.",
      "category": "hardcode",
      "evidence": "library.js:735-741; series-merge.js:59-62; library_state.py:14, 161-194."
    },
    {
      "item": "metadata:update rewrites ComicInfo inside CBZ/EPUB/PDF archives in place. 'Apply to all' loops over every file, with no confirm. This changes the chapter files' bytes and mtime, so any size/mtime/hash compare would see them as changed.",
      "category": "destructive_op",
      "evidence": "metadata_cli.py:33-35, 42-44; main.js:910-915; LibraryTab.jsx:1144-1166, 1200-1203."
    },
    {
      "item": "cleanupOrphanCovers deletes unreferenced cover_*.jpg files from userData/thumb-cache automatically on every scan-library.",
      "category": "destructive_op",
      "evidence": "library.js:1093-1116; main.js:986-993."
    },
    {
      "item": "delete-series and delete-temp run rm -rf on whatever path the renderer sends. Unlike merge's dirname===root guard, main does no library-root containment check. Every Electron-side .aio_series.json write (set-chapters-ignored, save-series-meta, merge) is a plain non-atomic writeFile; only history._saveJson is atomic.",
      "category": "destructive_op",
      "evidence": "main.js:817-826, 1059-1068, 1747, 1803; series-merge.js:389-392, 475-479; history.js:102-137."
    },
    {
      "item": "Settings write failures are silent:\n- _saveJson catches every error;\n- saveSettings mutates in-memory state before writing;\n- save-settings always returns {ok:true}.\nSo SettingsTab's 'Save failed' branch cannot fire on disk errors, even though its comment says it does.",
      "category": "failure_mode",
      "evidence": "history.js:102-137, 230-231; main.js:694-710; SettingsTab.jsx:555-565, 907-916."
    },
    {
      "item": "Adding any key to DEFAULT_SETTINGS shows a one-time phantom 'Save Settings · 1 changed' for every existing user until they press Save, because the draft holds the default while disk holds undefined.",
      "category": "integration_point",
      "evidence": "SettingsTab.jsx:460-465, 480-483, 796-802."
    },
    {
      "item": "High-frequency scan or sync state must not go through settings. useDownloader keeps searchSiteHealth in memory for exactly this reason: writing it to settings re-fires SettingsTab hydration mid-edit and re-renders App.",
      "category": "integration_point",
      "evidence": "useDownloader.js:223-237; SettingsTab.jsx:737-828."
    },
    {
      "item": "No IPC exposes the resolved PC library root. get-resolved-paths returns only pythonCmd, scriptPath and workingDir. The packaged-mode Settings hint ('The \"manga\" folder will be created inside this directory') is wrong when aio_config.json overrides output_dir.",
      "category": "integration_point",
      "evidence": "main.js:682-688, 220-233; SettingsTab.jsx:995-1011."
    },
    {
      "item": "pick-file defaults to a 'Python Scripts' (*.py) filter, so a Browse button for adb.exe must pass explicit filters. Existing callers already pass their own.",
      "category": "integration_point",
      "evidence": "main.js:897-904; SettingsTab.jsx:940-942; LibraryTab.jsx:1138-1140."
    },
    {
      "item": "The quit-dialog payload is download-shaped: {running:[{downloadId, title, url, startedAt}]} from downloader.getRunning(). Registering adb transfers means extending that payload and ConfirmQuitDialog. The 15 s safety valve would also force-close the window in the middle of a transfer.",
      "category": "integration_point",
      "evidence": "preload.js:80-92; main.js:558-568; downloader.js:981-993; App.jsx:282."
    },
    {
      "item": "ResumeBar renders beneath every tab body, so a new tab shares vertical space with it. The App header shows only the tab label; tab toolbars live inside each tab.",
      "category": "integration_point",
      "evidence": "App.jsx:163-169, 263-276."
    },
    {
      "item": "ChapterChips' wording and behaviour are wired to downloads: 'will download', 'this download only', and a cross-out saved to .aio_series.json chapters_ignored for 'every future check'. Reusing it for a sync diff without parameterizing the text and handlers would mix up 'don't download' and 'don't sync'.",
      "category": "integration_point",
      "evidence": "ChapterChips.jsx:7-19, 69-75, 97-101, 133-150; useUpdateCheck.js:321-333; main.js:1713-1752."
    },
    {
      "item": "runMetadataCli, the proposed model for a Python helper, has no timeout and no cancel. It always runs the bundled script folder, ignoring settings.scriptPath, and skips buildPythonEnv.",
      "category": "failure_mode",
      "evidence": "main.js:247-289 (248, 250-252, 259)."
    },
    {
      "item": "scanLibrary is fully synchronous (readdirSync, statSync and existsSync per file) on the Electron main thread, and check-all-updates runs it again. With 22,491 CBZs on this machine, each call blocks all IPC.",
      "category": "failure_mode",
      "evidence": "library.js:616-807; main.js:974, 1464; `find D:/AIO/manga -maxdepth 2 -name '*.cbz' | wc -l` = 22491."
    },
    {
      "item": "Merge edge cases:\n- a non-EXDEV error mid-move aborts with files already moved and no 'moved' list returned (main reports merge_failed);\n- the confirm call re-plans from scratch instead of executing the previewed plan;\n- the dialog closes on a backdrop click even while busy;\n- mergeErrorText has no text for no_target, no_library_root, no_sources, target_is_source or merge_failed.",
      "category": "failure_mode",
      "evidence": "series-merge.js:428-470; main.js:1772-1774; LibraryTab.jsx:547-555, 581-584, 749-764."
    },
    {
      "item": "Lesson from library_state 'MISC-3': concurrent scanners writing .cover.* caches produced torn writes, so scans are read-only by default. Any tablet scan or cache must not write into series folders.",
      "category": "failure_mode",
      "evidence": "library_state.py:226-233, 260-263, 274-279."
    },
    {
      "item": "The job record lives only in session memory. A sync interrupted by quitting leaves no persisted state to resume from or report on.",
      "category": "failure_mode",
      "evidence": "update-check-record.js:83-161; main.js:161."
    },
    {
      "item": "AIO has no content hashing or integrity checks for chapter files. The only createHash in UI-source is an md5 of a path or URL used as a thumbnail cache key. Hash-based comparison would be entirely new code.",
      "category": "other",
      "evidence": "library.js:94-100 (grep for createHash across UI-source finds only library.js:95)."
    },
    {
      "item": "'Device' already means the PC's disk in AIO: getChaptersOnDevice, the 'Check chapters against files on device' setting, and the 'missing from device' / 'on device' text. A tablet feature needs different wording.",
      "category": "other",
      "evidence": "library.js:243-273, 398-425; SettingsTab.jsx:2694-2696; LibraryTab.jsx:980-982, 1047."
    },
    {
      "item": "How the design language is actually used:\n- the theme's success/warning/info tokens appear only in DownloadTab.jsx;\n- Badge's success and warning variants use raw green and yellow;\n- FORMAT_COLORS paints every CBZ badge orange, which clashes with the proposed 'orange = missing on tablet';\n- ChapterChips and the Library Updates button use dark-only orange-200/300 and white/[0.06], so UpdatesCenter is not the only dark-leaning surface.",
      "category": "other",
      "evidence": "A grep for (bg|text|border|ring)-(success|warning|info) finds only DownloadTab.jsx (10 hits). primitives.jsx:223-230. LibraryTab.jsx:53-60, 2141-2142. ChapterChips.jsx:55, 79."
    },
    {
      "item": "CLI flags that use or mutate the library:\n- aio-dl.py --scan-library prints library_state.scan_library as JSON (a Python-side PC inventory);\n- --update-all;\n- --refresh-library-metadata (+ --refresh-rewrite-cbz) rewrites details.json, .aio_series.json, cover.jpg and optionally every CBZ's ComicInfo in place.\nmetadata_cli.py has its own CLI: 'read <path>' and 'update <path> [--cover-path]' with JSON on stdin.",
      "category": "flag",
      "evidence": "aio-dl.py:8853-8863, 9372-9376, 9378-9384, 8040-8067; metadata_cli.py:29-44."
    },
    {
      "item": "Two per-series state files are missing from the census: download_params.json, which the Python scanner merges under .aio_series.json, and '.cover.<ext>', written only when write_cache=True.",
      "category": "state_file",
      "evidence": "library_state.py:11, 137-146, 477-481, 197-206."
    },
    {
      "item": "Tablet-side images cannot be displayed directly. localfile:// serves only local paths (with no containment check), so tablet covers or thumbnails would first have to be pulled into a userData cache, the way thumb-cache works.",
      "category": "integration_point",
      "evidence": "main.js:109-117, 1891-1899; library.js:94-100, 827-866."
    }
  ],
  "notes": "**Method**\n- Read every assigned file in full: App.jsx, SettingsTab.jsx, primitives.jsx, globals.css, tailwind.config.js, main.js, preload.js, library.js, series-merge.js, LibraryTab.jsx, ChapterChips.jsx, useUpdateCheck.js, metadata_cli.py, library_state.py.\n- Spot-checked the non-assigned files the census cites: history.js, useDownloader.js, downloader.js, update-check-record.js, prepare-src.js, aio_config.py, log-filter.js, TESTING.md, CLAUDE.md:124.\n- Everything was read-only: no adb, no scripts, no aio-dl.py. Data checks on D:\\AIO\\manga were only directory listings and read-only JSON key tallies.\n\n**Findings from the data checks**\n- There are 134 folders, but only 132 series are visible to scanLibrary (two are husks with no chapters or metadata).\n- 25 of the 132 folder names differ from their metadata title, 7 of them through a '(hid=...)' suffix. These are the PC-side reasons an alias table is needed.\n- There are 22,491 CBZs, all Komikku-named 'Ch.NNN - Title.cbz', and no images/ folders.\n- Some folder names contain non-ASCII characters ('The Café Terrace…', 'Hell’s Paradise…'), which supports decoding adb output as UTF-8.\n\n**What is absent from the assigned files**\n- No series-name alias, rename, skip or exception tables exist in any assigned file.\n- The only name normalizers are LibraryTab facetKey (trim + lowercase) and, on the Python side, the '(hid=...)' strip plus _sanitize_folder_component.\n\n**Largest corrections for the planner**\n- scanLibrary's chapterCount is not a chapter count.\n- _normalizeChapterToken is private.\n- The quit cleanup covers downloads only.\n- Settings save errors are silent.\n- A new DEFAULT_SETTINGS key causes a one-time phantom dirty count.\n- 'device' already means the PC's disk in existing UI text."
}
```
