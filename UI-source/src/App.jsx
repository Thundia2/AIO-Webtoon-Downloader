import React, { useState, useEffect, useMemo } from "react";
import { useDownloader } from "@/hooks/useDownloader";
import { useDeviceSync } from "@/hooks/useDeviceSync";
import DownloadTab from "@/components/DownloadTab";
import SearchTab from "@/components/SearchTab";
import QueueTab from "@/components/QueueTab";
import LogPanel from "@/components/LogPanel";
import SettingsTab from "@/components/SettingsTab";
import LibraryTab from "@/components/LibraryTab";
import ResumeBar from "@/components/ResumeBar";
import ConfirmQuitDialog from "@/components/ConfirmQuitDialog";
import SyncTab from "@/components/sync/SyncTab";
import appIcon from "../build-resources/icon.png";
import {
  Download,
  Search,
  ListOrdered,
  Terminal,
  Settings,
  FolderSync,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Tab definitions — each tab has an ID, label, and icon.
// Search sits between New and Queue: cross-site discovery feeds the same
// queue the New tab does, so the visual order matches the user's flow:
//   Search (find URL) → New (configure if needed) → Queue (running)
// Sync is inserted just above Settings, and only while Device Sync is on
// (App's `tabs` memo below).
const BASE_TABS = [
  { id: "new", label: "New", icon: Download },
  { id: "search", label: "Search", icon: Search },
  { id: "queue", label: "Queue", icon: ListOrdered },
  { id: "logs", label: "Logs", icon: Terminal },
  { id: "settings", label: "Settings", icon: Settings },
];
const SYNC_TAB = { id: "sync", label: "Sync", icon: FolderSync };

export default function App() {
  const [activeTab, setActiveTab] = useState("new");
  const [downloadDraft, setDownloadDraft] = useState(null);
  // When the SearchTab slow-sites callout's "Manage in Settings" link fires, we
  // jump to the Settings tab AND preselect its Search category. Null the rest of
  // the time so a manual Settings visit (via the rail) lands on the default pane
  // — the rail button clears it below.
  const [settingsCategory, setSettingsCategory] = useState(null);

  // Central hook that manages all download state and Electron IPC
  const dl = useDownloader();

  // Device Sync, mounted once here so its event subscription lives as long as
  // the window: the Sync tab and Settings → Sync both read this one instance
  // (hooks/useDeviceSync.js). `sync.enabled` is the service's live state, not
  // the saved setting, so the tab appears only once the service has started.
  const sync = useDeviceSync();
  // The Sync tab's per-visit view (picked target, tile filter, query, sort,
  // dismissed last-run cards) lives here, not in the tab: App unmounts tabs
  // on every switch (UI-pass U2-14; components/sync/SyncTab.jsx `view`).
  const [syncView, setSyncView] = useState({ targetId: null, tile: null, query: "", sort: "copy", dismissed: {} });
  const patchSyncView = React.useCallback((patch) => setSyncView((v) => ({ ...v, ...patch })), []);
  const tabs = useMemo(() => {
    if (!sync.enabled) return BASE_TABS;
    const at = BASE_TABS.findIndex((t) => t.id === "settings");
    return [...BASE_TABS.slice(0, at), SYNC_TAB, ...BASE_TABS.slice(at)];
  }, [sync.enabled]);

  // Turning sync off while its tab is open would leave the view on a tab the
  // rail no longer shows; land on Settings, where the switch that did it is.
  useEffect(() => {
    if (activeTab === "sync" && !sync.enabled) setActiveTab("settings");
  }, [activeTab, sync.enabled]);

  // Apply the system dark/light theme on mount and listen for changes
  useEffect(() => {
    async function applyTheme() {
      if (window.electronAPI) {
        const theme = await window.electronAPI.getTheme();
        document.documentElement.classList.toggle("dark", theme === "dark");
      } else {
        // In browser dev mode, default to dark for testing
        document.documentElement.classList.add("dark");
      }
    }
    applyTheme();

    if (window.electronAPI) {
      const unsub = window.electronAPI.onThemeChanged((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
      });
      return unsub;
    }
  }, []);

  // Count for the queue badge (running + queued).
  // Memoized — Object.values + filter + length is cheap individually but
  // App re-renders on every dl state update (~10x/sec during a download
  // due to flushInterval). useMemo recomputes only when activeDownloads
  // or queue actually change, so render cost stays flat as the
  // activeDownloads dict accumulates completed entries (cleared via
  // QueueTab's "Clear completed" button rather than aggressively).
  const activeCount = useMemo(
    () =>
      Object.values(dl.activeDownloads || {}).filter((d) => d.status === "running").length
      + (dl.queue || []).length,
    [dl.activeDownloads, dl.queue]
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden relative">
      {/* ── Sidebar ── */}
      <nav className="flex flex-col items-center w-16 shrink-0 border-r bg-card/50 py-3 gap-1">
        {/* App icon at the top — click to open Library */}
        <button
          onClick={() => setActiveTab("library")}
          title="Library"
          className={cn(
            "flex items-center justify-center w-10 h-10 mb-4 rounded-lg transition-all duration-150",
            activeTab === "library"
              ? "bg-primary/15 ring-1 ring-primary/40"
              : "bg-primary/10 hover:bg-primary/20"
          )}
        >
          <img
            src={appIcon}
            alt=""
            className="h-7 w-7 rounded-md object-contain"
            draggable={false}
          />
        </button>

        {/* Tab buttons */}
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => {
                // A manual Settings visit resets any callout-forced category so
                // it opens on the default (General) pane, not Search.
                if (tab.id === "settings") setSettingsCategory(null);
                setActiveTab(tab.id);
              }}
              title={tab.label}
              className={cn(
                "relative flex flex-col items-center justify-center w-12 h-12 rounded-lg",
                "transition-all duration-150",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              <Icon className="w-[18px] h-[18px]" />
              <span className="text-[9px] mt-0.5 font-medium">{tab.label}</span>

              {/* Blue indicator line on the left edge when active */}
              {isActive && (
                <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-primary" />
              )}

              {/* Number badge on queue tab */}
              {tab.id === "queue" && activeCount > 0 && (
                <div className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center px-1">
                  {activeCount}
                </div>
              )}

              {/* Red dot on logs tab when there's a recent error */}
              {/* UIR-2: skip trailing 'divider' entries (a completion divider is
                  appended after the final error line, which would otherwise
                  suppress the dot exactly on a failed run). */}
              {tab.id === "logs" &&
                (() => {
                  const logs = dl.logs || [];
                  let i = logs.length - 1;
                  while (i >= 0 && logs[i]?.level === "divider") i--;
                  return i >= 0 && logs[i]?.level === "error";
                })() &&
                activeTab !== "logs" && (
                  <div className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
                )}
            </button>
          );
        })}
      </nav>

      {/* ── Main Content Area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Tab header bar */}
        <div className="flex items-center px-5 py-3 border-b bg-card/30">
          <h1 className="text-sm font-semibold tracking-wide">
            {activeTab === "library"
              ? "Library"
              : tabs.find((t) => t.id === activeTab)?.label}
          </h1>
        </div>

        {/* Tab content area */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === "library" && (
            <LibraryTab
              onStartDownload={(url, args) =>
                dl.queueDownload(url, { ...(dl.settings?.defaults || {}), ...args })
              }
              onSwitchTab={setActiveTab}
              settings={dl.settings}
              onSaveSettings={dl.saveSettings}
              libraryEntries={dl.libraryEntries}
              libraryLoading={dl.libraryLoading}
              loadLibrary={dl.loadLibrary}
              updateCheck={dl.updateCheck}
            />
          )}
          {activeTab === "new" && (
            <DownloadTab
              onStartDownload={dl.queueDownload}
              settings={dl.settings}
              draft={downloadDraft}
              onDraftChange={setDownloadDraft}
              onDraftConsumed={() => setDownloadDraft(null)}
            />
          )}
          {activeTab === "search" && (
            <SearchTab
              searchState={dl.searchState}
              searchLogs={dl.searchLogs}
              runSearch={dl.runSearch}
              cancelSearch={dl.cancelSearch}
              clearSearchLogs={dl.clearSearchLogs}
              settings={dl.settings}
              onSaveSettings={dl.saveSettings}
              resumable={dl.resumable}
              onResumeDownload={async (item) => {
                // Resume now routes through the serial queue; jump to the Queue
                // tab so the user sees it land (running or queued). Skip the jump
                // on a dedupe no-op / missing-API result.
                const r = await dl.resumeDownload(item);
                if (r && r.status !== "duplicate" && r.status !== "noop") {
                  setActiveTab("queue");
                }
              }}
              searchSiteHealth={dl.searchSiteHealth}
              onManageSources={() => {
                setSettingsCategory("search");
                setActiveTab("settings");
              }}
              onStartDownload={(url, args) => {
                // Fix A (2026-05-07): merge settings.defaults so search- and
                // library-driven downloads inherit format / quality / scaling /
                // image-workers / etc. without going through the New tab. The
                // caller-passed `args` wins on conflicts (search may set
                // `multiSource: true` even when defaults.multiSource is false,
                // because the search itself was multi-source). DownloadTab does
                // its own merge via form initialization, so it doesn't need
                // this wrapper. Same fix applied to LibraryTab above.
                dl.queueDownload(url, { ...(dl.settings?.defaults || {}), ...args });
                setActiveTab("queue");
              }}
            />
          )}
          {activeTab === "queue" && (
            <QueueTab
              activeDownloads={dl.activeDownloads}
              queue={dl.queue}
              currentDownloadId={dl.currentDownloadId}
              onCancel={dl.cancelDownload}
              onRemoveFromQueue={dl.removeFromQueue}
              onStartQueuedNow={dl.startQueuedNow}
              onClearCompleted={dl.clearCompleted}
            />
          )}
          {activeTab === "logs" && (
            <LogPanel
              logs={dl.logs}
              onClearLogs={dl.clearLogs}
              settings={dl.settings}
              onSaveSettings={dl.saveSettings}
            />
          )}
          {activeTab === "sync" && sync.enabled && (
            <SyncTab
              sync={sync}
              view={syncView}
              onView={patchSyncView}
              libraryEntries={dl.libraryEntries}
              loadLibrary={dl.loadLibrary}
              onOpenSettings={(category) => {
                setSettingsCategory(category === "general" ? "general" : "sync");
                setActiveTab("settings");
              }}
            />
          )}
          {activeTab === "settings" && (
            <SettingsTab
              settings={dl.settings}
              onSave={dl.saveSettings}
              searchSiteHealth={dl.searchSiteHealth}
              initialCategory={settingsCategory}
              sync={sync}
              libraryEntries={dl.libraryEntries}
              libraryLoading={dl.libraryLoading}
              loadLibrary={dl.loadLibrary}
            />
          )}
        </div>

        {/* Resume bar — pinned at the bottom, visible when unfinished downloads exist */}
        <ResumeBar
          resumable={dl.resumable}
          onResume={async (item) => {
            // Serial-queue the resume (bug fix) and surface it: jump to the Queue
            // tab on accept. Skip on a dedupe no-op / missing-API result.
            const r = await dl.resumeDownload(item);
            if (r && r.status !== "duplicate" && r.status !== "noop") {
              setActiveTab("queue");
            }
          }}
          onDelete={dl.deleteTemp}
          onRefresh={dl.refreshResumable}
        />
      </div>

      {/* Quit confirmation — self-contained (subscribes to main's
          "confirm-quit" push, renders null the rest of the time). Sits outside
          the tab-content area so it overlays whatever tab is open. */}
      <ConfirmQuitDialog />
    </div>
  );
}
