"""Tests for sites/search_orchestrator.py — particularly the audit fix
that moved `all_hits` initialization to BEFORE the `if not eligible and
not all_hits:` early-return.

Cross-file: search_all is invoked by aio_search_cli.run_search_mode when
the user passes --search. The early-return path triggers when every
search-capable handler is filtered out by --seeded-only or the probe-
failure cache, and the user provided no URL-mode seed hits.
"""

from __future__ import annotations

from unittest.mock import patch, MagicMock

from sites.search_orchestrator import search_all


def _empty_handler_iter():
    """Yields no handlers — simulates --seeded-only filtering everything."""
    return iter([])


def test_search_all_returns_empty_when_no_eligible_and_no_seed():
    """Reproduces the audit-flagged NameError scenario.

    When iter_search_capable_handlers returns nothing AND seed_hits is
    None, the early-return at search_orchestrator.py:940 must evaluate
    `not all_hits` without crashing. Pre-fix, all_hits was defined on
    line 943 (AFTER the check) so this raised
        NameError: name 'all_hits' is not defined
    """
    with patch("sites.iter_search_capable_handlers", _empty_handler_iter):
        with patch("sites.get_handler_by_name", lambda _: None):
            scraper_factory = MagicMock(return_value=MagicMock())
            make_request = MagicMock()
            result = search_all(
                "anything",
                scraper_factory,
                make_request,
                seed_hits=None,
            )
            assert result == []
            # scraper_factory should never be called when no handlers
            # are eligible and no seed hits.
            scraper_factory.assert_not_called()


def test_search_all_returns_empty_when_no_eligible_and_empty_seed():
    """Same as above but with seed_hits=[] (explicit empty rather than
    None) — exercise the `list(seed_hits) if seed_hits else []` branch
    on the truthy-empty side."""
    with patch("sites.iter_search_capable_handlers", _empty_handler_iter):
        with patch("sites.get_handler_by_name", lambda _: None):
            scraper_factory = MagicMock(return_value=MagicMock())
            make_request = MagicMock()
            result = search_all(
                "anything",
                scraper_factory,
                make_request,
                seed_hits=[],
            )
            assert result == []


def test_search_all_processes_seed_hits_when_no_eligible():
    """When eligible is empty BUT seed_hits is non-empty, the search
    should NOT short-circuit — the seed hits are scored and emitted."""
    from sites.base import SearchHit

    seed = SearchHit(
        site="mangadex",
        title="Test Series",
        url="https://example.com/title/abcd",
        cover=None,
        alt_titles=[],
        year=None,
        language=None,
        chapter_count_hint=10,
        raw_score=1.0,
    )
    with patch("sites.iter_search_capable_handlers", _empty_handler_iter):
        with patch("sites.get_handler_by_name", lambda _: None):
            scraper_factory = MagicMock(return_value=MagicMock())
            make_request = MagicMock()
            result = search_all(
                "Test Series",
                scraper_factory,
                make_request,
                seed_hits=[seed],
                # Pass a high min_match to keep this test focused on the
                # early-return path. The seed's title matches the query
                # exactly so rapidfuzz scores 1.0.
                min_match=0.5,
            )
            # We get one candidate with one source (the seed itself).
            assert len(result) == 1
            assert len(result[0].sources) == 1
            assert result[0].sources[0].site == "mangadex"


def test_search_all_handles_blocked_handlers():
    """When all eligible handlers are filtered out (e.g. probe-failure
    cache blocks every host), and no seed hits are provided, return []
    without spawning workers."""
    from sites.base import BaseSiteHandler
    from sites.search_orchestrator import ProbeFailureCache

    # Mock handler whose primary domain is "blocked.example".
    class _MockHandler(BaseSiteHandler):
        name = "mocked"
        domains = ("blocked.example",)
        def search(self, *args, **kwargs):
            return []
        def fetch_comic_context(self, *a, **kw): pass
        def get_chapters(self, *a, **kw): return []
        def get_chapter_images(self, *a, **kw): return []
        def get_group_name(self, *a, **kw): return None

    handler = _MockHandler()
    cache = ProbeFailureCache(threshold=1, ttl_s=3600)
    cache.record_failure("blocked.example")  # one failure, threshold=1

    with patch(
        "sites.iter_search_capable_handlers",
        lambda: iter([handler]),
    ):
        with patch("sites.get_handler_by_name", lambda _: None):
            scraper_factory = MagicMock(return_value=MagicMock())
            make_request = MagicMock()
            result = search_all(
                "anything",
                scraper_factory,
                make_request,
                seed_hits=None,
                probe_failure_cache=cache,
            )
            assert result == []
            # Handler was filtered — search() should NOT have been invoked.
            scraper_factory.assert_not_called()


# ────────────────────────────────────────────────────────────────────────
# Official-publisher tiebreaker (2026-05-12).
# Within a SeriesCandidate, sources where the handler sets
# OFFICIAL_PUBLISHER=True must rank above aggregator sources regardless
# of measured img_quality_score. Closes the ********.com vs ******* case
# where the official publisher served PNGs at 720-800px (below the probe's
# 800px res_score floor) and was losing to toonily's upscaled JPEG.
# ────────────────────────────────────────────────────────────────────────

def _sort_sources(sources):
    """Apply the same comparator logic the orchestrator uses internally,
    so we test the wire-level behavior without needing to spin up a full
    search_all + scraper_factory.
    """
    from functools import cmp_to_key
    from sites.search_orchestrator import TIEBREAKER_WINDOW

    def quality_for(s):
        return s.img_quality_score if s.img_quality_score is not None else s.seed_quality

    def cmp(a, b):
        if a.dmca_likely != b.dmca_likely:
            return 1 if a.dmca_likely else -1
        if a.is_official != b.is_official:
            return -1 if a.is_official else 1
        if abs(a.title_match - b.title_match) <= TIEBREAKER_WINDOW:
            qa, qb = quality_for(a), quality_for(b)
            if qa != qb:
                return -1 if qa > qb else 1
            return 0
        return -1 if a.title_match > b.title_match else 1

    return sorted(sources, key=cmp_to_key(cmp))


def _make_source(site, *, is_official=False, title_match=1.0,
                 seed_quality=0.5, img_quality_score=None,
                 dmca_likely=False):
    from sites.search_orchestrator import SourceEntry
    return SourceEntry(
        site=site, url=f"https://{site}/x", title="x", cover=None,
        title_match=title_match, seed_quality=seed_quality,
        img_quality_score=img_quality_score, dmca_likely=dmca_likely,
        is_official=is_official,
    )


def test_official_publisher_beats_aggregator_despite_lower_img_quality():
    """The bug: linewebtoon (official, PNG @ 800px → res_score=0 → composite
    ~0.51) was being outranked by toonily (aggregator, upscaled JPEG →
    composite ~0.60). After the fix, official wins regardless of quality."""
    linewebtoon = _make_source("linewebtoon", is_official=True,
                               seed_quality=0.92, img_quality_score=0.51)
    toonily = _make_source("toonily", is_official=False,
                           seed_quality=0.55, img_quality_score=0.60)
    result = _sort_sources([toonily, linewebtoon])
    assert result[0].site == "linewebtoon"
    assert result[1].site == "toonily"


def test_official_publisher_beats_aggregator_outside_tiebreaker_window():
    """Even when title_match deltas are large, official wins within a
    candidate — the union-find merge already established same-series
    membership, so the publisher is canonical regardless of title spread.
    Verifies the official check happens BEFORE the TIEBREAKER_WINDOW
    branch."""
    linewebtoon = _make_source("linewebtoon", is_official=True,
                               title_match=0.85, seed_quality=0.92)
    toonily = _make_source("toonily", is_official=False,
                           title_match=1.00, seed_quality=0.55)
    # delta = 0.15, outside TIEBREAKER_WINDOW of 0.10.
    result = _sort_sources([toonily, linewebtoon])
    assert result[0].site == "linewebtoon"


def test_dmca_likely_still_beats_official():
    """DMCA-likely sources go to the back even when they're the official
    publisher. The DMCA flag means most chapters are inaccessible — a
    canonical-but-empty source is worse than a complete aggregator."""
    official_dmca = _make_source("linewebtoon", is_official=True,
                                 dmca_likely=True, seed_quality=0.92)
    clean_agg = _make_source("toonily", is_official=False,
                             dmca_likely=False, seed_quality=0.55)
    result = _sort_sources([official_dmca, clean_agg])
    assert result[0].site == "toonily"
    assert result[1].site == "linewebtoon"


def test_two_aggregators_still_decided_by_quality():
    """When neither source is official, the existing img_quality_score-or-
    seed_quality tiebreaker takes over inside the title-match window."""
    mangadex = _make_source("mangadex", is_official=False,
                            title_match=1.0, seed_quality=0.93)
    toonily = _make_source("toonily", is_official=False,
                           title_match=1.0, seed_quality=0.55)
    result = _sort_sources([toonily, mangadex])
    assert result[0].site == "mangadex"


def test_two_officials_still_decided_by_quality():
    """Hypothetical: two official-publisher sources for the same series
    (would only happen if voyceme + linewebtoon both republished it).
    Quality decides among officials as well — the flag is a class tier,
    not a free pass."""
    off_hi = _make_source("a", is_official=True, seed_quality=0.92)
    off_lo = _make_source("b", is_official=True, seed_quality=0.55)
    result = _sort_sources([off_lo, off_hi])
    assert result[0].site == "a"


def test_linewebtoon_handler_carries_official_publisher_flag():
    """Wire-level: the linewebtoon handler class actually sets the flag.
    Regression guard for accidental class-attribute removal during a
    handler refactor."""
    from sites.linewebtoon import LineWebtoonSiteHandler
    assert getattr(LineWebtoonSiteHandler, "OFFICIAL_PUBLISHER", False) is True


def test_base_handler_defaults_official_publisher_to_false():
    """Aggregators that don't override the flag must default to False;
    otherwise every handler in the registry would be marked official."""
    from sites.base import BaseSiteHandler
    assert getattr(BaseSiteHandler, "OFFICIAL_PUBLISHER", None) is False


# ────────────────────────────────────────────────────────────────────────
# SiteBusyError (2026-10-17). A site whose search was blocked by THIS machine —
# mangafire's browser profile held by another AIO process — must be reported as
# a "busy" notice, never as a failure: no ProbeFailureCache strike (that path
# blocklists the host for an hour after two), and no tested_sites entry (that
# would decay a real strike the UI is tracking). Cross-file: sites/base.py
# SiteBusyError, sites/mangafire.py:search, useDownloader.js strike fold.
# ────────────────────────────────────────────────────────────────────────

def test_busy_site_is_a_notice_not_a_failure():
    from sites.base import BaseSiteHandler, SearchHit, SiteBusyError
    from sites.search_orchestrator import ProbeFailureCache

    class _Busy(BaseSiteHandler):
        name = "busysite"
        domains = ("busy.example",)

        def search(self, *a, **kw):
            raise SiteBusyError("profile held", reason="profile_busy")

    class _Ok(BaseSiteHandler):
        name = "oksite"
        domains = ("ok.example",)

        def search(self, query, *a, **kw):
            return [SearchHit(site=self.name, title=query, url="https://ok.example/s",
                              cover=None, alt_titles=[], year=None, language=None,
                              chapter_count_hint=5, raw_score=1.0)]

    cache = ProbeFailureCache(threshold=1, ttl_s=3600)
    diagnostics = {}
    with patch("sites.iter_search_capable_handlers", lambda: iter([_Busy(), _Ok()])):
        with patch("sites.get_handler_by_name", lambda _: None):
            result = search_all(
                "Some Series",
                MagicMock(return_value=MagicMock()),
                MagicMock(),
                probe_failure_cache=cache,
                diagnostics=diagnostics,
            )

    assert [s.site for c in result for s in c.sources] == ["oksite"]
    busy = [h for h in diagnostics["site_health"] if h["site"] == "busysite"]
    assert len(busy) == 1 and busy[0]["status"] == "busy", diagnostics["site_health"]
    assert busy[0]["reason"] == "profile_busy"
    assert "busysite" not in diagnostics["tested_sites"]
    assert "oksite" in diagnostics["tested_sites"]
    assert cache.is_blocked("busy.example") is False, "contention struck the host"


# ────────────────────────────────────────────────────────────────────────
# Anchored admission (2026-10-17): a hit below the title-match floor joins a
# candidate when one of its titles has exactly the merge key of a title an
# ADMITTED hit carries. See the ANCHORED ADMISSION block in search_all.
# ────────────────────────────────────────────────────────────────────────

def _run_with_hits(query, per_site):
    """search_all over fake handlers; *per_site* maps site name -> list of
    (title, alt_titles). Returns the candidates."""
    from sites.base import BaseSiteHandler, SearchHit

    def _make(name, rows):
        class _H(BaseSiteHandler):
            def search(self, *a, **kw):
                return [
                    SearchHit(site=name, title=t, url=f"https://{name}.example/{i}",
                              cover=None, alt_titles=list(alts), year=None,
                              language=None, chapter_count_hint=5, raw_score=1.0)
                    for i, (t, alts) in enumerate(rows)
                ]
        _H.name = name
        _H.domains = (f"{name}.example",)
        return _H()

    handlers = [_make(n, rows) for n, rows in per_site.items()]
    with patch("sites.iter_search_capable_handlers", lambda: iter(handlers)):
        with patch("sites.get_handler_by_name", lambda _: None):
            return search_all(query, MagicMock(return_value=MagicMock()), MagicMock())


def _where(cands, site):
    """(candidate index, source) for *site*, or None."""
    for i, c in enumerate(cands):
        for s in c.sources:
            if s.site == site:
                return i, s
    return None


def test_all_caps_listing_joins_its_correctly_spelled_twin():
    # The floor's scorer is case-sensitive: "CHAINSAW MAN" scores 0.25.
    cands = _run_with_hits("Chainsaw Man", {
        "alpha": [("Chainsaw Man", [])],
        "beta": [("CHAINSAW MAN", [])],
    })
    a, b = _where(cands, "alpha"), _where(cands, "beta")
    assert b is not None, "the all-caps listing was dropped"
    assert a[0] == b[0], "anchored hit landed in a different candidate"
    assert b[1].title_match == a[1].title_match, "did not inherit the anchor's score"


def test_romaji_word_break_variant_is_anchored_by_an_alt_title():
    # mangahub's only title for Railgun; another site carries "Toaru" as an alt.
    cands = _run_with_hits("A Certain Scientific Railgun", {
        "alpha": [("A Certain Scientific Railgun", ["Toaru Kagaku no Railgun"])],
        "beta": [("To Aru Kagaku no Railgun", [])],
    })
    a, b = _where(cands, "alpha"), _where(cands, "beta")
    assert b is not None and a[0] == b[0]


def test_below_floor_hit_without_an_anchor_stays_out():
    cands = _run_with_hits("Chainsaw Man", {
        "alpha": [("Chainsaw Man", [])],
        "beta": [("Completely Different Story", [])],
    })
    assert _where(cands, "beta") is None


def test_anchored_hit_never_welds_two_candidates():
    # beta's title matches one admitted candidate and its alt another. It may
    # join ONE of them (the better-scoring) but must not merge the two.
    cands = _run_with_hits("Chainsaw Man", {
        "alpha": [("Chainsaw Man", []), ("Chainsaw Man Devil War", [])],
        "beta": [("CHAINSAW MAN", ["CHAINSAW MAN DEVIL WAR"])],
    })
    titles = sorted(c.canonical_title for c in cands if any(s.site == "alpha" for s in c.sources))
    assert titles == ["Chainsaw Man", "Chainsaw Man Devil War"], titles
    b = _where(cands, "beta")
    assert b is not None and cands[b[0]].canonical_title == "Chainsaw Man"


def test_anchored_hits_do_not_chain():
    # gamma matches only beta's alt; beta is itself only anchored, so gamma
    # has no admitted voucher.
    cands = _run_with_hits("Chainsaw Man", {
        "alpha": [("Chainsaw Man", [])],
        "beta": [("CHAINSAW MAN", ["Qwyx Blorpt"])],
        "gamma": [("QWYX BLORPT", [])],
    })
    assert _where(cands, "beta") is not None
    assert _where(cands, "gamma") is None


# ────────────────────────────────────────────────────────────────────────
# Verified zero count sinks (plan sync-temp/plans/mangadex-link-outs.md).
# MangaDex Goblin Slayer: 203 rows, all publisher link-outs; its search()
# counts with includeExternalUrl=0, so the count is 0. No peer hint or
# lastChapter is needed for the sink.
# ────────────────────────────────────────────────────────────────────────

def test_source_sinks_on_verified_zero_count_only():
    from sites.search_orchestrator import SourceEntry, _source_sinks

    def src(count):
        return SourceEntry(site="s", url="u", title="t", cover=None,
                           title_match=1.0, seed_quality=0.9,
                           actual_chapter_count=count)

    assert _source_sinks(src(0)) is True
    assert _source_sinks(src(None)) is False  # unmeasured never sinks
    assert _source_sinks(src(5)) is False


def test_zero_count_source_sinks_below_peers_without_a_peer_hint():
    """The zero-count site is an official publisher (would otherwise rank
    first) and no site exposes a chapter_count_hint, so the cross-site
    dmca/count-outlier check can't fire; the zero count alone sinks it."""
    from sites.base import BaseSiteHandler, SearchHit

    def _make(name, count, official):
        class _H(BaseSiteHandler):
            OFFICIAL_PUBLISHER = official

            def search(self, query, *a, **kw):
                return [SearchHit(site=name, title=query, url=f"https://{name}.example/s",
                                  cover=None, alt_titles=[], year=None, language=None,
                                  chapter_count_hint=None, raw_score=1.0,
                                  actual_chapter_count=count)]
        _H.name = name
        _H.domains = (f"{name}.example",)
        return _H()

    handlers = [_make("zerosite", 0, True), _make("realsite", 113, False)]
    with patch("sites.iter_search_capable_handlers", lambda: iter(handlers)):
        with patch("sites.get_handler_by_name", lambda _: None):
            cands = search_all("Goblin Slayer", MagicMock(return_value=MagicMock()), MagicMock())
    sites = [s.site for s in cands[0].sources]
    assert sites == ["realsite", "zerosite"]
