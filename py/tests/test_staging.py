"""Looks and recipes (studio/staging.py, src/looks.tsx): theme defaults, marks from capture data,
countdown numbers, split pairs, morning-to-night order, and only approved words on screen."""
import random
import re

import pytest

from studio.assemble import THEMES, _beats, keep_pairs, morning_to_night
from studio.guard import problems
from studio.reels import check_reel
from studio.staging import LOOKS, RECIPES, day_mark, mark_for, number_lines, season_mark, staging


def test_marks_come_from_darkness_and_the_clock_in_japan_time():
    assert day_mark("night", "2026-10-31T03:00:00Z") == "夜"  # dark wins over the clock
    assert day_mark("dusk", None) == "夕"
    assert day_mark("day", "2026-10-31T23:30:00Z") == "朝"  # 08:30 JST
    assert day_mark("day", "2026-10-31T03:00:00Z") == "昼"  # 12:00 JST
    assert day_mark("day", "2026-10-31T08:00:00Z") == "夕"  # 17:00 JST
    assert day_mark("day", "2026-10-31T07:30:00") == "朝"   # no zone: camera time, Japan
    assert day_mark("day", None) == "昼"
    assert day_mark(None, None) is None
    assert season_mark("autumn") == ("秋", "autumn") and season_mark(None) is None
    assert mark_for("day", "night", "summer", None) == ("夜", "night")
    assert mark_for("season", "night", "summer", None) == ("夏", "summer")


def test_staging_takes_the_project_value_else_the_theme_default():
    assert staging({"theme": "reasons"}) == {"look": "punch", "recipe": "countdown", "kicker": THEMES["reasons"]["kicker"], "loop": True}
    assert staging({"theme": "reasons", "look": "film", "loop": False})["look"] == "film"
    assert staging({"theme": "reasons", "look": None})["look"] is None  # a person chose the plain picture
    assert staging({"theme": "office"}) == {"look": None, "recipe": None, "kicker": None, "loop": False}  # house reel unchanged
    assert staging({"look": "glitter", "recipe": "nope"})["look"] is None
    with pytest.raises(ValueError):
        staging({"kicker": {"ja": "キャンプ場の夜", "en": "x"}})  # the kicker passes the same fact guard


def test_countdown_numbers_the_lines_down_to_one():
    beats = [{"kind": "hook"}, {"kind": "line"}, {"kind": "line"}, {"kind": "line"}, {"kind": "end"}]
    assert [b.get("n") for b in number_lines(beats)] == [None, 3, 2, 1, None]


def test_split_keeps_only_whole_pairs_and_the_last_shot():
    chosen = [{"n": n, "sec": 2.0} for n in (0, 1, 2, 4, 5, 6, 7, 8)]  # slot 3 missing: pair (2,3) breaks
    assert [c["n"] for c in keep_pairs(chosen, 9)] == [0, 1, 4, 5, 6, 7, 8]


def test_timeline_runs_morning_to_night_after_the_opening():
    marks = [("朝", ""), ("夜", ""), ("昼", ""), ("夕", ""), ("朝", ""), None]
    chosen = [{"n": n, "mark": m} for n, m in enumerate(marks)]
    order = [c["n"] for c in morning_to_night(chosen)]
    assert order == [0, 4, 2, 5, 3, 1]  # the opening stays; unmarked counts as midday


def test_every_recipe_theme_names_a_real_look_and_recipe_and_only_approved_words():
    staged = {k: t for k, t in THEMES.items() if t.get("look") or t.get("recipe")}
    assert {t.get("recipe") for t in staged.values()} >= set(RECIPES)
    assert {t.get("look") for t in staged.values()} >= {"film", "punch", "split", "ember"}  # the cut looks come by variation (below)
    house_lines = {ja for k, t in THEMES.items() if k not in staged for _, ja, _ in t["beats"]}
    for key, theme in staged.items():
        assert theme.get("look") in (None, *LOOKS) and theme.get("recipe") in (None, *RECIPES), key
        for _, ja, en in theme["beats"]:
            assert problems(ja) == [] and problems(en) == [], (key, ja)
            assert ja in house_lines, f"{key}: {ja!r} is not a line an approved theme already uses"
        if theme.get("kicker"):
            assert problems(theme["kicker"]["ja"]) == [] and problems(theme["kicker"]["en"]) == [], key
        if theme.get("recipe") == "altitude":
            assert re.search(r"\d{1,3}(?:,\d{3})+\s*m", theme["beats"][0][1]), key  # the counter's number
        if theme.get("slot_season"):
            assert len(theme["slot_season"]) == len(theme["slots"]), key


def test_a_timeline_headline_is_never_cut_short_by_reordered_cues():
    import studio.assemble as A

    marks = [("夕", "")] + [("朝", "")] * 2 + [("昼", "")] * 2 + [("夜", "")] * 4
    chosen = [{"sec": s, "n": n, "mark": m} for n, (s, m) in enumerate(zip([1.5, 2.0, 2.0, 3.0, 3.0, 3.0, 2.0, 3.0, 3.0], marks))]
    chosen = A.morning_to_night(chosen)
    beats = A._beats({**THEMES["day"], "cues": []}, chosen)
    assert beats[0]["endSec"] - beats[0]["startSec"] >= 3.0
    reel = {"shots": [{"src": f"a{i}.mp4", "sec": c["sec"]} for i, c in enumerate(chosen)], "beats": beats}
    assert check_reel(reel) == []


def test_a_countdown_reel_still_passes_the_editorial_rules():
    theme = THEMES["reasons"]
    chosen = [{"sec": s, "n": n} for n, s in enumerate([2.0, 1.5, 1.0, 1.5, 1.5, 1.0, 1.5, 2.0, 3.0])]
    beats = number_lines(_beats(theme, chosen))
    reel = {"shots": [{"src": f"a{i}.mp4", "sec": c["sec"]} for i, c in enumerate(chosen)], "beats": beats}
    assert check_reel(reel) == []
    assert [b["n"] for b in beats if b["kind"] == "line"] == [3, 2, 1]


def test_vary_look_picks_a_known_look_and_repeats_for_a_seed():
    from studio.service import vary_look

    seen = set()
    for seed in range(900):
        a = vary_look({}, "column", random.Random(seed), "punch", night=True)
        b = vary_look({}, "column", random.Random(seed), "punch", night=True)
        assert a == b
        assert a["look"] in (None, *LOOKS) and a["style"] != "column"
        seen.add(a["look"])
    assert seen == {None, *LOOKS} - {"mirror"}  # mirror folds people in two: never drawn at random
    day = {vary_look({}, "column", random.Random(seed), None, night=False)["look"] for seed in range(900)}
    assert "ember" not in day and day == {None, *LOOKS} - {"ember", "mirror"}  # firelight only on night themes
