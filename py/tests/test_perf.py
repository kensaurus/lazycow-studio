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
    old = post(1, "youtube", remote_id="jKq4gp5a7S0", hours_ago=80)
    new = post(2, "youtube", slug="loud-1107", url="https://youtube.com/shorts/WEdE6u1qGn4", hours_ago=10)
    fake = Fake([
        ("GET", "/videos?", [(200, {"items": [{"id": "jKq4gp5a7S0", "statistics": {"viewCount": "812", "likeCount": "40", "commentCount": "3", "favoriteCount": "0"}},
                                              {"id": "WEdE6u1qGn4", "statistics": {"viewCount": "95", "likeCount": "5", "commentCount": "0"}}]})]),
        ("GET", "youtubeanalytics", [(200, {"columnHeaders": [{"name": n} for n in ("engagedViews", "views", "estimatedMinutesWatched", "averageViewDuration",
                                                                                     "averageViewPercentage", "likes", "comments", "shares", "subscribersGained")],
                                            "rows": [[400, 800, 120.5, 9.1, 61.3, 40, 3, 7, 2]]})]),
    ])
    monkeypatch.setattr(perf, "_http", fake)
    got, notes = perf.COLLECTORS["youtube"].fetch([{**old, "age_h": 80}, {**new, "age_h": 10}])
    assert len(fake.find("/videos?")) == 1 and "jKq4gp5a7S0%2CWEdE6u1qGn4" in fake.find("/videos?")[0]["url"]
    assert len(fake.find("youtubeanalytics")) == 1, "a 10 h old Short does not ask Analytics yet"
    assert "video%3D%3DjKq4gp5a7S0" in fake.find("youtubeanalytics")[0]["url"]
    a = next(g for g in got if g["post"]["id"] == 1)
    assert a["numbers"] == {"views": 812, "likes": 40, "comments": 3, "watch_time_s": 7230.0, "avg_view_pct": 61.3, "avg_view_s": 9.1, "shares": 7, "followers_gained": 2}
    assert a["extra"] == {"engaged_views": 400, "analytics_views": 800}
    b = next(g for g in got if g["post"]["id"] == 2)
    assert b["numbers"] == {"views": 95, "likes": 5, "comments": 0} and b["remote_id"] == "WEdE6u1qGn4"
    assert not notes
    assert all(c["headers"]["authorization"] == f"Bearer {TOKEN}" for c in fake.calls)


def test_youtube_without_the_analytics_scope_says_what_to_press(world, monkeypatch):
    yt_ready(monkeypatch, analytics=False)
    monkeypatch.setattr(perf, "_http", Fake([("GET", "/videos?", [(200, {"items": [{"id": "jKq4gp5a7S0", "statistics": {"viewCount": "5"}}]})])]))
    got, notes = perf.COLLECTORS["youtube"].fetch([{**post(1, "youtube", remote_id="jKq4gp5a7S0"), "age_h": 80}])
    assert got[0]["numbers"] == {"views": 5}
    assert any("Connect YouTube again" in n and "Analytics" in n for n in notes)


def test_youtube_analytics_retries_without_engaged_views_and_explains_a_disabled_api(world, monkeypatch):
    yt_ready(monkeypatch)
    stats = ("GET", "/videos?", [(200, {"items": [{"id": "jKq4gp5a7S0", "statistics": {"viewCount": "5"}}]})])
    fake = Fake([stats, ("GET", "youtubeanalytics", [(400, {"error": {"message": "Unknown identifier (engagedViews)"}}),
                                                     (200, {"columnHeaders": [{"name": "views"}, {"name": "shares"}], "rows": [[5, 1]]})])])
    monkeypatch.setattr(perf, "_http", fake)
    got, _ = perf.COLLECTORS["youtube"].fetch([{**post(1, "youtube", remote_id="jKq4gp5a7S0"), "age_h": 80}])
    assert "engagedViews" not in fake.find("youtubeanalytics")[1]["url"] and got[0]["numbers"]["shares"] == 1
    monkeypatch.setattr(perf, "_http", Fake([stats, ("GET", "youtubeanalytics", [(403, {"error": {"message": "API not enabled"}})])]))
    _, notes = perf.COLLECTORS["youtube"].fetch([{**post(1, "youtube", remote_id="jKq4gp5a7S0"), "age_h": 80}])
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
    assert perf.youtube_id({"url": "https://youtube.com/shorts/jKq4gp5a7S0"}) == "jKq4gp5a7S0"
    assert perf.youtube_id({"url": "https://www.youtube.com/watch?v=jKq4gp5a7S0&t=1"}) == "jKq4gp5a7S0"
    assert perf.facebook_id({"url": "https://www.facebook.com/reel/1787316039049482"}) == "1787316039049482"
    assert perf.facebook_id({"url": None}) is None


# ---------- collect, checkpoints, the hourly gap ----------

def test_collect_reads_due_posts_once_per_checkpoint_and_lists_the_rest(world, monkeypatch):
    world += [post(1, "bluesky", url="https://bsky.app/profile/did:plc:abc/post/r1", hours_ago=30),
              post(2, "tiktok", hours_ago=30, status="scheduled"),
              post(3, "youtube", remote_id="jKq4gp5a7S0", hours_ago=-5, status="scheduled"),  # goes out later
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
    world += [post(1, "bluesky", url="https://bsky.app/profile/did:plc:abc/post/r1"), post(2, "youtube", remote_id="jKq4gp5a7S0")]
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
         "1855000000000000001,\"Fri, Nov 14, 2026\",紅葉の嬬恋,https://x.com/example_owner/status/1855000000000000001,1234,20,55,3,2,1,4,5,6,7,8,0,1\n"
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
    assert d["networks"]["youtube"] == {"metric": "views", "median": 300, "posts": 3}
    assert d["byPost"][3]["ratio"] == pytest.approx(901 / 301, rel=1e-3) and "3.0x the median views on YouTube" in d["byPost"][3]["sentence"]
    # Engaged views win once most YouTube readings carry them.
    for r in rows:
        r["extra"] = {"engaged_views": (r["views"] or 0) // 2}
    assert learn.comparable(posts=posts, rows=rows)["networks"]["youtube"]["metric"] == "engaged_views"


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


def test_steer_switch(monkeypatch):
    monkeypatch.delenv("STUDIO_PERF_STEER", raising=False)
    assert not learn.steer_on()
    monkeypatch.setenv("STUDIO_PERF_STEER", "1")
    assert learn.steer_on()


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
