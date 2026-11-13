"""
FILE: py/studio/wording.py
PURPOSE: The approved words, and a fresh draw of them for every reel, so reels and posts do not repeat.
OVERVIEW: The bank holds every approved headline (hook) and proof line:
          - the themes' own lines;
          - lines from the website SSOT (place-line.ts, autumn-leaves-copy.ts);
          - lines the owner adds in the studio (Reels › Words);
          - AI suggestions the owner approved.
          A line is used on screen only when its status is "approved". The fact guard checks every line on the
          way in and again on the way out.
          `draw(theme_key, slots, rng)` picks a headline and proof lines for one reel:
          - the least-used first, weighted;
          - lines whose topic fits the shot they sit on;
          - never a headline-and-lines set another reel already has (it retries; `fresh` says if it managed);
          - never a line whose `months` excludes this month.
          `usage()` counts how many reels use each line, and `report()` gives the Words page its numbers.
DEPENDENCIES: studio.guard, studio.projects, studio.config
USAGE: python -m studio.wording report | draw <theme>   (JSON on stdout)
NOTES: The studio never writes a claim by itself. New lines come from a person, or from an AI suggestion that a person
       approves before any reel can use it.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import sys
import time
from collections import Counter
from pathlib import Path

from studio.config import PROJECTS, RANCH, ROOT
from studio.guard import assert_copy, problems

# The ranch workspace keeps its bank in shared/ (reviewed in git); a project made in the studio, beside its reels.
WORDS = Path(os.environ.get("STUDIO_WORDS") or (ROOT / "shared" / "words.json" if RANCH else PROJECTS.parent / "words.json"))

# Japanese words that say what a line is about, and English words that say what a shot shows.
TOPICS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "work": (("光回線", "働く", "仕事", "デスク", "進むか"), ("laptop", "desk", "work", "office", "window")),
    "view": (("景色", "尾根", "標高", "民家", "建物", "眺め"), ("mountain", "ridge", "aerial", "drone", "view", "forest", "road")),
    "fire": (("火", "キッチン", "レストラン", "店員", "お店"), ("fire", "pizza", "oven", "ember", "flame", "cook", "food")),
    "car": (("車で", "駐車場", "走り", "台まで"), ("car", "van", "parking", "vehicle")),
    "field": (("区画", "草原", "張れる", "テント", "5組"), ("field", "tent", "grass", "meadow", "pitch")),
    "warm": (("氷点下", "こたつ", "ぬくもり", "ラウンジ", "寒い"), ("lounge", "inside", "snow", "winter", "room", "kotatsu")),
    "night": (("夜", "星", "照明", "灯り", "暗い"), ("night", "dusk", "dark", "star", "evening")),
    "loud": (("騒げる", "笑い声", "お隣"), ("group", "party", "people", "music")),
    "people": (("つながり", "東京"), ("people", "group", "friends", "table")),
    "autumn": (("紅葉",), ("autumn", "leaves", "orange")),
    "sleep": (("寝る",), ("tent", "car", "van", "bed")),
}

# Approved website lines the themes do not use yet (verbatim from the website repo, src/constants). Each keeps its
# source so the owner can check it. Screen line breaks only; no word changed.
SITE_LINES: list[dict] = [
    {"kind": "hook", "ja": "山の24時間ラウンジ。\n寝るのは、自分の車かテント。", "en": "A 24-hour lounge on the mountain. You sleep in your own car or a tent.", "source": "place-line.ts PLACE_LINE"},
    {"kind": "hook", "ja": "平日、\n紅葉の中で働く", "en": "Weekdays, working among the autumn leaves", "source": "autumn-leaves-copy.ts weekdayTitle", "months": [10, 11]},
    {"kind": "line", "ja": "昼は紅葉、夜は焚き火。\nそのあとは、あったかいラウンジへ。", "en": "Autumn leaves by day, the fire by night, then the warm lounge.", "source": "autumn-leaves-copy.ts AUTUMN_EVENT_LINE.night", "months": [10, 11]},
    {"kind": "line", "ja": "紅葉の午後に、手を動かす。\n冷えてきたら、あったかいラウンジへ。", "en": "An afternoon of making things among the autumn leaves; when it turns cold, the warm lounge.", "source": "autumn-leaves-copy.ts AUTUMN_EVENT_LINE.day", "months": [10, 11]},
    {"kind": "hook", "ja": "仕事は浅く、つながりは深く。\n東京の逆を、山で。", "en": "Work shallower. Connect deeper. The opposite of Tokyo.", "source": "place-line.ts POSITIONING_PILLARS.connect"},
]


def _key(ja: str) -> str:
    return ja.replace("\n", "").strip()


def topics_of(text: str, english: bool = False) -> set[str]:
    text = text.replace("夜通し", "")  # "all night" is about working late, not the night sky
    low = text.lower()
    return {t for t, (ja, en) in TOPICS.items() if any((w in low) if english else (w in text) for w in (en if english else ja))}


def _stored() -> dict:
    try:
        return json.loads(WORDS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"lines": []}


def _write(data: dict) -> None:
    WORDS.parent.mkdir(parents=True, exist_ok=True)
    WORDS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def bank() -> list[dict]:
    """Every line: the themes', the site's and the stored ones, with status, topics and themes that use it."""
    from studio.assemble import THEMES, VENUE_LINES

    rows: dict[str, dict] = {}

    def add(kind: str, ja: str, en: str, source: str, theme: str | None = None, **extra) -> None:
        k = _key(ja)
        row = rows.setdefault(k, {"id": hashlib.sha1(k.encode()).hexdigest()[:10], "kind": kind, "ja": ja, "en": en, "source": source,
                                  "status": "approved", "themes": [], "topics": sorted(topics_of(ja))})
        row.update({k2: v for k2, v in extra.items() if v is not None})
        if theme and theme not in row["themes"]:
            row["themes"].append(theme)

    for name, theme in THEMES.items():
        for kind, ja, en in theme["beats"]:
            add(kind, ja, en, f"theme {name}", name)
    if RANCH:  # the ranch website's approved lines belong to the Tsumagoi workspace only
        for kind, ja, en in VENUE_LINES:
            add(kind, ja, en, "venue lines")
        for s in SITE_LINES:
            add(s["kind"], s["ja"], s["en"], s["source"], months=s.get("months"))
    for s in _stored().get("lines", []):
        k = _key(s["ja"])
        if k in rows:  # a stored row only changes the status of a built-in line (retire it, bring it back)
            rows[k]["status"] = s.get("status", rows[k]["status"])
            continue
        add(s["kind"], s["ja"], s.get("en", ""), s.get("source", "owner"), months=s.get("months"))
        rows[k].update({"status": s.get("status", "approved"), "added": s.get("added"), "why": s.get("why")})
    return list(rows.values())


def usage() -> dict[str, dict]:
    """Per line: how many reels use it, and the reels (newest last)."""
    from studio.projects import all_projects

    out: dict[str, dict] = {}
    for p in sorted(all_projects(), key=lambda p: p.get("made_at") or ""):
        for b in p.get("beats") or []:
            if b.get("kind") in ("hook", "line"):
                row = out.setdefault(_key(b["ja"]), {"reels": 0, "slugs": []})
                row["reels"] += 1
                row["slugs"].append(p["slug"])
    return out


def signature(beats: list[dict]) -> str:
    """One reel's words as a comparable key: headline plus the set of lines."""
    hook = next((_key(b["ja"]) for b in beats if b.get("kind") == "hook"), "")
    lines = sorted(_key(b["ja"]) for b in beats if b.get("kind") == "line")
    return hook + "|" + "|".join(lines)


def signatures(skip: str | None = None) -> Counter:
    from studio.projects import all_projects

    return Counter(signature(p.get("beats") or []) for p in all_projects() if p.get("slug") != skip)


def same_words(slug: str) -> list[str]:
    """Other reels with exactly this reel's words."""
    from studio.projects import all_projects, load

    me = load(slug)
    if not me:
        return []
    sig = signature(me.get("beats") or [])
    return [p["slug"] for p in all_projects() if p.get("slug") != slug and signature(p.get("beats") or []) == sig]


def _recent_lines(skip: str | None = None, n: int = 8) -> list[str]:
    """Lines of the last n reels made, newest first (four per reel: headline and lines)."""
    from studio.projects import all_projects

    out: list[str] = []
    for p in sorted((p for p in all_projects() if p.get("slug") != skip), key=lambda p: p.get("made_at") or "", reverse=True)[:n]:
        beats = [b for b in p.get("beats") or [] if b.get("kind") in ("hook", "line")]
        keys = [_key(b["ja"]) for b in beats][:4]
        out += keys + [""] * (4 - len(keys))
    return out


WINDOW_DAYS = 14


def booked_near(slug: str, days: int = WINDOW_DAYS) -> set[str]:
    """Headlines of the other reels booked on the same networks within `days` of this reel's own upcoming bookings:
    the ones this reel must not use, so no network shows one headline twice in two weeks."""
    from datetime import datetime, timedelta

    from studio import posting
    from studio.projects import all_projects

    def when(p: dict):
        try:
            t = datetime.fromisoformat(p["at"])
            return t.replace(tzinfo=None) if t.tzinfo else t
        except (TypeError, ValueError):
            return None

    rows = [p for p in posting.posts() if p.get("status") in ("scheduled", "queued", "planned") and p.get("network") != "all" and when(p)]
    mine = [(p["network"], when(p)) for p in rows if p["slug"] == slug]
    if not mine:
        return set()
    hook = {pr["slug"]: next((_key(b["ja"]) for b in pr.get("beats") or [] if b.get("kind") == "hook"), "") for pr in all_projects()}
    near = timedelta(days=days)
    return {hook.get(p["slug"], "") for p in rows for net, t in mine
            if p["slug"] != slug and p["network"] == net and abs(when(p) - t) <= near} - {""}


# Words that carry a line's fact: two lines that share one say the same thing twice (草原…尾根 and 草原…尾根).
FACT_WORDS = ("草原", "尾根", "景色", "見渡", "建物", "窓", "標高", "光回線", "焚き火", "火", "紅葉", "こたつ", "区画", "テント", "駐車場",
              "民家", "10km", "星", "照明", "灯り", "外灯", "ラウンジ", "キッチン", "5組", "5台", "東京", "22", "氷点下", "車")


def fact_words(ja: str) -> set[str]:
    return {w for w in FACT_WORDS if w in ja}


# Words that only make sense over certain pictures (each clip has its season and time of day in the library).
VIEW_WORDS = ("尾根", "景色", "見渡", "遠くまで", "草原", "眺め")
WINTER_WORDS = ("冬", "氷点下", "寒い", "こたつ", "ぬくもり", "あたたか")
NIGHT_WORDS = ("星", "照明", "灯り", "暗い", "外灯", "夜空", "夜のフィールド", "夜の")
AUTUMN_WORDS = ("紅葉",)


def picture_fits(ja: str, shots: list[dict]) -> bool:
    """Whether a line suits the shots it plays over: no view of the ridge over a night shot, no winter over summer,
    a night line needs a dusk or night shot, autumn leaves need an autumn shot. Unknown clips never block a line."""
    known = [x for x in shots if x]
    if not known:
        return True
    text = ja.replace("夜通し", "").replace("冬でも", "")  # "even in winter" is a claim, not a picture of winter
    tods = {x.get("tod") for x in known}
    seasons = {x.get("season") for x in known}
    if any(w in text for w in VIEW_WORDS) and "night" in tods:
        return False
    if any(w in text for w in WINTER_WORDS) and "summer" in seasons:
        return False
    dark = sum(1 for x in known if x.get("tod") in ("night", "dusk"))
    if any(w in text for w in NIGHT_WORDS) and dark * 2 < len(known):  # most of what it plays over is dusk or night
        return False
    if any(w in text for w in AUTUMN_WORDS) and "autumn" not in seasons:
        return False
    return True


def shot_facts(shots: list[dict]) -> list[dict | None]:
    """Season and time of day of each shot, from the library (None for a clip the library does not know)."""
    from studio.db import connect
    from studio.reels import resolve

    out = []
    with connect() as con:
        for sh in shots:
            try:
                path = str(resolve(sh["src"]))
            except Exception:  # noqa: BLE001 - a missing file just has no facts
                out.append(None)
                continue
            row = con.execute("SELECT l.season, l.tod FROM library l JOIN assets a ON a.id = l.asset_id WHERE a.path = ?", (path,)).fetchone()
            out.append({"season": row[0], "tod": row[1]} if row else None)
    return out


def beat_shots(beats: list[dict], shots: list[dict], facts: list[dict | None]) -> list[list[dict | None]]:
    """For each hook and line (in order), the facts of the shots it plays over."""
    starts, t = [], 0.0
    for sh in shots:
        starts.append((t, t + sh["sec"]))
        t += sh["sec"]
    out = []
    for b in beats:
        if b.get("kind") not in ("hook", "line"):
            continue
        out.append([facts[i] for i, (a, z) in enumerate(starts) if a < b["endSec"] and z > b["startSec"] and i < len(facts)])
    return out


ROW_MAX = 14  # characters per screen row: a longer row wraps inside a word (あったかいラウ / ンジへ)
ROWS_MAX = 3


def fits_screen(ja: str) -> bool:
    rows = ja.split("\n")
    return len(rows) <= ROWS_MAX and all(len(r) <= ROW_MAX for r in rows)


def _usable(row: dict, months: set[int]) -> bool:
    """Approved, clean, short enough to sit on screen without breaking a word, and in season for every month the
    reel goes out (a line for autumn never posts in December)."""
    return (row["status"] == "approved" and fits_screen(row["ja"]) and (not row.get("months") or months <= set(row["months"]))
            and not problems(row["ja"]) and not problems(row.get("en", "")))


def post_months(slug: str | None) -> set[int]:
    """The months a reel's upcoming bookings fall in; a reel with none yet may go out this month or next."""
    from datetime import date

    today = date.today()
    nxt = 1 if today.month == 12 else today.month + 1
    if not slug:
        return {today.month, nxt}
    from studio import posting

    got = set()
    for p in posting.posts():
        if p.get("slug") == slug and p.get("status") in ("scheduled", "queued", "planned") and p.get("at"):
            try:
                got.add(int(str(p["at"])[5:7]))
            except ValueError:
                pass
    return got or {today.month, nxt}


def draw(theme_key: str, slots: list[str], rng: random.Random, n_lines: int | None = None, skip_slug: str | None = None, tries: int = 40,
         avoid: set[str] | None = None, under: list[list[dict | None]] | None = None) -> dict:
    """A headline and proof lines for one reel of this theme. `slots` are the shot searches the lines sit on
    (one per line, in order). Returns {hook: (ja, en), lines: [(ja, en)…], fresh: bool, signature}."""
    from studio.assemble import THEMES

    theme = THEMES[theme_key]
    months = post_months(skip_slug)
    rows = [r for r in bank() if _usable(r, months)]
    used = usage()
    seen = signatures(skip_slug)
    own = {_key(ja) for _, ja, _ in theme["beats"]}
    # What the theme is about: its own headline and its shots (not every word of every line it happens to use).
    want = topics_of(theme["beats"][0][1]) | set().union(*(topics_of(s, english=True) for s in theme["slots"])) or {"view"}
    recent = _recent_lines(skip_slug)
    n_lines = n_lines if n_lines is not None else max(1, len(theme["beats"]) - 1)

    def weight(row: dict, slot: str | None = None) -> float:
        fit = len(set(row["topics"]) & want)
        if not fit and _key(row["ja"]) not in own:
            return 0.0
        k = _key(row["ja"])
        w = 1.0 / (1 + used.get(k, {}).get("reels", 0)) ** 0.5  # a gentle push towards lines used less overall
        if k in recent[:3 * 4]:
            w *= 0.03  # in the last three reels made: almost never again straight away
        elif k in recent:
            w *= 0.2  # in the last eight
        w *= 1.6 if _key(row["ja"]) in own else 1.0 + 0.3 * fit
        if slot and set(row["topics"]) & topics_of(slot, english=True):
            w *= 3.0  # the line describes the shot it sits on
        return w

    def pick(pool: list[dict], slot: str | None, taken: set[str]) -> dict | None:
        said = set().union(*(set(by_key[t]["topics"]) for t in taken if t in by_key))
        facts = set().union(*(fact_words(by_key[t]["ja"]) for t in taken if t in by_key))
        pool = [r for r in pool if not (fact_words(r["ja"]) & facts)] or pool  # never the same fact twice in one reel
        cands = [(r, weight(r, slot) * (0.15 if set(r["topics"]) & said else 1.0)) for r in pool if _key(r["ja"]) not in taken
                 and not any(_key(r["ja"]) in t or t in _key(r["ja"]) for t in taken)]  # no line inside the headline; one line per topic
        cands = [(r, w) for r, w in cands if w > 0]
        new_topic = [(r, w) for r, w in cands if not set(r["topics"]) & said]
        cands = new_topic or cands  # a line on a topic not said yet, whenever there is one
        if not cands:
            return None
        return rng.choices([r for r, _ in cands], weights=[w for _, w in cands], k=1)[0]

    by_key = {_key(r["ja"]): r for r in rows}
    core = topics_of(theme["beats"][0][1]) - {"sleep"}  # what this theme is about, from its own headline
    hooks = [r for r in rows if r["kind"] == "hook"]
    if avoid:  # headlines already going out on this reel's networks around its dates: never again, if anything else fits
        free = [r for r in hooks if _key(r["ja"]) not in avoid and weight(r) > 0]
        hooks = free or hooks
    if under:  # the headline plays over the first shots: it must suit them
        fit = [r for r in hooks if picture_fits(r["ja"], under[0]) and weight(r) > 0]
        hooks = fit or hooks
    lines = [r for r in rows if r["kind"] == "line"]
    best = None
    for _ in range(tries):
        h = pick(hooks, None, set())
        if not h:
            break
        taken = {_key(h["ja"])}
        chosen = []
        for k in range(n_lines):
            slot = slots[k] if k < len(slots) else None
            pool = lines
            if under and k + 1 < len(under):
                pool = [r for r in lines if picture_fits(r["ja"], under[k + 1])] or lines
            ln = pick(pool, slot, taken)
            if not ln:
                break
            chosen.append(ln)
            taken.add(_key(ln["ja"]))
        sig = _key(h["ja"]) + "|" + "|".join(sorted(_key(c["ja"]) for c in chosen))
        # The reel keeps its own story: at least one of its words is about what the theme is about (work for office,
        # the car for carstay, the fire for fire), or every filter above could leave a work reel about car parks.
        on_theme = not core or any(set(r["topics"]) & core for r in [h, *chosen])
        score = (len(chosen) == n_lines, sig not in seen, on_theme)
        if best is None or score > best[3]:
            best = (h, chosen, sig, score)
        if score == (True, True, True):
            break
    if not best:  # nothing fits: the theme's own words, as before
        hook = theme["beats"][0]
        return {"hook": (hook[1], hook[2]), "lines": [(ja, en) for _, ja, en in theme["beats"][1:]], "fresh": False, "signature": ""}
    h, chosen, sig, _ = best
    for text in [h["ja"], h["en"], *[c["ja"] for c in chosen], *[c["en"] for c in chosen]]:
        assert_copy(text)
    return {"hook": (h["ja"], h["en"]), "lines": [(c["ja"], c["en"]) for c in chosen], "fresh": sig not in seen, "signature": sig}


def report() -> dict:
    """The Words page: every line with its use count, and how repetitive the reels are."""
    from studio.projects import all_projects

    used = usage()
    rows = bank()
    for r in rows:
        u = used.get(_key(r["ja"]), {"reels": 0, "slugs": []})
        r["reels"] = u["reels"]
        r["recent"] = u["slugs"][-3:]
    projects = all_projects()
    sigs = Counter(signature(p.get("beats") or []) for p in projects if p.get("beats"))
    hooks = Counter(next((_key(b["ja"]) for b in p.get("beats") or [] if b.get("kind") == "hook"), "") for p in projects)
    hooks.pop("", None)
    repeated = sum(n for n in sigs.values() if n > 1)
    return {
        "lines": sorted(rows, key=lambda r: (r["kind"] != "hook", r["status"] != "approved", -r["reels"])),
        "reels": len(projects),
        "wordSets": len(sigs),
        "hooksUsed": len(hooks),
        "repeatedReels": repeated,
        "topHook": hooks.most_common(1)[0] if hooks else None,
        "approved": {k: sum(1 for r in rows if r["kind"] == k and r["status"] == "approved") for k in ("hook", "line")},
        "suggested": sum(1 for r in rows if r["status"] == "suggested"),
        "file": str(WORDS),
    }


def save_line(kind: str, ja: str, en: str, status: str = "approved", source: str = "owner", why: str | None = None, months: list[int] | None = None) -> dict:
    """Add or update one stored line. Approved and suggested lines must pass the fact guard."""
    if kind not in ("hook", "line"):
        raise ValueError("kind: hook or line")
    if status not in ("approved", "suggested", "retired"):
        raise ValueError("status: approved, suggested or retired")
    ja, en = ja.strip(), en.strip()
    if not ja or len(_key(ja)) > 40:
        raise ValueError("a line is 1 to 40 characters of Japanese")
    if status != "retired" and not fits_screen(ja):
        raise ValueError(f"each screen row is at most {ROW_MAX} characters, at most {ROWS_MAX} rows: break the line where a reader pauses")
    if status != "retired":
        assert_copy(ja)
        assert_copy(en)
    data = _stored()
    k = _key(ja)
    for s in data["lines"]:
        if _key(s["ja"]) == k:
            s.update({"kind": kind, "ja": ja, "en": en or s.get("en", ""), "status": status})
            break
    else:
        data["lines"].append({"kind": kind, "ja": ja, "en": en, "status": status, "source": source, "why": why, "months": months,
                              "added": time.strftime("%Y-%m-%d")})
    _write(data)
    return next(r for r in bank() if _key(r["ja"]) == k)


def set_status(ja: str, status: str) -> dict:
    row = next((r for r in bank() if _key(r["ja"]) == _key(ja)), None)
    if not row:
        raise KeyError("no such line")
    return save_line(row["kind"], row["ja"], row.get("en", ""), status, row.get("source", "owner"))


def reword(slug: str, seed: int | None = None, save_it: bool = True) -> dict:
    """New approved words for an existing reel: same shots and timings, a fresh headline and lines, and a caption, title,
    hashtags and text layout made from them. Saved without rendering; the next render sends it back to review."""
    from studio.assemble import THEMES, vary_copy
    from studio.projects import load, save

    project = load(slug)
    if not project:
        raise KeyError(f"{slug} has no project file (house reels keep their fixed words)")
    key = project.get("theme") or slug.split("-")[0]
    if key not in THEMES:
        raise ValueError(f"{slug}: no theme to draw words for")
    theme = THEMES[key]
    rng = random.Random(seed)
    lines_at = [b for b in project["beats"] if b["kind"] == "line"]
    cue_slots = [theme["slots"][c] if c < len(theme["slots"]) else theme["slots"][-1] for c in theme.get("cues", [])]
    under = beat_shots(project["beats"], project.get("shots") or [], shot_facts(project.get("shots") or []))
    drawn = draw(key, cue_slots, rng, n_lines=len(lines_at), skip_slug=slug, avoid=booked_near(slug), under=under)
    beats, k = [], 0
    for b in project["beats"]:
        b = dict(b)
        b.pop("side", None)
        if b["kind"] == "hook":
            b["ja"], b["en"] = drawn["hook"]
        elif b["kind"] == "line" and k < len(drawn["lines"]):
            b["ja"], b["en"] = drawn["lines"][k]
            k += 1
        beats.append(b)
    project["beats"] = beats
    project.update(vary_copy(project, theme, rng))
    project["words"] = {"fresh": drawn["fresh"], "from": "bank", "redrawn": time.strftime("%Y-%m-%dT%H:%M:%S")}
    if save_it:
        save(project)
    return {"slug": slug, "beats": beats, "fresh": drawn["fresh"], "style": project["style"], "yt_title": project["yt_title"],
            "post": project["posts"].get("ja", ""), "posts": project["posts"], "tags": project["tags"], "words": project["words"]}


SUGGEST_SYSTEM = (
    "You write on-screen lines for short vertical videos of a mountain campsite and workation place in Japan. "
    "Use ONLY facts stated in the approved copy you are given: never add a number, a place, an amenity, a feeling the copy "
    "does not support, a price, or a promise about the sky. Never write 天の川, 満天, 何もない, or the bare word 牧場. "
    "House style: calm, plain, Shippori Mincho; a headline (hook) is 8-22 Japanese characters, often the owner's form "
    "「〜からこそ、〜」 or a short fact; a proof line is 8-24 characters, one checkable fact. Put a screen line break "
    "as \\n where a reader would pause (at most 2 rows). Each needs a plain English version. Do not repeat or lightly "
    "reword the lines in `already` (they are in use). Reply JSON only: "
    "{\"lines\":[{\"kind\":\"hook|line\",\"ja\":\"...\",\"en\":\"...\",\"from\":\"the approved sentence it rests on\"}]}"
)


def suggest_system() -> str:
    """The line-writer's brief: the ranch's house rules, or this project's name and its own banned words."""
    from studio.brand import RANCH, brand, copy_rules

    if RANCH:
        return SUGGEST_SYSTEM
    name, rules = brand()["name"] or "a small business", copy_rules()
    never = ", ".join(rules["banned"][:40])
    return (f"You write on-screen lines for short vertical videos for {name}. Use ONLY facts stated in the approved copy "
            "you are given: never add a number, a place, a feature or a promise the copy does not support"
            + (", or a price" if rules["noPrices"] else "") + "." + (f" Never write: {never}." if never else "")
            + " A headline (hook) is short and calm; a proof line is one checkable fact. Write the main line in the language "
            "of the approved copy and a plain English version. Put a screen line break as \\n where a reader would pause "
            "(at most 2 rows). Do not repeat or lightly reword the lines in `already`. Reply JSON only: "
            "{\"lines\":[{\"kind\":\"hook|line\",\"ja\":\"...\",\"en\":\"...\",\"from\":\"the approved sentence it rests on\"}]}")


def suggest_lines(req: dict) -> dict:
    """AI drafts of new lines from the approved copy only. They are saved as "suggested": no reel uses one until a
    person approves it on the Words page. Numbers not in the approved copy, and anything the fact guard refuses,
    are dropped before saving."""
    import re

    from studio.research import _llm, approved_copy

    copy = [t for _, t in approved_copy() if t and len(t) < 400]
    corpus = "\n".join(copy)
    already = [r["ja"].replace("\n", "") for r in bank()]
    n = max(2, min(12, int(req.get("n", 8))))
    topic = str(req.get("topic") or "")[:60]
    got = _llm(suggest_system(), json.dumps({"approved_copy": sorted(set(copy))[:120], "already": already, "how_many": n,
                                           "topic": topic or "any"}, ensure_ascii=False), purpose="words-suggest", max_tokens=2400)
    if got is None:
        raise ValueError("No AI answer: add an OpenRouter key in Settings › Keys & AI, or today's AI budget is used up.")
    kept, dropped = [], []
    for s in (got.get("lines") or [])[:n]:
        ja, en, kind = str(s.get("ja", "")).strip(), str(s.get("en", "")).strip(), s.get("kind", "line")
        nums = re.findall(r"\d[\d,.]*", ja + " " + en)
        why = None
        if not ja or not en or kind not in ("hook", "line"):
            why = "incomplete"
        elif any(x.rstrip(".,") not in corpus for x in nums):
            why = "a number not in the approved copy"
        elif problems(ja) or problems(en):
            why = "fact guard: " + ", ".join(problems(ja) + problems(en))
        elif _key(ja) in {_key(a) for a in already}:
            why = "already in the bank"
        if why:
            dropped.append({"ja": ja, "why": why})
            continue
        kept.append(save_line(kind, ja, en, status="suggested", source="AI suggestion", why=str(s.get("from", ""))[:200]))
    return {"suggested": kept, "dropped": dropped}


def main(argv: list[str]) -> int:
    action = argv[0] if argv else "report"
    req = json.loads(sys.stdin.read() or "{}") if action in ("add", "status", "suggest", "reword") else {}
    try:
        if action == "report":
            out = report()
        elif action == "draw":
            rng = random.Random(int(argv[2]) if len(argv) > 2 else None)
            from studio.assemble import THEMES
            out = draw(argv[1], THEMES[argv[1]]["slots"], rng)
        elif action == "add":
            out = save_line(req.get("kind", "line"), req.get("ja", ""), req.get("en", ""), req.get("status", "approved"), req.get("source", "owner"), req.get("why"))
        elif action == "status":
            out = set_status(req.get("ja", ""), req.get("status", "approved"))
        elif action == "suggest":
            out = suggest_lines(req)
        elif action == "reword":
            out = reword(str(req.get("slug", "")), req.get("seed"), save_it=not req.get("preview"))
        else:
            raise ValueError(f"unknown action {action}")
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except (ValueError, KeyError) as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
