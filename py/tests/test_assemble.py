"""Assembled captions land on the cut of the shot they describe and end with the picture."""
from studio.assemble import THEMES, _beats
from studio.reels import check_reel


def _chosen(secs, slots=None):
    return [{"sec": s, "n": n} for n, s in zip(slots or range(len(secs)), secs)]


def test_lines_start_on_their_cue_shot():
    theme = THEMES["office"]  # cues on slots 2, 4, 6
    chosen = _chosen([2.0, 1.5, 1.0, 1.5, 1.5, 1.0, 1.5, 2.0, 3.0])
    beats = _beats(theme, chosen)
    starts = [0, 2.0, 3.5, 4.5, 6.0, 7.5, 8.5, 10.0, 12.0]
    lines = [b for b in beats if b["kind"] == "line"]
    assert [round(b["startSec"] - 0.1, 2) for b in lines] == [starts[2], starts[4], starts[6]]
    assert beats[-1]["kind"] == "end" and beats[-1]["startSec"] == 12.1 and beats[-1]["endSec"] == 15.0
    for a, b in zip(beats, beats[1:]):
        assert a["endSec"] < b["startSec"]


def test_a_skipped_slot_moves_the_cue_to_the_next_shot():
    theme = THEMES["office"]
    chosen = _chosen([2.0, 1.5, 1.5, 1.5, 1.0, 2.0, 3.0], slots=[0, 1, 3, 4, 5, 6, 8])
    lines = [b for b in _beats(theme, chosen) if b["kind"] == "line"]
    assert round(lines[0]["startSec"] - 0.1, 2) == 3.5  # slot 2 missing: slot 3's shot


def test_every_theme_is_approved_copy_in_a_valid_shape():
    from studio.assemble import posts_for
    from studio.guard import problems

    styles = {"column", "centre", "lower", "split"}
    for key, theme in THEMES.items():
        assert len(theme["slots"]) == 9, key
        assert theme.get("style", "column") in styles, key
        assert len(theme.get("cues", [])) == len(theme["beats"]) - 1, key
        assert all(0 < c < 8 for c in theme["cues"]), key
        for _, ja, en in theme["beats"]:
            assert problems(ja) == [] and problems(en) == [], (key, ja)
        post = posts_for(theme)
        assert post["ja"] and post["price_ja"] and post["path"], key
        if theme.get("post"):
            assert post["ja"].startswith(theme["post"]["ja"].split("\n")[0]) and post["zh"] == "", key


def test_words_go_to_the_quiet_side_of_the_picture():
    from studio.reels import side_for

    assert side_for(0.8) == "left"   # detail on the right
    assert side_for(0.2) == "right"  # detail on the left
    assert side_for(0.5) is None     # centred: the style decides


def test_too_few_shots_fall_back_to_even_spacing_and_still_pass_the_rules():
    theme = THEMES["carstay"]
    chosen = _chosen([2.0, 2.0, 2.0, 3.0], slots=[0, 1, 2, 8])
    beats = _beats(theme, chosen)
    reel = {"shots": [{"src": f"a{i}.mp4", "sec": c["sec"]} for i, c in enumerate(chosen)], "beats": beats}
    assert check_reel(reel) == []
    for b in beats:
        assert b["endSec"] > b["startSec"]


def test_a_four_or_five_shot_theme_still_makes_a_reel_long_enough_to_render():
    # The theme editor's minimum is 4 shots; the short rhythm gives them 6-7.5 s, under the renderer's 8 s, and the
    # example themes (examples/cafe-kumo: 4 and 5 shots) failed every render with "length 7.5s outside 8-25 s".
    from studio.assemble import RHYTHM, _reach_min_length

    for n in (4, 5):
        chosen = [{"sec": s, "cand": {"kind": "video", "duration": 7.0}} for s in RHYTHM[:n]]
        _reach_min_length(chosen)
        assert sum(c["sec"] for c in chosen) >= 8
        assert all(c["sec"] <= 4.0 and (c["sec"] * 2) == int(c["sec"] * 2) for c in chosen)
    # photos and short clips are never stretched past what they hold
    chosen = [{"sec": 1.0, "cand": {"kind": "photo", "duration": None}}, {"sec": 1.5, "cand": {"kind": "video", "duration": 2.0}}]
    _reach_min_length(chosen)
    assert [c["sec"] for c in chosen] == [2.0, 1.5]
