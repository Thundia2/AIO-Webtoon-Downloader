// Offline regression for searcher.js's cancel path and electron/proc-kill.js
// (deviceSync P4; non-UI plan, Integration edits → searcher.js, review #11).
//
// A fake search backend (a Python script written to a temp dir) stands in
// for aio-dl.py. Its query picks the behavior: "tree" spawns a grandchild
// and sleeps, "ok" prints the JSON contract and exits, "held" exits at once
// while a grandchild keeps stdout open for 1.5 s (the exit-before-close
// window).
//
//   node tools/_test_searcher_cancel.js
//   ELECTRON_RUN_AS_NODE=1 UI-source/node_modules/electron/dist/electron tools/_test_searcher_cancel.js
//   TEST_ONLY=<regex> runs the matching tests only.
//
// Needs python3 (or PYTHON=<cmd>) on PATH. tools/ is gitignored; this file is
// force-added on wip/device-sync-handoff only and never ships.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Searcher } = require(path.join(__dirname, "..", "UI-source", "electron", "searcher.js"));
const { killTree, trackChild } = require(path.join(__dirname, "..", "UI-source", "electron", "proc-kill.js"));

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-searcher-cancel-"));
const SCRIPT = path.join(TMP, "fake_aio_dl.py");
fs.writeFileSync(
  SCRIPT,
  `import json, os, subprocess, sys, time
q = sys.argv[sys.argv.index("--search") + 1]
pidfile = os.environ.get("FAKE_PIDFILE")
if q == "tree":
    gc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(pidfile, "w") as f:
        f.write("%d %d" % (os.getpid(), gc.pid))
    sys.stderr.write("[*] Searching 3 sites...\\n"); sys.stderr.flush()
    time.sleep(60)
elif q == "held":
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.5)"])
    print(json.dumps({"candidates": [{"title": "held"}]})); sys.stdout.flush()
    os._exit(0)
else:
    print(json.dumps({"candidates": [{"title": q}]}))
`,
);

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Alive and not a zombie. The container's PID 1 may not reap orphans, so a
// killed grandchild can linger as Z; that counts as dead.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/^\d+ \(.*\) Z/.test(st)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function run(searcher, query) {
  return searcher.runSearch({ pythonCmd: PY, scriptPath: SCRIPT, workingDir: TMP, query, opts: {} });
}

function mkSearcher(env) {
  const logs = [];
  const s = new Searcher({ onLog: (id, line) => logs.push(line), extraEnv: env || {} });
  s._logs = logs;
  return s;
}

let seq = 0;
async function startTree(s) {
  const pidfile = path.join(TMP, `pids-${++seq}.txt`);
  s._extraEnv = { FAKE_PIDFILE: pidfile };
  const p = run(s, "tree");
  p.catch(() => {});
  await waitFor(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").includes(" "), 10000, "pidfile");
  const [child, grand] = fs.readFileSync(pidfile, "utf8").trim().split(" ").map(Number);
  return { p, child, grand };
}

test("cancel kills the child and its grandchild; rejection has cancelled:true", async () => {
  const s = mkSearcher();
  const { p, child, grand } = await startTree(s);
  assert.ok(alive(child) && alive(grand), "both alive before cancel");
  assert.strictEqual(s.cancel(), true);
  const err = await p.then(
    () => null,
    (e) => e,
  );
  assert.ok(err && err.cancelled === true, `cancelled rejection, got ${err && err.message}`);
  await waitFor(() => !alive(child) && !alive(grand), 5000, "tree gone");
  assert.strictEqual(s.isRunning(), false);
});

test("cancel then an immediate new search: old promise cancelled, new one resolves", async () => {
  const s = mkSearcher();
  const { p, grand } = await startTree(s);
  assert.strictEqual(s.cancel(), true);
  const p2 = run(s, "second");
  const [r1, r2] = await Promise.allSettled([p, p2]);
  assert.strictEqual(r1.status, "rejected");
  assert.strictEqual(r1.reason.cancelled, true);
  assert.strictEqual(r2.status, "fulfilled", r2.reason && r2.reason.message);
  assert.strictEqual(r2.value.candidates[0].title, "second");
  await waitFor(() => !alive(grand), 5000, "old grandchild gone");
});

test("runSearch's own cancel-previous path: the old process's late close stays cancelled", async () => {
  const s = mkSearcher();
  const { p } = await startTree(s);
  const p2 = run(s, "third"); // runSearch cancels the running one itself
  const [r1, r2] = await Promise.allSettled([p, p2]);
  assert.strictEqual(r1.status, "rejected");
  assert.strictEqual(r1.reason.cancelled, true, r1.reason.message);
  assert.strictEqual(r2.status, "fulfilled");
});

test("cancel after the child exited (close still pending) returns false and the result stands", async () => {
  const s = mkSearcher();
  const p = run(s, "held");
  const proc = s._proc;
  await new Promise((r) => proc.once("exit", r));
  assert.ok(s.isRunning(), "close not yet delivered (grandchild holds stdout)");
  assert.strictEqual(s.cancel(), false);
  const res = await p;
  assert.strictEqual(res.candidates[0].title, "held");
  assert.strictEqual(s.cancel(), false, "nothing running after close");
});

test("cancelAndWait resolves on close", async () => {
  const s = mkSearcher();
  const { p, child, grand } = await startTree(s);
  let closed = false;
  s._proc.once("close", () => {
    closed = true;
  });
  const r = await s.cancelAndWait();
  assert.deepStrictEqual(r, { wasRunning: true });
  assert.strictEqual(closed, true, "close fired before cancelAndWait resolved");
  await p.catch(() => {});
  await waitFor(() => !alive(child) && !alive(grand), 5000, "tree gone");
  assert.deepStrictEqual(await s.cancelAndWait(), { wasRunning: false });
});

test("cancelNow fires a synchronous tree kill", async () => {
  const s = mkSearcher();
  const { p, child, grand } = await startTree(s);
  assert.strictEqual(s.cancelNow(), true);
  const err = await p.then(
    () => null,
    (e) => e,
  );
  assert.ok(err && err.cancelled);
  await waitFor(() => !alive(child) && !alive(grand), 5000, "tree gone");
});

test("killTree on a child that ignores SIGTERM escalates and still resolves", async () => {
  if (process.platform === "win32") return; // taskkill /f is already forceful
  const { spawn } = require("child_process");
  const c = spawn(PY, ["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('r', flush=True); time.sleep(60)"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  trackChild(c);
  await new Promise((r) => c.stdout.once("data", r));
  const t0 = Date.now();
  const r = await killTree(c, { timeoutMs: 300 });
  assert.strictEqual(r.closed, true);
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(c.signalCode, "SIGKILL");
});

test("killTree on an untracked, already-exited child resolves without signalling", async () => {
  const { spawn } = require("child_process");
  const c = spawn(PY, ["-c", "pass"], { stdio: "ignore" });
  await new Promise((r) => c.once("close", r));
  const r = await killTree(c, { timeoutMs: 100 });
  assert.deepStrictEqual(r, { closed: true });
});

(async () => {
  const only = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
  for (const t of tests) {
    if (only && !only.test(t.name)) continue;
    try {
      await Promise.race([t.fn(), sleep(20000).then(() => Promise.reject(new Error("test timed out (20 s)")))]);
      passed += 1;
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL ${t.name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n       ")}`);
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed (node ${process.versions.node})`);
  process.exit(failed ? 1 : 0);
})();
