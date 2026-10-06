# Agent: Adversarial review of sync plan

- type: `Plan`  model: `inherit`  shape: `background`
- transcript (user's machine): `agent-ac8a719f8f79be674.jsonl`
- final report at: 2026-09-30 21:25

<details><summary>prompt</summary>

You are reviewing a draft implementation plan for a new "Device Sync" feature in an Electron + React app, before it is shown to the user. Your job is ADVERSARIAL REVIEW: find concrete defects, holes, infeasible assumptions and missing requirements in the plan, each backed by evidence from the codebase (file:line) or from well-established tool behavior. Do not rewrite the plan wholesale; return a prioritized findings list plus concrete fixes.

The plan file: C:\Users\legoc\.claude\plans\add-this-script-s-features-linked-pumpkin.md (read it in full first).

Repo root: C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader
- Electron main: UI-source/electron/ (main.js, preload.js, library.js, searcher.js, downloader.js, history.js, resource-limits.js, update-check-record.js, series-merge.js)
- Renderer: UI-source/src/ (App.jsx, components/SettingsTab.jsx, components/LibraryTab.jsx, components/SearchTab.jsx, components/ConfirmQuitDialog.jsx, hooks/useUpdateCheck.js, hooks/useDownloader.js, lib/utils.js, components/ui/primitives.jsx)
- Source scripts being ported (read-only reference): C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga (sync_to_tablet.py, push_all_to_tablet.py, manga_ops.py, transfer_runner.py, compare_manga.py, manga_manager.py, batch_search.py)
- IMPORTANT: the working tree has large UNCOMMITTED in-flight edits (git status shows M on main.js, preload.js, library.js, App.jsx, LibraryTab.jsx, utils.js, useDownloader.js, and untracked series-merge.js / update-check-record.js / useUpdateCheck.js / ChapterChips.jsx). Read the working-tree versions. Do NOT modify anything; you are read-only.

User requirements the plan must satisfy (verbatim decisions from the user):
1. Opt-in "Sync" tab on the left rail above Settings. A NEW Settings category "Sync" holds all permanent sync settings and initially shows only one option (enable the tab).
2. Stop hard-coding tablet folders and aliases; every CLI flag and exception (aliases and more) of the scripts must be settable in the UI. Adapt, don't transplant the scripts.
3. Targets: adb devices + plain folders; MTP only recorded as a future possibility.
4. adb: detect + manual path only (no download/bundling).
5. Deletes: "Guarded mirror with an option in settings to make it add-only and a one-time override like in the downloads tab. Of course the user will be able to choose for individual chapters."
6. Automation: prompt on device connect only if the app is focused; if unfocused, prompt on refocus.
7. Inline alias/exclusion edits from the Sync tab persist into Settings → Sync.
8. Start fresh: no import of old script state; first sync per device runs Verify.
9. Extras: Find source for device-only series (opens Search tab prefilled); batch find-sources + review table; Library tab device badges.
10. Engine: Node in Electron main (user chose this). Tests in tools/_test_*.js (local convention).
11. Use the existing design language (shadcn-style HSL tokens, DM Sans/JetBrains Mono, primitives) with frontend-design principles.

Review lenses — check each and report findings with evidence:
A. Feasibility of technical assumptions:
   - adb behavior: `adb track-devices -l` framing (4-hex-digit length prefix) and whether `-l` is supported; whether `adb push` prints per-file percentage progress when stdout/stderr are PIPES (not a TTY) — look at how CompareManga/manga_ops.py parsed progress and whether it synthesizes 100% (a hint progress may be absent); the adb 36 non-ASCII truncation workaround as ported; `find -printf` / `stat -c` fallback; `sha256sum` output parsing; `df -k` parsing.
   - Electron main-process worker_threads with `eval: true` inline source (asar concerns), `fs.statfs` availability (check UI-source/package.json Electron version).
   - Node child_process on Windows passing non-ASCII args to adb.exe; Windows command-line length limits vs the 50-file/12,000-char batch caps.
B. Safety model holes: guarded delete preselection ("recorded file whose label still exists after the sync" depends on the user's live selection — is it recomputed?), orphan vs preserved classification, rename-by-hash (mv) correctness, re-stat guard vs running downloads (downloader.getRunning() only returns {downloadId,title,url,startedAt} — see UI-source/electron/downloader.js ~981), what happens when a target's root or device changes (stale record), case-insensitive folder targets, collision handling, dangling aliases, mass-delete acknowledgment, quit/cancel/resume record consistency.
C. Architecture fit with existing code: IPC naming, sendToUI, quit gate (main.js ~555-569, ~1862-1873, ~1953-1961), ConfirmQuitDialog payload shape, settings draft semantics (SettingsTab.jsx countDirtySettings ~469-494, handleSave/handleReset, history.js saveSettings shallow merge), the immediate-persist precedent (disabledSites), useUpdateCheck buffering pattern, Searcher multiple instances (searcher.js constructor), resource-limits exports, library.js exports (note seriesIdentityKey/normalizeSeriesUrl exist only in the uncommitted working tree).
D. Requirement coverage: map each user requirement (1-11) and each script hard-code/flag (see the plan's mapping table; cross-check against the scripts' argparse and constants) to plan sections. Report anything missing or under-specified (e.g., per-chapter selection UX, what "one-time override" controls exactly, prompt behavior details, batch find-sources persistence/resume, library badge data freshness).
E. UI feasibility at the app's minimum body width (~736px: window min 800px minus 64px rail — see main.js createWindow minWidth and App.jsx rail w-16), both themes, and performance for large series (One Piece ~1197 chapters, ~130 series, ~20k files).
F. Anything the plan claims as verified that you can refute from the code.

Output format (final message is data for the main agent, not the user):
1. "Critical" findings (would cause data loss, wrong deletes, or an infeasible design) — each: claim in plan, evidence, fix.
2. "Important" findings (correctness/UX gaps) — same format.
3. "Minor" findings.
4. Requirement-coverage table: requirement → covered? → plan section / gap.
5. Any facts you verified that CONFIRM load-bearing plan claims (with file:line), so the main agent knows what not to re-check.
Be specific and terse. Cite file paths with line numbers from your own reads this session.

</details>

## Final report

I found five critical holes in the plan. Four are in the delete-safety model and one is a load-bearing claim that my measurements refute. There are 15 important gaps and a list of minor ones. Each finding below has evidence and a concrete fix.

Path roots used below: `[R]` = `C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader`, `[CM]` = `C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga`. Library measurements were read-only scans of `D:\AIO\manga`.

## 1. Critical (wrong deletes, data loss, or an infeasible design)

**C1. The first-sync auto-Verify removes the "device extras" protection.**
- **Plan:** `--verify` is kept as a port (plan line 58). It runs automatically when a target has no record (rule 8). Rule 4 says unrecorded extras are never pre-selected. Rule 5 says removing an orphan deletes its recorded files.
- **Evidence:** `[CM]\sync_to_tablet.py:752-767` clears each managed folder's record and re-records every hashed device file. It never compares them with PC hashes. Under "start fresh", every target's first sync runs this.
- **Effect:** every pre-existing device file in a managed folder becomes "recorded": side-loaded chapters, legacy PDFs, and device-only files like "Bleach Ch 0.pdf" (`[CM]\DELTA_FINDINGS.md:168`). Rule 4 then pre-selects them whenever their label is covered. Orphan removal later deletes content the app never pushed.
- **Fix:** give each record entry a provenance:
  - `pushed`: we wrote it.
  - `adopted`: Verify's sha equals the current PC sha for the same name in that folder.
  - `foreign`: anything else. These stay extras.
  - Only pushed and adopted entries count as "recorded" for rules 4 and 5. "Adopt by size" gets a weaker provenance.
  - A push that would overwrite a foreign file becomes a guarded "replace" op. It is not pre-selected and is excluded from Sync now.

**C2. Guarded "replacement" deletes are not tied to the replacement actually landing.**
- **Plan:** the planner is pure and sets `preselected` at plan time (line 86). Rule 4 says "label still exists on the device after the sync". Rule 6 orders pushes → deletes → quick verify, and allows delete-first on low space. Rule 7 keeps running until the error budget (3) is spent. The re-stat guard can skip pushes.
- **Hole:** the replacement push can fail below the budget, be skipped by the re-stat or running-download guard, or be unticked by the user. Delete-first mode can also run the delete first. In each case the pre-selected delete still runs and the chapter disappears from the device. The script avoided this only because it deleted first (`sync_to_tablet.py:815-822`).
- **Fix:**
  - Recompute coverage and loss from the live selection. Unticking a push must re-flag or untick the deletes that depend on it.
  - The executor runs pushes, then a listing, then each delete. A delete runs only if its (unit, label) is still covered by a file verified present with exact name and size, or the user accepted that specific loss.
  - Delete-first mode applies only to non-replacement deletes, or does a per-file delete → push → check.

**C3. Case or normalization variants: pushing first, then deleting, removes the just-pushed file.**
- **Plan:** rule 1 matches folders on NFC equality. The executor now pushes before it deletes, which reverses the script's order.
- **Hole:** NTFS folder targets are case-insensitive, and Android shared storage is typically case-insensitive (sdcardfs or FUSE casefold).
  - A retitle that only changes case (`Ch.012 - mission 12.cbz` → `Ch.012 - Mission 12.cbz`) also changes the hash, because ComicInfo changes. Pushing N overwrites O's file. `rm -f O` then deletes the new chapter while the record says N exists.
  - At folder level, device `Spy x family` vs target `SPY x FAMILY`: `mkdir -p` lands in the existing folder, listing keys never equal record keys, so every sync re-pushes and the folder is misclassified as preserved.
- **Fix:**
  - Use a fold key (NFC + casefold) for file and folder names.
  - Treat fold-equal O and N as the same slot: rename through a temp name, or overwrite without deleting.
  - Never delete a path whose fold key equals a desired or just-pushed name.
  - Probe the target's case sensitivity once in `probe()`.

**C4. Pre-selection classes are too broad and label equality is too lossy.**
- **Plan:** rule 4 also pre-selects "a recorded non-chapter managed file". Labels get parity with library.js "by construction".
- **Evidence:**
  - `[R]\UI-source\electron\library.js:231-241` normalizes labels via `parseFloat`, so `005.10` becomes `5.1` and collides with `005.1`. The script deliberately keeps them distinct (`compare_manga.py:258-277`).
  - `library.js:195-206`: range files yield ranges, not labels.
  - Numbering sources really do diverge. `[CM]\REDOWNLOAD_FOR_KOMIKKU.md` has JoJo Part 5 at "PC 155, tablet 324" from a "different chapter-numbering source".
- **Fix:**
  - Pre-select only two kinds of file: sidecars (cover.jpg, details.json), and unit=chapter files whose exact canonical label string (no float collapse) is covered by a verified-landed file.
  - Never pre-select whole, volume, range or unknown units.
  - Suppress all delete pre-selection for series tagged numbering-mismatch, different-start or device-ahead.

**C5. The suggestion layer cannot rebuild the 14 old aliases (refutes plan lines 64, 117 and 192).**
- **Measured** with compare_manga's `normalize_series_name` plus the stored `anilist_synonyms`:
  - 0 of the 13 pairs whose PC folder still exists match exactly.
  - Token Jaccard is 0.00 for CØDEBREAKER, Is_the_order_a_rabbit, Makeine, Record of Ragnarok (it has zero synonyms) and SPY_x_FAMILY.
  - For SPY_x_FAMILY, `×` survives NFKC, and the synonyms are `SxF` plus Korean, Chinese and similar. There is no "SPY x FAMILY".
  - Only `anilist_synonyms` is stored (`aio-dl.py:7789`), and AniList synonyms exclude the English and romaji titles.
  - The old Fullmetal Alchemist alias already dangles: its PC folder no longer exists.
- **At stake:** 2,021 files / 14.17 GB of duplicate new-folder pushes on the first sync, plus duplicate series in the reader.
- **Fix:**
  - Add a content-fingerprint suggestion: overlap of exact (filename, size) pairs between a device folder and a PC series. Measured against the old record it matches 154/155, 235/235, 135/137, 101/101, 27/27 and 191/191, so treat ≥90% as strong.
  - On a record-less first sync, don't pre-select create-new-folder pushes while any preserved device folder is still unmatched above a weak threshold.
  - Add Ø/ō/×→x folding and space-insensitive comparison as secondary signals.

## 2. Important

- **I1. No per-file push progress when output is piped.**
  - `grep -c "%]"` returns 0 in `[CM]\full_mirror_stdout.log`, `full_mirror_stderr.log`, `push_run.log` and `canary_stderr.log`. Only per-invocation summaries appear, e.g. `full_mirror_stderr.log:9`: `…: 290 files pushed, 0 skipped. 28.0 MB/s`.
  - `manga_ops.py:157-162` assumes `[ NN%]` lines, and lines 244-249 synthesize 100%.
  - So "current file" and "segments fill as files land" (plan lines 156 and 163) only update once per batch. That is about 375 MB at the 7.5 MB average file size, or tens of seconds.
  - The summary lines also lie on failure. `[CM]\sync-log-20260706-221724.json` (Bleach) shows "1 file pushed" next to each `failed to read copy response: EOF`, and "50 files pushed", with rc=1.
  - **Fix:** add a byte cap per batch, report progress by batch and bytes, trust only the exit code plus a listing, and drop "current file".
- **I2. The device-lost signature won't match.** The real message is `adb.EXE: device 'A06B4A372090333' not found`: 106 instant failures in the same log. The plan's literal `device not found` misses it. Use `/device '[^']*' not found|no devices\/emulators found|device offline|failed to read copy response|protocol fault/`, and classify `unauthorized` separately.
- **I3. The `stat -c` fallback is dead code in the source being ported.** `compare_manga.py:533` sends find's stderr to `/dev/null`, but line 543 detects the fallback from stderr. Line 546 accepts rc≠0 whenever stdout holds the directory list. On toybox without `-printf` (Android ≤9) you get an empty listing that is silently treated as truth, so everything (171 GB) is re-pushed. **Fix:** a capability probe in `probe()`, plus a sanity check that blocks apply when a managed folder lists 0 files but has N record entries.
- **I4. Unbounded `rm -f` command.** `sync_to_tablet.py:394-403` and `816-818` build one command for all of a series' deletes. The plan's prune change (delete recorded files, then `rmdir`) turns One Piece's roughly 1,197 paths into a ~100 KB command. That exceeds Windows' 32,767-character CreateProcess limit. Chunk the commands, or pipe NUL-separated paths through stdin (`xargs -0 rm -f --`).
- **I5. The record isn't bound to the target, and Verify coverage isn't tracked.**
  - "Auto-verify when no record" misses three cases: a first Verify killed partway (the script flushes per folder), folders newly linked by alias after Verify, and a changed root or device serial (stale record).
  - The first two cause full re-pushes of already-present folders. The third feeds a stale record into orphan decisions.
  - **Fix:** a record header of `{deviceSerial, canonical root, profile}` plus a per-folder `verifiedFolders` set. Verify any managed folder that lacks coverage before planning. On a header mismatch, ignore the old record for deletes and orphans.
- **I6. Target-name changes cause orphan + full re-push instead of a rename.** This happens on a naming-policy switch, an alias edit, a retitle, or a collision winner flip. **Fix:** store the owner's PC identity per device folder in the record, and propose a device-side folder `mv` plus record re-key.
- **I7. A missing or empty PC root** makes every recorded folder an orphan and prunes the hash cache. D: is removable, so this is a real case. pc-inventory must fail hard, not return [], and must not prune on a failed walk.
- **I8. Rules contradict each other on legacy extras.** "Only files of mirrored types are ever proposed" (plan line 65) conflicts with "Select covered extras handles legacy PDF→CBZ" (line 122). The Komikku profile mirrors .cbz only, so the PDFs are "unmanaged". Legacy PDFs were the norm: `[CM]\REDOWNLOAD_FOR_KOMIKKU.md` lists 59 of 67 tablet series as PDF-only. **Fix:** define a "chapter-like foreign" class, `{pdf,cbz,zip,cbr,rar,epub}` (as in `[CM]\_classify_tablet.py:27`), that is user-selectable and never pre-selected.
- **I9. The find-sources Searcher bypasses main's search environment.**
  - `new Searcher({onLog})` omits `extraEnv`, so Playwright handlers silently drop out in packaged builds (`main.js:609-623`, `searcher.js:85-99`).
  - `disabledSites` and `collapseSplits` are injected in the renderer (`useDownloader.js:1055-1068`), not in `search:run`, so the batch search would ignore them.
  - `cancel()` sends SIGTERM to python.exe only. The downloader uses `taskkill /t` (`downloader.js:951-954`).
  - **Fix:** inject `buildPythonEnv()` (`main.js:393-403`), rebuild those opts from settings, kill the process tree, and cancel on quit.
- **I10. The quit gate needs concrete changes.**
  - The close handler at `main.js:556` checks only `downloader.runningCount()`.
  - `ConfirmQuitDialog.jsx:44` keeps only `running`, and all of its copy and buttons are download-specific (lines 100-104, 133-139, 143-148), so a sync-only quit would say "0 downloads…".
  - `reinstall-python` (`main.js:1824-1842`, `app.exit`) doesn't cancel.
  - **Fix:** a `{running, sync:{target, phase, done, total}}` payload with sync-only copy, and make reinstall refuse, or cancel and flush.
- **I11. main.js needs more than an init call and quit hooks.**
  - `save-settings` (`main.js:694-710`, following the `appUpdater.applySettings` precedent) must notify the service so the monitor starts or stops and picks up a new adb path.
  - `syncAdbPath` is a draft key, while the target editor persists immediately, so the device picker would use a stale saved adb. Make it persist immediately, or pass the draft path.
- **I12. No lock on config changes during a running job.** Forget record, Remove target, root/device/profile edits or alias edits mid-apply conflict with the executor's in-memory record, which would overwrite a Forget. Refuse or queue ops that affect a target while its job runs.
- **I13. Library badge freshness.** Snapshots update only when a plan runs, so a series that just finished downloading still shows "synced ✓". Recompute PC-vs-record status offline on library scan and download-complete, and keep only the device-side facts "as of <time>".
- **I14. The selection model is under-specified, and "renderer re-plans instantly" is not literally feasible.**
  - Missing: where deselections live (main, keyed by op id, persisted per target), how long they last (pushes vs deletes), and whether per-chapter toggles sit in the sheet or the review dialog.
  - `Checkbox` is boolean-only (`primitives.jsx:177-208`), so group toggles need a tri-state version.
  - `electron/` is CommonJS and `src/` can't import it (the mirror-twin note at `library.js:61-64`). Re-plans must run in main from cached inputs.
- **I15. Polling folder targets with `existsSync` blocks the main thread** when the root is an offline network share (SMB timeout). Use async stat with a timeout and an in-flight guard.

## 3. Minor

- Pass `windowsHide: true` on every adb spawn. Every existing spawn does (`downloader.js:730`, `searcher.js:138`).
- `track-devices -l` rows are `%-22s %s`, space-padded rather than tab-separated, with `transport_id` last (use it as the connectionId).
  - On Linux the state can be several words ("no permissions (…)").
  - Parse frames as raw Buffers; "decode once at the end" doesn't work for a stream.
  - Capture real adb.exe piped output in Phase 2 to rule out CRLF translation.
- Parse `%s|%T@|%p` with indexOf. JS `split("|", 3)` truncates names containing `|`.
- Use `stat -f -c '%a %S'` or `df -P -k` rather than parsing `df -k` output.
- Canonicalize the remote root with `realpath`, or append `/` for find. `find /sdcard` doesn't descend a symlinked root, and the script's root was `/storage/self/primary/Documents` (`compare_manga.py:56`).
- Library shape: 22,759 mirrorable files, 171 GB, 568 non-ASCII source paths (one push each), longest path 234 characters.
  - On the default Documents root (about 35 characters longer) paths pass 260, and adb.exe likely hits MAX_PATH.
  - Mitigation to prove in Phase 6: spawn with `cwd` = the series folder and relative file names.
- After a killed batch, adopt files that landed with exact size, rather than re-pushing up to a full batch.
- Quick verify should remove byte-prefix truncation artifacts of this run. Otherwise they become permanent extras; see the 434/434 repair at `synclogs07.md:1644-1656`.
- `stripHidSuffix` should use the script's regex (`compare_manga.py:107`, which accepts `(hid=)`), not `downloader.js:395`, which needs a non-empty hid. No empty-hid folders exist today, so this is an edge case.
- Settings pane: the nav is `clamp(176px, …)` (`SettingsTab.jsx` ~2801), leaving about 508 px of content at minimum window size. The alias table and target editor must stack.
  - `minWidth: 800` (`main.js:527`) is the outer window size (no `useContentSize`), so the body is somewhat under 736 px. Measure it.
- Chapter Strip: give delete and loss segments a minimum width. One chapter in a 1,197-chapter strip is about 0.2 px.
- An orange pending-push chip clashes with the existing orange "N new" badge (`LibraryTab.jsx:423-428`).
- 8 new draft keys will show "Save Settings · 8 changed" once to existing users (`SettingsTab.jsx:460-465`). Main must default-resolve the sync keys without a defaults dict (the triad in `CLAUDE.md` ~124); consider resolving them in `get-settings`, as `main.js:659-665` does.
- Validate cleanup names as dot-files only; otherwise a name that is also mirrored gets deleted and re-pushed every sync.
- App-initiated `runSearch` silently cancels a user's running search (`searcher.js:119-124`).
  - The SearchTab prefill changes behavior every time the user returns to Search.
  - Confirm the device-folder link in the download dialog.
  - Re-key URL aliases to the identity key once the series folder appears.
- Server mismatch: all three adb binaries report protocol 1.0.41 (36.0.2 in Scripts\ADB, 37.0.0 in the SDK and scrcpy v4.0), so the kill-fight the plan cites shouldn't happen here. The mismatch message only appears after our client has already killed the server, so check with a raw `host:version` on port 5037 before the first command.
- Make the collision winner sticky, so the winning folder doesn't flip and churn deletes.
- Define whether add-only still allows renames.
- Clean up leftover FolderTransport temp dot-files.
- Add a `sync:label-preview` IPC so the custom-pattern test uses the main-side labeler.
- The first cold hash of 171 GB delays the first connect prompt; pre-warm or show a preparing state.
- Specify whether a device already attached at app start counts as a "connect".
- The `CLAUDE.md` verification suite has 8 items, not 7 (`CLAUDE.md:157-187`).
- The plan says Phase 2 proves workers in a packaged build, but Phase 2's stop point is a tools script.
- The metadata key is `anilist_synonyms`; 21 of 132 metadata files have none.
- Requirement 2 gaps: map compare_manga `--report-file`/`--json-out` (export) and manga_manager `--host/--port/--no-browser`, `-q/-v/--no-color` (N/A). A third alias table exists: `_compare_tablet_vs_pc.py:43`, plus `_delta_findings.py:42` PUSH_MAP.
- fake-adb should also emulate:
  - piped output with no progress lines;
  - the `device 'X' not found` message;
  - rc=1 with misleading "N files pushed" lines;
  - a case-insensitive filesystem;
  - a missing `-printf`;
  - the `-l` row format.

## 4. Requirement coverage

| # | Covered? | Plan section / gap |
|---|---|---|
| 1 Opt-in tab + Sync category showing only the enable switch | Yes | Rail, Settings → Sync. Gap: gate on draft or saved `syncEnabled`; Reset turns sync off. The component-local SECTIONS (`SettingsTab.jsx:2770-2788`) allows conditional sections. |
| 2 Every flag/exception configurable | Mostly | Mapping table. Gaps: report/export flags, N/A flags and the third alias table (see Minor). |
| 3 adb + folders, MTP later | Yes | Decisions table, transports.js |
| 4 adb detect + manual path | Yes | adb.js / picker. Gap: I11 (draft adb path). |
| 5 Guarded mirror, add-only setting, one-time override, per-chapter choice | Partial | Rule 4, review dialog. Holes C1–C4; selection model I14. |
| 6 Focus-aware prompt | Yes | monitor.js, rule 10. Gaps: device attached at startup, several targets at once, withdrawing on disconnect, transport_id. |
| 7 Inline edits persist | Yes | store.js ops. Gap: I12. |
| 8 Start fresh, first sync verifies | Partial | Rule 8. Gaps: C1, C5, I5. |
| 9 Find source, batch, badges | Partial | Gaps: I9, I13, lifetime of batch rows. |
| 10 Node in main, `tools/_test_*.js` | Yes | Confirmed: `tools/` is gitignored and the convention exists. |
| 11 Design language | Mostly | Gaps: Settings pane width, strip minimum width, orange clash, tri-state checkbox. No Dialog, Sheet or Tooltip primitives exist, so those are hand-rolled (as ConfirmQuitDialog and UpdatesCenter already are). |

## 5. Load-bearing claims I confirmed (no need to re-check)

- `--fast` by default is safe for AIO writers:
  - metadata edits write fresh `mkstemp` files (`[R]\metadata_editor.py:36-64`);
  - `copy2` copies from fresh caches (`aio-dl.py:13026-13032`);
  - `os.utime` appears only in tests.
- Electron 40.10.0 (Node 24): `fs.statfs` and eval workers are available. lucide-react 0.263.1 has `folder-sync`. The `electron/**` build glob includes `sync/`. `asar: true`.
- The adb 36.0.2 binary contains `usage: adb track-devices [-l][--proto-text][--proto-binary]` and `host:track-devices-l`. Push batch caps (12,000 chars + quotes) stay far below 32,767.
- Non-ASCII arguments reach adb.exe correctly: the script's explicit pushes of non-ASCII names landed intact (`sync_to_tablet.py:443-452`).
- Quit gate, apply-now and window-all-closed are at `main.js:555-569`, `1862-1873` and `1953-1961`. `getRunning()` returns only `{downloadId, title, url, startedAt}` (`downloader.js:976-993`). series-merge maps running jobs to folders by normalized URL (`series-merge.js:415-422`).
- `seriesIdentityKey` and `normalizeSeriesUrl` exist only in the working tree (HEAD's export list lacks them). utils.js has `formatEta`, `chaptersToRangeString`, `naturalCompare` and `cn`, and no `formatBytes`. LibraryTab's `formatSize` differs (GB to 2 decimals).
- `countDirtySettings` (`SettingsTab.jsx:469-494`) uses reference equality, so scalar keys are fine. `saveSettings` merges shallowly (`history.js:230`, `useDownloader.js` saveSettings).
- Searcher state is per instance (`searcher.js:104`). `cpuPercentForLevel` returns 25/50/75/100.
- DownloadTab's per-job override is pre-filled from settings and never saved back (`DownloadTab.jsx:803, 917`).
- Tokens `success`, `warning`, `info` and `destructive` exist in both themes (`tailwind.config.js:46-48`). DM Sans, JetBrains Mono and `animate-slide-up` exist.
- MangaCard's bottom-right corner is free, and cards are at least 140 px wide (`LibraryTab.jsx:2268`).
- The 106-failure incident is real (n_fail=107). compare_manga can't parse `Ch.NNN - Title.cbz`.
- The claim that store.js twins `history.js:_saveJson` is inaccurate. `_saveJson` (lines 102-137) has no retry: it falls back to a non-atomic `copyFileSync` and swallows errors. Write a real retry for the sync record.

### Critical Files for Implementation
- C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga\sync_to_tablet.py
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\main.js
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\electron\library.js
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\src\components\SettingsTab.jsx
- C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\UI-source\src\components\ConfirmQuitDialog.jsx
