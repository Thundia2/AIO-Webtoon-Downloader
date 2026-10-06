# sync-temp — inputs for the Device Sync cloud session

This folder exists only on branch `wip/device-sync-handoff` of the fork
(`Thundia2/AIO-Webtoon-Downloader`). It carries everything that, until 2026-10-06, lived only on
the user's PC and that a cloud session needs to continue the **Device Sync** work: rebuilding the
CompareManga tablet-sync scripts as a general, UI-configured feature of the Electron app. The
contents:
- the plan files;
- the CompareManga scripts;
- the git-excluded CLAUDE.md files and the project memory;
- a metadata snapshot of the real library;
- the local test harnesses;
- digests of the two planning sessions, with every agent report.

## Rules for this branch (user directive, 2026-10-06)

- **This branch never goes to zzyil.** Never open a PR from it against
  `zzyil/AIO-Webtoon-Downloader`, and never push it to the `upstream` remote.
- **`sync-temp/` never ships.** `.gitignore` lists `/sync-temp/`, and these files are tracked on
  this branch only. Before anything ships, the shipping branch must not carry them:
  - either cut it fresh off `upstream/main` and bring over only the code, per the project
    CLAUDE.md's "How to ship";
  - or run `git rm -r --cached sync-temp`.
- **`tools/` is gitignored too** (`/tools/`, user directive "Don't ship tools"), and the plans put
  the sync tests there. A container reset loses untracked files. So on this branch, force-add
  (`git add -f`) any `tools/` file that must survive, and drop it the same way as `sync-temp/`
  before shipping.
- The branch also carries the user's **entire** in-flight local work, not only sync-related
  files. See "What the code commits hold".

## Where things stand — read this before the summary you were seeded with

**The summary your session started from is stale.** It says the CompareManga explorer was still
running and the plan was only a skeleton. The transcripts show more was done:

1. **The parent plan is approved** (2026-09-30 22:04, UTC+3):
   `plans/add-this-script-s-features-linked-pumpkin.md`.
   - The user then narrowed the work to the non-UI half.
   - They also said to pause before any UI work, for review. They will decide the course of
     action for the UI edits later.
2. **The non-UI plan is drafted** (2026-09-30 23:53):
   `plans/c-users-legoc-claude-plans-add-this-scr-noble-truffle.md`.
   - Its "Decisions this round" table holds the user's four answers.
   - All three explorers had finished by then: `sessions/S2-non-ui-plan-2026-09-30/agents/01`
     to `03`. That includes the CompareManga semantics inventory you were waiting on (`03`).
3. **An adversarial review of that draft returned** (2026-10-01 00:20) with 2 critical, 9 major
   and 14 minor findings: `sessions/S2-non-ui-plan-2026-09-30/agents/04-…`. **It has NOT been
   folded into the plan.**
4. **The user's last instruction was "Check the review's findings."** The session's final
   compaction summary (`sessions/S2-non-ui-plan-2026-09-30/compaction-summary-1-2026-10-01_0024.md`)
   lists the next steps:
   1. verify the review's load-bearing claims against the code and AOSP;
   2. fold the confirmed ones into the non-UI plan, and push back where the review is wrong;
   3. ask the user the decisions that are theirs (single-instance lock scope; adopted-size origin
      vs RECV + PC hashing);
   4. present the plan for approval.

No sync code exists yet: `UI-source/electron/sync/` does not exist.

## Read order

1. `context/CLAUDE.project.md`: the repo's CLAUDE.md, with its standing rules, invariants and
   per-feature pointer table. It is git-excluded on the user's PC (`.git/info/exclude`), so your
   clone does not have it.
   - Its "Where to find context" section was corrected on 2026-10-06. It no longer points at
     `~/.claude/plans/` files, because that folder is pruned at about 30 days.
   - Don't commit it to the repo root; read it from here.
2. `context/CLAUDE.global.md`, the user's global instructions: ask rather than pick, test before
   presenting, the comment policy, memory rules, agent rules. Then
   `context/output-styles/reports.md`, the report format those instructions require.
3. `context/memory/MEMORY.md`, then:
   - `device-sync-feature.md` (this task's phase state, written for this handoff);
   - the entries the plans lean on: `app-design-language.md`, `electron-app-local-e2e-testing.md`,
     `android-port-state.md`, `resource-limits-cpu-network-toggle.md`.
4. The parent plan (behavior rules 1-13), then the non-UI draft.
5. The S2 compaction summary named above, then the review it summarizes (`agents/04-…`).

## What's in here

| Path | What it is | Where it lives on the user's PC |
|---|---|---|
| `plans/add-this-script-s-features-linked-pumpkin.md` | Parent plan: the whole feature, UI included. Approved | `C:\Users\legoc\.claude\plans\` (pruned after ~30 days, so this copy is the durable one) |
| `plans/c-users-legoc-claude-plans-add-this-scr-noble-truffle.md` | Non-UI plan draft | same |
| `plans/komikkuspec.md` | The Komikku LocalSource spec the reader profile cites. Byte-identical to `git show 1f17a20^:komikkuspec.md`; that commit is unreachable from every branch, so your clone cannot produce it | same |
| `CompareManga.zip` | The **entire** CompareManga folder, 117 files: the scripts, their journal and hash caches (`.sync_state-<serial>.json`, `.pc_hash_cache.json`, `.tablet_cache.json`), run logs, `tablet_files.txt` and the Flask dashboard | `C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga` |
| `library-snapshot.zip` | `tree.tsv` (every library file: path, size, mtime_ns) plus a copy of every series-level sidecar (`.aio_series.json`, `details.json`, `.series_hid`, `.mangafire_hid`). Chapter archives and covers are listed only | `D:\AIO\manga`: 134 series, 23,106 files, 159 GiB |
| `local-tools/` | The repo's gitignored `tools/` scripts (`.js` and `.py`). The non-UI plan builds on `_test_update_check_hook.js` (its minimal hook runtime), `_test_update_check_record.js` and `_test_series_merge.js`. Copy them into `tools/` to run them | `<repo>\tools\` |
| `context/` | Repo and global CLAUDE.md, the report style, and the project memory as of 2026-10-06 | repo root; `C:\Users\legoc\.claude\`; `…\.claude\projects\C--Users-legoc-OneDrive-Belgeler-Scripts-AIO-Webtoon-Downloader\memory\` |
| `sessions/S1-parent-plan-2026-09-30/` | The session that wrote the parent plan and got it approved: the user's prompts and answers, 4 compaction summaries, the adversarial review of the parent plan, and the 9-agent census workflow (4 census, 4 verify, 1 synthesis; `09-synthesis.md` is the consolidated CompareManga brief) | transcript `da0c13c2-….jsonl` |
| `sessions/S2-non-ui-plan-2026-09-30/` | The non-UI planning session: the user's 4 answers, the 3 explorer reports (Electron main-process integration points; library, tests, packaging and Python writers; CompareManga semantics), the adversarial review of the draft, and the final compaction summary | transcript `62f6b154-….jsonl` |

**How the digests were made.**
- Thinking blocks are dropped.
- Routine tool calls (Read, Grep, Bash) are collapsed into counts, because their outputs can be
  re-derived from the code.
- Repeated history from session resumes is de-duplicated.
- The raw transcripts stay on the user's PC. Ask the user if a digest lacks something you need.

## Facts the plans assume about the user's machine

- **Paths.** The plans and digests use the user's Windows paths:
  - repo: `C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader` (OneDrive sync is
    off; it is an ordinary folder);
  - library root: `D:\AIO\manga`;
  - Electron userData: `%APPDATA%\aio-downloader-ui`. The dev, test and installed apps share it,
    so back up its JSONs before tests, and never run the NSIS uninstaller.
- **Line numbers** in the non-UI plan still match this branch (checked 2026-10-06):
  - the in-flight diff sizes it recorded are unchanged: 455 changed lines in `main.js`, 56 in
    `preload.js`, 197 in `library.js`, and `searcher.js` untouched;
  - five spot-checked anchors sit where it cites them: `library.js:148` and `:1118`, and
    `main.js:648`, `:1824` and `:1953`.

  Re-check any other line before relying on it.
- **Live-device steps** (adb against the tablet, serial `A06B4A372090333`) need the user's PC and
  their explicit OK. A cloud container has no device; the plans' fake adb server is the offline
  substitute.

## What the code commits hold

The branch starts from the user's local `fix/mangafire-cloudflare-challenge`:
- `fd73729` is the pre-squash #72. Its content is identical to `fork/main` (`f8e57c1`), but
  `git log` counts it as "ahead". Judge the branch by `git diff fork/main...`, not by `git log`
  (this is the CLAUDE.md squash-merge trap).
- `d1ae7d6` (android: track the Chaquopy port) was never pushed before this branch.
- **WIP snapshot**: the user's whole working tree on 2026-10-06, as 36 modified and 24 untracked
  files. It spans the Electron UI (`series-merge.js`, `update-check-record.js`,
  `useUpdateCheck.js`, `ChapterChips.jsx`, the identity helpers in `library.js`), the Android
  port, mangafire/comix/profile-lock work, and tests.

The sync plans depend on two of those in-flight pieces:
- `seriesIdentityKey` and `normalizeSeriesUrl` in `library.js`;
- `compareChapterLabels` in `series-merge.js`.

So the feature cannot ship ahead of that work (the plan's open decision 1).

## Keeping state across container resets

Your container can be reset, and you cannot write the user's local memory. Keep the phase state
you would otherwise put in memory in this folder (for example a `STATE.md`), and commit it.
- A **new** file here needs `git add -f`, because `/sync-temp/` is gitignored.
- Edits to files that are already tracked commit normally.

The user's local session folds this state back into `device-sync-feature.md` when the work
returns.
