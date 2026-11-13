"""
FILE: py/studio/grade.py
PURPOSE: Grade, reframe to 9:16, and optionally stabilise one clip.
OVERVIEW: ffmpeg does the pixels. A subject-weighted crop drifts from the
          start frame to the end frame. House LUTs live in luts/.
DEPENDENCIES: opencv, numpy, studio.config
USAGE: render_mezz(src, start, duration, lut, out, stabilise=False)
NOTES: Sources are only read. Output is a 1080x1920 H.264 mezzanine.
"""
from __future__ import annotations

import subprocess
import wave as wave_mod
from pathlib import Path

import cv2
import numpy as np

from studio.config import DATA, ffmpeg_bin

OUT_W, OUT_H = 1080, 1920


def ffesc(path: Path) -> str:
    """ffmpeg filtergraphs treat a drive-letter colon as an option separator."""
    return path.resolve().as_posix().replace(":", r"\:")


def _centroid_x(src: Path, t: float) -> float:
    dest = DATA / "keyframes" / "_crop.jpg"
    cmd = [str(ffmpeg_bin()), "-y", "-ss", f"{max(0, t):.3f}", "-i", str(src), "-frames:v", "1", "-vf", "scale=320:-2", str(dest)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        return 0.5
    image = cv2.imread(str(dest))
    if image is None:
        return 0.5
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    energy = np.abs(cv2.Laplacian(gray, cv2.CV_32F))
    energy = cv2.GaussianBlur(energy, (0, 0), 9)
    total = float(energy.sum()) + 1e-6
    xs = np.arange(gray.shape[1], dtype=np.float32)
    return float((energy.sum(axis=0) * xs).sum() / total / gray.shape[1])


def crop_window(width: int, height: int, cx: float) -> tuple[int, int, int, int]:
    """9:16 window inside a frame. cx is 0-1 across the width."""
    target = 9 / 16
    if width / max(height, 1) >= target:
        crop_h = height - height % 2
        crop_w = int(crop_h * target)
        crop_w -= crop_w % 2
        max_x = max(0, width - crop_w)
        x = int(round(cx * width - crop_w / 2))
        x = max(0, min(max_x, x))
        return crop_w, crop_h, x, 0
    crop_w = width - width % 2
    crop_h = int(crop_w / target)
    crop_h -= crop_h % 2
    max_y = max(0, height - crop_h)
    y = max(0, min(max_y, (height - crop_h) // 2))
    return crop_w, crop_h, 0, y


def _run(cmd: list[str]) -> None:
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60 * 20)
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or b"").decode("utf-8", "replace")[-1200:]
        raise RuntimeError(err) from exc


def render_mezz(src: Path, start: float, duration: float, lut: Path, out: Path, width: int, height: int, stabilise: bool = False) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    cx0 = _centroid_x(src, start + 0.2)
    cx1 = _centroid_x(src, start + max(0.2, duration - 0.2))
    w0, h0, x0, y0 = crop_window(width, height, cx0)
    _, _, x1, y1 = crop_window(width, height, cx1)
    dur = max(duration, 0.1)
    x_expr = f"{x0}+({x1}-{x0})*t/{dur:.3f}"
    y_expr = f"{y0}+({y1}-{y0})*t/{dur:.3f}"
    chain = f"crop={w0}:{h0}:x='{x_expr}':y='{y_expr}',scale={OUT_W}:{OUT_H},lut3d='{ffesc(lut)}',eq=saturation=1.04,unsharp=5:5:0.25,noise=alls=3:allf=t+u,format=yuv420p"
    work = src
    if stabilise:
        trf = out.with_suffix(".trf")
        detect = [
            str(ffmpeg_bin()), "-y", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(src),
            "-vf", f"vidstabdetect=shakiness=5:result='{ffesc(trf)}'", "-f", "null", "-",
        ]
        try:
            _run(detect)
            chain = f"vidstabtransform=input='{ffesc(trf)}':smoothing=20:zoom=2," + chain
        except subprocess.SubprocessError:
            pass
    cmd = [
        str(ffmpeg_bin()), "-y", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(work),
        "-vf", chain, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", "30",
        "-c:a", "aac", "-ar", "48000", "-b:a", "160k", str(out),
    ]
    _run(cmd)
    return out


def write_bed(path: Path, seconds: float) -> Path:
    """Original low drone. Not a recording of someone else's track."""
    sr = 48000
    n = int(sr * seconds)
    t = np.arange(n) / sr
    notes = [220.0, 261.63, 329.63, 392.0]
    wave = np.zeros(n, dtype=np.float64)
    for index, freq in enumerate(notes):
        env = 0.5 + 0.5 * np.sin(2 * np.pi * 0.07 * t + index)
        wave += 0.08 * np.sin(2 * np.pi * freq * t) * env
    wave *= 0.15
    pcm = np.clip(wave, -1, 1)
    pcm = (pcm * 32767).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave_mod.open(str(path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(pcm.tobytes())
    return path


def still_mezz(src: Path, lut: Path, out: Path, seconds: float = 3.0) -> Path:
    """A graded 9:16 hold of a photograph, so a photo can sit in a video recipe.

    Pillow writes a clean PNG first. ffmpeg's jpeg decoder leaves a green band
    on these phone files.
    """
    from PIL import Image, ImageOps

    out.parent.mkdir(parents=True, exist_ok=True)
    flat = out.with_suffix(".png")
    with Image.open(src) as image:
        ImageOps.exif_transpose(image).convert("RGB").save(flat)
    _run([
        str(ffmpeg_bin()), "-y", "-loop", "1", "-t", f"{seconds:.2f}", "-i", str(flat),
        "-vf", f"scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},lut3d='{ffesc(lut)}',format=yuv420p",
        "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-an", str(out),
    ])
    return out


def look_grid(src: Path, t: float, out_dir: Path, width: int, height: int) -> list[Path]:
    """One still of this frame through every house LUT, for the owner to pick."""
    from studio.looks import write_luts
    from studio.config import ROOT

    out_dir.mkdir(parents=True, exist_ok=True)
    ref = out_dir / "_ref.jpg"
    _run([str(ffmpeg_bin()), "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", str(ref)])
    written = []
    for lut in write_luts(ROOT / "luts"):
        dest = out_dir / f"{lut.stem}.jpg"
        w, h, x, y = crop_window(width, height, 0.5)
        _run([
            str(ffmpeg_bin()), "-y", "-i", str(ref),
            "-vf", f"crop={w}:{h}:{x}:{y},scale=360:640,lut3d='{ffesc(lut)}'",
            str(dest),
        ])
        written.append(dest)
    return written


def still_of(video: Path, t: float, dest: Path) -> Path:
    _run([str(ffmpeg_bin()), "-y", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", str(dest)])
    return dest


def fit_aspect(src: Path, w: int, h: int, dest: Path) -> Path:
    """Center-crop a 9:16 master into another aspect. Captions were framed for 9:16,
    so 4:5 and 16:9 renders go through Remotion. This is the fallback."""
    _run([
        str(ffmpeg_bin()), "-y", "-i", str(src),
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-ar", "48000",
        "-map_metadata", "-1", str(dest),
    ])
    return dest
