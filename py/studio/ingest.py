"""
FILE: py/studio/ingest.py
PURPOSE: Catalog the Drive media tree and make 720p proxies.
OVERVIEW: Walks the source, records hash, EXIF, GPS, and ffprobe. Copies nothing
          back. Proxies and the catalog live on the data disk.
DEPENDENCIES: studio.db, studio.media, studio.config
USAGE: ingest(source, do_hash=True, do_proxy=False, limit=None)
NOTES: A file whose size and mtime already match is left alone, including its hash.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from studio.config import DATA, ensure_dirs, ffmpeg_bin
from studio.db import connect, connect_autocommit
from studio.media import PHOTO, VIDEO, captured_from_name, device_of, exif_photo, file_sha256, near_ranch, parse_srt, probe_video

KEEP = VIDEO | PHOTO | {".srt"}


OUTPUT_DIRS = {"tsumagoi-video-edit-sns", "ready", "drafts", "_superseded_20261107"}
EDITED_NAME = re.compile(r"_reel_|_(9x16|16x9|4x5)(_|\.)", re.I)



def captured_time(tagged: str | None, path: Path, mtime: float) -> str | None:
    """When it was filmed: the file's own tag, unless it is the zero date (Google Photos' video copies carry
    1970-01-01); else the date in its name; else, for a Google Photos import only, the file time (the import sets it
    to the item's creation time). A copied file's time is never trusted elsewhere."""
    if tagged and str(tagged)[:4] >= "1990":
        return tagged
    named = captured_from_name(path)
    if named:
        return named
    if "google-photos" in {part.lower() for part in path.parts}:
        from datetime import datetime, timezone

        return datetime.fromtimestamp(mtime, timezone.utc).isoformat(timespec="seconds")
    return None

def is_output(path: Path) -> bool:
    """Studio renders, their Drive copies and finished edits filed beside footage are outputs, never footage."""
    return any(part in OUTPUT_DIRS or part.startswith("_superseded") for part in path.parts) or bool(EDITED_NAME.search(path.name))


def iter_media(source: Path):
    for path in source.rglob("*"):
        if path.is_file() and path.suffix.lower() in KEEP and not is_output(path):
            yield path


def _proxy(src: Path, asset_id: int) -> Path | None:
    dest = DATA / "proxies" / f"{asset_id}.mp4"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(ffmpeg_bin()),
        "-y",
        "-i",
        str(src),
        "-t",
        "25",
        "-vf",
        "scale=-2:720",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60 * 30)
    except (subprocess.SubprocessError, OSError):
        if dest.exists():
            dest.unlink()
        return None
    return dest


def prepare_asset(asset_id: int, do_hash: bool = True, do_proxy: bool = True) -> None:
    """Hash and proxy one already-catalogued video. Still read-only on the source."""
    with connect() as con:
        row = con.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            return
        path = Path(row["path"])
        if do_hash and not row["sha256"] and path.exists():
            con.execute("UPDATE assets SET sha256 = ? WHERE id = ?", (file_sha256(path), asset_id))
        if do_proxy and row["kind"] == "video" and not row["proxy_path"]:
            proxy = _proxy(path, asset_id)
            if proxy:
                con.execute("UPDATE assets SET proxy_path = ? WHERE id = ?", (str(proxy), asset_id))


def ingest(
    source: Path,
    do_hash: bool = True,
    do_proxy: bool = False,
    limit: int | None = None,
    only: str | None = None,
    paths: list[Path] | None = None,
) -> dict:
    """Catalog every media file under source, or just `paths` when given."""
    ensure_dirs()
    seen = 0
    added = 0
    with connect_autocommit() as con:
        for path in paths if paths is not None else iter_media(source):
            if only and only.lower() not in str(path).lower():
                continue
            if limit is not None and seen >= limit:
                break
            seen += 1
            stat = path.stat()
            row = con.execute("SELECT id, size, mtime, sha256, proxy_path FROM assets WHERE path = ?", (str(path),)).fetchone()
            if row and row["size"] == stat.st_size and abs((row["mtime"] or 0) - stat.st_mtime) < 1:
                asset_id = row["id"]
                if do_hash and not row["sha256"]:
                    con.execute("UPDATE assets SET sha256 = ? WHERE id = ?", (file_sha256(path), asset_id))
                if do_proxy and path.suffix.lower() in VIDEO and not row["proxy_path"]:
                    proxy = _proxy(path, asset_id)
                    if proxy:
                        con.execute("UPDATE assets SET proxy_path = ? WHERE id = ?", (str(proxy), asset_id))
                continue
            kind = "video" if path.suffix.lower() in VIDEO else "photo" if path.suffix.lower() in PHOTO else "telemetry"
            fields = {
                "path": str(path),
                "kind": kind,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
                "sha256": file_sha256(path) if do_hash and kind != "telemetry" else None,
                "captured_at": captured_from_name(path),
                "lat": None,
                "lon": None,
                "near_ranch": None,
                "device": device_of(path),
                "width": None,
                "height": None,
                "fps": None,
                "duration": None,
                "codec": None,
                "proxy_path": None,
            }
            if kind == "video":
                fields.update(probe_video(path))
            elif kind == "photo":
                fields.update({k: v for k, v in exif_photo(path).items() if k in fields or k in ("lat", "lon", "captured_at", "width", "height")})
            fields["near_ranch"] = near_ranch(fields.get("lat"), fields.get("lon"))
            from studio.footage import camera_of, family_of

            fields["camera"] = (camera_of(path, kind) or "") if kind in ("photo", "video") else None
            if fields["device"] == "unknown" and family_of(fields["camera"]):
                fields["device"] = family_of(fields["camera"])
            fields["captured_at"] = captured_time(fields["captured_at"], path, stat.st_mtime)
            con.execute(
                """INSERT INTO assets (path, kind, size, mtime, sha256, captured_at, lat, lon, near_ranch, device,
                   width, height, fps, duration, codec, proxy_path, camera)
                   VALUES (:path, :kind, :size, :mtime, :sha256, :captured_at, :lat, :lon, :near_ranch, :device,
                   :width, :height, :fps, :duration, :codec, :proxy_path, :camera)
                   ON CONFLICT(path) DO UPDATE SET
                     size=excluded.size, mtime=excluded.mtime, sha256=COALESCE(excluded.sha256, assets.sha256),
                     captured_at=excluded.captured_at, lat=excluded.lat, lon=excluded.lon, near_ranch=excluded.near_ranch,
                     device=excluded.device, width=excluded.width, height=excluded.height, fps=excluded.fps,
                     duration=excluded.duration, codec=excluded.codec, camera=COALESCE(excluded.camera, assets.camera)""",
                fields,
            )
            added += 1
            asset_id = con.execute("SELECT id FROM assets WHERE path = ?", (str(path),)).fetchone()["id"]
            if kind == "telemetry":
                con.execute("DELETE FROM telemetry WHERE asset_id = ?", (asset_id,))
                stem = path.stem.lower()
                video = con.execute(
                    "SELECT id FROM assets WHERE kind = 'video' AND lower(path) LIKE ?",
                    (f"%{stem}%",),
                ).fetchone()
                target = video["id"] if video else asset_id
                for row_t in parse_srt(path):
                    con.execute(
                        "INSERT INTO telemetry (asset_id, t, lat, lon, rel_alt) VALUES (?, ?, ?, ?, ?)",
                        (target, row_t["t"], row_t["lat"], row_t["lon"], row_t["rel_alt"]),
                    )
                if video:
                    sample = con.execute(
                        "SELECT lat, lon FROM telemetry WHERE asset_id = ? AND lat IS NOT NULL LIMIT 1",
                        (video["id"],),
                    ).fetchone()
                    if sample:
                        con.execute(
                            "UPDATE assets SET lat = ?, lon = ?, near_ranch = ? WHERE id = ?",
                            (sample["lat"], sample["lon"], near_ranch(sample["lat"], sample["lon"]), video["id"]),
                        )
            if do_proxy and kind == "video":
                proxy = _proxy(path, asset_id)
                if proxy:
                    con.execute("UPDATE assets SET proxy_path = ? WHERE id = ?", (str(proxy), asset_id))
        for srt in con.execute("SELECT id, path FROM assets WHERE kind = 'telemetry'").fetchall():
            stem = Path(srt["path"]).stem.lower()
            video = con.execute(
                "SELECT id FROM assets WHERE kind = 'video' AND lower(path) LIKE ? AND id != ?",
                (f"%{stem}%", srt["id"]),
            ).fetchone()
            if not video:
                continue
            con.execute("UPDATE telemetry SET asset_id = ? WHERE asset_id = ?", (video["id"], srt["id"]))
            sample = con.execute(
                "SELECT lat, lon FROM telemetry WHERE asset_id = ? AND lat IS NOT NULL LIMIT 1",
                (video["id"],),
            ).fetchone()
            if sample:
                con.execute(
                    "UPDATE assets SET lat = ?, lon = ?, near_ranch = ? WHERE id = ? AND lat IS NULL",
                    (sample["lat"], sample["lon"], near_ranch(sample["lat"], sample["lon"]), video["id"]),
                )
    return {"seen": seen, "upserted": added}
