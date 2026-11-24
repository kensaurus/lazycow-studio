"""Whose account each network posts to: the ranch's own accounts only in the ranch workspace."""
import json

from studio.config import ROOT, channel_who


def test_ranch_sees_its_own_accounts_and_others_see_neutral_labels():
    spec = {"who": "Your YouTube channel", "ranchWho": "Cafe Kumo channel"}
    assert channel_who(spec, ranch=True) == "Cafe Kumo channel"
    assert channel_who(spec, ranch=False) == "Your YouTube channel"
    assert channel_who({"who": "Article draft"}, ranch=True) == "Article draft"


def test_no_owner_account_in_a_neutral_label(ranch_words):
    chans = json.loads((ROOT / "shared" / "channels.json").read_text(encoding="utf-8"))["channels"]
    for c in chans:
        label = channel_who(c, ranch=False).lower()
        assert not any(w.lower() in label for w in ranch_words), (c["id"], label)
        assert "仙人" not in label and "kenji" not in label, (c["id"], label)
