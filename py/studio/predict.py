"""
FILE: py/studio/predict.py
PURPOSE: Before a reel goes out, a score (how good it looks on its own) and a prediction per network (how it should
         do against that network's typical post); after it went out, the prediction next to what really happened, so
         the owner sees which guesses held and the studio learns what worked.
OVERVIEW: 1. score(row): 0-100 from what is known before posting, each part shown: the AI reviewer's hook and look
             marks (ai/reviews/<slug>.json, 0-10), a fresh headline (no other reel with it), and a length that fits
             short video (12-35 s). Missing parts are left out and the score says it is partial. It ranks reels; it
             is not a forecast of views (vendor "virality scores" are not validated as one either).
          2. predict(project, network, at): the additive model in studio.learn summed over the reel's own choices
             (theme, layout, look, recipe, loop, length, clips, music, effects, cut, weekday, hour) on that network,
             plus the model's uncertainty and the usual post-to-post spread: a middle value and an 80 % range, as
             "x a typical post" (1.0 = the network's median post). A choice never posted adds its prior spread.
             With no measured posts the range is wide on purpose.
          3. freeze(): every booking without a prediction gets one, made now and stored (table predictions). A post
             that already had numbers when its prediction was made is marked late and never counts toward accuracy.
          4. report(): each post's frozen range next to its actual result (the comparable reading from studio.learn:
             nearest 72 h, at least 20 h), whether it landed inside, how often that happens (80 % is the aim), and
             whether higher scores went with better results (Spearman rank correlation, once 5 posts are measured).
DEPENDENCIES: numpy, studio.learn, studio.db, studio.posting, studio.projects, studio.config
USAGE: python -m studio.perf predictions | score  (through studio.perf's CLI and GET /api/perf/predictions, /api/perf/scores)
NOTES: Research (2026-11-10): Opus Clip's virality score is a rubric (hook, flow, value, trend) with no published
       accuracy (help.opus.pro/docs/article/virality-score); SMP Challenge 2025's winning video model needed thousands
       of posts from thousands of accounts (arXiv 2507.00950), far more than one ranch posts; with few data, a
       Bayesian range is checked by counting how often actual results fall inside it (coverage).
"""
from __future__ import annotations

import json
import math
from contextlib import contextmanager
from datetime import datetime, timezone

import numpy as np

from studio import learn
from studio.config import DATA

Z80 = 1.2815515655446004   # an 80 % central range of a normal on the log scale
PREDICT_FEATURES = ("theme", "style", "look", "recipe", "loop", "length", "clips", "music", "sfx", "cut", "weekday", "hour")
REVIEWS = DATA / "ai" / "reviews"
WEIGHTS = {"hook": 35, "look": 25, "fresh": 25, "length": 15}

SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
  post_id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  network TEXT NOT NULL,
  made_at TEXT NOT NULL,
  mid REAL NOT NULL,
  lo REAL NOT NULL,
  hi REAL NOT NULL,
  sd REAL NOT NULL,
  posts INTEGER NOT NULL,
  score REAL,
  late INTEGER NOT NULL DEFAULT 0
);
"""


@contextmanager
def _connect():
    from studio.db import connect

    with connect() as con:
        con.executescript(SCHEMA)
        yield con


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------- score: how good the reel is on its own ----------

def ai_review(slug: str) -> dict | None:
    try:
        return json.loads((REVIEWS / f"{slug}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def score(row: dict, seconds: float | None = None, review: dict | None = None) -> dict:
    """row: an overview reel row (slug, sameHook). Returns {score 0-100, parts, partial, missing}."""
    review = review if review is not None else ai_review(str(row.get("slug") or ""))
    parts = {}
    if review:
        for k in ("hook", "look"):
            v = (review.get(k) or {}).get("score")
            if isinstance(v, (int, float)):
                parts[k] = {"value": round(float(v), 1), "of": 10, "points": WEIGHTS[k] * max(0.0, min(1.0, float(v) / 10.0)),
                            "note": str((review.get(k) or {}).get("notes") or "")[:240]}
    same = int(row.get("sameHook") or 0)
    parts["fresh"] = {"value": same, "points": WEIGHTS["fresh"] * max(0.0, 1.0 - same / 3.0),
                      "note": "no other reel has this headline" if same <= 0 else f"{same} other reel{'s' if same > 1 else ''} use this headline"}
    if seconds:
        fit = 1.0 if 12 <= seconds <= 35 else 0.5 if 8 <= seconds < 12 or 35 < seconds <= 60 else 0.0
        parts["length"] = {"value": round(seconds, 1), "points": WEIGHTS["length"] * fit, "note": f"{seconds:.0f} s"}
    have = sum(WEIGHTS[k] for k in parts)
    total = sum(p["points"] for p in parts.values())
    missing = [k for k in WEIGHTS if k not in parts]
    for p in parts.values():
        p["points"] = round(p["points"], 1)
    return {"score": round(100.0 * total / have) if have else None, "parts": parts, "partial": bool(missing), "missing": missing}


# ---------- prediction: how it should do on one network ----------

def _prior_sd() -> float:
    return math.sqrt(learn.NOISE_SD ** 2 + learn.TAU_GLOBAL ** 2)


def predict(project: dict, network: str, at: str | None = None, model=None, data: dict | None = None) -> dict:
    """{mid, lo, hi, sd, posts, metric}: x the network's typical post, with an 80 % range."""
    if model is None:
        data = data or learn.comparable()
        model = learn.fit(data["units"])
    feats = learn.reel_features(project, {"at": at} if at else None)
    if model is None:
        mean, sd, posts = 0.0, _prior_sd(), 0
    else:
        net = network if network in model.nets else None
        base = model.ybar.get(net, model.ybar[None])
        w = np.zeros(len(model.cols))
        extra = 0.0
        for f in PREDICT_FEATURES:
            lv = feats.get(f)
            if lv in (None, "unknown"):
                continue
            wf = model._weights(f, lv, net)
            if wf is None:
                extra += model.prior_sd(net) ** 2  # a choice never posted: its effect is as uncertain as the prior
            else:
                w = w + wf
        mean = base + float(w @ model.mean)
        sd = math.sqrt(max(float(w @ model.cov @ w), 0.0) + extra + model.sigma2)
        posts = len(model.units) if net is None else sum(u["network"] == network for u in model.units)
    return {"mid": round(math.exp(mean), 3), "lo": round(math.exp(mean - Z80 * sd), 3), "hi": round(math.exp(mean + Z80 * sd), 3),
            "sd": round(sd, 4), "posts": posts}


# ---------- freeze a prediction per booking, then compare ----------

def _bookings() -> list[dict]:
    from studio import posting

    return [p for p in posting.posts() if p.get("network") not in (None, "all") and p.get("status") in ("scheduled", "queued", "posted", "planned")]


def freeze(now: datetime | None = None) -> dict:
    """Every booking without a prediction gets one now. Returns {made, late}."""
    from studio import perf
    from studio.projects import load

    now = now or _now()
    data = learn.comparable()
    model = learn.fit(data["units"])
    has_numbers = {r["post_id"] for r in perf.readings()}
    made = late = 0
    rows_cache: dict[str, dict] = {}
    with _connect() as con:
        known = {r[0] for r in con.execute("SELECT post_id FROM predictions")}
        for p in _bookings():
            if p["id"] in known:
                continue
            slug = p["slug"]
            try:
                project = rows_cache.get(slug) or load(slug)
            except Exception:
                continue
            rows_cache[slug] = project
            pr = predict(project, p["network"], p.get("at"), model=model)
            sc = score({"slug": slug, "sameHook": 0}, learn.reel_features(project, None).get("seconds")).get("score")  # as it stood when booked
            is_late = 1 if p["id"] in has_numbers else 0
            con.execute("INSERT INTO predictions (post_id, slug, network, made_at, mid, lo, hi, sd, posts, score, late) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (p["id"], slug, p["network"], now.isoformat(timespec="seconds"), pr["mid"], pr["lo"], pr["hi"], pr["sd"], pr["posts"], sc, is_late))
            made += 1
            late += is_late
    return {"made": made, "late": late}


def _spearman(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 5:
        return None

    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(v):
            j = i
            while j + 1 < len(v) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2.0
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return round(num / den, 2) if den else None


def report(overview_rows: list[dict] | None = None) -> dict:
    """Every frozen prediction with its actual result when measured; coverage of the 80 % ranges; score vs result."""
    freeze()
    data = learn.comparable()
    from studio.projects import load

    actual = {u["post_id"]: math.exp(u["y"]) for u in data["units"]}
    rows_by = {r["slug"]: r for r in overview_rows or []}
    cache: dict[str, float | None] = {}

    def score_of(slug: str) -> float | None:
        if slug not in cache:
            try:
                sec = learn.reel_features(load(slug), None).get("seconds")
            except Exception:
                sec = None
            cache[slug] = score(rows_by.get(slug) or {"slug": slug, "sameHook": 0}, sec).get("score")
        return cache[slug]

    with _connect() as con:
        preds = [dict(r) for r in con.execute("SELECT * FROM predictions ORDER BY post_id DESC")]
    posts = {p["id"]: p for p in _bookings()}
    out, inside, counted, sc, act = [], 0, 0, [], []
    for pr in preds:
        p = posts.get(pr["post_id"])
        if not p:
            continue
        a = actual.get(pr["post_id"])
        s = score_of(pr["slug"])
        hit = None
        if a is not None and not pr["late"]:
            hit = pr["lo"] <= a <= pr["hi"]
            counted += 1
            inside += hit
            if s is not None:
                sc.append(s)
                act.append(a)
        out.append({"post": pr["post_id"], "slug": pr["slug"], "network": pr["network"], "at": p.get("at"), "status": p.get("status"),
                    "predicted": {"mid": pr["mid"], "lo": pr["lo"], "hi": pr["hi"], "posts": pr["posts"], "made": pr["made_at"]},
                    "actual": round(a, 3) if a is not None else None, "inside": hit, "late": bool(pr["late"]), "score": s})
    return {"rows": out, "measured": counted, "inside": inside, "coverage": round(inside / counted, 2) if counted else None, "aim": 0.8,
            "spearman": _spearman(sc, act), "minPosts": learn.MIN_POSTS,
            "summary": (f"{inside} of {counted} measured posts landed inside their predicted range (the aim is 8 in 10)." if counted
                        else "No post has numbers old enough yet; the first comparisons come about 3 days after a post goes out.")}


def scores(overview_rows: list[dict]) -> dict:
    """The score of every reel in the overview, with its parts."""
    from studio.projects import load

    out = {}
    for r in overview_rows:
        try:
            sec = learn.reel_features(load(r["slug"]), None).get("seconds")
        except Exception:
            sec = None
        out[r["slug"]] = score(r, sec)
    return {"scores": out}
