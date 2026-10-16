// ============================================================
// DEV ONLY — a fake Device Sync backend for the ?gallery=sync page
//
// makeSyncSource(caseSpec) builds the object useDeviceSync({source}) reads
// instead of window.electronAPI (hooks/useDeviceSync.js, DEV SEAM): the
// sync* wrappers plus onSyncEvent. Every answer comes from the fixtures that
// tools/_gen_sync_fixtures.js recorded off the REAL service, so shapes can't
// drift from main; regenerate them after a backend change.
//
// The one thing here that is NOT recorded is config-op: it applies a naive
// copy of the edit (patch merge, list push/splice, version bump) and pushes a
// `config` event, so editors in the gallery respond to clicks. It does no
// validation, no identity clearing and no re-plan. Never treat its behaviour
// as the service's.
//
// Loaded only through src/dev/SyncGallery.jsx, which main.jsx imports
// dynamically under import.meta.env.DEV, so none of this reaches dist
// (the build check greps dist for "__aioSyncFixture").
// ============================================================

import stateOn from "./sync-fixtures/state-on.json";
import stateOff from "./sync-fixtures/state-off.json";
import devices from "./sync-fixtures/devices.json";
import locateAdb from "./sync-fixtures/locate-adb.json";
import browseRemote from "./sync-fixtures/browse-remote.json";
import labelPreview from "./sync-fixtures/label-preview.json";
import adbStates from "./sync-fixtures/adb-states.json";
import refusals from "./sync-fixtures/refusals.json";

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
export const FIXTURES = {
  stateOn: stateOn.data,
  stateOff: stateOff.data,
  devices: devices.data,
  locateAdb: locateAdb.data,
  browseRemote: browseRemote.data,
  labelPreview: labelPreview.data,
  adbStates: adbStates.data,
  refusals: refusals.data,
};

/**
 * @param {{base?:"on"|"off", adb?:string, mutate?:(snap)=>void}} spec
 *   base picks the recorded snapshot; adb swaps in one recorded adb state;
 *   mutate edits the snapshot copy before the hook sees it.
 */
export function makeSyncSource(spec = {}) {
  const snap = clone(spec.base === "off" ? FIXTURES.stateOff : FIXTURES.stateOn);
  if (spec.adb && FIXTURES.adbStates[spec.adb]) snap.adb = clone(FIXTURES.adbStates[spec.adb]);
  if (spec.mutate) spec.mutate(snap);
  const listeners = new Set();
  const emit = (ev) => setTimeout(() => listeners.forEach((fn) => fn(ev)), 0);
  const ok = (x) => Promise.resolve({ ok: true, ...x });

  const target = (id) => (snap.config.targets || []).find((t) => t.id === id);
  const listOp = (p, field, edit) => {
    const t = target(p.targetId);
    if (t) t[field] = edit((t[field] || []).slice());
  };
  function applyOp(p) {
    const cfg = snap.config;
    switch (p.op) {
      case "add-target": {
        const id = `tdev${Math.random().toString(16).slice(2, 9)}`;
        cfg.targets.push({ id, excludes: [], aliases: [], only: [], ignoredSuggestions: [], acknowledged: [], ...p.target });
        return id;
      }
      case "update-target":
        Object.assign(target(p.targetId) || {}, p.patch || {});
        return null;
      case "remove-target":
        cfg.targets = cfg.targets.filter((t) => t.id !== p.targetId);
        return null;
      case "set-adb-path":
        cfg.adbPath = p.path || null;
        return null;
      case "add-alias":
        listOp(p, "aliases", (l) => [...l, p.alias]);
        return null;
      case "add-exclude":
        listOp(p, "excludes", (l) => [...l, p.entry]);
        return null;
      case "remove-alias":
        listOp(p, "aliases", (l) => l.filter((_, i) => i !== p.index));
        return null;
      case "remove-exclude":
        listOp(p, "excludes", (l) => l.filter((_, i) => i !== p.index));
        return null;
      case "set-selection-mode":
        Object.assign(target(p.targetId) || {}, { selection: p.mode, ...(Array.isArray(p.only) ? { only: p.only } : {}) });
        return null;
      default:
        return null; // forget-record and the plan-backed ops: version bump only
    }
  }

  return {
    syncGetState: () => Promise.resolve(clone(snap)),
    onSyncEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    syncConfigOp: (p) => {
      if (snap.config && p.expectVersion !== snap.config.version) {
        return Promise.resolve({ ok: false, code: "version-conflict", message: "the sync settings changed", config: clone(snap.config) });
      }
      const targetId = applyOp(p);
      snap.config.version += 1;
      emit({ kind: "config", config: clone(snap.config) });
      return ok({ config: clone(snap.config), ...(targetId ? { targetId } : {}) });
    },
    syncLocateAdb: () => Promise.resolve(clone(FIXTURES.locateAdb)),
    syncListDevices: () => Promise.resolve(clone(FIXTURES.devices)),
    syncBrowseRemote: ({ path }) => {
      const r = FIXTURES.browseRemote[path] || Object.values(FIXTURES.browseRemote).find((v) => v.path === path);
      return Promise.resolve(r ? clone(r) : { ok: false, code: "invalid", message: `no fixture for ${path}` });
    },
    syncLabelPreview: ({ name, patterns }) => {
      // Any line that won't compile answers the recorded refusal shape (its
      // text is the recorded one, not this pattern's).
      const bad = (patterns || "").split("\n").some((l) => {
        try {
          new RegExp(l.trim());
          return false;
        } catch {
          return true;
        }
      });
      if (bad) return Promise.resolve(clone(FIXTURES.labelPreview.badPattern));
      const e = FIXTURES.labelPreview.byName[name];
      return Promise.resolve(e ? clone(patterns ? e.custom : e.builtin) : { ok: true, unit: "unknown", label: null });
    },
    // Not used by Settings → Sync; answered so a stray call can't throw.
    ...Object.fromEntries(
      ["syncPlan", "syncSeriesDetail", "syncSetSelection", "syncVerify", "syncApply", "syncPrune", "syncRenameDeviceFolder", "syncCancel",
        "syncPromptResponse", "syncLibraryStatus", "syncExportReport", "syncDeviceCover", "syncFindSourcesStart", "syncFindSourcesCancel",
        "syncFindSourcesGet", "syncFindSourcesUpdateRow", "syncLink", "syncReview"].map((k) => [k, () => Promise.resolve({ ok: false, code: "disabled", message: "not in the gallery" })]),
    ),
  };
}
