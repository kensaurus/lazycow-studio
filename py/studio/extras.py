"""
FILE: py/studio/extras.py
PURPOSE: Opt-in tools. Each one refuses to spend money or claim a model it did not run.
OVERVIEW: Ridge matte, a luminance parallax, Takeout ingest, Real-ESRGAN,
          a licensed-bed check, and a dry gap-fill request.
DEPENDENCIES: numpy, cv2, optional realesrgan binary, optional SAM
USAGE: python -m studio extras <name>
NOTES: SAM 3 and Depth Anything are used only when their packages import.
       The fallbacks are labelled heuristic in the sidecar JSON.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from studio.config import DATA, ROOT, daily_budget, openrouter_key
from studio.db import connect, spent_today
from studio.ingest import ingest
from studio.media import file_sha256

GAP_USD = 1.21


def ridge_mask(image_path: Path, dest: Path) -> dict:
    """White where the subject or ridge should cover the title."""
    note = "heuristic-luma"
    image = cv2.imread(str(image_path))
    if image is None:
        raise RuntimeError(f"cannot read {image_path}")
    try:
        import sam3  # noqa: F401

        note = "sam3-available-not-prompted"
    except ImportError:
        pass
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (0, 0), 7)
    _, mask = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    mask = cv2.medianBlur(mask, 5)
    dest.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(dest), mask)
    sidecar = dest.with_suffix(".json")
    sidecar.write_text(json.dumps({"method": note, "src": str(image_path)}), encoding="utf-8")
    return {"mask": str(dest), "method": note}


def parallax(image_path: Path, dest: Path, frames: int = 20, shift: int = 18) -> dict:
    """Slide a still by a luminance depth map. Not a learned depth model."""
    method = "heuristic-luma"
    image = cv2.imread(str(image_path))
    if image is None:
        raise RuntimeError(f"cannot read {image_path}")
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    folder = dest.parent / f"{dest.stem}_frames"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    xs = np.arange(w)
    for index in range(frames):
        offset = (index / max(1, frames - 1) - 0.5) * shift
        map_x = (xs[None, :] - offset * gray).astype(np.float32)
        map_y = np.repeat(np.arange(h, dtype=np.float32)[:, None], w, axis=1)
        warped = cv2.remap(image, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        cv2.imwrite(str(folder / f"{index:03d}.png"), warped)
    from studio.config import ffmpeg_bin

    subprocess.run(
        [str(ffmpeg_bin()), "-y", "-framerate", "25", "-i", str(folder / "%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", str(dest)],
        check=True,
        capture_output=True,
        timeout=180,
    )
    return {"video": str(dest), "method": method}


TAKEOUT = DATA / "takeout"


def _sidecar(media: Path) -> dict:
    """Takeout's JSON beside a photo: `<name>.json` or `<name>.supplemental-metadata.json` (truncated names too)."""
    for cand in sorted(media.parent.glob(media.name[:40] + "*.json")):
        try:
            data = json.loads(cand.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("title") in (None, media.name) or cand.name.startswith(media.name):
            return data
    return {}


def import_takeout(folder: Path) -> dict:
    """Bring a Google Photos Takeout into the catalog.

    `folder` holds Takeout zips (as delivered to Drive) and/or extracted folders. Zips are
    unpacked to the data disk, never beside the source. A file whose sha256 is already
    catalogued (the same photo already on Drive) is skipped. GPS and capture time come
    from the Takeout JSON when the file's own EXIF has none, so the location gate works.
    """
    import zipfile

    from studio.ingest import KEEP, is_output
    from studio.media import near_ranch

    if not folder.exists():
        return {"added": 0, "error": f"missing {folder}"}
    roots = [p for p in folder.iterdir() if p.is_dir()] if folder.is_dir() else []
    for z in sorted(folder.glob("*.zip")):
        dest = TAKEOUT / z.stem
        if not (dest / ".done").exists():
            dest.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(z) as archive:
                for member in archive.infolist():
                    name = Path(member.filename)
                    if member.is_dir() or name.suffix.lower() not in KEEP | {".json"} or ".." in name.parts:
                        continue
                    archive.extract(member, dest)
            (dest / ".done").write_text("ok", encoding="utf-8")
        roots.append(dest)
    with connect() as con:
        known = {r[0] for r in con.execute("SELECT sha256 FROM assets WHERE sha256 IS NOT NULL")}
    fresh, dupes = [], 0
    for root in roots:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in KEEP or path.suffix.lower() == ".srt" or is_output(path):
                continue
            if file_sha256(path) in known:
                dupes += 1
                continue
            fresh.append(path)
    added = ingest(folder, do_hash=True, do_proxy=False, paths=fresh)
    located = 0
    with connect() as con:
        for path in fresh:
            row = con.execute("SELECT id, lat, captured_at FROM assets WHERE path = ?", (str(path),)).fetchone()
            meta = _sidecar(path)
            geo = meta.get("geoData") or {}
            lat, lon = geo.get("latitude"), geo.get("longitude")
            if row and row["lat"] is None and lat and lon:
                con.execute("UPDATE assets SET lat = ?, lon = ?, near_ranch = ? WHERE id = ?", (lat, lon, near_ranch(lat, lon), row["id"]))
                located += 1
            taken = (meta.get("photoTakenTime") or {}).get("timestamp")
            if row and not row["captured_at"] and taken:
                from datetime import datetime, timezone

                stamp = datetime.fromtimestamp(int(taken), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
                con.execute("UPDATE assets SET captured_at = ? WHERE id = ?", (stamp, row["id"]))
    return {"added": added["upserted"], "duplicates": dupes, "gpsFromTakeout": located, "next": "python -m studio library --scan"}


def upscale(src: Path, dest: Path) -> dict:
    binary = next(DATA.joinpath("bin", "realesrgan").rglob("realesrgan-ncnn-vulkan.exe"), None)
    if binary is None:
        return {"ok": False, "error": "realesrgan-ncnn-vulkan.exe not installed"}
    image = cv2.imread(str(src))
    if image is None:
        return {"ok": False, "error": "unreadable"}
    if image.shape[1] >= 1600:
        return {"ok": False, "error": "already 1600px or wider", "width": int(image.shape[1])}
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(binary), "-i", str(src), "-o", str(dest), "-n", "realesrgan-x4plus"], check=True, capture_output=True, timeout=300)
    return {"ok": True, "out": str(dest), "sha": file_sha256(dest)}


def beat_track(audio: Path) -> dict:
    license_file = audio.with_suffix(".license.txt")
    text = license_file.read_text(encoding="utf-8").lower() if license_file.exists() else ""
    if not any(word in text for word in ("royalty-free", "cc0", "original", "public domain")):
        return {"ok": False, "error": "refusing: no royalty-free / cc0 / original license sidecar"}
    import librosa

    samples, rate = librosa.load(str(audio), sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=samples, sr=rate)
    times = librosa.frames_to_time(beats, sr=rate)
    return {"ok": True, "tempo": float(np.atleast_1d(tempo)[0]), "beats": [round(float(t), 3) for t in times[:64]]}


def gap_fill(prompt: str, confirm: bool) -> dict:
    """Seedance-shaped request. Dry unless confirm is set and the day's budget can hold $1.21."""
    banned = ("milky way", "天の川", "cattle", "牛", "直火", "ground fire")
    if any(word in prompt.lower() for word in banned):
        return {"ok": False, "error": "prompt tripped the fact guard"}
    with connect() as con:
        room = daily_budget() - spent_today(con)
    if not confirm:
        return {"ok": False, "dry": True, "wouldCostUsd": GAP_USD, "room": round(room, 2)}
    if room < GAP_USD or not openrouter_key():
        return {"ok": False, "error": "over budget or no key", "room": round(room, 2)}
    body = json.dumps({"model": "bytedance/seedance-2.0", "prompt": prompt}).encode("utf-8")
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/videos",
        data=body,
        headers={"Authorization": f"Bearer {openrouter_key()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": str(exc)[:300]}
    return {"ok": True, "job": payload.get("id"), "labelled": "generated-gap-fill"}
