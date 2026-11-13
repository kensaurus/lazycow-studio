"""Gap-fill stays dry, and a beat track without a license is refused."""
from pathlib import Path

from studio.extras import beat_track, gap_fill


def test_gap_is_dry():
    result = gap_fill("a quiet deck at dusk, no people", confirm=False)
    assert result["dry"] is True
    assert result["ok"] is False


def test_gap_blocks_invented_sky():
    result = gap_fill("the Milky Way over the ridge", confirm=True)
    assert result["ok"] is False


def test_beats_need_a_license(tmp_path: Path):
    audio = tmp_path / "bed.wav"
    audio.write_bytes(b"")
    result = beat_track(audio)
    assert result["ok"] is False
