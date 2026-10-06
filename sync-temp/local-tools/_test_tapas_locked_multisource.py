"""Offline regression: Tapas premium/locked episodes ride the chapter list as
placeholders so --multi-source fills them from the next-highest-rated site.

Background (user request 2026-07-06): Tapas serves only some episodes free; the
rest are premium/wait-to-unlock. The handler used to DROP those episodes in
get_chapters, so they never entered the chapter list and the multi-source
alt-rescue machinery (which is per-chapter over the primary list) never got a
chance at them → permanent gaps. Fix: emit locked episodes as bare `_locked`
placeholders (aux-free so the aux-veto doesn't block rescue), short-circuit them
in get_chapter_images with a deterministic "locked" reason, and wire "locked"
into _PERMANENT_SKIP_REASONS so a locked chapter no alt can supply clean-skips
instead of aborting the run.

Coverage:
  T1  tapas _skip_reason still classifies "locked", and _episode_to_chapter
      (locked=True) builds an aux-free placeholder while the free variant keeps
      its BGM aux hints.
  T2  tapas get_chapter_images SHORT-CIRCUITS a _locked chapter (raises
      IncompleteChapterError reason="locked" WITHOUT issuing any request).
  T3  tapas get_chapters (mocked episodes API) emits locked episodes as
      placeholders, keeps free episodes with aux, and drops scheduled/novel/
      invalid — verifying the placeholder rides the list, not the skip bucket.
  T4  aio-dl: "locked" is in _PERMANENT_SKIP_REASONS, and _chapter_carries_aux
      returns False for the aux-free locked placeholder (so aux_veto WON'T block
      the alt-rescue) while still True for a real BGM chapter.
  T5  aio_search_cli._fetch_chapters_for_winner DROPS _locked placeholders from
      an ALT source's chapter list (an alt must never offer a chapter it can't
      serve).
  T6  Structural invariants in aio-dl.py main() closures (can't be invoked
      offline): the download-path filter drops _locked only when multi-source
      is off; --list-chapters surfaces locked_chapters separately.

Run: python tools/_test_tapas_locked_multisource.py   (offline, no network)
"""

import argparse
import importlib
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

aio = importlib.import_module("aio-dl")
import aio_search_cli
from sites.tapas import TapasSiteHandler
from sites.base import IncompleteChapterError

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  [ok]   {name}")
        return
    FAILURES.append(f"{name}: {detail}")
    print(f"  [FAIL] {name} {detail}")


# --------------------------------------------------------------------------- T1
def t1_episode_mapping():
    h = TapasSiteHandler()
    locked_ep = {
        "id": 111, "scene": 5, "title": "Premium Ep",
        "publish_date": "2024-01-01T00:00:00Z",
        "free": False, "unlocked": False, "free_access": False,
        "has_bgm": True, "bgm_url": "https://cdn/bgm.mp3",
    }
    free_ep = {
        "id": 222, "scene": 6, "title": "Free Ep",
        "publish_date": "2024-01-02T00:00:00Z",
        "free": True, "has_bgm": True, "bgm_url": "https://cdn/bgm2.mp3",
    }
    check("t1.skip_reason_locked", h._skip_reason(locked_ep) == "locked",
          h._skip_reason(locked_ep))
    check("t1.skip_reason_free", h._skip_reason(free_ep) is None,
          h._skip_reason(free_ep))

    lc = h._episode_to_chapter(locked_ep, locked=True)
    fc = h._episode_to_chapter(free_ep)
    check("t1.locked_flag", lc.get("_locked") is True)
    check("t1.locked_chap_is_scene", lc.get("chap") == "5", lc.get("chap"))
    # Aux-free: no _bgm_url / _has_bgm / _bgm_title keys at all (so
    # _chapter_carries_aux stays False and no has_bgm is advertised).
    check("t1.locked_no_bgm_url", "_bgm_url" not in lc)
    check("t1.locked_no_has_bgm", "_has_bgm" not in lc)
    check("t1.locked_no_bgm_title", "_bgm_title" not in lc)
    # Free episode keeps its aux hints.
    check("t1.free_bgm_url", fc.get("_bgm_url") == "https://cdn/bgm2.mp3")
    check("t1.free_has_bgm", fc.get("_has_bgm") is True)
    check("t1.free_not_locked", fc.get("_locked") is None)


# --------------------------------------------------------------------------- T2
def t2_get_chapter_images_short_circuit():
    h = TapasSiteHandler()
    locked_ch = {
        "hid": "111", "chap": "5", "url": "https://tapas.io/episode/111",
        "_locked": True,
    }

    def _boom(*a, **k):
        raise AssertionError("make_request must NOT run for a _locked chapter")

    try:
        h.get_chapter_images(locked_ch, scraper=None, make_request=_boom)
        check("t2.raises", False, "no exception raised")
    except IncompleteChapterError as e:
        check("t2.reason_locked", e.reason == "locked", e.reason)
        check("t2.host", e.host == "tapas.io", e.host)
    except AssertionError as e:
        check("t2.no_request", False, str(e))


# --------------------------------------------------------------------------- T3
def t3_get_chapters_emits_placeholders():
    h = TapasSiteHandler()
    episodes = [
        {"id": 1, "scene": 1, "title": "Ch1", "free": True,
         "publish_date": "2024-01-01T00:00:00Z"},
        {"id": 2, "scene": 2, "title": "Ch2 (premium)", "free": False,
         "unlocked": False, "free_access": False, "has_bgm": True,
         "bgm_url": "https://cdn/x.mp3", "publish_date": "2024-01-02T00:00:00Z"},
        {"id": 3, "scene": 3, "title": "Ch3", "free": True,
         "publish_date": "2024-01-03T00:00:00Z"},
        {"id": 4, "scene": 4, "title": "Novel part", "free": True, "book": True},
        {"id": 5, "scene": 5, "title": "Not out yet", "free": True,
         "scheduled": True},
    ]

    class _Resp:
        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    def _make_request(url, scraper):
        # Single page, no has_next.
        return _Resp({"data": {"episodes": episodes, "pagination": {"has_next": False}}})

    ctx = type("Ctx", (), {"comic": {"_series_id": 999}})()
    chapters = h.get_chapters(ctx, scraper=None, language="en",
                              make_request=_make_request)
    by_chap = {c["chap"]: c for c in chapters}
    # Free + locked ride the list; scheduled + novel are dropped.
    check("t3.count", len(chapters) == 3, f"{len(chapters)} chapters: {sorted(by_chap)}")
    check("t3.free1_present", "1" in by_chap and by_chap["1"].get("_locked") is None)
    check("t3.locked2_placeholder",
          by_chap.get("2", {}).get("_locked") is True)
    check("t3.locked2_aux_free", "_bgm_url" not in by_chap.get("2", {}))
    check("t3.free3_present", "3" in by_chap)
    check("t3.novel_dropped", "4" not in by_chap)
    check("t3.scheduled_dropped", "5" not in by_chap)


# --------------------------------------------------------------------------- T4
def t4_aio_dl_wiring():
    check("t4.locked_permanent_skip", "locked" in aio._PERMANENT_SKIP_REASONS)
    check("t4.mature_still_permanent",
          "mature_login_required" in aio._PERMANENT_SKIP_REASONS)
    locked_ch = {"hid": "111", "chap": "5", "_locked": True}
    bgm_ch = {"hid": "222", "chap": "6", "_bgm_url": "https://x/y.mp3",
              "_has_bgm": True}
    check("t4.aux_veto_off_for_locked",
          aio._chapter_carries_aux(locked_ch) is False,
          "locked placeholder must NOT carry aux (else alt-rescue is vetoed)")
    check("t4.aux_veto_on_for_bgm",
          aio._chapter_carries_aux(bgm_ch) is True)
    # Scene number aligns numerically with an alt source's chapter number.
    check("t4.extract_chap_num", aio._extract_chapter_num("5") == 5.0)


# --------------------------------------------------------------------------- T5
def t5_alt_source_drops_locked():
    """_fetch_chapters_for_winner must strip _locked from an ALT's list."""
    class _FakeHandler:
        name = "fakealt"

        def configure_session(self, scraper, args):
            pass

        def fetch_comic_context(self, url, scraper, make_request):
            return type("Ctx", (), {"comic": {"title": "X"}, "title": "X"})()

        def get_chapters(self, ctx, scraper, language, make_request):
            return [
                {"hid": "a", "chap": "1"},
                {"hid": "b", "chap": "2", "_locked": True},  # must be dropped
                {"hid": "c", "chap": "3"},
            ]

    fake = _FakeHandler()
    fake_source = type("Src", (), {"site": "fakealt", "url": "https://fake/x"})()
    candidate = type("Cand", (), {"sources": [fake_source]})()
    args = argparse.Namespace(cookies="", language="en")

    orig = aio_search_cli.get_handler_by_name
    aio_search_cli.get_handler_by_name = lambda name: fake if name == "fakealt" else None
    try:
        recs = aio_search_cli._fetch_chapters_for_winner(
            candidate, args, make_request=lambda *a, **k: None
        )
    finally:
        aio_search_cli.get_handler_by_name = orig

    chapters = recs[0]["chapters"] if recs else []
    labels = [c.get("chap") for c in chapters]
    check("t5.locked_dropped_from_alt",
          all(not c.get("_locked") for c in chapters),
          f"alt still offers a _locked chapter: {labels}")
    check("t5.normal_kept", labels == ["1", "3"], f"labels={labels}")


# --------------------------------------------------------------------------- T6
def t6_structural_main_closures():
    """main() can't be invoked offline; assert the source-level invariants."""
    src = open(os.path.join(REPO, "aio-dl.py"), encoding="utf-8").read()

    # (a) Download-path filter drops _locked ONLY when multi-source is off.
    m = re.search(
        r'if not getattr\(args, "multi_source", False\):\s*\n'
        r'\s*_locked_dropped = sum\(1 for c in pool if c\.get\("_locked"\)\)',
        src,
    )
    check("t6.download_filter_gated_on_multisource", m is not None,
          "expected the pool _locked filter guarded by `not multi_source`")

    # (b) --list-chapters surfaces locked_chapters separately (not in `chapters`).
    check("t6.list_chapters_surfaces_locked",
          '"locked_chapters": locked_chapters' in src,
          "expected locked_chapters key in the --list-chapters result dict")

    # (c) The alt-rescue success path prints an explicit locked-fill line.
    check("t6.locked_fill_log",
          'premium/locked on {primary_state[0].name}' in src,
          "expected an explicit locked-fill log line in the alt-rescue path")


def main():
    print("tapas locked-chapter multi-source regression")
    t1_episode_mapping()
    t2_get_chapter_images_short_circuit()
    t3_get_chapters_emits_placeholders()
    t4_aio_dl_wiring()
    t5_alt_source_drops_locked()
    t6_structural_main_closures()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
