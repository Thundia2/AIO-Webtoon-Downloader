"""Regression: --collapse-splits + --modernize on a per-part-named handler.

Bug (bench/collapseSplitsModernize.md): MangaDex returns binary_image entries
named per-chapter ("0001.png", "0002.png", ... — no chapter prefix). The
download loop honored that `name` verbatim, so when --collapse-splits
concatenates several parts into ONE tdir, part 2's "0001.png" OVERWROTE part
1's. Two damages followed:
  1. immediate_images collected duplicate paths → part-1 pages silently lost.
  2. --modernize's transcode thread pool raced on the shared path: one worker
     rewrote+deleted the source and the duplicate slot's except-cleanup did
     os.remove(base+".jxl") on the winner's output → the CBZ build hit
     FileNotFoundError and the whole chapter was recorded missed.

Fix (aio-dl.py, two twins — the foreground loop + _run_image_prefetch_job):
name every on-disk page by the continuous page_counter, never the handler's
bare `name` (its extension is still honored). This test is offline/deterministic
— no network, no real MangaDex. Run: python tools/_test_collapse_modernize.py
"""
import importlib, os, re, sys, tempfile
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
aio = importlib.import_module("aio-dl")

PASS = []


def check(label, cond):
    PASS.append(bool(cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {label}")


# ── Naming layer: mimic the binary_image write loop for merged parts ─────────
# part1 has 3 pages, part2 has 2 pages; BOTH use MangaDex's per-part names so
# the stems collide across parts. total = 5 distinct pages.
PART1 = [("0001.png", b"A1"), ("0002.png", b"B1"), ("0003.png", b"C1")]
PART2 = [("0001.png", b"D2"), ("0002.png", b"E2")]


def simulate_merge(d, parts, use_fix):
    """Return immediate_images as the download loop would build it. use_fix
    picks the counter name (post-fix) vs the handler's bare name (pre-fix)."""
    os.makedirs(d, exist_ok=True)
    page_counter = 1
    immediate = []
    n = "1"
    for part in parts:
        for name, blob in part:
            ext = os.path.splitext(name)[1] or ".png"
            filename = f"{n}_{page_counter:04d}{ext}" if use_fix else name
            pth = os.path.join(d, filename)
            with open(pth, "wb") as fh:
                fh.write(blob)
            immediate.append((page_counter, pth))
            page_counter += 1
    return immediate


with tempfile.TemporaryDirectory() as td:
    fix_dir = os.path.join(td, "fixed")
    fixed = simulate_merge(fix_dir, [PART1, PART2], use_fix=True)
    fixed_paths = [p for _, p in fixed]
    fixed_on_disk = [f for f in os.listdir(fix_dir)]
    check("fix: every page gets a unique path (no dup in immediate_images)",
          len(set(fixed_paths)) == 5)
    check("fix: 5 pages land as 5 files on disk (no overwrite)",
          len(fixed_on_disk) == 5)
    check("fix: page order + content preserved across parts",
          [open(p, "rb").read() for p in fixed_paths]
          == [b"A1", b"B1", b"C1", b"D2", b"E2"])

    bug_dir = os.path.join(td, "buggy")
    buggy = simulate_merge(bug_dir, [PART1, PART2], use_fix=False)
    buggy_paths = [p for _, p in buggy]
    buggy_on_disk = [f for f in os.listdir(bug_dir)]
    check("bug repro: pre-fix names collide (5 pages -> 3 files on disk)",
          len(buggy_on_disk) == 3)
    check("bug repro: immediate_images holds duplicate paths (5 slots, 3 unique)",
          len(buggy_paths) == 5 and len(set(buggy_paths)) == 3)
    # part1's 0001/0002 were clobbered by part2's write.
    check("bug repro: part-1 content lost (page 1 on disk == part2's blob)",
          open(os.path.join(bug_dir, "0001.png"), "rb").read() == b"D2")


# ── End-to-end: modernize on the fixed (unique) page set must not lose pages ─
def _png(path, fill=(10, 120, 200)):
    Image.new("RGB", (96, 96), fill).save(path)


with tempfile.TemporaryDirectory() as td:
    # Fixed naming: 5 unique files, as the merged chapter would now produce.
    paths = []
    for i in range(1, 6):
        p = os.path.join(td, f"1_{i:04d}.png")
        _png(p, fill=(i * 30 % 256, 60, 180))
        paths.append(p)
    out = aio.recompress_chapter_images_modern(
        paths, policy="jxl", gray_quality=0.0, color_quality=90, min_saving=5.0
    )
    check("fix e2e: modernize returns one path per page (5)", len(out) == 5)
    check("fix e2e: every returned page exists on disk (no FileNotFoundError)",
          all(os.path.exists(p) for p in out))


# ── Mechanism proof: feed modernize the pre-fix duplicate list -> lost files ──
# Force the sequential branch (cpu_count->1) so the destructive interleaving is
# deterministic: slot 0 adopts .jxl and deletes the source; slot 1 can't open
# the now-missing source and its except-cleanup deletes slot 0's .jxl. Both
# returned paths then point at deleted files — exactly the CBZ crash source.
_orig_cpu = os.cpu_count
try:
    os.cpu_count = lambda: 1
    with tempfile.TemporaryDirectory() as td:
        shared = os.path.join(td, "0001.png")
        _png(shared)
        dup = [shared, shared]  # two immediate_images slots, one file (the bug)
        out = aio.recompress_chapter_images_modern(
            dup, policy="jxl", gray_quality=0.0, color_quality=90, min_saving=5.0
        )
        missing = [p for p in out if not os.path.exists(p)]
        check("mechanism: duplicate paths make modernize return missing files",
              len(missing) > 0)
finally:
    os.cpu_count = _orig_cpu


# ── Structural: the real download chokepoints name by counter, not bare name ─
src = open(os.path.join(REPO, "aio-dl.py"), encoding="utf-8").read()
# CL-4 (2026-07): the ext-determination + counter naming moved into a shared
# _binary_image_page_name helper so the foreground + prefetch twins can't drift.
check("structural: shared _binary_image_page_name helper defined",
      "def _binary_image_page_name(" in src)
check("structural: helper names by continuous page_counter (not the bare handler name)",
      'return f"{chap_label}_{page_counter:04d}{ext}"' in src)
check("structural: foreground twin routes through the shared helper",
      "_binary_image_page_name(entry, blob, n, page_counter)" in src)
check("structural: both twins call the helper (def + 2 call sites)",
      src.count("_binary_image_page_name(") >= 3)
check("structural: no verbatim-custom_name filename ternary remains",
      re.search(r"filename\s*=\s*\(\s*custom_name", src) is None)

print(f"\n{sum(PASS)}/{len(PASS)} checks passed")
sys.exit(0 if all(PASS) else 1)
