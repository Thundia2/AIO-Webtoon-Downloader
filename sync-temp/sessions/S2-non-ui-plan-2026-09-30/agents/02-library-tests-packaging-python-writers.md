# Agent: Library, tests, packaging, Python writers

- type: `Explore`  model: `inherit`  shape: `background`
- transcript (user's machine): `agent-a365a5b608f2bb51b.jsonl`
- final report at: 2026-09-30 23:03

<details><summary>prompt</summary>

Medium-thorough, READ-ONLY (modify nothing). Repo: C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader. Files have uncommitted edits — report CURRENT file:line with short verbatim snippets.

1. UI-source/electron/library.js: KOMIKKU_CH_RE (verbatim; exported or not?), `extractChaptersFromFiles` (signature; how it splits a filename on the last ` Ch `; how chapter numbers are normalized — parseFloat? — around lines ~220-260, quote it), `seriesIdentityKey` and `normalizeSeriesUrl` (verbatim + where used), `scanLibrary` (sync or async fs? what it returns per series), the full `module.exports` list, which fields it reads from `.aio_series.json` and `details.json`, which chapter file extensions it recognizes, how it treats `(hid=...)` suffixes in folder names.
2. UI-source/electron/series-merge.js: file header, `compareChapterLabels` signature + semantics (quote), exports, what it requires from library.js.
3. JS test conventions: read tools/_test_series_merge.js, tools/_test_update_check_record.js, tools/_test_update_check_hook.js, tools/_test_chapter_selection.js, tools/_test_date_version.js. How are they structured (node:assert? custom check() counter?), how do they require electron-main modules without Electron (do they stub `require('electron')`? how?), how are they run (plain `node tools/x.js`?), exit code conventions.
4. UI-source/package.json: electron version, `engines`, `build.files` globs (would a new `electron/sync/*.js` directory be packaged?), asar/asarUnpack settings, any test runner devDependency, scripts.
5. Python side: does any writer in aio-dl.py, metadata_editor.py, metadata_cli.py or library_state.py PRESERVE file mtimes (os.utime, shutil.copy2, shutil.copystat, copyfile)? Report each hit with 2 lines of context and whether it applies to chapter archives/cover.jpg/details.json in the library.
6. Which files can appear inside a library series folder: grep writers for `cover.jpg`, `details.json`, `.aio_series.json`, `.mangafire_hid`, `.series_hid`, `.cover.webp`, `run_params.json`, and any other dot-file written into the per-series folder. For `details.json` and `.aio_series.json`, list the keys written (especially `source_url`, `url`, `anilist_id`, `anilist_synonyms`, `title`).
7. Is there an environment variable that overrides the library root for the Electron app (e.g. AIO_OUTPUT_DIR) — where is it read?

Output a structured, numbered report with precise file:line references.

</details>

## Final report

I checked all seven items against the current working tree, uncommitted edits included. Paths below are relative to `C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\`.

Five findings matter most:
- **Legacy filenames aren't normalized.** Only Komikku-style chapter numbers go through `parseFloat`; legacy ones keep the raw text.
- **Library files are sync, the merge module is async.** `scanLibrary` uses sync fs; `series-merge.js` uses `fs.promises`.
- **Tests don't stub Electron.** The modules under test are simply written without it.
- **A new `electron/sync/` folder would be packaged.** The `electron/**` glob picks it up.
- **Chapter archive mtimes carry the temp-cache time.** Python writers use `shutil.copy2`, so the library file gets the mtime of the temp copy, not the time it was copied in. Nothing calls `os.utime`.

---

## 1. `UI-source/electron/library.js` (1118 lines, modified)

**`KOMIKKU_CH_RE`** (line 148). It is **not exported**; it's a module-private `const`.
```js
const KOMIKKU_CH_RE = /^(?:Vol\.\S+\s+)?Ch\.(\d+(?:\.\d+)?[a-z]?)/i;
```

**`extractChaptersFromFiles(files)`** (lines 159–217)
- Signature: `@param {Array} files - [{ name: "Title Ch 5.pdf", ... }]`. Returns `{ chapters: Set<string>, ranges: Array<{start:number, end:number}> }` (lines 153–157). Only `file.name` is read.
- It does **not** filter by extension. It strips the last `.xxx` with `file.name.replace(/\.[^.]+$/, "")` (169). Callers filter first.
- **Komikku branch** (175–182): a `KOMIKKU_CH_RE` match goes through `_normalizeChapterToken`, then `continue`.
- **Legacy branch**, split on the last ` Ch ` (187–213):
```js
const chIdx = nameNoExt.lastIndexOf(" Ch ");
if (chIdx === -1) continue;
const chPart = nameNoExt.slice(chIdx + 4).trim(); // everything after " Ch "
...
const rangeMatch = chPart.match(/^(\d+(?:~\d+)?)\s*-\s*(\d+(?:~\d+)?)$/);
if (rangeMatch) {
  const start = parseFloat(rangeMatch[1].replace("~", "."));
  const end = parseFloat(rangeMatch[2].replace("~", "."));
  if (!isNaN(start) && !isNaN(end)) { ranges.push({ start, end }); }
} else {
  const chapNum = chPart.replace("~", ".");
  if (!isNaN(parseFloat(chapNum))) { chapters.add(chapNum); }
}
```
- **Caveat:** single legacy chapters are added as the raw string, not the `parseFloat` result. So `"Ch 05"` gives `"05"`, and `"Ch 5 (v2)"` gives `"5 (v2)"` because `parseFloat` returns 5. Also, `.replace("~", ".")` replaces only the first `~`.
- **`_normalizeChapterToken(raw)`** (231–241), used by the Komikku branch only:
```js
const alphaMatch = raw.match(/^([\d.]+)([a-z])$/i);
if (alphaMatch) { const num = parseFloat(alphaMatch[1]); if (isNaN(num)) return null;
  return `${num}${alphaMatch[2].toLowerCase()}`; }
const num = parseFloat(raw); if (isNaN(num)) return null; return String(num);
```
  So `"005"` becomes `"5"`, `"005.50"` becomes `"5.5"`, and `"005A"` becomes `"5a"`.
- **`getChaptersOnDevice(files, siteChapters)`** (255–273) expands ranges only against the site's chapter list, adding `String(ch)`.

**`normalizeSeriesUrl(value)`** (460–467), verbatim:
```js
function normalizeSeriesUrl(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const text = String(raw || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  const m = text.match(/^(https?:\/\/)(?:www\.)?([^/]+)(.*)$/i);
  if (!m) return text.toLowerCase();
  return m[1].toLowerCase() + m[2].toLowerCase() + m[3];
}
```

**`seriesIdentityKey(seriesMeta)`** (480–487), verbatim:
```js
function seriesIdentityKey(seriesMeta) {
  if (!seriesMeta || typeof seriesMeta !== "object") return null;
  const site = String(seriesMeta.site || "").trim();
  const hid = String(seriesMeta.hid || "").trim();
  if (site && hid) return `hid:${site}:${hid}`;
  const url = normalizeSeriesUrl(seriesMeta.url);
  return url ? `url:${url}` : null;
}
```

Where these two are used:

| Location | Use |
|---|---|
| `library.js:485` | `normalizeSeriesUrl` inside `seriesIdentityKey` |
| `library.js:528` | `groupEntriesBySeries` fallback key |
| `library.js:782` | `seriesKey` field on each `scanLibrary` entry |
| `series-merge.js:401, 404` | identity check before merging |
| `series-merge.js:417, 420` | `normalizeSeriesUrl`, running-download guard |

- `main.js:36` does not import either one. It uses `groupEntriesBySeries` at `main.js:1486`.
- Python twins: `aio-dl.py:_normalize_series_url` (574) and `library_state.py:360` / `:379`.

**`scanLibrary(mangasDir, thumbCacheDir)`** (616–807) is **fully synchronous**: `existsSync`, `readdirSync`, `statSync`, `readFileSync`.
- Skips root entries that aren't directories or start with `.` (630). Skips files starting with `.` or with a non-output extension (646–649).
- A folder with no archive and no image chapter is skipped (694).
- It returns an array sorted by `naturalCompare(title)` (795). Each entry (766–791) has:
  - `title` (the folder name, verbatim), `folderPath`
  - `files` (`[{name, path, ext, size, modifiedAt}]`, natural-sorted)
  - `coverPdfPath`, `thumbPath`, `webCoverCached`
  - `chapterCount`, `totalSize`, `lastModified`
  - `seriesMeta` (the whole parsed `.aio_series.json`, or `null`)
  - `seriesKey`, `anilistId`
  - `isImageOnly`, `imageCount`, `coverImagePath`, `imageChapters`
  - `duplicate` (`{reason, peers}`), present only on duplicates (801–805)

**`module.exports`** (line 1118):
```js
module.exports = { scanLibrary, saveThumbnail, generateMissingThumbnails, downloadMissingCovers, cleanupOrphanCovers, extractChaptersFromFiles, getChaptersOnDevice, getImageChaptersOnDevice, imageChapterToken: _imageChapterToken, seriesIdentityKey, groupEntriesBySeries, findDuplicateSeries, normalizeSeriesUrl };
```
Everything from `imageChapterToken` onward is new in the uncommitted diff; at HEAD the list ended at `getImageChaptersOnDevice`. The diff also added the identity block (427–604), the `seriesKey`/`anilistId` fields (777–783) and the duplicate attach (796–805).

**Fields read from `.aio_series.json`** (loaded at 715–720):

| Field | Where |
|---|---|
| `site`, `hid`, `url` | 482–485 |
| `chapters_downloaded` | 496, 582 |
| `site` | 581 |
| `last_downloaded_at` | 724–725 (image-only fallback) |
| `cover` | 750–751, 1097–1100 |
| `anilist_id` | 783 |

- **`details.json` is not read anywhere in `library.js`.** The only Electron-side mention is the singleton list in `series-merge.js:61`.
- On-disk covers are probed in the order `cover.jpg`, `cover.png`, `cover.webp`, `cover.jpeg` (735).

**Recognized extensions**
- Archives: `OUTPUT_EXTENSIONS = new Set(["pdf", "epub", "cbz"])` (45), compared lowercased (648).
- Images: `IMAGE_EXTENSIONS = new Set(["jpg","jpeg","png","webp","avif","gif"])` (52), under `images/Chapter_<n>/` or legacy `ch_<n>/`. The token regex is `/^(?:Chapter_|ch_)(-?\d+(?:\.\d+)?)/i` (293).

**`(hid=...)` folder suffixes: `library.js` does nothing with them.**
- `title: folder.name` is used verbatim (767), so a `Title (hid=abc)` folder displays with the suffix.
- Grouping uses `.aio_series.json` identity only ("never fall back to the title", 474–475).
- The Python side strips the suffix from titles (`aio-dl.py:949`, `:10127`). It creates `"{clean_title} (hid={hid})"` folders, then ` (2)`, ` (3)`…, only on a genuine title collision (`aio-dl.py:1036–1041`).
- `downloader.js:395` parses `(hid=…)` from the stdout line, not from folder names.

## 2. `UI-source/electron/series-merge.js` (502 lines, untracked/new)

- **Header** (lines 1–39): "MERGE DUPLICATE SERIES FOLDERS".
  - Rules: nothing is ever overwritten; the source folder is removed only when it's clean; both folders must be direct children of the library root; identity must match (site+hid or URL, or at least `anilist_id`); merging is refused while a matching or unknown download is running.
  - It's a separate module "so it has to be drivable by an offline test". Dependencies "arrive as plain DATA (libraryRoot, runningDownloads) rather than as electron handles" (30–33).
- **Requires from `library.js`** (44–50): `seriesIdentityKey`, `normalizeSeriesUrl`, `extractChaptersFromFiles`, `getImageChaptersOnDevice`, `imageChapterToken`. It also uses `fs` and `path`, and its fs calls are **async** (`fs.promises`).
- **`compareChapterLabels(a, b)`** (83–91), verbatim:
```js
function compareChapterLabels(a, b) {
  const fa = parseFloat(a);
  const fb = parseFloat(b);
  if (Number.isNaN(fa) || Number.isNaN(fb)) {
    if (Number.isNaN(fa) && Number.isNaN(fb)) return a < b ? -1 : a > b ? 1 : 0;
    return Number.isNaN(fa) ? 1 : -1;
  }
  return fa - fb;
}
```
  - Numeric ascending. Non-numeric labels sort after all numeric ones and are string-compared among themselves.
  - Because of `parseFloat`, `"5a"` compares equal to `"5"` (returns 0).
- **`chapterLabel(c)`** (76–79): `Number.isFinite(Number(c)) ? String(n) : String(c)`.
- **Exports** (496–502): `mergeSeriesFolders`, `planFolderMerge`, `mergeSeriesMetaObjects`, `chapterLabel`, `compareChapterLabels`.
- `main.js:40` imports `mergeSeriesFolders`, `chapterLabel` and `compareChapterLabels`.

## 3. JS test conventions (`tools/`)

**Nothing stubs `require('electron')`** (no `require("electron")`, `Module._load` or `require.cache` in `tools/`). Instead:
- **Main-process modules are written without Electron.** `library.js` loads only `fs`, `path`, `crypto`, `https` and `http`; `mupdf` is imported lazily inside `generateThumbnail`. `series-merge.js` and `update-check-record.js` also have no Electron import. Collaborators are injected: a recording `send` sink (`_test_update_check_record.js:40–44`), or `libraryRoot`/`runningDownloads` passed as data (`main.js:1765–1770`).
- Only `main.js:18`, `preload.js:15` and `updater.js:68` require Electron.
- **Renderer sources** are loaded by reading the file, regex-stripping `import` lines and `export` keywords, and evaluating with `new Function(...)` with stubs passed as parameters. Examples: `_test_update_check_hook.js:42–56` (React hooks and `window` injected) and `_test_chapter_selection.js:42–70`.
- **Scripts** are spawned with `execFileSync("node", [SCRIPT], { env: {..., AIO_DATE_VERSION_EPOCH} })` (`_test_date_version.js:35–53`).

Two assertion styles are in use:

| Style | Files | How it reports |
|---|---|---|
| `node:assert` plus a `test(name, fn)` wrapper | `_test_series_merge.js` (`assert` at 16, wrapper 24–38) | async wrapper with `passed`/`failed` counters; prints `  ok  name` / `  FAIL name`; real temp dirs via `fs.mkdtempSync(os.tmpdir())` (42–44) |
| custom `check()` / `eq()` counter | the other four files | `check(label, ok, detail)` plus `eq(label, actual, expected)` comparing with `JSON.stringify` (e.g. `_test_update_check_record.js:24–37`); prints `  ok  …` / `FAIL  … — detail` to stderr; sections headed `console.log("\n[1] …")` |

**Running:** plain `node tools/_test_x.js`, from the repo root or `tools/`. Files find the repo with `const ROOT = path.resolve(__dirname, "..")` and require via `path.join(ROOT, "UI-source", "electron", "…")`; the series-merge test uses `require("../UI-source/electron/series-merge.js")` (22). Each file opens with a comment block: "Offline regression test for <file> … Run: node tools/… What it pins: …".

**Exit codes:**
- `process.exit(failures === 0 ? 0 : 1)` in `_test_update_check_record.js:274`, `_test_update_check_hook.js:584` and `_test_chapter_selection.js:195`.
- `_test_date_version.js:107–110` calls `process.exit(1)` only on failure.
- `_test_series_merge.js:496–500` sets `process.exitCode = 1` instead of calling `exit`, with `main()` at 503.

**Note:** `tools/` is gitignored (`.gitignore:89 /tools/`, confirmed with `git check-ignore`), and no files under `tools/` are tracked. The series-merge test says "tools/ is gitignored and not shipped" (10–11).

## 4. `UI-source/package.json`

- **Electron:** devDependency `"electron": "^40.6.1"` (149); installed version is 40.10.0. electron-builder `^26.8.1` (26.8.1 installed); electron-updater `^6.6.2` (6.8.9 installed). Local Node is v24.13.0.
- **No `engines`** and **no `"type"`** field, so modules default to CommonJS.
- **`build.files`:** `["dist/**", "electron/**"]` (21–24). **A new `electron/sync/*.js` would be packaged.**
- **asar:** `"asar": true, "asarUnpack": []` (129–130). Python ships as `extraResources` from `python-src` (35–41).
- **No test runner** in devDependencies (no jest/mocha/vitest) and **no `test` script**.
- Scripts (7–16): `dev`, `build`, `electron:dev`, `electron:build` (`node scripts/prepare-src.js && vite build && electron-builder --publish never`), `electron:preview`, `dist:win`, `dist:mac`, `dist:linux`.

## 5. Python mtime preservation

**There is no `os.utime`, `shutil.copystat` or `copyfile` in `aio-dl.py`, `metadata_editor.py`, `metadata_cli.py` or `library_state.py`.** The `shutil.copy2` hits below copy the temp file's mtime to the destination:

| Location | Writes to | Applies to the library? |
|---|---|---|
| `aio-dl.py:8029` | `cover.jpg` in the series folder (`_refresh_cover_jpg`, `--refresh-library-metadata`) | Yes. The source was just downloaded into a `mkdtemp`, so the mtime is effectively "now". |
| `aio-dl.py:11293–11295` | `cover_dst = <out_dir>/cover.jpg` (Komikku) | Yes. The comment says "Use copy2 so the file appears with timestamps from the tmp copy (preserves mtime for Library-tab thumb-cache)." The mtime is that of `tmp_<hid>/cover_orig.jpg`. |
| `aio-dl.py:12226`, `12239`, `12244` | `<out_dir>/images/Chapter_{n}` via `copytree(tdir, dest_dir, …)` (copy2 by default) | Yes, for `--keep-images` / `--format none` pages. They keep the temp mtime. |
| `aio-dl.py:12923` | `shutil.copy2(src_pdf, cached_pdf_path)` | No, temp dir only. |
| `aio-dl.py:13028–13034` | `shutil.copy2(src_cbz, ch_out_path)`; skipped when the destination already has the same size | **Yes, per-chapter CBZs** (`--keep-chapters` / Komikku). The mtime comes from the cached CBZ in `tmp_<hid>`, which can be older on resume. A size-equal file is left untouched. |
| `aio-dl.py:13079–13083` | same pattern for per-chapter PDFs | **Yes, per-chapter PDFs.** |
| `aio-dl.py:14419–14422` | `<out_dir>/.cover.jpg`, only under `--save-params` and only if it doesn't exist | Yes |

Writers that **do not** preserve mtime (the file gets a new timestamp):
- `aio-dl.py:7982–7991`: `_rewrite_cbz_comicinfo` rebuilds each library CBZ into `path + ".refresh.tmp"`, then `os.replace(tmp, path)`.
- `aio-dl.py:7125–7138`: the merged final PDF is written as `out_path + ".tmp"`, then `os.replace`.
- `aio-dl.py:13993`: `shutil.copy` (not copy2) for `(missed chapters).json`.
- `details.json` and `.aio_series.json` are rewritten in place with `open("w")`: 11327–11328, 8244–8245, 14398–14399.
- **`metadata_editor.py`**: `_replace_preserving_mode` (36–69) restores only the **mode**:
  ```python
  mode = os.stat(dest_path).st_mode
  shutil.move(temp_path, dest_path)
  if mode is not None: os.chmod(dest_path, mode & 0o7777)
  ```
  - The temp files come from `tempfile.mkstemp(suffix=…)` with no `dir=` (135, 231, 327), so they sit in the system temp directory.
  - Result: an edited CBZ, EPUB or PDF always ends up with the edit time as its mtime.
- **`metadata_cli.py`**: no file I/O of its own; it calls `update_metadata(args.path, data, args.cover_path)` (43).
- **`library_state.py`**: `os.path.getmtime` is read-only (321, for sorting). `_write_cover_file` (197–206) uses a plain `open(out_path, "wb")`.

Outside the four files: `migrate_library.py:41` uses `shutil.copy2(src_file, dst_file)` when merging legacy trees.

## 6. What can appear inside a series folder

| File | Writer | Notes |
|---|---|---|
| `<Title>.pdf/.epub/.cbz` | `aio-dl.py:14048` (final book), 6173/6213 (split parts) | EPUBs can go to `--epub-dir` instead |
| `<Title> Ch <n>.<fmt>` or `Vol.XX Ch.NNN - title.cbz` | `aio-dl.py:12983–12994` | Komikku names from `_komikku_chapter_filename` (4958); legacy names use `~` in place of the decimal point (10339–10365) |
| `images/Chapter_<n>/…` | `aio-dl.py:12222–12244` | `copytree` of the whole chapter temp dir, so leftover markers such as `.download_prefetched` (7695) or `.pending_*` may come along |
| `cover.jpg` | `aio-dl.py:11292–11295`, 8029 | Komikku / metadata refresh |
| `details.json` | `aio-dl.py:11326–11328`; patched at 5305–5364; refresh at 8211–8245 | keys below |
| `.aio_series.json` | `aio-dl.py:14209–14399`; `main.js:1747` (`set-chapters-ignored`), `main.js:1803` (`save-series-meta`); `series-merge.js:475–479`; refresh at `aio-dl.py:8251–8277` | keys below |
| `.series_hid` | `aio_config.py:81–86` (`write_hid_marker`), called from `aio-dl.py:966`; `migrate_library.py:68` | written as soon as the folder is allocated |
| `.mangafire_hid` | **no writer**; legacy, read-only (`aio_config.py:10`, `main.js:236`) | |
| `.cover.jpg` | `aio-dl.py:14419–14422` | `--save-params` only |
| `.cover.{jpg,jpeg,png,webp,gif}` | `library_state.py:200` (`f".cover{ext}"`) | only with `write_cache=True`; **no current caller passes it** (`aio_android.py:1984–1988` redirects to the app cache) |
| `.cover.webp` | nothing writes it specifically; only via the row above | `library.js:735` and `series-merge.js:60` recognize `cover.webp`, without the dot |
| `download_params.json` | `aio-dl.py:6566–6569` | `--save-params` |
| `<Title> (missed chapters).json` | `aio-dl.py:13992–13993` | `series-merge` would treat this as a "leftover" |
| `*.refresh.tmp`, `<Title>.pdf.tmp` | `aio-dl.py:7982`, 7126 | transient; can remain after a crash |
| `run_params.json` | **not in the series folder** | lives in `tmp_<hid>/` under `--temp-dir` or the cwd (`aio-dl.py:10131–10139`, 11152) |

Library-root files (not per series): `.aio_folder_alloc.lock` (`aio-dl.py:952`) and `.aio_coord/` (8355, default `manga/.aio_coord`). The root dotfolder is skipped by `library.js:630`.

**`details.json` keys (written in this order):**
- Base keys: `title`, `author`, `artist`, `description`, `genre`, `status` (`aio-dl.py:11297–11308`).
- Plus `_build_aio_reader_extras` (7844–7851): the seven AniList keys `anilist_id`, `mal_id`, `country_of_origin`, `media_format`, `anilist_synonyms`, `anilist_tags`, `anilist_spoiler_tags` (7784–7798), then `source_site`, `source_url`, `language`.
  - `source_url` is `args.comic_url` (11322). On refresh it's `meta.get("url")` (8239).
  - There is **no bare `url`** key, deliberately (7826–7827).
- Optionally `has_audio`, `has_motion`, `chapter_assets` (5337–5364).

**`.aio_series.json` keys** (`aio-dl.py:14349–14396`):
- `url` (`args.comic_url`; can be a list in older files, which `normalizeSeriesUrl` handles), `hid`, `title`, `site`, `format`, `language`, `download_volumes`, `status`, `authors`, `cover`, `genres`, `chapters_downloaded`, `chapters_skipped_fragments`.
- `chapters_ignored` and `final_file_chapters` are written only when non-empty.
- `total_available_at_download`, `last_downloaded_at`, then the seven AniList keys (including `anilist_id` and `anilist_synonyms`).
- There is **no `source_url`** key here.

## 7. Library-root environment variable

Yes. `AIO_OUTPUT_DIR` is read in `UI-source/electron/main.js:220–233`, in `getConfiguredOutputRoot(workingDir)`:
```js
let outputDir = process.env.AIO_OUTPUT_DIR || "manga";
...if (!process.env.AIO_OUTPUT_DIR && fs.existsSync(configPath)) { ... outputDir = config.output_dir.trim(); }
return path.isAbsolute(outputDir) ? outputDir : path.join(root, outputDir);
```
- Precedence: the env var, then `<workingDir>/aio_config.json` `output_dir`, then `"manga"`. A relative value is resolved against `workingDir`; the packaged default is `Documents/AIO Downloader` (`main.js:215`).
- Callers: `scan-library` (968), check-all (1451), and `libraryRoot` for merge (1769).
- Electron does **not** pass `--output-dir` to Python; there are no hits in `electron/` or `src/`. The Python child resolves the root itself in `aio_config.py:32–52` (`resolve_output_dir`: CLI, then `AIO_OUTPUT_DIR` at line 45, then `aio_config.json`, then `"manga"`). Help text is at `aio-dl.py:8956`.
- `aio_android.py:153` sets the env var for Android.
