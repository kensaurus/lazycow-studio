"""
FILE: py/studio/gps.py
PURPOSE: Where each file was filmed, as exactly as the files allow. Read only on the source files.
OVERVIEW: parse_iso6709 (the position a phone or camera writes into a video), video_gps (ffprobe's tags),
          srt_points (a DJI flight log, every format seen), join_srt (a DJI video takes its own .SRT's first fix),
          clock / estimate (a file with no position takes one from a GPS file filmed close in time, kept apart from
          real positions), report (real / estimated / none per device) and backfill (python -m studio media backfill-gps).
DEPENDENCIES: studio.config (ffprobe), studio.db, studio.media
USAGE: python -m studio media backfill-gps   (fills empty positions only; estimates are recomputed every run)
NOTES: A real position is never overwritten: only an empty one (or the 0,0 placeholder some phones write) is filled.
       Estimates live in est_lat / est_lon / est_from / est_gap_min; est_gap_min is signed: the GPS file was filmed
       that many minutes after (+) or before (-) the file. Photos keep the camera's own clock (the wall clock where it
       was taken); videos carry UTC, so a pair of the two is compared in the GPS file's zone (its position's).
"""
from __future__ import annotations

import bisect
import json
import math
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

WINDOW_MIN = 90   # a GPS file at most this far apart in time, on the same day
AGREE_KM = 2.0    # and the GPS files in that window all within this of each other
LOCATION_TAGS = ("com.apple.quicktime.location.iso6709", "location", "location-eng", "©xyz", "xyz")

_ISO = re.compile(r"^\s*([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\s*(?:CRS[^/]*)?/?\s*$")


def _sexagesimal(text: str, deg_digits: int) -> float | None:
    """ISO 6709 writes degrees as D(D)(D)[.d], DDMM[.m] or DDMMSS[.s]: the digits before the point say which."""
    sign = -1.0 if text[0] == "-" else 1.0
    body = text[1:]
    whole, _, frac = body.partition(".")
    frac = "." + frac if frac else ""
    try:
        if len(whole) <= deg_digits:
            return sign * float(whole + frac)
        if len(whole) == deg_digits + 2:
            return sign * (float(whole[:deg_digits]) + float(whole[deg_digits:] + frac) / 60)
        if len(whole) == deg_digits + 4:
            return sign * (float(whole[:deg_digits]) + float(whole[deg_digits:deg_digits + 2]) / 60 + float(whole[deg_digits + 2:] + frac) / 3600)
    except ValueError:
        return None
    return None


def valid(lat, lon) -> bool:
    """A usable fix: inside the globe and not the 0,0 placeholder some phones write."""
    return (lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180
            and not (abs(lat) < 0.01 and abs(lon) < 0.01))


def parse_iso6709(text: str | None) -> tuple[float, float] | None:
    """(lat, lon) from an ISO 6709 string as phones and cameras write it ("+36.4778+138.5050/",
    "+36.4778+138.5050+012.345/", "+3628.668+13830.300/"), or None."""
    m = _ISO.match(str(text or ""))
    if not m:
        return None
    lat, lon = _sexagesimal(m.group(1), 2), _sexagesimal(m.group(2), 3)
    return (round(lat, 7), round(lon, 7)) if valid(lat, lon) else None


def gps_from_tags(tags: dict | None) -> tuple[float, float] | None:
    """The position among a video's tags (the Apple key first, then the MP4 / Android ones), or None."""
    low = {str(k).lower(): v for k, v in (tags or {}).items()}
    for key in LOCATION_TAGS:
        if key in low:
            hit = parse_iso6709(low[key])
            if hit:
                return hit
    return None


def video_gps(path: Path) -> tuple[float, float] | None:
    """A video's own position (ffprobe's format tags), or None when it has none or cannot be read."""
    from studio.config import ffprobe_bin

    cmd = [str(ffprobe_bin()), "-v", "error", "-show_entries", "format_tags", "-of", "json", str(path)]
    try:
        raw = subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        return gps_from_tags(((json.loads(raw.stdout or "{}").get("format") or {}).get("tags")) or {})
    except (subprocess.SubprocessError, OSError, ValueError):
        return None


# DJI flight logs: "[latitude: 36.66] [longitude: 138.41] [rel_alt: 1.2 abs_alt: 1234]" (Mini 3/4, Air 3),
# "[latitude : 36.66] [longtitude : 138.41]" (Mini 2, DJI's own spelling), "[altitude: 1.6]" (Mini 4 Pro) and the
# older "GPS(138.41,36.66,15)" (Phantom / Mavic, longitude first).
_SRT_BRACKET = re.compile(r"\[latitude\s*:\s*([-\d.]+)\]\s*\[long?t?itude\s*:\s*([-\d.]+)\](?:\s*\[(?:rel_alt|altitude)\s*:\s*([-\d.]+))?", re.I)
_SRT_GPS = re.compile(r"GPS\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*(?:,\s*([-\d.]+))?\s*\)", re.I)


def srt_points(text: str) -> list[dict]:
    """Every position row in a DJI .SRT, in order: {t (s, one per frame at 30 fps), lat, lon, rel_alt}."""
    rows = []
    for m in _SRT_BRACKET.finditer(text):
        rows.append((float(m.group(1)), float(m.group(2)), float(m.group(3)) if m.group(3) else None))
    if not rows:
        for m in _SRT_GPS.finditer(text):
            rows.append((float(m.group(2)), float(m.group(1)), float(m.group(3)) if m.group(3) else None))
    return [{"t": i / 30, "lat": lat, "lon": lon, "rel_alt": alt} for i, (lat, lon, alt) in enumerate(rows)]


def first_fix(points: list[dict]) -> tuple[float, float] | None:
    """The first usable fix (a drone logs 0,0 until its GPS locks)."""
    return next(((p["lat"], p["lon"]) for p in points if valid(p["lat"], p["lon"])), None)


def _empty(lat, lon) -> bool:
    return not valid(lat, lon)


def join_srt(con, read=None) -> int:
    """Pair each DJI .SRT with the video of the same name in the same folder: its rows go under the video and the
    video takes the first usable fix when it has no position. Returns how many videos were given a position.
    `read(path) -> text` reads a log (tests pass one; the default reads the file)."""
    from studio.media import near_ranch

    read = read or (lambda p: Path(p).read_text(encoding="utf-8", errors="replace"))
    videos: dict[tuple[str, str], dict] = {}
    for v in con.execute("SELECT id, path, lat, lon FROM assets WHERE kind = 'video'"):
        p = Path(v["path"])
        videos.setdefault((str(p.parent).lower(), p.stem.lower()), dict(v))
    placed = 0
    for srt in con.execute("SELECT id, path FROM assets WHERE kind = 'telemetry'").fetchall():
        p = Path(srt["path"])
        video = videos.get((str(p.parent).lower(), p.stem.lower()))
        if not video:
            continue
        mine = con.execute("SELECT t, lat, lon, rel_alt FROM telemetry WHERE asset_id = ? ORDER BY t", (srt["id"],)).fetchall()
        have = con.execute("SELECT COUNT(*) FROM telemetry WHERE asset_id = ?", (video["id"],)).fetchone()[0]
        if mine:  # rows read at ingest under the log's own id: they belong to the video
            con.execute("DELETE FROM telemetry WHERE asset_id = ?", (video["id"],))
            con.execute("UPDATE telemetry SET asset_id = ? WHERE asset_id = ?", (video["id"], srt["id"]))
        elif not have:
            try:
                points = srt_points(read(p))
            except OSError:
                points = []
            con.executemany("INSERT INTO telemetry (asset_id, t, lat, lon, rel_alt) VALUES (?, ?, ?, ?, ?)",
                            [(video["id"], x["t"], x["lat"], x["lon"], x["rel_alt"]) for x in points])
        if _empty(video["lat"], video["lon"]):
            rows = con.execute("SELECT lat, lon FROM telemetry WHERE asset_id = ? ORDER BY t", (video["id"],)).fetchall()
            fix = first_fix([{"lat": r["lat"], "lon": r["lon"]} for r in rows])
            if fix:
                con.execute("UPDATE assets SET lat = ?, lon = ?, near_ranch = ? WHERE id = ?", (fix[0], fix[1], near_ranch(*fix), video["id"]))
                video["lat"], video["lon"] = fix
                placed += 1
    return placed


# ---------- Clocks: what kind of time each file's captured_at is ----------
def clock(captured_at: str | None, kind: str) -> tuple[str, datetime] | None:
    """("utc", aware UTC time) or ("wall", naive local wall-clock time) for a catalogue time, or None.
    A video's creation_time ends in Z (UTC), and so does the Google Photos file time (+00:00 on a video). A photo's
    EXIF time is the camera's wall clock (stored with +00:00 but not UTC), and a time from the file name is too."""
    text = str(captured_at or "").strip()
    if len(text) < 16 or text[:4] < "1990":
        return None
    try:
        when = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        return "wall", when
    off = when.utcoffset()
    if text.endswith("Z") or (off and off != timedelta(0)) or kind == "video":
        return "utc", when.astimezone(timezone.utc)
    return "wall", when.replace(tzinfo=None)


def home_offset_hours(when: datetime) -> float:
    """This studio's own zone at that moment (STUDIO_TZ, else this computer's), in hours east of UTC."""
    try:
        from studio.posting import audience_tz

        tz = audience_tz()
    except Exception:  # noqa: BLE001 - no posting module settings here: the computer's zone
        tz = None
    probe = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when
    off = probe.astimezone(tz).utcoffset() if tz else probe.astimezone().utcoffset()
    return (off or timedelta(0)).total_seconds() / 3600


def zone_hours(lat: float, lon: float, when: datetime, home=None) -> float:
    """Hours east of UTC where a GPS file was taken: the studio's own zone when it fits the place's longitude (within
    1.5 h: the usual case, exact with summer time), else the place's nominal hour (lon / 15), for footage from a trip."""
    nominal = round(lon / 15)
    own = (home or home_offset_hours)(when)
    return own if abs(own - nominal) <= 1.5 else float(nominal)


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    from studio.media import haversine_km

    return haversine_km(a[0], a[1], b)


def estimate(rows: list[dict], window_min: int = WINDOW_MIN, agree_km: float = AGREE_KM, zone=zone_hours) -> dict[int, dict]:
    """Estimated positions for files with none: {id: {lat, lon, from, gap}}. A file gets one only when GPS files were
    filmed within `window_min` of it on the same day AND all of them lie within `agree_km` of each other (else the
    person was moving and no single place is right). The position is the nearest-in-time GPS file's; ties go to
    the lower id, so the answer never depends on row order. Each row: {id, kind, captured_at, lat, lon}."""
    anchors = []
    for r in rows:
        if not valid(r.get("lat"), r.get("lon")):
            continue
        c = clock(r.get("captured_at"), r.get("kind") or "")
        if not c:
            continue
        lat, lon = float(r["lat"]), float(r["lon"])
        h = timedelta(hours=zone(lat, lon, c[1]))
        utc = c[1] if c[0] == "utc" else (c[1] - h).replace(tzinfo=timezone.utc)
        wall = (c[1] + h).replace(tzinfo=None) if c[0] == "utc" else c[1]
        anchors.append({"id": r["id"], "lat": lat, "lon": lon, "utc": utc, "wall": wall})
    if not anchors:
        return {}
    by_utc = sorted(anchors, key=lambda a: (a["utc"], a["id"]))
    by_wall = sorted(anchors, key=lambda a: (a["wall"], a["id"]))
    keys = {"utc": [a["utc"] for a in by_utc], "wall": [a["wall"] for a in by_wall]}
    lists = {"utc": by_utc, "wall": by_wall}
    span = timedelta(minutes=window_min)
    out: dict[int, dict] = {}
    for r in rows:
        if valid(r.get("lat"), r.get("lon")) or r.get("kind") not in ("photo", "video"):
            continue
        c = clock(r.get("captured_at"), r.get("kind") or "")
        if not c:
            continue
        frame, t = c
        lo, hi = bisect.bisect_left(keys[frame], t - span), bisect.bisect_right(keys[frame], t + span)
        near = []
        for a in lists[frame][lo:hi]:
            # the same day where it was filmed: the GPS file's wall-clock day, and this file's in the same zone
            day = (t + (a["wall"] - a["utc"].replace(tzinfo=None))).date() if frame == "utc" else t.date()
            if a["wall"].date() == day:
                near.append(a)
        if not near:
            continue
        lats, lons = [a["lat"] for a in near], [a["lon"] for a in near]
        if _km((min(lats), min(lons)), (max(lats), max(lons))) > agree_km:
            continue  # the GPS files in the window disagree: the person was moving
        best = min(near, key=lambda a: (abs((a[frame] - t).total_seconds()), a["id"]))
        gap = round((best[frame] - t).total_seconds() / 60)
        out[r["id"]] = {"lat": best["lat"], "lon": best["lon"], "from": best["id"], "gap": gap}
    return out


def ensure_columns(con) -> None:
    """The estimate columns (studio.db adds them too; kept here so a test catalogue made by hand has them)."""
    have = {r[1] for r in con.execute("PRAGMA table_info(assets)")}
    for col, kind in (("est_lat", "REAL"), ("est_lon", "REAL"), ("est_from", "INTEGER"), ("est_gap_min", "INTEGER")):
        if col not in have:
            con.execute(f"ALTER TABLE assets ADD COLUMN {col} {kind}")


def estimate_all(con) -> int:
    """Recompute every estimate from the catalogue as it is now (deterministic). Returns how many files have one."""
    ensure_columns(con)
    rows = [dict(r) for r in con.execute("SELECT id, kind, captured_at, lat, lon FROM assets WHERE kind IN ('photo', 'video')")]
    est = estimate(rows)
    con.execute("UPDATE assets SET est_lat = NULL, est_lon = NULL, est_from = NULL, est_gap_min = NULL WHERE est_lat IS NOT NULL OR est_from IS NOT NULL")
    con.executemany("UPDATE assets SET est_lat = ?, est_lon = ?, est_from = ?, est_gap_min = ? WHERE id = ?",
                    [(e["lat"], e["lon"], e["from"], e["gap"], i) for i, e in est.items()])
    return len(est)


def report(con, ids: set | None = None) -> dict:
    """Per device: files with a real position, an estimated one, none, and how many of the none came through a Google
    Photos import (Google removes the location from what it hands out). Photos and videos only; with `ids`, only those
    assets (the map passes the library files it draws, so its line and its dots count the same files)."""
    ensure_columns(con)
    devices: dict[str, dict] = {}
    for r in con.execute("SELECT id, device, path, lat, lon, est_lat FROM assets WHERE kind IN ('photo', 'video')"):
        if ids is not None and r["id"] not in ids:
            continue
        d = devices.setdefault(r["device"] or "unknown", {"device": r["device"] or "unknown", "files": 0, "real": 0, "estimated": 0, "none": 0, "googlePhotos": 0})
        d["files"] += 1
        if valid(r["lat"], r["lon"]):
            d["real"] += 1
        elif r["est_lat"] is not None:
            d["estimated"] += 1
        else:
            d["none"] += 1
            if "google-photos" in str(r["path"]).lower().replace("\\", "/").split("/"):
                d["googlePhotos"] += 1
    rows = sorted(devices.values(), key=lambda d: -d["files"])
    total = {k: sum(d[k] for d in rows) for k in ("files", "real", "estimated", "none", "googlePhotos")}
    return {"devices": rows, **total}


def backfill(limit: int | None = None, progress=print) -> dict:
    """Fill empty positions from what the files already hold, then recompute the estimates. Never overwrites a real
    position. Videos: their own ISO 6709 tag (read with ffprobe); DJI videos: their .SRT. Prints PROGRESS lines."""
    from studio.db import connect_autocommit
    from studio.media import near_ranch

    with connect_autocommit() as con:
        before = report(con)
        todo = [dict(r) for r in con.execute("SELECT id, path, lat, lon FROM assets WHERE kind = 'video'") if _empty(r["lat"], r["lon"])]
        if limit is not None:
            todo = todo[:limit]
        tagged = 0
        progress(f"STAGE 1/3 reading the position inside {len(todo)} videos", flush=True)
        for i, v in enumerate(todo, 1):
            if i % 10 == 0 or i == len(todo):
                progress(f"PROGRESS {i}/{len(todo)} {Path(v['path']).name}", flush=True)
            path = Path(v["path"])
            fix = video_gps(path) if path.exists() else None
            if fix:
                con.execute("UPDATE assets SET lat = ?, lon = ?, near_ranch = ? WHERE id = ? AND (lat IS NULL OR (abs(lat) < 0.01 AND abs(lon) < 0.01))",
                            (fix[0], fix[1], near_ranch(*fix), v["id"]))
                tagged += 1
        progress("STAGE 2/3 pairing drone videos with their flight logs", flush=True)
        flown = join_srt(con)
        progress("STAGE 3/3 estimating positions from files filmed close in time", flush=True)
        est = estimate_all(con)
        after = report(con)
    return {"videoTags": tagged, "droneLogs": flown, "estimated": est, "before": before, "after": after}
