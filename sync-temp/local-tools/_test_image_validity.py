"""Offline regression for sites/_image_io.looks_like_real_image +
sniff_image_dimensions (the fix for the Shelter ch.45 abort — a legitimately
tiny 800x40 divider bar compressed to 128 bytes and tripped the old blanket
`len(body) < 256` gate, aborting a whole 216-chapter run).

Self-contained: generates real images in every format the sniffer parses via
Pillow, checks the sniffed (w,h) against Pillow's ground truth, and asserts the
validity predicate on the bug shape + junk inputs. No library/series paths.

Run:  python tools/_test_image_validity.py   (exit 0 = pass)
"""
import io
import os
import struct
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from sites._image_io import sniff_image_dimensions, looks_like_real_image  # noqa: E402

try:
    from PIL import Image
except Exception as e:  # pragma: no cover
    print(f"SKIP: Pillow unavailable ({e})")
    sys.exit(0)

fails = []
def check(name, cond, detail=""):
    if not cond:
        fails.append(f"{name}: {detail}")
    print(f"  [{'ok  ' if cond else 'FAIL'}] {name}"
          f"{('  — ' + detail) if detail and not cond else ''}")

def make(fmt, size, color, **kw):
    mode = "RGBA" if (isinstance(color, tuple) and len(color) == 4) else "RGB"
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format=fmt, **kw)
    return buf.getvalue()

print("== sniff_image_dimensions matches Pillow ground truth ==")
samples = []  # (label, bytes, expected_wh, expected_valid)

# The real bug shape: an 800x40 solid divider, tiny after compression.
for fmt, kw, lbl in [
    ("PNG", {"optimize": True}, "PNG 800x40 divider (Shelter bug shape)"),
    ("GIF", {}, "GIF 800x40 divider"),
    ("JPEG", {"quality": 80}, "JPEG 800x40 divider"),
    ("WEBP", {"lossless": False, "quality": 80}, "WEBP-VP8 800x40"),
    ("WEBP", {"lossless": True}, "WEBP-VP8L 800x40"),
    ("BMP", {}, "BMP 800x40"),
]:
    try:
        data = make(fmt, (800, 40), (30, 30, 30), **kw)
    except Exception as e:
        print(f"  [skip] {lbl}: cannot encode ({e})")
        continue
    samples.append((f"{lbl} [{len(data)}B]", data, (800, 40), True))

# WebP VP8X extended container: multi-frame animation forces it.
try:
    frames = [Image.new("RGB", (333, 222), (i * 40, 0, 0)) for i in range(3)]
    b = io.BytesIO()
    frames[0].save(b, format="WEBP", save_all=True, append_images=frames[1:],
                   duration=100, loop=0)
    data = b.getvalue()
    samples.append((f"WEBP-{data[12:16].decode(errors='replace').strip()} 333x222 anim [{len(data)}B]",
                    data, (333, 222), True))
except Exception as e:
    print(f"  [skip] animated WEBP (VP8X): {e}")

# Thin spacer must survive (area >= 2); 1x1 tracking pixel must not.
samples.append(("PNG 1x8 spacer", make("PNG", (1, 8), (0, 0, 0)), (1, 8), True))
samples.append(("PNG 1x1 pixel", make("PNG", (1, 1), (0, 0, 0)), (1, 1), False))
samples.append(("GIF 1x1 pixel", make("GIF", (1, 1), (0, 0, 0)), (1, 1), False))

for lbl, data, expect_wh, expect_valid in samples:
    dims = sniff_image_dimensions(data)
    try:
        pil_wh = Image.open(io.BytesIO(data)).size
    except Exception:
        pil_wh = None
    check(f"{lbl} dims", dims == expect_wh, f"sniffed {dims}, expected {expect_wh}")
    if pil_wh is not None:
        check(f"{lbl} vs Pillow", dims == pil_wh, f"sniffed {dims}, Pillow {pil_wh}")
    check(f"{lbl} valid={expect_valid}",
          looks_like_real_image(data) is expect_valid, f"got {looks_like_real_image(data)}")

print("== hand-built VP8X header (encoder-independent) ==")
w, h = 1000, 500
body = (b"VP8X" + struct.pack("<I", 10) + b"\x00" + b"\x00\x00\x00"
        + struct.pack("<I", w - 1)[:3] + struct.pack("<I", h - 1)[:3])
webp = b"RIFF" + struct.pack("<I", len(body) + 4) + b"WEBP" + body
check("VP8X 1000x500 dims", sniff_image_dimensions(webp) == (w, h),
      f"got {sniff_image_dimensions(webp)}")

print("== junk / edge inputs stay rejected ==")
for lbl, data, expect_valid in [
    ("empty", b"", False),
    ("None", None, False),
    ("html 404 stub", b"<!doctype html><title>404 Not Found</title><p>nope</p>", False),
    ("json error", b'{"error":"not found","code":404}', False),
    ("truncated PNG signature only", b"\x89PNG\r\n\x1a\n", False),
    ("300B non-image blob (>=256 fast-accept)", bytes(range(256)) + bytes(50), True),
]:
    check(f"{lbl} valid={expect_valid}",
          looks_like_real_image(data) is expect_valid, f"got {looks_like_real_image(data)}")

print()
if fails:
    print(f"RESULT: {len(fails)} FAILURE(S):")
    for f in fails:
        print("   -", f)
    sys.exit(1)
print("RESULT: ALL CHECKS PASSED")
