"""
FILE: py/studio/shot.py
PURPOSE: Render one graded shot at an exact output size (9:16 or 16:9).
OVERVIEW: Measures the clip, normalises its levels, then lays the house film
          look on top (S-curve with lifted blacks, warm highlights, cool
          shadows, a touch more saturation, vignette, grain). The 9:16 window
          follows the subject (a face, else the sharpest part) instead of the
          middle of the frame. Optional slow motion for 60 fps phone clips.
          blur=True softens each detected face before the crop.
          Stills: JPEG/PNG/WebP/TIFF, HEIC/AVIF (pillow-heif), DNG and camera RAW (rawpy).
          360 sources (2:1 equirect, or Insta360 dual-fisheye which is stitched first) are not
          cropped: studio.sphere reframes them with an eased virtual-camera move instead.
          Between shots (reels.shot_looks decides, render_shot applies): probe_window measures a
          window once (Lab colour statistics, shake); color_correction pulls a shot's cast toward
          the reel's median (color=, before the look); stab_transforms + stab_filter steady a
          handheld clip with two-pass vidstab (stab=, before the crop). Both default to off here.
DEPENDENCIES: ffmpeg, numpy, opencv, Pillow, pillow-heif, rawpy, studio.config, studio.sphere
USAGE: render_shot(src, start, seconds, out, (1080, 1920), pan=(0.3, 0.7), speed=0.5,
       move=("unroll", 1))
NOTES: Sources are read only. Display size is read from a decoded frame, so a
       phone clip with rotation metadata crops the right way up.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np

from studio.config import DATA, ffmpeg_bin


@dataclass
class Measure:
    width: int
    height: int
    lo: tuple[float, float, float]
    hi: tuple[float, float, float]
    mean: float
    cx: float
    cy: float = 0.5
    faces: list | None = None


def _run(cmd: list[str], timeout: int = 60 * 20) -> None:
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError((exc.stderr or b"").decode("utf-8", "replace")[-1500:]) from exc


TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)


def hdr_prefix(src: Path) -> str:
    """HLG / PQ footage (DJI HLG, phone HDR) is tone-mapped to SDR first."""
    from studio.config import ffprobe_bin

    probe = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    transfer = (probe.stdout or "").strip()
    return TONEMAP + "," if transfer in ("arib-std-b67", "smpte2084") else ""


from studio.media import RAW as RAW_EXT, STILL as PHOTO_EXT  # noqa: E402


def open_photo(src: Path):
    """Any still as an upright RGB Pillow image: HEIC/AVIF through pillow-heif, camera RAW and
    DNG developed by rawpy (camera white balance), everything else through Pillow."""
    from PIL import Image, ImageOps

    if src.suffix.lower() in RAW_EXT:
        import rawpy

        with rawpy.imread(str(src)) as raw:
            return Image.fromarray(raw.postprocess(use_camera_wb=True, output_bps=8))
    if src.suffix.lower() in {".heic", ".heif", ".avif"}:
        import pillow_heif

        pillow_heif.register_heif_opener()
    with Image.open(src) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def save_whole(im, dest: Path) -> None:
    """Write a PNG under a temporary name and rename it into place, so a render stopped mid-write (a restart, a crash)
    never leaves a cut-off keyframe that every later render would reuse ("no frame from …png")."""
    import os

    part = dest.with_name(dest.stem + ".part.png")
    im.save(part, format="PNG")
    os.replace(part, dest)


def whole_png(path: Path) -> bool:
    """True when a cached PNG reads to the end; a cut-off one is removed so it is made again."""
    from PIL import Image

    try:
        with Image.open(path) as im:
            im.verify()
        return True
    except Exception:
        path.unlink(missing_ok=True)
        return False


def flat_photo(src: Path) -> Path:
    """A photo as an upright PNG. ffmpeg's JPEG path leaves a green band on these phone files.
    An unstitched 360 (two fisheye circles) comes back stitched to equirect."""
    from hashlib import sha1

    from PIL import Image

    from studio import sphere

    digest = sha1(str(src).encode()).hexdigest()[:16]
    flat = DATA / "keyframes" / f"photo_{digest}.png"
    globe = DATA / "keyframes" / f"sphere_{digest}.png"  # a 360 that came stitched
    seamed = DATA / "keyframes" / f"stitch_{digest}.png"  # a 360 stitched here (rough seams)
    for done in (globe, seamed):
        if done.exists() and whole_png(done):
            return done
    if flat.exists() and whole_png(flat):
        with Image.open(flat) as im:
            if not sphere.is_equirect(*im.size, src):
                return flat
    flat.parent.mkdir(parents=True, exist_ok=True)
    im = open_photo(src)
    if sphere.is_tall_pair(*im.size):
        im = sphere.side_by_side(im)
    if not sphere.is_equirect(*im.size, src):
        im.thumbnail((3840, 3840))
        save_whole(im, flat)
        return flat
    im.thumbnail((5760, 5760))
    # Stitching reads a file, so the layout test runs on the upright copy written here.
    raw = globe.with_name(globe.stem + "_raw.png")
    im.save(raw)
    try:
        if sphere.layout(raw) == "dfisheye":
            sphere.stitch_still(raw, seamed)
            pitch, roll = sphere.level(seamed)
            if (pitch, roll) != (0, 0):
                tilted = seamed.with_name(seamed.stem + "_tilt.png")
                seamed.replace(tilted)
                try:
                    sphere.apply_level(tilted, seamed, pitch, roll)
                finally:
                    tilted.unlink(missing_ok=True)
            result = seamed
        else:
            raw.replace(globe)
            result = globe
    finally:
        raw.unlink(missing_ok=True)
    flat.unlink(missing_ok=True)
    return result


def is_360(src: Path) -> bool:
    """True for a 360 source (stitched or dual-fisheye), from its decoded size."""
    from studio import sphere

    if src.suffix.lower() in PHOTO_EXT:
        from PIL import Image

        with Image.open(flat_photo(src)) as im:
            return sphere.is_equirect(*im.size, src)
    from studio.config import ffprobe_bin

    probe = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    try:
        w, h = (int(x) for x in probe.stdout.strip().split(",")[:2])
    except ValueError:
        return False
    return sphere.is_equirect(w, h, src)


_DET = None


def _face_boxes(image) -> list[tuple[int, int, int, int]]:
    """Face rectangles in full-frame pixels. Empty when the model is missing or nobody is there."""
    global _DET
    model = DATA / "bin" / "face_detection_yunet_2023mar.onnx"
    if not model.exists():
        return []
    h, w = image.shape[:2]
    dw = 640
    dh = max(2, int(round(h * dw / w)))
    dh -= dh % 2 or 0
    small = cv2.resize(image, (dw, max(2, dh)))
    if _DET is None:
        _DET = cv2.FaceDetectorYN.create(str(model), "", (small.shape[1], small.shape[0]), 0.75)
    _DET.setInputSize((small.shape[1], small.shape[0]))
    _, found = _DET.detect(small)
    if found is None:
        return []
    sx, sy = w / small.shape[1], h / small.shape[0]
    boxes = []
    for row in found:
        x, y, bw, bh = (int(row[0] * sx), int(row[1] * sy), int(row[2] * sx), int(row[3] * sy))
        bw -= bw % 2
        bh -= bh % 2
        x -= x % 2
        y -= y % 2
        x, y = max(0, x), max(0, y)
        if bw >= 16 and bh >= 16 and x + bw <= w and y + bh <= h:
            boxes.append((x, y, bw, bh))
    return boxes


def blur_graph(boxes: list[tuple[int, int, int, int]], label: str = "0:v") -> tuple[str, str]:
    """Blur each face on `label`. Returns the filter piece and the label it leaves."""
    parts = []
    current = label
    for i, (x, y, bw, bh) in enumerate(boxes):
        parts.append(f"[{current}]split[keep{i}][cut{i}]")
        # A small face crop rejects a large blur radius, so the radius stays under 8.
        parts.append(f"[cut{i}]crop={bw}:{bh}:{x}:{y},boxblur=6:1[face{i}]")
        parts.append(f"[keep{i}][face{i}]overlay={x}:{y}[b{i}]")
        current = f"b{i}"
    return ";".join(parts), current


def measure(src: Path, t: float) -> Measure:
    """Decode one frame at display orientation and read its levels."""
    if src.suffix.lower() in PHOTO_EXT and src.parent != DATA / "keyframes":
        src, t = flat_photo(src), 0.0
    # One file per call: builds run side by side and a shared name was read mid-write.
    dest = DATA / "keyframes" / f"_measure_{os.getpid()}_{uuid4().hex[:8]}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    pre = hdr_prefix(src)
    vf = ["-vf", pre.rstrip(",")] if pre else []
    try:
        _run([str(ffmpeg_bin()), "-y", "-ss", f"{max(0.0, t):.3f}", "-i", str(src), "-frames:v", "1", *vf, "-update", "1", str(dest)], 180)
        image = cv2.imread(str(dest))
    finally:
        dest.unlink(missing_ok=True)
    if image is None:
        raise RuntimeError(f"no frame from {src}")
    h, w = image.shape[:2]
    small = cv2.resize(image, (480, max(2, int(480 * h / w))))
    rgb = small[..., ::-1].astype(np.float32) / 255.0
    lo = tuple(float(np.percentile(rgb[..., c], 1)) for c in range(3))
    hi = tuple(float(np.percentile(rgb[..., c], 99.5)) for c in range(3))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    energy = cv2.GaussianBlur(np.abs(cv2.Laplacian(gray, cv2.CV_32F)), (0, 0), 9)
    xs = np.arange(gray.shape[1], dtype=np.float32)
    ys = np.arange(gray.shape[0], dtype=np.float32)
    cx = float((energy.sum(axis=0) * xs).sum() / (energy.sum() + 1e-6) / gray.shape[1])
    cy = float((energy.sum(axis=1) * ys).sum() / (energy.sum() + 1e-6) / gray.shape[0])
    boxes = _face_boxes(image)
    if boxes:
        cx = sum((x + bw / 2) / w for x, _, bw, _ in boxes) / len(boxes)
        cy = sum((y + bh / 2) / h for _, y, _, bh in boxes) / len(boxes)
    else:
        cx = min(0.82, max(0.18, cx))
        cy = min(0.82, max(0.18, cy))
    return Measure(w, h, lo, hi, float(gray.mean() / 255.0), cx, cy, boxes)


def look_chain(m: Measure, natural: bool = False) -> str:
    """Normalise, then the house film look. Night clips keep their dark.
    natural: for a long film. Exposure is evened gently (blacks are never crushed, highlights never pushed), and the
    colour stays what the camera saw: no S-curve, no extra saturation. A look's own grade is laid before this."""
    luma_lo = sum(m.lo) / 3
    luma_hi = sum(m.hi) / 3
    night = m.mean < 0.22
    parts = []
    if natural:
        lo = [0.0, 0.0, 0.0] if night else [min(0.045, 0.6 * c + 0.4 * luma_lo) for c in m.lo]
        hi = [max(0.88, 0.6 * c + 0.4 * luma_hi) for c in m.hi]
        return ("colorlevels="
                f"rimin={lo[0]:.3f}:gimin={lo[1]:.3f}:bimin={lo[2]:.3f}:rimax={hi[0]:.3f}:gimax={hi[1]:.3f}:bimax={hi[2]:.3f}"
                + ("" if night else ",curves=master='0/0.006 0.25/0.232 0.5/0.5 0.75/0.775 1/0.998',eq=saturation=1.06"))
    lo = [min(0.12, 0.6 * c + 0.4 * luma_lo) for c in m.lo]
    hi = [max(0.70, 0.6 * c + 0.4 * luma_hi) for c in m.hi]
    if night:
        lo = [0.0, 0.0, 0.0]
    parts.append(
        "colorlevels="
        f"rimin={lo[0]:.3f}:gimin={lo[1]:.3f}:bimin={lo[2]:.3f}:"
        f"rimax={hi[0]:.3f}:gimax={hi[1]:.3f}:bimax={hi[2]:.3f}"
    )
    if night:
        parts.append("curves=master='0/0.02 0.3/0.26 0.6/0.62 1/0.98'")
        parts.append("colorbalance=rs=0.0:bs=0.0:rm=0.02:bm=-0.02:rh=0.02:bh=-0.02")
        parts.append("eq=saturation=1.08:contrast=1.03")
    else:
        parts.append("curves=master='0/0.03 0.25/0.215 0.5/0.5 0.75/0.79 1/0.99'")
        parts.append("colorbalance=rs=-0.02:bs=0.02:rm=0.012:bm=-0.008:rh=0.012:gh=0.004:bh=-0.006")
        parts.append("eq=saturation=1.16:contrast=1.04")
    return ",".join(parts)


# ---- One low-resolution decode of a shot's window: colour statistics (colour match) and shake (stabilise) ----

PROBE_PX = 320  # frames are read as PROBE_PX x PROBE_PX (aspect squashed): shifts are kept as a share of each side
PROBE_FPS = 30
PROBE_VERSION = 1  # bump when color_stats or shake_of change, so cached probes are measured again


def window_key(src: Path, start: float, length: float) -> str:
    """Cache key for one window of one source: the file (path, size, mtime) and the window to the millisecond.
    A re-render of the same window reuses its probe and its stabilisation transforms."""
    from hashlib import sha1

    try:
        st = src.stat()
        stamp = f"{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        stamp = "missing"
    return sha1(f"{src.resolve()}|{stamp}|{start:.3f}|{length:.3f}".encode("utf-8")).hexdigest()[:20]


def _probe_dir() -> Path:
    d = DATA / "mezz" / "probe"
    d.mkdir(parents=True, exist_ok=True)
    return d


def color_stats(frames: list) -> dict:
    """Mean and spread of a* and b* (CIE Lab), Lab L and luma (Y', 0-1) over a few RGB uint8 frames."""
    rgb = np.concatenate([f.reshape(-1, 3) for f in frames]).astype(np.float32) / 255.0
    lab = cv2.cvtColor(rgb.reshape(-1, 1, 3), cv2.COLOR_RGB2Lab).reshape(-1, 3)
    luma = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    return {
        "L": round(float(lab[:, 0].mean()), 3),
        "a": round(float(lab[:, 1].mean()), 3),
        "b": round(float(lab[:, 2].mean()), 3),
        "aStd": round(float(lab[:, 1].std()), 3),
        "bStd": round(float(lab[:, 2].std()), 3),
        "luma": round(float(luma.mean()), 4),
    }


def shake_of(frames: list, fps: float = PROBE_FPS) -> float | None:
    """Handheld jitter as a percentage of the frame: phase correlation gives the shift between neighbouring
    frames, the shifts add up to the camera path, and the path minus its own 0.5 s moving average is the shake
    (a deliberate pan or walk is slow and stays in the average). Returned as the median of that residue, in %
    of the frame side: a median, so one quick deliberate reframe does not read as shake. None for fewer than
    8 frames. Measured (Nov 2026, 3.6 s windows): DJI aircraft 0.006-0.024, steady phone 0.10-0.18, visibly
    shaky phone 0.28-0.84."""
    if len(frames) < 8:
        return None
    grey = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY).astype(np.float32) for f in frames]
    h, w = grey[0].shape
    win = cv2.createHanningWindow((w, h), cv2.CV_32F)
    steps = [(0.0, 0.0)]
    for a, b in zip(grey, grey[1:]):
        (dx, dy), _ = cv2.phaseCorrelate(a, b, win)
        steps.append((dx / w, dy / h))
    path = np.cumsum(np.array(steps, dtype=np.float64), axis=0)
    k = max(3, int(round(fps * 0.5)) | 1)
    padded = np.pad(path, ((k // 2, k // 2), (0, 0)), mode="edge")
    kernel = np.ones(k) / k
    smooth = np.stack([np.convolve(padded[:, c], kernel, mode="valid") for c in range(2)], axis=1)
    resid = path - smooth
    return round(float(np.median(np.hypot(resid[:, 0], resid[:, 1]))) * 100, 4)


def probe_window(src: Path, start: float, length: float, photo: bool = False) -> dict:
    """Colour statistics (3 frames at 20/50/80 % of the window) and shake (every frame at 30 fps) from one
    low-resolution ffmpeg decode. Cached per source + window in DATA/mezz/probe. Never raises: a failed read
    comes back with "error" set and no numbers."""
    import json
    import time

    cache = _probe_dir() / f"{window_key(src, start, length)}.json"
    if cache.exists():
        try:
            done = json.loads(cache.read_text(encoding="utf-8"))
            if done.get("v") == PROBE_VERSION:
                return done
        except ValueError:
            pass
    t0 = time.monotonic()
    out: dict = {"v": PROBE_VERSION, "color": None, "shake": None, "frames": 0}
    try:
        if photo or src.suffix.lower() in PHOTO_EXT:
            image = cv2.imread(str(flat_photo(src) if src.parent != DATA / "keyframes" else src))
            if image is None:
                raise RuntimeError(f"no picture in {src.name}")
            small = cv2.resize(image, (PROBE_PX, PROBE_PX), interpolation=cv2.INTER_AREA)[..., ::-1]
            out.update(color=color_stats([small]), frames=1)
        else:
            pre = hdr_prefix(src)
            vf = f"fps={PROBE_FPS},scale={PROBE_PX}:{PROBE_PX}:flags=area," + (pre if pre else "") + "format=rgb24"
            proc = subprocess.run(
                [str(ffmpeg_bin()), "-v", "error", "-ss", f"{max(0.0, start):.3f}", "-t", f"{max(0.1, length):.3f}", "-i", str(src),
                 "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                capture_output=True, timeout=600,
            )
            size = PROBE_PX * PROBE_PX * 3
            n = len(proc.stdout) // size
            if n == 0:
                raise RuntimeError((proc.stderr or b"").decode("utf-8", "replace")[-300:] or "no frames")
            frames = np.frombuffer(proc.stdout[: n * size], dtype=np.uint8).reshape(n, PROBE_PX, PROBE_PX, 3)
            picks = sorted({min(n - 1, int(n * f)) for f in (0.2, 0.5, 0.8)})
            out.update(color=color_stats([frames[i] for i in picks]), shake=shake_of(list(frames)), frames=n)
    except Exception as exc:  # measuring never stops a render
        out["error"] = str(exc)[:300]
    out["sec"] = round(time.monotonic() - t0, 2)
    if "error" not in out:
        cache.write_text(json.dumps(out), encoding="utf-8")
    return out


# ---- Colour match: pull each shot's cast part of the way toward the reel's median ----

MATCH_STRENGTH = 0.5
MAX_GAIN = 0.08  # no channel gain moves more than +-8 %
MAX_LUMA = 0.06  # luma moves at most +-6 %
NIGHT_LUMA = 0.22  # the same line look_chain draws: darker shots keep their dark and are not matched


def match_target(stats: list[dict | None]) -> dict | None:
    """The reel's target: the median of each statistic over the shots that take part (day, not 360)."""
    rows = [s for s in stats if s]
    if not rows:
        return None
    return {k: round(float(np.median([r[k] for r in rows])), 4) for k in ("L", "a", "b", "aStd", "bStd", "luma")}


def _lab_to_rgb(L: float, a: float, b: float) -> np.ndarray:
    px = np.array([[[L, a, b]]], dtype=np.float32)
    return np.clip(cv2.cvtColor(px, cv2.COLOR_Lab2RGB).reshape(3).astype(np.float64), 1e-3, 1.0)


def color_correction(stats: dict | None, target: dict | None, strength: float = MATCH_STRENGTH) -> dict:
    """Per-channel gains that move this shot's mean a*/b* `strength` of the way to the target's, at its own
    lightness, and its luma the same share of the way to the target luma. The colour part keeps luma; luma
    is clamped to +-6 % and each final channel gain to +-8 %. Identity (gains 1, empty filter) when the stats
    equal the target. filter is a colorchannelmixer step, placed before look_chain."""
    if not stats or not target:
        return {"gains": [1.0, 1.0, 1.0], "luma": 1.0, "filter": ""}
    weights = np.array([0.299, 0.587, 0.114])
    a = stats["a"] + strength * (target["a"] - stats["a"])
    b = stats["b"] + strength * (target["b"] - stats["b"])
    now = _lab_to_rgb(stats["L"], stats["a"], stats["b"])
    want = _lab_to_rgb(stats["L"], a, b)
    gains = want / now
    gains *= float(weights @ now) / float(weights @ (now * gains))  # colour only: luma unchanged
    luma = 1.0
    if stats.get("luma") and target.get("luma"):
        luma = 1.0 + strength * (target["luma"] / stats["luma"] - 1.0)
        luma = min(1.0 + MAX_LUMA, max(1.0 - MAX_LUMA, luma))
    final = np.clip(gains * luma, 1.0 - MAX_GAIN, 1.0 + MAX_GAIN)
    final = [round(float(g), 4) for g in final]
    if all(abs(g - 1.0) < 0.002 for g in final):
        return {"gains": [1.0, 1.0, 1.0], "luma": round(luma, 4), "filter": ""}
    return {
        "gains": final,
        "luma": round(luma, 4),
        "filter": f"colorchannelmixer=rr={final[0]:.4f}:gg={final[1]:.4f}:bb={final[2]:.4f}",
    }


# ---- Stabilise: handheld phone clips only, two-pass vidstab, transforms cached per source + window ----

# shake_of units (% of the frame side). Calibrated on the ranch's footage (Nov 2026): DJI 0.006-0.024, steady
# phone 0.10-0.18, shaky phone 0.28-0.84; vidstab halved the shaky ones. 0.20 sits in the gap.
SHAKE_AUTO = 0.20
STAB_MODES = ("auto", "off", "on")


def has_vidstab() -> bool:
    """True when the studio's ffmpeg was built with libvidstab (vidstabdetect + vidstabtransform)."""
    global _VIDSTAB
    if _VIDSTAB is None:
        try:
            listing = subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-filters"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60).stdout
            _VIDSTAB = "vidstabdetect" in listing and "vidstabtransform" in listing
        except (OSError, subprocess.SubprocessError):
            _VIDSTAB = False
    return _VIDSTAB


_VIDSTAB: bool | None = None


def is_drone(src: Path, device: str | None = None) -> bool:
    """A DJI aircraft clip (the catalog's device, or DJI's file name). Gimbal footage needs no stabilising."""
    return (device or "").lower() == "dji" or src.name.upper().startswith("DJI_")


def stab_decision(mode: str, shake: float | None, *, photo: bool = False, is360: bool = False, drone: bool = False,
                  ai: bool = False, vidstab: bool = True, threshold: float = SHAKE_AUTO) -> tuple[bool, str]:
    """(stabilise?, reason). Photos, 360 shots, drone clips and AI clips are never stabilised. "off" never;
    "on" every other video clip whatever its shake; "auto" only when the measured shake reaches the threshold."""
    mode = mode if mode in STAB_MODES else "auto"
    if mode == "off":
        return False, "off"
    if photo:
        return False, "photo"
    if is360:
        return False, "360"
    if drone:
        return False, "drone"
    if ai:
        return False, "AI clip"
    if not vidstab:
        return False, "this ffmpeg has no vidstab"
    if mode == "on":
        return True, "on"
    if shake is None:
        return False, "shake not measured"
    if shake >= threshold:
        return True, f"shake {shake:.3f} >= {threshold:g}"
    return False, f"shake {shake:.3f} < {threshold:g}"


def _ffesc(path: Path) -> str:
    """ffmpeg filter arguments treat a drive-letter colon as a separator."""
    return path.resolve().as_posix().replace(":", r"\:")


def stab_transforms(src: Path, start: float, length: float) -> Path:
    """Pass 1 (vidstabdetect) over exactly the frames render_shot reads, cached in DATA/mezz/stab by
    window_key; a re-render reuses the file. Raises RuntimeError when ffmpeg fails."""
    d = DATA / "mezz" / "stab"
    d.mkdir(parents=True, exist_ok=True)
    trf = d / f"{window_key(src, start, length)}.trf"
    if trf.exists() and trf.stat().st_size > 0:
        return trf
    part = trf.with_name(trf.stem + f".{os.getpid()}.part")
    try:
        _run([str(ffmpeg_bin()), "-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(src), "-an",
              "-vf", f"vidstabdetect=shakiness=6:accuracy=9:stepsize=6:result='{_ffesc(part)}'", "-f", "null", "-"], 600)
        os.replace(part, trf)
    finally:
        part.unlink(missing_ok=True)
    return trf


def stab_filter(trf: Path) -> str:
    """Pass 2: smooth the camera path over ~0.5 s each side and zoom just enough that no border shows."""
    return f"vidstabtransform=input='{_ffesc(trf)}':smoothing=15:optzoom=1:interpol=bicubic"


def crop_for(m: Measure, out_w: int, out_h: int, cx: float) -> tuple[int, int, int, int]:
    target = out_w / out_h
    if m.width / m.height >= target:
        ch = m.height - m.height % 2
        cw = int(ch * target)
        cw -= cw % 2
        x = int(round(cx * m.width - cw / 2))
        return cw, ch, max(0, min(m.width - cw, x)), 0
    cw = m.width - m.width % 2
    ch = int(cw / target)
    ch -= ch % 2
    y = int(round(m.cy * m.height - ch / 2))
    return cw, ch, 0, max(0, min(m.height - ch, y))


def _input(src: Path, start: float, length: float, photo: bool) -> list[str]:
    """A still loops for the shot length; motion comes from Remotion's push-in."""
    if photo:
        return ["-loop", "1", "-framerate", "30", "-t", f"{length:.3f}", "-i", str(src)]
    return ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(src)]


def render_shot(
    src: Path,
    start: float,
    seconds: float,
    out: Path,
    size: tuple[int, int],
    pan: tuple[float, float] | None = None,
    speed: float = 1.0,
    keep_audio: bool = True,
    blur: bool = False,
    move: tuple[str, int] | None = None,
    color: str = "",
    stab: Path | None = None,
    natural: bool = False,
) -> Path:
    """natural: a long film's finish (look_chain natural; no vignette, no added grain).
    seconds is the output length. speed < 1 is slow motion. move = (sphere move, direction)
    for a 360 source; a 360 without one gets a calm pan.
    color: a colour-match step (color_correction()["filter"]) laid before the look grade; "" leaves the
    chain exactly as it was. stab: vidstab transforms from stab_transforms() for this window; None (the
    default) does not stabilise. A 360 source ignores both."""
    from studio import sphere

    out.parent.mkdir(parents=True, exist_ok=True)
    out_w, out_h = size
    original = src
    photo = src.suffix.lower() in PHOTO_EXT
    if photo:
        src, start, speed, keep_audio = flat_photo(src), 0.0, 1.0, False
    m = measure(src, start + (0.0 if photo else 0.3))
    if sphere.is_equirect(m.width, m.height, original):
        rough = src.name.startswith("stitch_") if photo else sphere.layout(src) == "dfisheye"
        return _render_360(src, start, seconds, out, size, m, speed, keep_audio and not photo, blur, move or ("pan", 1), photo, rough=rough)
    a, b = pan if pan else (m.cx, m.cx)
    cw, ch, x0, y0 = crop_for(m, out_w, out_h, a)
    _, _, x1, y1 = crop_for(m, out_w, out_h, b)
    source_len = seconds * speed
    t_expr = f"t/{seconds:.3f}"
    x_expr = f"{x0}+({x1}-{x0})*{t_expr}"
    y_expr = f"{y0}+({y1}-{y0})*{t_expr}"
    chain = []
    pre = hdr_prefix(src)
    if pre:
        chain.append(pre.rstrip(","))
    # Stabilise the whole source frame before the moving crop picks its window.
    stab_parts = [stab_filter(stab)] if stab and not photo else []
    chain += stab_parts
    if speed != 1.0:
        chain.append(f"setpts={1/speed:.4f}*PTS")
    color_parts = [color] if color else []
    chain += [
        f"crop={cw}:{ch}:x='{x_expr}':y='{y_expr}'",
        f"scale={out_w}:{out_h}:flags=lanczos",
        *color_parts,
        look_chain(m, natural),
        *([] if natural else ["vignette=angle=PI/8:mode=forward", "noise=alls=4:allf=t+u"]),
        "fps=30",
        "format=yuv420p",
    ]
    portrait_in_wide = m.height > m.width and out_w > out_h
    if portrait_in_wide:
        # A phone held upright, shown in 16:9: the picture whole in the middle,
        # a soft, dark copy of itself behind. Cropping it to a strip would lose the subject.
        pre_parts = [p for p in chain[: 1 if pre else 0]]
        speed_parts = [f"setpts={1/speed:.4f}*PTS"] if speed != 1.0 else []
        # An RGB still graded before split/boxblur crashes ffmpeg 8 (access violation); YUV first.
        photo_parts = ["format=yuv444p"] if photo else []
        head = ",".join(photo_parts + pre_parts + stab_parts + speed_parts + color_parts + [look_chain(m, natural)]) or "null"
        graph = (
            f"[0:v]{head},split[a][b];"
            f"[a]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},boxblur=28:2,eq=brightness=-0.12:saturation=0.8[bg];"
            f"[b]scale=-2:{out_h}:flags=lanczos[fg];"
            f"[bg][fg]overlay=(W-w)/2:0,{'' if natural else 'vignette=angle=PI/8:mode=forward,noise=alls=4:allf=t+u,'}fps=30,format=yuv420p[v]"
        )
        if blur and m.faces:
            piece, last = blur_graph(m.faces)
            graph = piece + ";" + graph.replace("[0:v]", f"[{last}]", 1)
        cmd = [str(ffmpeg_bin()), "-y", *_input(src, start, source_len, photo), "-filter_complex", graph, "-map", "[v]"]
        if keep_audio and speed == 1.0:
            cmd += ["-map", "0:a?"]
    elif blur and m.faces:
        piece, last = blur_graph(m.faces)
        graph = piece + f";[{last}]{','.join(chain)}[v]"
        cmd = [str(ffmpeg_bin()), "-y", *_input(src, start, source_len, photo), "-filter_complex", graph, "-map", "[v]"]
    else:
        cmd = [str(ffmpeg_bin()), "-y", *_input(src, start, source_len, photo), "-vf", ",".join(chain)]
    if keep_audio and speed == 1.0:
        cmd += ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k"]
    else:
        cmd += ["-an"]
    cmd += ["-t", f"{seconds:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "15", str(out)]
    _run(cmd)
    return out


def _render_360(src, start, seconds, out, size, m, speed, keep_audio, blur, move, photo, rough=False) -> Path:
    """A 360 source reframed to a flat (or tiny-planet) shot with an eased virtual-camera move.
    Faces are blurred on the sphere before reprojection, so the blur follows the move.
    rough: stitched here from dual fisheye without lens calibration, so the seams and poles
    do not line up; the camera then stays inside one lens (a pan, no planet)."""
    from studio import sphere

    name, direction = move
    if rough:
        name = "pan"
    script = DATA / "tmp" / "sendcmd" / f"{out.stem}_{uuid4().hex[:8]}.cmd"
    chain = []
    pre = hdr_prefix(src)
    if pre:
        chain.append(pre.rstrip(","))
    fisheye = not photo and sphere.layout(src) == "dfisheye"
    if fisheye:
        chain.append(sphere.DFISHEYE_PRE)
    if speed != 1.0:
        chain.append(f"setpts={1/speed:.4f}*PTS")
    chain += sphere.chain(name, seconds, size, script, direction=direction, yaw0=sphere.lens_centre(direction, seconds) if rough else (m.cx - 0.5) * 360)
    chain += [look_chain(m), "noise=alls=4:allf=t+u", "fps=30", "format=yuv420p"]
    body = ",".join(chain)
    head = [str(ffmpeg_bin()), "-y", *_input(src, start, seconds * speed, photo)]
    if blur and m.faces:
        piece, last = blur_graph(m.faces)
        cmd = head + ["-filter_complex", piece + f";[{last}]{body}[v]", "-map", "[v]"]
        if keep_audio and speed == 1.0:
            cmd += ["-map", "0:a?"]
    else:
        cmd = head + ["-filter_complex", f"[0:v]{body}[v]", "-map", "[v]"]
        if keep_audio and speed == 1.0:
            cmd += ["-map", "0:a?"]
    if keep_audio and speed == 1.0:
        cmd += ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k"]
    else:
        cmd += ["-an"]
    cmd += ["-t", f"{seconds:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "15", str(out)]
    try:
        _run(cmd)
    finally:
        script.unlink(missing_ok=True)
    return out


def before_after(src: Path, t: float, out: Path, size: tuple[int, int] = (1080, 1920)) -> Path:
    """Left half as shot, right half graded, same crop. Proof that a grade happened."""
    if src.suffix.lower() in PHOTO_EXT:
        src, t = flat_photo(src), 0.0
    m = measure(src, t)
    cw, ch, x, y = crop_for(m, size[0], size[1], m.cx)
    base = f"{hdr_prefix(src)}crop={cw}:{ch}:{x}:{y},scale={size[0]}:{size[1]}"
    graph = (
        f"[0:v]{base},split[a][b];"
        f"[b]{look_chain(m)},vignette=angle=PI/8[g];"
        f"[a]crop={size[0]//2}:{size[1]}:0:0[l];"
        f"[g]crop={size[0]//2}:{size[1]}:{size[0]//2}:0[r];"
        "[l][r]hstack,drawbox=x=iw/2-1:y=0:w=3:h=ih:color=white@0.9:t=fill"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([str(ffmpeg_bin()), "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", "-filter_complex", graph, "-update", "1", str(out)], 180)
    return out
