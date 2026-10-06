---
name: wordpress-image-accept-negotiation
description: "WordPress.com serves an HTML wrapper page instead of the image when a request's Accept prefers text/html — the hosts are alive; the old 'retired *.files.wordpress.com host' diagnosis was wrong"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 3cd3085b-1946-4785-a571-c3ea8a5f6f6e
  modified: 2026-08-03T12:15:23.276Z
---

WordPress.com **content-negotiates image URLs on the request's `Accept` header**
and returns a *different resource* for the same URL:

- `Accept` prefers `text/html` (a document Accept) → **HTTP 200,
  `Content-Type: text/html`, a ~19 KB attachment WRAPPER page**
  (`<!DOCTYPE html><html lang="vi">…`, response header `x-orig-src: 0_wrapper`).
- `Accept` prefers `image/*` (or is `*/*`) → the real JPEG
  (`x-orig-src: 01_mogdir`).

The response carries `Vary: Accept`. It applies to both URL forms —
`<sub>.files.wordpress.com/<path>` and the
`<sub>.wordpress.com/wp-content/uploads/<path>` it 301s to.

**This bites us because cloudscraper seeds every session with a document
Accept** (`text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8`),
and curl_cffi's `impersonate` does the same. So an image download asked for
HTML and got HTML — a 200, so nothing looked like a network failure.

**The "retired host" diagnosis was WRONG — don't re-derive it.** An earlier
session concluded these hosts were dead and made the handler fail loudly.
Verified 2026-08-03: every one of those URLs still serves its original bytes;
only the request was wrong. Symptoms that mislead: the body is a 200, the
subdomain varies *per chapter* (`anhanh1221`, `manhuaus5`, `manhuaus11`,
`cdnmanhuapluss1`…) so it reads like a graveyard of dead hosts, and
`looks_like_real_image` correctly rejects the markup — which makes a
request-side bug present as a host-side one.

Fix is global and request-side: `sites/_image_io.py:IMAGE_ACCEPT` /
`IMAGE_ACCEPT_HEADERS`, sent **per request** (never on `session.headers` — the
same session fetches HTML pages). Senders: `aio-dl.py:_try_download_url`,
`sites/base.py` (`_fast_dl_build_headers`, `_fetch_probe_item_bytes_ex`,
`_probe_cover_image`), `sites/mangadex.py:_fetch_image_blob`. Grep
`IMAGE_ACCEPT`. Offline guard: `tests/test_image_accept_negotiation.py` runs a
local server that reproduces the negotiation.

Who is affected: manhuaplus' pre-~ch.1000 back catalogue (newer chapters use
`cdn.manhuaplus.com` and were always fine), plus any other Madara site whose
uploader parked images on a WordPress blog. Self-hosted CDNs return
byte-identical responses either way, so the header is a no-op there. See
[[search-cli-entry-point]] for exercising a handler by hand.
