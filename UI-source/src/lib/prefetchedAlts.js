// ============================================================
// prefetchedAlts — the multi-source fallback payload a search-driven
// download carries: the matched series' OTHER sites, so aio-dl.py builds its
// alternatives from them (--multi-source-prefetched) instead of re-searching
// every site.
//
// ONE builder for both callers, so the two can't drift:
//   * SearchSourceCard.jsx handleDownload (the Search tab), over the raw
//     --search-json candidate (sources carry site/url/title/cover).
//   * components/sync/findView.js rowQueueArgs (Device Sync's Find sources),
//     over find-sources.js's compact candidate (same four keys).
// Consumed by electron/downloader.js:start, which writes the payload to
// ~/.aio-dl/cache/ms_prefetched_<id>.json and swaps it for
// `multiSourcePrefetched` (grep prefetchedAlts there). The caller decides
// whether multi-source is on; SearchTab's confirmSearchDownload strips the
// payload when the user turns it off.
// ============================================================

/**
 * @param {Array<{site, url, title?, cover?}>} sources  the series' sites in the search's rank order
 * @param {{site, url}} primary  the site being downloaded
 * @param {string|null} title    the search's canonical title
 * @param {number|null} year     the search's canonical year
 * @returns {object|null} {primary:{site,url}, alternatives:[{site,url,title,cover}], title, year},
 *   or null when the series has no other site. Order is kept: the search
 *   ranked the sources (official first, DMCA last, quality descending), and
 *   that order is chapter_merger's alignment input order.
 */
export function buildPrefetchedAlts(sources, primary, title, year) {
  if (!Array.isArray(sources) || sources.length < 2 || !primary) return null;
  const alternatives = sources
    .filter((s) => s.url !== primary.url)
    .map((s) => ({
      site: s.site,
      url: s.url,
      // `|| undefined`, not null: JSON.stringify drops the key, which is the
      // shape the Search tab has always sent.
      title: s.title || undefined,
      cover: s.cover || undefined,
    }));
  if (!alternatives.length) return null;
  return {
    primary: { site: primary.site, url: primary.url },
    alternatives,
    title: title || "",
    year: year || null,
  };
}
