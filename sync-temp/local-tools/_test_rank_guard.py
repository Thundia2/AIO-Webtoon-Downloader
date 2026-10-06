"""Deterministic (offline) test for the fresh-search popularity guard.

Codex PR #54 review: in `_pick_best_candidate` the rank key put `author_matched`
ABOVE `popularity`, so on a fresh search (no cached id -> no self-heal popularity
guard) a coincidental author-string hit on an obscure franchise/studio entry
could outrank a far more popular same-title candidate whose author the site
merely romanizes differently. The fix reorders to popularity-above-author. These
synthetic candidates pin that behavior without hitting the live API (the live
suite tools/_test_match_fix.py covers band + end-to-end).
"""
import os
import sys

# Repo root on sys.path (script dir is tools/) — same shim as _test_sidecar_aux.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sites.external_metadata import _pick_best_candidate, _author_match_score


def _cand(cid, title, pop, author, *, synonyms=None, year=2015):
    return {
        "id": cid,
        "title": {"romaji": title, "english": title, "native": "",
                  "userPreferred": title},
        "synonyms": synonyms or [],
        "popularity": pop,
        "startDate": {"year": year},
        "staff": {"edges": [
            {"role": "Story & Art",
             "node": {"name": {"full": author, "native": ""}}}
        ]} if author else {"edges": []},
    }


results = []


def check(label, cond):
    results.append(cond)
    print(f"[{'PASS' if cond else 'FAIL'}] {label}")


# ── T1: the reviewer's scenario — popularity must beat a spurious author hit ──
# Canonical entry (huge popularity) whose AniList staff the site does NOT match
# (author romanized differently); obscure decoy whose studio credit coincidentally
# matches the site's author string. Decoy listed FIRST so a no-op sort would pick
# it — the fix must actively choose the popular canonical entry.
canonical = _cand(1, "Generic Title", 40000, "Real Mangaka")
decoy = _cand(2, "Generic Title", 300, "Studio Foo")
# Precondition: the scenario is real only if the decoy author-matches and the
# canonical does not (otherwise we'd be testing nothing).
_da = _author_match_score(["Studio Foo"], decoy)
_ca = _author_match_score(["Studio Foo"], canonical)
check("T1 precondition: decoy author-matches, canonical does not",
      _da is not None and _da >= 85 and (_ca is None or _ca < 85))
best, _ = _pick_best_candidate(
    ["Generic Title"], [decoy, canonical], source_authors=["Studio Foo"], year=None)
check("T1: popular canonical beats obscure author-matched decoy",
      best is not None and best["id"] == 1)

# ── T2: author is still a genuine tiebreak BELOW popularity (equal popularity) ─
matched = _cand(1, "Dup Title", 1000, "Tarou Yamada")
unmatched = _cand(2, "Dup Title", 1000, "Someone Else")
best, _ = _pick_best_candidate(
    ["Dup Title"], [unmatched, matched], source_authors=["Yamada Tarou"], year=None)
check("T2: author breaks a popularity tie (still a booster)",
      best is not None and best["id"] == 1)

# ── T3: primary_hit still outranks popularity (Fairy-Tail-doujin guard) ───────
# Real series matches on a PRIMARY title (lower popularity); doujin matches only
# via a SYNONYM (higher popularity). primary_hit must win regardless of pop.
real = _cand(1, "Fairy Tail", 500, "")
doujin = _cand(2, "Naughty Parody", 5000, "", synonyms=["Fairy Tail"])
best, _ = _pick_best_candidate(
    ["Fairy Tail"], [doujin, real], source_authors=[], year=None)
check("T3: primary-title hit beats higher-popularity synonym-only hit",
      best is not None and best["id"] == 1)

print(f"\n{sum(results)}/{len(results)} checks passed")
