"""The picker really reads frames (an ffmpeg flag change once made it fall back silently)."""
import subprocess

from studio.config import ffmpeg_bin
from studio.pick import best_window


def test_picker_reads_frames(tmp_path):
    clip = tmp_path / "t.mp4"
    subprocess.run(
        [str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)],
        check=True, capture_output=True,
    )
    pick = best_window(clip, 1.5)
    assert pick["method"] == "4 fps"
    assert pick["score"] is not None
    assert 0.3 <= pick["start"] <= 6 - 1.5 - 0.3


def test_a_moment_shown_elsewhere_is_left_for_another_one(tmp_path):
    """Two videos of one trip that both use a clip show different moments of it, not the same best one twice."""
    clip = tmp_path / "t.mp4"
    subprocess.run(
        [str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)],
        check=True, capture_output=True,
    )
    first = best_window(clip, 3.0)
    again = best_window(clip, 3.0, avoid=[(first["start"], first["start"] + 3.0)])
    assert again["free"] == first["start"], "without the shown moment it would have been the same window"
    assert again["start"] + 3.0 <= first["start"] + 0.05 or again["start"] >= first["start"] + 3.0 - 0.05, (first, again)
    full = best_window(clip, 3.0, avoid=[(0.0, 12.0)])
    assert full["start"] is not None, "every moment shown: still a window (the least repeated)"


def test_a_stretch_that_does_not_show_the_shots_picture_idea_is_left_out(tmp_path):
    """MVI_8180 was picked for its deck, but its busiest stretch was a drive through town, which then played under
    "no buildings outside the window". With the picture idea, only stretches that look like it are picked."""
    clip = tmp_path / "t.mp4"
    subprocess.run(
        [str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)],
        check=True, capture_output=True,
    )
    plain = best_window(clip, 2.0)
    # Say the deck is only in the first 4 s; the rest (wherever the plain pick went) looks like something else.
    times = [0.5 * k + 0.25 for k in range(24)]
    sims = [0.30 if t < 4.0 else 0.20 for t in times]
    fitted = best_window(clip, 2.0, prompt="a wooden deck", fit=(times, sims))
    assert fitted["start"] + 2.0 <= 4.0 + 0.3, fitted
    assert fitted["fit"] == "a wooden deck"
    same = best_window(clip, 2.0, prompt="a wooden deck", fit=(times, [0.25] * len(times)))
    assert same["start"] == plain["start"], "a clip that looks the same all through keeps its sharpest moment"
