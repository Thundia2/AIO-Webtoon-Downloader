// Drift guard for the Device Sync IPC literals that can't import contract.js.
// Run: node tools/_test_device_sync_contract.js   (from the repo root or tools/)
//
// electron/preload.js runs sandboxed (no require) and src/hooks/useDeviceSync.js
// is bundled by Vite, so both spell the names out again. This pins:
//   - preload's "sync:*" invoke literals == contract.CHANNELS, one wrapper each
//   - preload subscribes to contract.EVENT_CHANNEL
//   - the hook's EVENT_KINDS == contract.EVENT_KINDS (same order)
//   - every preload wrapper the hook's ACTIONS table names exists, and every
//     channel but get-state (the hook's refresh) has an action

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const contract = require(path.join(ROOT, "UI-source", "electron", "sync", "contract.js"));
const PRELOAD = fs.readFileSync(path.join(ROOT, "UI-source", "electron", "preload.js"), "utf8");
const HOOK = fs.readFileSync(path.join(ROOT, "UI-source", "src", "hooks", "useDeviceSync.js"), "utf8");

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

// preload: `name: (p) => ipcRenderer.invoke("sync:…", p),`
const wrapperRe = /^\s*(sync\w+):\s*\(p\)\s*=>\s*ipcRenderer\.invoke\("(sync:[^"]+)",\s*p\),?\s*$/gm;
const wrappers = new Map();
for (const m of PRELOAD.matchAll(wrapperRe)) wrappers.set(m[1], m[2]);
const allSyncLiterals = [...PRELOAD.matchAll(/"(sync:[^"]+)"/g)].map((m) => m[1]);

const want = Object.values(contract.CHANNELS).slice().sort();
eq("preload wrappers cover exactly contract.CHANNELS", [...wrappers.values()].sort(), want);
eq("no other sync:* literal in preload", allSyncLiterals.slice().sort(), want);
eq("one wrapper per channel", wrappers.size, contract.CHANNEL_NAMES.length);
check("23 channels, link included", contract.CHANNEL_NAMES.length === 23 && contract.CHANNEL_NAMES.includes("link"));

// Wrapper naming: sync + PascalCase of the channel name, ':' and '-' as word breaks.
const pascal = (n) => n.split(/[:-]/).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
for (const [fn, ch] of wrappers) eq(`wrapper name for ${ch}`, fn, `sync${pascal(ch.slice(5))}`);

check(
  "preload subscribes to the event channel",
  new RegExp(`ipcRenderer\\.on\\("${contract.EVENT_CHANNEL}"`).test(PRELOAD) &&
    new RegExp(`removeListener\\("${contract.EVENT_CHANNEL}"`).test(PRELOAD),
);
check("preload exposes onSyncEvent", /^\s*onSyncEvent:\s*\(callback\)\s*=>/m.test(PRELOAD));

// hook EVENT_KINDS
const kindsMatch = HOOK.match(/^const EVENT_KINDS = (\[[^\]]*\]);$/m);
check("hook declares EVENT_KINDS on one line", !!kindsMatch);
if (kindsMatch) eq("hook EVENT_KINDS == contract.EVENT_KINDS", JSON.parse(kindsMatch[1]), [...contract.EVENT_KINDS]);

// hook ACTIONS → preload wrappers
const actionsBlock = HOOK.match(/^const ACTIONS = \{([\s\S]*?)^\};$/m);
check("hook declares ACTIONS", !!actionsBlock);
if (actionsBlock) {
  const used = [...actionsBlock[1].matchAll(/:\s*"(sync\w+)"/g)].map((m) => m[1]);
  for (const fn of used) check(`hook action wrapper ${fn} exists in preload`, wrappers.has(fn));
  const expected = [...wrappers.keys()].filter((fn) => fn !== "syncGetState").sort();
  eq("hook has an action per channel except get-state", used.slice().sort(), expected);
}
check("hook reads get-state through syncGetState", /\.syncGetState\(\)/.test(HOOK));
check("hook subscribes through onSyncEvent", /\.onSyncEvent\(/.test(HOOK));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall contract checks passed");
