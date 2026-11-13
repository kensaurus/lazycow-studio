"""Google Photos sign-in: a sign-in page opened earlier stays valid when a newer one is opened (2026-11-09: the
owner pressed Continue on the first page after the studio had opened a second, and the studio refused it)."""
import json
import time
import urllib.parse

import pytest

from studio import gphotos


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(gphotos, "SECRETS", tmp_path)
    monkeypatch.delenv("STUDIO_GPHOTOS_ACCOUNT", raising=False)
    monkeypatch.setattr(gphotos, "client", lambda: ("cid.apps.googleusercontent.com", "sec"))
    saved = {}
    monkeypatch.setattr(gphotos, "_save", lambda tok: saved.update(tok))
    calls = []

    def fake_call(method, url, data=None, headers=None):
        calls.append(urllib.parse.parse_qs(data.decode()))
        return 200, {}, json.dumps({"access_token": "a", "refresh_token": "r", "expires_in": 3600}).encode()
    monkeypatch.setattr(gphotos, "_call", fake_call)
    return tmp_path, saved, calls


def _state(url):
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["state"]


def test_an_earlier_sign_in_page_still_works_after_a_newer_one_opened(home):
    _, saved, calls = home
    first, second = gphotos.auth_url(), gphotos.auth_url()
    assert gphotos.exchange("code1", _state(first))["connected"] is True
    assert saved["refresh_token"] == "r"
    assert gphotos.exchange("code2", _state(second))["connected"] is True  # the newer one too
    assert len(calls) == 2 and calls[0]["code_verifier"] != calls[1]["code_verifier"]


def test_a_used_unknown_or_stale_state_is_refused(home):
    tmp, _, _ = home
    url = gphotos.auth_url()
    with pytest.raises(RuntimeError):
        gphotos.exchange("c", "not-a-state")
    gphotos.exchange("c", _state(url))
    with pytest.raises(RuntimeError):
        gphotos.exchange("c", _state(url))  # used once only
    url = gphotos.auth_url()
    pend = json.loads((tmp / "gphotos_pending.json").read_text(encoding="utf-8"))
    pend[-1]["at"] = time.time() - 3700
    (tmp / "gphotos_pending.json").write_text(json.dumps(pend), encoding="utf-8")
    with pytest.raises(RuntimeError):
        gphotos.exchange("c", _state(url))


def test_the_sign_in_shows_the_account_chooser(home):
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(gphotos.auth_url()).query))
    assert q["prompt"] == "select_account consent" and q["code_challenge_method"] == "S256"


def _id_token(email):
    import base64
    body = base64.urlsafe_b64encode(json.dumps({"email": email}).encode()).decode().rstrip("=")
    return f"h.{body}.s"


def test_only_the_owners_account_is_kept_when_one_is_set(home, monkeypatch):
    tmp, saved, _ = home
    monkeypatch.setenv("STUDIO_GPHOTOS_ACCOUNT", "owner@example.com")
    replies = iter([_id_token("someone@example.org"), _id_token("Owner@example.com")])
    monkeypatch.setattr(gphotos, "_call", lambda *a, **k: (200, {}, json.dumps(
        {"access_token": "a", "refresh_token": "r", "expires_in": 3600, "id_token": next(replies)}).encode()))
    url = gphotos.auth_url()
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
    assert q["login_hint"] == "owner@example.com" and "email" in q["scope"].split()
    with pytest.raises(RuntimeError, match="not owner@example.com"):
        gphotos.exchange("c", _state(url))
    assert not saved  # the wrong account's key is not stored
    assert gphotos.exchange("c", _state(gphotos.auth_url())) == {"connected": True, "account": "owner@example.com"}
    assert saved["account"] == "owner@example.com"
