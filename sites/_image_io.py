"""Image-format sniffing + atomic-finalize helpers, shared between aio-dl.py
and per-site handlers that implement their own image fetcher.

What this module owns:
  - Magic-byte detection for JPEG / PNG / GIF / WebP / AVIF / HEIC.
  - Content-Type fallback when magic is ambiguous.
  - Header-only pixel-dimension sniffing (`sniff_image_dimensions`) + a
    `looks_like_real_image()` validity predicate that rescues legitimately tiny
    images from the download/probe byte-size gate (see that function's docstring).
  - `finalize_pending_image()`: atomic-rename a `.pending_<base>` tempfile to
    `<folder>/<base><ext>` once bytes have landed.

What reads from it:
  - `aio-dl.py:dl_image` (the main download path) — uses both helpers.
  - `aio-dl.py:_start_image_prefetch._worker` and Phase 1/2 binary classification.
  - `sites/base.py:BaseSiteHandler.fast_download_images` (the shared curl_cffi
    async path; mangafire/linewebtoon/etc. inherit it) — uses
    `finalize_pending_image` per page and `looks_like_real_image` as its 200-OK
    body gate; the quality-probe + cover fetchers use `looks_like_real_image` too.

Why a separate module: `aio-dl.py` is at the top of the import graph (it
imports from `sites/`); `sites/mangafire.py` cannot import from `aio-dl.py`
without a circular dep. Pulling the helpers out into a leaf module is the
minimum-blast-radius refactor.

Originally lived in aio-dl.py at lines 808-881 (Phase A, 2026-05-07). Module
extracted 2026-05-09 to share with MangaFire's fast download path.
"""
from __future__ import annotations

import os
import struct
from typing import Optional, Tuple

# Magic-byte prefixes. Hex-readable comments inline.
JPEG_MAGIC = b"\xff\xd8"           # SOI marker
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"   # ISO 15948 §5.2 file signature
GIF_MAGIC = b"GIF8"                # both GIF87a and GIF89a
# WebP/AVIF/HEIC use ISO BMFF / RIFF containers — checked via byte ranges.


def content_type_to_ext(content_type: str) -> Optional[str]:
    """Map an `image/*` Content-Type to a file extension. Returns None for
    unrecognized types so the caller falls back to a default. The mapping
    intentionally normalizes `image/jpg` → `.jpg` even though it's not the
    IANA-registered name (some CDNs send it)."""
    return {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/avif": ".avif",
        "image/heic": ".heic",
        "image/heif": ".heic",
        "image/gif": ".gif",
    }.get((content_type or "").strip().lower())


def sniff_image_extension(head: bytes, content_type: Optional[str] = None) -> str:
    """Return the most accurate file extension (with leading dot) for an image
    given its first ≥12 bytes and an optional Content-Type. Magic bytes are
    primary; Content-Type is consulted only when magic is ambiguous. Falls
    back to `.jpg` so callers always get a usable extension (matches prior
    blanket-`.jpg` behavior for unknown content)."""
    if head:
        if head.startswith(JPEG_MAGIC):
            return ".jpg"
        if head.startswith(PNG_MAGIC):
            return ".png"
        if head.startswith(GIF_MAGIC):
            return ".gif"
        # WebP: bytes 0-3 = 'RIFF', bytes 8-11 = 'WEBP'.
        if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return ".webp"
        # AVIF/HEIC: ISO-BMFF "ftyp" box. Major brand at offset 8-11 tells
        # us the codec family. We only special-case AVIF; HEIC is rare in
        # manga aggregators but recognized so we don't accidentally label
        # it `.jpg`.
        if len(head) >= 12 and head[4:8] == b"ftyp":
            major = head[8:12]
            if major in (b"avif", b"avis"):
                return ".avif"
            if major in (b"heic", b"heix", b"mif1", b"msf1"):
                return ".heic"
    fallback = content_type_to_ext(
        (content_type or "").split(";", 1)[0]
    )
    return fallback or ".jpg"


# --- Dimension sniffing + image-validity predicate --------------------------
# WHY this exists: the fast-download path and the search-quality probes used to
# reject any HTTP-200 body under _MIN_IMAGE_BYTES as junk. That false-positives
# on legitimately tiny images — an 800x40 LINE-Webtoon divider bar compresses to
# ~128 bytes, and one such page tripping the gate aborted a whole 216-chapter
# run (bench/webtoonCanvasShelterLogs.md, Shelter ch.45: 50/51 pages, host
# swebtoon-phinf, 3 futile inline retries, then FATAL). A valid, decodable image
# with sane dimensions is real regardless of byte size. Callers: grep
# looks_like_real_image across sites/base.py.
_MIN_IMAGE_BYTES = 256  # bodies >= this accept without a decode (prior behavior; zero-regression)


def sniff_image_dimensions(head: bytes) -> Optional[Tuple[int, int]]:
    """Best-effort (width, height) in pixels from an image's leading header
    bytes, WITHOUT decoding pixel data or importing Pillow. Returns None when
    the bytes are not a recognized raster image or the header is too short /
    malformed to parse.

    Formats: PNG, GIF, JPEG, WebP (VP8 / VP8L / VP8X), BMP — the set served on
    manga/webtoon image CDNs. AVIF/HEIC (ISO-BMFF) are intentionally NOT parsed:
    their container overhead means they never appear as sub-256-byte bodies, so
    the byte-size fast-accept in looks_like_real_image() already covers them.
    """
    try:
        n = len(head)
        if n < 10:  # shortest parseable header is GIF's 10 bytes
            return None
        # PNG: 8-byte signature, then the IHDR chunk — width/height are the
        # first two big-endian uint32s of its data (offsets 16 and 20).
        if head[:8] == PNG_MAGIC:
            if n >= 24 and head[12:16] == b"IHDR":
                w, h = struct.unpack(">II", head[16:24])
                return (int(w), int(h))
            return None
        # GIF: logical-screen width/height as little-endian uint16 at offset 6.
        if head[:4] == GIF_MAGIC:
            w, h = struct.unpack("<HH", head[6:10])
            return (int(w), int(h))
        # BMP: BITMAPINFOHEADER width/height as little-endian int32 at 18/22
        # (height may be negative for top-down bitmaps → abs()).
        if head[:2] == b"BM" and n >= 26:
            w, h = struct.unpack("<ii", head[18:26])
            return (abs(int(w)), abs(int(h)))
        # WebP: RIFF container; the fourcc at offset 12 selects the codec, each
        # of which packs the canvas dimensions differently.
        if n >= 30 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            fourcc = head[12:16]
            if fourcc == b"VP8 ":  # lossy keyframe: 14-bit dims after the 0x9d012a start code
                w = struct.unpack("<H", head[26:28])[0] & 0x3FFF
                h = struct.unpack("<H", head[28:30])[0] & 0x3FFF
                return (int(w), int(h))
            if fourcc == b"VP8L":  # lossless: 14-bit (w-1, h-1) packed after the 0x2f signature byte
                b0, b1, b2, b3 = head[21], head[22], head[23], head[24]
                w = (((b1 & 0x3F) << 8) | b0) + 1
                h = (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)) + 1
                return (int(w), int(h))
            if fourcc == b"VP8X":  # extended: 24-bit (w-1, h-1) canvas size at offset 24
                w = (head[24] | (head[25] << 8) | (head[26] << 16)) + 1
                h = (head[27] | (head[28] << 8) | (head[29] << 16)) + 1
                return (int(w), int(h))
            return None
        # JPEG: walk marker segments to the first Start-Of-Frame (it carries dims).
        if head[:2] == JPEG_MAGIC:
            return _sniff_jpeg_dimensions(head)
    except Exception:
        return None
    return None


def _sniff_jpeg_dimensions(head: bytes) -> Optional[Tuple[int, int]]:
    """Scan JPEG marker segments for the Start-Of-Frame that carries the image
    dimensions (precision:1, height:2, width:2 after the segment length).
    Returns None if no SOF is reached within the available bytes (e.g. a body
    truncated before the frame header)."""
    n = len(head)
    i = 2  # skip the SOI marker (0xFFD8)
    while i + 9 <= n:
        if head[i] != 0xFF:
            i += 1
            continue
        marker = head[i + 1]
        if marker == 0xFF:  # padding fill bytes between segments
            i += 1
            continue
        # Standalone markers with no length payload: SOI/EOI, RSTn, TEM.
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = struct.unpack(">H", head[i + 2:i + 4])[0]
        # SOF0..SOF15 carry dimensions; exclude DHT(C4), JPG(C8), DAC(CC), which
        # share the 0xC0..0xCF range but are not frame headers.
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h = struct.unpack(">H", head[i + 5:i + 7])[0]
            w = struct.unpack(">H", head[i + 7:i + 9])[0]
            return (int(w), int(h))
        if seg_len < 2:
            return None  # malformed length would loop forever; bail
        i += 2 + seg_len
    return None


def looks_like_real_image(data: bytes, min_bytes: int = _MIN_IMAGE_BYTES) -> bool:
    """Does `data` look like a real, downloadable image, as opposed to a CDN
    error stub, an HTML/JSON error body, or a 1x1 tracking pixel?

    Policy:
      - Empty -> False.
      - len >= min_bytes -> True. Preserves the historical `len(body) >= 256`
        accept threshold verbatim, so nothing that used to download is newly
        rejected (no regression on large/unusual formats we don't dimension-parse,
        e.g. AVIF/HEIC).
      - len < min_bytes -> True ONLY if the bytes decode (by header) to a
        recognized image larger than a single pixel. This rescues legitimately
        tiny images (divider bars, thin spacers) while still rejecting sub-256-byte
        junk: HTML/JSON stubs and truncated bodies fail the format sniff, and 1x1
        tracking pixels fail the area check.

    See bench/webtoonCanvasShelterLogs.md for the run this fixes.
    """
    if not data:
        return False
    if len(data) >= min_bytes:
        return True
    dims = sniff_image_dimensions(data)
    if dims is None:
        return False
    w, h = dims
    return (w * h) >= 2  # reject the 1x1 tracking-pixel / error-stub shape


def finalize_pending_image(
    pending_path: str, folder: str, base: str, content_type: Optional[str]
) -> Optional[str]:
    """Sniff a successfully-downloaded pending file's first bytes, atomic-
    rename it to `<folder>/<base><ext>`, and return the final path. Returns
    None if the pending file is missing (caller should treat as failure).
    `os.replace` is atomic on both POSIX and NT when source/dest share a
    volume — pending and final live in the same folder, so this is safe."""
    if not os.path.exists(pending_path):
        return None
    try:
        with open(pending_path, "rb") as fh:
            head = fh.read(32)
    except Exception:
        head = b""
    ext = sniff_image_extension(head, content_type)
    final_path = os.path.join(folder, base + ext)
    os.replace(pending_path, final_path)
    return final_path
