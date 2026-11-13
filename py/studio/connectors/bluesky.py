"""
FILE: py/studio/connectors/bluesky.py
PURPOSE: Post a finished reel to Bluesky as a video post, with clickable links and hashtags.
OVERVIEW: Two ways in. "Sign in with Bluesky" (bluesky_oauth.py: Bluesky's own sign-in page,
          a session that lasts two weeks) or the other way, a handle and an app password (never
          the account password), which never runs out. Either is stored encrypted with the
          YouTube secret helpers. A post signs its requests to the account's server with the
          session (DPoP) or logs in fresh with the app password, sends the video to Bluesky's
          video service, waits for it to be processed, then writes the post record.
DEPENDENCIES: Python stdlib, studio.youtube (HTTPS and secret helpers), studio.media (aspect ratio, optional)
USAGE: from studio.connectors import get; get("bluesky").post(Path("reel.mp4"), "text")
TECHNICAL DETAILS (read 2026-11-08):
  Video guide: https://docs.bsky.app/docs/tutorials/video, which now redirects to
    https://bsky.network/docs/about-bluesky-content/video ("Recommended method").
  Lexicons: com.atproto.* from github.com/bluesky-social/atproto/lexicons; app.bsky.* from
    github.com/bluesky-social/bsky/lexicons (their canonical home since the split).
  1. POST https://bsky.social/xrpc/com.atproto.server.createSession {identifier, password}
     -> accessJwt, did, handle, didDoc. The PDS is the didDoc service whose id ends "#atproto_pds".
  2. GET  <pds>/xrpc/com.atproto.server.getServiceAuth?aud=did:web:<pds host>
          &lxm=com.atproto.repo.uploadBlob&exp=<now + 30 min>  -> {token}
  3. POST https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=<did>&name=<file name>
          Authorization: Bearer <service token>, Content-Type: video/mp4, body = the file
          -> {jobStatus: {jobId, state, blob?}} (the guide's sample reads the JobStatus at top level;
          both shapes are accepted).
  4. GET  https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=<id> (no auth) until a blob
          appears: JOB_STATE_COMPLETED, or an "already_exists" error that still carries the blob.
          JOB_STATE_FAILED stops with its error/message.
  5. POST <pds>/xrpc/com.atproto.repo.createRecord {repo: did, collection: app.bsky.feed.post,
          record: {$type, text, createdAt, langs, facets, embed: {$type: app.bsky.embed.video,
          video: <blob>, aspectRatio}}} -> {uri, cid}; the rkey is the last part of the uri.
  Before the upload, app.bsky.video.getUploadLimits (service token aud=did:web:video.bsky.app,
  lxm=app.bsky.video.getUploadLimits) is asked whether the account may upload today; a failed check
  is ignored, only an explicit canUpload=false stops the post.
  Limits: post text 300 graphemes and 3000 UTF-8 bytes (app.bsky.feed.post); video up to 300 MB
  (app.bsky.embed.video); the account email must be verified and there is a daily video quota.
  Facets (app.bsky.richtext.facet) index UTF-8 byte offsets, end exclusive.
NOTES: Bluesky cannot hold a post until a time (can_schedule = False); the studio's runner calls
       post() at the planned time. Grapheme counting is an approximation of Unicode extended
       grapheme clusters (combining marks, ZWJ emoji, flags, skin tones, variation selectors),
       since the Python 3.13 standard library has no segmenter.
"""
from __future__ import annotations

import base64
import json
import re
import time
import unicodedata
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from studio.connectors import bluesky_oauth as oauth
from studio.youtube import SECRETS, _call, _json, _protect, _unprotect, _write_secret

NAME = "Bluesky"
HOW = ("In the Bluesky app open Settings › Privacy and security › App passwords, add one called "
       "Lazycow Studio, and paste it here with your handle (never your account password).")
FIELDS = [
    {"key": "handle", "label": "Handle", "secret": False, "placeholder": "tsumagoi.bsky.social"},
    {"key": "app_password", "label": "App password", "secret": True, "placeholder": "xxxx-xxxx-xxxx-xxxx"},
]
can_schedule = False
LINKS = [{"label": "Open App passwords", "url": "https://bsky.app/settings/app-passwords"}]


def signin(port: int = 4317) -> dict:
    """The one-click way in: always available (no app to register), a handle is optional."""
    return {"ready": True, "handle": True}

ENTRYWAY = "https://bsky.social"
VIDEO = "https://video.bsky.app"
VIDEO_DID = "did:web:video.bsky.app"
SECRET_NAME = "bluesky"
MAX_GRAPHEMES = 300
MAX_BYTES = 3000
MAX_VIDEO = 300_000_000
POLL = 2.0            # seconds between job status checks
POLL_LIMIT = 15 * 60  # give up on processing after this long
EARLY = 5 * 60        # a post may go out at most this long before its planned time
APP_PASSWORD = re.compile(r"^[a-z0-9]{4}(-[a-z0-9]{4}){3}$")
_wait = time.sleep    # tests replace this


# ---------- stored credentials ----------

def _path() -> Path:
    return SECRETS / f"{SECRET_NAME}.bin"


def _load() -> dict | None:
    p = _path()
    if not p.exists():
        return None
    return json.loads(_unprotect(p.read_bytes()).decode("utf-8"))


def _save(creds: dict) -> None:
    _write_secret(_path(), _protect(json.dumps(creds).encode("utf-8"), SECRET_NAME))


def status() -> dict:
    try:
        creds = _load()
    except Exception as err:  # unreadable or from another Windows user: say so, never raise
        return {"connected": False, "account": None, "error": str(err) or "the stored Bluesky sign-in could not be read; connect again"}
    if not creds:
        return {"connected": False, "account": None, "error": None}
    account = "@" + (creds.get("account") or creds.get("handle") or "")
    if creds.get("kind") == "oauth":
        if oauth.ran_out(creds):
            return {"connected": False, "account": account, "error": oauth.RAN_OUT, "via": "signin"}
        until = datetime.fromtimestamp(oauth.until(creds), timezone.utc).isoformat(timespec="minutes")
        return {"connected": True, "account": account, "error": None, "via": "signin", "until": until}
    return {"connected": True, "account": account, "error": None}


def start_signin(fields: dict, port: int) -> dict:
    """{"url"}: Bluesky's sign-in page for this account (or any account when no handle is given)."""
    return oauth.start(str((fields or {}).get("handle") or ""), port)


def finish_signin(params: dict, port: int) -> dict:
    """The browser came back from Bluesky: check it, keep the session (replacing an app password), report."""
    _save(oauth.finish(params, port))
    return status()


def disconnect() -> None:
    _path().unlink(missing_ok=True)


# ---------- HTTP ----------

def _http(method: str, url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: int = 120):
    try:
        return _call(method, url, data=data, headers=headers, timeout=timeout)
    except OSError as err:  # no network, DNS, TLS, timeout
        raise RuntimeError(f"could not reach Bluesky ({getattr(err, 'reason', err)}); check the internet connection") from err


def _xrpc_error(status: int, body: bytes) -> str:
    j = _json(body)
    err, msg = j.get("error") or "", j.get("message") or ""
    return f"Bluesky {status}: {err}{' - ' if err and msg else ''}{msg}".rstrip(": ")


def _normal_handle(raw: str) -> str:
    h = (raw or "").strip().lstrip("@").strip()
    if h and "@" not in h and "." not in h and not h.startswith("did:"):
        h += ".bsky.social"  # "tsumagoi" means tsumagoi.bsky.social
    return h.lower() if "@" not in h else h


def _jwt_scope(token: str) -> str | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("scope")
    except Exception:
        return None


def _session(identifier: str, password: str) -> dict:
    status_, _, body = _http("POST", f"{ENTRYWAY}/xrpc/com.atproto.server.createSession",
                             data=json.dumps({"identifier": identifier, "password": password}).encode("utf-8"),
                             headers={"content-type": "application/json"})
    if status_ in (400, 401):
        raise ValueError("Bluesky did not accept that handle and app password. Check the handle, "
                         "or make a new app password in Settings › Privacy and security › App passwords.")
    if status_ == 429:
        raise RuntimeError("Bluesky says too many sign-ins in a short time; wait a few minutes and try again")
    if status_ != 200:
        raise RuntimeError(_xrpc_error(status_, body))
    j = _json(body)
    if not j.get("accessJwt") or not j.get("did"):
        raise RuntimeError("Bluesky signed in but returned no session")
    return j


def _pds(session: dict) -> str:
    for s in (session.get("didDoc") or {}).get("service") or []:
        if str(s.get("id", "")).endswith("#atproto_pds") and s.get("serviceEndpoint"):
            return str(s["serviceEndpoint"]).rstrip("/")
    return ENTRYWAY


def connect(fields: dict) -> dict:
    handle = _normal_handle(str(fields.get("handle") or ""))
    password = str(fields.get("app_password") or "").strip().lower()
    if not handle:
        raise ValueError("Enter your Bluesky handle, for example tsumagoi.bsky.social")
    if not password:
        raise ValueError("Enter an app password from Settings › Privacy and security › App passwords")
    if not APP_PASSWORD.match(password):
        raise ValueError("That is not an app password (they look like xxxx-xxxx-xxxx-xxxx). "
                         "Do not use your account password; make an app password in Settings › Privacy and security › App passwords.")
    s = _session(handle, password)
    if _jwt_scope(s["accessJwt"]) == "com.atproto.access":
        raise ValueError("That is your account password, not an app password. "
                         "Make an app password in Settings › Privacy and security › App passwords.")
    _save({"handle": handle, "app_password": password, "did": s["did"], "account": s.get("handle") or handle, "pds": _pds(s)})
    return status()


# ---------- text: length, links, hashtags ----------

def _extends(prev: str, c: str, ri_run: int) -> bool:
    """Does `c` belong to the grapheme cluster that `prev` is part of?"""
    o = ord(c)
    if prev == "\r" and c == "\n":
        return True
    if prev == "‍":  # zero width joiner: the next symbol is part of the same emoji
        return True
    if unicodedata.category(c) in ("Mn", "Me", "Mc") or c == "‍":
        return True
    if 0xFE00 <= o <= 0xFE0F or 0xE0100 <= o <= 0xE01EF or 0xE0020 <= o <= 0xE007F:
        return True  # variation selectors, emoji tag sequences
    if 0x1F3FB <= o <= 0x1F3FF:
        return True  # skin tones
    if 0x1160 <= o <= 0x11FF or 0xD7B0 <= o <= 0xD7FF:
        return True  # Hangul vowel and final jamo
    if 0x1F1E6 <= o <= 0x1F1FF and ri_run % 2 == 1:
        return True  # second regional indicator of a flag
    return False


def graphemes(text: str) -> int:
    n, prev, ri = 0, "", 0
    for c in text:
        if not prev or not _extends(prev, c, ri):
            n += 1
        ri = ri + 1 if 0x1F1E6 <= ord(c) <= 0x1F1FF else 0
        prev = c
    return n


_URL_CHARS = r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]"
URL = re.compile(rf"https?://{_URL_CHARS}+")
BARE = re.compile(r"(?<![A-Za-z0-9@/.\-])(?:[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?\.)+"
                  r"(?:com|net|org|jp|app|dev|io|co|info|me|social)(?![A-Za-z0-9\-])"
                  rf"(?:/{_URL_CHARS}*)?")
TAG = re.compile(r"(?:^|(?<=\s))[#＃]([^\s#＃]+)")
TRAIL = ".,;:!?'\"。、！？」』）】"


def _trim(s: str) -> str:
    s = s.rstrip(TRAIL)
    while s.endswith(")") and s.count("(") < s.count(")"):
        s = s[:-1].rstrip(TRAIL)
    return s


def _byte_slice(text: str, start: int, end: int) -> dict:
    b = len(text[:start].encode("utf-8"))
    return {"byteStart": b, "byteEnd": b + len(text[start:end].encode("utf-8"))}


def facets(text: str) -> list[dict]:
    """Link facets for every URL (with or without https://) and tag facets for every #hashtag."""
    out, taken = [], []
    for rx in (URL, BARE):
        for m in rx.finditer(text):
            s, e = m.start(), m.start() + len(_trim(m.group(0)))
            if e <= s or any(s < te and ts < e for ts, te in taken):
                continue
            raw = text[s:e]
            uri = raw if raw.lower().startswith(("http://", "https://")) else "https://" + raw
            if "." not in urllib.parse.urlsplit(uri).netloc:
                continue
            taken.append((s, e))
            out.append({"index": _byte_slice(text, s, e), "features": [{"$type": "app.bsky.richtext.facet#link", "uri": uri}]})
    for m in TAG.finditer(text):
        tag = _trim(m.group(1))
        s = m.start()
        e = m.start(1) + len(tag)
        if not tag or tag.isdigit() or graphemes(tag) > 64 or any(s < te and ts < e for ts, te in taken):
            continue
        out.append({"index": _byte_slice(text, s, e), "features": [{"$type": "app.bsky.richtext.facet#tag", "tag": tag}]})
    return sorted(out, key=lambda f: f["index"]["byteStart"])


def _langs(text: str) -> list[str]:
    ja = bool(re.search(r"[぀-ヿ㐀-鿿]", text))
    en = bool(re.search(r"[A-Za-z]{3,}", re.sub(r"https?://\S+|#\S+", "", text)))
    return (["ja"] if ja else []) + (["en"] if en or not ja else [])


def check_text(text: str) -> None:
    n = graphemes(text)
    if n > MAX_GRAPHEMES:
        raise RuntimeError(f"Bluesky posts can be at most {MAX_GRAPHEMES} characters; this text is {n}. Shorten it and try again.")
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise RuntimeError(f"Bluesky posts can be at most {MAX_BYTES} bytes; shorten the text and try again.")


# ---------- the post ----------

def _aspect(video: Path) -> dict | None:
    try:
        from studio.media import probe_video

        info = probe_video(video)
        w, h = int(info.get("width") or 0), int(info.get("height") or 0)
        return {"width": w, "height": h} if w > 0 and h > 0 else None
    except Exception:
        return None


def _service_token(pds: str, call, aud: str, lxm: str) -> str:
    q = urllib.parse.urlencode({"aud": aud, "lxm": lxm, "exp": int(time.time()) + 30 * 60})
    status_, _, body = call("GET", f"{pds}/xrpc/com.atproto.server.getServiceAuth?{q}")
    if status_ != 200 or not _json(body).get("token"):
        raise RuntimeError(_xrpc_error(status_, body) + " (could not get a video upload permit)")
    return _json(body)["token"]


def _check_limits(pds: str, call) -> None:
    try:
        token = _service_token(pds, call, VIDEO_DID, "app.bsky.video.getUploadLimits")
        status_, _, body = _http("GET", f"{VIDEO}/xrpc/app.bsky.video.getUploadLimits", headers={"authorization": f"Bearer {token}"})
    except RuntimeError:
        return  # the check is a courtesy; the upload itself will say what is wrong
    j = _json(body)
    if status_ == 200 and j.get("canUpload") is False:
        why = j.get("message") or j.get("error") or "the daily video limit is used up, or the account email is not verified"
        raise RuntimeError(f"Bluesky will not take a video from this account right now: {why}")


def _job(j: dict) -> dict:
    return j.get("jobStatus") if isinstance(j.get("jobStatus"), dict) else j


def _upload(video: Path, did: str, pds: str, call) -> dict:
    host = urllib.parse.urlsplit(pds).netloc
    token = _service_token(pds, call, f"did:web:{host}", "com.atproto.repo.uploadBlob")
    data = video.read_bytes()
    q = urllib.parse.urlencode({"did": did, "name": video.name})
    print(f"STAGE 1/2 sending {video.name} to Bluesky", flush=True)
    status_, _, body = _http("POST", f"{VIDEO}/xrpc/app.bsky.video.uploadVideo?{q}", data=data, timeout=900,
                             headers={"authorization": f"Bearer {token}", "content-type": "video/mp4", "content-length": str(len(data))})
    job = _job(_json(body))
    if job.get("blob"):
        return job["blob"]
    if not job.get("jobId"):
        msg = _xrpc_error(status_, body)
        if status_ in (401, 403):
            msg += " (make sure the account email is verified in Bluesky settings)"
        raise RuntimeError(msg)
    print("STAGE 2/2 waiting for Bluesky to process the video", flush=True)
    started = time.monotonic()
    while True:
        status_, _, body = _http("GET", f"{VIDEO}/xrpc/app.bsky.video.getJobStatus?{urllib.parse.urlencode({'jobId': job['jobId']})}")
        js = _job(_json(body))
        if js.get("blob"):  # done, or "already_exists" with the earlier blob
            return js["blob"]
        if js.get("state") == "JOB_STATE_FAILED" or (status_ != 200 and status_ < 500):
            why = js.get("message") or js.get("error") or _xrpc_error(status_, body)
            raise RuntimeError(f"Bluesky could not process the video: {why}")
        if js.get("state") == "JOB_STATE_COMPLETED":
            raise RuntimeError("Bluesky finished the video but returned no file reference; try again")
        if time.monotonic() - started > POLL_LIMIT:
            raise RuntimeError("Bluesky is still processing the video after 15 minutes; try again later")
        if js.get("progress") is not None:
            print(f"PROGRESS {js.get('progress')}/100 {js.get('state', '')}", flush=True)
        _wait(POLL)


def post(video: Path, text: str, at: datetime | None = None) -> dict:
    video = Path(video)
    check_text(text)
    if at is not None:
        when = at if at.tzinfo else at.astimezone()
        if when.timestamp() - time.time() > EARLY:
            raise RuntimeError("Bluesky cannot hold a post until later; the studio posts it at the planned time")
    if not video.exists():
        raise RuntimeError(f"the video {video.name} is missing; render the reel first")
    if video.stat().st_size > MAX_VIDEO:
        raise RuntimeError("Bluesky takes videos up to 300 MB; this file is larger")
    try:
        creds = _load()
    except Exception as err:
        raise RuntimeError(f"the stored Bluesky sign-in could not be read ({err}); connect again") from err
    if not creds:
        raise RuntimeError("Bluesky is not connected")
    if creds.get("kind") == "oauth":
        # Signed in on Bluesky's page: every request to the account's server carries the session's DPoP proof.
        oauth.fresh(creds, _save)
        did, pds, handle = creds["did"], creds["pds"], creds.get("handle") or creds["did"]
        call = lambda method, url, **kw: oauth.pds_request(creds, method, url, save=_save, **kw)
    else:
        try:
            s = _session(creds["handle"], creds["app_password"])
        except ValueError as err:
            raise RuntimeError("Bluesky no longer accepts the stored app password; connect Bluesky again") from err
        did, access, pds = s["did"], s["accessJwt"], _pds(s)
        handle = s.get("handle") or creds.get("account") or creds["handle"]

        def call(method, url, *, data=None, headers=None, timeout=120):
            return _http(method, url, data=data, headers={**(headers or {}), "authorization": f"Bearer {access}"}, timeout=timeout)
    _check_limits(pds, call)
    blob = _upload(video, did, pds, call)
    embed = {"$type": "app.bsky.embed.video", "video": blob}
    ratio = _aspect(video)
    if ratio:
        embed["aspectRatio"] = ratio
    record = {
        "$type": "app.bsky.feed.post",
        "text": text,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "langs": _langs(text),
        "embed": embed,
    }
    f = facets(text)
    if f:
        record["facets"] = f
    status_, _, body = call("POST", f"{pds}/xrpc/com.atproto.repo.createRecord",
                            data=json.dumps({"repo": did, "collection": "app.bsky.feed.post", "record": record}).encode("utf-8"),
                            headers={"content-type": "application/json"})
    uri = _json(body).get("uri") if status_ == 200 else None
    if not uri:
        raise RuntimeError(_xrpc_error(status_, body) + " (the post was not created)")
    rkey = uri.rsplit("/", 1)[-1]
    return {"url": f"https://bsky.app/profile/{handle}/post/{rkey}", "remote_id": uri, "scheduled": False}
