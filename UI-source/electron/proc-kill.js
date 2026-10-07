// ============================================================
// PROC-KILL — kill a child process and everything it spawned
//
// Owns: the one tree-kill spelling shared by searcher.js and
//   sync/find-sources.js (through Searcher). downloader.js keeps its inline
//   copy (downloader.js cancel(), grep taskkill) because that file is
//   in-flight; switch it here at ship time (plan open decision 3).
// Read by: searcher.js (cancel / cancelAndWait), sync/service.js
//   (shutdownNow → killTreeNow through Searcher.cancelNow).
// Depends on: child_process only. No electron.
//
// Why a tree kill: Python search/download children start Playwright, which
// starts Chromium. ChildProcess.kill() on Windows is TerminateProcess on the
// python.exe alone, so the grandchildren survive, keep the browser profile
// locked and hold files open (setup.js deleteEnv's rmSync then fails EBUSY).
//   win32:  `taskkill /pid N /t /f` (exit code 1, signal null on the child).
//   others: the child must be spawned `detached: true` so it leads its own
//           process group; process.kill(-pid) then reaches the whole group.
//           A child that isn't a group leader falls back to child.kill().
// ============================================================

const { spawn } = require("child_process");

// child → Promise that resolves on its "close" event. Filled by trackChild()
// at spawn time, so killTree can tell "already closed" from "exited, close
// not delivered yet" without reading ChildProcess internals.
const _closed = new WeakMap();

/**
 * Register a freshly spawned child so killTree can await its close even if
 * the close event fires before killTree is called. Idempotent.
 * @returns {Promise<void>} resolves on the child's "close" (or "error" before spawn).
 */
function trackChild(child) {
  if (!child) return Promise.resolve();
  let p = _closed.get(child);
  if (!p) {
    p = new Promise((resolve) => {
      child.once("close", () => resolve());
      // A spawn failure emits "error" and may never emit "close".
      child.once("error", () => {
        if (child.pid == null) resolve();
      });
    });
    _closed.set(child, p);
  }
  return p;
}

function _exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

// Fire the platform kill. `detached` (win32) spawns taskkill outside libuv's
// kill-on-close job object and unrefs it, so it outlives an app.exit() that
// follows immediately (shutdownNow; plan deviation 8).
function _signalTree(child, signal, detached) {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    try {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
        detached: !!detached,
      });
      tk.on("error", () => {});
      if (detached) tk.unref();
    } catch {
      /* taskkill missing: nothing better to try */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Kill `child` and its descendants.
 *
 * Contract: resolves (never rejects) with {closed:true} once the child's
 * "close" fired, or {closed:false} when it hadn't after `timeoutMs` plus a
 * SIGKILL grace second. A child that already exited is not signalled again
 * (its PID may be recycled), only awaited.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {{timeoutMs?: number, detached?: boolean}} [opts]
 */
function killTree(child, { timeoutMs = 5000, detached = false } = {}) {
  if (!child) return Promise.resolve({ closed: true });
  const tracked = _closed.has(child);
  const closeP = trackChild(child);
  // Untracked and already exited: we can't know whether close already fired,
  // so don't wait on it.
  if (!tracked && _exited(child)) return Promise.resolve({ closed: true });
  if (!_exited(child)) _signalTree(child, "SIGTERM", detached);

  return new Promise((resolve) => {
    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(t1);
      clearTimeout(t2);
      resolve({ closed });
    };
    let t2 = null;
    const t1 = setTimeout(() => {
      if (process.platform !== "win32" && !_exited(child)) _signalTree(child, "SIGKILL", false);
      t2 = setTimeout(() => finish(false), 1000);
    }, timeoutMs);
    closeP.then(() => finish(true));
  });
}

/**
 * Synchronous best effort for shutdownNow(): fire the kill and return.
 * win32 spawns a detached, unref'd taskkill; elsewhere SIGKILLs the group.
 * Contract: never throws; returns true when a signal was sent.
 */
function killTreeNow(child) {
  try {
    if (!child || child.pid == null || _exited(child)) return false;
    _signalTree(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL", true);
    return true;
  } catch {
    return false;
  }
}

module.exports = { killTree, killTreeNow, trackChild };
