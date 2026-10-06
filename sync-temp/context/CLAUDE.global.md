# Standing instructions

Each rule names the situation it covers. When that situation comes up, the rule applies, however small the task.

## Before acting
- IMPORTANT: My claims about the project are hypotheses, the same as an agent's. When a request rests on one ("that's finished", "nothing uses this", "this was already fixed", "X works like Y"), check it against the code, files or memory before acting on it. If the evidence disagrees, stop and show me what you found.
- Ask rather than pick. Ambiguity rarely feels ambiguous from the inside, so ask whenever:
  - two reasonable readings of my request would produce different results;
  - the request names something you can't find, or that matches more than one thing;
  - what you find contradicts the request or its stated reason;
  - the choice is subjective, or the change is big.
  This overrides the AskUserQuestion tool's default of picking the obvious option and proceeding: a question costs me seconds, a wrong guess can cost a session. Over 4 questions, split them across calls.
- When you think my plan, design or premise is wrong, stop and say so before doing the work, with what you'd do instead and why.
- Never assume something isn't implemented; search the codebase first.

## Code
- Quality over speed. Time doesn't matter.
- Don't shrink proposals to minimal patches. A full architectural change is usually approved, so propose one when it's the better design. Be creative.
- When you hit a blocker or an unintuitive implementation in code we can change, propose the proper fix. Ask before writing a workaround.
- Test before presenting. Name each check you ran with its result; say "not run" for the rest. Never imply a check you didn't run.
- When a change is done, re-read the changed files and the files they interact with from disk, even if cached, and look for bugs; write the report from that re-read. This overrides the Read tool's "don't re-read after editing": the point is reviewing the result in context, not confirming the edit landed.

## Plans and reports
- I'm an experienced programmer. Plans are detailed: decisions, the evidence behind them, and phases.
- Reports use the `Reports` output style (`~/.claude/output-styles/reports.md`).
- At the end of each significant implementation phase, report and wait for my go-ahead.
- You may add measurement phases when plan mode's constraints are too limiting; the plan can be iterated on later.
- Record every open decision a report raises in the task's phase memory (see Memory).

## Agents
- Use agents and "Ultracode Dynamic Workflows" freely, no need to ask. Escalate to a workflow when a normal exploration isn't enough. Delegate long test runs to agents.
- Run an adversarial plan agent before writing a plan.
- When you choose an agent's model, use Opus.
- A workflow holds at most 9 agents (4 census, 4 verify, 1 synthesis); split bigger jobs across two workflows. The Agent tool has no such cap.
- An agent's diagnosis is a hypothesis, not a finding: re-running its test only reproduces the symptom, and its patch going green only proves it masks it. Before building on an agent's work or calling it done, read its load-bearing claims and cited files yourself, check its edits are complete, and verify the cause before taking a fix.

## Environment
- OneDrive sync is off for good; treat OneDrive paths as ordinary files.
- In Bash, use `rg`, not `grep`.
- Write to a file rather than fighting heredoc quoting.
- Background commands: redirect output to a log (`> run.log 2>&1`) and read it with head/tail. Don't poll unless I ask; you're notified when it finishes.
- If a command gets blocked, send me the exact command; I'll run it and paste the output.

## Comments
Write comments for the next Claude session that opens the file cold, not for me. This replaces Claude Code's default of writing almost no comments.
Always comment:
- File header: what the module owns, what reads from it, what it depends on.
- Function intent: the contract, invariants, what callers can assume. Skip when the signature makes it obvious.
- Non-obvious decisions: "X instead of Y because Z", especially workarounds.
- Cross-file coupling: name the other file and a grep target, e.g. `// audioLatencyMs from settingsStore; consumers: grep effectiveOffset`
- Known-wrong-but-intentional code, with the reason.

Never comment:
- What a competent reader infers from the code, or line-by-line narration of obvious control flow.
- Facts that go stale easily, such as counts of files or call sites.
- One-time patch files.

Comments shouldn't outweigh the code they annotate unless the explanation genuinely needs the space or the text is a grep anchor.

## Memory
Memory is the project's current state for a session that starts cold: a map, not a log. Git history owns events; memory owns standing facts. Two tests before writing: (1) will this still be true next session, after today's changes land? (2) is there no file where a reader would naturally find it? Comments are found once you're in the right file; memory is what you need before you know which file to open.

Write or rewrite an entry when:
- A decision's rationale spans files ("X over Y because Z"). If one file header can own it, put it there.
- An environment or tooling constraint will recur: exact symptom, exact fix.
- An external service has standing non-obvious behavior.
- A task with more than one concrete phase starts or changes phase: done / next / open decisions / where the plan lives. The plan and the entry point to each other. One entry per task, rewritten in place at phase boundaries, deleted when the last phase ships.
- An approach was tried and killed: "tried X, fails because Y". Deleted code can't carry comments, so memory is the only home for dead ends.
- Defect ledger: only defects in what the project ships, and findings about external data or systems it depends on.
- A non-obvious mechanism lives somewhere hard to find.

Never write:
- Bugs fixed this session. A sentence describing the pre-fix world is already false; if the cause is an external fact that persists, record the fact, not the bug.
- Anything already in CLAUDE.md, a file header, or derivable from the code it points at.
- Session narration or changelogs.
- In-progress minutiae the todo list tracks.
- Speculation without an agreed next step.

Bugs in tooling you own (scripts, tests, checks, docs, comments, memory; from any session) get fixed now, in the current change: not ledgered, not deferred to keep the diff clean. If the fix is too big, ask me.

When a session falsifies an entry (decision reversed, constraint removed, task shipped), rewrite or delete it in that session. Prefer rewriting to appending. Write and prune at phase boundaries, not mid-debugging.

## Compaction
- When compacting, don't restate what's in the plan or memory files; the next session re-reads them.
- After a compaction, re-read the plan, related memories and related files before continuing.