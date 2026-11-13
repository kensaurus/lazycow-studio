"""A project can connect several YouTube accounts (studio.youtube use/accounts), and long videos upload to the one chosen."""
import json

import pytest

from studio import youtube


@pytest.fixture
def secrets(monkeypatch, tmp_path):
    monkeypatch.setattr(youtube, "SECRETS", tmp_path)
    monkeypatch.setattr(youtube, "ACCOUNT", "main")
    monkeypatch.setattr(youtube, "_protect", lambda data, name="": data)
    monkeypatch.setattr(youtube, "_unprotect", lambda data: data)
    return tmp_path


def test_each_account_has_its_own_token_and_main_stays_the_old_file(secrets):
    assert youtube._token_path().name == "youtube_token.bin"  # the one connected before accounts existed keeps working
    youtube.use("a2")
    assert youtube._token_path().name == "youtube_token-a2.bin"
    with pytest.raises(RuntimeError):
        youtube.use("../main")


def test_a_new_account_is_main_first_then_a2_a3(secrets):
    assert youtube._next_account() == "main"
    (secrets / "youtube_token.bin").write_text("{}")
    assert youtube._next_account() == "a2"
    (secrets / "youtube_token-a2.bin").write_text("{}")
    assert youtube._next_account() == "a3"


def test_accounts_lists_every_channel_main_first_and_leaves_the_account_in_use_alone(secrets):
    (secrets / "youtube_token.bin").write_text(json.dumps({"account": "ranch@example.com", "channel": {"id": "UC1", "title": "Ranch"}}))
    (secrets / "youtube_token-a10.bin").write_text(json.dumps({"account": "me@example.com", "channel": {"id": "UC10", "title": "Me"}}))
    (secrets / "youtube_token-a2.bin").write_text(json.dumps({"account": "two@example.com", "channel": {"id": "UC2", "title": "Two"}}))
    youtube.use("a2")
    got = youtube.accounts()
    assert [a["id"] for a in got] == ["main", "a2", "a10"]
    assert got[0]["shorts"] and not got[1]["shorts"] and got[2]["channel"] == "Me"
    assert youtube.ACCOUNT == "a2"


def test_the_sign_in_remembers_which_account_it_is_for(secrets, monkeypatch):
    monkeypatch.setattr(youtube, "client", lambda: ("id", "secret"))
    (secrets / "youtube_token.bin").write_text("{}")
    url = youtube.auth_url(4317, account="new")
    assert "accounts.google.com" in url
    assert json.loads((secrets / "youtube_pending.json").read_text())["account"] == "a2"


def test_a_part_not_built_is_not_uploaded(secrets, monkeypatch, tmp_path):
    monkeypatch.setattr(youtube, "DATA", tmp_path)
    with pytest.raises(RuntimeError, match="not built"):
        youtube.upload_vlog(3, privacy="unlisted")
    with pytest.raises(RuntimeError, match="privacy"):
        youtube.upload_vlog(3, privacy="friends")
