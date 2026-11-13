"""
FILE: py/studio/perf.py
PURPOSE: How each reel did on each network: a metrics store with snapshots over time, collectors for the
         networks the studio can read (YouTube, Facebook, Bluesky), manual entry and CSV import for the rest
         (TikTok, X, Pinterest, Google Maps, LINE, LinkedIn, Threads, Instagram).
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
    for p in _posts():
        if p["network"] == "all" or p["status"] not in LIVE:
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


COLLECTORS: dict[str, Collector] = {c.network: c for c in (YouTube(), Facebook(), Bluesky())}


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
    posts = [p for p in live_posts(now) if not only or p["id"] in only]
    have: dict[int, list[dict]] = {}
    for r in readings():
        have.setdefault(r["post_id"], []).append(r)
    stored, skipped, problems, manual, notes = [], [], [], [], []
    by_net: dict[str, list[dict]] = {}
    for p in posts:
        mine = have.get(p["id"], [])
        if p["network"] not in COLLECTORS:
            if checkpoint(p["age_h"]) and not any(r["checkpoint"] == checkpoint(p["age_h"]) for r in mine):
                manual.append({"post_id": p["id"], "slug": p["slug"], "network": p["network"], "age_h": p["age_h"],
                               "checkpoint": checkpoint(p["age_h"]), "url": p.get("url")})
            continue
        why = _due(p, [r for r in mine if r["source"] == "api"], now, fresh)
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
            row = store(g["post"], g["numbers"], "api", at=now, extra=g.get("extra"), remote_id=g.get("remote_id"))
            stored.append({k: row[k] for k in ("post_id", "slug", "network", "checkpoint", "age_h", *[n for n in NUMBERS if row.get(n) is not None])})
    upcoming = [p for p in _posts() if p["network"] != "all" and p["status"] in LIVE and (_when(p.get("at")) or now) > now]
    st.update(last_run=time.time(), last_at=now.isoformat(timespec="seconds"))
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
