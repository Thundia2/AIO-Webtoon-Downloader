# Workflow wf_e556ba67-39f — verify:analysis-and-docs (phase Verify)

```json
{
  "area": "analysis-and-docs",
  "confirmed": [
    {
      "claim": "TABLET_TO_PC_ALIAS has exactly 9 entries and the census lists all of them correctly, including SPY_x_FAMILY -> SPY×FAMILY (U+00D7). The JoJo 4/6 'deliberately NOT aliased' comment is present.",
      "evidence": "_compare_tablet_vs_pc.py:43-60 (9 pairs; comment at 50-54); duplicated verbatim at REDOWNLOAD_FOR_KOMIKKU.md:189-197 (U+00D7 note at :197)."
    },
    {
      "claim": "PUSH_MAP has exactly 50 entries; the census list is complete and every value is correct. It includes two raw hid-suffixed PC targets. Dragon Ball is omitted.",
      "evidence": "_delta_findings.py:42-107 (50 keys counted). Hid targets: 'Bungo Stray Dogs (hid=PW1SJ)' at :51 and 'Konosuba ... (hid=gvHMj)' at :72-73. Omission comment at :105-106. 50 = REDOWNLOAD B.1 44 + B.2 1 + B.3 6, minus Dragon Ball (REDOWNLOAD_FOR_KOMIKKU.md:77-144)."
    },
    {
      "claim": "The census's per-script sidecar/skip sets are complete and accurate.",
      "evidence": "_classify_tablet.py:28 {.aio_series.json,.mangafire_hid,details.json,.nomedia}, dotfile rule at :50. _compare_tablet_vs_pc.py:35 IGNORE_TOP {.aio_coord,.aio_folder_alloc.lock}; :36 IGNORE_FILES; :83-86 skips dot-entries and non-dirs; :97 dotfile skip. _delta_findings.py:36-37 SKIP_BASENAMES (+details.json, cover.jpg); :134-138 counts only .pdf/.cbz. _scan_pc_sizes.ps1:3 excludes only '.aio_coord'."
    },
    {
      "claim": "Chapter-label regexes: six patterns, tried in order, first match wins. search() is used only for the underscored and spaced patterns, match() for the rest, then '~' -> '.'.",
      "evidence": "_delta_findings.py:112-122: all six compiled with re.IGNORECASE (the census noted IGNORECASE only for #1). :126-127 order: UNDERSCORED, SPACES, PC_DOTTED, GENERIC_CHAP, HASH, VOL. :128 search/match split. :130 replace('~','.')."
    },
    {
      "claim": "Classifier action rules, including the latent bug where a zip/cbr/rar/epub-only series becomes 'empty'.",
      "evidence": "_classify_tablet.py:27 counts six extensions, but :64-65 derive only has_pdf/has_cbz, and :73-82 fall through to action='empty'."
    },
    {
      "claim": "CLI surface: no argparse in any assigned script. Only _classify_tablet.py takes a positional argv[1] (default /tmp/tablet_files.txt). The other .py scripts take no arguments, read CWD-relative inputs and write JSON to stdout. Both .ps1 scripts have no parameters and hard-code their output paths.",
      "evidence": "_classify_tablet.py:92, 96-97; _compare_tablet_vs_pc.py:113-115, 183, 187-188; _delta_findings.py:32, 145, 293, 297-298; _scan_pc_repack.ps1:6, 32; _scan_pc_sizes.ps1:1, 21."
    },
    {
      "claim": "Recommendation rules: 'push' requires every populated variant to have cover.jpg (covers == len(matches)); the sort order is as stated.",
      "evidence": "_compare_tablet_vs_pc.py:151-160 (push at :155); rec_order at :178-181."
    },
    {
      "claim": "Destructive op: 'delete the tablet folder, then push the PC folder' exists only as Markdown guidance. The analysis scripts are read-only apart from the .ps1 scripts' Out-File overwrite of their own JSON.",
      "evidence": "REDOWNLOAD_FOR_KOMIKKU.md:11-12, 73. _scan_pc_repack.ps1:4 ('Safe: read-only') and :32 Out-File. _scan_pc_sizes.ps1:21 Out-File. The .py scripts only json.dump to stdout (_classify_tablet.py:92; _compare_tablet_vs_pc.py:183; _delta_findings.py:293)."
    },
    {
      "claim": "State-file counts in the census are correct.",
      "evidence": "tablet_classify.json: 67 'action' lines = 59 redownload, 1 redownload_pdfs (:172 Fly Me), 6 add_cover (:280,:460,:487,:505,:523,:532), 1 ok (:153 Eleceed).\ntablet_vs_pc.json: 13 download (:10-:130) and 53 push (:149-:1138).\ndelta_findings.json: 43 records; 4 non-empty tablet_unparsed (:438, :1392, :1472, :1885); tag counts 17/14/11/10/10/6/5/5/2/1 exactly as the census states.\n_pc_repack.json: 111 records, none missing cover, details or .series_hid. cbz_mtime_min and cbz_mtime_max both fall on 2026-06-14 for 110 series (one outlier: min 2026-05-21, max 2026-06-06)."
    },
    {
      "claim": "tablet_files.txt statistics and naming-convention counts are correct.",
      "evidence": "Read-only grep/wc:\n- totals: 12,981 lines; 11,926 .pdf; 1,016 .cbz; 22 .mangafire_hid; 15 .aio_series.json; 1 details.json + 1 cover.jpg (both in Eleceed); 0 nested; 0 loose; 67 series.\n- underscored names: 3,717 _mangafire_Ch_ and 28 _comix_Ch_, across 15 series; 0 comickfun/mangadex/asura.\n- spaced ' Ch N': 31 series; 750 files contain '~'.\n- Chap-style: 8 series (Berserk, Chainsaw Man, Claymore, Daughter of the Spirit King, Link Click, Pandora Seven, Record of Ragnarok, The Legend of the Northern Blade).\n- '#N': Tower of God and SHELTER.\n- Vol: 12 series.\n- Ch.NNN: only Eleceed."
    },
    {
      "claim": "Volumes were parsed as chapters (Sakamoto Days).",
      "evidence": "tablet_files.txt: Sakamoto Days contains 'Vol 1.pdf'..'Vol 20.pdf' and 'Vol 22-24.pdf' (23 files, no Vol 21). delta_findings.json record 1 has pc_only starting '21','25',... DELTA_FINDINGS.md:79-85 wrongly reads this as 'tablet skipped Ch 21'."
    },
    {
      "claim": "The shortfall threshold (Δ <= -50), its 6-row table and the 3-row content-loss list are correct.",
      "evidence": "REDOWNLOAD_FOR_KOMIKKU.md:154-169; DELTA_FINDINGS.md:387-400."
    },
    {
      "claim": "The delta definition in the doc differs from the code.",
      "evidence": "DELTA_FINDINGS.md:11 says 'unique labels', but _delta_findings.py:272 computes len(p_labels) - len(t_labels) over raw lists."
    },
    {
      "claim": "tablet_vs_pc.json is stale for JoJo Part 4 relative to the later script edit.",
      "evidence": "tablet_vs_pc.json:571-587 maps Part 4 to 'JoJo no Kimyou na Bouken Part 4 - Diamond wa Kudakenai' with recommendation push. Directory mtimes: tablet_vs_pc.json May 23 19:55; _compare_tablet_vs_pc.py May 23 20:34."
    },
    {
      "claim": "The old PC root no longer exists; the new root is D:\\AIO\\manga.",
      "evidence": "ls: 'No such file or directory' for C:\\Users\\legoc\\OneDrive\\Belgeler\\AIO-Webtoon-Downloader and ...\\mangas. New root at _scan_pc_repack.ps1:6 and compare_manga.py:55 (DEFAULT_PC_ROOT)."
    },
    {
      "claim": "Device serial is 3CEF42502E91537, and there is a hint of a second device.",
      "evidence": "REDOWNLOAD_FOR_KOMIKKU.md:4, 177; compare_manga.py:57 DEFAULT_DEVICE_SERIAL. The directory listing shows .sync_state-A06B4A372090333.json (Jul 15)."
    },
    {
      "claim": "The verify report is blind to aliases and sidecars.",
      "evidence": "_verify_report.txt:7-15: 111 PC / 112 tablet / 97 matched / 14 PC-only / 15 tablet-only; 19,574 vs 20,006 files; 97 anomalies.\n_verify_report.txt:53-57: an 'ORPHAN (97)' header followed by 97 '[warn] ... 2 file(s) with unrecognized extension.' lines.\n_verify_report.json:1490-1503: samples are ['cover.jpg','details.json'].\n_verify_report.json:227-240: pc 213 vs tablet 215, with empty missing/extra lists."
    },
    {
      "claim": "App integration anchors are accurate.",
      "evidence": "- App.jsx:25-31 TABS (settings at :30); Library is the app-icon button at :85-101; rail at :83.\n- SettingsTab.jsx:435-436 Library category; renderLibrary at :2686-2687. SettingsTab.jsx has no local modifications (git status clean).\n- library.js:616 scanLibrary; library.js:735 accepts cover.jpg/png/webp/jpeg.\n- series-merge.js:52, :67 sidecar list; the file is untracked.\n- aio-dl.py:949 and :10127 hid-strip regex; :952 .aio_folder_alloc.lock; :4958-4975 _komikku_chapter_filename (no '~', :4969-4972); :10339-10345 format_chap_for_filename."
    },
    {
      "claim": "The later-suite tables the census recommends seeding from are as described.",
      "evidence": "- push_all_to_tablet.py:74-92 ALIASES_TABLET_TO_PC has 14 entries: the 9 originals plus :78 Every Day Is a Holiday (Colored)->Kinenbi Manga, :79 Fullmetal Alchemist->FULL METAL ALCHEMIST, :80 Ghost Sore wa rei no Shiwaza desu->Sore wa rei no Shiwaza desu, :84-85 JoJo Part 4->JP folder, :91 Slow Life In Another World (I Wish!)->Isekai de Slow Life o (Ganbou).\n- push_all_to_tablet.py:100 KEEP_TABLET_NAME_FOR_ALIASES = True.\n- push_all_to_tablet.py:107 SIDECARS_ON_TABLET are removed after the push; cover.jpg and details.json are kept (:102-106).\n- sync_to_tablet.py:97 SIDECARS (adds .cover.webp); :101-102 COVER_NAME/DETAILS_NAME; :108-110 inverted alias map.\n- _verify_chapters.py:36-38 notes that toybox find lacks -printf %h."
    }
  ],
  "refuted": [
    {
      "claim": "_scan_pc_sizes.ps1 result on 2026-05-24: '84 folders, 0 PDFs, all with cover and .aio_series.json' (feature 'PC library inventory').",
      "correction": "84 folders and 0 PDFs are correct, but 3 folders have neither cover.jpg nor .aio_series.json. They are the empty (0-CBZ) placeholders 'Daughter of the Spirit King', 'Fatestrange Fake' and 'Sentenced to Be a Hero The Prison Records of Penal Hero Unit 9004'. 'Fatestrange Fake' is a third empty placeholder the census never mentions.",
      "evidence": "_pc_sizes.json:99-104, ~155-160, 443-448. grep: cover:false = 3, aio_json:false = 3, cbz:0 = 3."
    },
    {
      "claim": "Git state: '36 modified tracked files ... and 4 untracked (series-merge.js, update-check-record.js, ChapterChips.jsx, android.yml)'.",
      "correction": "36 modified is correct, but there are 21 untracked entries. Beyond the four named:\n- UI: UI-source/src/hooks/useUpdateCheck.js\n- sites/profile_lock.py\n- tests: test_series_folder_identity.py, test_profile_lock.py, test_android_repair.py, test_fast_download_timeouts.py\n- Android: AppUpdater.kt, RunPersistence.kt, RunStore.kt and their 3 tests\n- 4 android/wheels/*.whl plus android/wheels/recipes/\nAll of this is local-only work that must not be lost.",
      "evidence": "git status --porcelain on branch fix/mangafire-cloudflare-challenge (HEAD d1ae7d6, 2026-08-20): 36 ' M' and 21 '??' entries."
    },
    {
      "claim": "komikkuspec.md is 'absent in the repo (Glob), and has no git history'.",
      "correction": "It was deleted in commit 1f17a20 (2026-05-24 21:46:45 +0300, 'docs: drop komikkuspec.md (internal implementation reference)'). The full 346-line spec can still be read with `git show 1f17a20^:komikkuspec.md`, which aio-dl.py:7818 itself cites. However, 1f17a20 is not on any local or remote branch, so it survives only as an unreachable object that `git gc --prune` could delete. This settles the census's open question: the authoritative reader-profile spec still exists, and it should be captured before any gc.",
      "evidence": "git cat-file -t 1f17a20 -> commit; git cat-file -e 1f17a20^:komikkuspec.md -> exists; git show ... | wc -l -> 346; git branch -a --contains 1f17a20 -> 0; aio-dl.py:7818."
    },
    {
      "claim": "Algorithm 'PC match ... -> recommendation': 'no chapters -> push-empty'.",
      "correction": "PC matches with 0 chapters are dropped before the recommendation is computed, so they produce 'download'. 'push-empty' can only occur when populated variants have neither pdf nor cbz, i.e. the PC has only zip/cbr/rar/epub chapters. It is the PC-side twin of the classifier's zip/epub blind spot, not an 'empty' state.",
      "evidence": "_compare_tablet_vs_pc.py:101 counts zip/cbr/rar/epub; :133 drops total_chapters==0; :135-137 no match -> download; :149-160 tests only pdf/cbz before falling to push-empty."
    },
    {
      "claim": "Classifier 'Cover rule: exact, case-sensitive cover.jpg at the SERIES folder root (_classify_tablet.py:10-11, 66)'.",
      "correction": "Only the docstring says 'root'. The code adds the basename of every file at any depth to series_root_files and then tests membership, so Series/sub/cover.jpg would count as a cover. Chapter files at any depth are counted too. The root-only check holds for _compare_tablet_vs_pc.py (non-recursive scandir) and the .ps1 scans, not for the classifier. There was no effect on the May snapshot (0 nested files).",
      "evidence": "_classify_tablet.py:13-15 (docstring), :44-49 (base = parts[-1]; series_root_files[series].add(base)), :56-57, :66. Compare _compare_tablet_vs_pc.py:91-96."
    },
    {
      "claim": "Hard-code 'JoJo Parts 4 and 6 deliberately NOT aliased ... Prevent a non-1:1 push', plus the failure note that tablet_vs_pc.json is merely stale for Parts 4 and 6 (lesson: 'recompute on demand').",
      "correction": "Leaving out the alias only excludes Part 4, whose EN device name does not normalize to its JP PC folder. For Part 6, normalize() strips '(hid=t4U07)', so the device folder 'JoJo's Bizarre Adventure Part 6 Stone Ocean' matches the populated PC folder 'JoJo's Bizarre Adventure Part 6 Stone Ocean (hid=t4U07)' (158 cbz) with no alias. Re-running the current script still recommends 'push' for Part 6. The A.2 fresh-download decision lived only in hand-edited Markdown. An explicit exclude/force-download override is required, because omitting an alias can never act as an exclusion.",
      "evidence": "_compare_tablet_vs_pc.py:50-54, 62-76, 128, 133. tablet_vs_pc.json:495-511: Part 6 -> folders ['...(hid=t4U07)'], variant_count 1, push. _pc_sizes.json:291 (2026-05-24): the hid folder is the only Part 6 folder. REDOWNLOAD_FOR_KOMIKKU.md:67, 209-214."
    }
  ],
  "missed": [
    {
      "item": "The machine tagger cannot tell real content loss from a numbering-system mismatch, and 'tablet_ahead_only' never fires on the real data. Every content-loss case is tagged only 'tablet_only_mixed': Horimiya '74 integer + 38 sub-chapter', Sentenced '3 integer + 2 sub-chapter', Fly Me '2 integer + 89 sub-chapter'. The numbering mismatches get the same tag: JoJo 5 '155 integer + 13 sub-chapter', Rabbit '91 integer + 1 sub-chapter'. The content-loss table and the 'tablet ahead: 2' row were therefore produced by hand. The port must compute device-only INTEGER labels above the PC max and inside the PC range separately from partials, then apply a numbering-mismatch heuristic.",
      "category": "failure_mode",
      "evidence": "_delta_findings.py:212 (tablet_ahead_only requires ALL device-only labels > p_max); :223-226 (the mixed branch skips the range check that :227-233 performs). delta_findings.json:733-735, 2197-2199, 844-848, 435-437, 962-965; tablet_ahead_only occurs 0 times. DELTA_FINDINGS.md:43, 387-400."
    },
    {
      "item": "Collapsing the hid suffix can merge DIFFERENT series. The app appends '(hid=X)' only for a genuine collision, meaning a different series with the same title, and adds a further ' (k)' suffix when that name is taken. Neither RE_HID nor the app's regex strips ' (k)'. The script aggregates every same-normalized-name folder as one series' 'variants', so a real title collision would be double-counted and pushed as one series.",
      "category": "failure_mode",
      "evidence": "aio-dl.py:936-937, 1025-1026, 1036-1041, 949; _compare_tablet_vs_pc.py:62, 68-70, 123-148."
    },
    {
      "item": "An uncommitted identity layer already exists and should be reused rather than name matching. aio-dl.py has a 'SERIES FOLDER IDENTITY' block dated 2026-08-21 (after HEAD d1ae7d6, 2026-08-20), which keys identity on url+hid+site from .aio_series.json plus .series_hid, and adds find_matching_series_folders. library.js adds seriesIdentityKey, groupEntriesBySeries and findDuplicateSeries (exported at library.js:1118). tests/test_series_folder_identity.py is untracked. aio-dl.py:533-534 names library.js as the JS mirror.",
      "category": "integration_point",
      "evidence": "aio-dl.py:505-534, 985-1010. git diff shows '+def find_matching_series_folders', 3 added 'SERIES FOLDER IDENTITY' lines, and library.js '+function seriesIdentityKey/groupEntriesBySeries/findDuplicateSeries' (+197 lines). git status: '?? tests/test_series_folder_identity.py'."
    },
    {
      "item": "Settings integration details the census skipped:\n1. Sections are registered in SECTIONS: add one render* closure and one line with group 'library'.\n2. countDirtySettings compares top-level keys with '!==' and only walks NESTED = ['defaults','searchOpts']. A top-level array or object setting (alias table, overrides, device list) would show as a permanent phantom '1 changed' unless it is added to SKIP_TOP or NESTED, or made immediate-persist like disabledSites.\n3. history.js:saveSettings merge semantics also apply.",
      "category": "integration_point",
      "evidence": "SettingsTab.jsx:2765-2788 (SECTIONS), 469-494 (countDirtySettings), 471-477 (SKIP_TOP/NESTED rationale), 449-453 and 466-468 (history.js:saveSettings merge)."
    },
    {
      "item": "Device-side identity sidecars can drive matching and re-download; the census treats them only as files to strip.\n- .aio_series.json (url+hid+site) exists on the device in 15 series: 'Tis Time, A Couple of Cuckoos, Angel Beats! Heaven's Door, Bungo Stray Dogs, CØDEBREAKER, Fly Me to the Moon, Horimiya, Kagurabachi, Konosuba, No More Love With the Girls, Pandora Hearts, Sleepy Princess, Talentless Nana, Undead Unluck, You are Ms. Servant.\n- .mangafire_hid exists in 22: those 15 plus Railgun, EDENS ZERO, Slime, Bleach, Dragon Ball, JoJo 5, JoJo 6.\nReading them over adb would match CØDEBREAKER to Code Breaker without an alias. It would also give a direct URL for 'No More Love With the Girls', which the plan lists as 'not on PC'.",
      "category": "integration_point",
      "evidence": "tablet_files.txt (grep of /.aio_series.json and /.mangafire_hid); aio-dl.py:509-513 (identity definition); push_all_to_tablet.py:104 (3-5 byte hid stubs); REDOWNLOAD_FOR_KOMIKKU.md:54."
    },
    {
      "item": "Re-downloading from the same numbering source. The intent of A.2 is 'a fresh AIO download under the tablet-style name produces a 1:1-replaceable CBZ folder', which means re-downloading from the source whose numbering the device uses (mangafire, as shown by the '_mangafire_' filename tag and .mangafire_hid). A force-download override therefore needs a source choice and a target folder name, not just a flag.",
      "category": "feature",
      "evidence": "REDOWNLOAD_FOR_KOMIKKU.md:38-42, 62-64; _delta_findings.py:114-116 (site tags); tablet_files.txt (3,717 _mangafire_ files)."
    },
    {
      "item": "The JoJo Part 4 decision was later reversed. The later suite re-adds the Part 4 alias to the JP published-numbering folder, contradicting REDOWNLOAD A.2 and the script comment. Per-series decisions change over time, so the UI must let a series move between force-download, alias/push and exclude.",
      "category": "other",
      "evidence": "push_all_to_tablet.py:84-85 vs REDOWNLOAD_FOR_KOMIKKU.md:60-67, 209-214 and _compare_tablet_vs_pc.py:50-54."
    },
    {
      "item": "The analysis's target root does not match the Komikku root. The recovered spec says LocalSource has exactly one root, <SAF-root>/local/ (exact lowercase 'local'); a loose archive directly in local/ is not a manga; the user-visible path is /storage/emulated/0/Komikku/local/<Series>/. Every analysis script targets /storage/self/primary/Documents/<Series>/ (the Perfect Viewer tree) and calls Eleceed there 'Komikku-compliant'. Unless Komikku's storage location maps local/ onto that tree, those folders are invisible to Komikku. The target (root, reader profile) must be configured per profile. The spec also recommends a .nomedia file in local/.",
      "category": "failure_mode",
      "evidence": "git show 1f17a20^:komikkuspec.md lines 3, 6, 15, 30, 41, 182, 242, 258. _classify_tablet.py:26; _delta_findings.py:33; compare_manga.py:6, 56; REDOWNLOAD_FOR_KOMIKKU.md:148-150."
    },
    {
      "item": "Nested folders are a Komikku incompatibility that the classifier hides. Per the spec, a sub-folder inside a manga folder becomes ONE chapter and sub-folders under a chapter are not recursed. The classifier instead maps files at any depth to the top-level series and counts them as chapters, so a 'Series/Volume 01/*.cbz' layout would be classified ok or add_cover.",
      "category": "failure_mode",
      "evidence": "komikkuspec.md (1f17a20^) lines 18, 51-52; _classify_tablet.py:44-57."
    },
    {
      "item": "A seventh device naming variant, 'Vol N <title>.pdf', cannot be parsed. My Dress-Up Darling has 8 such files, e.g. 'Vol 1 Sono Bisque Doll wa Koi wo Suru #1.pdf' and 'Vol 7 A Home Date with the Guy I Wuv Is the Best.pdf'; its Vol 9-14 are bare 'Vol N.pdf'. Across the whole device, 14 .pdf/.cbz files match none of the six regexes, not 6. They were hidden only because My Dress-Up Darling is not in PUSH_MAP.",
      "category": "failure_mode",
      "evidence": "tablet_files.txt (all .pdf/.cbz lines filtered through the 6 patterns leave exactly 14: the 6 dumps plus these 8). _delta_findings.py:122 (_RE_VOL requires '\\.(pdf|cbz)$' right after the number)."
    },
    {
      "item": "A missing mapped folder silently produces a bogus diff. scan_pc returns empty lists when the PUSH_MAP folder does not exist or is empty, and a device series absent from the dump yields []. Every label then looks one-sided with no 'folder missing' error. Example: PUSH_MAP's bare 'Sentenced to Be a Hero ...' folder had 0 cbz by 2026-05-24.",
      "category": "failure_mode",
      "evidence": "_delta_findings.py:169-171, 265; _pc_sizes.json:443-448."
    },
    {
      "item": "Alias precedence has no fallback, and alias targets are fuzzy. When an alias key exists, only normalize(alias) is looked up. If that target is missing or empty the result is 'download', with no fallback to the device's own normalized name. Because the target is normalized, one alias matches every hid variant of that title.",
      "category": "algorithm",
      "evidence": "_compare_tablet_vs_pc.py:124-128, 133-137."
    },
    {
      "item": "Labels are compared as raw strings, not canonical numbers. Only the PC 'Ch\\.0*' pattern strips leading zeros, even though the docstring and DELTA_FINDINGS.md:422 say zeros are stripped in general. So '5.50' != '5.5' and a device '01' != '1'. The docstring also promises a generic 'Ch[.\\s]<num>' fallback that does not exist. When one side has no labels, its max/min default to 0.0, so every label on the other side looks 'ahead'. This snapshot had 0 zero-padded and 0 trailing-zero device labels, so its results were unaffected; the port must still canonicalize.",
      "category": "algorithm",
      "evidence": "_delta_findings.py:18-19, 110-111, 117-118, 126-127, 202-205; DELTA_FINDINGS.md:422; tablet_files.txt grep (0 matches for '(_Ch_| Ch )0[0-9]' and for trailing-zero decimals)."
    },
    {
      "item": "Human cause taxonomy and per-series push-outcome verdicts. There are 8 cause classes with counts:\n- sub-chapter splits only: 12\n- Ch 0 prologue + splits: 6\n- Berserk-style fine prologue split: 1\n- PC ahead: 10\n- tablet ahead: 2\n- different numbering: 2\n- mid-range integer mismatch: 6\n- other: 4\nEach maps to a verdict: strict upgrade / loses real chapters / trades N splits for M omakes / re-numbering. The diff UI should show a verdict per series, not raw tags.",
      "category": "feature",
      "evidence": "DELTA_FINDINGS.md:37-46, 50-69; per-series 'Push outcome' lines, e.g. :85, :94-95, :110-111, :200, :317-318."
    },
    {
      "item": "Separate warning class: prologue (Ch 0) loss. Pushing drops the device's Ch 0 for Bleach, SPY×FAMILY, CØDEBREAKER, Konosuba, Bungo Stray Dogs and Undead Unluck, because the PC starts at Ch 1. Berserk keeps its prologue because the PC has Ch.000.",
      "category": "feature",
      "evidence": "DELTA_FINDINGS.md:57-60; delta_findings.json (tablet_has_ch0_pc_does_not x6)."
    },
    {
      "item": "What a sub-chapter label means depends on the source. Device mangafire '.1/.2/.3' labels are scan-continuation splits, while PC '.5' labels are published omake/bonus chapters (JoJo 3: 52 splits vs 10 '.5'; Komi: 23 vs 2; Berserk: 15-chunk vs 2-chunk prologue). So 'losing only partials is acceptable' is not universally safe, and PC-only partials are real content.",
      "category": "algorithm",
      "evidence": "DELTA_FINDINGS.md:52-56, 193-200, 217-224, 259-272."
    },
    {
      "item": "_pc_sizes.json is written as UTF-8 with a BOM and escapes apostrophes as ' (Windows PowerShell 5.1 Out-File -Encoding utf8). _pc_repack.json has no BOM. Any reader of these files needs utf-8-sig handling.",
      "category": "state_file",
      "evidence": "First bytes: _pc_sizes.json 'ef bb bf'; _pc_repack.json '5b 0d 0a'. _pc_sizes.json:267 'JoJo's ...'. _scan_pc_sizes.ps1:21; _scan_pc_repack.ps1:32."
    },
    {
      "item": "PowerShell scan pitfalls:\n- _scan_pc_sizes.ps1 uses wildcard-interpreting -Path with -ErrorAction SilentlyContinue, so a folder name containing [ or ] would silently count 0 files. _scan_pc_repack.ps1 uses -LiteralPath instead.\n- _scan_pc_repack.ps1 has no .aio_coord exclusion and sets $ErrorActionPreference='Stop', so one unreadable item aborts the whole scan.\nThe current data has no bracketed names. The port should always use literal paths.",
      "category": "failure_mode",
      "evidence": "_scan_pc_sizes.ps1:3, 5; _scan_pc_repack.ps1:5, 8-9; _pc_sizes.json/_pc_repack.json grep (no '[' or ']' in names)."
    },
    {
      "item": "Komikku's cover handling affects metadata sync. Komikku overwrites the series-root cover.jpg when the user picks a custom cover, and its LocalCoverManager also matches cover.<ext>. A metadata-only sync must not blindly overwrite a device cover.jpg that differs from the PC copy, since it may be user-chosen, and cover checks should treat cover.<ext> as a near-miss.",
      "category": "feature",
      "evidence": "git show 1f17a20^:komikkuspec.md lines 89-94."
    },
    {
      "item": "Use Mihon ChapterRecognition as the filename-compatibility oracle. It strips vol/volume/season prefixes (UNWANTED), its BASIC pattern requires 'ch.' followed by a number, and OCCURRENCE requires the number to be a free-standing token. As a result, 'Vol N.pdf' has no chapter number and legacy 'Ch 168~1' names mis-parse. The port can validate device filenames against this exact regex set.",
      "category": "algorithm",
      "evidence": "git show 1f17a20^:komikkuspec.md lines 205-213; aio-dl.py:4969-4972."
    },
    {
      "item": "Device-folder replacement also covers the 15 fresh-download series, not only the 51 push rows. The plan's end state for all 66 non-compliant series is a CBZ folder replacing the device PDFs. For A.2 this discards 546 and 494 mangafire-numbered PDFs (JoJo 4 and 6), so the same dry-run and confirmation rails apply to 'download then replace'.",
      "category": "destructive_op",
      "evidence": "REDOWNLOAD_FOR_KOMIKKU.md:11-15, 38-42, 66-67."
    },
    {
      "item": "Docs and code disagree on where the PC folders come from. DELTA_FINDINGS.md says they came from tablet_vs_pc.json's alias-resolved mapping, but the code uses the separately hard-coded PUSH_MAP. So two hand-maintained maps (TABLET_TO_PC_ALIAS and PUSH_MAP) can diverge, and in the port they should be a single table. The docstring also says the input is /tmp/tablet_files.txt, while the code reads ./tablet_files.txt.",
      "category": "other",
      "evidence": "DELTA_FINDINGS.md:416-418 vs _delta_findings.py:42-107, 264-266; _delta_findings.py:6 vs :32; _compare_tablet_vs_pc.py:43-60."
    }
  ],
  "notes": "I read all 7 assigned files in full, with no paging needed: _classify_tablet.py (98 lines), _compare_tablet_vs_pc.py (189), _delta_findings.py (299), _scan_pc_repack.ps1 (44), _scan_pc_sizes.ps1 (24), REDOWNLOAD_FOR_KOMIKKU.md (220) and DELTA_FINDINGS.md (433). I checked the data files only with targeted grep/wc/sed, and used only read-only git commands (status, diff --stat, log, cat-file, show). I wrote no files and ran no adb, script or network commands. CompareManga paths are relative to C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\CompareManga\\; app paths are relative to C:\\Users\\legoc\\OneDrive\\Belgeler\\Scripts\\AIO-Webtoon-Downloader\\.\n\nTop items for the planner:\n(1) The Komikku spec can still be recovered with `git show 1f17a20^:komikkuspec.md`. The commit is on no branch, so capture the rules before anyone runs git gc. The spec also says Komikku reads only <SAF-root>/local/, which puts the Documents-tree assumption in question.\n(2) The content-loss guard and the numbering-mismatch detection were never automated; the script tags them identically, and the doc's lists were written by hand. The port has to implement both from scratch.\n(3) An identity-based matcher (url/hid/site) already exists as uncommitted work in aio-dl.py and library.js. Build on it rather than on the script's hid-collapse, which can merge distinct series.\n(4) Leaving out an alias never excluded JoJo Part 6. Exclusions have to be explicit, persisted overrides.\n(5) Adding an alias or override table as a top-level setting would trip SettingsTab's reference-equality dirty counter.\n(6) There are 21 untracked files, not 4, so there is more local-only work to protect than the census reported."
}
```
