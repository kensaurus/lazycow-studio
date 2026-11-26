"""Make reels on a project's first run (BL-134, BL-137, BL-141): the headline limit is the server's too, Japanese shots
find footage through their English form (with no AI key: the glossary), and Footage's reel estimate counts the clips
Make reels can actually use."""
import pytest

from studio import assemble, footage, library, research, shotwords


@pytest.fixture
def own_themes(tmp_path, monkeypatch):
    """This project's themes.json in a folder of the test's own; the real one is read again afterwards."""
    monkeypatch.setattr(assemble, "THEME_FILE", tmp_path / "themes.json")
    assemble._THEMES_SEEN[0] = object()
    yield tmp_path / "themes.json"
    monkeypatch.undo()
    assemble._THEMES_SEEN[0] = object()
    assemble.load_themes()


@pytest.fixture
def no_ai(monkeypatch):
    """The AI writing path answers nothing (no key): the glossary must do the work. Counts the asks."""
    asked = []
    monkeypatch.setattr(research, "_llm", lambda *a, **k: asked.append(a) or None)
    return asked


# ---------- BL-141: the headline stops at 80 on the server too ----------

def test_a_headline_over_80_characters_is_refused_by_name(own_themes, no_ai):
    ok = {"hook": {"ja": "あ" * 80, "en": "Fresh bread."}, "shots": ["bread", "coffee", "a window", "a door"]}
    assert len(assemble.save_theme("long-ok", ok)["hook"]["ja"]) == 80
    with pytest.raises(ValueError, match=r"^hook: at most 80 characters \(this one has 81\)"):
        assemble.save_theme("too-long", {**ok, "hook": {"ja": "あ" * 81}})
    with pytest.raises(ValueError, match=r"^line 2: at most 80 characters"):
        assemble.save_theme("too-long", {**ok, "lines": [{"ja": "短い。"}, {"ja": "い" * 90}]})
    with pytest.raises(ValueError, match=r"^hook \(second language\): at most 120 characters"):
        assemble.save_theme("too-long", {**ok, "hook": {"ja": "短い。", "en": "x" * 121}})
    assert "too-long" not in assemble.read_own_themes()


def test_a_long_headline_already_in_the_file_still_loads_cut_to_80(own_themes):
    t = assemble.clean_theme("by-hand", {"hook": {"ja": "あ" * 95}, "shots": ["a", "b", "c", "d"]}, check_copy=False)
    assert len(t["hook"]["ja"]) == 80


# ---------- BL-137: Japanese shots get an English search form ----------

def test_the_glossary_turns_japanese_shots_into_english_with_no_key(no_ai):
    got = shotwords.to_english(["窓際のカフェのテーブル", "コーヒーを注ぐ手元", "a cup of coffee", "焼きたてのパン"])
    assert no_ai, "the AI path is asked first"
    assert not any(shotwords.has_ja(x) for x in got)
    assert got[0] == "table cafe by a window"  # "AのB": the thing first, then what it is of
    assert set(got[1].split()) >= {"coffee", "pouring", "hands"}
    assert got[2] == "a cup of coffee"  # English stays as typed
    assert got[3] == "bread freshly baked"


def test_the_ai_answer_is_used_when_there_is_one(monkeypatch):
    monkeypatch.setattr(research, "_llm", lambda *a, **k: {"shots": ["a cafe table by a window", "まだ日本語"]})
    got = shotwords.to_english(["窓際のカフェのテーブル", "焼きたてのパン"])
    assert got == ["a cafe table by a window", "bread freshly baked"]  # a reply still in Japanese: the glossary's line


def test_a_saved_japanese_theme_searches_in_english_and_shows_japanese(own_themes, no_ai, monkeypatch):
    shots = ["窓際のカフェのテーブル", "焼きたてのパン", "コーヒーを注ぐ手元", "a cup of coffee"]
    saved = assemble.save_theme("kumo-ja", {"hook": {"ja": "毎朝、パンを焼いています。"}, "shots": shots})
    assert saved["shots"] == shots  # the words as typed, for the editor
    assert saved["shotsEn"][:2] == ["table cafe by a window", "bread freshly baked"] and saved["shotsEn"][3] == shots[3]
    theme = assemble.load_themes()["kumo-ja"]
    assert theme["slots"] == saved["shotsEn"]  # what the picture search reads
    assert theme["slots_ja"] == [shots[0], shots[1], shots[2], None]
    # What to film next: English for the search and the English page, the typed Japanese for the Japanese page.
    monkeypatch.setattr(assemble, "items", lambda *a, **k: [])
    row = next(t for t in assemble.film_next() if t["theme"] == "kumo-ja")
    assert (row["need"], row["needJa"]) == ("table cafe by a window", "窓際のカフェのテーブル")


def test_a_theme_sent_with_its_english_forms_keeps_them(own_themes, no_ai):
    saved = assemble.save_theme("story", {"hook": {"ja": "ようこそ。"}, "shots": ["店の入口", "窓際の席", "コーヒー", "夕方の景色"],
                                          "shotsEn": ["the shop entrance", "a seat by the window", "a cup of coffee", "the view at dusk"]})
    assert saved["shotsEn"] == ["the shop entrance", "a seat by the window", "a cup of coffee", "the view at dusk"]
    assert not no_ai, "nothing to translate"


def test_the_starter_shots_have_japanese_words():
    assert len(assemble.STARTER_SHOTS_JA) == len(assemble.STARTER_SHOTS)
    assert all(shotwords.has_ja(x) for x in assemble.STARTER_SHOTS_JA)
    assert assemble.shot_ja(assemble.STARTER_SHOTS[0]) == assemble.STARTER_SHOTS_JA[0]
    assert assemble.shot_ja("a cup of coffee") is None


def test_a_japanese_search_reads_the_english_form(monkeypatch):
    seen = []
    monkeypatch.setattr(library, "_base_items", lambda: [])
    monkeypatch.setattr(library, "text_embedding", lambda q: seen.append(q))
    library.items("焼きたてのパン")
    library.items("a cup of coffee")
    assert seen == ["bread freshly baked", "a cup of coffee"]


# ---------- BL-134: one reel estimate, on the clips Make reels can use ----------

def _row(n, kind="video", dur=6.0, used=0, **kw):
    return {"file": f"c{n}.mp4", "kind": kind, "duration": dur, "place": "ranch (no home place)", "junk": 0.1, "person": 0.05,
            "faces": 0, "top": [], "vetoed": False, "usedIn": [f"r{k}" for k in range(used)], **kw}


def test_the_estimate_counts_what_make_reels_can_pick():
    rows = [_row(i) for i in range(45)] + [
        _row(100, junk=0.45),                 # filler: Make reels skips it
        _row(101, dur=1.5),                   # shorter than the shortest shot
        _row(102, faces=2), _row(103, top=["people"]), _row(104, vetoed=True), _row(105, place="away (trip)"),
        _row(106, kind="photo", dur=None),    # a photo: usable, not a video
    ]
    est = footage.estimate(rows)
    assert all(assemble.can_use(r) for r in est["_videos"]) and len(est["_videos"]) == est["clips"] == 45
    assert (est["usable"], est["fresh"], est["reelsLeft"], est["canMake"]) == (46, 45, 5, True)
    assert est["more"] == {"low": 15, "high": 15, "cap": 3}  # 135 uses left: 15 nine-shot reels (one photo adds none)
    worn = footage.estimate([_row(i, used=3) for i in range(45)])
    assert (worn["more"]["low"], worn["reelsLeft"]) == (0, 0)


def test_a_small_library_shows_no_estimate_beside_reels_will_repeat():
    # BL-134: 32 clips said "about 0 more reels possible" while Make reels was making reels from them.
    est = footage.estimate([_row(i, used=1) for i in range(32)])
    assert est["more"] is None and est["canMake"] is True and est["clips"] == 32
    assert footage.estimate([_row(i) for i in range(3)])["canMake"] is False  # under four clips: no reel at all


# ---------- BL-130: every starter story is a theme this project would save ----------

def test_every_starter_story_saves_as_a_theme_on_either_page(no_ai):
    """The page saves a story with the headline in its own language first (Make reels › Start from a story,
    server/ui/js/21-make.js mkStoryTheme): each must pass the real check, the guard included, both ways."""
    import json

    from studio.config import ROOT

    stories = json.loads((ROOT / "shared" / "starter-stories.json").read_text(encoding="utf-8"))["stories"]
    assert 6 <= len(stories) <= 8
    for s in stories:
        t = s["theme"]
        for lang in ("en", "ja"):
            ja = lang == "ja"
            sent = {"title": t["title"][lang], "hook": {"ja": t["hook"][lang], "en": t["hook"]["en"] if ja else ""},
                    "lines": [{"ja": ln[lang], "en": ln["en"] if ja else ""} for ln in t["lines"]],
                    "shots": t["shotsJa"] if ja else t["shots"], "shotsEn": t["shots"], "tags": t["tags"], "style": t["style"]}
            got = assemble.clean_theme(s["id"], sent)
            assert got["shotsEn"] == t["shots"] and got["style"] == t["style"], s["id"]
            assert len(got["lines"]) == len(t["lines"]) and len(got["shots"]) >= assemble.SHOTS_MIN
    assert not no_ai, "a story brings its own English: nothing to translate"

# ---------- the theme badges follow a theme saved or deleted at once (overview.filmNext was kept ten minutes) ----------

def test_a_saved_or_deleted_theme_is_in_what_to_film_next_at_once(own_themes, no_ai, monkeypatch):
    import time

    from studio import service

    monkeypatch.setitem(service._FILM, "at", time.time())
    monkeypatch.setitem(service._FILM, "data", [{"theme": "older", "left": 3}])
    monkeypatch.setitem(service._FOOTAGE, "data", {"shoot": [], "themes": 1})
    monkeypatch.setattr(assemble, "film_next", lambda: [{"theme": k, "left": 0} for k in assemble.read_own_themes()])
    assert service._film_next() == [{"theme": "older", "left": 3}], "kept between asks"
    theme = {"hook": {"ja": "朝のパン。", "en": "Morning bread."}, "shots": ["bread", "coffee", "a window", "a door"]}
    service.handle({"cmd": "theme_save", "key": "bread", "theme": theme})
    assert [t["theme"] for t in service._film_next()] == ["bread"], "the new theme, not the kept list"
    assert "data" not in service._FOOTAGE, "the footage runway (per theme too) is worked out again"
    service._FOOTAGE["data"] = {"shoot": [], "themes": 1}
    service.handle({"cmd": "theme_delete", "key": "bread"})
    assert service._film_next() == [] and "data" not in service._FOOTAGE
