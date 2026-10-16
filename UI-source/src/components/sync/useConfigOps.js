// ============================================================
// useConfigOps — the renderer's one client for sync:config-op
//
// Every Device Sync config edit (TargetEditor, the adb section, the draft add
// card) goes through run(). Two rules make immediate-persist safe:
//   * ops are SERIALIZED: one in flight, the rest queued in call order;
//   * each op sends the newest config version this client knows — the max of
//     the hook's pushed `config.version` and the version the previous op's
//     answer returned. Without the second, a name blur followed by a click
//     sends the second op before the first op's `config` event lands, and
//     main refuses it `version-conflict` though nothing else changed.
// A genuine conflict (another window, a stale screen) still refuses; the
// caller shows copy.js configRefusalCopy and the hook's next config event
// re-renders the current values.
//
// Consumers: TargetEditor.jsx, SyncSettings.jsx. Depends on: useDeviceSync's
// actions.configOp and config (App.jsx passes the hook down as `sync`).
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

export function useConfigOps(sync) {
  const versionRef = useRef(0);
  const chainRef = useRef(Promise.resolve());
  const [pending, setPending] = useState(0);
  const hookVersion = sync && sync.config ? sync.config.version : 0;
  useEffect(() => {
    if (hookVersion > versionRef.current) versionRef.current = hookVersion;
  }, [hookVersion]);

  const run = useCallback(
    (op, payload) => {
      setPending((n) => n + 1);
      const next = chainRef.current.then(async () => {
        if (hookVersion > versionRef.current) versionRef.current = hookVersion;
        let r;
        try {
          r = await sync.actions.configOp({ op, ...(payload || {}), expectVersion: versionRef.current });
        } catch (e) {
          r = { ok: false, code: "invalid", message: (e && e.message) || "the request failed" };
        }
        const v = r && r.config && r.config.version;
        if (typeof v === "number" && v > versionRef.current) versionRef.current = v;
        return r || { ok: false, code: "invalid", message: "no answer" };
      });
      chainRef.current = next.catch(() => {});
      return next.finally(() => setPending((n) => n - 1));
    },
    // sync.actions is stable for the hook's lifetime; hookVersion only seeds.
    [sync, hookVersion],
  );

  return { run, pending: pending > 0 };
}

/** The field a refusal is about (validateTarget errors[0].field), else null. */
export function refusalField(r) {
  return r && Array.isArray(r.errors) && r.errors[0] ? r.errors[0].field : null;
}
