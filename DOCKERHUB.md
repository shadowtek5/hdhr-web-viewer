# HDHomeRun Web Viewer

Watch live TV from an HDHomeRun network tuner in any web browser. Zero-config
web app: discovers your tuner, shows a TV guide, and transcodes broadcast
MPEG-2 to browser-playable HLS on the fly with the bundled ffmpeg.

## Features

- Auto-discovery (UDP broadcast + SiliconDust cloud lookup + manual IP)
- Live streaming with quality selection (720p / native / 480p)
- TV guide grid with now-playing info and click-to-watch
- Channel filters, favorites, and a real signal-strength survey per channel
- Device page: tuner status, signal meters, and channel scanning
- Light & dark themes; works on phones, tablets, and TV browsers

## Quick start

```
docker run -d --name hdhr-viewer --network host \
  -v /path/to/data:/data \
  --restart unless-stopped \
  shadowtek5/hdhr-web-viewer:latest
```

Open `http://<host-ip>:8090`.

- `--network host` (Linux hosts incl. Synology/QNAP/Unraid) enables UDP
  broadcast discovery. On Docker Desktop use `-p 8090:8090` instead — cloud
  discovery and manual IP entry still find your tuner.
- `/data` stores saved devices and signal-survey results.
- `HDHR_PORT` changes the listening port (default 8090).

## Credits

Background music in the classic guide: Kevin MacLeod
([incompetech.com](https://incompetech.com)), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Requirements

- An HDHomeRun tuner (CONNECT, FLEX, etc.) on your network
- ~1 CPU core per concurrent 720p transcode

Architectures: `linux/amd64`, `linux/arm64`.
