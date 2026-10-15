// Benchmark for deviceSync's record writes (non-UI plan P5; deviation 1):
// what one shard write costs on this PC's disk, which decides whether
// batched intent (executor.js intentBatch > 1) is worth switching on.
// With intentBatch = 1 every pushed file costs two shard writes (the
// pending intent before the send, the pushed entry after it).
//
//   node tools/_bench_device_sync_fsync.js [--dir <dir>] [--reps N]
//
// --dir defaults to a temp dir under os.tmpdir(), which on Windows is on the
// same volume as %APPDATA% (where userData/sync lives). The dir is created
// and removed by the script.
//
// Times store.js's real writeJsonAtomic (tmp + fsync + rename) on shard
// bodies built by store.js's shardBody, at three folder sizes, and the same
// write without the fsync, so the fsync's own share is visible. Each size
// rewrites ONE shard path repeatedly, as a run does.
//
// tools/ is gitignored; force-added on wip/device-sync-handoff only.

const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require(path.join(__dirname, "..", "UI-source", "electron", "sync", "store.js"));

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const REPS = Number(opt("--reps", 300));
const BASE = opt("--dir", null);

const NO_FSYNC_OPS = Object.freeze({
  ...store.REAL_OPS,
  async writeTmp(tmp, data) {
    const fh = await fs.promises.open(tmp, "wx");
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
  },
});

function shardOf(nFiles) {
  const files = new Map();
  for (let i = 1; i <= nFiles; i += 1) {
    const name = `Ch.${String(i).padStart(4, "0")} - Some Chapter Title.cbz`;
    files.set(name.toLowerCase(), { name, size: 20_000_000 + i, sha256: "ab".repeat(32), devMtime: 1760000000000 + i, origin: "pushed" });
  }
  return store.shardBody({ shardId: "0123456789abcdef", name: "A Series Name (2024)", identityKey: "anilist:12345", urlKey: "mangafire.to/manga/x", pcFolder: "A Series Name", files }, "e".repeat(32));
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function timeWrites(file, body, ops) {
  const ms = [];
  for (let i = 0; i < REPS; i += 1) {
    body.verifiedAt = i; // a real rewrite changes content
    const t = process.hrtime.bigint();
    await store.writeJsonAtomic(file, body, ops);
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const mean = ms.reduce((s, v) => s + v, 0) / ms.length;
  return { p50: pct(ms, 50), p95: pct(ms, 95), max: ms[ms.length - 1], mean };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(BASE || os.tmpdir(), "aio-fsync-bench-"));
  const f = (n) => n.toFixed(2).padStart(7);
  console.log(`dir: ${dir}  reps: ${REPS}  node ${process.versions.node}${process.versions.electron ? ` electron ${process.versions.electron}` : ""}`);
  console.log("files  bytes    | with fsync: p50     p95     max    mean | no fsync: p50     p95    mean");
  try {
    for (const n of [20, 200, 1000]) {
      const body = shardOf(n);
      const bytes = Buffer.byteLength(JSON.stringify(body));
      const file = path.join(dir, `shard-${n}.json`);
      await timeWrites(file, body, store.REAL_OPS); // warm-up (Defender's first look)
      const a = await timeWrites(file, body, store.REAL_OPS);
      const b = await timeWrites(file, body, NO_FSYNC_OPS);
      console.log(`${String(n).padStart(5)}  ${String(bytes).padStart(7)}  |       ${f(a.p50)} ${f(a.p95)} ${f(a.max)} ${f(a.mean)} |      ${f(b.p50)} ${f(b.p95)} ${f(b.mean)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e && e.stack);
  process.exit(1);
});
