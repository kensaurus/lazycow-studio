"""
FILE: py/studio/layers.py
PURPOSE: A second picture track (V2) over the main shots, so a reel is not one row of clips:
         - a B-roll **cutaway**: a detail shot laid over a running base shot. The base keeps its sound, so the cut
           in and out reads as an L/J cut, the way an editor cuts away and back;
         - an **inset**: a tilted paper print (frame-in-frame) of a second clip over the base shot.
OVERVIEW: `plan(...)` picks 0-2 layers for a new reel. It never uses a file already in the reel, never sits on the
          opening half second or the end card, never overlaps another layer, and keeps people out unless the reel
          allows them (no clip is changed or masked: a person in a layer appears exactly as filmed).
          `check(reel)` is the render gate for layers; `render(reel)` grades each layer clip with the same house
          grade as the shots and returns the Remotion props (src, atSec, durationSec, kind, rect, tilt).
DEPENDENCIES: studio.library, studio.shot, studio.pick
USAGE: from studio.layers import plan, check, render
NOTES: The evidence and the ranked list of techniques are in docs/research/2026-11-10-multilayer-editing.md.
       Cut-outs (subject masks), text behind the ridge and parallax need a segmentation or depth model; see the
       research doc and docs/ROADMAP.md.
"""
from __future__ import annotations

import random
from pathlib import Path

KINDS = ("cutaway", "inset")
GRID = 0.5
MAX_LAYERS = 3
# Where an inset sits (fractions of the frame): upper left or upper right, clear of the lower captions.
INSET_RECTS = ({"x": 0.06, "y": 0.13, "w": 0.46, "h": 0.30}, {"x": 0.48, "y": 0.13, "w": 0.46, "h": 0.30})
# The detail shots a cutaway or inset looks for (plain words for the library search), by what the reel is about.
DETAIL = {
    "fire": ["flames in a fire pit close up", "a hand holding a cup", "food cooking on a grill"],
    "work": ["a laptop keyboard close up", "a cup of coffee on a desk", "hands typing on a laptop"],
    "car": ["a car door or window close up", "a tent next to a car", "a road through the hills"],
    "field": ["grass moving in the wind", "a tent door opening", "a bell tent on grass"],
    "night": ["string lights at night", "embers of a campfire", "a lantern in the dark"],
    "warm": ["a kotatsu table inside", "a mug of a hot drink", "a blanket and a window"],
    "view": ["clouds moving over mountains", "a drone view of the forest", "the ridge line at dusk"],
}


def _starts(shots: list[dict]) -> list[float]:
    out, t = [], 0.0
    for s in shots:
        out.append(t)
        t += s["sec"]
    return out


def _topic(theme: dict) -> str:
    from studio.wording import topics_of

    found = topics_of(theme["beats"][0][1]) | set().union(*(topics_of(s, english=True) for s in theme["slots"]))
    for t in ("fire", "work", "car", "field", "night", "warm", "view"):
        if t in found:
            return t
    return "view"


def plan(theme: dict, shots: list[dict], used: set[str], rng: random.Random, allow_faces: bool = False,
         end_at: float | None = None) -> list[dict]:
    """Up to two V2 layers for a new reel. `shots` are the chosen main shots (src, sec), `used` the file names
    already in the reel (lower case). Returns [] when nothing fits; a reel without layers is still a good reel."""
    from studio.assemble import JUNK_MAX, _src
    from studio.library import items

    n = rng.choices([0, 1, 2], weights=[0.2, 0.5, 0.3])[0]
    if n == 0 or len(shots) < 4:
        return []
    starts = _starts(shots)
    total = starts[-1] + shots[-1]["sec"]
    end_at = end_at if end_at is not None else starts[-1]
    queries = DETAIL[_topic(theme)] + [s for s in theme["slots"][1:]]
    rng.shuffle(queries)
    bases = [i for i in range(1, len(shots) - 1) if shots[i]["sec"] >= 1.5]
    rng.shuffle(bases)
    out: list[dict] = []
    taken: list[tuple[float, float]] = []
    for i in bases:
        if len(out) >= n:
            break
        kind = rng.choice(KINDS)
        sec = 1.0 if kind == "cutaway" else min(2.0, round((total - starts[i] - 1.0) / GRID) * GRID)
        at = starts[i] + GRID  # the base shot shows first, then the layer comes in, then the base returns
        if kind == "cutaway" and shots[i]["sec"] < sec + 1.0:
            continue
        if sec < 1.0 or at + sec > end_at or any(not (at + sec <= a or at >= b) for a, b in taken):
            continue
        pick = None
        for q in queries:
            pool = items(q, {"ranch": True, "noFaces": not allow_faces, "kind": "video"}, limit=40)
            pool = [p for p in pool if p["file"].lower() not in used and p.get("junk", 0) < JUNK_MAX and not p.get("vetoed")
                    and (allow_faces or "people" not in p["top"]) and (p["duration"] or 0) >= sec + 0.8]
            if pool:
                top = pool[:4]
                pick = (q, top[rng.randrange(len(top))])
                break
        if not pick:
            continue
        q, cand = pick
        used.add(cand["file"].lower())
        layer = {"track": 2, "kind": kind, "src": _src(cand["path"]), "at": round(at, 2), "sec": sec,
                 "role": f"auto {kind}: {q} (match {cand.get('match')})"}
        if kind == "inset":
            layer["rect"] = dict(rng.choice(INSET_RECTS))
            layer["tilt"] = round(rng.uniform(-5.0, 5.0), 1)
        out.append(layer)
        taken.append((at, at + sec))
    return sorted(out, key=lambda x: x["at"])


def check(reel: dict) -> list[str]:
    """Render gate for layers: inside the reel, clear of the hook's first half second and of each other, no file
    used twice (shots and layers together), at most three, 0.5-3 s each."""
    layers = reel.get("layers") or []
    if not layers:
        return []
    problems = []
    total = sum(s["sec"] for s in reel["shots"])
    if len(layers) > MAX_LAYERS:
        problems.append(f"too many layers: {len(layers)} (at most {MAX_LAYERS})")
    names = [Path(s["src"]).name.lower() for s in reel["shots"]] + [Path(x["src"]).name.lower() for x in layers]
    if len(set(names)) != len(names):
        problems.append("a layer uses a file that is already in the reel")
    spans = []
    for x in layers:
        if x.get("kind") not in KINDS:
            problems.append(f"unknown layer kind: {x.get('kind')}")
        at, sec = float(x.get("at", 0)), float(x.get("sec", 0))
        if not 0.5 <= sec <= 3.0:
            problems.append(f"layer {Path(x['src']).name}: {sec}s (0.5-3 s)")
        if at < 0.5 or at + sec > total + 1e-6:
            problems.append(f"layer {Path(x['src']).name} at {at}s is outside the reel or on the opening")
        spans.append((at, at + sec))
    spans.sort()
    if any(spans[k + 1][0] < spans[k][1] - 1e-6 for k in range(len(spans) - 1)):
        problems.append("two layers overlap")
    return problems


def render(reel: dict, mezz: Path, blur: bool = False) -> tuple[list[dict], list[dict], list[dict]]:
    """Grade each layer clip (same house grade as the shots) and return (tall props, wide props, meta)."""
    from studio.pick import best_window, faces_at
    from studio.reels import is_output, off_site, resolve
    from studio.shot import render_shot

    tall, wide, meta = [], [], []
    for k, x in enumerate(reel.get("layers") or []):
        src = resolve(x["src"])
        if off_site(src):
            raise RuntimeError(f"location gate: nothing places {src} at the ranch (GPS, folder or event)")
        if is_output(src):
            raise RuntimeError(f"source gate: {src} is a finished edit, not footage")
        start = x.get("start")
        if start is None:
            start = best_window(src, x["sec"])["start"]
        faces = faces_at(src, start, x["sec"])
        inset = x["kind"] == "inset"
        for size, bucket, tag in (((720, 900) if inset else (1080, 1920), tall, "t"), ((720, 900) if inset else (1920, 1080), wide, "w")):
            out = mezz / f"L{k:02d}_{tag}.mp4"
            mark = f"{x['src']}|{start}|{x['sec']}|{x['kind']}|blur={int(blur)}"
            stamp = out.with_suffix(".key")
            if not out.exists() or not stamp.exists() or stamp.read_text(encoding="utf-8") != mark:
                render_shot(src, start, x["sec"], out, size, blur=blur)
                stamp.write_text(mark, encoding="utf-8")
            bucket.append({"src": f"mezz/{reel['slug']}/{out.name}", "atSec": x["at"], "durationSec": x["sec"], "kind": x["kind"],
                           **({"rect": x.get("rect") or INSET_RECTS[0], "tilt": x.get("tilt", 0)} if inset else {})})
        meta.append({"i": f"L{k}", "src": src, "rel": x["src"], "sec": x["sec"], "role": x.get("role", x["kind"]), "start": start, "faces": faces})
    for stale in mezz.glob("L*_[tw].mp4"):
        if int(stale.name[1:3]) >= len(reel.get("layers") or []):
            stale.unlink()
    return tall, wide, meta
