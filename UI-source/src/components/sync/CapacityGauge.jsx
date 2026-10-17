// ============================================================
// CapacityGauge — a target's storage, and what the selection would take
//
// Input is the summary's `capacity` (service.js _capacity): {free, total,
// needed, reserve, freeable, freeableEarly, after, fits, asOf}. `after` is
// main's free-after-sync (free − needed + freeable); `total` comes from the
// transport's storage() and is null when the target can't report it. Without
// a total the bar is drawn against free space alone: the "used" part is
// unknown, so the bar shows the after-sync ghost and the reserve as shares
// of what is free.
//
// Spec §4: 8 px pill on --muted; used --foreground/.45; the after-sync ghost
// a primary hatch; the reserve a destructive hatch at the right end. Labels
// below in mono. `free == null` (free space unreadable) renders a muted line
// instead of a bar, never a made-up number.
//
// Consumer: TargetBar.jsx. Depends on lib/utils formatBytes.
// ============================================================

import React from "react";
import { cn, formatBytes } from "@/lib/utils";

export default function CapacityGauge({ capacity, targetName, className }) {
  const c = capacity || {};
  if (c.free == null) {
    return <div className={cn("text-[11px] text-muted-foreground", className)}>Free space on {targetName || "the target"} unknown</div>;
  }
  const net = Math.max(0, (c.needed || 0) - (c.freeable || 0));
  const total = c.total && c.total > 0 ? c.total : c.free;
  const used = c.total ? Math.max(0, c.total - c.free) : 0;
  const pct = (x) => `${Math.max(0, Math.min(100, (x / total) * 100))}%`;
  const after = typeof c.after === "number" ? c.after : c.free - net;
  const short = c.fits === false;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div
        role="img"
        aria-label={`${formatBytes(c.free)} free, ${formatBytes(net)} needed`}
        className="flex h-2 overflow-hidden rounded-full bg-muted shadow-[inset_0_0_0_1px_hsl(var(--border))]"
      >
        {used > 0 && <span className="bg-foreground/45" style={{ width: pct(used) }} />}
        {net > 0 && <span className="sync-gauge-ghost" style={{ width: pct(Math.min(net, c.free)) }} />}
        {c.reserve > 0 && <span className="sync-gauge-reserve ml-auto" style={{ width: pct(Math.min(c.reserve, total)) }} />}
      </div>
      <div className="flex gap-2.5 font-mono text-[11px] tabular-nums text-muted-foreground">
        {used > 0 && <span>{formatBytes(used)} used</span>}
        <span>{formatBytes(c.free)} free</span>
        <span className="flex-1" />
        <span className={cn(short && "text-destructive")}>
          after sync <b className={cn("font-semibold", short ? "text-destructive" : "text-foreground")}>{formatBytes(Math.max(0, after))}</b> free
        </span>
      </div>
    </div>
  );
}
