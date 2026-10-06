---
name: electron-app-local-e2e-testing
description: "How to E2E-test the packaged Electron app on this machine — MSYS /S mangling, shared userData with the real install, local generic-feed recipe, restore procedure"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6fb3e5e3-3022-42fb-a385-3fa04267be17
---

Testing the packaged AIO Downloader app locally (learned during the auto-update E2E, 2026-07-12):

- **Git Bash mangles NSIS flags**: `./Setup.exe /S` from the Bash tool converts `/S` to a path → the installer opens its INTERACTIVE wizard and hangs forever. Run silent installs via PowerShell: `Start-Process -FilePath <exe> -ArgumentList "/S" -Wait -PassThru` (exit 0 = done).
- **The dev app, test installs, and the user's REAL install all share userData** (`%APPDATA%\aio-downloader-ui` — settings.json, download_history.json, python-env, thumb-cache) and the same install dir (`%LOCALAPPDATA%\Programs\AIO Downloader`). Before any install-over test: back up the two JSONs. NEVER run the NSIS uninstaller — `deleteAppDataOnUninstall: true` wipes userData including the multi-hundred-MB python-env (updates/install-overs are safe; only real uninstalls wipe).
- **Local update-feed E2E recipe** (no GitHub side effects): `npm pkg set build.publish.provider=generic build.publish.url=http://127.0.0.1:8765` + `npm version 9.9.8 --no-git-tag-version` → `dist:win` → repeat for 9.9.9 → `python -m http.server 8765 --directory release` (its access log is the observable; note it lacks Range support so differential downloads fall back to full — expected). Launch the installed exe with stdout redirected to a file to capture `[app-update]` logger lines (Electron main-process console works when spawned from a shell).
- **Installed version readout**: the exe's VersionInfo shows Electron's version (signAndEditExecutable:false skips rebranding) — read the real one from the asar: `node -e "require('@electron/asar').extractFile(LOCALAPPDATA+'/Programs/AIO Downloader/resources/app.asar','package.json')"`.
- **Restore after testing**: restore the JSON backups, `git checkout` ONLY if package.json feature edits are already committed (a checkout during uncommitted work reverts them — re-apply if so), rebuild at the original version, PowerShell-silent-install over the test build.
- The repo-level `CLAUDE.md` is untracked and excluded via `.git/info/exclude` — edits to it never enter PRs.

Related: [[app-design-language]]
