"""Functional test for the author-aware AniList matcher. Hits the live API."""
import os
import sys
import time

# Repo root on sys.path (script dir is tools/) — same shim as _test_sidecar_aux.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sites.external_metadata import enrich_from_anilist


def run(label, comic, *, cached=None, force=False, expect):
    cd = dict(comic)
    enrich_from_anilist(
        cd, hid="x", handler_name="test", year=comic.get("year"),
        cover_url=None, tag_min_rank=50, force_refresh=force,
        cached_anilist_id=cached,
    )
    got = cd.get("anilist_id")
    ok = "PASS" if got == expect else "FAIL"
    print(f"[{ok}] {label}: got id={got} country={cd.get('country_of_origin')} "
          f"(expected {expect})")
    time.sleep(0.8)
    return got == expect


results = []
# 1-2. The reported bug class: same-title collisions resolved by author.
results.append(run(
    "Fly Me (search)", {"title": "Fly Me to the Moon", "authors": ["Kenjirou Hata"]},
    expect=101177))
results.append(run(
    "Fairy Tail (search, vs Hentai doujin)",
    {"title": "Fairy Tail", "authors": ["MASHIMA Hiro"]}, expect=30598))
# 3. Solo Leveling must stay on the main series, NOT flip to the sequel Ragnarok
#    (title band beats the sequel's fluke studio-name author match).
results.append(run(
    "Solo Leveling (no flip to sequel)",
    {"title": "Solo Leveling", "authors": ["GEE So-Lyung", "JANG Sung-Lak", "Redice Studio"]},
    expect=105398))
# 4. Self-heal: a poisoned cache (157566) must heal to the real series.
results.append(run(
    "Fly Me (self-heal cache 157566)",
    {"title": "Fly Me to the Moon", "authors": ["Kenjirou Hata"]},
    cached=157566, force=False, expect=101177))
# 5. Author-drift correct series with cache: must KEEP its id (no flip).
results.append(run(
    "Eleceed (drift keeps cache 106929)",
    {"title": "Eleceed", "authors": ["Jeho Son / ZHENA"]},
    cached=106929, force=False, expect=106929))
# 6. No site author + cache: fast path trusts the cache (author=None).
results.append(run(
    "One Piece (no-author cache 30013)",
    {"title": "One Piece", "authors": []}, cached=30013, force=False, expect=30013))
# 7-8. Base vs spinoff must split by title band even with NO author signal.
results.append(run(
    "Angel Next Door base (not spinoff)",
    {"title": "The Angel Next Door Spoils Me Rotten", "authors": []}, expect=122337))
results.append(run(
    "Angel Next Door spinoff (After the Rain)",
    {"title": "The Angel Next Door Spoils Me Rotten After the Rain", "authors": []},
    expect=176688))
# 9. Self-heal popularity guard: a good but author-unmatched cache (Clannad
#    "Official Comic" 32598) must NOT be downgraded to an obscure same-franchise
#    entry (149957) just because the site's "Key (Company)" credit matches it.
results.append(run(
    "Clannad (self-heal keeps popular cache)",
    {"title": "Clannad", "authors": ["Key (Company)"]},
    cached=32598, force=False, expect=32598))

print(f"\n{sum(results)}/{len(results)} passed")
