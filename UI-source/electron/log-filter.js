// ============================================================
// LOG-FILTER MODULE (shared by downloader.js + searcher.js)
//
// Both the download subprocess and the search subprocess pipe aio-dl.py's
// stdout/stderr through the SAME line hygiene:
//   1. strip ANSI SGR escapes  (stripAnsi)
//   2. drop Playwright-teardown noise  (NOISY_LINE_RE)
//   3. color-classify the survivors  (classifyLogLevel)
// This file is the single source of truth for the first two (they were
// byte-identical copies before the 2026-07 dedup sweep) and for the shared
// spine of the third.
//
// Read by: downloader.js (Downloader._spawn stdout/stderr + tail flush) and
//          searcher.js (Searcher.runSearch stderr stream + tail flush).
// Depends on: nothing (pure string helpers, no Node built-ins).
// ============================================================

// Drop-list for stdout/stderr noise we can't usefully surface. Playwright's
// BrowserContext teardown races aio-dl.py's chapter loop and produces:
//   - "Error: write EPIPE" / Python "BrokenPipeError" / "ConnectionResetError"
//     on simple bridge closes, AND
//   - a full Node.js crash dump (15-20 lines of JS stack trace + errno
//     object + "Node.js vX.Y.Z" footer) when the PipeTransport hits a
//     write-after-shutdown on Windows (errno -4047 = libuv UV_ESHUTDOWN).
// None of this is actionable — the chapter either succeeded (download
// already finished) or will be retried by the missed-chapter pass; for the
// search subprocess the same bridge tears down on close.
//
// The pattern covers every line of the crash-dump format:
//   - EPIPE-family literal substrings (the single-line "Error: write EPIPE")
//   - JavaScript stack frames (`at Func (node:internal/...)`)
//   - Playwright driver paths / dispatcher class names (PipeTransport,
//     DispatcherConnection, BrowserContextDispatcher, CRBrowserContext)
//   - Crash markers: `Unhandled '<event>' event`, `Emitted '<event>' event`,
//     the literal `throw er;` line and its `^` caret pointer
//   - The `{ errno: ..., syscall: '...' }` object dump
//   - The trailing `Node.js vX.Y.Z` footer
//
// Non-global (no `g` flag) so `.test()` never advances lastIndex — safe to
// share one instance across both consumer modules.
const NOISY_LINE_RE = new RegExp(
  [
    // Original EPIPE-family literal substrings (still useful for the
    // single-line "Error: write EPIPE" path).
    String.raw`\b(EPIPE|BrokenPipeError|ConnectionResetError)\b`,
    // Node.js internal stack frame paths.
    String.raw`node:events:\d`,
    String.raw`node:internal\/(net|streams|process|timers|destroy)`,
    // Playwright driver internals.
    String.raw`playwright[\\/]driver`,
    String.raw`\bPipeTransport\b`,
    String.raw`\bDispatcherConnection\b`,
    String.raw`\bBrowserContextDispatcher\b`,
    String.raw`\bCRBrowserContext\b`,
    // Node crash format markers.
    String.raw`^\s*throw\s+er\b`,
    String.raw`(Unhandled|Emitted) '\w+' event`,
    String.raw`^\s*errno:\s*-?\d+`,
    String.raw`^\s*syscall:\s*['"]`,
    String.raw`^Node\.js v\d`,
    // Lone caret pointer + lone brace-dump open/close lines.
    String.raw`^\s*\^\s*$`,
    String.raw`^\s*[{}],?\s*$`,
  ].join("|"),
);

// Strip ANSI color escape sequences before testing against NOISY_LINE_RE
// (Node's Playwright driver emits SGR codes like \x1b[90m...\x1b[39m, so
// `^\s*errno:` won't match a line that's actually `\x1b[90m errno: \x1b[39m`
// without the strip first). Stripping also yields cleaner LogPanel display.
// Kept module-private: it carries the `g` flag, and only String.replace
// touches it (which resets lastIndex around every call), so it never leaks
// iteration state — but exposing only stripAnsi() keeps that guarantee.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Strip ANSI SGR escapes from a raw log line. Fast-paths the common case
 * (most lines carry no escape byte) by skipping the regex scan + string
 * allocation entirely when the literal ESC (\x1b) isn't present.
 *
 * @param {string} rawLine
 * @returns {string} the line with color escapes removed (or rawLine as-is)
 */
function stripAnsi(rawLine) {
  return rawLine.includes("\x1b") ? rawLine.replace(ANSI_RE, "") : rawLine;
}

/**
 * Classify a log line's severity for LogPanel color-coding:
 *   "error" | "warning" | "success" | "verbose" | "info"
 *
 * The error patterns are deliberately STRICT so informational retry-style
 * messages don't paint red. `/error:|FAILED/i` (an earlier rule) matched the
 * substring "failed" case-insensitively and painted hundreds of benign lines
 * red — e.g. "First variant failed, trying 9 more" — so we anchor instead:
 *   - `[!]` is aio-dl.py's genuine-error convention (anchored to trimmed start
 *     so "[!?] not really" doesn't fire).
 *   - "Traceback " is a Python crash header (unhandled exception above).
 *   - "^\w*?Error:" catches "ImportError: …" / "ValueError: …" / bare "Error: …"
 *     while the non-greedy prefix stays flexible.
 *   - "\bFAILED\b" is uppercase-word-bound (CI-style), NOT lowercase "failed".
 *
 * The success branch is the ONLY part that differs between callers — the
 * download stream and the search stream celebrate different lines — so it's
 * injected as `successRe`. Everything else (error/warning/verbose/info) is
 * shared verbatim, which keeps each caller's classification byte-for-byte
 * identical to its pre-dedup inline copy.
 *
 * @param {string} line
 * @param {RegExp} successRe - caller-specific "this line is a success" test
 * @returns {"error"|"warning"|"success"|"verbose"|"info"}
 */
function classifyLogLevel(line, successRe) {
  const trimmed = line.trim();
  // [!] is the codebase convention for genuine errors (anchored to the
  // start of the trimmed line so it doesn't fire on "[!?] not really").
  if (/^\[!\]/.test(trimmed)) return "error";
  // Python crash header — always indicates an unhandled exception above.
  if (/^Traceback /.test(trimmed)) return "error";
  // Python exception line: "ImportError: foo", "ValueError: bar", or just
  // "Error: bar". Non-greedy \w*? lets the leading prefix vary while
  // requiring "Error:" as the trailing token.
  if (/^\w*?Error:/.test(trimmed)) return "error";
  // Uppercase FAILED as a word boundary — matches CI-style "X tests FAILED"
  // but NOT "First variant failed" (lowercase). aio-dl.py doesn't emit
  // FAILED uppercase currently; this is forward-compat for tooling that does.
  if (/\bFAILED\b/.test(line)) return "error";

  if (/Warning:|warning:|⚠/i.test(line)) return "warning";
  if (successRe.test(line)) return "success";
  if (/^\s{2,}/.test(line)) return "verbose"; // Indented lines are usually verbose detail
  return "info";
}

module.exports = { NOISY_LINE_RE, stripAnsi, classifyLogLevel };
