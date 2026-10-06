---
name: modernize-effort-speed-tuning
description: "How --modernize's JXL --effort and AVIF --avif-speed knobs trade encode CPU for file size; e7/s6 is the sweet spot, e9/s4 is ~7.5x slower for ~5% smaller"
metadata:
  node_type: memory
  type: project
  originSessionId: ad75891c-9519-409e-9289-851928c39a0f
---

`--effort` (JXL) and `--avif-speed` (AVIF) are PURE CPU↔size knobs on the
modernize encode path — they change encode time and output BYTES but NOT the
decoded pixels/quality (distance / q stay fixed). This holds in both twins:
`tools/modernize_library.py` (offline library re-encode) and the live downloader
`aio-dl.py:recompress_chapter_images_modern`. They default DIFFERENTLY:
- `tools/modernize_library.py` defaults to JXL `--effort 9` / `--avif-speed 4`
  (its header justifies e9 as "offline, time doesn't matter").
- the live downloader path uses effort=7 / speed=6.

**The tuning, benchmarked on a Ryzen 5 7500F (6c/12t) over real library pages
(2026-06-26), at fixed visual quality:**
- **JXL grayscale dominates total time** (library is ~95% B&W):
  - e9 (the tool default) is strictly DOMINATED by e8 — e8 is the SAME size
    (+0.0%) and ~35% faster. Never use e9.
  - e7 is **7.7x faster than e9** for only +5.7% size.
  - e5 is ~31x faster than e9, +7.1% (only +1.3% over e7).
- **AVIF color:** s4 (the tool default) is 5.4x slower than s6 for +2.2% size;
  s6 is the sweet spot, s10 falls off (+12.8%).
- **Net:** e9/s4 → e7/s6 = **~7.5x faster** encode (JXL-dominated) for ~5-6%
  larger files.

**How to tune:** it's a FLAG, not a code change — run the tool with
`--effort 7 --avif-speed 6` (or `--effort 8` to keep e9-grade size at ~1.5x
speed). The run is resumable (skips up-to-date output CBZs by mtime), so
switching mid-run is free — only remaining chapters re-encode. `--jobs 10`
is already right for 6c/12t (CPU-saturated); jobs is NOT the lever.

Secondary micro-opts (measured, smaller): the grayscale probe
`_page_is_grayscale` is ~7% of an e7 encode and 2.9x cheaper at 1/2-res subsample
(but the live path probes full-res → routing can diverge on borderline pages);
the BytesIO encode is byte-identical to the temp-file path except at distance=0.0
(JPEG reconstruction), which needs the on-disk file.
