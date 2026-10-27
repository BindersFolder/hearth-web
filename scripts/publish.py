#!/usr/bin/env python3
"""Publish the Hearth feed for the static site.

Fetches highlights.json from the private hearth-feed repo, then writes:
  data/feed.json     everything except `highlights` (public)
  data/private.json  `highlights` encrypted with AES-256-GCM, key from
                     PBKDF2-SHA256 (200,000 iterations) over HEARTH_PASSPHRASE,
                     or {"disabled": true} when no passphrase is set.

The browser decrypts with WebCrypto using the same parameters. The GCM tag is
appended to the ciphertext (what both `cryptography` and WebCrypto produce/expect).

The salt is random when first created and then kept as long as the passphrase
is unchanged, so a key the browser remembered keeps working. A fresh random IV
is used whenever the plaintext changes; identical plaintext keeps the existing
file so the hourly run does not create empty commits.

Any fetch or parse failure exits 0 without touching data/, so the last good
copy stays published.

Env: FEED_TOKEN (required), HEARTH_PASSPHRASE (optional), FEED_URL (optional).
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
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FEED_PATH = os.path.join(DATA, "feed.json")
PRIVATE_PATH = os.path.join(DATA, "private.json")


def log(msg):
    print(f"publish: {msg}", file=sys.stderr)


def b64e(b):
    return base64.b64encode(b).decode("ascii")


def b64d(s):
    return base64.b64decode(s, validate=True)


def derive_key(passphrase, salt):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    return kdf.derive(passphrase.encode("utf-8"))


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
    if not any(k in data for k in ("updatedAt", "ticker", "weather", "news", "highlights")):
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


def build_private(highlights, passphrase, updated_at):
    if not passphrase:
        return {"disabled": True}
    plaintext = json.dumps(highlights, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    # Reuse the existing salt (and, if the plaintext is identical, the existing
    # IV/ciphertext) only when the existing file decrypts with this passphrase.
    prev = read_json(PRIVATE_PATH)
    if isinstance(prev, dict) and all(k in prev for k in ("salt", "iv", "ciphertext")):
        try:
            salt, iv, ct = b64d(prev["salt"]), b64d(prev["iv"]), b64d(prev["ciphertext"])
            if len(salt) == 16 and len(iv) == 12:
                key = derive_key(passphrase, salt)
                old = AESGCM(key).decrypt(iv, ct, None)
                if old == plaintext:
                    return {"salt": prev["salt"], "iv": prev["iv"], "ciphertext": prev["ciphertext"],
                            "updatedAt": updated_at}
                iv = os.urandom(12)
                return {"salt": prev["salt"], "iv": b64e(iv),
                        "ciphertext": b64e(AESGCM(key).encrypt(iv, plaintext, None)),
                        "updatedAt": updated_at}
        except (InvalidTag, ValueError, TypeError):
            log("existing private.json does not match this passphrase; new salt")

    salt, iv = os.urandom(16), os.urandom(12)
    key = derive_key(passphrase, salt)
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

    highlights = feed.get("highlights")
    if not isinstance(highlights, list):
        highlights = []
    public = {k: v for k, v in feed.items() if k != "highlights"}
    passphrase = os.environ.get("HEARTH_PASSPHRASE", "")

    os.makedirs(DATA, exist_ok=True)
    private = build_private(highlights, passphrase, public.get("updatedAt"))
    changed_feed = write_json(FEED_PATH, public)
    changed_priv = write_json(PRIVATE_PATH, private)
    log(f"feed.json {'updated' if changed_feed else 'unchanged'}, "
        f"private.json {'updated' if changed_priv else 'unchanged'} "
        f"({'encrypted' if passphrase else 'disabled'}, {len(highlights)} highlights)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
