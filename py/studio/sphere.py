"""
FILE: py/studio/sphere.py
PURPOSE: 360 footage: tell an equirectangular file from a flat one, and turn it into a flat
         shot with a camera move, the way Insta360 Studio's FreeCapture keyframes do.
OVERVIEW: ffmpeg's v360 filter reprojects the sphere to a normal (rectilinear) view, or to a
          stereographic "tiny planet". Its yaw / pitch / roll / fov are runtime commands, so a
          sendcmd script written here moves the virtual camera every frame with an ease-in-out
          curve: a keyframed move instead of a crop.
          Moves (from Insta360 / Premiere reframing practice; docs/research/2026-11-13-360-moves-and-layers.md):
            pan        - a slow eased pan across the scene (about 70 degrees), horizon level
            reveal     - start looking down, tilt up to the horizon while turning
            planet     - tiny planet: look straight down in stereographic and spin slowly
            unroll     - tiny planet that opens out into the normal view (hook / transition)
            rabbit     - rabbit hole (inverted tiny planet): look straight up, a tunnel of sky
            morph      - the planet turns inside out into the rabbit hole
            crystal    - a normal view that pulls back into a planet (crystal ball zoom-out)
            roll       - barrel roll: the view turns a full circle about the lens
            flip       - horizon flip: the world turns upside down and holds
            drone      - fake drone: a high look down and forward, pushing in slowly
            lookaround - turns to one side, pauses, turns on, pauses (N keyframes)
          Transitions (a shot's head or tail, composed onto its move): whip (a blurred 180-degree
          whip pan), rollx (A rolls out, B rolls in), tilt (down to the ground and up again),
          planetx (A ends as a tiny planet, B starts as one and unrolls).
DEPENDENCIES: ffmpeg with v360 and sendcmd (ffmpeg 5+)
USAGE: is_equirect(w, h, path); chain(move, seconds, (w, h), script, head=, tail=) -> list of
       filter strings; move_for(index, kind, total) and transitions_for(index, total) plan a
       sequence. studio.shot calls these for 360 sources.
NOTES: Insta360 cameras that write one lens per file (VID_..._00_n.insv + VID_..._10_n.insv, X3 /
       ONE RS) are stitched here from the pair: both lenses turned over (hflip,vflip), side by
       side, v360 dual fisheye. The lens field of view (196 / 200 / 204) is picked per camera by
       seam_cost on a still and cached. Without the maker's per-lens calibration the seams at
       +-90 degrees are rough but usable; LRV_ proxies and the _10_ file are not footage items.
       A single-file dual-fisheye .insv / .360 is stitched the same way from its two halves.
"""
from __future__ import annotations

import functools
import json
import math
import re
from pathlib import Path

RAW_360 = {".insv", ".360"}  # dual-fisheye originals (stitched here, roughly: no lens calibration)
PHOTO_360 = {".insp"}       # Insta360 photos: already stitched equirect JPEGs
MOVES = ("pan", "reveal", "planet", "unroll", "rabbit", "morph", "crystal", "roll", "flip", "drone", "lookaround")
SG_MOVES = {"planet", "unroll", "rabbit", "morph", "crystal"}  # rendered stereographic
TRANSITIONS = ("whip", "rollx", "tilt", "planetx")
WHIP_FRAMES = 7  # a whip pan's half: about a quarter second at 30 fps


DFISHEYE_FOV = 200  # Insta360 X-series lenses see a little over a hemisphere each

def dfisheye_pre(turn: tuple[bool, bool] = (True, False)) -> str:
    """Filters that stitch two side-by-side lens circles to equirect. turn = (left, right):
    which circle is upside down. Cameras and firmware differ, so stills test all four."""
    flip = {True: "hflip,vflip", False: "null"}
    return (
        f"split[s360a][s360b];[s360a]crop=iw/2:ih:0:0,{flip[turn[0]]}[s360l];"
        f"[s360b]crop=iw/2:ih:iw/2:0,{flip[turn[1]]}[s360r];"
        f"[s360l][s360r]hstack,v360=input=dfisheye:output=e:ih_fov={DFISHEYE_FOV}:iv_fov={DFISHEYE_FOV}"
    )


DFISHEYE_PRE = dfisheye_pre()  # the X-series video layout: left lens upside down
TURNS = ((True, False), (False, True), (False, False), (True, True))


def seam_cost(pixels) -> float:
    """How badly the two lenses disagree where they meet (yaw +-90 in a stitched equirect).
    The right lens orientation gives the smallest jump across both seams."""
    import numpy as np

    g = np.asarray(pixels, dtype=float)
    h, w = g.shape[:2]
    rows = slice(int(h * 0.2), int(h * 0.8))
    cost = 0.0
    for x in (w // 4, 3 * w // 4):
        cost += float(np.abs(g[rows, x - 3] - g[rows, x + 3]).mean())
    return cost


def best_turn(src: Path) -> tuple[bool, bool]:
    """Stitch a still four ways at low resolution and keep the one whose seams match."""
    import subprocess

    import numpy as np

    from studio.config import ffmpeg_bin

    best, best_cost = TURNS[0], float("inf")
    for turn in TURNS:
        raw = subprocess.run(
            [str(ffmpeg_bin()), "-v", "error", "-i", str(src), "-frames:v", "1",
             "-vf", dfisheye_pre(turn) + ":w=1024:h=512,format=gray", "-f", "rawvideo", "-"],
            capture_output=True, timeout=300,
        ).stdout
        if len(raw) < 1024 * 512:
            continue
        cost = seam_cost(np.frombuffer(raw[: 1024 * 512], dtype=np.uint8).reshape(512, 1024))
        if cost < best_cost:
            best, best_cost = turn, cost
    return best


# ---------- raw pairs: one lens per file ----------

PAIR_NAME = re.compile(r"^(VID_\d{8}_\d{6})_(\d{2})_(\d+)\.insv$", re.I)
PAIR_FOVS = (196, 200, 204)  # lens fields of view tried when a camera is first seen
TRAILER_MAGIC = b"8db42d694ccc418790edff439fe026bf"  # the end of an Insta360 file's metadata trailer


def pair_of(path: Path | str) -> Path | None:
    """The second lens of a one-lens-per-file recording: VID_<date>_<time>_00_<n>.insv ->
    the _10_ file beside it, when it is there. Anything else (a _10_ file, a single-file
    .insv, a proxy) -> None."""
    p = Path(path)
    m = PAIR_NAME.match(p.name)
    if not m or m.group(2) != "00":
        return None
    partner = p.with_name(f"{m.group(1)}_10_{m.group(3)}{p.suffix}")
    return partner if partner.exists() else None


def is_lens_extra(path: Path | str) -> bool:
    """A file the footage library does not list: the low-res LRV_ proxy (.insv) and the second
    lens (_10_) of a pair, which the _00_ item carries."""
    p = Path(path)
    if p.suffix.lower() != ".insv":
        return False
    if p.name.upper().startswith("LRV_"):
        return True
    m = PAIR_NAME.match(p.name)
    return bool(m and m.group(2) == "10")


def pair_pre(fov: float = DFISHEYE_FOV, size: tuple[int, int] | None = None, inputs: tuple[str, str] = ("0:v", "1:v")) -> str:
    """A filter_complex head that stitches a pair to equirect: each lens turned over (both are
    stored upside down and mirrored), side by side (_00_ left), v360 dual fisheye. The result is
    unlabelled, so the caller appends ",<more filters>[out]"."""
    a, b = inputs
    out = f":w={size[0]}:h={size[1]}" if size else ""
    return (
        f"[{a}]hflip,vflip[s360p0];[{b}]hflip,vflip[s360p1];"
        f"[s360p0][s360p1]hstack,v360=input=dfisheye:output=e:ih_fov={fov:g}:iv_fov={fov:g}{out}"
    )


def serial_from_trailer(blob: bytes) -> str | None:
    """The camera serial from the tail of an Insta360 file: its metadata trailer is a protobuf
    whose first field is the serial (field 1, a short upper-case string)."""
    if TRAILER_MAGIC not in blob[-64:]:
        return None
    found = None
    for m in re.finditer(rb"\x0a([\x06-\x20])([A-Z0-9]{6,32})\x12", blob):
        if m.group(1)[0] == len(m.group(2)):
            found = m.group(2).decode("ascii")
    return found


def camera_serial(path: Path) -> str | None:
    """Read only the last 256 KB of the file (a Drive stream file is not fetched whole)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            return serial_from_trailer(f.read())
    except OSError:
        return None


def _pair_still(a: Path, b: Path, fov: float, at: float):
    """One stitched frame of a pair as a 1024 x 512 greyscale array, or None."""
    import subprocess

    import numpy as np

    from studio.config import ffmpeg_bin

    raw = subprocess.run(
        [str(ffmpeg_bin()), "-v", "error", "-ss", f"{at:.2f}", "-i", str(a), "-ss", f"{at:.2f}", "-i", str(b), "-frames:v", "1",
         "-filter_complex", pair_pre(fov, (1024, 512)) + ",format=gray", "-f", "rawvideo", "-"],
        capture_output=True, timeout=300,
    ).stdout
    if len(raw) < 1024 * 512:
        return None
    return np.frombuffer(raw[: 1024 * 512], dtype=np.uint8).reshape(512, 1024)


def best_pair_fov(a: Path, b: Path, at: float = 2.0) -> int:
    """Stitch one frame at each candidate lens field of view; keep the one whose seams meet best."""
    best, best_cost = DFISHEYE_FOV, float("inf")
    for fov in PAIR_FOVS:
        still = _pair_still(a, b, fov, at)
        if still is None and at > 0:
            still = _pair_still(a, b, fov, 0.0)  # a clip shorter than `at`
        if still is None:
            continue
        cost = seam_cost(still)
        if cost < best_cost:
            best, best_cost = fov, cost
    return best


def _fov_cache() -> Path:
    from studio.config import DATA

    return DATA / "keyframes" / "insv_fov.json"  # beside the stitched-still cache


def pair_fov(path: Path) -> int:
    """The stitch field of view for this recording's camera: measured once per camera serial
    (per file when the serial cannot be read) and kept in <data>/keyframes/insv_fov.json."""
    partner = pair_of(path)
    if partner is None:
        return DFISHEYE_FOV
    key = camera_serial(Path(path)) or str(path)
    cache = _fov_cache()
    try:
        known = json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        known = {}
    if not isinstance(known, dict):
        known = {}
    if known.get(key) in PAIR_FOVS:
        return int(known[key])
    try:
        fov = best_pair_fov(Path(path), partner)
    except Exception:  # noqa: BLE001 - no ffmpeg / unreadable: the usual X-series value
        return DFISHEYE_FOV
    known[key] = fov
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(known, indent=1), encoding="utf-8")
    return fov


def is_equirect(width: int | None, height: int | None, path: Path | str | None = None) -> bool:
    """A 2:1 frame of 2000 px or more, an Insta360 photo, or the _00_ lens of a raw pair whose
    _10_ partner is beside it, is a 360 (stitched or not)."""
    if path is not None and Path(path).suffix.lower() in PHOTO_360:
        return True
    if path is not None and pair_of(path) is not None:
        return True
    if not width or not height or width < 2000:
        return False
    return abs(width / height - 2.0) < 0.01


def pan_span(seconds: float) -> float:
    """A calm pan: about 22 degrees a second, never more than 80 (no whip)."""
    return min(80.0, 22.0 * seconds)


def is_tall_pair(width: int, height: int) -> bool:
    """A 1:2 frame of 2000 px or more: a dual-fisheye still stored on its side (Insta360 DNG)."""
    return width >= 2000 and abs(height / width - 2.0) < 0.01


def side_by_side(im):
    """An Insta360 DNG's stacked lenses in the JPEG layout: each lens mirrored, top lens left."""
    from PIL import Image

    w, h = im.size
    top = im.crop((0, 0, w, h // 2)).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    bottom = im.crop((0, h // 2, w, h)).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    out = Image.new("RGB", (w * 2, h // 2))
    out.paste(top, (0, 0))
    out.paste(bottom, (w, 0))
    return out


def skyish(px) -> float:
    """Share of pixels that read as sky: bright, and blue or grey rather than warm.
    A sunlit concrete floor is warm, so it does not count."""
    import numpy as np

    px = np.asarray(px, dtype=float).reshape(-1, 3)
    luma = px.mean(axis=1)
    return float(((luma > 150) & (px[:, 2] >= px[:, 0] - 4)).mean())


def sky_up(rgb) -> float:
    """Sky in the top band minus sky in the bottom band of an equirect (higher is more level)."""
    import numpy as np

    a = np.asarray(rgb, dtype=float)
    band = max(1, a.shape[0] // 4)
    return skyish(a[:band]) - skyish(a[-band:])


# Whole-sphere turns tried when levelling a still: as shot, upside down, and tipped a quarter
# turn each way about both horizontal axes (camera held sideways on a selfie stick).
ORIENTATIONS = ((0, 0), (0, 180), (90, 0), (-90, 0), (0, 90), (0, -90))


def level(src: Path) -> tuple[int, int]:
    """(pitch, roll) that puts the sky on top. Insta360 levels from its gyro track, which is
    not read here; without a clear sky (indoors, night) the still is left as shot."""
    import subprocess

    import numpy as np

    from studio.config import ffmpeg_bin

    scores = {}
    for pitch, roll in ORIENTATIONS:
        raw = subprocess.run(
            [str(ffmpeg_bin()), "-v", "error", "-i", str(src), "-frames:v", "1",
             "-vf", f"v360=input=e:output=e:pitch={pitch}:roll={roll}:w=256:h=128,format=rgb24", "-f", "rawvideo", "-"],
            capture_output=True, timeout=300,
        ).stdout
        if len(raw) >= 256 * 128 * 3:
            scores[(pitch, roll)] = sky_up(np.frombuffer(raw[: 256 * 128 * 3], dtype=np.uint8).reshape(128, 256, 3))
    if not scores:
        return 0, 0
    best = max(scores, key=scores.get)
    return best if scores[best] > 0.3 and scores[best] - scores.get((0, 0), 0) > 0.25 else (0, 0)


def apply_level(src: Path, dest: Path, pitch: int, roll: int) -> Path:
    import subprocess

    from studio.config import ffmpeg_bin

    subprocess.run(
        [str(ffmpeg_bin()), "-v", "error", "-y", "-i", str(src), "-frames:v", "1",
         "-vf", f"v360=input=e:output=e:pitch={pitch}:roll={roll}:interp=lanczos", "-update", "1", str(dest)],
        capture_output=True, timeout=300, check=True,
    )
    return dest


def lens_centre(direction: int, seconds: float) -> float:
    """Where a pan starts on a rough stitch so it stays inside one lens (the seams sit at
    +-90): centred on the front lens going right, on the back lens going left."""
    d = 1 if direction >= 0 else -1
    centre = 0.0 if d > 0 else 180.0
    return centre - d * pan_span(seconds) / 2


def layout_of(pixels) -> str:
    """'dfisheye' when a 2:1 frame is two lens circles (black corners and a black notch
    between the circles), else 'equirect'. `pixels` is a greyscale numpy array, any size."""
    import numpy as np

    g = np.asarray(pixels, dtype=float)
    h, w = g.shape[:2]
    p = max(2, h // 24)
    corners = [g[:p, :p], g[:p, -p:], g[-p:, :p], g[-p:, -p:]]
    notch = [g[:p, w // 2 - p // 2: w // 2 + p // 2 + 1], g[-p:, w // 2 - p // 2: w // 2 + p // 2 + 1]]
    dark = [float(x.mean()) < 18 for x in corners + notch]
    return "dfisheye" if sum(dark) >= 5 else "equirect"


def layout(path: Path) -> str:
    """Read a small greyscale frame of a 360 file and classify it (photos via Pillow, video via ffmpeg)."""
    import numpy as np
    import subprocess

    from studio.config import ffmpeg_bin

    from studio.media import VIDEO

    if path.suffix.lower() in VIDEO:
        raw = subprocess.run(
            [str(ffmpeg_bin()), "-v", "error", "-ss", "1", "-i", str(path), "-frames:v", "1", "-vf", "scale=256:128,format=gray", "-f", "rawvideo", "-"],
            capture_output=True, timeout=120,
        ).stdout
        if len(raw) < 256 * 128:
            return "equirect"
        return layout_of(np.frombuffer(raw[: 256 * 128], dtype=np.uint8).reshape(128, 256))
    from PIL import Image

    with Image.open(path) as im:
        im.draft("L", (512, 256))
        return layout_of(np.asarray(im.convert("L").resize((256, 128))))


def stitch_still(src: Path, dest: Path) -> Path:
    """An unstitched Insta360 photo as an equirect PNG (cached by the caller's dest name)."""
    import subprocess

    from studio.config import ffmpeg_bin

    subprocess.run(
        [str(ffmpeg_bin()), "-v", "error", "-y", "-i", str(src), "-vf", dfisheye_pre(best_turn(src)) + ":w=5760:h=2880", "-frames:v", "1", "-update", "1", str(dest)],
        capture_output=True, timeout=300, check=True,
    )
    return dest


def front_view(src: Path, dest: Path, width: int = 480, at: float = 0.0) -> Path:
    """A level, normal-lens look straight ahead: what the tagger and the thumbnails see."""
    import subprocess

    from studio.config import ffmpeg_bin

    h, v = _fov(width, width * 9 // 16, 70)
    partner = pair_of(src)
    if partner is not None:
        subprocess.run(
            [str(ffmpeg_bin()), "-v", "error", "-y", "-ss", f"{at:.2f}", "-i", str(src), "-ss", f"{at:.2f}", "-i", str(partner), "-frames:v", "1",
             "-filter_complex", pair_pre(pair_fov(src), (2048, 1024)) + f",v360=input=e:output=flat:h_fov={h}:v_fov={v}:w={width}:h={width * 9 // 16}",
             "-update", "1", "-q:v", "4", str(dest)],
            capture_output=True, timeout=300,
        )
        return dest
    pre = DFISHEYE_PRE + "," if layout(src) == "dfisheye" else ""
    subprocess.run(
        [str(ffmpeg_bin()), "-v", "error", "-y", "-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1",
         "-vf", f"{pre}v360=input=e:output=flat:h_fov={h}:v_fov={v}:w={width}:h={width * 9 // 16}", "-update", "1", "-q:v", "4", str(dest)],
        capture_output=True, timeout=300,
    )
    return dest


def wrap(deg: float) -> float:
    """An angle in v360's range, -180..180 (the same view either way round)."""
    return (deg + 180.0) % 360.0 - 180.0


def _ease(u: float) -> float:
    """Smoothstep: the keyframe transition curve, slow at both ends."""
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def _fov(out_w: int, out_h: int, short_fov: float) -> tuple[float, float]:
    """Horizontal and vertical field of view for a rectilinear frame; short_fov is the narrow side."""
    if out_w >= out_h:
        v = short_fov
        h = math.degrees(2 * math.atan(math.tan(math.radians(v) / 2) * out_w / out_h))
    else:
        h = short_fov
        v = math.degrees(2 * math.atan(math.tan(math.radians(h) / 2) * out_h / out_w))
    return round(min(h, 170.0), 2), round(min(v, 170.0), 2)


def _sg_fov(out_w: int, out_h: int, short_fov: float) -> tuple[float, float]:
    """The same for a stereographic frame, whose radius grows with tan(angle / 4)."""
    def wide(f: float, ratio: float) -> float:
        return math.degrees(4 * math.atan(math.tan(math.radians(f) / 4) * ratio))
    if out_w >= out_h:
        return round(min(wide(short_fov, out_w / out_h), 359.0), 2), round(short_fov, 2)
    return round(short_fov, 2), round(min(wide(short_fov, out_h / out_w), 359.0), 2)


def keyframes(move: str, seconds: float, direction: int = 1, yaw0: float = 0.0) -> list[dict]:
    """The virtual camera's keyframes for one shot. Values in degrees. Two keys are the start and
    end; a longer list may give each key "at" (0..1 of the shot) and "ease" (the curve into it:
    "smooth", the default, or "in" / "out" / "linear"). A key equal to the one before is a hold."""
    d = 1 if direction >= 0 else -1
    if move == "reveal":
        return [{"yaw": yaw0, "pitch": -40, "roll": 0, "fov": 90}, {"yaw": yaw0 + 35 * d, "pitch": -4, "roll": 0, "fov": 80}]
    if move == "planet":
        return [{"yaw": yaw0, "pitch": -90, "roll": 0, "fov": 300}, {"yaw": yaw0 + 50 * d, "pitch": -90, "roll": 0, "fov": 270}]
    if move == "unroll":
        return [{"yaw": yaw0, "pitch": -90, "roll": 0, "fov": 300}, {"yaw": yaw0 + 25 * d, "pitch": -8, "roll": 0, "fov": 95}]
    if move == "rabbit":  # inverted tiny planet: straight up, the ground wrapped round the edge
        return [{"yaw": yaw0, "pitch": 90, "roll": 0, "fov": 280}, {"yaw": yaw0 + 45 * d, "pitch": 90, "roll": 0, "fov": 250}]
    if move == "morph":  # planet -> rabbit hole, through the horizon, wide all the way
        return [{"yaw": yaw0, "pitch": -90, "roll": 0, "fov": 300}, {"yaw": yaw0 + 40 * d, "pitch": 90, "roll": 0, "fov": 270}]
    if move == "crystal":  # a normal view that pulls back into a planet
        return [{"yaw": yaw0, "pitch": -5, "roll": 0, "fov": 100}, {"yaw": yaw0 + 30 * d, "pitch": -90, "roll": 0, "fov": 280}]
    if move == "roll":  # barrel roll: once round the lens axis
        return [{"yaw": yaw0, "pitch": -4, "roll": 0, "fov": 85}, {"yaw": yaw0 + 15 * d, "pitch": -4, "roll": 360 * d, "fov": 85}]
    if move == "flip":  # horizon flip: over in the first 40%, then held upside down
        return [
            {"yaw": yaw0, "pitch": -4, "roll": 0, "fov": 85, "at": 0.0},
            {"yaw": yaw0 + 10 * d, "pitch": -4, "roll": 180 * d, "fov": 85, "at": 0.4},
            {"yaw": yaw0 + 18 * d, "pitch": -4, "roll": 180 * d, "fov": 82, "at": 1.0},
        ]
    if move == "drone":  # a high look down and forward from the raised stick, pushing in
        return [{"yaw": yaw0, "pitch": -40, "roll": 0, "fov": 72}, {"yaw": yaw0 + 12 * d, "pitch": -42, "roll": 0, "fov": 58}]
    if move == "lookaround":  # turn, hold, turn on, hold
        span = min(200.0, 50.0 * seconds)
        return [
            {"yaw": yaw0, "pitch": -5, "roll": 0, "fov": 80, "at": 0.0},
            {"yaw": yaw0 + span / 2 * d, "pitch": -5, "roll": 0, "fov": 80, "at": 0.38},
            {"yaw": yaw0 + span / 2 * d, "pitch": -5, "roll": 0, "fov": 80, "at": 0.5},
            {"yaw": yaw0 + span * d, "pitch": -4, "roll": 0, "fov": 78, "at": 0.88},
            {"yaw": yaw0 + span * d, "pitch": -4, "roll": 0, "fov": 78, "at": 1.0},
        ]
    span = pan_span(seconds)
    return [{"yaw": yaw0, "pitch": -6, "roll": 0, "fov": 85}, {"yaw": yaw0 + span * d, "pitch": -4, "roll": 0, "fov": 82}]


CHANNELS = ("yaw", "pitch", "roll", "fov")
EASES = {
    "smooth": _ease,
    "in": lambda u: max(0.0, min(1.0, u)) ** 2,  # speeding up into a cut
    "out": lambda u: 1 - (1 - max(0.0, min(1.0, u))) ** 2,  # out of a cut, slowing
    "linear": lambda u: max(0.0, min(1.0, u)),
}


def _ease_expr(kind: str, u: str) -> str:
    """The same curves as ffmpeg expressions of u (already clipped to 0..1)."""
    if kind == "in":
        return f"{u}*{u}"
    if kind == "out":
        return f"{u}*(2-{u})"
    if kind == "linear":
        return u
    return f"{u}*{u}*(3-2*{u})"


def timed(keys: list[dict]) -> list[dict]:
    """Keys with an "at" each (evenly spaced where missing) and an "ease"."""
    n = len(keys)
    out = []
    for i, k in enumerate(keys):
        at = k.get("at")
        out.append({**k, "at": (i / (n - 1) if n > 1 else 0.0) if at is None else at, "ease": k.get("ease") or "smooth"})
    return out


def camera_at(keys: list[dict], x: float) -> dict:
    """The camera at x (0..1 of the shot): each channel eased from one key to the next."""
    keys = timed(keys)
    x = max(0.0, min(1.0, x))
    i = 0
    for j in range(len(keys) - 1):
        if keys[j]["at"] <= x and keys[j + 1]["at"] > keys[j]["at"]:
            i = j
    a, b = keys[i], keys[min(i + 1, len(keys) - 1)]
    if b["at"] <= a["at"]:
        return {c: a[c] for c in CHANNELS}
    e = EASES.get(b["ease"], _ease)((x - a["at"]) / (b["at"] - a["at"]))
    return {c: a[c] + (b[c] - a[c]) * e for c in CHANNELS}


def transition_seconds(name: str | None, seconds: float, fps: int = 30) -> float:
    """How long a head or tail transition takes, never more than 40% of the shot."""
    want = {"whip": WHIP_FRAMES / fps, "rollx": 0.6, "tilt": 0.7, "planetx": 0.9}.get(name or "", 0.0)
    return min(want, 0.4 * seconds)


TILT_GROUND = -80  # where a tilt transition cuts: the ground just short of the stick


def _edge(name: str, key: dict, side: str) -> tuple[dict, str]:
    """The camera at the cut for a transition starting ("head") or ending ("tail") at `key`,
    and the curve between them (fast at the cut for motion matches)."""
    s = -1 if side == "head" else 1
    if name == "whip":
        return {**key, "yaw": key["yaw"] + 180 * s}, "out" if side == "head" else "in"
    if name == "rollx":
        return {**key, "roll": key["roll"] + 180 * s}, "out" if side == "head" else "in"
    if name == "tilt":
        return {**key, "pitch": TILT_GROUND}, "out" if side == "head" else "in"
    if name == "planetx":
        return {**key, "pitch": -90, "fov": 300}, "smooth"
    raise ValueError(f"unknown transition {name!r}")


def path_for(move: str, seconds: float, direction: int = 1, yaw0: float = 0.0, head: str | None = None, tail: str | None = None, fps: int = 30) -> list[dict]:
    """The whole camera path of a shot: its move's keyframes, squeezed between a head transition
    (from the cut into the move's first key) and a tail transition (from its last key to the cut)."""
    keys = timed(keyframes(move, seconds, direction, yaw0))
    if not head and not tail:
        return keys
    hf = transition_seconds(head, seconds, fps) / seconds if head else 0.0
    tf = transition_seconds(tail, seconds, fps) / seconds if tail else 0.0
    span = 1.0 - hf - tf
    body = [{**k, "at": hf + k["at"] * span} for k in keys]
    if head:
        start, curve = _edge(head, keys[0], "head")
        body[0]["ease"] = curve
        body.insert(0, {**start, "at": 0.0, "ease": "smooth"})
    if tail:
        end, curve = _edge(tail, keys[-1], "tail")
        body.append({**end, "at": 1.0, "ease": curve})
    return body


def projection(move: str, head: str | None = None, tail: str | None = None) -> str:
    """'sg' (stereographic) for the planet family, else 'flat'. v360 cannot switch projection
    mid-stream, so a shot with a planet transition is stereographic throughout: at 80-100
    degrees that is close to a normal lens."""
    return "sg" if move in SG_MOVES or "planetx" in (head, tail) else "flat"


def yaw_expr(keys: list[dict], seconds: float) -> str:
    """The yaw path as an ffmpeg expression of t: the start plus one eased term per segment
    (each term is 0 before its segment and its full turn after it)."""
    keys = timed(keys)
    segs = [(a, b) for a, b in zip(keys, keys[1:]) if b["at"] > a["at"]]
    if len(segs) > 1:
        segs = [(a, b) for a, b in segs if b["yaw"] != a["yaw"]]
    terms = []
    for a, b in segs:
        t0, dt = a["at"] * seconds, (b["at"] - a["at"]) * seconds
        u = f"clip(t/{dt:.4f},0,1)" if a["at"] == 0 else f"clip((t-{t0:.4f})/{dt:.4f},0,1)"
        terms.append(f"+({b['yaw'] - a['yaw']:.3f})*{_ease_expr(b['ease'], u)}")
    return f"({keys[0]['yaw']:.3f}{''.join(terms)})"


def whip_blur(seconds: float, out_w: int, head: str | None, tail: str | None, fps: int = 30) -> list[str]:
    """Motion blur on a whip's frames only: a light sideways blur once the whip has picked up
    speed (all but its two slow frames) and a heavy one on the three frames nearest the cut
    (the blurriest frame is where it cuts)."""
    light, heavy = max(2, out_w // 48), min(1024, max(4, out_w // 14))
    n = transition_seconds("whip", seconds, fps)
    fast = max(0.0, n - 2 / fps)
    near = min(fast, 3 / fps)
    windows = []
    if head == "whip":
        windows.append(((0.0, fast), (0.0, near)))
    if tail == "whip":
        windows.append(((seconds - fast, seconds + 1), (seconds - near, seconds + 1)))
    steps = []
    for (a, b), (c, e) in windows:
        steps.append(f"avgblur=sizeX={light}:sizeY=1:enable='between(t,{a:.4f},{b:.4f})'")
        steps.append(f"avgblur=sizeX={heavy}:sizeY=1:enable='between(t,{c:.4f},{e:.4f})'")
    return steps


def filter_path(path: Path) -> str:
    """A path as an ffmpeg filter option value (forward slashes, drive colon escaped)."""
    return str(path).replace("\\", "/").replace(":", "\\:")


def chain(move: str, seconds: float, size: tuple[int, int], script_path: Path, direction: int = 1, yaw0: float = 0.0, fps: int = 30,
          head: str | None = None, tail: str | None = None) -> list[str]:
    """Filters that turn an equirect stream into a moving flat (or tiny-planet) shot of `size`.
    The per-frame camera keyframes go to `script_path` (a sendcmd file): inline they would pass
    the Windows command-line limit on a long shot. head / tail: a 360 transition (TRANSITIONS)
    the shot starts or ends with; whip adds a motion blur over its frames."""
    out_w, out_h = size
    keys = path_for(move, seconds, direction, yaw0, head, tail, fps)
    a = keys[0]
    # Stereographic cannot switch to flat mid-stream, so "unroll" stays stereographic: at about
    # 95 degrees it is close to a normal lens, which is how the planet opens out to the horizon.
    out_proj = projection(move, head, tail)
    fov = _sg_fov if out_proj == "sg" else _fov
    frames = max(2, int(round(seconds * fps)))
    # v360 adds a yaw / pitch / roll command to the current turn instead of setting it, so:
    # yaw is a sideways slide of the sphere (exact, and it spins a tiny planet about the
    # ground, not the lens); pitch and roll are sent as the change since the last frame; fov is absolute.
    cmds, last_pitch, last_roll = [], float(a["pitch"]), float(a["roll"])
    for k in range(frames):
        cam = camera_at(keys, k / (frames - 1))
        pitch, roll = cam["pitch"], cam["roll"]
        h, v = fov(out_w, out_h, cam["fov"])
        parts = [f"v360@r h_fov {h:.3f}", f"v360@r v_fov {v:.3f}"]
        if abs(roll - last_roll) > 1e-6:
            parts.insert(0, f"v360@r roll {roll - last_roll:.5f}")
            last_roll = roll
        if abs(pitch - last_pitch) > 1e-6:
            parts.insert(0, f"v360@r pitch {pitch - last_pitch:.5f}")
            last_pitch = pitch
        cmds.append(f"{k / fps:.4f} " + ",".join(parts))
    script_path.parent.mkdir(parents=True, exist_ok=True)
    script_path.write_text(";\n".join(cmds) + ";\n", encoding="ascii")
    h0, v0 = fov(out_w, out_h, a["fov"])
    yaw = yaw_expr(keys, seconds)
    return [
        "split[s360y1][s360y2];[s360y1][s360y2]hstack",
        f"crop=w=iw/2:h=ih:x='mod((iw/2)*{yaw}/360+(iw/2)*10,iw/2)':y=0",
        f"sendcmd=f='{filter_path(script_path)}'",
        f"v360@r=input=e:output={out_proj}:yaw=0:pitch={a['pitch']}:roll={a['roll']}:h_fov={h0}:v_fov={v0}:w={out_w}:h={out_h}:interp=lanczos",
        *whip_blur(seconds, out_w, head, tail, fps),
    ]


# ---------- planning a sequence ----------

PLANETS = {"planet", "unroll", "rabbit", "morph", "crystal"}  # used sparingly: one in any four shots
SPINS = {"roll", "flip"}  # dizzying: one in any four shots
MIDDLE = (("pan", 3), ("reveal", 3), ("drone", 2), ("lookaround", 2), ("crystal", 1), ("rabbit", 1), ("morph", 1), ("roll", 1), ("flip", 1))
JOINS = (("whip", 3), ("tilt", 2), ("rollx", 2), ("planetx", 1), (None, 2))


def _pick(rng, pool):
    total = sum(w for _, w in pool)
    r = rng.random() * total
    for item, w in pool:
        r -= w
        if r < 0:
            return item
    return pool[-1][0]


@functools.lru_cache(maxsize=128)
def move_plan(total: int) -> tuple[str, ...]:
    """The move of every shot in a sequence of `total` 360 shots: the opening unrolls from a
    tiny planet, the last of three or more is a planet, and in between a seeded mix that never
    repeats a move back to back and keeps planets and rolls to one in any four shots."""
    import random

    rng = random.Random(f"sphere-moves-{total}")
    plan: list[str] = []
    for i in range(max(1, total)):
        if i == 0:
            plan.append("unroll")
            continue
        if i == total - 1 and total >= 3:
            plan.append("planet")
            continue
        recent = plan[-3:]
        closing = total >= 3 and i >= total - 4  # within three shots of the closing planet
        pool = [(m, w) for m, w in MIDDLE if m != plan[-1]
                and not (m in PLANETS and (closing or any(r in PLANETS for r in recent)))
                and not (m in SPINS and any(r in SPINS for r in recent))]
        plan.append(_pick(rng, pool))
    return tuple(plan)


def move_for(index: int, kind: str, total: int) -> tuple[str, int]:
    """A move per shot (see move_plan), with the direction alternating shot to shot."""
    direction = 1 if index % 2 == 0 else -1
    return move_plan(max(total, index + 1))[index], direction


@functools.lru_cache(maxsize=128)
def transition_plan(total: int) -> tuple[str | None, ...]:
    """The transition at each join of a sequence (join i is between shots i and i+1): seeded,
    never the same twice running, a planet match at most once in four joins, no roll next to a
    rolling shot, no tilt next to a rabbit hole (a 170-degree swing), some plain cuts."""
    import random

    moves = move_plan(max(1, total))
    rng = random.Random(f"sphere-joins-{total}")
    plan: list[str | None] = []
    for i in range(max(0, total - 1)):
        near = {moves[i], moves[i + 1]}
        last = plan[-1] if plan else "none"
        pool = [(t, w) for t, w in JOINS if t != last
                and not (t == "planetx" and "planetx" in plan[-3:])
                and not (t == "rollx" and near & SPINS)
                and not (t == "tilt" and near & {"rabbit", "morph"})]
        plan.append(_pick(rng, pool))
    return tuple(plan)


def transition_for(index: int, total: int) -> str | None:
    """The transition from shot `index` into shot `index + 1` (None: a plain cut, or no next shot)."""
    if index < 0 or index >= total - 1:
        return None
    return transition_plan(total)[index]


def transitions_for(index: int, total: int) -> tuple[str | None, str | None]:
    """(head, tail) for shot `index`: how it starts (the join before it) and ends (the join after)."""
    return transition_for(index - 1, total), transition_for(index, total)


SEAMS = (90.0, -90.0)  # where the two lenses of a stitch made here meet (no lens calibration)


def seam_distance(yaw: float) -> float:
    """Degrees from a view direction to the nearest lens seam."""
    return min(abs(wrap(yaw - s)) for s in SEAMS)


def seam_safe_yaw0(move: str, seconds: float, direction: int = 1, margin: float = 40.0) -> float:
    """Where a move should start on a rough stitch so the view rests inside a lens: the seams
    show as a break in the picture, so the still parts of the path (holds, slow ends) are kept
    `margin` degrees off them; the camera may cross a seam while it is turning. Ties go to the
    start nearest the _00_ lens's centre (yaw 0)."""
    keys = keyframes(move, seconds, direction, 0.0)
    xs = [k / 60 for k in range(61)]
    yaws = [camera_at(keys, x)["yaw"] for x in xs]
    weights = []
    for i, y in enumerate(yaws):
        speed = abs(yaws[min(i + 1, 60)] - yaws[max(i - 1, 0)]) / 2
        weights.append(1.0 if speed < 0.5 else 0.15)  # degrees per sample (1/60 of the shot)

    def cost(y0: float) -> float:
        return sum(w * max(0.0, margin - seam_distance(y + y0)) ** 2 for y, w in zip(yaws, weights))

    return min((float(y0) for y0 in range(-180, 180, 5)), key=lambda y0: (round(cost(y0), 6), abs(wrap(y0))))
