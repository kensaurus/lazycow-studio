"""
FILE: py/studio/media.py
PURPOSE: Read-only probes of a source file. Nothing here writes the source.
OVERVIEW: ffprobe, sha256, EXIF GPS, DJI SRT rows, distance to the ranch. Owns the list of
          formats (VIDEO, PHOTO for ingest, STILL for anything the renderer can show).
          HEIC/AVIF read through pillow-heif; camera RAW / DNG sized by rawpy, with GPS and
          time taken from the JPEG / INSP the camera wrote beside it.
DEPENDENCIES: studio.config, Pillow, pillow-heif, rawpy
USAGE: probe_video(path), exif_photo(path), file_sha256(path), parse_srt(path)
NOTES: A failed probe returns an empty dict. The caller still records the path.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from studio.config import SPEC, ffprobe_bin

# The ranch's point (spec.json). A project's own home place comes from studio.brand.home_place().
RANCH_LAT = SPEC["ranch"]["lat"]
RANCH_LON = SPEC["ranch"]["lon"]
RADIUS_KM = SPEC["ranch"]["radiusKm"]

# The one list of formats. Ingest takes camera files; graphics (.png, .webp) are only used
# when a user adds them by hand, so they are not swept up from Drive.
RAW = {".dng", ".arw", ".cr2", ".cr3", ".nef", ".raf", ".orf", ".rw2"}
VIDEO = {".mp4", ".mov", ".m4v", ".insv"}
PHOTO = {".jpg", ".jpeg", ".heic", ".heif", ".avif", ".tif", ".tiff", ".insp"} | RAW
STILL = PHOTO | {".png", ".webp"}
SRT_ROW = re.compile(
    r"\[latitude:\s*([-\d.]+)\]\s*\[longitude:\s*([-\d.]+)\]\s*\[rel_alt:\s*([-\d.]+)",
    re.I,
)


def file_sha256(path: Path, chunk: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def haversine_km(lat: float, lon: float, to: tuple[float, float] | None = None) -> float:
    """Kilometres from (lat, lon) to `to`, else to the project's home place (the ranch in the main project)."""
    if to is None:
        from studio.brand import home_place

        home = home_place()
        to = (home["lat"], home["lon"]) if home else (RANCH_LAT, RANCH_LON)
    r = 6371.0
    p1, p2 = math.radians(lat), math.radians(to[0])
    dphi = math.radians(to[0] - lat)
    dl = math.radians(to[1] - lon)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def near_ranch(lat: float | None, lon: float | None) -> int | None:
    """1 near the project's home place, 0 far, None unknown. A 0,0 fix is a phone placeholder, not a place.
    A project with no home place (studio.brand) has nothing to be near: None, and its footage is placed by
    studio.library.place_from as home."""
    from studio.brand import home_place

    home = home_place()
    if home is None or lat is None or lon is None or (abs(lat) < 0.01 and abs(lon) < 0.01):
        return None
    return 1 if haversine_km(lat, lon, (home["lat"], home["lon"])) <= home["radiusKm"] else 0


def probe_video(path: Path) -> dict:
    cmd = [
        str(ffprobe_bin()),
        "-v",
        "error",
        "-show_entries",
        "format=duration:format_tags=creation_time:stream=codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate",
        "-of",
        "json",
        str(path),
    ]
    try:
        raw = subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    except (subprocess.SubprocessError, OSError):
        return {}
    data = json.loads(raw.stdout or "{}")
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"
    num, _, den = rate.partition("/")
    fps = float(num) / float(den) if den and float(den) else 0.0
    tags = (data.get("format") or {}).get("tags") or {}
    return {
        "codec": video.get("codec_name"),
        "width": video.get("width"),
        "height": video.get("height"),
        "fps": round(fps, 3) if fps else None,
        "duration": float((data.get("format") or {}).get("duration") or 0) or None,
        "captured_at": tags.get("creation_time"),
    }


def _ratio(values) -> float | None:
    try:
        deg, minutes, seconds = values
        return float(deg) + float(minutes) / 60 + float(seconds) / 3600
    except (TypeError, ValueError):
        return None


def _raw_size(path: Path) -> tuple[int | None, int | None]:
    """Developed size of a camera RAW / DNG (rawpy), turned the way the camera recorded it."""
    try:
        import rawpy

        with rawpy.imread(str(path)) as raw:
            s = raw.sizes
            w, h = s.width, s.height
            return (h, w) if s.flip in (5, 6) else (w, h)
    except Exception:  # noqa: BLE001  (an unreadable RAW is recorded without a size)
        return None, None


def _sibling(path: Path) -> Path | None:
    """The JPEG / INSP written next to a RAW of the same moment: it carries the GPS and time."""
    for ext in (".insp", ".jpg", ".JPG", ".jpeg", ".heic", ".HEIC"):
        twin = path.with_suffix(ext)
        if twin != path and twin.exists():
            return twin
    return None


def exif_photo(path: Path) -> dict:
    try:
        from PIL import Image
        from PIL.ExifTags import GPSTAGS, TAGS
    except ImportError:
        return {}
    ext = path.suffix.lower()
    if ext in RAW:
        width, height = _raw_size(path)
        twin = _sibling(path)
        info = exif_photo(twin) if twin else {"lat": None, "lon": None, "captured_at": None, "tags_hint": None}
        return {**info, "width": width, "height": height}
    if ext in {".heic", ".heif", ".avif"}:
        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
        except ImportError:
            return {"width": None, "height": None}
    try:
        with Image.open(path) as image:
            width, height = image.size
            exif = image.getexif()
            gps_ifd = exif.get_ifd(0x8825) if hasattr(exif, "get_ifd") else {}
    except (OSError, ValueError):
        return {"width": None, "height": None}
    named = {}
    for key, value in (gps_ifd or {}).items():
        named[GPSTAGS.get(key, str(key))] = value
    lat = _ratio(named.get("GPSLatitude"))
    lon = _ratio(named.get("GPSLongitude"))
    if lat is not None and str(named.get("GPSLatitudeRef", "N")).upper() == "S":
        lat = -lat
    if lon is not None and str(named.get("GPSLongitudeRef", "E")).upper() == "W":
        lon = -lon
    captured = None
    try:
        raw = exif.get(306) or exif.get(36867)
        if raw:
            captured = datetime.strptime(str(raw), "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat()
    except (ValueError, TypeError, AttributeError):
        captured = None
    return {"width": width, "height": height, "lat": lat, "lon": lon, "captured_at": captured, "tags_hint": TAGS.get(271)}


def device_of(path: Path) -> str:
    name = path.name.lower()
    folder = str(path.parent).lower()
    if "dji" in folder or name.startswith("dji"):
        return "dji"
    if "gopro" in folder or name.startswith("gx"):
        return "gopro"
    if "canon" in folder or name.startswith("mvi"):
        return "canon"
    if "insta" in folder or path.suffix.lower() in {".insp", ".insv"}:
        return "insta360"
    if name.startswith("vid"):
        return "phone"
    return "unknown"


def parse_srt(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    rows = []
    for index, match in enumerate(SRT_ROW.finditer(text)):
        lat, lon, alt = (float(match.group(i)) for i in (1, 2, 3))
        rows.append({"t": index / 30, "lat": lat, "lon": lon, "rel_alt": alt})
    return rows


def captured_from_name(path: Path) -> str | None:
    match = re.search(r"(20\d{6})[_-]?(\d{6})?", path.name)
    if not match:
        return None
    day = match.group(1)
    clock = match.group(2) or "000000"
    try:
        return datetime.strptime(day + clock, "%Y%m%d%H%M%S").isoformat()
    except ValueError:
        return None
