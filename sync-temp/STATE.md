# Device Sync — cloud phase state

The cloud session's stand-in for your memory entry `device-sync-feature.md`, which it can't write.
Your local session folds this file back into that entry when the work returns. It is a map, not a
log; git history owns the events.

## Where it stands (2026-10-06)

- **Parent plan:** `plans/add-this-script-s-features-linked-pumpkin.md`, approved 2026-09-30.
- **Non-UI plan:** `plans/c-users-legoc-claude-plans-add-this-scr-noble-truffle.md`, **rev 4,
  approved 2026-10-06** ("Start with the plan").
  - Rev 2 folded in the 2026-10-01 adversarial review of rev 1.
  - Rev 3 folds in a second review of rev 2's new designs (0 critical, 9 major, 11 minor).
  - Rev 4 folds in your answers to open decisions 6, 10 and 11. Decision 10's new design got its
    own review.
  - Every finding of the reviews was checked against the code, AOSP adb and libuv. The plan's last
    section holds the disposition tables.
- **Now:** P0 and P1 are done and committed; P2 (adb wire client) waits for your go-ahead.

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
- `electron-app-local-e2e-testing.md`: once the single-instance lock lands, the dev app and the
  installed app can't run at the same time. Close one before launching the other; this applies to
  P5's packaged smoke too.

## Branch facts this state relies on

- Baseline: commit `a27aaf4` holds all in-flight work. `git diff a27aaf4 HEAD -- UI-source tools`
  yields the feature's hunks.
- `sync-temp/` and force-added `tools/` files never ship. The branch never goes to zzyil.
