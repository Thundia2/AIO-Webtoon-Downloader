// ============================================================
// DEV ONLY — ?gallery=sync, every Device Sync UI state on one page
//
// Renders the REAL components (SettingsTab at its Sync category, the quit
// dialog's sync line, the overlay primitives) against fixture-backed fake
// sync backends (./syncFixtureSource.js), each case in a light and a `.dark`
// frame at a fixed width. Phase U1 of sync-temp/plans/device-sync-ui-pass.md;
// later phases add their cases here.
//
// URL: ?gallery=sync                      index of cases
//      ?gallery=sync&case=<id>            one case, light above dark
//      &w=wide                            1180 px frames instead of 735 px
//      &theme=light|dark                  one frame only
// 735 px is the content width at the window minimum (800 px minus the rail).
//
// Every case mounts its own useDeviceSync({source}) (the hook's DEV seam), so
// cases never share state and window.electronAPI stays undefined: the other
// hooks' IPC never starts (useDownloader is not mounted here at all).
// Loaded only by main.jsx under import.meta.env.DEV.
// ============================================================

import React, { useState } from "react";
import SettingsTab, { DEFAULT_SETTINGS } from "@/components/SettingsTab";
import { Dialog, Sheet } from "@/components/ui/overlay";
import { Button } from "@/components/ui/primitives";
import { useDeviceSync } from "@/hooks/useDeviceSync";
import { FIXTURES, makeSyncSource } from "./syncFixtureSource";

const savedFrom = (snap, over) => {
  const { chapterPatternErrors, ...s } = snap.settings || {};
  return { ...structuredClone(DEFAULT_SETTINGS), ...s, ...(over || {}) };
};

// id → {title, note, source spec, app settings (what Save last wrote)}
const CASES = [
  { id: "off", title: "Sync off", note: "Only the switch and the explainer.", spec: { base: "off" }, saved: savedFrom(FIXTURES.stateOff) },
  {
    id: "starting",
    title: "Saved on, service not up yet",
    note: "'Starting…' for 5 s, then the didn't-start callout.",
    spec: { base: "off" },
    saved: savedFrom(FIXTURES.stateOff, { syncEnabled: true }),
  },
  ...Object.keys(FIXTURES.adbStates).map((k) => ({
    id: `on-${k}`,
    title: `Sync on, adb ${k}`,
    note: k === "tracking" ? "Three targets: adb tablet (Komikku), folder (Everything), offline tablet (Custom)." : null,
    spec: { base: "on", adb: k },
    saved: savedFrom(FIXTURES.stateOn),
  })),
  {
    id: "on-empty",
    title: "Sync on, no targets yet",
    note: "The add card is the first thing to do.",
    spec: { base: "on", mutate: (s) => { s.config.targets = []; } },
    saved: savedFrom(FIXTURES.stateOn),
  },
  {
    id: "on-bad-pattern",
    title: "Sync on, a chapter pattern that won't compile",
    note: "Open Advanced; the preview shows the line error.",
    spec: { base: "on" },
    saved: savedFrom(FIXTURES.stateOn, { syncChapterPatterns: "Episode (\\d+" }),
  },
];

function Case({ c }) {
  const sync = useDeviceSync({ source: makeSyncSource(c.spec) });
  const [saved, setSaved] = useState(c.saved);
  // Save in the gallery only updates the app settings this frame sees; the
  // fake service does not start or stop (that is what the "starting" case
  // shows).
  return (
    <SettingsTab
      settings={saved}
      onSave={async (s) => {
        setSaved(s);
        return { ok: true };
      }}
      initialCategory="sync"
      sync={sync}
      libraryEntries={[
        { folderName: "Eleceed", title: "Eleceed", path: "D:\\Sync-fixture\\manga\\Eleceed" },
        { folderName: "Tonikaku Kawaii", title: "Tonikaku Kawaii", path: "D:\\Sync-fixture\\manga\\Tonikaku Kawaii" },
        { folderName: "Blue Lock", title: "Blue Lock", path: "D:\\Sync-fixture\\manga\\Blue Lock" },
      ]}
      libraryLoading={false}
      loadLibrary={() => {}}
    />
  );
}

function OverlaysCase() {
  const [dlg, setDlg] = useState(true);
  const [sheet, setSheet] = useState(true);
  return (
    <div className="flex h-full items-start gap-2 p-4">
      <Button size="sm" onClick={() => setDlg(true)}>Dialog</Button>
      <Button size="sm" variant="outline" onClick={() => setSheet(true)}>Sheet</Button>
      <Sheet contained accent open={sheet} onClose={() => setSheet(false)} title="Eleceed" description="Galaxy Tab S9 · 212 chapters">
        <div className="p-4 text-sm text-muted-foreground">Sheet body. Escape or the scrim closes it.</div>
      </Sheet>
      <Dialog
        contained
        open={dlg}
        onClose={() => setDlg(false)}
        title="Turn off Device Sync now?"
        description="A copy to Galaxy Tab S9 is running."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDlg(false)}>Keep syncing</Button>
            <Button size="sm" variant="destructive" onClick={() => setDlg(false)}>Turn off</Button>
          </>
        }
      >
        <div className="text-sm text-muted-foreground">Dialog body.</div>
      </Dialog>
    </div>
  );
}

const ALL = [...CASES, { id: "overlays", title: "Overlay primitives", note: "Dialog over a Sheet, both contained.", render: () => <OverlaysCase /> }];

function Frame({ theme, width, children }) {
  return (
    <div className={theme === "dark" ? "dark" : ""}>
      <div className="relative overflow-hidden border bg-background text-foreground" style={{ width, height: 640 }}>
        {children}
      </div>
    </div>
  );
}

export default function SyncGallery() {
  const q = new URLSearchParams(window.location.search);
  const id = q.get("case");
  const width = q.get("w") === "wide" ? 1180 : 735;
  const themes = q.get("theme") ? [q.get("theme")] : ["light", "dark"];
  const c = ALL.find((x) => x.id === id);
  if (!c) {
    return (
      <div className="min-h-screen bg-background p-6 text-foreground">
        <h1 className="mb-3 text-lg font-semibold">Device Sync gallery</h1>
        <ul className="space-y-1 text-sm">
          {ALL.map((x) => (
            <li key={x.id}>
              <a className="text-primary underline" href={`?gallery=sync&case=${x.id}`}>{x.title}</a>{" "}
              <a className="text-xs text-muted-foreground underline" href={`?gallery=sync&case=${x.id}&w=wide`}>wide</a>
              {x.note && <span className="ml-2 text-xs text-muted-foreground">{x.note}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="min-h-screen space-y-3 bg-muted p-3 text-foreground">
      <div className="text-xs text-muted-foreground">
        <b className="text-foreground">{c.title}</b> · {width}px {c.note ? `· ${c.note}` : ""} · <a className="underline" href="?gallery=sync">all cases</a>
      </div>
      {themes.map((t) => (
        <Frame key={t} theme={t} width={width}>
          {c.render ? c.render() : <Case c={c} />}
        </Frame>
      ))}
    </div>
  );
}
