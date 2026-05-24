// This is the standard shadcn/ui utility for merging CSS class names.
// clsx handles conditional classes, tailwind-merge resolves conflicts
// (e.g. if you pass both "p-2" and "p-4", it keeps only "p-4").

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// Render a millisecond duration as "Ns" (under 60s) or "Mm Ss" (>= 60s).
// Returns "" when ms is falsy so callers can safely conditional-render.
// Used by QueueTab's per-row duration label and useDownloader's log divider
// entry that punctuates each completed run.
export function formatDuration(ms) {
  if (!ms) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}
