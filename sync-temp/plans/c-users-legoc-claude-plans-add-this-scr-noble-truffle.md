# Device Sync — non-UI implementation plan

**Status: draft rev 2 (2026-10-06, cloud session on `wip/device-sync-handoff`), awaiting approval.**
- Rev 1 (2026-09-30) got an adversarial review on 2026-10-01: 2 critical, 9 major, 14 minor.
  Rev 2 checks every finding against the code and AOSP and folds in the confirmed ones. Where the
  review was wrong or a better fix exists, it says so. The per-finding disposition is the last
  section.
- Parent plan (behavior rules 1-13, the decisions table, the UI design), approved 2026-09-30:
  `sync-temp/plans/add-this-script-s-features-linked-pumpkin.md`. Rule numbers below refer to it.
  The `~/.claude/plans/` copies are pruned after about 30 days; the `sync-temp/plans/` copies are
  the durable ones.
- Phase state across container resets: `sync-temp/STATE.md`.

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

**The feature stays inert until the UI ships, with one deliberate exception.**
- `syncEnabled` resolves to false. Nothing in this pass adds a sync key to `get-settings` (review
  #9), so nothing new reaches the renderer's Settings draft either.
- While it is off:
  - no adb server start, no socket, no device monitor;
  - no library pre-hash and no quit-gate term;
  - no writes under `userData/sync/`.
- Every IPC handler is registered. All of them except `sync:get-state` and `sync:label-preview`
  answer `{ok:false, code:'disabled'}`. That includes `sync:config-op` (it writes files),
  `sync:locate-adb` (it spawns adb.exe) and `sync:find-sources:start` (it spawns Python).
- **The exception is the app-wide single-instance lock** (your answer, 2026-10-06). It changes
  behavior with sync off: a second launch focuses the running window instead of starting a second
  copy. Dev and installed builds share userData, so they can no longer run side by side.

## Decisions

| Round | Topic | Decision | What it means here |
|---|---|---|---|
| rev 1 | Scope | Appearance and the exposed-knob set are not finalized; knobs use presets; the boundary is my call | **In:** `electron/sync/*`, the main.js hooks, the preload bridge, a typed IPC contract, the searcher tree-kill, and `useDeviceSync.js` (written and tested, **not mounted**). **Out:** every `.jsx`, App.jsx, `DEFAULT_SETTINGS`, ConfirmQuitDialog |
| rev 1 | Transport | ADB wire protocol | Node speaks the adb server's socket protocol; adb.exe only runs `version` and `start-server` |
| rev 1 | Landing | Push in place (parent plan) | adbd unlinks an existing file before writing its replacement, so an interrupted update or replace leaves that slot empty until the next sync. Intent is recorded first, so the next plan re-pushes it (the PC still has the file) |
| rev 1 | Tests | `tools/` only (gitignored) | `tools/_test_device_sync_*.js`, `tools/fake-adb-server.js`, plus a live-tablet harness |
| rev 2 | Instance guard (review #7) | **App-wide single instance** | `app.requestSingleInstanceLock()` in main.js; a second launch focuses the first window. Sync needs no lock file of its own |
| rev 2 | Weak evidence (review #10) | **RECV + `adopted-size`** | A `pending` slot resolves by reading that one file back over the sync protocol (RECV) and hashing it on the PC. Verify uses the device's `sha256sum`. On a device without it, you choose "read back and hash on the PC" (exact, slow) or "adopt by size" (origin `adopted-size`, which never pre-selects a delete) |
| rev 2 | Test persistence | **Force-add in `tools/`** on this branch | `git add -f tools/<file>`; before shipping, `git rm -r --cached tools`, the same as `sync-temp/` |

### Deviations from the parent plan that are my calls (object at review if any is wrong)

1. **The record is sharded per device folder; there is no write-ahead log.** (Rev 2 replaces rev 1's
   snapshot plus append-only journal.)
   - Rev 1 used a journal because rewriting the whole 3.4 MB record for every file is too costly.
     Review #6 showed what that journal still needed to be safe on Windows:
     - truncate to the last valid line on open, with per-line checksums;
     - serialize compaction against appends;
     - make every operation idempotent, or stamp sequence numbers;
     - fsync, and keep a `.bak`.
   - Sharding removes the cost that motivated the journal instead:
     - each managed device folder gets its own file, `targets/<id>/folders/<h>.json`;
     - a change rewrites only that folder's file, atomically (write a tmp, fsync it, rename);
     - a typical series shard is tens of KB, and the largest (One Piece, 1,197 chapters) is
       estimated at about 250 KB.
   - Intent: before a push, the file's entry becomes `pending` and carries `prev`, the entry it
     replaces. After OKAY it becomes `pushed`. That is two shard writes per file.
   - Because each write is fsync'd, intent also survives an OS crash. Rev 1's journal covered
     process kills only (review #6e).
   - A shard that fails to parse marks its folder unverified, and that folder is re-verified before
     its ops are planned. This is safe by construction: an unverified folder is never deleted from
     (rule 3, coverage).
   - The PC hash cache stays one file, and **main is its only writer**: hash workers return
     results and never touch the disk. That removes review #6b's compaction race. It is flushed
     every 500 hashes and at the end; losing it costs a re-hash, never a wrong answer.
   - P3 measures the cost. If two fsyncs per file add more than 5% to a transfer of typical chapter
     files, intent is batched per N files. That is still safe: an unresolved `pending` resolves
     through RECV.
2. **Hash-while-push.**
   - The bytes streamed to the device are hashed on the fly, so the record's sha is always the sha
     of what was actually sent.
   - A mismatch with the planned sha (the file changed without changing size or mtime) is recorded
     truthfully and reported.
   - **The observed sha is also written into the PC hash cache** (review #14). Otherwise the cache
     keeps the stale sha under an unchanged (size, mtime) key, and every later plan proposes the
     same update forever.
3. **Pre-warm hashing is gated and throttled.**
   - It runs only when sync is enabled **and** at least one target exists.
   - It drops to 1 worker while a download or a Check All sweep runs. Check All is read through
     `isCheckAllRunning`, injected as `_updateCheck.isRunning()` (`update-check-record.js:91`).
4. **Two extra event kinds, `prewarm` and `library-status`.** They feed "Preparing (hashing N%)"
   (rule 10) and the badge refresh (rule 13), which the parent plan's event list had no channel for.
5. **Automatic connect-plans queue behind the job lane** (FIFO, one per target). A user-started job
   while busy is refused with `busy` plus the snapshot, like the Check All re-entrancy guard. **A
   queued auto-plan is dropped when its device disconnects.**
6. **Device loss is event-driven.** The monitor's track socket reports a removal within about a
   second, and the service aborts the in-flight transfer on that event. An EOF while the serial is
   still listed is rechecked after about 1 s before it counts as device loss (review #17).
7. **`sync:browse-remote` returns root presets** (Documents, Download, Komikku `…/local` when found,
   the AIO-for-Android default library, custom) with an `exists` flag. The flag comes from STA2
   `error == 0` plus a directory mode, never from "STA2 answered", because STA2 never FAILs
   (review #3).
8. **Shutdown is synchronous-safe by construction.**
   - Deviation 1 means nothing durable ever waits in memory: every record change is on disk when it
     happens.
   - So `shutdownNow()` is synchronous:
     - destroy the sockets (adbd then unlinks the partial file);
     - stop the hash workers;
     - write the job's cancelled status;
     - spawn the find-sources taskkill, a separate process that finishes even after Electron exits.
   - It runs from the `quit` event. Every exit emits `quit`: `app.exit()` too, per main.js's own
     comment at :1832. That covers the `app.quit()` paths that never emit `window-all-closed`
     (`quit-app` at :1816, the updater, macOS Cmd+Q).
   - This replaces the review's "prevent `will-quit` once, await, quit again" (#13), which would
     add a second quit state machine next to `quitConfirmed`.
   - The awaited `shutdown()` still runs alongside `cancelAll()` in `window-all-closed` and
     `apply-now`, so a normal close waits for the find-sources child.
9. **Files younger than 30 s plan as `settling`** (review #21).
   - They are counted but not offered, and the service schedules one re-plan when the youngest one
     settles.
   - The 10 s re-plan debounce stays. Apply's 30 s re-stat age would otherwise skip the newest
     chapters right after planning them.

## Repo state and the branch protocol

**Where this executes.** This plan runs on branch `wip/device-sync-handoff` of the fork
(`Thundia2/AIO-Webtoon-Downloader`).
- The branch never becomes a PR head against zzyil and is never pushed to `upstream`.
- `sync-temp/` and every force-added `tools/` file are dropped before anything ships (see
  `sync-temp/README.md`).

**The baseline is a commit now.**
- Commit `a27aaf4` is the snapshot of all in-flight local work: 36 modified and 24 untracked files
  as of 2026-10-06.
- `git diff a27aaf4 HEAD -- UI-source` yields exactly this feature's product hunks, whichever ship
  strategy you pick. Add `tools` to that pathspec to include the force-added tests.
- That replaces rev 1's copy-to-`~/.claude/plans/device-sync-baseline/` step.
- The diff sizes rev 1 recorded still match the WIP commit: `git diff --stat d1ae7d6 a27aaf4` shows
  455 changed lines in `main.js`, 56 in `preload.js` and 197 in `library.js`; `searcher.js` is
  untouched.

**Editing in-flight files.** `main.js`, `preload.js` and `library.js` are in-flight; `searcher.js` is
clean. Every edit to them is a small contiguous block carrying the grep anchor `deviceSync`. In
detail:
- main.js requires go in their own block after `:48` (the in-flight hunk is `:36-41`);
- library.js gets a new line instead of an edit to the in-flight export at `:1118` (HEAD's export
  is at `:923`).

**Commits.**
- Commit and push (`git push -u origin wip/device-sync-handoff`) at each phase's stop point, after
  its tests are green.
- Mid-phase checkpoints are open decision 6.

**State.** The cloud cannot write your memory.
- Phase state, open decisions and the defect ledger live in `sync-temp/STATE.md`. Your local
  session folds them into `device-sync-feature.md`.
- New files under `sync-temp/` need `git add -f`.

**Container limits.**
- There is no device here. Live steps run on your PC, with your OK.
- Windows-only behavior is exercised only on your PC: taskkill, NTFS rename and fsync timing,
  `%APPDATA%`, the NSIS-packaged exe.
- P0 checks whether this container can run `npm ci`, `npm run build` and launch Electron (under
  xvfb). Anything it can't run moves to your PC and is named in the phase report.

**Shipping order.** This feature cannot ship ahead of the in-flight work: `seriesIdentityKey` and
`normalizeSeriesUrl` exist only in the in-flight `library.js`, and `series-merge.js` (which supplies
`compareChapterLabels`) is new in the WIP commit. See open decision 1.

## Architecture — `UI-source/electron/sync/`

Every module gets the standard header: what it owns, who reads it, and cross-file grep anchors.
No module requires `electron`. Collaborators are injected, following the `series-merge.js` and
`update-check-record.js` precedent, so everything runs under plain `node` in `tools/`.

| Module | Owns | Delta vs parent |
|---|---|---|
| `sync-settings.js` | Defaults and preset specs for the global keys; pure `resolveSyncSettings(saved)`; `SYNC_SETTING_SPECS` for the UI | New (knob surface, see below) |
| `profiles.js` | Reader-profile presets; `resolveTargetConfig(target)` fills every per-target field | New. A `null` field means "profile default", so a profile switch propagates |
| `contract.js` | Invoke-channel names, the event channel `sync-event`, event kinds, op kinds, origins, job phases, error codes, JSDoc typedefs for every payload | New. Preload and the hook duplicate the literals because the sandboxed preload can't `require`; a drift test compares them |
| `naming.js` | As parent: `sanitizeSegment`, `stripHidSuffix`, `slotKey`, `compactKey`, `deriveSearchQuery`, `resolveTargetName`, the 255-byte segment check | — |
| `chapter-labels.js` | As parent: unit + conservative label, device conventions, custom patterns | Imports `KOMIKKU_CH_RE` (a new export line after `library.js:1118`) |
| `analysis.js` | As parent: delta-cause tags and anomalies | — |
| `provenance.js` | Pure: the origin model, "ours", and pending resolution: absent / pushed / restore previous / partial, from a listing plus RECV hashes | New (split out of the planner so the matrix is testable on its own) |
| `planner.js` | As parent (pure, stable op ids, rules 1-5) | Free space per transport (see `transports.js`); `settling` files; `adopted-size` never pre-selects a delete |
| `job-record.js` | As parent: one lane, runId-stamped emits, coalesced progress (≤10/s), snapshot | Adds the FIFO queue for automatic plans, dropped on device removal |
| `store.js` | `writeJsonAtomic` (tmp, fsync, close, rename; 5 retries with backoff on EBUSY/EPERM/EACCES, then throws); the sharded `RecordStore`; the startup sweep of stale `.tmp` files | Deviation 1. `history.js:_saveJson` (102-137) is **not** the model: it falls back to a non-atomic copy and swallows errors |
| `hash-pool.js` | As parent: `worker_threads` via an inline eval'd worker, main-thread fallback, cache keyed by path → `{size, mtimeNs, sha256}` | Main is the single writer of the cache. Workers use synchronous reads so hashing doesn't occupy the shared fs thread pool. Throttle (deviation 3) |
| `pc-inventory.js` | As parent: async walk of `getConfiguredOutputRoot`, identity / url / title / `anilist_*`, hard failure on a missing or empty root | — |
| `adb/wire.js` | Pure codecs: request framing (byte lengths), OKAY/FAIL, sync packets at full struct sizes, shell-v2 packets, `devices -l` rows parsed from the end, track frames split across chunks | New |
| `adb/client.js` | Sockets: host services, transport binding (`tport` with a `transport` fallback), `shell()`, `SyncSession` (stat, list, push, pull) with the session lifecycle below | New |
| `adb/locate.js` | Candidates from the configured path, PATH, ANDROID_HOME/ANDROID_SDK_ROOT and `%LOCALAPPDATA%\Android\Sdk` (each with `adb version`); `startServer(bin)` | Replaces the locate half of the parent's `adb.js` |
| `transports.js` | The interface; `AdbTransport` on the client; `FolderTransport` (dot-temp + rename, `fs.statfs`, async presence stat with a 3 s timeout and one check in flight per target); `validatePath`; `shq`; `freeSpaceNeeded(ops)` per transport | `validatePath` caps remote paths at 1018 bytes (see the framing section) |
| `executor.js` | As parent: per-series order and the failure model (rules 6-7) | Per-file results; devMtime only from the post-series listing; intent shard writes; the error policy in the error table |
| `monitor.js` | `host:track-devices-l` on a persistent socket (backoff 2→60 s, polling `host:devices-l` every 5 s after 3 straight failures), folder presence, focus-aware prompt state machine (rule 10) | No CLI child process; prompt marks keyed with a boot epoch |
| `find-sources.js` | Runner: sequential searches on its own `Searcher`, top 5 candidates, resumable, retry with an edited query; waits while Check All or the Search tab's search runs | Unchanged scope |
| `service.js` | `initDeviceSync(deps)`, every `sync:*` handler, settings hooks, quit hooks, library-change notifications, badge computation. The returned facade **never throws**: every method catches and logs | Failure isolation (review #2) |
| `electron/proc-kill.js` | `killTree(child, {timeoutMs})` → a Promise that resolves when the child closes (or on timeout). win32: `taskkill /pid N /t /f` with `windowsHide`. Elsewhere: `process.kill(-pid)` on a detached group, then SIGKILL on timeout | New shared helper. `downloader.js:952` keeps its inline copy because that file is in-flight |
| `src/hooks/useDeviceSync.js` | Renderer mirror: buffers events until the snapshot lands, adopts the snapshot, applies events by kind, exposes state and action wrappers. Opens with exactly one `import {…} from "react";` line, which the tools harness strips | Written and tested, **not mounted** (mounting in App.jsx is the UI pass's job) |

## The adb wire client

Protocol facts below cite AOSP `packages/modules/adb` at `main` (commit `1cf2f01`, fetched
2026-10-06). Every one was read this session. adbd on Android 11+ updates through the adbd APEX, so
P5 reads the tablet's feature list rather than assuming a version.

**Connection.**
- TCP `127.0.0.1:5037`, honoring `ANDROID_ADB_SERVER_PORT` and `ADB_SERVER_SOCKET=tcp:host:port`.
- A request is a 4-hex-digit length plus the service string.
- A reply is `OKAY`, or `FAIL` followed by a hex length and a message.

**Host services used.**
- `host:version`
- `host:devices-l`
- `host:track-devices-l` (`services.cpp:252-258`)
- `host:tport:serial:<s>`, answered with OKAY plus an 8-byte transport id (`adb.cpp:1303-1345`).
  If a server FAILs it, the client falls back to `host:transport:<s>` and takes the id from the
  `devices -l` row.
- `host-serial:<s>:features`

**Shell.**
- `shell,v2,raw:<cmd>` sends packets of 1-byte id, 4-byte LE length, then data. Id 1 is stdout,
  2 is stderr, 3 is the exit code.
- After OKAY the client sends CloseStdin (id 4, length 0), as the adb CLI does
  (`client/commandline.cpp:546`).
- Every command is rc-checked, and none uses `2>/dev/null`.
- Without `shell_v2`, it falls back to `shell:<cmd>; echo "<sentinel>$?"`. That legacy stream
  merges stderr into stdout and may use CRLF, so it is normalized before parsing.
- Commands are chunked at ≤3,072 bytes so they fit the legacy 4 KiB payload, service prefix
  included.

**Sync.**
- Operations:
  - `STA2`/`LST2` (64-bit size and mtime);
  - `LIS2` → `DNT2`… `DONE`;
  - `SEND "path,mode"` → `DATA` ≤64 KiB → `DONE <mtime>` → OKAY or FAIL;
  - `RECV`;
  - `QUIT`.
- v1 fallbacks apply when `stat_v2` or `ls_v2` is missing. v1 sizes are 32-bit, so listing that
  device falls back to shell `find -printf` or `stat -c`, probed.

**Session lifecycle** (review #1, critical).
- A sync session is one socket: `host:tport:serial:<s>`, then `sync:`. adbd handles its requests one
  at a time (`daemon/file_sync_service.cpp:862-866`).
- **adbd closes the session after any FAIL.** `handle_sync_command` returns false, and the loop
  ends, when any of these fails:
  - a SEND or RECV;
  - a path over 1,024 bytes (`:812-815`);
  - an unknown command;
  - a RECV of a file it can't open (`:639-642`);
  - QUIT (`:852-853`).
- So a session is dead after any FAIL or EOF. The client reopens it lazily for the next operation.
  **A reopen never costs the error budget**; only the FAIL that caused it counts. Rev 1's design
  would have charged the budget for the spurious EOFs too: one bad file trips the default budget
  of 3, and every re-run aborts at the same file.
- **Pushes are acknowledged one file at a time**: SEND, DATA…, DONE, then read OKAY or FAIL before
  the next SEND.
  - The adb CLI pipelines SENDs and reads deferred acknowledgements
    (`client/file_sync_client.cpp:806-830`). That is why one FAIL there fails every file queued
    behind it.
  - A round trip per file is negligible next to chapter-sized files. If P5 shows small files
    (covers, `details.json`) dominate a run's time, pipelining can come later behind the same
    interface.
- **While DATA streams, the client also reads the socket.** adbd sends FAIL as soon as an open or
  write fails, then drains DATA until DONE (`:423-453`). An early FAIL therefore stops the stream
  and destroys the socket, instead of sending the rest of a multi-GB file. ENOSPC is where this
  matters.
- `readSmall` and `device-cover` STA2 each path first and RECV only regular files that exist, so
  one missing `details.json` no longer kills every read queued behind it.

**Quiet failures** (review #3). Listing and stat errors do not FAIL.
- LIST/LIS2 on a missing, unreadable or non-directory path answers DONE only (`do_list`,
  `if (!d) goto done;`, `:207-208`). That is indistinguishable from an empty folder.
- STA2/LST2 never FAIL. A stat error comes back in the record's `error` field, with the other
  fields zeroed (`:162-191`). STAT v1 returns mode 0.
- DONE in a listing is a full dent record: 76 bytes for LIS2 and 20 for LIST (`file_sync_protocol.h`,
  `sync_dent_v2` / `sync_dent_v1`). The full record is read before the id is tested; reading only
  8 bytes would desync the next reply.
- LIS2 returns `.` and `..`, and an entry whose lstat failed carries the raw errno in `error`, with
  mode 0 (`:210-246`). Those entries are skipped.
- **Rules:**
  - STA2 the root before every listing; it must report `error == 0` and a directory mode.
  - STA2 a folder before trusting an empty LIS2 of it.
  - A root that lists 0 folders while the record holds folders is a **failed listing**. Planning
    refuses with `device-listing-suspect` instead of offering to push everything.
  - The case-sensitivity probe and browse-remote's `exists` read the `error` field.
- This covers file-based-encryption tablets that accept adb before the first unlock after a
  reboot, while `/storage/emulated/0` is still inaccessible, and a wrong root.

**Framing details pinned in `wire.js`** (review #18).
- The 4-hex request length and `SyncRequest.path_length` are **UTF-8 byte** counts. JavaScript's
  `.length` is wrong for `×` and `’`.
- SEND v1's spec is `"<path>,<mode>"` with the mode in decimal (`33188` = 0o100644), the CLI's own
  `"%s,%d"` (`client/file_sync_client.cpp:585`).
- adbd splits at the **last** comma (`:563`), so commas in names are legal; they join the
  hostile-names list.
- The 1,024-byte limit covers the path plus `,33188`, so `validatePath` caps remote paths at
  **1,018 bytes**, not the parent plan's 4,096. The 255-byte per-segment cap stays.
- `devices -l` rows pad the serial with `%-22s`, and a serial can contain spaces
  (`(no serial number)`, `transport.cpp:1407-1416`). So `transport_id:` and the state are parsed
  from the end of the row.
- Device file names are bytes. A name that isn't valid UTF-8 is unmanaged: it is listed, never
  planned, and never passed to `rm` or `mv` in a lossily decoded form.
- The tracking socket is exempt from the 60 s idle watchdog.

**adbd SEND behavior the engine relies on** (`daemon/file_sync_service.cpp`):
- `send_impl` unlinks an existing regular file before a byte is written (`:516-525`).
- It creates with `O_EXCL`, creating parent directories on ENOENT (`secure_mkdirs`, `:363-371`).
- On failure, or when the client disconnects mid-stream, it sends FAIL, drains DATA until DONE, and
  unlinks the partial (`:423-453`).
- If that unlink failed, the create hits EEXIST and adbd **reopens the old file without
  `O_TRUNC`** (`:372-374`). A shorter push then leaves the old tail. The post-series listing's size
  check catches it: a size different from the PC's is recorded as `partial`.
- It sends OKAY before `lutimes` applies the DONE mtime (`:419-421` vs `:552-557`). A STA2 on the
  same session still runs after `lutimes`, because the loop is serial. Nothing here relies on the
  DONE mtime (next point).

**devMtime comes only from listings** (review #4).
- The `pushed` write carries size and sha only.
- The entry's `devMtime` is filled from the listing taken after the series' pushes (rule 6's
  listing step). It is normalized to whole seconds for every listing method: LIS2 reports seconds,
  while `find -printf %T@` and `fs.stat` report fractions.
- Reason: `sync_to_tablet.py:16-17` recorded that on this tablet "adb push does NOT preserve source
  mtime (tablet mtimes are push-time)". Whatever the cause, only a value read the same way as the
  next plan's listing is comparable to it.
- P5 measures the mtime at OKAY, after the listing, after 60 s and after a reconnect.

**Errors map to `AdbError{kind}`, and each kind has one policy.**

| Kind | What produces it | Policy |
|---|---|---|
| `device-lost` | `device '…' not found` (the text behind the 106 cascaded failures), `no devices/emulators found`; or EOF/ECONNRESET/EPIPE when the serial is gone from `devices -l` after a ~1 s recheck; or the same serial with a new transport id (a removal plus an add) | Abort the run once: "disconnected — reconnect to resume" |
| `session-closed` | EOF/ECONNRESET/EPIPE while the serial is still listed as `device` | Reopen the session; no budget charge |
| `unauthorized` | state `unauthorized`; FAIL text `device unauthorized.` or `device still authorizing` | Abort with USB-debugging guidance |
| `offline` | state `offline`; FAIL text `device offline` | Abort |
| `server-unavailable` | ECONNREFUSED at connect, or mid-job | Abort the run (the server died) |
| `no-space` | a sync FAIL carrying ENOSPC | Abort the run. adbd drains each SEND to DONE, so every further attempt costs a whole file of DATA |
| `read-only` | a sync FAIL carrying EROFS | Abort the run |
| `remote-fail` | any other sync FAIL (EACCES, …) | Counts against the consecutive-failure budget |
| `timeout` | idle watchdog: no socket progress for 60 s. Verify uses a scaled budget (see Verify) | Counts against the budget |
| `cancelled` | the job was cancelled | Stop; record flushed by construction |

**What disappears** (relative to the scripts).
- The 50-file / 12,000-char batching.
- One adb process per non-ASCII file. The truncation came from adb.exe computing the leaf
  (`sync_to_tablet.py:824-832`); here the exact UTF-8 path is sent.
- Distrusting "N files pushed", which adb printed next to EOF failures.
- Listing forensics after a failed batch.
- Per-batch-only progress.
- Client/server version fights, because no adb client runs.

**When adb.exe still runs** (review #8).
- `adb version`, to list candidates.
- `adb start-server`, only when nothing answers on 5037 and sync is enabled, and either:
  - an explicit user action needs the server: list-devices, browse-remote, locate-adb's server
    check, or a plan/verify/apply on an adb target. Without this, the target editor's device picker
    could never show the first device;
  - or the background monitor starts, which requires an adb target to exist.
- It never runs `kill-server`.

## Provenance, pending resolution and Verify

**Origins** (parent rule 3, plus two):
- `pushed`, `adopted`, `partial`, `foreign` (parent);
- `pending`: intent recorded before a push, carrying `prev`;
- `adopted-size`: Verify matched by size alone, at your explicit choice on a device without
  `sha256sum`.

**Ours** is pushed, adopted, adopted-size or partial, provided the listing's size and devMtime still
equal the entry's. **Rule 5 never pre-selects the delete of an `adopted-size` file** (parent rule 8:
"Weak entries of that kind never pre-select a delete"). Its updates still apply.

**Pending resolution**, at the next plan, from the listing plus RECV:

| Listing shows | Check | Outcome |
|---|---|---|
| no file | — | Drop the entry. With a `prev`, the old copy was unlinked, so the slot plans a push |
| the planned size | RECV the file and hash it on the PC: equals the planned sha | `pushed` |
| `prev`'s size | RECV + hash equals `prev.sha256` | **Restore `prev`**: the old copy survived. Either the SEND never reached adbd, or a FolderTransport temp never got renamed |
| anything else, or the RECV hash matches neither | — | `partial` (ours; its update is pre-selected) |
| any | the RECV fails | Stays `pending`, and the folder is flagged. Never a delete candidate |

**Case-only renames through a temp name** carry the same intent: `{renameIntent: {from, via, to}}`
is written to the shard before the first move. The next plan finishes or reverts the rename, so a
dot-temp left by a kill is never an invisible leaked copy (review #15).

**Verify modes** (`sync:verify {mode}`):
- `device-hash` is the default. It runs
  `find '<F>' -maxdepth 1 -type f ! -name '.*' -exec sha256sum {} +`, rc-checked, per managed
  folder.
- `read-back` RECVs each file and hashes it on the PC. It is exact and needs no shell, but it is
  slow: every byte crosses USB again.
- `adopt-size` records size matches as `adopted-size`.
- On a device without `sha256sum`, the service offers `read-back` or `adopt-size`.
- **Timeout:** `sha256sum` prints nothing while it hashes one file, so a flat 60 s idle watchdog
  would fail a multi-GB volume on every attempt (review #19). Verify's idle budget is
  60 s + (the folder's largest file ÷ 8 MiB/s).
- **Failure:** a failed hash (rc ≠ 0, device loss, an empty result while the listing shows files)
  keeps the old entries. It never wipes them on a quiet failure; that was the `sync_to_tablet.py:373`
  hazard.

## Settings and presets (the knob surface; exposure is the UI pass's call)

**This pass adds nothing to `get-settings`** (review #9; rev 1 spread the resolved keys into it).
- First hydration copies every get-settings key into the SettingsTab draft (`SettingsTab.jsx:795-802`).
- `handleSave` sends the whole draft (`:913-916`), and `history.js:229` merges it over the file.
- So every user who pressed Save would store defaults the UI pass is still free to change.
  `history.js:58-67` shows this repo already paid that cost once: a migration had to drop stored
  `appAutoUpdate:false` values that carried no intent.
- The spread also bought nothing: with no sync key in `DEFAULT_SETTINGS`, there was no phantom
  "unsaved" count to prevent.
- The service reads `history.getSettings()` and resolves the keys internally with
  `resolveSyncSettings(saved)`. **The UI pass adds them to get-settings together with
  `DEFAULT_SETTINGS`** and the twin test.
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
| `root` | required | adb: chosen in browse-remote. Folder: **refused when it is inside or contains the library root or userData** (review #20). A target at `<library>/_mirror` would copy the library into itself on every sync |
| `namingPolicy` | strip-hid | strip-hid, as-is, title |
| `renameToMatch` | false | |
| `nomedia` | profile | |
| `cleanupNames` | `.aio_series.json .mangafire_hid .series_hid .cover.webp` | dot-files only |
| `selection` | all-except | all-except, only |
| `excludes`, `aliases`, `ignoredSuggestions`, `acknowledged` | [] | |

**Constants.** These are guards and platform limits, each commented where it is defined:
- mass-delete acknowledgment at ≥50% of a series' chapter files (with ≥10 files), or ≥200 in total;
- a free-space reserve of 1 GiB;
- a re-stat minimum age of 30 s, which is also the `settling` age;
- a re-plan debounce of 10 s;
- event coalescing at ≤10/s;
- a DATA chunk of 64 KiB;
- a shell command cap of 3,072 B;
- a remote path cap of 1,018 B, plus 255 B per segment;
- a 60 s idle watchdog; Verify uses 60 s + largest file ÷ 8 MiB/s;
- a device-lost recheck after 1 s;
- tracking falls back to polling (5 s) after 3 straight failures;
- `readSmall` ≤256 KB;
- 30 run logs kept;
- a 5 s quit wait;
- a PC hash cache flush every 500 hashes;
- ≤4 hash workers, sized from `cpuPercentForLevel(settings.cpuLimit)`.

## Persistent files — `userData/sync/`

All are written through `store.js`'s `writeJsonAtomic`:
1. write `<name>.tmp`;
2. fsync it, then close it;
3. rename it over the target, retrying on EBUSY/EPERM/EACCES (5 tries with backoff);
4. otherwise throw.

Startup sweeps stale `.tmp` files.

**`sync-targets.json`.** Holds `{version, adbPath, targets[]}`. `version` increments on every op, and
an op may carry `expectVersion` for optimistic concurrency.

**`targets/<id>/header.json`.** kind, serial or folderRoot, canonicalRoot, profile, caseInsensitive,
and caps (lsV2, statV2, shellV2, sha256sum, findPrintf, statF). On a mismatch with the target, the
record is ignored for deletes and orphans until re-verified (rule 3).

**`targets/<id>/folders/<sha1(folderSlotKey)>.json`.** One shard per managed device folder (deviation 1):
- the folder fields: `{name, identityKey, pcFolder, verifiedAt, verifyMode, renameIntent?, files}`;
- `files` is keyed by the file's slot key. Each entry is
  `{name, size, sha256, devMtime, origin, prev?}`.

**`targets/<id>/selection.json`.** Maps an op id to `{sha, selected}` (rule 7: a newer PC version
is proposed again).

**`targets/<id>/find-sources.json`.** Holds rows of `{folder, query, include, state,
candidates[≤5], pick, pinnedUrl, skip, error}`.

**`targets/<id>/logs/<ts>.json`.** Keeps 30. Each holds planned totals, final status, and every
destructive action.

**`targets/<id>/covers/<sha1(folder)>.jpg`.** The cache file name is hashed, never built from the
folder name the renderer supplies (review #22).

**`prompted.json`.** Prompt marks for "prompted once per connection" (rule 10), so an app restart
doesn't re-prompt the same connection.
- The key is `serial#transportId#bootEpoch`, where `bootEpoch` = `Date.now() − os.uptime()·1000`,
  rounded to the minute.
- Why the boot epoch: the server's transport ids come from a counter that restarts at 1 in every
  server process (`transport.cpp:284-285`). With `serial#transportId` alone, a PC reboot hands the
  tablet the same small id, and the prompt never appears again (review #5).
- A mark is deleted when the monitor sees its device leave, or loses its tracking socket to a server
  restart.
- Residual risk, accepted: the adb server restarts while the app is closed, without a PC reboot, and
  hands the tablet the same id. One prompt is then skipped; the Sync tab still works.

**`pc-hash-cache.json`.** Main is the only writer.

`forget-record` deletes `targets/<id>/folders/` and `header.json`.

## IPC contract

Invoke channels use the `sync:` namespace, following `search:` and `app-update:` (`main.js:1845`).
One push channel, `sync-event`, is kebab-case like every other push channel. The full plan and the
selection stay in main (parent IPC section); the renderer gets summaries and fetches per-file
detail per series. **Every channel except `get-state` and `label-preview` answers `disabled` while
sync is off.**

| Channel | Request → response |
|---|---|
| `sync:get-state` | → `{enabled, settings, config, adb:{binary, serverVersion, error}, devices[], folderPresence, job, plans:{[targetId]: summary}, prompt, find, prewarm}` |
| `sync:config-op` | `{op, expectVersion?, …}` → `{ok, config}` or `{ok:false, code, error}`. Ops: `add-target`, `update-target`, `remove-target`, `forget-record`, `set-adb-path`, `add-alias`/`remove-alias`, `add-exclude`/`remove-exclude`, `set-selection-mode`, `ack-anomaly`/`unack-anomaly`, `ignore-suggestion`/`unignore-suggestion`. Identity-changing ops are refused while that target's job runs. `add-target`/`update-target` validate the root (containment rule above) |
| `sync:locate-adb` | `{rescan?}` → `{candidates:[{path, version, build, source}], resolved, serverVersion}` |
| `sync:list-devices` | → `{ok, devices:[{serial, state, model, product, transportId}]}`; may start the server (review #8) |
| `sync:browse-remote` | `{serial, path?}` → `{ok, path (canonical), parent, entries:[{name, isDir}], presets:[{label, path, exists}]}` |
| `sync:plan` | `{targetId, overrides?:{hashMode, deletePolicy, verifyFirst}}` → `{ok, runId}` or `{ok:false, error: busy / disabled / disconnected / library-missing / record-mismatch / device-listing-suspect}` |
| `sync:series-detail` | `{targetId, seriesKey}` → per-file rows `{opId, kind, name, label, unit, size, origin, preselected, selected, reason, loss, settling}`, plus anomalies and suggestions |
| `sync:set-selection` | `{targetId, changes:[{opId, selected}]}` or `{bulk:'covered-extras'/'split-parts'/'group', …}` → `{ok, totals, losses, massDelete:{required, count}, changedSeries}` |
| `sync:verify` | `{targetId, mode?: 'device-hash' / 'read-back' / 'adopt-size', folders?}` → `{ok, runId}` or `{ok:false, code:'needs-mode'}` when the device has no `sha256sum` and no mode was given |
| `sync:prune` / `sync:rename-device-folder` | → `{ok, runId}` |
| `sync:apply` | `{targetId, overrides, ackMassDelete, ackLosses:[opId]}` → `{ok, runId}` or `{ok:false, reason:'blocked', blocking, dropped}`. Main re-lists, re-plans and re-checks losses first (rule 6) |
| `sync:cancel` | → `{ok, wasRunning}` |
| `sync:prompt-response` | `{promptId, action: review / sync-now / not-now}` → `{ok}` |
| `sync:library-status` | → `{asOf, bySeries:{[folderPath]: [{targetId, state: synced / pending / absent, pending}]}}` |
| `sync:label-preview` | `{name, folderName, patterns?}` → `{unit, label, start?, end?}` or `{error}` |
| `sync:export-report` | `{targetId}` → `{ok, path}`. main shows the save dialog through an injected `showSaveDialog` |
| `sync:device-cover` | `{targetId, folder}` → `{ok, path}` (cached under `covers/` by hashed name) |
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

Line numbers are from this branch (`a27aaf4` content). All five rev 1 anchors that `sync-temp/README.md`
spot-checked match. Every hook call is `try { deviceSync?.x(…) } catch {}` on top of the facade's
own catch-all (review #2), so a sync defect can't break a path every user runs with sync off.

| File | Where | Edit |
|---|---|---|
| `main.js` | new block after the requires (after `:48`; the in-flight hunk is `:36-41`) | `require("./sync/service")`; `let deviceSync = null;`; `const gotSingleInstanceLock = app.requestSingleInstanceLock(); if (!gotSingleInstanceLock) app.quit();`; `app.on("second-instance", …)` restores and focuses `mainWindow`, or whichever window exists during first-run setup (`BrowserWindow.getAllWindows()[0]`) |
| `main.js` | the `whenReady` callback, first line (`:1880`) | `if (!gotSingleInstanceLock) return;` |
| `main.js` | close listener `:555-569` | Ask only while a sync **apply or prune** runs; a plan or verify is cancelled on quit without asking (review #13). The sync term is evaluated after the download term, inside try/catch. The early return becomes "no downloads and no sync blocker". Payload `{running: downloader?.getRunning?.() ?? [], sync}`; `running` is unchanged, so ConfirmQuitDialog keeps working |
| `main.js` | `onComplete` `:603-606` | After the two existing calls: `notifyLibraryChanged("download")`. A throw here would skip `downloader.js:910`'s `entry._resolveClose()`, making quit wait the full 5 s |
| `main.js` | metadata:update `:910`, scan-library `:965-1049`, delete-series `:1059`, save-series-meta `:1781` | `notifyLibraryChanged(reason)` after the handler's work |
| `main.js` | merge-series-folders `:1759` (the handler is itself in-flight) | `const r = await …; if (r?.ok && !args.dryRun) notifyLibraryChanged("merge"); return r;` |
| `main.js` | save-settings `:694-710` | `deviceSync?.applySettings(merged)` after `appUpdater.applySettings`, fire-and-forget with its own catch, so a sync defect never turns a successful save into a rejected IPC call. It starts or stops the monitor and pre-warm |
| `main.js` | reinstall-python `:1824-1842` | Refuse while a sync job runs. `await deviceSync?.cancelFindSources()` (killTree resolves on close, ≤5 s) before `deleteEnv`, whose `rmSync` would otherwise throw EBUSY on a dying `python.exe` (`setup.js:1450-1454`) |
| `main.js` | app-update:apply-now `:1862-1873`, window-all-closed `:1953-1961` | `await Promise.allSettled([downloader?.cancelAll(), deviceSync?.shutdown({timeoutMs: 5000})])`, run in parallel, with `applyNow()` / `app.quit()` in a `finally` |
| `main.js` | new `app.on("quit", …)` | `deviceSync?.shutdownNow()` (deviation 8). It covers `app.quit()` (`quit-app` `:1816`, the updater) and `app.exit()` (reinstall-python), neither of which emits `window-all-closed` |
| `main.js` | after `initDownloader()` `:1934`, before `createWindow()` | `try { deviceSync = initDeviceSync({ipcMain, send: sendToUI, userDataDir, getSettings: () => history.getSettings(), getLibraryRoot, getRunningDownloads, isCheckAllRunning: () => _updateCheck.isRunning(), isSearchRunning: () => searcher?.isRunning(), resolveSpawnPaths, extraEnv: buildPythonEnv(), onFocus: (cb) => app.on("browser-window-focus", cb), isFocused: () => !!BrowserWindow.getFocusedWindow(), getWindow: () => mainWindow, showSaveDialog}) } catch (e) { console.error(…) }`. Window-dependent deps read lazily, because the window doesn't exist yet (review #12) |
| `preload.js` | the `electronAPI` object | A `sync*` wrapper per channel, plus `onSyncEvent(cb)` returning an unsubscribe (the `onConfirmQuit` shape, `:86-90`) |
| `library.js` | a new line after `:1118` | `module.exports.KOMIKKU_CH_RE = KOMIKKU_CH_RE; // deviceSync` (review #23: `:1118` is itself in-flight) |
| `searcher.js` | spawn options; `cancel()` `:255-263`; close handler `:202-208` | (review #11) **(a)** Cancellation is tracked per process, in a `WeakSet` the close handler checks. A single flag would break runSearch's own cancel-previous path (`:120-124`): a new search would reset it, and the old process's late close would report "exited with code 1". **(b)** `cancel()` returns false when `proc.exitCode !== null` or `proc.signalCode !== null`, so a taskkill can't hit a recycled PID between `exit` and `close`. **(c)** It calls `killTree(proc)` and exposes `cancelAndWait()` for callers that must wait. **(d)** On non-Windows the spawn uses `detached: true`, so the group kill reaches Python's children. The close handler treats a tracked cancel as cancelled regardless of code and signal; taskkill gives code 1 and signal null |
| `proc-kill.js` (new) | — | As in the architecture table |

**Handoff obligations for the UI pass.** These go into STATE.md and the `service.js` header:
- render `payload.sync` in ConfirmQuitDialog. Today a sync-only close would say "0 downloads are
  still running" (`ConfirmQuitDialog.jsx:44,101`);
- mount `useDeviceSync` in App.jsx;
- choose which presets to expose;
- **add the sync keys to `get-settings` together with `DEFAULT_SETTINGS`**, plus the settings-twin
  test;
- the second-instance behavior means your memory `electron-app-local-e2e-testing` must say that dev
  and installed builds can't run at the same time. STATE.md carries the rewrite.

## Phases (stop and report after each)

**P0. Groundwork.** No product code; reported with P1.
- `sync-temp/STATE.md` (force-added): the phase, the decisions, the open decisions, and a defect
  ledger for your local session to fold into memory. The ledger covers the shipped defects found
  while exploring, all review-confirmed:
  - `delete-series` and `delete-temp` run `rm -rf` with no library-root containment
    (`main.js:1059-1068`, `:817-826`);
  - `reinstall-python` deletes python-env without cancelling downloads (`:1824-1842`);
  - save-settings always answers ok (`:709`) while `_saveJson` swallows errors;
  - `comix:login` spawns without `extraEnv` (`:937-941`).
- Copy the needed harnesses from `sync-temp/local-tools/` into `tools/`. They stay untracked there,
  because their tracked copies already live in `sync-temp/`.
- **Environment check**, recorded in STATE.md:
  - the Node version versus Electron's;
  - `npm ci` and `npm run build` in `UI-source`;
  - whether Electron launches here under xvfb;
  - that the existing `tools/_test_*.js` still pass on the WIP baseline.
- The Komikku spec copy is **already done**: `sync-temp/plans/komikkuspec.md`, byte-identical to
  `git show 1f17a20^:komikkuspec.md` (cmp in the S2 session).

**P1. Pure core.** `sync-settings`, `profiles`, `contract`, `naming`, `chapter-labels` (plus the
library.js export line), `analysis`, `provenance`, `planner`, `job-record`.
- Test: `tools/_test_device_sync_core.js`.
- **Stop:** green.

**P2. ADB wire client.** `adb/wire`, `adb/client`, `adb/locate`, and `tools/fake-adb-server.js`.

The fake server is backed by an in-memory filesystem, so both case modes are exact on any host. Its
fidelity is part of the deliverable. **A fake that is kinder than adbd hides exactly the bugs the
review found.** It must:
- implement SEND's unlink, `O_EXCL` and auto-mkdir;
- **FAIL immediately, drain DATA until DONE, unlink the partial, and close the session after every
  FAIL**;
- reject paths over 1,024 bytes, and split SEND specs at the last comma;
- answer LIST of a missing or non-directory path with DONE only;
- send full-size DONE records, `.`/`..` entries, and STA2 `error` fields;
- deliver track frames both before and after the EOF on an unplug; send an empty `0000` frame;
  report a `(no serial number)` device.

It also injects:
- an unplug after N bytes;
- a FAIL per path pattern;
- ENOSPC and EROFS;
- locked storage (the root STA2s with an error, listings come back empty);
- a failed unlink, which leaves a reopen without `O_TRUNC`;
- a missing `ls_v2`, `stat_v2` or `shell_v2`;
- a FAIL on `host:tport:`;
- case-insensitive lookups;
- no `sha256sum` and no `find -printf`;
- throttled throughput.

Test: `tools/_test_device_sync_adb.js`. **Stop:** green.

**P3. Transports and execution.** `store` (shards), `hash-pool`, `pc-inventory`, `transports`,
`executor`.
- Test: `tools/_test_device_sync_exec.js`. Also measure the cost of the per-file shard fsync
  (deviation 1).
- **Stop:** green.

**P4. Service and integration.**
- `monitor`, `find-sources`, `service`, `proc-kill` plus the searcher fix.
- The main.js edits, including the single-instance lock, and the preload edits.
- `useDeviceSync.js`.
- Tests: `_test_device_sync_monitor.js`, `_test_device_sync_service.js`,
  `_test_device_sync_contract.js`, `_test_device_sync_hook.js`, `_test_searcher_cancel.js`,
  `_test_device_sync_main_isolation.js`.
- `node --check` on main.js and preload.js, then `npm run build`. **Vite never compiles
  `electron/main.js`**, so without these checks main.js would first run in P5 (review #2).
- **Dev-app smoke with sync off.** It runs here if P0 found Electron launchable, otherwise first
  thing on your PC. It checks that:
  - settings load with 0 changed, and Save round-trips;
  - the close-with-download dialog is unchanged, and quit time is unchanged;
  - no `userData/sync/` folder appears;
  - a second launch focuses the first window.
- **Stop:** a tools script drives the service end to end through a fake `ipcMain`, against
  FolderTransport and the fake adb server.

**P5. Packaged smoke and live tablet.** This needs your PC.
- **Isolate the test first.** Check whether Chromium's `--user-data-dir` moves Electron's `userData`
  for the unpacked exe.
  - If it does, use it.
  - If not, add a 3-line `AIO_USER_DATA_DIR` hook to main.js, **asking you first**.
  - Either way, back up `%APPDATA%\aio-downloader-ui\*.json` first; the memory's shared-userData
    trap applies, and so does the single-instance lock (close the installed app first).
- **Packaged smoke.** Run `npx electron-builder --dir`, then launch the unpacked exe with a temp
  library (`AIO_OUTPUT_DIR`), sync enabled and a folder target.
  - The exe is a GUI app, so it **writes a marker file** under `userData/sync/logs/` instead of
    relying on stdout (review #25).
  - The marker must show the pre-warm from the eval'd workers inside asar, then a clean quit.
- **Live tablet, only with your OK and your hands on the cable.** `tools/_live_device_sync.js` runs
  on the scratch root `/storage/emulated/0/Download/aio-sync-test/` with three series, including
  the SPY×FAMILY and Hell's Paradise name shapes. It measures:
  - the device features (`ls_v2`, `stat_v2`, `shell_v2`, `sendrecv_v2`) and the toybox
    capabilities;
  - the case-insensitivity probe;
  - what an interrupted push leaves (expect nothing, since adbd unlinks the partial) and what an
    interrupted update leaves (expect an empty slot);
  - **the device mtime at OKAY, after the listing, after 60 s and after a reconnect** (review #4);
  - **a listing after a reboot, before the first unlock** (review #3);
  - throughput versus adb.exe on the same files, and per-file acks versus a pipelined run;
  - byte-exact UTF-8 names, and `realpath /sdcard`;
  - an unplug mid-run: abort once, then resume;
  - **Komikku reads a synced `local/` with `.nomedia`** (the parent's check, restored; review #25).
- **Search timing.** Measure the per-query time split on 5 real find-sources queries. Only if the
  probe phase dominates, propose `AIO_SEARCH_PROBE_DEADLINE`. That would touch the in-flight
  `search_orchestrator.py`, so **ask first**.
- **Stop.**

**P6. Docs and handoff.**
- The IPC contract lives in `contract.js` typedefs plus the `service.js` header, with the handoff
  obligations listed above.
- CLAUDE.md gets a pointer row and invariants:
  - the socket transport and the session lifecycle;
  - push-in-place semantics;
  - provenance;
  - the single-instance lock.
- The repo CLAUDE.md is git-excluded on your PC, so the edits land in
  `sync-temp/context/CLAUDE.project.md`, and your local session copies them back.
- `android/PARITY.md` gets N/A-DESKTOP-ONLY rows for the 7 global sync settings and every `sync:*`
  channel (22 invoke channels plus `sync-event`).
- STATE.md is rewritten at the phase boundary.
- A forced re-read of every changed file, then the report. The ship decision follows.

## Verification

**`_test_device_sync_core.js`**
- **Naming.** Sanitize, hid-strip, `slotKey`, `compactKey`, the 255-byte segment limit.
- **Labels.**
  - `5.10` ≠ `5.1` and `005` = `5`;
  - `~` legacy names, ranges, device conventions, volumes;
  - recognition parity with `library.js:extractChaptersFromFiles`.
- **Settings.** Resolver defaults and invalid-value fallback.
- **Profiles.** Fill-in of null fields.
- **Provenance matrix.** pushed / adopted / adopted-size / partial / foreign / pending /
  changed-on-device. Every pending-resolution row: absent, pushed, restore `prev`, partial, RECV
  failure.
- **Per-slot planning.** In sync, update, replace (unticked group), kept name, rename toggle, push,
  `settling`.
- **Preselection.** Guarded vs add-only; every rule-5 case; an `adopted-size` delete is never
  pre-selected.
- **Losses.** Recomputed on toggle; the mass-delete threshold.
- **Rule 6.** The re-plan at apply time: changed or vanished ops are dropped, and a new loss blocks.
- **Rule 10.** "Sync now" eligibility, and one prompt covering several targets on one device.
- **Rule 12.** The record is cleared when a target's device, root or profile changes.
- **Rule 13.** A series that just finished downloading never shows "synced".
- **Selection persistence.** Keyed by (op id, sha).
- **Adoption ladder.** Identity, content ≥90%, name, weak, on sanitized fixtures shaped like the
  old aliases.
- **Collisions and binding.** Same vs different identity; sticky binding across a retitle; held
  excludes.
- **Refusals.**
  - an empty or missing library root;
  - a record-header mismatch;
  - a folder-target root inside or containing the library root or userData.
- **Job record.** Stale runId drop; coalescing; the auto-plan queue, including the drop on device
  removal.

**`_test_device_sync_adb.js`**
- **Golden-byte codecs** for every packet type, at the AOSP struct sizes (STA2 72, DNT2 76, DENT 20
  bytes, including DONE). They include 64-bit sizes and byte-length framing with `×` and `’`.
- Frames split at every byte offset; an empty `0000` frame.
- **`devices -l`.** Padding, `transport_id`, the `(no serial number)` serial.
- shell-v2 demux, exit codes, CloseStdin sent; the legacy `shell:` CRLF path.
- **Session lifecycle.**
  - A FAIL on file 2 of 5: files 3 to 5 still land, the budget shows 1, and the session is
    reopened.
  - An early FAIL mid-DATA stops the stream.
  - A missing `details.json` doesn't kill the reads queued behind it.
- **Quiet failures.**
  - A DONE-only listing of a missing directory is not trusted.
  - `.`, `..` and error entries are skipped.
  - The STA2 `error` field drives the case probe and `exists`.
  - Locked storage makes the plan refuse with `device-listing-suspect`.
- **Errors.**
  - Classification uses the real `device 'A06B4A372090333' not found` text.
  - ENOSPC and EROFS abort the run.
  - ECONNRESET is handled as EOF, with the ~1 s recheck.
  - The same serial with a new transport id is a removal plus an add.
- **Names.**
  - SPY×FAMILY and `Hell’s Paradise` names land byte-exact.
  - A comma in a name survives the last-comma split.
  - A 1,019-byte path is refused before it is sent.
  - A name that isn't valid UTF-8 is never planned.
- **Cancel mid-SEND.** The socket is destroyed and the fake adbd unlinks the partial.
- **Fallbacks.** v1; `tport` → `transport`; tracking → polling after 3 failures.
- **Server.** `start-server` is called only when the server is unreachable, also for explicit
  actions with no target yet. `kill-server` is never sent.

**`_test_device_sync_exec.js`**
- An interrupted in-place update leaves an empty slot. The entry is dropped and the re-plan
  re-pushes.
- **Shard crash windows.** Each one recovers correctly at the next plan:
  - a kill between the `pending` write and the SEND;
  - a kill between OKAY and the `pushed` write;
  - a leftover `.tmp`;
  - a zero-length or unparsable shard, which leaves that folder unverified.
- A case-only rename killed midway is finished or reverted from `renameIntent`.
- The delete gate: a failed replacement keeps its delete.
- The slot guard: a case-only rename on a case-insensitive target never deletes the new file.
- Device loss aborts once, not per series.
- The error budget.
- Cancel mid-file.
- **Guards.** Re-stat, running-download skip, the listing sanity check (per folder and for the
  whole root).
- **Verify.**
  - managed folders only; rc-checked;
  - a failure keeps the entries and never wipes them on a quiet failure;
  - all three modes;
  - the scaled timeout.
- Prune: `rmdir` only if empty.
- **Free space per transport** (review #16).
  - adb: the sum of `max(0, new − old)`.
  - FolderTransport: additionally the largest new file, because its temp sits beside the old copy.
- A hash-while-push mismatch: the observed sha lands in the record and the PC hash cache, and the
  next plan is stable.
- FolderTransport: temp + rename, its leftover sweep, and the single-flight presence check.

**Monitor, service, contract, hook, searcher and isolation tests**
- **Monitor.**
  - Frames; backoff; the polling fallback.
  - The prompt state machine: focus, refocus, attached at startup, app restart, withdraw on
    disconnect.
  - **The prompt appears again after a server restart that reuses the transport id** (an injected
    boot epoch), and a mark clears on disconnect.
- **Service E2E.**
  - Disabled means inert: no socket, no writes under `userData/sync`, and **every** handler except
    the two named answers `disabled`.
  - Config ops: validation (including root containment), versioning, refusal during a job.
  - The main flow: plan → selection → apply → modify / rename / delete on the PC → re-plan (kept
    name) → both delete policies → verify → prune → library root unplugged (refusal).
  - Quit: `shutdown()` finishes within 5 s; `shutdownNow()` is synchronous and leaves a consistent
    record.
  - find-sources with a fake Searcher.
- **Contract.** Preload `sync:*` literals equal `contract.CHANNELS`; the hook's event kinds equal
  `EVENT_KINDS`.
- **Hook.** Run against the minimal hook runtime copied from `_test_update_check_hook.js`, which
  strips exactly one React import line (`:42-47`). It covers buffering before the snapshot,
  snapshot adoption, and a stale runId.
- **Searcher.**
  - A node child that spawns a grandchild: cancel kills both, and the rejection has
    `cancelled: true`.
  - Cancel, then an immediate new search: the old promise is cancelled, the new one resolves.
  - Cancel after a natural exit returns false.
  - `cancelAndWait()` resolves on close.
- **Main isolation** (`_test_device_sync_main_isolation.js`). It loads main.js under a stub
  `electron` module, with a `deviceSync` whose every method throws. It then checks that
  get-settings, save-settings, the close listener, onComplete, window-all-closed and the `quit` hook
  all behave as they do without sync. If main.js's top level can't run under a stub without edits,
  this test is dropped and the dev-app smoke carries the check; the P4 report would say so.

**Hostile names.** `'`, `$`, backtick, `|`, `,`, `DocumentsX`, `..`, newline, NUL, invalid UTF-8,
names over 255 bytes and paths over 1,018 bytes are rejected or safely quoted, in both
`validatePath` and `shq`.

**Regression.**
- The CLAUDE.md suite. No Python changes are planned, so items 1-6 and 8 are sanity checks and
  item 7 (`npm run build`) is the real one.
- Re-run the existing `tools/_test_*.js`, since main.js and preload change.

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
   - Pick: leave its inline copy alone (in-flight file) and switch it to `proc-kill.js` at ship
     time.
   - Otherwise two taskkill spellings live on.
4. **Push-in-place window.** An interrupted update or replace leaves that chapter missing on the
   tablet until the next sync, and Komikku can see a partly written file during a push. Accepted
   with your answer; recorded as a decision, not a defect.
5. **Older devices.** A device without `ls_v2`/`stat_v2` lists through the shell fallback. The
   android-port memory's test tablet runs Android 15, which has both. Whether that is the sync
   tablet (serial `A06B4A372090333`) is unverified, and P5 reads its feature list. Until then the
   fallback is exercised only by the fake server.
6. **Mid-phase checkpoint commits on this branch.**
   - Pick: commit and push only at each phase's stop point, after its tests. That follows your
     standing "never mid-fix" rule.
   - Otherwise: also allow `wip(sync):` checkpoint commits mid-phase. A container reset could then
     never lose half a phase, and the branch never ships, so the rule's reason (a clean PR) doesn't
     apply here.
7. **Sharded record instead of the journal** (deviation 1).
   - Pick: shards.
   - Otherwise: the journal, with all five of review #6's fixes plus a test for each crash window.
8. **Per-file push acknowledgements.**
   - Pick: one OKAY per file; P5 measures.
   - Otherwise: pipeline small files with deferred acks, as the adb CLI does. That is faster for
     many small files, but one FAIL then fails the whole pipeline.
9. **Prompt-mark residual** (`prompted.json`).
   - Pick: accept one possibly skipped prompt after an adb server restart while the app was closed.
   - Otherwise: drop persistence, so every app restart re-prompts a still-connected device.

## Adversarial review disposition (review of rev 1, 2026-10-01)

Checked this session against `sync-temp/sessions/S2-non-ui-plan-2026-09-30/agents/04-…`, the code
on this branch, and AOSP `packages/modules/adb` `main` (commit `1cf2f01`). Verdicts:
- **Confirmed**: the claim holds, and so does its fix.
- **Partly**: the claim holds, but its evidence or fix is partly wrong.
- **Changed fix**: the problem is real, and a different fix is better.

| # | Finding | Verdict | Evidence checked | Where it landed |
|---|---|---|---|---|
| 1 | A FAIL ends the sync session | Confirmed | `file_sync_service.cpp:803-866` (every failing branch returns false), `:639-642` (RECV of a missing file), `:812-815` (path > 1,024) | Session lifecycle |
| 2 | "Inert" isn't failure-isolated; main.js first runs in P5 | Confirmed; the get-settings chain is moot | `downloader.js:908-910` (`_onComplete` before `_resolveClose`); `useDownloader.js:349` has no catch; `main.js:1953-1961`. Rev 2 adds nothing to get-settings (#9) | Integration edits (try/catch everywhere, a never-throw facade, `allSettled`); P4 checks |
| 3 | LIST/STA2 fail quietly; DONE is full-size | Confirmed | `:207-208`, `:162-191`, `:210-246`; struct sizes in `file_sync_protocol.h` | Quiet failures; fake fidelity |
| 4 | devMtime must come from the listing | Partly | "OKAY before the file handle closes" is wrong: the fd closes before OKAY, and only `lutimes` follows it (`:419-421`, `:552-557`); a same-session STA2 runs after `lutimes`. The fix stands for the push-time observation (`sync_to_tablet.py:16-17`, read) and for precision | devMtime section; P5 measurement |
| 5 | `serial#transportId` suppresses prompts | Confirmed; the fix is extended | `transport.cpp:284-285`: a static counter starting at 1 per server process. A boot epoch alone misses a server restart without a reboot, so marks also clear on disconnect and on server loss | `prompted.json`; open decision 9 |
| 6 | The journal design is incomplete | Changed fix | The analysis is sound; the journal is replaced by per-folder shards with fsync'd atomic rewrites | Deviation 1; shard crash tests |
| 7 | Two instances share userData/sync | Confirmed | No `requestSingleInstanceLock` in `electron/*.js` (rg) | Your decision: app-wide lock |
| 8 | The first adb target can't be created | Confirmed | The rev 1 text | When adb.exe still runs |
| 9 | get-settings spread persists undecided defaults | Confirmed | `SettingsTab.jsx:795-802`, `:913-916`; `history.js:229`, `:58-67` | Settings section; handoff obligation |
| 10 | Weak "adopt by size" was dropped | Confirmed | Parent rule 8; rev 1's origin list | Your decision: RECV + `adopted-size` |
| 11 | The searcher cancel fix is incomplete | Confirmed | `searcher.js:120-124`, `:202-213`, `:255-263`; `setup.js:1450-1454` | searcher.js row; proc-kill |
| 12 | Missing deps; lazy window access | Confirmed (the profile-lock aside was not checked; not load-bearing) | `update-check-record.js:91`, `main.js:1441` | initDeviceSync row |
| 13 | Quit coverage gaps | Changed fix | `main.js:1816` (`app.quit()`), `:1832` (`quit` is emitted on `app.exit`); no before-quit/will-quit handlers exist (rg) | Deviation 8; close-listener row |
| 14 | A hash mismatch must update the PC cache | Confirmed | Logic | Deviation 2 |
| 15 | Pending needs more outcomes | Confirmed | `:563-576` ("missing ," / "bad mode" FAIL before `send_impl`'s unlink) | Pending-resolution table; `renameIntent` |
| 16 | Free space depends on the transport | Confirmed | Logic | `freeSpaceNeeded`; exec test |
| 17 | Error classification | Confirmed | Logic, plus the FAIL texts the review cites (not re-checked against the server's source) | Error table |
| 18 | Wire-level details | Confirmed | `:563`; `client/file_sync_client.cpp:585`; `commandline.cpp:546`; `transport.cpp:1407-1416`; `adb.cpp:1303-1345` | Framing details; fallbacks |
| 19 | Verify timeout | Confirmed | Logic (`sha256sum` is silent per file) | Verify budget |
| 20 | Folder-target containment; presence threads | Confirmed | Logic | `root` field; transports row |
| 21 | Re-stat age vs debounce | Confirmed | 30 s vs 10 s in rev 1 | Deviation 9 |
| 22 | Cover cache path | Confirmed | Logic | Hashed cover names |
| 23 | Editing in-flight files | Confirmed | `git show d1ae7d6:…/library.js` export at `:923`; WIP at `:1118`. The baseline is now commit `a27aaf4` | Branch protocol; library.js row |
| 24 | Test gaps | Confirmed | `_test_update_check_hook.js:42-47` (one-import strip) | Verification lists |
| 25 | P5 gaps | Confirmed | The parent plan's Phase 6 list | P5 |

## Figures

| Figure | Meaning | Source |
|---|---|---|
| 36 M / 24 untracked files in `a27aaf4`; 455 / 197 / 56 changed lines in main.js / library.js / preload.js | The in-flight work this pass must not disturb; rev 1's diff sizes still hold | doc: `sync-temp/README.md` (file counts); read: `git diff --stat d1ae7d6 a27aaf4` (line counts) |
| `:923` vs `:1118` | library.js export line before vs inside the WIP commit | read: `git show d1ae7d6:…/library.js`, `rg` on the branch |
| 1,024 B; 1,018 B | adbd's sync path limit; the remote-path cap once `,33188` is appended | read: `file_sync_service.cpp:812`; derived |
| 72 / 76 / 20 B | STA2 record; DNT2 entry (and the LIS2 DONE); DENT entry (and the LIST DONE) | read: `file_sync_protocol.h`, summed |
| 64 KiB | Maximum DATA chunk | read: `SYNC_DATA_MAX` in `file_sync_protocol.h` |
| transport id starts at 1 | Why `serial#transportId` alone repeats after a server restart | read: `transport.cpp:284-285` |
| 1.0.41 on all 3 local adb binaries | No server-version fight between local tools | recall: rev 1 (`adb version` ×3 on your PC) |
| 107 lines (106 `not found` + 1 EOF tail) | The cascade the device-lost abort prevents | recall: rev 1 (grep of `sync-log-20260706-221724.json`) |
| 3,371,594 B record, 4,545,524 B hash cache | Why whole-record rewrites per file were rejected | read: `ls -la` of the CompareManga state files in `CompareManga.zip` |
| ~250 KB | Estimated largest shard (One Piece, 1,197 chapters × ~200 B per entry) | derived; the 1,197 is from the parent plan (doc) |
| 3,072 B shell cap vs 4 KiB legacy payload | Keeps chunked commands valid on every adbd | recall: adb `MAX_PAYLOAD_V1`, not re-checked; the review called it conservative |
| 22 invoke channels + 1 event channel | The IPC surface this pass ships | derived: the contract table |
| 30 s settling / re-stat, 10 s debounce, 60 s idle, 8 MiB/s Verify rate, 1 s recheck, 5 s polling, 5 s quit wait, 1 GiB reserve, ≤10 events/s, ≤4 workers, 500-hash flush | Engine constants | this plan's choices (the 8 MiB/s is a deliberately low floor for slow flash, not a measurement) |
