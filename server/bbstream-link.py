#!/usr/bin/env python3
"""Link Discord users to an external Broadcast Box(-compatible) stream.

  bbstream-link add <discordUsername> <playerUrl>            e.g. https://their.site/mykey
  bbstream-link add <discordUsername> <serverUrl> <streamKey>
  bbstream-link remove <discordUsername>
  bbstream-link list

Plugin users claim a stream on first run; those live in REGISTERED_FILE and show up here too
(an `add` for the same username overrides it). The presence server checks linked streams while plugin users are around; plugin users see a
LIVE badge on linked people in voice channels while their stream is actually online.
"""
import json
import os
import re
import sys
from urllib.parse import unquote, urlsplit

LINKS_FILE = os.environ.get("LINKS_FILE", "/opt/bbstream/links.json")
REGISTERED_FILE = os.environ.get("REGISTERED_FILE", "/var/lib/bbstream/registered.json")
KEY = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
USERNAME = re.compile(r"^[a-z0-9_.]{2,32}$")


def load(path=LINKS_FILE):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(links, path=LINKS_FILE):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(links, f, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def main(argv):
    links = load()
    registered = load(REGISTERED_FILE)
    if argv[:1] == ["list"]:
        for uid, (server, key) in links.items():
            print(f"{uid}  {server}  {key}")
        for uid, (server, key) in registered.items():
            if uid not in links:
                print(f"{uid}  {server}  {key}  (registered by the plugin)")
        return
    if len(argv) == 2 and argv[0] == "remove":
        uid = argv[1].lower()
        if uid not in links and uid not in registered:
            die("not linked")
        if links.pop(uid, None) is not None:
            save(links)
        if registered.pop(uid, None) is not None:
            save(registered, REGISTERED_FILE)
        return
    if argv[:1] == ["add"] and len(argv) in (3, 4):
        uid = argv[1].lower()
        if not USERNAME.match(uid):
            die("expected a Discord username (the unique one, not the display name)")
        if len(argv) == 4:
            server, key = argv[2], argv[3]
        else:
            parts = urlsplit(argv[2])
            key = unquote(parts.path.rstrip("/").rsplit("/", 1)[-1])
            server = f"{parts.scheme}://{parts.netloc}"
        server = server.rstrip("/")
        if not re.match(r"^https?://[^/\s]+$", server):
            die(f"bad server url: {server}")
        if not KEY.match(key):
            die(f"bad stream key: {key!r}")
        links[uid] = [server, key]
        save(links)
        print(f"linked {uid} -> {server} key={key}")
        return
    die(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
