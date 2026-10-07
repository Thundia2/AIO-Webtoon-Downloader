// ============================================================
// useDeviceSync — renderer mirror of Device Sync (main: electron/sync/service.js)
//
// NOT MOUNTED YET: mounting it (once, for the app's lifetime, like
// useUpdateCheck) is the UI pass's job.
//
// STATE OWNERSHIP: main owns everything. This hook adopts the sync:get-state
// snapshot, then applies "sync-event" pushes by kind. Same startup ordering
// as useUpdateCheck: events that arrive before the snapshot resolves are
// BUFFERED and drained after it, so adoption is a plain overwrite.
//
// JOB EVENTS (sync/job-record.js): begin and finish carry the full `job`
// view; progress carries only `progress`. A begin/finish with a runId older
// than the mirrored job, or a progress for any other runId, is dropped (a
// stale run's late event after the snapshot).
//
// PLANS are not pushed: a plan's summary rides on its job's finish, and a
// target is marked stale by edits main doesn't announce. So a finished job
// and a config event re-read `plans` alone from get-state (latest request
// wins). After a save-settings that flips syncEnabled, call refresh().
//
// Read by: nothing yet (UI pass). Depends on: preload.js sync* wrappers and
// onSyncEvent. The event kinds below duplicate sync/contract.js EVENT_KINDS;
// tools/_test_device_sync_contract.js keeps them equal, and
// tools/_test_device_sync_hook.js runs this file. grep: deviceSync
// ============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const EVENT_KINDS = ["device", "job", "config", "prompt", "find", "prewarm", "library-status"];

const api = () => (typeof window !== "undefined" && window.electronAPI && typeof window.electronAPI.syncGetState === "function" ? window.electronAPI : null);

const INITIAL = Object.freeze({
  loaded: false,
  enabled: false,
  settings: null,
  specs: null,
  config: null,
  adb: null,
  devices: [],
  folderPresence: {},
  job: null,
  queue: [],
  plans: {},
  prompt: null,
  prompts: [],
  find: null,
  findRows: {},
  prewarm: null,
  libraryStatus: null,
});

// Action name → preload wrapper. get-state is refresh(); events come from
// onSyncEvent. Every wrapper resolves {ok:true,…} or {ok:false, code, message}.
const ACTIONS = {
  configOp: "syncConfigOp",
  locateAdb: "syncLocateAdb",
  listDevices: "syncListDevices",
  browseRemote: "syncBrowseRemote",
  plan: "syncPlan",
  seriesDetail: "syncSeriesDetail",
  setSelection: "syncSetSelection",
  verify: "syncVerify",
  apply: "syncApply",
  prune: "syncPrune",
  renameDeviceFolder: "syncRenameDeviceFolder",
  cancel: "syncCancel",
  promptResponse: "syncPromptResponse",
  libraryStatus: "syncLibraryStatus",
  labelPreview: "syncLabelPreview",
  exportReport: "syncExportReport",
  deviceCover: "syncDeviceCover",
  findSourcesStart: "syncFindSourcesStart",
  findSourcesCancel: "syncFindSourcesCancel",
  findSourcesGet: "syncFindSourcesGet",
  findSourcesUpdateRow: "syncFindSourcesUpdateRow",
  link: "syncLink",
};

function rowsByFolder(rows) {
  const out = {};
  for (const r of rows || []) if (r && typeof r.folder === "string") out[r.folder] = r;
  return out;
}

/** Pure reducer: one pushed event onto the mirrored state. Unknown kinds are ignored. */
function applySyncEvent(s, ev) {
  if (!ev || typeof ev !== "object" || !EVENT_KINDS.includes(ev.kind)) return s;
  switch (ev.kind) {
    case "device":
      return { ...s, devices: Array.isArray(ev.devices) ? ev.devices : s.devices, folderPresence: ev.folderPresence || s.folderPresence };
    case "job": {
      const cur = s.job;
      if (ev.job) {
        if (cur && typeof ev.runId === "number" && ev.runId < cur.runId) return s;
        return { ...s, job: ev.job };
      }
      if (!cur || ev.runId !== cur.runId || cur.state !== "running") return s;
      return { ...s, job: { ...cur, progress: { ...cur.progress, ...(ev.progress || {}) } } };
    }
    case "config":
      return { ...s, config: ev.config || null };
    case "prompt": {
      const prompts = Array.isArray(ev.prompts) ? ev.prompts : s.prompts;
      return { ...s, prompts, prompt: prompts[0] || null };
    }
    case "find": {
      // Batch events carry done/total; a row edit (find-sources updateRow)
      // carries only the row and leaves the batch status alone.
      let find = s.find;
      if (typeof ev.done === "number") {
        const live = ev.state === "running" || ev.state === "waiting";
        find = live ? { targetId: ev.targetId, waiting: ev.state === "waiting" ? ev.waiting || null : null, done: ev.done, total: ev.total } : null;
      }
      if (!ev.row || typeof ev.row.folder !== "string" || !ev.targetId) return { ...s, find };
      const rows = { ...(s.findRows[ev.targetId] || {}), [ev.row.folder]: ev.row };
      return { ...s, find, findRows: { ...s.findRows, [ev.targetId]: rows } };
    }
    case "prewarm":
      return { ...s, prewarm: ev.prewarm || null };
    case "library-status":
      return { ...s, libraryStatus: ev.status || null };
    default:
      return s;
  }
}

function fromSnapshot(snap) {
  const j = snap.job || {};
  return {
    ...INITIAL,
    loaded: true,
    enabled: !!snap.enabled,
    settings: snap.settings || null,
    specs: snap.specs || null,
    config: snap.config || null,
    adb: snap.adb || null,
    devices: Array.isArray(snap.devices) ? snap.devices : [],
    folderPresence: snap.folderPresence || {},
    job: j.job || null,
    queue: Array.isArray(j.queue) ? j.queue : [],
    plans: snap.plans || {},
    prompt: snap.prompt || null,
    prompts: Array.isArray(snap.prompts) ? snap.prompts : [],
    find: snap.find || null,
    prewarm: snap.prewarm || null,
  };
}

export function useDeviceSync() {
  const [state, setState] = useState(INITIAL);
  const hydratedRef = useRef(false);
  const bufferRef = useRef([]);
  const plansSeqRef = useRef(0);

  const refreshPlans = useCallback(() => {
    const a = api();
    if (!a) return Promise.resolve();
    const seq = ++plansSeqRef.current;
    return Promise.resolve(a.syncGetState())
      .then((snap) => {
        if (seq !== plansSeqRef.current || !snap || snap.ok === false) return;
        setState((s) => ({ ...s, plans: snap.plans || {} }));
      })
      .catch(() => {});
  }, []);

  const onEvent = useCallback(
    (ev) => {
      if (!hydratedRef.current) {
        bufferRef.current.push(ev);
        return;
      }
      setState((s) => applySyncEvent(s, ev));
      if (ev && (ev.kind === "config" || (ev.kind === "job" && ev.state === "done"))) refreshPlans();
    },
    [refreshPlans],
  );

  /** Re-read the whole snapshot (e.g. after syncEnabled changed). */
  const refresh = useCallback(() => {
    const a = api();
    if (!a) return Promise.resolve(null);
    return Promise.resolve(a.syncGetState())
      .then((snap) => {
        if (snap && snap.ok !== false) {
          setState((s) => ({ ...fromSnapshot(snap), findRows: s.findRows, libraryStatus: s.libraryStatus }));
        }
        return snap;
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    const a = api();
    if (!a) return undefined;
    let alive = true;
    hydratedRef.current = false;
    bufferRef.current = [];
    const unsubscribe = a.onSyncEvent(onEvent);
    // Adopt the snapshot (or the defaults when get-state refused or failed),
    // then drain what arrived meanwhile.
    const hydrate = (snap) => {
      if (!alive) return;
      const buffered = bufferRef.current;
      bufferRef.current = [];
      hydratedRef.current = true;
      setState(() => {
        let s = snap && snap.ok !== false ? fromSnapshot(snap) : { ...INITIAL, loaded: true };
        for (const ev of buffered) s = applySyncEvent(s, ev);
        return s;
      });
    };
    Promise.resolve()
      .then(() => a.syncGetState())
      .then(hydrate, () => hydrate(null));
    return () => {
      alive = false;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [onEvent]);

  const actions = useMemo(() => {
    const out = { refresh };
    for (const [name, fn] of Object.entries(ACTIONS)) {
      out[name] = (payload) => {
        const a = api();
        if (!a) return Promise.resolve({ ok: false, code: "disabled", message: "electronAPI unavailable" });
        return Promise.resolve(a[fn](payload));
      };
    }
    // find-sources:get answers the target's rows; keep them so find events
    // (which carry one row each) patch a complete table.
    const getRows = out.findSourcesGet;
    out.findSourcesGet = (payload) =>
      getRows(payload).then((r) => {
        if (r && r.ok && payload && payload.targetId) {
          setState((s) => ({ ...s, findRows: { ...s.findRows, [payload.targetId]: rowsByFolder(r.rows) } }));
        }
        return r;
      });
    return out;
  }, [refresh]);

  return { ...state, actions };
}

export default useDeviceSync;
