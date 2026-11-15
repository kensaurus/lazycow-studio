"""
FILE: py/studio/lut.py
PURPOSE: Colour presets ("LUTs") for reels and long videos: 3D LUTs computed here and written as .cube files.
OVERVIEW: Each preset is a pure function rgb -> rgb (numpy, vectorised) built from channel mixing, a luminance tone
          curve (black lift, contrast, highlight roll-off), saturation by luminance, hue-selective shifts and split
          toning. It is baked once to a 33^3 .cube under DATA/luts (and once more per strength) and reused; ffmpeg's
          lut3d lays it on a shot.
DEPENDENCIES: numpy, studio.config (Pillow and ffmpeg for the preview sheet)
USAGE: presets() -> [{name, label, description}]; path(name, strength=1.0) -> .cube; filter(name, strength=1.0) -> ffmpeg
       filter; preview(src, out) -> a labelled contact sheet of every preset. CLI: python -m studio lut list|preview
NOTES: No downloaded or third-party LUT files (licensing): every table comes from the numbers below.
       Luminance comes from the tone curve alone, so a grey ramp stays in order, and nothing clips: a colour that would
       leave 0..1 is pulled toward its own grey at the same luminance. Skin hues (orange, about 20-50 degrees) keep
       their hue and most of their saturation. The cache key is this file's hash: a tuned preset is baked again.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from studio.config import DATA, ffmpeg_bin

SIZE = 33
CACHE = DATA / "luts"
_KEY = hashlib.sha1(Path(__file__).read_bytes()).hexdigest()[:8]
_LOCK = threading.Lock()

# Rec.709 luminance and colour-difference scales: R = Y + KR*Pr, B = Y + KB*Pb.
_W = np.array([0.2126, 0.7152, 0.0722])
KR, KB = 1.5748, 1.8556


def _split(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    y = rgb @ _W
    return y, (rgb[..., 2] - y) / KB, (rgb[..., 0] - y) / KR


def _join(y: np.ndarray, pb: np.ndarray, pr: np.ndarray) -> np.ndarray:
    r = y + KR * pr
    b = y + KB * pb
    g = (y - _W[0] * r - _W[2] * b) / _W[1]
    return np.stack([r, g, b], axis=-1)


def _hue(pb, pr):
    """Hue angle (degrees) in the Pb/Pr plane."""
    return np.degrees(np.arctan2(pr, pb))


def _hue_of(rgb) -> float:
    _, pb, pr = _split(np.asarray(rgb, dtype=np.float64))
    return float(_hue(pb, pr))


def _angdiff(a, b):
    return (a - b + 180.0) % 360.0 - 180.0


def _smooth(e0: float, e1: float, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _curve(points):
    """A monotone cubic through (x, y) points (Fritsch-Butland slopes): increasing points give an increasing curve."""
    x = np.array([p[0] for p in points], dtype=np.float64)
    y = np.array([p[1] for p in points], dtype=np.float64)
    h = np.diff(x)
    d = np.diff(y) / h
    m = np.empty_like(x)
    m[0], m[-1] = d[0], d[-1]
    prod = d[:-1] * d[1:]
    with np.errstate(divide="ignore", invalid="ignore"):
        m[1:-1] = np.where(prod > 0, 2 * prod / (d[:-1] + d[1:]), 0.0)

    def f(v):
        v = np.clip(v, x[0], x[-1])
        i = np.clip(np.searchsorted(x, v, side="right") - 1, 0, len(h) - 1)
        t = (v - x[i]) / h[i]
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
                + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h[i] * m[i + 1])

    return f


def _fit(y: np.ndarray, rgb: np.ndarray) -> np.ndarray:
    """Into 0..1 without clipping: chroma is eased toward the pixel's grey (same luminance) as it nears the edge of
    the gamut, with a soft knee, so saturated highlights roll off instead of turning into flat blocks."""
    y = np.clip(y, 0.0, 1.0)[..., None]
    c = rgb - y
    with np.errstate(divide="ignore", invalid="ignore"):
        up = np.where(c > 1e-9, (1.0 - y) / c, np.inf)
        dn = np.where(c < -1e-9, y / -c, np.inf)
    room = np.minimum(up.min(-1), dn.min(-1))[..., None]  # how far the chroma could stretch before leaving 0..1
    need = np.where(np.isfinite(room), 1.0 / np.maximum(room, 1e-9), 0.0)  # >1: outside
    knee = 0.9
    eased = np.where(need > knee, knee + (1 - knee) * np.tanh((need - knee) / (1 - knee)), need)
    with np.errstate(divide="ignore", invalid="ignore"):
        scale = np.where(need > knee, eased / need, 1.0)
    return np.clip(y + c * scale, 0.0, 1.0)


@dataclass(frozen=True)
class Hue:
    """A hue-selective change: colours near `of` turn `turn` of the way toward `to`'s hue, their saturation times
    `sat` and their luminance times 1 + `lum` (greys are untouched: the weight needs colour to act on)."""
    of: tuple[float, float, float]
    to: tuple[float, float, float] | None = None
    turn: float = 0.0
    sat: float = 1.0
    lum: float = 0.0
    width: float = 32.0


@dataclass(frozen=True)
class Grade:
    label: str
    description: str
    curve: tuple = ((0.0, 0.0), (1.0, 1.0))                 # luminance in -> out
    sat: tuple[float, float, float] = (1.0, 1.0, 1.0)       # saturation at black, mid grey, white
    shadows: tuple = ((0.5, 0.5, 0.5), 0.0)                 # (tint colour, amount in Pb/Pr units)
    mids: tuple = ((0.5, 0.5, 0.5), 0.0)
    highlights: tuple = ((0.5, 0.5, 0.5), 0.0)
    hues: tuple[Hue, ...] = ()
    mix: tuple | None = None                                # 3x3 channel mixer, rows summing to 1 (greys stay grey)
    mono: tuple[float, float, float] | None = None          # black and white: luminance weights (sum 1)
    clean_blacks: bool = False                              # no shadow tint in the bottom few percent
    skin: float = 0.85                                      # 0..1, how much skin hues are spared hue/saturation moves


SKIN = _hue_of((0.85, 0.62, 0.48))  # a mid skin tone; light and deep skin sit within a few degrees of it


def _tint(colour, amount):
    """A unit chroma direction for a tint colour, times the amount."""
    _, pb, pr = _split(np.asarray(colour, dtype=np.float64))
    n = float(np.hypot(pb, pr)) or 1.0
    return float(pb) / n * amount, float(pr) / n * amount


def apply(g: Grade, rgb: np.ndarray) -> np.ndarray:
    """The preset as a pure function on an (..., 3) array of display-referred RGB in 0..1."""
    rgb = np.clip(np.asarray(rgb, dtype=np.float64), 0.0, 1.0)
    if g.mix is not None:
        rgb = rgb @ np.asarray(g.mix, dtype=np.float64).T
    y, pb, pr = _split(rgb)
    if g.mono is not None:
        y = rgb @ np.asarray(g.mono, dtype=np.float64)
        pb, pr = np.zeros_like(y), np.zeros_like(y)
    chroma = np.hypot(pb, pr)
    hue = _hue(pb, pr)
    coloured = _smooth(0.008, 0.04, chroma)  # hue only means something with some colour
    skin = np.exp(-0.5 * (_angdiff(hue, SKIN) / 20.0) ** 2) * coloured * g.skin
    turn = np.zeros_like(y)
    satm = np.ones_like(y)
    lum = np.zeros_like(y)
    for h in g.hues:
        c = _hue_of(h.of)
        w = np.exp(-0.5 * (_angdiff(hue, c) / h.width) ** 2) * coloured
        if h.to is not None and h.turn:
            turn += w * _angdiff(_hue_of(h.to), c) * h.turn
        satm *= 1 + w * (h.sat - 1)
        lum += w * h.lum
    turn *= 1 - skin
    satm = 1 + (satm - 1) * (1 - skin)
    lum *= 1 - skin
    y = np.clip(y * (1 + lum), 0.0, 1.0)
    y2 = np.clip(_curve(g.curve)(np.clip(y, 0.0, 1.0)), 0.0, 1.0)
    by_lum = _curve(((0.0, g.sat[0]), (0.5, g.sat[1]), (1.0, g.sat[2])))(y2)
    by_lum = 1 + (by_lum - 1) * (1 - 0.6 * skin)
    s = satm * by_lum
    a = np.radians(turn)
    ca, sa = np.cos(a), np.sin(a)
    pb, pr = (pb * ca - pr * sa) * s, (pb * sa + pr * ca) * s
    # Tints live in the low mids and the bright mids: true black and paper white stay close to neutral, so a
    # flame's core or a white sky never turns blue or peach.
    ws = (1 - _smooth(0.05, 0.6, y2)) * (_smooth(0.02, 0.14, y2) if g.clean_blacks else _smooth(-0.04, 0.1, y2))
    wm = 4 * y2 * (1 - y2)
    wh = _smooth(0.4, 0.85, y2) * (1 - 0.75 * _smooth(0.86, 1.0, y2))
    spare = 1 - 0.7 * skin
    for (colour, amount), w in ((g.shadows, ws), (g.mids, wm), (g.highlights, wh)):
        if amount:
            tb, tr = _tint(colour, amount)
            pb = pb + tb * w * spare
            pr = pr + tr * w * spare
    return _fit(y2, _join(y2, pb, pr))


# Plain names, no film-stock or brand names. Every one is meant to sit under footage, not on top of it.
GREEN = (0.30, 0.60, 0.22)
YELLOW_GREEN = (0.62, 0.72, 0.22)
BLUE = (0.30, 0.50, 0.90)
CYAN = (0.20, 0.65, 0.75)
GOLD = (0.85, 0.68, 0.30)

PRESETS: dict[str, Grade] = {
    "warm-film": Grade(
        "Warm film", "Soft print film: lifted blacks, warm highlights, a gentle roll-off at the top.",
        curve=((0, 0.035), (0.15, 0.14), (0.5, 0.505), (0.8, 0.795), (0.93, 0.9), (1, 0.955)),
        sat=(0.86, 0.98, 0.88),
        shadows=((0.15, 0.5, 0.55), 0.012), highlights=((1.0, 0.8, 0.5), 0.026),
        hues=(Hue(GREEN, YELLOW_GREEN, 0.15, 0.92), Hue(BLUE, CYAN, 0.12, 0.9))),
    "teal-amber": Grade(
        "Teal and amber", "A restrained orange-teal: cool shadows and skies, warm highlights, skin left as it was.",
        curve=((0, 0.015), (0.2, 0.18), (0.5, 0.5), (0.8, 0.82), (1, 0.975)),
        sat=(0.9, 1.0, 0.92),
        shadows=((0.1, 0.55, 0.62), 0.03), highlights=((1.0, 0.72, 0.42), 0.024),
        hues=(Hue(BLUE, CYAN, 0.3, 1.0), Hue(GREEN, CYAN, 0.18, 0.86), Hue(YELLOW_GREEN, GREEN, 0.1, 0.9))),
    "golden-hour": Grade(
        "Golden hour", "Late-sun warmth through the mids and highlights, soft contrast, skies kept gentle.",
        curve=((0, 0.02), (0.25, 0.245), (0.5, 0.52), (0.85, 0.865), (1, 0.97)),
        sat=(0.94, 1.05, 0.94),
        shadows=((0.55, 0.38, 0.45), 0.008), mids=((1.0, 0.8, 0.5), 0.012), highlights=((1.0, 0.74, 0.4), 0.032),
        hues=(Hue(BLUE, None, 0.0, 0.88), Hue(GREEN, YELLOW_GREEN, 0.05, 0.96), Hue(YELLOW_GREEN, None, 0.0, 0.92))),
    "cool-morning": Grade(
        "Cool morning", "Clean, airy and a little blue: soft shadows, cool air, colour held back.",
        curve=((0, 0.028), (0.3, 0.31), (0.6, 0.625), (0.9, 0.915), (1, 0.975)),
        sat=(0.86, 0.93, 0.88),
        shadows=((0.3, 0.45, 0.78), 0.026), highlights=((0.75, 0.9, 1.0), 0.01),
        hues=(Hue(GREEN, CYAN, 0.15, 0.9), Hue(GOLD, None, 0.0, 0.9))),
    "bleach": Grade(
        "Bleach bypass", "Silver left in: low saturation, hard contrast, a steely edge.",
        curve=((0, 0.0), (0.12, 0.085), (0.5, 0.5), (0.85, 0.9), (1, 0.985)),
        sat=(0.55, 0.62, 0.55),
        shadows=((0.3, 0.48, 0.6), 0.008),
        skin=0.6),
    "soft-matte": Grade(
        "Soft matte", "Faded and pastel: milky blacks, lowered highlights, colour softened.",
        curve=((0, 0.075), (0.2, 0.215), (0.5, 0.5), (0.85, 0.82), (1, 0.915)),
        sat=(0.74, 0.85, 0.78),
        shadows=((0.48, 0.42, 0.62), 0.012), highlights=((1.0, 0.9, 0.72), 0.014),
        hues=(Hue(GREEN, CYAN, 0.12, 0.85),)),
    "deep-green": Grade(
        "Deep green", "Forest and pasture greens rich and dense, never neon; the rest stays natural.",
        curve=((0, 0.012), (0.2, 0.185), (0.5, 0.5), (0.8, 0.815), (1, 0.975)),
        sat=(0.94, 1.02, 0.94),
        shadows=((0.2, 0.45, 0.4), 0.012), highlights=((1.0, 0.86, 0.62), 0.014),
        hues=(Hue(GREEN, (0.2, 0.55, 0.32), 0.18, 1.08, -0.07), Hue(YELLOW_GREEN, GREEN, 0.25, 0.94, -0.03))),
    "savanna": Grade(
        "Savanna", "Dry golds and deep blue skies: warm grass, clean shadows, a sky with weight.",
        curve=((0, 0.015), (0.2, 0.185), (0.5, 0.51), (0.8, 0.82), (1, 0.97)),
        sat=(0.92, 1.03, 0.92),
        shadows=((0.45, 0.35, 0.3), 0.008), highlights=((1.0, 0.8, 0.5), 0.022),
        hues=(Hue(GOLD, None, 0.0, 1.1), Hue(BLUE, (0.25, 0.38, 0.92), 0.2, 1.1, -0.08),
              Hue(GREEN, YELLOW_GREEN, 0.15, 0.9), Hue(YELLOW_GREEN, GOLD, 0.08, 0.94))),
    "night-blue": Grade(
        "Night blue", "Cool moonlight with clean blacks; warm lamps and fire keep their glow.",
        curve=((0, 0.0), (0.1, 0.075), (0.4, 0.38), (0.8, 0.8), (1, 0.96)),
        sat=(0.72, 0.86, 0.86),
        shadows=((0.25, 0.4, 0.82), 0.032), highlights=((0.82, 0.9, 1.0), 0.008),
        hues=(Hue(GREEN, CYAN, 0.25, 0.8),), clean_blacks=True),
    "mono-warm": Grade(
        "Warm black and white", "Selenium-toned black and white: warm brown in the shadows, clean paper whites.",
        curve=((0, 0.025), (0.2, 0.18), (0.5, 0.5), (0.8, 0.825), (1, 0.97)),
        mono=(0.30, 0.59, 0.11),
        shadows=((0.6, 0.44, 0.36), 0.012), mids=((0.62, 0.52, 0.42), 0.008), highlights=((1.0, 0.95, 0.86), 0.005),
        skin=0.0),
    "mono-neutral": Grade(
        "Black and white", "Rich neutral black and white with a red-filter mix: darker skies, brighter skin.",
        curve=((0, 0.008), (0.18, 0.14), (0.5, 0.5), (0.82, 0.86), (1, 0.98)),
        mono=(0.45, 0.47, 0.08),
        skin=0.0),
    "punch": Grade(
        "Punch", "Vivid and crisp for short reels; skin tones are protected from the extra colour.",
        curve=((0, 0.0), (0.2, 0.175), (0.5, 0.5), (0.8, 0.83), (1, 0.98)),
        sat=(1.0, 1.13, 1.04),
        hues=(Hue(BLUE, None, 0.0, 1.06), Hue(GREEN, None, 0.0, 0.96), Hue(YELLOW_GREEN, None, 0.0, 0.88)),
        skin=0.92),
}


def presets() -> list[dict]:
    return [{"name": k, "label": g.label, "description": g.description} for k, g in PRESETS.items()]


def _grade(name: str) -> Grade:
    if name not in PRESETS:
        raise ValueError(f"lut: unknown preset {name!r}; one of {', '.join(PRESETS)}")
    return PRESETS[name]


def grid(size: int = SIZE) -> np.ndarray:
    """The identity lattice in .cube order (red fastest, then green, then blue): (size**3, 3)."""
    axis = np.linspace(0.0, 1.0, size)
    b, g, r = np.meshgrid(axis, axis, axis, indexing="ij")
    return np.stack([r.ravel(), g.ravel(), b.ravel()], axis=-1)


def table(name: str, strength: float = 1.0, size: int = SIZE) -> np.ndarray:
    """The preset sampled on the lattice, blended toward identity by strength (0 = no change)."""
    s = min(1.0, max(0.0, float(strength)))
    ident = grid(size)
    if s == 0.0:
        return ident
    return np.clip(ident + s * (apply(_grade(name), ident) - ident), 0.0, 1.0)


def cube_text(name: str, strength: float = 1.0, size: int = SIZE) -> str:
    rows = table(name, strength, size)
    head = [f'TITLE "{name} {round(strength * 100)}%"', f"LUT_3D_SIZE {size}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    return "\n".join(head + [f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in rows]) + "\n"


def _pct(strength: float) -> int:
    return int(round(min(1.0, max(0.0, float(strength))) * 100))


def path(name: str, strength: float = 1.0) -> Path:
    """The preset's .cube (baked on first use, then reused). Strength is baked in too, rounded to whole percent."""
    _grade(name)
    pct = _pct(strength)
    out = CACHE / _KEY / f"{name}-{pct:03d}.cube"
    if out.exists():
        return out
    with _LOCK:
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=out.parent, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="ascii", newline="\n") as fh:
                fh.write(cube_text(name, pct / 100))
            os.replace(tmp, out)
    return out


def filter_path(p: Path) -> str:
    """A path as an ffmpeg filter option value (forward slashes, drive colon escaped): sphere.filter_path's rule."""
    return str(p).replace("\\", "/").replace(":", "\\:")


def filter(name: str, strength: float = 1.0) -> str:  # noqa: A001 - the studio's word for an ffmpeg filter string
    """The ffmpeg filter that lays the preset at this strength; "" at strength 0 (nothing to do)."""
    if _pct(strength) == 0:
        _grade(name)
        return ""
    return f"lut3d=file='{filter_path(path(name, strength))}':interp=tetrahedral"


# -- preview sheet ----------------------------------------------------------------------------------------------

def _frame(src: Path, work: Path, width: int) -> Path:
    from studio.shot import PHOTO_EXT, flat_photo, hdr_prefix

    out = work / "source.png"
    if src.suffix.lower() in PHOTO_EXT:
        src, at, pre = flat_photo(src), 0.0, ""
    else:
        at, pre = _middle(src), hdr_prefix(src)
    cmd = [str(ffmpeg_bin()), "-y", "-v", "error", "-ss", f"{at:.3f}", "-i", str(src), "-frames:v", "1",
           "-vf", f"{pre}scale={width}:-2:flags=lanczos,format=rgb24", str(out)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=180)
    return out


def _middle(src: Path) -> float:
    from studio.config import ffprobe_bin

    try:
        r = subprocess.run([str(ffprobe_bin()), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
                           capture_output=True, text=True, timeout=60)
        return max(0.0, float(r.stdout.strip()) * 0.4)
    except (ValueError, OSError, subprocess.SubprocessError):
        return 0.0


def _font(size: int):
    from PIL import ImageFont

    for name in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def preview(src: Path, out: Path, width: int = 480, names: list[str] | None = None, strength: float = 1.0) -> Path:
    """The source (a photo, or a frame from a video) through every preset, through ffmpeg's real lut3d path, on one
    labelled contact sheet: the original first, then each preset."""
    from PIL import Image, ImageDraw

    names = names or list(PRESETS)
    with tempfile.TemporaryDirectory(prefix="lut-preview-") as tmp:
        work = Path(tmp)
        base = _frame(Path(src), work, width)
        tiles = [("Original", Image.open(base).convert("RGB"))]
        for name in names:
            dest = work / f"{name}.png"
            subprocess.run([str(ffmpeg_bin()), "-y", "-v", "error", "-i", str(base), "-vf", ",".join(x for x in ("format=rgb24", filter(name, strength), "format=rgb24") if x),
                            str(dest)], check=True, capture_output=True, timeout=180)
            tiles.append((f"{PRESETS[name].label}  ({name})", Image.open(dest).convert("RGB")))
        tw, th = tiles[0][1].size
        bar, gap = 34, 6
        cols = 4 if tw >= th else 5
        rows = -(-len(tiles) // cols)
        sheet = Image.new("RGB", (cols * tw + (cols + 1) * gap, rows * (th + bar) + (rows + 1) * gap), (18, 18, 18))
        draw = ImageDraw.Draw(sheet)
        font = _font(17)
        for k, (label, im) in enumerate(tiles):
            x = gap + (k % cols) * (tw + gap)
            y = gap + (k // cols) * (th + bar + gap)
            sheet.paste(im, (x, y))
            draw.text((x + 6, y + th + 7), label, fill=(235, 235, 235), font=font)
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(out, quality=90)
    return out
