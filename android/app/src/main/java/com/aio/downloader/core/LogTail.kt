package com.aio.downloader.core

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.BufferedReader
import java.io.InputStreamReader
import kotlin.concurrent.thread

/**
 * aio-dl.py's console output, made visible inside the app.
 *
 * ── WHY LOGCAT AND NOT A PYTHON HOOK ───────────────────────────────────────
 * Chaquopy already redirects the interpreter's `sys.stdout` / `sys.stderr` into
 * logcat under the tags `python.stdout` / `python.stderr`, and aio-dl.py prints
 * a great deal that never becomes a structured event — group selection, per-page
 * retries, backoff decisions, the skipped-chapters report. The structured event
 * sink carries milestones; this carries the reasoning. Reading logcat back gets
 * all of it with ZERO changes to the Python, which matters because the Python is
 * shared with the desktop.
 *
 * An app can read its OWN log entries without any permission — the log daemon
 * filters by UID — so this needs nothing in the manifest. It is also why the
 * output can never contain another app's data.
 *
 * `-T 1` means "print the most recent line, then follow", so a fresh reader
 * starts at roughly now instead of replaying whatever is still in the ring
 * buffer from previous runs. (`-t` is the dump-and-exit sibling; using it here
 * would give one snapshot and no stream.)
 *
 * Lines go through the same [sanitizeLogLine] hygiene the desktop applies, so
 * classification is identical on both platforms.
 */
object LogTail {

    private const val TAG = "AioLogTail"

    /**
     * Bounded because a long download prints tens of thousands of lines and the
     * whole list is snapshotted into Compose state on every flush. This is the
     * transcript of the last few minutes, not an archive; logcat itself still
     * has the rest for `adb logcat`.
     */
    private const val MAX_LINES = 1500

    /**
     * Flush cadence. aio-dl.py can emit hundreds of lines a second while pages
     * are downloading, and recomposing a lazy list per line would peg a core for
     * output nobody can read at that rate.
     */
    private const val FLUSH_MS = 220L

    private val _lines = MutableStateFlow<List<LogLine>>(emptyList())
    val lines: StateFlow<List<LogLine>> = _lines.asStateFlow()

    /** Non-null while the reader is up; surfaces "logs unavailable" in the UI. */
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var reader: Thread? = null
    private var process: Process? = null
    private var nextId = 0L

    // Written by the reader thread, read by it alone; the snapshot is what
    // crosses to the UI.
    private val buffer = ArrayDeque<LogLine>()

    @Synchronized
    fun start() {
        if (reader?.isAlive == true) return
        reader = thread(name = "aio-logtail", isDaemon = true) { run() }
    }

    @Synchronized
    fun stop() {
        runCatching { process?.destroy() }
        process = null
        reader = null
    }

    @Synchronized
    fun clear() {
        buffer.clear()
        _lines.value = emptyList()
    }

    private fun run() {
        val command = listOf(
            "logcat",
            "-v", "raw",
            "-T", "1",
            // Silent default, then the tags worth showing. Chaquopy's two are
            // the download itself; AioService is the run/cancel/exit lifecycle,
            // which is exactly the context that makes the Python output
            // readable ("run_download_json […]" then the output it produced).
            "-s",
            "python.stdout:V", "python.stderr:V", "AioService:V",
        )
        try {
            val proc = ProcessBuilder(command).redirectErrorStream(true).start()
            process = proc
            _error.value = null

            var lastFlush = System.currentTimeMillis()
            var dirty = false

            BufferedReader(InputStreamReader(proc.inputStream)).use { input ->
                while (true) {
                    val raw = input.readLine() ?: break
                    val sanitized = sanitizeLogLine(raw)
                    if (sanitized != null) {
                        val (text, level) = sanitized
                        buffer.addLast(LogLine(nextId++, text, level))
                        while (buffer.size > MAX_LINES) buffer.removeFirst()
                        dirty = true
                    }
                    val now = System.currentTimeMillis()
                    if (dirty && now - lastFlush >= FLUSH_MS) {
                        _lines.value = buffer.toList()
                        lastFlush = now
                        dirty = false
                    }
                }
            }
            if (dirty) _lines.value = buffer.toList()
        } catch (t: Throwable) {
            // Never fatal: the Logs screen is a convenience, and every line here
            // is also in `adb logcat`. Surface it in the UI rather than dying.
            Log.w(TAG, "log tail stopped", t)
            _error.value = t.message ?: t.javaClass.simpleName
        }
    }
}
