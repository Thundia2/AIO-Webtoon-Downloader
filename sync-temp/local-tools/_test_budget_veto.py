"""Offline regression: time-budget/complete-chapter gate + aux rescue veto.

Covers the 2026-07-03 fixes driven by bench/unordinaryLogs.md (unOrdinary run
where fully-downloaded chapters 130/135/143 were discarded with
"incomplete: N/N pages (reason=time_budget)" and replaced by smaller atsumaru
copies, and ch 141 opened dead with "0/114 (reason=time_budget)"):

  T1  _chapter_carries_aux: detects _aux_assets / has_bgm (linewebtoon) /
      _has_bgm/_bgm_url (tapas) / merged collapse-split parts.
  T2  _fetch_binary_asset_bytes ignores the per-chapter watchdog (a fired
      _CHAPTER_CANCEL no longer kills the BGM download) while the host-poison
      guard still short-circuits.
  T3  Structural ordering invariants inside the main() closures (which can't
      be invoked offline): the prefetch join happens BEFORE the watchdog
      timer is armed; the completeness gate accepts complete chapters BEFORE
      the failure elif; the prefetch chain-push fires BEFORE the sidecar-aux
      materialization; _process_chapter_strict computes aux_veto and gates
      both the lazy discovery and the alts lookup on it.

Run: python tools/_test_budget_veto.py   (offline, no network)
"""

import importlib
import os
import re
import sys
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

aio = importlib.import_module("aio-dl")

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        return
    FAILURES.append(f"{name}: {detail}")
    print(f"  [FAIL] {name} {detail}")


def t1_chapter_carries_aux():
    f = aio._chapter_carries_aux
    check("t1.empty", f({}) is False)
    check("t1.aux_assets", f({"_aux_assets": [object()]}) is True)
    check("t1.aux_assets_empty_list", f({"_aux_assets": []}) is False)
    # linewebtoon get_chapters stamps has_bgm (bool) on every chapter
    check("t1.has_bgm_true", f({"has_bgm": True}) is True)
    check("t1.has_bgm_false", f({"has_bgm": False}) is False)
    # tapas get_chapters stamps _has_bgm/_bgm_url
    check("t1.tapas_has_bgm", f({"_has_bgm": True}) is True)
    check("t1.tapas_bgm_url", f({"_bgm_url": "https://x/y.mp3"}) is True)
    check("t1.tapas_bgm_url_empty", f({"_bgm_url": ""}) is False)
    # merged collapse-split parts
    check(
        "t1.merged_part_hit",
        f({"_merged_parts": [{"has_bgm": False}, {"has_bgm": True}]}) is True,
    )
    check(
        "t1.merged_part_miss",
        f({"_merged_parts": [{"has_bgm": False}, {}]}) is False,
    )
    check("t1.merged_non_dict", f({"_merged_parts": ["x", None]}) is False)
    print("  [ok] _chapter_carries_aux signal detection")


class _FakeResp:
    def __init__(self, content=b"", status=200):
        self.content = content
        self.status_code = status


def t2_aux_fetch_deadline_exempt():
    url = "https://audio.example.test/bgm_21.m4a"
    host = "audio.example.test"

    # Arm a FIRED watchdog — the old code returned None immediately here.
    aio._CHAPTER_CANCEL = threading.Event()
    aio._CHAPTER_CANCEL.set()
    try:
        calls = {"n": 0}

        def fake_make_request(u, scraper):
            calls["n"] += 1
            return _FakeResp(b"ftypM4A-bytes", 200)

        got = aio._fetch_binary_asset_bytes(url, None, fake_make_request)
        check(
            "t2.fetch_despite_deadline",
            got == b"ftypM4A-bytes",
            f"got {got!r} (old behavior: None — BGM silently dropped)",
        )
        check("t2.single_call", calls["n"] == 1, f"calls={calls['n']}")

        # Host-poison guard must still short-circuit (dead audio CDN).
        with aio._HOST_FAIL_LOCK:
            aio._HOST_FAIL_COUNT[host] = int(
                getattr(aio, "_CHAPTER_HOST_POISON", 5)
            )
        try:
            got2 = aio._fetch_binary_asset_bytes(url, None, fake_make_request)
            check("t2.poison_guard", got2 is None, f"got {got2!r}")
        finally:
            with aio._HOST_FAIL_LOCK:
                aio._HOST_FAIL_COUNT.pop(host, None)
    finally:
        aio._CHAPTER_CANCEL = None
    print("  [ok] _fetch_binary_asset_bytes deadline-exempt, poison guard intact")


def _line_of(src_lines, pattern, start=0, name=""):
    rx = re.compile(pattern)
    for i in range(start, len(src_lines)):
        if rx.search(src_lines[i]):
            return i
    raise AssertionError(f"pattern not found: {name or pattern} (from line {start})")


def t3_structural_ordering():
    path = os.path.join(REPO, "aio-dl.py")
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    # (a) _process_chapter: prefetch join BEFORE the watchdog Event/timer.
    d = _line_of(lines, r"^    def _process_chapter\(", name="def _process_chapter")
    ev = _line_of(lines, r"_CHAPTER_CANCEL = threading\.Event\(\)", d, "Event arm")
    j = _line_of(lines, r"_consume_image_prefetch\(ch\.get\(", d, "wrapper join")
    check("t3.join_before_timer", d < j < ev, f"def={d+1} join={j+1} event={ev+1}")

    # (b) completeness gate: acceptance branch precedes the failure elif.
    acc = _line_of(lines, r"accepting despite", name="acceptance print")
    fail = _line_of(
        lines,
        r"elif incomplete or deadline_hit or poisoned_hosts:",
        name="failure elif",
    )
    check("t3.accept_before_fail", acc < fail, f"accept={acc+1} fail={fail+1}")
    # ... and the acceptance is guarded on completeness, not reason.
    guard = _line_of(
        lines, r"if pages_total > 0 and not incomplete:", name="complete guard"
    )
    check("t3.guard_before_accept", guard < acc, f"guard={guard+1} accept={acc+1}")

    # (c) impl: chain-push call site precedes aux materialization call site
    #     (both indented — skips the module-level defs).
    chain = _line_of(
        lines, r"^\s{16,}_start_image_prefetch_chain\(", name="chain-push call"
    )
    aux = _line_of(
        lines, r"^\s{16,}_aux_rec, _aux_members = _materialize_chapter_aux\(",
        name="aux materialize call",
    )
    check("t3.chain_before_aux", chain < aux, f"chain={chain+1} aux={aux+1}")

    # (d) strict wrapper: aux_veto computed, gates lazy discovery + alts.
    veto = _line_of(lines, r"aux_veto = \(", name="aux_veto assignment")
    lazy = _line_of(
        lines, r"if _ms_lazy_pending and not aux_veto:", veto, "lazy gate"
    )
    alts = _line_of(lines, r"^\s+if not aux_veto:", veto, "alts gate")
    check("t3.veto_gates", veto < lazy and veto < alts,
          f"veto={veto+1} lazy={lazy+1} alts={alts+1}")

    print("  [ok] structural ordering (join<timer, accept<fail, chain<aux, veto gates)")


def main():
    print("time-budget / aux-veto offline regression:")
    t1_chapter_carries_aux()
    t2_aux_fetch_deadline_exempt()
    t3_structural_ordering()
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S)")
        sys.exit(1)
    print("ALL PASSED")


if __name__ == "__main__":
    main()
