"""Networks for a general audience (BL-116): every network has a tier, a project that never chose its networks starts
with the six common ones on, the ranch workspace keeps its own list, and the owner-only networks (his site and article
drafts) may be missing from the list without anything breaking."""
import json

import pytest

from studio import config, reels

OWNER_ONLY = ("kensaurus", "zenn", "note")


def _spec(public: bool = False) -> dict:
    """The shared channel list: the owner's (shared/channels.json) or the public copy (examples/public/..., which a
    public clone already has as shared/channels.json)."""
    pub = config.ROOT / "examples" / "public" / "shared" / "channels.json"
    path = pub if public and pub.is_file() else config.ROOT / "shared" / "channels.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _on(spec: dict) -> list[str]:
    return sorted(c["id"] for c in spec["channels"] if not c.get("off"))


def test_every_network_has_a_tier_and_the_six_most_used_are_common():
    for public in (False, True):
        chans = _spec(public)["channels"]
        assert all(c.get("tier") in ("common", "more") for c in chans), [c["id"] for c in chans if c.get("tier") not in ("common", "more")]
        assert sorted(c["id"] for c in chans if c["tier"] == "common") == sorted(reels.COMMON_NETWORKS)


def test_a_channel_without_a_tier_is_common_only_if_it_is_one_of_the_six():
    assert reels.tier_of({"id": "tiktok"}) == "common" and reels.tier_of({"id": "bluesky"}) == "more"
    assert reels.tier_of({"id": "bluesky", "tier": "common"}) == "common" and reels.tier_of({"id": "x", "tier": "odd"}) == "common"


def test_a_project_that_never_chose_starts_with_the_six_common_networks(tmp_path, monkeypatch):
    monkeypatch.setattr(reels, "DATA", tmp_path)  # no networks.json here
    monkeypatch.setattr(reels, "RANCH", False)
    monkeypatch.setattr(config, "PROJECTS", tmp_path / "projects")  # and no reel made yet
    for public in (False, True):
        assert _on(reels._own_networks(_spec(public))) == sorted(reels.COMMON_NETWORKS)


def test_a_project_that_made_reels_before_the_upgrade_keeps_every_network_it_had(tmp_path, monkeypatch):
    monkeypatch.setattr(reels, "DATA", tmp_path)  # never chose: no networks.json
    monkeypatch.setattr(reels, "RANCH", False)
    (tmp_path / "projects").mkdir()
    (tmp_path / "projects" / "first-reel.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config, "PROJECTS", tmp_path / "projects")
    spec = _spec(True)
    assert _on(reels._own_networks(_spec(True))) == _on(spec), "the old rule: every channel not marked off stays on"


@pytest.mark.parametrize("made", ["photo post", "long-video plan", "booked post", "nothing"])
def test_photo_posts_long_videos_or_posts_also_keep_the_old_networks(tmp_path, monkeypatch, made):
    """Not only reels: a 0.26 project with only photo posts, only a long-video plan or only booked posts never chose its
    networks either, and an upgrade must not switch any of them off (judge, 24 Nov)."""
    import sqlite3

    monkeypatch.setattr(reels, "DATA", tmp_path)
    monkeypatch.setattr(reels, "RANCH", False)
    monkeypatch.setattr(config, "PROJECTS", tmp_path / "projects")  # no reel
    if made == "photo post":
        (tmp_path / "stills" / "cafe-kumo-autumn").mkdir(parents=True)
        (tmp_path / "stills" / "_pub").mkdir()
    elif made == "long-video plan":
        (tmp_path / "vlog-plan.json").write_text('{"videos": []}', encoding="utf-8")
    elif made == "booked post":
        (tmp_path / "catalog").mkdir()
        con = sqlite3.connect(tmp_path / "catalog" / "catalog.sqlite")
        con.execute("CREATE TABLE posts (id INTEGER PRIMARY KEY, slug TEXT, network TEXT, status TEXT)")
        con.execute("INSERT INTO posts (slug, network, status) VALUES ('a-reel', 'bluesky', 'scheduled')")
        con.commit()
        con.close()
    else:
        (tmp_path / "stills" / "_pub").mkdir(parents=True)  # only the working folder: nothing made
    want = sorted(reels.COMMON_NETWORKS) if made == "nothing" else _on(_spec(True))
    assert _on(reels._own_networks(_spec(True))) == want


def test_a_projects_own_choice_still_wins_over_the_tiers(tmp_path, monkeypatch):
    monkeypatch.setattr(reels, "DATA", tmp_path)
    monkeypatch.setattr(reels, "RANCH", False)
    (tmp_path / "networks.json").write_text(json.dumps({"on": ["bluesky"], "off": ["tiktok"], "accounts": {"x": "@cafe.kumo"}}),
                                             encoding="utf-8")
    by = {c["id"]: c for c in reels._own_networks(_spec(True))["channels"]}
    assert not by["bluesky"].get("off") and by["tiktok"].get("off") and by["x"]["account"] == "@cafe.kumo"


def test_the_ranch_keeps_its_shared_list_as_it_is(tmp_path, monkeypatch):
    monkeypatch.setattr(reels, "DATA", tmp_path)
    monkeypatch.setattr(reels, "RANCH", True)
    assert reels._own_networks(_spec()) == _spec()  # nothing switched on or off by the tiers


def test_the_public_list_has_no_owner_only_network_and_nothing_needs_one(tmp_path, monkeypatch):
    public = _spec(True)
    ids = [c["id"] for c in public["channels"]]
    if config.ROOT.joinpath("examples", "public", "shared", "channels.json").is_file():
        assert not set(OWNER_ONLY) & set(ids)
    monkeypatch.setattr(reels, "DATA", tmp_path)
    monkeypatch.setattr(reels, "RANCH", False)
    chans = {c["id"]: c for c in reels._own_networks(public)["channels"]}
    monkeypatch.setattr(reels, "CHANNEL_SPEC", {**public, "channels": list(chans.values())})
    monkeypatch.setattr(reels, "CHANNELS", chans)
    monkeypatch.setattr(reels, "DRAFTS", tmp_path / "drafts")
    reel = {"slug": "lunch-1124", "title_ja": "静かだからこそ、よく話せる。", "yt_title": "静かだからこそ、よく話せる。｜Cafe Kumo",
            "tags": ["#cafekumo", "#lunch"], "posts": {"ja": "静かだからこそ、よく話せる。", "en": "Quiet, so you can talk.", "zh": "安静"},
            "beats": []}
    for cid, spec in chans.items():
        assert reels._post_text(reel, cid).strip(), cid
        assert config.channel_who(spec, ranch=False), cid
    assert reels._channel_info("lunch-1124") == []  # no folders yet: an empty list, never a KeyError on a missing network


@pytest.mark.ranch
def test_the_ranch_still_has_its_owner_only_networks():
    assert set(OWNER_ONLY) <= {c["id"] for c in _spec()["channels"]}
