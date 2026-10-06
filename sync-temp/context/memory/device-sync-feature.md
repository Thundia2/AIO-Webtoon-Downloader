---
name: device-sync-feature
description: "Device Sync (CompareManga's adb tablet mirror rebuilt inside the Electron app) — phase state, where the two plans live (durably in sync-temp/plans/ on wip/device-sync-handoff), and the handoff-branch rules (never to zzyil; untrack sync-temp before shipping)"
metadata:
  node_type: memory
  type: project
  originSessionId: fc0029e5-4f2f-4bcd-bb1d-49d246ec64cd
  modified: 2026-10-06T15:10:20.557Z
---

**Task.** Rebuild the CompareManga tablet-sync scripts
(`C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga`) as an opt-in Sync feature: engine and
service in `UI-source/electron/sync/`, UI in a later pass.

**Plans.**
- Parent plan (whole feature, UI included), **approved 2026-09-30**:
  `add-this-script-s-features-linked-pumpkin.md`.
- Non-UI plan, **draft, not yet approved**: `c-users-legoc-claude-plans-add-this-scr-noble-truffle.md`.
- Both sit in `~/.claude/plans/`, which loses files after ~30 days ([[claude-plans-dir-pruned]]).
  The durable copies are in `sync-temp/plans/` on branch `wip/device-sync-handoff` (fork), next to
  `komikkuspec.md`. Its only git source, `1f17a20^:komikkuspec.md`, is unreachable from every branch.

**Where it stands (2026-10-06).**
- Done: after approving the parent plan, the user narrowed the pass to the non-UI half and said to
  pause before any UI work. The non-UI draft folds in their four answers: knob exposure is left to
  the UI pass via presets; the engine speaks the ADB wire protocol; files are pushed in place; JS
  tests live in `tools/` only. No sync code exists yet.
- Pending: the draft's adversarial review (2 critical, 9 major, 14 minor) came back but is **not
  folded in**. The user's last instruction was "Check the review's findings":
  1. verify its load-bearing claims;
  2. fold the confirmed ones in;
  3. ask the decisions that are the user's (single-instance lock scope; adopted-size origin vs
     RECV + PC hashing);
  4. present the plan for approval.
- Moved to a cloud session on 2026-10-06. Its inputs are in `sync-temp/` (see its README). The local
  checkout was left on `wip/device-sync-handoff`.

**Branch rules.**
- `wip/device-sync-handoff` is a snapshot of all in-flight local work plus `sync-temp/`. It must
  never become a PR head against zzyil.
- The shipping branch must not carry `sync-temp/`, or any `tools/` file force-added on this
  branch. Either cut it fresh off `upstream/main` and bring over only the code (per CLAUDE.md), or
  run `git rm -r --cached sync-temp`; `.gitignore` already lists `/sync-temp/`.
- The cloud session can't write this memory. It keeps its phase state in `sync-temp/` on the branch.
  When the work returns, pull the branch and rewrite this entry from there.

**Open decisions.**
- the non-UI plan's own "Open decisions" list: shipping with the in-flight library.js /
  series-merge work, the AIO-for-Android root, the downloader.js tree-kill, the push-in-place
  window, older devices;
- the review-driven decisions under "Pending" above.
