"""Music and effects: placement follows the captions, choice honours the reel, the mix keeps the picture."""
import json
import subprocess

from studio.config import SPEC, ffmpeg_bin, ffprobe_bin
from studio.sound import LIB, choose_music, fit_cuts, mix, sfx_plan, synth

REEL = {
    "slug": "office-test",
    "beats": [
        {"kind": "hook", "startSec": 0.1, "endSec": 3.3},
        {"kind": "line", "startSec": 3.6, "endSec": 5.8},
        {"kind": "line", "startSec": 6.1, "endSec": 8.3},
        {"kind": "end", "startSec": 12.1, "endSec": 15.0},
    ],
    "shots": [{"sec": 15.0}],
}


def _music(seconds=30):
    folder = LIB / "music"
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / "test_tone.mp3"
    if not dest.exists():
        subprocess.run([str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}", "-ac", "2", str(dest)],
                       check=True, capture_output=True, timeout=60)
        meta = {"kind": "music", "title": "Test tone", "creator": "test", "license": "CC0", "duration": seconds, "query": "calm piano"}
        dest.with_suffix(".mp3.json").write_text(json.dumps(meta), encoding="utf-8")
    return dest


def test_shot_lengths_land_on_the_beats():
    beats = [i * 0.5 for i in range(1, 40)]
    lengths = fit_cuts(beats, 9)
    assert lengths and len(lengths) == 9
    assert all(1 <= step <= 3 for step in lengths)
    t = 0.0
    for step in lengths:
        t = round(t + step, 2)
        assert any(abs(t - b) < 1e-6 for b in beats)
    assert fit_cuts([1, 2, 3], 9) is None


def test_a_face_blur_names_its_output():
    from studio.shot import blur_graph

    piece, last = blur_graph([(10, 20, 40, 40), (100, 80, 32, 32)])
    assert "boxblur" in piece and last == "b1"


def test_effects_peak_on_the_caption_cuts():
    plan = sfx_plan(REEL)
    names = [p["name"] for p in plan]
    assert names == ["whoosh_1", "whoosh_2", "riser", "hit"]
    assert plan[0]["at"] == round(3.6 - 0.1 - 0.42, 2)  # rises into the cut, peaks on it
    assert plan[2]["at"] == round(12.1 - 1.2, 2) and plan[3]["at"] == 12.1
    assert sfx_plan({**REEL, "sfx": False}) == []


def test_music_choice_follows_the_reel():
    _music()
    auto = choose_music(REEL, 15.0)
    assert auto and auto["license"] == "CC0" and auto["start"] == 0.0
    assert choose_music({**REEL, "music": "off"}, 15.0) is None
    picked = choose_music({**REEL, "music": {"id": "test_tone.mp3", "volume": 0.8, "start": 2}}, 15.0)
    assert picked["volume"] == 0.8 and picked["start"] == 2.0
    assert choose_music({**REEL, "music": {"id": "missing.mp3"}}, 15.0) is None


def test_mix_copies_the_picture_and_lands_on_the_loudness_target(tmp_path):
    synth()
    clip = tmp_path / "clip.mp4"
    subprocess.run([str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)],
                   check=True, capture_output=True, timeout=60)
    reel = {**REEL, "beats": [{"kind": "hook", "startSec": 0.1, "endSec": 1.5}, {"kind": "line", "startSec": 1.6, "endSec": 2.4}, {"kind": "end", "startSec": 2.5, "endSec": 4.0}]}
    out = tmp_path / "scored.mp4"
    record = mix(clip, out, 4.0, choose_music(reel, 4.0) or {"file": str(_music()), "start": 0, "volume": 1.0}, sfx_plan(reel))
    assert record["sfx"] and record["music"]
    probe = json.loads(subprocess.run([str(ffprobe_bin()), "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,nb_read_frames",
                                       "-of", "json", str(out)], capture_output=True, text=True, timeout=60).stdout)
    kinds = {s["codec_type"]: s for s in probe["streams"]}
    assert kinds["video"]["nb_read_frames"] == "120" and kinds["audio"]["codec_name"] == "aac"
    meter = subprocess.run([str(ffmpeg_bin()), "-i", str(out), "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True, timeout=60).stderr
    lufs = float([ln for ln in meter.splitlines() if ln.strip().startswith("I:")][-1].split()[1])
    assert abs(lufs - SPEC["loudnessLufs"]) < 2.0


def test_a_quiet_mix_is_trimmed_onto_the_target(tmp_path):
    """One-pass loudnorm lands under target on short reels; trim_loudness moves the finished mix onto it."""
    from studio.sound import trim_loudness
    from studio.verify import parse_ebur128

    ff = str(ffmpeg_bin())
    quiet = tmp_path / "quiet.mp4"
    subprocess.run([ff, "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=6", "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=0.5",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(quiet)], check=True, capture_output=True, timeout=60)
    target = SPEC["loudnessLufs"]
    gain = trim_loudness(quiet, target)
    err = subprocess.run([ff, "-hide_banner", "-nostats", "-i", str(quiet), "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True, timeout=60).stderr
    got = parse_ebur128(err)
    assert gain > 1 and abs(got["lufs"] - target) < 0.8 and got["truePeak"] <= -1.0
    assert trim_loudness(quiet, target) == 0.0, "already on target: left alone"


def test_a_hot_mix_on_its_level_is_brought_under_the_peak_limit(tmp_path):
    """A mix on its loudness target can still peak over -1 dBTP after AAC (three long films did): the overshoot comes off."""
    from studio.sound import PEAK_SAFE, trim_loudness
    from studio.verify import parse_ebur128

    ff = str(ffmpeg_bin())
    hot = tmp_path / "hot.mp4"
    # A quiet tone with short loud bursts: on its own level, but peaking near full scale.
    subprocess.run([ff, "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=8", "-f", "lavfi",
                    "-i", r"aevalsrc=0.08*sin(2*PI*440*t)+if(lt(mod(t\,1)\,0.01)\,0.97*sin(2*PI*3000*t)\,0):d=8:s=48000",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(hot)], check=True, capture_output=True, timeout=60)
    def read():
        err = subprocess.run([ff, "-hide_banner", "-nostats", "-i", str(hot), "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True, timeout=60).stderr
        return parse_ebur128(err)
    before = read()
    assert before["truePeak"] > -1.0, before
    trim_loudness(hot, before["lufs"])  # on its own level already: only the peak is wrong
    after = read()
    assert after["truePeak"] <= PEAK_SAFE + 0.1, after
    assert before["lufs"] - after["lufs"] < 3.5, "only the overshoot came off, never more"


def test_loudness_is_read_from_a_clip_with_japanese_in_its_name_and_tags(tmp_path):
    """ffmpeg's report quotes the file name and tags; read in the Windows code page it came back as None."""
    from studio.ai import mean_volume
    from studio.sound import trim_loudness

    ff = str(ffmpeg_bin())
    clip = tmp_path / "嬬恋の焚き火.mp4"
    subprocess.run([ff, "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=4", "-f", "lavfi", "-i", "anoisesrc=d=4:c=pink:a=0.5",
                    "-shortest", "-metadata", "title=焚き火の音", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(clip)],
                   check=True, capture_output=True, timeout=60)
    assert mean_volume(clip, 0.0, 3.0) is not None
    assert trim_loudness(clip, SPEC["loudnessLufs"]) != 0.0, "measured, so the level was trimmed"
