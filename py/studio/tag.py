"""
FILE: py/studio/tag.py
PURPOSE: One OpenRouter vision call per shot, on keyframes only.
OVERVIEW: Gemini Flash returns subject, action, mood, time of day, season,
          shot type, and a 0-10 score. Spend is logged and capped per day.
DEPENDENCIES: studio.db, studio.config, urllib
USAGE: tag_shots(limit)
NOTES: No key, no call. A response that is not JSON is stored as an error note, not as tags.
"""
from __future__ import annotations

import base64
import json
import urllib.request
from datetime import datetime
from pathlib import Path

from studio.config import SPEC, daily_budget, openrouter_key
from studio.db import connect, spent_today

PROMPT = (
    "You are logging a real shot from Tsumagoi Work&Camp in Gunma, Japan. "
    "Reply with JSON only: "
    '{"subject":"","action":"","mood":"","time_of_day":"","season":"","shot_type":"","quality":0,"people":false}. '
    "quality is 0-10 for a social reel. Do not invent cattle, a Milky Way, or a fire on the ground. "
    "If unsure, use empty strings."
)


def _usd(usage: dict) -> tuple[float, int, int]:
    tin = int(usage.get("prompt_tokens") or 0)
    tout = int(usage.get("completion_tokens") or 0)
    price = SPEC["openrouter"]
    usd = tin / 1_000_000 * price["usdPerMInput"] + tout / 1_000_000 * price["usdPerMOutput"]
    return usd, tin, tout


def _call(image_paths: list[str]) -> tuple[dict, dict]:
    content: list[dict] = [{"type": "text", "text": PROMPT}]
    for path in image_paths[:3]:
        blob = Path(path).read_bytes()
        b64 = base64.b64encode(blob).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
    body = json.dumps(
        {
            "model": SPEC["openrouter"]["tagModel"],
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
            "max_tokens": 300,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {openrouter_key()}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        payload = json.loads(response.read().decode("utf-8"))
    text = payload["choices"][0]["message"]["content"]
    return json.loads(text), payload.get("usage") or {}


def tag_shots(limit: int = 20, like: str | None = None) -> dict:
    if not openrouter_key():
        return {"tagged": 0, "stopped": "no OPENROUTER_API_KEY"}
    tagged = 0
    spent = 0.0
    with connect() as con:
        query = """SELECT shots.id, shots.keyframes, assets.path FROM shots
                   JOIN assets ON assets.id = shots.asset_id
                   WHERE shots.tags_json IS NULL"""
        args: tuple = ()
        if like:
            query += " AND lower(assets.path) LIKE ?"
            args = (f"%{like.lower()}%",)
        query += " ORDER BY shots.quality DESC LIMIT ?"
        rows = con.execute(query, (*args, limit)).fetchall()
        for row in rows:
            if spent_today(con) >= daily_budget():
                return {"tagged": tagged, "usd": round(spent, 4), "stopped": "daily budget"}
            frames = json.loads(row["keyframes"] or "[]")
            if not frames:
                continue
            try:
                tags, usage = _call(frames)
            except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
                con.execute(
                    "INSERT INTO spend (ts, model, purpose, usd, tokens_in, tokens_out, note) VALUES (?, ?, ?, 0, 0, 0, ?)",
                    (datetime.now().isoformat(timespec="seconds"), SPEC["openrouter"]["tagModel"], "tag-error", str(exc)[:200]),
                )
                continue
            usd, tin, tout = _usd(usage)
            con.execute(
                "UPDATE shots SET tags_json = ?, quality = COALESCE(?, quality) WHERE id = ?",
                (json.dumps(tags, ensure_ascii=False), (float(tags.get("quality") or 0) / 10) or None, row["id"]),
            )
            if tags.get("people"):
                con.execute("UPDATE shots SET face = 1 WHERE id = ?", (row["id"],))
            con.execute(
                "INSERT INTO spend (ts, model, purpose, usd, tokens_in, tokens_out, note) VALUES (?, ?, 'tag', ?, ?, ?, ?)",
                (datetime.now().isoformat(timespec="seconds"), SPEC["openrouter"]["tagModel"], usd, tin, tout, f"shot {row['id']}"),
            )
            tagged += 1
            spent += usd
    return {"tagged": tagged, "usd": round(spent, 4)}
