"""The posting log and YouTube's guard rails: plans become reminders, a reel is not sent twice,
a schedule is always in the future, and the stored token is never readable as text."""
from datetime import datetime, timedelta

import pytest

from studio import posting, youtube


def test_a_plan_becomes_a_reminder_then_a_posted_record():
    at = (datetime.now() + timedelta(days=1)).replace(hour=19, minute=0, second=0, microsecond=0).isoformat(timespec="minutes")
    pid = posting.plan("test-reel", "instagram", at)
    row = next(p for p in posting.posts() if p["id"] == pid)
    # Stored with its offset: the same moment, readable the same way whatever the computer's or audience's zone.
    assert row["status"] == "planned" and datetime.fromisoformat(row["at"]) == datetime.fromisoformat(at).astimezone()
    assert datetime.fromisoformat(row["at"]).tzinfo is not None

    cal = posting.ics(pid)
    assert "BEGIN:VEVENT" in cal and "TRIGGER:-PT10M" in cal and "Post test-reel on instagram" in cal
    assert "\r\n" in cal

    with pytest.raises(ValueError):
        posting.done(pid, "http://not-https.example")
    posting.done(pid, "https://www.instagram.com/reel/abc/")
    row = next(p for p in posting.posts() if p["id"] == pid)
    assert row["status"] == "posted" and row["url"].startswith("https://")
    with pytest.raises(ValueError):
        posting.drop(pid)  # what went out stays on record


def test_marking_posted_keeps_the_time_it_really_went_out():
    # A scheduled post that went out by itself keeps its scheduled time when "Mark posted" is pressed later;
    # a given time wins; a plan marked posted without a time is stamped now.
    past = (datetime.now() - timedelta(hours=14)).replace(second=0, microsecond=0).isoformat(timespec="minutes")
    pid = posting.plan("test-reel", "tiktok", (datetime.now() + timedelta(days=1)).isoformat(timespec="minutes"))
    posting.booked(pid, "https://www.tiktok.com/@x/video/1", past)
    posting.done(pid, "https://www.tiktok.com/@x/video/1")
    assert next(p for p in posting.posts() if p["id"] == pid)["at"] == past

    pid2 = posting.plan("test-reel", "x", (datetime.now() + timedelta(days=1)).isoformat(timespec="minutes"))
    posting.done(pid2, "https://x.com/a/status/1", "2026-11-08T20:00+09:00")
    assert next(p for p in posting.posts() if p["id"] == pid2)["at"].startswith("2026-11-08T20:00")

    pid3 = posting.plan("test-reel", "threads", (datetime.now() + timedelta(days=1)).isoformat(timespec="minutes"))
    before = datetime.now().replace(second=0, microsecond=0)
    posting.done(pid3, "https://www.threads.com/@x/post/1")
    assert datetime.fromisoformat(next(p for p in posting.posts() if p["id"] == pid3)["at"]) >= before


def test_only_known_networks_can_be_planned_and_plans_can_be_dropped():
    with pytest.raises(ValueError):
        posting.plan("test-reel", "myspace", "2030-01-01T10:00")
    pid = posting.plan("test-reel", "threads", "2030-01-01T10:00")
    posting.drop(pid)
    assert all(p["id"] != pid for p in posting.posts())


def test_a_schedule_must_be_at_least_15_minutes_ahead():
    with pytest.raises(RuntimeError):
        youtube._rfc3339((datetime.now() + timedelta(minutes=5)).isoformat(timespec="minutes"))
    out = youtube._rfc3339((datetime.now() + timedelta(days=2)).isoformat(timespec="minutes"))
    assert out.endswith("Z") and "T" in out


def test_a_reel_already_on_youtube_is_not_uploaded_twice(monkeypatch):
    from studio import publish

    monkeypatch.setattr(publish, "review_status", lambda slug: "approved")
    posting.record("dup-reel", "youtube", "scheduled", "2030-01-01T19:00", "abc123", "https://youtube.com/shorts/abc123")
    with pytest.raises(RuntimeError, match="already on YouTube"):
        youtube.upload("dup-reel", at="2030-01-02T19:00")


def test_the_stored_token_is_not_plain_text(tmp_path, monkeypatch):
    monkeypatch.setattr(youtube, "SECRETS", tmp_path)
    youtube._save_token({"refresh_token": "1//secret-refresh-value", "access_token": "x", "expires": 0})
    raw = (tmp_path / "youtube_token.bin").read_bytes()
    if youtube.sys.platform == "win32":
        assert b"secret-refresh-value" not in raw
    assert youtube._load_token()["refresh_token"] == "1//secret-refresh-value"


def test_sign_in_state_must_match(tmp_path, monkeypatch):
    monkeypatch.setattr(youtube, "SECRETS", tmp_path)
    monkeypatch.setattr(youtube, "client", lambda: ("id.apps.googleusercontent.com", "s"))
    url = youtube.auth_url()
    assert "code_challenge_method=S256" in url and "access_type=offline" in url and "127.0.0.1%3A4317%2Foauth%2Fyoutube" in url
    with pytest.raises(RuntimeError, match="state did not match"):
        youtube.exchange("code", "wrong-state")


def test_youtube_refuses_a_reel_nobody_approved(monkeypatch):
    from studio import publish

    monkeypatch.setattr(publish, "review_status", lambda slug: "rendered")
    with pytest.raises(RuntimeError, match="not approved"):
        youtube.upload("unapproved-reel", at="2030-01-02T19:00")


def test_post_times_are_stored_with_their_offset():
    # A bare time is this computer's local time; a time with an offset keeps it; junk is left for the caller to reject.
    bare = "2026-11-10T18:00"
    assert posting.with_offset(bare) == datetime.fromisoformat(bare).astimezone().isoformat(timespec="minutes")
    assert posting.with_offset("2026-11-10T19:00+09:00") == "2026-11-10T19:00+09:00"
    assert posting.with_offset("2026-11-10T10:00Z") == "2026-11-10T10:00+00:00"
    assert posting.with_offset(None) is None and posting.with_offset("soon") == "soon"


def test_a_studio_held_post_moves_but_one_a_day_and_network_bookings_stay():
    from datetime import timezone as tz
    base = (datetime.now(tz.utc) + timedelta(days=30)).replace(hour=10, minute=0, second=0, microsecond=0)
    a = posting.queue("move-test-a", "bluesky", base.isoformat(timespec="minutes"))
    b = posting.queue("move-test-b", "bluesky", (base + timedelta(days=1)).isoformat(timespec="minutes"))
    got = posting.move(a, (base + timedelta(days=2)).isoformat(timespec="minutes"))
    assert datetime.fromisoformat(got) == base + timedelta(days=2)
    with pytest.raises(ValueError, match="one a day"):
        posting.move(a, (base + timedelta(days=1, hours=2)).isoformat(timespec="minutes"))
    with pytest.raises(ValueError, match="15 minutes"):
        posting.move(a, datetime.now(tz.utc).isoformat(timespec="minutes"))
    c = posting.record("move-test-c", "facebook", "scheduled", (base + timedelta(days=3)).isoformat(timespec="minutes"))
    with pytest.raises(ValueError, match="booked on the network"):
        posting.move(c, (base + timedelta(days=4)).isoformat(timespec="minutes"))
    for pid in (a, b):
        posting.drop(pid)
