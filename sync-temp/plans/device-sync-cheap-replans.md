# Device Sync: decisions without full re-plans (plan rev 1)

Status: rev 1, APPROVED 2026-10-20 without P4 (user's call). Branch `wip/device-sync-handoff`.
Phase memory: `device-sync-feature.md` (points here once approved).
rev 0 → rev 1: the adversarial review (2026-10-20) found 18 defects; the ones
that changed the design are noted inline as (R#).

## Goal (user, 2026-10-20)

- Link in the Sync tab must not run a full re-plan. It rebuilds the plan from
  the cached prepare inputs and verifies only the newly linked folder on the
  device. One link per click (no batch link).
- Acknowledge (ack-anomaly / unack-anomaly) must not run a full re-plan.
- Audit every other user action that runs a full re-plan and fix the ones that
  don't need one.

## Why the problem exists

`preparePlan` (prepare.js) fuses two kinds of work:

- **Facts** (expensive, device + PC I/O): probe, record load, PC walk, root
  listing, gone stats, every folder listing + meta reads, PC hashing, name
  probes, coverage Verify.
- **Derivation** (cheap, pure): `planner.buildPlan({target, settings, pc,
  device, view, opts})`.

Every review decision changes only the target config or the record, i.e. the
derivation inputs, yet every config op ends in `_replanSoon` (service.js
`_configOp`), which queues a full prepare. Link also refuses `busy` while any
job runs (`H.link`), and the renderer disables the device-only Link button
while any job runs (SyncTab.jsx `DeviceOnlySection locked=`), so one Link
blocks the next until its full re-plan ends.

The code already derives from cache once: the rebind path in
`H["set-selection"]` re-runs `buildPlan` on `rt.prep`, and prepare returns
`planOpts` for exactly that. This plan makes that the general mechanism.

## Design: facts are cached, plans are derived, missing facts are topped up

### 1. `derivePlan` (prepare.js, new export, no device I/O)

`derivePlan({facts, view, target, settings, now})` → `{plan, device,
obligations}`.

- `facts` is what prepare measured, now returned whole: `probe`, `measured`,
  `pc`, `device`, `freeSpace`, `nameProbe`, `goneAnswers` (candKey → absent;
  candKey = shardId + its names), `hashAttempted` (paths), `verifyAttempted`
  (folders), `warnings`, `usedOpts`.
- `view` is the cached `rt.prep.view` for config-only decisions; it is
  reloaded from the store only when the record changed, and record changes now
  happen only inside lane jobs (§3). So a config op never touches the disk and
  can't race a header write (R1).
- `target`: the current resolved config, with the probed `volumeId` kept for
  folder targets (prepare step 1's rule).

Steps: gone candidates against the cached root dirs (cached answer, else a
**stat obligation**); included + mirrored + not-image-only files without
`sha256` and never attempted → **hash obligation**; drop `meta.aio` for
folders the view binds (`_readMeta` reads it only for unbound folders);
`buildPlan` with a copy of `nameProbe` (unanswered `needsProbe` → **stat
obligation**); `needsVerify` folders not in `verifyAttempted` → **verify
obligation** (R4: a folder whose verify failed is not retried until the next
full prepare, so Ack stays at zero device calls and nothing loops).

Needs-mode is decided here (R gap): verify obligations on a device that can't
hash (`facts.probe.caps.sha256sum` false, adb) with no `verifyMode` give the
same refusal `_needsMode` gives today, without first showing an interim plan.

**When the plan may be shown:**
- Stat or hash obligations outstanding → not adopted; the target reads stale
  ("Updating the plan…") until the refresh lands. A gone series would
  otherwise show as `folder-unreadable` with a spurious anomaly.
- Only verify obligations → adopted as an interim plan. The planner already
  models it: `needs-verify` state, unverified files never pre-select a delete
  (planner.js header 21-23). Rows show "Verifying…", or "Connect to verify"
  while disconnected (R gap).

### 2. Config decisions: `_derive(targetId)` replaces `_replanSoon`

- Falls back to `_replanSoon` with no `rt.prep`, a refusal, or no summary.
- A job of this target is running: set `rt.rederive`, mark stale. `_afterJob`
  honors `rt.rederive` for **every** phase and status (R6): derive from
  `rt.prep`, or `_replanSoon` if the job invalidated it (apply, prune, rename
  executed; identity cleared).
- A full plan of this target is pending (`stale` from the library watcher,
  settle timer, connect): derive and adopt nothing; the full plan reads the new
  config (R8: a derived adopt must not clear a stale that a full plan owns).
- Otherwise derive → adopt, or enqueue a refresh (§4).
- Settings changes set `rt.rederive` the same way (R14).

### 3. Link: a record write, so it runs in the lane

Link validates and **queues a bind** on `rt.pendingLinks`, then requests a
refresh. Every job of the target runs pending binds first, before its first
`store.load` (plan, verify, refresh preambles). Record writes then never race a
running prepare's load or its executor's `ensureHeader` (R1), and Link is
never refused `busy` by a plan or refresh.

- Validation runs against `rt.plan` **plus** `pendingLinks`: one folder and one
  series per pending link, so two clicks during a job can't give a series two
  shards (R2).
- Still refused during apply / prune / rename of that target (they hold their
  op lists; the existing selection-lock rule).
- Rows with a pending link read "Linking…"; the reply is `{ok, queued:true}`.
- The bind is today's code (`ensureHeader`, `bindFolder`, a gone shard rebound
  in place). The selection epoch rule then applies on adopt; deferred
  selection writes (`selDeferred`) are flushed after the bind, not wiped (R1).

### 4. The refresh job (new job phase `refresh`)

An automatic lane job that runs only the missing facts:

1. Run pending binds; reload the view if any ran; derive.
2. Seed the transport with the cached probe (new `transport.adoptProbe(probe)`
   sets the canonical root, caps and case flags). A fresh transport is unprobed
   (`_abs`, `_caps` in transports.js), and `probe()` lists the root (R5).
3. Stat obligations with the ENOENT rules of prepare step 6 / `_planWithProbes`.
   **A name that exists as a directory means the cached root listing is
   stale: escalate to a full plan, never a listing-suspect refusal** (R13).
4. Hash obligations through `hashPool` (cache lookups usually satisfy them).
5. Verify obligations through `_verifyFolders` with the **derived** prep (the
   pre-Link plan has the series as `new`, no shard: R10). The folder's fresh
   listing from the verify replaces its cached entry in `facts.device`.
6. Derive again (bounded by `PROBE_PASSES`); adopt. **A refresh's adopt never
   enqueues another refresh**; anything left is reported as a warning.

Queue (R7): `job-record` entries carry a kind. A plan request upgrades a
queued refresh of the same target; a refresh request is a no-op while a plan
is queued or running (the plan runs pending binds itself). `_pump` dispatches
on kind. Connect-prompt batches settle on plan jobs only, which is safe
because a connect always enqueues a plan.

Side effects (R9): refresh gets no `lastRun` (the last apply/verify card
stays); not in `QUIT_ASK_PHASES`; review `busy` counts a running refresh of the
target, so Start is gated instead of refused (R18); contract `JOB_PHASES`, the
`begin()` guard and the renderer's phase tables (copy.js last-run copy,
SyncDock verb/unit, syncView `planning`, connectView `workLine`) learn it.

### 5. One adopt path

`_adopt` is split so derived and full plans share the bookkeeping:
`rt.plan`, `rt.prep`, epoch rule, `_summarize`, `_armSettle`, `_planChanged`,
`_refreshLibraryStatus` when the record changed. **Gen always bumps** (R3):
the series sheet and the review re-read only on a gen change
(SeriesSheet.jsx `seriesDetail` effect, ReviewDialog.jsx), and the review
dialog already hides the "plan changed" notice when content is equal
(`reviewSig`). Today's full re-plans bump it too, so the renderer already
copes.

Warnings (R15): a derived summary drops the fact warnings it re-decided
(`pc-unhashed` for re-hashed paths, `verify-failed` for re-verified folders)
and appends the refresh's own.

### 6. Which actions use what

| Action | Today | After |
|---|---|---|
| Link | full plan; refused while any job runs | queued bind → refresh: bind, interim plan, verify of that one folder |
| Ack / unack anomaly | full plan | derive, zero device and disk I/O |
| Ignore / unignore suggestion | full plan | derive |
| Rebind with unprobed names (set-selection) | full plan | stat-only refresh |
| Aliases, namingPolicy, profile | full plan | derive; new names → stat refresh; a name hitting an unbound folder → verify refresh |
| Excludes, `only`, remove/include series, selection mode | full plan | derive; widening → stat/hash refresh as needed |
| formats, sidecars | full plan | derive; newly mirrored files → hash refresh |
| deletePolicy, renameToMatch, nomedia, cleanupNames, name | full plan | derive |
| verifyMode chosen after a needs-mode refusal | full plan | verify-only refresh (prepare now returns its facts with the needs-mode refusal) |
| Settings: delete policy, chapter patterns, size warn | full plan (all targets) | derive (all targets) |
| Settings: hash mode; identity (kind/serial/root); forget-record; add-target | full plan | unchanged (the cache is invalid) |
| Verify job (Re-check folders) | prepare, verify, prepare again | prepare, verify, refresh steps in the same job with the job's one-shot mode (R11) |
| After apply / prune / rename, settle timer, library watcher, connect, Re-check | full plan | unchanged in P1-P3; see Open decision 1 |

Safety is unchanged: apply always runs a fresh prepare and
`planner.reconcileForApply` (`_startApply`), so a review built from cached
facts can't cause an unreviewed write.

### 7. Renderer

- DeviceOnlySection gets separate locks: Link/Ignore by the selection lock
  only; Prune keeps "any job running" (R16).
- Series rows and sheet: "Linking…", "Verifying…", "Connect to verify".
- Stale dock line: "Updating the plan…" for a pending refresh or decision,
  "Something changed; re-planning…" for a full plan.
- Refresh phase in the job copy tables (§4).

## Phases

- **P1, facts + derive (prepare.js, transports.js; pure tests).** prepare
  returns `facts` (also with a needs-mode refusal); `derivePlan`;
  `adoptProbe`. Equivalence test: for each decision kind, derive + fulfilled
  obligations equals a fresh `preparePlan` (op ids, states, suggestions,
  anomalies, needsVerify). Time `derivePlan` on a large synthetic record.
  Report.
- **P2, service.** Kind-aware queue, refresh job, pending binds in every job
  preamble, `_derive`, split `_adopt`, `rt.rederive` in `_afterJob`, config /
  settings / rebind / verifyMode routing, Verify job. Tests: device-call
  counts (ack 0 and no `store.load`; link = one folder verify, no `listRoot`;
  include of a gone series = stats only; formats widened = hashes only);
  decision during a running plan lands after it; two Links during a job;
  Link during a plan job binds before its load; refresh upgraded by a plan
  request; decision during apply re-derives after a blocked apply; a failed
  verify isn't retried by Ack; needs-mode from derive; stale cache escalates.
  Rewrite "Link a content match" (it waits for a plan job, R12). Report.
- **P3, renderer + fixtures + E2E.** Locks, row states, copy tables;
  regenerate gallery fixtures (`tools/_gen_sync_fixtures.js`); view tests;
  `tools/_e2e_device_sync_tab.js` Link and Ack flows. Report.
- **P4 (declined 2026-10-20, not built).** PC-only refresh for library
  changes and the settle timer: re-walk + hash, cached device facts.

## P1 outcome (2026-10-20, uncommitted)

- prepare.js: the result is the facts cache (`measured`, `goneAnswers`,
  `rootDirKeys`, `rootCrossChecked`, `hashAttempted`, `verifyAttempted`); a
  needs-mode refusal carries them as `prep`. New exports `derivePlan` (no I/O),
  `refreshPlan` (fulfils obligations), `verifyModeFor`. Section "cached facts".
- **Deviation:** `refreshPlan` (the refresh job's device work, §4 steps 2-6)
  moved from P2 into P1, beside `preparePlan`, so the equivalence tests can
  drive it without the service. P2 keeps the job, queue and routing.
- **Found while testing:** a refresh on a store the job hasn't loaded would
  let the executor mint a new record epoch and orphan every shard (store.epoch
  null on a fresh RecordStore). refreshPlan loads the store before a verify.
- executor.js: `verifyListings` (folder → the listing verify merged against);
  prepare and refresh plan against it instead of the older cached listing.
- transports.js: `adoptProbe(probe)` on both transports.
- service.js: `_stripFacts` keeps a needs-mode refusal's facts off the
  renderer (`rt.needsModeFacts`, used in P2).
- derivePlan costs 26 ms median on a 400-series x 12-file first sync.

## P2 outcome (2026-10-21, uncommitted)

- job-record.js: queue entries carry `kind` (plan | refresh); a plan
  upgrades a queued refresh in its slot. contract.js: `refresh` job phase;
  the `plans` event gains `updating` and `links`, and `stale` is true for
  either a full plan owed or a decision in flight.
- service.js: `_derive` / `_deriveNow` (serialized per target),
  `_requestRefresh`, `_startRefresh`, `_bindLinks` (single flight, also run
  at the start of every job), `_adoptPlan` (one adopt path, gen always
  bumps), `_replanAfterVerify` (Verify job and verifyFirst). Config ops but
  identity / forget-record route to `_derive`; settings but hash mode too.
- Deviations from §3:
  1. Link binds AT ONCE when no job of the target runs (queued only while
     one does), then re-reads the record (disk only) and derives. So the
     row shows needs-verify before the refresh runs, and a device that
     can't hash refuses needs-mode with no job at all.
  2. A decision on a target that owes a full plan (rt.stale) queues that
     plan if nothing has (a cancelled refresh, a drop on disconnect), so it
     never waits on a manual Re-check.
  3. verifyFirst (Re-check + Verify first) also replaces its second prepare
     with the refresh steps, like the Verify job.
  4. apply refuses `blocked` / plan-changed while `updating` (belt and
     braces; the renderer gates Start on `stale`).
  5. A stat/hash top-up with the device away marks the target stale; the
     reconnect's automatic plan delivers it.
  6. Unchanged on purpose: a rebind is still refused `busy` while any job runs.
- Not covered at service level: "a failed verify isn't retried by Ack" (the
  engine test in _test_device_sync_exec.js covers it) and a BLOCKED apply
  re-deriving (the test drives a completed apply: the decision lands through
  the plan the apply owes).

## P3 outcome (2026-10-21, uncommitted)

- useDeviceSync: the `plans` reducer carries `updating` and `links`.
- syncView.js: `jobOn().refreshing`; `linkIndex(pv)` (folders / series with
  a Link in flight); `liveState(row, ctx)` → linking | verifying |
  verify-offline | null; `dockStatus(...)` (moved out of SyncTab, now
  tested); `reviewGate` gains the `updating` reason ("Updating the plan…").
- copy.js `LIVE_STATE_COPY`; Ledger rows, the Only-on section and
  SeriesSheet show it. DeviceOnlySection's lock is split: Link / Ignore by
  the selection lock, Remove folders by any job.
- connectView: `workLine` reads a refresh (the no-plan screen after a
  needs-mode pick); a refresh never pulses the rail.
- Deviations: copy.js last-run table and SyncDock PHASE_VERB / UNIT get no
  `refresh` entry, since a refresh writes no last run and never uses the
  progress dock (comments there say so). "Verifying…" keys on `updating`
  or a running refresh, so a decision landing next to a failed-verify row
  shows "Verifying…" for that moment.
- Fixtures: `_gen_sync_fixtures.js recordLink` records `linking` and
  `verifying` snapshots in a world of their own; gallery cases
  tab-linking / tab-verifying / tab-verify-offline (the last synthetic).
- E2E `_e2e_device_sync_tab.js` flow 8: Acknowledge runs no job; Link runs
  one refresh, no plan job, binds the old folder.

## Fixes after the user's live test (2026-10-21, uncommitted)

1. **Link to an orphaned folder** (its series left the library; the record
   still has its shard). P2's bind-time clash check counted that shard as a
   clash and dropped the Link silently ("link dropped" in service.log). Now
   H.link rebinds the orphan's shard in place, and drops a gone series' own
   shard first when the series was gone (grep dropShardId). The committed
   pre-P2 code wrote a second shard naming the same folder instead.
2. **A library scan that changed nothing re-planned in full.** Opening the
   Sync tab scans the library for covers (SyncTab.jsx loadLibrary), main.js
   reported every scan as a library change, and 10 s later the target was
   re-planned in full; a Link clicked meanwhile waited behind it. User
   choice (option A over "only the Sync tab's scan stays quiet"):
   notifyLibraryChanged walks the library and re-plans only targets whose
   plan read a different library (pc-inventory.js pcSignature vs prep.pc;
   grep _afterLibraryChange). A real change still plans in full, so open
   decision 1 below stands.

## Risks

1. Derive drifting from a fresh prepare. Guard: the P1 equivalence test.
2. Facts age: a review can rest on minutes-old device facts. Same exposure as
   today between plans; apply re-prepares; any stat that contradicts the
   cache escalates to a full plan.
3. Main-thread cost of `buildPlan` per decision (no disk I/O on config
   decisions). Measured in P1.

## Open decisions

1. Closed 2026-10-20: P4 declined by the user. Library changes and the settle
   timer keep running full plans (always-current device facts).
