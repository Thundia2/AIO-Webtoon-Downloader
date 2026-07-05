import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Button, Input, Label, Select, Checkbox, Card, SectionHeader, Slider, Badge, Switch,
} from "@/components/ui/primitives";
import {
  Save, RotateCcw, FolderOpen, FileText, Package, Terminal, RefreshCw,
  Check, AlertTriangle, Gauge, Cpu, Network, Lock,
  // Category-nav icons (2026-07-05 two-pane redesign) — one per CATEGORIES group.
  Settings, Image as ImageIcon, Tags, Search, Library,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LANGUAGES } from "@/lib/constants";
// Resource Limits (Max network / Max CPU usage) — presets + display helpers.
// KEEP IN SYNC: the canonical copy that drives the actual spawn is
// electron/resource-limits.js (resolved in main.js). This mirror is display-only.
import {
  NETWORK_LEVELS, CPU_LEVELS, isNetworkManaged, networkEffective,
  networkPreviewText, cpuPreviewText, levelLabel,
} from "@/lib/resourceLimits";

// Default values for settings.searchOpts. Mirrors DEFAULT_OPTS in
// SearchTab.jsx. Both surfaces (Settings + Search) read/write this
// namespace so changing in one is reflected in the other.
//
// `collapseSplits` was here historically (Phase 3) but moved to the top-level
// settings.collapseSplits in 2026-05-08 because the same toggle now affects
// download behavior, not just search-display diagnostics. See section 8 of
// snappy-forging-waffle.md.
const DEFAULT_SEARCH_OPTS = {
  searchLanguage: "en",
  seededOnly: true,
  multiSource: false,
  multiSourceQualityMin: 0.65,
  searchTimeout: 20,
  searchMinMatch: 0.55,
  searchParallelism: 6,
  // Mirror of SearchTab.jsx DEFAULT_OPTS.enableMlRating. The UI control is
  // in SearchTab's "Advanced search options" Collapsible (not surfaced here)
  // so the shared settings.searchOpts namespace stays schema-aligned across
  // both surfaces. See SearchTab.jsx for the WMI-hang rationale.
  enableMlRating: false,
};

// ── IntInput ──
// Controlled integer <Input> that folds the identical parse+truncate+clamp
// dance the Image-Prefetch/Concurrency number fields used to hand-roll inline.
// Calls `onChange(intValue)` with a coerced integer — never a raw string, so
// the Python argparse `type=int` flags can't crash on a decimal.
//
// Coercion contract (must stay byte-identical to the four migrated fields —
// prefetchImageWorkers, imageConcurrency, imagePrefetchDepth,
// imagePrefetchParallel):
//   - empty string or non-finite (e.g. the user cleared it, or typed "-") →
//     `fallback`.
//   - else truncate toward zero.
//   - below `min`: `clampLow` true → clamp UP to `min` (prefetchImageWorkers /
//     imageConcurrency); false → `fallback` (imagePrefetchDepth /
//     imagePrefetchParallel, which reset to their default when the user types
//     a below-range value).
//   - above `max` → clamp DOWN to `max` (all four).
// This deliberately does NOT cover the Default-Network trio or the search
// fields — those have different empty/rounding semantics (see their inline
// handlers) and would change behavior if forced through here.
function IntInput({ value, onChange, min, max, fallback, clampLow = true, ...props }) {
  const coerce = (raw) => {
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) return fallback;
    let v = Math.trunc(n);
    // Below-min test uses the PRE-truncation `n`: the migrated fields guarded
    // the parsed value (e.g. `v < 0`) BEFORE truncating, so a typed "-0.5" must
    // reset — trunc(-0.5) === 0 would otherwise slip past a `v < min` check on
    // the min=0 field (imagePrefetchDepth) and read as "disable" instead.
    if (min != null && n < min) return clampLow ? min : fallback;
    if (max != null && v > max) return max;
    return v;
  };
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={1}
      value={value}
      onChange={(e) => onChange(coerce(e.target.value))}
      {...props}
    />
  );
}

// ── Resource-limit "managed" affordances ──
// When a Max-network preset is active it HARD-OVERRIDES the five download/search
// concurrency inputs: they render disabled and show their effective (running)
// value while the stored manual value is preserved. ManagedLock marks such an
// input inline; ManagedBanner explains it once at the top of the all-overridden
// "Image Prefetch & Concurrency" section. Amber = "governed elsewhere, heads up"
// (the app's existing advisory accent). See lib/resourceLimits.js + the resolver
// that actually enforces this at spawn time in electron/resource-limits.js.
function ManagedLock() {
  return (
    <Lock
      className="w-2.5 h-2.5 text-amber-600 dark:text-amber-400 shrink-0"
      aria-label="Managed by a resource limit"
    />
  );
}

function ManagedBanner({ level }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
      <Lock className="w-3 h-3 shrink-0" />
      <span>
        Managed by <strong>Max network usage: {levelLabel(level)}</strong> — set it to{" "}
        <span className="font-mono">Unlimited</span> in <strong>Resource Limits</strong>{" "}
        above to edit these by hand.
      </span>
    </div>
  );
}

// ── DEFAULT VALUES ──
// Empty placeholders shown only during the brief window before main.js's
// get-settings IPC resolves. The real per-machine defaults come from
// main.js (DEV_SCRIPT_PATH / DEV_WORKING_DIR derived from __dirname in dev,
// or app.getPath("documents")/AIO Downloader in packaged). Used to bake an
// absolute path to the original developer's OneDrive folder here, which
// mkdirSync would silently re-create on any other machine — better to show
// blank for ~50ms than mislead the user with a stranger's home path.
//
// On Reset (handleReset below), dev-mode reverts to these blanks so the
// user can re-pick their workingDir; packaged-mode preserves the existing
// value via the prev.isPackaged guard.
// All three path fields START EMPTY. The empty string is the user's
// "no override — use the runtime-resolved default" sentinel. Every
// consumer (main.js spawn sites) does `settings.X || defaultX`, so
// empty falls through to the runtime default cleanly.
//
// This is part of the 2026-05-13 round-trip fix: AppImage / macOS
// Gatekeeper App Translocation / DMG-direct runs all produce volatile
// auto-computed paths that change between launches. If we initialized
// these to non-empty values (or hydrated them from settings.json with
// the old computed defaults baked in), Save would persist the volatile
// path back to disk and the next launch would ENOENT. Keeping initial
// state empty + filtering the hydration spread + reading resolved
// paths separately via getResolvedPaths() ensures the saved settings
// dict only carries user-typed overrides.
const DEV_DEFAULTS = {
  pythonCmd: "",
  scriptPath: "",
  workingDir: "",
};

// ── DEFAULT_SETTINGS ──
// Single source of truth for the initial `local` settings draft AND the Reset
// button's target. Previously the same ~90 fields were spelled out twice (the
// useState initializer + handleReset), which drifted easily. Both consume this
// via structuredClone(DEFAULT_SETTINGS) so neither mutates the shared const's
// nested objects. Reset overrides only `isPackaged` (kept from prev, since
// main.js owns it) — see handleReset.
//
// This IS the UI architectural triad's owner of the download defaults
// (electron/main.js and useDownloader.js carry NO defaults dict). Keep it here.
//
// The comments below are the field-level rationale that used to live inline in
// the useState initializer — preserved because they're load-bearing for the
// next reader (quality=100 fast-path, collapseSplits opt-in, etc.).
const DEFAULT_SETTINGS = {
  pythonCmd: DEV_DEFAULTS.pythonCmd,
  scriptPath: DEV_DEFAULTS.scriptPath,
  workingDir: DEV_DEFAULTS.workingDir,
  verboseAlways: true,
  // Global chapter-collapse toggle. Affects:
  //   - Search-display "X main / Y entries" diagnostic counts.
  //   - Actual download behavior — split clusters (e.g. 1.1/1.2/1.3/1.4)
  //     merge into one combined chapter file; redundant duplicate uploads
  //     of the same chapter are pruned. See sites/chapter_merger.py
  //     :group_chapters_for_download for the full 6-rule cluster table.
  // Persisted as settings.collapseSplits; useDownloader.queueDownload and
  // .runSearch inject this into args/opts before IPC.
  // Default OFF (opt-in, documented 2026-05-27) to MATCH the spawn sites,
  // which all read `settings.collapseSplits === true` (absent → OFF): with a
  // `true` default here the toggle showed ON while downloads ran OFF until the
  // first save, and saving then silently flipped collapse ON against the
  // documented default. Residual follow-up.
  collapseSplits: false,
  // Inter-chapter image prefetch worker count (Phase G7, 2026-05-08).
  // While chapter N is encoding (CPU-bound), a background thread
  // downloads chapter N+1's images. -1 = match Image Workers (default).
  // 0 = disable prefetch entirely. Positive N = use exactly N workers.
  // Drop to 4 (or 0) when the upstream CDN is throttling and the extra
  // concurrent burst from N+1's downloads compounds throttling.
  prefetchImageWorkers: -1,
  // ── Image prefetch & concurrency (generalized 2026-05-13) ──
  // Apply to any handler with SUPPORTS_FAST_DOWNLOAD=True (currently
  // mangafire and linewebtoon; see sites/base.py:fast_download_images
  // for the implementation).
  //   - imageConcurrency: asyncio.Semaphore bound for image fetches via
  //     curl_cffi async + HTTP/2 multiplex. 8 hits ~5 MB/s (near network
  //     ceiling on home links). Auto-dials down per-host on CDN errors.
  //   - imagePrefetchDepth: how many chapters ahead to keep queued for
  //     image prefetch. Higher helps when main-loop processing is fast
  //     relative to network download (CBZ fast-path, LINE Webtoon).
  //   - imagePrefetchParallel: concurrent prefetch worker threads. =2
  //     means up to 2 chapters in flight while main processes a third.
  //   - noFastDownload: escape hatch — force-disable curl_cffi path.
  // queueDownload (useDownloader.js) injects each into args only when
  // not at default. Pre-2026-05-13 setting `mangafireImageConcurrency`
  // is migrated to `imageConcurrency` at settings-load time below.
  imageConcurrency: 8,
  imagePrefetchDepth: 2,
  imagePrefetchParallel: 2,
  noFastDownload: false,
  // ── Resource Limits (Max network / Max CPU usage) ──
  // Discrete presets: "unlimited" (default no-op) | "high" | "balanced" | "low".
  // HARD OVERRIDE: an active networkLimit REPLACES the image-concurrency family
  // + search-parallelism; cpuLimit → --max-cpu-percent. Resolved at spawn in
  // main.js (electron/resource-limits.js), NOT here. "unlimited" leaves the
  // manual knobs above / search Parallel-sites untouched. Absent → "unlimited"
  // via the `?? "unlimited"` reads at the Selects, so old settings dicts are safe.
  networkLimit: "unlimited",
  cpuLimit: "unlimited",
  // ── MangaFire VRF capture knobs intentionally NOT surfaced in UI ──
  // VRF is MangaFire-specific browser-automation tuning that users
  // shouldn't need to touch. The CLI flags
  // --mangafire-vrf-prefetch-depth (default 4) and
  // --mangafire-vrf-parallel (default 1) still exist for advanced
  // tuning; the UI just inherits the argparse defaults.
  // How often the UI refreshes logs & progress (in milliseconds).
  // Lower = more responsive. Default: 100ms (10 updates/sec).
  logUpdateInterval: 100,
  // When true, update checks scan actual files on disk instead of
  // trusting .aio_series.json. Saved as a top-level setting.
  useFileBasedChapterCheck: false,
  // ── Library Check All filter ──
  // When true (default), "Check All" includes series marked Completed /
  // Finished, not just Ongoing / Releasing. Many aggregators — mangafire
  // most notoriously — slap "Completed" on actively-updating series, so
  // skipping them by default would silently leave the user months behind
  // on a chunk of their library. The cost of an extra check on a truly
  // completed series is ~one Python proc (handled by the parallel pool
  // in <1 ms of wall-time per slot saturation), vs. the cost of missing
  // weeks of releases by trusting the bad metadata. Cross-file: the
  // filter lives in UI-source/electron/main.js:check-all-updates handler;
  // LibraryTab.jsx mirrors the filter for the toolbar's ongoingCount.
  checkAllIncludeCompleted: true,
  // Parallel "Check All" worker count. Clamped to [1, 8] by main.js. 4 is
  // the safe sweet spot — finishes 30 series in 30-60s while keeping any
  // single site from getting hit with 4+ concurrent --list-chapters calls
  // (the provider-aware scheduler in main.js further fans across distinct
  // sites when possible).
  checkAllConcurrency: 4,
  // When ON (default), downloads queued from the UpdatesCenter panel get
  // --seeded-rating-only injected so the multi-source rating skips its
  // image-quality probe phase and ranks alternatives from
  // sites/quality_seed.json's per-site priors instead. Saves 30-60+ s
  // per series on MangaFire-class handlers (the probe runs Playwright
  // VRF per sample chapter plus image-quality scoring). For a 1-5
  // chapter update delta, the probe cost dwarfs the actual download.
  // Off restores full probe accuracy at the per-download cost — pick
  // off only if you've tuned multi-source ranking carefully and want
  // every download to use measured scores. Read in LibraryTab.jsx's
  // buildDownloadArgsForRow; flag plumbed via downloader.js's
  // seededRatingOnly boolMap entry; honored in aio_search_cli.
  // find_alternatives_for_direct_url.
  updateChecksUseSeededRating: true,
  // ── External metadata enrichment (--metadata-source family) ──
  // Top-level "global setting" semantic: applies to EVERY download
  // regardless of which tab spawned it (New / Search / Library / queue).
  // useDownloader.queueDownload injects these into args for every
  // electronAPI.startDownload, so it's a true app-wide preference rather
  // than a per-download form value. Defaults match the Python argparse
  // defaults so a Save with the section untouched is a no-op for the
  // spawn line. Python side: aio-dl.py near --enable-ml-rating (flag
  // registration) + sites/external_metadata.py (the AniList GraphQL
  // client). Grep cross-file: metadataSource, metadata-source.
  metadataSource: "none",
  metadataTagMinRank: 50,
  metadataRefresh: false,
  // Whether the app is running from an installed .exe (bundled mode)
  // or from source (dev mode). Set by main.js, read-only here. Reset
  // preserves prev.isPackaged rather than this false (see handleReset).
  isPackaged: false,
  defaults: {
    format: "pdf",
    // Global download language. DownloadTab.jsx:32 had its own per-form
    // default of "en"; surfacing it here lets the user pick a different
    // global default (e.g. "ja" for a Japanese-only library) without
    // changing the dropdown on every download. DownloadTab's useEffect
    // at line ~95-99 already spreads settings.defaults onto its form,
    // so this propagates through automatically. Library-tab downloads
    // override with the per-series saved language; Search-tab downloads
    // inherit via App.jsx's defaults-spread.
    language: "en",
    // 100 (not aio-dl.py's argparse default of 85): Phase G4 in aio-dl.py
    // (~line 4272) sets _user_set_quality = (--quality on argv) AND
    // (args.quality < 100). When True, the CBZ byte-preserving fast-path
    // (cbzPreserveOriginals) is bypassed in favor of decode/re-encode.
    // The UI always emits --quality from form state, so a default of 85
    // would force every default CBZ download into the slow legacy path
    // — defeating the cbzPreserveOriginals toggle for everyone except
    // users who manually slide the quality up to 100. The Python
    // argparse default of 85 still applies to direct CLI users; the
    // UI's separate default is intentional. Keep this at 100 unless
    // you also revisit the Phase G4 guard.
    quality: 100,
    scaling: 100,
    keepChapters: false,
    noFinalFile: false,
    keepImages: false,
    noProcessing: false,
    noCleanup: false,
    imageWorkers: 3,
    httpTimeout: 30,
    httpMaxRetries: 6,
    jobs: 1,
    // Multi-source fallback default (added 2026-05-07). DownloadTab's
    // useEffect spreads settings.defaults into its form on mount, so
    // setting these here makes them survive both tab switches and
    // session restarts. Per-job overrides in DownloadTab don't save back.
    multiSource: false,
    multiSourceQualityMin: 0.65,
    // Lazy-discovery modifier for multi-source (2026-07-02): defer the
    // ~30-80 s cross-site alternatives discovery until a chapter actually
    // fails, instead of running it before the first chapter. Opt-OUT
    // nested inside the multi-source opt-in: the multiSource toggle's
    // handler force-resets this to true on every enable, and every
    // consumer treats ABSENT as on (`!== false`) so settings dicts saved
    // before this field existed stay lazy. Only an explicit false (user
    // unticked the nested toggle) reverts to eager discovery.
    // downloader.js emits --multi-source-lazy from a dedicated
    // chokepoint (grep multiSourceLazy there — NOT in boolMap, because
    // boolMap's `=== true` test would break absent-means-on); Python
    // side: aio-dl.py --multi-source-lazy + _ms_lazy_pending.
    multiSourceLazy: true,
    // CBZ byte-preservation default (added 2026-05-07). When ON (default),
    // CBZ output uses the original wire bytes from the CDN (lossless,
    // fastest, smallest archives). Setting this to false emits
    // --no-cbz-preserve-originals which forces decode/re-encode even at
    // --scaling 100. The downloader.js boolMap handles the negative-form
    // flag emission. Only meaningful for --format cbz.
    cbzPreserveOriginals: true,
    // Komikku-compatible per-chapter CBZ output (2026-05-12, Komikku LocalSource format).
    // When ON, Python auto-coerces --format cbz --keep-chapters
    // --no-final-file and writes per-chapter ComicInfo.xml + cover.jpg
    // + details.json at <out>/manga/<Series>/. The format selector
    // above is effectively ignored when this is on (Python prints a
    // [Komikku] coercion notice in the log). DownloadTab's DEFAULT_FORM
    // spread picks this up via the useEffect at line ~120-124; App.jsx's
    // search/library wrappers spread it into queueDownload args.
    komikku: false,
    // LINE Webtoon WebP recompression defaults (Phase 1, 2026-05-11).
    // When enabled here, BOTH the New tab AND search/library-initiated
    // downloads inherit these knobs: the New tab's DEFAULT_FORM spread
    // (DownloadTab.jsx:~110) and App.jsx's settings.defaults spread for
    // the search/library onStartDownload wrappers (App.jsx:~155 and
    // :~192) both pick this up. Master toggle is off by default so
    // existing user flows are unchanged; toggling on in Settings makes
    // every new webtoons.com download recompress without per-job UI.
    // Silently no-ops for non-webtoons.com handlers (Python checks
    // handler.name === "linewebtoon" before the encode pass).
    webtoonRecompress: false,
    webtoonRecompressQuality: 85,
    webtoonRecompressMethod: 4,
    // Content-aware JXL/AVIF transcode (opt-in, CBZ-only). Mirrors the
    // --modernize* CLI flags (aio-dl.py, grep '--modernize compatibility
    // checks'). Rides the CBZ byte-passthrough fast-path, so it's only valid
    // with the fast-path conditions (format cbz/komikku, quality 100,
    // scaling 100, preserve-originals on, no-processing off); the toggle in
    // the Modernize section below auto-corrects those on enable, and
    // downloader.js:buildCliArgs (modernizeBlocked) strips the flag if
    // they're ever violated. DownloadTab's DEFAULT_FORM spread + App.jsx's
    // search/library defaults spread propagate these to every download path.
    modernize: false,
    // Fully-reversible archival preset. UI-level only — no dedicated CLI
    // flag: downloader.js:buildCliArgs forces the PAIR --modernize-format
    // jxl + --modernize-distance 0 while this is on and ignores the stored
    // routing/distance/AVIF values (kept, so switching the preset off
    // restores them). A PAIR because auto + distance 0 is NOT reversible —
    // auto still routes color pages to the always-lossy AVIF branch.
    modernizeReversible: false,
    modernizeFormat: "auto",      // auto | jxl | avif | jxl+avif
    modernizeQuality: 90,         // AVIF color quality (1-100)
    modernizeDistance: 1.0,       // JXL grayscale distance (0.0 = lossless)
    modernizeMinSaving: 0.92,     // keep transcode only if < orig * this
    // CPU<->size knobs (no pixel change; NON-gating on the Python side).
    // INVERSE axes — higher JXL effort = slower/smaller, higher AVIF speed =
    // faster/larger. Defaults are the measured sweet spot (see the effort-9
    // CPU-trap benchmark). downloader.js emits --modernize-effort /
    // --modernize-avif-speed only when they differ from these.
    modernizeEffort: 7,           // JXL effort 1-9
    modernizeAvifSpeed: 6,        // AVIF speed 0-10
  },
  // Per-search defaults — read by SearchTab on mount via the same
  // settings.searchOpts namespace. Surfaced here so the user has one
  // central place to configure both download and search defaults.
  searchOpts: { ...DEFAULT_SEARCH_OPTS },
};

// ── CATEGORIES ──
// The 7-group taxonomy for the two-pane category-navigator layout (2026-07-05
// redesign — de-crowds the old ~2,300-line single flat scroll). Array ORDER is
// the nav order. Each `id` must match the `group` field on entries in the
// component-local SECTIONS registry (grep SECTIONS in this file); the count
// badge in the left nav is derived from that registry, so adding a section is a
// one-line SECTIONS edit with no change here. Icons are lucide components
// imported above. Module-level (no closure deps) so it's built once, not per
// render — mirrors the DEFAULT_SETTINGS placement.
const CATEGORIES = [
  { id: "general", label: "General", icon: Settings,
    desc: "Environment, Python, and logging behaviour." },
  { id: "output", label: "Output", icon: FileText,
    desc: "File format, image quality, and per-chapter packaging." },
  { id: "compression", label: "Compression", icon: ImageIcon,
    desc: "Optional JXL / AVIF and WebP re-encoding to shrink archives." },
  // navLabel: compact single-word label for the narrow left nav (the pane-head
  // still shows the full `label`). Network is the only multi-word group; keeping
  // it full-length would force the whole nav ~30px wider just to fit one item.
  { id: "network", label: "Network & Speed", navLabel: "Network", icon: Network,
    desc: "Speed caps, concurrency, prefetch, and fallback sources." },
  { id: "metadata", label: "Metadata", icon: Tags,
    desc: "AniList tags, descriptions, and enrichment." },
  { id: "search", label: "Search", icon: Search,
    desc: "Defaults for cross-site title search." },
  { id: "library", label: "Library", icon: Library,
    desc: "Update checks and how the library is scanned." },
];

// ── Dirty diff for the Save Settings button ──
// Compares the local in-memory settings draft against the most recently
// hydrated `settings` prop (mirrors what's on disk via get-settings IPC).
// Counts every key that differs across the top level + the two known
// nested namespaces (defaults, searchOpts). `isPackaged` is excluded —
// it's read-only from main.js and never persisted (see handleSave below).
// Returns 0 when `settings` is nullish so the button doesn't blink an
// inflated count during the ~50ms before the first get-settings IPC
// resolves on mount.
//
// IMPORTANT: walks ONLY local's keys, not the union of local + settings.
// history.js:saveSettings does a defensive merge (`{...this._settings,
// ...filtered}`) so legacy or obsolete keys on disk (e.g. the
// pre-2026-05-13 `mangafireImageConcurrency` left over after the rename
// migration) survive every save indefinitely. Counting those in the
// dirty diff would produce a phantom count the user can't act on —
// the UI doesn't surface those fields, so there's no control to flip,
// and clicking Save wouldn't bring the count down. By walking only
// local's keys we count exactly the keys the user CAN influence via the
// UI, which is the contract "Save Settings · N changed" implies.
//
// New-feature defaults backfilling missing keys (a new field added in
// the UI's initial useState that older settings.json files don't have
// yet) still surface as dirty — local has the key, settings doesn't,
// `local[k] !== settings[k]` → counted. Saving flushes them to disk
// and the count drops to 0 on the next render. That's correct: those
// one-time inflations represent genuine on-disk work.
// Cross-file: matches the shape of the initial useState below + the
// migration logic in the settings-hydration useEffect + the merge in
// electron/history.js:saveSettings.
function countDirtySettings(local, settings) {
  if (!settings) return 0;
  const SKIP_TOP = new Set(["isPackaged"]);
  const NESTED = ["defaults", "searchOpts"];
  let count = 0;

  for (const k of Object.keys(local)) {
    if (SKIP_TOP.has(k) || NESTED.includes(k)) continue;
    if (local[k] !== settings[k]) count++;
  }

  for (const ns of NESTED) {
    const a = local[ns] || {};
    const b = settings[ns] || {};
    for (const k of Object.keys(a)) {
      if (a[k] !== b[k]) count++;
    }
  }

  return count;
}

// ── Save Settings button with dirty-state + confirmation sweep ──
// Replaces the bare <Button> the footer used to render. Visual states:
//   - idle/clean:   muted primary (bg-primary/60), Check icon, "Up to date"
//   - idle/dirty:   full primary + amber ring + amber dot, Save icon,
//                   "Save Settings · N changed"
//   - in:           emerald-500 fill grows L→R from a pseudo-overlay span
//                   over 280ms; label flips to "Saved" + Check icon
//   - hold:         emerald fill held at scaleX(1) for ~900ms (driven
//                   by the timer gap, not a separate phase)
//   - out:          emerald fill shrinks scaleX(1)→scaleX(0) with the
//                   origin flipped to right; takes 320ms then → idle
//   - error:        bg-destructive, AlertTriangle icon, "Save failed";
//                   auto-dismisses after 2500ms back to idle (which then
//                   renders dirty because the hydration round-trip
//                   never happened — dirty count stayed > 0)
//
// The L→R origin flip when entering 'out' is invisible: transform-origin
// is NOT in the transition-property list, so it snaps instantly while
// scaleX is still 1 (visually identical regardless of origin at scale 1),
// then the scaleX(1)→scaleX(0) shrink runs against the new right origin.
//
// Cross-file coupling: `cn` from @/lib/utils (clsx + tailwind-merge).
// Async onSave threads through SettingsTab.handleSave → useDownloader.
// saveSettings (await window.electronAPI.saveSettings + setSettings) →
// preload.js → electron/main.js's "save-settings" IPC handler →
// history.js:saveSettings (volatile-path filter + atomic file write).
// IPC currently resolves in <50ms locally, so the sweep is the dominant
// duration the user actually perceives — any "loading" spinner state
// would flash by too fast to register and isn't worth wiring up.
function SaveSettingsButton({ dirty, onSave }) {
  const [phase, setPhase] = useState("idle"); // 'idle' | 'in' | 'out' | 'error'
  const timers = useRef([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const cancelTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const handleClick = async () => {
    if (phase !== "idle") return;

    try {
      await onSave();
    } catch {
      cancelTimers();
      setPhase("error");
      timers.current.push(setTimeout(() => setPhase("idle"), 2500));
      return;
    }

    cancelTimers();
    setPhase("in");
    // 280ms sweep-in + 900ms hold + 320ms sweep-out ≈ 1500ms total. Two
    // timers fire at the in→out boundary (1180ms) and the final reset
    // to idle (1500ms); the sweep visual itself is driven by CSS
    // transitions off the phase-derived className below.
    timers.current.push(setTimeout(() => setPhase("out"), 1180));
    timers.current.push(setTimeout(() => setPhase("idle"), 1500));
  };

  const isAnimating = phase === "in" || phase === "out";
  const isErrored = phase === "error";
  const isClean = dirty === 0;

  const sweepScale = phase === "in" ? "scale-x-100" : "scale-x-0";
  const sweepOrigin = phase === "out" ? "origin-right" : "origin-left";
  const sweepDuration =
    phase === "in" ? "duration-[280ms]" :
    phase === "out" ? "duration-[320ms]" :
    "duration-0";

  let icon, label, baseColor, showAmberDot, ring;
  if (isErrored) {
    icon = <AlertTriangle className="w-4 h-4" />;
    label = "Save failed";
    baseColor = "bg-destructive text-destructive-foreground";
    showAmberDot = false;
    ring = "";
  } else if (isAnimating) {
    icon = <Check className="w-4 h-4" />;
    label = "Saved";
    // text-white reads cleanly over both bg-primary (under-sweep) and
    // bg-emerald-500 (over-sweep) in both light + dark themes.
    baseColor = "bg-primary text-white";
    showAmberDot = false;
    ring = "";
  } else if (isClean) {
    icon = <Check className="w-4 h-4" />;
    label = "Up to date";
    baseColor = "bg-primary/60 text-primary-foreground/90 hover:bg-primary/70";
    showAmberDot = false;
    ring = "";
  } else {
    icon = <Save className="w-4 h-4" />;
    label = `Save Settings · ${dirty} changed`;
    baseColor = "bg-primary text-primary-foreground hover:bg-primary/90";
    showAmberDot = true;
    ring = "ring-2 ring-amber-500/30";
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isAnimating || isErrored}
      aria-busy={isAnimating}
      aria-live="polite"
      className={cn(
        "relative overflow-hidden inline-flex flex-1 items-center justify-center gap-2",
        "h-9 px-4 py-2 text-sm rounded-md font-medium shadow-sm",
        "transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        baseColor,
        ring,
      )}
    >
      {/* Sweep overlay — emerald fill driven by phase-derived classes.
          Sits absolutely inside overflow-hidden so the rounded corners
          clip the sweep; z-0 (implicit) keeps it behind the label span. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 bg-emerald-500 transition-transform ease-out",
          sweepScale,
          sweepOrigin,
          sweepDuration,
        )}
      />
      <span className="relative z-10 inline-flex items-center gap-2">
        {showAmberDot && (
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_4px_rgba(245,158,11,0.7)]"
          />
        )}
        {icon}
        {label}
      </span>
    </button>
  );
}

export default function SettingsTab({ settings, onSave }) {
  // Local copy of settings so changes don't apply until you click Save
  // Local copy of settings so changes don't apply until you click Save.
  // Sourced from the module-level DEFAULT_SETTINGS (single source of truth,
  // also consumed by handleReset). Lazy initializer + structuredClone so the
  // draft owns its own nested `defaults`/`searchOpts` objects and never
  // mutates the shared const. Field-level rationale lives on DEFAULT_SETTINGS.
  const [local, setLocal] = useState(() => structuredClone(DEFAULT_SETTINGS));

  // Which category pane is visible in the two-pane layout (2026-07-05 redesign).
  // Resets to the first group ("general") on every mount — SettingsTab unmounts
  // when you leave the Settings tab (App.jsx conditionally renders it), so this
  // is deliberately not persisted. All 15 sections share the one `local` draft
  // below, so edits in a hidden category survive navigation and still count
  // toward the dirty badge / Save.
  const [activeCategory, setActiveCategory] = useState("general");

  // Display-only resolved paths (what main.js would use as defaults when
  // local.pythonCmd / .scriptPath / .workingDir are empty). Shown as
  // placeholders/hints in the path input fields below. NOT persisted —
  // fetched once via the dedicated read-only IPC so the volatile auto-
  // resolved values (AppImage /tmp/.mount_*, macOS App Translocation,
  // DMG-direct) never enter the saveSettings round-trip.
  const [resolved, setResolved] = useState({
    pythonCmd: "",
    scriptPath: "",
    workingDir: "",
  });

  // Fetch resolved paths from main.js once on mount. The handler is a
  // pure read of the computePaths() globals — no side effects, runs in
  // microseconds. We don't refresh on every settings change because
  // those globals don't move at runtime.
  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== "undefined" && window.electronAPI;
    if (api && typeof api.getResolvedPaths === "function") {
      api.getResolvedPaths()
        .then((r) => { if (!cancelled && r) setResolved(r); })
        .catch(() => { /* main.js missing handler → keep empty placeholders */ });
    }
    return () => { cancelled = true; };
  }, []);

  // Load settings when they arrive from Electron
  useEffect(() => {
    if (settings) {
      // Migration: pre-2026-05-13 settings dicts carry
      // `mangafireImageConcurrency` (MangaFire-only); the flag was
      // generalized + renamed to `imageConcurrency` and now applies to
      // any handler with SUPPORTS_FAST_DOWNLOAD. Forward the old key
      // ONCE on read; the next handleSave persists under the new name
      // and the old key falls off naturally on the next save round-trip.
      // Idempotent: no-op when imageConcurrency is already present.
      const migrated = { ...settings };
      if (
        migrated.mangafireImageConcurrency != null &&
        migrated.imageConcurrency == null
      ) {
        migrated.imageConcurrency = migrated.mangafireImageConcurrency;
      }
      // Drop the legacy key so it doesn't get written back on save.
      delete migrated.mangafireImageConcurrency;

      // Volatile-path filter on hydration — mirrors the write-side
      // filter in history.js:saveSettings. Existing users may have
      // pre-2026-05-13 settings.json files carrying stale AppImage /
      // macOS Gatekeeper-translocation paths that were auto-computed
      // and round-tripped before the fix. Without this filter, the
      // stale path would hydrate into local.scriptPath, the input
      // would show the broken path as the value (not a placeholder),
      // and even though saveSettings would reject the bad write, the
      // existing on-disk value would never get cleared. Stripping
      // volatile values here lets the input fall back to the resolved
      // placeholder so users see what's actually going to run.
      // Non-volatile customizations (e.g. a custom `python3.13` venv
      // path the user typed deliberately) pass through unchanged.
      const VOLATILE_PATH_PATTERNS = [
        /^\/tmp\/\.mount_/,
        /\/AppTranslocation\/[0-9A-F-]+\//,
        /\/Volumes\/[^/]+\.app\//,
      ];
      for (const k of ["pythonCmd", "scriptPath", "workingDir"]) {
        const v = migrated[k];
        if (typeof v === "string" && v) {
          const normalized = v.replace(/\\/g, "/");
          if (VOLATILE_PATH_PATTERNS.some((re) => re.test(normalized))) {
            delete migrated[k];
          }
        }
      }

      setLocal((prev) => ({
        ...prev,
        ...migrated,
        defaults: { ...prev.defaults, ...(migrated.defaults || {}) },
        searchOpts: { ...prev.searchOpts, ...(migrated.searchOpts || {}) },
      }));
    }
  }, [settings]);

  const set = (key, value) => setLocal((prev) => ({ ...prev, [key]: value }));
  const setDefault = (key, value) =>
    setLocal((prev) => ({
      ...prev,
      defaults: { ...prev.defaults, [key]: value },
    }));
  const setSearchOpt = (key, value) =>
    setLocal((prev) => ({
      ...prev,
      searchOpts: { ...prev.searchOpts, [key]: value },
    }));

  // A Max-network preset (Resource Limits) hard-overrides the five concurrency
  // inputs below — imageWorkers, imageConcurrency, prefetch depth/parallel, and
  // search Parallel-sites — so they render disabled and show their EFFECTIVE
  // (running) value while the stored manual value is preserved. grep netManaged.
  const netManaged = isNetworkManaged(local.networkLimit);

  // Whether the default --webtoon-recompress toggle is valid for the current
  // default format. aio-dl.py rejects recompress with --format pdf/none (no
  // archive to write into); --komikku coerces format→cbz first, so it's
  // allowed then. Mirrors DownloadTab's recompressAllowed. Drives the default
  // toggle's disabled state + the format-select auto-clear below.
  const recompressAllowedDefault =
    local.defaults.komikku ||
    local.defaults.format === "cbz" ||
    local.defaults.format === "epub";

  // Whether --modernize is valid for the current default config. Unlike
  // webtoon-recompress (which also allows epub), modernize is CBZ-ONLY: it
  // emits .jxl/.avif pages that only survive the CBZ byte-passthrough
  // fast-path (other formats re-encode them away). komikku coerces format→cbz
  // so it qualifies too. Drives the toggle's disabled state + the on-enable
  // auto-correct below; mirrors aio-dl.py's '--modernize compatibility checks'.
  const modernizeAllowedDefault =
    local.defaults.komikku || local.defaults.format === "cbz";

  // Fast-path conditions modernize needs beyond the format gate (quality 100,
  // scaling 100, preserve-originals on, no-processing off). The enable handler
  // sets these, but the user can still break them afterward via the
  // sliders/toggles above — surface that as a warning instead of letting
  // aio-dl.py hard-error mid-spawn. buildCliArgs (modernizeBlocked) also strips
  // --modernize defensively in that case, so a broken combo just skips
  // modernize rather than failing the whole download.
  const modernizeConflicts =
    !!local.defaults.modernize && modernizeAllowedDefault && (
      (local.defaults.quality ?? 100) < 100 ||
      (local.defaults.scaling ?? 100) < 100 ||
      local.defaults.cbzPreserveOriginals === false ||
      local.defaults.noProcessing === true
    );

  // Dirty count drives the SaveSettingsButton's pre-click visual
  // ("Save Settings · N changed" + amber ring/dot when > 0, "Up to date"
  // when 0). Recomputed cheaply on any local-state change; the diff
  // walks ~30 top-level keys + ~25 nested keys, well under a frame.
  // See countDirtySettings above for the migration-edge-case rationale.
  const dirty = useMemo(() => countDirtySettings(local, settings), [local, settings]);

  // Awaited (not fire-and-forget) so SaveSettingsButton can chain its
  // sweep-in only after the IPC round-trip resolves successfully — and
  // route to the 'error' branch if history.saveSettings throws (disk
  // full, EACCES, etc.). Pre-change behavior dropped the promise; the
  // failure was an unhandled rejection. `await onSave(saveable)`
  // preserves the rejection so the button's try/catch sees it.
  const handleSave = async () => {
    const { isPackaged, ...saveable } = local;
    await onSave(saveable);
  };

  const handleReset = () => {
    // Reset to DEFAULT_SETTINGS (the same single source the useState
    // initializer clones). structuredClone so the reset draft owns fresh
    // nested objects. Path fields reset to "" in BOTH packaged and dev modes
    // (empty == "use the runtime-resolved default"; the placeholder from
    // getResolvedPaths shows what will run) — DEFAULT_SETTINGS already carries
    // "" for all three. Only isPackaged is overridden: it's owned by main.js,
    // so keep the current value rather than DEFAULT_SETTINGS's placeholder.
    setLocal((prev) => ({
      ...structuredClone(DEFAULT_SETTINGS),
      isPackaged: prev.isPackaged,
    }));
  };

  const browseScript = async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.pickFile([
      { name: "Python Scripts", extensions: ["py"] },
    ]);
    if (path) set("scriptPath", path);
  };

  const browseWorkingDir = async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.pickFolder();
    if (path) set("workingDir", path);
  };

  const [confirmReinstall, setConfirmReinstall] = useState(false);
  const handleReinstall = async () => {
    if (!window.electronAPI?.reinstallPython) return;
    if (!confirmReinstall) {
      setConfirmReinstall(true);
      setTimeout(() => setConfirmReinstall(false), 4000);
      return;
    }
    setConfirmReinstall(false);
    await window.electronAPI.reinstallPython();
  };

  // ══════════════════════════════════════════════════════════════════════
  // SECTION RENDERERS
  // Each returns the controls for ONE settings section — the exact JSX that
  // used to sit inline in the old flat scroll, MINUS its <SectionHeader> (the
  // pane loop below emits that from the SECTIONS registry's `title`). They're
  // closures over the component state/handlers above, so wiring is unchanged.
  // Reorg vs the pre-2026-07-05 flat layout: Logging joins General; Metadata
  // is its own group; the "prefetch workers for next chapter" knob moved out
  // of Chapter Behavior into "Image Prefetch & Concurrency" (it's a
  // prefetch/concurrency knob, not a chapter-collapse one).
  // ══════════════════════════════════════════════════════════════════════

  // ── General › Paths & Python ──
  const renderPaths = () => (
    <>
      {/* ── BUNDLED MODE: Show a simple info card instead of editable paths ── */}
      {local.isPackaged ? (
        <Card className="p-3 space-y-2 bg-emerald-500/10 border-emerald-500/30">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-emerald-500" />
            <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              Bundled Python
            </span>
            <Badge variant="secondary" className="text-[10px] ml-auto">Installed Mode</Badge>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Python, Playwright, and all dependencies were set up automatically.
            No external Python installation needed.
          </p>
          {/* Still show the working directory so users know where manga is saved */}
          <div className="pt-1">
            <Label className="text-xs">Output Directory (manga saved here)</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={local.workingDir}
                onChange={(e) => set("workingDir", e.target.value)}
                placeholder={resolved.workingDir || ""}
                className="flex-1 font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={browseWorkingDir}>
                <FolderOpen className="w-3.5 h-3.5" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {local.workingDir
                ? <>The "manga" folder will be created inside this directory.</>
                : <>Using auto-resolved default. Leave blank to keep it; type a path to override.</>
              }
            </p>
          </div>
          {/* Reinstall button — re-downloads Python from scratch */}
          <div className="pt-1">
            <Button
              variant="outline"
              size="sm"
              className={confirmReinstall
                ? "text-xs gap-1.5 text-destructive border-destructive/50 hover:text-destructive hover:border-destructive/50"
                : "text-xs gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50"
              }
              onClick={handleReinstall}
              onBlur={() => setConfirmReinstall(false)}
            >
              <RefreshCw className="w-3 h-3" />
              {confirmReinstall ? "Click again to confirm reinstall" : "Reinstall Python Environment"}
            </Button>
          </div>
        </Card>
      ) : (
        /* ── DEV MODE: Full editable paths ── */
        <div className="space-y-3">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">
              Dev mode — using system Python
            </span>
          </div>

          <div>
            <Label className="text-xs">Python Command</Label>
            <Input
              value={local.pythonCmd}
              onChange={(e) => set("pythonCmd", e.target.value)}
              placeholder={resolved.pythonCmd || "python"}
              className="mt-1 font-mono text-sm"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {local.pythonCmd
                ? <>Custom override. Clear to fall back to auto-resolved <span className="font-mono">{resolved.pythonCmd || "python"}</span>.</>
                : <>Using auto-resolved <span className="font-mono">{resolved.pythonCmd || "python"}</span>. Type to override (e.g. <span className="font-mono">python3.13</span> for a specific venv).</>
              }
            </p>
          </div>

          <div>
            <Label className="text-xs">aio-dl.py Location</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={local.scriptPath}
                onChange={(e) => set("scriptPath", e.target.value)}
                placeholder={resolved.scriptPath || ""}
                className="flex-1 font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={browseScript}>
                <FileText className="w-3.5 h-3.5" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {local.scriptPath
                ? <>Custom override. Clear to fall back to the auto-resolved path shown as placeholder.</>
                : <>Using auto-resolved default. Leave blank or type a path to override.</>
              }
            </p>
          </div>

          <div>
            <Label className="text-xs">Working Directory</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={local.workingDir}
                onChange={(e) => set("workingDir", e.target.value)}
                placeholder={resolved.workingDir || ""}
                className="flex-1 font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={browseWorkingDir}>
                <FolderOpen className="w-3.5 h-3.5" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {local.workingDir
                ? <>Custom override. The "manga" output folder will be created here. Clear to fall back to the auto-resolved path.</>
                : <>Using auto-resolved default. Leave blank or type a path to override.</>
              }
            </p>
          </div>
        </div>
      )}
    </>
  );

  // ── General › Logging ──
  const renderLogging = () => (
    <>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={local.verboseAlways}
          onCheckedChange={(v) => set("verboseAlways", v)}
        />
        <Label className="text-xs cursor-pointer">
          Always use verbose mode (--verbose flag on every download)
        </Label>
      </div>

      {/* Log update interval */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs">Log Update Speed</Label>
          <Badge variant="secondary">{local.logUpdateInterval}ms</Badge>
        </div>
        <Slider
          value={local.logUpdateInterval}
          onValueChange={(v) => set("logUpdateInterval", v)}
          min={50}
          max={2000}
          step={50}
        />
        <div className="flex justify-between mt-1 px-0.5">
          <span className="text-[10px] text-muted-foreground">50ms (fastest)</span>
          <span className="text-[10px] text-muted-foreground">2000ms (lightest)</span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          How often logs and progress bars refresh. Lower = more responsive, higher = less CPU.
        </p>
      </div>
    </>
  );

  // ── Output › Format & Quality (+ CBZ preserve-originals) ──
  const renderFormat = () => (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <Label className="text-xs">Format</Label>
          <Select
            value={local.defaults.format}
            onChange={(e) => {
              const next = e.target.value;
              // Honor the "None (images only)" label promise: aio-dl.py
              // treats --format none as "skip the final book build" and
              // silently passes on it (line ~6196), with no output unless
              // --keep-images or --keep-chapters is also set. Selecting
              // None here auto-enables keepImages so the user actually
              // gets the images the label advertises. They can still
              // manually uncheck keepImages later for a metadata-only
              // run, but the warning below will fire if they do.
              setLocal((prev) => ({
                ...prev,
                defaults: {
                  ...prev.defaults,
                  format: next,
                  ...(next === "none" ? { keepImages: true } : {}),
                  // PDF/None can't carry --webtoon-recompress (no archive to
                  // write into; aio-dl.py hard-errors). Auto-clear the
                  // default so we never save a contradictory combo. Skip
                  // when Komikku is on — it coerces format→cbz.
                  ...((next === "pdf" || next === "none") && !prev.defaults.komikku
                    ? { webtoonRecompress: false }
                    : {}),
                  // --modernize is CBZ-only (stricter than webtoon, which
                  // also allows epub): its .jxl/.avif pages only survive CBZ
                  // output. Clear it whenever the new format isn't cbz and
                  // komikku isn't coercing to cbz, so we never persist a
                  // contradictory combo (mirrors modernizeAllowedDefault).
                  ...(next !== "cbz" && !prev.defaults.komikku
                    ? { modernize: false }
                    : {}),
                },
              }));
            }}
            className="mt-1"
          >
            <option value="pdf">PDF</option>
            <option value="epub">EPUB</option>
            <option value="cbz">CBZ</option>
            <option value="none">None (images only)</option>
          </Select>
          {/* Warning fires only when the user has explicitly unchecked
              both Keep images and Keep chapters under format=none — the
              only path that produces an empty manga folder. The format
              onChange above auto-enables keepImages, so the default
              "select None" path never trips this. */}
          {local.defaults.format === "none"
            && !local.defaults.keepImages
            && !local.defaults.keepChapters && (
            <p className="text-[10px] text-yellow-500 dark:text-yellow-400 mt-1 leading-snug">
              Format = None with no "Keep images" / "Keep chapters" enabled
              produces nothing in the manga folder (only metadata).
              Re-enable one of those toggles to keep raw images or
              per-chapter files.
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <Label className="text-xs">Quality</Label>
            <Badge variant="secondary">{local.defaults.quality}</Badge>
          </div>
          <Slider
            value={local.defaults.quality}
            onValueChange={(v) => setDefault("quality", v)}
            min={1}
            max={100}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <Label className="text-xs">Scaling</Label>
            <Badge variant="secondary">{local.defaults.scaling}%</Badge>
          </div>
          <Slider
            value={local.defaults.scaling}
            onValueChange={(v) => setDefault("scaling", v)}
            min={1}
            max={100}
          />
        </div>

        {/* Global default download language. DownloadTab's useEffect
            spreads settings.defaults into its form, so picking a
            language here makes it the default in the New tab AND in
            search-initiated downloads (App.jsx:185-194 spreads defaults
            into the queueDownload args). Library-tab downloads still
            use the per-series saved language from .aio_series.json,
            which is correct — that's the language the series was
            originally fetched in. */}
        <div>
          <Label className="text-xs">Default language</Label>
          <Select
            value={local.defaults.language || "en"}
            onChange={(e) => setDefault("language", e.target.value)}
            className="mt-1"
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </Select>
        </div>
      </div>

      {/* CBZ byte-preservation toggle (Phase F, 2026-05-07).
          Only meaningful when --format cbz; the flag is benign on other
          formats (aio-dl ignores it). When ON (default), CBZ output keeps
          the original wire bytes from the CDN — lossless, fastest,
          smallest. Turn off to force decode/re-encode (uses --quality and
          --scaling). downloader.js emits --no-cbz-preserve-originals only
          when this is === false. */}
      <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-border/50">
        <div className="flex-1">
          <Label className="text-xs cursor-pointer">CBZ: preserve original image bytes</Label>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            When on, CBZ archives the original CDN wire bytes (WebP/JPEG/PNG)
            losslessly. Turn off to force decode + re-encode (slower,
            respects --quality and --scaling).
          </p>
        </div>
        <Switch
          checked={local.defaults.cbzPreserveOriginals !== false}
          onCheckedChange={(v) => setDefault("cbzPreserveOriginals", v)}
        />
      </div>
    </>
  );

  // ── Output › Komikku Output ──
  // When ON, Python force-coerces --format cbz / --keep-chapters /
  // --no-final-file regardless of the Format selector. Each chapter CBZ gets
  // its own ComicInfo.xml + cover.jpg + details.json at the series-folder root.
  const renderKomikku = () => (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1">
        <Label className="text-xs cursor-pointer">
          Write Komikku-compatible per-chapter CBZs
        </Label>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Each chapter is its own CBZ with a per-chapter{" "}
          <span className="font-mono">ComicInfo.xml</span> (chapter number,
          title, scanlator, web URL, upload date). Series folder also gets{" "}
          <span className="font-mono">cover.jpg</span> +{" "}
          <span className="font-mono">details.json</span> (status, genres,
          authors). Forces format=CBZ, keep-chapters, no-final-file.
          Output stays at <span className="font-mono">manga/&lt;Series&gt;/</span>;
          sync that into Komikku's storage root yourself.
        </p>
      </div>
      <Switch
        checked={!!local.defaults.komikku}
        onCheckedChange={(v) => setDefault("komikku", v)}
      />
    </div>
  );

  // ── Output › Chapter Behavior (collapse split chapters) ──
  // Moved 2026-05-08 from "Default Search Options" because it now affects
  // download behavior, not just the search-display diagnostic. Same toggle
  // drives sites/chapter_merger.py:group_chapters_for_download on the Python
  // side; SearchTab's inline toggle reads/writes the same settings.collapseSplits.
  const renderChapters = () => (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1">
        <Label className="text-xs cursor-pointer">Collapse split chapters</Label>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          When sources split chapter 1 into 1.1/1.2/1.3/1.4 (no integer 1),
          combine them into a single Chapter 1 file. When integer 1 exists
          alongside the splits, they're treated as redundant duplicates and
          dropped. True partials like 1.5 alongside Ch 1 are preserved.
          Affects both downloads and the search-coverage display. Turn off
          for series that legitimately use decimal numbering.
        </p>
      </div>
      <Switch
        checked={local.collapseSplits === true}
        onCheckedChange={(v) => set("collapseSplits", v)}
      />
    </div>
  );

  // ── Output › Processing Toggles ──
  const renderToggles = () => (
    <div className="grid grid-cols-2 gap-3">
      {[
        ["keepChapters", "Keep chapters"],
        ["noFinalFile", "No final file"],
        ["keepImages", "Keep images"],
        ["noProcessing", "No processing"],
        ["noCleanup", "No cleanup"],
      ].map(([key, label]) => (
        <div key={key} className="flex items-center gap-2">
          <Checkbox
            checked={local.defaults[key]}
            onCheckedChange={(v) => setDefault(key, v)}
          />
          <Label className="text-xs cursor-pointer">{label}</Label>
        </div>
      ))}
    </div>
  );

  // ── Compression › Modernize (JXL / AVIF) ──
  // Opt-in content-aware transcode (--modernize family). CBZ-only; the master
  // toggle is gated on modernizeAllowedDefault (komikku || format cbz) and, on
  // enable, auto-corrects the fast-path conditions (quality 100 / scaling 100 /
  // preserve-originals on / no-processing off) so the saved config can't
  // hard-error at spawn. The valued knobs map 1:1 to the CLI: codec routing,
  // JXL distance, AVIF quality, min-saving — plus a UI-level fully-reversible
  // preset (modernizeReversible, no dedicated CLI flag) that buildCliArgs
  // resolves to the forced pair jxl + distance 0 and that hides the knobs it
  // overrides. downloader.js:buildCliArgs maps modernize* → --modernize* and
  // strips them if the fast-path is disabled.
  const renderModernize = () => (
    <>
      <p className="text-[10px] text-muted-foreground -mt-1 mb-2 leading-snug">
        Re-encode JPEG/PNG pages to <span className="font-mono">JXL</span>{" "}
        (grayscale line art) or <span className="font-mono">AVIF</span>{" "}
        (color) before packaging — visually-lossless storage savings for a
        reader that decodes them. Per-page choice; already-efficient
        WebP/AVIF/JXL pages are left untouched, and a page is only replaced
        when the new file actually comes out smaller (never bloats). CBZ only
        — rides the byte-passthrough fast-path, so it pairs with Komikku
        output and keeps the source resolution.
      </p>
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <Switch
            checked={!!local.defaults.modernize && modernizeAllowedDefault}
            onCheckedChange={(v) => {
              if (!modernizeAllowedDefault) return;
              if (v) {
                // Enable + auto-correct the fast-path conditions modernize
                // requires (aio-dl.py hard-errors otherwise). The quality /
                // scaling sliders are moot under modernize anyway — it
                // replaces the page bytes with JXL/AVIF, so a prior re-encode
                // would just be wasted generation loss. Mirrors the
                // format=none → keepImages auto-enable above.
                setLocal((prev) => ({
                  ...prev,
                  defaults: {
                    ...prev.defaults,
                    modernize: true,
                    quality: 100,
                    scaling: 100,
                    cbzPreserveOriginals: true,
                    noProcessing: false,
                  },
                }));
              } else {
                setDefault("modernize", false);
              }
            }}
            disabled={!modernizeAllowedDefault}
            className="mt-0.5"
          />
          <div className="flex-1">
            <Label className={cn("text-xs cursor-pointer", !modernizeAllowedDefault && "opacity-40")}>
              Transcode pages to JXL / AVIF
            </Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Applies to every CBZ download — direct URL, search-initiated,
              and library re-downloads. Idempotent: re-running over an
              already-modernized series skips pages that are already JXL/AVIF.
            </p>
            {!modernizeAllowedDefault && (
              <p className="text-[10px] text-yellow-500 dark:text-yellow-400 mt-1 leading-snug">
                Unavailable while the default format is{" "}
                <span className="font-mono">{(local.defaults.format || "").toUpperCase()}</span>{" "}
                — modernize writes JXL/AVIF pages that only survive CBZ output.
                Switch the default format to CBZ (or enable Komikku) to use it.
              </p>
            )}
          </div>
        </div>
        {local.defaults.modernize && modernizeAllowedDefault && (
          <div className="pl-12 animate-slide-up space-y-3">
            {modernizeConflicts && (
              <p className="text-[10px] text-yellow-500 dark:text-yellow-400 leading-snug">
                Heads up — modernize needs the CBZ byte-passthrough fast-path,
                but your current defaults disable it:
                {(local.defaults.quality ?? 100) < 100 && (
                  <> <span className="font-mono">Quality&nbsp;{local.defaults.quality}</span></>
                )}
                {(local.defaults.scaling ?? 100) < 100 && (
                  <> <span className="font-mono">Scaling&nbsp;{local.defaults.scaling}%</span></>
                )}
                {local.defaults.cbzPreserveOriginals === false && (
                  <> <span className="font-mono">preserve-originals&nbsp;off</span></>
                )}
                {local.defaults.noProcessing === true && (
                  <> <span className="font-mono">no-processing&nbsp;on</span></>
                )}
                . The downloader will skip modernize until these are reset
                (Quality 100, Scaling 100%, CBZ preserve-originals on,
                No&nbsp;processing off).
              </p>
            )}
            {/* Fully-reversible archival preset. buildCliArgs (downloader.js)
                forces the PAIR --modernize-format jxl + --modernize-distance
                0 while this is on — a PAIR because auto + distance 0 is NOT
                reversible (auto still routes color pages to the always-lossy
                AVIF branch). The routing/distance/AVIF controls below are
                hidden meanwhile; their stored values are untouched so
                switching the preset off restores them. Python side: distance
                0 = bit-exact JPEG->JXL reconstruction + pixel-lossless PNG,
                reconstructions exempt from min-saving (aio-dl.py, grep
                is_recon). */}
            <div className="flex items-start gap-3">
              <Switch
                checked={!!local.defaults.modernizeReversible}
                onCheckedChange={(v) => setDefault("modernizeReversible", !!v)}
                className="mt-0.5"
              />
              <div className="flex-1">
                <Label className="text-xs cursor-pointer">
                  Fully reversible (archival)
                </Label>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                  Every page becomes lossless JXL: JPEGs are stored as
                  bit-exact reversible reconstructions (the original .jpg is
                  recoverable byte-for-byte; measured 7–87% smaller than the
                  source), PNGs become pixel-lossless, WebP/GIF stay
                  untouched. Locks routing to JXL-only — under Auto, color
                  pages would still take the lossy AVIF path. Larger than the
                  visually-lossless tiers, but the archive stays a faithful
                  master copy.
                </p>
              </div>
            </div>
            {/* Routing / distance / AVIF-quality are moot while the
                reversible preset forces jxl + d0 — hidden, values kept. */}
            {!local.defaults.modernizeReversible && (<>
            <div>
              <Label className="text-xs">Codec routing</Label>
              <Select
                value={local.defaults.modernizeFormat ?? "auto"}
                onChange={(e) => setDefault("modernizeFormat", e.target.value)}
                className="mt-1"
              >
                <option value="auto">Auto — JXL for B&amp;W, AVIF for color</option>
                <option value="jxl">JXL only</option>
                <option value="avif">AVIF only</option>
                <option value="jxl+avif">JXL + AVIF — encode both, keep smaller</option>
              </Select>
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                <span className="font-mono">Auto</span> decides per page (the
                right call for mixed libraries). Oversized pages
                (&gt; 8192&nbsp;px) always use JXL, except under AVIF-only
                where they're left untouched.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs">JXL distance (B&amp;W)</Label>
                  <Badge variant="secondary" className="font-mono tabular-nums">
                    {(local.defaults.modernizeDistance ?? 1.0) === 0
                      ? "lossless"
                      : (local.defaults.modernizeDistance ?? 1.0).toFixed(1)}
                  </Badge>
                </div>
                <Slider
                  value={local.defaults.modernizeDistance ?? 1.0}
                  onValueChange={(v) => setDefault("modernizeDistance", v)}
                  min={0}
                  max={3}
                  step={0.1}
                />
                <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                  Butteraugli distance for grayscale → JXL.{" "}
                  <span className="font-mono">1.0</span> = visually lossless
                  (default); lower = larger/closer to source;{" "}
                  <span className="font-mono">0.0</span> = mathematically
                  lossless — JPEGs become byte-exact reversible
                  reconstructions (measured 7–87% smaller than the source),
                  PNGs pixel-lossless. For a fully reversible archive use the
                  toggle above; routing must be JXL-only too.
                </p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs">AVIF quality (color)</Label>
                  <Badge variant="secondary" className="font-mono tabular-nums">
                    {local.defaults.modernizeQuality ?? 90}
                  </Badge>
                </div>
                <Slider
                  value={local.defaults.modernizeQuality ?? 90}
                  onValueChange={(v) => setDefault("modernizeQuality", v)}
                  min={1}
                  max={100}
                />
                <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                  AVIF quality for color pages.{" "}
                  <span className="font-mono">90</span> = visually lossless
                  (default); <span className="font-mono">85</span> =
                  aggressive (smaller; artifacts only under pixel-peeping).
                </p>
              </div>
            </div>
            </>)}
            {/* Encoder effort ─ pure CPU↔size knobs (--modernize-effort /
                --modernize-avif-speed). Split from the quality grid above
                because these change encode TIME and file SIZE only, never the
                decoded pixels — hence non-gating on the Python side (grep the
                _RESUME_GATING_DESTS note). The two axes are INVERSE (higher
                JXL effort = slower+smaller; higher AVIF speed = faster+larger),
                so each slider carries mirrored end-labels + a hint that only
                surfaces at the wasteful "lots of CPU for marginal size" end
                (effort 9 / avif-speed ≤4). Bench rationale: the effort-9
                CPU-trap memory note. */}
            <div className="border-t border-border/50 pt-3">
              <div className="flex items-baseline justify-between mb-0.5">
                <Label className="text-xs">Encoder effort</Label>
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground/80 font-medium">
                  speed&nbsp;↔&nbsp;size · same pixels
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mb-2.5 leading-snug">
                How hard the encoders work — changes{" "}
                <span className="text-foreground/90 font-medium">encode time
                and file size only</span>, never how a page looks. Defaults
                (JXL&nbsp;7, AVIF&nbsp;6) are the measured sweet spot.
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-xs">
                      JXL effort {local.defaults.modernizeReversible ? "(all pages)" : "(B&W)"}
                    </Label>
                    <Badge variant="secondary" className="font-mono tabular-nums">
                      {local.defaults.modernizeEffort ?? 7}
                    </Badge>
                  </div>
                  <Slider
                    value={local.defaults.modernizeEffort ?? 7}
                    onValueChange={(v) => setDefault("modernizeEffort", v)}
                    min={1}
                    max={9}
                    step={1}
                  />
                  <div className="flex justify-between text-[9px] font-mono text-muted-foreground/70 mt-1 px-0.5">
                    <span>1 · faster</span>
                    <span>smaller · 9</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                    Grayscale → JXL. <span className="font-mono">7</span> is the
                    sweet spot; <span className="font-mono">8</span> matches
                    9's size at ~1.5× the speed.
                  </p>
                  {(local.defaults.modernizeEffort ?? 7) >= 9 && (
                    <p className="text-[10px] text-yellow-500 dark:text-yellow-400 mt-1 leading-snug">
                      Effort 9 is a CPU trap — ~7.5× slower than 7 for only
                      ~5% smaller. Use 8 for near-identical size, or 7 to
                      encode fast.
                    </p>
                  )}
                </div>
                {/* Hidden under the reversible preset — jxl-only routing
                    means the AVIF branch never runs. */}
                {!local.defaults.modernizeReversible && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-xs">AVIF speed (color)</Label>
                    <Badge variant="secondary" className="font-mono tabular-nums">
                      {local.defaults.modernizeAvifSpeed ?? 6}
                    </Badge>
                  </div>
                  <Slider
                    value={local.defaults.modernizeAvifSpeed ?? 6}
                    onValueChange={(v) => setDefault("modernizeAvifSpeed", v)}
                    min={0}
                    max={10}
                    step={1}
                  />
                  <div className="flex justify-between text-[9px] font-mono text-muted-foreground/70 mt-1 px-0.5">
                    <span>0 · smaller</span>
                    <span>faster · 10</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                    Color → AVIF, axis{" "}
                    <span className="text-foreground/90 font-medium">reversed</span>:{" "}
                    <span className="font-mono">6</span> is the sweet spot —
                    lower is slower &amp; smaller, higher faster &amp; larger.
                  </p>
                  {(local.defaults.modernizeAvifSpeed ?? 6) <= 4 && (
                    <p className="text-[10px] text-yellow-500 dark:text-yellow-400 mt-1 leading-snug">
                      Speed {local.defaults.modernizeAvifSpeed} is ~5× slower
                      than 6 for only ~2% smaller (more so below 4). These
                      don't change quality — 6 is usually the better trade.
                    </p>
                  )}
                </div>
                )}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-xs">Minimum saving to replace a page</Label>
                <Badge variant="secondary" className="font-mono tabular-nums">
                  ≥{Math.round((1 - (local.defaults.modernizeMinSaving ?? 0.92)) * 100)}%
                </Badge>
              </div>
              <Slider
                value={local.defaults.modernizeMinSaving ?? 0.92}
                onValueChange={(v) => setDefault("modernizeMinSaving", v)}
                min={0.5}
                max={1}
                step={0.01}
              />
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                A transcoded page is kept only if it's at least this much
                smaller than the original — otherwise the original bytes stay.
                Default <span className="font-mono">≥8%</span>{" "}
                (<span className="font-mono">min-saving 0.92</span>) skips
                already-dense pages so the archive never grows. At distance{" "}
                <span className="font-mono">0</span>, JPEG→JXL reconstructions
                are exempt — being byte-recoverable, they're adopted whenever
                they're smaller at all.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );

  // ── Compression › LINE Webtoon Recompress ──
  // webtoons.com-only PNG→WebP recompression. Python-side
  // `handler.name === "linewebtoon"` gates the actual re-encode pass, so these
  // defaults are safe for mixed-site libraries (non-webtoons downloads skip it).
  const renderWebtoon = () => (
    <>
      <p className="text-[10px] text-muted-foreground -mt-1 mb-2 leading-snug">
        Re-encode webtoons.com <em className="not-italic font-semibold">lossless PNG</em> pages
        to lossy WebP before packaging — only fires when the active handler is{" "}
        <span className="font-mono">linewebtoon</span>, silently ignored for
        every other site. Skips JPEG-served chapters automatically
        (webtoons.com only ships PNG once a series gets popular — Eleceed
        flips at Ch 57; recompressing the small early JPEGs would be
        generation-loss for ~50 KB of savings). Typical impact on a
        PNG-heavy series: 45 GB → ~5 GB at q85. Requires CBZ or EPUB output;
        PDF is rejected at startup.
      </p>
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <Switch
            checked={!!local.defaults.webtoonRecompress && recompressAllowedDefault}
            onCheckedChange={(v) => recompressAllowedDefault && setDefault("webtoonRecompress", v)}
            disabled={!recompressAllowedDefault}
            className="mt-0.5"
          />
          <div className="flex-1">
            <Label className={cn("text-xs cursor-pointer", !recompressAllowedDefault && "opacity-40")}>
              Recompress webtoons.com pages to WebP
            </Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Applies to every webtoons.com download — direct URL, search-
              initiated, and library re-downloads.
            </p>
            {!recompressAllowedDefault && (
              <p className="text-[10px] text-yellow-500 dark:text-yellow-400 mt-1 leading-snug">
                Unavailable while the default format is{" "}
                <span className="font-mono">{(local.defaults.format || "").toUpperCase()}</span>{" "}
                — recompression needs CBZ or EPUB output. Change the default
                format above (or enable Komikku) to use it.
              </p>
            )}
          </div>
        </div>
        {local.defaults.webtoonRecompress && recompressAllowedDefault && (
          <div className="pl-12 animate-slide-up grid grid-cols-2 gap-x-6 gap-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-xs">Quality</Label>
                <Badge variant="secondary" className="font-mono tabular-nums">
                  {local.defaults.webtoonRecompressQuality ?? 85}
                </Badge>
              </div>
              <Slider
                value={local.defaults.webtoonRecompressQuality ?? 85}
                onValueChange={(v) => setDefault("webtoonRecompressQuality", v)}
                min={1}
                max={100}
              />
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                <span className="font-mono">85</span> = storage-optimized
                (default). <span className="font-mono">90</span> =
                archival-safe (~60% larger files). Above 95 is wasted
                bytes on color webtoon content.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-xs">Encoder effort</Label>
                <Badge variant="secondary" className="font-mono tabular-nums">
                  {local.defaults.webtoonRecompressMethod ?? 4}
                </Badge>
              </div>
              <Slider
                value={local.defaults.webtoonRecompressMethod ?? 4}
                onValueChange={(v) => setDefault("webtoonRecompressMethod", v)}
                min={0}
                max={6}
              />
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                <span className="font-mono">0</span> = fastest,{" "}
                <span className="font-mono">6</span> = smallest. Default
                4 is the sweet spot; 6 buys ~5% smaller files at ~2-3×
                the encode time — fine for overnight bulk runs.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );

  // ── Network & Speed › Resource Limits ──
  // Two discrete presets. HARD OVERRIDE: an active Max-network level REPLACES
  // the concurrency knobs in the sections below (they go disabled + show their
  // effective value); Max-CPU sets --max-cpu-percent. Resolved at spawn in
  // main.js via electron/resource-limits.js.
  const renderResourceLimits = () => (
    <>
      <p className="text-[10px] text-muted-foreground -mt-1 mb-2">
        Cap how hard downloads and search push your machine. An active limit{" "}
        <strong>overrides</strong> the matching knobs below while it's set — choose{" "}
        <span className="font-mono">Unlimited</span> to tune them by hand.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {/* Max network usage → image-concurrency family + search parallelism */}
        <div>
          <Label className="text-xs flex items-center gap-1.5">
            <Network className="w-3 h-3" /> Max network usage
          </Label>
          <Select
            value={local.networkLimit ?? "unlimited"}
            onChange={(e) => set("networkLimit", e.target.value)}
            className="mt-1"
          >
            {NETWORK_LEVELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          <p className="text-[10px] text-muted-foreground mt-1 leading-snug min-h-[2.2em]">
            {networkPreviewText(local.networkLimit) ? (
              <span className="font-mono">{networkPreviewText(local.networkLimit)}</span>
            ) : (
              "Full speed — the download & search knobs below apply."
            )}
          </p>
        </div>
        {/* Max CPU usage → --max-cpu-percent (modernize / recompress / encode pools) */}
        <div>
          <Label className="text-xs flex items-center gap-1.5">
            <Cpu className="w-3 h-3" /> Max CPU usage
          </Label>
          <Select
            value={local.cpuLimit ?? "unlimited"}
            onChange={(e) => set("cpuLimit", e.target.value)}
            className="mt-1"
          >
            {CPU_LEVELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          <p className="text-[10px] text-muted-foreground mt-1 leading-snug min-h-[2.2em]">
            {cpuPreviewText(local.cpuLimit)
              ? `${cpuPreviewText(local.cpuLimit)} for image processing (modernize, recompress, encode).`
              : "Full speed — image processing uses about half your cores."}
          </p>
        </div>
      </div>
    </>
  );

  // ── Network & Speed › Network Settings ──
  const renderNetworkBasic = () => (
    <div className="grid grid-cols-3 gap-3">
      <div>
        <Label className="text-xs flex items-center gap-1">
          Image Workers{netManaged && <ManagedLock />}
        </Label>
        <Input
          type="number"
          min={1}
          max={10}
          step={1}
          // When a Max-network preset is active, show the EFFECTIVE value
          // that will run (networkEffective) and disable editing; the stored
          // manual value is preserved and restored on Unlimited.
          value={netManaged
            ? networkEffective(local.networkLimit, "imageWorkers", local.defaults.imageWorkers)
            : local.defaults.imageWorkers}
          disabled={netManaged}
          onChange={(e) => {
            // Number("") returns 0; argparse would crash on 0 for
            // a "min=1" field. Truncate to int and clamp into the
            // [min, max] range; fall back to a sensible default
            // when the parse can't yield a finite value.
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) { setDefault("imageWorkers", 3); return; }
            setDefault("imageWorkers", Math.min(10, Math.max(1, Math.trunc(v))));
          }}
          className={cn("mt-1", netManaged && "opacity-60")}
        />
      </div>
      <div>
        <Label className="text-xs">HTTP Timeout</Label>
        <Input
          type="number"
          min={5}
          step={1}
          value={local.defaults.httpTimeout}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v) || v < 5) { setDefault("httpTimeout", 30); return; }
            setDefault("httpTimeout", Math.trunc(v));
          }}
          className="mt-1"
        />
      </div>
      <div>
        <Label className="text-xs">Max Retries</Label>
        <Input
          type="number"
          min={0}
          step={1}
          value={local.defaults.httpMaxRetries}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v) || v < 0) { setDefault("httpMaxRetries", 6); return; }
            setDefault("httpMaxRetries", Math.trunc(v));
          }}
          className="mt-1"
        />
      </div>
    </div>
  );

  // ── Network & Speed › Image Prefetch & Concurrency ──
  // Tuning for the curl_cffi fast image-download path (MangaFire + LINE
  // Webtoon today). The first three knobs are hard-overridden by an active
  // Max-network preset — one banner explains it for the whole section. The
  // "prefetch workers for next chapter" knob was moved here 2026-07-05 from
  // the old Chapter Behavior section; unlike the three above it is NOT
  // network-managed, so it stays editable under a Max-network preset.
  const renderPrefetch = () => (
    <>
      <p className="text-[10px] text-muted-foreground -mt-1 mb-2">
        Tuning for the curl_cffi fast image-download path (used by MangaFire
        and LINE Webtoon today). Auto-dials concurrency down per-host on
        CDN errors. Sites without fast-download support still use Image
        Workers above.
      </p>
      {netManaged && (
        <div className="mb-2">
          <ManagedBanner level={local.networkLimit} />
        </div>
      )}
      <div className="space-y-3">
        {/* Image concurrency for the curl_cffi async fetcher. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <Label className="text-xs cursor-pointer flex items-center gap-1">
              Image concurrency{netManaged && <ManagedLock />}
            </Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Concurrent in-flight image fetches via HTTP/2 multiplex. Default
              {" "}<span className="font-mono">8</span> hits ~5 MB/s — typical home-network ceiling.
              Past <span className="font-mono">12</span> is diminishing returns. Drop to
              {" "}<span className="font-mono">3</span> if a CDN starts rate-limiting (rare on
              cookieless edge caches, but defensive). Auto-dials down on
              rate-limit / 5xx errors during a download.
            </p>
          </div>
          {/* Python's --image-concurrency is argparse type=int; IntInput
              truncates + clamps [1,32] (empty/invalid → 8, the default). */}
          <IntInput
            value={netManaged
              ? networkEffective(local.networkLimit, "imageConcurrency", local.imageConcurrency ?? 8)
              : (local.imageConcurrency ?? 8)}
            onChange={(v) => set("imageConcurrency", v)}
            min={1}
            max={32}
            fallback={8}
            disabled={netManaged}
            className={cn("w-20 shrink-0 font-mono tabular-nums", netManaged && "opacity-60")}
          />
        </div>

        {/* Image prefetch depth. 0 disables prefetch entirely. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <Label className="text-xs cursor-pointer flex items-center gap-1">
              Prefetch depth{netManaged && <ManagedLock />}
            </Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              How many chapters ahead to keep queued for image prefetch.
              Default <span className="font-mono">2</span> means ~one extra chapter
              buffered while the main loop processes the current one.
              Higher helps when main-loop work is fast vs network download
              (e.g. CBZ fast-path on LINE Webtoon).
              {" "}<span className="font-mono">0</span> disables prefetch entirely.
            </p>
          </div>
          {/* clampLow=false: a below-0 entry resets to the default (2)
              rather than clamping — matches the original v<0 guard. */}
          <IntInput
            value={netManaged
              ? networkEffective(local.networkLimit, "imagePrefetchDepth", local.imagePrefetchDepth ?? 2)
              : (local.imagePrefetchDepth ?? 2)}
            onChange={(v) => set("imagePrefetchDepth", v)}
            min={0}
            max={8}
            fallback={2}
            clampLow={false}
            disabled={netManaged}
            className={cn("w-20 shrink-0 font-mono tabular-nums", netManaged && "opacity-60")}
          />
        </div>

        {/* Concurrent prefetch worker threads. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <Label className="text-xs cursor-pointer flex items-center gap-1">
              Prefetch workers in parallel{netManaged && <ManagedLock />}
            </Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Concurrent prefetch worker threads. Default
              {" "}<span className="font-mono">2</span> = up to 2 chapters downloading at
              once while the main thread processes a third. <span className="font-mono">1</span> =
              legacy single-in-flight behavior. Total concurrent connections
              per host ≈ this × image concurrency. Webtoons.com and
              MangaFire's edge cache tolerate 2 well in practice.
            </p>
          </div>
          {/* clampLow=false: a below-1 entry resets to the default (2)
              rather than clamping — matches the original v<1 guard. */}
          <IntInput
            value={netManaged
              ? networkEffective(local.networkLimit, "imagePrefetchParallel", local.imagePrefetchParallel ?? 2)
              : (local.imagePrefetchParallel ?? 2)}
            onChange={(v) => set("imagePrefetchParallel", v)}
            min={1}
            max={4}
            fallback={2}
            clampLow={false}
            disabled={netManaged}
            className={cn("w-20 shrink-0 font-mono tabular-nums", netManaged && "opacity-60")}
          />
        </div>

        {/* Inter-chapter image prefetch — Phase G7. Moved here 2026-07-05
            from the old "Chapter Behavior" section: it's a prefetch/
            concurrency knob, not a chapter-collapse one. NOT network-managed —
            unlike the three knobs above it stays editable under an active
            Max-network preset (no ManagedLock). */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <Label className="text-xs cursor-pointer">Prefetch workers for next chapter</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Background workers that download chapter N+1's images while
              chapter N is encoding. <span className="font-mono">-1</span> = match Image Workers (default). <span className="font-mono">0</span> =
              disable prefetch entirely. Positive number = exact worker count. Drop to
              4 (or 0) when the upstream CDN is rate-limiting (Cloudflare 5xx storms)
              — the extra concurrent burst from N+1 can compound throttling. Typically
              saves 2-5s per chapter on MangaFire-style long-strip encodes when on.
            </p>
          </div>
          {/* The Python --prefetch-image-workers flag is argparse type=int;
              IntInput truncates + clamps so a decimal never round-trips to
              settings.json and crashes the next spawn. -1 = match Image
              Workers; below -1 clamps up (clampLow default). */}
          <IntInput
            value={local.prefetchImageWorkers ?? -1}
            onChange={(v) => set("prefetchImageWorkers", v)}
            min={-1}
            max={32}
            fallback={-1}
            className="w-20 shrink-0 font-mono tabular-nums"
          />
        </div>

        {/* Force-disable curl_cffi escape hatch. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <Label className="text-xs cursor-pointer">
              Force-disable fast download path
            </Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Escape hatch — when on, ALL handlers fall back to the legacy
              ThreadPoolExecutor + cloudscraper path regardless of their
              per-handler SUPPORTS_FAST_DOWNLOAD flag. Useful for curl_cffi
              version regressions or weird CDN-vs-impersonation issues.
              Off by default; only flip on when troubleshooting.
            </p>
          </div>
          <Switch
            checked={!!local.noFastDownload}
            onCheckedChange={(v) => set("noFastDownload", v)}
          />
        </div>
      </div>

      {/* MangaFire VRF capture knobs (--mangafire-vrf-prefetch-depth,
          --mangafire-vrf-parallel) were removed from the UI on
          2026-05-13. They're advanced Patchright/Cloudflare tuning
          most users shouldn't touch; the argparse defaults (depth=4,
          parallel=1) are bench-good. Advanced users can still pass
          the CLI flags directly. */}
    </>
  );

  // ── Network & Speed › Multi-source Fallback ──
  const renderMultiSource = () => (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <Switch
          checked={!!local.defaults.multiSource}
          onCheckedChange={(v) =>
            // Enabling multi-source force-resets the nested lazy toggle
            // to ON (opt-out inside the opt-in): a previous opt-out
            // shouldn't survive a fresh opt-in. One combined update so
            // both fields land in the same render.
            setLocal((prev) => ({
              ...prev,
              defaults: {
                ...prev.defaults,
                multiSource: v,
                ...(v ? { multiSourceLazy: true } : {}),
              },
            }))
          }
          className="mt-0.5"
        />
        <div className="flex-1">
          <Label className="text-xs cursor-pointer">
            Use alternate sources when the primary fails
          </Label>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            When the primary CDN throttles or 404s a page, the chapter
            falls over to the next source automatically.
          </p>
        </div>
      </div>
      {local.defaults.multiSource && (
        <div className="pl-12 animate-slide-up space-y-3">
          {/* Lazy discovery — opt-out nested in the multi-source opt-in.
              Absent-means-on everywhere (`!== false`): older saved
              settings dicts without the field behave as ON, and the
              master switch above force-resets it to true on enable.
              Applies to EVERY multi-source download (New tab, Search,
              Library update checks) via the downloader.js chokepoint;
              search-driven downloads with a prefetched payload ignore
              it (Python reads the prefetched JSON eagerly — cheap). */}
          <div className="flex items-start gap-3">
            <Switch
              checked={local.defaults.multiSourceLazy !== false}
              onCheckedChange={(v) => setDefault("multiSourceLazy", v)}
              className="mt-0.5"
            />
            <div className="flex-1">
              <Label className="text-xs cursor-pointer">
                Only search alternatives after a chapter fails (recommended)
              </Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                <strong>On:</strong> downloads start immediately; the ~30-80s
                cross-site discovery only runs if a chapter actually needs a
                fallback — for a 1-5 chapter update it usually costs more than
                the whole download. <strong>Off:</strong> discover up front:
                slower start, but split-collapse gets cross-source consensus
                and ghost detection has alignment data from chapter one.
              </p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-xs">Alternative quality floor</Label>
              <Badge variant="secondary" className="font-mono tabular-nums">
                {(local.defaults.multiSourceQualityMin ?? 0.65).toFixed(2)}
              </Badge>
            </div>
            <Slider
              value={local.defaults.multiSourceQualityMin ?? 0.65}
              onValueChange={(v) => setDefault("multiSourceQualityMin", v)}
              min={0.3}
              max={0.95}
              step={0.05}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Sources below this seed/measured quality won't be used as
              fallbacks. Default 0.65 keeps unknown-language Madara extras out.
            </p>
          </div>
        </div>
      )}
    </div>
  );

  // ── Metadata › AniList Enrichment ──
  // Opt-in global setting — when on, every download spawn injects
  // --metadata-source anilist. The two sub-options only emit on spawn when
  // source !== "none" AND the value differs from Python argparse defaults.
  const renderMetadata = () => (
    <>
      <p className="text-[10px] text-muted-foreground -mt-1 mb-2 leading-snug">
        Pull normalized tags, descriptions, and country/format from the free{" "}
        <a
          href="https://anilist.co"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          AniList GraphQL API
        </a>{" "}
        (90 req/min, no auth, no account). Results merge into{" "}
        <span className="font-mono">ComicInfo.xml</span> and{" "}
        <span className="font-mono">.aio_series.json</span> on every download —
        ID-cached so resume / update runs do a single fetch-by-id instead of
        re-searching. Off by default; opt in if you want filterable, ranked,
        spoiler-aware tags in your reader.
      </p>
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <Switch
            checked={local.metadataSource === "anilist"}
            onCheckedChange={(v) => set("metadataSource", v ? "anilist" : "none")}
            className="mt-0.5"
          />
          <div className="flex-1">
            <Label className="text-xs cursor-pointer">
              Enable AniList enrichment
            </Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Adds 1 GraphQL round-trip per series (first download) or 1
              fetch-by-id (cached afterwards). Failures are non-fatal — the
              download continues with site-only metadata and logs a single
              warning line.
            </p>
          </div>
        </div>
        {local.metadataSource === "anilist" && (
          <div className="pl-12 animate-slide-up space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-xs">Tag relevance threshold</Label>
                <Badge variant="secondary" className="font-mono tabular-nums">
                  {local.metadataTagMinRank ?? 50}
                </Badge>
              </div>
              <Slider
                value={local.metadataTagMinRank ?? 50}
                onValueChange={(v) => set("metadataTagMinRank", v)}
                min={0}
                max={100}
                step={5}
              />
              <div className="flex justify-between mt-1 px-0.5">
                <span className="text-[10px] text-muted-foreground">
                  0 — every tag
                </span>
                <span className="text-[10px] text-muted-foreground">
                  50 — default
                </span>
                <span className="text-[10px] text-muted-foreground">
                  100 — only top-rank
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                AniList scores each tag <span className="font-mono">0–100</span> by
                relevance. Tags below this floor are dropped from{" "}
                <span className="font-mono">{"<Tags>"}</span> /{" "}
                <span className="font-mono">{"<SpoilerTags>"}</span> /{" "}
                <span className="font-mono">{"<TagsExtended>"}</span> in the
                ComicInfo.xml. At <span className="font-mono">50</span> a typical
                manga has ~15–25 tags; at <span className="font-mono">80</span>{" "}
                ~3–6 tags.
              </p>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <Label className="text-xs cursor-pointer">
                  Always re-fetch (skip the AniList ID cache)
                </Label>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Force a fresh AniList lookup on every download — even when
                  an AniList ID is already cached in{" "}
                  <span className="font-mono">.aio_series.json</span>. Useful
                  when backfilling a library or after AniList re-tags a
                  series upstream. Costs one extra round-trip per download;
                  leave off unless you specifically need fresh data.
                </p>
              </div>
              <Switch
                checked={!!local.metadataRefresh}
                onCheckedChange={(v) => set("metadataRefresh", v)}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );

  // ── Search › Search Options ──
  // Same settings.searchOpts namespace SearchTab reads/writes; the two surfaces
  // stay in sync on every change.
  const renderSearch = () => (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
      <div>
        <Label className="text-xs">Search language</Label>
        <Select
          value={local.searchOpts?.searchLanguage ?? "en"}
          onChange={(e) => setSearchOpt("searchLanguage", e.target.value)}
          className="mt-1"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </Select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          <Label className="text-xs cursor-pointer">Curated sites only</Label>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            ~3× faster; skips long-tail aggregators
          </p>
        </div>
        <Switch
          checked={!!local.searchOpts?.seededOnly}
          onCheckedChange={(v) => setSearchOpt("seededOnly", v)}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          <Label className="text-xs cursor-pointer">Multi-source by default</Label>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Pre-fetch alternative sources when searching
          </p>
        </div>
        <Switch
          checked={!!local.searchOpts?.multiSource}
          onCheckedChange={(v) => setSearchOpt("multiSource", v)}
        />
      </div>
      {local.searchOpts?.multiSource && (
        <div className="col-span-2 animate-slide-up">
          <div className="flex items-center justify-between mb-1">
            <Label className="text-xs">Search alternative quality floor</Label>
            <Badge variant="secondary" className="font-mono tabular-nums">
              {(local.searchOpts?.multiSourceQualityMin ?? 0.65).toFixed(2)}
            </Badge>
          </div>
          <Slider
            value={local.searchOpts?.multiSourceQualityMin ?? 0.65}
            onValueChange={(v) => setSearchOpt("multiSourceQualityMin", v)}
            min={0.3}
            max={0.95}
            step={0.05}
          />
        </div>
      )}
      <div>
        <Label className="text-xs">Per-site timeout (s)</Label>
        <Input
          type="number"
          min={5}
          max={60}
          value={local.searchOpts?.searchTimeout ?? 20}
          onChange={(e) => setSearchOpt("searchTimeout", Number(e.target.value) || 20)}
          className="mt-1"
        />
      </div>
      <div>
        <Label className="text-xs">Min title-match</Label>
        <Input
          type="number"
          min={0.3}
          max={1.0}
          step={0.05}
          value={local.searchOpts?.searchMinMatch ?? 0.55}
          onChange={(e) => setSearchOpt("searchMinMatch", Number(e.target.value) || 0.55)}
          className="mt-1 font-mono"
        />
      </div>
      <div>
        <Label className="text-xs flex items-center gap-1">
          Parallel sites{netManaged && <ManagedLock />}
        </Label>
        <Input
          type="number"
          min={1}
          max={16}
          // Hard-overridden by an active Max-network preset (main.js caps
          // --search-parallelism at spawn); show the effective value + lock.
          value={netManaged
            ? networkEffective(local.networkLimit, "searchParallelism", local.searchOpts?.searchParallelism ?? 6)
            : (local.searchOpts?.searchParallelism ?? 6)}
          disabled={netManaged}
          onChange={(e) => setSearchOpt("searchParallelism", Number(e.target.value) || 6)}
          className={cn("mt-1", netManaged && "opacity-60")}
        />
      </div>
    </div>
  );

  // ── Library › Library & Update Checks ──
  const renderLibrary = () => (
    <>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={local.useFileBasedChapterCheck ?? false}
          onCheckedChange={(v) => set("useFileBasedChapterCheck", v)}
        />
        <Label className="text-xs cursor-pointer">
          Check chapters against files on device (instead of download history)
        </Label>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 ml-6">
        <strong>Off (default):</strong> Uses the saved download history (.aio_series.json) to
        know which chapters you have. Faster, but won't notice deleted files.
        <br />
        <strong>On:</strong> Scans your actual files and extracts chapter numbers from filenames.
        Catches missing or deleted files, but only works with individual chapter files
        or combined files with chapter ranges in the name.
      </p>

      {/* ── Check All — include "Completed" series ──
          Aggregators (mangafire most notoriously) routinely mis-label
          ongoing series as "Completed". Defaulting this ON gives a
          forgiving scan that catches mislabeled series; opt out only if
          your library lives on reliable status sources (MangaDex etc.)
          AND you want to save a few seconds per scan. */}
      <div className="flex items-center gap-2 mt-4">
        <Checkbox
          checked={local.checkAllIncludeCompleted !== false}
          onCheckedChange={(v) => set("checkAllIncludeCompleted", v)}
        />
        <Label className="text-xs cursor-pointer">
          Check "Completed" series too (recommended)
        </Label>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 ml-6">
        <strong>On (default):</strong> "Check All" scans every series with a saved URL, regardless
        of status. Catches the very common case where a site (mangafire, etc.) wrongly
        marks an ongoing series as Completed.
        <br />
        <strong>Off:</strong> Only scans series whose status is Ongoing or Releasing.
        Faster, but misses mislabeled series.
      </p>

      {/* ── Check All — parallel worker count ──
          Capped to [1, 8] in main.js. 4 is the safe sweet spot for typical
          libraries; the provider-aware scheduler fans across distinct
          sites at that count. Drop to 2 only if your library hits one
          site heavily and you see throttling; bump to 6-8 only if scans
          consistently bottleneck on a single site's per-request latency. */}
      <div className="flex items-center gap-3 mt-4">
        <Label className="text-xs whitespace-nowrap">
          Parallel checks
        </Label>
        <Input
          type="number"
          min={1}
          max={8}
          value={local.checkAllConcurrency ?? 4}
          onChange={(e) =>
            set(
              "checkAllConcurrency",
              Math.max(1, Math.min(8, Number(e.target.value) || 4))
            )
          }
          className="w-20 font-mono"
        />
        <Badge variant="secondary" className="text-[10px]">
          1–8
        </Badge>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">
        How many series the "Check All" sweep checks at the same time. Workers prefer
        jobs on different sites so no single CDN gets hammered. Default 4.
      </p>

      {/* ── Update-check downloads: skip image-quality probe ──
          Multi-source ranks alternatives by running an image-quality probe
          (download sample images, score them). On MangaFire-class handlers
          the probe burns ~30-60+ s per series. For a 1-5 chapter update
          delta that probe cost dwarfs the actual download. With this on
          (default), the multi-source picker uses sites/quality_seed.json
          priors as the ranking signal instead of running the probe. The
          picker's tiebreaker logic ALREADY falls back to the seed when
          probe scores are equal, so the seed-only mode is a "trust the
          curated priors" shortcut. Only affects downloads queued from
          the UpdatesCenter; regular New-tab downloads still get full
          probe accuracy. */}
      <div className="flex items-center gap-2 mt-4">
        <Checkbox
          checked={local.updateChecksUseSeededRating !== false}
          onCheckedChange={(v) => set("updateChecksUseSeededRating", v)}
        />
        <Label className="text-xs cursor-pointer">
          Update-check downloads use fast seed-based rating (recommended)
        </Label>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 ml-6">
        <strong>On (default):</strong> Downloads queued from the Updates Center skip the
        multi-source image-quality probe (which runs Playwright + per-source image scoring
        and adds ~30-60+ seconds per series). Ranking falls back to the curated quality
        priors in <code className="font-mono text-[9px]">sites/quality_seed.json</code>.
        For a typical 1-5 chapter update delta the probe takes ~10× longer than the
        actual download.
        <br />
        <strong>Off:</strong> Update-check downloads run the full probe like any other
        multi-source download. More accurate per-source ranking; significantly slower.
      </p>
    </>
  );

  // ── SECTIONS registry ──
  // Flat list in nav order. `group` keys into CATEGORIES; `title` is the
  // <SectionHeader> text; `render` is the closure above. To add a section:
  // write a render* closure and add one line here — the left-nav count badge
  // and pane routing derive from this array automatically.
  const SECTIONS = [
    { group: "general",     title: "Paths & Python",                render: renderPaths },
    { group: "general",     title: "Logging",                       render: renderLogging },
    { group: "output",      title: "Format & Quality",              render: renderFormat },
    { group: "output",      title: "Komikku Output",                render: renderKomikku },
    { group: "output",      title: "Chapter Behavior",              render: renderChapters },
    { group: "output",      title: "Processing Toggles",            render: renderToggles },
    { group: "compression", title: "Modernize (JXL / AVIF)",        render: renderModernize },
    { group: "compression", title: "LINE Webtoon Recompress",       render: renderWebtoon },
    { group: "network",     title: "Resource Limits",               render: renderResourceLimits },
    { group: "network",     title: "Network Settings",              render: renderNetworkBasic },
    { group: "network",     title: "Image Prefetch & Concurrency",  render: renderPrefetch },
    { group: "network",     title: "Multi-source Fallback",         render: renderMultiSource },
    { group: "metadata",    title: "AniList Enrichment",            render: renderMetadata },
    { group: "search",      title: "Search Options",                render: renderSearch },
    { group: "library",     title: "Library & Update Checks",       render: renderLibrary },
  ];

  const activeCat = CATEGORIES.find((c) => c.id === activeCategory) || CATEGORIES[0];
  const activeSections = SECTIONS.filter((s) => s.group === activeCat.id);
  const ActiveIcon = activeCat.icon;

  return (
    <div className="flex flex-col h-full">
      {/* Two-pane body: left category nav + right active-category pane.
          `min-h-0 overflow-hidden` bounds the row so each pane scrolls
          independently under the pinned footer. */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* ── Left category nav ──
            Fluid width: shrinks on narrow windows, grows modestly on wide ones,
            clamped so the longest label ("Network & Speed") never wraps and it
            never dominates a big window. Was a hard 236px (felt oversized). */}
        <nav
          className="shrink-0 border-r overflow-y-auto py-3 px-2"
          style={{ width: "clamp(176px, calc(144px + 3vw), 208px)" }}
        >
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = cat.id === activeCategory;
            const count = SECTIONS.filter((s) => s.group === cat.id).length;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCategory(cat.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 w-full text-left rounded-lg px-2 py-[7px] mb-0.5 transition-colors",
                  isActive
                    ? "bg-primary/[0.12] text-primary"
                    : "text-foreground hover:bg-accent/50"
                )}
              >
                {/* Active left indicator bar — matches the App.jsx rail. */}
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-primary" />
                )}
                <span className={cn(
                  "flex items-center justify-center w-[26px] h-[26px] rounded-md shrink-0 transition-colors",
                  isActive ? "bg-primary/[0.18] text-primary" : "bg-secondary text-foreground"
                )}>
                  <Icon className="w-[14px] h-[14px]" />
                </span>
                {/* min-w-0 + truncate so a long label ellipsizes instead of
                    wrapping/overflowing if the fluid width bottoms out. */}
                <span className="flex-1 min-w-0 truncate text-[13px] font-semibold">{cat.navLabel || cat.label}</span>
                <span className={cn(
                  "text-[10px] tabular-nums shrink-0",
                  isActive ? "text-primary/80" : "text-muted-foreground"
                )}>
                  {count}
                </span>
              </button>
            );
          })}
        </nav>

        {/* ── Right pane: header + the active category's sections ── */}
        <div className="flex-1 min-w-0 overflow-y-auto px-[26px] pt-5 pb-7">
          <div className="max-w-[760px]">
            {/* Pane head — category title + icon tile + one-line description.
                Replaces the per-category name the old flat scroll never had;
                the app-level topbar (App.jsx) still shows "Settings". */}
            <div className="mb-1">
              <h2 className="flex items-center gap-[11px] text-[19px] font-bold tracking-[-0.01em]">
                <span className="flex items-center justify-center w-[34px] h-[34px] rounded-[9px] bg-primary/[0.12] text-primary shrink-0">
                  <ActiveIcon className="w-[19px] h-[19px]" />
                </span>
                {activeCat.label}
              </h2>
              <p className="mt-2 text-[12.5px] text-muted-foreground">{activeCat.desc}</p>
            </div>

            {/* Each section: its <SectionHeader> (from the registry title)
                then the section's controls. Only the active category's
                sections mount; edits persist in `local` across nav switches. */}
            {activeSections.map((s) => (
              <React.Fragment key={s.title}>
                <SectionHeader>{s.title}</SectionHeader>
                {s.render()}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Save/Reset buttons. SaveSettingsButton (defined above) carries
          its own dirty-state visual + post-save sweep + error branch;
          the Reset stays a plain outline Button. Pinned full-width under
          both panes so Save is reachable from every category. */}
      <div className="flex-shrink-0 p-4 border-t bg-background/80 backdrop-blur-sm flex gap-2">
        <SaveSettingsButton dirty={dirty} onSave={handleSave} />
        <Button variant="outline" onClick={handleReset}>
          <RotateCcw className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
