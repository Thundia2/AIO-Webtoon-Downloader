# Device Sync — UI pass (plan rev 1)

> **Durable copy.** At implementation start, copy this file to
> `sync-temp/plans/device-sync-ui-pass.md` (force-add it), because `~/.claude/plans/` is pruned
> at about 30 days. Rewrite the phase memory `device-sync-feature.md` so it points at that copy.

## Context

The backend of Device Sync is finished. Device Sync is CompareManga's adb tablet mirror, rebuilt inside the Electron app.
- The engine and service live in `UI-source/electron/sync/`.
- There are 23 `sync:*` channels plus the `sync-event` push.
- The renderer hook `src/hooks/useDeviceSync.js` is written but not mounted.
- P0–P5 are done. The user deferred the live tablet run until the UI exists.

This plan is the UI pass: everything the user sees and touches. It also repairs the backend contract wherever the UI census and the adversarial review found that the UI could not be built safely on it.

**Baselines:**
- Approved UI design (2026-09-30): `sync-temp/plans/add-this-script-s-features-linked-pumpkin.md`, lines 230–327. It is kept except where a decision below replaces it.
- Non-UI plan rev 4: `sync-temp/plans/c-users-legoc-claude-plans-add-this-scr-noble-truffle.md`.

## User decisions (2026-10-15)

| # | Decision | Answer |
|---|---|---|
| 1 | Visual design, including the "will copy" colour | **Design round first.** "Start a design agent at the start of the plan to do some mockups that I choose from. Only the mockup I approved will be seen by the main session." It covers the whole Sync UI, with 2–3 directions. |
| 2 | Storage gauge | **Add free space to the plan** (backend). |
| 3 | Backend contract gaps | **Fix them first**, each with a test. |
| 4 | Where target settings live | **Both.** "Device specific settings (like folder location) get saved per-device in the UI. Settings tab shows all devices while the sync tab only shows the currently connected device's settings." |
| 5 | Confirming a loss (a removal that leaves a chapter on neither side) | **One tick per series**, naming the count. |

## Evidence that shapes the plan

Every row was read this session; the file:line is the source.

### The backend already computes the view

- `planner.planSummary` (planner.js:1715) returns ledger rows carrying:
  - the chapter strip `[{state, count, from, to}]`;
  - counts, tags, `rebind` and `hasLoss`;
  - `syncNow: {eligible, reasons[]}` (:1468).
- `seriesDetail` (:1670) returns per-file rows with `selected`, `loss`, `lossIfSelected` and `blockedBy`.
- `promptSummary` (:1503) returns `verifyBytes` and `removedOnDevice`.

**So the renderer renders; it computes no sync logic of its own.**

### The strip has six states

They are `synced`, `push`, `warn`, `delete`, `absent` and `other` (:1604-1662). The approved design gave no colour to `absent`.

### Safety holes in the contract (all confirmed by reading)

| Hole | Evidence | Consequence |
|---|---|---|
| Start can run a plan nobody saw | apply re-checks against the `rt.plan` current at job start (service.js:1366-1372); automatic re-plans swap that plan after config ops, links and downloads | Pre-selected sidecar or replacement deletes from a re-plan that lands while the review is open run unseen |
| One-time overrides have no effect | `_startApply` re-prepares with `{}` (:1370); `_replanSoon` drops overrides; `deletePolicy` isn't in the summary | A "Guarded" override shown in the review is not what apply does |
| Prune with no folder list removes every orphaned folder | :1387-1392 | One click with an empty list wipes every orphan |
| Prompt "Sync now" consumes the prompt even when refused, and skips targets silently | :1455-1457, :1467-1468 | The user clicks, nothing happens, and the prompt is gone |
| The "a download is writing here" guard is never wired | the Executor is built without `isPathBusy` (:854-867); `getRunning()` carries no folder (downloader.js:981-992) | Apply can copy a series mid-download. The fix needs folder resolution, not just wiring |
| Selection changes are accepted during an apply | no busy check for non-rebind changes (:1306-1311) | Toggles appear to take effect but don't |

### Data gaps the UI would trip over

- No free space in any payload; only the executor reads it, at apply time (executor.js:319-341). Both transports implement `freeSpace()` (transports.js:592, :1047).
- `set-selection` rebuilds the summary without `warnings` (service.js:1303/1310 vs :826). The planner's own `plan.warnings` (`alias-conflict`, `duplicate-op`, `pc-name-collision`) never reach the renderer.
- Push rows for new and gone series carry `reason: null`. The op has `new` or `removed-on-device` (planner.js:871 vs :878).
- A non-hashing adb device fails every automatic plan with `needs-mode`, nulls the summary, and quiets the connect prompt. The chosen verify mode is not remembered (prepare.js:286-296, service.js:716).
- Job results are overwritten within milliseconds: apply, prune and rename queue a re-plan before they finish, and the hook replaces `job` on the next begin event.
- The plan-summary refusal is cleared by `_adopt` (service.js:819), so `blocked` and `free-space` results exist only on the finished job.
- `config` is emitted before the identity clear runs, and `forget-record` emits nothing. The hook's re-read can land on a stale summary.
- adb tracking state, the job queue and settings are snapshot-only, with no event. `list-devices` omits `stateKind`.
- `get-state` while sync is off has no `specs` (service.js:956).

### Renderer facts

- **Missing primitives:** no Dialog, Sheet or Tooltip. Checkbox is boolean-only. Badge uses literal colours.
- **No virtualization anywhere.**
- **Colours:** there is no orange token. `--warning` is amber (hue 38); the "N new" badge is Tailwind `orange-500` (about hue 25), which sits next to it.
- **Deep links:** tabs unmount when you switch, so the mount-time `settingsCategory` already works for a deep link.
- **Width:** the window minimum is 800×550, so content is about 735 px and the Settings right pane about 506 px.
- **Icons:** lucide 0.263.1 has `folder-sync`, `tablet`, `smartphone`, `usb`, `hard-drive`, `refresh-cw`, `shield-check`, `link`, `unlink`, `eye-off` and `more-horizontal` (checked in node_modules).
- **Dev fixtures:** a fixture that sets `window.electronAPI` would crash useDownloader and App, which call unguarded APIs once `hasAPI` is true (useDownloader.js:41, App.jsx:48).
- **Library badge keys match:** library.js:632 and pc-inventory.js:68 both use `path.join` on the same root.
- **Badge gap:** `libraryStatus` skips excluded, image-only and unmirrored series. A missing chip therefore means "not mirrored".

## Design decisions

1. **Ask the system, don't copy it: plans are pushed.**
   - A new `sync-event` kind `plans` carries `{targetId, summary, refusal, stale, lastRun, gen}` whenever any of them changes: adopt, set-selection, refusal, identity clear, forget, a job finishing.
   - The hook drops its "re-read get-state after job or config" logic. That deletes the race behind the stale-summary and lost-result holes instead of patching it.
   - Events are coalesced per target.
2. **The plan generation is the review contract.**
   - The summary carries `gen`, which increments on every plan adopt.
   - `apply` and the prompt's `sync-now` must send the `gen` the user reviewed. A mismatch refuses `blocked {kind:'plan-changed'}`.
   - The UI disables Start while the summary is stale or a job runs on that target.
3. **One review channel.**
   - `sync:review {targetId}` returns every offered op grouped `{kind, reason, seriesKey, name, label, size, selected, loss, lossIfSelected, blockedBy}`, plus loss ids per series, the mass flags, capacity and `gen`.
   - Bulk selection gains `{group, reason}`.
   - Orphan removal leaves the review: prune is its own action with an explicit per-folder list.
4. **Planning options are per target and sticky, not one-time.**
   - `deletePolicy`, `hashMode` and `verifyMode` overrides live on the target's runtime record and are used by every prepare (automatic re-plans and apply included) until the user clears them or an apply completes.
   - The verify mode chosen after `needs-mode` is stored as a target field (`verifyMode`, added to `TARGET_FIELDS`).
   - The summary exposes the policy it was built with. The review header's controls become "Re-plan with…" actions.
5. **Target settings are a shared editor in two homes** (user decision 4).
   - `components/sync/TargetEditor.jsx` (immediate-persist `config-op`, always sending `expectVersion`) is used by:
     - Settings → Sync → Targets, which lists all targets;
     - the Sync tab's target panel, which shows only the targets on what is connected now: adb serial present, or `folderPresence` true.
   - Both carry the "Changes here save immediately" note (the disabledSites precedent).
   - Edits to identity fields (kind, serial, root, profile), which clear the record, need a two-click confirm naming the target: "forgets sync history for <target>".
   - The root stored is `browse-remote`'s canonical path.
6. **Settings plumbing.**
   - The renderer owns the eight defaults and preset lists next to `DEFAULT_SETTINGS`, per the SettingsTab-owns-defaults invariant. A tools twin test asserts they equal `SYNC_SETTING_SPECS`, which removes the dependency on `specs`.
   - main's `get-settings` spreads `resolveSyncSettings(saved)` without the parsed fields, so a first launch shows no phantom "8 changed".
   - Every preset is exposed.
   - Sections other than the enable switch gate on the hook's live `enabled`; in between they show "Save to turn on Device Sync".
   - Saving `syncEnabled: false` while an apply, prune or rename runs asks first.
7. **Losses** (user decision 5). The review lists each series' lost chapters by label with one checkbox ("Remove N chapters of <series> that aren't on your PC"). Ticking it adds that series' loss op ids to `ackLosses`. The mass-delete and mass-repush acknowledgments stay separate, each naming its count.
8. **Large lists.**
   - Ledger rows use `content-visibility:auto` with `contain-intrinsic-size` and are memoised by `seriesKey` plus a strip signature.
   - Series detail is never a flat list. It is grouped by action, with removals and losses expanded and the rest collapsed with a tri-state group checkbox. An expanded group renders 150 rows, then "Show 150 more".
9. **Selection is a serialized client of the server.**
   - Clicks within 150 ms batch into one `set-selection`, with one request in flight and a request sequence number. A response older than the latest is dropped.
   - Rows show a pending state until the reply arrives.
   - `set-selection` refuses `busy` while an apply, prune or rename runs on that target.
10. **Fixtures cannot drift.**
    - `tools/_gen_sync_fixtures.js` runs the real `buildPlan`, `planSummary`, `seriesDetail`, `promptCard` and `libraryStatus` over synthetic inputs and writes `src/dev/sync-fixtures/*.json`.
    - A DEV-only injection seam in `useDeviceSync`'s `api()` replays them, with a scripted event timeline. It never touches `window.electronAPI`.
    - A DEV-only `?gallery=sync` entry renders every state in a light and a `.dark` container side by side, at 735 px and at a wide width.
    - The production `dist` must not contain the fixture strings.
11. **The download guard resolves folders properly.**
    - The service gets `isBusyFolder(folderPath)` from main.
    - main maps each running download to its series folder: `seriesDir` when present (update-check downloads); otherwise a match of the download URL, through `normalizeSeriesUrl`, against the inventory's identity URL.
    - A brand-new series has no PC folder yet, and the 30 s settle age already holds its fresh files.
12. **Primitives.** `ui/overlay.jsx` gets `Dialog` (Escape, backdrop, focus return) and `Sheet` (two-phase rAF entrance like UpdatesCenter, token colours). Checkbox gains `checked="mixed"`. `utils.js` gains `formatBytes`. Existing dialogs are not migrated.
13. **The quit dialog** gains a sync branch: "Copying to <target>: 120 of 340 files", using `payload.sync`. For prune and rename, `quitInfo` reports the executor's own counts (backend fix).

## Phases (stop, report, and wait for the go-ahead after each)

### D — Design round (starts first, runs in its own session)

- **Proposal.** At implementation start, propose a separate session, "Device Sync UI mockups", via `start_session`.
  - Its fresh brief holds: the goal in plain words; the constraints (tokens copied from `globals.css`, both themes, 800×550 minimum, lucide 0.263.1, never bare "device"); every screen and state from the "UI inventory" below; the data shapes; user decisions 2, 4 and 5; the approved design as one option among the 2–3 directions; and the colour question (blue vs a dedicated orange token vs others).
- **How the user works.** The user works with that session directly. It shows the directions as private Artifact pages or HTML files in its own scratchpad.
- **Output.** It writes **only the approved direction** to `sync-temp/design/approved/`: the mockup HTML plus `spec.md` covering tokens, layout, the colour mapping for all six strip states, motion, and any surface choices (side sheet vs in-place detail, modal vs corner prompt, rail position).
- **Isolation.** The main session never reads that session's transcript or scratchpad.
- **Overlap.** U0 runs in the main session meanwhile, since it is backend only.
- **Stop point:** the user approves a direction, and `sync-temp/design/approved/` exists.

### U0 — Backend contract fixes (main session, during D)

| Area | Change | Files | Test |
|---|---|---|---|
| Review contract | `gen` on summary; apply and sync-now require it | service.js, planner.js | `_test_device_sync_service.js`: a re-plan between review and Start refuses `plan-changed` |
| Review data | `sync:review` channel; bulk `{group, reason}` | contract.js, service.js, planner.js, preload.js, useDeviceSync.js | contract drift test + service test |
| Sticky options | per-target `rt.overrides`; `verifyMode` target field; policy in summary; planning settings changes mark plans stale and re-plan | service.js, profiles.js, prepare.js | after a `needs-mode` answer, auto plans keep working; overrides survive an auto re-plan |
| Prune | refuses a missing or empty `folders` | service.js | test |
| Prompt | refuse before `answered`; the chain reports per target through `lastRun` | service.js | test |
| Download guard | `isBusyFolder` dep, main-side folder resolution (decision 11) | service.js, main.js, downloader.js (meta only) | executor test with a busy folder; main wiring by grep |
| Selection lock | `set-selection` busy during apply/prune/rename on that target | service.js | test |
| Push model | `plans` event; `lastRun[targetId]`; `config` emitted after `after()`; forget-record emits; `adb` event; `stateKind` in list-devices; settings applied → `enabled` change pushed | service.js, contract.js, monitor.js, useDeviceSync.js | hook reducer unit test (node, pure reducer) + service event-order test |
| Data | `capacity {free, needed, reserve, asOf}` in summary (free read once per prepare, `needed` recomputed on selection); summary keeps `prep.warnings` + exposes `plan.warnings`; push row `reason`; skip reasons and `skippedSeries` in `_runSummary`; prune/rename `quitInfo` counts | prepare.js, planner.js, service.js, executor.js | tests |
| Settings | `get-settings` spreads resolved sync keys; the renderer's sync defaults and presets; twin test | main.js, SettingsTab.jsx (constants only), `tools/_test_device_sync_settings_twin.js` | twin test |

- **Stop point:** all `tools/_test_device_sync_*.js` green, both smokes (`_smoke_device_sync_dev.js`, `_smoke_device_sync_packaged.js`) still pass, and `npm run build` clean.
- **Commit:** at the stop, commit and push to `fork` on `wip/device-sync-handoff`, per the branch rules in memory.

### U1 — Foundations and Settings → Sync (needs D approved)

- **Shared pieces:** primitives (decision 12), `components/sync/copy.js` (one map from every code, reason, state, `heldReason`, tag and warning kind to target-naming copy), the fixture generator, the injection seam and the gallery (decision 10).
- **App wiring:** mount `useDeviceSync` once. `TABS` becomes a `useMemo`, and the Sync tab shows only while the hook says `enabled`. The view falls back to Settings if the tab disappears while active.
- **Settings → Sync category:**
  - while off: only the enable switch and an explainer;
  - Device Sync: enable, prompt-on-connect;
  - adb: candidates, Browse with a `.exe` filter, Re-detect, tracking state;
  - Sync Defaults;
  - Targets: all targets in `TargetEditor`, the remote browser with the service's presets, aliases and excludes with `expectVersion`, danger actions;
  - Advanced: error budget, size warning, chapter patterns with a live `label-preview`, the diagnostic log toggle, "Open log folder".
- **Elsewhere:** the Komikku Output hint gains "…or turn on Settings → Sync". ConfirmQuitDialog gets its sync branch.
- **Stop point:** gallery states for Settings in both themes, at 735 px and wide; `npm run build` clean; turning sync on and off in the dev app, with no `userData/sync` writes while off (the existing dev smoke).

### U2 — Sync tab core

- **Layout:** target bar (picker, status, capacity gauge with an after-sync ghost, Re-check, Verify), summary tiles that double as filters, the ledger with Chapter Strips, and the series detail (sheet or in-place, per D).
- **Connected-device panel:** `TargetEditor` limited to what is connected (decision 5).
- **Selection:** batched, serialized and locked (decision 9).
- **Review:** built from `sync:review`, with "Re-plan with…" option controls, tri-state groups by kind and reason, per-series loss ticks, mass acknowledgments, the capacity check and the rebind name choice (`previous`, `derived`, or decline).
- **Progress mode:** throughput, ETA (`formatEta`), the current file, Cancel.
- **Refusal panel:** one entry per code with its primary recovery action:
  - `needs-mode`: a two-card chooser stored as the target's `verifyMode`;
  - `blocked`: a checklist including `plan-changed` and `free-space`;
  - `record-mismatch`: edit the target, or "Start fresh" (two-click `forget-record`);
  - `version-conflict`: adopt the returned config.
- **Last-run card:** from `lastRun`.
- **Device-only panel:** Link suggestions, plus prune with an explicit per-folder list.
- **Motion:** one orchestrated motion (rows stagger, strips sweep), honouring `prefers-reduced-motion`.
- **Stop point:** gallery states in both themes. The E2E (Verification) passes for a folder target: plan, deselect, apply, removal review, `record-mismatch`, `device-listing-suspect`, `plan-changed`. The packaged check is `npx electron-builder --dir` plus the unpacked exe against a temp library (`AIO_OUTPUT_DIR`, isolated `--user-data-dir`).

### U3 — Connect prompt and rail

- **Prompt card:** placement per D. It is driven by the live per-target `summary.syncNow`, not the frozen card:
  - Review / Sync now (sending `gen`) / Not now;
  - "Set up (verifies ~N GB)" on a first sync;
  - "Preparing (hashing N%)" from `prewarm`;
  - refused targets listed as needing attention.
- **Device states:** unauthorized and no-permissions get the red dot plus USB-debugging guidance. Authorizing and connecting get a spinner line.
- **Rail badge:** the count of series with pre-selected changes, a pulsing dot during a job, a red dot on a refusal, an unauthorized device, or a failed last run.
- **Stop point:** E2E: a folder appears, the prompt shows, Sync now applies, the last-run card appears. Gallery states for every prompt variant.

### U4 — Extras

- **Library:** a bottom-right MangaCard chip aggregated across targets: a count, a success check, or dim; none when not mirrored; never orange. A DetailView "Sync targets" row plus "Open in Sync" (an App `syncFocus` deep link).
- **Hook:** loads `libraryStatus` at enable and keeps the result.
- **Single find source:** App runs `dl.runSearch(derivedQuery)`, switches to Search with a one-shot `prefill` prop and a dismissible "Finding a source for <folder> on <target>" banner. A download started under the banner records `add-alias {url, deviceFolder}` before it is queued.
- **Batch find-sources:** device covers, editable queries, a seeded-only toggle, streamed rows, a review table (candidate pick, URL pin, Skip), and "Queue N downloads". For each accepted row it first calls `add-alias`, then `dl.queueDownload`, with Komikku mode following the target profile. Results are reported per row.
- **Stop point:** E2E with a folder target holding a device-only folder: find-sources against a recorded search fixture, then queue. Visuals in both themes.

### After U4

- The deferred **live tablet run** (`A06B4A372090333`), only with the user's OK and hands on the cable, writes only under `/storage/emulated/0/Download/aio-sync-test/`.
- Then P6 (docs: CLAUDE.md pointer rows and invariants, PARITY rows).

## UI inventory (states every phase must render; also the D brief's checklist)

- **Device states:** `device`, `unauthorized`, `no-permissions`, `authorizing`, `connecting`, `offline`, `targetable:false`.
- **adb tracking:** `stopped`, `connecting`, `tracking`, `polling`, plus `adb.error`.
- **Folder presence:** true, false, null.
- **Prewarm:** idle, running, paused (download, check-all, search, sync-job), done, error.
- **Series states:** bound, needs-verify, new, gone (rebind `fellBack`, `declined`, `chosen:null`), held, with the seven `heldReason`s.
- **The nine tags.**
- **Device-only folders:** orphaned and preserved; `listed:false`.
- **Job states:** each phase × `completed`, `cancelled`, `failed`, `disconnected`, with the reasons (unauthorized, no-space, read-only, record-write-failed, error-budget, internal, not-a-bound-folder, rename-refused-*).
- **All ten refusal codes** plus `internal:true`, `plan-changed`, `free-space`, and get-state's "could not start".
- **Warning kinds:** prepare, planner and executor.
- **Settling:** countdown to `settleAt`.
- **Selection:** pending state and toggles locked during a job.

## Verification

- **Unit and contract (node):** every `tools/_test_device_sync_*.js`, the new settings twin test, and the hook reducer test. `TEST_ONLY=<regex>` gives a fast loop.
- **Build:** `npm run build` clean, and `dist` free of fixture strings.
- **Visual:** the `?gallery=sync` page in the Vite dev server, driven with the built-in browser in both themes at 735 px and wide. Screenshots of every inventory state are compared against `sync-temp/design/approved/`.
- **E2E (dev Electron):**
  - Playwright-driven, an extension of `_smoke_device_sync_dev.js`.
  - Isolated `--user-data-dir` and a temp library (`AIO_OUTPUT_DIR`).
  - A folder target in a temp dir drives the full engine without adb. The adb browser and picker paths run against `tools/fake-adb-server.js` through a small runner and `ADB_SERVER_SOCKET`.
  - Flows: enable/disable, add target, plan, deselect, apply (files asserted on disk), removal review with per-series loss ticks, `record-mismatch`, `device-listing-suspect`, `plan-changed`, folder-appears prompt and Sync now, quit mid-apply (the dialog shows the sync line), find-sources then queue.
- **Packaged:** `npx electron-builder --dir`, then the unpacked exe (`_smoke_device_sync_packaged.js`). Never the installer: userData is shared, so back up its JSONs first (memory `electron-app-local-e2e-testing`).
- Each phase report names every check with its result and says "not run" for the rest.

## Open (not blocking; recorded in the phase memory at implementation start)

- Non-UI open decisions 1, 2, 5 and 7–9, plus 12–13 (weak matches block only on a first sync; a fork is identified regardless of names), are still awaiting the user's confirmation. The UI renders their outcomes and does not change them.
- Rail position, prompt modality and series-detail surface come from the approved D direction.
- `adb.tracking`'s `polling` mode exists in monitor.js but was not seen emitted live (census claim, not re-read).

## Deviations recorded while coding

- **U0-1 (2026-10-16): `hashMode: rehash` stays one-shot; only `deletePolicy` is sticky** (plus the stored target `verifyMode`). A sticky rehash would rehash the whole library on every download's automatic re-plan. Decision 4 otherwise holds (grep `_planOpts` in service.js).
- **U0-2: the download guard lives in the service, not behind a new main `isBusyFolder` dep.** `downloader.js getRunning()` rows now carry `seriesDir`; `service.js _busyCheck` matches it, else the download URL through `normalizeSeriesUrl` against the inventory's series URL. Same behaviour as decision 11 with one fewer cross-file seam.
- **U0-3: executor gained a test-only `prune-before-folder` hook point** (KILL POINTS convention), used by the quitInfo-progress test.
- **U0-4: no `job-queue` push event.** The queue stays snapshot-only (get-state); nothing in U1–U4 renders it yet. Revisit if a phase needs it.

## Design round outcome (2026-10-16) and phase U0b

The user approved **Transfer Desk rev 4**: `sync-temp/design/approved/spec.md` + `device-sync-ui.html`.
Spec §1 decisions D1–D9 are user decisions and override this plan where they conflict. The
backend consequences become **phase U0b**, folded into the U0 commit (user, 2026-10-16:
"Fold U0b into U0"), with the same stop/report/wait.

- **U0b-1 (D4 retires decision 4's sticky half):** no per-target planning overrides. Re-check's
  *Re-hash* / *Read back* are one-shot inputs to that one plan / verify job; automatic re-plans use
  the defaults. The stored target `verifyMode` (needs-mode answer) stays as the baseline. Supersedes U0-1.
- **U0b-2 (D5):** removal policy is a per-target field (`deletePolicy` in TARGET_FIELDS). Global
  `syncDeletePolicy` = "Removals for new targets" (the value stamped at target creation); a target
  saved without the field reads the global.
- **U0b-3 (D2): the prompt's `sync-now` path is DELETED** (user, 2026-10-16), with
  `syncNowEligibility` and the summary/prompt `syncNow` fields. prompt-response accepts
  review / not-now only. No route can start an apply without Review.
- **U0b-4 (D7): remove a series from a target = a saved exclude mark** (user pick A). Config ops
  `remove-series {seriesKey}` (exclude entry with `removeFiles: true`; also leaves the `only` list) and
  `include-series {seriesKey}` (drops every exclude of the series, mark included). Planner step 8b
  (grep `_planEvict`) offers delete ops, reason `removed-from-target`, for every chapter file and
  sidecar in the series' folder: record-proven files pre-selected, never-written-by-the-app files
  unticked, other types untouched. A delete is a loss only when the PC lacks that chapter too. They go
  through Review and count toward mass-delete. The executor lifts the PC-slot guard for that reason
  alone, then rmdirs the emptied folder and drops its shard (`result.evictions`), so a later Include
  is a NEW series, not a gone folder asking for a re-push name. The mark is cleared once the folder
  is gone; the exclude stays. Summary/detail rows carry `removing`.
- **U0b-5 (D8): renderer-only (U2).** The summary already carries `state`/`heldReason`; the ledger
  sorts held series last. No backend change.

## Phase U1 decisions and deviations (2026-10-16)

- **U1-1 (user): four reader presets replace "generic".** `everything` (default: all six formats,
  cover.jpg + details.json, `.nomedia`, no Komikku warnings), `komikku` (cbz/zip/cbr/rar/epub, both
  sidecars, `.nomedia`, warns on pdf / `~` / missing cover, never renames), `pdf` (pdf + cover.jpg +
  `.nomedia`), `custom` (the only reader where formats, sidecars, `.nomedia`, naming policy,
  rename-to-match and clean-up names are editable). validateTarget refuses those fields on a preset.
  Switching into Custom seeds them from the old preset's values; leaving Custom clears them
  (service.js update-target). No stored targets existed, so nothing migrates.
- **U1-2 (user): the reader is no longer part of the record identity.** `RECORD_IDENTITY_FIELDS`
  = kind, serial, root, volumeId (profiles.js); a preset change keeps sync history. This
  supersedes spec §4's "identity fields (kind, tablet, folder, reader)".
- **U1-3 (user): the Add-target draft card has a Reader field**, default Everything.
- **U1-4: get-state while enabled carries `logDir`** (Advanced → "Open log folder").
- **U1-5: the Sync tab is a placeholder** (`components/sync/SyncTab.jsx`) until U2; ChapterStrip
  and CapacityGauge move to U2 with their first consumer.
- **U1-6: the STATE.md obligation "call refresh() after a save that flips syncEnabled" is met by
  the hook itself**: a `settings` event that flips `enabled` re-reads get-state. The dev smoke's
  step 6 shows the rail tab appear and disappear through the UI.
- **U1-7: the gallery's config-op is a naive fake** (`src/dev/syncFixtureSource.js`); every other
  answer is recorded off the real service by `tools/_gen_sync_fixtures.js`. Re-run the generator
  after a backend change.

## Phase U2 design (2026-10-16)

Built from a draft, an independent design agent (goal + evidence only) and an adversarial review of
the draft; every load-bearing claim below was re-read in the code first.

**Backend (each with a test in `_test_device_sync_service.js` / `_core.js`):**
- **U2-1 auto-plan is the service's call, not the tab's.** `plan {ifNeeded:true}` plans only when the
  target is connected, has no summary or a stale one, nothing is queued/running for it, it holds no
  refusal, and its last plan attempt didn't fail or get cancelled since the last config / connect /
  library change. It goes through `jobs.enqueueAuto` (dedup). Why: a renderer rule ("no summary, no
  refusal") loops forever after a cancelled or internally-failed plan (both leave summary and refusal
  null, svc `_runJob` catch), never fires for a stale summary when prompt-on-connect is off (svc
  `_connected` returns early), and the tab unmounts on every tab switch so it can't hold a latch.
  The plan view gains `lastPlan {runId, status, reason, at}`; verifyFirst's needs-mode now goes
  through `_refused` like prepare's. Recovery buttons (needs-mode save, Start fresh) send no follow-up
  plan: the config op's own `replan:true` already queues one.
- **U2-2 acknowledgements are bound to what was shown.** The review stores each loss tick as
  `seriesKey → sorted lossOpIds at tick time` and drops it when that list changes; `ackLosses` sends
  only stored ids. `ackMassDelete` / `ackMassRepush` over IPC are the COUNT the user acknowledged;
  reconcileForApply blocks unless it equals the fresh count (`true` stays valid only for in-process
  callers/tests). Why: set-selection doesn't bump gen, so a gen-keyed reset misses selection-driven
  growth of the loss / mass-delete sets.
- **U2-3 selection echoes its sequence.** set-selection takes optional `gen` (mismatch → `blocked
  {plan-changed}`) and the plan view carries `selSeq` (last applied client seq). A pending checkbox
  clears when a pushed view's `selSeq` reaches its request, independent of reply/event order.
  `bulk:'series' {seriesKey, selected}`: false = every offered op off, true = delete the stored
  entries (back to the plan's pre-selection).
- **U2-4 summary rows gain** `counts.offered` / `counts.preselected` (tri-state + when the row box is
  useful), `attention: [reason…]` (held-not-excluded, anomaly, loss, blocked-by-suggestion,
  needs-verify, rebind fell back, unticked replace candidate), and the summary a `suggestionList`
  (id, seriesKey, deviceFolder, tier) so device-only rows can draw Link. Tile counts are trivial
  folds over these.
- **U2-5 capacity gains `total` and `after`.** Transports grow `storage() → {free, total}` (adb
  `stat -f %a %b %S`, df fallback; folder `statfs`); prepare reads it when present.
- **U2-6 settling re-plans itself:** `_adopt` arms `_replanSoon` at `settleAt + 1 s`, cleared by the
  next adopt.
- **U2-7 apply progress** carries `at` and `folder {key, landed, total}` (files actually landed, not
  skipped) for the transfer lane. No batch field: intentBatch is 1.
- **U2-8 `remove-series {removeFiles:false}`** = the detail sheet's Exclude.
- **U2-9 verify takes a one-shot `hashMode`**; the renderer's Read back always sends
  `mode:'read-back'`.

**Renderer:**
- **U2-10 the selection client lives in useDeviceSync** (app lifetime) as a pure FIFO reducer with an
  injected clock (`src/hooks/selectionQueue.js`, node-tested). `changes` and bulks never share a
  request; one in flight per target; locked while apply/prune/rename runs there.
- **U2-11 Start is enabled only when** review `(gen, selSeq)` matches the pushed view, not stale, no
  job on the target, no selection request pending, every ack ticked, `fits !== false`. A gen change
  from someone else shows "The plan changed. Review it again."; the user's own rebind resets acks
  silently. The detail sheet re-fetches on every `plans` push for its target (debounced).
- **U2-12 held rows:** Include only for `heldReason === 'excluded'`; Rename only for bound folders;
  a `removing` series stays in the main list (−N pill, Removals filter), not the dimmed held section.
- **U2-13 apply/prune refusals render on the LastRunCard** from `lastRun.summary` (the fresh re-plan's
  `_adopt` clears the plan-view refusal), de-duplicated against the plan-view refusal.
- **U2-14 tab state that must survive a tab switch** (chosen target, dismissed last-run ids) lives in
  App and is passed down.
- **U2-15 fixtures record real set-selection replies and the `plans` pushes that follow them**, so
  the gallery shows pending → settled and ack resets; the E2E reaches `plan-changed` by sending an
  old-gen apply through `page.evaluate` and asserts the UI's notice separately.

## Phase U3 design (2026-10-17)

Built from a draft, an independent design agent (goal + evidence only) and an adversarial review of
the draft; load-bearing claims re-read in the code. The plan's U3 bullets predate D2 and are
superseded where they differ: there is no Sync now (Review → the tab's Start), and "Preparing" reads
the connect plan's own job progress, not the pre-warm (`_runJob` pauses the pre-warm).

**User decisions (2026-10-17):**
- **U3-1 a connect always plans.** Every target that connects gets an automatic, read-only plan,
  also with "Ask when a target connects" off and on a connection whose mark is honored. The prompt
  rules (marks, focus) only decide whether a card shows. Why: the rail count needs a plan.
- **U3-2 Review lands on the Sync tab's series list** for that target (not the Review dialog). It
  answers the prompt `review`.

**Backend:**
- **U3-3 the prompt is live, the machine only decides open/closed.** PromptMachine allocates the
  promptId at connect (state `planning`), so a Preparing card can be answered: `respond()` accepts
  `planning` (the later `planned()` then stays silent, mark set). `pending()` lists planning
  connections `{promptId, connKey, serial, targetIds, since}`; they ride every `prompt` event and
  get-state (`pending`), and a `prompt {action:'pending'}` event goes out when the list changes.
- **U3-4 refused and failed plans are on the card.** promptCard takes the batch's `attention`
  entries `{targetId, targetName, code, message, firstSync, folders, bytes}` (code = the job's own
  `summary.refusal.code`, or `failed` with the reason; a cancelled plan is left out). A card with
  attention is not empty. prepare's needs-mode refusal gains `bytes` (planner `verifyBytesOf`) and
  `firstSync`.
- **U3-5 a batch can't hang.** `_batchDrop(targetId)` settles a batch when `_pump` skips a target
  (removed / disconnected / serial edited away), a plan can't begin, or `remove-target` runs.
- **U3-6 nothing left to do closes the card.** After a plan adopts, a shown or waiting prompt whose
  every target now has nothing to do and no refusal is withdrawn `{reason:'nothing-to-do'}`
  (PromptMachine `resolve`). The renderer never answers on the user's behalf.
- **U3-7 `list-devices` feeds the device diff** (`_onDevices`, source `manual`) when tracking is
  live, so "I've allowed it" / "Re-check" refresh what the card shows.
- **U3-8 a folder must be absent on two polls in a row** before a present folder counts as gone
  (FolderWatcher). A checkPresence timeout reads absent, so one slow poll re-prompted.

**Renderer:**
- **U3-9 the card** (`components/sync/ConnectPrompt.jsx`, mounted in App outside the tab area):
  bottom-right, 340 px, 16 px in, z above content; at most 2 cards, then "+N more". Lines come
  from the live `plans[tid].summary` when its gen ≥ the card's gen, else the frozen card summary
  (pure `promptView()` in syncView.js). Variant precedence per target: device state > preparing >
  needs-mode (Set up) > other refusal / failed ("needs attention") > ready.
- **U3-10 Set up** stores `verifyMode: 'read-back'` (config-op update-target; its replan reads
  back) and does not answer the prompt: the card shows "Reading back N%" from the job, then ready.
- **U3-11 Preparing** shows after a 2 s grace (fast plans don't flash) with the plan job's step and
  files done/total; its only button is Not now.
- **U3-12 device cards are renderer-derived** for configured adb targets whose device is
  unauthorized / no-permissions (red, guidance, "I've allowed it" / "Re-check" → listDevices) or
  authorizing / connecting (spinner), gated on prompt-on-connect; dismissed per serial + state.
- **U3-13 a card whose target the Sync tab is showing is hidden** (it would cover the dock's
  Review and start); it is not answered, so it returns on another tab until answered or withdrawn.
- **U3-14 rail badge** (pure `railBadge()` in syncView.js) over CONNECTED targets: count = distinct
  series with ticked changes (rows with a selected push/replace/rename/delete, union over targets;
  a stale summary still counts, so it doesn't flicker across re-plans; "99+"); red dot = a plan-view
  refusal other than needs-mode, a connected target's tablet unauthorized / no-permissions, or a
  failed / disconnected last run not dismissed and not a `plan-changed` block; pulse = a job running
  that isn't an automatic plan. Red wins over pulse; the count shows alongside either.

**U3 deviations recorded while coding (2026-10-17):**
- The pure card and rail logic lives in a new `components/sync/connectView.js` (`connectCards()`,
  `railBadge()`), not in syncView.js as U3-9 / U3-14 say: it is the corner card's own view model,
  and keeping it out of syncView.js keeps that file the Sync tab's. Unit tests bundle it separately
  (`tools/_test_device_sync_view.js`).
- Per-target precedence as built: running work (plan / read-back progress) > needs-mode (Set up)
  > other refusal / failed > ready / up to date / unknown. Device-state cards are their own cards,
  not a per-target variant, and a Preparing card is its own card kind.
- Red dot also fires for a connected target whose last automatic plan failed with nothing to show,
  and for ANY configured tablet that is unauthorized / no-permissions (it isn't "connected" in
  that state, so the connected-only filter would have hidden exactly the case it exists for).
- The rail dot moves to the top-left corner when a count pill shows (the approved mockup stacked
  both top-right and overlapped them).
- The card's ✕ is labelled "Dismiss" (same effect as Not now for a prompt card; for a device card
  it hides that serial + state locally) so the two controls don't announce the same name.
