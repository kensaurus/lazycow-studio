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
