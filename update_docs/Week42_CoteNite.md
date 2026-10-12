# Week42 — Windows installation directory and data lifecycle

Implemented the behavior described by Issues #2, #4, #5, #6 and #7 on `feat/windows-installation-data`, based on local `develop`. No changes were merged into the teaching/documentation branch `main`.

## Storage and migration

Windows packaged startup invokes the bundled backend's `--prepare-installation-data` command before Electron's persistent session and backend initialization. `ripple-data/` holds the database, desktop settings and persistent Chromium reader state; `ripple-migration-backup/` retains the verified pre-migration state. Development, macOS and Linux retain their existing locations. Existing valid target data wins without merging legacy sources. Interrupted migration staging does not become a fresh account; recognized staging files can be retried while unknown files are preserved.

The supplemental data-preparation interface is `prepare_installation_data` / `confirm_installation_data`. Source snapshots use Windows deny-write file handles, SQLite integrity and encrypted-credential checks, hash-verified copies and activation records. Chromium preferences are compared through actual Electron sessions before source cleanup. Cleanup removes only recognized internal state; independent exports and unrelated files remain.

Before confirming a migrated Chromium session, isolated clones are opened in separate Electron processes. A committed random Local Storage probe must survive a process boundary, and the LevelDB `LOCK` file identity must remain unchanged; corrupt/unsupported stores that Chromium would recreate or replace with memory-only storage are rejected. Source and migration backup are never opened for repair by this verifier.

No business schema migration or new business HTTP endpoint was added. SQLite runtime errors now return HTTP 503 with a readable data-directory error. Reader fetch failures retain existing content, tag writes no longer report local-only success, failed note reads block saving, and preference changes are applied to in-memory state after persistence succeeds.

AI configuration reads are independent and retain their last successful values on failure. A visible retry alert and initial-read save gates prevent unread RAG defaults from overwriting valid configuration. Reader provider-load, tag-operation and unsubscribe failures are surfaced without clearing valid selection or content.

## Installer behavior

The assisted current-user NSIS installer exposes the final directory directly, preserves the old default and registered upgrade location, checks fixed local storage and write access, and rejects network/removable/mixed targets. Run it without administrator elevation. `ripple-program-files.json` identifies shipped files by relative path and SHA-256; installation registers installer-added program files, and removal preserves modified or unowned files.

Interactive uninstall defaults to preserving data and backups. An explicit delete choice runs only when uninstall begins. Silent uninstall and upgrade always preserve. Same-directory reinstall reopens retained data; different-directory reinstall does not scan another installation's state.

Upgrade protection runs before the previous version's uninstaller and stores independent files outside the directory that old uninstallers recursively clear. It verifies restored files before disposing the upgrade transaction. The trusted legacy reference is upstream v0.1.7 (`Ripple.Setup.0.1.7.exe`), SHA-256 `2035c5241320dca8742145f9c034bba452ba27fb321e00b0cf108642cb611630`; its file hashes are recorded in the legacy ownership manifest.

Incoming program paths are checked against current/legacy ownership hashes before extraction, so independent files cannot be overwritten by the replacement payload. Protected payloads live under a separate `files/` directory; per-file intent is journaled before copying. A current-user upgrade recovery location survives removal of the old installation registration, allowing the next installer run to restore protected content before retrying. Partial copies are discarded only when the original hash remains valid; damaged sole copies stop recovery.

## Exercised verification

- Backend: `python -m unittest discover -s tests` — 113 tests passed; the 12 installation-data tests cover real Windows read-denied profile recovery, missing pending database source preservation and never-launched deletion boundaries.
- Frontend: `npx vue-tsc --noEmit` passed; production frontend and PyInstaller backend builds completed.
- Real NSIS package compiled using installed Electron 33.4.11 and pinned electron-builder/NSIS tool caches after GitHub downloader timeouts. Publishing was disabled.
- Actual directory wizard installed to a Chinese/space path and launched the packaged renderer and backend. Tags, font size and palette survived exit/restart; health reported the database under the chosen directory.
- Actual read-only database write returned 503 and installed preference operations reported the storage error; restoring access retained the original tag and data location.
- Actual silent uninstall (including a legacy deletion flag) and interactive keep/delete branches preserved independent exports. Same-directory reinstall restored retained tags; delete consent alone did not remove data before uninstall began.
- Untouched trusted upstream v0.1.7 was installed and run, then upgraded: original tags/preferences migrated, backup remained readable, source database was cleaned after verification, and root/nested independent files survived. New-layout upgrade retained contents and backup hash and used the registered original directory.
- Supplementary PowerShell recovery smoke preserved an independent file named exactly like the protection journal, retried a partial payload against an intact original, and restored the complete file after its original was removed. Packaged backend deletion before first launch succeeded without creating data.
- Actual Chromium six-case smoke accepted a valid legacy profile and rejected corrupt manifests, unsupported schema versions and corrupt empty-profile maps; rejected cases retained source and backup byte hashes. Actual installed LevelDB-only write denial returned a desktop storage error; after ACL repair, a saved font value survived process restart.
- Actual installer retry recovered protected data after the old registration and original data files were removed; database SHA-256 matched the pre-upgrade value. An independent incoming `resources/app.asar` collision was rejected before extraction.
- Actual-source consumer smokes covered cached persisted article tag writes, note read/save identity races, failed unsubscribe/provider reads, independent AI settings reads, prior-value preservation and initial-read RAG save gating.
- Final installed AI settings surface showed all three synthetic HTTP 503 read errors, disabled unread RAG saves, and cleared the alert/re-enabled saving after retry succeeded. Final unregistered same-directory silent `/D` reinstall and preservation uninstall both completed successfully.

## Limits

The validation was performed with dedicated synthetic data and disposable paths on the current non-admin Windows account after checking for existing Ripple registrations/profiles; Hyper-V management was not available to this account. No signed public distribution, macOS/Linux runtime smoke or removable-drive hardware scenario was exercised. Automated backend tests do not replace the actual installer observations above. The feature does not add portable mode, cross-computer credentials, automatic updates or a backup-restoration UI.
