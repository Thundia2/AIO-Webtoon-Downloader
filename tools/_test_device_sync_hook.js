// Offline regression test for UI-source/src/hooks/useDeviceSync.js — the
// renderer mirror of Device Sync (main: electron/sync/service.js).
// Run: node tools/_test_device_sync_hook.js   (from the repo root or tools/)
//
// Drives the REAL hook source: its single `import … from "react"` line is
// stripped and it is evaluated against the minimal hook runtime copied from
// tools/_test_update_check_hook.js (same semantics: functional setState,
// value-equal bail-out, useCallback/useMemo identity, effects after render).
//
// What it pins:
//   - events that race the get-state snapshot are buffered and applied after it
//   - snapshot adoption maps every field (job + queue from jobs.snapshot())
//   - a stale runId's begin/finish/progress is dropped; the live run's applies
//   - a finished job and a config event re-read plans (latest request wins)
//   - find events: batch status vs a row-only edit; findSourcesGet keeps rows
//   - prompt / device / prewarm / library-status / config by kind; unknown kinds ignored
//   - without electronAPI the hook is inert and actions answer `disabled`
//   - a refused or rejected first get-state still loads and drains the buffer

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "UI-source", "src", "hooks", "useDeviceSync.js");

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

// ── Load the real hook against an injected React ─────────────────────────
function loadHook() {
  let src = fs.readFileSync(HOOK, "utf8");
  const importLine = /^import\s*\{[^}]*\}\s*from\s*"react";\s*$/m;
  const n = (src.match(new RegExp(importLine.source, "gm")) || []).length;
  if (n !== 1) throw new Error(`useDeviceSync.js must have exactly one react import line (found ${n})`);
  if (/^import\s/m.test(src.replace(importLine, ""))) throw new Error("useDeviceSync.js has a second import");
  src = src.replace(importLine, "");
  src = src.replace(/^export function useDeviceSync/m, "function useDeviceSync");
  src = src.replace(/^export default useDeviceSync;\s*$/m, "");
  // eslint-disable-next-line no-new-func
  return new Function(
    "useState", "useEffect", "useCallback", "useMemo", "useRef", "window", "console",
    `${src}\nreturn useDeviceSync;`
  );
}

// ── Minimal hook runtime ─────────────────────────────────────────────────
function mount(hookFactory, windowStub, consoleStub, props) {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let pendingEffects = [];
  let result = null;

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((v, i) => Object.is(v, b[i]));

  function useState(init) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { v: typeof init === "function" ? init() : init };
    const slot = slots[i];
    const set = (next) => {
      const value = typeof next === "function" ? next(slot.v) : next;
      if (Object.is(value, slot.v)) return; // React bails on an identical value
      slot.v = value;
      dirty = true;
    };
    return [slot.v, set];
  }
  function useRef(init) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: init };
    return slots[i];
  }
  function useCallback(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    slots[i] = { value: fn, deps };
    return fn;
  }
  function useMemo(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    const value = fn();
    slots[i] = { value, deps };
    return value;
  }
  function useEffect(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && sameDeps(prev.deps, deps)) return;
    const slot = { deps, cleanup: prev ? prev.cleanup : undefined };
    slots[i] = slot;
    pendingEffects.push(() => {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = fn();
    });
  }

  const useHook = hookFactory(
    useState, useEffect, useCallback, useMemo, useRef, windowStub, consoleStub
  );

  function renderOnce() {
    cursor = 0;
    dirty = false;
    result = useHook(props);
    const effects = pendingEffects;
    pendingEffects = [];
    for (const run of effects) run();
  }

  function settle() {
    renderOnce();
    let guard = 0;
    while (dirty) {
      if (++guard > 50) throw new Error("render loop did not settle");
      renderOnce();
    }
    return result;
  }

  settle();
  return {
    get state() { return result; },
    // Run something external (an IPC callback, a user action), then let the
    // "component" re-render the way React would.
    act(fn) {
      const out = fn();
      settle();
      return out;
    },
    async actAsync(fn) {
      const out = await fn();
      // let any promise chains the hook started resolve
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      settle();
      return out;
    },
  };
}

// ── Test rig ─────────────────────────────────────────────────────────────
const hookFactory = loadHook();

const settleAsync = () => new Promise((r) => setImmediate(r));

// A get-state answer shaped like service.js H["get-state"] (enabled).
function snapshot(extra = {}) {
  return {
    ok: true,
    enabled: true,
    settings: { syncEnabled: true },
    specs: { syncEnabled: {} },
    config: { version: 3, targets: [{ id: "t1", kind: "folder" }] },
    adb: { binary: "/x/adb", serverVersion: 41, error: null, tracking: "track" },
    devices: [{ serial: "S1", state: "device" }],
    folderPresence: { t1: true },
    job: { job: { runId: 5, phase: "apply", targetId: "t1", state: "running", progress: { filesDone: 1, filesTotal: 9 } }, queue: [{ targetId: "t2" }] },
    plans: { t1: { summary: { ops: 3 }, refusal: null, stale: false } },
    prompt: null,
    prompts: [],
    find: null,
    prewarm: { state: "idle" },
    ...extra,
  };
}

function makeHarness({ snap = snapshot(), delayed = false, noApi = false } = {}) {
  const listeners = [];
  const calls = { getState: 0, invokes: [], unsub: 0 };
  let release;
  let reject;
  const first = delayed
    ? new Promise((res, rej) => { release = () => res(snap); reject = rej; })
    : Promise.resolve(snap);
  const harness = {
    calls,
    // Later get-state answers (plans refresh): a queue of {value, gate}.
    nextStates: [],
    answers: {},
    release: () => release && release(),
    reject: (e) => reject && reject(e),
    emit(ev) { for (const cb of listeners.slice()) cb(ev); },
    mounted: null,
  };
  const electronAPI = {
    onSyncEvent(cb) {
      listeners.push(cb);
      return () => { calls.unsub += 1; const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    syncGetState() {
      calls.getState += 1;
      if (calls.getState === 1) return first;
      const n = harness.nextStates.shift();
      return n ? n.promise : Promise.resolve(snap);
    },
  };
  for (const fn of ["syncConfigOp", "syncPlan", "syncApply", "syncLink", "syncFindSourcesGet", "syncCancel"]) {
    electronAPI[fn] = (p) => { calls.invokes.push([fn, p]); return Promise.resolve(harness.answers[fn] || { ok: true }); };
  }
  const windowStub = noApi ? {} : { electronAPI };
  harness.mounted = mount(hookFactory, windowStub, console, undefined);
  return harness;
}

function deferred(value) {
  let resolve;
  const promise = new Promise((r) => { resolve = () => r(value); });
  return { promise, resolve };
}

(async function run() {
  console.log("\n[1] snapshot adoption");
  {
    const h = makeHarness();
    eq("not loaded before the snapshot resolves", h.mounted.state.loaded, false);
    await h.mounted.actAsync(() => {});
    const s = h.mounted.state;
    eq("loaded", s.loaded, true);
    eq("enabled", s.enabled, true);
    eq("job from jobs.snapshot().job", s.job && s.job.runId, 5);
    eq("queue from jobs.snapshot().queue", s.queue, [{ targetId: "t2" }]);
    eq("devices", s.devices, [{ serial: "S1", state: "device" }]);
    eq("plans", s.plans.t1.summary, { ops: 3 });
    eq("config", s.config.version, 3);
    eq("adb", s.adb.tracking, "track");
    eq("prewarm", s.prewarm, { state: "idle" });
    eq("subscribed once, get-state read once", [h.calls.getState, h.calls.unsub], [1, 0]);
  }

  console.log("\n[2] events racing the snapshot are buffered");
  {
    const h = makeHarness({ delayed: true });
    h.mounted.act(() => {
      h.emit({ kind: "device", devices: [{ serial: "S2", state: "device" }], folderPresence: {} });
      h.emit({ kind: "job", runId: 5, state: "running", progress: { filesDone: 4 } });
      h.emit({ kind: "prompt", action: "show", prompt: { promptId: "p1" }, prompts: [{ promptId: "p1" }] });
    });
    eq("nothing applied before the snapshot", [h.mounted.state.loaded, h.mounted.state.devices.length], [false, 0]);
    h.release();
    await h.mounted.actAsync(() => {});
    const s = h.mounted.state;
    eq("buffered device event wins over the snapshot", s.devices.map((d) => d.serial), ["S2"]);
    eq("buffered progress folds into the snapshot's job", s.job.progress, { filesDone: 4, filesTotal: 9 });
    eq("buffered prompt applied", s.prompt, { promptId: "p1" });
  }

  console.log("\n[3] stale runId");
  {
    const h = makeHarness();
    await h.mounted.actAsync(() => {});
    h.mounted.act(() => h.emit({ kind: "job", runId: 4, state: "running", progress: { filesDone: 8 } }));
    eq("progress of an older run dropped", h.mounted.state.job.progress.filesDone, 1);
    h.mounted.act(() => h.emit({ kind: "job", runId: 4, state: "done", status: "completed", job: { runId: 4, state: "done", status: "completed", progress: {} } }));
    eq("finish of an older run dropped", [h.mounted.state.job.runId, h.mounted.state.job.state], [5, "running"]);
    h.mounted.act(() => h.emit({ kind: "job", runId: 5, state: "running", progress: { filesDone: 2 } }));
    eq("progress of the live run applied", h.mounted.state.job.progress, { filesDone: 2, filesTotal: 9 });
    h.mounted.act(() => h.emit({ kind: "job", runId: 5, state: "done", status: "completed", summary: {}, job: { runId: 5, state: "done", status: "completed", progress: { filesDone: 9, filesTotal: 9 } } }));
    eq("finish of the live run applied", [h.mounted.state.job.state, h.mounted.state.job.status], ["done", "completed"]);
    h.mounted.act(() => h.emit({ kind: "job", runId: 5, state: "running", progress: { filesDone: 3 } }));
    eq("a late progress after finish dropped", h.mounted.state.job.progress.filesDone, 9);
    h.mounted.act(() => h.emit({ kind: "job", runId: 6, state: "running", job: { runId: 6, phase: "plan", state: "running", progress: { filesDone: 0 } } }));
    eq("a newer run's begin adopted", [h.mounted.state.job.runId, h.mounted.state.job.phase], [6, "plan"]);
  }

  console.log("\n[4] plans re-read on job finish and config (latest wins)");
  {
    const h = makeHarness();
    await h.mounted.actAsync(() => {});
    const slow = deferred(snapshot({ plans: { t1: { summary: { ops: 111 }, refusal: null, stale: false } } }));
    const fast = deferred(snapshot({ plans: { t1: { summary: { ops: 222 }, refusal: null, stale: true } } }));
    h.nextStates.push(slow, fast);
    h.mounted.act(() => h.emit({ kind: "job", runId: 5, state: "done", status: "completed", job: { runId: 5, state: "done", progress: {} } }));
    h.mounted.act(() => h.emit({ kind: "config", config: { version: 4, targets: [] } }));
    eq("two refreshes requested", h.calls.getState, 3);
    eq("config applied at once", h.mounted.state.config.version, 4);
    fast.resolve();
    await h.mounted.actAsync(() => {});
    slow.resolve();
    await h.mounted.actAsync(() => {});
    eq("the later request's plans kept", h.mounted.state.plans.t1, { summary: { ops: 222 }, refusal: null, stale: true });
    eq("a plans refresh leaves the job alone", h.mounted.state.job.state, "done");
    h.mounted.act(() => h.emit({ kind: "job", runId: 5, state: "running", progress: { filesDone: 1 } }));
    eq("progress triggers no refresh", h.calls.getState, 3);
  }

  console.log("\n[5] find-sources");
  {
    const h = makeHarness();
    await h.mounted.actAsync(() => {});
    h.answers.syncFindSourcesGet = { ok: true, targetId: "t1", running: false, rows: [{ folder: "A", state: "queued" }, { folder: "B", state: "done" }] };
    const r = await h.mounted.actAsync(() => h.mounted.state.actions.findSourcesGet({ targetId: "t1" }));
    eq("findSourcesGet answers the IPC result", r.ok, true);
    eq("rows stored by folder", Object.keys(h.mounted.state.findRows.t1), ["A", "B"]);
    h.mounted.act(() => h.emit({ kind: "find", targetId: "t1", state: "running", done: 0, total: 2 }));
    eq("batch status", h.mounted.state.find, { targetId: "t1", waiting: null, done: 0, total: 2 });
    h.mounted.act(() => h.emit({ kind: "find", targetId: "t1", state: "running", done: 1, total: 2, row: { folder: "A", state: "done" } }));
    eq("row patched", h.mounted.state.findRows.t1.A.state, "done");
    eq("other rows kept", h.mounted.state.findRows.t1.B.state, "done");
    h.mounted.act(() => h.emit({ kind: "find", targetId: "t1", state: "running", row: { folder: "B", state: "queued", query: "x" } }));
    eq("a row-only edit keeps the batch status", h.mounted.state.find, { targetId: "t1", waiting: null, done: 1, total: 2 });
    eq("...and patches its row", h.mounted.state.findRows.t1.B.query, "x");
    h.mounted.act(() => h.emit({ kind: "find", targetId: "t1", state: "waiting", done: 1, total: 2, waiting: "download" }));
    eq("waiting", h.mounted.state.find.waiting, "download");
    h.mounted.act(() => h.emit({ kind: "find", targetId: "t1", state: "done", done: 2, total: 2 }));
    eq("batch end clears status", h.mounted.state.find, null);
  }

  console.log("\n[6] other kinds; unknown ignored; actions pass through");
  {
    const h = makeHarness();
    await h.mounted.actAsync(() => {});
    h.mounted.act(() => h.emit({ kind: "prewarm", prewarm: { state: "running", done: 3 } }));
    eq("prewarm", h.mounted.state.prewarm, { state: "running", done: 3 });
    h.mounted.act(() => h.emit({ kind: "library-status", status: { series: 2 } }));
    eq("library-status", h.mounted.state.libraryStatus, { series: 2 });
    h.mounted.act(() => h.emit({ kind: "prompt", action: "withdraw", prompt: { promptId: "p1" }, prompts: [] }));
    eq("prompt withdrawn", [h.mounted.state.prompt, h.mounted.state.prompts], [null, []]);
    const before = JSON.stringify(h.mounted.state);
    h.mounted.act(() => { h.emit({ kind: "bogus", x: 1 }); h.emit(null); h.emit("str"); });
    eq("unknown and malformed events ignored", JSON.stringify(h.mounted.state), before);
    h.answers.syncLink = { ok: false, code: "busy", message: "another sync job is running" };
    const r = await h.mounted.actAsync(() => h.mounted.state.actions.link({ targetId: "t1", suggestionIds: ["link:a=>b"] }));
    eq("a refusal comes back verbatim", r, { ok: false, code: "busy", message: "another sync job is running" });
    eq("payload passed through", h.calls.invokes.find((c) => c[0] === "syncLink")[1], { targetId: "t1", suggestionIds: ["link:a=>b"] });
    const a1 = h.mounted.state.actions;
    h.mounted.act(() => h.emit({ kind: "prewarm", prewarm: null }));
    check("actions identity is stable across renders", a1 === h.mounted.state.actions);
  }

  console.log("\n[7] disabled snapshot, then refresh()");
  {
    const off = { ok: true, enabled: false, settings: { syncEnabled: false }, config: null, adb: null, devices: [], folderPresence: {}, job: { job: null, queue: [] }, plans: {}, prompt: null, prompts: [], find: null, prewarm: null };
    const h = makeHarness({ snap: off });
    await h.mounted.actAsync(() => {});
    eq("disabled adopted", [h.mounted.state.loaded, h.mounted.state.enabled, h.mounted.state.job], [true, false, null]);
    const on = deferred(snapshot());
    h.nextStates.push(on);
    const p = h.mounted.state.actions.refresh();
    on.resolve();
    await h.mounted.actAsync(() => p);
    eq("refresh adopts the new snapshot", [h.mounted.state.enabled, h.mounted.state.job.runId], [true, 5]);
  }

  console.log("\n[8] no electronAPI: inert");
  {
    const h = makeHarness({ noApi: true });
    await h.mounted.actAsync(() => {});
    eq("no get-state, not loaded", [h.calls.getState, h.mounted.state.loaded], [0, false]);
    const r = await h.mounted.state.actions.apply({ targetId: "t1" });
    eq("actions answer disabled", [r.ok, r.code], [false, "disabled"]);
    eq("refresh resolves null", await h.mounted.state.actions.refresh(), null);
  }

  console.log("\n[9] a failed get-state still finishes loading");
  {
    const h = makeHarness({ snap: { ok: false, code: "disabled", message: "sync could not start" } });
    h.mounted.act(() => h.emit({ kind: "prewarm", prewarm: { state: "x" } }));
    await h.mounted.actAsync(() => {});
    eq("loaded with defaults plus buffered events", [h.mounted.state.loaded, h.mounted.state.enabled, h.mounted.state.prewarm], [true, false, { state: "x" }]);
  }

  console.log("\n[10] a rejected get-state still drains the buffer");
  {
    const h = makeHarness({ snap: null, delayed: true });
    h.mounted.act(() => h.emit({ kind: "prewarm", prewarm: { state: "y" } }));
    await h.mounted.actAsync(() => {});
    eq("not loaded while get-state is pending", h.mounted.state.loaded, false);
    h.reject(new Error("ipc down"));
    await h.mounted.actAsync(() => {});
    eq("loaded with defaults plus buffered events", [h.mounted.state.loaded, h.mounted.state.prewarm], [true, { state: "y" }]);
  }

  console.log(failures === 0 ? "\nAll useDeviceSync checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
