"""
FILE: py/studio/connectors/facebook.py
PURPOSE: Publish or schedule a finished reel as a Facebook Page Reel through the Graph API.
OVERVIEW: Two ways in. "Connect with Facebook": the owner's own Meta app (App ID in the project's
          data folder, App secret encrypted, both entered once) and Facebook's login window;
          the code that comes back is traded for a user token, made long-lived with the secret,
          and the Page's own non-expiring token is kept. The other way: paste a token from Graph
          API Explorer. Either way the Page token is checked against the live Graph API and
          stored encrypted with the YouTube secret helpers. A post
          opens an upload session, sends the bytes to rupload.facebook.com, then finishes it as
          published now or scheduled by Facebook itself.
DEPENDENCIES: Python stdlib, studio.youtube (HTTPS and secret helpers)
USAGE: from studio.connectors import get; get("facebook").post(Path("reel.mp4"), "text", at)
TECHNICAL DETAILS (read 2026-11-08):
  Reels Publishing API: https://developers.facebook.com/docs/video-api/guides/reels-publishing
  (samples on Graph API v27.0). Needs a Page token from a user who can do CREATE_CONTENT on the
  Page, with pages_show_list, pages_read_engagement and pages_manage_posts.
  connect: GET /{page-id}?fields=name, then GET /me?fields=id,name to make sure the token is a
           Page token for that same Page (a Page token's /me is the Page).
  Login (manual flow, https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow):
    https://www.facebook.com/v27.0/dialog/oauth?client_id&redirect_uri&state&scope&response_type=code
    -> http://localhost:<port>/oauth/facebook?code&state (or error=access_denied&error_reason=user_denied)
    -> GET graph.facebook.com/v27.0/oauth/access_token?client_id&redirect_uri&client_secret&code.
    http://localhost redirects are allowed without listing them while the app is in Development mode.
  App check on setup: GET /oauth/access_token?client_id&client_secret&grant_type=client_credentials.
  1. POST graph.facebook.com/v27.0/{page-id}/video_reels  upload_phase=start, access_token
       -> {video_id, upload_url}
  2. POST rupload.facebook.com/video-upload/v27.0/{video-id}  (the returned upload_url)
       headers Authorization: OAuth <page token>, offset: 0, file_size: <bytes>,
       Content-Type: application/octet-stream; body = the file  -> {success: true}
  3. POST graph.facebook.com/v27.0/{page-id}/video_reels  upload_phase=finish, video_id,
       video_state=PUBLISHED | SCHEDULED (+ scheduled_publish_time, unix seconds), description,
       access_token  -> {success: true}
  Then one GET /{video-id}?fields=status to catch an upload that already failed
  (video_status upload_failed / error / expired); processing continues on Facebook's side.
  Limits: a schedule must be more than 10 minutes and at most 29 days ahead; 30 API-published
  reels per Page per rolling 24 hours; reels are 3-90 s, 9:16, 540x960 minimum.
NOTES: The token travels in the POST body or an Authorization header and never in an error
       message. When `at` is under 10 minutes ahead (or past) the reel is published now.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
import urllib.parse
from datetime import datetime
from pathlib import Path

from studio.config import DATA as CONFIG
from studio.youtube import SECRETS, _call, _json, _protect, _unprotect, _write_secret

NAME = "Facebook"
HOW = ("In Graph API Explorer (any Meta app where you are an admin) add pages_show_list, pages_read_engagement, "
       "pages_manage_posts and business_management, press Generate Access Token, tick your business and your Page, and "
       "paste the token here. The studio finds the Page and keeps the Page's own token. Add the app secret once and it "
       "never expires.")
FIELDS = [
    {"key": "token", "label": "Access token", "secret": True, "placeholder": "EAA…"},
    {"key": "app_secret", "label": "App secret (optional: makes it permanent)", "secret": True, "placeholder": "App settings › Basic › App secret", "optional": True},
    {"key": "page_id", "label": "Page ID (optional: found for you)", "secret": False, "placeholder": "found from the token", "optional": True},
]
can_schedule = True
LINKS = [{"label": "Open Graph API Explorer", "url": "https://developers.facebook.com/tools/explorer/"},
         {"label": "My Meta apps (app secret)", "url": "https://developers.facebook.com/apps/"}]

VERSION = "v27.0"
GRAPH = f"https://graph.facebook.com/{VERSION}"
RUPLOAD = f"https://rupload.facebook.com/video-upload/{VERSION}"
SECRET_NAME = "facebook"
MIN_LEAD = 10 * 60          # Facebook wants a schedule more than 10 minutes ahead
MAX_LEAD = 29 * 24 * 3600   # and at most 29 days ahead
FAILED = ("upload_failed", "error", "expired")
DIALOG = f"https://www.facebook.com/{VERSION}/dialog/oauth"
PENDING_TTL = 10 * 60
APP_FIELDS = [
    {"key": "app_id", "label": "App ID", "secret": False, "placeholder": "1234567890123456"},
    {"key": "app_secret", "label": "App secret", "secret": True, "placeholder": "32 letters and digits"},
]
APP_LINK = "https://developers.facebook.com/apps/"


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


_ALIVE: dict[str, tuple[float, str | None]] = {}  # token -> (when it was asked, why Facebook refuses it)
_ALIVE_FOR = 600.0


def _token_problem(token: str) -> str | None:
    """Why Facebook refuses this token, or None. Only Facebook's own 'invalid token' (190) counts: a network error says nothing."""
    now = time.monotonic()
    hit = _ALIVE.get(token)
    if hit and now - hit[0] < _ALIVE_FOR:
        return hit[1]
    try:
        code, data, _ = _get("me", token, fields="id")
    except Exception:  # noqa: BLE001 - offline is not expired
        return None
    err = data.get("error") or {}
    problem = None if code == 200 or err.get("code") != 190 else "Facebook's sign-in has expired, so nothing can be posted there. Connect Facebook again."
    _ALIVE[token] = (now, problem)
    return problem


def status() -> dict:
    try:
        creds = _load()
    except Exception as err:
        return {"connected": False, "account": None, "error": str(err) or "the stored Facebook token could not be read; connect again"}
    if not creds:
        return {"connected": False, "account": None, "error": None}
    account = creds.get("account") or creds.get("page_id")
    problem = _token_problem(creds["token"]) if creds.get("token") else None
    if problem:
        return {"connected": False, "account": account, "error": problem}
    return {"connected": True, "account": account, "error": None}


def disconnect() -> None:
    _path().unlink(missing_ok=True)


# ---------- HTTP ----------

def _http(method: str, url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: int = 120):
    try:
        return _call(method, url, data=data, headers=headers, timeout=timeout)
    except OSError as err:
        raise RuntimeError(f"could not reach Facebook ({getattr(err, 'reason', err)}); check the internet connection") from err


def _fb_error(status: int, body: bytes) -> str:
    err = _json(body).get("error")
    if isinstance(err, dict):
        code = err.get("code")
        hint = ""
        if code == 190:
            hint = " (the token expired or was revoked; connect Facebook again with a new Page token)"
        elif code in (10, 200) or (isinstance(code, int) and 200 <= code < 300):
            hint = " (the token lacks pages_manage_posts or you are not allowed to post on this Page)"
        elif code in (4, 17, 32, 613):
            hint = " (Facebook's rate limit; try again later)"
        return f"Facebook {status}: {err.get('message', '')}{hint}".strip()
    if isinstance(err, str):
        return f"Facebook {status}: {err}"
    return f"Facebook {status}"


def _get(path: str, token: str, **params) -> tuple[int, dict, bytes]:
    q = urllib.parse.urlencode({**params, "access_token": token})
    status_, _, body = _http("GET", f"{GRAPH}/{path}?{q}")
    return status_, _json(body), body


def _post_form(path: str, token: str, form: dict) -> tuple[int, dict, bytes]:
    data = urllib.parse.urlencode({**form, "access_token": token}).encode("utf-8")
    status_, _, body = _http("POST", f"{GRAPH}/{path}", data=data, headers={"content-type": "application/x-www-form-urlencoded"})
    return status_, _json(body), body


# ---------- connect ----------

NEEDED = ("pages_show_list", "pages_read_engagement", "pages_manage_posts")
# Asked for too, not required: a Page kept in a business portfolio (Business Suite) is only listed with it;
# read_insights lets studio.perf read each reel's plays, watch time and reach (/{video-id}/video_insights).
OPTIONAL = ("business_management", "read_insights")


def _business_pages(token: str) -> list[dict]:
    """Pages the person reaches through a business portfolio, which me/accounts leaves out."""
    status_, biz, _ = _get("me/businesses", token, fields="id,name")
    out: list[dict] = []
    seen: set[str] = set()
    for b in (biz.get("data") or []) if status_ == 200 else []:
        for edge in ("owned_pages", "client_pages"):
            s_, pg, _ = _get(f"{b.get('id')}/{edge}", token, fields="id,name,access_token")
            for page in (pg.get("data") or []) if s_ == 200 else []:
                if str(page.get("id")) not in seen:
                    seen.add(str(page.get("id")))
                    out.append(page)
    return out


def _long_lived(token: str, secret: str) -> str:
    """With the app's secret, swap a short user token (about an hour) for a 60-day one; its Page token never expires."""
    status_, app, body = _get("app", token, fields="id,name")
    if status_ != 200 or not app.get("id"):
        raise ValueError("The studio could not tell which Meta app made this token. " + _fb_error(status_, body))
    q = urllib.parse.urlencode({"grant_type": "fb_exchange_token", "client_id": app["id"], "client_secret": secret, "fb_exchange_token": token})
    status_, _, body = _http("GET", f"{GRAPH}/oauth/access_token?{q}")
    got = _json(body)
    if status_ != 200 or not got.get("access_token"):
        raise ValueError(f"The app secret did not work for {app.get('name') or 'this app'}: copy it again from the app's "
                         "App settings › Basic › App secret (Show). " + _fb_error(status_, body))
    return str(got["access_token"])


def connect(fields: dict) -> dict:
    """Paste one token; the studio works out the rest: which Page, whether the permissions are there, and the
    Page's own token. The Page ID is only needed when the token manages several Pages."""
    page_id = str(fields.get("page_id") or "").strip()
    token = str(fields.get("token") or "").strip()
    secret = str(fields.get("app_secret") or "").strip()
    if not token or re.search(r"\s", token):
        raise ValueError("Paste the access token from Graph API Explorer: the long line under Access Token (it starts with EAA), with no spaces.")
    if page_id and not re.fullmatch(r"\d{5,25}", page_id):
        raise ValueError("The Page ID is only digits. Leave it empty: the studio finds your Page from the token.")
    if secret and not re.fullmatch(r"[0-9a-f]{32}", secret):
        raise ValueError("An app secret is 32 letters and digits (0-9, a-f). Leave it empty if you extended the token yourself.")
    return _connect(token, secret, page_id, login=False)


def _connect(token: str, secret: str, page_id: str, login: bool) -> dict:
    """Find the Page and keep its own token. `login`: the token came from Connect with Facebook, so a problem
    is fixed by pressing that button again (not by pasting)."""
    again = "Press Connect with Facebook again"
    status_, me, body = _get("me", token, fields="id,name")
    if status_ != 200:
        if login:
            raise RuntimeError("Facebook signed you in but then refused the sign-in. " + _fb_error(status_, body) + f" {again}.")
        raise ValueError("Facebook did not accept that token. " + _fb_error(status_, body) + " Press Generate Access Token again and paste the new one.")
    # A user token lists the Pages it manages; a Page token does not (that call fails), and is itself the Page.
    status_, acc, _ = _get("me/accounts", token, fields="id,name,access_token,tasks")
    if status_ == 200:
        status_, perms, _ = _get("me/permissions", token)
        granted = {p.get("permission") for p in perms.get("data", []) if p.get("status") == "granted"} if status_ == 200 else set(NEEDED)
        missing = [p for p in NEEDED if p not in granted]
        if missing and login:
            raise ValueError("Facebook did not give the studio permission to " + _plain_perms(missing) + f". {again} and keep "
                             "every switch on in the Facebook window (or press Edit access and allow everything).")
        if missing:
            raise ValueError(f"The token is missing {', '.join(missing)}. In Graph API Explorer add {' and '.join(missing)} under "
                             "Permissions, press Generate Access Token, allow it for your Page, and paste the new token.")
        if secret:
            token = _long_lived(token, secret)
            status_, acc, _ = _get("me/accounts", token, fields="id,name,access_token,tasks")
        pages = acc.get("data", [])
        if not pages and "business_management" in granted:
            pages = _business_pages(token)
        if not pages and login:
            raise ValueError(f"{me.get('name') or 'This account'} did not share any Facebook Page with the studio. {again} and "
                             "tick your Page when Facebook asks which Pages to use (you must be an admin of the Page).")
        if not pages:
            if "business_management" not in granted:
                raise ValueError(f"{me.get('name') or 'This account'} manages no Facebook Page this token can see. If your Page is "
                                 "in a business portfolio (you post through Business Suite), add business_management under "
                                 "Permissions in Graph API Explorer, press Generate Access Token, "
                                 "tick your business and your Page, and paste the new token.")
            raise ValueError(f"{me.get('name') or 'This account'} still sees no Facebook Page. Press Generate Access Token, "
                             "press Edit access in the Facebook window, tick your business and your Page, and paste the new token.")
        if page_id:
            page = next((p for p in pages if str(p.get("id")) == page_id), None)
            if not page:
                _, what, _ = _get(page_id, token, metadata="1", fields="name")
                kind = (what.get("metadata") or {}).get("type") or ""
                found = ", ".join(f"{p.get('name')} ({p.get('id')})" for p in pages)
                hint = f"{page_id} is your Meta app ({what.get('name')}), not a Page." if kind == "application" else f"{page_id} is not one of your Pages."
                raise ValueError(f"{hint} Your Pages: {found}. Leave Page ID empty to use the first one, or paste one of these.")
        elif len(pages) == 1:
            page = pages[0]
        elif login:
            raise ValueError("You shared several Pages: " + ", ".join(f"{p.get('name')} ({p.get('id')})" for p in pages) +
                             f". {again} and tick only the Page to post to (Edit access in the Facebook window).")
        else:
            raise ValueError("This token manages several Pages: " + ", ".join(f"{p.get('name')} ({p.get('id')})" for p in pages) +
                             ". Paste the one to post to in Page ID.")
        if "CREATE_CONTENT" not in (page.get("tasks") or ["CREATE_CONTENT"]):
            raise ValueError(f"Your role on {page.get('name')} cannot create posts. Ask the Page owner for full control, then connect again.")
        page_id, page_token, name = str(page["id"]), str(page.get("access_token") or ""), str(page.get("name") or page["id"])
        if not page_token:
            raise ValueError(f"Facebook did not give a Page token for {name}. Allow pages_manage_posts for that Page, then paste a new token.")
    else:
        # Already a Page token: it must be the Page asked for (when one was given).
        if page_id and str(me.get("id")) != page_id:
            raise ValueError(f"That is a token for {me.get('name')} ({me.get('id')}), not for Page {page_id}. Leave Page ID empty to use it.")
        page_id, page_token, name = str(me["id"]), token, str(me.get("name") or me["id"])
    status_, check, body = _get("me", page_token, fields="id,name")
    if status_ != 200 or str(check.get("id")) != page_id:
        raise ValueError("Facebook gave a Page token that does not match the Page. " + _fb_error(status_, body))
    _save({"page_id": page_id, "token": page_token, "account": name, "lasting": bool(secret), "via": "login" if login else "paste"})
    return status()


def _plain_perms(missing: list[str]) -> str:
    words = {"pages_show_list": "see your Pages", "pages_read_engagement": "read your Page", "pages_manage_posts": "post on your Page"}
    return " and ".join(words.get(p, p) for p in missing)


# ---------- Connect with Facebook (the owner's own Meta app) ----------

def _app_file() -> Path:
    return CONFIG / "facebook_app.json"


def _app_secret_path() -> Path:
    return SECRETS / "facebook_app.bin"


def app() -> tuple[str, str] | None:
    """(App ID, App secret) from .env (STUDIO_FB_APP_ID / STUDIO_FB_APP_SECRET) or the one-time setup."""
    aid, sec = os.environ.get("STUDIO_FB_APP_ID", ""), os.environ.get("STUDIO_FB_APP_SECRET", "")
    if aid and sec:
        return aid, sec
    try:
        aid = str(json.loads(_app_file().read_text(encoding="utf-8")).get("app_id") or "")
        sec = _unprotect(_app_secret_path().read_bytes()).decode("utf-8") if _app_secret_path().exists() else ""
    except (OSError, ValueError):
        return None
    return (aid, sec) if aid and sec else None


def redirect_uri(port: int) -> str:
    """Meta lets a Development-mode app return to http://localhost without listing it; 127.0.0.1 would need listing."""
    return f"http://localhost:{int(port)}/oauth/facebook"


def signin(port: int = 4317) -> dict:
    a = app()
    return {"ready": bool(a), "app": a[0] if a else None, "fields": APP_FIELDS, "link": APP_LINK, "redirect": redirect_uri(port)}


def setup(fields: dict) -> dict:
    """Keep the owner's Meta app once: App ID in the project folder, App secret encrypted. Checked with Facebook first."""
    aid = re.sub(r"\s", "", str(fields.get("app_id") or ""))
    sec = re.sub(r"\s", "", str(fields.get("app_secret") or "")).lower()
    where = "developers.facebook.com › My apps › your app › App settings › Basic"
    if not re.fullmatch(r"\d{6,25}", aid):
        raise ValueError(f"The App ID is only digits (about 15 or 16). Copy it from {where}.")
    if not re.fullmatch(r"[0-9a-f]{32}", sec):
        raise ValueError(f"The App secret is 32 letters and digits. On {where} press Show next to App secret and copy it.")
    q = urllib.parse.urlencode({"client_id": aid, "client_secret": sec, "grant_type": "client_credentials"})
    status_, _, body = _http("GET", f"{GRAPH}/oauth/access_token?{q}")
    if status_ != 200 or not _json(body).get("access_token"):
        raise ValueError(f"Facebook says this App ID and App secret do not belong together. Copy both again from {where} "
                         "(press Show next to App secret; if you pressed Reset, use the new one).")
    CONFIG.mkdir(parents=True, exist_ok=True)
    _app_file().write_text(json.dumps({"app_id": aid}, indent=2), encoding="utf-8")
    _write_secret(_app_secret_path(), _protect(sec.encode("utf-8"), "facebook_app"))
    return {"ready": True, "app": aid}


def _pending_path() -> Path:
    return SECRETS / "facebook_pending.json"


def start_signin(fields: dict, port: int) -> dict:
    """{"url"}: Facebook's login window for the owner's app, asking for the three Page permissions."""
    a = app()
    if not a:
        raise ValueError("First paste your Meta app's App ID and App secret (developers.facebook.com › My apps › your app › "
                         "App settings › Basic). It is a one-time step.")
    state = secrets.token_urlsafe(24)
    SECRETS.mkdir(parents=True, exist_ok=True)
    _pending_path().write_text(json.dumps({"state": state, "at": time.time(), "port": int(port)}), encoding="utf-8")
    q = {"client_id": a[0], "redirect_uri": redirect_uri(port), "state": state, "response_type": "code", "scope": ",".join(NEEDED + OPTIONAL)}
    return {"url": DIALOG + "?" + urllib.parse.urlencode(q)}


def _login_error(status_: int, body: bytes, port: int) -> str:
    """Meta's code-exchange errors in plain words, with the fix."""
    err = _json(body).get("error")
    err = err if isinstance(err, dict) else {"message": str(err or "")}
    msg, code, sub = str(err.get("message") or ""), err.get("code"), err.get("error_subcode")
    low = msg.lower()
    if code == 191 or "redirect_uri" in low or "redirect uri" in low or "url blocked" in low or sub == 36008:
        return ("Facebook would not send you back to the studio. In your app on developers.facebook.com open Facebook Login › "
                f"Settings and add {redirect_uri(port)} under Valid OAuth Redirect URIs (an app in Development mode allows it "
                "by itself), then press Connect with Facebook again.")
    if code in (1, 101) or "client secret" in low or "client_secret" in low:
        return ("Facebook did not accept the saved App secret (it may have been reset). Paste the App ID and App secret again "
                "under Use another Meta app, then press Connect with Facebook again.")
    if sub in (36007, 36009) or "authorization code" in low or "code has been used" in low or "expired" in low:
        return "That Facebook sign-in was already used or took too long. Press Connect with Facebook again."
    return f"Facebook did not finish the sign-in ({status_}: {msg or 'no reason given'}). Press Connect with Facebook again."


def finish_signin(params: dict, port: int) -> dict:
    """The browser came back from Facebook's login window: trade the code for a Page token and keep it."""
    p = {k: str(v or "") for k, v in (params or {}).items()}
    path = _pending_path()
    try:
        pend = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    except ValueError:
        pend = None
    path.unlink(missing_ok=True)
    if p.get("error"):
        if p.get("error") == "access_denied" or p.get("error_reason") == "user_denied":
            raise ValueError("You pressed Cancel in the Facebook window, so nothing was connected. Press Connect with Facebook again when you are ready.")
        raise ValueError(f"Facebook stopped the sign-in ({p.get('error_description') or p['error']}). Press Connect with Facebook again.")
    if not pend or not secrets.compare_digest(str(pend.get("state", "")).encode(), p.get("state", "").encode()):
        raise ValueError("This Facebook sign-in was not started from the studio, or was already used. Press Connect with Facebook again.")
    if time.time() - float(pend.get("at", 0)) > PENDING_TTL:
        raise ValueError("The Facebook sign-in took longer than 10 minutes. Press Connect with Facebook again.")
    if not p.get("code"):
        raise ValueError("Facebook came back without a sign-in code. Press Connect with Facebook again.")
    a = app()
    if not a:
        raise ValueError("The Meta app's App ID and App secret are missing; paste them again, then press Connect with Facebook.")
    used_port = int(pend.get("port") or port)
    q = urllib.parse.urlencode({"client_id": a[0], "redirect_uri": redirect_uri(used_port), "client_secret": a[1], "code": p["code"]})
    status_, _, body = _http("GET", f"{GRAPH}/oauth/access_token?{q}")
    user_token = _json(body).get("access_token") if status_ == 200 else None
    if not user_token:
        raise RuntimeError(_login_error(status_, body, used_port))
    return _connect(str(user_token), a[1], "", login=True)


# ---------- the reel ----------

def _when(at: datetime | None) -> int | None:
    """Unix time to schedule at, or None to publish now."""
    if at is None:
        return None
    ts = int((at if at.tzinfo else at.astimezone()).timestamp())
    lead = ts - time.time()
    if lead > MAX_LEAD:
        raise RuntimeError("Facebook can schedule a reel at most 29 days ahead; pick an earlier time")
    return ts if lead > MIN_LEAD else None


def delete(remote_id: str) -> None:
    """Take a reel off the Page (a scheduled one never goes out). Already gone counts as done."""
    creds = _load()
    if not creds:
        raise RuntimeError("Facebook is not connected")
    if not str(remote_id or "").isdigit():
        raise RuntimeError("no Facebook video id on this booking")
    status_, _, body = _http("DELETE", f"{GRAPH}/{remote_id}?" + urllib.parse.urlencode({"access_token": creds["token"]}))
    if status_ == 200 and _json(body).get("success"):
        return
    if status_ in (400, 404) and b"does not exist" in body:
        return
    raise RuntimeError(_fb_error(status_, body))


def post(video: Path, text: str, at: datetime | None = None) -> dict:
    video = Path(video)
    if not video.exists():
        raise RuntimeError(f"the video {video.name} is missing; render the reel first")
    _when(at)  # refuse a far-off time before sending any bytes
    try:
        creds = _load()
    except Exception as err:
        raise RuntimeError(f"the stored Facebook token could not be read ({err}); connect again") from err
    if not creds:
        raise RuntimeError("Facebook is not connected")
    page_id, token = creds["page_id"], creds["token"]

    print("STAGE 1/3 asking Facebook for an upload slot", flush=True)
    status_, start, body = _post_form(f"{page_id}/video_reels", token, {"upload_phase": "start"})
    video_id = str(start.get("video_id") or "")
    if status_ != 200 or not video_id:
        raise RuntimeError(_fb_error(status_, body))
    upload_url = start.get("upload_url") or f"{RUPLOAD}/{video_id}"

    print(f"STAGE 2/3 uploading {video.name}", flush=True)
    data = video.read_bytes()
    status_, _, body = _http("POST", upload_url, data=data, timeout=900, headers={
        "authorization": f"OAuth {token}", "offset": "0", "file_size": str(len(data)),
        "content-type": "application/octet-stream",
    })
    if status_ != 200 or not _json(body).get("success"):
        raise RuntimeError(_fb_error(status_, body) + " (the upload did not finish)")

    print("STAGE 3/3 publishing the reel", flush=True)
    ts = _when(at)  # again: the upload took time
    form = {"upload_phase": "finish", "video_id": video_id, "description": text}
    if ts:
        form.update(video_state="SCHEDULED", scheduled_publish_time=str(ts))
    else:
        form["video_state"] = "PUBLISHED"
    status_, done, body = _post_form(f"{page_id}/video_reels", token, form)
    if status_ != 200 or not done.get("success"):
        raise RuntimeError(_fb_error(status_, body) + " (the reel was uploaded but not published)")

    try:
        st_code, st, _ = _get(video_id, token, fields="status")
        vs = (st.get("status") or {}).get("video_status") if st_code == 200 else None
    except RuntimeError:
        vs = None
    if vs in FAILED:
        raise RuntimeError(f"Facebook reports the reel as '{vs}'; check the file (9:16, 3-90 s) and try again")
    return {"url": f"https://www.facebook.com/reel/{video_id}", "remote_id": video_id, "scheduled": bool(ts)}
