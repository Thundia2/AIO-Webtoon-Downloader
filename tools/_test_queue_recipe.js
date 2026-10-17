// Offline regression test for UI-source/src/lib/queueRecipe.js (+ the pure
// builders it calls in lib/downloadForm.js and lib/downloadArgs.js).
// Run: node tools/_test_queue_recipe.js   (from the repo root)
//
// Two kinds of check:
//   1. PARITY with the pre-recipe code. The OLD builders are pulled out of
//      `git show <base>:…` (DownloadTab.handleStart + DEFAULT_FORM,
//      useDownloader.queueDownload's global injection, SearchTab's dialog +
//      confirm, App.jsx's defaults spread) and evaluated as-is, so "with the
//      same settings a recipe builds exactly the old args" is checked against
//      the real old code, not a transcription. Base defaults to the last
//      pre-recipe commit; QUEUE_RECIPE_BASE overrides it.
//   2. The new rule (2026-10-17): settings saved before an item starts reach
//      it, except fields the user explicitly changed in the New tab / Search
//      dialog.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const UI = path.join(ROOT, "UI-source");
const esbuild = require(path.join(UI, "node_modules", "esbuild"));
// f1f6d5a = the last commit before queue recipes (the recipe commit's parent).
const BASE = process.env.QUEUE_RECIPE_BASE || "f1f6d5a";

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
// Key order is irrelevant to the CLI (buildCliArgs walks fixed maps), so
// compare canonically.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
function eq(label, actual, expected) {
  const a = JSON.stringify(canon(actual));
  const e = JSON.stringify(canon(expected));
  check(label, a === e, a === e ? "" : `\n      got  ${a}\n      want ${e}`);
}
function throws(label, fn) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
}

// ── The OLD code, from git ───────────────────────────────────────────────
function gitShow(rel) {
  return execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: ROOT, encoding: "utf8" });
}
function slice(src, start, end, what) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`old ${what}: start marker not found`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`old ${what}: end marker not found`);
  return src.slice(i + start.length, j);
}

const oldDT = gitShow("UI-source/src/components/DownloadTab.jsx");
const OLD_DEFAULT_FORM = new Function(
  `return {${slice(oldDT, "const DEFAULT_FORM = {", "\n};", "DEFAULT_FORM")}};`
)();
const oldHandleStartBody = slice(oldDT, "const handleStart = () => {", "\n  };\n\n  return (", "handleStart");
// Old flow: form = {...DEFAULT_FORM, ...settings.defaults, ...draft}; handleStart
// emits args; useDownloader.queueDownload puts its globals UNDER them.
function oldNewTabArgs(settings, draft, urls) {
  const form = { ...OLD_DEFAULT_FORM, ...(settings.defaults || {}), ...(draft || {}), urls };
  const recompressAllowed = form.komikku || form.format === "cbz" || form.format === "epub";
  const modernizeAllowed = form.komikku || form.format === "cbz";
  let captured;
  new Function(
    "form", "settings", "recompressAllowed", "modernizeAllowed",
    "onStartDownload", "onDraftConsumed", "setFormState",
    oldHandleStartBody
  )(form, settings, recompressAllowed, modernizeAllowed, (_u, a) => { captured = a; }, () => {}, () => {});
  return oldGlobals(settings, captured);
}

const oldUD = gitShow("UI-source/src/hooks/useDownloader.js");
const oldGlobalsBody = slice(oldUD, "const finalArgs = {", "        ...args,\n      };", "queueDownload globals");
function oldGlobals(s, args) {
  return { ...new Function("s", `return {${oldGlobalsBody}};`)(s), ...args };
}

const oldST = gitShow("UI-source/src/components/SearchTab.jsx");
const oldInitialBody = slice(oldST, "const initial = useMemo(() => (", "), [pending?.args?.multiSource", "dialog initial");
const oldSubmitBody = slice(oldST, "const submit = (event) => {", "\n  };", "dialog submit");
const oldConfirmBody = slice(oldST, "const confirmSearchDownload = (overrides) => {", "\n  };", "confirmSearchDownload");
// Old flow: dialog form (initial + user changes) → submit args → confirm merge
// with the search's args → App's {...defaults, ...args[, ...findQueueArgs]} →
// queueDownload globals.
function oldSearchArgs(settings, searchArgs, formChanges, extra) {
  const pending = { args: searchArgs };
  const initial = new Function("settings", "pending", `return (${oldInitialBody});`)(settings, pending);
  const form = { ...initial, ...(formChanges || {}) };
  let overrides;
  new Function("event", "form", "onConfirm", oldSubmitBody)(undefined, form, (a) => { overrides = a; });
  let appArgs;
  new Function("downloadDialog", "overrides", "onStartDownload", "setDownloadDialog", oldConfirmBody)(
    { url: "u", args: searchArgs }, overrides, (_u, a) => { appArgs = a; }, () => {}
  );
  return oldGlobals(settings, { ...(settings.defaults || {}), ...appArgs, ...(extra || {}) });
}

// buildLibraryDownloadArgs itself is unchanged; take the old copy anyway.
const oldDA = gitShow("UI-source/src/lib/downloadArgs.js");
const oldBuildLibrary = new Function(
  `${oldDA.slice(oldDA.indexOf("export function buildLibraryDownloadArgs")).replace("export function", "function")}\nreturn buildLibraryDownloadArgs;`
)();
function oldLibraryArgs(settings, meta, chapters, folder) {
  const built = oldBuildLibrary(meta, settings.defaults, chapters, settings.verboseAlways, folder);
  return oldGlobals(settings, { ...(settings.defaults || {}), ...built });
}
function oldSyncArgs(settings, jobArgs) {
  return oldGlobals(settings, { ...(settings.defaults || {}), ...jobArgs });
}

// ── Fixtures ─────────────────────────────────────────────────────────────
const S1 = {
  verboseAlways: true,
  collapseSplits: false,
  imageConcurrency: 8,
  disabledSites: ["badsite"],
  searchOpts: { seededOnly: true, searchLanguage: "en" },
  defaults: {
    format: "pdf",
    quality: 100,
    multiSource: true,
    multiSourceLazy: true,
    modernize: true,
    modernizeEffort: 7,
    mtl: "avoid",
    keepChapters: true,
    webtoonRecompress: true,
    imageWorkers: 4,
  },
};
// "Settings saved while items wait": modernize stays on with effort 5, MTL
// exclude, CBZ (so modernize is allowed), image concurrency 4, quality 90.
const S2 = {
  ...S1,
  imageConcurrency: 4,
  defaults: {
    ...S1.defaults,
    format: "cbz",
    quality: 90,
    modernizeEffort: 5,
    mtl: "exclude",
    excludeGroup: "BadTL",
  },
};

(async () => {
  const out = path.join(os.tmpdir(), `aio-queuerecipe-${process.pid}.mjs`);
  const entry = path.join(os.tmpdir(), `aio-queuerecipe-entry-${process.pid}.js`);
  fs.writeFileSync(entry, [
    `export * from ${JSON.stringify(path.join(UI, "src", "lib", "queueRecipe.js"))};`,
    `export { applyEdits, formDefaults } from ${JSON.stringify(path.join(UI, "src", "lib", "downloadForm.js"))};`,
  ].join("\n"));
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: out,
    logLevel: "error",
  });
  const R = await import(pathToFileURL(out).href);
  fs.rmSync(out, { force: true });
  fs.rmSync(entry, { force: true });
  const fin = (recipe, s) => R.finalArgsFor(recipe, s);
  const newTab = (formEdits, urlCount = 1) => ({ kind: "newTab", input: { formEdits, urlCount } });
  const search = (searchArgs, dialogEdits = {}, extraArgs = {}) => ({ kind: "search", input: { searchArgs, dialogEdits, extraArgs } });

  console.log("── parity: same settings ⇒ the old args ──");
  for (const [name, s] of [["S1", S1], ["S2", S2]]) {
    eq(`newTab untouched (${name})`, fin(newTab({}), s), oldNewTabArgs(s, null, "https://x/1"));
    const edits = { chapters: "1-5", multiSourceLazy: false, imageWorkers: 6, format: "epub", epubLayout: "page" };
    eq(`newTab with edits (${name})`, fin(newTab(edits), s), oldNewTabArgs(s, edits, "https://x/1"));
    eq(`newTab 3 URLs → --jobs 3 (${name})`, fin(newTab({}, 3), s), oldNewTabArgs(s, null, "a\nb\nc"));
    const sa = { multiSource: true, prefetchedAlts: "[alts]", multiSourcePrefetched: true, site: "mangadex" };
    eq(`search untouched (${name})`, fin(search(sa), s), oldSearchArgs(s, sa, {}));
    eq(`search with dialog edits (${name})`, fin(search(sa, { format: "epub", chapters: "3-4", group: "G" }), s),
      oldSearchArgs(s, sa, { format: "epub", chapters: "3-4", group: "G" }));
    eq(`search multi-source unticked drops prefetched alts (${name})`, fin(search(sa, { multiSource: false }), s),
      oldSearchArgs(s, sa, { multiSource: false }));
    eq(`search from Sync's find (komikku extra) (${name})`, fin(search(sa, {}, { komikku: true }), s),
      oldSearchArgs(s, sa, {}, { komikku: true }));
    const meta = { format: "epub", language: "es", site: "mangadex", url: "https://md/1", title: "T" };
    eq(`library (${name})`, fin(R.libraryRecipe(meta, "10-12", "D:/manga/T"), s),
      oldLibraryArgs(s, meta, "10-12", "D:/manga/T"));
    const job = { multiSource: true, prefetchedAlts: "[a]", komikku: true };
    eq(`sync defaultsPlus (${name})`, fin({ kind: "defaultsPlus", input: { jobArgs: job } }, s), oldSyncArgs(s, job));
  }

  console.log("── a save before the start reaches waiting items ──");
  const untouched = fin(newTab({}), S2);
  eq("newTab untouched picks up S2", {
    format: untouched.format, quality: untouched.quality, modernize: untouched.modernize,
    modernizeEffort: untouched.modernizeEffort, mtl: untouched.mtl, imageConcurrency: untouched.imageConcurrency,
  }, { format: "cbz", quality: 90, modernize: true, modernizeEffort: 5, mtl: "exclude", imageConcurrency: 4 });
  const lib = fin(R.libraryRecipe({ format: "cbz", language: "en" }, "5", null), S2);
  eq("library picks up S2 (effort, MTL, concurrency, quality)",
    [lib.modernizeEffort, lib.mtl, lib.imageConcurrency, lib.quality], [5, "exclude", 4, 90]);
  eq("library keeps the series' own format over Settings",
    fin(R.libraryRecipe({ format: "epub" }, "5", null), S2).format, "epub");
  const sy = fin({ kind: "defaultsPlus", input: { jobArgs: { multiSource: true } } }, S2);
  eq("sync picks up S2", [sy.modernizeEffort, sy.format, sy.mtl], [5, "cbz", "exclude"]);

  console.log("── explicit New-tab / dialog changes are kept ──");
  const lazyOff = fin(newTab({ multiSourceLazy: false }), S2);
  eq("edited multiSourceLazy:false survives S2, the rest follows S2",
    [lazyOff.multiSourceLazy, lazyOff.modernizeEffort, lazyOff.format], [false, 5, "cbz"]);
  eq("explicit MTL avoid beats Settings exclude", fin(newTab({ mtl: "avoid" }), S2).mtl, "avoid");
  eq("explicit empty exclude-groups beats Settings", fin(newTab({ excludeGroup: "" }), S2).excludeGroup, "");
  eq("unedited MTL follows Settings exclude", fin(newTab({}), S2).mtl, "exclude");
  const sd = fin(search({ multiSource: false }, { format: "epub" }), S2);
  eq("search dialog's edited format survives S2, quality follows", [sd.format, sd.quality], ["epub", 90]);
  eq("search multi-source is the search's own flag, not Settings",
    fin(search({ multiSource: false }), S2).multiSource, false);

  console.log("── what counts as an edit ──");
  const b1 = R.formDefaults(S1);
  const e1 = R.applyEdits({}, { multiSourceLazy: false }, b1);
  eq("changing a field records it", e1, { multiSourceLazy: false });
  eq("toggling it back unpins it", R.applyEdits(e1, { multiSourceLazy: true }, b1), {});
  eq("setting a field to its current default is not an edit", R.applyEdits({}, { format: "pdf" }, b1), {});
  // PDF→CBZ: with Settings format cbz + modernize on, the New tab's format
  // buttons used to write modernize:false on PDF and never restore it.
  const sCbz = { ...S2 };
  const bc = R.formDefaults(sCbz);
  const viaPdf = R.applyEdits(R.applyEdits({}, { format: "pdf" }, bc), { format: "cbz" }, bc);
  eq("PDF then CBZ leaves no edits", viaPdf, {});
  eq("…so modernize comes from Settings again", fin(newTab(viaPdf), sCbz).modernize, true);
  eq("while on PDF, modernize is gated off (not pinned)",
    [fin(newTab({ format: "pdf" }), sCbz).modernize, "modernize" in R.applyEdits({}, { format: "pdf" }, bc)],
    [undefined, false]);
  eq("None → keep images: the side-effect pins only if it differs",
    R.applyEdits({}, { format: "none", keepImages: true }, bc), { format: "none", keepImages: true });

  console.log("── malformed recipes throw (the hook drops them) ──");
  throws("null recipe", () => R.finalArgsFor(null, S1));
  throws("unknown kind", () => R.finalArgsFor({ kind: "nope", input: {} }, S1));
  throws("non-object input", () => R.finalArgsFor({ kind: "newTab", input: "x" }, S1));
  throws("non-object dialogEdits", () => R.finalArgsFor(search({}, "bad"), S1));
  throws("array jobArgs", () => R.finalArgsFor({ kind: "defaultsPlus", input: { jobArgs: [] } }, S1));

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
