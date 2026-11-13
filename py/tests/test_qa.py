"""The quality gate: stderr parsers on captured ffmpeg output, the checks, and one real pass on a lavfi clip."""
import subprocess

from studio import verify
from studio.config import ffmpeg_bin

# Captured from the studio's ffmpeg (N-128532, Nov 2026): one pass of blackdetect + freezedetect + ebur128 + silencedetect
# over a 5 s clip (1 s black, 1 s testsrc, 3 s still red) with a silent track.
SILENT = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'syn.mp4':
  Duration: 00:00:05.00, start: 0.000000, bitrate: 28 kb/s
[Parsed_silencedetect_3 @ 000001a85b010ec0] silence_start: 0
[Parsed_blackdetect_0 @ 000001a85b0111c0] black_start:0 black_end:1 black_duration:1
[Parsed_freezedetect_1 @ 000001a85b0110c0] lavfi.freezedetect.freeze_start: 2
[Parsed_silencedetect_3 @ 000001a85b010ec0] silence_end: 5 | silence_duration: 5
[Parsed_ebur128_2 @ 000001a85b0112c0] Summary:

  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:       -inf dBFS
"""

# A finished house master (aerial-1107-cube, 9:16): nothing found, the mix at -14.5 LUFS / -1.5 dBTP.
CLEAN = """  Duration: 00:00:15.00, start: 0.000000, bitrate: 1240 kb/s
[Parsed_ebur128_2 @ 000001e7e1ed6100] Summary:

  Integrated loudness:
    I:         -14.5 LUFS
    Threshold: -24.8 LUFS

  Loudness range:
    LRA:         2.4 LU
    Threshold: -34.7 LUFS
    LRA low:   -15.8 LUFS
    LRA high:  -13.4 LUFS

  True peak:
    Peak:       -1.5 dBFS
"""

# freezedetect with a closed run, two black runs (one inside the end card's last 1.5 s).
RUNS = """  Duration: 00:00:18.80, start: 0.000000, bitrate: 900 kb/s
[Parsed_blackdetect_0 @ 0] black_start:4.2 black_end:4.9 black_duration:0.7
[Parsed_freezedetect_1 @ 0] lavfi.freezedetect.freeze_start: 6.5
[Parsed_freezedetect_1 @ 0] lavfi.freezedetect.freeze_duration: 3.1
[Parsed_freezedetect_1 @ 0] lavfi.freezedetect.freeze_end: 9.6
[Parsed_silencedetect_3 @ 0] silence_start: 2.25
[Parsed_silencedetect_3 @ 0] silence_end: 3.5 | silence_duration: 1.25
[Parsed_blackdetect_0 @ 0] black_start:17.4 black_end:18.8 black_duration:1.4
"""


def test_duration_and_loudness_are_read_from_stderr():
    assert verify.parse_duration(SILENT) == 5.0
    assert verify.parse_duration(RUNS) == 18.8
    assert verify.parse_ebur128(CLEAN) == {"lufs": -14.5, "truePeak": -1.5}
    assert verify.parse_ebur128(SILENT) == {"lufs": -70.0, "truePeak": None}  # -inf is no peak, not a number
    assert verify.parse_ebur128("no summary here") == {"lufs": None, "truePeak": None}


def test_runs_are_paired_and_an_open_run_closes_at_the_end():
    assert verify.parse_black(SILENT) == [(0.0, 1.0)]
    assert verify.parse_black(RUNS) == [(4.2, 4.9), (17.4, 18.8)]
    assert verify.parse_freeze(RUNS, 18.8) == [(6.5, 9.6)]
    assert verify.parse_freeze(SILENT, 5.0) == [(2.0, 5.0)]  # still frozen when the file ended
    assert verify.parse_silence(SILENT, 5.0) == [(0.0, 5.0)]
    assert verify.parse_silence(RUNS, 18.8) == [(2.25, 3.5)]
    assert verify.parse_black(CLEAN) == [] and verify.parse_freeze(CLEAN, 15.0) == []


def test_black_ignores_the_end_card_fade_and_short_dips():
    assert verify.black_check([(4.2, 4.9)], 18.8)["level"] == "bad"
    assert verify.black_check([(17.4, 18.8)], 18.8)["level"] == "ok"  # inside the last 1.5 s
    assert verify.black_check([(16.9, 18.8)], 18.8)["level"] == "bad"  # starts 0.4+ s before the fade window
    assert verify.black_check([(3.0, 3.3)], 18.8)["level"] == "ok"  # 0.3 s: a cut, not a black shot


def test_freeze_is_only_a_warning():
    assert verify.freeze_check([(6.5, 9.6)])["level"] == "warn"
    assert verify.freeze_check([(6.5, 8.5)])["level"] == "ok"


def test_loudness_peak_and_silence_levels():
    assert verify.loudness_check(-14.5)["level"] == "ok"
    assert verify.loudness_check(-12.4)["level"] == "warn"
    assert verify.loudness_check(-19.0)["level"] == "bad"
    assert verify.loudness_check(None)["level"] == "bad"
    assert verify.peak_check(-1.5)["level"] == "ok"
    assert verify.peak_check(-0.4)["level"] == "warn"
    assert verify.peak_check(0.6)["level"] == "bad"
    assert verify.silence_check([(0.0, 5.0)], 5.0, music=True)["level"] == "bad"
    assert verify.silence_check([(0.0, 5.0)], 5.0, music=False)["level"] == "warn"
    assert verify.silence_check([(2.25, 3.5)], 18.8, music=True)["level"] == "ok"
    for row in (verify.black_check([(4.2, 4.9)], 18.8), verify.loudness_check(-19.0)):
        assert set(row) == {"id", "level", "found", "fix"} and row["fix"]


def test_qa_finds_a_black_second_in_a_real_render(tmp_path):
    clip = tmp_path / "reel_9x16.mp4"
    subprocess.run(
        [str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=1",
         "-f", "lavfi", "-i", "testsrc=s=1080x1920:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
         "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-map", "2:a",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ar", "48000", "-t", "3", str(clip)],
        check=True, capture_output=True, timeout=120,
    )
    res = verify.qa(clip, music=True)
    by = {c["id"]: c for c in res["checks"]}
    assert res["measured"]["aspect"] == "9x16"
    assert by["format"]["level"] == "ok"
    assert by["black"]["level"] == "bad" and "0.0-1.0 s" in by["black"]["found"]
    assert by["silence"]["level"] == "ok"
    assert res["ok"] is False
    assert abs(res["measured"]["durationSec"] - 3.0) < 0.1
