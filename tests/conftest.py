"""Shared pytest fixtures + sys.path bootstrap.

Adds the project root to sys.path so `from sites.chapter_merger import ...`
works when running pytest from the project root. We can't rely on the
package being installed via pip — the project ships as a single-file
script (`aio-dl.py`) plus the `sites/` package in-place.
"""

from __future__ import annotations

import os
import sys

# Project root = parent of this tests/ directory.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# No test may launch a browser. mangafire.to signs every /api/* call with a
# `vrf=` token minted by driving Chromium (sites/mangafire_vrf.py), so ANY test
# that calls a MangaFire handler method would otherwise boot a real browser and
# hit the network — silently passing on a dev machine and failing in CI, where
# no browser binary is installed. Tests that need signing to succeed must stub
# `mangafire_vrf.sign_api_query` (see tests/test_mangafire_vrf.py's fake_signer
# fixture and the MangaFire cases in tests/test_komikku_metadata.py).
os.environ["AIO_MANGAFIRE_NO_SIGNER"] = "1"
