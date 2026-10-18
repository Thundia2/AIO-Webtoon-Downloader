// E2E for the Sync tab (UI pass U2) on the real dev app with a FOLDER target.
// Run: node tools/_e2e_device_sync_tab.js [--app <UI-source dir>] [--exe <packaged exe>] [--renderer dist|dev] [--no-build]
//   --exe runs the same flows on a packaged build (electron-builder --dir;
//   see tools/_smoke_device_sync_packaged.js for the command). Its temp
//   profile is pre-marked set up (python-env/.setup-complete), as that smoke
//   does, so the first-run wizard doesn't download Python.
//   Renderer flags: tools/_e2e_launch.js (dist is built first by default).
//   Needs Playwright (PLAYWRIGHT_PATH, as
//   tools/_smoke_device_sync_dev.js documents; on this PC it lives in the npx
//   cache). Linux without a display: prefix with `xvfb-run -a`.
//
// The whole engine runs for real (service, planner, executor, folder
// transport); only the target is a temp folder instead of a tablet. Isolated
// userData (--user-data-dir) and library (AIO_OUTPUT_DIR), both under one
// temp dir that is deleted at the end. Every step drives the Sync tab's own
// controls; IPC is used only to set the scene (turn sync on, add the target)
// and for the one contract the UI can't reach (a stale-gen apply).
//
// Flows, in order (each depends on the one before):
//   1. plan: both series listed with the dock's Review and start
//   2. deselect: Beta's row box off → the dock counts 1 series
//   3. apply: Review → Start → last-run card; Alpha on disk, Beta not
//   4. removal review: a chapter deleted on the PC, ticked in the detail
//      sheet; Start stays disabled until the loss (and the mass-removal, when
//      the plan requires it) is confirmed; the file is gone afterwards
//   5. plan-changed: a re-plan while Review is open moves the dialog to the
//      new plan; an identical re-plan asks nothing, while one with a new PC
//      chapter raises "The plan changed" notice, which holds Start until
//      dismissed (R7); an apply with the old gen is refused `blocked {plan-changed}`
//   6. record-mismatch: the record's header names another folder → its card;
//      restored → gone
//   7. device-listing-suspect: the target folder suddenly empty → its card,
//      nothing removed; restored → gone
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cliOptions, launchApp, waitReady } = require("./_e2e_launch");

const argv = process.argv.slice(2);
const REPO = path.resolve(__dirname, "..");
const LAUNCH = cliOptions(argv);

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OLD = new Date(Date.now() - 3600_000); // past the 30 s settle age

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
function findFile(root, name) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return null;
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-e2e-sync-"));
  const CFG = path.join(TMP, "config");
  const LIB = path.join(TMP, "library");
  const DEV = path.join(TMP, "tablet");
  fs.mkdirSync(CFG, { recursive: true });
  fs.mkdirSync(DEV, { recursive: true });
  series(LIB, "Alpha", ["Ch.001.cbz", "Ch.002.cbz", "Ch.003.cbz"]);
  series(LIB, "Beta", ["Ch.001.cbz", "Ch.002.cbz"]);

  const env = { ...process.env, XDG_CONFIG_HOME: CFG, AIO_OUTPUT_DIR: LIB };
  const { app, win, output } = await launchApp({ ...LAUNCH, userDataDir: CFG, env });
  const ready = () => waitReady(win);
  const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  check("isolated userData", userData.startsWith(CFG), userData);

  const TN = "E2E Tab";
  const text = (t, timeout = 20_000) => win.getByText(t).first().waitFor({ timeout });
  const gone = (t, timeout = 20_000) => win.getByText(t).first().waitFor({ state: "detached", timeout });
  const box = (name) => win.getByRole("checkbox", { name, exact: true });
  const dialog = () => win.getByRole("dialog");
  const recheck = async () => {
    await win.getByRole("button", { name: "Re-check" }).first().click();
    await win.getByRole("button", { name: "Re-check" }).last().click();
  };
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      check(label, false, String(e && e.message).split("\n")[0]);
      const shot = path.join(REPO, "tools", `_e2e_sync_fail_${label.replace(/\W+/g, "_")}.png`);
      const shotErr = await win.screenshot({ path: shot }).then(() => null, (x) => x);
      console.log(`  ..  screenshot: ${shotErr ? `FAILED (${String(shotErr.message).split("\n")[0]})` : shot}`);
      // An open dialog's text says which gate held Start (footer WHY copy).
      const dlg = await win.evaluate(() => {
        const d = document.querySelector("[role=dialog]");
        return d ? d.innerText.replace(/\s+/g, " ").slice(0, 600) : null;
      }).catch(() => null);
      if (dlg) console.log(`  ..  dialog: ${dlg}`);
      throw e;
    }
  };

  try {
    // Scene: sync on, one folder target.
    const s = await win.evaluate(() => window.electronAPI.getSettings());
    const saved = await win.evaluate((x) => window.electronAPI.saveSettings({ ...x, syncEnabled: true }), s);
    check("sync turned on", saved && saved.ok === true, JSON.stringify(saved));
    await win.locator('nav.w-16 button[title="Sync"]').waitFor({ timeout: 20_000 });
    const added = await win.evaluate((t) => window.electronAPI.syncConfigOp({ op: "add-target", target: t }), { name: TN, kind: "folder", root: DEV, profile: "komikku" });
    check("folder target added", added && added.ok === true, JSON.stringify(added));
    const tid = added.targetId;
    await win.locator('nav.w-16 button[title="Sync"]').click();

    // 1. plan
    await step("plan lists both series", async () => {
      await box("Sync Alpha").waitFor({ timeout: 30_000 });
      await box("Sync Beta").waitFor();
      await text("Review and start");
    });
    check("plan lists both series", true);
    // A wide window gets the wide desk (legend with labels). Regression: the
    // width observer stayed on the no-target screen's detached element.
    const contentW = await win.evaluate(() => document.querySelector('[data-testid="sync-ledger"]').getBoundingClientRect().width);
    if (contentW >= 1000) {
      // No wait: the desk measures itself on mount, so a wide window's first
      // paint is already wide (it used to flash narrow for a frame).
      const shown = await win.getByText("Will copy", { exact: true }).isVisible();
      const why = await win.evaluate(() => {
        const sw = document.querySelector('[data-testid="sync-ledger"]').parentElement;
        return { root: Math.round(sw.getBoundingClientRect().width), dpr: window.devicePixelRatio, filter: Math.round(document.querySelector('input[aria-label="Filter series"]').parentElement.getBoundingClientRect().width) };
      });
      check("wide layout at a wide window", shown, `ledger ${Math.round(contentW)} px, ${JSON.stringify(why)}`);
    }
    else console.log(`  --  window too narrow for the wide layout (${Math.round(contentW)} px); not checked`);
    check("both pre-selected", (await box("Sync Alpha").getAttribute("aria-checked")) === "true" && (await box("Sync Beta").getAttribute("aria-checked")) === "true");

    // 2. deselect
    await step("deselect Beta", async () => {
      await box("Sync Beta").click();
      await win.waitForFunction(() => {
        const b = document.querySelector('[role=checkbox][aria-label="Sync Beta"]');
        return b && b.getAttribute("aria-checked") === "false" && !b.getAttribute("aria-busy");
      }, null, { timeout: 15_000 });
      await text(/^1 series$/);
    });
    check("deselect Beta (dock: 1 series)", true);

    // 3. apply
    await step("apply", async () => {
      await win.getByRole("button", { name: "Review and start" }).click();
      const start = dialog().getByRole("button", { name: /^Start sync/ });
      await start.waitFor();
      await win.waitForFunction(() => [...document.querySelectorAll("[role=dialog] button")].some((b) => /^Start sync/.test(b.textContent) && !b.disabled), null, { timeout: 15_000 });
      await start.click();
      await text(`Synced to ${TN}`, 60_000);
    });
    check("apply: last-run card", true);
    check("apply: Alpha copied", ["Ch.001.cbz", "Ch.002.cbz", "Ch.003.cbz"].every((n) => fs.existsSync(path.join(DEV, "Alpha", n))), fs.readdirSync(DEV).join(","));
    check("apply: Beta not copied", !fs.existsSync(path.join(DEV, "Beta")));

    // 4. removal review
    fs.rmSync(path.join(LIB, "Alpha", "Ch.003.cbz"));
    await step("removal review", async () => {
      await recheck();
      await win.getByRole("button", { name: "Open Alpha" }).click();
      const tick = win.getByRole("checkbox", { name: "Tick Ch.003.cbz" });
      await tick.waitFor();
      await tick.click();
      await win.getByRole("checkbox", { name: "Untick Ch.003.cbz" }).waitFor({ timeout: 15_000 });
      await win.keyboard.press("Escape");
      await win.getByRole("button", { name: "Review and start" }).click();
      await dialog().getByRole("checkbox", { name: "Confirm removing chapters of Alpha" }).waitFor();
    });
    const startBtn = dialog().getByRole("button", { name: /^Start sync/ });
    check("Start disabled until the loss is confirmed", await startBtn.isDisabled());
    await dialog().getByRole("checkbox", { name: "Confirm removing chapters of Alpha" }).click();
    const mass = dialog().getByRole("checkbox", { name: "Confirm the mass removal" });
    if (await mass.count()) {
      check("mass removal still blocks Start", await startBtn.isDisabled());
      await mass.click();
    }
    await step("removal applied", async () => {
      await win.waitForFunction(() => [...document.querySelectorAll("[role=dialog] button")].some((b) => /^Start sync/.test(b.textContent) && !b.disabled), null, { timeout: 10_000 });
      await startBtn.click();
      await win.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 15_000 });
      await text(/removed/, 60_000);
    });
    check("removal: Ch.003 gone from the target", !fs.existsSync(path.join(DEV, "Alpha", "Ch.003.cbz")));
    check("removal: Ch.001 kept", fs.existsSync(path.join(DEV, "Alpha", "Ch.001.cbz")));

    // 5. plan-changed. Beta stays deselected across plans (the user's choice
    // persists), so tick it back first: the box restores the pre-selection.
    await step("Beta back on", async () => {
      await box("Sync Beta").click();
      await win.waitForFunction(() => {
        const b = document.querySelector('[role=checkbox][aria-label="Sync Beta"]');
        return b && b.getAttribute("aria-checked") === "true" && !b.getAttribute("aria-busy");
      }, null, { timeout: 15_000 });
    });
    check("a deselected series stays off across plans, and its box restores it", true);
    await step("plan-changed", async () => {
      await win.getByRole("button", { name: "Review and start" }).click();
      await dialog().getByText(/^plan \d+/).waitFor();
    });
    const genOf = async () => Number(((await dialog().getByText(/^plan \d+/).textContent()) || "").match(/plan (\d+)/)[1]);
    // Waits until the dialog shows a plan newer than g. No catch: a re-plan
    // the dialog never shows is the failure.
    const pastGen = (g) =>
      win.waitForFunction((x) => [...document.querySelectorAll("[role=dialog] *")].some((e) => e.children.length === 0 && /^plan (\d+)\b/.test(e.textContent) && Number(e.textContent.match(/^plan (\d+)/)[1]) > x), g, { timeout: 30_000 });
    const notice = () => dialog().getByRole("button", { name: "I've reviewed it" });
    const g0 = await genOf();
    // (a) A re-plan that finds nothing new moves the gen but asks nothing
    // (syncView.reviewSig): the dialog follows it quietly.
    await win.evaluate((id) => window.electronAPI.syncPlan({ targetId: id }), tid);
    await step("an open Review follows an identical re-plan", () => pastGen(g0));
    const g1 = await genOf();
    await sleep(500);
    check("an identical re-plan raises no notice", (await notice().count()) === 0);
    // (b) A re-plan that changes what Start would do (a new PC chapter) is
    // announced and holds Start until acknowledged (R7).
    chapter(path.join(LIB, "Beta"), "Ch.009.cbz", 4010);
    await win.evaluate((id) => window.electronAPI.syncPlan({ targetId: id }), tid);
    await step("an open Review follows a changed re-plan", () => pastGen(g1));
    await step("plan-changed notice shows and holds Start", async () => {
      await dialog().getByText("The plan changed. Review it again.").first().waitFor({ timeout: 10_000 });
      if (!(await startBtn.isDisabled())) throw new Error("Start enabled under the notice");
      await dialog().getByRole("button", { name: "I've reviewed it" }).click();
      await dialog().getByRole("button", { name: "I've reviewed it" }).waitFor({ state: "detached", timeout: 5_000 });
    });
    const stale = await win.evaluate((p) => window.electronAPI.syncApply(p), { targetId: tid, gen: g0 });
    check("apply with the reviewed-before gen is refused plan-changed", stale && stale.code === "blocked" && stale.blocking && stale.blocking[0].kind === "plan-changed", JSON.stringify(stale));
    await win.keyboard.press("Escape");

    // 6. record-mismatch
    const hp = findFile(path.join(userData, "sync"), "header.json");
    check("record header found", !!hp, hp);
    const header = fs.readFileSync(hp, "utf8");
    fs.writeFileSync(hp, JSON.stringify({ ...JSON.parse(header), root: path.join(TMP, "Old Tablet") }));
    await step("record-mismatch card", async () => {
      await recheck();
      await text(`The folder on ${TN} isn't the one this app synced to`, 30_000);
      await win.getByRole("button", { name: "Edit target" }).waitFor();
    });
    check("record-mismatch card", true);
    fs.writeFileSync(hp, header);
    await step("record-mismatch clears", async () => {
      await recheck();
      await gone(`The folder on ${TN} isn't the one this app synced to`, 30_000);
    });
    check("record-mismatch clears once restored", true);

    // 7. device-listing-suspect
    const parked = path.join(TMP, "parked");
    fs.renameSync(DEV, parked);
    fs.mkdirSync(DEV);
    fs.writeFileSync(path.join(DEV, ".nomedia"), "");
    await step("listing-suspect card", async () => {
      await recheck();
      await text(`${TN} shows no series folders`, 30_000);
    });
    check("device-listing-suspect card", true);
    check("listing-suspect removed nothing", fs.existsSync(path.join(parked, "Alpha", "Ch.001.cbz")));
    fs.rmSync(DEV, { recursive: true, force: true });
    fs.renameSync(parked, DEV);
    await step("listing-suspect clears", async () => {
      await recheck();
      await gone(`${TN} shows no series folders`, 30_000);
      await box("Sync Alpha").waitFor({ timeout: 30_000 }).catch(() => {});
    });
    check("device-listing-suspect clears once restored", true);
  } catch (e) {
    if (!failures) check("e2e", false, e && e.stack);
  } finally {
    const errs = output().split("\n").filter((l) => /\[deviceSync\].*(error|internal)/i.test(l));
    check("no internal sync errors in main's log", !errs.length, errs.slice(0, 3).join(" | "));
    await app.close().catch(() => {});
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {}
  }
  console.log(failures ? `\n${failures} failure(s)` : "\ne2e passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log(`FAIL  e2e: ${e && e.stack}`);
  process.exit(1);
});
