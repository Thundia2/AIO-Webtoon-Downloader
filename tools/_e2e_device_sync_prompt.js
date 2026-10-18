// E2E for the connect prompt and the rail badge (UI pass U3) on the real dev
// app with a FOLDER target.
// Run: node tools/_e2e_device_sync_prompt.js [--app <UI-source dir>] [--exe <packaged exe>] [--renderer dist|dev] [--no-build]
//   Same prerequisites as tools/_e2e_device_sync_tab.js (Playwright via
//   PLAYWRIGHT_PATH; renderer flags and --exe are tools/_e2e_launch.js's).
//
// The whole engine runs for real; only the target is a temp folder, created
// AFTER the target is configured, so the app sees it "plugged in" through
// its own FolderWatcher (monitor.js, a poll every 5 s). Isolated userData
// (--user-data-dir) and library (AIO_OUTPUT_DIR) under one temp dir.
//
// FOCUS. main shows a card only while the window is focused
// (BrowserWindow.getFocusedWindow, main.js grep isFocused) and a window
// driven by Playwright may never be. The run pins getFocusedWindow to the
// app window and emits browser-window-focus once, the two things main reads.
//
// Flows, in order (each depends on the one before):
//   1. plug in: the folder appears on the New tab → the corner card shows
//      the plan's numbers; the rail counts the series to sync
//   2. Review: the card closes and the Sync tab opens on that target's
//      series list (U3-2), not the Review dialog
//   3. Start: the dock's Review and start → Start sync → last-run card;
//      files on disk; the rail count clears after the re-plan
//   4. re-plug with a new chapter: a new card; hidden while the Sync tab
//      shows its target (U3-13), back on another tab; Not now closes it
//   5. nothing left to do: a card left open closes by itself once the
//      target is synced from the tab (U3-6, main's withdraw)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cliOptions, launchApp } = require("./_e2e_launch");

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

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aio-e2e-prompt-"));
  const CFG = path.join(TMP, "config");
  const LIB = path.join(TMP, "library");
  const DEV = path.join(TMP, "tablet");
  fs.mkdirSync(CFG, { recursive: true });
  series(LIB, "Alpha", ["Ch.001.cbz", "Ch.002.cbz", "Ch.003.cbz"]);
  series(LIB, "Beta", ["Ch.001.cbz", "Ch.002.cbz"]);

  const env = { ...process.env, XDG_CONFIG_HOME: CFG, AIO_OUTPUT_DIR: LIB };
  const { app, win, output } = await launchApp({ ...LAUNCH, userDataDir: CFG, env });
  const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  check("isolated userData", userData.startsWith(CFG), userData);
  await app.evaluate(({ BrowserWindow, app: a }) => {
    const w = BrowserWindow.getAllWindows()[0];
    BrowserWindow.getFocusedWindow = () => w;
    a.emit("browser-window-focus", {}, w);
  });

  const TN = "E2E Tab";
  const text = (t, timeout = 20_000) => win.getByText(t).first().waitFor({ timeout });
  const card = () => win.locator('[data-testid="sync-connect-card"][data-kind="prompt"]');
  const railCount = () => win.locator('nav.w-16 button[title="Sync"] [data-testid="sync-rail-count"]');
  const tabTitle = () => win.locator("h1").first().textContent();
  const box = (name) => win.getByRole("checkbox", { name, exact: true });
  const step = async (label, fn) => {
    try {
      await fn();
      check(label, true);
    } catch (e) {
      check(label, false, String(e && e.message).split("\n")[0]);
      const shot = path.join(REPO, "tools", `_e2e_prompt_fail_${label.replace(/\W+/g, "_")}.png`);
      await win.screenshot({ path: shot }).catch(() => {});
      console.log(`  ..  screenshot: ${shot}`);
      throw e;
    }
  };
  // Review and start → wait for Start to enable → Start. A re-plan that
  // lands while the dialog is open and changes what it shows raises "The
  // plan changed. Review it again." (ReviewDialog.jsx grep changedNotice),
  // which holds Start until dismissed: that is the app working, and a user
  // would click "I've reviewed it". In flow 5 the reconnect's follow-up
  // re-plan can land after Review opens, so the helper dismisses the notice
  // the way a user would and logs that it did. On timeout the footer's
  // reason line ("Ready", "Saving…", "The plan is being rebuilt"…) goes into
  // the error so the cause is in the log, not only in the screenshot.
  const startSync = async () => {
    await win.getByRole("button", { name: "Review and start" }).click();
    const dialog = win.getByRole("dialog");
    const start = dialog.getByRole("button", { name: /^Start sync/ });
    const reviewed = dialog.getByRole("button", { name: "I've reviewed it" });
    await start.waitFor();
    const end = Date.now() + 15_000;
    while (!(await start.isEnabled())) {
      // Deadline first, so a notice that keeps coming back can't loop forever.
      if (Date.now() > end) {
        const why = await dialog.locator("span.flex-1.text-xs").first().textContent({ timeout: 2_000 }).catch(() => "?");
        throw new Error(`Start sync stayed disabled for 15 s: "${why}"`);
      }
      if (await reviewed.isVisible()) {
        console.log("  ..  the plan changed while Review was open; dismissed the notice");
        await reviewed.click();
        continue;
      }
      await win.waitForTimeout(200);
    }
    await start.click();
    await text(`Synced to ${TN}`, 60_000);
  };

  try {
    // Scene: sync on (prompt on connect is the default), one folder target
    // whose folder doesn't exist yet. Stay on the New tab.
    const s = await win.evaluate(() => window.electronAPI.getSettings());
    const saved = await win.evaluate((x) => window.electronAPI.saveSettings({ ...x, syncEnabled: true, syncPromptOnConnect: true }), s);
    check("sync turned on", saved && saved.ok === true, JSON.stringify(saved));
    await win.locator('nav.w-16 button[title="Sync"]').waitFor({ timeout: 20_000 });
    const added = await win.evaluate((t) => window.electronAPI.syncConfigOp({ op: "add-target", target: t }), { name: TN, kind: "folder", root: DEV, profile: "komikku" });
    check("folder target added (folder absent)", added && added.ok === true, JSON.stringify(added));
    await win.locator('nav.w-16 button[title="New"]').click();
    check("no card while the folder is absent", (await card().count()) === 0);

    // 1. plug in
    fs.mkdirSync(DEV, { recursive: true });
    await step("plug in: the card shows the plan", async () => {
      await card().waitFor({ timeout: 40_000 });
      await card().getByText(`${TN} connected`).waitFor();
      await card().getByText("5 chapters in 2 series").waitFor();
    });
    await step("plug in: the rail counts 2 series", async () => {
      await railCount().waitFor({ timeout: 10_000 });
      const n = (await railCount().textContent()).trim();
      if (n !== "2") throw new Error(`rail count ${n}`);
    });
    check("the card sits bottom-right over the New tab", (await tabTitle()) === "New");

    // 2. Review
    await step("Review opens the Sync tab's series list", async () => {
      await card().getByRole("button", { name: "Review" }).click();
      await box("Sync Alpha").waitFor({ timeout: 15_000 });
      await card().waitFor({ state: "detached", timeout: 5_000 });
      if ((await tabTitle()) !== "Sync") throw new Error(`tab ${await tabTitle()}`);
      if (await win.getByRole("dialog").count()) throw new Error("the Review dialog opened");
    });

    // 3. Start
    await step("Start syncs and shows the last-run card", startSync);
    check("Alpha and Beta on disk", ["Alpha", "Beta"].every((f) => fs.existsSync(path.join(DEV, f, "Ch.001.cbz"))), fs.readdirSync(DEV).join(","));
    await step("the rail count clears after the re-plan", () => railCount().waitFor({ state: "detached", timeout: 20_000 }));

    // 4. re-plug with a new chapter
    const parked = `${DEV}.off`;
    fs.renameSync(DEV, parked);
    // Two absent polls (U3-8) before it counts as unplugged: ≥ 10 s.
    await step("unplug is seen", () => win.getByText("Folder not found").first().waitFor({ timeout: 30_000 }));
    chapter(path.join(LIB, "Alpha"), "Ch.004.cbz", 4010);
    // Positive control for the "hidden" check below: main having the card
    // says nothing about the renderer, so a count() taken before the
    // renderer's `prompt` event lands passes whether or not the tab hides
    // it. This listener sits beside useDeviceSync's on the same "sync-event"
    // channel and was added after it, so once it has seen the show, the
    // hook's reducer has too; two frames then let React commit.
    await win.evaluate(() => {
      window.__e2ePromptShows = 0;
      window.electronAPI.onSyncEvent((e) => {
        if (e && e.kind === "prompt" && e.action === "show") window.__e2ePromptShows += 1;
      });
    });
    fs.renameSync(parked, DEV);
    await step("re-plug: hidden while the Sync tab shows the target", async () => {
      await win.getByText("Connected").first().waitFor({ timeout: 30_000 });
      await win.waitForFunction(() => window.__e2ePromptShows >= 1, null, { timeout: 30_000, polling: 200 });
      await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      if ((await tabTitle()) !== "Sync") throw new Error(`tab ${await tabTitle()}`);
      // The renderer holds the card; the tab shows its target, so nothing draws.
      if (await card().count()) throw new Error("card drawn over the Sync tab");
    });
    await step("re-plug: the card is back on another tab", async () => {
      await win.locator('nav.w-16 button[title="New"]').click();
      await card().waitFor({ timeout: 5_000 });
      await card().getByText("1 chapter in 1 series").waitFor();
    });
    await step("Not now closes it", async () => {
      await card().getByRole("button", { name: "Not now" }).click();
      await card().waitFor({ state: "detached", timeout: 5_000 });
    });
    const left = await win.evaluate(() => window.electronAPI.syncGetState());
    check("main has no open card after Not now", left.prompts.length === 0, JSON.stringify(left.prompts));

    // 5. nothing left to do: re-plug again, leave the card open, sync from the tab.
    fs.renameSync(DEV, parked);
    await step("second unplug is seen", async () => {
      await win.locator('nav.w-16 button[title="Sync"]').click();
      await win.getByText("Folder not found").first().waitFor({ timeout: 30_000 });
    });
    chapter(path.join(LIB, "Beta"), "Ch.003.cbz", 4010);
    fs.renameSync(parked, DEV);
    await step("a card left open closes once the target is synced", async () => {
      await win.waitForFunction(async () => {
        const st = await window.electronAPI.syncGetState();
        return st.prompts && st.prompts.length === 1;
      }, null, { timeout: 40_000, polling: 500 });
      await startSync();
      await win.waitForFunction(async () => {
        const st = await window.electronAPI.syncGetState();
        return st.prompts && st.prompts.length === 0;
      }, null, { timeout: 30_000, polling: 500 });
      await win.locator('nav.w-16 button[title="New"]').click();
      await win.waitForTimeout(500);
      if (await card().count()) throw new Error("card still drawn");
    });
  } catch (e) {
    if (!failures) check("e2e", false, e && e.stack);
  } finally {
    const errs = output().split("\n").filter((l) => /\[deviceSync\].*(error|internal)/i.test(l));
    check("no internal sync errors in main's log", !errs.length, errs.slice(0, 3).join(" | "));
    await app.close().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall prompt E2E checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
