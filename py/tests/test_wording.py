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
