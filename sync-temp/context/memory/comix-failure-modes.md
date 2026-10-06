---
name: comix-failure-modes
description: "comix's failure contract — the chapter-LIST scrape and a SHORT image capture both raise; only a TOTAL render miss returns [] and degrades to an `empty_content` miss; plus what the /@waf/ CAPTCHA binds its clearance to and why transplanting that session into cloudscraper was tried and killed, the live DOM facts, the unsettled canvas-vs-img question, and the `reader.webtoon.v3` preload lever"
metadata: 
  node_type: memory
  type: reference
  originSessionId: dac9b439-ee6a-48e0-baa4-1c1c92dd945b
  modified: 2026-08-02T20:09:23.164Z
---

comix has **three different failure contracts**, and knowing which one you're
looking at decides whether a log line is an emergency.

**LOUD — raises, kills the series run.** `fetch_chapters_via_dom` and the HTTP
metadata path (`_cf_aware_request` → `_waf_recover_once`) raise
`ComixChapterScrapeError` / `ComixWafChallengeError` rather than return a short
answer. That is on purpose: a truncated chapter LIST gets persisted to
`.aio_series.json` as if it were the whole series, so every later update run
inherits the truncation. `aio-dl.py` catches both at top level (grep
`_actionable`) and prints remediation. Note `_waf_recover_once` raises only as a
LAST resort — a WAF'd metadata request is first re-read through the browser, and
that usually succeeds silently (see below).

**LOUD — raises, routes into the rescue machinery.** `get_chapter_images` raises
`IncompleteChapterError(reason="comix_dom_render_incomplete")` when the DOM
capture comes back with FEWER pages than the reader reported. This is the same
signal `sites/mangadex.py` uses; `aio-dl.py` converts it to `ChapterSkippedError`
→ inline retry → `--multi-source` alt rescue → hard abort.

**SOFT — returns `[]`, run continues.** Only a TOTAL render miss (nav failed, the
reader never mounted, so no page count was ever learned), and `search()` on *any*
failure — a raise there would poison `search_orchestrator`'s ProbeFailureCache
and blocklist comix.to for an hour.

## Why the short-capture case had to become loud

`aio-dl.py`'s zero-tolerance gate computes `pages_total` from `len()` of what the
handler RETURNS, so a handler that quietly drops a page reports N/N and passes.
comix returned 67 of 68 pages and the CBZ was saved one page short — and because
pages are renumbered `0001..0067` on the way in, the archive had no gap to
notice. `ComixChapterCapture` (a NamedTuple, not a bare list) carries
`expected_pages` specifically so the handler can tell the two apart. Keep that
distinction: `expected_pages == 0` means "we were never told a count", which is
NOT the same as "we were told 68".

## What a soft (total) miss still costs

An empty page list makes `pages_total == 0`, and `incomplete = (pages_total > 0
and pages_ok < pages_total)` is therefore **False** — so the completeness gate
never fires and no `ChapterSkippedError` is raised. Consequences, all from *not*
raising: no immediate alt rescue, no inline retry, no deferred
`--multi-source-lazy` trigger, no host-poison/Phase-D feedback, and
`consecutive_ghosts` **resets** so a whole series of these never escalates.

Not data loss, though: the chapter lands as `empty_content` in `missed_entries`,
and the end-of-run missed replay *does* route through `_process_chapter_strict`,
so alts are available there. Nothing short or empty is ever memo-cached, and
`actually_downloaded = downloaded_nums - still_missed_nums` keeps a still-missed
chapter **out** of `chapters_downloaded` so the UI re-offers it. See
[[lazy-multisource-update-downloads]] and [[tapas-locked-multisource-rescue]].

## OPEN: is the `<canvas>` branch still earning its keep?

The capture poll checks `<canvas>` **before** `<img>`, and canvas fires on ~9% of
pages (6/68 on one chapter, ~8/88 on a TBATE one) even though comix is believed
to have dropped tile-scrambling. Two incompatible readings and they need
different fixes:

- **Real per-page scrambling** → canvas is load-bearing, optimise the encode.
- **A poll race** (canvas transiently present on an ordinary page) → ~9% of every
  chapter is being re-encoded through `toDataURL('image/webp', 0.95)` for
  nothing, lossily.

Instrumented, not yet decided (user call: measure first, don't rewire). The
authoritative signal is the **`x-scramble-*` RESPONSE header**, not DOM shape —
recorded by the `page.on("response")` listener into `_scrambled_urls`. Read the
per-chapter `[*] Comix capture shapes: img=N canvas=N (M of which also had a
complete <img>); scramble-headered responses this chapter=K` line: `K=0` **and**
`M == canvas` means race → prefer `<img>`. Behaviour is unchanged until it reads
one way or the other.

## The `/@waf/` CAPTCHA: what the SITE does (mechanics live in repo CLAUDE.md)

Standing external behaviour, the part that isn't derivable from our code:

- The interstitial is **comix's own**, not Cloudflare's, and it is **machine-
  unsolvable by design** — a human drags a slider. `"@waf"` appears in ZERO
  client bundles (727 KB scanned), so it is entirely server-issued: there is no
  in-page routine to invoke and nothing to replicate. Don't go looking again.
- It fires **behaviorally, not always-on** — comix served a full chapter to a
  cookieless anonymous browser. So "it works in my browser" proves nothing about
  the headless profile, and a clean manual check does not mean the run will pass.
- Clearance is bound to the **client identity that earned it**, and identity
  includes the `Sec-CH-UA` client hints — not just the UA string. This is why a
  solved check can stop working seconds later.
- The clearance rides an `HttpOnly`+`Secure` `session` cookie (short-lived,
  rolling) alongside a year-long `cf_clearance`. Both persist in the app-owned
  profile, so **one human solve legitimately covers days across processes** —
  if you're seeing repeated prompts, the identity is drifting, not the cookies
  expiring.

**Tried and killed: transplanting the solved session into cloudscraper.** Copy
cookies onto the scraper, overwrite its User-Agent, retry the request. It cannot
work — cloudscraper picks a random 2016-2019 browser profile per session, the UA
overwrite leaves a decade-old `Accept` and no client hints beside a modern UA,
and the cookie is bound to a browser the HTTP client cannot impersonate at the
TLS layer. It burned real user solves to fail anyway. The code is gone; the
metadata path re-reads the page through the browser instead. Don't reinvent it.

The two counter-intuitive fixes (`channel=` **and** UA pin — neither works
alone; CDP `Browser.getVersion` to read the true UA past an override) are
written up with the measurement table in the repo's own `CLAUDE.md`
architectural invariants, which is where a reader will be when it matters.

## Live DOM facts (verified 2026-08-02, anonymous browser)

Check these *before* blaming the handler:

- `.rpage-page` is **current**, and all N divs exist at mount (75 on a 75-page
  chapter) even though only ~3 `<img>` have loaded — the count comes from the
  decrypted chapter API, the images are lazy.
- Pages are plain `<img>` off rotating `*.wowpic*.store` hosts; `canvas` count
  was 0 **in that anonymous session**, which is precisely why the ~9% canvas rate
  seen during real runs is still an open question rather than a settled fact.
- **`document.cookie` is empty** — this is the observation the "fires
  behaviorally" point above rests on: comix served a full chapter to a cookieless
  anonymous browser, so neither CF nor `/@waf/` is always-on.

Recipe: open the chapter URL and evaluate
`document.querySelectorAll('.rpage-page').length`, `document.cookie`,
`Object.keys(localStorage)`. See [[search-cli-entry-point]] for exercising the
handler itself.

## The reader's preload setting (the one lever on chapter-fetch speed)

The reader lazy-loads pages on scroll. Its persisted settings live in
localStorage under **`reader.webtoon.v3`**, a Zustand-persist envelope whose
fields sit under `state` — *not* at the top level:

```json
{"state": {"readingDirection":"ttb", "pageLayout":"single", "preload":"some", ...}, "version": 0}
```

`preload` accepts **`all`**, and it is worth a lot: on one 75-page chapter, same
URL, plain reload — `some` (the site default) → **3** pages carrying a loaded
`<img>`; `all` → **68**. Read-modify-write it and leave `version` alone, or the
store's migration logic discards the blob as a foreign schema generation. The
key only materializes once the reader has run, so a fresh profile needs it
created in exactly that shape.

Two traps, both real, both hit here: the key is *not* `reader.default` (a
plausible-looking name that nothing on the site reads), and a top-level
`preload` is ignored even under the right key. A write that gets either wrong is
silently inert — there is no error, the reader just keeps lazy-loading.
