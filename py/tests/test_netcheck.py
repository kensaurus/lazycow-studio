"""Check every connection (studio.netcheck): which networks are in use, the latest failed post unless a later one went
out, Facebook permissions from debug_token turned into fixes, YouTube scopes from tokeninfo, Bluesky's sign-in end date,
Chrome-posted networks, and that one network's crash never hides the others. No network: every call is faked."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from studio import netcheck as nc

NOW = datetime(2026, 11, 18, 20, 0, tzinfo=timezone(timedelta(hours=9)))
SECRET_TOKEN = "EAAB" + "z" * 40


def at(hours: float) -> str:
    return (NOW + timedelta(hours=hours)).isoformat(timespec="minutes")


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch):
    monkeypatch.setattr(nc, "_now", lambda: NOW)


def test_networks_in_use_and_the_latest_failure_unless_a_later_post_went_out():
    posts = [{"network": "bluesky", "status": "failed", "at": at(-1), "note": "Bluesky 401 (verify the account email)"},
             {"network": "x", "status": "failed", "at": at(-50)}, {"network": "x", "status": "posted", "at": at(-24)},
             {"network": "tiktok", "status": "scheduled", "at": at(20)},
             {"network": "pinterest", "status": "posted", "at": at(-24 * 45)},  # too old to count as in use
             {"network": "all", "status": "planned", "at": at(5)}]
    assert nc._in_use(posts, NOW) == {"bluesky", "x", "tiktok"}
    assert nc.last_failure(posts, "bluesky", NOW)["note"].startswith("Bluesky 401")
    assert nc.last_failure(posts, "x", NOW) is None, "a later post went out"
    old = [{"network": "x", "status": "failed", "at": at(-24 * 20)}]
    assert nc.last_failure(old, "x", NOW) is None, "older than 14 days"
    rebooked = [{"network": "bluesky", "slug": "focus", "status": "failed", "at": at(-1)},
                {"network": "bluesky", "slug": "focus", "status": "queued", "at": at(24 * 25)}]
    assert nc.last_failure(rebooked, "bluesky", NOW) is None, "booked again: handled"
    assert nc.last_failure(rebooked[:1] + [{**rebooked[1], "slug": "other"}], "bluesky", NOW) is not None, "another reel does not count"


def test_check_lists_each_network_with_its_fix_and_survives_one_crash(monkeypatch):
    monkeypatch.setattr(nc, "_bsky_checks", lambda: ([nc._check("signin", True, "Signed in as @shop.")], "@shop"))
    monkeypatch.setattr(nc, "_yt_checks", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    posts = [{"network": "bluesky", "status": "failed", "at": at(-1), "note": "Bluesky 401"},
             {"network": "youtube", "status": "scheduled", "at": at(3)}, {"network": "tiktok", "status": "scheduled", "at": at(3)}]
    out = nc.check({"chrome": False}, posts=posts)
    by = {n["network"]: n for n in out["networks"]}
    assert by["bluesky"]["state"] == "bad" and by["bluesky"]["checks"][-1]["id"] == "lastpost"
    assert by["youtube"]["state"] == "warn" and "could not finish" in by["youtube"]["checks"][0]["say"]
    assert by["tiktok"]["via"] == "chrome" and by["tiktok"]["state"] == "bad" and "not linked" in by["tiktok"]["checks"][0]["say"]
    assert [n["network"] for n in out["networks"]][:2] == ["bluesky", "youtube"], "the studio's own networks first"
    assert out["counts"] == {"ok": 0, "warn": 1, "bad": 2}
    unknown = nc.check({"chrome": None}, posts=[{"network": "x", "status": "scheduled", "at": at(3)}])
    assert unknown["networks"][0]["checks"] == [] and unknown["networks"][0]["state"] == "ok", "no Chrome news: no claim either way"


def test_facebook_permissions_come_from_debug_token_and_never_leak_the_token(monkeypatch):
    from studio.connectors import facebook as fb

    monkeypatch.setattr(fb, "status", lambda: {"connected": True, "account": "Shop Page", "error": None})
    monkeypatch.setattr(fb, "app", lambda: ("1234567890123456", "s" * 32))
    monkeypatch.setattr(fb, "_load", lambda: {"token": SECRET_TOKEN, "page_id": "1"})
    seen = {}

    def fake_get(path, token, **params):
        seen.update(path=path, token=token, **params)
        granted = [p for p in nc.FB_PERMS if p not in ("instagram_manage_insights", "pages_manage_posts")]
        return 200, {"data": {"is_valid": True, "expires_at": 0, "scopes": granted}}, b""

    monkeypatch.setattr(fb, "_get", fake_get)
    checks, account = nc._fb_checks()
    assert seen["path"] == "debug_token" and seen["token"] == "1234567890123456|" + "s" * 32 and seen["input_token"] == SECRET_TOKEN
    bad = {c["id"]: c for c in checks if c["ok"] is not True}
    assert bad["perm-pages_manage_posts"]["ok"] is False, "posting needs it"
    assert bad["perm-instagram_manage_insights"]["ok"] is None, "a feature, not posting"
    assert "developers.facebook.com/apps/1234567890123456/use_cases" in bad["perm-instagram_manage_insights"]["url"]
    assert "Connect again" in bad["perm-instagram_manage_insights"]["fix"]
    assert SECRET_TOKEN not in json.dumps(checks) and account == "Shop Page"


def test_youtube_scopes_from_tokeninfo_and_a_dead_sign_in(monkeypatch):
    from studio import youtube as y

    monkeypatch.setattr(y, "status", lambda: {"app": True})
    monkeypatch.setattr(y, "accounts", lambda: [{"id": "main", "channel": "Shop", "email": "a@b.c"}, {"id": "a2", "channel": "Vlog"}])

    def access_token():
        if y.ACCOUNT == "a2":
            raise RuntimeError("invalid_grant (the sign-in expired after about a week: your Google app is probably still in Testing)")
        return "ya29.secret"

    monkeypatch.setattr(y, "access_token", access_token)
    scopes = " ".join(s for s in nc.YT_SCOPES if not s.endswith("yt-analytics.readonly"))
    monkeypatch.setattr(y, "_call", lambda m, url, **kw: (200, {}, json.dumps({"scope": scopes}).encode()))
    checks, account = nc._yt_checks()
    by = {c["id"]: c for c in checks}
    assert by["signin-main"]["ok"] is True and by["scope-main-yt-analytics.readonly"]["ok"] is None
    assert by["signin-a2"]["ok"] is False and "Testing" in by["signin-a2"]["say"] and "audience" in by["signin-a2"]["url"]
    assert account == "Shop" and y.ACCOUNT == "main", "the account in use is put back"


def test_bluesky_says_an_unverified_email_blocks_videos(monkeypatch):
    """18 Nov: getUploadLimits answered 401 {canUpload: false, error: unconfirmed_email}; the post had failed with a bare 401."""
    from studio.connectors import bluesky as bs

    monkeypatch.setattr(bs, "account", lambda: ("did:plc:x", "https://pds.example", "shop", lambda m, url, **kw: (200, {}, b'{"handle": "shop"}')))
    monkeypatch.setattr(bs, "_service_token", lambda *a: "svc")
    monkeypatch.setattr(bs, "_http", lambda m, url, **kw: (401, {}, json.dumps({"canUpload": False, "error": "unconfirmed_email",
                                                                                  "message": "Confirm your email address to upload videos"}).encode()))
    checks = nc._bsky_video_checks(bs)
    assert [c["id"] for c in checks] == ["email"] and checks[0]["ok"] is False and "verify" in checks[0]["fix"]
    monkeypatch.setattr(bs, "_http", lambda m, url, **kw: (200, {}, json.dumps({"canUpload": True, "remainingDailyVideos": 24}).encode()))
    assert nc._bsky_video_checks(bs)[0]["say"].endswith("(24 left today).")


def test_bluesky_warns_before_a_browser_sign_in_ends(monkeypatch):
    from studio.connectors import bluesky as bs

    monkeypatch.setattr(nc, "_bsky_video_checks", lambda bs: [])
    monkeypatch.setattr(bs, "status", lambda: {"connected": True, "account": "@shop", "via": "signin", "until": at(24 * 5)})
    checks, _ = nc._bsky_checks()
    assert checks[1]["id"] == "expires" and checks[1]["ok"] is None and "app password" in checks[1]["fix"]
    monkeypatch.setattr(bs, "status", lambda: {"connected": True, "account": "@shop", "via": "app password"})
    assert [c["id"] for c in nc._bsky_checks()[0]] == ["signin"], "an app password never signs out"
