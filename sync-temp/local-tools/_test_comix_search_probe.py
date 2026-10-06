"""Offline regression for comix's 2026-07-12 promotion to a first-class
search + --multi-source + image-quality-probe source (sites/comix.py). No
browser, no network — the Patchright bridge and comix's own fetch_comic_context
/ get_chapters are monkeypatched, and a real PNG is placed in image_cache for
scoring. Covers:
  1. _pick_probe_chapter   — "probe chapter 1, not 0 or 0.5, unless no ch.1".
  2. search()              — typeahead row -> SearchHit mapping + swallow-to-[].
  3. _fetch_probe_item_bytes — image_cache-first (fixes comix-page:// -> 0.0).
  4. _probe_chapter_aggregate — chapter-1, capped render, latter-half median.
  5. _enrich_hits_with_alt_titles — alt_titles/year from the title-page blob.

Run: python tools/_test_comix_search_probe.py   (exit 0 = all pass)
"""
import io
import json
import os
import sys
import types

# Repo root on sys.path (script dir is tools/) — same shim as _test_rank_guard.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sites.comix as cm
from sites.comix import ComixSiteHandler
from sites import image_cache
from sites import base as _base_mod
from PIL import Image

H = ComixSiteHandler()
results = []


def check(name, cond):
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")
    results.append(bool(cond))


# ─────────────────────────────────────────────── 1. _pick_probe_chapter
def _ch(n, tag=None):
    return {"chap": (str(n) if n is not None else None), "url": f"u{tag if tag is not None else n}"}


def _pick(name, chapters, expect_idx, expect_chap):
    got = H._pick_probe_chapter(chapters)
    if expect_idx is None:
        ok = got is None
    else:
        ok = got is not None and got[0] == expect_idx and got[1].get("chap") == expect_chap
    check(f"pick: {name}", ok)


print("── _pick_probe_chapter ──")
_pick("ascending 1,2,3", [_ch(1), _ch(2), _ch(3)], 0, "1")
_pick("newest-first 3,2,1,0.5,0", [_ch(3), _ch(2), _ch(1), _ch("0.5"), _ch(0)], 2, "1")
_pick("0,0.5,1,2 -> ch1 (not 0/0.5)", [_ch(0), _ch("0.5"), _ch(1), _ch(2)], 2, "1")
_pick("no ch1: 2,3,4 -> 2", [_ch(2), _ch(3), _ch(4)], 0, "2")
_pick("no ch1: 0,0.5,2 -> 2", [_ch(0), _ch("0.5"), _ch(2)], 2, "2")
_pick("no ch1 newest-first 5,4,3,2 -> 2", [_ch(5), _ch(4), _ch(3), _ch(2)], 3, "2")
_pick("only 0,0.5 -> 0", [_ch(0), _ch("0.5")], 0, "0")
_pick("only 0.5 -> 0.5", [_ch("0.5")], 0, "0.5")
_pick("non-numeric only -> idx0", [{"chap": "Prologue", "url": "up"}, {"chap": None, "url": "un"}], 0, "Prologue")
_pick("empty -> None", [], None, None)
_pick("dup ch1 -> first", [_ch(2), _ch(1, "1a"), _ch(1, "1b")], 1, "1")
_pick("'1.0' string", [_ch(2), {"chap": "1.0", "url": "u1"}], 1, "1.0")
_pick("long newest-first 100..1", [_ch(n) for n in range(100, 0, -1)], 99, "1")


# ─────────────────────────────────────────────── 2. search() mapping
class FakeBridge:
    def __init__(self, rows=None, exc=None):
        self._rows, self._exc = rows, exc
        self.last = None

    def fetch_search_via_dom(self, query, limit=20, time_budget_s=28.0):
        self.last = {"query": query, "limit": limit, "time_budget_s": time_budget_s}
        if self._exc:
            raise self._exc
        return self._rows


print("── search() mapping ──")
_orig_bridge = cm._COMIX_BROWSER_BRIDGE
try:
    rows = [
        {"hid": "k7r37", "title": "Frieren - Beyond Journey's End", "cover": "https://c/1.webp", "type": "MANGA", "sub": "Ch.147"},
        {"hid": "abc12", "title": "Some Manhwa", "cover": "", "type": "OTHER", "sub": "Ch.686.5"},
        {"hid": "", "title": "No HID", "cover": "x", "type": "MANGA", "sub": "Ch.5"},
        {"hid": "d99", "title": "", "cover": "x", "type": "MANGA", "sub": "Ch.5"},
        {"hid": "e77", "title": "No Sub Count", "cover": "https://c/2.webp", "type": "OTHER", "sub": ""},
    ]
    cm._COMIX_BROWSER_BRIDGE = FakeBridge(rows=rows)
    hits = H.search("frieren", scraper=None, make_request=None, limit=20)
    check("search: 3 valid hits (2 dropped)", len(hits) == 3)
    check("search: bare /title/{hid} url", hits[0].url == "https://comix.to/title/k7r37")
    check("search: chapter hint 147", hits[0].chapter_count_hint == 147)
    check("search: raw_score max at idx0", abs(hits[0].raw_score - 1.0) < 1e-9)
    check("search: OTHER type kept", hits[1].title == "Some Manhwa")
    check("search: decimal Ch.686.5 -> 686", hits[1].chapter_count_hint == 686)
    check("search: empty cover -> None", hits[1].cover is None)
    check("search: no-sub -> None hint", hits[2].chapter_count_hint is None)
    check("search: raw_score descending", hits[0].raw_score > hits[1].raw_score > hits[2].raw_score)
    check("search: limit forwarded int", cm._COMIX_BROWSER_BRIDGE.last["limit"] == 20)
    check("search: budget forwarded 28.0", cm._COMIX_BROWSER_BRIDGE.last["time_budget_s"] == 28.0)

    cm._COMIX_BROWSER_BRIDGE = FakeBridge(rows=[])
    check("search: empty rows -> []", H.search("z", None, None) == [])
    cm._COMIX_BROWSER_BRIDGE = FakeBridge(rows=None)
    check("search: None rows -> []", H.search("z", None, None) == [])
    cm._COMIX_BROWSER_BRIDGE = FakeBridge(exc=RuntimeError("boom"))
    try:
        check("search: exception swallowed -> []", H.search("z", None, None) == [])
    except Exception:
        check("search: exception swallowed -> []", False)
    import concurrent.futures as _f
    cm._COMIX_BROWSER_BRIDGE = FakeBridge(exc=_f.TimeoutError())
    try:
        check("search: TimeoutError swallowed -> []", H.search("z", None, None) == [])
    except Exception:
        check("search: TimeoutError swallowed -> []", False)

    called = {"hit": False}

    class Sentinel(FakeBridge):
        def fetch_search_via_dom(self, *a, **k):
            called["hit"] = True
            return []

    cm._COMIX_BROWSER_BRIDGE = Sentinel(rows=[])
    check("search: blank query short-circuits", H.search("   ", None, None) == [] and not called["hit"])
finally:
    cm._COMIX_BROWSER_BRIDGE = _orig_bridge


# ──────────────────────────────────── 2b. _enrich_hits_with_alt_titles
# The typeahead carries no alternate titles, so comix hits used to reach the
# orchestrator with alt_titles == []. That lost the series whenever the query
# arrived as the English title and comix listed the romaji: the 0.55 title
# floor dropped the RIGHT entry (0.466) while unrelated titles sharing one word
# cleared it. alt_titles also feed the union-find grouping that merges comix
# into the other sites' candidate instead of a lookalike second one.
def _blob(hid, title, alts, year=None):
    """Minimal <script id="initial-data"> payload in the React-Query shape
    _manga_detail_from_initial_data walks (a ["manga","detail",<hid>] key)."""
    detail = {"title": title, "altTitles": list(alts)}
    if year is not None:
        detail["year"] = year
    return json.dumps({"queries": {json.dumps(["manga", "detail", hid]): detail}})


class AltBridge(FakeBridge):
    def __init__(self, rows=None, blobs=None, alt_exc=None):
        super().__init__(rows=rows)
        self._blobs, self._alt_exc = blobs or {}, alt_exc
        self.alt_calls = []

    def fetch_initial_data_blobs(self, hids, time_budget_s=12.0):
        self.alt_calls.append({"hids": list(hids), "time_budget_s": time_budget_s})
        if self._alt_exc:
            raise self._alt_exc
        return dict(self._blobs)


print("── _enrich_hits_with_alt_titles ──")
_orig_bridge = cm._COMIX_BROWSER_BRIDGE
try:
    alt_rows = [
        {"hid": "8163d", "title": "Saiki Kusuo no Psi Nan", "cover": "", "type": "MANGA", "sub": "Ch.281"},
        {"hid": "rm228", "title": "Disastrous Romance", "cover": "", "type": "MANGA", "sub": "Ch.10"},
    ]
    en = "The Disastrous Life of Saiki K."
    jp = "斉木楠雄のΨ難"
    alt_blobs = {
        # Third entry repeats the primary title — must be dropped.
        "8163d": _blob("8163d", "Saiki Kusuo no Psi Nan",
                       [en, jp, "Saiki Kusuo no Psi Nan"], year=2012),
        "rm228": _blob("rm228", "Disastrous Romance", [], year=2025),
    }
    br = AltBridge(rows=alt_rows, blobs=alt_blobs)
    cm._COMIX_BROWSER_BRIDGE = br
    hits = H.search(en, None, None)
    check("alt: both hits returned", len(hits) == 2)
    check("alt: english alt attached", en in (hits[0].alt_titles or []))
    check("alt: non-latin alt attached", jp in (hits[0].alt_titles or []))
    check("alt: primary-title duplicate dropped",
          [a for a in hits[0].alt_titles if a == hits[0].title] == [])
    check("alt: year populated", hits[0].year == 2012)
    check("alt: empty altTitles -> []", hits[1].alt_titles == [])
    check("alt: year still set with no alts", hits[1].year == 2025)
    check("alt: hids forwarded", sorted(br.alt_calls[0]["hids"]) == ["8163d", "rm228"])
    check("alt: budget forwarded", br.alt_calls[0]["time_budget_s"] == cm._COMIX_ALT_TITLE_BUDGET_S)

    # The whole point of scoring against alt titles: the correct series clears
    # the floor it used to die against, WITHOUT lowering the floor.
    from sites.search_orchestrator import _best_title_match, DEFAULT_MIN_MATCH
    check("alt: correct series now clears the floor",
          _best_title_match(en, hits[0]) >= DEFAULT_MIN_MATCH)

    # Degradation contracts — a lookup failure must never cost the hits.
    br_exc = AltBridge(rows=alt_rows, blobs=alt_blobs, alt_exc=RuntimeError("boom"))
    cm._COMIX_BROWSER_BRIDGE = br_exc
    hits_e = H.search(en, None, None)
    check("alt: bridge exception -> hits kept", len(hits_e) == 2)
    check("alt: bridge exception -> alt_titles []", hits_e[0].alt_titles == [])

    cm._COMIX_BROWSER_BRIDGE = FakeBridge(rows=alt_rows)  # no fetch_initial_data_blobs
    hits_m = H.search(en, None, None)
    check("alt: bridge missing method -> hits kept", len(hits_m) == 2)
    check("alt: bridge missing method -> alt_titles []", hits_m[0].alt_titles == [])

    cm._COMIX_BROWSER_BRIDGE = AltBridge(rows=alt_rows, blobs={})
    hits_n = H.search(en, None, None)
    check("alt: no blobs -> hits kept, alt_titles []",
          len(hits_n) == 2 and hits_n[0].alt_titles == [])

    cm._COMIX_BROWSER_BRIDGE = AltBridge(rows=alt_rows, blobs={"zzzz": _blob("zzzz", "Other", ["X"])})
    hits_u = H.search(en, None, None)
    check("alt: unknown hid ignored", hits_u[0].alt_titles == [])
finally:
    cm._COMIX_BROWSER_BRIDGE = _orig_bridge


# ─────────────────────────────────────────────── 3. _fetch_probe_item_bytes
class SpyScraper:
    """Stands in for the probe's scraper.

    `headers` is NOT optional decoration: base._fetch_probe_item_bytes_ex calls
    scraper.get(item, timeout=15, headers=IMAGE_ACCEPT_HEADERS) — a real
    request-side requirement (a WordPress host answers an html-preferring
    Accept with a wrapper PAGE, which fails looks_like_real_image and would
    score every page 0.0; grep IMAGE_ACCEPT). A stub without the kwarg raises
    TypeError at call time, before the body records the call, which reads as
    "the override never delegated" rather than "the stub is stale".
    """

    def __init__(self, status=404, content=b""):
        self.calls = []
        self.headers_seen = []
        self._status, self._content = status, content

    def get(self, url, timeout=None, headers=None):
        self.calls.append(url)
        self.headers_seen.append(headers)
        r = types.SimpleNamespace()
        r.status_code, r.content = self._status, self._content
        return r


print("── _fetch_probe_item_bytes ──")
image_cache.clear_cache()
synth = "comix-page://chap123/0002.webp"
synth_bytes = b"SYNTH_CANVAS_" + b"\x00" * 40
image_cache.cache_image(synth, synth_bytes, "image/webp")
spy = SpyScraper()
check("bytes: synthetic URL from cache", H._fetch_probe_item_bytes(synth, spy) == synth_bytes)
check("bytes: synthetic URL no scraper.get", spy.calls == [])
real = "https://cdn/si/p3.webp"
real_bytes = b"REAL_" + b"\x11" * 30
image_cache.cache_image(real, real_bytes, "image/webp")
spy2 = SpyScraper()
check("bytes: cached https from cache", H._fetch_probe_item_bytes(real, spy2) == real_bytes)
check("bytes: cached https no scraper.get", spy2.calls == [])
spy3 = SpyScraper(status=404)
check("bytes: uncached delegates to base", H._fetch_probe_item_bytes("https://cdn/si/miss.webp", spy3) is None and spy3.calls == ["https://cdn/si/miss.webp"])
check(
    "bytes: delegation sends IMAGE_ACCEPT_HEADERS",
    spy3.headers_seen == [_base_mod.IMAGE_ACCEPT_HEADERS],
)
spy4 = SpyScraper()
check("bytes: dict item -> None", H._fetch_probe_item_bytes({"type": "other"}, spy4) is None and spy4.calls == [])
spy5 = SpyScraper()
check("bytes: empty string -> None", H._fetch_probe_item_bytes("", spy5) is None and spy5.calls == [])
image_cache.clear_cache()


# ─────────────────────────────────────────────── 4. _probe_chapter_aggregate e2e
def _make_png(w=800, h=1200):
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(0, w, 7):
            px[x, y] = ((x + y) % 256, (x * 3) % 256, (y * 5) % 256)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


class _Hit:
    def __init__(self, url):
        self.url, self.cover = url, None


CH = [
    {"chap": "4", "url": "https://comix.to/title/x/44-chapter-4"},
    {"chap": "3", "url": "https://comix.to/title/x/33-chapter-3"},
    {"chap": "2", "url": "https://comix.to/title/x/22-chapter-2"},
    {"chap": "1", "url": "https://comix.to/title/x/11-chapter-1"},
    {"chap": "0", "url": "https://comix.to/title/x/00-chapter-0"},
]

print("── _probe_chapter_aggregate (mocked I/O) ──")
_o_ctx, _o_chs, _o_bridge = H.fetch_comic_context, H.get_chapters, cm._COMIX_BROWSER_BRIDGE
try:
    H.fetch_comic_context = lambda url, s, m: types.SimpleNamespace(comic={"url": url}, identifier="x")
    H.get_chapters = lambda ctx, s, lang, m: list(CH)
    PNG = _make_png()
    captured = {}

    class Bridge:
        # Returns ComixChapterCapture, NOT a bare list: _probe_chapter_aggregate
        # reads capture.urls, and get_chapter_images compares len(urls) against
        # capture.expected_pages to catch a short capture (a 67-of-68 render
        # used to pass as complete). expected_pages == len(urls) here = the
        # healthy full-capture case.
        def fetch_chapter_images_via_dom(self, chapter_url, time_budget_s=300.0, max_capture_pages=None):
            captured.update(chapter_url=chapter_url, max_capture_pages=max_capture_pages, time_budget_s=time_budget_s)
            n = max_capture_pages or 8
            urls = [f"https://cdn/x/ch1_p{i}.webp" for i in range(n)]
            for u in urls:
                image_cache.cache_image(u, PNG, "image/png")
            return cm.ComixChapterCapture(urls=urls, expected_pages=len(urls))

    cm._COMIX_BROWSER_BRIDGE = Bridge()
    expect_samples = len(range(8 // 2, 8))
    out = H._probe_chapter_aggregate(_Hit("https://comix.to/title/k7r37"), scraper=object(), make_request=None, max_samples=1)
    check("probe: returns (score, meta)", isinstance(out, tuple) and len(out) == 2)
    if out:
        score, meta = out
        check("probe: score in [0,1]", isinstance(score, float) and 0.0 <= score <= 1.0)
        check("probe: probe_mode tag", meta.get("probe_mode") == "comix_first_chapter")
        check(f"probe: samples_attempted={expect_samples}", meta.get("samples_attempted") == expect_samples)
        check(f"probe: samples_succeeded={expect_samples}", meta.get("samples_succeeded") == expect_samples)
        check("probe: chapter_indices_sampled=[3]", meta.get("chapter_indices_sampled") == [3])
        check("probe: format present", bool(meta.get("format")))
    check("probe: bridge got chapter-1 URL", captured.get("chapter_url") == "https://comix.to/title/x/11-chapter-1")
    check("probe: bridge got cap=_COMIX_PROBE_PAGE_CAP", captured.get("max_capture_pages") == cm._COMIX_PROBE_PAGE_CAP)
    check("probe: bridge got 60s budget", captured.get("time_budget_s") == 60.0)

    captured.clear()
    out2 = H._probe_chapter_aggregate(_Hit("https://comix.to/title/k7r37"), scraper=object(), make_request=None, max_samples=None)
    check("probe: max_samples=None also ch1", captured.get("chapter_url") == "https://comix.to/title/x/11-chapter-1" and out2 is not None)

    H.get_chapters = lambda *a, **k: []
    check("probe: empty chapters -> None", H._probe_chapter_aggregate(_Hit("u"), object(), None) is None)

    def _raise(*a, **k):
        raise RuntimeError("ctx boom")

    H.fetch_comic_context = _raise
    check("probe: ctx exception -> None", H._probe_chapter_aggregate(_Hit("u"), object(), None) is None)

    H.fetch_comic_context = lambda url, s, m: types.SimpleNamespace(comic={"url": url}, identifier="x")
    H.get_chapters = lambda *a, **k: list(CH)

    class EmptyBridge:
        # The total-miss shape: nav failed / reader never mounted. Mirrors the
        # handler's own pre-mount sentinel (grep ComixChapterCapture(urls=[],
        # expected_pages=0)) — 0 expected means "nothing to be short of", so it
        # reads as empty_content rather than an incomplete chapter.
        def fetch_chapter_images_via_dom(self, *a, **k):
            return cm.ComixChapterCapture(urls=[], expected_pages=0)

    cm._COMIX_BROWSER_BRIDGE = EmptyBridge()
    check("probe: empty images -> None", H._probe_chapter_aggregate(_Hit("u"), object(), None) is None)
    check("probe: None hit -> None", H._probe_chapter_aggregate(None, object(), None) is None)
    check("probe: hit without url -> None", H._probe_chapter_aggregate(_Hit(""), object(), None) is None)
finally:
    H.fetch_comic_context, H.get_chapters, cm._COMIX_BROWSER_BRIDGE = _o_ctx, _o_chs, _o_bridge
    image_cache.clear_cache()


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
