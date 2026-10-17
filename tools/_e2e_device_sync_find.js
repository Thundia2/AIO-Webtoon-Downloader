// E2E for find-sources and the Library sync chip (UI pass U4) on the real dev
// app with a FOLDER target that holds folders the PC library doesn't have.
// Run: node tools/_e2e_device_sync_find.js [--app <UI-source dir>] [--exe <packaged exe>]
//   Same prerequisites as tools/_e2e_device_sync_tab.js (UI-source/dist from
//   `npm run build`, Playwright via PLAYWRIGHT_PATH). Needs a `python` on
//   PATH (or PYTHON=<exe>) to run the fake backend below.
//
// FAKE BACKEND. Search and download both spawn `<pythonCmd> -u <scriptPath>
// …` (searcher.js / downloader.js), so the run points scriptPath at a tiny
// python script written into the temp dir. It logs every argv to a file,
// answers `--search <q>` from FAKE_SEARCH in the --search-json shape, and for
// a download writes the series into AIO_OUTPUT_DIR (old mtimes, past the 30 s
// settle age) the way aio-dl.py would — under a folder name that DIFFERS from
// the device folder, so the device folder can only bind through the alias the
// UI records before queueing. Nothing touches the network.
//
// Flows, in order (each depends on the one before):
//   1. batch: Only on <target> → Find sources… → skip one → Search → pin a
//      URL on the row that found nothing → Queue 2: both aliases recorded
//      (two back-to-back config ops), both downloads spawned with --komikku
//      (the target's reader is Komikku), both device folders bind after
//   2. single: a row's Find source → Search tab with the banner, the search
//      already run → Download → Queue: alias recorded, banner gone, Queue tab
//   3. Library: the chip on a series with chapters to copy, the detail's
//      sync line, Open in Sync opens that series on the Sync tab
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const REPO = path.resolve(__dirname, "..");
const APP = path.resolve(opt("--app") || path.join(REPO, "UI-source"));
const EXE = opt("--exe") ? path.resolve(opt("--exe")) : null;
const WIN = process.platform === "win32";
const ELECTRON = path.join(APP, "node_modules", "electron", "dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : WIN ? "electron.exe" : "electron");
const PYTHON = process.env.PYTHON || "python";
const { _electron } = require(process.env.PLAYWRIGHT_PATH || "playwright");

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const OLD = new Date(Date.now() - 3600_000);

function chapter(dir, name, size) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(size, name));
  fs.utimesSync(p, OLD, OLD);
}
function series(lib, folder, chapters) {
  const dir = path.join(lib, folder);
  fs.mkdirSync(dir, { recursive: true });
  const meta = path.join(dir, ".aio_series.json");
  fs.writeFileSync(meta, JSON.stringify({ url: `https://mangafire.to/manga/${folder.toLowerCase()}.e2e`, title: folder }));
  fs.utimesSync(meta, OLD, OLD);
  for (const c of chapters) chapter(dir, c, 4000 + c.length);
}

const CSM_URL = "https://mangadex.org/title/e2e-csm/chainsaw-man";
const DAN_URL = "https://mangafire.to/title/e2e-dan-dandadan";
// Pinned by hand on the row whose search found nothing.
const KAG_URL = "https://weebcentral.com/series/e2e-kag/kagurabachi";
// --search-json answers by query. Device folder names are their own queries
// (naming.deriveSearchQuery leaves plain titles alone).
const FAKE_SEARCH = {
  "Chainsaw Man": {
    candidates: [
      { canonical_title: "Chainsaw Man", canonical_year: 2018, sources: [{ site: "mangadex", url: CSM_URL, title: "Chainsaw Man", composite_score: 0.91, actual_chapter_count: 2, quality_basis: "chapter_probe" }] },
    ],
  },
  Kagurabachi: { candidates: [] },
  Dandadan: {
    candidates: [
      { canonical_title: "Dandadan", canonical_year: 2021, sources: [{ site: "mangafire", url: DAN_URL, title: "Dandadan", composite_score: 0.8, actual_chapter_count: 1, quality_basis: "chapter_probe" }] },
    ],
  },
};
// What a download of each url leaves in the library. The folder names differ
// from the device folders on purpose (see FAKE BACKEND above).
const FAKE_DOWNLOADS = {
  [CSM_URL]: { folder: "Chainsaw Man (PC)", title: "Chainsaw Man", chapters: ["Ch.001.cbz", "Ch.002.cbz"] },
  [DAN_URL]: { folder: "Dandadan (PC)", title: "Dandadan", chapters: ["Ch.001.cbz"] },
  [KAG_URL]: { folder: "Kagurabachi (PC)", title: "Kagurabachi", chapters: ["Ch.001.cbz"] },
};
const FAKE_PY = `import json, os, sys
args = sys.argv[1:]
with open(os.environ["AIO_E2E_FAKE_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(args) + "\\n")
if "--search" in args:
    q = args[args.index("--search") + 1]
    table = json.loads(os.environ["AIO_E2E_FAKE_SEARCH"])
    sys.stdout.write(json.dumps(table.get(q, {"candidates": []})))
    sys.exit(0)
table = json.loads(os.environ["AIO_E2E_FAKE_DOWNLOADS"])
lib = os.environ["AIO_OUTPUT_DIR"]
old = os.path.getmtime(os.environ["AIO_E2E_OLD_FILE"])
for u in [a for a in args if a.startswith("http")]:
    d = table.get(u)
    if not d:
        print("[!] fake backend: unknown url " + u)
        sys.exit(1)
    folder = os.path.join(lib, d["folder"])
    os.makedirs(folder, exist_ok=True)
    files = []
    for c in d["chapters"]:
        p = os.path.join(folder, c)
        with open(p, "wb") as f:
            f.write(c.encode() * 400)
        files.append(p)
        print("CBZ saved -> " + c)
    meta = os.path.join(folder, ".aio_series.json")
    with open(meta, "w", encoding="utf-8") as f:
        json.dump({"url": u, "title": d["title"]}, f)
    for p in files + [meta]:
        os.utime(p, (old, old))
sys.exit(0)
`;

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-e2e-find-"));
  const CFG = path.join(TMP, "config");
  const LIB = path.join(TMP, "library");
  const DEV = path.join(TMP, "tablet");
  const FAKE = path.join(TMP, "fake_aio.py");
  const LOG = path.join(TMP, "fake_calls.log");
  const OLDF = path.join(TMP, "old.stamp");
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(FAKE, FAKE_PY);
  fs.writeFileSync(LOG, "");
  fs.writeFileSync(OLDF, "");
  fs.utimesSync(OLDF, OLD, OLD);
  series(LIB, "Alpha", ["Ch.001.cbz", "Ch.002.cbz"]);
  for (const f of ["Chainsaw Man", "Kagurabachi", "Dandadan"]) chapter(path.join(DEV, f), "Ch.001.cbz", 3000);

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: CFG,
    AIO_OUTPUT_DIR: LIB,
    AIO_E2E_FAKE_LOG: LOG,
    AIO_E2E_OLD_FILE: OLDF,
    AIO_E2E_FAKE_SEARCH: JSON.stringify(FAKE_SEARCH),
    AIO_E2E_FAKE_DOWNLOADS: JSON.stringify(FAKE_DOWNLOADS),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_ENV;
  if (EXE) {
    fs.mkdirSync(path.join(CFG, "python-env"), { recursive: true });
    fs.writeFileSync(path.join(CFG, "python-env", ".setup-complete"), "e2e");
  }
  console.log(`app: ${EXE || APP}`);
  const app = await _electron.launch(
    EXE
      ? { executablePath: EXE, args: [`--user-data-dir=${CFG}`], env, timeout: 60_000 }
      : { executablePath: ELECTRON, args: ["--no-sandbox", `--user-data-dir=${CFG}`, APP], env, timeout: 60_000 }
  );
  let out = "";
  app.process().stderr.on("data", (d) => (out += d));
  app.process().stdout.on("data", (d) => (out += d));
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.electronAPI && document.querySelector("#root") && document.querySelector("#root").children.length > 0, null, { timeout: 30_000 });
  const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  check("isolated userData", userData.startsWith(CFG), userData);

  const TN = "E2E Find";
  const rail = (t) => win.locator(`nav.w-16 button[title="${t}"]`);
  const tabTitle = () => win.locator("h1").first().textContent();
  const calls = () =>
    fs
      .readFileSync(LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const downloadsOf = (url) => calls().filter((a) => !a.includes("--search") && a.includes(url));
  const state = () => win.evaluate(() => window.electronAPI.syncGetState());
  const targetOf = (st) => (st.config && st.config.targets ? st.config.targets.find((t) => t.name === TN) : null);
  const planOf = (st) => {
    const t = targetOf(st);
    return t && st.plans && st.plans[t.id] ? st.plans[t.id].summary : null;
  };
  // Waits until the target's plan binds `folder` (a series whose device
  // folder it is) and no longer lists it as only on the target.
  const waitBound = (folder, timeout = 40_000) =>
    win.waitForFunction(
      async ({ tn, folder: f }) => {
        const st = await window.electronAPI.syncGetState();
        const t = st.config && st.config.targets && st.config.targets.find((x) => x.name === tn);
        const s = t && st.plans && st.plans[t.id] && st.plans[t.id].summary;
        if (!s) return false;
        const only = (s.deviceOnly || []).some((d) => d.name === f);
        const bound = (s.series || s.rows || []).some((r) => r.deviceFolder === f);
        return !only && bound;
      },
      { tn: TN, folder },
      { timeout, polling: 500 }
    );
  const step = async (label, fn) => {
    try {
      await fn();
      check(label, true);
    } catch (e) {
      check(label, false, String(e && e.message).split("\n")[0]);
      const shot = path.join(REPO, "tools", `_e2e_find_fail_${label.replace(/\W+/g, "_")}.png`);
      await win.screenshot({ path: shot }).catch(() => {});
      console.log(`  ..  screenshot: ${shot}`);
      throw e;
    }
  };

  try {
    // Scene: sync on, the fake backend as the python side, prompt-on-connect
    // off (the corner card would cover the sheet's footer), one folder target
    // already present with three folders the library doesn't have.
    const s = await win.evaluate(() => window.electronAPI.getSettings());
    const saved = await win.evaluate(
      (x) => window.electronAPI.saveSettings({ ...x.s, pythonCmd: x.py, scriptPath: x.fake, workingDir: x.wd, syncEnabled: true, syncPromptOnConnect: false }),
      { s, py: PYTHON, fake: FAKE, wd: TMP }
    );
    check("sync on, fake backend set", saved && saved.ok === true, JSON.stringify(saved));
    await rail("Sync").waitFor({ timeout: 20_000 });
    const added = await win.evaluate((t) => window.electronAPI.syncConfigOp({ op: "add-target", target: t }), { name: TN, kind: "folder", root: DEV, profile: "komikku" });
    check("folder target added", added && added.ok === true, JSON.stringify(added));
    await rail("Sync").click();

    // 1. batch
    await step("the target's own folders are listed", () => win.getByText(`Only on ${TN}`).first().waitFor({ timeout: 40_000 }));
    await step("Find sources… opens the sheet with all three", async () => {
      await win.getByRole("button", { name: "Find sources…" }).click();
      await win.getByText("Find sources for 3 folders").waitFor({ timeout: 10_000 });
    });
    await step("Skip one, then Search the other two", async () => {
      await win.getByRole("checkbox", { name: "Include Dandadan" }).click();
      await win.getByRole("button", { name: "Search 2 folders" }).click();
      await win.getByRole("button", { name: "Queue 1 download" }).waitFor({ timeout: 30_000 });
    });
    check("the skipped folder wasn't searched", !calls().some((a) => a.includes("--search") && a.includes("Dandadan")));
    check("the search ran with --search-json", calls().some((a) => a.includes("--search") && a.includes("Chainsaw Man") && a.includes("--search-json")));
    await step("pin a URL on the row that found nothing", async () => {
      const row = win.locator('[data-testid="find-row"][data-folder="Kagurabachi"]');
      await row.getByText("No source found").waitFor({ timeout: 10_000 });
      await row.getByRole("button", { name: "Pin URL" }).click();
      await row.getByRole("textbox", { name: "URL for Kagurabachi" }).fill(KAG_URL);
      await row.getByRole("button", { name: "Pin", exact: true }).click();
      await win.getByRole("button", { name: "Queue 2 downloads" }).waitFor({ timeout: 10_000 });
    });
    await step("Queue links both folders, then downloads", async () => {
      await win.getByRole("button", { name: "Queue 2 downloads" }).click();
      const ok = win.getByText("Queued. It syncs into this folder once it's downloaded.");
      await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="find-row"]')].filter((r) => /Queued\. It syncs/.test(r.textContent)).length === 2, null, { timeout: 15_000 });
      await ok.first().waitFor();
    });
    const t1 = targetOf(await state());
    for (const [url, folder] of [[CSM_URL, "Chainsaw Man"], [KAG_URL, "Kagurabachi"]]) {
      check(`alias recorded for ${folder}`, !!t1 && (t1.aliases || []).some((a) => a.url === url && a.deviceFolder === folder), JSON.stringify(t1 && t1.aliases));
    }
    await step("both downloads ran with --komikku", async () => {
      const t0 = Date.now();
      while ((!downloadsOf(CSM_URL).length || !downloadsOf(KAG_URL).length) && Date.now() - t0 < 30_000) await win.waitForTimeout(250);
      for (const url of [CSM_URL, KAG_URL]) {
        const d = downloadsOf(url);
        if (!d.length) throw new Error(`no download call for ${url}`);
        if (!d[0].includes("--komikku")) throw new Error(`args ${d[0].join(" ")}`);
      }
    });
    await step("after the downloads both device folders bind through their aliases", async () => {
      await waitBound("Chainsaw Man");
      await waitBound("Kagurabachi");
    });
    await win.keyboard.press("Escape");

    // 2. single
    await step("Find source opens Search with the banner and runs it", async () => {
      await win.getByText("Find sources for 3 folders").waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
      const row = win.locator("div.cursor-pointer", { hasText: "Dandadan" }).first();
      await row.getByRole("button", { name: "Find source" }).click();
      await win.locator('[data-testid="find-banner"]').waitFor({ timeout: 10_000 });
      if ((await tabTitle()) !== "Search") throw new Error(`tab ${await tabTitle()}`);
      await win.locator('[data-testid="find-banner"]').getByText("Dandadan").first().waitFor();
      await win.getByRole("heading", { name: "Dandadan" }).waitFor({ timeout: 30_000 });
    });
    check("the single search used the folder's query", calls().some((a) => a.includes("--search") && a.includes("Dandadan")));
    await step("Download → Queue links, queues, clears the banner", async () => {
      await win.getByRole("button", { name: "Download" }).first().click();
      // The rail's Queue tab button shares the name; the dialog's isn't in nav.
      await win.locator("button:not(nav button)", { hasText: /^\s*Queue\s*$/ }).click();
      await win.waitForFunction(() => document.querySelector("h1") && document.querySelector("h1").textContent === "Queue", null, { timeout: 10_000 });
      if (await win.locator('[data-testid="find-banner"]').count()) throw new Error("banner still shown");
    });
    const t2 = targetOf(await state());
    check("alias recorded for Dandadan", !!t2 && (t2.aliases || []).some((a) => a.url === DAN_URL && a.deviceFolder === "Dandadan"), JSON.stringify(t2 && t2.aliases));
    await step("the single download ran with --komikku and binds", async () => {
      const t0 = Date.now();
      while (!downloadsOf(DAN_URL).length && Date.now() - t0 < 20_000) await win.waitForTimeout(250);
      const d = downloadsOf(DAN_URL);
      if (!d.length) throw new Error("no download call");
      if (!d[0].includes("--komikku")) throw new Error(`args ${d[0].join(" ")}`);
      await waitBound("Dandadan");
    });
    await rail("Search").click();
    check("the banner stays gone on return", (await win.locator('[data-testid="find-banner"]').count()) === 0);

    // 3. Library
    // Alpha was never copied to the target ("not on it yet": dim chip). The
    // linked Chainsaw Man is bound with its 2 chapters still to copy (count).
    const csm = () => win.locator("button", { hasText: "Chainsaw Man (PC)" }).first();
    await step("Library: chips read dim for Alpha, 2 for Chainsaw Man", async () => {
      await rail("Library").click();
      await win.locator("button", { hasText: "Alpha" }).first().locator('[data-testid="sync-chip"][data-kind="dim"]').waitFor({ timeout: 20_000 });
      const chip = csm().locator('[data-testid="sync-chip"][data-kind="count"]');
      await chip.waitFor({ timeout: 20_000 });
      const n = (await chip.textContent()).trim();
      if (n !== "2") throw new Error(`count ${n}`);
    });
    await step("detail: the sync line and Open in Sync open the series", async () => {
      await csm().click();
      const line = win.locator('[data-testid="sync-line"]');
      await line.waitFor({ timeout: 10_000 });
      await line.getByText(TN).first().waitFor();
      await line.getByText("2 to copy").first().waitFor();
      await line.getByRole("button", { name: "Open in Sync" }).click();
      await win.waitForFunction(() => document.querySelector("h1") && document.querySelector("h1").textContent === "Sync", null, { timeout: 10_000 });
      await win.getByRole("dialog").getByText("Chainsaw Man").first().waitFor({ timeout: 10_000 });
    });
  } catch (e) {
    if (!failures) check("e2e", false, e && e.stack);
  } finally {
    const errs = out.split("\n").filter((l) => /\[deviceSync\].*(error|internal)/i.test(l));
    check("no internal sync errors in main's log", !errs.length, errs.slice(0, 3).join(" | "));
    await app.close().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall find E2E checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
