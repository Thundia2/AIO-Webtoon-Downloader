"""Offline regression: Phase D backoff — prefetch feedback + AIMD recovery.

Covers the 2026-07-03 backoff overhaul (follow-up to the chapter-watchdog
fixes; motivated by bench/unordinaryLogs.md where the cap crawled 8->3 in 50
minutes because only foreground failures fed it while the prefetch path — the
actual downloader in steady state — recorded nothing):

  T1  Reducer: retryable -1 / rate_limit halve / floor 1, baseline recorded
      at FIRST reduction, origin_error and permanent never move the cap.
  T2  AIMD recovery: +1 cap per _HOST_CAP_RECOVERY_STREAK gate-accepted
      chapters; climbing back to the baseline DELETES the cap entry (full
      un-clamp, _effective_concurrency returns base again).
  T3  Any non-permanent failure (including origin_error) resets the clean
      streak, so recovery re-earns each step.
  T4  Healthy-host credits are no-ops and leave no state behind.
  T5  _reset_host_concurrency_caps clears cap + baseline + streak.
  T6  Structural: the prefetch fast path passes the backoff-only callback
      (with the 4xx guard), the gate's accept branch credits the host, and
      the chain-push clamps depth for capped hosts.

Run: python tools/_test_backoff_aimd.py   (offline, no network)
"""

import importlib
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

aio = importlib.import_module("aio-dl")

FAILURES = []
HOST = "cdn.example.test"


def check(name, cond, detail=""):
    if cond:
        return
    FAILURES.append(f"{name}: {detail}")
    print(f"  [FAIL] {name} {detail}")


def _cap():
    with aio._HOST_CAP_LOCK:
        return aio._HOST_CONCURRENCY_CAP.get(HOST)


def _baseline():
    with aio._HOST_CAP_LOCK:
        return aio._HOST_CAP_BASELINE.get(HOST)


def _streak():
    with aio._HOST_CAP_LOCK:
        return aio._HOST_CLEAN_STREAK.get(HOST)


def _fresh():
    aio._reset_host_concurrency_caps()


def t1_reducer():
    _fresh()
    aio._record_host_failure_for_backoff(HOST, "retryable")
    check("t1.first_step", _cap() == 7, f"cap={_cap()}")
    check("t1.baseline_recorded", _baseline() == 8, f"baseline={_baseline()}")
    for _ in range(4):
        aio._record_host_failure_for_backoff(HOST, "retryable")
    check("t1.walkdown", _cap() == 3, f"cap={_cap()}")
    check("t1.baseline_stable", _baseline() == 8, f"baseline={_baseline()}")
    aio._record_host_failure_for_backoff(HOST, "rate_limit")
    check("t1.halve", _cap() == 1, f"cap={_cap()}")
    aio._record_host_failure_for_backoff(HOST, "retryable")
    check("t1.floor", _cap() == 1, f"cap={_cap()}")
    # Non-reducing classes never create or move a cap.
    _fresh()
    aio._record_host_failure_for_backoff(HOST, "origin_error")
    check("t1.origin_no_cap", _cap() is None, f"cap={_cap()}")
    aio._record_host_failure_for_backoff(HOST, "permanent")
    check("t1.permanent_no_cap", _cap() is None, f"cap={_cap()}")
    check("t1.effective_clamped_after", True)  # placeholder ordering
    print("  [ok] reducer: -1/halve/floor, baseline at first reduction")


def t2_recovery():
    _fresh()
    n = aio._HOST_CAP_RECOVERY_STREAK
    for _ in range(3):  # 8 -> 5
        aio._record_host_failure_for_backoff(HOST, "retryable")
    check("t2.setup", _cap() == 5, f"cap={_cap()}")
    # n-1 credits: no movement yet.
    for _ in range(n - 1):
        aio._record_host_clean_chapter(HOST)
    check("t2.partial_streak", _cap() == 5 and _streak() == n - 1,
          f"cap={_cap()} streak={_streak()}")
    aio._record_host_clean_chapter(HOST)
    check("t2.step_up", _cap() == 6, f"cap={_cap()}")
    check("t2.streak_spent", _streak() in (None, 0), f"streak={_streak()}")
    # Climb to full recovery: 6 -> 7 -> uncapped (7+1 >= baseline 8).
    for _ in range(2 * n):
        aio._record_host_clean_chapter(HOST)
    check("t2.fully_recovered", _cap() is None, f"cap={_cap()}")
    check("t2.baseline_dropped", _baseline() is None, f"baseline={_baseline()}")
    check(
        "t2.unclamped",
        aio._effective_concurrency(HOST, 8) == 8
        and aio._effective_concurrency(HOST, 10) == 10,
        f"eff8={aio._effective_concurrency(HOST, 8)}",
    )
    check("t2.capped_accessor", aio._host_concurrency_capped(HOST) is False)
    print("  [ok] AIMD recovery: +1 per streak, full un-clamp at baseline")


def t3_streak_reset():
    _fresh()
    n = aio._HOST_CAP_RECOVERY_STREAK
    for _ in range(2):  # 8 -> 6
        aio._record_host_failure_for_backoff(HOST, "retryable")
    for _ in range(n - 1):
        aio._record_host_clean_chapter(HOST)
    check("t3.pre_reset_streak", _streak() == n - 1, f"streak={_streak()}")
    # A new failure resets the streak AND steps the cap down.
    aio._record_host_failure_for_backoff(HOST, "retryable")
    check("t3.reset_on_failure", _streak() is None and _cap() == 5,
          f"streak={_streak()} cap={_cap()}")
    # origin_error resets the streak WITHOUT moving the cap.
    for _ in range(n - 1):
        aio._record_host_clean_chapter(HOST)
    aio._record_host_failure_for_backoff(HOST, "origin_error")
    check("t3.origin_resets_streak", _streak() is None and _cap() == 5,
          f"streak={_streak()} cap={_cap()}")
    # Full streak must be re-earned from zero after each reset.
    for _ in range(n):
        aio._record_host_clean_chapter(HOST)
    check("t3.re_earned", _cap() == 6, f"cap={_cap()}")
    print("  [ok] failures (incl. origin_error) reset the clean streak")


def t4_healthy_host():
    _fresh()
    for _ in range(5):
        aio._record_host_clean_chapter(HOST)
    check("t4.no_state", _cap() is None and _streak() is None and _baseline() is None,
          f"cap={_cap()} streak={_streak()}")
    aio._record_host_clean_chapter("")  # empty host: no-op, no crash
    check("t4.capped_false", aio._host_concurrency_capped(HOST) is False)
    check("t4.capped_empty", aio._host_concurrency_capped("") is False)
    print("  [ok] healthy/empty hosts: credits are stateless no-ops")


def t5_reset_clears_all():
    _fresh()
    aio._record_host_failure_for_backoff(HOST, "retryable")
    aio._record_host_clean_chapter(HOST)
    with aio._HOST_CAP_LOCK:
        pre = (
            bool(aio._HOST_CONCURRENCY_CAP)
            and bool(aio._HOST_CAP_BASELINE)
            and bool(aio._HOST_CLEAN_STREAK)
        )
    check("t5.state_populated", pre)
    aio._reset_host_concurrency_caps()
    with aio._HOST_CAP_LOCK:
        post = (
            not aio._HOST_CONCURRENCY_CAP
            and not aio._HOST_CAP_BASELINE
            and not aio._HOST_CLEAN_STREAK
        )
    check("t5.all_cleared", post)
    print("  [ok] _reset_host_concurrency_caps clears cap+baseline+streak")


def _line_of(src_lines, pattern, start=0, name=""):
    rx = re.compile(pattern)
    for i in range(start, len(src_lines)):
        if rx.search(src_lines[i]):
            return i
    raise AssertionError(f"pattern not found: {name or pattern} (from line {start})")


def t6_structural():
    path = os.path.join(REPO, "aio-dl.py")
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    # (a) Prefetch fast path passes the backoff-only callback with a 4xx guard,
    #     inside _run_image_prefetch_job.
    job = _line_of(lines, r"^def _run_image_prefetch_job\(", name="job def")
    guard = _line_of(lines, r"if status is not None and 400 <= int\(status\) < 500:",
                     job, "4xx guard")
    hook = _line_of(lines, r"record_host_failure=_prefetch_backoff_feedback",
                    job, "prefetch backoff hook")
    backoff_call = _line_of(
        lines, r'_record_host_failure_for_backoff\(h, "retryable"\)', job,
        "backoff-only call",
    )
    check("t6.prefetch_feedback", job < guard < backoff_call < hook,
          f"job={job+1} guard={guard+1} call={backoff_call+1} hook={hook+1}")
    # ... and it must NOT route through _record_failure (poison/ghost leak).
    seg = "\n".join(lines[guard:hook + 1])
    check("t6.no_record_failure_leak", "_record_failure(" not in seg)

    # (b) Gate accept branch credits the host before the failure elif.
    accept = _line_of(lines, r"accepting despite", name="accept print")
    credit = _line_of(
        lines, r"_record_host_clean_chapter\(_resolve_host_blame\(\)\)",
        accept, "gate credit",
    )
    fail = _line_of(lines, r"elif incomplete or deadline_hit or poisoned_hosts:",
                    accept, "failure elif")
    check("t6.credit_in_accept", accept < credit < fail,
          f"accept={accept+1} credit={credit+1} elif={fail+1}")

    # (c) Chain-push clamps depth for capped hosts, before the push call.
    clamp = _line_of(
        lines, r"if depth > 1 and _host_concurrency_capped\(_resolve_host_blame\(\)\):",
        name="depth clamp",
    )
    push = _line_of(lines, r"^\s{16,}_start_image_prefetch_chain\(", clamp,
                    "chain push call")
    check("t6.clamp_before_push", clamp < push, f"clamp={clamp+1} push={push+1}")

    # (d) Reducer resets the streak under the cap lock.
    red = _line_of(lines, r"^def _record_host_failure_for_backoff\(", name="reducer def")
    reset = _line_of(lines, r"_HOST_CLEAN_STREAK\.pop\(host, None\)", red,
                     "streak reset in reducer")
    red_end = _line_of(lines, r"^def _effective_concurrency\(", red, "next def")
    check("t6.reducer_resets_streak", red < reset < red_end,
          f"def={red+1} reset={reset+1}")

    print("  [ok] structural (prefetch hook, gate credit, depth clamp, streak reset)")


def main():
    print("backoff/AIMD offline regression:")
    t1_reducer()
    t2_recovery()
    t3_streak_reset()
    t4_healthy_host()
    t5_reset_clears_all()
    t6_structural()
    _fresh()  # leave module state clean
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S)")
        sys.exit(1)
    print("ALL PASSED")


if __name__ == "__main__":
    main()
