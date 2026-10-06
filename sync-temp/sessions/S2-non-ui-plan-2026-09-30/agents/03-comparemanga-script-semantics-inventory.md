# Agent: CompareManga script semantics inventory

- type: `Explore`  model: `inherit`  shape: `background`
- transcript (user's machine): `agent-a7aab3cc9374be02d.jsonl`
- final report at: 2026-09-30 23:10

<details><summary>prompt</summary>

Very thorough, READ-ONLY (do not modify anything). Directory: C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga — a personal Python script suite that mirrors a manga library (PC folder of per-series folders with .cbz chapter files) to an Android tablet over adb. I am porting its durable semantics into a Node/Electron engine and need an exact inventory. Read sync_to_tablet.py fully, then manga_ops.py, transfer_runner.py, push_all_to_tablet.py, verify_push.py, and the relevant parts of compare_manga.py, batch_search.py, fixup_seed_links.py.

Report, with file:line for every item and short verbatim code where it is short:
1. Every adb command line constructed (push, shell find / sha256sum / stat / rm / rmdir / mkdir / mv / df / ls), exact flags, how quoting is done (shlex.quote?), how the remote path is built, whether cwd is set, whether stderr is discarded (2>/dev/null) anywhere and on which commands.
2. Batching constants (max files per batch, max arg length ~12000 chars, anything else), the non-ASCII one-file-at-a-time rule and the reason comment verbatim, all timeouts (total, idle/no-output), subprocess settings (encoding, creationflags).
3. The journal/state file (.sync_state-<serial>.json): top-level keys, per-folder and per-file entry shapes, when it is flushed (per batch?), atomic write method, how resume works.
4. The PC hash cache (.pc_hash_cache.json) format and the --fast size+mtime logic; worker count / thread pool.
5. The --verify implementation: exact device command, parsing, how results are merged into the journal (does it adopt everything it sees?).
6. Delete logic: which device files in a managed folder become deletion candidates, the ordering of deletes vs pushes, prune semantics (rm -rf?), how "preserved" vs "orphaned" device folders are decided.
7. Error handling: how adb failures are classified, any regex, the error budget, what happens when the device disconnects mid-run, whether the "N files pushed" summary is parsed.
8. `_validate_tablet_path` in manga_ops.py — full logic verbatim.
9. Alias / mapping tables: ALIASES_TABLET_TO_PC, KEEP_TABLET_NAME_FOR_ALIASES, PUSH_MAP, SIDECARS, SIDECARS_ON_TABLET, IGNORE_SERIES_FILES, is_content_file, CHAPTER_EXTS — shapes and entry COUNTS only (do not list series names beyond 2 examples each).
10. compare_manga.py chapter-name parsing regexes (CHAPTER_PATTERNS or similar) verbatim, the hid-strip regex, and how it counts volumes vs chapters.
11. batch_search.py: the rules that turn a device folder name into a search query (verbatim), PROBE_PHASE_DEADLINE_S and how the search is invoked (subprocess args to AIO's CLI?).
12. Any handling of `.nomedia`, `cover.jpg`, `details.json`, `.aio_series.json` on the device.
Also grep sync-log-*.json, synclogs07.md, full_mirror_stderr.log, full_mirror_stdout.log, push_run.log, transfer-log-*.json for: (a) device-disconnect error text (patterns: "not found", "device offline", "failed to read copy response", "protocol fault", "no devices") — quote exact distinct lines and approximate counts; (b) whether adb push output contains per-file progress lines like "[ 42%]" (count them); (c) any "files pushed" summary lines that appear next to failures. Finally, open .sync_state-A06B4A372090333.json only far enough to report its top-level key structure and one sample per-file entry (it is 3 MB — use a targeted read/grep, do not dump it).

Output a structured, numbered report. Precision matters more than brevity.

</details>

## Final report

I have everything needed. Here is the full inventory.

# CompareManga sync semantics: inventory for the Node/Electron port

## 0. Legend

All files are under `C:\Users\legoc\OneDrive\Belgeler\Scripts\CompareManga\`. Line references use these short names:

| Alias | File |
|---|---|
| `sync` | `sync_to_tablet.py` (incremental engine) |
| `pat` | `push_all_to_tablet.py` (legacy whole-folder mirror; also provides sync's adb helpers) |
| `ops` | `manga_ops.py` |
| `tr` | `transfer_runner.py` |
| `cm` | `compare_manga.py` |
| `vp` | `verify_push.py` |
| `bs` | `batch_search.py` |
| `fs` | `fixup_seed_links.py` |
| `mm` | `manga_manager.py` (the Flask UI that feeds `tr`) |
| `vc` | `_verify_chapters.py` |
| `df` | `_delta_findings.py` |

Base constants:
- Tablet root is `"/storage/self/primary/Documents"` (`cm:56`); sync strips the trailing slash (`sync:87`).
- PC root is `D:\AIO\manga` (`cm:55`).
- Default serial is `3CEF42502E91537` (`cm:57`, the old tablet). The current device in the logs and state is `A06B4A372090333`.
- adb is resolved via `shutil.which("adb")` first, then `KNOWN_ADB_PATH` (`cm:444-457`, `cm:58`).

---

## 1. Every adb command line

**Invocation pattern**
- Every call is an argv list `[adb, "-s", device, ...]`. There is never `shell=True` (`pat:176`, `ops:119`, `ops:164-169`, `ops:276-279`, `cm:537`, `cm:562`).
- Shell commands go as one argv element after `"shell"`: `_adb_run(adb, device, ["shell", cmd_str], ...)` (`pat:235`).
- Paths are quoted with `shlex.quote()` (POSIX single quotes) in all core code. Exceptions are noted below.
- **cwd is never set** on any subprocess. The only cwd change anywhere is `os.chdir(str(AIO_DIR))` at import time in `bs:41`, which runs in-process (no subprocess).

**sync (the engine to port)**

| Operation | Remote command (as the device receives it) | Timeout | Where |
|---|---|---|---|
| Listing (via `cm._run_adb_find`) | `find '<root>' -mindepth 1 -maxdepth 1 -type d 2>/dev/null; echo ---COMPARE_MANGA_DIRS_END---; find '<root>' -type f -printf '%s\|%T@\|%p\n' 2>/dev/null` | 180 | `cm:530-539`, called at `sync:339` |
| Listing fallback | same, but the second find is `-type f -exec stat -c '%s\|%Y\|%n' {} + 2>/dev/null` | 600 | `cm:555-564` |
| Verify hashing | `find '<root>/<folder>' -type f ! -name ".*" -exec sha256sum {} + 2>/dev/null` | 7200 | `sync:369-373` |
| mkdir | `mkdir -p '<root>/<target>'` (through `pat.adb_mkdir_p`) | 30 | `sync:390-391` → `pat:285-293` |
| Delete files | `rm -f 'p1' 'p2' …`: **one shell call with all paths, no chunking** | 120 | `sync:394-403` |
| Prune | `rm -rf '<root>/<target>'` | 600 | `sync:406-410` |
| Batch push | argv `push <winpath1> … <winpathN> "<root>/<target>/"` (trailing slash) | computed | `sync:432-440` |
| Explicit push | argv `push <winpath> "<root>/<target>/<f.rel>"` (no trailing slash) | computed | `sync:454-462` |

Notes on the sync commands:
- In the Python source, the printf format is `'%s|%T@|%p\\n'` inside an f-string. The device therefore receives a literal backslash-n, which find interprets as a newline. The `{{}}` in the f-strings becomes `{}`.
- In the sha256sum command, `".*"` is a double-quoted literal inside the remote string.
- **adb push flags:** none. There is no `--sync`, `-z`, `-q`, `-a` or `--progress`. `--progress` was deliberately dropped: "36.0.2 rejects --progress with 'unrecognized option'" (`ops:157-162`).
- The source path is `str(f.abs_path)`, e.g. `D:\AIO\manga\Bleach\Ch.640 - …cbz`.
- **Remote path building:** `tablet_join(*parts) = "/".join([TABLET_ROOT] + [p.strip("/") for p in parts])` (`sync:328-329`).
  - The batch destination is validated through a fake child path: `_validate_tablet_path(dest_dir.rstrip("/") + "/__probe__", TABLET_ROOT)` (`sync:432`).
  - The file leaf `f.rel` is the PC filename verbatim. Only folder names are sanitized.
- **Listing post-processing** (`sync:340-357`):
  - Only paths under `root + "/"` are kept.
  - Files whose **basename** starts with `.` are dropped. Files inside dot-directories are not dropped.
  - `dirs` contains depth-1 folder names only.

**pat (legacy tool)**

| Helper | Remote command | Timeout | Where |
|---|---|---|---|
| `adb_shell` | wrapper | default 60 | `pat:234-235` |
| `list_tablet_folders` | `find '<root>' -mindepth 1 -maxdepth 1 -type d -printf '%f\n'` (raises if rc≠0) | 30 | `pat:262-271` |
| `adb_rm_rf` | `rm -rf '<path>'` | 300 | `pat:274-282` |
| `adb_mv` | `mv '<src>' '<dst>'` | 60 | `pat:296-305` |
| `adb_path_exists` | `[ -e '<path>' ] && echo Y \|\| echo N` → true iff `rc == 0 and out.strip().endswith("Y")` | 30 | `pat:308-316` |
| `adb_remove_sidecars` | `rm -f '<dir>/.aio_series.json' '<dir>/.mangafire_hid' '<dir>/.series_hid'` (result ignored) | 30 | `pat:363-372` |
| `adb_push_folder` | argv `push "<PC series dir>" "/storage/self/primary/Documents/"` | 14400 ("4 hour ceiling per single folder (One Piece is 11 GB)") | `pat:375-396` |

pat's apply sequence (`pat:701-758`):
1. `rm -rf` each matched tablet folder.
2. `rm -rf` the target name and the push basename plus its truncated variant.
3. Push the folder.
4. Locate the landed folder: `adb_landed_basename`, then `[ -e ]`, then the listing fallback.
5. `mv` it to the target name.
6. `rm -f` the sidecars.

**ops / tr (Flask UI path)**
- `mkdir -p '<dir>'`, timeout 30 (`ops:118-127`).
- Push: argv `push "<pc file>" "<dir>/"` with **no timeout at all**, only a cancel event (`ops:163-179`).
- `rm -f '<path>'`, timeout 30 (`ops:275-287`).
- `delete_tablet_dir` validates and then raises `NotImplementedError` (`ops:290-302`).
- `tr` runs `mkdir -p` before **every** push op (`tr:270-279`).
- Paths come from mm:
  - Push destination is the existing tablet folder, or `root + "/" + sanitize_tablet_segment(canon.folder_name)`. The hid suffix is **not** stripped (`mm:554-576`).
  - Delete path is `abs_path.rstrip("/") + "/" + filename` (`mm:579-599`).

**Other adb calls**
- `adb devices` (no `-s`), timeout 15 (`cm:460-465`).
- `vc` uses hand-written single quotes rather than `shlex`: `find '{T}' -mindepth 1 -maxdepth 1 -type d -printf '%f\n'` and `find '{T}' -mindepth 2 -maxdepth 2 -name '*.cbz'` (`vc:35-40`). It has no timeout and hard-codes the old serial (`vc:19`, `vc:24-25`).

**Never used anywhere:** `df`, `ls`, `rmdir`, `md5sum`, `pull`, `wait-for-device`, `reconnect`, `get-state`. `stat` appears only in the listing fallback.

**`2>/dev/null` appears only on** `cm:531`, `cm:533`, `cm:556`, `cm:558` (all four finds) and `sync:371` (sha256sum). It is never on rm, mkdir, mv, `[ -e ]`, `list_tablet_folders`, or `vc`. It only silences device-side stderr; the adb client's own errors (`adb.EXE: device '…' not found`) still reach the PC's captured stderr.

---

## 2. Batching, the non-ASCII rule, timeouts, subprocess settings

**Batch caps**
- `MAX_BATCH_FILES = 50` and `MAX_BATCH_ARGLEN = 12000` (`sync:116-117`). The comment says the caps exist "so the Windows CreateProcess 32 KB command-line limit is never hit" (`sync:112-115`).
- `_chunk_files` (`sync:465-479`) adds `len(str(f.abs_path)) + 1` per file and starts a new batch when `cur and (len(cur) >= MAX_BATCH_FILES or cur_len + add > MAX_BATCH_ARGLEN)`.
  - Only source paths are counted, not the adb exe, `-s`, serial, `push` or destination.
  - Batches never span series (it is called per series, `sync:851`).
  - `rm_files` has no equivalent chunking.

**Non-ASCII rule** (`sync:833-834`, `sync:851-856`)
- The test is `_is_ascii(str(f.abs_path))`, i.e. `all(ord(c) < 128 for c in s)` (`sync:413-414`), applied to the **whole source path**.
- All ASCII batches run first, then non-ASCII files one adb call each.
- The self-test asserts that an ASCII filename inside a non-ASCII PC folder still routes to explicit push (`sync:983-989`).

Reason comment, verbatim (`sync:824-832`):
```
# Pushes: files with a fully-ASCII SOURCE PATH batch efficiently
# into the dir; anything with a non-ASCII byte in its source path
# goes one-at-a-time via explicit dest. adb truncates the dest leaf
# by the source path's (bytes - chars), so this bites BOTH non-ASCII
# filenames AND ASCII files sitting in a non-ASCII SERIES FOLDER
# (e.g. SPY×FAMILY\Ch.001 - Mission 1.cbz -> tablet "…Mission 1.cb").
# Keying on the whole source path covers both. Confirmed live via the
# scratch probe; see [[bug-adb-push-utf8-truncation]]. Record + flush
# after every batch/file so an interrupted run resumes cleanly.
```
Supporting text:
- `push_batch` docstring (`sync:418-429`): "adb push (36.x, Windows) truncates the leaf it writes by the SOURCE path's (utf-8 bytes − char count)".
- `push_explicit` docstring (`sync:444-452`): with a full-path destination, "adb writes those exact bytes as the filename".
- `pat.adb_landed_basename` (`pat:319-339`) keeps "only the first (character-count) BYTES".

Log evidence:
- `canary_stderr.log:9` shows `'Hell’s Paradise Jigokura'` and `canary_stderr.log:15` shows `'SPY×FAMIL'`.
- In `synclogs07.md:1243-1397`, a non-ASCII-folder series was still batched (50/50/49), because that run predates the fix.
- The follow-up `--plan --verify` (`synclogs07.md:~1627-1656`) found 3 series needing 434 pushes and 434 deletes.
- The fix runs (`sync-log-20260707-013414.json` and `-013548.json`) deleted 131+154+149 files and pushed 1+433.

**Timeouts (seconds)**

| Call | Timeout | Where |
|---|---|---|
| sync batch push | `max(180.0, total/4_000_000 + 120.0)`, comment "Pessimistic USB-2 floor of ~4 MB/s" | `sync:436-437` |
| sync explicit push | `max(180.0, f.size/4_000_000 + 120.0)` | `sync:456` |
| sync verify hashing | 7200 | `sync:373` |
| sync `rm -f` | 120 | `sync:401` |
| sync `rm -rf` | 600 | `sync:408` |
| mkdir (pat) | 30 | `pat:290` |
| pat `rm -rf` | 300 | `pat:279` |
| pat `mv` | 60 | `pat:302` |
| pat `[ -e ]` / list / sidecars | 30 | `pat:267`, `pat:314`, `pat:372` |
| pat folder push | 14400 | `pat:393` |
| cm find / stat fallback / `adb devices` | 180 / 600 / 15 | `cm:539`, `cm:564`, `cm:464` |
| ops mkdir / rm | 30 / 30 | `ops:120`, `ops:280` |
| ops push | **none** | |
| tr queue / progress | event `put` 30 s (`tr:176`), heartbeat 15 s (`tr:130`), progress throttle 0.2 s (`tr:77`), queue max 4096 (`tr:64`) | |

- **There is no idle/no-output timeout anywhere.** In stream mode the overall timeout is checked only after `p.stdout.read(1024)` returns (`pat:198-201`). That read blocks until bytes or EOF arrive, so a silent stall is never timed out. On a timeout that is detected, the function returns `(-1, tail, f"timeout after {timeout}s")`.
- Non-stream calls raise `subprocess.TimeoutExpired` uncaught inside `_adb_run`; callers' `except Exception` handles it.
- Kill escalation is terminate → `wait(5)` → kill (`pat:218-227`, `ops:252-264`).

**Subprocess settings**
- All output is read as bytes and decoded manually with `.decode("utf-8", errors="replace")` (`pat:181-182`, `pat:212`, `pat:229`; `ops:122`, `ops:209`; `cm:466`, `cm:542`, `cm:550`). Only `vc` uses `encoding="utf-8", errors="replace"` (`vc:25`).
- **No `creationflags` / `CREATE_NO_WINDOW`, no `cwd`, no `env`, and stdin is never redirected** (it inherits the parent's) anywhere.
- Stream mode: `Popen(stdout=PIPE, stderr=STDOUT, bufsize=0)` (`pat:186-191`).
  - pat reads 1024-byte chunks and splits via `.replace(b"\r", b"\n").split(b"\n")` (`pat:207`).
  - ops reads 256-byte chunks and uses `re.split(rb"\r\n|\r|\n", …)` (`ops:203`).
  - pat keeps a tail of 250–500 lines (`pat:213-215`) and echoes each line to stderr with a two-space indent (`pat:216`).
  - sync's error message includes `out[-800:]` (`sync:440`, `sync:462`).
  - Non-stream mode uses `subprocess.run(cmd, capture_output=True, timeout=…)` (`pat:178`).

---

## 3. The journal: `.sync_state-<serial>.json`

**Location and format**
- Path: `SCRIPT_DIR / f".sync_state-{device}.json"` (`sync:487-488`); `--state` overrides it (`sync:1027`).
- Top-level shape is `{"version": 1, "device", "tablet_root", "files": {…}, "updated_at_iso"}` (`sync:90`, `sync:491-505`, `sync:509`).
- **There are no per-folder entries.** It is a flat map keyed `"<tablet target>/<filename>"` (`sync:587`, `sync:839`). Folder membership is derived with `k.split("/", 1)[0]` (`sync:626`, `sync:763`, `sync:883`).
- Per-file value: `{"size": int, "sha256": "<64 lowercase hex>"}` (`sync:766`, `sync:839`).

**Loading**
- A missing, corrupt, non-dict, or `files`-less file resets to empty (`sync:491-505`).
- `version`, `device` and `tablet_root` are **not validated** on load.

**Flush points** (each one is a full rewrite)
- After each folder is verified (`sync:767`).
- After each series' deletes (`sync:822`).
- After every ASCII batch and every explicit file (`sync:843`).
- After each pruned folder (`sync:885`).

**Atomic write** (`sync:508-513`)
- Writes to `path.with_suffix(path.suffix + ".tmp")`, using `json.dump(..., ensure_ascii=False)` with no indent, then `os.replace`.
- No fsync, no lock, no backup.
- The current file is one 3.37 MB line, rewritten roughly every 50 files.

**How resume works**
- There is no resume mode. Re-running rebuilds the plan from fresh PC hashes, a fresh tablet listing, and the record.
- A file is skipped iff `tb_size == f.size and r is not None and r.get("sha256") == f.sha256` (`sync:590-594`).
- A batch is recorded only if adb returns rc 0 for the **whole batch**. Files from a failed batch are re-pushed (overwritten) next run.
- Evidence:
  - The disconnect run recorded 600 Bleach files before the failing batch (`sync-log-20260706-221724.json:90-98`), and the 22:30 rerun finished 107 ok.
  - The 01:34 run logged `"ok": false, "error": null`. That is the Ctrl-C/BaseException signature: only `Exception` is caught (`sync:858`), but `finally` still writes the log (`sync:862-865`). It had deleted 131 files and pushed 1; the 01:35 run then pushed 130 with 0 deletes.

**Run log** (`sync-log-<ts>.json`)
- Rewritten atomically after every series (indent=2), `sync:890-904`.
- Keys: `started_at_iso`, `completed_at_iso`, `n_ok`, `n_fail`, `pushed_files`, `pushed_bytes`, `deleted_files`, `results[]`. Each result is `{target, pushed_files, pushed_bytes, deleted_files, duration_sec, ok, error}`.
- A 0-byte `sync-log-20260715-021752.json.tmp` (mtime 02:18:10) sits next to an intact `.json` (last write 02:17:56). That is consistent with a write interrupted mid-tmp.
- `_watch_progress.py:4-6` warns that reading the atomically rewritten JSON mid-run "can collide with the writer's os.replace on Windows and crash the run".

---

## 4. PC hash cache (`.pc_hash_cache.json`) and `--fast`

**Format**
- `{"entries": {"<str(abs_path)>": {"size": int, "mtime": float st_mtime, "sha256": hex}}}` (`sync:244-259`, `sync:303-305`).
- Keys are Windows absolute paths, e.g. `"D:\\AIO\\manga\\'Tis Time…\\Ch.001 - Torture 1.cbz"`.
- It currently has 22,902 entries against 22,168 in the state. **Entries are never pruned.**
- It is saved once, after hashing, with tmp + `os.replace` (`sync:255-259`, `sync:1069`).

**`--fast` logic** (`sync:283-288`)
```python
if c and c.get("size") == f.size and c.get("mtime") == f.mtime and c.get("sha256"):
```
- mtime is compared as an exact float.
- Without `--fast`, everything is re-hashed, but the cache is still refreshed (`sync:272-276`).

**Hashing**
- SHA-256 over 1 MiB chunks (`sync:236-241`).
- `ThreadPoolExecutor(max_workers=workers)` with `ex.map` (`sync:300-301`).
- `--workers` defaults to 8, applied as `max(1, args.workers)` (`sync:1025`, `sync:1067`). Progress prints every 200 files (`sync:308`).
- Observed: "hashed 20834 file(s) (142.3GB), 0 from cache" at about 5.8 GB/s (`synclogs07.md`).

**Tablet-side cache:** sync has none. `.tablet_cache.json` (v2 format `{version, device, tablet_root, scanned_at_unix, …, files:[{p,s,m}], dirs}`, `cm:571-625`) is used only by cm, pat and vp.

---

## 5. `--verify`

- **Scope:** `dirs = sorted(tablet_dirs & managed, key=str.casefold)` (`sync:753`). `managed` is every current PC target, not filtered by `--only`/`--skip` (`sync:1081-1085`).
- **Command:** see section 1 (`sync:369-373`). `rc` and `err` are **ignored**.
- **Parsing** (`sync:376-386`):
  - Skip the line if `len(line) < 68 or line[64:66] != "  "`.
  - `digest = line[:64]`, `apath = line[66:]`.
  - The path must start with `root + "/"`; dot basenames are skipped.
- **Merge** (`sync:763-767`):
  - Pop **all** record keys for that folder.
  - Then set `rec[rel] = {"size": tablet_files.get(rel, 0), "sha256": digest}`.
  - Flush after each folder.
- **Does it adopt everything it sees?** Yes, for managed folders: every non-dot file at any depth and any extension, whether or not the PC has it and whether or not the hash matches.
  - Mismatched hashes then get pushed.
  - Extra depth-1 files become delete candidates.
  - Nested files are recorded but never pushed or deleted.
  - Unmanaged folders are never recorded, on purpose (`sync:617-624`, `sync:745-747`).
- **Exceptions:** logged as "! hash failed" and skipped, leaving the record untouched (`sync:758-762`).
- **Hazard:** if adb fails without raising (device gone gives rc=1 and empty stdout), `hashes == {}`. The folder's record is then wiped and flushed, so the next plan re-pushes the whole folder.

---

## 6. Delete logic, prune, preserved vs orphaned

**Deletion candidates** (`sync:598-612`)
- The union of record keys and live-listing keys under `target/`, where the name has no `/` and is not in `desired_names`.
- `desired_names` is the set of PC content filenames: `*.cbz`, `cover.jpg`, `details.json`.
- Consequences:
  - Any depth-1 non-dot tablet file that isn't PC content gets deleted. That includes **.pdf chapters**, stray files, and truncated names like `…Mission 1.cb`.
  - Dotfiles such as `.nomedia` are never candidates, because they are excluded from the listing (`sync:347`).
  - Empty PC folders are skipped with a warning (`sync:558-560`).

**Per-series order** (`sync:804-857`)
1. `mkdir -p` the target.
2. `rm -f` the 4 sidecars, swallowing errors.
3. **Deletes first** ("frees space before the push", `sync:815`): one `rm -f` call, drop the keys from the record, flush.
4. ASCII batches.
5. Non-ASCII singles.

Series are processed in casefolded target order (`sync:577`).

**Prune**
- Only runs with `--apply --prune`, after the apply finishes (`sync:1117-1119`).
- Per orphan folder: `rm -rf`, drop its keys, flush. Errors are caught per folder (`sync:876-887`).

**Orphaned vs preserved** is decided by record membership (`sync:625-634`):
- **Orphaned** = a folder that appears as a record-key prefix but is not a current PC target. Computed over all PC folders, unfiltered. It is never auto-deleted.
- **Preserved** = a live tablet folder that is neither a PC target nor in the record.

**Other tools**
- pat does a whole-folder `rm -rf` of matched folders before pushing (`pat:703-707`). Its preserved set is tablet folders with no normalize/alias match (`pat:499-502`).
- vp hard-codes a check that `SHELTER` survived (`vp:128-135`).
- ops only ever runs single-file `rm -f`, documented as "NEVER -rf" (`ops:274`). mm skips nested files when building delete ops (`mm:546-548`).

---

## 7. Error handling

**Classification**
- There is **no regex classification** of adb errors. Success means rc == 0.
- sync raises `RuntimeError` strings; ops raises `TransferError(msg, stderr_tail, returncode)` (`ops:50-67`).
- The only places output is inspected:
  - The `-printf` fallback substring check (`cm:543`). It is effectively unreachable, because find's stderr goes to `/dev/null`.
  - `_PERCENT_RE = re.compile(r"(\d{1,3})%")` for progress (`ops:39`).
  - The `Y`/`N` check in `adb_path_exists`.
  - `resolve_device` keeps only rows whose state is `device` (`cm:473`), so offline and unauthorized devices are ignored.
  - `_watch_progress.py:22-24` scrapes run logs with `r'^\[\s*(\d+)/(\d+)\]'`, `r'^Done\.'` and `r'!! ERROR:'`.

**The "N files pushed" summary is not parsed anywhere.**
- sync's `pushed_files` counts files in batches that returned rc 0 (`sync:836-843`).
- pat's count comes from the plan, `e.pc_chapter_count` (`pat:760-761`).

**Error budget**
- Only tr has one: `error_budget: int = 3` **consecutive** failures, reset on success. Hitting it emits `batch_aborted_due_to_errors` with the last 3 errors (`tr:91`, `tr:208`, `tr:225-232`). mm never overrides it (`mm:771-776`).
- sync and pat have no budget: they catch per series and keep going (`sync:858-865`; `pat:685-687`: "partial completion is the expected mode if e.g. USB flickers mid-batch").

**Mid-run disconnect** (observed in `sync-log-20260706-221724.json`)
- The in-flight batch fails with rc=1.
- **Each of the remaining 106 series then fails in 0.03–0.04 s at `mkdir -p`** with `device … not found`.
- Final tally: n_ok 9, n_fail 107, exit code 2 (`sync:1121`).
- There is no reconnect, wait, or abort.

**Exit codes:** 2 for adb/device/listing failure or any failed series (`sync:1046-1048`, `sync:1076-1078`); 3 when the user aborts at the prompt; 0 otherwise.

---

## 8. `_validate_tablet_path` in `ops:86-107` (verbatim)

It uses these constants from `ops:46-47`: `_BAD_PATH_CHARS = ("\n", "\r", "\x00")` and `_MAX_PATH_LEN = 4096`.

```python
def _validate_tablet_path(path: str, root: str) -> None:
    if not isinstance(path, str) or not path:
        raise TransferError("empty tablet path")
    if len(path) > _MAX_PATH_LEN:
        raise TransferError(f"tablet path too long ({len(path)} bytes)")
    for ch in _BAD_PATH_CHARS:
        if ch in path:
            raise TransferError(f"tablet path contains forbidden char {ch!r}")
    norm_root = root.rstrip("/")
    if path == norm_root or path == norm_root + "/":
        raise TransferError(f"refusing to operate on tablet root itself: {path!r}")
    if not path.startswith(norm_root + "/"):
        raise TransferError(f"tablet path escapes root {norm_root!r}: {path!r}")
    for segment in path.split("/"):
        if segment == "..":
            raise TransferError(f"tablet path contains '..': {path!r}")
```
The docstring is omitted above. Note that `len(path)` counts characters, not bytes.

**There is a second copy, `pat:238-255`.** It takes one argument (the module's `TABLET_ROOT`), raises `ValueError`, and has **no length cap**; otherwise the logic is the same.
- sync uses the ops version for hashing, rm, rm -rf and both push types.
- sync's `mkdir_p` goes through the pat version.
- Neither version rejects `.` or empty segments; both rely on `shlex.quote` for shell metacharacters.

---

## 9. Alias and mapping tables

| Table | Where | Shape | Count | Two examples |
|---|---|---|---|---|
| `ALIASES_TABLET_TO_PC` | `pat:74-92` | dict tablet→PC | 14 | `"SPY_x_FAMILY": "SPY×FAMILY"`, `"CØDEBREAKER": "Code Breaker"` |
| `PC_TO_TABLET_ALIAS` | `sync:108-110` | dict comprehension inverting the above | 14 (self-test `sync:941-942`) | |
| `KEEP_TABLET_NAME_FOR_ALIASES` | `pat:100` | bool `True` | | |
| `PUSH_MAP` | `df:42-107` (one-off analyzer) | dict tablet→PC | 50 | `"A Certain Scientific Railgun"`→`"Toaru Majutsu no Index Gaiden…"`, `"Attack_on_Titan"`→`"Attack on Titan"` |
| `TABLET_TO_PC_ALIAS` | `_compare_tablet_vs_pc.py:43-60` (one-off) | dict tablet→PC | 9 | `"Record of Ragnarok"`→`"Shuumatsu no Valkyrie"`, `"No Longer Allowed In Another World"`→`"Isekai Shikkaku"` |
| `SIDECARS` | `sync:97` | tuple | 4: `.aio_series.json`, `.mangafire_hid`, `.series_hid`, `.cover.webp` | |
| `SIDECARS_ON_TABLET` | `pat:107` | tuple | 3 (same as above minus `.cover.webp`) | |
| `IGNORE_SERIES_FILES` | `cm:66` | set | 2: `.aio_series.json`, `.mangafire_hid` | |
| `IGNORE_TOP_LEVEL` | `cm:64` | set | 2: `.aio_coord`, `.aio_folder_alloc.lock` | |
| `CHAPTER_EXTS` | `_classify_tablet.py:27` (one-off) | set | 6: `pdf`, `cbz`, `zip`, `cbr`, `rar`, `epub` | |
| `bs.SERIES` | `bs:74-139` | list of (folder, query) | 64 (asserted, `bs:141`) | see section 11 |

**`is_content_file`** (`sync:168-173`): returns False if the name starts with `.`; otherwise True for `name.lower().endswith(".cbz")` or `name == "cover.jpg"` or `name == "details.json"`. **PDF is not content.**

**`resolve_target_name`** (`sync:219-228`):
- If `KEEP_TABLET_NAME_FOR_ALIASES` is set and the **raw** PC folder name is in `PC_TO_TABLET_ALIAS`, the result is `sanitize_tablet_segment(alias)`.
- Otherwise it is `sanitize_tablet_segment(pat._strip_hid(pc_folder))`.
- `sanitize_tablet_segment` (`ops:70-83`) applies NFKC, removes ``[/\\:*?\"<>|\x00-\x1f]``, trims whitespace and trailing dots, and raises on `""`, `"."` or `".."`.

---

## 10. compare_manga chapter parsing (`cm:71-107`, verbatim)

All patterns use `re.IGNORECASE`; the first match wins.
```python
RE_CH_SPACES      = r"^(?P<prefix>.+?)\s+Ch\s+(?P<label>\d+(?:[.~]\d+)?)\s*\.(?P<ext>pdf|cbz)$"            # "A"
RE_CH_UNDERSCORED = r"^(?P<prefix>.+?)_(?P<site>[a-z]+)_Ch_(?P<label>\d+(?:[.~]\d+)?)\s*\.(?P<ext>pdf|cbz)$"  # "B"
RE_CH_CHAP_TITLE  = r"^Chap\s+(?P<label>\d+(?:[.~]\d+)?)\b.*\.(?P<ext>pdf|cbz)$"                       # "C"
RE_CH_CHAPTER     = r"^Chapter\s+(?P<label>\d+(?:[.~]\d+)?)\s*\.(?P<ext>pdf|cbz)$"                     # "D"
RE_CH_HASH        = r"^#(?P<label>\d+)\s*-.*\.(?P<ext>pdf|cbz)$"                                       # "E"
RE_CH_VOL         = r"^Vol\s+(?P<label>\d+)\s*\.(?P<ext>pdf|cbz)$"                                     # "F"
RE_HID_SUFFIX = re.compile(r"^(.+?)\s*\(hid=(.*?)\)\s*$")
```

**Label handling**
- Canonicalization (`cm:258-277`): `~` becomes `.`; pure integers lose leading zeros; `N.0` becomes `N`; other decimals are kept as-is, so `315.01` stays distinct from `315.1`.
- Sort key (`cm:232-255`): `(main, 0|1, sub, lower)`; a missing label sorts last.

**hid strip**
- `pat._strip_hid` returns `m.group(1).strip()` (`pat:404-406`).
- `cm._strip_hid` returns `(group1.strip(), group2)` (`cm:324-328`).

**Current PC filenames are not parsed.** A live test with `python -B` gave `parse_chapter_label('Ch.001 - Torture 1.cbz') → (None, 'cbz', 'unmatched')`, and the same for `Ch.686.5 - x.cbz`. The only regex in the suite that handles this form is in `df:117-118`:
```python
r"^Ch\.0*(\d+(?:\.\d+)?)\s*(?:-.*)?\.(?:pdf|cbz)$"
```

**Volumes vs chapters: no distinction.**
- `Vol N` (pattern F) produces a label in the same namespace as chapters: `"Vol 1.pdf" → ("1","pdf","F")` (`cm:1398`). Only integer volume numbers are accepted.
- Duplicate labels are first-wins (`cm:796-823`), so `Vol 1` and `Ch 1` collide.
- Counts are plain file counts:
  - PC counts every `*.pdf`/`*.cbz`, including unmatched names (`cm:398-400`).
  - The tablet side counts every non-dot file at any depth and extension, including `cover.jpg` and `details.json` (`cm:676-717`, `cm:1308`).
  - pat and vp count only depth-1 pdf/cbz (`pat:521-541`, `vp:111-114`).

---

## 11. batch_search.py

**Query rules** (`bs:66-73`, verbatim):
```
# (tablet_folder, normalized_query) — folder is the literal tablet directory name,
# query is what we feed to search_all. Normalization rules:
#   - underscores -> spaces
#   - drop "(Official)" suffix (format hint, not part of title)
#   - keep "(Colored)" suffix (disambiguates a colored re-release)
#   - Vivy's wrapping dashes are dropped (search expects "Vivy Fluorite Eye's Song")
#   - "Is_the_order_a_rabbit" — official title has the trailing "?"
#   - everything else: just underscore -> space; AIO's rapidfuzz is forgiving
```
The table is hand-written, not computed at runtime. Examples: `("One-Punch_Man_(Official)", "One-Punch Man")` and `("SPY_x_FAMILY", "SPY x FAMILY")`.

**Probe deadline:** `_so.PROBE_PHASE_DEADLINE_S = 45.0` (`bs:62-64`). The comment says the default is 120 s; the current AIO repo default is **240.0** (`C:\Users\legoc\OneDrive\Belgeler\Scripts\AIO-Webtoon-Downloader\sites\search_orchestrator.py:284`).

**Invocation: in-process, not a subprocess** (`bs:40-54`).
- It runs `os.chdir` and `sys.path.insert` on `AIO_DIR = C:\Users\legoc\OneDrive\Belgeler\AIO-Webtoon-Downloader` (`bs:35`). **That path no longer exists**; the repo is now under `...\Scripts\`.
- It imports `search_all`, `ProbeFailureCache`, `ImageQualityCache`, `DEFAULT_*` from `sites.search_orchestrator`, and `_scraper_factory_for` and `_search_make_request_factory` from `aio_search_cli`.
- Setup: `_search_make_request_factory(timeout=args.search_timeout, attempts=2)`, with the argument `Namespace` built in `bs:144-161`.
- Call (`bs:228-240`):
  ```python
  search_all(query, factory, search_mr, language="en", parallelism=6,
             per_site_timeout_s=DEFAULT_PER_SITE_TIMEOUT_S, min_match=DEFAULT_MIN_MATCH,
             probe_failure_cache=probe_cache, img_quality_cache=img_cache,
             on_status=…, seeded_only=True)
  ```
  The caches are shared across all queries. The current `search_all` signature still accepts all of these arguments (`search_orchestrator.py:5517-5537`).
- Results: the top 5 `c.to_json()` go to `seed_links.json` via tmp + `os.replace` after each query (`bs:174-178`, `bs:267`). Error entries are retried on rerun (`bs:222`).

**fixup_seed_links.py** hand-overrides three entries (SHELTER, Tensura, Eleceed) and adds `manual_override` / `override_reason` fields. It writes non-atomically (`fs:110-111`).

---

## 12. `.nomedia`, `cover.jpg`, `details.json`, `.aio_series.json`

- **`.nomedia`:** never referenced by sync, pat, ops, tr or cm.
  - It appears only in ignore lists in three one-off scripts (`_classify_tablet.py:28`, `_compare_tablet_vs_pc.py:36`, `df:36`).
  - sync would never delete it, because it is a dotfile.
  - Both device dumps contain 0 of them.
- **`cover.jpg` and `details.json`:** mirrored as content (`sync:101-102`, `sync:173`), hashed and recorded (129 of each in the state).
  - **They are deleted from the tablet if absent on the PC.**
  - pat keeps them deliberately, since "Komikku reads them" (`pat:105-106`), and excludes them from chapter counts.
- **`.aio_series.json`:** never pushed by sync. It is `rm -f`'d from every managed folder on every apply (`sync:809-813`), and pat removes it after each folder push.
  - cm reads it on the **PC side** for title, status, site, format and chapters_downloaded (`cm:358-383`) and ignores it on the tablet.
- **`.cover.webp`:** only in sync's SIDECARS list. The June cache showed exactly one on the device.

---

## Log analysis

**(a) Disconnect text.** Only `sync-log-20260706-221724.json` has hits: 107 matching lines.

| Pattern | Occurrences |
|---|---|
| `RuntimeError: mkdir -p failed for '<root>/<target>': rc=1 stderr=adb.EXE: device 'A06B4A372090333' not found` | 106 (12 of them use a `"…"` repr because the name contains an apostrophe) |
| `adb: error: failed to read copy response: EOF` | 5, all inside the Bleach 800-char tail at line 98 (the real count is probably higher, since the tail is truncated) |
| `device offline`, `protocol fault`, `no devices` | 0 in every listed file |

`synclogs07.md`, `full_mirror_*.log`, `push_run.log` and `transfer-log-*.json` contain no disconnect text. The only other failure in the listed logs is at `push_run.log:575`: `mv: bad '…/SPY×FAMILY': No such file or directory`, caused by the truncation bug.

**(b) `[ NN%]` progress lines: 0 in every listed file** (and in the canary, full-mirror and plan logs too). The only percentages in the logs are the script's own hashing and "% of run" lines (37 in `synclogs07.md`).

adb's actual output shapes, with the pipe as stdout:
- Multi-file push, one line per file: `<src>: 1 file pushed, 0 skipped. 28.3 MB/s (12067303 bytes in 0.406s)`. There are 1,531 in `synclogs07.md`.
- Batch summary: `50 files pushed, 0 skipped. …`. There are 35 in `synclogs07.md`.
- Folder push, one line per folder: `<dir>\: N files pushed, 0 skipped. …`. There are 111 in `full_mirror_stderr.log`, 80 in `push_run.log`, and 2 in the canary log.
- The skipped count is 0 everywhere.

**(c) Yes, "files pushed" lines appear alongside failures.** The Bleach tail interleaves these two lines four times:
```
adb: error: failed to read copy response: EOF
D:\AIO\manga\Bleach\Ch.640 - …cbz: 1 file pushed, 0 skipped. 323.2 MB/s (4796630 bytes in 0.014s)
```
The reported rates of 170–323 MB/s are not real writes. The tail ends with `50 files pushed, 0 skipped. 41.2 MB/s (215486525 bytes in 4.985s)`, yet the exit code was 1. Separately, `push_run.log:573` reports `154 files pushed, 0 skipped` two lines before the mv failure at line 575.

---

## State file sample (`.sync_state-A06B4A372090333.json`)

- 3,371,594 bytes on a single line.
- Top-level keys, in order: `version` (1), `device` (`"A06B4A372090333"`), `tablet_root` (`"/storage/self/primary/Documents"`), `files`, `updated_at_iso` (`"2026-07-15T02:37:40.568958"`).
- `files` has 22,168 entries across 129 folders, all depth-1. They break down as 21,910 `.cbz`, 129 `cover.jpg` and 129 `details.json`. Every entry has the `{size, sha256}` shape, and none has size 0.
- Sample entry:
```json
"'Tis Time for Torture, Princess/Ch.001 - Torture 1.cbz": {"size": 7332980, "sha256": "eba7e4834deae877c5a91e3a7819500982b606d7fc4b1e61a98e4b2eac71603a"}
```
The same hash appears in `.pc_hash_cache.json` under the `D:\\AIO\\manga\\…` key, with `mtime` 1782147052.985332.

---

## Behaviours you probably don't want to copy as-is

1. **Verify wipes the record when adb fails quietly.** `rc` is ignored and stderr goes to `/dev/null`, so a disconnect during `--verify` empties that folder's record and forces a full re-push (`sync:373-386`, `sync:763-767`).
2. **Silent hangs are never timed out.** The stream timeout is only checked after a blocking read returns (`pat:198-201`), and adb prints nothing mid-file when writing to a pipe. The ops push path has no timeout at all.
3. **"N files pushed" can't be trusted.** adb prints "pushed" for files that got EOF errors, so rc is the only reliable success signal.
4. **The delete command isn't length-limited.** `rm_files` builds one unchunked command per series and could hit the 32 KB limit (`sync:400-401`).
5. **The `-printf` fallback can't trigger.** Its detection reads stderr that has already been sent to `/dev/null` (`cm:531-543`).
6. **Current PC chapter names don't parse in compare_manga.** Every `Ch.NNN - Title.cbz` file comes back unmatched.
7. **Tablet PDFs in managed folders get deleted.** PDF isn't PC content, so any depth-1 `.pdf` there is a delete candidate.
8. **The Flask push path (mm/tr/ops) doesn't handle the non-ASCII truncation bug,** and it doesn't strip the hid suffix when it creates a new folder.
9. **batch_search.py is stale.** Its `AIO_DIR` doesn't exist and its note about a 120 s probe default is outdated (the default is now 240 s).
