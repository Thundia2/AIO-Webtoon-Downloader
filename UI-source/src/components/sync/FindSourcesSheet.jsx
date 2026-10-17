// ============================================================
// FindSourcesSheet — "Find sources for N folders" (UI pass U4; spec §4
// surfaces: right sheet, 600 / 680 px; mockup findSourcesTable())
//
// For a target's device-only folders: search each folder's name, let the
// user pick a candidate or pin a URL per row, then "Queue N downloads".
// A queued row downloads its picked site with the series' other sites as
// multi-source fallbacks, exactly as a Search-tab download would
// (findView.rowQueueArgs → lib/prefetchedAlts.js).
//
// WHO OWNS WHAT
//   * the search runs in main (electron/sync/find-sources.js: its own
//     Searcher, one folder at a time, waits for Check All / a Search-tab
//     search, rows persisted per target). This sheet starts / cancels it
//     and edits rows (find-sources:update-row); rows stream back through
//     the hook's findRows (`find` events).
//   * Queue is the renderer's job by contract (service.js header, "Queue N
//     downloads"): per row IN ORDER, config-op add-alias {url, deviceFolder}
//     FIRST, then onQueueDownload. The alias is what makes the finished
//     download land in the existing folder on the target instead of a new
//     one (planner step 5: alias → that folder → verified). A refused alias
//     queues nothing for that row.
//   * every folder shown has a runner row to edit: find-sources:get
//     reconciles the rows with the plan's device-only folders on open.
//   * which rows are already linked is read from the target's aliases
//     (findView.findRows), so a reopened sheet never offers a second queue.
//
// One checkbox per row = the runner's `skip` (skipped rows are neither
// searched nor queued); `include` stays true.
//
// THE PICKER (F2, the user picked this layout from a mockup 2026-10-17): a
// row shows its matched series and ONE chip for the site it downloads from
// (+N fallbacks). The chip opens every site of that series as radios (pick
// = pickUrl); the search's other, unrelated matches fold behind "Not this
// series?" so lookalikes (e.g. a one-site "Princess Princess") never sit
// beside the real series as if they were more sites of it. The badge is
// findView's Ready / Check match rule; "Check match" rows are not queued
// until the user picks a site, uses another match, or pins a URL.
// Consumer: SyncTab.jsx. Depends on: findView.js, useConfigOps (ops),
// copy.js configRefusalCopy.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Download, Link2, Loader2, Pin, Search, Settings2, X } from "lucide-react";
import { Badge, Button, Checkbox, Input } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import { Cover } from "./Ledger";
import { configRefusalCopy } from "./copy";
import { aliasFor, candidateScore, findQueueArgs, findRows, findStatusLine, otherMatches, rowCandidate, rowQueueArgs, rowSites, rowSource, searchable, unmeasured } from "./findView";

const XS = "h-7 px-2 text-xs gap-1 [&_svg]:h-3.5 [&_svg]:w-3.5";

function RowState({ row }) {
  if (row.linked != null) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-success" title={row.linked}>
        <Link2 className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">Linked · {row.linked}</span>
      </span>
    );
  }
  if (row.state === "searching")
    return (
      <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Searching…
      </span>
    );
  if (row.state === "error") return <span className="truncate text-[11.5px] text-destructive" title={row.error || ""}>Search failed{row.error ? `: ${row.error}` : ""}</span>;
  if (row.state === "done" && !row.candidates.length && !row.pinnedUrl) return <span className="text-[11.5px] text-muted-foreground">No source found. Edit the query, or pin a URL.</span>;
  if (row.state === "unsearched" || row.state === "queued" || row.state === "cancelled") return <span className="text-[11.5px] text-muted-foreground">Not searched yet</span>;
  return null;
}

/** "0.91 · ch.181" plus the red triangle when the rating isn't measured from chapter pages. */
function SiteScore({ source }) {
  const warn = unmeasured(source);
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground" title={warn ? "Rating not measured from chapter pages" : undefined}>
      {candidateScore(source)}
      {warn && <AlertTriangle className="h-3 w-3 text-destructive" aria-label="Rating not measured from chapter pages" />}
    </span>
  );
}

function MatchBadge({ row }) {
  if (row.confirmed)
    return (
      <Badge variant="token-success" title="You picked this series">
        <Check aria-hidden="true" />
        Picked
      </Badge>
    );
  if (row.ready)
    return (
      <Badge variant="token-success" title="The search matched this title clearly ahead of any other">
        <Check aria-hidden="true" />
        Ready
      </Badge>
    );
  return (
    <Badge variant="token-warning" title="The title match is weak or close to another match. Open the sources and confirm it, or pick another.">
      Check match
    </Badge>
  );
}

/**
 * The found-series picker of one row: matched series + badge, the chip for
 * the site it downloads from, and (opened) every site of that series plus
 * the search's other matches. Every change is a pickUrl patch.
 */
function Picker({ row, busy, onPatch }) {
  const [open, setOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const cand = rowCandidate(row);
  const src = rowSource(row);
  const sites = rowSites(row);
  const others = otherMatches(row);
  if (!cand || !src) return null;
  const nMore = sites.length - 1;
  const more = !nMore ? "" : row.multiSource === true ? `+${nMore} fallback${nMore === 1 ? "" : "s"}` : `+${nMore} site${nMore === 1 ? "" : "s"}`;
  const panelId = `find-sites-${row.key}`;
  const title = cand.title || src.title || "Untitled";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[12.5px] font-medium" title={title}>
          {title}
          {cand.year ? <span className="font-normal text-muted-foreground"> ({cand.year})</span> : null}
        </span>
        <MatchBadge row={row} />
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Sources for ${row.folder}: ${src.site}${more ? `, ${more}` : ""}`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 min-w-0 max-w-full items-center gap-1.5 self-start rounded-md border border-input bg-background px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate font-mono">{src.site}</span>
        <SiteScore source={src} />
        {more && <span className="shrink-0 text-[11px] text-muted-foreground">{more}</span>}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-1 rounded-md border border-border/70 bg-muted/30 p-1">
          <div role="radiogroup" aria-label={`Download site for ${row.folder}`}>
            {sites.map(({ source, picked, fallback }) => (
              <label key={source.url} className={cn("flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent", picked && "bg-primary/[.06]")} title={source.url}>
                <input type="radio" name={panelId} className="accent-primary" checked={picked} disabled={busy} onChange={() => onPatch({ pickUrl: source.url })} />
                <span className="w-28 shrink-0 truncate font-mono">{source.site}</span>
                <SiteScore source={source} />
                <span className={cn("ml-auto shrink-0 text-[11px]", picked ? "font-medium text-primary" : "text-muted-foreground")}>{picked ? "downloads" : fallback ? `fallback ${fallback}` : ""}</span>
              </label>
            ))}
          </div>
          {row.multiSource === false && nMore > 0 && <span className="px-2 text-[11px] text-muted-foreground">Fallback sites were off for this search, so only the picked site downloads.</span>}
          {row.needsCheck && (
            <div className="flex items-center gap-2 px-2 py-0.5">
              <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">Is this the series in the folder?</span>
              <Button size="sm" variant="outline" className={XS} disabled={busy} onClick={() => onPatch({ pickUrl: src.url })}>
                <Check aria-hidden="true" />
                Yes, use it
              </Button>
            </div>
          )}
          {others.length > 0 && (
            <div className="flex flex-col border-t border-border/70 pt-1">
              <button type="button" aria-expanded={othersOpen} onClick={() => setOthersOpen((o) => !o)} className="self-start px-2 py-0.5 text-[11.5px] text-muted-foreground underline-offset-2 hover:underline">
                Not this series? {others.length} other match{others.length === 1 ? "" : "es"}
              </button>
              {othersOpen &&
                others.map((c, i) => {
                  const b = c.best || (c.sources || [])[0];
                  if (!b) return null;
                  const n = (c.sources || []).length;
                  return (
                    <div key={`${b.url}-${i}`} className="flex min-w-0 items-center gap-2 px-2 py-1 text-xs">
                      <span className="min-w-0 flex-1 truncate" title={c.title || b.title || ""}>
                        {c.title || b.title || "Untitled"}
                        {c.year ? <span className="text-muted-foreground"> ({c.year})</span> : null}
                      </span>
                      <span className="shrink-0 font-mono text-[11px]">{b.site}</span>
                      {n > 1 && <span className="shrink-0 text-[11px] text-muted-foreground">+{n - 1}</span>}
                      <SiteScore source={b} />
                      <Button size="sm" variant="ghost" className={XS} disabled={busy} onClick={() => onPatch({ pickUrl: b.url })} aria-label={`Use ${c.title || b.title || b.site}`}>
                        Use this
                      </Button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}
      {/* Queued WITH results = a row searched before file version 2 (only 5
          sites per match were kept then; find-sources.js _migrateRow re-queues it). */}
      {row.state === "queued" && <span className="text-[11.5px] text-muted-foreground">Searched by an older version. Search again to see every site.</span>}
      {/* A re-search keeps the old results on screen until the new ones land. */}
      {row.state === "searching" && <RowState row={row} />}
    </div>
  );
}

function FindRow({ row, cover, busy, result, onPatch, onUnlink }) {
  const [query, setQuery] = useState(row.query);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState(row.pinnedUrl || "");
  useEffect(() => setQuery(row.query), [row.query]);
  useEffect(() => setPin(row.pinnedUrl || ""), [row.pinnedUrl]);
  const linked = row.linked != null;
  const commitQuery = () => {
    const q = query.trim();
    if (q && q !== row.query) onPatch({ query: q });
    else setQuery(row.query);
  };
  return (
    <div data-testid="find-row" data-folder={row.folder} className={cn("flex items-start gap-2.5 border-b border-border/70 px-3 py-2.5", (row.skip || linked) && "opacity-70")}>
      <Checkbox
        checked={!row.skip && !linked}
        locked={linked}
        disabled={busy || linked}
        // A stable name that matches what "checked" means (included), so a
        // screen reader says "Include X, not checked" for a skipped row.
        aria-label={`Include ${row.folder}`}
        onCheckedChange={(on) => onPatch({ skip: !on })}
        className="mt-0.5"
      />
      <Cover path={cover} title={row.folder} className="h-[38px] w-[28px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-mono text-xs" title={row.folder}>
          {row.folder}
        </span>
        {!linked && (
          <Input
            value={query}
            disabled={busy || row.state === "searching"}
            aria-label={`Search query for ${row.folder}`}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={commitQuery}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setQuery(row.query);
            }}
            className="h-7 text-xs"
          />
        )}
        {!linked && row.pinnedUrl ? (
          <span className="flex min-w-0 items-center gap-1 text-[11.5px]">
            <Pin className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate font-mono" title={row.pinnedUrl}>
              {row.pinnedUrl}
            </span>
            <button type="button" className="shrink-0 text-muted-foreground underline-offset-2 hover:underline" disabled={busy} onClick={() => onPatch({ pinnedUrl: null })}>
              Unpin
            </button>
          </span>
        ) : !linked && row.candidates.length > 0 ? (
          <Picker row={row} busy={busy} onPatch={onPatch} />
        ) : (
          <RowState row={row} />
        )}
        {!linked && pinOpen && (
          <div className="flex items-center gap-1.5">
            <Input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="https://…" aria-label={`URL for ${row.folder}`} className="h-7 font-mono text-xs" />
            <Button
              size="sm"
              variant="outline"
              className={XS}
              disabled={busy || !/^https?:\/\/\S+$/i.test(pin.trim())}
              onClick={() => {
                onPatch({ pinnedUrl: pin.trim() });
                setPinOpen(false);
              }}
            >
              Pin
            </Button>
            <Button size="sm" variant="ghost" className={XS} onClick={() => setPinOpen(false)} aria-label="Close">
              <X aria-hidden="true" />
            </Button>
          </div>
        )}
        {result && <span className={cn("text-[11.5px]", result.ok ? "text-success" : "text-destructive")}>{result.text}</span>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {linked ? (
          <Button size="sm" variant="ghost" className={XS} disabled={busy} onClick={onUnlink}>
            Unlink
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" className={XS} disabled={busy} onClick={() => onPatch({ skip: !row.skip })}>
              {row.skip ? "Include" : "Skip"}
            </Button>
            {!row.pinnedUrl && !pinOpen && (
              <Button size="sm" variant="ghost" className={XS} disabled={busy} onClick={() => setPinOpen(true)}>
                <Pin aria-hidden="true" />
                Pin URL
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** What the batch searches with, from the saved settings (absent = the defaults). */
function searchLine(s) {
  const o = s || {};
  const sites = o.seededOnly === false ? "all sites" : "curated sites only";
  const collapse = o.collapseSplits === true ? "split chapters collapsed" : "split chapters kept";
  // multiSource: the toggle new searches run with; each found row queues with
  // the value ITS search ran with (findView.rowQueueArgs).
  const fallback = o.multiSource === true ? "fallback sites on" : "fallback sites off";
  return `Your search settings: ${sites} · ${collapse} · ${fallback}`;
}

/**
 * @param {object} p
 * @param {boolean} p.open
 * @param {object} p.target      the config target (name, profile, aliases)
 * @param {Array} p.items        summary.deviceOnly (with `query`, U4-1)
 * @param {{seededOnly?:boolean, collapseSplits?:boolean, multiSource?:boolean}} [p.searchSettings]  the SAVED
 *   search settings, shown only: the search itself runs with them in main
 *   (find-sources.js _searchOptions), with no per-run override
 * @param {() => void} [p.onOpenSearchSettings]  App: Settings → Search
 * @param {(url:string, args:object) => any} p.onQueueDownload  App: dl.queueDownload with the download defaults
 */
export default function FindSourcesSheet({ open, onClose, target, tn, items, wide, contained, sync, ops, searchSettings, onOpenSearchSettings, onQueueDownload }) {
  const tid = target ? target.id : null;
  const [covers, setCovers] = useState({});
  const [results, setResults] = useState({});
  const [busyRows, setBusyRows] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [refusal, setRefusal] = useState(null);

  useEffect(() => {
    if (!open || !tid) return;
    setResults({});
    setRefusal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tid]);
  // Covers are per target (folder names repeat across targets).
  useEffect(() => setCovers({}), [tid]);

  // Rows: re-read (and so reconciled, service.js find-sources:get) on open
  // and whenever the device-only folders change under the open sheet.
  const names = (items || []).map((d) => d.name).join("\0");
  useEffect(() => {
    if (open && tid) sync.actions.findSourcesGet({ targetId: tid });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tid, names]);

  // Device covers, one at a time (an adb target reads each over the cable;
  // main caches them under userData/sync, so a reopen is instant).
  const coversRef = useRef(covers);
  coversRef.current = covers;
  useEffect(() => {
    if (!open || !tid) return undefined;
    let alive = true;
    (async () => {
      for (const name of names ? names.split("\0") : []) {
        if (!alive) return;
        if (name in coversRef.current) continue;
        let p = null;
        try {
          const r = await sync.actions.deviceCover({ targetId: tid, folder: name });
          p = r && r.ok ? r.path || null : null;
        } catch (_) {
          p = null;
        }
        if (alive) setCovers((c) => ({ ...c, [name]: p }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tid, names]);

  const rows = useMemo(() => findRows(items, sync.findRows && sync.findRows[tid], target), [items, sync.findRows, tid, target]);
  const find = sync.find;
  const running = !!find;
  const runningHere = running && find.targetId === tid;
  const toSearch = searchable(rows);
  const queueable = rows.filter((r) => r.queueable);
  const nCheck = rows.filter((r) => r.needsCheck).length;
  const status = findStatusLine(find, tid, rows);
  const komikku = target && target.profile === "komikku";

  const patch = async (row, p) => {
    setBusyRows(true);
    const r = await sync.actions.findSourcesUpdateRow({ targetId: tid, folder: row.folder, patch: p });
    setBusyRows(false);
    if (r && r.ok === false) setResults((x) => ({ ...x, [row.folder]: { ok: false, text: r.message || "That change wasn't saved." } }));
  };
  const startSearch = async () => {
    setRefusal(null);
    const r = await sync.actions.findSourcesStart({ targetId: tid, folders: toSearch.map((x) => x.folder) });
    if (r && r.ok === false) setRefusal(r);
  };

  const unlink = async (row) => {
    const entry = aliasFor(target, row.folder);
    if (!entry) return;
    const r = await ops.run("remove-alias", { targetId: tid, entry });
    setResults((x) => ({ ...x, [row.folder]: r && r.ok === false ? { ok: false, text: configRefusalCopy(r, tn) } : null }));
  };

  const queue = async () => {
    setQueueing(true);
    for (const row of queueable) {
      const a = await ops.run("add-alias", { targetId: tid, alias: { url: row.url, deviceFolder: row.folder } });
      if (!a || a.ok === false) {
        setResults((x) => ({ ...x, [row.folder]: { ok: false, text: `Not queued: ${configRefusalCopy(a, tn)}` } }));
        continue;
      }
      try {
        // rowQueueArgs = the Search tab's multi-source + fallback-sites rules;
        // findQueueArgs (komikku) last, as before.
        await onQueueDownload(row.url, { ...rowQueueArgs(row), ...findQueueArgs(target) });
        setResults((x) => ({ ...x, [row.folder]: { ok: true, text: "Queued. It syncs into this folder once it's downloaded." } }));
      } catch (e) {
        setResults((x) => ({ ...x, [row.folder]: { ok: false, text: `Linked, but the download didn't queue: ${(e && e.message) || e}` } }));
      }
    }
    setQueueing(false);
  };

  const nQueue = queueable.length;
  const busy = busyRows || queueing;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={wide ? 680 : 600}
      contained={contained}
      title={`Find sources for ${rows.length} folder${rows.length === 1 ? "" : "s"}`}
      description={`Searches each folder's name on ${tn}. Edit a query or pin a URL, then queue.${status ? ` ${status}` : ""}`}
      bodyClassName="p-0"
      footer={
        <>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {nCheck > 0 && <span className="text-warn-fg">{nCheck} to check, not queued · </span>}
            Komikku mode follows {tn} ({komikku ? "on" : "off"}) · each queued series is linked to its folder first
          </span>
          <Button size="sm" disabled={!nQueue || busy || runningHere} onClick={queue} className="gap-1.5 [&_svg]:h-3.5 [&_svg]:w-3.5">
            {queueing ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download aria-hidden="true" />}
            {nQueue ? `Queue ${nQueue} download${nQueue === 1 ? "" : "s"}` : "Queue downloads"}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">
          {searchLine(searchSettings)}
        </span>
        {onOpenSearchSettings && (
          <Button size="sm" variant="ghost" className={XS} onClick={onOpenSearchSettings}>
            <Settings2 aria-hidden="true" />
            Search settings
          </Button>
        )}
        {runningHere ? (
          <Button size="sm" variant="outline" className={XS} onClick={() => sync.actions.findSourcesCancel({})}>
            <X aria-hidden="true" />
            Stop searching
          </Button>
        ) : (
          <Button size="sm" variant="outline" className={XS} disabled={!toSearch.length || running || busy} onClick={startSearch} title={running ? "Another target's search is running" : undefined}>
            <Search aria-hidden="true" />
            {toSearch.length ? `Search ${toSearch.length} folder${toSearch.length === 1 ? "" : "s"}` : "Search"}
          </Button>
        )}
      </div>
      {refusal && <div className="border-b px-4 py-2 text-xs text-destructive">{refusal.message || "The search didn't start."}</div>}
      {!rows.length ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">No folders are only on {tn}.</div>
      ) : (
        rows.map((row) => (
          <FindRow
            key={row.key}
            row={row}
            cover={covers[row.folder] || null}
            busy={busy || (runningHere && row.state === "searching")}
            result={results[row.folder]}
            onPatch={(p) => patch(row, p)}
            onUnlink={() => unlink(row)}
          />
        ))
      )}
    </Sheet>
  );
}
