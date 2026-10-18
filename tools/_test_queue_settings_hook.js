// Offline regression test: queued downloads build their args when they START.
// Run: node tools/_test_queue_settings_hook.js   (from the repo root)
//
// Drives the REAL UI-source/src/hooks/useDownloader.js (esbuild-bundled with
// `@` aliased to src and "react" swapped for tools/_hook_runtime.js) against a
// stubbed window.electronAPI that records every startDownload.
//
// What it pins (user rule 2026-10-17 + the adversarial review of the plan):
//   - items waiting behind a running download start with Settings saved
//     after they were queued; a New-tab edit survives that save
//   - the queue persisted to disk holds recipes, not resolved args
//   - the Queue tab's badges (the returned queue's display `args`) follow a save
//   - a restored queue does NOT start before the saved settings have loaded
//   - an unreadable recipe at the head is dropped and the next item starts
//   - a legacy item (frozen args, from before recipes) spawns those args as-is

const { makeRuntime, bundleHook } = require("./_hook_runtime");

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

// ── Fixtures ─────────────────────────────────────────────────────────────
const S1 = {
  pythonCmd: "python", scriptPath: "", workingDir: "", verboseAlways: true,
  imageConcurrency: 8,
  defaults: { format: "pdf", quality: 100, modernize: true, modernizeEffort: 7, multiSource: true, mtl: "avoid" },
};
const S2 = {
  ...S1,
  imageConcurrency: 4,
  defaults: { ...S1.defaults, format: "cbz", modernizeEffort: 5, mtl: "exclude" },
};

function makeApi({ settings = S1, settingsGate = null, snapshot = null } = {}) {
  const listeners = { complete: [] };
  const calls = { start: [], saved: [] };
  let n = 0;
  const noop = () => () => {};
  const api = {
    getSettings: () => (settingsGate ? settingsGate.then(() => settings) : Promise.resolve(settings)),
    saveSettings: () => Promise.resolve({ ok: true }),
    scanResumable: () => Promise.resolve([]),
    getQueueSnapshot: () => Promise.resolve(snapshot),
    saveQueueSnapshot: (snap) => { calls.saved.push(JSON.parse(JSON.stringify(snap))); return Promise.resolve(); },
    startDownload: ({ url, args }) => { calls.start.push({ url, args }); return Promise.resolve({ downloadId: `d${++n}` }); },
    resumeDownload: () => Promise.resolve({ downloadId: `r${++n}` }),
    scanLibrary: () => Promise.resolve([]),
    onDownloadLog: noop, onDownloadProgress: noop, onSearchLog: noop, onThumbnailReady: noop,
    onDownloadComplete: (cb) => { listeners.complete.push(cb); return () => {}; },
    onUpdateCheckProgress: noop,
    getUpdateCheckState: () => Promise.resolve(null),
  };
  const complete = (downloadId) => listeners.complete.forEach((cb) => cb({ downloadId, result: { status: "completed" } }));
  return { api, calls, complete };
}

(async () => {
  const { useDownloader } = await bundleHook("hooks/useDownloader.js");

  const rt = makeRuntime();
  globalThis.__hookRuntime = rt.api;
  const errors = [];
  const realError = console.error;
  console.error = (...a) => { if (String(a[0]).startsWith("FAIL")) realError(...a); else errors.push(a.map(String).join(" ")); };

  console.log("── waiting items start with Settings saved after they were queued ──");
  {
    const { api, calls, complete } = makeApi();
    globalThis.window = { electronAPI: api };
    const h = rt.mount(() => useDownloader());
    await h.wait(50);
    const dl = () => h.state;
    await dl().queueDownload("u1", { recipe: { kind: "newTab", input: { formEdits: {}, urlCount: 1 } } });
    await h.wait(20);
    await dl().queueDownload("u2", { recipe: { kind: "search", input: { searchArgs: { multiSource: false }, dialogEdits: {}, extraArgs: {} } } });
    await dl().queueDownload("u3", { recipe: { kind: "newTab", input: { formEdits: { multiSourceLazy: false }, urlCount: 1 } } });
    await h.wait(400); // past the persist debounce
    // S1 is PDF, so modernize (CBZ-only) is gated off for this one.
    eq("first item started at once with the settings of that moment",
      [calls.start.length, calls.start[0].args.format, "modernize" in calls.start[0].args], [1, "pdf", false]);
    eq("two items wait", dl().queue.map((q) => q.url), ["u2", "u3"]);
    const lastSave = calls.saved[calls.saved.length - 1];
    eq("persisted queue holds recipes, no resolved args",
      lastSave.queue.map((q) => [!!q.recipe, "args" in q]), [[true, false], [true, false]]);
    eq("badges before the save", dl().queue.map((q) => q.args.format), ["pdf", "pdf"]);

    await dl().saveSettings(S2);
    await h.wait(20);
    eq("badges follow the save", dl().queue.map((q) => q.args.format), ["cbz", "cbz"]);

    complete("d1");
    await h.wait(700);
    eq("second item started with the saved settings",
      [calls.start[1].url, calls.start[1].args.modernizeEffort, calls.start[1].args.format, calls.start[1].args.mtl, calls.start[1].args.imageConcurrency],
      ["u2", 5, "cbz", "exclude", 4]);
    complete("d2");
    await h.wait(700);
    eq("third item: new settings, and its New-tab edit kept",
      [calls.start[2].url, calls.start[2].args.modernizeEffort, calls.start[2].args.multiSourceLazy],
      ["u3", 5, false]);
    eq("the running entry carries the resolved args", dl().activeDownloads.d3.args.modernizeEffort, 5);
  }

  console.log("── a restored queue waits for the saved settings ──");
  {
    let open;
    const gate = new Promise((r) => { open = r; });
    const snapshot = {
      queue: [{ id: "q7", type: "download", url: "r1", displayUrl: "r1", queuedAt: 1,
        recipe: { kind: "newTab", input: { formEdits: {}, urlCount: 1 } } }],
      running: [],
    };
    const { api, calls } = makeApi({ settings: S2, settingsGate: gate, snapshot });
    globalThis.window = { electronAPI: api };
    const h = rt.mount(() => useDownloader());
    await h.wait(500); // past the 300ms restore auto-start
    eq("nothing spawned while settings are still loading", calls.start.length, 0);
    open();
    await h.wait(100);
    eq("spawned once settings loaded, with those settings",
      calls.start.map((c) => [c.url, c.args.format, c.args.modernizeEffort]), [["r1", "cbz", 5]]);
  }

  console.log("── an unreadable recipe is dropped, the next item starts ──");
  {
    const snapshot = {
      queue: [
        { id: "q1", type: "download", url: "bad", displayUrl: "bad", queuedAt: 1, recipe: { kind: "nonsense", input: {} } },
        { id: "q2", type: "download", url: "good", displayUrl: "good", queuedAt: 2,
          recipe: { kind: "defaultsPlus", input: { jobArgs: { multiSource: true } } } },
      ],
      running: [],
    };
    const { api, calls } = makeApi({ snapshot });
    globalThis.window = { electronAPI: api };
    errors.length = 0;
    const h = rt.mount(() => useDownloader());
    await h.wait(1200);
    eq("only the good item spawned", calls.start.map((c) => c.url), ["good"]);
    eq("the bad one is gone from the queue", h.state.queue.map((q) => q.url), []);
    check("the drop was logged", errors.some((e) => e.includes("can't be read")));
  }

  console.log("── a legacy item (frozen args) spawns them as-is ──");
  {
    const frozen = { format: "epub", quality: 80, verbose: true, collapseSplits: false };
    const snapshot = {
      queue: [{ id: "q1", type: "download", url: "old", displayUrl: "old", queuedAt: 1, args: frozen }],
      running: [],
    };
    const { api, calls } = makeApi({ settings: S2, snapshot });
    globalThis.window = { electronAPI: api };
    const h = rt.mount(() => useDownloader());
    await h.wait(500);
    eq("stored args used verbatim", calls.start.map((c) => c.args), [frozen]);
  }

  console.error = realError;
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
