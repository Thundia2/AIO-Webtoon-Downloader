import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Button, Input, Badge } from "@/components/ui/primitives";
import {
  Search,
  RefreshCw,
  BookOpen,
  FolderOpen,
  Trash2,
  FileText,
  ArrowLeft,
  ArrowUpDown,
  Download,
  ExternalLink,
  Globe,
  Bell,
  Loader2,
  AlertCircle,
  Link,
  User,
  Tag,
  PencilLine,
  Save,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Convert a Windows file path to a localfile:// URL the renderer can load.
function fileToUrl(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, "/");
  return "localfile:///" + encodeURI(normalized);
}

// ── CONFIGURABLE ──
const FORMAT_COLORS = {
  pdf: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  epub: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  cbz: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

const STATUS_COLORS = {
  Ongoing: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  Releasing: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  Completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
  Finished: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
};

const SORT_OPTIONS = [
  { value: "title", label: "Title A→Z" },
  { value: "title-desc", label: "Title Z→A" },
  { value: "date", label: "Newest first" },
  { value: "date-asc", label: "Oldest first" },
  { value: "size", label: "Largest first" },
  { value: "size-asc", label: "Smallest first" },
];

// ============================================================
// HELPERS
// ============================================================
function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function formatDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function getFormats(files) {
  return [...new Set(files.map((f) => f.ext))];
}

/**
 * Turn ["51","52","53","55","60"] into "51-53, 55, 60"
 */
function chaptersToRangeString(chapters) {
  if (!chapters || chapters.length === 0) return "";
  const nums = chapters.map(Number).sort((a, b) => a - b);
  const ranges = [];
  let start = nums[0], end = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] - end <= 1.001) {
      end = nums[i];
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = nums[i];
      end = nums[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(", ");
}

// ============================================================
// PDF COVER THUMBNAIL
// ============================================================
function PdfCover({ entry }) {
  if (entry.thumbPath) {
    return (
      <img
        src={fileToUrl(entry.thumbPath)}
        alt={entry.title}
        className="w-full h-full object-cover rounded"
        loading="lazy"
      />
    );
  }
  if (entry.coverPdfPath) {
    return <div className="w-full h-full bg-muted animate-pulse rounded" />;
  }
  const initials = entry.title
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase();
  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5 rounded">
      <span className="text-2xl font-bold text-primary/60">{initials}</span>
    </div>
  );
}

// ============================================================
// MANGA CARD (grid item)
// ============================================================
function MangaCard({ entry, newCount, onClick }) {
  const formats = getFormats(entry.files);
  const status = entry.seriesMeta?.status;

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex flex-col rounded-lg overflow-hidden text-left",
        "bg-card/60 border border-border/50",
        "hover:border-primary/40 hover:bg-card/80",
        "transition-all duration-150 cursor-pointer",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      )}
    >
      {/* Cover with overlay badges */}
      <div className="aspect-[3/4] w-full overflow-hidden bg-muted/30 relative">
        <PdfCover entry={entry} />

        {/* Status badge (top-left) */}
        {status && (
          <span
            className={cn(
              "absolute top-1.5 left-1.5 text-[8px] font-bold uppercase px-1.5 py-0.5 rounded border backdrop-blur-sm",
              STATUS_COLORS[status] || "bg-muted/80 text-muted-foreground border-border"
            )}
          >
            {status}
          </span>
        )}

        {/* New chapters badge (top-right) */}
        {newCount > 0 && (
          <span className="absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/90 text-white shadow-sm">
            {newCount} new
          </span>
        )}
      </div>

      {/* Info area */}
      <div className="p-2.5 flex flex-col gap-1 min-w-0">
        <h3 className="text-xs font-semibold leading-tight truncate" title={entry.title}>
          {entry.title}
        </h3>
        <div className="flex gap-1 flex-wrap">
          {formats.map((fmt) => (
            <span
              key={fmt}
              className={cn(
                "text-[8px] font-bold uppercase px-1.5 py-0.5 rounded border",
                FORMAT_COLORS[fmt] || "bg-muted text-muted-foreground border-border"
              )}
            >
              {fmt}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
          <span>{formatSize(entry.totalSize)}</span>
          <span>&middot;</span>
          <span>{entry.files.length} file{entry.files.length !== 1 ? "s" : ""}</span>
          {entry.chapterCount > 0 && (
            <>
              <span>&middot;</span>
              <span>{entry.chapterCount} ch</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

// ============================================================
// UPDATE CHECKER SECTION (inside detail view)
// ============================================================
function UpdateSection({ entry, onStartDownload, onSwitchTab, settings }) {
  const meta = entry.seriesMeta;
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [manualUrl, setManualUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const res = await window.electronAPI.checkForUpdates(entry.folderPath);
      if (res.error) {
        setError(res.message || res.error);
      } else {
        setResult(res);
      }
    } catch (err) {
      setError(err.message || "Check failed");
    }
    setChecking(false);
  };

  const handleDownloadNew = () => {
    if (!result?.newChapters?.length || !meta?.url) return;
    const rangeStr = chaptersToRangeString(result.newChapters);

    // Start with the user's saved default settings from the Settings tab,
    // then override format/language/site from the series metadata and set
    // the chapter range to only the missing ones.
    const d = settings?.defaults || {};
    const args = {
      format: meta.format || d.format || "pdf",
      quality: d.quality ?? 85,
      chapters: rangeStr,
      language: meta.language || "en",
      site: meta.site || undefined,
      verbose: settings?.verboseAlways ?? true,
    };

    // Apply all the same toggles that DownloadTab uses
    if (d.scaling && d.scaling !== 100) args.scaling = d.scaling;
    if (d.keepChapters) args.keepChapters = true;
    if (d.noFinalFile) args.noFinalFile = true;
    if (d.keepImages) args.keepImages = true;
    if (d.noProcessing) args.noProcessing = true;
    if (d.noCleanup) args.noCleanup = true;
    if (d.imageWorkers && d.imageWorkers !== 3) args.imageWorkers = d.imageWorkers;
    if (d.httpTimeout && d.httpTimeout !== 30) args.httpTimeout = d.httpTimeout;
    if (d.httpMaxRetries && d.httpMaxRetries !== 6) args.httpMaxRetries = d.httpMaxRetries;

    onStartDownload(meta.url, args);
    onSwitchTab("queue");
  };

  const handleSaveUrl = async () => {
    if (!manualUrl.trim()) return;
    setSaving(true);
    try {
      const res = await window.electronAPI.saveSeriesMeta(entry.folderPath, {
        url: manualUrl.trim(),
        title: entry.title,
      });
      if (res.ok) {
        // Mutate the entry's seriesMeta so the UI refreshes immediately
        entry.seriesMeta = res.meta;
        setManualUrl("");
      } else {
        setError(res.error || "Failed to save");
      }
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  // ── No metadata: show manual URL entry ──
  if (!meta?.url) {
    return (
      <div className="rounded-lg border border-border/50 bg-card/30 p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>No source URL saved. Enter it to enable update checking.</span>
        </div>
        <div className="flex gap-2">
          <Input
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="https://mangafire.to/manga/..."
            className="h-8 text-xs flex-1"
          />
          <Button
            size="sm"
            onClick={handleSaveUrl}
            disabled={saving || !manualUrl.trim()}
            className="text-xs gap-1.5 shrink-0"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link className="w-3 h-3" />}
            Save
          </Button>
        </div>
        {error && <p className="text-[10px] text-destructive">{error}</p>}
      </div>
    );
  }

  // ── Has metadata: show update check UI ──
  return (
    <div className="rounded-lg border border-border/50 bg-card/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Globe className="w-3.5 h-3.5" />
          <span className="truncate max-w-[280px]" title={meta.url}>
            {meta.site || "unknown"}
          </span>
          {meta.chapters_downloaded?.length > 0 && (
            <>
              <span>&middot;</span>
              <span>{meta.chapters_downloaded.length} ch downloaded</span>
            </>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheck}
          disabled={checking}
          className="text-xs gap-1.5 shrink-0"
        >
          {checking
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <RefreshCw className="w-3 h-3" />}
          {checking ? "Checking…" : "Check for Updates"}
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          {result.newChapters.length > 0 ? (
            <div className="rounded-md border border-orange-500/30 bg-orange-500/10 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-orange-400">
                  {result.newChapters.length}
                  {result.checkMode === "files"
                    ? ` chapter${result.newChapters.length !== 1 ? "s" : ""} missing from device`
                    : ` new chapter${result.newChapters.length !== 1 ? "s" : ""} available`}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {result.downloaded} / {result.total} total
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Chapters: {chaptersToRangeString(result.newChapters)}
              </p>
              <Button size="sm" onClick={handleDownloadNew} className="text-xs gap-1.5 w-full">
                <Download className="w-3 h-3" />
                Download Missing Chapters
              </Button>
              {/* Mode indicator */}
              <p className="text-[9px] text-muted-foreground/60 text-right">
                Checked via {result.checkMode === "files" ? "file scan" : "download history"}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <span>&#10003;</span>
              <span>
                Up to date ({result.total} on site, {result.downloaded} on device)
              </span>
              <span className="text-[9px] text-muted-foreground/60 ml-auto">
                via {result.checkMode === "files" ? "file scan" : "history"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// DETAIL VIEW
// ============================================================
function MetadataEditorPanel({ entry, onClose, onSaved }) {
  const editableFiles = entry.files.filter((f) => ["cbz", "epub", "pdf"].includes(f.ext));
  const primaryFile = editableFiles[0];
  const [form, setForm] = useState({
    title: entry.title || "",
    writers: "",
    pencillers: "",
    genres: "",
    publisher: "",
    synopsis: "",
  });
  const [coverPath, setCoverPath] = useState("");
  const [applyAll, setApplyAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!primaryFile || !window.electronAPI?.readMetadata) return;
      setBusy(true);
      setError(null);
      try {
        const metadata = await window.electronAPI.readMetadata(primaryFile.path);
        if (!cancelled && metadata) {
          setForm((prev) => ({
            ...prev,
            ...metadata,
            writers: Array.isArray(metadata.writers) ? metadata.writers.join(", ") : (metadata.writers || ""),
            pencillers: Array.isArray(metadata.pencillers) ? metadata.pencillers.join(", ") : (metadata.pencillers || ""),
            genres: Array.isArray(metadata.genres) ? metadata.genres.join(", ") : (metadata.genres || ""),
          }));
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not read metadata");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [primaryFile?.path]);

  const updateField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handlePickCover = async () => {
    const picked = await window.electronAPI?.pickFile?.([
      { name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] },
    ]);
    if (picked) setCoverPath(picked);
  };

  const handleSave = async () => {
    if (!primaryFile || !window.electronAPI?.updateMetadata) return;
    setBusy(true);
    setError(null);
    const payload = {
      ...form,
      writers: form.writers.split(",").map((s) => s.trim()).filter(Boolean),
      pencillers: form.pencillers.split(",").map((s) => s.trim()).filter(Boolean),
      genres: form.genres.split(",").map((s) => s.trim()).filter(Boolean),
    };
    try {
      const targets = applyAll ? editableFiles : [primaryFile];
      for (const file of targets) {
        await window.electronAPI.updateMetadata(file.path, payload, coverPath || null);
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Could not update metadata");
    } finally {
      setBusy(false);
    }
  };

  if (!primaryFile) return null;

  return (
    <div className="mt-4 border border-border/40 bg-card/30 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Embedded Metadata
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input value={form.title} onChange={(e) => updateField("title", e.target.value)} placeholder="Title" />
        <Input value={form.publisher} onChange={(e) => updateField("publisher", e.target.value)} placeholder="Publisher" />
        <Input value={form.writers} onChange={(e) => updateField("writers", e.target.value)} placeholder="Writers" />
        <Input value={form.pencillers} onChange={(e) => updateField("pencillers", e.target.value)} placeholder="Pencillers" />
        <Input className="col-span-2" value={form.genres} onChange={(e) => updateField("genres", e.target.value)} placeholder="Genres" />
      </div>
      <textarea
        className="w-full min-h-20 rounded-md border border-input bg-background px-3 py-2 text-xs"
        value={form.synopsis}
        onChange={(e) => updateField("synopsis", e.target.value)}
        placeholder="Synopsis"
      />
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handlePickCover} className="text-xs">
          Cover
        </Button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {coverPath || "No cover selected"}
        </span>
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
          Apply to all
        </label>
        <Button size="sm" onClick={handleSave} disabled={busy} className="text-xs gap-1.5">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Save
        </Button>
      </div>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

function DetailView({ entry, onBack, onRefresh, onStartDownload, onSwitchTab, settings }) {
  const [deleting, setDeleting] = useState(false);
  // Two-step delete confirmation (avoids window.confirm which breaks
  // Electron's renderer focus/input handling)
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [showMetadataEditor, setShowMetadataEditor] = useState(false);

  const handleOpenFile = async (filePath) => {
    if (window.electronAPI?.openFile) {
      await window.electronAPI.openFile(filePath);
    }
  };

  const handleOpenFolder = () => {
    if (window.electronAPI?.openFolder) {
      window.electronAPI.openFolder(entry.folderPath);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      // First click — show confirmation
      setConfirmDelete(true);
      // Auto-cancel after 4 seconds
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    // Second click — actually delete
    setDeleting(true);
    setConfirmDelete(false);
    if (window.electronAPI?.deleteSeries) {
      const result = await window.electronAPI.deleteSeries(entry.folderPath);
      if (result.ok) {
        onRefresh();
        onBack();
      } else {
        setDeleteError("Failed to delete: " + result.error);
        setDeleting(false);
      }
    }
  };

  const formats = getFormats(entry.files);
  const meta = entry.seriesMeta;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b bg-card/30">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>
        <h2 className="text-sm font-semibold truncate">{entry.title}</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex gap-5">
          {/* Cover */}
          <div className="w-44 shrink-0 aspect-[3/4] rounded-lg overflow-hidden border border-border/50 bg-muted/30">
            <PdfCover entry={entry} />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0 space-y-3">
            <h2 className="text-lg font-bold leading-tight">{entry.title}</h2>

            {/* Series metadata from .aio_series.json */}
            {meta && (
              <div className="space-y-1.5">
                {meta.status && (
                  <span
                    className={cn(
                      "inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded border",
                      STATUS_COLORS[meta.status] || "bg-muted text-muted-foreground border-border"
                    )}
                  >
                    {meta.status}
                  </span>
                )}
                {meta.authors?.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <User className="w-3 h-3 shrink-0" />
                    <span>{meta.authors.join(", ")}</span>
                  </div>
                )}
                {meta.genres?.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Tag className="w-3 h-3 shrink-0" />
                    <span>{meta.genres.join(", ")}</span>
                  </div>
                )}
              </div>
            )}

            {/* Stats row */}
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <FileText className="w-3.5 h-3.5" />
                {entry.files.length} file{entry.files.length !== 1 ? "s" : ""}
              </div>
              <div>{formatSize(entry.totalSize)}</div>
              {meta?.chapters_downloaded?.length > 0 && (
                <div>{meta.chapters_downloaded.length} chapters</div>
              )}
              {entry.lastModified && <div>Modified {formatDate(entry.lastModified)}</div>}
            </div>

            {/* Format badges */}
            <div className="flex gap-1.5">
              {formats.map((fmt) => (
                <span
                  key={fmt}
                  className={cn(
                    "text-[10px] font-bold uppercase px-2 py-1 rounded border",
                    FORMAT_COLORS[fmt] || "bg-muted text-muted-foreground border-border"
                  )}
                >
                  {fmt}
                </span>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={handleOpenFolder} className="gap-1.5 text-xs">
                <FolderOpen className="w-3.5 h-3.5" />
                Open Folder
              </Button>
              {meta?.url && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(meta.url, "_blank")}
                  className="gap-1.5 text-xs"
                >
                  <Globe className="w-3.5 h-3.5" />
                  Source
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowMetadataEditor((value) => !value)}
                className="gap-1.5 text-xs"
              >
                <PencilLine className="w-3.5 h-3.5" />
                Metadata
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDelete}
                onBlur={() => setConfirmDelete(false)}
                disabled={deleting}
                className={cn(
                  "gap-1.5 text-xs",
                  confirmDelete
                    ? "text-destructive bg-destructive/10 border-destructive/50 hover:bg-destructive/20 hover:text-destructive hover:border-destructive/50"
                    : "text-destructive hover:text-destructive hover:border-destructive/50"
                )}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {deleting ? "Deleting…" : confirmDelete ? "Are you sure?" : "Delete"}
              </Button>
            </div>
            {deleteError && (
              <p className="text-[10px] text-destructive mt-1">{deleteError}</p>
            )}
            {showMetadataEditor && (
              <MetadataEditorPanel
                entry={entry}
                onClose={() => setShowMetadataEditor(false)}
                onSaved={onRefresh}
              />
            )}
          </div>
        </div>

        {/* Update checking section */}
        <div className="mt-5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Updates
          </h3>
          <UpdateSection
            entry={entry}
            onStartDownload={onStartDownload}
            onSwitchTab={onSwitchTab}
            settings={settings}
          />
        </div>

        {/* File list */}
        <div className="mt-5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Files
          </h3>
          <div className="space-y-1">
            {entry.files.map((file) => (
              <button
                key={file.path}
                onClick={() => handleOpenFile(file.path)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left",
                  "bg-card/40 border border-border/30",
                  "hover:bg-card/80 hover:border-primary/30",
                  "transition-all duration-100 group"
                )}
              >
                <span
                  className={cn(
                    "text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0",
                    FORMAT_COLORS[file.ext] || "bg-muted text-muted-foreground border-border"
                  )}
                >
                  {file.ext}
                </span>
                <span className="text-xs font-medium truncate flex-1">{file.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {formatSize(file.size)}
                </span>
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// EMPTY STATE
// ============================================================
function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center py-20 px-8">
      <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mb-4">
        <BookOpen className="w-7 h-7 text-muted-foreground/50" />
      </div>
      <h3 className="text-sm font-semibold mb-1">No manga yet</h3>
      <p className="text-xs text-muted-foreground max-w-xs">
        Downloaded manga will appear here. Go to the{" "}
        <span className="inline-flex items-center gap-0.5 text-primary">
          <Download className="w-3 h-3" /> New
        </span>{" "}
        tab to start downloading.
      </p>
    </div>
  );
}

// ============================================================
// LIBRARY TAB (main export)
// ============================================================
export default function LibraryTab({
  onStartDownload, onSwitchTab, settings, onSaveSettings,
  // Lifted state from useDownloader. libraryEntries is null until first
  // load completes (so we know whether to trigger an initial fetch on
  // mount). loadLibrary forces a fresh scan; setLibraryEntries is exposed
  // so handleCheckAll can splice updatedMeta back into the entries list
  // without round-tripping through the IPC scan again.
  libraryEntries, libraryLoading, loadLibrary, setLibraryEntries,
}) {
  const entries = libraryEntries || [];
  const loading = libraryLoading || libraryEntries === null;
  // setEntries shim so the existing handleCheckAll / detail-edit code reads
  // naturally without diverging from the upstream pattern. Calling
  // setLibraryEntries with a non-null value is safe — null is reserved
  // exclusively for the "not yet loaded" sentinel that loadLibrary clears
  // by setting an array (even an empty one).
  const setEntries = setLibraryEntries;

  const [searchQuery, setSearchQuery] = useState("");
  // Lazy-init from persisted settings.libraryOpts.sortBy. Falls back to "title"
  // for first run / older settings dicts. Sync below via useEffect when the
  // settings prop hydrates asynchronously from disk on app launch.
  const [sortBy, setSortBy] = useState(() => settings?.libraryOpts?.sortBy ?? "title");

  // Sync once when settings.libraryOpts.sortBy arrives from disk (history.json
  // load is async). Same shape as SearchTab's settings.searchOpts hydration.
  useEffect(() => {
    const persisted = settings?.libraryOpts?.sortBy;
    if (persisted && persisted !== sortBy) {
      setSortBy(persisted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.libraryOpts?.sortBy]);

  // Wrap the setter so picking a new sort persists to settings.libraryOpts.
  // Spread merge preserves any future libraryOpts fields without listing them.
  const updateSort = (value) => {
    setSortBy(value);
    onSaveSettings?.({
      libraryOpts: { ...(settings?.libraryOpts || {}), sortBy: value },
    });
  };
  const [selectedEntry, setSelectedEntry] = useState(null);

  // New chapter counts per series (folderPath → count).
  // Populated by "Check All" or individual checks.
  const [newChapterCounts, setNewChapterCounts] = useState({});

  // Check-all state
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkProgress, setCheckProgress] = useState(null);

  // ── Load library on first mount only ──
  // libraryEntries is the null sentinel until the first scan completes.
  // Subsequent tab switches see an array and skip the fetch — the entries
  // and pending thumbnail-ready events are managed at the hook level.
  useEffect(() => {
    if (libraryEntries === null && !libraryLoading) {
      loadLibrary();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Listen for check-all-updates progress ──
  useEffect(() => {
    if (!window.electronAPI?.onUpdateCheckProgress) return;
    const unsub = window.electronAPI.onUpdateCheckProgress((progress) => {
      setCheckProgress(progress);
    });
    return unsub;
  }, []);

  // ── Check all ongoing series for updates ──
  const handleCheckAll = useCallback(async () => {
    if (!window.electronAPI?.checkAllUpdates) return;
    setCheckingAll(true);
    setCheckProgress(null);
    try {
      const res = await window.electronAPI.checkAllUpdates();
      if (res.results) {
        const counts = {};
        // Each result also carries `updatedMeta` (status, authors, cover,
        // genres) from the live --list-chapters call. Splice it back into
        // entries so the grid + detail view reflect fresh metadata
        // without requiring a manual Refresh after Check All.
        const updatedMetas = {};
        for (const r of res.results) {
          if (!r.ok) continue;
          if (r.newChapters?.length > 0) {
            counts[r.folderPath] = r.newChapters.length;
          }
          if (r.updatedMeta) {
            updatedMetas[r.folderPath] = r.updatedMeta;
          }
        }
        setNewChapterCounts((prev) => ({ ...prev, ...counts }));
        if (Object.keys(updatedMetas).length > 0) {
          setEntries((prev) =>
            prev.map((e) => {
              const fresh = updatedMetas[e.folderPath];
              if (!fresh) return e;
              // Merge so we keep fields the live check didn't fetch
              // (e.g. chapters_downloaded, hid, url) and only overwrite
              // the metadata fields the live check actually returned.
              const mergedMeta = { ...e.seriesMeta };
              for (const [k, v] of Object.entries(fresh)) {
                if (v !== undefined && v !== null) mergedMeta[k] = v;
              }
              return { ...e, seriesMeta: mergedMeta };
            })
          );
        }
      }
    } catch (err) {
      console.error("Check all updates failed:", err);
    }
    setCheckingAll(false);
    setCheckProgress(null);
  }, []);

  const handleRefresh = useCallback(() => {
    setSelectedEntry(null);
    loadLibrary();
  }, [loadLibrary]);

  // ── Filter + Sort ──
  // Pre-compute lowercased titles ONCE per entries-list change. Without
  // this, every keystroke recomputes `e.title.toLowerCase()` for every
  // entry — at 200 entries × 8 keystrokes/sec that's 1600 case
  // conversions/sec just to filter on a substring search.
  const entriesIndexed = useMemo(
    () => entries.map((e) => ({ entry: e, lowerTitle: (e.title || "").toLowerCase() })),
    [entries]
  );
  const lowerQuery = useMemo(() => searchQuery.toLowerCase(), [searchQuery]);
  const filtered = useMemo(
    () => {
      if (!lowerQuery) return entries;
      return entriesIndexed
        .filter((x) => x.lowerTitle.includes(lowerQuery))
        .map((x) => x.entry);
    },
    [entriesIndexed, lowerQuery, entries]
  );

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      switch (sortBy) {
        case "title": return a.title.localeCompare(b.title);
        case "title-desc": return b.title.localeCompare(a.title);
        case "date": return (b.lastModified || "").localeCompare(a.lastModified || "");
        case "date-asc": return (a.lastModified || "").localeCompare(b.lastModified || "");
        case "size": return b.totalSize - a.totalSize;
        case "size-asc": return a.totalSize - b.totalSize;
        default: return 0;
      }
    });
    return copy;
  }, [filtered, sortBy]);

  // Count how many series are eligible for "Check All"
  const ongoingCount = entries.filter((e) => {
    const s = e.seriesMeta?.status;
    return e.seriesMeta?.url && (!s || s === "Ongoing" || s === "Releasing");
  }).length;

  // ── Detail view ──
  if (selectedEntry) {
    const current = entries.find((e) => e.folderPath === selectedEntry.folderPath) || selectedEntry;
    return (
      <DetailView
        entry={current}
        onBack={() => setSelectedEntry(null)}
        onRefresh={handleRefresh}
        onStartDownload={onStartDownload}
        onSwitchTab={onSwitchTab}
        settings={settings}
      />
    );
  }

  // ── GRID VIEW ──
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-card/20">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search manga…"
            className="pl-8 h-8 text-xs"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
          <select
            value={sortBy}
            onChange={(e) => updateSort(e.target.value)}
            className={cn(
              "text-xs bg-transparent border border-border rounded-md px-2 py-1.5",
              "text-foreground cursor-pointer",
              "focus:outline-none focus:ring-1 focus:ring-primary"
            )}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Check All Updates button — only shows when there are ongoing series */}
        {ongoingCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheckAll}
            disabled={checkingAll || loading}
            className="gap-1.5 text-xs"
            title={`Check ${ongoingCount} ongoing series for new chapters`}
          >
            {checkingAll
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Bell className="w-3.5 h-3.5" />}
            {checkingAll
              ? (checkProgress ? `${checkProgress.current}/${checkProgress.total}` : "Checking…")
              : "Check All"}
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
          className="gap-1.5 text-xs"
          title="Refresh library"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
        </Button>

        <Badge variant="secondary" className="text-[10px] ml-auto">
          {loading ? "…" : `${sorted.length} manga${sorted.length !== 1 ? "s" : ""}`}
        </Badge>
      </div>

      {/* Grid / Empty */}
      <div className="flex-1 overflow-y-auto">
        {!loading && sorted.length === 0 ? (
          searchQuery ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Search className="w-8 h-8 text-muted-foreground/30 mb-3" />
              <p className="text-xs text-muted-foreground">
                No manga matching &ldquo;{searchQuery}&rdquo;
              </p>
            </div>
          ) : (
            <EmptyState />
          )
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-4">
            {sorted.map((entry) => (
              <MangaCard
                key={entry.folderPath}
                entry={entry}
                newCount={newChapterCounts[entry.folderPath] || 0}
                onClick={() => setSelectedEntry(entry)}
              />
            ))}

            {loading && entries.length === 0 &&
              Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="rounded-lg overflow-hidden border border-border/30">
                  <div className="aspect-[3/4] bg-muted/30 animate-pulse" />
                  <div className="p-2.5 space-y-2">
                    <div className="h-3 bg-muted/40 rounded animate-pulse w-3/4" />
                    <div className="h-2 bg-muted/30 rounded animate-pulse w-1/2" />
                  </div>
                </div>
              ))
            }
          </div>
        )}
      </div>
    </div>
  );
}
