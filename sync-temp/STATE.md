# Device Sync — cloud phase state

The cloud session's stand-in for your memory entry `device-sync-feature.md`, which it can't write.
Your local session folds this file back into that entry when the work returns. It is a map, not a
log; git history owns the events.

## Where it stands (2026-10-06)

- **Parent plan:** `plans/add-this-script-s-features-linked-pumpkin.md`, approved 2026-09-30.
- **Non-UI plan:** `plans/c-users-legoc-claude-plans-add-this-scr-noble-truffle.md`, **draft rev 2,
  awaiting your approval.**
  - Rev 2 folds in the 2026-10-01 adversarial review of rev 1. Every finding was checked against the
    code and AOSP adb; the plan's last section holds the disposition table.
  - A second adversarial pass, on rev 2's new designs, is folded in before rev 2 is presented.
- **Next:** your approval. Then P0 (groundwork + environment check), reported together with P1
  (pure core).
- **No sync code exists yet.** `UI-source/electron/sync/` does not exist.

## Decisions taken in the cloud session (2026-10-06)

| Topic | Decision |
|---|---|
| Instance guard (review #7) | **App-wide single instance**: `app.requestSingleInstanceLock()` in main.js. A second launch focuses the first window. Dev and installed builds share userData, so they can no longer run side by side |
| Weak evidence (review #10) | **RECV + `adopted-size`**. Pending slots resolve by reading the file back and hashing it on the PC. A Verify without device `sha256sum` offers read-back (exact, slow) or adopt-by-size (`adopted-size`, never pre-selects a delete) |
| tools/ tests on this branch | **Force-add** (`git add -f tools/<file>`); drop with `git rm -r --cached tools` before shipping |

## Open decisions

1. From the plan's own "Open decisions" section: shipping with the in-flight work, the AIO-for-Android
   root, the downloader.js tree-kill, the push-in-place window, older devices, mid-phase checkpoint
   commits, sharded record vs journal, per-file acks, the prompt-mark residual.
2. P5's `AIO_USER_DATA_DIR` hook, if Chromium's `--user-data-dir` doesn't isolate the packaged
   test: ask first.
3. P5's `AIO_SEARCH_PROBE_DEADLINE`, only if measurement shows the probe phase dominates: ask first
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
