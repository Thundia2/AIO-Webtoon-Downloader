package com.aio.downloader.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * The cross-site search result shapes, and the parse from `aio_android.search`'s
 * JSON into them.
 *
 * ── WHERE THE DATA COMES FROM ──────────────────────────────────────────────
 * `sites/search_orchestrator.py` fans out to every search-capable handler,
 * merges the hits into one candidate per SERIES, and rates each SOURCE. The
 * `--search-json` contract is `{"query", "language", "candidates": [...]}` where
 * each candidate carries a `sources` array — see `SeriesCandidate.to_json`.
 * Nothing here re-derives any of that; it parses.
 *
 * ── THE ONE THING WORTH KNOWING ABOUT THE RATINGS ──────────────────────────
 * A source's displayed rating is not always measured. `quality_basis` says
 * where it came from: "chapter_probe" means real chapter pages were fetched and
 * scored, "cover" means only the cover image was, and "seed" means it is a
 * per-site prior with nothing measured at all. [SearchSource.ratingIsMeasured]
 * is that distinction, and the UI flags the other two — the desktop shows a red
 * triangle for exactly this (SearchSourceCard.jsx), because a seed rating
 * looks identical to a measured one otherwise.
 *
 * Cross-file: aio_android.search (the payload), SearchRepository.kt (the
 * caller), UI-source/src/components/SearchSourceCard.jsx (the behaviour ported).
 */

/** One site's copy of a series. */
data class SearchSource(
    val site: String,
    val url: String,
    val title: String,
    val cover: String,
    /** 0..1 query-vs-title similarity. rapidfuzz WRatio; see sites/fuzzy_match. */
    val titleMatch: Double,
    /** 0..1 image quality, or null when nothing was measured. */
    val imgQuality: Double?,
    val seedQuality: Double,
    val compositeScore: Double,
    val qualityBasis: String,
    /** From the site's own listing; null when it does not publish one. */
    val chapterCountHint: Int?,
    /** Counted from a real chapter-list fetch; null when not fetched. */
    val actualChapterCount: Int?,
    val dmcaLikely: Boolean,
    val isOfficial: Boolean,
) {
    /** True only when the rating came from measured chapter pages. */
    val ratingIsMeasured: Boolean get() = qualityBasis == "chapter_probe"

    /** What to show as the chapter count, preferring the counted value. */
    val chapterCount: Int? get() = actualChapterCount ?: chapterCountHint

    /** The rating actually displayed: measured if present, else the seed prior. */
    val displayRating: Double get() = imgQuality ?: seedQuality
}

/** One series, with every site that has it. */
data class SearchCandidate(
    val canonicalTitle: String,
    val canonicalYear: Int?,
    val sources: List<SearchSource>,
) {
    /** The orchestrator ranks sources; the first is its pick. */
    val best: SearchSource? get() = sources.firstOrNull()

    val siteCount: Int get() = sources.size

    /** Highest chapter count any source reports — the useful headline number. */
    val maxChapters: Int? get() = sources.mapNotNull { it.chapterCount }.maxOrNull()

    /** Cover from the first source that has one; sites vary in what they expose. */
    val cover: String? get() = sources.firstOrNull { it.cover.isNotBlank() }?.cover
}

/**
 * A whole search. [error] non-null means the run failed; an empty [candidates]
 * with a null error is a legitimate "nothing found", and the two must stay
 * distinguishable — collapsing them would present a failed search as an empty
 * one, which is the bug the desktop's searcher.js explicitly guards against.
 */
data class SearchOutcome(
    val query: String,
    val candidates: List<SearchCandidate>,
    val error: String? = null,
) {
    val isEmpty: Boolean get() = error == null && candidates.isEmpty()
}

// ── parsing ────────────────────────────────────────────────────────────────

private fun JSONObject.intOrNull(key: String): Int? =
    if (isNull(key)) null else optInt(key).takeIf { has(key) }

private fun JSONObject.doubleOrNull(key: String): Double? =
    if (isNull(key)) null else optDouble(key).takeIf { !it.isNaN() }

private fun parseSource(o: JSONObject): SearchSource? {
    val url = o.optString("url").orEmpty()
    // A source with no URL cannot be downloaded, so it has no reason to be on
    // screen — this is the same "drop, do not crash" rule parseSeries uses.
    if (url.isBlank()) return null
    return SearchSource(
        site = o.optString("site").orEmpty(),
        url = url,
        title = o.optString("title").orEmpty(),
        cover = o.optString("cover").orEmpty(),
        titleMatch = o.optDouble("title_match", 0.0).let { if (it.isNaN()) 0.0 else it },
        imgQuality = o.doubleOrNull("img_quality_score"),
        seedQuality = o.optDouble("seed_quality", 0.0).let { if (it.isNaN()) 0.0 else it },
        compositeScore = o.optDouble("composite_score", 0.0).let { if (it.isNaN()) 0.0 else it },
        qualityBasis = o.optString("quality_basis").orEmpty(),
        chapterCountHint = o.intOrNull("chapter_count_hint"),
        actualChapterCount = o.intOrNull("actual_chapter_count"),
        dmcaLikely = o.optBoolean("dmca_likely", false),
        isOfficial = o.optBoolean("is_official", false),
    )
}

private fun parseCandidate(o: JSONObject): SearchCandidate? {
    val sources = buildList {
        val arr = o.optJSONArray("sources") ?: JSONArray()
        for (i in 0 until arr.length()) {
            arr.optJSONObject(i)?.let { parseSource(it) }?.let { add(it) }
        }
    }
    if (sources.isEmpty()) return null
    return SearchCandidate(
        canonicalTitle = o.optString("canonical_title").ifBlank { sources.first().title },
        canonicalYear = o.intOrNull("canonical_year"),
        sources = sources,
    )
}

/**
 * Parse one `aio_android.search` payload.
 *
 * Never throws: a malformed payload becomes a [SearchOutcome] carrying an error
 * string, because the alternative on a device is a crash three layers from
 * anything a stack trace would point at.
 */
fun parseSearchOutcome(query: String, json: String): SearchOutcome {
    val root = try {
        JSONObject(json)
    } catch (e: Exception) {
        return SearchOutcome(query, emptyList(), "Search returned unreadable output.")
    }
    root.optString("error").takeIf { it.isNotBlank() }?.let { code ->
        return SearchOutcome(query, emptyList(), searchErrorMessage(code, root.optString("detail")))
    }
    val arr = root.optJSONArray("candidates") ?: JSONArray()
    val candidates = buildList {
        for (i in 0 until arr.length()) {
            arr.optJSONObject(i)?.let { parseCandidate(it) }?.let { add(it) }
        }
    }
    return SearchOutcome(root.optString("query").ifBlank { query }, candidates)
}

/**
 * Turn `aio_android.search`'s error codes into something a person can act on.
 * Raw codes must never reach the UI — "engine_busy" is not an instruction.
 */
fun searchErrorMessage(code: String, detail: String? = null): String = when (code) {
    "engine_busy" ->
        "A download is running. Search shares the engine with downloads, so it " +
            "has to wait until that finishes."
    "no_query" -> "Enter something to search for."
    "no_search_payload" ->
        "The search finished without returning results. Check the Logs tab for " +
            "what went wrong."
    "search_failed" ->
        if (detail.isNullOrBlank()) "The search failed." else "The search failed: $detail"
    else -> if (detail.isNullOrBlank()) "The search failed ($code)." else detail
}
