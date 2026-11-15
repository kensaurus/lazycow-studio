"""
FILE: py/studio/devices.py
PURPOSE: The editing devices of a long video, so a film is not one row of clips with one dissolve:
         - a transition per shot (how it enters over the one before), chosen per look;
         - picture layers over the running film: a multicam split (the same minute from two or three cameras),
           picture-in-picture, prints of the day's photos landing on paper, a freeze-to-print snapshot when an animal
           first appears, and a light leak over a chapter change;
         - the sound that goes with them: a whoosh only where the picture moves, a soft tick on a snapshot or a print,
           and each chapter's own quiet ambience under its photographs.
OVERVIEW: Pure planning over the film's timeline (shot starts, roles, chapters, overlays). studio.vlog.build calls
          `plan(...)`, renders the few extra files it asks for (pane clips, stills, ambience loops) and passes the result
          to src/Vlog.tsx as props (`tin` per shot, `layers`, `ambience`) and to studio.sound.mix as effects.
          Budget rules (docs/research/2026-11-13-360-moves-and-layers.md):
            - nothing over the cold open, the title, "previously", the end card or a caption on screen;
            - at most MAX_PER_CHAPTER layers a chapter, never two at once, at least GAP s apart;
            - a motion transition (whip, zoom, slide) at most every MOTION_GAP s, and always with a whoosh;
            - the same device not twice in a row.
DEPENDENCIES: none (stdlib); studio.vlog supplies the timeline and the library rows.
USAGE: from studio import devices; d = devices.plan(seq, starts, roles, chapters, overlays, look, lib, seed)
"""
from __future__ import annotations

import random
from datetime import datetime

# How each look moves from shot to shot: its everyday join and the joins it uses at a chapter change or for a lift.
TRANSITIONS = {
    "documentary": {"base": "dissolve", "chapter": ["iris", "wipe", "zoom"], "lift": ["wipe", "slide"]},
    "cinematic": {"base": "dissolve", "chapter": ["zoom", "wipe", "iris"], "lift": ["whip", "slide"]},
    "energetic": {"base": "cut", "chapter": ["flash", "whip"], "lift": ["flash", "whip", "zoom"]},
    "journal": {"base": "dissolve", "chapter": ["slide", "wipe"], "lift": ["slide"]},
    "retro": {"base": "cut", "chapter": ["flash", "wipe"], "lift": ["flash"]},
    "fieldguide": {"base": "dissolve", "chapter": ["wipe", "iris"], "lift": ["clock", "wipe"]},
    "monochrome": {"base": "dissolve", "chapter": ["iris", "dissolve"], "lift": ["clock"]},
    "slow": {"base": "dissolve", "chapter": ["dissolve"], "lift": []},
    "roadmovie": {"base": "dissolve", "chapter": ["whip", "slide", "wipe"], "lift": ["whip", "zoom"]},
}
MOTION = {"whip", "zoom", "slide"}          # joins that move the picture: they get a whoosh
NEEDS_OVERLAP = {"iris", "wipe", "clock", "slide", "whip", "zoom", "dissolve"}  # joins drawn inside the fade window
MOTION_GAP = 18.0     # seconds between two moving joins
LIFT_EVERY = 4        # inside a chapter, every this many shots one shot may enter with the look's "lift" join

# Which layers each look uses (the slow film keeps its single, quiet track).
LAYERS = {
    "documentary": ["split", "pip", "prints", "snapshot", "leak"],
    "cinematic": ["split", "pip", "leak"],
    "energetic": ["split", "prints", "snapshot"],
    "journal": ["prints", "snapshot", "pip", "leak"],
    "retro": ["split", "prints", "leak"],
    "fieldguide": ["snapshot", "pip", "split"],
    "monochrome": ["split", "prints"],
    "slow": [],
    "roadmovie": ["split", "pip", "leak"],
}
MAX_PER_CHAPTER = 2
GAP = 12.0            # seconds between two layers
SPLIT_SEC = (3.5, 5.0)
PIP_SEC = (3.0, 4.5)
PRINTS_SEC = (3.6, 4.8)
SNAP_SEC = 3.2
LEAK_SEC = 1.1
MULTICAM_WINDOW = 120.0  # seconds: clips from other cameras this close in time show "the same moment"
PRINTS_MAX = 4


def _t(item: dict) -> float | None:
    """When a picture was taken, as epoch seconds (None when unknown)."""
    v = item.get("captured") or item.get("local")
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def camera(item: dict) -> str:
    """The camera that took a picture: the library's device, else the folder it came from."""
    d = str(item.get("device") or "").strip()
    if d:
        return d.lower()
    p = str(item.get("path") or "").replace("\\", "/")
    return p.rsplit("/", 2)[-2].lower() if "/" in p else ""


def transitions(roles: list[str], starts: list[float], chapter_at: list[float], look: str, seed: int = 0,
                overlap: bool = True) -> list[str]:
    """How each shot enters over the one before. The first shot of a chapter takes one of the look's chapter joins; a
    few shots inside a chapter take its lift join; the rest the look's base. Moving joins stay MOTION_GAP apart and the
    same join never comes twice in a row. Without an overlap (a hard-cut look) only cuts and flashes are possible."""
    t = TRANSITIONS.get(look, TRANSITIONS["documentary"])
    rnd = random.Random(seed)
    chap = {round(a, 2) for a in chapter_at}
    out, last_motion, last, since = [], -1e9, "", 0
    for k, (role, at) in enumerate(zip(roles, starts)):
        pick = t["base"]
        if k == 0:
            pick = "cut"
        elif role == "body":
            since += 1
            pool: list[str] = []
            if round(at, 2) in chap:
                pool, since = list(t["chapter"]), 0
            elif t["lift"] and since >= LIFT_EVERY and rnd.random() < 0.5:
                pool, since = list(t["lift"]), 0
            pool = [p for p in pool if p != last and (p not in MOTION or at - last_motion >= MOTION_GAP)]
            if not overlap:
                pool = [p for p in pool if p not in NEEDS_OVERLAP]
            if pool:
                pick = rnd.choice(pool)
        if not overlap and pick in NEEDS_OVERLAP:
            pick = "cut"
        if pick in MOTION:
            last_motion = at
        out.append(pick)
        last = pick
    return out


def sphere_handoffs(seq: list[dict], tins: list[str], overlap: bool = True) -> list[str]:
    """A 360 shot moves its own camera into and out of the cut (studio.sphere transitions, its move's head and tail):
    one that starts with a whip enters on a plain cut (the whip is inside the shot); one that ends whipping hands the
    motion on, so the next shot enters with a whip in the same direction; one that ends in a roll cuts plainly."""
    out = list(tins)
    for k, s in enumerate(seq):
        mv = s.get("move") if s.get("is360") else None
        if not mv or len(mv) < 4:
            continue
        head, tail = mv[2], mv[3]
        if head and k > 0:
            out[k] = "cut"
        if tail and k + 1 < len(out):
            out[k + 1] = "whip" if tail == "whip" and overlap else "cut"
    return out


def whooshes(tins: list[str], starts: list[float]) -> list[float]:
    """Seconds where a whoosh starts: 0.25 s before each moving join (and never on a dissolve or a cut)."""
    return [round(max(0.0, s - 0.25), 2) for tin, s in zip(tins, starts) if tin in MOTION]


def _busy(spans: list[tuple[float, float]], a: float, b: float) -> bool:
    return any(a < y and b > x for x, y in spans)


def free_spans(roles: list[str], starts: list[float], secs: list[float], blocked: list[tuple[float, float]]) -> list[tuple[int, float, float]]:
    """Body shots (index, start, end) that a layer may cover: the middle of the shot, clear of every blocked span."""
    out = []
    for k, (role, s, d) in enumerate(zip(roles, starts, secs)):
        if role != "body" or d < 3.0:
            continue
        a, b = s + 0.6, s + d - 0.5
        if b - a >= 2.5 and not _busy(blocked, a, b):
            out.append((k, a, b))
    return out


def multicam(seq: list[dict], k: int, lib: list[dict], used: set[str], most: int = 2) -> list[dict]:
    """Clips from other cameras taken within MULTICAM_WINDOW s of shot k: the same moment from another angle. Each
    from a different camera, not in the film already, longest first."""
    me = seq[k]
    t0 = _t(me)
    if t0 is None:
        return []
    mine = camera(me)
    seen, out = {mine}, []
    near = [(abs((_t(r) or 1e18) - t0), r) for r in lib
            if r.get("kind") == "video" and r.get("path") not in used and r.get("path") != me.get("path")
            and not r.get("is360") and float(r.get("duration") or 0) >= 3.0]
    for gap, r in sorted(near, key=lambda x: (x[0], -float(x[1].get("duration") or 0))):
        if gap > MULTICAM_WINDOW:
            break
        c = camera(r)
        if c and c not in seen:
            seen.add(c)
            out.append(r)
            if len(out) >= most:
                break
    return out


def same_day_photos(seq: list[dict], k: int, lib: list[dict], used: set[str], most: int = PRINTS_MAX) -> list[dict]:
    """Photos from the day of shot k that the film does not show: the prints that land on paper."""
    day = str(seq[k].get("local") or seq[k].get("captured") or "")[:10]
    if not day:
        return []
    rows = [r for r in lib if r.get("kind") == "photo" and r.get("path") not in used and not r.get("is360")
            and str(r.get("local") or r.get("captured") or "")[:10] == day]
    rows.sort(key=lambda r: -float(r.get("aesthetic") or 0))
    return rows[:most]


def plan(seq: list[dict], starts: list[float], roles: list[str], chapter_at: list[float], blocked: list[tuple[float, float]],
         look: str, lib: list[dict], seed: int = 0, overlap: bool = True, subjects: list[tuple[float, int]] | None = None) -> dict:
    """Everything above for one film. Returns {"tins": [...], "whooshes": [s], "layers": [{kind, k, atSec, sec, ...}]}.
    `blocked`: spans where words are on screen (titles, chapter labels, notes, the end card). `subjects`: (seconds, shot
    index) where an animal is first named: a snapshot sits there (the label is drawn by the film, the print beside it)."""
    rnd = random.Random(seed + 7)
    secs = [float(s["sec"]) for s in seq]
    tins = sphere_handoffs(seq, transitions(roles, starts, chapter_at, look, seed, overlap), overlap)
    used = {s.get("path") for s in seq}
    kinds = list(LAYERS.get(look, []))
    layers: list[dict] = []
    taken: list[tuple[float, float]] = []
    per_chapter: dict[int, int] = {}
    edges = sorted(chapter_at)

    def chapter_of(t: float) -> int:
        n = 0
        for i, a in enumerate(edges):
            if t >= a:
                n = i
        return n

    def room(a: float, b: float) -> bool:
        return not _busy(taken, a - GAP, b + GAP) and per_chapter.get(chapter_of(a), 0) < MAX_PER_CHAPTER

    def add(layer: dict) -> None:
        a, b = layer["atSec"], layer["atSec"] + layer["sec"]
        taken.append((a, b))
        c = chapter_of(a)
        per_chapter[c] = per_chapter.get(c, 0) + 1
        layers.append(layer)

    # A light leak over each chapter change (it covers the join, so it ignores the word spans).
    if "leak" in kinds:
        for a in edges[1:]:
            layers.append({"kind": "leak", "atSec": round(max(0.0, a - LEAK_SEC / 2), 2), "sec": LEAK_SEC, "seed": rnd.randint(0, 999)})
    # Snapshots where an animal is first named (the freeze sits on the label's shot).
    if "snapshot" in kinds:
        for at, k in subjects or []:
            if 0 <= k < len(seq) and roles[k] == "body" and seq[k].get("kind") == "video" and room(at, at + SNAP_SEC):
                add({"kind": "snapshot", "k": k, "atSec": round(at, 2), "sec": SNAP_SEC, "offset": round(at - starts[k], 2),
                     "tilt": rnd.choice([-4, -3, 3, 4])})
    free = free_spans(roles, starts, secs, blocked)
    rnd.shuffle(free)
    free.sort(key=lambda x: x[1])
    last_kind = ""
    for k, a, b in free:
        order = [x for x in kinds if x not in ("leak", "snapshot") and x != last_kind]
        rnd.shuffle(order)
        for kind in order:
            if kind == "split" and seq[k].get("kind") == "video":
                other = multicam(seq, k, lib, used)
                sec = min(b - a, rnd.uniform(*SPLIT_SEC))
                if other and sec >= 3.0 and room(a, a + sec):
                    for r in other:
                        used.add(r.get("path"))
                    add({"kind": "split", "k": k, "atSec": round(a, 2), "sec": round(sec, 2), "with": [r["path"] for r in other]})
                    last_kind = kind
                    break
            elif kind == "pip" and seq[k].get("kind") == "video":
                other = multicam(seq, k, lib, used, most=1)
                sec = min(b - a, rnd.uniform(*PIP_SEC))
                if other and sec >= 2.8 and room(a, a + sec):
                    used.add(other[0].get("path"))
                    add({"kind": "pip", "k": k, "atSec": round(a, 2), "sec": round(sec, 2), "with": [other[0]["path"]],
                         "corner": rnd.choice(["tr", "tl"])})
                    last_kind = kind
                    break
            elif kind == "prints":
                photos = same_day_photos(seq, k, lib, used)
                sec = min(b - a, rnd.uniform(*PRINTS_SEC))
                if len(photos) >= 2 and sec >= 3.0 and room(a, a + sec):
                    for r in photos:
                        used.add(r.get("path"))
                    add({"kind": "prints", "k": k, "atSec": round(a, 2), "sec": round(sec, 2), "with": [r["path"] for r in photos],
                         "tilts": [rnd.choice([-7, -5, -3, 3, 5, 7]) for _ in photos]})
                    last_kind = kind
                    break
    layers.sort(key=lambda x: x["atSec"])
    # A 360 shot that whips or rolls in by itself gets its whoosh too (its join is a plain cut).
    own = [round(max(0.0, starts[k] - 0.1), 2) for k, s in enumerate(seq)
           if k and s.get("is360") and len(s.get("move") or []) >= 4 and s["move"][2] in ("whip", "rollx")]
    return {"tins": tins, "whooshes": sorted(whooshes(tins, starts) + own), "layers": layers}


def ticks(layers: list[dict]) -> list[tuple[str, float]]:
    """The small sounds of the layers: a shutter-like tick on a snapshot, a paper slap per landing print."""
    out = []
    for l in layers:
        if l["kind"] == "snapshot":
            out.append(("tick", round(l["atSec"], 2)))
        elif l["kind"] == "prints":
            n = len(l.get("with") or [])
            step = min(0.7, (l["sec"] - 1.2) / max(1, n))
            out += [("paper", round(l["atSec"] + 0.15 + i * step, 2)) for i in range(n)]
        elif l["kind"] in ("split", "pip"):
            out.append(("swish", round(max(0.0, l["atSec"] - 0.1), 2)))
    return out


def ambience_runs(seq: list[dict], starts: list[float], roles: list[str], chapter_at: list[float], min_sec: float = 5.0) -> list[dict]:
    """Stretches of photographs inside a chapter (they carry no sound of their own): the chapter's ambience goes under
    them. [{"chapter": i, "atSec", "sec"}]."""
    edges = sorted(chapter_at)
    runs, cur = [], None
    for k, (s, role, at) in enumerate(zip(seq, roles, starts)):
        ch = max([i for i, a in enumerate(edges) if at >= a] or [0])
        photo = role == "body" and s.get("kind") != "video"
        end = at + float(s["sec"])
        if photo and cur and cur["chapter"] == ch:
            cur["end"] = end
        else:
            if cur:
                runs.append(cur)
            cur = {"chapter": ch, "atSec": at, "end": end} if photo else None
    if cur:
        runs.append(cur)
    return [{"chapter": r["chapter"], "atSec": round(r["atSec"], 2), "sec": round(r["end"] - r["atSec"], 2)} for r in runs if r["end"] - r["atSec"] >= min_sec]
