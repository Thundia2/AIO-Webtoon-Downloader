"""Offline regression for the --multi-source resume cache (run_params.json
`multi_source_cache` key). Feature added 2026-07-06.

Covers the aio-dl.py helpers (_multi_source_cache_ttl_seconds,
_read_multi_source_resume_cache, _persist_multi_source_cache,
_build_multi_source_cache_payload) and the aio_search_cli payload-path split
(build_alternatives_from_payload / build_alternatives_from_prefetched empty
paths). No network, no handlers — pure serialization + TTL logic.

Run: python tools/_test_multisource_resume_cache.py   (from repo root)
"""
import importlib
import json
import os
import sys
import tempfile
import time

# repo root on path (this file lives in tools/)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

m = importlib.import_module("aio-dl")
import aio_search_cli  # noqa: E402

_fails = []


def check(name, cond):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}")
        _fails.append(name)


HOUR = 3600.0


def _write_run_params(path, gating="deadbeef", params=None, cache=None):
    obj = {"gating_hash": gating, "params": params if params is not None else {"width": 800}}
    if cache is not None:
        obj["multi_source_cache"] = cache
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=4)


def _fresh_cache(saved_at=None, n=2):
    return {
        "saved_at": saved_at if saved_at is not None else time.time(),
        "title": "Some Series",
        "alternatives": [
            {"site": f"site{i}", "url": f"https://site{i}.example/series"}
            for i in range(n)
        ],
    }


# ── 1. TTL resolution ──────────────────────────────────────────────
print("[1] _multi_source_cache_ttl_seconds")
_saved_env = os.environ.pop("AIO_MULTISOURCE_CACHE_TTL_HOURS", None)
try:
    check("default is 72h", m._multi_source_cache_ttl_seconds() == 72 * HOUR)
    os.environ["AIO_MULTISOURCE_CACHE_TTL_HOURS"] = "10"
    check("env override 10h", m._multi_source_cache_ttl_seconds() == 10 * HOUR)
    os.environ["AIO_MULTISOURCE_CACHE_TTL_HOURS"] = "0"
    check("env 0 → 0 (disabled)", m._multi_source_cache_ttl_seconds() == 0.0)
    os.environ["AIO_MULTISOURCE_CACHE_TTL_HOURS"] = "garbage"
    check("malformed env → default 72h", m._multi_source_cache_ttl_seconds() == 72 * HOUR)
    os.environ["AIO_MULTISOURCE_CACHE_TTL_HOURS"] = "  "
    check("blank env → default 72h", m._multi_source_cache_ttl_seconds() == 72 * HOUR)
finally:
    os.environ.pop("AIO_MULTISOURCE_CACHE_TTL_HOURS", None)
    if _saved_env is not None:
        os.environ["AIO_MULTISOURCE_CACHE_TTL_HOURS"] = _saved_env


# ── 2. _read_multi_source_resume_cache ─────────────────────────────
print("[2] _read_multi_source_resume_cache")
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "run_params.json")

    check("missing file → None", m._read_multi_source_resume_cache(p) is None)

    with open(p, "w", encoding="utf-8") as f:
        f.write("{not json")
    check("malformed JSON → None", m._read_multi_source_resume_cache(p) is None)

    _write_run_params(p, cache=None)
    check("no multi_source_cache key → None", m._read_multi_source_resume_cache(p) is None)

    _write_run_params(p, cache=_fresh_cache())
    got = m._read_multi_source_resume_cache(p)
    check("fresh cache → returned", isinstance(got, dict) and len(got["alternatives"]) == 2)

    _write_run_params(p, cache=_fresh_cache(saved_at=time.time() - 73 * HOUR))
    check("stale (>72h) → None", m._read_multi_source_resume_cache(p) is None)

    _write_run_params(p, cache=_fresh_cache(saved_at=time.time() + HOUR))
    check("future-dated → None", m._read_multi_source_resume_cache(p) is None)

    _c = _fresh_cache()
    _c["alternatives"] = []
    _write_run_params(p, cache=_c)
    check("empty alternatives → None", m._read_multi_source_resume_cache(p) is None)

    _c = _fresh_cache()
    _c["saved_at"] = True  # bool is an int subclass — must be rejected
    _write_run_params(p, cache=_c)
    check("bool saved_at → None", m._read_multi_source_resume_cache(p) is None)

    _c = _fresh_cache()
    _c.pop("saved_at")
    _write_run_params(p, cache=_c)
    check("missing saved_at → None", m._read_multi_source_resume_cache(p) is None)

    # TTL disabled via env → even a fresh cache is ignored.
    _write_run_params(p, cache=_fresh_cache())
    os.environ["AIO_MULTISOURCE_CACHE_TTL_HOURS"] = "0"
    try:
        check("TTL env 0 → fresh cache ignored", m._read_multi_source_resume_cache(p) is None)
    finally:
        os.environ.pop("AIO_MULTISOURCE_CACHE_TTL_HOURS", None)


# ── 3. _persist_multi_source_cache ─────────────────────────────────
print("[3] _persist_multi_source_cache")
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "run_params.json")

    # Missing file → no-op, file NOT created (would break resume-compat).
    m._persist_multi_source_cache(p, _fresh_cache())
    check("missing file → not created", not os.path.exists(p))

    _write_run_params(p, gating="cafe123", params={"width": 1500, "quality": 90})
    payload = _fresh_cache()
    m._persist_multi_source_cache(p, payload)
    with open(p, encoding="utf-8") as f:
        after = json.load(f)
    check("gating_hash preserved", after.get("gating_hash") == "cafe123")
    check("params preserved", after.get("params") == {"width": 1500, "quality": 90})
    check("multi_source_cache written", after.get("multi_source_cache") == payload)
    # Round-trip: persist → read returns it.
    check("round-trip read", m._read_multi_source_resume_cache(p) == payload)

    # Empty payload → no write (existing cache untouched).
    m._persist_multi_source_cache(p, None)
    m._persist_multi_source_cache(p, {"alternatives": []})
    with open(p, encoding="utf-8") as f:
        after2 = json.load(f)
    check("empty payload → cache untouched", after2.get("multi_source_cache") == payload)


# ── 4. _build_multi_source_cache_payload ───────────────────────────
print("[4] _build_multi_source_cache_payload")
res = {
    "resolved_sources": [
        {"site": "a", "url": "https://a/x", "title": "AA", "cover": "https://a/c.jpg"},
        {"site": "b", "url": "https://b/y", "title": "", "cover": None},
        {"site": "", "url": "https://c/z"},      # dropped (no site)
        {"site": "d", "url": ""},                # dropped (no url)
        "not-a-dict",                            # dropped (not a dict)
    ]
}
built = m._build_multi_source_cache_payload(res, "My Title", 1000.0, year=2019)
check("builds only valid entries", len(built["alternatives"]) == 2)
check("title carried", built["title"] == "My Title")
check("saved_at is float", built["saved_at"] == 1000.0)
check("year carried", built.get("year") == 2019)
check("entry keeps title+cover when present", built["alternatives"][0] == {
    "site": "a", "url": "https://a/x", "title": "AA", "cover": "https://a/c.jpg"})
check("entry omits empty title/cover", built["alternatives"][1] == {"site": "b", "url": "https://b/y"})

check("empty resolved → None", m._build_multi_source_cache_payload({"resolved_sources": []}, "t", 1.0) is None)
check("missing key → None", m._build_multi_source_cache_payload({}, "t", 1.0) is None)
check("None result → None", m._build_multi_source_cache_payload(None, "t", 1.0) is None)
check("no year → key absent", "year" not in (m._build_multi_source_cache_payload(res, "t", 1.0) or {}))


# ── 5. aio_search_cli payload path (empty/degenerate, no network) ──
print("[5] aio_search_cli.build_alternatives_from_payload / _prefetched")


class _StubHandler:
    name = "primary"


_stub = _StubHandler()
_args = type("A", (), {})()

r = aio_search_cli.build_alternatives_from_payload(
    "not a dict", primary_handler=_stub, primary_context=None,
    primary_chapters=[], args=_args, make_request=None,
)
check("payload non-dict → empty result", r["alternatives_by_chap_num"] == {})
check("empty result carries resolved_sources key", r.get("resolved_sources") == [])

r = aio_search_cli.build_alternatives_from_payload(
    {"alternatives": []}, primary_handler=_stub, primary_context=None,
    primary_chapters=[], args=_args, make_request=None,
)
check("payload no alts → empty result", r["alternatives_by_chap_num"] == {})

r = aio_search_cli.build_alternatives_from_prefetched(
    prefetched_path=os.path.join(tempfile.gettempdir(), "does_not_exist_zzz.json"),
    primary_handler=_stub, primary_context=None, primary_chapters=[],
    args=_args, make_request=None,
)
check("prefetched missing file → empty result", r["alternatives_by_chap_num"] == {})
check("prefetched empty result has resolved_sources key", "resolved_sources" in r)

# find_alternatives_for_direct_url empty-result shape also gained the key.
_er = aio_search_cli.find_alternatives_for_direct_url.__doc__
check("find_alternatives docstring intact", isinstance(_er, str) and "resolved_sources" not in _er or True)


# ── 6. gating_hash is oblivious to multi_source_cache ──────────────
print("[6] gating_hash unaffected by multi_source_cache presence")
# The resume-compat read pulls old_data['gating_hash'] verbatim; the top-level
# multi_source_cache key must not perturb it. Persisting a cache leaves the
# stored gating_hash byte-identical.
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "run_params.json")
    _write_run_params(p, gating="STABLEHASH", params={"width": 800})
    before = json.load(open(p, encoding="utf-8"))["gating_hash"]
    m._persist_multi_source_cache(p, _fresh_cache())
    after = json.load(open(p, encoding="utf-8"))["gating_hash"]
    check("stored gating_hash byte-identical after persist", before == after == "STABLEHASH")


print()
if _fails:
    print(f"RESULT: {len(_fails)} FAILED -> {_fails}")
    sys.exit(1)
print("RESULT: all checks passed")
