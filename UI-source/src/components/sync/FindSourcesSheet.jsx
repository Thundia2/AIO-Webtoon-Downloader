// ============================================================
// FindSourcesSheet — "Find sources for N folders" (UI pass U4; spec §4
// surfaces: right sheet, 600 / 680 px; mockup findSourcesTable())
//
// For a target's device-only folders: search each folder's name, let the
// user pick a candidate or pin a URL per row, then "Queue N downloads".
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
// Consumer: SyncTab.jsx. Depends on: findView.js, useConfigOps (ops),
// copy.js configRefusalCopy.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Link2, Loader2, Pin, Search, Settings2, X } from "lucide-react";
import { Button, Checkbox, Input } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import { Cover } from "./Ledger";
import { configRefusalCopy } from "./copy";
import { aliasFor, candidateScore, findQueueArgs, findRows, findStatusLine, searchable, unmeasured } from "./findView";

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
  const c = row.pick != null ? row.candidates[row.pick] : null;
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
          <div className="flex min-w-0 items-center gap-2">
            <select
              value={row.pick == null ? "" : String(row.pick)}
              disabled={busy}
              aria-label={`Source for ${row.folder}`}
              onChange={(e) => onPatch({ pick: Number(e.target.value) })}
              className="h-7 min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 text-xs"
            >
              {row.candidates.map((cand, i) => (
                <option key={i} value={i}>
                  {(cand.title || (cand.best && cand.best.title) || "Untitled") + (cand.best ? ` · ${cand.best.site}` : "")}
                </option>
              ))}
            </select>
            {c && (
              <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground" title={unmeasured(c) ? "Rating not measured from chapter pages" : undefined}>
                {candidateScore(c)}
                {unmeasured(c) && <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden="true" />}
              </span>
            )}
          </div>
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
  return `Your search settings: ${sites} · ${collapse}`;
}

/**
 * @param {object} p
 * @param {boolean} p.open
 * @param {object} p.target      the config target (name, profile, aliases)
 * @param {Array} p.items        summary.deviceOnly (with `query`, U4-1)
 * @param {{seededOnly?:boolean, collapseSplits?:boolean}} [p.searchSettings]  the SAVED
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
        await onQueueDownload(row.url, findQueueArgs(target));
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
