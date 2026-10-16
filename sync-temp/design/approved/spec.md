# Device Sync UI: approved design spec (Transfer Desk, rev 4)

Approved by the user on 2026-10-16, after four revisions in the design round (phase D of
`sync-temp/plans/device-sync-ui-pass.md`). The companion mockup is `device-sync-ui.html` in this
folder. Open it in a browser; the top bar switches theme (light / dark / both), width (735 px
content / wide) and height (550 minimum / tall), and the screen strip walks every surface and
state. Where this spec and the mockup disagree, this spec wins.

The mockup is HTML, not React. Its markup mirrors `components/ui/primitives.jsx` and
`SettingsTab.jsx`, but the main session builds the real components; nothing in the mockup is
meant to be copied in verbatim.

## 1. Decisions the user made in the design round

These change the plan of record or the backend. Each one is a user decision, not a design option.

| # | Decision | Consequence outside the UI |
|---|---|---|
| D1 | **"Will copy" is the existing blue `--primary`. No new colour token.** | None. |
| D2 | **The connect prompt never offers Sync now.** Its blue button is Review. | `syncNowEligibility`, `promptCard.syncNow`, the prompt-response `sync-now` path and the U0/U3 items that send `gen` from the prompt have no UI caller. Delete them, or keep them unused (main session's call; record it). Every connect now goes through Review. |
| D3 | **Re-check and Verify are one button, "Re-check", with a dropdown** holding *PC files: Cached / Re-hash* and *Galaxy Tab S9: Trust record / Read back*, and a Re-check button that runs with them. Read back is the old Verify. | The renderer starts a `plan` for Trust record and a `verify` job for Read back (`sync:verify` stays). |
| D4 | **Re-check choices apply to that one Re-check only.** They reset to Cached / Trust record. What a Re-check learns (PC fingerprints, read-back results in the record) is kept. | This retires the sticky `hashMode` / `verifyMode` override half of plan decision 4. Automatic re-plans always use the defaults. |
| D5 | **Removals (Guarded / Add only) is a permanent per-target setting.** It is a quick switch in the target settings menu (the sliders button next to Re-check), and the same field in the shared TargetEditor. | The backend needs a per-target removal-policy field (`TARGET_FIELDS` has none today). The global `syncDeletePolicy` becomes "Removals for new targets", the value a new target starts with. This retires the sticky `deletePolicy` override half of plan decision 4. |
| D6 | **"Re-plan with…" leaves Review.** Review holds no planning controls. One read-only line says what the plan was built with ("Planned with guarded removals, cached PC files, and the tablet read back") and where to change it. | Review only ever shows a plan that already exists, so the `gen` contract (plan decision 2) is simple: Start sends the `gen` on screen; any option change rebuilds the plan with a new `gen` before Review can show it. |
| D7 | **A whole series can be removed from a target, only from series detail.** It is a red "Remove from Galaxy Tab S9" button next to Rename, with a two-click confirm. The second click reads "Click again: remove 318 chapters and stop syncing Eleceed". | **New backend action.** The planner never removes files of a series that is still in the library, so this needs an action that (a) excludes the series on that target and (b) adds delete ops for all its files on the target, which then go through Review like any removal. Without (a), the next plan copies the series straight back. |
| D8 | **Series that aren't synced sit at the bottom of the ledger**, under a "Not synced to Galaxy Tab S9 (N)" heading, dimmed, each with an Include button. | Excluded and other held series sort last regardless of the chosen sort. |
| D9 | **Library: a cover chip on each card, and a Sync line in DetailView.** The chip sits bottom-right on the card cover. The DetailView line joins the per-series facts under the file-stats line, with Open in Sync. It is not a floating panel. | Open in Sync is the App `syncFocus` deep link (plan U4). |

Two interactions resolved by these decisions:

- **needs-mode vs the Re-check menu.** The verify mode chosen after a `needs-mode` refusal is stored on the target (`verifyMode`). It is the target's baseline, not the Re-check menu's one-time choice. The menu's Galaxy Tab S9 row opens on Trust record. For a target whose stored mode is read-back, Trust record means "use what the record already proves", and Read back forces a fresh read. Don't merge the two into one stored value.
- **Copy no longer says "verify".** The first-sync prompt button is "Set up (reads ~9.4 GB)". Settings hints say "check" and "re-check".

## 2. Tokens

All existing tokens are copied verbatim from `src/styles/globals.css`. The design adds **one** token.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--warn-edge` (new) | `32 95% 36%` | `38 92% 55%` (= `--warning`) | 1 px inset edge on `warn` strip segments only. Light `--warning` on white is 2.14:1; the edge brings the segment to 4.51:1. |

Strip state aliases (`--st-*`) used in the mockup are just names for existing tokens. The real
code can use the tokens directly:

| State | Meaning (planner.js `chapterStrip`) | Fill | Light vs card | Dark vs card |
|---|---|---|---|---|
| `synced` | on the target, in sync or under a kept name | `--success` | 3.24 | 6.84 |
| `push` | selected push / update / replace | `--primary` | 5.54 | 4.33 |
| `warn` | replace candidates and extras (unselected) | `--warning` + `--warn-edge` inset | 4.51 (edge) | 8.31 |
| `delete` | selected delete or loss; **min-width 3 px** | `--destructive` | 4.80 | 3.71 |
| `absent` | on PC, not on target, not selected | transparent, 1 px inset `--muted-foreground / .85` | 3.59 | 3.79 |
| `other` | volumes, ranges, whole files, unparsed; drawn last | 135° hatch `--muted-foreground / .45` 2 px on / 2 px off, plus 1 px inset `/ .3` | n/a (pattern) | n/a |

- **Why blue for copy.** Measured distance (CIE76 ΔE) from every status colour: ≥113 in both themes. The candidates were worse:
  - orange (the old design) is ΔE 26 from amber `--warning` in light, and is the Library "N new" colour;
  - violet is ΔE 24–28 from `--primary`;
  - teal is ΔE 41–43 from `--success`.
- **Why blue doesn't clash with selection.** The strip only shows `push` for ticked ops, so the strip's blue and the checkbox's blue mean the same thing.
- **Blue next to green.** Adjacent `push` / `synced` segments are 1.7:1 against each other. They are separated by the strip's 1 px gap and differ strongly in hue; the tooltip on every segment names its range and state.
- **Badge colours.** The new surfaces use token-based badge variants, not the primitives' literal `green-500` / `yellow-500` / `red-500`. Light-theme warning text is `hsl(32 90% 34%)` and info text is `hsl(200 85% 34%)`, because the raw tokens are too light for text on white. Dark theme uses the tokens. Add these as Badge variants rather than literals.
- **Never orange** anywhere in Sync UI: orange is the Library "N new" badge.

## 3. Typography

- DM Sans for all UI text; JetBrains Mono with `tabular-nums` for counts, sizes, chapter labels (`Ch.021`), serials, paths, speeds and the plan id. No new fonts.
- Scale used: 11 / 11.5 / 12 / 12.5 / 13 / 14 / 15 / 17–19 px.
  - Ledger title: 13 px, weight 600.
  - Sheet and dialog titles: 15 px, weight 700.
  - Settings pane head: 19 px, weight 700 (as today).
  - Tile numbers: mono 18 px, weight 600.
  - Secondary lines and hints: 11–12 px muted.
- Sentence case everywhere. The only uppercase is the existing `SectionHeader`.
- **Copy rule:** never a bare "device". Name the target ("Galaxy Tab S9", "Komikku folder"). Where a target name can't fit, say "there" with the full name in a tooltip.

## 4. Layout and widths

The window minimum is 800×550: about 735 px of content, and a Settings right pane of about 506 px. The wide view in the mockup is 1280 px of content.

**Rail.** Sync sits **just above Settings**, and only while sync is enabled. Its badge has three forms:
- a count of series with pre-selected changes (primary pill);
- a pulsing primary dot while a job runs;
- a red dot on a refusal, an unauthorized tablet, or a failed last run.

The pulse is 1.6 s ease-out.

**Sync tab**, top to bottom:

1. **Target bar.**
   - Narrow layout, two rows. Row 1: picker (176 px), status ("Connected · listed 14:32"), and the actions on the right. Row 2: the gauge.
   - Wide layout, one row: picker (210 px), status, gauge (flex), actions.
   - Actions:
     - **Re-check ▾**, an outline xs button with a dropdown (D3);
     - **settings ▾**, the sliders icon with a dropdown holding Removals plus "All Galaxy Tab S9 settings…" (D5).
   - **Capacity gauge:** an 8 px pill on `--muted`.
     - used: `--foreground / .45`;
     - the "after sync" ghost: a 135° hatch of `--primary` at .85 / .45, 3 px stripes;
     - the reserve, at the right end: a destructive hatch.
     - Labels below in mono: "198 GB used · 58 GB free … after sync 51 GB free".
2. **Last-run card** and **refusal card**, when present, sit between the target bar and the tiles.
3. **Tiles**: five equal columns with an 8 px gap; each is also a filter, and the active tile gets a primary ring. The five are:
   - To copy · N series;
   - Removals to review;
   - In sync;
   - Only on Galaxy Tab S9;
   - Needs attention.

   Each tile has a 3 px bar in its strip colour.
4. **Ledger toolbar**: filter input, sort select, strip legend (swatches only when narrow; with labels when wide), and an overflow menu holding Export report (JSON).
5. **Ledger rows** (one per series), left to right:
   - tri-state checkbox;
   - 22×30 cover;
   - a title block, 178 px narrow / 300 px wide: the title, plus a state badge or one tag (two tags when wide);
   - the strip (flex);
   - count pills (`+N` copy, `−N` remove, `?N` decision; a green check when in sync), 76 / 120 px;
   - size, wide only (58 px);
   - a chevron.

   Rows use `content-visibility:auto` with `contain-intrinsic-size: auto 44px`. The strip is 8 px high when narrow and 12 px when wide. Series with a loss show a red warning icon after the title. Held series go last (D8). Folders only on the target form a final section, with Link suggestions, Find sources… and Remove folders….
6. **Sticky selection bar** (dock): "9 series · 452 files · 6.8 GB · 4 removals", a status line under it, and **Review and start** (primary).
   - The status line shows either the plan id and build time, or the settling countdown ("3 chapters of Eleceed are still downloading. They join the plan in 23 s").
   - During a job, the dock becomes the progress dock (section 6).

**Surfaces.**

| Surface | Choice | Size | Why |
|---|---|---|---|
| Series detail | **Right side sheet** over a scrim | 440 px narrow / 520 px wide | Keeps the ledger's scroll position and selection context; the UpdatesCenter precedent. |
| Connected-target editor | Right side sheet, opened from settings ▾ → All settings… | 470 / 560 px | Same TargetEditor as Settings → Targets, limited to the connected target. |
| Find sources (batch) | Right side sheet from "Find sources…" | 600 / 680 px | The review table needs width but belongs to the ledger's Only-on section. |
| Review | **Centered modal dialog**, the only place Start lives | 660 px narrow / 720 px wide, max height = frame − 32 px | One deliberate checkpoint before anything changes on the target. |
| Remove folders (prune) | Small modal with an explicit per-folder list | 520 px | Separate from Review; preserved folders (never synced by the app) are locked unticked. |
| Re-check ▾ / settings ▾ | Popover menus under the buttons | 310 / 300 px | Quick, non-modal; the choices are small. |
| Connect prompt | **Bottom-right corner card**, non-blocking, over any tab | 340 px, 16 px from the edges | Plugging a tablet in shouldn't block whatever the user is doing; the rail badge keeps the count after Not now. |

**Series detail sheet**, top to bottom:
- a 2 px primary accent line;
- a header: cover, title, PC → target paths in mono, tags;
- an xl strip (16 px) with first and last labels;
- groups by action (Copy · Replace · Rename on Galaxy Tab S9 · Already on Galaxy Tab S9 · Anomalies), each with a tri-state checkbox, a colour square, count, hint and size;
- a footer: Exclude from Galaxy Tab S9 · Rename on Galaxy Tab S9… · **Remove from Galaxy Tab S9** (danger outline, D7) · selected total.

Groups that need a decision (Replace, removals, losses) open expanded; the rest start collapsed. An open group renders 150 rows, then "Show 150 more" (the mockup shows smaller numbers).

**Review dialog**:
- Header: title, plan id and time, and the read-only "Planned with…" line (D6).
- Body:
  1. op groups by kind and reason, each with a tri-state checkbox, colour square, series count, file count and size, and a chevron that opens the group;
  2. one **loss tick per series**, in a destructive confirm strip ("Remove 3 chapters of unOrdinary that aren't on your PC" plus the labels);
  3. the **mass-repush** acknowledgement in a warning callout. It holds the **rebind name choice**: previous name / name from the PC / don't copy it back;
  4. the separate **mass-delete** acknowledgement, naming its count;
  5. a capacity line ("Fits: needs 6.8 GB, 57.6 GB free, 2 GB kept in reserve"), red with the shortfall when it doesn't fit.
- Footer: "N confirmations left" / "Ready", Cancel, and **Start sync · 452 files**, disabled until every acknowledgement is ticked and while the summary is stale.

**Settings → Sync** follows the existing two-pane category pattern; the Sync category is last in the nav.
- While off: only the switch plus an explainer. Once it's switched on but not saved, a callout says "Save to turn on Device Sync".
- While on, the sections are:
  1. **Device Sync:** enable, "Ask when a target connects".
  2. **adb:** a radio list of candidates (path + version), Browse… / Re-detect, and a tracking-state line for each state (watching, starting, polling every 5 s, not watching, error).
  3. **Sync defaults:** "Removals for new targets", "Checking PC files".
  4. **Targets:** a card per target, the expanded one holding the TargetEditor.
  5. **Advanced:**
     - error budget 1/3/5/10;
     - size warning 0/15/30/50%;
     - chapter patterns, with a live label-preview table and a test field;
     - diagnostic log switch;
     - Open log folder.
- Immediate-persist sections carry the "Changes here save immediately." note.

**TargetEditor** (shared; fields stack below about 560 px of width):
- name; kind (adb / Folder); tablet picker; folder plus Browse;
- the remote browser, with the four preset chips and a "Use this folder" button;
- **Removals (D5)**; reader profile with the Komikku hint;
- file types; also copy (sidecars); `.nomedia`; folder names; rename files to match PC;
- series (all-except / only, plus excluded chips); linked folders (dangling ones flagged in warning colour);
- clean-up names; and a danger zone with Forget sync history and Remove target, both two-click.

Identity fields (kind, tablet, folder, reader) carry a history icon. Editing one shows an inline destructive confirm strip naming the target: "This forgets sync history for Galaxy Tab S9…" with "Change folder and forget history" / "Keep current folder".

## 5. States the mockup shows (map to the plan's UI inventory)

| Screen in mockup | Covers |
|---|---|
| Sync tab | Plan landed: tiles, ledger, strip sweep, selection bar |
| Series detail / · remove from target | Detail sheet, grouped selection, Show more, anomaly acknowledge, D7 two-click armed |
| Re-check menu / Target settings menu | D3 / D4 / D5 |
| Target panel · only-on · settling · pending | Connected-target editor sheet; device-only section with Link and Find source; settling countdown; Frieren's row with a selection in flight ("saving", checkbox at 55% opacity) |
| Remove folders | Prune with an explicit list; preserved folders locked |
| Review / Review · confirmed + mass removal | Section 4 Review; Start disabled → enabled; mass-delete variant |
| Progress | Dock: current file, MB/s, ETA, files and GB done, batch, Cancel. Ledger checkboxes locked (muted). Copy segments fill green as batches land; that series is the transfer lane |
| Refusal panel | Every code: `needs-mode` (two-card chooser), `blocked` (checklist incl. plan-changed + free-space + loss), `record-mismatch` (Edit target / two-click Start fresh, shown armed), `device-listing-suspect`, `disconnected`, `busy`, `library-missing`, `version-conflict` (Use current settings), `invalid` (+ the `internal:true` wording), `disabled`, get-state "could not start" |
| Last-run card | completed (with skipped series), cancelled, failed (with reason), disconnected; every failure reason's wording |
| Connect prompt / variants | Ready (Review blue, Not now); first sync "Set up (reads ~9.4 GB)"; preparing (hashing %); two targets, one needing attention; unauthorized and no-permissions with USB-debugging guidance (red icon); authorizing and connecting spinners |
| Find sources | Batch sheet: covers, candidate select, URL pin, Skip / Include, "Queue 2 downloads". Second frame: single find, a Search tab banner "Finding a source for “Dungeon Meshi” on Galaxy Tab S9" |
| Settings × 4 | Section 4 |
| Rail badge | count / pulsing / red dot / none |
| Library extras | Grid chip (tablet + count, tablet + check in success colour, dim tablet = on no target yet, none = not mirrored), DetailView Sync line (D9) |

Not drawn but implied:
- the seven `heldReason` labels (data.js `HELD_REASONS` in the mockup source holds the wording);
- the nine tags;
- warning kinds from prepare / planner / executor. Render them as `co-warn` callouts above the tiles, same slot as refusals.

## 6. Motion

There is one orchestrated moment, plus motion that answers the user.

- **Plan lands** (the only unprompted motion):
  - rows fade and rise 4 px over 320 ms ease-out, staggered 28 ms per row and capped at row 12 (≤336 ms of total stagger);
  - each strip reveals left to right with `clip-path: inset(0 100% 0 0) → inset(0)` over 600 ms `cubic-bezier(.2,.7,.2,1)`, using the same per-row delay.
  - It runs only when a new `gen` arrives, never on a filter or a selection change.
- **Sheets** slide from the right, 220 ms `cubic-bezier(.2,.7,.2,1)`, with UpdatesCenter's two-phase rAF entrance.
- **Dialogs and popovers** appear without movement (opacity 120 ms at most).
- **Transfer lane:** during apply, the active series' copy segment fills with green from the left as batches land (a gradient stop, `--fill`), moving only on batch events, not on a timer.
- **Spinners:** 1 s linear rotation. **Rail job dot:** 1.6 s pulse.
- **`prefers-reduced-motion: reduce`:** every animation and transition is off. Rows and strips render at rest; the transfer lane still updates its fill instantly; spinners stop.

## 7. Primitives the build needs (from the mockup)

- `Dialog`, `Sheet` and `Popover` (the Re-check / settings menus) in `ui/overlay.jsx`; plan decision 12 lists only Dialog and Sheet.
- Checkbox gains `checked="mixed"`, plus visual `pending` (55% opacity), `locked` (muted, not clickable) and `danger` (destructive fill) variants.
- `SegmentedControl`, used for the Removals / Re-check choices, error budget and size warning, kind and reader.
- Token-based Badge variants (section 2).
- `ChapterStrip` with props `segments`, `size: sm | md | xl`, `lane` (fill %) and `targetName` (for tooltips).
- `CapacityGauge`.
