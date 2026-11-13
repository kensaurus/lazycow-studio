"""
FILE: py/studio/footage.py
PURPOSE: How much usable footage is left, which camera it came from, how often clips are reused, and what to
         film next with which camera. Read only, except `backfill_cameras`, which fills assets.camera from each
         file's own metadata (EXIF Make/Model for photos, the container's make/model tags for video).
DEPENDENCIES: studio.db, studio.library (the tagged rows and their usage), studio.assemble (themes), studio.media.
USAGE: python -m studio footage health | cameras [--limit N]
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
VIDEOS_IN_MIXED_REEL = 4    # a reel leaning on photos still needs about four moving shots
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


def _health(now: datetime | None = None) -> dict:
    from studio.assemble import THEMES, film_next
    from studio.library import items

    now = now or datetime.now(timezone.utc)
    rows = [r for r in items("", {}, limit=100000) if not r.get("vetoed")]
    with connect() as con:
        cams = {r["path"]: r["camera"] for r in con.execute("SELECT path, camera FROM assets")}
    ranch = [r for r in rows if str(r.get("place", "")).startswith("ranch")]
    clips = [r for r in ranch if r["kind"] == "video" and (r.get("duration") or 0) >= 2.5 and (r.get("junk") or 0) < 0.5]

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
    fresh = reuse["never"]
    room = sum(max(0, VIDEO_REUSE_CAP - len(r["usedIn"])) for r in clips)  # uses left before each video reaches the cap
    more = {"low": room // CLIPS_PER_REEL, "high": room // VIDEOS_IN_MIXED_REEL, "cap": VIDEO_REUSE_CAP}
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
        themes.append({"theme": key, "title": theme["title_ja"], "need": theme["slots"][0], "left": t["left"] if t else None,
                       "short": bool(t), "camera": camera})
    shoot = sorted((t for t in themes if t["short"]), key=lambda t: (t["left"], t["theme"]))
    return {
        "clips": len(clips), "fresh": fresh, "reelsLeft": fresh // CLIPS_PER_REEL, "more": more, "reuse": reuse,
        "mostReused": [{"file": r["file"], "uses": len(r["usedIn"]), "camera": cam(r)} for r in most],
        "cameras": cameras, "unknownCameras": sum(1 for r in ranch if cams.get(r["path"]) is None),  # never read ('' = read, none recorded)
        "shoot": shoot, "themes": len(themes), "asOf": now.isoformat(),
    }
