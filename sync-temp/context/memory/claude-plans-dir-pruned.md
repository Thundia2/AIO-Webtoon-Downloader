---
name: claude-plans-dir-pruned
description: ~/.claude/plans/ loses files after ~30 days — never cite a plan file as standing context; commit any plan that must outlive a month
metadata:
  node_type: memory
  type: reference
  originSessionId: fc0029e5-4f2f-4bcd-bb1d-49d246ec64cd
  modified: 2026-10-06T15:10:22.584Z
---

**Files in `C:\Users\legoc\.claude\plans\` disappear after about 30 days.**

Measured 2026-10-06:
- The oldest surviving plan was dated 2026-09-06, exactly 30 days earlier.
- All 8 plan files the project CLAUDE.md cited were gone: `pr-31-context.md`, both merge handoffs,
  both #31 conflict analyses, `compression-modernize-handoff.md`, `try-to-find-ways-vast-eagle.md`
  and `i-want-to-add-rustling-penguin.md`.
- Session transcripts under `~/.claude/projects/` run on a different clock: they reached back to
  2026-08-02.
- The cause is unconfirmed. `~/.claude/settings.json` sets no `cleanupPeriodDays`, so it is
  presumably Claude Code's default cleanup.

**Why it matters.** Plan mode writes its plans here. A task that runs longer than a month loses its
plan mid-flight, and every pointer to a plan file silently goes dead.

**How to apply.**
- Never point CLAUDE.md or memory at a plan file as standing context.
- Commit a plan that must outlive a month somewhere durable. The device-sync plans live in
  `sync-temp/plans/` for this reason: [[device-sync-feature]].
- A pruned plan can still be recovered while the session that wrote it is on disk: grep its file
  name in `~/.claude/projects/<project>/*.jsonl`.
  - An ExitPlanMode call carries the final text.
  - A plan that never reached ExitPlanMode has to be rebuilt by replaying its `Write` call and the
    `Edit` calls after it.
