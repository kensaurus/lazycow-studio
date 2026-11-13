"""
FILE: py/studio/typekits.py
PURPOSE: A reel's type pairing, colours, word motion and colour grade (shared/type-kits.json): each new reel draws one of
         each, so reels stop all looking alike; the person can change any of them in the reel editor.
OVERVIEW: pick() draws by weight with the reel's own seeded rng and gives what the last few reels used a quarter of its
          chance, so two reels in a row rarely share a style. The first entry of each list is the house style; a reel
          without these fields renders as before. grade_filter() is the ffmpeg filter for a grade (laid before the house
          look in studio.shot, through the per-shot colour filter).
USAGE: from studio.typekits import pick, grade_filter, recent
"""
from __future__ import annotations

import json
from functools import lru_cache

from studio.config import ROOT

FIELDS = {"typeKit": "kits", "palette": "palettes", "motion": "motions", "grade": "grades"}
RECENT = 4  # how many of the newest reels count as "just used"


@lru_cache(maxsize=1)
def table() -> dict:
    return json.loads((ROOT / "shared" / "type-kits.json").read_text(encoding="utf-8"))


def ids(field: str) -> list[str]:
    return [x["id"] for x in table()[FIELDS[field]]]


def grade_filter(grade: str | None) -> str:
    """The ffmpeg filter of a grade; "" for the house grade or an unknown name."""
    return next((g["filter"] for g in table()["grades"] if g["id"] == grade), "")


def recent(n: int = RECENT) -> list[dict]:
    """The style fields of the n newest reels (by file time), newest first."""
    from studio.projects import DIR

    if not DIR.exists():
        return []
    out = []
    for p in sorted(DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)[:n]:
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({k: r.get(k) for k in FIELDS})
    return out


def pick(rng, recent_styles: list[dict] | None = None) -> dict:
    """One of each (typeKit, palette, motion, grade), weighted, seeded by rng; a value one of the recent reels used gets a
    quarter of its weight. Night and fire themes keep the house grade (their dark is graded by the house look)."""
    used = recent_styles or []
    out = {}
    for field, key in FIELDS.items():
        rows = table()[key]
        weights = [float(r.get("weight", 1)) * (0.25 if any(u.get(field) == r["id"] for u in used) else 1.0) for r in rows]
        out[field] = rng.choices([r["id"] for r in rows], weights=weights, k=1)[0]
    return out
