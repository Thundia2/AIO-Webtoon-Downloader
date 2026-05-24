// ============================================================
// SEARCH CHAPTER MAP
//
// Visualizes winner_chapter_map (only present when --multi-source
// is on). Shows a thin grid: chapter numbers across X, sources
// down Y. Cells colored by status:
//   gold    = is_official (licensed publisher)
//   primary = available
//   muted   = absent
//
// Lets the user spot DMCA gaps + licensed-translation coverage
// at a glance. Power feature — collapsed by default in SearchTab.
// ============================================================

import React, { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Info } from "lucide-react";

export default function SearchChapterMap({ chapterMap }) {
  const [expanded, setExpanded] = useState(false);

  // Pre-compute the matrix: site -> Set<chapter_num>, plus per-chapter
  // is_official site mapping. This walks the JSON once on mount; cheap
  // for series with <2000 chapters (One Piece is the worst case at ~1250).
  const { sites, chapterNums, presence, officialAt, totalAligned } = useMemo(() => {
    if (!chapterMap?.chapters) {
      return { sites: [], chapterNums: [], presence: {}, officialAt: {}, totalAligned: 0 };
    }
    const siteSet = new Set();
    const presence = {};   // site -> Set<chapter_num>
    const officialAt = {}; // site -> Set<chapter_num where is_official=true>
    const numSet = new Set();
    for (const entry of chapterMap.chapters) {
      numSet.add(entry.chapter_num);
      for (const s of entry.sources || []) {
        siteSet.add(s.site);
        if (!presence[s.site]) presence[s.site] = new Set();
        presence[s.site].add(entry.chapter_num);
        if (s.is_official) {
          if (!officialAt[s.site]) officialAt[s.site] = new Set();
          officialAt[s.site].add(entry.chapter_num);
        }
      }
    }
    return {
      sites: [...siteSet].sort(),
      chapterNums: [...numSet].sort((a, b) => a - b),
      presence,
      officialAt,
      totalAligned: chapterMap.total_chapters_aligned || chapterMap.chapters.length,
    };
  }, [chapterMap]);

  if (!chapterMap || sites.length === 0) return null;

  // Phase 3: Aggregate "main chapters" count surfaced when collapse is on
  // AND the count differs from raw aligned entries — visually flags the
  // inflation. Backend computes this at chapter_map build time via
  // _classify_main_chapters; we just read the field. Falls back to
  // totalAligned when the field is absent (older payloads / collapse off
  // / no inflation detected).
  const collapseApplied = !!chapterMap.collapse_splits_applied;
  const effectiveAligned = chapterMap.effective_chapters_aligned ?? totalAligned;
  const hasInflation = effectiveAligned !== totalAligned;

  // Per-site stats for the row label. Helps the user see which source has
  // the deepest catalog at a glance without expanding. Phase 3 enriches
  // this with effective_chapters from merge_diagnostics so MangaFire-style
  // 362-vs-119 inflation is visible without reading the heatmap.
  const siteStats = sites.map((site) => {
    const ch = presence[site]?.size || 0;
    const off = officialAt[site]?.size || 0;
    const diag = chapterMap.merge_diagnostics?.[site] || {};
    const totalChapters = diag.total_chapters ?? ch;
    const effective = diag.effective_chapters ?? totalChapters;
    const compatibility = diag.compatibility;
    return { site, ch, totalChapters, effective, off, compatibility };
  });

  return (
    <div className="rounded-lg border bg-card/50 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex items-center justify-between w-full px-4 py-2.5 text-left",
          "hover:bg-accent/30 transition-colors",
        )}
      >
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            Chapter coverage across {sites.length} sources
          </span>
          {hasInflation ? (
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title={
                collapseApplied
                  ? "Aggregator catalogs include split-chapter rows (e.g. 1.1, 1.2). Main count collapses those; entries shows the raw row count."
                  : "Series uses decimal numbering — collapse is off, so main and entries diverge naturally."
              }
            >
              · {effectiveAligned} main / {totalAligned} entries
            </span>
          ) : (
            <span className="text-xs text-muted-foreground tabular-nums">
              · {totalAligned} chapters aligned
            </span>
          )}
        </div>
        <ChevronDown
          className={cn("w-4 h-4 transition-transform", expanded && "rotate-180")}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t bg-background/50 animate-slide-up">
          {/* Per-site summary row.
              When the source has split-chapter inflation (effective < totalChapters
              under collapse, OR raw entries > effective in any case), show
              "X main / Y entries"; otherwise just "X chapters". The "main"
              count is what the user should compare across sources for parity. */}
          <div className="grid gap-1.5 mb-3" style={{ gridTemplateColumns: "120px 1fr" }}>
            {siteStats.map(({ site, ch, totalChapters, effective, off, compatibility }) => {
              const showInflation = effective !== totalChapters;
              return (
                <React.Fragment key={site}>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-[11px] truncate">{site}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] tabular-nums">
                    {showInflation ? (
                      <span
                        className="text-muted-foreground"
                        title={`Source returned ${totalChapters} entries; collapsed to ${effective} main chapters for parity with other sources.`}
                      >
                        <span className="text-foreground">{effective}</span>
                        <span className="text-muted-foreground"> main / {totalChapters} entries</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {ch}/{totalAligned} chapters
                      </span>
                    )}
                    {off > 0 && (
                      <span className="text-yellow-600 dark:text-yellow-400">
                        · {off} licensed
                      </span>
                    )}
                    {compatibility != null && compatibility < 1 && (
                      <span className="text-muted-foreground">
                        · {Math.round(compatibility * 100)}% match
                      </span>
                    )}
                  </div>
                </React.Fragment>
              );
            })}
          </div>

          {/* Heatmap grid — site rows × chapter columns. Each cell ~6px
              wide so a 1200-chapter series fits in ~7000px (horizontal
              scroll in a contained div). For typical 100-300 chapter
              series, fits the viewport easily. */}
          <div className="rounded border bg-background overflow-x-auto">
            <table className="text-[9px] tabular-nums">
              <thead>
                <tr className="border-b">
                  <th className="sticky left-0 z-10 bg-background px-2 py-1 text-left font-mono text-muted-foreground">
                    site
                  </th>
                  {chapterNums.map((n) => (
                    <th key={n} className="px-0 py-0 w-[6px] font-normal text-muted-foreground" />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site} className="border-b border-border/40 last:border-0">
                    <td className="sticky left-0 z-10 bg-background px-2 py-1.5 font-mono text-foreground">
                      {site}
                    </td>
                    {chapterNums.map((n) => {
                      const has = presence[site]?.has(n);
                      const isOfficial = officialAt[site]?.has(n);
                      const cell = isOfficial
                        ? "bg-yellow-500"
                        : has
                          ? "bg-primary/60"
                          : "bg-muted/30";
                      return (
                        <td
                          key={n}
                          className={cn("h-3 w-[6px]", cell)}
                          title={
                            `${site} · Ch ${n}` +
                            (isOfficial ? " · official" : has ? " · available" : " · missing")
                          }
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 mt-3 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-yellow-500" />
              <span>Licensed (official translation)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-primary/60" />
              <span>Available</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-muted/30 border border-border" />
              <span>Missing</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
