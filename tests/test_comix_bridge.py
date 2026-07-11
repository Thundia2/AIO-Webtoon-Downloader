"""Smoke tests for the comix Patchright bridge (sites/comix.py).

Pre-v7 (2026-05-18) ComixSiteHandler had a main-thread guard around its
Patchright sync API usage. Worker-thread callers (the search orchestrator's
probe-phase daemon workers, aio-dl.py's image-prefetch chain) silently
returned None, which caused the probe to fall back to cover-only sampling
and skewed the img_quality_score against comix.

v7 moved all Patchright work onto a dedicated single-thread surface.
v8 (2026-05-24) replaced the ThreadPoolExecutor backend with a daemon
thread + queue.Queue so interpreter shutdown stops hanging on stuck
Patchright nav (concurrent.futures._python_exit joined workers before
atexit could close the browser) and so callers get a per-call timeout
on `_comix_call` (the previous `fut.result()` had none, deadlocking
every other bridge caller behind a single hung op). The bridge's
public API (`_COMIX_BROWSER_BRIDGE`) is unchanged across both rewrites.

2026-07-11: comix.to relaunched as a fully signed + encrypted SPA, so the old
token-capture (`get_api_token`) and encrypted-response-steal (`fetch_chapter_api`)
methods were deleted from both the handler and the bridge — the only live
Patchright work now is the chapter-list and chapter-image DOM scrapes
(`fetch_chapters_via_dom` / `fetch_chapter_images_via_dom`). See sites/comix.py.

These tests verify the bridge's contract:
  - Module-level singletons exist (request queue, worker-started flag,
    bridge, ensure-worker helper).
  - A worker-thread call (fetch_chapters_via_dom — the live chapter-list path)
    doesn't raise `RuntimeError: no running event loop`.

The tests stub the bridge/session methods (no real Patchright launch) so they
run without network or browser dependencies. A separate live-integration check
is documented in the plan file's Verification section but not run here.

Cross-file:
  - sites/comix.py (handler + bridge — under test).
  - sites/mangadex.py (sibling daemon+queue + lazy-start pattern).
  - sites/mangafire_vrf_simple.py:1965-2106 (reference idiom for the
    legacy executor-based pattern).
"""

from __future__ import annotations

import threading
from unittest.mock import patch

import pytest

from sites import comix


def test_bridge_module_singletons_exist():
    """Bridge surface should be present and well-typed.

    v8: the executor was replaced by a daemon-worker + queue, so we
    assert the new module-level symbols (request queue, worker-started
    flag, ensure-worker helper) instead of `_COMIX_EXECUTOR`.
    """
    assert hasattr(comix, "_COMIX_REQUEST_QUEUE")
    assert hasattr(comix, "_COMIX_WORKER_STARTED")
    assert hasattr(comix, "_ensure_comix_worker")
    assert hasattr(comix, "_comix_worker_loop")
    assert hasattr(comix, "_COMIX_BROWSER_BRIDGE")
    assert isinstance(comix._COMIX_BROWSER_BRIDGE, comix._ComixBrowserBridge)
    # The browser session is created lazily inside the worker thread;
    # at import time it should still be None.
    assert comix._COMIX_BROWSER is None or isinstance(
        comix._COMIX_BROWSER, comix._ComixBrowserSession
    )


def test_handler_no_longer_needs_main_thread_prefetch():
    """v7 contract: comix relies on the bridge, not the orchestrator's
    main-thread prefetch hook. NEEDS_MAIN_THREAD_PREFETCH must be False
    so search_orchestrator and aio_search_cli don't waste cycles on the
    no-op warmup path."""
    assert getattr(comix.ComixSiteHandler, "NEEDS_MAIN_THREAD_PREFETCH", False) is False


def test_bridge_callable_from_worker_thread_without_event_loop():
    """The primary regression guard: pre-v7, calling the Patchright surface
    from a worker thread raised `RuntimeError: no running event loop`.
    Post-v7, the bridge serializes the work onto its dedicated worker thread
    so the caller's thread context is irrelevant.

    Exercised via fetch_chapters_via_dom — the live chapter-list path since the
    2026-07-11 signed+encrypted SPA relaunch (token capture / API steal were
    deleted). Stubs the underlying session method so this runs without an actual
    browser launch."""
    captured: dict = {"exc": None, "result": "<unset>"}
    fake_chapters = [{"id": 1, "number": 1, "url": "https://x/1", "language": None}]

    # Patch the session method that runs on the bridge's worker thread.
    with patch.object(
        comix._ComixBrowserSession, "fetch_chapters_via_dom", return_value=fake_chapters
    ):
        def worker():
            try:
                captured["result"] = comix._COMIX_BROWSER_BRIDGE.fetch_chapters_via_dom(
                    "https://test.example/title/wt"
                )
            except Exception as e:
                captured["exc"] = e

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        t.join(timeout=10.0)

    assert captured["exc"] is None, (
        f"bridge call from worker thread raised {captured['exc']!r}; "
        f"expected the worker thread to absorb the asyncio-loop constraint"
    )
    assert captured["result"] == fake_chapters


def test_bridge_close_is_noop_safe():
    """close() must swallow exceptions so atexit shutdown never blocks
    interpreter exit even if the browser is in a degraded state."""
    # Calling close() with no real browser launched yet must not raise.
    comix._COMIX_BROWSER_BRIDGE.close()
