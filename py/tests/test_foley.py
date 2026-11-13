"""Natural sound for silent shots (studio.ai foley, MMAudio V2 on fal): which shots get it, what it costs, how the run
stores it per shot, and how the mix lays it in at each shot's place (studio.sound.mix, studio.reels.foley_track)."""
import json
import subprocess
from pathlib import Path

import studio.ai as ai
from studio import projects
from studio.config import ffmpeg_bin
from studio.reels import foley_track
from tests.test_ai import env, fal_routes, make_reel, rows, use  # noqa: F401 - the shared fixture and fakes

PRICE = {"endpoint_id": "fal-ai/mmaudio-v2", "unit_price": 0.001, "unit": "seconds"}


def test_only_silent_shots_are_offered_and_priced_by_the_second(env, monkeypatch):  # noqa: F811
    make_reel(env, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "mean_volume", lambda src, start, secs: -62.0 if Path(src).name == "small.mp4" else -24.0)
    monkeypatch.setattr(ai, "fal_prices", lambda models: {m: {**PRICE, "source": "test"} for m in models})
    items = ai.plan("day-test", ["foley"])
    got = {i["target"]: i for i in items}
    assert set(got) == {1, 2}, "the photo and the near-silent clip; the clip with its own sound keeps it"
    assert "a photo" in got[1]["what"] and "almost silent" in got[2]["what"]
    assert got[2]["quantity"] == 2.5 and got[2]["usd"] == 0.0025
    assert ai.plan("day-test", ["foley"], {"shots": {"foley": [2]}})[0]["target"] == 2, "asked-for shots only"


def test_a_run_stores_the_sound_on_its_shot_and_notes_it(env, monkeypatch):  # noqa: F811
    make_reel(env, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    monkeypatch.setattr(ai, "mean_volume", lambda src, start, secs: -24.0)
    (env / "mezz" / "day-test" / "01_t.mp4").write_bytes(b"mezz")
    fake = use(monkeypatch, fal_routes({"fal-ai/mmaudio-v2": {"video": {"url": "https://cdn.example/with_sound.mp4"}}}))
    monkeypatch.setattr(ai, "fal_prices", lambda models: {m: {**PRICE, "source": "test"} for m in models})
    out = ai.run({"slug": "day-test", "tools": ["foley"]})
    p = projects.load("day-test")
    f = p["shots"][1]["ai_foley"]
    assert f["tool"] == "foley" and f["file"].endswith(".m4a") and f["seconds"] == 2.0
    assert "ai_foley" not in p["shots"][0], "a shot with its own sound is left alone"
    note = [n for n in p["ai"] if n["tool"] == "foley"][0]
    assert note["label_required"] is False and "MMAudio" in note["licence"] and out["applied"][0]["tool"] == "foley"
    body = fake.find("queue.fal.run/fal-ai/mmaudio-v2")[0]["body"]
    assert "No music, no voices" in body["prompt"] and "speech" in body["negative_prompt"] and body["duration"] == 2.0
    assert [r["purpose"] for r in rows()] == ["ai-foley"]
    again = ai.estimate({"slug": "day-test", "tools": ["foley"]})
    assert again["total"] == 0 and again["tools"][0]["items"][0]["cached"], "made once per shot: the next run is free"


def test_the_track_follows_the_shots_and_the_mix_lays_it_in(tmp_path, monkeypatch):
    from studio import sound

    ff = str(ffmpeg_bin())
    clip, bed = tmp_path / "clip.mp4", tmp_path / "bed.m4a"
    subprocess.run([ff, "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)],
                   check=True, capture_output=True, timeout=60)
    subprocess.run([ff, "-y", "-f", "lavfi", "-i", "anoisesrc=d=2:c=pink:a=0.2", "-ac", "2", "-c:a", "aac", str(bed)], check=True, capture_output=True, timeout=60)
    reel = {"shots": [{"src": "a.mp4", "sec": 1.5}, {"src": "b.jpg", "sec": 2.5, "ai_foley": {"file": str(bed), "seconds": 2.0}}]}
    track = foley_track(reel)
    assert track == [{"file": str(bed), "at": 1.5, "seconds": 2.0, "gain": 0.8}]
    seen = []
    real = subprocess.run

    def spy(cmd, *a, **k):
        if "-filter_complex" in cmd:
            seen.append(cmd[cmd.index("-filter_complex") + 1])
        return real(cmd, *a, **k)
    monkeypatch.setattr(sound.subprocess, "run", spy)
    sound.mix(clip, tmp_path / "plain.mp4", 4.0, None, [])
    plain = seen[-1]
    sound.mix(clip, tmp_path / "plain2.mp4", 4.0, None, [], foley=[])
    assert seen[-1] == plain, "without foley the graph is exactly the old one"
    rec = sound.mix(clip, tmp_path / "foley.mp4", 4.0, None, [], foley=track)
    g = seen[-1]
    assert "adelay=1500|1500[fo1]" in g and "[cliprw][fo1]amix" in g and rec["foley"]["shots"] == 1
    meter = real([ff, "-i", str(tmp_path / "foley.mp4"), "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, timeout=60).stderr
    assert "mean_volume" in meter and float(meter.split("mean_volume:")[1].split("dB")[0]) > -60, "the silent clip now has sound"
    assert json.dumps(rec)


def test_saving_keeps_each_shots_foley(tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "DIR", tmp_path)
    projects.save({"slug": "r-1", "shots": [{"src": "b.jpg", "sec": 2, "ai_foley": {"file": "f.m4a", "seconds": 2}}]})
    got = projects.keep_ai({"slug": "r-1", "shots": [{"src": "x.mp4", "sec": 1}, {"src": "b.jpg", "sec": 2}]})
    assert got["shots"][1]["ai_foley"]["file"] == "f.m4a" and "ai_foley" not in got["shots"][0]
