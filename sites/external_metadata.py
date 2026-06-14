"""AniList GraphQL metadata enrichment for AIO-Webtoon-Downloader.

This module owns the external-metadata enrichment path used when the user
passes --metadata-source anilist. It queries https://graphql.anilist.co
(free, anonymous-readable, 90 req/min, no auth) to fetch normalized tags,
descriptions, country of origin, media format, and cross-reference IDs
(AniList + MAL), then merges those into the per-series `comic_data` dict
that aio-dl.py passes around.

What reads from this module:
  - aio-dl.py:main() — calls enrich_from_anilist right after
    allocate_series_output_dir; threads results through the ComicInfo.xml
    builders, the Komikku details.json writer, and the .aio_series.json
    writer.
  - aio_search_cli.py registers the same CLI flags for parity but does
    NOT call this module in v1 (the search CLI doesn't end-to-end fetch
    comic context yet; reserved for the next search refactor).

What this module depends on:
  - requests (already a project dep; aio-dl.py:454, requirements.txt)
  - rapidfuzz (already a project dep; sites/search_orchestrator.py uses
    fuzz.WRatio the same way, requirements.txt:15) — imported lazily
    inside _score_candidate so a packager who strips rapidfuzz only
    breaks --metadata-source enrichment, not the rest of the project.
  - Standard library only otherwise (html, re, time, dataclasses, typing).

Network resilience notes:
  - This module does NOT route through aio-dl.py's make_request /
    scraper / cloudscraper / cooldown plumbing. AniList isn't a comic
    source — it's a metadata API with documented rate limits — so the
    per-handler hardening is overkill. We do our own 429 + 5xx retry
    with the published Retry-After header.
  - All public functions are best-effort. Network failures, malformed
    responses, and no-match-found are signalled by returning the
    comic_data dict unchanged (no `anilist_id` key set). Callers MUST
    handle that path; this module never raises into the caller for a
    network-level problem. The single exception is ImportError on
    rapidfuzz (project-wide hard dep) which propagates so the user
    knows what to install.
"""
from __future__ import annotations

import html
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import requests


# --- Constants -------------------------------------------------------------

ANILIST_GRAPHQL_URL = "https://graphql.anilist.co"

# rapidfuzz WRatio (0..100) threshold for accepting an AniList match.
# 75 was chosen empirically: at 60+ rapidfuzz starts admitting same-genre-
# different-series matches (e.g. "Solo Leveling" vs "Solo Login" scores
# ~64 on live data); at 75+ matches are reliably the right series under
# any reasonable title variant including translit drift between sites.
# Not exposed as a CLI flag — when users want more matches they should
# fix their site's title field, not lower this floor.
ANILIST_TITLE_MATCH_THRESHOLD = 75.0

# Spacing between retries when AniList didn't tell us how long to wait.
# Budget at 90 req/min = 1 every 0.67s; 0.7s leaves ~5% margin so we
# never get caught by the burst limiter. Only applies inside the retry
# loop; one-shot calls run immediately.
ANILIST_RATE_LIMIT_SLEEP_S = 0.7

ANILIST_TIMEOUT_S = 15

ANILIST_MAX_RETRIES = 3

# Cap on AniList search requests per series on the no-match path. Each source
# title now expands to up to four queries (full, bracket-cleaned, trailing
# subtitle segment, shortened prefix — see enrich_from_anilist), so 6 leaves
# room for the primary's variants plus an alt's. Early-stop means the common
# case (full title matches on query 1) still costs a single request; this cap
# only bounds the worst case so a series genuinely absent from AniList can't
# trigger a request storm.
_MAX_SEARCH_QUERIES = 6

# Drop candidates with these formats from the search-result pool. NOVEL
# poisons comic enrichment (light novels share titles with their manga
# adaptations and AniList lists them as separate Media entries). ONE_SHOT
# is kept — some downloads are legitimate one-shots and rapidfuzz scoring
# usually picks the serialized entry first anyway.
_EXCLUDED_FORMATS = frozenset({"NOVEL"})


# --- Public dataclass ------------------------------------------------------

@dataclass
class AnilistTag:
    """One AniList Media tag, normalized.

    `rank` is the 0..100 relevance score AniList computes; we filter on it
    in _split_tags. `is_*_spoiler` are the two flavours of spoiler flag:
    media-specific (e.g. "Tragedy" spoils *this* series) vs general (e.g.
    "Time Travel" is broadly spoilerish for any story). Either flag puts
    the tag into the spoiler bucket — the user's reader can decide
    granularity at display time using the per-tag attributes preserved
    in the ComicInfo.xml <TagsExtended> block, the Komikku details.json
    (flat `anilist_tags` / `anilist_spoiler_tags` keys), and
    .aio_series.json.

    Cross-file: serialized to dict in aio-dl.py's details.json writer (grep
    _build_aio_reader_extras) and .aio_series.json writer (grep _tag_to_dict),
    and to XML in aio-dl.py:_emit_tags_extended.
    """
    name: str
    category: str
    rank: int
    is_media_spoiler: bool
    is_general_spoiler: bool


# --- Internal: GraphQL document --------------------------------------------

# The full Media fragment used by both fetch-by-id and search-by-title.
# Field selection optimized for ComicInfo.xml enrichment + library
# display + MAL cross-reference. asHtml:false is requested per the
# AniList docs convention but the API still returns <br>/<i>/<b> tags
# in practice (verified 2026-05-28) — _strip_anilist_html handles both.
_MEDIA_FRAGMENT = """
fragment MediaFields on Media {
  id
  idMal
  type
  format
  status
  countryOfOrigin
  isAdult
  title { romaji english native userPreferred }
  synonyms
  description(asHtml: false)
  startDate { year }
  chapters
  volumes
  averageScore
  meanScore
  popularity
  coverImage { extraLarge large }
  siteUrl
  genres
  tags { name category rank isAdult isMediaSpoiler isGeneralSpoiler }
}
"""

_QUERY_BY_ID = f"""
query($id: Int!) {{
  Media(id: $id, type: MANGA) {{
    ...MediaFields
  }}
}}
{_MEDIA_FRAGMENT}
"""

_QUERY_BY_SEARCH = f"""
query($search: String!, $perPage: Int = 8) {{
  Page(perPage: $perPage) {{
    media(search: $search, type: MANGA) {{
      ...MediaFields
    }}
  }}
}}
{_MEDIA_FRAGMENT}
"""


# --- Internal: HTTP client -------------------------------------------------

def _query_anilist(
    query: str, variables: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """POST a GraphQL query to AniList with 429/5xx retry.

    Returns the parsed `data` block on success, None on definitive
    failure (network unreachable, 4xx other than 429, exhausted retries,
    or GraphQL `errors` field in the payload — usually a stale ID).
    Never raises — callers handle None by skipping enrichment or falling
    through to search.

    Cross-file: caller-side error handling at aio-dl.py's enrichment
    hook (try/except around the enrich_from_anilist call) is the final
    safety net; this function should already absorb every transient.
    """
    for attempt in range(ANILIST_MAX_RETRIES):
        try:
            response = requests.post(
                ANILIST_GRAPHQL_URL,
                json={"query": query, "variables": variables},
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=ANILIST_TIMEOUT_S,
            )
        except requests.RequestException:
            if attempt + 1 < ANILIST_MAX_RETRIES:
                time.sleep(ANILIST_RATE_LIMIT_SLEEP_S)
                continue
            return None

        status = response.status_code
        if status == 200:
            try:
                payload = response.json()
            except ValueError:
                return None
            # GraphQL errors come back inside a 200 with an `errors` key;
            # treat a non-empty errors list as a query failure (typically
            # a stale ID for fetch-by-id) so the caller can fall through.
            if payload.get("errors"):
                return None
            return payload.get("data") or {}

        if status == 429:
            # AniList sends Retry-After in seconds. Cap at 10s so a
            # misconfigured header can't wedge the run.
            retry_after_raw = response.headers.get("Retry-After", "")
            try:
                retry_after = min(10.0, float(retry_after_raw))
            except ValueError:
                retry_after = ANILIST_RATE_LIMIT_SLEEP_S
            if attempt + 1 < ANILIST_MAX_RETRIES:
                time.sleep(max(0.1, retry_after))
                continue
            return None

        if 500 <= status < 600:
            if attempt + 1 < ANILIST_MAX_RETRIES:
                time.sleep(ANILIST_RATE_LIMIT_SLEEP_S)
                continue
            return None

        # 4xx other than 429: don't retry. AniList returns 404 for
        # missing media IDs and 400 for malformed queries — either way
        # a retry won't help.
        return None

    # Unreachable in practice (the loop always returns inside an
    # iteration), but kept for static-analysis quieting and as a safety
    # net against future refactors of the loop body.
    return None


def _fetch_by_id(anilist_id: int) -> Optional[Dict[str, Any]]:
    """Fetch a single Media by its AniList ID. Returns None on miss."""
    data = _query_anilist(_QUERY_BY_ID, {"id": int(anilist_id)})
    if not data:
        return None
    return data.get("Media")


def _search_candidates(
    title: str, *, per_page: int = 8
) -> List[Dict[str, Any]]:
    """Search AniList by free-text title. Returns up to per_page candidates.

    Filters out NOVEL-format hits so a light novel adaptation can't win
    the score over its manga sibling. ONE_SHOT is kept (some downloads
    legitimately ARE oneshots; rapidfuzz usually picks the serialized
    entry first when both exist).
    """
    if not title:
        return []
    data = _query_anilist(
        _QUERY_BY_SEARCH, {"search": title, "perPage": int(per_page)}
    )
    if not data:
        return []
    page = data.get("Page") or {}
    candidates = page.get("media") or []
    return [c for c in candidates if (c.get("format") not in _EXCLUDED_FORMATS)]


# --- Internal: HTML cleanup ------------------------------------------------

# Strip-but-keep-content tag families. Block-level tags like <p>/<div>
# don't appear in AniList descriptions in practice — kept narrow on
# purpose so a future API change doesn't silently swallow useful markup.
_HTML_STRIP_PAIRS = re.compile(
    r"</?(?:i|b|em|strong|u|s|del|ins|small|sup|sub|span)\b[^>]*>",
    re.IGNORECASE,
)
# <br>, <br/>, <br /> all collapse to a single newline.
_HTML_BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
# Three-or-more newlines collapse to two (preserves paragraph breaks
# while killing the "AniList double-<br>" → "\n\n\n" inflation pattern).
_NEWLINE_COLLAPSE = re.compile(r"\n{3,}")


def _strip_anilist_html(desc: Optional[str]) -> str:
    """Convert AniList's HTML-flavoured description to plain text.

    AniList's `description(asHtml: false)` still emits `<br>`, `<i>`,
    `<b>` etc. in practice (verified 2026-05-28 against the live API).
    We strip the tags, decode HTML entities, normalize line endings,
    and collapse runaway blank lines so the output is suitable for
    ComicInfo.xml `<Summary>`, Komikku `details.json` `description`,
    and library UI display.

    Attribution lines like `(Source: Tappytoon)` and any prose-level
    structure are preserved unchanged.
    """
    if not desc:
        return ""
    s = str(desc)
    s = _HTML_BR.sub("\n", s)
    s = _HTML_STRIP_PAIRS.sub("", s)
    s = html.unescape(s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = _NEWLINE_COLLAPSE.sub("\n\n", s)
    return s.strip()


# --- Internal: matching ----------------------------------------------------

# Bracket/tilde families that wrap subtitle noise AniList's search index
# chokes on. Stripped (not split) so the core title survives; see
# _clean_search_title.
_TITLE_NOISE_RE = re.compile(r"~[^~]*~|\([^)]*\)|\[[^\]]*\]|[【「][^】」]*[】」]")


def _clean_search_title(title: str) -> str:
    """Return `title` with bracketed/tilde subtitle segments stripped.

    e.g. "Shangri-La Frontier ~ Kusoge Hunter, Kamige ni Idoman to su~"
    -> "Shangri-La Frontier". Used as a fallback AniList search query (and
    scoring title) when the full stored title returns no candidates — some
    sites bake a ~...~ or (...) subtitle into the title that defeats
    AniList's search index. Deliberately does NOT split on ':' / ' - '
    subtitle separators: that would surface a parent series for a spinoff
    (e.g. "...Spoils Me Rotten: After the Rain") and risk a wrong match even
    with full-title scoring. May return a string equal to the input (caller
    dedupes) or "" if nothing survives. Cross-file: called only from
    enrich_from_anilist's search path. Subtitle-separator SPLITTING does
    happen — but in _subtitle_segment, which is search-query-only (never a
    scoring title), so the parent-match risk above doesn't apply to it.
    """
    if not title:
        return ""
    s = _TITLE_NOISE_RE.sub(" ", str(title))
    return re.sub(r"\s+", " ", s).strip()


# Subtitle/volume separators: a ':' or a SPACED dash. Used to pull the trailing
# distinctive segment out of titles AniList's search can't match whole — e.g.
# "JoJo no Kimyou na Bouken: Part 4 - Diamond wa Kudakenai" (0 results) vs the
# trailing "Diamond wa Kudakenai" (id 33006). Hyphens WITHOUT surrounding
# spaces ("Shangri-La", "Boku-tachi") are deliberately NOT separators.
_SUBTITLE_SPLIT_RE = re.compile(r":\s+|\s+[-–—]\s+")


def _subtitle_segment(title: str) -> str:
    """Trailing segment after the last subtitle separator — a SEARCH query only,
    never a scoring title. "" when there's no separator or the trailing part is
    a <2-word fragment (too generic to anchor a search). Because the match is
    still gated by scoring against the FULL title in enrich_from_anilist,
    pulling a parent/other series into the candidate pool here is harmless: it
    fails the 75 threshold. grep caller: enrich_from_anilist.
    """
    parts = [p.strip() for p in _SUBTITLE_SPLIT_RE.split(str(title or "")) if p.strip()]
    if len(parts) < 2:
        return ""
    seg = parts[-1]
    return seg if len(seg.split()) >= 2 else ""


def _shortened_prefix(title: str, words: int = 4) -> str:
    """First `words` tokens of a LONG, separator-less title — a SEARCH query
    only. "" when the title has a subtitle separator (use _subtitle_segment
    instead) or is short enough (≤5 words) that the full-title query already
    covers it. Rescues long romaji whose spelling drifts between the site and
    AniList — e.g. AnoHana's "...Namae o Boku-tachi..." vs AniList's
    "...Namae wo Bokutachi..." returns nothing whole, but "Ano Hi Mita Hana"
    matches id 65733. grep caller: enrich_from_anilist.
    """
    s = str(title or "")
    if _SUBTITLE_SPLIT_RE.search(s):
        return ""
    toks = s.split()
    if len(toks) <= max(words, 5):
        return ""
    return " ".join(toks[:words])


def _candidate_titles(media: Dict[str, Any]) -> List[str]:
    """All title variants a candidate exposes — used for fuzzy matching."""
    title_block = media.get("title") or {}
    out: List[str] = []
    for key in ("romaji", "english", "native", "userPreferred"):
        val = title_block.get(key)
        if val:
            out.append(str(val))
    for syn in media.get("synonyms") or []:
        if syn:
            out.append(str(syn))
    return out


def _score_candidate(
    source_titles: List[str], candidate: Dict[str, Any]
) -> float:
    """Best (max) rapidfuzz WRatio across all (source x candidate) pairs,
    compared case/punctuation-insensitively via default_process.

    rapidfuzz is project-wide required for cross-site search; this lazy
    import keeps the failure mode consistent (clear ImportError naming
    the install command) instead of failing at module-load time.
    """
    try:
        from rapidfuzz import fuzz
        from rapidfuzz.utils import default_process
    except ImportError as exc:
        raise ImportError(
            "rapidfuzz is required for --metadata-source enrichment. "
            "Install with: pip install rapidfuzz"
        ) from exc
    if not source_titles:
        return 0.0
    cand_titles = _candidate_titles(candidate)
    if not cand_titles:
        return 0.0
    # processor=default_process lowercases, trims, and strips non-alphanumerics
    # on both sides before scoring. Without it WRatio is brutally case-sensitive:
    # "FULL METAL ALCHEMIST" vs the synonym "Full Metal Alchemist" scores 25 raw
    # but 100 processed (verified against id 30025), while the unrelated romaji
    # "Hagane no Renkinjutsushi" sits at 26 processed. So the 75 threshold still
    # separates cleanly — processing rescues case/punctuation drift without
    # inventing matches.
    best = 0.0
    for s in source_titles:
        for c in cand_titles:
            score = float(fuzz.WRatio(s, c, processor=default_process))
            if score > best:
                best = score
    return best


def _pick_best_candidate(
    source_titles: List[str],
    candidates: List[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], float]:
    """Return (best_candidate, best_score) — best_candidate is None when
    no candidate cleared ANILIST_TITLE_MATCH_THRESHOLD.

    The score is returned in both branches so the caller can log the
    best-seen-score when a match was rejected ("no confident match
    for X — best score 42 < 75").
    """
    best_cand: Optional[Dict[str, Any]] = None
    best_score = 0.0
    for cand in candidates:
        score = _score_candidate(source_titles, cand)
        if score > best_score:
            best_cand = cand
            best_score = score
    if best_cand is None or best_score < ANILIST_TITLE_MATCH_THRESHOLD:
        return None, best_score
    return best_cand, best_score


# --- Internal: derived fields ----------------------------------------------

def _derive_media_format(country_code: Optional[str]) -> Optional[str]:
    """Map AniList countryOfOrigin → user-friendly format label.

    AniList stores everything as format=MANGA regardless of origin. We
    derive a label so the user's reader can badge titles "Manhwa"/
    "Manhua"/"Manga" without re-deriving the mapping on the read side.
    Same convention MangaUpdates uses for its `type` field.
    """
    if not country_code:
        return None
    code = str(country_code).upper()
    if code == "KR":
        return "MANHWA"
    if code in ("CN", "TW"):
        return "MANHUA"
    if code == "JP":
        return "MANGA"
    return "MANGA"


def _split_tags(
    raw_tags: List[Dict[str, Any]], tag_min_rank: int
) -> Tuple[List[AnilistTag], List[AnilistTag]]:
    """Filter raw AniList tag dicts → (non_spoiler, spoiler) AnilistTag lists.

    Tags below `tag_min_rank` are dropped entirely. Adult-only tags
    are NOT filtered here — the per-Media `isAdult` flag governs that
    at the caller level; suppressing here would defeat enrichment for
    the cases where it matters most.

    Both lists are sorted (-rank, name) for stable XML output and
    predictable cross-run diffs.
    """
    non_spoiler: List[AnilistTag] = []
    spoiler: List[AnilistTag] = []
    for raw in raw_tags or []:
        try:
            rank = int(raw.get("rank") or 0)
        except (TypeError, ValueError):
            rank = 0
        if rank < int(tag_min_rank):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        tag = AnilistTag(
            name=name,
            category=str(raw.get("category") or "").strip(),
            rank=rank,
            is_media_spoiler=bool(raw.get("isMediaSpoiler")),
            is_general_spoiler=bool(raw.get("isGeneralSpoiler")),
        )
        if tag.is_media_spoiler or tag.is_general_spoiler:
            spoiler.append(tag)
        else:
            non_spoiler.append(tag)
    non_spoiler.sort(key=lambda t: (-t.rank, t.name.lower()))
    spoiler.sort(key=lambda t: (-t.rank, t.name.lower()))
    return non_spoiler, spoiler


def _dedupe_genres(*genre_lists: List[str]) -> List[str]:
    """Concatenate genre/tag-name lists with case-insensitive dedupe.

    Order: earlier lists win; first-seen casing is preserved, so the
    leading list dictates the display form when two sources spell a genre
    differently. Empty/blank entries are dropped.

    Used by _apply_anilist_match to build the normalized visible genre
    field = AniList genres (coarse buckets) followed by AniList high-rank
    tag names (fine descriptors).

    Renamed from _union_genres (2026-06-06): the merge is no longer
    site ∪ AniList. On a confident match AniList is authoritative and the
    site's own genre list is dropped entirely — it was the source of the
    50+-tag taxonomy dumps (e.g. mangakatana leaking its whole nav genre
    dropdown). See the REPLACE semantics documented in
    _apply_anilist_match. grep callers: only _apply_anilist_match.
    """
    out: List[str] = []
    seen_lower = set()
    for genre_list in genre_lists:
        for src in genre_list or []:
            if not src:
                continue
            key = str(src).strip().lower()
            if key and key not in seen_lower:
                seen_lower.add(key)
                out.append(str(src).strip())
    return out


# --- Internal: apply -------------------------------------------------------

def _apply_anilist_match(
    comic_data: Dict[str, Any],
    media: Dict[str, Any],
    tag_min_rank: int,
) -> None:
    """Mutate comic_data with fields from an AniList Media doc.

    Field merge semantics (per plan-locked user decisions):
      - desc: REPLACE with AniList description (per user choice — max
        uniformity for filtering)
      - genres: REPLACE with AniList genres + high-rank non-spoiler tag
        names (case-insensitive dedupe via _dedupe_genres). The site's
        genre list is dropped on a confident match — it's the source of
        the 50+-tag taxonomy dumps. Spoilers are excluded from this
        visible field. Falls back to the site genres only when AniList
        contributed nothing (changed from UNION 2026-06-06 per user req).
      - authors / artists: FILL-MISSING (v1 doesn't fetch AniList
        staff{} connection so this is effectively a no-op today; the
        semantic is documented for future expansion)
      - status: REPLACE with AniList enum spelling. The existing
        aio-dl.py:_komikku_status_to_digit helper already handles
        AniList's enum spellings via its lowercase mapping
        (FINISHED → "finished" → "2", RELEASING → "releasing" → "1",
        CANCELLED → "cancelled" → "5", HIATUS → "hiatus" → "6",
        NOT_YET_RELEASED → falls through to "0"). No helper change
        needed.
      - anilist_tags / anilist_spoiler_tags: SET (AniList-only fields)
      - cover: REPLACE with AniList coverImage (extraLarge → large) for
        cross-library cover normalization — every enriched series ends up
        with one cover source/quality/aspect. The site's own cover is
        stashed under `site_cover` (aio-dl.py's cover-download path falls
        back to it if the AniList CDN fetch fails) and the AniList URL is
        also mirrored to `anilist_cover` (read by --refresh-library-metadata
        to decide cover.jpg re-download). Only set when AniList actually
        supplied a cover.
      - country_of_origin / media_format / anilist_id / mal_id /
        anilist_synonyms: SET
    """
    if media.get("id"):
        comic_data["anilist_id"] = int(media["id"])
    if media.get("idMal"):
        comic_data["mal_id"] = int(media["idMal"])

    cleaned_desc = _strip_anilist_html(media.get("description"))
    if cleaned_desc:
        comic_data["desc"] = cleaned_desc

    non_spoiler, spoiler = _split_tags(media.get("tags") or [], tag_min_rank)
    comic_data["anilist_tags"] = non_spoiler
    comic_data["anilist_spoiler_tags"] = spoiler

    # REPLACE the visible genre list with AniList's curated set: AniList
    # genres (coarse buckets) followed by the high-rank non-spoiler tag
    # names (fine descriptors). The site's own genre list is dropped on a
    # confident match — many sites (mangakatana especially) leak their
    # entire genre taxonomy into this field, and the previous union-merge
    # preserved that garbage. Spoiler tags are deliberately excluded so the
    # default-visible genre field never leaks spoilers (they stay in
    # anilist_spoiler_tags / <SpoilerTags>). Only fall back to the existing
    # site genres if AniList contributed nothing at all (pathological:
    # matched but zero genres AND zero tags above tag_min_rank) — never
    # blank the field. Cross-file: flows to ComicInfo <Genre> (aio-dl.py
    # build_comic_info_xml / build_per_chapter_comic_info_xml) and Komikku
    # details.json `genre` (aio-dl.py, grep '"genre": list(comic_data').
    normalized_genres = _dedupe_genres(
        media.get("genres") or [],
        [t.name for t in non_spoiler],
    )
    if normalized_genres:
        comic_data["genres"] = normalized_genres

    if media.get("status"):
        comic_data["status"] = str(media["status"])

    country = media.get("countryOfOrigin")
    if country:
        comic_data["country_of_origin"] = str(country)
    media_format = _derive_media_format(country)
    if media_format:
        comic_data["media_format"] = media_format

    # Cover normalization: REPLACE the series cover with AniList's so the
    # whole library shares one cover source/quality/aspect. extraLarge is
    # AniList's highest-res variant; large is the smaller fallback. Stash the
    # site's own cover under `site_cover` so aio-dl.py's cover-download block
    # can fall back to it when the AniList CDN fetch fails (dl_image returns
    # None, never raises). Cross-file: aio-dl.py cover-download block (grep
    # 'site_cover'); the chosen cover flows to cover.jpg, the .aio_series.json
    # `cover` field, and the UI thumbnail cache (library.js keys on
    # seriesMeta.cover).
    cover_block = media.get("coverImage") or {}
    anilist_cover = cover_block.get("extraLarge") or cover_block.get("large")
    if anilist_cover:
        anilist_cover = str(anilist_cover)
        existing_cover = comic_data.get("cover")
        if existing_cover and existing_cover != anilist_cover:
            comic_data["site_cover"] = existing_cover
        comic_data["cover"] = anilist_cover
        # Record the AniList cover URL explicitly (parallel to anilist_id).
        # Not written to any sink today — cover.jpg + the `cover` field carry
        # it — but --refresh-library-metadata reads it to decide whether to
        # re-download cover.jpg, so it stays truthy ONLY when AniList actually
        # supplied a cover (not merely when a site cover is present). grep
        # anilist_cover in aio-dl.py.
        comic_data["anilist_cover"] = anilist_cover

    comic_data["anilist_synonyms"] = list(media.get("synonyms") or [])


# --- Public entry point ----------------------------------------------------

def enrich_from_anilist(
    comic_data: Dict[str, Any],
    *,
    hid: str,
    handler_name: str,
    year: Optional[int],
    cover_url: Optional[str],
    tag_min_rank: int,
    force_refresh: bool,
    cached_anilist_id: Optional[int],
) -> Dict[str, Any]:
    """Enrich `comic_data` in place from AniList; return the same dict.

    Flow:
      1. If `cached_anilist_id` is set AND NOT `force_refresh`: fetch
         that Media by ID (1 GraphQL hit). On success, apply fields and
         return immediately. On 404 / network failure / API errors,
         fall through to the search path so a stale cached ID can
         self-heal.
      2. Search AniList for the site title + alt_names. Score every
         candidate via rapidfuzz WRatio across every source-title ×
         candidate-title pair; pick the highest.
      3. If best score >= ANILIST_TITLE_MATCH_THRESHOLD (75), apply
         fields. The match's anilist_id then gets persisted by
         aio-dl.py's .aio_series.json writer so subsequent runs
         take the cached fast path.
      4. Otherwise leave comic_data untouched (no anilist_id key set)
         so the caller knows to log "no confident match" and the run
         continues with site-only metadata. The best-observed score
         is stashed under `_anilist_best_score` purely for the
         caller's log line; the underscore prefix marks it as
         non-persistable transient data and downstream writers ignore
         unknown keys.

    `year`, `cover_url`, `hid`, `handler_name` are currently accepted-
    but-unused — forwarded for future scoring refinements (year
    tiebreak, cover-image perceptual match) without breaking the API.
    """
    # Cached-ID fast path.
    if cached_anilist_id and not force_refresh:
        media = _fetch_by_id(int(cached_anilist_id))
        if media:
            _apply_anilist_match(comic_data, media, tag_min_rank)
            return comic_data
        # Stale ID or transient network failure: fall through. If the
        # search step also fails, comic_data ends up unchanged and the
        # caller logs accordingly.

    # Search path. Two deliberately decoupled lists:
    #   scoring_titles — the identity set: each source title + its bracket/
    #     tilde-cleaned variant. The match is ALWAYS gated by scoring against
    #     these full forms (75 threshold), so nothing below can admit a wrong
    #     series no matter how broad the search net gets.
    #   search_queries — the broader net used only to FIND candidates: the
    #     scoring titles plus two derived fallbacks per title — the trailing
    #     subtitle segment (_subtitle_segment) and a shortened prefix
    #     (_shortened_prefix). These rescue titles AniList returns nothing for
    #     on the full string: subtitle-prefixed romaji ("...Gaiden: Toaru
    #     Kagaku no Railgun" → id 37776), long romaji with spelling drift
    #     (AnoHana → id 65733), and ~...~/(...)-suffixed titles (Shangri-La
    #     Frontier → id 122063).
    # Per-title order is full → cleaned → subtitle → shortened so precise forms
    # are tried before loose fallbacks; early-stop means the common case (full
    # title matches) never fires a fallback query.
    scoring_titles: List[str] = []
    search_queries: List[str] = []
    seen_scoring = set()
    seen_query = set()

    def _add_scoring(v: str) -> None:
        v = (v or "").strip()
        k = v.lower()
        if v and k not in seen_scoring:
            seen_scoring.add(k)
            scoring_titles.append(v)

    def _add_query(v: str) -> None:
        v = (v or "").strip()
        k = v.lower()
        if v and k not in seen_query:
            seen_query.add(k)
            search_queries.append(v)

    raw_titles: List[str] = []
    if comic_data.get("title"):
        raw_titles.append(str(comic_data["title"]))
    for alt in comic_data.get("alt_names") or []:
        if alt:
            raw_titles.append(str(alt))
    for raw in raw_titles:
        cleaned = _clean_search_title(raw)
        _add_scoring(raw)
        _add_scoring(cleaned)
        _add_query(raw)
        _add_query(cleaned)
        _add_query(_subtitle_segment(cleaned or raw))
        _add_query(_shortened_prefix(cleaned or raw))
    if not scoring_titles:
        return comic_data

    # Query AniList with each search query in priority order, accumulating
    # candidates deduped by id; stop early once one clears the threshold when
    # scored against scoring_titles. Bounded to _MAX_SEARCH_QUERIES requests so
    # a series that genuinely isn't on AniList can't fan out into a storm.
    # best_score stays 0.0 across the "no hits" and "hits but all below
    # threshold" branches so the caller's log line is uniform.
    pool: List[Dict[str, Any]] = []
    seen_ids = set()
    best: Optional[Dict[str, Any]] = None
    score = 0.0
    for query in search_queries[:_MAX_SEARCH_QUERIES]:
        for cand in _search_candidates(query):
            cid = cand.get("id")
            if cid is not None and cid in seen_ids:
                continue
            if cid is not None:
                seen_ids.add(cid)
            pool.append(cand)
        if pool:
            best, score = _pick_best_candidate(scoring_titles, pool)
            if best is not None:
                break

    comic_data["_anilist_best_score"] = score
    if best is None:
        return comic_data
    _apply_anilist_match(comic_data, best, tag_min_rank)
    return comic_data
