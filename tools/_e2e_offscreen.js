// Main-process preload (`electron -r <this>`) that keeps E2E windows off the
// user's screen: every BrowserWindow the app creates opens far outside the
// desktop, never takes focus and has no taskbar button, but renders exactly
// as a visible window does (rAF at full rate, screenshots work).
//
// Loaded by: tools/_e2e_launch.js launchApp (grep _e2e_offscreen), unless the
// run passes --show or AIO_E2E_SHOW=1. Not used for --exe: a packaged build
// may have the node-CLI fuse off, so `-r` would be ignored or refused.
//
// Why the two extra switches: Windows' native occlusion tracking counts an
// off-screen window as not visible and Chromium throttles it (measured
// 2026-10-18, off-screen alone: rAF 1/s, capturePage returned an empty
// image). With CalculateNativeWinOcclusion off and backgroundThrottling:false
// it measured rAF ~190/s and a full-size screenshot. Minimized or never-shown
// windows weren't tried: Chromium throttles those by design, and the prompt
// E2E waits on rAF.
//
// Why a require proxy: electron's BrowserWindow export is a non-configurable
// getter ("Cannot redefine property"), so main.js's own
// `require("electron").BrowserWindow` can only be swapped by answering the
// require itself. The swapped-in value is a Proxy of the real class with only
// a construct trap, NOT a subclass: Electron's BrowserWindow.getAllWindows()
// leaves out instances of a JS subclass (measured: 0 windows), which broke
// both main and every harness's getAllWindows()[0]. Static reads and writes
// (a harness pinning getFocusedWindow) pass through to the real class.
//
// Known gaps: show()/focus() are made inactive/no-ops so a second-instance
// handler can't steal focus. Harnesses that need main to believe its window
// is focused pin BrowserWindow.getFocusedWindow themselves (grep
// getFocusedWindow in tools/). minimize()/restore() still run for real
// (_smoke_device_sync_dev.js tests them), so that one step may show a small
// minimized stub and restore() may activate the window.
"use strict";
const Module = require("module");
const electron = require("electron");

const OFF = -30000; // past any monitor, short of Windows' minimized-window sentinel (-32000)
const Real = electron.BrowserWindow;

const OffscreenWindow = new Proxy(Real, {
  construct(target, [o = {}, ...rest], newTarget) {
    const wantShow = o.show !== false;
    const w = Reflect.construct(target, [{
      ...o,
      x: OFF,
      y: OFF,
      show: false,
      skipTaskbar: true,
      webPreferences: { ...(o.webPreferences || {}), backgroundThrottling: false },
    }, ...rest], newTarget === OffscreenWindow ? target : newTarget);
    w.show = () => w.showInactive();
    w.focus = () => {};
    if (wantShow) w.showInactive();
    return w;
  },
});

electron.app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const proxy = new Proxy(electron, { get: (t, k) => (k === "BrowserWindow" ? OffscreenWindow : Reflect.get(t, k)) });
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "electron" ? proxy : load.call(this, request, ...rest);
};
