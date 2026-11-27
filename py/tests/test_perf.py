"""Performance learning (studio.perf, studio.learn) against a fake HTTP layer and a throwaway catalog: the
collectors' parsing (YouTube statistics + Analytics, Facebook reel insights, Bluesky getPosts), checkpoints and
the hourly gap, manual entry, CSV import for X and TikTok exports (English, legacy, Japanese, date-only), the
comparable number per post, the Bayesian effects and their plain sentences, Thompson-sampling suggestions with
their exploration share, the "not enough data yet" thresholds, and the opt-in steering of vary_look."""
import json
import math
import random
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from studio import learn, perf
from studio.db import connect

TOKEN = "ya29.SECRET-access-token-value-0123456789"
FB_TOKEN = "EAAB" + "x" * 40
NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone(timedelta(hours=9)))


class Fake:
    """Answers by (method, a piece of the URL); each route pops its next reply, the last one repeats."""

    def __init__(self, routes):
        self.routes = [(m, part, list(replies)) for m, part, replies in routes]
        self.calls = []

    def __call__(self, method, url, *, data=None, headers=None, timeout=30):
        self.calls.append({"method": method, "url": url, "headers": headers or {}})
        for m, part, replies in self.routes:
            if m == method and part in url:
                reply = replies.pop(0) if len(replies) > 1 else replies[0]
                if isinstance(reply, BaseException):
                    raise reply
                return reply[0], {}, json.dumps(reply[1]).encode()
        raise AssertionError(f"unexpected call {method} {url}")

    def find(self, part):
        return [c for c in self.calls if part in c["url"]]


def post(pid, network, slug="autumn-1108-2", hours_ago=80.0, **kw):
    at = (NOW - timedelta(hours=hours_ago)).isoformat(timespec="minutes")
    return {"id": pid, "slug": slug, "network": network, "status": kw.pop("status", "posted"), "at": at, "remote_id": kw.pop("remote_id", None),
            "url": kw.pop("url", None), "note": "", "created": at, **kw}


@pytest.fixture
def world(monkeypatch):
    """A clean metrics table, a fixed clock, a fixed posting log and no real network."""
    with connect() as con:
        perf._ready(con)
        con.execute("DELETE FROM metrics")
    rows = []
    monkeypatch.setattr(perf, "_now", lambda: NOW)
    monkeypatch.setattr(perf, "_posts", lambda: rows)
    monkeypatch.setattr(perf, "_http", Fake([]))
    perf._state_path().unlink(missing_ok=True)
    return rows


def yt_ready(monkeypatch, analytics=True):
    scopes = ["https://www.googleapis.com/auth/youtube.upload"] + ([perf.ANALYTICS_SCOPE] if analytics else [])
    monkeypatch.setattr(perf.YouTube, "_token", lambda self: {"scopes": scopes, "refresh_token": "1//x"})
    monkeypatch.setattr(perf.YouTube, "_access", lambda self: TOKEN)


# ---------- collectors ----------

def test_youtube_reads_statistics_in_one_batch_and_analytics_only_after_two_days(world, monkeypatch):
    yt_ready(monkeypatch)
    old = post(1, "youtube", remote_id="Xm3kQ9vT2aL", hours_ago=80)
    new = post(2, "youtube", slug="loud-1107", url="https://youtube.com/shorts/Rp7wN4yH8cZ", hours_ago=10)
    fake = Fake([
        ("GET", "/videos?", [(200, {"items": [{"id": "Xm3kQ9vT2aL", "statistics": {"viewCount": "812", "likeCount": "40", "commentCount": "3", "favoriteCount": "0"}},
                                              {"id": "Rp7wN4yH8cZ", "statistics": {"viewCount": "95", "likeCount": "5", "commentCount": "0"}}]})]),
        ("GET", "youtubeanalytics", [(200, {"columnHeaders": [{"name": n} for n in ("engagedViews", "views", "estimatedMinutesWatched", "averageViewDuration",
                                                                                     "averageViewPercentage", "likes", "comments", "shares", "subscribersGained")],
                                            "rows": [[400, 800, 120.5, 9.1, 61.3, 40, 3, 7, 2]]})]),
    ])
    monkeypatch.setattr(perf, "_http", fake)
    got, notes = perf.COLLECTORS["youtube"].fetch([{**old, "age_h": 80}, {**new, "age_h": 10}])
    assert len(fake.find("/videos?")) == 1 and "Xm3kQ9vT2aL%2CRp7wN4yH8cZ" in fake.find("/videos?")[0]["url"]
    assert len(fake.find("youtubeanalytics")) == 1, "a 10 h old Short does not ask Analytics yet"
    assert "video%3D%3DXm3kQ9vT2aL" in fake.find("youtubeanalytics")[0]["url"]
    a = next(g for g in got if g["post"]["id"] == 1)
    assert a["numbers"] == {"views": 812, "likes": 40, "comments": 3, "watch_time_s": 7230.0, "avg_view_pct": 61.3, "avg_view_s": 9.1, "shares": 7, "followers_gained": 2}
    assert a["extra"] == {"engaged_views": 400, "analytics_views": 800}
    b = next(g for g in got if g["post"]["id"] == 2)
    assert b["numbers"] == {"views": 95, "likes": 5, "comments": 0} and b["remote_id"] == "Rp7wN4yH8cZ"
    assert not notes
    assert all(c["headers"]["authorization"] == f"Bearer {TOKEN}" for c in fake.calls)


def test_youtube_without_the_analytics_scope_says_what_to_press(world, monkeypatch):
    yt_ready(monkeypatch, analytics=False)
    monkeypatch.setattr(perf, "_http", Fake([("GET", "/videos?", [(200, {"items": [{"id": "Xm3kQ9vT2aL", "statistics": {"viewCount": "5"}}]})])]))
    got, notes = perf.COLLECTORS["youtube"].fetch([{**post(1, "youtube", remote_id="Xm3kQ9vT2aL"), "age_h": 80}])
    assert got[0]["numbers"] == {"views": 5}
    assert any("Connect YouTube again" in n and "Analytics" in n for n in notes)


def test_youtube_analytics_retries_without_engaged_views_and_explains_a_disabled_api(world, monkeypatch):
    yt_ready(monkeypatch)
    stats = ("GET", "/videos?", [(200, {"items": [{"id": "Xm3kQ9vT2aL", "statistics": {"viewCount": "5"}}]})])
    fake = Fake([stats, ("GET", "youtubeanalytics", [(400, {"error": {"message": "Unknown identifier (engagedViews)"}}),
                                                     (200, {"columnHeaders": [{"name": "views"}, {"name": "shares"}], "rows": [[5, 1]]})])])
    monkeypatch.setattr(perf, "_http", fake)
    got, _ = perf.COLLECTORS["youtube"].fetch([{**post(1, "youtube", remote_id="Xm3kQ9vT2aL"), "age_h": 80}])
    assert "engagedViews" not in fake.find("youtubeanalytics")[1]["url"] and got[0]["numbers"]["shares"] == 1
    monkeypatch.setattr(perf, "_http", Fake([stats, ("GET", "youtubeanalytics", [(403, {"error": {"message": "API not enabled"}})])]))
    _, notes = perf.COLLECTORS["youtube"].fetch([{**post(1, "youtube", remote_id="Xm3kQ9vT2aL"), "age_h": 80}])
    assert any("enable \"YouTube Analytics API\"" in n for n in notes)


def test_facebook_maps_reel_insights_and_never_leaks_the_token(world, monkeypatch):
    monkeypatch.setattr(perf.Facebook, "_creds", lambda self: {"page_id": "1", "token": FB_TOKEN})
    insights = {"data": [
        {"name": "blue_reels_play_count", "values": [{"value": 230}]}, {"name": "fb_reels_total_plays", "values": [{"value": 260}]},
        {"name": "fb_reels_replay_count", "values": [{"value": 30}]}, {"name": "post_impressions_unique", "values": [{"value": 900}]},
        {"name": "post_video_avg_time_watched", "values": [{"value": 6400}]}, {"name": "post_video_view_time", "values": [{"value": 1664000}]},
        {"name": "post_video_followers", "values": [{"value": 2}]}, {"name": "post_video_social_actions", "values": [{"value": {"COMMENT": 4, "SHARE": 6}}]},
        {"name": "post_video_likes_by_reaction_type", "values": [{"value": {"REACTION_LIKE": 10, "REACTION_LOVE": 3}}]}]}
    fake = Fake([("GET", "/1873050440494016/video_insights", [(200, insights)])])
    monkeypatch.setattr(perf, "_http", fake)
    got, notes = perf.COLLECTORS["facebook"].fetch([{**post(23, "facebook", url="https://www.facebook.com/reel/1873050440494016"), "age_h": 80}])
    assert got[0]["numbers"] == {"views": 230, "reach": 900, "avg_view_s": 6.4, "watch_time_s": 1664.0, "followers_gained": 2, "comments": 4, "shares": 6, "likes": 13}
    assert got[0]["extra"]["fb_reels_replay_count"] == 30 and got[0]["remote_id"] == "1873050440494016"
    # Errors: an expired token stops Facebook with a plain sentence, without the token in it.
    monkeypatch.setattr(perf, "_http", Fake([("GET", "video_insights", [(400, {"error": {"code": 190, "message": f"bad token {FB_TOKEN}"}})])]))
    with pytest.raises(perf.PerfError) as err:
        perf.COLLECTORS["facebook"].fetch([{**post(23, "facebook", remote_id="1873050440494016"), "age_h": 80}])
    assert "connect Facebook again" in str(err.value) and FB_TOKEN not in str(err.value)
    monkeypatch.setattr(perf, "_http", Fake([("GET", "video_insights", [(403, {"error": {"code": 10, "message": "no"}})])]))
    with pytest.raises(perf.PerfError, match="read_insights"):
        perf.COLLECTORS["facebook"].fetch([{**post(23, "facebook", remote_id="1873050440494016"), "age_h": 80}])


def test_bluesky_turns_a_link_into_an_at_uri_and_counts_reposts_and_quotes_as_shares(world, monkeypatch):
    did = "did:plc:abc123"
    uri = f"at://{did}/app.bsky.feed.post/3mzsq6ezxgc2x"
    fake = Fake([("GET", "resolveHandle", [(200, {"did": did})]),
                 ("GET", "getPosts", [(200, {"posts": [{"uri": uri, "likeCount": 12, "repostCount": 3, "replyCount": 2, "quoteCount": 1, "bookmarkCount": 4}]})])])
    monkeypatch.setattr(perf, "_http", fake)
    p = post(12, "bluesky", slug="aerial360-1108", url="https://bsky.app/profile/kensaur.us/post/3mzsq6ezxgc2x")
    got, notes = perf.COLLECTORS["bluesky"].fetch([{**p, "age_h": 30}])
    assert got[0]["numbers"] == {"likes": 12, "comments": 2, "shares": 4, "saves": 4} and got[0]["remote_id"] == uri
    assert "handle=kensaur.us" in fake.find("resolveHandle")[0]["url"]
    assert "authorization" not in fake.find("getPosts")[0]["headers"], "the public AppView needs no sign-in"
    assert perf.bluesky_uri({"remote_id": uri}) == uri and perf.bluesky_uri({"url": "https://x.com/a"}) is None


def test_ids_come_from_links_when_remote_id_is_missing():
    assert perf.youtube_id({"url": "https://youtube.com/shorts/Xm3kQ9vT2aL"}) == "Xm3kQ9vT2aL"
    assert perf.youtube_id({"url": "https://www.youtube.com/watch?v=Xm3kQ9vT2aL&t=1"}) == "Xm3kQ9vT2aL"
    assert perf.facebook_id({"url": "https://www.facebook.com/reel/1787316039049482"}) == "1787316039049482"
    assert perf.facebook_id({"url": None}) is None


# ---------- collect, checkpoints, the hourly gap ----------

def test_collect_reads_due_posts_once_per_checkpoint_and_lists_the_rest(world, monkeypatch):
    world += [post(1, "bluesky", url="https://bsky.app/profile/did:plc:abc/post/r1", hours_ago=30),
              post(2, "tiktok", hours_ago=30, status="scheduled"),
              post(3, "youtube", remote_id="Xm3kQ9vT2aL", hours_ago=-5, status="scheduled"),  # goes out later
              post(4, "x", hours_ago=0.5)]                                                    # under an hour
    bsky = ("GET", "getPosts", [(200, {"posts": [{"uri": "at://did:plc:abc/app.bsky.feed.post/r1", "likeCount": 2, "repostCount": 0, "replyCount": 0, "quoteCount": 0}]})])
    fake = Fake([bsky])
    monkeypatch.setattr(perf, "_http", fake)
    r = perf.collect({})
    assert r["read"] == 1 and r["stored"][0]["checkpoint"] == "24h" and r["stored"][0]["likes"] == 2
    assert [m["post_id"] for m in r["needsNumbers"]] == [2], "TikTok has no collector: needs numbers by hand"
    assert [m["post_id"] for m in r["notOutYet"]] == [3]
    assert "Read 1 post" in r["summary"]
    again = perf.collect({})
    assert again["read"] == 0 and any(s["why"] == "already read for this checkpoint" for s in again["skipped"])
    assert len(fake.find("getPosts")) == 1, "the same checkpoint is not read twice"
    assert perf.collect({"timer": True})["ran"] is False, "the timer waits an hour between runs"
    assert perf.collect({"fresh": True})["read"] == 0, "fresh waits 15 minutes since the last reading"


def test_collect_keeps_going_when_one_network_fails(world, monkeypatch):
    yt_ready(monkeypatch, analytics=False)
    world += [post(1, "bluesky", url="https://bsky.app/profile/did:plc:abc/post/r1"), post(2, "youtube", remote_id="Xm3kQ9vT2aL")]
    monkeypatch.setattr(perf, "_http", Fake([
        ("GET", "/videos?", [(403, {"error": {"message": "quota exceeded", "errors": [{"reason": "quotaExceeded"}]}})]),
        ("GET", "getPosts", [(200, {"posts": [{"uri": "at://did:plc:abc/app.bsky.feed.post/r1", "likeCount": 1}]})])]))
    r = perf.collect({})
    assert r["read"] == 1 and r["problems"][0]["network"] == "youtube" and "quota" in r["problems"][0]["error"]
    assert TOKEN not in json.dumps(r)


def test_checkpoints():
    assert perf.checkpoint(0.5) is None and perf.checkpoint(1) == "1h" and perf.checkpoint(30) == "24h"
    assert perf.checkpoint(100) == "72h" and perf.checkpoint(200) == "7d" and perf.checkpoint(700) == "28d"


# ---------- manual entry ----------

def test_manual_entry_checks_numbers_and_stores_a_reading(world):
    world.append(post(30, "tiktok", hours_ago=26))
    r = perf.manual({"post_id": 30, "views": 1500, "likes": 80, "shares": 4, "saves": 9, "completion_pct": 18.5, "note": "from the app"})
    s = r["stored"]
    assert (s["views"], s["likes"], s["source"], s["checkpoint"], s["extra"]) == (1500, 80, "manual", "24h", {"note": "from the app"})
    for bad, msg in (({"post_id": 30}, "at least one number"), ({"post_id": 30, "views": -1}, "zero or more"),
                     ({"post_id": 30, "avg_view_pct": 140}, "0 to 100"), ({"post_id": 999, "views": 1}, "no post 999"),
                     ({"post_id": "x", "views": 1}, "post_id"), ({"post_id": 30, "views": True}, "views")):
        with pytest.raises(perf.PerfError, match=msg):
            perf.manual(bad)


def test_browser_readings_are_marked_browser_and_clear_needs_numbers(world):
    world += [post(40, "x", hours_ago=26), post(41, "pinterest", hours_ago=2), post(42, "bluesky", hours_ago=26),
              post(43, "tiktok", hours_ago=-3, status="scheduled")]                     # not out yet
    before = perf.needs({})["needsNumbers"]
    assert [n["post_id"] for n in before] == [40, 41], "API networks and posts not out yet are not listed"
    assert [n["post_id"] for n in perf.needs({"networks": ["pinterest"]})["needsNumbers"]] == [41]
    assert perf._state().get("last_run") is None, "needs reads nothing and never moves the hourly timer"
    r = perf.manual({"post_id": 40, "views": 456, "likes": 10, "shares": 2, "comments": 3, "saves": 1, "source": "browser",
                     "page": "https://x.com/example_owner/status/1855000000000000001", "remote_id": "1855000000000000001"})
    s = r["stored"]
    assert (s["source"], s["views"], s["checkpoint"], s["remote_id"]) == ("browser", 456, "24h", "1855000000000000001")
    assert s["extra"] == {"page": "https://x.com/example_owner/status/1855000000000000001"}
    assert [n["post_id"] for n in perf.needs({})["needsNumbers"]] == [41], "a browser reading fills its checkpoint"
    assert perf.manual({"post_id": 41, "views": 9})["stored"]["source"] == "manual", "typing stays manual"
    for bad, msg in (({"post_id": 41, "views": 1, "source": "api"}, "manual or browser"),
                     ({"post_id": 41, "views": 1, "source": "browser", "page": "javascript:alert(1)"}, "https://")):
        with pytest.raises(perf.PerfError, match=msg):
            perf.manual(bad)


# ---------- CSV import ----------

X_NOW = ("Post id,Date,Post text,Post Link,Impressions,Likes,Engagements,Bookmarks,Shares,New follows,Replies,Reposts,Profile visits,"
         "Detail Expands,URL Clicks,Hashtag Clicks,Permalink Clicks\n"
         "1855000000000000001,\"Fri, Nov 14, 2026\",紅葉のCafe Kumo,https://x.com/example_owner/status/1855000000000000001,1234,20,55,3,2,1,4,5,6,7,8,0,1\n"
         "1855000000000000002,\"Sat, Nov 15, 2026\",something else,https://x.com/example_owner/status/1855000000000000002,99,1,2,0,0,0,0,0,0,0,0,0,0\n")


def test_x_export_maps_columns_matches_by_day_and_adds_reposts_to_shares(world):
    world += [post(7, "x", hours_ago=0, status="scheduled") | {"at": "2026-11-14T19:00+09:00"}]
    r = perf.import_csv({"network": "x", "csv": X_NOW})
    assert r["columns"]["reach"] == "Impressions" and r["columns"]["saves"] == "Bookmarks" and r["columns"]["followers_gained"] == "New follows"
    assert r["columns"]["comments"] == "Replies" and r["columns"]["_reposts"] == "Reposts" and "Engagements" not in r["columns"].values()
    assert len(r["stored"]) == 1 and r["stored"][0]["post_id"] == 7 and r["stored"][0]["matchedBy"] == "date"
    s = r["stored"][0]
    assert (s["reach"], s["likes"], s["saves"], s["shares"], s["comments"], s["followers_gained"]) == (1234, 20, 3, 7, 4, 1)
    assert r["unmatched"][0]["row"] == 2 and "send post_id" in r["summary"]
    again = perf.import_csv({"network": "x", "csv": X_NOW})
    assert again["stored"] == [] and again["duplicates"] == 1, "importing the same file twice stores nothing new"


def test_legacy_x_export_matches_by_link_and_by_time(world):
    world += [post(14, "x", url="https://x.com/example_owner/status/1700000000000000009") | {"at": "2026-11-12T19:00+09:00"},
              post(15, "x") | {"at": "2026-11-13T19:00+09:00"}]
    text = ("Tweet id,Tweet permalink,Tweet text,time,impressions,engagements,engagement rate,retweets,replies,likes,url clicks,follows\n"
            "1700000000000000009,https://twitter.com/x/status/1700000000000000009,hello,2026-11-12 10:00 +0000,500,20,0.04,2,1,9,0,1\n"
            "1700000000000000010,https://twitter.com/x/status/1700000000000000010,hi,2026-11-13 10:05 +0000,300,10,0.03,0,0,4,0,0\n")
    r = perf.import_csv({"network": "x", "csv": text})
    assert [(s["post_id"], s["matchedBy"]) for s in r["stored"]] == [(14, "link"), (15, "time")]
    assert r["stored"][0]["shares"] == 2 and r["stored"][0]["reach"] == 500


def test_tiktok_export_with_times_and_a_japanese_export_with_a_mapping(world):
    world += [post(28, "tiktok") | {"at": "2026-11-11T19:00+09:00"}]
    text = ("Video name,Post time,Video views,Likes,Comments,Shares,Add to Favorites,Average watch time,Total play time,Watched full video,New followers\n"
            "仕事は浅く,2026-11-11 19:02,\"1,2K\",80,3,4,9,8.5s,2h 30m,21.5%,3\n")
    r = perf.import_csv({"network": "tiktok", "csv": text.replace("\"1,2K\"", "1.2K")})
    s = r["stored"][0]
    assert s["post_id"] == 28 and s["matchedBy"] == "time"
    assert (s["views"], s["saves"], s["avg_view_s"], s["watch_time_s"], s["completion_pct"], s["followers_gained"]) == (1200, 9, 8.5, 9000.0, 21.5, 3)
    ja = "動画タイトル,投稿日時,再生数,いいね数,コメント数,シェア数,謎の列\n仕事,2026/11/11 19:00,2500,100,5,6,42\n"
    r = perf.import_csv({"network": "tiktok", "csv": ja, "mapping": {"謎の列": "saves"}, "dry_run": True})
    assert r["dryRun"] and r["stored"][0]["views"] == 2500 and r["stored"][0]["saves"] == 42 and r["columns"]["likes"] == "いいね数"
    assert perf.readings(post_id=28)[-1]["views"] == 1200, "a dry run stores nothing"


def test_csv_errors_are_plain_sentences(world):
    for req, msg in (({"network": "myspace", "csv": "a,b\n1,2"}, "network"), ({"network": "x", "csv": ""}, "paste"),
                     ({"network": "x", "csv": "foo,bar,baz\n1,2,3\n"}, "Columns found: foo, bar, baz"),
                     ({"network": "x", "csv": X_NOW, "mapping": {"Nope": "views"}}, "no column"),
                     ({"network": "x", "csv": X_NOW, "mapping": {"Likes": "hearts"}}, "not a field"),
                     ({"network": "x", "csv": "x" * (perf.MAX_CSV + 1)}, "2 MB")):
        with pytest.raises(perf.PerfError, match=msg):
            perf.import_csv(req)


def test_numbers_and_times_from_exports():
    p = perf.parse_number
    assert p("1,234") == 1234 and p("1.2K") == 1200 and p("3.4M") == 3_400_000 and p("1.5万") == 15000 and p("21.5%") == 21.5
    assert p("3.4M", is_time=False) == 3_400_000, "a count never reads M as minutes"
    assert p("0:12", is_time=True) == 12 and p("1:02:03", is_time=True) == 3723 and p("12.5s", is_time=True) == 12.5
    assert p("1h 2m 3s", is_time=True) == 3723 and p("", True) is None and p("--") is None and p("abc") is None
    t = perf.parse_time("2026-11-14 19:00")
    assert t.utcoffset() == timedelta(hours=9), "a time without a zone is Japan time"
    assert perf.parse_time("Fri, Nov 14, 2026").day == 14 and perf.parse_time("2026-11-12 10:00 +0000").hour == 10


# ---------- the comparable number ----------

def test_comparable_uses_the_reading_nearest_72h_and_divides_by_the_network_median(world, monkeypatch):
    monkeypatch.setattr("studio.projects.load", lambda slug: {"slug": slug, "theme": "autumn", "look": "punch", "shots": [{"sec": 2}] * 7})
    posts = [{**post(i, "youtube", slug=f"autumn-{i}"), "out_at": "x"} for i in (1, 2, 3)]
    rows = []
    for pid, views in ((1, 100), (2, 300), (3, 900)):
        rows += [{"post_id": pid, "age_h": 5, "views": 1, "fetched_at": "a", "source": "api", "extra": {}},
                 {"post_id": pid, "age_h": 70, "views": views, "fetched_at": "b", "source": "api", "extra": {}},
                 {"post_id": pid, "age_h": 200, "views": views * 3, "fetched_at": "c", "source": "api", "extra": {}}]
    posts.append({**post(4, "youtube", slug="autumn-4"), "out_at": "x"})
    rows.append({"post_id": 4, "age_h": 3, "views": 7, "fetched_at": "a", "source": "api", "extra": {}})
    d = learn.comparable(posts=posts, rows=rows)
    assert [u["value"] for u in d["units"]] == [100, 300, 900] and d["tooNew"] == 1
    assert d["networks"]["youtube"] == {"metric": "views", "median": 300, "posts": 3, "silent": False}
    assert d["byPost"][3]["ratio"] == pytest.approx(901 / 301, rel=1e-3) and "3.0x the median views on YouTube" in d["byPost"][3]["sentence"]
    # Engaged views win once most YouTube readings carry them.
    for r in rows:
        r["extra"] = {"engaged_views": (r["views"] or 0) // 2}
    assert learn.comparable(posts=posts, rows=rows)["networks"]["youtube"]["metric"] == "engaged_views"


def test_a_network_that_showed_every_post_to_nobody_is_left_out_of_the_model(world, monkeypatch):
    """16 Nov: 17 of 26 "measured" posts were TikTok, Facebook and Bluesky zeros. They each scored exactly the median,
    said nothing about any choice, and still counted towards "ready"."""
    monkeypatch.setattr("studio.projects.load", lambda slug: {"slug": slug, "theme": "autumn", "look": "punch", "shots": [{"sec": 2}] * 7})
    posts, rows = [], []
    for i, (net, views) in enumerate([("youtube", 100), ("youtube", 300), ("youtube", 900),
                                       ("tiktok", 0), ("tiktok", 0), ("tiktok", 0), ("x", 0), ("x", 5), ("x", 0)], start=1):
        posts.append({**post(i, net, slug=f"autumn-{i}"), "out_at": "x"})
        rows.append({"post_id": i, "age_h": 72, "views": views, "fetched_at": "a", "source": "api", "extra": {}})
    d = learn.comparable(posts=posts, rows=rows)
    assert d["networks"]["tiktok"]["silent"] is True and d["networks"]["tiktok"]["posts"] == 3
    assert d["networks"]["x"]["silent"] is False, "one post with views: the network is showing them"
    assert {u["network"] for u in d["units"]} == {"youtube", "x"} and len(d["units"]) == 6
    s = learn.summary(data=d)
    assert s["measured"] == 6 and s["silent"] == ["tiktok"] and "Not counted: TikTok" in s["headline"]
    assert "Left out: TikTok" in s["method"]
    assert "not showing them to anyone" in learn.summary("tiktok", data=d)["headline"]


def test_features_of_a_reel():
    f = learn.reel_features({"slug": "fire-1108", "theme": "fire", "style": "split", "look": "ember", "loop": True, "music": "auto", "sfx": True,
                             "shots": [{"sec": 2.0}] * 8, "beats": [{"kind": "hook", "ja": "火を\n囲む。"}]},
                            {"at": "2026-11-14T19:00+09:00"})
    assert f["look"] == "ember" and f["style"] == "split" and f["loop"] == "loop" and f["length"] == "16-22 s" and f["clips"] == "7-9"
    assert f["hook"] == "火を囲む。" and f["weekday"] == "Saturday" and f["hour"] == "18-20" and f["cut"] == "short"
    assert learn.reel_features({"slug": "x-long", "variant": "b-explainer", "music": "off"}, None)["cut"] == "long"


# ---------- learning math ----------

LOOK_CYCLE = ("punch", "film", "split", "plain")


def synthetic(n, lift=2.0, seed=0, nets=("youtube", "tiktok")):
    """n posts where the punch look gets `lift` times the median; everything else is noise."""
    rng = np.random.default_rng(seed)
    units = []
    for i in range(n):
        look = LOOK_CYCLE[i % 4]
        net = nets[(i // len(LOOK_CYCLE)) % len(nets)]  # every look on every network (not confounded)
        y = (math.log(lift) if look == "punch" else 0.0) + rng.normal(0, 0.3)
        feats = {"theme": "autumn", "style": ("column", "centre", "lower")[i % 3], "look": look, "recipe": "none", "loop": "loop",
                 "length": "12-16 s", "clips": "7-9", "music": "auto", "sfx": "effects", "hook": "hook", "cut": "short",
                 "weekday": learn.WEEKDAYS[i % 7], "hour": "18-20"}
        units.append({"post_id": i, "slug": f"s{i}", "network": net, "metric": "views", "value": math.exp(y) * 100, "y": y, "features": feats})
    networks = {n_: {"metric": "views", "median": 100.0, "posts": sum(u["network"] == n_ for u in units)} for n_ in nets}
    return {"units": units, "byPost": {}, "networks": networks, "tooNew": 0}


def test_the_model_finds_a_real_lift_and_says_so_with_its_uncertainty():
    data = synthetic(40, lift=2.0)
    s = learn.summary(data=data)
    assert s["ready"] and s["measured"] == 40
    punch = next(r for r in s["features"]["look"] if r["level"] == "punch")
    assert 1.4 < punch["mult"] < 2.2 and punch["low"] < punch["mult"] < punch["high"] and punch["pBetter"] > 0.9
    assert punch["sentence"].startswith("punch look: about ") and "x the median views (all networks)" in punch["sentence"]
    assert "10 posts; fairly sure it helps" in punch["sentence"]
    assert punch in s["worked"] and all(r["level"] != "punch" for r in s["didnt"])
    # A choice every post shared is never a finding.
    autumn = s["features"]["theme"][0]
    assert autumn["verdict"].startswith("every measured post had it") and autumn not in s["worked"] + s["didnt"]
    # With 24 posts the same lift is seen, with less certainty.
    small = next(r for r in learn.summary(data=synthetic(24, lift=2.0))["features"]["look"] if r["level"] == "punch")
    assert small["mult"] > 1.3 and small["pBetter"] > 0.75 and small["high"] - small["low"] > punch["high"] - punch["low"]
    one = learn.summary(network="tiktok", data=data)
    assert "on TikTok" in next(r for r in one["features"]["look"] if r["level"] == "punch")["sentence"]
    assert learn.summary(network="x", data=data)["headline"].startswith("No measured posts on X")


def test_few_posts_shrink_towards_no_effect_and_say_not_enough_data():
    data = synthetic(4, lift=3.0)
    s = learn.summary(data=data)
    assert not s["ready"] and s["headline"].startswith("Not enough data yet: 4 of 15 measured posts")
    punch = next(r for r in s["features"]["look"] if r["level"] == "punch")
    assert punch["mult"] < 3.0 * 0.9, "one post is pulled well towards the median"
    assert "1 post: too few to tell" in punch["sentence"] and punch not in s["worked"]
    assert learn.summary(data={"units": [], "byPost": {}, "networks": {}, "tooNew": 2})["headline"].startswith("No measured posts yet")


def test_verdict_words():
    assert learn.verdict(0.95, 5) == "fairly sure it helps" and learn.verdict(0.8, 5).startswith("probably helps")
    assert learn.verdict(0.5, 5) == "still uncertain" and learn.verdict(0.05, 5) == "fairly sure it holds back"
    assert learn.verdict(0.99, 1) == "1 post: too few to tell"


def test_effects_are_deterministic():
    a = learn.fit(synthetic(20)["units"]).effect("look", "punch")
    b = learn.fit(synthetic(20)["units"]).effect("look", "punch")
    assert a == b


# ---------- suggestions ----------

def test_below_the_threshold_every_suggestion_explores_the_least_tried_choice():
    s = learn.suggest(n=5, seed=3, data=synthetic(8))
    assert not s["ready"] and all(x["mode"] == "explore" for x in s["suggestions"])
    untried = {"ember", "whip", "zoom", "ridge", "slats", "iris", "jump", "mono", "pulse", "mix", "spin", "cube", "glitch", "burn", "bars", "window", "print", "steps", "hold", "mirror", "impact", "letters"}  # 0 posts in the data
    assert all(x["look"] in untried for x in s["suggestions"]), "the least tried looks come first"
    assert all(x["why"]["look"] == f"exploring: {x['look']} look has 0 measured posts so far" for x in s["suggestions"])
    assert "Exploring only: 8 of 15" in s["note"]
    assert all(x["length"] in learn.STEER_LENGTHS and x["hour"] in learn.STEER_HOURS for x in s["suggestions"])


def test_above_the_threshold_suggestions_mostly_follow_the_winner_and_explore_about_30_percent():
    data = synthetic(40, lift=2.5)
    modes, looks = [], []
    for seed in range(40):
        s = learn.suggest(n=10, seed=seed, data=data)
        modes += [x["mode"] for x in s["suggestions"]]
        looks += [x["look"] for x in s["suggestions"] if x["mode"] == "learned"]
    explore = modes.count("explore") / len(modes)
    assert 0.24 < explore < 0.36
    assert looks.count("punch") / len(looks) > 0.6
    s = learn.suggest(n=3, seed=7, data=data)
    assert s == learn.suggest(n=3, seed=7, data=data), "the same seed gives the same suggestions"
    assert s["ready"] and abs(sum(s["distribution"]["look"].values()) - 1) < 0.01 and max(s["distribution"]["look"], key=s["distribution"]["look"].get) == "punch"
    learned = next(x for seed in range(20) for x in learn.suggest(n=10, seed=seed, data=data)["suggestions"] if x["mode"] == "learned")
    assert "the median views" in learned["why"]["look"]
    assert all(x["mode"] == "explore" for x in learn.suggest(n=10, explore=1, seed=1, data=data)["suggestions"])
    assert all(x["mode"] == "learned" for x in learn.suggest(n=10, explore=0, seed=1, data=data)["suggestions"])


def test_suggest_inputs_are_clamped():
    s = learn.suggest(n=99, explore=5, seed="12", data=synthetic(2))
    assert len(s["suggestions"]) == 10 and s["explore"] == 1.0
    assert len(learn.suggest(n="x", data=synthetic(2))["suggestions"]) == 3


# ---------- steering vary_look (opt-in) ----------

def test_vary_draw_waits_for_enough_posts():
    assert learn.vary_draw("column", random.Random(1), data=synthetic(10)) is None


def test_vary_look_is_unchanged_without_the_flag_and_steers_with_it(monkeypatch):
    from studio.service import vary_look

    before = [vary_look({}, "column", random.Random(s), "punch", night=False) for s in range(30)]
    data = synthetic(40, lift=3.0)
    monkeypatch.setattr(learn, "comparable", lambda *a, **k: data)
    again = [vary_look({}, "column", random.Random(s), "punch", night=False) for s in range(30)]
    assert before == again, "the default path draws exactly as before"
    steered = [vary_look({}, "column", random.Random(s), None, night=False, learned=True) for s in range(60)]
    assert all(v["style"] != "column" for v in steered)
    share = sum(v["look"] == "punch" for v in steered) / len(steered)
    random_share = sum(v["look"] == "punch" for v in (vary_look({}, "column", random.Random(s), None) for s in range(60))) / 60
    assert share > random_share + 0.25 and share > 0.5
    assert all(v["look"] != "ember" for v in steered), "firelight stays for night and fire themes"
    assert vary_look({}, "column", random.Random(5), None, learned=True) == vary_look({}, "column", random.Random(5), None, learned=True)


def test_steer_switch(monkeypatch, tmp_path):
    """The .env switch wins when it is set (either way); otherwise the Settings › Workflow switch (on by default)."""
    import studio.live as live

    monkeypatch.setattr(live, "SETTINGS_FILE", tmp_path / "autopost.json")
    monkeypatch.delenv("STUDIO_PERF_STEER", raising=False)
    assert learn.steer_on() and learn.steering_on is learn.steer_on
    live.save_settings({"learn": {"steer": False}})
    assert not learn.steer_on()
    monkeypatch.setenv("STUDIO_PERF_STEER", "1")
    assert learn.steer_on()
    live.save_settings({"learn": {"steer": True}})
    monkeypatch.setenv("STUDIO_PERF_STEER", "0")
    assert not learn.steer_on()


def test_explore_share_follows_the_setting(monkeypatch, tmp_path):
    import studio.live as live

    monkeypatch.setattr(live, "SETTINGS_FILE", tmp_path / "autopost.json")
    assert learn.explore_share() == pytest.approx(0.3)
    live.save_settings({"learn": {"explore": 10}})
    assert learn.explore_share() == pytest.approx(0.1)
    with pytest.raises(ValueError):
        live.save_settings({"learn": {"explore": 90}})
    s = learn.suggest(n=200, seed=3, data=synthetic(40, lift=3.0))
    assert s["explore"] == pytest.approx(0.1) and [x["mode"] for x in s["suggestions"]].count("explore") < 40


# ---------- why a reel looks the way it does (made.steer) ----------

def test_steer_draw_says_why_in_each_mode():
    few = learn.steer_draw("column", random.Random(1), data=synthetic(9))
    assert few["mode"] == "random" and "9 of 15" in few["why"] and "9件" in few["whyJa"]
    data = synthetic(40, lift=3.0)
    draws = [learn.steer_draw("column", random.Random(s), data=data) for s in range(80)]
    modes = [d["mode"] for d in draws]
    assert set(modes) == {"learned", "explore"} and 0.15 < modes.count("explore") / len(modes) < 0.45
    for d in draws:
        assert d["why"] and d["whyJa"] and d["picks"]["look"]
        if d["mode"] == "learned":
            assert d["why"].startswith("Learned: ") and "× a typical post" in d["why"] and d["style"] != "column"
        else:  # an explore turn takes a look with the fewest measured posts: one the synthetic posts never used
            assert d["why"].startswith("Trying something new: ") and "not tried yet" in d["why"]
            assert d["picks"]["look"] not in LOOK_CYCLE and d["look"] != "ember"
    learned = [d for d in draws if d["mode"] == "learned"]
    assert sum(d["look"] == "punch" for d in learned) / len(learned) > 0.6
    assert "Punch look did about" in next(d["why"] for d in learned if d["look"] == "punch")
    # the same seed gives the same draw, and vary_draw keeps its old answer (the learned pick, else None)
    assert learn.steer_draw("column", random.Random(7), data=data) == learn.steer_draw("column", random.Random(7), data=data)
    for s in range(20):
        d, v = learn.steer_draw("column", random.Random(s), data=data), learn.vary_draw("column", random.Random(s), data=data)
        assert v == ({"style": d["style"], "look": d["look"]} if d["mode"] == "learned" else None)


def test_vary_look_keeps_why_on_the_reel(monkeypatch):
    from studio.service import vary_look

    off = vary_look({}, "column", random.Random(2), None)
    assert off["made"]["steer"]["mode"] == "random" and "off" in off["made"]["steer"]["why"]
    data = synthetic(40, lift=3.0)
    monkeypatch.setattr(learn, "comparable", lambda *a, **k: data)
    on = [vary_look({}, "column", random.Random(s), None, learned=True) for s in range(30)]
    for p in on:
        st = p["made"]["steer"]
        assert st["mode"] in ("learned", "explore") and st["whyJa"]
        assert (p["look"] or "plain") == st["picks"]["look"], "the look on the reel is the one the sentence names"


def test_autopilot_request_honours_learned_and_falls_back_to_the_setting(monkeypatch):
    from studio import service

    seen = []
    monkeypatch.setattr(service, "_autopilot", lambda *a: seen.append(a) or [])
    monkeypatch.setattr(learn, "steer_on", lambda: True)
    service.handle({"cmd": "autopilot", "themes": ["autumn"], "learned": False})
    service.handle({"cmd": "autopilot", "themes": ["autumn"], "by": "auto"})
    service.handle({"cmd": "autopilot", "themes": ["autumn"], "learned": True, "by": "someone"})
    assert [(a[5], a[6]) for a in seen] == [(False, "person"), (True, "auto"), (True, "person")]


# ---------- the CLI ----------

def test_cli_answers_one_result_line_and_scrubs_errors(world, monkeypatch, capsys):
    import io
    import sys

    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"post_id": 1, "views": 1})))
    perf.main(["manual"])
    out = json.loads(capsys.readouterr().out.removeprefix("RESULT "))
    assert out == {"ok": False, "error": "no post 1 in the posting log", "code": "not_found", "status": 404}
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    perf.main(["nope"])
    assert json.loads(capsys.readouterr().out.removeprefix("RESULT "))["code"] == "bad_input"
    assert perf._scrub(f"Bearer {TOKEN} access_token={FB_TOKEN}&x=1") == "[hidden] [hidden]&x=1"


def test_reach_says_per_network_whether_anyone_saw_the_posts(monkeypatch):
    """14 Nov: the Results page said "0 views, 1.0x a typical post" and the owner could not tell good from bad."""
    from datetime import datetime, timedelta, timezone

    from studio import perf, posting

    now = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)
    day = lambda d: (now - timedelta(days=d)).isoformat()  # noqa: E731
    posts = [
        {"id": 1, "slug": "a", "network": "youtube", "status": "posted", "at": day(3), "url": "u1"},
        {"id": 2, "slug": "b", "network": "youtube", "status": "posted", "at": day(2), "url": "u2"},
        {"id": 3, "slug": "a", "network": "tiktok", "status": "posted", "at": day(3)},
        {"id": 4, "slug": "a", "network": "x", "status": "posted", "at": day(3)},
        {"id": 5, "slug": "a", "network": "bluesky", "status": "posted", "at": day(3)},
        {"id": 6, "slug": "a", "network": "gbp", "status": "posted", "at": day(3)},
        {"id": 7, "slug": "c", "network": "youtube", "status": "posted", "at": day(90)},  # too old
        {"id": 8, "slug": "d", "network": "youtube", "status": "scheduled", "at": day(-1)},  # not out
    ]
    reads = [
        {"post_id": 1, "views": 100, "likes": 1}, {"post_id": 1, "views": 900, "likes": 5, "comments": 1},  # the latest counts
        {"post_id": 2, "views": 300, "likes": 2},
        {"post_id": 3, "views": 0, "likes": 0},
        {"post_id": 4, "views": 12},
        {"post_id": 5, "views": None, "likes": 0, "shares": 0},
        {"post_id": 7, "views": 99999},
    ]
    monkeypatch.setattr(posting, "posts", lambda: posts)
    monkeypatch.setattr(perf, "readings", lambda: reads)
    r = perf.reach(now=now)
    by = {n["network"]: n for n in r["networks"]}
    assert by["youtube"]["verdict"] == "working" and by["youtube"]["views"] == 1200 and by["youtube"]["measured"] == 2
    assert by["youtube"]["best"]["slug"] == "a" and by["youtube"]["reactions"] == 8
    assert by["tiktok"]["verdict"] == "none" and by["tiktok"]["zero"] == 1
    assert by["x"]["verdict"] == "few"
    assert by["bluesky"]["verdict"] == "none"  # no view count there: no reactions is nobody
    assert by["gbp"]["verdict"] == "unmeasured"
    assert [n["network"] for n in r["networks"]][0] == "youtube" and r["totals"]["out"] == 6
    assert not any(n["stalled"] for n in r["networks"]), "one zero post three days out is too little to call"


def test_reach_calls_a_network_stalled_when_several_posts_days_out_all_have_nothing(monkeypatch):
    """16 Nov: TikTok 15 posts at 0 views and Facebook 6 reels at 0 plays sat in one grey line under a green +1307%."""
    from datetime import datetime, timedelta, timezone

    from studio import perf, posting

    now = datetime(2026, 11, 16, 12, tzinfo=timezone.utc)
    day = lambda d: (now - timedelta(days=d)).isoformat()  # noqa: E731
    posts = [{"id": i, "slug": f"s{i}", "network": net, "status": "posted", "at": day(d)}
             for i, (net, d) in enumerate([("tiktok", 6), ("tiktok", 4), ("tiktok", 1), ("bluesky", 5), ("bluesky", 3), ("bluesky", 2),
                                           ("facebook", 1.5), ("facebook", 1), ("facebook", 0.5), ("youtube", 3)], start=1)]
    reads = [{"post_id": i, "views": 0, "likes": 0} for i in (1, 2, 3, 7, 8, 9)]
    reads += [{"post_id": i, "views": None, "likes": 0} for i in (4, 5, 6)] + [{"post_id": 10, "views": 500}]
    monkeypatch.setattr(posting, "posts", lambda: posts)
    monkeypatch.setattr(perf, "readings", lambda: reads)
    by = {n["network"]: n for n in perf.reach(now=now)["networks"]}
    assert by["tiktok"]["stalled"] and by["tiktok"]["oldestH"] == 144 and by["tiktok"]["since"] == day(6)
    assert by["bluesky"]["stalled"] and not by["bluesky"]["hasViews"], "no reactions on a network without views counts too"
    assert not by["facebook"]["stalled"], "the oldest is 36 h out: too early to say"
    assert not by["youtube"]["stalled"]


def test_reach_counts_only_the_account_in_use_now(monkeypatch):
    """24 Nov: the old Singapore-region TikTok was deleted (its bookings dropped with a note) and a new Japan account
    took over; the 13 old posts at 0 views kept saying the new account was not being seen."""
    from datetime import datetime, timedelta, timezone

    from studio import perf, posting

    now = datetime(2026, 11, 28, 12, tzinfo=timezone.utc)
    day = lambda d: (now - timedelta(days=d)).isoformat()  # noqa: E731
    posts = [{"id": i, "slug": f"s{i}", "network": "tiktok", "status": "posted", "at": day(d)} for i, d in [(1, 12), (2, 10), (3, 8)]]
    posts += [{"id": 4, "slug": "s4", "network": "tiktok", "status": "dropped", "at": day(4),
               "note": " · the old @cafekumo TikTok (Singapore region) was deleted 24 Nov; book again on the new one"},
              {"id": 5, "slug": "s5", "network": "tiktok", "status": "posted", "at": day(1)},
              {"id": 6, "slug": "s6", "network": "x", "status": "dropped", "at": day(3), "note": "set aside by hand"},
              {"id": 7, "slug": "s7", "network": "x", "status": "posted", "at": day(9)}]
    reads = [{"post_id": i, "views": 0, "likes": 0} for i in (1, 2, 3, 5, 7)]
    monkeypatch.setattr(posting, "posts", lambda: posts)
    monkeypatch.setattr(perf, "readings", lambda: reads)
    since = perf.account_since(posts, saved={})
    assert since == {"tiktok": datetime.fromisoformat(day(4))}, "only a drop that names a deleted account counts"
    by = {n["network"]: n for n in perf.reach(now=now, since=since)["networks"]}
    assert by["tiktok"]["history"] == 3 and by["tiktok"]["out"] == 1 and not by["tiktok"]["stalled"]
    assert by["tiktok"]["accountSince"] == "2026-11-24T12:00+00:00"
    assert by["x"]["out"] == 1 and "history" not in by["x"]
    # a saved "since" (the account name changed on Settings › Accounts) wins over the dropped rows
    assert perf.account_since(posts, saved={"tiktok": day(2)})["tiktok"] == datetime.fromisoformat(day(2))
    # with no account change every old post counts, and three silent ones days out are stalled
    assert {n["network"]: n for n in perf.reach(now=now, since={})["networks"]}["tiktok"]["stalled"]


def test_a_page_reel_missing_from_the_log_is_matched_to_its_reel_never_guessed():
    """16 Nov: the one Facebook reel with 100 plays was not in the posting log, so Results said Facebook got nothing."""
    texts = {"view": "不便だからこそ、景色がいい。\n本文A", "aerial-1109": "不便だからこそ、景色がいい。\n本文B",
             "fire-1108": "火をわけあう。\n本文", "warm-1107": "寒いからこそ。\n本文"}
    assert perf.match_reel("不便だからこそ、景色がいい。\n本文A", texts) == "view", "exact text wins"
    assert perf.match_reel("火をわけあう。\n少し違う本文", texts) == "fire-1108", "a unique first line"
    assert perf.match_reel("不便だからこそ、景色がいい。\n別の本文", texts) is None, "two reels share the line: no guess"
    assert perf.match_reel("", texts) is None and perf.match_reel("知らない文", texts) is None


# ---------- Instagram Stories and "what the numbers say" (18 Nov) ----------

def test_instagram_story_reads_views_reach_and_taps_and_says_what_is_missing(world, monkeypatch):
    """A Story's numbers last 24 hours. 18 Nov: the stored token answered (#10) "Application does not have permission"."""
    monkeypatch.setattr(perf.InstagramStory, "_creds", lambda self: {"page_id": "1", "token": FB_TOKEN})
    insights = {"data": [{"name": "views", "total_value": {"value": 140}}, {"name": "reach", "values": [{"value": 120}]},
                         {"name": "shares", "total_value": {"value": 2}}, {"name": "follows", "total_value": {"value": 1}},
                         {"name": "profile_visits", "total_value": {"value": 6}}]}
    nav = {"data": [{"name": "navigation", "total_value": {"value": 100, "breakdowns": [{"dimension_keys": ["story_navigation_action_type"], "results": [
        {"dimension_values": ["TAP_FORWARD"], "value": 55}, {"dimension_values": ["tap_exit"], "value": 30},
        {"dimension_values": ["tap_back"], "value": 5}, {"dimension_values": ["swipe_forward"], "value": 10}]}]}}]}
    fake = Fake([("GET", "breakdown=story_navigation_action_type", [(200, nav)]), ("GET", "/18103426217638712/insights", [(200, insights)])])
    monkeypatch.setattr(perf, "_http", fake)
    story = {**post(40, "instagram-story", remote_id="18103426217638712", hours_ago=5), "age_h": 5}
    got, notes = perf.COLLECTORS["instagram-story"].fetch([story])
    assert got[0]["numbers"] == {"views": 140, "reach": 120, "shares": 2, "followers_gained": 1}
    assert got[0]["extra"] == {"profile_visits": 6, "navigation": {"tap_forward": 55, "tap_exit": 30, "tap_back": 5, "swipe_forward": 10}}
    assert "replies" not in fake.calls[0]["url"], "replies are always 0 for accounts in Japan"
    assert all(FB_TOKEN not in n for n in notes)
    # Fewer than 5 viewers is a note, not a failure; a missing permission stops the network with what to press.
    monkeypatch.setattr(perf, "_http", Fake([("GET", "insights", [(400, {"error": {"code": 10, "message": "(#10) Not enough viewers for the media to show insights"}})])]))
    got, notes = perf.COLLECTORS["instagram-story"].fetch([story])
    assert got == [] and "fewer than 5 viewers" in notes[0]
    monkeypatch.setattr(perf, "_http", Fake([("GET", "insights", [(400, {"error": {"code": 10, "message": "(#10) Application does not have permission for this action"}})])]))
    with pytest.raises(perf.PerfError, match="instagram_manage_insights") as err:
        perf.COLLECTORS["instagram-story"].fetch([story])
    assert err.value.code == "permission"
    monkeypatch.setattr(perf, "_http", Fake([("GET", "insights", [(400, {"error": {"code": 100, "error_subcode": 33, "message": "does not exist"}})])]))
    got, notes = perf.COLLECTORS["instagram-story"].fetch([story])
    assert got == [] and "expired" in notes[0]


def test_a_story_is_read_while_it_is_up_and_once_in_its_last_hours():
    def r(age, hours_ago):
        return {"age_h": age, "fetched_at": (NOW - timedelta(hours=hours_ago)).isoformat()}

    def due(age, mine, fresh=False):
        return perf._story_due({"age_h": age}, mine, NOW, fresh)

    assert due(0.5, []) is None, "under an hour: too new"
    assert due(1.2, []) == "first reading"
    assert due(3.0, [r(1.2, 1.8)]) is None, "read under 6 hours ago"
    assert due(7.5, [r(1.2, 6.3)]) == "story reading"
    assert due(21.4, [r(1.2, 20.2), r(19.5, 1.9)]) == "last reading before it expires"
    assert due(22.6, [r(1.2, 21.4), r(21.4, 1.2)]) is None, "the last reading is done"
    assert due(24.5, []) is None, "gone after 24 hours: nothing to read"
    assert due(3.0, [r(1.2, 1.8)], fresh=True) == "asked for fresh numbers"


def test_collect_reads_a_due_story_and_keeps_its_permission_problem_until_it_works(world, monkeypatch):
    world.append(post(41, "instagram-story", remote_id="18103426217638712", hours_ago=2))
    monkeypatch.setattr(perf.InstagramStory, "_creds", lambda self: {"page_id": "1", "token": FB_TOKEN})
    monkeypatch.setattr(perf, "_http", Fake([("GET", "insights", [(400, {"error": {"code": 10, "message": "(#10) Application does not have permission"}})])]))
    out = perf.collect({})
    assert out["problems"][0]["network"] == "instagram-story" and not out["needsNumbers"], "a Story is no longer 'enter by hand'"
    assert perf._state()["problems"]["instagram-story"]["code"] == "permission"
    monkeypatch.setattr(perf, "_http", Fake([("GET", "breakdown", [(400, {})]), ("GET", "insights", [(200, {"data": [{"name": "views", "total_value": {"value": 9}}]})])]))
    out = perf.collect({})
    assert out["read"] == 1 and "instagram-story" not in perf._state()["problems"]


def _short(i, title, views, hours_ago=72, **kw):
    return {"id": f"vid{i:08d}", "slug": kw.pop("slug", f"s{i}"), "title": title, "views": views, "kind": kw.pop("kind", "short"),
            "privacy": kw.pop("privacy", "public"), "at": (NOW - timedelta(hours=hours_ago)).isoformat(), **kw}


def test_insights_find_the_opening_that_broke_out_the_stalled_short_and_how_much_is_watched():
    """The channel on 18 Nov: 「〜からこそ」 openers at a median 943 views, the rest 183; nightfire-1109 at 8."""
    shorts = [_short(1, "不便だからこそ、尾根まで見渡せる。｜Cafe Kumo", 1271, seconds=21, avgPct=54, avgS=11, subs=1),
              _short(2, "区画がないからこそ、気の向くまま張れる。｜Cafe Kumo", 1101, seconds=22, avgPct=55, avgS=12),
              _short(3, "お店がないからこそ、火をわけあう。｜Cafe Kumo", 948, seconds=24),
              _short(4, "寒いからこそ、こたつがうれしい。｜Cafe Kumo", 943, seconds=18, avgPct=66, avgS=11),
              _short(5, "区画がないからこそ、自由に広げられる。｜Cafe Kumo", 8, seconds=14, slug="nightfire-1109"),
              _short(6, "遠いからこそ、騒げる｜Cafe Kumo", 267, seconds=16, avgPct=97, avgS=15),
              _short(7, "不便だからこそ、草原の先に尾根が続く。｜Cafe Kumo", 146, seconds=14, avgPct=102, avgS=14),
              _short(8, "車で来て、車で寝る。｜Cafe Kumo", 200, seconds=14, avgPct=117, avgS=16),
              _short(9, "区画がないから、好きな場所に張る。｜Cafe Kumo", 178, seconds=14, avgPct=91, avgS=12),
              _short(10, "紅葉のCafe Kumo｜標高1,444m｜Cafe Kumo", 183, seconds=14, avgPct=80, avgS=11),
              _short(11, "仕事は浅く、つながりは深く。｜Cafe Kumo", 156, hours_ago=3),  # under a day: not judged yet
              _short(12, "11月17日 · 標高1,444m Cafe Kumo｜Cafe Kumo 標高1,444m #shorts", 5, slug=None),
              _short(13, "11月16日 · 標高1,444m Cafe Kumo｜Cafe Kumo 標高1,444m #shorts", 8, slug=None),
              _short(14, "11月15日 · 標高1,444m Cafe Kumo｜Cafe Kumo 標高1,444m #shorts", 14, slug=None, subs=0),
              _short(15, "【LIVE】浅間山ライブカメラ 24時間", 737, slug=None, kind="live", subs=8),
              _short(16, "private booked", 0, privacy="private")]
    out = perf.insights_from({"channels": [{"items": shorts}]}, [], [], [], {}, {"vid00000002": "2026-11-18"}, NOW)
    y = out["youtube"]
    assert y["shorts"] == 10 and y["hook"]["phrase"] == "からこそ"
    assert y["hook"]["with"] == {"n": 7, "median": 943} and y["hook"]["without"] == {"n": 3, "median": 183}
    assert [s["slug"] for s in y["stalled"]] == ["nightfire-1109"]
    assert y["watch"]["short"]["pct"] > y["watch"]["long"]["pct"] and y["watch"]["long"]["views"] > y["watch"]["short"]["views"]
    assert out["convert"]["live"]["subs"] == 8 and out["convert"]["shorts"]["subs"] == 1
    assert out["related"]["done"] == 1 and out["related"]["of"] == 11 and out["related"]["items"][0]["slug"] == "s11", "newest first"
    assert out["outside"] == {"n": 3, "median": 8, "studio": 234}, "(200 + 267) / 2, the studio's median"
    assert perf.opener("寒いからこそ、こたつがうれしい。｜Cafe Kumo") == "寒いからこそ"
    assert perf.hook_phrase([{"title": s["title"], "views": s["views"]} for s in shorts[:3]]) is None, "too few Shorts: no pattern"


def test_insights_name_the_small_account_and_what_stops_the_story_numbers():
    posts = [{"id": 1, "network": "bluesky", "status": "posted", "at": NOW.isoformat(), "url": "https://bsky.app/profile/smallshop.bsky.social/post/3m5"},
             {"id": 2, "network": "x", "status": "posted", "at": NOW.isoformat(), "url": "https://x.com/smallshop_jp/status/2120818890263638258"},
             {"id": 3, "network": "instagram-story", "status": "posted", "at": (NOW - timedelta(hours=30)).isoformat()}]
    reach_rows = [{"network": "bluesky", "verdict": "none", "out": 8, "views": 0, "reactions": 0},
                  {"network": "x", "verdict": "few", "out": 8, "views": 109, "reactions": 0},
                  {"network": "youtube", "verdict": "working", "out": 11, "views": 5236, "reactions": 26}]
    out = perf.insights_from(None, reach_rows, posts, [], {"instagram-story": {"code": "permission"}}, {}, NOW,
                             followers=lambda h: 2 if h == "smallshop.bsky.social" else None)
    assert out["accounts"] == [{"network": "bluesky", "handle": "smallshop.bsky.social", "followers": 2, "posts": 8, "views": 0, "reactions": 0},
                               {"network": "x", "handle": "smallshop_jp", "followers": None, "posts": 8, "views": 109, "reactions": 0}]
    assert out["stories"]["need"] == "permission" and out["stories"]["out"] == 1
    assert "youtube" not in out and out["related"] == {"done": 0, "of": 0, "items": []}
    old = {"id": 4, "network": "instagram-story", "status": "posted", "at": (NOW - timedelta(days=9)).isoformat()}
    reads = [{"post_id": 3, "views": 140, "reach": 120, "extra": {"navigation": {"tap_forward": 55, "tap_exit": 30, "tap_back": 5, "swipe_forward": 10}}},
             {"post_id": 4, "views": 900, "reach": 800, "extra": {"navigation": {"tap_exit": 500}}}]
    s = perf.insights_from(None, [], posts + [old], reads, {}, {}, NOW)["stories"]
    assert (s["out"], s["read"], s["views"], s["exitPct"], s["onPct"], s["need"]) == (1, 1, 140, 30, 65, None), \
        "a Story older than 7 days counts in neither the posts nor the numbers"


def test_related_ticks_are_kept_and_checked(world):
    perf._related_path().unlink(missing_ok=True)
    assert perf.mark_related({"id": "AbCdEfGhIjK"}) == {"id": "AbCdEfGhIjK", "done": True, "count": 1}
    assert "AbCdEfGhIjK" in perf.related_done()
    assert perf.mark_related({"id": "AbCdEfGhIjK", "done": False})["done"] is False
    with pytest.raises(perf.PerfError):
        perf.mark_related({"id": "../../etc"})


def test_channel_totals_are_kept_once_a_day(tmp_path, monkeypatch):
    """BL-058: channel.json is overwritten on every read, so there was no subscriber history. One row per channel per
    JST day goes to channel-history.jsonl; a second read the same day adds nothing; an errored channel is skipped."""
    monkeypatch.setattr(perf, "_channel_history_file", lambda: tmp_path / "channel-history.jsonl")
    monkeypatch.setattr(perf, "_now", lambda: NOW)
    chans = [{"account": "main", "channel": "Cafe Kumo", "subscribers": 18, "views": 9326, "videos": 31,
              "byKind": {"short": {"views": 9236}, "live": {"views": 1837}}},
             {"account": "spare", "error": "sign-in refused"}]
    added = perf.record_channel_day(chans, NOW)
    assert [(r["date"], r["account"], r["subscribers"], r["views"], r["liveViews"], r["shortViews"], r["longViews"]) for r in added] == [
        ("2026-11-20", "main", 18, 9326, 1837, 9236, None)]
    assert perf.record_channel_day([{**chans[0], "subscribers": 19}], NOW + timedelta(hours=5)) == []  # same JST day
    nxt = perf.record_channel_day([{**chans[0], "subscribers": 20}], NOW + timedelta(days=1))
    assert [r["subscribers"] for r in nxt] == [20]
    (tmp_path / "channel-history.jsonl").open("a", encoding="utf-8").write("not json\n")
    hist = perf.channel_history()
    assert [(r["date"], r["subscribers"]) for r in hist] == [("2026-11-20", 18), ("2026-11-21", 20)]


def test_the_channel_answer_carries_the_history(tmp_path, monkeypatch):
    import time as _time

    from studio.config import DATA

    monkeypatch.setattr(perf, "_channel_history_file", lambda: tmp_path / "channel-history.jsonl")
    monkeypatch.setattr(perf, "_now", lambda: NOW)
    perf.record_channel_day([{"account": "main", "subscribers": 18, "views": 9326}], NOW)
    cache = DATA / "perf" / "channel.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    before = cache.read_text(encoding="utf-8") if cache.exists() else None
    try:
        cache.write_text(json.dumps({"channels": [], "at": NOW.isoformat(), "_at": _time.time()}), encoding="utf-8")
        got = perf.channel()
        assert [r["subscribers"] for r in got["history"]] == [18]
        assert "history" not in json.loads(cache.read_text(encoding="utf-8"))  # the cache stays the channel read only
    finally:
        cache.write_text(before, encoding="utf-8") if before is not None else cache.unlink()


def test_youtube_is_read_from_its_own_posts_not_pooled_with_networks_at_zero():
    """BL-059 (PDCA 21 Nov): YouTube is 92 % of views; its effects were fitted together with networks whose median post
    got nothing, where a handful of views reads as 6x the median. YouTube's summary is fitted on YouTube alone."""
    yt = synthetic(20, lift=2.0, nets=("youtube",))
    units = list(yt["units"])
    for i in range(20):  # X: median 0; the punch look got nothing, every other look a few views (log 6 = 1.8)
        look = LOOK_CYCLE[i % 4]
        v = 0 if look == "punch" else 5
        units.append({"post_id": 100 + i, "slug": f"x{i}", "network": "x", "metric": "views", "value": v, "y": math.log(v + 1),
                      "features": {**units[i]["features"], "look": look}})
    data = {"units": units, "byPost": {}, "tooNew": 0,
            "networks": {"youtube": {"metric": "views", "median": 100.0, "posts": 20, "silent": False},
                         "x": {"metric": "views", "median": 0, "posts": 20, "silent": False}}}
    own = learn.summary("youtube", data=data)
    assert own["measured"] == 20 and own["ready"]
    punch = next(r for r in own["features"]["look"] if r["level"] == "punch")
    assert 1.4 < punch["mult"] < 2.4 and punch["pBetter"] > 0.9, punch
    pooled = learn.summary(data=data)
    assert pooled["measured"] == 40 and pooled["zeroMedian"] == ["x"] and "median 0" in pooled["method"]
    pooled_punch = next(r for r in pooled["features"]["look"] if r["level"] == "punch")
    assert pooled_punch["pBetter"] < punch["pBetter"], "pooled with X, YouTube's real lift is blurred"
    assert set(pooled["byNetwork"]) == {"youtube"} and pooled["byNetwork"]["youtube"]["measured"] == 20
    assert any(r["level"] == "punch" for r in pooled["byNetwork"]["youtube"]["worked"])


def test_week_views_compares_like_with_like_and_leaves_out_replaced_uploads():
    """24 Nov: Today said 2,181 ▼54% and Results 3,146 ▼23% for the same week. One definition (perf.week_views): views so
    far on posts out in the last 7×24 h, against what the posts of the 7 days before had at this point last week."""
    from datetime import datetime, timedelta, timezone

    from studio import perf

    now = datetime(2026, 11, 24, 12, tzinfo=timezone.utc)
    ago = lambda d: (now - timedelta(days=d)).isoformat()  # noqa: E731
    posts = [
        {"id": 1, "slug": "a", "network": "youtube", "status": "posted", "at": ago(2)},
        {"id": 2, "slug": "b", "network": "x", "status": "posted", "at": ago(6.9)},
        {"id": 3, "slug": "c", "network": "youtube", "status": "posted", "at": ago(8)},   # last week: 100 then, 900 now
        {"id": 4, "slug": "d", "network": "youtube", "status": "posted", "at": ago(10)},
        {"id": 5, "slug": "e", "network": "youtube", "status": "posted", "at": ago(13)},
        {"id": 6, "slug": "f", "network": "youtube", "status": "posted", "at": ago(1)},   # replaced: not counted
        {"id": 7, "slug": "g", "network": "youtube", "status": "posted", "at": ago(20)},  # too old
        {"id": 8, "slug": "h", "network": "youtube", "status": "scheduled", "at": ago(-1)},
        {"id": 9, "slug": "i", "network": "tiktok", "status": "posted", "at": ago(3)},    # out, never read
    ]
    reads = [
        {"post_id": 1, "views": 50, "fetched_at": ago(1.5)}, {"post_id": 1, "views": 400, "fetched_at": ago(0.1)},
        {"post_id": 2, "views": 30, "fetched_at": ago(4)},
        {"post_id": 3, "views": 100, "fetched_at": ago(7.5)}, {"post_id": 3, "views": 900, "fetched_at": ago(1)},
        {"post_id": 4, "views": 200, "fetched_at": ago(9)}, {"post_id": 4, "views": 250, "fetched_at": ago(7.2)},
        {"post_id": 5, "views": 70, "fetched_at": ago(10)},
        {"post_id": 6, "views": 5000, "fetched_at": ago(0.5)},
        {"post_id": 7, "views": 9999, "fetched_at": ago(1)},
    ]
    w = perf.week_views(posts, {6: "replaced"}, now, reads)
    assert w["now"] == {"views": 430, "posts": 3, "seen": 2, "measured": 2}
    assert w["before"] == {"views": 420, "posts": 3, "seen": 3, "measured": 3}, "last week's posts as they were 7 days ago"
    assert w["beforeNow"] == 900 + 250 + 70
    assert w["pct"] == round(100 * (430 - 420) / 420)
    thin = perf.week_views(posts[:3], {}, now, reads)
    assert thin["before"]["seen"] == 1 and thin["pct"] is None, "one post with views is no base for a percentage"


def test_a_results_preset_sets_what_it_names_and_says_so():
    from studio.service import _apply_preset
    from studio.staging import LOOKS, RECIPES

    look, recipe = LOOKS[0], RECIPES[0]
    p = {"look": None, "style": "column", "recipe": "x"}
    st = _apply_preset(p, {"look": look, "style": "lower", "recipe": recipe, "mode": "explore"})
    assert p["look"] == look and p["style"] == "lower" and p["recipe"] == recipe
    assert st["mode"] == "explore" and st["picks"] == {"look": look, "style": "lower", "recipe": recipe} and st["from"] == "results"
    assert st["why"].startswith("Made from Results › What to try next: ") and st["whyJa"].startswith("結果の")
    q = {"look": "punch", "recipe": "r"}
    assert _apply_preset(q, {"look": "plain", "recipe": "none", "mode": "odd"})["mode"] == "learned"
    assert q["look"] is None and "recipe" not in q
    assert _apply_preset({}, {"look": "no-such-look", "style": "diagonal"}) is None, "unknown names change nothing"


def test_autopilot_keeps_who_made_each_reel_and_why(monkeypatch, tmp_path):
    """made: {by, at, steer} lands in the saved project for drafts by itself, a person's batch and a Results preset."""
    import studio.assemble as assemble
    import studio.projects as projects
    from studio import service
    from studio.staging import LOOKS

    monkeypatch.setattr(projects, "DIR", tmp_path)
    monkeypatch.setattr(assemble, "THEMES", {"autumn": {"title": "t", "style": "column"}})
    monkeypatch.setattr(assemble, "assemble", lambda theme, slug, **kw: {"slug": slug, "seed": 7, "shots": [{"src": "a.mp4", "sec": 2}], "made_by": "assembler"})
    monkeypatch.setattr(learn, "comparable", lambda *a, **k: synthetic(40, lift=3.0))
    a = service._autopilot(["autumn"], None, False, vary=True, learned=True, by="auto")[0]
    p = projects.load(a["slug"])
    assert p["made"]["by"] == "auto" and p["made"]["at"] and p["made"]["steer"]["mode"] in ("learned", "explore")
    assert a["steer"] == p["made"]["steer"]["mode"] and p["made"]["steer"]["why"]
    b = projects.load(service._autopilot(["autumn"], None, False, vary=False)[0]["slug"])
    assert b["made"]["by"] == "person" and b["made"]["steer"]["mode"] == "theme"
    c = projects.load(service._autopilot(["autumn"], None, False, vary=True, preset={"look": LOOKS[0], "mode": "explore"})[0]["slug"])
    assert c["look"] == LOOKS[0] and c["made"]["steer"]["from"] == "results" and c["made"]["steer"]["mode"] == "explore"


def test_a_look_sent_back_twice_in_30_days_is_left_out_of_learned_picks():
    """Track D's rejections table: punch wins on numbers, but two rejections of punch pause it for learned picks."""
    from datetime import datetime, timedelta

    from studio import review_actions

    data = synthetic(40, lift=3.0)
    try:
        review_actions.reject("s-old", reason="weak-hook", look="punch")
        assert learn.paused_looks() == set(), "one rejection pauses nothing"
        review_actions.reject("s-new", reason="wrong-clip", look="punch")
        assert learn.paused_looks() == {"punch"}
        assert learn.paused_looks(now=datetime.now().astimezone() + timedelta(days=31)) == set(), "it comes back after 30 days"
        draws = [learn.steer_draw("column", random.Random(s), data=data) for s in range(60)]
        learned = [d for d in draws if d["mode"] == "learned"]
        assert learned and all(d["look"] != "punch" for d in learned)
        assert all("Paused after rejections: Punch." in d["why"] and "休止中" in d["whyJa"] for d in learned)
        assert any(d["mode"] == "explore" for d in draws), "explore turns still run"
        from studio import service
        assert service.handle({"cmd": "paused_looks"}) == {"looks": ["punch"], "after": 2, "days": 30}
    finally:
        with connect() as con:
            con.execute("DELETE FROM rejections")


def test_a_reel_made_from_a_lesson_shows_why_on_the_overview_and_is_logged(monkeypatch, tmp_path):
    """End to end without rendering: _autopilot (assembly stubbed) → saved project made.steer → the overview's short form
    (_made_view, what Review and the queue show) → one "reel" line in lessons.jsonl (BL-106c, BL-112)."""
    import studio.assemble as assemble
    import studio.config as config
    import studio.projects as projects
    from studio import service

    monkeypatch.setattr(projects, "DIR", tmp_path)
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(assemble, "THEMES", {"autumn": {"title": "t", "style": "column"}})
    monkeypatch.setattr(assemble, "assemble", lambda theme, slug, **kw: {"slug": slug, "seed": 7, "shots": [{"src": "a.mp4", "sec": 2}], "made_by": "assembler"})
    monkeypatch.setattr(learn, "comparable", lambda *a, **k: synthetic(40, lift=3.0))
    slug = service._autopilot(["autumn"], None, False, vary=True, learned=True, by="auto")[0]["slug"]
    view = service._made_view(projects.load(slug)["made"])
    assert view["by"] == "auto" and view["mode"] in ("learned", "explore") and view["why"] and view["whyJa"]
    lines = learn.lessons()
    assert lines and lines[0]["kind"] == "reel" and lines[0]["slug"] == slug and lines[0]["by"] == "auto"


def test_reach_says_a_network_went_quiet_when_its_latest_posts_get_nothing_after_earlier_ones_were_seen(monkeypatch):
    """27 Nov: Facebook's reel of 10 Nov had 102 plays, so Facebook was never "stalled", while every reel from 18 Nov on
    read 0 plays and nothing said so."""
    from datetime import datetime, timedelta, timezone

    from studio import perf, posting

    now = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
    day = lambda d: (now - timedelta(days=d)).isoformat()  # noqa: E731
    rows = [("facebook", 17, 102), ("facebook", 9, 0), ("facebook", 8, 0), ("facebook", 6, 0), ("facebook", 3, 0),
            ("facebook", 0.1, 0),                                      # two hours out: too young to count
            ("x", 5, 0), ("x", 4, 0), ("x", 3, 40),                   # the latest was seen: not quiet
            ("tiktok", 5, 0), ("tiktok", 4, 0), ("tiktok", 3, 0),     # never seen: stalled, not quiet
            ("youtube", 6, 900), ("youtube", 4, 0), ("youtube", 2, 0)]  # only two at nothing: too few
    posts = [{"id": i, "slug": f"s{i}", "network": n, "status": "posted", "at": day(d)} for i, (n, d, _) in enumerate(rows, start=1)]
    reads = [{"post_id": i, "views": v, "likes": 0} for i, (_, _, v) in enumerate(rows, start=1)]
    monkeypatch.setattr(posting, "posts", lambda: posts)
    monkeypatch.setattr(perf, "readings", lambda: reads)
    by = {n["network"]: n for n in perf.reach(now=now)["networks"]}
    assert by["facebook"]["quiet"] == {"posts": 4, "since": day(9)} and not by["facebook"]["stalled"]
    assert "quiet" not in by["x"] and "quiet" not in by["youtube"]
    assert by["tiktok"]["stalled"] and "quiet" not in by["tiktok"], "never seen is stalled; quiet is only after a seen post"
    assert all("_seq" not in n for n in by.values())


def test_insights_judge_shorts_by_engaged_views_and_the_share_of_viewers_kept():
    """27 Nov: 83 % of viewers swiped away; the studio's Shorts kept about 9 %, the camera's time-lapses about 26 %.
    A Shorts view is any start or replay since March 2025, so the hook and the top list rank by engaged views."""
    shorts = [_short(1, "不便だからこそ、尾根まで見渡せる。｜Cafe Kumo", 1270, engaged=107),
              _short(2, "区画がないからこそ、気の向くまま張れる。｜Cafe Kumo", 1100, engaged=63),
              _short(3, "星が見える夜だからこそ、外で火を囲む。｜Cafe Kumo", 920, engaged=226),
              _short(4, "遠いからこそ、騒げる｜Cafe Kumo", 265, engaged=25),
              _short(5, "車で来て、車で寝る。｜Cafe Kumo", 200, engaged=17),
              _short(6, "紅葉のCafe Kumo｜Cafe Kumo", 182, engaged=20),
              _short(7, "仕事は浅く、つながりは深く。｜Cafe Kumo", 220, engaged=21),
              _short(8, "朝焼けの山、10時間を31秒で #shorts", 1080, engaged=405, slug=None),
              _short(9, "雲の山、71分を24秒で #shorts", 1150, engaged=364, slug=None),
              _short(10, "夕焼けの山、10時間を31秒で #shorts", 660, engaged=200, slug=None)]
    out = perf.insights_from({"channels": [{"items": shorts}]}, [], [], [], {}, {}, NOW)
    y = out["youtube"]
    assert y["metric"] == "engaged" and y["hook"]["metric"] == "engaged" and y["hook"]["phrase"] == "からこそ"
    assert y["hook"]["with"]["median"] == 85 and y["hook"]["without"]["median"] == 20, "medians of engaged views, not views"
    assert y["hook"]["kept"] == {"with": 8.9, "without": 9.5}, "more engaged views, about the same share kept: shown wider"
    assert [t["slug"] for t in y["top"]] == ["s3", "s1", "s2"], "ranked by engaged views: 226, 107, 63"
    assert y["kept"]["n"] == 7 and 8 < y["kept"]["pct"] < 11 and y["kept"]["outside"]["n"] == 3 and y["kept"]["outside"]["pct"] > 30
    assert out["outside"]["kept"] == {"outside": y["kept"]["outside"]["pct"], "studio": y["kept"]["pct"]}
    # without Analytics (no engaged views) everything stays on views, as before
    plain = [{k: v for k, v in s.items() if k != "engaged"} for s in shorts]
    y2 = perf.insights_from({"channels": [{"items": plain}]}, [], [], [], {}, {}, NOW)["youtube"]
    assert y2["metric"] == "views" and "kept" not in y2 and y2["hook"]["metric"] == "views" and "kept" not in y2["hook"]
