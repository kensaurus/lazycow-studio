"""
FILE: py/studio/netcheck.py
PURPOSE: Check every connection before a post needs it: is each sign-in still alive, does it carry every permission
         the studio uses, and what to press when it does not. Accounts › Check every connection, GET
         /api/connections/check, the MCP tool check_connections.
OVERVIEW: One entry per network in use: booked or posted in the last 30 days, or one the project uses (the page sends
          the networks Settings › Accounts counts as "in use", BL-135: the check said "No network is in use yet" under
          "6 networks in use"). Its checks, each
          {id, ok, say, fix, url}, where ok is True (fine), False (posting or a feature fails) or None (worth a look).
          - YouTube, per connected account: the sign-in refreshes, and Google's own record of the token's scopes
            (tokeninfo) has upload; comments, playlists and Analytics are features.
          - Facebook: the Page token is valid and, with the owner's Meta app, debug_token lists its permissions:
            the three posting ones are needed; read_insights, the comment pair, the Instagram pair and
            instagram_manage_insights are features. A missing one is fixed in the app's use cases, then Connect again.
          - Instagram Stories: the Instagram account linked to the Page.
          - Bluesky: connected, and when a browser sign-in (not an app password) runs out.
          - Networks the owner's Chrome posts (TikTok, X, LinkedIn, ...): whether Chrome is linked (the server says).
          - Every network: its latest post that failed or went missing in the last 14 days, unless a later one went out.
DEPENDENCIES: studio.youtube, studio.connectors (facebook, instagram_story, bluesky), studio.posting
USAGE: python -m studio.netcheck check   (request JSON on stdin: {"chrome": true|false|null, "nets": [network, ...]?})
       prints RESULT {"ok": true, "data": {...}}
TECHNICAL DETAILS (read 2026-11-18):
  Google: GET https://oauth2.googleapis.com/tokeninfo?access_token=<token> -> {scope: "a b c", expires_in}.
  Meta Graph v27.0: GET /debug_token?input_token=<page token>&access_token=<app id>|<app secret>
       -> data {is_valid, scopes[], expires_at (0 = never), type}.
       (developers.facebook.com/docs/graph-api/reference/debug_token)
NOTES: Read-only: nothing here posts, signs in or changes a connection. No token or secret is ever returned; errors
       are scrubbed the same way as studio.perf's.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

YT = "https://www.googleapis.com/auth/"
# Scope -> (what it does in the studio, needed to post?)
YT_SCOPES = {
    YT + "youtube.upload": ("upload and schedule Shorts", True),
    YT + "youtube": ("add uploads to playlists", False),
    YT + "youtube.force-ssl": ("read and answer comments", False),
    YT + "yt-analytics.readonly": ("read % watched and subscribers in Results", False),
}
# Facebook permission -> (what it does in the studio, needed to post?)
FB_PERMS = {
    "pages_show_list": ("find your Page", True),
    "pages_read_engagement": ("read your Page", True),
    "pages_manage_posts": ("post and schedule Page reels", True),
    "read_insights": ("read each reel's plays in Results", False),
    "pages_read_user_content": ("read comments on your Page", False),
    "pages_manage_engagement": ("answer comments on your Page", False),
    "instagram_basic": ("find the Instagram account linked to the Page", False),
    "instagram_content_publish": ("post Instagram Stories", False),
    "instagram_manage_insights": ("read Instagram Story numbers (they last 24 hours)", False),
    "business_management": ("find a Page kept in a business portfolio", False),
}
STUDIO_NETS = ("youtube", "facebook", "instagram-story", "bluesky")
NAMES = {"youtube": "YouTube", "facebook": "Facebook", "instagram-story": "Instagram Stories", "bluesky": "Bluesky",
         "tiktok": "TikTok", "x": "X", "linkedin": "LinkedIn", "gbp": "Google Maps", "line-oa": "LINE", "pinterest": "Pinterest",
         "threads": "Threads", "instagram": "Instagram"}
FAIL_DAYS = 14
IN_USE_DAYS = 30
# Networks the owner's Chrome posts to (server/autoplan.mjs CHROME_NETS, plus the ones the helper fills in): a network
# the project uses but never booked gets the Chrome check only if it is one of these (Instagram is posted by hand).
CHROME_POSTS = ("x", "tiktok", "gbp", "line-oa", "linkedin", "pinterest", "threads", "line-voom")
EXPIRY_WARN_DAYS = 14


def _now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def _when(at) -> datetime | None:
    if not at:
        return None
    try:
        d = datetime.fromisoformat(str(at))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=_now().tzinfo)


def _check(cid: str, ok: bool | None, say: str, fix: str = "", url: str = "") -> dict:
    return {"id": cid, "ok": ok, "say": say, "fix": fix, "url": url}


def _state(checks: list[dict]) -> str:
    if any(c["ok"] is False for c in checks):
        return "bad"
    if any(c["ok"] is None for c in checks):
        return "warn"
    return "ok"


def _scrub(text: str) -> str:
    from studio.perf import _scrub as s

    return s(str(text))


# ---------- YouTube ----------

def _yt_checks() -> tuple[list[dict], str | None]:
    from studio import youtube as y

    st = y.status()
    if not st.get("app"):
        return [_check("app", False, "No Google app is set up, so the studio cannot sign in to YouTube.",
                       "Settings › Accounts › YouTube: follow the 10-minute Google Cloud steps.")], None
    accts = y.accounts()
    if not accts:
        return [_check("signin", False, "YouTube is not connected.", "Accounts › YouTube › Connect YouTube.")], None
    out, keep = [], y.ACCOUNT
    try:
        for a in accts:
            label = a.get("channel") or a.get("id")
            y.ACCOUNT = a["id"]
            try:
                token = y.access_token()
            except Exception as err:  # noqa: BLE001 - any refusal is the finding
                out.append(_check(f"signin-{a['id']}", False, _scrub(f"{label}: the sign-in no longer works: {err}"),
                                  "Accounts › YouTube › Connect YouTube again.",
                                  "https://console.cloud.google.com/auth/audience"))
                continue
            out.append(_check(f"signin-{a['id']}", True, f"{label}: signed in."))
            status, _, body = y._call("GET", "https://oauth2.googleapis.com/tokeninfo?" + urllib.parse.urlencode({"access_token": token}))
            if status != 200:
                out.append(_check(f"scopes-{a['id']}", None, f"{label}: Google did not say which permissions the sign-in has (HTTP {status}).",
                                  "Press Check again in a minute."))
                continue
            granted = set(str(json.loads(body.decode("utf-8") or "{}").get("scope") or "").split())
            for scope, (use, needed) in YT_SCOPES.items():
                if scope in granted:
                    continue
                out.append(_check(f"scope-{a['id']}-{scope.rsplit('/', 1)[-1]}", False if needed else None,
                                  f"{label}: the sign-in cannot {use}.",
                                  "Accounts › YouTube › Connect YouTube again and tick every box Google shows."))
            if not any(c["id"].startswith(f"scope-{a['id']}") for c in out):
                out.append(_check(f"scopes-{a['id']}", True, f"{label}: every permission the studio uses is granted."))
    finally:
        y.ACCOUNT = keep
    main = next((a for a in accts if a.get("id") == "main"), accts[0])
    return out, main.get("channel") or main.get("email")


# ---------- Facebook and Instagram ----------

def _fb_checks() -> tuple[list[dict], str | None]:
    from studio.connectors import facebook as fb

    st = fb.status()
    if not st.get("connected"):
        if st.get("error"):
            return [_check("signin", False, _scrub(st["error"]), "Accounts › Facebook › Connect.")], st.get("account")
        return [_check("signin", False, "Facebook is not connected.", "Accounts › Facebook › Connect.")], None
    out = [_check("signin", True, "The Page's sign-in works.")]
    app = fb.app()
    if not app:
        out.append(_check("permissions", None, "Without your Meta app's ID and secret the studio cannot list the sign-in's permissions.",
                          "Accounts › Facebook › set up the Meta app once (App settings › Basic)."))
        return out, st.get("account")
    creds = fb._load() or {}
    # The app access token (app id|secret) asks; the Page token is the one inspected.
    code, data, _ = fb._get("debug_token", f"{app[0]}|{app[1]}", input_token=creds.get("token", ""))
    d = data.get("data") if isinstance(data, dict) else None
    if code != 200 or not isinstance(d, dict):
        out.append(_check("permissions", None, "Facebook did not say which permissions the sign-in has.", "Press Check again in a minute."))
        return out, st.get("account")
    if d.get("is_valid") is False:
        out.append(_check("valid", False, "Facebook says the sign-in is no longer valid.", "Accounts › Facebook › Connect again."))
    exp = int(d.get("expires_at") or 0)
    if exp and datetime.fromtimestamp(exp, timezone.utc) - _now() < timedelta(days=EXPIRY_WARN_DAYS):
        out.append(_check("expires", None, f"The sign-in ends {datetime.fromtimestamp(exp, timezone.utc).date().isoformat()}.",
                          "Add the App secret (Accounts › Facebook) and connect again: the Page token then has no end date."))
    granted = set(d.get("scopes") or [])
    use_cases = f"https://developers.facebook.com/apps/{app[0]}/use_cases/"
    missing = [p for p in FB_PERMS if p not in granted]
    for p in missing:
        use, needed = FB_PERMS[p]
        out.append(_check(f"perm-{p}", False if needed else None, f"Without {p} the studio cannot {use}.",
                          f"Add {p} to your Meta app (Use cases › Customize › Permissions and features › Add), then Accounts › Facebook › Connect again.",
                          use_cases))
    if not missing:
        out.append(_check("permissions", True, "Every permission the studio uses is granted."))
    return out, st.get("account")


def _ig_checks() -> tuple[list[dict], str | None]:
    from studio.connectors import instagram_story as ig

    st = ig.status()
    if st.get("connected"):
        return [_check("account", True, f"Stories go to {st.get('account')}.")], st.get("account")
    return [_check("account", False, _scrub(st.get("error") or "No Instagram account is linked to the Page."),
                   "Link the Instagram professional account to the Page in Meta Business Suite, then Accounts › Facebook › Connect again.",
                   "https://business.facebook.com/latest/settings/instagram_account")], None


def _bsky_checks() -> tuple[list[dict], str | None]:
    from studio.connectors import bluesky as bs

    st = bs.status()
    if not st.get("connected"):
        return [_check("signin", False, _scrub(st.get("error") or "Bluesky is not connected."), "Accounts › Bluesky › Sign in.")], st.get("account")
    out = [_check("signin", True, f"Signed in as {st.get('account')}" + (" with an app password." if st.get("via") != "signin" else "."))]
    until = _when(st.get("until"))
    if until and until - _now() < timedelta(days=EXPIRY_WARN_DAYS):
        out.append(_check("expires", None, f"The sign-in ends {until.date().isoformat()}; posts booked after that will not go out.",
                          "Accounts › Bluesky › Add app password: it never signs out.",
                          "https://bsky.app/settings/app-passwords"))
    out.extend(_bsky_video_checks(bs))
    return out, st.get("account")


def _bsky_video_checks(bs) -> list[dict]:
    """Can this account post a video today? Bluesky refuses video from an account whose email is not verified (the
    upload answers 401), and caps videos a day. com.atproto.server.getSession -> emailConfirmed;
    app.bsky.video.getUploadLimits -> canUpload, message (read 2026-11-18, atproto lexicons)."""
    out = []
    try:
        _did, pds, _handle, call = bs.account()
    except RuntimeError as err:
        return [_check("session", False, _scrub(str(err)), "Accounts › Bluesky › Sign in again.")]
    status, _, body = call("GET", f"{pds}/xrpc/com.atproto.server.getSession")
    sess = bs._json(body) if status == 200 else {}
    if sess.get("emailConfirmed") is False:
        out.append(_check("email", False, "The account's email is not verified, so Bluesky refuses its videos (the upload answers 401).",
                          "In Bluesky open Settings › Account › Email and verify it, then book the failed post again.",
                          "https://bsky.app/settings/account"))
    try:
        token = bs._service_token(pds, call, bs.VIDEO_DID, "app.bsky.video.getUploadLimits")
        status, _, body = bs._http("GET", f"{bs.VIDEO}/xrpc/app.bsky.video.getUploadLimits", headers={"authorization": f"Bearer {token}"})
    except RuntimeError:
        return out
    # A refusal comes as an error status with the reason in the body: 401 {canUpload: false, error: "unconfirmed_email",
    # message: "Confirm your email address to upload videos"} (seen 2026-11-18 on a new account).
    lim = bs._json(body)
    if lim.get("error") == "unconfirmed_email" and any(c["id"] == "email" for c in out):
        return out
    if lim.get("error") == "unconfirmed_email":
        out.append(_check("email", False, "The account's email is not verified, so Bluesky refuses its videos (the upload answers 401).",
                          "In Bluesky open Settings › Account › Email and verify it, then book the failed post again.",
                          "https://bsky.app/settings/account"))
    elif lim.get("canUpload") is False:
        out.append(_check("video", False, _scrub(f"Bluesky will not take a video from this account now: {lim.get('message') or lim.get('error') or 'no reason given'}."),
                          "Verify the account's email in Bluesky settings; a daily limit resets the next day."))
    elif lim.get("canUpload") is True and not out:
        left = lim.get("remainingDailyVideos")
        out.append(_check("video", True, "Bluesky takes videos from this account" + (f" ({left} left today)." if isinstance(left, int) else ".")))
    return out


# ---------- the posting log ----------

def _in_use(posts: list[dict], now: datetime) -> set[str]:
    nets = set()
    for p in posts:
        at = _when(p.get("at"))
        if p.get("network") in (None, "", "all") or not at:
            continue
        if p.get("status") in ("planned", "queued", "scheduled") and at >= now - timedelta(days=1):
            nets.add(p["network"])
        elif p.get("status") in ("posted", "failed", "missing") and at >= now - timedelta(days=IN_USE_DAYS):
            nets.add(p["network"])
    return nets


def last_failure(posts: list[dict], net: str, now: datetime) -> dict | None:
    """The newest post on this network that failed or went missing in the last FAIL_DAYS, unless a later one went out
    or that reel is booked again on this network (the fix the check itself gives)."""
    mine = sorted((p for p in posts if p.get("network") == net and _when(p.get("at"))), key=lambda p: _when(p["at"]))
    bad = None
    for p in mine:
        at = _when(p["at"])
        if at > now:
            continue
        if p.get("status") in ("failed", "missing") and at >= now - timedelta(days=FAIL_DAYS):
            bad = p
        elif p.get("status") == "posted" and bad and at > _when(bad["at"]):
            bad = None
    if bad and any(p.get("slug") == bad.get("slug") and p.get("status") in ("planned", "queued", "scheduled", "posted")
                   and _when(p["at"]) > _when(bad["at"]) for p in mine):
        return None
    return bad


def check(req: dict | None = None, posts: list[dict] | None = None) -> dict:
    req = req or {}
    now = _now()
    if posts is None:
        from studio import posting

        posts = posting.posts()
    used = _in_use(posts, now)
    asked = {n for n in (req.get("nets") or []) if isinstance(n, str) and re.fullmatch(r"[a-z0-9-]{1,40}", n)}
    nets = used | asked
    runners = {"youtube": _yt_checks, "facebook": _fb_checks, "instagram-story": _ig_checks, "bluesky": _bsky_checks}
    out = []
    for net in sorted(nets | {n for n in STUDIO_NETS if n in nets or req.get("all")}, key=lambda n: (n not in STUDIO_NETS, n)):
        if net in runners:
            try:
                checks, account = runners[net]()
            except Exception as err:  # noqa: BLE001 - one network's problem never hides the others
                checks, account = [_check("error", None, _scrub(f"The check could not finish: {type(err).__name__}: {err}"), "Press Check again.")], None
            via = "studio"
        else:
            via, account = ("chrome" if net in used or net in CHROME_POSTS else "hand"), None
            chrome = req.get("chrome") if via == "chrome" else None  # posted by hand: nothing to check here
            checks = [_check("chrome", True, "Your Chrome is linked: the studio posts here through it.")] if chrome is True else (
                [_check("chrome", False, "Your Chrome is not linked, so posts booked here wait.",
                        "Settings › Keys & AI › Chrome link key, or open the studio's Chrome helper.")] if chrome is False else [])
        fail = last_failure(posts, net, now)
        if fail:
            checks.append(_check("lastpost", False, _scrub(f"The post booked for {str(fail.get('at'))[:16].replace('T', ' ')} did not go out"
                                                          + (f": {fail.get('note')}" if fail.get("note") else ".")),
                                 "Fix what it says, then Posting › book it again (or post it by hand)."))
        out.append({"network": net, "name": NAMES.get(net, net), "via": via, "account": account, "state": _state(checks), "checks": checks})
    counts = {k: sum(1 for n in out if n["state"] == k) for k in ("ok", "warn", "bad")}
    return {"at": now.isoformat(timespec="seconds"), "networks": out, "counts": counts}


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        req = json.loads(raw or "{}")
        if (argv[:1] or [""])[0] != "check" or not isinstance(req, dict):
            raise ValueError("usage: python -m studio.netcheck check")
        out = {"ok": True, "data": check(req)}
    except Exception as err:  # noqa: BLE001
        out = {"ok": False, "error": _scrub(f"{type(err).__name__}: {err}"), "code": "bug", "status": 500}
    sys.stdout.write("RESULT " + json.dumps(out, ensure_ascii=False, default=str) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
