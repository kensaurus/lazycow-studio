"""A Google Photos Takeout zip lands in the catalog once, with GPS from its JSON."""
import json
import zipfile
from pathlib import Path

from PIL import Image

from studio.db import connect
from studio.extras import import_takeout


def _photo(path: Path, colour) -> bytes:
    Image.new("RGB", (64, 48), colour).save(path, "JPEG")
    return path.read_bytes()


def test_takeout_zip_is_unpacked_located_and_deduped(tmp_path):
    drive = tmp_path / "Takeout"
    drive.mkdir()
    ranch = _photo(tmp_path / "a.jpg", (200, 120, 40))
    away = _photo(tmp_path / "b.jpg", (20, 120, 200))
    with zipfile.ZipFile(drive / "takeout-20261107T000000Z-001.zip", "w") as z:
        z.writestr("Takeout/Google Photos/嬬恋/PXL_1.jpg", ranch)
        z.writestr("Takeout/Google Photos/嬬恋/PXL_1.jpg.supplemental-metadata.json", json.dumps(
            {"title": "PXL_1.jpg", "geoData": {"latitude": 36.5893, "longitude": 138.5096}, "photoTakenTime": {"timestamp": "1792800000"}}))
        z.writestr("Takeout/Google Photos/Trip/PXL_2.jpg", away)
        z.writestr("Takeout/Google Photos/Trip/PXL_2.jpg.json", json.dumps(
            {"title": "PXL_2.jpg", "geoData": {"latitude": 35.68, "longitude": 139.76}}))
        z.writestr("Takeout/Google Photos/Trip/../../evil.jpg", ranch)

    first = import_takeout(drive)
    assert first["added"] == 2 and first["gpsFromTakeout"] == 2
    with connect() as con:
        rows = {Path(r["path"]).name: r for r in con.execute("SELECT path, near_ranch, captured_at FROM assets")}
    assert rows["PXL_1.jpg"]["near_ranch"] == 1
    assert rows["PXL_1.jpg"]["captured_at"].startswith("2026-")
    assert rows["PXL_2.jpg"]["near_ranch"] == 0
    assert "evil.jpg" not in rows

    again = import_takeout(drive)
    assert again["added"] == 0 and again["duplicates"] == 2
