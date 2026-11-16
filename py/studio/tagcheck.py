"""
FILE: py/studio/tagcheck.py
PURPOSE: Check the footage tags the word rules lean on against the picture, and keep the corrections.
OVERVIEW: The library's tags are the image model's best guesses (CLIP over three frames). The word rules trust a few
          of them to decide what a line may play over: a camp chair the library called "car" put "the car park takes
          five vehicles a night" over a man in a chair, a table of bowls called "grill" opened the 1,444 m headline
          (15 Nov). One vision call per clip answers yes or no for each of those tags on two of its frames; a "no"
          drops the tag, a clear "yes" for a tag the rules need adds it. The answers live in DATA/tag-fixes.json and
          are applied every time tags are written (library.scan, library.retag), so a later re-tag keeps them.
DEPENDENCIES: studio.config, studio.db, urllib (OpenRouter, the tag model in shared/spec.json)
USAGE: python -m studio.tagcheck [--limit N] [--fresh]     check the clips not checked yet (spend logged, daily cap)
NOTES: No key, no call. A clip already checked is skipped unless --fresh. Spend stops at the daily AI budget.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from studio.config import DATA, SPEC, daily_budget, openrouter_key

FIXES = DATA / "tag-fixes.json"
# The tags a word rule reads (studio.wording: SHOWS, NEAR_BUILDING_TAGS, WORK_TAGS, MAKE_TAGS, FIRE_WORDS, ...), each
# with what it has to show for "yes".
CHECKED = {
    "car": "a car, van or camper is clearly visible",
    "parking": "a car park or parked vehicles are visible",
    "building": "a building is clearly visible (a house, the lodge, a shed)",
    "deck": "a wooden or concrete deck or terrace is visible",
    "interior": "the picture is taken indoors",
    "kitchen": "a kitchen, a stove top or cooking indoors",
    "desk": "a desk or table set up for work (laptop, monitor, notebook)",
    "food": "food or drink is the main subject",
    "grill": "a barbecue grill or food cooking on a fire outdoors",
    "fire": "a real fire (campfire, fire pit, wood stove flame)",
    "field": "an open grass field or meadow",
    "tent": "a tent is visible",
    "mountains": "mountains or a mountain ridge are visible",
    "snow": "snow is visible",
}
ADDABLE = {"car", "parking", "building", "interior", "desk", "food", "fire"}  # a clear yes adds these (rules refuse on them)

PROMPT = ("You check tags on a photo or video frames from a mountain campsite in Japan. For each tag below answer true only "
          "if the picture clearly shows it, false if it does not. Reply with JSON only, one key per tag.\n"
          + "\n".join(f"- {k}: {v}" for k, v in CHECKED.items()))


def fixes() -> dict:
    try:
        return json.loads(FIXES.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def apply(asset_id: int | str, top: list[str], table: dict | None = None) -> list[str]:
    """A clip's tags with its checked corrections: dropped tags out, added tags in (at most 6)."""
    f = (fixes() if table is None else table).get(str(asset_id))
    if not f:
        return list(top)
    out = [t for t in top if t not in set(f.get("drop") or [])]
    for t in f.get("add") or []:
        if t not in out:
            out.append(t)
    return out[:6]


def judge(top: list[str], answer: dict) -> dict:
    """What to drop and add, from the model's yes/no answers (a tag it did not answer stays as it is)."""
    drop = [t for t in top if t in CHECKED and answer.get(t) is False]
    add = [t for t in ADDABLE if answer.get(t) is True and t not in top]
    return {"drop": drop, "add": sorted(add)}


def _usd(usage: dict) -> tuple[float, int, int]:
    tin, tout = int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
    p = SPEC["openrouter"]
    return tin / 1e6 * p["usdPerMInput"] + tout / 1e6 * p["usdPerMOutput"], tin, tout


def _ask(images: list[str]) -> tuple[dict, dict]:
    content: list[dict] = [{"type": "text", "text": PROMPT}]
    for path in images[:2]:
        b64 = base64.b64encode(Path(path).read_bytes()).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
    body = json.dumps({"model": SPEC["openrouter"]["tagModel"], "messages": [{"role": "user", "content": content}],
                       "response_format": {"type": "json_object"}, "max_tokens": 1200}).encode("utf-8")
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {openrouter_key()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        out = json.loads(r.read().decode("utf-8"))
    text = out["choices"][0]["message"]["content"]
    ans = json.loads(text[text.find("{"): text.rfind("}") + 1])
    return {k: v for k, v in ans.items() if k in CHECKED and isinstance(v, bool)}, out.get("usage") or {}


def check(limit: int | None = None, fresh: bool = False, workers: int = 6) -> dict:
    from studio.db import connect, spent_today

    if not openrouter_key():
        return {"checked": 0, "stopped": "no OPENROUTER_API_KEY"}
    table = fixes()
    with connect() as con:
        rows = [dict(r) for r in con.execute("SELECT asset_id, thumbs, top FROM library WHERE emb IS NOT NULL ORDER BY asset_id")]
    todo = [r for r in rows if fresh or str(r["asset_id"]) not in table]
    if limit:
        todo = todo[:limit]
    done = changed = 0
    spent = 0.0
    stopped = ""

    def one(r: dict):
        thumbs = [t for t in json.loads(r["thumbs"] or "[]") if Path(t).exists()]
        if not thumbs:
            return r, None, None, "no thumbnail"
        pick = [thumbs[len(thumbs) // 2]] + ([thumbs[0]] if len(thumbs) > 2 else [])
        try:
            ans, usage = _ask(pick)
            return r, ans, usage, ""
        except Exception as err:  # noqa: BLE001 - one clip's failure never stops the rest
            return r, None, None, f"{type(err).__name__}: {str(err)[:120]}"

    for k in range(0, len(todo), 30):  # in batches, so the daily budget is looked at as it goes
        with connect() as con:
            if spent_today(con) >= daily_budget():
                stopped = "daily budget"
                break
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(one, todo[k:k + 30]))
        with connect() as con:
            for r, ans, usage, err in results:
                model = SPEC["openrouter"]["tagModel"]
                if ans is None:
                    con.execute("INSERT INTO spend (ts, model, purpose, usd, tokens_in, tokens_out, note) VALUES (?, ?, 'tagcheck-error', 0, 0, 0, ?)",
                                (datetime.now().isoformat(timespec="seconds"), model, f"asset {r['asset_id']}: {err}"))
                    continue
                usd, tin, tout = _usd(usage)
                spent += usd
                con.execute("INSERT INTO spend (ts, model, purpose, usd, tokens_in, tokens_out, note) VALUES (?, ?, 'tagcheck', ?, ?, ?, ?)",
                            (datetime.now().isoformat(timespec="seconds"), model, usd, tin, tout, f"asset {r['asset_id']}"))
                top = json.loads(r["top"] or "[]")
                j = judge(top, ans)
                table[str(r["asset_id"])] = {**j, "seen": datetime.now().isoformat(timespec="seconds")}
                new = apply(r["asset_id"], top, table)
                if new != top:
                    changed += 1
                    con.execute("UPDATE library SET top = ? WHERE asset_id = ?", (json.dumps(new), r["asset_id"]))
                done += 1
        FIXES.write_text(json.dumps(table, ensure_ascii=False, indent=0), encoding="utf-8")
        print(f"PROGRESS {min(k + 30, len(todo))}/{len(todo)} checked · {changed} corrected · ${spent:.3f}", flush=True)
    return {"checked": done, "corrected": changed, "usd": round(spent, 4), **({"stopped": stopped} if stopped else {})}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m studio.tagcheck")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--fresh", action="store_true")
    a = ap.parse_args(argv)
    print("RESULT " + json.dumps(check(a.limit, a.fresh)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
