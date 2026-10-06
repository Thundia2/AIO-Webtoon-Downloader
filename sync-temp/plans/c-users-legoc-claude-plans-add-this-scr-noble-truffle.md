# Device Sync — non-UI implementation plan

**Status: rev 4, approved 2026-10-06 ("Start with the plan"), cloud session on
`wip/device-sync-handoff`. P0, P1 and P2 are done; P3 waits for your go-ahead.**
- Rev 1 (2026-09-30) got an adversarial review on 2026-10-01: 2 critical, 9 major, 14 minor.
  Rev 2 checked every finding against the code and AOSP and folded in the confirmed ones. Where the
  review was wrong or a better fix exists, it says so.
- Rev 2's new designs got a second adversarial review the same day: 0 critical, 9 major, 11 minor.
  Rev 3 checks and folds those in.
- Rev 4 folds in your answers to open decisions 6, 10 and 11 (the rev 4 rows of the Decisions
  table). Decision 10 reverses rev 3's pick, so its new design got its own review (the third
  disposition table).
- P1 corrected the corrupt-shard rule (deviation 1), recorded the calls made while coding the
  planner (deviation 10), and raised open decisions 12 and 13.
- P2 recorded the calls made while coding the adb layer (deviation 11), moved the adb-test
  items that need later modules to their phases ("Moved at P2" in Verification), and added a P5
  measurement of the wait between a push's last DATA and its OKAY.
- The three disposition tables are the last section.
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
- Every IPC handler is registered. All of them answer `{ok:false, code:'disabled'}` except
  `sync:get-state`, `sync:label-preview` and the two cancel channels (see the IPC contract). That
  includes `sync:config-op` (it writes files), `sync:locate-adb` (it spawns adb.exe) and
  `sync:find-sources:start` (it spawns Python).
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
| rev 4 | Commits (open decision 6) | **Commit and push at each phase stop**, after its tests are green | No mid-phase checkpoints. You first asked for one commit at the end, then chose this once the container-reclaim risk was on the table |
| rev 4 | A bound folder deleted on the device (open decision 10) | **Re-push it, ticked; you choose the name, defaulting to the old device folder name** | Reverses rev 3's pick. A folder counts as gone when a trusted listing lacks it and a STA2 returns ENOENT. The series then plans as new, with its pushes pre-selected under rule 2's guard (plus a `record` match for tablet-side renames), a mass-gone acknowledgment, and a sticky decline. The shard is rewritten only when the re-push starts. The name choice is plan data plus one selection op; drawing it is the UI pass's job. See "Provenance" |
| rev 4 | Large `pending` files (open decision 11) | **RECV at every size** | Unchanged from rev 3's pick: a pending slot is always resolved by reading it back and hashing on the PC |

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
     - each managed device folder gets its own file, `targets/<id>/folders/<shardId>.json`;
     - a change rewrites only that folder's file, atomically (write a tmp, fsync it, rename);
     - a typical series shard is tens of KB, and the largest (One Piece, 1,197 chapters) is
       estimated at about 250 KB.
   - **Shards are named by a stable random id, not by the folder name** (second review #4).
     - The device folder name lives inside the shard, and a plan loads every shard into a
       name → shard map.
     - So a folder rename rewrites one field, and a re-probed `caseInsensitive` changes nothing on
       disk. A slot key depends on that measured flag, so a name-hashed file would move under a
       flipped probe and orphan its old copy.
   - **One `recordEpoch` ties the record together** (second review #5).
     - The epoch is a random value. `header.json`, every shard and `selection.json` carry it, and a
       file with a different epoch is ignored and garbage-collected.
     - Forget-record, and rule 12's clear on a device, root or profile change, become a single
       atomic header write with a new epoch, followed by lazy deletion.
     - A half-finished `rmSync` (antivirus EBUSY) can therefore never leave old shards that a later
       Verify would trust again.
   - **Intent.** Before a push, the file's entry becomes `pending` and carries `prev`, the entry it
     replaces. After OKAY it becomes `pushed`. That is two shard writes per file.
   - **Every rename carries the same intent** (second review #4). This covers a folder rename,
     rename-to-match, and a case-only rename through a temp name:
     1. write `renameIntent {from, via?, to}` into the shard;
     2. STA2 the destination and require ENOENT. A shell `mv A B` onto an existing B moves A *into*
        B;
     3. run the `mv`;
     4. rewrite the shard once, atomically.

     The next plan resolves a leftover intent from the parent listing's exact names (see
     "Provenance"; a STA2 can't tell case variants apart on case-insensitive storage).
   - **Write mechanics** (second review #6).
     - Writes go through an async single-flight queue per path that coalesces to the latest
       content, with unique tmp names `<name>.<pid>.<seq>.tmp`. Overlapping writes can therefore
       never interleave in one tmp file.
     - A separate synchronous writer is used only by `shutdownNow()`, after it abandons the queue.
     - A failed write throws `record-write-failed`, which aborts the run. **A failed `pending`
       write stops that file's SEND**: a push without recorded intent would break this deviation's
       guarantee.
   - **Durability, stated exactly** (second review #10). libuv renames with `MoveFileExW(…,
     MOVEFILE_REPLACE_EXISTING)` only, with no write-through (`src/win/fs.c:2341`), and Node can't
     fsync a directory on Windows.
     - So a shard write is **durable across a process kill, and atomic but not durable across an OS
       crash**: after a power loss, the previous shard may come back.
     - That outcome is safe. The rewritten slot then fails its (size, devMtime) check, reads as
       foreign, and is never pre-selected for a delete.
     - For the same reason a `.bak` buys nothing: the old or the new shard always survives, and
       either is safe. On POSIX the directory is fsync'd too.
   - **A shard that fails to parse is set aside, and its folder plans as unbound** (corrected in
     P1). A random shard id can't say which folder a corrupt file described.
     - When the series' derived name equals the folder, the folder is managed by name and verified
       before its ops are planned (rule 3).
     - Otherwise the adoption ladder offers Link (identity or content), with the series' pushes
       unticked until then.
     - Either way nothing in that folder pre-selects a delete, because its files are unverified.
     - Residual: a folder bound under a non-derived name (an alias or a retitle) whose old-script
       file names match no PC name and whose `details.json` is missing gets no strong match. Its
       series then plans as new, with a second folder pre-selected. That needs a corrupt shard,
       which atomic writes make a disk-corruption event.
   - **A folder counts as gone only** when it is absent from a trusted root listing **and** a
     STA2 of the folder returns ENOENT. Its shard is kept until a re-push starts; "Provenance" says
     how a gone folder plans.
   - The PC hash cache stays one file, and **main is its only writer**: hash workers return
     results and never touch the disk. That removes review #6b's compaction race. It is flushed
     every 500 hashes, at each job end and in `shutdownNow()`. Losing it costs a re-hash, never a
     wrong answer.
   - **Cost.** P3 builds the batching path, but the fsync cost is measured on your PC (NTFS), since
     a Linux container's numbers can't decide it. If two fsyncs per file add more than 5% to a
     transfer of typical chapter files, intent is batched per N files. That is still safe: an
     unresolved `pending` resolves through RECV.
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
   - Under deviation 1, every record change is on disk when it happens. What else waits in memory
     is written at fixed points (second review #12):
     - the run log before and after each destructive batch, not only at job end;
     - `selection.json` on every `sync:set-selection`;
     - `find-sources.json` per row;
     - the PC hash cache at each job end and in `shutdownNow()`.
   - So `shutdownNow()` is synchronous and idempotent (it runs again after `window-all-closed`'s
     awaited `shutdown()`). Its steps:
     1. **First**, while the root PID is still alive, spawn the find-sources taskkill with
        `{detached: true, stdio: "ignore", windowsHide: true}` plus `unref()`. libuv puts every
        non-detached child in a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
        (`src/win/process.c:93-96`, `:1149-1152`). A plain spawn would therefore die with Electron
        (second review #11).
     2. Destroy the sockets; adbd then unlinks the partial file.
     3. Stop the hash workers.
     4. Write the job's cancelled status and the PC hash cache through the synchronous writer.
   - It runs from the `quit` event. `app.exit()` emits `quit` too: main.js's own comment at :1832
     says so, and the second review confirmed it in Electron's source (`App::OnQuit`). That covers
     the `app.quit()` paths that never emit `window-all-closed`: `quit-app` at :1816, the updater,
     macOS Cmd+Q.
   - **Exits it can't cover:** logoff or OS shutdown, a crash, a Task Manager kill. The record is
     still consistent by deviation 1. Only a find-sources Python tree may outlive the app, as a
     download's can today.
   - This replaces the review's "prevent `will-quit` once, await, quit again" (#13), which would
     add a second quit state machine next to `quitConfirmed`.
   - The awaited `shutdown()` still runs alongside `cancelAll()` in `window-all-closed` and
     `apply-now`, so a normal close waits for the find-sources child.
9. **Files younger than 30 s plan as `settling`** (review #21).
   - They are counted but not offered, and the service schedules one re-plan when the youngest one
     settles.
   - The 10 s re-plan debounce stays. Apply's 30 s re-stat age would otherwise skip the newest
     chapters right after planning them.
10. **Calls made while coding the planner (P1).** Each is pinned by a test in
    `tools/_test_device_sync_core.js`.
    - **Two-pass inputs.** `buildPlan` reports `needsVerify` (managed folders without a verified
      shard) and `needsProbe` (gone-folder candidate names not yet STA2'd). The service does that
      I/O and plans again. A name is `available` only with a STA2 ENOENT in `opts.nameProbe`.
    - **Every live shard's name stays reserved until Forget**, not only a gone series'
      `previous`. A new series taking an orphaned shard's name would leave two shards naming one
      folder once its own shard is written.
    - **A held series keeps its existing device folder.** An excluded, image-only or empty series
      without a shard claims the unbound device folder of its derived name. Otherwise another
      series resolving to that name would verify it and push into it.
    - **A fork is the same identity, whatever the names.** Unbound members lose to a bound member,
      or to the richest; the losers are held with `merge-in-library`. Parent rule 1 lists forks
      under name collisions; under `as-is` naming the two folders don't collide, and both would
      otherwise land on the device.
    - **Losses beyond chapter labels.** Deleting a volume, whole or unknown file is always a loss;
      a range is covered only when every integer in it stays carried (spans up to 5,000).
    - **Thresholds.** "With ≥10" in the mass-delete and mass-repush rules is the denominator: the
      series' device chapter files, and the target's bound folders of included series.
    - **Kept names need hash evidence.** Only `pushed` and `adopted` copies satisfy a PC file
      under another name; an `adopted-size` sha is an assumption.
    - **The slot guard in plan form.** A device file at the slot of any PC file of the series,
      mirrored or not, is never offered for delete.
    - **`name-invalid`.** A PC folder name with nothing left after sanitizing holds its series with
      an error anomaly of that kind; `name-too-long` covers the 255-byte case.
    - **Outputs for the service:** `entryFixes` (a `pushed` entry adopting a listing's devMtime)
      and `shardNameFixes` (a bound folder's case drifted on the device) are persisted by
      `service.js`; the planner itself writes nothing.
11. **Calls made while coding the adb layer (P2).** Each is pinned by a test in
    `tools/_test_device_sync_adb.js`.
    - **The retry and the charges live in `SyncSession`.** Each operation charges a
      `session-closed` and retries it once on a fresh session. Every thrown `AdbError` carries
      `.charges`, the operation's total, so a drop on every SEND of one path costs 2 per file;
      `onCharge` reports an attempt the retry rescued. The executor only sums `.charges` (P3).
    - **Charges by kind.** A received FAIL is `remote-fail`, charged 1; ENOSPC and EROFS become
      `no-space` and `read-only`, charged 0 (they abort the run). The host-FAIL kinds
      (`device-lost`, `unauthorized`, `connecting`, `offline`) are never charged.
    - **`list` returns `{entries, errored}`.** LIS2 entries whose lstat failed come back apart,
      never as files.
    - **A v1 STAT failure reports `error: -1`.** Mode 0 says only that the lstat failed, not why.
    - **Server address as the adb CLI resolves it:** `ADB_SERVER_SOCKET`, else
      `ANDROID_ADB_SERVER_ADDRESS` + `ANDROID_ADB_SERVER_PORT`, else 5037; `127.0.0.1` rather
      than `localhost`, which can resolve to `::1` first on Windows.
    - **`start-server` runs with cwd = the adb binary's folder.** The server inherits its
      starting directory and outlives the app, so the install folder would stay open against an
      update or uninstall.
    - **The end-of-file drain gets an allowance on the OKAY wait.** Under `delayed_ack` adbd
      grants the server 32 MiB of send window at OPEN (`adb.h:38`, `adb.cpp:540-544`) and acks
      only what it has flushed (`sockets.cpp:148-150`). So after the last DATA the device can
      still be writing up to 32 MiB plus the loopback buffers, and nothing the client sees moves.
      The OKAY wait's idle budget grows by `min(sent, 40 MiB)` at a 1 MiB/s floor (up to 40 s
      on top of the 60 s). A device slower than 1 MiB/s on that tail still hits the watchdog;
      P5 measures the real wait.
    - **Backpressure is asserted as bounded in-flight bytes** (under 24 MiB across a 256 MiB
      push), not as a heap cap. Buffers live outside the V8 heap, so a heap cap would not catch
      unbounded buffering.
    - **Caller code is raced against the socket's end.** The PC source's open and reads, and a
      pull's sink, are awaited through a guard, so a cancel or the watchdog ends a stalled
      source too. During a push every wait races the status: the source, each DATA write and
      the DONE write. So an early FAIL (ENOSPC) is reported at once, and a FAIL that lands while
      a write waits behind adbd's discard of the DATA in flight stays the result instead of
      turning into a watchdog `timeout`. The races use a one-shot `Latch` whose waiters leave
      when their own work settles; a `Promise.race` against one long-lived promise per chunk
      piles up a reaction per call until that promise settles.
    - **A re-attached device is caught two ways:** at the recheck after an EOF, and at the next
      bind, where `host:tport:` returns a transport id other than the pinned one. The bind check
      runs **before the service is sent**, because adbd starts a shell command (`rm`, `mv`) as
      soon as its service opens. An old server without `tport` gets the pin checked against
      `devices -l` before `host:transport:`; a replug between the two requests can still slip
      through there. `host:transport-id:` would close it but isn't used: ids restart from 1
      after a server restart, so a stale pin could bind a different device.
    - **Nothing that refuses an open runs after the service is sent.** An abort during the bind
      is `cancelled` with no service written. Every `AdbError` carries `sent`: `false` means
      the command never reached the device, `true` means it may have run (the caller re-reads
      the device before trusting it), `null` means not applicable. A bind that never answers
      is `timeout`, not `server-unavailable`.
    - **`SyncSession.destroy()` is terminal.** It aborts the open socket, so the operation in
      flight ends as `cancelled` (no retry, no charge), a bind in flight drops its fresh socket
      instead of adopting it, and every later operation is `cancelled`.
    - **Shell.** shell v2 when the device advertises it. The legacy `shell:` path takes the exit
      code from a per-call sentinel echoed after a **newline**, not `; `: mksh rejects `;;` as a
      syntax error and runs nothing, so a command ending in `;` would lose its exit code. CRLF is
      normalized. A service string over 3,072 bytes is a RangeError, so `transports.js` chunks
      its `rm`/`mv` batches. Never retried.
    - **An unplug reads as offline before removal, as AOSP does it.** `HandleError` runs
      `handle_offline` (marks the transport offline, closes its sockets; `adb.cpp:201-215`), then
      `transport_destroy`: a USB transport is removed on a later looper turn, and a TCP/wireless
      one that wasn't kicked stays listed offline while it reconnects
      (`transport.cpp:833-857`, `:1164-1169`). With a
      removal faster than the recheck, the push is `device-lost`, charged 0. With a slower one
      it is `offline`, charged 0 and not retried, and the next operation is `device-lost` once
      the row is gone. A wireless device that stays listed is `offline`, and its binds FAIL
      `device offline`.

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
- No mid-phase checkpoints (your answer to open decision 6).

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

**Shipping order.** This feature cannot ship ahead of the in-flight work:
- `seriesIdentityKey` and `normalizeSeriesUrl` exist only in the in-flight `library.js`;
- `series-merge.js`, which supplies `compareChapterLabels`, is new in the WIP commit;
- find-sources searches through mangafire, whose profile lock is the in-flight
  `sites/profile_lock.py` (review #23).

See open decision 1.

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
| `planner.js` | As parent (pure, stable op ids, rules 1-5) | Free space per transport (see `transports.js`); `settling` files; `adopted-size` never pre-selects a delete; gone folders re-push with a name choice (decision 10) |
| `job-record.js` | As parent: one lane, runId-stamped emits, coalesced progress (≤10/s), snapshot | Adds the FIFO queue for automatic plans, dropped on device removal |
| `store.js` | `writeJsonAtomic`: a unique tmp, fsync, close, rename; 5 async retries with backoff on EBUSY/EPERM/EACCES, then it throws `record-write-failed`. Also: the per-path single-flight write queue; `writeJsonAtomicSync` for `shutdownNow()` only; the sharded `RecordStore` (random shard ids, `recordEpoch`, epoch GC); the startup sweep of stale `.tmp` files | Deviation 1. `history.js:_saveJson` (102-137) is **not** the model: it falls back to a non-atomic copy and swallows errors |
| `hash-pool.js` | As parent: `worker_threads` via an inline eval'd worker, main-thread fallback, cache keyed by path → `{size, mtimeNs, sha256}` | Main is the single writer of the cache. Workers use synchronous reads so hashing doesn't occupy the shared fs thread pool. Throttle (deviation 3) |
| `pc-inventory.js` | As parent: async walk of `getConfiguredOutputRoot`, identity / url / title / `anilist_*`, hard failure on a missing or empty root | — |
| `adb/wire.js` | Pure codecs: request framing (byte lengths), OKAY/FAIL, sync packets at full struct sizes, shell-v2 packets, `devices -l` rows (keyed fields stripped from the end, state from the known set), track frames split across chunks | New |
| `adb/client.js` | Sockets: host services, transport binding (`tport` with a `transport` fallback), `shell()`, `SyncSession` (stat, list, push, pull) with the session lifecycle below | New |
| `adb/locate.js` | Candidates from the configured path, PATH, ANDROID_HOME/ANDROID_SDK_ROOT and `%LOCALAPPDATA%\Android\Sdk` (each with `adb version`); `startServer(bin)` | Replaces the locate half of the parent's `adb.js` |
| `transports.js` | The interface; `AdbTransport` on the client; `FolderTransport` (dot-temp + rename, `fs.statfs`, async presence stat with a 3 s timeout and one check in flight per target); `validatePath`; `shq`; `freeSpaceNeeded(ops)` per transport | `validatePath` caps remote paths at 1018 bytes (see the framing section) |
| `executor.js` | As parent: per-series order and the failure model (rules 6-7) | Per-file results; devMtime only from listings (the post-series one, or the next one for an interrupted series); intent shard writes, renames included; the error policy in the error table |
| `monitor.js` | `host:track-devices-l` on a persistent socket (backoff 2→60 s, polling `host:devices-l` every 5 s after 3 straight failures), folder presence, focus-aware prompt state machine (rule 10) | No CLI child process; prompt marks keyed with a boot epoch and honored for 30 min only |
| `find-sources.js` | Runner: sequential searches on its own `Searcher`, top 5 candidates, resumable, retry with an edited query; waits while Check All or the Search tab's search runs | Unchanged scope |
| `service.js` | `initDeviceSync(deps)`, every `sync:*` handler, settings hooks, quit hooks, library-change notifications, badge computation. It validates `deps` and throws loudly at init if any is missing or has the wrong type. The returned facade **never throws and never rejects**: every method catches, logs and resolves | Failure isolation (review #2; second review #1, #18) |
| `electron/proc-kill.js` | `killTree(child, {timeoutMs, detached})` → a Promise that resolves when the child closes (or on timeout). win32: `taskkill /pid N /t /f` with `windowsHide`; `detached: true` (only `shutdownNow()` uses it) spawns taskkill outside libuv's kill-on-close job and `unref()`s it. Elsewhere: `process.kill(-pid)` on a detached group, then SIGKILL on timeout | New shared helper. `downloader.js:952` keeps its inline copy because that file is in-flight |
| `src/hooks/useDeviceSync.js` | Renderer mirror: buffers events until the snapshot lands, adopts the snapshot, applies events by kind, exposes state and action wrappers. Opens with exactly one `import {…} from "react";` line, which the tools harness strips | Written and tested, **not mounted** (mounting in App.jsx is the UI pass's job) |

## The adb wire client

Protocol facts below cite AOSP `packages/modules/adb` at `main` (commit `1cf2f01`, fetched
2026-10-06). Every one was read this session. adbd on Android 11+ updates through the adbd APEX, so
P5 reads the tablet's feature list rather than assuming a version.

**Connection.**
- TCP `127.0.0.1:5037`, honoring `ADB_SERVER_SOCKET=tcp:host:port`, `ANDROID_ADB_SERVER_ADDRESS`
  and `ANDROID_ADB_SERVER_PORT` (deviation 11).
- A request is a 4-hex-digit length plus the service string.
- A reply is `OKAY`, or `FAIL` followed by a hex length and a message.

**Host services used.**
- `host:version`
- `host:devices-l`
- `host:track-devices-l` (`services.cpp:252-258`)
- `host:tport:serial:<s>`, answered with OKAY plus an 8-byte transport id (`adb.cpp:1303-1345`).
  If a server FAILs it as an unknown service, the client falls back to `host:transport:<s>` and
  takes the id from the `devices -l` row.
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
- **The reopen after a received FAIL is free**; only the FAIL itself counts against the budget.
  Rev 1's design would have charged the budget for the spurious EOFs that follow a FAIL too: one bad
  file trips the default budget of 3, and every re-run aborts at the same file.
- **An EOF during an operation on a session believed alive is a real failure** (second review #8).
  It charges 1 and is retried once on a fresh session. Otherwise a deterministic drop on one path
  would loop forever or fail every file without ever tripping the budget. Possible causes: adbd, or
  a local security product resetting connections to 127.0.0.1:5037.
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
  - **One framed reader per session** serves both the early-FAIL watch and the per-file status
    read, so they can never split bytes between them. A FAIL is `FAIL` + u32 length + text, whether
    it arrives mid-DATA or after DONE.
  - **Writes honor backpressure**: they await `drain`, or Node would buffer a whole multi-GB file
    in memory. The idle watchdog counts flushed bytes, not write calls.
  - There is no deadlock risk: adbd's failure path keeps reading until DONE (`:430-450`).
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
  - A managed folder missing from the root listing is STA2'd before it counts as absent.
    `do_list` stops at readdir's first NULL, which may be an error rather than the end, and
    still sends DONE (`:210-251`). A FUSE error partway through therefore yields a truncated root
    that the zero-folder check alone misses (second review #17).
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
- **`devices -l` rows** (`transport.cpp:1407-1433`, second review #15).
  - The layout is the serial padded with `%-22s`, then the state, then an optional unkeyed devpath,
    then `product:`, `model:`, `device:` and `transport_id:`.
  - A serial can contain spaces (`(no serial number)`).
  - So the parser strips the keyed fields from the end. The state is the first token after the
    serial that belongs to the known state set (`adb.cpp:140-175`): `device`, `offline`,
    `unauthorized`, `authorizing`, `connecting`, `detached`, `bootloader`, `recovery`, `rescue`,
    `sideload`, `host`, plus Linux's multi-word "no permissions" text.
- **A `(no serial number)` device is listed but not targetable.** `host:tport:serial:` can't
  select it, because `MatchesTarget` never matches an empty serial (`transport.cpp:1289-1291`).
- **`host:tport:` falls back to `host:transport:`** only on an unknown-service FAIL, never on
  `device '…' not found`.
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
  listing step). It is normalized to whole seconds **by truncation** for every listing method:
  LIS2 reports `st_mtime` seconds, while `find -printf %T@` and `fs.stat` report fractions.
- **When that listing goes through the shell** (no `ls_v2`), it runs on a different socket and could
  race the last file's `lutimes`. So one STA2 is sent on the push session first: adbd serves it
  only after `lutimes` (second review #16).
- **A `pushed` entry still without devMtime**, because an unplug, cancel or kill landed before the
  post-series listing, adopts the devMtime of the next listing that shows its exact size. The file
  was acknowledged, and hash-while-push knows its sha. Without this, every interrupted series would
  read as "changed on device" on resume (second review #7).
- Reason: `sync_to_tablet.py:16-17` recorded that on this tablet "adb push does NOT preserve source
  mtime (tablet mtimes are push-time)". Whatever the cause, only a value read the same way as the
  next plan's listing is comparable to it.
- P5 measures the mtime at OKAY, after the listing, after 60 s and after a reconnect.

**Errors map to `AdbError{kind}`, and each kind has one policy.**

| Kind | What produces it | Policy |
|---|---|---|
| `device-lost` | `device '…' not found` (the text behind the 106 cascaded failures), `no devices/emulators found`; or EOF/ECONNRESET/EPIPE when the serial is gone from `devices -l` after a ~1 s recheck; or the same serial with a new transport id (a removal plus an add) | Abort the run once: "disconnected — reconnect to resume" |
| `session-closed` | EOF/ECONNRESET/EPIPE while the serial is still listed as `device` | After a received FAIL: reopen, no charge. During an operation on a live session: charge 1 and retry once on a fresh session |
| `unauthorized` | state `unauthorized`; FAIL text `device unauthorized.` | Abort with USB-debugging guidance |
| `connecting` | state `authorizing` or `connecting`; FAIL text `device still authorizing` or `device still connecting` (`transport.cpp:988-993`) | Transient: wait for the monitor's next state, never a failure |
| `offline` | state `offline`; FAIL text `device offline` | Abort |
| `server-unavailable` | ECONNREFUSED at connect, or mid-job | Abort the run (the server died) |
| `no-space` | a sync FAIL carrying ENOSPC | Abort the run: every later file would fail the same way |
| `record-write-failed` | `store.js` gave up on a write (C: full, a persistent antivirus lock) | Abort the run. A failed `pending` write stops that file's SEND |
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
equal the entry's.

**`adopted-size`, pinned down** (second review #14):
- It stores the **PC file's sha at adoption time**. So a later PC change still proposes an update,
  and an unchanged PC file reads as in sync.
- **Rule 5 never pre-selects its delete** (parent rule 8: "Weak entries of that kind never
  pre-select a delete"). Its updates still apply.
- An in-sync `adopted-size` file **does not count as covering a label** when rule 5 decides whether
  to pre-select *another* file's delete.
- A folder verified with `adopt-size` **does not count as verified for rule 10's "Sync now"**.
  One click must never overwrite files matched by size alone.

**Pending resolution**, at the next plan, from the listing plus RECV (your decision: RECV). Rows are
checked top to bottom.

| Listing shows | Check | Outcome |
|---|---|---|
| no file | — | Drop the entry. With a `prev`, the old copy was unlinked, so the slot plans a push |
| `prev`'s exact (size, devMtime) | none: SEND always unlinks and recreates, so an unchanged mtime means it never ran | **Restore `prev`**: the old copy survived |
| the planned size, `prev`'s size, or both (same-size updates such as `details.json` are common) | One RECV, hashed on the PC and compared against both shas | Planned sha → `pushed`. `prev.sha256` → restore `prev` (the SEND never reached adbd, or a FolderTransport temp never got renamed) |
| any other size, or the RECV hash matches neither | — | `partial` (ours; its update is pre-selected) |
| any | the RECV fails | Stays `pending`, and the folder is flagged. **It plans as a pre-selected update**, because the app was writing that slot and the PC still has the file. Never a delete candidate |

The RECV costs one file's transfer, and only the file that was in flight is ever pending (or N
files under batched intent). It runs at every size (your answer to open decision 11).

**Every rename carries intent** (deviation 1): folder renames, rename-to-match, and case-only renames
through a temp name. The next plan finishes or reverts a leftover intent from the parent listing's
**exact** names, so a dot-temp left by a kill is never an invisible leaked copy (review #15), and a
renamed folder never loses its shard.
- Which of `from`, `via` and `to` the listing holds decides the outcome. `to` alone: finished. `from`
  alone: never ran, revert. `via`: finish with `mv via to`. None: the folder is gone (below).
- The listing, not STA2, because case-insensitive storage answers a STA2 for both case variants of
  a case-only rename.

**A bound folder that is gone from the device is re-pushed, ticked** (your answer to open decision
10, 2026-10-06; it reverses rev 3's pick). The third review shaped the details (third disposition
table).
- **"Gone" needs every signal.**
  - The shard's `name`, and its `renameIntent`'s `from`, `via` and `to` when one is left over, are
    all absent from a trusted root listing, and a STA2 of each returns ENOENT.
  - When anything reads as gone on an adb target, the root is listed once more with an rc-checked
    shell `find '<root>' -mindepth 1 -maxdepth 1 -type d`. A folder set that differs from LIS2's
    refuses the plan with `device-listing-suspect`, because a readdir error ends LIS2 early without
    an error (quiet failures above), and the hidden folder could be the renamed one.
  - A failed or suspect listing refuses the plan instead. So a locked or half-mounted storage can
    never make a folder read as gone.
- **Plan preparation runs in a fixed order per target:** rename intents, then gone detection, then
  pending resolution, coverage Verify and the zero-files sanity check. Each later step skips gone
  folders, which would otherwise misfire: a RECV or `find` of a missing path fails, and a missing
  folder isn't a folder that lists 0 files.
- **Gone is derived at each plan, never persisted.** The shard stays as it is until a re-push
  actually starts. A plan you don't apply loses nothing, and a folder that comes back (restored from
  a backup) simply binds again.
- **The series plans as new.** Every PC file of it becomes a `push`, pre-selected, carrying reason
  `removed-on-device`.
  - **Pushes reuse the kept names the old shard recorded**: a PC file whose sha matches an old
    entry is pushed under that entry's name, so Komikku's per-chapter progress, keyed by file name,
    survives the round trip.
  - **Rule 2's guard still applies, with one more strong signal.** When an unmatched device folder
    holds ≥90% of the gone shard's recorded (name, size) entries, that is a `record` match: you
    renamed the folder on the tablet rather than deleting it. It counts as strong next to identity
    and content, so the pushes are not pre-selected and Link is offered. The content match alone
    would miss a folder that holds kept names.
  - **Link on a gone series rewrites its shard** onto the linked folder (name, empty `files`,
    unverified), so a series never has two shards on one target.
- **A mass of gone folders needs an acknowledgment.** When ≥50% of a target's bound folders are gone
  and it has ≥10 of them (the mass-delete thresholds), Start requires a checked "I reviewed N series
  to re-push" box and Sync now is hidden; the ticks stay as decided. Folder targets also gain a
  volume id in the header (`fs.stat`'s `dev`, which is the volume serial on Windows), so a different
  disk at the same drive letter is a `record-mismatch`, not a mass of gone folders.
- **You choose the folder name; the default is the old device folder name.** This is an exception to
  rule 1's "never re-create", but the default keeps that rule's purpose: Komikku identifies a local
  series by its folder name, and the old scripts' alias tables also kept the tablet name.
  - `previous` is used **byte-exact**, gated only by `validatePath` and the 255-byte check, never
    through `sanitizeSegment` (its NFKC and trailing-dot trim would change the name Komikku knows).
  - `derived` is the name an unbound series would get (alias, then naming policy). It is listed
    only when it differs from `previous` by slot key.
  - **Availability.** A gone series' `previous` is reserved like a present folder before any new
    series resolves its name. A name is `available` when no device folder in the listing, no
    reserved name and no other planned series holds its slot key, **and** a STA2 of it returns
    ENOENT (the storage's own case and normalization rules decide, not the JS slot key).
  - When the default is unavailable, the series falls back to `derived`. When both are, rule 1's
    collision handling applies (the PC folder name verbatim). When that is taken too, the series is
    held with the error anomaly `name-taken`.
  - The plan carries `rebind: {shardId, choices: [{source, name, available}], chosen, fellBack,
    declined}` on the series.
  - The choice is stored in `selection.json` as `rebinds[shardId] = {source, name, declined}` and
    changed through `sync:set-selection`. A stored `name` that no longer equals that source's
    current candidate (after an alias or naming-policy change) counts as unset. The entry is cleared
    when the shard is rewritten.
  - Push op ids contain the folder name, so switching the name re-keys the series' ops, and the new
    ones start from their default preselection.
- **Declining the re-push sticks.** `declined: true` makes every push of that series default to
  unticked, including chapters downloaded later. Otherwise each new chapter's fresh op id would be
  ticked again, and one Sync now would re-create the folder around a single chapter.
- **A re-created folder needs a chapter.** For a new or gone folder, apply drops the series' sidecar
  pushes when none of its chapter pushes is selected, and reports it. A folder holding only
  `cover.jpg` and `details.json` would show in Komikku as an empty series.
- **When the series starts,** its first step, before `mkdir`, is a STA2 of the chosen name that must
  return ENOENT. If the folder reappeared since the plan, the series is skipped with "folder
  reappeared; re-plan". Then one atomic shard write sets the full field set: `name` (chosen),
  `identityKey`, `urlKey` and `pcFolder` (current), `files: {}`, `verifiedAt` (now; rule 3: a folder
  the app creates is verified at creation), `verifyMode: 'created'`, and no `renameIntent`. Rewriting
  before `mkdir` matters: an empty folder left by a kill after `mkdir` would otherwise fail rule 7's
  zero-files sanity check against the old entries and block the whole target.
- **A gone folder whose series no longer exists on the PC** plans nothing and is never STA2'd. Its
  shard is kept until Forget. Dropping it on the first plan without the series would lose the name
  for good after a transient inventory gap, and an excluded series is held, not gone.
- **Library badges show it.** `sync:library-status` takes the last plan's gone set as a device-side
  fact and reports state `removed` with that plan's "as of" time. Without it, the record's old
  entries would read as `synced`.
- **The connect prompt's "Sync now"** stays eligible for a gone series under its `previous` name
  (rule 10 allows pushes). A fallback name or a mass-gone target disqualifies it. The summary
  carries `removedOnDevice: [{series, name, fellBack, files, bytes}]`, counting selected pushes only.

**Verify modes** (`sync:verify {mode}`):
- `device-hash` is the default. It runs
  `find '<F>' -maxdepth 1 -type f ! -name '.*' -exec sha256sum {} +`, rc-checked, per managed
  folder.
- `read-back` RECVs each file and hashes it on the PC. It is exact and needs no shell, but it is
  slow: every byte crosses USB again.
- `adopt-size` records size matches as `adopted-size`.
- On a device without `sha256sum`, the service offers `read-back` or `adopt-size`. A plan that
  needs an automatic Verify on such a device (a newly linked folder, a folder whose shard didn't parse) answers
  `needs-mode` instead of choosing for you.
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
- a free-space reserve of 1 GiB. It also absorbs the space that a file unlinked while Komikku
  holds it open doesn't free yet, so `freeSpaceNeeded` is a bound only together with it (review
  #16);
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

All are written through `store.js`'s per-path single-flight queue and `writeJsonAtomic`:
1. write a unique `<name>.<pid>.<seq>.tmp`;
2. fsync it, then close it;
3. rename it over the target, retrying on EBUSY/EPERM/EACCES (5 async tries with backoff);
4. otherwise throw `record-write-failed`.

`shutdownNow()` alone uses the synchronous twin. Startup sweeps stale `.tmp` files. Durability is
as deviation 1 states it: durable across a process kill, atomic across an OS crash.

**`sync-targets.json`.** Holds `{version, adbPath, targets[]}`. `version` increments on every op, and
an op may carry `expectVersion` for optimistic concurrency.

**`targets/<id>/header.json`.** It holds:
- `recordEpoch`;
- kind, serial or folderRoot (plus `volumeId` for a folder target: `fs.stat`'s `dev`, the volume
  serial on Windows), canonicalRoot, profile, caseInsensitive;
- caps (lsV2, statV2, shellV2, sha256sum, findPrintf, statF).

On a mismatch with the target, the record is ignored for deletes and orphans until re-verified
(rule 3).

**`targets/<id>/folders/<shardId>.json`.** One shard per managed device folder (deviation 1). The
`shardId` is random and stable.
- The folder fields: `{recordEpoch, name, identityKey, urlKey, pcFolder, verifiedAt, verifyMode,
  renameIntent?, files}`. There is no state field: a gone folder is derived at each plan (see
  "Provenance").
- **Binding matches** `identityKey` (site + hid), then `urlKey` (the normalized series URL), then
  `pcFolder`. A hid change alone then keeps the binding, as rule 1 requires; `seriesIdentityKey`
  prefers the hid key whenever both exist, so a shard holding only that key would lose its series.
- `files` is keyed by the file's slot key. Each entry is
  `{name, size, sha256, devMtime, origin, prev?}`.
- A shard whose `recordEpoch` differs from the header's is ignored and garbage-collected.

**`targets/<id>/selection.json`.** `{recordEpoch, ops, rebinds}`. `ops` maps an op id to
`{sha, selected}` (rule 7: a newer PC version is proposed again). `rebinds` maps a gone folder's
`shardId` to `{source, name, declined}` (decision 10; see "Provenance"). It is written on every
`sync:set-selection`, and a forget invalidates it through the epoch.

**`targets/<id>/find-sources.json`.** Holds rows of `{folder, query, include, state,
candidates[≤5], pick, pinnedUrl, skip, error}`, written per row.

**`targets/<id>/logs/<ts>.json`.** Keeps 30. Each holds planned totals, final status, and every
destructive action. It is written before and after each destructive batch.

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
- **A mark is honored for 30 minutes only** (second review #9).
  - Why: on Windows, `os.uptime()` is `GetTickCount64()/1000` (libuv `src/win/util.c:502-503`).
    Windows' default "Shut down" is Fast Startup, which hibernates the kernel session, so uptime
    and the boot epoch survive it. Meanwhile the adb server restarts its id counter.
  - Without the time limit, the skipped prompt that review #5 described would still be the normal
    morning case.
  - 30 minutes still covers what persistence is for: a relaunch after a crash, an update or a
    reinstall.
- Residual, accepted: a skipped prompt needs a server restart, the same id, and a reconnect within
  30 minutes of the mark. The Sync tab still works then.

**`pc-hash-cache.json`.** Main is the only writer.

**Forget and clear.** `forget-record`, and rule 12's clear, write a new `recordEpoch` into
`header.json` in one atomic write, then delete the stale shards lazily. A half-finished delete can
therefore never resurrect old entries.

## IPC contract

Invoke channels use the `sync:` namespace, following `search:` and `app-update:` (`main.js:1845`).
One push channel, `sync-event`, is kebab-case like every other push channel. The full plan and the
selection stay in main (parent IPC section); the renderer gets summaries and fetches per-file
detail per series.

**Rules for every channel** (second review #18).
- **One refusal shape:** `{ok:false, code, message, …extra}`. The codes are `disabled`, `busy`,
  `disconnected`, `library-missing`, `record-mismatch`, `device-listing-suspect`, `needs-mode`,
  `blocked`, `invalid` and `version-conflict`.
- **While sync is off,** every channel answers `disabled` except four:
  - `get-state`, which then reports `enabled:false` from settings alone and never touches port
    5037;
  - `label-preview`, which is pure;
  - `cancel` and `find-sources:cancel`, so a job can always be stopped.
- **Turning sync off mid-job** (`applySettings` with `syncEnabled:false`) cancels the job and the
  find-sources run first, then stops the monitor.

| Channel | Request → response |
|---|---|
| `sync:get-state` | → `{enabled, settings, config, adb:{binary, serverVersion, error}, devices[], folderPresence, job, plans:{[targetId]: summary}, prompt, find, prewarm}` |
| `sync:config-op` | `{op, expectVersion?, …}` → `{ok, config}` or a refusal (`invalid`, `version-conflict`, `busy`). Ops: `add-target`, `update-target`, `remove-target`, `forget-record`, `set-adb-path`, `add-alias`/`remove-alias`, `add-exclude`/`remove-exclude`, `set-selection-mode`, `ack-anomaly`/`unack-anomaly`, `ignore-suggestion`/`unignore-suggestion`. Identity-changing ops are refused while that target's job runs. `add-target`/`update-target` validate the root (containment rule above) |
| `sync:locate-adb` | `{rescan?}` → `{candidates:[{path, version, build, source}], resolved, serverVersion}` |
| `sync:list-devices` | → `{ok, devices:[{serial, state, model, product, transportId}]}`; may start the server (review #8) |
| `sync:browse-remote` | `{serial, path?}` → `{ok, path (canonical), parent, entries:[{name, isDir}], presets:[{label, path, exists}]}` |
| `sync:plan` | `{targetId, overrides?:{hashMode, deletePolicy, verifyFirst, verifyMode}}` → `{ok, runId}` or a refusal: `busy`, `disabled`, `disconnected`, `library-missing`, `record-mismatch`, `device-listing-suspect`, or `needs-mode` (an automatic Verify on a device without `sha256sum`) |
| `sync:series-detail` | `{targetId, seriesKey}` → per-file rows `{opId, kind, name, label, unit, size, origin, preselected, selected, reason, loss, settling}`, plus anomalies, suggestions and the series' `rebind` (decision 10) |
| `sync:set-selection` | `{targetId, changes:[{opId, selected}]}`, `{bulk:'covered-extras'/'split-parts'/'group', …}` or `{rebind:{shardId, source?:'previous'/'derived', declined?}}` → `{ok, totals, losses, massDelete:{required, count}, massRepush:{required, count}, changedSeries}`. A `source` that isn't `available` is refused with `invalid` |
| `sync:verify` | `{targetId, mode?: 'device-hash' / 'read-back' / 'adopt-size', folders?}` → `{ok, runId}`, or the `needs-mode` refusal when the device has no `sha256sum` and no mode was given |
| `sync:prune` / `sync:rename-device-folder` | → `{ok, runId}`. Both run as jobs (phases `prune` and `rename`), and both are in the quit-ask set |
| `sync:apply` | `{targetId, overrides, ackMassDelete, ackMassRepush, ackLosses:[opId]}` → `{ok, runId}` or the `blocked` refusal with `{blocking, dropped}`. Main re-lists, re-plans and re-checks losses first (rule 6) |
| `sync:cancel` | → `{ok, wasRunning}` |
| `sync:prompt-response` | `{promptId, action: review / sync-now / not-now}` → `{ok}` |
| `sync:library-status` | → `{asOf, bySeries:{[folderPath]: [{targetId, state: synced / pending / absent / removed, pending, asOf?}]}}`. `removed` comes from the last plan's gone set, with that plan's time |
| `sync:label-preview` | `{name, folderName, patterns?}` → `{unit, label, start?, end?}` or `{error}` |
| `sync:export-report` | `{targetId}` → `{ok, path}`. main shows the save dialog through an injected `showSaveDialog` |
| `sync:device-cover` | `{targetId, folder}` → `{ok, path}` (cached under `covers/` by hashed name) |
| `sync:find-sources:start` / `:cancel` / `:get` / `:update-row` | Runner control. `update-row` patches `{query, pick, pinnedUrl, skip, include}` |

`sync-event` kinds (each carries `kind`, and job-bound ones carry `runId`):
- `device`
- `job`: phase plan/verify/apply/prune/rename; state running/done; byte and file progress; current
  file; a final `{status: completed / cancelled / failed / disconnected, summary}`
- `config`
- `prompt`
- `find`
- `prewarm`
- `library-status`

## Integration edits in existing files

Line numbers are from this branch (`a27aaf4` content). The second review re-checked every anchor
below. Every hook call is `try { deviceSync?.x(…) } catch {}` on top of the facade's own
catch-all (review #2), so a sync defect can't break a path every user runs with sync off.

**Rev 2 had two identifier bugs here that would have shipped silently** (second review #1, #2):
- Its init call used four names main.js doesn't define. Building the argument would have thrown, the
  try/catch would have swallowed it, and sync would have stayed dead with no `sync:*` handler
  registered.
- Its merge hook read `args` where the parameter is `opts`. Every merge, dry runs included, would
  have answered `merge_failed`, for every user.

Rev 3 spells every dependency out. `_test_device_sync_main_isolation.js` asserts the real
`initDeviceSync` was called once with every dependency present and correctly typed, and it runs a
dry and a real merge.

| File | Where | Edit |
|---|---|---|
| `main.js` | new block after the requires (after `:48`; the in-flight hunk is `:36-41`) | `let initDeviceSync = null; try { ({ initDeviceSync } = require("./sync/service")); } catch (e) { console.error("[deviceSync] load failed", e); }`. The require itself is isolated, so a load-time throw anywhere in the module tree can't abort main.js (second review #3). Then `let deviceSync = null;`, `const gotSingleInstanceLock = app.requestSingleInstanceLock(); if (!gotSingleInstanceLock) app.quit();`, and `app.on("second-instance", …)`. That handler restores and focuses `mainWindow`, or whichever window exists during first-run setup (`BrowserWindow.getAllWindows()[0]`). When no window exists but the app is ready, setup is done and it isn't quitting, it calls `createWindow()`, so a second launch never just vanishes (second review #19). P5's `AIO_USER_DATA_DIR` hook, if it is ever added, must run **before** the lock call, because Electron keys the lock on the userData directory at call time |
| `main.js` | the `whenReady` callback, first line (`:1880`) | `if (!gotSingleInstanceLock) return;`. An `app.quit()` before ready defers shutdown, and the ready promise can still resolve |
| `main.js` | close listener `:555-569` | Ask only while a sync **apply, prune or rename** runs; a plan or verify is cancelled on quit without asking (review #13). The sync term is evaluated after the download term, inside try/catch. The early return becomes "no downloads and no sync blocker". Payload `{running: downloader?.getRunning?.() ?? [], sync}`; `running` is unchanged, so ConfirmQuitDialog keeps working |
| `main.js` | `onComplete` `:603-606` | After the two existing calls: `notifyLibraryChanged("download")`. A throw here would skip `downloader.js:910`'s `entry._resolveClose()`, making quit wait the full 5 s |
| `main.js` | scan-library `:965-1049`, delete-series `:1059`, save-series-meta `:1781` | `notifyLibraryChanged(reason)` after the handler's work |
| `main.js` | metadata:update `:910` (today a bare `return runMetadataCli(…)`) | `const r = await runMetadataCli(…); notifyLibraryChanged("metadata"); return r;` |
| `main.js` | merge-series-folders `:1759` (the handler is itself in-flight; its parameter is `opts`) | `const r = await mergeSeriesFolders({…}); if (r?.ok && r.dryRun === false) notifyLibraryChanged("merge"); return r;`. It tests the **result's** `dryRun` (`series-merge.js:455`, `:493`), because the module defaults `dryRun = true` (`:372`) and a call that omits the flag is a dry run |
| `main.js` | save-settings `:694-710` | `deviceSync?.applySettings(merged)` after `appUpdater.applySettings`, fire-and-forget with its own catch, so a sync defect never turns a successful save into a rejected IPC call. It starts or stops the monitor and pre-warm, and turning sync off cancels a running job first |
| `main.js` | reinstall-python `:1824-1842` | Refuse while a sync job runs. `await deviceSync?.cancelFindSources()` (killTree resolves on close, ≤5 s) before `deleteEnv`, whose `rmSync` would otherwise throw EBUSY on a dying `python.exe` (`setup.js:1450-1454`) |
| `main.js` | app-update:apply-now `:1862-1873`, window-all-closed `:1953-1961` | `await Promise.allSettled([downloader?.cancelAll(), deviceSync?.shutdown({timeoutMs: 5000})])`, run in parallel, with `applyNow()` / `app.quit()` in a `finally` |
| `main.js` | new `app.on("quit", …)` | `deviceSync?.shutdownNow()` (deviation 8). It covers `app.quit()` (`quit-app` `:1816`, the updater) and `app.exit()` (reinstall-python), neither of which emits `window-all-closed` |
| `main.js` | after `initDownloader()` `:1934`, before `createWindow()` | `if (initDeviceSync) try { deviceSync = initDeviceSync({…}) } catch (e) { console.error("[deviceSync] init failed", e) }`, with every dependency spelled out: `ipcMain`, `send: sendToUI`, `userDataDir: path.join(app.getPath("userData"), "sync")`, `getSettings: () => history.getSettings()`, `getLibraryRoot: () => getConfiguredOutputRoot(resolveSpawnPaths(history.getSettings()).workingDir)` (the merge handler's own expression, `:1761-1769`), `getRunningDownloads: () => downloader?.getRunning?.() ?? []`, `isCheckAllRunning: () => _updateCheck.isRunning()`, `isSearchRunning: () => searcher?.isRunning?.() ?? false`, `resolveSpawnPaths`, `extraEnv: buildPythonEnv()`, `onFocus: (cb) => app.on("browser-window-focus", cb)`, `isFocused: () => !!BrowserWindow.getFocusedWindow()`, `getWindow: () => mainWindow`, `showSaveDialog: (o) => dialog.showSaveDialog(mainWindow, o)`. Window-dependent deps read lazily, because the window doesn't exist yet (review #12) |
| `preload.js` | the `electronAPI` object | A `sync*` wrapper per channel, plus `onSyncEvent(cb)` returning an unsubscribe (the `onConfirmQuit` shape, `:86-90`) |
| `library.js` | a new line after `:1118` | `module.exports.KOMIKKU_CH_RE = KOMIKKU_CH_RE; // deviceSync` (review #23: `:1118` is itself in-flight) |
| `searcher.js` | spawn options; `cancel()` `:255-263`; close handler `:202-208` | (review #11) **(a)** Cancellation is tracked per process, in a `WeakSet` the close handler checks. A single flag would break runSearch's own cancel-previous path (`:120-124`): a new search would reset it, and the old process's late close would report "exited with code 1". **(b)** `cancel()` returns false when `proc.exitCode !== null` or `proc.signalCode !== null`, so a taskkill can't hit a recycled PID between `exit` and `close`. **(c)** It calls `killTree(proc)` and exposes `cancelAndWait()` for callers that must wait. **(d)** On non-Windows the spawn uses `detached: true`, so the group kill reaches Python's children. The close handler treats a tracked cancel as cancelled regardless of code and signal; taskkill gives code 1 and signal null |
| `proc-kill.js` (new) | — | As in the architecture table |

**Handoff obligations for the UI pass.** These go into STATE.md and the `service.js` header:
- render `payload.sync` in ConfirmQuitDialog. Today a sync-only close would say "0 downloads are
  still running" (`ConfirmQuitDialog.jsx:44,101`);
- mount `useDeviceSync` in App.jsx;
- choose which presets to expose;
- draw the name choice for a series re-pushed after its folder was deleted on the device
  (`rebind`, `removedOnDevice`; decision 10);
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
- Test: `tools/_test_device_sync_exec.js`. The batched-intent path is built and tested here; the
  per-file fsync cost that decides whether it's switched on is measured on your PC in P5
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
  - a series merge works, dry run then real;
  - a second launch focuses the first window.
- **Stop:** a tools script drives the service end to end through a fake `ipcMain`, against
  FolderTransport and the fake adb server.

**P5. Packaged smoke and live tablet.** This needs your PC.
- **Isolate the test first.** Check whether Chromium's `--user-data-dir` moves Electron's `userData`
  for the unpacked exe.
  - If it does, use it.
  - If not, add a 3-line `AIO_USER_DATA_DIR` hook to main.js, **asking you first**. It must run
    before `requestSingleInstanceLock()`, or the test instance still collides with the installed
    app.
  - Either way, back up `%APPDATA%\aio-downloader-ui\*.json` first; the memory's shared-userData
    trap applies, and so does the single-instance lock (close the installed app first).
- **Packaged smoke.** Run `npx electron-builder --dir`, then launch the unpacked exe with a temp
  library (`AIO_OUTPUT_DIR`), sync enabled and a folder target.
  - The exe is a GUI app, so it **writes a marker file** under `userData/sync/logs/` instead of
    relying on stdout (review #25).
  - The marker must show that `sync/service` loaded from inside asar, then the pre-warm from the
    eval'd workers, then a clean quit.
  - **The NTFS fsync cost per shard write** is measured here; it decides whether batched intent is
    switched on (deviation 1).
  - **Quit paths:** after `app.exit()` (the reinstall-python path, simulated) and after a normal
    close, no find-sources process tree survives (deviation 8).
- **Live tablet, only with your OK and your hands on the cable.** `tools/_live_device_sync.js` runs
  on the scratch root `/storage/emulated/0/Download/aio-sync-test/` with three series, including
  the SPY×FAMILY and Hell's Paradise name shapes. It measures:
  - the device features (`ls_v2`, `stat_v2`, `shell_v2`, `sendrecv_v2`) and the toybox
    capabilities;
  - the case-insensitivity probe;
  - what an interrupted push leaves (expect nothing, since adbd unlinks the partial) and what an
    interrupted update leaves (expect an empty slot);
  - **the device mtime at OKAY, after the listing, after 60 s and after a reconnect** (review #4);
  - **the wait between the last DATA and OKAY** on large files, against P2's drain allowance
    (32 MiB of `delayed_ack` window at a 1 MiB/s floor);
  - **a listing after a reboot, before the first unlock** (review #3);
  - throughput versus adb.exe on the same files, and per-file acks versus a pipelined run;
  - byte-exact UTF-8 names, and `realpath /sdcard`;
  - an unplug mid-run: abort once, then resume. The resumed plan must show the files acknowledged
    before the unplug as in sync, not as replaces (second review #7);
  - **the connect prompt after a Windows "Shut down" (Fast Startup)**: with the app closed, shut
    down, power on, plug in, and the prompt appears (second review #9);
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
  changed-on-device.
  - Every pending-resolution row: absent; `prev`'s (size, devMtime) shortcut; planned size equal to
    `prev`'s (one RECV, both shas); pushed; restore `prev`; partial; RECV failure, which plans as a
    pre-selected update.
  - A `pushed` entry without devMtime adopts the next listing's devMtime at an equal size.
- **`adopted-size`.** It stores the PC sha. Its delete is never pre-selected. It never covers a
  label for another file's delete. A size-verified folder never makes "Sync now" eligible.
- **Gone bound folder** (decision 10).
  - Every PC file plans as a pre-selected push with reason `removed-on-device`, under the old name
    byte-exact by default, and under the old shard's kept names where the sha matches.
  - `rebind.choices` lists `derived` only when its slot key differs. An unavailable default falls
    back to `derived`, then to the verbatim PC folder name, then to a held series with `name-taken`.
    A reserved `previous` can't be taken by a new series.
  - A `rebind` switch re-keys the series' op ids; a stored name that no longer matches its source
    counts as unset; `declined` unticks every push, including ones for later chapters.
  - A `record` match (≥90% of the gone shard's entries in an unmatched folder), and identity or
    content matches, leave the pushes unticked and offer Link.
  - ≥50% of ≥10 bound folders gone requires `massRepush` and hides Sync now; a fallback name hides
    it too.
  - A gone folder whose PC series is absent plans nothing. Planning writes nothing for a gone
    folder.
  - Binding survives a hid change through `urlKey`, and a URL change through `pcFolder`.
- **Per-slot planning.** In sync, update, replace (unticked group), kept name, rename toggle, push,
  `settling`.
- **Preselection.** Guarded vs add-only; every rule-5 case.
- **Losses.** Recomputed on toggle; the mass-delete threshold.
- **Rule 6.** The re-plan at apply time: changed or vanished ops are dropped, and a new loss blocks.
- **Rule 10.** "Sync now" eligibility, and one prompt covering several targets on one device.
- **Rule 12.** The record is cleared when a target's device, root or profile changes, through a new
  `recordEpoch`; old shards and the old selection are ignored afterwards.
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
- **`devices -l`.** Full rows with devpath, `product:`, `model:`, `device:` and `transport_id:`;
  padding; every state in the set, including `authorizing`, `connecting` and the multi-word
  "no permissions"; the `(no serial number)` serial, listed but not targetable.
- shell-v2 demux, exit codes, CloseStdin sent; the legacy `shell:` CRLF path.
- **Session lifecycle.**
  - A FAIL on file 2 of 5: files 3 to 5 still land, the budget shows 1, and the session is
    reopened.
  - An early FAIL mid-DATA stops the stream, read through the single framed reader.
  - A missing `details.json` doesn't kill the reads queued behind it.
  - **A session that closes without a FAIL on every SEND matching a pattern** charges the budget
    and aborts the run at it, instead of looping.
  - Backpressure: pushing a file larger than the test's heap allowance keeps memory bounded, and
    the idle watchdog counts flushed bytes.
- **Quiet failures.**
  - A DONE-only listing of a missing directory is not trusted.
  - `.`, `..` and error entries are skipped.
  - The STA2 `error` field drives the case probe and `exists`.
  - Locked storage makes the plan refuse with `device-listing-suspect`.
  - A truncated root listing (a FUSE error mid-readdir) doesn't turn the missing managed folders
    into absences: each one is STA2'd first.
  - A shell-path post-series listing is preceded by a same-session STA2.
- **Errors.**
  - Classification uses the real `device 'A06B4A372090333' not found` text.
  - ENOSPC and EROFS abort the run.
  - ECONNRESET is handled as EOF, with the ~1 s recheck.
  - The same serial with a new transport id is a removal plus an add.
  - `device still connecting` and `device still authorizing` are transient, never failures.
- **Names.**
  - SPY×FAMILY and `Hell’s Paradise` names land byte-exact.
  - A comma in a name survives the last-comma split.
  - A 1,019-byte path is refused before it is sent.
  - A name that isn't valid UTF-8 is never planned.
- **Cancel mid-SEND.** The socket is destroyed and the fake adbd unlinks the partial.
- **Fallbacks.** v1; `tport` → `transport` only on an unknown-service FAIL (never on
  `device '…' not found`); tracking → polling after 3 failures.
- **Server.** `start-server` is called only when the server is unreachable, also for explicit
  actions with no target yet. `kill-server` is never sent.
- **Moved at P2.** These items need a module of a later phase. P2 tests the primitive each one
  rests on, and the rule itself is tested with its module:
  - the budget summing to an abort, and ENOSPC/EROFS/`connecting` as run policy → `executor.js`,
    `_test_device_sync_exec.js` (P2: the kinds and `.charges`);
  - not trusting a DONE-only listing, the STA2 `error` field driving the case probe and
    `exists`, locked storage refusing with `device-listing-suspect`, STA2 of each managed folder
    missing from a truncated listing, and the same-session STA2 before a shell-path listing →
    `transports.js`, `_test_device_sync_exec.js` (P2: a missing folder lists like an empty one,
    STA2 errors, the locked root, a truncated listing that STA2 contradicts);
  - a non-UTF-8 name never planned → `transports.js` feeding the planner, P3 (P2: `name` is
    null and the raw bytes are kept);
  - tracking → polling after 3 failures → `monitor.js`, `_test_device_sync_monitor.js` (P4);
  - when a server start is allowed → `service.js`, `_test_device_sync_service.js` (P4) (P2:
    `ensureServer` starts it only on `server-unavailable`).
- **Added at P2** (deviation 11's calls):
  - nothing that refuses an open runs after the service is sent: a re-attached device and an
    abort during the bind send no shell and no sync request, and errors carry `sent`;
  - `destroy()` mid-push and mid-bind is `cancelled`, terminal, and leaves no device socket;
  - a stalled PC source, source open or pull sink ends by cancel or watchdog;
  - an early FAIL is reported at once while the source is slow, while a DATA write waits on a
    slow device, and while DONE waits on drain (where it was a `timeout` before the fix);
  - the OKAY wait's drain allowance under `delayed_ack`, on a 24 MiB push whose stream also
    crosses the fake's read-ahead pauses;
  - an unplug reads offline first: removal faster or slower than the recheck, and a wireless
    device that stays listed;
  - the fake's own AOSP behaviors: mksh syntax errors, bytes sent with a transport switch
    dropped, one `failPaths` match per SEND.

**`_test_device_sync_exec.js`**
- An interrupted in-place update leaves an empty slot. The entry is dropped and the re-plan
  re-pushes.
- **Shard crash windows.** Each one recovers correctly at the next plan:
  - a kill between the `pending` write and the SEND;
  - a kill between OKAY and the `pushed` write;
  - **a kill after `pushed` writes but before the post-series listing, and a cancel mid-series**:
    the resumed plan shows those files in sync;
  - a leftover `.tmp`;
  - a zero-length or unparsable shard, which leaves that folder unbound (managed by name and
    verified again, or offered for Link);
  - a shard with a stale `recordEpoch` after a half-finished forget: ignored and collected.
- **Renames.** A folder rename and a case-only rename, each killed before and after the `mv`, are
  finished or reverted from `renameIntent`. A rename onto an existing destination is refused before
  `mv` runs.
- **Writes.** Overlapping writes to one shard coalesce, and their tmp files never collide.
  `record-write-failed` aborts the run, and a failed `pending` write stops that file's SEND.
- **Gone-folder rule.**
  - A folder absent from a truncated listing is never gone, and neither is one whose rename intent
    left it under `via`. On adb, a gone folder triggers the rc-checked shell re-listing.
  - The series' first step STA2s the chosen name: a folder that reappeared skips the series. Then
    the shard is rewritten before `mkdir`. A kill between that write and `mkdir`, and one between
    `mkdir` and the first push, both recover at the next plan without a sanity-check refusal.
  - A selection with only sidecar pushes for a new or gone folder creates no folder.
  - Link on a gone series rewrites its shard instead of adding a second one.
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
  - **A mark older than 30 minutes is ignored** even when serial, id and boot epoch all match (the
    Fast Startup case, with an injected clock).
- **Service E2E.**
  - Disabled means inert: no socket (`get-state` included), no writes under `userData/sync`, and
    **every** handler except the four named answers `disabled`.
  - Turning sync off mid-job cancels the job and find-sources first; both cancel channels still
    work while off.
  - Every refusal has the one shape `{ok:false, code, message}`.
  - The facade never throws and never rejects, even when its internals do.
  - `sync:rename-device-folder` runs as a `rename` job and is in the quit-ask set.
  - Config ops: validation (including root containment), versioning, refusal during a job.
  - The main flow: plan → selection → apply → modify / rename / delete on the PC → re-plan (kept
    name) → both delete policies → verify → prune → library root unplugged (refusal).
  - Quit: `shutdown()` finishes within 5 s. `shutdownNow()` is synchronous and idempotent (called
    twice), leaves a consistent record, flushes the PC hash cache, and spawns its taskkill
    detached.
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
  `electron` module.
  - **With the real `sync/service`:** `initDeviceSync` is called exactly once, with every
    dependency present and of the right type, and the `sync:*` handlers get registered (second
    review #1).
  - **With a `sync/service` that throws at require time:** main.js still loads (second review #3).
  - **With a `deviceSync` whose every method throws or rejects:** get-settings, save-settings, the
    close listener, onComplete, metadata:update, merge-series-folders (dry and real, second review
    #2), window-all-closed and the `quit` hook all behave as they do without sync.
  - If main.js's top level can't run under a stub without edits, this test is dropped and the
    dev-app smoke carries the check; the P4 report would say so.

**Hostile names.** `'`, `$`, backtick, `|`, `,`, `DocumentsX`, `..`, newline, NUL, invalid UTF-8,
names over 255 bytes and paths over 1,018 bytes are rejected or safely quoted, in both
`validatePath` and `shq`.

**Regression.**
- The CLAUDE.md suite. No Python changes are planned, so items 1-6 and 8 are sanity checks and
  item 7 (`npm run build`) is the real one.
- Re-run the existing `tools/_test_*.js`, since main.js and preload change.

## Open decisions and risks (my pick → what changes otherwise)

1. **Shipping with in-flight work.** Decided after P6, per CLAUDE.md.
   - Pick: ship with or after the in-flight work (`library.js`, `series-merge.js`,
     `sites/profile_lock.py`).
   - Otherwise the identity rules get duplicated into `sync/`, and two definitions drift.
   - Either way, the feature diff (`git diff a27aaf4 HEAD -- UI-source`) is rebased onto your local
     in-flight tree **as it stands at ship time**, which may have moved on from `a27aaf4`.
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
6. **Mid-phase checkpoint commits on this branch.** **Decided 2026-10-06: commit and push at each
   phase stop only** (Decisions table, rev 4).
7. **Sharded record instead of the journal** (deviation 1).
   - Pick: shards.
   - Otherwise: the journal, with all five of review #6's fixes plus a test for each crash window.
8. **Per-file push acknowledgements.**
   - Pick: one OKAY per file; P5 measures.
   - Otherwise: pipeline small files with deferred acks, as the adb CLI does. That is faster for
     many small files, but one FAIL then fails the whole pipeline.
9. **Prompt-mark residual** (`prompted.json`).
   - Pick: keep persisted marks, honored for 30 minutes. A prompt can then be skipped only when the
     server restarts, hands out the same id, and the device reconnects within that window.
   - Otherwise: drop persistence, so every app restart re-prompts a still-connected device.
10. **A bound folder deleted on the tablet.** **Decided 2026-10-06: re-push it ticked, under a
    name you choose that defaults to the old device folder name** (Decisions table, rev 4;
    design under "Provenance"). Rev 3's pick (keep the binding, list the pushes unticked) was
    declined.
11. **Large `pending` files under your RECV decision.** **Decided 2026-10-06: RECV at every
    size.** One 3 GB pending volume adds about a minute and a half to that plan at 30 MB/s; the
    `prev` (size, devMtime) shortcut skips the RECV when the SEND never ran.
12. **Weak adoption matches after the first sync** (raised in P1).
    - Pick, implemented: parent rule 2 as written. `name` and `similar` matches block a series'
      new-folder pushes only on a target's first sync; identity, content and `record` always do.
      Later, a new PC series whose name matches an unmatched device folder (`SPY x FAMILY` against
      `SPY_x_FAMILY`) gets its pushes pre-selected into a new folder. The Link suggestion is still
      shown, and an unresolved suggestion hides Sync now, so the review has to be opened.
    - Otherwise weak matches always block. No duplicate folder can then appear without a click,
      but every new series that merely resembles a device-only folder waits for Link or Not the
      same.
13. **A fork regardless of names** (deviation 10).
    - Pick, implemented: same identity is a fork even when the derived names differ.
    - Otherwise forks count only on a name collision, and under `as-is` naming both fork folders
      are synced as two series.

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
| 6 | The journal design is incomplete | Changed fix | The analysis is sound; the journal is replaced by per-folder shards with fsync'd atomic rewrites. The `.bak` (#6d) is dropped: an atomic rename always leaves the old or the new shard, and either is safe | Deviation 1; shard crash tests |
| 7 | Two instances share userData/sync | Confirmed | No `requestSingleInstanceLock` in `electron/*.js` (rg) | Your decision: app-wide lock |
| 8 | The first adb target can't be created | Confirmed | The rev 1 text | When adb.exe still runs |
| 9 | get-settings spread persists undecided defaults | Confirmed | `SettingsTab.jsx:795-802`, `:913-916`; `history.js:229`, `:58-67` | Settings section; handoff obligation |
| 10 | Weak "adopt by size" was dropped | Confirmed | Parent rule 8; rev 1's origin list | Your decision: RECV + `adopted-size` |
| 11 | The searcher cancel fix is incomplete | Confirmed | `searcher.js:120-124`, `:202-213`, `:255-263`; `setup.js:1450-1454` | searcher.js row; proc-kill |
| 12 | Missing deps; lazy window access | Confirmed (the profile-lock aside was not checked; not load-bearing) | `update-check-record.js:91`, `main.js:1441` | initDeviceSync row |
| 13 | Quit coverage gaps | Changed fix | `main.js:1816` (`app.quit()`), `:1832` (`quit` is emitted on `app.exit`); no before-quit/will-quit handlers exist (rg) | Deviation 8; close-listener row |
| 14 | A hash mismatch must update the PC cache | Confirmed | Logic | Deviation 2 |
| 15 | Pending needs more outcomes | Confirmed | `:563-576` ("missing ," / "bad mode" FAIL before `send_impl`'s unlink) | Pending-resolution table; `renameIntent` |
| 16 | Free space depends on the transport | Confirmed | Logic | `freeSpaceNeeded`; exec test; the 1 GiB reserve covers a file Komikku holds open |
| 17 | Error classification | Confirmed | Logic, plus the FAIL texts the review cites (not re-checked against the server's source) | Error table |
| 18 | Wire-level details | Confirmed | `:563`; `client/file_sync_client.cpp:585`; `commandline.cpp:546`; `transport.cpp:1407-1416`; `adb.cpp:1303-1345` | Framing details; fallbacks |
| 19 | Verify timeout | Confirmed | Logic (`sha256sum` is silent per file) | Verify budget |
| 20 | Folder-target containment; presence threads | Confirmed | Logic | `root` field; transports row |
| 21 | Re-stat age vs debounce | Confirmed | 30 s vs 10 s in rev 1 | Deviation 9 |
| 22 | Cover cache path | Confirmed | Logic | Hashed cover names |
| 23 | Editing in-flight files | Confirmed | `git show d1ae7d6:…/library.js` export at `:923`; WIP at `:1118`. The baseline is now commit `a27aaf4` | Branch protocol; library.js row; `sites/profile_lock.py` in the shipping order |
| 24 | Test gaps | Confirmed | `_test_update_check_hook.js:42-47` (one-import strip) | Verification lists |
| 25 | P5 gaps | Confirmed | The parent plan's Phase 6 list | P5 |

### Second review (of rev 2, 2026-10-06)

Rev 3 checked the second review's load-bearing claims against main.js, `series-merge.js`, AOSP, and
libuv `v1.x` (`src/win/process.c`, `util.c`, `fs.c`). Every one held. The review found no
delete-safety hole: each failure it built ends in "foreign" or "unverified".

| # | Finding | Verdict | Evidence checked | Where it landed |
|---|---|---|---|---|
| 1 | `initDeviceSync` deps name identifiers main.js lacks | Confirmed | `rg -c` on main.js: `userDataDir`, `getLibraryRoot`, `getRunningDownloads`, `showSaveDialog` all 0 | Integration init row; isolation test |
| 2 | The merge hook reads `args`; the parameter is `opts` | Confirmed | `main.js:1759`; `series-merge.js:372` (default `true`), `:455`, `:493` | Merge row tests `r.dryRun === false`; metadata:update reshaped |
| 3 | The `require` isn't isolated | Confirmed | Logic | Integration require row |
| 4 | Shards keyed by name; no rename protocol | Confirmed | Rev 2 text; shell `mv` semantics | Deviation 1 (random ids, rename intent); rev 4 replaced its drop rule with the gone-folder design |
| 5 | Header and shards can disagree after a partial clear | Confirmed | Rev 2 text | `recordEpoch` |
| 6 | Write mechanics under-specified | Confirmed | Rev 2 text | Deviation 1 write mechanics; `record-write-failed` |
| 7 | `pushed` without devMtime breaks resume | Confirmed | Rev 2 text | devMtime adoption rule; exec test; P5 check |
| 8 | Free reopen allows endless or unaborted runs | Confirmed | Rev 2 text | Session lifecycle; error table; fake injection |
| 9 | Fast Startup keeps the boot epoch | Confirmed | libuv `src/win/util.c:502-503` (`GetTickCount64`); Fast Startup is hibernation (recall) | 30-minute mark limit; P5 check |
| 10 | Durability overstated | Confirmed | libuv `src/win/fs.c:2341` (`MoveFileExW`, no write-through) | Deviation 1 wording |
| 11 | taskkill spawned at `quit` dies with Electron | Confirmed | libuv `src/win/process.c:93-96`, `:1149-1152` (kill-on-close job) | Deviation 8; proc-kill `detached` |
| 12 | State still waiting in memory | Confirmed | Rev 2 text | Deviation 8 write points |
| 13 | Pending-resolution gaps | Confirmed; one part left to you | The RECV cost is real, but replacing RECV with device hashing would change your decision | Pending table; `needs-mode`; open decision 11 |
| 14 | `adopted-size` unpinned | Confirmed | Rev 2 text | The `adopted-size` rules |
| 15 | `devices -l` parsing | Confirmed | `transport.cpp:1407-1433`, `:1289-1291`, `:988-993`; `adb.cpp:140-175` | Framing details; `connecting` kind |
| 16 | DATA reader, backpressure, listing race | Confirmed | `:419-421` vs `:552-557`; `:430-450` | Session lifecycle; devMtime section |
| 17 | A truncated root listing goes unnoticed | Confirmed | `:210-251` | Quiet failures |
| 18 | Contract and lifecycle inconsistencies | Confirmed | Rev 2 text | IPC rules; the rename job |
| 19 | Single-instance edge cases | Confirmed | Logic; the review read Electron's `OnQuit` and lock code (not re-checked) | Integration lock row; P5 |
| 20 | Gaps in the first disposition table | Confirmed | This section | #6, #16 and #23 rows; open decision 1 |

### Third review (of rev 4's gone-folder design, 2026-10-06)

An Opus reviewer read both plans and the rev 3 → rev 4 diff. Every finding was checked against the
plan text it cites. None needed AOSP. The volume-id fix was checked in libuv `src/win/fs.c:1863`,
`:1915` (`st_dev` = `VolumeSerialNumber`).

| # | Finding | Verdict | Evidence checked | Where it landed |
|---|---|---|---|---|
| 1 | The folder is created before its shard is rewritten | Confirmed | Parent's per-series order (mkdir → cleanup → renames → pushes) vs rev 4's "first intent write" | Shard rewrite is the series' first step, before `mkdir`; exec test for both kill windows |
| 2 | Nothing re-checks absence before writing | Confirmed | Rev 4 text; SEND unlinks an existing file | STA2 ENOENT at plan time (availability) and right before the rewrite |
| 3 | Per-folder step order unspecified; a leftover rename intent can fake "gone" | Confirmed | Rev 4 text; dot-names are invisible to the listing | Fixed prep order; gone requires `name`, `from`, `via`, `to` all absent |
| 4 | Content match misses renamed folders with kept names | Confirmed | Parent rule 2 compares with PC names; kept names are rule 4's default | `record` match strength; rc-checked shell re-listing when anything is gone |
| 5 | Link on a gone series undefined | Confirmed | Rev 4 text | Link rewrites the gone shard; one shard per series per target |
| 6 | Unticking a gone series doesn't stick | Confirmed | Selection keyed by (op id, sha); new ops default to their preselection | `declined`; no folder without a chapter push |
| 7 | A mass of gone folders; no volume identity for folder targets | Confirmed | Header fields in rev 4 | `massRepush` acknowledgment; header `volumeId` |
| 8 | Name availability circular, no terminal case, old names altered by sanitize | Confirmed | Rev 4 text; `sanitizeSegment`'s NFKC and trailing-dot trim | `previous` reserved and byte-exact; `name-taken` hold |
| 9 | `names` stores a choice, not a name | Confirmed | Rev 4 text | `rebinds[shardId] = {source, name, declined}`, cleared at the rewrite |
| 10 | Badges say "synced" for a gone series | Confirmed | Parent rule 13 computes badges from the record | `removed` state from the last plan's gone set |
| 11 | Shard rewrite's field set incomplete | Confirmed | Rev 4 text | Full field set listed |
| 12 | Shards dropped when the PC series is absent | Confirmed | Transient inventory gaps; excluded series are held | Kept until Forget; never STA2'd |
| 13 | Sync now data thin | Confirmed | Rev 4 text | `removedOnDevice` fields; a fallback name hides Sync now |
| 14 | A re-push loses per-chapter Komikku progress | Confirmed | `komikkuspec.md` keys progress by chapter file name | Pushes reuse the old shard's kept names |
| 15 | Stale text | Confirmed | Status block; second table's #4 row | Both fixed |

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
| `GetTickCount64()/1000`; `MoveFileExW(…, MOVEFILE_REPLACE_EXISTING)`; kill-on-close job | Why the boot epoch survives Fast Startup; why a rename is atomic but not durable; why a quit-time taskkill must be detached | read: libuv v1.x `src/win/util.c:502-503`, `fs.c:2341`, `process.c:93-96,1149-1152` |
| 30 min | How long a prompt mark is honored | this plan's choice: covers crash, update and reinstall relaunches |
| ~90 s | RECV of a 3 GB pending volume at 30 MB/s | derived; the 30 MB/s USB rate is an assumption, which P5 measures |
| 30 s settling / re-stat, 10 s debounce, 60 s idle, 8 MiB/s Verify rate, 1 s recheck, 5 s polling, 5 s quit wait, 1 GiB reserve, ≤10 events/s, ≤4 workers, 500-hash flush | Engine constants | this plan's choices (the 8 MiB/s is a deliberately low floor for slow flash, not a measurement) |
