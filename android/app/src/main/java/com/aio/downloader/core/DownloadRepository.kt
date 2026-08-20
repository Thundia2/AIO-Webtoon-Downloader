package com.aio.downloader.core

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.util.UUID

/**
 * The process-wide download state: what is running, what is waiting, what
 * finished.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────
 * `aio_android.poll_events()` DRAINS the Python-side queue. Two callers polling
 * it would each receive a random half of the events, and both would render
 * nonsense — the notification stuck three chapters behind, the Queue screen
 * skipping every other tick. So **DownloadService is the sole poller**, it
 * feeds [applyEvent] here, and the UI only ever READS these flows. Nothing in
 * `ui/` may call poll_events.
 *
 * ── AND THE ONE CONSTRAINT IT INHERITS ─────────────────────────────────────
 * Downloads are SERIAL. aio-dl.py keeps per-run state in module-level globals
 * (`_HOST_CONCURRENCY_CAP`, `_image_prefetch_queue`, `_RATE_LIMIT_SCHEDULE`)
 * and Chaquopy runs one interpreter per process, so two concurrent runs would
 * corrupt each other's backoff and prefetch state. The queue below is how that
 * constraint becomes a feature instead of a rejection: the desktop's
 * DownloadService simply refused a second request, which on a phone reads as
 * "the button does nothing".
 *
 * An `object`, not a ViewModel: the service outlives every Activity, and this
 * state has to survive the UI being destroyed mid-download. It is deliberately
 * NOT persisted across process death — a killed process has no run to resume,
 * and aio-dl.py's own resume path (M7) owns that story.
 */
object DownloadRepository {

    private const val TAG = "AioRepo"

    /** Completed/failed/cancelled runs kept for the Queue screen's "Recent". */
    private const val HISTORY_LIMIT = 20

    private val _queue = MutableStateFlow<List<DownloadJob>>(emptyList())
    val queue: StateFlow<List<DownloadJob>> = _queue.asStateFlow()

    private val _active = MutableStateFlow<ActiveRun?>(null)
    val active: StateFlow<ActiveRun?> = _active.asStateFlow()

    private val _history = MutableStateFlow<List<FinishedRun>>(emptyList())
    val history: StateFlow<List<FinishedRun>> = _history.asStateFlow()

    /**
     * Set while the service's worker loop is alive. Guarded by [lock] together
     * with the queue so the loop cannot decide "queue empty, I'm done" in the
     * same instant an enqueue decides "a worker is already running".
     */
    private var workerActive = false
    private val lock = Any()

    // ── enqueue side (called from the UI / the intent harness) ─────────────

    /**
     * Queue [job]. Returns false if this URL is already queued or running —
     * double-tapping Start must not download the same series twice.
     */
    fun enqueue(job: DownloadJob): Boolean = synchronized(lock) {
        val alreadyQueued = _queue.value.any { it.url == job.url }
        val alreadyRunning = _active.value?.job?.url == job.url
        if (alreadyQueued || alreadyRunning) {
            Log.i(TAG, "duplicate enqueue ignored: ${job.url}")
            return false
        }
        _queue.value = _queue.value + job
        true
    }

    fun removeQueued(id: String) = synchronized(lock) {
        _queue.value = _queue.value.filterNot { it.id == id }
    }

    fun clearHistory() {
        _history.value = emptyList()
    }

    // ── worker side (called ONLY from DownloadService) ─────────────────────

    /**
     * Claim the single worker slot. Returns false when one is already running,
     * in which case the caller must NOT start a loop — the running one will
     * pick the new job up on its next iteration.
     */
    fun claimWorker(): Boolean = synchronized(lock) {
        if (workerActive) return false
        workerActive = true
        true
    }

    /**
     * Next job, or null — and null ALSO releases the worker slot, atomically.
     * Splitting those two into separate calls is what would let a job enqueued
     * between them sit in the queue forever with no worker to run it.
     */
    fun takeNextOrRelease(): DownloadJob? = synchronized(lock) {
        val next = _queue.value.firstOrNull()
        if (next == null) {
            workerActive = false
            return null
        }
        _queue.value = _queue.value.drop(1)
        next
    }

    /** Emergency release for the worker's `finally` — a crash must not wedge the queue. */
    fun releaseWorker() = synchronized(lock) { workerActive = false }

    fun beginRun(job: DownloadJob) {
        _active.value = ActiveRun(job)
    }

    /**
     * Fold one aio-dl.py `_emit` payload into [active].
     *
     * Field names come from aio-dl.py's `_emit(` calls — grep that. Two of them
     * have already cost a debugging session apiece:
     *  - `chapters_selected` carries **total**, not `count`. Reading the wrong
     *    key leaves the total at 0, which silently disables both the "x/y" text
     *    AND the determinate progress bar.
     *  - Chapter counting keys off `chapter_start`, not `chapter_saved`, because
     *    `chapter_saved` only fires for cbz/pdf — an EPUB run saves nothing per
     *    chapter and its bar would never move.
     *
     * Unknown kinds are ignored by design: aio-dl.py gains events over time and
     * an older UI must not break on one it has never seen.
     */
    fun applyEvent(e: JSONObject) {
        val run = _active.value ?: return
        val p = run.progress
        val next = when (e.optString("kind")) {
            "series" -> p.copy(title = e.optString("title").ifBlank { p.title })

            "chapters_selected" -> p.copy(total = e.optInt("total", p.total))

            "chapter_start" -> p.copy(
                chapter = e.optString("chapter").ifBlank { p.chapter },
                // `processed` counts chapters STARTED, the in-flight one
                // included — the same definition the desktop's
                // processedChapters uses, and the one the ETA was computed
                // against. A retried chapter therefore ticks twice; that is
                // correct, not a double-count.
                processed = e.optInt("processed", p.processed + 1),
                total = e.optInt("total", p.total),
                etaMs = if (e.isNull("eta_ms")) null else e.optLong("eta_ms"),
                etaSamples = e.optInt("eta_samples", p.etaSamples),
            )

            "phase" -> p.copy(phase = e.optString("phase").ifBlank { p.phase })

            "done" -> p.copy(phase = "done")

            else -> p
        }
        if (next !== p) _active.value = run.copy(progress = next)
    }

    /**
     * Retire the running job into history.
     *
     * [exitCode] 130 is `aio_android.CANCELLED_EXIT_CODE`. It WINS over a real
     * failure code, which can mask a genuine error — accepted deliberately,
     * because the per-chapter reasons still land in the skipped-chapters report
     * and the missed-chapters JSON, so no diagnosis is actually lost.
     */
    fun finishRun(exitCode: Int) {
        val run = _active.value ?: return
        val outcome = when (exitCode) {
            0 -> RunOutcome.Completed
            CANCELLED_EXIT_CODE -> RunOutcome.Cancelled
            else -> RunOutcome.Failed
        }
        val entry = FinishedRun(
            id = run.job.id,
            label = run.label,
            outcome = outcome,
            exitCode = exitCode,
            durationMs = System.currentTimeMillis() - run.startedAt,
            processed = run.progress.processed,
            total = run.progress.total,
        )
        _history.value = (listOf(entry) + _history.value).take(HISTORY_LIMIT)
        _active.value = null
    }

    /** Mirrors `aio_android.CANCELLED_EXIT_CODE`. */
    const val CANCELLED_EXIT_CODE = 130

    fun newJobId(): String = UUID.randomUUID().toString()
}
