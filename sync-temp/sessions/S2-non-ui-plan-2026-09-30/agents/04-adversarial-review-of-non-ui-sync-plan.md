# Agent: Adversarial review of non-UI sync plan

- type: `Plan`  model: `inherit`  shape: `foreground`
- transcript (user's machine): `agent-a2f92cdfdfabe0c31.jsonl`
- final report at: 2026-10-01 00:20

<details><summary>prompt</summary>

You are an adversarial reviewer of an implementation plan. READ-ONLY: do not modify any file.

Files:
- DRAFT PLAN under review: C:\Users\legoc\.claude\plans\c-users-legoc-claude-plans-add-this-scr-noble-truffle.md
- Its PARENT plan (behavior rules 1-13, decisions): C:\Users\legoc\.claude\plans\add-this-script-s-features-linked-pumpkin.md
- Repo: C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader (Electron app in UI-source/; main process in UI-source/electron/). main.js, preload.js, library.js have uncommitted edits; series-merge.js and update-check-record.js are untracked.
- The Python scripts being ported: C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga\sync_to_tablet.py (and manga_ops.py, push_all_to_tablet.py).

Context: the draft is the NON-UI half of a "Device Sync" feature (mirror the manga library to an Android tablet over adb or to a plain folder). Decisions already made by the user and NOT to be re-litigated: (1) talk to adb via the adb SERVER's socket wire protocol from Node (host:*, shell,v2, sync: STA2/LIS2/SEND/RECV), adb.exe only for `version` and `start-server`; (2) push IN PLACE (no temp+rename on the device) even though adbd unlinks an existing file before writing; (3) tests stay in tools/ (gitignored, plain `node tools/_test_*.js`); (4) the UI's appearance and the number of exposed knobs are not decided here — the engine uses a defaults/presets table; (5) Node engine in Electron main, following series-merge.js's injected-dependency pattern.

Your job: find concrete defects in the DRAFT, with evidence. Prioritize by severity. For each issue give: what is wrong, evidence (file:line or protocol fact), consequence, and a specific fix. Areas to stress-test:
1. ADB wire protocol correctness: request framing, shell,v2 packet layout (id byte + 4-byte LE length), sync v2 packet layouts (STA2/LST2/DNT2 field sizes and order, SEND "path,mode" then DATA ≤64KiB then DONE+mtime, OKAY/FAIL), the `sync:` service needing host:transport first, host:tport:serial returning an 8-byte id, track-devices-l framing, what happens to a sync session after a FAIL, whether one sync connection can carry many SENDs, and whether the draft's error classification and cancel semantics are sound. Use your knowledge of AOSP adb (daemon/file_sync_service.cpp, SYNC.TXT, SERVICES.TXT); flag anything the draft states that you believe is wrong.
2. Push-in-place interplay: `pending` origin, free-space math max(0,new−old), the delete gate (rule 6) and slot guard, resume after a kill, and whether the journal (snapshot + WAL) design is sound on Windows (appends, torn last line, compaction atomicity, crash between snapshot rename and WAL truncation).
3. Main-process integration: verify the draft's cited main.js line anchors and behaviors (close listener ~555-569, get-settings ~648-672, save-settings ~694-710, onComplete ~603-606, scan-library ~965-1049, delete-series ~1059, merge-series-folders ~1759, save-series-meta ~1781, reinstall-python ~1824-1842, app-update:apply-now ~1862-1873, window-all-closed ~1953-1961, initDownloader/createWindow ~1934-1935). Check: is the quit gating complete (all exit paths), is "inert when syncEnabled is false" actually achievable with the listed hooks, does resolving sync keys in get-settings really avoid phantom unsaved changes in SettingsTab.jsx (countDirtySettings ~469-494, hydration ~795-802), and does the confirm-quit payload change break ConfirmQuitDialog.jsx.
4. searcher.js cancel via taskkill /t /f: verify the draft's claim that the close handler's `signal === "SIGTERM"` check (searcher.js ~202-208) would misclassify a taskkill cancel, and whether the proposed `_cancelRequested` fix is complete (race: cancel after natural exit, runSearch's own cancel-previous path).
5. Worker threads: inline eval'd Worker in Electron 40 main process inside asar — any pitfalls (require availability in eval workers, termination on quit, fallback).
6. Test plan gaps: important behaviors in the parent plan's rules 1-13 or the draft that have no test listed; fake-adb-server fidelity risks (where a fake that is too kind would hide real bugs).
7. Anything in the parent plan's non-UI scope (its Phases 0-2 and the non-UI parts of 5-6) that the draft silently dropped.
8. Ordering/phasing risks and in-flight-file edit risks.

Be precise and skeptical; do not pad. Output a numbered list ordered by severity (critical / major / minor), then a short list of things you checked and found correct.

</details>

## Final report

# Adversarial review: Device Sync non-UI plan (noble-truffle)

I found 2 critical, 9 major and 14 minor issues. Nothing was modified.

The most serious are:
- **A FAIL ends the sync session.** The draft never accounts for this. With the default error budget of 3, one file that always fails aborts every run at the same point.
- **"Inert" is not protected against exceptions, and nothing checks it before P5.** The new hooks run on code paths every user hits, even with sync off.

Paths used below: `main.js` = `C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\main.js`. The other files named are in the same `electron\` folder or in `UI-source\src\`.

## Critical

### 1. adbd closes the sync session after any FAIL; the draft assumes it stays open

**What is wrong.** Several parts of the draft reuse one sync session and never say what a FAIL does to it:
- `SyncSession` carries stat, list, push and pull;
- each file's result feeds the error budget of "consecutive failures";
- `readSmall` and `device-cover` read many files.

**Evidence** (AOSP `daemon/file_sync_service.cpp`):
- `file_sync_service()` loops `while (handle_sync_command(...))`.
- `handle_sync_command` returns false, and the socket closes, whenever `do_send` or `do_recv` fails. It does the same for `path_length > 1024` ("path too long") and for an unknown id.
- `handle_send_file` sends FAIL the moment an error happens (open/EACCES, write/ENOSPC, secure_mkdirs). It then keeps reading and discarding DATA until DONE, and unlinks the file.
- `do_recv` on a missing file sends "open failed" and returns false.

**Consequence.**
- After one real FAIL, the next operation on that session hits EOF while the device is still listed. The draft's error table has no kind for that case.
- One bad file therefore produces two more spurious failures and trips the default budget of 3.
- The re-plan reaches the same file first, so every run aborts at the same point.
- In `readSmall`, one missing `details.json` kills every read queued behind it.
- The fake's "FAIL per path pattern" injection hides all of this unless the fake also closes the session.

**Fix.**
- A session is dead after any FAIL or EOF. The executor reopens it (`host:tport:serial:` then `sync:`) without charging the budget; only the FAIL itself counts.
- Run STA2 before each RECV, or open one session per RECV.
- Read the socket while streaming DATA, and destroy it on an early FAIL instead of streaming the rest of a large file.
- The fake must send FAIL immediately, drain DATA until DONE, close after every FAIL, and reject paths over 1024 bytes.
- Test: a FAIL on file 2 of 5 → files 3 to 5 still land, and the budget shows 1.

### 2. "Inert" is not failure-isolated, and main.js first runs in P5

**What is wrong.** The new calls sit on paths every user runs with sync off: get-settings, save-settings, the close listener, `onComplete`, scan-library, window-all-closed and apply-now. An exception in any of them breaks existing behavior.

**Concrete failure chains:**
- **window-all-closed** (`main.js:1953-1961`). If `await deviceSync.shutdown()` rejects, `app.quit()` is never reached. A process with no window keeps running, and since there is no single-instance lock (item 7), a relaunch starts a second copy.
- **get-settings** (`:648-672`). A throw from the spread rejects `getSettings()`, and `useDownloader.js:349` has no catch.
  - `settings` then stays the placeholder (`useDownloader.js:166-203`). SettingsTab hydrates from it, and `countDirtySettings` counts nearly every DEFAULT_SETTINGS key as changed.
  - The Save button stays clickable (`SettingsTab.jsx:621`). One Save sends the defaults, and `history.js:229` merges them over the user's `settings.json`.
- **onComplete** runs inside downloader.js's close handler (`downloader.js:908-910`). A throw skips `entry._resolveClose()`, so quit waits the full 5 s, and the main process shows an error dialog.
- **Close listener.** If the sync term is evaluated first and throws, the existing download prompt is skipped too.
- **save-settings.** A throw from `applySettings` after `history.saveSettings` rejects the IPC call. `useDownloader.js:1014-1016` then skips `setSettings`, so disk and renderer disagree, and the immediate-save disabledSites path gets an unhandled rejection.

**Nothing verifies main.js before P5.** P4 validates with tools scripts and `npm run build`. Vite does not compile `electron/main.js` or the unmounted hook, so main.js first runs in P5, and P5 runs with sync enabled.

**Fix.**
- `let deviceSync = null; try { deviceSync = initDeviceSync(...) } catch {}`. Every hook becomes `try { deviceSync?.x?.() } catch {}`.
- window-all-closed and apply-now: `await Promise.allSettled([downloader?.cancelAll(), deviceSync?.shutdown(...)])`, with `app.quit()` in a `finally`.
- get-settings: wrap the resolver and fall back to `{}`.
- `applySettings` runs fire-and-forget with its own catch.
- Add a P4 step:
  - `node --check` on main.js and preload.js;
  - launch the dev app with sync off;
  - confirm settings load with 0 changed and Save round-trips;
  - confirm the close-with-download dialog is unchanged and quit time is unchanged;
  - confirm there is no `userData/sync` folder.

## Major

### 3. LIST, LIS2 and STA2 fail quietly, and DONE is a full-size record

**Protocol facts** (`file_sync_service.cpp`):
- `do_list` does `if (!d) goto done;`. A missing, unreadable or not-a-directory path answers with DONE only — no FAIL — which looks exactly like an empty folder.
- The DONE is a whole `dent` struct with id=DONE: 76 bytes for LIS2, 20 for LIST. The client's `sync_ls` reads `sizeof(dent)` before it tests the id.
- `do_stat_v2` never FAILs on a stat error. It returns a 72-byte STA2/LST2 with `error` set to the errno.
- LIS2 returns `.` and `..` entries. An entry whose lstat failed carries `error` with mode 0.

**Consequences.**
- File-based-encryption tablets accept adb before the first unlock after a reboot, while `/storage/emulated/0` is still inaccessible; a wrong root behaves the same way.
  - The plan-on-connect then sees an empty device.
  - Rule 7's sanity check is per folder ("lists 0 files"), so it does not fire when the whole root lists empty.
  - The plan tries to push everything (at best the free-space check refuses it), and pending slots resolve as "absent".
- If STA2 is treated as "FAIL means missing", the case-insensitivity probe reports case-insensitive on every device, and browse-remote's `exists` flags are always true.
- Reading an 8-byte DONE leaves the rest of the record in the stream and desyncs the next reply.

**Fix.**
- STA2 the root, and any folder before trusting an empty LIS2; require `error==0` and a directory mode.
- Treat "root lists 0 folders while the record has folders" as a failed listing.
- Check the `error` field in the case probe.
- Parse DONE at full size, and skip `.`, `..` and entries with `error != 0`.
- The fake must do all of this, plus a "locked storage" injection.

### 4. The record's devMtime must be read back from the device, not taken from what was sent

**What is wrong.** "Ours" means the listing's size and devMtime still equal the entry (parent rule 3). The draft never says where devMtime comes from, and per-file `pending → pushed` lines invite writing the DONE mtime at OKAY time.

**Evidence.**
- `sync_to_tablet.py:16-17` recorded that on this tablet "adb push does NOT preserve source mtime (tablet mtimes are push-time)", even though adbd applies the DONE mtime.
- adbd sends OKAY before its file handle closes, so a STA2 right after OKAY can race the filesystem's close.
- LIS2 returns whole seconds, while the `find -printf %T@` fallback returns fractions.

**Consequence.** On the next plan, every file the app wrote reads as "changed on device":
- updates become unticked replaces;
- deletes are never pre-selected;
- "Sync now" is never offered.

The provenance model collapses on the user's own tablet.

**Fix.**
- `pushed` lines carry size and sha only.
- devMtime is filled in from the listing taken after each series' pushes (rule 6's listing step), normalized to whole seconds for every listing method.
- Add a P5 measurement of mtime at OKAY, after the listing, after 60 s and after a reconnect.

### 5. The `prompted` key `serial#transportId` suppresses prompts after reboots

**Evidence.** The adb server assigns transport ids from a counter that restarts at 1 in each server process. The `prompted` map is persisted in the record.

**Consequence.** After a PC reboot or an adb-server restart, a single tablet usually gets the same small id again. The app reads it as already prompted, and the connect prompt silently never appears. This will be the common case, not an edge case.

**Fix.**
- Add a server-lifetime part to the key, e.g. `serial#tid#bootEpoch`, where boot epoch = `Date.now() − os.uptime()*1000`, rounded.
- Clear the marks when the monitor sees the device disconnect.
- Test: server restart with the same id → the prompt appears again.

### 6. The journal (snapshot + write-ahead log) design is incomplete for Windows and for concurrent writers

- **(a) Torn last line.** Tolerating it on replay is not enough: the next append lands after it and makes it a middle line. A strict replay then rejects the whole log; a lenient one silently drops the first new line.
  - After a power loss, NTFS can also leave a tail of NUL bytes.
  - Fix: at open, truncate to the last valid line; stop replay at the first bad line; add a per-line checksum.
- **(b) Compaction racing appends.** The hash cache compacts at 8 MB while up to 4 workers keep appending. Snapshot from memory → async write and rename → truncate loses any line appended in between.
  - Fix: one promise queue per store, or rotate the log (rename to `.old`, append to a fresh log, delete `.old` after the snapshot rename).
- **(c) Crash between snapshot rename and log truncation.** Replay is only correct if every operation is an absolute set or delete (safe to re-apply). State that, or stamp a sequence number in the snapshot.
- **(d) No fsync in `writeJsonAtomic`.** After a power loss, the renamed snapshot can be zero-length while the log was already truncated, which loses the whole record and forces a re-Verify of ~22k files.
  - Fix: fsync the tmp before rename; keep a `.bak` until the new snapshot parses; never truncate the log if the rename failed.
- **(e) "Intent is logged first" only holds across process kills,** not OS crashes. The outcome is safe (the file reads as foreign), but the draft should say so.
- **Tests:** add each of these crash and concurrency windows.

### 7. Two app instances would share `userData/sync`

**Evidence.** There is no `requestSingleInstanceLock` anywhere in `electron/*.js`.

**Consequence.** Two stores append to and compact the same log, two monitors run, two prompts appear, and two executors can push to one device at once.

**Fix.**
- Add an exclusive lock file in `userData/sync/` (open with `wx`, write the PID, treat it as stale if that PID is dead).
- The second instance's service refuses with `locked`.
- An app-wide single-instance lock would be simpler, but it changes main.js behavior, so ask you first.

### 8. The first adb target cannot be created

**Evidence.** The draft runs `adb start-server` only when sync is enabled **and** an adb target exists.

**Consequence.** The target editor needs `sync:list-devices` to pick a device, but nothing starts the server unless another tool already did. The picker shows no devices.

**Fix.** Explicit user actions (list-devices, browse-remote, locate-adb) may start the server whenever sync is enabled. Only the background monitor keeps the "a target exists" condition.

### 9. Adding the resolved sync keys to get-settings saves defaults that aren't decided yet

**Evidence.**
- First hydration spreads every get-settings key into the draft (`SettingsTab.jsx:795-802`).
- `handleSave` sends the whole draft (`:913-916`), and `history.js:229` merges it into the file.
- `history.js:58-67` is this project's own precedent: a stored old default of `appAutoUpdate:false` became indistinguishable from a real choice and needed a migration.

**Consequence.** Any user who presses Save stores `syncPromptOnConnect:true`, `syncErrorBudget:3` and the rest — exactly the values the UI pass is still free to change. The spread also buys nothing now: with no sync key in DEFAULT_SETTINGS, there is no phantom "unsaved" count to prevent.

**Fix.** Don't add the keys to get-settings in this pass; the service resolves them internally. Add them in the UI pass together with DEFAULT_SETTINGS.

### 10. Parent rule 8's weak "adopt by size" state has been dropped

**Evidence.**
- Parent rule 8: "Weak entries of that kind never pre-select a delete."
- The draft's origins are pushed, adopted, partial, foreign and pending — nowhere to record a weak adoption.
- The "no sha256sum" fake injection has no specified behavior, and pending resolution needs a device-side hash.

**Consequence.** Size-adopted files get recorded as `adopted`, so they count as "ours" and deletes become pre-selectable on size evidence alone. A delete-safety rule disappears silently.

**Fix.**
- Add a distinct origin such as `adopted-size`, excluded from rule 5's pre-selection.
- Or use RECV plus hashing on the PC, which now works on any device: for pending resolution, and as the Verify fallback for small folders.
- Add both to the provenance matrix test.

### 11. The searcher cancel fix is incomplete

The draft's diagnosis is right. `kill("SIGTERM")` makes Node report `signal:"SIGTERM"`. An external `taskkill /f` gives code 1 and signal null, which `searcher.js:202-213` would report as a failure.

- **(a) A single `_cancelRequested` field breaks runSearch's own cancel-previous path** (`searcher.js:120-124`).
  - If a new search resets the field, the old process's late close (taskkill is asynchronous) reports "exited with code 1".
  - If it doesn't, the new search's normal exit reports "cancelled".
  - Fix: track cancellation per process, e.g. a `WeakSet` checked in that process's close handler, like the existing `this._proc === proc` guards.
- **(b) PID reuse.** Between `exit` and `close`, `_proc` is still set but its handle is already closed, so a taskkill on a recycled PID can kill an unrelated process tree.
  - Fix: return early when `child.exitCode !== null` or `child.signalCode !== null`.
- **(c) `killTree` must return a promise that resolves on close, with a timeout.**
  - reinstall-python's `deleteEnv` is `fs.rmSync(..., {force:true})` (`setup.js:1450-1454`), which throws EBUSY while a dying `python.exe` still holds files. The result is a half-deleted Python environment and no relaunch.
  - Shutdown needs the same await. Also pass `windowsHide:true` to taskkill.
- **(d) "SIGTERM elsewhere" kills only the Python parent on Linux and macOS.** Use `detached: true` there and kill the process group (`process.kill(-pid)`).
- **Tests:** cancel then an immediate new search (old promise `cancelled:true`, new one resolves normally); cancel after a natural exit returns false.

## Minor

### 12. Dependencies missing from `initDeviceSync`
- Deviation 3 throttles hashing "while Check All runs", but no dependency exposes that; `_updateCheck.isRunning()` (`update-check-record.js:91`) is the existing accessor.
- find-sources also needs `isCheckAllRunning` and `searcher.isRunning()`. Only mangafire takes the Python profile lock (`sites/profile_lock.py`, untracked); comix doesn't.
- `subscribeFocus`, `isFocused` and `showSaveDialog` are wired before `createWindow()` runs (`:1934-1935`), so they must read `mainWindow` lazily. Subscribe with `app.on("browser-window-focus")`.

### 13. Gaps in quit coverage
- Quits started by `app.quit()` — the `quit-app` IPC at `:1816`, macOS Cmd+Q — never emit window-all-closed, so shutdown never runs there. Use `before-quit`/`will-quit`: prevent once, await, quit again.
- "Alongside `cancelAll`" must mean in parallel; one after the other doubles the worst case to 10 s.
- Shutdown should also terminate the hash workers and close the monitor socket.
- Only prompt on quit during apply or prune. A background plan or verify should just be cancelled; otherwise a re-plan triggered by a finished download prompts on quit.
- Use `downloader?.getRunning?.() ?? []` in the payload.

### 14. Hash-while-push mismatch
Also write the observed sha into the PC hash cache. Otherwise the cache, keyed by an unchanged size and mtime, keeps the stale sha, and every later plan proposes the same update forever.

### 15. Pending resolution needs more outcomes
- The draft only resolves to pushed or partial. The needed outcomes are:
  - pushed (size and hash match);
  - absent (drop the entry);
  - **restore the previous entry** when the old copy survived — FolderTransport's temp + rename never unlinks it, and adbd's "missing ," or "bad mode" FAIL fires before its unlink;
  - otherwise partial.
- So the pending line must carry the previous entry.
- Case-only renames through a temp name need the same logging. A dot-temp left by a kill is invisible to the planner, which leaves a hidden leaked copy and a re-push.

### 16. Free-space math depends on the transport
`max(0, new − old)` is right for adb. FolderTransport writes the temp next to the old file, so it transiently needs the largest old file on top. Unlinking a file Komikku still has open does not free its space either. Make this a transport property.

### 17. Error classification
- ENOSPC, EROFS, and ECONNREFUSED mid-job (server died) should abort the run instead of using up the budget. Each ENOSPC costs a full file of DATA, because adbd drains until DONE.
- Treat ECONNRESET and EPIPE like EOF.
- On EOF with the serial still listed, re-check after about 1 s and count offline or absent as device-lost.
- Map the FAIL texts "device unauthorized.", "device offline" and "device still authorizing".
- The same serial with a new transport id is a removal plus an add.

### 18. Wire-level details to pin in `wire.js` and the golden-byte tests
- The 4-hex request length and the sync `path_length` are UTF-8 **byte** counts. JavaScript's `.length` breaks on `×` and `’`.
- Remote paths are limited to 1024 bytes including `,<mode>`. The byte cap in `validatePath` must be this, not the parent plan's 4096.
- Send the mode as decimal `33188`.
- adbd splits `path,mode` at the **last** comma, so commas in names are legal. Add a comma to the hostile-names list, and make the fake split at the last comma.
- In shell v2, send `CloseStdin` (id 4, length 0) after OKAY, as the adb CLI does.
- Fall back from `host:tport:` to `host:transport:` on older servers.
- The parent plan's polling fallback for device tracking was dropped.
- Exempt the tracking socket from the 60 s idle watchdog.
- Legacy `shell:` merges stderr into stdout and may emit CRLF line endings.
- Device file names are bytes. Treat names that aren't valid UTF-8 as unmanaged; never pass a lossily decoded name to `rm` or `mv`.

### 19. Verify timeout
The parent's size-scaled timeout became a flat 60 s idle watchdog. `find … -exec sha256sum {} +` prints nothing while it hashes one file, so a multi-GB volume on slow storage times out on every attempt, and that folder can never be verified. Scale the budget by the folder's largest file.

### 20. Folder targets
- `add-target` and `update-target` should reject a root that is inside or contains the library root or userData. A target at `<library>/_mirror` copies the library into itself on every sync.
- The presence check's 3 s timeout abandons the promise but not the underlying file-system thread. A dead network share can tie up threads that hashing and other file operations share. Allow only one presence check in flight per target.

### 21. Re-stat age vs re-plan debounce
The re-plan fires 10 s after a download finishes, but Apply skips files younger than 30 s. The newest chapters are therefore planned and then skipped. Debounce for at least 30 s, or plan those files as "settling".

### 22. `sync:device-cover` cache path
The cache path under `covers/<id>/` is built from a folder name the renderer supplies. Hash or sanitize the file name.

### 23. Editing in-flight files
- `library.js:1118` is itself an in-flight line (HEAD's export is at `:923`). Add a separate line instead: `module.exports.KOMIKKU_CH_RE = KOMIKKU_CH_RE; // deviceSync`.
- Put the main.js requires in their own block after `:48`; the in-flight hunk is `:36-41`.
- The merge-series-folders handler (`:1759`) is entirely uncommitted. The `ok && !dryRun` hook needs `const r = await …; return r`.
- Add `sites/profile_lock.py` to the ship dependencies.
- Save the feature's patch at each phase end. The baseline diff assumes nobody else edits these files in between.

### 24. Test gaps
- Rule 6: re-plan at apply time — changed or vanished ops are dropped, and a new loss blocks.
- Rule 13: a series that just finished downloading never shows "synced".
- Rule 10: "Sync now" eligibility, and one prompt covering several targets on one device.
- Rule 12: the record is cleared when a target's device, root or profile changes.
- Selection persistence keyed by (op id, sha).
- Queued auto-plans are dropped when the device is removed.
- "Disabled" must cover every handler, not just jobs: config-op writes files, locate-adb spawns processes, find-sources:start spawns Python.
- Fake fidelity:
  - the tracker frame arriving before vs after EOF on unplug;
  - an empty `0000` frame;
  - the `(no serial number)` serial, which contains spaces;
  - an NTFS temp directory cannot model a case-sensitive device, so use an in-memory filesystem.
- The hook harness strips exactly one React import (`tools/_test_update_check_hook.js:42-47`).

### 25. P5
- The parent plan's live check "Komikku reads a synced `local/` with `.nomedia`" was dropped.
- The packaged exe is a GUI app, so its stdout needs redirection. Write a marker file under `userData/sync/logs` instead.
- Add the mtime (item 4) and before-first-unlock listing (item 3) measurements.

## Checked and correct

- **main.js anchors:** all match — close listener 555-569, onComplete 603-606, get-settings 648-672, save-settings 694-710, metadata:update 910, scan-library 965-1049, delete-series 1059, merge 1759, save-series-meta 1781, reinstall-python 1824-1842, apply-now 1862-1873, window-all-closed 1953-1961, initDownloader/createWindow 1934/1935.
- **Other anchors:** `ConfirmQuitDialog.jsx` 44/101, `history.js:_saveJson` 102-137, `downloader.js:952`, and `KOMIKKU_CH_RE` at `library.js:148`.
- **Defect-ledger items:** all confirmed. `comix:login` spawns with only `{...process.env, PYTHONUNBUFFERED}` at `:937-941`, so it does belong in the ledger.
- **Unsaved-changes reasoning:** walking only the draft's keys, plus the full first hydration, means no phantom count.
- **ConfirmQuitDialog:** it reads only `data.running`, so adding `sync` is backward compatible.
- **Searcher diagnosis:** correct.
- **Sandboxed preload:** Electron 20 and later sandbox the preload by default, so it can't require local files. Duplicating the literals with a drift test is the right call.
- **ADB protocol claims that hold:**
  - request framing, and the OKAY or FAIL + hex length reply;
  - `host:version`, `devices-l`, `track-devices-l` with full hex-framed lists and an immediate first frame;
  - `tport` returning an 8-byte id and switching the socket;
  - `host-serial:<s>:features`, and `sync:` needing a transport-switched socket;
  - the shell v2 layout (1-byte id + 4-byte little-endian length; ids 1/2/3; 1-byte exit code);
  - SEND with DATA ≤ 65536 bytes, then DONE + mtime;
  - many sync requests per connection until QUIT or an error;
  - 64-bit v2 sizes;
  - adbd's unlink / O_EXCL create / auto-mkdir / unlink-on-failure behavior, including when the client disconnects;
  - the 3,072 B shell cap is conservative.
- **Free-space bound:** summing `max(0, new − old)` is a sound upper bound on peak use for adb's in-place pushes.
- **Eval'd workers:** `new Worker(src, {eval:true})` gets `require` through Node's eval path, so `fs` and `crypto` work and nothing loads from app.asar. Consider synchronous reads inside the workers so hashing doesn't use the shared file-system thread pool.

### Critical Files for Implementation
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\main.js
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\searcher.js
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\preload.js
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\history.js
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\src\components\SettingsTab.jsx
