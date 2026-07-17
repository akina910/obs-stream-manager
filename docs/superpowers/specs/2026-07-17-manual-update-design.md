# Manual application update design

## Goal

An installed Windows user can update OBS Stream Manager without Node.js, npm,
PowerShell commands, GitHub asset selection, or developer knowledge. Updates
remain explicitly user initiated: the application does not check, download, or
install an update at startup.

The first build containing this feature must still be installed once through
the existing installer. Later releases can be applied from inside the desktop
application.

## User experience

The desktop Settings screen contains an **Application update** card showing the
current version. The Windows notification-area menu also contains **Check for
updates**, which opens the desktop window and starts the same check.

The installed edition uses this flow:

1. The user presses **Check for updates**.
2. The application reports either that the current version is latest or that a
   newer stable version is available, including its version and release notes.
3. The user presses **Download update** and sees download progress.
4. After the package integrity check succeeds, the user presses **Restart and
   update**.
5. OBS Stream Manager shuts down its local server cleanly, the per-user NSIS
   installer applies the update, and the updated application starts again.

The Portable edition can check the latest version, but it does not overwrite
its currently running executable. It offers **Open download page** and explains
that the installer edition is recommended for one-click future updates.

All labels, progress states, and errors are available in Japanese and English.

## Safety rules

- No automatic update check, download, restart, or installation.
- Installing is blocked while OBS output, recording, replay buffer, an external
  YouTube/Twitch broadcast, or another manager operation is active.
- The desktop main process repeats the runtime-state check before installation;
  disabling a renderer button is not the only protection.
- An interrupted download or failed integrity check leaves the current
  installation untouched.
- Updates preserve `%APPDATA%\obs-stream-manager`, Windows Credential Manager
  entries, profiles, thumbnails, OAuth state, and desktop preferences.
- Release metadata is fixed to `akina910/obs-stream-manager`; the renderer
  cannot supply an arbitrary update URL.
- Stable builds ignore drafts and prereleases unless a later design explicitly
  adds an opt-in preview channel.

## Architecture

### Desktop update service

A focused desktop module owns the updater lifecycle and exposes a small state
machine:

- `idle`
- `checking`
- `up-to-date`
- `available`
- `downloading`
- `downloaded`
- `installing`
- `error`
- `unsupported` for development and Portable executions

The module wraps `electron-updater` behind an injected adapter so version and
state behavior can be unit tested without network access or launching an
installer. It sets `autoDownload` and `autoInstallOnAppQuit` to false.

Electron's main process exposes only these IPC operations through the existing
preload bridge:

- get current update state
- check for an update
- download the selected update
- install the verified update

Update-state events are pushed to the desktop renderer so progress does not
require polling. OBS browser docks do not receive installer-control IPC.

### Settings and tray

The React Settings view renders the update card only when the desktop preload
bridge exists. The card presents exactly one primary action for the current
state. The tray action calls the same update service, opens the main window,
and shows a Windows notification when a newer version is found.

### Release channel

GitHub Releases is the update source. Electron Builder produces the NSIS setup,
update metadata containing the package SHA-512 digest, and required blockmap.
A tag-triggered Windows release workflow will:

1. require the distributor OAuth build credentials;
2. run the complete repository check;
3. build the OBS plugin and Windows packages;
4. verify the extracted package;
5. publish the installer, Portable executable, ZIP, update metadata, checksums,
   and release notes to the matching GitHub Release.

Creating or pushing a tag and publishing a Release remain separate operational
actions. This implementation does not perform either without explicit user
permission.

## Error handling

Network unavailability, GitHub rate limiting, missing releases, invalid update
metadata, download failure, and integrity failure produce a Japanese/English
message with a retry action. They do not terminate the application.

If OBS is still open when an update contains a newer output plugin, the
application update may finish while the compatible loaded plugin remains in
use. The existing pending-plugin mechanism applies the bundled plugin on the
next safe OBS/application restart, and the UI must disclose that restart state.

## Verification

Implementation acceptance requires:

- red-green unit tests for version/state transitions and manual-only behavior;
- tests that Portable and development runs cannot self-install;
- tests that active streaming, recording, replay, external delivery, and busy
  state block installation;
- IPC contract tests and Japanese/English translation coverage;
- typecheck, lint, full automated tests, secret scan, and production build;
- Windows NSIS/Portable/ZIP generation;
- package verification including update metadata and its referenced checksum;
- confirmation that no startup code checks or downloads updates;
- confirmation that existing application data and credentials remain outside
  the installation directory;
- a live update check against GitHub Releases after publication of an approved
  test release.

Until an approved GitHub Release exists, the final live network and
installer-to-newer-version check is reported as blocked rather than passed.
