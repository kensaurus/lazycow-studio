"""
FILE: py/studio/learn.py
PURPOSE: Learn which reel choices work from the readings in studio.perf, say so in plain words with their
         uncertainty, and suggest what to try next (Thompson sampling with a fixed share of exploration).
OVERVIEW: 1. Features: each reel's theme, text layout, look, recipe, loop, length, clip count, music, effects,
             hook line, cut, plus the post's weekday and hour (Japan time).
          2. One comparable number per post: the reading nearest 72 h old (at least 20 h), on the network's
             own scale (views; reach or impressions where a network has no views; else likes + comments +
             shares + saves), divided by that network's median. y = ln((value + 1) / (median + 1)).
          3. A Bayesian additive model on y: per-network intercepts, a shared effect for every feature level
             (prior sd 0.5 on the log scale, about x0.6 to x1.6) and a smaller per-network deviation (prior
             sd 0.3). Conjugate Normal, closed form in numpy: few posts pull the estimates only a little,
             networks share what they learn (partial pooling), and every effect has an uncertainty.
          4. Reports: "punch look: about 1.6x the median views on TikTok (5 posts; still uncertain)".
          5. suggest(): each suggestion either explores (30 % by default: the least-tried choice) or draws one
             sample of the effects from the posterior and takes the best choice under it (Thompson sampling).
             Until MIN_POSTS measured posts exist every suggestion explores.
          6. vary_draw(): what service.vary_look uses when steering is switched on (opt-in: the `learned`
             flag on autopilot, or STUDIO_PERF_STEER=1). Below MIN_POSTS, or on an explore turn, it returns
             None and the old uniform random choice stands.
DEPENDENCIES: numpy, studio.perf, studio.posting, studio.projects, studio.staging, studio.assemble (theme defaults)
USAGE: summary(network=None); suggest(network=None, n=3, explore=0.3, seed=None); vary_draw(...)
NOTES: Research and reasoning: docs/research/2026-11-09-reel-learning.md. The model is additive (no
       interactions) on purpose: with about one post a day per network there is not enough data for more.
       Suggestions only steer how drafts are made; a person still approves every reel and nothing posts.
"""
from __future__ import annotations

import math
import os
import statistics
from datetime import datetime

import numpy as np

MIN_POSTS = 15          # measured posts before the learned choice steers anything
MIN_AGE_H = 20.0        # a reading younger than this is not comparable yet
REF_AGE_H = 72.0        # the reading nearest this age is the one compared
EXPLORE = 0.3           # share of suggestions that try a less-tested choice
TAU_GLOBAL = 0.5        # prior sd of a feature effect shared by every network (log scale)
TAU_NET = 0.3           # prior sd of one network's deviation from the shared effect
TAU_INTERCEPT = 1.0
NOISE_SD = 0.8          # prior guess of how much a post varies for no reason we can see (log scale)
NOISE_WEIGHT = 4        # how many posts' worth that guess counts for
MEDIAN_OF_LAST = 30     # a network's median is taken over its newest measured posts

LENGTHS = ("under 12 s", "12-16 s", "16-22 s", "22-35 s", "35-60 s", "over 60 s")
CLIPS = ("1-6", "7-9", "10-12", "13+")
HOURS = ("00-05", "06-09", "10-13", "14-17", "18-20", "21-23")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
FEATURES = ("theme", "style", "look", "recipe", "loop", "length", "clips", "music", "sfx", "hook", "cut", "weekday", "hour")
STEER = ("look", "recipe", "style", "length", "hour")
# What suggestions may steer to: the short loop's lengths (the 40-60 s explainer is its own cut) and waking hours.
STEER_LENGTHS = LENGTHS[:4]
STEER_HOURS = HOURS[1:]
NET_NAMES = {"youtube": "YouTube", "tiktok": "TikTok", "x": "X", "facebook": "Facebook", "bluesky": "Bluesky", "instagram": "Instagram",
             "threads": "Threads", "linkedin": "LinkedIn", "pinterest": "Pinterest", "gbp": "Google Maps", "line-voom": "LINE VOOM",
             "line-oa": "LINE", "xiaohongshu": "Xiaohongshu", "kensaurus": "kensaur.us", "zenn": "Zenn", "note": "note"}
METRIC_WORDS = {"views": "views", "engaged_views": "engaged views", "reach": "reach", "engagements": "likes, comments, shares and saves"}


def steer_on() -> bool:
    """The opt-in switch for learned looks without asking per run (.env STUDIO_PERF_STEER=1)."""
    return os.environ.get("STUDIO_PERF_STEER", "").strip().lower() in ("1", "true", "on", "yes")


def levels(feature: str) -> tuple[str, ...]:
    """Every choice the maker can steer to, including ones never posted yet."""
    from studio.service import TEXT_STYLES
    from studio.staging import LOOKS, RECIPES

    return {"look": (*LOOKS, "plain"), "recipe": (*RECIPES, "none"), "style": TEXT_STYLES, "length": STEER_LENGTHS, "hour": STEER_HOURS}[feature]


# ---------- features ----------

def length_bucket(sec: float) -> str:
    for edge, name in ((12, LENGTHS[0]), (16, LENGTHS[1]), (22, LENGTHS[2]), (35, LENGTHS[3]), (60, LENGTHS[4])):
        if sec < edge:
            return name
    return LENGTHS[5]


def clips_bucket(n: int) -> str:
    return CLIPS[0] if n <= 6 else CLIPS[1] if n <= 9 else CLIPS[2] if n <= 12 else CLIPS[3]


def hour_bucket(h: int) -> str:
    return HOURS[0] if h < 6 else HOURS[1] if h < 10 else HOURS[2] if h < 14 else HOURS[3] if h < 18 else HOURS[4] if h < 21 else HOURS[5]


def reel_features(project: dict, post: dict | None) -> dict:
    """The choices one reel was made with (and, with a post, when it went out in Japan time)."""
    from studio.assemble import THEMES
    from studio.perf import JST, _when
    from studio.staging import staging

    project = project or {}
    slug = str(project.get("slug") or (post or {}).get("slug") or "")
    theme = project.get("theme") or slug.split("-")[0] or "unknown"
    try:
        st = staging({**project, "theme": theme})
    except Exception:  # a kicker that fails the copy guard must not stop learning
        st = {"look": project.get("look"), "recipe": project.get("recipe"), "loop": bool(project.get("loop"))}
    shots = project.get("shots") or []
    sec = sum(float(s.get("sec") or 0) for s in shots if isinstance(s, dict))
    music = project.get("music")
    ai_music = any(isinstance(n, dict) and n.get("tool") == "music" for n in project.get("ai") or [])
    hook = next((b.get("ja") for b in project.get("beats") or [] if isinstance(b, dict) and b.get("kind") == "hook"), "") or ""
    out = {
        "theme": theme,
        "style": project.get("style") or (THEMES.get(theme) or {}).get("style") or "column",
        "look": st.get("look") or "plain",
        "recipe": st.get("recipe") or "none",
        "loop": "loop" if st.get("loop") else "no loop",
        "length": length_bucket(sec),
        "clips": clips_bucket(len(shots)),
        "music": "AI bed" if ai_music else "none" if music in (None, False, "off", "none") else "auto" if music == "auto" else "picked",
        "sfx": "effects" if project.get("sfx") else "no effects",
        "hook": "".join(hook.split())[:40] or "none",
        "cut": "long" if project.get("variant") == "b-explainer" or slug.endswith("-long") else "short",
        "seconds": round(sec, 1),
    }
    t = _when((post or {}).get("at"))
    if t:
        j = t.astimezone(JST)
        out.update(weekday=WEEKDAYS[j.weekday()], hour=hour_bucket(j.hour))
    else:
        out.update(weekday="unknown", hour="unknown")
    return out


# ---------- one comparable number per post ----------

def _value(r: dict, metric: str) -> float | None:
    if metric == "engagements":
        parts = [r.get(k) for k in ("likes", "comments", "shares", "saves")]
        return float(sum(p for p in parts if p is not None)) if any(p is not None for p in parts) else None
    v = (r.get("extra") or {}).get(metric) if metric == "engaged_views" else r.get(metric)
    return float(v) if v is not None else None


def comparable(now: datetime | None = None, posts: list[dict] | None = None, rows: list[dict] | None = None) -> dict:
    """{units, byPost, networks, tooNew}: one unit per live post with a reading at least MIN_AGE_H old."""
    from studio import perf
    from studio.projects import load

    posts = perf.live_posts(now) if posts is None else posts
    rows = perf.readings() if rows is None else rows
    by_post: dict[int, list[dict]] = {}
    for r in rows:
        by_post.setdefault(r["post_id"], []).append(r)
    picked, too_new = [], 0
    for p in posts:
        ok = [r for r in by_post.get(p["id"], []) if (r.get("age_h") or 0) >= MIN_AGE_H]
        if not ok:
            too_new += bool(by_post.get(p["id"]))
            continue
        best = min(ok, key=lambda r: (abs(math.log(max(r["age_h"], 0.1) / REF_AGE_H)), r["fetched_at"]))
        picked.append((p, best))
    networks: dict[str, dict] = {}
    for net in sorted({p["network"] for p, _ in picked}):
        mine = [r for p, r in picked if p["network"] == net]
        # YouTube's engaged views (Analytics) when most posts have them: plain views changed meaning twice since 2025.
        metric = next((m for m in ("engaged_views", "views", "reach") if sum(_value(r, m) is not None for r in mine) * 2 >= len(mine)), "engagements")
        networks[net] = {"metric": metric}
    projects: dict[str, dict] = {}
    units = []
    for p, r in picked:
        net = p["network"]
        v = _value(r, networks[net]["metric"])
        if v is None:
            continue
        if p["slug"] not in projects:
            projects[p["slug"]] = load(p["slug"]) or {"slug": p["slug"]}
        units.append({"post_id": p["id"], "slug": p["slug"], "network": net, "metric": networks[net]["metric"], "value": v,
                      "age_h": r["age_h"], "source": r["source"], "at": p.get("out_at") or p.get("at"),
                      "features": reel_features(projects[p["slug"]], p)})
    for net, info in networks.items():
        mine = sorted((u for u in units if u["network"] == net), key=lambda u: str(u["at"]))[-MEDIAN_OF_LAST:]
        info["median"] = statistics.median([u["value"] for u in mine]) if mine else None
        info["posts"] = sum(u["network"] == net for u in units)
    for u in units:
        med = networks[u["network"]]["median"] or 0.0
        u["median"] = med
        u["ratio"] = round((u["value"] + 1) / (med + 1), 3)
        u["y"] = math.log(u["ratio"])
        u["sentence"] = (f"{u['ratio']:.1f}x the median {METRIC_WORDS[u['metric']]} on {NET_NAMES.get(u['network'], u['network'])} "
                         f"({networks[u['network']]['posts']} measured posts there)")
    return {"units": units, "byPost": {u["post_id"]: u for u in units}, "networks": networks, "tooNew": too_new}


# ---------- the model ----------

class Model:
    """Posterior of the additive model: mean and covariance over columns
    ("i", None, None, net) intercepts, ("g", feature, level, None) shared effects, ("n", feature, level, net) deviations."""

    def __init__(self, units: list[dict]):
        self.units = units
        self.nets = sorted({u["network"] for u in units})
        cols: list[tuple] = [("i", None, None, n) for n in self.nets]
        prior = [TAU_INTERCEPT] * len(self.nets)
        for f in FEATURES:
            for lv in sorted({u["features"].get(f, "unknown") for u in units}):
                cols.append(("g", f, lv, None))
                prior.append(TAU_GLOBAL)
                for n in self.nets:
                    if any(u["network"] == n and u["features"].get(f) == lv for u in units):
                        cols.append(("n", f, lv, n))
                        prior.append(TAU_NET)
        self.cols = cols
        self.index = {c: i for i, c in enumerate(cols)}
        X = np.zeros((len(units), len(cols)))
        y = np.array([u["y"] for u in units], dtype=float)
        for r, u in enumerate(units):
            X[r, self.index[("i", None, None, u["network"])]] = 1.0
            for f in FEATURES:
                lv = u["features"].get(f, "unknown")
                X[r, self.index[("g", f, lv, None)]] = 1.0
                X[r, self.index[("n", f, lv, u["network"])]] = 1.0
        # Noise: the prior guess, updated by how much posts spread around their network's mean.
        resid = sum((u["y"] - np.mean([v["y"] for v in units if v["network"] == u["network"]])) ** 2 for u in units)
        self.sigma2 = (NOISE_WEIGHT * NOISE_SD ** 2 + resid) / (NOISE_WEIGHT + len(units))
        precision = X.T @ X / self.sigma2 + np.diag(1.0 / np.square(prior))
        self.cov = np.linalg.inv(precision)
        self.cov = (self.cov + self.cov.T) / 2
        self.mean = self.cov @ (X.T @ y) / self.sigma2
        self._chol = None
        self._w: dict = {}
        # The typical post's log ratio to its median, over all posts and per network.
        self.ybar = {None: float(np.mean(y)), **{n: float(np.mean([u["y"] for u in units if u["network"] == n])) for n in self.nets}}

    def _raw(self, feature: str, level: str, net: str | None) -> np.ndarray | None:
        g = self.index.get(("g", feature, level, None))
        if g is None:
            return None
        w = np.zeros(len(self.cols))
        w[g] = 1.0
        n = self.index.get(("n", feature, level, net)) if net else None
        if n is not None:
            w[n] = 1.0
        return w

    def _weights(self, feature: str, level: str, net: str | None) -> np.ndarray | None:
        """A level compared with the post-weighted average of its feature's levels (a contrast). Every post has one
        level of every feature, so a level's own coefficient is not identified; the contrast is, and it is what
        the data can tell: posts with this choice against the typical post."""
        key = (feature, level, net)
        if key not in self._w:
            w = self._raw(feature, level, net)
            if w is not None:
                seen = [(lv, self.count(feature, lv, net)) for lv in sorted({u["features"].get(feature) for u in self.units})]
                seen = [(lv, c) for lv, c in seen if c] or [(lv, self.count(feature, lv)) for lv, _ in seen]
                total = sum(c for _, c in seen) or 1
                for lv, c in seen:
                    w = w - (c / total) * self._raw(feature, lv, net)
            self._w[key] = w
        return self._w[key]

    def prior_sd(self, net: str | None) -> float:
        return math.sqrt(TAU_GLOBAL ** 2 + (TAU_NET ** 2 if net else 0.0))

    def contrast(self, feature: str, level: str, net: str | None = None) -> tuple[float, float]:
        """(mean, sd) on the log scale of this level against the typical post (the feature's other choices)."""
        w = self._weights(feature, level, net)
        if w is None:
            return 0.0, self.prior_sd(net)
        return float(w @ self.mean), float(math.sqrt(max(w @ self.cov @ w, 1e-12)))

    def effect(self, feature: str, level: str, net: str | None = None) -> tuple[float, float]:
        """(mean, sd) on the log scale of posts with this level against their network's median; a level never
        posted is the prior. The typical post's own spread around the median adds sigma^2 / posts."""
        base = self.ybar.get(net, self.ybar[None])
        m, s = self.contrast(feature, level, net)
        n = len(self.units) if net is None else sum(u["network"] == net for u in self.units)
        return base + m, math.sqrt(s * s + self.sigma2 / max(n, 1))

    def choices(self, feature: str, net: str | None = None) -> int:
        return len({u["features"].get(feature) for u in self.units if net is None or u["network"] == net})

    def count(self, feature: str, level: str, net: str | None = None) -> int:
        return sum(1 for u in self.units if u["features"].get(feature) == level and (net is None or u["network"] == net))

    def sample(self, rng: np.random.Generator) -> np.ndarray:
        if self._chol is None:
            self._chol = np.linalg.cholesky(self.cov + np.eye(len(self.cols)) * 1e-9)
        return self.mean + self._chol @ rng.standard_normal(len(self.cols))

    def sampled_effect(self, beta: np.ndarray, feature: str, level: str, net: str | None, rng: np.random.Generator) -> float:
        base = self.ybar.get(net, self.ybar[None])
        w = self._weights(feature, level, net)
        if w is None:  # never posted: a draw from the prior, so an untried choice can win a turn
            return float(rng.normal(base, self.prior_sd(net)))
        return base + float(w @ beta)


def fit(units: list[dict]) -> Model | None:
    return Model(units) if units else None


# ---------- plain words ----------

def _phi(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def label(feature: str, level: str) -> str:
    return {
        "look": "plain picture (no look)" if level == "plain" else f"{level} look",
        "recipe": "no recipe" if level == "none" else f"{level} recipe",
        "style": f"{level} text layout",
        "length": f"{level} long",
        "clips": f"{level} clips",
        "hour": f"posting at {level} JST",
        "weekday": f"posting on {level}",
        "theme": f"{level} theme",
        "loop": "a looping ending" if level == "loop" else "no loop",
        "music": f"music: {level}",
        "sfx": "sound effects" if level == "effects" else "no sound effects",
        "hook": f"hook \"{level}\"",
        "cut": f"{level} cut",
    }.get(feature, f"{feature} {level}")


def verdict(p_better: float, posts: int) -> str:
    if posts < 2:
        return f"{posts} post: too few to tell"
    if p_better >= 0.9:
        return "fairly sure it helps"
    if p_better >= 0.75:
        return "probably helps; still uncertain"
    if p_better <= 0.1:
        return "fairly sure it holds back"
    if p_better <= 0.25:
        return "probably holds back; still uncertain"
    return "still uncertain"


def describe(model: Model, feature: str, level: str, net: str | None, metric: str) -> dict:
    """mult and its 80 % range: posts with this choice against the network median. pBetter and the verdict:
    the chance this choice beats the feature's other choices (not the median), so a choice every post shared
    never reads as a finding."""
    m, s = model.effect(feature, level, net)
    cm, cs = model.contrast(feature, level, net)
    n = model.count(feature, level, net)
    shared = n > 0 and model.choices(feature, net) < 2
    p = 0.5 if shared else (_phi(cm / cs) if cs > 0 else 0.5)
    mult, low, high = math.exp(m), math.exp(m - 1.2816 * s), math.exp(m + 1.2816 * s)
    where = f" on {NET_NAMES.get(net, net)}" if net else " (all networks)"
    words = "every measured post had it: nothing to compare yet" if shared else verdict(p, n)
    return {"feature": feature, "level": level, "label": label(feature, level), "mult": round(mult, 2), "low": round(low, 2),
            "high": round(high, 2), "posts": n, "pBetter": round(p, 3), "verdict": words,
            "sentence": f"{label(feature, level)}: about {mult:.1f}x the median {METRIC_WORDS.get(metric, metric)}{where} "
                        f"({n} post{'s' if n != 1 else ''}; {words})"}


def _metric_for(data: dict, net: str | None) -> str:
    if net:
        return (data["networks"].get(net) or {}).get("metric", "views")
    metrics = {i["metric"] for i in data["networks"].values()}
    return metrics.pop() if len(metrics) == 1 else "result"


METRIC_WORDS["result"] = "result for its network"


def summary(network: str | None = None, data: dict | None = None) -> dict:
    """What worked and what did not, by feature, in plain sentences with their uncertainty."""
    data = data or comparable()
    units = data["units"]
    measured = len(units)
    ready = measured >= MIN_POSTS
    base = {"ready": ready, "measured": measured, "needed": MIN_POSTS, "tooNew": data["tooNew"], "network": network,
            "networks": {n: {"name": NET_NAMES.get(n, n), **i} for n, i in data["networks"].items()},
            "method": (f"Each post's reading nearest {int(REF_AGE_H)} h old is compared with its network's median "
                       "(YouTube's engaged views when Analytics is allowed, else views, else reach, else likes + comments + "
                       "shares + saves). A Bayesian model shares what one network "
                       "learns with the others and keeps every estimate's uncertainty; ranges are 80 % intervals.")}
    if network and network not in data["networks"]:
        return {**base, "headline": f"No measured posts on {NET_NAMES.get(network, network)} yet.", "worked": [], "didnt": [], "features": {}, "sentences": []}
    if not units:
        return {**base, "headline": "No measured posts yet. Numbers arrive from the hourly check (YouTube, Facebook, Bluesky) "
                                    "or by hand / CSV for the other networks, from a day after posting.",
                "worked": [], "didnt": [], "features": {}, "sentences": []}
    model = fit(units)
    metric = _metric_for(data, network)
    feats = {}
    for f in FEATURES:
        lvls = sorted({u["features"].get(f, "unknown") for u in units if network is None or u["network"] == network})
        rows = [describe(model, f, lv, network, metric) for lv in lvls if lv != "unknown"]
        feats[f] = sorted(rows, key=lambda r: -r["mult"])
    flat = [r for rows in feats.values() for r in rows if r["posts"] >= 2]
    worked = sorted((r for r in flat if r["pBetter"] >= 0.75), key=lambda r: -r["pBetter"])[:6]
    didnt = sorted((r for r in flat if r["pBetter"] <= 0.25), key=lambda r: r["pBetter"])[:6]
    head = (f"{measured} measured post{'s' if measured != 1 else ''}." if ready else
            f"Not enough data yet: {measured} of {MIN_POSTS} measured posts. Read these as early hints, not findings.")
    if not worked and not didnt:
        head += " Nothing stands out yet: every choice is still within the noise."
    sentences = [head] + [r["sentence"] for r in worked] + [r["sentence"] for r in didnt]
    return {**base, "headline": head, "worked": worked, "didnt": didnt, "features": feats, "sentences": sentences}


# ---------- what to try next ----------

def _tried(model: Model, feature: str, net: str | None, allowed=None) -> list[str]:
    """The choices with at least one measured post. Following the results means choosing among these: an untried
    choice has a wide prior, so with many of them one would win most draws. Explore turns are what try them."""
    opts = list(allowed) if allowed is not None else list(levels(feature))
    return [lv for lv in opts if model.count(feature, lv, net) > 0] or opts


def _least_tried(model: Model | None, feature: str, net: str | None, rng: np.random.Generator) -> tuple[str, int]:
    opts = levels(feature)
    counts = [model.count(feature, lv, net) if model else 0 for lv in opts]
    low = min(counts)
    choices = [lv for lv, c in zip(opts, counts) if c == low]
    return choices[int(rng.integers(len(choices)))], low


def best_shares(model: Model | None, net: str | None, rng: np.random.Generator, draws: int = 400) -> dict:
    """For each steerable feature: how often each choice is the best under the posterior (the Thompson odds)."""
    out = {}
    if model is None:
        return {f: {lv: round(1 / len(levels(f)), 3) for lv in levels(f)} for f in STEER}
    wins = {f: dict.fromkeys(levels(f), 0) for f in STEER}
    for _ in range(draws):
        beta = model.sample(rng)
        for f in STEER:
            vals = {lv: model.sampled_effect(beta, f, lv, net, rng) for lv in _tried(model, f, net)}
            wins[f][max(vals, key=vals.get)] += 1
    for f, w in wins.items():
        out[f] = {lv: round(c / draws, 3) for lv, c in sorted(w.items(), key=lambda kv: -kv[1])}
    return out


def suggest(network: str | None = None, n=3, explore=None, seed=None, data: dict | None = None) -> dict:
    """Next-reel suggestions: look, recipe, text layout, length and posting hour, each with why."""
    try:
        n = max(1, min(10, int(n)))
    except (TypeError, ValueError):
        n = 3
    try:
        explore = EXPLORE if explore is None else max(0.0, min(1.0, float(explore)))
    except (TypeError, ValueError):
        explore = EXPLORE
    seed = int(seed) if isinstance(seed, (int, float)) or (isinstance(seed, str) and seed.isdigit()) else None
    data = data or comparable()
    units = data["units"]
    ready = len(units) >= MIN_POSTS
    model = fit(units)
    net = network if network in data["networks"] else None
    metric = _metric_for(data, net)
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        learned = ready and model is not None and rng.random() >= explore
        pick, why = {}, {}
        if learned:
            beta = model.sample(rng)
            for f in STEER:
                vals = {lv: model.sampled_effect(beta, f, lv, net, rng) for lv in _tried(model, f, net)}
                lv = max(vals, key=vals.get)
                pick[f] = lv
                why[f] = describe(model, f, lv, net, metric)["sentence"]
        else:
            for f in STEER:
                lv, c = _least_tried(model, f, net, rng)
                pick[f] = lv
                why[f] = f"exploring: {label(f, lv)} has {c} measured post{'s' if c != 1 else ''} so far"
        out.append({"mode": "learned" if learned else "explore", **pick, "why": why})
    note = (f"Learned from {len(units)} measured posts; about {round(explore * 100)} % of suggestions explore on purpose."
            if ready else f"Exploring only: {len(units)} of {MIN_POSTS} measured posts so far. Suggestions try the least-tested "
                          "choices until there is enough to learn from.")
    from studio.brand import RANCH

    if RANCH:  # the ranch's own posting rule; another project has no house time
        note += " The house posting time is 19:00 JST; move it only if another hour keeps winning."
    return {"ready": ready, "measured": len(units), "needed": MIN_POSTS, "explore": explore, "network": network, "metric": metric,
            "suggestions": out, "distribution": best_shares(model, net, np.random.default_rng(seed)), "note": note}


def vary_draw(theme_style: str, rng, night: bool = False, looks: list | None = None, network: str | None = None,
              data: dict | None = None) -> dict | None:
    """For service.vary_look when steering is on: {"style", "look"} drawn from what has worked, or None
    (not enough data, or an explore turn) so the uniform random choice stands. `rng` is the caller's
    random.Random, so a seed gives the same reel again."""
    from studio.service import TEXT_STYLES
    from studio.staging import LOOKS

    data = data or comparable()
    if len(data["units"]) < MIN_POSTS:
        return None
    nrng = np.random.default_rng(rng.getrandbits(32))
    if nrng.random() < EXPLORE:
        return None
    model = fit(data["units"])
    net = network if network in data["networks"] else None
    beta = model.sample(nrng)
    styles = [s for s in TEXT_STYLES if s != theme_style]
    allowed = [lv for lv in (looks if looks is not None else LOOKS) if lv and (night or lv != "ember")] + ["plain"]
    style = max(styles, key=lambda s: model.sampled_effect(beta, "style", s, net, nrng))
    look = max(_tried(model, "look", net, allowed), key=lambda lv: model.sampled_effect(beta, "look", lv, net, nrng))
    return {"style": style, "look": None if look == "plain" else look}
