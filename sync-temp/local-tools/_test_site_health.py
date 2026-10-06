#!/usr/bin/env python3
# Offline, deterministic regression for the search-health signal + --disable-sites
# exclusion (2026-07-13). Covers:
#   1. _classify_site_health truth table (hard-down precedence, slow_probe gate).
#   2. parse_disable_sites tolerance (case / whitespace / None / trailing comma).
#   3. search_all end-to-end assembly with STUB handlers (no network): drives the
#      fan-out with a dead/slow/fast/blocked/disabled mix and asserts the emitted
#      diagnostics["site_health"], including the no-hits EARLY-RETURN path (the
#      "every site is down" case that must still surface health) and the
#      exclude_sites suppression.
#
# Run: python tools/_test_site_health.py   (exit 0 = pass)
# Sibling of tools/_test_search_perf_opts.py; same plain-assert style. Gitignored
# with the rest of tools/. Cross-file: sites/search_orchestrator.py
# (_classify_site_health, search_all, _emit_site_health), aio_search_cli.py
# (parse_disable_sites).

import os
import sys
import time

# Import from the repo root regardless of CWD.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sites  # noqa: E402
import sites.search_orchestrator as so  # noqa: E402
from aio_search_cli import parse_disable_sites  # noqa: E402

_failures = []


def check(label, cond):
    tag = "PASS" if cond else "FAIL"
    if not cond:
        _failures.append(label)
    print(f"  [{tag}] {label}")


# ─────────────────────────────────────────────────────────────────────────
# 1. _classify_site_health truth table
# ─────────────────────────────────────────────────────────────────────────
print("1. _classify_site_health")
C = so._classify_site_health
BASE = dict(errored=False, blocked=False, never_finished=False, stuck=False,
            constitutionally_slow=False)


def cls(fanout_s, probe_s, **over):
    kw = dict(BASE)
    kw.update(over)
    return C(fanout_s, probe_s, **kw)


check("errored -> down/error", cls(1.0, None, errored=True) == ("down", "error"))
check("blocked -> down/blocked", cls(None, None, blocked=True) == ("down", "blocked"))
check("never_finished -> down/late_fanout",
      cls(None, None, never_finished=True) == ("down", "late_fanout"))
check("stuck -> down/probe_stuck", cls(None, 999, stuck=True) == ("down", "probe_stuck"))
# Hard-down precedence: a slow fan-out that ALSO errored is down, not slow.
check("errored beats slow_fanout",
      cls(99.0, None, errored=True) == ("down", "error"))
# stuck fires even for constitutionally-slow handlers (hard-down, not the gated
# slow_probe): a genuinely hung comix is still caught.
check("stuck fires for constitutionally_slow",
      cls(None, None, stuck=True, constitutionally_slow=True) == ("down", "probe_stuck"))
check("slow fan-out (>=10s)", cls(so.SEARCH_SLOW_FANOUT_S + 0.1, None) == ("slow", "slow_fanout"))
check("fan-out just under threshold is ok",
      cls(so.SEARCH_SLOW_FANOUT_S - 0.1, None) == ("ok", None))
check("slow probe (>=30s, normal handler)",
      cls(2.0, so.SEARCH_SLOW_PROBE_S + 1) == ("slow", "slow_probe"))
# The single most important refinement: a constitutionally-slow handler's deep
# probe is slow BY DESIGN and must NOT be flagged slow_probe.
check("slow probe EXEMPT for constitutionally_slow",
      cls(2.0, so.SEARCH_SLOW_PROBE_S + 100, constitutionally_slow=True) == ("ok", None))
check("all-quiet -> ok", cls(2.0, 5.0) == ("ok", None))
check("None timings -> ok", cls(None, None) == ("ok", None))
# fan-out beats probe when both slow (reason precedence is fan-out first)
check("slow_fanout precedes slow_probe",
      cls(so.SEARCH_SLOW_FANOUT_S + 1, so.SEARCH_SLOW_PROBE_S + 1) == ("slow", "slow_fanout"))


# ─────────────────────────────────────────────────────────────────────────
# 2. parse_disable_sites
# ─────────────────────────────────────────────────────────────────────────
print("2. parse_disable_sites")


class _Args:
    def __init__(self, v):
        self.disable_sites = v


check("comma + whitespace + case + trailing comma",
      parse_disable_sites(_Args("MangaKatana, zeroscans ,")) == {"mangakatana", "zeroscans"})
check("None -> empty set", parse_disable_sites(_Args(None)) == set())
check("empty string -> empty set", parse_disable_sites(_Args("")) == set())
check("missing attr -> empty set", parse_disable_sites(object()) == set())
check("blanks only -> empty set", parse_disable_sites(_Args(" , , ")) == set())


# ─────────────────────────────────────────────────────────────────────────
# 3. search_all end-to-end assembly with stub handlers (no network)
# ─────────────────────────────────────────────────────────────────────────
print("3. search_all site_health assembly")


class StubHandler:
    """Minimal search-capable handler stand-in. `behavior` drives search()."""
    EXPENSIVE_PROBE = False
    OFFICIAL_PUBLISHER = False

    def __init__(self, name, behavior, *, cost_hint="normal", hit_title=None):
        self.name = name
        self.display_name = name.capitalize()
        self.domains = (f"{name}.test",)
        self.SEARCH_COST_HINT = cost_hint
        self._behavior = behavior
        self._hit_title = hit_title

    def search(self, query, scraper, make_request, language="en", limit=20):
        if self._behavior == "dead":
            raise RuntimeError("simulated unreachable site")
        if self._behavior == "slow":
            time.sleep(0.15)
            return []
        if self._behavior == "ok_hit":
            return [so.SearchHit(site=self.name, title=self._hit_title or query,
                                 url=f"https://{self.name}.test/x")]
        return []  # "fast" — up, no match


class FakeCache:
    """Stands in for ProbeFailureCache: only is_blocked + record_* are used."""
    def __init__(self, blocked_hosts):
        self.blocked = set(blocked_hosts)

    def is_blocked(self, host):
        return host in self.blocked

    def record_failure(self, host):
        pass

    def record_success(self, host):
        pass


# Hermetic + fast: no T2 warmup thread, a tiny slow-threshold so a 0.15s sleep
# reads as slow. Restore afterwards so the module stays clean for other tests.
_orig_iter = sites.iter_search_capable_handlers
_orig_warmup = so.warmup_t2_models
_orig_slow_fanout = so.SEARCH_SLOW_FANOUT_S
so.warmup_t2_models = lambda *a, **k: None
so.SEARCH_SLOW_FANOUT_S = 0.05

try:
    handlers = [
        StubHandler("okhit", "ok_hit", hit_title="Frieren"),  # matches query -> success path
        StubHandler("deadsite", "dead"),                      # raises -> down/error
        StubHandler("slowsite", "slow"),                      # 0.15s -> slow/slow_fanout
        StubHandler("fastsite", "fast"),                      # up, no match -> ok (no entry)
        StubHandler("disabledsite", "dead"),                  # excluded -> NO entry
        StubHandler("comixlike", "slow", cost_hint="slow"),   # slow BUT would need probe; fan-out slow still flags
        StubHandler("blockedsite", "fast"),                   # cache-blocked -> down/blocked (skipped)
    ]
    sites.iter_search_capable_handlers = lambda: list(handlers)
    cache = FakeCache(blocked_hosts={"blockedsite.test"})

    # ---- Call A: success path (okhit returns a matching hit) ----
    diag = {}
    so.search_all(
        "Frieren",
        scraper_factory=lambda h: object(),
        make_request=lambda *a, **k: None,
        parallelism=8,
        seeded_only=False,
        img_quality_cache=None,          # skip probe phase
        probe_failure_cache=cache,
        exclude_sites={"disabledsite"},
        diagnostics=diag,
        on_status=None,
    )
    health = {e["site"]: e for e in diag.get("site_health", [])}
    check("site_health key present", "site_health" in diag)
    check("deadsite -> down/error",
          health.get("deadsite", {}).get("status") == "down"
          and health["deadsite"]["reason"] == "error")
    check("slowsite -> slow/slow_fanout",
          health.get("slowsite", {}).get("reason") == "slow_fanout")
    check("comixlike slow fan-out still flagged (fan-out is not gated)",
          health.get("comixlike", {}).get("reason") == "slow_fanout")
    check("fastsite (ok) -> NO entry", "fastsite" not in health)
    check("okhit (ok) -> NO entry", "okhit" not in health)
    check("disabledsite (excluded) -> NO entry", "disabledsite" not in health)
    check("blockedsite -> down/blocked",
          health.get("blockedsite", {}).get("reason") == "blocked")
    check("display_name surfaced", health.get("slowsite", {}).get("display_name") == "Slowsite")
    check("slowsite fanout_s recorded (>0)", (health.get("slowsite", {}).get("fanout_s") or 0) > 0)
    # eligible_count excludes the disabled + blocked-skipped sites (5 eligible:
    # okhit, deadsite, slowsite, fastsite, comixlike).
    check("eligible_count == 5", diag.get("eligible_count") == 5)
    check("phase_times present", isinstance(diag.get("phase_times"), dict))
    # tested_sites = the fanned-out set (the UI's strike-DECAY roster). It is
    # exactly `eligible`: the healthy fastsite is HERE (so the UI can decay it)
    # even though it is correctly ABSENT from site_health. Disabled + blocked
    # sites never entered the fan-out, so they must NOT appear.
    tested = set(diag.get("tested_sites") or [])
    check("tested_sites == the 5 eligible",
          tested == {"okhit", "deadsite", "slowsite", "fastsite", "comixlike"})
    check("tested_sites includes healthy-but-unflagged fastsite", "fastsite" in tested)
    check("tested_sites excludes disabled site", "disabledsite" not in tested)
    check("tested_sites excludes blocked site", "blockedsite" not in tested)

    # ---- Call B: no-hits EARLY-RETURN path still emits health ----
    # Every handler returns [] or raises -> all_hits empty -> early return; the
    # health snapshot must STILL be populated (this is the 'all sites down' case).
    diag2 = {}
    handlers_b = [StubHandler("deadsite", "dead"), StubHandler("slowsite", "slow"),
                  StubHandler("fastsite", "fast")]
    sites.iter_search_capable_handlers = lambda: list(handlers_b)
    res = so.search_all(
        "zzznobodymatchesthis",
        scraper_factory=lambda h: object(),
        make_request=lambda *a, **k: None,
        seeded_only=False,
        img_quality_cache=None,
        probe_failure_cache=None,
        diagnostics=diag2,
        on_status=None,
    )
    h2 = {e["site"]: e for e in diag2.get("site_health", [])}
    check("no-hits path returns []", res == [])
    check("no-hits path STILL emits health", "site_health" in diag2)
    check("no-hits: deadsite -> down/error", h2.get("deadsite", {}).get("reason") == "error")
    check("no-hits: slowsite -> slow/slow_fanout", h2.get("slowsite", {}).get("reason") == "slow_fanout")
    check("no-hits: fastsite -> NO entry", "fastsite" not in h2)
    # The no-hits EARLY-RETURN path must still emit tested_sites (the decay set),
    # or an "all sites down, zero matches" run could never decay a site that
    # later recovers.
    tested_b = set(diag2.get("tested_sites") or [])
    check("no-hits: tested_sites still emitted",
          tested_b == {"deadsite", "slowsite", "fastsite"})

    # ---- Call C: diagnostics=None must not crash ----
    sites.iter_search_capable_handlers = lambda: [StubHandler("fastsite", "fast")]
    so.search_all("q", scraper_factory=lambda h: object(),
                  make_request=lambda *a, **k: None, seeded_only=False,
                  img_quality_cache=None, probe_failure_cache=None, diagnostics=None)
    check("diagnostics=None is a no-op (no crash)", True)
finally:
    sites.iter_search_capable_handlers = _orig_iter
    so.warmup_t2_models = _orig_warmup
    so.SEARCH_SLOW_FANOUT_S = _orig_slow_fanout


# ─────────────────────────────────────────────────────────────────────────
# 4. Reachability refinement (2026-07-13, fix 3): the emit-time liveness probe
#    that splits down(unreachable)-from-slow and softens a reachable errored
#    search to slow/search_error.
# ─────────────────────────────────────────────────────────────────────────
print("4a. _refine_with_reachability truth table")
R = so._refine_with_reachability
check("errored + reachable -> slow/search_error",
      R("down", "error", True) == ("slow", "search_error"))
check("errored + unreachable -> down/unreachable",
      R("down", "error", False) == ("down", "unreachable"))
check("errored + unknown(None) -> unchanged down/error",
      R("down", "error", None) == ("down", "error"))
check("slow_fanout + unreachable -> down/unreachable",
      R("slow", "slow_fanout", False) == ("down", "unreachable"))
check("slow_fanout + reachable -> unchanged slow/slow_fanout",
      R("slow", "slow_fanout", True) == ("slow", "slow_fanout"))
check("slow_probe + reachable -> unchanged slow/slow_probe",
      R("slow", "slow_probe", True) == ("slow", "slow_probe"))
check("late_fanout + reachable -> softened to slow (site up, search hung)",
      R("down", "late_fanout", True) == ("slow", "late_fanout"))
check("probe_stuck + reachable -> softened to slow",
      R("down", "probe_stuck", True) == ("slow", "probe_stuck"))
check("blocked + reachable -> stays down/blocked (cache is authority)",
      R("down", "blocked", True) == ("down", "blocked"))
check("blocked + unreachable -> stays down/blocked",
      R("down", "blocked", False) == ("down", "blocked"))


print("4b. _reachability_urls / _probe_site_reachable helpers")


class _DomHandler:
    domains = ("foo.com", "www.foo.com", "bar.net")


check("_reachability_urls: apex https, www-deduped",
      so._reachability_urls(_DomHandler()) == ["https://foo.com/", "https://bar.net/"])


class _CandHandler:
    domains = ("old.com",)

    def _candidate_domains(self):
        return ["live.com", "old.com"]


_cu = so._reachability_urls(_CandHandler())
check("_reachability_urls: _candidate_domains() preferred first",
      _cu and _cu[0] == "https://live.com/")
check("_reachability_urls: merges candidate + domains tuple",
      "https://old.com/" in _cu)


class _CapHandler:
    domains = ("a.com", "b.com", "c.com", "d.com", "e.com")


check("_reachability_urls: capped at _REACHABILITY_MAX_URLS",
      len(so._reachability_urls(_CapHandler())) == so._REACHABILITY_MAX_URLS)


class _NoDom:
    domains = ()


check("_reachability_urls: no domains -> []", so._reachability_urls(_NoDom()) == [])


class _OneDom:
    domains = ("x.com",)


class _FakeScraper:
    def __init__(self, mode):
        self._mode = mode

    def get(self, url, timeout=None, allow_redirects=True):
        if self._mode == "boom":
            raise ConnectionError("dead host")

        class _R:
            status_code = 403  # a CF challenge still means the SERVER answered
        return _R()


check("_probe_site_reachable: unusable scraper (no .get) -> None",
      so._probe_site_reachable(_OneDom(), lambda h: object(), timeout_s=1.0) is None)
check("_probe_site_reachable: host answers (even 4xx) -> True",
      so._probe_site_reachable(_OneDom(), lambda h: _FakeScraper("ok"), timeout_s=1.0) is True)
check("_probe_site_reachable: all hosts raise -> False",
      so._probe_site_reachable(_OneDom(), lambda h: _FakeScraper("boom"), timeout_s=1.0) is False)
check("_probe_site_reachable: no domains -> None",
      so._probe_site_reachable(_NoDom(), lambda h: _FakeScraper("ok"), timeout_s=1.0) is None)


print("4c. search_all reachability end-to-end (mocked probe)")


class RecordingCache(FakeCache):
    """FakeCache that records record_failure/record_success calls so the test can
    assert the reachability refinement feeds the cache exactly once per confirmed-
    unreachable host and never double-counts an already-errored one."""
    def __init__(self, blocked_hosts=()):
        super().__init__(blocked_hosts)
        self.failures = []
        self.successes = []

    def record_failure(self, host):
        self.failures.append(host)

    def record_success(self, host):
        self.successes.append(host)


_orig_probe = so._probe_site_reachable
_orig_iter2 = sites.iter_search_capable_handlers
_orig_warmup2 = so.warmup_t2_models
_orig_slow_fanout2 = so.SEARCH_SLOW_FANOUT_S
so.warmup_t2_models = lambda *a, **k: None
so.SEARCH_SLOW_FANOUT_S = 0.05
# Canned liveness verdicts keyed by handler name.
_verdicts = {
    "mangakatana": True,   # errored BUT reachable  -> slow/search_error
    "omegascans": True,    # slow BUT reachable     -> stays slow/slow_fanout
    "zeroscans": False,    # slow + unreachable     -> down/unreachable (+1 cache failure)
    "deadunreach": False,  # errored + unreachable  -> down/unreachable (NO double failure)
}
so._probe_site_reachable = lambda handler, sf, *, timeout_s: _verdicts.get(handler.name)
try:
    handlers_c = [
        StubHandler("mangakatana", "dead"),
        StubHandler("omegascans", "slow"),
        StubHandler("zeroscans", "slow"),
        StubHandler("deadunreach", "dead"),
        StubHandler("okhit", "ok_hit", hit_title="Frieren"),  # keeps all_hits nonempty
    ]
    sites.iter_search_capable_handlers = lambda: list(handlers_c)
    rcache = RecordingCache()
    diag3 = {}
    so.search_all(
        "Frieren",
        scraper_factory=lambda h: object(),
        make_request=lambda *a, **k: None,
        parallelism=8,
        seeded_only=False,
        img_quality_cache=None,
        probe_failure_cache=rcache,
        diagnostics=diag3,
        on_status=None,
    )
    hc = {e["site"]: e for e in diag3.get("site_health", [])}
    check("mangakatana errored+reachable -> slow/search_error",
          hc.get("mangakatana", {}).get("status") == "slow"
          and hc["mangakatana"]["reason"] == "search_error")
    check("omegascans slow+reachable -> stays slow/slow_fanout",
          hc.get("omegascans", {}).get("status") == "slow"
          and hc["omegascans"]["reason"] == "slow_fanout")
    check("zeroscans slow+unreachable -> down/unreachable",
          hc.get("zeroscans", {}).get("status") == "down"
          and hc["zeroscans"]["reason"] == "unreachable")
    check("deadunreach errored+unreachable -> down/unreachable",
          hc.get("deadunreach", {}).get("reason") == "unreachable")
    # Cache side-effects: reachability records a failure for a non-errored
    # unreachable host (zeroscans) but NOT for a reachable one (omegascans);
    # an already-errored+unreachable host (deadunreach) is recorded EXACTLY once
    # (by _run_one's except, not doubled by the refinement).
    check("reachability recorded zeroscans failure (non-errored unreachable)",
          "zeroscans.test" in rcache.failures)
    check("reachable slow site never recorded a failure (omegascans)",
          "omegascans.test" not in rcache.failures)
    check("errored+unreachable host recorded exactly once (deadunreach)",
          rcache.failures.count("deadunreach.test") == 1)
    # mangakatana is still flagged, but as SLOW now — so the UI folds it as +1
    # (needs 2 runs), not the instant +2 a 'down' would get. Verified via status
    # above; the strike weighting lives in useDownloader.setSearchSiteHealth.
finally:
    so._probe_site_reachable = _orig_probe
    sites.iter_search_capable_handlers = _orig_iter2
    so.warmup_t2_models = _orig_warmup2
    so.SEARCH_SLOW_FANOUT_S = _orig_slow_fanout2


# ─────────────────────────────────────────────────────────────────────────
print()
if _failures:
    print(f"FAILED ({len(_failures)}): " + "; ".join(_failures))
    sys.exit(1)
print("ALL PASSED")
