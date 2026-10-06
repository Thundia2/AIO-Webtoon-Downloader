"""Deterministic (offline) test for the LINE Webtoon author/primary-title
corroboration gate: sites/external_metadata._match_is_trustworthy_for_site.

Bug: unOrdinary (LINE Webtoon, by uru-chan) enriched against the Japanese manga
"Kanojo Iro no Kanojo" (id 40442) purely through that entry's synonym "Unordinary
Life" (WRatio 90 >= 75). Author was only a tiebreak/booster, so the wrong series
was applied. The gate rejects a match on author-reliable sites (_AUTHOR_GATED_
SITES, currently just linewebtoon) when the author disagrees AND the title basis
is a synonym only — while KEEPING legit matches that romanize the author
differently but hit a PRIMARY title (Eleceed: author 67 < 85 but title "Eleceed"
== 100).

Synthetic media pin the behavior without the live API; the end-to-end proof over
the real 5-series library ran against graphql.anilist.co during development. If
_match_is_trustworthy_for_site / _AUTHOR_GATED_SITES / the thresholds change,
update here. grep sync target: external_metadata._match_is_trustworthy_for_site.
"""
import os
import sys

# Repo root on sys.path (script dir is tools/) — same shim as _test_rank_guard.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sites.external_metadata import (
    _match_is_trustworthy_for_site,
    _author_match_score,
    _score_candidate_detail,
    ANILIST_AUTHOR_MATCH_THRESHOLD,
)


def _media(romaji, *, synonyms=None, staff=None):
    """Minimal AniList Media doc. staff = list of full names (Story & Art)."""
    return {
        "id": 1,
        "title": {"romaji": romaji, "english": romaji, "native": "",
                  "userPreferred": romaji},
        "synonyms": synonyms or [],
        "staff": {"edges": [
            {"role": "Story & Art", "node": {"name": {"full": n, "native": ""}}}
            for n in (staff or [])
        ]},
    }


results = []


def check(label, cond):
    results.append(bool(cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {label}")


# ── unOrdinary shape: synonym-only title + disagreeing author ────────────────
# Primary title is the JP manga's romaji (scores low vs "unOrdinary"); the site
# title only matches the SYNONYM "Unordinary Life". Author "uru-chan" vs the JP
# staff disagrees. This is the poison the gate must reject.
unord = _media("Kanojo Iro no Kanojo",
               synonyms=["Kanojoiro no Kanojo", "Unordinary Life"],
               staff=["Yukari Yashiki", "Aoi"])
_s, _primary = _score_candidate_detail(["unOrdinary"], unord)
_a = _author_match_score(["uru-chan"], unord)
check("precondition: unOrdinary shape is synonym-only (primary_hit False)",
      _primary is False and _s >= 75.0)
check("precondition: unOrdinary author disagrees (< 85)",
      _a is not None and _a < ANILIST_AUTHOR_MATCH_THRESHOLD)
check("unOrdinary: linewebtoon REJECTS synonym-only + author-mismatch",
      _match_is_trustworthy_for_site("linewebtoon", unord, ["unOrdinary"],
                                     ["uru-chan"]) is False)

# ── Eleceed shape: exact PRIMARY title + author romanized differently ────────
# Site "Jeho Son / ZHENA" vs AniList "Jae-Ho Son" scores < 85 (Jeho vs Jae-Ho;
# ZHENA is Hye-Jin Kim's pen name), but the primary title "Eleceed" is exact.
# primary_hit must rescue it — this is the case a naive author-only gate breaks.
elec = _media("Eleceed", synonyms=["Eleceed: Velocidad electrica"],
              staff=["Jae-Ho Son", "Hye-Jin Kim"])
_s2, _primary2 = _score_candidate_detail(["Eleceed"], elec)
_a2 = _author_match_score(["Jeho Son / ZHENA"], elec)
check("precondition: Eleceed hits a PRIMARY title (primary_hit True)",
      _primary2 is True)
check("precondition: Eleceed author romanization scores < 85",
      _a2 is not None and _a2 < ANILIST_AUTHOR_MATCH_THRESHOLD)
check("Eleceed: linewebtoon KEEPS primary-title hit despite author mismatch",
      _match_is_trustworthy_for_site("linewebtoon", elec, ["Eleceed"],
                                     ["Jeho Son / ZHENA"]) is True)

# ── Author corroborates a synonym-only match -> keep ─────────────────────────
syn_ok = _media("Totally Different Romaji", synonyms=["My Webtoon"],
                staff=["Jane Creator"])
check("author-match on a synonym-only hit -> KEEP (author corroborates)",
      _match_is_trustworthy_for_site("linewebtoon", syn_ok, ["My Webtoon"],
                                     ["Jane Creator"]) is True)

# ── Conservative: no usable author on either side + synonym-only -> reject ────
no_author = _media("JP Romaji Thing", synonyms=["Unordinary Life"], staff=[])
check("no candidate staff + synonym-only -> REJECT (can't corroborate)",
      _match_is_trustworthy_for_site("linewebtoon", no_author, ["unOrdinary"],
                                     ["uru-chan"]) is False)
check("no site author + synonym-only -> REJECT (can't corroborate)",
      _match_is_trustworthy_for_site("linewebtoon", unord, ["unOrdinary"],
                                     []) is False)
# ...but a primary-title hit still passes with no author on either side.
prim_no_author = _media("Eleceed", staff=[])
check("no author anywhere but PRIMARY-title hit -> KEEP",
      _match_is_trustworthy_for_site("linewebtoon", prim_no_author, ["Eleceed"],
                                     []) is True)

# ── Scope: the gate is a NO-OP for non-gated sites (unchanged behavior) ──────
check("mangadex (non-gated) KEEPS the unOrdinary-shape poison (no regression)",
      _match_is_trustworthy_for_site("mangadex", unord, ["unOrdinary"],
                                     ["uru-chan"]) is True)
check("empty handler_name -> non-gated -> KEEP",
      _match_is_trustworthy_for_site("", unord, ["unOrdinary"],
                                     ["uru-chan"]) is True)

# ── Safety: empty gate titles never blocks (pathological titleless input) ────
check("empty site_scoring_titles -> KEEP (nothing to corroborate against)",
      _match_is_trustworthy_for_site("linewebtoon", unord, [], ["uru-chan"])
      is True)

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
