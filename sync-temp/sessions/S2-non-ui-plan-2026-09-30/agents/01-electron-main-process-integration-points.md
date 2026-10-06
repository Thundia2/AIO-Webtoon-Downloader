# Agent: Electron main-process integration points

- type: `Explore`  model: `inherit`  shape: `background`
- transcript (user's machine): `agent-a6373992581b06994.jsonl`
- final report at: 2026-09-30 23:03

<details><summary>prompt</summary>

Medium-thorough, READ-ONLY (modify nothing). Repo: C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader, directory UI-source/electron (an Electron app's main process). Files have uncommitted edits, so line numbers in older notes are stale — report CURRENT file:line for everything, with short verbatim snippets.

1. main.js:
   a. The `get-settings` ipcMain handler: how the returned object is built, and specifically how `appAutoUpdate` (and any other key) is resolved/spread in so absent keys get defaults.
   b. The `save-settings` handler, and where it calls `appUpdater.applySettings` (or similar).
   c. The main window `close` listener / quit gate: what "busy" terms it checks (running downloads? update checks?), the `confirm-quit` payload shape it sends to the renderer, and the IPC that answers it.
   d. `app-update:apply-now`, `window-all-closed`, `before-quit`, `will-quit` handlers — what each does.
   e. `reinstall-python` handler — does it call app.exit / app.relaunch, and does it bypass the quit gate?
   f. `delete-series` handler — does it check the path is inside the library root before rm?
   g. `getConfiguredOutputRoot`, `resolveSpawnPaths`, `sendToUI`, `extraEnv` / `buildPythonEnv` definitions; where `new Searcher(...)` is constructed and with what options.
   h. How `update-check-record.js` and `series-merge.js` are required and initialized (is there an initX({ipcMain, ...}) pattern?), and every ipcMain.handle channel name that uses a colon namespace (e.g. `search:`, `app-update:`, `library:`), to show naming conventions.
   i. `pick-file` / `pick-folder` (or similar) dialog handlers and their default filters.
   j. Any API to enumerate currently running downloads and their output folders/series (e.g. a downloader instance method), and where library rescans / series merges / download completions emit events main could hook.
   k. App `focus`/`blur` handling on BrowserWindow, if any.
2. preload.js: the contextBridge exposure shape; how an `onX(cb)` subscription returns an unsubscribe function (quote one example).
3. updater.js: `resolveSettings` / `applySettings` (or equivalents) — exported contracts.
4. update-check-record.js: its full contract (runId stamping, stale-run dropping, coalesced progress, snapshot re-adoption by renderer).
5. history.js `_saveJson` (~lines 100-140): is it atomic (tmp+rename)? what does it fall back to on error?
6. searcher.js: `Searcher` constructor options (extraEnv? onLog?), how it spawns python (args), and its `cancel()` implementation verbatim.
7. downloader.js: the Windows tree kill (taskkill /t /f?) implementation + function name; how it tracks running downloads (is there a getter for running jobs' output dirs / series titles?).
8. resource-limits.js: every export and signature (cpuPercentForLevel, searchParallelismForLevel, …), the level names, and the file header's note about a src/lib mirror twin.

Output a structured, numbered report with precise file:line references.

</details>

## Final report

# Report: UI-source/electron main process (read-only; line numbers match the current working tree)

All paths are under `C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\`. `main.js`, `preload.js`, `downloader.js` and `library.js` have uncommitted edits. `series-merge.js` and `update-check-record.js` are new, untracked files.

---

## 1. main.js

### 1a. `get-settings` (main.js:648-672)
```js
const saved = history.getSettings();          // shallow copy, history.js:175-177
return {
  ...saved,
  defaults: saved.defaults || {},
  verboseAlways: saved.verboseAlways !== false,
  appAutoUpdate: saved.appAutoUpdate !== false,   // :665  opt-OUT, absent => true
  logUpdateInterval: saved.logUpdateInterval || 100,
  isPackaged: IS_PACKAGED,
};
```
- Only five keys get defaults: `defaults`, `verboseAlways`, `appAutoUpdate`, `logUpdateInterval`, `isPackaged`. Everything else passes through raw, including `appUpdateDelayDays` (the updater clamps it, default 5).
- `pythonCmd`, `scriptPath` and `workingDir` are deliberately not merged in (:668-670). The renderer gets them from `get-resolved-paths` (:682-688).
- The `appAutoUpdate` polarity lives in three places: :665, :706, :1947.
- A one-time migration in history.js:54-71 deletes a stored `appAutoUpdate: false`. It is guarded by `SETTINGS_SCHEMA_VERSION = 1` (:23).
- Stale comment: the header at :632-633 lists `searchOpts` among the merged defaults, but it is not merged.

### 1b. `save-settings` (main.js:694-710)
- Calls `history.saveSettings(newSettings)`. This is a shallow merge `{ ...this._settings, ...filtered }` (history.js:230) after a volatile-path filter.
- It then calls:
  ```js
  const merged = history.getSettings();
  appUpdater.applySettings({ enabled: merged.appAutoUpdate !== false, delayDays: merged.appUpdateDelayDays }); // :701-708
  ```
- It always returns `{ ok: true }` (:709), even if the disk write failed (see §5).

### 1c. Quit gate
- State lives at :172-173: `let quitConfirmed = false; let quitSafetyTimer = null;`. `clearQuitSafetyTimer()` is at :175-180.
- The listener is inside `createWindow()` (:555-569):
  ```js
  mainWindow.on("close", (e) => {
    if (quitConfirmed || !downloader || downloader.runningCount() === 0) return;
    e.preventDefault();
    sendToUI("confirm-quit", { running: downloader.getRunning() });
    clearQuitSafetyTimer();
    quitSafetyTimer = setTimeout(() => { quitSafetyTimer = null; quitConfirmed = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); }, 15_000);
  });
  ```
- **The only busy check is running downloads** (`runningCount()`, which is the size of the `_processes` Map). It does not check:
  - the Check All sweep (`_updateCheck.isRunning()` / `_checkAllAbortCtrl`)
  - an active search (`searcher.isRunning()`)
  - a merge in progress
  - an app-update download
  - queued items (excluded on purpose, per the comment at :550-553)
- **Payload:** `{ running: [{ downloadId, title, url, startedAt }] }`. It is built by downloader.js:981-993 and documented at preload.js:81-85.
- **Answers:**
  - `quit:confirm` (:869-874) clears the timer, sets `quitConfirmed = true`, then calls `mainWindow.close()`.
  - `quit:cancel` (:876-879) only clears the timer.
  - Preload exposes these as `onConfirmQuit` / `confirmQuit` / `cancelQuit` (:86-92).
- Two behaviours to be aware of:
  - The 15s safety valve closes the app if the user simply doesn't answer in time.
  - `quitConfirmed` is never reset to `false` once set.

### 1d. Lifecycle handlers
- **`app-update:apply-now`** (:1862-1873):
  - If `getStatus().state !== "downloaded"`, it returns `{ ok:false, reason }`.
  - Otherwise it sets `quitConfirmed = true` (:1870), then `await downloader.cancelAll()` (:1871), then `return appUpdater.applyNow()` (:1872), which calls `quitAndInstall(true, true)`.
- **`window-all-closed`** (:1953-1961): `if (downloader) await downloader.cancelAll(); app.quit();`. There is no darwin special case.
- **`before-quit` / `will-quit`:** none are registered. They appear only in comments (main.js:1832, updater.js:357-358). There is also no `quit`, `activate`, or single-instance lock handling.
- None of the three quit paths abort the Check All sweep's Python children or the search child.

### 1e. `reinstall-python` (:1824-1842)
The sequence is: `deleteEnv(pythonEnvDir)` (:1830), `appUpdater.suppressInstallOnQuit()` (:1837), `app.relaunch()` (:1840), `app.exit(0)` (:1841).
- **It bypasses the quit gate.** `app.exit` never emits the window `close` event (documented at :866-868).
- **It does not call `downloader.cancelAll()` first.**
- `deleteEnv` (setup.js:1450-1454) is a bare `fs.rmSync(envDir, { recursive: true, force: true })` with no try/catch.
- On Windows, a running `python.exe` is likely to make that throw. The IPC call would then reject before the relaunch/exit, possibly leaving the environment partly deleted.

### 1f. `delete-series` (:1059-1068) has no containment check
```js
if (fs.existsSync(folderPath)) { fs.rmSync(folderPath, { recursive: true, force: true }); }
```
- It checks neither the library root nor running downloads. `delete-temp` (:817-826) has the same shape.
- The only root-containment guard in the codebase is in series-merge.js:387-392 (`if (path.dirname(folder) !== root) return { ok: false, error: "outside_library", folder }`). `libraryRoot` is injected by main at main.js:1769.

### 1g. Helpers and constructors
- **`getConfiguredOutputRoot(workingDir)`** (:220-233):
  - Base folder is `workingDir || defaultWorkingDir`.
  - Output folder name is `process.env.AIO_OUTPUT_DIR || "manga"`, overridden by `aio_config.json` → `output_dir` when the env var is unset.
  - Returns the folder as-is if absolute, otherwise joined onto the base.
  - Used at :968, :1451, :1769.
- **`resolveSpawnPaths(settings)`** (:361-367): returns `{ pythonCmd: settings.pythonCmd || defaultPythonCmd, scriptPath: …, workingDir: … }`.
- **`buildPythonEnv(opts = {})`** (:393-403) adds:
  - `PYTHONUNBUFFERED` when `opts.unbuffered`
  - `PLAYWRIGHT_BROWSERS_PATH` when packaged and `playwrightDir` exists
  - `PYTHONPATH` when packaged on non-Windows
- **`extraEnv`** is a local, not a module variable:
  - `const extraEnv = buildPythonEnv();` at :593 (in `initDownloader`)
  - `buildPythonEnv({ unbuffered: true })` at :1172 (in `_checkSeriesUpdates`)
  - Not used by `comix:login` (:939, `env: { ...process.env, PYTHONUNBUFFERED: "1" }`), so in packaged builds it gets no `PLAYWRIGHT_BROWSERS_PATH`. This may be a bug; I have not verified it.
  - `runMetadataCli` (:254-262) is hand-rolled on purpose.
- **`sendToWindow` / `sendToUI`** (:409-417): `sendToUI(channel, data)` is `sendToWindow(mainWindow, …)`, guarded by `!win.isDestroyed()`. It is used at :161 before its definition; this works because function declarations are hoisted.
- **Constructors:**
  - `new Downloader({ extraEnv, onLog, onProgress, onComplete })` at :595-607.
  - `new Searcher({ extraEnv, onLog: (searchId, line, level) => sendToUI("search-log", { searchId, line, level }) })` at :618-623.
  - `initDownloader()` runs at :1934, after `setupIPC()` at :1920.

### 1h. How modules are wired, and IPC naming
- **There is no `initX({ ipcMain, … })` pattern.** Every handler is inline in `setupIPC()` (:630-1874). The one exception is `retry-setup` (:498-501, with `removeHandler` first).
- **update-check-record:**
  - Required at :41: `const { createUpdateCheckRecord, resultRow: updateCheckResultRow } = require("./update-check-record");`
  - Created by a module-scope factory at :161: `const _updateCheck = createUpdateCheckRecord(sendToUI);` (the send function is injected).
- **series-merge:**
  - Required at :40: `const { mergeSeriesFolders, chapterLabel, compareChapterLabels } = require("./series-merge");`
  - These are pure functions. Dependencies are passed in as data on each call (:1763-1771): `libraryRoot`, `runningDownloads: downloader?.getRunning?.() || []`.
- **updater:** required at :48. `initAppUpdater({ enabled, delayDays, onStatus })` at :1946-1950 is the only init-style call, and it takes a callback, not `ipcMain`.
- **Colon-namespaced handle channels:**

  | Channel | Line |
  |---|---|
  | `search:run` | 753 |
  | `search:cancel` | 783 |
  | `queue:get` | 854 |
  | `queue:save` | 858 |
  | `quit:confirm` | 869 |
  | `quit:cancel` | 876 |
  | `metadata:read` | 906 |
  | `metadata:update` | 910 |
  | `comix:login` | 931 |
  | `app-update:get-status` | 1849 |
  | `app-update:check-now` | 1853 |
  | `app-update:apply-now` | 1862 |

- **There is no `library:` namespace.** Library channels are kebab-case: `scan-library`, `delete-series`, `check-for-updates`, `check-all-updates`, `get-update-check-state`, `cancel-check-all-updates`, `set-chapters-ignored`, `merge-series-folders`, `save-series-meta`.
- The stated convention is at :1845-1846: colon-namespaced "to keep visual distance from the kebab-case manga `check-for-updates` family".
- Push channels (main to renderer) are all kebab-case: `download-log`, `download-progress`, `download-complete`, `search-log`, `confirm-quit`, `theme-changed`, `library-thumb-ready`, `update-check-progress`, `app-update-status`, `setup-*`.

### 1i. Dialog handlers
- `pick-folder` (:888-894): `properties: ["openDirectory"]`. No `defaultPath` and no filters. Returns `null` on cancel, otherwise `filePaths[0]`.
- `pick-file` (:897-904): `filters: filters || [{ name: "Python Scripts", extensions: ["py"] }]` (:900), `properties: ["openFile"]`.

### 1j. Enumerating running downloads, and hook points
- **`downloader.getRunning()`** (downloader.js:981-993) returns only `{ downloadId, title, url, startedAt }`. There is **no output-folder or series-folder getter.**
- Data that exists internally but is not exposed:
  - `entry.meta.args.seriesDir`: `--series-dir` in the flag map (downloader.js:66). It is set only for library update downloads.
  - `entry.progress.hid`, parsed from the "Title (hid=…)" line (:395-399). The tmp folder is derived from it at :835 as `tmp_${hid}` but not stored.
  - `entry.progress.savedFile`, parsed at :452-457.
  - For resumed downloads, `meta` is only `{ url, resumed: true }` (:713).
- **Download completion:** the `onComplete` callback at main.js:603-606 (`history.updateEntry` + `sendToUI("download-complete")`).
  - It fires from downloader.js:908 (on close) and :920 (on spawn error).
  - Status is `"completed"` only for exit code 0; a cancelled download reports `"failed"`.
- **Library rescans:** only the renderer-initiated `scan-library` handler (:965-1049). The only push is `library-thumb-ready` per thumbnail (:1011/:1022/:1038). `check-all-updates` also calls `scanLibrary` internally (:1464). There is no "library changed" event.
- **Merges:** `merge-series-folders` (:1759-1775) only returns its result. A hook would go after `await mergeSeriesFolders(...)` when `ok && !dryRun` (the result carries `moved`, `removed`, `kept`; series-merge.js:493).
- **Check All:** there is a single choke point, `_updateCheck.emit` (update-check-record.js:137-151). The `done` event is emitted in a `finally` at main.js:1667-1673.
- **Other writes with no event:** `set-chapters-ignored` (:1713), `save-series-meta` (:1781), `delete-series` (:1059).

### 1k. Focus/blur
None. Searching `electron/` for focus/blur finds only a comment at main.js:166. The only window events are `close` (:555), `nativeTheme "updated"` (:572), and on the setup window `did-finish-load` (:504) and `closed` (:509).

---

## 2. preload.js
- `contextBridge.exposeInMainWorld("electronAPI", { … })` at :17-247. It is one flat object of `ipcRenderer.invoke` wrappers plus `onX` subscriptions.
- Example unsubscribe pattern (:86-90):
  ```js
  onConfirmQuit: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("confirm-quit", handler);
    return () => ipcRenderer.removeListener("confirm-quit", handler);
  },
  ```
- All `on*` functions follow this shape:
  - `onDownloadLog` :55, `onDownloadProgress` :62, `onDownloadComplete` :68, `onThemeChanged` :74
  - `onSearchLog` :100, `onThumbnailReady` :122, `onUpdateCheckProgress` :191, `onAppUpdateStatus` :208
  - `onSetupStep`, `onSetupLog`, `onSetupProgress`, `onSetupComplete`, `onSetupError` at :222-246
- Stale comments: preload.js:197 and main.js:1844 still say the app self-update is "opt-in"; it is now opt-OUT.

## 3. updater.js
- **There is no `resolveSettings`.** Polarity is resolved by the caller in main.js.
- Exports are at :370-377:
  - `initAppUpdater(opts)` (:259-277):
    - `enabled = opts.enabled === true` (:262)
    - `delayDays = _clampDelayDays(opts.delayDays)` (:116-120: non-finite becomes 5, then clamped to [0, 60] and truncated)
    - `onStatus` is the push callback
    - The first check is armed after 30s (:73)
  - `applySettings(prefs)` (:289-325):
    - `const next = prefs.enabled === true;` (:294)
    - Same enabled value with a changed delay while in the `deferred` state: re-checks
    - Unsupported install: only updates `status.enabled`
    - Enabling: starts immediately, or re-arms if already started
    - Disabling: clears all timers, sets `autoInstallOnAppQuit = false`, state becomes `"disabled"`
  - `checkNow()` (:328-338) returns `{ ok, reason? }`.
  - `applyNow()` (:347-353) returns `{ ok, reason? }`.
  - `suppressInstallOnQuit()` (:362-364).
  - `getStatus()` (:366-368) returns a copy of `status` (:104-114). States: `unsupported | disabled | idle | checking | deferred | downloading | downloaded | up-to-date | no-feed | error`.

## 4. update-check-record.js (163 lines; test at `…\AIO-Webtoon-Downloader\tools\_test_update_check_record.js`)
- **`resultRow(base, r)`** (:49-79) maps a check result to a row:
  - `aborted` → `{ state: "error", error: "aborted", errorMessage: "cancelled" }`
  - other error → `state: "error"`
  - new chapters → `"found"` (with `newChapters`, `total`)
  - otherwise → `"uptodate"`
  - `ignoredChapters` rides on both non-error states.
- **`createUpdateCheckRecord(send)`** (:83-161):
  - `isRunning()` (:91-93)
  - `runId()` (:95-97): returns 0 if no run
  - `snapshot()` (:103-115): returns `{ runId, state, completed, total, durationMs, aborted, startedAt, rows: [...] }`, or `null`
  - `begin(total)` (:119-132): increments `seq`, supersedes the old run, returns `{ runId, startedAt }`
  - `emit(runId, event)` (:137-151): **stale-run drop** via `if (!run || run.runId !== runId || !event) return false;`, then folds and sends `update-check-progress` with `{ ...event, runId }`
  - `rowFor(runId, folderPath)` (:156-159)
- **"Coalescing" is only per-row, last write wins.** Rows go into a Map keyed by `folderPath` (:140) and counters are overwritten (:142-143). There is no time-based throttling or debouncing anywhere; every emit is forwarded immediately. The record is not persisted (:25-26).
- **Main-side flow:**
  - Re-entrancy: a non-forced call while running returns `{ status: "already-running", runId, snapshot }` (main.js:1441-1447).
  - Supersede: aborts the old controller, then `begin` (:1496-1500).
  - Events are emitted as `queued` (:1524-1540), `running` (:1616-1621), `completed` (:1646-1655), and `done` (:1667-1673).
  - `get-update-check-state` is at :1683.
- **Renderer side** (`…\UI-source\src\hooks\useUpdateCheck.js`):
  - Buffers live events until the snapshot has been adopted (:194-227).
  - `adoptSnapshot` fully overwrites local state (:92-113).
  - An unseen `runId` wipes the rows (:123-128).
  - When a call returns `already-running`, it adopts `result.snapshot` (:257-259).

## 5. history.js `_saveJson` (:102-137)
- **It is atomic tmp+rename:** it writes `filePath + ".tmp"` with `writeFileSync`, then `renameSync`.
- **Fallback:**
  - On rename errors `EBUSY`/`EACCES`/`EPERM`, it does `fs.copyFileSync(tmp, filePath)`, which is a non-atomic overwrite (:111-121). If the copy also fails, it only logs `console.error`.
  - Other rename errors, and write-phase errors, are only logged with `console.error`. It never throws.
- **Caveats:**
  - The `finally` block unlinks the tmp file only if `wrote` (:133-135). A partial `.tmp` left by a failed `writeFileSync` is therefore not cleaned up, despite the comment at :127-128.
  - Callers update in-memory state before saving (for example :230), so memory silently diverges from disk on failure.
  - There is no fsync.

## 6. searcher.js
- **Constructor:** `constructor({ onLog, extraEnv })` (:85-110). There is no default parameter, so `new Searcher()` with no argument would throw.
- **Spawn:**
  - Args: `cliArgs = ["-u", scriptPath, ...buildSearchArgs(query, opts)]` (:127). `buildSearchArgs` (:38-82) starts with `["--search", query, "--search-json"]` and appends the optional flags.
  - Options: `stdio: ["ignore","pipe","pipe"], windowsHide: true, env: { ...process.env, ...this._extraEnv, PYTHONUNBUFFERED: "1" }` (:135-145).
  - Only one search runs at a time: a new `runSearch` cancels the previous one (:120-124).
- **`cancel()` verbatim** (:255-263):
  ```js
  cancel() {
    if (!this._proc) return false;
    try {
      this._proc.kill("SIGTERM");
    } catch {
      /* swallow — process may already be dead */
    }
    return true;
  }
  ```
  - This kills only the direct child. Unlike the Downloader, there is no taskkill tree kill on Windows.
  - The close handler maps `SIGTERM`/`SIGKILL` to `err.cancelled = true` (:202-208).
  - `isRunning()` is at :266-268.

## 7. downloader.js
- **Tree kill is inline in `cancel(downloadId)`** (:942-962); there is no separate helper:
  ```js
  spawn("taskkill", ["/pid", String(entry.process.pid), "/f", "/t"], { windowsHide: true });
  ```
  - On non-Windows it uses `SIGTERM`.
  - It returns `entry.closePromise`, which is resolved at :910 (close) and :929 (error).
  - The taskkill child itself is fire-and-forget.
- **`cancelAll()`** (:1004-1015) races `Promise.all(pending)` against a 5000 ms timeout.
- **Tracking:** `this._processes = new Map()` (:571), keyed by `downloadId`.
  - Entry fields (:741-765): `process`, `meta`, `startTime`, `progress`, `processedChapters`, `closePromise`.
  - Entries are removed at :900 and :919.
- **Getters:** `runningCount()` (:972-974) and `getRunning()` (:981-993). There is no getter for output folders or series folders (see 1j).

## 8. resource-limits.js
- **Levels:** `"unlimited" | "high" | "balanced" | "low"`. `_normLevel` (:50-53, not exported) lowercases the value and maps anything unknown to `"unlimited"`.
- **Exports** (:121-130):
  - `NET_DEFAULTS` (:29-35)
  - `NETWORK_PRESETS` (:39-43)
  - `CPU_PRESETS` (:47): `{ high: 75, balanced: 50, low: 25 }`
  - `isNetworkLimited(level)` (:56-58)
  - `applyNetworkLimit(args, level)` (:64-75): returns the same `args` reference when unlimited, otherwise a clone with the four image knobs replaced
  - `cpuPercentForLevel(level)` (:79-82): 100 when unlimited
  - `searchParallelismForLevel(currentValue, level)` (:87-90)
  - `resumeThrottleFlags(settings)` (:101-119): returns a CLI array. It reads `imageWorkers` from `settings.defaults` but the other knobs from the top level.
- **main.js imports four of them** (:28-33). The settings keys are `settings.networkLimit` and `settings.cpuLimit`.
- **Mirror-twin note** (:17-22): "KEEP IN SYNC with ../src/lib/resourceLimits.js — the renderer mirror… THESE tables are the source of truth… A drift guard lives in the verification suite." The twin exists at `…\UI-source\src\lib\resourceLimits.js`.
