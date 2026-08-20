import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    // Since Kotlin 2.0 the Compose compiler ships WITH the Kotlin plugin and is
    // applied separately. Omitting it fails with "compose compiler plugin not
    // found"; pinning it to a different version than kotlin-android is the
    // classic Compose build break, which is why both use the same version.ref.
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.chaquopy)
}

// ---------------------------------------------------------------------------
// PYTHON SOURCE STAGING
//
// The downloader's Python lives at the REPO ROOT (../..), not inside android/.
// Chaquopy only reads source dirs it owns, so we mirror the shipping subset
// into build/generated/python and point Chaquopy's `main` source set there.
//
// This is the Android analogue of UI-source/scripts/prepare-src.js — when a new
// root-level module appears, BOTH lists need it. grep: ROOT_PYTHON_MODULES.
//
// WHY AN INCLUDE-LIST, NOT AN EXCLUDE-LIST: the repo root also holds one-off
// dev/debug scripts (investigate_comix.py, probe_mangafire_vrf.py,
// calibrate_quality_probe.py, _diag_*.py ...). An exclude-list would ship them
// the moment someone adds another one. An include-list fails closed.
// ---------------------------------------------------------------------------
val repoRoot: File = rootProject.projectDir.parentFile

// Deliberately omitted, each for a reason:
//   api.py             - FastAPI REST server; the Android app calls Python in-process.
//   gui.py             - tkinter desktop GUI.
//   metadata_dialog.py - tkinter dialog, pulled in only by gui.py.
//   requirements.txt   - the Android dependency set is the `pip` block below,
//                        not the desktop list (see README "Dependency triage").
val ROOT_PYTHON_MODULES = listOf(
    "aio-dl.py",          // the engine; imported via importlib (the dash is not an identifier)
    "aio_android.py",     // Chaquopy entry point — what Kotlin actually calls
    "aio_search_cli.py",
    "aio_config.py",
    "library_state.py",
    "metadata_editor.py",
    "metadata_cli.py",
    "migrate_library.py",
)

val stagedPythonDir: File = layout.buildDirectory.dir("generated/python").get().asFile

// Wheels we ship ourselves because no index serves them for Android. See
// android/wheels/README.md for what each one is and how to regenerate it.
val vendoredWheelsDir: File = File(rootProject.projectDir, "wheels")

fun vendoredWheel(name: String): String {
    val f = File(vendoredWheelsDir, name)
    // Same fail-at-configuration-time rule as the Python staging above: a
    // missing wheel here would otherwise surface on device as an ImportError
    // in search, long after the build "succeeded".
    require(f.isFile) { "Vendored wheel not found: $f" }
    return f.absolutePath
}

val stagePythonSources by tasks.registering(Sync::class) {
    description = "Mirror the downloader's Python sources into the Chaquopy source set."
    group = "build"

    ROOT_PYTHON_MODULES.forEach { name ->
        val f = File(repoRoot, name)
        // Fail at configuration time, not with a mystifying ImportError on the
        // device three minutes into a build. `from(missingFile)` is silently a
        // no-op, which is exactly the failure mode worth spending a check on.
        require(f.isFile) { "Expected Python module not found: $f" }
        from(f)
    }

    from(File(repoRoot, "sites")) {
        into("sites")
        // sites/ carries two DATA files besides the handlers —
        // quality_seed.json (read by the comix image-quality probe) and
        // official_publishers.json (metadata layer). A "*.py"-only filter drops
        // them silently and the failure surfaces much later as a bad rating.
        include("**/*.py", "**/*.json")
        exclude("**/__pycache__/**")
    }

    into(stagedPythonDir)
}

android {
    namespace = "com.aio.downloader"
    compileSdk = 36

    defaultConfig {
        // One-line change point if this ever needs a real publisher identity.
        applicationId = "com.aio.downloader"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-m0"

        ndk {
            // Chaquopy's Python 3.12+ builds are 64-bit ONLY (armeabi-v7a and
            // x86 exist for 3.11 and older). arm64-v8a is real devices;
            // x86_64 is the emulator and can be dropped to halve the APK.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildFeatures {
        compose = true
    }

    buildTypes {
        release {
            // Left off for now: R8 has no visibility into the reflective
            // Java<->Python calls Chaquopy makes, so enabling it needs a
            // keep-rule pass that is not worth doing before the app has a UI.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    // The BOM aligns every compose-* artifact below; none of them carry their
    // own version. platform() is required — a plain implementation() of a BOM
    // silently does nothing.
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)

    // Debug-only: ui-tooling pulls in the whole preview/inspection runtime and
    // has no business in a release APK.
    debugImplementation(libs.androidx.compose.ui.tooling)

    // core/LogFilter.kt is pure Kotlin with no Android imports precisely so its
    // port of UI-source/electron/log-filter.js can be tested with no device in
    // the loop. `gradlew :app:testDebugUnitTest` runs them.
    testImplementation(libs.junit)
    // The android.jar used for unit tests stubs org.json so every method throws
    // ("not mocked"). core/LibraryModels.kt is ALL JSONObject parsing, and that
    // parsing is where a wrong key silently produces an empty library rather
    // than an error — so the real implementation goes on the test classpath
    // instead of the alternative, which is testing it only on a device.
    testImplementation(libs.json)
}

chaquopy {
    defaultConfig {
        // Matches the desktop interpreter (3.13.x), so behaviour differences
        // between "works on my machine" and "works on the phone" can't come
        // from a Python version gap. Chaquopy auto-detects buildPython on
        // Windows via `py -3.13`; set buildPython(...) here only if that fails.
        version = "3.13"

        pip {
            // ---- Native packages -------------------------------------------
            // PINNED to exactly what Chaquopy's Android wheel index publishes
            // for cp313/arm64-v8a. Unpinned, pip would prefer PyPI's newer
            // releases, find no Android wheel, fall back to the sdist, and fail
            // to compile it. Verify a bump at https://chaquo.com/pypi-13.1/<name>/
            install("Pillow==11.0.0")        // hard dep: aio-dl.py + sites/mangareader.py import at module scope
            install("numpy==1.26.2")         // image-quality scoring (search_orchestrator)
            install("lxml==5.3.0")           // BeautifulSoup's fast parser
            install("cryptography==42.0.8")  // kagane / mangago / mangareader

            // ---- Pure Python, straight from PyPI ---------------------------
            install("requests")
            install("beautifulsoup4")
            install("cloudscraper")
            install("pypdf")

            // ---- Vendored, because no index serves it for Android ----------
            // rapidfuzz gates cross-site search AND AniList enrichment (both
            // lazy-import it, so downloads work without it). Chaquopy's index
            // has no rapidfuzz and PyPI ships no platform-independent wheel,
            // so android/wheels/ carries rapidfuzz's OWN pure-Python build,
            // made from the official sdist via upstream's supported
            // wheel.cmake=false path. Not a substitute matcher — same library,
            // same version, same scorers, and its .py files are byte-identical
            // to a desktop install.
            //
            // A local path rather than install("rapidfuzz==3.14.5"): from an
            // sdist, pip's output depends on whether the BUILD machine happens
            // to have cmake, and with cmake it would produce a host-native
            // extension that has no business in an APK. The vendored file is
            // the same artifact on every machine.
            //
            // The two rapidfuzz backends are not bit-identical; sites/
            // fuzzy_match.py normalizes the difference and
            // tests/test_fuzzy_match.py pins it. Read that header before
            // touching this.
            install(vendoredWheel("rapidfuzz-3.14.5-py3-none-any.whl"))

            // NOT INSTALLED, and why (all degrade through an existing
            // capability flag — see README "Dependency triage"):
            //   curl_cffi / impit  - fast-download fast paths; base.py degrades.
            //   pyvips             - WebP save fast path; falls back to PIL.
            //   patchright / zendriver - desktop browsers, replaced by WebView.
            //   fastapi / uvicorn      - the REST server, unused in-process.
            //   pillow-jxl-plugin      - --modernize only.
            //   torch stack            - opt-in ML rating, ~700 MB.
        }
    }

    sourceSets {
        getByName("main") {
            srcDir(stagedPythonDir)
        }
    }
}

// Chaquopy's per-variant tasks read the staged directory DIRECTLY, and they are
// not downstream of `preBuild` — depending on that anchor alone builds fine by
// luck and then fails Gradle's validation:
//
//   Task ':app:mergeDebugPythonSources' uses this output of task
//   ':app:stagePythonSources' without declaring an explicit [...] dependency.
//
// Matching by name rather than type because the task class (OutputDirTask) is
// internal to the plugin and not on this script's classpath. The filter is
// broad (every Chaquopy task carries "Python" in its name: mergeXPythonSources,
// generateXPythonAssets, generateXPythonRequirements) so a renamed or added
// task stays covered; the self-exclusion keeps it from depending on itself.
//
// This wiring is self-guarding: if a future Chaquopy renames its tasks out of
// this filter, Gradle raises the same validation error above rather than
// silently packaging a stale copy of the Python sources.
tasks.matching { it.name.contains("Python") && it.name != stagePythonSources.name }
    .configureEach { dependsOn(stagePythonSources) }
