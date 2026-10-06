#!/usr/bin/env python3
r"""
tools/modernize_library.py — standalone batch converter for an existing CBZ library.

WHAT THIS OWNS
  Part B of the manga-compression plan (DOWNLOADER-PLAN-aio.md §"Part B"). A
  one-shot / occasional bulk converter that walks a `manga/<Series>/*.cbz` tree
  and rewrites each chapter CBZ with its JPEG/PNG pages transcoded to JXL (B&W
  line art) or AVIF (color) — the same content-aware, visually-lossless scheme
  the downloader applies live via `--modernize`. Originals are LEFT UNTOUCHED:
  output goes to a parallel tree (default D:\AIO\manga-jxl), so this is safe to
  run against the real library and re-run (resumable).

WHAT READS FROM IT
  Nothing imports this — it's an UNSHIPPED personal tool (not in the upstream
  PR; the `--modernize` downloader stage is the PR-safe half). Output is consumed
  by the user's Kotatsu reader fork (decodes .jxl/.avif) and any Komikku-style
  reader (per-chapter CBZ + ComicInfo.xml preserved).

WHAT IT DEPENDS ON
  Pillow (+ native AVIF, Pillow >= 12), numpy, and pillow-jxl-plugin (JXL). No
  dependency on aio-dl.py or the sites/ registry — fully standalone so the bulk
  run can't break on an unrelated handler import and starts instantly.

CROSS-FILE COUPLING (KEEP IN SYNC)
  The per-page classify/transcode/guard core below is a DELIBERATE DUPLICATE of
  aio-dl.py:recompress_chapter_images_modern (grep that name + '_page_is_grayscale'
  + '_MODERNIZE_MAX_DIM'). The HANDOFF per-page decision matrix is the shared
  contract: the downloader and this converter MUST emit byte-equivalent output
  for the same page (same routing, same guard, same encode flags) so a mixed
  library — some chapters grabbed live with --modernize, some converted here —
  is uniform. If you change routing/guard/encoding in one place, change it in the
  other. Duplicated (not imported) on purpose: keeps the upstream --modernize PR
  self-contained and this tool free of aio-dl.py's heavy import graph.

  The ONE thing that differs from A1 by design: encoder *effort* (JXL effort
  default 8 vs A1's 7, AVIF speed 4 vs A1's 6; e9 is a measured CPU trap —
  ~7.5x e7's time for ~5% size, while e8 matches e9's size at ~1.5x speed; see
  the memory note modernize-effort9-cpu-trap). Slower-but-smaller — time
  matters less for an offline bulk run. Effort only affects file size, never
  the decoded pixels or the format, so it doesn't break the shared contract.

USAGE
  # Dry-run a sample to validate the projection before the multi-hour real run:
  python tools/modernize_library.py --in D:\AIO\manga --dry-run --series "One Piece"
  python tools/modernize_library.py --in D:\AIO\manga --dry-run            # whole library (slow; full transcode, no writes)

  # Real run to the parallel tree (resumable — re-run to pick up where it stopped):
  python tools/modernize_library.py --in D:\AIO\manga --out D:\AIO\manga-jxl

  # Aggressive / lossless variants:
  python tools/modernize_library.py --in D:\AIO\manga --quality 85 --distance 1.2     # smaller
  python tools/modernize_library.py --in D:\AIO\manga --distance 0.0                   # JXL mathematically-lossless (much larger)
"""

import argparse
import os
import shutil
import sys
import tempfile
import time
import warnings
import zipfile
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed

from PIL import Image

# pillow-jxl-plugin registers the JXL encoder/decoder in PIL.Image.SAVE on
# import. AVIF is native in Pillow >= 12. Done at MODULE level (not inside the
# worker fn) so it runs once per process: ProcessPoolExecutor spawns fresh
# interpreters on Windows that re-import this module, so each worker gets JXL
# registered without a per-call import. _HAVE_JXL gates the startup check in
# main() (avif-only policy doesn't need it).
try:
    import pillow_jxl  # noqa: F401  (registers JXL in PIL.Image.SAVE)
    _HAVE_JXL = True
except ImportError:
    _HAVE_JXL = False

Image.init()  # force lazy native-plugin registration (AVIF) before any worker save
# These are the user's own files; a long-strip webtoon page can be 800x15000+
# (12M+ px) which trips Pillow's DecompressionBomb guard. Trust the library.
Image.MAX_IMAGE_PIXELS = None

# In strict-lossless mode (--distance 0.0) pillow_jxl does bit-exact JPEG
# reconstruction and warns once per page suggesting lossless_jpeg — pure noise
# since reconstruction is exactly what we want there. Mirrors the same filter in
# aio-dl.py (grep 'Using JPEG reconstruction').
warnings.filterwarnings(
    "ignore", message="Using JPEG reconstruction", category=UserWarning
)

# ============================================================================
# PER-PAGE CORE — DUPLICATED from aio-dl.py:recompress_chapter_images_modern.
# KEEP IN SYNC (see the file header's CROSS-FILE COUPLING note). The HANDOFF
# per-page matrix is the contract. Routing is a SIZE decision only — we never
# convert("L"), so a misroute costs bytes, never pixels.
# ============================================================================

# Pages larger than this in either dimension route to JXL regardless of color:
# AVIF's on-device (Android) decode at extreme heights is unverified, and JXL
# measured strictly better on tall strips anyway — 12 MP strip: JXL d1
# 968,501 B / butteraugli 1.23 / 27.6 MP/s decode vs AVIF-444 1,072,135 B /
# bt 2.28 / 13.0 MP/s (libavif 1.4.2, 2026-07-02 bench). Under an avif-only
# policy the user opted out of JXL, so oversized pages are skipped (original kept).
_MODERNIZE_MAX_DIM = 8192

# Source formats with no re-encode headroom (already efficient / animated /
# already modern). Matched against PIL's reported Image.format, so the routing
# follows the actual decoded container, not the filename extension.
_MODERN_SKIP_FORMATS = frozenset({"WEBP", "AVIF", "GIF", "JXL"})

# Archive entries we even attempt to transcode. Non-image entries (ComicInfo.xml,
# .nomedia, stray text) are copied verbatim. Extension-based: cheap and CBZ entry
# names are predictable; the core's Image.open + _MODERN_SKIP_FORMATS check is the
# real authority on "has headroom" for the ones we do open.
_IMAGE_EXTS = frozenset({
    ".jpg", ".jpeg", ".jfif", ".png", ".webp", ".avif",
    ".gif", ".bmp", ".jxl", ".tif", ".tiff",
})


def _page_is_grayscale(im, chroma_thresh: int = 16, area_frac: float = 0.005) -> bool:
    """True if a page should route to JXL (grayscale) vs AVIF (color).

    ROUTING ONLY — never a pixel decision (we never reduce to mode L), so a wrong
    verdict only changes which codec is tried (a size trade-off). Full-resolution
    colored-area fraction, not a downscaled probe: a small but real color element
    (a 5%-area panel) survives at full res but gets averaged away by a thumbnail.
    Counting the fraction of pixels whose channel spread exceeds chroma_thresh is
    robust to JPEG chroma ringing on B&W scans yet catches genuine local color.
    Identical to aio-dl.py:_page_is_grayscale — keep in sync.
    """
    if getattr(im, "mode", None) in ("L", "LA", "1"):
        return True
    import numpy as np  # lazy; hard dep
    arr = np.asarray(im.convert("RGB"), dtype=np.int16)
    chroma = arr.max(axis=2) - arr.min(axis=2)  # per-pixel max channel spread
    return float((chroma > chroma_thresh).mean()) < area_frac


def _pick_target(im, w: int, h: int, policy: str) -> str:
    """Choose the codec for one page: 'jxl' | 'avif' | 'both' | 'skip'."""
    if max(w, h) > _MODERNIZE_MAX_DIM:
        return "jxl" if policy != "avif" else "skip"
    if policy == "jxl":
        return "jxl"
    if policy == "avif":
        return "avif"
    if policy == "jxl+avif":
        return "both"
    return "jxl" if _page_is_grayscale(im) else "avif"  # auto


def _encode_avif_444(im, out, *, quality: int, speed: int,
                     max_threads: int = -1) -> None:
    """Alpha-preserving, 4:4:4-chroma AVIF save. ``out`` is a path or any
    writable binary file object (Pillow accepts both).

    Single source of the AVIF encode so _transcode_page_file (the normal
    transcode) and _repair_one_cbz (the --fix-avif repair) emit BYTE-equivalent
    output. Mirrors aio-dl.py:recompress_chapter_images_modern's AVIF branch
    (KEEP IN SYNC): map every alpha-bearing mode to RGBA, widen the rest
    (L / opaque-P / CMYK / ...) to RGB, force subsampling 4:4:4 (Pillow defaults
    to 4:2:0 → chroma bleed, measured butteraugli ~7.1 vs ~1.3; 2026-07-02 bench).

    ``max_threads`` caps libavif's internal pool (default = all cores). The
    ProcessPool already fans out across CBZs, so an all-cores pool per encode
    would oversubscribe (jobs*cpu threads); callers pass the per-job budget.
    Thread count never changes the output bytes. Mirrors aio-dl.py's num_threads
    cap (grep enc_threads).
    """
    if im.mode == "RGB":
        avif_src = im
    elif im.mode in ("RGBA", "LA", "PA") or (
        im.mode == "P" and "transparency" in im.info
    ):
        avif_src = im.convert("RGBA")
    else:
        avif_src = im.convert("RGB")
    avif_src.save(out, format="AVIF", quality=quality, speed=speed,
                  subsampling="4:4:4", max_threads=max_threads)


def _transcode_page_file(
    src: str,
    *,
    policy: str,
    gray_quality: float,
    color_quality: int,
    min_saving: float,
    effort: int,
    avif_speed: int,
    enc_threads: int = 1,
):
    """Transcode one page FILE in a temp dir; return (result_path, action, orig_size, new_size).

    action: 'jxl'/'avif' (transcoded, new file adopted) | 'kept' (transcoded but
    failed the min_saving guard → original) | 'skip' (no headroom: WebP/AVIF/GIF/JXL
    source, or oversized under avif-only) | 'fail' (corrupt/encoder error → original).

    FILE-based (not BytesIO) on purpose: pillow_jxl's JPEG handling differs between
    a file source and an in-memory buffer (the bit-exact reconstruction path at
    distance 0.0 needs the on-disk JPEG bitstream). Operating on temp files makes
    this byte-identical to aio-dl.py's A1, which transcodes downloaded files.

    ``enc_threads`` bounds each encoder's internal pool. The ProcessPool already
    parallelizes across CBZs, so an all-cores pool per encode oversubscribes
    (jobs*cpu threads) and intermittently trips libjxl into a bare JXL_ENC_ERROR
    on very large pages; a transient failure is retried single-threaded (no
    cross-process pool contention) before conceding to 'fail'. Mirrors aio-dl.py's
    enc_threads cap + serial mop-up (KEEP IN SYNC — grep enc_threads).
    """
    base, _ = os.path.splitext(src)
    orig_size = os.path.getsize(src)

    def _encode(nthreads):
        """One encode attempt. Returns the candidate list, or None for a skip
        page; raises on an encoder error (caught by the retry loop below)."""
        with Image.open(src) as im:
            src_fmt = (im.format or "").upper()
            if src_fmt in _MODERN_SKIP_FORMATS:
                return None
            w, h = im.size
            target = _pick_target(im, w, h, policy)
            if target == "skip":
                return None
            candidates = []  # (size, path, action, is_recon)
            if target in ("jxl", "both"):
                jxl_path = base + ".jxl"
                # Encode as-is (no convert("L") — measured 0% benefit at d1.0 and
                # it would destroy color on a misroute). Keep alpha-capable modes
                # (JXL carries alpha); map paletted transparency to RGBA so
                # palette alpha isn't flattened; only widen truly exotic modes
                # pillow_jxl can't take (opaque P / CMYK / I / ...) to RGB.
                # Mirrors aio-dl.py's JXL branch exactly (KEEP IN SYNC — the old
                # one-liner here dropped palette transparency).
                if im.mode in ("L", "LA", "RGB", "RGBA"):
                    jxl_src = im
                elif im.mode == "PA" or (
                    im.mode == "P" and "transparency" in im.info
                ):
                    jxl_src = im.convert("RGBA")
                else:
                    jxl_src = im.convert("RGB")
                # JPEG quirk: pillow_jxl's default lossless_jpeg=True does bit-exact
                # reconstruction and IGNORES distance. Force lossless_jpeg=False on
                # the lossy path so --distance applies; keep the default only for
                # the explicit lossless tier (distance 0.0 → lossless=True gives
                # JPEG reconstruction + PNG pixel-lossless for free). Mirror of A1.
                # num_threads caps pillow_jxl's internal pool (grep enc_threads).
                jxl_src.save(
                    jxl_path,
                    format="JXL",
                    effort=effort,
                    num_threads=nthreads,
                    **({"lossless": True} if gray_quality == 0.0
                       else {"distance": gray_quality, "lossless_jpeg": False}),
                )
                # is_recon marks pillow_jxl's bit-exact JPEG->JXL
                # *reconstruction* (JPEG file source + strict-lossless tier +
                # no mode conversion — a CMYK JPEG went through convert("RGB"),
                # severing the original bitstream, so that save is NOT
                # byte-recoverable). Zero quality cost and reversible, so the
                # min_saving guard below exempts it. Mirrors aio-dl.py (grep
                # is_recon).
                is_recon = (
                    src_fmt == "JPEG"
                    and gray_quality == 0.0
                    and jxl_src is im
                )
                candidates.append(
                    (os.path.getsize(jxl_path), jxl_path, "jxl", is_recon)
                )
            if target in ("avif", "both"):
                avif_path = base + ".avif"
                # Alpha-preserving 4:4:4 AVIF — see _encode_avif_444 (shared with
                # the --fix-avif repair; mirrors aio-dl.py, KEEP IN SYNC).
                _encode_avif_444(im, avif_path, quality=color_quality,
                                 speed=avif_speed, max_threads=nthreads)
                candidates.append(
                    (os.path.getsize(avif_path), avif_path, "avif", False)
                )
            return candidates

    # Primary attempt at the capped thread budget, then single-threaded retries
    # for the rare transient encoder failure under cross-process load. Only a
    # persistent failure (corrupt page / missing encoder / decode bomb) falls
    # through to 'fail'. Mirrors aio-dl.py's serial mop-up (KEEP IN SYNC).
    candidates = None
    for _attempt, nthreads in enumerate((enc_threads, 1, 1)):
        try:
            candidates = _encode(nthreads)
            break
        except Exception:
            for _ext in (".jxl", ".avif"):
                try:
                    os.remove(base + _ext)
                except OSError:
                    pass
            if _attempt < 2:
                time.sleep(0.3 * (_attempt + 1))
                continue
            return src, "fail", orig_size, orig_size

    if candidates is None:
        return src, "skip", orig_size, orig_size

    candidates.sort(key=lambda c: c[0])
    best_size, best_path, best_action, best_is_recon = candidates[0]
    # Guard: adopt the new file only if it clears the savings threshold. Never
    # bloats, and self-corrects a gray→AVIF misroute (AVIF on line art ~95% > 0.92).
    # JPEG reconstructions are exempt (adopt iff strictly smaller): the candidate
    # is byte-recoverable, so unlike a lossy candidate there is no quality cost
    # to weigh a marginal saving against — 92-93%-ratio line-art JPEGs would
    # otherwise keep their originals for no benefit. Mirrors aio-dl.py.
    if best_size < orig_size * (1.0 if best_is_recon else min_saving):
        return best_path, best_action, orig_size, best_size
    return src, "kept", orig_size, orig_size


# ============================================================================
# CBZ + SERIES PROCESSING
# ============================================================================

# A CBZ's per-page outcomes. Top-level (picklable) so worker results pickle back.
_ACTIONS = ("jxl", "avif", "kept", "skip", "fail")


def _process_one_cbz(job: dict) -> dict:
    """Worker: transcode one chapter CBZ → out_cbz (atomic). Returns a stats dict.

    Preserves entry ORDER and non-image entries (ComicInfo.xml verbatim). Image
    entries are extracted to a temp file, run through the per-page core, and
    written back under the same stem with a possibly-new extension. Images are
    ZIP_STORED, non-images ZIP_DEFLATED — matching aio-dl.py:build_cbz (grep it).
    """
    in_cbz = job["in_cbz"]
    out_cbz = job["out_cbz"]
    dry = job["dry_run"]
    enc = job["enc"]
    st = {
        "series": job["series"],
        "name": os.path.basename(in_cbz),
        "orig": 0, "new": 0, "error": None,
    }
    for a in _ACTIONS:
        st[a] = 0

    tmp = tempfile.mkdtemp(prefix="modlib_")
    try:
        out_entries = []  # (arcname, data, compress_type) in original order
        with zipfile.ZipFile(in_cbz, "r") as zin:
            for i, info in enumerate(zin.infolist()):
                if info.is_dir():
                    continue
                name = info.filename
                data = zin.read(name)
                ext = os.path.splitext(name)[1].lower()
                if ext not in _IMAGE_EXTS:
                    # ComicInfo.xml and any other sidecar inside the archive →
                    # verbatim, DEFLATE (matches build_cbz's ComicInfo handling).
                    out_entries.append((name, data, zipfile.ZIP_DEFLATED))
                    continue
                page_path = os.path.join(tmp, "%06d%s" % (i, ext))
                with open(page_path, "wb") as f:
                    f.write(data)
                res_path, action, osz, nsz = _transcode_page_file(page_path, **enc)
                st[action] += 1
                st["orig"] += osz
                st["new"] += nsz
                if action in ("jxl", "avif"):
                    with open(res_path, "rb") as f:
                        new_data = f.read()
                    new_name = os.path.splitext(name)[0] + os.path.splitext(res_path)[1]
                    out_entries.append((new_name, new_data, zipfile.ZIP_STORED))
                else:
                    out_entries.append((name, data, zipfile.ZIP_STORED))

        if not dry:
            os.makedirs(os.path.dirname(out_cbz), exist_ok=True)
            tmp_out = out_cbz + ".tmp"
            with zipfile.ZipFile(tmp_out, "w", zipfile.ZIP_STORED) as zout:
                for arcname, data, ctype in out_entries:
                    zout.writestr(arcname, data, compress_type=ctype)
            os.replace(tmp_out, out_cbz)  # atomic: a crash mid-write never leaves a "done" CBZ
    except Exception as e:
        st["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return st


def _is_cbz(name: str) -> bool:
    return name.lower().endswith(".cbz")


def _build_jobs(args, enc: dict):
    """Walk the input tree → (jobs, n_series, n_skipped_resume). Copies sidecars
    (cover.jpg/details.json/.aio_series.json/.*_hid/etc.) verbatim as a side effect
    on a real run; dry-run touches nothing on disk."""
    in_root = os.path.abspath(args.in_root)
    out_root = os.path.abspath(args.out_root)
    series = sorted(
        d for d in os.listdir(in_root) if os.path.isdir(os.path.join(in_root, d))
    )
    if args.series:
        wants = [s.lower() for s in args.series]
        series = [s for s in series if any(w in s.lower() for w in wants)]
    if args.limit:
        series = series[: args.limit]

    jobs = []
    skipped = 0
    # Read-only preview (--plan) and projection (--dry-run) never touch disk in
    # the build phase — no series dirs, no sidecar copies. Only the resume
    # skip-check below runs, so --plan reports exactly what a resume would do.
    write = not (args.dry_run or args.plan)
    for s in series:
        sdir = os.path.join(in_root, s)
        odir = os.path.join(out_root, s)
        if write:
            os.makedirs(odir, exist_ok=True)
        for name in sorted(os.listdir(sdir)):
            sp = os.path.join(sdir, name)
            if not os.path.isfile(sp):
                continue
            if _is_cbz(name):
                op = os.path.join(odir, name)
                # Resume: an existing, up-to-date output CBZ is already converted.
                if (not args.force and os.path.exists(op)
                        and os.path.getmtime(op) >= os.path.getmtime(sp)):
                    skipped += 1
                    continue
                jobs.append({
                    "in_cbz": sp, "out_cbz": op,
                    "dry_run": args.dry_run, "enc": enc, "series": s,
                })
            elif write:
                # Sidecar (cover.jpg, details.json, .aio_series.json, .*_hid, …) →
                # copy verbatim. cover.jpg stays JPEG by design (HANDOFF: tiny,
                # used across UI/widget surfaces).
                op = os.path.join(odir, name)
                if (args.force or not os.path.exists(op)
                        or os.path.getmtime(op) < os.path.getmtime(sp)):
                    shutil.copy2(sp, op)
    return jobs, len(series), skipped


def _fmt(n: float) -> str:
    """Human-readable bytes."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return "%.1f %s" % (n, unit)
        n /= 1024.0


def _pct(new: int, orig: int) -> str:
    return "%.0f%%" % (100.0 * new / orig) if orig else "—"


# ============================================================================
# --avif-to-jxl : targeted repair of the 4:2:0-AVIF color pages
# ============================================================================
# The 2026-07-01 run wrote color pages as AVIF with Pillow's 4:2:0 default
# (chroma bleed — the bug fixed in aio-dl.py commit 88d8dd8). Under the locked
# "JXL everywhere, fully reversible" decision (handoff §4) the end-state has NO
# AVIF at all, so we repair those pages to JXL rather than to 4:4:4 AVIF.
#
# This is a TARGETED repair, NOT the full reversible re-run (handoff §6): the
# grayscale pages already in the tree are left as-is (they're already .jxl and
# re-doing ~95% of the library is the slow part the user wants to skip). Only
# CBZs that actually contain a .avif entry are touched; a pure-grayscale chapter
# is skipped after a single central-directory read. The grayscale pages stay at
# their original distance (d1 visually-lossless) — so after this repair the tree
# is bug-free and AVIF-free but NOT yet fully reversible; the §6 d0 rebuild (all
# pages) is still the path to a deletable backup.
#
# WHY re-encode from the ORIGINAL backup, not the in-tree AVIF: 4:2:0 already
# discarded the chroma; transcoding the AVIF can't recover it. The original
# JPEG/PNG in --src is the only faithful source. At --distance 0 a color JPEG
# becomes a bit-exact reconstruction (reversible) and a color PNG pixel-lossless
# — identical to what a fresh fixed run would emit for those pages, via the SAME
# _transcode_page_file(policy="jxl") path the grayscale pages use.

def _repair_one_cbz(job: dict) -> dict:
    """Worker: rebuild ONE modernized CBZ in place, replacing every .avif color
    page with a JXL re-encoded from the ORIGINAL page in the --src backup CBZ.

    Grayscale .jxl pages, kept .jpg/.webp originals, ComicInfo.xml and _aio/
    members are copied VERBATIM (blob copy — no decode), so the already-correct
    grayscale work and the audio/motion sidecars can't be perturbed. Atomic
    (temp + os.replace): a crash mid-write never leaves a half-written CBZ, and
    the pristine backup is the ultimate floor.
    """
    in_cbz = job["in_cbz"]
    src_cbz = job["src_cbz"]
    enc = job["enc"]          # policy="jxl", gray_quality=distance, ...
    dry = job["dry_run"]
    st = {
        "series": job["series"], "name": os.path.basename(in_cbz),
        "avif": 0, "jxl": 0, "reverted": 0, "no_source": 0,
        "orig": 0, "new": 0, "error": None,
    }
    tmp = tempfile.mkdtemp(prefix="modfix_")
    try:
        with zipfile.ZipFile(in_cbz, "r") as zin:
            entries = [
                (i.filename, i.compress_type, zin.read(i.filename))
                for i in zin.infolist() if not i.is_dir()
            ]
        # Which page stems need an original? (root-level .avif entries; an _aio/
        # audio member could in principle end .avif in the future — exclude it.)
        need = {
            os.path.splitext(os.path.basename(n))[0].lower()
            for (n, _c, _d) in entries
            if n.lower().endswith(".avif") and not n.startswith("_aio/")
        }
        # Read ONLY those originals from the backup CBZ (one open).
        src_by_stem = {}  # stem_lower -> (entry_name, bytes)
        with zipfile.ZipFile(src_cbz, "r") as zsrc:
            picks = {}
            for i in zsrc.infolist():
                if i.is_dir():
                    continue
                n = i.filename
                if "/" in n.replace("\\", "/"):
                    continue  # originals are flat; ignore any nested entry
                stem, ext = os.path.splitext(os.path.basename(n))
                if ext.lower() in _IMAGE_EXTS and stem.lower() in need:
                    picks[stem.lower()] = n
            for stem, n in picks.items():
                src_by_stem[stem] = (n, zsrc.read(n))

        out_entries = []  # (arcname, data, compress_type) — original order
        for name, ctype, data in entries:
            if name.lower().endswith(".avif") and not name.startswith("_aio/"):
                st["avif"] += 1
                stem = os.path.splitext(os.path.basename(name))[0].lower()
                pick = src_by_stem.get(stem)
                if pick is None:
                    # No original to repair from (e.g. a chapter added after the
                    # backup snapshot). Keep the existing 4:2:0 AVIF — can't do
                    # better without the source.
                    st["no_source"] += 1
                    out_entries.append((name, data, zipfile.ZIP_STORED))
                    continue
                src_name, src_bytes = pick
                src_ext = os.path.splitext(src_name)[1].lower()
                page_path = os.path.join(tmp, stem + src_ext)
                with open(page_path, "wb") as f:
                    f.write(src_bytes)
                # SAME encode path as the grayscale pages — policy="jxl" forces
                # JXL for this color page; gray_quality=0 → reconstruction
                # (JPEG) / pixel-lossless (PNG), guard-exempt for JPEG recon.
                res_path, action, osz, nsz = _transcode_page_file(page_path, **enc)
                with open(res_path, "rb") as f:
                    new_data = f.read()
                out_name = os.path.splitext(name)[0] + os.path.splitext(res_path)[1]
                out_entries.append((out_name, new_data, zipfile.ZIP_STORED))
                st["orig"] += osz
                st["new"] += nsz
                if action == "jxl":
                    st["jxl"] += 1
                else:
                    # guard failed / skip / fail → the original page bytes are
                    # written back (faithful; .avif reverts to .jpg/.png).
                    st["reverted"] += 1
                for p in {page_path, res_path}:
                    try:
                        os.remove(p)
                    except OSError:
                        pass
            else:
                out_entries.append((name, data, ctype))  # verbatim

        if not dry:
            tmp_out = in_cbz + ".fixtmp"
            with zipfile.ZipFile(tmp_out, "w", zipfile.ZIP_STORED) as zout:
                for arc, d, ct in out_entries:
                    zout.writestr(arc, d, compress_type=ct)
            os.replace(tmp_out, in_cbz)  # atomic in-place swap
    except Exception as e:
        st["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return st


def _build_repair_jobs(args, enc: dict, done_set: set):
    """Walk --in → repair jobs. Skips (fast, one central-dir read) any CBZ with
    no .avif entry, anything already in the resume log, and anything whose
    original backup CBZ is missing. Returns (jobs, stats); stats also carries
    no_src_list (rel paths of CBZs with AVIF but no backup) and missing_series
    (series whose ENTIRE folder is absent from --src)."""
    in_root = os.path.abspath(args.in_root)
    src_root = os.path.abspath(args.src_root)
    series = sorted(
        d for d in os.listdir(in_root) if os.path.isdir(os.path.join(in_root, d))
    )
    if args.series:
        wants = [s.lower() for s in args.series]
        series = [s for s in series if any(w in s.lower() for w in wants)]
    if args.limit:
        series = series[: args.limit]

    jobs = []
    stats = {"series": len(series), "cbz": 0, "no_avif": 0, "done": 0,
             "no_src": 0, "no_src_list": [], "missing_series": []}
    missing_series = set()  # series whose ENTIRE folder is absent from the backup
    for s in series:
        sdir = os.path.join(in_root, s)
        src_series_dir = os.path.join(src_root, s)
        src_series_exists = os.path.isdir(src_series_dir)
        for name in sorted(os.listdir(sdir)):
            sp = os.path.join(sdir, name)
            if not (os.path.isfile(sp) and _is_cbz(name)):
                continue
            stats["cbz"] += 1
            rel = os.path.join(s, name)
            if not args.force and rel in done_set:
                stats["done"] += 1
                continue
            try:
                with zipfile.ZipFile(sp, "r") as z:
                    has_avif = any(
                        e.lower().endswith(".avif") and not e.startswith("_aio/")
                        for e in z.namelist()
                    )
            except (zipfile.BadZipFile, OSError):
                has_avif = False
            if not has_avif:
                stats["no_avif"] += 1
                continue
            src_cbz = os.path.join(src_series_dir, name)
            if not os.path.isfile(src_cbz):
                # AVIF pages but nothing to repair from. Record the exact CBZ (and
                # whether its whole series is missing) so the projection/real run
                # can name them instead of just counting — see _print_missing_backups.
                stats["no_src"] += 1
                stats["no_src_list"].append(rel)
                if not src_series_exists:
                    missing_series.add(s)
                continue
            jobs.append({
                "in_cbz": sp, "src_cbz": src_cbz, "enc": enc,
                "dry_run": args.dry_run, "series": s, "rel": rel,
            })
    stats["missing_series"] = sorted(missing_series)
    return jobs, stats


def _print_missing_backups(stats) -> None:
    """List CBZs that have AVIF pages but no backup original to repair from,
    grouped by series. Flags a whole-series gap (the entire folder is absent from
    --src — that series was never backed up) distinctly from a lone missing
    chapter (a chapter added after the backup snapshot). This is the precise
    answer to 'which series have no original CBZ'; printed in BOTH the projection
    and the real run so the skipped CBZs are always named, never just counted."""
    no_src_list = stats.get("no_src_list") or []
    if not no_src_list:
        return
    missing_series = set(stats.get("missing_series") or [])
    by_series = defaultdict(list)
    for rel in no_src_list:
        by_series[os.path.dirname(rel)].append(os.path.basename(rel))
    print("  [!] %d CBZ(s) have AVIF pages but NO matching backup — left untouched "
          "(can't repair 4:2:0 without the pristine original):" % len(no_src_list))
    for i, s in enumerate(sorted(by_series)):
        if i >= 40:
            print("      … and %d more series" % (len(by_series) - 40))
            break
        chaps = sorted(by_series[s])
        if s in missing_series:
            print("      %-45s ENTIRE series folder missing from backup (%d CBZ)"
                  % (s[:45], len(chaps)))
        else:
            preview = ", ".join(chaps[:6]) + (" …" if len(chaps) > 6 else "")
            print("      %-45s %d not in backup: %s" % (s[:45], len(chaps), preview))
    print()


def _run_avif_to_jxl(args) -> int:
    """--avif-to-jxl driver. See the section header above for the design."""
    if not _HAVE_JXL:
        sys.exit("error: --avif-to-jxl needs the JXL encoder. "
                 "pip install pillow-jxl-plugin.")
    if not args.src_root:
        sys.exit("error: --avif-to-jxl requires --src <original backup tree> "
                 "(the pristine JPEG/PNG pages to re-encode color from).")
    in_root = os.path.abspath(args.in_root)
    src_root = os.path.abspath(args.src_root)
    if not os.path.isdir(in_root):
        sys.exit("error: --in not found: %s" % in_root)
    if not os.path.isdir(src_root):
        sys.exit("error: --src not found: %s" % src_root)
    if os.path.normcase(in_root) == os.path.normcase(src_root):
        sys.exit("error: --in and --src must differ (--src is the pristine "
                 "backup; --in is the modernized tree being repaired in place).")

    # Force JXL for the color pages. gray_quality carries the JXL distance; 0.0
    # is the reversible default (JPEG reconstruction / PNG pixel-lossless).
    enc = dict(
        policy="jxl", gray_quality=args.distance, color_quality=args.quality,
        min_saving=args.min_saving, effort=args.effort, avif_speed=args.avif_speed,
        # Cap each encode's internal pool so jobs*enc_threads ~= cpu (the
        # ProcessPool already fans out across CBZs); avoids the libjxl
        # oversubscription failure. Grep enc_threads. jobs defaults to cpu → 1.
        enc_threads=max(1, (os.cpu_count() or 4) // max(1, args.jobs)),
    )

    resume_log = args.resume_log or os.path.join(
        os.path.dirname(in_root) or ".", "_avif_to_jxl_progress.log"
    )
    done_set = set()
    if not args.force and os.path.isfile(resume_log):
        try:
            with open(resume_log, "r", encoding="utf-8") as fh:
                done_set = {ln.strip() for ln in fh if ln.strip()}
        except OSError:
            pass

    print("== modernize_library --avif-to-jxl (repair 4:2:0 color pages → JXL) ==")
    print("  in (repaired in place): %s%s"
          % (in_root, "   (DRY-RUN: nothing written)" if args.dry_run else ""))
    print("  src (original backup):  %s" % src_root)
    print("  JXL distance=%s (0.0 = reversible: JPEG reconstruction / PNG "
          "pixel-lossless) | effort=%d | min-saving=%.2f | jobs=%d"
          % (args.distance, args.effort, args.min_saving, args.jobs))
    if args.distance != 0.0:
        print("  [!] distance=%s is LOSSY — repaired color pages will NOT be "
              "reversible. Use --distance 0 for the archival/reversible policy."
              % args.distance)
    print("  resume log: %s (%d already done)\n"
          % (resume_log, len(done_set)))

    jobs, stats = _build_repair_jobs(args, enc, done_set)
    print("  series: %d | CBZs: %d | with AVIF to fix: %d | "
          "no-AVIF skipped: %d | already done: %d | missing backup: %d\n"
          % (stats["series"], stats["cbz"], len(jobs), stats["no_avif"],
             stats["done"], stats["no_src"]))
    _print_missing_backups(stats)

    # --dry-run / --plan is a FAST projection here, and exits BEFORE the pool.
    # DELIBERATELY unlike the normal transcode path, whose --dry-run still encodes
    # every page to measure exact bytes: the repair preview must not churn through
    # thousands of CBZs doing full JXL encodes (that's the whole slow run). Every-
    # thing worth previewing — how many CBZs get touched, which lack a backup —
    # already came from _build_repair_jobs's cheap central-directory reads. Re-run
    # without the flag to actually repair (in-place, atomic per-CBZ, resumable).
    if args.dry_run or args.plan:
        print("Projection only — nothing encoded or written. %d CBZ(s) would be "
              "repaired; re-run without --dry-run/--plan to do it." % len(jobs))
        return 0

    if not jobs:
        print("Nothing to do.")
        return 0

    tot = {"avif": 0, "jxl": 0, "reverted": 0, "no_source": 0,
           "orig": 0, "new": 0, "cbz": 0, "errors": 0}
    errors = []
    t0 = time.time()
    done = 0
    _tty = sys.stdout.isatty()
    last_print = 0.0
    log_fh = None
    if not args.dry_run:
        log_fh = open(resume_log, "a", encoding="utf-8")

    try:
        with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as ex:
            futs = {ex.submit(_repair_one_cbz, j): j for j in jobs}
            for fut in as_completed(futs):
                j = futs[fut]
                st = fut.result()
                done += 1
                tot["cbz"] += 1
                for k in ("avif", "jxl", "reverted", "no_source", "orig", "new"):
                    tot[k] += st[k]
                if st["error"]:
                    tot["errors"] += 1
                    errors.append("%s / %s : %s" % (st["series"], st["name"], st["error"]))
                elif log_fh is not None:
                    log_fh.write(j["rel"] + "\n")
                    log_fh.flush()

                now = time.time()
                elapsed = now - t0
                rate = done / elapsed if elapsed else 0
                eta = (len(jobs) - done) / rate if rate else 0
                line = ("[%d/%d] %-30.30s  %-22.22s  fixed %d avif→jxl (%d rev)  "
                        "%.1f cbz/s  ETA %dm%02ds"
                        % (done, len(jobs), st["series"][:30], st["name"][:22],
                           tot["jxl"], tot["reverted"], rate,
                           int(eta) // 60, int(eta) % 60))
                if _tty:
                    sys.stdout.write("\r" + line + "   ")
                    sys.stdout.flush()
                elif now - last_print >= 5 or done == len(jobs):
                    print(line, flush=True)
                    last_print = now
                if st["error"]:
                    print("\n  [!] %s / %s: %s"
                          % (st["series"], st["name"], st["error"]), flush=True)
    finally:
        if log_fh is not None:
            log_fh.close()

    saved = tot["orig"] - tot["new"]
    print("\n\n== TOTAL (--avif-to-jxl) ==")
    print("  CBZs repaired: %d   AVIF pages seen: %d"
          % (tot["cbz"], tot["avif"]))
    print("  %d → JXL, %d reverted to original (guard), %d kept 4:2:0 (no backup source)"
          % (tot["jxl"], tot["reverted"], tot["no_source"]))
    print("  color bytes: %s → %s   (%s of the originals, saved %s)"
          % (_fmt(tot["orig"]), _fmt(tot["new"]), _pct(tot["new"], tot["orig"]),
             _fmt(saved)))
    if tot["errors"]:
        print("\n  %d CBZ(s) errored (left untouched — atomic write):" % tot["errors"])
        for e in errors[:20]:
            print("    [!] %s" % e)
        if len(errors) > 20:
            print("    ... and %d more" % (len(errors) - 20))
    print("\n  %.0fs elapsed%s" % (time.time() - t0,
          "  (DRY-RUN — no files written)" if args.dry_run else ""))
    return 1 if tot["errors"] else 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="modernize_library.py",
        description="Batch-transcode a manga CBZ library to JXL (B&W) / AVIF "
                    "(color), keeping originals untouched in a parallel tree.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--in", dest="in_root", default=r"D:\AIO\manga",
                    help="Input library root (contains <Series>/*.cbz folders).")
    ap.add_argument("--out", dest="out_root", default=r"D:\AIO\manga-jxl",
                    help="Output root (parallel tree; originals are never modified).")
    ap.add_argument("--policy", choices=["auto", "jxl", "avif", "jxl+avif"],
                    default="auto",
                    help="Codec routing. auto = JXL for grayscale, AVIF for color.")
    ap.add_argument("--distance", type=float, default=1.0,
                    help="JXL Butteraugli distance for grayscale pages "
                         "(1.0 ~ visually lossless; 0.0 = mathematically lossless).")
    ap.add_argument("--quality", type=int, default=90,
                    help="AVIF quality for color pages (90 ~ visually lossless; 85 aggressive).")
    ap.add_argument("--min-saving", dest="min_saving", type=float, default=0.92,
                    help="Keep a transcoded page only if its size < orig * this "
                         "(0.92 = must save >=8%%); else the original bytes are kept. "
                         "1.0 = disable the threshold (adopt on any strict size "
                         "reduction, however small; still never adopts a same-size "
                         "or bigger candidate).")
    ap.add_argument("--effort", type=int, default=8,
                    help="JXL effort 1-9. Default 8 matches 9's size at ~1.5x the "
                         "speed; 9 is a CPU trap (~7.5x e7's time for ~5%% size). "
                         "pillow_jxl rejects >9.")
    ap.add_argument("--avif-speed", dest="avif_speed", type=int, default=4,
                    help="AVIF speed 0-10 (lower = smaller/slower).")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4,
                    help="Parallel worker processes (one chapter per worker).")
    ap.add_argument("--series", action="append", default=None,
                    help="Only process series whose name contains this (repeatable).")
    ap.add_argument("--limit", type=int, default=None,
                    help="Process only the first N series (sampling/testing).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Transcode + measure but write nothing — projection only.")
    ap.add_argument("--plan", action="store_true",
                    help="Preview only: report how many chapters would convert vs are "
                         "already done (the resume check), then exit without transcoding "
                         "or writing anything. Use to verify a resume before committing.")
    ap.add_argument("--force", action="store_true",
                    help="Re-convert even if an up-to-date output already exists.")
    # ── Targeted repair mode (see the _run_avif_to_jxl section header) ──
    ap.add_argument("--avif-to-jxl", dest="avif_to_jxl", action="store_true",
                    help="REPAIR MODE (not the normal transcode): rebuild only the "
                         "CBZs in --in that contain .avif pages, replacing each with "
                         "a JXL re-encoded from the original page in --src. Grayscale "
                         ".jxl / kept originals / ComicInfo / _aio/ are copied "
                         "verbatim; pure-grayscale chapters are skipped instantly. "
                         "In place, atomic, resumable. Use --distance 0 for the "
                         "reversible policy. Fixes the 4:2:0-AVIF chroma bug without "
                         "the full re-run. --dry-run/--plan give a FAST projection "
                         "(which CBZs get touched, which lack a backup) without "
                         "encoding anything.")
    ap.add_argument("--src", dest="src_root", default=None,
                    help="(--avif-to-jxl only) Pristine original tree "
                         "(e.g. D:\\AIO\\manga_ORIGINAL_backup) supplying the "
                         "color pages to re-encode from. MUST differ from --in.")
    ap.add_argument("--resume-log", dest="resume_log", default=None,
                    help="(--avif-to-jxl only) Progress file of completed CBZs "
                         "(default: <parent of --in>\\_avif_to_jxl_progress.log). "
                         "Re-runs skip logged CBZs; delete it to start over.")
    args = ap.parse_args()

    # Targeted repair is a separate pipeline (two input trees, page-level splice).
    if args.avif_to_jxl:
        return _run_avif_to_jxl(args)

    # Encoder availability — fail fast (like A1's '--modernize compatibility checks').
    if args.policy != "avif" and not _HAVE_JXL:
        sys.exit("error: --policy %s needs the JXL encoder. "
                 "pip install pillow-jxl-plugin (or use --policy avif)." % args.policy)
    if args.policy in ("auto", "avif", "jxl+avif") and "AVIF" not in Image.SAVE:
        sys.exit("error: AVIF write support missing. Pillow >= 12 has it natively "
                 "(or: pip install pillow-avif-plugin).")
    if not os.path.isdir(args.in_root):
        sys.exit("error: input not found: %s" % args.in_root)

    enc = dict(
        policy=args.policy, gray_quality=args.distance, color_quality=args.quality,
        min_saving=args.min_saving, effort=args.effort, avif_speed=args.avif_speed,
        # Cap each encode's internal pool so jobs*enc_threads ~= cpu (the
        # ProcessPool already fans out across CBZs); avoids the libjxl
        # oversubscription failure. Grep enc_threads. jobs defaults to cpu → 1.
        enc_threads=max(1, (os.cpu_count() or 4) // max(1, args.jobs)),
    )

    print("== modernize_library ==")
    print("  in:     %s" % os.path.abspath(args.in_root))
    print("  out:    %s%s" % (os.path.abspath(args.out_root),
                              "   (PLAN: preview only)" if args.plan
                              else "   (DRY-RUN: nothing written)" if args.dry_run else ""))
    print("  policy: %s  | JXL d=%s effort=%d | AVIF q=%d speed=%d | min-saving=%.2f | jobs=%d"
          % (args.policy, args.distance, args.effort, args.quality,
             args.avif_speed, args.min_saving, args.jobs))

    jobs, n_series, skipped_resume = _build_jobs(args, enc)
    print("  series: %d  | chapters to convert: %d  | already up-to-date (skipped): %d\n"
          % (n_series, len(jobs), skipped_resume))
    if args.plan:
        print("Plan only — nothing written. Re-run without --plan to convert the "
              "%d remaining chapter(s); the %d already done will be skipped."
              % (len(jobs), skipped_resume))
        return 0
    if not jobs:
        print("Nothing to do.")
        return 0

    per_series = defaultdict(lambda: {k: 0 for k in ("orig", "new", *_ACTIONS, "chapters")})
    tot = {k: 0 for k in ("orig", "new", *_ACTIONS, "chapters", "errors")}
    errors = []
    t0 = time.time()
    done = 0
    _tty = sys.stdout.isatty()  # \r live-overwrite on a terminal; newline lines when logged
    last_print = 0.0

    # Process pool across chapters (encoding is CPU-bound; pages run sequentially
    # within each worker so N processes == N cores, no thread oversubscription).
    with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as ex:
        futs = [ex.submit(_process_one_cbz, j) for j in jobs]
        for fut in as_completed(futs):
            st = fut.result()
            done += 1
            s = st["series"]
            ps = per_series[s]
            ps["chapters"] += 1
            tot["chapters"] += 1
            for k in ("orig", "new", *_ACTIONS):
                ps[k] += st[k]
                tot[k] += st[k]
            if st["error"]:
                tot["errors"] += 1
                errors.append("%s / %s : %s" % (s, st["name"], st["error"]))

            # Live progress: ratio so far + rate + ETA. On a TTY, overwrite one
            # line with \r; when logged/piped (non-TTY), emit newline-terminated
            # lines throttled to ~5s so a background run's log stays small and
            # readable (cumulative totals mean a throttled-away tick loses nothing).
            now = time.time()
            elapsed = now - t0
            rate = done / elapsed if elapsed else 0
            eta = (len(jobs) - done) / rate if rate else 0
            saved = tot["orig"] - tot["new"]
            line = ("[%d/%d] %-26.26s  %-22.22s  running %s (saved %s)  %.1f ch/s  ETA %dm%02ds"
                    % (done, len(jobs), s[:26], st["name"][:22],
                       _pct(tot["new"], tot["orig"]), _fmt(saved),
                       rate, int(eta) // 60, int(eta) % 60))
            if _tty:
                sys.stdout.write("\r" + line + "   ")
                sys.stdout.flush()
            elif now - last_print >= 5 or done == len(jobs):
                print(line, flush=True)
                last_print = now
            if st["error"]:
                print("  [!] %s / %s: %s" % (s, st["name"], st["error"]), flush=True)

    print("\n\n== per-series ==")
    for s in sorted(per_series):
        ps = per_series[s]
        print("  %-40.40s %8s -> %8s  %4s  | jxl %d avif %d kept %d skip %d fail %d  (%d ch)"
              % (s[:40], _fmt(ps["orig"]), _fmt(ps["new"]), _pct(ps["new"], ps["orig"]),
                 ps["jxl"], ps["avif"], ps["kept"], ps["skip"], ps["fail"], ps["chapters"]))

    pages = sum(tot[a] for a in _ACTIONS)
    saved = tot["orig"] - tot["new"]
    print("\n== TOTAL ==")
    print("  chapters: %d   pages: %d" % (tot["chapters"], pages))
    print("  pages: %d -> JXL, %d -> AVIF, %d kept (guard), %d skipped (no headroom), %d failed"
          % (tot["jxl"], tot["avif"], tot["kept"], tot["skip"], tot["fail"]))
    print("  image bytes: %s -> %s   (%s of original, saved %s)"
          % (_fmt(tot["orig"]), _fmt(tot["new"]), _pct(tot["new"], tot["orig"]), _fmt(saved)))
    if tot["errors"]:
        print("\n  %d chapter(s) errored:" % tot["errors"])
        for e in errors[:20]:
            print("    [!] %s" % e)
        if len(errors) > 20:
            print("    ... and %d more" % (len(errors) - 20))
    print("\n  %.0fs elapsed%s" % (time.time() - t0,
          "  (DRY-RUN — no files written)" if args.dry_run else ""))
    return 1 if tot["errors"] else 0


if __name__ == "__main__":
    # Guard required so ProcessPoolExecutor workers (spawn on Windows) re-import
    # this module without re-running main().
    sys.exit(main())
