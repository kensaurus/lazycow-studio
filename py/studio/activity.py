"""
FILE: py/studio/activity.py
PURPOSE: One read of everything the studio did and what it cost: paid AI calls, the local
         models, how each reel was assembled (the search line per shot, the candidates, the
         scores, the seed), the render and upload history, and YouTube API use.
OVERVIEW: Read-only. Sources: the `spend` table (every paid call with model, tokens, USD and,
          for AI assist, provider and reel slug), projects/*.json (`trace`, `seed`; older reels are rebuilt from
          their shot roles), <data>/renders/jobs.jsonl (written by server/review.mjs when a
          job ends) and the `posts` table.
DEPENDENCIES: studio.db, studio.projects, studio.assemble (THEMES), studio.config
USAGE: summary() -> dict; served as GET /api/log through the editor helper (cmd "log").
NOTES: YouTube units are an estimate from the documented costs: an upload uses the
       videos.insert bucket (1 call), a playlist insert 50 units, a list call 1.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

from studio.config import DATA, PROJECTS, daily_budget, openrouter_key
from studio.db import connect

LOCAL_MODELS = [
    {"name": "OpenCLIP ViT-B-32 (quickgelu)", "use": "tags footage and matches each shot's search line", "where": "this PC"},
    {"name": "YuNet face detector", "use": "faces: consent flags and Blur faces", "where": "this PC"},
    {"name": "LAION aesthetic predictor (linear head on CLIP)", "use": "how good a clip looks, 1-10: a small nudge when picking", "where": "this PC"},
    {"name": "librosa beat tracker", "use": "cuts on the music's beats", "where": "this PC"},
    {"name": "ffmpeg + Remotion", "use": "grade, crop, type and render", "where": "this PC"},
    {"name": "ffmpeg v360", "use": "360 photos and video: stitch, level and reframe with a moving virtual camera", "where": "this PC"},
]
ROLE = re.compile(r"auto: (.+) \(match ([0-9.]+|None)\)")


def _spend() -> dict:
    with connect() as con:
        rows = [dict(r) for r in con.execute("SELECT ts, model, purpose, usd, tokens_in, tokens_out, note, provider, slug FROM spend ORDER BY ts DESC LIMIT 200")]
        total = con.execute("SELECT COALESCE(SUM(usd), 0) FROM spend").fetchone()[0]
        today = con.execute("SELECT COALESCE(SUM(usd), 0) FROM spend WHERE ts LIKE ?", (date.today().isoformat() + "%",)).fetchone()[0]
        by = [dict(r) for r in con.execute(
            "SELECT purpose, model, COUNT(*) AS calls, ROUND(SUM(usd), 4) AS usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out FROM spend GROUP BY purpose, model ORDER BY usd DESC")]
    ai_total = sum(r["usd"] or 0 for r in by if str(r["purpose"] or "").startswith("ai-"))
    # AI assist (studio.ai) rows carry provider and slug; its limits and per-reel spend are at /api/ai.
    return {"total": round(total, 4), "today": round(today, 4), "budget": daily_budget(), "keySet": bool(openrouter_key()), "byPurpose": by, "rows": rows,
            "ai": round(ai_total, 4)}


def _trace_from_roles(project: dict) -> list[dict]:
    """Reels made before traces were kept: the search line and score are in each shot's role."""
    out = []
    for i, s in enumerate(project.get("shots", [])):
        m = ROLE.match(s.get("role", ""))
        out.append({"slot": i, "prompt": m.group(1) if m else (s.get("role") or "added by hand"),
                    "picked": Path(s["src"]).name, "candidates": [{"file": Path(s["src"]).name,
                    "match": float(m.group(2)) if m and m.group(2) != "None" else None}], "rebuilt": True})
    return out


def _reels() -> list[dict]:
    out = []
    for p in sorted(PROJECTS.glob("*.json"), key=lambda x: -x.stat().st_mtime):
        project = json.loads(p.read_text(encoding="utf-8"))
        slug = project.get("slug", p.stem)
        audio_p = DATA / "renders" / f"story-{slug}" / "audio.json"
        audio = json.loads(audio_p.read_text(encoding="utf-8")) if audio_p.exists() else {}
        out.append({
            "slug": slug, "theme": project.get("theme") or slug.split("-")[0], "title": project.get("title_ja", ""),
            "madeBy": project.get("made_by", ""), "madeAt": project.get("made_at") or datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
            "seed": project.get("seed"), "variety": project.get("variety"), "bpm": project.get("bpm"),
            "music": (audio.get("music") or {}).get("title"), "words": [b.get("ja", "") for b in project.get("beats", []) if b.get("kind") != "end"],
            "trace": project.get("trace") or _trace_from_roles(project), "traced": bool(project.get("trace")),
            "hand": sum(1 for s in project.get("shots", []) if not str(s.get("role", "")).startswith("auto:")),
        })
    return out


def _jobs() -> list[dict]:
    path = DATA / "renders" / "jobs.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[-300:]:
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return list(reversed(rows))


def _youtube() -> dict:
    with connect() as con:
        con.execute("CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, slug TEXT, network TEXT, status TEXT, at TEXT, remote_id TEXT, url TEXT, note TEXT, created TEXT)")
        uploads = con.execute("SELECT COUNT(*) FROM posts WHERE network = 'youtube' AND status IN ('scheduled', 'posted')").fetchone()[0]
        today = con.execute("SELECT COUNT(*) FROM posts WHERE network = 'youtube' AND created LIKE ?", (date.today().isoformat() + "%",)).fetchone()[0]
    # YouTube Data API since 1 June 2026: uploads (videos.insert) have their own allowance, 100 a day per Google app at
    # 1 unit each; everything else shares 10,000 units (developers.google.com/youtube/v3/getting-started).
    return {"uploads": uploads, "uploadsToday": today, "uploadLimit": 100, "unitsPerDay": 10000, "unitsPerUpload": 1}


def summary() -> dict:
    return {"spend": _spend(), "local": LOCAL_MODELS, "reels": _reels(), "jobs": _jobs(), "youtube": _youtube()}
