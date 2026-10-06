// Fake adb SERVER + adbd for Device Sync tests, backed by an in-memory
// filesystem per device. One TCP listener speaks the server's smart-socket
// protocol; after a transport switch the same socket speaks adbd's sync or
// shell protocol for the chosen device.
//
// FIDELITY IS THE DELIVERABLE (non-UI plan, P2). A fake kinder than adbd
// hides exactly the bugs the reviews found, so each behavior below mirrors
// AOSP packages/modules/adb @ 1cf2f01 and cites where:
//   * SEND (daemon/file_sync_service.cpp send_impl/handle_send_file):
//     lstat → unlink an existing regular file → open O_EXCL → on ENOENT
//     secure_mkdirs + retry → on EEXIST reopen WITHOUT O_TRUNC (only reached
//     when the unlink failed) → DATA… DONE → OKAY, then lutimes(DONE mtime).
//     Any failure: FAIL at once, drain DATA until DONE (or EOF), unlink the
//     partial, END THE SESSION. A client EOF mid-stream is the same path.
//   * the spec "path,mode" splits at the LAST comma; mode is strtoul base 0;
//   * path_length > 1024 → FAIL "path too long", session ends;
//   * LIST/LIS2 of a missing / non-dir / locked path → DONE only; `.` and
//     `..` are listed; LIS2 entries whose lstat failed carry errno + zeros
//     (v1 skips them); the DONE is a full zeroed dent record;
//   * STA2/LST2 never FAIL: errors in the `error` field; STAT v1 → mode 0;
//   * RECV of a missing file → FAIL "open failed: …"; of a directory →
//     FAIL "read failed: Is a directory"; both end the session;
//   * QUIT ends the session without a reply; unknown ids FAIL;
//   * STA2/LST2/LIS2 FAIL as unknown commands when the device doesn't
//     advertise stat_v2/ls_v2 (an old adbd simply doesn't know them);
//   * server: acquire_one_transport's exact FAIL texts and state checks,
//     `host:tport:serial:` → OKAY + u64 LE transport id, unknown services →
//     "unknown host service '<svc>'", a device service the device refuses →
//     FAIL "closed", track-devices-l frames ("%04x" + long list; "0000" when
//     empty) and a tracker closed when the client writes to it;
//   * shell,v2: stdout/stderr/exit packets; legacy shell: merged output.
//
// INJECTIONS (per device `inject`, or server.inject): see DEFAULT_INJECT and
// FakeAdbServer.unplug/replug/restart. They cover the plan's list: unplug
// after N bytes, FAIL per path pattern, ENOSPC (capacity) and EROFS, locked
// storage, a failed unlink, missing ls_v2/stat_v2/shell_v2, a FAIL on
// host:tport:, case-insensitive lookups, no sha256sum / no find -printf,
// throttled throughput, plus drops and stalls for the lifecycle tests.
//
// Used by tools/_test_device_sync_adb.js (P2) and the exec/service tests of
// later phases. tools/ is gitignored; this file is force-added on
// wip/device-sync-handoff only and never ships.

const net = require("net");
const crypto = require("crypto");
const path = require("path");
const wire = require(path.join(__dirname, "..", "UI-source", "electron", "sync", "adb", "wire.js"));

const { ERRNO, S_IFDIR, S_IFREG } = wire;

// bionic strerror() texts for the errnos the fake produces.
const STRERROR = {
  [ERRNO.EPERM]: "Operation not permitted",
  [ERRNO.ENOENT]: "No such file or directory",
  [ERRNO.EIO]: "I/O error",
  [ERRNO.EACCES]: "Permission denied",
  [ERRNO.EEXIST]: "File exists",
  [ERRNO.ENOTDIR]: "Not a directory",
  [ERRNO.EISDIR]: "Is a directory",
  [ERRNO.ENOSPC]: "No space left on device",
  [ERRNO.EROFS]: "Read-only file system",
  [ERRNO.ENAMETOOLONG]: "File name too long",
  39: "Directory not empty",
};
const ENOTEMPTY = 39;

const DEFAULT_FEATURES = Object.freeze([
  "shell_v2",
  "cmd",
  "stat_v2",
  "ls_v2",
  "fixed_push_mkdir",
  "apex",
  "abb",
  "fixed_push_symlink_timestamp",
  "abb_exec",
  "remount_shell",
  "track_app",
  // Not sendrecv_v2: the fake implements SEND/RECV v1 only, and a fake that
  // advertised what it can't do would be kinder than nothing.
]);

const DEFAULT_INJECT = Object.freeze({
  // [{pattern:RegExp, op:'send'|'recv', at:'open'|'data', errno}] → FAIL.
  // Any entry in these three lists may carry `times`: it then applies to that
  // many requests and is spent.
  failPaths: [],
  // [{pattern, op}] → the session closes with NO reply (deterministic drop)
  dropPaths: [],
  // [{pattern, op}] → stop reading forever (watchdog tests)
  stallPaths: [],
  // RegExp: unlink() of a matching path silently fails (→ reopen without O_TRUNC)
  unlinkFails: null,
  readOnly: false, // EROFS on every create/mkdir/unlink
  capacityBytes: Infinity, // ENOSPC once file bytes would exceed it
  // {prefix:string, errno} → STA2 errors, listings DONE-only, creates fail
  locked: null,
  // [{path:string, after:number}] → that listing stops after N entries (FUSE mid-readdir error)
  truncateList: [],
  // RegExp on the full path → LIS2 entry carries EACCES with zeroed fields
  lstatErrors: null,
  bytesPerSec: 0, // throttle the sync reader (0 = off)
  unplugAfterBytes: 0, // unplug once this many DATA bytes arrived (0 = off)
  unplugOrder: "frame-first", // or 'eof-first'
  unplugReset: false, // RST instead of FIN on the device's sockets
  listLagMs: 0, // an unplugged device stays listed (as offline) this long after its EOFs
  stayOffline: false, // an unplug never removes it: a TCP/wireless transport under reconnect
  delayedAckBytes: 0, // > 0: read ahead this far on sync sockets (the 32 MiB delayed_ack window) and advertise delayed_ack
  shellDelayMs: 0, // a shell command "runs" this long before its output
  pushMtime: "done", // 'done' (lutimes the DONE value, as AOSP) or 'now' (the tablet's push-time behavior)
  lutimesDelayMs: 0, // other sessions see the old mtime this long after OKAY
  legacyCrlf: true, // legacy shell output uses \r\n (old adbd allocated a pty)
  tools: { sha256sum: true, findPrintf: true },
});

// --- in-memory filesystem --------------------------------------------------

let _ino = 100;

function _dir(mtime) {
  return { type: "dir", mode: S_IFDIR | 0o771, children: new Map(), mtime, ino: _ino++ };
}

function _file(mode, mtime, hashOnly) {
  return { type: "file", mode: S_IFREG | (mode & 0o7777), data: Buffer.alloc(0), size: 0, mtime, ino: _ino++, hashOnly, hash: hashOnly ? crypto.createHash("sha256") : null, sha: null, shaValid: true };
}

const _b = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), "utf8"));

/**
 * Paths are BYTES end to end (sync paths arrive as raw bytes, and device
 * names need not be UTF-8). Case-insensitive mode keys children by the
 * lowercased UTF-8 name but keeps the stored name byte-exact, like
 * sdcardfs/FUSE on shared storage.
 */
class MemFs {
  constructor({ caseInsensitive = false, now } = {}) {
    this.ci = !!caseInsensitive;
    this.now = now || (() => Math.floor(Date.now() / 1000));
    this.root = _dir(this.now());
    this.used = 0;
    this.hashOnlyPrefixes = [];
  }

  _key(nameBuf) {
    if (!this.ci) return nameBuf.toString("latin1");
    const d = wire.decodeName(nameBuf);
    return d.name != null ? Buffer.from(d.name.toLowerCase(), "utf8").toString("latin1") : nameBuf.toString("latin1");
  }

  _parts(p) {
    const buf = _b(p);
    const parts = [];
    let start = 0;
    for (let i = 0; i <= buf.length; i += 1) {
      if (i === buf.length || buf[i] === 0x2f) {
        const seg = buf.subarray(start, i);
        start = i + 1;
        if (!seg.length || (seg.length === 1 && seg[0] === 0x2e)) continue;
        if (seg.length === 2 && seg[0] === 0x2e && seg[1] === 0x2e) {
          parts.pop();
          continue;
        }
        parts.push(Buffer.from(seg));
      }
    }
    return parts;
  }

  /** → {node, parent, name} | {error, parent?, name?}. */
  lookup(p) {
    const parts = this._parts(p);
    let node = this.root;
    let parent = null;
    for (let i = 0; i < parts.length; i += 1) {
      if (node.type !== "dir") return { error: ERRNO.ENOTDIR };
      const child = node.children.get(this._key(parts[i]));
      if (!child) return i === parts.length - 1 ? { error: ERRNO.ENOENT, parent: node, name: parts[i] } : { error: ERRNO.ENOENT };
      parent = node;
      node = child.node;
    }
    return { node, parent, name: parts[parts.length - 1] || null };
  }

  stat(p) {
    const r = this.lookup(p);
    if (r.error) return { error: r.error };
    const n = r.node;
    return { error: 0, mode: n.mode, size: n.type === "file" ? n.size : 4096, mtime: n.mtime, ino: n.ino, nlink: n.type === "dir" ? 2 : 1 };
  }

  /** Children incl. `.`/`..`, or null when the path isn't a listable dir. */
  list(p) {
    const r = this.lookup(p);
    if (r.error || r.node.type !== "dir") return null;
    const out = [
      { name: Buffer.from("."), node: r.node },
      { name: Buffer.from(".."), node: r.parent || r.node },
    ];
    for (const { name, node } of r.node.children.values()) out.push({ name, node });
    return out;
  }

  /** mkdir -p semantics of secure_mkdirs: EEXIST is fine even on a file. */
  mkdirs(p) {
    const parts = this._parts(p);
    let node = this.root;
    for (const part of parts) {
      if (node.type !== "dir") return ERRNO.ENOTDIR;
      const k = this._key(part);
      let child = node.children.get(k);
      if (!child) {
        child = { name: part, node: _dir(this.now()) };
        node.children.set(k, child);
        node.mtime = this.now();
      }
      node = child.node;
    }
    return 0;
  }

  _isHashOnly(p) {
    const s = _b(p).toString("utf8");
    return this.hashOnlyPrefixes.some((pre) => s.startsWith(pre));
  }

  /** open(O_WRONLY|O_CREAT|O_EXCL). → {node} | {error}. */
  createExclusive(p, mode) {
    const r = this.lookup(p);
    if (!r.error) return { error: ERRNO.EEXIST };
    if (!r.parent) return { error: r.error };
    if (r.parent.type !== "dir") return { error: ERRNO.ENOTDIR };
    const node = _file(mode, this.now(), this._isHashOnly(p));
    r.parent.children.set(this._key(r.name), { name: r.name, node });
    r.parent.mtime = this.now();
    return { node };
  }

  /** open(O_WRONLY) without O_TRUNC. */
  openExisting(p) {
    const r = this.lookup(p);
    if (r.error) return { error: r.error };
    if (r.node.type === "dir") return { error: ERRNO.EISDIR };
    return { node: r.node };
  }

  unlink(p) {
    const r = this.lookup(p);
    if (r.error) return r.error;
    if (r.node.type === "dir") return ERRNO.EISDIR;
    r.parent.children.delete(this._key(r.name));
    r.parent.mtime = this.now();
    this.used -= r.node.size;
    return 0;
  }

  rmdir(p) {
    const r = this.lookup(p);
    if (r.error) return r.error;
    if (r.node.type !== "dir") return ERRNO.ENOTDIR;
    if (r.node.children.size) return ENOTEMPTY;
    if (!r.parent) return ERRNO.EPERM;
    r.parent.children.delete(this._key(r.name));
    return 0;
  }

  /** rename(2): replaces a file target; a dir target must be empty. */
  rename(from, to) {
    const a = this.lookup(from);
    if (a.error) return a.error;
    if (!a.parent) return ERRNO.EPERM;
    const b = this.lookup(to);
    if (!b.error) {
      if (b.node === a.node) {
        // case-only rename on a case-insensitive fs: rewrite the stored name
        a.parent.children.delete(this._key(a.name));
        b.parent.children.set(this._key(b.name), { name: b.name, node: a.node });
        return 0;
      }
      if (b.node.type === "dir") {
        if (a.node.type !== "dir") return ERRNO.EISDIR;
        if (b.node.children.size) return ENOTEMPTY;
      } else if (a.node.type === "dir") return ERRNO.ENOTDIR;
      b.parent.children.delete(this._key(b.name));
      if (b.node.type === "file") this.used -= b.node.size;
    } else if (!b.parent) return b.error;
    const dest = b.parent;
    a.parent.children.delete(this._key(a.name));
    dest.children.set(this._key(b.name), { name: b.name, node: a.node });
    a.parent.mtime = this.now();
    dest.mtime = this.now();
    return 0;
  }

  /** Write at an offset (a reopened file is overwritten from 0, never truncated). */
  writeAt(node, pos, chunk) {
    const end = pos + chunk.length;
    if (node.hashOnly) {
      if (pos !== node.size) node.shaValid = false;
      else node.hash.update(chunk);
      if (end > node.size) {
        this.used += end - node.size;
        node.size = end;
      }
      return;
    }
    if (end > node.data.length) {
      const grown = Buffer.alloc(Math.max(end, node.data.length * 2));
      node.data.copy(grown, 0, 0, node.size);
      node.data = grown;
    }
    chunk.copy(node.data, pos);
    if (end > node.size) {
      this.used += end - node.size;
      node.size = end;
    }
  }

  contents(node) {
    return node.data.subarray(0, node.size);
  }

  sha(node) {
    if (node.hashOnly) {
      if (!node.sha) node.sha = node.shaValid ? node.hash.copy().digest("hex") : null;
      return node.sha;
    }
    return crypto.createHash("sha256").update(this.contents(node)).digest("hex");
  }

  // --- test helpers ---

  writeFile(p, data, { mtime, mode = 0o644 } = {}) {
    const parts = this._parts(p);
    this.mkdirs(Buffer.concat(parts.slice(0, -1).flatMap((x) => [Buffer.from("/"), x])));
    const ex = this.lookup(p);
    if (!ex.error) this.unlink(p);
    const c = this.createExclusive(p, mode);
    if (c.error) throw new Error(`writeFile ${p}: errno ${c.error}`);
    this.writeAt(c.node, 0, _b(data));
    if (mtime != null) c.node.mtime = mtime;
    return c.node;
  }

  readFile(p) {
    const r = this.lookup(p);
    if (r.error || r.node.type !== "file") return null;
    return Buffer.from(this.contents(r.node));
  }

  /** Stored child names of a dir (byte-exact), for assertions. */
  names(p) {
    const r = this.lookup(p);
    if (r.error || r.node.type !== "dir") return null;
    return [...r.node.children.values()].map((c) => c.name.toString("utf8")).sort();
  }
}

// --- socket reader (device side) ------------------------------------------------

/** Exact reads with a high-water pause; throttle and stall hooks for injections. */
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.q = new wire.ByteQueue();
    this.ended = false;
    this.waiter = null;
    this.paused = false;
    this.consumed = 0;
    this.throttle = 0;
    // Read-ahead: pause past highWater, resume under lowWater. By default
    // the kernel's share. Under delayed_ack adbd acks every flush
    // (sockets.cpp:148-150), so the window reopens almost at once; a resume
    // gap of a quarter of 8 MiB stalled the stream 1.5 s at 4 MiB/s, which
    // real adbd never does. What remains (~0.4 s at 4 MiB/s) is loopback
    // TCP's window update to a paused reader, which the real server's own
    // loopback leg has too.
    this.highWater = 1024 * 1024;
    this.lowWater = 256 * 1024;
    this.startedAt = Date.now();
    socket.on("data", (c) => {
      this.q.push(c);
      if (!this.paused && this.q.length > this.highWater) {
        this.paused = true;
        socket.pause();
      }
      this._wake();
    });
    const end = () => {
      this.ended = true;
      this._wake();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  _wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  /** n bytes, or null at EOF (the caller decides what EOF means there). */
  async read(n) {
    while (this.q.length < n) {
      if (this.ended) return null;
      if (this.paused && this.q.length < this.lowWater) {
        this.paused = false;
        this.socket.resume();
      }
      await new Promise((r) => {
        this.waiter = r;
      });
    }
    const b = this.q.take(n);
    this.consumed += n;
    if (this.paused && this.q.length < this.lowWater) {
      this.paused = false;
      this.socket.resume();
    }
    if (this.throttle > 0) {
      const due = this.startedAt + (this.consumed / this.throttle) * 1000;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return b;
  }

  /** Never consume again (a stalled device). */
  stall() {
    this.paused = true;
    this.socket.pause();
    return new Promise(() => {});
  }
}

function _write(socket, buf) {
  if (!socket.destroyed && socket.writable) socket.write(buf);
}

function _strtoul0(s) {
  const t = s.trim();
  let m;
  if ((m = /^0[xX]([0-9a-fA-F]+)/.exec(t))) return parseInt(m[1], 16) >>> 0;
  if ((m = /^0([0-7]*)/.exec(t))) return m[1] ? parseInt(m[1], 8) >>> 0 : 0;
  if ((m = /^(\d+)/.exec(t))) return Number(m[1]) >>> 0;
  return 0;
}

/** First injection entry matching (op, path); an entry with `times` is consumed. */
function _match(list, op, p) {
  const s = _b(p).toString("utf8");
  const hit = (list || []).find((x) => (!x.op || x.op === op) && x.pattern.test(s) && (x.times == null || x.times > 0)) || null;
  if (hit && hit.times != null) hit.times -= 1;
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the server --------------------------------------------------------------------

class FakeAdbServer {
  constructor(opts = {}) {
    this.devices = [];
    this.nextTransportId = 1;
    this.log = [];
    this.trackers = new Set();
    this.sockets = new Set();
    this.server = null;
    this.port = null;
    // noTport: FAIL host:tport: as unknown; bindDelayMs: answer a bind this late.
    this.inject = { noTport: false, bindDelayMs: 0, ...(opts.inject || {}) };
    this.now = opts.now || (() => Math.floor(Date.now() / 1000));
    this.version = opts.version != null ? opts.version : 41;
  }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((s) => this._accept(s));
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.trackers.clear();
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    this.server = null;
  }

  /** The adb server restarted: every socket drops, ids start over (deviation 6 / monitor tests). */
  async restart() {
    const port = this.port;
    await this.close();
    this.nextTransportId = 1;
    for (const d of this.devices) d.transportId = this.nextTransportId++;
    await this.listen(port);
  }

  /**
   * Add a device. `serial: ''` lists as "(no serial number)" and is not
   * targetable. The fs survives unplug/replug (same tablet).
   */
  addDevice(spec = {}) {
    const d = {
      serial: spec.serial != null ? spec.serial : "FAKE0001",
      state: spec.state || "device",
      devpath: spec.devpath === undefined ? "usb:1-1" : spec.devpath,
      product: spec.product === undefined ? "a06xx" : spec.product,
      model: spec.model === undefined ? "SM-X200" : spec.model,
      device: spec.device === undefined ? "gta8wifi" : spec.device,
      features: new Set([...(spec.features || DEFAULT_FEATURES), ...(spec.inject && spec.inject.delayedAckBytes ? ["delayed_ack"] : [])]),
      fs: spec.fs || new MemFs({ caseInsensitive: spec.caseInsensitive, now: this.now }),
      inject: { ...DEFAULT_INJECT, ...(spec.inject || {}), tools: { ...DEFAULT_INJECT.tools, ...((spec.inject && spec.inject.tools) || {}) } },
      transportId: this.nextTransportId++,
      sockets: new Set(),
      dataBytes: 0,
      syncSessions: 0,
      listed: true,
    };
    this.devices.push(d);
    this._notify();
    return d;
  }

  device(serial) {
    return this.devices.find((d) => d.serial === serial) || null;
  }

  setState(serial, state) {
    const d = this.device(serial);
    d.state = state;
    this._notify();
  }

  /**
   * Unplug, in AOSP's order (atransport::HandleError → handle_offline,
   * adb.cpp:201-222, then transport_destroy, transport.cpp:837-857): the
   * state goes `offline` (a tracker frame), every socket bound to it closes,
   * then the transport is removed (another frame). order 'frame-first'
   * sends the removal frame before the EOFs, 'eof-first' after them (plus
   * listLagMs), so clients get exercised both ways. stayOffline keeps it
   * listed as offline, as a TCP transport under its reconnect handler.
   */
  async unplug(serial, { order, reset, listLagMs, stayOffline } = {}) {
    const d = this.device(serial);
    if (!d || d.unplugged) return;
    d.unplugged = true;
    d.state = "offline";
    this._notify();
    order = order || d.inject.unplugOrder;
    reset = reset != null ? reset : d.inject.unplugReset;
    listLagMs = listLagMs != null ? listLagMs : d.inject.listLagMs;
    stayOffline = stayOffline != null ? stayOffline : d.inject.stayOffline;
    const kill = () => {
      for (const s of d.sockets) {
        if (reset && typeof s.resetAndDestroy === "function") s.resetAndDestroy();
        else s.destroy();
      }
      d.sockets.clear();
    };
    const drop = () => {
      const i = this.devices.indexOf(d);
      if (i !== -1) this.devices.splice(i, 1);
    };
    if (stayOffline) {
      kill();
    } else if (order === "frame-first") {
      drop();
      this._notify();
      await sleep(5);
      kill();
    } else {
      kill();
      if (listLagMs) await sleep(listLagMs);
      drop();
      await sleep(5);
      this._notify();
    }
  }

  /** Close the device's sockets while it stays listed (a dropped session, not an unplug). */
  kickSessions(serial, { reset = false } = {}) {
    const d = this.device(serial);
    for (const s of d.sockets) {
      if (reset && typeof s.resetAndDestroy === "function") s.resetAndDestroy();
      else s.destroy();
    }
    d.sockets.clear();
  }

  /** Plug the same tablet back in: same fs, NEW transport id. */
  replug(d) {
    d.transportId = this.nextTransportId++;
    d.unplugged = false;
    d.state = "device";
    d.dataBytes = 0;
    if (!this.devices.includes(d)) this.devices.push(d);
    this._notify();
    return d;
  }

  requests(kind) {
    return this.log.filter((e) => !kind || e.kind === kind);
  }

  // --- host protocol ---

  _listText() {
    return this.devices.map((d) => wire.formatDevicesLRow(d)).join("");
  }

  _notify() {
    const frame = wire.encodeProtocolString(this._listText());
    for (const t of this.trackers) _write(t, frame);
  }

  _accept(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const r = new Reader(socket);
    this._serve(socket, r).catch(() => socket.destroy());
  }

  async _readRequest(r) {
    const h = await r.read(4);
    if (!h) return null;
    const len = wire.parseHex4(h);
    if (len == null || len === 0) return null;
    const body = await r.read(len);
    return body;
  }

  _fail(socket, msg) {
    _write(socket, wire.encodeHostStatus(false, msg));
    socket.end();
  }

  _okay(socket, payload) {
    _write(socket, wire.encodeHostStatus(true));
    if (payload != null) _write(socket, wire.encodeProtocolString(payload));
  }

  /** acquire_one_transport (transport.cpp:912-1004), serial selection only. */
  _acquire(serial) {
    let error = `device '${serial}' not found`;
    let found = null;
    for (const d of this.devices) {
      if (d.state.startsWith("no permissions")) {
        error = "insufficient permissions for device\nSee [http://developer.android.com/tools/device.html] for more information";
        continue;
      }
      if (d.serial && d.serial === serial) {
        if (found) return { error: `more than one device with serial ${serial}` };
        found = d;
      }
    }
    if (!found) return { error };
    switch (found.state) {
      case "connecting":
        return { error: "device still connecting" };
      case "authorizing":
        return { error: "device still authorizing" };
      case "unauthorized":
        return {
          error:
            "device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set\nTry 'adb kill-server' if that seems wrong.\nOtherwise check for a confirmation dialog on your device.",
        };
      case "offline":
        return { error: "device offline" };
      default:
        return { device: found };
    }
  }

  async _serve(socket, r) {
    const raw = await this._readRequest(r);
    if (!raw) return socket.destroy();
    const service = raw.toString("utf8");
    this.log.push({ kind: "host", service });

    let m;
    if ((m = /^host-serial:(.*):([^:]+)$/s.exec(service))) {
      const [, serial, what] = m;
      if (what === "features") {
        const a = this._acquire(serial);
        if (a.error) return this._fail(socket, a.error);
        this._okay(socket, [...a.device.features].join(","));
        return socket.end();
      }
      return this._fail(socket, `unknown host service '${what}'`);
    }
    if (!service.startsWith("host:")) return this._fail(socket, "device offline (no transport)");
    const svc = service.slice(5);

    if (svc === "kill") {
      this.log.push({ kind: "kill" });
      this._okay(socket);
      return this.close();
    }
    if (svc === "version") {
      this._okay(socket, wire.hex4(this.version));
      return socket.end();
    }
    if (svc === "devices-l") {
      this._okay(socket, this._listText());
      return socket.end();
    }
    if (svc === "devices") {
      this._okay(socket, this.devices.map((d) => `${d.serial || wire.NO_SERIAL}\t${d.state}\n`).join(""));
      return socket.end();
    }
    if (svc === "track-devices-l") {
      this._okay(socket);
      this.trackers.add(socket);
      _write(socket, wire.encodeProtocolString(this._listText()));
      // device_tracker_enqueue: a tracker can't be written to; data closes it.
      socket.removeAllListeners("data");
      if (r.q.length) {
        this.trackers.delete(socket);
        return socket.destroy();
      }
      socket.on("data", () => {
        this.trackers.delete(socket);
        socket.destroy();
      });
      socket.on("close", () => this.trackers.delete(socket));
      return;
    }
    if ((m = /^tport:serial:(.*)$/s.exec(svc))) {
      if (this.inject.noTport) return this._fail(socket, `unknown host service '${svc}'`);
      if (this.inject.bindDelayMs) await sleep(this.inject.bindDelayMs);
      const a = this._acquire(m[1]);
      if (a.error) return this._fail(socket, a.error);
      _write(socket, wire.encodeHostStatus(true));
      const id = Buffer.alloc(8);
      id.writeBigUInt64LE(BigInt(a.device.transportId));
      _write(socket, id);
      return this._deviceService(socket, r, a.device);
    }
    if ((m = /^transport:(.*)$/s.exec(svc))) {
      if (this.inject.bindDelayMs) await sleep(this.inject.bindDelayMs);
      const a = this._acquire(m[1]);
      if (a.error) return this._fail(socket, a.error);
      _write(socket, wire.encodeHostStatus(true));
      return this._deviceService(socket, r, a.device);
    }
    return this._fail(socket, `unknown host service '${svc}'`);
  }

  async _deviceService(socket, r, d) {
    d.sockets.add(socket);
    socket.on("close", () => d.sockets.delete(socket));
    // SwitchedTransport clears the smart socket's buffer (sockets.cpp:865-868):
    // bytes that rode in with the bind request are dropped, not served.
    if (r.q.length) r.q.take(r.q.length);
    const raw = await this._readRequest(r);
    if (!raw) return socket.destroy();
    const service = raw.toString("utf8");
    this.log.push({ kind: "device", serial: d.serial, service });
    if (d.unplugged) return this._fail(socket, "closed"); // local_socket_close_notify on a dead transport
    if (d.state !== "device") return this._fail(socket, "device offline (transport offline)");
    if (service === "sync:") {
      _write(socket, wire.encodeHostStatus(true));
      d.syncSessions += 1;
      return this._sync(socket, r, d);
    }
    let m;
    if ((m = /^shell,([^:]*):(.*)$/s.exec(service))) {
      const args = m[1].split(",");
      if (!args.includes("v2") || !d.features.has("shell_v2")) return this._fail(socket, "closed");
      _write(socket, wire.encodeHostStatus(true));
      return this._shellV2(socket, r, d, m[2]);
    }
    if ((m = /^shell:(.*)$/s.exec(service))) {
      _write(socket, wire.encodeHostStatus(true));
      return this._shellLegacy(socket, d, m[1]);
    }
    return this._fail(socket, "closed");
  }

  // --- sync -----------------------------------------------------------------------

  _syncFail(socket, msg) {
    _write(socket, wire.encodeSyncFail(msg));
  }

  _locked(d, p) {
    const L = d.inject.locked;
    if (!L) return 0;
    return _b(p).toString("utf8").startsWith(L.prefix) ? L.errno || ERRNO.ENOENT : 0;
  }

  async _sync(socket, r, d) {
    r.throttle = d.inject.bytesPerSec || 0;
    if (d.inject.delayedAckBytes) {
      r.highWater = d.inject.delayedAckBytes;
      r.lowWater = Math.max(r.highWater / 4, r.highWater - 256 * 1024);
    }
    for (;;) {
      // adbd's loop is serial: lutimes (after OKAY) runs before the NEXT
      // request on this session is read. Other sessions don't wait.
      if (r.lutimes) await r.lutimes;
      const head = await r.read(8);
      if (!head) return socket.destroy(); // "command read failure" to a closed peer
      const id = head.toString("latin1", 0, 4);
      const plen = head.readUInt32LE(4);
      if (plen > wire.SYNC_PATH_MAX) {
        this._syncFail(socket, "path too long");
        return socket.end();
      }
      const p = plen ? await r.read(plen) : Buffer.alloc(0);
      if (p == null) {
        this._syncFail(socket, "filename read failure");
        return socket.end();
      }
      this.log.push({ kind: "sync", serial: d.serial, id, path: p.toString("utf8"), rawPath: p });
      let keep;
      switch (id) {
        case wire.ID.STAT:
          keep = this._statV1(socket, d, p);
          break;
        case wire.ID.STA2:
        case wire.ID.LST2:
          keep = d.features.has("stat_v2") ? this._statV2(socket, d, id, p) : this._unknown(socket, head);
          break;
        case wire.ID.LIST:
          keep = this._list(socket, d, p, false);
          break;
        case wire.ID.LIS2:
          keep = d.features.has("ls_v2") ? this._list(socket, d, p, true) : this._unknown(socket, head);
          break;
        case wire.ID.SEND:
          keep = await this._sendV1(socket, r, d, p);
          break;
        case wire.ID.RECV:
          keep = this._recv(socket, d, p);
          break;
        case wire.ID.QUIT:
          keep = false;
          break;
        default:
          keep = this._unknown(socket, head);
      }
      if (!keep) return socket.end();
    }
  }

  _unknown(socket, head) {
    this._syncFail(socket, `unknown command ${head.readUInt32LE(0).toString(16).padStart(8, "0")}`);
    return false;
  }

  _statV1(socket, d, p) {
    const lk = this._locked(d, p);
    const st = lk ? { error: lk } : d.fs.stat(p);
    _write(socket, wire.encodeStatV1(st.error ? {} : { mode: st.mode, size: st.size, mtime: st.mtime }));
    return true;
  }

  _statV2(socket, d, id, p) {
    const lk = this._locked(d, p);
    const st = lk ? { error: lk } : d.fs.stat(p);
    _write(socket, wire.encodeStatV2(st.error ? { id, error: st.error } : { id, dev: 0xfd00, ino: st.ino, mode: st.mode, nlink: st.nlink, uid: 1023, gid: 1023, size: st.size, atime: st.mtime, mtime: st.mtime, ctime: st.mtime }));
    return true;
  }

  _list(socket, d, p, v2) {
    const entries = this._locked(d, p) ? null : d.fs.list(p);
    if (entries) {
      const trunc = (d.inject.truncateList || []).find((t) => _b(t.path).equals(_b(p)));
      let n = 0;
      for (const { name, node } of entries) {
        if (trunc && n >= trunc.after) break;
        n += 1;
        const full = `${_b(p).toString("utf8")}/${name.toString("utf8")}`;
        const lstatFails = d.inject.lstatErrors && name.toString() !== "." && name.toString() !== ".." && d.inject.lstatErrors.test(full);
        if (lstatFails) {
          if (!v2) continue; // do_list v1: `continue` on lstat failure
          _write(socket, wire.encodeDent(true, { error: ERRNO.EACCES }, name));
          continue;
        }
        const size = node.type === "file" ? node.size : 4096;
        const o = { mode: node.mode, size, mtime: node.mtime, dev: 0xfd00, ino: node.ino, nlink: 1, uid: 1023, gid: 1023, atime: node.mtime, ctime: node.mtime };
        _write(socket, wire.encodeDent(v2, o, name));
      }
    }
    _write(socket, wire.encodeDentDone(v2));
    return true;
  }

  async _sendV1(socket, r, d, spec) {
    const comma = spec.lastIndexOf(0x2c);
    if (comma === -1) {
      this._syncFail(socket, "missing , in ID_SEND_V1");
      return false;
    }
    const p = Buffer.from(spec.subarray(0, comma));
    const mode = _strtoul0(spec.subarray(comma + 1).toString("latin1"));
    this.log[this.log.length - 1].sendPath = p.toString("utf8");
    this.log[this.log.length - 1].sendRawPath = p;

    const drop = _match(d.inject.dropPaths, "send", p);
    if (drop) {
      socket.destroy();
      return false;
    }
    if (_match(d.inject.stallPaths, "send", p)) await r.stall();

    // send_impl: unlink an existing regular file (or a missing path) first.
    const st = d.fs.stat(p);
    const doUnlink = !!st.error || (st.mode & wire.S_IFMT) === S_IFREG;
    if (doUnlink && !d.inject.readOnly && !(d.inject.unlinkFails && d.inject.unlinkFails.test(p.toString("utf8")))) {
      d.fs.unlink(p);
    }
    let m = mode & 0o777;
    m |= (m >> 3) & 0o070;
    m |= (m >> 3) & 0o007;
    return this._handleSendFile(socket, r, d, p, m, doUnlink);
  }

  _createErr(d, p, inj) {
    if (d.inject.readOnly) return ERRNO.EROFS;
    const lk = this._locked(d, p);
    if (lk) return lk === ERRNO.ENOENT ? ERRNO.EACCES : lk;
    if (inj && (inj.at || "open") === "open") return inj.errno || ERRNO.EACCES;
    return 0;
  }

  async _handleSendFile(socket, r, d, p, mode, doUnlink) {
    const fail = async (msg) => {
      this._syncFail(socket, msg);
      // Drain DATA until DONE (or EOF / garbage), then unlink the partial.
      for (;;) {
        const h = await r.read(8);
        if (!h) break;
        const id = h.toString("latin1", 0, 4);
        if (id === wire.ID.DONE) break;
        if (id !== wire.ID.DATA) break;
        const n = h.readUInt32LE(4);
        if (n > wire.SYNC_DATA_MAX) break;
        if (!(await r.read(n))) break;
      }
      if (doUnlink && !d.inject.readOnly) d.fs.unlink(p);
      this.log.push({ kind: "send-failed", serial: d.serial, path: p.toString("utf8"), message: msg });
      return false;
    };

    // One failPaths match per SEND, so an entry with `times` counts SENDs.
    const inj = _match(d.inject.failPaths, "send", p);
    const ce = this._createErr(d, p, inj);
    let fd = ce ? { error: ce } : d.fs.createExclusive(p, mode);
    if (fd.error === ERRNO.ENOENT) {
      const dir = p.subarray(0, Math.max(0, p.lastIndexOf(0x2f)));
      const me = d.fs.mkdirs(dir);
      if (me) return fail(`secure_mkdirs() failed: ${STRERROR[me]}`);
      fd = d.fs.createExclusive(p, mode);
    }
    if (fd.error === ERRNO.EEXIST) fd = d.fs.openExisting(p);
    if (fd.error) return fail(`couldn't create file: ${STRERROR[fd.error] || fd.error}`);
    const node = fd.node;
    node.mode = S_IFREG | mode;
    node.sha = null;

    const failAt = inj && inj.at === "data" ? inj : null;
    let pos = 0;
    let doneMtime = 0;
    for (;;) {
      const h = await r.read(8);
      if (!h) return fail("command read failure"); // client gone mid-stream
      const id = h.toString("latin1", 0, 4);
      const n = h.readUInt32LE(4);
      if (id === wire.ID.DONE) {
        doneMtime = n;
        break;
      }
      if (id !== wire.ID.DATA) return fail("invalid data message");
      const chunk = await r.read(n);
      if (!chunk) return fail("command read failure");
      d.dataBytes += n;
      if (failAt && failAt.at === "data") return fail(`write failed: ${STRERROR[failAt.errno || ERRNO.EIO]}`);
      const room = d.inject.capacityBytes - d.fs.used;
      const grow = Math.max(0, pos + n - node.size);
      if (grow > room) {
        const k = Math.max(0, Math.min(n, node.size - pos + room));
        if (k) d.fs.writeAt(node, pos, chunk.subarray(0, k));
        return fail(`write failed: ${STRERROR[ERRNO.ENOSPC]}`);
      }
      d.fs.writeAt(node, pos, chunk);
      pos += n;
      if (d.inject.unplugAfterBytes && d.dataBytes >= d.inject.unplugAfterBytes) {
        // The cable is gone: the host sees EOF, never a FAIL. adbd's own
        // read fails, so it unlinks the partial (handle_send_file `fail:`).
        if (doUnlink) d.fs.unlink(p);
        this.log.push({ kind: "unplugged-mid-send", serial: d.serial, path: p.toString("utf8"), bytes: pos });
        this.unplug(d.serial);
        if (!socket.destroyed) await new Promise((res) => socket.once("close", res));
        return false;
      }
    }
    _write(socket, wire.encodeSyncMsg(wire.ID.OKAY, 0));
    this.log.push({ kind: "sent", serial: d.serial, path: p.toString("utf8"), size: node.size });
    const mtime = d.inject.pushMtime === "now" ? this.now() : doneMtime;
    if (d.inject.lutimesDelayMs) {
      r.lutimes = sleep(d.inject.lutimesDelayMs).then(() => {
        node.mtime = mtime;
        r.lutimes = null;
      });
    } else node.mtime = mtime;
    return true;
  }

  _recv(socket, d, p) {
    const lk = this._locked(d, p);
    const f = _match(d.inject.failPaths, "recv", p);
    if (lk || f) {
      this._syncFail(socket, `open failed: ${STRERROR[lk || f.errno || ERRNO.EACCES]}`);
      return false;
    }
    const r = d.fs.lookup(p);
    if (r.error) {
      this._syncFail(socket, `open failed: ${STRERROR[r.error]}`);
      return false;
    }
    if (r.node.type === "dir") {
      // open(O_RDONLY) of a dir succeeds; read() then fails with EISDIR.
      this._syncFail(socket, `read failed: ${STRERROR[ERRNO.EISDIR]}`);
      return false;
    }
    if (r.node.hashOnly) {
      this._syncFail(socket, "read failed: fake: hash-only file has no contents");
      return false;
    }
    const data = d.fs.contents(r.node);
    for (let i = 0; i < data.length; i += wire.SYNC_DATA_MAX) {
      const c = data.subarray(i, i + wire.SYNC_DATA_MAX);
      _write(socket, Buffer.concat([wire.encodeDataHeader(c.length), c]));
    }
    _write(socket, wire.encodeSyncMsg(wire.ID.DONE, 0));
    return true;
  }

  // --- shell ----------------------------------------------------------------------

  async _shellV2(socket, r, d, cmd) {
    const entry = { kind: "shell", serial: d.serial, v2: true, cmd, closeStdin: false };
    this.log.push(entry);
    // Watch for CloseStdin while the command "runs" (stdin is otherwise ignored).
    const demux = new wire.ShellDemuxer();
    const feed = (c) => {
      for (const pkt of demux.push(c)) if (pkt.id === wire.SHELL_ID.CLOSE_STDIN) entry.closeStdin = true;
    };
    socket.removeAllListeners("data");
    socket.resume();
    socket.on("data", feed);
    if (r.q.length) feed(r.q.take(r.q.length));
    // adbd doesn't wait for stdin; the fake waits briefly only so the test
    // can observe whether CloseStdin was sent at all.
    for (let i = 0; i < 40 && !entry.closeStdin; i += 1) await sleep(5);
    if (d.inject.shellDelayMs) await sleep(d.inject.shellDelayMs);
    const res = runShell(d, cmd);
    if (res.stdout.length) _write(socket, wire.encodeShellPacket(wire.SHELL_ID.STDOUT, res.stdout));
    if (res.stderr.length) _write(socket, wire.encodeShellPacket(wire.SHELL_ID.STDERR, res.stderr));
    _write(socket, wire.encodeShellPacket(wire.SHELL_ID.EXIT, Buffer.from([res.code & 0xff])));
    socket.end();
  }

  async _shellLegacy(socket, d, cmd) {
    this.log.push({ kind: "shell", serial: d.serial, v2: false, cmd });
    if (d.inject.shellDelayMs) await sleep(d.inject.shellDelayMs);
    const res = runShell(d, cmd);
    let out = Buffer.concat([res.stdout, res.stderr]);
    if (d.inject.legacyCrlf) out = Buffer.from(out.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
    _write(socket, out);
    socket.end();
  }
}

// --- a small toybox-flavored shell ------------------------------------------------
//
// Enough for the transports' commands and the tests: quoting ('…', "…" with
// $? expansion, \-escapes), `;` `&&` `||`, and the commands below. No pipes
// or redirections: the engine never uses them (rc-checked, no 2>/dev/null).

function tokenize(src) {
  const toks = [];
  let i = 0;
  let cur = null;
  const push = () => {
    if (cur != null) toks.push({ w: cur });
    cur = null;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      push();
      i += 1;
    } else if (c === "\n" || c === ";") {
      push();
      toks.push({ op: c === ";" ? ";" : "nl" });
      i += 1;
    } else if (c === "&" && src[i + 1] === "&") {
      push();
      toks.push({ op: "&&" });
      i += 2;
    } else if (c === "|" && src[i + 1] === "|") {
      push();
      toks.push({ op: "||" });
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j === -1) throw new Error("unterminated '");
      cur = (cur || "") + src.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && '"\\$`'.includes(src[j + 1])) {
          s += src[j + 1];
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "?") {
          s += "\u0000RC\u0000";
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new Error('unterminated "');
      cur = (cur || "") + s;
      i = j + 1;
    } else if (c === "\\") {
      cur = (cur || "") + (src[i + 1] || "");
      i += 2;
    } else if (c === "|" || c === ">" || c === "<" || c === "`" || c === "&") {
      throw new Error(`fake shell: unsupported operator ${c}`);
    } else if (c === "$" && src[i + 1] === "?") {
      cur = (cur || "") + "\u0000RC\u0000";
      i += 2;
    } else {
      cur = (cur || "") + c;
      i += 1;
    }
  }
  push();
  return toks;
}

/**
 * The operator mksh would reject, or null. sh parses the whole -c string
 * before running any of it, so a syntax error runs nothing: `;;`, a leading
 * `;`, `&& ;`, a trailing `&&`/`||`. Empty lines and a trailing `;` are
 * fine, and so is a newline after `&&`/`||`.
 */
function _syntaxError(toks) {
  let words = false;
  let lastOp = null;
  for (const t of toks) {
    if (t.w != null) {
      words = true;
      continue;
    }
    if (t.op === "nl") {
      if (words) {
        words = false;
        lastOp = ";";
      }
      continue;
    }
    if (!words) return t.op;
    words = false;
    lastOp = t.op;
  }
  if (!words && (lastOp === "&&" || lastOp === "||")) return "end of file";
  return null;
}

function runShell(d, cmdline) {
  const out = [];
  const err = [];
  let rc = 0;
  let toks;
  try {
    toks = tokenize(cmdline);
  } catch (e) {
    return { stdout: Buffer.alloc(0), stderr: Buffer.from(`/system/bin/sh: syntax error: ${e.message}\n`), code: 2 };
  }
  const bad = _syntaxError(toks);
  if (bad) return { stdout: Buffer.alloc(0), stderr: Buffer.from(`/system/bin/sh: syntax error: '${bad}' unexpected\n`), code: 2 };
  let argv = [];
  let pendingOp = ";";
  const flush = () => {
    if (!argv.length) return false;
    const words = argv.map((w) => w.replace(/\u0000RC\u0000/g, String(rc)));
    argv = [];
    const run = pendingOp === ";" || (pendingOp === "&&" && rc === 0) || (pendingOp === "||" && rc !== 0);
    if (!run) return false;
    const r = runCommand(d, words);
    out.push(r.stdout);
    err.push(r.stderr);
    rc = r.code;
    return r.exit;
  };
  for (const t of toks) {
    if (t.w != null) argv.push(t.w);
    else if (t.op === "nl" && !argv.length) continue; // an empty line, or a newline after && / ||
    else {
      if (flush()) break;
      pendingOp = t.op === "nl" ? ";" : t.op;
    }
  }
  flush();
  return { stdout: Buffer.concat(out.map(_b)), stderr: Buffer.concat(err.map(_b)), code: rc };
}

function _fmtMtimeAt(sec) {
  return `${sec}.0000000000`;
}

function runCommand(d, words) {
  const [cmd, ...args] = words;
  const fs = d.fs;
  const tools = d.inject.tools;
  const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });
  const bad = (stderr, code = 1) => ({ stdout: "", stderr, code });
  const notFound = () => bad(`/system/bin/sh: ${cmd}: inaccessible or not found\n`, 127);
  const opts = (list) => {
    const flags = new Set();
    const rest = [];
    for (const a of list) {
      if (/^-[a-zA-Z]+$/.test(a) && !rest.length) for (const ch of a.slice(1)) flags.add(ch);
      else rest.push(a);
    }
    return { flags, rest };
  };
  switch (cmd) {
    case "true":
      return ok();
    case "false":
      return bad("", 1);
    case "exit":
      return { stdout: "", stderr: "", code: Number(args[0] || 0), exit: true };
    case "echo": {
      const n = args[0] === "-n";
      const words2 = n ? args.slice(1) : args;
      return ok(words2.join(" ") + (n ? "" : "\n"));
    }
    case "cat": {
      const parts = [];
      for (const a of args) {
        const b = fs.readFile(a);
        if (b == null) return { stdout: Buffer.concat(parts), stderr: `cat: ${a}: No such file or directory\n`, code: 1 };
        parts.push(b);
      }
      return { stdout: Buffer.concat(parts), stderr: "", code: 0 };
    }
    case "sha256sum": {
      if (!tools.sha256sum) return notFound();
      let s = "";
      let e = "";
      let code = 0;
      for (const a of args) {
        const r = fs.lookup(a);
        if (r.error || r.node.type !== "file") {
          e += `sha256sum: ${a}: ${r.error ? "No such file or directory" : "Is a directory"}\n`;
          code = 1;
          continue;
        }
        s += `${fs.sha(r.node)}  ${a}\n`;
      }
      return { stdout: s, stderr: e, code };
    }
    case "stat": {
      if (args[0] !== "-c") return bad("stat: fake supports only -c FMT\n", 1);
      const fmt = args[1];
      let s = "";
      let e = "";
      let code = 0;
      for (const a of args.slice(2)) {
        const st = fs.stat(a);
        if (st.error) {
          e += `stat: '${a}': ${STRERROR[st.error]}\n`;
          code = 1;
          continue;
        }
        const isDir = (st.mode & wire.S_IFMT) === S_IFDIR;
        s += `${fmt
          .replace(/%s/g, String(st.size))
          .replace(/%Y/g, String(st.mtime))
          .replace(/%n/g, a)
          .replace(/%F/g, isDir ? "directory" : "regular file")}\n`;
      }
      return { stdout: s, stderr: e, code };
    }
    case "find": {
      const root = args[0];
      let maxdepth = Infinity;
      let mindepth = 0;
      let type = null;
      let printf = null;
      for (let i = 1; i < args.length; i += 1) {
        if (args[i] === "-maxdepth") maxdepth = Number(args[++i]);
        else if (args[i] === "-mindepth") mindepth = Number(args[++i]);
        else if (args[i] === "-type") type = args[++i];
        else if (args[i] === "-printf") {
          if (!tools.findPrintf) return bad("find: Unknown option '-printf'\n", 1);
          printf = args[++i];
        } else return bad(`find: Unknown option '${args[i]}'\n`, 1);
      }
      const top = fs.lookup(root);
      if (top.error) return bad(`find: ${root}: No such file or directory\n`, 1);
      let s = "";
      const walk = (node, rel, depth) => {
        const full = rel ? `${root}/${rel}` : root;
        const t = node.type === "dir" ? "d" : "f";
        if (depth >= mindepth && (!type || type === t)) {
          if (printf == null) s += `${full}\n`;
          else {
            s += printf
              .replace(/%s/g, String(node.type === "file" ? node.size : 4096))
              .replace(/%T@/g, _fmtMtimeAt(node.mtime))
              .replace(/%P/g, rel)
              .replace(/%p/g, full)
              .replace(/%f/g, rel ? rel.split("/").pop() : root.split("/").pop())
              .replace(/%y/g, t)
              .replace(/\\n/g, "\n")
              .replace(/\\0/g, "\0");
          }
        }
        if (node.type === "dir" && depth < maxdepth) {
          for (const { name, node: ch } of node.children.values()) walk(ch, rel ? `${rel}/${name.toString("utf8")}` : name.toString("utf8"), depth + 1);
        }
      };
      walk(top.node, "", 0);
      return ok(s);
    }
    case "mv": {
      if (args.length !== 2) return bad("mv: fake supports exactly SRC DST\n", 1);
      const [a, b] = args;
      if (d.inject.readOnly) return bad(`mv: bad '${a}': Read-only file system\n`, 1);
      const src = fs.lookup(a);
      if (src.error) return bad(`mv: bad '${a}': No such file or directory\n`, 1);
      const dst = fs.lookup(b);
      // mv A B onto an existing directory B moves A INTO B (the reason
      // renames STA2 the destination first and require ENOENT).
      let target = b;
      if (!dst.error && dst.node.type === "dir" && dst.node !== src.node) target = `${b}/${src.name.toString("utf8")}`;
      const e = fs.rename(a, target);
      if (e) return bad(`mv: '${a}' to '${target}': ${STRERROR[e]}\n`, 1);
      return ok();
    }
    case "rm": {
      const { flags, rest } = opts(args);
      let code = 0;
      let e = "";
      for (const a of rest) {
        const r = fs.lookup(a);
        if (r.error) {
          if (!flags.has("f")) {
            e += `rm: ${a}: No such file or directory\n`;
            code = 1;
          }
          continue;
        }
        if (r.node.type === "dir") {
          if (!flags.has("r")) {
            e += `rm: ${a}: Is a directory\n`;
            code = 1;
            continue;
          }
          const rmTree = (p, node) => {
            for (const { name, node: ch } of [...node.children.values()]) {
              const cp = `${p}/${name.toString("utf8")}`;
              if (ch.type === "dir") rmTree(cp, ch);
              else fs.unlink(cp);
            }
            fs.rmdir(p);
          };
          rmTree(a, r.node);
          continue;
        }
        const ue = d.inject.readOnly ? ERRNO.EROFS : fs.unlink(a);
        if (ue) {
          e += `rm: ${a}: ${STRERROR[ue]}\n`;
          code = 1;
        }
      }
      return { stdout: "", stderr: e, code };
    }
    case "rmdir": {
      let code = 0;
      let e = "";
      for (const a of args) {
        const re = fs.rmdir(a);
        if (re) {
          e += `rmdir: '${a}': ${STRERROR[re]}\n`;
          code = 1;
        }
      }
      return { stdout: "", stderr: e, code };
    }
    case "mkdir": {
      const { flags, rest } = opts(args);
      let code = 0;
      let e = "";
      for (const a of rest) {
        if (d.inject.readOnly) {
          e += `mkdir: '${a}': Read-only file system\n`;
          code = 1;
          continue;
        }
        const ex = fs.lookup(a);
        if (!ex.error) {
          if (!flags.has("p")) {
            e += `mkdir: '${a}': File exists\n`;
            code = 1;
          }
          continue;
        }
        if (!flags.has("p") && ex.parent == null) {
          e += `mkdir: '${a}': No such file or directory\n`;
          code = 1;
          continue;
        }
        const me = fs.mkdirs(a);
        if (me) {
          e += `mkdir: '${a}': ${STRERROR[me]}\n`;
          code = 1;
        }
      }
      return { stdout: "", stderr: e, code };
    }
    case "test":
    case "[": {
      const a = cmd === "[" ? args.slice(0, -1) : args;
      if (a.length !== 2) return bad("", 2);
      const st = fs.stat(a[1]);
      const isDir = !st.error && (st.mode & wire.S_IFMT) === S_IFDIR;
      const isFile = !st.error && (st.mode & wire.S_IFMT) === S_IFREG;
      const truth = { "-e": !st.error, "-d": isDir, "-f": isFile, "-s": isFile && st.size > 0 }[a[0]];
      if (truth == null) return bad("", 2);
      return truth ? ok() : bad("", 1);
    }
    case "ls": {
      const { rest } = opts(args);
      const names = fs.names(rest[0] || "/");
      if (names == null) return bad(`ls: ${rest[0]}: No such file or directory\n`, 1);
      return ok(names.map((n) => `${n}\n`).join(""));
    }
    default:
      return notFound();
  }
}

module.exports = { FakeAdbServer, MemFs, DEFAULT_FEATURES, DEFAULT_INJECT, STRERROR, runShell, tokenize };
