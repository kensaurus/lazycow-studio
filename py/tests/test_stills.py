"""Photo posts (studio.stills): exact slides, words that pass the copy rules, captions that fit each network, and files
the server may send only from inside a set's folder. The drawing itself (Remotion) is checked by eye and by the live run."""
import json

import pytest
from PIL import Image

from studio import stills


def test_every_theme_and_caption_passes_the_ranch_copy_rules():
    """No banned word, no price, the bare word only inside the registered name (the project's copy rules): on any
    slide or caption."""
    for th in stills.themes():
        for st in stills.styles():
            words = stills.slide_words(th) + [v for k, v in stills.captions(th, st, st["panels"]).items() if not k.startswith("_")]
            bad = [(w, p) for w in words for p in stills.copy_problems(str(w))]
            assert not bad, f"{th['id']}/{st['id']}: {bad[:3]}"


def test_copy_problems_catches_banned_words_prices_and_the_registered_name(monkeypatch):
    from studio import brand

    # The example business's own rules (Cafe Kumo), so the check is tested without any one project's words.
    monkeypatch.setattr(brand, "copy_rules", lambda: {"banned": ["食べ放題"], "noPrices": True, "registered": "Cafe Kumo Kitchen",
                                                      "bare": "Kitchen"})
    assert stills.copy_problems("最高の食べ放題です")
    assert stills.copy_problems("ランチ 1,200円")
    assert stills.copy_problems("Kitchen open") == ["Kitchen outside the registered name"]
    assert not stills.copy_problems("Cafe Kumo Kitchenでゆっくり")


def test_x_length_counts_japanese_as_two_and_links_as_23():
    assert stills.x_length("abc") == 3
    assert stills.x_length("山で働く") == 8
    assert stills.x_length("see https://cafe-kumo.example/very/long/path?x=1") == 4 + 23


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
    meta = {"id": d.name, "style": "pano", "theme": "autumn", "styleJa": "つながるパノラマ", "themeJa": "雲の上の秋", "styleEn": "Seamless panorama",
            "themeEn": "Autumn at Cafe Kumo", "slides": ["slide-01.jpg", "slide-02.jpg"], "story": "story.jpg",
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


def test_another_brand_never_gets_the_ranch_words_facts_or_place(cafe, ranch_words):
    import random

    words = json.dumps(stills.themes(), ensure_ascii=False)
    assert not [w for w in ranch_words if w.lower() in words.lower()]
    assert stills.facts() == []
    pl = stills.place()
    assert pl["place"] == "Cafe Kumo" and pl["alt"] == "" and pl["region"] == ""
    looks = {st["id"] for st, _ in stills._plan(20, None, None, random.Random(1))}
    assert "numbers" not in looks  # no made-up numbers
    for th in stills.themes():
        caps = stills.captions(th, stills.styles()[0], 5, random.Random(2))
        assert "#cafekumo" in caps["instagram"] and not [w for w in ranch_words if w in caps["instagram"]]


def test_hooks_vary_between_sets_of_one_subject():
    import random

    th = stills.themes()[0]
    seen = {stills.with_hook(th, random.Random(s))["hookJa"] for s in range(40)}
    assert len(seen) >= 3


def test_focal_point_of_a_flat_photo_is_the_middle(tmp_path, monkeypatch):
    monkeypatch.setattr(stills, "_clip_subject", lambda p: None)
    f = tmp_path / "flat.jpg"
    Image.new("RGB", (800, 600), (120, 130, 140)).save(f)
    assert stills.focal_point(f) == (0.5, 0.5)


def test_focal_point_follows_a_subject_off_the_middle(tmp_path, monkeypatch):
    """A red tent in the upper right of a plain field: the crop must keep it, not the empty middle."""
    import random

    monkeypatch.setattr(stills, "_clip_subject", lambda p: None)
    rnd = random.Random(1)
    im = Image.new("RGB", (1200, 800), (90, 120, 80))
    px = im.load()
    for x in range(0, 1200, 3):  # a little grass texture everywhere
        for y in range(0, 800, 3):
            v = rnd.randint(-8, 8)
            px[x, y] = (90 + v, 120 + v, 80 + v)
    for x in range(860, 1020):
        for y in range(120, 280):
            px[x, y] = (210, 40, 30)
    f = tmp_path / "tent.jpg"
    im.save(f, quality=92)
    fx, fy = stills.focal_point(f)
    assert fx > 0.62 and fy < 0.42, (fx, fy)


def test_clip_points_the_way_when_it_is_sure(tmp_path, monkeypatch):
    monkeypatch.setattr(stills, "_clip_subject", lambda p: (0.2, 0.3, 0.05))
    f = tmp_path / "flat.jpg"
    Image.new("RGB", (800, 600), (120, 130, 140)).save(f)
    fx, fy = stills.focal_point(f)
    assert fx < 0.4 and fy < 0.4  # 70% meaning, 30% saliency (the middle here)


def test_the_focal_point_is_kept_per_source_photo(tmp_path, monkeypatch):
    monkeypatch.setattr(stills, "FOCAL_CACHE", tmp_path / "_focal.json")
    calls = []
    monkeypatch.setattr(stills, "focal_point", lambda p: calls.append(p) or (0.3, 0.7))
    src = tmp_path / "a.jpg"
    Image.new("RGB", (10, 10)).save(src)
    assert stills.cached_focal(src, src) == (0.3, 0.7) and stills.cached_focal(src, src) == (0.3, 0.7)
    assert len(calls) == 1


def _story_set(out, sid="1121-090000-01-contact-autumn"):
    d = out / sid
    d.mkdir(parents=True)
    for k, colour in enumerate(("#c84", "#48c", "#8c4"), 1):
        Image.new("RGB", (stills.SLIDE_W, stills.SLIDE_H), colour).save(d / f"slide-0{k}.jpg")
    meta = {"id": d.name, "style": "contact", "theme": "autumn", "styleJa": "コンタクトシート", "themeJa": "雲の上の秋",
            "slides": ["slide-01.jpg", "slide-02.jpg", "slide-03.jpg"], "story": "story.jpg", "captions": {}}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return d


def test_the_story_video_steps_through_every_slide_in_9_16(tmp_path, monkeypatch):
    import subprocess

    from studio.config import ffprobe_bin

    monkeypatch.setattr(stills, "OUT", tmp_path)
    d = _story_set(tmp_path)
    video = stills.story_video(d.name)
    probe = subprocess.run([str(ffprobe_bin()), "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
                            "-of", "json", str(video)], capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert (v["width"], v["height"]) == (stills.STORY_W, stills.STORY_H)
    assert any(s["codec_type"] == "audio" for s in info["streams"])  # a silent track: Instagram wants one
    assert 9.0 <= float(info["format"]["duration"]) <= 12.0  # 3 slides, about 3 s each
    assert not (d / "_story").exists()  # the frames are cleaned up
    assert stills.file_path(d.name, "story.mp4") == video


def test_a_story_goes_once_and_the_set_remembers_it(tmp_path, monkeypatch):
    from studio.connectors import instagram_story

    monkeypatch.setattr(stills, "OUT", tmp_path)
    d = _story_set(tmp_path, "1121-090000-02-contact-autumn")
    sent = []
    monkeypatch.setattr(stills, "story_video", lambda sid: (d / "story.mp4").write_bytes(b"mp4") and d / "story.mp4")
    monkeypatch.setattr(instagram_story, "post", lambda video, *a, **k: sent.append(video) or {"url": "https://instagram.com/stories/x/1", "remote_id": "1"})
    r = stills.post_story(d.name)
    assert r["posted"] and r["url"].endswith("/1") and sent == [d / "story.mp4"]
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    assert meta["storyPosted"]["id"] == "1" and meta["storyVideo"] == "story.mp4"
    with pytest.raises(RuntimeError, match="went to Instagram"):
        stills.post_story(d.name)
    assert len(sent) == 1
    with pytest.raises(ValueError):
        stills.post_story("../x")



def test_photo_stories_get_one_lunchtime_a_day():
    from datetime import datetime

    jst = stills.JST
    at = lambda s: datetime.fromisoformat(s)  # noqa: E731
    stills_rows = []
    orig = stills.story_rows
    try:
        stills.story_rows = lambda: stills_rows
        assert stills.next_story_slot(at("2026-11-21T11:00+09:00")) == datetime(2026, 11, 21, 12, 15, tzinfo=jst)
        assert stills.next_story_slot(at("2026-11-21T12:10+09:00")) == datetime(2026, 11, 22, 12, 15, tzinfo=jst)  # too close
        stills_rows.append({"slug": "x", "status": "queued", "at": "2026-11-22T12:15+09:00"})
        assert stills.next_story_slot(at("2026-11-21T13:00+09:00")) == datetime(2026, 11, 23, 12, 15, tzinfo=jst)
    finally:
        stills.story_rows = orig


def _bookable(tmp_path, monkeypatch, sid):
    from studio.connectors import instagram_story

    monkeypatch.setattr(stills, "OUT", tmp_path)
    d = _story_set(tmp_path, sid)
    monkeypatch.setattr(instagram_story, "status", lambda: {"connected": True})
    monkeypatch.setattr(stills, "story_video", lambda s: (d / "story.mp4").write_bytes(b"mp4") and d / "story.mp4")
    return d


def test_a_set_with_a_face_is_booked_only_with_a_yes_and_only_once(tmp_path, monkeypatch):
    from studio import posting

    sid = "1121-090000-03-shapes-stay"
    _bookable(tmp_path, monkeypatch, sid)
    monkeypatch.setattr(stills, "faces_in", lambda s: [3])
    with pytest.raises(stills.FacesFound, match="slide 3"):
        stills.schedule_story(sid)
    assert not [r for r in posting.posts() if r["slug"] == sid]
    r = stills.schedule_story(sid, "2030-01-05T12:15+09:00", force=True)
    row = next(x for x in posting.posts() if x["id"] == r["id"])
    assert (row["network"], row["status"], row["slug"]) == ("photo-story", "queued", sid)
    with pytest.raises(ValueError, match="already booked"):
        stills.schedule_story(sid, "2030-01-06T12:15+09:00", force=True)
    listed = next(s for s in stills.list_sets() if s["id"] == sid)
    assert listed["storyQueued"]["id"] == r["id"]
    assert stills.unschedule_story(sid)["unbooked"] == 1
    assert not [x for x in posting.posts() if x["slug"] == sid]
    assert "storyQueued" not in next(s for s in stills.list_sets() if s["id"] == sid)


def test_a_booked_photo_story_goes_out_at_its_time_and_is_logged(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from studio import posting, publish
    from studio.connectors import instagram_story

    sid = "1121-090000-04-gallery-views"
    _bookable(tmp_path, monkeypatch, sid)
    monkeypatch.setattr(instagram_story, "post", lambda video, *a, **k: {"url": "https://www.instagram.com/stories/x/9", "remote_id": "9"})
    pid = posting.queue(sid, "photo-story", (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(timespec="minutes"))
    out = [r for r in publish._run_due() if r.get("slug") == sid]
    assert out and out[0]["status"] == "posted"
    row = next(x for x in posting.posts() if x["id"] == pid)
    assert (row["status"], row["remote_id"]) == ("posted", "9")
    meta = json.loads((tmp_path / sid / "meta.json").read_text(encoding="utf-8"))
    assert meta["storyPosted"]["post"] == pid


def test_story_numbers_are_kept_per_set_and_stay_out_of_the_reel_model():
    from studio import learn

    rows = [
        {"network": "photo-story", "slug": "a", "fetched_at": "2026-11-21T14:00:00+09:00", "views": 10, "reach": 8, "extra": {}, "age_h": 1},
        {"network": "photo-story", "slug": "a", "fetched_at": "2026-11-22T10:00:00+09:00", "views": 90, "reach": 70,
         "extra": {"profile_visits": 4, "navigation": {"tap_forward": 30}}, "age_h": 21},
        {"network": "instagram-story", "slug": "reel", "fetched_at": "2026-11-22T10:00:00+09:00", "views": 5, "extra": {}, "age_h": 21},
    ]
    res = stills.story_results(rows)
    assert set(res) == {"a"} and res["a"]["views"] == 90 and res["a"]["profile_visits"] == 4 and res["a"]["navigation"]["tap_forward"] == 30
    looks = stills.look_results([{"style": "shapes", "storyResult": res["a"]}, {"style": "pano"}])
    assert looks == [{"style": "shapes", "stories": 1, "reach": 70.0, "views": 90.0, "profile_visits": 4.0}]
    post = {"id": 1, "slug": "a", "network": "photo-story", "status": "posted", "at": "2026-11-21T13:00+09:00", "out_at": "2026-11-21T13:00+09:00", "age_h": 30}
    assert learn.comparable(posts=[post], rows=[{**rows[1], "post_id": 1, "source": "api"}])["units"] == []
