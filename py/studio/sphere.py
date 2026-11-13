"""
FILE: py/studio/sphere.py
PURPOSE: 360 footage: tell an equirectangular file from a flat one, and turn it into a flat
         shot with a camera move, the way Insta360 Studio's FreeCapture keyframes do.
OVERVIEW: ffmpeg's v360 filter reprojects the sphere to a normal (rectilinear) view, or to a
          stereographic "tiny planet". Its yaw / pitch / roll / fov are runtime commands, so a
          sendcmd script written here moves the virtual camera every frame with an ease-in-out
          curve: a keyframed move instead of a crop.
          Moves (from Insta360 / Premiere reframing practice):
            pan     - a slow eased pan across the scene (about 70 degrees), horizon level
            reveal  - start looking down, tilt up to the horizon while turning
            planet  - tiny planet: look straight down in stereographic and spin slowly
            unroll  - tiny planet that opens out into the normal view (hook / transition)
DEPENDENCIES: ffmpeg with v360 and sendcmd (ffmpeg 5+)
USAGE: is_equirect(w, h, path); chain(move, seconds, (w, h)) -> list of filter strings;
       move_for(index, kind) picks a move for a shot. studio.shot calls these for 360 sources.
NOTES: Dual-fisheye originals (.insv, .360) are not stitched here: export them as 360 video
       from Insta360 Studio / GoPro Player first (stitching needs the lens calibration).
"""
from __future__ import annotations

import math
from pathlib import Path

RAW_360 = {".insv", ".360"}  # dual-fisheye originals that need the maker's stitcher
PHOTO_360 = {".insp"}       # Insta360 photos: already stitched equirect JPEGs
MOVES = ("pan", "reveal", "planet", "unroll")


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


def is_equirect(width: int | None, height: int | None, path: Path | str | None = None) -> bool:
    """A 2:1 frame of 2000 px or more, or an Insta360 photo, is a 360 (stitched or not)."""
    if path is not None and Path(path).suffix.lower() in PHOTO_360:
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

    if path.suffix.lower() in {".mp4", ".mov", ".insv", ".360"}:
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

    pre = DFISHEYE_PRE + "," if layout(src) == "dfisheye" else ""
    h, v = _fov(width, width * 9 // 16, 70)
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
    """Start and end of the virtual camera for one shot. Values in degrees."""
    d = 1 if direction >= 0 else -1
    if move == "reveal":
        return [{"yaw": yaw0, "pitch": -40, "roll": 0, "fov": 90}, {"yaw": yaw0 + 35 * d, "pitch": -4, "roll": 0, "fov": 80}]
    if move == "planet":
        return [{"yaw": yaw0, "pitch": -90, "roll": 0, "fov": 300}, {"yaw": yaw0 + 50 * d, "pitch": -90, "roll": 0, "fov": 270}]
    if move == "unroll":
        return [{"yaw": yaw0, "pitch": -90, "roll": 0, "fov": 300}, {"yaw": yaw0 + 25 * d, "pitch": -8, "roll": 0, "fov": 95}]
    span = pan_span(seconds)
    return [{"yaw": yaw0, "pitch": -6, "roll": 0, "fov": 85}, {"yaw": yaw0 + span * d, "pitch": -4, "roll": 0, "fov": 82}]


def filter_path(path: Path) -> str:
    """A path as an ffmpeg filter option value (forward slashes, drive colon escaped)."""
    return str(path).replace("\\", "/").replace(":", "\\:")


def chain(move: str, seconds: float, size: tuple[int, int], script_path: Path, direction: int = 1, yaw0: float = 0.0, fps: int = 30) -> list[str]:
    """Filters that turn an equirect stream into a moving flat (or tiny-planet) shot of `size`.
    The per-frame camera keyframes go to `script_path` (a sendcmd file): inline they would pass
    the Windows command-line limit on a long shot."""
    out_w, out_h = size
    a, b = keyframes(move, seconds, direction, yaw0)
    # Stereographic cannot switch to flat mid-stream, so "unroll" stays stereographic: at about
    # 95 degrees it is close to a normal lens, which is how the planet opens out to the horizon.
    out_proj = "sg" if move in ("planet", "unroll") else "flat"
    fov = _sg_fov if out_proj == "sg" else _fov
    frames = max(2, int(round(seconds * fps)))
    # v360 adds a yaw / pitch / roll command to the current turn instead of setting it, so:
    # yaw is a sideways slide of the sphere (exact, and it spins a tiny planet about the
    # ground, not the lens); pitch is sent as the change since the last frame; fov is absolute.
    cmds, last_pitch = [], float(a["pitch"])
    for k in range(frames):
        u = _ease(k / (frames - 1))
        pitch = a["pitch"] + (b["pitch"] - a["pitch"]) * u
        h, v = fov(out_w, out_h, a["fov"] + (b["fov"] - a["fov"]) * u)
        parts = [f"v360@r h_fov {h:.3f}", f"v360@r v_fov {v:.3f}"]
        if abs(pitch - last_pitch) > 1e-6:
            parts.insert(0, f"v360@r pitch {pitch - last_pitch:.5f}")
            last_pitch = pitch
        cmds.append(f"{k / fps:.4f} " + ",".join(parts))
    script_path.parent.mkdir(parents=True, exist_ok=True)
    script_path.write_text(";\n".join(cmds) + ";\n", encoding="ascii")
    h0, v0 = fov(out_w, out_h, a["fov"])
    u = f"clip(t/{seconds:.4f},0,1)"
    yaw = f"({a['yaw']:.3f}+({b['yaw'] - a['yaw']:.3f})*{u}*{u}*(3-2*{u}))"
    return [
        "split[s360y1][s360y2];[s360y1][s360y2]hstack",
        f"crop=w=iw/2:h=ih:x='mod((iw/2)*{yaw}/360+(iw/2)*10,iw/2)':y=0",
        f"sendcmd=f='{filter_path(script_path)}'",
        f"v360@r=input=e:output={out_proj}:yaw=0:pitch={a['pitch']}:roll=0:h_fov={h0}:v_fov={v0}:w={out_w}:h={out_h}:interp=lanczos",
    ]


def move_for(index: int, kind: str, total: int) -> tuple[str, int]:
    """A move per shot: the opening becomes a tiny planet that opens out (the classic 360 hook),
    the last shot a planet, the rest alternate pans and reveals with alternating direction."""
    direction = 1 if index % 2 == 0 else -1
    if index == 0:
        return "unroll", direction
    if index == total - 1:
        return "planet", direction
    return ("reveal" if index % 3 == 1 else "pan"), direction
