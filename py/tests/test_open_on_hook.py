"""The opening shot suits the headline (14 Nov review: connect-1114-3 opened "work in the mountains" on snacks)."""
from studio import assemble, wording


def _c(i, tags):
    return {"cand": {"id": i, "season": "autumn", "tod": "day", "top": list(tags)}, "sec": 1.5}


def test_opens_on_the_first_shot_a_headline_suits(monkeypatch):
    monkeypatch.setattr(wording, "draw", lambda *a, under=None, **k: {"hookFits": "desk" in under[0][0]["tags"]})
    chosen = [_c(1, {"food"}), _c(2, {"aerial"}), _c(3, {"desk", "interior"}), _c(4, {"desk"})]
    out = assemble._open_on_hook("office", chosen, {})
    assert [c["cand"]["id"] for c in out] == [3, 1, 2, 4]


def test_keeps_the_order_when_the_opening_fits_or_nothing_does(monkeypatch):
    chosen = [_c(1, {"food"}), _c(2, {"aerial"}), _c(3, {"desk"})]
    monkeypatch.setattr(wording, "draw", lambda *a, **k: {"hookFits": True})
    assert assemble._open_on_hook("office", chosen, {}) == chosen
    monkeypatch.setattr(wording, "draw", lambda *a, **k: {"hookFits": False})
    assert assemble._open_on_hook("office", chosen, {}) == chosen
    # the closing shot is never pulled to the front
    monkeypatch.setattr(wording, "draw", lambda *a, under=None, **k: {"hookFits": "desk" in under[0][0]["tags"]})
    assert assemble._open_on_hook("office", chosen, {}) == chosen


def test_draw_says_whether_a_headline_suits_the_opening(monkeypatch):
    import random

    under = [[{"tod": "day", "season": "autumn", "tags": {"food", "kitchen"}}]]
    monkeypatch.setattr(wording, "picture_fits", lambda ja, shots: True)
    assert wording.draw("office", [], random.Random(0), n_lines=0, tries=1, under=under)["hookFits"] is True
    monkeypatch.setattr(wording, "picture_fits", lambda ja, shots: False)
    assert wording.draw("office", [], random.Random(0), n_lines=0, tries=1, under=under)["hookFits"] is False
    assert wording.draw("office", [], random.Random(0), n_lines=0, tries=1)["hookFits"] is True  # nothing to check against


def test_the_kicker_label_also_suits_the_opening_shot(monkeypatch):
    monkeypatch.setattr(wording, "draw", lambda *a, **k: {"hookFits": True})
    chosen = [_c(1, {"car"}), _c(2, {"aerial"}), _c(3, {"desk", "interior"}), _c(4, {"tent"})]
    out = assemble._open_on_hook("pov", chosen, {}, "POV：今日のデスク")
    assert [c["cand"]["id"] for c in out] == [3, 1, 2, 4]


def test_a_label_that_no_opening_shot_shows_is_left_off():
    assert not assemble._label_fits("POV：今日のデスク", _c(1, {"kitchen"}), {})
    assert assemble._label_fits("POV：今日のデスク", _c(2, {"desk", "interior"}), {})


def test_a_summer_autumn_pair_moves_together(monkeypatch):
    monkeypatch.setattr(wording, "draw", lambda key, lines, rng, **k: {"hookFits": "food" not in k["under"][0][0]["tags"]})
    chosen = [_c(1, {"food"}), _c(2, {"field"}), _c(3, {"mountains"}), _c(4, {"aerial"}), _c(5, {"tent"})]
    out = assemble._open_on_hook("seasons", chosen, {}, step=2)
    assert [c["cand"]["id"] for c in out] == [3, 4, 1, 2, 5]


def test_the_second_shot_under_the_headline_suits_it_too(monkeypatch):
    monkeypatch.setattr(wording, "draw", lambda key, lines, rng, **k: {"hookFits": "food" not in k["under"][0][0]["tags"]})
    chosen = [_c(1, {"field"}), _c(2, {"food"}), _c(3, {"food"}), _c(4, {"aerial"}), _c(5, {"tent"})]
    assert [c["cand"]["id"] for c in assemble._open_on_hook("altitude", chosen, {})] == [1, 4, 2, 3, 5]

