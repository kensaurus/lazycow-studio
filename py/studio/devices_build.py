"""
FILE: py/studio/devices_build.py
PURPOSE: Puts a long video's editing devices (studio.devices) into its Remotion props during studio.vlog.build:
         a join per shot (props.shots[k].tin), picture layers over the running film (props.layers), and each chapter's
         own sound under its photographs (props.ambience). Renders the few extra files they need (split panes, the
         inset, prints, a snapshot still, ambience loops) into the film's mezzanine folder, and returns the sound effects
         that go with them for studio.sound.mix.
DEPENDENCIES: studio.devices (the plan), studio.shot.render_shot (the same grade as every shot), studio.sound (effects)
USAGE: sfx = devices_build.apply(props, jobs, done, starts, roles, look, L, lib, mezz, slug, total, end_at, title_at,
                                 title_sec, held, recap)
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from studio import devices

DEVICES_V = "1"       # bump when the device renders change: their files are named by it
AMBIENCE_GAIN = 0.32  # the chapter's own sound under its photographs: present, never louder than a clip
SFX_GAIN = {"whoosh": 0.18, "tick": 0.26, "paper": 0.2, "swish": 0.14}


def dev_path(mezz: Path, kind: str, key: str) -> Path:
    return mezz / f"dev{DEVICES_V}_{kind}_{hashlib.sha1(key.encode()).hexdigest()[:10]}.mp4"


def same_moment(base: dict, base_at: float, other: dict, sec: float) -> float:
    """Where in `other` the moment shown by `base` at `base_at` s into its file is (from both clips' capture times),
    inside the clip; the middle of the clip when the times are unknown or far apart."""
    dur = float(other.get("duration") or sec)
    t_b, t_o = devices._t(base), devices._t(other)
    mid = max(0.0, (dur - sec) / 2)
    if t_b is None or t_o is None:
        return mid
    at = t_b + base_at - t_o
    return mid if not (-30.0 <= at <= dur + 30.0) else min(max(0.0, at), max(0.0, dur - sec))


def blocked_spans(props: dict, total: float, end_at: float | None, title_at: float, title_sec: float,
                  recap: dict | None = None) -> list[tuple[float, float]]:
    """Where words or cards are on screen: no layer goes there."""
    chapter_at = [float(c["atSec"]) for c in props["chapters"]]
    spans = [(0.0, title_at + title_sec + 0.5)]       # the cold open and the title card
    spans += [(a, a + 5.6) for a in chapter_at]        # each chapter's label
    spans += [(float(o["atSec"]), float(o["atSec"]) + float(o["sec"])) for o in props.get("overlays") or []]
    if recap:
        spans.append((float(recap["atSec"]), float(recap["atSec"]) + float(recap["sec"])))
    spans.append(((end_at if end_at is not None else total - 15.0) - 1.0, total))
    return spans


def effects(whooshes: list[float], layers: list[dict], chapter_at: list[float], have: dict) -> list[dict]:
    """The devices' sounds: a whoosh on each moving join (not where a chapter's own whoosh already plays, which starts
    0.45 s before the chapter), and the layers' ticks, paper slaps and swishes."""
    out = []
    for i, at in enumerate(whooshes):
        w = have.get(f"whoosh_{i % 3 + 1}")
        if w and all(abs(at - (a - 0.45)) > 1.2 for a in chapter_at):
            out.append({"name": "whoosh", "file": str(w), "at": at, "gain": SFX_GAIN["whoosh"]})
    out += [{"name": n, "file": str(have[n]), "at": at, "gain": SFX_GAIN[n]} for n, at in devices.ticks(layers) if have.get(n)]
    return out


def apply(props: dict, jobs: list, done: dict, starts: list[float], roles: list[str], look: str, L: dict, lib: dict,
          mezz: Path, slug: str, total: float, end_at: float | None, title_at: float, title_sec: float, held: dict,
          recap: dict | None = None) -> list[dict]:
    from studio import sound
    from studio.shot import render_shot
    from studio.vlog import ROOT, _quality_no, ffmpeg_bin

    seq = [{**(lib.get(j[1]["path"]) or {}), **j[1]} for j in jobs]
    chapter_at = [float(c["atSec"]) for c in props["chapters"]]
    blocked = blocked_spans(props, total, end_at, title_at, title_sec, recap)
    subjects = []
    for o in props.get("overlays") or []:
        if o["kind"] == "subject":
            k = max([i for i, s in enumerate(starts) if s <= float(o["atSec"])] or [0])
            subjects.append((float(o["atSec"]), k))
    pool = [r for r in lib.values() if r.get("path") not in held and not r.get("junk") and not r.get("vetoed") and not _quality_no(r)]
    seed = int(hashlib.sha1(slug.encode()).hexdigest()[:6], 16)
    d = devices.plan(seq, starts, roles, chapter_at, blocked, look, pool, seed, overlap=L["fade"] > 0, subjects=subjects)
    for k, tin in enumerate(d["tins"]):
        props["shots"][k]["tin"] = tin
    rel = lambda p: Path(p).relative_to(ROOT / "public").as_posix()  # noqa: E731
    grade = L.get("grade") or ""
    lut_name, lut_strength = L.get("lut") or (None, 1.0)  # the same colour preset as the film
    ff = str(ffmpeg_bin())
    layers = []
    for l in d["layers"]:
        k = l.get("k")
        out = {"kind": l["kind"], "atSec": l["atSec"], "sec": l["sec"]}
        try:
            if l["kind"] == "leak":
                out["seed"] = l["seed"]
            elif l["kind"] == "snapshot":
                base = Path(done[k]["out"])
                still = dev_path(mezz, "snap", f"{base.name}{l['offset']}").with_suffix(".jpg")
                if not still.exists():
                    subprocess.run([ff, "-y", "-v", "error", "-ss", f"{l['offset']:.2f}", "-i", str(base), "-frames:v", "1",
                                    "-vf", "scale=1280:-2", "-q:v", "3", str(still)], check=True, timeout=120)
                out.update({"still": rel(still), "tilt": l["tilt"]})
            elif l["kind"] in ("split", "pip"):
                others = [lib.get(p) or {"path": p} for p in l["with"]]
                size = (768, 432) if l["kind"] == "pip" else ((1920 // (len(others) + 1)) // 2 * 2, 1080)
                base_at = float(done[k]["start"]) + (l["atSec"] - starts[k])
                srcs = []
                for r in others:
                    st = same_moment(seq[k], base_at, r, l["sec"])
                    dest = dev_path(mezz, l["kind"], f"{r['path']}{st:.2f}{l['sec']}{size}{look}{lut_name}{lut_strength}")
                    if not dest.exists():
                        render_shot(Path(r["path"]), st, l["sec"], dest, size, keep_audio=False, color=grade, natural=True, lut=lut_name, lut_strength=lut_strength)
                    srcs.append(rel(dest))
                out.update({"srcs": srcs, "base": props["shots"][k]["src"], "baseFrom": round(l["atSec"] - starts[k], 2)})
                if l["kind"] == "pip":
                    out["corner"] = l["corner"]
            elif l["kind"] == "prints":
                srcs = []
                for p in l["with"]:
                    r = lib.get(p) or {}
                    tall = float(r.get("height") or 0) > float(r.get("width") or 1)
                    size = (520, 700) if tall else (900, 600)
                    dest = dev_path(mezz, "print", f"{p}{l['sec']}{size}{look}{lut_name}{lut_strength}")
                    if not dest.exists():
                        render_shot(Path(p), 0.0, l["sec"], dest, size, keep_audio=False, color=grade, natural=True, lut=lut_name, lut_strength=lut_strength)
                    srcs.append(rel(dest))
                out.update({"srcs": srcs, "tilts": l["tilts"][: len(srcs)]})
        except Exception as exc:  # noqa: BLE001 - one device that cannot be made is left out; the film is whole without it
            print(f"device {l['kind']} at {l['atSec']} s left out: {exc}", flush=True)
            continue
        layers.append(out)
    props["layers"] = layers
    # The chapter's own sound under its photographs: its longest calm clip with sound (none turned down for wind), looped.
    amb = []
    for run in devices.ambience_runs(seq, starts, roles, chapter_at):
        lo = chapter_at[run["chapter"]] if run["chapter"] < len(chapter_at) else 0.0
        hi = chapter_at[run["chapter"] + 1] if run["chapter"] + 1 < len(chapter_at) else total
        cands = [k for k, (role, s) in enumerate(zip(roles, starts)) if role == "body" and lo <= s < hi and seq[k].get("kind") == "video"
                 and done[k]["volume"] and (done[k].get("clean") is None or (done[k]["clean"]["gain"] >= 1.0 and done[k]["clean"]["tag"] != "w1"))]
        if not cands:
            continue
        k = max(cands, key=lambda i: float(seq[i]["sec"]))
        src = Path(done[k]["out"])
        dest = dev_path(mezz, "amb", f"{src.name}{run['sec']}").with_suffix(".m4a")
        if not dest.exists():
            fade = min(1.2, run["sec"] / 4)
            subprocess.run([ff, "-y", "-v", "error", "-stream_loop", "-1", "-i", str(src), "-t", f"{run['sec']:.2f}", "-vn",
                            "-af", f"highpass=f=80,lowpass=f=9000,afade=t=in:d={fade:.2f},afade=t=out:st={run['sec'] - fade:.2f}:d={fade:.2f}",
                            "-c:a", "aac", "-b:a", "160k", str(dest)], check=True, timeout=180)
        amb.append({"src": rel(dest), "atSec": run["atSec"], "sec": run["sec"], "volume": AMBIENCE_GAIN})
    props["ambience"] = amb
    have = {p.stem.replace("synth_", ""): p for p in (sound.LIB / "sfx").glob("synth_*.wav")} if (sound.LIB / "sfx").exists() else {}
    if not {"tick", "paper", "swish", "whoosh_1"} <= set(have):
        sound.synth()
        have = {p.stem.replace("synth_", ""): p for p in (sound.LIB / "sfx").glob("synth_*.wav")}
    sfx = effects(d["whooshes"], layers, chapter_at, have)
    kinds: dict = {}
    for l in layers:
        kinds[l["kind"]] = kinds.get(l["kind"], 0) + 1
    joins: dict = {}
    for t in d["tins"]:
        joins[t] = joins.get(t, 0) + 1
    print(f"devices: layers {kinds or 'none'}; joins {joins}; ambience under {len(amb)} photo runs; {len(sfx)} effects", flush=True)
    return sfx
