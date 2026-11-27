"""Words from frame 0, the loop ending on by default, and the Site walk cut (27 Nov: reels of 1-3 s cuts kept 5-8 % of
feed viewers; one continuous 24-31 s shot with words on screen kept 24-35 %)."""
from pathlib import Path

import pytest

import studio.assemble as asm
from studio.assemble import WALK_LINES, WALK_RHYTHM, WALK_SHOT, _beats, _reach_min_length, walk_theme
from studio.reels import LENGTH_RULE, SHOT_MAX, check_reel, open_on_words, wants

# A neutral example business (examples/cafe-kumo), so nothing here is any one project's own words.
SLOTS = ["a cafe table by a window", "bread on a wooden board", "a chef cooking", "a cup of coffee", "a view of clouds",
         "pouring coffee", "a pastry on a plate", "steam from a cup", "a window in morning light"]
BEATS = [("hook", "雲の上で、\nランチを。", "Lunch above the clouds."), ("line", "席は12だけ。", "Only twelve seats."),
         ("line", "パンは毎朝焼きます。", "Bread baked every morning."), ("line", "豆は近所で焙煎。", "Beans roasted down the street."),
         ("line", "窓から雲海。", "A sea of clouds from the window.")]
THEME = {"title_ja": "雲の上", "slots": SLOTS, "cues": [2, 4, 6, 7], "beats": BEATS, "tags": ["#cafe"], "yt_title": "Lunch above the clouds",
         "style": "column", "look": "punch", "posts": {"ja": "雲の上で、ランチを。", "en": "Lunch above the clouds.", "x": "雲の上で", "zh": ""}}


def _chosen(secs):
    return [{"sec": s, "n": n, "cand": {"kind": "video", "duration": 12.0}} for n, s in enumerate(secs)]


def test_the_headline_starts_on_the_first_frame():
    beats = _beats(THEME, _chosen([2.0, 1.5, 1.0, 1.5, 1.5, 1.0, 1.5, 2.0, 3.0]))
    hook = beats[0]
    assert hook["kind"] == "hook" and hook["startSec"] == 0.0, "the first frame the feed shows carries the words"
    assert hook["endSec"] > 1.0


def test_every_render_moves_an_early_headline_to_zero_and_leaves_the_rest():
    beats = [{"kind": "hook", "ja": "a", "startSec": 0.1, "endSec": 3.0}, {"kind": "line", "ja": "b", "startSec": 3.1, "endSec": 5.0},
             {"kind": "end", "ja": "c", "startSec": 5.1, "endSec": 8.0}]
    out = open_on_words(beats)
    assert out[0]["startSec"] == 0.0 and out[0]["endSec"] == 3.0
    assert out[1:] == beats[1:] and beats[0]["startSec"] == 0.1, "the project's own beats are not changed"


def test_site_walk_has_its_own_length_and_shot_rules():
    assert LENGTH_RULE["site-walk"] == (25, 40) and SHOT_MAX["site-walk"] == 9.0
    assert LENGTH_RULE[None] == (8, 25) and SHOT_MAX[None] == 4.0, "the short loop keeps its rules"
    shots = [{"src": f"a{i}.mp4", "sec": s} for i, s in enumerate(WALK_RHYTHM)]
    beats = _beats(walk_theme(THEME), _chosen(WALK_RHYTHM), walk=True)
    assert check_reel({"slug": "w", "variant": "site-walk", "shots": shots, "beats": beats}) == []
    short = check_reel({"slug": "s", "shots": shots, "beats": beats})
    assert any("shot too long" in p for p in short) and any("length" in p for p in short), "a 7 s shot is still too long on the short loop"


def test_walk_theme_keeps_the_first_and_last_shot_and_three_lines():
    w = walk_theme(THEME)
    assert w["slots"][0] == SLOTS[0] and w["slots"][-1] == SLOTS[-1] and len(w["slots"]) == len(WALK_RHYTHM)
    assert len(w["beats"]) == 1 + WALK_LINES and w["beats"][0][0] == "hook" and w["cues"] == []
    four = walk_theme({**THEME, "slots": SLOTS[:4]})
    assert four["slots"] == SLOTS[:4], "a four-shot theme keeps all four"


def test_walk_words_hold_the_long_shots_and_the_end_card_takes_the_last_seconds():
    chosen = _chosen(WALK_RHYTHM)  # 7, 6.5, 6, 6.5, 7 = 33 s
    beats = _beats(walk_theme(THEME), chosen, walk=True)
    hook, *lines, end = beats
    assert hook["startSec"] == 0.0 and hook["endSec"] == pytest.approx(WALK_RHYTHM[0] - 0.2), "the headline holds the first shot"
    assert len(lines) == WALK_LINES and all(b["endSec"] - b["startSec"] >= 5 for b in lines), "calm lines, about 7 s each"
    assert end["kind"] == "end" and end["endSec"] == 33.0 and end["startSec"] == pytest.approx(33.0 - asm.WALK_END)
    for a, b in zip(beats, beats[1:]):
        assert a["endSec"] < b["startSec"]


def test_a_walk_too_short_grows_its_shots_up_to_nine_seconds():
    chosen = [{"sec": 5.0, "cand": {"kind": "video", "duration": 12.0}} for _ in range(4)]  # 20 s, under 25
    _reach_min_length(chosen, variant="site-walk")
    assert sum(c["sec"] for c in chosen) >= 25 and max(c["sec"] for c in chosen) <= 9.0


def test_a_site_walk_goes_to_the_short_networks_not_the_explainer_only_ones():
    reel = {"slug": "w", "variant": "site-walk", "shots": [{"sec": 7.0}] * 5}
    assert wants(reel, {"variant": "a-loop", "maxSec": 180})
    assert not wants(reel, {"variant": "a-loop", "maxSec": 30}), "longer than the network takes"


# ---------- assemble end to end, on a made-up library ----------

def _clip(i: int, dur: float, kind: str = "video") -> dict:
    return {"id": 1000 + i, "file": f"clip{i:02d}.mp4" if kind == "video" else f"still{i:02d}.jpg", "path": f"C:/footage/clip{i:02d}.mp4",
            "kind": kind, "duration": dur if kind == "video" else None, "usedIn": [], "match": 0.30 - i * 0.001, "aesthetic": None,
            "captured": "2026-11-01T10:00:00", "season": "autumn", "top": ["view"], "tod": "day", "place": "ranch", "vetoed": False,
            "junk": 0.0, "faces": 0, "person": 0.0}


@pytest.fixture
def library(monkeypatch, tmp_path):
    """Twelve long clips, six short ones and two photos; every search finds all of them (best first)."""
    import studio.projects as projects

    clips = [_clip(i, 12.0) for i in range(12)] + [_clip(20 + i, 3.0) for i in range(6)] + [_clip(40 + i, 0, "photo") for i in range(2)]
    clips.sort(key=lambda c: -c["match"])

    def items(slot, filters, limit=80):
        return [dict(c) for c in clips if not filters.get("kind") or c["kind"] == filters["kind"]][:limit]

    import contextlib

    import studio.db as db

    class NoEmbeddings:
        def execute(self, *a):
            return []

    monkeypatch.setattr(db, "connect", contextlib.contextmanager(lambda: (yield NoEmbeddings())))
    monkeypatch.setattr(asm, "items", items)
    monkeypatch.setattr(asm, "_on_the_beat", lambda *a, **k: None)
    monkeypatch.setattr(projects, "DIR", tmp_path)
    return clips


def test_assemble_makes_a_site_walk_of_few_long_calm_shots(library):
    p = asm.assemble(dict(THEME), "walk-test", variant="site-walk", seed=3, with_layers=False)
    secs = [s["sec"] for s in p["shots"]]
    assert p["variant"] == "site-walk" and len(secs) == len(WALK_RHYTHM)
    assert all(WALK_SHOT[0] <= s <= WALK_SHOT[1] for s in secs), secs
    assert LENGTH_RULE["site-walk"][0] <= sum(secs) <= LENGTH_RULE["site-walk"][1]
    long_files = {c["file"] for c in library if c["kind"] == "video" and c["duration"] >= WALK_SHOT[0] + 0.8}
    assert all(Path(s["src"]).name in long_files for s in p["shots"]), "only clips that hold a long shot, no photos"
    assert p["look"] is None, "the theme's punch look waits for its short loop"
    assert p["loop"] is True and p["sfx"] is False and not p.get("layers") and p["bpm"] is None
    assert p["beats"][0]["startSec"] == 0.0
    assert check_reel(p) == []


def test_a_new_reel_ends_on_the_loop_unless_its_theme_says_no(library):
    p = asm.assemble(dict(THEME), "loop-test", seed=3, with_layers=False)
    assert p["loop"] is True and "variant" not in p
    q = asm.assemble({**THEME, "loop": False}, "noloop-test", seed=3, with_layers=False)
    assert q["loop"] is False


def test_a_site_walk_says_what_to_film_when_the_clips_are_too_short(library, monkeypatch):
    short = [c for c in library if c["kind"] == "video" and c["duration"] < 5]
    monkeypatch.setattr(asm, "items", lambda slot, filters, limit=80: [dict(c) for c in short])
    with pytest.raises(RuntimeError, match="site walk needs 3"):
        asm.assemble(dict(THEME), "walk-none", variant="site-walk", seed=1, with_layers=False)


def test_the_autopilot_takes_the_walk_cut(monkeypatch, tmp_path):
    import studio.projects as projects
    from studio import service

    monkeypatch.setattr(projects, "DIR", tmp_path)
    monkeypatch.setattr(asm, "THEMES", {"kumo": {"title": "t", "style": "column"}})
    seen = {}

    def fake(theme, slug, **kw):
        seen.update(kw)
        return {"slug": slug, "seed": 7, "look": None, "shots": [{"src": "a.mp4", "sec": 7}], "made_by": "assembler"}

    monkeypatch.setattr(asm, "assemble", fake)
    made = service._autopilot(["kumo"], None, False, cut="walk", vary=True)[0]
    p = projects.load(made["slug"])
    assert seen["variant"] == "site-walk" and made["slug"].endswith("-walk") and made["cut"] == "walk"
    assert p["sfx"] is False and p.get("look") in asm.WALK_LOOKS, "Vary the look never gives a site walk a punchy look"
    assert service.handle({"cmd": "autopilot", "themes": ["kumo"], "cut": "walk"})[0]["cut"] == "walk"
    assert service.handle({"cmd": "autopilot", "themes": ["kumo"], "cut": "odd"})[0]["cut"] == "short"
