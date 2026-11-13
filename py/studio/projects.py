"""
FILE: py/studio/projects.py
PURPOSE: Reels made in the editor (or proposed by the assembler) as JSON projects.
OVERVIEW: A project has the same shape as a reel in reel_specs.py plus its own post
          text. The editor saves edits here (order, trims, added clips, captions);
          `python -m studio reels --build <slug>` renders it like any house reel.
DEPENDENCIES: studio.config
USAGE: all_projects(), load(slug), save(project)
NOTES: Files live in tsumagoi-studio/projects/<slug>.json and are reviewable in git.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from studio.config import PROJECTS

DIR = PROJECTS


def all_projects() -> list[dict]:
    if not DIR.exists():
        return []
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(DIR.glob("*.json"))]


def load(slug: str) -> dict | None:
    path = DIR / f"{slug}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


AI_KEYS = ("voice", "ai")


def keep_ai(project: dict) -> dict:
    """What the AI tools added stays when a reel is saved from somewhere that does not carry it (the editor sends the
    shots and words it shows): the read-aloud voice, the AI notes (they decide the platform's AI label) and each
    shot's AI clip, while the shot still shows the same source. A shot that was swapped loses its clip, as it should."""
    old = load(str(project.get("slug", ""))) if re.fullmatch(r"[a-z0-9][a-z0-9-]*", str(project.get("slug", ""))) else None
    if not old:
        return project
    for key in AI_KEYS:
        if key not in project and key in old:
            project[key] = old[key]
    for key in ("ai_clip", "ai_foley", "ai_behind"):
        made = {s.get("src"): s[key] for s in old.get("shots", []) if s.get(key)}
        for s in project.get("shots", []):
            if key not in s and s.get("src") in made:
                s[key] = made[s["src"]]
    return project


def save(project: dict) -> Path:
    # Never a leading "-": the slug goes on the command line (`studio reels --build <slug>`), where it would read as an option.
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", project.get("slug", "")):
        raise ValueError("slug must be lowercase letters, digits and dashes, starting with a letter or digit")
    DIR.mkdir(parents=True, exist_ok=True)
    path = DIR / f"{project['slug']}.json"
    path.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
