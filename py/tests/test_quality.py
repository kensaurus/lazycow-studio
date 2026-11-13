"""studio.quality and what a long video does with it: wind found and turned down, blurry and shaky pictures left out,
music that covers the whole film (and a build that refuses to go out silent), captions checked against their frames.
A trip series (13 Nov) went out with wind at full volume, no music, blurry photos and captions nobody checked."""
import json
from pathlib import Path

import numpy as np
import pytest

from studio import quality, vlog

RATE = 16000


def _noise_low(sec=4.0, seed=1):
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 0.2, int(RATE * sec)).astype(np.float32)
    k = np.ones(200) / 200  # a moving average: energy far under 150 Hz, like wind on a microphone
    return np.convolve(x, k, mode="same").astype(np.float32) * 8


def _tone(f=1000.0, sec=4.0):
    t = np.arange(int(RATE * sec)) / RATE
    return (0.1 * np.sin(2 * np.pi * f * t)).astype(np.float32)


def test_wind_is_found_in_rumble_and_not_in_a_clean_sound():
    w = quality.wind_of(_noise_low())
    assert w["low"] > 0.5 and quality.windy(w)
    c = quality.wind_of(_tone())
    assert c["low"] < 0.05 and not quality.windy(c)
    assert not quality.windy({"low": 0.9, "gust": 0.9, "db": -60}), "near silence is not wind worth fixing"


def test_a_windy_clip_with_nobody_speaking_is_turned_down_and_with_speech_is_cleaned():
    windy = {"low": 0.3, "gust": 0.7, "db": -25}
    assert quality.cleanup(windy, False)["gain"] < 0.2
    spoken = quality.cleanup(windy, True)
    assert spoken["gain"] == 1.0 and "highpass=f=160" in spoken["filter"] and "afftdn" in spoken["filter"]
    unknown = quality.cleanup(windy, None)
    assert unknown["gain"] == 1.0, "never transcribed: cleaned, never silenced (someone may be speaking)"
    calm = quality.cleanup({"low": 0.02, "gust": 0.1, "db": -22}, False)
    assert calm["gain"] == 1.0 and calm["tag"] == "c"


def test_peak_sharpness_sees_a_sharp_subject_on_a_soft_background():
    import cv2

    rng = np.random.default_rng(3)
    soft = cv2.GaussianBlur((rng.random((480, 640)) * 255).astype(np.uint8), (31, 31), 0)
    subject = soft.copy()
    subject[180:300, 260:380] = (rng.random((120, 120)) * 255).astype(np.uint8)  # a sharp animal in the middle
    blurred = cv2.GaussianBlur(subject, (31, 31), 0)
    assert quality.peak_sharp([subject]) > 10 * quality.peak_sharp([blurred])


def test_blurry_and_shaky_pictures_are_left_out_by_the_trips_own_floors(monkeypatch, tmp_path):
    items = [{"path": str(tmp_path / f"p{i}.jpg"), "kind": "photo", "sharp": float(100 + 10 * i)} for i in range(40)]
    cache = {quality._key(it["path"]): {"peak": float(200 + 20 * i)} for i, it in enumerate(items)}
    clip = {"path": str(tmp_path / "shaky.mp4"), "kind": "video", "sharp": 900.0}
    cache[quality._key(clip["path"])] = {"peak": 2000.0, "shake": 0.7}
    monkeypatch.setattr(quality, "_cache", cache)
    fl = quality.floors(items)
    assert quality.why_not(items[0], fl) == "blurry", "the trip's softest picture on both measures"
    assert quality.why_not(items[-1], fl) is None
    soft_bg = dict(items[1])
    cache[quality._key(soft_bg["path"])] = {"peak": 5000.0}
    assert quality.why_not(soft_bg, fl) is None, "a soft frame with a sharp subject stays"
    assert quality.why_not(clip, fl) == "shaky"
    assert quality.why_not({"path": str(tmp_path / "new.jpg"), "kind": "photo", "sharp": 0}, fl) is None, "unmeasured: usable"
    sunset = {**items[0], "aesthetic": 6.0}
    fl_aes = {**fl, "aes": 5.7}
    assert quality.why_not(sunset, fl_aes) is None, "a smooth sunset the aesthetic model rates highly is not blur"
    assert quality.why_not({**items[0], "aesthetic": 5.1}, fl_aes) == "blurry"


def test_music_covers_the_whole_film_from_paid_pieces_and_free_tracks(monkeypatch, tmp_path):
    """The AI limit refused new pieces: the pieces this video already paid for and free CC0 tracks fill it, crossfaded."""
    monkeypatch.setattr(vlog, "OUT", tmp_path)
    from studio import ai

    monkeypatch.setattr(ai, "status", lambda *a, **k: {"ready": False})
    folder = tmp_path / "vlog-9" / "music"
    folder.mkdir(parents=True)
    old = folder / "vlog_vlog-9_0_aaaa.wav"
    old.write_bytes(b"x")
    free = tmp_path / "free.mp3"
    free.write_bytes(b"x")
    secs = {str(old): 150.0, str(free): 200.0}
    monkeypatch.setattr(vlog, "_audio_sec", lambda p: secs.get(str(p), 0.0))
    monkeypatch.setattr(vlog, "_free_music", lambda need: [{"file": str(free), "title": "Folk", "creator": "A", "license": "CC0",
                                                             "attribution": "\"Folk\" by A is marked with CC0 1.0."}])
    ran = {}
    monkeypatch.setattr(vlog.subprocess, "run", lambda cmd, **k: ran.setdefault("cmd", cmd))
    bed = vlog.music_beds("vlog-9", 600.0)
    assert bed == folder / "bed.wav"
    pieces = json.loads((folder / "bed.json").read_text(encoding="utf-8"))["pieces"]
    assert [p["license"] for p in pieces] == ["AI-GENERATED", "CC0"]
    inputs = [ran["cmd"][i + 1] for i, a in enumerate(ran["cmd"]) if a == "-i"]
    assert sum(secs[f] for f in inputs) - 6 * (len(inputs) - 1) >= 600, "the bed covers all 600 s (repeated only as a last resort)"
    assert "Music: AI-generated" in vlog._music_line({"slug": "vlog-9"}) and "CC0" in vlog._music_line({"slug": "vlog-9"})
    assert vlog.BED_EQ in " ".join(map(str, ran["cmd"])), "the bed loses its sub-bass rumble"


def test_captions_the_frame_does_not_show_are_dropped_and_titles_fixed(monkeypatch, tmp_path):
    props = {"overlays": [{"kind": "subject", "atSec": 10, "sec": 2.3, "title": "Lion", "sub": "simba in Swahili"},
                          {"kind": "subject", "atSec": 30, "sec": 2.3, "title": "Monkeys"},
                          {"kind": "note", "atSec": 50, "sec": 5, "title": "A rhinoceros lies near a wooded camp."}],
             "chapters": [{"title": "Rhinoceros and Acacia Camp Masai Mara", "atSec": 0}]}
    chapters = [{"title": "Rhinoceros and Acacia Camp Masai Mara", "atSec": 0, "dayNo": 3}]
    monkeypatch.setattr(vlog, "_frame_at", lambda shots, t, dest: dest)
    from studio import ai

    seen = {}

    def fake(images, system, prompt, slug, purpose, max_tokens):
        seen["prompt"], seen["n"] = prompt, len(images)
        return {"verdicts": [{"n": 1, "true": True}, {"n": 2, "true": False}, {"n": 3, "true": False},
                             {"n": 4, "true": False, "fix": "A rhino resting in the bush"}]}
    monkeypatch.setattr(ai, "vision_json", fake)
    r = vlog.check_captions(props, chapters, [(0.0, tmp_path / "a.mp4")], "vlog-2", tmp_path, ["Masai Mara National Reserve"])
    assert r == {"checked": 4, "dropped": 2, "fixed": 1}
    assert [o["title"] for o in props["overlays"]] == ["Lion"]
    assert chapters[0]["title"] == props["chapters"][0]["title"] == "A rhino resting in the bush"
    assert "Masai Mara National Reserve" in seen["prompt"] and seen["n"] == 4
    assert vlog._wildlife_line({"slug": "-"}) == "", "no props, no list"


def test_captions_are_left_alone_and_said_unchecked_without_a_key(monkeypatch, tmp_path):
    props = {"overlays": [{"kind": "subject", "atSec": 10, "sec": 2.3, "title": "Lion"}], "chapters": []}
    monkeypatch.setattr(vlog, "_frame_at", lambda shots, t, dest: dest)
    from studio import ai

    def refuse(*a, **k):
        raise RuntimeError("no AI key")
    monkeypatch.setattr(ai, "vision_json", refuse)
    r = vlog.check_captions(props, [], [(0.0, Path("a.mp4"))], "vlog-2", tmp_path, [])
    assert r["checked"] == 0 and "no AI key" in r["error"] and len(props["overlays"]) == 1


@pytest.mark.parametrize("segs,want", [([{"start": 1, "end": 3, "text": "look at that"}], True),
                                       ([{"start": 20, "end": 22, "text": "later"}], False), ([], False)])
def test_speech_in_a_stretch_of_a_clip_comes_from_the_speech_cache(monkeypatch, tmp_path, segs, want):
    from studio import speech

    monkeypatch.setattr(speech, "CACHE", tmp_path)
    src = Path("MVI_0001.MP4")
    (tmp_path / f"{speech._key(src, 30.0)}.json").write_text(json.dumps({"segments": segs}), encoding="utf-8")
    assert vlog._speech_in(src, 0.0, 5.0, 30.0) is want
    assert vlog._speech_in(Path("never.MP4"), 0.0, 5.0, 30.0) is None


def test_each_chapter_card_gets_a_soft_whoosh_and_the_end_card_a_riser(monkeypatch, tmp_path):
    from studio import sound

    monkeypatch.setattr(sound, "LIB", tmp_path)
    (tmp_path / "sfx").mkdir()
    for n in ("whoosh_1", "whoosh_2", "whoosh_3", "riser"):
        (tmp_path / "sfx" / f"synth_{n}.wav").write_bytes(b"x")
    fx = vlog.chapter_sfx([{"atSec": 0.0}, {"atSec": 60.0}, {"atSec": 200.0}], 580.0)
    assert [(f["name"], f["at"]) for f in fx] == [("whoosh", 59.55), ("whoosh", 199.55), ("riser", 578.8)], "none on the very first frame"
    assert all(f["gain"] <= 0.22 for f in fx), "quieter than a reel's"


def test_captions_are_checked_in_batches_and_one_bad_reply_is_tried_again(monkeypatch, tmp_path):
    props = {"overlays": [{"kind": "subject", "atSec": 10 + k, "sec": 2, "title": f"Animal {k}"} for k in range(10)], "chapters": []}
    monkeypatch.setattr(vlog, "_frame_at", lambda shots, t, dest: dest)
    from studio import ai

    calls = []

    def flaky(images, system, prompt, slug, purpose, max_tokens):
        calls.append(len(images))
        if len(calls) == 1:
            raise RuntimeError("The vision model sent back no JSON.")
        return {"verdicts": [{"n": n + 1, "true": n != 0} for n in range(len(images))]}
    monkeypatch.setattr(ai, "vision_json", flaky)
    r = vlog.check_captions(props, [], [(0.0, tmp_path / "a.mp4")], "vlog-2", tmp_path, [])
    assert calls == [8, 8, 2], "8 a call; the first, with no JSON, tried again"
    assert r["checked"] == 10 and r["dropped"] == 2, "the first line of each batch was false"


def test_a_chapter_title_is_judged_on_its_whole_chapter_not_one_frame(monkeypatch, tmp_path):
    """One frame renamed "Lions and a Buffalo Calf" (four minutes) to "Guineafowl in Grass"."""
    sheet = tmp_path / "chapter-0.jpg"
    sheet.write_bytes(b"x")
    chapters = [{"title": "Lions and a Buffalo Calf", "atSec": 12.0, "dayNo": 3}]
    props = {"overlays": [], "chapters": [{"title": "Lions and a Buffalo Calf", "atSec": 12.0}]}
    monkeypatch.setattr(vlog, "_frame_at", lambda shots, t, dest: dest)
    from studio import ai

    seen = {}

    def fake(images, system, prompt, slug, purpose, max_tokens):
        seen["images"], seen["prompt"] = images, prompt
        return {"verdicts": [{"n": 1, "true": True}]}
    monkeypatch.setattr(ai, "vision_json", fake)
    r = vlog.check_captions(props, chapters, [(0.0, tmp_path / "a.mp4")], "vlog-2", tmp_path, [], [sheet])
    assert seen["images"] == [sheet] and "contact sheet of the whole chapter" in seen["prompt"]
    assert r == {"checked": 1, "dropped": 0, "fixed": 0} and chapters[0]["title"] == "Lions and a Buffalo Calf"


def test_360_moments_join_their_own_day_once_each_and_raw_files_wait_for_a_stitch(monkeypatch):
    """No 360 shot reached the trip series (13 Nov): the picker leaves 360 files out, so with_360 adds them by day."""
    monkeypatch.setattr(vlog, "_quality_no", lambda it: None)
    lib = {p: {"path": p, "kind": k, "is360": True, "captured": d, "duration": dur} for p, k, d, dur in [
        ("C:/f/hot-air.mp4", "video", "2025-05-15T05:00:00", 120.0),
        ("C:/f/VID_1.insv", "video", "2025-05-15T05:00:00", 600.0),          # raw: needs Insta360 Studio's stitch
        ("C:/f/IMG_9.jpg", "photo", "2025-05-15T06:00:00", 0),
        ("C:/f/IMG_9_PureShot.jpg", "photo", "2025-05-15T06:00:00", 0),    # the same photo, the camera's enhanced copy
        ("C:/f/IMG_9.dng", "photo", "2025-05-15T06:00:00", 0),
        ("C:/f/IMG_7.jpg", "photo", "2025-05-16T06:00:00", 0),              # another day
    ]}
    video = {"chapters": [{"day": "2025-05-15", "shots": [{"path": f"C:/f/a{k}.jpg", "kind": "photo", "sec": 3.0} for k in range(6)]}]}
    assert vlog.with_360(video, lib) == 2
    added = [s for s in video["chapters"][0]["shots"] if s.get("is360")]
    assert [s["path"] for s in added] == ["C:/f/hot-air.mp4", "C:/f/IMG_9_PureShot.jpg"]
    assert added[0]["move"] == ["unroll", 1] and added[1]["move"] == ["planet", 1]
    assert video["chapters"][0]["shots"][0]["path"] == "C:/f/a0.jpg", "never the very first shot of a chapter"
    assert not vlog.sphere_ok(lib["C:/f/VID_1.insv"])
