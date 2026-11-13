"""Booked posts are confirmed live, flagged when they never appear, sent or marked missed after downtime, and old
failures a newer booking replaced are tidied (studio.live)."""
from datetime import datetime, timedelta, timezone

import pytest

import studio.live as live
from studio import posting

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone(timedelta(hours=9)))


def iso(dt):
    return dt.isoformat(timespec="minutes")


@pytest.fixture
def fresh(tmp_path, monkeypatch):
    """Empty posts table and settings for each test."""
    monkeypatch.setattr(live, "SETTINGS_FILE", tmp_path / "autopost.json")
    with posting.connect() as con:
        posting._ready(con)
        con.execute("DELETE FROM posts")
    yield
    with posting.connect() as con:
        con.execute("DELETE FROM posts")


def row(pid):
    return next(r for r in posting.posts() if r["id"] == pid)


def test_seen_confirms_a_booked_post_with_its_link_and_time(fresh):
    pid = posting.record("a-1", "x", "scheduled", iso(NOW - timedelta(hours=2)), url="https://x.com/someone")
    assert live.seen(pid, "https://x.com/someone/status/123", "read in your Chrome", NOW)
    r = row(pid)
    assert r["status"] == "posted" and r["url"].endswith("/123") and r["seen_at"].startswith("2026-11-20T12:00")
    assert "seen live" in r["note"] and not live.seen(pid, when=NOW)  # once


def test_missing_only_after_the_grace_hours(fresh):
    pid = posting.record("a-1", "tiktok", "scheduled", iso(NOW - timedelta(hours=3)))
    assert not live.missing(pid, "not on the profile", NOW)  # 3 h < 6 h
    assert row(pid)["status"] == "scheduled"
    assert live.missing(pid, "not on the profile", NOW + timedelta(hours=4))
    assert row(pid)["status"] == "missing" and "not on the profile" in row(pid)["note"]
    assert live.seen(pid, "", "found later", NOW + timedelta(hours=5)) and row(pid)["status"] == "posted"


def test_catch_up_sends_a_little_late_and_marks_long_late_missed(fresh, monkeypatch):
    monkeypatch.setattr(live, "_now", lambda: NOW)
    soon = posting.record("a-1", "bluesky", "queued", iso(NOW - timedelta(minutes=50)))
    late = posting.record("a-2", "bluesky", "queued", iso(NOW - timedelta(hours=7)))
    ahead = posting.record("a-3", "bluesky", "queued", iso(NOW + timedelta(hours=7)))
    got = live.catch_up(NOW)
    assert got == {"send": [soon], "missed": [late]}
    assert row(late)["status"] == "missing" and row(ahead)["status"] == "queued" and row(soon)["status"] == "queued"


def test_tidy_retires_failures_whose_day_was_booked_again(fresh):
    day = iso(NOW + timedelta(days=3))
    old = posting.record("a-1", "facebook", "failed", day, note="token expired")
    posting.record("a-2", "facebook", "scheduled", day)
    lone = posting.record("a-3", "facebook", "failed", iso(NOW + timedelta(days=4)))
    assert live.tidy() == {"replaced": [old]}
    assert row(old)["status"] == "replaced" and row(lone)["status"] == "failed"


def test_check_api_confirms_youtube_and_facebook_and_flags_errors(fresh, monkeypatch):
    yt = posting.record("a-1", "youtube", "scheduled", iso(NOW - timedelta(hours=2)), remote_id="abcdefghijk")
    yt_private = posting.record("a-2", "youtube", "scheduled", iso(NOW - timedelta(hours=8)), remote_id="bbbbbbbbbbb")
    fb = posting.record("a-3", "facebook", "scheduled", iso(NOW - timedelta(hours=2)), remote_id="111")
    fb_err = posting.record("a-4", "facebook", "scheduled", iso(NOW - timedelta(hours=2)), remote_id="222")
    future = posting.record("a-5", "youtube", "scheduled", iso(NOW + timedelta(hours=2)), remote_id="ccccccccccc")
    monkeypatch.setattr(live, "_youtube_state", lambda vid: ("public", "") if vid == "abcdefghijk" else ("private", ""))
    monkeypatch.setattr(live, "_facebook_state", lambda vid: ("published", "https://www.facebook.com/reel/111") if vid == "111" else ("error", "Facebook: copyright"))
    got = live.check_api(NOW)
    assert sorted(got["seen"]) == sorted([yt, fb]) and got["missing"] == [yt_private] and got["failed"] == [fb_err]
    assert row(fb)["url"] == "https://www.facebook.com/reel/111" and row(future)["status"] == "scheduled"
    assert "copyright" in row(fb_err)["note"]


def test_settings_are_checked_and_off_switches_work(fresh, monkeypatch):
    assert live.settings()["verify"]["missingAfterH"] == 6
    live.save_settings({"verify": {"missingAfterH": 12}, "plan": {"networks": ["tiktok", "x"]}})
    assert live.settings()["verify"]["missingAfterH"] == 12 and live.settings()["plan"]["networks"] == ["tiktok", "x"]
    for bad in ({"verify": {"missingAfterH": 0}}, {"nope": {}}, {"plan": {"networks": ["myspace"]}}, {"verify": {"x": 1}}):
        with pytest.raises(ValueError):
            live.save_settings(bad)
    live.save_settings({"verify": {"on": False}, "tidy": {"on": False}})
    assert live.check_api(NOW).get("off") and live.tidy().get("off")


def test_a_reading_of_numbers_confirms_the_post(fresh):
    from studio import perf

    pid = posting.record("a-1", "linkedin", "scheduled", iso(NOW - timedelta(hours=2)))
    perf.store(row(pid), {"views": 12}, "browser", at=NOW)
    assert row(pid)["status"] == "posted" and row(pid)["seen_at"]


def test_numbers_read_before_the_checks_existed_count_as_seen(fresh, monkeypatch):
    from studio import perf

    monkeypatch.setattr(live, "_youtube_state", lambda vid: ("unknown", "not asked"))
    pid = posting.record("a-1", "tiktok", "scheduled", iso(NOW - timedelta(hours=20)))
    early = posting.record("a-2", "x", "scheduled", iso(NOW - timedelta(hours=20)))
    with posting.connect() as con:
        perf._ready(con)
        con.execute("DELETE FROM metrics")
        con.execute("INSERT INTO metrics (post_id, network, slug, fetched_at, source) VALUES (?, 'tiktok', 'a-1', ?, 'browser')", (pid, iso(NOW - timedelta(hours=19))))
        con.execute("INSERT INTO metrics (post_id, network, slug, fetched_at, source) VALUES (?, 'x', 'a-2', ?, 'browser')", (early, iso(NOW - timedelta(hours=30))))
    got = live.check_api(NOW)
    assert got["seen"] == [pid] and row(pid)["status"] == "posted" and "its numbers were read" in row(pid)["note"]
    assert row(early)["status"] == "scheduled", "a reading from before its time proves nothing"
    with posting.connect() as con:
        con.execute("DELETE FROM metrics")


def test_catch_up_off_sends_nothing_late(fresh, monkeypatch):
    live.save_settings({"catchUp": {"on": False}})
    on_time = posting.record("a-1", "bluesky", "queued", iso(NOW - timedelta(minutes=5)))
    late = posting.record("a-2", "bluesky", "queued", iso(NOW - timedelta(minutes=50)))
    very = posting.record("a-3", "bluesky", "queued", iso(NOW - timedelta(hours=72)))
    got = live.catch_up(NOW)
    assert got["send"] == [on_time] and sorted(got["missed"]) == sorted([late, very])
    assert row(very)["status"] == "missing"


def test_a_missed_post_can_be_booked_again_and_stays_as_history(fresh):
    pid = posting.record("a-1", "bluesky", "queued", iso(NOW - timedelta(hours=7)))
    live.catch_up(NOW)
    assert row(pid)["status"] == "missing"
    posting.retire(pid)
    assert row(pid)["status"] == "replaced" and "booked again" in row(pid)["note"]
    planned = posting.record("a-2", "bluesky", "failed", iso(NOW))
    posting.retire(planned)
    assert all(r["id"] != planned for r in posting.posts()), "a failed row is still simply removed"


def test_missing_youtube_and_facebook_posts_are_asked_again_for_three_days(fresh, monkeypatch):
    yt = posting.record("a-1", "youtube", "scheduled", iso(NOW - timedelta(hours=10)), remote_id="abcdefghijk")
    old = posting.record("a-2", "youtube", "scheduled", iso(NOW - timedelta(hours=80)), remote_id="bbbbbbbbbbb")
    for pid in (yt, old):
        live.missing(pid, "still private", NOW)
    assert row(yt)["status"] == "missing" and row(old)["status"] == "missing"
    monkeypatch.setattr(live, "_youtube_state", lambda vid: ("public", ""))
    got = live.check_api(NOW)
    assert got["seen"] == [yt] and row(yt)["status"] == "posted"
    assert row(old)["status"] == "missing", "older than 72 h: left for a person"
