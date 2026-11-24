"""
FILE: py/studio/predict.py
PURPOSE: Before a reel goes out, a score (how good it looks on its own) and a prediction per network (how it should
         do against that network's typical post); after it went out, the prediction next to what really happened, so
         the owner sees which guesses held and the studio learns what worked.
OVERVIEW: 1. score(row): 0-100 from what is known before posting, each part shown: the AI reviewer's hook and look
             marks (ai/reviews/<slug>.json, 0-10), a fresh headline (no other reel with the same headline goes out
             within FRESH_DAYS of this one: what a follower would notice; reusing a good headline weeks apart is
             fine), and a length that fits short video (12-35 s). Missing parts are left out and the score says it is partial. It ranks reels; it
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
FRESH_DAYS = 14  # another reel with the same headline posted or booked this close to this one is a repeat
# The AI reviewer's marks bunch: of 184 reels, 163 openings got 5 or 6 out of 10 (Nov 2026), so read straight as a share
# every ordinary reel scored about 50. Read on this scale instead: 2/10 or less counts as nothing, 8/10 or more in full,
# in a straight line between (5 → half, 6 → two thirds). The order of reels is the same; the number reads as meant.
AI_FLOOR, AI_TOP = 2.0, 8.0


def ai_share(mark: float) -> float:
    """An AI reviewer's mark out of 10 as the share of its points (AI_FLOOR..AI_TOP)."""
    return max(0.0, min(1.0, (float(mark) - AI_FLOOR) / (AI_TOP - AI_FLOOR)))
OUT = ("posted", "scheduled", "planned", "queued")  # a post that went out or is booked to

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
                parts[k] = {"value": round(float(v), 1), "of": 10, "points": WEIGHTS[k] * ai_share(v),
                            "note": str((review.get(k) or {}).get("notes") or "")[:240],
                            "basis": review.get("basis") or "video"}  # "frames": your own model saw stills only (the page marks it)
    if "nearHook" in row:  # repeats a follower would see: same headline within FRESH_DAYS (near_repeats)
        same = int(row.get("nearHook") or 0)
        parts["fresh"] = {"value": same, "points": WEIGHTS["fresh"] * max(0.0, 1.0 - same / 2.0), "days": FRESH_DAYS,
                          "note": f"no other reel with this headline goes out within {FRESH_DAYS} days" if same <= 0
                          else f"{same} reel{'s' if same > 1 else ''} with this headline go{'' if same > 1 else 'es'} out within {FRESH_DAYS} days"}
    else:  # a row without posting data: every reel with this headline counts (the old rule)
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
    return {"score": round(100.0 * total / have) if have else None, "parts": parts, "partial": bool(missing), "missing": missing,
            "basis": (review or {}).get("basis") or ("video" if review else None)}


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
    near = None
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
            if near is None:
                near = _near_all(sorted({b["slug"] for b in _bookings()}))
            sc = score({"slug": slug, "nearHook": near.get(slug, 0)},  # as it stood when booked, by the cards' rule
                       learn.reel_features(project, None).get("seconds")).get("score")
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
    rho = _spearman(sc, act)
    # What Plan posts actually orders by (the rule _rank_by uses), so the page never says "learned" while it uses the score.
    rank_by = "learned" if _learned_model(rho, data["units"]) is not None else "score"
    return {"rows": out, "measured": counted, "inside": inside, "coverage": round(inside / counted, 2) if counted else None, "aim": 0.8,
            "spearman": rho, "rankBy": rank_by, "minPosts": learn.MIN_POSTS,
            "summary": (f"{inside} of {counted} measured posts landed inside their predicted range (the aim is 8 in 10)." if counted
                        else "No post has numbers old enough yet; the first comparisons come about 3 days after a post goes out.")}


def _hook(project: dict) -> str:
    return next((b.get("ja", "").replace("\n", "") for b in project.get("beats") or [] if b.get("kind") == "hook"), "")


def near_repeats(hooks: dict[str, str], posts: list[dict], now: datetime | None = None) -> dict[str, int]:
    """For each reel (slug -> headline): how many other reels with the same headline go out (posted or booked) within
    FRESH_DAYS of this reel's own posts, or of now when it has none yet."""
    now = now or _now()
    when: dict[str, list[datetime]] = {}
    for p in posts:
        if p.get("status") not in OUT or not p.get("at"):
            continue
        try:
            t = datetime.fromisoformat(str(p["at"]).replace("Z", "+00:00"))
        except ValueError:
            continue
        when.setdefault(p["slug"], []).append(t if t.tzinfo else t.replace(tzinfo=timezone.utc))
    window = FRESH_DAYS * 86400
    by_hook: dict[str, list[str]] = {}
    for slug, h in hooks.items():
        if h:
            by_hook.setdefault(h, []).append(slug)
    out = {}
    for slug, h in hooks.items():
        mine = when.get(slug) or [now]
        out[slug] = sum(1 for other in by_hook.get(h, []) if other != slug
                        and any(abs((a - b).total_seconds()) <= window for a in mine for b in when.get(other, [])))
    return out


def _near_all(slugs: list[str]) -> dict[str, int]:
    from studio import posting
    from studio.projects import load

    hooks = {}
    for slug in slugs:
        try:
            hooks[slug] = _hook(load(slug))
        except Exception:
            hooks[slug] = ""
    try:
        posts = posting.posts()
    except Exception:
        posts = []
    return near_repeats(hooks, posts)


# The score orders bookings only while it goes with views at least this well (Spearman over measured posts). Below it,
# Plan posts orders by what the learned model expects for each reel instead (BL-109, 24 Nov 2026: the score's rank
# correlation with views was -0.10, so "best score first" was close to random).
RANK_TRUST = 0.3


def scores(overview_rows: list[dict], report_data: dict | None = None) -> dict:
    """The score of every reel in the overview, with its parts, and `rank`: the number Plan posts orders by (the score,
    or the learned model's expected result when the score does not go with views). `rankBy` says which, `rankWhy` why."""
    from studio.projects import load

    near = _near_all([r["slug"] for r in overview_rows])
    out = {}
    for r in overview_rows:
        try:
            sec = learn.reel_features(load(r["slug"]), None).get("seconds")
        except Exception:
            sec = None
        out[r["slug"]] = score({**r, "nearHook": near.get(r["slug"], 0)}, sec)
    return {"scores": out, **_rank_by(overview_rows, out, report_data)}


def _learned_model(rho: float | None, units: list[dict]):
    """The one rule for what Plan posts orders by: the learned model when the score goes with views below RANK_TRUST
    and a model fits; else None (order by score). Used by _rank_by (the planner) and report() (the page's wording)."""
    if rho is None or rho >= RANK_TRUST:
        return None
    try:
        return learn.fit(units)
    except Exception:
        return None


def _rank_by(rows: list[dict], out: dict, rep: dict | None = None) -> dict:
    """Fill `rank` in each score: the score itself while it predicts views, else the learned middle value (x a typical post)."""
    from studio.projects import load

    try:
        rep = rep if rep is not None else report(rows)
    except Exception:
        rep = {}
    rho = rep.get("spearman")
    try:
        units = learn.comparable()["units"] if rho is not None and rho < RANK_TRUST else []
    except Exception:
        units = []
    model = _learned_model(rho, units)
    if model is None:
        for v in out.values():
            v["rank"] = v.get("score")
        why = "Ordered by score." if rho is None else f"Ordered by score: it goes with views at {rho:+.2f}."
        why_ja = "スコアの順に並べています。" if rho is None else f"スコアの順に並べています（結果との順位の相関 {rho:+.2f}）。"
        return {"rankBy": "score", "spearman": rho, "rankWhy": why, "rankWhyJa": why_ja}
    for slug, v in out.items():
        try:
            v["rank"] = round(predict(load(slug), "", model=model)["mid"] * 100, 1)
        except Exception:
            v["rank"] = None
    return {"rankBy": "learned", "spearman": rho,
            "rankWhy": (f"Ordered by what the learned model expects: the score went with views at only {rho:+.2f} "
                        f"(it orders bookings from {RANK_TRUST:+.1f})."),
            "rankWhyJa": (f"学習モデルが見込む結果の順に並べています。スコアと結果の順位の相関が {rho:+.2f} と弱いためです"
                          f"（{RANK_TRUST:+.1f} を超えたらスコアに戻します）。")}
