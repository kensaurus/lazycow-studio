"""Each new reel draws a type pairing, colours, word motion and grade (studio.typekits), seeded and avoiding repeats."""
import random
from collections import Counter

from studio import typekits


def test_every_list_starts_with_the_house_style_and_ids_are_unique():
    t = typekits.table()
    for key, house in (("kits", "house"), ("palettes", "paper"), ("motions", "type"), ("grades", "house")):
        ids = [x["id"] for x in t[key]]
        assert ids[0] == house, key  # a reel without the field renders exactly as before
        assert len(ids) == len(set(ids)), key


def test_a_draw_is_known_and_repeats_for_a_seed():
    a = typekits.pick(random.Random(7))
    assert a == typekits.pick(random.Random(7))
    for field, value in a.items():
        assert value in typekits.ids(field)


def test_what_the_last_reels_used_is_drawn_less():
    rng = random.Random(1)
    free = Counter(typekits.pick(rng)["typeKit"] for _ in range(3000))
    rng = random.Random(1)
    used = Counter(typekits.pick(rng, [{"typeKit": "house"}])["typeKit"] for _ in range(3000))
    assert used["house"] < free["house"] / 2
    assert len(free) >= 8  # the draw really varies


def test_a_grade_is_a_filter_from_the_table_never_the_reels_own_text():
    assert typekits.grade_filter("house") == ""
    assert typekits.grade_filter(None) == ""
    assert typekits.grade_filter("warm,drawtext=text=x") == ""  # an unknown name is ignored, never passed to ffmpeg
    assert typekits.grade_filter("warm").startswith("colorbalance=")


def test_vary_look_dresses_a_new_reel_and_a_night_keeps_the_house_grade(monkeypatch):
    from studio import service

    monkeypatch.setattr(typekits, "recent", lambda n=typekits.RECENT: [])
    day = service.vary_look({}, "column", random.Random(3))
    assert {"typeKit", "palette", "motion", "grade"} <= set(day)
    seen = {service.vary_look({}, "column", random.Random(s), night=True)["grade"] for s in range(30)}
    assert seen == {"house"}
