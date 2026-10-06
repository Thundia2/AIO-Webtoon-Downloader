"""Fast offline dev loop for group selection + MTL detection.

    python tools/_test_group_selection.py

Same ground as tests/test_group_selection.py but with no pytest dependency and
a single N/N line, matching the house style of _test_backoff_aimd.py /
_test_lw_author_gate.py. The pytest file is the SHIPPED coverage; this one is
for iterating on the ranker without paying conftest's torch probe (~13s).

Cross-file: sites/base.py (_rank_version, build_group_census),
sites/group_quality.py (classify_mtl).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sites.base import (  # noqa: E402
    BaseSiteHandler,
    GroupInfo,
    GroupSelectionPolicy,
    build_group_census,
)
from sites.group_quality import (  # noqa: E402
    MTL_CONFIRMED,
    MTL_NONE,
    MTL_SUSPECT,
    classify_mtl,
)

H = BaseSiteHandler()
_passed = 0
_failed = []


def check(label, got, expected):
    global _passed
    if got == expected:
        _passed += 1
    else:
        _failed.append(f"{label}: expected {expected!r}, got {got!r}")


def v(chap="1", groups=None, **extra):
    d = {"chap": chap}
    if groups is not None:
        d["_groups"] = [
            g if isinstance(g, GroupInfo) else GroupInfo(name=g) for g in groups
        ]
    d.update(extra)
    return d


def pick(versions, preferred=(), mix=False, policy=None, fallback=True):
    best = H.select_best_chapter_version(
        versions, list(preferred), mix,
        allow_group_fallback=fallback, selection_policy=policy,
    )
    return best.get("id") if best else None


# ── MTL classifier ────────────────────────────────────────────────────────
for name in ("MTL Sans", "100% MTL", "MTL-Scans", "Machine Translated",
             "Machiner Translate", "AI Translations", "AI-TL", "AI_Translated",
             "NEET-GPT 1.0", "DeepL Diaries", "Google Translate Gang"):
    check(f"mtl confirmed {name!r}", classify_mtl(name)[0], MTL_CONFIRMED)

for name in ("Aiden Scans", "Ai", "Rainbow Ai", "Aiko TL", "Ai Translations",
             "Formatl", "Botan Scans", "Kaiju Translations",
             "Machine Doll Translations", "Alpha", "MangaPlus", "LINE Webtoon"):
    check(f"mtl clean {name!r}", classify_mtl(name)[0], MTL_NONE)

check("bare AI is suspect", classify_mtl("AI Scans")[0], MTL_SUSPECT)
check("description promotes",
      classify_mtl("Impatient Scans", description="Uploading MTL chapters")[0],
      MTL_CONFIRMED)
check("description 'bot' does not promote",
      classify_mtl("Real Group", description="our bot posts to Discord")[0],
      MTL_NONE)

# ── canonical model ───────────────────────────────────────────────────────
for key in ("group_name", "group", "scanlator", "publisher"):
    check(f"legacy key {key}", H.get_group_name({key: "Alpha"}), "Alpha")
check("no group", H.get_group_name({}), None)
check("_groups joins", H.get_group_name(v(groups=["A", "B"])), "A, B")
check("Originals != Canvas",
      H.get_group_match_key("LINE Webtoon") == H.get_group_match_key("LINE Webtoon Canvas"),
      False)
check("official alias uses flag",
      H.group_matches_filter([GroupInfo(name="MangaPlus", is_official=True)], "official"),
      True)
check("fan group not official",
      H.group_matches_filter([GroupInfo(name="Webtoon Scans")], "official"),
      False)

# ── ranker ────────────────────────────────────────────────────────────────
check("all-zero upvotes not first-wins",
      pick([v(groups=["MTL Sans"], id="a"), v(groups=["Alpha"], id="b")]), "b")
check("missing up_count != 0",
      pick([v(groups=["A"], id="none"), v(groups=["B"], up_count=5, id="five")]),
      "none")
check("comparable upvotes decide",
      pick([v(groups=["A"], up_count=10, id="lo"), v(groups=["B"], up_count=5000, id="hi")]),
      "hi")
check("MTL loses despite 9999 votes",
      pick([v(groups=["MTL Sans"], up_count=9999, id="mtl"),
            v(groups=["Real"], up_count=3, id="human")]), "human")
check("MTL-only still downloads",
      pick([v(groups=["MTL Sans"], id="only")]), "only")
check("--mtl exclude skips MTL-only",
      pick([v(groups=["MTL Sans"], id="x")], policy=GroupSelectionPolicy(mtl="exclude")),
      None)
check("--mtl exclude keeps suspect",
      pick([v(groups=["AI Scans"], id="s")], policy=GroupSelectionPolicy(mtl="exclude")),
      "s")
check("--mtl allow makes the tier inert",
      pick([v(groups=["MTL Sans"], id="mtl"), v(groups=["Human"], id="human")],
           policy=GroupSelectionPolicy(mtl="allow")), "mtl")
check("undownloadable loses",
      pick([v(groups=["MangaPlus"], _undownloadable=True, id="ext"),
            v(groups=["Fan"], id="fan")]), "fan")
check("undownloadable wins when alone",
      pick([v(groups=["MangaPlus"], _undownloadable=True, id="ext")]), "ext")
check("official beats fan",
      pick([v(groups=["Fan"], id="fan"),
            v(groups=[GroupInfo(name="MangaPlus", is_official=True)], id="off")]), "off")

# ── page band (real atsumaru Solo Leveling ch.1 counts) ───────────────────
check("22/22/19/14 -> no page discrimination",
      pick([v(groups=[f"G{i}"], _pages=p, id=f"p{i}")
            for i, p in enumerate([22, 22, 19, 14])]), "p0")
check("3-page stub loses",
      pick([v(groups=["S"], _pages=3, id="stub"), v(groups=["A"], _pages=22, id="a"),
            v(groups=["B"], _pages=19, id="b")]) != "stub", True)
check("short chapters inert",
      pick([v(groups=["A"], _pages=4, id="a"), v(groups=["B"], _pages=3, id="b")]), "a")

# ── census ────────────────────────────────────────────────────────────────
by_num = {}
for i in range(1, 202):
    row = [v(chap=str(i), groups=["Alpha"])]
    if i <= 12:
        row.append(v(chap=str(i), groups=["Filler"]))
    by_num[str(i)] = row
census, total = build_group_census(H, by_num)
check("census counts", (census, total), ({"alpha": 201, "filler": 12}, 201))
pol = GroupSelectionPolicy(census=census, census_total=total)
check("long run beats filler dump",
      pick([v(groups=["Filler"], id="filler"), v(groups=["Alpha"], id="alpha")], policy=pol),
      "alpha")

dupes = {"5": [v(chap="5", groups=["A"]) for _ in range(3)]}
check("census dedupes re-uploads", build_group_census(H, dupes), ({"a": 1}, 1))

tie = {str(i): [v(chap=str(i), groups=["A"]), v(chap=str(i), groups=["B"])]
       for i in range(1, 101)}
c2, t2 = build_group_census(H, tie)
check("two full runs tie -> recency",
      pick([v(groups=["A"], uploaded=100, id="old"), v(groups=["B"], uploaded=200, id="new")],
           policy=GroupSelectionPolicy(census=c2, census_total=t2)), "new")

# ── user filters ──────────────────────────────────────────────────────────
check("--group overrides MTL demotion",
      pick([v(groups=["Real"], id="real"), v(groups=["MTL Sans"], id="mtl")],
           preferred=["MTL Sans"]), "mtl")
check("priority order respected",
      pick([v(groups=["A"], id="a"), v(groups=["B"], id="b")], preferred=["B", "A"]), "b")
check("--no-group-fallback skips",
      pick([v(groups=["A"], id="a")], preferred=["Nobody"], fallback=False), None)
check("multi-group matches one member",
      pick([v(groups=["X", "Y"], id="xy"), v(groups=["Z"], id="z")], preferred=["X"]), "xy")
excl = GroupSelectionPolicy(excluded_keys=frozenset({H.get_group_match_key("Bad")}))
check("--exclude-group demotes",
      pick([v(groups=["Bad"], id="bad"), v(groups=["Good"], id="good")], policy=excl), "good")
check("--exclude-group used when only option",
      pick([v(groups=["Bad"], id="bad")], policy=excl), "bad")
check("mix-by-upvote ranks the union",
      pick([v(groups=["A"], up_count=10, id="a"), v(groups=["B"], up_count=500, id="b"),
            v(groups=["C"], up_count=9999, id="c")], preferred=["A", "B"], mix=True), "b")

# ── contracts ─────────────────────────────────────────────────────────────
_src = [v(groups=["A"], id="a")]
H.select_best_chapter_version(_src, [], False)
check("input not mutated", "_group_selection" in _src[0], False)
check("empty list", H.select_best_chapter_version([], [], False), None)
check("duplicate-equal rows survive",
      H.select_best_chapter_version([v(groups=["A"]), v(groups=["A"])], [], False) is not None,
      True)

import sites  # noqa: E402

check("no handler overrides the selector or reader",
      [type(h).__name__ for h in sites._BASE_HANDLERS
       if type(h).select_best_chapter_version is not BaseSiteHandler.select_best_chapter_version
       or type(h).get_group_name is not BaseSiteHandler.get_group_name],
      [])


total_checks = _passed + len(_failed)
for line in _failed:
    print("FAIL", line)
print(f"{_passed}/{total_checks} checks passed")
sys.exit(1 if _failed else 0)
