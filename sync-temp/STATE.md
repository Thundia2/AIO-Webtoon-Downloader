# Device Sync — cloud phase state

The cloud session's stand-in for your memory entry `device-sync-feature.md`, which it can't write.
Your local session folds this file back into that entry when the work returns. It is a map, not a
log; git history owns the events.

## Where it stands (2026-10-07)

- **Parent plan:** `plans/add-this-script-s-features-linked-pumpkin.md`, approved 2026-09-30.
- **Non-UI plan:** `plans/c-users-legoc-claude-plans-add-this-scr-noble-truffle.md`, **rev 4,
  approved 2026-10-06** ("Start with the plan").
  - Rev 2 folded in the 2026-10-01 adversarial review of rev 1.
  - Rev 3 folds in a second review of rev 2's new designs (0 critical, 9 major, 11 minor).
  - Rev 4 folds in your answers to open decisions 6, 10 and 11. Decision 10's new design got its
    own review.
  - Every finding of the reviews was checked against the code, AOSP adb and libuv. The plan's last
    section holds the disposition tables.
- **Now:** P0 to P4 are done and committed. P5 (packaged smoke, live tablet) needs your PC.
  The local session starts from `sync-temp/HANDOFF-TO-LOCAL.md`.

## P4 service and integration (2026-10-07)

| Item | State |
|---|---|
| Modules | `UI-source/electron/sync/`: `service` (entry point: deps validation, every `sync:*` handler, the job lane, the facade main.js calls), `monitor` (`DeviceTracker`, `FolderWatcher`, `PromptMarks`, `PromptMachine`), `find-sources` (the search runner). `UI-source/electron/proc-kill.js` (tree kill; searcher.js uses it). `UI-source/src/hooks/useDeviceSync.js` (written and tested, **not mounted**) |
| Integration | `main.js`: guarded require, single-instance lock + `second-instance`, `whenReady` early return, `initDeviceSync` with all 14 deps, the close listener's sync term, library hooks (download, scan, delete, series-meta, metadata, real merge only), `applySettings` in save-settings, reinstall-python refusal + find-sources stop, `allSettled` in apply-now and window-all-closed, the `quit` hook. `preload.js`: 23 `sync*` wrappers + `onSyncEvent`. `searcher.js`: per-process cancel set, `cancelAndWait`, `cancelNow`, group kill |
| Engine edits | `contract`: `link` (23 channels). `executor`: public `ensureHeader()`. `prepare`: fills `canonicalRoot`/`caps` when the header lacks them, returns `planOpts`. Fake: `inject.trackFail` |
| Tests (force-added) | `_test_device_sync_service.js` 21, `_monitor` 23, `_contract` 57 checks, `_hook` 50 checks, `_main_isolation` 6 scenarios (194 checks), `_test_searcher_cancel.js` 8. All pass under node 22.22.0 and Electron 40's Node 24.15.0 |
| Dev-app smoke | `tools/_smoke_device_sync_dev.js` (Playwright `_electron`, xvfb, sync off), 3 runs on P4 and 3 on the P3 tree (`--baseline`): all pass. Quit after "Quit anyway": 320 / 403 / 376 ms on P4, 335 / 266 / 349 ms on P3. A fresh profile shows "55 changed" before its first Save on both trees (by design, `countDirtySettings`), so the smoke saves once through the UI before checking "Up to date". Minimize isn't observable under xvfb without a window manager, so restore-on-second-launch wasn't checked |
| Mutation check | 17 deliberate breaks of the new tests' subjects (hook 5, preload/hook literals 3, main.js hooks 8, service refusal keeping 1): each one fails its test. One main.js break was first written as a syntax error and was redone |
| Defects fixed | Pre-warm never ran for a target added after start; Forget-record refused `record-mismatch` (the cleared header's volume id); browse presets STA2'd through the `/sdcard` symlink; the hook dropped buffered events when the first get-state rejected |
| Regression | All 14 `tools/_test_*.js` pass on both Nodes (28 runs), the 5 pre-existing ones included; `node --check` on main.js and preload.js; `npm run build` exit 0 (1269 modules); esbuild transforms `useDeviceSync.js` (Vite doesn't compile it while unmounted) |
| Plan changes | Deviation 13 records your three P4 answers and the calls made in P4; the contract table gains `sync:link`; the channel count is 23 (P6's PARITY rows, the Figures row); Verification gets "Added at P4" |

## P3 engine (2026-10-06)

| Item | State |
|---|---|
| Modules | `UI-source/electron/sync/`: `store` (atomic writes, write queue, sharded record), `hash-pool` (inline workers, PC hash cache), `pc-inventory` (async library walk), `transports` (`AdbTransport`, `FolderTransport`), `executor` (apply, Verify, prune, folder rename), `prepare` (plan preparation; your P3 answer) |
| Core edits | `provenance`: `prevObserved` in pending resolution; first sync lasts until `header.firstApplyAt`. `planner`: `inputRefusal` and `isIncluded` exported; file-scope rename intents ignored by gone detection |
| Fake | `tools/fake-adb-server.js`: `realpath` (injectable symlinks), `sha256sum /dev/null`, `stat -f`, `df -P -k`, `find` with `!`, `-name` and `-exec … {} +`, `--` ending options; each tool can be switched off |
| Test | `tools/_test_device_sync_exec.js` (force-added): 49 pass under node 22.22.0 and under Electron 40's Node 24.15.0, and 3 repeat runs pass. `TEST_ONLY=<regex>` runs a subset. Core gains 2 tests (87) |
| Mutation check | 20 deliberate breaks of the engine's guards (runner in the session scratchpad; not kept). The first run missed 2, both test gaps: the `prevObserved` test used a foreign file, which an older rule already restores, and the hash-pool stall only shows with a lone task. Both tests were strengthened; all 20 now fail the suite |
| Defects fixed | The hash pool stalled a lone task after a failed worker start; a folder target's Verify and read-back accepted the hash of a file written while hashed; P1's `resolvePending` read an interrupted replace of a file the app never wrote as `partial` (ours); a coverage Verify on a first sync would have ended the first sync; the fake's `--` handling |
| Regression | `_test_device_sync_core.js` 87 and `_test_device_sync_adb.js` 90 pass under both Nodes; the 5 existing `tools/_test_*.js` pass; `npm run build` exit 0 (1269 modules); `node --check` on every sync module, `library.js`, the fake and the three tests |
| Plan changes | Deviation 12 records your four P3 answers and the calls made in P3; P3 lists `prepare`; the header field list gains `caseMeasured` and `firstApplyAt`; Verification gets "Added at P3" |
| P4 must add | An IPC channel for Link: the plan's `config-op` has no `link` op. The engine side is `RecordStore.bindFolder` |

## P2 adb wire client (2026-10-06)

| Item | State |
|---|---|
| Modules | `UI-source/electron/sync/adb/`: `wire` (pure codecs), `client` (host services, transport binding, shell, `SyncSession`), `locate` (`adb version`, `start-server`). No adb.exe client runs; `kill-server` is never sent |
| Fake | `tools/fake-adb-server.js` (force-added): server + adbd + an in-memory filesystem, AOSP adb @ `1cf2f01` behaviors plus the plan's injections |
| Test | `tools/_test_device_sync_adb.js` (force-added): 90 pass under node 22.22.0 and under Electron 40's Node 24.15.0. `TEST_ONLY=<regex>` runs a subset |
| Mutation check | 43 deliberate breaks across client, wire and the fake (list and runner in the session scratchpad; not kept). 39 fail the suite. The 4 that pass are known: the status checks at the loop top and after the source wait (the races back them up; removing every check fails), the guard on the source wait (equivalent: the pending status read ends with the socket too), and the fake's raised `delayed_ack` window (this container's loopback buffers alone hold enough; the window keeps the test meaningful on smaller buffers). The run found two defects, both fixed with a test: a FAIL landing while DONE waited on drain could come back as a watchdog `timeout` (DATA writes already raced the status), and the fake's read-ahead stalled 1.5 s per cycle under `delayed_ack`, which made the drain test flaky |
| Regression | `_test_device_sync_core.js` 85 pass under both Nodes; the 5 existing `tools/_test_*.js` pass; `npm run build` exit 0 (1269 modules); `node --check` on the three adb modules, the fake and the test |
| Plan changes | Deviation 11 records the calls made in P2; Verification gets "Moved at P2" (adb-test items that need later modules) and "Added at P2"; P5 gets a measurement of the wait between a push's last DATA and its OKAY |

## P1 pure core (2026-10-06)

| Item | State |
|---|---|
| Modules | `UI-source/electron/sync/`: `contract`, `naming`, `chapter-labels`, `sync-settings`, `profiles`, `provenance`, `analysis`, `planner`, `job-record`. Pure; nothing requires `electron` |
| In-flight edit | `library.js`: one appended line exporting `KOMIKKU_CH_RE` (grep `deviceSync`) |
| Test | `tools/_test_device_sync_core.js` (force-added): 85 pass under node 22.22.0 and under Electron 40's Node 24.15.0 |
| Mutation check | 12 deliberate breaks of key guards (adopted-size delete, blocking tags, name reservations, STA2 requirement, weak first-sync block, (id, sha) selection, reconcile signature, slot guard, devMtime in "ours", 5.10 ≠ 5.1, held-folder claim): each one fails the suite |
| Regression | The 5 existing `tools/_test_*.js` pass; `npm run build` exit 0; `node --check` on every sync module and `library.js` |
| Plan changes | Deviation 1's corrupt-shard rule corrected; deviation 10 records the planner calls; open decisions 12 and 13 raised |

## P0 environment check (cloud container, 2026-10-06)

| Check | Result |
|---|---|
| Node | Container `node` is v22.22.0; Electron 40.10.0 (from `npm ci`) runs Node 24.15.0. So the `tools/` tests run under both: plain `node`, and `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron` |
| `npm ci` in `UI-source` | exit 0 (the Electron binary downloads through the proxy) |
| `npm run build` | exit 0, 1269 modules transformed |
| Electron under xvfb | Works: `xvfb-run -a electron --no-sandbox` (root needs `--no-sandbox`). The real app also starts with an isolated `XDG_CONFIG_HOME` and `AIO_OUTPUT_DIR`, falling back from `localhost:5173` to `dist/index.html` (`main.js:542-546`). So P4's dev-app smoke can run here |
| Existing `tools/_test_*.js` on the baseline | All 5 pass: chapter_selection, date_version, series_merge (27/0), update_check_hook, update_check_record |
| Harnesses | `sync-temp/local-tools/*` copied into `tools/` (untracked there; `/tools/` is gitignored) |

## Decisions taken in the cloud session (2026-10-06)

| Topic | Decision |
|---|---|
| Instance guard (review #7) | **App-wide single instance**: `app.requestSingleInstanceLock()` in main.js. A second launch focuses the first window. Dev and installed builds share userData, so they can no longer run side by side |
| Weak evidence (review #10) | **RECV + `adopted-size`**. Pending slots resolve by reading the file back and hashing it on the PC. A Verify without device `sha256sum` offers read-back (exact, slow) or adopt-by-size (`adopted-size`, never pre-selects a delete) |
| tools/ tests on this branch | **Force-add** (`git add -f tools/<file>`); drop with `git rm -r --cached tools` before shipping |
| Commits (open decision 6) | **Commit and push at each phase stop**, after its tests are green; no mid-phase checkpoints |
| A bound folder deleted on the device (open decision 10) | **Re-push it ticked**, under a name you choose that **defaults to the old device folder name**. Gone is derived at each plan (trusted listing absent + STA2 ENOENT), never persisted. A `record` match (≥90% of the gone shard's entries in an unmatched folder) counts as strong and unticks the pushes; ≥50% of ≥10 bound folders gone needs a mass-repush acknowledgment; a decline sticks for later chapters too. Drawing the name choice is the UI pass's job |
| Large `pending` files (open decision 11) | **RECV at every size** |
| Link (P4) | **Its own channel**, `sync:link {targetId, suggestionIds}` → `{ok, linked}`; refused `busy` during a job; queues a re-plan. 23 invoke channels |
| Pre-warm (P4) | **30 s after launch, or at once on enable**, at the Resource Limits CPU level; pauses while a download, Check All, a search or a sync job runs |
| Find-sources' "Queue N downloads" (P4) | **The UI pass's job**, through the download IPC plus `config-op add-alias`; main only stores and runs rows |
| Plan preparation (P3) | **A new `prepare.js`**; it persists `entryFixes`/`shardNameFixes`, and `service.js` only calls it |
| Case probe (P3) | **No device writes; the flag is saved in the header.** Flip an existing name's ASCII case and STA2 it; with nothing to flip, assume case-insensitive and probe again at the next connection |
| `connecting` during a run (P3) | **Wait up to 60 s, then end the run `disconnected`** |
| Prune and `adopted-size` (P3) | **Keep them as leftovers**; prune deletes only `pushed`, `adopted` and `partial` files proven ours |

## Open decisions

1. From the plan's own "Open decisions" section (6, 10 and 11 are decided):
   - shipping with the in-flight work;
   - the AIO-for-Android root;
   - the downloader.js tree-kill;
   - the push-in-place window;
   - older devices;
   - sharded record vs journal;
   - per-file acks;
   - the prompt-mark residual (marks honored for 30 minutes).
2. Raised in P1, implemented with my pick, awaiting your confirmation (plan open decisions 12, 13):
   - weak (`name`/`similar`) adoption matches block pushes only on a first sync (parent rule 2 as
     written);
   - a fork is the same identity whatever the derived names.
3. P5's `AIO_USER_DATA_DIR` hook, if Chromium's `--user-data-dir` doesn't isolate the packaged
   test: ask first.
4. P5's `AIO_SEARCH_PROBE_DEADLINE`, only if measurement shows the probe phase dominates: ask first
   (it touches the in-flight `search_orchestrator.py`).
5. Calls made in P4 with my pick (plan deviation 13), for your confirmation:
   - a job's device refusals arrive in its end (`summary.refusal`, kept in `plans[id].refusal`),
     not as the invoke's answer;
   - a target never applied to keeps its selection in memory for the session only;
   - the executor's `isPathBusy` stays unwired (`getRunning()` has no folder paths); `settling`
     covers a file a download is writing;
   - a second launch during the ≤5 s quit wait opens no window (`appQuitting`).

## Handoff obligations for the UI pass

Also in the `service.js` header.
- Render `payload.sync` (`{target, phase, done, total}`) in ConfirmQuitDialog; a sync-only close
  would say "0 downloads are still running".
- Mount `useDeviceSync` in App.jsx, and call its `refresh()` after a save that flips
  `syncEnabled`.
- Choose which presets to expose.
- Draw the name choice for a re-pushed gone folder (`rebind`, `removedOnDevice`; decision 10).
- Add the sync keys to `get-settings` together with `DEFAULT_SETTINGS`, plus the settings-twin
  test.
- "Queue N downloads" for find-sources rows: the download IPC plus `config-op add-alias` per
  accepted row.

## Defect ledger (shipped defects found while exploring; outside this feature)

Each item was confirmed by the S2 explorers and the rev-1 review. Fold these into memory as ledger
entries.
- `delete-series` and `delete-temp` run `fs.rmSync(…, {recursive:true, force:true})` with no
  library-root containment (`main.js:1059-1068`, `:817-826`).
- `reinstall-python` deletes python-env without cancelling running downloads (`main.js:1824-1842`).
- `save-settings` always answers `{ok:true}` (`main.js:709`), while `history.js:_saveJson`
  (`:102-137`) swallows write errors and falls back to a non-atomic copy.
- `comix:login` spawns with only `{...process.env, PYTHONUNBUFFERED}`, without `extraEnv`
  (`main.js:937-941`). So Playwright can miss its browsers in packaged builds.

## Memory rewrites owed when the work returns

- `device-sync-feature.md`: rewrite from this file.
- `electron-app-local-e2e-testing.md`: the single-instance lock landed in P4, so the dev app and the
  installed app can't run at the same time. Close one before launching the other; this applies to
  P5's packaged smoke too.

## Branch facts this state relies on

- Baseline: commit `a27aaf4` holds all in-flight work. `git diff a27aaf4 HEAD -- UI-source tools`
  yields the feature's hunks.
- `sync-temp/` and force-added `tools/` files never ship. The branch never goes to zzyil.
