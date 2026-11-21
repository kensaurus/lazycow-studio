"""Photo posts (studio.stills): exact slides, words that pass the copy rules, captions that fit each network, and files
the server may send only from inside a set's folder. The drawing itself (Remotion) is checked by eye and by the live run."""
import json

import pytest
from PIL import Image

from studio import stills


def test_every_theme_and_caption_passes_the_ranch_copy_rules():
    """No banned word (キャンプ場, campground, 牛...), no price, 牧場 only inside 嬬恋牧場Work&Camp: on any slide or caption."""
    for th in stills.themes():
        for st in stills.styles():
            words = stills.slide_words(th) + [v for k, v in stills.captions(th, st, st["panels"]).items() if not k.startswith("_")]
            bad = [(w, p) for w in words for p in stills.copy_problems(str(w))]
            assert not bad, f"{th['id']}/{st['id']}: {bad[:3]}"


def test_copy_problems_catches_banned_words_prices_and_the_registered_name():
    assert stills.copy_problems("最高のキャンプ場です")
    assert stills.copy_problems("1泊 3,000円")
    assert stills.copy_problems("牧場でゆっくり")
    assert not stills.copy_problems("嬬恋牧場Work&Campでゆっくり")


def test_x_length_counts_japanese_as_two_and_links_as_23():
    assert stills.x_length("abc") == 3
    assert stills.x_length("山で働く") == 8
    assert stills.x_length("see https://tsumagoi.kensaur.us/very/long/path?x=1") == 4 + 23


@pytest.mark.parametrize("theme", [t["id"] for t in stills.themes()])
def test_captions_fit_each_network(theme):
    th = next(t for t in stills.themes() if t["id"] == theme)
    for st in stills.styles():
        c = stills.captions(th, st, st["panels"])
        assert stills.x_length(c["x"]) <= 280
        assert stills.graphemes(c["bluesky"]) <= 300
        assert len(c["threads"]) <= 500
        assert len(c["instagram"]) <= 2200
        assert c["instagram"].count("#") <= 8  # more than a few tags reads as spam


def test_every_look_names_a_known_count_of_slides_and_photos():
    ids = [s["id"] for s in stills.styles()]
    assert len(ids) == len(set(ids)) >= 22
    for s in stills.styles():
        assert 3 <= s["panels"] <= 10 and s["photos"] >= 2  # Instagram carousels take 2-20


def test_slices_are_exact_and_join_back_to_the_still(tmp_path):
    panels = 3
    still = Image.new("RGB", (stills.SLIDE_W * panels, stills.SLIDE_H))
    for x in range(0, still.width, 7):  # a pattern that crosses every join
        still.paste((x % 255, (x * 3) % 255, 90), (x, 0, x + 7, still.height))
    still.save(tmp_path / "still.png")
    names = stills.slice_slides(tmp_path / "still.png", tmp_path, panels)
    assert names == ["slide-01.jpg", "slide-02.jpg", "slide-03.jpg"]
    for n in names:
        with Image.open(tmp_path / n) as im:
            assert im.size == (1080, 1350) and im.format == "JPEG"
        assert (tmp_path / n).stat().st_size < 8_000_000
    assert (tmp_path / "strip.jpg").exists()


def test_slicing_refuses_a_still_of_the_wrong_size(tmp_path):
    Image.new("RGB", (1000, 1350)).save(tmp_path / "still.png")
    with pytest.raises(ValueError):
        stills.slice_slides(tmp_path / "still.png", tmp_path, 1)


def test_prepare_drops_all_metadata(tmp_path):
    src = tmp_path / "gps.jpg"
    im = Image.new("RGB", (4000, 3000), (10, 120, 30))
    exif = Image.Exif()
    exif[0x8825] = {1: "N", 2: (36.0, 30.0, 0.0)}  # a GPS block
    exif[271] = "Xiaomi"
    im.save(src, exif=exif)
    w, h = stills.prepare(src, tmp_path / "out.jpg")
    assert max(w, h) == stills.PHOTO_EDGE
    with Image.open(tmp_path / "out.jpg") as out:
        assert not dict(out.getexif())


def test_files_are_only_sent_from_inside_a_set(tmp_path, monkeypatch):
    monkeypatch.setattr(stills, "OUT", tmp_path)
    (tmp_path / "1121-084552-01-pano-night").mkdir()
    (tmp_path / "1121-084552-01-pano-night" / "slide-01.jpg").write_bytes(b"x")
    assert stills.file_path("1121-084552-01-pano-night", "slide-01.jpg")
    assert stills.file_path("1121-084552-01-pano-night", "meta.json") is None
    assert stills.file_path("../secrets", "slide-01.jpg") is None
    assert stills.file_path("1121-084552-01-pano-night", "../../x.jpg") is None


def test_list_and_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(stills, "OUT", tmp_path)
    for i, when in enumerate(["2026-11-20T10:00:00+09:00", "2026-11-21T10:00:00+09:00"]):
        d = tmp_path / f"set-{i}"
        d.mkdir()
        (d / "meta.json").write_text(json.dumps({"id": f"set-{i}", "created": when}), encoding="utf-8")
    assert [s["id"] for s in stills.list_sets()] == ["set-1", "set-0"]  # newest first
    assert stills.delete("set-0") is True and stills.delete("set-0") is False
    with pytest.raises(ValueError):
        stills.delete("../x")


def test_plan_shows_every_look_before_repeating():
    import random

    plan = stills._plan(10, None, None, random.Random(3))
    assert len({st["id"] for st, _ in plan}) == 10  # 10 different looks out of the 22
    themes = [th["id"] for _, th in plan]
    assert all(a != b for a, b in zip(themes, themes[1:]))  # neighbours differ


def test_approve_copies_slides_story_and_one_caption_per_network(tmp_path, monkeypatch):
    from studio import config

    out, ready = tmp_path / "stills", tmp_path / "ready"
    monkeypatch.setattr(stills, "OUT", out)
    monkeypatch.setattr(config, "READY", ready)
    d = out / "1121-090000-01-pano-autumn"
    d.mkdir(parents=True)
    for f in ("slide-01.jpg", "slide-02.jpg", "story.jpg"):
        (d / f).write_bytes(b"jpg")
    meta = {"id": d.name, "style": "pano", "theme": "autumn", "styleJa": "つながるパノラマ", "themeJa": "嬬恋の秋", "styleEn": "Seamless panorama",
            "themeEn": "Autumn in Tsumagoi", "slides": ["slide-01.jpg", "slide-02.jpg"], "story": "story.jpg",
            "captions": {"instagram": "秋", "facebook": "fb", "threads": "th", "x": "x", "bluesky": "b"}}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    r = stills.approve(d.name)
    dest = next(ready.iterdir())
    assert dest.name.endswith(d.name) and r["folder"] == str(dest)
    assert sorted(p.name for p in dest.iterdir()) == sorted(["slide-01.jpg", "slide-02.jpg", "story.jpg", "instagram.txt", "facebook.txt",
                                                              "threads.txt", "x.txt", "bluesky.txt", "README.txt"])
    assert (dest / "instagram.txt").read_text(encoding="utf-8").strip() == "秋"
    assert json.loads((d / "meta.json").read_text(encoding="utf-8"))["approved"]["folder"] == str(dest)
    with pytest.raises(FileNotFoundError):
        stills.approve("1121-090000-09-none-none")


@pytest.fixture
def cafe(tmp_path, monkeypatch):
    """A neutral project made in the studio ("Cafe Kumo"): not the ranch."""
    from studio import brand

    monkeypatch.setattr(brand, "RANCH", False)
    monkeypatch.setattr(brand, "DATA", tmp_path)
    monkeypatch.setattr(brand, "BRAND_FILE", tmp_path / "brand.json")
    (tmp_path / "brand.json").write_text(json.dumps({"name": "Cafe Kumo", "nameEn": "Cafe Kumo", "tags": ["#cafekumo"]}), encoding="utf-8")
    return tmp_path


def test_another_brand_never_gets_the_ranch_words_facts_or_place(cafe):
    import random
    import re

    words = json.dumps(stills.themes(), ensure_ascii=False)
    assert not re.search("嬬恋|1,444|浅間|tsumagoi|こたつ|Asama", words, re.I)
    assert stills.facts() == []
    pl = stills.place()
    assert pl["place"] == "Cafe Kumo" and pl["alt"] == "" and pl["region"] == ""
    looks = {st["id"] for st, _ in stills._plan(20, None, None, random.Random(1))}
    assert "numbers" not in looks  # no made-up numbers
    for th in stills.themes():
        caps = stills.captions(th, stills.styles()[0], 5, random.Random(2))
        assert "#cafekumo" in caps["instagram"] and "#tsumagoicamp" not in caps["instagram"]


@pytest.mark.ranch
def test_the_ranch_keeps_its_own_words_facts_and_place():
    assert any(t["titleJa"] == "嬬恋の秋" for t in stills.themes())
    assert any(f["big"] == "1,444" for f in stills.facts())
    assert stills.place()["place"] == "TSUMAGOI"


def test_hooks_vary_between_sets_of_one_subject():
    import random

    th = stills.themes()[0]
    seen = {stills.with_hook(th, random.Random(s))["hookJa"] for s in range(40)}
    assert len(seen) >= 3
