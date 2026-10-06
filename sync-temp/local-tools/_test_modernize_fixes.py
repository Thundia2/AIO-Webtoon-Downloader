"""Validate the Codex-review fixes: alpha preservation + --update-all replay."""
import argparse, importlib, json, os, sys, tempfile
from PIL import Image

# Repo root on sys.path (script dir is tools/) — same shim as _test_sidecar_aux.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

aio = importlib.import_module("aio-dl")

PASS = []


def check(label, cond):
    PASS.append(cond)
    print(f"[{'PASS' if cond else 'FAIL'}] {label}")


# ── Fix 1: alpha preserved through AVIF and JXL ─────────────────────────────
def alpha_case(label, mode, fill, policy):
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "page.png")
        Image.new(mode, (160, 160), fill).save(src)
        # min_saving=5.0 forces adoption so we always get the transcoded file.
        out = aio.recompress_chapter_images_modern(
            [src], policy=policy, gray_quality=1.0, color_quality=90, min_saving=5.0
        )[0]
        ext = os.path.splitext(out)[1]
        with Image.open(out) as im:
            bands = im.getbands()
        check(f"{label} ({mode}->{policy}) kept alpha [{ext}, bands={bands}]", "A" in bands)


alpha_case("RGBA via AVIF", "RGBA", (255, 0, 0, 128), "avif")
alpha_case("RGBA via JXL", "RGBA", (0, 128, 0, 64), "jxl")
alpha_case("LA via AVIF", "LA", (128, 90), "avif")
alpha_case("LA via JXL", "LA", (200, 50), "jxl")

# Opaque grayscale to AVIF must NOT crash and needs no alpha.
with tempfile.TemporaryDirectory() as d:
    src = os.path.join(d, "g.png")
    Image.new("L", (160, 160), 128).save(src)
    out = aio.recompress_chapter_images_modern(
        [src], policy="avif", gray_quality=1.0, color_quality=90, min_saving=5.0
    )[0]
    check("L->AVIF produced a file", os.path.exists(out))

# ── Fix 3: --update-all saves + replays modernize (0.0 distance survives) ────
with tempfile.TemporaryDirectory() as d:
    args = argparse.Namespace(
        site=None, format="cbz", language="en", width=1500, aspect_ratio="2.5",
        quality=85, scaling=100, cookies="", group=[], split=None,
        mix_by_upvote=False, no_group_fallback=False, no_partials=False,
        download_volumes=False, keep_chapters=False, keep_images=False,
        no_final_file=False, no_processing=False, no_cleanup=False,
        verbose=False, debug=False, metadata_source="none",
        metadata_tag_min_rank=50, metadata_refresh=False,
        modernize=True, modernize_format="jxl", modernize_quality=90,
        modernize_distance=0.0, modernize_min_saving=0.92,
    )
    aio._save_download_params(d, "http://x/y", args, "Title")
    params = json.load(open(os.path.join(d, aio._SAVED_PARAMS_FILE), encoding="utf-8"))
    check("saved modernize=True", params.get("modernize") is True)
    check("saved modernize_distance 0.0 (not clobbered)", params.get("modernize_distance") == 0.0)
    check("saved modernize_format jxl", params.get("modernize_format") == "jxl")

    child = []
    aio._append_saved_update_options(child, params)
    check("replay has --modernize", "--modernize" in child)
    check("replay has --modernize-format jxl",
          "--modernize-format" in child and child[child.index("--modernize-format") + 1] == "jxl")
    check("replay has --modernize-distance 0.0 (non-default emitted)", "--modernize-distance" in child)
    check("replay omits --modernize-quality (default 90)", "--modernize-quality" not in child)
    check("replay SUPPRESSES --quality (would trip compat check)", "--quality" not in child)
    check("replay SUPPRESSES --width (cbz default 1500 not user-set)", "--width" not in child)
    check("replay SUPPRESSES --aspect-ratio", "--aspect-ratio" not in child)
    check("replay keeps --scaling 100 (fast-path safe)",
          "--scaling" in child and child[child.index("--scaling") + 1] == "100")

    # Control: a non-modernize series. Post-S4-1, --quality is replayed ONLY when
    # the user explicitly set it (_user_set_quality); a default-quality run
    # SUPPRESSES --quality to keep the CBZ byte-passthrough fast-path (emitting the
    # default 85 would flip the child's _user_set_quality True and re-encode).
    args2 = argparse.Namespace(**{**vars(args), "modernize": False, "_user_set_quality": True})
    aio._save_download_params(d, "http://x/y", args2, "Title")
    p2 = json.load(open(os.path.join(d, aio._SAVED_PARAMS_FILE), encoding="utf-8"))
    c2 = []
    aio._append_saved_update_options(c2, p2)
    check("non-modernize + user-set quality emits --quality", "--quality" in c2)
    check("non-modernize still emits --width", "--width" in c2)

    # The S4-1 fix itself: a non-modernize DEFAULT-quality run must NOT emit
    # --quality (else update chapters get silently lossy-re-encoded at q85).
    args3 = argparse.Namespace(**{**vars(args), "modernize": False, "_user_set_quality": False})
    aio._save_download_params(d, "http://x/y", args3, "Title")
    p3 = json.load(open(os.path.join(d, aio._SAVED_PARAMS_FILE), encoding="utf-8"))
    c3 = []
    aio._append_saved_update_options(c3, p3)
    check("non-modernize + default quality SUPPRESSES --quality (S4-1 byte-preserve)",
          "--quality" not in c3)

print(f"\n{sum(PASS)}/{len(PASS)} checks passed")
