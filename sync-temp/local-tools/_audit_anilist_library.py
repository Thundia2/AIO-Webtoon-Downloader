"""Read-only audit: find series whose cached AniList match likely points at the
WRONG series. Heuristic: the site-provided author should appear in the matched
AniList entry's STORY/ART staff. When it doesn't but DOES match a different
same-title candidate, that's the Fly-Me-to-the-Moon bug class.

One AniList search per series (site title), with by-id fallback for the cached
entry when it's not in the search page. Author compare is order-insensitive
fuzzy (token_set_ratio) so "Hata Kenjirou" == "Kenjirou Hata".
"""
import json, os, time, glob
import requests
from rapidfuzz import fuzz
from rapidfuzz.utils import default_process

ROOT = r"D:\AIO\manga"
URL = "https://graphql.anilist.co"
FRAG = """
fragment M on Media {
  id idMal type format status countryOfOrigin isAdult chapters volumes
  title { romaji english native userPreferred }
  synonyms startDate { year } popularity
  staff(perPage: 8) { edges { role node { name { full native } } } }
  relations { edges { relationType node { id type format } } }
}
"""
SEARCH = "query($s:String!){ Page(perPage:8){ media(search:$s,type:MANGA){ ...M } } }" + FRAG
BYID = "query($id:Int!){ Media(id:$id,type:MANGA){ ...M } }" + FRAG
TITLE_THRESH = 75.0
AUTHOR_THRESH = 86.0
AUTHOR_ROLES_OK = ("story", "art")

# --- Refresh-outcome predictor -------------------------------------------------
# Mirror of sites/external_metadata._pick_best_candidate's composite rank so the
# audit can PREDICT what `--refresh-library-metadata --metadata-refresh` would
# pick NOW. Many cached ids pre-date the popularity/author-aware ranker, and the
# author heuristic below is BLIND to the stub-duplicate class: when AniList has
# two entries for one work (e.g. a 1-chapter oneshot pilot + the real
# serialization) they share the same staff, so author-compare says "ok" while a
# far more popular same-title entry is the true match. Kept as a local reimpl
# (not an import of sites.external_metadata) so this tool stays self-contained
# and fast — importing the module triggers sites/__init__'s full handler
# registry. If _rank_key / _score_candidate_detail / the thresholds change there,
# mirror the change here. grep sync target: external_metadata._rank_key.
PREDICT_AUTHOR_THRESH = 85.0   # == external_metadata.ANILIST_AUTHOR_MATCH_THRESHOLD
TITLE_BAND_DELTA = 8.0         # == external_metadata._TITLE_BAND_DELTA


def post(query, variables, tries=4):
    for a in range(tries):
        try:
            r = requests.post(URL, json={"query": query, "variables": variables}, timeout=20)
        except requests.RequestException:
            time.sleep(1.0)
            continue
        if r.status_code == 200:
            j = r.json()
            if j.get("errors"):
                return {}
            return j.get("data") or {}
        if r.status_code == 429:
            wait = float(r.headers.get("Retry-After", "2") or 2)
            time.sleep(min(15, max(1, wait)))
            continue
        if 500 <= r.status_code < 600:
            time.sleep(1.5)
            continue
        return {}
    return {}


def titles(m):
    t = m.get("title") or {}
    out = [t.get(k) for k in ("romaji", "english", "native", "userPreferred") if t.get(k)]
    out += [s for s in (m.get("synonyms") or []) if s]
    return out


def author_names(m):
    edges = ((m.get("staff") or {}).get("edges")) or []
    names = []
    for e in edges:
        role = (e.get("role") or "").lower()
        if not any(k in role for k in AUTHOR_ROLES_OK):
            continue
        if any(bad in role for bad in ("translator", "lettering", "design", "assistant", "editor")):
            continue
        nm = (e.get("node") or {}).get("name") or {}
        for v in (nm.get("full"), nm.get("native")):
            if v:
                names.append(v)
    return names


def title_score(src_list, m):
    cand = titles(m)
    best = 0.0
    for s in src_list:
        for c in cand:
            sc = fuzz.WRatio(s, c, processor=default_process)
            if sc > best:
                best = sc
    return best


def author_score(site_authors, m):
    al = author_names(m)
    if not site_authors or not al:
        return None
    best = 0.0
    for s in site_authors:
        for c in al:
            sc = fuzz.token_set_ratio(s, c, processor=default_process)
            if sc > best:
                best = sc
    return best


def title_detail(src_list, m):
    """(best_title_score, primary_hit) — mirrors
    external_metadata._score_candidate_detail. primary = the four official title
    slots; synonyms = the free-form list. primary_hit means a PRIMARY title (not
    a synonym) cleared the 75 gate — the signal that keeps a doujin/parody that
    only lists the title as a SYNONYM from tying the real series."""
    tb = m.get("title") or {}
    primary = [tb[k] for k in ("romaji", "english", "native", "userPreferred") if tb.get(k)]
    synonyms = [x for x in (m.get("synonyms") or []) if x]

    def best_over(cs):
        b = 0.0
        for s in src_list:
            for c in cs:
                sc = fuzz.WRatio(s, c, processor=default_process)
                if sc > b:
                    b = sc
        return b

    ps = best_over(primary)
    ss = best_over(synonyms)
    return max(ps, ss), (ps >= TITLE_THRESH)


def predict_pick(src_titles, src_authors, cands):
    """The candidate the SHIPPING ranker would choose over `cands` now, or None.

    Mirrors external_metadata._pick_best_candidate with year omitted (the refresh
    path passes year=None, so year_matched is a constant False and drops out of
    the key). Key: (in_band, primary_hit, popularity, author_matched, title). The
    75 title floor stays a HARD gate, so this can never predict an unrelated
    series — only reorder title-plausible ones, exactly like the real ranker."""
    gated = []
    for c in cands:
        ts, primary = title_detail(src_titles, c)
        if ts < TITLE_THRESH:
            continue
        asc = author_score(src_authors, c)
        am = asc is not None and asc >= PREDICT_AUTHOR_THRESH
        pop = int(c.get("popularity") or 0)
        gated.append((am, primary, pop, ts, c))
    if not gated:
        return None
    best_title = max(r[3] for r in gated)

    def key(r):
        am, primary, pop, ts, _c = r
        in_band = ts >= best_title - TITLE_BAND_DELTA
        return (in_band, primary, pop, am, ts)

    gated.sort(key=key, reverse=True)
    return gated[0][4]


def relation_between(a, b_id):
    """The AniList relationType on media `a` whose edge points at media id
    `b_id`, else None. ALTERNATIVE is AniList's own 'same work, different
    version/serialization' link — the ONLY relation under which swapping the
    cached match for a more-popular sibling is provably not a cross-series
    mismatch. SEQUEL/PREQUEL/SIDE_STORY/SPIN_OFF/ADAPTATION are DISTINCT works
    (e.g. a light-novel ADAPTATION or a pilot's SEQUEL) and must not auto-swap.
    Requires `relations` in FRAG."""
    for e in ((a or {}).get("relations") or {}).get("edges") or []:
        if (e.get("node") or {}).get("id") == b_id:
            return e.get("relationType")
    return None


def load_series():
    out = []
    for meta_path in glob.glob(os.path.join(ROOT, "*", ".aio_series.json")):
        folder = os.path.dirname(meta_path)
        try:
            meta = json.load(open(meta_path, encoding="utf-8"))
        except Exception:
            continue
        if not meta.get("anilist_id"):
            continue
        authors = [a for a in (meta.get("authors") or []) if a and a.strip()]
        seen = set()
        ded = []
        for a in authors:
            k = a.strip().lower()
            if k not in seen:
                seen.add(k)
                ded.append(a.strip())
        out.append({
            "folder": os.path.basename(folder),
            "title": meta.get("title") or os.path.basename(folder),
            "authors": ded,
            "anilist_id": int(meta.get("anilist_id")),
            "country": meta.get("country_of_origin"),
            "format": meta.get("media_format"),
            "site": meta.get("site"),
            # Seed the refresh-outcome predictor's scoring titles exactly like
            # _refresh_library_metadata does (comic_data["alt_names"] = synonyms).
            "synonyms": [x for x in (meta.get("anilist_synonyms") or []) if x],
        })
    return out


def main():
    series = load_series()
    print(f"Auditing {len(series)} enriched series (have anilist_id) under {ROOT}\n", flush=True)
    results = []
    for i, s in enumerate(series, 1):
        data = post(SEARCH, {"s": s["title"]})
        time.sleep(0.7)
        cands = (data.get("Page", {}) or {}).get("media", []) or []
        by_id = {c["id"]: c for c in cands if c.get("id")}
        cached = by_id.get(s["anilist_id"])
        if cached is None:
            m = post(BYID, {"id": s["anilist_id"]})
            time.sleep(0.7)
            cached = (m or {}).get("Media")
        cur_author = author_score(s["authors"], cached) if cached else None
        cur_title = title_score([s["title"]], cached) if cached else 0.0
        alts = []
        for c in cands:
            ts = title_score([s["title"]], c)
            if ts < TITLE_THRESH:
                continue
            asc = author_score(s["authors"], c)
            alts.append((c, ts, asc))
        author_hits = [(c, ts, asc) for (c, ts, asc) in alts if asc is not None and asc >= AUTHOR_THRESH]
        author_hits.sort(key=lambda x: (x[2], x[0].get("popularity") or 0), reverse=True)
        suggestion = author_hits[0][0] if author_hits else None

        # Predict what a cache-bypass refresh would pick NOW (shipping ranker),
        # then classify by AniList relation. This catches the class the author
        # heuristic misses: a stub/oneshot duplicate cached before the popularity
        # ranker existed, where both entries share the author (so author-compare
        # says "ok") but a far more popular ALTERNATIVE is the real series.
        # Reason buckets (only the first is auto-refreshed):
        #   more-popular-duplicate  predicted is ALTERNATIVE to cached, both
        #                           author-match, predicted more popular -> same
        #                           work, safe to swap to the canonical entry.
        #   author-fix              cached author DISagrees, predicted matches ->
        #                           self-heal territory (REVIEW; overlaps the
        #                           Eleceed/Tekyuu romanization false positives).
        #   related-<x>             predicted != cached but relation is SEQUEL/
        #                           ADAPTATION/etc -> a DISTINCT work (REVIEW).
        #   ranker-change           unexplained reorder (REVIEW).
        # Mirror the shipping search EXACTLY: drop NOVEL-format hits
        # (external_metadata._EXCLUDED_FORMATS) and do NOT inject the cached
        # entry — a force_refresh skips the by-id fast path and ranks the search
        # pool alone, so injecting cached would diverge from the real outcome.
        # (The un-filtered version produced false positives: KonoSuba/Oregairu's
        # light NOVEL outranked the manga the refresh actually keeps.)
        pool = [c for c in cands if c.get("format") != "NOVEL"]
        scoring_titles = [s["title"]] + s.get("synonyms", [])
        predicted = predict_pick(scoring_titles, s["authors"], pool)
        pred_id = predicted.get("id") if predicted else None
        cached_pop = int((cached or {}).get("popularity") or 0)
        pred_pop = int((predicted or {}).get("popularity") or 0)
        refresh_change = pred_id is not None and pred_id != s["anilist_id"]
        # How AniList relates cached<->predicted decides confidence. ALTERNATIVE
        # (checked from either side) == same work -> safe to swap to the more
        # canonical entry. Any other relation, or none, == possibly a DISTINCT
        # work (sequel, LN adaptation, spinoff) -> review, never auto-swap.
        refresh_relation = None
        if refresh_change:
            refresh_relation = (relation_between(cached, pred_id)
                                or relation_between(predicted, s["anilist_id"]))
        refresh_reason = ""
        if refresh_change:
            pred_author = author_score(s["authors"], predicted)
            cur_ok = cur_author is not None and cur_author >= PREDICT_AUTHOR_THRESH
            pred_ok = pred_author is not None and pred_author >= PREDICT_AUTHOR_THRESH
            if refresh_relation == "ALTERNATIVE" and cur_ok and pred_ok and pred_pop > cached_pop:
                refresh_reason = "more-popular-duplicate"        # SAFE: same work
            elif (cur_author is not None and cur_author < PREDICT_AUTHOR_THRESH
                  and pred_ok):
                refresh_reason = "author-fix"                    # REVIEW (self-heal territory)
            elif refresh_relation:
                refresh_reason = "related-%s" % refresh_relation.lower()  # REVIEW: distinct work
            else:
                refresh_reason = "ranker-change"                 # REVIEW

        if s["authors"]:
            if cur_author is None:
                verdict = "no-staff-on-match"
            elif cur_author >= AUTHOR_THRESH:
                verdict = "ok"
            else:
                if suggestion is not None and suggestion.get("id") != s["anilist_id"]:
                    verdict = "WRONG-author-mismatch+better-exists"
                else:
                    verdict = "author-mismatch"
        else:
            verdict = "no-site-author"

        row = {
            "folder": s["folder"], "title": s["title"], "site": s["site"],
            "site_authors": s["authors"],
            "cached_id": s["anilist_id"], "cached_country": s["country"], "cached_format": s["format"],
            "cached_title_score": round(cur_title, 1),
            "cached_author_score": (None if cur_author is None else round(cur_author, 1)),
            "cached_anilist_title": (titles(cached)[0] if cached else None),
            "cached_anilist_staff": (author_names(cached) if cached else []),
            "cached_popularity": cached_pop,
            "verdict": verdict,
            "refresh_change": refresh_change,
            "refresh_reason": refresh_reason,
            "refresh_relation": refresh_relation,
            "refresh_would_pick_id": pred_id if refresh_change else None,
        }
        if refresh_change:
            row["refresh_pick_title"] = titles(predicted)[0] if predicted else None
            row["refresh_pick_popularity"] = pred_pop
            row["refresh_pick_country"] = (predicted or {}).get("countryOfOrigin")
        if suggestion is not None and suggestion.get("id") != s["anilist_id"]:
            row["suggested_id"] = suggestion["id"]
            row["suggested_title"] = titles(suggestion)[0]
            row["suggested_country"] = suggestion.get("countryOfOrigin")
            row["suggested_staff"] = author_names(suggestion)
        results.append(row)
        tag = "" if verdict in ("ok", "no-site-author") else f"   <<< {verdict}"
        rtag = f"   [refresh->{pred_id} {refresh_reason}]" if refresh_change else ""
        a_disp = row["cached_author_score"]
        print(f"[{i:>3}/{len(series)}] {s['folder'][:46]:46}  id={s['anilist_id']:<7} "
              f"t={row['cached_title_score']:>5} a={a_disp}{tag}{rtag}", flush=True)
        if "suggested_id" in row:
            print(f"        suggest -> id={row['suggested_id']} {row['suggested_title']!r} "
                  f"({row['suggested_country']}) staff={row['suggested_staff']}", flush=True)

    json.dump(results, open("tools/_anilist_audit.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    from collections import Counter
    c = Counter(r["verdict"] for r in results)
    for k, v in c.most_common():
        print(f"  {v:>3}  {k}")
    flagged = [r for r in results if r["verdict"].startswith("WRONG") or r["verdict"] == "author-mismatch"]
    print(f"\nLIKELY WRONG MATCHES ({len(flagged)}):")
    for r in flagged:
        print(f"  - {r['folder']}: cached id={r['cached_id']} "
              f"({r['cached_anilist_title']!r}, {r['cached_country']}) "
              f"site_author={r['site_authors']}")
        if "suggested_id" in r:
            print(f"      -> should be id={r['suggested_id']} ({r['suggested_title']!r}, {r['suggested_country']})")

    # Refresh-outcome section: what a cache-bypass refresh would actually change.
    # SAFE bucket = more-popular-duplicate ONLY: predicted is AniList-ALTERNATIVE
    # (same work) to the cached entry, both author-match, predicted more popular.
    # Everything else is REVIEW — related-<x> is a DISTINCT work (sequel/LN
    # adaptation/spinoff), author-fix overlaps the runtime self-heal (and the
    # known author-romanization false positives: Eleceed/Tekyuu), ranker-change
    # is an unexplained reorder. Only the SAFE bucket goes in the auto command.
    changed = [r for r in results if r.get("refresh_change")]
    from collections import Counter as _C
    rc = _C(r["refresh_reason"] for r in changed)
    print("\n" + "=" * 70)
    print(f"REFRESH WOULD CHANGE THE MATCH ({len(changed)})")
    print("=" * 70)
    for k, v in rc.most_common():
        tag = "  <SAFE>" if k == "more-popular-duplicate" else "  <review>"
        print(f"  {v:>3}  {k}{tag}")

    def _print_bucket(rows):
        for r in rows:
            rel = r.get("refresh_relation") or "-"
            print(f"  - {r['folder']}   [rel={rel}]")
            print(f"      cached id={r['cached_id']} (pop {r.get('cached_popularity')}, "
                  f"{r['cached_anilist_title']!r})")
            print(f"      refresh-> id={r['refresh_would_pick_id']} (pop {r.get('refresh_pick_popularity')}, "
                  f"{r.get('refresh_pick_title')!r})")

    safe = [r for r in changed if r["refresh_reason"] == "more-popular-duplicate"]
    review = [r for r in changed if r["refresh_reason"] != "more-popular-duplicate"]
    if safe:
        print(f"\n[SAFE — more-popular-duplicate / ALTERNATIVE] ({len(safe)}):")
        _print_bucket(safe)
    if review:
        print(f"\n[REVIEW — do NOT auto-swap] ({len(review)}):")
        _print_bucket(review)

    # Ready-to-run targeted refresh for the SAFE bucket only. Each folder name is
    # passed verbatim as a case-insensitive substring filter
    # (_refresh_library_metadata matches folder name OR source url).
    if safe:
        subs = " ".join('"%s"' % r["folder"] for r in safe)
        print("\nTargeted refresh (SAFE bucket only):")
        print('  python aio-dl.py --refresh-library-metadata --metadata-refresh '
              '--output-dir "%s" %s' % (ROOT, subs))

    print("\nFull JSON: tools/_anilist_audit.json")


main()
