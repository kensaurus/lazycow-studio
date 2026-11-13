"""Choosing the Google account and bringing your own Google app: the sign-in always shows Google's account
chooser, returns to the studio's own port (a Desktop client accepts any loopback port), the app file is
checked and stored without its secret ever being shown, and the connected account is known by its email."""
import base64
import json
import urllib.parse

import pytest

from studio import youtube

DESKTOP = {"installed": {"client_id": "123456-abc.apps.googleusercontent.com", "client_secret": "s3cret", "project_id": "tsumagoi-growth",
                         "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token",
                         "redirect_uris": ["http://localhost"]}}


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(youtube, "SECRETS", tmp_path)
    monkeypatch.setattr(youtube, "ROOT", tmp_path / "none")
    monkeypatch.setattr(youtube, "HOME_APP", tmp_path / "home" / "youtube_client.json")  # never the real shared app
    monkeypatch.delenv("STUDIO_YT_CLIENT_ID", raising=False)
    monkeypatch.delenv("STUDIO_YT_CLIENT_SECRET", raising=False)
    monkeypatch.setattr(youtube, "_write_secret", lambda p, data: (p.parent.mkdir(parents=True, exist_ok=True), p.write_bytes(data)))
    return tmp_path


def test_the_sign_in_shows_the_account_chooser_and_returns_to_the_studios_port(home):
    youtube.set_app(json.dumps(DESKTOP))
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(youtube.auth_url(4399, "owner@example.com")).query))
    assert q["prompt"] == "select_account consent"
    assert q["login_hint"] == "owner@example.com"
    assert q["redirect_uri"] == "http://127.0.0.1:4399/oauth/youtube"
    assert q["code_challenge_method"] == "S256" and q["access_type"] == "offline"
    assert "email" in q["scope"].split() and "openid" in q["scope"].split()
    pending = json.loads((home / "youtube_pending.json").read_text(encoding="utf-8"))
    assert pending["redirect"] == "http://127.0.0.1:4399/oauth/youtube"  # the code is exchanged with the same address


def test_a_bad_hint_is_ignored_and_the_default_port_is_4317(home):
    youtube.set_app(json.dumps(DESKTOP))
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(youtube.auth_url(None, "not an email")).query))
    assert "login_hint" not in q and q["redirect_uri"] == "http://127.0.0.1:4317/oauth/youtube"
    with pytest.raises(ValueError):
        youtube.redirect_uri("43;17")


def test_the_app_file_is_checked_and_its_secret_is_never_reported(home):
    with pytest.raises(ValueError, match="not the file"):
        youtube.set_app("hello")
    with pytest.raises(ValueError, match="Web type"):
        youtube.set_app(json.dumps({"web": DESKTOP["installed"]}))
    with pytest.raises(ValueError, match="client ID or secret"):
        youtube.set_app(json.dumps({"installed": {"client_id": "x", "client_secret": ""}}))
    info = youtube.set_app(json.dumps(DESKTOP))
    assert info == {"set": True, "source": "file", "type": "desktop", "project": "tsumagoi-growth", "projectNumber": "123456", "shared": False}
    assert "s3cret" not in json.dumps(info) and "s3cret" not in json.dumps(youtube.status())
    assert youtube.client() == ("123456-abc.apps.googleusercontent.com", "s3cret")


def test_a_new_app_drops_the_old_sign_in_and_forget_removes_both(home, monkeypatch):
    calls = []
    monkeypatch.setattr(youtube, "_call", lambda *a, **k: calls.append(a[1]) or (200, {}, b"{}"))
    youtube.set_app(json.dumps(DESKTOP))
    youtube._token_path().write_bytes(b"x")
    youtube.set_app(json.dumps(DESKTOP))
    assert not youtube._token_path().exists()
    youtube.forget_app()
    assert youtube.app_info() == {"set": False} and youtube.client() is None


def test_a_channel_that_is_not_the_projects_is_refused(monkeypatch):
    monkeypatch.setenv("STUDIO_YT_CHANNEL", "@tsumagoicamp")
    mine = {"id": "UCabc", "title": "A personal channel", "handle": "@example_owner"}
    assert "this project posts to @tsumagoicamp" in youtube.channel_mismatch(mine)
    assert youtube.channel_mismatch({"id": "UCxyz", "title": "Tsumagoi Work&Camp", "handle": "@tsumagoicamp"}) is None
    monkeypatch.setenv("STUDIO_YT_CHANNEL", "UCxyz")
    assert youtube.channel_mismatch({"id": "UCxyz", "title": "T", "handle": ""}) is None
    monkeypatch.delenv("STUDIO_YT_CHANNEL")
    assert youtube.channel_mismatch(mine) is None  # no expectation set: any channel


def test_the_connected_account_is_read_from_the_id_token():
    payload = base64.urlsafe_b64encode(json.dumps({"email": "owner@example.com"}).encode()).rstrip(b"=").decode()
    assert youtube._email_from(f"h.{payload}.s") == "owner@example.com"
    assert youtube._email_from(None) is None and youtube._email_from("garbage") is None


def test_a_return_with_the_wrong_state_does_not_cancel_the_sign_in_in_progress(home, monkeypatch):
    """A stray or forged /oauth/youtube?state=... (another site can navigate there) is refused and leaves the owner's
    pending sign-in in place; nothing is sent to Google."""
    youtube.set_app(json.dumps(DESKTOP))
    youtube.auth_url(4317)
    pending = home / "youtube_pending.json"
    good = json.loads(pending.read_text(encoding="utf-8"))["state"]
    monkeypatch.setattr(youtube, "_call", lambda *a, **k: pytest.fail("no token request on a wrong state"))
    with pytest.raises(RuntimeError, match="state did not match"):
        youtube.exchange("code-from-elsewhere", "not-" + good)
    assert pending.exists() and json.loads(pending.read_text(encoding="utf-8"))["state"] == good
