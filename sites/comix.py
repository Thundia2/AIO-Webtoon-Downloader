from __future__ import annotations

import atexit
import builtins as _builtins
import concurrent.futures as _futures
import json
import queue
import re
import sys
import threading
import time
from typing import Dict, List, Optional, Any, Tuple
from urllib.parse import quote_plus, urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseSiteHandler, SearchHit, SiteComicContext

# Optional zendriver-backed Cloudflare fallback. comix.to added CF
# protection in upstream's 2026-05 release; direct-HTTP API calls (the
# v1/v2 manga + chapter-list endpoints we hit through the regular
# `scraper` session, NOT the Patchright-routed token capture or
# chapter-detail steal) can drop 403/503 challenge pages. `_cf_aware_request`
# wraps those calls and falls back through a one-shot zendriver session on
# confirmed CF challenges. Soft-import so non-zendriver installs still load
# the module — the wrapper degrades to a straight passthrough.
# Cross-file: sites/crawlee_utils.py:get_cf_session / is_cf_challenge.
try:
    from .crawlee_utils import get_cf_session, is_cf_challenge
    _CF_AVAILABLE = True
except ImportError:
    _CF_AVAILABLE = False


# All bare print() calls in this module emit to stderr by default. Why: this
# handler's Patchright bridge logs [!] diagnostic messages when chapter-API
# capture fails, and when invoked from the orchestrator's search-time probe
# path (sites/search_orchestrator.py:_probe_one) those lines would land on
# stdout — which carries the JSON --search output for piped consumers. The
# UI's searcher.js rejects non-JSON stdout with "Search produced non-JSON
# stdout" so any leak hard-breaks the search results panel. This shim keeps
# stdout clean without touching every print site. Explicit file= overrides
# still work (e.g., pass file=sys.stdout to opt out). Same idiom as
# sites/mangafire.py:_stderr_print.
def _stderr_print(*args, **kwargs):
    kwargs.setdefault("file", sys.stderr)
    return _builtins.print(*args, **kwargs)


print = _stderr_print  # noqa: A001 — intentional shadow of builtins.print


class ComixSiteHandler(BaseSiteHandler):
    name = "comix"
    domains = ("comix.to", "www.comix.to")

    # Opt out of the orchestrator's image-quality probe entirely. Two
    # facts make probing comix uneconomic at search time:
    #   1. comix's chapter list AND every chapter page require the
    #      single-threaded Patchright bridge (the /chapters + /chapters/{id}
    #      APIs are signed + encrypted, and the page <img> URLs are only
    #      set by in-page JS on scroll — see get_chapter_images). The probe
    #      phase runs up to 6 sources in parallel — they all serialize on
    #      the bridge worker thread, so adding comix to the probe set
    #      uniformly trips the orchestrator's 240 s probe-phase deadline
    #      before any comix candidate completes.
    #   2. Any legacy tile-scrambled pages come back as synthetic
    #      `comix-page://` URLs. sites/base.py:_fetch_probe_item_bytes uses
    #      scraper.get(url) which doesn't know that scheme, so those chapters
    #      score 0.0 even when the probe DOES finish.
    # Resolution: the comix seed in sites/quality_seed.json is
    # calibrated offline (run comix_seed_calibration.py — drives the
    # full T1+T2 ML pipeline against one good + one bad title; the
    # current 0.74 is the median across both). The comparator
    # `_quality_for` (sites/search_orchestrator.py:~5329) falls back
    # to seed_quality when img_quality_score is None, so leaving the
    # score un-set IS the mechanism by which the calibrated seed
    # becomes the effective ranking signal.
    # Cross-file: sites/search_orchestrator.py:~5425 honors this attr
    # in the per-source probe loop (skips both the persistent-cache
    # lookup and the worker enqueue).
    SKIP_QUALITY_PROBE = True

    # Opt out of --multi-source merging too. Even with the probe phase
    # already skipped (above), comix's calibrated seed (0.74 — see
    # quality_seed.json) clears the default --multi-source-quality-min
    # of 0.65, so without this flag comix candidates survive
    # _filter_and_rank_alt_sources and reach _fetch_chapters_for_winner,
    # where each one pays a ~25 s bridge-DOM-scrape just to enumerate
    # chapters. Those scrapes serialize through the single-threaded
    # Patchright bridge with no concurrency benefit — they pile up
    # while the user's primary download is waiting for multi-source
    # alignment to finish. And the merged result almost never actually
    # uses comix as a fallback: the primary site (mangafire / mangadex
    # / etc.) has the same chapters, so the alt is dead weight.
    # Cross-file: aio_search_cli.py:_filter_and_rank_alt_sources honors
    # this attribute alongside the existing primary_host filter so
    # comix is dropped from the alts list before any chapter-list
    # fetch is queued.
    SKIP_MULTI_SOURCE = True

    # Patchright's sync API requires that every call run on the same thread
    # that started the browser, AND that thread must own an asyncio loop.
    # Probe-phase workers (sites/search_orchestrator.py) and aio-dl.py's
    # image-prefetch threads can't satisfy either. So all Patchright work
    # (the chapter-list + chapter-image DOM scrapes — the site is a signed +
    # encrypted SPA, see fetch_comic_context) routes through
    # _COMIX_BROWSER_BRIDGE (bottom of this file), which serializes calls onto
    # a single dedicated worker thread, one process-wide. Block-on-future
    # semantics make the bridge fully synchronous from any caller's
    # perspective. Cross-file idiom: sites/mangadex.py:_report_worker.

    def __init__(self):
        # BaseSiteHandler has no __init__; super().__init__() falls through to
        # object.__init__ (no-args). We override only to attach the per-instance
        # lazy CF session + the chapter-image memo cache below.
        super().__init__()
        # Lazy-init zendriver CF session. Built on first 403/503 in
        # _cf_aware_request when is_cf_challenge confirms the body is a CF
        # interstitial, then reused for subsequent direct-HTTP calls within
        # the same handler instance. Patchright-routed calls (token capture,
        # chapter-detail steal) don't need this — the browser handles CF
        # natively via its own cookie store.
        self._cf_session = None
        # Memoize get_chapter_images results so the prefetch worker and
        # the main download flow don't both run the ~20s canvas scrape
        # per chapter. Both threads share THIS handler instance (the
        # prefetch job carries `handler` by reference). Comix's
        # Patchright bridge serializes every scrape through one daemon
        # worker, so a duplicate main-flow scrape gets queued behind
        # every other in-flight prefetch — turning the supposed-to-be-
        # instant prefetch_hit path into a wait worth several chapters'
        # scrape time (~14-20s each). Keyed by chapter URL because
        # merged-part chapters share an id but have distinct part URLs.
        # 600s TTL matches sites/image_cache._TTL_SECONDS so cached
        # URLs and the cached bytes behind them expire together — a
        # URL whose bytes have been evicted points at a CDN signed
        # token that's almost certainly rotated by then, so we want a
        # fresh scrape rather than serving stale URLs that would
        # 404-on-fetch.
        self._chapter_images_cache: Dict[str, Tuple[List[str], float]] = {}
        self._chapter_images_cache_lock = threading.Lock()

    def configure_session(self, scraper, args) -> None:
        scraper.headers.update({
            "Referer": "https://comix.to/",
            "Origin": "https://comix.to",
        })

    def _get_cf_session(self):
        """Lazy-build a zendriver-backed requests.Session pre-loaded with
        valid CF cookies for comix.to. Returns the cached session on
        subsequent calls; returns None when crawlee_utils isn't importable
        OR the zendriver solve fails (caller treats None as "no fallback
        available" and surfaces the original 403/503).

        Cross-file: sites/crawlee_utils.py:get_cf_session handles the
        zendriver lifecycle + per-domain cookie cache (_CF_COOKIE_TTL).
        """
        if self._cf_session is None and _CF_AVAILABLE:
            try:
                self._cf_session = get_cf_session("https://comix.to")
                self._cf_session.headers.update({
                    "Referer": "https://comix.to/",
                    "Origin": "https://comix.to",
                })
            except Exception as e:
                # Failure modes: zendriver missing, Chrome not installed,
                # CF solve timeout, network blip. Log to stderr (via the
                # _stderr_print shim at module top so we don't corrupt
                # --search JSON on stdout) and fall through — the caller
                # keeps the original response.
                print(f"[!] Comix CF session failed: {e}")
        return self._cf_session

    def _cf_aware_request(self, url: str, scraper, make_request):
        """Wraps make_request with a one-shot zendriver CF fallback.

        Behavior: makes the normal request; on a 403/503 that
        is_cf_challenge confirms IS a CF interstitial (not a legitimate
        403/503 from the API itself, where we want the real status to
        propagate to the caller's error handling), retries through the
        lazy CF session. Any exception in the retry path silently keeps
        the original response so we never make CF resilience itself the
        cause of a hard failure.

        Used only for the direct-HTTP paths (fetch_comic_context,
        get_chapters listing, get_chapter_images HTML fallback). The
        Patchright-routed token capture and chapter-detail steal handle
        CF transparently and don't go through this wrapper.

        Cross-file: same idiom as upstream comix.py's _cf_aware_request;
        ported here on top of the local persistent-browser bridge.
        """
        response = make_request(url, scraper)
        if _CF_AVAILABLE and response.status_code in (403, 503):
            try:
                if is_cf_challenge(response.status_code, response.text):
                    cf = self._get_cf_session()
                    if cf:
                        # Push the freshly-captured CF cookies into the
                        # caller's scraper so subsequent make_request calls
                        # — chapter API HTML fallback, cover-image download
                        # via the global scraper, anything else hitting
                        # comix.to or its CDN — inherit the cf_clearance
                        # instead of each one re-tripping the 403 + CF retry
                        # cycle on the same cookies we already have. No-op
                        # when the cookie cache is empty (CF wasn't solved).
                        # Cross-file: sites/crawlee_utils.py:sync_cf_cookies.
                        try:
                            from .crawlee_utils import sync_cf_cookies
                            sync_cf_cookies(scraper, url)
                        except Exception:
                            pass
                        response = cf.get(url, timeout=20)
            except Exception:
                # Retry-path failure is non-fatal — keep the original
                # response so the caller's own error path runs.
                pass
        return response

    def _extract_initial_data_manga(self, soup) -> Optional[Dict]:
        """Return the full manga-detail dict from the title page's SSR
        React-Query hydration blob, or None.

        2026-07-11: comix.to is now an SPA that gates every /api/v1/* endpoint
        behind a per-request signature AND encrypts the response body
        ({"e":"<blob>"}, decrypted only in-JS), so the old cloudscraper API
        calls return 403 "Missing token." The title-page HTML, however, still
        ships a plaintext <script id="initial-data" type="application/json">
        React-Query hydration blob in the RAW server response. Its
        ["manga","detail",<hid|id>] query value IS the detail object we want:
        title / altTitles / authors / artists / genres / poster / synopsis /
        year / status / latestChapter / url. Plain HTTP, no browser, no
        decryption — this is the replacement for /api/v1/manga/{hid}.

        Match the query key on the ["manga","detail" prefix (parsed as JSON)
        so it works whether comix keys it by hid string ("6e6jz") or numeric
        id (49660), and ignore the sibling ["manga","recommended"/"groups"]
        queries. Some React-Query dumps wrap the payload under a "data" key;
        handle both. Returns a shallow copy so callers can mutate freely.
        """
        try:
            tag = soup.find("script", id="initial-data")
            raw = (tag.string or tag.get_text()) if tag else None
            data = json.loads(raw) if raw else None
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        queries = data.get("queries")
        if isinstance(queries, dict):
            for key, value in queries.items():
                if not isinstance(key, str):
                    continue
                try:
                    parsed_key = json.loads(key)
                except Exception:
                    continue
                if not (
                    isinstance(parsed_key, list)
                    and len(parsed_key) >= 2
                    and parsed_key[0] == "manga"
                    and parsed_key[1] == "detail"
                ):
                    continue
                if isinstance(value, dict):
                    if value.get("title"):
                        return dict(value)
                    inner = value.get("data")
                    if isinstance(inner, dict) and inner.get("title"):
                        return dict(inner)
        # Alt shape: a top-level "manga" object carrying real fields (vs the
        # {hid,id}-only stub the current markup uses).
        manga = data.get("manga")
        if isinstance(manga, dict) and manga.get("title"):
            return dict(manga)
        return None

    def _extract_sync_data(self, soup) -> Optional[Dict]:
        """Return the small <script id="syncData"> JSON (mal-sync integration
        data: {name, manga_id, manga_url, ...}) or None. Present on every
        title page; a cheap title/hid source when #initial-data is absent."""
        try:
            tag = soup.find("script", id="syncData")
            raw = (tag.string or tag.get_text()) if tag else None
            return json.loads(raw) if raw else None
        except Exception:
            return None

    def _normalize_named_list(self, value: Any) -> List[str]:
        """Converts mixed list/dict/string inputs into a clean list of names."""
        if not value:
            return []
        if not isinstance(value, list):
            value = [value]
        names: List[str] = []
        for item in value:
            name = None
            if isinstance(item, dict):
                name = item.get("title") or item.get("name")
            elif isinstance(item, str):
                name = item
            if name:
                name = name.strip()
                if name:
                    names.append(name)
        return names

    def fetch_comic_context(self, url: str, scraper, make_request) -> SiteComicContext:
        response = self._cf_aware_request(url, scraper, make_request)
        html = response.text
        soup = BeautifulSoup(html, "html.parser")
        
        # First, extract hash_id from URL
        hash_id = None
        path = urlparse(url).path
        parts = path.split('/')
        if len(parts) >= 3 and parts[1] == 'title':
            slug_part = parts[2]
            if '-' in slug_part:
                hash_id = slug_part.split('-')[0]
            else:
                hash_id = slug_part
        
        # Primary source (2026-07-11): the full manga detail lives plaintext in
        # the title page's <script id="initial-data"> SSR blob — see
        # _extract_initial_data_manga. This replaces the now-dead
        # /api/v1/manga/{hid} API call (403 "Missing token." + encrypted body).
        # The og:image / meta-description / list-normalization steps below run
        # regardless of which branch populated manga_data.
        manga_data = self._extract_initial_data_manga(soup)

        # Fallback 1: the small #syncData mal-sync blob ({name, manga_id}).
        if not manga_data:
            sync = self._extract_sync_data(soup)
            if sync and sync.get("name"):
                _sync_hid = sync.get("manga_id") or hash_id
                manga_data = {
                    "hid": _sync_hid,
                    "hash_id": _sync_hid,
                    "title": sync.get("name"),
                }

        # Fallback 2: a raw "manga_id"/"hash_id"/"title" triple in the HTML.
        if not manga_data:
            match = re.search(r'"manga_id":(\d+)', html)
            if match:
                hash_match = re.search(r'"hash_id":"([^"]+)"', html)
                title_match = re.search(r'"title":"([^"]+)"', html)
                if hash_match and title_match:
                    manga_data = {
                        "manga_id": int(match.group(1)),
                        "hash_id": hash_match.group(1),
                        "title": title_match.group(1),
                        "hid": hash_match.group(1),
                    }

        # Last resort: derive a title from the URL slug (hash_id is only set
        # when slug_part parsed, so slug_part is defined here).
        if not manga_data and hash_id:
            title = slug_part.split('-', 1)[1].replace('-', ' ').title() if '-' in slug_part else slug_part
            manga_data = {
                "hash_id": hash_id,
                "title": title,
                "hid": hash_id,
            }

        if not manga_data:
            raise RuntimeError("Could not find manga data in page.")

        # AniList enrichment reads comic_data["title"]; some callers key on
        # "name". Set both from whichever branch won (asura precedent, CLAUDE.md).
        if manga_data.get("title") and not manga_data.get("name"):
            manga_data["name"] = manga_data["title"]

        # Ensure hid is present
        if "hid" not in manga_data:
            if "hash_id" in manga_data:
                manga_data["hid"] = manga_data["hash_id"]
            elif "slug" in manga_data:
                slug = manga_data["slug"]
                if "-" in slug:
                    manga_data["hid"] = slug.split("-")[0]
                else:
                    manga_data["hid"] = slug
            else:
                # Last resort: try to extract from URL
                if hash_id:
                    manga_data["hid"] = hash_id

        poster = manga_data.get("poster") or manga_data.get("_poster")
        if isinstance(poster, dict):
            cover_url = poster.get("large") or poster.get("medium") or poster.get("small")
            thumb_url = poster.get("medium") or poster.get("small") or cover_url
            if cover_url and not manga_data.get("cover"):
                manga_data["cover"] = cover_url
            if thumb_url and not manga_data.get("thumb"):
                manga_data["thumb"] = thumb_url
        if not manga_data.get("cover"):
            cover_tag = soup.find("meta", property="og:image")
            if cover_tag and cover_tag.get("content"):
                manga_data["cover"] = cover_tag["content"]

        synopsis = manga_data.get("synopsis")
        if synopsis and not manga_data.get("desc"):
            manga_data["desc"] = synopsis.strip()
        if not manga_data.get("desc"):
            desc_meta = soup.find("meta", attrs={"name": "description"})
            if desc_meta and desc_meta.get("content"):
                manga_data["desc"] = desc_meta["content"].strip()

        # The #initial-data detail's `url` is a relative path (e.g.
        # "/title/6e6jz-the-beginning-after-the-end"). get_chapters →
        # fetch_chapters_via_dom → page.goto needs an absolute URL or Patchright
        # raises "Cannot navigate to invalid URL". Normalize here so every caller
        # of context.comic["url"] sees a usable absolute URL. Fall back to the
        # caller-supplied url only when the detail didn't populate the field.
        api_url_value = manga_data.get("url")
        if isinstance(api_url_value, str) and api_url_value.startswith("/"):
            manga_data["url"] = "https://comix.to" + api_url_value
        elif url and not api_url_value:
            manga_data["url"] = url

        list_mappings = {
            "genres": ["genres", "genre"],
            "theme": ["theme"],
            "format": ["format"],
            "authors": ["authors", "author"],
            "artists": ["artists", "artist"],
            "alt_names": ["alt_names", "alt_titles", "altTitles", "aliases", "alternative_names"],
        }
        for target_key, source_keys in list_mappings.items():
            for source_key in source_keys:
                normalized = self._normalize_named_list(manga_data.get(source_key))
                if normalized:
                    manga_data[target_key] = normalized
                    break

        # Year may live under any of these depending on the comix.to API
        # version. Guard tightly: only int values > 0; non-int payloads are
        # silently dropped so downstream consumers always see a clean field.
        for year_key in ("year", "release_year", "year_of_release"):
            year_raw = manga_data.get(year_key)
            if isinstance(year_raw, int) and year_raw > 0:
                manga_data["year"] = year_raw
                break

        return SiteComicContext(
            comic=manga_data,
            title=manga_data.get("title", "Unknown"),
            identifier=manga_data.get("hid") or manga_data.get("hash_id"),
            soup=soup
        )

    def get_chapters(
        self, context: SiteComicContext, scraper, language: str, make_request
    ) -> List[Dict]:
        hash_id = context.identifier
        if not hash_id:
             raise RuntimeError("Missing manga identifier (hash_id).")

        # Title URL feeds the DOM scrape. fetch_comic_context absolutizes this
        # on the comic dict; the hash_id-only fallback exists for callers that
        # constructed a context manually without a URL.
        title_url = context.comic.get("url") or f"https://comix.to/title/{hash_id}"

        # 2026-07-11: /api/v1/manga/{hid}/chapters is signed + encrypted
        # ({"e":...}) and 403s "Missing token." to cloudscraper, so the chapter
        # list is only obtainable from the rendered DOM. The persistent
        # Patchright browser paginates the title page via ?page=N (hard 20/page;
        # ?limit= is ignored and there's no infinite scroll), which can take
        # 30-90s on a large multi-group series. stderr (via the _stderr_print
        # shim) keeps stdout clean for JSON consumers.
        # Cross-file: _ComixBrowserSession.fetch_chapters_via_dom.
        print(
            "[*] Comix: fetching chapter list via persistent-browser DOM scrape "
            "(the JSON API is encrypted/token-gated).",
            flush=True,
        )
        raw_items = _COMIX_BROWSER_BRIDGE.fetch_chapters_via_dom(title_url) or []

        chapters: List[Dict] = []
        for item in raw_items:
            # Lenient language filter (ported from upstream's
            # "No chapters selected" fix). Two rules:
            #   1. Items with no `language` field are KEPT — many
            #      comix payloads omit the field on untranslated /
            #      original-language entries. The prior strict
            #      `!= language` silently dropped them (since
            #      None != "en"), surfacing as zero chapters.
            #   2. String match is case-insensitive AND accepts
            #      long-form names: "English" / "english" match
            #      "en" because the API mixes short codes ("en")
            #      with display names ("English") across endpoints.
            # DOM-scrape items always set language=None and so always
            # pass this filter; the per-row UI doesn't surface the
            # language attribute and the title URL implicitly already
            # restricts to whatever language section the user landed on.
            item_lang = item.get("language")
            if language and item_lang is not None:
                lang_lower = language.lower()
                item_lang_lower = item_lang.lower()
                if item_lang_lower != lang_lower and not item_lang_lower.startswith(lang_lower):
                    continue

            chap_num = item.get("number")
            # v1 uses `id`; v2 used `chapter_id`. Try v1 first.
            chap_id = item.get("id") or item.get("chapter_id")
            title = item.get("name") or f"Chapter {chap_num}"

            # Normalize chap_num to a parseable numeric string.
            # The API USUALLY returns int/float (e.g. 47, 47.5), but
            # has been observed returning None / "" / non-numeric
            # strings for special chapters (oneshots, side stories,
            # season-break placeholders). aio-dl.py:5885 calls
            # float(chap) for chapter bucketing and ValueErrors on
            # "None" / non-numeric text → the chapter gets skipped
            # with "Skipping chapter with invalid number: None" and
            # the user sees zero comix chapters downloaded.
            # Resolution order:
            #   1. item["number"] when numeric → "%g" coerce ("47", "47.5").
            #   2. item["number"] as a string with embedded digits
            #      → regex-extract.
            #   3. item["name"] / title → regex-extract.
            # Skip the chapter entirely when no numeric token is
            # available — surfacing a non-numeric `chap` would just
            # trigger the same skip downstream with a misleading
            # "Skipping chapter with invalid number" log line.
            chap_str: Optional[str] = None
            if isinstance(chap_num, (int, float)):
                chap_str = f"{chap_num:g}"
            else:
                for source_text in (
                    chap_num if isinstance(chap_num, str) else None,
                    title,
                ):
                    if not source_text:
                        continue
                    m = re.search(r"(\d+(?:\.\d+)?)", str(source_text))
                    if m:
                        chap_str = m.group(1)
                        break
            if chap_str is None:
                continue

            # Prefer the canonical chapter URL the API/DOM supplies in
            # `item["url"]` when present (ported from upstream's
            # _cf_aware refactor; DOM scrape also populates this).
            # Using the supplied URL avoids drift if comix changes
            # their URL slug format; the construction path below
            # remains the fallback for legacy item shapes that omit
            # the field.
            chap_url = item.get("url")
            if chap_url and not chap_url.startswith("http"):
                chap_url = urljoin("https://comix.to", chap_url)
            if not chap_url:
                # Construct URL
                # Format: https://comix.to/title/{hash_id}-{slug}/{chapter_id}-chapter-{number}
                slug = context.comic.get("slug")

                # If we don't have the slug from API, try to get it from the context URL
                if not slug and context.comic.get("url"):
                    path = urlparse(context.comic["url"]).path
                    parts = path.split('/')
                    if len(parts) >= 3:
                        # This is likely the full slug (hash_id-slug)
                        slug = parts[2]

                if not slug:
                    slug = "unknown"

                # Ensure slug starts with hash_id
                if not slug.startswith(f"{hash_id}-"):
                    slug = f"{hash_id}-{slug}"

                # URL still uses the API's raw `number` value (which is
                # what comix.to's chapter-page URL expects); chap_str is
                # only for our internal bucketing/sorting. Falls back to
                # chap_str when the API field was unparseable so the URL
                # at least targets the right chapter number rather than
                # the literal string "None".
                url_chap_part = chap_num if chap_num not in (None, "") else chap_str
                chap_url = f"https://comix.to/title/{slug}/{chap_id}-chapter-{url_chap_part}"

            # v1 uses `group`; v2 used `scanlation_group`. Try both.
            # DOM-scrape items also populate `group` with {"name": ...}.
            group_info = item.get("group") or item.get("scanlation_group") or {}
            group_name = group_info.get("name") if group_info else None

            chapters.append({
                "url": chap_url,
                "chap": chap_str,
                "title": title,
                "id": chap_id,
                "group": group_name,
                "up_count": item.get("votes", 0),
            })

        return chapters

    def get_group_name(self, chapter_version: Dict) -> Optional[str]:
        return chapter_version.get("group")

    # Module-level TTL constant used by _get/_cache_chapter_images.
    # Defined here (class-scope) instead of top-of-file so it stays
    # adjacent to the methods that read it; 600 s matches
    # sites/image_cache._TTL_SECONDS by intent — see __init__'s
    # _chapter_images_cache comment for why both clocks share a TTL.
    _CHAPTER_IMAGES_CACHE_TTL = 600.0

    def _get_cached_chapter_images(self, chapter_url: str) -> Optional[List[str]]:
        """Return a defensive copy of the cached URL list for this
        chapter, or None on miss / TTL-expired. Thread-safe."""
        with self._chapter_images_cache_lock:
            entry = self._chapter_images_cache.get(chapter_url)
            if entry is None:
                return None
            urls, ts = entry
            if time.monotonic() - ts > self._CHAPTER_IMAGES_CACHE_TTL:
                del self._chapter_images_cache[chapter_url]
                return None
            return list(urls)

    def _cache_chapter_images(self, chapter_url: str, urls: List[str]) -> None:
        """Stash this chapter's URL list. No-op on empty inputs
        (don't poison the cache with a known-bad result that would
        short-circuit a future retry). Thread-safe."""
        if not chapter_url or not urls:
            return
        with self._chapter_images_cache_lock:
            self._chapter_images_cache[chapter_url] = (list(urls), time.monotonic())

    def get_chapter_images(self, chapter: Dict, scraper, make_request) -> List[str]:
        url = chapter.get("url")

        # Memoization fast path. The prefetch worker and the main download flow
        # share this handler instance and BOTH call in for every chapter; the
        # DOM scrape is ~seconds AND serializes through the bridge's single
        # daemon worker behind any pending prefetches, so main was waiting
        # several chapters' scrape time for a result it could serve from memory.
        # Cache hit → return immediately, no browser enqueue. See __init__.
        if url:
            cached = self._get_cached_chapter_images(url)
            if cached is not None:
                return cached

        if not url:
            raise RuntimeError("Comix chapter is missing a url; cannot fetch images.")

        # 2026-07-11: the chapter page is an SPA that fetches a signed +
        # encrypted /api/v1/chapters/{id} ({"e":...}) and decrypts it in-JS to
        # render one lazy-loaded <img> per page. Those pages are now plain,
        # directly-fetchable webp CDN URLs — comix dropped the old server-side
        # tile-scramble, so there is no <canvas> anymore (verified 2026-07-11:
        # no x-scramble-* headers, no CSS transform, fetchable with no referer).
        # Python can neither sign nor decrypt the API, so drive the persistent
        # browser to render the chapter and scrape the page URLs from the DOM.
        # The bridge's page.on("response") listener also caches each <img>'s
        # bytes as they load, so aio-dl.py:dl_image usually serves straight from
        # memory instead of re-fetching. Returns [] on a render miss (the
        # caller's completeness gate then retries on the primary — comix is
        # SKIP_MULTI_SOURCE, so there is no alt-source rescue).
        # Cross-file: _ComixBrowserSession.fetch_chapter_images_via_dom.
        images = _COMIX_BROWSER_BRIDGE.fetch_chapter_images_via_dom(url) or []
        if images:
            self._cache_chapter_images(url, images)
        return images

    # ----------------------------------------------------------------- search
    # 2026-07-11: /api/v1/manga?keyword= is token-gated now — it returns
    # 403 {"message":"Missing token."} to anything cloudscraper can send (the
    # signature is computed in-page per URL). Keyword search can no longer work
    # from Python, so this degrades to [] on any failure, which just drops comix
    # out of a TITLE search. The usable path is URL-seed input: paste a comix.to
    # /title/ URL into --search and aio_search_cli.py:_try_extract_seed_hit
    # resolves it via fetch_comic_context (SSR #initial-data, no browser). A
    # browser-driven keyword search was considered and deferred (fragile; comix
    # is already SKIP_MULTI_SOURCE + SKIP_QUALITY_PROBE, i.e. de-prioritized).
    def search(
        self,
        query: str,
        scraper,
        make_request,
        *,
        language: str = "en",
        limit: int = 20,
    ) -> List[SearchHit]:
        clean = (query or "").strip()
        if not clean:
            return []
        url = (
            f"https://comix.to/api/v1/manga"
            f"?keyword={quote_plus(clean)}"
            f"&limit={int(limit)}"
        )
        # Any error (403 token-gate, network, non-JSON) → no comix results,
        # never an exception that would break the cross-site orchestrator.
        try:
            response = make_request(url, scraper)
            data = response.json()
        except Exception:
            return []
        if not isinstance(data, dict) or data.get("status") != "ok":
            return []
        items = (data.get("result") or {}).get("items") or []
        if not isinstance(items, list):
            return []

        hits: List[SearchHit] = []
        for idx, it in enumerate(items):
            hid = it.get("hid")
            title = (it.get("title") or "").strip()
            if not hid or not title:
                continue
            poster = it.get("poster") or {}
            cover = None
            if isinstance(poster, dict):
                cover = poster.get("large") or poster.get("medium") or poster.get("small")
            # latestChapter is float (e.g., 686.5 for half chapters); finalChapter
            # is the canonical end. Use finalChapter when available, else
            # int(latestChapter).
            chapter_count = it.get("finalChapter") or it.get("latestChapter")
            if isinstance(chapter_count, (int, float)):
                chapter_count = int(chapter_count)
            else:
                chapter_count = None
            year = it.get("year")
            if not isinstance(year, int):
                year = None
            # URL: /title/<hid> works without slug — verified live. The
            # fetch_comic_context handler takes hid from slug_part.split('-')[0]
            # so the no-slug form is parsed correctly.
            url_full = f"https://comix.to/title/{hid}"
            raw_score = max(0.05, 1.0 - (idx / max(1, len(items))))
            hits.append(
                SearchHit(
                    site=self.name,
                    title=title,
                    url=url_full,
                    cover=cover,
                    alt_titles=[],
                    year=year,
                    language=None,
                    chapter_count_hint=chapter_count,
                    raw_score=raw_score,
                )
            )
        return hits


# ---------------------------------------------------------------------------
# Patchright bridge
# ---------------------------------------------------------------------------
# Patchright's sync API has two hard constraints: (1) every call must run on
# the same thread that called sync_playwright().start(), and (2) that thread
# must own an asyncio event loop. Probe-phase workers in
# sites/search_orchestrator.py and image-prefetch threads in aio-dl.py
# satisfy neither. To make Patchright safely callable from any thread, we
# serialize all Patchright work onto a single dedicated worker thread (one
# process-wide) — the daemon `comix-pw` thread started by
# _ensure_comix_worker(). Callers from any thread submit a (future, fn,
# args, kwargs) tuple to _COMIX_REQUEST_QUEUE and block on the future's
# result with a wall-clock timeout (_COMIX_DEFAULT_TIMEOUT_S, 60 s).
# Synchronous from the caller's perspective.
#
# Mirrors sites/mangadex.py:_report_worker / _enqueue_report (same daemon
# +queue pattern) and sites/mangafire_vrf_simple.py:1965-2106 (the prior
# pattern this module used to follow before the v8 rewrite). Keep the
# three structurally similar so the pattern stays recognizable across
# the codebase.


class _ComixBrowserSession:
    """Patchright lifecycle owner. Every method runs on the daemon
    `comix-pw` worker (see _comix_worker_loop) so sync_playwright's
    same-thread contract is upheld.

    Bodies are lifted verbatim from the prior in-class implementation,
    with the main-thread guard removed (this dedicated thread IS now the
    only valid caller).
    """

    def __init__(self):
        self._pw = None
        self._browser = None
        # _context is an explicit BrowserContext so we can set User-Agent at
        # creation time AND call add_cookies later. browser.new_page() gives
        # an anonymous default context with neither lever exposed — and CF
        # binds cf_clearance to (UA, IP, TLS fp), so a UA mismatch between
        # the zendriver-captured cookie and the Patchright request would
        # make injection useless.
        self._context = None
        self._page = None
        # Monotonic-ish ts of the last crawlee_utils._cf_cookie_cache entry
        # we synced into _context. Used by _sync_cf_cookies to skip
        # redundant add_cookies calls when the cache hasn't changed.
        self._last_cf_cookie_ts: float = 0.0

    def _start(self) -> bool:
        """Lazy-launch Patchright on first use. Returns True if the browser
        is ready, False if Patchright/Playwright unavailable or launch failed.
        Subsequent calls are cheap (already-started fast path)."""
        if self._page is not None:
            # CX-1: a non-None page is NOT proof of health. A mid-run browser
            # or context crash leaves the dead page object in place; reusing
            # it makes every later chapter silently yield 0 images. Health-check
            # the page + browser connection before trusting the fast path; if
            # either is dead (or the check itself throws because the underlying
            # transport is gone), tear the whole stack down and relaunch fresh.
            # _cleanup() nulls self._page, so control falls through to the
            # launch block below on the same call.
            try:
                page_dead = self._page.is_closed()
                browser_dead = (
                    self._browser is not None and not self._browser.is_connected()
                )
            except Exception:
                page_dead = browser_dead = True
            if page_dead or browser_dead:
                print(
                    "[!] Comix: cached Patchright page/browser is dead "
                    "(crash or context loss); relaunching.",
                    flush=True,
                )
                self._cleanup()
            else:
                return True
        try:
            from patchright.sync_api import sync_playwright  # type: ignore
        except ImportError:
            try:
                from playwright.sync_api import sync_playwright  # type: ignore
            except ImportError:
                print("[!] Comix: patchright/playwright not installed; API capture unavailable.")
                return False
        try:
            self._pw = sync_playwright().start()
        except Exception as e:
            print(f"[!] Comix Playwright start failed: {e}")
            return False
        try:
            self._browser = self._pw.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-setuid-sandbox"],
            )
            # Create an explicit context so we can (a) match the UA that
            # zendriver used to solve CF and (b) inject cookies after the
            # fact. The cached UA is set at context-creation because it
            # cannot be changed on an existing context — if no CF solve
            # has happened yet, Patchright's default stealth UA is used.
            ctx_kwargs: Dict[str, Any] = {}
            cached_ua = self._cached_cf_user_agent()
            if cached_ua:
                ctx_kwargs["user_agent"] = cached_ua
            self._context = self._browser.new_context(**ctx_kwargs)
            self._page = self._context.new_page()
        except Exception as e:
            print(f"[!] Comix Playwright launch failed: {e}")
            self._cleanup()
            return False

        # Session-level <img> byte capture. This is the single most important
        # wire in the comix chapter pipeline: the ~70-80 pages per chapter load
        # as <img> off the CDN, and without capturing the bytes here dl_image
        # would re-fetch each URL over HTTP later — by which time the CDN may be
        # rate-limiting from the parallel scrape traffic. Empirically that was
        # the cause of the [Backoff]/[Fallback]/[Error: Skipping] cascades and
        # the 30s long-retries per chapter. Stashing the bytes at the moment the
        # browser pulls them lets dl_image short-circuit straight to disk.
        #
        # Filter on request.resource_type == "image": only true <img>-tag
        # fetches qualify. JS-driven fetch()/XHR calls are resource_type
        # "fetch"/"xhr" and get skipped — caching them would just waste the
        # 256MB cap. Cross-file: sites/image_cache.py owns the cache + eviction;
        # aio-dl.py:dl_image reads from it at the top before any HTTP work.
        try:
            from . import image_cache as _image_cache_module
        except Exception:
            _image_cache_module = None

        def _capture_image_response(response):
            if _image_cache_module is None:
                return
            try:
                try:
                    if response.request.resource_type != "image":
                        return
                except Exception:
                    pass
                ct = (response.headers.get("content-type") or "").lower()
                if not ct.startswith("image/"):
                    return
                body = response.body()
                if body:
                    _image_cache_module.cache_image(response.url, body, ct)
            except Exception:
                # response.body() can throw if the response was
                # aborted or the page navigated before the body
                # arrived. Silent skip — the chapter's canvas
                # toDataURL path or dl_image's HTTP fallback will
                # handle the missing entry.
                pass

        try:
            self._page.on("response", _capture_image_response)
        except Exception as e:
            print(
                f"[!] Comix: failed to attach image-response "
                f"listener ({type(e).__name__}: {e}); plain <img> "
                f"pages will fall through to HTTP fetch with the "
                f"signed-token-expiry risk that implies.",
                flush=True,
            )

        # Inject any cookies already captured by a prior zendriver solve.
        # Public methods also re-call _sync_cf_cookies in case the cache
        # gets a fresher generation between the bridge launching and the
        # actual navigation.
        self._sync_cf_cookies()
        return True

    def _cleanup(self):
        try:
            if self._context is not None:
                self._context.close()
        except Exception:
            pass
        self._context = None
        try:
            if self._browser is not None:
                self._browser.close()
        except Exception:
            pass
        self._browser = None
        try:
            if self._pw is not None:
                self._pw.stop()
        except Exception:
            pass
        self._pw = None
        self._page = None
        self._last_cf_cookie_ts = 0.0

    def _cached_cf_user_agent(self) -> Optional[str]:
        """Return the User-Agent string from any cached zendriver CF solve
        for comix.to, or None if no solve has run yet. Using THAT exact UA
        in the Patchright context is what keeps the cf_clearance cookie
        valid on Patchright-issued requests — CF rejects cookie+UA
        mismatches as bot signals.

        Cross-file: cache populated by sites/crawlee_utils.py:_solve_cf_async
        via get_cf_session; key is the bare netloc ("comix.to").
        """
        try:
            from . import crawlee_utils as _cu
            with _cu._cf_cookie_lock:
                cached = _cu._cf_cookie_cache.get("comix.to")
            if cached:
                return cached.get("user_agent") or None
        except Exception:
            pass
        return None

    def _sync_cf_cookies(self) -> None:
        """Copy the latest crawlee CF cookies into this bridge's Patchright
        context so the headless DOM scrape inherits the cf_clearance
        that zendriver captured visibly. Idempotent — tracks last-synced
        timestamp and no-ops when the cache is empty or hasn't changed
        since the last sync.

        Caveat: even with matching UA + cookies, CF can still re-challenge
        because the TLS fingerprint of Patchright's bundled Chromium may
        differ from the headed Chrome that zendriver used. If it does,
        the page-1 selector wait still times out and the comix.py
        diagnostic block surfaces it — at which point this strategy is
        exhausted and the user should rerun with --multi-source.

        Cross-file: cookies populated in sites/crawlee_utils.py via
        get_cf_session → _solve_cf_async; serialized through
        _cu._cf_cookie_lock for cross-thread safety.
        """
        if self._context is None:
            return
        try:
            from . import crawlee_utils as _cu
            with _cu._cf_cookie_lock:
                cached = _cu._cf_cookie_cache.get("comix.to")
        except Exception:
            return
        if not cached:
            return
        ts = float(cached.get("ts", 0) or 0)
        if ts <= self._last_cf_cookie_ts:
            return  # already injected this generation
        raw = cached.get("cookies") or []
        if not raw:
            return
        pw_cookies: List[Dict[str, Any]] = []
        for c in raw:
            entry: Dict[str, Any] = {
                "name": c["name"],
                "value": c["value"],
                "domain": c.get("domain") or "comix.to",
                "path": c.get("path") or "/",
            }
            pw_cookies.append(entry)
        try:
            self._context.add_cookies(pw_cookies)
            self._last_cf_cookie_ts = ts
            print(
                f"[*] Comix: injected {len(pw_cookies)} CF cookie(s) "
                f"captured by zendriver into the Patchright context",
                flush=True,
            )
        except Exception as exc:
            print(
                f"[!] Comix: failed to inject CF cookies into Patchright: "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )

    def fetch_chapters_via_dom(
        self,
        title_url: str,
        max_pages: int = 500,
        time_budget_s: float = 300.0,
    ) -> List[Dict]:
        """Paginate the title page (`?page=N`) in the persistent browser and
        scrape chapter rows from the rendered DOM. Used when the JSON API
        path returns 0 items because comix.to's `/api/v1/manga/{hid}/chapters`
        now responds with an encrypted blob (`{"e": "<base64-ish>"}`) that
        we can't decode in Python — the page's bundle decrypts it via a
        module-scoped routine that isn't exposed on `window`, so calling it
        from `page.evaluate` isn't reachable.

        Returns API-item-shaped dicts so the handler's existing per-item
        processing loop (chap_str normalization, lenient language filter,
        URL construction, group extraction) keeps working unchanged. The
        only field that's intentionally None is `language` — comix's DOM
        doesn't surface a per-row language attribute, and the title-page
        URL implicitly already filters to whichever language the user
        landed on; the lenient filter treats None as "keep" anyway.

        Pagination strategy:
          - Iterate page=1,2,3… via `page.goto`. Each navigation is ~1s
            with `wait_for_selector(".mchap-row__primary", timeout=10s)`
            instead of a fixed sleep, and the persistent browser keeps
            warm so subsequent navs reuse the same TCP/TLS session.
          - Dedupe by chap_id across pages — comix's pagination occasionally
            overlaps the boundary chapter between adjacent pages, so naive
            concatenation would double-count.
          - Print a progress line every 20 pages so the UI / CLI user
            doesn't think the process is hung during long scrapes.

        Time budget: default 300s. One Piece is the long-tail outlier
        (~180 pages * 1s in the warm-browser case = ~3 min); most series
        fit well under a minute. Truncated runs surface a stderr warning
        AND return the partial list — better than a hard fail, and the
        caller's chapter range (`--chapters`) can clip to whatever was
        scraped.

        Returns empty list on any error so the caller's None-vs-[] check
        still works as a sentinel for "API exhausted, scrape exhausted".
        """
        if not self._start():
            return []
        self._sync_cf_cookies()
        import time as _time
        # Selectors mirror the DOM probe done during the merge research:
        # `.mchap-item` is the <li> row, `.mchap-row__primary` is the chapter
        # link, `.mchap-row__ch` holds "Ch.<num>", `.mchap-row__title` is the
        # chapter title, `.mchap-row__group` is the scanlation group anchor
        # (with `.is-official` for official publishers). Cross-file: grep
        # `mchap-` in this file's history for the probe context.
        scrape_js = """() => {
            return Array.from(document.querySelectorAll('.mchap-item')).map(li => {
                const a = li.querySelector('.mchap-row__primary');
                const ch = li.querySelector('.mchap-row__ch');
                const ti = li.querySelector('.mchap-row__title');
                const gp = li.querySelector('.mchap-row__group');
                const lk = li.querySelector('.mchap-row__likes');
                return {
                    href: a ? a.getAttribute('href') : null,
                    chap_label: ch ? ch.textContent.trim() : null,
                    title: ti ? ti.textContent.trim() : null,
                    group: gp ? (gp.querySelector('span') ? gp.querySelector('span').textContent.trim() : gp.textContent.trim()) : null,
                    group_official: gp ? gp.classList.contains('is-official') : false,
                    likes: lk ? parseInt((lk.textContent.match(/\\d+/) || ['0'])[0]) : 0,
                };
            });
        }"""
        # Drop any trailing ?query so we can append our own pagination param
        # cleanly. comix accepts ?page=N on the title page and the React
        # router uses that to drive the chapter-list state.
        base = title_url.split("?", 1)[0]
        items: List[Dict] = []
        seen_ids: set = set()
        deadline = _time.monotonic() + time_budget_s
        # Track the first row's href from the previous scrape. Critical for
        # correctness on back-to-back goto: comix's React component swaps
        # row CONTENT without unmounting, so the OLD page's `.mchap-row__primary`
        # nodes survive long enough that a naïve `wait_for_selector` returns
        # instantly on stale DOM, we re-scrape the previous page's chap_ids,
        # every row is a dup, and the consecutive_dup early-break fires a
        # false end-of-list. Waiting for the first row's href to differ
        # from the previous page is the cheapest reliable freshness signal.
        prev_first_href: Optional[str] = None
        consecutive_dup_pages = 0
        for page_n in range(1, max_pages + 1):
            if _time.monotonic() > deadline:
                print(
                    f"[!] Comix DOM scrape time budget ({time_budget_s:.0f}s) "
                    f"exceeded at page {page_n}; returning {len(items)} chapters "
                    f"(use --chapters to limit). Series may be truncated.",
                    flush=True,
                )
                break
            url = f"{base}?page={page_n}"
            try:
                self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
                # Page 1 has no prior page to diff against — fall back to
                # the simple "any chapter row exists" signal. Subsequent
                # pages wait for the React swap to actually happen.
                if prev_first_href is None:
                    try:
                        self._page.wait_for_selector(".mchap-row__primary", timeout=10000)
                    except Exception as wait_exc:
                        # Surface why the scrape gave up on page 1. The prior
                        # silent break made "comix returns 0 chapters"
                        # debugging opaque — sandboxed Chromium can silently
                        # masquerade a CF challenge or a slow SPA render as
                        # an empty series. Dump page title/URL/body-text +
                        # CF-challenge sniff so the user can tell which.
                        # Diagnostic-only; control flow still breaks after.
                        # Cross-file: is_cf_challenge in sites/crawlee_utils.py.
                        try:
                            page_title = self._page.title() or "(no title)"
                            page_url = self._page.url
                            body_text = self._page.evaluate(
                                "document.body ? document.body.innerText.slice(0, 500) : ''"
                            ) or ""
                            snippet = body_text.replace("\n", " ").strip()
                            cf_msg = ""
                            if _CF_AVAILABLE:
                                try:
                                    if is_cf_challenge(200, body_text):
                                        cf_msg = " — looks like a Cloudflare challenge"
                                except Exception:
                                    pass
                            print(
                                f"[!] Comix DOM scrape: page 1 selector "
                                f"'.mchap-row__primary' did not render "
                                f"within 10s{cf_msg}. "
                                f"title={page_title!r} url={page_url!r}",
                                flush=True,
                            )
                            if snippet:
                                print(
                                    f"[!] Comix DOM scrape: page 1 visible "
                                    f"text (first 500 chars): {snippet}",
                                    flush=True,
                                )
                        except Exception as diag_exc:
                            print(
                                f"[!] Comix DOM scrape: page 1 selector timed "
                                f"out ({type(wait_exc).__name__}); diagnostic "
                                f"dump also failed: {type(diag_exc).__name__}: "
                                f"{diag_exc}",
                                flush=True,
                            )
                        break
                else:
                    # Wait until the first row's href differs from the
                    # previous page's first href. Times out at 10s either
                    # because (a) we're past the last page and React kept
                    # showing the prior content unchanged, or (b) comix
                    # legitimately took >10s to re-render. (a) is terminal;
                    # we treat the empty-rows result that follows as the
                    # end signal naturally. json.dumps escapes any quotes
                    # in the href so the literal can't break the JS parse.
                    js_predicate = (
                        "(() => { const a = document.querySelector('.mchap-row__primary'); "
                        f"return a && a.getAttribute('href') !== {json.dumps(prev_first_href)}; }})"
                    )
                    try:
                        self._page.wait_for_function(js_predicate, timeout=10000)
                    except Exception:
                        # DOM didn't update — either past end of pagination
                        # or React is being lazy. Either way scrape what we
                        # have and let the post-scrape dup-detect handle it.
                        pass
                rows = self._page.evaluate(scrape_js) or []
            except Exception as e:
                print(f"[!] Comix DOM scrape failed at page {page_n}: {type(e).__name__}: {e}", flush=True)
                break
            if not rows:
                # On page 1 the selector wait already passed (so
                # `.mchap-row__primary` rendered) — `.mchap-item` returning
                # 0 here means the DOM scheme changed. On later pages this
                # is the normal end-of-pagination signal; silent is correct
                # there. Probe both selectors so the user can see the gap.
                if prev_first_href is None:
                    try:
                        primary_count = self._page.evaluate(
                            "document.querySelectorAll('.mchap-row__primary').length"
                        )
                        item_count = self._page.evaluate(
                            "document.querySelectorAll('.mchap-item').length"
                        )
                        print(
                            f"[!] Comix DOM scrape: page 1 had "
                            f"{primary_count} `.mchap-row__primary` "
                            f"element(s) but {item_count} `.mchap-item` "
                            f"row(s). scrape_js queries `.mchap-item`, so "
                            f"comix likely renamed the row container — "
                            f"update the selectors in fetch_chapters_via_dom.",
                            flush=True,
                        )
                    except Exception as diag_exc:
                        print(
                            f"[!] Comix DOM scrape: page 1 returned 0 rows "
                            f"and the diagnostic probe also failed: "
                            f"{type(diag_exc).__name__}: {diag_exc}",
                            flush=True,
                        )
                break
            # Update prev_first_href for the next iteration's freshness check.
            # Use the raw href (not the normalized url) so the JS predicate
            # comparison stays exact.
            prev_first_href = rows[0].get("href")
            # Progress: emit a heartbeat every 20 pages so the UI / CLI
            # doesn't look stuck during long scrapes (One Piece is ~180
            # pages = ~3 minutes wall time with a warm browser). stderr
            # path keeps stdout clean for JSON consumers.
            if page_n % 20 == 0:
                elapsed = int(_time.monotonic() - (deadline - time_budget_s))
                print(
                    f"[*] Comix DOM scrape: page {page_n}, "
                    f"{len(items)} unique chapters so far ({elapsed}s elapsed).",
                    flush=True,
                )
            page_added = 0
            for row in rows:
                href = row.get("href")
                if not href:
                    continue
                # Parse `/title/{slug}/{chap_id}-chapter-{chap_num}` —
                # chap_id is digits, chap_num is the rest (allows .5/.1 etc).
                m = re.match(r".*/title/[^/]+/(\d+)-chapter-(.+)$", href)
                if not m:
                    continue
                chap_id_str, chap_num_str = m.group(1), m.group(2)
                if chap_id_str in seen_ids:
                    continue
                seen_ids.add(chap_id_str)
                # Absolutize URL — comix anchors are href-relative on the page.
                chap_url = href if href.startswith("http") else ("https://comix.to" + href)
                # Coerce chap_num to int/float where possible so the handler's
                # `isinstance(chap_num, (int, float))` branch hits the fast
                # %g formatter; non-numeric specials fall through to the
                # regex-extract branch (handles oneshots / "1.5" / etc).
                num_val: Any = chap_num_str
                try:
                    fv = float(chap_num_str)
                    num_val = int(fv) if fv.is_integer() else fv
                except ValueError:
                    pass
                items.append({
                    "id": int(chap_id_str),
                    "number": num_val,
                    "name": row.get("title") or row.get("chap_label"),
                    "url": chap_url,
                    "group": {"name": row.get("group")} if row.get("group") else None,
                    "votes": row.get("likes") or 0,
                    # Language is unknown from the DOM — the lenient filter
                    # in get_chapters keeps `None` items, matching the
                    # "untagged items shouldn't be silently dropped" rule
                    # ported from upstream.
                    "language": None,
                })
                page_added += 1
            if page_added == 0:
                # Every row was a dup of an earlier page. Could be normal
                # boundary overlap (1-2 dups) or a sign the pagination is
                # stuck on the same page. Break after 2 consecutive
                # zero-add pages to bound the worst case.
                consecutive_dup_pages += 1
                if consecutive_dup_pages >= 2:
                    break
            else:
                consecutive_dup_pages = 0
        # Always emit a final tally so the caller's "API returned 0
        # chapters, falling back to DOM scrape" line in get_chapters has
        # a corresponding "DOM scrape gave us X" line. Without this the
        # silent-empty path looked identical to the success path from
        # the get_chapters caller's perspective, and the user only saw
        # "No chapters selected" with no clue what happened in between.
        print(
            f"[*] Comix DOM scrape: complete. {len(items)} chapter(s) "
            f"collected across {page_n} page(s).",
            flush=True,
        )
        return items


    def fetch_chapter_images_via_dom(
        self,
        chapter_url: str,
        time_budget_s: float = 300.0,
    ) -> list:
        """Capture chapter pages by scrolling each .rpage-page into view and
        reading the rendered element one at a time.

        Why the browser at all: the chapter page is an SPA whose page list
        comes from a signed + encrypted /api/v1/chapters/{id} ({"e":...})
        response that only the in-page JS can decrypt — Python can neither sign
        nor decrypt it — and the <img> src is lazy-set per page as it nears the
        viewport (not in #initial-data or any data-* attribute). So we let the
        browser render and scrape the DOM.

        Two page shapes, checked in order (see the per-page poll below):
          - <img> (the NORMAL path as of 2026-07-11): comix dropped the old
            server-side tile-scramble, so pages are plain, directly-fetchable
            webp CDN URLs. Use img.src verbatim; aio-dl.py:dl_image fetches it
            (and the session-level page.on("response") listener already cached
            its bytes as it loaded, so that's usually a memory hit).
          - <canvas> (LEGACY fallback): kept in case comix re-enables the tile
            scramble it used through mid-2026 (webp shipped with x-scramble-seed
            / x-scramble-grid headers, unscrambled in-JS onto a canvas). Read
            the pixels via canvas.toDataURL and stash the bytes in image_cache
            under a synthetic comix-page://<chap_id>/<NNNN>.webp key so dl_image
            serves them without any HTTP fetch (the real /si/ URL would return
            the scrambled bytes). Costs nothing when no canvas is present.

        Flow:
          1. Pre-flight: visit comix.to once to set localStorage
             `reader.default.preload = 'all'` so the reader renders eagerly.
          2. Navigate to the chapter URL; wait for the React app to mount and
             populate one .rpage-page <div> per page (= the page count).
          3. For each page 1..N: scrollIntoView (triggers the lazy load), poll
             up to 10 s for a rendered <img>/<canvas>, collect the URL/key.

        Cross-file: called from ComixSiteHandler.get_chapter_images via
        _COMIX_BROWSER_BRIDGE.fetch_chapter_images_via_dom; image_cache
        populated here is read by aio-dl.py:dl_image. Runs on the comix-pw
        daemon worker per the bridge's same-thread Patchright contract.
        """
        if not self._start():
            return []
        self._sync_cf_cookies()
        import base64 as _b64
        import re as _re
        import time as _time

        page = self._page
        if page is None:
            return []

        try:
            from . import image_cache as _image_cache
            # No clear_cache() here. The image-prefetch chain in
            # aio-dl.py runs scrape N+1 while chapter N's
            # downloader is still draining cached bytes for N, so
            # a clear would wipe still-needed entries and force
            # dl_image to fall through to HTTP (where the signed
            # CDN tokens may have already expired). Eviction is
            # TTL- and size-based — see sites/image_cache.py.
        except Exception:
            _image_cache = None

        m_id = _re.search(r"/(\d+)-chapter-\d+", chapter_url or "")
        chap_id = m_id.group(1) if m_id else "unknown"

        deadline = _time.monotonic() + time_budget_s

        # ── Step 1: set preload=all in localStorage on the comix.to
        # origin. Localstorage is per-origin so we navigate to the
        # homepage first (cheap because we already have CF cookies).
        # If this fails we still proceed — the per-page scrollIntoView
        # loop below works without preload-all, just slower.
        try:
            page.goto(
                "https://comix.to/",
                wait_until="domcontentloaded",
                timeout=15000,
            )
            page.evaluate("""() => {
                try {
                    const k = 'reader.default';
                    const cur = JSON.parse(localStorage.getItem(k) || '{}');
                    cur.preload = 'all';
                    localStorage.setItem(k, JSON.stringify(cur));
                } catch (e) {}
            }""")
        except Exception as e:
            print(
                f"[*] Comix: localStorage preload-all setup failed "
                f"({type(e).__name__}: {e}); continuing with default "
                f"preload setting.",
                flush=True,
            )

        # ── Step 2: navigate to chapter and wait for .rpage-page divs.
        try:
            page.goto(
                chapter_url,
                wait_until="domcontentloaded",
                timeout=30000,
            )
        except Exception as e:
            print(
                f"[!] Comix chapter image canvas scrape: nav failed for "
                f"{chapter_url}: {type(e).__name__}: {e}",
                flush=True,
            )
            return []

        # Wait for the React app to mount and the chapter API to fire,
        # which populates .rpage-page divs. Poll up to 30 s — most
        # chapters mount in 3-8 s but the CF turnstile / slow networks
        # can push that out.
        page_count = 0
        for _ in range(60):
            if _time.monotonic() > deadline:
                break
            try:
                page_count = page.evaluate(
                    "() => document.querySelectorAll('.rpage-page').length"
                ) or 0
            except Exception:
                page_count = 0
            if page_count > 0:
                break
            page.wait_for_timeout(500)

        if page_count == 0:
            print(
                f"[!] Comix: chapter had 0 .rpage-page divs in DOM "
                f"after wait. Either the React app failed to mount or "
                f"CF re-challenged. URL={chapter_url}",
                flush=True,
            )
            return []

        print(
            f"[*] Comix: chapter has {page_count} pages; capturing "
            f"each via Patchright (<img> src, or canvas pixels if a page "
            f"is tile-scrambled).",
            flush=True,
        )

        # ── Step 3: per-page scroll + capture.
        # Per-page wait is capped at 10 s. Pages that don't render in
        # time are logged and skipped (very long chapters may still
        # come up; the user can retry with a longer time_budget_s).
        urls: list = []
        canvas_count = 0
        img_count = 0
        failed_pages: list = []

        for p in range(1, page_count + 1):
            if _time.monotonic() > deadline:
                print(
                    f"[!] Comix: hit time budget {time_budget_s:.0f}s "
                    f"at page {p}/{page_count} — returning what we have.",
                    flush=True,
                )
                break

            # Scroll the page's div into view. instant + center so the
            # IntersectionObserver fires immediately and the canvas
            # ends up vertically centered, helping the surrounding
            # pages preload too.
            try:
                page.evaluate(
                    "(n) => { const el = document.querySelector("
                    "'.rpage-page[data-page=\"' + n + '\"]'); "
                    "if (el) el.scrollIntoView("
                    "{behavior: 'instant', block: 'center'}); }",
                    p,
                )
            except Exception:
                pass

            # Poll for the page to be ready. The polling JS returns
            # either {type: canvas, ...} or {type: img, ...} once a
            # rendered child exists with non-zero dimensions and the
            # parent has shed the .is-loading class.
            ready = None
            for _attempt in range(40):  # 40 * 250ms = 10s
                if _time.monotonic() > deadline:
                    break
                try:
                    ready = page.evaluate(
                        "(n) => { "
                        "const el = document.querySelector("
                        "'.rpage-page[data-page=\"' + n + '\"]'); "
                        "if (!el) return null; "
                        "const isLoading = "
                        "el.classList.contains('is-loading'); "
                        "const c = el.querySelector('canvas'); "
                        "if (c && c.width > 0 && c.height > 0 "
                        "&& !isLoading) "
                        "return {type: 'canvas', w: c.width, h: c.height}; "
                        "const i = el.querySelector('img'); "
                        "if (i && i.src && i.complete "
                        "&& i.naturalWidth > 0) "
                        "return {type: 'img', src: i.src, "
                        "w: i.naturalWidth, h: i.naturalHeight}; "
                        "return null; }",
                        p,
                    )
                except Exception:
                    ready = None
                if ready:
                    break
                page.wait_for_timeout(250)

            if not ready:
                failed_pages.append(p)
                continue

            if ready.get("type") == "canvas":
                # Read canvas pixels. Use webp at q=0.95 — comparable
                # to the original (the source is already webp) and
                # smaller than PNG by a factor of 5-10x.
                try:
                    data_url = page.evaluate(
                        "(n) => { const c = document.querySelector("
                        "'.rpage-page[data-page=\"' + n + '\"] canvas'); "
                        "return c ? c.toDataURL('image/webp', 0.95) "
                        ": null; }",
                        p,
                    )
                except Exception as e:
                    print(
                        f"  page {p}: toDataURL threw "
                        f"{type(e).__name__}: {e}",
                        flush=True,
                    )
                    failed_pages.append(p)
                    continue
                if not data_url or not data_url.startswith("data:image/"):
                    failed_pages.append(p)
                    continue
                try:
                    _hdr, b64 = data_url.split(",", 1)
                    decoded = _b64.b64decode(b64)
                except Exception:
                    failed_pages.append(p)
                    continue
                # Synthetic URL key — comix's real /si/ URLs cannot
                # be re-fetched by cloudscraper (they'd return the
                # SCRAMBLED bytes, and we can't undo the scrambling
                # in Python). The cache hit short-circuits dl_image
                # before any HTTP work.
                synthetic_url = (
                    f"comix-page://{chap_id}/{p:04d}.webp"
                )
                if _image_cache is not None:
                    _image_cache.cache_image(
                        synthetic_url, decoded, "image/webp",
                    )
                urls.append(synthetic_url)
                canvas_count += 1
            else:
                # Plain image — non-scrambled. img.src is the real
                # CDN URL; cloudscraper can fetch it the normal way.
                urls.append(ready["src"])
                img_count += 1

        # Final summary so the user knows the capture rate. Failed
        # pages aren't FATAL on their own — aio-dl.py:_process_chapter
        # will treat the chapter as incomplete and inline-retry, which
        # gives the reader another shot to render any laggards.
        if failed_pages:
            sample = ", ".join(str(p) for p in failed_pages[:10])
            more = (
                f" (+{len(failed_pages) - 10} more)"
                if len(failed_pages) > 10 else ""
            )
            print(
                f"[!] Comix canvas scrape: {len(urls)}/{page_count} "
                f"pages captured ({canvas_count} via canvas, "
                f"{img_count} via <img>). {len(failed_pages)} pages "
                f"failed to render in 10 s each: pages {sample}{more}.",
                flush=True,
            )
        else:
            print(
                f"[*] Comix canvas scrape: {len(urls)}/{page_count} "
                f"pages captured ({canvas_count} via canvas, "
                f"{img_count} via <img>). All pages rendered.",
                flush=True,
            )
        return urls



    def close(self):
        self._cleanup()


# v8 bridge rewrite (2026-05-24): replaced module-level ThreadPoolExecutor
# with a daemon thread + queue.Queue, mirroring sites/mangadex.py's report
# pipeline. The TPE approach had two latent failure modes that the
# code review surfaced:
#
#   1. INTERPRETER HANG AT EXIT. concurrent.futures._python_exit
#      registers with `threading._register_atexit` and runs BEFORE the
#      atexit module's hooks. It calls join() on every TPE worker
#      unconditionally — even after shutdown(wait=False, cancel_futures=True).
#      If Patchright nav was wedged on a Cloudflare turnstile spin at
#      Ctrl-C, the comix-pw worker stayed blocked in page.goto and
#      the user's process hung for up to 30s waiting for the goto's
#      own timeout. Same anti-pattern that sites/mangadex.py's daemon
#      rewrite explicitly addressed earlier in the same diff
#      (mangadex.py:41-58 comment).
#   2. CALLER DEADLOCK ON HUNG NAV. `fut.result()` had no timeout, so
#      any single hung Patchright op deadlocked every concurrent caller
#      submitting through the same single-worker executor (and there
#      IS only one worker — max_workers=1). The probe phase has 6 parallel
#      probe-pool workers all routing through this bridge; one comix
#      candidate getting stuck would freeze all six.
#
# Daemon thread + queue resolves both: daemons are skipped by _python_exit
# (clean Ctrl-C semantics), and the worker dequeues one job at a time so
# we can attach an explicit per-call timeout on fut.result() without
# changing the single-thread-owns-the-browser invariant. Bridge public
# API (_COMIX_BROWSER_BRIDGE) is unchanged so existing call sites in
# this file don't move.
_COMIX_REQUEST_QUEUE: queue.Queue = queue.Queue()
_COMIX_WORKER_STARTED = False
_COMIX_WORKER_LOCK = threading.Lock()
_COMIX_BROWSER: Optional[_ComixBrowserSession] = None  # owned by the worker thread
_COMIX_SHUTDOWN_SENTINEL = object()
# Per-call wall-clock cap on Patchright work. Real-world page.goto
# timeouts inside _ComixBrowserSession sit at 30s; the bridge cap is
# the sum of those plus a small slack so a legitimate slow nav still
# completes but a stuck one surfaces as TimeoutError rather than
# deadlocking the caller. Search-phase callers should also have their
# own outer deadline (PROBE_PHASE_DEADLINE_S in search_orchestrator);
# this is the inner guard.
_COMIX_DEFAULT_TIMEOUT_S = 60.0


def _comix_worker_loop() -> None:
    """Daemon thread that owns the single Patchright browser instance.

    Pulls (future, fn_name, args, kwargs) tuples and sets the future's
    result/exception. Exits cleanly on the shutdown sentinel. Lazy-inits
    the session singleton on the first non-sentinel job so import-time
    cost stays at zero for non-comix runs (sites/__init__.py imports
    this module eagerly so every aio-dl process touches these globals,
    but no Patchright launch happens until a user actually hits comix).
    """
    global _COMIX_BROWSER
    while True:
        item = _COMIX_REQUEST_QUEUE.get()
        if item is _COMIX_SHUTDOWN_SENTINEL:
            try:
                if _COMIX_BROWSER is not None:
                    try:
                        _COMIX_BROWSER.close()
                    except Exception:
                        pass
                    _COMIX_BROWSER = None
            finally:
                return
        try:
            fut, fn_name, args, kwargs = item
        except (TypeError, ValueError):
            # Malformed enqueue — skip without dying. Belt-and-suspenders
            # against future maintainers putting unexpected sentinels on
            # the queue (matches the mangadex worker's None-safe pattern).
            continue
        # Caller's fut.result(timeout=...) may have already given up and
        # the future could be cancelled; honor the cancel without doing
        # the work (avoids redundant Patchright nav for callers who
        # already moved on).
        if fut.cancelled():
            continue
        try:
            if _COMIX_BROWSER is None:
                _COMIX_BROWSER = _ComixBrowserSession()
            fn = getattr(_COMIX_BROWSER, fn_name)
            result = fn(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 — propagate to caller
            # Race: caller's fut.result(timeout=...) may have hit the
            # timeout and called fut.cancel() AFTER our cancelled-check
            # above but BEFORE we got here. set_exception raises
            # InvalidStateError on a cancelled future, which would kill
            # the worker thread. Suppress — the caller already moved on.
            try:
                fut.set_exception(exc)
            except _futures.InvalidStateError:
                pass
        else:
            try:
                fut.set_result(result)
            except _futures.InvalidStateError:
                # Same race as above, success path. Worker just discards
                # its result because the caller no longer cares.
                pass


def _ensure_comix_worker() -> None:
    """Lazy-start the single Patchright worker daemon. Double-checked
    locking so concurrent first-callers don't race to spawn duplicates.
    """
    global _COMIX_WORKER_STARTED
    if _COMIX_WORKER_STARTED:
        return
    with _COMIX_WORKER_LOCK:
        if _COMIX_WORKER_STARTED:
            return
        threading.Thread(
            target=_comix_worker_loop,
            name="comix-pw",
            daemon=True,
        ).start()
        _COMIX_WORKER_STARTED = True


def _comix_call(fn_name: str, *args, _timeout_s: float = _COMIX_DEFAULT_TIMEOUT_S, **kwargs):
    """Submit a session method call onto the daemon worker and block on
    its result, bounded by ``_timeout_s`` (default 60 s). Synchronous
    from the caller's perspective — same contract as the previous
    ThreadPoolExecutor-based implementation, but with an explicit
    wall-clock cap so a hung Patchright nav surfaces as TimeoutError
    instead of an indefinite deadlock.

    Per-call timeout can be overridden via the keyword `_timeout_s`
    (kw-only so it doesn't collide with method args). Cancellation
    after timeout sets the future cancelled; the worker honors the
    cancel and skips the underlying call if it hadn't started yet.
    """
    _ensure_comix_worker()
    fut: _futures.Future = _futures.Future()
    _COMIX_REQUEST_QUEUE.put((fut, fn_name, args, kwargs))
    try:
        return fut.result(timeout=_timeout_s)
    except _futures.TimeoutError:
        # Best-effort cancel so the worker can skip the call if it
        # hasn't started. If the worker is already executing this
        # future, set_running_or_notify_cancel returns False internally
        # and the underlying Patchright op continues (no thread
        # cancellation in Python) — but at least subsequent callers
        # aren't blocked behind a future we've stopped waiting for.
        fut.cancel()
        raise


class _ComixBrowserBridge:
    """Thread-safe facade over _ComixBrowserSession. Every method routes
    through _comix_call so the underlying Patchright calls always run
    on the daemon worker thread that owns the browser instance.

    Cross-file: mirrors sites/mangafire_vrf_simple.py:_VRFBridge in
    spirit; the v8 rewrite swaps the executor for daemon+queue (see
    block-comment near _COMIX_REQUEST_QUEUE for rationale).
    """

    def fetch_chapters_via_dom(
        self,
        title_url: str,
        max_pages: int = 500,
        time_budget_s: float = 300.0,
    ) -> List[Dict]:
        """Bridge facade for the DOM-pagination fallback. Default per-call
        wall clock is `time_budget_s + 30s` (worker overhead + final goto
        slack) so the bridge timeout doesn't trip BEFORE the in-method
        budget logic has a chance to return a partial list — the inner
        budget is the load-bearing one; this is just the outer safety net.
        Cross-file: see _ComixBrowserSession.fetch_chapters_via_dom for
        the actual pagination + DOM-scrape implementation.
        """
        return _comix_call(
            "fetch_chapters_via_dom",
            title_url,
            max_pages,
            time_budget_s,
            _timeout_s=time_budget_s + 30.0,
        )

    def fetch_chapter_images_via_dom(
        self,
        chapter_url: str,
        time_budget_s: float = 300.0,
    ) -> List[str]:
        """Bridge facade for chapter-page image capture.

        The chapter page's `/api/v1/chapters/{id}` response is signed +
        encrypted (`{"e": "..."}`) and Python can't reproduce/decrypt it, so
        drive the browser to render the chapter and scrape the page URLs. Pages
        are plain <img> webp CDN URLs now (comix dropped the tile-scramble); a
        legacy <canvas> branch remains as a fallback — see
        _ComixBrowserSession.fetch_chapter_images_via_dom for the details.

        Default 300 s budget covers ~126-page chapters; a typical chapter takes
        ~1-2 s per page (scroll + render wait). Bump this for chapters that
        exceed the budget. Inner deadline + 30 s outer cap matches
        fetch_chapters_via_dom. Populates sites/image_cache.py with page bytes;
        aio-dl.py:dl_image reads real CDN URLs from there, and canvas-captured
        pages via synthetic `comix-page://<chap_id>/<NNNN>.webp` keys.
        """
        return _comix_call(
            "fetch_chapter_images_via_dom",
            chapter_url,
            time_budget_s,
            _timeout_s=time_budget_s + 30.0,
        )

    def close(self) -> None:
        try:
            _comix_call("close", _timeout_s=5.0)
        except Exception:
            pass


_COMIX_BROWSER_BRIDGE = _ComixBrowserBridge()


def _shutdown_comix_bridge():
    """At-exit best-effort cleanup. Daemon worker dies with the
    interpreter regardless (the whole reason for the daemon+queue
    rewrite), so the goal here is just to close the Patchright session
    cleanly when there's time. We enqueue the shutdown sentinel and
    rely on the daemon to drain — no join, no wait."""
    if not _COMIX_WORKER_STARTED:
        return
    try:
        _COMIX_REQUEST_QUEUE.put_nowait(_COMIX_SHUTDOWN_SENTINEL)
    except queue.Full:
        # The unbounded queue can't actually go full here; the except
        # is defensive belt-and-suspenders in case the queue is ever
        # given a maxsize. Silent drop matches the rest of the bridge's
        # at-exit semantics.
        pass


atexit.register(_shutdown_comix_bridge)
