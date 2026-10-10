# Device Sync — handoff from the cloud session back to your PC (after P4)

You are the local Claude session on the user's Windows 11 PC. A cloud session built the non-UI
Device Sync feature through phase P4 on branch `wip/device-sync-handoff` of the fork, and stopped
because P5 needs this machine. This file tells you how to pick the work up without damaging the
user's local tree, what to fold back into memory, and what to do next.

**State at handoff (2026-10-10):** P0 to P4 are done, committed and pushed. The tip is `47d7923`,
plus the commit that adds this file. The phase map is `sync-temp/STATE.md`; this file only says
how to continue.

## 0. Read first, in this order

1. `sync-temp/STATE.md`. It is the phase map: what each phase built, its tests and its decisions,
   the open decisions, the defect ledger, and the memory rewrites owed.
2. `sync-temp/plans/c-users-legoc-claude-plans-add-this-scr-noble-truffle.md` (rev 4).
   - The status block.
   - Deviations 10 to 13: the calls made while coding P1 to P4.
   - "Integration edits in existing files".
   - "P5. Packaged smoke and live tablet".
   - Verification ("Added at P2/P3/P4").
3. The header comment of `UI-source/electron/sync/service.js`. It describes the runtime contract
   and lists the UI pass's handoff obligations.
4. The parent plan, `sync-temp/plans/add-this-script-s-features-linked-pumpkin.md`, but only when
   a behavior rule number (1-13) comes up.

## 1. Standing rules, unchanged

- **This branch never goes to zzyil.** No PR against `zzyil/AIO-Webtoon-Downloader`, and no push
  to `upstream`. Push only to the fork's `wip/device-sync-handoff`.
- **`sync-temp/` and `tools/` never ship.** Both are gitignored. On this branch their files are
  force-added (`git add -f`). Before anything ships, drop them with
  `git rm -r --cached sync-temp tools`, or cut the shipping branch fresh per CLAUDE.md
  "How to ship".
- **Ask rather than pick.** Test before presenting: name every check you ran, and say "not run"
  for the rest. Re-read changed files from disk before reporting. Report in the Reports style at
  each phase stop, then wait.
- **Commit and push at each phase stop**, and only once its tests are green. No PR unless the user
  asks. Commits end with the `Co-Authored-By` / `Claude-Session` lines your session's attribution
  reminder gives.
- **Back up `%APPDATA%\aio-downloader-ui\*.json` before launching any build of the app.** The dev,
  test and installed apps share that userData.
- **Never run the NSIS uninstaller.**
- **Ask first:**
  - before adding the `AIO_USER_DATA_DIR` hook to main.js;
  - before touching `search_orchestrator.py` (it is in-flight);
  - before any live-tablet step. The tablet is serial `A06B4A372090333`, and the user must have
    their hands on the cable.
- **The single-instance lock is now in main.js.** The dev app and the installed app can't run at
  the same time, so close one before launching the other.

## 2. Get the branch without touching the user's local work

The user warned that the local tree may hold edits the branch doesn't have. The branch's
`a27aaf4` is a snapshot of their whole working tree on 2026-10-06, and work has continued since.
**Do not check out, reset, stash, merge or rebase in the user's main working tree.**

1. Fetch, after checking the remote names with `git remote -v` (CLAUDE.md calls them `fork` and
   `upstream`):
   ```powershell
   git fetch fork wip/device-sync-handoff
   ```
2. **Measure what changed locally since the snapshot.** Run this in the user's tree; it is
   read-only:
   ```powershell
   git diff --stat a27aaf4                       # tracked files changed since 2026-10-06
   git ls-files --others --exclude-standard      # untracked now; compare with:
   git ls-tree -r --name-only a27aaf4
   ```
   Pay particular attention to the files the feature edits outside `sync/`:
   - `UI-source/electron/main.js`
   - `UI-source/electron/preload.js`
   - `UI-source/electron/searcher.js`
   - `UI-source/electron/library.js` (one appended line)
3. **Work in a separate worktree** for P5, so the user's tree stays as it is:
   ```powershell
   git worktree add ..\aio-sync-wt fork/wip/device-sync-handoff
   cd ..\aio-sync-wt\UI-source
   npm ci
   ```
   The repo's CLAUDE.md is git-excluded locally, so the worktree won't have it. Read it from the
   user's main tree.
4. **Bringing the feature into the user's tree is the user's decision.** Ask before doing it. The
   feature diff is `git diff a27aaf4 fork/wip/device-sync-handoff -- UI-source`. If step 2 shows
   local edits in the four files above, expect conflicts in main.js. Show the user the overlap
   first.

## 3. Fold the cloud state into memory

The cloud session couldn't write memory, so this is owed:
- **`device-sync-feature.md`:** rewrite it from `sync-temp/STATE.md`, as a map, not a log.
- **`electron-app-local-e2e-testing.md`:** add three things.
  1. The single-instance lock: dev and installed builds can't run side by side, P5's packaged
     smoke included.
  2. A fresh profile shows "Save Settings · 55 changed" until its first Save. This is by design
     (`countDirtySettings`), not a regression.
  3. `tools/_smoke_device_sync_dev.js` exists (see §4).
- **The defect ledger:** add the 4 shipped defects listed under STATE.md "Defect ledger".
- **Merge, don't overwrite.** `sync-temp/context/memory/` is the 2026-10-06 copy. The live memory
  folder may have changed since, so compare each file before writing.
- **CLAUDE.md:** nothing to copy back yet. The cloud never edited
  `sync-temp/context/CLAUDE.project.md`; the CLAUDE.md edits are P6 work.

## 4. Re-verify on Windows before starting P5

Every test so far ran on Linux (node 22.22.0, and Electron 40's Node 24.15.0). The first run on
Windows covers code paths the container never ran:
- `proc-kill.js`'s `taskkill /t /f` branch, with its detached spawn;
- the NTFS behavior of FolderTransport and the atomic renames;
- the Windows adb paths.

In the worktree's `UI-source`:
```powershell
node --check electron\main.js; node --check electron\preload.js
npm run build
cd ..
Get-ChildItem tools\_test_*.js | ForEach-Object {
  node $_.FullName; "{0} node exit {1}" -f $_.Name, $LASTEXITCODE
  $env:ELECTRON_RUN_AS_NODE = "1"
  & .\UI-source\node_modules\electron\dist\electron.exe $_.FullName; "{0} electron exit {1}" -f $_.Name, $LASTEXITCODE
  Remove-Item Env:ELECTRON_RUN_AS_NODE
}
```
- **Expected on Linux:**
  - core 87, adb 90, exec 49, monitor 23, service 21, searcher_cancel 8;
  - contract, hook and main_isolation (6 scenarios) print their "passed" lines;
  - the 5 older tests pass.
- **Two known Windows differences:**
  - `_test_searcher_cancel.js` needs `python` on PATH;
  - `_test_device_sync_main_isolation.js` skips its `metadata:update` check on win32 (it has no
    fake python).
- **A failure on Windows is a finding.** Report it with its output; don't patch it silently.

**The dev-app smoke script doesn't run on Windows as written.** `tools/_smoke_device_sync_dev.js`
was built for the Linux container:
- its fake python is an `sh` script;
- it launches `electron`, not `electron.exe`;
- it runs under xvfb;
- it requires a global `playwright`.

Ask the user which they want:
- **Run the checklist by hand.** It is the plan's P4 "Dev-app smoke with sync off".
- **Adapt the script.** It is a tools-only change. Use `electron.exe`; make the fake download
  `pythonCmd = node.exe` with `scriptPath` set to a `.js` that sleeps; drop xvfb.

Either way, also check the one item the container couldn't: **a second launch restores a
minimized window.**

## 5. Questions to put to the user before P5

The P4 report asked for confirmation of four calls I made, and none has been answered yet (STATE.md
open decision 5; plan deviation 13). Get the user's answer, or their OK to keep my picks:
1. A plan's device refusals arrive when its job ends (`summary.refusal`, kept in
   `plans[id].refusal`), not as the call's answer.
2. A target that was never synced to keeps its selection only for the session.
3. The executor's `isPathBusy` stays unwired. `settling` covers a file a download is still
   writing.
4. A second launch during the ≤5 s quit wait opens no window.

STATE.md open decisions 1 to 4 are still open too. Raise them only when a phase needs them.

## 6. Then P5, as the plan describes it

Follow "P5. Packaged smoke and live tablet". Two things P5 has to **write**, because they don't
exist yet:
- **The marker file.** The packaged exe writes it under `userData/sync/logs/`. It must show that
  `sync/service` loaded from inside asar, the pre-warm ran in its workers, and the app quit
  cleanly. Nothing writes it today. Add it with the same failure isolation as the rest of the
  service: it must never throw, and it must write nothing while sync is off.
- **`tools/_live_device_sync.js`.** It works on the scratch root
  `/storage/emulated/0/Download/aio-sync-test/` only. Write it, but **don't run it without the
  user's OK.**

Order:
1. Back up the JSONs and close the installed app.
2. Check whether Chromium's `--user-data-dir` moves Electron's userData for the unpacked exe. If
   it doesn't, **ask** before adding the 3-line `AIO_USER_DATA_DIR` hook. It must run before
   `requestSingleInstanceLock()`; see the comment above that call in main.js.
3. `npx electron-builder --dir`, then launch with a temp library (`AIO_OUTPUT_DIR`), sync enabled
   and a folder target. Then:
   - read the marker;
   - measure the NTFS fsync cost per shard write. It decides whether batched intent is turned on
     (deviation 1; `intentBatch = 1` today);
   - check the quit paths: after a normal close and after a simulated `app.exit()`, no
     find-sources process tree may survive.
4. **Live tablet, only with the user's OK**: the measurement list in the plan's P5 section.
5. **Search timing** on 5 real find-sources queries. Propose `AIO_SEARCH_PROBE_DEADLINE` only if
   the probe phase dominates, and **ask first** (`search_orchestrator.py`).
6. **The P5 stop:** update STATE.md and the plan (a deviation 14 for the P5 calls), commit,
   push, report, wait.

P6 (docs and handoff: CLAUDE.md pointer rows, PARITY rows for 23 channels plus `sync-event`) and
the UI pass (STATE.md "Handoff obligations for the UI pass") come after. Neither starts without
the user.

## 7. Quick reference

| What | Where |
|---|---|
| Feature code | `UI-source/electron/sync/` (adb/, contract, planner, provenance, store, hash-pool, pc-inventory, transports, executor, prepare, monitor, find-sources, service, …), `electron/proc-kill.js`, `src/hooks/useDeviceSync.js` (not mounted) |
| main.js integration | `grep deviceSync` in `UI-source/electron/main.js` |
| Tests | `tools/_test_device_sync_*.js`, `tools/_test_searcher_cancel.js`, `tools/fake-adb-server.js`, `tools/_smoke_device_sync_dev.js`. `TEST_ONLY=<regex>` runs a subset of the adb, exec, monitor, service and searcher_cancel tests |
| Baseline of the user's tree | `a27aaf4` (2026-10-06) |
| The feature's hunks | `git diff a27aaf4 fork/wip/device-sync-handoff -- UI-source tools` |
| Library root | `D:\AIO\manga` (134 series, 159 GiB). Use a temp `AIO_OUTPUT_DIR` for every test |
