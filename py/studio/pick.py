"""
FILE: py/studio/pick.py
PURPOSE: Find the best few seconds of a clip, and whether a face is in them.
OVERVIEW: Decodes small grey frames, scores sharpness and motion per frame,
          and returns the window with the highest mean score. Long drone files
          decode keyframes only, so a 200 s 5.4K clip is read in seconds.
DEPENDENCIES: ffmpeg, numpy, opencv (YuNet face model from studio.shots)
USAGE: best_window(src, seconds) -> (start, score_info); faces_at(src, start, seconds) -> int
NOTES: Research rule (2026-11-07): keep the 1-2 s where something moves, cut the
       shaky head and tail. The first and last 0.3 s are never picked.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np

from studio.config import DATA, ffmpeg_bin, ffprobe_bin

W = 160


def _duration(src: Path) -> float:
    out = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    ).stdout.strip()
    return float(out or 0)


def _frames(src: Path, fps: float, keyframes: bool) -> tuple[np.ndarray, list[float]]:
    pre = ["-skip_frame", "nokey"] if keyframes else []
    vf = f"scale={W}:-2,format=gray" if keyframes else f"fps={fps},scale={W}:-2,format=gray"
    cmd = [str(ffmpeg_bin()), *pre, "-i", str(src), "-vf", vf, "-fps_mode", "vfr", "-an", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    probe = subprocess.run(
        [str(ffmpeg_bin()), *pre, "-i", str(src), "-vf", vf, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
        capture_output=True, timeout=120,
    )
    first = cv2.imdecode(np.frombuffer(probe.stdout, np.uint8), cv2.IMREAD_GRAYSCALE)
    if first is None:
        return np.zeros((0, 1, 1), np.uint8), []
    h, w = first.shape
    proc = subprocess.run(cmd, capture_output=True, timeout=900)
    if proc.returncode != 0:
        raise RuntimeError("frame sampling failed: " + proc.stderr.decode("utf-8", "replace")[-400:])
    raw = proc.stdout
    n = len(raw) // (w * h)
    frames = np.frombuffer(raw[: n * w * h], np.uint8).reshape(n, h, w)
    dur = _duration(src)
    times = list(np.linspace(0, max(dur - 0.05, 0), n)) if n else []
    return frames, times


def best_window(src: Path, seconds: float, speed: float = 1.0, avoid: list | None = None) -> dict:
    """Start time of the best window of `seconds` output (seconds*speed of source).
    avoid: [(start, end), ...] of the source already shown elsewhere (another video of the same trip). The best window
    that does not overlap them wins; when every window overlaps, the one overlapping least. "free" is the start the
    window would have had without `avoid` (the caller can tell whether the moment moved)."""
    spans = [(float(a), float(b)) for a, b in (avoid or [])]
    dur = _duration(src)
    need = seconds * speed
    if dur <= need + 0.6:
        return {"start": max(0.0, (dur - need) / 2), "score": None, "duration": dur, "method": "whole clip"}
    long_file = dur > 40
    frames, times = _frames(src, 4.0, keyframes=long_file)
    if len(frames) < 3:
        raise RuntimeError(f"picker read {len(frames)} frames from {src}; refusing to guess a window")
    sharp = np.array([cv2.Laplacian(f, cv2.CV_32F).var() for f in frames], np.float32)
    motion = np.zeros(len(frames), np.float32)
    motion[1:] = np.abs(frames[1:].astype(np.int16) - frames[:-1].astype(np.int16)).mean(axis=(1, 2))
    expo = frames.mean(axis=(1, 2)) / 255.0
    z = lambda a: (a - a.mean()) / (a.std() + 1e-6)
    score = z(np.log1p(sharp)) + 0.6 * z(motion) - 2.0 * ((expo < 0.06) | (expo > 0.96))
    if long_file:
        motion_cap = np.percentile(motion, 90)
        score -= 1.5 * (motion > motion_cap * 1.5)
    t = np.array(times)
    best, best_s, free, free_s, least = None, -1e9, None, -1e9, None
    overlap = lambda a, b: sum(max(0.0, min(b, y) - max(a, x)) for x, y in spans)  # noqa: E731
    # Long files are drone flights: the first 10% is the take-off and the last 15% the landing.
    lo, hi = (0.10 * dur, 0.85 * dur) if long_file else (0.3, dur - 0.3)
    for i, start in enumerate(t):
        if start < lo or start + need > hi:
            continue
        mask = (t >= start) & (t <= start + need)
        if mask.sum() == 0:
            continue
        s = float(score[mask].mean())
        if s > free_s:
            free, free_s = float(start), s
        ov = overlap(float(start), float(start) + need) if spans else 0.0
        if ov <= 0.05 and s > best_s:
            best, best_s = float(start), s
        if ov > 0.05 and (least is None or (ov, -s) < least[0]):
            least = ((ov, -s), float(start), s)
    if best is None and least is not None:  # every window was shown before: the one that repeats least
        best, best_s = least[1], least[2]
    if best is None:
        best = 0.3
    return {"start": round(best, 2), "score": round(best_s, 3), "duration": round(dur, 2), "method": "keyframes" if long_file else "4 fps",
            "free": round(free if free is not None else best, 2)}


_FACE = None


def faces_at(src: Path, start: float, seconds: float) -> int:
    """Largest number of faces YuNet sees in three frames of the window."""
    global _FACE
    model = DATA / "bin" / "face_detection_yunet_2023mar.onnx"
    if not model.exists():
        return -1
    if _FACE is None:
        _FACE = cv2.FaceDetectorYN.create(str(model), "", (320, 320), 0.75)
    most = 0
    from studio.shot import PHOTO_EXT, flat_photo

    if src.suffix.lower() in PHOTO_EXT:
        img = cv2.imread(str(flat_photo(src)))
        if img is None:
            return -1
        scale = 640 / max(img.shape[1], 1)
        img = cv2.resize(img, (640, max(2, int(img.shape[0] * scale))))
        _FACE.setInputSize((img.shape[1], img.shape[0]))
        _, found = _FACE.detect(img)
        return 0 if found is None else len(found)
    for k in (0.2, 0.5, 0.8):
        t = start + seconds * k
        png = subprocess.run(
            [str(ffmpeg_bin()), "-ss", f"{t:.2f}", "-i", str(src), "-frames:v", "1", "-vf", "scale=640:-2", "-f", "image2pipe", "-vcodec", "png", "-"],
            capture_output=True, timeout=120,
        ).stdout
        if not png:
            continue
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            continue
        _FACE.setInputSize((img.shape[1], img.shape[0]))
        _, found = _FACE.detect(img)
        most = max(most, 0 if found is None else len(found))
    return most
