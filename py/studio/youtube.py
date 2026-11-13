"""
FILE: py/studio/youtube.py
PURPOSE: Connect the Tsumagoi YouTube channel once, then upload or schedule a reel's Short.
OVERVIEW: OAuth for an installed app (PKCE, loopback redirect to the studio), a stored
          refresh token, a resumable upload of the reel's youtube-shorts file with its
          approved title and description, and a read of what is on the channel.
          Every upload is written to the `posts` table, so one reel is never sent twice
          by accident and the home page can show what went out. Bilingual playlists
          (PLAYLISTS) are created on demand; public and scheduled videos are sorted into
          them by reel theme or title words, and a new upload joins its playlists.
DEPENDENCIES: Python stdlib (urllib, ctypes on Windows), certifi, studio.config, studio.posting, studio.reels
USAGE: python -m studio youtube status | auth-url | exchange --code C --state S |
       upload SLUG [--at 2026-11-08T19:00] [--privacy private|unlisted|public] [--force] | list |
       playlists | sort [--dry-run]
       server/review.mjs calls these for the Post panel.
TECHNICAL DETAILS: Google OAuth 2.0 for installed apps (code + PKCE S256, redirect
       http://127.0.0.1:4317/oauth/youtube). Scopes: youtube.upload, youtube.readonly.
       Upload: POST upload/youtube/v3/videos?uploadType=resumable, then PUT in 8 MB chunks.
       Scheduling: status.privacyStatus=private + status.publishAt (RFC 3339).
NOTES: The client id/secret come from STUDIO_YT_CLIENT_ID / STUDIO_YT_CLIENT_SECRET in the
       gitignored .env, or <data>/secrets/youtube_client.json (Google's download).
       The refresh token lives in <data>/secrets/youtube_token.bin: DPAPI-encrypted for this Windows user, or a marker pointing into the macOS Keychain / Linux Secret Service (owner-only file as last resort); encrypted for this
       Windows user (DPAPI); it is never printed. In Google's "Testing" mode the token
       lasts 7 days; publish the consent screen to make it last.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from studio.config import DATA, ROOT
from studio.posting import posts, record

REDIRECT = "http://127.0.0.1:4317/oauth/youtube"  # the default; a Desktop client accepts any loopback port (redirect_uri())
# yt-analytics.readonly: watch time, % viewed, shares and subscribers per Short for studio.perf (a token from
# before it was added keeps working; press Connect YouTube again to allow it).
# openid + email: only to show which Google account is connected (the email in the id_token), nothing else.
SCOPES = ("openid email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube"
          " https://www.googleapis.com/auth/yt-analytics.readonly")


def redirect_uri(port: int | str | None = None) -> str:
    """Google's native-app flow: a Desktop client may return to 127.0.0.1 on any port, so the studio uses its own."""
    p = str(port or 4317)
    if not p.isdigit():
        raise ValueError("port must be a number")
    return f"http://127.0.0.1:{p}/oauth/youtube"
MANAGE = "https://www.googleapis.com/auth/youtube"  # playlists need it; upload and read do not

# Bilingual playlists. A studio reel goes by its theme; any other video by words in its title.
PLAYLISTS = [
    {"key": "aerial", "title": "空撮 | Aerial views", "themes": ["aerial"], "words": ["from the air", "空撮", "drone", "ドローン"],
     "description": "標高1,444mの嬬恋牧場Work&Campを空から。\nTsumagoi Work&Camp at 1,444 m, from the air."},
    {"key": "autumn", "title": "紅葉と秋 | Autumn", "themes": ["autumn"], "words": ["autumn", "秋", "紅葉", "maple"],
     "description": "嬬恋高原の秋と紅葉。\nAutumn colours around Tsumagoi Work&Camp."},
    {"key": "winter", "title": "雪と冬 | Winter", "themes": ["warm", "winter"], "words": ["snow", "winter", "雪", "冬"],
     "description": "雪の嬬恋牧場、冬のキャンプと車中泊。\nSnow and winter at Tsumagoi Work&Camp."},
    {"key": "spring", "title": "春と夏 | Spring and summer", "themes": [], "words": ["spring", "summer", "春", "夏"],
     "description": "嬬恋高原の春と夏。\nSpring and summer on the Tsumagoi highland."},
    {"key": "fire", "title": "焚き火とごはん | Fire and food", "themes": ["fire"], "words": ["fire", "bbq", "lunch", "pizza", "焚き火", "お昼", "ピザ", "ごはん"],
     "description": "共用キッチンとデッキの焚き火台。\nThe shared kitchen and the fire on the deck."},
    {"key": "work", "title": "山で働く | Work in the mountains", "themes": ["office", "focus", "connect"], "words": ["desk", "lounge", "laptop", "office", "デスク", "こたつ", "ワーケーション"],
     "description": "標高1,444m、100Mbpsの光回線で働く。\nWork at 1,444 m on 100 Mbps fibre."},
    {"key": "field", "title": "フィールドと車中泊 | Field and car stay", "themes": ["field", "carstay", "loud", "lookup", "view"], "words": ["tent", "field", "car", "kite", "テント", "車中泊", "凧", "フィールド"],
     "description": "区画のない草原、テント、車中泊。\nOne open field, tents and car stays."},
]
AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/youtube/v3"
UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos"
SECRETS = DATA / "secrets"
CHUNK = 8 * 1024 * 1024  # a multiple of 256 KiB, as the resumable protocol asks
TRAVEL = "19"  # YouTube category: Travel & Events


# ---------- secrets: DPAPI on Windows, the Keychain on macOS, the Secret Service on Linux ----------
# On macOS and Linux the .bin file holds only a marker ("vault:<name>"); the token itself is in the
# operating system's store. Without one (a bare Linux server), the file is kept owner-only (0600).

VAULT = "lazycow-studio"
MARK = b"vault:"


def _have(tool: str) -> bool:
    import shutil

    return shutil.which(tool) is not None


def _vault_put(name: str, data: bytes) -> bool:
    import base64
    import subprocess

    secret = base64.b64encode(data).decode("ascii")
    if sys.platform == "darwin" and _have("security"):
        r = subprocess.run(["security", "add-generic-password", "-U", "-a", name, "-s", f"{VAULT}:{name}", "-w", secret], capture_output=True)
        return r.returncode == 0
    if sys.platform.startswith("linux") and _have("secret-tool"):
        r = subprocess.run(["secret-tool", "store", "--label", f"Lazycow Studio {name}", "service", VAULT, "key", name], input=secret.encode(), capture_output=True)
        return r.returncode == 0
    return False


def _vault_get(name: str) -> bytes:
    import base64
    import subprocess

    if sys.platform == "darwin":
        r = subprocess.run(["security", "find-generic-password", "-a", name, "-s", f"{VAULT}:{name}", "-w"], capture_output=True)
    else:
        r = subprocess.run(["secret-tool", "lookup", "service", VAULT, "key", name], capture_output=True)
    if r.returncode != 0 or not r.stdout.strip():
        raise OSError(f"the stored {name} is missing from this computer's key store; connect again")
    return base64.b64decode(r.stdout.strip())


def _write_secret(path: Path, data: bytes) -> None:
    """Owner-only on macOS and Linux (0700 folder, 0600 file); Windows keeps its own ACLs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        os.chmod(path.parent, 0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(path, 0o600)
    else:
        path.write_bytes(data)


def _protect(data: bytes, name: str = "youtube_token") -> bytes:
    if sys.platform != "win32":
        return MARK + name.encode() if _vault_put(name, data) else data
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    src = Blob(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)))
    out = Blob()
    if not ctypes.windll.crypt32.CryptProtectData(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("could not encrypt the YouTube token for this Windows user")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def _unprotect(data: bytes) -> bytes:
    if sys.platform != "win32":
        return _vault_get(data[len(MARK):].decode()) if data.startswith(MARK) else data
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    src = Blob(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)))
    out = Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("the stored YouTube token belongs to another Windows user; connect again")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


ACCOUNT = "main"  # which of this project's YouTube accounts the calls act as (use()); "main" is the one Shorts post to
ACCOUNT_RX = re.compile(r"main|a[0-9]{1,3}")


def use(account: str | None) -> None:
    """Act as one of this project's YouTube accounts: "main" (the channel Shorts post to) or a2, a3, ... (more channels
    connected with "Connect another account": a personal channel for long videos, a second brand)."""
    global ACCOUNT
    acct = account or "main"
    if not ACCOUNT_RX.fullmatch(acct):
        raise RuntimeError("account: main, or a2, a3, ... (python -m studio youtube accounts)")
    ACCOUNT = acct


def _token_path() -> Path:
    return SECRETS / ("youtube_token.bin" if ACCOUNT == "main" else f"youtube_token-{ACCOUNT}.bin")


def _token_files() -> list[tuple[str, Path]]:
    extra = [(p.stem.split("-", 1)[1], p) for p in SECRETS.glob("youtube_token-a*.bin") if ACCOUNT_RX.fullmatch(p.stem.split("-", 1)[1])]
    return [("main", SECRETS / "youtube_token.bin"), *sorted(extra, key=lambda x: int(x[0][1:]))]


def accounts() -> list[dict]:
    """Every YouTube account connected in this project, main first: id, Google account, channel."""
    global ACCOUNT
    keep, out = ACCOUNT, []
    try:
        for acct, f in _token_files():
            if not f.exists():
                continue
            ACCOUNT = acct
            try:
                tok = _load_token() or {}
            except (OSError, ValueError) as err:
                out.append({"id": acct, "error": str(err)[:200]})
                continue
            ch = tok.get("channel") or {}
            out.append({"id": acct, "email": tok.get("account"), "channel": ch.get("title"), "handle": ch.get("handle"),
                        "channelId": ch.get("id"), "since": tok.get("since"), "shorts": acct == "main"})
    finally:
        ACCOUNT = keep
    return out


def _next_account() -> str:
    """The id a newly connected account gets: main when the project has none yet, else a2, a3, ..."""
    have = {a for a, f in _token_files() if f.exists()}
    if "main" not in have:
        return "main"
    k = 2
    while f"a{k}" in have:
        k += 1
    return f"a{k}"


def _load_token() -> dict | None:
    p = _token_path()
    if not p.exists():
        return None
    return json.loads(_unprotect(p.read_bytes()).decode("utf-8"))


def _save_token(tok: dict) -> None:
    name = "youtube_token" if ACCOUNT == "main" else f"youtube_token-{ACCOUNT}"
    _write_secret(_token_path(), _protect(json.dumps(tok).encode("utf-8"), name))


# The Google app every project can use (Settings › YouTube › "Use this Google app in every project"): kept in the studio
# home beside workspaces.json, so a project made in the studio can connect its own YouTube accounts without its own app.
HOME_APP = Path(os.environ.get("STUDIO_HOME") or Path.home() / ".lazycow") / "youtube_client.json"


def _app_file() -> Path | None:
    for p in (SECRETS / "youtube_client.json", ROOT / "youtube_client.json", HOME_APP):
        if p.exists():
            return p
    return None


def share_app(on: bool = True) -> dict:
    """Use this project's Google app in every project (a copy in the studio home), or stop (the copy is removed;
    projects with their own app keep it)."""
    if on:
        mine = SECRETS / "youtube_client.json"
        if not mine.exists():
            raise RuntimeError("This project has no Google app of its own to share: add the app file first.")
        HOME_APP.parent.mkdir(parents=True, exist_ok=True)
        _write_secret(HOME_APP, mine.read_bytes())
    else:
        HOME_APP.unlink(missing_ok=True)
    return app_info()


def client() -> tuple[str, str] | None:
    cid, sec = os.environ.get("STUDIO_YT_CLIENT_ID", ""), os.environ.get("STUDIO_YT_CLIENT_SECRET", "")
    if cid and sec:
        return cid, sec
    p = _app_file()
    if p:
        raw = json.loads(p.read_text(encoding="utf-8"))
        app = raw.get("installed") or raw.get("web") or {}
        if app.get("client_id") and app.get("client_secret"):
            return app["client_id"], app["client_secret"]
    return None


def app_info() -> dict:
    """Which Google app the studio signs in with: where it comes from and its Cloud project. Never the secret."""
    if os.environ.get("STUDIO_YT_CLIENT_ID") and os.environ.get("STUDIO_YT_CLIENT_SECRET"):
        cid = os.environ["STUDIO_YT_CLIENT_ID"]
        return {"set": True, "source": "env", "type": "unknown", "project": None, "projectNumber": cid.split("-")[0]}
    p = _app_file()
    if not p:
        return {"set": False}
    raw = json.loads(p.read_text(encoding="utf-8"))
    kind = "desktop" if "installed" in raw else "web" if "web" in raw else "unknown"
    app = raw.get("installed") or raw.get("web") or {}
    return {"set": bool(app.get("client_id")), "source": "studio" if p == HOME_APP else "file", "type": kind, "project": app.get("project_id"),
            "projectNumber": (app.get("client_id") or "").split("-")[0] or None, "shared": HOME_APP.exists()}


def set_app(text: str) -> dict:
    """Save the app Google gives you (the JSON from Google Cloud › Clients › Download). Desktop type recommended."""
    try:
        raw = json.loads(text)
    except ValueError:
        raise ValueError("That is not the file Google gives you: in Google Cloud open Clients, press the download icon, and pick that .json file.")
    if "installed" not in raw and "web" not in raw:
        raise ValueError("That file is not an OAuth client. In Google Cloud create a client of type Desktop app and download its JSON.")
    app = raw.get("installed") or raw.get("web")
    if not str(app.get("client_id", "")).endswith(".apps.googleusercontent.com") or not app.get("client_secret"):
        raise ValueError("The file is missing its client ID or secret. Download it again from Google Cloud › Clients.")
    if "web" in raw:
        raise ValueError("This client is the Web type. Create one of type Desktop app instead: it works on any port and needs no redirect list.")
    keep = {"installed": {k: app[k] for k in ("client_id", "client_secret", "project_id", "auth_uri", "token_uri") if k in app}}
    SECRETS.mkdir(parents=True, exist_ok=True)
    if _token_path().exists():  # a sign-in belongs to the app that made it
        _token_path().unlink()
    _write_secret(SECRETS / "youtube_client.json", json.dumps(keep).encode("utf-8"))
    return app_info()


def forget_app() -> dict:
    disconnect()
    for p in (SECRETS / "youtube_client.json",):
        p.unlink(missing_ok=True)
    return app_info()


def disconnect() -> None:
    """Sign out: ask Google to revoke the studio's access, then forget the token."""
    try:
        tok = _load_token()
    except OSError:
        tok = None
    if tok and tok.get("refresh_token"):
        _call("POST", "https://oauth2.googleapis.com/revoke", data=urllib.parse.urlencode({"token": tok["refresh_token"]}).encode(),
              headers={"content-type": "application/x-www-form-urlencoded"}, timeout=20)
    _token_path().unlink(missing_ok=True)


def expected_channel() -> str:
    """The channel this project posts to (STUDIO_YT_CHANNEL: an @handle or a UC… id), or "" for any."""
    return os.environ.get("STUDIO_YT_CHANNEL", "").strip()


def channel_mismatch(ch: dict | None) -> str | None:
    """A plain sentence when the signed-in channel is not the project's channel, else None."""
    want = expected_channel()
    if not want or not ch:
        return None
    have = {str(ch.get("id", "")).lower(), str(ch.get("handle", "")).lower().lstrip("@")}
    if want.lower().lstrip("@") in have:
        return None
    return (f"You signed in to the channel \"{ch.get('title')}\" ({ch.get('handle') or ch.get('id')}), but this project posts to {want}. "
            f"Press Connect YouTube again and pick the Google account that owns {want} (a channel you only manage cannot be used by apps).")


def _email_from(id_token: str | None) -> str | None:
    """The account's email from the id_token Google returned on this TLS call (shown, never trusted for access)."""
    if not id_token or id_token.count(".") != 2:
        return None
    part = id_token.split(".")[1]
    try:
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("email")
    except (ValueError, TypeError):
        return None


# ---------- HTTP ----------

def _call(method: str, url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: int = 120):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_tls()) as r:
            body = r.read()
            return r.status, dict(r.headers), body
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


def _tls():
    try:
        import certifi
        import ssl

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return None


def _json(body: bytes) -> dict:
    try:
        return json.loads(body.decode("utf-8") or "{}")
    except ValueError:
        return {}


def _google_error(status: int, body: bytes) -> str:
    j = _json(body)
    err = j.get("error")
    if isinstance(err, dict):
        reasons = ",".join(e.get("reason", "") for e in err.get("errors", []) if e.get("reason"))
        return f"YouTube {status}: {err.get('message', '')}{f' ({reasons})' if reasons else ''}"
    if isinstance(err, str):
        return f"Google {status}: {err} {j.get('error_description', '')}".strip()
    return f"YouTube {status}"


# ---------- OAuth ----------

def auth_url(port: int | str | None = None, hint: str | None = None, account: str = "main") -> str:
    """Google's own sign-in, always with the account chooser (prompt=select_account) so the person picks the
    account that owns the channel; `hint` (an email) preselects it. Consent is asked again so a refresh token
    is always returned. account: "main" (again), an existing id (sign it in again), or "new" (another channel)."""
    acct = _next_account() if account == "new" else account
    if not ACCOUNT_RX.fullmatch(acct or ""):
        raise RuntimeError("account: main, new, or a2, a3, ...")
    c = client()
    if not c:
        raise RuntimeError("No Google app yet: open Settings › Keys & AI › YouTube and add the app file from your own Google Cloud project.")
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    redirect = redirect_uri(port)
    SECRETS.mkdir(parents=True, exist_ok=True)
    (SECRETS / "youtube_pending.json").write_text(json.dumps({"state": state, "verifier": verifier, "at": time.time(), "redirect": redirect, "account": acct}), encoding="utf-8")
    q = {
        "client_id": c[0], "redirect_uri": redirect, "response_type": "code", "scope": SCOPES,
        "access_type": "offline", "prompt": "select_account consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256", "include_granted_scopes": "true",
    }
    if hint and "@" in hint:
        q["login_hint"] = hint.strip()
    return AUTH + "?" + urllib.parse.urlencode(q)


def exchange(code: str, state: str) -> dict:
    pend_path = SECRETS / "youtube_pending.json"
    if not pend_path.exists():
        raise RuntimeError("no sign-in was started from the studio")
    pend = json.loads(pend_path.read_text(encoding="utf-8"))
    # Checked before the pending sign-in is used up: a stray or forged return (wrong state) must not cancel
    # the sign-in the owner is in the middle of. A matching state is single-use.
    if not secrets.compare_digest(str(pend.get("state", "")), state or ""):
        raise RuntimeError("sign-in state did not match; start again from the studio")
    pend_path.unlink(missing_ok=True)
    if time.time() - pend.get("at", 0) > 900:
        raise RuntimeError("sign-in took longer than 15 minutes; start again")
    use(pend.get("account") or "main")
    cid, sec = client() or ("", "")
    form = urllib.parse.urlencode({
        "code": code, "client_id": cid, "client_secret": sec, "redirect_uri": pend.get("redirect") or REDIRECT,
        "grant_type": "authorization_code", "code_verifier": pend["verifier"],
    }).encode()
    status, _, body = _call("POST", TOKEN, data=form, headers={"content-type": "application/x-www-form-urlencoded"})
    if status != 200:
        raise RuntimeError(_google_error(status, body))
    j = _json(body)
    if not j.get("refresh_token"):
        raise RuntimeError("Google returned no refresh token; remove the studio's access in your Google account and connect again")
    tok = {"refresh_token": j["refresh_token"], "access_token": j["access_token"], "expires": time.time() + int(j.get("expires_in", 3600)) - 60,
           "scopes": j.get("scope", "").split(), "account": _email_from(j.get("id_token")), "since": time.time(),
           "project": (app_info().get("project") or None)}
    _save_token(tok)
    ch = channel()
    wrong = channel_mismatch(ch) if ACCOUNT == "main" else None  # the project's own channel binds Shorts, not the others
    if wrong:  # never keep a sign-in that would post to the wrong channel
        disconnect()
        raise RuntimeError(wrong)
    tok["channel"] = ch
    _save_token(tok)
    return {"connected": True, "channel": ch, "account": ACCOUNT}


def access_token() -> str:
    tok = _load_token()
    if not tok:
        raise RuntimeError("YouTube is not connected")
    if tok.get("access_token") and tok.get("expires", 0) > time.time():
        return tok["access_token"]
    cid, sec = client() or ("", "")
    form = urllib.parse.urlencode({"client_id": cid, "client_secret": sec, "refresh_token": tok["refresh_token"], "grant_type": "refresh_token"}).encode()
    status, _, body = _call("POST", TOKEN, data=form, headers={"content-type": "application/x-www-form-urlencoded"})
    if status != 200:
        msg = _google_error(status, body)
        if "invalid_grant" in msg:
            # Google: an External app in "Testing" gets refresh tokens that expire after 7 days.
            days = (time.time() - tok.get("since", time.time())) / 86400
            msg += (" (the sign-in expired after about a week: your Google app is probably still in Testing. In Google Cloud open"
                    " Google Auth Platform › Audience, press Publish app, then press Connect YouTube again)" if 6 <= days <= 8
                    else " (the sign-in expired or was removed; press Connect YouTube again)")
        raise RuntimeError(msg)
    j = _json(body)
    tok.update(access_token=j["access_token"], expires=time.time() + int(j.get("expires_in", 3600)) - 60)
    _save_token(tok)
    return tok["access_token"]


def _get(path: str, **params) -> dict:
    status, _, body = _call("GET", f"{API}/{path}?{urllib.parse.urlencode(params)}", headers={"authorization": f"Bearer {access_token()}"})
    if status != 200:
        raise RuntimeError(_google_error(status, body))
    return _json(body)


def _post(path: str, resource: dict, **params) -> dict:
    status, _, body = _call("POST", f"{API}/{path}?{urllib.parse.urlencode(params)}", data=json.dumps(resource).encode("utf-8"),
                            headers={"authorization": f"Bearer {access_token()}", "content-type": "application/json; charset=UTF-8"})
    if status not in (200, 201):
        msg = _google_error(status, body)
        if "insufficient" in msg.lower() or status == 403 and "scope" in msg.lower():
            msg += " (press Connect YouTube again to allow playlists)"
        raise RuntimeError(msg)
    return _json(body)


def channel() -> dict:
    items = _get("channels", part="snippet,contentDetails", mine="true").get("items", [])
    if not items:
        raise RuntimeError("this Google account has no YouTube channel; pick the channel this project posts to when signing in")
    c = items[0]
    return {"id": c["id"], "title": c["snippet"]["title"], "handle": c["snippet"].get("customUrl", ""),
            "uploads": c["contentDetails"]["relatedPlaylists"]["uploads"]}


def status() -> dict:
    info = app_info()
    out = {"app": bool(client()), "appInfo": info, "connected": False}
    tok = None
    try:
        tok = _load_token()
    except OSError as err:
        out["error"] = str(err)
    if tok:
        scopes = tok.get("scopes") or []
        out.update(connected=True, channel=tok.get("channel"), playlists=MANAGE in scopes, account=tok.get("account"),
                   analytics="https://www.googleapis.com/auth/yt-analytics.readonly" in scopes, since=tok.get("since"))
    return out


# ---------- the Short ----------

def _folder(slug: str) -> Path:
    from studio.reels import DRAFTS

    return DRAFTS / slug / "youtube-shorts"


def metadata(slug: str) -> dict:
    """Title and description from the approved post text, plus the reel's hashtags and the music credit."""
    from studio.projects import load

    folder = _folder(slug)
    text = (folder / "post.txt").read_text(encoding="utf-8")
    title = text.split("TITLE:", 1)[1].split("\n", 1)[0].strip() if "TITLE:" in text else slug
    desc = text.split("DESCRIPTION:", 1)[1].strip() if "DESCRIPTION:" in text else text.strip()
    project = load(slug) or {}
    tags = project.get("tags") or []
    if not tags:
        from studio.reels import REELS

        tags = next((r.get("tags", []) for r in REELS if r["slug"] == slug), [])
    credit = ""
    credits = folder / "credits.txt"
    if credits.exists():
        rows = credits.read_text(encoding="utf-8").splitlines()
        line = next((l for l in rows if l.startswith("Music:")), "")
        licence = next((l for l in rows if l.startswith("Licence:")), "")
        if line:
            # A bed studio.ai made for this reel is credited as AI-made, never as CC0.
            credit = line.replace(".wav", "").replace(".mp3", "") + (" (AI-generated music)" if "AI-GENERATED" in licence else " (CC0)")
    parts = [desc, "群馬県吾妻郡嬬恋村・嬬恋牧場Work&Camp"]
    if credit:
        parts.append(credit)
    if tags:
        parts.append(" ".join(tags))
    words = [t.lstrip("#") for t in tags] + ["嬬恋牧場Work&Camp", "嬬恋", "群馬"]
    return {
        "title": title[:100],
        "description": "\n\n".join(parts)[:4900],
        "tags": list(dict.fromkeys(w for w in words if w))[:15],
        "video": next(iter(sorted(folder.glob("*.mp4"))), None),
    }


def synthetic(slug: str) -> bool:
    """YouTube's status.containsSyntheticMedia ("altered or synthetic content"): true when the reel carries an
    AI note that needs a label (studio.ai: an AI voice or a living photo). Slow motion, sharpening and an AI
    music bed are aesthetic edits and do not set it."""
    from studio.projects import load

    return any(isinstance(n, dict) and n.get("label_required") for n in ((load(slug) or {}).get("ai") or []))


def _rfc3339(local_iso: str) -> str:
    """'2026-11-08T19:00' in this PC's time zone -> UTC RFC 3339."""
    dt = datetime.fromisoformat(local_iso)
    if dt.tzinfo is None:
        dt = dt.astimezone()
    if dt.timestamp() < time.time() + 15 * 60:
        raise RuntimeError("a scheduled time must be at least 15 minutes from now")
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def delete_video(video_id: str) -> None:
    """Delete one of this channel's videos (a scheduled Short that is being replaced). Already gone counts as done."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", str(video_id or "")):
        raise RuntimeError("no YouTube video id on this booking")
    code, _, body = _call("DELETE", f"{API}/videos?id={video_id}", headers={"authorization": f"Bearer {access_token()}"})
    if code in (200, 204, 404):
        return
    raise RuntimeError(_google_error(code, body))


def upload(slug: str, at: str | None = None, privacy: str = "private", force: bool = False) -> dict:
    if privacy not in ("private", "unlisted", "public"):
        raise RuntimeError("privacy: private, unlisted or public")
    from studio.publish import NotApproved, assert_approved

    try:
        assert_approved(slug)  # only approved reels go out, on YouTube too
    except NotApproved as err:
        raise RuntimeError(str(err)) from err
    tok = _load_token() or {}
    wrong = channel_mismatch(tok.get("channel"))
    if wrong:
        raise RuntimeError(wrong)
    done = [p for p in posts() if p["slug"] == slug and p["network"] == "youtube" and p["status"] in ("scheduled", "posted")]
    if done and not force:
        raise RuntimeError(f"{slug} is already on YouTube: {done[0]['url']}")
    meta = metadata(slug)
    video: Path | None = meta["video"]
    if not video or not video.exists():
        raise RuntimeError(f"no YouTube file for {slug}; render it first")
    st = {"privacyStatus": privacy, "selfDeclaredMadeForKids": False, "containsSyntheticMedia": synthetic(slug), "embeddable": True}
    if at:
        st.update(privacyStatus="private", publishAt=_rfc3339(at))
    resource = {
        "snippet": {"title": meta["title"], "description": meta["description"], "tags": meta["tags"],
                    "categoryId": TRAVEL, "defaultLanguage": "ja", "defaultAudioLanguage": "ja"},
        "status": st,
    }
    result = _resumable(video, resource)
    vid = result["id"]
    url = f"https://youtube.com/shorts/{vid}"
    record(slug, "youtube", "scheduled" if at else "posted", at or datetime.now().isoformat(timespec="minutes"), vid, url,
           note=f"{privacy if not at else 'private until ' + at}")
    if at or privacy == "public":
        try:
            if MANAGE in ((_load_token() or {}).get("scopes") or []):
                mine = _my_playlists()
                for key in playlist_keys(meta["title"], _theme_of(slug)):
                    p = next(x for x in PLAYLISTS if x["key"] == key)
                    if p["title"] in mine:
                        _post("playlistItems", {"snippet": {"playlistId": mine[p["title"]]["id"], "resourceId": {"kind": "youtube#video", "videoId": vid}}}, part="snippet")
        except Exception as err:  # the upload stands; the playlist can be fixed with "Sort into playlists"
            print(f"playlist: {err}", file=sys.stderr)
    return {"id": vid, "url": url, "privacy": result.get("status", {}).get("privacyStatus"),
            "publishAt": result.get("status", {}).get("publishAt"), "title": meta["title"]}


def _resumable(video: Path, resource: dict) -> dict:
    """YouTube's resumable upload (8 MB chunks, server errors tried again): the video resource it returns."""
    size = video.stat().st_size
    print("STAGE 1/2 asking YouTube for an upload slot", flush=True)
    status_, headers, body = _call(
        "POST", f"{UPLOAD}?uploadType=resumable&part=snippet,status",
        data=json.dumps(resource).encode("utf-8"),
        headers={"authorization": f"Bearer {access_token()}", "content-type": "application/json; charset=UTF-8",
                 "x-upload-content-length": str(size), "x-upload-content-type": "video/mp4"},
    )
    location = {k.lower(): v for k, v in headers.items()}.get("location")
    if status_ != 200 or not location:
        raise RuntimeError(_google_error(status_, body))
    print(f"STAGE 2/2 uploading {video.name}", flush=True)
    sent, result = 0, None
    with video.open("rb") as f:
        while sent < size:
            chunk = f.read(CHUNK)
            end = sent + len(chunk) - 1
            for attempt in range(5):
                code, hdrs, body = _call("PUT", location, data=chunk, timeout=600,
                                         headers={"authorization": f"Bearer {access_token()}", "content-length": str(len(chunk)),
                                                  "content-range": f"bytes {sent}-{end}/{size}"})
                if code in (200, 201, 308):
                    break
                if code >= 500 and attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(_google_error(code, body))
            sent = end + 1
            print(f"PROGRESS {sent // 1024}/{size // 1024} uploading {video.name}", flush=True)
            if code in (200, 201):
                result = _json(body)
    if not result or not result.get("id"):
        raise RuntimeError("YouTube did not confirm the upload")
    return result


def _set_thumbnail(video_id: str, image: Path) -> None:
    """A custom thumbnail (YouTube allows it once the channel is verified by phone; 2 MB at most)."""
    data = image.read_bytes()
    if len(data) > 2 * 1024 * 1024:
        raise RuntimeError("the thumbnail is over 2 MB")
    code, _, body = _call("POST", f"https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId={video_id}", data=data,
                          headers={"authorization": f"Bearer {access_token()}", "content-type": "image/jpeg"})
    if code != 200:
        raise RuntimeError(_google_error(code, body))


def _vlog_dir(n: int) -> Path:
    return DATA / "renders" / "vlogs" / f"vlog-{int(n)}"


def _uploaded(n: int, made: str | None = None) -> dict | None:
    """What uploaded.json says went to YouTube for long video n, but only when it is this build's upload (`made`, the
    build's stamp in youtube.json): the series reuses the folders vlog-1, vlog-2, ... of earlier plans, and a record
    of an earlier film must never be taken for this one (its video is someone else's link, left as it is)."""
    try:
        up = json.loads((_vlog_dir(n) / "uploaded.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if made is not None and up.get("made") != made:
        return None
    return up


def upload_vlog(n: int, privacy: str = "unlisted", at: str | None = None, force: bool = False) -> dict:
    """A long video (studio.vlog part n) to the channel of the account in use (use()): its title, description with
    chapters, tags and thumbnail. privacy: private, unlisted (only people with the link) or public; `at` schedules it
    (private until then, then public). The upload is written to the posts table as vlog-<n>, so it is not sent twice.
    A series episode (youtube.json has a link template) is sent once per build: its description carries the links
    already known (the part before, the series playlist) and leaves out the others until link_series; its spoken
    words go up as English captions (subtitles.srt). An earlier film's record in the same folder is kept aside as
    uploaded-<id>.json; that video is not touched."""
    if privacy not in ("private", "unlisted", "public"):
        raise RuntimeError("privacy: private, unlisted or public")
    d = _vlog_dir(n)
    video, info_path = d / "master.mp4", d / "youtube.json"
    if not video.exists() or not info_path.exists():
        raise RuntimeError(f"part {n} is not built yet")
    slug = f"vlog-{int(n)}"
    info = json.loads(info_path.read_text(encoding="utf-8"))
    meta = info.get("youtube") or {}
    if not meta.get("title"):
        raise RuntimeError(f"part {n} has no YouTube title yet; build it again")
    series = bool(meta.get("template"))
    if series:
        same = _uploaded(n, info.get("made"))
        if same and not force:
            raise RuntimeError(f"part {n} is already on YouTube: {same['url']}")
        old = _uploaded(n)
        if old and not same:  # an earlier film's record: kept beside, never reused
            (d / "uploaded.json").replace(d / f"uploaded-{old.get('id') or 'earlier'}.json")
    else:
        done = [p for p in posts() if p["slug"] == slug and p["network"] == "youtube" and p["status"] in ("scheduled", "posted")]
        if done and not force:
            raise RuntimeError(f"part {n} is already on YouTube: {done[0]['url']}")
    description = str(meta.get("description") or "")
    if series:
        from studio import vlog

        description = vlog.fill_links(meta["template"], _series_links(n))
    st = {"privacyStatus": privacy, "selfDeclaredMadeForKids": False, "embeddable": True}
    if at:
        st.update(privacyStatus="private", publishAt=_rfc3339(at))
    resource = {"snippet": {"title": meta["title"][:100], "description": description[:5000],
                            "tags": [str(t)[:60] for t in (meta.get("tags") or [])][:30], "categoryId": TRAVEL,
                            "defaultLanguage": "en", "defaultAudioLanguage": "en"}, "status": st}
    result = _resumable(video, resource)
    vid = result["id"]
    url = f"https://youtu.be/{vid}"
    note = f"{ACCOUNT}: " + (f"private until {at}, then public" if at else privacy)
    thumb = d / "thumbnail.jpg"
    if thumb.exists():
        try:
            _set_thumbnail(vid, thumb)
        except Exception as err:  # the upload stands; YouTube keeps its own frame
            note += f"; thumbnail not set ({str(err)[:120]})"
    captions = None
    if series and (d / "subtitles.srt").exists():
        try:
            captions = upload_captions(vid, d / "subtitles.srt")["id"]
        except Exception as err:  # the upload stands; the .srt can be added in Studio
            note += f"; captions not added ({str(err)[:120]})"
    record(slug, "youtube", "scheduled" if at else "posted", at or datetime.now().isoformat(timespec="minutes"), vid, url, note=note)
    out = {"id": vid, "url": url, "privacy": result.get("status", {}).get("privacyStatus"), "publishAt": result.get("status", {}).get("publishAt"),
           "title": meta["title"], "account": ACCOUNT, "note": note, "at": datetime.now().astimezone().isoformat(timespec="seconds"),
           "made": info.get("made"), **({"series": meta.get("series"), "captions": captions} if series else {})}
    (d / "uploaded.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")  # the Long videos page reads it
    return out


# ---------- a series of long videos: playlist, links, captions, comments ----------

def _series_parts() -> list[dict]:
    """The series episodes of the plan, in order: [{n, of, title, made, template, uploaded}], uploaded only when it is
    this build's upload (_uploaded)."""
    try:
        plan = json.loads((DATA / "vlog-plan.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    out = []
    for v in plan.get("videos", []):
        if not v.get("series"):
            continue
        try:
            info = json.loads((_vlog_dir(v["n"]) / "youtube.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            info = {}
        yt = info.get("youtube") or {}
        out.append({"n": v["n"], "of": v["series"]["of"], "title": yt.get("title") or v["title"], "episode": v.get("episode") or v["title"].split(": ", 1)[-1],
                    "made": info.get("made"), "template": yt.get("template"), "tags": yt.get("tags") or [], "uploaded": _uploaded(v["n"], info.get("made")) if info else None})
    return out


def _series_state() -> dict:
    try:
        return json.loads((DATA / "vlog-series.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _series_links(n: int) -> dict:
    """The links a series episode's description can carry now: the parts before and after (when this build's upload
    of them exists) and the series playlist (once made)."""
    parts = {p["n"]: p for p in _series_parts()}
    link = lambda k: (parts.get(k) or {}).get("uploaded", {}) and parts[k]["uploaded"].get("url")  # noqa: E731
    pl = _series_state().get("playlist")
    return {"prev": link(n - 1) or None, "next": link(n + 1) or None, "playlist": f"https://www.youtube.com/playlist?list={pl}" if pl else None}


def _put(path: str, resource: dict, **params) -> dict:
    status, _, body = _call("PUT", f"{API}/{path}?{urllib.parse.urlencode(params)}", data=json.dumps(resource).encode("utf-8"),
                            headers={"authorization": f"Bearer {access_token()}", "content-type": "application/json; charset=UTF-8"})
    if status != 200:
        raise RuntimeError(_google_error(status, body))
    return _json(body)


def series_playlist(title: str, ids: list[str], description: str = "", privacy: str = "public") -> dict:
    """The series playlist, in episode order: found by its title on the channel or made (playlists.insert, 50 units),
    then each video not in it yet added at its position (playlistItems.insert, 50 units each). A playlist sorted by
    YouTube refuses positions (manualSortRequired): the rest are added without one, in order. A public playlist shows
    others only the videos that are public themselves."""
    if privacy not in ("private", "unlisted", "public"):
        raise RuntimeError("privacy: private, unlisted or public")
    mine = _my_playlists()
    if title in mine:
        pid, created = mine[title]["id"], False
    else:
        made = _post("playlists", {"snippet": {"title": title[:150], "description": description[:5000], "defaultLanguage": "en"},
                                   "status": {"privacyStatus": privacy}}, part="snippet,status")
        pid, created = made["id"], True
    have = _members(pid)
    added, positioned = [], True
    for k, vid in enumerate(ids):
        if vid in have:
            continue
        item = {"snippet": {"playlistId": pid, "resourceId": {"kind": "youtube#video", "videoId": vid}}}
        if positioned:
            try:
                _post("playlistItems", {"snippet": {**item["snippet"], "position": k}}, part="snippet")
                added.append(vid)
                continue
            except RuntimeError as err:
                if "manualSortRequired" not in str(err):
                    raise
                positioned = False
        _post("playlistItems", item, part="snippet")
        added.append(vid)
    return {"id": pid, "url": f"https://www.youtube.com/playlist?list={pid}", "created": created, "added": added, "positioned": positioned}


def link_series(title: str | None = None, dry_run: bool = False, privacy: str = "public") -> dict:
    """Once every episode of the series is on YouTube (this build's uploads): the series playlist in order
    (series_playlist), then each episode's description with its real links to the part before, the part after and
    the playlist (videos.update, 50 units each). videos.update replaces the whole snippet, so the video's own title,
    category, tags and languages are read first (videos.list) and sent back with the new description; nothing else
    changes. Only videos this build uploaded are touched. dry_run: the descriptions, with no call to YouTube."""
    from studio import vlog

    parts = _series_parts()
    if not parts:
        raise RuntimeError("the plan has no series: plan one first (vlog plan --series)")
    missing = [p["n"] for p in parts if not p["uploaded"] or not p["template"]]
    if missing:
        raise RuntimeError(f"upload these parts of the series first (built now, not on YouTube yet): {', '.join(map(str, missing))}")
    try:
        name = json.loads((DATA / "vlog-plan.json").read_text(encoding="utf-8")).get("name") or "The trip"
    except (OSError, ValueError):
        name = "The trip"
    title = (title or f"{name} · the series").strip()[:150]
    ids = [p["uploaded"]["id"] for p in parts]
    url = {p["n"]: p["uploaded"]["url"] for p in parts}
    if dry_run:
        pl = "https://www.youtube.com/playlist?list=(made on the real run)"
        return {"dryRun": True, "playlist": {"title": title, "url": pl}, "descriptions": {
            p["n"]: vlog.fill_links(p["template"], {"prev": url.get(p["n"] - 1), "next": url.get(p["n"] + 1), "playlist": pl}) for p in parts}}
    lines = "\n".join(f"Part {p['n']} of {p['of']}: {p['episode']}" for p in parts)
    pl = series_playlist(title, ids, description=f"{name}, in order.\n\n{lines}", privacy=privacy)
    state = {**_series_state(), "playlist": pl["id"], "title": title, "at": datetime.now().astimezone().isoformat(timespec="seconds")}
    (DATA / "vlog-series.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    updated = []
    for p in parts:
        vid = p["uploaded"]["id"]
        desc = vlog.fill_links(p["template"], {"prev": url.get(p["n"] - 1), "next": url.get(p["n"] + 1), "playlist": pl["url"]})
        items = _get("videos", part="snippet", id=vid).get("items", [])
        if not items:
            raise RuntimeError(f"part {p['n']} ({vid}) is not on this channel; connect the account it was uploaded to")
        cur = items[0]["snippet"]
        snippet = {"title": cur.get("title") or p["title"], "categoryId": cur.get("categoryId") or TRAVEL, "description": desc[:5000],
                   "tags": cur.get("tags") or p["tags"], **{k: cur[k] for k in ("defaultLanguage", "defaultAudioLanguage") if cur.get(k)}}
        _put("videos", {"id": vid, "snippet": snippet}, part="snippet")
        up = dict(p["uploaded"], linked=state["at"], playlist=pl["id"])
        (_vlog_dir(p["n"]) / "uploaded.json").write_text(json.dumps(up, ensure_ascii=False, indent=1), encoding="utf-8")
        updated.append(p["n"])
    return {"playlist": pl, "updated": updated}


def upload_captions(video_id: str, srt: Path, language: str = "en", name: str = "English") -> dict:
    """A caption track from an .srt file (captions.insert, 400 units): what people say in the clips, for viewers with
    the sound off and for search."""
    data = srt.read_bytes()
    if not data.strip():
        raise RuntimeError("the subtitles file is empty")
    meta = json.dumps({"snippet": {"videoId": video_id, "language": language, "name": name, "isDraft": False}}).encode("utf-8")
    boundary = "lazycow" + secrets.token_hex(8)
    body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode() + meta
            + f"\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n".encode() + data + f"\r\n--{boundary}--\r\n".encode())
    code, _, out = _call("POST", "https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet", data=body,
                         headers={"authorization": f"Bearer {access_token()}", "content-type": f"multipart/related; boundary={boundary}"})
    if code not in (200, 201):
        raise RuntimeError(_google_error(code, out))
    return _json(out)


def post_comment(video_id: str, text: str) -> dict:
    """A comment on the channel's own video (commentThreads.insert, 50 units). Pinning it is done in YouTube Studio:
    the API has no way to pin."""
    t = str(text or "").strip()
    if not t:
        raise RuntimeError("no comment text")
    made = _post("commentThreads", {"snippet": {"videoId": video_id, "topLevelComment": {"snippet": {"textOriginal": t[:1000]}}}}, part="snippet")
    return {"id": made.get("id"), "videoId": video_id}


def series_comments(dry_run: bool = False) -> dict:
    """On each episode of the series (this build's uploads), one comment that says where it sits and where to go next
    ("Part 2 of 4. Next: Part 3, The River Crossing and a Birthday <link>"), for the person to pin in Studio. A part
    that already has its comment is skipped. YouTube refuses comments on private videos: run this once they are
    public or unlisted."""
    parts = _series_parts()
    if not parts or any(not p["uploaded"] for p in parts):
        raise RuntimeError("upload every part of the series first, then link it (youtube link-series)")
    pl = _series_state().get("playlist")
    url = {p["n"]: p["uploaded"]["url"] for p in parts}
    texts = {}
    for p in parts:
        n, of = p["n"], p["of"]
        nxt = next((q for q in parts if q["n"] == n + 1), None)
        tail = (f"Next: Part {n + 1}, {nxt['episode']} {url[n + 1]}" if nxt else
                f"That's the whole series. Watch it from Part 1: {f'https://www.youtube.com/playlist?list={pl}' if pl else url[parts[0]['n']]}")
        texts[n] = f"Part {n} of {of}: {p['episode']}. {tail}"
    if dry_run:
        return {"dryRun": True, "comments": texts}
    done = []
    for p in parts:
        if p["uploaded"].get("comment"):
            continue
        c = post_comment(p["uploaded"]["id"], texts[p["n"]])
        up = dict(p["uploaded"], comment=c["id"])
        (_vlog_dir(p["n"]) / "uploaded.json").write_text(json.dumps(up, ensure_ascii=False, indent=1), encoding="utf-8")
        done.append(p["n"])
    return {"commented": done, "comments": texts}


def _theme_of(slug: str | None) -> str | None:
    if not slug:
        return None
    from studio.projects import load

    project = load(slug) or {}
    return project.get("theme") or slug.split("-")[0]


def playlist_keys(title: str, theme: str | None) -> list[str]:
    """Which bilingual playlists a video belongs in: its reel's theme, then words in its title."""
    low = title.lower()
    keys = [p["key"] for p in PLAYLISTS if theme and theme in p["themes"]]
    keys += [p["key"] for p in PLAYLISTS if any(w.lower() in low for w in p["words"])]
    return list(dict.fromkeys(keys))


def _my_playlists() -> dict[str, dict]:
    out, token = {}, ""
    while True:
        page = _get("playlists", part="snippet,contentDetails", mine="true", maxResults="50", **({"pageToken": token} if token else {}))
        for p in page.get("items", []):
            out[p["snippet"]["title"]] = {"id": p["id"], "count": p["contentDetails"]["itemCount"]}
        token = page.get("nextPageToken", "")
        if not token:
            return out


def _members(playlist_id: str) -> set[str]:
    ids, token = set(), ""
    while True:
        page = _get("playlistItems", part="contentDetails", playlistId=playlist_id, maxResults="50", **({"pageToken": token} if token else {}))
        ids |= {i["contentDetails"]["videoId"] for i in page.get("items", [])}
        token = page.get("nextPageToken", "")
        if not token:
            return ids


def playlists() -> dict:
    """The studio's playlists as they are on the channel: id, count, members."""
    mine = _my_playlists()
    out = []
    for p in PLAYLISTS:
        found = mine.get(p["title"])
        out.append({"key": p["key"], "title": p["title"], "id": found["id"] if found else None, "count": found["count"] if found else 0,
                    "url": f"https://www.youtube.com/playlist?list={found['id']}" if found else None,
                    "members": sorted(_members(found["id"])) if found else []})
    return {"playlists": out}


def sort_into_playlists(dry_run: bool = False) -> dict:
    """Create any missing playlist (public) and add every public or scheduled video where it belongs.
    A private video with no release time is left out: it is private on purpose."""
    mine = _my_playlists()
    by_key = {p["key"]: p for p in PLAYLISTS}
    ids = {p["key"]: mine[p["title"]]["id"] for p in PLAYLISTS if p["title"] in mine}
    members = {k: _members(v) for k, v in ids.items()}
    plan, skipped = [], []
    for v in list_videos(50):
        if v["privacy"] != "public" and not v.get("publishAt"):
            skipped.append(v["title"])
            continue
        for key in playlist_keys(v["title"], _theme_of(v.get("slug"))):
            if v["id"] not in members.get(key, set()):
                plan.append((key, v))
    created, added = [], []
    for key, v in plan:
        if key not in ids:
            created.append(by_key[key]["title"])
            ids[key] = None
            if not dry_run:
                made = _post("playlists", {"snippet": {"title": by_key[key]["title"], "description": by_key[key]["description"], "defaultLanguage": "ja"},
                                           "status": {"privacyStatus": "public"}}, part="snippet,status")
                ids[key] = made["id"]
        if not dry_run:
            _post("playlistItems", {"snippet": {"playlistId": ids[key], "resourceId": {"kind": "youtube#video", "videoId": v["id"]}}}, part="snippet")
        added.append({"video": v["title"], "playlist": by_key[key]["title"]})
    return {"created": created, "added": added, "skippedPrivate": skipped, "dryRun": dry_run}


def list_videos(n: int = 15) -> list[dict]:
    """What is on the channel now, newest first, with our reel slug where we sent it."""
    tok = _load_token() or {}
    ch = tok.get("channel") or channel()
    items = _get("playlistItems", part="contentDetails", playlistId=ch["uploads"], maxResults=str(n)).get("items", [])
    ids = [i["contentDetails"]["videoId"] for i in items]
    if not ids:
        return []
    vids = _get("videos", part="snippet,status,statistics", id=",".join(ids)).get("items", [])
    ours = {p["remote_id"]: p["slug"] for p in posts() if p["network"] == "youtube" and p["remote_id"]}
    out = []
    for v in vids:
        out.append({
            "id": v["id"], "url": f"https://youtube.com/shorts/{v['id']}", "title": v["snippet"]["title"],
            "thumb": (v["snippet"].get("thumbnails", {}).get("medium") or {}).get("url"),
            "privacy": v["status"]["privacyStatus"], "publishAt": v["status"].get("publishAt"),
            "published": v["snippet"].get("publishedAt"), "views": int(v.get("statistics", {}).get("viewCount", 0) or 0),
            "likes": int(v.get("statistics", {}).get("likeCount", 0) or 0), "slug": ours.get(v["id"]),
            "processing": v["status"].get("uploadStatus"),
        })
    return out
