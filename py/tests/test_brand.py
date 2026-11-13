"""A project made in the studio is any brand: its own place, themes, words, name and links, nothing of the ranch's.
The Tsumagoi workspace (the main project, config.RANCH) keeps every ranch value exactly as before."""
import json
import os
import random
import subprocess
import sys
from pathlib import Path

import pytest

import studio.ai as ai
import studio.assemble as assemble
import studio.brand as brand
import studio.reels as reels
import studio.wording as wording
from studio.config import SPEC
from studio.guard import problems
from studio.library import place_from
from studio.media import near_ranch

RANCH_STRINGS = ("嬬恋", "tsumagoi", "Tsumagoi", "牧場", "kensaur", "¥", "#キャンプ")
CHANNELS = ("instagram", "tiktok", "threads", "line-voom", "line-oa", "pinterest", "bluesky", "gbp", "x", "facebook",
            "youtube-shorts", "linkedin", "xiaohongshu")


def _reload_themes():
    assemble._THEMES_SEEN[0] = object()
    assemble.load_themes()


@pytest.fixture
def neutral(tmp_path, monkeypatch):
    """The open project is one made in the studio ("Cafe Kumo"), with its data folder in tmp_path."""
    import studio.config as config

    for mod in (brand, assemble, reels, wording, ai, config):
        monkeypatch.setattr(mod, "RANCH", False)
    monkeypatch.setattr(brand, "DATA", tmp_path)
    monkeypatch.setattr(brand, "BRAND_FILE", tmp_path / "brand.json")
    monkeypatch.setattr(assemble, "THEME_FILE", tmp_path / "themes.json")
    (tmp_path / "profiles.json").write_text(json.dumps({"displayName": "Cafe Kumo", "handle": "", "networks": {}}), encoding="utf-8")
    _reload_themes()
    yield tmp_path
    monkeypatch.undo()
    _reload_themes()


LUNCH = {"hook": {"ja": "雲の上で、\nランチを。", "en": "Lunch above the clouds."},
         "lines": [{"ja": "席は12だけ。", "en": "Only twelve seats."}, {"ja": "パンは毎朝焼きます。", "en": "Bread baked every morning."}],
         "shots": ["a cafe table by a window", "bread on a wooden board", "a cup of coffee", "a view of clouds", "a chef cooking"],
         "tags": ["#lunch"]}


# ---------- which checkout is the ranch ----------

def test_a_clone_without_the_ranch_overlay_is_neutral_and_keeps_its_reels_in_its_data(tmp_path, monkeypatch):
    import studio.config as config

    monkeypatch.delenv("STUDIO_RANCH", raising=False)
    assert config.ranch_overlay(tmp_path) is False  # no shared/reels.json: a public clone
    assert config.is_ranch(tmp_path / "projects", tmp_path) is False
    (tmp_path / "shared").mkdir()
    (tmp_path / "shared" / "reels.json").write_text("[]", encoding="utf-8")
    assert config.ranch_overlay(tmp_path) is True
    assert config.is_ranch(tmp_path / "projects", tmp_path) is True
    assert config.is_ranch(tmp_path / "data" / "projects", tmp_path) is False  # another project of the same checkout
    assert config.ranch_overlay(tmp_path, "0") is False and config.ranch_overlay(tmp_path / "x", "1") is True
    assert config.ranch_overlay(tmp_path, "") is True  # unset: the marker decides


def test_a_neutral_process_keeps_everything_in_its_data_folder(tmp_path):
    """What a public clone does at start: no ranch, reels, plan and word bank all in its data folder."""
    env = {k: v for k, v in os.environ.items() if k not in ("STUDIO_PROJECTS", "STUDIO_WORDS", "STUDIO_READY")}
    env.update({"STUDIO_RANCH": "0", "STUDIO_DATA": str(tmp_path)})
    code = ("import json; from studio import brand, config, wording; "
            "print(json.dumps([config.RANCH, brand.RANCH, str(config.PROJECTS), str(config.PLAN), str(config.READY), str(wording.WORDS)]))")
    out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    ranch, brand_ranch, projects, plan, ready, words = json.loads(out.stdout.strip().splitlines()[-1])
    assert ranch is False and brand_ranch is False
    from studio.config import ROOT, _parse_env

    pinned = _parse_env(ROOT / ".env").keys() | _parse_env(ROOT / ".env.local").keys()  # a machine's own .env wins
    want = {"STUDIO_PROJECTS": (projects, tmp_path / "projects"), "STUDIO_PLAN": (plan, tmp_path / "reels.json"),
            "STUDIO_READY": (ready, tmp_path / "ready"), "STUDIO_WORDS": (words, tmp_path / "words.json")}
    for key, (got, expected) in want.items():
        if key not in pinned:
            assert Path(got) == expected, key


@pytest.mark.ranch
def test_this_checkout_with_the_overlay_is_still_the_ranch():
    import studio.config as config

    assert config.RANCH_MARKER.is_file() and config.OVERLAY
    assert config.RANCH and config.PROJECTS.resolve() == (config.ROOT / "projects").resolve()
    assert config.PLAN == config.ROOT / "shared" / "reels.json" and wording.WORDS == config.ROOT / "shared" / "words.json"


# ---------- the ranch stays the ranch ----------

def test_the_ranch_workspace_keeps_its_name_place_rules_and_themes():
    b = brand.brand()
    assert b["name"] == "嬬恋牧場Work&Camp" and b["tags"] == ["#tsumagoicamp"] and b["link"] == "https://tsumagoi.kensaur.us/"
    home = brand.home_place()
    assert (home["lat"], home["lon"], home["radiusKm"]) == (SPEC["ranch"]["lat"], SPEC["ranch"]["lon"], SPEC["ranch"]["radiusKm"])
    assert brand.copy_rules()["banned"] == SPEC["bannedSubstrings"] and brand.copy_rules()["noPrices"]
    assert set(assemble.RANCH_THEMES) <= set(assemble.THEMES) and len(assemble.RANCH_THEMES) == 17
    assert brand.end_card() == ("嬬恋牧場Work&Camp", "Tsumagoi Work&Camp")
    assert problems("牧場の朝") == ["bare-bokujo"] and "price" in problems("¥3,500")
    with pytest.raises(ValueError):
        brand.save_brand({"name": "x"})  # the ranch's values live in code, not in a form


# ---------- a new project: place ----------

def test_a_project_without_a_home_place_uses_all_its_footage(neutral):
    assert brand.home_place() is None
    assert near_ranch(35.68, 139.76) is None  # nothing to be near
    assert place_from(None, (0, 0), (0, 0), "2026-01 anywhere at all") == "ranch (no home place)"
    assert place_from(0, (0, 5), (0, 5), "20250807_嬬恋牧場-summer-burn") == "ranch (no home place)"  # the ranch's away list is not this project's


def test_a_project_with_a_home_place_keeps_footage_from_elsewhere_out(neutral):
    brand.save_brand({"place": {"lat": 35.6812, "lon": 139.7671, "radiusKm": 1, "names": ["kumo"]}})
    assert near_ranch(35.6815, 139.7675) == 1
    assert near_ranch(SPEC["ranch"]["lat"], SPEC["ranch"]["lon"]) == 0  # the ranch is far from Tokyo Station
    assert place_from(None, (0, 0), (0, 0), "2026-03 kumo opening") == "ranch (folder name)"
    assert place_from(None, (0, 0), (0, 0), "202610- tsumagoi-phone") == "unknown"  # the ranch's folder names mean nothing here
    with pytest.raises(ValueError):
        brand.save_brand({"place": {"lat": 200, "lon": 0}})
    brand.save_brand({"place": None})
    assert brand.home_place() is None


# ---------- a new project: themes ----------

def test_a_new_project_starts_with_no_themes_and_never_the_ranchs(neutral):
    assert assemble.THEMES == {}
    assert assemble.theme_list() == {}
    from studio.service import _autopilot

    with pytest.raises(ValueError, match="no themes yet"):
        _autopilot([], None, False)


def test_a_theme_from_the_editor_becomes_a_theme_the_assembler_uses(neutral):
    saved = assemble.save_theme("lunch", LUNCH)
    assert saved["hook"]["ja"] == "雲の上で、\nランチを。" and len(saved["shots"]) == 5
    t = assemble.THEMES["lunch"]
    assert t["beats"][0] == ("hook", "雲の上で、\nランチを。", "Lunch above the clouds.")
    assert len(t["beats"]) == 3 and t["cues"] and all(0 < c < len(t["slots"]) - 1 for c in t["cues"])
    assert t["yt_title"] == "雲の上で、ランチを。｜Cafe Kumo"
    row = assemble.theme_list()["lunch"]
    assert row["own"] and row["edit"]["lines"][1]["ja"] == "パンは毎朝焼きます。"
    assert list(assemble.THEMES) == ["lunch"]
    assert assemble.delete_theme("lunch") and assemble.THEMES == {}


def test_a_theme_needs_a_headline_enough_shots_and_a_free_name(neutral):
    with pytest.raises(ValueError, match="hook"):
        assemble.save_theme("lunch", {**LUNCH, "hook": {"ja": ""}})
    with pytest.raises(ValueError, match="shots"):
        assemble.save_theme("lunch", {**LUNCH, "shots": ["a", "b"]})
    with pytest.raises(ValueError, match="key"):
        assemble.save_theme("Lunch Menu", LUNCH)
    with pytest.raises(ValueError, match="built-in"):
        assemble.save_theme("fire", LUNCH)  # a house reel's name
    no_shots = assemble.save_theme("plain", {"hook": "ようこそ。"})
    assert no_shots["shots"] == assemble.STARTER_SHOTS  # nothing named: plain searches that fit most places


def test_a_projects_own_copy_rules_and_only_those(neutral):
    assert problems("牧場の牛と天の川、¥500") == []  # the ranch's facts are not this project's rules
    brand.save_brand({"banned": "cheapest\nbest in town", "noPrices": True})
    assert problems("The cheapest lunch, ¥500") == ["banned:cheapest", "price"]
    with pytest.raises(ValueError, match="fact guard"):
        assemble.save_theme("deal", {**LUNCH, "hook": {"ja": "Best in town."}})


# ---------- a new project: words, titles, posts ----------

def test_the_word_bank_has_the_projects_lines_and_no_ranch_site_lines(neutral):
    assemble.save_theme("lunch", LUNCH)
    monkey_words = neutral / "words.json"
    wording_file = wording.WORDS
    try:
        wording.WORDS = monkey_words
        texts = {r["ja"] for r in wording.bank()}
    finally:
        wording.WORDS = wording_file
    assert "席は12だけ。" in texts
    assert not any("山" in t or "ラウンジ" in t or "1,444" in t for t in texts)


def test_titles_hashtags_end_card_and_posts_carry_the_projects_name_not_the_ranchs(neutral):
    brand.save_brand({"name": "Cafe Kumo", "nameEn": "", "link": "https://kumo.example/", "tags": "#cafekumo #tokyo"})
    assemble.save_theme("lunch", LUNCH)
    theme = assemble.THEMES["lunch"]
    posts = assemble.posts_for(theme)
    assert "price_ja" not in posts and "linkedin" not in posts and "path" not in posts
    project = {"beats": [{"kind": "hook", "ja": "雲の上で、\nランチを。", "en": "Lunch above the clouds."},
                         {"kind": "line", "ja": "席は12だけ。", "en": "Only twelve seats."}], "posts": posts}
    varied = assemble.vary_copy(project, theme, random.Random(1))
    assert varied["yt_title"].endswith("｜Cafe Kumo")
    assert varied["tags"][:2] == ["#cafekumo", "#tokyo"] and "#tsumagoicamp" not in varied["tags"]
    assert brand.end_card() == ("Cafe Kumo", "")
    reel = {"slug": "lunch-1111", "title_ja": "雲の上で、ランチを。", "yt_title": varied["yt_title"], "tags": varied["tags"], "posts": varied["posts"]}
    for ch in CHANNELS:
        text = reels._post_text(reel, ch)
        assert not any(s in text for s in RANCH_STRINGS), (ch, text)
        if ch in ("bluesky", "x", "threads", "line-oa", "pinterest", "youtube-shorts"):
            assert "https://kumo.example/?utm_source=" + ch in text, ch
    assert len(reels._post_text(reel, "bluesky")) <= 301
    assert reels.file_prefix() == "cafe-kumo"


def test_the_ai_reviewer_is_told_whose_reel_it_is(neutral):
    assert "Cafe Kumo" in ai._review_system() and "嬬恋" not in ai._review_system()


def test_the_ranchs_house_reels_stay_in_the_ranch_workspace(neutral):
    house = {"view", "fire", "field", "winter"}
    assert not house & {r["slug"] for r in reels.all_reels()}


@pytest.mark.ranch
def test_the_ranch_keeps_its_house_reels():
    assert {"view", "fire", "field", "winter"} <= {r["slug"] for r in reels.all_reels()}


def test_the_end_card_handle_is_the_projects_own(neutral):
    assert brand.brand()["handle"] == ""  # a new project's profile has no handle yet: none, never the ranch's
    brand.save_brand({"handle": "cafe.kumo"})
    assert brand.brand()["handle"] == "@cafe.kumo" and reels._brand_handle() == "@cafe.kumo"


def test_the_ranch_end_card_handle_is_unchanged():
    assert reels._brand_handle() == "@tsumagoicamp"


@pytest.mark.ranch
def test_each_project_keeps_its_own_reel_list(neutral, monkeypatch):
    import studio.config as config

    monkeypatch.setattr(config, "PLAN", neutral / "reels.json")
    before = (config.ROOT / "shared" / "reels.json").read_bytes()
    reels.plan_json()
    assert (neutral / "reels.json").exists()
    assert (config.ROOT / "shared" / "reels.json").read_bytes() == before  # the ranch's list is untouched


def test_words_suggest_and_research_carry_no_ranch_material_in_a_new_project(neutral, monkeypatch):
    import studio.research as research

    brand.save_brand({"link": "https://kumo.example/menu?x=1"})
    assemble.save_theme("lunch", LUNCH)
    monkeypatch.setattr(wording, "WORDS", neutral / "words.json")
    import studio.config as config

    monkeypatch.setattr(config, "PLAN", neutral / "reels.json")
    sent = []
    monkeypatch.setattr(research, "_llm", lambda system, user, **k: sent.append(system + "\n" + user) or {"lines": []})
    wording.suggest_lines({"n": 4})
    research._llm_angles([{"url": "https://example.com/a", "title": "t", "snippet": "s", "date": None}], research.default_topic()["ja"])
    copy = " ".join(t for _, t in research.approved_copy())
    for text in sent + [copy, research.site_url(), research.default_topic()["en"], research.angle_system()]:
        assert not any(s in text for s in ("嬬恋", "牧場", "Work&Camp", "Tsumagoi", "群馬", "tsumagoi", "1,444")), text[:200]
    assert "席は12だけ。" in copy and research.site_url() == "https://kumo.example/menu"
    with pytest.raises(ValueError, match="home place"):
        research.events({})


@pytest.mark.ranch
def test_the_ranch_keeps_its_research_and_suggest_briefs():
    import studio.research as research

    assert research.default_topic() is research.DEFAULT_TOPIC and research.angle_system() is research.ANGLE_SYSTEM
    assert wording.suggest_system() is wording.SUGGEST_SYSTEM
    assert any("嬬恋" in t for _, t in research.approved_copy())
