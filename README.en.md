# OBS Stream Manager

[日本語](README.md) | [English](README.en.md)

A Windows application that brings game selection, OBS controls, and YouTube/Twitch stream setup into one OBS browser dock. Packaged builds do not require end users to install Node.js, run npm or command-line tools, enter client IDs, or register developer applications. The app UI can be switched between Japanese and English.

> [!WARNING]
> This project is under development and comes without operational guarantees or individual support. No public GitHub Release is available yet. Test with a private YouTube stream and a Twitch test stream before going live.

## Current distribution status

- The repository can reproducibly build a Windows 11 x64 installer, Portable EXE, and Portable ZIP.
- Current test packages are available as Actions artifacts from the [Windows distribution workflow](https://github.com/akina910/obs-stream-manager/actions/workflows/windows-distribution.yml). A GitHub sign-in is required, and artifacts are retained for 14 days.
- A public GitHub Release for general users has not been published yet. Once releases begin, use only the files attached to the relevant Release.
- Current development builds are unsigned, so Windows SmartScreen may display a warning.

## Package options

### Installer

Run `OBS Stream Manager-Setup-*-x64.exe` and approve the Windows administrator prompt. Installation then completes automatically with no folder choice or manual OBS plugin placement. It creates Start menu and desktop shortcuts and is the recommended option. After the first launch, silent startup at Windows sign-in is enabled by default so the OBS dock is ready immediately. If Windows delays that startup entry, the bundled OBS plugin also requests a background launch of the installed companion application. You can disable login startup from Settings or the notification-area menu. Once public Releases begin, installed builds can download an update from Settings and restart into it.

### Portable EXE

Run `OBS Stream Manager-Portable-*-x64.exe` directly from any folder. Installation is not required. Windows requests administrator approval at launch so the bundled OBS plugin can be installed automatically. Portable builds are not registered for Windows startup because moving the executable would leave a broken startup entry. Start the EXE before opening OBS.

### Portable ZIP

Extract `OBS Stream Manager-*-win.zip` to any folder, then run `OBS Stream Manager.exe`. This option is useful for inspecting the packaged files or managing the application as a folder.

All package types store settings and credentials in the same Windows user data locations, not next to the executable. The EXE starts the bundled UI and local server automatically. End users do not need to install Node.js, build or start a server, or run commands. The local server listens only on `127.0.0.1` and is not exposed to the LAN or internet.

## OBS integration is automatic

While OBS is closed, OBS Stream Manager automatically prepares OBS's built-in connection, imports its local password, and registers the `Stream Manager` dock. End users do not enter a URL or password, enable WebSocket manually, or create a custom browser dock. If OBS was already running on first launch, close it once and start it again. Existing docks and unrelated OBS settings are preserved. [OBS_SETUP.md](docs/OBS_SETUP.md) is now only a recovery and advanced guide.

Closing the desktop window does not stop the OBS dock server. The app remains in the Windows notification area, and launching the EXE again reopens the same window. Choose **Quit completely** from the notification-area menu or Settings only when you also want to stop the local server. The OBS dock becomes unavailable after a complete quit.

## First-run setup

On first launch, a setup dialog covers only automatic OBS preparation, YouTube/Twitch connection, and game detection. Technical URLs and passwords are hidden. Completion is saved, so the dialog stays closed on later launches. You can reopen it from Settings at any time.

Steam is optional. When the Steam client is signed in, the app automatically adds owned games including games that are not installed locally. No Steam ID or Steam Web API key is required. Uninstalled games are configured for GeForce NOW, and the library clearly distinguishes local installs from cloud games. Without Steam, you can manually add Game Pass, GeForce NOW, Nintendo Switch, and standalone executable games. The app does not add fixed starter games such as ARK or Diablo.

## Connect and start a stream

1. Run the Setup EXE, then start OBS Stream Manager.
2. Start OBS. If first-run setup asks for a restart, close OBS once and start it again.
3. Press **Connect YouTube** or **Connect Twitch**.
4. Select your account in the default browser and grant the requested permissions.
5. Return to the app and confirm that the service shows **Connected**.
6. Select a game from the library, edit its settings if needed, and apply the profile.
7. Check the actual delivery status for each destination, then press **Start stream**.

YouTube uses PKCE for a desktop public client, and Twitch uses Device Code Flow. There is no end-user screen for Client ID, Client Secret, API Key, or Broadcaster ID. If the app reports a distribution configuration error, report it as an Issue instead of creating a developer application yourself.

**Connected** means that account authorization has been saved in Windows. It does not mean that video is live. Use the separate YouTube and Twitch live-status indicators at the top of the app to confirm actual delivery.

> [!IMPORTANT]
> The YouTube connection manages broadcasts, metadata, thumbnails, and the video output settings applied to OBS. The Twitch connection manages title, category, tags, chat, stream-key retrieval, and actual live status. The bundled OBS Stream Manager Output plugin creates an in-memory Twitch secondary output only while streaming, so no Aitum stream-key setup is required. Do not treat simulcasting as successful until Twitch reports `LIVE`.

## Requirements

- Supported target: Windows 11 x64
- Supported target: OBS Studio 31.1 or later; the built-in connection is configured automatically
- Simultaneous YouTube/Twitch output: the app installs its bundled plugin automatically; restart OBS after the first install or an update
- Optional: Aitum Vertical, Source Record, Advanced Scene Switcher, and Steam

Aitum Multistream is not required. If Source Record or Aitum Vertical is unavailable, only its corresponding extra recording feature is disabled with a warning.

After Windows administrator approval, the bundled plugin is installed automatically in OBS's official Windows plugin directory at `C:\ProgramData\obs-studio\plugins\obs-stream-manager-output`.

## Main features

- Profiles for PC, Nintendo Switch, and exception games
- Automatic discovery and library insertion of owned Steam games, including uninstalled games
- Clear indication of the selected game and currently applied profile
- OBS scene, capture, audio, recording, and replay-buffer control
- A BGM library for MP3, WAV, OGG, FLAC, and M4A files with shared looping playback, pause, and resume across scenes
- Per-game audio auto-adjustment from OBS meters, peak protection, and microphone sidechain ducking
- Isolated recording stems: A1 game, A2 Discord, A3 microphone, A4 BGM, A5 capture/AUX, with A6 as the shared YouTube/Twitch stream mix
- At 4K or high frame rates, standard recording shares the stream encoder while only overloaded Source Record/vertical encoders are suppressed
- Automatic YouTube broadcast, title, description, privacy, and per-game thumbnail setup
- Automatic Twitch title, category, tag, stream-key, and secondary-video-output setup, plus a non-public bandwidth test
- Title variables `{game}`, `{part}`, `{date}`, `{time}`, and `{datetime}`, with automatic Part advancement after a successful stream
- Separate authorization and actual live-status indicators for YouTube and Twitch
- Combined chat display and settings backup/restore
- Shared PNG/JPEG/WEBP stream-screen templates with per-profile game-label replacement and one-click application to every profile
- Japanese and English UI

## Data, updates, and uninstalling

Personal settings, game profiles, thumbnails, BGM tracks, shared stream templates, descriptions, logs, and backups are stored in `%APPDATA%\obs-stream-manager`. Updating the app preserves this folder. Each BGM file can be up to 50 MB and is attached to OBS through the managed `BGM Stock` media source. Backups exported from Settings include the BGM files and selected-track state, up to 150 MB total.

Configure the shared stream template from Settings. Its text supports `{game}`, `{part}`, `{date}`, `{time}`, and `{datetime}`. Each game can override only its template display name, such as shortening `ARK: Survival Ascended` to `ARK`. Create an OBS image source named `COMMON_STREAM_TEMPLATE` (or use the same custom source name in both OBS and the app). Selecting a game then assigns that profile's generated PNG to the source automatically.

### Manual updates

The app never checks, downloads, or restarts for an update automatically at startup. It checks GitHub Releases only after you choose **Check for updates** in Settings or the notification-area menu.

In the installed edition, choose **Check for updates**, **Download update**, then **Restart and update**. The final step is blocked while a stream, recording, replay buffer, YouTube/Twitch live broadcast, or broadcast transition is active. Game profiles, thumbnails, settings, and OAuth connections remain in place after the update.

Portable EXE and ZIP builds do not overwrite themselves while running. When an update is available, the app opens the fixed GitHub Releases page so you can replace the Portable copy. Use the installer edition for the simplest in-app update flow.

Secrets such as OAuth tokens, stream keys, and the OBS password are excluded from normal settings and backups. They are stored under the `obs-stream-manager` service in Windows Credential Manager.

Uninstall the app from **Windows Settings → Apps → Installed apps**. Uninstalling does not delete personal data, so a later installation can reuse it. To remove everything, uninstall the app and then manually delete `%APPDATA%\obs-stream-manager` and the `obs-stream-manager` entries from Windows Credential Manager.

## Issues and pull requests

Issues and pull requests are welcome. Bug reports should include the Windows, OBS, and app versions, reproduction steps, and logs with secrets removed. Never paste access tokens, refresh tokens, authorization codes, client secrets, stream keys, or OBS passwords into an Issue or screenshot.

## Development

Development setup, tests, reproducible Windows packaging, and distributor-only OAuth public-client configuration are documented separately in [DEVELOPMENT.md](docs/DEVELOPMENT.md) and [DISTRIBUTION.md](docs/DISTRIBUTION.md).

## License

[MIT](LICENSE)
