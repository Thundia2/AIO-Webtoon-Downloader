"""Offline regression for the 2026-07-12 search/multi-source performance
rework (plan: ~/.claude/plans/try-to-find-ways-vast-eagle.md). No network,
no browser — handler registry, quality seed, and T2 warmup are monkeypatched.

Covers:
  1. FetchMemo (sites/fetch_memo.py) — fetch-once semantics, language-key
     isolation, deep-copy mutation isolation, no negative caching, put_*.
  2. ImageQualityCache clamped entries — write flag, disk-reload passthrough
     (_load_snapshot's fixed key set), TTL shortening + min() rule.
  3. _desired_max_samples — probe-depth plan (top/non-top/quick-probe).
  4. _quality_basis + to_json `quality_basis` — chapter_probe/cover/seed.
  5. mangadex _DMCA_PROBE_MAX_HITS — per-hit probe capped at 5.
  6. search_all e2e (fake handlers) — clamped write for non-top candidates,
     clamped-entry NOT served for a full-breadth target (re-probed +
     rewritten unclamped), PROBE_SAMPLES_FIXED always unclamped + served,
     probe_candidate_limit scoping, skip_probe_sites interplay.
  7. Fan-out soft barrier + late adoption — stragglers merge post-T3 with
     seed/cached rating; wedged handler doesn't block the return.
  8. T3 pairwise — parallel page-fetch produces IDENTICAL adjustments to a
     forced-serial run; higher-quality source wins.
  9. _fetch_chapters_for_winner + memo — zero re-fetch for probe-warmed
     sources, bounded shim used instead of the passed make_request,
     `_locked` strip isolated from the memo's copy.

Run: python tools/_test_search_perf_opts.py   (exit 0 = all pass)
"""
import copy
import io
import os
import sys
import tempfile
import threading
import time
import types

# Repo root on sys.path (script dir is tools/) — same shim as _test_rank_guard.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sites
import sites.search_orchestrator as so
import aio_search_cli as cli
from sites.base import BaseSiteHandler, SearchHit
from sites.fetch_memo import FetchMemo
from sites.search_orchestrator import (
    ImageQualityCache,
    IMG_QUALITY_CLAMPED_TTL_S,
    IMG_QUALITY_TTL_S,
    SeriesCandidate,
    SourceEntry,
    _desired_max_samples,
    _quality_basis,
    search_all,
)
from PIL import Image

results = []


def check(name, cond):
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")
    results.append(bool(cond))


# Grab the REAL mangadex handler before any registry patching (suite 5).
MD_HANDLER = sites.get_handler_by_name("mangadex")

_REAL_EXPANDUSER = os.path.expanduser


def make_tmp_cache(ttl_s=None):
    """ImageQualityCache pointed at a fresh temp dir (never the real
    ~/.aio-dl/cache). Same expanduser patch idiom as
    tests/test_image_quality_cache.py's fixture."""
    tmpdir = tempfile.mkdtemp(prefix="aio-imgq-")
    os.path.expanduser = lambda p: tmpdir
    try:
        c = ImageQualityCache(**({"ttl_s": ttl_s} if ttl_s is not None else {}))
    finally:
        os.path.expanduser = _REAL_EXPANDUSER
    return c, tmpdir


def reload_cache(tmpdir):
    os.path.expanduser = lambda p: tmpdir
    try:
        return ImageQualityCache()
    finally:
        os.path.expanduser = _REAL_EXPANDUSER


# Metadata that survives ImageQualityCache._load_snapshot's REQUIRED_V6_FIELDS
# gate AND counts as a real chapter probe for _quality_basis.
def full_meta(samples_succeeded=3, **extra):
    m = {
        "t1_score": 0.7, "res_norm": 0.5, "blockiness": 0.1,
        "fft_hf_ratio": 0.55, "tenengrad_norm": 0.9,
        "content_type": "bw_manga", "tenengrad_clean": 0.9,
        "width": 1200, "height": 1800, "format": "JPEG",
        "samples_attempted": 8, "samples_succeeded": samples_succeeded,
    }
    m.update(extra)
    return m


# ─────────────────────────────────────────────── 1. FetchMemo
print("── FetchMemo ──")


class CountingHandler(BaseSiteHandler):
    def __init__(self, name, chapters=None, ctx_exc=None, chap_exc_once=False,
                 empty_once=False):
        self.name = name
        self.domains = (f"{name}.example",)
        self._chapters = chapters or [
            {"chap": "1", "url": f"https://{name}/c1"},
            {"chap": "2", "url": f"https://{name}/c2", "_locked": True},
        ]
        self.ctx_calls = 0
        self.chap_calls = 0
        self._ctx_exc = ctx_exc
        self._chap_exc_once = chap_exc_once
        self._empty_once = empty_once

    def fetch_comic_context(self, url, scraper, make_request):
        self.ctx_calls += 1
        if self._ctx_exc:
            raise self._ctx_exc
        return types.SimpleNamespace(title=self.name, comic={"title": self.name, "url": url})

    def get_chapters(self, ctx, scraper, language, make_request):
        self.chap_calls += 1
        if self._chap_exc_once:
            self._chap_exc_once = False
            raise RuntimeError("transient")
        if self._empty_once:
            self._empty_once = False
            return []
        return copy.deepcopy(self._chapters)


memo = FetchMemo()
h1 = CountingHandler("memo1")
ctx_a = memo.get_context(h1, "https://memo1/s", None, None)
ctx_b = memo.get_context(h1, "https://memo1/s", None, None)
check("memo: context fetched once, same object", h1.ctx_calls == 1 and ctx_a is ctx_b)

ch_a = memo.get_chapters(h1, "https://memo1/s", "en", None, None)
ch_b = memo.get_chapters(h1, "https://memo1/s", "en", None, None)
check("memo: chapters fetched once (ctx reused)", h1.chap_calls == 1 and h1.ctx_calls == 1)
check("memo: chapters distinct copies", ch_a is not ch_b and ch_a == ch_b)
ch_a.pop()
ch_a[0]["mutated"] = True
ch_c = memo.get_chapters(h1, "https://memo1/s", "en", None, None)
check("memo: caller mutation isolated", len(ch_c) == 2 and "mutated" not in ch_c[0])
memo.get_chapters(h1, "https://memo1/s", "de", None, None)
check("memo: language keys isolated (de refetches)", h1.chap_calls == 2)

h2 = CountingHandler("memo2", chap_exc_once=True)
raised = False
try:
    memo.get_chapters(h2, "https://memo2/s", "en", None, None)
except RuntimeError:
    raised = True
ok2 = memo.get_chapters(h2, "https://memo2/s", "en", None, None)
check("memo: no negative caching (exception propagates, retry succeeds)",
      raised and len(ok2) == 2 and h2.chap_calls == 2)

h3 = CountingHandler("memo3", empty_once=True)
e1 = memo.get_chapters(h3, "https://memo3/s", "en", None, None)
e2 = memo.get_chapters(h3, "https://memo3/s", "en", None, None)
check("memo: empty list not stored (refetched)", e1 == [] and len(e2) == 2 and h3.chap_calls == 2)

h4 = CountingHandler("memo4")
memo.put_context("memo4", "https://memo4/s", types.SimpleNamespace(title="pre"))
memo.put_chapters("memo4", "https://memo4/s", "en", [{"chap": "9", "url": "u"}])
pre_ctx = memo.get_context(h4, "https://memo4/s", None, None)
pre_ch = memo.get_chapters(h4, "https://memo4/s", "en", None, None)
check("memo: put_context/put_chapters pre-populate (0 handler calls)",
      h4.ctx_calls == 0 and h4.chap_calls == 0
      and pre_ctx.title == "pre" and pre_ch == [{"chap": "9", "url": "u"}])

builds = []
s1 = memo.get_scraper("memo1", "https://memo1/s", lambda: builds.append(1) or "SCRAPER")
s2 = memo.get_scraper("memo1", "https://memo1/s", lambda: builds.append(1) or "OTHER")
check("memo: scraper built once", s1 == "SCRAPER" and s2 == "SCRAPER" and len(builds) == 1)
line = memo.stats_line()
check("memo: stats line shape", line.startswith("[*] fetch-memo:") and "reused" in line)


# ─────────────────────────────────────────────── 2. clamped cache entries
print("── ImageQualityCache clamped ──")
cache, cdir = make_tmp_cache()
cache.set("siteX", "https://x/s", 0.62, metadata=full_meta(), clamped=True)
got = cache.get_full("siteX", "https://x/s")
check("clamped: in-memory get_full flag", got is not None and got[2] is True and abs(got[0] - 0.62) < 1e-9)
check("clamped: get()/get_with_metadata still serve", cache.get("siteX", "https://x/s") == 0.62
      and cache.get_with_metadata("siteX", "https://x/s") is not None)
entry = cache._state[cache._key("siteX", "https://x/s")]
ttl_left = entry["expires_at"] - time.time()
check("clamped: shorter TTL (~7d)", abs(ttl_left - IMG_QUALITY_CLAMPED_TTL_S) < 60)

re1 = reload_cache(cdir)
rgot = re1.get_full("siteX", "https://x/s")
check("clamped: flag survives disk reload", rgot is not None and rgot[2] is True)

cache.set("siteX", "https://x/s", 0.80, metadata=full_meta(), clamped=False)
got2 = cache.get_full("siteX", "https://x/s")
entry2 = cache._state[cache._key("siteX", "https://x/s")]
ttl_left2 = entry2["expires_at"] - time.time()
check("clamped: unclamped overwrite clears flag + full TTL",
      got2[2] is False and abs(ttl_left2 - IMG_QUALITY_TTL_S) < 60)
re2 = reload_cache(cdir)
check("clamped: cleared flag survives reload", re2.get_full("siteX", "https://x/s")[2] is False)

short, _sdir = make_tmp_cache(ttl_s=100)
short.set("s", "https://s/1", 0.5, metadata=full_meta(), clamped=True)
sleft = short._state[short._key("s", "https://s/1")]["expires_at"] - time.time()
check("clamped: min(ttl_s, clamped TTL) rule", abs(sleft - 100) < 5)


# ─────────────────────────────────────────────── 3. _desired_max_samples
print("── _desired_max_samples ──")


def _src(url, match=1.0):
    return SourceEntry(site="s", url=url, title="t", cover=None,
                       title_match=match, seed_quality=0.9)


class _Expensive:
    EXPENSIVE_PROBE = True


top_urls = {"https://top/1"}
check("plan: non-top -> 1", _desired_max_samples(_src("https://other/1"), None, top_urls) == 1)
check("plan: top -> None", _desired_max_samples(_src("https://top/1"), None, top_urls) is None)
check("plan: top + expensive + weak match -> 2",
      _desired_max_samples(_src("https://top/1", match=0.6), _Expensive(), top_urls) == 2)
check("plan: top + expensive + strong match -> None",
      _desired_max_samples(_src("https://top/1", match=0.99), _Expensive(), top_urls) is None)
check("plan: handler None degrades safely",
      _desired_max_samples(_src("https://top/1", match=0.6), None, top_urls) is None)


# ─────────────────────────────────────────────── 4. quality_basis
print("── _quality_basis / to_json ──")
s_probe = _src("u1"); s_probe.img_quality_score = 0.7; s_probe.img_quality_metadata = full_meta()
s_cover = _src("u2"); s_cover.img_quality_score = 0.6; s_cover.img_quality_metadata = {"width": 900, "format": "JPEG"}
s_fail = _src("u3"); s_fail.img_quality_score = 0.0; s_fail.img_quality_metadata = {"format": "FAILED", "samples_attempted": 8, "samples_succeeded": 0}
s_seed = _src("u4")
check("basis: chapter_probe", _quality_basis(s_probe) == "chapter_probe")
check("basis: cover (no samples key)", _quality_basis(s_cover) == "cover")
check("basis: cover (0/8 failed probe)", _quality_basis(s_fail) == "cover")
check("basis: seed (unmeasured)", _quality_basis(s_seed) == "seed")
cand_json = SeriesCandidate("t", None, [s_probe, s_seed]).to_json()
check("basis: to_json carries quality_basis",
      [x["quality_basis"] for x in cand_json["sources"]] == ["chapter_probe", "seed"])


# ─────────────────────────────────────────────── 5. mangadex DMCA cap
print("── mangadex DMCA probe cap ──")
from sites.mangadex import _DMCA_PROBE_MAX_HITS

md_counts = {"manga": 0, "chapter": 0}


class _MDResp:
    def __init__(self, payload):
        self._p = payload
    def json(self):
        return self._p


def md_mr(url, scraper):
    if "/chapter?" in url:
        md_counts["chapter"] += 1
        return _MDResp({"total": 50})
    md_counts["manga"] += 1
    return _MDResp({"data": [
        {"id": f"uuid-{i}",
         "attributes": {"title": {"en": f"Series {i}"}, "altTitles": [],
                        "year": 2020, "lastChapter": "50"},
         "relationships": []}
        for i in range(10)
    ]})


md_hits = MD_HANDLER.search("series", scraper=None, make_request=md_mr, language="en", limit=20)
check("mangadex: 10 hits returned", len(md_hits) == 10)
check(f"mangadex: DMCA probes capped at {_DMCA_PROBE_MAX_HITS}",
      md_counts["chapter"] == _DMCA_PROBE_MAX_HITS == 5)
check("mangadex: head hits carry actual counts",
      all(h.actual_chapter_count == 50 for h in md_hits[:5]))
check("mangadex: tail hits left unprobed (None)",
      all(h.actual_chapter_count is None for h in md_hits[5:]))


# ─────────────────────────────────────────────── shared fakes for search_all
class FakeScraper:
    """Serves canned bytes by URL for probe/T3 page fetches."""
    BYTES = {}

    def get(self, url, timeout=15, **kw):
        data = self.BYTES.get(url, b"")
        return types.SimpleNamespace(status_code=200 if data else 404, content=data)


class FakeSearchHandler(BaseSiteHandler):
    """search() + _probe_chapter_aggregate fakes with call recording."""

    def __init__(self, name, hits, probe_score=0.75, search_sleep=0.0,
                 probe_sleep=0.0, samples_fixed=False):
        self.name = name
        self.domains = (f"{name}.example",)
        self._hits = hits
        self._probe_score = probe_score
        self._search_sleep = search_sleep
        self._probe_sleep = probe_sleep
        if samples_fixed:
            self.PROBE_SAMPLES_FIXED = True
        self.probe_calls = []  # list of (url, max_samples)

    def search(self, query, scraper, make_request, *, language="en", limit=20):
        if self._search_sleep:
            time.sleep(self._search_sleep)
        return list(self._hits)

    def _probe_chapter_aggregate(self, hit, scraper, make_request,
                                 max_samples=None, fetch_memo=None):
        self.probe_calls.append((hit.url, max_samples))
        if self._probe_sleep:
            time.sleep(self._probe_sleep)
        return self._probe_score, full_meta()

    def _probe_cover_image(self, hit, scraper, make_request):
        return None


def mk_hit(site, title, url, year=2020):
    return SearchHit(site=site, title=title, url=url, cover=None,
                     alt_titles=[], year=year, language=None,
                     chapter_count_hint=100, raw_score=1.0)


_REAL_ITER = sites.iter_search_capable_handlers
_REAL_GET = sites.get_handler_by_name
_REAL_SEED_LOADER = so._load_quality_seed
_REAL_WARMUP = so.warmup_t2_models
_REAL_DEADLINE = so._FANOUT_DEADLINE_S

FAKES = {}


def install_fakes(handlers):
    FAKES.clear()
    FAKES.update({h.name: h for h in handlers})
    sites.iter_search_capable_handlers = lambda: list(FAKES.values())
    sites.get_handler_by_name = lambda name: FAKES.get(name)
    # Seed keys are LOWERCASE in the orchestrator (seed.get(site.lower())).
    so._load_quality_seed = lambda: {n.lower(): 0.9 for n in FAKES}
    so.warmup_t2_models = lambda background=True: None


def restore_registry():
    sites.iter_search_capable_handlers = _REAL_ITER
    sites.get_handler_by_name = _REAL_GET
    so._load_quality_seed = _REAL_SEED_LOADER
    so.warmup_t2_models = _REAL_WARMUP
    so._FANOUT_DEADLINE_S = _REAL_DEADLINE


def run_search(query, cache, limit=None, skip=None, statuses=None, memo=None):
    return search_all(
        query,
        lambda handler: FakeScraper(),
        lambda url, scraper: (_ for _ in ()).throw(RuntimeError("no network")),
        parallelism=4,
        min_match=0.55,
        probe_failure_cache=None,
        img_quality_cache=cache,
        skip_probe_sites=skip,
        on_status=(statuses.append if statuses is not None else None),
        probe_candidate_limit=limit,
        fetch_memo=memo,
    )


# ─────────────────────────────────────────────── 6. search_all probe rules
print("── search_all: clamped serve/write + probe scope ──")
try:
    A = FakeSearchHandler("mainA", [mk_hit("mainA", "Main Series", "https://a/main")])
    B = FakeSearchHandler("subB", [mk_hit("subB", "Main Series Anthology", "https://b/anth")])
    C = FakeSearchHandler("fixedC", [mk_hit("fixedC", "Main Series Anthology", "https://c/anth")],
                          samples_fixed=True)
    install_fakes([A, B, C])
    cache6, _ = make_tmp_cache()

    cands = run_search("Main Series", cache6)
    check("e2e: 2 candidates, main first",
          len(cands) == 2 and cands[0].canonical_title == "Main Series")
    check("e2e: top-candidate source probed full (max_samples=None)",
          A.probe_calls == [("https://a/main", None)])
    check("e2e: non-top source probed clamped (max_samples=1)",
          B.probe_calls == [("https://b/anth", 1)])
    check("e2e: PROBE_SAMPLES_FIXED probed with clamp arg but ignores it",
          C.probe_calls == [("https://c/anth", 1)])
    check("e2e: top entry cached unclamped",
          cache6.get_full("mainA", "https://a/main")[2] is False)
    check("e2e: non-top entry cached CLAMPED",
          cache6.get_full("subB", "https://b/anth")[2] is True)
    check("e2e: PROBE_SAMPLES_FIXED entry cached UNCLAMPED",
          cache6.get_full("fixedC", "https://c/anth")[2] is False)
    check("e2e: quality_basis chapter_probe for probed sources",
          all(s["quality_basis"] == "chapter_probe"
              for c in cands for s in c.to_json()["sources"]))

    # Run B: anthology becomes the TOP candidate -> B's clamped entry is a
    # MISS (full re-probe, rewritten unclamped); C's unclamped entry serves;
    # A (now non-top) serves from its unclamped entry.
    cands2 = run_search("Main Series Anthology", cache6)
    check("e2e: promoted source re-probed full",
          B.probe_calls == [("https://b/anth", 1), ("https://b/anth", None)])
    check("e2e: promoted entry rewritten unclamped",
          cache6.get_full("subB", "https://b/anth")[2] is False)
    check("e2e: fixed handler served from cache (no re-probe)", len(C.probe_calls) == 1)
    check("e2e: demoted top served from unclamped cache (no re-probe)", len(A.probe_calls) == 1)

    # Run C: everything cached + servable -> zero new probes.
    run_search("Main Series", cache6)
    check("e2e: warm re-run issues no probes",
          len(A.probe_calls) == 1 and len(B.probe_calls) == 2 and len(C.probe_calls) == 1)

    # probe_candidate_limit=1: only the top candidate's sources probed.
    A2 = FakeSearchHandler("mainA", [mk_hit("mainA", "Main Series", "https://a/main")])
    B2 = FakeSearchHandler("subB", [mk_hit("subB", "Main Series Anthology", "https://b/anth")])
    C2 = FakeSearchHandler("fixedC", [mk_hit("fixedC", "Main Series Anthology", "https://c/anth")],
                           samples_fixed=True)
    install_fakes([A2, B2, C2])
    cacheL, _ = make_tmp_cache()
    candsL = run_search("Main Series", cacheL, limit=1)
    anth = next(c for c in candsL if c.canonical_title != "Main Series")
    check("limit=1: only top candidate probed",
          len(A2.probe_calls) == 1 and not B2.probe_calls and not C2.probe_calls)
    check("limit=1: out-of-scope sources unmeasured -> seed basis",
          all(s.img_quality_score is None for s in anth.sources)
          and all(x["quality_basis"] == "seed" for x in anth.to_json()["sources"]))
    candsL2 = run_search("Main Series", cacheL, limit=2)
    check("limit=2: both candidates probed",
          len(A2.probe_calls) == 1  # cached from limit=1 run
          and len(B2.probe_calls) == 1 and len(C2.probe_calls) == 1)

    # skip_probe_sites honored under a limit: top candidate's site skipped.
    A3 = FakeSearchHandler("mainA", [mk_hit("mainA", "Main Series", "https://a/main")])
    install_fakes([A3])
    cacheS, _ = make_tmp_cache()
    candsS = run_search("Main Series", cacheS, limit=1, skip={"mainA"})
    check("limit+skip: committed site not probed, stays seed-based",
          not A3.probe_calls and candsS[0].sources[0].img_quality_score is None)
finally:
    restore_registry()


# ─────────────────────────────────────────────── 7. fan-out late adoption
print("── fan-out: soft barrier + late adoption ──")
try:
    mainH = FakeSearchHandler("mainA", [mk_hit("mainA", "Main Series", "https://a/main")],
                              probe_sleep=1.2)
    slow_same = FakeSearchHandler(
        "slowSame", [mk_hit("slowSame", "Main Series", "https://slow/main")],
        search_sleep=0.9)
    slow_new = FakeSearchHandler(
        "slowNew", [mk_hit("slowNew", "Main Series: Side Stories", "https://slow/side")],
        search_sleep=0.9)
    wedge = FakeSearchHandler("wedge", [mk_hit("wedge", "Main Series", "https://wedge/x")],
                              search_sleep=30.0)
    install_fakes([mainH, slow_same, slow_new, wedge])
    so._FANOUT_DEADLINE_S = 0.4

    cache7, _ = make_tmp_cache()
    # Pre-seed a cached probe for the slowSame source: the late-adoption
    # FREE cache read must restore it (measured score without a probe).
    cache7.set("slowSame", "https://slow/main", 0.77, metadata=full_meta())

    statuses = []
    t0 = time.monotonic()
    cands7 = run_search("Main Series", cache7, statuses=statuses)
    elapsed = time.monotonic() - t0

    check("late: returned without waiting for the wedged handler", elapsed < 6.0)
    check("late: barrier status line emitted",
          any("still searching" in s for s in statuses))
    check("late: merge status line emitted",
          any("merged 2 late hit(s)" in s for s in statuses))
    main_cand = next(c for c in cands7 if c.canonical_title == "Main Series")
    late_src = next((s for s in main_cand.sources if s.site == "slowSame"), None)
    check("late: straggler merged into existing candidate", late_src is not None)
    check("late: straggler NOT probed (no probe call)", not slow_same.probe_calls
          and not slow_new.probe_calls)
    check("late: FREE cache read restored measured score",
          late_src is not None and late_src.img_quality_score == 0.77
          and _quality_basis(late_src) == "chapter_probe")
    side_cand = next((c for c in cands7 if c.canonical_title == "Main Series: Side Stories"), None)
    check("late: unmatched straggler becomes NEW candidate",
          side_cand is not None and side_cand.sources[0].site == "slowNew")
    check("late: new candidate is seed-based",
          side_cand is not None
          and side_cand.to_json()["sources"][0]["quality_basis"] == "seed")
    check("late: wedged handler absent everywhere",
          all(s.site != "wedge" for c in cands7 for s in c.sources))
    check("late: phase summary line emitted",
          any(s.startswith("[*] Search phases:") for s in statuses))
finally:
    restore_registry()


# ─────────────────────────────────────────────── 8. T3 parallel == serial
print("── T3 pairwise: parallel == serial ──")


def _jpeg_blob(seed, quality, size=(700, 1000)):
    """Manga-page-like synthetic image (white bg, curves, fills, gradient) —
    NOT raw noise: block noise makes q18 gain artificial high-freq energy and
    inverts the fft/tenengrad components, which is unrepresentative of real
    pages. On line-art-ish content every component degrades with quality."""
    import random
    from PIL import ImageDraw
    rng = random.Random(seed)
    img = Image.new("RGB", size, (250, 250, 250))
    d = ImageDraw.Draw(img)
    for y in range(0, size[1], 2):  # background gradient wash FIRST
        d.line([(0, y), (size[0], y)],
               fill=(235 - y // 12, 238 - y // 14, 242 - y // 16), width=1)
    for i in range(60):  # line art on top
        x0, y0 = rng.randrange(size[0]), rng.randrange(size[1])
        x1, y1 = x0 + rng.randrange(20, 200), y0 + rng.randrange(20, 200)
        shade = rng.randrange(0, 120)
        if i % 3 == 0:
            d.ellipse([x0, y0, x1, y1], outline=(shade,) * 3, width=3)
        elif i % 3 == 1:
            d.line([x0, y0, x1, y1], fill=(shade,) * 3, width=2)
        else:
            d.rectangle([x0, y0, x1, y1], fill=(200 - shade,) * 3,
                        outline=(shade,) * 3, width=2)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


class T3Handler(BaseSiteHandler):
    def __init__(self, name, quality):
        self.name = name
        self.domains = (f"{name}.example",)
        self._q = quality

    def fetch_comic_context(self, url, scraper, make_request):
        return types.SimpleNamespace(title=self.name, comic={})

    def get_chapters(self, ctx, scraper, language, make_request):
        return [{"chap": str(n), "url": f"https://{self.name}/ch{n}"} for n in range(1, 5)]

    def get_chapter_images(self, chapter, scraper, make_request):
        n = chapter["chap"]
        return [f"https://{self.name}/ch{n}/p{i}.jpg" for i in range(4)]


def build_t3_candidate():
    hi = SourceEntry(site="t3hi", url="https://t3hi/s", title="T3 Series", cover=None,
                     title_match=1.0, seed_quality=0.9, img_quality_score=0.8,
                     img_quality_metadata={"content_type": "color_manga", "samples_succeeded": 3})
    lo = SourceEntry(site="t3lo", url="https://t3lo/s", title="T3 Series", cover=None,
                     title_match=1.0, seed_quality=0.9, img_quality_score=0.6,
                     img_quality_metadata={"content_type": "color_manga", "samples_succeeded": 3})
    return SeriesCandidate("T3 Series", None, [hi, lo])


class _SerialFuture:
    def __init__(self, fn, *a, **k):
        try:
            self._r, self._e = fn(*a, **k), None
        except Exception as e:
            self._r, self._e = None, e

    def result(self, timeout=None):
        if self._e:
            raise self._e
        return self._r


class SerialExecutor:
    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def submit(self, fn, *a, **k):
        return _SerialFuture(fn, *a, **k)


try:
    t3hi = T3Handler("t3hi", 92)
    t3lo = T3Handler("t3lo", 18)
    install_fakes([t3hi, t3lo])
    blob_hi = _jpeg_blob(7, 92)
    blob_lo = _jpeg_blob(7, 18)
    FakeScraper.BYTES = {}
    for n in range(1, 5):
        for i in range(4):
            FakeScraper.BYTES[f"https://t3hi/ch{n}/p{i}.jpg"] = blob_hi
            FakeScraper.BYTES[f"https://t3lo/ch{n}/p{i}.jpg"] = blob_lo

    def t3_run(serial):
        cand = build_t3_candidate()
        real_tpe, real_ac = so.ThreadPoolExecutor, so.as_completed
        if serial:
            so.ThreadPoolExecutor = SerialExecutor
            so.as_completed = lambda futs, timeout=None: list(futs)
        try:
            so._run_pairwise_ranking(
                [cand], lambda h: FakeScraper(), lambda url, scraper: None,
                on_status=None, probe_failure_cache=None, fetch_memo=None,
            )
        finally:
            so.ThreadPoolExecutor, so.as_completed = real_tpe, real_ac
        return {
            s.site: (
                round(s.img_quality_score, 6),
                (s.img_quality_metadata or {}).get("pairwise_adjustment"),
                (s.img_quality_metadata or {}).get("pairwise_winrate"),
                (s.img_quality_metadata or {}).get("pairwise_total_comparisons"),
            )
            for s in cand.sources
        }

    par = t3_run(serial=False)
    ser = t3_run(serial=True)
    check("t3: parallel adjustments == serial", par == ser)
    ran = par["t3hi"][3] and par["t3hi"][3] > 0
    check("t3: comparisons actually ran", bool(ran))
    check("t3: higher-quality source wins the pairwise",
          ran and par["t3hi"][1] > par["t3lo"][1])
finally:
    FakeScraper.BYTES = {}
    restore_registry()


# ─────────────────────────────────────────────── 8b. per-source probe budget
print("── probe: per-source budget (PROBE_SOURCE_BUDGET_S) ──")


class BudgetHandler(T3Handler):
    """T3Handler with 8 chapters (-> 6 breadth picks after first/last trim,
    chapters 2..7), driving the real base _probe_chapter_aggregate against the
    per-source budget.

    Under the CONCURRENT breadth pass the old test's premise — serial
    accumulation of uniform 0.25s sleeps crossing the 0.6s deadline — no longer
    holds (the sleeps overlap and all finish inside the budget). Instead we
    straddle the budget PER CHAPTER: chapters below `slow_from` finish fast (well
    under the budget -> success), chapters at/above it are still mid-sleep when
    the wall-clock join fires (-> None sentinels -> v5.2 TIMEOUTS: excluded from
    the score, not scored as failures). Deterministic
    regardless of scheduling given the wide fast/slow gap; pinning
    PROBE_BREADTH_CONCURRENCY >= the pick count starts every sample in one wave
    so the split doesn't depend on wave ordering either."""

    def __init__(self, name, quality, fast=0.05, slow=1.5, slow_from=5):
        super().__init__(name, quality)
        self._fast, self._slow, self._slow_from = fast, slow, slow_from

    def get_chapters(self, ctx, scraper, language, make_request):
        return [{"chap": str(n), "url": f"https://{self.name}/ch{n}"} for n in range(1, 9)]

    def get_chapter_images(self, chapter, scraper, make_request):
        time.sleep(self._slow if int(chapter["chap"]) >= self._slow_from else self._fast)
        return super().get_chapter_images(chapter, scraper, make_request)


try:
    # picks after trim = chapters 2..7 (6). slow_from=5 -> 2,3,4 fast / 5,6,7 slow.
    bh = BudgetHandler("t3budget", 92, slow_from=5)
    bh.PROBE_SOURCE_BUDGET_S = 0.6    # instance attr shadows the class default
    bh.PROBE_BREADTH_CONCURRENCY = 8  # >= picks -> one wave, split is scheduling-free
    blob_b = _jpeg_blob(11, 92)
    FakeScraper.BYTES = {
        f"https://t3budget/ch{n}/p{i}.jpg": blob_b
        for n in range(1, 9) for i in range(4)
    }
    t0 = time.monotonic()
    res = bh._probe_chapter_aggregate(mk_hit("t3budget", "B", "https://t3budget/s"),
                                      FakeScraper(), None)
    took = time.monotonic() - t0
    check("budget: partial aggregate returned (not None)", res is not None)
    sc, meta = res if res else (None, {})
    attempted = meta.get("samples_attempted") or 0
    check("budget: flag set + full pick count still attempted",
          meta.get("probe_budget_exhausted") is True and attempted >= 4)
    check("budget: some-but-not-all samples succeeded",
          0 < (meta.get("samples_succeeded") or 0) < attempted)
    check("budget: budget-missed chapters recorded as timeouts (excluded, not measured)",
          (meta.get("samples_timed_out") or 0) > 0
          and meta.get("samples_measured") == meta.get("samples_succeeded"))
    check("budget: probe bounded in wall-clock (join returns at the deadline)",
          took < 4.0)
    # v5.2: the budget-missed (slow) chapters are EXCLUDED from the aggregate —
    # NOT scored 0.0 — so a slow source is measured on the pages it COULD fetch.
    # sc is the median of the successful pages, a positive measured score.
    check("budget: score is a positive measured median (timeouts excluded, not 0)",
          sc is not None and sc > 0.0)

    # Fast source: no slow chapter in the pick range -> every pick finishes
    # before the deadline -> all succeed, no timeouts, flag False.
    bh2 = BudgetHandler("t3budget", 92, slow_from=99)
    bh2.PROBE_SOURCE_BUDGET_S = 0.6
    bh2.PROBE_BREADTH_CONCURRENCY = 8
    res2 = bh2._probe_chapter_aggregate(mk_hit("t3budget", "B", "https://t3budget/s"),
                                        FakeScraper(), None)
    sc2, meta2 = res2
    check("budget: fast source fully measured (all picks succeed, no timeouts)",
          meta2.get("samples_succeeded") == meta2.get("samples_attempted") == attempted
          and meta2.get("probe_budget_exhausted") is False
          and (meta2.get("samples_timed_out") or 0) == 0)
    # The KEY v5.2 fairness property: identical-quality pages score the SAME
    # whether the source was slow (partially timed out) or fast — the slow
    # source is no longer penalized for pages it never reached. Every page here
    # is the same blob, so the two medians are exactly equal (was: sc2 > sc).
    check("budget: slow source NOT penalized vs fast (same measured quality)",
          sc2 == sc)
finally:
    FakeScraper.BYTES = {}


# ─────────────────────────────────────────── 8c. probe: breadth parallel==serial
print("── probe: breadth parallel == serial (byte-identity) ──")


class ProbeEqHandler(T3Handler):
    """12 chapters (-> 8 breadth picks after trim) with DISTINCT per-chapter page
    bytes, so the aggregation (median/mean, majority-vote outlier, per-field
    means) is non-trivial. Running the REAL base _probe_chapter_aggregate at
    concurrency 1 (inline serial path) vs 4 (daemon pool) must yield byte-
    identical (score, metadata) — the determinism guarantee the whole
    optimization rests on. Mirrors suite 8's parallel==serial idiom for the
    probe (whose daemon pool has no injectable executor — the knob is the seam)."""

    def get_chapters(self, ctx, scraper, language, make_request):
        return [{"chap": str(n), "url": f"https://{self.name}/ch{n}"} for n in range(1, 13)]

    def get_chapter_images(self, chapter, scraper, make_request):
        n = chapter["chap"]
        return [f"https://{self.name}/ch{n}/p{i}.jpg" for i in range(8)]


try:
    peq = ProbeEqHandler("peq", 80)
    FakeScraper.BYTES = {}
    for n in range(1, 13):  # distinct blob per chapter (quality varies) -> distinct scores
        b = _jpeg_blob(100 + n, 20 + n * 6)
        for i in range(8):
            FakeScraper.BYTES[f"https://peq/ch{n}/p{i}.jpg"] = b

    def probe_run(conc):
        peq.PROBE_BREADTH_CONCURRENCY = conc
        return peq._probe_chapter_aggregate(
            mk_hit("peq", "P", "https://peq/s"), FakeScraper(), None,
        )

    s1, m1 = probe_run(1)   # inline serial path (n_workers <= 1)
    s4, m4 = probe_run(4)   # daemon pool path
    check("probe: aggregation non-trivial (real samples scored)",
          (m1.get("samples_succeeded") or 0) >= 6 and s1 > 0.0)
    check("probe: parallel score == serial", round(s1, 9) == round(s4, 9))
    check("probe: parallel metadata == serial", m1 == m4)
finally:
    FakeScraper.BYTES = {}


# ─────────────────────────────────────────────── 9. winner fetch + memo
print("── _fetch_chapters_for_winner: memo + shim ──")


class WinnerHandler(CountingHandler):
    """CountingHandler whose fetches also exercise the make_request they're
    handed — proving the internal bounded shim is what reaches handlers."""

    def fetch_comic_context(self, url, scraper, make_request):
        resp = make_request(f"{url}/__probe", scraper)
        assert getattr(resp, "status_code", 0) == 200
        return super().fetch_comic_context(url, scraper, make_request)


_REAL_CLI_GET = cli.get_handler_by_name
_REAL_CLI_BUILD = cli._build_scraper
try:
    w1 = WinnerHandler("win1")
    w2 = WinnerHandler("win2")
    cli.get_handler_by_name = lambda name: {"win1": w1, "win2": w2}.get(name)

    class WinScraper:
        def get(self, url, timeout=None, **kw):
            return types.SimpleNamespace(status_code=200, content=b"ok")

    # The cold-source path builds its scraper via cli._build_scraper — a
    # REAL cloudscraper session that would hit actual DNS when the fake
    # handler exercises the shim. Substitute the offline fake.
    cli._build_scraper = lambda args: WinScraper()

    wmemo = FetchMemo()
    # Simulate the probe phase having already fetched win1 (scraper + data).
    wmemo.get_scraper("win1", "https://win1/s", WinScraper)
    wmemo.get_chapters(w1, "https://win1/s", "en",
                       wmemo.get_scraper("win1", "https://win1/s", WinScraper),
                       lambda url, scraper: scraper.get(url))
    ctx_calls_before, chap_calls_before = w1.ctx_calls, w1.chap_calls

    args = types.SimpleNamespace(language="en", cookies="")

    def BOOM(url, scraper):
        raise AssertionError("outer make_request must not be used for list fetches")

    winner = SeriesCandidate("W", None, [
        SourceEntry(site="win1", url="https://win1/s", title="W", cover=None,
                    title_match=1.0, seed_quality=0.9),
        SourceEntry(site="win2", url="https://win2/s", title="W", cover=None,
                    title_match=1.0, seed_quality=0.9),
    ])
    statuses9 = []
    recs = cli._fetch_chapters_for_winner(
        winner, args, BOOM, on_status=statuses9.append, fetch_memo=wmemo,
    )
    by_site = {r["site"]: r for r in recs}
    check("winner: probe-warmed source not re-fetched",
          w1.ctx_calls == ctx_calls_before and w1.chap_calls == chap_calls_before)
    check("winner: cold source fetched exactly once",
          w2.ctx_calls == 1 and w2.chap_calls == 1)
    check("winner: records carry context + handler",
          all(by_site[s]["context"] is not None and by_site[s]["handler"] is not None
              for s in ("win1", "win2")))
    check("winner: _locked placeholders stripped from records",
          all(len(by_site[s]["chapters"]) == 1
              and by_site[s]["chapters"][0]["chap"] == "1" for s in ("win1", "win2")))
    fresh = wmemo.get_chapters(w1, "https://win1/s", "en", WinScraper(), BOOM)
    check("winner: strip isolated — memo copy keeps the _locked entry",
          len(fresh) == 2 and fresh[1].get("_locked") is True
          and w1.chap_calls == chap_calls_before)
    check("winner: outer make_request never invoked (shim in use)", True)
    check("winner: timing status line emitted",
          any(s.startswith("[*] Chapter lists fetched:") for s in statuses9))
finally:
    cli.get_handler_by_name = _REAL_CLI_GET
    cli._build_scraper = _REAL_CLI_BUILD


# ─────────────────────────────────────────────── summary
n_pass = sum(results)
print(f"\n{'='*50}\n{n_pass}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
