from __future__ import annotations

import builtins as _builtins
import json
import os
import re
import sys
import time

import random


# All bare print() calls in this module emit to stderr by default. Why: this
# handler's get_chapters / get_chapter_images log progress + retry/VRF state
# via plain print(). When called from the orchestrator's search-time image-
# quality probe path (sites/search_orchestrator.py:_probe_one), that chatter
# would land in stdout — which carries the JSON --search output for piped
# consumers. This shim keeps stdout clean without touching every print site.
# Explicit file= overrides still work (e.g., pass file=sys.stdout to opt out).
def _stderr_print(*args, **kwargs):
    kwargs.setdefault("file", sys.stderr)
    return _builtins.print(*args, **kwargs)


print = _stderr_print  # noqa: A001 — intentional shadow of builtins.print

# Cache throttle delays at module load – these env vars don't change at runtime.
# Reading os.getenv on every throttle call adds unnecessary overhead.
_MF_DELAY_REQUEST: float = 0.0
_MF_DELAY_CHAPTER: float = 0.0
try:
    _MF_DELAY_REQUEST = float(os.getenv("MANGAFIRE_DELAY_REQUEST", "0.0"))
except Exception:
    pass
try:
    _MF_DELAY_CHAPTER = float(os.getenv("MANGAFIRE_DELAY_CHAPTER", "0.0"))
except Exception:
    pass

def _mf_throttle(tag: str = "request") -> None:
    """Optional jittered delay to reduce burstiness when MangaFire/Cloudflare is sensitive.

    Env vars (read once at import):
      - MANGAFIRE_DELAY_REQUEST (seconds, default 0.0)
      - MANGAFIRE_DELAY_CHAPTER (seconds, default 0.0)
    """
    base = _MF_DELAY_CHAPTER if tag == "chapter" else _MF_DELAY_REQUEST
    if base <= 0:
        return
    time.sleep(base * random.uniform(0.7, 1.3))

from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseSiteHandler, SearchHit, SiteComicContext
from ._image_io import finalize_pending_image

try:
    from .mangafire_vrf_simple import get_vrf_generator
    VRF_AVAILABLE = True
except Exception:
    VRF_AVAILABLE = False

# curl_cffi powers the fast image-download path. HTTP/2 multiplex over a
# single keep-alive AsyncSession + Chrome120 TLS fingerprint. ImportError
# fallback toggles SUPPORTS_FAST_DOWNLOAD off so the main loop reverts to
# its existing ThreadPoolExecutor + cloudscraper path. Pinned to >=0.7.0
# in requirements.txt for the AsyncSession API.
try:
    from curl_cffi.requests import AsyncSession as _CurlCffiAsyncSession
    _CURL_CFFI_AVAILABLE = True
except Exception:  # ImportError or any sub-dep failure
    _CURL_CFFI_AVAILABLE = False


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)).strip())
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)).strip())
    except Exception:
        return default


def _short(s: str, n: int = 240) -> str:
    s = (s or "").replace("\r", " ").replace("\n", " ")
    return s[:n] + ("…" if len(s) > n else "")


class MangaFireSiteHandler(BaseSiteHandler):
    name = "mangafire"
    domains = ("mangafire.to",)
    # MangaFire's per-chapter fetch needs a Playwright VRF capture (~3-5s
    # per chapter) on top of the actual image downloads. The orchestrator's
    # search-phase probe runs this for every match, including low-confidence
    # ones (spinoffs, doujinshi, wrong series sharing a token). Flagging
    # EXPENSIVE_PROBE=True lets the orchestrator clamp low-title-match
    # results to a single image sample instead of the usual 5 — saving 4
    # image fetches × N noise results per search. See
    # search_orchestrator.py:EXPENSIVE_PROBE_QUICK_THRESHOLD.
    EXPENSIVE_PROBE = True

    # Class-level capability flag picked up by aio-dl.py's chapter loop. When
    # True (and curl_cffi is importable), Phase 2 of _process_chapter_impl and
    # the inter-chapter image prefetch route through fast_download_images
    # (curl_cffi async + HTTP/2) instead of the generic ThreadPoolExecutor +
    # dl_image cloudscraper path. Bench (2026-05-09, 83-page chapter):
    # cloudscraper 3-thread = 10.20s; curl_cffi async @ conc=8 = 6.04s. The
    # ceiling is the local network bandwidth (~5 MB/s on this test network);
    # higher concurrency past ~12 is diminishing returns. Toggled off if
    # curl_cffi failed to import — main loop falls back gracefully.
    SUPPORTS_FAST_DOWNLOAD = _CURL_CFFI_AVAILABLE

    _BASE_URL = "https://mangafire.to"

    # Retry knobs (fixed delays; no exponential backoff)
    _JSON_RETRIES = _env_int("MANGAFIRE_JSON_RETRIES", 3)
    _JSON_RETRY_DELAY = _env_float("MANGAFIRE_JSON_RETRY_DELAY", 3.0)
    _VRF_RETRIES = _env_int("MANGAFIRE_CHAPTER_VRF_RETRIES", 3)
    _VRF_RETRY_DELAY = _env_float("MANGAFIRE_CHAPTER_VRF_RETRY_DELAY", 3.0)

    def configure_session(self, scraper, args) -> None:
        scraper.headers.update(
            {
                "Referer": self._BASE_URL + "/",
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                "X-Requested-With": "XMLHttpRequest",
            }
        )

    def _make_soup(self, html: str) -> BeautifulSoup:
        return BeautifulSoup(html, "html.parser")

    def _extract_id_from_url(self, url: str) -> str:
        # URL format: https://mangafire.to/manga/name.id
        path = urlparse(url).path
        if "." in path:
            return path.split(".")[-1]
        return ""

    def _resp_diag(self, response) -> str:
        """A compact diagnostic string for logging."""
        try:
            status = getattr(response, "status_code", None)
        except Exception:
            status = None
        try:
            ctype = response.headers.get("content-type", "")
        except Exception:
            ctype = ""
        try:
            text = response.text or ""
        except Exception:
            text = ""
        head = _short(text, 180)
        return f"status={status} ctype={_short(ctype, 60)} body='{head}'"

    def _safe_json(self, response, *, label: str, url: str) -> Optional[Dict]:
        """Parse JSON with a clear log if it fails (often the server returns HTML while status=200)."""
        try:
            return response.json()
        except Exception as e:
            print(f"[!] {label}: JSON decode failed for {url}: {e}")
            print(f"    {self._resp_diag(response)}")
            return None

    def fetch_comic_context(self, url: str, scraper, make_request) -> SiteComicContext:
        _mf_throttle('request')

        # If the caller passed a /read/<slug>... URL (chapter reader URL,
        # possibly truncated to just /read/<slug>), rewrite it to the series
        # URL (/manga/<slug>) BEFORE the HTTP fetch. The chapter reader page
        # doesn't render h1[itemprop=name] so title extraction would return
        # "Unknown Title" — which then propagates to the aio-dl.py header
        # printout (the UI's queue-text source), file naming, multi-source
        # search, etc. _extract_id_from_url's path.split('.')[-1] gives the
        # same hid for both URL forms, so the manga_id stays consistent.
        # Mirror of the same rewrite in mangafire_vrf_simple.capture_series_meta.
        _read_url_match = re.match(
            r"^https?://(?:www\.)?mangafire\.to/read/([^/?#]+)",
            url,
            re.IGNORECASE,
        )
        if _read_url_match:
            url = f"https://mangafire.to/manga/{_read_url_match.group(1)}"

        response = make_request(url, scraper)

        # MangaFire sometimes returns JSON-wrapped HTML
        html_content = response.text
        try:
            from .crawlee_utils import ZENDRIVER_AVAILABLE, fetch_html_with_cf_cookies, is_cf_challenge

            if ZENDRIVER_AVAILABLE and is_cf_challenge(response.status_code, html_content):
                html_content = fetch_html_with_cf_cookies(url, base_url=self._BASE_URL)
        except Exception:
            pass
        if html_content.strip().startswith("{"):
            try:
                data = response.json()
                if data.get("status") == 200 and "result" in data:
                    html_content = data["result"]
            except Exception:
                pass  # Not JSON, use as-is

        soup = self._make_soup(html_content)

        manga_id = self._extract_id_from_url(url)

        title_node = soup.select_one("h1[itemprop='name']")
        title = title_node.get_text(strip=True) if title_node else "Unknown Title"

        cover_node = soup.select_one(".poster img[itemprop='image']")
        cover = cover_node.get("src") if cover_node else None

        desc = None
        desc_modal = soup.select_one("#synopsis")
        if desc_modal:
            close_btn = desc_modal.select_one(".modal-close")
            if close_btn:
                close_btn.decompose()
            desc = desc_modal.get_text(strip=True)
        else:
            desc_node = soup.select_one(".description")
            if desc_node:
                desc = desc_node.get_text(strip=True)

        status = None
        status_node = soup.select_one(".info p")
        if status_node:
            status_text = status_node.get_text(strip=True)
            if status_text in ["Releasing", "Ongoing"]:
                status = "Ongoing"
            elif status_text in ["Completed", "Finished"]:
                status = "Completed"
            else:
                status = status_text

        authors: List[str] = []
        for author_link in soup.select(".meta a[itemprop='author']"):
            author_name = author_link.get_text(strip=True)
            if author_name:
                authors.append(author_name)

        genres: List[str] = []
        for div in soup.select(".meta div"):
            span = div.select_one("span")
            if span and "Genres:" in span.get_text():
                for genre_link in div.select("a[href^='/genre/']"):
                    g = genre_link.get_text(strip=True)
                    if g:
                        genres.append(g)
                break

        comic = {
            "hid": manga_id,
            "title": title,
            "desc": desc,
            "cover": cover,
            "authors": authors,
            "genres": genres,
            "status": status,
            "url": url,
        }
        return SiteComicContext(comic=comic, title=title, identifier=manga_id, soup=soup)

    # ----------------------------- Chapters -----------------------------

    def get_chapters(self, context: SiteComicContext, scraper, language: str, make_request) -> List[Dict]:
        manga_id = context.identifier
        if not manga_id:
            return []

        lang_code = language if language else "en"

        # Primary endpoint (VRF-protected):
        # https://mangafire.to/ajax/read/{id}/chapter/{lang}?vrf=...
        read_ajax_path = f"/ajax/read/{manga_id}/chapter/{lang_code}"
        read_ajax_url = self._BASE_URL + read_ajax_path

        if VRF_AVAILABLE:
            try:
                vrf_gen = get_vrf_generator()
                init_reader_url = f"{self._BASE_URL}/read/manga.{manga_id}/{lang_code}/chapter-1"
                vrf = vrf_gen.ensure_vrf(read_ajax_path, init_url=init_reader_url)
                read_ajax_url = f"{read_ajax_url}?vrf={vrf}"
            except Exception as e:
                print(f"[!] Chapter list VRF failed: {e}")
                print("    (continuing without VRF; fallback endpoint may still work)")

        # Try read endpoint (with IDs)
        try:
            print(f"[*] Fetching chapters from: {read_ajax_url}")
            _mf_throttle('request')
            data = None
            if VRF_AVAILABLE:
                try:
                    resp_text = vrf_gen.fetch_ajax(read_ajax_url)
                    if resp_text:
                        data = json.loads(resp_text)
                except Exception as e:
                    print(f"[-] Playwright fetch_ajax chapter list warning: {e}")
            if not data:
                resp = make_request(read_ajax_url, scraper)
                data = self._safe_json(resp, label="chapter-list", url=read_ajax_url)
            if not data or data.get("status") != 200:
                raise RuntimeError(f"status={None if not data else data.get('status')}")

            html_content = None
            result = data.get("result")
            if isinstance(result, dict):
                html_content = result.get("html") or result.get("result") or result.get("data")
            elif isinstance(result, str):
                html_content = result
            if not html_content:
                raise RuntimeError("missing result HTML")

            soup = self._make_soup(html_content)
            chapters: List[Dict] = []
            # Phase 1 dedupe: MangaFire's chapter list HTML often contains
            # multiple <a data-id> rows for the same chapter — one row per
            # scanlation group / language variant / re-upload. They all share
            # the same data-number. Without dedupe, MangaFire's chapter count
            # gets inflated 2-3× over reality (e.g., Talentless Nana reports
            # 362 entries vs ~118 actual main chapters), which then poisons
            # both the per-source coverage display AND the alignment-anchor
            # selection in chapter_merger (anchor-by-largest-set picks
            # MangaFire even when other sources have the truer chapter list).
            #
            # Strategy: keep the first <a data-id> per data-number. MangaFire
            # serves rows ordered by group popularity, so the first one is
            # typically the most-viewed translation — best heuristic match
            # for "the" canonical chapter when we have to pick one.
            seen_numbers: set = set()
            for a in soup.select("a[data-id]"):
                chap_id = a.get("data-id")
                if not chap_id:
                    continue
                chap_num = a.get("data-number") or a.get("data-num") or a.get("data-chapter")
                dedupe_key = (chap_num or "").strip()
                if dedupe_key:
                    if dedupe_key in seen_numbers:
                        continue
                    seen_numbers.add(dedupe_key)
                # Empty/missing data-number: keep the entry (rare anomaly;
                # silently dropping would lose data). Such rows can't be
                # deduped anyway since we have no key.
                title = a.get("title") or a.get_text(strip=True)
                href = a.get("href") or ""
                full_url = urljoin(self._BASE_URL, href)
                chapters.append(
                    {
                        "hid": chap_id,
                        "chap": chap_num,
                        "title": title,
                        "url": full_url,
                        "uploaded": 0,
                    }
                )
            if chapters:
                return chapters
            print("[!] Read endpoint returned no <a data-id> items; will fall back.")
        except Exception as e:
            print(f"[!] Read endpoint failed: {e}")

        # Fallback endpoint (often works, but lacks internal IDs)
        fallback_url = f"{self._BASE_URL}/ajax/manga/{manga_id}/chapter/{lang_code}"
        print(f"[*] Falling back to: {fallback_url}")

        try:
            _mf_throttle('request')
            resp = make_request(fallback_url, scraper)
            data = self._safe_json(resp, label="chapter-list-fallback", url=fallback_url)
            if not data or data.get("status") != 200:
                return []
            html = data.get("result")
            if not html:
                return []
            soup = self._make_soup(html)
        except Exception as e:
            print(f"[!] Fallback chapter list failed: {e}")
            return []

        chapters: List[Dict] = []
        # Phase 1 dedupe (same rationale as primary endpoint above) — fallback
        # /ajax/manga path occasionally also returns duplicate rows when the
        # series has multiple language editions queued.
        seen_numbers: set = set()
        for li in soup.select("li.item"):
            a_tag = li.select_one("a")
            if not a_tag:
                continue
            chap_num = li.get("data-number")
            dedupe_key = (chap_num or "").strip() if isinstance(chap_num, str) else (str(chap_num) if chap_num is not None else "")
            if dedupe_key:
                if dedupe_key in seen_numbers:
                    continue
                seen_numbers.add(dedupe_key)
            href = a_tag.get("href") or ""
            title = a_tag.get("title") or a_tag.get_text(strip=True)
            full_url = urljoin(self._BASE_URL, href)
            chapters.append({"hid": chap_num, "chap": chap_num, "title": title, "url": full_url, "uploaded": 0})
        return chapters

    # ----------------------------- Images -----------------------------

    def _parse_images_from_result(self, result) -> List[str]:
        # result can be str(html) or dict(json)
        if isinstance(result, dict):
            images = result.get("images") or result.get("pages") or []
            if images and isinstance(images[0], list):
                images = [img[0] if isinstance(img, list) and img else img for img in images]
            return [u for u in images if isinstance(u, str) and u]

        if isinstance(result, str):
            soup = self._make_soup(result)
            images: List[str] = []

            for img in soup.select("img[data-url]"):
                u = img.get("data-url")
                if u:
                    images.append(u)

            if not images:
                for img in soup.select("img.page-img, img.img-fluid"):
                    u = img.get("src") or img.get("data-src")
                    if u:
                        images.append(u)

            if not images:
                # Look for inline JSON arrays in scripts
                for script in soup.find_all("script"):
                    st = script.string
                    if not st:
                        continue
                    if ("images" in st) or ("pages" in st):
                        m = re.search(r"(?:images|pages)\s*[:=]\s*(\[[^\]]+\])", st)
                        if m:
                            try:
                                arr = json.loads(m.group(1))
                                if isinstance(arr, list):
                                    images = [x[0] if isinstance(x, list) and x else x for x in arr]
                                    images = [u for u in images if isinstance(u, str) and u]
                                    break
                            except Exception:
                                continue

            return images

        return []

    def get_chapter_images(self, chapter: Dict, scraper, make_request) -> List[str]:
        if not VRF_AVAILABLE:
            raise NotImplementedError(
                "MangaFire image downloading requires Patchright for VRF generation. "
                "Install with: pip install patchright && python -m patchright install chromium"
            )

        chapter_id = chapter.get("hid")
        chapter_url = chapter.get("url")
        if not chapter_id:
            print("[!] Chapter missing ID; cannot fetch images.")
            return []

        ajax_path = f"/ajax/read/chapter/{chapter_id}"
        ajax_url_base = self._BASE_URL + ajax_path

        vrf_gen = get_vrf_generator()

        last_err: Optional[Exception] = None

        for attempt in range(1, self._JSON_RETRIES + 1):
            stage = "start"
            try:
                # 1) VRF
                stage = "vrf"
                if chapter_url:
                    # The actual capture path (in-page fetch vs navigation) is
                    # decided inside ensure_vrf and logged with its own per-
                    # attempt diagnostic lines — don't pre-claim "navigation".
                    print(f"[*] Capturing chapter VRF for: {chapter_url}")
                    vrf = vrf_gen.ensure_vrf(ajax_path, page_url=chapter_url, init_url=chapter_url)
                else:
                    vrf = vrf_gen.ensure_vrf(ajax_path)
                ajax_url = f"{ajax_url_base}?vrf={vrf}"

                # 2) AJAX fetch
                stage = "ajax"
                print(f"[*] Fetching images for chapter {chapter_id} (attempt {attempt}/{self._JSON_RETRIES})…")
                _mf_throttle('request')
                resp_text = None
                try:
                    resp_text = vrf_gen.fetch_ajax(ajax_url)
                except Exception as e:
                    print(f"[-] Playwright fetch_ajax warning: {e}")

                # 3) JSON parse
                stage = "json"
                if resp_text:
                    try:
                        data = json.loads(resp_text)
                    except Exception as e:
                        raise RuntimeError(f"fetch_ajax JSON decode failed: {e}")
                else:
                    resp = make_request(ajax_url, scraper)
                    data = self._safe_json(resp, label=f"chapter-{chapter_id}", url=ajax_url)
                if not data:
                    raise RuntimeError("non-json response")

                if data.get("status") != 200:
                    raise RuntimeError(f"api status={data.get('status')}")

                # 4) parse result
                stage = "parse"
                result = data.get("result")
                images = self._parse_images_from_result(result)
                if not images:
                    raise RuntimeError("parsed 0 images from result")

                # Rewrite malfunctioning CDN servers to working mirrors (e.g. k99.*)
                rewritten_images = []
                for img_url in images:
                    if "mfcdn" in img_url:
                        # Rewrite nw8.mfcdn[number].xyz to k99.mfcdn[number].xyz
                        img_url = re.sub(r'https://nw8\.mfcdn([0-9])\.xyz/', r'https://k99.mfcdn\1.xyz/', img_url)
                        # Rewrite legacy/forbidden CDNs (e.g. nw8.mfcdn.nl, nw8.mfcdn.net, fmcdn.mfcdn.net) to k99.mfcdn3.xyz
                        img_url = img_url.replace("https://nw8.mfcdn.nl/", "https://k99.mfcdn3.xyz/")
                        img_url = img_url.replace("https://nw8.mfcdn.net/", "https://k99.mfcdn3.xyz/")
                        img_url = img_url.replace("https://fmcdn.mfcdn.net/", "https://k99.mfcdn3.xyz/")
                        img_url = img_url.replace("https://static.mfcdn.nl/", "https://k99.mfcdn3.xyz/")
                    rewritten_images.append(img_url)

                return rewritten_images


            except Exception as e:
                last_err = e
                print(f"[!] Chapter {chapter_id} attempt {attempt}/{self._JSON_RETRIES} failed at stage={stage}: {e}")
                if attempt < self._JSON_RETRIES:
                    time.sleep(self._JSON_RETRY_DELAY)
                    continue
                break

        # Final: help debugging
        print(f"[!] Giving up on chapter {chapter_id}. Last error: {last_err}")
        try:
            if hasattr(vrf_gen, "dump_state"):
                vrf_gen.dump_state()
        except Exception:
            pass
        return []

    # ----------------------------- Probe -----------------------------
    def _probe_cover_image(self, hit, scraper, make_request):
        """MangaFire-specific cover fallback. Strips the @<digits>
        thumbnail-size suffix so we fetch the full available cover
        rather than the search-card 100px thumbnail.

        MangaFire serves cover thumbnails at URLs like
            https://static.mfcdn.nl/<hash>/...<filename>@100.jpg
        where '@100' is a 100px-width thumbnail hint. The underlying CDN
        ignores the size token (all variants return the same 280×400
        image) so removing it at least gets us the full cover.

        Note: this is the cover-FALLBACK path. BaseSiteHandler.probe_sample_image
        first calls _probe_chapter_image which uses our get_chapter_images
        (VRF-protected) for an accurate chapter-image measurement — that's
        the preferred signal. Cover only fires when chapter-fetch fails (CF
        challenge on series page, VRF init failure, Playwright unavailable).
        Even with the @<digits> strip, cover stays at 280×400 which
        underranks MangaFire vs MangaDex/MangaReader covers — so the chapter
        path winning is important. Cross-file: search() returns hit.cover
        with the @100 suffix straight from the autocomplete payload.
        """
        if not hit or not getattr(hit, "cover", None):
            return None
        cover_url = hit.cover
        # Strip @<digits> tokens immediately before the file extension.
        cleaned = re.sub(r"@\d+(\.\w+)$", r"\1", cover_url)
        try:
            response = scraper.get(cleaned, timeout=10)
            if response.status_code >= 400:
                return None
            data = response.content
            if not data or len(data) < 256:
                return None
            return data
        except Exception:
            return None

    # ----------------------------- Fast image download path -----------------
    # Bulk chapter-image fetch via curl_cffi async + HTTP/2 + Chrome120 TLS
    # impersonation. Replaces the generic dl_image+ThreadPoolExecutor path in
    # aio-dl.py:_process_chapter_impl and _start_image_prefetch._worker for
    # MangaFire only (gated by SUPPORTS_FAST_DOWNLOAD).
    #
    # Why curl_cffi: bench shows ~1.7x faster than cloudscraper 3-thread on
    # an 83-page chapter (10.20s -> 6.04s). The win is HTTP/2 multiplex over
    # one keep-alive TLS session — eliminates per-page handshake. CF edge
    # cache (cf-cache=HIT for repeated chapters) means the bandwidth ceiling
    # is the user's network, not the origin server.
    #
    # No URL-variant cascade: tested live 2026-05-09 — alternative path
    # segments (/o/, /full/, /orig/) and extensions (.png, .webp) all 404 on
    # the image CDN. The first URL works or it doesn't. One transient retry
    # on hard failure; on second failure return None for that page so the
    # caller's per-chapter zero-tolerance check fires the inline-retry path.
    #
    # Cancellation + host-poison: caller passes callbacks so this method
    # stays decoupled from aio-dl.py's module globals. is_cancelled() short-
    # circuits in-flight fetches; record_host_failure(host, url) feeds
    # aio-dl's _HOST_FAIL_COUNT so the chapter watchdog can fast-fail when a
    # CDN is poisoned for this run.
    def fast_download_images(
        self,
        download_tasks: List[Tuple[int, str, str, str]],
        *,
        concurrency: int = 8,
        timeout: float = 30.0,
        is_cancelled: Optional[Callable[[], bool]] = None,
        record_host_failure: Optional[Callable[[str, str], None]] = None,
    ) -> List[Tuple[int, Optional[str]]]:
        """Bulk-download chapter images via curl_cffi async + HTTP/2.

        Args:
          download_tasks: list of (page_index, url, folder, filename) tuples,
                          same shape aio-dl.py constructs in Phase 1. The
                          filename is a base placeholder like "5_0001.jpg";
                          finalize_pending_image rewrites the extension based
                          on actual bytes.
          concurrency:    asyncio.Semaphore bound. 8 is the bench-stable
                          default. Past ~12 is diminishing returns on most
                          home networks (network-bandwidth-limited).
          timeout:        Per-request socket timeout. 30s matches aio-dl.py's
                          default _HTTP_TIMEOUT.
          is_cancelled:   Optional callback. When True, every in-flight fetch
                          checks before sending the next request and bails.
          record_host_failure: Optional callback fired when a URL hard-fails.
                          Updates aio-dl's _HOST_FAIL_COUNT so the chapter
                          watchdog can poison-detect a flaky CDN.

        Returns: list of (page_index, path_or_None), ordered by page_index.
        path_or_None matches dl_image's contract — None signals failure.
        """
        if not _CURL_CFFI_AVAILABLE:
            raise RuntimeError(
                "fast_download_images called without curl_cffi installed. "
                "Caller should check SUPPORTS_FAST_DOWNLOAD before invoking."
            )
        if not download_tasks:
            return []

        import asyncio

        # Headers: anti-hotlink Referer + Chrome UA matching the Patchright
        # session's UA (so cf_clearance fingerprint stays consistent if CF
        # ever starts cookie-validating image hits — currently they're
        # cookieless edge-cache HITs, but be defensive).
        headers = {
            "Referer": self._BASE_URL + "/",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
        }

        # Helper to rewrite malfunctioning CDN servers to working mirrors (e.g. k99.*)
        def rewrite_cdn_url(url: str) -> str:
            if "mfcdn" not in url:
                return url
            # Rewrite nw8.mfcdn[number].xyz to k99.mfcdn[number].xyz
            url = re.sub(r'https://nw8\.mfcdn([0-9])\.xyz/', r'https://k99.mfcdn\1.xyz/', url)
            # Rewrite legacy/forbidden CDNs (e.g. nw8.mfcdn.nl, nw8.mfcdn.net, fmcdn.mfcdn.net) to k99.mfcdn3.xyz
            url = url.replace("https://nw8.mfcdn.nl/", "https://k99.mfcdn3.xyz/")
            url = url.replace("https://nw8.mfcdn.net/", "https://k99.mfcdn3.xyz/")
            url = url.replace("https://fmcdn.mfcdn.net/", "https://k99.mfcdn3.xyz/")
            url = url.replace("https://static.mfcdn.nl/", "https://k99.mfcdn3.xyz/")
            return url

        # Rewrite URLs in the download tasks list
        rewritten_tasks = []
        for p_idx, url, folder, name in download_tasks:
            rewritten_tasks.append((p_idx, rewrite_cdn_url(url), folder, name))
        download_tasks = rewritten_tasks

        async def _fetch_one(

            session, sema, page_idx: int, url: str, folder: str, filename: str
        ) -> Tuple[int, Optional[str]]:
            base, _ = os.path.splitext(filename)
            if not base:
                base = filename
            pending_path = os.path.join(folder, f".pending_{base}")
            host = urlparse(url).netloc

            # Two attempts: original + one retry on transient failure. No
            # variant cascade — alternates don't exist on this CDN.
            for attempt in range(2):
                if is_cancelled is not None and is_cancelled():
                    return page_idx, None
                async with sema:
                    # Re-check after sema acquire — coroutines that were
                    # queued before cancel was set should still bail here
                    # rather than firing a GET they were already cancelled
                    # for. (Without this, large queues + late cancel = the
                    # remaining tail still issues HTTP requests.)
                    if is_cancelled is not None and is_cancelled():
                        return page_idx, None
                    try:
                        r = await session.get(url, headers=headers, timeout=timeout)
                    except Exception as exc:
                        print(f"[-] curl_cffi exception: {exc} for URL: {url}")
                        if attempt < 1:
                            await asyncio.sleep(1.0)
                            continue
                        if record_host_failure is not None:
                            try:
                                record_host_failure(host, url)
                            except Exception:
                                pass
                        return page_idx, None
                if r.status_code != 200 or not r.content or len(r.content) < 256:
                    print(f"[-] curl_cffi status={r.status_code} size={len(r.content) if r.content else 0} for URL: {url}")
                    if attempt < 1:
                        await asyncio.sleep(1.0)
                        continue
                    if record_host_failure is not None:
                        try:
                            record_host_failure(host, url)
                        except Exception:
                            pass
                    return page_idx, None
                # Bytes look real — write pending file then atomic-rename.
                # finalize_pending_image runs sync; safe inside the coroutine
                # because file I/O is the same cost either way.
                try:
                    os.makedirs(folder, exist_ok=True)
                    with open(pending_path, "wb") as fh:
                        fh.write(r.content)
                except OSError:
                    return page_idx, None
                content_type = ""
                try:
                    content_type = r.headers.get("Content-Type", "") or ""
                except Exception:
                    content_type = ""
                final = finalize_pending_image(
                    pending_path, folder, base, content_type
                )
                return page_idx, final
            return page_idx, None

        async def _run() -> List[Tuple[int, Optional[str]]]:
            sema = asyncio.Semaphore(max(1, int(concurrency)))
            # Single AsyncSession across all pages of this chapter so HTTP/2
            # multiplex + connection keepalive amortize TLS handshake cost.
            # impersonate=chrome120 sets the JA3/JA4 + h2 settings frame to
            # match Chrome — should not strictly be needed for the cookieless
            # edge-cached image CDN, but defensive (and free).
            async with _CurlCffiAsyncSession(impersonate="chrome120") as s:
                tasks = [
                    _fetch_one(s, sema, p_idx, url, folder, name)
                    for p_idx, url, folder, name in download_tasks
                ]
                return await asyncio.gather(*tasks)

        # Run in this thread's own event loop. asyncio.run constructs a fresh
        # loop, so works whether called from main thread or from a daemon
        # prefetch thread (each has no running loop).
        results = asyncio.run(_run())
        # Preserve original submission order (page_idx ascending). gather()
        # already returns in input order, but sorting is cheap insurance.
        results.sort(key=lambda t: t[0])
        return results

    # ----------------------------- Search -----------------------------
    # MangaFire search: driven by the persistent Playwright bridge in
    # mangafire_vrf_simple.py:capture_search.
    #
    # Why not /filter?keyword= via cloudscraper?
    #   /filter is CF-WAF-blocked for HTTP scrapers (verified 2026-05-06:
    #   cloudscraper, curl_cffi-Chrome131..133, edge101 all return 403).
    #   /ajax/manga/search is also blocked when called directly because the
    #   site's bot defenses gate it on a VRF token that's only minted by the
    #   typeahead's keyup handler bound to .search-inner input[name=keyword].
    #   Mirrors the keiyoushi/extensions-source PR #11396 strategy: drive the
    #   live JS, capture the XHR, parse its result.html.
    #
    # Why not the canonical /filter UI scrape?
    #   The autocomplete payload (used here) is richer: it includes chapter
    #   count + status badges per result, which feed our Phase 4 DMCA-detection
    #   heuristics. /filter's full results page would only buy us ~30 entries
    #   vs autocomplete's ~5-8 — but the top entries are what matter for
    #   title-match scoring anyway.
    #
    # Returns [] when Playwright isn't available — matches the existing
    # VRF_AVAILABLE guard pattern. Errors that indicate "the host is broken
    # right now" raise so the orchestrator's probe-failure cache catches them.
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
        if not VRF_AVAILABLE:
            # Playwright not installed → graceful no-op. Orchestrator's
            # probe-failure cache treats this as a no-result, not a failure.
            return []

        # capture_search may raise on bridge/browser/CF problems; let it
        # propagate so the orchestrator's _run_one catches and caches.
        vrf_gen = get_vrf_generator()
        payload = vrf_gen.capture_search(clean)

        result = (payload or {}).get("result") or {}
        html = result.get("html") or ""
        if not html:
            return []

        soup = self._make_soup(html)
        # Autocomplete cards: <a class="unit" href="/manga/<slug>.<id>">
        #   .poster img[src]      -> cover
        #   .info h6              -> title
        #   .info span (multiple) -> status, "Chap N", "Vol N" (in that order;
        #                            we extract Chap N as chapter_count_hint
        #                            for the Phase 4 DMCA-detection compare).
        result_re = re.compile(r"^/manga/[\w\-]+\.\w+")
        anchors = soup.select("a.unit[href]")
        hits: List[SearchHit] = []
        seen: set = set()
        for idx, a in enumerate(anchors):
            if len(hits) >= limit:
                break
            href = (a.get("href") or "").strip()
            if not result_re.match(href):
                continue
            abs_url = urljoin(self._BASE_URL, href).split("?")[0].split("#")[0]
            if abs_url in seen:
                continue
            seen.add(abs_url)

            title_node = a.select_one(".info h6, .info .title, h6, h3")
            title = title_node.get_text(strip=True) if title_node else ""
            if not title:
                continue

            cover: Optional[str] = None
            img = a.select_one(".poster img, img")
            if img is not None:
                src = img.get("data-src") or img.get("src")
                if src:
                    cover = src if src.startswith("http") else urljoin(self._BASE_URL, src)

            chapter_count_hint: Optional[int] = None
            for span in a.select(".info span"):
                text = span.get_text(strip=True)
                m = re.match(r"(?:Chap|Chapter)\s*([\d.]+)", text, re.I)
                if m:
                    try:
                        chapter_count_hint = int(float(m.group(1)))
                    except ValueError:
                        pass
                    break

            raw_score = max(0.05, 1.0 - (idx / max(1, len(anchors))))
            hits.append(
                SearchHit(
                    site=self.name,
                    title=title,
                    url=abs_url,
                    cover=cover,
                    alt_titles=[],
                    year=None,
                    language=language if language and language.lower() != "all" else None,
                    chapter_count_hint=chapter_count_hint,
                    raw_score=raw_score,
                )
            )
        return hits
