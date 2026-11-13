"""Each version differs on near-ties, a clearly better clip still wins, a seed repeats a version,
and footage from a vouched-for folder counts as ranch footage."""
import random
from pathlib import Path

from studio.activity import _trace_from_roles
from studio.assemble import draw
from studio.config import DATA, trusted_folder


def _scored(*scores):
    return [(s, {"file": f"c{i}.mp4"}) for i, s in enumerate(scores)]


def test_near_ties_are_shared_out():
    picks = {draw(_scored(0.300, 0.299, 0.298, 0.297), random.Random(s)) for s in range(200)}
    assert picks == {0, 1, 2, 3}


def test_a_clearly_better_clip_wins():
    wins = sum(draw(_scored(0.40, 0.25, 0.24, 0.23), random.Random(s)) == 0 for s in range(500))
    assert wins >= 495


def test_the_same_seed_gives_the_same_version_and_zero_variety_takes_the_best():
    a = [draw(_scored(0.3, 0.299, 0.298), random.Random(42)) for _ in range(5)]
    b = [draw(_scored(0.3, 0.299, 0.298), random.Random(42)) for _ in range(5)]
    assert a == b
    assert draw(_scored(0.3, 0.31), random.Random(1), variety=0) == 0


def test_imports_and_listed_folders_are_trusted(monkeypatch):
    monkeypatch.setenv("STUDIO_EXTRA_SOURCES", "X:/ranch photos;Y:/more")  # forward slashes: folders on Windows and on Linux
    assert trusted_folder(Path("X:/ranch photos/deck.jpg"))
    assert trusted_folder(DATA / "imports" / "google-photos" / "20261108" / "a.mp4")
    assert not trusted_folder(Path("X:/ranch photos2/deck.jpg"))
    assert not trusted_folder(Path(r"Z:\trip\beach.jpg"))


def test_the_aesthetic_nudge_is_small_and_capped():
    from studio.aesthetic import nudge

    assert nudge(None) == 0 and nudge(5.0) == 0
    assert nudge(6.0) == 0.01 and nudge(9.5) == 0.02 and nudge(1.0) == -0.02


def test_older_reels_get_a_trace_from_their_shot_notes():
    project = {"shots": [{"src": "2026/a/DJI_1.MP4", "role": "auto: a wide view of mountains (match 0.2876)"},
                         {"src": "2026/b/IMG_2.jpg", "role": "swapped in by hand"}]}
    trace = _trace_from_roles(project)
    assert trace[0]["prompt"] == "a wide view of mountains" and trace[0]["candidates"][0]["match"] == 0.2876
    assert trace[1]["prompt"] == "swapped in by hand" and trace[1]["picked"] == "IMG_2.jpg"
