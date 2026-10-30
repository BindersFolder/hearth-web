#!/usr/bin/env python3
"""Publish the Hearth feed for the static site, in three privacy tiers.

Fetches highlights.json from the private hearth-feed repo, then writes:
  data/feed.json     public: only the PUBLIC_FIELDS (an allowlist, so a new
                     personal field can't leak), with `highlights` filtered to
                     the public kinds (weather, news)
  data/friends.json  {"media": ...} encrypted with FRIENDS_KEY
  data/private.json  {"highlights": [every non-public item], "media": ...,
                      "packages": ...}
                     encrypted with HEARTH_PASSPHRASE (the passphrase sees
                     everything the friends link does)

Encryption (both blobs): AES-256-GCM, key = PBKDF2-SHA256(secret, salt,
200,000 iterations, 32 bytes), random 16-byte salt, random 12-byte IV. The GCM
tag is appended to the ciphertext, which is what WebCrypto expects. A blob is
{"salt", "iv", "ciphertext", "updatedAt"} (base64), or {"disabled": true} when
its secret is unset.

The salt of each file is random when first created and kept while its secret is
unchanged, so keys a browser remembered keep working. A fresh IV is used
whenever the plaintext changes; identical plaintext keeps the existing file so
hourly runs do not create empty commits.

Any fetch or parse failure exits 0 without touching data/, so the last good
copy stays published.

Env: FEED_TOKEN (required), HEARTH_PASSPHRASE, FRIENDS_KEY, FEED_URL (optional).
"""
import base64
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

FEED_URL = os.environ.get(
    "FEED_URL",
    "https://api.github.com/repos/BindersFolder/hearth-feed/contents/highlights.json",
)
ITERATIONS = 200_000
PUBLIC_KINDS = {"weather", "news"}  # highlight kinds safe to publish in plaintext
PUBLIC_FIELDS = ("updatedAt", "ticker", "weather", "news", "highlights")  # all else stays encrypted
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FEED_PATH = os.path.join(DATA, "feed.json")
FRIENDS_PATH = os.path.join(DATA, "friends.json")
PRIVATE_PATH = os.path.join(DATA, "private.json")


def log(msg):
    print(f"publish: {msg}", file=sys.stderr)


def b64e(b):
    return base64.b64encode(b).decode("ascii")


def b64d(s):
    return base64.b64decode(s, validate=True)


def derive_key(secret, salt):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    return kdf.derive(secret.encode("utf-8"))


def fetch_feed(token):
    req = urllib.request.Request(
        FEED_URL,
        headers={
            "Accept": "application/vnd.github.raw+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hearth-web-publish",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("feed is not a JSON object")
    if not any(k in data for k in ("updatedAt", "ticker", "weather", "news", "highlights", "media")):
        raise ValueError("feed has none of the expected sections")
    return data


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, obj):
    """Atomic write; skips the write when content is unchanged."""
    text = json.dumps(obj, ensure_ascii=False, indent=1) + "\n"
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    except OSError:
        pass
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return True


def is_public(item):
    return isinstance(item, dict) and str(item.get("kind", "")).strip().lower() in PUBLIC_KINDS


def build_blob(path, payload, secret, updated_at):
    """Encrypt payload for `path`, reusing that file's salt (and ciphertext if unchanged)."""
    if not secret:
        return {"disabled": True}
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    prev = read_json(path)
    if isinstance(prev, dict) and all(k in prev for k in ("salt", "iv", "ciphertext")):
        try:
            salt, iv, ct = b64d(prev["salt"]), b64d(prev["iv"]), b64d(prev["ciphertext"])
            if len(salt) == 16 and len(iv) == 12:
                key = derive_key(secret, salt)
                old = AESGCM(key).decrypt(iv, ct, None)  # proves the secret is unchanged
                if old == plaintext:
                    return {"salt": prev["salt"], "iv": prev["iv"], "ciphertext": prev["ciphertext"],
                            "updatedAt": updated_at}
                iv = os.urandom(12)
                return {"salt": prev["salt"], "iv": b64e(iv),
                        "ciphertext": b64e(AESGCM(key).encrypt(iv, plaintext, None)),
                        "updatedAt": updated_at}
        except (InvalidTag, ValueError, TypeError):
            log(f"existing {os.path.basename(path)} does not match its secret; new salt")

    salt, iv = os.urandom(16), os.urandom(12)
    key = derive_key(secret, salt)
    return {"salt": b64e(salt), "iv": b64e(iv),
            "ciphertext": b64e(AESGCM(key).encrypt(iv, plaintext, None)),
            "updatedAt": updated_at}


def main():
    token = os.environ.get("FEED_TOKEN", "").strip()
    if not token:
        log("FEED_TOKEN is not set; leaving data/ unchanged")
        return 0
    try:
        feed = fetch_feed(token)
    except (urllib.error.URLError, OSError, ValueError) as e:
        # HTTPError is a URLError; message never includes the token.
        log(f"fetch failed ({type(e).__name__}: {e}); leaving data/ unchanged")
        return 0

    highlights = feed.get("highlights") if isinstance(feed.get("highlights"), list) else []
    public_items = [h for h in highlights if is_public(h)]
    personal_items = [h for h in highlights if not is_public(h)]
    media = feed.get("media") if isinstance(feed.get("media"), dict) else None

    packages = feed.get("packages") if isinstance(feed.get("packages"), dict) else None

    public = {k: v for k, v in feed.items() if k in PUBLIC_FIELDS and k != "highlights"}
    if "highlights" in feed:
        public["highlights"] = public_items
    updated_at = public.get("updatedAt")

    friends_key = os.environ.get("FRIENDS_KEY", "")
    passphrase = os.environ.get("HEARTH_PASSPHRASE", "")
    os.makedirs(DATA, exist_ok=True)
    friends = build_blob(FRIENDS_PATH, {"media": media}, friends_key, updated_at)
    private = build_blob(PRIVATE_PATH, {"highlights": personal_items, "media": media, "packages": packages}, passphrase, updated_at)

    changed = [name for name, path, obj in (("feed.json", FEED_PATH, public),
                                             ("friends.json", FRIENDS_PATH, friends),
                                             ("private.json", PRIVATE_PATH, private))
               if write_json(path, obj)]
    log(f"updated: {', '.join(changed) or 'nothing'}; "
        f"{len(public_items)} public + {len(personal_items)} personal highlights, "
        f"media {'yes' if media else 'no'}, "
        f"packages {len(packages.get('items') or []) if packages else 'none'}; "
        f"friends {'encrypted' if friends_key else 'disabled'}, "
        f"private {'encrypted' if passphrase else 'disabled'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
