"""Offline regression for the update-check skip-set (Option 2, 2026-07-07).

Root cause it guards: a consensus-armed collapse DROPS source-only fragment-
shaped decimals (mangafire's duplicate `.1-.4` sitting next to the integer
floor) via group_chapters_for_download Rule 2/3b/6, but the Library update-
check spawns `--list-chapters` with NO peer data, so its consensus-free collapse
KEEPS those labels and the main.js diff (siteChapters − chapters_downloaded)
reports them as a perpetual "+N new". The fix records exactly the labels the
download dropped-under-consensus into `.aio_series.json:chapters_skipped_fragments`
and subtracts them in the UI diff.

Covers:
  1. The derivation `free_labels − consensus_labels` against the REAL
     group_chapters_for_download (aio-dl.py:~9593), incl. the Rule-4 standalone
     `.3` (no integer sibling) that must NOT be skipped.
  2. That sequential-split clusters (Rule 3a/5) collapse identically with and
     without consensus, so they never leak into the skip-set.
  3. The .aio_series.json merge lifecycle: union-with-prior (a lazy run's empty
     set can't wipe an eager run's) minus downloaded (a force-downloaded
     fragment leaves the skip-set). Mirrors the inline logic at
     aio-dl.py `merged_skipped = sorted((prev | new) - downloaded, ...)`.

Run: python tools/_test_skip_set.py   (no network; pure functions)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sites.chapter_merger import group_chapters_for_download


def _skip_set(pool, consensus):
    """Reproduce aio-dl.py's _skipped_fragment_labels derivation."""
    consensus_labels = {
        g.label
        for g in group_chapters_for_download(
            pool, collapse_splits=True, consensus_set=consensus
        )
    }
    free_labels = {
        g.label
        for g in group_chapters_for_download(
            pool, collapse_splits=True, consensus_set=None
        )
    }
    # Invariant the fix relies on: consensus only ever removes more, never adds.
    assert consensus_labels <= free_labels, (consensus_labels, free_labels)
    return free_labels - consensus_labels


def _merge_skipped(prev, new, downloaded):
    """Mirror aio-dl.py: (prev ∪ new) − downloaded, order-independent set."""
    return (set(prev) | set(new)) - set(downloaded)


def _pool(*labels):
    return [{"chap": s} for s in labels]


def test_fragment_dupes_captured():
    # floors 7 and 12 have BOTH the integer and a .3 duplicate; peers confirm
    # the integers -> the .3 dupes are dropped and belong in the skip-set.
    # floor 6 has ONLY 6.3 (no integer 6) -> Rule 4 standalone, kept, NOT skipped.
    skip = _skip_set(_pool("7", "7.3", "12", "12.3", "6.3"), {7.0, 12.0, 6.0})
    assert skip == {"7.3", "12.3"}, skip
    print("ok  fragment dupes captured; Rule-4 standalone .3 kept ->", sorted(skip))


def test_empty_without_consensus():
    # Lazy / single-source run: no consensus -> nothing dropped -> empty skip-set.
    skip = _skip_set(_pool("7", "7.3", "12", "12.3"), None)
    assert skip == set(), skip
    skip_empty_set = _skip_set(_pool("7", "7.3"), set())
    assert skip_empty_set == set(), skip_empty_set
    print("ok  no consensus -> empty skip-set")


def test_sequential_splits_never_leak():
    # {5,5.1,5.2,5.3} is a Rule-3a sequential split: collapses to "5" identically
    # with and without consensus, so it must never appear in the skip-set.
    skip = _skip_set(_pool("5", "5.1", "5.2", "5.3"), {5.0})
    assert skip == set(), skip
    # No-integer sequential cluster {9.1,9.2,9.3} (Rule 5) -> merged "9", same both ways.
    skip5 = _skip_set(_pool("9.1", "9.2", "9.3"), {9.0})
    assert skip5 == set(), skip5
    print("ok  sequential-split merges never leak into skip-set")


def test_side_story_not_skipped():
    # A real ".5"-style side story is never fragment-shaped, so it survives
    # consensus and is NOT skipped even when its integer floor is peer-confirmed.
    skip = _skip_set(_pool("8", "8.5"), {8.0})
    assert skip == set(), skip
    print("ok  .5 side story not skipped")


def test_merge_lifecycle():
    # Eager run drops {7.3, 12.3}.
    eager = {"7.3", "12.3"}
    downloaded_after_eager = {"7", "12"}  # the .3 dupes were NOT downloaded
    merged1 = _merge_skipped(prev=set(), new=eager, downloaded=downloaded_after_eager)
    assert merged1 == {"7.3", "12.3"}, merged1

    # Later LAZY "Download Missing" run computes an empty new set; union with the
    # persisted prior set must PRESERVE it (this is the whole point of the union).
    merged2 = _merge_skipped(prev=merged1, new=set(), downloaded=downloaded_after_eager)
    assert merged2 == {"7.3", "12.3"}, merged2

    # User force-downloads 7.3 (e.g. `--chapters 7.3`): it enters chapters_downloaded,
    # so the minus-downloaded term drops it from the skip-set (present, not skipped).
    merged3 = _merge_skipped(prev=merged2, new=set(), downloaded={"7", "12", "7.3"})
    assert merged3 == {"12.3"}, merged3
    print("ok  merge lifecycle: union preserves, downloaded removes ->", sorted(merged3))


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
    print(f"\nALL {len(fns)} SKIP-SET TESTS PASSED")
