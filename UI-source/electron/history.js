// ============================================================
// HISTORY MANAGER
//
// Persists download history and user settings to JSON files
// in Electron's userData folder:
//   Windows: %AppData%/aio-downloader-ui/
//
// Two files:
//   download_history.json  → list of past downloads
//   settings.json          → user preferences and defaults
// ============================================================

const fs = require("fs");
const path = require("path");

class HistoryManager {
  constructor(userDataPath) {
    this._dataDir = userDataPath;
    this._historyPath = path.join(userDataPath, "download_history.json");
    this._settingsPath = path.join(userDataPath, "settings.json");

    // Make sure the data directory exists
    fs.mkdirSync(userDataPath, { recursive: true });

    // Load existing data from disk (or start with empty arrays/objects)
    this._history = this._loadJson(this._historyPath, []);
    this._settings = this._loadJson(this._settingsPath, {});
  }

  /**
   * Safely read a JSON file from disk.
   * Returns the fallback value if the file doesn't exist or is corrupted.
   */
  _loadJson(filePath, fallback) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error(`Failed to load ${filePath}:`, err.message);
    }
    return fallback;
  }

  /**
   * Write data to a JSON file on disk.
   * Uses a temporary file + rename to avoid corrupted writes if the
   * app crashes mid-write.
   *
   * Windows EBUSY/EACCES handling: AV scanners and OneDrive shims
   * occasionally hold filePath open (typically for milliseconds) which
   * makes rename fail. Falls back to copyFileSync, which is happier
   * sharing a target with another reader. Always cleans up the tmp
   * file in the finally block — without this, a failed rename used
   * to leak the .tmp file alongside subsequent successful renames,
   * AND in-memory state diverged from disk for the entire app session.
   */
  _saveJson(filePath, data) {
    const tmp = filePath + ".tmp";
    let wrote = false;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      wrote = true;
      try {
        fs.renameSync(tmp, filePath);
      } catch (err) {
        if (err && (err.code === "EBUSY" || err.code === "EACCES" || err.code === "EPERM")) {
          // Windows lock contention. Copy is more permissive than rename
          // because it doesn't need exclusive access to the target's
          // directory entry, just write access to the file contents.
          try {
            fs.copyFileSync(tmp, filePath);
          } catch (copyErr) {
            console.error(
              `Failed to save ${filePath} (rename + copy fallback): ${copyErr.message}`,
            );
          }
        } else {
          console.error(`Failed to save ${filePath}: ${err.message}`);
        }
      }
    } catch (err) {
      // Write itself failed (disk full, permissions, etc.). Tmp may not
      // exist; the finally cleanup handles either case.
      console.error(`Failed to save ${filePath} (write phase): ${err.message}`);
    } finally {
      // Always clean up tmp regardless of which branch errored, so we
      // don't accumulate stale .tmp files alongside the real file.
      if (wrote) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
  }

  // ── History ──

  getAll() {
    return [...this._history];
  }

  /**
   * Add or update an entry in the download history.
   * Called when a download completes, fails, or is cancelled.
   */
  updateEntry(downloadId, result) {
    const entry = {
      downloadId,
      timestamp: new Date().toISOString(),
      ...result,
    };

    // Check if this downloadId already exists (update it)
    const idx = this._history.findIndex((h) => h.downloadId === downloadId);
    if (idx >= 0) {
      this._history[idx] = { ...this._history[idx], ...entry };
    } else {
      // Add to the front (most recent first)
      this._history.unshift(entry);
    }

    // Keep only the last 200 entries to avoid the file growing forever
    if (this._history.length > 200) {
      this._history = this._history.slice(0, 200);
    }

    this._saveJson(this._historyPath, this._history);
  }

  // ── Settings ──

  getSettings() {
    return { ...this._settings };
  }

  saveSettings(newSettings) {
    const next = { ...this._settings, ...newSettings };
    for (const key of ["defaults", "searchOpts", "libraryOpts"]) {
      if (
        newSettings[key] &&
        typeof newSettings[key] === "object" &&
        !Array.isArray(newSettings[key])
      ) {
        next[key] = { ...(this._settings[key] || {}), ...newSettings[key] };
      }
    }
    this._settings = next;
    this._saveJson(this._settingsPath, this._settings);
  }
}

module.exports = { HistoryManager };
