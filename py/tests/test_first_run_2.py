"""The fresh-user walk of 27 Nov. BL-145: Make reels counts the clips that fit a theme by the same picks a reel is made
by (assemble.theme_fit, the helper's "fit"), so its button can be greyed before a press that would fail. BL-149: a
starter story picked on the English page still has Japanese words for What to film next on the Japanese page."""
import json

import pytest

from studio import assemble, service, shotwords
from studio.config import ROOT


@pytest.fixture
def own_themes(tmp_path, monkeypatch):
    """This project's themes.json in a folder of the test's own; the real one is read again afterwards."""
    monkeypatch.setattr(assemble, "THEME_FILE", tmp_path / "themes.json")
    assemble._THEMES_SEEN[0] = object()
    yield tmp_path / "themes.json"
    monkeypatch.undo()
    assemble._THEMES_SEEN[0] = object()
    assemble.load_themes()


def _row(i: int, name: str, kind: str = "video", duration: float = 10.0, **extra) -> dict:
    return {"id": 10_000 + i, "file": name, "path": f"C:/footage/{name}", "kind": kind, "duration": duration if kind == "video" else None,
            "place": "ranch (no home place)", "usedIn": [], "match": 0.3 - i * 0.01, "aesthetic": None, "captured": "2026-11-20",
            "season": None, "top": [], "faces": 0, "person": 0, "junk": 0, "vetoed": False, "device": "phone", "tod": None, **extra}


def _library(monkeypatch, rows: list[dict]) -> None:
    """Every search line finds the same rows, best first (what a tiny library looks like to the picture search)."""
    monkeypatch.setattr(assemble, "items", lambda query, filters=None, limit=400: [r for r in rows if not (filters or {}).get("kind") or r["kind"] == filters["kind"]][:limit])


STORY = {"hook": {"ja": "Coffee, made slowly.", "en": ""}, "lines": [{"ja": "Every cup by hand.", "en": ""}],
         "shots": ["pouring coffee into a cup", "steam rising from a cup", "a cafe table by a window", "hands making coffee",
                   "a pastry on a plate", "the cafe door from the street"], "style": "lower"}


def test_the_fit_count_is_the_number_of_different_clips_a_reel_would_get(own_themes, monkeypatch):
    assemble.save_theme("coffee", STORY)
    _library(monkeypatch, [_row(0, "a.mp4"), _row(1, "b.mp4")])
    assert assemble.theme_fit(["coffee"]) == {"coffee": 2}
    # The same count a press of Make would end on (the walk's "found only 2 different clips that fit").
    with pytest.raises(RuntimeError, match=r"^only 2 usable assets for this theme$"):
        assemble.assemble(assemble.THEMES["coffee"], "coffee-1127", seed=1)
    _library(monkeypatch, [_row(i, f"c{i}.mp4") for i in range(6)])
    assert assemble.theme_fit(["coffee"]) == {"coffee": 6}
    assert assemble.MIN_SHOTS == 4


def test_the_fit_count_leaves_out_what_a_reel_cannot_use(own_themes, monkeypatch):
    assemble.save_theme("coffee", STORY)
    rows = [_row(0, "long1.mp4"), _row(1, "long2.mp4"), _row(2, "long3.mp4"),
            _row(3, "short.mp4", duration=1.2),            # shorter than the shortest shot
            _row(4, "set-aside.mp4", vetoed=True),          # set aside by a person
            _row(5, "people.mp4", faces=2),                 # faces, not allowed by default
            _row(6, "p1.jpg", kind="photo"), _row(7, "p2.jpg", kind="photo"), _row(8, "p3.jpg", kind="photo")]
    _library(monkeypatch, rows)
    # 3 videos and at most 30 % photos of 6 slots (1 photo): 4 different clips, just enough.
    assert assemble.theme_fit(["coffee"]) == {"coffee": 4}
    assert assemble.theme_fit(["coffee"], allow_faces=True) == {"coffee": 5}, "faces allowed: the clip with people counts"
    assert assemble.theme_fit(["nope"]) == {}, "an unknown theme is left out"


def test_the_helper_answers_fit_and_keeps_it_while_nothing_changes(own_themes, monkeypatch):
    assemble.save_theme("coffee", STORY)
    _library(monkeypatch, [_row(i, f"c{i}.mp4") for i in range(3)])
    service._FIT.clear()
    counted = []
    real = assemble.theme_fit
    monkeypatch.setattr(assemble, "theme_fit", lambda keys, faces=False: counted.append(keys) or real(keys, faces))
    monkeypatch.setattr(service, "_library_counts", lambda: {"total": 3, "ranch": 3})
    got = service.handle({"cmd": "fit", "themes": ["coffee"]})
    assert got == {"fit": {"coffee": 3}, "need": 4}
    assert service.handle({"cmd": "fit", "themes": ["coffee"]}) == got and len(counted) == 1, "kept"
    monkeypatch.setattr(service, "_library_counts", lambda: {"total": 4, "ranch": 4})
    service.handle({"cmd": "fit", "themes": ["coffee"]})
    assert len(counted) == 2, "a new clip: counted again"


# ---------- BL-149: What to film next in Japanese for a story picked on the English page ----------

def _stories() -> list[dict]:
    return json.loads((ROOT / "shared" / "starter-stories.json").read_text(encoding="utf-8"))["stories"]


def test_every_starter_story_shot_has_japanese_words():
    for s in _stories():
        t = s["theme"]
        assert len(t["shotsJa"]) == len(t["shots"]), s["id"]
        for en, ja in zip(t["shots"], t["shotsJa"]):
            got = assemble.shot_ja(en)
            assert got and shotwords.has_ja(got), f"{s['id']}: {en}"
            if en not in assemble.STARTER_SHOTS:
                assert got == ja, f"{s['id']}: {en} reads as the story says"


def test_a_story_picked_on_the_english_page_shows_japanese_what_to_film(own_themes, monkeypatch):
    cafe = next(s for s in _stories() if s["id"] == "cafe")["theme"]
    # The English page sends the English shots only (server/ui/js/21-make.js mkStoryTheme).
    assemble.save_theme("cafe", {"title": cafe["title"]["en"], "hook": {"ja": cafe["hook"]["en"], "en": ""},
                                 "lines": [{"ja": ln["en"], "en": ""} for ln in cafe["lines"]], "shots": cafe["shots"], "shotsEn": cafe["shots"],
                                 "tags": cafe["tags"], "style": cafe["style"]})
    theme = assemble.load_themes()["cafe"]
    assert theme["slots_ja"] == cafe["shotsJa"]
    monkeypatch.setattr(assemble, "items", lambda *a, **k: [])
    row = next(t for t in assemble.film_next() if t["theme"] == "cafe")
    assert (row["need"], row["needJa"]) == ("pouring coffee into a cup", "カップにコーヒーを注ぐところ")
