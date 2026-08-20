package com.aio.downloader.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parsing tests for the `--search-json` contract.
 *
 * WHY THESE MATTER: this parse is where a renamed Python key turns into an
 * empty results page rather than an error. Every field here is read by string
 * from a payload built in `SeriesCandidate.to_json`, three layers away, and a
 * mismatch is silent by construction.
 *
 * The error-vocabulary tests are the other half: `aio_android.search` returns
 * machine codes, and "engine_busy" is not something a user can act on. A raw
 * code reaching the screen is a bug these tests are meant to catch.
 *
 * Cross-file: core/SearchModels.kt (the code), aio_android.search (the
 * producer), tests/test_android_search.py (the Python side of the same
 * contract).
 */
class SearchModelsTest {

    private fun payload(sources: String, title: String = "Frieren") = """
        {"query":"frieren","language":"en","candidates":[
          {"canonical_title":"$title","canonical_year":2020,"sources":[$sources]}
        ]}
    """.trimIndent()

    private val fullSource = """
        {"site":"mangadex","url":"https://mangadex.org/title/abc","title":"Sousou no Frieren",
         "cover":"https://cdn/x.jpg","title_match":0.9231,"seed_quality":0.74,
         "img_quality_score":0.8123,"img_quality_metadata":{"samples_succeeded":6},
         "quality_basis":"chapter_probe","composite_score":0.8712,
         "chapter_count_hint":120,"actual_chapter_count":128,
         "dmca_likely":false,"is_official":true}
    """.trimIndent()

    // ── happy path ─────────────────────────────────────────────────────────

    @Test
    fun `parses a full candidate`() {
        val out = parseSearchOutcome("frieren", payload(fullSource))
        assertNull(out.error)
        assertEquals(1, out.candidates.size)
        val c = out.candidates.first()
        assertEquals("Frieren", c.canonicalTitle)
        assertEquals(2020, c.canonicalYear)
        assertEquals(1, c.siteCount)
        val s = c.sources.first()
        assertEquals("mangadex", s.site)
        assertEquals("https://mangadex.org/title/abc", s.url)
        assertEquals(0.9231, s.titleMatch, 1e-6)
        assertEquals(0.8123, s.imgQuality!!, 1e-6)
        assertTrue(s.isOfficial)
        assertFalse(s.dmcaLikely)
    }

    @Test
    fun `actual chapter count wins over the site's hint`() {
        val s = parseSearchOutcome("f", payload(fullSource)).candidates.first().sources.first()
        assertEquals(128, s.chapterCount)
    }

    @Test
    fun `falls back to the hint when nothing was counted`() {
        val src = fullSource.replace("\"actual_chapter_count\":128", "\"actual_chapter_count\":null")
        val s = parseSearchOutcome("f", payload(src)).candidates.first().sources.first()
        assertEquals(120, s.chapterCount)
    }

    @Test
    fun `max chapters spans every source`() {
        val second = fullSource
            .replace("mangadex", "weebcentral")
            .replace("title/abc", "title/def")
            .replace("\"actual_chapter_count\":128", "\"actual_chapter_count\":131")
        val c = parseSearchOutcome("f", payload("$fullSource,$second")).candidates.first()
        assertEquals(131, c.maxChapters)
        assertEquals(2, c.siteCount)
    }

    // ── the rating caveat ──────────────────────────────────────────────────

    @Test
    fun `only a chapter probe counts as a measured rating`() {
        for ((basis, measured) in listOf(
            "chapter_probe" to true, "cover" to false, "seed" to false, "" to false,
        )) {
            val src = fullSource.replace("\"quality_basis\":\"chapter_probe\"", "\"quality_basis\":\"$basis\"")
            val s = parseSearchOutcome("f", payload(src)).candidates.first().sources.first()
            assertEquals("basis=$basis", measured, s.ratingIsMeasured)
        }
    }

    @Test
    fun `display rating falls back to the seed prior when nothing was measured`() {
        // Both fields move together: Python's _quality_basis returns "seed"
        // whenever img_quality_score is None, so a null score paired with
        // "chapter_probe" is a payload the producer cannot emit.
        val src = fullSource
            .replace("\"img_quality_score\":0.8123", "\"img_quality_score\":null")
            .replace("\"quality_basis\":\"chapter_probe\"", "\"quality_basis\":\"seed\"")
        val s = parseSearchOutcome("f", payload(src)).candidates.first().sources.first()
        assertNull(s.imgQuality)
        assertEquals(0.74, s.displayRating, 1e-6)
        assertFalse(s.ratingIsMeasured)
    }

    @Test
    fun `the rating caveat keys on quality_basis, not on the score being present`() {
        // quality_basis is the authoritative provenance field: a score that
        // came from the COVER is still a number, and calling it measured would
        // be exactly the misrepresentation this flag exists to prevent.
        val src = fullSource.replace("\"quality_basis\":\"chapter_probe\"", "\"quality_basis\":\"cover\"")
        val s = parseSearchOutcome("f", payload(src)).candidates.first().sources.first()
        assertEquals(0.8123, s.imgQuality!!, 1e-6)
        assertFalse(s.ratingIsMeasured)
    }

    // ── degenerate payloads ────────────────────────────────────────────────

    @Test
    fun `an empty candidate list is a result, not an error`() {
        val out = parseSearchOutcome("zzz", """{"query":"zzz","candidates":[]}""")
        assertNull(out.error)
        assertTrue(out.isEmpty)
    }

    @Test
    fun `a source without a url is dropped, not rendered`() {
        val noUrl = fullSource.replace("\"url\":\"https://mangadex.org/title/abc\"", "\"url\":\"\"")
        val out = parseSearchOutcome("f", payload(noUrl))
        // The only source was unusable, so the whole candidate goes.
        assertTrue(out.candidates.isEmpty())
    }

    @Test
    fun `malformed json becomes an error outcome instead of throwing`() {
        val out = parseSearchOutcome("f", "not json at all")
        assertTrue(out.error!!.isNotBlank())
        assertTrue(out.candidates.isEmpty())
    }

    @Test
    fun `missing optional fields do not break the parse`() {
        val minimal = """{"site":"x","url":"https://x/1","title":"T"}"""
        val s = parseSearchOutcome("f", payload(minimal)).candidates.first().sources.first()
        assertEquals(0.0, s.titleMatch, 1e-9)
        assertNull(s.imgQuality)
        assertNull(s.chapterCount)
        assertFalse(s.isOfficial)
    }

    @Test
    fun `a blank canonical title falls back to the source title`() {
        val out = parseSearchOutcome("f", payload(fullSource, title = ""))
        assertEquals("Sousou no Frieren", out.candidates.first().canonicalTitle)
    }

    @Test
    fun `cover comes from the first source that has one`() {
        val noCover = fullSource.replace("\"cover\":\"https://cdn/x.jpg\"", "\"cover\":\"\"")
        val c = parseSearchOutcome("f", payload("$noCover,$fullSource")).candidates.first()
        assertEquals("https://cdn/x.jpg", c.cover)
    }

    // ── error vocabulary ───────────────────────────────────────────────────

    @Test
    fun `every error code becomes human text, never the raw code`() {
        for (code in listOf("engine_busy", "no_query", "no_search_payload", "search_failed")) {
            val out = parseSearchOutcome("f", """{"error":"$code"}""")
            val message = out.error!!
            assertFalse("raw code leaked for $code: $message", message.contains(code))
            assertTrue(message.isNotBlank())
        }
    }

    @Test
    fun `engine busy explains the shared engine rather than blaming the user`() {
        val out = parseSearchOutcome("f", """{"error":"engine_busy"}""")
        assertTrue(out.error!!.contains("download", ignoreCase = true))
    }

    @Test
    fun `search failed carries the underlying detail when there is one`() {
        val out = parseSearchOutcome(
            "f",
            """{"error":"search_failed","detail":"ImportError: rapidfuzz is required"}""",
        )
        assertTrue(out.error!!.contains("rapidfuzz"))
    }

    @Test
    fun `an unknown error code still produces something readable`() {
        val out = parseSearchOutcome("f", """{"error":"some_new_code"}""")
        assertTrue(out.error!!.isNotBlank())
    }

    @Test
    fun `an error outcome is not reported as empty results`() {
        val out = parseSearchOutcome("f", """{"error":"engine_busy"}""")
        assertFalse(out.isEmpty)
    }
}
