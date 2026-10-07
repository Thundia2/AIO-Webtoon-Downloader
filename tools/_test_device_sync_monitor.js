// Offline regression for UI-source/electron/sync/monitor.js (deviceSync P4):
// device tracking against tools/fake-adb-server.js (frames, backoff, the
// polling fallback, a server restart), folder presence, the persisted prompt
// marks (boot epoch, 30-minute limit) and the focus-aware prompt state
// machine (non-UI plan, Verification → "Monitor").
//
// Backoff and poll delays run on scaled timers (÷100), so a 2 s backoff
// takes 20 ms; the clock for mark ages is a fake.
//
//   node tools/_test_device_sync_monitor.js
//   ELECTRON_RUN_AS_NODE=1 UI-source/node_modules/electron/dist/electron tools/_test_device_sync_monitor.js
//   TEST_ONLY=<regex> runs the matching tests only.
//
// tools/ is gitignored; this file is force-added on wip/device-sync-handoff
// only and never ships.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SYNC = path.join(__dirname, "..", "UI-source", "electron", "sync");
const mon = require(path.join(SYNC, "monitor.js"));
const { AdbClient } = require(path.join(SYNC, "adb", "client.js"));
const { FakeAdbServer } = require(path.join(__dirname, "fake-adb-server.js"));

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-sync-monitor-"));
let dirSeq = 0;
const mkdir = () => {
  const d = path.join(TMP, String(++dirSeq));
  fs.mkdirSync(d);
  return d;
};

const SCALE = 100;
const fastTimers = {
  setTimeout: (f, ms) => setTimeout(f, Math.max(1, ms / SCALE)),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (f, ms) => setInterval(f, Math.max(1, ms / SCALE)),
  clearInterval: (t) => clearInterval(t),
};

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function clock(t0 = 1_800_000_000_000) {
  const c = { t: t0 };
  c.now = () => c.t;
  return c;
}

function tracked(server, extra = {}) {
  const client = new AdbClient({ port: server.port, recheckMs: 10 });
  const events = [];
  const states = [];
  const tr = new mon.DeviceTracker({
    client,
    timers: fastTimers,
    onDevices: (rows, info) => events.push({ rows, source: info.source }),
    onState: (s) => states.push(s),
    ...extra,
  });
  tr.events = events;
  tr.states = states;
  return tr;
}

const lastRows = (tr) => (tr.events.length ? tr.events[tr.events.length - 1].rows : null);

// ---------------------------------------------------------------- tracker

test("backoff doubles from 2 s and caps at 60 s", () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 9].map((n) => mon.DeviceTracker.backoffMs(n)), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test("track: a device attached at start is in the first frame; plug and unplug follow", async () => {
  const srv = new FakeAdbServer();
  await srv.listen();
  const d = srv.addDevice({ serial: "SER1" });
  const tr = tracked(srv);
  try {
    tr.start();
    await waitFor(() => tr.events.length >= 1, 2000, "first frame");
    assert.strictEqual(tr.events[0].source, "track");
    assert.deepStrictEqual(tr.events[0].rows.map((r) => [r.serial, r.state, r.transportId]), [["SER1", "device", d.transportId]]);
    assert.strictEqual(tr.mode, "tracking");
    srv.addDevice({ serial: "SER2" });
    await waitFor(() => (lastRows(tr) || []).length === 2, 2000, "second device");
    await srv.unplug("SER1", { order: "eof-first" });
    await waitFor(() => (lastRows(tr) || []).map((r) => r.serial).join() === "SER2", 2000, "unplug frame");
  } finally {
    tr.stop();
    await srv.close();
  }
});

test("track: an empty `0000` frame is an empty list", async () => {
  const srv = new FakeAdbServer();
  await srv.listen();
  const tr = tracked(srv);
  try {
    tr.start();
    await waitFor(() => tr.events.length >= 1, 2000, "first frame");
    assert.deepStrictEqual(tr.events[0].rows, []);
  } finally {
    tr.stop();
    await srv.close();
  }
});

test("a server restart: `lost` with no rows, then a fresh frame with restarted ids", async () => {
  const srv = new FakeAdbServer();
  await srv.listen();
  srv.addDevice({ serial: "SER1" });
  srv.addDevice({ serial: "SER2" });
  const tr = tracked(srv);
  try {
    tr.start();
    await waitFor(() => tr.events.length >= 1, 2000, "first frame");
    assert.deepStrictEqual(tr.events[0].rows.map((r) => r.transportId), [1, 2]);
    await srv.unplug("SER1", { order: "eof-first" });
    await waitFor(() => lastRows(tr).length === 1, 2000, "unplug");
    await srv.restart();
    await waitFor(() => tr.events.some((e) => e.source === "lost"), 2000, "lost");
    const lostAt = tr.events.findIndex((e) => e.source === "lost");
    assert.deepStrictEqual(tr.events[lostAt].rows, []);
    await waitFor(() => tr.events.length > lostAt + 1, 3000, "frame after restart");
    assert.deepStrictEqual(lastRows(tr).map((r) => [r.serial, r.transportId]), [["SER2", 1]]);
  } finally {
    tr.stop();
    await srv.close();
  }
});

test("3 straight track failures start polling devices -l; tracking again stops it", async () => {
  const srv = new FakeAdbServer({ inject: { trackFail: true } });
  await srv.listen();
  srv.addDevice({ serial: "SER1" });
  const tr = tracked(srv);
  try {
    tr.start();
    await waitFor(() => tr.events.some((e) => e.source === "poll"), 3000, "a poll");
    assert.ok(tr.failStreak >= mon.TRACK_FAILS_BEFORE_POLL, `failStreak ${tr.failStreak}`);
    assert.strictEqual(tr.polling, true);
    assert.deepStrictEqual(tr.events.find((e) => e.source === "poll").rows.map((r) => r.serial), ["SER1"]);
    // No poll before the third failure.
    const firstPollState = tr.states.findIndex((s) => s.mode === "polling");
    assert.strictEqual(tr.states[firstPollState].failStreak, mon.TRACK_FAILS_BEFORE_POLL);
    srv.inject.trackFail = false;
    await waitFor(() => tr.mode === "tracking", 5000, "tracking again");
    assert.strictEqual(tr.polling, false);
    assert.strictEqual(tr.pollTimer, null);
    const n = tr.events.length;
    await sleep(3 * (mon.POLL_MS / SCALE));
    assert.ok(tr.events.slice(n).every((e) => e.source === "track"), "no poll after tracking resumed");
  } finally {
    tr.stop();
    await srv.close();
  }
});

test("server down: polling reports `lost`; ensureServer is asked before each retry", async () => {
  const srv = new FakeAdbServer();
  await srv.listen();
  const port = srv.port;
  await srv.close(); // nothing listens on the port
  let ensures = 0;
  const client = new AdbClient({ port, connectTimeoutMs: 200 });
  const events = [];
  const tr = new mon.DeviceTracker({
    client,
    timers: fastTimers,
    ensureServer: async () => {
      ensures += 1;
      if (ensures === 4) {
        await srv.listen(port);
        srv.addDevice({ serial: "BACK" });
      }
      return { ok: ensures >= 4 };
    },
    onDevices: (rows, info) => events.push({ rows, source: info.source }),
  });
  try {
    tr.start();
    await waitFor(() => events.some((e) => e.source === "track"), 8000, "tracking after the server came up");
    assert.ok(ensures >= 3, `ensures ${ensures}`);
    assert.ok(events.some((e) => e.source === "lost"), "polling reported the server unreachable");
    assert.deepStrictEqual(events[events.length - 1].rows.map((r) => r.serial), ["BACK"]);
  } finally {
    tr.stop();
    await srv.close();
  }
});

test("stop() closes the tracking socket and schedules nothing", async () => {
  const srv = new FakeAdbServer();
  await srv.listen();
  const tr = tracked(srv);
  tr.start();
  await waitFor(() => tr.events.length >= 1, 2000, "first frame");
  tr.stop();
  await waitFor(() => srv.trackers.size === 0, 2000, "tracker closed");
  const n = tr.events.length;
  srv.addDevice({ serial: "LATE" });
  await sleep(50);
  assert.strictEqual(tr.events.length, n);
  assert.strictEqual(tr.retryTimer, null);
  await srv.close();
});

// ---------------------------------------------------------------- folders

test("FolderWatcher: reports the first answer and changes only; a removed target reads absent", async () => {
  const present = { a: true, b: false };
  const tp = (id) => ({ checkPresence: async () => ({ present: present[id] }) });
  const ta = tp("a");
  const tb = tp("b");
  const seen = [];
  const w = new mon.FolderWatcher({ onChange: (id, p) => seen.push(`${id}:${p}`), timers: fastTimers });
  try {
    w.setTargets([
      { targetId: "a", transport: ta },
      { targetId: "b", transport: tb },
    ]);
    await waitFor(() => seen.length === 2, 1000, "first answers");
    assert.deepStrictEqual(seen.sort(), ["a:true", "b:false"]);
    await sleep(3 * (mon.POLL_MS / SCALE));
    assert.strictEqual(seen.length, 2, "no repeats without a change");
    present.b = true;
    await waitFor(() => seen.includes("b:true"), 1000, "b appears");
    w.setTargets([{ targetId: "b", transport: tb }]);
    assert.ok(seen.includes("a:false"), "a removed while present reads absent");
    assert.deepStrictEqual(w.presence(), { b: true });
  } finally {
    w.stop();
  }
  assert.strictEqual(w.timer, null);
});

test("FolderWatcher: a presence check that throws reads absent", async () => {
  const seen = [];
  const w = new mon.FolderWatcher({ onChange: (id, p) => seen.push(`${id}:${p}`), timers: fastTimers });
  w.setTargets([{ targetId: "x", transport: { checkPresence: async () => Promise.reject(new Error("boom")) } }]);
  await waitFor(() => seen.length === 1, 1000, "answer");
  w.stop();
  assert.deepStrictEqual(seen, ["x:false"]);
});

// ---------------------------------------------------------------- marks

test("marks: honored for the same connection and boot epoch, for 30 minutes only", async () => {
  const c = clock();
  const dir = mkdir();
  const m = new mon.PromptMarks({ dir, now: c.now, bootEpoch: 111 });
  await m.load();
  assert.strictEqual(m.honored("SER1#3"), false);
  await m.set("SER1#3");
  assert.strictEqual(m.honored("SER1#3"), true);
  assert.strictEqual(m.honored("SER1#4"), false, "a new transport id is a new connection");
  c.t += mon.MARK_TTL_MS - 1;
  assert.strictEqual(m.honored("SER1#3"), true);
  c.t += 1;
  assert.strictEqual(m.honored("SER1#3"), false, "exactly 30 minutes is too old");
});

test("marks: persisted across an app restart; another boot epoch doesn't match", async () => {
  const c = clock();
  const dir = mkdir();
  const m1 = new mon.PromptMarks({ dir, now: c.now, bootEpoch: 111 });
  await m1.load();
  await m1.set("SER1#1");
  const file = JSON.parse(fs.readFileSync(path.join(dir, mon.MARKS_FILE), "utf8"));
  assert.deepStrictEqual(Object.keys(file.marks), ["SER1#1#111"]);
  c.t += 60 * 1000;
  const m2 = new mon.PromptMarks({ dir, now: c.now, bootEpoch: 111 });
  await m2.load();
  assert.strictEqual(m2.honored("SER1#1"), true, "app restart, same connection");
  const m3 = new mon.PromptMarks({ dir, now: c.now, bootEpoch: 222 });
  await m3.load();
  assert.strictEqual(m3.honored("SER1#1"), false, "PC reboot: the reused id must not match");
  c.t += mon.MARK_TTL_MS;
  const m4 = new mon.PromptMarks({ dir, now: c.now, bootEpoch: 111 });
  await m4.load();
  assert.strictEqual(m4.honored("SER1#1"), false, "Fast Startup: same boot epoch, but older than 30 min");
});

test("marks: a corrupt or missing file loads empty; removeAdb keeps folder marks", async () => {
  const c = clock();
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, mon.MARKS_FILE), "{not json");
  const m = new mon.PromptMarks({ dir, now: c.now, bootEpoch: 1 });
  await m.load();
  assert.strictEqual(m.marks.size, 0);
  await m.set("SER1#1");
  await m.set("folder:t1");
  await m.removeAdb();
  assert.strictEqual(m.honored("SER1#1"), false);
  assert.strictEqual(m.honored("folder:t1"), true);
  await m.remove("folder:t1");
  assert.strictEqual(m.honored("folder:t1"), false);
  const m2 = new mon.PromptMarks({ dir, now: c.now, bootEpoch: 1 });
  await m2.load();
  assert.strictEqual(m2.marks.size, 0, "removals persisted");
});

test("bootEpochNow rounds now − uptime to the minute", () => {
  const e = mon.bootEpochNow({ now: () => 10 * 60000 + 29000, uptime: () => 60 });
  assert.strictEqual(e, 9 * 60000);
});

// ---------------------------------------------------------------- prompt machine

async function machine({ focused = true, dir = mkdir(), bootEpoch = 1, c = clock() } = {}) {
  const marks = new mon.PromptMarks({ dir, now: c.now, bootEpoch });
  await marks.load();
  const ev = [];
  const st = { focused };
  const pm = new mon.PromptMachine({ marks, isFocused: () => st.focused, onPrompt: (e) => ev.push(e), now: c.now });
  return { pm, ev, st, marks, dir, c };
}
const CARD = { serial: "SER1", targets: [{ targetId: "t1", files: 3 }], syncNow: false, empty: false };

test("prompt: connect → plan → shown at once when focused, and marked", async () => {
  const { pm, ev, marks } = await machine();
  assert.strictEqual(pm.connected({ connKey: "SER1#1", serial: "SER1", targetIds: ["t1"] }), true);
  assert.strictEqual(ev.length, 0, "nothing before the plan");
  const p = pm.planned("SER1#1", CARD);
  assert.deepStrictEqual(ev.map((e) => e.action), ["show"]);
  assert.strictEqual(ev[0].prompt.promptId, p.promptId);
  assert.deepStrictEqual(pm.shown().map((x) => x.promptId), [p.promptId]);
  assert.strictEqual(marks.honored("SER1#1"), true);
  assert.strictEqual(pm.connected({ connKey: "SER1#1", targetIds: ["t1"] }), false, "same connection again: no second plan");
});

test("prompt: unfocused waits for focus; refocus shows it once", async () => {
  const { pm, ev, st, marks } = await machine({ focused: false });
  pm.connected({ connKey: "SER1#1", targetIds: ["t1"] });
  pm.planned("SER1#1", CARD);
  assert.strictEqual(ev.length, 0);
  assert.strictEqual(marks.honored("SER1#1"), false, "not marked until shown");
  st.focused = true;
  pm.focus();
  pm.focus();
  assert.deepStrictEqual(ev.map((e) => e.action), ["show"]);
  assert.strictEqual(marks.honored("SER1#1"), true);
});

test("prompt: a disconnect withdraws a waiting or shown prompt and clears the mark", async () => {
  const { pm, ev, st, marks } = await machine({ focused: false });
  pm.connected({ connKey: "SER1#1", targetIds: ["t1"] });
  pm.planned("SER1#1", CARD);
  pm.disconnected("SER1#1");
  st.focused = true;
  pm.focus();
  assert.deepStrictEqual(ev.map((e) => e.action), ["withdraw"], "never shown after the device left");
  pm.connected({ connKey: "SER1#2", targetIds: ["t1"] });
  pm.planned("SER1#2", CARD);
  assert.strictEqual(marks.honored("SER1#2"), true);
  pm.disconnected("SER1#2");
  assert.deepStrictEqual(ev.map((e) => e.action), ["withdraw", "show", "withdraw"]);
  assert.strictEqual(marks.honored("SER1#2"), false);
  assert.deepStrictEqual(pm.shown(), []);
});

test("prompt: a plan that finishes after the disconnect shows nothing", async () => {
  const { pm, ev } = await machine();
  pm.connected({ connKey: "SER1#1", targetIds: ["t1"] });
  pm.disconnected("SER1#1");
  assert.strictEqual(pm.planned("SER1#1", CARD), null);
  assert.deepStrictEqual(ev, []);
});

test("prompt: nothing to report is quiet, and marked for this connection", async () => {
  const { pm, ev, marks } = await machine();
  pm.connected({ connKey: "SER1#1", targetIds: ["t1"] });
  assert.strictEqual(pm.planned("SER1#1", { serial: "SER1", targets: [], syncNow: false, empty: true }), null);
  assert.deepStrictEqual(ev, []);
  assert.strictEqual(pm.pendingConn("SER1#1"), "quiet");
  assert.strictEqual(marks.honored("SER1#1"), true);
});

test("prompt: attached at startup after an app restart within 30 min is not re-prompted", async () => {
  const dir = mkdir();
  const c = clock();
  const a = await machine({ dir, c });
  a.pm.connected({ connKey: "SER1#5", targetIds: ["t1"] });
  a.pm.planned("SER1#5", CARD);
  await a.marks.queue.whenIdle();
  c.t += 5 * 60 * 1000;
  const b = await machine({ dir, c }); // the restarted app
  assert.strictEqual(b.pm.connected({ connKey: "SER1#5", targetIds: ["t1"] }), false);
  assert.strictEqual(b.pm.pendingConn("SER1#5"), "marked");
  // ...but after the 30 minutes the same key prompts (Fast Startup morning).
  const c2 = clock(c.t + mon.MARK_TTL_MS);
  const d = await machine({ dir, c: c2 });
  assert.strictEqual(d.pm.connected({ connKey: "SER1#5", targetIds: ["t1"] }), true);
});

test("prompt: after a server restart that reuses the transport id, the prompt appears again", async () => {
  const srv = new FakeAdbServer();
  await srv.listen();
  srv.addDevice({ serial: "SER1" });
  const { pm, ev } = await machine();
  // A miniature of service.js's wiring: rows → connect/disconnect diff.
  let live = new Set();
  const tr = tracked(srv, {
    onDevices: (rows, info) => {
      if (info.source === "lost") {
        pm.lostAdb();
        live = new Set();
        return;
      }
      const now = new Set(rows.filter((r) => r.state === "device").map(mon.adbConnKey));
      for (const k of live) if (!now.has(k)) pm.disconnected(k);
      for (const k of now) if (!live.has(k) && pm.connected({ connKey: k, targetIds: ["t1"] })) pm.planned(k, CARD);
      live = now;
    },
  });
  try {
    tr.start();
    await waitFor(() => ev.length === 1, 2000, "first prompt");
    assert.strictEqual(ev[0].prompt.connKey, "SER1#1");
    await srv.restart(); // same device, transport id 1 again
    await waitFor(() => ev.filter((e) => e.action === "show").length === 2, 3000, "second prompt");
    assert.deepStrictEqual(ev.map((e) => e.action), ["show", "withdraw", "show"]);
    assert.strictEqual(ev[2].prompt.connKey, "SER1#1");
  } finally {
    tr.stop();
    await srv.close();
  }
});

test("prompt: respond answers a shown prompt once; unknown or stale ids are null", async () => {
  const { pm } = await machine();
  pm.connected({ connKey: "SER1#1", targetIds: ["t1", "t2"] });
  const p = pm.planned("SER1#1", CARD);
  assert.strictEqual(pm.respond("nope"), null);
  assert.strictEqual(pm.respond(p.promptId).promptId, p.promptId);
  assert.strictEqual(pm.respond(p.promptId), null, "answered once");
  assert.deepStrictEqual(pm.shown(), []);
});

test("prompt: two devices give two prompts, oldest first", async () => {
  const { pm, c } = await machine();
  pm.connected({ connKey: "A#1", targetIds: ["t1"] });
  pm.connected({ connKey: "B#2", targetIds: ["t2"] });
  const pa = pm.planned("A#1", CARD);
  c.t += 1;
  const pb = pm.planned("B#2", CARD);
  assert.deepStrictEqual(pm.shown().map((x) => x.promptId), [pa.promptId, pb.promptId]);
});

test("prompt: a throwing focus check counts as unfocused", async () => {
  const marks = new mon.PromptMarks({ dir: mkdir(), bootEpoch: 1 });
  await marks.load();
  const ev = [];
  const pm = new mon.PromptMachine({
    marks,
    isFocused: () => {
      throw new Error("no window");
    },
    onPrompt: (e) => ev.push(e),
  });
  pm.connected({ connKey: "X#1", targetIds: ["t"] });
  pm.planned("X#1", CARD);
  assert.strictEqual(pm.pendingConn("X#1"), "waiting-focus");
  assert.deepStrictEqual(ev, []);
});

(async () => {
  const only = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
  for (const t of tests) {
    if (only && !only.test(t.name)) continue;
    try {
      await Promise.race([Promise.resolve().then(t.fn), sleep(20000).then(() => Promise.reject(new Error("test timed out (20 s)")))]);
      passed += 1;
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL ${t.name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 8).join("\n       ")}`);
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed (node ${process.versions.node})`);
  process.exit(failed ? 1 : 0);
})();
