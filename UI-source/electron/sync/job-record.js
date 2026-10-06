// ============================================================
// DEVICE SYNC — JOB RECORD (main-process, canonical)
//
// Owns the one sync job lane (parent rule 9): which job is live, its
// progress, and the queue of automatic connect-plans waiting behind it
// (deviation 5). service.js drives it; sync:get-state serves its snapshot so
// a reloaded renderer re-adopts a running job.
//
// Shaped like update-check-record.js, with the same two invariants:
//   1. ONE live job. begin() refuses while one runs (the `busy` refusal,
//      carrying the snapshot, like the Check All re-entrancy guard).
//   2. Every emission carries its runId and is DROPPED when it belongs to a
//      superseded run, so a cancelled job's late progress can't land in the
//      next job.
// Progress is coalesced: the latest progress wins and at most one progress
// event goes out per COALESCE_MS (≤10/s). begin and finish go out at once and
// replace any progress still waiting, since their event carries the whole job.
//
// AUTO-PLAN QUEUE: a connect while busy queues one plan per target (FIFO,
// one entry per target). A user-started job while busy is refused instead.
// A queued plan is dropped when its device disconnects (dropDevice).
//
// NOT PERSISTED: a job dies with the process; the record files under
// userData/sync are what survives it.
//
// `send(channel, payload)` and the timers are injected so this runs under
// plain node in tools/_test_device_sync_core.js.
// ============================================================

const { EVENT_CHANNEL, JOB_PHASES, JOB_STATUSES, QUIT_ASK_PHASES, refuse } = require("./contract");

const COALESCE_MS = 100;

/**
 * @param {object} deps
 * @param {(channel:string, payload:object) => void} deps.send
 * @param {() => number} [deps.now]
 * @param {{setTimeout:Function, clearTimeout:Function}} [deps.timers]
 */
function createJobRecord(deps) {
  const send = deps.send;
  const now = deps.now || Date.now;
  const timers = deps.timers || { setTimeout, clearTimeout };
  let job = null;
  let seq = 0;
  let pending = null;
  let timer = null;
  let lastProgressAt = -Infinity;
  const queue = [];

  function _view() {
    if (!job) return null;
    return {
      runId: job.runId,
      phase: job.phase,
      targetId: job.targetId,
      serial: job.serial,
      auto: job.auto,
      state: job.state,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: { ...job.progress },
      status: job.status,
      summary: job.summary,
    };
  }

  function _emit(payload) {
    send(EVENT_CHANNEL, { kind: "job", ...payload });
  }

  function _flush() {
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const p = pending;
    pending = null;
    lastProgressAt = now();
    _emit(p);
  }

  return {
    isBusy() {
      return !!job && job.state === "running";
    },

    /** True while a job runs whose phase the close listener must ask about. */
    needsQuitAsk() {
      return !!job && job.state === "running" && QUIT_ASK_PHASES.has(job.phase);
    },

    runId() {
      return job ? job.runId : 0;
    },

    snapshot() {
      return { job: _view(), queue: queue.map((q) => ({ ...q })) };
    },

    /**
     * Open a job. Returns {ok:true, runId} or the `busy` refusal.
     * @param {{phase:string, targetId:string, serial?:string, auto?:boolean, total?:object}} spec
     */
    begin(spec) {
      if (!spec || !JOB_PHASES.includes(spec.phase)) throw new Error(`unknown sync job phase: ${spec && spec.phase}`);
      if (this.isBusy()) {
        return refuse("busy", "another sync job is running", { job: _view() });
      }
      _flush();
      seq += 1;
      job = {
        runId: seq,
        phase: spec.phase,
        targetId: spec.targetId || null,
        serial: spec.serial || null,
        auto: !!spec.auto,
        state: "running",
        startedAt: now(),
        finishedAt: null,
        progress: { bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, current: null, ...(spec.total || {}) },
        status: null,
        summary: null,
      };
      lastProgressAt = -Infinity;
      _emit({ runId: job.runId, state: "running", job: _view() });
      return { ok: true, runId: job.runId };
    },

    /**
     * Fold progress into the live job; coalesced to ≤1 event per
     * COALESCE_MS. Returns false (and drops it) for a stale runId.
     */
    progress(runId, patch) {
      if (!job || job.runId !== runId || job.state !== "running") return false;
      Object.assign(job.progress, patch || {});
      pending = { runId, state: "running", progress: { ...job.progress } };
      const wait = COALESCE_MS - (now() - lastProgressAt);
      if (wait <= 0) _flush();
      else if (!timer) timer = timers.setTimeout(_flush, wait);
      return true;
    },

    /** Close the live job with a final status. False for a stale runId. */
    finish(runId, result) {
      if (!job || job.runId !== runId || job.state !== "running") return false;
      const status = result && result.status;
      if (!JOB_STATUSES.includes(status)) throw new Error(`unknown sync job status: ${status}`);
      pending = null;
      _flush();
      job.state = "done";
      job.status = status;
      job.summary = (result && result.summary) || null;
      job.finishedAt = now();
      _emit({ runId, state: "done", status, summary: job.summary, job: _view() });
      return true;
    },

    /**
     * Queue an automatic plan for a target (deviation 5). One entry per
     * target; a second connect for a queued target is a no-op.
     * @returns {boolean} true when queued.
     */
    enqueueAuto({ targetId, serial }) {
      if (!targetId || queue.some((q) => q.targetId === targetId)) return false;
      queue.push({ targetId, serial: serial || null, queuedAt: now() });
      return true;
    },

    /** A device left: drop its queued plans. Returns how many were dropped. */
    dropDevice(serial) {
      let n = 0;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i].serial === serial) {
          queue.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },

    dropTarget(targetId) {
      const i = queue.findIndex((q) => q.targetId === targetId);
      if (i === -1) return false;
      queue.splice(i, 1);
      return true;
    },

    /** The next queued plan, FIFO, or null while busy or empty. */
    takeNextAuto() {
      if (this.isBusy() || !queue.length) return null;
      return queue.shift();
    },
  };
}

module.exports = { createJobRecord, COALESCE_MS };
