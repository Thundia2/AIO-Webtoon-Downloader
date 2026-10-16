// Drift guard for the Device Sync settings twin.
// Run: node tools/_test_device_sync_settings_twin.js   (from anywhere)
//
// UI-source/src/lib/syncSettings.js (renderer, ES module) mirrors
// UI-source/electron/sync/sync-settings.js SYNC_SETTING_SPECS (source of
// truth). This pins:
//   - the renderer's keys, defaults and preset lists == the specs
//   - main.js get-settings spreads syncSettingsForRenderer's keys
//   - syncSettingsForRenderer returns exactly the eight keys, resolved
//     (no parsed chapterPatterns — RegExps don't cross IPC)
//   - SettingsTab's DEFAULT_SETTINGS spreads SYNC_DEFAULTS

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UI = path.join(ROOT, "UI-source");
const specsMod = require(path.join(UI, "electron", "sync", "sync-settings.js"));

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

(async () => {
  // The renderer file is import-free, so a data: URL loads it as-is.
  const src = fs.readFileSync(path.join(UI, "src", "lib", "syncSettings.js"), "utf8");
  const r = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const specs = specsMod.SYNC_SETTING_SPECS;

  eq("keys (same order)", r.SYNC_SETTING_KEYS, Object.keys(specs));
  eq("defaults", r.SYNC_DEFAULTS, Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, s.default])));
  eq(
    "preset lists (every enum key, same order)",
    r.SYNC_PRESETS,
    Object.fromEntries(Object.entries(specs).filter(([, s]) => s.type === "enum").map(([k, s]) => [k, s.presets]))
  );

  const out = specsMod.syncSettingsForRenderer({ syncEnabled: true, syncErrorBudget: 99, unrelated: 1 });
  eq("syncSettingsForRenderer: exactly the eight keys", Object.keys(out), Object.keys(specs));
  eq("syncSettingsForRenderer: resolves (bad preset → default)", [out.syncEnabled, out.syncErrorBudget], [true, 3]);
  eq("syncSettingsForRenderer(undefined) = defaults", specsMod.syncSettingsForRenderer(undefined), r.SYNC_DEFAULTS);

  const main = fs.readFileSync(path.join(UI, "electron", "main.js"), "utf8");
  const gs = main.slice(main.indexOf('ipcMain.handle("get-settings"'));
  check("main get-settings calls syncSettingsForRenderer", /syncSettingsForRenderer\(saved\)/.test(gs.slice(0, 1500)));
  check("main get-settings spreads the sync keys after ...saved", /\.\.\.saved,[\s\S]*?\.\.\.syncKeys,/.test(gs.slice(0, 1500)));

  const tab = fs.readFileSync(path.join(UI, "src", "components", "SettingsTab.jsx"), "utf8");
  check("SettingsTab imports the mirror", /from\s+"@\/lib\/syncSettings"/.test(tab));
  const ds = tab.slice(tab.indexOf("const DEFAULT_SETTINGS = {"));
  check("DEFAULT_SETTINGS spreads SYNC_DEFAULTS", /\.\.\.SYNC_DEFAULTS,/.test(ds.slice(0, ds.indexOf("\n};"))));

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
