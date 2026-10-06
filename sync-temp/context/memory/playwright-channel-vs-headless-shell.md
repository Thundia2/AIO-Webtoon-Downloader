---
name: playwright-channel-vs-headless-shell
description: "Playwright's channel=\"chromium\" and its default headless launch are DIFFERENT BINARIES — only the first respects the user-data-dir lock, and they report different UA build numbers, so a shared persistent profile silently degrades the loser's identity"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7601b6c1-49a1-409b-a9a6-8b80b5627537
  modified: 2026-08-20T08:53:20.460Z
---

**`channel="chromium"` and the default headless launch are not the same
browser.** Measured 2026-08-20 on patchright 1.59.1 / Chromium 147, Windows.
This surprises people twice, and both surprises cost real bugs.

**1. Only one of them respects the profile lock.** Chromium locks a
user-data-dir, but the two launches behave oppositely against a held one:

| launch | binary | on a profile another process holds |
|---|---|---|
| `channel="chromium"` | full Chromium (`chrome.exe`) | **refuses** — `TargetClosedError: ... has been closed` |
| default headless (no channel) | `chromium_headless_shell` | **gets in anyway** |

So any "try the good launch, fall back to the plain one" ladder over a SHARED
persistent profile is guaranteed, under contention, to take the fallback and
guaranteed to have it succeed. That is a silent identity downgrade, plus two
browsers writing one cookie jar. Reproduce in ~10s: hold a profile in one
process, launch the same dir with and without `channel` from another.

**2. They report different UA versions**, and only one matches real Chrome:

| launch | wire User-Agent | `userAgentData.brands` | `fullVersionList` |
|---|---|---|---|
| `channel="chromium"` | `HeadlessChrome/147.0.**0.0**` | `Chromium 147` | `Chromium/147.0.7727.15` |
| headed + channel | `Chrome/147.0.0.0` | `Chromium` | — |
| default headless | `HeadlessChrome/147.0.**7727.15**` | **`HeadlessChrome`** | **`HeadlessChrome`** |

Chrome's UA reduction freezes everything after the major version, so
`147.0.7727.15` is a UA **no genuine Chrome ever sends** — the headless-shell
value is a bot signal in its own right. Anything that probes the true UA
(CDP `Browser.getVersion`) and caches it must reduce to `MAJOR.0.0.0`, or the
cached value oscillates between the two binaries and every flip triggers a
teardown+relaunch. Note the fallback leaks `HeadlessChrome` in **three** places
at once — the UA token, `brands`, and `fullVersionList` — so a UA pin alone
fixes only one third of it.

Practical rules this repo now follows (`sites/profile_lock.py`,
`sites/browser_identity.py`):

- Take a cross-process lock on the profile dir **before any launch**, and wait
  rather than fall back. Use an OS-level lock (`msvcrt.locking` /
  `fcntl.flock`), not a pid file — the kernel releases it when a process is
  killed, so there is no stale-lock case to garbage-collect.
- On Windows a byte-range lock **blocks reads of that range from other
  processes**, so a holder pid stored at offset 0 is unreadable by exactly the
  peer that wants to name it. Stamp diagnostics at offset 1.
- `msvcrt.locking(LK_LOCK)` spins ~10s then raises — useless as a timeout. Poll
  `LK_NBLCK` against your own deadline instead.
- Never let a degraded launch write a cached identity that later processes pin.

Affects every handler with a persistent profile: [[mangafire-vrf-returned]] and
[[comix-failure-modes]] both hit this wall independently. See also
[[electron-app-local-e2e-testing]] — the desktop app runs several Python
processes at once, which is what creates the contention in the first place.
