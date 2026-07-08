// Shared UI constants — values used across multiple tab components.
//
// LANGUAGES: the download/search language dropdown options. Previously
// duplicated byte-for-byte in DownloadTab.jsx, SearchTab.jsx, and
// SettingsTab.jsx (three copies that had to be kept in lockstep). Consumed by
// every <Select> that offers a language choice; add a new language here once
// and all three surfaces pick it up. The `value` strings are forwarded
// straight to aio-dl.py's --language flag, so they must match the Python
// side's accepted language codes.
//
// NOTE: the format option lists are intentionally NOT here — DownloadTab's
// FORMATS (carries a `desc` and the "None"/"Images only" label) and
// SearchTab's DOWNLOAD_FORMATS (label-only, "None") have different shapes and
// labels, so they stay local to their components.
export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "pt-br", label: "Portuguese (BR)" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "ru", label: "Russian" },
  { value: "ar", label: "Arabic" },
  { value: "tr", label: "Turkish" },
];
