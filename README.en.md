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

Run `OBS Stream Manager-Setup-*-x64.exe` and follow the prompts to install for the current Windows user. It creates Start menu and desktop shortcuts. This is the recommended option for normal use. After the first launch, silent startup at Windows sign-in is enabled by default so the OBS dock is ready immediately. You can disable it from Settings or the notification-area menu.

### Portable EXE

Run `OBS Stream Manager-Portable-*-x64.exe` directly from any folder. Installation is not required. Portable builds are not registered for Windows startup because moving the executable would leave a broken startup entry. Start the EXE before opening OBS.

### Portable ZIP

Extract `OBS Stream Manager-*-win.zip` to any folder, then run `OBS Stream Manager.exe`. This option is useful for inspecting the packaged files or managing the application as a folder.

All package types store settings and credentials in the same Windows user data locations, not next to the executable. The EXE starts the bundled UI and local server automatically. End users do not need to install Node.js, build or start a server, or run commands. The local server listens only on `127.0.0.1` and is not exposed to the LAN or internet.

## Add the OBS dock

1. Start OBS Stream Manager.
2. In OBS Studio, open **Docks → Custom Browser Docks**.
3. Enter `Stream Manager` as the name and `http://127.0.0.1:4317` as the URL.
4. Place the new dock wherever you prefer.

The desktop window also displays the dock URL and a copy button. See [OBS_SETUP.md](docs/OBS_SETUP.md) for the detailed OBS configuration guide.

Closing the desktop window does not stop the OBS dock server. The app remains in the Windows notification area, and launching the EXE again reopens the same window. Choose **Quit completely** from the notification-area menu or Settings only when you also want to stop the local server. The OBS dock becomes unavailable after a complete quit.

## First-run setup

On first launch, a setup dialog guides you through the display language, OBS dock URL, OBS WebSocket connection, YouTube/Twitch authorization, and game detection. Completion is saved, so the dialog stays closed on later launches. You can reopen it from Settings at any time.

Steam is optional. Installed Steam games are added automatically only when Steam is detected. Without Steam, you can manually add Game Pass, GeForce NOW, Nintendo Switch, and standalone executable games. The app does not add fixed starter games such as ARK or Diablo.

## Connect and start a stream

1. In OBS, open **Tools → WebSocket Server Settings** and enable the WebSocket server.
2. In first-run setup or Settings, save the OBS WebSocket URL and its password if one is configured.
3. Press **Connect YouTube** or **Connect Twitch**.
4. Select your account in the default browser and grant the requested permissions.
5. Return to the app and confirm that the service shows **Connected**.
6. Select a game from the library, edit its settings if needed, and apply the profile.
7. Check the actual delivery status for each destination, then press **Start stream**.

YouTube uses PKCE for a desktop public client, and Twitch uses Device Code Flow. There is no end-user screen for Client ID, Client Secret, API Key, or Broadcaster ID. If the app reports a distribution configuration error, report it as an Issue instead of creating a developer application yourself.

**Connected** means that account authorization has been saved in Windows. It does not mean that video is live. Use the separate YouTube and Twitch live-status indicators at the top of the app to confirm actual delivery.

> [!IMPORTANT]
> The YouTube connection manages broadcasts, metadata, thumbnails, and the video output settings applied to OBS. The Twitch connection manages title, category, tags, chat, and actual live status, but it does not configure the Twitch video output destination. YouTube/Twitch simulcasting therefore requires a preconfigured Twitch output in Aitum Multistream. Do not treat simulcasting as successful until Twitch reports `LIVE`.

## Requirements

- Supported target: Windows 11 x64
- Supported target: OBS Studio 30 or later with its built-in WebSocket server enabled
- For simultaneous YouTube and Twitch video output: Aitum Multistream
- Optional: Aitum Vertical, Source Record, Advanced Scene Switcher, and Steam

You can use YouTube-only streaming, game profile management, and standard OBS controls without Aitum Multistream. If Source Record or Aitum Vertical is unavailable, only its corresponding extra recording feature is disabled with a warning.

## Main features

- Profiles for PC, Nintendo Switch, and exception games
- Automatic discovery and library insertion of installed Steam games
- Clear indication of the selected game and currently applied profile
- OBS scene, capture, audio, recording, and replay-buffer control
- Automatic YouTube broadcast, title, description, privacy, and per-game thumbnail setup
- Automatic Twitch title, category, and tag setup
- Title variables `{game}`, `{part}`, `{date}`, `{time}`, and `{datetime}`, with automatic Part advancement after a successful stream
- Separate authorization and actual live-status indicators for YouTube and Twitch
- Combined chat display and settings backup/restore
- Japanese and English UI

## Data, updates, and uninstalling

Personal settings, game profiles, thumbnails, descriptions, logs, and backups are stored in `%APPDATA%\obs-stream-manager`. Updating the app preserves this folder.

Secrets such as OAuth tokens, stream keys, the OBS password, and the Steam API key are excluded from normal settings and backups. They are stored under the `obs-stream-manager` service in Windows Credential Manager.

Uninstall the app from **Windows Settings → Apps → Installed apps**. Uninstalling does not delete personal data, so a later installation can reuse it. To remove everything, uninstall the app and then manually delete `%APPDATA%\obs-stream-manager` and the `obs-stream-manager` entries from Windows Credential Manager.

## Issues and pull requests

Issues and pull requests are welcome. Bug reports should include the Windows, OBS, and app versions, reproduction steps, and logs with secrets removed. Never paste access tokens, refresh tokens, authorization codes, client secrets, stream keys, OBS passwords, or Steam API keys into an Issue or screenshot.

## Development

Development setup, tests, reproducible Windows packaging, and distributor-only OAuth public-client configuration are documented separately in [DEVELOPMENT.md](docs/DEVELOPMENT.md) and [DISTRIBUTION.md](docs/DISTRIBUTION.md).

## License

[MIT](LICENSE)
