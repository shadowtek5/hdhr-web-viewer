#!/usr/bin/env python3
"""HDHomeRun Web Viewer server.

Zero-dependency (Python stdlib only). Requires ffmpeg on PATH for transcoding
the tuner's MPEG-TS stream into browser-playable HLS.

Usage: python server.py [port]   (default port 8090)
"""

import atexit
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_VERSION = "1.5"
UPDATE_REPO = "shadowtek5/hdhr-web-viewer"  # Docker Hub repo checked for newer tags

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
# In Docker, HDHR_DATA_DIR points at a mounted volume so saved devices and
# signal-survey results persist across container rebuilds.
DATA_DIR = os.environ.get("HDHR_DATA_DIR", ROOT)
DEFAULT_PORT = int(os.environ.get("HDHR_PORT", "8090"))

SESSION_IDLE_SECONDS = 30      # reap streams nobody is polling
MAX_SESSIONS = 4               # most HDHomeRuns have 2-4 tuners
STARTUP_TIMEOUT = 25           # seconds to wait for ffmpeg's first HLS segment

CHANNEL_RE = re.compile(r"^[0-9]{1,5}(\.[0-9]{1,4})?$")

# ---------------------------------------------------------------------------
# HDHomeRun discovery (UDP broadcast, port 65001)
# ---------------------------------------------------------------------------

def _discover_packet():
    # Discover request (type 0x0002): wildcard device type + device id tags,
    # framed as >type >length payload <crc32.
    payload = struct.pack(">BB4sBB4s",
                          0x01, 4, b"\xff\xff\xff\xff",
                          0x02, 4, b"\xff\xff\xff\xff")
    frame = struct.pack(">HH", 0x0002, len(payload)) + payload
    return frame + struct.pack("<I", zlib.crc32(frame) & 0xFFFFFFFF)


def discover_device_ips(timeout=2.0):
    ips = set()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(0.4)
        packet = _discover_packet()
        for _ in range(2):  # UDP is lossy; ask twice
            try:
                sock.sendto(packet, ("255.255.255.255", 65001))
            except OSError:
                pass
            deadline = time.time() + timeout / 2
            while time.time() < deadline:
                try:
                    data, addr = sock.recvfrom(2048)
                except socket.timeout:
                    break
                except OSError:
                    break
                if len(data) >= 4 and struct.unpack(">H", data[:2])[0] == 0x0003:
                    ips.add(addr[0])
    finally:
        sock.close()
    return sorted(ips)


def discover_cloud():
    """SiliconDust cloud discovery: finds devices sharing this network's public
    IP even when they're on a different subnet (UDP broadcast can't cross)."""
    try:
        data = http_get_json("https://api.hdhomerun.com/discover", timeout=8)
        return [d["LocalIP"] for d in data if d.get("LocalIP")]
    except Exception:
        return []


SAVED_DEVICES_FILE = os.path.join(DATA_DIR, "devices.json")
_saved_lock = threading.Lock()


def load_saved_ips():
    try:
        with open(SAVED_DEVICES_FILE) as f:
            return [ip for ip in json.load(f) if valid_ip(ip)]
    except (OSError, ValueError):
        return []


def save_ip(ip):
    with _saved_lock:
        ips = load_saved_ips()
        if ip not in ips:
            ips.append(ip)
            try:
                with open(SAVED_DEVICES_FILE, "w") as f:
                    json.dump(ips, f)
            except OSError:
                pass


def http_get_json(url, timeout=5):
    req = urllib.request.Request(url, headers={"User-Agent": "HDHomeRunWebViewer/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def fetch_device_info(ip):
    info = http_get_json(f"http://{ip}/discover.json")
    info["IP"] = ip
    return info


def valid_ip(value):
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False

# ---------------------------------------------------------------------------
# Guide data (SiliconDust cloud API; needs internet, fails gracefully)
# ---------------------------------------------------------------------------

_guide_cache = {}  # (ip, start) -> (fetched_at, data)
_guide_lock = threading.Lock()

def fetch_guide(ip, start=None, channel=None):
    key = (ip, start, channel)
    with _guide_lock:
        cached = _guide_cache.get(key)
        if cached and time.time() - cached[0] < 900:
            return cached[1]
    info = fetch_device_info(ip)
    auth = info.get("DeviceAuth")
    if not auth:
        return []
    url = "https://api.hdhomerun.com/api/guide.php?DeviceAuth=" + urllib.parse.quote(auth)
    if channel:
        url += "&Channel=" + urllib.parse.quote(channel)  # extended data incl. Synopsis
    if start:
        url += "&Start=" + str(int(start))
    data = http_get_json(url, timeout=15)
    if not isinstance(data, list):
        data = []
    with _guide_lock:
        _guide_cache[key] = (time.time(), data)
        if len(_guide_cache) > 32:  # bound memory across paging windows
            oldest = min(_guide_cache, key=lambda k: _guide_cache[k][0])
            del _guide_cache[oldest]
    return data


SOURCE_RE = re.compile(r"^[A-Za-z0-9 ]{1,24}$")


def device_post(ip, path_and_query):
    """POST to the tuner's own HTTP API (same calls its web UI makes)."""
    req = urllib.request.Request(
        f"http://{ip}{path_and_query}", data=b"", method="POST",
        headers={"User-Agent": "HDHomeRunWebViewer/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status

# ---------------------------------------------------------------------------
# Update check: compare APP_VERSION against the newest numeric tag on Docker
# Hub. Best-effort — no internet just means "no update news".
# ---------------------------------------------------------------------------

_update_cache = {"ts": 0.0, "latest": None}
_update_lock = threading.Lock()


def parse_version(s):
    try:
        return tuple(int(p) for p in str(s).split("."))
    except (ValueError, AttributeError):
        return None


def fetch_latest_version():
    with _update_lock:
        if time.time() - _update_cache["ts"] < 6 * 3600:
            return _update_cache["latest"]
    latest = None
    try:
        data = http_get_json(
            f"https://hub.docker.com/v2/repositories/{UPDATE_REPO}/tags?page_size=25",
            timeout=8)
        versions = [parse_version(t.get("name")) for t in data.get("results", [])]
        versions = [v for v in versions if v]
        if versions:
            latest = ".".join(str(n) for n in max(versions))
    except Exception:
        pass
    with _update_lock:
        _update_cache.update(ts=time.time(), latest=latest)
    return latest


def version_info():
    latest = fetch_latest_version()
    cur = parse_version(APP_VERSION)
    newer = bool(latest and cur and parse_version(latest) > cur)
    return {"version": APP_VERSION, "latest": latest,
            "updateAvailable": newer, "repo": UPDATE_REPO}


# ---------------------------------------------------------------------------
# Dashboard stats (for gethomepage.dev customapi widgets and similar).
# Flat JSON, cheap to poll: cached 10s, lineup size cached 10 min.
# ---------------------------------------------------------------------------

_stats_lock = threading.Lock()
_stats_cache = {}         # ip-or-'' -> (ts, data)
_lineup_count_cache = {}  # ip -> (ts, count)
_stats_device = {"ts": 0.0, "ip": None}


def find_stats_device():
    """Best device to report stats for: saved file, else live discovery
    (UDP broadcast, then cloud). Found IPs cache 1h; misses retry after 60s."""
    saved = load_saved_ips()
    if saved:
        return saved[0]
    with _stats_lock:
        age = time.time() - _stats_device["ts"]
        if age < (3600 if _stats_device["ip"] else 60):
            return _stats_device["ip"]
    ips = discover_device_ips(timeout=1.5) or discover_cloud()
    ip = ips[0] if ips else None
    with _stats_lock:
        _stats_device.update(ts=time.time(), ip=ip)
    return ip


def _lineup_count(ip):
    cached = _lineup_count_cache.get(ip)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    count = None
    try:
        count = len(http_get_json(f"http://{ip}/lineup.json", timeout=4))
    except Exception:
        pass
    _lineup_count_cache[ip] = (time.time(), count)
    return count


def collect_stats(ip=None):
    key = ip or ""
    with _stats_lock:
        cached = _stats_cache.get(key)
        if cached and time.time() - cached[0] < 10:
            return cached[1]

    with sessions_lock:
        active = sum(1 for s in sessions.values() if s["proc"].poll() is None)

    data = {
        "version": APP_VERSION,
        "updateAvailable": version_info()["updateAvailable"],
        "activeStreams": active,
        "tunerCount": None, "tunersInUse": None, "tunersFree": None,
        "channels": None, "device": None,
    }
    target = ip or find_stats_device()
    if target:
        try:
            status = http_get_json(f"http://{target}/status.json", timeout=3)
            in_use = sum(1 for t in status if t.get("VctNumber") or t.get("Frequency"))
            data["tunersInUse"] = in_use
            data["tunerCount"] = len(status)
            data["tunersFree"] = len(status) - in_use
        except Exception:
            pass
        try:
            info = fetch_device_info(target)
            data["device"] = info.get("FriendlyName") or info.get("ModelNumber")
            if info.get("TunerCount"):
                data["tunerCount"] = info["TunerCount"]
                if data["tunersInUse"] is not None:
                    data["tunersFree"] = info["TunerCount"] - data["tunersInUse"]
        except Exception:
            pass
        data["channels"] = _lineup_count(target)

    with _stats_lock:
        _stats_cache[key] = (time.time(), data)
        if len(_stats_cache) > 8:
            _stats_cache.pop(min(_stats_cache, key=lambda k: _stats_cache[k][0]))
    return data


# ---------------------------------------------------------------------------
# Signal survey: probe one subchannel per RF mux and read real tuner stats.
# Subchannels (11.1, 11.2, ...) share a transmitter, so one probe covers all.
# ---------------------------------------------------------------------------

SIGNALS_FILE = os.path.join(DATA_DIR, "signals.json")
_signal_state = {}  # ip -> {"running","progress","total","results","ts"}
_signal_lock = threading.Lock()


def _load_signal_file():
    try:
        with open(SIGNALS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_signal_file(ip, results):
    data = _load_signal_file()
    data[ip] = {"ts": time.time(), "results": results}
    try:
        with open(SIGNALS_FILE, "w") as f:
            json.dump(data, f)
    except OSError:
        pass


def probe_mux(ip, channel):
    """Tune a channel briefly; return {"status": good|weak|none|unknown, ...}."""
    url = f"http://{ip}:5004/auto/v{channel}"
    req = urllib.request.Request(url, headers={"User-Agent": "HDHomeRunWebViewer/1.0"})
    try:
        resp = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        detail = e.headers.get("X-HDHomeRun-Error", "") if e.headers else ""
        code = detail.split(" ")[0] if detail else ""
        if code in ("805", "806"):  # tuners busy: can't judge signal
            return {"status": "unknown"}
        return {"status": "none"}
    except Exception:
        return {"status": "unknown"}
    strength = quality = None
    got = 0
    try:
        with resp:
            tuner = resp.headers.get("X-HDHomeRun-Resource", "")
            deadline = time.time() + 1.5  # let tuner stats settle
            while time.time() < deadline:
                chunk = resp.read(32768)
                if not chunk:
                    break
                got += len(chunk)
            if tuner:
                try:
                    for t in http_get_json(f"http://{ip}/status.json"):
                        if t.get("Resource") == tuner:
                            strength = t.get("SignalStrengthPercent")
                            quality = t.get("SignalQualityPercent")
                except Exception:
                    pass
    except Exception:
        pass
    if not got:
        return {"status": "none", "strength": strength, "quality": quality}
    status = "good"
    if quality is not None and quality < 55:
        status = "weak"
    return {"status": status, "strength": strength, "quality": quality}


def signal_scan_thread(ip, muxes):
    results = {}
    for i, (major, channel) in enumerate(muxes):
        results[major] = probe_mux(ip, channel)
        with _signal_lock:
            st = _signal_state[ip]
            st["progress"] = i + 1
            st["results"] = dict(results)
    with _signal_lock:
        _signal_state[ip].update(running=False, ts=time.time())
        _save_signal_file(ip, results)


def start_signal_scan(ip):
    with _signal_lock:
        st = _signal_state.get(ip)
        if st and st.get("running"):
            return "A signal test is already running."
    lineup = http_get_json(f"http://{ip}/lineup.json")
    muxes, seen = [], set()
    for ch in lineup:
        num = str(ch.get("GuideNumber", ""))
        if not num or ch.get("DRM"):
            continue
        major = num.split(".")[0]
        if major not in seen:
            seen.add(major)
            muxes.append((major, num))
    if not muxes:
        return "No channels to test."
    with _signal_lock:
        _signal_state[ip] = {"running": True, "progress": 0, "total": len(muxes),
                             "results": {}, "ts": time.time()}
    threading.Thread(target=signal_scan_thread, args=(ip, muxes), daemon=True).start()
    return None


def get_signal_status(ip):
    with _signal_lock:
        st = _signal_state.get(ip)
        if st:
            return dict(st)
    saved = _load_signal_file().get(ip)
    if saved:
        return {"running": False, "progress": 0, "total": 0,
                "results": saved.get("results", {}), "ts": saved.get("ts")}
    return {"running": False, "progress": 0, "total": 0, "results": {}, "ts": None}


# ---------------------------------------------------------------------------
# Stream sessions (ffmpeg -> HLS in a temp dir)
# ---------------------------------------------------------------------------

sessions = {}
sessions_lock = threading.Lock()

QUALITY = {
    "native": {"scale": None,  "vb": "6000k", "maxrate": "7000k", "bufsize": "12000k"},
    "720":    {"scale": "720", "vb": "3500k", "maxrate": "4200k", "bufsize": "8000k"},
    "480":    {"scale": "480", "vb": "1500k", "maxrate": "1800k", "bufsize": "4000k"},
}


def build_ffmpeg_cmd(src_url, out_dir, quality):
    q = QUALITY.get(quality, QUALITY["720"])
    vf = "yadif=0:-1:1"  # deinterlace (broadcast is often 1080i/480i)
    if q["scale"]:
        vf += f",scale=-2:{q['scale']}"
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-fflags", "+discardcorrupt+genpts",
        "-i", src_url,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-b:v", q["vb"], "-maxrate", q["maxrate"], "-bufsize", q["bufsize"],
        "-force_key_frames", "expr:gte(t,n_forced*2)",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-f", "hls",
        "-hls_time", "2", "-hls_list_size", "6",
        "-hls_flags", "delete_segments+independent_segments",
        "-hls_segment_filename", os.path.join(out_dir, "seg%05d.ts"),
        os.path.join(out_dir, "index.m3u8"),
    ]


def stop_session(session_id):
    with sessions_lock:
        sess = sessions.pop(session_id, None)
    if not sess:
        return False
    proc = sess["proc"]
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    shutil.rmtree(sess["dir"], ignore_errors=True)
    return True


def stop_all_sessions():
    for sid in list(sessions.keys()):
        stop_session(sid)


atexit.register(stop_all_sessions)


HDHR_ERROR_MESSAGES = {
    "801": "Unknown channel — try rescanning channels on the HDHomeRun.",
    "802": "Unknown channel program.",
    "805": "All tuners are in use (another app or DVR recording is using them).",
    "806": "The tuner is busy with a recording.",
    "807": "No signal — this channel is in the lineup but isn't receivable with your antenna right now.",
    "808": "The tuner failed to tune this channel.",
}


def diagnose_stream_url(url):
    """Ask the tuner directly why a stream fails; returns a message or None if
    the URL actually works (i.e. the failure was elsewhere)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "HDHomeRunWebViewer/1.0"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            resp.read(1316)  # got video data; the channel is fine
        return None
    except urllib.error.HTTPError as e:
        detail = e.headers.get("X-HDHomeRun-Error", "") if e.headers else ""
        code = detail.split(" ")[0] if detail else ""
        return HDHR_ERROR_MESSAGES.get(code) or (
            f"HDHomeRun error: {detail}" if detail else f"HDHomeRun returned HTTP {e.code}.")
    except Exception as exc:
        return f"Could not reach the tuner: {exc}"


def start_session(device_ip, channel, quality):
    """Returns (session_id, None) on success or (None, error_message)."""
    if not valid_ip(device_ip):
        return None, "Invalid device address."
    if not CHANNEL_RE.match(channel):
        return None, "Invalid channel number."

    # Make room: reap dead sessions, then refuse if truly full.
    with sessions_lock:
        dead = [sid for sid, s in sessions.items() if s["proc"].poll() is not None]
    for sid in dead:
        stop_session(sid)
    with sessions_lock:
        if len(sessions) >= MAX_SESSIONS:
            return None, "Too many active streams. Stop one first."

    src_url = f"http://{device_ip}:5004/auto/v{channel}"
    out_dir = tempfile.mkdtemp(prefix="hdhr_hls_")
    err_path = os.path.join(out_dir, "ffmpeg.log")
    err_file = open(err_path, "wb")
    try:
        proc = subprocess.Popen(
            build_ffmpeg_cmd(src_url, out_dir, quality),
            stdout=subprocess.DEVNULL, stderr=err_file,
        )
    except FileNotFoundError:
        err_file.close()
        shutil.rmtree(out_dir, ignore_errors=True)
        return None, "ffmpeg not found on PATH. Install ffmpeg to enable streaming."

    session_id = uuid.uuid4().hex[:12]
    with sessions_lock:
        sessions[session_id] = {
            "proc": proc, "dir": out_dir, "err_file": err_file,
            "last_access": time.time(),
            "device": device_ip, "channel": channel, "quality": quality,
        }

    # Wait for the first playable playlist (needs at least one full segment).
    playlist = os.path.join(out_dir, "index.m3u8")
    deadline = time.time() + STARTUP_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            err_file.close()
            tail = ""
            try:
                with open(err_path, "r", errors="replace") as f:
                    tail = f.read()[-800:].strip()
            except OSError:
                pass
            stop_session(session_id)
            if tail:
                print(f"[stream {device_ip} ch{channel}] ffmpeg failed:\n{tail}", file=sys.stderr)
            # Ask the tuner itself for the precise reason (no signal, tuners
            # busy, unknown channel, ...) rather than guessing from ffmpeg.
            reason = diagnose_stream_url(src_url)
            if reason:
                return None, reason
            return None, "Stream failed to start. " + (tail.splitlines()[-1] if tail else "")
        try:
            if os.path.getsize(playlist) > 0 and b"seg" in open(playlist, "rb").read():
                with sessions_lock:
                    if session_id in sessions:
                        sessions[session_id]["last_access"] = time.time()
                return session_id, None
        except OSError:
            pass
        time.sleep(0.25)

    stop_session(session_id)
    return None, "Timed out waiting for the stream to start."


def reaper_loop():
    while True:
        time.sleep(5)
        now = time.time()
        with sessions_lock:
            stale = [sid for sid, s in sessions.items()
                     if now - s["last_access"] > SESSION_IDLE_SECONDS
                     or (s["proc"].poll() is not None and now - s["last_access"] > 10)]
        for sid in stale:
            stop_session(sid)

# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HDHRViewer/1.0"

    def log_message(self, fmt, *args):
        # Keep the console quiet for segment polling; log everything else.
        if "/hls/" not in (args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- helpers ------------------------------------------------------------

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file_bytes(self, data, content_type, cache=False):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 65536:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # -- routes -------------------------------------------------------------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if len(path) > 1:
            path = path.rstrip("/")  # /api/version/ should match /api/version
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/" or path == "/index.html":
                self.serve_static("index.html")
            elif path.startswith("/static/"):
                self.serve_static(path[len("/static/"):])
            elif path == "/api/discover":
                self.api_discover(query)
            elif path == "/api/lineup":
                self.api_lineup(query)
            elif path == "/api/guide":
                self.api_guide(query)
            elif path == "/api/device/status":
                self.api_device_proxy(query, "/status.json")
            elif path == "/api/version":
                self.send_json(version_info())
            elif path == "/api/stats":
                ip = query.get("device", [None])[0]
                if ip and not valid_ip(ip):
                    return self.send_json({"error": "Invalid device parameter."}, 400)
                self.send_json(collect_stats(ip))
            elif path == "/api/signal/status":
                ip = query.get("device", [None])[0]
                if not ip or not valid_ip(ip):
                    return self.send_json({"error": "Missing or invalid device parameter."}, 400)
                self.send_json(get_signal_status(ip))
            elif path == "/api/device/scan_status":
                self.api_device_proxy(query, "/lineup_status.json")
            elif path.startswith("/hls/"):
                self.serve_hls(path)
            else:
                self.send_json({"error": "Not found"}, 404)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as exc:  # keep the thread alive, report the error
            try:
                self.send_json({"error": str(exc)}, 500)
            except Exception:
                pass

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if len(path) > 1:
            path = path.rstrip("/")
        try:
            if path == "/api/stream/start":
                body = self.read_json_body()
                sid, err = start_session(
                    str(body.get("device", "")),
                    str(body.get("channel", "")),
                    str(body.get("quality", "720")),
                )
                if err:
                    self.send_json({"error": err}, 502)
                else:
                    self.send_json({"id": sid, "playlist": f"/hls/{sid}/index.m3u8"})
            elif path == "/api/stream/stop":
                body = self.read_json_body()
                stop_session(str(body.get("id", "")))
                self.send_json({"ok": True})
            elif path == "/api/device/scan":
                self.api_device_scan()
            elif path == "/api/signal/scan":
                body = self.read_json_body()
                ip = str(body.get("device", ""))
                if not valid_ip(ip):
                    return self.send_json({"error": "Invalid device address."}, 400)
                err = start_signal_scan(ip)
                if err:
                    self.send_json({"error": err}, 409)
                else:
                    self.send_json({"ok": True})
            else:
                self.send_json({"error": "Not found"}, 404)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as exc:
            try:
                self.send_json({"error": str(exc)}, 500)
            except Exception:
                pass

    # -- route implementations ----------------------------------------------

    def api_discover(self, query):
        manual = query.get("ip", [None])[0]
        if manual:
            if not valid_ip(manual):
                return self.send_json({"error": "Invalid IP address."}, 400)
            ips = [manual]
        else:
            # UDP broadcast finds same-subnet devices; the SiliconDust cloud
            # API covers devices on other subnets; saved IPs cover everything
            # the user has manually added before.
            ips = discover_device_ips()
            seen = set(ips)
            for ip in discover_cloud() + load_saved_ips():
                if ip not in seen:
                    seen.add(ip)
                    ips.append(ip)
        devices, errors = [], []
        for ip in ips:
            try:
                devices.append(fetch_device_info(ip))
                save_ip(ip)  # remember every reachable tuner (stats, restarts)
            except Exception as exc:
                errors.append({"ip": ip, "error": str(exc)})
        self.send_json({"devices": devices, "errors": errors})

    def api_lineup(self, query):
        ip = query.get("device", [None])[0]
        if not ip or not valid_ip(ip):
            return self.send_json({"error": "Missing or invalid device parameter."}, 400)
        lineup = http_get_json(f"http://{ip}/lineup.json")
        self.send_json({"lineup": lineup})

    def api_guide(self, query):
        ip = query.get("device", [None])[0]
        if not ip or not valid_ip(ip):
            return self.send_json({"error": "Missing or invalid device parameter."}, 400)
        start = None
        raw_start = query.get("start", [None])[0]
        if raw_start:
            try:
                start = int(raw_start)
            except ValueError:
                return self.send_json({"error": "Invalid start time."}, 400)
        channel = query.get("channel", [None])[0]
        if channel and not CHANNEL_RE.match(channel):
            return self.send_json({"error": "Invalid channel."}, 400)
        try:
            self.send_json({"guide": fetch_guide(ip, start, channel)})
        except Exception:
            self.send_json({"guide": []})  # no internet / no auth: degrade quietly

    def api_device_proxy(self, query, device_path):
        ip = query.get("device", [None])[0]
        if not ip or not valid_ip(ip):
            return self.send_json({"error": "Missing or invalid device parameter."}, 400)
        self.send_json({"data": http_get_json(f"http://{ip}{device_path}")})

    def api_device_scan(self):
        body = self.read_json_body()
        ip = str(body.get("device", ""))
        action = str(body.get("action", "start"))
        source = str(body.get("source", "Antenna"))
        if not valid_ip(ip):
            return self.send_json({"error": "Invalid device address."}, 400)
        if action not in ("start", "abort"):
            return self.send_json({"error": "Invalid action."}, 400)
        if not SOURCE_RE.match(source):
            return self.send_json({"error": "Invalid source."}, 400)
        if action == "start":
            path = "/lineup.json?scan=start&source=" + urllib.parse.quote(source)
        else:
            path = "/lineup.json?scan=abort"
        try:
            device_post(ip, path)
            self.send_json({"ok": True})
        except urllib.error.HTTPError as e:
            self.send_json({"error": f"The device refused the request (HTTP {e.code})."}, 502)

    def serve_hls(self, path):
        # /hls/<session_id>/<file>
        parts = path.split("/")
        if len(parts) != 4:
            return self.send_json({"error": "Not found"}, 404)
        _, _, sid, name = parts
        name = os.path.basename(name)
        if not re.match(r"^[A-Za-z0-9_.-]+\.(m3u8|ts)$", name):
            return self.send_json({"error": "Not found"}, 404)
        with sessions_lock:
            sess = sessions.get(sid)
            if sess:
                sess["last_access"] = time.time()
        if not sess:
            return self.send_json({"error": "Stream not active"}, 404)
        file_path = os.path.join(sess["dir"], name)
        try:
            with open(file_path, "rb") as f:
                data = f.read()
        except OSError:
            return self.send_json({"error": "Not found"}, 404)
        ctype = "application/vnd.apple.mpegurl" if name.endswith(".m3u8") else "video/mp2t"
        self.send_file_bytes(data, ctype)

    def serve_static(self, rel):
        rel = os.path.normpath(rel).replace("\\", "/")
        if rel.startswith("..") or os.path.isabs(rel):
            return self.send_json({"error": "Not found"}, 404)
        file_path = os.path.join(STATIC_DIR, rel)
        if not os.path.isfile(file_path):
            return self.send_json({"error": "Not found"}, 404)
        ctype = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        # Only the versioned hls.js library is safe to cache long-term; the app's
        # own js/css must always be revalidated or updates break button handlers.
        with open(file_path, "rb") as f:
            self.send_file_bytes(f.read(), ctype, cache=rel.endswith("hls.min.js"))


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Clients dropping keep-alive connections is normal; don't spam tracebacks.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    os.makedirs(DATA_DIR, exist_ok=True)
    # docker stop sends SIGTERM; convert it to a clean shutdown so ffmpeg
    # processes die and the HDHomeRun's tuners are released.
    import signal

    def handle_term(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, handle_term)
    threading.Thread(target=reaper_loop, daemon=True).start()
    server = QuietServer(("0.0.0.0", port), Handler)
    try:
        host = socket.gethostbyname(socket.gethostname())
    except OSError:
        host = "<this-machine>"
    print("HDHomeRun Web Viewer running:", flush=True)
    print(f"  Local:   http://localhost:{port}", flush=True)
    print(f"  Network: http://{host}:{port}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_all_sessions()


if __name__ == "__main__":
    main()
