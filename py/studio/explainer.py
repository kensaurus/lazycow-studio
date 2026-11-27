"""
FILE: py/studio/explainer.py
PURPOSE: Explainers as a video type: a script of scenes (facts, drawn graphics, a few library pictures) rendered with the
         Explainer-9x16 composition (src/Explainer.tsx) and handed to the SAME pipeline as every reel: one project per
         explainer (projects/<slug>.json with kind "explainer"), its render in renders/story-<slug>/ (manifest, hook.jpg,
         <slug>_9x16.mp4), a drafts row that a person approves, the network folders posting reads, the daily plan, perf.
OVERVIEW: check(script) -> errors and warnings in plain words (unknown kind, a field missing, a library id that is not
          there, a clip past the end of its file, text too long for its place on the page, the fact guard, and in the
          ranch workspace the campsite rule: nothing may suggest staying or sleeping indoors). parse_lib("lib:123@4+6")
          reads a library reference. stage(script, slug) cuts every picture from the library into
          public/explainer/<slug>/ (1080x1920 full, 1440x1080 card, 1440x648 pair), people-free check as a warning
          (person >= 0.05 or a face). draft(script) saves the script (<data>/explainers/scripts) and the project;
          add(folder) does that for every *.json in a folder. build(slug) renders, normalises to -14 LUFS, packages one
          folder per network (9:16 for each), writes the manifest and the drafts row ("rendered": a person approves).
          sheet(script) renders one still with every scene's settled frame (Explainer-Sheet), the preview before a render.
DEPENDENCIES: studio.reels (CHANNELS, DRAFTS, file_prefix, covers, verify), studio.sound (choose_music CC0/PDM, synth,
              credits), studio.remotion, studio.guard, studio.projects, studio.db, ffmpeg, Pillow
USAGE: python -m studio explainer check FILE... | add PATH [--render] [--queue URL] | build SLUG | sheet FILE|SLUG | list
NOTES: The script format is docs/user-guide.md "Explainers" and SCENES below; a scene kind added to src/Explainer.tsx is
       added here too (test_explainer.py checks both lists agree). Only approved explainers are posted, as every reel
       (publish.assert_approved reads the same drafts row); nothing here approves.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from studio.config import DATA, RANCH, RANCH_BRAND, ROOT, ffmpeg_bin

KIND = "explainer"
SCRIPTS = DATA / "explainers" / "scripts"
SHEETS = DATA / "explainers" / "sheets"
PUBLIC = ROOT / "public" / "explainer"
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")
LIB = re.compile(r"^lib:(\d+)(?:@(\d+(?:\.\d+)?)\+(\d+(?:\.\d+)?))?$")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
FPS = 30
SECONDS = (15, 60)  # the whole film: long enough to explain, short enough for Shorts and Reels
SCENE_SEC = (2.0, 10.0)
PERSON_MAX = 0.05  # the library's person score at or over this, or any face: said as a warning, never a block
# Picture sizes the composition shows each field at (cover and end fill the screen; a card is 4:3; a pair photo 2.2:1).
SHAPES = {"full": (1080, 1920), "card": (1440, 1080), "pair": (1440, 648)}
ICONS = ("tent", "car", "kotatsu", "laptop", "wifi", "shower", "fire", "star", "snowflake", "mountain", "mug", "sun", "moon",
         "toilet", "dumbbell", "parking")
MASCOT = (True, False, "tl", "tr", "bl", "br")

# Every scene kind: its required fields, its list (name, fewest, most) and where its words sit on the page.
# room = (em per written line, most lines) for the headline at its smallest size (src/Explainer.tsx fitSize: 72 %).
SCENES: dict[str, dict] = {
    "cover": {"need": ("src",), "media": {"src": "full"}, "room": (13.3, 3)},
    "number": {"need": ("value",), "room": (15.6, 2)},
    "tally": {"need": ("count",), "room": (15.6, 2)},
    "checklist": {"need": ("items",), "list": ("items", 1, 4), "room": (17.3, 2)},
    "nogo": {"need": ("items",), "list": ("items", 1, 4), "room": (17.3, 2)},
    "card": {"need": ("src",), "media": {"src": "card"}, "room": (17.3, 2)},
    "route": {"need": ("from", "to"), "room": (17.3, 2)},
    "pair": {"need": ("left", "right"), "room": (17.3, 2)},
    "thermo": {"need": ("value",), "room": (17.3, 2)},
    "compare": {"need": ("left", "right"), "room": (17.3, 2)},
    "clock": {"need": ("hours",), "list": ("hours", 3, 6), "room": (17.3, 2)},
    "bars": {"need": ("bars",), "list": ("bars", 2, 5), "room": (17.3, 2)},
    "icons": {"need": ("items",), "list": ("items", 3, 6), "room": (17.3, 2)},
    "steps": {"need": ("steps",), "list": ("steps", 2, 4), "room": (17.3, 2)},
    "quote": {"need": (), "room": (13.4, 4)},
    "end": {"need": ("src",), "media": {"src": "full"}, "room": (16.0, 2)},
}
# Networks an explainer goes to: every network that takes a 9:16 file, and Bluesky (it shows vertical video too).
VERTICAL_TOO = ("bluesky",)
NOT_FOR = ("xiaohongshu", "gbp", "linkedin", "kensaurus", "zenn", "note")  # need words or shapes an explainer has not got


# ---------- reading a script ----------
def text_em(s: str) -> float:
    """Width of one written line in em: full-width (Japanese) 1, a space 0.3, anything else 0.56 (src/Explainer.tsx textEm)."""
    out = 0.0
    for c in str(s or "").replace("*", ""):
        o = ord(c)
        out += 1.0 if (0x3000 <= o <= 0x9FFF or 0xFF00 <= o <= 0xFFEF) else 0.3 if c == " " else 0.56
    return out


def parse_lib(ref) -> dict | None:
    """'lib:1246' -> {id: 1246}; 'lib:752@2+8' -> {id: 752, start: 2.0, len: 8.0}; anything else -> None."""
    m = LIB.match(str(ref or "").strip())
    if not m:
        return None
    out = {"id": int(m.group(1))}
    if m.group(2) is not None:
        out.update(start=float(m.group(2)), len=float(m.group(3)))
    return out


def _words(x) -> bool:
    return isinstance(x, dict) and isinstance(x.get("ja"), str) and bool(x["ja"].strip()) and isinstance(x.get("en", ""), str)


def _media_fields(scene: dict) -> list[tuple[str, str, str]]:
    """(label, ref, shape) for every picture a scene asks for."""
    out = [(k, scene.get(k), shape) for k, shape in (SCENES.get(scene.get("kind"), {}).get("media") or {}).items()]
    if scene.get("kind") == "pair":
        for side in ("left", "right"):
            if isinstance(scene.get(side), dict) and scene[side].get("src"):
                out.append((f"{side}.src", scene[side]["src"], "pair"))
    return out


def lib_rows(ids) -> dict[int, dict]:
    """The library rows for these ids: path, kind, duration, person score, faces. Read only."""
    ids = sorted({int(i) for i in ids})
    if not ids:
        return {}
    from studio.db import connect

    out: dict[int, dict] = {}
    with connect() as con:
        have_lib = bool(con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='library'").fetchone())
        q = ("SELECT a.id, a.path, a.kind, a.duration, a.width, a.height" + (", l.person, l.faces FROM assets a LEFT JOIN library l ON l.asset_id = a.id"
             if have_lib else ", NULL AS person, NULL AS faces FROM assets a") + f" WHERE a.id IN ({','.join('?' * len(ids))})")
        for r in con.execute(q, ids):
            out[int(r["id"])] = dict(r)
    return out


def _indoor_words() -> list[str]:
    """The campsite rule (ranch workspace only): words that would say people stay or sleep indoors. The ranch is a campsite
    with a kotatsu coworking lounge, not lodging: people sleep in their own tent or car; the lounge is for warming up and
    working. The list lives in the ranch overlay (shared/ranch/brand.json noIndoorStay)."""
    return [str(w) for w in (RANCH_BRAND.get("noIndoorStay") or []) if str(w).strip()] if RANCH else []


def _texts(script: dict) -> list[tuple[str, str]]:
    """(where, text) for every word the explainer shows or posts."""
    out = [(k, script[k]) for k in ("title", "yt", "ig", "bsky", "x") if isinstance(script.get(k), str)]
    for i, s in enumerate(script.get("scenes") or []):
        if not isinstance(s, dict):
            continue
        at = f"scene {i + 1} ({s.get('kind')})"

        def add(where, v):
            if isinstance(v, str):
                out.append((f"{at} {where}", v))
            elif isinstance(v, dict):
                for k in ("ja", "en", "value", "at"):
                    if isinstance(v.get(k), str):
                        out.append((f"{at} {where}.{k}", v[k]))
                if isinstance(v.get("label"), dict):
                    add(f"{where}.label", v["label"])
        for k in ("ja", "en", "kicker", "big", "source", "note", "via", "by", "unit"):
            add(k, s.get(k))
        for k in ("label", "from", "to", "left", "right", "compare"):
            if isinstance(s.get(k), dict):
                add(k, s[k])
        for k in ("items", "hours", "bars", "steps"):
            for j, it in enumerate(s.get(k) or []):
                add(f"{k}[{j + 1}]", it)
        for j, line in enumerate(s.get("lines") or []):
            add(f"lines[{j + 1}]", line)
    return out


def _room(where: str, text: str, per_line: float, lines: int, errors: list[str]) -> None:
    """Too long for its place: more written lines than fit, or one line wider than the page at the smallest size."""
    rows = str(text or "").split("\n")
    if len(rows) > lines:
        errors.append(f"{where}: {len(rows)} lines, at most {lines} fit here (split the idea, or shorten it)")
    for row in rows:
        if text_em(row) > per_line + 1e-6:
            errors.append(f"{where}: 「{row.replace('*', '')}」 is too long for one line here (about {text_em(row):.0f} of {per_line:.0f} wide); "
                          "break it with \\n or say it shorter")


def check(script, lib: dict[int, dict] | None = None, music_ids: set[str] | None = None) -> dict:
    """Everything wrong with a script before anything renders. {ok, errors: [str], warnings: [str], seconds, slug, scenes,
    media: [{scene, field, id, shape, kind, start, len}]}. lib: library rows by id (read from the catalog when None);
    music_ids: the audio library's music ids (read when None and the script names one)."""
    from studio.guard import problems

    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(script, dict):
        return {"ok": False, "errors": ["the script is not a JSON object ({ ... })"], "warnings": [], "seconds": 0, "slug": None, "scenes": 0, "media": []}
    slug = str(script.get("slug") or "")
    if not SLUG.match(slug):
        errors.append('slug: lowercase letters, digits and dashes, starting with a letter or digit (e.g. "winter-cold-101")')
    for k in ("title", "yt", "ig"):
        if not (isinstance(script.get(k), str) and script[k].strip()):
            errors.append(f'{k}: missing ({ {"title": "the video title on YouTube", "yt": "the YouTube description", "ig": "the Instagram and Facebook caption"}[k]})')
    if isinstance(script.get("title"), str) and len(script["title"]) > 100:
        errors.append(f"title: {len(script['title'])} characters; YouTube takes at most 100")
    if script.get("accent") is not None and not HEX.match(str(script["accent"])):
        errors.append('accent: a colour like "#c8321f"')
    tags = script.get("tags", [])
    if not isinstance(tags, list) or not all(isinstance(t, str) and t.strip() for t in tags):
        errors.append('tags: a list of words, e.g. ["冬キャンプ", "群馬"]')
    music = script.get("music", "auto")
    if not (music in ("auto", "off") or (isinstance(music, dict) and isinstance(music.get("id"), str))):
        errors.append('music: "auto" (a CC0 or public-domain track from the audio library), "off", or {"id": "<file name in the audio library>"}')
    elif isinstance(music, dict):
        if music_ids is None:
            from studio.sound import library

            music_ids = {t["id"] for t in library() if t["kind"] == "music" and t.get("license") in ("CC0", "PDM")}
        if music["id"] not in music_ids:
            errors.append(f"music: {music['id']} is not a CC0 or public-domain track in the audio library (Reels › Audio lists them)")
    if isinstance(script.get("yt"), str) and re.search(r"(^|\s)#\S", script["yt"]):
        warnings.append("yt: hashtags go in tags; the studio adds them under the description (here they would show twice)")
    scenes = script.get("scenes")
    media: list[dict] = []
    total = 0.0
    if not isinstance(scenes, list) or not scenes:
        errors.append("scenes: a list of scenes, from a cover to an end")
        scenes = []
    elif not 3 <= len(scenes) <= 12:
        errors.append(f"scenes: {len(scenes)}; an explainer has 3 to 12")
    for i, s in enumerate(scenes):
        at = f"scene {i + 1}"
        if not isinstance(s, dict):
            errors.append(f"{at}: not an object")
            continue
        kind = s.get("kind")
        spec = SCENES.get(kind)
        at = f"scene {i + 1} ({kind})"
        if not spec:
            errors.append(f"{at}: unknown kind; one of {', '.join(SCENES)}")
            continue
        sec = s.get("sec")
        if not isinstance(sec, (int, float)) or isinstance(sec, bool) or not SCENE_SEC[0] <= sec <= SCENE_SEC[1]:
            errors.append(f"{at}: sec must be a number of seconds, {SCENE_SEC[0]:g} to {SCENE_SEC[1]:g}")
        else:
            total += float(sec)
            if sec > 7:
                warnings.append(f"{at}: {sec:g} s is long for one idea; viewers swipe on at about 6 s")
        if not (isinstance(s.get("ja"), str) and s["ja"].strip()):
            errors.append(f"{at}: ja (the Japanese words on screen) is missing")
        if s.get("en") is not None and not isinstance(s.get("en"), str):
            errors.append(f"{at}: en must be text")
        for f in spec["need"]:
            if s.get(f) in (None, "", []):
                errors.append(f"{at}: {f} is missing")
        if "list" in spec:
            name, lo, hi = spec["list"]
            got = s.get(name)
            if isinstance(got, list) and not lo <= len(got) <= hi:
                errors.append(f"{at}: {name} has {len(got)}; {lo} to {hi} fit")
        if i == 0 and kind != "cover":
            warnings.append(f"{at}: the first scene is usually the cover (its frame is what the feed shows)")
        if i == len(scenes) - 1 and kind != "end":
            warnings.append(f"{at}: the last scene is usually the end card")
        per, lines = spec["room"]
        _room(f"{at} ja", s.get("ja") or "", per, lines, errors)
        if isinstance(s.get("en"), str) and len(s["en"]) > 110:
            errors.append(f"{at} en: {len(s['en'])} characters; about 100 fit under the Japanese")
        if isinstance(s.get("kicker"), str) and len(s["kicker"]) > 44:
            warnings.append(f"{at} kicker: {len(s['kicker'])} characters; the end is cut off past about 42")
        if isinstance(s.get("source"), str) and text_em(s["source"]) > (60 if kind != "cover" else 54):
            errors.append(f"{at} source: too long for its two lines; keep the source short (who measured it, when)")
        if s.get("mascot") is not None and (kind not in ("cover", "end") or s["mascot"] not in MASCOT):
            errors.append(f'{at}: mascot is for the cover or end, true or a corner "tl", "tr", "bl", "br"')
        _check_kind(at, kind, s, errors, warnings)
        for field, ref, shape in _media_fields(s):
            got = parse_lib(ref)
            if not got:
                errors.append(f'{at} {field}: pictures come from the library: "lib:<id>" for a photo, "lib:<id>@<start>+<seconds>" for a clip (got {json.dumps(ref, ensure_ascii=False)[:60]})')
                continue
            media.append({"scene": i, "field": field, "shape": shape, "sec": float(sec) if isinstance(sec, (int, float)) else 0.0, **got})
    if scenes and not SECONDS[0] <= total <= SECONDS[1]:
        errors.append(f"length {total:g} s; an explainer runs {SECONDS[0]} to {SECONDS[1]} s")
    for where, text in _texts(script):
        if text.count("*") % 2:
            errors.append(f"{where}: an odd number of * (each *marked* part needs one on both sides)")
        for p in problems(text):
            errors.append(f"{where}: the fact guard refuses it ({p.replace('banned:', 'a banned word: ')})")
        low = text.lower()
        for w in _indoor_words():
            if w.lower() in low:
                errors.append(f"{where}: 「{w}」 says people stay indoors; the lounge is for warming up and working, people sleep in their own tent or car")
    if media:
        rows = lib if lib is not None else lib_rows(m["id"] for m in media)
        for m in media:
            at = f"scene {m['scene'] + 1} {m['field']}"
            row = rows.get(m["id"])
            if not row:
                errors.append(f"{at}: library id {m['id']} is not in the library (Footage › Library shows each clip's id)")
                continue
            m["kind"] = row.get("kind")
            if row.get("kind") == "photo" and "start" in m:
                errors.append(f"{at}: {m['id']} is a photo; write lib:{m['id']} without @start+seconds")
            if row.get("kind") == "video":
                dur = float(row.get("duration") or 0)
                start, length = m.get("start", 0.0), m.get("len", min(dur, m["sec"] + 1))
                m["start"], m["len"] = start, length
                if dur and start + length > dur + 0.05:
                    errors.append(f"{at}: {start:g}+{length:g} s runs past the end of the clip ({dur:.1f} s)")
                if length < m["sec"]:
                    warnings.append(f"{at}: the clip is {length:g} s for a {m['sec']:g} s scene; its last frame is held")
            if (row.get("person") or 0) >= PERSON_MAX or (row.get("faces") or 0) > 0:
                warnings.append(f"{at}: library id {m['id']} may show people (person {float(row.get('person') or 0):.2f}, faces {int(row.get('faces') or 0)}); "
                                "check the frame before approving")
            if row.get("path") and not Path(row["path"]).exists():
                errors.append(f"{at}: the file for library id {m['id']} cannot be read now (is its drive connected?)")
    return {"ok": not errors, "errors": errors, "warnings": warnings, "seconds": round(total, 2), "slug": slug or None,
            "scenes": len(scenes), "media": media}


def _check_kind(at: str, kind: str, s: dict, errors: list[str], warnings: list[str]) -> None:
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)  # noqa: E731
    if kind == "number" and not num(s.get("value")):
        errors.append(f"{at}: value must be a number")
    if kind == "tally" and not (isinstance(s.get("count"), int) and 1 <= s["count"] <= 45):
        errors.append(f"{at}: count must be a whole number, 1 to 45")
    if kind in ("checklist", "nogo"):
        for j, it in enumerate(s.get("items") or []):
            if not _words(it):
                errors.append(f"{at} items[{j + 1}]: needs ja (and en)")
            else:
                _room(f"{at} items[{j + 1}]", it["ja"], 18.0, 1, errors)
    if kind == "card" and s.get("label") is not None:
        if not _words(s["label"]):
            errors.append(f"{at} label: needs ja (and en)")
        else:
            _room(f"{at} label", s["label"]["ja"], 23.0, 2, errors)
    if kind == "route":
        for k in ("from", "to"):
            if s.get(k) is not None and not _words(s[k]):
                errors.append(f"{at} {k}: needs ja (and en)")
            elif _words(s.get(k)):
                _room(f"{at} {k}", s[k]["ja"], 9.0 if k == "from" else 14.0, 1, errors)
    if kind == "pair":
        for k in ("left", "right"):
            v = s.get(k)
            if v is None:
                continue
            if not _words(v):
                errors.append(f"{at} {k}: needs ja (and en)")
                continue
            if not v.get("src") and v.get("icon") not in ICONS:
                errors.append(f"{at} {k}: a photo (src) or a drawn icon, one of {', '.join(ICONS)}")
            _room(f"{at} {k}", v["ja"], 22.0, 1, errors)
        if isinstance(s.get("left"), dict) and isinstance(s.get("right"), dict) and bool(s["left"].get("src")) != bool(s["right"].get("src")):
            errors.append(f"{at}: both sides a photo, or both a drawn icon")
    if kind == "thermo":
        if not num(s.get("value")):
            errors.append(f"{at}: value must be a number (degrees)")
        c = s.get("compare")
        if c is not None and not (isinstance(c, dict) and num(c.get("value"))):
            errors.append(f"{at} compare: {{\"value\": <number>, \"label\": {{\"ja\", \"en\"}}}}")
        for k, v in (("label", s.get("label")), ("compare.label", (c or {}).get("label") if isinstance(c, dict) else None)):
            if v is not None:
                if not _words(v):
                    errors.append(f"{at} {k}: needs ja (and en)")
                else:
                    _room(f"{at} {k}", v["ja"], 12.0 if c else 26.0, 2, errors)
        for k in ("min", "max"):
            if s.get(k) is not None and not num(s[k]):
                errors.append(f"{at}: {k} must be a number")
        if num(s.get("min")) and num(s.get("max")) and s["min"] >= s["max"]:
            errors.append(f"{at}: min must be under max")
    if kind == "compare":
        for k in ("left", "right"):
            v = s.get(k)
            if v is None:
                continue
            if not (_words(v) and isinstance(v.get("value"), str) and v["value"].strip()):
                errors.append(f'{at} {k}: {{"value": "1,444 m", "ja": ..., "en": ...}}')
                continue
            if text_em(v["value"]) > 7.5:
                errors.append(f"{at} {k}.value: 「{v['value']}」 is too wide to read big; at most about 7 characters")
            _room(f"{at} {k}", v["ja"], 12.5, 2, errors)
    if kind == "clock":
        prev = None
        for j, h in enumerate(s.get("hours") or []):
            if not (_words(h) and isinstance(h.get("at"), str) and re.match(r"^([01]?\d|2[0-3]):[0-5]\d$", h["at"])):
                errors.append(f'{at} hours[{j + 1}]: {{"at": "07:00", "ja": ..., "en": ...}}')
                continue
            _room(f"{at} hours[{j + 1}]", h["ja"], 13.0, 1, errors)
            if isinstance(h.get("en"), str) and len(h["en"]) > 30:
                warnings.append(f"{at} hours[{j + 1}] en: {len(h['en'])} characters; the end may be cut off past about 30")
            mins = int(h["at"].split(":")[0]) * 60 + int(h["at"].split(":")[1])
            if prev is not None and mins <= prev:
                warnings.append(f"{at} hours[{j + 1}]: {h['at']} is not after the hour before; the hand goes round to it")
            prev = mins
    if kind == "bars":
        bars = s.get("bars") or []
        room = {2: 13.0, 3: 10.0, 4: 8.4, 5: 7.2}.get(len(bars), 7.2)
        for j, b in enumerate(bars):
            if not (_words(b) and num(b.get("value"))):
                errors.append(f'{at} bars[{j + 1}]: {{"value": 12, "ja": ..., "en": ...}}')
                continue
            if b["value"] < 0:
                errors.append(f"{at} bars[{j + 1}]: bars grow up from zero; a temperature below zero is a thermo scene")
            _room(f"{at} bars[{j + 1}]", b["ja"], room, 2, errors)
        if bars and all(_words(b) and num(b.get("value")) for b in bars) and max(b["value"] for b in bars) <= 0:
            errors.append(f"{at}: at least one bar must be above zero")
    if kind == "icons":
        items = s.get("items") or []
        room = 15.0 if len(items) == 4 else 9.8
        for j, it in enumerate(items):
            if not _words(it) or it.get("icon") not in ICONS:
                errors.append(f"{at} items[{j + 1}]: {{\"icon\": one of {', '.join(ICONS)}, \"ja\": ..., \"en\": ...}}")
                continue
            _room(f"{at} items[{j + 1}]", it["ja"], room, 2, errors)
    if kind == "steps":
        for j, st in enumerate(s.get("steps") or []):
            if not _words(st):
                errors.append(f"{at} steps[{j + 1}]: needs ja (and en)")
            else:
                _room(f"{at} steps[{j + 1}]", st["ja"], 19.0, 2, errors)
    if kind == "quote" and isinstance(s.get("by"), str) and len(s["by"]) > 40:
        errors.append(f"{at} by: {len(s['by'])} characters; keep the attribution under 40")
    if kind == "end":
        lines = s.get("lines")
        if lines is not None and not (isinstance(lines, list) and all(isinstance(x, str) for x in lines)):
            errors.append(f"{at} lines: a list of short lines")
        elif isinstance(lines, list):
            if len(lines) > 3:
                errors.append(f"{at} lines: {len(lines)}; at most 3 fit under the words")
            for j, line in enumerate(lines):
                _room(f"{at} lines[{j + 1}]", line, 30.0, 1, errors)


def beats_of(script: dict) -> list[dict]:
    """The explainer's words as reel beats (the overview's headline, word repeats, the Review card's words)."""
    out, t = [], 0.0
    scenes = [s for s in script.get("scenes") or [] if isinstance(s, dict)]
    for i, s in enumerate(scenes):
        sec = float(s.get("sec") or 0)
        kind = "hook" if i == 0 else "end" if i == len(scenes) - 1 and s.get("kind") == "end" else "line"
        ja = str(s.get("ja") or "").replace("*", "")
        if ja:
            out.append({"kind": kind, "ja": ja, "en": str(s.get("en") or ""), "startSec": round(t, 2), "endSec": round(t + sec, 2)})
        t += sec
    return out


def seconds_of(script: dict) -> float:
    return round(sum(float(s.get("sec") or 0) for s in script.get("scenes") or [] if isinstance(s, dict)), 2)


def _tags(script: dict) -> list[str]:
    return [t if t.startswith("#") else f"#{t}" for t in dict.fromkeys(str(x).strip() for x in script.get("tags") or [] if str(x).strip())]


# ---------- drafts ----------
def project_of(script: dict) -> dict:
    """The reel record an explainer rides the pipeline as (projects/<slug>.json)."""
    from studio.projects import load

    old = load(script["slug"]) or {}
    return {
        "slug": script["slug"], "kind": KIND, "theme": KIND, "title_ja": script["title"], "yt_title": script["title"],
        "shots": [], "beats": beats_of(script), "tags": _tags(script), "music": script.get("music", "auto"),
        "posts": {"ja": script["ig"], "en": "", "x": script.get("x") or script["title"]},
        "explainer": script, "made": old.get("made") or {"by": "explainer", "at": datetime.now().astimezone().isoformat(timespec="seconds")},
    }


def is_explainer(reel: dict | None) -> bool:
    return bool(reel) and reel.get("kind") == KIND


def draft(script, *, lib: dict | None = None) -> dict:
    """Check a script; when it passes, keep it in the script library and save its project (a draft: not rendered, not
    approved). {slug, ok, errors, warnings, seconds, saved}."""
    from studio.projects import load, save

    res = check(script, lib=lib)
    out = {"slug": res["slug"], "ok": res["ok"], "errors": res["errors"], "warnings": res["warnings"], "seconds": res["seconds"], "saved": False}
    if not res["ok"]:
        return out
    old = load(script["slug"])
    if old and not is_explainer(old):
        out.update(ok=False, errors=[f"slug {script['slug']} is a reel already; give the explainer its own slug"])
        return out
    SCRIPTS.mkdir(parents=True, exist_ok=True)
    (SCRIPTS / f"{script['slug']}.json").write_text(json.dumps(script, ensure_ascii=False, indent=1), encoding="utf-8")
    save(project_of(script))
    out["saved"] = True
    return out


def read_script(path: Path) -> tuple[dict | None, str | None]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig")), None
    except (OSError, UnicodeDecodeError) as err:
        return None, f"cannot read {Path(path).name}: {err}"
    except json.JSONDecodeError as err:
        return None, f"{Path(path).name} is not valid JSON: line {err.lineno}, column {err.colno}: {err.msg}"


def add(path) -> dict:
    """Every *.json script in a folder (or one file) becomes a draft. {made: [slug], failed: [{file, slug, errors}],
    warnings: {slug: [str]}}. Nothing renders here: the caller queues the renders (one at a time)."""
    p = Path(path)
    files = sorted(p.glob("*.json")) if p.is_dir() else [p] if p.is_file() and p.suffix.lower() == ".json" else []
    if not files:
        raise FileNotFoundError(f"no .json scripts in {p}")
    scripts = []
    for f in files:
        data, err = read_script(f)
        scripts.append((f, data, err))
    ids = [m["id"] for _, d, _ in scripts if isinstance(d, dict) for s in d.get("scenes") or [] if isinstance(s, dict)
           for _, ref, _ in _media_fields(s) if (m := parse_lib(ref))]
    lib = lib_rows(ids)
    made, failed, warn = [], [], {}
    seen = set()
    for f, data, err in scripts:
        if err:
            failed.append({"file": f.name, "slug": None, "errors": [err]})
            continue
        if isinstance(data, dict) and data.get("slug") in seen:
            failed.append({"file": f.name, "slug": data.get("slug"), "errors": [f"slug {data.get('slug')} is used by another script in this folder"]})
            continue
        r = draft(data, lib=lib)
        if r["ok"]:
            made.append(r["slug"])
            seen.add(r["slug"])
            if r["warnings"]:
                warn[r["slug"]] = r["warnings"]
        else:
            failed.append({"file": f.name, "slug": r["slug"], "errors": r["errors"]})
    return {"made": made, "failed": failed, "warnings": warn}


def scripts() -> list[dict]:
    """The script library for the console's Explainer picker: each script's slug, title, length, scene kinds, and whether
    it is made (a project) and its review status."""
    from studio.projects import load
    from studio.publish import review_status

    out = []
    for f in sorted(SCRIPTS.glob("*.json")) if SCRIPTS.exists() else []:
        data, err = read_script(f)
        if err or not isinstance(data, dict):
            out.append({"slug": f.stem, "file": f.name, "error": err or "not a script"})
            continue
        proj = load(str(data.get("slug") or f.stem))
        out.append({"slug": data.get("slug") or f.stem, "file": f.name, "title": data.get("title", ""), "seconds": seconds_of(data),
                    "kinds": [s.get("kind") for s in data.get("scenes") or [] if isinstance(s, dict)],
                    "made": is_explainer(proj), "status": review_status(data.get("slug") or f.stem) if is_explainer(proj) else None,
                    "rendered": (DATA / "renders" / f"story-{data.get('slug') or f.stem}" / "manifest.json").exists()})
    return out


def script_of(slug: str) -> dict | None:
    from studio.projects import load

    proj = load(slug)
    if is_explainer(proj):
        return proj["explainer"]
    f = SCRIPTS / f"{slug}.json"
    return read_script(f)[0] if f.exists() else None


# ---------- staging the pictures and the sound ----------
def _vf(shape: str) -> str:
    w, h = SHAPES[shape]
    return f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"


def _cut(row: dict, m: dict, dest_dir: Path) -> str:
    """One picture, cut once (named by what it is, so a second render reuses it). Returns its name in dest_dir."""
    src = Path(row["path"])
    w, h = SHAPES[m["shape"]]
    if row.get("kind") == "photo":
        name = f"{m['id']}-{m['shape']}.jpg"
        dest = dest_dir / name
        if not dest.exists():
            from PIL import ImageOps

            from studio.shot import open_photo

            ImageOps.fit(open_photo(src), (w, h)).convert("RGB").save(dest, "JPEG", quality=90)
        return name
    start, length = float(m.get("start", 0)), float(m.get("len") or m["sec"] + 1)
    hold = max(0.0, m["sec"] + 0.5 - length)
    name = f"{m['id']}-{start:g}-{length:g}-{m['shape']}{'-h' if hold else ''}.mp4"
    dest = dest_dir / name
    if not dest.exists():
        vf = _vf(m["shape"]) + f",fps={FPS},format=yuv420p" + (f",tpad=stop_mode=clone:stop_duration={hold:.2f}" if hold else "")
        tmp = dest.with_suffix(".part.mp4")
        r = subprocess.run([str(ffmpeg_bin()), "-v", "error", "-y", "-ss", f"{start:g}", "-i", str(src), "-t", f"{length:g}", "-an", "-vf", vf,
                            "-c:v", "libx264", "-preset", "fast", "-crf", "20", str(tmp)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        if r.returncode != 0 or not tmp.exists():
            raise RuntimeError(f"could not cut library id {m['id']}: {(r.stderr or '').strip()[-300:]}")
        tmp.replace(dest)
    return name


def _pencil() -> Path:
    """A soft pencil scratch for paper scenes, made here with ffmpeg (no third-party rights), kept in the audio folder."""
    from studio.sound import LIB

    out = LIB / "sfx" / "synth_pencil.wav"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(ffmpeg_bin()), "-v", "error", "-y", "-f", "lavfi", "-i",
                        "anoisesrc=d=0.9:c=white:a=0.45,highpass=f=2200,lowpass=f=8000,tremolo=f=13:d=0.85,afade=t=in:d=0.05,afade=t=out:st=0.55:d=0.35",
                        "-ar", "48000", "-ac", "2", str(out)], check=True, capture_output=True, timeout=60)
    return out


def _whoosh() -> Path:
    from studio.sound import LIB, synth

    out = LIB / "sfx" / "synth_whoosh_2.wav"
    if not out.exists():
        synth()
    return out


def stage(script: dict, slug: str | None = None, lib: dict | None = None, sound: bool = True) -> tuple[dict, dict]:
    """Remotion props for a checked script: every lib: picture cut into public/explainer/<slug>/, music (CC0/PDM only),
    the whoosh and the pencil copied beside them. Returns (props, audio) where audio is what credits.txt says."""
    from studio.sound import choose_music

    slug = slug or script["slug"]
    res = check(script, lib=lib)
    if not res["ok"]:
        raise ValueError("the script does not pass its checks: " + "; ".join(res["errors"][:5]))
    folder = PUBLIC / slug
    folder.mkdir(parents=True, exist_ok=True)
    rows = lib if lib is not None else lib_rows(m["id"] for m in res["media"])
    scenes = json.loads(json.dumps(script["scenes"]))
    for k, m in enumerate(res["media"]):
        print(f"PROGRESS {k}/{len(res['media'])} cutting library id {m['id']}", flush=True)
        name = f"explainer/{slug}/{_cut(rows[m['id']], m, folder)}"
        sc = scenes[m["scene"]]
        if m["field"] == "src":
            sc["src"] = name
        else:
            sc[m["field"].split(".")[0]]["src"] = name
    for sc in scenes:
        if sc.get("kind") == "pair":
            for side in ("left", "right"):
                sc[side].setdefault("icon", "tent" if side == "left" else "kotatsu")
    props = {"scenes": scenes, "accent": script.get("accent") or "#c8321f", "snow": bool(script.get("snow"))}
    audio: dict = {}
    if sound:
        track = choose_music({"slug": slug, "theme": KIND, "music": script.get("music", "auto")}, res["seconds"])
        if track:
            ext = Path(track["file"]).suffix.lower()
            dest = folder / f"music{ext}"
            if not dest.exists() or dest.stat().st_size != Path(track["file"]).stat().st_size:
                shutil.copy2(track["file"], dest)
            vol = script["music"].get("volume") if isinstance(script.get("music"), dict) else None
            props["music"] = {"src": f"explainer/{slug}/music{ext}", "volume": float(vol if vol is not None else 0.6), "start": float(track.get("start") or 0)}
            audio["music"] = track
        for name, src in (("whoosh", _whoosh()), ("pencil", _pencil())):
            dest = folder / f"{name}.wav"
            if not dest.exists():
                shutil.copy2(src, dest)
            props[name] = f"explainer/{slug}/{name}.wav"
        audio["sfx"] = [{"name": "whoosh"}, {"name": "pencil"}]
    return props, audio


# ---------- render, package, review row ----------
def _remotion_still(composition: str, props: Path, out: Path) -> bool:
    from studio.remotion import render_cmd

    cmd = render_cmd(composition, props, out)
    cmd[2] = "still"  # npx remotion still src/index.ts <id> <out> --props --public-dir
    log = out.with_suffix(".log")
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    log.write_text((r.stdout or "") + (r.stderr or ""), encoding="utf-8")
    return r.returncode == 0 and out.exists()


def sheet(script: dict, out: Path | None = None) -> Path:
    """The preview: one still with every scene's settled frame (Explainer-Sheet). Cuts the pictures it needs first."""
    props, _ = stage(script, sound=False)
    SHEETS.mkdir(parents=True, exist_ok=True)
    out = out or SHEETS / f"{script['slug']}.jpg"
    pj = SHEETS / f"{script['slug']}.props.json"
    pj.write_text(json.dumps(props, ensure_ascii=False), encoding="utf-8")
    print("STAGE 2/2 drawing every scene once", flush=True)
    if not _remotion_still("Explainer-Sheet", pj, out):
        raise RuntimeError(f"the preview did not render; see {out.with_suffix('.log')}")
    return out


def wants(spec: dict, seconds: float) -> bool:
    """Does this network get an explainer? Every switched-on network that takes a 9:16 file (or vertical video), within
    its length limit."""
    if spec.get("off") or spec.get("manual") or spec.get("stillsOnly") or spec["id"] in NOT_FOR:
        return False
    if spec.get("maxSec") and seconds > spec["maxSec"]:
        return False
    return any(f["aspect"] == "9x16" for f in spec.get("files", [])) or spec["id"] in VERTICAL_TOO


def _link(channel: str) -> str:
    from studio.brand import brand

    b = brand()
    return f"{b['link']}{'&' if '?' in b['link'] else '?'}utm_source={channel}&utm_medium=social&utm_campaign=explainer" if b.get("link") else ""


def post_text(reel: dict, channel: str) -> str:
    """Each network's text from the script: the title and the YouTube description for Shorts, the caption for Instagram,
    Facebook, TikTok and Threads, a short line with the link for Bluesky and X."""
    from studio.reels import _fit, x_length

    sc = reel["explainer"]
    tags = reel.get("tags") or []
    ig = sc["ig"].strip()
    cap = ig if "#" in ig else "\n\n".join(p for p in (ig, " ".join(tags[:5])) if p)
    link = _link(channel)
    if channel == "youtube-shorts":
        return f"TITLE: {sc['title']}\n\nDESCRIPTION:\n{sc['yt'].strip()}\n"
    if channel == "threads":
        return "\n\n".join(p for p in (ig, *(["――― 最初の返信に貼るリンク / first reply ―――\n" + link] if link else []))) + "\n"
    if channel == "pinterest":
        return "\n\n".join(p for p in (f"TITLE: {sc['title']}", f"DESCRIPTION:\n{ig}", *([f"LINK: {link}"] if link else []))) + "\n"
    if channel == "bluesky":
        line = (sc.get("bsky") or sc["title"]).strip()
        tagline = " ".join(tags[:2])
        return _fit("\n".join(p for p in (line, link) if p), 300 - len(tagline) - 1) + ("\n" + tagline if tagline else "") + "\n"
    if channel == "x":
        return _fit("\n".join(p for p in ((sc.get("x") or sc["title"]).strip(), link) if p), 280, x_length) + "\n"
    if channel in ("line-voom", "line-oa"):
        return "\n\n".join(p for p in (ig, link) if p) + "\n"
    return cap + "\n"


def package(slug: str, only: list[str] | None = None) -> list[str]:
    """One draft folder per network: the 9:16 master (scaled where a network wants another size), its cover, the post
    text and credits.txt. Same folders and names as a reel's (studio.reels.package), so posting reads them unchanged."""
    from studio.guard import assert_copy
    from studio.held import remove
    from studio.reels import CHANNEL_SPEC, CHANNELS, DRAFTS, _channel_info, _cover, _place, file_prefix, get_reel
    from studio.sound import credits

    reel = get_reel(slug)
    out = DATA / "renders" / f"story-{slug}"
    master = out / f"{slug}_9x16.mp4"
    if not master.exists():
        raise FileNotFoundError(f"render first: {master}")
    seconds = seconds_of(reel["explainer"])
    audio_path = out / "audio.json"
    audio = json.loads(audio_path.read_text(encoding="utf-8")) if audio_path.exists() else {}
    made = []
    for channel, spec in CHANNELS.items():
        if (only and channel not in only) or not wants({**spec, "id": channel}, seconds):
            continue
        text = post_text(reel, channel)
        assert_copy(text)
        folder = DRAFTS / slug / channel
        folder.mkdir(parents=True, exist_ok=True)
        try:
            for old in [*folder.glob("*.mp4"), *folder.glob("cover*.jpg")]:
                remove(old)
        except PermissionError as err:
            print(f"NOTE {channel}: the earlier copy could not be replaced ({err.strerror or err}); the other networks were made", flush=True)
            continue
        files = [f for f in spec.get("files", []) if f["aspect"] == "9x16"] or [{"aspect": "9x16", "w": 1080, "h": 1920}]
        for f in files:
            dest = folder / f"{file_prefix()}_{slug}_{f['w']}x{f['h']}.mp4"
            if (f["w"], f["h"]) == (1080, 1920):
                _place(master, dest)
            else:
                subprocess.run([str(ffmpeg_bin()), "-y", "-i", str(master), "-vf", f"scale={f['w']}:{f['h']}:flags=lanczos,setsar=1", "-c:v", "libx264",
                                "-preset", "medium", "-crf", "17", "-r", str(CHANNEL_SPEC["fps"]), "-c:a", "copy", "-map_metadata", "-1", str(dest)],
                               check=True, capture_output=True, timeout=600)
        cw, ch = spec["cover"]
        _cover(master, float(reel.get("coverAt", 1.0)), folder / f"cover_{cw}x{ch}.jpg", (cw, ch))
        (folder / "post.txt").write_text(text, encoding="utf-8")
        (folder / "credits.txt").write_text(credits(audio), encoding="utf-8")
        made.append(channel)
    manifest_path = out / "manifest.json"
    if made and manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["channels"] = _channel_info(slug)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return made


def loudnorm(raw: Path, dest: Path, target: float | None = None) -> None:
    """The finished sound at the house loudness (-14 LUFS, true peak under -1.5 dBTP): two passes of ffmpeg loudnorm, the
    first measures, the second applies it linearly (one pass lands a LU or so off: -13.2 and -15.0 on the first renders).
    The picture is copied, not encoded again."""
    from studio.config import SPEC

    level = float(SPEC["loudnessLufs"] if target is None else target)
    base = f"loudnorm=I={level:g}:TP=-1.5:LRA=11"
    r = subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-nostats", "-i", str(raw), "-af", base + ":print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr or "")
    if m:
        got = json.loads(m.group(0))
        base += (f":measured_I={got['input_i']}:measured_TP={got['input_tp']}:measured_LRA={got['input_lra']}"
                 f":measured_thresh={got['input_thresh']}:offset={got['target_offset']}:linear=true")
    tmp = dest.with_suffix(".part.mp4")
    subprocess.run([str(ffmpeg_bin()), "-v", "error", "-y", "-i", str(raw), "-af", base + ",aresample=48000", "-map", "0:v", "-map", "0:a",
                    "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-map_metadata", "-1", "-movflags", "+faststart", str(tmp)],
                   check=True, capture_output=True, timeout=900)
    from studio.held import replace

    replace(tmp, dest)  # a page playing the earlier film holds it open: that copy is moved aside, never a failed render


def _register(slug: str, master: Path, cover: Path, faces: int, caption: Path) -> None:
    """A fresh render goes back to "rendered": a person approves it again (same row a reel's render writes)."""
    from studio.db import connect

    with connect() as con:
        con.execute(
            """INSERT INTO drafts (slug, recipe, edl_json, status, notes, cost, faces, consent, render_natural, render_scored, cover, caption_txt, created_at)
               VALUES (?, 'explainer', '{}', 'rendered', '', 0, ?, 0, ?, ?, ?, ?, ?)
               ON CONFLICT(slug) DO UPDATE SET status='rendered', recipe='explainer', faces=excluded.faces, consent=0,
                 render_natural=excluded.render_natural, render_scored=excluded.render_scored,
                 cover=excluded.cover, caption_txt=excluded.caption_txt""",
            (f"story-{slug}", int(faces > 0), str(master), str(master), str(cover), str(caption), datetime.now().isoformat(timespec="seconds")),
        )


def build(slug: str) -> dict:
    """Render one explainer through the reel pipeline. Prints STAGE n/7 for the render queue."""
    from studio.reels import DRAFTS, _channel_info, _cover, _lufs, _qa, _wave, get_reel
    from studio.remotion import _remotion
    from studio.reels import stage as say
    from studio.verify import verify_master

    reel = get_reel(slug)
    if not is_explainer(reel):
        raise ValueError(f"{slug} is not an explainer")
    script = reel["explainer"]
    say(1, "checking the script")
    res = check(script)
    if not res["ok"]:
        raise ValueError("the script does not pass its checks: " + "; ".join(res["errors"][:5]))
    for w in res["warnings"]:
        print(f"NOTE {w}", flush=True)
    say(2, "cutting the pictures from the library")
    lib = lib_rows(m["id"] for m in res["media"])
    props, audio = stage(script, slug, lib=lib)
    out = DATA / "renders" / f"story-{slug}"
    out.mkdir(parents=True, exist_ok=True)
    pj = out / "props.json"
    pj.write_text(json.dumps(props, ensure_ascii=False, indent=1), encoding="utf-8")
    say(3, "drawing the explainer")
    raw = out / "raw_9x16.mp4"
    if not _remotion("Explainer-9x16", pj, raw):
        raise RuntimeError(f"remotion failed for {slug}; see {raw.with_suffix('.log')}")
    say(4, "setting the loudness (-14 LUFS)")
    master = out / f"{slug}_9x16.mp4"
    loudnorm(raw, master)
    report = verify_master(master)
    (out / "audio.json").write_text(json.dumps(audio, ensure_ascii=False, indent=1), encoding="utf-8")
    say(5, "checking the finished film")
    gate = _qa({"9x16": master}, audio)
    say(6, "cutting a copy for every network")
    faces = max([int((lib.get(m["id"]) or {}).get("faces") or 0) for m in res["media"]] + [0])
    _cover(master, 1.0, out / "hook.jpg")
    _cover(master, max(0.5, res["seconds"] - 2.0), out / "end.jpg")
    manifest = {
        "slug": slug, "kind": KIND, "title": script["title"], "style": KIND, "durationSec": res["seconds"],
        "outputs": {"9x16": str(master)}, "verify": report, "qa": gate, "beats": beats_of(script),
        "stats": {"shots": len(script["scenes"]), "faces": faces, "lufs": _lufs(master), "layers": 0, "blurFaces": False},
        "audio": {"wave": str(_wave(master, out)), **audio},
        "shots": [{"i": k, "file": Path(lib[m["id"]]["path"]).name, "path": lib[m["id"]]["path"], "role": script["scenes"][m["scene"]]["kind"],
                   "sec": m["sec"], "in": m.get("start", 0), "faces": int(lib[m["id"]].get("faces") or 0), "libId": m["id"]} for k, m in enumerate(res["media"])],
        "explainer": {"scenes": [s["kind"] for s in script["scenes"]], "warnings": res["warnings"]},
        "channels": [], "rules": [],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    made = package(slug)
    say(7, "writing the review sheet")
    manifest["channels"] = _channel_info(slug)
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    _register(slug, master, out / "hook.jpg", faces, DRAFTS / slug / "instagram" / "post.txt")
    return {"slug": slug, **report, "faces": faces, "lufs": manifest["stats"]["lufs"], "drafts": str(DRAFTS / slug), "networks": made,
            "qa": {k: v["ok"] for k, v in gate.items()}, "warnings": res["warnings"]}


# ---------- command line ----------
def queue_renders(slugs: list[str], url: str) -> dict:
    """Ask a running studio to queue these renders (its render queue: one at a time, shown in the console)."""
    import urllib.request

    body = json.dumps({"slugs": slugs}).encode()
    origin = url.rstrip("/")
    req = urllib.request.Request(origin + "/api/explainers/queue", data=body, method="POST",
                                 headers={"content-type": "application/json", "origin": origin})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310  (a loopback studio the person names)
        return json.loads(r.read().decode("utf-8"))


def main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="studio explainer", description="Explainers: check scripts, add them as drafts, render, preview.")
    sub = ap.add_subparsers(dest="action", required=True)
    c = sub.add_parser("check", help="check script files, say what is wrong")
    c.add_argument("files", nargs="+")
    a = sub.add_parser("add", help="every *.json in a folder (or one file) becomes a draft explainer")
    a.add_argument("path")
    a.add_argument("--render", action="store_true", help="render the drafts here, one at a time (the studio need not run)")
    a.add_argument("--queue", default=None, metavar="URL", help="queue the renders in a running studio, e.g. http://127.0.0.1:4317")
    b = sub.add_parser("build", help="render one explainer (same as reels --build)")
    b.add_argument("slug")
    s = sub.add_parser("sheet", help="the preview still: every scene once")
    s.add_argument("what", help="a script file or a draft's slug")
    s.add_argument("--out", default=None)
    sub.add_parser("list", help="the script library and what is made")
    args = ap.parse_args(argv)
    if args.action == "check":
        bad = 0
        for f in args.files:
            data, err = read_script(Path(f))
            res = {"ok": False, "errors": [err], "warnings": []} if err else check(data)
            bad += not res["ok"]
            print(f"{'OK  ' if res['ok'] else 'FAIL'} {f}" + (f"  ({res.get('seconds')} s, {res.get('scenes')} scenes)" if res["ok"] else ""))
            for e in res["errors"]:
                print(f"  error: {e}")
            for w in res["warnings"]:
                print(f"  note:  {w}")
        return 1 if bad else 0
    if args.action == "add":
        out = add(args.path)
        print(json.dumps(out, ensure_ascii=False, indent=1))
        if args.queue and out["made"]:
            print("RESULT " + json.dumps(queue_renders(out["made"], args.queue), ensure_ascii=False))
        elif args.render:
            for slug in out["made"]:
                print(json.dumps(build(slug), ensure_ascii=False), flush=True)
        return 1 if out["failed"] and not out["made"] else 0
    if args.action == "build":
        print(json.dumps(build(args.slug), ensure_ascii=False))
        return 0
    if args.action == "sheet":
        p = Path(args.what)
        data = read_script(p)[0] if p.suffix == ".json" and p.exists() else script_of(args.what)
        if not data:
            raise SystemExit(f"no script {args.what}")
        print("STAGE 1/2 cutting the pictures", flush=True)
        path = sheet(data, Path(args.out) if args.out else None)
        print("RESULT " + json.dumps({"slug": data.get("slug"), "sheet": str(path)}, ensure_ascii=False))
        return 0
    if args.action == "list":
        print(json.dumps(scripts(), ensure_ascii=False, indent=1))
        return 0
    return 2


def fingerprint(script: dict) -> str:
    """A short id for a script's content (the console says when a draft's script changed since its render)."""
    return hashlib.sha1(json.dumps(script, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:10]
