// ============================================================
// findView — pure view model for finding sources of folders that are only
// on a target (UI pass U4; spec §4 "Find sources (batch)" sheet and the
// single find's Search banner)
//
// Rows come from the batch runner (electron/sync/find-sources.js, persisted
// per target; the hook keeps them in findRows[targetId] by folder):
//   {folder, query, include, state, candidates[≤5], pick, pinnedUrl, skip,
//    error, searchedAt}
//   candidate {title, year, best:{site, url, title, cover, composite,
//              chapters, qualityBasis}, sources}
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

/** The URL a row would queue: a pinned URL wins over the picked candidate. */
export function rowUrl(row) {
  if (!row) return null;
  if (row.pinnedUrl) return row.pinnedUrl;
  const c = row.pick != null && row.candidates ? row.candidates[row.pick] : null;
  return (c && c.best && c.best.url) || null;
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
      pick: r ? r.pick : null,
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

/** "0.92 · ch.97" for a candidate's best source. */
export function candidateScore(c) {
  const b = c && c.best;
  if (!b) return "";
  const parts = [];
  if (b.composite != null) parts.push(b.composite.toFixed(2));
  if (b.chapters != null) parts.push(`ch.${b.chapters}`);
  return parts.join(" · ");
}

/** A rating not measured from chapter pages gets the red triangle (SearchSourceCard's rule). */
export function unmeasured(c) {
  return !!(c && c.best && c.best.qualityBasis && c.best.qualityBasis !== "chapter_probe");
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
