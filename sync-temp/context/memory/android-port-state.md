---
name: android-port-state
description: "Android/Chaquopy port — current phase, the pinned toolchain and why, the settled native-wheel answer, and the rapidfuzz decision"
metadata:
  node_type: memory
  type: project
  originSessionId: f564c22c-eb53-4d8c-9e51-512ad58b5468
  modified: 2026-08-13T11:55:48.356Z
---

Porting the downloader to Android (Chaquopy embeds CPython; native Jetpack
Compose UI planned). **Desktop stays fully featured — the port is additive and
nothing under `android/` is imported by desktop code.** Plan file with all
milestones: `~/.claude/plans/i-want-to-port-parallel-simon.md`.

**Phase as of 2026-08-12:** M0–M6 **COMPLETE and verified on real hardware**
(tablet `9469X`, Android 15 / API 35, arm64-v8a) — on-device registry 303/42
identical to desktop, real MangaDex **and MangaFire** chapters downloaded to valid
CBZs, a **Compose UI (Library / Search / New / Queue / Logs)** over the foreground
service, a **WebView `BrowserBackend`** behind `sites/browser_backend.py` (Kotlin
`browser/WebViewBridge.kt`), a **library browser** (cover grid, facet filtering,
per-series + whole-library update checks, delete), and **cross-site search**
(19 series for "frieren" across 297 sites, the source comparison, the handoff to
New, and the shared-engine refusal all confirmed on hardware).

**M7 is COMPLETE and device-verified** — Settings (a top-bar destination, not a
sixth tab; Diagnostics moved inside it), resume over the `tmp_*` folders, the
embedded-metadata editor, and the `MANAGE_EXTERNAL_STORAGE` library-path opt-in.
921 desktop pytest / 119 JVM / full CLAUDE.md suite green. **8d (granting the
shared-folder permission and moving the library root) was deliberately NOT run
— it is the user's call.** **Next: M8 (packaging/CI).**

**A COOPERATIVE CANCEL WALKS THROUGH END-OF-RUN LOGIC THAT ASSUMES THE RUN
FINISHED. This is the Android-only hazard class to check first whenever cancel
behaves oddly.** Desktop cancels by KILLING the process, so `main()` never
reaches its tail; Android flips `_RUN_CANCEL` and the run returns NORMALLY,
executing everything after the chapter loop. Consequence (a), now fixed: the
tail did `rm_tree(main_tmp_dir)` unless `--no-cleanup`, so every cancelled
download **deleted its own resume data** — guarded on `run_cancelled()`
(Android-only in effect: `request_run_cancel` has exactly one caller,
`aio_android.cancel`).

**The archive-overwrite hazard is STILL OPEN and is CROSS-PLATFORM, not
Android-only** (2026-08-13 audit corrected the earlier framing). `aio-dl.py`'s
final-file gate has no `run_cancelled()` term, so a partial run rebuilds the
book from whatever finished and writes it over the complete archive at the same
path. Two doors, not one: Android's cooperative cancel, AND — on **both**
platforms — a library-update run, which passes only the missing chapter range.
The floor is **one page, not one chapter** (CBZ seeds the content list with the
cover, so the guard is true with zero chapters), and `.aio_series.json` writes
`chapters_downloaded` as a UNION, so the file still claims the full list and the
update check never offers repair — the loss is self-concealing. `--komikku`,
`--format none` and manual `--no-final-file` are immune. Traced line by line but
NEVER EXECUTED end to end; that test is the first thing to run here.

**Two more standing platform facts found by the same audit:** the
`--webtoon-recompress` toggle is EXPOSED in the Android UI with no WebP encoder
behind it (silent no-op on the default path — and unfixably invisible, because
Android deliberately never emits `--verbose`, which is the only channel the
warning uses; hard chapter failure when combined with the quality/scaling
sliders). And `diagnostics()` probes module IMPORTABILITY only, never codec
registration, so it reports `pillow: true` and is structurally blind to that
whole class of gap.

**comix is NOT the only site that cannot work here — that claim was wrong.**
comix does drive its own Patchright session (`_comix_worker_loop`) and never
reaches the seam. But the **Cloudflare rescue is also dead for all 244 Madara
handlers**: `sites/madara.py:757` gates it on `ZENDRIVER_AVAILABLE` (false here)
inside `except Exception: pass`, and the sibling branch that WOULD reach the
WebView is dead code because **0 of 244 handlers set `use_zendriver`**
(live-verified). Fails silently — the challenge page is parsed as the page, and
the user sees "No chapters selected." or a 503 retry storm, neither naming
Cloudflare. `sites/manhwaread.py:111` repeats it. MangaFire, violetscans,
likemanga and kappabeast genuinely do work. **`android/README.md` asserts the
opposite of all this in several places — treat that file as a claim under test,
not as evidence.**

**The full desktop-vs-Android inventory now lives in `android/PARITY.md`**
(9 ranked defects, coverage across 303 handlers / 91 settings / 101 flags / 35
IPC channels, the deliberate omissions with their rationale, and 13 doc-vs-code
errors). Read it before claiming any feature "works on Android".
**On-device test recipes live in `android/TESTING.md` — point testing agents at
that file rather than re-deriving commands.**

**Deviations from the plan, all deliberate and all still standing:**
(1) the CLI arg builder, the **ETA estimator**, and the **resource-limit
resolver** are all in **Python** (`aio_android`) rather than Kotlin. Arg-builder
guards are load-bearing (aio-dl.py hard-errors on bad flag combinations); the
ETA must be measured at the EMIT site because DownloadService polls on a 700ms
timer and batching would merge two chapters into one sample; and Python gets
offline pytest coverage with no device in the loop
(`tests/test_android_argv.py`, `test_android_progress.py`,
`test_android_resource_limits.py`). Kotlin only collects UI state into JSON.
(1b) settings persist to **SharedPreferences, not DataStore** (M7): every
consumer needs a SYNCHRONOUS read from a non-composable context (the service's
worker thread, the intent harness, `queueLibraryUpdate`), and DataStore's only
sync read is `runBlocking` — on the main thread, the ANR it exists to prevent.
Collecting a Flow instead leaves a startup window where a job silently runs with
the settings ignored.
(2) the service runs **in the main process, not `android:process=":py"`** —
Chaquopy's interpreter is per-process, so a separate process means a second
interpreter and two disjoint copies of aio-dl.py's module globals.
(3) `START_NOT_STICKY` — silently restarting a large download on mobile data
after an OOM kill is hostile, and the partial run is resumable.
(4) **no Material You dynamic color**, though the plan called for it: it derives
the palette from the wallpaper and would replace the blue that carries the
product's identity. The UI conforms to the desktop's tokens instead
(`ui/theme/Color.kt` is a straight HSL→RGB port of `globals.css`).
(5) **fonts are the platform faces, not DM Sans / JetBrains Mono.** Downloadable
Google Fonts need Play Services AND a certs resource array and fall back
silently; bundling TTFs means vendoring ~800 KB plus an OFL license. The type
SCALE in `ui/theme/Type.kt` carries the design language, and swapping in real
faces is a two-constant change there.

**UI architecture invariant: `aio_android.poll_events()` DRAINS the Python event
queue, so `DownloadService` is its SOLE caller.** It folds events into
`core/DownloadRepository.kt` (StateFlows); the UI only reads. A second poller
would take a random half of the events and both consumers would render nonsense.
That repository also owns a **serial queue** — the one-run-at-a-time constraint
used to be enforced by REFUSING a second request, which on a phone reads as a
button that does nothing.

**Engine invariant (M5): every caller of aio-dl.py's `main()` must hold
`aio_android._ENGINE_LOCK`.** Desktop never needed one — a run is its own OS
process — but Android shares ONE interpreter between the download service and the
library's update checks, and `run_download` CLEARS `_RUN_CANCEL` on entry. So an
unserialized `--list-chapters` started while a download was being cancelled would
UN-CANCEL it. The lock is an RLock (`check_series_updates` → `list_chapters`
re-enters it); the download path blocks on it, a library check try-acquires and
returns `{"error": "engine_busy"}` instead. This is also why a whole-library sweep
is serial where the desktop runs a 4-slot pool.

**Testing trap that already cost one wrong diagnosis:** `python.stdout` is EMPTY
during an update check *by design* — `list_chapters` wraps the run in
`redirect_stdout` so an 800-chapter payload can't bury the log. Do not read that
silence as "the check never ran". Use `python.stderr` (not redirected) or open the
series and look for a pre-populated result panel + a **Check again** button.

**The library root can MOVE, and moving it is a restart** (M7). Default is
app-scoped external storage (no permission); a user-chosen path needs
`MANAGE_EXTERNAL_STORAGE`, which is the only way Komikku/Mihon can read the
library at all. SAF stays rejected — `content://` URIs cannot be `open()`ed.
`configure()` is once per process (it sets CWD + env, and aio-dl.py bakes
constants in at import), so a path change applies on the NEXT app start; the UI
says so. `probe_library_root` decides usability by WRITING a probe file, because
a granted permission and a writable directory are different questions under
scoped storage; `Aio.resolveLibraryDir` falls back to the app's own folder when a
configured path fails, since throwing out of `Aio.module()` takes every screen
down, not just the library.

**The library's series folder is Komikku/Mihon's folder, so nothing may write into
it.** `library_state.find_cover_path` CAN extract an archive cover but only via
`write_cache=True`, which drops a `.cover.*` there; `aio_android.library_cover`
redirects that write to `<cacheDir>/covers` instead. Covers come from four places
and only one is a plain file: root `cover.jpg` (`--komikku` writes it), a raw
`Chapter_N/` first page, an archive member (Python), or PDF page 1 (Kotlin
`CoverStore` + `PdfRenderer` — there is no PDF rasterizer in the Python dep set).

**Browser-backend rules that are counter-intuitive and were each needed:**
(a) **one WebView PER PROFILE** (`bridge.forProfile(name)`), because MangaFire
bootstraps `window.__aioMfSign` into a live page and keeps it for the run, so an
unrelated navigation on a shared WebView wipes it — intermittently. Cookies stay
shared anyway (`CookieManager` is process-global), which is what makes one solved
challenge count everywhere. (b) **`evaluateJavascript` does NOT await promises**;
without the wrapper an async signer returns `{}` and every token reads as null,
which presents as a broken site. (c) **never read the UA from
`navigator.userAgent`** — an override makes the page report it straight back, so
a wrong value is self-consistent forever; use `settings.userAgentString` and set
no override. (d) **the vrf disk cache cannot skip the browser boot**: `_cached()`
needs `_namespace`, which is a hash of the signer chunk URL, knowable only by
loading the page. ~800ms once per process; tokens themselves do come from disk.

**Compose gotcha that cost a device round-trip:** `LocalContentColor` defaults to
**BLACK**, and `MaterialTheme` does not change that — only a `Surface` publishes a
contentColor. Without one at the theme root, every `Text` that does not name a
colour renders near-black: invisible in dark mode, and completely unnoticeable in
light mode while you develop. `AioTheme` wraps its content in a `Surface` for
exactly this reason.
**Second one:** `AnimatedVisibility` inside a `Box` nested in a `Column` resolves
to the `ColumnScope` overload and fails to compile ("cannot be called in this
context with an implicit receiver"). Fix is to extract the Box into its own
composable, which takes the outer ColumnScope out of the resolution set.
**Third, and the nastiest:** `fillMaxHeight()` is a NO-OP under the infinite
height constraint of a `verticalScroll` Column but EXPANDS TO FILL in an ordinary
one — so a component that looks correct everywhere it is currently used can
silently swallow a whole screen the first time it is placed in a non-scrolling
parent. Pin such a component with `Modifier.height(IntrinsicSize.Min)`. Worth
recognizing because of the symptom: it starved a sibling **WebView to zero
height**, and a 0px WebView takes its window's rendering down with it — the
entire Activity renders PURE BLACK with no exception, no Chromium error, and a
perfectly correct semantics tree. `adb shell uiautomator dump` vs `screencap` is
what separates "layout is wrong" from "drawing is wrong"; a Kotlin syntax error
can also hide here, since **Kotlin block comments NEST** and a literal `/`+`*`
inside a KDoc comments out the rest of the file, reported at EOF.

**Compose gotcha #4, from M5:** `rememberInfiniteTransition` must NOT be created
in a branch that a boolean flips between recompositions in the same call
position — but calling it inside a plain `if (x) A() else B()` where A and B are
distinct composables IS fine (each branch gets its own group). The wrong shape is
an always-running transition per widget, which pins the screen in a permanent
recomposition loop; the right shape is a small composable that only exists while
the animation should.

**The preset tables now exist in THREE places** — `UI-source/electron/
resource-limits.js` (source of truth), its renderer mirror `UI-source/src/lib/
resourceLimits.js`, and `aio_android`. `tests/test_android_resource_limits.py`
parses both JS files and asserts equality, so drift fails a test instead of
silently throttling Android at stale numbers.

**Chaquopy's Pillow has NO WebP decoder** (`PIL/_webp.so` is absent, and 11.0.0
is the only Pillow they publish, so there is nothing to bump to). Downloads are
unaffected — the default CBZ path is raw byte passthrough and never decodes a
page. What degrades is IMAGE-QUALITY PROBING for WebP-serving sites: their
samples cannot be decoded, the rating falls back to cover/seed, and the UI's
"rating not measured" triangle correctly flags it (measured live: atsumaru
`Quality 0%` WITH a triangle, vs mangafire 88% / weebcentral 86% / mangapill 81%
probing for real with none). The lossy transform paths (`--webtoon-recompress`,
EPUB/PDF, `--width`, `--quality<100`) would fail on WebP sources; none are wired
into the app yet.

**The riskiest assumption is settled: every native wheel exists.** Chaquopy's
index (`https://chaquo.com/pypi-13.1/<name>/`) serves cp313/`android_24` builds
of Pillow 11.0.0, numpy 1.26.2, lxml 5.3.0, cryptography 42.0.8. They are
**pinned exactly** in `android/app/build.gradle.kts` — unpinned, pip prefers
PyPI's newer release, finds no Android wheel, falls back to the sdist and fails
to compile.

**`rapidfuzz` was the one gap; RESOLVED at M6 (2026-08-12) — but NOT by the
native wheel the earlier decision named.** rapidfuzz ships its own pure-Python
backend and imports it automatically when no compiled extension exists, and its
build system EMITS that by default (`wheel.cmake = false`, upstream's message:
"CMake unavailable, falling back to pure Python Extension"). So
`android/wheels/rapidfuzz-3.14.5-py3-none-any.whl` (64 KB, built from the
official sdist, `.py` files byte-identical to a desktop install) is **the same
library, not a substitute matcher** — the substitution ban still holds, it just
never applied to rapidfuzz's own reference backend. No NDK, no per-ABI binary,
and `py3-none-any` survives a Chaquopy Python bump. Native was measured, not
dismissed: 16x faster = **4.9 ms vs 79 ms** per search-and-enrich (~1950 scorer
calls), against 60+ s of network. Recipe kept in `android/wheels/README.md`.

**The backends are NOT bit-identical, and that is now a DESKTOP-affecting
invariant** — full detail in the repo CLAUDE.md ("Every fuzzy score ... goes
through `sites/fuzzy_match.py`"). Short version: an exhaustive sweep of all
1,114,112 codepoints found (a) **3 separator codepoints** — `_` (Python regex
`\W` counts it a word char), U+0085 and U+00A0 (`str.split()` splits Unicode
whitespace, the C++ tokenizer only ASCII) — which `fuzzy_match` normalizes, and
(b) **5536 Unicode-skew codepoints** (mostly CJK extensions) from rapidfuzz's
C++ tables predating Python 3.13's Unicode database, knowingly left alone at
<=4.35 points. U+00A0 is the reachable one: scraped HTML titles carry `&nbsp;`.
Device parity is checkable — `diagnostics()` reports `rapidfuzz_backend`
("python" on device) and a `rapidfuzz_fingerprint` that must equal desktop's
`python -c "import aio_android; print(aio_android._match_fingerprint())"`.

**Toolchain pins come from Chaquopy 17.0's compatibility table** (Python
3.10–3.14, AGP 7.3–9.3, minSdk 24), not convention: Chaquopy 17.0.0, Python
3.13, **AGP 8.13.2 deliberately not the newest** (9.3.1 is the exact top of the
range and AGP 9 is a breaking major), Gradle 8.14.5, Kotlin 2.2.21, compileSdk
36, minSdk 26, ABIs arm64-v8a + x86_64. Full reasoning: `android/README.md`.

**Build environment gotcha that will recur:** this machine's `JAVA_HOME` points
at JDK 18 and `PATH` java is JDK 23, but AGP 8.13 needs **JDK 17–21**. Set it
per-invocation rather than changing the environment:
`JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug`
(Studio's bundled runtime is 21).

**This network's DNS resolver drops manga hosts INTERMITTENTLY, on both the PC
and the tablet.** On the PC `api.mangadex.org` and `dynasty-scans.com` fail to
resolve while `mangadex.org` and `google.com` succeed. The tablet usually
resolves all four but has died mid-download with `NameResolutionError ... [Errno
7] No address associated with hostname`, then resolved fine two minutes later.
**A mid-run resolution failure is an environment flake — re-run before
investigating.** Desktop-side workaround (do NOT edit DNS or hosts):
`curl.exe -s -g --resolve api.mangadex.org:443:45.129.229.2 "<url>"` (`-g` is
required or curl reads `[]` in the query as a glob and exits 3).

**Tried and killed:** wiring the Python-staging task via `preBuild.dependsOn`.
Chaquopy's tasks read the staged dir directly and are NOT downstream of that
anchor, so Gradle fails validation ("`mergeDebugPythonSources` uses this output
of `stagePythonSources` without declaring a dependency"). The working form
matches every task whose name contains `Python`.

**JNI gotcha that will recur:** a `java.util.List` does NOT cross into Python as
an iterable — Chaquopy wraps it as an opaque proxy and any `for x in argv` dies
with `TypeError: 'ArrayList' object is not iterable`. Java *arrays* convert;
`List` does not. So Kotlin calls `aio_android.run_download_json(argvJson)`, not
`run_download(list)`. Same rule for anything structured: it crosses as a JSON
string. Verified on device, not guessed.

Related: [[comix-failure-modes]], [[mangafire-vrf-returned]] — MangaFire's signer
now runs in the WebView backend; comix stays out because it never went through
the seam.
