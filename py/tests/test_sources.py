"""Footage folders: formats, the 360 guess, the registry (trusted vs GPS-placed), browsing a
folder, a discovery report that skips studio outputs and graphics, and HEIC / RAW sizes."""
import json
from pathlib import Path

import pytest

from studio import config, media, sources


@pytest.fixture()
def data(tmp_path, monkeypatch):
    home = tmp_path / "data"
    home.mkdir()
    monkeypatch.setattr(config, "DATA", home)
    monkeypatch.setattr(sources, "DATA", home)
    monkeypatch.setattr(sources, "REGISTRY", home / "sources.json")
    monkeypatch.setattr(sources, "STATE", home / "sources_state.json")
    monkeypatch.setattr(sources, "_catalogued", lambda: set())
    monkeypatch.delenv("STUDIO_EXTRA_SOURCES", raising=False)
    return home


def _touch(path: Path, size: int = 10) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    return path


def test_formats_cover_phone_camera_raw_and_360():
    for ext in (".heic", ".avif", ".dng", ".cr3", ".insp", ".tif"):
        assert ext in media.PHOTO
    assert ".insv" in media.VIDEO and ".png" in media.STILL and ".png" not in media.PHOTO
    assert sources.kind_of(Path("a.NEF")) == "raw" and sources.kind_of(Path("a.MOV")) == "video"
    assert sources.kind_of(Path("notes.txt")) is None
    assert sources.looks_360(Path("VID_20250807_124951_00_041.insv"))
    assert sources.looks_360(Path("X:/insta360/IMG_1.jpg"))  # forward slashes: a folder on Windows and on Linux
    assert not sources.looks_360(Path("IMG_20261102_154607.jpg"))


def test_a_trusted_folder_counts_as_ranch_and_a_gps_folder_does_not(data, tmp_path):
    ranch, trip = tmp_path / "ranch", tmp_path / "trip"
    ranch.mkdir(), trip.mkdir()
    sources.add(str(ranch), "trusted")
    sources.add(str(trip), "gps")
    assert config.trusted_folder(ranch / "a.jpg")
    assert not config.trusted_folder(trip / "a.jpg")
    assert {Path(p) for p in config.extra_sources()} >= {ranch, trip}
    sources.add(str(trip), "trusted")  # re-adding replaces, never duplicates
    assert len(json.loads((data / "sources.json").read_text())) == 2
    assert sources.remove(str(trip)) == {"removed": 1}
    with pytest.raises(ValueError):
        sources.add(str(tmp_path / "missing"), "gps")
    with pytest.raises(ValueError):
        sources.add(str(ranch), "everything")


def test_browsing_shows_subfolders_and_media_but_not_system_folders(data, tmp_path):
    root = tmp_path / "drive"
    _touch(root / "a.jpg"), _touch(root / "b.MP4"), _touch(root / "c.txt")
    (root / "2026").mkdir(), (root / "$RECYCLE.BIN").mkdir(), (root / ".git").mkdir()
    out = sources.listdir(str(root))
    assert out["media"] == 2 and [d["name"] for d in out["dirs"]] == ["2026"]
    assert out["parent"] == str(tmp_path)


def test_discovery_counts_what_would_be_added_and_skips_outputs_and_graphics(data, tmp_path):
    root = tmp_path / "phone"
    _touch(root / "DCIM" / "IMG_20261102_154607.jpg", 100)
    _touch(root / "DCIM" / "VID_20261102_154607.mp4", 300)
    _touch(root / "DCIM" / "IMG_20261102_154700.dng")
    _touch(root / "insta360" / "IMG_20250807_124951_00_041.insp")
    _touch(root / "drafts" / "fire_reel_9x16.mp4")  # a studio output
    _touch(root / "logo.png")  # a graphic
    r = sources.discover(str(root))
    assert r["total"] == 4 and r["kinds"] == {"photo": 2, "video": 1, "raw": 1}
    assert r["outputs"] == 1 and r["graphics"] == 1 and r["is360"] == 1 and r["new"] == 4
    assert r["years"] == {2025: 1, 2026: 3}


def test_the_diff_finds_files_the_catalog_does_not_know(data, tmp_path, monkeypatch):
    root = tmp_path / "ranch"
    known = _touch(root / "a.jpg")
    _touch(root / "b.jpg"), _touch(root / "logo.png")
    monkeypatch.setattr(config, "SOURCE", tmp_path / "nowhere")
    monkeypatch.setattr(sources, "SOURCE", tmp_path / "nowhere")
    monkeypatch.setattr(sources, "_catalogued", lambda: {str(known).lower(), str(known)})
    sources.add(str(root), "trusted")
    state = sources.diff()
    row = next(s for s in state["sources"] if s["path"] == str(root))
    assert row["files"] == 2 and row["new"] == 1  # the logo is never "new"
    assert sources.last_diff()["new"] == state["new"]


def test_heic_and_raw_report_their_size(tmp_path):
    pillow_heif = pytest.importorskip("pillow_heif")
    from PIL import Image

    pillow_heif.register_heif_opener()
    heic = tmp_path / "a.heic"
    Image.new("RGB", (64, 48), (90, 120, 80)).save(heic)
    info = media.exif_photo(heic)
    assert (info["width"], info["height"]) == (64, 48)
    raw = _touch(tmp_path / "b.dng")  # not a real RAW: recorded without a size, no crash
    assert media.exif_photo(raw)["width"] is None
