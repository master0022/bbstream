#!/usr/bin/env python3
"""Tiny UDP "who is streaming, and where" registry.

Protocol (one datagram per message, ASCII):
  L <userId> <channelId> <streamKey> [<serverHost>]
                                       heartbeat: I'm live in <channelId>. Reply "ok".
  S <userId>                           I stopped. Reply "ok".
  Q                                    Reply JSON {userId: [channelId, streamKey, serverHost], ...}
  K                                    Reply JSON {username: [serverUrl, streamKey, isLive], ...}
  R <username> <serverUrl> <streamKey> First run of the plugin: claim a stream for <username>.
                                       Reply "ok", or "taken" if they already have one.

Entries expire EXPIRY seconds after their last heartbeat.
Links come from LINKS_FILE (managed with bbstream-link.py) plus REGISTERED_FILE (claimed with R);
LINKS_FILE wins. While any client
has asked for them in the last ACTIVE_FOR seconds, each link is checked every CHECK_EVERY seconds:
open a WHEP session and read the first "status" event from its SSE feed (isOnline).
"""
import http.client
import json
import os
import re
import socket
import threading
import time
from urllib.parse import urlsplit

PORT = int(os.environ.get("PRESENCE_PORT", "8200"))
LINKS_FILE = os.environ.get("LINKS_FILE", "/opt/bbstream/links.json")
REGISTERED_FILE = os.environ.get("REGISTERED_FILE", "/var/lib/bbstream/registered.json")
MAX_REGISTERED = 200
EXPIRY = 10.0
MAX_ENTRIES = 64
TOKEN = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
HOST = re.compile(r"^[a-z0-9.\-]{1,64}(:[0-9]{1,5})?$")
USERNAME = re.compile(r"^[a-z0-9_.]{2,32}$")

CHECK_EVERY = 10.0
ACTIVE_FOR = 60.0

live = {}  # userId -> (channelId, streamKey, serverHost, lastSeen)
file_cache = {}  # path -> (mtime, parsed json)
online = {}  # (server, streamKey) -> bool, written by the checker thread
last_asked = 0.0

# Receive-only offer; the session never connects, it only exists to get the SSE status feed.
# It must list the codecs a real viewer would (audio + H264 + AV1): an H264-only session stops
# Broadcast Box from forwarding an AV1 stream to everyone. The server drops it after ~30s.
_M = ["a=ice-ufrag:bbpr", "a=ice-pwd:bbprobebbprobebbprobe12", "a=fingerprint:sha-256 " + ":".join(["7B"] * 32),
      "a=setup:actpass", "a=recvonly", "a=rtcp-mux", "c=IN IP4 0.0.0.0"]
OFFER = "\r\n".join([
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", *_M, "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 45", "a=mid:1", *_M, "a=rtpmap:96 H264/90000",
    "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", "a=rtpmap:45 AV1/90000", "",
])
SSE_REL = re.compile(r'<([^>]+)>\s*;\s*rel="urn:ietf:params:whep:ext:core:server-sent-events"')


def load_json(path):
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return {}
    cached = file_cache.get(path)
    if not cached or cached[0] != mtime:
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        cached = file_cache[path] = (mtime, data if isinstance(data, dict) else {})
    return cached[1]


def load_links():
    return {**load_json(REGISTERED_FILE), **load_json(LINKS_FILE)}


def register(username, server, key):
    if username in load_links():
        return "taken"
    registered = dict(load_json(REGISTERED_FILE))
    if len(registered) >= MAX_REGISTERED:
        return "full"
    registered[username] = [server, key]
    tmp = REGISTERED_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(registered, f, indent=1)
    os.replace(tmp, REGISTERED_FILE)
    return "ok"


def links_json():
    global last_asked
    last_asked = time.monotonic()
    return json.dumps({who: [server, key, online.get((server, key), False)] for who, (server, key) in load_links().items()},
                      separators=(",", ":"))


def request(url, method, body=None, headers=None):
    parts = urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=6)
    conn.request(method, parts.path or "/", body=body, headers={"User-Agent": "bbstream-presence", **(headers or {})})
    return conn, conn.getresponse()


def is_online(server, key):
    conn, res = request(server + "/api/whep", "POST", OFFER, {"Content-Type": "application/sdp", "Authorization": "Bearer " + key})
    res.read()
    conn.close()
    sse = SSE_REL.search(res.getheader("Link") or "")
    if res.status != 201 or not sse:
        return False
    url = sse.group(1) if "://" in sse.group(1) else server + sse.group(1)
    conn, res = request(url, "GET", headers={"Accept": "text/event-stream"})
    try:
        event = ""
        for _ in range(20):
            line = res.fp.readline(4096).decode("utf-8", "replace").strip()
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:") and event == "status":
                return bool(json.loads(line[5:]).get("isOnline"))
        return False
    finally:
        conn.close()


def checker():
    while True:
        started = time.monotonic()
        if started - last_asked < ACTIVE_FOR:
            targets = {(server, key) for server, key in load_links().values()}
            for target in targets:
                try:
                    online[target] = is_online(*target)
                except (OSError, ValueError, http.client.HTTPException):
                    online[target] = False
            for gone in set(online) - targets:
                del online[gone]
        time.sleep(max(1.0, CHECK_EVERY - (time.monotonic() - started)))


def prune(now):
    for uid in [u for u, (*_, seen) in live.items() if now - seen > EXPIRY]:
        del live[uid]


def handle(msg, now):
    parts = msg.split()
    if not parts:
        return None
    cmd = parts[0]
    if cmd == "Q" and len(parts) == 1:
        prune(now)
        return json.dumps({u: [c, k, h] for u, (c, k, h, _) in live.items()}, separators=(",", ":"))
    if cmd == "K" and len(parts) == 1:
        return links_json()
    if cmd == "L" and len(parts) in (4, 5) and all(TOKEN.match(p) for p in parts[1:4]):
        host = parts[4] if len(parts) == 5 else ""
        if host and not HOST.match(host):
            return None
        if parts[1] in live or len(live) < MAX_ENTRIES:
            live[parts[1]] = (parts[2], parts[3], host, now)
            return "ok"
        return "full"
    if cmd == "R" and len(parts) == 4 and USERNAME.match(parts[1]) and TOKEN.match(parts[3]):
        server = parts[2].rstrip("/")
        if not server.startswith("https://") or not HOST.match(server[8:]):
            return None
        try:
            return register(parts[1], server, parts[3])
        except OSError:
            return "error"
    if cmd == "S" and len(parts) == 2:
        live.pop(parts[1], None)
        return "ok"
    return None


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", PORT))
    threading.Thread(target=checker, daemon=True).start()
    while True:
        data, addr = sock.recvfrom(512)
        try:
            reply = handle(data.decode("ascii"), time.monotonic())
        except UnicodeDecodeError:
            reply = None
        if reply is not None:
            sock.sendto(reply.encode(), addr)


if __name__ == "__main__":
    main()
