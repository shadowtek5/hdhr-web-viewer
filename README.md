# HDHomeRun Web Viewer

Watch live TV from your HDHomeRun network tuner in any web browser — on this PC,
a phone, a tablet, or a TV on the same network.

## Requirements

- **Python 3.8+** (no packages needed — standard library only)
- **ffmpeg** on the PATH (used to transcode broadcast MPEG-2 into browser-playable HLS)
- An HDHomeRun tuner on the same network

## Run it

Double-click **`start.bat`**, or from a terminal:

```
python server.py          # default port 8090
python server.py 9000     # custom port
```

Then open <http://localhost:8090>. The console also prints a network URL you can
open from other devices on your LAN.

## Run it in Docker

Ideal for a NAS or an always-on home server (the container bundles ffmpeg, so
the host needs nothing but Docker):

```
docker compose up -d --build
```

Then open `http://<docker-host-ip>:8090`.

- The compose file uses **bridge networking with a port mapping**, which works
  everywhere including Docker Desktop on Windows/Mac. Broadcast discovery
  can't cross the bridge, but SiliconDust cloud discovery and manually added
  IPs still find your tuner. On a **Linux host** (NAS, home server), switch to
  the commented `network_mode: host` in `docker-compose.yml` instead — then
  broadcast discovery works too.
- Saved devices and signal-survey results persist in the `./data` volume
  (`HDHR_DATA_DIR=/data` inside the container). To carry over an existing
  `devices.json`/`signals.json`, copy them into `./data` before first start.
- Change the port with the `HDHR_PORT` environment variable (host networking)
  or the port mapping (bridge).
- `docker stop` shuts down cleanly: ffmpeg processes are killed and the
  HDHomeRun's tuners are released.
- Transcoding happens inside the container — give it a couple of CPU cores;
  a 720p stream uses roughly one core.

### Published image

The image is published as
[`shadowtek5/hdhr-web-viewer`](https://hub.docker.com/r/shadowtek5/hdhr-web-viewer)
(`linux/amd64` + `linux/arm64`), so any Docker host can pull it without
building:

```
docker run -d --name hdhr-viewer --network host \
  -v /path/to/data:/data --restart unless-stopped \
  shadowtek5/hdhr-web-viewer:latest
```

### Homepage dashboard widget

The app exposes `/api/stats` — flat JSON made for the
[Homepage](https://github.com/gethomepage/homepage) `customapi` widget:

```json
{"version": "1.4", "updateAvailable": false, "activeStreams": 1,
 "tunerCount": 4, "tunersInUse": 1, "tunersFree": 3,
 "channels": 115, "device": "HDHomeRun FLEX 4K"}
```

**Step-by-step:**

1. **Find Homepage's config folder.** It's the folder mounted at `/app/config`
   of your Homepage container (check its compose file or, on Synology, the
   volume mapping in Container Manager). It contains `services.yaml`,
   `settings.yaml`, etc.

2. **Edit `services.yaml`** and add a service entry under whichever group you
   like (indentation matters — groups are top-level list items, services are
   nested under them):

   ```yaml
   - Media:
       - HDHomeRun Viewer:
           icon: mdi-television-classic
           href: http://<host-ip>:8090          # link when the tile is clicked
           description: Live TV
           widget:
             type: customapi
             url: http://<host-ip>:8090/api/stats
             refreshInterval: 10000             # poll every 10 s
             mappings:
               - field: activeStreams
                 label: Streaming
                 format: number
               - field: tunersFree
                 label: Tuners free
                 format: number
               - field: channels
                 label: Channels
                 format: number
               - field: version
                 label: Version
   ```

   Replace `<host-ip>` with the machine running this app (your NAS IP if it
   runs there). Use a real IP or hostname that the **browser and the Homepage
   container can both reach** — not `localhost`.

3. **Save** — Homepage hot-reloads config; refresh the dashboard and the tile
   appears with live numbers. No container restart needed.

**Customizing:**

- `/api/stats` also reports `tunersInUse`, `tunerCount`, `device`, and
  `updateAvailable` — swap any of them into the four mappings.
- Multiple tuners? Point the widget at a specific one with
  `url: http://<host-ip>:8090/api/stats?device=<tuner-ip>`.
- The endpoint is cheap to poll (10 s response cache), so a low
  `refreshInterval` is fine.

**Companion widget:** Homepage also ships a native `hdhomerun` widget that
talks to the tuner directly and works even when this app is stopped:

```yaml
- HDHomeRun Tuner:
    icon: mdi-antenna
    href: http://<tuner-ip>
    widget:
      type: hdhomerun
      url: http://<tuner-ip>
```

The pair looks great side by side: the native widget for the hardware, the
customapi one for streaming activity.

### Versions & updates

The app knows its own version (`APP_VERSION` in `server.py`) and checks Docker
Hub twice a day for a newer numeric tag. When one exists, a green **⬆ Update**
badge appears in the header and the Device tab's About panel shows the update
command. To release a new version: bump `APP_VERSION`, then

```
docker buildx build --builder multiarch --platform linux/amd64,linux/arm64 \
  -t shadowtek5/hdhr-web-viewer:latest -t shadowtek5/hdhr-web-viewer:<version> --push .
```

To update an install: `docker compose pull && docker compose up -d`
(on Synology: Container Manager → Project → hdhr-viewer → Action → "Clean and
rebuild" or update the image from the Images tab).

### Synology (DSM 7.2+)

1. Install **Container Manager** from Package Center.
2. Container Manager → **Project** → **Create**:
   - Project name: `hdhr-viewer`
   - Path: create e.g. `/docker/hdhr-viewer`
   - Source: **Upload docker-compose.yml** → pick `docker-compose.synology.yml`
     from this folder
3. Build/start the project, then open `http://<synology-ip>:8090`.

The Synology compose file uses host networking (fine on DSM) and pulls the
published image — no building on the NAS. Saved devices and signal results
land in `data/` inside the project folder. To carry over what you have here,
copy this folder's `data/devices.json` and `data/signals.json` there.

## Features

- **Auto-discovery** of HDHomeRun tuners three ways: UDP broadcast (same subnet),
  the SiliconDust cloud API (finds tuners on other subnets/VLANs), and remembered
  devices (`devices.json` — manual add-by-IP saves there automatically)
- **Channel list** with search, HD/DRM badges, and favorites (starred channels sort to the top)
- **Now playing** program titles from the SiliconDust guide API (needs internet; optional)
- **TV Guide tab** — timeline grid of what's on across all channels, with a live
  "now" line, paging to later hours, program details (episode number, artwork),
  and click-to-watch for shows airing now
- **Filters** — All / Favorites / HD chips + search; channels that fail with
  "no signal" get flagged automatically and can be hidden with one click
  (a flagged channel un-flags itself if it later plays successfully)
- **Signal survey** — the 📶 Test signal button tunes each transmitter in the
  lineup (one probe per RF mux, so subchannels are covered by a single test)
  and reads the tuner's real signal strength/quality. Every channel then shows
  a green/yellow/red dot (hover for percentages), weak channels get a WEAK
  badge, and "Hide no-signal" filters out the dead ones. Results are saved in
  `signals.json` and survive restarts; re-run the test after moving the antenna.
- **Device tab** — device info, live per-tuner status (channel, signal strength /
  quality / symbol quality, network rate, refreshed every 5 s), and **channel
  scanning** with source selection (Antenna/Cable), live progress, and abort
- **Live streaming** transcoded on the fly with ffmpeg (H.264 + AAC HLS), with
  quality options: 720p (default), Native, 480p
- Streams stop automatically ~30 s after the last viewer disconnects, freeing the tuner

## Music

The classic guide's background music is royalty-free smooth jazz by Kevin
MacLeod (incompetech.com), CC BY 4.0 — see [ATTRIBUTION.md](ATTRIBUTION.md).
The app shuffles every audio file it finds in `static/music/`, so add or swap
`.mp3`/`.ogg`/`.m4a` tracks freely. If the folder is empty it falls back to a
built-in synthesized jazz loop.

## Notes

- Guide data comes from SiliconDust's free API: titles, times, episode numbers,
  and artwork. Full synopses require an HDHomeRun DVR subscription.
- Starting a channel scan interrupts all active streams/recordings and takes
  several minutes; the app shows live progress and reloads the lineup when done.

- Channel-change takes a few seconds — that's the tuner locking plus ffmpeg
  producing the first HLS segment.
- Live streams run ~6–10 seconds behind broadcast (HLS segment buffering).
- DRM-flagged channels can't be streamed (HDHomeRun blocks them at the source).
- Stream errors are read from the tuner itself (`X-HDHomeRun-Error`), so
  "no signal on this channel" and "all tuners in use" are reported distinctly.
  A channel scan can include distant stations your antenna can't actually
  receive — those show a "no signal" error when you try them.
- Transcoding uses CPU on the machine running the server: roughly one core per
  720p stream. Up to 4 simultaneous streams are allowed.

## How it works

`server.py` discovers tuners (HDHomeRun UDP discovery protocol on port 65001),
proxies each device's `lineup.json`, and on play spawns
`ffmpeg -i http://<tuner>:5004/auto/v<channel> … -f hls` into a temp directory,
which it serves to the browser. The frontend (`static/`) plays it with hls.js.

