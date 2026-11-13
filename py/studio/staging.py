"""
FILE: py/studio/staging.py
PURPOSE: How a reel is staged beyond its text layout: the picture look, the word recipe, the kicker
         and the loop ending (src/looks.tsx), plus the time-of-day and season marks some recipes show.
OVERVIEW: shared/looks.json lists the looks (film, punch, split, ember) and recipes (countdown,
          timeline, pov, altitude). A theme in assemble.py sets defaults; a project may override them.
          `staging(reel)` resolves what the build passes to Remotion, falling back to the theme when an
          editor save dropped a field. Marks come from each clip's own data, never from new copy:
          朝 昼 夕 夜 from its darkness (library tod) and capture hour in Japan time, 春 夏 秋 冬 from its
          capture month (library season).
DEPENDENCIES: studio.config, studio.guard (kicker copy), studio.assemble (theme defaults, lazily)
USAGE: staging(reel) -> {"look", "recipe", "kicker", "loop"}; day_mark(tod, captured); season_mark(season)
NOTES: Research: docs/research/2026-11-08-reel-effects.md. The kicker is a framing label, guard-checked.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from studio.config import ROOT
from studio.guard import assert_copy

SPEC = json.loads((ROOT / "shared" / "looks.json").read_text(encoding="utf-8"))
LOOKS = tuple(SPEC["looks"])
RECIPES = tuple(SPEC["recipes"])

DAY = {"朝": "morning", "昼": "midday", "夕": "dusk", "夜": "night"}
DAY_ORDER = {k: i for i, k in enumerate(DAY)}
SEASON = {"spring": ("春", "spring"), "summer": ("夏", "summer"), "autumn": ("秋", "autumn"), "winter": ("冬", "winter")}
JST = timezone(timedelta(hours=9))


def _hour_jst(captured: str | None) -> int | None:
    """Capture hour at the ranch. A stamp with a zone (most are UTC "Z") is moved to Japan time;
    one without a zone is taken as camera-local, which for this footage is Japan."""
    if not captured:
        return None
    try:
        t = datetime.fromisoformat(captured.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (t.astimezone(JST) if t.tzinfo else t).hour


def day_mark(tod: str | None, captured: str | None) -> str | None:
    """朝 / 昼 / 夕 / 夜 for one clip. Darkness decides night and dusk; the clock splits the day."""
    if tod == "night":
        return "夜"
    if tod == "dusk":
        return "夕"
    hour = _hour_jst(captured)
    if hour is None:
        return "昼" if tod == "day" else None
    if 4 <= hour < 10:
        return "朝"
    if 10 <= hour < 16:
        return "昼"
    if 16 <= hour < 19:
        return "夕"
    return "夜"


def season_mark(season: str | None) -> tuple[str, str] | None:
    return SEASON.get(season or "")


def mark_for(kind: str, tod: str | None, season: str | None, captured: str | None) -> tuple[str, str] | None:
    """The (ja, en) mark a recipe shows on a shot: "day" for the timeline, "season" for the split look."""
    if kind == "day":
        d = day_mark(tod, captured)
        return (d, DAY[d]) if d else None
    if kind == "season":
        return season_mark(season)
    return None


def mark_kind(stage: dict) -> str | None:
    """Which mark the staging shows: time of day for the timeline, season for a split screen."""
    if stage.get("recipe") == "timeline":
        return "day"
    if stage.get("look") == "split":
        return "season"
    return None


def number_lines(beats: list[dict]) -> list[dict]:
    """Countdown: the proof lines get 3, 2, 1 (as many as there are), last line is 1."""
    lines = [b for b in beats if b["kind"] == "line"]
    out = []
    k = 0
    for b in beats:
        b = dict(b)
        if b["kind"] == "line":
            b["n"] = len(lines) - k
            k += 1
        out.append(b)
    return out


def staging(reel: dict) -> dict:
    """Look, recipe, kicker and loop for a reel: the project's own value when it has the key, else its
    theme's. Unknown names fall back to the house reel (None)."""
    from studio.assemble import THEMES

    theme = THEMES.get(reel.get("theme") or "") or {}

    def pick(key, default=None):
        return reel[key] if key in reel else theme.get(key, default)

    look = pick("look")
    recipe = pick("recipe")
    kicker = pick("kicker")
    if kicker:
        kicker = {"ja": assert_copy(str(kicker.get("ja", ""))), "en": assert_copy(str(kicker.get("en", "")))}
    return {
        "look": look if look in LOOKS else None,
        "recipe": recipe if recipe in RECIPES else None,
        "kicker": kicker if kicker and kicker["ja"] else None,
        "loop": bool(pick("loop", False)),
    }


def portrait_shots(reel: dict) -> list[bool]:
    """Per shot: was the source shot upright (library orientation)? A split half then keeps the tall grade,
    because the wide grade of an upright clip is filled out with blur."""
    from studio.db import connect
    from studio.reels import resolve

    with connect() as con:
        rows = [con.execute(
            "SELECT l.orientation FROM assets a JOIN library l ON l.asset_id = a.id WHERE lower(a.path) = lower(?)", (str(resolve(s["src"])),),
        ).fetchone() for s in reel["shots"]]
    return [bool(r and r["orientation"] == "portrait") for r in rows]


def shot_marks(reel: dict, kind: str | None) -> list[tuple[str, str] | None]:
    """Per shot: its stored mark, else one read from the library row of its source file."""
    if not kind:
        return [None] * len(reel["shots"])
    from studio.db import connect
    from studio.reels import resolve

    out: list[tuple[str, str] | None] = []
    with connect() as con:
        for s in reel["shots"]:
            if s.get("label"):
                out.append((s["label"], s.get("labelEn") or ""))
                continue
            row = con.execute(
                "SELECT l.season, l.tod, a.captured_at FROM assets a LEFT JOIN library l ON l.asset_id = a.id WHERE lower(a.path) = lower(?)",
                (str(resolve(s["src"])),),
            ).fetchone()
            out.append(mark_for(kind, row["tod"], row["season"], row["captured_at"]) if row else None)
    return out
