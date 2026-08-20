"""Coverage for aio_android.build_argv — the Android CLI-argument builder.

This is a behavioural port of UI-source/electron/downloader.js:buildCliArgs, and
these tests are the reason the port lives in Python rather than Kotlin: the
guards are load-bearing (aio-dl.py HARD-ERRORS on several flag combinations) and
here they can be checked offline, with no device and no rebuild.

Every "blocked"/"incompatible" case below corresponds to a real Python-side
hard error or a silently-wrong output. If one of these starts failing, do NOT
relax the test — check downloader.js first, since the two must agree.
"""

from __future__ import annotations

import json

import pytest

from aio_android import build_argv, build_argv_json


def _pairs(argv):
    """{flag: value} for valued flags, so assertions don't depend on ordering."""
    out = {}
    i = 0
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            out[argv[i]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return out


# --------------------------------------------------------------------------
# Valued flags
# --------------------------------------------------------------------------

def test_empty_settings_produce_no_args():
    assert build_argv({}) == []


def test_valued_flags_are_emitted():
    argv = build_argv({"format": "cbz", "language": "en", "jobs": 3})
    assert _pairs(argv) == {"--format": "cbz", "--language": "en", "--jobs": "3"}


@pytest.mark.parametrize("empty", [None, ""])
def test_empty_values_are_skipped(empty):
    assert build_argv({"format": empty}) == []


def test_zero_is_emitted_not_treated_as_empty():
    # The trap: a truthiness filter would drop 0, and 0 is meaningful for
    # several knobs (e.g. --net-min-gap 0).
    assert _pairs(build_argv({"netMinGap": 0})) == {"--net-min-gap": "0"}


def test_default_valued_flags_are_skipped():
    # Both are the Python-side defaults; emitting them is pure noise.
    assert build_argv({"chapters": "all", "mtl": "avoid"}) == []
    assert _pairs(build_argv({"chapters": "1-5", "mtl": "exclude"})) == {
        "--chapters": "1-5",
        "--mtl": "exclude",
    }


def test_url_is_appended_last_as_positional():
    argv = build_argv({"format": "cbz", "url": "https://example.com/x"})
    assert argv[-1] == "https://example.com/x"


def test_blank_url_is_not_appended():
    assert build_argv({"url": "   "}) == []


# --------------------------------------------------------------------------
# Boolean flags
# --------------------------------------------------------------------------

def test_bool_flag_requires_exactly_true():
    assert build_argv({"verbose": True}) == ["--verbose"]
    for falsey in (False, None, 0, "", "true", 1):
        assert build_argv({"verbose": falsey}) == [], f"{falsey!r} must not enable the flag"


def test_prompt_urls_is_never_emitted():
    # It makes aio-dl.py read from stdin, which does not exist under Chaquopy.
    assert build_argv({"promptUrls": True}) == []


# --------------------------------------------------------------------------
# --webtoon-recompress compatibility
# --------------------------------------------------------------------------

@pytest.mark.parametrize("fmt", ["pdf", "none"])
def test_webtoon_recompress_stripped_on_incompatible_format(fmt):
    argv = build_argv({"format": fmt, "webtoonRecompress": True})
    assert "--webtoon-recompress" not in argv


@pytest.mark.parametrize("fmt", ["cbz", "epub"])
def test_webtoon_recompress_kept_on_archive_formats(fmt):
    assert "--webtoon-recompress" in build_argv({"format": fmt, "webtoonRecompress": True})


def test_komikku_rescues_webtoon_recompress_on_pdf():
    # --komikku coerces format->cbz BEFORE aio-dl.py's compatibility check.
    argv = build_argv({"format": "pdf", "komikku": True, "webtoonRecompress": True})
    assert "--webtoon-recompress" in argv


def test_webtoon_knobs_only_when_non_default_and_enabled():
    at_defaults = _pairs(build_argv({"format": "cbz", "webtoonRecompress": True,
                                     "webtoonRecompressQuality": 85, "webtoonRecompressMethod": 4}))
    assert "--webtoon-recompress-quality" not in at_defaults
    assert "--webtoon-recompress-method" not in at_defaults
    got = _pairs(build_argv({"format": "cbz", "webtoonRecompress": True,
                             "webtoonRecompressQuality": 70, "webtoonRecompressMethod": 6}))
    assert got["--webtoon-recompress-quality"] == "70"
    assert got["--webtoon-recompress-method"] == "6"
    # Knobs must not leak out when the master toggle is off.
    assert build_argv({"format": "cbz", "webtoonRecompressQuality": 70}) == ["--format", "cbz"]


# --------------------------------------------------------------------------
# --modernize compatibility (all seven blocking conditions)
# --------------------------------------------------------------------------

def test_modernize_allowed_on_plain_cbz():
    assert "--modernize" in build_argv({"format": "cbz", "modernize": True})


@pytest.mark.parametrize("extra", [
    {"format": "epub"},                    # stricter than webtoon: cbz only
    {"format": "cbz", "quality": 90},      # <100 disables the byte fast-path
    {"format": "cbz", "scaling": 50},
    {"format": "cbz", "cbzPreserveOriginals": False},
    {"format": "cbz", "noProcessing": True},
    {"format": "cbz", "width": 800},
    {"format": "cbz", "aspectRatio": "16:9"},
])
def test_modernize_stripped_when_fast_path_unsatisfiable(extra):
    argv = build_argv({"modernize": True, **extra})
    assert "--modernize" not in argv
    assert not [a for a in argv if a.startswith("--modernize")], "no knob may survive either"


def test_modernize_komikku_overrides_format_but_not_other_blockers():
    assert "--modernize" in build_argv({"format": "epub", "komikku": True, "modernize": True})
    assert "--modernize" not in build_argv(
        {"format": "epub", "komikku": True, "modernize": True, "noProcessing": True}
    )


def test_modernize_quality_100_and_scaling_100_do_not_block():
    argv = build_argv({"format": "cbz", "modernize": True, "quality": 100, "scaling": 100})
    assert "--modernize" in argv


def test_modernize_reversible_forces_the_jxl_distance0_pair():
    # A PAIR because `auto` + distance 0 is NOT reversible — auto still routes
    # color pages to the always-lossy AVIF branch.
    got = _pairs(build_argv({
        "format": "cbz", "modernize": True, "modernizeReversible": True,
        "modernizeFormat": "avif", "modernizeDistance": 3, "modernizeAvifSpeed": 2,
    }))
    assert got["--modernize-format"] == "jxl"
    assert got["--modernize-distance"] == "0"
    # The stored routing knobs must be ignored, not merged.
    assert "--modernize-avif-speed" not in got


def test_modernize_knobs_skip_defaults_but_emit_zero_speed():
    base = {"format": "cbz", "modernize": True}
    at_defaults = _pairs(build_argv({**base, "modernizeFormat": "auto", "modernizeDistance": 1.0,
                                     "modernizeQuality": 90, "modernizeAvifSpeed": 6,
                                     "modernizeMinSaving": 0.92, "modernizeEffort": 7}))
    assert not [k for k in at_defaults if k.startswith("--modernize-")], at_defaults
    # speed 0 is a valid non-default (slowest/smallest) — a truthiness test would drop it.
    assert _pairs(build_argv({**base, "modernizeAvifSpeed": 0}))["--modernize-avif-speed"] == "0"


def test_modernize_min_saving_and_effort_apply_under_reversible_too():
    got = _pairs(build_argv({
        "format": "cbz", "modernize": True, "modernizeReversible": True,
        "modernizeMinSaving": 0.5, "modernizeEffort": 9,
    }))
    assert got["--modernize-min-saving"] == "0.5"
    assert got["--modernize-effort"] == "9"


# --------------------------------------------------------------------------
# Negative-default and absent-means-on flags
# --------------------------------------------------------------------------

def test_cbz_preserve_originals_only_negates_on_explicit_false():
    assert "--no-cbz-preserve-originals" in build_argv({"cbzPreserveOriginals": False})
    for v in (True, None, "no-such-field"):
        assert "--no-cbz-preserve-originals" not in build_argv({"cbzPreserveOriginals": v})


def test_multi_source_lazy_is_absent_means_on():
    assert "--multi-source-lazy" in build_argv({"multiSource": True})
    assert "--multi-source-lazy" in build_argv({"multiSource": True, "multiSourceLazy": True})
    # Only an explicit false suppresses it.
    assert "--multi-source-lazy" not in build_argv(
        {"multiSource": True, "multiSourceLazy": False}
    )
    # Never emitted without the multi-source opt-in.
    assert "--multi-source-lazy" not in build_argv({"multiSourceLazy": True})


def test_collapse_splits_is_opt_in():
    assert build_argv({"collapseSplits": True}) == ["--collapse-splits"]
    assert build_argv({"collapseSplits": False}) == []


def test_disabled_sites_joined_with_commas():
    assert _pairs(build_argv({"disabledSites": ["comix", "asura"]})) == {
        "--disable-sites": "comix,asura"
    }
    assert build_argv({"disabledSites": []}) == []
    assert build_argv({"disabledSites": None}) == []


# --------------------------------------------------------------------------
# JNI wrapper
# --------------------------------------------------------------------------

def test_build_argv_json_round_trip():
    out = build_argv_json(json.dumps({"format": "cbz", "url": "https://e/x"}))
    assert json.loads(out) == ["--format", "cbz", "https://e/x"]


@pytest.mark.parametrize("bad,exc", [
    ("not json", ValueError),
    ("[1,2]", TypeError),
    ("42", TypeError),
])
def test_build_argv_json_rejects_bad_payloads(bad, exc):
    with pytest.raises(exc):
        build_argv_json(bad)


def test_realistic_komikku_download_matches_expected_command_line():
    """End-to-end shape check against a plausible real settings blob."""
    argv = build_argv({
        "format": "cbz", "language": "en", "chapters": "all", "mtl": "avoid",
        "komikku": True, "multiSource": True, "imageWorkers": 8,
        "cbzPreserveOriginals": True, "disabledSites": ["comix"],
        "url": "https://mangadex.org/title/abc",
    })
    assert argv == [
        "--format", "cbz",
        "--language", "en",
        "--image-workers", "8",
        "--multi-source",
        "--komikku",
        "--multi-source-lazy",
        "--disable-sites", "comix",
        "https://mangadex.org/title/abc",
    ]
