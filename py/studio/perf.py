"""
FILE: py/studio/perf.py
PURPOSE: How each reel did on each network: a metrics store with snapshots over time, collectors for the
         networks the studio can read (YouTube, Facebook, Bluesky, Instagram Stories), manual entry and CSV import
         for the rest (TikTok, X, Pinterest, Google Maps, LINE, LinkedIn, Threads, the Instagram feed); and
         insights(), the numbers behind Results › What the numbers say.
OVERVIEW: One `metrics` table in the catalog. A row is one reading of one post (posts.id) at one time:
          views, likes, comments, shares, saves, watch time, average % viewed, followers gained, reach,
          plus `source` (api | manual | csv) and the post's age when read. Readings are kept, never
          overwritten, so a reel has a 1 h / 24 h / 72 h / 7 d / 28 d curve.
          collect() reads every live post whose next checkpoint has come (CHECKPOINTS) from its network's
          collector (COLLECTORS: one class per network with ready() and fetch(); an API connector for
          TikTok or X later is one more class there). Posts on networks without a collector are listed
          as "needs numbers by hand". The server's timer calls collect at most hourly; nothing is read
          twice for the same checkpoint unless `fresh` is asked.
          manual() stores numbers a person typed; import_csv() maps TikTok Studio / X Analytics (and any
          other) exports by their column names and matches each row to a post by link, id, time or title.
          Learning (what worked, what to try next) is studio.learn.
DEPENDENCIES: Python stdlib, studio.db, studio.posting, studio.youtube (HTTPS, token), studio.connectors.facebook
              (Page token), studio.learn (summary, suggest)
USAGE: python -m studio.perf <get|summary|collect|manual|import|suggest|status>  (request JSON on stdin)
       prints one line: RESULT {"ok": true, "data": {...}}
                     or RESULT {"ok": false, "error": "<one plain sentence>", "code": "...", "status": 4xx|5xx}
TECHNICAL DETAILS (read 2026-11-09, docs/research/2026-11-09-reel-learning.md):
  YouTube Data API v3: GET youtube/v3/videos?part=statistics&id=<up to 50> -> items[].statistics
       {viewCount, likeCount, commentCount}; 1 quota unit per call (10,000 a day).
  YouTube Analytics API v2 (scope yt-analytics.readonly): GET youtubeanalytics.googleapis.com/v2/reports
       ?ids=channel==MINE&startDate&endDate&metrics=engagedViews,views,estimatedMinutesWatched,
       averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained&filters=video==<id>
       -> {columnHeaders: [{name}], rows: [[...]]}. Data lags 1-3 days, so it is asked from 48 h on.
  Facebook Graph API: GET /{video-id}/video_insights (Page token of someone with the ANALYZE task; read_insights,
       and the reference also lists pages_manage_engagement)
       -> data[{name, values: [{value}]}]; reels report blue_reels_play_count, fb_reels_total_plays,
       fb_reels_replay_count, post_impressions_unique, post_video_avg_time_watched (ms),
       post_video_view_time (ms), post_video_followers, post_video_social_actions,
       post_video_likes_by_reaction_type. Asked without a metric list so a renamed metric never fails the call.
  Bluesky AppView (public, no sign-in): GET public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=<up to 25>
       -> posts[{uri, likeCount, repostCount, replyCount, quoteCount, bookmarkCount?}]; no view counts.
       A handle in a bsky.app link is turned into its DID with com.atproto.identity.resolveHandle.
NOTES: Tokens come from the stored connections (studio.youtube, studio.connectors.facebook) and are never
       printed, logged, stored here or returned; every error leaving this module is scrubbed. Nothing here posts.
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from studio.db import connect

JST = timezone(timedelta(hours=9))
# Snapshot checkpoints: a post is read once it is at least this old, once per checkpoint.
CHECKPOINTS = (("1h", 1.0), ("24h", 24.0), ("72h", 72.0), ("7d", 168.0), ("28d", 672.0))
LAST_READ_H = 30 * 24.0        # after 30 days a post is final; it is not read again
TIMER_GAP_S = 55 * 60          # the timer collects at most once an hour
FRESH_GAP_S = 15 * 60          # "fresh" re-reads a post only if its last reading is older than this
LIVE = ("posted", "scheduled")  # a scheduled post whose time has passed is out (YouTube, Facebook, booked posts)
NUMBERS = ("views", "likes", "comments", "shares", "saves", "watch_time_s", "avg_view_pct", "avg_view_s",
           "completion_pct", "followers_gained", "reach")
INTS = {"views", "likes", "comments", "shares", "saves", "followers_gained", "reach"}
SOURCES = ("api", "manual", "csv", "browser")  # browser: read off the network's own page in the owner's Chrome (server/helper.mjs)
MAX_CSV = 2_000_000
ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly"
YT_API = "https://www.googleapis.com/youtube/v3"
YT_ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"
BSKY_APPVIEW = "https://public.api.bsky.app/xrpc"

METRICS_SQL = """
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL,       -- posts.id
  network TEXT NOT NULL,
  slug TEXT NOT NULL,
  remote_id TEXT,
  fetched_at TEXT NOT NULL,       -- when the numbers were read (ISO, with offset)
  age_h REAL,                     -- hours between the post going out and fetched_at
  checkpoint TEXT,                -- 1h | 24h | 72h | 7d | 28d (the newest one the post had reached)
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER,
  watch_time_s REAL,              -- total watch time
  avg_view_pct REAL,              -- average percentage of the reel watched
  avg_view_s REAL,                -- average seconds watched per view
  completion_pct REAL,            -- share of views that watched to the end (TikTok "watched full video")
  followers_gained INTEGER,
  reach INTEGER,                  -- unique accounts reached / impressions where a network has no views
  extra TEXT,                     -- JSON: anything else a network reports (engaged views, replays, quotes)
  source TEXT NOT NULL            -- api | manual | csv | browser
);
CREATE INDEX IF NOT EXISTS metrics_post ON metrics(post_id, fetched_at);
CREATE INDEX IF NOT EXISTS metrics_slug ON metrics(slug, network);
"""


class PerfError(Exception):
    """A plain sentence for a person, with a code and an HTTP status for the server."""

    def __init__(self, message: str, code: str = "error", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


_SECRETISH = [re.compile(p) for p in (r"(?i)bearer\s+[\w.~+/-]+=*", r"(?i)(access_token|refresh_token|client_secret|key)=[^&\s\"']+",
                                      r"EAA[A-Za-z0-9]{20,}", r"ya29\.[\w.-]+", r"1//[\w-]{20,}", r"eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+")]


def _scrub(text: str) -> str:
    for rx in _SECRETISH:
        text = rx.sub("[hidden]", text)
    return text


# ---------- time ----------

def _now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def _when(at: str | None) -> datetime | None:
    """A posts.at value: ISO with an offset, or naive (this PC's zone, as studio.posting writes it)."""
    if not at:
        return None
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.astimezone()


def checkpoint(age_h: float | None) -> str | None:
    """The newest checkpoint a post of this age has reached, or None before the first hour."""
    if age_h is None:
        return None
    out = None
    for name, hours in CHECKPOINTS:
        if age_h >= hours:
            out = name
    return out


# ---------- the store ----------

def _ready(con) -> None:
    con.executescript(METRICS_SQL)


def _posts() -> list[dict]:
    from studio import posting

    return posting.posts()


def live_posts(now: datetime | None = None) -> list[dict]:
    """Posts that are out: posted, or scheduled with their time passed. Each gets `age_h` and `out_at`."""
    now = now or _now()
    out = []
    posts = _posts()
    gone = retired(posts)  # a replaced or deleted upload is neither read again nor learned from
    for p in posts:
        if p["network"] == "all" or p["status"] not in LIVE or int(p["id"]) in gone:
            continue
        t = _when(p.get("at"))
        if not t or t > now:
            continue
        out.append({**p, "out_at": t.isoformat(timespec="minutes"), "age_h": round((now - t).total_seconds() / 3600, 2)})
    return out


def _clean_numbers(raw: dict) -> dict:
    out = {}
    for k in NUMBERS:
        v = raw.get(k)
        if v is None or v == "":
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
            raise PerfError(f"{k}: a number of zero or more", "bad_input")
        if k in ("avg_view_pct", "completion_pct") and v > 100:
            raise PerfError(f"{k}: a percentage from 0 to 100", "bad_input")
        out[k] = int(round(v)) if k in INTS else round(float(v), 3)
    return out


def store(post: dict, numbers: dict, source: str, *, at: datetime | None = None, extra: dict | None = None,
          remote_id: str | None = None) -> dict:
    """Write one reading of one post. `post` is a posts row (id, slug, network, at)."""
    if source not in SOURCES:
        raise ValueError(f"source: one of {', '.join(SOURCES)}")
    at = at or _now()
    out_at = _when(post.get("at"))
    age = round((at - out_at).total_seconds() / 3600, 2) if out_at else None
    row = {"post_id": int(post["id"]), "network": post["network"], "slug": post["slug"],
           "remote_id": remote_id or post.get("remote_id"), "fetched_at": at.isoformat(timespec="seconds"),
           "age_h": age, "checkpoint": checkpoint(age), **_clean_numbers(numbers),
           "extra": json.dumps(extra, ensure_ascii=False, sort_keys=True) if extra else None, "source": source}
    cols = list(row)
    with connect() as con:
        _ready(con)
        cur = con.execute(f"INSERT INTO metrics ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", [row[c] for c in cols])
        row["id"] = int(cur.lastrowid)
    # Numbers mean it is out: a booked post read here is confirmed live (studio.live), once its time has passed.
    if out_at and out_at <= at:
        from studio import live

        live.seen(int(post["id"]), str(post.get("url") or ""), {"api": "read by the API", "browser": "read in your Chrome"}.get(source, source), at)
    return _view(row)


def _view(row: dict) -> dict:
    r = dict(row)
    r["extra"] = json.loads(r["extra"]) if isinstance(r.get("extra"), str) and r["extra"] else (r.get("extra") or {})
    return r


def readings(post_id: int | None = None, slug: str | None = None) -> list[dict]:
    """Every reading, oldest first; filtered to one post or one reel."""
    q, args = "SELECT * FROM metrics", []
    if post_id is not None:
        q, args = q + " WHERE post_id = ?", [int(post_id)]
    elif slug is not None:
        q, args = q + " WHERE slug = ?", [slug]
    with connect() as con:
        _ready(con)
        return [_view(dict(r)) for r in con.execute(q + " ORDER BY fetched_at, id", args)]


# ---------- HTTP (tests replace _http) ----------

def _http(method: str, url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: int = 30):
    from studio.youtube import _call

    try:
        return _call(method, url, data=data, headers=headers, timeout=timeout)
    except OSError as err:
        host = urllib.parse.urlsplit(url).netloc
        raise PerfError(f"could not reach {host} ({getattr(err, 'reason', err)}); check the internet connection", "offline", 502) from None


def _json(body: bytes) -> dict:
    try:
        j = json.loads(body.decode("utf-8") or "{}")
        return j if isinstance(j, dict) else {}
    except ValueError:
        return {}


def _int(v) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _float(v) -> float | None:
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


# ---------- collectors ----------

class Collector:
    """One network the studio can read by itself. ready() -> (ok, why not); fetch(posts) -> (readings, notes).
    A reading is {"post": <posts row>, "numbers": {...}, "extra": {...}}. A note is a plain sentence about the
    network as a whole (missing permission, quota). Raise PerfError for a failure that stops the network."""

    network = ""
    name = ""

    def ready(self) -> tuple[bool, str]:
        return False, "not set up"

    def fetch(self, posts: list[dict]) -> tuple[list[dict], list[str]]:
        raise NotImplementedError


def youtube_id(post: dict) -> str | None:
    rid = str(post.get("remote_id") or "")
    if re.fullmatch(r"[\w-]{11}", rid):
        return rid
    m = re.search(r"(?:shorts/|watch\?v=|youtu\.be/)([\w-]{11})", str(post.get("url") or ""))
    return m.group(1) if m else None


class YouTube(Collector):
    network, name = "youtube", "YouTube"

    def _token(self) -> dict | None:
        from studio.youtube import _load_token

        try:
            return _load_token()
        except OSError:
            return None

    def _access(self) -> str:
        from studio.youtube import access_token

        return access_token()

    def ready(self):
        return (True, "") if self._token() else (False, "YouTube is not connected (Accounts › Connect YouTube)")

    def analytics(self) -> bool:
        return ANALYTICS_SCOPE in ((self._token() or {}).get("scopes") or [])

    def _get(self, url: str) -> tuple[int, dict]:
        try:
            token = self._access()
        except RuntimeError as err:
            raise PerfError(f"YouTube: {err}", "auth", 401) from None
        status, _, body = _http("GET", url, headers={"authorization": f"Bearer {token}"})
        return status, _json(body)

    @staticmethod
    def _error(status: int, j: dict) -> str:
        err = j.get("error") if isinstance(j.get("error"), dict) else {}
        reasons = ",".join(e.get("reason", "") for e in err.get("errors", []) if isinstance(e, dict) and e.get("reason"))
        return f"YouTube {status}: {err.get('message', '')}{f' ({reasons})' if reasons else ''}".strip()

    def fetch(self, posts):
        notes, out = [], []
        ids = {}
        for p in posts:
            vid = youtube_id(p)
            if vid:
                ids.setdefault(vid, []).append(p)
        vids = list(ids)
        stats: dict[str, dict] = {}
        for i in range(0, len(vids), 50):  # 1 quota unit per call, up to 50 videos
            status, j = self._get(f"{YT_API}/videos?" + urllib.parse.urlencode({"part": "statistics", "id": ",".join(vids[i:i + 50])}))
            if status != 200:
                msg = self._error(status, j)
                if "quota" in msg.lower():
                    msg += " (the daily quota resets at midnight Pacific time)"
                raise PerfError(msg, "youtube", 502)
            for item in j.get("items", []):
                stats[item.get("id")] = item.get("statistics") or {}
        analytics = self.analytics()
        if not analytics:
            notes.append("YouTube: views, likes and comments only. For watch time, % viewed, shares and subscribers, open "
                         "Accounts, press Connect YouTube again and allow \"View YouTube Analytics reports\".")
        for vid, rows in ids.items():
            s = stats.get(vid)
            if s is None:
                notes.append(f"YouTube: video {vid} was not found (deleted, or on another channel).")
                continue
            for p in rows:
                numbers = {"views": _int(s.get("viewCount")), "likes": _int(s.get("likeCount")), "comments": _int(s.get("commentCount"))}
                extra = {}
                if analytics and (p.get("age_h") or 0) >= 48:  # Analytics lags 1-3 days
                    a, why = self._analytics(vid, p)
                    if why and why not in notes:
                        notes.append(why)
                    for k in ("watch_time_s", "avg_view_pct", "avg_view_s", "shares", "followers_gained"):
                        if a.get(k) is not None:
                            numbers[k] = a[k]
                    extra = {k: a[k] for k in ("engaged_views", "analytics_views") if a.get(k) is not None}
                    # A Short that people loop is watched over 100 % on average: the column holds 0-100, so it keeps 100
                    # and the real figure rides in extra (16 Nov: one such reading stopped the whole hourly read).
                    if (numbers.get("avg_view_pct") or 0) > 100:
                        extra["avg_view_pct_raw"] = numbers["avg_view_pct"]
                        numbers["avg_view_pct"] = 100.0
                out.append({"post": p, "numbers": {k: v for k, v in numbers.items() if v is not None}, "extra": extra, "remote_id": vid})
        return out, notes

    def _analytics(self, vid: str, post: dict) -> tuple[dict, str | None]:
        start = (_when(post.get("at")) or _now()).astimezone(JST).date().isoformat()
        end = _now().astimezone(JST).date().isoformat()
        metrics = ["engagedViews", "views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage",
                   "likes", "comments", "shares", "subscribersGained"]
        for attempt in (metrics, [m for m in metrics if m != "engagedViews"]):
            q = {"ids": "channel==MINE", "startDate": start, "endDate": end, "metrics": ",".join(attempt), "filters": f"video=={vid}"}
            status, j = self._get(f"{YT_ANALYTICS}?{urllib.parse.urlencode(q)}")
            if status == 200:
                break
            if status == 400 and "engagedViews" in attempt:
                continue  # an older API without engaged views: ask again without it
            if status == 403:
                return {}, ("YouTube Analytics refused the request. In Google Cloud (the project of the studio's OAuth app) "
                            "enable \"YouTube Analytics API\", then press Connect YouTube again.")
            return {}, self._error(status, j)
        names = [h.get("name") for h in j.get("columnHeaders", [])]
        rows = j.get("rows") or []
        if not rows:
            return {}, "YouTube Analytics has no numbers yet for the newest Shorts (they arrive 1-3 days after posting)."
        r = dict(zip(names, rows[0]))
        minutes = _float(r.get("estimatedMinutesWatched"))
        return {"watch_time_s": round(minutes * 60, 1) if minutes is not None else None,
                "avg_view_pct": _float(r.get("averageViewPercentage")), "avg_view_s": _float(r.get("averageViewDuration")),
                "shares": _int(r.get("shares")), "followers_gained": _int(r.get("subscribersGained")),
                "engaged_views": _int(r.get("engagedViews")), "analytics_views": _int(r.get("views"))}, None


def facebook_id(post: dict) -> str | None:
    rid = str(post.get("remote_id") or "")
    if rid.isdigit():
        return rid
    m = re.search(r"facebook\.com/(?:reel/|watch/?\?v=|[^/]+/videos/)(\d+)", str(post.get("url") or ""))
    return m.group(1) if m else None


# Graph API insight names -> our columns (first one present wins). Times are milliseconds.
# blue_reels_play_count: plays of 1 ms or more, replays excluded (closest to "views"); total plays include replays.
FB_VIEWS = ("blue_reels_play_count", "fb_reels_total_plays", "total_video_views", "post_video_views")
FB_MAP = {"reach": ("post_impressions_unique", "total_video_impressions_unique"),
          "avg_view_s": ("post_video_avg_time_watched", "total_video_avg_time_watched"),
          "watch_time_s": ("post_video_view_time", "total_video_view_total_time"),
          "followers_gained": ("post_video_followers",)}


class Facebook(Collector):
    network, name = "facebook", "Facebook"

    def _creds(self) -> dict | None:
        from studio.connectors.facebook import _load

        try:
            return _load()
        except Exception:
            return None

    def ready(self):
        return (True, "") if self._creds() else (False, "Facebook is not connected (Accounts › Facebook)")

    def fetch(self, posts):
        from studio.connectors.facebook import GRAPH

        creds = self._creds() or {}
        token = creds.get("token")
        if not token:
            raise PerfError("Facebook is not connected", "auth", 401)
        out, notes = [], []
        for p in posts:
            vid = facebook_id(p)
            if not vid:
                notes.append(f"Facebook: post {p['id']} ({p['slug']}) has no reel id; add its link with Mark posted.")
                continue
            status, _, body = _http("GET", f"{GRAPH}/{vid}/video_insights?" + urllib.parse.urlencode({"access_token": token}))
            j = _json(body)
            if status != 200:
                err = j.get("error") if isinstance(j.get("error"), dict) else {}
                code = err.get("code")
                if code == 190:
                    raise PerfError("Facebook: the stored token expired or was revoked; connect Facebook again.", "auth", 401)
                if code in (10, 200) or (isinstance(code, int) and 200 <= code < 300):
                    raise PerfError("Facebook: the token may not read insights. Connect Facebook again and allow read_insights "
                                    "(Graph API Explorer: add read_insights and pages_manage_engagement; you need the Analyze "
                                    "task on the Page).", "permission", 403)
                if code in (4, 17, 32, 613):
                    raise PerfError("Facebook: rate limit reached; the next hourly check tries again.", "rate", 429)
                notes.append(_scrub(f"Facebook: reel {vid}: {err.get('message') or status}"))
                continue
            values = {}
            for m in j.get("data", []):
                vals = m.get("values") or []
                if m.get("name") and vals:
                    values[m["name"]] = vals[-1].get("value")
            numbers: dict = {}
            views = next((values[k] for k in FB_VIEWS if isinstance(values.get(k), (int, float))), None)
            if views is not None:
                numbers["views"] = int(views)
            for col, names in FB_MAP.items():
                v = next((values[k] for k in names if isinstance(values.get(k), (int, float))), None)
                if v is not None:
                    numbers[col] = round(v / 1000, 2) if col in ("avg_view_s", "watch_time_s") else int(v)
            social = values.get("post_video_social_actions")
            if isinstance(social, (int, float)):
                values["social_actions"] = int(social)  # comments + shares as one count
            elif isinstance(social, dict):
                low = {str(k).lower(): v for k, v in social.items()}
                if isinstance(low.get("comment"), (int, float)):
                    numbers["comments"] = int(low["comment"])
                if isinstance(low.get("share"), (int, float)):
                    numbers["shares"] = int(low["share"])
            reactions = values.get("post_video_likes_by_reaction_type")
            if isinstance(reactions, dict):
                numbers["likes"] = int(sum(v for v in reactions.values() if isinstance(v, (int, float))))
            extra = {k: values[k] for k in ("fb_reels_replay_count", "blue_reels_play_count", "fb_reels_total_plays", "social_actions") if k in values}
            if not numbers:
                notes.append(f"Facebook: reel {vid} has no insights yet (they appear after it has been watched).")
                continue
            out.append({"post": p, "numbers": numbers, "extra": extra, "remote_id": vid})
        return out, notes


def bluesky_uri(post: dict, resolve=None) -> str | None:
    rid = str(post.get("remote_id") or "")
    if rid.startswith("at://"):
        return rid
    m = re.search(r"bsky\.app/profile/([^/]+)/post/([\w~.-]+)", str(post.get("url") or ""))
    if not m:
        return None
    actor, rkey = m.group(1), m.group(2)
    if not actor.startswith("did:"):
        actor = (resolve or _resolve_handle)(actor)
        if not actor:
            return None
    return f"at://{actor}/app.bsky.feed.post/{rkey}"


def _resolve_handle(handle: str) -> str | None:
    status, _, body = _http("GET", f"{BSKY_APPVIEW}/com.atproto.identity.resolveHandle?" + urllib.parse.urlencode({"handle": handle}))
    return _json(body).get("did") if status == 200 else None


class Bluesky(Collector):
    network, name = "bluesky", "Bluesky"

    def ready(self):
        return True, ""  # the public AppView needs no sign-in

    def fetch(self, posts):
        out, notes, uris = [], [], {}
        for p in posts:
            uri = bluesky_uri(p)
            if uri:
                uris.setdefault(uri, []).append(p)
            else:
                notes.append(f"Bluesky: post {p['id']} ({p['slug']}) has no bsky.app link.")
        keys = list(uris)
        found = {}
        for i in range(0, len(keys), 25):
            q = urllib.parse.urlencode([("uris", u) for u in keys[i:i + 25]])
            status, _, body = _http("GET", f"{BSKY_APPVIEW}/app.bsky.feed.getPosts?{q}")
            if status != 200:
                raise PerfError(f"Bluesky {status}: {_json(body).get('message') or 'getPosts failed'}", "bluesky", 502)
            for item in _json(body).get("posts", []):
                found[item.get("uri")] = item
        for uri, rows in uris.items():
            item = found.get(uri)
            if not item:
                notes.append(f"Bluesky: {uri.rsplit('/', 1)[-1]} was not found (deleted?).")
                continue
            reposts, quotes = _int(item.get("repostCount")) or 0, _int(item.get("quoteCount")) or 0
            numbers = {"likes": _int(item.get("likeCount")) or 0, "comments": _int(item.get("replyCount")) or 0, "shares": reposts + quotes}
            if item.get("bookmarkCount") is not None:
                numbers["saves"] = _int(item.get("bookmarkCount")) or 0
            for p in rows:
                out.append({"post": p, "numbers": numbers, "extra": {"reposts": reposts, "quotes": quotes}, "remote_id": uri})
        return out, notes


# Instagram Story insights (Instagram API with Facebook Login, v27.0; read 2026-11-18,
# developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights):
#   GET /{ig-media-id}/insights?metric=views,reach,shares,follows,profile_visits,total_interactions
#   GET /{ig-media-id}/insights?metric=navigation&breakdown=story_navigation_action_type
#       -> total_value.breakdowns[0].results[{dimension_values: ["tap_forward"|"tap_back"|"tap_exit"|"swipe_forward"], value}]
#   "Story media metrics are only available for 24 hours" (after that the media id answers code 100, subcode 33);
#   a value under 5 answers (#10) "Not enough viewers"; replies are always 0 for accounts in Japan, so not asked.
#   impressions, exits, taps_forward and taps_back are gone (v18 / v22). Needs instagram_manage_insights.
IG_STORY_METRICS = ("views", "reach", "shares", "follows", "profile_visits", "total_interactions")
STORY_LIFE_H = 24.0     # a Story is gone after a day, and its numbers with it
STORY_GAP_H = 6.0       # read about every 6 hours while it is up (the timer runs hourly)...
STORY_LAST_H = 21.0     # ...and once more in its last hours, the reading that counts


def instagram_media_id(post: dict) -> str | None:
    rid = str(post.get("remote_id") or "")
    return rid if rid.isdigit() else None


def _ig_value(metric: dict):
    tv = metric.get("total_value")
    if isinstance(tv, dict) and isinstance(tv.get("value"), (int, float)):
        return tv["value"]
    vals = metric.get("values") or []
    return vals[-1].get("value") if vals and isinstance(vals[-1], dict) else None


class InstagramStory(Collector):
    network, name = "instagram-story", "Instagram Stories"

    def _creds(self) -> dict | None:
        from studio.connectors.facebook import _load

        try:
            return _load()
        except Exception:
            return None

    def ready(self):
        return (True, "") if self._creds() else (False, "Instagram Stories use the Facebook connection: connect Facebook (Accounts › Facebook)")

    def fetch(self, posts):
        from studio.connectors.facebook import GRAPH

        token = (self._creds() or {}).get("token")
        if not token:
            raise PerfError("Instagram Stories: Facebook is not connected", "auth", 401)
        out, notes = [], []
        for p in posts:
            mid = instagram_media_id(p)
            if not mid:
                notes.append(f"Instagram Stories: post {p['id']} ({p['slug']}) has no media id, so its numbers cannot be read.")
                continue
            q = urllib.parse.urlencode({"metric": ",".join(IG_STORY_METRICS), "access_token": token})
            status, _, body = _http("GET", f"{GRAPH}/{mid}/insights?{q}")
            j = _json(body)
            if status != 200:
                err = j.get("error") if isinstance(j.get("error"), dict) else {}
                code, msg = err.get("code"), str(err.get("message") or "")
                if code == 190:
                    raise PerfError("Instagram Stories: the stored Facebook token expired or was revoked; connect Facebook again.", "auth", 401)
                if code == 10 and "viewer" in msg.lower():
                    notes.append(f"Instagram Stories: {p['slug']} has fewer than 5 viewers so far (Instagram shows no numbers under 5).")
                    continue
                if code in (10, 200) or (isinstance(code, int) and 200 <= code < 300):
                    raise PerfError("Instagram Stories: the Facebook connection may not read Story numbers yet. Accounts › Facebook › "
                                    "Connect again and allow instagram_manage_insights (a Story's numbers last only 24 hours).",
                                    "permission", 403)
                if code in (4, 17, 32, 613):
                    raise PerfError("Instagram: rate limit reached; the next hourly check tries again.", "rate", 429)
                if code == 100 and err.get("error_subcode") == 33:
                    notes.append(f"Instagram Stories: {p['slug']} has expired; its numbers are gone after 24 hours.")
                    continue
                notes.append(_scrub(f"Instagram Stories: {p['slug']}: {msg or status}"))
                continue
            values = {m.get("name"): _ig_value(m) for m in j.get("data", []) if isinstance(m, dict)}
            numbers: dict = {}
            for col, name in (("views", "views"), ("reach", "reach"), ("shares", "shares"), ("followers_gained", "follows")):
                if isinstance(values.get(name), (int, float)):
                    numbers[col] = int(values[name])
            extra = {k: int(values[k]) for k in ("profile_visits", "total_interactions") if isinstance(values.get(k), (int, float))}
            # How people left it: one extra call, and a Story without it still counts.
            q = urllib.parse.urlencode({"metric": "navigation", "breakdown": "story_navigation_action_type", "access_token": token})
            s2, _, b2 = _http("GET", f"{GRAPH}/{mid}/insights?{q}")
            if s2 == 200:
                nav = {}
                for m in _json(b2).get("data", []):
                    for bd in ((m.get("total_value") or {}).get("breakdowns") or []):
                        for r in bd.get("results") or []:
                            key = str((r.get("dimension_values") or [""])[0]).lower()
                            if key and isinstance(r.get("value"), (int, float)):
                                nav[key] = int(r["value"])
                if nav:
                    extra["navigation"] = nav
            if not numbers:
                notes.append(f"Instagram Stories: {p['slug']} has no numbers yet.")
                continue
            out.append({"post": p, "numbers": numbers, "extra": extra, "remote_id": mid})
        return out, notes


class PhotoStory(InstagramStory):
    """A photo post's Story (studio.stills, network "photo-story"): the same Instagram Story numbers, kept apart from
    the reels' Stories so each is judged on its own."""
    network, name = "photo-story", "Instagram Stories (photo posts)"


COLLECTORS: dict[str, Collector] = {c.network: c for c in (YouTube(), Facebook(), Bluesky(), InstagramStory(), PhotoStory())}


def _story_due(post: dict, mine: list[dict], now: datetime, fresh: bool) -> str | None:
    """A Story is read while it is up: first after an hour, then about every STORY_GAP_H hours, and once in its last
    hours (from STORY_LAST_H), because its numbers vanish with it at 24 hours. mine: its API readings."""
    age = post["age_h"]
    if age < 1.0 or age >= STORY_LIFE_H:
        return None
    if not mine:
        return "first reading"
    if age >= STORY_LAST_H and max(float(r.get("age_h") or 0) for r in mine) < STORY_LAST_H:
        return "last reading before it expires"
    last = max((_when(r["fetched_at"]) for r in mine), default=None)
    gap = (now - last).total_seconds() if last else 1e9
    if gap >= STORY_GAP_H * 3600:
        return "story reading"
    if fresh and gap > FRESH_GAP_S:
        return "asked for fresh numbers"
    return None


def _fb_texts() -> dict[str, str]:
    """Each reel's Facebook post text, from the render manifests on the data disk (fast; the drafts may sit on a
    synced drive). {slug: text}."""
    from studio.config import DATA

    out: dict[str, str] = {}
    for m in (DATA / "renders").glob("story-*/manifest.json"):
        try:
            man = json.loads(m.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        ch = next((c for c in man.get("channels") or [] if c.get("name") == "facebook"), None)
        if ch and str(ch.get("post") or "").strip():
            out[m.parent.name.removeprefix("story-")] = str(ch["post"]).strip()
    return out


def match_reel(description: str, texts: dict[str, str]) -> str | None:
    """The reel a network post belongs to: the one whose post text is exactly the description, else the one reel whose
    first line is the description's first line. Two candidates is no match (never a guess). Pure, for tests."""
    d = (description or "").strip()
    if not d:
        return None
    exact = [s for s, t in texts.items() if t == d]
    if len(exact) == 1:
        return exact[0]
    first = d.split("\n")[0].strip()
    line = [s for s, t in texts.items() if t.split("\n")[0].strip() == first]
    return line[0] if len(line) == 1 and not exact else None


def discover_facebook(texts: dict[str, str] | None = None) -> list[str]:
    """Reels on the Page that the posting log does not know (posted by hand, or a row lost when a booking was replaced)
    are added to the log as posted, so they are measured. 16 Nov: the one reel with 100 plays was not in the log, and
    Results said Facebook got nothing. Returns notes: what was added, and what could not be matched to a reel."""
    from studio import posting
    from studio.connectors.facebook import GRAPH, _load

    creds = _load() or {}
    token, page = creds.get("token"), creds.get("page_id")
    if not token or not page:
        return []
    status, _, body = _http("GET", f"{GRAPH}/{page}/video_reels?" + urllib.parse.urlencode(
        {"access_token": token, "fields": "id,description,permalink_url,published,status", "limit": 50}))
    if status != 200:
        return [_scrub(f"Facebook: could not list the Page's reels ({status})")]
    known = {str(p.get("remote_id") or "") for p in _posts() if p["network"] == "facebook"}
    known |= {facebook_id(p) or "" for p in _posts() if p["network"] == "facebook"}
    texts = _fb_texts() if texts is None else texts
    notes, unmatched = [], 0
    for r in _json(body).get("data", []):
        vid = str(r.get("id") or "")
        if not vid or vid in known or not r.get("published"):
            continue
        out_at = ((r.get("status") or {}).get("publishing_phase") or {}).get("publish_time")
        slug = match_reel(r.get("description") or "", texts)
        when = _when(out_at)
        if not slug or not when:
            unmatched += 1
            continue
        url = "https://www.facebook.com" + r["permalink_url"] if str(r.get("permalink_url", "")).startswith("/") else (r.get("permalink_url") or f"https://www.facebook.com/reel/{vid}/")
        posting.record(slug, "facebook", "posted", when.astimezone().isoformat(timespec="minutes"), remote_id=vid, url=url,
                       note="found on the Page; not in the posting log before")
        notes.append(f"Facebook: added {slug} (reel {vid}), found on the Page but missing from the posting log.")
    if unmatched:
        notes.append(f"Facebook: {unmatched} reel{'s' if unmatched != 1 else ''} on the Page could not be matched to a reel here.")
    return notes


# ---------- collect ----------

def _state_path() -> Path:
    from studio.config import DATA

    p = DATA / "perf"
    p.mkdir(parents=True, exist_ok=True)
    return p / "state.json"


def _state() -> dict:
    try:
        return json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _due(post: dict, mine: list[dict], now: datetime, fresh: bool) -> str | None:
    """Why this post should be read now, or None. mine: its API readings."""
    cp = checkpoint(post["age_h"])
    if cp is None:
        return None
    if post["age_h"] > LAST_READ_H + 48 and any(r["checkpoint"] == "28d" for r in mine):
        return None
    if not any(r["checkpoint"] == cp for r in mine):
        return f"{cp} reading"
    if fresh:
        last = max((_when(r["fetched_at"]) for r in mine), default=None)
        if not last or (now - last).total_seconds() > FRESH_GAP_S:
            return "asked for fresh numbers"
    return None


def collect(req: dict | None = None) -> dict:
    req = req or {}
    now = _now()
    fresh, timer = bool(req.get("fresh")), bool(req.get("timer"))
    st = _state()
    if timer and time.time() - float(st.get("last_run", 0)) < TIMER_GAP_S:
        return {"ran": False, "why": "checked less than an hour ago", "lastRun": st.get("last_at")}
    only = {int(x) for x in req.get("post_ids") or [] if str(x).isdigit()}
    found: list[str] = []
    if not only and COLLECTORS["facebook"].ready()[0]:
        try:
            found = discover_facebook()
        except Exception as err:  # finding missed reels never stops the reading itself
            found = [_scrub(f"Facebook: could not look for reels missing from the log ({type(err).__name__})")]
    posts = [p for p in live_posts(now) if not only or p["id"] in only]
    have: dict[int, list[dict]] = {}
    for r in readings():
        have.setdefault(r["post_id"], []).append(r)
    stored, skipped, problems, manual, notes = [], [], [], [], list(found)
    by_net: dict[str, list[dict]] = {}
    for p in posts:
        mine = have.get(p["id"], [])
        if p["network"] not in COLLECTORS:
            if checkpoint(p["age_h"]) and not any(r["checkpoint"] == checkpoint(p["age_h"]) for r in mine):
                manual.append({"post_id": p["id"], "slug": p["slug"], "network": p["network"], "age_h": p["age_h"],
                               "checkpoint": checkpoint(p["age_h"]), "url": p.get("url")})
            continue
        due = _story_due if p["network"] in ("instagram-story", "photo-story") else _due
        why = due(p, [r for r in mine if r["source"] == "api"], now, fresh)
        if why:
            by_net.setdefault(p["network"], []).append({**p, "why": why})
        else:
            skipped.append({"post_id": p["id"], "slug": p["slug"], "network": p["network"],
                            "why": "too new (under an hour)" if checkpoint(p["age_h"]) is None else "already read for this checkpoint"})
    for net, rows in by_net.items():
        col = COLLECTORS[net]
        ok, why = col.ready()
        if not ok:
            problems.append({"network": net, "error": why})
            continue
        try:
            got, net_notes = col.fetch(rows)
        except PerfError as err:
            problems.append({"network": net, "error": _scrub(str(err)), "code": err.code})
            continue
        except Exception as err:  # one network's bug never stops the others
            problems.append({"network": net, "error": _scrub(f"{col.name}: {type(err).__name__}: {err}"), "code": "bug"})
            continue
        notes.extend(net_notes)
        for g in got:
            try:
                row = store(g["post"], g["numbers"], "api", at=now, extra=g.get("extra"), remote_id=g.get("remote_id"))
            except PerfError as err:  # one post's odd number never stops the rest of the read
                problems.append({"network": net, "error": _scrub(f"{g['post'].get('slug')}: {err}"), "code": err.code})
                continue
            stored.append({k: row[k] for k in ("post_id", "slug", "network", "checkpoint", "age_h", *[n for n in NUMBERS if row.get(n) is not None])})
    upcoming = [p for p in _posts() if p["network"] != "all" and p["status"] in LIVE and (_when(p.get("at")) or now) > now]
    # Each network's last problem stays until a read of that network works, so Results can say what is missing
    # (a Story's permission) between runs. Networks not read this run keep theirs.
    last = dict(st.get("problems") or {})
    for net in by_net:
        last.pop(net, None)
    for x in problems:
        last[x["network"]] = {"error": x["error"], "code": x.get("code"), "at": now.isoformat(timespec="seconds")}
    st.update(last_run=time.time(), last_at=now.isoformat(timespec="seconds"), problems=last)
    _state_path().write_text(json.dumps(st), encoding="utf-8")
    return {"ran": True, "at": now.isoformat(timespec="seconds"), "read": len(stored), "stored": stored, "skipped": skipped,
            "problems": problems, "notes": notes, "needsNumbers": manual,
            "notOutYet": [{"post_id": p["id"], "slug": p["slug"], "network": p["network"], "at": p["at"]} for p in upcoming],
            "summary": _collect_line(stored, problems, manual)}


def _collect_line(stored, problems, manual) -> str:
    parts = [f"Read {len(stored)} post{'s' if len(stored) != 1 else ''}"]
    if problems:
        parts.append(f"{len(problems)} network{'s' if len(problems) != 1 else ''} could not be read ({', '.join(p['network'] for p in problems)})")
    if manual:
        parts.append(f"{len(manual)} post{'s' if len(manual) != 1 else ''} on other networks "
                     f"{'need' if len(manual) != 1 else 'needs'} numbers by hand or a CSV")
    return "; ".join(parts) + "."


# ---------- manual entry ----------

def _post(post_id) -> dict:
    try:
        pid = int(post_id)
    except (TypeError, ValueError):
        raise PerfError("post_id: the number of a row in the posting log", "bad_input") from None
    p = next((r for r in _posts() if r["id"] == pid), None)
    if not p or p["network"] == "all":
        raise PerfError(f"no post {post_id} in the posting log", "not_found", 404)
    return p


def manual(req: dict) -> dict:
    p = _post(req.get("post_id"))
    numbers = _clean_numbers(req)
    if not numbers:
        raise PerfError("Type at least one number (views, likes, comments, shares, saves, ...).", "bad_input")
    at = _when(req.get("at")) if req.get("at") else None
    if req.get("at") and not at:
        raise PerfError("at: when you read the numbers, e.g. 2026-11-12T19:00", "bad_input")
    if at and at > _now() + timedelta(minutes=5):
        raise PerfError("at: that time is in the future", "bad_input")
    note = str(req.get("note") or "")[:200]
    # "browser": the studio's helper read these off the network's own page (never a person's typing). Its page link
    # and the post's id on the network ride along so a reading can be traced back to where it was read.
    source = req.get("source") or "manual"
    if source not in ("manual", "browser"):
        raise PerfError("source: manual or browser", "bad_input")
    extra = {"note": note} if note else {}
    page = str(req.get("page") or "")[:300]
    if page:
        if not page.startswith("https://"):
            raise PerfError("page: the https:// address the numbers were read from", "bad_input")
        extra["page"] = page
    rid = str(req.get("remote_id") or "")[:100] or None
    row = store(p, numbers, source, at=at, extra=extra or None, remote_id=rid)
    return {"stored": row, "post": {k: p[k] for k in ("id", "slug", "network", "at", "url")}}


def needs(req: dict | None = None) -> dict:
    """Read-only: live posts on networks without an API collector whose current checkpoint has no reading yet.
    The same list collect() returns as needsNumbers, without reading any network or moving the hourly timer."""
    req = req or {}
    nets = {str(n) for n in req.get("networks") or [] if isinstance(n, str)}
    have: dict[int, list[dict]] = {}
    for r in readings():
        have.setdefault(r["post_id"], []).append(r)
    out = []
    for p in live_posts(_now()):
        if p["network"] in COLLECTORS or (nets and p["network"] not in nets):
            continue
        if p["network"] == "line-oa" and p.get("seen_at"):
            continue  # LINE has no numbers: once the message list shows it sent, there is nothing more to read
        cp = checkpoint(p["age_h"])
        if cp and not any(r["checkpoint"] == cp for r in have.get(p["id"], [])):
            out.append({"post_id": p["id"], "slug": p["slug"], "network": p["network"], "age_h": p["age_h"], "checkpoint": cp,
                        "at": p.get("at"), "url": p.get("url"), "remote_id": p.get("remote_id")})
    # Posts marked missing (studio.live) are looked for again for three days: one that turns up late is confirmed.
    now = _now()
    for p in _posts():
        t = _when(p.get("at"))
        if p["status"] != "missing" or not t or p["network"] in COLLECTORS or (nets and p["network"] not in nets):
            continue
        age = (now - t).total_seconds() / 3600
        if age <= 72:
            out.append({"post_id": p["id"], "slug": p["slug"], "network": p["network"], "age_h": round(age, 2), "checkpoint": checkpoint(age),
                        "at": p.get("at"), "url": p.get("url"), "remote_id": p.get("remote_id"), "recheck": True})
    return {"needsNumbers": out}


# ---------- CSV import ----------

def _norm(h: str) -> str:
    """Lower case, brackets and punctuation dropped; letters of any script kept (Japanese headers too)."""
    h = str(h or "").replace("﻿", "").strip().lower()
    h = re.sub(r"[(（].*?[)）]", "", h)
    return re.sub(r"[^\w%]+", " ", h).replace("_", " ").strip()


# Our field -> header names seen in exports (normalised: lower case, punctuation and brackets dropped).
# Sources and how sure each is: docs/research/2026-11-09-reel-learning.md (X per-post file: Post id, Date, Post text,
# Post Link, Impressions, Likes, Engagements, Bookmarks, Shares, New follows, Replies, Reposts, ...; legacy X: Tweet id,
# Tweet text, time, impressions, retweets, replies, follows; TikTok Studio: Video title / Video name, Video views, Likes,
# Comments, Shares, Average watch time, Total play time, New followers). Japanese names are unverified guesses at the
# localised exports; a mapping in the request always wins.
ALIASES: dict[str, tuple[str, ...]] = {
    "views": ("total views", "video views", "views", "total play", "plays", "video plays", "media views", "play count", "total video views",
              "再生数", "視聴数", "動画視聴数", "動画の視聴数", "再生回数", "視聴回数"),
    "likes": ("total likes", "likes", "like count", "reactions", "いいね", "いいね数"),
    "comments": ("total comments", "comments", "replies", "reply count", "comment count", "コメント", "コメント数", "返信", "返信数"),
    "shares": ("total shares", "shares", "share count", "シェア", "シェア数", "共有"),
    "saves": ("total saves", "saves", "add to favorites", "favorites", "favorites count", "bookmarks", "save count", "保存", "保存数",
              "お気に入り", "ブックマーク", "ブックマーク数"),
    "reach": ("impressions", "reach", "total reach", "accounts reached", "impression count", "インプレッション", "インプレッション数",
              "リーチ", "表示回数"),
    "avg_view_s": ("average watch time", "avg watch time", "average view duration", "average time watched", "平均視聴時間", "平均再生時間"),
    "watch_time_s": ("total watch time", "total play time", "total time watched", "watch time", "総再生時間", "合計再生時間", "総視聴時間"),
    "completion_pct": ("watched full video", "watched full video rate", "completion rate", "finish rate", "full video watched",
                       "フル視聴率", "完全視聴率", "最後まで視聴"),
    "avg_view_pct": ("average percentage viewed", "average view percentage", "avg percentage viewed", "平均視聴率"),
    "followers_gained": ("new followers", "new follows", "followers gained", "follows", "subscribers gained", "新規フォロワー",
                         "新しいフォロワー", "フォロワー増加数", "新しいフォロー"),
    # added to shares (X has both Shares and Reposts; legacy X calls them retweets)
    "_reposts": ("reposts", "retweets", "repost count", "リポスト", "リポスト数"),
    # identity, used to find the post a row belongs to
    "_link": ("video link", "video url", "post link", "tweet permalink", "permalink", "link", "url", "post url", "動画リンク", "リンク"),
    "_id": ("post id", "tweet id", "video id", "id", "ポストid", "動画id"),
    "_time": ("post time", "posted", "posted date", "date posted", "create time", "publish time", "post date", "date", "time", "created at",
              "投稿日時", "投稿日", "日付", "日時"),
    "_title": ("video title", "video name", "video caption", "post text", "tweet text", "text", "title", "caption", "description",
               "動画タイトル", "タイトル", "ポスト本文", "本文", "キャプション"),
}
FIELDS = tuple(k for k in ALIASES if not k.startswith("_"))
# Header words that look like a match but are a different number.
NOT_FIELD = {"engagements", "engagement rate", "url clicks", "profile visits", "detail expands", "user profile clicks"}


def map_columns(headers: list[str], mapping: dict | None = None) -> dict[str, str]:
    """Our field -> the CSV column it comes from. An explicit mapping {column: field} wins."""
    out: dict[str, str] = {}
    by_norm = {_norm(h): h for h in headers}
    for col, field in (mapping or {}).items():
        if field not in ALIASES:
            raise PerfError(f"mapping: {field!r} is not a field; use one of {', '.join(ALIASES)}", "bad_input")
        if col not in headers:
            raise PerfError(f"mapping: the CSV has no column {col!r}", "bad_input")
        out[field] = col
    for field, names in ALIASES.items():
        if field in out:
            continue
        for name in names:
            if name in by_norm and name not in NOT_FIELD and by_norm[name] not in out.values():
                out[field] = by_norm[name]
                break
    return out


_SUFFIX = {"k": 1e3, "m": 1e6, "b": 1e9, "万": 1e4}


TIME_FIELDS = ("avg_view_s", "watch_time_s")


def parse_number(raw, is_time: bool = False) -> float | None:
    """Counts: '1,234' '1.2K' '3.4M' '1.5万' '12%'. Times (is_time): '0:12' '1:02:03' '12.5s' '1h 2m 3s' '12.5'
    -> seconds. A count never reads 'm' as minutes."""
    if raw is None:
        return None
    s = str(raw).strip().replace(" ", " ")
    if s in ("", "-", "--", "N/A", "n/a"):
        return None
    if is_time:
        if re.fullmatch(r"\d+(:\d{1,2}){1,2}(\.\d+)?", s):
            total = 0.0
            for x in s.split(":"):
                total = total * 60 + float(x)
            return total
        m = re.fullmatch(r"(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?", s.lower())
        if m and any(m.groups()):
            h, mi, se = (float(x) if x else 0.0 for x in m.groups())
            return h * 3600 + mi * 60 + se
    s = s.replace(",", "").replace("%", "").strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([kKmMbB万])?", s)
    if not m:
        return None
    return float(m.group(1)) * _SUFFIX.get((m.group(2) or "").lower(), 1)


_TIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d", "%Y/%m/%d",
                 "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y", "%d/%m/%Y %H:%M", "%b %d, %Y %H:%M", "%b %d, %Y",
                 "%a, %b %d, %Y", "%A, %B %d, %Y", "%B %d, %Y", "%Y-%m-%d %H:%M %z", "%Y-%m-%d %H:%M:%S %z")


def parse_time(raw) -> datetime | None:
    """A date/time from an export. One without a zone is taken as Japan time (the audience's clock)."""
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        t = None
        for fmt in _TIME_FORMATS:
            try:
                t = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
    if t is None:
        return None
    return t if t.tzinfo else t.replace(tzinfo=JST)


def _ids_in(text: str) -> set[str]:
    """Ids inside a link or id cell: long digit runs (TikTok, X, Facebook, Pinterest) and path tails."""
    text = str(text or "")
    out = set(re.findall(r"\d{8,}", text))
    tail = text.rstrip("/").rsplit("/", 1)[-1].split("?")[0]
    if len(tail) >= 6:
        out.add(tail)
    return out


def _words(text: str) -> str:
    return re.sub(r"[\s、。,.!！?？「」『』|｜#＃]+", "", str(text or "")).lower()


def _titles(slug: str) -> list[str]:
    from studio.projects import load

    p = load(slug) or {}
    out = [p.get("title_ja"), p.get("yt_title")]
    out += [b.get("ja") for b in p.get("beats") or [] if isinstance(b, dict)]
    return [w for w in (_words(x) for x in out if x) if len(w) >= 4]


def _match(row: dict, candidates: list[dict]) -> tuple[dict | None, str]:
    """The post an export row belongs to: by link/id, then by post time (within 12 h), then by title words."""
    ids = _ids_in(row.get("_link")) | _ids_in(row.get("_id"))
    if ids:
        for p in candidates:
            mine = _ids_in(p.get("url")) | ({str(p["remote_id"])} if p.get("remote_id") else set())
            if ids & mine:
                return p, "link"
    when = parse_time(row.get("_time")) if row.get("_time") else None
    title = _words(row.get("_title"))
    by_title = [p for p in candidates if title and any(t in title or title in t for t in _titles(p["slug"]))] if title else []
    if when and not re.search(r"\d:\d", str(row.get("_time"))):
        # A date without a time (TikTok's overview file, X's daily file): the post that went out that day in Japan.
        day = [p for p in candidates if _when(p.get("at")) and _when(p.get("at")).astimezone(JST).date() == when.date()]
        if len(day) == 1:
            return day[0], "date"
        if len(day) > 1:
            titled = [p for p in day if p in by_title]
            if len(titled) == 1:
                return titled[0], "date and title"
            return None, "more than one post that day; send post_id"
        if len(by_title) == 1:
            return by_title[0], "title"
        return None, "no post on this network that day"
    if when:
        near = sorted((abs((_when(p.get("at")) - when).total_seconds()), p["id"], p) for p in candidates if _when(p.get("at")))
        near = [x for x in near if x[0] <= 12 * 3600]
        if near:
            if len(near) > 1 and by_title:
                titled = [x for x in near if x[2] in by_title]
                if titled:
                    return titled[0][2], "time and title"
            return near[0][2], "time"
    if len(by_title) == 1:
        return by_title[0], "title"
    return None, "no post on this network matches its link, time or title"


def _read_csv(text: str) -> tuple[list[str], list[dict]]:
    text = text.lstrip("﻿")
    lines = text.splitlines()
    # Some exports put a title line above the header: start at the first line with 3+ separators.
    start = next((i for i, l in enumerate(lines[:10]) if max(l.count(","), l.count("\t"), l.count(";")) >= 2), 0)
    body = "\n".join(lines[start:])
    try:
        dialect = csv.Sniffer().sniff(body[:4096], delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(body), dialect=dialect)
    headers = [h for h in (reader.fieldnames or []) if h is not None]
    return headers, [r for r in reader if any((v or "").strip() for v in r.values() if isinstance(v, str))]


def import_csv(req: dict) -> dict:
    from studio.posting import NETWORKS

    network = str(req.get("network") or "")
    if network not in NETWORKS:
        raise PerfError(f"network: one of {', '.join(NETWORKS)}", "bad_input")
    text = req.get("csv")
    if not isinstance(text, str) or not text.strip():
        raise PerfError("csv: paste the exported file's text", "bad_input")
    if len(text) > MAX_CSV:
        raise PerfError("csv: the file is over 2 MB; export a shorter date range", "bad_input")
    headers, rows = _read_csv(text)
    if not headers:
        raise PerfError("csv: no header row found", "bad_input")
    cols = map_columns(headers, req.get("mapping") if isinstance(req.get("mapping"), dict) else None)
    if not any(f in cols for f in FIELDS):
        raise PerfError("csv: none of the columns is a number we know (views, likes, comments, shares, saves, ...). "
                        f"Columns found: {', '.join(headers[:20])}. Send a mapping {{column: field}}.", "bad_input")
    fixed = _post(req["post_id"]) if req.get("post_id") not in (None, "") else None
    if fixed and fixed["network"] != network:
        raise PerfError(f"post {fixed['id']} is on {fixed['network']}, not {network}", "bad_input")
    candidates = [p for p in _posts() if p["network"] == network and p["status"] in LIVE + ("planned",)]
    existing = {(r["post_id"], json.dumps({k: r.get(k) for k in NUMBERS}, sort_keys=True)) for r in readings() if r["source"] == "csv"}
    dry = bool(req.get("dry_run"))
    out, unmatched, dupes = [], [], 0
    for i, raw in enumerate(rows, start=1):
        row = {f: raw.get(c) for f, c in cols.items()}
        numbers = {}
        for f in FIELDS:
            if f in cols:
                v = parse_number(row.get(f), is_time=f in TIME_FIELDS)
                if v is not None and v >= 0:
                    numbers[f] = min(v, 100.0) if f in ("avg_view_pct", "completion_pct") else v
        reposts = parse_number(row.get("_reposts")) if "_reposts" in cols else None
        if reposts is not None:
            numbers["shares"] = numbers.get("shares", 0.0) + reposts
        if not numbers:
            continue
        post, how = (fixed, "chosen") if fixed else _match(row, candidates)
        if not post:
            unmatched.append({"row": i, "title": str(row.get("_title") or "")[:80], "time": row.get("_time"), "link": row.get("_link"), "why": how})
            continue
        key = (post["id"], json.dumps({k: (int(round(numbers[k])) if k in INTS else round(float(numbers[k]), 3)) if k in numbers else None for k in NUMBERS}, sort_keys=True))
        if key in existing:
            dupes += 1
            continue
        existing.add(key)
        rid = next(iter(sorted(_ids_in(row.get("_link")) | _ids_in(row.get("_id")), key=len, reverse=True)), None)
        if dry:
            out.append({"row": i, "post_id": post["id"], "slug": post["slug"], "matchedBy": how, **_clean_numbers(numbers)})
        else:
            stored = store(post, numbers, "csv", extra={"row": i, "matchedBy": how}, remote_id=rid)
            out.append({"row": i, "post_id": post["id"], "slug": post["slug"], "matchedBy": how, "checkpoint": stored["checkpoint"],
                        **{k: stored[k] for k in NUMBERS if stored.get(k) is not None}})
    return {"network": network, "dryRun": dry, "columns": cols, "rows": len(rows), "stored": out, "unmatched": unmatched, "duplicates": dupes,
            "summary": f"{'Would store' if dry else 'Stored'} {len(out)} of {len(rows)} rows for {network}"
                       + (f"; {len(unmatched)} did not match a post (send post_id, or add the post's link with Mark posted)" if unmatched else "")
                       + (f"; {dupes} already imported" if dupes else "") + "."}


# ---------- per reel ----------

def reel(slug: str) -> dict:
    from studio.learn import comparable, reel_features
    from studio.projects import load

    if not slug or not re.fullmatch(r"[a-z0-9-]+", slug):
        raise PerfError("slug: the reel's name, lower case letters, digits and dashes", "bad_input")
    project = load(slug) or {}
    now = _now()
    rows = readings(slug=slug)
    comp = comparable()
    out = []
    for p in _posts():
        if p["slug"] != slug or p["network"] == "all":
            continue
        mine = [r for r in rows if r["post_id"] == p["id"]]
        t = _when(p.get("at"))
        live = p["status"] in LIVE and t is not None and t <= now
        unit = comp["byPost"].get(p["id"])
        out.append({"post_id": p["id"], "network": p["network"], "status": p["status"], "at": p["at"], "url": p.get("url"), "live": live,
                    "age_h": round((now - t).total_seconds() / 3600, 1) if live else None,
                    "latest": {k: mine[-1].get(k) for k in ("fetched_at", "checkpoint", "source", *NUMBERS)} if mine else None,
                    "readings": mine,
                    "vsMedian": unit and {"metric": unit["metric"], "value": unit["value"], "median": unit["median"], "ratio": unit["ratio"],
                                          "sentence": unit["sentence"]},
                    "canCollect": p["network"] in COLLECTORS})
    return {"slug": slug, "features": reel_features(project, None) if project else None, "posts": out}


def status() -> dict:
    out = {}
    for net, col in COLLECTORS.items():
        ok, why = col.ready()
        out[net] = {"name": col.name, "ready": ok, "why": why or None}
        if net == "youtube" and ok:
            out[net]["analytics"] = col.analytics()
    st = _state()
    with connect() as con:
        _ready(con)
        n = con.execute("SELECT COUNT(*) AS n FROM metrics").fetchone()["n"]
    return {"collectors": out, "lastRun": st.get("last_at"), "readings": n, "checkpoints": [c for c, _ in CHECKPOINTS],
            "csvFields": list(ALIASES)}


# ---------- reach: is it working? ----------

REACH_DAYS = 60
FEW, SOME = 20, 200  # views a post: under 20 is very few for a short video, 200 and up is being seen (a rough guide)
# A network is "stalled" (not showing the posts at all) when at least this many measured posts, the oldest at least
# this many hours out, all have no views and no reactions. A new post can sit at 0 for its first hours; days cannot.
STALL_POSTS, STALL_H = 3, 48
# A booking dropped because the account it was on was deleted (24 Nov: the old Singapore-region TikTok was deleted and
# its bookings were dropped with a note saying so): the posts before it went out on the old account.
GONE_ACCOUNT = re.compile(r"deleted|削除", re.I)
ACCOUNT_WORD = re.compile(r"@|account|アカウント", re.I)


def account_since(posts: list[dict], saved: dict | None = None) -> dict[str, datetime]:
    """Per network, when the account in use now started: networks.json "since" (the server writes it when a network's
    account name changes on Settings › Accounts), else the earliest booking dropped because the old account was deleted.
    Posts before it went out on another account: they stay in the log, but say nothing about whether the account in
    use now is being shown (24 Nov: 13 posts on a deleted TikTok at 0 views kept calling the new account unseen)."""
    if saved is None:
        from studio.config import DATA

        try:
            saved = json.loads((DATA / "networks.json").read_text(encoding="utf-8")).get("since") or {}
        except (OSError, ValueError, AttributeError):
            saved = {}
    out: dict[str, datetime] = {n: t for n, t in ((n, _when(at)) for n, at in (saved or {}).items()) if t}
    dropped: dict[str, datetime] = {}
    for p in posts:
        note, t = str(p.get("note") or ""), _when(p.get("at"))
        if p.get("status") == "dropped" and t and GONE_ACCOUNT.search(note) and ACCOUNT_WORD.search(note):
            dropped[p["network"]] = min(t, dropped.get(p["network"], t))
    for n, t in dropped.items():
        out.setdefault(n, t)
    return out


def reach(days: int = REACH_DAYS, now: datetime | None = None, since: dict | None = None) -> dict:
    """Per network, over the posts that went out in the last `days`: how many are out and measured, views and reactions
    (the latest reading of each post), how many got nothing, the best post, and a plain verdict:
    working / some / few / none (nobody seen or reacted) / unmeasured. The owner, 14 Nov: "i still dont understand if the
    posted reels did a good job or bad job" (the Results page said "0 views, 1.0x a typical post")."""
    from studio import posting

    now = now or _now()
    latest: dict[int, dict] = {}
    for r in readings():
        latest[int(r["post_id"])] = r
    nets: dict[str, dict] = {}
    posts = posting.posts()
    gone = retired(posts)
    fresh = account_since(posts) if since is None else {n: t for n, t in ((n, _when(v) if isinstance(v, str) else v) for n, v in since.items()) if t}
    new = lambda net: {"network": net, "out": 0, "measured": 0, "views": 0, "hasViews": False,  # noqa: E731
                       "likes": 0, "comments": 0, "shares": 0, "saves": 0, "zero": 0, "best": None, "oldestH": 0.0, "since": None}
    for p in posts:
        at = _when(p.get("at"))
        if p.get("status") != "posted" or not at or at > now or (now - at).days > days or int(p["id"]) in gone:
            continue
        if p["network"] in fresh and at < fresh[p["network"]]:
            # on the account used before: kept as history, never part of this account's verdict
            n = nets.setdefault(p["network"], new(p["network"]))
            n["history"] = n.get("history", 0) + 1
            continue
        n = nets.setdefault(p["network"], new(p["network"]))
        n["out"] += 1
        r = latest.get(int(p["id"]))
        if not r:
            continue
        n["measured"] += 1
        n["oldestH"] = max(n["oldestH"], round((now - at).total_seconds() / 3600, 1))
        if not n["since"] or at < _when(n["since"]):
            n["since"] = p["at"]
        v = r.get("views")
        if v is not None:
            n["hasViews"] = True
        eng = sum(int(r.get(k) or 0) for k in ("likes", "comments", "shares", "saves"))
        for k in ("likes", "comments", "shares", "saves"):
            n[k] += int(r.get(k) or 0)
        n["views"] += int(v or 0)
        if not v and not eng:
            n["zero"] += 1
        score = int(v or 0) + eng
        if score and (not n["best"] or score > n["best"]["score"]):
            n["best"] = {"slug": p["slug"], "url": p.get("url") or "", "views": v, "reactions": eng, "score": score}
    for n in nets.values():
        n["reactions"] = n["likes"] + n["comments"] + n["shares"] + n["saves"]
        m = n["measured"]
        if not m:
            n["verdict"] = "unmeasured"
        elif n["hasViews"]:
            avg = n["views"] / m
            n["avgViews"] = round(avg, 1)
            n["verdict"] = "none" if not n["views"] and not n["reactions"] else "few" if avg < FEW else "some" if avg < SOME else "working"
            if n["views"]:
                n["reactedPct"] = round(100 * n["reactions"] / n["views"], 1)
        else:  # a network that gives no view count (Bluesky): reactions only
            n["verdict"] = "none" if not n["reactions"] else "few" if n["reactions"] / m < 3 else "some"
        # Stalled: several posts, days old, and every one still at nothing. That is the network not showing them (an
        # account limit, a new account with no followers, a setting), not a weak reel, and better reels will not fix it.
        # 16 Nov: TikTok 15 posts at 0 views, Facebook 6 reels at 0 plays, while YouTube had 130-1,265 views a Short.
        n["stalled"] = n["verdict"] == "none" and m >= STALL_POSTS and n["oldestH"] >= STALL_H
        if n["network"] in fresh:
            n["accountSince"] = fresh[n["network"]].isoformat(timespec="minutes")
    order ={"working": 0, "some": 1, "few": 2, "none": 3, "unmeasured": 4}
    rows = sorted(nets.values(), key=lambda x: (order[x["verdict"]], -x["views"], -x["reactions"]))
    return {"days": days, "networks": rows, "fewViews": FEW, "someViews": SOME,
            "totals": {"out": sum(x["out"] for x in rows), "measured": sum(x["measured"] for x in rows),
                       "views": sum(x["views"] for x in rows), "reactions": sum(x["reactions"] for x in rows)}}


def _channel_index() -> dict | None:
    """From the last channel read (Results › YouTube channel, no new request): every listed video's title, how far back
    the list reaches, and when it was read. None when there is no read, or a channel in it could not be read."""
    from studio.config import DATA

    try:
        got = json.loads((DATA / "perf" / "channel.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    chans = got.get("channels") or []
    if not chans or any(c.get("error") for c in chans):
        return None
    titles, since = {}, None
    for c in chans:
        items = c.get("items") or []
        for v in items:
            titles[v["id"]] = v.get("title") or ""
        if len(items) >= CHANNEL_MAX:  # the list stops at the newest CHANNEL_MAX: older posts cannot be judged
            oldest = min((_when(v.get("at")) for v in items if _when(v.get("at"))), default=None)
            since = max(since, oldest) if since and oldest else (oldest or since)
    return {"titles": titles, "since": since, "read": _when(got.get("at"))}


def _upload_title(slug: str, vid: str) -> str | None:
    """The title the studio gave a long video when it uploaded it: the channel list is read at most every few hours,
    and a part uploaded since showed as "vlog-4" (15 Nov)."""
    from studio.config import DATA

    try:
        up = json.loads((DATA / "renders" / "vlogs" / slug / "uploaded.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return up.get("title") if up.get("id") == vid else None


def retired(posts: list[dict], index: dict | None = None) -> dict[int, str]:
    """Posts that no longer count, by id: "replaced" (a newer upload of the same reel or video on the same network: the
    trip series was built again and uploaded anew) and "removed" (a YouTube video the channel no longer lists: the old
    episodes were deleted, 12-15 Nov). Results counted both: one series showed every episode three times."""
    out: dict[int, str] = {}
    newest: dict[tuple, dict] = {}
    live = [p for p in posts if p.get("status") == "posted" and _when(p.get("at"))]
    for p in live:
        k = (p["slug"], p["network"])
        if k not in newest or _when(p["at"]) > _when(newest[k]["at"]):
            newest[k] = p
    for p in live:
        if newest[(p["slug"], p["network"])] is not p:
            out[int(p["id"])] = "replaced"
    idx = index if index is not None else _channel_index()
    if idx and idx.get("read"):
        for p in live:
            vid = youtube_id(p) if p.get("network") == "youtube" else None
            at = _when(p["at"])
            # only a video that was already up when the channel was read, inside the stretch the list covers
            if vid and int(p["id"]) not in out and vid not in idx["titles"] and at < idx["read"] - timedelta(minutes=30) and (not idx["since"] or at >= idx["since"]):
                out[int(p["id"])] = "removed"
    return out


def table(days: int = 90, now: datetime | None = None) -> dict:
    """Every post that went out in the last `days`, newest first, with its latest numbers: Results › Every post.
    One row per post (a reel on five networks is five rows); `best` marks the top post of each network by views,
    else by reactions. Owner, 14 Nov: "make sure all the above performance should be able to see on the console"."""
    from studio import posting

    now = now or _now()
    latest: dict[int, dict] = {}
    for r in readings():
        latest[int(r["post_id"])] = r
    rows = []
    posts = posting.posts()
    idx = _channel_index()
    gone = retired(posts, idx or {})
    for p in posts:
        at = _when(p.get("at"))
        if p.get("status") != "posted" or not at or at > now or (now - at).days > days:
            continue
        r = latest.get(int(p["id"])) or {}
        vid = youtube_id(p) if p.get("network") == "youtube" else None
        extra = r.get("extra") or {}
        nums = {k: r.get(k) for k in ("views", "likes", "comments", "shares", "saves", "watch_time_s", "avg_view_pct", "avg_view_s", "reach")}
        reactions = sum(int(r.get(k) or 0) for k in ("likes", "comments", "shares", "saves")) if r else None
        rows.append({"id": int(p["id"]), "slug": p["slug"], "network": p["network"], "at": p.get("at"), "url": p.get("url") or "",
                     **nums, "engaged": extra.get("engaged_views"), "reactions": reactions, "read": r.get("fetched_at"),
                     "source": r.get("source"), "measured": bool(r), "video": vid,
                     "title": ((idx or {}).get("titles", {}).get(vid) or _upload_title(p["slug"], vid)) if vid else None,
                     **({"retired": gone[int(p["id"])]} if int(p["id"]) in gone else {})})
    for net in {x["network"] for x in rows}:
        mine = [x for x in rows if x["network"] == net and x["measured"] and not x.get("retired")]
        top = max(mine, key=lambda x: (x["views"] or 0, x["reactions"] or 0), default=None)
        if top and ((top["views"] or 0) or (top["reactions"] or 0)):
            top["best"] = True
    rows.sort(key=lambda x: x["at"] or "", reverse=True)
    return {"days": days, "rows": rows, "networks": sorted({x["network"] for x in rows}), "week": week_views(posts, gone, now)}


# WEEKLY VIEWS: the one definition (Track B, 24 Nov). Reels › Today said "2,181, ▼54% vs 4,782" while Results said
# "3,146, ▼23% vs 4,064": two sums (calendar days vs 7×24 h, replaced uploads in or out) and both compared a week still
# gaining views with a week that had finished. Both pages now show this one number (editor.html weekViews()).
WEEK_MIN_SEEN = 3  # under 3 posts with views last week there is no base for a percentage (16 Nov: "▲ 1307%" on one post)


def week_views(posts: list[dict] | None = None, gone: dict | None = None, now: datetime | None = None,
               reads: list[dict] | None = None) -> dict:
    """Views this week, said one way everywhere: the views so far on the posts that went out in the last 7 days
    (7×24 hours up to now), against what the posts of the 7 days before had at this same point last week (each one's
    newest reading taken by then). Like with like: posts keep gaining views for days, so last week's finished numbers
    against this week's young ones would always read as a drop. Replaced and removed uploads are left out (retired).
    {now, before: {views, posts, seen, measured}, beforeNow (those posts' views today), pct (None without a base), from, to}."""
    from studio import posting

    now = now or _now()
    posts = posting.posts() if posts is None else posts
    gone = retired(posts) if gone is None else gone
    then = now - timedelta(days=7)
    by: dict[int, list[tuple[datetime, dict]]] = {}
    for r in (readings() if reads is None else reads):
        t = _when(r.get("fetched_at"))
        if t:
            by.setdefault(int(r["post_id"]), []).append((t, r))
    zero = lambda: {"views": 0, "posts": 0, "seen": 0, "measured": 0}  # noqa: E731
    week, before, before_now = zero(), zero(), 0
    for p in posts:
        at = _when(p.get("at"))
        if p.get("status") != "posted" or not at or at > now or int(p["id"]) in gone or p.get("network") == "all":
            continue
        age = now - at
        if age >= timedelta(days=14):
            continue
        got = sorted(by.get(int(p["id"]), []), key=lambda x: x[0])
        if age < timedelta(days=7):
            bucket, r = week, (got[-1][1] if got else None)
        else:
            older = [x for x in got if x[0] <= then]
            bucket, r = before, (older[-1][1] if older else None)
            before_now += int((got[-1][1].get("views") if got else 0) or 0)
        v = int((r or {}).get("views") or 0)
        bucket["posts"] += 1
        bucket["measured"] += 1 if r else 0
        bucket["views"] += v
        bucket["seen"] += 1 if v > 0 else 0
    pct = round(100 * (week["views"] - before["views"]) / before["views"]) if before["views"] > 0 and before["seen"] >= WEEK_MIN_SEEN else None
    return {"now": week, "before": before, "beforeNow": before_now, "pct": pct, "minSeen": WEEK_MIN_SEEN,
            "from": then.isoformat(timespec="minutes"), "to": now.isoformat(timespec="minutes")}


CHANNEL_CACHE_S = 3 * 3600   # the channel table is read at most every 3 hours ({fresh: true} asks again)
CHANNEL_MAX = 200            # newest uploads listed per channel (4 quota units for the list, 4 for the numbers)
SHORT_MAX_S = 180            # YouTube counts videos up to 3 minutes as Shorts


def _iso_seconds(d: str) -> int | None:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", d or "")
    if not m or not any(m.groups()):
        return 0 if d in ("P0D", "PT0S") else None
    dd, h, mi, s = (int(x or 0) for x in m.groups())
    return dd * 86400 + h * 3600 + mi * 60 + s


def channel(req: dict | None = None) -> dict:
    """Every connected YouTube channel: its totals and its newest uploads (Shorts, long videos, live) with views,
    likes and comments, and watch time and % watched from YouTube Analytics where the sign-in allows it. Videos the
    studio posted carry their reel's name. Cached CHANNEL_CACHE_S; {fresh: true} reads again."""
    from studio import youtube as y
    from studio.config import DATA

    req = req or {}
    cache = DATA / "perf" / "channel.json"
    if not req.get("fresh"):
        try:
            got = json.loads(cache.read_text(encoding="utf-8"))
            if time.time() - float(got.get("_at", 0)) < CHANNEL_CACHE_S:
                return {**got, "history": channel_history()}
        except (OSError, ValueError):
            pass
    reels: dict[str, str] = {}
    try:
        from studio import posting

        for p in posting.posts():
            vid = youtube_id(p) if p.get("network") == "youtube" else None
            if vid:
                reels[vid] = p["slug"]
    except Exception:  # noqa: BLE001 - no posting log: titles only
        pass
    out, keep = [], y.ACCOUNT
    collector = YouTube()
    try:
        for a in y.accounts():
            if a.get("error"):
                continue
            y.use(a["id"])
            try:
                status, j = collector._get(f"{YT_API}/channels?part=snippet,statistics,contentDetails&mine=true")
            except PerfError as err:
                out.append({"account": a["id"], "error": str(err)})
                continue
            if status != 200 or not j.get("items"):
                out.append({"account": a["id"], "error": YouTube._error(status, j)})
                continue
            ch = j["items"][0]
            st = ch.get("statistics") or {}
            uploads = ch["contentDetails"]["relatedPlaylists"]["uploads"]
            ids, tok = [], None
            while len(ids) < CHANNEL_MAX:
                q = {"part": "contentDetails", "playlistId": uploads, "maxResults": 50, **({"pageToken": tok} if tok else {})}
                status, pj = collector._get(f"{YT_API}/playlistItems?" + urllib.parse.urlencode(q))
                if status != 200:
                    break
                ids += [i["contentDetails"]["videoId"] for i in pj.get("items", [])]
                tok = pj.get("nextPageToken")
                if not tok:
                    break
            vids = []
            for k in range(0, len(ids), 50):
                status, vj = collector._get(f"{YT_API}/videos?" + urllib.parse.urlencode(
                    {"part": "snippet,statistics,status,contentDetails,liveStreamingDetails", "id": ",".join(ids[k:k + 50])}))
                if status != 200:
                    continue
                for v in vj.get("items", []):
                    s, sn = v.get("statistics") or {}, v.get("snippet") or {}
                    sec = _iso_seconds((v.get("contentDetails") or {}).get("duration") or "")
                    live = sn.get("liveBroadcastContent") in ("live", "upcoming") or bool(v.get("liveStreamingDetails"))
                    # just uploaded: YouTube says P0D until it has processed the file (15 Nov: a 12-minute episode listed as a Short)
                    processing = not live and (not sec or (v.get("status") or {}).get("uploadStatus") not in (None, "processed"))
                    kind = "live" if live else "processing" if processing else "short" if sec <= SHORT_MAX_S else "long"
                    vids.append({"id": v["id"], "title": sn.get("title") or "", "at": sn.get("publishedAt") or "", "seconds": sec,
                                 "kind": kind, "privacy": (v.get("status") or {}).get("privacyStatus"), "booked": (v.get("status") or {}).get("publishAt"),
                                 "views": _int(s.get("viewCount")) or 0, "likes": _int(s.get("likeCount")), "comments": _int(s.get("commentCount")),
                                 "slug": reels.get(v["id"]),
                                 "url": f"https://www.youtube.com/{'shorts/' if kind == 'short' else 'watch?v='}{v['id']}"})
            note = _channel_analytics(collector, vids, ch["snippet"].get("publishedAt")) if collector.analytics() and vids else None
            by_kind = {}
            for kname in ("short", "long", "live"):
                mine = [v for v in vids if v["kind"] == kname and v["privacy"] == "public"]
                if mine:
                    by_kind[kname] = {"videos": len(mine), "views": sum(v["views"] for v in mine), "likes": sum(v["likes"] or 0 for v in mine),
                                      "comments": sum(v["comments"] or 0 for v in mine), "median": sorted(v["views"] for v in mine)[len(mine) // 2]}
            out.append({"account": a["id"], "channel": ch["snippet"].get("title"), "handle": ch["snippet"].get("customUrl"),
                        "subscribers": _int(st.get("subscriberCount")), "views": _int(st.get("viewCount")), "videos": _int(st.get("videoCount")),
                        "listed": len(vids), "byKind": by_kind, "items": vids, "analytics": collector.analytics(), "note": note})
    finally:
        y.use(keep)
    got = {"channels": out, "at": _now().isoformat(timespec="seconds"), "_at": time.time()}
    if out:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(got, ensure_ascii=False), encoding="utf-8")
        record_channel_day(out)
    return {**got, "history": channel_history()}


# ---------- channel history (BL-058) ----------
# channel.json is overwritten on every read, so subscribers and views had no history (PDCA 21 Nov). One row per
# channel per JST day, the first read of that day, is appended to <DATA>/channel-history.jsonl and never rewritten.

def _channel_history_file() -> Path:
    from studio.config import DATA

    return DATA / "channel-history.jsonl"


def channel_history(days: int = 400) -> list[dict]:
    """The daily rows, oldest first, the last `days` days (a bad line is skipped)."""
    try:
        lines = _channel_history_file().read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("date"):
            rows.append(row)
    since = (_now().astimezone(JST).date() - timedelta(days=days)).isoformat()
    return [r for r in rows if str(r["date"]) >= since]


def record_channel_day(channels: list[dict], when: datetime | None = None) -> list[dict]:
    """Append today's (JST) totals for each channel read without an error, unless that channel has a row for today.
    Returns the rows added."""
    when = (when or _now()).astimezone(JST)
    day = when.date().isoformat()
    have = {(r.get("date"), r.get("account")) for r in channel_history(days=2)}
    rows = []
    for c in channels:
        if c.get("error") or (day, c.get("account")) in have:
            continue
        kinds = c.get("byKind") or {}
        rows.append({"date": day, "at": when.isoformat(timespec="seconds"), "account": c.get("account"), "channel": c.get("channel"),
                     "subscribers": c.get("subscribers"), "views": c.get("views"), "videos": c.get("videos"),
                     **{f"{k}Views": (kinds.get(k) or {}).get("views") for k in ("short", "long", "live")}})
    if rows:
        f = _channel_history_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        with f.open("a", encoding="utf-8") as fh:
            fh.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    return rows


def _channel_analytics(collector: "YouTube", vids: list[dict], since: str | None) -> str | None:
    """Watch time, average % watched and engaged views per video, in one Analytics report (the top 200 by views)."""
    start = (since or "2005-04-23")[:10]
    end = _now().astimezone(JST).date().isoformat()
    metrics = ["views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "shares", "subscribersGained"]
    j: dict = {}
    for attempt in (metrics, [m for m in metrics if m != "engagedViews"]):
        q = {"ids": "channel==MINE", "startDate": start, "endDate": end, "metrics": ",".join(attempt), "dimensions": "video",
             "sort": "-views", "maxResults": 200}
        status, j = collector._get(f"{YT_ANALYTICS}?{urllib.parse.urlencode(q)}")
        if status == 200:
            break
        if status == 400 and "engagedViews" in attempt:
            continue
        if status == 403:
            return "YouTube Analytics refused: enable the YouTube Analytics API for the studio's Google app, then Connect YouTube again."
        return "YouTube Analytics did not answer: watch time is left out."
    names = [h.get("name") for h in j.get("columnHeaders", [])]
    by = {row[0]: dict(zip(names, row)) for row in (j.get("rows") or [])}
    for v in vids:
        r = by.get(v["id"])
        if not r:
            continue
        minutes = _float(r.get("estimatedMinutesWatched"))
        v.update({"watchMin": round(minutes) if minutes is not None else None, "avgPct": _float(r.get("averageViewPercentage")),
                  "avgS": _float(r.get("averageViewDuration")), "engaged": _int(r.get("engagedViews")), "shares": _int(r.get("shares")),
                  "subs": _int(r.get("subscribersGained"))})
    return None


# ---------- what the numbers say (Results › How reels did) ----------
# The owner, 18 Nov: "check if the reels are doing well … any other optimisation". The answers came from reading the
# channel table by hand: which openings broke out, how much of a Short people watch, that the live converts and the
# Shorts do not, which networks post to a small personal account, the Story numbers nobody reads. insights() works
# them out each time, numbers only; the page says them in the owner's language (server/editor.html resInsights).

INSIGHT_MIN_SHORTS = 4     # fewer Shorts than this: no pattern to speak of
PHRASE_MIN = 3             # a phrase counts only with at least 3 Shorts that have it and 2 that do not
STALL_SHARE = 0.05         # a Short a day old with under 5 % of the median views was shown to almost nobody
SHORT_SPLIT_S = 15         # "short" vs "long" Shorts for the watch comparison


def _median(xs: list[float]) -> float | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    mid = len(xs) // 2
    return float(xs[mid]) if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2


def opener(title: str) -> str:
    """The first clause of a title, where the hook sits: 「静かだからこそ、よく話せる。｜Cafe Kumo」 -> 静かだからこそ."""
    head = re.split(r"[｜|]", str(title or ""), maxsplit=1)[0]
    return re.split(r"[。、,，.!?！？:：]", head, maxsplit=1)[0].strip()


def hook_phrase(shorts: list[dict]) -> dict | None:
    """The opening phrase whose Shorts did best against the ones without it: every 2-6 character piece of the openers,
    kept when PHRASE_MIN Shorts have it and 2 do not, ranked by median views with it ÷ without it (the longest piece
    wins among pieces found in the same Shorts). A pattern to test, not proof: the page says how many Shorts it rests on."""
    ops = [(opener(s.get("title")), s) for s in shorts]
    grams: dict[str, set[int]] = {}
    for i, (op, _) in enumerate(ops):
        for n in range(2, 7):
            for k in range(0, max(0, len(op) - n + 1)):
                g = op[k:k + n]
                if re.search(r"[\s\W\d]", g):
                    continue
                grams.setdefault(g, set()).add(i)
    best = None
    for g, idx in grams.items():
        if len(idx) < PHRASE_MIN or len(ops) - len(idx) < 2:
            continue
        w = _median([ops[i][1]["views"] for i in idx])
        wo = _median([ops[i][1]["views"] for i in range(len(ops)) if i not in idx])
        lift = (w or 0) / max(1.0, wo or 0)
        # Lifts within half a step are a tie: the phrase more Shorts share wins (「からこそ」 in 7, not 「いからこそ」 in 5),
        # then the longest piece of that same set.
        key = (math.floor(lift * 2) / 2, len(idx), len(g))
        if lift >= 2 and (best is None or key > best[0]):
            best = (key, g, idx, w, wo)
    if not best:
        return None
    _, g, idx, w, wo = best
    with_ = sorted((ops[i][1] for i in idx), key=lambda s: -s["views"])
    return {"phrase": g, "lift": round((w or 0) / max(1.0, wo or 0), 1), "with": {"n": len(idx), "median": round(w or 0)},
            "without": {"n": len(ops) - len(idx), "median": round(wo or 0)},
            "examples": [{"slug": s.get("slug"), "opener": opener(s.get("title")), "views": s["views"]} for s in with_[:4]]}


def _handle(url: str, network: str) -> str | None:
    pats = {"bluesky": r"bsky\.app/profile/([^/?#]+)", "x": r"(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})/status"}
    m = re.search(pats.get(network, r"$^"), str(url or ""))
    return m.group(1) if m else None


def _bsky_followers(handle: str) -> int | None:
    try:
        status, _, body = _http("GET", f"{BSKY_APPVIEW}/app.bsky.actor.getProfile?" + urllib.parse.urlencode({"actor": handle}), timeout=8)
    except PerfError:
        return None
    return _int(_json(body).get("followersCount")) if status == 200 else None


def _related_path() -> Path:
    from studio.config import DATA

    return DATA / "perf" / "related.json"


def related_done() -> dict[str, str]:
    try:
        got = json.loads(_related_path().read_text(encoding="utf-8"))
        return {str(k): str(v) for k, v in got.items()} if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def mark_related(req: dict) -> dict:
    """The owner set (or cleared) a Short's Related video in YouTube Studio; the API cannot set or read it, so the
    studio keeps the tick. {id: <video id>, done: bool}."""
    vid = str(req.get("id") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", vid):
        raise PerfError("that is not a YouTube video id", "bad_input")
    done = related_done()
    if req.get("done", True):
        done[vid] = _now().isoformat(timespec="seconds")
    else:
        done.pop(vid, None)
    path = _related_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(done, indent=1), encoding="utf-8")
    return {"id": vid, "done": vid in done, "count": len(done)}


def insights_from(chan: dict | None, reach_rows: list[dict], posts: list[dict], story_rows: list[dict], problems: dict,
                  related: dict[str, str], now: datetime, followers=None) -> dict:
    """The numbers behind each takeaway; pure, so the tests feed it. chan: channel(); reach_rows: reach()["networks"];
    posts: the posting log; story_rows: the latest reading of each Instagram Story; problems: collect()'s last problem
    per network; related: mark_related's ticks; followers(handle) -> int | None for Bluesky."""
    out: dict = {"at": now.isoformat(timespec="seconds")}
    items = [v for c in (chan or {}).get("channels") or [] for v in c.get("items") or []]
    day_old = lambda v: (_when(v.get("at")) or now) <= now - timedelta(hours=24)
    pub = [v for v in items if v.get("privacy") == "public" and isinstance(v.get("views"), (int, float))]
    mine = [v for v in pub if v.get("kind") == "short" and v.get("slug") and day_old(v)]
    if len(mine) >= INSIGHT_MIN_SHORTS:
        med = _median([v["views"] for v in mine]) or 0
        y: dict = {"shorts": len(mine), "median": round(med)}
        y["hook"] = hook_phrase(mine)
        y["stalled"] = [{"slug": v["slug"], "id": v.get("id"), "title": v.get("title"), "views": v["views"], "seconds": v.get("seconds")}
                        for v in mine if med > 0 and v["views"] < STALL_SHARE * med]
        y["top"] = [{"slug": v["slug"], "id": v.get("id"), "opener": opener(v.get("title")), "views": v["views"]}
                    for v in sorted(mine, key=lambda v: -v["views"])[:3]]
        watched = [v for v in mine if isinstance(v.get("avgPct"), (int, float)) and v.get("seconds")]
        if len(watched) >= 3:
            part = lambda xs: {"n": len(xs), "pct": round(_median([min(v["avgPct"], 200) for v in xs]) or 0),
                               "views": round(_median([v["views"] for v in xs]) or 0)} if xs else None
            y["watch"] = {"n": len(watched), "pct": round(_median([min(v["avgPct"], 200) for v in watched]) or 0),
                          "avgS": round(_median([v["avgS"] for v in watched if isinstance(v.get("avgS"), (int, float))]) or 0, 1),
                          "seconds": round(_median([v["seconds"] for v in watched]) or 0),
                          "split": SHORT_SPLIT_S,
                          "short": part([v for v in watched if v["seconds"] <= SHORT_SPLIT_S]),
                          "long": part([v for v in watched if v["seconds"] > SHORT_SPLIT_S])}
        out["youtube"] = y
    shorts_all = [v for v in pub if v.get("kind") == "short"]
    lives = [v for v in pub if v.get("kind") == "live"]
    sum_ = lambda xs, k: sum(int(v.get(k) or 0) for v in xs)
    if shorts_all and any(v.get("subs") is not None for v in shorts_all + lives):
        live = max(lives, key=lambda v: v["views"], default=None)
        out["convert"] = {"shorts": {"n": len(shorts_all), "views": sum_(shorts_all, "views"), "subs": sum_(shorts_all, "subs"),
                                     "likes": sum_(shorts_all, "likes"), "comments": sum_(shorts_all, "comments")},
                          "live": {"n": len(lives), "views": sum_(lives, "views"), "subs": sum_(lives, "subs"),
                                   "title": live.get("title"), "id": live.get("id"), "url": live.get("url")} if live else None}
    todo = sorted((v for v in pub if v.get("kind") == "short" and v.get("slug")), key=lambda v: str(v.get("at") or ""), reverse=True)
    out["related"] = {"done": sum(1 for v in todo if v.get("id") in related), "of": len(todo),
                      "items": [{"id": v.get("id"), "slug": v.get("slug"), "title": v.get("title"), "views": v["views"],
                                 "done": v.get("id") in related} for v in todo[:24]]}
    others = [v for v in pub if v.get("kind") == "short" and not v.get("slug") and (_when(v.get("at")) or now) >= now - timedelta(days=30)]
    if len(others) >= 3 and mine:
        out["outside"] = {"n": len(others), "median": round(_median([v["views"] for v in others]) or 0),
                          "studio": round(_median([v["views"] for v in mine]) or 0)}
    # Accounts that hold the posts back: networks posting to an account few people follow.
    accts = []
    by_net = {r["network"]: r for r in reach_rows}
    for net in ("bluesky", "x"):
        r = by_net.get(net)
        if not r or r.get("verdict") not in ("none", "few"):
            continue
        urls = [p.get("url") for p in sorted(posts, key=lambda p: str(p.get("at") or ""), reverse=True)
                if p.get("network") == net and p.get("status") == "posted" and p.get("url")]
        handle = next((h for h in (_handle(u, net) for u in urls) if h), None)
        if not handle:
            continue
        fol = followers(handle) if (followers and net == "bluesky") else None
        accts.append({"network": net, "handle": handle, "followers": fol, "posts": r.get("out"), "views": r.get("views"),
                      "reactions": r.get("reactions")})
    if accts:
        out["accounts"] = accts
    # Instagram Stories: what the last 7 days' Stories did, or what stops the studio reading them.
    week = [p for p in posts if p.get("network") == "instagram-story" and p.get("status") == "posted"
            and (_when(p.get("at")) or now) >= now - timedelta(days=7)]
    if week:
        # Only this week's Stories: an older Story's last reading would count against this week's posts.
        week_ids = {int(p["id"]) for p in week if str(p.get("id", "")).isdigit()}
        story_rows = [r for r in story_rows if int(r.get("post_id") or -1) in week_ids]
        nav: dict[str, int] = {}
        for r in story_rows:
            for k, v in ((r.get("extra") or {}).get("navigation") or {}).items():
                nav[k] = nav.get(k, 0) + int(v or 0)
        total = sum(nav.values())
        prob = problems.get("instagram-story") or {}
        out["stories"] = {"out": len(week), "read": len(story_rows), "views": sum(int(r.get("views") or 0) for r in story_rows),
                          "reach": sum(int(r.get("reach") or 0) for r in story_rows),
                          "exitPct": round(100 * nav.get("tap_exit", 0) / total) if total else None,
                          "onPct": round(100 * (nav.get("tap_forward", 0) + nav.get("swipe_forward", 0)) / total) if total else None,
                          "need": "permission" if prob.get("code") == "permission" else "connect" if prob.get("code") == "auth" else None}
    return out


def insights(req: dict | None = None) -> dict:
    now = _now()
    try:
        chan = channel({})
    except Exception:  # noqa: BLE001 - YouTube offline or not connected: the other takeaways still stand
        chan = None
    latest: dict[int, dict] = {}
    for r in readings():
        if r.get("network") == "instagram-story":
            latest[int(r["post_id"])] = r
    from studio import posting

    return insights_from(chan, reach(now=now)["networks"], posting.posts(), list(latest.values()),
                         _state().get("problems") or {}, related_done(), now, followers=_bsky_followers)


# ---------- CLI ----------

def run(action: str, req: dict) -> object:
    from studio import learn

    if action == "get":
        return reel(str(req.get("slug") or ""))
    if action == "summary":
        return learn.summary(network=req.get("network") or None)
    if action == "suggest":
        return learn.suggest(network=req.get("network") or None, n=req.get("n", 3), explore=req.get("explore"), seed=req.get("seed"))
    if action == "collect":
        return collect(req)
    if action == "manual":
        return manual(req)
    if action == "needs":
        return needs(req)
    if action == "import":
        return import_csv(req)
    if action == "status":
        return status()
    if action == "table":
        return table(int(req.get("days") or 90))
    if action == "channel":
        return channel(req)
    if action == "reach":
        return reach()
    if action == "insights":
        return insights(req)
    if action == "related":
        return mark_related(req)
    if action in ("predictions", "scores"):
        from studio import predict
        from studio.service import _overview

        rows = _overview()["reels"]
        return predict.report(rows) if action == "predictions" else predict.scores(rows)
    raise PerfError(f"unknown action {action!r}", "bad_input")


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    action = argv[0] if argv else ""
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        try:
            req = json.loads(raw or "{}")
        except ValueError:
            raise PerfError("The request was not valid JSON.", "bad_input") from None
        if not isinstance(req, dict):
            raise PerfError("The request must be a JSON object.", "bad_input")
        out = {"ok": True, "data": run(action, req)}
    except PerfError as err:
        out = {"ok": False, "error": _scrub(str(err)), "code": err.code, "status": err.status}
    except Exception as err:  # a bug: keep the type and place, never a token
        import traceback

        where = traceback.extract_tb(err.__traceback__)[-1]
        out = {"ok": False, "error": _scrub(f"Performance stopped on a problem in the studio: {type(err).__name__}: {err} ({Path(where.filename).name}:{where.lineno})"),
               "code": "bug", "status": 500}
    sys.stdout.write("RESULT " + json.dumps(out, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
