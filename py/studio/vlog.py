"""
FILE: py/studio/vlog.py
PURPOSE: Long-form travel vlogs for YouTube (16:9, 5-10 minutes each) from a trip's own clips and photos: a trip is
         split into parts (one video each), each part into chapters (one per day), with the strongest, most varied
         moments picked, the clips' own sound kept, a music bed under it, and YouTube's title, description and
         chapter timestamps written to match the cut.
OVERVIEW: plan(): every usable item of the project's library, by day; days split into `parts` videos of balanced
          size; per day the best moments (aesthetic + sharpness + "is it a moving clip", minus junk) picked with a
          diversity rule (no near-identical bursts), kept in time order. Chapter names say what the pictures show
          (CLIP zero-shot against a fixed list of things a safari trip holds): nothing is claimed that the picture
          does not show, and no place is named that the footage does not prove.
          build(): every shot rendered once to 1920x1080 (the studio's grade, colour match, steadying, upright phone
          clips shown whole over a soft copy), the Vlog-16x9 composition rendered (src/Vlog.tsx), music beds made
          (Stable Audio 2.5 via fal.ai, inside the AI limits) and mixed under the clip sound with ducking
          (studio.sound.mix, -14 LUFS), the quality check run (studio.verify.qa), and youtube.json, description.txt,
          chapters and a thumbnail written next to the master.
DEPENDENCIES: studio.library, studio.shot, studio.pick, studio.sound, studio.verify, studio.ai (music)
USAGE: python -m studio vlog plan [--parts 4] [--minutes 8] | build <n> [--no-music] | all
NOTES: Nothing is posted; uploading stays with a person (the studio's YouTube upload can take master.mp4).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from studio.config import DATA, ROOT, ffmpeg_bin

SIZE = (1920, 1080)
FPS = 30
FADE_SEC = 12 / FPS          # src/Vlog.tsx VLOG_FADE: each dissolve overlaps two shots
PHOTO_SEC = 3.4
VIDEO_MIN, VIDEO_MAX = 2.8, 12.0  # a moving shot may run long: it carries the trip's own sound
CLEAR_MIN = 0.05             # a picture "clearly shows" one of CONCEPTS when its best match beats its average by this
COLD_OPEN = 7                # shots in the cold open
COLD_SEC = 1.9
# A series: episodes of one length the person sets (5-15 minutes), each day of the trip in exactly one of them, in
# story order, one look. Each episode: a cold open from its own peak, "previously" (parts 2 on), the title over a map
# of its leg, the chapters, and a card for the next part at the end (src/Vlog.tsx).
SERIES_TARGET = 10.0         # minutes per episode unless the person sets another
SERIES_BAND = 1.0            # an episode within target +- this many minutes is the right length
SERIES_LOOK = "documentary"  # one look for the whole series
SERIES_HOLD = 14.0           # longest moment of a clip (a documentary part holds 8 s)
SERIES_MOMENTS = 3           # moments one long clip may give, each from its own stretch of the clip
SERIES_COLD = 6              # shots in the cold open...
SERIES_COLD_SEC = 2.0        # ...of this long each (12 s)
SERIES_RECAP = 4             # shots of the part before, "previously"...
SERIES_RECAP_SEC = 1.9       # ...of this long each (under 8 s)
SERIES_TITLE = 6.0           # seconds of the title card with the series map
SERIES_END = 20.0            # seconds of the next-part card at the end (YouTube's end screen sits on it)
SERIES_TEASER = 4            # shots of the next part under that card (silent)
OUT = DATA / "renders" / "vlogs"
PLAN_FILE = DATA / "vlog-plan.json"

# What a safari trip holds, as (chapter word, CLIP prompt). Chapter names come only from these.
CONCEPTS = [
    ("Lions", "a photo of a lion"), ("Cheetahs", "a photo of a cheetah"), ("Leopards", "a leopard resting in a tree or in the grass"),
    ("Hyenas", "a photo of a spotted hyena"), ("Vultures", "vultures feeding on a carcass"), ("Warthogs", "a photo of a warthog"),
    ("Antelope", "an antelope, a gazelle or an impala"), ("Ostriches", "a photo of an ostrich"), ("Crocodiles", "a crocodile in a river"),
    ("Jackals", "a photo of a jackal"),
    ("Elephants", "a photo of an elephant"), ("Giraffes", "a photo of a giraffe"), ("Zebras", "a photo of zebras"),
    ("Wildebeest", "a herd of wildebeest"), ("Buffalo", "a photo of a cape buffalo"), ("Hippos", "a hippo in water"),
    ("Rhinos", "a photo of a rhinoceros"), ("Monkeys", "a photo of a monkey"), ("Birds", "a photo of a wild bird"),
    ("Flamingos", "flamingos at a lake"), ("Game drives", "a safari jeep on a dirt road"),
    ("The plains", "a wide savanna landscape with acacia trees"), ("Sunsets", "a sunset over the plains"),
    ("Crater views", "the rim of a huge volcanic crater"), ("Lakes", "a lake shore with birds"),
    ("The coast", "a tropical beach with turquoise water"), ("Old town streets", "narrow old town streets"),
    ("Markets", "a busy local market"), ("Food", "a plate of food on a table"), ("Camp life", "a safari lodge or tented camp"),
    ("Village visit", "people in a village in colourful traditional dress"), ("Travel day", "an airport, airplane or terminal"),
    ("City streets", "a city street with buildings and traffic"), ("Us", "two people smiling at the camera, a selfie"),
]


def _day(item: dict) -> str | None:
    """The day a picture was taken, in the trip's own time when the plan stamped it (_localize), else as stored."""
    c = str(item.get("_local") or item.get("captured") or "")
    return c[:10] if re.match(r"\d{4}-\d{2}-\d{2}", c) else None


def _when(item: dict) -> str:
    """When a picture was taken, for putting shots in order: the trip's own time when known (see local_time)."""
    return str(item.get("_local") or item.get("captured") or "")


# Time zones a trip's notes may name, as hours from UTC. None of these moves its clocks in summer; any other IANA name
# works where Python has the time-zone database, and "+03:00" always works.
ZONES = {"UTC": 0, "Africa/Nairobi": 3, "Africa/Dar_es_Salaam": 3, "Africa/Kampala": 3, "Africa/Addis_Ababa": 3, "Africa/Kigali": 2,
         "Africa/Johannesburg": 2, "Africa/Cairo": 2, "Asia/Qatar": 3, "Asia/Riyadh": 3, "Asia/Dubai": 4, "Asia/Kolkata": 5.5,
         "Asia/Bangkok": 7, "Asia/Jakarta": 7, "Asia/Singapore": 8, "Asia/Kuala_Lumpur": 8, "Asia/Manila": 8, "Asia/Hong_Kong": 8,
         "Asia/Shanghai": 8, "Asia/Taipei": 8, "Asia/Tokyo": 9, "Asia/Seoul": 9}


def zone_hours(name) -> float | None:
    """Hours from UTC for a zone name ("Africa/Nairobi"), an offset ("+08:00", "UTC+3") or a number; None if unknown."""
    if name is None or isinstance(name, bool):
        return None
    if isinstance(name, (int, float)):
        return float(name) if -12 <= name <= 14 else None
    s = str(name).strip()
    m = re.fullmatch(r"(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?", s)
    if m:
        h = (int(m.group(2)) + int(m.group(3) or 0) / 60) * (1 if m.group(1) == "+" else -1)
        return h if -12 <= h <= 14 else None
    if s in ZONES:
        return float(ZONES[s])
    try:
        from zoneinfo import ZoneInfo

        off = datetime(2026, 1, 15, tzinfo=ZoneInfo(s)).utcoffset()
        return off.total_seconds() / 3600 if off is not None else None
    except Exception:  # no time-zone database on this computer, or not a zone
        return None


def local_time(item: dict, tz=None, clocks: dict | None = None) -> str | None:
    """When a picture was taken in the trip's own time (`tz`), as "YYYY-MM-DDTHH:MM:SS". A video file keeps UTC; a
    photo's EXIF keeps the camera's wall clock with no zone (studio.media stores both as +00:00), so a photo is moved
    by the difference between the trip's zone and its camera's clock (`clocks`: {device: zone}; a camera not listed
    showed local time). Without `tz` the time stays as stored, as before."""
    c = str(item.get("captured") or "")
    if not re.match(r"\d{4}-\d{2}-\d{2}", c):
        return None
    tzh = zone_hours(tz)
    try:
        t = datetime.fromisoformat(c.replace("Z", "+00:00"))
    except ValueError:
        return c[:10]
    if tzh is None or len(c) < 13:
        return t.replace(tzinfo=None).isoformat(timespec="seconds") if len(c) >= 13 else c[:10]
    off = t.utcoffset()
    if off is not None and off.total_seconds():  # a real zone in the file: exact
        utc = t.replace(tzinfo=None) - off
        return (utc + timedelta(hours=tzh)).isoformat(timespec="seconds")
    if item.get("kind") == "video":
        shift = tzh
    else:
        clock = zone_hours((clocks or {}).get(str(item.get("device") or "")))
        shift = tzh - clock if clock is not None else 0.0
    return (t.replace(tzinfo=None) + timedelta(hours=shift)).isoformat(timespec="seconds")


def _localize(rows: list) -> list:
    """Stamp each library row with its time in the trip's own zone (`_local`, see local_time). Returns the rows."""
    t = trip()
    tz, clocks = t.get("tz"), t.get("clocks") or {}
    for r in rows:
        r[0]["_local"] = local_time(r[0], tz, clocks)
    return rows


def clock_offsets(rows: list, least: int = 20) -> dict:
    """What each camera's clock was set to, measured: a photo and a moment of video that look the same (CLIP) were
    taken at the same time, and videos keep true UTC, so the most common gap between the two is the camera's offset
    from UTC. {device: hours}, only for devices with at least `least` such pairs and one clear winner. A suggestion
    for the trip notes' `clocks`; nothing uses it by itself."""
    vids = [(i, e) for i, e in rows if i.get("kind") == "video" and len(str(i.get("captured") or "")) >= 19]
    if not vids:
        return {}
    V = np.stack([e / (np.linalg.norm(e) + 1e-8) for _, e in vids]).astype("float32")
    VT = np.array([datetime.fromisoformat(str(i["captured"])[:19]).timestamp() for i, _ in vids])
    gaps: dict[str, dict[float, int]] = {}
    for i, e in rows:
        if i.get("kind") == "video" or len(str(i.get("captured") or "")) < 19:
            continue
        s = V @ (e / (np.linalg.norm(e) + 1e-8))
        k = int(np.argmax(s))
        if s[k] > 0.92:
            h = round((datetime.fromisoformat(str(i["captured"])[:19]).timestamp() - VT[k]) / 1800) / 2
            if abs(h) <= 14:
                g = gaps.setdefault(str(i.get("device") or ""), {})
                g[h] = g.get(h, 0) + 1
    out = {}
    for dev, g in gaps.items():
        h, n = max(g.items(), key=lambda x: x[1])
        if n >= least and n >= 0.5 * sum(g.values()):
            out[dev] = h
    return out


def _usable(item: dict, clear: float | None = None) -> bool:
    """`clear`: how clearly the picture shows something from CONCEPTS (_clarity). The library's junk score was made
    for the ranch (a floor, a pocket, the ground) and reads savanna as ground: on a trip, a clip it flags still counts
    when it clearly shows an animal or a place; only flagged pictures of nothing in particular are left out."""
    if item.get("vetoed"):
        return False
    # A 360 camera's own files (two fisheye circles, sometimes upside down) and unframed 360 pictures are raw
    # material, not shots: in a 16:9 film they read as a broken picture.
    if item.get("is360") or str(item.get("path") or "").lower().endswith(RAW_360):
        return False
    if (item.get("junk") or 0) > 0.6 and (clear is None or clear < CLEAR_MIN):
        return False
    if item.get("kind") == "video" and (item.get("duration") or 0) < 1.2:
        return False
    # Blurry (under the trip's own sharpness floor on the whole frame AND its sharpest part) or too shaky to steady
    # (studio.quality, measured by `python -m studio quality scan`): left out, not just ranked lower. Part 2 of the
    # trip series used 16 of 120 shots under the trip's 20th percentile (owner, 13 Nov: "blurry photos used").
    if _quality_no(item):
        return False
    return bool(_day(item))


_FLOORS: dict | None = None


def _quality_no(item: dict) -> str | None:
    """"blurry" / "shaky" when studio.quality's measurements say so, else None (unmeasured counts as usable)."""
    global _FLOORS
    from studio import quality

    if not quality.load():
        return None
    if _FLOORS is None:
        from studio.library import _base_items

        _FLOORS = quality.floors([i for i, _ in _base_items()])
    return quality.why_not(item, _FLOORS)


def _score(item: dict) -> float:
    aes = item.get("aesthetic") or 4.5
    sharp = math.log1p(max(0.0, float(item.get("sharp") or 0)))
    moving = 0.6 if item.get("kind") == "video" and (item.get("duration") or 0) >= 3 else 0.0
    junk = float(item.get("junk") or 0) if float(item.get("_clear", 0)) < CLEAR_MIN else 0.0  # see _usable
    return aes + 0.5 * sharp + moving - 3.0 * junk  # a soft or smeared picture loses to a sharp one


def _clarity(emb: np.ndarray, concepts: np.ndarray) -> float:
    """How clearly one picture shows something from CONCEPTS: its best match minus its average match."""
    v = emb / (np.linalg.norm(emb) + 1e-8)
    s = v @ concepts.T
    return float(s.max() - s.mean())


# On-screen animal labels: only these, only when the picture is clear (calibrated on 1,575 safari files, 2026-11-11:
# at LABEL_MIN / LABEL_GAP 38 of 40 sampled labels were right; the misses were broader-word cases, hence "Antelope").
LABEL = {"Lions": "Lion", "Cheetahs": "Cheetah", "Leopards": "Leopard", "Elephants": "Elephant", "Giraffes": "Giraffe", "Zebras": "Zebra",
         "Wildebeest": "Wildebeest", "Buffalo": "Cape buffalo", "Hippos": "Hippo", "Rhinos": "Rhino", "Flamingos": "Flamingos",
         "Hyenas": "Spotted hyena", "Vultures": "Vultures", "Warthogs": "Warthog", "Antelope": "Antelope", "Ostriches": "Ostrich",
         "Crocodiles": "Crocodile", "Jackals": "Jackal", "Monkeys": "Monkeys"}
SWAHILI = {"Lion": "simba", "Cheetah": "duma", "Leopard": "chui", "Elephant": "tembo", "Giraffe": "twiga", "Zebra": "punda milia",
           "Wildebeest": "nyumbu", "Cape buffalo": "nyati", "Hippo": "kiboko", "Rhino": "kifaru", "Flamingos": "heroe", "Spotted hyena": "fisi",
           "Vultures": "tumbusi", "Warthog": "ngiri", "Antelope": "swala", "Ostrich": "mbuni", "Crocodile": "mamba", "Jackal": "bweha"}
EAST_AFRICA = re.compile(r"kenya|tanzania|uganda|rwanda|zanzibar|serengeti|mara|ngorongoro|amboseli|tsavo|nairobi|arusha|kilimanjaro|manyara|tarangire", re.I)
LABEL_MIN, LABEL_GAP = 0.09, 0.02
RAW_360 = (".insv", ".insp", ".lrv")
MEZZ_V = "n2"  # the finish every shot is rendered with (natural grade): part of each shot file's name
THUMB_STARS = {"Lions", "Leopards", "Cheetahs", "Elephants", "Giraffes", "Zebras", "Rhinos", "Hippos", "Flamingos", "Wildebeest", "Buffalo"}
THUMB_NEVER = {"Vultures", "Hyenas", "Crocodiles", "Jackals"}  # scavengers and kills are part of the film, not its cover

# Five art directions. Each is honest numbers for the cut (shot lengths, dissolve frames, how much of the time photos
# may take: the planner sizes a part from the footage with it), a grade laid on every shot (ffmpeg, after the
# studio's own), the music brief, and the drawing in src/Vlog.tsx (type, frame, transitions, overlays) by its name.
LOOKS = {
    "documentary": {"photo": 3.2, "videoMin": 3.0, "videoMax": 8.0, "photoShare": 0.4, "fade": 12, "grade": "",
                    "music": ["a calm wildlife documentary score: fingerpicked acoustic guitar, kalimba, soft hand percussion and warm strings, spacious and observant",
                              "a gentle nature documentary theme: warm strings and marimba over soft hand drums, unhurried, golden afternoon light"]},
    "cinematic": {"photo": 4.0, "videoMin": 3.5, "videoMax": 8.0, "photoShare": 0.3, "fade": 24,
                  "grade": "colorbalance=rs=-0.035:bs=0.045:rh=0.045:gh=0.012:bh=-0.04,eq=contrast=1.04:saturation=0.93",  # a restrained teal-and-warm split
                  "music": ["an epic cinematic orchestral score: swelling strings, deep low brass, soft choir pads and distant taiko hits, a slow build, full of awe",
                            "a sweeping cinematic theme: soaring strings and French horns over a steady low pulse, majestic and emotional"]},
    "energetic": {"photo": 1.6, "videoMin": 1.2, "videoMax": 3.6, "photoShare": 0.25, "fade": 0, "beat": True,
                  "grade": "eq=contrast=1.06:saturation=1.12",
                  "music": ["an upbeat travel montage track at 120 BPM: driving afro-house drums, a bright marimba hook, punchy bass and claps, joyful",
                            "a high-energy percussion groove at 120 BPM with a catchy marimba riff and big drum fills, euphoric"]},
    "journal": {"photo": 4.2, "videoMin": 2.8, "videoMax": 8.0, "photoShare": 0.75, "fade": 18, "lead": "photo",
                "grade": "eq=saturation=0.94:gamma=1.04,colorbalance=rh=0.03:gh=0.01:bh=-0.02",
                "music": ["a gentle travel-journal piece: warm fingerpicked acoustic guitar, soft piano and a light shaker, intimate and nostalgic",
                          "a cosy acoustic folk instrumental: ukulele and acoustic guitar, soft hand claps far back, sunny and personal"]},
    "retro": {"photo": 3.0, "videoMin": 2.4, "videoMax": 8.0, "photoShare": 0.45, "fade": 6,
              "grade": "curves=master='0/0.06 0.5/0.52 1/0.94':blue='0/0.05 1/0.9',colorbalance=rm=0.04:gm=0.015:bm=-0.03,eq=saturation=0.86,noise=alls=7:allf=t",  # faded and warm, never murky
              "music": ["a lo-fi retro home-movie track: dusty vinyl crackle, mellow Rhodes piano, tape-wobbled guitar and laid-back drums",
                        "a warm 1970s soft-rock instrumental with tape hiss: electric piano, brushed drums and a gentle bass line"]},
    # Four more, each cut by its own rule (extend): by animal, photos in black and white, long holds with no music,
    # and the journey itself (camps, tracks, airstrips, people) without the animals.
    "fieldguide": {"photo": 3.6, "videoMin": 3.0, "videoMax": 8.0, "photoShare": 0.45, "fade": 10, "grade": "",
                   "music": ["a light, curious natural-history theme: pizzicato strings, marimba and clarinet, playful and warm",
                             "a gentle woodwind and marimba piece with soft pizzicato strings, inquisitive and bright"]},
    "monochrome": {"photo": 5.0, "videoMin": 3.0, "videoMax": 7.0, "photoShare": 0.8, "fade": 30, "lead": "photo",
                   "grade": "hue=s=0,eq=contrast=1.1",
                   "music": ["a spare, intimate solo piano piece with a slow cello line, long silences between the notes, contemplative",
                             "a quiet minimalist piece for felt piano and soft strings, slow and reflective"]},
    "slow": {"photo": 6.0, "videoMin": 9.0, "videoMax": 36.0, "photoShare": 0.0, "fade": 45, "grade": "", "music": []},  # the place's own sound only
    "roadmovie": {"photo": 2.8, "videoMin": 2.4, "videoMax": 7.0, "photoShare": 0.5, "fade": 8,
                  "grade": "colorbalance=rs=0.03:bs=-0.035:rh=0.035:bh=-0.03,eq=contrast=1.03:saturation=1.04",
                  "music": ["a warm road-trip instrumental: slide guitar, hand claps, upright bass and a loping drum groove, sunny and easy",
                            "an easy-going afro-folk road tune without vocals: nylon guitar, shakers and a walking bass line"]},
}
MORE_LOOKS = ["fieldguide", "monochrome", "slow", "roadmovie"]  # added to a plan by extend(), one video each
MORE = {  # title, card line, minutes
    "fieldguide": ("A Field Guide to the Animals", "A field guide", 8.0),
    "monochrome": ("In Black and White", "A photo essay", 5.0),
    "slow": ("Slow Safari: No Music, Just the Savanna", "Slow safari", 9.0),
    "roadmovie": ("The Road: Camps, Tracks and Airstrips", "The journey", 5.0),
}
ROAD = {"Game drives", "The coast", "Old town streets", "Markets", "Food", "Camp life", "Village visit", "Travel day", "City streets",
        "Us"}  # the journey itself: vehicles, camps, towns, people (a wide view of the plains usually has animals in it)
MORE_THUMB = {"fieldguide": "A Field Guide", "monochrome": "In Black and White", "slow": "Slow Safari", "roadmovie": "The Road"}
LOOK_ALIAS = {"calm": "documentary", "lively": "energetic", "photos": "journal"}  # the planner's first three names
STYLES = LOOKS
REEL_LOOKS = ["energetic", "cinematic", "documentary", "retro", "journal"]  # a showreel: one video in each


def look_of(name: str | None) -> str:
    n = LOOK_ALIAS.get(name or "", name or "")
    return n if n in LOOKS else ""


def fade_sec(look: str | None) -> float:
    return (LOOKS.get(look_of(look)) or {}).get("fade", 12) / FPS
TRIP_FILE = DATA / "vlog-trip.json"  # what the person told us: where each day was, which words go on screen


def trip() -> dict:
    """The person's own notes on the trip: {"places": {day: "Maasai Mara, Kenya"}, "overlays": {...}}."""
    try:
        t = json.loads(TRIP_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        t = {}
    on = {"places": True, "animals": True, "captions": True, **(t.get("overlays") or {})}
    # moments: what happened that day, in the person's own words ("a birthday by the river"); names and captions may use
    # them where the pictures show it. personal: whether names may also mention personal events the pictures seem to
    # show without such a note (off: only what is seen, "two people by the tents").
    places = {k: str(v).strip()[:60] for k, v in (t.get("places") or {}).items() if str(v).strip()}
    # tz: the trip's own time zone (days are counted in it); clocks: {device: zone} a camera's clock was set to (its
    # photos' times have no zone); route: {day: {place, country, lat, lon, stops}} for the maps (see route_of);
    # target: minutes per series episode (the studio's "Length of each episode").
    tz = t.get("tz") if zone_hours(t.get("tz")) is not None else None
    clocks = {str(k)[:40]: v for k, v in (t.get("clocks") or {}).items() if zone_hours(v) is not None}
    target = t.get("target")
    target = float(target) if isinstance(target, (int, float)) and not isinstance(target, bool) and 5 <= target <= 15 else SERIES_TARGET
    return {"places": places, "overlays": on,
            "hints": t.get("hints") or {}, "moments": {k: str(v).strip()[:80] for k, v in (t.get("moments") or {}).items() if str(v).strip()},
            "personal": bool(t.get("personal", False)), "privateOk": bool(t.get("privateOk", False)),
            "tz": tz, "clocks": clocks, "route": with_timeline(route_of(t.get("route") or {}, places), t.get("route") or {}, places),
            "origin": _stop(t.get("origin")), "target": target,
            "studio": t.get("studio") or {}}


# Where places a safari names lie, approximately (park centres, gates and airports, to about 10 km): the map pin for a
# day whose notes give no position. Matched against the person's own words, the first rule that fits wins; their own
# lat/lon always win. (pattern, label, country, lat, lon)
PINS = [
    (r"\bJRO\b|kilimanjaro (international )?airport", "Kilimanjaro International Airport", "Tanzania", -3.43, 37.07),
    (r"\bDAR\b|julius nyerere|dar es salaam", "Dar es Salaam", "Tanzania", -6.88, 39.20),
    (r"\bDOH\b|\bdoha\b|hamad international", "Doha", "Qatar", 25.27, 51.61),
    (r"\bNBO\b|jomo kenyatta|\bnairobi\b", "Nairobi", "Kenya", -1.32, 36.93),
    (r"isebania|sirari", "Isebania border post", "Kenya", -1.24, 34.47),
    (r"sekenani", "Sekenani Gate, Masai Mara", "Kenya", -1.56, 35.36),
    (r"lamai", "Lamai Gate, Northern Serengeti", "Tanzania", -1.47, 34.78),
    (r"mara river|kogatende|northern serengeti", "Northern Serengeti", "Tanzania", -1.56, 34.89),
    (r"ma(a)?sai mara|\bmara\b", "Masai Mara National Reserve", "Kenya", -1.49, 35.14),
    (r"seronera|central serengeti", "Seronera, Central Serengeti", "Tanzania", -2.43, 34.82),
    (r"ikoma", "Ikoma Gate, Serengeti", "Tanzania", -2.09, 34.67),
    (r"serengeti", "Serengeti National Park", "Tanzania", -2.33, 34.83),
    (r"lemala|ngorongoro", "Ngorongoro Crater", "Tanzania", -3.18, 35.58),
    (r"karatu", "Karatu", "Tanzania", -3.34, 35.67),
    (r"arusha", "Arusha", "Tanzania", -3.37, 36.68),
    (r"tarangire", "Tarangire National Park", "Tanzania", -3.90, 36.00),
    (r"manyara", "Lake Manyara National Park", "Tanzania", -3.55, 35.83),
    (r"amboseli", "Amboseli National Park", "Kenya", -2.65, 37.26),
    (r"tsavo", "Tsavo National Park", "Kenya", -2.98, 38.47),
    (r"zanzibar|stone town", "Zanzibar", "Tanzania", -6.16, 39.19),
]


def pin_for(text: str | None) -> dict | None:
    """The approximate pin for a place named in the person's words: {place, country, lat, lon}, or None."""
    for rx, label, country, lat, lon in PINS:
        if text and re.search(rx, str(text), re.I):
            return {"place": label, "country": country, "lat": lat, "lon": lon}
    return None


def _num(v, lo: float, hi: float) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi else None


def _stop(raw) -> dict | None:
    """One point of a route from the notes: {place, country, lat, lon, by}, the position filled from PINS when absent."""
    if not isinstance(raw, dict):
        return None
    place = str(raw.get("place") or "").strip()[:80]
    lat, lon = _num(raw.get("lat"), -90, 90), _num(raw.get("lon"), -180, 180)
    pin = pin_for(place) if lat is None or lon is None else None
    if pin:
        lat, lon = pin["lat"], pin["lon"]
    if lat is None or lon is None:
        return None
    country = str(raw.get("country") or (pin or {}).get("country") or "").strip()[:40]
    by = raw.get("by") if raw.get("by") in ("road", "flight", "boat", "walk") else None
    return {"place": place or (pin or {}).get("place", ""), "country": country, "lat": lat, "lon": lon, **({"by": by} if by else {}),
            **({"main": True} if raw.get("main") else {}), **({"stop": True} if raw.get("stop") else {})}


TL_BY = {"drive": "road", "bus": "road", "bike": "road", "train": "road", "flight": "flight", "boat": "boat", "walk": "walk", "move": "road"}


def with_timeline(route: dict, raw: dict, places: dict, tl: dict | None = None) -> dict:
    """The route, with the days a Google Maps Timeline import knows better (py/studio/timeline.py): each shown visit
    becomes a stop at its real position, with how long they stayed (`stay`, minutes), how they got there (`by`, `leg`
    as words, and `via`: the real road as [lon, lat] points). A day whose stops the person wrote out stays theirs; a
    day's place in their words names its longest visit."""
    from studio import timeline as tlmod

    tl = tl if tl is not None else tlmod.load()
    if not tl:
        return route
    out = dict(route)
    for day, d in (tl.get("days") or {}).items():
        own = raw.get(day) if isinstance(raw.get(day), dict) else {}
        if own.get("stops"):
            continue
        shown = [v for v in d.get("visits") or [] if v.get("show")]
        if not shown:
            continue
        main = max(shown, key=lambda v: v["min"])
        label = str(own.get("place") or places.get(day) or "").strip()[:80]
        legs = sorted(d.get("legs") or [], key=lambda x: x["start"])
        stops = []
        for v in sorted(shown, key=lambda x: x["start"]):
            before = [l for l in legs if l["end"] <= v["start"] and (not stops or l["start"] >= stops[-1]["_end"])]
            leg = before[-1] if before else None
            place = v.get("name") or (label if v is main else "") or v.get("country") or ""
            stop = {"place": place, "country": v.get("country") or "", "lat": v["lat"], "lon": v["lon"], "stop": True, "stay": v["min"], "_end": v["end"]}
            if leg:
                stop.update({"by": TL_BY.get(leg["mode"], "road"), "leg": tlmod.leg_words(leg),
                             **({"via": [[p[1], p[0]] for p in leg["path"][1:-1]]} if leg["mode"] != "flight" and len(leg["path"]) > 2 else {})})
            if v is main:
                stop["main"] = True
            stops.append(stop)
        for s in stops:
            s.pop("_end", None)
        out[day] = {"place": label or main.get("name") or main.get("country") or "", "country": own.get("country") or main.get("country") or "",
                    "lat": main["lat"], "lon": main["lon"], "stops": stops, "timeline": True}
    return dict(sorted(out.items()))


def route_of(raw: dict, places: dict) -> dict:
    """{day: {place, country, lat, lon, stops: [...]}} for the maps: what the notes say, and for a day with only a place
    in words, the pin that fits those words (PINS). `place`/`lat`/`lon` are where the day was filmed (the stop marked
    main, else the last one); stops are the day's travel in order, each with how it was reached (by road or flight)."""
    out = {}
    for day in sorted(set(raw) | set(places)):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(day)):
            continue
        r = raw.get(day) if isinstance(raw.get(day), dict) else {}
        stops = [s for s in (_stop(x) for x in (r.get("stops") or [])) if s]
        main = _stop({**r, "place": r.get("place") or places.get(day) or ""}) if not stops else None
        if not stops and main:
            stops = [main]
        if not stops:
            continue
        at = next((s for s in stops if s.get("main")), stops[-1])
        country = str(r.get("country") or at.get("country") or "").strip()[:40]
        out[day] = {"place": str(r.get("place") or at["place"])[:80], "country": country, "lat": at["lat"], "lon": at["lon"], "stops": stops,
                    **({"note": str(r["note"])[:80]} if r.get("note") else {})}
    return out


# Pictures that look private (someone in a hospital bed, a passport): kept out of every video unless the person says
# otherwise (trip()["privateOk"]). Matched against the trip's own concepts: a picture counts when the private prompt
# beats its best ordinary match by PRIVATE_MARGIN (measured on a test library: private pictures +0.10 to +0.13, the next
# ordinary picture +0.07).
PRIVATE = [("hospital", "a patient lying in a hospital bed"), ("hospital", "a hospital room with medical equipment and an IV drip"),
           ("documents", "a passport, ID card or boarding pass held up to the camera")]
PRIVATE_MARGIN = 0.09
_PRIVATE_M: list = []


def private_kind(emb: np.ndarray, concepts: np.ndarray) -> str | None:
    """"hospital" / "documents" when the picture looks private, else None."""
    from studio.library import text_embedding

    if not _PRIVATE_M:
        m = np.stack([text_embedding(p) for _, p in PRIVATE]).astype("float32")
        _PRIVATE_M.append(m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-8))
    v = emb / (np.linalg.norm(emb) + 1e-8)
    if _PRIVATE_M[0].shape[1] != v.shape[0] or concepts.shape[1] != v.shape[0]:  # another model's vectors: nothing to compare
        return None
    sims = _PRIVATE_M[0] @ v
    k = int(np.argmax(sims))
    return PRIVATE[k][0] if float(sims[k]) - float(max(0.0, (concepts @ v).max())) >= PRIVATE_MARGIN else None


def private_paths(rows: list | None = None) -> dict:
    """{path: kind} of the pictures kept out as private; empty when the person lets them in."""
    if trip().get("privateOk"):
        return {}
    from studio.library import _base_items

    concepts = _concept_matrix()
    out = {}
    for i, e in (rows if rows is not None else _base_items()):
        k = private_kind(e, concepts)
        if k:
            out[i["path"]] = k
    return out


SIGNS_SYSTEM = ("You read signs in travel photos. Report only a place name that is written on a sign, board, gate, banner or "
                "building in these pictures (a park, reserve, gate, town, lodge, airport). Never guess from the landscape, the "
                "animals or the people. Reply JSON only.")


def place_hints() -> dict:
    """Places read from signs, per day: the pictures most like a signboard (CLIP), as one contact sheet a day, to the
    vision model (inside the AI limits, about $0.003 a day). Saved as hints in the trip notes; the person decides."""
    from studio import ai
    from studio.library import _base_items, text_embedding

    q = text_embedding("a signboard or gate with a written place name")
    q = q / (np.linalg.norm(q) + 1e-8)
    by_day: dict[str, list] = {}
    for it, e in _localize(list(_base_items())):
        d = _day(it)
        if d:
            by_day.setdefault(d, []).append({"path": it["path"], "kind": it.get("kind"), "score": float((e / (np.linalg.norm(e) + 1e-8)) @ q)})
    hints, failed = {}, 0
    for d in sorted(by_day):
        ranked = sorted(by_day[d], key=lambda s: -s["score"])
        got, broke = {}, False
        for k in range(3):  # the nine most sign-like pictures first; a day with no sign in them gets two more sheets
            top = ranked[9 * k: 9 * k + 9]
            if not top:
                break
            sheet = _sheet(top, OUT / "signs" / (f"{d}.jpg" if not k else f"{d}-{k + 1}.jpg"))
            try:
                got = ai.vision_json([sheet], SIGNS_SYSTEM, f"These are {len(top)} pictures from {d} of a trip. Reply as JSON: "
                                     '{"place": "the place name exactly as written, with its country when a sign shows it, or null", '
                                     '"read": "the words on the sign, as written, or null"}', "vlog-signs", purpose="vlog-signs", max_tokens=1200)  # thinking models spend tokens first
            except Exception as err:  # no key, over a limit: no hint for this day
                print(f"signs {d}: {err}", flush=True)
                broke = True
                break
            if str(got.get("place") or "").strip().lower() not in ("", "null", "none"):
                break
        if broke:
            failed += 1
            continue
        place = str(got.get("place") or "").strip()
        if place.isupper():  # signs shout: "MASAI MARA NATIONAL RESERVE" reads better as "Masai Mara National Reserve"
            place = " ".join(w if len(w) <= 3 and w.isalpha() and w in ("KWS", "USA", "UK") else w.capitalize() for w in place.split())
        if place and place.lower() not in ("null", "none"):
            hints[d] = {"place": place[:60], "read": str(got.get("read") or "").strip()[:120]}
    t = {}
    try:
        t = json.loads(TRIP_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    t["hints"] = hints
    TRIP_FILE.write_text(json.dumps(t, ensure_ascii=False, indent=1), encoding="utf-8")
    if failed == len(by_day):
        raise RuntimeError("The vision model could not read the pictures (no key, over a limit, or it failed): no places were read.")
    return {"hints": hints, "days": len(by_day), "failed": failed}


def _subject(emb: np.ndarray, concepts: np.ndarray) -> tuple[str | None, float, float]:
    """The concept a picture clearly shows, with its margin (best vs average) and gap (best vs second best)."""
    v = emb / (np.linalg.norm(emb) + 1e-8)
    s = v @ concepts.T
    o = np.argsort(-s)
    return CONCEPTS[int(o[0])][0], float(s[o[0]] - s.mean()), float(s[o[0]] - s[o[1]])


def _concept_matrix() -> np.ndarray:
    from studio.library import text_embedding

    m = np.stack([text_embedding(p) for _, p in CONCEPTS]).astype("float32")
    return m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-8)


def _votes(embs: list[np.ndarray], concepts: np.ndarray) -> np.ndarray:
    """How many of these pictures clearly show each thing (their best match stands out from their own average)."""
    if not embs:
        return np.zeros(len(CONCEPTS))
    e = np.stack(embs).astype("float32")
    e = e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-8)
    sims = e @ concepts.T
    best = sims.argmax(axis=1)
    clear = sims.max(axis=1) - sims.mean(axis=1) > 0.035
    return np.bincount(best[clear], minlength=len(CONCEPTS)).astype("float64")


def chapter_name(embs: list[np.ndarray], concepts: np.ndarray | None = None, trip: np.ndarray | None = None) -> str:
    """The two things that set these pictures apart ("Lions & Cheetahs"): frequent here, and more frequent here than
    across the whole trip (`trip`: the trip's votes), so a thing every day shows does not name every day."""
    if not embs:
        return "On the road"
    concepts = concepts if concepts is not None else _concept_matrix()
    v = _votes(embs, concepts)
    if not v.sum():
        return "On the road"
    share = v / v.sum()
    if trip is not None and trip.sum():
        base = (trip + 1) / (trip.sum() + len(CONCEPTS))
        score = share / base * np.sqrt(share)
    else:
        score = share
    floor = max(2.0, 0.06 * v.sum())
    top = [CONCEPTS[i][0] for i in np.argsort(-score) if v[i] >= floor][:2]
    return " & ".join(top) if top else CONCEPTS[int(v.argmax())][0]


def _pick(cands: list[tuple[dict, np.ndarray]], budget: float, same: float = 0.9, style: str | None = None, hold: float | None = None) -> list[tuple[dict, np.ndarray]]:
    """The best moments of one day that fill `budget` seconds, in time order. Moving clips go in first (motion and
    the place's own sound are what make a vlog; a photo only fills what the clips leave). Near-identical pictures
    (bursts) are left out; when photos are too few to fill the day, their rule loosens step by step (never to exact
    copies)."""
    picked: list[tuple[dict, np.ndarray]] = []
    vecs: list[np.ndarray] = []
    used = 0.0
    # Variety first: clips that look alike (the same animal from the same spot) wait until the different ones are in;
    # two clips of one lion are still two moments, so they come back when the day would otherwise run short.
    passes = [("video", (0.86, 0.91, max(same, 0.955))), ("photo", (0.86, same, 0.93, 0.955, 0.975))]
    lk = LOOKS.get(look_of(style)) or {}
    cap = {}
    if lk.get("lead") == "photo":
        # A photo journal leads with photos, up to its share of the time; clips fill the rest as moving pages.
        passes = [("photo", (0.86, same, 0.93)), ("video", (0.86, 0.91, max(same, 0.955)))]
        cap["photo"] = budget * lk.get("photoShare", 0.75)
    for kind, limits in passes:
        room = cap.get(kind, budget)
        ranked = sorted((c for c in cands if (c[0].get("kind") == "video") == (kind == "video")), key=lambda c: -_score(c[0]))
        for limit in limits:
            for item, emb in ranked:
                if used >= room:
                    break
                v = emb / (np.linalg.norm(emb) + 1e-8)
                if any(item is p for p, _ in picked) or any(float(v @ w) > limit for w in vecs):
                    continue
                picked.append((item, emb)); vecs.append(v)
                used += shot_seconds(item, style, hold) - fade_sec(style)
            if used >= room:
                break
    return sorted(picked, key=lambda c: _when(c[0]))


def shot_seconds(item: dict, style: str | None = None, hold: float | None = None) -> float:
    """How long a shot of this item lasts in a look; `hold` raises the longest hold of a clip (a series lets a clip
    run up to SERIES_HOLD). A moment that is one part of a clip (item["_part"] = [j, k]) has only its k-th of it."""
    st = LOOKS.get(look_of(style)) or {}
    if item.get("kind") != "video":
        return st.get("photo", PHOTO_SEC)
    d = float(item.get("duration") or 0)
    part = item.get("_part")
    if part and part[1] > 1:
        d = d / part[1]
    top = max(st.get("videoMax", VIDEO_MAX), hold or 0)
    return round(min(top, max(st.get("videoMin", VIDEO_MIN), d * 0.75), max(1.0, d - 0.3)), 2)


def _moments(item: dict) -> int:
    """How many moments a clip can give in a series: one per SERIES_HOLD + 4 s of it, at most SERIES_MOMENTS."""
    if item.get("kind") != "video":
        return 1
    return max(1, min(SERIES_MOMENTS, int(float(item.get("duration") or 0) // (SERIES_HOLD + 4))))


def _capacity(items: list[dict]) -> float:
    """Seconds of honest material for a series episode: every moment a clip can give (_moments, each its own stretch
    of the clip, up to SERIES_HOLD) and about 60% of the photos (as _material counts them)."""
    s = 0.0
    for i in items:
        if i.get("kind") == "video":
            k = _moments(i)
            s += sum(shot_seconds({**i, "_part": [j, k]}, SERIES_LOOK, SERIES_HOLD) for j in range(k)) if k > 1 else shot_seconds(i, SERIES_LOOK, SERIES_HOLD)
        else:
            s += 0.6 * PHOTO_SEC
    return s


def _more_moments(chosen: list, budget: float, look: str, hold: float) -> list:
    """A day that came out short gets more moments from its long clips: each picked clip that can give several
    (_moments) is cut into that many stretches and each stretch gives one moment (build renders each from its own
    stretch), best-scoring clips first, until the day fills `budget` seconds. In time order."""
    fs = fade_sec(look)
    used = sum(shot_seconds(i, look, hold) - fs for i, _ in chosen)
    if used >= budget * 0.97:
        return chosen
    out = list(chosen)
    for item, emb in sorted(chosen, key=lambda c: -_score(c[0])):
        k = _moments(item)
        if k < 2 or item.get("_part"):
            continue
        parts = [({**item, "_part": [j, k]}, emb) for j in range(k)]
        idx = next(n for n, c in enumerate(out) if c[0] is item)
        gain = sum(shot_seconds(p, look, hold) for p, _ in parts) - shot_seconds(item, look, hold) - fs * (k - 1)
        out[idx: idx + 1] = parts
        used += gain
        if used >= budget * 0.97:
            break
    return sorted(out, key=lambda c: (_when(c[0]), (c[0].get("_part") or [0])[0]))


def _group_days(stats: list[tuple[str, float]], want: float) -> list[list[str]]:
    """Consecutive days into parts by how much moving footage they hold: a part closes once it has `want` seconds of
    video; a short last group joins the one before. stats: [(day, video seconds as shots)] in order."""
    groups: list[list[str]] = []
    cur: list[str] = []
    got = 0.0
    for day, sec in stats:
        cur.append(day)
        got += sec
        if got >= want:
            groups.append(cur)
            cur, got = [], 0.0
    if cur:
        if groups and got < want / 2:
            groups[-1].extend(cur)
        else:
            groups.append(cur)
    return groups[:8]


def _split(days: list[tuple[str, int]], parts: int) -> list[list[str]]:
    """Consecutive days into `parts` groups whose largest group (in items) is as small as it can be."""
    parts = max(1, min(parts, len(days)))
    sizes = [n for _, n in days]
    pre = [0]
    for n in sizes:
        pre.append(pre[-1] + n)
    INF = float("inf")
    best = [[INF] * (len(days) + 1) for _ in range(parts + 1)]
    cut = [[0] * (len(days) + 1) for _ in range(parts + 1)]
    best[0][0] = 0
    for p in range(1, parts + 1):
        for i in range(1, len(days) + 1):
            for j in range(p - 1, i):
                v = max(best[p - 1][j], pre[i] - pre[j])
                if v < best[p][i]:
                    best[p][i], cut[p][i] = v, j
    out, i = [], len(days)
    for p in range(parts, 0, -1):
        j = cut[p][i]
        out.append([d for d, _ in days[j:i]])
        i = j
    return out[::-1]


STORY_PENALTY = 0.25  # what breaking one story rule costs against evenness (series_split)


def series_split(days: list[str], cap: dict[str, float], target: float, moments=(), country: dict | None = None, travel=(),
                 most: int = 8) -> list[list[str]]:
    """Consecutive days into the fewest episodes of `target` minutes the footage holds honestly, each day in exactly one.
    cap: seconds of material per day (_capacity). An episode needs at least 1.25 x target of material (less, and it
    repeats or pads); the count starts at total / (3 x target) (more material than that per episode, and good moments
    are thrown away) and goes up until a split fits. Among the splits of that count, the one with the most even
    material, plus STORY_PENALTY for each story rule it breaks:
      a moment day (moments: days the person noted something happened) is cut off from the day before it (the lead-in
      and the climax belong in one episode);
      an episode changes country part-way through, except onto a travel day (travel: days with a flight), which may
      end an episode (the way home);
      an episode is only travel days (an arrival day joins the first real day)."""
    T = target * 60
    days = [d for d in days if d in cap]
    if not days:
        return []
    total = sum(cap[d] for d in days)
    country, moments, travel = country or {}, set(moments), set(travel)

    def cost_of(g: list[str], mean: float, n: int) -> float:
        c = sum(cap[d] for d in g)
        if c < 1.25 * T:
            return math.inf
        k = (c / mean - 1) ** 2 / n
        k += STORY_PENALTY * sum(1 for a, b in zip(g, g[1:]) if country.get(a) and country.get(b) and country[a] != country[b] and b not in travel)
        if all(d in travel for d in g):
            k += STORY_PENALTY
        return k

    def best(n: int) -> list[list[str]] | None:
        mean, L = total / n, len(days)
        INF = math.inf
        dp = [[INF] * (L + 1) for _ in range(n + 1)]
        cut = [[0] * (L + 1) for _ in range(n + 1)]
        dp[0][0] = 0.0
        for k in range(1, n + 1):
            for i in range(k, L + 1):
                for j in range(k - 1, i):
                    if dp[k - 1][j] == INF:
                        continue
                    v = dp[k - 1][j] + cost_of(days[j:i], mean, n) + (STORY_PENALTY if j > 0 and days[j] in moments else 0.0)
                    if v < dp[k][i]:
                        dp[k][i], cut[k][i] = v, j
        if dp[n][L] == INF:
            return None
        out, i = [], L
        for k in range(n, 0, -1):
            j = cut[k][i]
            out.append(days[j:i])
            i = j
        return out[::-1]

    lo = max(1, math.ceil(total / (3 * T)))
    for n in [*range(lo, min(most, len(days)) + 1), *range(min(lo, len(days) + 1) - 1, 0, -1)]:
        got = best(n)
        if got:
            return got
    return [days]  # too little for even one episode of this length: one, as long as it honestly gets


MOMENT_SUBJECTS = {"Us", "Camp life"}  # pictures of people (two people smiling, the camp they were at)
MOMENT_SHARE = 0.4    # of the day's share of the episode, for the day's noted moment
MOMENT_MAX = 75.0     # seconds, at most
MOMENT_WINDOW = 90    # minutes: the moment is the densest stretch of such pictures that day


def _moment_pick(cands: list, concepts, budget: float, look: str | None) -> list:
    """A noted moment's pictures: the day's pictures of people (MOMENT_SUBJECTS), from the MOMENT_WINDOW minutes with
    the most of them, in time order, up to `budget` seconds. None when the day has fewer than three."""
    people = sorted((c for c in cands if _subject(c[1], concepts)[0] in MOMENT_SUBJECTS), key=lambda c: _when(c[0]))
    if len(people) < 3 or budget < 6:
        return []
    def t(c):
        try:
            return datetime.fromisoformat(_when(c[0])[:19])
        except ValueError:
            return None
    times = [t(c) for c in people]
    best, lo = (0, 0, 0), 0
    for hi in range(len(people)):
        while times[hi] and times[lo] and (times[hi] - times[lo]).total_seconds() > MOMENT_WINDOW * 60:
            lo += 1
        if hi - lo + 1 > best[0]:
            best = (hi - lo + 1, lo, hi)
    stretch = people[best[1]: best[2] + 1]
    picked = _pick(stretch, budget, style=look) if len(stretch) >= 3 else []
    return sorted(picked, key=lambda c: _when(c[0]))


def _moment_title(note: str) -> str:
    """The person's note as a chapter title: "a birthday by the river" -> "A Birthday by the River" (their words, never invented)."""
    words = str(note).strip().rstrip(".")[:60].split()
    small = {"a", "an", "the", "and", "of", "at", "in", "on", "by", "to", "with"}
    return " ".join(w if (i and w.lower() in small) or w[:1].isupper() else w[:1].upper() + w[1:] for i, w in enumerate(words)) or "A Moment"


def plan(parts: int = 4, minutes: float = 8.0, name: str | None = None, since: str | None = None, until: str | None = None,
         style: str | None = None, groups: list[list[str]] | None = None, lengths: list[float] | None = None, dry: bool = False,
         _rows: list | None = None, looks: list[str] | None = None, series: bool = False) -> dict:
    """The trip, cut into `parts` videos of about `minutes` each (or the given day `groups`, each `lengths[i]` minutes,
    in a `style`). Written to vlog-plan.json (and returned); `dry` only returns it (for suggestions). `series`: the
    episodes of a series (see series()): clips hold up to SERIES_HOLD and give several moments before photos fill a
    day, the body leaves room for the cold open, "previously" and the next-part card, and the cold open comes from
    the episode's own peak."""
    from studio.brand import brand
    from studio.library import _base_items

    concepts = _concept_matrix()
    rows = []
    src = _localize(list(_rows if _rows is not None else _base_items()))
    held = private_paths(src)
    for i, e in src:
        i["_clear"] = _clarity(e, concepts)
        if _usable(i, i["_clear"]) and i["path"] not in held and (not since or _day(i) >= since) and (not until or _day(i) <= until):
            rows.append((i, e))
    if not rows:
        raise ValueError("No usable clips or photos with a date in this project's library yet: import the trip and let the scan finish.")
    by_day: dict[str, list] = {}
    for it, emb in rows:
        by_day.setdefault(_day(it), []).append((it, emb))
    days = sorted(by_day)
    if groups:
        groups = [[d for d in g if d in by_day] for g in groups]
        groups = [g for g in groups if g]
    else:
        groups = _split([(d, len(by_day[d])) for d in days], parts)
    t = trip()
    places, route = t["places"], t.get("route") or {}
    trip_votes = _votes([e for _, e in rows], concepts)
    title = name or brand()["name"] or "The trip"
    # Days are counted from the trip's first day (the route when the notes give one, else the footage): "Day 4 of 10".
    span_days = sorted(set(days) | set(route))
    day0 = datetime.fromisoformat(span_days[0])
    day_no = lambda d: (datetime.fromisoformat(d) - day0).days + 1  # noqa: E731
    hold = SERIES_HOLD if series else None
    videos = []
    used: set[str] = set()
    for n, group in enumerate(groups, 1):
        target = (lengths[n - 1] if lengths and n - 1 < len(lengths) else minutes) * 60
        body = target - COLD_OPEN * COLD_SEC - 4
        if series:  # the title card lies over the first chapter; the cold open, "previously" and the end card are their own shots
            body = target - SERIES_COLD * SERIES_COLD_SEC - (SERIES_RECAP * SERIES_RECAP_SEC if n > 1 else 0) - SERIES_END
        look = look_of(looks[n - 1] if looks and n - 1 < len(looks) else style)
        # With a look, each day's share follows its moving footage (photos then fill each day in proportion);
        # without one, its size (the first planner's rule).
        moving = {d: sum(shot_seconds(it, look) for it, _ in by_day[d] if it.get("kind") == "video") for d in group}
        weights = {d: max(moving[d], 20.0) for d in group} if look else {d: math.sqrt(len(by_day[d])) for d in group}
        if look and len(group) >= 5:
            # A film of the whole trip draws on every day, not mostly the day with the most footage.
            weights = {d: math.sqrt(max(moving[d], 20.0)) for d in group}
        chapters = []
        for d in group:
            share = body * weights[d] / sum(weights.values())
            # Parts that cover the same days (a highlight and a day-by-day part) never show the same shot twice:
            # what an earlier part took is left out, unless the day then has too little to fill its share.
            fresh = [c for c in by_day[d] if c[0]["path"] not in used]
            enough = sum(shot_seconds(it, look, hold) for it, _ in fresh) >= share * 0.8
            cands = fresh if enough else by_day[d]
            moment = []
            if series and d in t["moments"]:
                # The day the person noted something happened ("A birthday by the river") ends on it: its own chapter from the
                # day's pictures of people, the densest stretch of them. Picked first, so the wildlife cannot crowd it
                # out (13 Nov: an episode named after a noted moment did not show it: its pictures were stills and clips
                # came first).
                moment = _moment_pick(cands, concepts, min(MOMENT_MAX, share * MOMENT_SHARE), look)
                share -= sum(shot_seconds(it, look) for it, _ in moment)
                cands = [c for c in cands if c not in moment]
            if series:
                # Moving footage first, with every moment a long clip can give, then photos for what is left.
                clips = _more_moments(_pick([c for c in cands if c[0].get("kind") == "video"], share, style=look, hold=hold), share, look, hold)
                left = share - sum(shot_seconds(it, look, hold) - fade_sec(look) for it, _ in clips)
                stills = _pick([c for c in cands if c[0].get("kind") != "video"], left, style=look) if left > 2 else []
                chosen = sorted([*clips, *stills], key=lambda c: (_when(c[0]), (c[0].get("_part") or [0])[0]))
            else:
                chosen = _pick(cands, share, style=look)
            used.update(it["path"] for it, _ in chosen)
            # A part of one or two days still gets three or more chapters: each day is cut at its longest pauses.
            for seg in (_segments(chosen) if len(group) < 3 else [chosen]):
                chapters.append({"day": d, "dayNo": day_no(d), "place": places.get(d), "title": chapter_name([e for _, e in seg], concepts, trip_votes),
                                 "shots": [{"path": it["path"], "kind": it["kind"], "sec": shot_seconds(it, look, hold), "captured": it.get("captured"),
                                            **({"local": it["_local"]} if it.get("_local") else {}), **({"part": it["_part"]} if it.get("_part") else {}),
                                            "duration": it.get("duration"), "score": round(_score(it), 2), "is360": it.get("is360", False),
                                            **dict(zip(("subject", "clear", "gap"), (lambda r: (r[0], round(r[1], 3), round(r[2], 3)))(_subject(e, concepts))))}
                                           for it, e in seg]})
            if moment:
                used.update(it["path"] for it, _ in moment)
                chapters.append({"day": d, "dayNo": day_no(d), "place": places.get(d), "title": _moment_title(t["moments"][d]), "moment": True,
                                 "shots": [{"path": it["path"], "kind": it["kind"], "sec": shot_seconds(it, look), "captured": it.get("captured"),
                                            **({"local": it["_local"]} if it.get("_local") else {}), "duration": it.get("duration"),
                                            "score": round(_score(it), 2), "is360": it.get("is360", False),
                                            **dict(zip(("subject", "clear", "gap"), (lambda r: (r[0], round(r[1], 3), round(r[2], 3)))(_subject(e, concepts))))}
                                           for it, e in moment]})
        pool = [s for c in chapters for s in c["shots"]]
        cold = sorted(pool, key=lambda s: -s["score"])[:COLD_OPEN]
        if series and chapters:
            # Open in the middle of the episode's strongest moment: the day the person noted something happened, else
            # the chapter whose best shots score highest.
            def peak_score(c: dict) -> tuple:
                top3 = sorted((s["score"] for s in c["shots"]), reverse=True)[:3]
                return (c["day"] in t["moments"], sum(top3) / max(1, len(top3)))
            peak = max(chapters, key=peak_score)
            cold = sorted(peak["shots"], key=lambda s: -s["score"])[:SERIES_COLD]
            if len(cold) < SERIES_COLD:
                cold += [s for s in sorted(pool, key=lambda s: -s["score"]) if s not in cold][: SERIES_COLD - len(cold)]
            cold = [{**s, "sec": min(s["sec"], SERIES_COLD_SEC) if s["kind"] != "video" else SERIES_COLD_SEC} for s in cold]
        part_name = chapter_name([e for d in group for _, e in _pick(by_day[d], 1e9, 0.9)], concepts, trip_votes)
        top = [w for w in part_name.split(" & ") if w not in ("On the road", "Us")]
        first, last = group[0], group[-1]
        span = _span(first, last)
        videos.append({"n": n, "slug": f"vlog-{n}", "title": f"{title} · Part {n}: {' & '.join(top) if top else span}",
                       "card": title, "cardSub": f"Part {n} · {span}", "days": group, "span": span, "chapters": chapters, "look": look or None,
                       "cold": cold if series else [{**s, "sec": COLD_SEC} for s in cold]})
    out = {"made": datetime.now().isoformat(timespec="seconds"), "name": title, "parts": len(videos), "minutes": minutes, "videos": videos,
           "items": len(rows), "days": days, "style": style, "dayOf": day_no(span_days[-1])}
    if not dry:
        PLAN_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


# The music of each episode follows its place in the story (the look's own score, in this mood).
SERIES_MOODS = {"first": "an arrival: warm, spacious and hopeful, the first look at wild country",
                "middle": "out with the guides: steady, alert and curious, a quiet tension",
                "peak": "the high point of the trip: joyful, tender and full of wonder",
                "last": "the long way home: warm, reflective and grateful"}


def series(target: float | None = None, band: float = SERIES_BAND, name: str | None = None, titles: list[str] | None = None,
           dry: bool = False, _rows: list | None = None) -> dict:
    """The trip as a series: episodes of `target` minutes (the trip notes' target, else SERIES_TARGET), each day in
    exactly one, in story order (series_split), all in one look (SERIES_LOOK). Each episode knows its place: series
    {n, of}, prev and next, the shots that recap the part before, the next part's teaser under its end card, the
    person's own note for its days (arc) and the mood of its music. `titles`: the person's own episode titles, in
    order ("The River Crossing and a Birthday"); they become "<name> · Part n of N: <title>" and stay as given.
    Written to vlog-plan.json (and returned); `dry` only returns it."""
    from studio.library import _base_items

    t = trip()
    target = float(target or t.get("target") or SERIES_TARGET)
    if not 5 <= target <= 15:
        raise ValueError("target: 5 to 15 minutes per episode")
    src = _localize(list(_rows if _rows is not None else _base_items()))
    concepts = _concept_matrix()
    held = private_paths(src)
    by_day: dict[str, list] = {}
    for i, e in src:
        i["_clear"] = _clarity(e, concepts)
        if _usable(i, i["_clear"]) and i["path"] not in held:
            by_day.setdefault(_day(i), []).append(i)
    if not by_day:
        raise ValueError("No usable clips or photos with a date in this project's library yet: import the trip and let the scan finish.")
    route = t.get("route") or {}
    country = {d: r["country"] for d, r in route.items() if r.get("country")}
    travel = {d for d, r in route.items() if any(s.get("by") == "flight" for s in r.get("stops") or [])}
    days = sorted(by_day)
    groups = series_split(days, {d: _capacity(by_day[d]) for d in days}, target, moments=set(t["moments"]), country=country, travel=travel)
    p = plan(name=name, style=SERIES_LOOK, groups=groups, lengths=[target] * len(groups), dry=True, _rows=src, series=True)
    vids, N = p["videos"], len(p["videos"])
    for v in vids:
        n = v["n"]
        own = str(titles[n - 1]).strip()[:70] if titles and n - 1 < len(titles) and str(titles[n - 1] or "").strip() else ""
        v["series"] = {"n": n, "of": N}
        v["prev"], v["next"] = (n - 1 if n > 1 else None), (n + 1 if n < N else None)
        v["title"] = f"{p['name']} · Part {n} of {N}: {own}"[:100] if own else v["title"].replace(f"Part {n}:", f"Part {n} of {N}:", 1)
        if own:
            v["fixedTitle"], v["episode"] = True, own
        v["cardSub"] = f"Part {n} of {N} · {v['span']}"
        notes = [t["moments"][d] for d in v["days"] if d in t["moments"]]
        v["arc"] = notes[0] if notes else None
        role = "peak" if notes else "first" if n == 1 else "last" if n == N and N > 1 else "middle"
        v["moods"] = [f"{m}; the story here: {SERIES_MOODS[role]}" for m in LOOKS[SERIES_LOOK]["music"]]
    for v in vids:
        n = v["n"]
        if v["prev"]:
            # "Previously": the part before's strongest moving moments, one shot each, in the order they happened.
            before = [s for c in vids[n - 2]["chapters"] for s in c["shots"]]
            seen_paths, recap = set(), []
            for s in sorted(before, key=lambda s: (s["kind"] != "video", -s["score"])):
                if s["path"] not in seen_paths:
                    seen_paths.add(s["path"])
                    recap.append({**s, "sec": SERIES_RECAP_SEC})
                if len(recap) >= SERIES_RECAP:
                    break
            v["recap"] = sorted(recap, key=lambda s: str(s.get("local") or s.get("captured") or ""))
        # Under the end card: the next part's opening (the last part: the first part's, "watch from Part 1"), silent.
        nxt = vids[n] if n < N else vids[0]
        pool = [*nxt["cold"], *sorted((s for c in nxt["chapters"] for s in c["shots"]), key=lambda s: -s["score"])]
        fs = fade_sec(SERIES_LOOK)
        each = (SERIES_END + fs * (SERIES_TEASER - 1)) / SERIES_TEASER  # SERIES_TEASER shots fill SERIES_END with their dissolves
        teaser, got, seen = [], 0.0, set()
        for s in pool:
            key = (s["path"], tuple(s.get("part") or ()))
            if key in seen:
                continue
            seen.add(key)
            sec = min(each, SERIES_END - got + fs)
            if s["kind"] == "video":
                sec = min(sec, max(1.0, float(s.get("duration") or sec) / max(1, (s.get("part") or [0, 1])[1]) - 0.3))
            teaser.append({**s, "sec": round(sec, 2)})
            got += sec - (fs if len(teaser) > 1 else 0.0)
            if got >= SERIES_END - 0.05:
                break
        v["teaser"] = teaser
    p["series"] = {"target": target, "band": band, "of": N, "look": SERIES_LOOK}
    p["minutes"] = target
    if not dry:
        PLAN_FILE.write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")
    return p


def extend(looks: list[str] | None = None, dry: bool = False, _rows: list | None = None, _plan: dict | None = None) -> dict:
    """More videos on the plan there is, one per look in `looks` (default MORE_LOOKS) it does not have yet. The videos
    it has stay as they are (same numbers, same shots, still built). Each new one is cut by its own rule:
      fieldguide  a chapter per animal, the ones seen most first; every shot clearly shows that animal
      monochrome  the whole trip day by day, photographs first
      slow        the whole trip day by day, only clips of 8 s or more, held long
      roadmovie   the whole trip day by day, only pictures that show the journey most (camps, tracks, towns, people, airports)
    A shot an earlier video used is taken only when there is not enough else. Returns the plan; "added" lists the new numbers."""
    from studio.library import _base_items

    plan_ = _plan if _plan is not None else json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    have = {v.get("look") for v in plan_["videos"]}
    todo = [lk for lk in (looks or MORE_LOOKS) if lk in MORE and lk not in have]
    concepts = _concept_matrix()
    rows = []
    src = _localize(list(_rows if _rows is not None else _base_items()))
    held = private_paths(src)
    for i, e in src:
        i["_clear"] = _clarity(e, concepts)
        if _usable(i, i["_clear"]) and i["path"] not in held:
            rows.append((i, e, _subject(e, concepts)))
    days = sorted({_day(i) for i, _, _ in rows})
    places = trip()["places"]
    trip_votes = _votes([e for _, e, _ in rows], concepts)
    used = {s["path"] for v in plan_["videos"] for c in v["chapters"] for s in c["shots"]}
    animal = lambda sj: sj[0] in LABEL and sj[1] >= LABEL_MIN and sj[2] >= LABEL_GAP  # noqa: E731
    n, added = max((v["n"] for v in plan_["videos"]), default=0), []
    for look in todo:
        name, card, minutes = MORE[look]
        body = minutes * 60 - COLD_OPEN * COLD_SEC - 4
        if look == "fieldguide":
            by: dict[str, list] = {}
            for i, e, sj in rows:
                if animal(sj):
                    by.setdefault(sj[0], []).append((i, e))
            secs = {k: sum(shot_seconds(i, look) for i, _ in v) for k, v in by.items()}
            keys = sorted((k for k, v in by.items() if len(v) >= 3 and secs[k] >= 12), key=lambda k: -secs[k])[:9]
            groups = [(k, by[k]) for k in keys]
        else:
            keep = {"monochrome": lambda i, sj: True, "slow": lambda i, sj: i.get("kind") == "video" and (i.get("duration") or 0) >= 8,
                    "roadmovie": lambda i, sj: sj[0] in ROAD and sj[1] >= LABEL_MIN and sj[2] >= LABEL_GAP}[look]  # what the picture shows most is a camp, a track, a town, people: never an animal
            groups = [(d, [(i, e) for i, e, sj in rows if _day(i) == d and keep(i, sj)]) for d in days]
            groups = [(d, c) for d, c in groups if c]
        if not groups:
            continue
        weight = {k: math.sqrt(max(sum(shot_seconds(i, look) for i, _ in c), 20.0)) for k, c in groups}
        chapters = []
        for k, cands in groups:
            share = body * weight[k] / sum(weight.values())
            fresh = [c for c in cands if c[0]["path"] not in used]
            enough = sum(shot_seconds(i, look) for i, _ in fresh) >= share * 0.8
            chosen = _pick(fresh if enough else cands, share, style=look)
            if look in ("fieldguide", "roadmovie"):
                # The clips of this animal (or of the road) went into the earlier videos: here they come back for up to 40% of its
                # chapter (a field guide of stills only is a slideshow); the rest is photographs no video has shown.
                clips = _pick([c for c in cands if c[0]["path"] in used and c[0].get("kind") == "video"], share * 0.4, style=look)
                took = sum(shot_seconds(i, look) for i, _ in clips)
                rest = _pick([c for c in (fresh if enough else cands) if not any(c[0] is p for p, _ in clips)], max(4.0, share - took), style=look) if clips else chosen
                chosen = sorted([*clips, *rest] if clips else rest, key=lambda c: str(c[0].get("captured") or ""))
            if look == "slow":
                chosen = [c for c in chosen if c[0].get("kind") == "video"]
            if not chosen:
                continue
            used.update(i["path"] for i, _ in chosen)
            day = k if look != "fieldguide" else _day(chosen[0][0])
            extra = {"title": k, "label": f"No. {len(chapters) + 1:02d}", "fixed": True, "place": None} if look == "fieldguide" \
                else {"title": chapter_name([e for _, e in chosen], concepts, trip_votes), "place": places.get(day)}
            chapters.append({"day": day, "dayNo": days.index(day) + 1, **extra,
                             "shots": [{"path": it["path"], "kind": it["kind"], "sec": shot_seconds(it, look), "captured": it.get("captured"), **({"local": it["_local"]} if it.get("_local") else {}),
                                        "duration": it.get("duration"), "score": round(_score(it), 2), "is360": it.get("is360", False),
                                        **dict(zip(("subject", "clear", "gap"), (lambda r: (r[0], round(r[1], 3), round(r[2], 3)))(_subject(e, concepts))))}
                                       for it, e in chosen]})
        if not chapters:
            continue
        n += 1
        pool = [s for c in chapters for s in c["shots"]]
        seen_days = sorted({str(s.get("local") or s.get("captured") or "")[:10] for s in pool} & set(days)) or days
        span = _span(seen_days[0], seen_days[-1])
        plan_["videos"].append({"n": n, "slug": f"vlog-{n}", "title": f"{plan_['name']} · Part {n}: {name}", "card": name, "cardSub": f"{card} · {span}",
                                "days": seen_days, "span": span, "chapters": chapters, "look": look, "fixedTitle": True,
                                "cold": [{**s, "sec": COLD_SEC} for s in sorted(pool, key=lambda s: -s["score"])[:COLD_OPEN]]})
        added.append(n)
    plan_["parts"] = len(plan_["videos"])
    plan_["added"] = added
    if not dry and added:
        PLAN_FILE.write_text(json.dumps(plan_, ensure_ascii=False, indent=1), encoding="utf-8")
    return plan_


FRESH_MOVING = ["documentary", "cinematic", "retro", "energetic"]  # looks for a fresh film of moving footage, in turn (the themed looks have their own rules)
FRESH_PHOTO = ["journal", "monochrome"]  # and for one made mostly of photographs
FRESH_MIN = 3.0  # seconds of a clip no video shows yet, for it to give one more shot
FRESH_USES = 3  # a clip that this many videos already show gives no more: a fourth moment of it reads as a repeat
PLAN_MAX = 20  # videos in one plan (server/review.mjs VLOG_MAX)


def _left(item: dict, shown: list) -> float:
    """Seconds of a clip no video shows yet (the part before, between and after the shown moments)."""
    dur = float(item.get("duration") or 0)
    spans = sorted((max(0.0, a), min(dur, b)) for a, b in shown)
    gone, end = 0.0, 0.0
    for a, b in spans:  # union of the shown spans
        a = max(a, end)
        if b > a:
            gone += b - a
            end = b
    return max(0.0, dur - 0.6 - gone)


def _shown(plan_: dict) -> dict:
    """{clip path: [(start, end), ...]}: the moments the plan's videos show. From vlog-windows.json once a video is built
    (the real windows); for a planned one not built yet, the length of its shot in the middle of the clip."""
    real = windows()
    built = {sl for w in real.values() for *_, sl in w}
    out: dict = {}
    for p, ws in real.items():
        out.setdefault(p, []).extend((a, b) for a, b, _ in ws)
    for v in plan_.get("videos", []):
        if v["slug"] in built:
            continue
        for c in v["chapters"]:
            for s in c["shots"]:
                if s["kind"] == "video":
                    d = float(s.get("duration") or s["sec"])
                    out.setdefault(s["path"], []).append(((d - s["sec"]) / 2, (d + s["sec"]) / 2))
    return out


def coverage(rows: list, plan_: dict | None) -> dict:
    """The yardstick: how much of the usable footage the plan's videos use, what is left, and how many more videos the
    rest can honestly make. rows: [(item, embedding)] of usable footage (with _clear). "Good" left-over photos are the
    ones that score at least as well as the bottom quarter of what the videos already show."""
    import statistics

    plan_ = plan_ or {"videos": []}
    shown = _shown(plan_)
    in_plan = {s["path"] for v in plan_["videos"] for c in v["chapters"] for s in c["shots"]}
    clips = [i for i, _ in rows if i.get("kind") == "video"]
    photos = [i for i, _ in rows if i.get("kind") != "video"]
    moving = sum(float(i.get("duration") or 0) for i in clips)
    left = {i["path"]: (_left(i, shown.get(i["path"], [])) if len(shown.get(i["path"], [])) < FRESH_USES else 0.0) for i in clips}
    scores = [_score(i) for i, _ in rows if i["path"] in in_plan]
    floor = statistics.quantiles(scores, n=4)[0] if len(scores) >= 8 else -1e9
    fresh_photos = [i for i in photos if i["path"] not in in_plan and _score(i) >= floor]
    left_sec = sum(min(s, 3 * 8.0) for s in left.values() if s >= FRESH_MIN)  # at most three more moments of one clip
    more = len(_fresh_groups(rows, plan_)[2])
    room = max(0, PLAN_MAX - len(plan_["videos"]))
    return {"videos": len(plan_["videos"]),
            "clips": len(clips), "clipsUsed": sum(1 for i in clips if i["path"] in in_plan),
            "photos": len(photos), "photosUsed": sum(1 for i in photos if i["path"] in in_plan),
            "movingMin": round(moving / 60, 1), "shownMin": round(sum(float(i.get("duration") or 0) - 0.6 - left[i["path"]] for i in clips if i["path"] in shown) / 60, 1),
            "leftMin": round(left_sec / 60, 1), "freshPhotos": len(fresh_photos),
            "more": min(more, room), "moreAll": more, "room": room}


FRESH_WANT = 5 * 60  # seconds of material (one moment per clip, about 60% of the photos at PHOTO_SEC) for one more video


def _material(items: list[dict]) -> float:
    return sum(shot_seconds(i, "documentary") for i in items if i.get("kind") == "video") + 0.6 * PHOTO_SEC * sum(1 for i in items if i.get("kind") != "video")


def _fresh_groups(rows: list, plan_: dict) -> tuple[list, dict, list]:
    """What no video shows yet: (pool, by_day, groups). pool: clips with a moment left (their duration cut to what is
    left) and good photos no video used; groups: consecutive days, each with about FRESH_WANT of material (a short last
    stretch joins the one before), so every planned video can be a real one, not a minute of leftovers."""
    import statistics

    shown = _shown(plan_)
    in_plan = {s["path"] for v in plan_["videos"] for c in v["chapters"] for s in c["shots"]}
    scores = [_score(i) for i, _ in rows if i["path"] in in_plan]
    floor = statistics.quantiles(scores, n=4)[0] if len(scores) >= 8 else -1e9
    pool = []
    for i, e in rows:
        if i.get("kind") == "video":
            left = _left(i, shown.get(i["path"], [])) if len(shown.get(i["path"], [])) < FRESH_USES else 0.0
            if left >= FRESH_MIN:
                pool.append(({**i, "duration": min(float(i.get("duration") or 0), left + 0.6)}, e))
        elif i["path"] not in in_plan and _score(i) >= floor:
            pool.append((i, e))
    by_day: dict[str, list] = {}
    for i, e in pool:
        by_day.setdefault(_day(i), []).append((i, e))
    stats = [(d, _material([i for i, _ in by_day[d]])) for d in sorted(by_day)]
    groups = _group_days(stats, FRESH_WANT) if sum(s for _, s in stats) >= FRESH_WANT else []
    return pool, by_day, groups


def fresh(count: int | None = None, dry: bool = False, _rows: list | None = None, _plan: dict | None = None) -> dict:
    """More videos from footage no video of the plan shows yet: clips with moments still unshown (each shot takes a moment
    the others do not, see _render_one) and photographs no video has used. The trip is cut into `count` stretches (default
    what coverage() says it can hold), each a different look: moving footage gets FRESH_MOVING in turn, a stretch that is
    mostly photographs a photo look. The videos there are stay as they are. Returns the plan; "added" lists the new numbers."""
    from studio.library import _base_items

    plan_ = _plan if _plan is not None else json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    concepts = _concept_matrix()
    rows = []
    src = _localize(list(_rows if _rows is not None else _base_items()))
    held = private_paths(src)
    for i, e in src:
        i["_clear"] = _clarity(e, concepts)
        if _usable(i, i["_clear"]) and i["path"] not in held:
            rows.append((i, e))
    cov = coverage(rows, plan_)
    plan_["added"] = []
    pool, by_day, groups = _fresh_groups(rows, plan_)
    if count is not None and 0 < int(count) < len(groups):  # fewer, longer stretches
        groups = _split([(d, len(by_day[d])) for d in sorted(by_day)], int(count))
    groups = groups[: cov["room"]]
    if not groups:
        return plan_
    looks, lengths, nm, np_ = [], [], 0, 0
    for g in groups:
        items = [i for d in g for i, _ in by_day[d]]
        mov = sum(shot_seconds(i, "documentary") for i in items if i.get("kind") == "video")
        if mov < 0.35 * _material(items):  # mostly photographs: a photo look
            lk, np_ = FRESH_PHOTO[np_ % len(FRESH_PHOTO)], np_ + 1
        else:
            lk, nm = FRESH_MOVING[nm % len(FRESH_MOVING)], nm + 1
        looks.append(lk)
        lengths.append(round(min(3.5 if lk == "energetic" else 9.0, max(3.0 if lk == "energetic" else 4.0, 0.85 * _material(items) / 60)), 1))
    p = plan(name=plan_["name"], groups=groups, lengths=lengths, looks=looks, dry=True, _rows=pool)
    n = max((v["n"] for v in plan_["videos"]), default=0)
    for v in p["videos"]:
        n += 1
        v.update({"n": n, "slug": f"vlog-{n}", "fresh": True, "title": v["title"].replace(f"Part {v['n']}", f"Part {n}"),
                  "cardSub": v["cardSub"].replace(f"Part {v['n']}", f"Part {n}")})
        plan_["videos"].append(v)
        plan_["added"].append(n)
    plan_["parts"] = len(plan_["videos"])
    if not dry:
        PLAN_FILE.write_text(json.dumps(plan_, ensure_ascii=False, indent=1), encoding="utf-8")
    return plan_


def _mix(video: dict) -> dict:
    """What one planned part is made of: minutes, moving clips, photos, and the share of the time that moves."""
    shots = [s for c in video["chapters"] for s in c["shots"]]
    moving = sum(s["sec"] for s in shots if s["kind"] == "video")
    total = sum(s["sec"] for s in shots) or 1.0
    extra = [*video.get("cold", []), *video.get("recap", []), *video.get("teaser", [])] if video.get("series") else []
    whole = sum(s["sec"] for s in extra) - fade_sec(video.get("look")) * len(extra) if extra else COLD_OPEN * COLD_SEC
    return {"days": video["days"], "span": video["span"], "look": video.get("look"),
            "minutes": round((total - fade_sec(video.get("look")) * max(0, len(shots) - 1) + whole) / 60, 1),
            "videos": sum(s["kind"] == "video" for s in shots), "photos": sum(s["kind"] != "video" for s in shots), "videoPct": round(100 * moving / total)}


def suggest(style: str = "calm", name: str | None = None, target: float | None = None) -> dict:
    """What this footage can become, without spending anything: the footage per day (moving minutes, photos, what is
    in it, the place the person gave), and plans with honest numbers, each made by the real picker in a dry run. The
    series comes first and is the suggestion: episodes of `target` minutes (the trip notes' length when not given),
    each day once, in story order, in one look (series()). Then separate films: one highlight film, the showreel of
    looks, more looks and films of what is left; and the plain even split for comparison."""
    from studio.library import _base_items

    style = look_of(style) or "documentary"
    st = LOOKS[style]
    concepts = _concept_matrix()
    rows = _localize(list(_base_items()))
    t = trip()
    days: dict[str, dict] = {}
    for it, e in rows:
        it["_clear"] = _clarity(e, concepts)
        if not _usable(it, it["_clear"]):
            continue
        d = days.setdefault(_day(it), {"day": _day(it), "videos": 0, "videoSec": 0.0, "photos": 0, "seen": {}})
        if it.get("kind") == "video":
            d["videos"] += 1
            d["videoSec"] += shot_seconds(it, style)
        else:
            d["photos"] += 1
        what, margin, gap = _subject(e, concepts)
        if margin >= LABEL_MIN and gap >= LABEL_GAP / 2:
            d["seen"][what] = d["seen"].get(what, 0) + 1
    if not days:
        raise ValueError("No usable clips or photos with a date in this project's library yet: import the trip and let the scan finish.")
    order = sorted(days)
    have = [{"day": d, "videos": days[d]["videos"], "videoMin": round(days[d]["videoSec"] / 60, 1), "photos": days[d]["photos"],
             "seen": [k for k, _ in sorted(days[d]["seen"].items(), key=lambda x: -x[1])[:4]], "place": t["places"].get(d, ""),
             "country": ((t.get("route") or {}).get(d) or {}).get("country", "")} for d in order]
    total_video = sum(days[d]["videoSec"] for d in order)
    keep = 1 - st["photoShare"]
    sized = lambda sec, lo, hi: round(min(hi, max(lo, sec / keep / 60)), 1)  # noqa: E731  minutes a part can fill at this style
    options = []
    target = float(target or t.get("target") or SERIES_TARGET)
    try:  # the series: planned for real (dry), so its numbers are the ones the build will use
        sp = series(target=target, name=name, dry=True, _rows=rows)
        options.append({"id": "series", "series": True, "planned": True, "target": target, "look": SERIES_LOOK,
                        "groups": [v["days"] for v in sp["videos"]], "lengths": [target] * len(sp["videos"]),
                        "titles": [v["title"] for v in sp["videos"]], "parts": [_mix(v) for v in sp["videos"]]})
    except (ValueError, KeyError) as err:
        print(f"series: {err}", flush=True)
    options.append({"id": "highlights", "groups": [order], "lengths": [sized(total_video, 4, 12)]})
    even = _split([(d, 1) for d in order], min(4, len(order)))
    options.append({"id": "even", "groups": even, "lengths": [8.0] * len(even)})
    if len(order) >= 3:
        # A showreel: the whole trip as a 3-minute beat-cut highlight, three stretches of the trip each in its own look,
        # and the whole trip again as a photo journal. Same footage, five art directions.
        three = _split([(d, days[d]["videos"] + days[d]["photos"]) for d in order], 3)  # three stretches of the trip, evenly by what was shot
        fit = lambda g, lk: round(min(12, max(4, sum(days[d]["videoSec"] for d in g) / (1 - LOOKS[lk]["photoShare"]) / 60)), 1)  # noqa: E731
        options.insert(0, {"id": "looks", "more": True, "groups": [order, *three, order], "looks": REEL_LOOKS,
                           "lengths": [3.0, *[fit(g, lk) for g, lk in zip(three, REEL_LOOKS[1:4])], 6.0]})
    try:  # more looks for the plan there is: each added as one more video, the built ones untouched
        ext = extend(dry=True, _rows=rows) if PLAN_FILE.exists() else None
        new = [v for v in ext["videos"] if v["n"] in ext["added"]] if ext else []
        if new:
            options.append({"id": "more", "extend": True, "looks": [v["look"] for v in new], "groups": [v["days"] for v in new],
                            "lengths": [MORE[v["look"]][2] for v in new], "parts": [_mix(v) for v in new]})
    except (OSError, ValueError, KeyError):
        pass
    cover = None
    held = private_paths(rows)
    try:  # the yardstick, and more videos from what no video shows yet
        current = json.loads(PLAN_FILE.read_text(encoding="utf-8")) if PLAN_FILE.exists() else {"videos": []}
        ok = [(i, e) for i, e in rows if _usable(i, i["_clear"]) and i["path"] not in held]
        cover = coverage(ok, current)
        if current["videos"] and cover["more"]:
            fr = fresh(dry=True, _rows=rows, _plan=json.loads(json.dumps(current)))
            new = [v for v in fr["videos"] if v["n"] in fr["added"]]
            if new:
                options.append({"id": "fresh", "extend": True, "fresh": True, "looks": [v["look"] for v in new], "groups": [v["days"] for v in new],
                                "lengths": [0] * len(new), "parts": [_mix(v) for v in new]})
    except (OSError, ValueError, KeyError) as err:
        print(f"coverage: {err}", flush=True)
    def parts_of(o: dict) -> list[dict]:
        p = plan(name=name, style=style, groups=o["groups"], lengths=o["lengths"], dry=True, _rows=rows, looks=o.get("looks"))
        if o.get("more"):  # the showreel also holds the four films cut by theme
            p = extend(dry=True, _rows=rows, _plan=p)
        return [_mix(v) for v in p["videos"]]

    for o in options:
        looks = o.get("looks")
        if not o.get("extend") and not o.get("planned"):
            o["parts"] = parts_of(o)
        aims = [0 if LOOKS[look_of(lk) or style].get("lead") == "photo" else 100 * (1 - LOOKS[look_of(lk) or style]["photoShare"])
                for lk in (looks or [style] * len(o["parts"]))]  # a journal is photos on purpose: never shortened for it
        if o["id"] not in ("even", "more", "fresh", "series") and any(x["videoPct"] < a - 5 for x, a in zip(o["parts"], aims)):
            # The picker leaves near-identical clips out, so a part can hold less moving footage than counted: shorten
            # the parts that came out short to what they really hold, once, and plan again.
            o["lengths"] = [round(max(3.0, ln * x["videoPct"] / a), 1) if x["videoPct"] < a - 5 else ln for ln, x, a in zip(o["lengths"], o["parts"], aims)]
            o["parts"] = parts_of(o)
        o["minutes"] = round(sum(x["minutes"] for x in o["parts"]), 1)
        o["videoPct"] = round(sum(x["videoPct"] * x["minutes"] for x in o["parts"]) / max(1, o["minutes"]))
        o["weak"] = [x["span"] for x in o["parts"] if x["videoPct"] < 50 and (LOOKS.get(x.get("look") or "") or {}).get("lead") != "photo"
                     and x.get("look") not in MORE and o["id"] != "fresh"]  # a journal, a photo essay and the themed films lean on photos on purpose; fresh films are what is left
        if o.get("more"):
            o["allLooks"] = [x.get("look") for x in o["parts"]]
        pieces = sum(max(1, min(3, math.ceil(x["minutes"] * 60 / 175))) for x in o["parts"] if (LOOKS.get(x.get("look") or style) or {}).get("music", True))
        o["usd"] = round(pieces * 0.2 + 0.01 * len(o["parts"]), 2)  # music beds (Stable Audio, ~$0.20 a piece) + naming
        o["buildMin"] = round(sum(x["minutes"] for x in o["parts"]) * 3)  # this PC: about 3 minutes per minute of video
    best = next((o for o in options if o["id"] == "series"), None) or max((o for o in options if o["id"] not in ("even", "looks", "more", "fresh")), key=lambda o: (o["videoPct"] >= 60, o["minutes"] if o["videoPct"] >= 60 else o["videoPct"]))
    raw = sum(float(it.get("duration") or 0) for it, _ in rows if it.get("kind") == "video" and _usable(it, it.get("_clear")))
    return {"style": style, "styles": list(LOOKS), "target": target, "have": have, "videoMin": round(total_video / 60, 1), "rawMin": round(raw / 60, 1),
            "videos": sum(x["videos"] for x in have), "photos": sum(x["photos"] for x in have), "options": options, "best": best["id"],
            "places": sum(1 for x in have if x["place"]), "overlays": t["overlays"], "coverage": cover,
            "moments": t["moments"], "personal": t["personal"], "privateOk": t.get("privateOk", False),
            "held": {"count": len(held), "kinds": sorted(set(held.values())), "files": [Path(p).name for p in list(held)[:12]]}}


def overlays(seq: list[dict], starts: list[float], chapter_at: list[tuple[float, dict]], total: float, end_quiet: float = 15.0,
             title_at: float | None = None, title_sec: float = 4.5, label_sec: float = 4.2, quiet: list | None = None) -> list[dict]:
    """What goes on screen besides the pictures, never two at once: each chapter's caption (what the viewer sees, from the
    vision model) after its place-and-day label, and an animal's name (with its Swahili name on an East African trip)
    the first time it is clearly in a shot, again only after a while. seq/starts: the shots and where each begins.
    A series' title card (with its map) runs title_sec, its place tags label_sec; `quiet`: more (start, end) spans that
    carry their own words (the "previously" recap)."""
    t = trip()
    on, places = t["overlays"], " ".join(t["places"].values())
    # Where each chapter's label sits (Vlog.tsx ChapterLabel): 0.6 s in for label_sec, or after the title card when
    # the chapter opens under it.
    label = []
    for at, _ in chapter_at:
        a = at + 0.6
        if title_at is not None and a < title_at + title_sec and a + label_sec > title_at:
            a = title_at + title_sec
        label.append((a, a + label_sec))
    busy: list[tuple[float, float]] = list(label) + ([(title_at, title_at + title_sec)] if title_at is not None else []) + list(quiet or [])
    out: list[dict] = []
    free = lambda a, b: all(b <= x or a >= y for x, y in busy) and b < total - end_quiet  # noqa: E731
    if on.get("captions"):
        for (at, c), (_, lab_end) in zip(chapter_at, label):
            text = str(c.get("caption") or "").strip()
            a = lab_end + 0.4
            if text and free(a, a + 5.0):
                out.append({"kind": "note", "atSec": round(a, 2), "sec": 5.0, "title": text[:84]})
                busy.append((a, a + 5.0))
    if on.get("animals"):
        last: dict[str, float] = {}
        for s, at in zip(seq, starts):
            label = LABEL.get(s.get("subject") or "")
            if not label or s.get("clear", 0) < LABEL_MIN or s.get("gap", 0) < LABEL_GAP or s["sec"] < 1.4:
                continue
            # A long shot: the name sits inside it. A short one (a beat-cut): from its first frames, 1.6 s at least.
            a = at + (0.7 if s["sec"] >= 2.5 else 0.15)
            b = a + max(1.6, min(3.4, s["sec"] - 0.9))
            if at - last.get(label, -1e9) < 90 or not free(a - (2 if s["sec"] >= 2.5 else 0.6), b + (2 if s["sec"] >= 2.5 else 0.6)):
                continue
            local = SWAHILI.get(label) if EAST_AFRICA.search(places) else None
            out.append({"kind": "subject", "atSec": round(a, 2), "sec": round(b - a, 2), "title": label, **({"sub": f"{local} in Swahili"} if local else {})})
            busy.append((a, b))
            last[label] = at
    return sorted(out, key=lambda o: o["atSec"])


def _segments(chosen: list[tuple[dict, np.ndarray]], most: int = 3, least: int = 10, gap_min: float = 40.0) -> list[list]:
    """A day's picked moments cut at its longest pauses (over `gap_min` minutes between two shots), into at most
    `most` parts of at least `least` shots each: morning at the camp, the drive, the evening. In time order."""
    def t(item: dict) -> float:
        try:
            return datetime.fromisoformat(str(item.get("_local") or str(item.get("captured"))[:19])).timestamp()  # one clock for photos and clips
        except ValueError:
            return 0.0
    if len(chosen) < 2 * least:
        return [chosen]
    gaps = sorted(((t(chosen[k][0]) - t(chosen[k - 1][0]), k) for k in range(1, len(chosen))), reverse=True)
    cuts: list[int] = []
    for g, k in gaps:
        if len(cuts) >= most - 1 or g < gap_min * 60:
            break
        edges = sorted([0, *cuts, k, len(chosen)])
        if all(b - a >= least for a, b in zip(edges, edges[1:])):
            cuts.append(k)
    edges = sorted([0, *cuts, len(chosen)])
    return [chosen[a:b] for a, b in zip(edges, edges[1:])]


def _span(a: str, b: str) -> str:
    fa, fb = datetime.fromisoformat(a), datetime.fromisoformat(b)
    if a == b:
        return f"{fa.day} {fa:%B %Y}"
    if fa.month == fb.month:
        return f"{fa.day}–{fb.day} {fb:%B %Y}"
    return f"{fa.day} {fa:%b} – {fb.day} {fb:%b %Y}"


EYES_SYSTEM = ("You name the chapters of a travel vlog from contact sheets of its pictures. Name only what is clearly visible: "
               "animals (a species only when it is unmistakable in several pictures, else a broader word such as 'big cats' or "
               "'antelope'), what people do, the landscape. A place name only when it is written on a sign in the pictures. "
               "Never guess a country, park or town from the scenery. {personal} Chapter titles: 2 to 5 words, Title Case, the most "
               "striking thing first, all different from each other. Video title: at most 55 characters, the two most striking "
               "things actually in the pictures, concrete nouns (for example 'Lions at Dawn and a Balloon over the Plains'); "
               "never the words journey, adventure, wildlife, safari, drives, exploring or diverse; honest, no clickbait, "
               "no emoji. Hook: at most 8 words naming two or three things the viewer is about to see, as a plain phrase (for "
               "example 'A river crossing, then lions at dusk'); no verbs like appear, feature or showcase, no question, "
               "no exclamation mark. "
               "Thumb: 2 to 4 words, the single most striking thing in the pictures, Title Case. Reply JSON only.")
PERSONAL_OFF = ("Never name a personal event or relationship (a proposal, a wedding, a birthday, a couple) unless the person's "
                "own note for that day says it: otherwise say only what is seen (two people by the tents).")
PERSONAL_ON = ("A personal moment (a proposal, a birthday, a reunion) may be named when the pictures clearly show it; the "
               "person's own note for that day wins over your reading, in their words.")


def eyes_system(personal: bool) -> str:
    """EYES_SYSTEM with the person's choice on personal moments (trip()["personal"])."""
    return EYES_SYSTEM.replace("{personal}", PERSONAL_ON if personal else PERSONAL_OFF)


def notes_for(days: list[str]) -> str:
    """The person's own notes for these days, for the naming prompt (empty when there are none)."""
    m = trip()["moments"]
    got = [f"{d}: {m[d]}" for d in dict.fromkeys(days) if d in m]
    return ("The person's own notes on what happened (their words; use them, in these words, for a chapter of that day whose "
            "pictures show it, and never on a chapter of animals or scenery): " + "; ".join(got) + ". ") if got else ""


def _sheet(shots: list[dict], dest: Path, n: int = 9) -> Path:
    """A 3x3 contact sheet of the chapter's strongest pictures, spread across it (960x600 JPEG)."""
    from PIL import Image

    from studio.shot import PHOTO_EXT, flat_photo

    dest.parent.mkdir(parents=True, exist_ok=True)
    ranked = sorted(range(len(shots)), key=lambda k: -shots[k]["score"])[: n * 2]
    pick = sorted(ranked[:: max(1, len(ranked) // n)][:n])
    sheet = Image.new("RGB", (960, 600), (16, 16, 16))
    for k, idx in enumerate(pick):
        s = shots[idx]
        src = Path(s["path"])
        try:
            if src.suffix.lower() in PHOTO_EXT:
                im = Image.open(flat_photo(src))
            else:
                frame = dest.with_suffix(f".{k}.jpg")
                subprocess.run([str(ffmpeg_bin()), "-y", "-loglevel", "error", "-ss", f"{min(1.0, float(s.get('duration') or 2) / 2):.2f}", "-i", str(src),
                                "-frames:v", "1", "-vf", "scale=640:-2", str(frame)], check=True, capture_output=True, timeout=60)
                im = Image.open(frame)
            im = im.convert("RGB")
            im.thumbnail((320, 200))
            sheet.paste(im, ((k % 3) * 320 + (320 - im.width) // 2, (k // 3) * 200 + (200 - im.height) // 2))
        except Exception:
            continue
    sheet.save(dest, quality=82)
    for extra in dest.parent.glob(dest.stem + ".*.jpg"):
        extra.unlink(missing_ok=True)
    return dest


def name_with_eyes(plan_: dict | None = None, only: list[int] | None = None) -> dict:
    """Chapter and video titles from the pictures, by the reviewer's vision model (one call per video, inside the AI
    limits). The CLIP names stay as the fallback when there is no key or the call fails."""
    from studio import ai

    plan_ = plan_ or json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    for v in plan_["videos"]:
        if only and v["n"] not in only:
            continue
        sheets = [_sheet(c["shots"], OUT / v["slug"] / f"sheet-{k}.jpg") for k, c in enumerate(v["chapters"])]
        ser = v.get("series") or {}
        before = next((x for x in plan_["videos"] if x["n"] == v.get("prev")), None) if ser else None
        context = (f"This is episode {ser['n']} of {ser['of']} of a series, in story order"
                   + (f"; the episode before showed: {before.get('summary') or before['title'].split(': ', 1)[-1]}" if before else "")
                   + ". Write the summary so a viewer who starts here understands it. ") if ser else ""
        prompt = (f"These {len(sheets)} images are the chapters of part {v['n']} of a trip film called '{plan_['name']}', in order "
                  f"(days: {', '.join(c['day'] for c in v['chapters'])}). {context}{notes_for([c['day'] for c in v['chapters']])}Reply as JSON: "
                  '{"chapters": ["title for image 1", ...], "captions": ["one plain sentence for image 1, at most 80 characters, '
                  'present tense, saying what the viewer sees", ...], "title": "video title without the trip name", '
                  '"summary": "one plain sentence on what this part shows", "hook": "at most 8 words", "thumb": "2 to 4 words"}')
        got = None
        for attempt in (1, 2):  # a reply that is not JSON is asked once more
            try:
                got = ai.vision_json(sheets, eyes_system(trip()["personal"]), prompt, v["slug"], purpose="vlog-names", max_tokens=4000)  # room for a thinking model and nine chapters
                break
            except Exception as err:  # no key, over a limit, or the model failed: keep the names from the pictures' CLIP votes
                print(f"names for part {v['n']} (try {attempt}): {err}", flush=True)
        if not got:
            continue
        names = [str(x).strip()[:48] for x in (got.get("chapters") or [])]
        if len(names) == len(v["chapters"]) and all(names) and not any(c.get("fixed") for c in v["chapters"]):
            for c, nm in zip(v["chapters"], names):
                if not c.get("moment"):  # a noted moment keeps the person's own words
                    c["clip"], c["title"] = c["title"], nm
        caps = [str(x).strip()[:84] for x in (got.get("captions") or [])]
        if len(caps) == len(v["chapters"]):
            for c, cap in zip(v["chapters"], caps):
                c["caption"] = cap
        if got.get("title") and not v.get("fixedTitle"):
            part = f"Part {ser['n']} of {ser['of']}" if ser else f"Part {v['n']}"
            v["title"] = f"{plan_['name']} · {part}: {str(got['title']).strip()[:60]}"[:100]
        if got.get("summary"):
            v["summary"] = str(got["summary"]).strip()[:300]
        hook, thumb = str(got.get("hook") or "").strip().rstrip(".!"), str(got.get("thumb") or "").strip().rstrip(".!")
        if 0 < len(hook.split()) <= 9 and len(hook) <= 64:
            v["hook"] = hook
        if 0 < len(thumb.split()) <= 4 and len(thumb) <= 30:
            v["thumb"] = thumb
    PLAN_FILE.write_text(json.dumps(plan_, ensure_ascii=False, indent=1), encoding="utf-8")
    return plan_


# ---------- build ----------

WINDOWS_FILE = DATA / "vlog-windows.json"  # {clip path: [[start, end, slug], ...]}: the moments each video shows
BRIDGE = {"documentary": 0.6, "cinematic": 0.9, "journal": 0.6, "retro": 0.4, "fieldguide": 0.6, "monochrome": 0.8, "slow": 1.2,
          "roadmovie": 0.5, "energetic": 0.0}  # seconds the next shot's sound leads its picture (and the last one's trails it)


def windows() -> dict:
    try:
        return json.loads(WINDOWS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _bridge(src: Path, start: float, sec: float, lead: float, dest: Path) -> dict | None:
    """The clip's own sound from `lead` s before its picture to `lead` s after (a J and an L cut): the next place is heard
    before it is seen and the last one fades under it. None when the clip has no sound or ffmpeg fails."""
    a = max(0.0, start - lead)
    try:
        if not dest.exists():
            subprocess.run([str(ffmpeg_bin()), "-y", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", str(src), "-t", f"{sec + (start - a) + lead:.3f}",
                            "-vn", "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", str(dest)], check=True, capture_output=True, timeout=120)
    except Exception:
        dest.unlink(missing_ok=True)
        return None
    return {"lead": round(start - a, 3), "tail": lead}


def _part_span(s: dict) -> tuple[float, float] | None:
    """(start, end) seconds of the stretch of its clip a moment comes from, when the clip gives several (shot["part"])."""
    part, dur = s.get("part"), float(s.get("duration") or 0)
    if not part or part[1] < 2 or dur <= 0:
        return None
    seg = dur / part[1]
    return round(part[0] * seg, 2), round((part[0] + 1) * seg, 2)


CLEAN_V = "1"  # bump when studio.quality.cleanup changes: cleaned shot files are named by it


def _speech_in(src: Path, start: float, sec: float, duration=None) -> bool | None:
    """Does someone speak in this stretch of the clip? From studio.speech's cache only (a build transcribes its clips
    anyway): True / False, or None when the clip was never transcribed (then it is cleaned, never turned down)."""
    from studio import speech

    hit = speech.CACHE / f"{speech._key(src, duration)}.json"
    if not hit.exists():
        return None
    try:
        segs = json.loads(hit.read_text(encoding="utf-8")).get("segments") or []
    except ValueError:
        return None
    return any(float(g.get("end", 0)) > start and float(g.get("start", 0)) < start + sec and str(g.get("text", "")).strip() for g in segs)


def _render_one(job: tuple) -> dict:
    """One shot to 1920x1080 with the studio's grade (+ colour match, + steadying when it shakes). A clip takes its best
    moment that no other video of the plan shows (vlog-windows.json), and gets its sound with a lead-in and a tail."""
    from studio.pick import best_window
    from studio.shot import PHOTO_EXT, color_correction, has_vidstab, is_drone, probe_window, render_shot, stab_decision, stab_transforms

    k, s, out, target, *rest = job
    grade = rest[0] if rest else ""
    avoid = rest[1] if len(rest) > 1 else []
    lead = rest[2] if len(rest) > 2 else 0.0
    src = Path(s["path"])
    photo = src.suffix.lower() in PHOTO_EXT
    start = 0.0
    seg = _part_span(s)
    if seg:  # one of several moments of this clip in the film: it looks only in its own stretch of the clip
        dur = float(s.get("duration") or 0)
        avoid = [*avoid, *([(0.0, seg[0])] if seg[0] > 0 else []), *([(seg[1], dur)] if seg[1] < dur else [])]
    if not photo:
        try:
            w = best_window(src, s["sec"], avoid=avoid)
            start = float(w["start"])
            if abs(start - float(w.get("free", start))) > 0.01:  # a different moment from the one this file name was first made for
                out = out.with_name(f"{out.stem}_w{int(round(start * 10))}{out.suffix}")
        except Exception:
            a, b = seg or (0.0, float(s.get("duration") or s["sec"]))
            start = max(0.0, a + (b - a - s["sec"]) / 2)
    color, stab = "", None
    if not s.get("is360"):
        probe = probe_window(src, start, s["sec"], photo=photo)
        if target and probe.get("color"):
            color = color_correction(probe["color"], target).get("filter", "")
        on, _ = stab_decision("auto", probe.get("shake"), photo=photo, drone=is_drone(src), vidstab=has_vidstab())
        if on:
            try:
                stab = stab_transforms(src, start, s["sec"])
            except Exception:
                stab = None
    color = ",".join(x for x in (color, grade) if x)
    if not out.exists():
        render_shot(src, start, s["sec"], out, SIZE, keep_audio=True, color=color, stab=stab, natural=True)
    vol = _clip_volume(out)
    clean = None
    if not photo and vol:
        # Wind (owner, 13 Nov: "the wind audio is really bad we hate it"): measured on this shot's own sound; a windy
        # stretch with nobody speaking is turned right down, with speech it is cleaned, calm sound loses its rumble.
        from studio import quality

        try:
            how = quality.cleanup(quality.wind_of(quality.audio_of(out)), _speech_in(src, start, s["sec"], s.get("duration")))
            cleaned = out.with_name(f"{out.stem}_{how['tag']}{CLEAN_V}{out.suffix}")
            quality.apply_cleanup(out, cleaned, how)
            out, clean = cleaned, how
        except Exception as exc:  # noqa: BLE001 - the shot keeps its sound as rendered; said in the build's log
            print(f"sound cleanup skipped for {src.name}: {exc}", flush=True)
    bridge = None
    if not photo and vol and lead > 0 and (clean is None or clean["gain"] >= 1.0):  # no wind carried across a cut
        if clean:
            raw_bridge = out.with_name(out.stem + ".raw.m4a")
            bridge = _bridge(src, start, s["sec"], lead, raw_bridge)
            if bridge:
                from studio import quality

                quality.apply_cleanup(raw_bridge, out.with_suffix(".m4a"), clean, video=False)
        else:
            bridge = _bridge(src, start, s["sec"], lead, out.with_suffix(".m4a"))
    return {"k": k, "start": start, "volume": vol, "out": out, "bridge": bridge, "clean": clean}


def _clip_volume(path: Path) -> float:
    """1.0 when the clip has sound worth hearing, 0 when it is silent (so the music carries it)."""
    err = subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0?", "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120).stderr
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", err)
    return 0.0 if not m or float(m.group(1)) < -50 else 1.0


def _targets(shots: list[dict]) -> dict | None:
    from studio.shot import PHOTO_EXT, match_target, probe_window

    stats = []
    for s in shots[:: max(1, len(shots) // 40)]:
        src = Path(s["path"])
        if s.get("is360"):
            continue
        photo = src.suffix.lower() in PHOTO_EXT
        stats.append(probe_window(src, 0.0 if photo else max(0.0, float(s.get("duration") or 0) / 2 - 1), min(2.0, s["sec"]), photo=photo).get("color"))
    return match_target(stats)


def _remotion(props: Path, out: Path, log: Path) -> None:
    npx = shutil.which("npx") or "npx"
    # Fewer render tabs on a computer short of memory (13 Nov: two builds at once ran it out): STUDIO_VLOG_CONCURRENCY.
    conc = os.environ.get("STUDIO_VLOG_CONCURRENCY", "8")
    conc = conc if conc.isdigit() and 1 <= int(conc) <= 16 else "8"
    cmd = [npx, "remotion", "render", "src/index.ts", "Vlog-16x9", str(out), f"--props={props}", f"--concurrency={conc}", "--timeout=120000"]
    with log.open("w", encoding="utf-8") as h:
        proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        for line in proc.stdout:
            h.write(line)
            hit = re.search(r"Rendered (\d+)/(\d+)", line)
            if hit and int(hit.group(1)) % 300 == 0:
                print(f"PROGRESS {hit.group(1)}/{hit.group(2)} rendering", flush=True)
        if proc.wait(timeout=3 * 3600) or not out.exists():
            raise RuntimeError(f"Remotion stopped; see {log}")


BED_EQ = "highpass=f=70:poles=2,equalizer=f=120:t=q:w=1.2:g=-5"  # music_beds: no sub-bass rumble under the film
MOODS = ["dawn on the open plains: warm, spacious, hopeful", "on the move through wild country: steady, adventurous, curious",
         "golden evening light and quiet: gentle, reflective, grateful"]


def _audio_sec(path: Path) -> float:
    try:
        import soundfile

        return float(soundfile.info(str(path)).duration)
    except Exception:  # noqa: BLE001 - an mp3 libsndfile cannot read: ask ffmpeg
        err = subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


def _free_music(need: float) -> list[dict]:
    """Free CC0 / public-domain tracks (studio.sound's library, fetched from Openverse when it holds too little) for
    `need` seconds, longest first. Each carries its own credit line."""
    from studio import sound

    def have() -> list[dict]:
        return sorted([t for t in sound.library() if t["kind"] == "music" and t.get("license") in ("CC0", "PDM") and not t.get("ai")],
                      key=lambda t: -float(t.get("duration") or 0))
    tracks = have()
    if sum(float(t.get("duration") or 0) for t in tracks) < need:
        for q in ("acoustic guitar", "ambient cinematic", "calm piano", "kalimba"):
            try:
                sound.fetch("music", q, n=6)
            except Exception as exc:  # noqa: BLE001 - offline: use what there is
                print(f"music: could not fetch free tracks ({exc})", flush=True)
                break
        tracks = have()
    out, got = [], 0.0
    for t in tracks:
        if got >= need:
            break
        out.append(t)
        got += float(t.get("duration") or 0)
    return out


def music_beds(slug: str, seconds: float, moods: list[str] | None = None) -> Path | None:
    """One bed that covers all `seconds`: Stable Audio pieces (one per third of the video) inside the AI limits; when
    the limits stop that, the pieces this video already paid for in earlier builds; then free CC0 tracks; repeated
    only as a last resort. Crossfaded. Writes bed.json (every piece and its credit) next to bed.wav.
    A trip series went out with no music (13 Nov): each episode had used its $2 AI limit on earlier beds, the
    first new piece was refused, and the film was built silent under its own wind."""
    from studio import ai

    parts = max(1, min(3, math.ceil(seconds / 175)))
    each = min(180, math.ceil(seconds / parts) + 6)
    files: list[Path] = []
    credits: list[dict] = []
    if ai.status().get("ready"):
        files = _ai_pieces(slug, parts, each, moods)
        credits = [{"file": str(f), "credit": "AI-generated (Stable Audio 2.5, via fal.ai)", "license": "AI-GENERATED"} for f in files]
    total = lambda: sum(_audio_sec(f) for f in files) - 6 * max(0, len(files) - 1)  # noqa: E731 - crossfades overlap
    if total() < seconds:
        for f in sorted((OUT / slug / "music").glob(f"vlog_{slug}_*.wav"), key=lambda p: p.stat().st_mtime, reverse=True):
            if f not in files and _audio_sec(f) > 20:
                files.append(f)
                credits.append({"file": str(f), "credit": "AI-generated (Stable Audio 2.5, via fal.ai), made for an earlier cut", "license": "AI-GENERATED"})
            if total() >= seconds:
                break
    if total() < seconds:
        for t in _free_music(seconds - max(0.0, total())):
            files.append(Path(t["file"]))
            credits.append({"file": t["file"], "credit": t.get("attribution") or f"\"{t.get('title')}\" by {t.get('creator')} ({t.get('license')})",
                            "license": t.get("license"), "landing": t.get("landing")})
    if not files:
        return None
    base = list(files)
    while total() < seconds and len(files) < 40:  # last resort: the same pieces again, crossfaded
        files.append(base[len(files) % len(base)])
    bed = OUT / slug / "music" / "bed.wav"
    bed.parent.mkdir(parents=True, exist_ok=True)
    (bed.parent / "bed.json").write_text(json.dumps({"seconds": round(seconds, 1), "pieces": credits}, ensure_ascii=False, indent=1), encoding="utf-8")
    cmd = [str(ffmpeg_bin()), "-y", "-hide_banner", "-loglevel", "error"]
    for f in files:
        cmd += ["-i", str(f)]
    graph = [f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo[s{k}]" for k in range(len(files))]
    last = "[s0]"
    for k in range(1, len(files)):
        graph.append(f"{last}[s{k}]acrossfade=d=6:c1=tri:c2=tri[x{k}]")
        last = f"[x{k}]"
    # The low end tamed: Stable Audio's "documentary score" pieces carried 80-97 % of their energy under 150 Hz, a
    # sub-bass drone that reads as rumble under the whole film (measured 13 Nov). Under 70 Hz goes; 120 Hz dips 5 dB.
    graph.append(f"{last}{BED_EQ}[bed]")
    cmd += ["-filter_complex", ";".join(graph), "-map", "[bed]", str(bed)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=900)
    return bed


def _ai_pieces(slug: str, parts: int, each: int, moods: list[str] | None) -> list[Path]:
    """Up to `parts` Stable Audio pieces of `each` seconds, made inside the AI limits (a refused one stops the rest)."""
    from studio import ai

    price = ai.fal_prices([ai.TOOLS["music"][1]]).get(ai.TOOLS["music"][1]) or {"unit_price": 0.2, "unit": "audios"}
    files = []
    for k in range(parts):
        prompt = (f"Instrumental, {moods[k % len(moods)]}. Clean mix, no vocals, no singing, no speech.") if moods else (f"Instrumental travel film score, {MOODS[k % len(MOODS)]}. Acoustic guitar, kalimba, soft hand percussion and "
                  "warm strings, light and natural, a documentary about wildlife in East Africa. Clean mix, no vocals, no singing, no speech.")
        name = f"vlog_{slug}_{k}_{hashlib.sha1((prompt + str(each)).encode()).hexdigest()[:8]}.wav"
        dest = OUT / slug / "music" / name
        if not dest.exists():
            usd = round(price["unit_price"] * ai.quantity(price["unit"], seconds=each), 4)
            why = ai.over_caps(slug, usd, ai.spent(slug))
            if why:
                print(f"music: {why}", flush=True)
                break

            def call(prompt=prompt, dest=dest):
                out = ai.fal_run(ai.TOOLS["music"][1], {"prompt": prompt, "seconds_total": each, "num_inference_steps": 8})
                return {"file": str(ai.download((out.get("audio") or {}).get("url") or "", dest))}, None

            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                ai.charge("fal", ai.TOOLS["music"][1], "music", slug, usd, call, note=f"vlog bed {k + 1}/{parts}, {each}s")
            except Exception as exc:  # noqa: BLE001 - a failed call: the earlier pieces and free music fill in
                print(f"music: Stable Audio failed ({exc})", flush=True)
                break
        files.append(dest)
    return files


def _stamp(sec: float) -> str:
    s = int(round(sec))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


LINK_KEYS = ("prev", "next", "playlist")


def fill_links(text: str, links: dict) -> str:
    """A series description with its links: each {prev}, {next}, {playlist} becomes its URL; a line whose link is not
    known yet (the next part is not uploaded, no playlist yet) is left out, never shown with a placeholder."""
    out = []
    for line in text.split("\n"):
        keys = [k for k in LINK_KEYS if "{" + k + "}" in line]
        if any(not links.get(k) for k in keys):
            continue
        for k in keys:
            line = line.replace("{" + k + "}", str(links[k]))
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _series_text(video: dict, chapters: list[dict], total: float, name: str, story: dict) -> dict:
    """A series episode's YouTube text: a one-line hook, where it sits in the series with {prev}/{next}/{playlist}
    placeholders (fill_links fills them once the parts are on YouTube), where and when (day, date, place, country),
    chapters named by what they show (0:00 is the cold open's moment, the last one the next part) and the credits."""
    ser, N = video["series"], video["series"]["of"]
    n = ser["n"]
    titles = story.get("titles") or {}
    route = story.get("route") or {}
    cold = story.get("cold") or "The best of it"
    marks = [{"at": 0.0, "title": f"{cold} (cold open)" if n == 1 else f"{cold}, then the story so far"}]
    for c in chapters:
        r = route.get(c["day"]) or {}
        where = ", ".join(x for x in (r.get("place") or c.get("place"), r.get("country")) if x)
        label = f"Day {c['dayNo']}{' · ' + where if where else ''}: {c['title']}"
        if c["atSec"] - marks[-1]["at"] >= 10 and total - c["atSec"] >= 10:
            marks.append({"at": c["atSec"], "title": label})
        elif len(marks) == 1:
            # The first chapter starts inside YouTube's 10 s minimum after 0:00: the opening mark carries its name, so
            # the story's first chapter is still listed (13 Nov: Part 1's Day 1 lions were folded into "cold open").
            marks[0]["title"] = label
    end = story.get("endAt")
    if end is not None and end - marks[-1]["at"] >= 10 and total - end >= 10:
        marks.append({"at": end, "title": f"Next: Part {n + 1}" if n < N else "Watch the series from Part 1"})
    lines = "\n".join(f"{_stamp(m['at'])} {m['title']}" for m in marks)
    things = sorted({w for c in chapters for w in c["title"].split(" & ") if w != "On the road"})
    hook = video.get("summary") or (f"{video['hook']}." if video.get("hook") else f"What you will see: {', '.join(things[:8]).lower() if things else 'the road'}.")
    links = [f"Part {n} of {N} · {name} series"]
    if n > 1:
        links.append(f"◀ Previous: Part {n - 1} – {titles.get(n - 1, '')}  {{prev}}".replace(" –   ", "  "))
    if n < N:
        links.append(f"▶ Next: Part {n + 1} – {titles.get(n + 1, '')}  {{next}}".replace(" –   ", "  "))
    links.append("☰ Whole series, in order: {playlist}")
    when = []
    for d in dict.fromkeys(c["day"] for c in chapters):
        c = next(x for x in chapters if x["day"] == d)
        r = route.get(d) or {}
        where = ", ".join(x for x in (r.get("place") or c.get("place"), r.get("country")) if x)
        when.append(f"Day {c['dayNo']} · {datetime.fromisoformat(d):%a %d %b %Y}{' · ' + where if where else ''}")
        if r.get("timeline"):  # from Google Maps Timeline: how we got there, how long we stayed (names: the person's)
            from studio.timeline import stay_words

            for s in r.get("stops") or []:
                if s.get("place"):
                    when.append(f"   {(s['leg'] + ' → ') if s.get('leg') else ''}{s['place']}{' · ' + stay_words(s['stay']) if s.get('stay') else ''}")
    music = _music_line(video)
    wild = _wildlife_line(video)
    desc = (f"{hook}\n\n" + "\n".join(links) + "\n\nWhere and when\n" + "\n".join(when) + (f"\n\n{wild}" if wild else "") + f"\n\nChapters\n{lines}\n\n"
            f"Filmed on our own phones and cameras. {music} Map data: Natural Earth.")
    tags = [name, f"{name} series", "travel vlog", "safari", "East Africa", *[t.lower() for t in things[:10]]]
    # description: ready to paste now (the link lines wait for the links); template: what the link pass fills.
    return {"title": video["title"][:100], "description": fill_links(desc, {}), "template": desc, "chapters": marks, "tags": tags,
            "chaptersValid": len(marks) >= 3 and all(b["at"] - a["at"] >= 10 for a, b in zip(marks, marks[1:])),
            "series": {"n": n, "of": N}}


def _frame_at(shots: list[tuple[float, Path]], t: float, dest: Path) -> Path | None:
    """The frame on screen at `t` s of the film: from the rendered shot that covers it (shots: (start, file))."""
    cur = None
    for start, f in shots:
        if start <= t:
            cur = (start, f)
    if not cur:
        return None
    try:
        subprocess.run([str(ffmpeg_bin()), "-y", "-v", "error", "-ss", f"{max(0.0, t - cur[0]):.2f}", "-i", str(cur[1]), "-frames:v", "1",
                        "-vf", "scale=640:-2", str(dest)], check=True, capture_output=True, timeout=60)
    except Exception:  # noqa: BLE001
        return None
    return dest if dest.exists() else None


def check_captions(props: dict, chapters: list[dict], shots: list[tuple[float, Path]], slug: str, folder: Path, places: list[str],
                   sheets: list[Path] | None = None) -> dict:
    """Every animal label and one-line note checked against the very frame on screen when it shows; every chapter title
    against a contact sheet of its whole chapter (`sheets`, one per chapter: a title speaks for minutes, and one frame
    renamed "Lions and a Buffalo Calf" to "Guineafowl in Grass"). By the reviewer's vision model, inside the AI limits.
    A label or note it does not see is dropped; a title that does not read as plain sense, or names a camp or person, is
    replaced by its short fix. Owner, 13 Nov: "some of the captions also doesnt make sense" (Part 2: "Rhinoceros and Acacia
    Camp Masai Mara", "Antelope" and "Monkeys" labels from a fixed list). No key or over a limit: nothing is changed,
    and the result says the captions were not checked."""
    from studio import ai

    work = folder / "check"
    work.mkdir(parents=True, exist_ok=True)
    claims = []  # (kind, index, text, frame)
    for i, o in enumerate(props.get("overlays") or []):
        if o.get("kind") in ("subject", "note") and o.get("title"):
            text = o["title"] if o["kind"] == "note" else f"{o['title']} (an animal or thing clearly visible in the picture)"
            f = _frame_at(shots, float(o["atSec"]) + min(1.2, float(o.get("sec") or 2) / 2), work / f"o{i}.jpg")
            if f:
                claims.append(("overlay", i, text, f))
    for i, c in enumerate(chapters):
        if c.get("fixed") or not c.get("title"):
            continue
        sheet = sheets[i] if sheets and i < len(sheets) and sheets[i] and Path(sheets[i]).exists() else None
        f = sheet or _frame_at(shots, float(c["atSec"]) + 2.0, work / f"c{i}.jpg")
        if f:
            claims.append(("chapter", i, f"chapter title for this contact sheet of the whole chapter: \"{c['title']}\" (false if it does "
                                         "not read as plain, sensible English, or names a camp, lodge or person)" if sheet else c["title"], f))
    if not claims:
        return {"checked": 0, "dropped": 0, "fixed": 0}
    system = "You check captions against pictures for a documentary editor. Be strict: when unsure, say false. Never invent names."
    verdict: dict = {}
    errors: list[str] = []
    # Batches of 8, each tried twice: one call with 15 pictures came back with no JSON (a thinking model ran out of room).
    for b0 in range(0, len(claims), 8):
        batch = claims[b0:b0 + 8]
        lines = "\n".join(f"{n + 1}. {text}" for n, (_, _, text, _) in enumerate(batch))
        prompt = (f"Each numbered line below goes with the image of the same number, from a wildlife trip film. Places this film "
                  f"really visited: {', '.join(places) or 'not given'}. For each line say whether it is plainly true of its own image: an "
                  "animal or thing it names must be clearly visible (not guessed from a shape far away), and a name of a camp, lodge or "
                  "person that is neither readable in the image nor in the list of places makes the line false. For a false chapter-style "
                  "line give a short replacement (at most 6 words, plain, only what is visible). Lines:\n" + lines +
                  '\nReply with JSON only: {"verdicts": [{"n": 1, "true": true, "fix": ""}, ...]}')
        for attempt in (1, 2):
            try:
                got = ai.vision_json([f for *_, f in batch], system, prompt, slug, purpose="vlog-captions", max_tokens=6000)
                for v in got.get("verdicts") or []:
                    if isinstance(v, dict) and str(v.get("n", "")).isdigit():
                        verdict[b0 + int(v["n"])] = v
                break
            except Exception as err:  # noqa: BLE001 - no key, over a limit, or the model failed
                if attempt == 2 or getattr(err, "code", "") in ("no_key", "over_cap"):
                    errors.append(str(err)[:200])
                    break
    if not verdict:
        print(f"captions not checked: {'; '.join(errors) or 'no answer'}", flush=True)
        return {"checked": 0, "dropped": 0, "fixed": 0, "error": ("; ".join(dict.fromkeys(errors)) or "no answer")[:200]}
    drop, fixed = set(), 0
    for n, (kind, i, text, _) in enumerate(claims, 1):
        v = verdict.get(n)
        if not v or v.get("true") is not False:
            continue
        if kind == "overlay":
            drop.add(i)
        else:
            fix = str(v.get("fix") or "").strip().rstrip(".")[:48]
            chapters[i]["title"] = fix if fix and len(fix.split()) <= 7 else (chapters[i].get("label") or f"Day {chapters[i].get('dayNo', '')}").strip()
            fixed += 1
    props["overlays"] = [o for k, o in enumerate(props.get("overlays") or []) if k not in drop]
    for pc, c in zip(props.get("chapters") or [], chapters):
        pc["title"] = c["title"]
    return {"checked": len(claims), "dropped": len(drop), "fixed": fixed}


def chapter_sfx(chapters: list[dict], end_at: float | None) -> list[dict]:
    """A soft whoosh into each chapter card and a riser into the next-part card: editors mark a change of place with a
    sound as well as a picture (a transition sting). Quieter than a reel's, under a documentary's music. The studio's
    own effects (studio.sound.synth: made from noise and sine waves, no third-party rights)."""
    from studio import sound

    have = {p.stem.replace("synth_", ""): p for p in (sound.LIB / "sfx").glob("synth_*.wav")} if (sound.LIB / "sfx").exists() else {}
    if "whoosh_1" not in have:
        try:
            sound.synth()
        except Exception:  # noqa: BLE001 - no effects: the film is fine without them
            return []
        have = {p.stem.replace("synth_", ""): p for p in (sound.LIB / "sfx").glob("synth_*.wav")}
    out = []
    for k, c in enumerate(chapters):
        w = have.get(f"whoosh_{k % 3 + 1}")
        if w and float(c.get("atSec") or 0) > 1.0:
            out.append({"name": "whoosh", "file": str(w), "at": round(max(0.0, float(c["atSec"]) - 0.45), 2), "gain": 0.22})
    if end_at and have.get("riser"):
        out.append({"name": "riser", "file": str(have["riser"]), "at": round(max(0.0, end_at - 1.2), 2), "gain": 0.2})
    return out


def _music_line(video: dict) -> str:
    """The music credit for the description, from what was really mixed (bed.json): it said "AI-generated" on four
    episodes that had no music at all (13 Nov). Free tracks carry their own attribution lines."""
    f = OUT / str(video.get("slug") or "-") / "music" / "bed.json"
    try:
        pieces = json.loads(f.read_text(encoding="utf-8")).get("pieces") or []
    except (OSError, ValueError):
        pieces = []
    if not pieces:
        return "" if (LOOKS.get(look_of(video.get("look"))) or {"music": True})["music"] else "No music: every sound is the place's own."
    return "Music: " + "; ".join(dict.fromkeys(p["credit"] for p in pieces)) + "."


def _wildlife_line(video: dict) -> str:
    """"Wildlife in this episode: Lion (simba), ..." from the episode's animal labels in props.json (check_captions
    keeps only those a vision model saw in that very frame)."""
    try:
        props = json.loads((OUT / str(video.get("slug") or "-") / "props.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    seen: dict = {}
    for o in props.get("overlays") or []:
        if o.get("kind") == "subject" and o.get("title"):
            seen.setdefault(o["title"], str(o.get("sub") or "").replace(" in Swahili", ""))
    return ("Wildlife in this episode: " + ", ".join(f"{k} ({v})" if v else k for k, v in seen.items()) + ".") if seen else ""


def youtube_text(video: dict, chapters: list[dict], total: float, name: str, story: dict | None = None) -> dict:
    """Title, description with chapters (0:00 first, at least three, each 10 s or longer: YouTube's rule) and tags.
    A series episode (video["series"], with `story`: the other parts' titles, the route, the cold open's moment and
    where the end card starts) gets the series text (_series_text)."""
    if video.get("series") and story is not None:
        return _series_text(video, chapters, total, name, story)
    marks = [{"at": 0.0, "title": "Intro"}]
    for c in chapters:
        if c["atSec"] - marks[-1]["at"] >= 10 and total - c["atSec"] >= 10:
            marks.append({"at": c["atSec"], "title": c["title"] if c.get("fixed") else f"Day {c['dayNo']}{' · ' + c['place'] if c.get('place') else ''}: {c['title']}"})
    lines = "\n".join(f"{_stamp(m['at'])} {m['title']}" for m in marks)
    things = sorted({w for c in chapters for w in c["title"].split(" & ") if w != "On the road"})
    seen = video.get("summary") or f"What you will see: {', '.join(things[:8]).lower() if things else 'the road'}."
    where = list(dict.fromkeys(c["place"] for c in chapters if c.get("place")))
    seen = seen + (f"\n\nWhere: {' · '.join(where)}." if where else "")
    desc = (f"{name}, part {video['n']}: {video['span']}.\n\n{seen}\n\n"
            f"Chapters\n{lines}\n\n"
            "Filmed on our own phones and cameras. " + _music_line(video))
    tags = [name, "travel vlog", "safari", "East Africa", *[t.lower() for t in things[:10]]]
    return {"title": video["title"][:100], "description": desc, "chapters": marks, "tags": tags, "chaptersValid": len(marks) >= 3}


def _wrap(text: str, width: int) -> list[str]:
    """Words into lines of at most `width` characters (a word longer than that keeps its own line)."""
    lines: list[str] = []
    for w in text.split():
        if lines and len(lines[-1]) + 1 + len(w) <= width:
            lines[-1] += " " + w
        else:
            lines.append(w)
    return lines


def _face(name: str) -> str:
    """A Windows system face for a look's thumbnail, or the bundled bold face when this computer has no such file."""
    f = Path("C:/Windows/Fonts") / name
    if not f.exists():
        f = ROOT / "public" / "fonts" / "ShipporiMincho-Bold.ttf"
    return f.as_posix().replace(":", r"\:")


# A thumbnail per look: (face, title case, title colour, kicker text colour, kicker box, extra drawing). Same frame.
THUMB = {
    "cinematic": ("seguisb.ttf", "upper", "0xffffff", "0xf4c66b", None, ["drawbox=y=0:w=iw:h=92:color=black:t=fill", "drawbox=y=ih-92:w=iw:h=92:color=black:t=fill"]),
    "energetic": ("ariblk.ttf", "upper", "0x111111", "0xffffff", "0x111111", []),
    "journal": ("segoepr.ttf", "", "0x2b2a26", "0x9a3324", None, ["drawbox=y=ih*0.52:w=iw:h=ih*0.48:color=0xece3cf@0.93:t=fill"]),
    "monochrome": ("seguisb.ttf", "upper", "0xffffff", "0xffffff", None, ["drawbox=x=28:y=28:w=iw-56:h=ih-56:color=white@0.9:t=3"]),
    "slow": ("seguisb.ttf", "", "0xffffff", "0xcfe3c4", None, []),
    "roadmovie": ("ariblk.ttf", "upper", "0xffffff", "0x111111", "0xff9d2e", []),
    "retro": ("consolab.ttf", "upper", "0xf4efe2", "0xff9d2e", None, ["drawbox=x=0:y=0:w=160:h=ih:color=black:t=fill", "drawbox=x=iw-160:y=0:w=160:h=ih:color=black:t=fill"]),
}


def _thumbnail(master: Path, at: float, title: str, kicker: str, dest: Path, look: str = "") -> None:
    """1280x720: the strongest frame darkening towards the bottom, a gold tag ("PART 1 · HIGHLANDS & COAST") and the
    title in at most two lines of a bold upright face, sized to fit. It has to read at the size YouTube shows it
    (about 320 px wide), so: heavy type, solid contrast, few words. Never cut off at the edge."""
    font = (ROOT / "public" / "fonts" / "ShipporiMincho-Bold.ttf").as_posix().replace(":", r"\:")
    esc = lambda t: t.replace("\\", "").replace("'", "’").replace(":", r"\:").replace("%", r"\%")  # noqa: E731
    lines = _wrap(title, 22)[:2]
    if len(_wrap(title, 22)) > 2:
        lines[-1] = lines[-1].rstrip(".,") + "…"
    size = max(58, min(104, int(1160 / (max(len(x) for x in lines) * 0.56))))
    y0 = 720 - 64 - size * 1.12 * len(lines)
    # A gradient from clear (40% down) to near-black at the bottom, in bands, so the words sit on calm dark ground.
    bands = [f"drawbox=y={288 + 54 * i}:w=iw:h=54:color=black@{0.10 + i * 0.09:.2f}:t=fill" for i in range(8)]  # whole pixels: no seams
    th = THUMB.get(look_of(look))
    if not th:
        parts = ["scale=1280:720", *bands,
                 f"drawtext=fontfile='{font}':text='{esc(kicker.upper())}':x=62:y={int(y0 - 62)}:fontsize=30:fontcolor=0x1d211a:box=1:boxcolor=0xf4c66b:boxborderw=10"]
        for k, line in enumerate(lines):
            parts.append(f"drawtext=fontfile='{font}':text='{esc(line)}':x=60:y={int(y0 + k * size * 1.12)}:fontsize={size}:fontcolor=0xffffff:shadowcolor=black@0.75:shadowx=3:shadowy=3")
    else:
        face, case, colour, kcol, kbox, extra = th
        f = _face(face)
        x0 = 200 if look_of(look) == "retro" else 62
        lines = [ln.upper() if case == "upper" else ln for ln in lines]
        # Each face's average capital (or letter) width, in ems, measured for these fonts: the title fits the frame.
        em = {"ariblk.ttf": 0.84, "consolab.ttf": 0.56, "seguisb.ttf": 0.68, "segoepr.ttf": 0.56}[face]
        room = 1280 - x0 - (200 if look_of(look) == "retro" else 50)
        size = int(min(size, 96, room / (max(len(x) for x in lines) * em)))
        y0 = 720 - (120 if look_of(look) == "cinematic" else 70) - size * 1.15 * len(lines)
        shade = [] if look_of(look) == "journal" else bands
        parts = ["scale=1280:720", *shade, *extra,
                 f"drawtext=fontfile='{f}':text='{esc(kicker.upper())}':x={x0}:y={int(y0 - 60)}:fontsize=30:fontcolor={kcol}"
                 + (f":box=1:boxcolor={kbox}:boxborderw=10" if kbox else ":shadowcolor=black@0.6:shadowx=2:shadowy=2")]
        for k, line in enumerate(lines):
            box = ":box=1:boxcolor=0xffd400:boxborderw=14" if look_of(look) == "energetic" else (":shadowcolor=black@0.75:shadowx=3:shadowy=3" if look_of(look) != "journal" else "")
            parts.append(f"drawtext=fontfile='{f}':text='{esc(line)}':x={x0}:y={int(y0 + k * size * 1.15)}:fontsize={size}:fontcolor={colour}{box}")
    subprocess.run([str(ffmpeg_bin()), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at:.2f}", "-i", str(master), "-frames:v", "1", "-vf", ",".join(parts), str(dest)],
                   check=True, capture_output=True, timeout=120)


THUMB_PHRASE_MIN = 0.33  # CLIP similarity of a picture to "a photo of <words>" that clearly shows them (a dawn plain
# scored 0.32 for "hot air balloon" with no balloon in it)


def thumbnail(n: int) -> Path:
    """Draw part n's thumbnail again from its master (after a change to the title or the drawing)."""
    plan_ = json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    video = next(v for v in plan_["videos"] if v["n"] == n)
    folder = OUT / video["slug"]
    # The picture: a shot that clearly shows an animal (the clearer the better), else the best-looking one, and never
    # one an earlier part's thumbnail shows. Taken from the middle of that shot in the finished film (its real
    # lengths and dissolves, from props.json), so never from a dissolve.
    def shots_of(v: dict) -> list[dict]:
        return [*(v.get("cold") or []), *[x for c in v["chapters"] for x in c["shots"]]]

    seen: set[str] = set()
    want = ""
    try:  # each picture's embedding, to match it against the thumbnail's whole phrase
        from studio.library import _base_items, text_embedding

        embs = {i["path"]: e / (np.linalg.norm(e) + 1e-8) for i, e in _base_items()}
    except Exception:
        embs, text_embedding = {}, None
    phrase: dict = {}

    def match(x: dict) -> float:
        # How well the picture shows the thumbnail's whole phrase ("wildebeest river crossing": the herd in the water,
        # not a herd on a slope that the subject vote also calls wildebeest), as a photo of it. 0 without a phrase.
        e = embs.get(x["path"])
        if not want or e is None or text_embedding is None:
            return 0.0
        if want not in phrase:
            t = text_embedding(f"a photo of {want}")
            phrase[want] = t / (np.linalg.norm(t) + 1e-8)
        return float(e @ phrase[want])

    def says(x: dict) -> bool:
        # The picture shows what the thumbnail's words name ("Wildebeest River Crossing" over wildebeest, not buffalo).
        sub = str(x.get("subject") or "")
        stem = LABEL.get(sub, sub).lower().rstrip("s")[:6]
        return bool(stem) and x.get("clear", 0) >= LABEL_MIN and stem in want

    def rank(x: dict) -> tuple:
        # An animal people come for, clearly shown, and one no earlier part's thumbnail has; never a kill.
        clear = x.get("clear", 0) >= LABEL_MIN and x.get("gap", 0) >= LABEL_GAP
        star = clear and x.get("subject") in THUMB_STARS
        fine = clear and x.get("subject") in LABEL and x.get("subject") not in THUMB_NEVER
        return (says(x), round(match(x), 2) if says(x) or by_phrase else 0, star and x.get("subject") not in seen, star, fine, x.get("subject") not in THUMB_NEVER,
                x.get("clear", 0) if fine else 0, x.get("score", 0))

    taken: set[str] = set()
    best = 0
    by_phrase, shown, subject, alt_words = False, True, "", ""
    for v in sorted(plan_["videos"], key=lambda v: v["n"]):
        c = shots_of(v)
        want = str(v.get("thumb") or "").lower() if not v.get("fixedTitle") else ""
        if v.get("series"):  # a series names its episode itself: the picture shows what its title or thumb words say
            want = str(v.get("thumb") or v.get("episode") or v["title"].split(": ", 1)[-1]).lower()
        # Words that name no animal ("A Hot Air Balloon"): the picture that best shows the phrase, when one clearly does,
        # not the clearest animal (part 10 put "A Hot Air Balloon" over an elephant).
        by_phrase = bool(want) and not any(says(x) for x in c) and max((match(x) for x in c), default=0) >= THUMB_PHRASE_MIN
        order = sorted(range(len(c)), key=lambda k: rank(c[k]), reverse=True)
        pick = next((k for k in order if c[k]["path"] not in taken), order[0] if order else 0)
        if v["n"] == n and want and not by_phrase and not any(says(x) for x in c):
            # Nothing shows the thumbnail's words (part 10: "A Hot Air Balloon", no balloon in its shots): the other half
            # of the title, when a picture shows that ("... and Leopards in the Grass" over a leopard).
            for part_ in [x.strip() for x in re.split(r",| and | & ", video["title"].split(": ", 1)[-1]) if x.strip()]:
                want = part_.lower()
                if any(says(x) for x in c):
                    alt_words = part_
                    order = sorted(range(len(c)), key=lambda k: rank(c[k]), reverse=True)
                    pick = next((k for k in order if c[k]["path"] not in taken), order[0])
                    break
        if c:
            taken.add(c[pick]["path"])
            seen.add(c[pick].get("subject") or "")
        if v["n"] == n:
            best = pick
            shown = bool(c) and (says(c[pick]) or by_phrase or bool(alt_words))  # the picture shows the words
            subject = str(c[pick].get("subject") or "") if c else ""
            break
    title = video["title"].split(": ", 1)[-1] if ": " in video["title"] else video["title"]
    look = video.get("look") or plan_.get("style") or ""
    if video.get("series"):  # the film has "previously" between the cold open and the chapters, and the teaser after
        seqv = _sequence(video)[0]
        best = best + len(video.get("recap") or []) if best >= len(video.get("cold") or []) else best
        secs, fade = [x["sec"] for x in seqv], fade_sec(look)
    else:
        secs, fade = [x["sec"] for x in shots_of(video)], fade_sec(look)
    try:
        props = json.loads((folder / "props.json").read_text(encoding="utf-8"))
        if len(props["shots"]) == len(secs):
            secs, fade = [x["durationSec"] for x in props["shots"]], props.get("fade", 12) / FPS
    except (OSError, ValueError, KeyError):
        pass
    at = sum(secs[:best]) - fade * best + (secs[best] / 2 if secs else 0.8)
    source = folder / "master.mp4"
    try:  # the shot's own clean file (graded, no words on it) when the build left it
        clean = ROOT / "public" / props["shots"][best]["src"]
        if len(props["shots"]) == len(secs) and clean.exists():
            source, at = clean, secs[best] / 2
    except (NameError, KeyError, IndexError):
        pass
    words = video.get("thumb") or _short(title)
    if video.get("series"):
        words = video.get("thumb") or _short(video.get("episode") or title, 5)
    elif video.get("fixedTitle"):  # a film cut by theme carries its own name
        words = MORE_THUMB.get(video.get("look") or "", _short(video.get("card") or title))
    elif words.lower() in {str(v.get("thumb") or "").lower() for v in plan_["videos"] if v["n"] < n}:
        words = _short(title)  # an earlier part's thumbnail already says this: no two thumbnails with the same words
    if not video.get("fixedTitle") and not video.get("series"):
        if alt_words:
            words = _short(alt_words)
        elif not shown and subject in LABEL:  # no part of the title is shown either: name what the picture shows
            words = LABEL[subject]
    ser = video.get("series") or {}
    kicker = f"Part {n} of {ser['of']} · {plan_['name']}" if ser else f"Part {n} · {plan_['name']}"
    dest = folder / "thumbnail.jpg"
    try:
        frame = ROOT / "public" / "mezz" / "thumbs" / f"{hashlib.sha1(str(folder).encode()).hexdigest()[:10]}.jpg"
        frame.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(ffmpeg_bin()), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.2, at):.2f}", "-i", str(source), "-frames:v", "1",
                        "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720", "-q:v", "2", str(frame)], check=True, capture_output=True, timeout=120)
        props = folder / "thumb.json"
        props.write_text(json.dumps({"src": frame.relative_to(ROOT / "public").as_posix(), "title": words, "kicker": kicker,
                                     "look": look_of(look) or "documentary"}, ensure_ascii=False), encoding="utf-8")
        npx = shutil.which("npx") or "npx"
        subprocess.run([npx, "remotion", "still", "src/index.ts", "Vlog-Thumb", str(dest), f"--props={props}", "--image-format=jpeg", "--jpeg-quality=92", "--timeout=120000"],
                       cwd=ROOT, check=True, capture_output=True, timeout=600)
    except (subprocess.SubprocessError, OSError) as err:
        print(f"thumbnail: the designed one failed ({str(err)[:160]}); drawing the plain one", flush=True)
        _thumbnail(source, max(0.2, at), words, kicker, dest, look=look)
    return dest


def _short(title: str, most: int = 4) -> str:
    """A title cut to the few words a thumbnail can carry: whole words, and never ending on a joining word."""
    words = title.replace(":", "").split()[:most]
    while len(words) > 1 and words[-1].lower() in {"and", "of", "the", "a", "an", "to", "in", "on", "at", "over", "with", "from", "&"}:
        words.pop()
    return " ".join(words)

def speech_hint() -> str:
    """Words a guide on this trip is likely to say: its places and the animals, for the speech model's spelling."""
    extra = "hartebeest, topi, impala, Thomson's gazelle, eland, dik-dik, kopje, acacia, migration, game drive"
    return ", ".join([*trip()["places"].values(), *sorted(set(LABEL.values())), extra])


def _subtitles(jobs: list, done: dict, starts: list[float], cold_len: int, folder: Path, end: int | None = None) -> dict:
    """What people say in the clips the edit keeps the sound of, as subtitles.srt (for YouTube's CC). Local, free;
    skipped when faster-whisper is not installed. Only shots cold_len..end (the chapters) carry their sound."""
    try:
        from studio import speech
    except Exception:
        return {"cues": 0}
    placed = []
    for k, (_, s, *_) in enumerate(jobs):
        if k < cold_len or (end is not None and k >= end) or s["kind"] != "video" or not done[k].get("volume"):
            continue
        try:
            placed.append({"at": starts[k], "from": float(done[k]["start"]), "sec": s["sec"], "speech": speech.transcribe(Path(s["path"]), s.get("duration"), speech_hint())})
        except Exception as err:  # one unreadable clip never stops the build
            print(f"speech {Path(s['path']).name}: {err}", flush=True)
    cs = speech.cues(placed)
    dest = folder / "subtitles.srt"
    if cs:
        dest.write_text(speech.srt(cs), encoding="utf-8")
    else:
        dest.unlink(missing_ok=True)
    return {"cues": len(cs), "file": str(dest) if cs else None}


def _beats(bed: Path) -> list[float]:
    """Beat times (seconds) of a music bed (librosa)."""
    try:
        import librosa

        y, sr = librosa.load(str(bed), sr=22050, mono=True, duration=900)
        _, frames = librosa.beat.beat_track(y=y, sr=sr)
        return [float(x) for x in librosa.frames_to_time(frames, sr=sr)]
    except Exception as err:  # no beat found: the cut keeps its own lengths
        print(f"beats: {err}", flush=True)
        return []


def _on_beats(seq: list[dict], beats: list[float]) -> list[dict]:
    """Shot lengths moved onto the beat: each shot starts on a beat and lasts whole beats (2 for a photo; for a clip,
    as many as its planned length holds, 2 to 7, never more than the clip itself has; 3 for a photo)."""
    step = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
    if beats and beats[0] > 0.05:
        beats = [0.0, *beats]  # the film starts at 0: count beats from there, so "3 beats" is 3 beats
    at = lambda i: beats[i] if i < len(beats) else beats[-1] + (i - len(beats) + 1) * step  # noqa: E731
    out, i, t = [], 0, 0.0
    for s in seq:
        n = 3 if s["kind"] != "video" else int(min(7, max(2, round(s["sec"] / step))))
        if s["kind"] == "video" and s.get("duration"):
            while n > 1 and at(i + n) - t > float(s["duration"]) - 0.2:
                n -= 1
        end = at(i + n)
        out.append({**s, "sec": round(end - t, 3)})
        t, i = end, i + n
    return out


def background_priority() -> None:
    """A long build runs below the studio itself (and every ffmpeg / Remotion it starts inherits that), so the
    studio's pages stay quick while a 10-minute video renders. Best effort."""
    try:
        if os.name == "nt":
            import ctypes

            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL
        else:
            os.nice(10)
    except Exception:
        pass


def _sequence(video: dict) -> tuple[list[dict], list[str]]:
    """The shots in film order and what each one is: "cold" (the cold open), "recap" (a series' "previously"), "body"
    (the chapters) and "teaser" (under a series' next-part card)."""
    ser = bool(video.get("series"))
    cold, body = video.get("cold") or [], [s for c in video["chapters"] for s in c["shots"]]
    recap, teaser = (video.get("recap") or [], video.get("teaser") or []) if ser else ([], [])
    return [*cold, *recap, *body, *teaser], ["cold"] * len(cold) + ["recap"] * len(recap) + ["body"] * len(body) + ["teaser"] * len(teaser)


def _film_seconds(video: dict, look: str) -> float:
    seq, _ = _sequence(video)
    return sum(s["sec"] for s in seq) - fade_sec(look) * max(0, len(seq) - 1)


def length_fit(video: dict, look: str, target: float, band: float) -> dict:
    """Before rendering, bring a series episode within target +- band seconds: too long, the lowest-scoring shots go
    (never a chapter's first, never below three shots a chapter); too short, the best clips hold longer (up to 20 s,
    never more than their stretch of the clip has). Changes `video` in place; returns {"seconds", "trimmed", "held",
    "lengthOk"}."""
    est, trimmed, held = _film_seconds(video, look), 0, 0
    if est > target + band:
        cands = sorted(((s["score"], ci, si) for ci, c in enumerate(video["chapters"]) for si, s in enumerate(c["shots"]) if si > 0),
                       key=lambda x: x[0])
        gone: set = set()
        for _, ci, si in cands:
            if est <= target:
                break
            c = video["chapters"][ci]
            if len(c["shots"]) - sum(1 for g in gone if g[0] == ci) <= 3:
                continue
            gone.add((ci, si))
            est -= c["shots"][si]["sec"] - fade_sec(look)
            trimmed += 1
        for ci, c in enumerate(video["chapters"]):
            c["shots"] = [s for si, s in enumerate(c["shots"]) if (ci, si) not in gone]
    elif est < target - band:
        clips = sorted((s for c in video["chapters"] for s in c["shots"] if s["kind"] == "video"), key=lambda s: -s["score"])
        for s in clips:
            if est >= target:
                break
            seg = _part_span(s)
            room = min(20.0, ((seg[1] - seg[0]) if seg else float(s.get("duration") or 0)) - 0.3) - s["sec"]
            if room > 0.5:
                more = min(room, target - est)
                s["sec"] = round(s["sec"] + more, 2)
                est += more
                held += 1
    return {"seconds": round(est, 2), "trimmed": trimmed, "held": held, "lengthOk": abs(est - target) <= band}


def _place_lines(chapters: list[dict], route: dict, show_place: bool) -> list[dict]:
    """A series' place tag per chapter (src/Vlog.tsx PlaceTag): the route's place and country for its day, and the
    border crossed when the country changes from the chapter before ("KENYA → TANZANIA")."""
    out, last = [], None
    for c in chapters:
        r = route.get(c["day"]) or {}
        country = r.get("country") or ""
        first = (r.get("stops") or [{}])[0].get("country") or country
        before = last if last is not None else first
        border = f"{before} → {country}".upper() if before and country and before != country else ""
        out.append({"place": (r.get("place") or c.get("place")) if show_place else None, "country": country or None, "border": border or None})
        last = country or last
    return out


def _short_span(a: str, b: str) -> str:
    fa, fb = datetime.fromisoformat(a), datetime.fromisoformat(b)
    if a == b:
        return f"{fa.day} {fa:%b %Y}"
    return f"{fa.day}–{fb.day} {fb:%b %Y}" if fa.month == fb.month else f"{fa.day} {fa:%b} – {fb.day} {fb:%b %Y}"


def series_props(video: dict, plan_: dict, tp: dict, chapters: list[dict], show_place: bool, recap: dict | None, end_at: float | None) -> dict:
    """What a series episode adds to the film's props (src/Vlog.tsx): its place in the series and the title card's
    kicker ("PART 2 OF 4 · DAY 3 · 15 SEP 2026"), the whole route for the maps with this episode's leg, a place tag per
    chapter (place, country, the border when it changes), "previously" with the legs before, and the next-part card
    (its leg and title; the last part points back to Part 1)."""
    ser = video["series"]
    n, N = ser["n"], ser["of"]
    route = tp.get("route") or {}
    vids = {v["n"]: v for v in plan_["videos"]}
    nos = {c["day"]: c["dayNo"] for v in plan_["videos"] for c in v["chapters"]}
    d0, d1 = video["days"][0], video["days"][-1]
    days = f"Day {nos.get(d0, '')}" if d0 == d1 else f"Days {nos.get(d0, '')}–{nos.get(d1, '')}"
    nxt = vids.get(n + 1) if n < N else vids.get(1)
    lines = _place_lines(chapters, route, show_place)
    keep = ("place", "country", "lat", "lon", "by", "stop")
    return {
        "series": {"n": n, "of": N, "name": plan_["name"], "episode": video.get("episode") or video["title"].split(": ", 1)[-1],
                   "kicker": f"Part {n} of {N} · {days} · {_short_span(d0, d1)}", "dayOf": plan_.get("dayOf")},
        "route": [{"day": d, **{k: r[k] for k in ("place", "country", "lat", "lon")}, "stops": [{k: s[k] for k in keep if k in s} for s in r.get("stops") or []]}
                  for d, r in sorted(route.items())],
        **({"origin": {k: tp["origin"][k] for k in ("place", "country", "lat", "lon")}} if tp.get("origin") else {}),
        "leg": list(video["days"]),
        "titleSec": SERIES_TITLE,
        "chapters": [{"title": c["title"], "sub": c["sub"], "atSec": c["atSec"], "day": c["day"],
                      **{k: v for k, v in ln.items() if v}} for c, ln in zip(chapters, lines)],
        **({"recap": {**recap, "leg": [d for v in plan_["videos"] if v["n"] < n for d in v["days"]]}} if recap else {}),
        **({"next": {"atSec": end_at, "n": nxt["n"], "of": N, "first": n == N, "leg": list(nxt["days"]),
                     "title": nxt.get("episode") or nxt["title"].split(": ", 1)[-1]}} if nxt and end_at is not None else {}),
    }


def build(n: int, music: bool = True, workers: int = 6) -> dict:
    """Render video `n` of the plan: master.mp4 (with sound and music), youtube.json, description.txt, thumbnail.jpg.
    A series episode also gets its maps, "previously", the next-part card and a length check (length_fit)."""
    from studio import sound, verify

    background_priority()
    plan_ = json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    video = next(v for v in plan_["videos"] if v["n"] == n)
    slug = video["slug"]
    folder = OUT / slug
    folder.mkdir(parents=True, exist_ok=True)
    mezz = ROOT / "public" / "mezz" / f"vlog-{hashlib.sha1(str(DATA).encode()).hexdigest()[:6]}-{slug}"
    mezz.mkdir(parents=True, exist_ok=True)
    held = private_paths()
    if held:  # a plan made before the hold-back, or before a picture was found private: those shots come out here
        for k in ("cold", "recap", "teaser"):
            video[k] = [s for s in video.get(k) or [] if s["path"] not in held]
        for c in video["chapters"]:
            c["shots"] = [s for s in c["shots"] if s["path"] not in held]
        video["chapters"] = [c for c in video["chapters"] if c["shots"]]
    # A plan made before the quality scan: its blurry and too-shaky pictures come out here too (studio.quality).
    from studio.library import _base_items

    lib = {i["path"]: i for i, _ in _base_items()}
    shot_lists = [c["shots"] for c in video["chapters"]] + [video.get(k) or [] for k in ("cold", "recap", "teaser")]
    poor = {s["path"] for lst in shot_lists for s in lst if _quality_no(lib.get(s["path"]) or s)}
    if poor:
        print(f"left out {len(poor)} blurry or shaky pictures", flush=True)
        for k in ("cold", "recap", "teaser"):
            video[k] = [s for s in video.get(k) or [] if s["path"] not in poor]
        for c in video["chapters"]:
            c["shots"] = [s for s in c["shots"] if s["path"] not in poor]
        video["chapters"] = [c for c in video["chapters"] if c["shots"]]
    look = look_of(video.get("look") or plan_.get("style")) or "documentary"
    L, fs = LOOKS[look], fade_sec(look)
    ser = video.get("series")
    fitted = None
    if ser:
        sp = plan_.get("series") or {}
        fitted = length_fit(video, look, float(sp.get("target", SERIES_TARGET)) * 60, float(sp.get("band", SERIES_BAND)) * 60)
        print(f"length: {fitted}", flush=True)
    seq, roles = _sequence(video)
    bed = None
    if L.get("beat") and music:
        # Beat-cut: the music is made first, and every cut lands on its beat (2 beats a photo, 2-6 a clip).
        print("STAGE 1/4 music first (the cuts follow its beat)", flush=True)
        bed = music_beds(slug, sum(s["sec"] for s in seq) + 8, L["music"])
        beats = _beats(bed) if bed else []
        if len(beats) > 8:
            seq = _on_beats(seq, beats)
    print(f"STAGE 1/4 {len(seq)} shots to 1920x1080 ({look})", flush=True)
    target = _targets(seq)
    shown = windows()  # moments of each clip the plan's other videos show: this one takes others
    others = lambda p: [(a, b) for a, b, sl in shown.get(p, []) if sl != slug]  # noqa: E731
    lead = BRIDGE.get(look, 0.5)
    # "Previously" and the teaser show another part's moments again on purpose: they take no window of their own.
    name_of = lambda s: s["path"] + str(s["sec"]) + look + MEZZ_V + (str(s["part"]) if s.get("part") else "")  # noqa: E731
    jobs = [(k, s, mezz / f"{k:03d}_{hashlib.sha1(name_of(s).encode()).hexdigest()[:8]}.mp4", target, L["grade"],
             others(s["path"]) if roles[k] in ("cold", "body") else [], lead) for k, s in enumerate(seq)]
    done = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for r in pool.map(_render_one, jobs):
            done[r["k"]] = r
            if len(done) % 10 == 0:
                print(f"PROGRESS {len(done)}/{len(jobs)} shots", flush=True)
    jobs = [(k, s, done[k]["out"], *rest) for k, s, _, *rest in jobs]  # the file each shot was really rendered to
    shown = windows()  # read again just before writing: another build may have added its own
    for p in list(shown):
        shown[p] = [w for w in shown[p] if w[2] != slug]
    for k, s, *_ in jobs:
        if s["kind"] == "video" and roles[k] in ("cold", "body"):
            shown.setdefault(s["path"], []).append([round(done[k]["start"], 2), round(done[k]["start"] + s["sec"], 2), slug])
    WINDOWS_FILE.write_text(json.dumps({p: w for p, w in shown.items() if w}, indent=0), encoding="utf-8")
    shots, chapters, starts, t = [], [], [], 0.0
    first = roles.index("body") if "body" in roles else len(roles)  # the first chapter shot
    end = len(roles) - roles.count("teaser")                        # the first shot under the next-part card
    tp = trip()
    show_place = tp["overlays"].get("places", True)
    title_at = 0.0
    for k, (_, s, out, *_) in enumerate(jobs):
        start = max(0.0, t - fs) if k else 0.0  # where shot k begins: it dissolves in over the previous one (a cut: fs 0)
        starts.append(start)
        if k == (first if ser else len(video["cold"])):
            title_at = start
        ci = None
        if first <= k < end:
            acc = first
            for i, c in enumerate(video["chapters"]):
                if k == acc and c["shots"]:
                    ci = i
                acc += len(c["shots"])
        if ci is not None:
            c = video["chapters"][ci]
            place = c.get("place") if show_place else None
            sw = SWAHILI.get(LABEL.get(c["title"], ""), "") if c.get("fixed") else ""
            when = datetime.fromisoformat(c["day"])
            sub = f"Day {c['dayNo']} of {plan_.get('dayOf') or c['dayNo']} · {when:%a %d %b}" if ser else f"Day {c['dayNo']} · {when:%a %d %b}"
            chapters.append({"title": c["title"], "fixed": bool(c.get("fixed")),
                             "sub": f"{c['label']}{' · ' + sw if sw else ''}" if c.get("label") else sub,
                             "atSec": round(start, 2), "dayNo": c["dayNo"], "day": c["day"], "place": place, "caption": c.get("caption")})
        body = roles[k] == "body"
        br = done[k].get("bridge") if body else None
        shots.append({"src": out.relative_to(ROOT / "public").as_posix(), "durationSec": s["sec"], "photo": s["kind"] != "video",
                      "volume": (done[k]["volume"] * (0.35 if L.get("beat") else 1.0)) if s["kind"] == "video" and body else 0.0,
                      "date": str(s.get("local") or s.get("captured") or "")[:10],
                      **({"audio": out.with_suffix(".m4a").relative_to(ROOT / "public").as_posix(), "audioLead": br["lead"], "audioTail": br["tail"]} if br else {})})
        t = start + s["sec"]
    total = round(t, 2)
    end_at = round(starts[end], 2) if ser and end < len(starts) else None
    recap = {"atSec": round(starts[len(video["cold"])], 2), "sec": round(starts[first] - starts[len(video["cold"])], 2)} if ser and roles.count("recap") else None
    props = {"shots": shots, "chapters": [{"title": c["title"], "sub": c["sub"], "atSec": c["atSec"], **({"place": c["place"]} if c.get("place") else {})} for c in chapters],
             "title": video["card"], "subtitle": video["cardSub"], "titleAtSec": round(title_at, 2), "look": look, "fade": L["fade"],
             **({"hook": video["hook"]} if video.get("hook") else {}),
             "overlays": overlays([j[1] for j in jobs][first:end], starts[first:end], [(c["atSec"], c) for c in chapters], round(t, 2), title_at=round(title_at, 2),
                                  end_quiet=(total - end_at + 1.0) if end_at is not None else 15.0,
                                  title_sec=SERIES_TITLE if ser else 4.5, label_sec=4.5 if ser else 4.2)}
    # Every label, note and chapter title against the frame on screen when it shows (check_captions).
    places = sorted({str(r.get("place")) for r in (tp.get("route") or {}).values() if isinstance(r, dict) and r.get("place")}
                    | {str(c["place"]) for c in chapters if c.get("place")})
    sheets = []  # one contact sheet per chapter, in the order `chapters` was built (each chapter with shots)
    for k, c in enumerate(c for c in video["chapters"] if c["shots"]):
        try:
            sheets.append(_sheet(c["shots"], folder / "check" / f"chapter-{k}.jpg"))
        except Exception:  # noqa: BLE001 - a sheet that cannot be made: that title is checked on one frame
            sheets.append(None)
    captions = check_captions(props, chapters, [(starts[k], j[2]) for k, j in enumerate(jobs)], slug, folder, places,
                              sheets if len(sheets) == len(chapters) else None)
    print(f"captions: {captions}", flush=True)
    if ser:
        props.update(series_props(video, plan_, tp, chapters, show_place, recap, end_at))
    if look == "fieldguide":  # the chapter card already names the animal
        props["overlays"] = [o for o in props["overlays"] if o["kind"] != "subject"]
    (folder / "props.json").write_text(json.dumps(props, ensure_ascii=False, indent=1), encoding="utf-8")
    if L.get("beat"):  # 1-3 s cuts break every sentence: a beat-cut film is carried by its music, not by speech
        (folder / "subtitles.srt").unlink(missing_ok=True)
        subs = {"cues": 0}
    else:
        subs = _subtitles(jobs, done, starts, first, folder, end=end)
    print(f"STAGE 2/4 rendering {total:.0f} s", flush=True)
    raw = folder / "raw.mp4"
    _remotion(folder / "props.json", raw, folder / "render.log")
    print("STAGE 3/4 music and mix", flush=True)
    wants_music = bool(music and L["music"])
    bed = bed or (music_beds(slug, total, video.get("moods") or L["music"]) if wants_music else None)  # a series episode's own mood
    if wants_music and not bed:
        raise RuntimeError(f"{slug}: no music could be made or found (AI limits, no free tracks offline). Nothing was built without "
                           "it; build with --no-music to make a film of the place's own sound on purpose.")
    master = folder / "master.mp4"
    pieces = json.loads((bed.parent / "bed.json").read_text(encoding="utf-8")).get("pieces", []) if bed and (bed.parent / "bed.json").exists() else []
    bed_info = {"file": str(bed), "start": 0.0, "volume": 0.7, "id": bed.name if bed else None, "title": f"Music beds for {slug}",
                "creator": "; ".join(dict.fromkeys(p["credit"] for p in pieces)) or "Stable Audio 2.5 (AI, via fal.ai)",
                "license": "/".join(dict.fromkeys(str(p.get("license")) for p in pieces)) or "AI-GENERATED", "source": "fal.ai / Openverse"} if bed else None
    # The music dips for speech, not for every breeze (windy stretches are already down: studio.quality).
    audio = sound.mix(raw, master, total, bed_info, chapter_sfx(chapters, end_at), peak=-2.5, duck=(0.08, 3.0))  # lands near -1 dBTP after AAC (YouTube re-encodes; headroom avoids clipping)
    print("STAGE 4/4 quality check and YouTube text", flush=True)
    qa = verify.qa(master, "16x9", music=wants_music)  # music asked for and missing is a failed check, not a pass
    # What the film's own checks found: captions against their frames, wind, and what the music is made of.
    cleaned = [d["clean"] for d in done.values() if d.get("clean")]
    quiet = sum(1 for c in cleaned if c["gain"] < 1.0)
    windy_speech = sum(1 for c in cleaned if c["tag"] == "w1")
    qa.setdefault("checks", []).extend([
        {"id": "captions", "level": "ok" if captions.get("checked") else "warn",
         "found": (f"{captions['checked']} labels and titles checked against their frames: {captions['dropped']} dropped, {captions['fixed']} titles fixed"
                   if captions.get("checked") else f"captions not checked ({captions.get('error') or 'nothing to check'})"),
         "fix": "" if captions.get("checked") else "Add an AI key in Settings › Keys & AI (or raise its limit) and build again."},
        {"id": "wind", "level": "ok", "found": f"{len(cleaned)} clips cleaned: {quiet} windy with nobody speaking turned down, {windy_speech} windy under speech cleaned", "fix": ""},
        {"id": "music-source", "level": "ok" if bed else ("bad" if wants_music else "ok"), "found": (bed_info or {}).get("creator") or "no music", "fix": ""},
    ])
    qa["ok"] = qa.get("ok", True) and not any(c.get("level") == "bad" for c in qa["checks"])
    story = None
    if ser:
        cold_path = (video.get("cold") or [{}])[0].get("path")
        peak = next((c for c in video["chapters"] if any(s["path"] == cold_path for s in c["shots"])), video["chapters"][0])
        story = {"titles": {v["n"]: v.get("episode") or v["title"].split(": ", 1)[-1] for v in plan_["videos"]},
                 "route": tp.get("route") or {}, "cold": peak["title"], "endAt": end_at}
    yt = youtube_text(video, chapters, total, plan_["name"], story)
    thumbnail(n)
    (folder / "description.txt").write_text(yt["description"], encoding="utf-8")
    result = {"slug": slug, "master": str(master), "seconds": total, "shots": len(shots), "chapters": yt["chapters"], "youtube": yt, "qa": qa, "subtitles": subs,
              "captions": captions, "sound": {"cleaned": len(cleaned), "quietWind": quiet, "windUnderSpeech": windy_speech},
              "audio": audio, "thumbnail": str(folder / "thumbnail.jpg"), "made": datetime.now().isoformat(timespec="seconds")}
    if ser:  # the length the person set, and whether the film kept to it
        sp = plan_.get("series") or {}
        result.update({"target": float(sp.get("target", SERIES_TARGET)), "band": float(sp.get("band", SERIES_BAND)),
                       "lengthOk": abs(total - float(sp.get("target", SERIES_TARGET)) * 60) <= float(sp.get("band", SERIES_BAND)) * 60,
                       "fit": fitted, "series": ser})
    (folder / "youtube.json").write_text(json.dumps(result, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    raw.unlink(missing_ok=True)
    return result
