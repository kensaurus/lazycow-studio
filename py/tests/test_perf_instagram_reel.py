"""Results for Instagram reels the studio sent (studio.perf.InstagramReel) against a fake Graph API: plays, reach,
likes, comments, shares, saves and watch time from the media insights; a reel posted by hand (no media id) stays with
"needs numbers by hand"; a missing permission stops the network with what to press."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from studio import perf
from studio.db import connect

FB_TOKEN = "EAAB" + "y" * 40
NOW = datetime(2026, 11, 27, 12, 0, tzinfo=timezone(timedelta(hours=9)))
MID = "18000000000000042"


class Fake:
    def __init__(self, routes):
        self.routes = [(m, part, list(replies)) for m, part, replies in routes]
        self.calls = []

    def __call__(self, method, url, *, data=None, headers=None, timeout=30):
        self.calls.append({"method": method, "url": url})
        for m, part, replies in self.routes:
            if m == method and part in url:
                reply = replies.pop(0) if len(replies) > 1 else replies[0]
                return reply[0], {}, json.dumps(reply[1]).encode()
        raise AssertionError(f"unexpected call {method} {url}")


def post(pid, network, slug="cafe-reel-1", hours_ago=30.0, **kw):
    at = (NOW - timedelta(hours=hours_ago)).isoformat(timespec="minutes")
    return {"id": pid, "slug": slug, "network": network, "status": "posted", "at": at, "remote_id": kw.pop("remote_id", None),
            "url": kw.pop("url", None), "note": "", "created": at, **kw}


@pytest.fixture
def world(monkeypatch):
    with connect() as con:
        perf._ready(con)
        con.execute("DELETE FROM metrics")
    rows = []
    monkeypatch.setattr(perf, "_now", lambda: NOW)
    monkeypatch.setattr(perf, "_posts", lambda: rows)
    monkeypatch.setattr(perf, "_http", Fake([]))
    monkeypatch.setattr(perf.InstagramStory, "_creds", lambda self: {"page_id": "1", "token": FB_TOKEN})
    perf._state_path().unlink(missing_ok=True)
    return rows


INSIGHTS = {"data": [{"name": "views", "values": [{"value": 1840}]}, {"name": "reach", "total_value": {"value": 1520}},
                     {"name": "likes", "values": [{"value": 61}]}, {"name": "comments", "values": [{"value": 4}]},
                     {"name": "shares", "values": [{"value": 9}]}, {"name": "saved", "values": [{"value": 12}]},
                     {"name": "total_interactions", "values": [{"value": 86}]},
                     {"name": "ig_reels_avg_watch_time", "values": [{"value": 6350}]},
                     {"name": "ig_reels_video_view_total_time", "values": [{"value": 11684000}]}]}


def test_a_sent_reel_is_read_with_the_reels_metrics(world, monkeypatch):
    fake = Fake([("GET", f"/{MID}/insights", [(200, INSIGHTS)])])
    monkeypatch.setattr(perf, "_http", fake)
    got, notes = perf.COLLECTORS["instagram"].fetch([{**post(70, "instagram", remote_id=MID), "age_h": 30}])
    assert got[0]["numbers"] == {"views": 1840, "reach": 1520, "likes": 61, "comments": 4, "shares": 9, "saves": 12,
                                 "avg_view_s": 6.35, "watch_time_s": 11684.0}
    assert got[0]["extra"] == {"total_interactions": 86} and not notes
    asked = fake.calls[0]["url"]
    for m in ("views", "reach", "likes", "comments", "shares", "saved", "ig_reels_avg_watch_time"):
        assert m in asked
    assert "plays" not in asked and "impressions" not in asked, "metrics Meta no longer lists for reels"


def test_collect_reads_the_sent_reel_and_leaves_the_hand_posted_one_to_be_typed_in(world, monkeypatch):
    world.append(post(71, "instagram", remote_id=MID))
    world.append(post(72, "instagram", slug="cafe-reel-2", url="https://www.instagram.com/reel/XyZ987/"))
    monkeypatch.setattr(perf, "_http", Fake([("GET", "insights", [(200, INSIGHTS)])]))
    out = perf.collect({})
    assert [s["post_id"] for s in out["stored"]] == [71]
    assert [m["post_id"] for m in out["needsNumbers"]] == [72], "posted by hand: no media id to read"
    assert [n["post_id"] for n in perf.needs({})["needsNumbers"]] == [72]
    assert perf.collected(world[0]) and not perf.collected(world[1])


def test_a_missing_insights_permission_says_what_to_press(world, monkeypatch):
    world.append(post(73, "instagram", remote_id=MID))
    monkeypatch.setattr(perf, "_http", Fake([("GET", "insights", [(400, {"error": {"code": 10, "message": "(#10) Application does not have permission"}})])]))
    out = perf.collect({})
    assert out["problems"][0]["network"] == "instagram" and "instagram_manage_insights" in out["problems"][0]["error"]
    assert FB_TOKEN not in json.dumps(out)
