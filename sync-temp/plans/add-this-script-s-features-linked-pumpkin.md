# Device Sync — CompareManga's features as a general, UI-configured AIO feature

## Context

`C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga` is a personal script suite that mirrors the AIO
library to one Android tablet over adb:
- `sync_to_tablet.py`: content-hash incremental mirror with a resumable journal.
- `push_all_to_tablet.py`: older wipe-and-repush tool with the alias table.
- `compare_manga.py` + `manga_manager.py`: comparator and Flask dashboard.
- `transfer_runner.py` / `manga_ops.py`: per-chapter push/delete with adb path safety.
- `batch_search.py` + fixups: find sources for tablet-only series.
- `_delta_findings` / `_classify_tablet`: chapter-diff forensics.

Everything user-specific in those scripts is hard-coded: PC root, tablet root, device serial, adb path,
14 aliases, three drifting sidecar lists, the mirrored file set, a 64-row search table and 3 manual
fixups. One script (compare_manga) cannot even parse AIO's current `Ch.NNN - Title.cbz` names.

The goal is to rebuild the durable capabilities inside the Electron app, not transplant the scripts:
- an opt-in **Sync** tab on the left rail, directly above Settings;
- every former flag and exception configurable in the UI;
- the existing design language, applied with the frontend-design principles.

Two reviews shaped this revision, and their corrections are folded in below:
- a census of the scripts (4 readers, 4 adversarial verifiers, 1 synthesis);
- an adversarial review of the first draft. It found four delete-safety holes and showed that name matching cannot rebuild the old aliases.

### Decisions already made (user answers, this session)
| Topic | Decision |
|---|---|
| Targets | **adb devices + plain folders**. MTP is recorded as future work only (the transport interface is the extension point). |
| adb binary | **Detect + manual path only**. Detect from PATH, the SDK locations and ANDROID_HOME, with a manual override. No download, no bundling. |
| Deletes | **Guarded mirror** is the default, with an **Add-only** option in Settings. A **one-time override** in the review works like DownloadTab's per-job block: it is initialized from Settings and never saved back. The user can always pick individual chapters. |
| Settings home | A **new Settings category "Sync"**. It shows only the enable switch until the feature is on; all permanent sync settings live there, not in Library. |
| Automation | **Prompt on device connect only while the app is focused**. If the app is unfocused, prompt when it regains focus, once per connection. |
| Inline edits | The Sync tab can create aliases and exclusions in place; they persist into Settings → Sync. |
| Existing data | **Start fresh**. Nothing is imported, and the first sync of each target runs Verify once. |
| Extras | Find source for device-only series (opens Search prefilled); **batch** find-sources with a review table; **Library device badges**. Wi-Fi adb is out. |
| Engine | **Node in Electron main**, following the `series-merge.js` precedent. Tests are `tools/_test_*.js` (the existing local convention, not shipped). |
| Renamed chapters, identical bytes | **Keep the device name** by default: no transfer, and Komikku keeps its reading progress. A per-target toggle renames instead. |
| Overwriting files the app didn't write (first-Verify foreign files, files changed on the device such as Komikku custom covers) | **Listed unticked in one group** ("Replace N device copies the app didn't write"). |
| Add-only scope | **No deletes, renames or replaces.** Updates of files the app itself wrote still apply. |
| Search cancel | **Fix it in Phase 5.** searcher.js `cancel()` switches to downloader.js's tree kill. |

## Approach in one paragraph

A new main-process package `UI-source/electron/sync/` owns everything device-side:
- adb location and a thin client;
- a transport interface with `AdbTransport` and `FolderTransport`;
- a pure planner and analysis;
- a batched, resumable executor;
- per-target records, a job record and a device monitor.

The renderer mirrors job state through a `useDeviceSync` hook mounted directly in App, so it survives tab switches and a renderer reload re-adopts main's snapshot. `useUpdateCheck` gets the same survival by being composed into `useDownloader` (useDownloader.js:258); mounting the sync hook in App instead keeps the in-flight `useDownloader.js` untouched.

The engine keeps the proven script semantics: content-hash change detection, a per-batch record flush, adb non-ASCII routing, depth-1 files, preserved versus orphaned folders. It fixes what the census and review found:
- a Verify that adopted everything → **provenance** (the app deletes only what it wrote or verified as identical);
- deletes before pushes → pushes first, and **each delete runs only after its replacement has landed**;
- aliases that break on retitles → **sticky folder binding** by series identity;
- no folder adoption → **identity and content fingerprints** (name matching alone cannot rebuild the old aliases);
- device loss → abort instead of 106 instant failures, using the real error text;
- blind label parsing → library.js recognition plus **conservative labels**;
- deletion of non-chapter types → never offered.

## What we keep, fix, drop

| From the scripts | In AIO |
|---|---|
| SHA-256 mirror, journal flushed per batch, resume by re-plan | **Keep.** Per-target record in `userData/sync/`, bound to its device, root and profile |
| `--verify` (device sha256sum rebuilds the journal from whatever it finds) | **Keep, with provenance.** A device file is *adopted* only when its sha equals a current PC file of that series; everything else is *foreign* and stays protected. Coverage is per folder, and a failed hash (rc≠0, device loss, empty while the listing shows files) keeps the old entries. It runs automatically for any unverified managed folder, plus a Verify button |
| `--fast` (size+mtime PC hash cache) | **Keep, and make it the default.** No AIO writer preserves mtime (`os.utime` appears in tests only; `copy2` copies from freshly written cache files; metadata edits write fresh temp files). "Re-hash everything" stays as a setting and per-run override |
| ASCII batches of ≤50 files / ≤12,000 chars; non-ASCII pushed one file at a time to an explicit remote path | **Keep, plus a ≤256 MiB cap per batch** for progress granularity and cheaper retries. This works around adb 36's UTF-8 leaf truncation; the SPY×FAMILY / Hell's Paradise regressions become tests. Deletes are chunked under the same 12,000-char cap |
| Deletes run before pushes | **Fix.** Pushes run first, then a listing, then deletes gated on what actually landed (rule 6) |
| Loop continues after the device drops (106 instant failures) | **Fix.** The real message is `adb.EXE: device 'A06B4A372090333' not found`; the classifier matches it, aborts, and the resume after reconnect is cheap |
| Aliases keyed by PC folder name (break on retitle or merge); stale alias aborts apply | **Fix.** Bound folders are sticky: the record ties each device folder to a series identity. Aliases are keyed by identity, then URL, then folder name, and a dangling alias is a warning, never a blocker |
| sync_to_tablet cannot adopt differently-named device folders, so it duplicates them | **Fix.** Adoption ladder: identity from the device's own `details.json`, then a (name, size) content fingerprint, then names. Measured on the old journal, the fingerprint matches Record of Ragnarok 135/135, CØDEBREAKER 233/233 and SPY_x_FAMILY 153/153 |
| Deletes everything outside `.cbz`+cover+details in managed folders | **Fix.** Only chapter formats and the profile's mirrored sidecars are ever offered, and only files the app wrote are ever pre-selected |
| Prune = `rm -rf` | **Fix.** Delete the app's own files, then `rmdir` only if empty; report leftovers |
| Renamed chapter = delete + full re-push (Nano Machine: 3.28 GB) | **Fix.** A PC file whose bytes already sit in the folder under another name is satisfied by that file: no transfer, and the device keeps its name so Komikku keeps its reading progress. A per-target toggle renames instead (user decision) |
| compare_manga parser blind to Komikku names; volumes counted as chapters | **Fix.** library.js recognition, conservative labels (`5.10` ≠ `5.1`), device conventions, and a unit on every file (chapter / range / volume / whole / unknown) |
| compare_manga `--report-file` / `--json-out` | **Keep as "Export report (JSON)"** from the ledger |
| Flask dashboard, SSE, HTMX, cover proxy, `.tablet_cache.json` TTL | **Drop.** Replaced by the tab, IPC events, library `cover.jpg`, and a listing refreshed on connect, on Refresh and before every apply |
| 64-row search table, 3 fixups, markdown renderers | **Drop the data, keep the capability.** Device-only list + derived queries + a review table with candidate pick and URL pin |

## Architecture

### Main process: `UI-source/electron/sync/`
Every module gets the standard file header: what it owns, who reads it, and cross-file grep anchors.

| Module | Contract |
|---|---|
| `adb.js` | **Locating adb.** `locateAdb(cfg)` returns candidates `[{path, version, source}]` from the configured path, PATH, ANDROID_HOME/ANDROID_SDK_ROOT and `%LOCALAPPDATA%\Android\Sdk`.<br>**Server safety.** `serverStatus()` asks a running server for its version over TCP `127.0.0.1:5037` (`host:version`) before our client runs, so we never kill a server another tool owns. The service then runs `adb start-server` once, so no client we later cancel owns the server.<br>**Running commands.** `runAdb(bin, argv, {timeout, idleTimeout, signal, cwd})` uses `windowsHide:true`, collects stdout and stderr as Buffers and decodes them once at exit, runs a no-output watchdog alongside the total timeout, and on cancel kills only the client process.<br>**Helpers.** `shq()` quotes like POSIX `shlex.quote`. `classifyAdbError()` returns:<br>• device-lost: `/device '[^']*' not found\|no devices\/emulators found\|device offline\|failed to read copy response\|protocol fault/`;<br>• unauthorized, server-mismatch, timeout, other.<br>`parseTrackFrames()` works on raw Buffers: 4-hex-length frames, space-padded rows, and `transport_id` last, used as the connectionId.<br>**Tests.** The binary is `{cmd, prefixArgs}`, so tests can inject `node fake-adb.js` |
| `transports.js` | **Interface:** `probe()`, `freeSpace()`, `list(folders?)` → `{dirs, files: Map slotKey→{name,size,devMtime}}`, `hashFolders`, `readSmall(paths, maxBytes)`, `mkdirp`, `push(batch)`, `remove(paths)`, `move(a,b)`, `rmdirIfEmpty`.<br>**Probe.** `probe()` canonicalizes the root with `realpath` (`/sdcard` is a symlink that `find` won't descend). It detects capabilities with explicit, rc-checked probes: `find -printf`, `sha256sum`, `stat -c`, and `stat -f -c '%a %S'` or `df -P -k`. It also detects case sensitivity by writing a probe file and looking it up with flipped case. The results go into the record header.<br>**Command hygiene.** A command whose failure changes the meaning of its output never runs with `2>/dev/null`; the script's `stat` fallback was dead for exactly that reason.<br>**Listing.** Rows print as `%s\|%T@\|%p` and are parsed with `indexOf`, because names may contain `\|`.<br>**Path validation.** `validatePath(root, p)` ports `_validate_tablet_path`: strictly under the root, not the root itself, no `..`, no CR/LF/NUL, ≤4096 chars, no `DocumentsX` prefix trick. It adds a limit of ≤255 UTF-8 bytes per segment.<br>**FolderTransport:**<br>• writes through fs by copying to a dot-temp name and renaming, and sweeps its own leftovers;<br>• measures free space with `fs.statfs`;<br>• checks presence with an async stat and a 3 s timeout, never `existsSync`, because an offline network share would block the main thread.<br>**MTP** is documented in the header as a future WPD-backed implementation |
| `naming.js` | `sanitizeSegment` (NFKC, strip `/\:*?"<>\|` and control chars, trim trailing ` .`, reject ''/'.'/'..'). `stripHidSuffix` (compare_manga's `^(.+?)\s*\(hid=(.*?)\)\s*$`). `slotKey(name, caseInsensitive)` (NFC, plus casefold on case-insensitive targets). `compactKey` (NFKC, casefold, `×`→x, `Ø/ø/ō`→o, drop spaces and punctuation). `deriveSearchQuery` (batch_search rules). `resolveTargetName` |
| `chapter-labels.js` | **Output.** `labelFile(name, folderName, customPatterns)` returns `{unit, label, start?, end?, sortValue}`. `unit` is one of chapter / range / volume / whole / unknown.<br>**Recognition parity with library.js.** It uses library.js's `KOMIKKU_CH_RE` (one new export line) and the same last-` Ch ` split, and a tools test asserts that both recognize the same files.<br>**Conservative label, used for delete coverage.**<br>• strip leading zeros from the integer part;<br>• `~` becomes `.`;<br>• an all-zero decimal is dropped (`5.0` becomes `5`);<br>• other decimals are kept verbatim;<br>• a letter suffix is lowercased.<br>This matters because library.js's `parseFloat` normalization merges `005.10` and `005.1` (library.js:231-241), and that collision would pre-select the delete of a real chapter.<br>**Other formats.** Device conventions come next: `_<site>_Ch_N`, `Chap/Chapter N`, `#N -`, `Vol N` (volume) and `<folder>.<ext>` (whole). Then the user's regexes (a named group `ch`).<br>**Sort only.** Sorting uses series-merge.js `compareChapterLabels`, tie-broken by a local `Intl.Collator(undefined,{numeric:true})`, because main cannot import the renderer's `naturalCompare` |
| `pc-inventory.js` | **Walk.** An async walk of the library root (`getConfiguredOutputRoot`) with `fs.promises`, yielding between series; never the synchronous `scanLibrary`.<br>**Failing hard.** A missing or unreadable root throws, and planning refuses to run when the walk finds no series while a record has managed folders. D: is removable, and an empty result would otherwise orphan every folder.<br>**Output per series:** its mirrorable depth-1 files per profile, plus identity (`seriesIdentityKey`), url, title, `anilist_synonyms` and `anilist_id` from `.aio_series.json`. Image-only and empty folders are flagged |
| `hash-pool.js` | **Hashing.** SHA-256 on `worker_threads` via an **inline eval'd worker** (no worker script loaded from app.asar), falling back to main-thread streaming. Pool size follows the Resource Limits CPU preset (`cpuPercentForLevel`), capped at 4.<br>**Cache.** `userData/sync/pc-hash-cache.json`, keyed by absolute path → `{size, mtimeNs, sha256}`, written atomically every 500 files and at the end.<br>**Per-file errors** (a vanished or locked file) skip that file for this plan with a warning and never abort the walk. A failed walk never prunes the cache.<br>**Pre-warm.** It pre-warms in the background when the feature is enabled, so the first connect prompt is not waiting on a cold hash of the whole library |
| `analysis.js` | Pure, per series:<br>• label sets and delta-cause tags: sub-chapter splits, Ch 0 asymmetry, PC ahead, **device ahead = content-loss risk**, mixed, different start, numbering-mismatch heuristic, volumes not comparable.<br>• anomalies: fork collision, format mismatch, direction-aware size mismatch, single bundled file, loose root files, empty PC folder, malformed JSON, image-only, reader-compat (Komikku: no `cover.jpg`, PDF unreadable, `~` legacy names break ChapterRecognition), unparsed files, name over 255 bytes.<br>• anomalies can be acknowledged per target |
| `planner.js` | Pure: `buildPlan({pc, device, record, selection, cfg, opts})` returns:<br>• per-series ops with **stable ids** (`push:`, `update:`, `replace:`, `rename:` or `delete:` plus folder/name), each carrying `preselected`, `reason` and `lossLabels`;<br>• chapter-strip segments, device-only folders (preserved / orphaned), suggestions, warnings and totals.<br>The per-slot model is in rules 3-5. No I/O: after an inline edit, main re-plans from its cached listing and inventory |
| `executor.js` | **Per series:**<br>1. mkdir -p (only when there is something to push), then cleanup names;<br>2. renames (case-only renames go through a temp name);<br>3. pushes, updates and replaces in capped batches, with a re-stat guard (size and mtime unchanged, mtime >30 s old, not in a running download) and ASCII/non-ASCII routing;<br>4. **listing** and recording of what landed;<br>5. deletes, each passing the delete gate and slot guard (rule 6), in chunked commands;<br>6. quick verify: every pushed file is present with its exact name and size. Truncation artifacts from this run (new names that are a byte-prefix of a pushed name) are removed.<br>**After a failed or killed batch:** list the folder.<br>• A file that now has the exact PC size, and was absent or a different size before, is recorded `pushed`.<br>• A slot we wrote that ends at any other size is recorded `partial` (ours; repaired by the next plan).<br>• adb's "N files pushed" summary is never trusted; it prints next to EOF failures with rc=1.<br>**Progress:**<br>• counted in bytes;<br>• the UI names the current batch, not the current file, because piped adb prints no per-file `[ NN%]` lines (0 across four CompareManga logs);<br>• interpolates inside a batch and snaps at the batch end.<br>**Run log:** planned totals, final status (completed / cancelled / failed / disconnected) and every destructive action, including prune |
| `store.js` | **Writes.** Atomic JSON with a real bounded retry on rename (EBUSY/EPERM/EACCES, 5 tries with backoff), then a loud failure. `history.js:_saveJson` is **not** a model: it falls back to a non-atomic copy and swallows errors (history.js:102-137). Stale `.tmp` files are swept at startup.<br>**Files:**<br>• `sync-targets.json` (config, including the adb path);<br>• `sync/state-<id>.json` (record);<br>• `sync/selection-<id>.json`;<br>• `sync/find-sources-<id>.json`;<br>• `sync/logs/<id>/<ts>.json` (keep 30);<br>• `sync/covers/<id>/`.<br>**Config ops** (`add-alias`, `add-exclude`, …) are validated, versioned and broadcast. A failed write returns `{ok:false,error}`, and the UI reverts the inline edit.<br>**While a target's job runs:**<br>• ops that change the target's identity are refused: forget record, remove, root/device/profile edits;<br>• alias, exclude and acknowledge edits are accepted and take effect at the next plan |
| `job-record.js` | Shaped like `update-check-record.js`: one live job lane (plan / verify / apply / prune), runId-stamped emits that drop stale runs, coalesced progress events (latest wins, ≤10/s), and a snapshot the renderer re-adopts |
| `monitor.js` | **Watching devices.** `track-devices -l` with backoff (2→60 s), falling back to `devices -l` polling at 5 s. Folder targets use async stat. It runs only while the feature is on **and** a target of that kind exists.<br>**Server safety.** It runs the port-5037 version check before the first command.<br>**Connect events.**<br>• A device already attached at app start counts as a connect.<br>• "Prompted" is persisted per (serial, transport_id), so an app restart doesn't re-prompt the same connection.<br>**Prompt state machine** (focus-aware): connect → quick plan → prompt now if focused, else on the next `focus` event if still connected. A disconnect withdraws a pending prompt |
| `find-sources.js` | **Searcher.** `new Searcher({extraEnv, onLog})` gets main's `extraEnv`, without which Playwright handlers drop out of packaged builds (main.js:618-623).<br>**Search options** are rebuilt from settings the way the renderer does for Search: `searchOpts`, plus `collapseSplits === true` and `disabledSites` (useDownloader.js:1055-1068), plus the Resource Limits network cap.<br>**Runs** sequentially, keeps the top 5 candidates, and is resumable. Rows with errors or 0 candidates can be retried with an edited query.<br>**Lifecycle.** It is cancelled on quit. A pinned URL queues a normal download (URL seed mode only knows mangafire/comix). A batch started during a library update check waits on the shared mangafire/comix browser profile |
| `service.js` | **Init.** `initDeviceSync({ipcMain, sendToUI, history, getLibraryRoot, resolveSpawnPaths, extraEnv, getRunningDownloads, getWindow})` registers every `sync:*` handler.<br>**Settings hooks.**<br>• `resolveSettings(saved)` is spread into `get-settings`, like `appAutoUpdate` (main.js:659-665), so new keys never show as unsaved changes.<br>• `applySettings(merged)` is called from `save-settings`, like `appUpdater.applySettings` (main.js:702-708), and starts or stops the monitor immediately.<br>**main.js changes:** the init call, those two hooks, the quit hooks, and the `reinstall-python` refusal |

### IPC (colon namespace, like `search:` / `app-update:`)
- Invoke: `sync:get-state`, `sync:config-op`, `sync:locate-adb`, `sync:list-devices`, `sync:browse-remote`, `sync:plan`, `sync:series-detail`, `sync:set-selection`, `sync:verify`, `sync:apply`, `sync:prune`, `sync:rename-device-folder`, `sync:cancel`, `sync:prompt-response`, `sync:library-status`, `sync:label-preview`, `sync:export-report`, `sync:device-cover`, `sync:find-sources:{start,cancel,get,update-row}`.
- One push channel `sync-event`, with kinds: device, job, config, prompt, find.
- `preload.js` gains a `sync*` block plus `onSyncEvent(cb)`, which returns an unsubscribe function.
- The full plan and the selection stay in main. The renderer gets summary rows and strips, and fetches per-file detail per series, so multi-MB payloads never cross IPC on every change.

### Renderer
- `src/hooks/useDeviceSync.js` is mounted in **App.jsx**. It buffers events until the snapshot arrives, re-adopts the snapshot after a renderer reload, and exposes actions.
- `src/components/sync/` holds:
  - `SyncTab.jsx`, `ChapterStrip.jsx`, `SeriesSheet.jsx`, `SyncReviewDialog.jsx`;
  - `DeviceOnlyPanel.jsx`, `FindSourcesDialog.jsx`;
  - `SyncConnectPrompt.jsx`, rendered by App like `ConfirmQuitDialog`;
  - `SyncSettings.jsx`, which exports the Settings sections: TargetEditor, AliasTable, RemoteFolderBrowser, AdbPicker.
- `ui/primitives.jsx`: `Checkbox` accepts `checked="mixed"` (renders a dash, `aria-checked="mixed"`) for group rows. It is boolean-only today (:177), and the change is backward compatible.
- `src/lib/utils.js` gains `formatBytes`. LibraryTab's local `formatSize` formats differently (GB to 2 decimals), so LibraryTab is left alone.

## Behavior rules that must hold

1. **Names and binding.**
   - **A bound device folder keeps its name.** The record binds each managed device folder to a PC identity (`folders[F] = {identityKey, pcFolder}`).
     - Retitles, hid changes, merges, alias edits, naming-policy switches and collision re-ranks never rename or re-create it.
     - When the derived name differs, the sheet offers **Rename on device**. It is explicit and warns that Komikku treats a renamed folder as a new series and loses its reading progress.
     - This generalizes `KEEP_TABLET_NAME_FOR_ALIASES` (the user's 2026-05-24 decision).
   - **Unbound series** resolve through the alias (identity, then normalized URL, then folder name), else the naming policy:
     - PC folder name without `(hid=…)` (default; sync_to_tablet's rule);
     - PC folder name as-is;
     - series title.
   - **Collisions:**
     - same identity → a fork: the richer folder wins, the choice is sticky, and the other gets a "merge in Library" anomaly;
     - different identities → each keeps its PC folder name verbatim (AIO added the hid because the titles collide).
   - Every segment passes `sanitizeSegment` and the 255-byte check, and is matched by slot key (rule 11).
   - No device folder is created for a series with zero mirrorable files.
   - Excluded series are **held**: never pushed to, deleted from, or offered for prune.
2. **Adoption never applies silently, but strong matches take one click.** For an unmatched device folder D and a PC series P, strongest first:
   - **identity**: D's `details.json` (or a leftover `.aio_series.json`) carries P's normalized source URL or AniList id. These files are read in one batched shell call, ≤256 KB each. PC `details.json` carries `source_url` and `anilist_id` today, so every folder the old scripts synced has them wherever the pushed copy postdates that change;
   - **content**: ≥90% of D's chapter files equal P's by exact (name, size);
   - **name**: equal `compactKey` against P's folder name, title or any `anilist_synonyms` entry;
   - **similar** (weak): token-set similarity.

   Identity and content are strong. P's new-folder pushes are then not pre-selected, and a banner offers Link / **Link all N strong matches** / Not the same. On a target's first sync (no record), weak matches block too. Names alone cannot carry the old aliases: `.aio_series.json` stores only `anilist_synonyms` (no English title), and Shuumatsu no Valkyrie has none.
3. **The record and provenance.**
   - Each file entry is `{name, size, sha256, devMtime, origin}`, keyed by slot key. `origin` is:
     - `pushed`: the app wrote it and it landed;
     - `adopted`: Verify's sha equals a current PC file of that series;
     - `partial`: the app wrote to it and the write didn't finish;
     - `foreign`: Verify saw it and it matches nothing on the PC.
   - **Ours** = pushed, adopted or partial, and the listing's size and devMtime still equal the entry. Otherwise the file has **changed on the device**, for example a Komikku custom cover, which Komikku writes as `cover.jpg`.
   - Header: `{deviceSerial | folderRoot, canonicalRoot, profile, caseInsensitive}`. On a mismatch the record is ignored for deletes and orphans until re-verified.
   - Coverage: `folders[F].verifiedAt`. Any managed folder without it is verified before its ops are planned: a first sync, an interrupted Verify, a newly linked folder. A folder the app creates is verified at creation.
4. **Per-slot planning.** A slot is a file name within a bound folder, compared by slot key. For each PC file p:
   - the slot holds ours with p's sha and size → in sync;
   - the slot holds ours with another sha → **update** (pre-selected);
   - the slot holds foreign, unverified or changed-on-device content → **replace**: not pre-selected, grouped as "Replace N device copies the app didn't write" with one checkbox (user decision);
   - the slot is empty, and an unclaimed file of ours in the folder has p's sha and size → satisfied under its **kept name** (no op); with the target's "rename device files to match" on → **rename**;
   - otherwise → **push** (pre-selected unless rule 2 blocks the new folder).

   Unclaimed device files:
   - chapter formats (pdf, cbz, zip, cbr, rar, epub) and the profile's mirrored sidecars → delete candidates (rule 5);
   - any other type → unmanaged, never offered;
   - dot-files and nested files → invisible.
5. **Guarded delete preselection.**
   - A delete is pre-selected only when **all** of these hold:
     - the file is **ours**;
     - it is either a mirrored sidecar, or unit = chapter whose exact label is covered by a PC file whose op is selected or already in sync;
     - the series is not tagged numbering-mismatch, different-start or device-ahead.
   - Everything else is listed unticked. Whole, volume, range and unknown units are never pre-selected.
   - **Loss is a property of the selection, not the plan.** A chapter label is lost iff it is on the device now and, after the *selected* ops, no device file carries it and no *selected* push brings it.
     - A red **loss** marker shows on every such file, recomputed on every toggle: deselecting a replacement push turns its pre-selected delete into a loss.
     - `sync:apply` re-checks the rule in main against the submitted selection. A loss the user has not individually ticked blocks Start.
   - **Bulk actions.**
     - "Select covered extras" ticks listed extras of any chapter format (legacy PDFs included) whose label the PC covers.
     - Split parts under the sub-chapter-split tag get their own "select these N parts" action and stay marked as loss.
   - **Add-only** pre-selects no deletes, renames or replaces; updates of the app's own files still apply (user decision).
   - **Mass-delete acknowledgment.** When selected deletes cover ≥50% of a series' device chapter files (with ≥10 files), or ≥200 deletes in total, Start requires a checked "I reviewed N deletions" box.
6. **Apply.**
   - **Re-plan first.** `sync:apply` re-lists and re-plans. It then applies only submitted op ids that still exist with identical parameters; changed or vanished ops are dropped and reported, and a new loss blocks.
   - **Order per series:** mkdir → cleanup names → renames → pushes/updates/replaces → listing → deletes → quick verify.
   - **Delete gate.** A pre-selected replacement delete runs only if the post-push listing shows a file carrying the same label at its exact PC size. Otherwise it is skipped and reported as "kept: replacement didn't land". Deletes the user ticked as accepted losses run as asked.
   - **Slot guard.** Never delete a path whose slot key equals a PC file of the series or a file pushed this run. This covers case-only variants on a case-insensitive target.
   - **Free space.** Pushes must fit in free space minus 1 GiB.
     - If they don't, accepted-loss and orphan deletes may run first.
     - Replacement deletes never run before their push lands.
     - Otherwise the apply refuses and shows the numbers.
   - **Cleanup names** default to `.aio_series.json .mangafire_hid .series_hid .cover.webp`. The editor accepts dot-files only; a mirrored name there would be deleted and re-pushed on every sync.
7. **Failure model.**
   - Device-lost (adb.js regex) aborts with "disconnected — reconnect to resume". Unauthorized is reported separately.
   - Consecutive failures reaching the budget (default 3) abort the run.
   - Cancel stops between batches and kills the adb client. The record is always flushed.
   - Resume = re-plan. The selection persists by (op id, content sha), so a newer PC version is proposed again.
   - **Sanity check:** a managed folder that lists 0 files while its record holds entries blocks apply for that target ("the device listing looks wrong").
8. **Verify.**
   - adb runs `find '<F>' -maxdepth 1 -type f ! -name '.*' -exec sha256sum {} +` per managed folder, rc-checked, with a size-scaled timeout. FolderTransport uses the local hash pool.
   - Results are adopted or foreign (rule 3), and a failure keeps the old entries.
   - It only records managed folders, which keeps preserved folders from turning into orphans.
   - Without `sha256sum`, the user chooses "push all" or an explicit "adopt by size". Weak entries of that kind never pre-select a delete.
9. **One job lane, and every exit knows about it.**
   - Only one plan, verify, apply or prune job runs at a time.
   - **Quit gate:**
     - the close listener (main.js:555-566) gains a sync-busy term;
     - the `confirm-quit` payload becomes `{running, sync:{target, phase, done, total}}`;
     - ConfirmQuitDialog gains sync-only copy (today it keeps only `running`, :44);
     - confirm cancels the job within 5 s and flushes the record.
   - `app-update:apply-now` and `window-all-closed` also cancel it.
   - `reinstall-python` refuses while a job runs, because it calls `app.exit` and skips the gate (main.js:1824-1842).
   - A running find-sources batch is cancelled on quit.
10. **Connect prompt.**
    - Card: target name + "12 series · 1,348 files · 10.3 GB to push · 4 deletions to review". Buttons: **Review**, **Sync now**, **Not now**.
    - **Sync now** appears only when all of these hold:
      - the record is verified;
      - no deletes, replaces or renames are selected;
      - there are no unresolved suggestions and no error-severity anomalies.
    - A first-time target shows "Set up (verifies ~N GB on the device)". "Preparing (hashing library N%)" shows while the pre-warm runs.
    - A device with several targets gets one prompt listing each.
    - Unauthorized devices get a red rail dot plus USB-debugging guidance.
11. **Case and Unicode.**
    - Slot keys are NFC, plus casefold when `probe()` reports case-insensitive: NTFS folders, and typically Android shared storage. It is measured per target, not assumed.
    - A case-only difference is the same slot. Content decides update versus in sync. The name changes only with rename-to-match on, through a temp name.
    - Two PC names with one slot key are a collision (rule 1).
12. **A record describes one place.** Changing a target's device, root or profile clears its record behind a confirm, and the header check catches any other mismatch (rule 3).
13. **The plan and the badges follow the library.**
    - While a target is connected and idle, a finished download, library rescan or series merge triggers a re-plan debounced by 10 s.
    - Library badges are computed in main from the current library against each target's record: by name and size, with sha from the warm cache. They update on library scan, download completion and plan end, so a series that just finished downloading never shows "synced".
    - Only device-side facts carry "as of <time>".

## UI (existing language; frontend-design principles applied inside it)

- **Purpose and tone.** A trustworthy transfer desk: what differs, what will change, and nothing surprising gets deleted.
  - The style is utilitarian precision inside the app's tokens. Text is DM Sans; JetBrains Mono tabular numerals are used for counts, sizes and paths.
  - No new fonts or colors. Status colors come from the tokens `success`, `warning`, `destructive` and `info`, plus the app's orange "new chapters" accent.
  - **Copy never says bare "device".** AIO already uses it for the PC disk ("Check chapters against files on device"), so sync copy names the target, e.g. "On Galaxy Tab".
- **Signature element: the Chapter Strip.**
  - Each ledger row renders the series' whole chapter range as run-length segments, with `flex-grow` proportional to count.
  - Colors:
    - success = on the target (in sync or under a kept name);
    - orange = will push or update;
    - warning = replace candidates and extras;
    - destructive = selected delete or loss;
    - hatched muted = volumes, ranges, whole files, unparsed.
  - Destructive segments are at least 3 px wide (one chapter of One Piece's 1,197 is ~0.2 px). Hovering shows the range.
  - During apply, the active series' orange segments fill to success as batches land. That is the transfer lane.
- **One orchestrated motion.** When a plan lands, rows stagger in (`animate-slide-up` with a small capped delay) and the strips sweep left to right. Everything else stays still, and `prefers-reduced-motion` is honored.
- **Layout.** It must work at the minimum body width: the 800 px window minus the rail and frame, measured in Phase 4. At minimum size the Settings content pane is ~508 px, so the target editor and alias table stack.
  - **Target bar:** target picker, status dot, storage gauge with an "after sync" ghost segment, and Refresh / Verify / gear. The gear deep-links to Settings → Sync via `settingsCategory`.
  - **Summary tiles**, which double as filters: To push · Deletions to review · In sync · Only on <target> · Attention.
  - **Ledger:** search, sort, and an overflow menu with "Export report (JSON)".
  - **Right side sheet** for series detail:
    - the chapter table with run groups (collapsed runs of the same op, expandable);
    - anomalies;
    - inline Link / Exclude / Acknowledge / Find source / Rename on device.

    It reuses UpdatesCenter's structure but takes **token** colors, not its zinc literals.
  - **Sticky selection bar → review dialog.**
    - The header holds the one-time overrides: Deletes Guarded/Add-only, Re-hash PC, Verify device first.
    - Groups with tri-state checkboxes: New · Updates · Replace (unticked) · Renames · Deletes (replacements / losses / extras) · Orphans.
    - The mass-delete acknowledgment sits here.
  - **Progress mode:** throughput, ETA via `formatEta`, the current batch (N files, X MB), Cancel.
- **Rail.** `TABS` becomes derived (useMemo). `{id:"sync", label:"Sync", icon: FolderSync}` sits before Settings only when `settings.syncEnabled`.
  - The badge shows the count of series with pre-selected changes, a pulsing dot while a job runs, or a red dot on a target error or unauthorized device.
  - The view falls back to Settings if the tab is disabled while active.
- **Both themes.** Tokens only, with `dark:` variants for accent text. Do not copy ChapterChips' dark-only `text-orange-200`.
- **Library badges.** A bottom-right chip on MangaCard: a Tablet icon with a count in neutral foreground for pending pushes, a success check when synced, and dim when the series is on no target.
  - Not orange: orange already means "N new" on the same card.
  - The chip aggregates across targets. DetailView gets a "Sync targets" row listing each target, plus "Open in Sync".
  - It is hidden when the feature is off.
- **Find source (single).**
  - App runs `dl.runSearch(derivedQuery, settings.searchOpts)`, switches to Search, and passes a one-shot `prefill`. SearchTab's input keeps `useState("")` (SearchTab.jsx:167), so ordinary returns to Search are unchanged.
  - While the link is pending, SearchTab shows a dismissible banner: "Finding a source for <folder> on <target>".
  - A download started from Search under that banner records the alias. It is keyed by URL and re-keyed to the series identity once the series folder exists.
- **Batch find-sources.**
  - Rows are device-only folders. Each shows its device `cover.jpg`, pulled once into `userData/sync/covers/`, an editable derived query and an include checkbox. A seeded-only toggle sits above them.
  - The run is sequential, with progress, and ends in a review table:
    - best candidate (title, site, composite, chapters, `quality_basis`);
    - a dropdown to pick another candidate or source;
    - a URL pin (for manual cases like SHELTER);
    - Skip.
  - "Queue N downloads" queues each accepted row. Komikku mode follows the target profile and can be toggled. Each queued row adds an alias from the URL to the device folder, so the new series adopts the existing folder.

## Settings → Sync (every former hardcode, and where it lives now)

- **Category.** `{id:"sync", label:"Sync", icon: FolderSync, desc:"Mirror your library to a tablet or a folder."}`.
  - While `syncEnabled` is false, the only section is "Device Sync": the switch plus a two-line explainer.
  - Once it's enabled, the sections are Device Sync (enable, prompt-on-connect), adb, Sync Defaults, Targets and Advanced.
- **Draft keys (Save button), 7 in `DEFAULT_SETTINGS`:** `syncEnabled:false`, `syncPromptOnConnect:true`, `syncDeletePolicy:"guarded"`, `syncHashMode:"cached"`, `syncErrorBudget:3`, `syncSizeWarnPct:30`, `syncChapterPatterns:""`.
  - All are scalars, so `countDirtySettings` needs no change.
  - main resolves each in `get-settings` (absent → default), so none shows as an unsaved change after the update. Without that, the one-time inflation documented at SettingsTab.jsx:460-465 would show "Save Settings · 7 changed".
  - `DEFAULT_SETTINGS` and `service.resolveSettings` hold the same values, and a tools test compares them.
- **Immediate-persist, in `sync-targets.json`: targets and the adb path.**
  - This follows the disabledSites precedent, and a note says so.
  - Inline edits must not wait for, or be wiped by, the Save/Reset draft.
  - The device picker must use the adb just chosen, not the last saved draft.
- The Komikku Output hint that says "copy into `<SAF>/local/` yourself" gains "…or turn on Settings → Sync".
- **Komikku profile.**
  - Target-editor hint: "Komikku reads only the `local` folder inside the folder you gave it. Pick that `local` folder."
  - A `.nomedia` file is written in the root (default on), which keeps covers out of the gallery.
  - `cover.jpg` is required; PDFs and `~` names are flagged.
- **Custom chapter patterns** get a live test field that calls `sync:label-preview`, so it tests the main-side labeler.

| Script hardcode / flag | Now |
|---|---|
| `DEFAULT_PC_ROOT` / `--pc-root` | AIO's own library root (`getConfiguredOutputRoot`); no second setting to drift |
| `DEFAULT_TABLET_ROOT` / `--tablet-root` | Target root. For adb, chosen in a remote folder browser starting at `/storage/emulated/0`, with presets Documents, Download, Komikku `…/local`, AIO for Android library, and custom. Folder targets use a folder picker |
| `DEFAULT_DEVICE_SERIAL` / `--device` | Target's device, picked from connected devices; the model name is shown |
| `KNOWN_ADB_PATH` / `--adb` | adb picker: detected candidates with versions + Browse (explicit `.exe` filter; `pick-file` defaults to `*.py`) + Re-detect |
| `ALIASES_TABLET_TO_PC` (14), the May 9-entry table, `PUSH_MAP` (50), `KEEP_TABLET_NAME_FOR_ALIASES` | Sticky binding + per-target alias table keyed by identity. The adoption ladder re-creates the pairs, and most PUSH_MAP rows are identical or underscore variants that `compactKey` already matches |
| `SIDECARS`, `SIDECARS_ON_TABLET`, `IGNORE_SERIES_FILES` | Per-target cleanup-name list (dot-files only) + sidecar toggles (cover.jpg, details.json) |
| Mirrored set (`is_content_file`), `CHAPTER_EXTS` | Reader profile: Komikku/Mihon, Perfect Viewer/generic, or Custom (extension checkboxes). No default: the target editor asks which reader reads the folder |
| `--only` / `--skip` | Per-target series selection (all-except-excluded, or only-selected) + exclude list, identity-keyed; excluded series are held |
| `--verify`, `--fast`, `--prune`, `--apply`, `--yes`, `--plan` | Verify button + automatic coverage; hash mode setting + override; orphan removal action; review + Start; the tab itself |
| `--workers` | Derived from the Resource Limits CPU preset |
| `--state`, `--pc-cache`, `--log`, `--cache-file`, `--cache-ttl-hours` | App-managed files in `userData/sync/`; the listing refreshes on connect, on Refresh and before apply |
| `--report-file`, `--json-out` | Export report (JSON) |
| `--size-threshold`, `error_budget` | `syncSizeWarnPct`, `syncErrorBudget` |
| Chapter-loss threshold (≥20 fewer), shortfall (−50) | Replaced by exact per-chapter loss detection |
| SHELTER preserve assertion | Automatic: never-verified, never-written folders are preserved by construction |
| batch_search `SERIES`, `PROBE_PHASE_DEADLINE_S=45`, fixups | Device-only list + editable queries; probe deadline gated on measurement (Phase 5); candidate pick / URL pin |
| `CHAPTER_PATTERNS` | Built-ins + Advanced custom patterns (`syncChapterPatterns`) with a live test field |
| `MAX_BATCH_FILES/ARGLEN`, adb timeouts | Constants (plus the 256 MiB cap). They are platform limits, not preferences; each is commented with its reason |
| `--host`, `--port`, `--no-browser`, `-q`, `-v`, `--no-color`, `_watch_progress` flags | Not applicable: no local server or terminal output; progress arrives as live events |

**Target editor fields:** name, kind, device or folder, root, reader profile, file types, sidecars, naming policy, "rename device files to match the PC" (default off), `.nomedia`, cleanup names, series selection, aliases (flagged when dangling), ignored suggestions, acknowledged anomalies.

**Danger actions**, each a two-click confirm: "Forget sync record" (the next sync re-verifies) and "Remove target".

## Phases (stop and report after each)

0. **Groundwork.**
   - Write the phase memory `device-sync-feature.md` + a MEMORY.md pointer that cross-references this plan.
   - Guard the in-flight work: edit in the main working tree on the current branch; never stash, reset or check out; keep a list of in-flight files this feature touches.
   - Preserve the Komikku spec that the reader profile cites: `git show 1f17a20^:komikkuspec.md` → `~/.claude/plans/komikkuspec.md`. It sits outside the repo on purpose, since upstream review removed it. It survives today only as an unreachable object that `git gc` can delete.
1. **Engine core (no UI).**
   - Modules: `adb`, `transports`, `naming`, `chapter-labels`, `pc-inventory`, `hash-pool`, `analysis`, `planner`, `executor`, `store`, `job-record`.
   - `tools/fake-adb.js` emulates:
     - `devices -l` rows and `shell find/sha256sum/mkdir/rm/mv/df/stat`;
     - `push` into a temp dir, including the non-ASCII truncation bug;
     - piped output with no progress lines;
     - `device 'X' not found`;
     - rc=1 with a misleading "N files pushed";
     - a case-insensitive filesystem;
     - a device without `find -printf`.
   - Tests: `tools/_test_device_sync_core.js`, `tools/_test_device_sync_exec.js`.
   - Stop point: tests green.
2. **Main service.**
   - `monitor.js` (port-5037 pre-check, start-server, frame parser, prompt state machine including startup-attached devices and restarts).
   - `find-sources.js` (runner only) and `service.js`.
   - IPC + preload.
   - main.js hooks: init, `get-settings`/`save-settings`, quit gate + dialog payload, apply-now, window-all-closed, the `reinstall-python` refusal.
   - Badge computation.
   - `tools/_test_device_sync_monitor.js`.
   - Stop point: a tools script drives the service end-to-end against FolderTransport and the fake adb.
3. **Settings → Sync.**
   - The category, its sections, the target editor, the remote folder browser, the adb picker, the alias table.
   - Stop point: build + visual check in both themes.
4. **Sync tab, rail, prompt.**
   - Ledger, Chapter Strip, series sheet, review with the one-time overrides, apply progress, device-only panel, connect prompt, rail badge.
   - Packaged check: `npx electron-builder --dir`, then run the unpacked exe against a temp library. This proves the eval'd workers inside asar. Never run the installer: userData is shared, so back up its JSONs first.
   - Stop point: E2E in the dev app with a folder target against a temp library (`AIO_OUTPUT_DIR`), plus visuals in both themes.
5. **Extras.**
   - Single find source (App handoff, SearchTab prefill + banner), batch find-sources dialog, Library badges and the DetailView row.
   - searcher.js `cancel()` switches to downloader.js's `taskkill /t` tree kill (user decision). The Search tab benefits too.
   - Measure the per-query time split. Only if the probe phase dominates, propose the `AIO_SEARCH_PROBE_DEADLINE` env knob; it would touch in-flight `search_orchestrator.py`, so ask first.
6. **Live verification and docs.**
   - Live tablet test **only with your OK**, on a scratch root (`/storage/emulated/0/Download/aio-sync-test/`) with three series including non-ASCII names.
   - Measure on the device:
     - per-file progress under a pipe (expect none);
     - what a killed push leaves behind;
     - the case-insensitivity probe result;
     - relative-name pushes with cwd = series folder. If proven, they would lift the one-file-at-a-time non-ASCII rule and shorten command lines; adopt them only then;
     - that Komikku reads a synced `local/` with `.nomedia`.
   - Docs: a CLAUDE.md pointer row + invariant, `android/PARITY.md` N/A-DESKTOP-ONLY rows (settings + IPC), and final memory updates.
   - A forced re-read of every changed file, then the report. The ship decision follows.

## Critical files

- **New:**
  - `UI-source/electron/sync/*.js` (13 modules), `UI-source/src/hooks/useDeviceSync.js`, `UI-source/src/components/sync/*.jsx`;
  - `tools/fake-adb.js`, `tools/_test_device_sync_*.js`.

  The `electron/**` glob in package.json already packages them.
- **Modified, in-flight files (edits must interleave carefully):**
  - `electron/main.js`: init, settings hooks, quit hooks, reinstall guard;
  - `electron/preload.js`: sync block;
  - `electron/library.js`: one export line, `KOMIKKU_CH_RE`;
  - `src/App.jsx`: rail, route, prompt, find-source handoff;
  - `src/components/LibraryTab.jsx`: chip + detail row;
  - `src/lib/utils.js`: `formatBytes`.
- **Modified, clean files:**
  - `src/components/SettingsTab.jsx`;
  - `src/components/SearchTab.jsx`: prefill + banner;
  - `src/components/ConfirmQuitDialog.jsx`;
  - `src/components/ui/primitives.jsx`: mixed Checkbox;
  - `electron/searcher.js`: tree-kill cancel;
  - `android/PARITY.md`.
- **Reused, not re-implemented:**
  - `library.js`: `extractChaptersFromFiles` (the recognition parity test), `seriesIdentityKey` and `normalizeSeriesUrl` (**in-flight only**).
  - `series-merge.js` (in-flight, untracked; unchanged): `compareChapterLabels` for sorting.
  - `main.js`: `getConfiguredOutputRoot`, `resolveSpawnPaths`, `sendToUI`, `extraEnv` / `buildPythonEnv`, the quit gate.
  - `searcher.js`: `Searcher`.
  - `downloader.js`: its `taskkill /t` tree kill.
  - `resource-limits.js`: `cpuPercentForLevel(level)`, `searchParallelismForLevel(currentValue, level)`.
  - Renderer `utils.js`: `formatEta`, `chaptersToRangeString`, `naturalCompare`, `cn`.
  - UI primitives, `SectionHeader`, the Settings two-pane shell.

## Verification

- **Offline:** `node tools/_test_device_sync_core.js`.
  - Naming: sanitize, hid-strip, `slotKey`, `compactKey`, the 255-byte limit.
  - Labels:
    - conservative canonical form, including `5.10` ≠ `5.1` and `005` = `5`;
    - recognition parity with library.js across Komikku, legacy `~`, ranges, device conventions and volumes.
  - Provenance matrix: pushed / adopted / partial / foreign / changed-on-device.
  - Per-slot planning: update, replace, kept name, rename toggle, push.
  - Guarded / add-only preselection. Every delete-pre-selection case is checked against rule 5.
  - Adoption ladder on sanitized fixtures shaped like the old aliases (identity, content ≥90%, name, weak).
  - Collisions (same vs different identity), sticky binding across a retitle, held exclusions.
  - Refusals: a missing or empty library root; a record header mismatch.
  - The settings-defaults twin check.
- **Offline:** `_test_device_sync_exec.js` against the fake adb and real temp dirs.
  - Routing: non-ASCII routing survives the emulated truncation bug; the 50-file / 12,000-char / 256 MiB caps; chunked deletes.
  - Delete gate: a failed or skipped replacement push keeps its delete from running.
  - Slot guard: a case-only rename on a case-insensitive target never deletes the new file.
  - Failures: the device-lost abort using the real message text; the error budget; a misleading "N files pushed" is ignored.
  - Cancel mid-batch leaves landed files `pushed` and unfinished slots `partial`.
  - Resume: a kill after batch k re-plans to exactly the rest.
  - Guards: re-stat, running-download skip, listing sanity check, missing `-printf`.
  - Verify: managed folders only; failure keeps entries.
  - Prune: `rmdir`-if-empty; this run's truncation artifacts are removed.
- **Offline:** `_test_device_sync_monitor.js`.
  - Frame parser (Buffer chunks, padded rows, transport_id).
  - Prompt state machine: focus, refocus, startup-attached, restart, withdraw on disconnect.
  - Server-version pre-check.
- **Hostile names:** `'`, `$`, backtick, `|`, `DocumentsX`, `..`, newline and names over 255 bytes are all rejected or safely quoted.
- **Build:** `cd UI-source; npm run build` with no errors.
- **Visual:** the dev app in light and dark, covering every state:
  - empty, no targets, disconnected, unauthorized, first-verify, preparing, planning skeleton;
  - ledger, sheet, review with replace and mass-delete, progress, prompt;
  - Settings disabled and enabled, Library chips.

  If a state can't be reached with the live IPC, a dev-only (`import.meta.env.DEV`) fixture API drives it.
- **E2E (folder target):** temp library → plan → apply → modify, rename and delete on the PC → re-plan (kept name) → both policies → Verify → prune → unplug the library root (refusal).
- **Live tablet (with permission):** landed names exact, sizes match the record, and unplugging mid-run (your hands) aborts cleanly and resumes. Plus the Phase 6 measurements.
- **Regression:** the CLAUDE.md verification suite. No Python changes are planned, so items 1-6 and 8 are sanity checks and item 7 (UI build) is the real check.

## Open decisions / risks (my pick → what changes otherwise)

1. **Shipping with in-flight work.**
   - Facts: there is no open PR (#72, this branch, is merged). The tree carries 36 modified and 21 untracked files. The sync imports `seriesIdentityKey` / `normalizeSeriesUrl`, which exist only in the uncommitted library.js.
   - Pick: ship the sync **with or after** that work, deciding the branch and staging with you after Phase 6.
   - Otherwise: duplicate the identity rules into `sync/`, which creates two identity definitions that will drift.
2. **Image-only (`--format none`) series** are not synced in v1; they get an anomaly with an explanation. Supporting them would need depth>1 mirroring and deletes.
3. **Pushing device-only chapters back to the PC** (pull) is not planned. Device-only series route through Find source instead; pulling would put unmanaged files into AIO library folders.
4. **adb server fights.** The port-5037 pre-check means our client never touches a server of another version. The review reports that all three adb binaries here speak protocol 1.0.41, so no fight is expected (not re-measured).
5. **Worker threads in the packaged build** are proven by the Phase 4 `electron-builder --dir` run, with main-thread hashing as the fallback.
6. **JS tests stay local** (`tools/`, gitignored) under your Node choice. Say if you want a shipped JS test directory.
7. **A pre-existing defect outside this feature.**
    - The census reports that `delete-series` runs `rm -rf` without checking that the path is inside the library root (main.js:1059-1068).
    - Pick: a separate fix, not part of this feature.
