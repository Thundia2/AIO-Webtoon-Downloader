// ============================================================
// findView — pure view model for finding sources of folders that are only
// on a target (UI pass U4; spec §4 "Find sources (batch)" sheet and the
// single find's Search banner)
//
// Rows come from the batch runner (electron/sync/find-sources.js, persisted
// per target; the hook keeps them in findRows[targetId] by folder):
//   {folder, query, include, state, candidates[≤5], pickUrl, multiSource,
//    pinnedUrl, skip, error, searchedAt}
//   candidate {title, canonicalTitle, year, best, sources[every site]}
//   source {site, url, title, cover, composite, chapters, qualityBasis,
//           titleMatch}
// (the runner's header owns the field meanings).
//
// WHAT A QUEUED ROW DOWNLOADS (rowQueueArgs): the Search tab's rules,
// reused, not re-derived (SearchSourceCard.handleDownload): the picked site
// is the URL; multiSource is the toggle the row's OWN search ran with (the
// Search tab's dialog defaults to the search's snapshot, and this sheet has
// no dialog); when that is on, the series' other sites ride as
// prefetchedAlts. A pinned URL is a series the search didn't pick, so it
// sends nothing and follows the download defaults.
// The sheet shows exactly the target's CURRENT device-only folders
// (summary.deviceOnly), each joined with its row when one exists; a folder
// the runner hasn't seen yet reads "not searched".
//
// LINKED is asked from the config, not remembered (U4-11): a folder the
// target already holds an alias for (sync/service.js OPS["add-alias"]) was
// queued before, so it shows the alias URL and can't be queued twice. The
// folder leaves device-only once the download lands and the planner binds
// it through that alias (planner step 5).
//
// Consumers: FindSourcesSheet.jsx, App.jsx (findQueueArgs), the DEV gallery.
// Tested by tools/_test_device_sync_view.js.
// ============================================================

import { buildPrefetchedAlts } from "../../lib/prefetchedAlts.js";

/**
 * The series match a row's download comes from: the FIRST candidate listing
 * pickUrl, else candidate 0 (no pick, or a pick no result lists any more).
 * null when pinned or nothing was found.
 */
export function rowCandidate(row) {
  if (!row || row.pinnedUrl) return null;
  const list = row.candidates || [];
  if (row.pickUrl) {
    const c = list.find((x) => (x.sources || []).some((s) => s && s.url === row.pickUrl));
    if (c) return c;
  }
  return list[0] || null;
}

/** The site a row downloads from (a source of rowCandidate), or null. */
export function rowSource(row) {
  const c = rowCandidate(row);
  if (!c) return null;
  const picked = row.pickUrl ? (c.sources || []).find((s) => s && s.url === row.pickUrl) : null;
  return picked || c.best || (c.sources || [])[0] || null;
}

/** The URL a row would queue: a pinned URL wins over the picked site. */
export function rowUrl(row) {
  if (!row) return null;
  if (row.pinnedUrl) return row.pinnedUrl;
  const s = rowSource(row);
  return (s && s.url) || null;
}

/**
 * Download args a row adds (before findQueueArgs): {} when pinned or when
 * the row predates the runner recording multiSource (a migrated row not yet
 * re-searched: the download defaults decide); else {multiSource} plus
 * prefetchedAlts when it is on and the series has another site. A single-
 * site series still sends multiSource: true, like the Search tab, and
 * aio-dl.py then looks for fallbacks itself.
 */
export function rowQueueArgs(row) {
  if (!row || row.pinnedUrl || typeof row.multiSource !== "boolean") return {};
  const c = rowCandidate(row);
  const s = rowSource(row);
  if (!c || !s) return {};
  const args = { multiSource: row.multiSource };
  if (row.multiSource) {
    const alts = buildPrefetchedAlts(c.sources, s, c.canonicalTitle, c.year);
    if (alts) args.prefetchedAlts = alts;
  }
  return args;
}

/** The target's alias for a device folder, or null. */
export function aliasFor(target, folder) {
  const list = (target && Array.isArray(target.aliases) && target.aliases) || [];
  return list.find((a) => a && a.deviceFolder === folder) || null;
}

/**
 * One view row per current device-only folder, in the ledger's order.
 * state: unsearched | queued | searching | done | error | cancelled (runner
 * states, plus `unsearched` for a folder without a row).
 */
export function findRows(items, rowsByFolder, target) {
  const rows = rowsByFolder || {};
  return (items || []).map((d) => {
    const r = rows[d.name] || null;
    const alias = aliasFor(target, d.name);
    const url = rowUrl(r);
    const skip = !!(r && r.skip);
    return {
      key: d.key,
      folder: d.name,
      query: (r && r.query) || d.query || d.name,
      state: r ? r.state : "unsearched",
      candidates: (r && r.candidates) || [],
      pickUrl: (r && r.pickUrl) || null,
      multiSource: r && typeof r.multiSource === "boolean" ? r.multiSource : null,
      pinnedUrl: (r && r.pinnedUrl) || null,
      error: (r && r.error) || null,
      skip,
      url,
      linked: alias ? alias.url || alias.identityKey || alias.pcFolder || "" : null,
      queueable: !skip && !alias && !!url,
    };
  });
}

/** Folders a Search press would run: not skipped, not linked, not already found. */
export function searchable(rows) {
  return (rows || []).filter((r) => !r.skip && r.linked == null && r.state !== "done");
}

// The two helpers below take a candidate (they read its best site) or a
// source itself (a source has no `best` key).
function _site(x) {
  return x && "best" in x ? x.best : x;
}

/** "0.92 · ch.97" for a candidate's best site, or for one site. */
export function candidateScore(c) {
  const b = _site(c);
  if (!b) return "";
  const parts = [];
  if (b.composite != null) parts.push(b.composite.toFixed(2));
  if (b.chapters != null) parts.push(`ch.${b.chapters}`);
  return parts.join(" · ");
}

/** A rating not measured from chapter pages gets the red triangle (SearchSourceCard's rule). */
export function unmeasured(c) {
  const b = _site(c);
  return !!(b && b.qualityBasis && b.qualityBasis !== "chapter_probe");
}

/**
 * Extra download args for a series queued for a target (U4-8): a Komikku
 * reader downloads in Komikku mode; every other reader keeps the defaults.
 */
export function findQueueArgs(target) {
  return target && target.profile === "komikku" ? { komikku: true } : {};
}

const WAITING_COPY = {
  "check-all": "Waiting for Library Check All to finish",
  search: "Waiting for the Search tab's search to finish",
};

/** The sheet's status line for the runner's batch status (hook `find`). */
export function findStatusLine(find, targetId, rows) {
  const list = rows || [];
  if (find && find.targetId === targetId) {
    if (find.waiting) return WAITING_COPY[find.waiting] || "Waiting";
    return `Searching ${Math.min(find.done + 1, find.total)} of ${find.total}…`;
  }
  const found = list.filter((r) => r.state === "done" && r.candidates.length).length;
  const searched = list.filter((r) => r.state === "done" || r.state === "error").length;
  if (!searched) return null;
  return `${found} of ${list.length} found a source.`;
}
