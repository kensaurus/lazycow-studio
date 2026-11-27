"""Posting from the studio: a connected network posts now, holds a schedule itself, or is queued for the
studio to send at its time; a refusal is kept as "failed" with the reason; a project's network switches apply."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from studio import posting, publish


class Fake:
    NAME, HOW, FIELDS = "Fake", "", []

    def __init__(self, can_schedule, fail=False):
        self.can_schedule, self.fail, self.calls = can_schedule, fail, []

    def status(self):
        return {"connected": True, "account": "@fake", "error": None}

    def post(self, video, text, at=None):
        self.calls.append((video, text, at))
        if self.fail:
            raise RuntimeError("rate limited")
        return {"url": "https://example.com/p/1", "remote_id": "r1", "scheduled": at is not None}


@pytest.fixture
def net(monkeypatch, tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    monkeypatch.setattr(publish, "file_for", lambda slug, n: (video, "hello"))
    monkeypatch.setattr(publish, "review_status", lambda slug: "approved")

    def use(mod):
        monkeypatch.setattr(publish, "_registry", lambda: {"bluesky": mod})
        return mod
    return use


def _row(pid):
    return next(p for p in posting.posts() if p["id"] == pid)


def test_post_now_records_the_live_link(net):
    mod = net(Fake(can_schedule=False))
    out = publish.publish("pub-a", "bluesky")
    assert out["status"] == "posted" and mod.calls[0][2] is None
    assert _row(out["id"])["url"] == "https://example.com/p/1"


def test_a_network_without_schedules_is_queued_then_sent_when_due(net):
    mod = net(Fake(can_schedule=False))
    later = (datetime.now(timezone.utc) + timedelta(hours=2)).astimezone().isoformat(timespec="minutes")
    out = publish.publish("pub-b", "bluesky", later)
    assert out["status"] == "queued" and not mod.calls
    assert out["id"] not in [r["id"] for r in posting.due()]
    assert out["id"] in [r["id"] for r in posting.due(datetime.now(timezone.utc) + timedelta(hours=3))]
    # Make it due now and let the runner send it.
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).astimezone().isoformat(timespec="minutes")
    from studio.db import connect
    with connect() as con:
        con.execute("UPDATE posts SET at = ? WHERE id = ?", (past, out["id"]))
    sent = [r for r in publish.run_due() if r["id"] == out["id"]]
    assert sent and sent[0]["status"] == "posted" and _row(out["id"])["status"] == "posted"


def test_a_second_due_run_sends_nothing_while_one_is_sending(net):
    """14 Nov: two runs read the same queued Bluesky post and both sent it."""
    from studio.config import DATA
    from studio.db import connect
    mod = net(Fake(can_schedule=False))
    later = (datetime.now(timezone.utc) + timedelta(hours=2)).astimezone().isoformat(timespec="minutes")
    out = publish.publish("pub-lock", "bluesky", later)
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).astimezone().isoformat(timespec="minutes")
    with connect() as con:
        con.execute("UPDATE posts SET at = ? WHERE id = ?", (past, out["id"]))
    lock = Path(DATA) / "post-due.lock"
    lock.write_text("123")
    try:
        assert publish.run_due() == [] and not mod.calls and _row(out["id"])["status"] == "queued"
    finally:
        lock.unlink(missing_ok=True)
    sent = [r for r in publish.run_due() if r["id"] == out["id"]]
    assert sent[0]["status"] == "posted" and len(mod.calls) == 1 and not lock.exists()


def test_a_network_that_holds_schedules_gets_the_time(net):
    mod = net(Fake(can_schedule=True))
    later = (datetime.now(timezone.utc) + timedelta(days=1)).astimezone().isoformat(timespec="minutes")
    out = publish.publish("pub-c", "bluesky", later)
    assert out["status"] == "scheduled" and mod.calls[0][2] is not None


def test_a_refusal_is_kept_with_its_reason(net):
    net(Fake(can_schedule=False, fail=True))
    with pytest.raises(RuntimeError, match="rate limited"):
        publish.publish("pub-d", "bluesky")
    failed = [p for p in posting.posts() if p["slug"] == "pub-d"]
    assert failed and failed[0]["status"] == "failed" and "rate limited" in failed[0]["note"]
    posting.drop(failed[0]["id"])  # a failed try can be cleared


def test_unknown_network_says_to_use_the_upload_page(net):
    net(Fake(can_schedule=False))
    with pytest.raises(ValueError, match="upload page"):
        publish.publish("pub-e", "tiktok")


def test_project_network_switches(tmp_path, monkeypatch):
    from studio import reels
    (tmp_path / "networks.json").write_text(json.dumps({"off": ["tiktok"], "on": ["instagram"], "accounts": {"x": "@example_owner"}}), encoding="utf-8")
    monkeypatch.setattr(reels, "DATA", tmp_path)
    spec = json.loads(Path(reels.ROOT / "shared" / "channels.json").read_text(encoding="utf-8"))
    out = {c["id"]: c for c in reels._own_networks(spec)["channels"]}
    assert out["tiktok"].get("off") is True
    assert "off" not in out["instagram"]
    assert out["x"]["account"] == "@example_owner"


def test_a_reel_nobody_approved_is_never_posted(net, monkeypatch):
    mod = net(Fake(can_schedule=False))
    for status in (None, "rendered", "rejected"):
        monkeypatch.setattr(publish, "review_status", lambda slug, s=status: s)
        with pytest.raises(publish.NotApproved, match="approved"):
            publish.publish("pub-x", "bluesky")
    assert not mod.calls


def test_a_queued_post_waits_while_its_reel_is_back_in_review(net, monkeypatch):
    mod = net(Fake(can_schedule=False))
    later = (datetime.now(timezone.utc) + timedelta(hours=2)).astimezone().isoformat(timespec="minutes")
    out = publish.publish("pub-y", "bluesky", later)
    monkeypatch.setattr(publish, "review_status", lambda slug: "rendered")  # new words: back to review
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).astimezone().isoformat(timespec="minutes")
    from studio.db import connect

    with connect() as con:
        con.execute("UPDATE posts SET at = ? WHERE id = ?", (past, out["id"]))
    sent = [r for r in publish.run_due() if r["id"] == out["id"]]
    assert sent and sent[0]["status"] == "held" and not mod.calls
    assert _row(out["id"])["status"] == "queued"  # still booked: it goes out once a person approves it again


def _future(hours=30):
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).astimezone().isoformat(timespec="minutes")


def test_replace_swaps_a_facebook_booking_for_the_new_render(net, monkeypatch):
    from studio.connectors import facebook

    gone = []
    monkeypatch.setattr(facebook, "delete", lambda rid: gone.append(rid))
    mod = net(Fake(can_schedule=True))
    monkeypatch.setattr(publish, "_registry", lambda: {"facebook": mod})
    old = posting.record("pub-r", "facebook", "scheduled", _future(), "1234567890", "https://facebook.com/reel/1")
    out = publish.replace(old)
    assert gone == ["1234567890"] and out["replaced"] == old and out["status"] == "scheduled"
    assert _row(old)["status"] == "replaced" and len(mod.calls) == 1


def test_replace_swaps_a_youtube_booking(net, monkeypatch):
    from studio import youtube

    calls = []
    monkeypatch.setattr(youtube, "delete_video", lambda vid: calls.append(("del", vid)))
    monkeypatch.setattr(youtube, "upload", lambda slug, at=None, force=False: calls.append(("up", slug, at, force)) or {"id": "new1", "url": "u"})
    old = posting.record("pub-y2", "youtube", "scheduled", _future(), "abcDEF12345", "https://youtube.com/shorts/abcDEF12345")
    out = publish.replace(old)
    assert calls[0] == ("del", "abcDEF12345") and calls[1][0] == "up" and calls[1][3] is True
    assert out["replaced"] == old and _row(old)["status"] == "replaced"


def test_replace_refuses_an_unapproved_reel_or_a_post_about_to_go_out(net, monkeypatch):
    old = posting.record("pub-z", "facebook", "scheduled", _future(), "999", "")
    monkeypatch.setattr(publish, "review_status", lambda slug: "rendered")
    with pytest.raises(publish.NotApproved):
        publish.replace(old)
    monkeypatch.setattr(publish, "review_status", lambda slug: "approved")
    soon = posting.record("pub-z2", "facebook", "scheduled", _future(hours=0.05), "998", "")
    with pytest.raises(ValueError, match="more than a few minutes"):
        publish.replace(soon)


def test_an_instagram_story_borrows_the_reels_9x16_file_and_sends_no_caption(monkeypatch, tmp_path):
    """16 Nov, the owner: post the scheduled reels to Instagram as stories (24 hours), not as feed posts."""
    from studio import reels

    d = tmp_path / "instagram"
    d.mkdir()
    (d / "story.mp4").write_bytes(b"x")
    monkeypatch.setattr(reels, "_channel_info", lambda slug: [
        {"name": "instagram", "dir": str(d), "videos": [{"file": "story.mp4", "mb": 1.0}], "post": "caption"},
        {"name": "tiktok", "dir": str(d), "videos": [], "post": ""}])
    video, text = publish.file_for("st-a", "instagram-story")
    assert video == d / "story.mp4" and text == ""
    monkeypatch.setattr(reels, "_channel_info", lambda slug: [])
    with pytest.raises(ValueError):
        publish.file_for("st-a", "instagram-story")


def test_stories_follow_the_youtube_schedule_once_and_drop_when_it_moves(monkeypatch):
    class Story(Fake):
        pass

    on = {"connected": True}
    story = Story(can_schedule=False)
    story.status = lambda: {"connected": on["connected"], "account": "@x", "error": None if on["connected"] else "not linked"}
    monkeypatch.setattr(publish, "_registry", lambda: {"instagram-story": story})
    soon = (datetime.now(timezone.utc) + timedelta(days=2)).astimezone().isoformat(timespec="minutes")
    yt = posting.record("st-yt", "youtube", "scheduled", soon)
    past = posting.record("st-old", "youtube", "scheduled", (datetime.now(timezone.utc) - timedelta(hours=1)).astimezone().isoformat(timespec="minutes"))

    def mine():
        return [p for p in posting.posts() if p["network"] == "instagram-story" and p["slug"] in ("st-yt", "st-old")]

    on["connected"] = False
    assert publish.stories_from_schedule()["queued"] == 0 and not mine(), "nothing until Instagram is reachable"
    on["connected"] = True
    publish.stories_from_schedule()
    publish.stories_from_schedule()
    got = mine()
    assert [(p["slug"], p["at"], p["status"]) for p in got] == [("st-yt", soon, "queued")], "once, same time, never for a past booking"
    posting.settle(yt, "replaced", note="moved")
    out = publish.stories_from_schedule()
    assert out["dropped"] == 1 and not [p for p in mine() if p["status"] == "queued"]
    assert past


def test_a_story_beside_a_bare_youtube_time_is_kept_not_dropped_and_queued_again(monkeypatch):
    """BL-060: YouTube autumn-1108-3 is stored bare ("2026-11-27T18:00"); its story was stored with an offset, so the
    text never matched: every run took the story back and queued it again. Matched by the moment, it stays."""
    from studio.db import connect

    story = Fake(can_schedule=False)
    story.status = lambda: {"connected": True, "account": "@x", "error": None}
    monkeypatch.setattr(publish, "_registry", lambda: {"instagram-story": story})
    bare = (datetime.now() + timedelta(days=3)).replace(second=0, microsecond=0).isoformat(timespec="minutes")
    yt = posting.record("st-bare", "youtube", "scheduled", bare)
    with connect() as con:  # a row written before every writer kept the offset
        con.execute("UPDATE posts SET at = ? WHERE id = ?", (bare, yt))
    first = publish.stories_from_schedule()
    again = publish.stories_from_schedule()
    mine = [p for p in posting.posts() if p["network"] == "instagram-story" and p["slug"] == "st-bare"]
    assert first["queued"] == 1 and again["queued"] == 0 and again["dropped"] == 0
    assert len(mine) == 1 and posting.aware(mine[0]["at"]) == posting.aware(bare)


def test_replace_books_youtube_with_the_offset(net, monkeypatch):
    from studio import youtube

    got = []
    monkeypatch.setattr(youtube, "delete_video", lambda vid: None)
    monkeypatch.setattr(youtube, "upload", lambda slug, at=None, force=False: got.append(at) or {"id": "n", "url": "u"})
    at = _future()
    publish.replace(posting.record("pub-off", "youtube", "scheduled", at, "abcDEF12399", ""))
    assert got and datetime.fromisoformat(got[0]).tzinfo is not None
    assert datetime.fromisoformat(got[0]) == datetime.fromisoformat(at)


def test_unbook_takes_a_facebook_booking_back_and_keeps_the_row_as_dropped(net, monkeypatch):
    from studio.connectors import facebook

    gone = []
    monkeypatch.setattr(facebook, "delete", lambda rid: gone.append(rid))
    pid = posting.record("pub-unbook", "facebook", "scheduled", _future(), "1234567891", "https://facebook.com/reel/1")
    out = publish.unbook(pid)
    row = _row(pid)
    assert gone == ["1234567891"] and out["status"] == "dropped"
    assert row["status"] == "dropped" and row["remote_id"] == "1234567891" and "taken off Facebook" in row["note"]


def test_unbook_refused_by_facebook_leaves_the_booking_scheduled(net, monkeypatch):
    from studio.connectors import facebook

    def refuse(rid):
        raise RuntimeError("Facebook 400: nope")
    monkeypatch.setattr(facebook, "delete", refuse)
    pid = posting.record("pub-unbook2", "facebook", "scheduled", _future(), "1234567892", "")
    with pytest.raises(RuntimeError, match="nope"):
        publish.unbook(pid)
    assert _row(pid)["status"] == "scheduled"


def test_unbook_takes_only_a_facebook_booking_still_ahead(net, monkeypatch):
    from studio.connectors import facebook

    monkeypatch.setattr(facebook, "delete", lambda rid: pytest.fail("nothing is deleted"))
    yt = posting.record("pub-unbook3", "youtube", "scheduled", _future(), "abcDEF12346", "")
    soon = posting.record("pub-unbook4", "facebook", "scheduled", _future(hours=0.05), "1234567893", "")
    out = posting.record("pub-unbook5", "facebook", "posted", _future(hours=-2), "1234567894", "")
    with pytest.raises(ValueError, match="taken back on youtube itself"):
        publish.unbook(yt)
    for pid in (soon, out):
        with pytest.raises(ValueError, match="only a scheduled booking"):
            publish.unbook(pid)


def test_facebook_reels_are_held_by_the_studio_not_booked_on_facebook():
    # 24 Nov 2026: reels uploaded days ahead with scheduled_publish_time got 0 plays; the one published at once got
    # 102. Facebook must queue in the studio and go out at its time (publish.run_due), like Bluesky.
    from studio.connectors import facebook

    assert facebook.can_schedule is False


# ---------- BL-156: a send that failed on a passing error is tried again ----------

ABORTED = ("could not reach Facebook ([Errno 10053] An established connection was aborted by the software in your host "
           "machine); check the internet connection")


class Flaky(Fake):
    """Fails with the given reasons in turn, then posts."""

    def __init__(self, errors):
        super().__init__(can_schedule=False)
        self.errors = list(errors)

    def post(self, video, text, at=None):
        self.calls.append((video, text, at))
        if self.errors:
            raise RuntimeError(self.errors.pop(0))
        return {"url": "https://example.com/p/2", "remote_id": "r2", "scheduled": False}


def _due_now(slug, minutes_ago=1):
    """One queued post due now, the only one (earlier tests leave theirs in the shared catalog)."""
    from studio.db import connect
    with connect() as con:
        con.execute("UPDATE posts SET status = 'dropped' WHERE status = 'queued'")
    pid = posting.queue(slug, "bluesky", (datetime.now(timezone.utc) + timedelta(hours=2)).astimezone().isoformat(timespec="minutes"))
    with connect() as con:
        con.execute("UPDATE posts SET at = ? WHERE id = ?",
                    ((datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).astimezone().isoformat(timespec="minutes"), pid))
    return pid


def _mine(results, pid):
    return [r for r in results if r["id"] == pid]


def test_the_two_failures_of_25_and_26_nov_are_passing_and_a_refusal_is_not():
    assert publish.passing(ABORTED)
    assert publish.passing("Instagram 400 (the upload did not finish)")
    assert publish.passing("Instagram could not process the video (ERROR); check the file (9:16, under 60 s)")
    assert publish.passing("Instagram 503: Service temporarily unavailable")
    assert publish.passing("could not reach Bluesky (timed out); check the internet connection")
    for no in ("Facebook 400: (#200) The user hasn't authorized the application (the token lacks pages_manage_posts or you are not allowed to post on this Page)",
               "Facebook 400: Error validating access token (the token expired or was revoked; connect Facebook again with a new Page token)",
               "Instagram 400: (#10) Application does not have permission for this action (the upload did not finish)",
               "Facebook 400: (#4) Application request limit reached (Facebook's rate limit; try again later)",
               "the video v.mp4 is missing; render the reel first", "Bluesky is not connected", "rate limited"):
        assert not publish.passing(no), no


def test_a_passing_failure_is_tried_again_a_few_minutes_later_then_goes_out(net, monkeypatch):
    mod = net(Flaky([ABORTED]))
    pid = _due_now("retry-a")
    first = _mine(publish.run_due(), pid)
    assert first and first[0]["status"] == "retrying" and len(mod.calls) == 1
    row = _row(pid)
    assert row["status"] == "queued" and row["note"].startswith("retry 1/2 after ") and "Errno 10053" in row["note"]
    tries, after = posting.retry_of(row["note"])
    assert tries == 1 and timedelta(minutes=4) < after - datetime.now(timezone.utc) <= timedelta(minutes=5)
    assert not _mine(publish.run_due(), pid) and len(mod.calls) == 1, "not before its retry time"
    later = datetime.now(timezone.utc).astimezone() + timedelta(minutes=6)
    monkeypatch.setattr(publish, "_now", lambda: later)
    sent = _mine(publish.run_due(), pid)
    assert sent[0]["status"] == "posted" and len(mod.calls) == 2
    assert _row(pid)["status"] == "posted" and not _row(pid)["note"], "the retry note is gone once it went out"


def test_three_passing_failures_stay_failed_saying_how_many_tries(net, monkeypatch):
    mod = net(Flaky(["Instagram 400 (the upload did not finish)"] * 3))
    pid = _due_now("retry-b")
    clock = {"t": datetime.now(timezone.utc).astimezone()}
    monkeypatch.setattr(publish, "_now", lambda: clock["t"])
    statuses = []
    for _ in range(3):
        statuses.append(_mine(publish.run_due(), pid)[0]["status"])
        clock["t"] += timedelta(minutes=11)
    assert statuses == ["retrying", "retrying", "failed"] and len(mod.calls) == 3
    row = _row(pid)
    assert row["status"] == "failed" and row["note"].endswith("(tried 3 times)") and "upload did not finish" in row["note"]
    assert not _mine(publish.run_due(), pid), "a failed post is not sent again"


def test_a_refusal_is_never_tried_again(net):
    mod = net(Flaky(["Facebook 400: (#200) permission (the token lacks pages_manage_posts or you are not allowed to post on this Page)"]))
    pid = _due_now("retry-c")
    assert _mine(publish.run_due(), pid)[0]["status"] == "failed"
    assert _row(pid)["status"] == "failed" and not posting.retry_of(_row(pid)["note"]) and len(mod.calls) == 1


def test_no_retry_for_a_post_already_an_hour_late(net):
    net(Flaky([ABORTED]))
    pid = _due_now("retry-d", minutes_ago=70)
    assert _mine(publish.run_due(), pid)[0]["status"] == "failed"


def test_a_waiting_retry_is_not_marked_missed_by_the_catch_up(monkeypatch):
    """A Story that came due three hours ago while the studio was off is missed; one waiting for its retry is not."""
    from studio import live

    old = posting.queue("retry-e", "instagram-story", (datetime.now(timezone.utc) - timedelta(hours=3)).astimezone().isoformat(timespec="minutes"))
    wait = posting.queue("retry-f", "instagram-story", (datetime.now(timezone.utc) - timedelta(hours=3)).astimezone().isoformat(timespec="minutes"))
    posting.requeue(wait, 1, 2, datetime.now(timezone.utc).astimezone() + timedelta(minutes=5), ABORTED)
    out = live.catch_up()
    assert old in out["missed"] and wait in out["send"] and _row(wait)["status"] == "queued"
