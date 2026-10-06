---
name: mangafire-vrf-returned
description: "mangafire.to signs every /api/* call with a `vrf=` param AND sits behind a Cloudflare Managed Challenge no headless client can pass; both are handled by driving the site's own browser-side code"
metadata: 
  node_type: memory
  type: reference
  originSessionId: a0e659be-113f-4376-bf50-17627e306b53
  modified: 2026-08-19T21:03:07.099Z
---

**mangafire.to requires a `vrf=` signature on every `/api/*` call** (since
2026-08-02): `403 {"message":"Missing token."}` without one, `"Invalid token."`
when it doesn't match the params sent. Handled by `sites/mangafire_vrf.py` —
read its module header for the full mechanism; the repo `CLAUDE.md` invariants
have the operational summary.

Standing facts about the site that the code can't tell you:

- **The token is not reimplementable.** It's a stream cipher over the path +
  serialized query, shipped as *virtualized bytecode* (custom binary
  deserializer, seed-derived 512-entry opcode permutation tables, VM dispatch
  loop, `DisableDevtool`), re-seeded per build. Reversing it was tried and
  abandoned 2026-08-02 — don't reopen it.
- **Tokens are session-independent and never expire.** They replay from a cold
  cookieless `curl_cffi` session, and ciphertext length == plaintext length
  exactly, leaving no room for a timestamp.
- **The site deletes `window.__build` and `window.__config`** once its bundle
  reads them — they're in the shell HTML and `undefined` by the time a
  `page.evaluate` runs. Don't key anything on them.
- **The signer chunk ships under the decoy name `polyfill-<hash>.js`** and the
  hash rotates on every deploy (observed rotating mid-session). Discover it
  behaviourally, never by filename.
- Param **order** matters (the cipher covers the serialized query), but the
  server compares parsed params, so reordering a signed request still passes
  while changing a value fails.

**Cloudflare, added 2026-08-19 — the site is behind a Managed Challenge
sitewide, `/api/*` included.** Measured against the live site: plain
`requests`, **impit** (`browser="chrome"`), **curl_cffi**
(`impersonate="chrome"`) and **cloudscraper** were all served `Just a
moment...` for both the homepage and the API. There is no TLS-impersonation
fix — a browser that passes the JS challenge is the only client that can read
this site while it is up. Consequences worth knowing before touching anything:

- The *launch configuration decides whether it clears at all.* A cold
  throwaway profile auto-cleared in **3.2s** headless with
  `channel="chromium"` + a pinned UA; plain `headless=True` (announcing
  `HeadlessChrome` in both the UA and `Sec-CH-UA`) never did. Both levers are
  required — see `sites/browser_identity.py`'s measured table, and
  [[playwright-channel-vs-headless-shell]] for why that launch is a
  different BINARY whose lock behaviour makes a shared profile the
  deciding factor in whether a background update check works at all.
- **This retires the old "only *signing* needs a browser" note in this file.**
  While the challenge is up, `_api_get` reads `/api/*` through the browser
  too (same-origin `fetch()` in the cleared page, sticky per process). Plain
  HTTP is still tried first, so the fast path returns by itself if Cloudflare
  is ever switched off.
- **Image downloads are unaffected** — the `*.mfcdn*.xyz` CDN is a different
  host and is not challenged (verified: a real page URL returns a 536 KB
  `image/jpeg` under `impersonate="chrome"`).
- Handing the clearance to cloudscraper does not work and shouldn't be
  retried; see [[comix-failure-modes]] for the measurement that settled it.

Related: `sites/hardening.py` used to treat the token 403s as Cloudflare rate
limiting and burn ~84s of retries per call; `_is_api_token_rejection` now
exempts them. See [[search-cli-entry-point]], [[comix-failure-modes]] — comix.to
returns the identical `Missing token.` body from its own signed API, and hit the
same browser-identity wall first.
