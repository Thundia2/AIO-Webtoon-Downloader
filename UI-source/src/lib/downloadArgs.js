// Shared builder for library/update-check download argument dicts.
//
// Both LibraryTab surfaces that queue an update download — the per-series
// detail view ("Download Missing Chapters", UpdateSection.handleDownloadNew)
// and the Updates Center per-row queue (buildDownloadArgsForRow) — assembled
// the SAME args object from the series metadata + the user's saved
// settings.defaults. They differed in exactly one line (the Updates Center
// path injects seededRatingOnly), so that single difference is the
// `seededRatingOnly` option here.
//
// The produced arg dict is forwarded to useDownloader.queueDownload (via
// App.jsx's onStartDownload wrapper, which spreads settings.defaults UNDER it)
// and ultimately mapped to CLI flags in electron/downloader.js:buildCliArgs.
// Flag names / conditional-inclusion here must stay byte-identical to what
// those call sites emitted before extraction.
//
// Params:
//   meta   — the series' .aio_series.json metadata (seriesMeta). May be {}.
//   d      — settings.defaults (the download-defaults dict). May be {}.
//   chaptersStr — the chapter range string (from chaptersToRangeString).
//   verboseAlways — settings.verboseAlways (the raw value; `?? true` applied here).
//   opts.seededRatingOnly — when true, inject seededRatingOnly (Updates
//     Center's fast seed-based rating; skips the multi-source image-quality
//     probe). Caller decides based on settings.updateChecksUseSeededRating.
//
// NOTE the XF-2 quality default of 100 (NOT 85): any --quality < 100 flips the
// child's _user_set_quality True and disables the CBZ byte-passthrough
// fast-path (silent lossy re-encode). Keep it 100.
export function buildLibraryDownloadArgs(
  meta,
  d,
  chaptersStr,
  verboseAlways,
  { seededRatingOnly = false } = {}
) {
  const m = meta || {};
  const def = d || {};
  const args = {
    format: m.format || def.format || "pdf",
    quality: def.quality ?? 100,
    chapters: chaptersStr,
    language: m.language || "en",
    site: m.site || undefined,
    verbose: verboseAlways ?? true,
  };
  if (def.scaling && def.scaling !== 100) args.scaling = def.scaling;
  if (def.keepChapters) args.keepChapters = true;
  if (def.noFinalFile) args.noFinalFile = true;
  if (def.keepImages) args.keepImages = true;
  if (def.noProcessing) args.noProcessing = true;
  if (def.noCleanup) args.noCleanup = true;
  if (def.imageWorkers && def.imageWorkers !== 3) args.imageWorkers = def.imageWorkers;
  if (def.httpTimeout && def.httpTimeout !== 30) args.httpTimeout = def.httpTimeout;
  if (def.httpMaxRetries && def.httpMaxRetries !== 6) args.httpMaxRetries = def.httpMaxRetries;
  // Default on at the call site — settings.updateChecksUseSeededRating !==
  // false catches both explicit-true and default-undefined. Has no effect
  // when --multi-source isn't on (nothing to probe). Only the Updates Center
  // path passes this true; the detail-view "Download Missing Chapters" path
  // never injected it.
  if (seededRatingOnly) {
    args.seededRatingOnly = true;
  }
  return args;
}
