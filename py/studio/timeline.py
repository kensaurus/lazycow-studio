"""
FILE: py/studio/timeline.py
PURPOSE: Where the trip went, from Google Maps Timeline: the places visited (when, how long, which country) and the
         legs between them (drive, flight, walk; how far, how long; the real path), so a trip video can say
         "Masai Mara · Kenya · 2 nights" and draw the road it took.
OVERVIEW: import_file() reads an export from the phone (Android on-device Timeline.json, iPhone location-history.json),
          an older Takeout (Semantic Location History, Records.json) or a GPX, keeps only the trip's days, drops home and
          work and every raw signal, and writes the slim DATA/vlog-timeline.json. match() places each photo and video in
          the visit or leg it was taken in, with the right clock for each. route() gives the series map its places.
PRIVACY: local only; the file the person gives is deleted after reading (by the server); nothing outside the trip
         window, no home or work, no raw GPS or Wi-Fi scans, no Google place names (the file has none). Names come from
         the person. Coordinates never reach titles, descriptions or AI prompts.
FORMATS: research 13 Nov (scratchpad research-timeline.md): Timelinize's models.go, Dawarich, locationhistoryformat.com.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from studio.config import DATA, ROOT

TIMELINE_FILE = DATA / "vlog-timeline.json"
GEO = [ROOT / "public" / "geo" / "east-africa-50m.json", ROOT / "shared" / "geo" / "world-110m.json"]
MIN_VISIT_MIN = 10        # shorter stops are kept hidden (a traffic light is not a place)
HOME_TRIM_KM = 1.0        # path points this close to home or work are dropped, so a route never starts at the door
MAX_PATH_POINTS = 400     # per day, after simplifying
MODES = {
    "drive": {"IN_PASSENGER_VEHICLE", "IN_VEHICLE", "IN_TAXI", "MOTORCYCLING", "IN_CAR", "DRIVING", "DRIVE"},
    "flight": {"FLYING", "IN_AIRPLANE"},
    "walk": {"WALKING", "HIKING", "RUNNING", "ON_FOOT"},
    "bus": {"IN_BUS"},
    "train": {"IN_TRAIN", "IN_SUBWAY", "IN_TRAM", "IN_RAIL_VEHICLE"},
    "boat": {"IN_FERRY", "BOATING", "SAILING", "KAYAKING"},
    "bike": {"CYCLING"},
}


# ---------- small parsers ----------------------------------------------------------------------------------------
def _latlng(v) -> tuple[float, float] | None:
    """'-1.40612°, 35.01234°' (Android), 'geo:-1.406,35.012' (iPhone), {latitudeE7, longitudeE7} / {latE7, lngE7}."""
    if v is None:
        return None
    if isinstance(v, dict):
        if "latLng" in v or "LatLng" in v:
            return _latlng(v.get("latLng") or v.get("LatLng"))
        la = v.get("latitudeE7", v.get("latE7"))
        lo = v.get("longitudeE7", v.get("lngE7"))
        if la is not None and lo is not None:
            return (int(la) / 1e7, int(lo) / 1e7)
        return None
    m = re.match(r"\s*(?:geo:)?\s*(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?\s*$", str(v))
    return (float(m.group(1)), float(m.group(2))) if m else None


def _time(v) -> datetime | None:
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
        return datetime.fromtimestamp(int(v) / 1000, tz=timezone.utc)
    s = str(v).replace("Z", "+00:00")
    try:
        t = datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _num(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _mode(t) -> str:
    key = str(t or "").upper().replace(" ", "_")
    for mode, names in MODES.items():
        if key in names:
            return mode
    return "move"


def _private(semantic) -> bool:
    s = str(semantic or "").upper()
    return "HOME" in s or "WORK" in s


def km_between(a, b) -> float:
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(min(1.0, h)))


# ---------- formats -> segments --------------------------------------------------------------------------------------
def _seg(kind, start, end, off_min=None, **kw) -> dict:
    return {"kind": kind, "start": start, "end": end, "off": off_min, **kw}


def _ondevice(items: list, private_points: list) -> list[dict]:
    """Android (object.semanticSegments) and iPhone (top-level array): the same segment shapes, different spellings."""
    out = []
    for it in items:
        start, end = _time(it.get("startTime")), _time(it.get("endTime"))
        if not start or not end:
            continue
        off = it.get("startTimeTimezoneUtcOffsetMinutes")
        off = int(off) if off is not None else int(start.utcoffset().total_seconds() // 60)
        if "visit" in it:
            v = it["visit"]
            top = v.get("topCandidate") or {}
            where = _latlng(top.get("placeLocation"))
            if not where:
                continue
            if _private(top.get("semanticType")):
                private_points.append(where)
                out.append(_seg("private", start, end, off))  # counted as hidden; no position kept
                continue
            out.append(_seg("visit", start, end, off, lat=where[0], lon=where[1], placeId=top.get("placeId") or top.get("placeID"),
                            conf=_num(top.get("probability"), _num(v.get("probability"), 1.0)), name=None))
        elif "activity" in it:
            a = it["activity"]
            out.append(_seg("leg", start, end, off, mode=_mode((a.get("topCandidate") or {}).get("type")),
                            km=round(_num(a.get("distanceMeters")) / 1000, 1), a=_latlng(a.get("start")), b=_latlng(a.get("end")), path=[]))
        elif "timelinePath" in it:
            pts = []
            for p in it["timelinePath"]:
                ll = _latlng(p.get("point"))
                t = _time(p.get("time")) or (start + timedelta(minutes=_num(p.get("durationMinutesOffsetFromStartTime"))))
                if ll:
                    pts.append((ll[0], ll[1], t))
            out.append(_seg("path", start, end, off, points=pts))
    return out


def _semantic(objs: list, private_points: list) -> list[dict]:
    """Takeout's Semantic Location History: placeVisit / activitySegment, UTC times, E7 coordinates, names included."""
    out = []
    for o in objs:
        if "placeVisit" in o:
            pv = o["placeVisit"]
            loc = pv.get("location") or {}
            d = pv.get("duration") or {}
            start, end = _time(d.get("startTimestamp") or d.get("startTimestampMs")), _time(d.get("endTimestamp") or d.get("endTimestampMs"))
            where = _latlng(loc)
            if not (start and end and where):
                continue
            if _private(loc.get("semanticType")):
                private_points.append(where)
                out.append(_seg("private", start, end, None))
                continue
            out.append(_seg("visit", start, end, None, lat=where[0], lon=where[1], placeId=loc.get("placeId"),
                            conf=_num(loc.get("locationConfidence"), 100.0) / 100, name=loc.get("name")))
        elif "activitySegment" in o:
            a = o["activitySegment"]
            d = a.get("duration") or {}
            start, end = _time(d.get("startTimestamp") or d.get("startTimestampMs")), _time(d.get("endTimestamp") or d.get("endTimestampMs"))
            if not (start and end):
                continue
            pts = []
            for p in ((a.get("simplifiedRawPath") or {}).get("points") or []):
                ll = _latlng(p)
                if ll:
                    pts.append((ll[0], ll[1], _time(p.get("timestamp") or p.get("timestampMs")) or start))
            if not pts:
                for p in ((a.get("waypointPath") or {}).get("waypoints") or []):
                    ll = _latlng(p)
                    if ll:
                        pts.append((ll[0], ll[1], start))
            out.append(_seg("leg", start, end, None, mode=_mode(a.get("activityType")), km=round(_num(a.get("distance")) / 1000, 1),
                            a=_latlng(a.get("startLocation")), b=_latlng(a.get("endLocation")), path=pts))
    return out


def _records(locs: list) -> list[dict]:
    """Records.json: raw points only, so it can only draw a path."""
    pts = []
    for p in locs:
        ll, t = _latlng(p), _time(p.get("timestamp") or p.get("timestampMs"))
        if ll and t:
            pts.append((ll[0], ll[1], t))
    pts.sort(key=lambda p: p[2])
    return [_seg("path", pts[0][2], pts[-1][2], None, points=pts)] if pts else []


def _gpx(text: str) -> list[dict]:
    pts = [(float(la), float(lo), _time(t)) for la, lo, t in re.findall(
        r'<trkpt[^>]*\blat="(-?[\d.]+)"[^>]*\blon="(-?[\d.]+)"[^>]*>.*?<time>([^<]+)</time>', text, re.S)]
    pts += [(float(la), float(lo), _time(t)) for lo, la, t in re.findall(
        r'<trkpt[^>]*\blon="(-?[\d.]+)"[^>]*\blat="(-?[\d.]+)"[^>]*>.*?<time>([^<]+)</time>', text, re.S)]
    pts = sorted((p for p in pts if p[2]), key=lambda p: p[2])
    return [_seg("path", pts[0][2], pts[-1][2], None, points=pts)] if pts else []


def sniff(path: Path) -> tuple[str, list[dict], list]:
    """(format, segments, private points) from a file; raises ValueError with a plain message when it is not one."""
    raw = Path(path).read_bytes()
    text = raw.decode("utf-8-sig", errors="replace")
    head = text.lstrip()[:400].lower()
    if head.startswith("<?xml") or "<gpx" in head:
        return "gpx", _gpx(text), []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as err:
        raise ValueError("This is not a Timeline file (it is not JSON or GPX).") from err
    private: list = []
    if isinstance(data, dict) and "semanticSegments" in data:
        for fp in ((data.get("userLocationProfile") or {}).get("frequentPlaces") or []):
            if _private(fp.get("label")):
                ll = _latlng(fp.get("placeLocation"))
                if ll:
                    private.append(ll)
        return "android", _ondevice(data["semanticSegments"], private), private
    if isinstance(data, list) and data and isinstance(data[0], dict) and "startTime" in data[0]:
        return "iphone", _ondevice(data, private), private
    if isinstance(data, dict) and "timelineObjects" in data:
        return "takeout-semantic", _semantic(data["timelineObjects"], private), private
    if isinstance(data, dict) and isinstance(data.get("locations"), list):
        return "takeout-records", _records(data["locations"]), []
    raise ValueError("This JSON is not a Google Maps Timeline export. On the phone: Timeline › Export Timeline data.")


# ---------- countries, offline ---------------------------------------------------------------------------------------
_COUNTRIES: list | None = None


def _countries() -> list:
    global _COUNTRIES
    if _COUNTRIES is None:
        _COUNTRIES = []
        for f in GEO:
            try:
                for c in json.loads(f.read_text(encoding="utf-8"))["countries"]:
                    xs = [x for r in c["rings"] for x, _ in r]
                    ys = [y for r in c["rings"] for _, y in r]
                    _COUNTRIES.append((c["name"], (min(xs), min(ys), max(xs), max(ys)), c["rings"]))
            except (OSError, ValueError, KeyError):
                continue
    return _COUNTRIES


def _inside(x, y, ring) -> bool:
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            hit = not hit
        j = i
    return hit


def country(lat: float, lon: float, near_km: float = 30.0) -> str | None:
    """The country a point is in, from Natural Earth outlines on this computer (the finer East Africa map first). A
    point just off a coarse coastline (a coastal city, an airport by the sea) takes the nearest country within near_km."""
    for name, (x0, y0, x1, y1), rings in _countries():
        if x0 <= lon <= x1 and y0 <= lat <= y1 and any(_inside(lon, lat, r) for r in rings):
            return name
    pad = near_km / 100
    best, best_km = None, near_km
    for name, (x0, y0, x1, y1), rings in _countries():
        if not (x0 - pad <= lon <= x1 + pad and y0 - pad <= lat <= y1 + pad):
            continue
        for r in rings:
            for x, y in r:
                k = km_between((lat, lon), (y, x))
                if k < best_km:
                    best, best_km = name, k
    return best


# ---------- normalise ----------------------------------------------------------------------------------------------
def _simplify(pts: list, tol_km: float = 0.05) -> list:
    """Ramer–Douglas–Peucker on (lat, lon, minute) points, tolerance about 50 m."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    best, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        d = _dist_to_segment(pts[i], a, b)
        if d > best:
            best, idx = d, i
    if best <= tol_km:
        return [a, b]
    return _simplify(pts[: idx + 1], tol_km)[:-1] + _simplify(pts[idx:], tol_km)


def _dist_to_segment(p, a, b) -> float:
    ky = 111.32
    kx = 111.32 * math.cos(math.radians(a[0]))
    px, py = (p[1] - a[1]) * kx, (p[0] - a[0]) * ky
    bx, by = (b[1] - a[1]) * kx, (b[0] - a[0]) * ky
    seg = bx * bx + by * by
    t = max(0.0, min(1.0, (px * bx + py * by) / seg)) if seg else 0.0
    return math.hypot(px - t * bx, py - t * by)


def _local(t: datetime, off: int) -> datetime:
    return (t.astimezone(timezone.utc) + timedelta(minutes=off)).replace(tzinfo=None)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalise(segs: list[dict], private: list, window: tuple[str, str] | None, default_off: int | None = None) -> dict:
    """Segments -> {days: {date: {offsetMin, visits, legs}}}, only inside `window` (inclusive local dates)."""
    near_private = lambda ll: any(km_between(ll, p) < HOME_TRIM_KM for p in private)  # noqa: E731
    # A timezone for each segment: its own, else the nearest segment's that has one, else the trip's.
    offs = [s["off"] for s in segs if s["off"] is not None]
    fallback = default_off if default_off is not None else (offs[0] if offs else 0)
    days: dict = {}
    hidden = 0
    vid = lid = 0
    paths = [s for s in segs if s["kind"] == "path"]
    for s in sorted((s for s in segs if s["kind"] != "path"), key=lambda s: s["start"]):
        off = s["off"] if s["off"] is not None else fallback
        day = _local(s["start"], off).date().isoformat()
        if window and not (window[0] <= day <= window[1]):
            continue
        if s["kind"] == "private":
            hidden += 1
            continue
        d = days.setdefault(day, {"offsetMin": off, "visits": [], "legs": []})
        minutes = max(0, round((s["end"] - s["start"]).total_seconds() / 60))
        if s["kind"] == "visit":
            if near_private((s["lat"], s["lon"])):
                hidden += 1
                continue
            vid += 1
            d["visits"].append({"id": f"v{vid}", "start": _iso(s["start"]), "end": _iso(s["end"]), "min": minutes,
                                "lat": round(s["lat"], 5), "lon": round(s["lon"], 5), "placeId": s.get("placeId"),
                                "country": country(s["lat"], s["lon"]), "name": None, "nameSource": None,
                                "show": minutes >= MIN_VISIT_MIN, "conf": round(s.get("conf") or 0, 2)})
        else:
            pts = list(s.get("path") or [])
            for p in paths:  # Android/iPhone keep the path in its own segments: take the points inside this leg
                pts += [q for q in p["points"] if s["start"] <= q[2] <= s["end"]]
            pts.sort(key=lambda q: q[2])
            pts = [q for q in pts if not near_private((q[0], q[1]))]
            if s.get("a") and not near_private(s["a"]) and (not pts or pts[0][:2] != s["a"]):
                pts.insert(0, (s["a"][0], s["a"][1], s["start"]))
            if s.get("b") and not near_private(s["b"]) and (not pts or pts[-1][:2] != s["b"]):
                pts.append((s["b"][0], s["b"][1], s["end"]))
            simple = _simplify([(round(q[0], 5), round(q[1], 5), round((q[2] - s["start"]).total_seconds() / 60)) for q in pts]) if s["mode"] != "flight" else \
                [(round(q[0], 5), round(q[1], 5), 0) for q in (pts[:1] + pts[-1:])]
            km = s.get("km") or (round(sum(km_between(simple[i][:2], simple[i + 1][:2]) for i in range(len(simple) - 1)), 1) if len(simple) > 1 else 0)
            lid += 1
            d["legs"].append({"id": f"l{lid}", "start": _iso(s["start"]), "end": _iso(s["end"]), "min": minutes, "mode": s["mode"],
                              "km": km, "path": [list(q) for q in simple]})
    for d in days.values():  # keep each day's paths small
        total = sum(len(l["path"]) for l in d["legs"])
        if total > MAX_PATH_POINTS:
            for leg in d["legs"]:
                step = math.ceil(total / MAX_PATH_POINTS)
                leg["path"] = leg["path"][::step] + ([leg["path"][-1]] if leg["path"] and (len(leg["path"]) - 1) % step else [])
        prev = None  # each leg names the visits it joins
        for item in sorted(d["visits"] + d["legs"], key=lambda x: x["start"]):
            if item["id"].startswith("l"):
                item["from"] = prev
            else:
                for leg in d["legs"]:
                    if leg.get("from") == prev and "to" not in leg and leg["start"] <= item["start"]:
                        leg["to"] = item["id"]
                prev = item["id"]
    return {"days": dict(sorted(days.items())), "hidden": hidden}


def import_file(path: Path, window: tuple[str, str] | None = None, out: Path | None = None) -> dict:
    """Read an export, keep the trip's days, write the slim file. Returns a summary (no coordinates)."""
    fmt, segs, private = sniff(path)
    tl = normalise(segs, private, window)
    tl.update({"imported": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": fmt, "file": Path(path).name,
               "window": {"from": window[0], "to": window[1]} if window else None})
    old = load(out)
    if old:  # names and choices the person made on an earlier import stay with the same place
        keep = {(v.get("placeId") or f"{v['lat']},{v['lon']}"): v for d in old.get("days", {}).values() for v in d["visits"]}
        for d in tl["days"].values():
            for v in d["visits"]:
                k = keep.get(v.get("placeId") or f"{v['lat']},{v['lon']}")
                if k:
                    v.update({x: k[x] for x in ("name", "nameSource", "show") if x in k})
    target = out or TIMELINE_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(tl, ensure_ascii=False, indent=1), encoding="utf-8")
    return summary(tl)


def footage_window() -> tuple[str, str] | None:
    """The trip's days as the footage gives them: its first day - 1 to its last day + 1 (dates, inclusive)."""
    from studio.db import connect

    with connect() as con:
        row = con.execute("SELECT MIN(captured_at), MAX(captured_at) FROM assets WHERE captured_at IS NOT NULL AND captured_at != ''").fetchone()
    lo, hi = (_time(row[0]), _time(row[1])) if row else (None, None)
    if not lo or not hi:
        return None
    return ((lo - timedelta(days=1)).date().isoformat(), (hi + timedelta(days=1)).date().isoformat())


def load(path: Path | None = None) -> dict | None:
    p = path or TIMELINE_FILE
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def summary(tl: dict | None) -> dict:
    """What the page shows: per day, visits (no coordinates beyond a Maps link) and legs, plus the format."""
    if not tl:
        return {"imported": None}
    days = []
    for day, d in tl["days"].items():
        days.append({"day": day, "offsetMin": d.get("offsetMin", 0), "visits": [{k: v[k] for k in ("id", "start", "end", "min", "country", "name", "show", "placeId", "lat", "lon")} for v in d["visits"]],
                     "legs": [{k: l[k] for k in ("id", "start", "end", "min", "mode", "km")} for l in d["legs"]]})
    return {"imported": tl.get("imported"), "source": tl.get("source"), "window": tl.get("window"), "hidden": tl.get("hidden", 0), "days": days}


def choose(changes: list[dict], path: Path | None = None) -> dict:
    """The person's edits: [{id, day, name?, show?}]. Names are their own words (up to 60 characters)."""
    tl = load(path)
    if not tl:
        raise ValueError("No Timeline in this project yet.")
    for ch in changes:
        d = tl["days"].get(str(ch.get("day")))
        v = next((x for x in (d or {}).get("visits", []) if x["id"] == ch.get("id")), None)
        if not v:
            continue
        if "name" in ch:
            name = re.sub(r"[\x00-\x1f<>]", "", str(ch["name"] or "")).strip()[:60]
            v["name"], v["nameSource"] = (name or None), ("person" if name else None)
        if "show" in ch:
            v["show"] = bool(ch["show"])
    (path or TIMELINE_FILE).write_text(json.dumps(tl, ensure_ascii=False, indent=1), encoding="utf-8")
    return summary(tl)


def forget(path: Path | None = None) -> bool:
    p = path or TIMELINE_FILE
    if p.exists():
        p.unlink()
        return True
    return False


# ---------- footage -> visits and legs --------------------------------------------------------------------------------
def match(items: list[dict], tl: dict | None = None, snap_min: int = 30) -> dict:
    """{path: {visit|leg, day, approx}} for each item {path, captured, clock: 'utc'|'wall'}.
    A video's creation time is UTC; a photo's EXIF time is the camera's wall clock stamped +00:00 in the catalog, so it is
    read as local time in the timeline's offset for that moment."""
    tl = tl if tl is not None else load()
    if not tl:
        return {}
    segs = []
    for day, d in tl["days"].items():
        off = d.get("offsetMin", 0)
        for v in d["visits"]:
            if v.get("show", True):
                segs.append((_time(v["start"]), _time(v["end"]), "visit", v["id"], day, off))
        for l in d["legs"]:
            segs.append((_time(l["start"]), _time(l["end"]), "leg", l["id"], day, off))
    segs.sort(key=lambda s: s[0])
    out = {}
    for it in items:
        t = _time(it.get("captured"))
        if not t or not segs:
            continue
        if it.get("clock") == "wall":
            wall = t.replace(tzinfo=None)
            near = min(segs, key=lambda s: abs((_local(s[0], s[5]) - wall).total_seconds()))
            t = (wall - timedelta(minutes=near[5])).replace(tzinfo=timezone.utc)
        hit = next((s for s in segs if s[0] <= t <= s[1] and s[2] == "visit"), None) or next((s for s in segs if s[0] <= t <= s[1]), None)
        approx = False
        if not hit:
            near = min(segs, key=lambda s: min(abs((t - s[0]).total_seconds()), abs((t - s[1]).total_seconds())))
            gap = min(abs((t - near[0]).total_seconds()), abs((t - near[1]).total_seconds())) / 60
            if gap > snap_min:
                continue
            hit, approx = near, True
        out[it["path"]] = {hit[2]: hit[3], "day": hit[4], "approx": approx}
    return out


def route(tl: dict | None = None) -> dict:
    """{day: [{place, country, lat, lon, min, start, end}]}: the shown visits, for the series map and place tags.
    The place is the person's name for it, or none (the map then shows the country only)."""
    tl = tl if tl is not None else load()
    if not tl:
        return {}
    out = {}
    for day, d in tl["days"].items():
        stops = [{"place": v.get("name"), "country": v.get("country"), "lat": v["lat"], "lon": v["lon"], "min": v["min"],
                  "start": v["start"], "end": v["end"]} for v in d["visits"] if v.get("show")]
        legs = [{"mode": l["mode"], "km": l["km"], "min": l["min"], "path": l["path"]} for l in d["legs"]]
        if stops or legs:
            out[day] = {"stops": stops, "legs": legs}
    return out


def stay_words(minutes: int) -> str:
    """'3 h 10 min', '2 nights' (a stay over 10 hours that crosses nights counts nights)."""
    if minutes >= 20 * 60:
        n = round(minutes / (24 * 60)) or 1
        return f"{n} night{'s' if n > 1 else ''}"
    h, m = divmod(minutes, 60)
    return f"{h} h {m:02d} min" if h else f"{m} min"


def leg_words(leg: dict) -> str:
    """'4 h 08 min drive · 212 km', 'Flight · 1 h 05 min'."""
    dur = stay_words(leg["min"]) if leg["min"] < 20 * 60 else f"{leg['min'] // 60} h"
    if leg["mode"] == "flight":
        return f"Flight · {dur}"
    noun = {"drive": "drive", "walk": "walk", "bus": "bus ride", "train": "train ride", "boat": "boat ride", "bike": "ride"}.get(leg["mode"], "journey")
    return f"{dur} {noun}" + (f" · {round(leg['km'])} km" if leg.get("km") else "")
