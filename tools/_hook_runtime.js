// Minimal React-hook runtime for offline hook tests: renders ONE hook outside
// React and re-renders it whenever its state changes, the way React would.
// Used by tools/_test_queue_settings_hook.js and tools/_test_search_hook.js
// (grep _hook_runtime). tools/_test_update_check_hook.js (local, untracked)
// still carries its own copy of the same runtime.
//
// Deliberately small: useState / useRef / useCallback / useMemo / useEffect,
// effects run after each render, no StrictMode double-run, no unmount. A
// hook that needs more than this is outside what these tests cover.
// bundleHook esbuild-bundles a real hook file from UI-source/src with "react"
// swapped for a shim over globalThis.__hookRuntime and "@" aliased to src.
// tools/ is gitignored; force-added on wip/device-sync-handoff.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const UI = path.resolve(__dirname, "..", "UI-source");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRuntime() {
  let current = null;
  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((v, i) => Object.is(v, b[i]));
  const api = {
    useState(init) {
      const c = current; const i = c.cursor++;
      if (!(i in c.slots)) c.slots[i] = { v: typeof init === "function" ? init() : init };
      const slot = c.slots[i];
      const set = (next) => {
        const value = typeof next === "function" ? next(slot.v) : next;
        if (Object.is(value, slot.v)) return;
        slot.v = value;
        c.dirty = true;
      };
      return [slot.v, set];
    },
    useRef(init) {
      const c = current; const i = c.cursor++;
      if (!(i in c.slots)) c.slots[i] = { current: init };
      return c.slots[i];
    },
    useCallback(fn, deps) {
      const c = current; const i = c.cursor++;
      const prev = c.slots[i];
      if (prev && sameDeps(prev.deps, deps)) return prev.value;
      c.slots[i] = { value: fn, deps };
      return fn;
    },
    useMemo(fn, deps) {
      const c = current; const i = c.cursor++;
      const prev = c.slots[i];
      if (prev && sameDeps(prev.deps, deps)) return prev.value;
      const value = fn();
      c.slots[i] = { value, deps };
      return value;
    },
    useEffect(fn, deps) {
      const c = current; const i = c.cursor++;
      const prev = c.slots[i];
      if (prev && sameDeps(prev.deps, deps)) return;
      const slot = { deps, cleanup: prev ? prev.cleanup : undefined };
      c.slots[i] = slot;
      c.effects.push(() => {
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.cleanup = fn();
      });
    },
  };
  function mount(hook) {
    const c = { slots: [], cursor: 0, dirty: false, effects: [], result: null };
    function renderOnce() {
      current = c;
      c.cursor = 0;
      c.dirty = false;
      c.result = hook();
      current = null;
      const effects = c.effects;
      c.effects = [];
      for (const run of effects) run();
    }
    function settle() {
      renderOnce();
      let guard = 0;
      while (c.dirty) {
        if (++guard > 50) throw new Error("render loop did not settle");
        renderOnce();
      }
      return c.result;
    }
    settle();
    return {
      get state() { return c.result; },
      settle,
      // Let timers / promise chains the hook started run, re-rendering the
      // way React would whenever state changed.
      async wait(ms) {
        const end = Date.now() + ms;
        do {
          await sleep(10);
          if (c.dirty) settle();
        } while (Date.now() < end);
        settle();
        return c.result;
      },
    };
  }
  return { api, mount };
}

// Bundle UI-source/src/<rel> and import it. Returns the module's exports.
async function bundleHook(rel) {
  const esbuild = require(path.join(UI, "node_modules", "esbuild"));
  const tag = `${process.pid}-${path.basename(rel, path.extname(rel))}`;
  const shim = path.join(os.tmpdir(), `aio-react-shim-${tag}.js`);
  fs.writeFileSync(shim, [
    "const R = () => globalThis.__hookRuntime;",
    "export const useState = (...a) => R().useState(...a);",
    "export const useEffect = (...a) => R().useEffect(...a);",
    "export const useCallback = (...a) => R().useCallback(...a);",
    "export const useMemo = (...a) => R().useMemo(...a);",
    "export const useRef = (...a) => R().useRef(...a);",
    "export default {};",
  ].join("\n"));
  const out = path.join(os.tmpdir(), `aio-hook-${tag}.mjs`);
  try {
    await esbuild.build({
      entryPoints: [path.join(UI, "src", rel)],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: out,
      alias: { "@": path.join(UI, "src"), react: shim },
      nodePaths: [path.join(UI, "node_modules")],
      logLevel: "error",
    });
    return await import(pathToFileURL(out).href);
  } finally {
    fs.rmSync(out, { force: true });
    fs.rmSync(shim, { force: true });
  }
}

module.exports = { makeRuntime, bundleHook, sleep };
