// Offline regression for the Device Sync adb layer
// (UI-source/electron/sync/adb/: wire, client, locate) against
// tools/fake-adb-server.js.
//
// Covers the non-UI plan's "_test_device_sync_adb.js" list (sync-temp/plans/
// c-users-legoc-claude-plans-add-this-scr-noble-truffle.md, Verification)
// for everything the adb layer owns: golden-byte codecs at the AOSP struct
// sizes, frames split at every offset, `devices -l`, shell v2 and legacy,
// the session lifecycle, quiet failures at the primitive level, error kinds,
// byte-exact names, cancel mid-SEND, the v1 and tport fallbacks, and locate /
// start-server. Items that need transports.js, executor.js, monitor.js or
// service.js (the listing-trust rules, the error budget itself, the polling
// fallback, when a server start is allowed) are tested in the phase that
// builds those modules; the P2 report lists them.
//
// The fake's own fidelity is tested here too, on raw sockets: a fake kinder
// than adbd would hide exactly the bugs these tests exist for.
//
//   node tools/_test_device_sync_adb.js
//   ELECTRON_RUN_AS_NODE=1 UI-source/node_modules/electron/dist/electron tools/_test_device_sync_adb.js
//
// tools/ is gitignored; this file is force-added on wip/device-sync-handoff
// only and never ships.

const assert = require("assert");
const net = require("net");
const path = require("path");
const crypto = require("crypto");

const ADB = path.join(__dirname, "..", "UI-source", "electron", "sync", "adb");
const wire = require(path.join(ADB, "wire.js"));
const client = require(path.join(ADB, "client.js"));
const locate = require(path.join(ADB, "locate.js"));
const { FakeAdbServer, MemFs, DEFAULT_FEATURES } = require(path.join(__dirname, "fake-adb-server.js"));

const { AdbClient, AdbError } = client;

let passed = 0;
let failed = 0;
const failures = [];
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString("hex");
const SERIAL = "A06B4A372090333";
const ROOT = "/storage/emulated/0/Komikku/local";

/** A fake server with one device, and a client with short recheck/idle times. */
async function rig({ device = {}, server = {}, clientOpts = {} } = {}) {
  const srv = new FakeAdbServer(server);
  const port = await srv.listen();
  const dev = srv.addDevice({ serial: SERIAL, ...device });
  dev.fs.mkdirs(ROOT);
  const c = new AdbClient({ port, recheckMs: 20, idleMs: 5000, ...clientOpts });
  const d = c.device(SERIAL);
  const s = d.sync();
  return {
    srv,
    dev,
    c,
    d,
    s,
    port,
    async close() {
      s.destroy();
      await srv.close();
    },
  };
}

/**
 * A file must be absent on the fake device. Not strictEqual(buf, null): on a
 * failure, assert inspects and diffs the Buffer element by element, which
 * takes minutes past ~64 KiB and blocks the per-test timeout.
 */
function assertGone(memFs, p, what = "partial unlinked") {
  const b = memFs.readFile(p);
  assert.ok(b === null, `${what}: ${p} still holds ${b && b.length} bytes`);
}

async function expectAdbError(promise, kind) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AdbError, `expected AdbError(${kind}), got ${e && e.stack}`);
    assert.strictEqual(e.kind, kind, `kind ${e.kind} (${e.message}), expected ${kind}`);
    return e;
  }
  assert.fail(`expected AdbError(${kind}), resolved instead`);
}

/** Raw sync socket for fake-fidelity tests (bypasses SyncSession). */
async function rawSync(c, serial = SERIAL) {
  const { conn } = await c.openService(serial, "sync:");
  return conn;
}

async function readFail(conn) {
  const h = await conn.read(8);
  assert.strictEqual(h.toString("latin1", 0, 4), "FAIL");
  return (await conn.read(h.readUInt32LE(4))).toString("utf8");
}

async function expectEof(conn, ms = 2000) {
  const t = Date.now();
  try {
    await Promise.race([conn.read(1), sleep(ms).then(() => Promise.reject(new Error("no EOF")))]);
  } catch (e) {
    assert.ok(e.connEnd, `expected EOF within ${ms} ms: ${e.message} after ${Date.now() - t} ms`);
    return;
  }
  assert.fail("expected EOF, got data");
}

/** Every split of `buf` into two chunks, plus byte-by-byte. */
function splits(buf) {
  const out = [];
  for (let i = 0; i <= buf.length; i += 1) out.push([buf.subarray(0, i), buf.subarray(i)]);
  out.push([...buf].map((x) => Buffer.from([x])));
  return out;
}

/** A Conn fed from an in-process stream that delivers `chunks` one tick apart. */
function feedConn(chunks) {
  const { PassThrough } = require("stream");
  const s = new PassThrough();
  s.setNoDelay = () => {};
  s.destroyed = false;
  const conn = new client._Conn(s);
  (async () => {
    for (const ch of chunks) {
      if (ch.length) s.write(ch);
      await sleep(0);
    }
    s.end();
  })();
  return conn;
}

// =====================================================================
// Golden bytes
// =====================================================================

test("golden: host request framing counts UTF-8 bytes (× ’)", () => {
  assert.strictEqual(wire.encodeHostRequest("host:version").toString("latin1"), "000chost:version");
  const svc = "shell,v2,raw:ls '/sdcard/SPY×FAMILY/Hell’s Paradise'";
  const enc = wire.encodeHostRequest(svc);
  const bytes = Buffer.byteLength(svc);
  assert.notStrictEqual(bytes, svc.length, "fixture must contain multi-byte chars");
  assert.strictEqual(enc.toString("latin1", 0, 4), bytes.toString(16).padStart(4, "0"));
  assert.ok(enc.subarray(4).equals(Buffer.from(svc, "utf8")));
  assert.throws(() => wire.encodeHostRequest("x".repeat(0x10000)), RangeError);
});

test("golden: sync request header = id + u32 LE UTF-8 path length", () => {
  const p = "/sdcard/SPY×FAMILY/Hell’s.cbz";
  const b = wire.encodeSyncRequest(wire.ID.STA2, p);
  const len = Buffer.byteLength(p);
  assert.strictEqual(len, p.length + 1 + 2);
  const lenHex = Buffer.alloc(4);
  lenHex.writeUInt32LE(len);
  assert.strictEqual(hex(b.subarray(0, 8)), `53544132${hex(lenHex)}`);
  assert.ok(b.subarray(8).equals(Buffer.from(p, "utf8")));
  assert.strictEqual(wire.encodeSyncRequest(wire.ID.LIS2, "a".repeat(1024)).length, 8 + 1024);
  assert.throws(() => wire.encodeSyncRequest(wire.ID.LIS2, "a".repeat(1025)), RangeError);
  assert.throws(() => wire.encodeSyncRequest(wire.ID.STA2, "/a\0b"), RangeError);
});

test("golden: SEND v1 spec is path,decimal-mode; comma in the path kept", () => {
  const b = wire.encodeSendV1("/d/a,b.cbz");
  assert.strictEqual(b.toString("latin1", 0, 4), "SEND");
  assert.strictEqual(b.subarray(8).toString("latin1"), "/d/a,b.cbz,33188");
  assert.strictEqual(b.readUInt32LE(4), "/d/a,b.cbz,33188".length);
  assert.strictEqual(wire.REMOTE_PATH_MAX, 1018);
  assert.doesNotThrow(() => wire.encodeSendV1("/" + "a".repeat(1017)));
  assert.throws(() => wire.encodeSendV1("/" + "a".repeat(1018)), RangeError);
});

test("golden: DATA/DONE/QUIT/OKAY/FAIL messages", () => {
  assert.strictEqual(hex(wire.encodeDataHeader(65536)), "4441544100000100");
  assert.throws(() => wire.encodeDataHeader(65537), RangeError);
  assert.strictEqual(hex(wire.encodeDone(1700000000)), `444f4e45${hex(Buffer.from([0x00, 0xf1, 0x53, 0x65]))}`);
  assert.strictEqual(hex(wire.encodeQuit()), "5155495400000000");
  assert.strictEqual(hex(wire.encodeSyncMsg(wire.ID.OKAY, 0)), "4f4b415900000000");
  assert.strictEqual(wire.encodeSyncFail("path too long").toString("latin1"), "FAIL\x0d\x00\x00\x00path too long");
  assert.strictEqual(wire.encodeHostStatus(false, "device offline").toString("latin1"), "FAIL000edevice offline");
});

test("golden: struct sizes are AOSP's (STAT 16, STA2 72, DENT 20, DNT2 76, DONE full-size)", () => {
  assert.strictEqual(wire.STAT_V1_SIZE, 16);
  assert.strictEqual(wire.STAT_V2_SIZE, 72);
  assert.strictEqual(wire.DENT_V1_SIZE, 20);
  assert.strictEqual(wire.DENT_V2_SIZE, 76);
  assert.strictEqual(wire.encodeStatV1({}).length, 16);
  assert.strictEqual(wire.encodeStatV2({}).length, 72);
  assert.strictEqual(wire.encodeDent(false, {}, "ab").length, 22);
  assert.strictEqual(wire.encodeDent(true, {}, "ab").length, 78);
  const d2 = wire.encodeDentDone(true);
  assert.strictEqual(d2.length, 76);
  assert.strictEqual(d2.toString("latin1", 0, 4), "DONE");
  assert.ok(d2.subarray(4).equals(Buffer.alloc(72)));
  assert.strictEqual(wire.encodeDentDone(false).length, 20);
});

test("golden: STA2 decode — 64-bit size, error field, zeroed on error", () => {
  const big = 2 ** 32 + 5;
  const b = wire.encodeStatV2({ mode: 0o100644, size: big, mtime: 1700000123, ino: 77, nlink: 1 });
  assert.strictEqual(b.toString("latin1", 0, 4), "STA2");
  assert.strictEqual(hex(b.subarray(40, 48)), "0500000001000000");
  const r = wire.decodeStatV2(b);
  assert.strictEqual(r.size, big);
  assert.strictEqual(r.mtime, 1700000123);
  assert.strictEqual(r.error, 0);
  assert.strictEqual(wire.modeType(r.mode), "file");
  const e = wire.encodeStatV2({ error: wire.ERRNO.ENOENT });
  assert.strictEqual(hex(e), `5354413202000000${"00".repeat(64)}`);
  const dn = wire.decodeDentV2(wire.encodeDent(true, { size: big, mode: 0o40771 }, "x"));
  assert.strictEqual(dn.size, big);
  assert.strictEqual(dn.namelen, 1);
  assert.strictEqual(wire.modeType(dn.mode), "dir");
});

test("golden: shell packets; demuxer at every split offset", () => {
  assert.strictEqual(hex(wire.encodeShellPacket(wire.SHELL_ID.CLOSE_STDIN)), "0400000000");
  assert.strictEqual(hex(wire.encodeShellPacket(wire.SHELL_ID.EXIT, Buffer.from([3]))), "030100000003");
  const stream = Buffer.concat([
    wire.encodeShellPacket(1, "out×"),
    wire.encodeShellPacket(2, "err"),
    wire.encodeShellPacket(1, ""),
    wire.encodeShellPacket(3, Buffer.from([7])),
  ]);
  for (const parts of splits(stream)) {
    const dm = new wire.ShellDemuxer();
    const got = parts.flatMap((p) => dm.push(p));
    assert.deepStrictEqual(
      got.map((g) => [g.id, g.data.toString()]),
      [
        [1, "out×"],
        [2, "err"],
        [1, ""],
        [3, "\x07"],
      ],
    );
    assert.strictEqual(dm.buffered, 0);
  }
});

test("golden: track frames split at every offset, empty 0000 frame", () => {
  const row = wire.formatDevicesLRow({ serial: SERIAL, state: "device", transportId: 3 });
  const stream = Buffer.concat([wire.encodeProtocolString(row), wire.encodeProtocolString(""), wire.encodeProtocolString(row)]);
  for (const parts of splits(stream)) {
    const fs = new wire.FrameSplitter();
    const frames = parts.flatMap((p) => fs.push(p)).map((f) => f.toString());
    assert.deepStrictEqual(frames, [row, "", row]);
  }
  assert.throws(() => new wire.FrameSplitter().push(Buffer.from("zz00")), /bad frame length/);
});

test("golden: sync replies split at every offset read the same through one Conn", async () => {
  const name = Buffer.from("Hell’s Paradise", "utf8");
  const stream = Buffer.concat([
    wire.encodeDent(true, { mode: 0o40771 }, "."),
    wire.encodeDent(true, { mode: 0o100644, size: 2 ** 33, mtime: 5 }, name),
    wire.encodeDentDone(true),
    wire.encodeStatV2({ error: 2 }),
  ]);
  for (const parts of splits(stream)) {
    const conn = feedConn(parts);
    const ids = [];
    for (;;) {
      const rec = await conn.read(76);
      const d = wire.decodeDentV2(rec);
      ids.push(d.id);
      if (d.id === "DONE") break;
      const nm = await conn.read(d.namelen);
      ids.push(nm.toString());
      if (d.id === "DNT2" && nm.equals(name)) assert.strictEqual(d.size, 2 ** 33);
    }
    const st = wire.decodeStatV2(await conn.read(72));
    assert.deepStrictEqual(ids, ["DNT2", ".", "DNT2", "Hell’s Paradise", "DONE"]);
    assert.strictEqual(st.error, 2);
  }
});

test("Latch: waiters leave when their work settles; fire() wins over pending work only", async () => {
  const l = new client._Latch();
  for (let i = 0; i < 10000; i += 1) assert.strictEqual(await l.or(Promise.resolve(i), "F"), i);
  assert.strictEqual(l.waiting, 0, "10,000 settled waits leave nothing behind");
  await assert.rejects(l.or(Promise.reject(new Error("x")), "F"), /x/);
  assert.strictEqual(l.waiting, 0);
  const pending = l.or(new Promise(() => {}), "F");
  assert.strictEqual(l.waiting, 1);
  l.fire();
  assert.strictEqual(await pending, "F");
  assert.strictEqual(l.waiting, 0);
  assert.strictEqual(await l.or(new Promise(() => {}), "G"), "G", "after fire(), or() settles at once");
});

test("ByteQueue: exact takes across chunks", () => {
  const q = new wire.ByteQueue();
  q.push(Buffer.from("ab"));
  q.push(Buffer.from("cde"));
  q.push(Buffer.from("f"));
  assert.strictEqual(q.take(1).toString(), "a");
  assert.strictEqual(q.peek(3).toString(), "bcd");
  assert.strictEqual(q.take(4).toString(), "bcde");
  assert.strictEqual(q.length, 1);
  assert.throws(() => q.take(2), RangeError);
  assert.strictEqual(q.take(1).toString(), "f");
});

test("decodeName: valid UTF-8 exact, invalid bytes → name null", () => {
  const ok = wire.decodeName(Buffer.from("SPY×FAMILY", "utf8"));
  assert.strictEqual(ok.name, "SPY×FAMILY");
  const bad = wire.decodeName(Buffer.from([0x66, 0xff, 0x2e, 0x63]));
  assert.strictEqual(bad.name, null);
  assert.ok(bad.display.includes("\ufffd"));
  assert.ok(bad.raw.equals(Buffer.from([0x66, 0xff, 0x2e, 0x63])));
});

// =====================================================================
// devices -l
// =====================================================================

test("devices -l: full rows, padding, devpath, keyed fields from the end", () => {
  const text = [
    "A06B4A372090333        device usb:1-1 product:a06xx model:SM_A065F device:a06 transport_id:3",
    "192.168.1.5:5555       offline product:x model:y device:z transport_id:12",
    "emulator-5554          device product:sdk_gphone64 model:sdk_gphone64_x86_64 device:emu64x transport_id:1",
    "adb-R58N123ABCD-AbCdEf._adb-tls-connect._tcp device product:p model:m device:d transport_id:7",
    "",
  ].join("\n");
  const rows = wire.parseDevicesL(text);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows[0], {
    serial: "A06B4A372090333",
    state: "device",
    stateKind: "device",
    devpath: "usb:1-1",
    product: "a06xx",
    model: "SM_A065F",
    device: "a06",
    transportId: 3,
    targetable: true,
  });
  assert.strictEqual(rows[1].serial, "192.168.1.5:5555");
  assert.strictEqual(rows[1].state, "offline");
  assert.strictEqual(rows[1].devpath, null);
  assert.strictEqual(rows[1].transportId, 12);
  assert.strictEqual(rows[2].devpath, null);
  assert.strictEqual(rows[3].serial, "adb-R58N123ABCD-AbCdEf._adb-tls-connect._tcp");
  assert.strictEqual(rows[3].transportId, 7);
});

test("devices -l: (no serial number) is listed but not targetable", () => {
  const rows = wire.parseDevicesL("(no serial number)     unauthorized usb:1-2 transport_id:4\n");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].serial, "(no serial number)");
  assert.strictEqual(rows[0].state, "unauthorized");
  assert.strictEqual(rows[0].devpath, "usb:1-2");
  assert.strictEqual(rows[0].targetable, false);
});

test("devices -l: multi-word 'no permissions' state, then devpath", () => {
  const t =
    "X1                     no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:5";
  const [r] = wire.parseDevicesL(t);
  assert.strictEqual(r.stateKind, "no-permissions");
  assert.ok(r.state.startsWith("no permissions (missing udev rules?"));
  assert.ok(r.state.endsWith("device.html]"));
  assert.strictEqual(r.devpath, "usb:1-3");
  assert.strictEqual(r.transportId, 5);
  const [w] = wire.parseDevicesL("X2                     no permissions; see [http://developer.android.com/tools/device.html] transport_id:6");
  assert.strictEqual(w.stateKind, "no-permissions");
  assert.strictEqual(w.devpath, null);
});

test("devices -l: every state round-trips through the fake's formatter", () => {
  for (const state of wire.DEVICE_STATES) {
    for (const serial of ["S1", "x".repeat(22), "y".repeat(23), ""]) {
      const line = wire.formatDevicesLRow({ serial, state, devpath: "usb:2-1", product: "p", model: "SM-T 50", device: "d", transportId: 9 });
      const [r] = wire.parseDevicesL(line);
      assert.ok(r, `${state}/${serial}: ${line}`);
      assert.strictEqual(r.serial, serial || "(no serial number)");
      assert.strictEqual(r.state, state);
      assert.strictEqual(r.devpath, "usb:2-1");
      assert.strictEqual(r.model, "SM_T_50");
      assert.strictEqual(r.transportId, 9);
      assert.strictEqual(r.targetable, !!serial);
    }
  }
});

test("devices (short form) parses serial<TAB>state", () => {
  const rows = wire.parseDevicesShort(`${SERIAL}\tdevice\n(no serial number)\tunauthorized\nZ\tbogus\n`);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].targetable, false);
});

// =====================================================================
// Fake fidelity (raw sockets)
// =====================================================================

test("fake: SEND unlinks, creates O_EXCL with auto-mkdir, replaces a longer file exactly", async () => {
  const r = await rig();
  try {
    r.dev.fs.writeFile(`${ROOT}/A/old.cbz`, "0123456789");
    await r.s.push({ remotePath: `${ROOT}/A/old.cbz`, open: () => Buffer.from("abc") });
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/A/old.cbz`).toString(), "abc");
    await r.s.push({ remotePath: `${ROOT}/New/Deep/x.cbz`, open: () => Buffer.from("x") });
    assert.deepStrictEqual(r.dev.fs.names(`${ROOT}/New`), ["Deep"]);
  } finally {
    await r.close();
  }
});

test("fake: FAIL comes BEFORE DONE, DATA is drained, the partial unlinked, the session closed", async () => {
  const r = await rig({ device: { inject: { failPaths: [{ pattern: /locked\.cbz$/, op: "send", at: "data" }] } } });
  try {
    const conn = await rawSync(r.c);
    const p = `${ROOT}/locked.cbz`;
    await conn.write(wire.encodeSendV1(p));
    await conn.write([wire.encodeDataHeader(4), Buffer.from("abcd")]);
    const msg = await Promise.race([readFail(conn), sleep(1500).then(() => "no early FAIL")]);
    assert.strictEqual(msg, "write failed: I/O error");
    // The fake must still be draining: more DATA then DONE are accepted…
    await conn.write([wire.encodeDataHeader(4), Buffer.from("efgh")]);
    await conn.write(wire.encodeDone(1));
    // …and then the session ends.
    await expectEof(conn);
    assertGone(r.dev.fs, p);
  } finally {
    await r.close();
  }
});

test("fake: open-time FAIL arrives before any DATA is sent", async () => {
  const r = await rig({ device: { inject: { failPaths: [{ pattern: /perm\.cbz$/, op: "send", at: "open", errno: wire.ERRNO.EACCES }] } } });
  try {
    const conn = await rawSync(r.c);
    await conn.write(wire.encodeSendV1(`${ROOT}/perm.cbz`));
    assert.strictEqual(await readFail(conn), "couldn't create file: Permission denied");
    conn.destroy();
  } finally {
    await r.close();
  }
});

test("fake: a failPaths entry with `times` fails that many SENDs, then lets them through", async () => {
  const inject = {
    failPaths: [
      { pattern: /d\.cbz$/, op: "send", at: "data", errno: wire.ERRNO.EIO, times: 1 },
      { pattern: /o\.cbz$/, op: "send", at: "open", errno: wire.ERRNO.EACCES, times: 2 },
    ],
  };
  const r = await rig({ device: { inject } });
  try {
    const push = (n) => r.s.push({ remotePath: `${ROOT}/${n}`, open: () => Buffer.from(n) });
    assert.strictEqual((await expectAdbError(push("d.cbz"), "remote-fail")).failText, "write failed: I/O error");
    await push("d.cbz");
    for (let i = 0; i < 2; i += 1) {
      assert.strictEqual((await expectAdbError(push("o.cbz"), "remote-fail")).failText, "couldn't create file: Permission denied");
    }
    await push("o.cbz");
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/d.cbz`).toString(), "d.cbz");
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/o.cbz`).toString(), "o.cbz");
  } finally {
    await r.close();
  }
});

test("fake: path over 1024 bytes → FAIL 'path too long' and EOF", async () => {
  const r = await rig();
  try {
    const conn = await rawSync(r.c);
    const p = Buffer.alloc(1025, 0x61);
    await conn.write([wire.encodeSyncMsg(wire.ID.STA2, p.length), p]);
    assert.strictEqual(await readFail(conn), "path too long");
    await expectEof(conn);
  } finally {
    await r.close();
  }
});

test("fake: SEND spec splits at the LAST comma", async () => {
  const r = await rig();
  try {
    const conn = await rawSync(r.c);
    await conn.write(wire.encodeSendV1(`${ROOT}/a,b,c.cbz`));
    await conn.write([wire.encodeDataHeader(1), Buffer.from("z"), wire.encodeDone(1)]);
    const h = await conn.read(8);
    assert.strictEqual(h.toString("latin1", 0, 4), "OKAY");
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/a,b,c.cbz`).toString(), "z");
    conn.destroy();
  } finally {
    await r.close();
  }
});

test("fake: LIST/LIS2 of a missing or non-dir path → full DONE record only; LIS2 lists . and ..", async () => {
  const r = await rig();
  try {
    r.dev.fs.writeFile(`${ROOT}/f.cbz`, "x");
    const conn = await rawSync(r.c);
    await conn.write(wire.encodeSyncRequest(wire.ID.LIST, `${ROOT}/missing`));
    const d1 = await conn.read(20);
    assert.strictEqual(d1.toString("latin1", 0, 4), "DONE");
    await conn.write(wire.encodeSyncRequest(wire.ID.LIS2, `${ROOT}/f.cbz`));
    const d2 = await conn.read(76);
    assert.strictEqual(d2.toString("latin1", 0, 4), "DONE");
    await conn.write(wire.encodeSyncRequest(wire.ID.LIS2, ROOT));
    const names = [];
    for (;;) {
      const rec = wire.decodeDentV2(await conn.read(76));
      if (rec.id === "DONE") break;
      names.push((await conn.read(rec.namelen)).toString());
    }
    assert.deepStrictEqual(names.sort(), [".", "..", "f.cbz"]);
    // The session is still alive after all three (no FAIL in listings).
    await conn.write(wire.encodeSyncRequest(wire.ID.STA2, `${ROOT}/missing`));
    const st = wire.decodeStatV2(await conn.read(72));
    assert.strictEqual(st.error, wire.ERRNO.ENOENT);
    assert.strictEqual(st.mode, 0);
    assert.strictEqual(st.size, 0);
    conn.destroy();
  } finally {
    await r.close();
  }
});

test("fake: a failed unlink reopens without O_TRUNC (old tail survives a shorter push)", async () => {
  const r = await rig({ device: { inject: { unlinkFails: /tail\.cbz$/ } } });
  try {
    r.dev.fs.writeFile(`${ROOT}/tail.cbz`, "AAAAAAAAAA");
    await r.s.push({ remotePath: `${ROOT}/tail.cbz`, open: () => Buffer.from("BBB") });
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/tail.cbz`).toString(), "BBBAAAAAAA");
  } finally {
    await r.close();
  }
});

test("fake: RECV of a dir FAILs 'read failed: Is a directory'; QUIT closes without a reply", async () => {
  const r = await rig();
  try {
    const conn = await rawSync(r.c);
    await conn.write(wire.encodeSyncRequest(wire.ID.RECV, ROOT));
    assert.strictEqual(await readFail(conn), "read failed: Is a directory");
    await expectEof(conn);
    const c2 = await rawSync(r.c);
    await c2.write(wire.encodeQuit());
    await expectEof(c2);
  } finally {
    await r.close();
  }
});

test("fake: STA2/LIS2 FAIL as unknown commands when stat_v2/ls_v2 aren't advertised", async () => {
  const r = await rig({ device: { features: ["shell_v2"] } });
  try {
    const conn = await rawSync(r.c);
    await conn.write(wire.encodeSyncRequest(wire.ID.STA2, ROOT));
    assert.strictEqual(await readFail(conn), "unknown command 32415453");
    await expectEof(conn);
  } finally {
    await r.close();
  }
});

test("fake: track-devices-l — initial frame, (no serial number), offline then removal frames on unplug in both orders, 0000 when empty", async () => {
  for (const order of ["frame-first", "eof-first"]) {
    const r = await rig();
    try {
      r.srv.addDevice({ serial: "", state: "unauthorized" });
      const frames = [];
      let ended = null;
      const t = r.c.track({ onDevices: (rows) => frames.push(rows), onEnd: (e) => (ended = e || "clean") });
      await sleep(50);
      assert.deepStrictEqual(
        frames[0].map((x) => [x.serial, x.targetable]),
        [
          [SERIAL, true],
          ["(no serial number)", false],
        ],
      );
      // Unplug the real device while a sync session is open.
      const conn = await rawSync(r.c);
      const eofAt = { t: 0 };
      conn.read(1).catch(() => (eofAt.t = Date.now()));
      const before = frames.length;
      await r.srv.unplug(SERIAL, { order });
      await sleep(50);
      assert.ok(eofAt.t > 0, `${order}: session EOF`);
      // AOSP order: handle_offline's frame (state offline), then the removal.
      assert.strictEqual(frames.length, before + 2, `${order}: offline frame + removal frame`);
      assert.deepStrictEqual(
        frames[before].map((x) => [x.serial, x.state]),
        [
          [SERIAL, "offline"],
          ["(no serial number)", "unauthorized"],
        ],
      );
      assert.deepStrictEqual(
        frames[frames.length - 1].map((x) => x.serial),
        ["(no serial number)"],
      );
      r.srv.devices.splice(0);
      r.srv._notify();
      await sleep(30);
      assert.deepStrictEqual(frames[frames.length - 1], [], "empty 0000 frame → []");
      t.close();
      await sleep(30);
      assert.strictEqual(ended, "clean");
    } finally {
      await r.close();
    }
  }
});

test("fake: a tracker that receives data is closed (device_tracker_enqueue)", async () => {
  const r = await rig();
  try {
    const sock = net.connect({ port: r.port, host: "127.0.0.1" });
    await new Promise((res) => sock.once("connect", res));
    let closed = false;
    sock.on("close", () => (closed = true));
    sock.on("error", () => {});
    sock.resume(); // a paused readable never emits 'close'
    sock.write(wire.encodeHostRequest("host:track-devices-l"));
    await sleep(30);
    sock.write("x");
    await sleep(50);
    assert.ok(closed);
  } finally {
    await r.close();
  }
});

// =====================================================================
// Host services and transport binding
// =====================================================================

test("host: version, devices -l, features", async () => {
  const r = await rig();
  try {
    assert.strictEqual(await r.c.version(), 41);
    const rows = await r.c.devices();
    assert.strictEqual(rows[0].serial, SERIAL);
    assert.strictEqual(rows[0].transportId, r.dev.transportId);
    const f = await r.c.features(SERIAL);
    assert.ok(f.has("shell_v2") && f.has("stat_v2") && f.has("ls_v2"));
    assert.ok(!f.has("sendrecv_v2"), "the fake doesn't advertise what it can't do");
  } finally {
    await r.close();
  }
});

test("host: tport answers with the 8-byte transport id and the device pins it", async () => {
  const r = await rig();
  try {
    await r.s.stat(ROOT);
    assert.strictEqual(r.d.transportId, r.dev.transportId);
    assert.strictEqual(r.c.tportSupported, true);
    assert.ok(r.srv.requests("host").some((e) => e.service === `host:tport:serial:${SERIAL}`));
  } finally {
    await r.close();
  }
});

test("host: tport → transport fallback ONLY on unknown-service FAIL; id from devices -l", async () => {
  const r = await rig({ server: { inject: { noTport: true } } });
  try {
    const st = await r.s.stat(ROOT);
    assert.ok(st.ok);
    assert.strictEqual(r.c.tportSupported, false);
    assert.strictEqual(r.d.transportId, r.dev.transportId);
    const svcs = r.srv.requests("host").map((e) => e.service);
    assert.ok(svcs.includes(`host:transport:${SERIAL}`));
    // Later opens go straight to transport: (no second tport attempt).
    await r.s.close();
    await r.s.stat(ROOT);
    assert.strictEqual(r.srv.requests("host").filter((e) => e.service.startsWith("host:tport:")).length, 1);
  } finally {
    await r.close();
  }
});

test("host: `device '…' not found` is device-lost and never falls back to host:transport:", async () => {
  const r = await rig();
  try {
    const e = await expectAdbError(r.c.openService("ZZZ", "sync:"), "device-lost");
    assert.strictEqual(e.failText, "device 'ZZZ' not found");
    assert.ok(!r.srv.requests("host").some((x) => x.service.startsWith("host:transport:")));
    await expectAdbError(r.c.openService("(no serial number)", "sync:"), "device-lost");
  } finally {
    await r.close();
  }
});

test("host: state FAIL texts → unauthorized / offline / connecting (authorizing too)", async () => {
  const r = await rig();
  try {
    const cases = [
      ["unauthorized", "unauthorized"],
      ["offline", "offline"],
      ["connecting", "connecting"],
      ["authorizing", "connecting"],
    ];
    for (const [state, kind] of cases) {
      r.srv.setState(SERIAL, state);
      const e = await expectAdbError(r.c.device(SERIAL).sync().stat(ROOT), kind);
      assert.strictEqual(e.charges, 0, `${state} is never charged`);
    }
    assert.strictEqual(client.classifyHostFail("device still connecting"), "connecting");
    assert.strictEqual(client.classifyHostFail("device still authorizing"), "connecting");
    assert.strictEqual(client.classifyHostFail("device 'A06B4A372090333' not found"), "device-lost");
    assert.strictEqual(client.classifyHostFail("no devices/emulators found"), "device-lost");
    assert.strictEqual(client.classifyHostFail("insufficient permissions for device\nSee [x] for more information"), "unauthorized");
  } finally {
    await r.close();
  }
});

test("host: nothing listening → server-unavailable", async () => {
  const srv = net.createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  await new Promise((res) => srv.close(res));
  const c = new AdbClient({ port, connectTimeoutMs: 1000 });
  await expectAdbError(c.version(), "server-unavailable");
  await expectAdbError(c.device(SERIAL).sync().stat("/"), "server-unavailable");
});

test("resolveServerAddress: ADB_SERVER_SOCKET, ANDROID_ADB_SERVER_PORT/ADDRESS, default", () => {
  const r = client.resolveServerAddress;
  assert.deepStrictEqual(r({}), { host: "127.0.0.1", port: 5037 });
  assert.deepStrictEqual(r({ ANDROID_ADB_SERVER_PORT: "5038" }), { host: "127.0.0.1", port: 5038 });
  assert.deepStrictEqual(r({ ANDROID_ADB_SERVER_PORT: "5038", ANDROID_ADB_SERVER_ADDRESS: "10.0.0.2" }), { host: "10.0.0.2", port: 5038 });
  assert.deepStrictEqual(r({ ADB_SERVER_SOCKET: "tcp:6000", ANDROID_ADB_SERVER_PORT: "5038" }), { host: "127.0.0.1", port: 6000 });
  assert.deepStrictEqual(r({ ADB_SERVER_SOCKET: "tcp:example.lan:6001" }), { host: "example.lan", port: 6001 });
  assert.ok(r({ ADB_SERVER_SOCKET: "localabstract:adb" }).error);
  assert.ok(r({ ANDROID_ADB_SERVER_PORT: "70000" }).error);
});

// =====================================================================
// Shell
// =====================================================================

test("shell v2: stdout/stderr apart, exit code from its packet, CloseStdin sent", async () => {
  const r = await rig();
  try {
    const res = await r.d.shell("echo out; cat /nope; exit 3");
    assert.strictEqual(res.v2, true);
    assert.strictEqual(res.stdout.toString(), "out\n");
    assert.strictEqual(res.stderr.toString(), "cat: /nope: No such file or directory\n");
    assert.strictEqual(res.exitCode, 3);
    const entry = r.srv.requests("shell").pop();
    assert.strictEqual(entry.closeStdin, true);
    assert.ok(r.srv.requests("device").some((e) => e.service === "shell,v2,raw:echo out; cat /nope; exit 3"));
  } finally {
    await r.close();
  }
});

test("shell legacy (no shell_v2): CRLF normalized, exit code from the sentinel, never shell,v2", async () => {
  const r = await rig({ device: { features: ["stat_v2", "ls_v2"] } });
  try {
    r.dev.fs.writeFile(`${ROOT}/a.cbz`, "hello");
    const res = await r.d.shell(`sha256sum '${ROOT}/a.cbz'; false`);
    assert.strictEqual(res.v2, false);
    const sha = crypto.createHash("sha256").update("hello").digest("hex");
    assert.strictEqual(res.stdout.toString(), `${sha}  ${ROOT}/a.cbz\n`);
    assert.strictEqual(res.exitCode, 1);
    const res0 = await r.d.shell("echo ok");
    assert.strictEqual(res0.exitCode, 0);
    assert.strictEqual(res0.stdout.toString(), "ok\n");
    const svcs = r.srv.requests("device").map((e) => e.service);
    assert.ok(svcs.every((s) => !s.startsWith("shell,v2")));
    assert.ok(svcs.some((s) => /^shell:echo ok\necho "__AIO_RC_[0-9a-f]+__\$\?"$/.test(s)));
    // A command ending in ";" keeps its exit code (the sentinel follows a newline).
    const semi = await r.d.shell("false;");
    assert.deepStrictEqual([semi.exitCode, semi.stdout.toString()], [1, ""]);
  } finally {
    await r.close();
  }
});

test("shell: a service string over 3,072 bytes is refused before anything is sent", async () => {
  const r = await rig();
  try {
    await r.d.features();
    const before = r.srv.log.length;
    const cmd = `echo ${"x".repeat(wire.SHELL_SERVICE_MAX - "shell,v2,raw:echo ".length + 1)}`;
    await assert.rejects(r.d.shell(cmd), RangeError);
    assert.strictEqual(r.srv.log.length, before);
    const fits = `echo ${"x".repeat(wire.SHELL_SERVICE_MAX - "shell,v2,raw:echo ".length)}`;
    assert.strictEqual((await r.d.shell(fits)).exitCode, 0);
  } finally {
    await r.close();
  }
});

test("shell: a missing sha256sum is rc 127, rc-checked by the caller (no 2>/dev/null)", async () => {
  const r = await rig({ device: { inject: { tools: { sha256sum: false, findPrintf: false } } } });
  try {
    const a = await r.d.shell(`sha256sum '${ROOT}'`);
    assert.strictEqual(a.exitCode, 127);
    assert.ok(a.stderr.toString().includes("sha256sum: inaccessible or not found"));
    const b = await r.d.shell(`find '${ROOT}' -maxdepth 1 -printf '%s %T@ %P\\n'`);
    assert.strictEqual(b.exitCode, 1);
    assert.ok(b.stderr.toString().includes("-printf"));
  } finally {
    await r.close();
  }
});

// =====================================================================
// Sync session: names and primitives
// =====================================================================

test("names: SPY×FAMILY, Hell’s Paradise and commas land byte-exact and list back exact", async () => {
  const r = await rig();
  try {
    const names = ["SPY×FAMILY", "Hell’s Paradise", "Kaguya-sama, Love Is War"];
    for (const n of names) await r.s.push({ remotePath: `${ROOT}/${n}/Ch. 1.cbz`, open: () => Buffer.from(n) });
    const listed = (await r.s.list(ROOT)).entries.map((e) => e.name).sort();
    assert.deepStrictEqual(listed, [...names].sort());
    for (const n of names) {
      const rec = r.srv.requests("sync").find((e) => e.id === "SEND" && e.sendPath === `${ROOT}/${n}/Ch. 1.cbz`);
      assert.ok(rec.sendRawPath.equals(Buffer.from(`${ROOT}/${n}/Ch. 1.cbz`, "utf8")));
      assert.strictEqual((await r.s.pull(`${ROOT}/${n}/Ch. 1.cbz`)).data.toString(), n);
    }
  } finally {
    await r.close();
  }
});

test("names: a 1,019-byte remote path is refused before it is sent; 1,018 works", async () => {
  const r = await rig();
  try {
    const base = "/storage/emulated/0/";
    const p1018 = base + "a".repeat(1018 - base.length);
    const p1019 = base + "a".repeat(1019 - base.length);
    assert.strictEqual(Buffer.byteLength(p1018), 1018);
    const before = r.srv.requests("sync").length;
    assert.throws(() => r.s.push({ remotePath: p1019, open: () => Buffer.from("x") }), RangeError);
    assert.strictEqual(r.srv.requests("sync").length, before);
    await r.s.push({ remotePath: p1018, open: () => Buffer.from("x") });
    assert.strictEqual(r.dev.fs.readFile(p1018).toString(), "x");
  } finally {
    await r.close();
  }
});

test("names: a non-UTF-8 device name lists with name null and its raw bytes", async () => {
  const r = await rig();
  try {
    const raw = Buffer.from([0x66, 0xff, 0x2e, 0x63, 0x62, 0x7a]);
    r.dev.fs.writeFile(Buffer.concat([Buffer.from(`${ROOT}/`), raw]), "x");
    const { entries } = await r.s.list(ROOT);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, null);
    assert.ok(entries[0].raw.equals(raw));
    // A raw-byte path still stats (Buffer paths pass through unchanged).
    assert.ok((await r.s.stat(Buffer.concat([Buffer.from(`${ROOT}/`), raw]))).ok);
  } finally {
    await r.close();
  }
});

test("list: . and .. dropped; entries whose lstat failed come back in `errored`, never as files", async () => {
  const r = await rig({ device: { inject: { lstatErrors: /secret\.cbz$/ } } });
  try {
    r.dev.fs.writeFile(`${ROOT}/a.cbz`, "1");
    r.dev.fs.writeFile(`${ROOT}/secret.cbz`, "2");
    const v2 = await r.s.list(ROOT);
    assert.deepStrictEqual(v2.entries.map((e) => e.name), ["a.cbz"]);
    assert.deepStrictEqual(v2.errored.map((e) => [e.name, e.error]), [["secret.cbz", wire.ERRNO.EACCES]]);
  } finally {
    await r.close();
  }
});

test("quiet failures: a missing dir lists EMPTY; only STA2's error field tells it apart", async () => {
  const r = await rig();
  try {
    r.dev.fs.mkdirs(`${ROOT}/Empty`);
    const missing = await r.s.list(`${ROOT}/Missing`);
    const empty = await r.s.list(`${ROOT}/Empty`);
    assert.deepStrictEqual(missing, empty, "indistinguishable by listing");
    const sm = await r.s.stat(`${ROOT}/Missing`);
    const se = await r.s.stat(`${ROOT}/Empty`);
    assert.deepStrictEqual([sm.ok, sm.error], [false, wire.ERRNO.ENOENT]);
    assert.deepStrictEqual([se.ok, se.type], [true, "dir"]);
    assert.strictEqual(r.s.opens, 1, "no FAIL anywhere: one session");
  } finally {
    await r.close();
  }
});

test("quiet failures: locked storage — root STA2 reports an error, listings come back empty", async () => {
  const r = await rig({ device: { inject: { locked: { prefix: "/storage/emulated/0", errno: wire.ERRNO.ENOENT } } } });
  try {
    r.dev.fs.writeFile(`${ROOT}/Series/c1.cbz`, "x");
    const st = await r.s.stat(ROOT);
    assert.strictEqual(st.ok, false);
    assert.strictEqual(st.error, wire.ERRNO.ENOENT);
    assert.deepStrictEqual((await r.s.list(ROOT)).entries, []);
  } finally {
    await r.close();
  }
});

test("quiet failures: a truncated listing drops names that STA2 still finds", async () => {
  const r = await rig({ device: { inject: { truncateList: [{ path: ROOT, after: 3 }] } } });
  try {
    for (const n of ["A", "B", "C", "D"]) r.dev.fs.mkdirs(`${ROOT}/${n}`);
    const listed = (await r.s.list(ROOT)).entries.map((e) => e.name);
    assert.strictEqual(listed.length, 1, ". and .. count against the truncation");
    const missing = ["A", "B", "C", "D"].filter((n) => !listed.includes(n));
    for (const n of missing) assert.ok((await r.s.stat(`${ROOT}/${n}`)).ok, `${n} exists despite the listing`);
  } finally {
    await r.close();
  }
});

test("v1 fallback: no stat_v2/ls_v2 → STAT/LIST; STAT error is mode 0 (cause unknown)", async () => {
  const r = await rig({ device: { features: ["shell_v2"] } });
  try {
    r.dev.fs.writeFile(`${ROOT}/a.cbz`, "12345", { mtime: 1700000000 });
    const st = await r.s.stat(`${ROOT}/a.cbz`);
    assert.deepStrictEqual([st.ok, st.type, st.size, st.mtime], [true, "file", 5, 1700000000]);
    const miss = await r.s.stat(`${ROOT}/zz`);
    assert.deepStrictEqual([miss.ok, miss.error], [false, -1]);
    const ls = await r.s.list(ROOT);
    assert.deepStrictEqual(ls.entries.map((e) => [e.name, e.size]), [["a.cbz", 5]]);
    const ids = r.srv.requests("sync").map((e) => e.id);
    assert.ok(ids.includes("STAT") && ids.includes("LIST"));
    assert.ok(!ids.includes("STA2") && !ids.includes("LIS2"));
  } finally {
    await r.close();
  }
});

test("case-insensitive device: lookups ignore case; a push under a new case replaces the slot", async () => {
  const r = await rig({ device: { caseInsensitive: true } });
  try {
    r.dev.fs.writeFile(`${ROOT}/Alpha/Ch 1.cbz`, "old");
    assert.ok((await r.s.stat(`${ROOT}/ALPHA/ch 1.CBZ`)).ok);
    await r.s.push({ remotePath: `${ROOT}/alpha/CH 1.cbz`, open: () => Buffer.from("new") });
    assert.deepStrictEqual(r.dev.fs.names(ROOT), ["Alpha"], "the folder keeps its stored case (mkdirs EEXIST)");
    assert.deepStrictEqual(r.dev.fs.names(`${ROOT}/Alpha`), ["CH 1.cbz"], "unlink + create: the file takes the new case");
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/alpha/ch 1.cbz`).toString(), "new");
  } finally {
    await r.close();
  }
});

test("push: hash-while-push sha equals the device's, DONE mtime applied after OKAY", async () => {
  const r = await rig();
  try {
    const data = crypto.randomBytes(300 * 1024);
    const res = await r.s.push({ remotePath: `${ROOT}/s/x.cbz`, open: () => data, mtime: 1700000999 });
    assert.strictEqual(res.bytes, data.length);
    assert.strictEqual(res.sha256, crypto.createHash("sha256").update(data).digest("hex"));
    const st = await r.s.stat(`${ROOT}/s/x.cbz`);
    assert.strictEqual(st.size, data.length);
    assert.strictEqual(st.mtime, 1700000999);
    const sends = r.srv.requests("sync").filter((e) => e.id === "SEND");
    assert.strictEqual(sends[0].path, `${ROOT}/s/x.cbz,33188`);
  } finally {
    await r.close();
  }
});

test("push: a same-session STA2 after OKAY is served only after lutimes; another session can see the old mtime", async () => {
  const r = await rig({ device: { inject: { lutimesDelayMs: 150 } } });
  try {
    const p = `${ROOT}/m.cbz`;
    r.dev.fs.writeFile(p, "old", { mtime: 1000 });
    await r.s.push({ remotePath: p, open: () => Buffer.from("new"), mtime: 2000 });
    const other = r.d.sync();
    const early = await other.stat(p);
    const same = await r.s.stat(p);
    assert.strictEqual(same.mtime, 2000, "same session: after lutimes");
    assert.notStrictEqual(early.mtime, 2000, "other session raced lutimes");
    other.destroy();
  } finally {
    await r.close();
  }
});

// =====================================================================
// Session lifecycle
// =====================================================================

test("lifecycle: a FAIL on file 2 of 5 — files 3-5 still land, charge 1, one reopen", async () => {
  const r = await rig({ device: { inject: { failPaths: [{ pattern: /f2\.cbz$/, op: "send", at: "open" }] } } });
  try {
    const results = [];
    for (let i = 1; i <= 5; i += 1) {
      try {
        await r.s.push({ remotePath: `${ROOT}/S/f${i}.cbz`, open: () => Buffer.from(`file ${i}`) });
        results.push("ok");
      } catch (e) {
        assert.ok(e instanceof AdbError);
        results.push(`${e.kind}/${e.charges}/${e.receivedFail}`);
      }
    }
    assert.deepStrictEqual(results, ["ok", "remote-fail/1/true", "ok", "ok", "ok"]);
    for (const i of [1, 3, 4, 5]) assert.strictEqual(r.dev.fs.readFile(`${ROOT}/S/f${i}.cbz`).toString(), `file ${i}`);
    assertGone(r.dev.fs, `${ROOT}/S/f2.cbz`, "no file after an open-time FAIL");
    assert.strictEqual(r.s.opens, 2);
    assert.strictEqual(r.dev.syncSessions, 2);
  } finally {
    await r.close();
  }
});

test("lifecycle: an early FAIL mid-DATA (ENOSPC) stops the stream; partial unlinked", async () => {
  const r = await rig({ device: { inject: { capacityBytes: 1024 * 1024 } } });
  try {
    const total = 64 * 1024 * 1024;
    let produced = 0;
    async function* gen() {
      while (produced < total) {
        produced += 65536;
        yield Buffer.alloc(65536, 7);
      }
    }
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/big.cbz`, open: () => gen() }), "no-space");
    assert.strictEqual(e.receivedFail, true);
    assert.strictEqual(e.failText, "write failed: No space left on device");
    assert.ok(produced < 24 * 1024 * 1024, `stream stopped early (produced ${produced})`);
    await sleep(50);
    assertGone(r.dev.fs, `${ROOT}/big.cbz`);
    assert.strictEqual(r.dev.fs.used, 0);
  } finally {
    await r.close();
  }
});

test("lifecycle: EROFS → read-only", async () => {
  const r = await rig({ device: { inject: { readOnly: true } } });
  try {
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/x.cbz`, open: () => Buffer.from("x") }), "read-only");
    assert.strictEqual(e.failText, "couldn't create file: Read-only file system");
  } finally {
    await r.close();
  }
});

test("lifecycle: a missing details.json doesn't kill the reads behind it (readSmall STA2s first)", async () => {
  const r = await rig();
  try {
    r.dev.fs.writeFile(`${ROOT}/B/details.json`, '{"title":"B"}');
    assert.strictEqual(await r.s.readSmall(`${ROOT}/A/details.json`), null);
    assert.strictEqual(await r.s.readSmall(`${ROOT}/A`), null, "a dir is not read");
    assert.strictEqual((await r.s.readSmall(`${ROOT}/B/details.json`)).toString(), '{"title":"B"}');
    assert.strictEqual(r.s.opens, 1);
    assert.ok(!r.srv.requests("sync").some((e) => e.id === "RECV" && e.path.includes("/A/")));
  } finally {
    await r.close();
  }
});

test("lifecycle: a RECV FAIL kills the session; the next op reopens it free", async () => {
  const r = await rig();
  try {
    const e = await expectAdbError(r.s.pull(`${ROOT}/none.json`), "remote-fail");
    assert.strictEqual(e.charges, 1);
    assert.ok(e.failText.startsWith("open failed: No such file or directory"));
    assert.ok((await r.s.stat(ROOT)).ok);
    assert.strictEqual(r.s.opens, 2);
  } finally {
    await r.close();
  }
});

test("lifecycle: a drop on every SEND of a path pattern charges 2 per file and can't loop", async () => {
  const r = await rig({ device: { inject: { dropPaths: [{ pattern: /bad/, op: "send" }] } } });
  try {
    const charges = [];
    const e1 = await expectAdbError(r.s.push({ remotePath: `${ROOT}/bad1.cbz`, open: () => Buffer.from("x") }), "session-closed");
    charges.push(e1.charges);
    const sends = r.srv.requests("sync").filter((x) => x.id === "SEND" && x.path.includes("bad1"));
    assert.strictEqual(sends.length, 2, "one attempt + one retry, then stop");
    // The executor's budget (P3) sums charges; a budget of 3 trips on the 2nd bad file.
    let budget = 0;
    budget += e1.charges;
    const e2 = await expectAdbError(r.s.push({ remotePath: `${ROOT}/bad2.cbz`, open: () => Buffer.from("x") }), "session-closed");
    budget += e2.charges;
    assert.ok(budget >= 3, `budget trips (${budget})`);
    await r.s.push({ remotePath: `${ROOT}/good.cbz`, open: () => Buffer.from("g") });
    assert.deepStrictEqual(charges, [2]);
  } finally {
    await r.close();
  }
});

test("lifecycle: one dropped session on a live device is charged 1 and rescued by the retry", async () => {
  const charged = [];
  const r = await rig({ device: { inject: { dropPaths: [{ pattern: /once/, op: "send", times: 1 }] } } });
  try {
    const s = r.d.sync({ onCharge: (e) => charged.push(e.kind) });
    const res = await s.push({ remotePath: `${ROOT}/once.cbz`, open: () => Buffer.from("data") });
    assert.strictEqual(res.bytes, 4);
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/once.cbz`).toString(), "data");
    assert.deepStrictEqual(charged, ["session-closed"]);
    assert.strictEqual(s.opens, 2);
    s.destroy();
  } finally {
    await r.close();
  }
});

test("lifecycle: ECONNRESET on a live device reads as an EOF (session-closed after the recheck)", async () => {
  const r = await rig();
  try {
    await r.s.stat(ROOT);
    // Kill the session with an RST while an op waits on a stalled device.
    r.dev.inject.stallPaths = [{ pattern: /rst/, op: "send", times: 1 }];
    const p = r.s.push({ remotePath: `${ROOT}/rst.cbz`, open: () => Buffer.from("x") });
    await sleep(80);
    r.srv.kickSessions(SERIAL, { reset: true });
    const res = await p;
    assert.strictEqual(res.bytes, 1, "the retry on a fresh session delivered it");
    assert.strictEqual(r.dev.fs.readFile(`${ROOT}/rst.cbz`).toString(), "x");
  } finally {
    await r.close();
  }
});

test("backpressure: a 256 MiB push keeps in-flight bytes bounded; the end-to-end sha matches", async () => {
  const r = await rig();
  try {
    r.dev.fs.hashOnlyPrefixes.push(`${ROOT}/huge`);
    const total = 256 * 1024 * 1024;
    let produced = 0;
    let maxInFlight = 0;
    const h = crypto.createHash("sha256");
    async function* gen() {
      let i = 0;
      while (produced < total) {
        const b = Buffer.allocUnsafe(65536).fill(i++ & 0xff);
        h.update(b);
        maxInFlight = Math.max(maxInFlight, produced - r.dev.dataBytes);
        produced += b.length;
        yield b;
      }
    }
    const res = await r.s.push({ remotePath: `${ROOT}/huge/x.cbz`, open: () => gen() });
    assert.strictEqual(res.bytes, total);
    // 4,096 guarded source waits on one long-lived socket leave nothing behind.
    assert.strictEqual(r.s.conn.endLatch.waiting, 0, "guard waiters released");
    const want = h.digest("hex");
    assert.strictEqual(res.sha256, want);
    const node = r.dev.fs.lookup(`${ROOT}/huge/x.cbz`).node;
    assert.strictEqual(r.dev.fs.sha(node), want);
    assert.ok(maxInFlight < 24 * 1024 * 1024, `in flight peaked at ${(maxInFlight / 1048576).toFixed(1)} MiB`);
  } finally {
    await r.close();
  }
});

// After the last DATA the client waits for OKAY while the device drains what
// the loopback buffers hold, with no observable progress: (buffered bytes) /
// (device rate). Measured here: ~1 s at 8 MB/s. So the idle budget below sits
// above that, and the push runs well past it in total.
test("watchdog: a throttled device that keeps reading never times out", async () => {
  const idleMs = 2500;
  const r = await rig({ device: { inject: { bytesPerSec: 8 * 1024 * 1024 } }, clientOpts: { idleMs } });
  try {
    r.dev.fs.hashOnlyPrefixes.push(`${ROOT}/slow`);
    const data = Buffer.alloc(32 * 1024 * 1024, 1);
    const t = Date.now();
    const res = await r.s.push({ remotePath: `${ROOT}/slow/x.cbz`, open: () => data });
    assert.strictEqual(res.bytes, data.length);
    assert.ok(Date.now() - t > idleMs + 500, `the push outlived the idle budget (${Date.now() - t} ms)`);
  } finally {
    await r.close();
  }
});

test("watchdog: a stalled device times out (charged 1), and counts FLUSHED bytes, not write calls", async () => {
  const r = await rig({ device: { inject: { stallPaths: [{ pattern: /stall/, op: "send" }] } }, clientOpts: { idleMs: 300 } });
  try {
    const t = Date.now();
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/stall.cbz`, open: () => Buffer.alloc(32 * 1024 * 1024) }), "timeout");
    assert.strictEqual(e.charges, 1);
    const dt = Date.now() - t;
    assert.ok(dt >= 300 && dt < 5000, `timed out after ${dt} ms`);
  } finally {
    await r.close();
  }
  // On a bare socket pair, at the client's real granularity (64 KiB writes):
  //  * a peer that never reads, with write CALLS still arriving every 40 ms
  //    (not awaiting drain): a watchdog fed by write calls would never fire;
  //    one fed by flushed bytes fires once the kernel buffers are full;
  //  * a peer that reads slowly, writes awaited one at a time: never fires.
  for (const mode of ["calls-without-flush", "slow-steady"]) {
    const srv = net.createServer();
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const peer = new Promise((res) => srv.once("connection", res));
    const sock = net.connect({ port: srv.address().port, host: "127.0.0.1" });
    await new Promise((res) => sock.once("connect", res));
    const other = await peer;
    const conn = new client._Conn(sock);
    conn.arm(300);
    const chunk = Buffer.alloc(65536 + 8);
    if (mode === "calls-without-flush") {
      other.pause();
      let calls = 0;
      while (!conn.timedOut && calls < 1000) {
        conn.write(chunk).catch(() => {});
        calls += 1;
        await sleep(40);
      }
      assert.strictEqual(conn.timedOut, true, `fired despite ${calls} write calls`);
      assert.ok(calls > 10, "write calls kept coming while nothing flushed");
    } else {
      other.on("data", () => {
        other.pause();
        setTimeout(() => other.resume(), 5);
      });
      const t = Date.now();
      while (Date.now() - t < 1500) await conn.write(chunk);
      assert.strictEqual(conn.timedOut, false, "slow-but-steady flushes keep it quiet");
    }
    conn.disarm();
    conn.destroy();
    other.destroy();
    await new Promise((res) => srv.close(res));
  }
});

// =====================================================================
// Errors: device loss
// =====================================================================

for (const order of ["frame-first", "eof-first"]) {
  test(`device loss: unplug mid-push (${order}) → device-lost once, charge 0, partial unlinked`, async () => {
    const r = await rig({ device: { inject: { unplugAfterBytes: 2 * 1024 * 1024, unplugOrder: order } } });
    try {
      const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/u.cbz`, open: () => Buffer.alloc(16 * 1024 * 1024, 3) }), "device-lost");
      assert.strictEqual(e.charges, 0);
      assertGone(r.dev.fs, `${ROOT}/u.cbz`);
      assert.ok(r.srv.requests("unplugged-mid-send").length === 1);
      const sends = r.srv.requests("sync").filter((x) => x.id === "SEND");
      assert.strictEqual(sends.length, 1, "no retry against a vanished device");
    } finally {
      await r.close();
    }
  });
}

test("device loss: an RST unplug is device-lost too (ECONNRESET handled as EOF)", async () => {
  const r = await rig({ device: { inject: { unplugAfterBytes: 1024 * 1024, unplugReset: true, unplugOrder: "eof-first" } } });
  try {
    await expectAdbError(r.s.push({ remotePath: `${ROOT}/u.cbz`, open: () => Buffer.alloc(8 * 1024 * 1024) }), "device-lost");
  } finally {
    await r.close();
  }
});

test("device loss: the recheck waits out a server slow to drop the device (lag < recheck → device-lost, charge 0)", async () => {
  const r = await rig({ device: { inject: { unplugAfterBytes: 1024 * 1024, unplugOrder: "eof-first", listLagMs: 150 } }, clientOpts: { recheckMs: 400 } });
  try {
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/u.cbz`, open: () => Buffer.alloc(8 * 1024 * 1024) }), "device-lost");
    assert.strictEqual(e.charges, 0);
    assert.strictEqual(r.srv.requests("sync").filter((x) => x.id === "SEND").length, 1);
  } finally {
    await r.close();
  }
});

test("device loss: a removal slower than the recheck reads as offline (no retry, charge 0), then device-lost", async () => {
  const r = await rig({ device: { inject: { unplugAfterBytes: 1024 * 1024, unplugOrder: "eof-first", listLagMs: 400 } }, clientOpts: { recheckMs: 20 } });
  try {
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/u.cbz`, open: () => Buffer.alloc(8 * 1024 * 1024) }), "offline");
    assert.strictEqual(e.charges, 0);
    assert.strictEqual(r.srv.requests("sync").filter((x) => x.id === "SEND").length, 1, "no retry");
    await sleep(450);
    await expectAdbError(r.s.stat(ROOT), "device-lost");
  } finally {
    await r.close();
  }
});

test("device loss: a wireless transport that stays listed offline is offline, and binds FAIL 'device offline'", async () => {
  const r = await rig({ device: { inject: { unplugAfterBytes: 1024 * 1024, stayOffline: true } } });
  try {
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/w.cbz`, open: () => Buffer.alloc(4 * 1024 * 1024) }), "offline");
    assert.strictEqual(e.charges, 0);
    const b = await expectAdbError(r.s.stat(ROOT), "offline");
    assert.strictEqual(b.failText, "device offline");
  } finally {
    await r.close();
  }
});

test("device loss: the same serial back with a new transport id is a removal plus an add", async () => {
  const r = await rig();
  try {
    await r.s.stat(ROOT);
    const pinned = r.d.transportId;
    await r.srv.unplug(SERIAL);
    r.srv.replug(r.dev);
    assert.notStrictEqual(r.dev.transportId, pinned);
    const e = await expectAdbError(r.s.stat(ROOT), "device-lost");
    assert.ok(/re-attached/.test(e.message));
    // A NEW handle (the next run) binds the new id fine.
    assert.ok((await r.c.device(SERIAL).sync().stat(ROOT)).ok);
  } finally {
    await r.close();
  }
});

test("device loss: a re-attach while no session is open is refused at the next bind (pinned id)", async () => {
  const r = await rig();
  try {
    await r.s.stat(ROOT);
    await r.s.close(); // no live socket: no EOF to recheck, only the bind can tell
    await r.srv.unplug(SERIAL);
    r.srv.replug(r.dev);
    const before = r.srv.requests("sync").length;
    const e = await expectAdbError(r.s.stat(ROOT), "device-lost");
    assert.ok(/re-attached/.test(e.message), e.message);
    assert.strictEqual(e.charges, 0);
    assert.strictEqual(r.srv.requests("sync").length, before, "no sync request reached the re-attached device");
    assert.strictEqual((await expectAdbError(r.d.shell("true"), "device-lost")).sent, false);
    assert.ok(!r.srv.requests("shell").length, "nor a shell command");
  } finally {
    await r.close();
  }
});

test("device loss: the server dying mid-job is server-unavailable", async () => {
  const r = await rig({ device: { inject: { bytesPerSec: 2 * 1024 * 1024 } } });
  try {
    r.dev.fs.hashOnlyPrefixes.push(`${ROOT}/z`);
    const p = r.s.push({ remotePath: `${ROOT}/z/x.cbz`, open: () => Buffer.alloc(16 * 1024 * 1024) });
    await sleep(150);
    await r.srv.close();
    await expectAdbError(p, "server-unavailable");
  } finally {
    await r.close();
  }
});

test("cancel mid-SEND: socket destroyed at once, kind cancelled, the fake unlinks the partial", async () => {
  const r = await rig({ device: { inject: { bytesPerSec: 8 * 1024 * 1024 } } });
  try {
    const ac = new AbortController();
    const p = r.s.push({
      remotePath: `${ROOT}/c.cbz`,
      open: () => Buffer.alloc(32 * 1024 * 1024, 9),
      signal: ac.signal,
      onProgress: (n) => {
        if (n > 1024 * 1024) ac.abort();
      },
    });
    const t = Date.now();
    const e = await expectAdbError(p, "cancelled");
    assert.strictEqual(e.charges, 0);
    assert.ok(Date.now() - t < 3000);
    assert.strictEqual(r.s.conn, null, "socket dropped");
    for (let i = 0; i < 50 && r.dev.fs.readFile(`${ROOT}/c.cbz`) != null; i += 1) await sleep(20);
    assertGone(r.dev.fs, `${ROOT}/c.cbz`, "partial unlinked by the fake adbd");
    await expectAdbError(r.s.stat(ROOT, { signal: ac.signal }), "cancelled");
  } finally {
    await r.close();
  }
});

test("sync FAIL texts → kinds", () => {
  assert.strictEqual(client.classifySyncFail("write failed: No space left on device"), "no-space");
  assert.strictEqual(client.classifySyncFail("couldn't create file: Read-only file system"), "read-only");
  assert.strictEqual(client.classifySyncFail("couldn't create file: Permission denied"), "remote-fail");
  assert.throws(() => new AdbError("nope", "x"), /unknown AdbError kind/);
});

// =====================================================================
// Cancel, destroy, caller code, binding (the P2 adversarial review)
// =====================================================================

test("destroy() mid-push ends it as cancelled: no retry, no charge, the session stays dead", async () => {
  const r = await rig({ device: { inject: { bytesPerSec: 8 * 1024 * 1024 } } });
  try {
    const charged = [];
    const s = r.d.sync({ onCharge: (e) => charged.push(e.kind) });
    const p = s.push({
      remotePath: `${ROOT}/d.cbz`,
      open: () => Buffer.alloc(32 * 1024 * 1024, 1),
      onProgress: (n) => {
        if (n > 1024 * 1024) s.destroy();
      },
    });
    const e = await expectAdbError(p, "cancelled");
    assert.strictEqual(e.charges, 0);
    assert.deepStrictEqual(charged, []);
    assert.strictEqual(s.opens, 1, "not retried on a fresh session");
    await sleep(100); // the fake shares this event loop; let it parse what was queued
    assert.strictEqual(r.srv.requests("sync").filter((x) => x.id === "SEND").length, 1, "one SEND");
    await expectAdbError(s.stat(ROOT), "cancelled");
    assert.strictEqual(s.opens, 1, "a destroyed session stays closed");
  } finally {
    await r.close();
  }
});

test("destroy() while the bind is in flight: cancelled, and the fresh socket is dropped, not adopted", async () => {
  const r = await rig({ server: { inject: { bindDelayMs: 150 } } });
  try {
    const s = r.d.sync();
    const q = s.stat(ROOT);
    await sleep(50);
    s.destroy();
    await expectAdbError(q, "cancelled");
    assert.strictEqual(s.conn, null);
    assert.strictEqual(s.opens, 0);
    await sleep(80);
    assert.strictEqual(r.dev.sockets.size, 0, "no device socket left open");
  } finally {
    await r.close();
  }
});

test("shell: an abort during the bind never sends the command (cancelled, sent:false)", async () => {
  const r = await rig({ server: { inject: { bindDelayMs: 200 } } });
  try {
    await r.d.features();
    const ac = new AbortController();
    const p = r.d.shell("rm -f /sdcard/x", { signal: ac.signal });
    await sleep(50);
    const t = Date.now();
    ac.abort();
    const e = await expectAdbError(p, "cancelled");
    assert.strictEqual(e.sent, false);
    assert.ok(Date.now() - t < 150, "the bind was dropped at once");
    await sleep(250);
    assert.ok(!r.srv.requests("shell").length, "the command never reached the device");
  } finally {
    await r.close();
  }
});

test("shell: an abort after the command was sent is cancelled with sent:true", async () => {
  const r = await rig({ device: { inject: { shellDelayMs: 300 } } });
  try {
    const ac = new AbortController();
    const p = r.d.shell("true", { signal: ac.signal });
    await sleep(100);
    ac.abort();
    const e = await expectAdbError(p, "cancelled");
    assert.strictEqual(e.sent, true);
    assert.strictEqual(r.srv.requests("shell").length, 1);
  } finally {
    await r.close();
  }
});

test("old server (no tport): the pin is checked against devices -l BEFORE binding", async () => {
  const r = await rig({ server: { inject: { noTport: true } } });
  try {
    await r.s.stat(ROOT);
    await r.s.close();
    await r.srv.unplug(SERIAL);
    r.srv.replug(r.dev);
    const binds = () => r.srv.requests("host").filter((x) => x.service.startsWith("host:transport:")).length;
    const b0 = binds();
    const e = await expectAdbError(r.d.shell("true"), "device-lost");
    assert.ok(/re-attached/.test(e.message), e.message);
    assert.strictEqual(e.sent, false);
    assert.strictEqual(binds(), b0, "refused before binding");
    // Gone and not back: no row → device-lost, still before any bind.
    await r.srv.unplug(SERIAL);
    const e2 = await expectAdbError(r.d.shell("true"), "device-lost");
    assert.ok(/disconnected/.test(e2.message), e2.message);
    assert.strictEqual(binds(), b0);
    assert.ok(!r.srv.requests("shell").length);
  } finally {
    await r.close();
  }
});

test("host: a bind that never answers is a timeout, not server-unavailable", async () => {
  const r = await rig({ server: { inject: { bindDelayMs: 2000 } }, clientOpts: { idleMs: 200 } });
  try {
    const e = await expectAdbError(r.s.stat(ROOT), "timeout");
    assert.strictEqual(e.sent, false);
  } finally {
    await r.close();
  }
});

test("caller code: a stalled PC source or sink can't outlive a cancel or the watchdog", async () => {
  const r = await rig({ clientOpts: { idleMs: 300 } });
  try {
    const stalled = () => ({
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(65536, 1);
        await new Promise(() => {});
      },
    });
    // Cancel: ends at once although the source never answers again.
    const ac = new AbortController();
    const p = r.s.push({ remotePath: `${ROOT}/s1.cbz`, open: stalled, signal: ac.signal, onProgress: () => setTimeout(() => ac.abort(), 30) });
    assert.strictEqual((await expectAdbError(p, "cancelled")).charges, 0);
    // No cancel: the watchdog ends it (no socket progress while the source hangs).
    const t = Date.now();
    await expectAdbError(r.s.push({ remotePath: `${ROOT}/s2.cbz`, open: stalled }), "timeout");
    assert.ok(Date.now() - t < 3000, `watchdog after ${Date.now() - t} ms`);
    // An open() that never resolves: cancelled, and no SEND went out.
    const ac2 = new AbortController();
    const p2 = r.s.push({ remotePath: `${ROOT}/s3.cbz`, open: () => new Promise(() => {}), signal: ac2.signal });
    setTimeout(() => ac2.abort(), 50);
    await expectAdbError(p2, "cancelled");
    assert.ok(!r.srv.requests("sync").some((x) => x.id === "SEND" && x.path.includes("s3")), "no SEND before the source opened");
    // A pull sink that never resolves.
    r.dev.fs.writeFile(`${ROOT}/big.json`, Buffer.alloc(256 * 1024, 2));
    const ac3 = new AbortController();
    const p3 = r.s.pull(`${ROOT}/big.json`, { sink: () => new Promise(() => {}), signal: ac3.signal });
    setTimeout(() => ac3.abort(), 50);
    await expectAdbError(p3, "cancelled");
    // Nothing is wedged: the next op on the same session runs.
    assert.ok((await r.s.stat(ROOT)).ok);
  } finally {
    await r.close();
  }
});

test("caller code: an early FAIL is reported at once even while the PC source is slow", async () => {
  const r = await rig({ device: { inject: { failPaths: [{ pattern: /slowsrc/, op: "send", at: "data", errno: wire.ERRNO.EIO }] } }, clientOpts: { idleMs: 3000 } });
  try {
    const slow = () => ({
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(65536, 1);
        await sleep(2000);
        yield Buffer.alloc(65536, 1);
      },
    });
    const t = Date.now();
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/slowsrc.cbz`, open: slow }), "remote-fail");
    assert.strictEqual(e.failText, "write failed: I/O error");
    assert.ok(Date.now() - t < 1000, `FAIL reported after ${Date.now() - t} ms, not after the source's next chunk`);
  } finally {
    await r.close();
  }
});

test("lifecycle: an early FAIL while a write waits on a slow device is reported at once (the write races the status)", async () => {
  // adbd discards the DATA in flight after a FAIL at device speed, so a
  // write blocked on backpressure would flush only seconds later.
  const r = await rig({ device: { inject: { bytesPerSec: 256 * 1024, failPaths: [{ pattern: /blocked/, op: "send", at: "data", errno: wire.ERRNO.EIO }] } } });
  try {
    const t = Date.now();
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/blocked.cbz`, open: () => Buffer.alloc(32 * 1024 * 1024, 1) }), "remote-fail");
    assert.strictEqual(e.failText, "write failed: I/O error");
    assert.ok(Date.now() - t < 1000, `FAIL reported after ${Date.now() - t} ms, not after the blocked write flushed`);
  } finally {
    await r.close();
  }
});

test("lifecycle: a FAIL that lands while DONE waits on drain is the result, not a watchdog timeout", async () => {
  // The kernel takes an 8-byte DONE unless its buffers are full, so the stub
  // holds DONE the way a full buffer would: until the socket ends.
  const idleMs = 3000;
  const r = await rig({ device: { inject: { bytesPerSec: 64 * 1024, failPaths: [{ pattern: /donewin/, op: "send", at: "data", errno: wire.ERRNO.EIO }] } }, clientOpts: { idleMs } });
  const write = client._Conn.prototype.write;
  let doneWrites = 0;
  client._Conn.prototype.write = function (b) {
    if (Buffer.isBuffer(b) && b.length === wire.SYNC_MSG_SIZE && b.toString("latin1", 0, 4) === wire.ID.DONE) {
      doneWrites += 1;
      return this.guard(new Promise(() => {}));
    }
    return write.call(this, b);
  };
  try {
    const t = Date.now();
    const e = await expectAdbError(r.s.push({ remotePath: `${ROOT}/donewin.cbz`, open: () => Buffer.alloc(65536, 1) }), "remote-fail");
    assert.strictEqual(e.failText, "write failed: I/O error");
    assert.strictEqual(doneWrites, 1, "the FAIL landed while DONE was pending");
    assert.ok(Date.now() - t < idleMs - 500, `FAIL reported after ${Date.now() - t} ms, not at the watchdog`);
  } finally {
    client._Conn.prototype.write = write;
    await r.close();
  }
});

test("watchdog: the OKAY wait gets a drain allowance for what delayed_ack let the server send ahead", async () => {
  // 24 MiB: more than the window plus the kernel buffers, so the stream
  // also crosses the fake's read-ahead pauses, which must stay short of the
  // plain idle budget (as adbd's per-flush acks keep them).
  const idleMs = 1000;
  const size = 24 * 1024 * 1024;
  const r = await rig({ device: { inject: { bytesPerSec: 4 * 1024 * 1024, delayedAckBytes: 8 * 1024 * 1024 } }, clientOpts: { idleMs } });
  try {
    assert.ok((await r.d.features()).has("delayed_ack"));
    r.dev.fs.hashOnlyPrefixes.push(`${ROOT}/dk`);
    let lastProgressAt = 0;
    const res = await r.s.push({ remotePath: `${ROOT}/dk/x.cbz`, open: () => Buffer.alloc(size, 5), onProgress: () => (lastProgressAt = Date.now()) });
    const wait = Date.now() - lastProgressAt;
    assert.strictEqual(res.bytes, size);
    assert.ok(wait > idleMs + 300, `the OKAY wait (${wait} ms) outlasted the plain idle budget`);
  } finally {
    await r.close();
  }
});

test("fake: bytes sent along with a transport switch are dropped (SwitchedTransport clears the buffer)", async () => {
  const r = await rig();
  try {
    const sock = net.connect({ port: r.port, host: "127.0.0.1" });
    await new Promise((res) => sock.once("connect", res));
    const conn = new client._Conn(sock);
    await conn.write(Buffer.concat([wire.encodeHostRequest(`host:tport:serial:${SERIAL}`), wire.encodeHostRequest("sync:")]));
    assert.deepStrictEqual(await conn.readHostStatus(), { ok: true });
    await conn.read(8);
    const pending = conn.read(4).then((b) => b.toString("latin1"));
    assert.strictEqual(await Promise.race([pending, sleep(300).then(() => "nothing")]), "nothing", "the piggybacked sync: was dropped");
    await conn.write(wire.encodeHostRequest("sync:"));
    assert.strictEqual(await pending, "OKAY", "a request sent after the switch is served");
    conn.destroy();
  } finally {
    await r.close();
  }
});

test("fake shell: mksh syntax errors run nothing (;;, a leading ;, a trailing &&); empty lines and a trailing ; are fine", async () => {
  const r = await rig();
  try {
    r.dev.fs.writeFile(`${ROOT}/k.cbz`, "k");
    for (const cmd of [`rm -f '${ROOT}/k.cbz';;`, `; rm -f '${ROOT}/k.cbz'`, `rm -f '${ROOT}/k.cbz' &&`]) {
      const res = await r.d.shell(cmd);
      assert.strictEqual(res.exitCode, 2, cmd);
      assert.ok(res.stderr.toString().includes("syntax error"), cmd);
      assert.ok(r.dev.fs.readFile(`${ROOT}/k.cbz`) !== null, `${cmd}: nothing ran`);
    }
    const ok = await r.d.shell("echo a;\n\necho b;");
    assert.deepStrictEqual([ok.exitCode, ok.stdout.toString()], [0, "a\nb\n"]);
  } finally {
    await r.close();
  }
});

// =====================================================================
// locate / start-server
// =====================================================================

test("locate: Windows candidates in order, quoted PATH entries, case-insensitive dedupe", () => {
  const env = {
    PATH: 'C:\\Windows;"C:\\Android\\platform-tools";C:\\tools',
    ANDROID_HOME: "C:\\Android",
    ANDROID_SDK_ROOT: "D:\\Sdk",
    LOCALAPPDATA: "C:\\Users\\legoc\\AppData\\Local",
  };
  const c = locate.candidatePaths({ configured: "c:\\android\\PLATFORM-TOOLS\\ADB.EXE", env, platform: "win32" });
  assert.deepStrictEqual(
    c.map((x) => [x.source, x.path]),
    [
      ["configured", "c:\\android\\PLATFORM-TOOLS\\ADB.EXE"],
      ["PATH", "C:\\Windows\\adb.exe"],
      ["PATH", "C:\\tools\\adb.exe"],
      ["ANDROID_SDK_ROOT", "D:\\Sdk\\platform-tools\\adb.exe"],
      ["LOCALAPPDATA", "C:\\Users\\legoc\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe"],
    ],
  );
  const p = locate.candidatePaths({ env: { PATH: "/usr/bin:/opt/sdk/platform-tools", ANDROID_HOME: "/opt/sdk" }, platform: "linux" });
  assert.deepStrictEqual(
    p.map((x) => x.path),
    ["/usr/bin/adb", "/opt/sdk/platform-tools/adb"],
  );
});

test("locate: adb version parsing; working candidates resolved, configured reported even when missing", async () => {
  const out = "Android Debug Bridge version 1.0.41\r\nVersion 35.0.2-12147458\r\nInstalled as C:\\Android\\platform-tools\\adb.exe\r\nRunning on Windows 10.0.26100\r\n";
  assert.deepStrictEqual(locate.parseAdbVersion(out), { version: "1.0.41", build: "35.0.2-12147458", installedAs: "C:\\Android\\platform-tools\\adb.exe" });
  assert.strictEqual(locate.parseAdbVersion("garbage"), null);
  const calls = [];
  const execFile = (bin, args, opts, cb) => {
    calls.push([bin, args, opts]);
    if (bin.includes("broken")) cb(new Error("spawn EPERM"), "", "");
    else cb(null, out, "");
  };
  const exists = async (p) => !p.includes("Missing");
  const res = await locate.locateAdb({
    configured: "C:\\Missing\\adb.exe",
    env: { PATH: "C:\\broken;C:\\Android\\platform-tools" },
    platform: "win32",
    execFile,
    exists,
  });
  assert.deepStrictEqual(
    res.candidates.map((c) => [c.source, c.ok, c.version || c.error]),
    [
      ["configured", false, "not found"],
      ["PATH", false, "spawn EPERM"],
      ["PATH", true, "1.0.41"],
    ],
  );
  assert.strictEqual(res.resolved, "C:\\Android\\platform-tools\\adb.exe");
  assert.ok(calls.every(([, args, opts]) => args[0] === "version" && opts.windowsHide === true));
});

test("start-server: only when the server is unreachable; cwd is the binary's folder; never kill-server", async () => {
  // Server up: nothing spawned.
  const r = await rig();
  try {
    const spawned = [];
    const up = await locate.ensureServer(r.c, "C:\\sdk\\platform-tools\\adb.exe", { execFile: (...a) => spawned.push(a), platform: "win32" });
    assert.deepStrictEqual([up.ok, up.started, up.version], [true, false, 41]);
    assert.strictEqual(spawned.length, 0);
  } finally {
    await r.close();
  }
  // Server down: start-server runs once, then the server answers.
  const probe = net.createServer();
  await new Promise((res) => probe.listen(0, "127.0.0.1", res));
  const port = probe.address().port;
  await new Promise((res) => probe.close(res));
  const srv = new FakeAdbServer();
  const c = new AdbClient({ port, connectTimeoutMs: 1000 });
  const spawned = [];
  const execFile = (bin, args, opts, cb) => {
    spawned.push({ bin, args, opts });
    srv.listen(port).then(() => cb(null, "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n", ""));
  };
  try {
    const res = await locate.ensureServer(c, "C:\\sdk\\platform-tools\\adb.exe", { execFile, platform: "win32", retryMs: 20 });
    assert.deepStrictEqual([res.ok, res.started, res.version], [true, true, 41]);
    assert.strictEqual(spawned.length, 1);
    assert.deepStrictEqual(spawned[0].args, ["start-server"]);
    assert.strictEqual(spawned[0].opts.cwd, "C:\\sdk\\platform-tools");
    assert.strictEqual(spawned[0].opts.windowsHide, true);
    assert.ok(!srv.log.some((e) => e.kind === "kill" || /kill/.test(e.service || "")));
    // Without a binary nothing is spawned and the error says why.
    await srv.close();
    const none = await locate.ensureServer(c, null, { execFile: () => assert.fail("spawned") });
    assert.strictEqual(none.ok, false);
  } finally {
    await srv.close();
  }
});

test("no file in sync/adb ever builds a kill-server request", () => {
  const fs = require("fs");
  for (const f of ["wire.js", "client.js", "locate.js"]) {
    const src = fs.readFileSync(path.join(ADB, f), "utf8");
    assert.ok(!/["'`]host:kill/.test(src) && !/["'`]kill-server["'`]/.test(src.replace(/\/\/.*$/gm, "")), f);
  }
});

// =====================================================================

// TEST_ONLY=<regex> runs the matching tests only (repeat runs of one test).
(async () => {
  const only = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
  for (const t of tests) {
    if (only && !only.test(t.name)) continue;
    const started = Date.now();
    try {
      await Promise.race([t.fn(), sleep(30000).then(() => Promise.reject(new Error("test timed out (30 s)")))]);
      passed += 1;
      const dt = Date.now() - started;
      console.log(`  ok   ${t.name}${dt > 1000 ? ` (${dt} ms)` : ""}`);
    } catch (e) {
      failed += 1;
      failures.push({ name: t.name, e });
      console.log(`  FAIL ${t.name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n       ")}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (node ${process.versions.node})`);
  process.exit(failed ? 1 : 0);
})();
