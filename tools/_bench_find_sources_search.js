// Search timing for Device Sync's find-sources (non-UI plan P5): runs real
// cross-site searches through the exact find-sources path (sync/
// find-sources.js FindSources + electron/searcher.js Searcher, the same
// query derivation and search options) and prints each query's phase split
// from the search CLI's own "[*] Search phases:" line. The plan proposes
// AIO_SEARCH_PROBE_DEADLINE only if the probe phase dominates.
//
//   node tools/_bench_find_sources_search.js ["<folder>" …] [--python <exe>]
//
// Folder names stand in for device-only folders (the tablet's names would be
// the real input); the defaults are five library-style names covering a hid
// suffix, a subtitle, long romaji, a long English title and a one-word title.
// Network: real searches against the supported sites, as the app makes.
// Writes only a temp targets dir (find-sources.json); the search's own caches
// go where the app's searches put them.
//
// tools/ is gitignored; force-added on wip/device-sync-handoff only.

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const { FindSources } = require(path.join(REPO, "UI-source", "electron", "sync", "find-sources.js"));
const { Searcher } = require(path.join(REPO, "UI-source", "electron", "searcher.js"));

const argv = process.argv.slice(2);
const pyAt = argv.indexOf("--python");
const PY = pyAt >= 0 ? argv[pyAt + 1] : "python";
const given = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--python");
const FOLDERS = given.length
  ? given
  : ["Bungo Stray Dogs (hid=PW1SJ)", "Frieren - Beyond Journey's End", "Dungeon ni Deai o Motomeru no wa Machigatte Iru Darou ka", "A Story About Smoking at the Back of the Supermarket", "Eleceed"];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-fs-bench-"));
  const rows = new Map(); // folder → {query, t0, ms, phases, status, candidates}
  let current = null;
  const fsrc = new FindSources({
    targetsDir: dir,
    getSettings: () => ({}),
    spawnPaths: () => ({ pythonCmd: PY, scriptPath: path.join(REPO, "aio-dl.py"), workingDir: REPO }),
    makeSearcher: () =>
      new Searcher({
        extraEnv: {},
        onLog: (_id, line) => {
          const m = /\[\*\] Search phases: fan-out ([\d.]+)s · probe ([\d.]+)s · T3 ([\d.]+)s · total ([\d.]+)s/.exec(line);
          if (m && current) current.phases = { fanout: +m[1], probe: +m[2], t3: +m[3], total: +m[4] };
          if (current && /slowest:/.test(line)) (current.slowest = current.slowest || []).push(line.replace(/^\s*\[\*\]\s*/, "").slice(0, 200));
        },
      }),
    emit: (ev) => {
      if (!ev.row) return;
      const r = rows.get(ev.row.folder) || { query: ev.row.query };
      rows.set(ev.row.folder, r);
      if (ev.row.state === "searching") {
        r.t0 = Date.now();
        current = r;
      } else if (ev.row.state === "done" || ev.row.state === "error") {
        r.ms = Date.now() - r.t0;
        r.status = ev.row.state;
        r.error = ev.row.error;
        r.candidates = (ev.row.candidates || []).length;
        console.log(`  ${ev.row.folder}  →  "${r.query}": ${r.status} in ${(r.ms / 1000).toFixed(1)} s ${JSON.stringify(r.phases || null)} (${r.candidates} candidates)`);
        current = null;
      }
    },
  });
  const t0 = Date.now();
  const st = await fsrc.start({ targetId: "bench", folders: FOLDERS });
  if (!st.ok || !st.started) throw new Error(JSON.stringify(st));
  while (fsrc.isRunning()) await new Promise((r) => setTimeout(r, 500));
  const all = [...rows.values()].filter((r) => r.phases);
  const sum = (k) => all.reduce((s, r) => s + r.phases[k], 0);
  const total = sum("total");
  console.log(`\n${rows.size} queries, wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (total) console.log(`phase share of search time: fan-out ${((100 * sum("fanout")) / total).toFixed(0)}% · probe ${((100 * sum("probe")) / total).toFixed(0)}% · T3 ${((100 * sum("t3")) / total).toFixed(0)}% (rest: setup, winner fetch)`);
  for (const [f, r] of rows) if (r.slowest) console.log(`  ${f}: ${r.slowest.join(" | ")}`);
  console.log(JSON.stringify([...rows.entries()].map(([folder, r]) => ({ folder, ...r }))));
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => {
  console.error(e && e.stack);
  process.exit(1);
});
