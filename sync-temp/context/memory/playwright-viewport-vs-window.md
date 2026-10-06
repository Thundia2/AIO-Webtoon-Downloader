---
name: playwright-viewport-vs-window
description: "Playwright/Patchright `viewport=` is CDP device-metrics EMULATION — it sets the CSS viewport regardless of OS window size, and `--window-size` is clamped to the display work area, so any window a HUMAN must use needs the EMULATED viewport shrunk to fit a real window; symptom when violated is a correctly-loaded but blank, unscrollable page"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1ec40a93-1c23-44d4-9808-6721f8b0b70f
  modified: 2026-08-03T22:28:20.297Z
---

**`viewport=` and the OS window are different things, and only one of them is
under your control.** Playwright/Patchright applies `viewport=` through CDP
`Emulation.setDeviceMetricsOverride`, so it fixes the **CSS** viewport no matter
how large the real window is — including in headed mode. `--window-size` cannot
be used to catch up: a browser window is clamped to the display work area, so on
any real monitor it resolves to "as tall as the screen" and no further.

Consequence: **a viewport taller than the screen means the bottom of the page is
unreachable, not merely off-screen.** A `min-height:100vh` centred layout makes
`scrollHeight == innerHeight`, so there is no scrollbar either — the user gets a
window that loaded correctly, has the right title, and is completely blank, with
no way to scroll to the content. Measured on comix's `/@waf/` interstitial at a
2400px emulated viewport: the card lands at y=978–1422 and the Verify button at
y=1335, while a real window shows ~950px (1080p) to ~1180px (maximised 1440p).

**So: any window a HUMAN has to interact with must shrink the EMULATED
viewport** (`page.set_viewport_size(...)`, which re-applies device metrics at
runtime with no relaunch and no identity change), and restore the scrape
geometry in a `finally`. Do not try to grow the window instead.

Two traps that make this expensive to rediscover:

- **You cannot derive the right size from the page.** Device-metrics emulation
  overrides `window.screen` as well, so `screen.availHeight` reports the
  emulated value back and the derivation is circular. Use a fixed size that fits
  the smallest realistic window.
- **The failure is silent in both directions.** Too tall strands the human; too
  short (forgetting the restore) strands the *scrape* — comix's reader defers
  every 10th page until the viewport approaches it, so a run left at 720px
  returns chapters ~10% short with no error at all.

**Risk surface is any browser-driven handler**, not just comix: `sites/comix.py`
(WAF handoff + sign-in window — fixed, upstream PR #71), `sites/browser_backend.py`,
and mangafire's signer page ([[mangafire-vrf-returned]]). comix's own launch
config and the measured layout table live in `sites/comix.py` next to
`_COMIX_INTERACTIVE_VIEWPORT`; site-specific WAF behaviour is in
[[comix-failure-modes]].

Testing note: both of comix's human-facing methods return early at a
`no_display` guard on Linux without `DISPLAY`, which is bare `ubuntu-latest` in
CI. An offline test of anything past that guard must set `DISPLAY` itself or it
reports green for code it never ran.
