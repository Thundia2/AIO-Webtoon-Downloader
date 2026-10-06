# Workflow wf_e556ba67-39f — census:analysis-and-docs (phase Census)

```json
{
  "area": "analysis-and-docs",
  "summary": "These are one-off forensic scripts (underscore-prefixed) and two Markdown reports, built around a snapshot of 2026-05-23, with follow-ups on 2026-05-24 and 2026-06-14/15. They investigated how to move the Android tablet's Perfect Viewer library (/storage/self/primary/Documents/<Series>/, mostly PDFs in six legacy naming styles) to a Komikku-LocalSource-compatible layout: CBZ plus an exact 'cover.jpg' at the series root, with PDF unsupported (_classify_tablet.py:8-11). The route was pushing the PC AIO library (CBZ + cover.jpg + details.json, 0 PDFs) or re-downloading. None of the scripts modify either library; they work on an offline 'adb shell find' dump.\n\nPipeline:\n(1) tablet_files.txt dump: 12,981 paths in 67 flat series folders (11,926 .pdf, 1,016 .cbz).\n(2) _classify_tablet.py tags each series: 59 redownload, 1 redownload_pdfs, 6 add_cover, 1 ok (Eleceed).\n(3) _compare_tablet_vs_pc.py matches tablet to PC. It uses a normalizer (strip '(hid=X)', NFKC, casefold, '_'->space, drop apostrophes, punctuation->space) plus a 9-entry hand alias table, and recommends download / push / push-no-cover / push-pdfs / push-mixed / push-empty. The JSON says 13 download and 53 push; manual revision turned that into 15 fresh-download and 51 push.\n(4) _delta_findings.py diffs chapter-label sets for a 50-entry PUSH_MAP and tags causes: sub-chapter splits, Ch 0 prologues, PC ahead, tablet ahead, different numbering systems.\n\nDELTA_FINDINGS.md explains the 43 non-zero deltas and names 3 series where pushing would lose real chapters. REDOWNLOAD_FOR_KOMIKKU.md is the resulting checklist (sections A/B/C). The two .ps1 scripts are one-off PC inventories. _scan_pc_sizes.ps1 (May 24) found 84 folders and 0 PDFs at the old root. _scan_pc_repack.ps1 (Jun 14) found 111 series at the new root D:\\AIO\\manga, 110 of which had every CBZ rewritten that day. The later compare_manga.py verify report (_verify_report.*, Jun 15) exposed two port requirements: alias-unaware matching lists alias pairs as missing on both sides, and cover.jpg/details.json get flagged as orphans.\n\nDurable takeaways for the app:\n- reader-profile compatibility classification of the device library;\n- identity-based series matching with a UI-editable alias table;\n- persisted per-series overrides (force-download / accept-push / exclude / preserve / keep-device-name);\n- a chapter-level diff with a content-loss guard before any destructive push;\n- a threshold-based 'refresh PC first' list;\n- an alias- and sidecar-aware verification;\n- configurable PC root, device serial, device root(s), sidecar lists, filename patterns and thresholds. All of these are hard-coded today.\n\nMajor lesson: the label parser treated 'Vol N.pdf' volumes as chapters (12 of 67 series), which makes several 'PC ahead' diagnoses unreliable. Example: Sakamoto Days is Vol 1-24 without 21, not 23 chapters.",
  "features": [
    {
      "name": "Device library snapshot (recursive listing over adb)",
      "description": "Captures every file path under the device manga root in one adb call, then parses offline. The series is the first path component under the root. The classifier maps any deeper file to its top-level series; the delta scan skips nested files.",
      "source": "_classify_tablet.py:5-6, 40-57; _delta_findings.py:141-163; REDOWNLOAD_FOR_KOMIKKU.md:175-179",
      "durable": true,
      "notes": "Operator command: adb -s <serial> shell \"find <root> -mindepth 1 -type f -printf '%p\\n'\". toybox find lacks -printf %h (_verify_chapters.py:37-38), so derive the folder from the full path. The May dump had 67 flat folders, 0 loose files and 0 nested files (verified via tablet_files.txt stats). Serial, root and adb path must be settings."
    },
    {
      "name": "Reader-compatibility classification per device series",
      "description": "Per series: counts chapter archives by extension (pdf, cbz, zip, cbr, rar, epub) and checks for an exact 'cover.jpg' at the series root. Action is one of: pdf-only -> redownload; pdf+cbz -> redownload_pdfs (re-do only the PDF chapters); cbz without cover -> add_cover; cbz with cover -> ok; else -> empty. Result on 2026-05-23: 59 redownload, 1 redownload_pdfs (Fly Me to the Moon: 456 pdf + 4 cbz, the CBZs being the newest Ch 343-345 plus 299~5), 6 add_cover, 1 ok (Eleceed).",
      "source": "_classify_tablet.py:8-11, 27-28, 59-90; tablet_classify.json (67 entries); REDOWNLOAD_FOR_KOMIKKU.md:24-32",
      "durable": true,
      "notes": "Generalize into user-editable 'reader profiles'. Komikku: archives {cbz, zip, cbr, rar, epub}, PDF unsupported, cover.jpg required, details.json read at the series root. Perfect Viewer: pdf+cbz fine, no cover needed. Latent bug: the action logic only tests pdf and cbz (_classify_tablet.py:64-65, 73-82), so a zip/cbr/rar/epub-only series becomes 'empty'."
    },
    {
      "name": "Device-to-PC series matching (normalize + aliases + hid collapse + empty-variant filter + variant aggregation)",
      "description": "Each device series is matched to PC folders. The hand alias is applied first, otherwise the normalized name is used. PC variants with 0 chapter files (empty placeholder folders) are dropped, then extension counts and cover flags are aggregated across the remaining variants (e.g. a bare folder and its '(hid=X)' sibling).",
      "source": "_compare_tablet_vs_pc.py:20-22, 38-76, 79-109, 123-148",
      "durable": true,
      "notes": "The alias table must be UI-editable. The normalizer cannot bridge: '×' vs 'x' (SPY×FAMILY), 'Ø' (CØDEBREAKER), 'FULL METAL' vs 'Fullmetal', macrons (Ōsugiru), JP vs EN titles, or '(Official)' suffixes. Those need aliases. The later suite grew the table (push_all_to_tablet.py:74-91), so seed the UI from that one, not from these 9 entries. Reuse the app's hid-strip regex (aio-dl.py:949)."
    },
    {
      "name": "Per-series remediation recommendation",
      "description": "From the PC match, recommends: download (no populated PC match); push (PC has CBZ, no PDF, and every variant has cover.jpg); push-no-cover (CBZ but some variant lacks a cover); push-pdfs (PC is PDF-only); push-mixed (PC has PDF+CBZ); push-empty. Series already 'ok' are skipped. Sort order: download, push-pdfs, push-mixed, push-no-cover, push, push-empty, then casefolded name.",
      "source": "_compare_tablet_vs_pc.py:9-18, 119-181; tablet_vs_pc.json (66 entries: 13 download, 53 push)",
      "durable": true,
      "notes": "Only offer a push after combining with the chapter diff and user overrides. 'download' should hand off to the app's Search/queue (by device title or alias target). 'add_cover' could reuse the app's Komikku metadata writers."
    },
    {
      "name": "Chapter-level diff with cause tagging",
      "description": "Parses a chapter label from each chapter filename on both sides, then computes device-only / PC-only / shared label sets and tags causes: exact_match, pc_ahead_only, tablet_ahead_only, tablet_has_extra_sub_chapters_only, tablet_only_mixed, tablet_has_integer_chapters_in_pc_range, pc_has_extra_sub_chapters_only, pc_has_integer_chapters_in_tablet_range, pc_only_mixed, tablet_has_ch0_pc_does_not, pc_has_ch0_tablet_does_not, different_starting_chapter, unclassified. Unparsable files are listed separately. Output is sorted by |delta| descending.",
      "source": "_delta_findings.py:109-131, 186-258, 261-293; delta_findings.json (43 entries); DELTA_FINDINGS.md:31-48, 404-433",
      "durable": true,
      "notes": "43 of the 50 mapped series had non-zero deltas. Tag frequency in delta_findings.json: tablet_has_extra_sub_chapters_only 17, tablet_only_mixed 14, pc_only_mixed 11, pc_ahead_only 10, different_starting_chapter 10, tablet_has_ch0_pc_does_not 6, pc_has_integer_chapters_in_tablet_range 5, pc_has_extra_sub_chapters_only 5, pc_has_ch0_tablet_does_not 2, tablet_has_integer_chapters_in_pc_range 1. The port must treat volume files as a separate unit, accept the app's '[Vol.vv ]Ch.ccc - title.cbz' names, and show parsed labels for spot checks."
    },
    {
      "name": "Pre-push content-loss guard",
      "description": "Before a device folder is replaced with the PC copy, detect device-only INTEGER chapters (real published chapters the PC lacks), then block or warn and offer 'refresh PC first'. Documented cases: Horimiya (Ch 128-201, 74 chapters), Sentenced to Be a Hero (Ch 11-13), Fly Me to the Moon (Ch 168, 215).",
      "source": "DELTA_FINDINGS.md:62-63, 104-111, 113-122, 312-318, 387-400",
      "durable": true,
      "notes": "Losing only sub-chapter splits (.1/.5 mangafire scan pieces) was judged acceptable after a spot-check of one per series (DELTA_FINDINGS.md:52-56). Numbering-system mismatches (JoJo 5, Is the Order a Rabbit) were deliberately left out of the loss list (DELTA_FINDINGS.md:398-400) and need an explicit per-series decision."
    },
    {
      "name": "Per-series overrides / exceptions",
      "description": "User decisions that override the computed plan:\n- force a fresh download instead of a push when numbering systems differ (JoJo Parts 4 and 6);\n- keep the push despite a numbering mismatch 'per user direction' (JoJo Part 5; Is the Order a Rabbit 'treat like JoJo Part 5');\n- temporarily exclude a series whose PC copy is mid-re-download (Dragon Ball 'in flux');\n- mark an already-compliant series as done (Eleceed);\n- record re-downloads that changed a delta (Pandora Hearts -170 -> 0).",
      "source": "_compare_tablet_vs_pc.py:50-54, 121-122; _delta_findings.py:39-41, 105-106; REDOWNLOAD_FOR_KOMIKKU.md:60-67, 93, 110, 192, 207-219; DELTA_FINDINGS.md:64-66, 124-132, 431-432",
      "durable": true,
      "notes": "Today these exist only as code comments, map omissions and hand edits to Markdown, which is why tablet_vs_pc.json still says 'push' for JoJo 4 and 6. In the app they must be persisted per-series (ideally per-device) settings: exclude, force-download, never-push, accept-loss, keep-device-folder-name (push_all_to_tablet.py:100), and preserve-device-only (SHELTER, verify_push.py:12-14)."
    },
    {
      "name": "Shortfall list: PC behind device (threshold)",
      "description": "Lists series where PC chapters minus device chapters is at or below a threshold (-50 in the doc) and recommends re-running the AIO updater before pushing.",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:17-22, 154-169",
      "durable": true,
      "notes": "The threshold must be a setting. On 2026-05-23 the list was: JoJo 5 (324/155/-169), Horimiya (254/142/-112), Fly Me to the Moon (460/370/-90), Is the Order a Rabbit (184/97/-87), One-Punch Man (299/245/-54), SPY×FAMILY (204/150/-54). Each row should link to the app's library update check / download for that series."
    },
    {
      "name": "Remediation plan / checklist report",
      "description": "A grouped, checkable plan:\n- A. Fresh download: A.1 not on PC; A.2 PC folder exists but uses a different numbering source.\n- B. Push from PC: B.1 from PDF-only, B.2 from mixed, B.3 from CBZ-missing-cover. Columns: device chapters, PC chapters, delta, PC folder.\n- C. Already compliant.\nPlus a bucket x action summary matrix and a methodology/alias appendix.",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:24-150, 173-205",
      "durable": true,
      "notes": "In the app this becomes a table with per-row status (pending/done, replacing the doc's manual [ ]/[x]), bucket filters, and an optional Markdown/JSON export."
    },
    {
      "name": "Unparsable / whole-series-dump detection",
      "description": "Flags chapter-extension files that are not chapter-numbered and excludes them from counts. The 6 examples are single whole-series PDFs: 'Bleach.pdf', 'Dragon Ball.pdf', 'A Certain Scientific Railgun.pdf', and 'That_Time_I_Got_Reincarnated_as_a_Slime_mangafire.pdf' / 'JoJo's_Bizarre_Adventure_Part_5_Golden_Wind_mangafire.pdf' / 'JoJo's_Bizarre_Adventure_Part_6_Stone_Ocean_mangafire.pdf'.",
      "source": "_delta_findings.py:158-160, 178-181; DELTA_FINDINGS.md:426-429; tablet_files.txt",
      "durable": true,
      "notes": "The classifier counted these as chapters, so classify totals are 1 higher than the label totals: Bleach 742 vs 741, JoJo 5 324 vs 323, Railgun 236 vs 235, Slime 183 vs 182 (tablet_classify.json vs delta_findings.json)."
    },
    {
      "name": "PC library inventory (size / format / cover / metadata presence)",
      "description": "Per PC series folder: size in MB, cbz and pdf counts, cover.jpg present, .aio_series.json present. Emits JSON plus a total in GB.",
      "source": "_scan_pc_sizes.ps1:1-23; _pc_sizes.json",
      "durable": true,
      "notes": "Useful for estimating transfer size and checking free space before a push, and as a health check for missing cover or metadata. Overlaps the app's scanLibrary (UI-source/electron/library.js:616), which already accepts cover.jpg/png/webp/jpeg (library.js:735). The 2026-05-24 result was 84 folders, 0 PDFs, all with cover and .aio_series.json."
    },
    {
      "name": "PC repack-scope diagnostic (full re-mirror vs metadata-only sync)",
      "description": "Per PC series: cbz count and bytes, min/max cbz mtime, cover.jpg/details.json presence and mtime, and .series_hid presence, plus day-histograms of newest-cbz and cover mtimes. Used once to decide whether a library-wide repack forces a full re-mirror to the tablet.",
      "source": "_scan_pc_repack.ps1:1-43; _pc_repack.json",
      "durable": false,
      "notes": "LESSON: on 2026-06-14, 110 of 111 series had every CBZ rewritten (min and max mtime the same day, e.g. 21:48:39-21:48:43 for 'Tis Time, _pc_repack.json:6-7), along with cover and details. mtime/size-based sync would re-push roughly 165 GB. The port needs content hashing and a separate metadata-only (cover.jpg/details.json) sync path."
    },
    {
      "name": "One-time PDF-to-Komikku migration analysis (the May-2026 investigation itself)",
      "description": "The concrete 66-series plan (51 push, 15 fresh download), the per-series delta narratives, and the manual revisions.",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:1-220; DELTA_FINDINGS.md:1-433",
      "durable": false,
      "notes": "LESSONS: (a) mangafire scan sources split chapters into .1/.5 pieces and add Ch 0 / 0.x prologues, while published-numbering sources don't, so label sets legitimately differ. (b) Some series use entirely different numbering systems (mangafire running scan count vs published): JoJo 4/5/6 and Is the Order a Rabbit. These can't be auto-reconciled and need a user decision. (c) Positive deltas mostly meant the PC was re-downloaded after the snapshot. (d) Series lists and counts are snapshot data; only the decision types become settings."
    },
    {
      "name": "Post-sync verification report (must be alias-aware and sidecar-aware)",
      "description": "After a push or sync, compares PC against the device per series (chapter-exact) and summarizes matched / PC-only / device-only / gaps / anomalies. Here it was compare_manga.py's _verify_report.txt/.json on 2026-06-15: 111 PC folders, 112 device folders, 97 matched, 19,574 vs 20,006 chapter files (164.9 vs 167.4 GB).",
      "source": "_verify_report.txt:1-15; _verify_report.json:1-22, 150-155, 227-240, 1490-1503; compare_manga.py:1242-1248, 1314",
      "durable": true,
      "notes": "Must share the sync's alias table and sidecar whitelist. Without them, alias pairs appear as 14 PC-only plus 15 device-only, and all 97 matched series get 2 'orphan' warnings (cover.jpg, details.json). _verify_chapters.py:1-8 shows the alias-aware variant (via push_all_to_tablet.build_plan)."
    },
    {
      "name": "Configurable device target layouts",
      "description": "Three distinct device-side layouts:\n(1) Perfect Viewer tree: /storage/self/primary/Documents/<Series>/, flat, PDF/CBZ in 6 legacy naming conventions, dot-sidecars (.mangafire_hid in 22 series, .aio_series.json in 15), no cover.\n(2) Komikku-compliant inside the same tree: <Series>/Ch.NNN - <title>.cbz + cover.jpg + details.json. Eleceed ('Ch.001 - Episode 1.cbz') was the only example on 2026-05-23.\n(3) The app's own Komikku LocalSource convention: <SAF-root>/local/<Title>/[Vol.vv ]Ch.ccc - <title>.cbz with per-chapter ComicInfo.xml, cover.jpg and details.json.\nDevice folder names can differ from PC names; the later tool keeps the device name for aliased series.",
      "source": "_classify_tablet.py:6-11, 26; compare_manga.py:5-6; tablet_files.txt; aio-dl.py:4958-4975, 12975-12980; push_all_to_tablet.py:100, 102-107; sync_to_tablet.py:97-102",
      "durable": true,
      "notes": "The port needs per-target settings: device serial, root path, reader profile, folder-naming policy (keep device name vs PC name), sidecars to mirror (cover.jpg, details.json), and sidecars to strip (.aio_series.json, .mangafire_hid, .series_hid, .cover.webp)."
    }
  ],
  "hardcodes": [
    {
      "script": "_classify_tablet.py",
      "name": "ROOT",
      "value": "/storage/self/primary/Documents/",
      "purpose": "Device manga root (Perfect Viewer tree); only dump lines starting with it are parsed",
      "source": "_classify_tablet.py:26",
      "should_be_user_setting": true
    },
    {
      "script": "_classify_tablet.py",
      "name": "CHAPTER_EXTS",
      "value": "{pdf, cbz, zip, cbr, rar, epub}",
      "purpose": "Extensions counted as chapter archives (Komikku-supported set + pdf)",
      "source": "_classify_tablet.py:27",
      "should_be_user_setting": true
    },
    {
      "script": "_classify_tablet.py",
      "name": "IGNORE_FILES (+ dotfile rule)",
      "value": "{.aio_series.json, .mangafire_hid, details.json, .nomedia}; additionally every basename starting with '.' is skipped",
      "purpose": "Sidecars excluded from chapter counts",
      "source": "_classify_tablet.py:28, 50",
      "should_be_user_setting": true
    },
    {
      "script": "_classify_tablet.py",
      "name": "Cover rule",
      "value": "exact, case-sensitive 'cover.jpg' at the SERIES folder root",
      "purpose": "Komikku LocalSource cover requirement",
      "source": "_classify_tablet.py:10-11, 66",
      "should_be_user_setting": true
    },
    {
      "script": "_classify_tablet.py",
      "name": "Action rules",
      "value": "pdf AND cbz -> redownload_pdfs; pdf only -> redownload; cbz without cover -> add_cover; cbz with cover -> ok; otherwise -> empty (zip/cbr/rar/epub ignored by these rules)",
      "purpose": "Map format and cover state to a remediation action",
      "source": "_classify_tablet.py:68-82",
      "should_be_user_setting": false
    },
    {
      "script": "_classify_tablet.py",
      "name": "Default dump path",
      "value": "/tmp/tablet_files.txt",
      "purpose": "Input when no argv[1] is given",
      "source": "_classify_tablet.py:96-97",
      "should_be_user_setting": false
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "PC_ROOT",
      "value": "C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas (path no longer exists; the library later lived at D:\\AIO\\manga)",
      "purpose": "PC library scanned live",
      "source": "_compare_tablet_vs_pc.py:34",
      "should_be_user_setting": true
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "IGNORE_TOP",
      "value": "{.aio_coord, .aio_folder_alloc.lock}; plus any top-level entry starting with '.' and non-directories",
      "purpose": "Skip the app's internal files at the library root",
      "source": "_compare_tablet_vs_pc.py:35, 83-86",
      "should_be_user_setting": false
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "IGNORE_FILES",
      "value": "{.aio_series.json, .mangafire_hid, .nomedia}; plus dotfiles",
      "purpose": "Sidecars excluded from PC chapter counts",
      "source": "_compare_tablet_vs_pc.py:36, 97",
      "should_be_user_setting": true
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "TABLET_TO_PC_ALIAS (all 9 entries; key = tablet folder, value = PC folder before normalization)",
      "value": "'A Certain Scientific Railgun' -> 'Toaru Majutsu no Index Gaiden Toaru Kagaku no Railgun'; 'CØDEBREAKER' -> 'Code Breaker'; 'Is_the_order_a_rabbit' -> 'Gochuumon wa Usagi desu ka'; 'JoJo's Bizarre Adventure Part 5 Golden Wind' -> 'JoJo no Kimyou na Bouken Part 5 - Ougon no Kaze'; 'Makeine Make Hiroin ga Ōsugiru!' -> 'Too Many Losing Heroines!'; 'No Longer Allowed In Another World' -> 'Isekai Shikkaku'; 'One-Punch_Man_(Official)' -> 'One-Punch Man'; 'Record of Ragnarok' -> 'Shuumatsu no Valkyrie'; 'SPY_x_FAMILY' -> 'SPY×FAMILY' (× is U+00D7, REDOWNLOAD_FOR_KOMIKKU.md:197)",
      "purpose": "Bridge device names that normalization cannot match to PC folders (JP titles, alternate EN titles, stylized characters)",
      "source": "_compare_tablet_vs_pc.py:38-60; duplicated in REDOWNLOAD_FOR_KOMIKKU.md:189-197",
      "should_be_user_setting": true
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "Deliberate non-alias exception",
      "value": "JoJo Parts 4 and 6 deliberately NOT aliased: PC folders use published-chapter numbering, while the tablet uses mangafire scan numbering with sub-chapters (e.g. Ch_439.1); handled as fresh download (REDOWNLOAD A.2)",
      "purpose": "Prevent a non-1:1 push",
      "source": "_compare_tablet_vs_pc.py:50-54",
      "should_be_user_setting": true
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "RE_HID",
      "value": "^(.+?)\\s*\\(hid=(.*?)\\)\\s*$",
      "purpose": "Strip the app's '(hid=X)' collision suffix before matching",
      "source": "_compare_tablet_vs_pc.py:62, 68-70",
      "should_be_user_setting": false
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "_APOS / _PUNCT normalization tables",
      "value": "deleted: ' ’ ‘ ; mapped to space: \" “ ” , . ! ? : ; ( ) [ ] - – — / ; plus NFKC, casefold, '_' -> ' ', whitespace collapse",
      "purpose": "Series-name normalization",
      "source": "_compare_tablet_vs_pc.py:63-64, 67-76",
      "should_be_user_setting": false
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "PC chapter extensions",
      "value": "(pdf, cbz, zip, cbr, rar, epub)",
      "purpose": "PC chapter counting",
      "source": "_compare_tablet_vs_pc.py:101",
      "should_be_user_setting": true
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "Empty-variant filter",
      "value": "drop PC matches whose total_chapters == 0 (comment cites the empty EN-named JoJo Part 4 / Part 6 Stone Ocean folders)",
      "purpose": "Ignore placeholder folders",
      "source": "_compare_tablet_vs_pc.py:130-133",
      "should_be_user_setting": false
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "rec_order",
      "value": "download 0, push-pdfs 1, push-mixed 2, push-no-cover 3, push 4, push-empty 5, unknown 99; then casefolded tablet name",
      "purpose": "Report sort order",
      "source": "_compare_tablet_vs_pc.py:178-181",
      "should_be_user_setting": false
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "name": "Inputs/outputs",
      "value": "reads ./tablet_classify.json (CWD-relative); skips action=='ok' ('Eleceed — already compliant'); JSON to stdout",
      "purpose": "I/O contract",
      "source": "_compare_tablet_vs_pc.py:113-122, 183",
      "should_be_user_setting": false
    },
    {
      "script": "_delta_findings.py",
      "name": "PC_ROOT / TABLET_DUMP / TABLET_ROOT",
      "value": "C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas ; tablet_files.txt (CWD-relative) ; /storage/self/primary/Documents/",
      "purpose": "Inputs",
      "source": "_delta_findings.py:31-33",
      "should_be_user_setting": true
    },
    {
      "script": "_delta_findings.py",
      "name": "SKIP_BASENAMES",
      "value": "{.aio_series.json, .mangafire_hid, .nomedia, details.json, cover.jpg}; plus dotfiles; only .pdf/.cbz count as chapter files",
      "purpose": "Keep sidecars out of the diff and the unparsed list",
      "source": "_delta_findings.py:35-37, 134-138",
      "should_be_user_setting": true
    },
    {
      "script": "_delta_findings.py",
      "name": "PUSH_MAP (all 50 entries; tablet name -> PC folder; 'same' = identical name)",
      "value": "'Tis Time for Torture, Princess -> same; A Certain Scientific Railgun -> Toaru Majutsu no Index Gaiden Toaru Kagaku no Railgun; A Couple of Cuckoos -> same; Angel Beats! Heaven's Door -> Angel Beats! - Heaven's Door; Attack_on_Titan -> Attack on Titan; Berserk -> same; Bleach -> same; Bungo Stray Dogs -> Bungo Stray Dogs (hid=PW1SJ); Chainsaw Man -> same; Claymore -> same; CØDEBREAKER -> Code Breaker; Demon_Slayer_Kimetsu_no_Yaiba -> Demon Slayer Kimetsu no Yaiba; EDENS ZERO -> same; Fly Me to the Moon -> same; Horimiya -> same; I Was Supposed to Never Fall in Love with You -> same; Is_the_order_a_rabbit -> Gochuumon wa Usagi desu ka; JoJo's Bizarre Adventure Part 5 Golden Wind -> JoJo no Kimyou na Bouken Part 5 - Ougon no Kaze; JoJo's_Bizarre_Adventure_Part_1_Phantom_Blood -> JoJo's Bizarre Adventure Part 1 Phantom Blood; JoJo's_Bizarre_Adventure_Part_2_Battle_Tendency -> JoJo's Bizarre Adventure Part 2 Battle Tendency; JoJo's_Bizarre_Adventure_Part_3_Stardust_Crusaders -> JoJo's Bizarre Adventure Part 3 Stardust Crusaders; Kagurabachi -> same; Komi_Can't_Communicate -> Komi Can't Communicate; Konosuba God's Blessing on This Wonderful World! -> Konosuba God's Blessing on This Wonderful World! (hid=gvHMj); Link Click -> same; Lycoris_Recoil -> Lycoris Recoil; Makeine Make Hiroin ga Ōsugiru! -> Too Many Losing Heroines!; My youth romantic comedy is wrong as I expected -> My Youth Romantic Comedy Is Wrong, As I Expected; No Longer Allowed In Another World -> Isekai Shikkaku; One-Punch_Man_(Official) -> One-Punch Man; Pandora Hearts -> same; Pandora Seven -> same; Record of Ragnarok -> Shuumatsu no Valkyrie; Rinjin-chan ga Shinpai -> same; Sakamoto Days -> same; Sentenced to Be a Hero The Prison Records of Penal Hero Unit 9004 -> same; Shiunji-ke no Kodomotachi -> same; Sleepy Princess in the Demon Castle -> same; Solo Leveling -> same; SPY_x_FAMILY -> SPY×FAMILY; Talentless Nana -> same; That Time I Got Reincarnated as a Slime -> same; The Angel Next Door Spoils Me Rotten -> same; The Angel Next Door Spoils Me Rotten After the Rain -> same; The Legend of the Northern Blade -> same; Tower of God -> same; Undead Unluck -> same; Vivy_-Fluorite_Eye's_Song- -> Vivy -Fluorite Eye's Song-; You and I are Polar Opposites -> You and I Are Polar Opposites; You are Ms. Servant -> You Are Ms. Servant",
      "purpose": "Exact device -> PC folder pairs for the push-from-PC set (derived from the REDOWNLOAD B.1/B.2/B.3 tables)",
      "source": "_delta_findings.py:39-104",
      "should_be_user_setting": true
    },
    {
      "script": "_delta_findings.py",
      "name": "PUSH_MAP exclusions",
      "value": "Dragon Ball omitted ('PC is mid-redownload and counts are in flux'); JoJo Parts 4 and 6 omitted (moved to fresh-download after manual revision)",
      "purpose": "Per-series exclusion from analysis",
      "source": "_delta_findings.py:39-41, 105-106; DELTA_FINDINGS.md:431-432",
      "should_be_user_setting": true
    },
    {
      "script": "_delta_findings.py",
      "name": "Source-site tags in underscored tablet filenames",
      "value": "mangafire | comix | comickfun | mangadex | asura | asurascans (only mangafire, 3,717 files, and comix, 28 files, occur in tablet_files.txt)",
      "purpose": "Recognize '<Series>_<site>_Ch_<N>.pdf' names",
      "source": "_delta_findings.py:114-116",
      "should_be_user_setting": true
    },
    {
      "script": "_delta_findings.py",
      "name": "Chapter-label regexes (ordered; first match wins; '~' -> '.' afterwards)",
      "value": "(1) _RE_TABLET_UNDERSCORED, search, IGNORECASE: _(?:mangafire|comix|comickfun|mangadex|asura|asurascans)_Ch_(\\d+(?:[.~]\\d+)?)\\s*\\.(?:pdf|cbz)$ ; (2) _RE_TABLET_SPACES, search: ' Ch\\s+(\\d+(?:[.~]\\d+)?)\\s*\\.(?:pdf|cbz)$' ; (3) _RE_PC_DOTTED, match: ^Ch\\.0*(\\d+(?:\\.\\d+)?)\\s*(?:-.*)?\\.(?:pdf|cbz)$ ; (4) _RE_GENERIC_CHAP, match: ^Chap(?:ter)?\\s+(\\d+(?:\\.\\d+)?)\\b ; (5) _RE_HASH, match: ^#(\\d+(?:\\.\\d+)?)\\s*- ; (6) _RE_VOL, match: ^Vol\\s+(\\d+(?:\\.\\d+)?)\\s*\\.(?:pdf|cbz)$",
      "purpose": "Extract comparable chapter labels from 6 naming conventions",
      "source": "_delta_findings.py:109-131",
      "should_be_user_setting": true
    },
    {
      "script": "_scan_pc_repack.ps1",
      "name": "$root",
      "value": "D:\\AIO\\manga",
      "purpose": "PC library root (new location)",
      "source": "_scan_pc_repack.ps1:6",
      "should_be_user_setting": true
    },
    {
      "script": "_scan_pc_repack.ps1",
      "name": "Probed sidecars + output path",
      "value": "cover.jpg, details.json, .series_hid ; output C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\_pc_repack.json",
      "purpose": "Repack-scope measurement",
      "source": "_scan_pc_repack.ps1:10-12, 32",
      "should_be_user_setting": false
    },
    {
      "script": "_scan_pc_sizes.ps1",
      "name": "$path / exclusion / output",
      "value": "C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas ; excludes directory '.aio_coord' ; checks cover.jpg and .aio_series.json ; output C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\_pc_sizes.json",
      "purpose": "PC size and format inventory",
      "source": "_scan_pc_sizes.ps1:1-3, 10-11, 21",
      "should_be_user_setting": true
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "Device serial",
      "value": "3CEF42502E91537 (also _verify_report.json:6). The folder also contains .sync_state-A06B4A372090333.json (Jul 15), which suggests a second serial.",
      "purpose": "adb target device",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:4, 177",
      "should_be_user_setting": true
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "Komikku spec reference",
      "value": "../../AIO-Webtoon-Downloader/komikkuspec.md (dead link: absent at that path, in the repo, and in git history)",
      "purpose": "Source of the Komikku layout rules",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:6; _classify_tablet.py:8",
      "should_be_user_setting": false
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "Shortfall threshold",
      "value": "delta <= -50 (PC minus tablet)",
      "purpose": "Which series to refresh on PC before pushing",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:154-160",
      "should_be_user_setting": true
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "A.1 fresh-download list, not on PC (13; tablet PDF counts)",
      "value": "DARLING in the FRANXX 8; Daughter of the Spirit King 170; Every Day Is a Holiday (Colored) 310; Fullmetal Alchemist 311; Ghost Sore wa rei no Shiwaza desu 7; Let's do it already 9; Like a Butterfly 12; My Dress-Up Darling 14; No More Love With the Girls 143; SHELTER 210; Slow Life In Another World (I Wish!) 8; The Reincarnation Magician of the Inferior Eyes 16; Zom 100 Bucket List of the Dead 18. Note: several are 'Vol N.pdf' volumes, not chapters. Four later matched PC folders under JP/variant names via push_all_to_tablet.py:78-91 (Kinenbi Manga, FULL METAL ALCHEMIST, Sore wa rei no Shiwaza desu, Isekai de Slow Life o (Ganbou)).",
      "purpose": "Computed snapshot list",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:44-58",
      "should_be_user_setting": false
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "A.2 numbering-mismatch force-fresh-download list (2)",
      "value": "JoJo's_Bizarre_Adventure_Part_4_Diamond_is_Unbreakable (tablet 546 PDF mangafire-scan up to Ch 439.1; PC 'JoJo no Kimyou na Bouken Part 4 - Diamond wa Kudakenai' 174 published); JoJo's Bizarre Adventure Part 6 Stone Ocean (tablet 494 PDF up to Ch 752.1; PC 'JoJo's Bizarre Adventure Part 6 Stone Ocean (hid=t4U07)' 158 published)",
      "purpose": "User override: push is not 1:1, so re-download under the tablet-style name",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:60-67, 209-214",
      "should_be_user_setting": true
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "B.1 push list, from PDF-only (44; tablet/PC/delta -> PC folder)",
      "value": "'Tis Time for Torture, Princess 294/285/-9 -> same; A Certain Scientific Railgun 236/189/-47 -> Toaru Majutsu no Index Gaiden Toaru Kagaku no Railgun; A Couple of Cuckoos 291/297/+6 -> same; Angel Beats! Heaven's Door 89/85/-4 -> Angel Beats! - Heaven's Door; Attack_on_Titan 142/147/+5 -> Attack on Titan; Berserk 400/389/-11 -> same; Bleach 742/694/-48 -> same; Bungo Stray Dogs 167/137/-30 -> Bungo Stray Dogs (hid=PW1SJ); Chainsaw Man 215/293/+78 -> same; Claymore 159/154/-5 -> same; CØDEBREAKER 236/233/-3 -> Code Breaker; Demon_Slayer_Kimetsu_no_Yaiba 244/237/-7 -> Demon Slayer Kimetsu no Yaiba; Dragon Ball 545/in flux -> same; EDENS ZERO 293/293/= -> same; Horimiya 254/142/-112 -> same; I Was Supposed to Never Fall in Love with You 45/45/= -> same; Is_the_order_a_rabbit 184/97/-87 -> Gochuumon wa Usagi desu ka; JoJo's Bizarre Adventure Part 5 Golden Wind 324/155/-169 -> JoJo no Kimyou na Bouken Part 5 - Ougon no Kaze; JoJo's_Bizarre_Adventure_Part_1_Phantom_Blood 44/49/+5 -> JoJo's Bizarre Adventure Part 1 Phantom Blood; JoJo's_Bizarre_Adventure_Part_2_Battle_Tendency 113/117/+4 -> JoJo's Bizarre Adventure Part 2 Battle Tendency; JoJo's_Bizarre_Adventure_Part_3_Stardust_Crusaders 445/403/-42 -> JoJo's Bizarre Adventure Part 3 Stardust Crusaders; Komi_Can't_Communicate 526/505/-21 -> Komi Can't Communicate; Konosuba God's Blessing on This Wonderful World! 136/133/-3 -> Konosuba God's Blessing on This Wonderful World! (hid=gvHMj); Link Click 41/41/= -> same; Lycoris_Recoil 21/21/= -> Lycoris Recoil; Makeine Make Hiroin ga Ōsugiru! 4/25/+21 -> Too Many Losing Heroines!; My youth romantic comedy is wrong as I expected 97/89/-8 -> My Youth Romantic Comedy Is Wrong, As I Expected; No Longer Allowed In Another World 11/62/+51 -> Isekai Shikkaku; One-Punch_Man_(Official) 299/245/-54 -> One-Punch Man; Pandora Hearts 277/277/= -> same (PC re-downloaded); Pandora Seven 19/54/+35 -> same; Record of Ragnarok 119/132/+13 -> Shuumatsu no Valkyrie; Rinjin-chan ga Shinpai 5/152/+147 -> same; Sakamoto Days 23/258/+235 -> same; Sentenced to Be a Hero The Prison Records of Penal Hero Unit 9004 15/10/-5 -> same; Sleepy Princess in the Demon Castle 455/453/-2 -> same; SPY_x_FAMILY 204/150/-54 -> SPY×FAMILY; That Time I Got Reincarnated as a Slime 183/167/-16 -> same; The Legend of the Northern Blade 207/206/-1 -> same; Tower of God 652/653/+1 -> same; Undead Unluck 259/240/-19 -> same; Vivy_-Fluorite_Eye's_Song- 7/7/= -> Vivy -Fluorite Eye's Song-; You and I are Polar Opposites 80/67/-13 -> You and I Are Polar Opposites; You are Ms. Servant 92/87/-5 -> You Are Ms. Servant",
      "purpose": "Computed snapshot push plan",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:77-124",
      "should_be_user_setting": false
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "B.2 / B.3 / C lists",
      "value": "B.2 (mixed): Fly Me to the Moon (456 pdf + 4 cbz) 460/370/-90 -> same. B.3 (CBZ, no cover): Kagurabachi 124/126/+2; Shiunji-ke no Kodomotachi 71/72/+1; Solo Leveling 245/201/-44; Talentless Nana 119/119/=; The Angel Next Door Spoils Me Rotten 29/32/+3; The Angel Next Door Spoils Me Rotten After the Rain 39/40/+1 (all -> same). C (compliant): Eleceed, 385 CBZ + cover.jpg, PC 385.",
      "purpose": "Computed snapshot plan",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:126-150",
      "should_be_user_setting": false
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "Shortfall table (6)",
      "value": "JoJo's Bizarre Adventure Part 5 (Golden Wind) 324/155/-169; Horimiya 254/142/-112; Fly Me to the Moon 460/370/-90; Is the Order a Rabbit (Gochuumon wa Usagi desu ka) 184/97/-87; One-Punch Man 299/245/-54; SPY×FAMILY 204/150/-54",
      "purpose": "Computed with the -50 threshold",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:162-169",
      "should_be_user_setting": false
    },
    {
      "script": "REDOWNLOAD_FOR_KOMIKKU.md",
      "name": "Manual revisions (overrides)",
      "value": "JoJo Part 4 and Part 6 moved B.1 -> A.2; Pandora Hearts PC re-downloaded (277 cbz, originally delta -170); Dragon Ball 'in flux', assumed to reach 545 before push (PC had 574 cbz on 2026-05-24 per _pc_sizes.json)",
      "purpose": "User decisions layered on the computed plan",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:207-219",
      "should_be_user_setting": true
    },
    {
      "script": "DELTA_FINDINGS.md",
      "name": "Content-loss list (push would lose real chapters)",
      "value": "Horimiya: tablet ahead by 74 (Ch 128-201); Sentenced to Be a Hero: 3 (Ch 11, 12, 13); Fly Me to the Moon: 2 (Ch 168, 215)",
      "purpose": "Computed; refresh the PC copy before pushing",
      "source": "DELTA_FINDINGS.md:387-400",
      "should_be_user_setting": false
    },
    {
      "script": "DELTA_FINDINGS.md",
      "name": "Numbering-mismatch series kept as push 'per user direction'",
      "value": "JoJo's Bizarre Adventure Part 5 Golden Wind (kept as push); Is the Order a Rabbit ('Treat like JoJo Part 5')",
      "purpose": "User override accepting the published-numbering view",
      "source": "DELTA_FINDINGS.md:64-66, 87-95, 124-132; REDOWNLOAD_FOR_KOMIKKU.md:192",
      "should_be_user_setting": true
    },
    {
      "script": "DELTA_FINDINGS.md",
      "name": "Delta-magnitude heuristics",
      "value": "[-50, -1] ~ sub-chapter splits (+ Ch 0 prologue); <= -85 ~ different numbering system; positive ~ PC re-downloaded after the snapshot",
      "purpose": "Human interpretation guide",
      "source": "DELTA_FINDINGS.md:14-29",
      "should_be_user_setting": false
    },
    {
      "script": "_verify_report.json (compare_manga.py output)",
      "name": "pc_root / tablet_root / device",
      "value": "D:\\AIO\\manga ; /storage/self/primary/Documents ; 3CEF42502E91537",
      "purpose": "Roots and serial used by the 2026-06-15 verification run",
      "source": "_verify_report.json:4-6; _verify_report.txt:3-4",
      "should_be_user_setting": true
    }
  ],
  "algorithms": [
    {
      "name": "Series-name normalization",
      "description": "Strip a trailing '(hid=X)', apply NFKC and casefold, replace '_' with a space, delete ' ’ ‘, map \" “ ” , . ! ? : ; ( ) [ ] - – — / to spaces, collapse whitespace, trim. It does NOT fold × (U+00D7), Ø, macrons, or 'full metal' vs 'fullmetal', so those need aliases.",
      "source": "_compare_tablet_vs_pc.py:62-76"
    },
    {
      "name": "Device-series compatibility action",
      "description": "Split each dump path on the root, take series = first component and base = last component, and skip IGNORE_FILES and dotfiles. Count extensions in CHAPTER_EXTS and check for an exact 'cover.jpg'. Action: pdf and cbz -> redownload_pdfs; pdf -> redownload; cbz without cover -> add_cover; cbz with cover -> ok; otherwise -> empty. Output is sorted by casefolded name.",
      "source": "_classify_tablet.py:31-93"
    },
    {
      "name": "PC match, variant aggregation and recommendation",
      "description": "Look up the alias (if any), else the normalized device name, in a normalized-name -> [PC folders] index. Drop variants with 0 chapters and aggregate extension counts and covers. Then: pdf without cbz -> push-pdfs; pdf and cbz -> push-mixed; cbz with covers == variant count -> push; cbz otherwise -> push-no-cover; no chapters -> push-empty; no match -> download.",
      "source": "_compare_tablet_vs_pc.py:79-109, 119-181"
    },
    {
      "name": "Chapter-label parsing",
      "description": "Six regexes tried in order: underscored-site and spaced tablet patterns via search, the others anchored via match. '~' maps to '.'. Leading zeros are stripped only by the PC 'Ch.0*' pattern. Non-matching chapter files go to *_unparsed. Only .pdf/.cbz count, and nested files are skipped.",
      "source": "_delta_findings.py:109-138, 141-183"
    },
    {
      "name": "Chapter-set diff and cause tagging",
      "description": "t_only = sorted(T-P) and p_only = sorted(P-T), sorted numerically (non-numeric labels become -1.0). delta = len(PC label list) - len(tablet label list). Skip when delta is 0 and both sets are equal. Tags:\n- pc_ahead_only if every p_only label > t_max; tablet_ahead_only if every t_only label > p_max;\n- labels containing '.' are sub-chapters, the rest integers. Bucket each side into *_extra_sub_chapters_only, *_only_mixed, or *_integer_chapters_in_*_range (in-range = <= the other side's max);\n- Ch 0 presence asymmetry;\n- different_starting_chapter when the minimums differ;\n- exact_match or unclassified otherwise.\nOutput is sorted by -|delta|, then name.",
      "source": "_delta_findings.py:186-258, 261-293"
    },
    {
      "name": "Repack-scope heuristic",
      "description": "Per series, take the min and max CBZ LastWriteTime and the cover/details mtimes, then histogram the newest-CBZ day and cover day across the library. If (nearly) all series were rewritten on one day, a full re-mirror is needed; if only cover/details are newer, metadata-only sync is enough.",
      "source": "_scan_pc_repack.ps1:8-31, 33-43"
    },
    {
      "name": "Delta-cause interpretation (human)",
      "description": "Small negative deltas are sub-chapter splits, often plus a device-side Ch 0 prologue. Large negative deltas (<= -85) mean different numbering systems. Positive deltas mean the PC was re-downloaded later. Device-only integers above the PC max mean the device is ahead, i.e. real content loss on push.",
      "source": "DELTA_FINDINGS.md:14-29, 50-69"
    }
  ],
  "cli_flags": [
    {
      "script": "_classify_tablet.py",
      "flag": "<dump_path> (positional argv[1])",
      "meaning": "Path to the device path dump (one absolute path per line). JSON result goes to stdout; the operator redirected it to tablet_classify.json.",
      "default": "/tmp/tablet_files.txt",
      "source": "_classify_tablet.py:92, 96-97"
    },
    {
      "script": "_compare_tablet_vs_pc.py",
      "flag": "(none)",
      "meaning": "No arguments. Reads ./tablet_classify.json from CWD, scans PC_ROOT live, JSON to stdout (-> tablet_vs_pc.json).",
      "source": "_compare_tablet_vs_pc.py:112-117, 183, 187-188"
    },
    {
      "script": "_delta_findings.py",
      "flag": "(none)",
      "meaning": "No arguments. Reads ./tablet_files.txt, PUSH_MAP and PC_ROOT; JSON to stdout (-> delta_findings.json).",
      "source": "_delta_findings.py:31-33, 261-298"
    },
    {
      "script": "_scan_pc_repack.ps1",
      "flag": "(none)",
      "meaning": "No parameters. Root and output path are hard-coded; prints summary lines to stdout.",
      "source": "_scan_pc_repack.ps1:6, 32-43"
    },
    {
      "script": "_scan_pc_sizes.ps1",
      "flag": "(none)",
      "meaning": "No parameters. Path and output are hard-coded; prints entry count and total GB.",
      "source": "_scan_pc_sizes.ps1:1, 21-23"
    },
    {
      "script": "adb (documented operator step)",
      "flag": "-s 3CEF42502E91537 shell \"find /storage/self/primary/Documents -mindepth 1 -type f -printf '%p\\n'\"",
      "meaning": "Produces tablet_files.txt (read-only listing)",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:175-179; _classify_tablet.py:5-6"
    }
  ],
  "destructive_ops": [
    {
      "op": "Delete the existing device series folder, then push the PC folder (the plan's 'push' action for 51 series)",
      "source": "REDOWNLOAD_FOR_KOMIKKU.md:11-12, 71-75",
      "safety_rails": "Manual guidance only, with no automated guard in these scripts:\n- delta column plus shortfall table (REDOWNLOAD_FOR_KOMIKKU.md:17-22, 154-169);\n- content-loss list: refresh the PC copy first for Horimiya, Sentenced to Be a Hero, Fly Me to the Moon (DELTA_FINDINGS.md:387-400);\n- 'Spot-check one of these per series before mass-pushing' for sub-chapter splits (DELTA_FINDINGS.md:55-56);\n- numbering-mismatch series moved to fresh download (REDOWNLOAD_FOR_KOMIKKU.md:207-214).\nThe port must enforce the content-loss check and offer a dry-run preview plus a confirmation listing the files to be deleted."
    },
    {
      "op": "Re-download only the PDF chapters of a mixed series ('redownload_pdfs'), which implicitly removes the device PDFs",
      "source": "_classify_tablet.py:69-74; REDOWNLOAD_FOR_KOMIKKU.md:126-130",
      "safety_rails": "None described. The only case (Fly Me to the Moon) was routed to a full push instead. The port should list the exact PDFs to remove and require confirmation."
    },
    {
      "op": "Overwrite of report JSON on every run",
      "source": "_scan_pc_repack.ps1:32; _scan_pc_sizes.ps1:21",
      "safety_rails": "Out-File overwrites silently. Harmless, since these are the scripts' own outputs. The scans are otherwise read-only (_scan_pc_repack.ps1:4 'Safe: read-only')."
    }
  ],
  "state_files": [
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\tablet_files.txt",
      "schema": "One absolute device path per line (12,981 lines, 1.2 MB). All under /storage/self/primary/Documents/<Series>/<file>; 67 series; 11,926 .pdf, 1,016 .cbz, 22 .mangafire_hid, 15 .aio_series.json, 1 details.json and 1 cover.jpg (both in Eleceed); 0 nested, 0 loose.",
      "purpose": "Offline snapshot of the device library (2026-05-23)",
      "writer": "adb find (manual; REDOWNLOAD_FOR_KOMIKKU.md:177-178)",
      "reader": "_classify_tablet.py, _delta_findings.py"
    },
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\tablet_classify.json",
      "schema": "Array of {series, counts{ext:int}, total_chapters, has_cover_jpg, action in redownload|redownload_pdfs|add_cover|ok|empty}. 67 entries: 59 redownload, 1 redownload_pdfs, 6 add_cover, 1 ok.",
      "purpose": "Per-series compatibility classification",
      "writer": "_classify_tablet.py (stdout)",
      "reader": "_compare_tablet_vs_pc.py:113-115"
    },
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\tablet_vs_pc.json",
      "schema": "Array of {tablet_series, tablet_action, tablet_counts, tablet_total, pc: null | {folders[], exts{}, covers, variant_count}, recommendation}. 66 entries: 13 download, 53 push. Stale: still maps JoJo Part 4 to the JP PC folder and recommends push for Parts 4 and 6 (tablet_vs_pc.json:495-512, 571-588).",
      "purpose": "Device -> PC match and recommendation",
      "writer": "_compare_tablet_vs_pc.py (stdout)",
      "reader": "Human -> REDOWNLOAD_FOR_KOMIKKU.md"
    },
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\delta_findings.json",
      "schema": "Array of {series, pc_folder, tablet_total, pc_total, delta, shared, tablet_only_count, pc_only_count, tablet_only[], pc_only[], tags[], tablet_unparsed[], pc_unparsed[]}, sorted by |delta| desc. 43 entries; 4 non-empty tablet_unparsed.",
      "purpose": "Chapter-label diff with cause tags",
      "writer": "_delta_findings.py (stdout)",
      "reader": "Human -> DELTA_FINDINGS.md"
    },
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\_pc_repack.json",
      "schema": "Array of {name, cbz_count, cbz_bytes, cbz_mtime_max, cbz_mtime_min (ISO-8601 'o'), has_cover, cover_mtime, has_details, details_mtime, has_series_hid}. 111 entries (D:\\AIO\\manga, 2026-06-14); all have cover, details and .series_hid.",
      "purpose": "Decide full re-mirror vs metadata-only sync",
      "writer": "_scan_pc_repack.ps1:32",
      "reader": "Human"
    },
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\_pc_sizes.json",
      "schema": "Array of {folder, size_mb, cbz, pdf, cover(bool), aio_json(bool)}. 84 entries (old root, 2026-05-24); 0 PDFs; includes empty bare placeholders next to '(hid=...)' siblings (Daughter of the Spirit King, Sentenced to Be a Hero).",
      "purpose": "PC size and format inventory",
      "writer": "_scan_pc_sizes.ps1:21",
      "reader": "Human"
    },
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\_verify_report.json",
      "schema": "{report_version:1, generated_at_iso, pc_root, tablet_root, device, cache_status, tablet_file_count_total, totals{pc_folders, pc_logical_series, tablet_folders, matched, pc_only, tablet_only, pc_chapter_files, pc_total_bytes, tablet_chapter_files, tablet_total_bytes, anomalies}, tablet_missing_series[{norm_key, pc_folders[], canonical_folder, status, pc_chapter_count}], pc_missing_series[{norm_key, tablet_folder, tablet_chapter_count}], shared_series[{norm_key, pc_folders[], canonical_folder, tablet_folder, status, pc_chapter_count, tablet_chapter_count, missing_on_tablet[], extra_on_tablet[]}], anomalies[{kind, severity, series, detail, payload{series, count, samples[]}}]}",
      "purpose": "Post-push verification (2026-06-15)",
      "writer": "compare_manga.py:1242-1248, 1314",
      "reader": "Human"
    },
    {
      "file": "C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\_verify_report.txt (+ _verify_console.txt)",
      "schema": "Plain-text report: header ('# Compare Manga Report v1'), roots/cache, SUMMARY, TABLET MISSING (with [FINISHED]/[RELEASING] status), PC MISSING, CHAPTER GAPS, ANOMALIES grouped by kind",
      "purpose": "Human-readable form of the same verification",
      "writer": "compare_manga.py:1242-1248",
      "reader": "Human"
    },
    {
      "file": "DELTA_FINDINGS.md / REDOWNLOAD_FOR_KOMIKKU.md",
      "schema": "Hand-curated Markdown built from the JSON outputs plus manual revisions; checkbox rows per series",
      "purpose": "Human decision documents",
      "writer": "Human/agent (snapshot 2026-05-23)",
      "reader": "Human"
    }
  ],
  "external_deps": [
    "adb (Android platform-tools): device listing via 'adb -s <serial> shell find <root> -mindepth 1 -type f -printf %p\\n'. The tablet has toybox find, which lacks -printf %h (_verify_chapters.py:37-38).",
    "Python 3 standard library only (json, re, unicodedata, os, pathlib, collections) for the three .py scripts",
    "Windows PowerShell (Get-ChildItem, Measure-Object, ConvertTo-Json, Out-File) for the two .ps1 scans",
    "Komikku LocalSource spec (komikkuspec.md, now missing) and Mihon/Komikku ChapterRecognition filename parsing (aio-dl.py:4961-4972)",
    "Perfect Viewer (Android reader) serving /storage/self/primary/Documents (compare_manga.py:5-6)"
  ],
  "observed_failures": [
    {
      "what": "Volume-numbered files were parsed as chapter numbers, so several 'PC ahead' diagnoses are wrong",
      "evidence": "_delta_findings.py:122, 126-127: _RE_VOL returns the volume number as the label. tablet_files.txt: Sakamoto Days has 'Vol 1.pdf'..'Vol 24.pdf' without Vol 21 (23 files), yet DELTA_FINDINGS.md:79-85 says 'Tablet 23 -> PC 258 ... tablet skipped Ch 21'. The same applies to Rinjin-chan (Vol 1-5), Makeine (Vol 1-4) and No Longer Allowed (Vol 1-11) (DELTA_FINDINGS.md:97-101, 161-165, 226-230). 12 of 67 tablet series use 'Vol N' files, and REDOWNLOAD_FOR_KOMIKKU.md:46-58 calls them 'PDF chapters'.",
      "lesson": "Make the unit type (volume vs chapter vs whole-series) part of every parsed label. Never diff volumes against chapters; show 'not comparable' and let the user decide."
    },
    {
      "what": "Whole-series single-file dumps were counted as chapters, giving off-by-one totals across reports",
      "evidence": "There are 6 such files in tablet_files.txt (Bleach.pdf, Dragon Ball.pdf, A Certain Scientific Railgun.pdf, three '*_mangafire.pdf'), and _classify_tablet.py:56-57 counts them. REDOWNLOAD_FOR_KOMIKKU.md:87 lists Bleach 742/-48, while DELTA_FINDINGS.md:167-168 says 'Δ -47: Bleach / Tablet 742' and delta_findings.json has tablet_total 741. Same for JoJo 5 (324 vs 323), Railgun (236 vs 235), Slime (183 vs 182).",
      "lesson": "Classify files as chapter / volume / whole-series / unknown and count only one class, applied the same way everywhere."
    },
    {
      "what": "JSON outputs went stale against the script and the hand-revised docs",
      "evidence": "tablet_vs_pc.json (19:55) still maps JoJo Part 4 to 'JoJo no Kimyou na Bouken Part 4 - Diamond wa Kudakenai' and says push for Parts 4 and 6 (tablet_vs_pc.json:495-512, 571-588). The script was edited at 20:34 to drop the Part 4 alias (_compare_tablet_vs_pc.py:50-54), and the doc was revised by hand (REDOWNLOAD_FOR_KOMIKKU.md:207-214).",
      "lesson": "Overrides must be persisted data that every computation reads, not code comments or Markdown edits. Recompute on demand."
    },
    {
      "what": "Hard-coded PC root went stale after the library moved",
      "evidence": "_compare_tablet_vs_pc.py:34, _delta_findings.py:31 and _scan_pc_sizes.ps1:1 use C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader\\mangas, which no longer exists (ls: No such file or directory). _scan_pc_repack.ps1:6 and _verify_report.json:4 use D:\\AIO\\manga.",
      "lesson": "PC root is a setting, defaulting to the app's own download directory."
    },
    {
      "what": "The referenced Komikku spec file is gone",
      "evidence": "REDOWNLOAD_FOR_KOMIKKU.md:6 and _classify_tablet.py:8 cite komikkuspec.md. It is absent at ../../AIO-Webtoon-Downloader, absent in the repo (Glob), and has no git history, yet aio-dl.py still cites 'Spec §6.1/§6.2/§8' (aio-dl.py:4714, 4764, 4961).",
      "lesson": "Encode reader-profile rules (extensions, cover/details names, filename rules) in app config/code with inline docs."
    },
    {
      "what": "Alias-unaware verification reported alias pairs as missing on both sides",
      "evidence": "_verify_report.txt:17-48 lists 14 PC-only and 15 tablet-only series. All except SHELTER are alias pairs, e.g. Code Breaker<->CØDEBREAKER, Kinenbi Manga<->Every Day Is a Holiday (Colored), FULL METAL ALCHEMIST<->Fullmetal Alchemist, Sore wa rei no Shiwaza desu<->Ghost Sore wa rei no Shiwaza desu, Isekai de Slow Life o (Ganbou)<->Slow Life In Another World (I Wish!).",
      "lesson": "Plan, diff, sync and verify must share one identity/alias resolver."
    },
    {
      "what": "Komikku sidecars were flagged as orphans, and device chapter counts included them",
      "evidence": "_verify_report.txt:53-151 has 97 'ORPHAN ... 2 file(s) with unrecognized extension' warnings; _verify_report.json:1490-1503 samples are ['cover.jpg','details.json']. shared_series tablet_chapter_count = pc_chapter_count + 2 (213 vs 215 at _verify_report.json:236-237) even though the missing/extra lists are empty.",
      "lesson": "Keep a per-profile whitelist of expected sidecars (cover.jpg, details.json) and a strip-list (.aio_series.json, .mangafire_hid, .series_hid, .cover.webp), and count only chapter archives."
    },
    {
      "what": "Exact PC folder names in the maps went stale within hours (hid-suffixed re-downloads left empty placeholders)",
      "evidence": "PUSH_MAP maps Sentenced to Be a Hero to the bare folder (_delta_findings.py:86-87), which had 10 chapters on 2026-05-23 (delta_findings.json). By 2026-05-24, _pc_sizes.json shows the bare folder with cbz 0 and a '(hid=sentenced-to-be-a-hero-...)' sibling with 10. Daughter of the Spirit King likewise shows bare 0 and '(hid=9o8ym)' 170. _compare_tablet_vs_pc.py:130-132 already had to drop empty EN-named JoJo 4/6 folders.",
      "lesson": "Resolve series by identity (normalized name + hid collapse + .series_hid marker), ignore empty folders, and never store raw folder names without re-resolving them."
    },
    {
      "what": "Six naming conventions exist on the device, sometimes mixed inside one folder",
      "evidence": "tablet_files.txt statistics:\n- underscored '<Series>_mangafire_Ch_N' (3,717) / '_comix_Ch_' (28), across 15 series;\n- spaced '<Series> Ch N~M', 31 series, 750 files with '~' (the app's legacy format_chap_for_filename, aio-dl.py:10339-10345);\n- 'Chap N title', 8 series (Berserk 'Chap 0.01 Black Swordsman Arc.pdf');\n- '#N - title' (Tower of God, SHELTER);\n- 'Vol N', 12 series;\n- AIO 'Ch.001 - Episode 1.cbz' (Eleceed).\nSPY_x_FAMILY mixes 21 spaced and 183 underscored files; Slime mixes 7, 175 and 1 dump.",
      "lesson": "Use an ordered, user-extensible pattern list with presets, a per-series 'unparsed files' view, and '~' -> '.' normalization."
    },
    {
      "what": "'#N - [Season X] Ep. Y' names parse the running index, not the episode number",
      "evidence": "tablet_files.txt: 'Tower of God/#1 - [Season 1] Ep. 0.pdf', '#10 - [Season 1] Ep. 9.pdf'. _RE_HASH (_delta_findings.py:121) captures the '#N'.",
      "lesson": "Let a pattern (or a per-series setting) choose which number is the label, and show parsed labels for spot checks."
    },
    {
      "what": "Different numbering systems cannot be reconciled by label diff",
      "evidence": "JoJo 5: tablet integers go up to 594 vs PC 1-155 (DELTA_FINDINGS.md:87-95). Is the Order a Rabbit: DELTA_FINDINGS.md:124-132. JoJo 4: up to Ch 439.1 vs 174; JoJo 6: up to 752.1 vs 158 (REDOWNLOAD_FOR_KOMIKKU.md:66-67).",
      "lesson": "Flag it heuristically (a large one-sided integer surplus far beyond the other side's max), then require an explicit per-series decision: force fresh download, or accept the PC numbering."
    },
    {
      "what": "The classifier ignores zip/cbr/rar/epub when choosing actions",
      "evidence": "_classify_tablet.py:27 counts them, but :64-65 and :73-82 only test pdf/cbz, so an epub- or zip-only series would be labeled 'empty'.",
      "lesson": "Drive decisions from the reader profile's supported-extension set."
    },
    {
      "what": "The doc's delta definition differs from the code",
      "evidence": "DELTA_FINDINGS.md:11 says 'PC unique chapter labels − tablet unique chapter labels', but _delta_findings.py:272 uses len(p_labels) - len(t_labels) (raw lists). Spot-checked SPY_x_FAMILY, Slime and Fly Me to the Moon: no duplicate labels, so the numbers agree only by coincidence.",
      "lesson": "Compute on unique labels and surface duplicates (the same chapter in two formats or conventions) as their own anomaly."
    },
    {
      "what": "A library-wide repack rewrote every CBZ, which defeats mtime-based sync",
      "evidence": "_pc_repack.json: 110 of 111 series have cbz_mtime_min and cbz_mtime_max on 2026-06-14 (e.g. 21:48:39-21:48:43 at _pc_repack.json:6-7). _scan_pc_repack.ps1:1-4 was written to decide full re-mirror vs metadata-only sync.",
      "lesson": "Change detection must be content-hash based, with an explicit metadata-only sync mode."
    },
    {
      "what": "Case-sensitive exact cover-name check",
      "evidence": "_classify_tablet.py:66 and _compare_tablet_vs_pc.py:95 accept only 'cover.jpg', whereas the app's own scanner accepts cover.jpg/png/webp/jpeg (UI-source/electron/library.js:735).",
      "lesson": "Make the required cover filename a profile setting and warn on near-misses."
    }
  ],
  "open_questions": [
    "Which device folder does Komikku actually read? Every analysis script targets /storage/self/primary/Documents/<Series>/ (the Perfect Viewer tree, compare_manga.py:5-6) as the 'Komikku' target, but the app documents Komikku LocalSource as <SAF-root>/local/<Title>/ (aio-dl.py:12977-12979). Should the new tab support one shared tree or separate per-reader targets?",
    "Is Perfect Viewer still used? If so, should PDFs stay acceptable in its profile, or is the goal to migrate everything to Komikku-compatible CBZ?",
    "For aliased series, should the device folder keep the device name (the later tool hard-codes KEEP_TABLET_NAME_FOR_ALIASES = True, push_all_to_tablet.py:100) or take the PC name? Global setting or per alias?",
    "How should volume-numbered device series (12 of 67, e.g. Sakamoto Days 'Vol N.pdf') be handled: shown as 'not comparable', or mapped to chapter ranges (needs metadata)?",
    "Should device-only sub-chapter splits (.1/.5 mangafire scan pieces) be dropped silently on push, require per-series confirmation, or get a spot-check preview (DELTA_FINDINGS.md:52-56)?",
    "Multiple devices? May/June reports use serial 3CEF42502E91537, but the folder also has .sync_state-A06B4A372090333.json (Jul 15). Should aliases, overrides and targets be stored per device serial?",
    "Should the remediation plan be exportable as Markdown (like REDOWNLOAD_FOR_KOMIKKU.md), or is an in-app checklist enough?",
    "Does a copy of komikkuspec.md survive somewhere that should be treated as the authoritative reader-profile spec?",
    "Should 'download' recommendations queue AIO downloads automatically (search by device title or alias target), or only link to the Search tab?"
  ],
  "integration_notes": [
    "Rail placement: TABS at UI-source/src/App.jsx:25-31 ends with { id: 'settings' } (App.jsx:30), and the rail renders at App.jsx:83-125. Library is not a TABS item; it is the app-icon button (App.jsx:85-101). Insert the opt-in tab into TABS conditionally, just before 'settings'. App.jsx has uncommitted local modifications.",
    "Opt-in toggle: the Settings 'Library' category is at UI-source/src/components/SettingsTab.jsx:435-436 ({id:'library', label:'Library', desc:'Update checks and how the library is scanned.'}), rendered by renderLibrary at SettingsTab.jsx:2686-2687.",
    "The app's Komikku chapter-name producer is aio-dl.py:4958-5015 (_komikku_chapter_filename -> '[Vol.vv ]Ch.ccc[.d] - title.cbz'; 3-digit pad, decimals verbatim, never '~'). The port's parser must accept an optional 'Vol.NN ' prefix; _delta_findings.py:117-118 anchors at ^Ch\\. and would miss it.",
    "Legacy producer: aio-dl.py:10339-10345 format_chap_for_filename swaps the decimal '.' for '~' ('Ch 168~1'), used for non-Komikku keep-chapters names (aio-dl.py:12986-12989). That is exactly the device's spaced convention. Per aio-dl.py:4970-4972, '~' breaks Komikku ChapterRecognition, so such files are Komikku-incompatible even as CBZ.",
    "Folder identity: aio-dl.py:926-949 allocates folders (identity -> title -> 'title (hid=<hid>)' on collision) with a .series_hid marker, reclaims empty folders, and uses a root lock .aio_folder_alloc.lock (aio-dl.py:952). Reuse the app's hid-strip regex (aio-dl.py:949, 10127) instead of the script's RE_HID. hid formats seen: short 'PW1SJ', UUID '9f7530e3-3fc0-4d2b-a1f9-00caadbf2d05', slug 'sentenced-to-be-a-hero-...' (_pc_repack.json / _pc_sizes.json names).",
    "Sidecar list reuse: UI-source/electron/series-merge.js:67 already lists SERIES_META_FILE, '.series_hid', '.mangafire_hid' and '.DS_Store'. That file is UNTRACKED ('??' in git status), i.e. local-only work that must not be lost.",
    "The existing PC scanner UI-source/electron/library.js:616 (scanLibrary) accepts cover.jpg/png/webp/jpeg (library.js:735). Reuse it for the PC side of matching and inventory rather than writing a new scanner.",
    "Komikku metadata writers already exist: aio-dl.py:4711-4723 (_komikku_status_to_digit, details.json status 0-6), aio-dl.py:4762-4771 (per-chapter ComicInfo.xml), aio-dl.py:5309-5377 (details.json patching), tests/test_komikku_metadata.py and bench/probe_komikku_metadata.py. 'add_cover' and metadata-only remediation can reuse them.",
    "Git state (be careful): branch fix/mangafire-cloudflare-challenge has 36 modified tracked files (incl. UI-source/electron/{downloader,library,main,preload}.js, src/App.jsx, LibraryTab.jsx, aio-dl.py, library_state.py) and 4 untracked (UI-source/electron/series-merge.js, update-check-record.js, src/components/ChapterChips.jsx, .github/workflows/android.yml). Build on the working tree; never reset or checkout.",
    "The later CompareManga tables supersede the ones here, so seed the UI alias editor from them. push_all_to_tablet.py:74 ALIASES_TABLET_TO_PC (lines 78-91 add Every Day Is a Holiday (Colored)->Kinenbi Manga, Fullmetal Alchemist->FULL METAL ALCHEMIST, Ghost Sore wa rei no Shiwaza desu->Sore wa rei no Shiwaza desu, JoJo Part 4->JoJo no Kimyou na Bouken Part 4 - Diamond wa Kudakenai, Slow Life In Another World (I Wish!)->Isekai de Slow Life o (Ganbou)). Also push_all_to_tablet.py:100 KEEP_TABLET_NAME_FOR_ALIASES, push_all_to_tablet.py:107 SIDECARS_ON_TABLET, and sync_to_tablet.py:97-107 SIDECARS/COVER_NAME/DETAILS_NAME plus the inverted PC->tablet alias map.",
    "Device listing gotcha: toybox find lacks -printf %h (_verify_chapters.py:37-38). List with '%p' and derive the series folder in code, as _classify_tablet.py:43-48 does. Every adb call must use the user-selected serial, never a hard-coded one."
  ]
}
```
