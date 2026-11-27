"""Instagram reels through the Facebook connection (studio.connectors.instagram_reel) against a fake Graph API: the
reel goes up with its post text as the caption, as a trial reel for a small account (trial_params SS_PERFORMANCE) or
shared to the feed otherwise; without instagram_content_publish Instagram is not a studio network at all, so it stays
posted by hand; a used-up day is said before anything is uploaded. Nothing here reaches a network."""
import json
import urllib.parse

import pytest

from studio import publish
from studio.connectors import facebook
from studio.connectors import instagram_reel as igr

IG_ID, PAGE_ID, MEDIA_ID, CONTAINER = "17841400000000001", "100000000000001", "18000000000000009", "17900000000000002"
TOKEN = "EAAtesttoken"


class Fake:
    """Answers by (method, a piece of the URL); each route pops its next reply, the last one repeats."""

    def __init__(self, routes):
        self.routes = [(m, part, list(replies)) for m, part, replies in routes]
        self.calls = []

    def __call__(self, method, url, *, data=None, headers=None, timeout=120):
        self.calls.append({"method": method, "url": url, "data": data, "headers": {k.lower(): v for k, v in (headers or {}).items()}})
        for m, part, replies in self.routes:
            if m == method and part in url:
                status, body = replies.pop(0) if len(replies) > 1 else replies[0]
                return status, {}, json.dumps(body).encode()
        raise AssertionError(f"unexpected call {method} {url}")

    def form(self, part):
        c = next(c for c in self.calls if c["method"] == "POST" and part in c["url"])
        return dict(urllib.parse.parse_qsl(c["data"].decode()))


@pytest.fixture
def ig(monkeypatch, tmp_path):
    monkeypatch.setattr(facebook, "_load", lambda: {"page_id": PAGE_ID, "token": TOKEN, "account": "Test Page"})
    monkeypatch.setattr(facebook, "app", lambda: None)
    monkeypatch.setattr(igr, "_PERM", {})
    monkeypatch.setattr(igr, "POLL_S", 0)
    monkeypatch.setattr(igr, "trial_setting", lambda: None)
    video = tmp_path / "reel_instagram.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 64)

    def routes(followers=120, quota=(3, 100), extra=()):
        return Fake([*extra,
                     ("GET", f"/{PAGE_ID}?", [(200, {"instagram_business_account": {"id": IG_ID, "username": "test.shop", "followers_count": followers}})]),
                     ("GET", "content_publishing_limit", [(200, {"data": [{"quota_usage": quota[0], "config": {"quota_total": quota[1], "quota_duration": 86400}}]})]),
                     ("POST", f"/{IG_ID}/media_publish", [(200, {"id": MEDIA_ID})]),
                     ("POST", f"/{IG_ID}/media", [(200, {"id": CONTAINER, "uri": f"https://rupload.facebook.com/ig-api-upload/v27.0/{CONTAINER}"})]),
                     ("POST", "rupload.facebook.com", [(200, {"success": True})]),
                     ("GET", f"/{CONTAINER}?", [(200, {"status_code": "IN_PROGRESS"}), (200, {"status_code": "FINISHED"})]),
                     ("GET", f"/{MEDIA_ID}?", [(200, {"permalink": "https://www.instagram.com/reel/AbC123/"})])])
    return video, routes


def test_a_small_accounts_reel_goes_up_as_a_trial_reel_with_its_post_text(ig, monkeypatch):
    video, routes = ig
    fake = routes(followers=120)
    monkeypatch.setattr(facebook, "_call", fake)
    out = igr.post(video, "冬の朝。\n#camp #winter")
    assert out == {"url": "https://www.instagram.com/reel/AbC123/", "remote_id": MEDIA_ID, "scheduled": False, "trial": True}
    form = fake.form(f"/{IG_ID}/media")
    assert form["media_type"] == "REELS" and form["upload_type"] == "resumable"
    assert form["caption"] == "冬の朝。\n#camp #winter"
    assert json.loads(form["trial_params"]) == {"graduation_strategy": "SS_PERFORMANCE"}
    assert "share_to_feed" not in form, "a trial reel is for non-followers first: not pushed to the feed"
    up = next(c for c in fake.calls if "rupload" in c["url"])
    assert up["headers"]["authorization"] == f"OAuth {TOKEN}" and up["headers"]["file_size"] == str(video.stat().st_size)
    assert fake.form("media_publish") == {"creation_id": CONTAINER, "access_token": TOKEN}


def test_a_bigger_account_or_the_switch_off_shares_the_reel_to_the_feed(ig, monkeypatch):
    video, routes = ig
    fake = routes(followers=5400)
    monkeypatch.setattr(facebook, "_call", fake)
    assert igr.post(video, "text")["trial"] is False
    form = fake.form(f"/{IG_ID}/media")
    assert form["share_to_feed"] == "true" and "trial_params" not in form
    # The person's choice wins over the follower count, both ways.
    assert igr.trial_on(120, False) is False and igr.trial_on(5400, True) is True
    assert igr.trial_on(999, None) is True and igr.trial_on(1000, None) is False and igr.trial_on(None, None) is True


def test_the_trial_switch_is_read_from_the_projects_networks_file(monkeypatch, tmp_path):
    from studio import config

    monkeypatch.setattr(config, "DATA", tmp_path)
    assert igr.trial_setting() is None, "never chosen"
    (tmp_path / "networks.json").write_text(json.dumps({"on": ["instagram"], "igTrial": False}), encoding="utf-8")
    assert igr.trial_setting() is False
    (tmp_path / "networks.json").write_text(json.dumps({"igTrial": "yes"}), encoding="utf-8")
    assert igr.trial_setting() is None, "anything but true or false is not a choice"


def test_a_used_up_day_is_said_before_anything_is_uploaded(ig, monkeypatch):
    video, routes = ig
    fake = routes(quota=(100, 100))
    monkeypatch.setattr(facebook, "_call", fake)
    with pytest.raises(RuntimeError, match="limit of 100 API posts"):
        igr.post(video, "text")
    assert not [c for c in fake.calls if c["method"] == "POST"]
    assert not publish.passing(RuntimeError("Instagram's limit of 100 API posts in 24 hours is used (100)")), "never retried"


def test_an_upload_that_did_not_finish_says_so_and_is_worth_another_try(ig, monkeypatch):
    video, routes = ig
    fake = routes(extra=[("POST", "rupload.facebook.com", [(400, {})])])
    monkeypatch.setattr(facebook, "_call", fake)
    with pytest.raises(RuntimeError, match="the upload did not finish") as err:
        igr.post(video, "text")
    assert TOKEN not in str(err.value) and publish.passing(err.value)


def test_caption_keeps_30_hashtags_and_2200_characters():
    tags = " ".join(f"#t{i}" for i in range(35))
    out = igr.caption("hello " + tags)
    assert out.count("#") == 30 and "#t29" in out and "#t30" not in out
    long = igr.caption("word " * 600)
    assert len(long) <= 2200 and long.endswith("word")
    assert igr.caption("  line one  \nline two  ") == "line one\nline two"


def test_without_the_publish_permission_instagram_stays_by_hand(ig, monkeypatch):
    video, routes = ig
    monkeypatch.setattr(facebook, "app", lambda: ("1234", "s" * 32))
    fake = routes(extra=[("GET", "debug_token", [(200, {"data": {"is_valid": True, "scopes": ["pages_manage_posts", "instagram_basic"]}})])])
    monkeypatch.setattr(facebook, "_call", fake)
    st = igr.status()
    assert st["connected"] is False and "instagram_content_publish" in st["error"] and st["account"] == "@test.shop"

    class Page:
        NAME, HOW, FIELDS, LINKS, can_schedule = "Facebook", "", [], [], True

        @staticmethod
        def status():
            return {"connected": True, "account": "Test Page", "error": None}
    monkeypatch.setattr(publish, "_registry", lambda: {"facebook": Page, "instagram": igr})
    conns = publish.connections()
    assert "instagram" not in conns, "Instagram is not a studio network: the page keeps it as a by-hand reminder"
    assert "instagram_content_publish" in conns["facebook"]["igReels"]["error"]
    with pytest.raises(ValueError, match="not connected"):
        monkeypatch.setattr(publish, "review_status", lambda slug: "approved")
        monkeypatch.setattr(publish, "file_for", lambda slug, n: (video, "text"))
        publish.publish("ig-a", "instagram")


def test_with_the_permission_instagram_is_a_studio_network_that_the_studio_sends(ig, monkeypatch):
    video, routes = ig
    monkeypatch.setattr(facebook, "app", lambda: ("1234", "s" * 32))
    fake = routes(extra=[("GET", "debug_token", [(200, {"data": {"is_valid": True, "scopes": ["instagram_basic", "instagram_content_publish"]}})])])
    monkeypatch.setattr(facebook, "_call", fake)
    st = igr.status()
    assert st["connected"] is True and st["followers"] == 120 and st["trial"] is True and st["trialSet"] is None
    monkeypatch.setattr(publish, "_registry", lambda: {"instagram": igr})
    conns = publish.connections()
    assert conns["instagram"]["connected"] and conns["instagram"]["canSchedule"] is False
    # Asked once per ten minutes, not every time the Accounts page is drawn.
    igr.status()
    assert len([c for c in fake.calls if "debug_token" in c["url"]]) == 1


def test_no_app_saved_asks_the_publishing_limit_whether_it_may_publish(ig, monkeypatch):
    video, routes = ig
    refused = {"error": {"code": 10, "message": "(#10) Application does not have permission for this action"}}
    monkeypatch.setattr(facebook, "_call", routes(extra=[("GET", "content_publishing_limit", [(400, refused)])]))
    assert "instagram_content_publish" in igr.status()["error"]
    monkeypatch.setattr(igr, "_PERM", {})
    monkeypatch.setattr(facebook, "_call", routes())
    assert igr.status()["connected"] is True


def test_the_reel_takes_the_instagram_9x16_cut_and_its_post_text(monkeypatch, tmp_path):
    from studio import reels

    d = tmp_path / "instagram"
    d.mkdir()
    (d / "reel_instagram.mp4").write_bytes(b"x")
    monkeypatch.setattr(reels, "_channel_info", lambda slug: [
        {"name": "instagram", "dir": str(d), "videos": [{"file": "reel_instagram.mp4", "mb": 4.0}], "post": "caption here\n#tag"},
        {"name": "instagram-story", "dir": str(d), "videos": [], "post": ""}])
    video, text = publish.file_for("ig-b", "instagram")
    assert video == d / "reel_instagram.mp4" and text == "caption here\n#tag"
