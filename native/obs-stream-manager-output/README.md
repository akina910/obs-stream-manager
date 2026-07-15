# OBS Stream Manager Output

This small OBS plugin creates a secondary Twitch RTMP output while the primary OBS stream is active. The app sends the server and stream key through an authenticated loopback obs-websocket vendor request; the plugin keeps them in memory and never writes them to OBS configuration files.

The plugin is distributed under GPL-2.0-or-later. Its reproducible Windows build uses a pinned OBS plugin template and the pinned official `obs-websocket-api.h`; `scripts/build-obs-plugin.ps1` verifies the downloaded header and license checksums.
