---
name: curl-cffi-vs-requests-timeout
description: "curl_cffi's scalar timeout= is a TOTAL-transfer deadline while requests' is a per-read stall timeout, so the same --http-timeout means two different things on the fast vs slow download path"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 75f6aeb9-42c3-46d8-8ec3-df6239a2b2fb
  modified: 2026-08-20T00:28:33.930Z
---

`curl_cffi` and `requests` give the identical `timeout=` argument opposite
meanings, and this repo passes the SAME `--http-timeout` to both.

- **`requests`/cloudscraper** (`aio-dl.py:_try_download_url`, the slow path):
  per-read STALL timeout — "N seconds with no bytes arriving". A slow but
  progressing transfer runs as long as it needs.
- **`curl_cffi`** (`sites/base.py:fast_download_images`, the fast path): a
  scalar `timeout=` sets ONLY `CurlOpt.TIMEOUT_MS` — a TOTAL-transfer deadline.
  It sets no connect timeout and no stall detector. A tuple `(connect, read)`
  is still a total deadline (`TIMEOUT_MS = connect + read`); only `stream=True`
  switches curl_cffi to `LOW_SPEED_LIMIT`/`LOW_SPEED_TIME`. Source of truth:
  `curl_cffi/requests/utils.py:set_curl_options`, the `# timeout` block.

This bites large images on throttled CDNs: a page that HTTP/2-starves to
~20 KB/s needs ~35s, so a 30s total deadline kills it mid-transfer and the
retry restarts from byte 0 — unable to ever succeed. Affects only handlers
with `SUPPORTS_FAST_DOWNLOAD` (linewebtoon, mangafire).

**The lever for per-request curl options is `curl_options=`, and in curl_cffi
0.15 it is CONSTRUCTOR-ONLY on `AsyncSession` — not a `request()`/`get()`
kwarg.** So varying curl options per attempt means one session per option set.
`set_curl_options` applies `curl_options` LAST ("after all others, because it
will alter some options"), so it reliably overrides everything curl_cffi
derived, including options a scalar `timeout=` left unset.

Useful `CurlOpt`s that are all present in 0.15: `LOW_SPEED_LIMIT`,
`LOW_SPEED_TIME`, `CONNECTTIMEOUT_MS`, `TIMEOUT_MS`, `FRESH_CONNECT`,
`FORBID_REUSE`, `RANGE`, `HTTP_VERSION`. `CurlHttpVersion.V1_1` forces
HTTP/1.1, which sidesteps H2 stream starvation when many pages are multiplexed
onto one connection (a 100+ page chapter shares ONE H2 connection by design).

Note when reading `r.http_version`: it is curl's raw enum, so **2 = HTTP/1.1
and 3 = HTTP/2**, not the version number.

Related: [[wordpress-image-accept-negotiation]] is the other case where the
fast path's defaults differ from the slow path's in a way that breaks images.
