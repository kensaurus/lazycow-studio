"""The owner's Meta app still in Development mode (27 Nov 2026: every reel from 18 Nov on read 0 plays from such an
app). The Graph API has no mode field; an app with no privacy policy URL cannot have been published."""
from __future__ import annotations

from studio.connectors import facebook as fb


def _fake(monkeypatch, reply, calls):
    monkeypatch.setattr(fb, "app", lambda: ("1234567890123456", "0" * 32))
    monkeypatch.setattr(fb, "_MODE", {})

    def get(path, token, **params):
        calls.append((path, params))
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(fb, "_get", get)


def test_an_app_without_a_privacy_policy_is_in_development(monkeypatch):
    calls: list = []
    _fake(monkeypatch, (200, {"name": "Cafe Kumo app", "id": "1234567890123456"}, b""), calls)
    m = fb.app_mode(now=0.0)
    assert m == {"app": "1234567890123456", "name": "Cafe Kumo app", "mode": "development",
                 "publish": "https://developers.facebook.com/apps/1234567890123456/go_live/"}
    assert calls == [("1234567890123456", {"fields": "name,privacy_policy_url"})]
    assert fb.app_mode(now=60.0) == m and len(calls) == 1, "asked at most every six hours"
    fb.app_mode(now=fb._MODE_FOR + 1)
    assert len(calls) == 2


def test_an_app_with_a_privacy_policy_is_unknown_and_offline_says_nothing(monkeypatch):
    calls: list = []
    _fake(monkeypatch, (200, {"name": "A", "privacy_policy_url": "https://example.com/privacy"}, b""), calls)
    assert fb.app_mode(now=0.0)["mode"] == "unknown"
    _fake(monkeypatch, OSError("offline"), calls)
    assert fb.app_mode(now=0.0) is None
    _fake(monkeypatch, (400, {"error": {"code": 190}}, b""), calls)
    assert fb.app_mode(now=0.0) is None
    monkeypatch.setattr(fb, "app", lambda: None)
    assert fb.app_mode(now=0.0) is None, "a pasted token with no saved app: nothing to ask"


def test_status_carries_the_app_mode_and_a_live_app_is_told_to_paste_a_token(monkeypatch):
    monkeypatch.setattr(fb, "_load", lambda: {"token": "t", "account": "Cafe Kumo", "page_id": "1"})
    monkeypatch.setattr(fb, "_token_problem", lambda token: None)
    monkeypatch.setattr(fb, "app_mode", lambda: {"app": "9", "name": "A", "mode": "development", "publish": "u"})
    assert fb.status()["appMode"]["mode"] == "development" and fb.status()["connected"]
    monkeypatch.setattr(fb, "app_mode", lambda: None)
    assert "appMode" not in fb.status()
    msg = fb._login_error(400, b'{"error":{"message":"URL blocked","code":191}}', 4317)
    assert "Graph API Explorer" in msg and "Development mode" in msg
