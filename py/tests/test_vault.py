"""Login tokens: round-trip on this OS, owner-only files off Windows, the key-store marker path."""
import json
import os
import sys

from studio import youtube as yt


def test_token_round_trip_on_this_computer(tmp_path, monkeypatch):
    monkeypatch.setattr(yt, "SECRETS", tmp_path)
    monkeypatch.setattr(yt, "_vault_put", lambda name, data: False)  # no OS key store: the file path
    tok = {"refresh_token": "r-unit", "access_token": "a", "expires": 1}
    yt._save_token(tok)
    assert yt._load_token() == tok
    if sys.platform != "win32":
        assert oct(os.stat(tmp_path / "youtube_token.bin").st_mode & 0o777) == "0o600"


def test_key_store_marker_is_read_back(monkeypatch):
    store = {}
    monkeypatch.setattr(yt.sys, "platform", "linux")
    monkeypatch.setattr(yt, "_vault_put", lambda name, data: store.__setitem__(name, data) or True)
    monkeypatch.setattr(yt, "_vault_get", lambda name: store[name])
    raw = json.dumps({"refresh_token": "r"}).encode()
    blob = yt._protect(raw, "youtube_token")
    assert blob == b"vault:youtube_token" and b"r" not in blob.split(b":", 1)[1].replace(b"youtube_token", b"")
    assert yt._unprotect(blob) == raw
