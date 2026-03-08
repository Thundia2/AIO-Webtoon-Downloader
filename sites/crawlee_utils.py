"""Anti-bot fetch utilities for bot-protected sites.

Two strategies are provided:
1. impit (Chrome/Firefox TLS impersonation, handles zstd/brotli) — fast, no browser launch.
   Use for sites that are blocked by header/fingerprint checks but serve readable HTML.
2. zendriver (CDP-based Chrome with built-in CF challenge solver) — for Cloudflare-protected
   sites. Uses zendriver's cloudflare module to interact with and solve CF challenges.

All functions are synchronous and safe to call from multiprocessing subprocesses.
zendriver is async; fetch_html_zendriver wraps it synchronously via asyncio.run().
"""

from __future__ import annotations

from typing import List, Optional
from urllib.parse import urljoin

# ---------------------------------------------------------------------------
# impit — fast TLS/browser impersonation (part of crawlee's dependency set)
# ---------------------------------------------------------------------------

try:
    import impit as _impit
    IMPIT_AVAILABLE = True
except ImportError:
    IMPIT_AVAILABLE = False


def fetch_html_impit(
    url: str,
    browser: str = "chrome",
    headers: Optional[dict] = None,
    timeout: float = 20.0,
) -> str:
    """Fetch a URL using impit (Chrome/Firefox TLS fingerprint impersonation).

    Handles zstd, brotli, and gzip compression transparently.
    Much faster than Camoufox (no browser launch), but cannot execute JS.

    Args:
        url: Page URL to fetch.
        browser: Browser to impersonate ('chrome' or 'firefox').
        headers: Extra headers to send.
        timeout: Request timeout in seconds.

    Returns:
        Full page HTML string.

    Raises:
        RuntimeError: If impit is not installed or the request fails.
    """
    if not IMPIT_AVAILABLE:
        raise RuntimeError("impit is not installed (should be part of crawlee)")
    client = _impit.Client(browser=browser, follow_redirects=True, timeout=timeout)
    resp = client.get(url, headers=headers or {})
    resp.raise_for_status()
    return resp.text


# ---------------------------------------------------------------------------
# zendriver — CF cookie capture strategy
#
# Strategy: launch a real (non-headless) Chrome once per domain to solve the
# Cloudflare Managed Challenge and capture the resulting cookies
# (primarily `cf_clearance` + `__cf_bm`).  Those cookies are then injected
# into a plain requests.Session so that all subsequent page/image fetches
# run headlessly without re-launching a browser.
#
# Cookie cache: {domain -> {"cookies": [...], "user_agent": str, "ts": float}}
# Cookies are reused until they expire (cf_clearance lasts ~30 min).
# ---------------------------------------------------------------------------

try:
    import zendriver as _zd
    ZENDRIVER_AVAILABLE = True
except ImportError:
    ZENDRIVER_AVAILABLE = False

import threading as _threading
import time as _time
from urllib.parse import urlparse as _urlparse

_cf_cookie_cache: dict = {}          # domain -> {cookies, user_agent, ts}
_cf_cookie_lock = _threading.Lock()
_CF_COOKIE_TTL = 25 * 60             # 25 minutes (cf_clearance lasts ~30 min)


async def _solve_cf_async(url: str) -> dict:
    """Open a visible Chrome, solve CF challenge, return {cookies, user_agent}."""
    from zendriver.core.cloudflare import cf_is_interactive_challenge_present, verify_cf

    browser = await _zd.start(headless=False)
    try:
        page = await browser.get(url)
        if await cf_is_interactive_challenge_present(page, timeout=10):
            await verify_cf(page, timeout=30)
        # Wait briefly for any post-challenge redirects to settle
        await _asyncio.sleep(1)
        raw_cookies = await browser.cookies.get_all()
        ua = await page.evaluate("navigator.userAgent")
        cookies = [
            {"name": c.name, "value": c.value, "domain": c.domain, "path": c.path}
            for c in raw_cookies
        ]
        return {"cookies": cookies, "user_agent": ua}
    finally:
        await browser.stop()


def get_cf_session(base_url: str) -> "requests.Session":
    """Return a requests.Session pre-loaded with valid CF cookies for *base_url*.

    If cached cookies are still fresh they are reused; otherwise a visible
    Chrome window opens, solves the CF challenge, captures cookies, then closes.
    All subsequent requests through the returned session pass CF checks.

    Args:
        base_url: Any URL on the target domain (used to identify / solve CF).

    Returns:
        requests.Session with CF cookies and matching User-Agent set.

    Raises:
        RuntimeError: If zendriver is not available or the solve fails.
    """
    if not ZENDRIVER_AVAILABLE:
        raise RuntimeError("zendriver is not installed. Run: pip install zendriver")

    import requests as _requests
    global _asyncio
    import asyncio as _asyncio

    domain = _urlparse(base_url).netloc

    with _cf_cookie_lock:
        cached = _cf_cookie_cache.get(domain)
        now = _time.time()
        if cached and now - cached["ts"] < _CF_COOKIE_TTL:
            cookies = cached["cookies"]
            user_agent = cached["user_agent"]
        else:
            result = _asyncio.run(_solve_cf_async(base_url))
            cookies = result["cookies"]
            user_agent = result["user_agent"]
            _cf_cookie_cache[domain] = {"cookies": cookies, "user_agent": user_agent, "ts": now}

    session = _requests.Session()
    session.headers["User-Agent"] = user_agent
    for c in cookies:
        session.cookies.set(c["name"], c["value"], domain=c.get("domain", domain))
    return session


_CF_CHALLENGE_PHRASES = (
    "just a moment",
    "checking your browser",
    "enable javascript and cookies",
    "cf-browser-verification",
    "cloudflare ray id",
    "cf_chl_opt",
    "challenge-platform",
)

_CF_PLAIN_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def is_cf_challenge(status_code: int, text: str) -> bool:
    """Return True if the HTTP response looks like a Cloudflare challenge page.

    Checks both the status code and page content so it works regardless of
    whether CF returns 403, 503, or even 200 for the interstitial.

    Args:
        status_code: HTTP status code of the response.
        text: Response body text.

    Returns:
        True if a CF challenge / block is detected.
    """
    if status_code in (403, 429, 503):
        lower = text.lower()
        for phrase in _CF_CHALLENGE_PHRASES:
            if phrase in lower:
                return True
    # CF sometimes serves the interstitial with 200 (JS-redirect variant)
    if status_code == 200 and len(text) < 15_000:
        lower = text.lower()
        hits = sum(1 for phrase in _CF_CHALLENGE_PHRASES if phrase in lower)
        if hits >= 2:
            return True
    return False


def fetch_html_with_cf_cookies(
    url: str,
    base_url: Optional[str] = None,
    extra_headers: Optional[dict] = None,
    timeout: float = 20.0,
) -> str:
    """Fetch *url*, automatically solving Cloudflare challenges only when needed.

    Strategy:
    1. Attempt a plain requests.get() with a realistic User-Agent.
    2. If the response looks like a CF challenge (or connection error), invoke
       get_cf_session() to solve it via a visible Chrome and retry with the
       resulting cookies.
    3. Subsequent calls for the same domain reuse cached CF cookies (TTL 25 min).

    Args:
        url: Page URL to fetch.
        base_url: Override the URL used to trigger the CF solve (defaults to url).
        extra_headers: Additional headers to send.
        timeout: requests timeout in seconds.

    Returns:
        Full page HTML as a string.

    Raises:
        RuntimeError: If the fetch fails even after CF solve.
    """
    import requests as _req

    headers = {"User-Agent": _CF_PLAIN_UA}
    if extra_headers:
        headers.update(extra_headers)

    # Step 1 — plain request (fast path, no browser)
    try:
        resp = _req.get(url, headers=headers, timeout=timeout)
        if not is_cf_challenge(resp.status_code, resp.text):
            resp.raise_for_status()
            return resp.text
    except _req.RequestException:
        pass  # fall through to CF solve

    # Step 2 — CF challenge detected, solve and retry
    session = get_cf_session(base_url or url)
    if extra_headers:
        session.headers.update(extra_headers)
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.text


