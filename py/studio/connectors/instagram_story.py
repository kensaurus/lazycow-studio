"""
FILE: py/studio/connectors/instagram_story.py
PURPOSE: Send a finished reel to the Instagram account linked to the Facebook Page as an Instagram Story (it shows
         for 24 hours), through the Instagram API with Facebook Login.
OVERVIEW: No sign-in of its own: it uses the Facebook connection's Page token, which must also carry instagram_basic
          and instagram_content_publish (Facebook's sign-in asks for both; an older connection needs "Connect" once
          more). Stories cannot be scheduled through the API, so the studio queues them and sends each at its time
          (studio.publish run_due, every minute), like Bluesky.
DEPENDENCIES: studio.connectors.facebook (token, HTTP helpers)
TECHNICAL DETAILS (read 2026-11-16):
  Content publishing: https://developers.facebook.com/documentation/instagram-platform/content-publishing
  Resumable upload:   https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads
  0. GET /{page-id}?fields=instagram_business_account{id,username}  -> the Instagram account id
  1. POST graph.facebook.com/{ig-id}/media  media_type=STORIES, upload_type=resumable  -> {id, uri}
  2. POST {uri} (rupload.facebook.com/ig-api-upload/...)  Authorization: OAuth <token>, offset: 0,
     file_size: <bytes>, body = the file  -> {success: true}
  3. GET /{container-id}?fields=status_code  until FINISHED (EXPIRED / ERROR stop it); about once a minute, at most 5 min
  4. POST /{ig-id}/media_publish  creation_id=<container-id>  -> {id: <media id>}
  Needs a Page token with instagram_basic, instagram_content_publish and pages_read_engagement.
  Limit: 100 API-published posts per account in a moving 24 hours (POST media_publish).
NOTES: A story takes no caption; the post text is not sent. The token never appears in an error message.
"""
from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path

from studio.connectors import facebook as fb

NAME = "Instagram Stories"
HOW = ("Uses your Facebook connection: the Instagram professional account linked to the Facebook Page. Connect "
       "Facebook again and allow instagram_basic and instagram_content_publish. Each story shows for 24 hours.")
FIELDS: list[dict] = []
LINKS = [{"label": "Link Instagram to the Page (Meta Business Suite)", "url": "https://business.facebook.com/latest/settings/instagram_account"}]
can_schedule = False  # the API cannot hold a story's time: the studio sends it then
POLL_S, POLL_MAX_S = 10, 300


def _creds() -> dict:
    try:
        creds = fb._load()
    except Exception as err:
        raise RuntimeError(f"the stored Facebook token could not be read ({err}); connect Facebook again") from err
    if not creds or not creds.get("token"):
        raise RuntimeError("Facebook is not connected: Accounts › Facebook › Connect (Instagram Stories use that connection)")
    return creds


def account(creds: dict | None = None) -> dict:
    """{id, username} of the Instagram account linked to the Page, or a RuntimeError saying what is missing."""
    creds = creds or _creds()
    code, data, body = fb._get(str(creds.get("page_id") or ""), creds["token"], fields="instagram_business_account{id,username}")
    if code != 200:
        raise RuntimeError(fb._fb_error(code, body))
    ig = data.get("instagram_business_account") or {}
    if not ig.get("id"):
        raise RuntimeError("Facebook does not show an Instagram account for this Page: link the Instagram professional account "
                           "to the Page in Meta Business Suite, then connect Facebook again and allow instagram_basic and "
                           "instagram_content_publish")
    return {"id": str(ig["id"]), "username": ig.get("username") or ""}


def status() -> dict:
    try:
        ig = account()
    except RuntimeError as err:
        return {"connected": False, "account": None, "error": str(err)}
    return {"connected": True, "account": f"@{ig['username']}" if ig["username"] else ig["id"], "error": None}


def connect(fields: dict) -> dict:
    raise RuntimeError("Instagram Stories have no sign-in of their own: connect Facebook (Accounts › Facebook) and allow the Instagram permissions")


def disconnect() -> None:
    """Nothing of its own is stored: disconnecting Facebook stops it."""


def post(video: Path, text: str = "", at: datetime | None = None) -> dict:
    video = Path(video)
    if not video.exists():
        raise RuntimeError(f"the video {video.name} is missing; render the reel first")
    creds = _creds()
    token = creds["token"]
    ig = account(creds)

    print("STAGE 1/4 asking Instagram for an upload slot", flush=True)
    code, start, body = fb._post_form(f"{ig['id']}/media", token, {"media_type": "STORIES", "upload_type": "resumable"})
    container, uri = str(start.get("id") or ""), start.get("uri")
    if code != 200 or not container or not uri:
        raise RuntimeError(fb._fb_error(code, body).replace("Facebook", "Instagram", 1))

    print(f"STAGE 2/4 uploading {video.name}", flush=True)
    data = video.read_bytes()
    code, _, body = fb._http("POST", uri, data=data, timeout=900, headers={
        "authorization": f"OAuth {token}", "offset": "0", "file_size": str(len(data)), "content-type": "application/octet-stream"})
    if code != 200 or not fb._json(body).get("success"):
        raise RuntimeError(fb._fb_error(code, body).replace("Facebook", "Instagram", 1) + " (the upload did not finish)")

    print("STAGE 3/4 waiting for Instagram to process the video", flush=True)
    waited, state = 0, ""
    while waited <= POLL_MAX_S:
        code, st, _ = fb._get(container, token, fields="status_code,status")
        state = str(st.get("status_code") or "")
        if state == "FINISHED":
            break
        if state in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"Instagram could not process the video ({st.get('status') or state}); check the file (9:16, under 60 s)")
        time.sleep(POLL_S)
        waited += POLL_S
    if state != "FINISHED":
        raise RuntimeError("Instagram was still processing the video after 5 minutes; the next run tries again")

    print("STAGE 4/4 publishing the story", flush=True)
    code, done, body = fb._post_form(f"{ig['id']}/media_publish", token, {"creation_id": container})
    media = str(done.get("id") or "")
    if code != 200 or not media:
        raise RuntimeError(fb._fb_error(code, body).replace("Facebook", "Instagram", 1) + " (uploaded but not published)")
    url = f"https://www.instagram.com/stories/{ig['username']}/" if ig["username"] else ""
    try:
        c2, m, _ = fb._get(media, token, fields="permalink")
        url = (m.get("permalink") if c2 == 200 else None) or url
    except RuntimeError:
        pass
    return {"url": url, "remote_id": media, "scheduled": False}
