"""Long YouTube vlogs from a trip (studio.vlog): days split evenly into parts, the best moments picked without
near-identical bursts, chapter names only from what the pictures show, and YouTube's chapter rules kept."""
import numpy as np

import studio.vlog as vlog


def test_days_split_into_even_consecutive_parts():
    days = [("2015-09-13", 120), ("2015-09-14", 300), ("2015-09-15", 80), ("2015-09-16", 260), ("2015-09-17", 200),
            ("2015-09-18", 150), ("2015-09-19", 90), ("2015-09-20", 250), ("2015-09-21", 40)]
    parts = vlog._split(days, 4)
    assert len(parts) == 4 and [d for p in parts for d in p] == [d for d, _ in days], "every day once, in order"
    sizes = [sum(n for d, n in days if d in p) for p in parts]
    assert max(sizes) / min(sizes) < 2.2
    assert vlog._split(days[:2], 4) == [["2015-09-13"], ["2015-09-14"]], "never more parts than days"


def test_shot_lengths():
    assert vlog.shot_seconds({"kind": "photo"}) == vlog.PHOTO_SEC
    assert vlog.shot_seconds({"kind": "video", "duration": 40}) == vlog.VIDEO_MAX
    assert vlog.shot_seconds({"kind": "video", "duration": 3.6}) == vlog.VIDEO_MIN
    assert vlog.shot_seconds({"kind": "video", "duration": 10}) == 7.5, "most of a clip plays, not a 5 s snippet"
    assert vlog.shot_seconds({"kind": "video", "duration": 2.0}) == 1.7, "a short clip is used whole, minus its ragged end"


def test_the_best_moments_without_bursts_in_time_order():
    rng = np.random.default_rng(1)
    base = rng.normal(size=16).astype("float32")
    burst = [({"path": f"b{k}", "kind": "photo", "aesthetic": 8.0 - k * 0.1, "sharp": 50, "junk": 0, "captured": f"2015-09-13T10:0{k}"}, base + rng.normal(scale=0.01, size=16).astype("float32")) for k in range(4)]
    other = [({"path": f"o{k}", "kind": "photo", "aesthetic": 6.0, "sharp": 50, "junk": 0, "captured": f"2015-09-13T0{k}:00"}, rng.normal(size=16).astype("float32")) for k in range(4)]
    got = vlog._pick(burst + other, budget=12)
    paths = [i["path"] for i, _ in got]
    assert sum(p.startswith("b") for p in paths) == 1, "one of a burst, the best"
    assert "b0" in paths
    assert [i["captured"] for i, _ in got] == sorted(i["captured"] for i, _ in got)


def test_moving_clips_go_in_before_photos():
    rng = np.random.default_rng(2)
    photos = [({"path": f"p{k}", "kind": "photo", "aesthetic": 8.5, "sharp": 80, "junk": 0, "captured": f"2015-09-13T1{k}:00"}, rng.normal(size=16).astype("float32")) for k in range(6)]
    clips = [({"path": f"v{k}", "kind": "video", "duration": 10, "aesthetic": 5.0, "sharp": 10, "junk": 0, "captured": f"2015-09-13T0{k}:00"}, rng.normal(size=16).astype("float32")) for k in range(3)]
    got = [i["path"] for i, _ in vlog._pick(photos + clips, budget=25)]
    assert all(f"v{k}" in got for k in range(3)), "every distinct clip, though the photos look better"
    assert any(p.startswith("p") for p in got), "photos fill what the clips leave"


def test_a_flagged_clip_that_clearly_shows_an_animal_still_counts():
    day = {"captured": "2015-09-14T08:00", "kind": "video", "duration": 12}
    assert vlog._usable({**day, "junk": 0.85}, clear=0.10), "a lion on brown ground is not junk"
    assert not vlog._usable({**day, "junk": 0.85}, clear=0.03), "a flagged shot of nothing in particular is"
    assert not vlog._usable({**day, "junk": 0.85}), "no clarity known: the flag stands"
    assert vlog._usable({**day, "junk": 0.1})


def test_chapter_names_come_from_the_pictures():
    concepts = np.eye(len(vlog.CONCEPTS), dtype="float32")
    lion, cheetah = [n for n, _ in vlog.CONCEPTS].index("Lions"), [n for n, _ in vlog.CONCEPTS].index("Cheetahs")
    embs = [concepts[lion]] * 3 + [concepts[cheetah]] * 2
    assert vlog.chapter_name(embs, concepts) == "Lions & Cheetahs"
    assert vlog.chapter_name([], concepts) == "On the road"


def test_youtube_chapters_follow_youtubes_rules():
    video = {"n": 2, "span": "15–17 September 2015", "title": "Highlands & Coast · Part 2: Lions & Elephants"}
    chapters = [{"atSec": 18.3, "title": "Lions & Cheetahs", "dayNo": 3}, {"atSec": 22.0, "title": "Birds", "dayNo": 4},
                {"atSec": 160.0, "title": "Elephants & The plains", "dayNo": 5}, {"atSec": 475.0, "title": "Sunsets", "dayNo": 6}]
    yt = vlog.youtube_text(video, chapters, 480.0, "Highlands & Coast")
    marks = yt["chapters"]
    assert marks[0]["at"] == 0 and len(marks) >= 3 and yt["chaptersValid"]
    assert all(b["at"] - a["at"] >= 10 for a, b in zip(marks, marks[1:])), "each chapter at least 10 s"
    assert all(480 - m["at"] >= 10 for m in marks[1:]), "none in the last 10 s"
    assert "0:00 Intro" in yt["description"] and "2:40 Day 5: Elephants & The plains" in yt["description"]
    assert len(yt["title"]) <= 100 and vlog._stamp(3725) == "1:02:05"


def test_a_google_photos_video_without_a_real_date_gets_its_creation_time(tmp_path):
    from pathlib import Path

    from studio.ingest import captured_time

    gp = Path(tmp_path) / "imports" / "google-photos" / "20261111" / "MVI_0400.MP4"
    other = Path(tmp_path) / "footage" / "clip.mp4"
    t = 1442814800.0  # 2015-09-21
    assert captured_time("1970-01-01T00:00:00.000000Z", gp, t).startswith("2015-09-2")
    assert captured_time("2015-09-14T08:00:00Z", gp, t) == "2015-09-14T08:00:00Z"
    assert captured_time("1970-01-01T00:00:00Z", other, t) is None, "a copied file's time is never trusted"


def test_a_day_is_cut_into_chapters_at_its_long_pauses():
    def shot(h, m):
        return ({"captured": f"2015-09-13T{h:02d}:{m:02d}:00"}, np.zeros(4, "float32"))
    morning = [shot(7, m) for m in range(0, 24, 2)]
    drive = [shot(10, m) for m in range(0, 48, 2)]
    evening = [shot(18, m) for m in range(0, 30, 2)]
    segs = vlog._segments(morning + drive + evening)
    assert [len(s) for s in segs] == [12, 24, 15]
    assert vlog._segments(morning) == [morning], "too few shots to cut"
    close = [shot(9, m) for m in range(0, 60, 2)]
    assert len(vlog._segments(close)) == 1, "no long pause, no cut"


def test_long_video_use_is_its_own_mark(tmp_path, monkeypatch):
    """Footage shows which clips are in a long video, apart from reel use (which steers how reels are picked)."""
    import json

    import studio.library as lib

    monkeypatch.setattr(lib, "DATA", tmp_path)
    assert lib.vlog_usage() == {}, "no plan yet"
    (tmp_path / "vlog-plan.json").write_text(json.dumps({"videos": [
        {"n": 2, "cold": [{"path": "C:/Trip/MVI_1.MP4"}], "chapters": [{"shots": [{"path": "C:/Trip/mvi_1.mp4"}, {"path": "C:/Trip/IMG_2.JPG"}]}]},
        {"n": 3, "chapters": [{"shots": [{"path": "C:/Trip/IMG_2.JPG"}]}]}]}), encoding="utf-8")
    assert lib.vlog_usage() == {"c:/trip/mvi_1.mp4": [2], "c:/trip/img_2.jpg": [2, 3]}


def test_parts_follow_the_moving_footage():
    stats = [("d1", 160), ("d2", 730), ("d3", 130), ("d4", 145), ("d5", 147), ("d6", 111), ("d7", 144), ("d8", 87), ("d9", 0)]
    assert vlog._group_days(stats, want=288) == [["d1", "d2"], ["d3", "d4", "d5"], ["d6", "d7", "d8", "d9"]], "a quiet last day joins the part before"
    assert vlog._group_days([("a", 10), ("b", 10)], want=288) == [["a", "b"]], "too little for two parts: one"


def test_style_sets_shot_lengths():
    clip = {"kind": "video", "duration": 30}
    assert vlog.shot_seconds(clip, "lively") == vlog.LOOKS["energetic"]["videoMax"] < vlog.shot_seconds(clip, "calm"), "older names still work"
    assert vlog.shot_seconds({"kind": "photo"}, "photos") == vlog.LOOKS["journal"]["photo"]
    assert vlog.look_of("calm") == "documentary" and vlog.look_of("nonsense") == ""
    assert vlog.fade_sec("energetic") == 0 and vlog.fade_sec("cinematic") > vlog.fade_sec("documentary"), "a cut, and a longer dissolve"


def test_energetic_cuts_land_on_the_beat():
    beats = [0.5 * i for i in range(1, 60)]  # 120 BPM
    seq = [{"kind": "photo", "sec": 1.6}, {"kind": "video", "sec": 3.0, "duration": 1.4}, {"kind": "video", "sec": 3.6, "duration": 20}]
    out = vlog._on_beats(seq, beats)
    ends, t = [], 0.0
    for s in out:
        t += s["sec"]
        ends.append(round(t, 3))
    assert all(round(e / 0.5, 6).is_integer() for e in ends), "every cut on a beat"
    assert out[1]["sec"] <= 1.4, "a short clip is never asked for more than it has"
    assert out[2]["sec"] == 3.5, "a long clip takes whole beats, at most 7 (3.5 s at 120 BPM)"
    assert out[0]["sec"] == 1.5, "a photo holds three beats"


def test_the_first_chapter_label_and_caption_wait_for_the_title():
    out = vlog.overlays([], [], [(10.0, {"caption": "A balloon over the plains."})], total=300.0, title_at=10.0)
    note = next(o for o in out if o["kind"] == "note")
    assert note["atSec"] == round(10.0 + 4.5 + 4.2 + 0.4, 2), "title 4.5 s, then the label 4.2 s, then the caption"


def test_overlays_never_overlap_and_name_an_animal_once_in_a_while(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(vlog, "TRIP_FILE", tmp_path / "trip.json")
    (tmp_path / "trip.json").write_text(json.dumps({"places": {"2015-09-14": "Maasai Mara, Kenya"}}), encoding="utf-8")
    lion = {"kind": "video", "sec": 6.0, "subject": "Lions", "clear": 0.12, "gap": 0.04}
    seq = [lion, {**lion}, {"kind": "photo", "sec": 3.4, "subject": "Zebras", "clear": 0.05, "gap": 0.01}, {**lion, "subject": "Hippos"}]
    starts = [0.0, 30.0, 40.0, 130.0]
    out = vlog.overlays(seq, starts, [(0.0, {"caption": "A lion walks through tall grass."})], total=300.0)
    kinds = [(o["kind"], o.get("title")) for o in out]
    assert ("note", "A lion walks through tall grass.") in kinds
    assert [(t, o["atSec"]) for (k, t), o in zip(kinds, out) if k == "subject"] == [("Lion", 30.7), ("Hippo", 130.7)],         "the first lion shot sits under the chapter label and caption, so the next one names it; an unclear zebra is never named"
    two = vlog.overlays([{**lion}, {**lion}], [20.0, 60.0], [], total=300.0)
    assert [o["atSec"] for o in two] == [20.7], "the same animal again 40 s later is not named again"
    assert next(o for o in out if o.get("title") == "Hippo")["sub"] == "kiboko in Swahili"
    spans = sorted((o["atSec"], o["atSec"] + o["sec"]) for o in out)
    assert all(b <= c for (_, b), (c, _) in zip(spans, spans[1:])), "never two at once"
    assert not vlog.overlays([{**lion}], [290.0], [], total=300.0), "nothing in the end-screen seconds"
    (tmp_path / "trip.json").write_text(json.dumps({"places": {"2015-09-14": "Hokkaido"}, "overlays": {"captions": False}}), encoding="utf-8")
    out = vlog.overlays([{**lion}], [60.0], [(0.0, {"caption": "x"})], total=300.0)
    assert [o["kind"] for o in out] == ["subject"] and "sub" not in out[0], "captions off; no Swahili away from East Africa"


def test_parts_over_the_same_days_do_not_share_shots(monkeypatch, tmp_path):
    monkeypatch.setattr(vlog, "TRIP_FILE", tmp_path / "trip.json")
    monkeypatch.setattr(vlog, "private_paths", lambda rows=None: {})  # needs the search model; privacy has its own tests
    monkeypatch.setattr(vlog, "_concept_matrix", lambda: np.eye(len(vlog.CONCEPTS), dtype="float32"))
    rng = np.random.default_rng(5)
    rows = []
    for d in range(13, 19):
        for k in range(40):
            e = rng.normal(size=len(vlog.CONCEPTS)).astype("float32")
            rows.append(({"path": f"d{d}-{k}.mp4", "kind": "video", "duration": 12, "aesthetic": 6 + rng.random(), "sharp": 40, "junk": 0,
                          "captured": f"2015-09-{d}T10:{k:02d}:00"}, e))
    days = [f"2015-09-{d}" for d in range(13, 19)]
    p = vlog.plan(name="Trip", style="documentary", groups=[days, days[:2]], lengths=[4, 4], looks=["energetic", "cinematic"], dry=True, _rows=rows)
    one = {s["path"] for c in p["videos"][0]["chapters"] for s in c["shots"]}
    two = {s["path"] for c in p["videos"][1]["chapters"] for s in c["shots"]}
    assert one and two and not (one & two), "the highlight and the day part show different shots"
    per_day = {d: sum(s["path"].startswith(f"d{d[-2:]}-") for s in [x for c in p["videos"][0]["chapters"] for x in c["shots"]]) for d in days}
    assert min(per_day.values()) >= 1, "the highlight draws on every day"


def test_extend_adds_a_video_per_extra_look_and_leaves_the_plan_alone(monkeypatch):
    monkeypatch.setattr(vlog, "private_paths", lambda rows=None: {})  # needs the search model; privacy has its own tests
    import copy

    monkeypatch.setattr(vlog, "_concept_matrix", lambda: np.eye(len(vlog.CONCEPTS), dtype="float32"))
    monkeypatch.setattr(vlog, "trip", lambda: {"places": {}, "overlays": {}})
    names = [c[0] for c in vlog.CONCEPTS]
    rng = np.random.default_rng(7)
    rows = []
    for d in range(13, 17):
        for k in range(36):
            e = rng.normal(scale=0.15, size=len(names)).astype("float32")
            e[names.index(["Lions", "Elephants", "Camp life"][k % 3])] += 1.0
            video = k % 2 == 0
            rows.append(({"path": f"d{d}-{k}.{'mp4' if video else 'jpg'}", "kind": "video" if video else "photo", "duration": 14 if video else None,
                          "aesthetic": 6 + rng.random(), "sharp": 40, "junk": 0, "captured": f"2015-09-{d}T10:{k:02d}:00"}, e))
    days = [f"2015-09-{d}" for d in range(13, 17)]
    p = vlog.plan(name="Trip", style="documentary", groups=[days], lengths=[4], looks=["energetic"], dry=True, _rows=rows)
    before = copy.deepcopy(p["videos"])
    x = vlog.extend(dry=True, _rows=rows, _plan=p)
    assert x["videos"][:1] == before, "the videos the plan had are untouched"
    assert x["added"] == [2, 3, 4, 5] and [v["look"] for v in x["videos"][1:]] == vlog.MORE_LOOKS
    guide, mono, slow, road = x["videos"][1:]
    assert {c["title"] for c in guide["chapters"]} == {"Lions", "Elephants"} and all(c["fixed"] for c in guide["chapters"]), "a chapter per animal"
    assert all(s["subject"] == c["title"] for c in guide["chapters"] for s in c["shots"]), "every shot shows its chapter's animal"
    assert all(s["kind"] == "video" for c in slow["chapters"] for s in c["shots"]), "slow safari is clips only"
    assert all(s["subject"] == "Camp life" for c in road["chapters"] for s in c["shots"]), "the road movie leaves the animals out"
    assert vlog.extend(dry=True, _rows=rows, _plan=x)["added"] == [], "asking again adds nothing"
    assert not vlog.LOOKS["slow"]["music"], "slow safari has no music"


def test_a_private_looking_picture_is_held_back_unless_the_person_lets_it_in(monkeypatch, tmp_path):
    """A hospital bed or a passport stays out of every video by default (vlog.private_paths); the trip switch lets it in."""
    import numpy as np

    from studio import library, vlog

    dim = 8
    axes = {p: np.eye(dim, dtype="float32")[k] for k, (_, p) in enumerate(vlog.PRIVATE)}
    monkeypatch.setattr(library, "text_embedding", lambda q: axes.get(q, np.eye(dim, dtype="float32")[7]))
    monkeypatch.setattr(vlog, "_PRIVATE_M", [])
    monkeypatch.setattr(vlog, "_concept_matrix", lambda: np.eye(dim, dtype="float32")[5:7])
    monkeypatch.setattr(vlog, "TRIP_FILE", tmp_path / "trip.json")
    bed = np.eye(dim, dtype="float32")[0] * 0.9 + np.eye(dim, dtype="float32")[5] * 0.3   # a hospital bed, a little like a plain concept
    lion = np.eye(dim, dtype="float32")[5] * 0.9 + np.eye(dim, dtype="float32")[0] * 0.1  # a lion that faintly resembles it
    rows = [({"path": "bed.jpg"}, bed), ({"path": "lion.jpg"}, lion)]
    assert vlog.private_paths(rows) == {"bed.jpg": "hospital"}
    (tmp_path / "trip.json").write_text('{"privateOk": true}', encoding="utf-8")
    assert vlog.private_paths(rows) == {}, "the person lets private pictures in"
