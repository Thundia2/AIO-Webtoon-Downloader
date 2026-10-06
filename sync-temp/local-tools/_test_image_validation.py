"""Offline regression: image-body validation in sites/_image_io.py.

The bug this locks down: manhuaplus' older chapters point at
`*.files.wordpress.com`, a retired host that answers **HTTP 200 +
`Content-Type: text/html` + a ~19 KB HTML error page** for every image URL.
`looks_like_real_image` short-circuited on `len(data) >= 256` with no format
check, so 15 HTML documents landed in the CBZ named 0001.jpg and every page
rendered as a broken-image dot.

The fix must be surgical: the size fast-accept is ALSO what keeps formats we
don't dimension-parse (AVIF/HEIC/JXL) working, and the sub-256-byte dimension
path is the LINE-Webtoon divider-bar rescue (bench/webtoonCanvasShelterLogs.md,
an 800x40 bar compresses to ~128 B and a whole 216-chapter run died on it). So
the suite asserts both directions: markup/JSON rejected at any size, every real
format still accepted, tiny-but-real still accepted, 1x1 still rejected.

Sibling with a confusingly similar name: `tools/_test_image_validity.py` is the
OLDER suite and covers the same function from the other side — it needs Pillow,
encodes real images in every format, and checks `sniff_image_dimensions` against
Pillow's ground truth. This one is Pillow-free (hand-built byte headers), owns
the reject side plus `finalize_pending_image`'s delete-on-reject contract. Run
BOTH after touching sites/_image_io.py.

Run: python tools/_test_image_validation.py   (offline, no network)
"""

import os
import shutil
import struct
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from sites._image_io import (  # noqa: E402
    describe_invalid_image,
    finalize_pending_image,
    image_magic_extension,
    looks_like_real_image,
    sniff_image_dimensions,
    sniff_image_extension,
)

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  [PASS] {name}")
        return
    FAILURES.append(f"{name}: {detail}")
    print(f"  [FAIL] {name} {detail}")


# --------------------------------------------------------------- byte fixtures

def make_html(total=19206):
    """The real shape served by the dead host: a full HTML document, ~19 KB,
    comfortably past the 256-byte fast-accept."""
    body = b'<!DOCTYPE html>\n<html lang="vi">\n\t<head>\n\t\t<meta charset="UTF-8" />\n'
    return body + b"<p>page not found</p>\n" * ((total - len(body)) // 22)


def make_jpeg(width=384, height=512, total=4096):
    """SOI + APP0(JFIF) + SOF0 carrying real dimensions, then filler."""
    out = bytearray(b"\xff\xd8")                       # SOI
    out += b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"  # APP0
    out += b"\xff\xc0\x00\x11\x08"                     # SOF0, len 17, precision 8
    out += struct.pack(">HH", height, width)
    out += b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"  # 3 components
    out += b"\x00" * max(0, total - len(out))
    return bytes(out)


def make_png(width=800, height=1200, total=1024):
    out = bytearray(b"\x89PNG\r\n\x1a\n")
    out += struct.pack(">I", 13) + b"IHDR"
    out += struct.pack(">II", width, height)
    out += b"\x08\x02\x00\x00\x00"                     # depth/color/comp/filter/interlace
    out += b"\x00" * 4                                 # CRC placeholder
    out += b"\x00" * max(0, total - len(out))
    return bytes(out)


def make_gif(width=800, height=40, total=512):
    out = bytearray(b"GIF89a")
    out += struct.pack("<HH", width, height)
    out += b"\xf7\x00\x00"                             # packed / bg / aspect
    out += b"\x00" * max(0, total - len(out))
    return bytes(out)


def _riff(fourcc, payload, total):
    out = bytearray(b"RIFF")
    out += struct.pack("<I", 4 + 8 + len(payload))
    out += b"WEBP" + fourcc + struct.pack("<I", len(payload)) + payload
    out += b"\x00" * max(0, total - len(out))
    return bytes(out)


def make_webp_vp8(width=1000, height=1500, total=1024):
    # 3-byte frame tag, the 0x9d012a start code, then 14-bit dims.
    payload = b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", width, height)
    return _riff(b"VP8 ", payload, total)


def make_webp_vp8l(width=720, height=1600, total=1024):
    w1, h1 = width - 1, height - 1
    b0 = w1 & 0xFF
    b1 = ((w1 >> 8) & 0x3F) | ((h1 & 0x03) << 6)
    b2 = (h1 >> 2) & 0xFF
    b3 = (h1 >> 10) & 0x0F
    payload = bytes([0x2F, b0, b1, b2, b3])
    return _riff(b"VP8L", payload, total)


def make_webp_vp8x(width=900, height=2000, total=1024):
    w1, h1 = width - 1, height - 1
    payload = (
        b"\x10\x00\x00\x00"                            # flags + reserved
        + bytes([w1 & 0xFF, (w1 >> 8) & 0xFF, (w1 >> 16) & 0xFF])
        + bytes([h1 & 0xFF, (h1 >> 8) & 0xFF, (h1 >> 16) & 0xFF])
    )
    return _riff(b"VP8X", payload, total)


def make_avif(total=512):
    return b"\x00\x00\x00\x20ftypavifavifmif1miaf" + b"\x00" * (total - 24)


ONE_BY_ONE_GIF = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!"
    b"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01"
    b"\x00\x00\x02\x02D\x01\x00;"
)


# ------------------------------------------------------------------ the checks

def t1_markup_rejected():
    html = make_html()
    check("t1.html_no_ct", looks_like_real_image(html) is False,
          f"len={len(html)} accepted — the original bug")
    check("t1.html_with_ct",
          looks_like_real_image(html, content_type="text/html; charset=utf-8") is False)
    # Size-independence is the whole point: the old gate accepted on length.
    check("t1.html_large", looks_like_real_image(b"<!DOCTYPE html>" + b"x" * 500000) is False)
    check("t1.html_leading_ws", looks_like_real_image(b"\n\n  <html><body>err</body></html>" + b" " * 400) is False)
    check("t1.html_bom", looks_like_real_image(b"\xef\xbb\xbf<!doctype html>" + b" " * 400) is False)
    check("t1.html_utf16_bom",
          looks_like_real_image(b"\xff\xfe<\x00h\x00t\x00m\x00l\x00" + b" " * 400) is False)
    check("t1.xml", looks_like_real_image(b'<?xml version="1.0"?><err/>' + b" " * 400) is False)
    # sniff_image_extension's contract is unchanged — it still guesses .jpg,
    # which is exactly why it can't be used as the validity test.
    check("t1.sniff_ext_contract",
          sniff_image_extension(html[:64], "text/html; charset=utf-8") == ".jpg",
          sniff_image_extension(html[:64], "text/html; charset=utf-8"))
    check("t1.magic_recognizer_says_no", image_magic_extension(html[:64]) is None)


def t2_json_rejected():
    body = b'{"error":"not found"}' + b" " * 400
    check("t2.json_no_ct", looks_like_real_image(body) is False, f"len={len(body)}")
    check("t2.json_with_ct",
          looks_like_real_image(body, content_type="application/json") is False)
    check("t2.json_array", looks_like_real_image(b'[{"e":1}]' + b" " * 400) is False)


def t3_real_formats_accepted():
    for label, blob, dims in (
        ("jpeg", make_jpeg(), (384, 512)),
        ("png", make_png(), (800, 1200)),
        ("gif", make_gif(), (800, 40)),
        ("webp_vp8", make_webp_vp8(), (1000, 1500)),
        ("webp_vp8l", make_webp_vp8l(), (720, 1600)),
        ("webp_vp8x", make_webp_vp8x(), (900, 2000)),
    ):
        check(f"t3.{label}_accepted", looks_like_real_image(blob) is True)
        check(f"t3.{label}_dims", sniff_image_dimensions(blob) == dims,
              f"got {sniff_image_dimensions(blob)} want {dims}")
    # A CDN mislabeling real image bytes as text must NOT lose the page: the
    # content-type rule only bites when the bytes are ALSO unrecognizable.
    check("t3.jpeg_mislabeled_text",
          looks_like_real_image(make_jpeg(), content_type="text/html") is True)


def t4_tiny_image_rescue():
    """bench/webtoonCanvasShelterLogs.md: an 800x40 divider compresses to ~128 B.
    Rejecting it aborted a whole 216-chapter run."""
    tiny = make_gif(800, 40, total=128)
    check("t4.tiny_is_small", len(tiny) == 128, f"len={len(tiny)}")
    check("t4.tiny_accepted", looks_like_real_image(tiny) is True)
    check("t4.tiny_accepted_with_image_ct",
          looks_like_real_image(tiny, content_type="image/gif") is True)
    check("t4.one_by_one_rejected", looks_like_real_image(ONE_BY_ONE_GIF) is False,
          f"len={len(ONE_BY_ONE_GIF)} dims={sniff_image_dimensions(ONE_BY_ONE_GIF)}")
    check("t4.tiny_junk_rejected", looks_like_real_image(b"\x01\x02\x03" * 10) is False)


def t5_unknown_format_fast_path():
    """Zero-regression: bodies we can't dimension-parse still accept on size."""
    opaque = bytes(range(256)) * 2
    check("t5.opaque_accepted", looks_like_real_image(opaque) is True, f"len={len(opaque)}")
    avif = make_avif()
    check("t5.avif_accepted", looks_like_real_image(avif) is True)
    check("t5.avif_magic", image_magic_extension(avif) == ".avif", image_magic_extension(avif))
    check("t5.avif_undimensioned", sniff_image_dimensions(avif) is None)
    # Declared-text + unrecognizable bytes is the one case size can't save.
    check("t5.opaque_declared_text",
          looks_like_real_image(opaque, content_type="text/plain") is False)
    check("t5.empty", looks_like_real_image(b"") is False)
    # Positional-call compatibility for every existing caller in sites/base.py.
    check("t5.positional_min_bytes", looks_like_real_image(opaque, 256) is True)
    check("t5.positional_min_bytes_high", looks_like_real_image(make_gif(800, 40, 128), 4096) is True)


def t6_finalize_rejects_html():
    tmp = tempfile.mkdtemp(prefix="_img_val_")
    try:
        html = make_html()
        pending = os.path.join(tmp, ".pending_0001")
        with open(pending, "wb") as fh:
            fh.write(html)
        reasons = []
        got = finalize_pending_image(
            pending, tmp, "0001", "text/html; charset=utf-8", on_reject=reasons.append
        )
        check("t6.returns_none", got is None, f"got {got!r}")
        check("t6.pending_deleted", not os.path.exists(pending))
        check("t6.no_final_written", os.listdir(tmp) == [], os.listdir(tmp))
        check("t6.reason_reported", len(reasons) == 1, f"reasons={reasons}")
        if reasons:
            check("t6.reason_names_ct", "text/html" in reasons[0], reasons[0])
            check("t6.reason_names_size", str(len(html)) in reasons[0], reasons[0])

        # validate=False is the documented opt-out; the file must survive.
        pending2 = os.path.join(tmp, ".pending_0002")
        with open(pending2, "wb") as fh:
            fh.write(html)
        got2 = finalize_pending_image(pending2, tmp, "0002", "text/html", validate=False)
        check("t6.opt_out_keeps_file", got2 is not None and os.path.exists(got2), f"got {got2!r}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def t7_finalize_accepts_real():
    tmp = tempfile.mkdtemp(prefix="_img_val_")
    try:
        png = make_png(total=900000)  # a real page is ~MB; head-only validation must not choke
        pending = os.path.join(tmp, ".pending_0001")
        with open(pending, "wb") as fh:
            fh.write(png)
        got = finalize_pending_image(pending, tmp, "0001", "image/png")
        check("t7.returns_path", got is not None, f"got {got!r}")
        check("t7.png_extension", bool(got) and got.endswith(".png"), f"got {got!r}")
        check("t7.file_moved", bool(got) and os.path.exists(got) and not os.path.exists(pending))
        check("t7.bytes_intact", bool(got) and os.path.getsize(got) == len(png))

        # The tiny divider must survive finalize too — its validation reads the
        # whole (sub-256-byte) file back, not just the head.
        tiny = make_gif(800, 40, total=128)
        pending2 = os.path.join(tmp, ".pending_0002")
        with open(pending2, "wb") as fh:
            fh.write(tiny)
        got2 = finalize_pending_image(pending2, tmp, "0002", "image/gif")
        check("t7.tiny_survives_finalize", got2 is not None and got2.endswith(".gif"), f"got {got2!r}")

        # A JPEG whose SOF sits past the 64-byte head must NOT be rejected.
        big = make_jpeg(total=500000)
        pending3 = os.path.join(tmp, ".pending_0003")
        with open(pending3, "wb") as fh:
            fh.write(b"\xff\xd8\xff\xe1" + struct.pack(">H", 60000) + b"\x00" * 59998 + big[2:])
        got3 = finalize_pending_image(pending3, tmp, "0003", "image/jpeg")
        check("t7.deep_sof_jpeg_accepted", got3 is not None and got3.endswith(".jpg"), f"got {got3!r}")

        # Missing pending file keeps the historical contract: None, no reason.
        reasons = []
        got4 = finalize_pending_image(
            os.path.join(tmp, ".pending_nope"), tmp, "9999", "image/png",
            on_reject=reasons.append,
        )
        check("t7.missing_pending_none", got4 is None and reasons == [], f"{got4!r} {reasons}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def t8_describe():
    html = make_html()
    msg = describe_invalid_image(html[:64], "text/html; charset=utf-8", len(html))
    check("t8.names_bare_ct", "text/html" in msg and "charset" not in msg, msg)
    check("t8.names_size", str(len(html)) in msg, msg)
    msg2 = describe_invalid_image(html[:64], None, len(html))
    check("t8.no_ct_still_useful", "HTML" in msg2 and str(len(html)) in msg2, msg2)


def main():
    print("image-body validation offline regression:")
    for fn in (
        t1_markup_rejected,
        t2_json_rejected,
        t3_real_formats_accepted,
        t4_tiny_image_rescue,
        t5_unknown_format_fast_path,
        t6_finalize_rejects_html,
        t7_finalize_accepts_real,
        t8_describe,
    ):
        print(f"\n{fn.__name__}:")
        fn()
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("\nALL PASSED")


if __name__ == "__main__":
    main()
