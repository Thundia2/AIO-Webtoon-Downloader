---
name: tapas-motion-audio-local-feature
description: "Faithful-archival aux pipeline: tapas.io handler + LINE-Webtoon motion/BGM captured as sidecar assets embedded INSIDE the chapter CBZ under _aio/; how BGM is resolved and where the code lives"
metadata:
  node_type: memory
  type: project
  originSessionId: ad75891c-9519-409e-9289-851928c39a0f
---

Faithful archival of webtoon extras (no video rendering — a custom reader replays
raw manifest/timeline + audio). Two producers: `sites/tapas.py` (handler) and
`sites/linewebtoon.py` (motion-toon manifest + standard-episode BGM). The full
spec is the CLAUDE.md "Auxiliary assets ride the chapter dict…" invariant plus
the "fix tapas" / "fix sidecar assets" / "fix linewebtoon" rows; this memory keeps
the non-obvious mechanics.

**Architecture (grep anchors in aio-dl.py):** a handler stashes
`List[sites.base.AssetSpec]` on `chapter["_aux_assets"]` during
`get_chapter_images` (types audio_download / motion_manifest / motion_layer /
audio_reference). `_materialize_chapter_aux` fetches them into in-memory members
(audio via `_fetch_binary_asset_bytes`, NOT `dl_image` — its magic-sniff
mislabels `.m4a`) named under the reserved **`_aio/`** prefix, written straight
INTO the per-chapter `{n}.cbz` by the cbz_cache builder. `_aio/` members are
renumber-EXEMPT in `build_cbz_from_content` (skipped in PageCount, copied
verbatim) — else an in-CBZ `.m4a` would become a bogus page. Per-chapter metadata
rides the ComicInfo `<AioChapterResources>` blob (Komga/Kavita ignore it);
details.json gets a series rollup rebuilt at end-of-run by `_scan_chapter_cbz_aux`
(reads each CBZ back — self-heals on resume). **CBZ-only** (EPUB/PDF skip aux →
`_warn_aux_needs_cbz_once`); `--no-sidecar-assets` opts out; `--refresh-rewrite-cbz`
preserves aux. Reset `ch.pop("_aux_assets"/"_aux_records"/"_aux_members")` before
each fetch so retries don't duplicate.

**tapas gotchas:** episodes come from JSON `data.episodes` (NOT the `data.body`
HTML); `scene` = chapter number; **the episodes API caps `max_limit` at 20 —
≥21 → HTTP 500**; free/unlocked gating skips locked eps. `bgm_url` → an
`audio_download`; SoundCloud iframe → `audio_reference` (record-only).

**LINE-Webtoon standard-episode BGM → real .m4a via Naver AudioCloud** (the unique
recipe; helpers `_resolve_bgm_specs` / `_extract_episode_bgm_list` /
`_resolve_audiocloud_url` in sites/linewebtoon.py):
1. The desktop viewer HTML (already fetched in `get_chapter_images`) embeds
   `window.__audioProperties__ = { …, episodeBgmList: [{audioId, filePath, …}] }`.
   `filePath` is a LEGACY path that 404s on every phinf CDN — DO NOT use it; the
   `audioId` is the real key.
2. GET `https://apis.naver.com/audiocweb/audiocplayogwweb/play/audio/{audioId}/audio/token?quality=MIDDLE&acceptCodecs=AAC,MP3`
   with `Referer: https://www.webtoons.com/`. No login for public episodes.
   **Param casing is strict** — `quality=MIDDLE` (LOW/MIDDLE/HIGH),
   `acceptCodecs=AAC,MP3` uppercase; wrong casing → HTTP 400 "Invalid request."
   Use a direct `scraper.get`, NOT `make_request` (which 6×-retries non-2xx and
   would stall every has_bgm chapter ~a minute if the API shifts).
3. Response `result.playToken` is base64 JSON (pad to %4) → `audioInfo.url` = a
   signed `.m4a` on `…-audiop.pstatic.net/stream/v3/audio/…?__gda__=<expiry>_<sig>`.
   GET it (same Referer) → real M4A bytes (`ftypM4A`). The signed URL lives ~1 hr,
   but resolve-at-parse + download-at-package run seconds apart in the same
   per-chapter iteration → no expiry risk.
Resolution failure falls back to an `audio_reference` presence marker (still sets
`has_bgm` meta so a reader flags it). The motion `.mp3` base is the BDCoMa
`motiontoonJson` reference (`assets.image`/`assets.sound` share one
`template_path`). Motion+BGM on the same episode is the one unhandled edge (the
motion branch returns before `_stash_normal_audio`) — documented in-code, no live
case found. Video episodes (app-only) are HLS + likely Widevine DRM → out of scope.

**Watchdog / multi-source interaction (grep `aux_veto`, `_chapter_carries_aux`):**
aux fetch is watchdog-EXEMPT (it only runs post-gate; honoring the deadline
silently dropped BGM). Aux-bearing chapters (BGM/motion) are NEVER
alt-source-rescued and don't trigger lazy discovery — alt sites only mirror
flattened pages, so a rescue would trade real audio/motion for availability;
recovery is inline-retry on the primary only. See the CLAUDE.md "Chapter watchdog
scope" invariant. Related: [[tapas-locked-multisource-rescue]],
[[lazy-multisource-update-downloads]].
