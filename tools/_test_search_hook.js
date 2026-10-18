// Offline regression test for UI-source/src/hooks/useSearch.js: only the most
// recent search may write the Search tab's state.
// Run: node tools/_test_search_hook.js   (from the repo root)
//
// Drives the REAL hook (esbuild-bundled through tools/_hook_runtime.js)
// against a stub window.electronAPI whose runSearch answers are resolved by
// hand, in whatever order a case needs. Real timers, so the log flush ticks.
//
// Why it exists: main's Searcher cancels a running search when a new one
// starts, and the cancelled call still answers, often after the newer search
// finished. Before the guard (2026-10-18) that late "cancelled" replaced the
// newer results, which made tools/_e2e_device_sync_find.js fail about 1 run in
// 3. SearchTab's `ranFor` ref now stops the E2E's double search by itself, so
// THIS test is the only thing proving the guard. Mutation check: drop the
// `if (!isCurrent()) return null;` lines in useSearch.js and it must fail.
"use strict";
const { makeRuntime, bundleHook } = require("./_hook_runtime");

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

// Stub API: each runSearch call is held until the case settles it.
function makeApi() {
  const calls = [];
  let logCb = null;
  let cancels = 0;
  const api = {
    runSearch: (query, opts, requestId) =>
      new Promise((resolve, reject) => calls.push({ query, opts, requestId, resolve, reject })),
    cancelSearch: () => { cancels += 1; return Promise.resolve({ ok: true }); },
    onSearchLog: (cb) => { logCb = cb; return () => { logCb = null; }; },
  };
  return {
    api,
    calls,
    log: (searchId, line) => logCb && logCb({ searchId, line, level: "info" }),
    cancels: () => cancels,
  };
}
const done = (title, extra = {}) => ({ ok: true, result: { candidates: [{ canonical_title: title }], ...extra } });
const CANCELLED = { ok: false, cancelled: true, error: "Search cancelled" };

(async () => {
  const { useSearch, foldSiteHealth } = await bundleHook("hooks/useSearch.js");
  const rt = makeRuntime();
  globalThis.__hookRuntime = rt.api;
  const settingsRef = { current: { collapseSplits: true, disabledSites: ["slowsite"] } };
  const setup = () => {
    const stub = makeApi();
    globalThis.window = { electronAPI: stub.api };
    const h = rt.mount(() => useSearch({ settingsRef, flushInterval: 20 }));
    return { ...stub, h };
  };
  const titles = (st) => (st.results && st.results.candidates ? st.results.candidates.map((c) => c.canonical_title) : null);

  console.log("── a replaced search's late \"cancelled\" can't hide the newer results ──");
  {
    const { calls, h } = setup();
    const pA = h.state.runSearch("Dandadan", {});
    const pB = h.state.runSearch("Dandadan", {});
    await h.wait(20);
    eq("two calls reached main", calls.length, 2);
    calls[1].resolve(done("B"));
    await h.wait(30);
    eq("the newer search shows its results", [h.state.searchState.status, titles(h.state.searchState)], ["done", ["B"]]);
    calls[0].resolve(CANCELLED);
    await h.wait(30);
    eq("still done with B after A's cancel lands", [h.state.searchState.status, titles(h.state.searchState), h.state.searchState.error], ["done", ["B"], null]);
    eq("A answers null, B its result", [await pA, titles({ results: await pB })], [null, ["B"]]);
  }

  console.log("── a replaced search that SUCCEEDS late is ignored too (state + health) ──");
  {
    const { calls, h } = setup();
    h.state.runSearch("Old", {});
    h.state.runSearch("New", {});
    await h.wait(20);
    calls[0].resolve(done("A", { site_health: [{ site: "siteY", status: "down" }], tested_sites: ["siteY"] }));
    await h.wait(30);
    eq("while the newer one runs, the old answer changes nothing", [h.state.searchState.status, h.state.searchState.query, titles(h.state.searchState)], ["running", "New", null]);
    calls[1].resolve(done("B", { site_health: [{ site: "siteX", status: "slow" }], tested_sites: ["siteX"] }));
    await h.wait(30);
    eq("the newer search's results", [h.state.searchState.status, titles(h.state.searchState)], ["done", ["B"]]);
    eq("health folds only the current search", Object.keys(h.state.searchSiteHealth), ["siteX"]);
    eq("siteX struck once (slow)", h.state.searchSiteHealth.siteX.strikes, 1);
  }

  console.log("── a replaced search that throws is ignored ──");
  {
    const { calls, h } = setup();
    h.state.runSearch("Old", {});
    h.state.runSearch("New", {});
    await h.wait(20);
    calls[1].resolve(done("B"));
    await h.wait(30);
    calls[0].reject(new Error("IPC gone"));
    await h.wait(30);
    eq("still done with B", [h.state.searchState.status, h.state.searchState.error], ["done", null]);
  }

  console.log("── the current search's own outcomes still land ──");
  {
    const { calls, h, cancels } = setup();
    h.state.runSearch("Mine", {});
    await h.wait(20);
    await h.state.cancelSearch();
    eq("cancelSearch reached main", cancels(), 1);
    calls[0].resolve(CANCELLED);
    await h.wait(30);
    eq("cancelling the current search shows cancelled", h.state.searchState.status, "cancelled");
    h.state.runSearch("Broken", {});
    await h.wait(20);
    calls[1].resolve({ ok: false, error: "boom" });
    await h.wait(30);
    eq("a failing current search shows its error", [h.state.searchState.status, h.state.searchState.error], ["error", "boom"]);
  }

  console.log("── log lines are scoped to the current search ──");
  {
    const { calls, h, log } = setup();
    h.state.runSearch("Old", {});
    h.state.runSearch("New", {});
    await h.wait(20);
    const [a, b] = calls.map((c) => c.requestId);
    check("each call sends its own request id", typeof a === "string" && typeof b === "string" && a !== b && /^srch_r\d+_\d+$/.test(b), `${a} ${b}`);
    log(a, "old line");
    log(b, "new line 1");
    log("srch_7_1", "another searcher's line");
    log(b, "new line 2");
    await h.wait(60); // a few flushes
    eq("only the current search's lines are shown", h.state.searchLogs.map((l) => l.line), ["new line 1", "new line 2"]);
    h.state.clearSearchLogs();
    await h.wait(30);
    eq("clearSearchLogs empties the feed", h.state.searchLogs.length, 0);
  }

  console.log("── opts: settings injected, caller wins ──");
  {
    const { calls, h } = setup();
    h.state.runSearch("Q", { searchLanguage: "en" });
    h.state.runSearch("Q", { disabledSites: ["a", "b"] });
    await h.wait(20);
    eq("settings' collapseSplits + disabledSites ride along", calls[0].opts, { collapseSplits: true, disabledSites: ["slowsite"], searchLanguage: "en" });
    eq("an explicit disabledSites wins", calls[1].opts.disabledSites, ["a", "b"]);
    eq("a blank query sends nothing", [await h.state.runSearch("   "), calls.length], [null, 2]);
  }

  console.log("── foldSiteHealth ──");
  {
    const prev = { gone: { strikes: 1, lastStatus: "slow" }, kept: { strikes: 3, lastStatus: "down" } };
    const next = foldSiteHealth(prev, { site_health: [{ site: "busy1", status: "busy" }, { site: "d", status: "down" }], tested_sites: ["gone", "kept", "d"] }, 5);
    eq("down +2, busy ignored, healthy decays and drops at 0", [Object.keys(next).sort(), next.d.strikes, next.kept.strikes], [["d", "kept"], 2, 2]);
    check("a result with neither list returns prev itself", foldSiteHealth(prev, {}) === prev);
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
