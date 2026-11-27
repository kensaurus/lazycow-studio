"""
FILE: py/studio/connectors/instagram_reel.py
PURPOSE: Send a finished reel to the Instagram account linked to the Facebook Page as an Instagram Reel, with its
         post text as the caption, through the Instagram API with Facebook Login. Network key "instagram" (the
         planner's and the page's Instagram Reels channel, shared/channels.json).
OVERVIEW: No sign-in of its own: it uses the Facebook connection's Page token, which must also carry instagram_basic
          and instagram_content_publish (Facebook's sign-in asks for both). Reels cannot be scheduled through the API,
          so the studio queues them and sends each at its time (studio.publish run_due, every minute), like Stories.
          Only while that works does Instagram count as a network the studio posts to: until then status() says
          "not connected" with the reason, and studio.publish.connections() leaves Instagram out (LISTED_ONLY_CONNECTED), so the page
          keeps Instagram as before (a reminder; you upload it in the Instagram app).
          Trial reels (shown to non-followers first): Settings › Accounts › Instagram, saved per project in
          networks.json "igTrial" (true / false; unset = on for an account under TRIAL_UNDER followers). A trial reel is
          sent with trial_params {"graduation_strategy": "SS_PERFORMANCE"}: Instagram shares it with the followers too
          when it does well.
DEPENDENCIES: studio.connectors.facebook (token, HTTP helpers), studio.config (DATA: networks.json)
TECHNICAL DETAILS (read 2026-11-27):
  IG User Media, updated 2026-09-28:
    https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
  Content Publishing, updated 2026-10-20:
    https://developers.facebook.com/documentation/instagram-platform/content-publishing
  IG User Content Publishing Limit, updated 2024-07-23:
    https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
  0. GET /{page-id}?fields=instagram_business_account{id,username,followers_count}  -> the Instagram account
  1. POST graph.facebook.com/{ig-id}/media  media_type=REELS, upload_type=resumable, caption,
     share_to_feed=true (Feed and Reels tabs) -- or, for a trial reel, trial_params={"graduation_strategy":
     "SS_PERFORMANCE"} (REELS only; "trial reels are only shared to non-followers", so share_to_feed is not sent with
     it)  -> {id, uri}
  2. POST {uri} (rupload.facebook.com/ig-api-upload/...)  Authorization: OAuth <token>, offset: 0,
     file_size: <bytes>, body = the file  -> {success: true}
  3. GET /{container-id}?fields=status_code  until FINISHED (EXPIRED / ERROR stop it). Meta recommends once a minute
     for at most 5 minutes; this asks every POLL_S seconds for at most POLL_MAX_S.
  4. POST /{ig-id}/media_publish  creation_id=<container-id>  -> {id: <media id>}; GET /{media-id}?fields=permalink
  Before 1: GET /{ig-id}/content_publishing_limit?fields=quota_usage,config  -> data[{quota_usage, config{quota_total,
     quota_duration}}]: a used-up day is said in plain words instead of being tried (the reference says quota_total is
     currently 50; Meta's publishing overview says 100 a day).
  Reels: MP4/MOV, H.264/HEVC, 23-60 fps, 3 s to 15 min, 300 MB at most. Caption: 2,200 characters, 30 hashtags,
     20 @tags at most. thumb_offset (ms) / cover_url are left out: the cover is the first frame, the reel's hook.
  Permissions: instagram_basic, instagram_content_publish, pages_read_engagement. Whether the token carries
     instagram_content_publish is read with debug_token when the owner's Meta app is saved (studio.netcheck does the
     same), else the publishing-limit call is asked (it answers a permission error without it).
NOTES: The token never appears in an error message. The 10-minute cache keeps the Accounts page from asking Facebook
       every time it is drawn.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

from studio.connectors import facebook as fb

NAME = "Instagram Reels"
HOW = ("Uses your Facebook connection: the Instagram professional account linked to the Facebook Page. Connect "
       "Facebook again and allow instagram_basic and instagram_content_publish. Without them you upload reels in the "
       "Instagram app, as before.")
FIELDS: list[dict] = []
LINKS = [{"label": "Link Instagram to the Page (Meta Business Suite)", "url": "https://business.facebook.com/latest/settings/instagram_account"}]
can_schedule = False  # the API cannot hold a reel's time: the studio sends it then
LISTED_ONLY_CONNECTED = True  # left out of connections() until it works: Instagram then stays a by-hand network
POLL_S, POLL_MAX_S = 20, 300
MAX_MB = 300
MAX_CHARS, MAX_TAGS = 2200, 30
TRIAL_UNDER = 1000    # followers: under this, trial reels are on unless the person switched them off
TRIAL = {"graduation_strategy": "SS_PERFORMANCE"}
PUBLISH_PERM = "instagram_content_publish"
_CACHE_S = 600.0
_PERM: dict[str, tuple[float, str | None]] = {}  # token -> (when asked, why it cannot publish or None)


def _creds() -> dict:
    try:
        creds = fb._load()
    except Exception as err:
        raise RuntimeError(f"the stored Facebook token could not be read ({err}); connect Facebook again") from err
    if not creds or not creds.get("token"):
        raise RuntimeError("Facebook is not connected: Accounts › Facebook › Connect (Instagram reels use that connection)")
    return creds


def _ig(text: str) -> str:
    return text.replace("Facebook", "Instagram", 1)


def account(creds: dict | None = None) -> dict:
    """{id, username, followers} of the Instagram account linked to the Page, or a RuntimeError saying what is missing."""
    creds = creds or _creds()
    code, data, body = fb._get(str(creds.get("page_id") or ""), creds["token"], fields="instagram_business_account{id,username,followers_count}")
    if code != 200:
        raise RuntimeError(fb._fb_error(code, body))
    ig = data.get("instagram_business_account") or {}
    if not ig.get("id"):
        raise RuntimeError("Facebook does not show an Instagram account for this Page: link the Instagram professional account "
                           "to the Page in Meta Business Suite, then connect Facebook again and allow instagram_basic and "
                           "instagram_content_publish")
    n = ig.get("followers_count")
    return {"id": str(ig["id"]), "username": ig.get("username") or "", "followers": int(n) if isinstance(n, (int, float)) else None}


def _publish_problem(creds: dict, ig_id: str, now: float | None = None) -> str | None:
    """Why this Page token cannot publish to Instagram, or None. debug_token with the owner's Meta app when it is saved
    (it lists the token's scopes); else the publishing-limit call, which a token without the permission is refused."""
    token = creds["token"]
    now = time.monotonic() if now is None else now
    hit = _PERM.get(token)
    if hit and now - hit[0] < _CACHE_S:
        return hit[1]
    missing = (f"the Facebook connection does not carry {PUBLISH_PERM}, so reels are uploaded by hand: add it to your Meta "
               "app (Use cases › Customize › Permissions), then Accounts › Facebook › Connect again and allow it")
    problem = None
    app = fb.app()
    scopes = None
    if app:
        code, data, _ = fb._get("debug_token", f"{app[0]}|{app[1]}", input_token=token)
        d = data.get("data") if isinstance(data, dict) else None
        if code == 200 and isinstance(d, dict) and isinstance(d.get("scopes"), list):
            scopes = set(d["scopes"])
    if scopes is not None:
        problem = None if PUBLISH_PERM in scopes else missing
    else:
        code, data, _ = fb._get(f"{ig_id}/content_publishing_limit", token, fields="quota_usage")
        err = data.get("error") if isinstance(data.get("error"), dict) else {}
        c = err.get("code")
        if code != 200 and (c in (10, 200) or (isinstance(c, int) and 200 <= c < 300)):
            problem = missing
    _PERM[token] = (now, problem)
    return problem


def trial_setting() -> bool | None:
    """This project's choice (networks.json "igTrial"): True, False, or None when never chosen."""
    from studio import config

    try:
        v = json.loads((Path(config.DATA) / "networks.json").read_text(encoding="utf-8")).get("igTrial")
    except (OSError, ValueError, AttributeError):
        return None
    return v if isinstance(v, bool) else None


def trial_on(followers: int | None, setting: bool | None) -> bool:
    """Trial reels: the person's choice when made; else on for a small account (under TRIAL_UNDER followers, or an
    unknown count: a new account is the one that needs people who do not follow it yet)."""
    if setting is not None:
        return setting
    return followers is None or followers < TRIAL_UNDER


def status() -> dict:
    try:
        stored = fb._load()
    except Exception:
        stored = {"token": "unreadable"}
    if not stored or not stored.get("token"):
        return {"connected": False, "account": None, "error": None}
    try:
        creds = _creds()
        ig = account(creds)
        why = _publish_problem(creds, ig["id"])
    except RuntimeError as err:
        return {"connected": False, "account": None, "error": str(err)}
    name = f"@{ig['username']}" if ig["username"] else ig["id"]
    if why:
        return {"connected": False, "account": name, "error": why}
    setting = trial_setting()
    return {"connected": True, "account": name, "error": None, "via": "facebook", "followers": ig["followers"],
            "trial": trial_on(ig["followers"], setting), "trialSet": setting, "trialUnder": TRIAL_UNDER}


def connect(fields: dict) -> dict:
    raise RuntimeError("Instagram reels have no sign-in of their own: connect Facebook (Accounts › Facebook) and allow the Instagram permissions")


def disconnect() -> None:
    """Nothing of its own is stored: disconnecting Facebook stops it."""


def caption(text: str) -> str:
    """The post text as Instagram takes it: hashtags after the 30th are left out, and a text over 2,200 characters is
    cut at the last space before the limit."""
    out, tags = [], 0
    for tok in re.split(r"(\s+)", text or ""):
        if re.fullmatch(r"#\w[\w-]*", tok or ""):
            tags += 1
            if tags > MAX_TAGS:
                continue
        out.append(tok)
    s = re.sub(r"[ \t]+(\n|$)", r"\1", "".join(out)).strip()
    if len(s) > MAX_CHARS:
        cut = s[:MAX_CHARS]
        s = (cut.rsplit(None, 1)[0] if re.search(r"\s", cut) else cut).rstrip()
    return s


def _quota_left(ig_id: str, token: str) -> str | None:
    """A plain sentence when today's API posts are used up; None otherwise (or when Instagram does not say)."""
    try:
        code, data, _ = fb._get(f"{ig_id}/content_publishing_limit", token, fields="quota_usage,config")
    except RuntimeError:
        return None
    row = (data.get("data") or [{}])[0] if code == 200 else {}
    used, total = row.get("quota_usage"), (row.get("config") or {}).get("quota_total")
    if isinstance(used, int) and isinstance(total, int) and total and used >= total:
        return (f"Instagram's limit of {total} API posts in 24 hours is used ({used}); the reel was not sent. "
                "Book it again tomorrow, or post it in the Instagram app")
    return None


def post(video: Path, text: str = "", at: datetime | None = None) -> dict:
    video = Path(video)
    if not video.exists():
        raise RuntimeError(f"the video {video.name} is missing; render the reel first")
    size = video.stat().st_size
    if size > MAX_MB * 1024 * 1024:
        raise RuntimeError(f"Instagram takes reels up to {MAX_MB} MB; {video.name} is {size / 1048576:.0f} MB")
    creds = _creds()
    token = creds["token"]
    ig = account(creds)
    full = _quota_left(ig["id"], token)
    if full:
        raise RuntimeError(full)
    trial = trial_on(ig["followers"], trial_setting())
    form = {"media_type": "REELS", "upload_type": "resumable", "caption": caption(text)}
    if trial:
        form["trial_params"] = json.dumps(TRIAL)
    else:
        form["share_to_feed"] = "true"

    print(f"STAGE 1/4 asking Instagram for an upload slot{' (trial reel)' if trial else ''}", flush=True)
    code, start, body = fb._post_form(f"{ig['id']}/media", token, form)
    container, uri = str(start.get("id") or ""), start.get("uri")
    if code != 200 or not container or not uri:
        raise RuntimeError(_ig(fb._fb_error(code, body)))

    print(f"STAGE 2/4 uploading {video.name}", flush=True)
    data = video.read_bytes()
    code, _, body = fb._http("POST", uri, data=data, timeout=900, headers={
        "authorization": f"OAuth {token}", "offset": "0", "file_size": str(len(data)), "content-type": "application/octet-stream"})
    if code != 200 or not fb._json(body).get("success"):
        raise RuntimeError(_ig(fb._fb_error(code, body)) + " (the upload did not finish)")

    print("STAGE 3/4 waiting for Instagram to process the reel", flush=True)
    waited, state = 0, ""
    while waited <= POLL_MAX_S:
        code, st, _ = fb._get(container, token, fields="status_code,status")
        state = str(st.get("status_code") or "")
        if state == "FINISHED":
            break
        if state in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"Instagram could not process the reel ({st.get('status') or state}); check the file (9:16, 3 s to 15 min, 23-60 fps)")
        time.sleep(POLL_S)
        waited += POLL_S
    if state != "FINISHED":
        raise RuntimeError("Instagram was still processing the reel after 5 minutes")

    print("STAGE 4/4 publishing the reel", flush=True)
    code, done, body = fb._post_form(f"{ig['id']}/media_publish", token, {"creation_id": container})
    media = str(done.get("id") or "")
    if code != 200 or not media:
        raise RuntimeError(_ig(fb._fb_error(code, body)) + " (uploaded but not published)")
    url = f"https://www.instagram.com/{ig['username']}/reels/" if ig["username"] else ""
    try:
        c2, m, _ = fb._get(media, token, fields="permalink")
        url = (m.get("permalink") if c2 == 200 else None) or url
    except RuntimeError:
        pass
    return {"url": url, "remote_id": media, "scheduled": False, "trial": trial}
