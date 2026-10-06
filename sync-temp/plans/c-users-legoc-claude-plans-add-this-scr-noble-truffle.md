# Device Sync — non-UI implementation plan

Parent plan (behavior rules 1-13, the decisions table, the UI design):
`~/.claude/plans/add-this-script-s-features-linked-pumpkin.md`. Rule numbers below refer to it.

## Context

The parent plan rebuilds the CompareManga tablet scripts inside the Electron app: an adb and
plain-folder mirror with provenance, guarded deletes, folder adoption, a connect prompt and batch
find-sources. **This plan is its non-UI half.** It covers what decides *what* happens and what
*makes* it happen: the engine, the adb transport, the main-process service, the IPC contract and
the renderer data mirror. The UI pass then only has to draw.

Two things are deliberately left open for the UI pass (your answer, 2026-09-30):
- how the Sync tab and Settings → Sync look;
- how many knobs they expose.

So every tunable lives in one table of defaults and presets, and the UI can expose any subset.

**The feature stays inert until the UI ships.**
- `syncEnabled` resolves to false.
- While it is off there is no adb server start, no device monitor, no library pre-hash and no
  quit-gate term.
- The IPC handlers are registered but refuse jobs with `disabled`.

Landing this pass alone changes nothing a user can see.

## Decisions this round

| Topic | Decision | What it means here |
|---|---|---|
| Scope | Appearance and the exposed-knob set are not finalized; knobs use presets; the boundary is my call | **In:** `electron/sync/*`, the main.js hooks, the preload bridge, a typed IPC contract, the searcher tree-kill, and `useDeviceSync.js` (written and tested, **not mounted**). **Out:** every `.jsx`, App.jsx, `DEFAULT_SETTINGS`, ConfirmQuitDialog |
| Transport | ADB wire protocol | Node speaks the adb server's socket protocol; adb.exe only runs `version` and `start-server` |
| Landing | Push in place (parent plan) | adbd unlinks an existing file before writing its replacement, so an interrupted update or replace leaves that slot empty until the next sync. The executor logs intent first, so the next plan re-pushes it (the PC still has the file) |
| Tests | `tools/` only (gitignored) | `tools/_test_device_sync_*.js`, `tools/fake-adb-server.js`, plus a live-tablet harness |

### Deviations from the parent plan that are my calls (object at review if any is wrong)

1. **The record and the PC hash cache are a snapshot plus an append-only journal.**
   - The parent plan rewrote the whole JSON per batch.
   - The old record is 3.4 MB for 22,168 files; the old hash cache is 4.5 MB.
   - Per-file pushes (from the transport decision) need per-file intent (`pending` → `pushed`).
   - With a journal, each file costs two small appended lines instead of a multi-MB rewrite.
2. **Hash-while-push.**
   - The bytes streamed to the device are hashed on the fly, so the record's sha is always the sha
     of what was actually sent.
   - A mismatch with the planned sha (a file changed without changing size or mtime) is recorded
     truthfully and reported.
3. **Pre-warm hashing is gated and throttled.**
   - It runs only when sync is enabled **and** at least one target exists.
   - It drops to 1 worker while a download or a Check All sweep runs.
4. **Two extra event kinds, `prewarm` and `library-status`.** They feed "Preparing (hashing N%)"
   (rule 10) and the badge refresh (rule 13), which the parent plan's event list had no channel for.
5. **Automatic connect-plans queue behind the job lane** (FIFO, one per target). A user-started job
   while busy is refused with `busy` plus the snapshot, like the Check All re-entrancy guard.
6. **Device loss is event-driven.** The monitor's track socket reports a removal within about a
   second. The service aborts the in-flight transfer on that event, instead of discovering the loss
   through a failing write.
7. **`sync:browse-remote` returns root presets** (Documents, Download, Komikku `…/local` when found,
   the AIO-for-Android default library, custom) with an `exists` flag. The UI picks which to show.

## Repo state and the in-flight protocol

**State (measured this session).**
- **Branch.** `fix/mangafire-cloudflare-challenge`. Its PR #72 is merged and no PR is open.
- **Upstream.** Upstream `main` is `f8e57c1` on the remote. The local `upstream/main` ref is still
  `fcb1a73`, because nothing has been fetched since #72.
- **Unpushed commit.** The branch carries one commit that is not on `fork`: `d1ae7d6` (android
  port), on top of `fd73729`.
- **Working tree.** 36 modified and 21 untracked files.
- **Files this pass edits** (changed-line counts are the uncommitted in-flight edits already there):
  - in-flight `main.js` (455 changed lines);
  - in-flight `preload.js` (56);
  - in-flight `library.js` (197; this pass adds one export line);
  - clean `searcher.js`.

**Rules for this pass.**
- Never stash, reset, checkout, commit, push, rebase or pull.
- `git fetch upstream` happens only at ship time, where it is safe because it moves remote-tracking
  refs only.
- **Baseline before the first edit to each in-flight file.** Copy the file and its
  `git diff HEAD -- <file>` to `~/.claude/plans/device-sync-baseline/`. At ship time, diffing the
  baseline against the current file yields exactly this feature's hunks, whichever branch
  strategy you pick.
- Edits to in-flight files are small, contiguous blocks, each carrying a grep anchor
  (`deviceSync.`).

**This feature cannot ship ahead of the in-flight work.** `seriesIdentityKey` and
`normalizeSeriesUrl` exist only in the uncommitted `library.js`. `series-merge.js`, which supplies
`compareChapterLabels`, is untracked.

## Architecture — `UI-source/electron/sync/`

Every module gets the standard header: what it owns, who reads it, and cross-file grep anchors.
No module requires `electron`. Collaborators are injected, following the `series-merge.js` and
`update-check-record.js` precedent, so everything runs under plain `node` in `tools/`.

| Module | Owns | Delta vs parent |
|---|---|---|
| `sync-settings.js` | Defaults and preset specs for the global keys; pure `resolveSyncSettings(saved)`; `SYNC_SETTING_SPECS` for the UI | New (knob surface, see below) |
| `profiles.js` | Reader-profile presets; `resolveTargetConfig(target)` fills every per-target field | New; a `null` field means "profile default", so a profile switch propagates |
| `contract.js` | Invoke-channel names, the event channel `sync-event`, event kinds, op kinds, origins, job phases, JSDoc typedefs for every payload | New; preload and the hook duplicate the literals because the sandboxed preload can't `require`; a drift test compares them |
| `naming.js` | As parent: `sanitizeSegment`, `stripHidSuffix`, `slotKey`, `compactKey`, `deriveSearchQuery`, `resolveTargetName`, the 255-byte check | — |
| `chapter-labels.js` | As parent: unit + conservative label, device conventions, custom patterns | Imports `KOMIKKU_CH_RE` (new export at `library.js:1118`) |
| `analysis.js` | As parent: delta-cause tags and anomalies | — |
| `planner.js` | As parent (pure, stable op ids, rules 1-5) | Free space for an in-place update is `max(0, new − old)` because adbd frees the old copy first; `pending` slots resolve to pushed or partial |
| `job-record.js` | As parent: one lane, runId-stamped emits, coalesced progress (≤10/s), snapshot | Adds the FIFO queue for automatic plans |
| `store.js` | `writeJsonAtomic` (tmp + rename, 5 retries with backoff on EBUSY/EPERM/EACCES, then throws); `JournalStore` (snapshot + append log, torn-last-line tolerant replay, compaction at job end or 8 MB); startup sweep of `.tmp` | Deviation 1. `history.js:_saveJson` (102-137) is **not** the model: it falls back to a non-atomic copy and swallows errors |
| `hash-pool.js` | As parent: `worker_threads` via an inline eval'd worker, main-thread fallback, cache keyed by path → `{size, mtimeNs, sha256}` | Cache on `JournalStore`; throttle (deviation 3) |
| `pc-inventory.js` | As parent: async walk of `getConfiguredOutputRoot`, identity / url / title / `anilist_*`, hard failure on a missing or empty root | — |
| `adb/wire.js` | Pure codecs: request framing, OKAY/FAIL, sync packets, shell-v2 packets, `devices -l` rows, track frames split across chunks | New |
| `adb/client.js` | Sockets: host services, transport binding, `shell()`, `SyncSession` (stat, list, push, pull) | New |
| `adb/locate.js` | Candidates from configured path, PATH, ANDROID_HOME/ANDROID_SDK_ROOT, `%LOCALAPPDATA%\Android\Sdk` (with `adb version`); `startServer(bin)` | Replaces the locate half of the parent's `adb.js` |
| `transports.js` | The interface; `AdbTransport` on the client; `FolderTransport` (dot-temp + rename, `fs.statfs`, async presence stat with a 3 s timeout); `validatePath` (port of `manga_ops.py:_validate_tablet_path`, plus a 255-byte per-segment limit, byte-length cap, empty and `.` segment rejection); `shq` | — |
| `executor.js` | As parent: per-series order and the failure model (rules 6-7) | Per-file results and per-chunk progress (see the transport section) |
| `monitor.js` | `host:track-devices-l` on a persistent socket (backoff 2→60 s), folder presence, focus-aware prompt state machine (rule 10) | No CLI child process |
| `find-sources.js` | Runner: sequential searches on its own `Searcher`, top 5 candidates, resumable, retry with an edited query | Unchanged scope |
| `service.js` | `initDeviceSync(deps)`, every `sync:*` handler, settings hooks, quit hooks, library-change notifications, badge computation | — |
| `electron/proc-kill.js` | `killTree(child)`: `taskkill /pid N /t /f` on win32, SIGTERM elsewhere | New shared helper. `downloader.js:952` keeps its inline copy because that file is in-flight |
| `src/hooks/useDeviceSync.js` | Renderer mirror: buffers events until the snapshot lands, adopts the snapshot, applies events by kind, exposes state and action wrappers | Written and tested, **not mounted** (mounting in App.jsx is the UI pass's job) |

## The adb wire client

**Connection.**
- TCP `127.0.0.1:5037`, honoring `ANDROID_ADB_SERVER_PORT` and `ADB_SERVER_SOCKET=tcp:host:port`.
- A request is a 4-hex-digit length plus the service string.
- A reply is `OKAY`, or `FAIL` followed by a hex length and a message.

**Host services used.**
- `host:version`
- `host:devices-l`
- `host:track-devices-l` (server `services.cpp`)
- `host:tport:serial:<s>`, answered with OKAY plus an 8-byte transport id (server `adb.cpp`).
  That id is the connection id for "prompted once per connection".
- `host-serial:<s>:features`

**Shell.**
- `shell,v2,raw:<cmd>` sends packets of 1-byte id, 4-byte LE length, then data. Id 1 is stdout,
  2 is stderr, 3 is the exit code.
- Every command is rc-checked, and none uses `2>/dev/null`.
- Without `shell_v2`, it falls back to `shell:<cmd>; echo "<sentinel>$?"`.
- Commands are chunked at ≤3,072 bytes so they fit the legacy 4 KiB payload, service prefix included.

**Sync.**
- Operations: `STA2`/`LST2` (64-bit size and mtime); `LIS2` → `DNT2`… `DONE`; `SEND "path,mode"`
  → `DATA` ≤64 KiB → `DONE <mtime>` → OKAY or FAIL; `RECV`; `QUIT`.
- v1 fallbacks apply when `stat_v2` or `ls_v2` is missing. v1 sizes are 32-bit, so listing that
  device falls back to shell `find -printf` or `stat -c`, probed.

**adbd behavior the engine relies on** (AOSP `daemon/file_sync_service.cpp`, read this session):
- SEND unlinks an existing regular file, then creates with `O_EXCL`.
- It auto-creates parent directories (`secure_mkdirs`).
- It unlinks the partial file on failure.
- It applies the `DONE` mtime with `lutimes`.
- The dispatch loop handles LSTAT/STAT/LIST/SEND/RECV v1 and v2, plus QUIT.

**Errors map to `AdbError{kind}`.**

| Kind | What produces it |
|---|---|
| `device-lost` | `device '…' not found` (the text behind the 106 cascaded failures), `no devices/emulators found`, EOF mid-stream with the serial gone from `devices-l` |
| `offline` | the device's state is offline |
| `unauthorized` | the device's state is unauthorized |
| `server-unavailable` | ECONNREFUSED |
| `remote-fail` | a sync FAIL message (EACCES, ENOSPC, …) |
| `timeout` | idle watchdog: no socket progress for 60 s |
| `cancelled` | the job was cancelled |

**What disappears.**
- The 50-file / 12,000-char batching.
- One adb process per non-ASCII file. The truncation came from adb.exe computing the leaf
  (`sync_to_tablet.py:824-832`); here the exact UTF-8 path is sent.
- Distrusting "N files pushed". adb printed it next to EOF failures.
- Listing forensics after a failed batch.
- Per-batch-only progress.
- Client/server version fights, because no adb client runs.

**When adb.exe still runs.**
- `adb version`, to list candidates.
- `adb start-server`, only when nothing answers on 5037, sync is enabled, and an adb target exists.
- It never runs `kill-server`.

## Settings and presets (the knob surface; exposure is the UI pass's call)

Global keys live in `settings.json` and follow draft/Save semantics.
- main resolves them in `get-settings` by spreading `resolveSyncSettings(saved)`.
- `countDirtySettings` walks only the draft's keys (`SettingsTab.jsx:469-494`), and first hydration
  spreads get-settings into the draft (`:795-802`). **So no SettingsTab edit is needed now, and
  nothing shows as unsaved.**
- An invalid or out-of-set stored value resolves to the default.

| Key | Default | Presets |
|---|---|---|
| `syncEnabled` | false | on / off |
| `syncPromptOnConnect` | true | on / off |
| `syncDeletePolicy` | guarded | guarded, add-only |
| `syncHashMode` | cached | cached, rehash |
| `syncErrorBudget` | 3 | 1, 3, 5, 10 consecutive failures |
| `syncSizeWarnPct` | 30 | off, 15, 30, 50 |
| `syncChapterPatterns` | "" | free text: one regex per line, with a named group `ch`, validated |

Per-target fields live in `sync-targets.json` and persist immediately (the disabledSites precedent).

| Field | Default | Presets |
|---|---|---|
| `profile` | required | **komikku**: cbz/zip/cbr/rar/epub; cover.jpg + details.json; `.nomedia` on; flags PDF, `~` names and a missing cover. **generic**: all six chapter formats incl. pdf; cover.jpg; `.nomedia` off. **custom**: chosen formats and sidecars |
| `namingPolicy` | strip-hid | strip-hid, as-is, title |
| `renameToMatch` | false | |
| `nomedia` | profile | |
| `cleanupNames` | `.aio_series.json .mangafire_hid .series_hid .cover.webp` | dot-files only |
| `selection` | all-except | all-except, only |
| `excludes`, `aliases`, `ignoredSuggestions`, `acknowledged` | [] | |

**Constants.** These are guards and platform limits, each commented where it is defined:
- mass-delete acknowledgment at ≥50% of a series' chapter files (with ≥10 files), or ≥200 in total;
- a free-space reserve of 1 GiB;
- a re-stat minimum age of 30 s;
- a re-plan debounce of 10 s;
- event coalescing at ≤10/s;
- a DATA chunk of 64 KiB;
- a shell command cap of 3,072 B;
- a 60 s idle watchdog;
- `readSmall` ≤256 KB;
- 30 run logs kept;
- ≤4 hash workers, sized from `cpuPercentForLevel(settings.cpuLimit)`.

## Persistent files — `userData/sync/`

All are written through `store.js`.

**`sync-targets.json`.** Holds `{version, adbPath, targets[]}`. `version` increments on every op, and
an op may carry `expectVersion` for optimistic concurrency.

**`state-<id>.json` + `state-<id>.wal`.** This is the record.
- `header`: kind, serial or folderRoot, canonicalRoot, profile, caseInsensitive, and caps
  (lsV2, statV2, shellV2, sha256sum, findPrintf, statF).
- `folders`: keyed by the folder's slot key. Each entry is
  `{name, identityKey, pcFolder, verifiedAt, files}`.
- `files`: keyed by the file's slot key. Each entry is `{name, size, sha256, devMtime, origin}`.
- `prompted`: keyed by `serial#transportId`.
- **`origin` adds `pending` to the parent's four.** Intent is journaled before a push. At the next
  plan, a pending slot resolves by listing, plus a single-file device hash when the size matches.

**`selection-<id>.json`.** Maps an op id to `{sha, selected}` (rule 7: a newer PC version is
proposed again).

**`find-sources-<id>.json`.** Holds rows of `{folder, query, include, state, candidates[≤5], pick,
pinnedUrl, skip, error}`.

**Other files.**
- `pc-hash-cache.json` + `.wal`
- `logs/<id>/<ts>.json`: keeps 30. Each holds planned totals, final status, and every destructive
  action.
- `covers/<id>/`

## IPC contract

Invoke channels use the `sync:` namespace, following `search:` and `app-update:` (`main.js:1845`).
One push channel, `sync-event`, is kebab-case like every other push channel. The full plan and the
selection stay in main (parent IPC section); the renderer gets summaries and fetches per-file
detail per series.

| Channel | Request → response |
|---|---|
| `sync:get-state` | → `{enabled, settings, config, adb:{binary, serverVersion, error}, devices[], folderPresence, job, plans:{[targetId]: summary}, prompt, find, prewarm}` |
| `sync:config-op` | `{op, expectVersion?, …}` → `{ok, config}` or `{ok:false, code, error}`. Ops: `add-target`, `update-target`, `remove-target`, `forget-record`, `set-adb-path`, `add-alias`/`remove-alias`, `add-exclude`/`remove-exclude`, `set-selection-mode`, `ack-anomaly`/`unack-anomaly`, `ignore-suggestion`/`unignore-suggestion`. Identity-changing ops are refused while that target's job runs |
| `sync:locate-adb` | `{rescan?}` → `{candidates:[{path, version, build, source}], resolved, serverVersion}` |
| `sync:list-devices` | → `{ok, devices:[{serial, state, model, product, transportId}]}` |
| `sync:browse-remote` | `{serial, path?}` → `{ok, path (canonical), parent, entries:[{name, isDir}], presets:[{label, path, exists}]}` |
| `sync:plan` | `{targetId, overrides?:{hashMode, deletePolicy, verifyFirst}}` → `{ok, runId}` or `{ok:false, error: busy / disabled / disconnected / library-missing / record-mismatch}` |
| `sync:series-detail` | `{targetId, seriesKey}` → per-file rows `{opId, kind, name, label, unit, size, origin, preselected, selected, reason, loss}`, plus anomalies and suggestions |
| `sync:set-selection` | `{targetId, changes:[{opId, selected}]}` or `{bulk:'covered-extras'/'split-parts'/'group', …}` → `{ok, totals, losses, massDelete:{required, count}, changedSeries}` |
| `sync:verify` / `sync:prune` / `sync:rename-device-folder` | → `{ok, runId}` |
| `sync:apply` | `{targetId, overrides, ackMassDelete, ackLosses:[opId]}` → `{ok, runId}` or `{ok:false, reason:'blocked', blocking, dropped}`. Main re-lists, re-plans and re-checks losses first (rule 6) |
| `sync:cancel` | → `{ok, wasRunning}` |
| `sync:prompt-response` | `{promptId, action: review / sync-now / not-now}` → `{ok}` |
| `sync:library-status` | → `{asOf, bySeries:{[folderPath]: [{targetId, state: synced / pending / absent, pending}]}}` |
| `sync:label-preview` | `{name, folderName, patterns?}` → `{unit, label, start?, end?}` or `{error}` |
| `sync:export-report` | `{targetId}` → `{ok, path}`. main shows the save dialog through an injected `showSaveDialog` |
| `sync:device-cover` | `{targetId, folder}` → `{ok, path}` (cached under `covers/`) |
| `sync:find-sources:start` / `:cancel` / `:get` / `:update-row` | Runner control. `update-row` patches `{query, pick, pinnedUrl, skip, include}` |

`sync-event` kinds (each carries `kind`, and job-bound ones carry `runId`):
- `device`
- `job`: phase plan/verify/apply/prune; state running/done; byte and file progress; current file;
  a final `{status: completed / cancelled / failed / disconnected, summary}`
- `config`
- `prompt`
- `find`
- `prewarm`
- `library-status`

## Integration edits in existing files

Line numbers are current as of this session.

| File | Where | Edit |
|---|---|---|
| `main.js` | requires (:28-48) | require `./sync/service` and `./sync/sync-settings` |
| `main.js` | close listener :555-569 | Add a sync-busy term. Payload becomes `{running, sync: busySummary}`; `running` is unchanged, so ConfirmQuitDialog keeps working |
| `main.js` | `onComplete` :603-606 | `deviceSync.notifyLibraryChanged("download")` |
| `main.js` | get-settings :648-672 | `...resolveSyncSettings(saved)` |
| `main.js` | save-settings :694-710 | `deviceSync.applySettings(merged)` next to `appUpdater.applySettings`; starts or stops the monitor and pre-warm immediately |
| `main.js` | metadata:update :910, scan-library :965-1049, delete-series :1059, merge-series-folders :1759 (ok && !dryRun), save-series-meta :1781 | `notifyLibraryChanged(reason)`, which drives the debounced re-plan and badges (rule 13) |
| `main.js` | reinstall-python :1824-1842 | Refuse while a sync job runs; cancel find-sources before deleting the env |
| `main.js` | app-update:apply-now :1862-1873, window-all-closed :1953-1961 | `await deviceSync.shutdown({timeoutMs: 5000})` alongside `downloader.cancelAll()`. Cancels the job, flushes the record, kills the find-sources search |
| `main.js` | after `initDownloader()` :1934, before `createWindow()` | `initDeviceSync({ipcMain, send: sendToUI, userDataDir, getSettings, getLibraryRoot, getRunningDownloads, resolveSpawnPaths, extraEnv: buildPythonEnv(), subscribeFocus, isFocused, showSaveDialog})` |
| `preload.js` | the `electronAPI` object | A `sync*` wrapper per channel, plus `onSyncEvent(cb)` returning an unsubscribe (the `onConfirmQuit` shape, :86-90) |
| `library.js` | :1118 | Add `KOMIKKU_CH_RE` to `module.exports` |
| `searcher.js` | `cancel()` :255-263, close handler :202-208 | `killTree(proc)`, plus a `_cancelRequested` flag. taskkill makes the child exit with code 1 and signal null, so today's `signal === "SIGTERM"` test would misreport a cancel as a failure |

**Handoff obligations for the UI pass.** These go into the phase memory and the service.js header:
- render `payload.sync` in ConfirmQuitDialog (today a sync-only close would say "0 downloads are
  still running", `ConfirmQuitDialog.jsx:44,101`);
- mount `useDeviceSync` in App.jsx;
- choose which presets to expose;
- add the settings-twin test once `DEFAULT_SETTINGS` carries any sync key.

## Phases (stop and report after each)

**P0. Groundwork.** No product code; reported with P1.
- Phase memory `device-sync-feature.md` plus a MEMORY.md pointer, cross-referencing both plan files.
- The in-flight baselines above.
- A defect-ledger memory for the shipped defects found while exploring:
  - `delete-series` and `delete-temp` run `rm -rf` with no library-root containment
    (`main.js:1059-1068`, `:817-826`);
  - `reinstall-python` deletes python-env without cancelling downloads (`:1824-1842`);
  - save-settings always answers ok (`:709`) while `_saveJson` swallows errors;
  - `comix:login` spawns without `extraEnv` (agent-reported, verify before ledgering).
- The Komikku spec copy is **already done**: `~/.claude/plans/komikkuspec.md` is byte-identical to
  `git show 1f17a20^:komikkuspec.md` (cmp this session).

**P1. Pure core.** `sync-settings`, `profiles`, `contract`, `naming`, `chapter-labels` (plus the
library.js export), `analysis`, `planner`, `job-record`.
- Test: `tools/_test_device_sync_core.js`.
- **Stop:** green.

**P2. ADB wire client.** `adb/wire`, `adb/client`, `adb/locate`, and `tools/fake-adb-server.js`.
The fake server is backed by a temp dir with adbd SEND semantics. It injects:
- unplug after N bytes;
- a FAIL per path pattern;
- a missing `ls_v2`, `stat_v2` or `shell_v2`;
- case-insensitive lookups;
- no `sha256sum` and no `find -printf`;
- throttled throughput.

Test: `tools/_test_device_sync_adb.js`. **Stop:** green.

**P3. Transports and execution.** `store`, `hash-pool`, `pc-inventory`, `transports`, `executor`.
- Test: `tools/_test_device_sync_exec.js`.
- **Stop:** green.

**P4. Service and integration.** `monitor`, `find-sources`, `service`, `proc-kill` plus the searcher
fix, the main.js and preload edits, and `useDeviceSync.js`.
- Tests: `_test_device_sync_monitor.js`, `_test_device_sync_service.js`,
  `_test_device_sync_contract.js`, `_test_device_sync_hook.js`, `_test_searcher_cancel.js`.
- `npm run build`.
- **Stop:** a tools script drives the service end to end through a fake `ipcMain`, against
  FolderTransport and the fake adb server.

**P5. Packaged smoke and live tablet.**
- **Isolate the test first.** Check whether Chromium's `--user-data-dir` moves Electron's `userData`
  for the unpacked exe.
  - If it does, use it.
  - If not, add a 3-line `AIO_USER_DATA_DIR` hook to main.js, **asking you first**.
  - Either way, back up `%APPDATA%\aio-downloader-ui\*.json` first; the memory's shared-userData
    trap applies.
- **Packaged smoke.** Run `npx electron-builder --dir`, then launch the unpacked exe with a temp
  library (`AIO_OUTPUT_DIR`), sync enabled and a folder target. Its stdout must show the pre-warm
  line from the eval'd workers inside asar, followed by a clean quit.
- **Live tablet, only with your OK and your hands on the cable.** `tools/_live_device_sync.js`
  runs on the scratch root `/storage/emulated/0/Download/aio-sync-test/` with three series,
  including the SPY×FAMILY and Hell's Paradise name shapes. It measures:
  - the device features;
  - the case-insensitivity probe;
  - what an interrupted push leaves (expect nothing, since adbd unlinks the partial) and what an
    interrupted update leaves (expect an empty slot);
  - throughput versus adb.exe on the same files;
  - byte-exact UTF-8 names;
  - `realpath /sdcard`;
  - the toybox capabilities;
  - an unplug mid-run: abort once, then resume.
- **Search timing.** Measure the per-query time split on 5 real find-sources queries. Only if the
  probe phase dominates, propose `AIO_SEARCH_PROBE_DEADLINE`. That would touch the in-flight
  `search_orchestrator.py`, so **ask first**.
- **Stop.**

**P6. Docs and handoff.**
- The IPC contract lives in `contract.js` typedefs plus the `service.js` header, with the handoff
  obligations listed above.
- A CLAUDE.md pointer row and invariants: the socket transport, push-in-place semantics, and
  provenance.
- `android/PARITY.md` N/A-DESKTOP-ONLY rows for the 7 global sync settings and every `sync:*`
  channel (22 invoke channels plus `sync-event` as designed here).
- A memory rewrite at the phase boundary.
- A forced re-read of every changed file, then the report. The ship decision follows.

## Verification

**`_test_device_sync_core.js`**
- **Naming.** Sanitize, hid-strip, `slotKey`, `compactKey`, the 255-byte limit.
- **Labels.**
  - `5.10` ≠ `5.1` and `005` = `5`;
  - `~` legacy names, ranges, device conventions, volumes;
  - recognition parity with `library.js:extractChaptersFromFiles`.
- **Settings.** Resolver defaults and invalid-value fallback.
- **Profiles.** Fill-in of null fields.
- **Provenance matrix.** pushed / adopted / partial / foreign / pending / changed-on-device.
- **Per-slot planning.** In sync, update, replace (unticked group), kept name, rename toggle, push.
- **Preselection.** Guarded vs add-only, and every rule-5 case.
- **Losses.** Recomputed on toggle; the mass-delete threshold.
- **Adoption ladder.** Identity, content ≥90%, name, weak, on sanitized fixtures shaped like the
  old aliases.
- **Collisions and binding.** Same vs different identity; sticky binding across a retitle; held
  excludes.
- **Refusals.** Empty or missing library root; record-header mismatch.
- **Job record.** Stale runId drop; coalescing; auto-plan queue.

**`_test_device_sync_adb.js`**
- Golden-byte codecs for every packet type, including 64-bit sizes.
- Frames split at every byte offset.
- `devices -l` padding and `transport_id`.
- shell-v2 demux and exit codes.
- Error classification using the real `device 'A06B4A372090333' not found` text.
- SPY×FAMILY and `Hell’s Paradise` names land byte-exact.
- Cancel mid-SEND: the socket is destroyed and the fake adbd unlinks the partial.
- v1 fallbacks.
- `start-server` is called once and only when the server is unreachable; `kill-server` is never sent.

**`_test_device_sync_exec.js`**
- An interrupted in-place update leaves an empty slot; the entry is dropped and the re-plan re-pushes.
- The delete gate: a failed replacement keeps its delete.
- The slot guard: a case-only rename on a case-insensitive target never deletes the new file.
- Device loss aborts once, not per series.
- The error budget.
- Cancel mid-file.
- A kill after file k re-plans exactly the rest (journal replay, including a torn last line).
- Guards: re-stat, running-download skip, listing sanity check.
- Verify: managed folders only, rc-checked, a failure keeps entries, never wipes on a quiet failure
  (the `sync_to_tablet.py:373` hazard).
- Prune: `rmdir` only if empty.
- Free-space refusal, including the in-place update math.
- A hash-while-push mismatch.
- FolderTransport temp + rename and its leftover sweep.

**Monitor, service, contract, hook and searcher tests**
- **Monitor.** Frames; prompt state machine: focus, refocus, attached at startup, app restart,
  withdraw on disconnect; backoff.
- **Service E2E.**
  - Disabled means inert: no socket, and no writes under `userData/sync`.
  - Config ops: validation, versioning, refusal during a job.
  - The main flow: plan → selection → apply → modify / rename / delete on the PC → re-plan (kept
    name) → both delete policies → verify → prune → library root unplugged (refusal).
  - Quit shutdown within 5 s.
  - find-sources with a fake Searcher.
- **Contract.** Preload `sync:*` literals equal `contract.CHANNELS`; the hook's event kinds equal
  `EVENT_KINDS`.
- **Hook.** Run against the minimal hook runtime copied from `_test_update_check_hook.js`: buffering
  before the snapshot, snapshot adoption, stale runId.
- **Searcher.** A node child that spawns a grandchild: cancel kills both, and the rejection has
  `cancelled: true`.

**Hostile names.** `'`, `$`, backtick, `|`, `DocumentsX`, `..`, newline, NUL, and names over 255
bytes are rejected or safely quoted, in both `validatePath` and `shq`.

**Regression.** The CLAUDE.md suite. No Python changes are planned, so items 1-6 and 8 are sanity
checks and item 7 (`npm run build`) is the real one. Also re-run the existing `tools/_test_*.js`,
since main.js and preload change.

## Open decisions and risks (my pick → what changes otherwise)

1. **Shipping with in-flight work.** Decided after P6, per CLAUDE.md.
   - Pick: ship with or after the in-flight library.js / series-merge work.
   - Otherwise the identity rules get duplicated into `sync/`, and two definitions drift.
2. **AIO-for-Android library as a root.**
   - Pick: it is a plain folder root with a reader profile. Series synced there are read-only in
     the tablet app, because no `.aio_series.json` is pushed.
   - Otherwise a profile that mirrors `.aio_series.json` makes two writers of that file (the tablet
     app writes `chapters_downloaded` into it). Each sync would then offer a "replace" of it.
3. **Tree-kill in downloader.js.**
   - Pick: leave its inline copy alone (in-flight file) and switch it to `proc-kill.js` at ship time.
   - Otherwise two taskkill spellings live on.
4. **Push-in-place window.** An interrupted update or replace leaves that chapter missing on the
   tablet until the next sync, and Komikku can see a partly written file during a push. Accepted
   with your answer; recorded in memory as a decision, not a defect.
5. **Older devices.** A device without `ls_v2`/`stat_v2` lists through the shell fallback. The
   android-port memory's test tablet runs Android 15, which has both; whether that is the sync
   tablet (serial `A06B4A372090333`) is unverified, and P5 reads its feature list. Until then the
   fallback is exercised only by the fake server.

## Figures

| Figure | Meaning | Source |
|---|---|---|
| 36 M / 21 ?? files; 455 / 197 / 56 changed lines in main.js / library.js / preload.js | In-flight work this pass must not disturb | read: `git status`, `git diff --stat HEAD` |
| `f8e57c1` vs `fcb1a73`; `d1ae7d6` | Remote upstream main vs the stale local ref; the unpushed local commit | read: `git ls-remote`, `git log` |
| 1.0.41 on all 3 adb binaries (builds 36.0.2, 37.0.0, 37.0.0) | No server-version fight is possible between local tools | read: `adb version` ×3 |
| 107 lines (106 `not found` + 1 EOF tail) | The cascade the device-lost abort prevents | read: grep `sync-log-20260706-221724.json` |
| 50 files / 12,000 chars | CLI batching the socket transport removes | recall: agent inventory (`sync_to_tablet.py:116-117`); the cap logic itself read at :465-479 |
| 3.4 MB record, 4.5 MB hash cache; 22,168 record entries | Why the journal replaces whole-file rewrites | read: file sizes via `ls`; entry count is recall (agent inventory) |
| 3,072 B shell cap vs 4 KiB legacy payload | Keeps chunked commands valid on every adbd | recall: adb `MAX_PAYLOAD_V1`, not re-checked this session |
| 22 invoke channels + 1 event channel | The IPC surface this pass ships | derived: the contract table above |
| 64 KiB DATA, 60 s idle, 1 GiB reserve, 30 s re-stat, 10 s debounce, ≤10 events/s, ≤4 workers | Engine constants | parent plan, plus 64 KiB = adb sync DATA maximum (recall) |
