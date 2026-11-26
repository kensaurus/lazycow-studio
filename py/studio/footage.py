"""
FILE: py/studio/footage.py
PURPOSE: How much usable footage is left, which camera it came from, how often clips are reused, and what to
         film next with which camera. Read only, except `backfill_cameras`, which fills assets.camera from each
         file's own metadata (EXIF Make/Model for photos, the container's make/model tags for video).
DEPENDENCIES: studio.db, studio.library (the tagged rows and their usage), studio.assemble (themes), studio.media.
USAGE: python -m studio footage health | cameras [--limit N]  (places() is read by the service: GET /api/footage/places)
"""
from __future__ import annotations

import json
import subprocess
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from studio.db import connect

# Camera family from the maker's name (the friendly group the studio already uses in `device`).
FAMILY = [("dji", "dji"), ("gopro", "gopro"), ("canon", "canon"), ("insta360", "insta360"), ("arashi", "insta360"),
          ("xiaomi", "phone"), ("google", "phone"), ("apple", "phone"), ("samsung", "phone"), ("sony", "phone"),
          ("oppo", "phone"), ("sharp", "phone"), ("fujifilm", "camera"), ("nikon", "camera"), ("panasonic", "camera")]
CLIPS_PER_REEL = 9          # a short reel uses about nine shots (assemble THEMES slots)
VIDEO_REUSE_CAP = 3         # past this many reels one video starts to look repeated
PHOTOS_IN_REEL = 2          # Make reels puts at most 30 % photos in a reel: two of nine shots (studio.assemble)
FEW_CLIPS = 40              # under this many usable clips Make reels says "reels will repeat": no estimate beside it
FRESH_DAYS = 30


def family_of(camera: str | None) -> str | None:
    low = (camera or "").lower()
    return next((fam for key, fam in FAMILY if key in low), None)


# Market names for the codes some files record (the phone's own photos say "Xiaomi 14T Pro" where its videos say
# 2407FPN8EG; FC3411 is the DJI Air 2S camera; Insta360 writes its maker as Arashi Vision).
ALIAS = {"xiaomi 2407fpn8eg": "Xiaomi 14T Pro", "dji fc3411": "DJI Air 2S", "arashi vision insta360 oners": "Insta360 ONE RS"}


def _clean(make: str | None, model: str | None) -> str | None:
    make, model = (str(make or "").strip(" \x00"), str(model or "").strip(" \x00"))
    if not make and not model:
        return None
    name = model if make and model.lower().startswith(make.lower()) else f"{make} {model}".strip()
    return ALIAS.get(name.lower(), name)


def camera_of(path: Path, kind: str) -> str | None:
    """'Xiaomi 2407FPN8EG', 'DJI FC8482', 'Canon EOS R6': the maker and model the file itself records."""
    if kind == "photo":
        try:
            from PIL import Image

            with Image.open(path) as im:
                ex = im.getexif()
                return _clean(ex.get(271), ex.get(272))
        except Exception:  # noqa: BLE001 - an unreadable photo has no camera, not an error
            return None
    if kind == "video":
        from studio.media import ffprobe_bin

        try:
            out = subprocess.run([str(ffprobe_bin()), "-v", "error", "-show_entries", "format_tags:stream_tags=handler_name,encoder",
                                  "-of", "json", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60).stdout
        except (subprocess.SubprocessError, OSError):
            return None
        data = json.loads(out or "{}")
        tags = {k.lower(): v for k, v in ((data.get("format") or {}).get("tags") or {}).items()}
        make = tags.get("com.android.manufacturer") or tags.get("com.apple.quicktime.make") or tags.get("make")
        model = tags.get("com.android.model") or tags.get("com.apple.quicktime.model") or tags.get("model")
        if make or model:
            return _clean(make, model)
        handlers = " ".join(str((s.get("tags") or {}).get("handler_name", "")) for s in data.get("streams", []))
        enc = str(tags.get("encoder", ""))
        for key, name in (("dji", "DJI"), ("gopro", "GoPro"), ("insta360", "Insta360")):
            if key in handlers.lower() or key in enc.lower():
                return name
    return None


def backfill_cameras(limit: int = 5000) -> dict:
    """Fill assets.camera for files that do not have it yet; a recognised maker also fixes an 'unknown' device."""
    with connect() as con:
        rows = [dict(r) for r in con.execute(
            "SELECT id, path, kind, device FROM assets WHERE camera IS NULL AND kind IN ('photo','video') LIMIT ?", (limit,))]
    found, missing, gone = 0, 0, 0
    updates = []
    for r in rows:
        p = Path(r["path"])
        if not p.exists():
            gone += 1
            continue
        cam = camera_of(p, r["kind"])
        fam = family_of(cam)
        device = fam if fam and r["device"] in (None, "unknown") else r["device"]
        updates.append((cam or "", device, r["id"]))  # '' = looked, nothing recorded (not asked again)
        found += bool(cam)
        missing += not cam
    with connect() as con:
        con.executemany("UPDATE assets SET camera = ?, device = ? WHERE id = ?", updates)
    return {"checked": len(updates), "found": found, "none": missing, "unreachable": gone}


def _when(s: str | None) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def health(now: datetime | None = None) -> dict:
    """The footage picture for the Footage page: per camera, reuse, runway, and what to film next.
    Read-only, so its ~35 library searches share one build of the catalog rows (library.batch)."""
    from studio.library import batch

    with batch():
        return _health(now)


def estimate(rows: list[dict]) -> dict:
    """How many reels the footage holds, counted on the clips Make reels can actually use (studio.assemble.can_use: the
    same filters, so the two never disagree; BL-134: "about 0 more reels possible" while reels were being made from
    32 clips, because this counted only videos over 2.5 s with a looser filler line).
    clips: usable videos; fresh: those in no reel yet; reelsLeft: reels of fresh videos (nine shots each); more: reels
    still possible before every video is in VIDEO_REUSE_CAP reels (low: videos only; high: with two photos a reel while
    the photos last), or None when there are fewer than FEW_CLIPS usable clips: Make reels then says reels will
    repeat, and no number is shown beside it. canMake: at least four usable clips, one a video (a reel's minimum)."""
    from studio.assemble import SHOTS_MIN, can_use

    usable = [r for r in rows if can_use(r)]
    videos = [r for r in usable if r["kind"] == "video"]
    photos = len(usable) - len(videos)
    fresh = sum(1 for r in videos if not r["usedIn"])
    room = sum(max(0, VIDEO_REUSE_CAP - len(r["usedIn"])) for r in videos)  # uses left before each video reaches the cap
    with_photos = min(room // (CLIPS_PER_REEL - PHOTOS_IN_REEL), (room + photos * VIDEO_REUSE_CAP) // CLIPS_PER_REEL)
    more = None if len(usable) < FEW_CLIPS else {"low": room // CLIPS_PER_REEL, "high": max(room // CLIPS_PER_REEL, with_photos),
                                                   "cap": VIDEO_REUSE_CAP}
    return {"clips": len(videos), "usable": len(usable), "fresh": fresh, "reelsLeft": fresh // CLIPS_PER_REEL, "more": more,
            "canMake": len(usable) >= SHOTS_MIN and bool(videos), "_videos": videos}


def _health(now: datetime | None = None) -> dict:
    from studio.assemble import THEMES, film_next
    from studio.library import items

    now = now or datetime.now(timezone.utc)
    rows = [r for r in items("", {}, limit=100000) if not r.get("vetoed")]
    with connect() as con:
        cams = {r["path"]: r["camera"] for r in con.execute("SELECT path, camera FROM assets")}
    ranch = [r for r in rows if str(r.get("place", "")).startswith("ranch")]
    est = estimate(rows)
    clips = est.pop("_videos")

    def cam(r):
        return cams.get(r["path"]) or {"dji": "DJI drone", "phone": "Phone", "canon": "Canon", "gopro": "GoPro", "insta360": "Insta360"}.get(r["device"], "Unknown camera")

    per = {}
    for r in ranch:
        c = per.setdefault(cam(r), {"camera": cam(r), "family": r["device"], "videos": 0, "photos": 0, "minutes": 0.0,
                                    "unused": 0, "newest": None, "recent": 0})
        c["videos" if r["kind"] == "video" else "photos"] += 1
        c["minutes"] += (r.get("duration") or 0) / 60 if r["kind"] == "video" else 0
        if r["kind"] == "video" and not r["usedIn"]:
            c["unused"] += 1
        d = _when(r.get("captured"))
        if d and (not c["newest"] or d > _when(c["newest"])):
            c["newest"] = d.isoformat()
        if d and now - d < timedelta(days=FRESH_DAYS):
            c["recent"] += 1
    cameras = sorted(({**c, "minutes": round(c["minutes"], 1)} for c in per.values()), key=lambda c: -(c["videos"] * 3 + c["photos"]))

    uses = Counter(min(len(r["usedIn"]), 3) for r in clips)
    reuse = {"never": uses[0], "once": uses[1], "twice": uses[2], "3+": uses[3]}
    most = sorted((r for r in clips if len(r["usedIn"]) >= 3), key=lambda r: -len(r["usedIn"]))[:5]
    thin = {t["theme"]: t for t in film_next()}
    themes = []
    for key, theme in THEMES.items():
        t = thin.get(key)
        camera = None
        if t:  # the camera that shot most of this opening's best ranch matches: the one to take out again
            want = theme.get("device") or []
            pool = [r for r in items(theme["slots"][0], {"ranch": True, "kind": "video"}, limit=20) if not want or r["device"] in want]
            top = Counter(cam(r) for r in pool).most_common(1)
            camera = top[0][0] if top else ("DJI drone" if "dji" in want else None)
        themes.append({"theme": key, "title": theme["title_ja"], "need": theme["slots"][0], "needJa": t.get("needJa") if t else None,
                       "left": t["left"] if t else None,
                       "short": bool(t), "camera": camera})
    shoot = sorted((t for t in themes if t["short"]), key=lambda t: (t["left"], t["theme"]))
    return {
        **est, "reuse": reuse,
        "mostReused": [{"file": r["file"], "uses": len(r["usedIn"]), "camera": cam(r)} for r in most],
        "cameras": cameras, "unknownCameras": sum(1 for r in ranch if cams.get(r["path"]) is None),  # never read ('' = read, none recorded)
        "shoot": shoot, "themes": len(themes), "asOf": now.isoformat(),
    }


# ---------- Where the footage was filmed (Footage › Health's map; GET /api/footage/places) ----------
PLACE_GRID = 0.001  # degrees: about 110 m north-south and 90 m east-west at the ranch; no position is finer than this


def cluster_places(rows: list[dict], home: dict | None) -> dict:
    """Footage with a GPS position, grouped on a ~100 m grid. Each row is {id, lat, lon, kind, used}; a cluster gives
    its grid point (never a file's own position), how many files, videos and unused files it holds, whether it is
    inside the home place, and the library ids it holds (for the page's filter). A 0,0 fix is a phone placeholder."""
    from studio.media import haversine_km

    def snap(x: float) -> float:
        return round(round(x / PLACE_GRID) * PLACE_GRID, 3)

    from studio.gps import valid

    groups: dict[tuple[float, float], dict] = {}
    for r in rows:
        lat, lon, est = r.get("lat"), r.get("lon"), False
        if not valid(lat, lon):
            # no position of its own: an estimate from a GPS file filmed close in time (studio.gps), shown hollow
            lat, lon, est = r.get("est_lat"), r.get("est_lon"), True
            if not valid(lat, lon):
                continue
        k = (snap(lat), snap(lon))
        g = groups.setdefault(k, {"lat": k[0], "lon": k[1], "clips": 0, "videos": 0, "unused": 0, "ids": [], "real": 0, "est": 0,
                                  "first": None, "last": None, "gap": None})
        g["clips"] += 1
        g["videos"] += r.get("kind") == "video"
        g["unused"] += not r.get("used")
        g["ids"].append(r["id"])
        g["est" if est else "real"] += 1
        day = str(r.get("captured") or "")[:10]
        if len(day) == 10:
            g["first"] = min(g["first"] or day, day)
            g["last"] = max(g["last"] or day, day)
        if est and r.get("est_gap") is not None:  # the closest and furthest GPS file in time behind the estimates, minutes
            a = abs(int(r["est_gap"]))
            g["gap"] = [min(g["gap"][0], a), max(g["gap"][1], a)] if g["gap"] else [a, a]
            g["one"] = {"gap": int(r["est_gap"]), "kind": r.get("est_kind")}  # read when the group holds one estimate
    out = sorted(groups.values(), key=lambda g: -g["clips"])
    for g in out:
        g["km"] = round(haversine_km(g["lat"], g["lon"], (home["lat"], home["lon"])), 1) if home else None
        g["home"] = bool(home) and g["km"] <= home["radiusKm"]
    placed = sum(g["real"] for g in out)
    estimated = sum(g["est"] for g in out)
    return {"home": {"lat": home["lat"], "lon": home["lon"], "radiusKm": home["radiusKm"]} if home else None,
            "clusters": out, "placed": placed, "estimated": estimated, "unplaced": len(rows) - placed - estimated, "gridM": 100}


def places() -> dict:
    """Every library file (not vetoed) with its GPS position, clustered for the map. Read only."""
    from studio.brand import home_place
    from studio.library import items

    from studio import gps, places as names

    rows = [r for r in items("", {}, limit=100000) if not r.get("vetoed")]
    with connect() as con:
        gps.ensure_columns(con)
        pos = {r["id"]: dict(r) for r in con.execute(
            "SELECT a.id, a.lat, a.lon, a.est_lat, a.est_lon, a.est_gap_min, b.kind AS est_kind FROM assets a"
            " LEFT JOIN assets b ON b.id = a.est_from WHERE a.lat IS NOT NULL OR a.est_lat IS NOT NULL")}
        report = gps.report(con, {r["id"] for r in rows})  # the same files the dots count, so the line adds up
    flat = []
    for r in rows:
        p = pos.get(r["id"], {})
        flat.append({"id": r["id"], "lat": p.get("lat"), "lon": p.get("lon"), "est_lat": p.get("est_lat"), "est_lon": p.get("est_lon"),
                     "est_gap": p.get("est_gap_min"), "est_kind": p.get("est_kind"), "kind": r["kind"], "captured": r.get("captured"),
                     "used": bool(r.get("usedIn") or r.get("inVlogs"))})
    home = home_place()
    out = cluster_places(flat, home)
    out["gps"] = report
    # Place names, offline, only when a person downloaded the GeoNames files (studio.places); else the map shows distances.
    idx = names.index()
    if idx is not None:
        for g in out["clusters"][:400]:
            g["place"] = names.label(g["lat"], g["lon"], idx)
        if out["home"]:
            out["home"]["place"] = names.label(home["lat"], home["lon"], idx)
    pts = ([(home["lat"], home["lon"])] if home else []) + [(g["lat"], g["lon"]) for g in out["clusters"][:20]]
    out["names"] = {**names.status(), "suggest": names.suggest_country(pts, idx) if idx is not None else None, "mb": names.KNOWN_MB}
    return out
