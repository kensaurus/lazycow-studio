"""The word bank: every reel draws approved words, avoids sets other reels already have, never puts a line inside its
own headline, never uses a retired line or an unapproved suggestion, and refuses words the fact guard rejects."""
import json
import random

import pytest

from studio import projects, wording
from studio.assemble import THEMES


@pytest.fixture
def bank(tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "DIR", tmp_path / "projects")
    monkeypatch.setattr(wording, "WORDS", tmp_path / "words.json")
    return tmp_path


def _reel(slug, hook, lines, made="2026-11-10T10:00:00"):
    beats = [{"kind": "hook", "ja": hook, "en": "x", "startSec": 0.1, "endSec": 2}]
    beats += [{"kind": "line", "ja": ja, "en": "x", "startSec": 3 + i, "endSec": 4 + i} for i, ja in enumerate(lines)]
    beats.append({"kind": "end", "ja": "嬬恋牧場Work&Camp", "en": "Tsumagoi Work&Camp", "startSec": 9, "endSec": 12})
    projects.save({"slug": slug, "theme": "office", "beats": beats, "made_at": made, "shots": []})


def _sig(d):
    return wording._key(d["hook"][0]) + "|" + "|".join(sorted(wording._key(ja) for ja, _ in d["lines"]))


def test_a_draw_uses_only_approved_lines_and_is_new(bank):
    theme = THEMES["office"]
    approved = {wording._key(r["ja"]) for r in wording.bank() if r["status"] == "approved"}
    _reel("office-a", theme["beats"][0][1], [ja for _, ja, _ in theme["beats"][1:]])
    seen = set()
    for seed in range(12):
        d = wording.draw("office", theme["slots"], random.Random(seed))
        assert wording._key(d["hook"][0]) in approved and all(wording._key(ja) in approved for ja, _ in d["lines"])
        assert len(d["lines"]) == len(theme["beats"]) - 1
        assert d["fresh"] and _sig(d) != wording.signature(projects.load("office-a")["beats"])
        seen.add(_sig(d))
    assert len(seen) >= 6  # twelve draws, many different reels


def test_a_line_is_never_inside_its_own_headline(bank):
    for seed in range(30):
        d = wording.draw("office", THEMES["office"]["slots"], random.Random(seed))
        hook = wording._key(d["hook"][0])
        assert not any(wording._key(ja) in hook or hook in wording._key(ja) for ja, _ in d["lines"])


def test_retired_lines_and_suggestions_are_not_drawn(bank):
    office_hook = THEMES["office"]["beats"][0][1]
    wording.set_status(office_hook, "retired")
    wording.save_line("hook", "山で、\nもう一度。", "Back on the mountain.", status="suggested", source="AI suggestion")
    for seed in range(25):
        d = wording.draw("office", THEMES["office"]["slots"], random.Random(seed))
        assert wording._key(d["hook"][0]) not in (wording._key(office_hook), "山で、もう一度。")
    wording.set_status("山で、\nもう一度。", "approved")
    assert any(r["status"] == "approved" and r["ja"] == "山で、\nもう一度。" for r in wording.bank())


def test_the_fact_guard_refuses_a_bad_line(bank):
    with pytest.raises(ValueError, match="fact guard"):
        wording.save_line("line", "1泊¥3,000から。", "From ¥3,000 a night.")
    with pytest.raises(ValueError, match="fact guard"):
        wording.save_line("hook", "満天の星。", "A sky full of stars.")
    assert not (bank / "words.json").exists() or "¥" not in (bank / "words.json").read_text(encoding="utf-8")


def test_reword_keeps_shots_and_timings_and_changes_the_caption(bank):
    theme = THEMES["office"]
    _reel("office-b", theme["beats"][0][1], [ja for _, ja, _ in theme["beats"][1:]])
    _reel("office-c", theme["beats"][0][1], [ja for _, ja, _ in theme["beats"][1:]], made="2026-11-10T11:00:00")
    before = projects.load("office-c")
    out = wording.reword("office-c", seed=3)
    after = projects.load("office-c")
    assert [b["startSec"] for b in after["beats"]] == [b["startSec"] for b in before["beats"]]
    assert wording.signature(after["beats"]) != wording.signature(before["beats"])
    assert out["fresh"] and after["posts"]["ja"].startswith(after["beats"][0]["ja"].replace("\n", ""))
    assert after["style"] in ("column", "centre", "lower", "split") and after["tags"][0] == "#tsumagoicamp"
    assert wording.same_words("office-b") == []  # c no longer repeats b


def test_report_counts_repeats(bank):
    theme = THEMES["office"]
    for k in range(3):
        _reel(f"office-r{k}", theme["beats"][0][1], [ja for _, ja, _ in theme["beats"][1:]])
    r = wording.report()
    assert r["reels"] == 3 and r["wordSets"] == 1 and r["repeatedReels"] == 3
    assert json.dumps(r, ensure_ascii=False)  # the page reads it as JSON


def test_a_reworded_reel_avoids_headlines_booked_near_it_on_its_networks(bank, monkeypatch):
    from studio import posting

    theme = THEMES["office"]
    taken = theme["beats"][0][1]
    _reel("office-x", taken, [ja for _, ja, _ in theme["beats"][1:]])
    _reel("office-y", taken, [ja for _, ja, _ in theme["beats"][1:]], made="2026-11-10T11:00:00")
    monkeypatch.setattr(posting, "posts", lambda: [
        {"slug": "office-x", "network": "x", "status": "scheduled", "at": "2026-11-20T19:00+09:00"},
        {"slug": "office-y", "network": "x", "status": "scheduled", "at": "2026-11-25T19:00+09:00"},
        {"slug": "office-y", "network": "bluesky", "status": "queued", "at": "2026-11-26T19:00+09:00"},
    ])
    assert wording.booked_near("office-y") == {wording._key(taken)}
    for seed in range(10):
        out = wording.reword("office-y", seed=seed, save_it=False)
        hook = next(b["ja"] for b in out["beats"] if b["kind"] == "hook")
        assert wording._key(hook) != wording._key(taken)


def test_lines_that_would_wrap_inside_a_word_never_go_on_screen(bank):
    assert wording.fits_screen("山で働く。\n冬でも、夜通しでも。")
    assert not wording.fits_screen("昼は紅葉、夜は焚き火。\nそのあとは、あったかいラウンジへ。")  # 17 characters: ラウ / ンジ
    with pytest.raises(ValueError, match="at most 14"):
        wording.save_line("line", "とても長い一行の文章がここにあります。", "A long line.")
    for seed in range(20):
        d = wording.draw("autumn", THEMES["autumn"]["slots"], random.Random(seed))
        assert all(wording.fits_screen(ja) for ja in [d["hook"][0], *[x for x, _ in d["lines"]]])


def test_one_reel_never_says_the_same_fact_twice(bank):
    for theme in ("aerial", "office", "fire", "carstay"):
        for seed in range(15):
            d = wording.draw(theme, THEMES[theme]["slots"], random.Random(seed))
            seen = set()
            for ja in [d["hook"][0], *[x for x, _ in d["lines"]]]:
                assert not (wording.fact_words(ja) & seen), (theme, seed, ja)
                seen |= wording.fact_words(ja)


def test_a_line_suits_the_picture_it_plays_over():
    night, day_summer, autumn = [{"tod": "night", "season": "summer"}], [{"tod": "day", "season": "summer"}], [{"tod": "day", "season": "autumn"}]
    assert not wording.picture_fits("不便だからこそ、\nこの尾根が見える。", night)       # no ridge in the dark
    assert not wording.picture_fits("冬の夜は、\n氷点下まで下がります。", day_summer)  # no winter over summer
    assert not wording.picture_fits("晴れた夜空には、\nくっきり光る星。", day_summer)    # a night line needs night or dusk
    assert not wording.picture_fits("平日、\n紅葉の中で働く", day_summer)               # autumn leaves need autumn
    assert wording.picture_fits("山で働く。\n冬でも、夜通しでも。", day_summer)         # a claim, not a picture of winter
    assert wording.picture_fits("平日、\n紅葉の中で働く", autumn)
    assert wording.picture_fits("不便だからこそ、\nこの尾根が見える。", [None])        # an unknown clip never blocks


def test_every_draw_keeps_the_theme(bank):
    for theme, word in (("office", "work"), ("carstay", "car"), ("fire", "fire")):
        core = wording.topics_of(THEMES[theme]["beats"][0][1]) - {"sleep"}
        for seed in range(12):
            d = wording.draw(theme, THEMES[theme]["slots"], random.Random(seed))
            texts = [d["hook"][0], *[x for x, _ in d["lines"]]]
            assert any(wording.topics_of(t) & core for t in texts), (theme, seed, texts)


def test_a_line_must_not_say_what_its_picture_contradicts():
    """13 Nov review: a tent before the lodge under "no buildings", a lit lounge under "no lights on the field at night",
    zucchini under the stars, a kite on a car park under "the next tent is not too close"."""
    def shot(*tags, tod="day", season="summer"):
        return {"tod": tod, "season": season, "tags": set(tags)}

    assert not wording.picture_fits("窓の外を眺めても、\n建物は見えません。", [shot("tent", "building")])
    assert wording.picture_fits("窓の外を眺めても、\n建物は見えません。", [shot("mountains", "field")])
    assert not wording.picture_fits("夜のフィールドに、\n外灯はありません。", [shot("interior", tod="night")])
    assert wording.picture_fits("夜のフィールドに、\n外灯はありません。", [shot("field", "night", tod="night")])
    assert not wording.picture_fits("晴れた夜は、\n星もくっきり見えます。", [shot("food", "kitchen", tod="night")])
    assert not wording.picture_fits("となりのテントと、\n距離が近すぎない。", [shot("parking", "people")])
    assert wording.picture_fits("となりのテントと、\n距離が近すぎない。", [shot("tent", "field")])
    assert not wording.picture_fits("中のラウンジは、\nこたつと光回線。", [shot("tent", "field")])
    assert wording.picture_fits("中のラウンジは、\nこたつと光回線。", [shot("interior", "desk", season="winter")])
    assert not wording.picture_fits("共用キッチンで、\n自分で作って。", [shot("car", "road")])
    assert not wording.picture_fits("不便だからこそ、\n景色がいい。", [shot("kitchen", "food")])
    assert wording.picture_fits("不便だからこそ、\n景色がいい。", [shot("mountains", "sky")])
    stars = "晴れた夜空には、くっきり光る星。"
    assert not wording.picture_fits(stars, [shot("night", tod="night"), shot("forest", "road"), shot("grill", tod="night")])
    assert wording.picture_fits(stars, [shot("night", tod="night"), shot("sky", tod="dusk")])
    parking = "駐車場は、1晩に5台まで。"
    assert not wording.picture_fits(parking, [shot("kitchen"), shot("interior", "kitchen")])
    assert wording.picture_fits(parking, [shot("parking", "car")])
    # a clip the library never tagged never blocks a line
    assert wording.picture_fits("窓の外を眺めても、\n建物は見えません。", [{"tod": "day", "season": "summer"}])


def test_a_shot_that_shows_a_building_or_a_room_does_not_play_under_open_country(monkeypatch):
    """nightfire-1114: the lounge under "one open field"; a road ending at a house under "no buildings outside"."""
    import numpy as np
    vec = {"a photo of a house or a building": np.array([1.0, 0.0], "float32"),
           "a photo of open nature, fields and mountains with no buildings": np.array([0.0, 1.0], "float32")}
    import studio.library as library
    monkeypatch.setattr(library, "text_embedding", lambda q: vec[q])
    assert wording.built(np.array([0.30, 0.25], "float32")) is True and wording.built(np.array([0.25, 0.27], "float32")) is False
    assert wording.built(None) is None
    house = {"tod": "day", "season": "autumn", "tags": {"road", "sky"}, "built": True}
    field = {"tod": "day", "season": "autumn", "tags": {"field", "mountains"}, "built": False}
    lounge = {"tod": "day", "season": "summer", "tags": {"interior", "kitchen", "fire"}, "built": True}
    nobuild = "窓の外に、建物はありません。"
    onefield = "区画のない、ひとつの草原。"
    assert not wording.picture_fits(nobuild, [field, house])
    assert wording.picture_fits(nobuild, [field])
    assert not wording.picture_fits(onefield, [field, lounge])
    assert wording.picture_fits(onefield, [field])


def test_the_shot_a_line_starts_on_must_show_it_and_no_buildings_means_open_country():
    """office-1114-2 and carstay-1114 (14 Nov): an aerial of the lodge under "no buildings", a car park under "the next
    tent is never too close", daytime kite flying under "winter nights drop below zero"."""
    def shot(*tags, tod="day", season="summer"):
        return {"tod": tod, "season": season, "tags": set(tags), "built": False}

    nobuild = "窓の外に、建物はありません。"
    assert not wording.picture_fits(nobuild, [shot("aerial", "mountains", "deck")])
    assert wording.picture_fits(nobuild, [shot("aerial", "mountains"), shot("field")])
    spacing = "となりのテントと、距離が近すぎない。"
    assert not wording.picture_fits(spacing, [shot("car", "parking"), shot("tent", "field")])  # starts on the car park
    assert wording.picture_fits(spacing, [shot("tent", "field"), shot("car")])
    winter = "冬の夜は、氷点下まで下がります。"
    assert not wording.picture_fits(winter, [shot("sky", season="autumn")])
    assert wording.picture_fits(winter, [shot("snow", season="winter")])


def test_a_pitching_line_starts_on_a_tent_or_open_ground():
    pitch = "区画がないから、好きな場所に張る。"
    assert not wording.picture_fits(pitch, [{"tod": "day", "season": "autumn", "tags": {"kitchen", "food"}}])
    assert wording.picture_fits(pitch, [{"tod": "day", "season": "autumn", "tags": {"tent", "field"}}])


def test_a_car_line_starts_on_a_car():
    car = "車で来て、車で寝る。"
    assert not wording.picture_fits(car, [{"tod": "day", "season": "autumn", "tags": {"working", "building"}}, {"tod": "day", "season": "autumn", "tags": {"car"}}])
    assert wording.picture_fits(car, [{"tod": "day", "season": "autumn", "tags": {"car", "field"}}])


def test_a_kitchen_line_starts_in_the_kitchen_not_at_the_grill():
    kit = "共用キッチンで、自分で作って。"
    assert not wording.picture_fits(kit, [{"tod": "night", "season": "summer", "tags": {"grill", "fire"}}])
    assert wording.picture_fits(kit, [{"tod": "day", "season": "summer", "tags": {"kitchen", "interior"}}])


def test_a_choose_your_spot_line_starts_on_open_ground():
    spot = "区画がないからこそ、好きな場所を選べる。"
    assert not wording.picture_fits(spot, [{"tod": "day", "season": "summer", "tags": {"food", "kitchen"}}])
    assert wording.picture_fits(spot, [{"tod": "day", "season": "summer", "tags": {"field", "mountains"}}])


def test_a_fire_line_starts_on_a_fire_not_on_the_kitchen_hob():
    fire = "お店がないからこそ、火を囲んで食べる。"
    hob = {"tod": "day", "season": "autumn", "tags": {"food", "grill", "kitchen"}}
    assert not wording.picture_fits(fire, [hob, {"tod": "day", "season": "summer", "tags": {"aerial", "building"}}])
    assert wording.picture_fits(fire, [{"tod": "night", "season": "summer", "tags": {"fire", "grill"}}])
    assert wording.picture_fits(fire, [{"tod": "day", "season": "summer", "tags": {"grill", "pizza"}}])  # the grill outside


def test_a_work_line_starts_at_a_desk_or_in_a_room():
    work = "山で働く。冬でも、夜通しでも。"
    assert not wording.picture_fits(work, [{"tod": "day", "season": "autumn", "tags": {"food", "kitchen"}}])
    assert not wording.picture_fits("仕事は浅く、つながりは深く。", [{"tod": "day", "season": "autumn", "tags": {"kitchen"}}])
    assert wording.picture_fits(work, [{"tod": "day", "season": "winter", "tags": {"desk", "interior"}}])
    # working among the autumn leaves is outdoors: not held to a desk
    assert wording.picture_fits("平日、紅葉の中で働く", [{"tod": "day", "season": "autumn", "tags": {"aerial", "mountains"}}])


def test_no_buildings_never_over_a_bare_aerial_of_the_site_or_the_car_park():
    line = "窓の外に、建物はありません。"
    assert not wording.picture_fits(line, [{"tod": "day", "season": "summer", "tags": {"aerial"}}])
    assert not wording.picture_fits(line, [{"tod": "day", "season": "summer", "tags": {"car", "mountains"}}])
    assert wording.picture_fits(line, [{"tod": "day", "season": "autumn", "tags": {"aerial", "mountains"}}])


def test_making_it_yourselves_starts_on_food_or_fire_and_a_desk_label_on_a_desk():
    make = "お店がないからこそ、手で作る。"
    assert not wording.picture_fits(make, [{"tod": "day", "season": "summer", "tags": {"car"}}])
    assert wording.picture_fits(make, [{"tod": "day", "season": "summer", "tags": {"pizza", "grill"}}])
    assert not wording.picture_fits("POV：今日のデスク", [{"tod": "day", "season": "summer", "tags": {"car"}}])
    assert wording.picture_fits("POV：今日のデスク", [{"tod": "day", "season": "summer", "tags": {"desk", "interior"}}])


def _at(*tags, tod="day", season="summer"):
    return [{"tod": tod, "season": season, "tags": set(tags)}]


def test_fifteen_november_review_lines_start_on_what_they_say():
    fits = wording.picture_fits
    # one open grassland: not the lodge or the car park
    assert not fits("区画のない、ひとつの草原。", _at("aerial", "building", "mountains"))
    assert fits("区画のない、ひとつの草原。", _at("aerial", "mountains"))
    assert not fits("区画のない、ひとつの草原。", _at("deck", "mountains"))
    assert not fits("山にこもって、どこまで進むか。", _at("food", "kitchen"))
    # the fibre line: a desk or a room, never the stove
    assert not fits("標高1,444m、100Mbpsの光回線。", _at("desk", "fire", "grill", season="autumn"))
    assert fits("標高1,444m、100Mbpsの光回線。", _at("desk", "interior"))
    # an altitude headline: the mountain, not lunch
    assert not fits("東京の逆を、標高1,444mで。", _at("food", "kitchen"))
    assert not fits("東京の逆を、標高1,444mで。", _at("grill"))
    assert fits("東京の逆を、標高1,444mで。", _at("grill", "mountains"))
    assert fits("東京の逆を、標高1,444mで。", _at("field", "mountains"))
    # loud: the fire or the evening, not a parked car
    assert not fits("遠いからこそ、騒げる。", _at("car", "parking", season="autumn"))
    assert fits("遠いからこそ、騒げる。", _at("fire", "pizza", tod="night"))
    assert fits("遠いからこそ、騒げる。", _at("deck", tod="dusk"))
