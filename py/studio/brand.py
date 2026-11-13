"""
FILE: py/studio/brand.py
PURPOSE: Whose reels these are: the name on the end card, the link and hashtags in posts, the home place footage
         must come from, and the rules every line of copy must pass. One answer per project.
OVERVIEW: This repository is the Tsumagoi Work&Camp workspace (README). Its main project (config.RANCH) keeps the
          ranch's values exactly as they always were: spec.json's ranch point and banned words, 嬬恋牧場Work&Camp,
          #tsumagoicamp and the ranch site. A project made in the studio is any brand and starts neutral: no home
          place (all of its footage counts), no ranch words, links or hashtags, no copy rules but its own. It reads
          <data>/brand.json, written from the studio (POST /api/brand):
            {"name": "Cafe Kumo", "nameEn": "", "link": "https://...", "tags": ["#cafekumo"],
             "place": {"lat": 35.0, "lon": 139.0, "radiusKm": 2, "awayEvents": [], "names": ["kumo"]},
             "banned": ["cheapest"], "noPrices": false}
DEPENDENCIES: studio.config
USAGE: from studio.brand import RANCH, brand, home_place, copy_rules
NOTES: Read fresh on every call (the file is tiny): an edit in the studio applies to the next reel without a restart.
"""
from __future__ import annotations

import json
import os
import re

from studio.config import DATA, RANCH, ROOT, SPEC

__all__ = ["RANCH", "brand", "home_place", "copy_rules", "save_brand", "end_card", "BRAND_FILE"]

BRAND_FILE = DATA / "brand.json"
RANCH_NAME = "嬬恋牧場Work&Camp"
RANCH_LINK = "https://tsumagoi.kensaur.us/"
HASHTAG = re.compile(r"^#[^\s#]{1,60}$")


def _own() -> dict:
    try:
        data = json.loads(BRAND_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _profile_name() -> str:
    """A new project's profile kit carries its name (server/review.mjs createWorkspace)."""
    try:
        prof = json.loads((DATA / "profiles.json").read_text(encoding="utf-8"))
        return str(prof.get("displayName") or "").strip()
    except (OSError, ValueError):
        return ""


def brand() -> dict:
    """{name, nameEn, link, tags, ranch}. The ranch's own for the main project; else this project's brand.json,
    falling back to the project's name. Never another brand's link or hashtags."""
    if RANCH:
        return {"name": RANCH_NAME, "nameEn": "Tsumagoi Work&Camp", "link": RANCH_LINK, "tags": ["#tsumagoicamp"], "handle": "@tsumagoicamp",
                "ranch": True}
    own = _own()
    name = str(own.get("name") or _profile_name() or os.environ.get("STUDIO_WORKSPACE") or "").strip()[:60]
    link = str(own.get("link") or "").strip()
    if link and not re.match(r"^https?://", link):
        link = ""
    tags = [t for t in (own.get("tags") or []) if isinstance(t, str) and HASHTAG.match(t)][:8]
    return {"name": name, "nameEn": str(own.get("nameEn") or "").strip()[:60], "link": link, "tags": tags,
            "handle": _handle(own.get("handle") or _profile_handle()), "ranch": False}


def _handle(h: str) -> str:
    """@name, or "" for none (the end card then shows the name alone)."""
    h = re.sub(r"[^\w.]", "", str(h or "").strip().lstrip("@"))[:40]
    return f"@{h}" if h else ""


def _profile_handle() -> str:
    try:
        return str(json.loads((DATA / "profiles.json").read_text(encoding="utf-8")).get("handle") or "")
    except (OSError, ValueError):
        return ""


def home_place() -> dict | None:
    """Where footage must have been shot to be used: {lat, lon, radiusKm, awayEvents, names}, or None when the project
    has no home place (then every clip it has counts). The ranch: spec.json's point and its owner-declared away events."""
    if RANCH:
        r = SPEC["ranch"]
        return {"lat": r["lat"], "lon": r["lon"], "radiusKm": r["radiusKm"], "awayEvents": list(r.get("awayEvents", [])), "names": ["tsumagoi", "嬬恋"]}
    p = _own().get("place")
    if not isinstance(p, dict):
        return None
    try:
        lat, lon, km = float(p["lat"]), float(p["lon"]), float(p.get("radiusKm") or 2)
    except (KeyError, TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or km <= 0:
        return None
    names = [str(n) for n in (p.get("names") or []) if str(n).strip()][:10]
    away = [str(e) for e in (p.get("awayEvents") or []) if str(e).strip()][:50]
    return {"lat": lat, "lon": lon, "radiusKm": km, "awayEvents": away, "names": names}


def copy_rules() -> dict:
    """{banned: [phrases], noPrices: bool, registered: name or None}. The ranch: spec.json's facts (no prices on screen,
    牧場 only inside the registered name). Any other project: only what its brand.json asks for."""
    if RANCH:
        return {"banned": list(SPEC["bannedSubstrings"]), "noPrices": True, "registered": RANCH_NAME}
    own = _own()
    banned = [str(b).strip() for b in (own.get("banned") or []) if str(b).strip()][:200]
    return {"banned": banned, "noPrices": bool(own.get("noPrices")), "registered": None}


def end_card() -> tuple[str, str]:
    """The last card of every reel: (main line, second line)."""
    b = brand()
    return (b["name"], b["nameEn"] if b["nameEn"] != b["name"] else "")


def save_brand(fields: dict) -> dict:
    """Write this project's brand.json from the studio's form. The ranch's values live in code and spec.json."""
    if RANCH:
        raise ValueError("brand: the Tsumagoi workspace's name, links and rules are fixed in shared/spec.json and studio/brand.py")
    cur = _own()
    out = dict(cur)
    if "name" in fields:
        out["name"] = str(fields.get("name") or "").strip()[:60]
    if "nameEn" in fields:
        out["nameEn"] = str(fields.get("nameEn") or "").strip()[:60]
    if "handle" in fields:
        out["handle"] = _handle(fields.get("handle"))
    if "link" in fields:
        link = str(fields.get("link") or "").strip()
        if link and not re.match(r"^https?://[^\s]+$", link):
            raise ValueError("link: a web address starting with https://")
        out["link"] = link
    if "tags" in fields:
        raw = fields.get("tags")
        items = raw.split() if isinstance(raw, str) else list(raw or [])
        tags = [t if str(t).startswith("#") else "#" + str(t) for t in items if str(t).strip()]
        bad = [t for t in tags if not HASHTAG.match(t)]
        if bad:
            raise ValueError("tags: hashtags without spaces, e.g. #cafekumo (" + ", ".join(bad[:3]) + ")")
        out["tags"] = tags[:8]
    if "banned" in fields:
        raw = fields.get("banned")
        items = raw.splitlines() if isinstance(raw, str) else list(raw or [])
        out["banned"] = [str(b).strip() for b in items if str(b).strip()][:200]
    if "noPrices" in fields:
        out["noPrices"] = bool(fields.get("noPrices"))
    if "place" in fields:
        p = fields.get("place")
        if p in (None, "", {}):
            out.pop("place", None)
        else:
            try:
                lat, lon, km = float(p["lat"]), float(p["lon"]), float(p.get("radiusKm") or 2)
            except (KeyError, TypeError, ValueError):
                raise ValueError("place: latitude and longitude as numbers, e.g. 35.68, 139.76") from None
            if not (-90 <= lat <= 90 and -180 <= lon <= 180) or not (0 < km <= 500):
                raise ValueError("place: latitude -90..90, longitude -180..180, radius 0-500 km")
            out["place"] = {"lat": lat, "lon": lon, "radiusKm": km,
                            "names": [str(n).strip() for n in (p.get("names") or []) if str(n).strip()][:10],
                            "awayEvents": [str(e).strip() for e in (p.get("awayEvents") or []) if str(e).strip()][:50]}
    BRAND_FILE.parent.mkdir(parents=True, exist_ok=True)
    BRAND_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {**brand(), "place": home_place(), "rules": copy_rules()}


def view() -> dict:
    """What GET /api/brand returns: the brand, its home place and copy rules, and whether it can be edited here."""
    return {**brand(), "place": home_place(), "rules": copy_rules(), "editable": not RANCH, "file": str(BRAND_FILE) if not RANCH else None,
            "workspaceRoot": str(ROOT)}
