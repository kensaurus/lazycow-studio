"""
FILE: py/studio/quality.py
PURPOSE: What a long video must not show or play: a blurry picture, a clip too shaky to steady, and wind. Measured once
         per file (cached by path, size and time) so a plan can leave them out and a build can clean the sound.
OVERVIEW: - Sharpness. The library's `sharp` is the variance of the Laplacian over the whole frame, which reads a
            sharp animal against a soft background as blurry. peak_sharp() takes the 90th percentile of 4x4 tiles,
            the sharpest part. A picture is blurry when BOTH are under the trip's own floor (percentiles of this
            library, per kind): a fixed number does not carry from one camera to another (PyImageSearch, "Blur
            detection with OpenCV"; arXiv 1908.04929 on adaptive thresholds).
          - Shake. studio.shot.shake_of over a 3 s window, in % of the frame (steady phone 0.10-0.18, shaky
            0.28-0.84). Steadying fixes the middle; SHAKE_MAX and over is left out.
          - Wind. The share of the sound's energy under 150 Hz, per 64 ms frame: its median says steady wind or rumble,
            its 90th percentile says gusts. Measured on a safari trip's clips (13 Nov): clean clips 0-0.05 median, windy ones
            0.14-0.44 (gusts 0.55-0.8). Owner, 13 Nov: "the wind audio is really bad we hate it."
          cleanup() decides and apply_cleanup() writes it: a windy clip turned down (or cleaned when someone speaks);
          calm ones get a light rumble cut.
DEPENDENCIES: numpy, opencv (cv2), studio.shot (probe_window), studio.config (DATA, ffmpeg_bin)
USAGE: python -m studio quality scan   (every picture and clip; a vlog plan reads the cache)
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import numpy as np

from studio.config import DATA, ffmpeg_bin

CACHE = DATA / "quality.json"
VERSION = 2
BLUR_PCT = 15          # under this percentile of the trip, on both measures, a picture is blurry
KEEP_AES_PCT = 75     # ... unless the aesthetic model rates it at or over this percentile (a smooth sunset is not blur)
SHAKE_MAX = 0.5        # % of the frame: past what steadying can save without a wobbling, cropped picture
WIND_MEDIAN = 0.12     # share of energy under 150 Hz, median frame: steady wind or rumble
WIND_GUST = 0.45       # ... 90th percentile frame: gusts
_cache: dict | None = None


def _key(path: str) -> str:
    try:
        st = os.stat(path)
        return f"{path}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        return path


def load() -> dict:
    global _cache
    if _cache is None:
        try:
            raw = json.loads(CACHE.read_text(encoding="utf-8"))
            _cache = raw.get("items", {}) if raw.get("version") == VERSION else {}
        except (OSError, ValueError):
            _cache = {}
    return _cache


def save() -> None:
    if _cache is not None:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": VERSION, "items": _cache}), encoding="utf-8")
        tmp.replace(CACHE)


def peak_sharp(images: list) -> float | None:
    """The sharpest part of the pictures: 90th percentile of the Laplacian variance of 4x4 tiles (grey, 640 px wide)."""
    import cv2

    best = None
    for img in images:
        if img is None:
            continue
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        h, w = g.shape
        if w > 640:
            g = cv2.resize(g, (640, int(h * 640 / w)), interpolation=cv2.INTER_AREA)
            h, w = g.shape
        tiles = [g[r * h // 4:(r + 1) * h // 4, c * w // 4:(c + 1) * w // 4] for r in range(4) for c in range(4)]
        v = float(np.percentile([cv2.Laplacian(t, cv2.CV_64F).var() for t in tiles], 90))
        best = v if best is None else max(best, v)
    return best


def wind_of(samples: np.ndarray, rate: int = 16000) -> dict:
    """Wind in mono samples: {"low": median share under 150 Hz, "gust": its 90th percentile, "db": level}."""
    n = 1024
    if samples.size < n * 4:
        return {"low": 0.0, "gust": 0.0, "db": -90.0}
    frames = samples[: samples.size // n * n].reshape(-1, n) * np.hanning(n)
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    f = np.fft.rfftfreq(n, 1 / rate)
    share = spec[:, f < 150].sum(1) / (spec.sum(1) + 1e-12)
    loud = frames.std(1) > 1e-4  # silent frames say nothing about wind
    share = share[loud] if loud.any() else share
    return {"low": round(float(np.median(share)), 3), "gust": round(float(np.percentile(share, 90)), 3),
            "db": round(float(10 * np.log10(np.mean(samples ** 2) + 1e-12)), 1)}


def windy(w: dict | None) -> bool:
    return bool(w) and (w.get("low", 0) >= WIND_MEDIAN or w.get("gust", 0) >= WIND_GUST) and w.get("db", -90) > -50


def audio_of(path: str | Path, start: float = 0.0, sec: float | None = None, rate: int = 16000) -> np.ndarray:
    cmd = [str(ffmpeg_bin()), "-v", "error", "-ss", f"{max(0.0, start):.3f}", "-i", str(path)]
    if sec:
        cmd += ["-t", f"{sec:.3f}"]
    cmd += ["-map", "0:a:0?", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, timeout=300).stdout
    return np.frombuffer(out, dtype=np.float32)


def measure(item: dict) -> dict:
    """Peak sharpness (pictures from the library's keyframes), and for a clip its shake and wind. Cached."""
    import cv2

    cache = load()
    k = _key(item["path"])
    if k in cache:
        return cache[k]
    thumbs = item.get("thumbs") or []
    if isinstance(thumbs, str):
        try:
            thumbs = json.loads(thumbs)
        except ValueError:
            thumbs = [thumbs]
    out: dict = {"peak": peak_sharp([cv2.imread(str(t)) for t in thumbs if t and Path(t).exists()])}
    if item.get("kind") == "video":
        dur = float(item.get("duration") or 0)
        mid = max(0.0, dur / 2 - 1.5)
        try:
            from studio.shot import probe_window

            out["shake"] = probe_window(Path(item["path"]), mid, min(3.0, max(1.0, dur))).get("shake")
        except Exception:  # noqa: BLE001 - an unreadable clip is not shaky, only unmeasured
            out["shake"] = None
        try:
            out["wind"] = wind_of(audio_of(item["path"], 0, min(60.0, dur or 60.0)))
        except Exception:  # noqa: BLE001
            out["wind"] = None
    cache[k] = out
    return out


def floors(items: list[dict]) -> dict:
    """The trip's own blur floors, per kind: BLUR_PCT percentile of the whole-frame and the peak sharpness."""
    out = {}
    for kind in ("photo", "video"):
        mine = [i for i in items if (i.get("kind") == "video") == (kind == "video")]
        whole = [float(i.get("sharp") or 0) for i in mine if i.get("sharp")]
        peak = [m["peak"] for m in (load().get(_key(i["path"])) for i in mine) if m and m.get("peak")]
        out[kind] = {"whole": float(np.percentile(whole, BLUR_PCT)) if len(whole) >= 20 else None,
                     "peak": float(np.percentile(peak, BLUR_PCT)) if len(peak) >= 20 else None}
    aes = [float(i["aesthetic"]) for i in items if i.get("aesthetic") is not None]
    out["aes"] = float(np.percentile(aes, KEEP_AES_PCT)) if len(aes) >= 20 else None
    return out


def why_not(item: dict, fl: dict) -> str | None:
    """"blurry", "shaky", or None when the picture may be used (unmeasured counts as usable)."""
    m = load().get(_key(item["path"])) or {}
    f = fl.get("video" if item.get("kind") == "video" else "photo") or {}
    whole = float(item.get("sharp") or 0)
    if f.get("whole") is not None and whole and whole < f["whole"]:
        if f.get("peak") is None or m.get("peak") is None or m["peak"] < f["peak"]:
            # A sunset or a silhouette is smooth on purpose: one the aesthetic model rates among the trip's best stays.
            if not (fl.get("aes") is not None and item.get("aesthetic") is not None and float(item["aesthetic"]) >= fl["aes"]):
                return "blurry"
    if item.get("kind") == "video" and m.get("shake") is not None and m["shake"] >= SHAKE_MAX:
        return "shaky"
    return None


def cleanup(wind: dict | None, speech: bool | None) -> dict:
    """How a clip's sound goes into a long video: a windy clip with nobody speaking is turned right down (the music
    carries it); with speech (or when nobody knows), wind rumble is cut and the noise floor lowered; a calm clip only
    loses rumble under 70 Hz. {"gain", "filter", "why", "tag"}: tag names the cleaned file."""
    if windy(wind) and speech is False:
        return {"gain": 0.12, "filter": "highpass=f=200,afftdn=nf=-30:tn=1,lowpass=f=9000", "why": "wind, no speech: kept quiet under the music", "tag": "w0"}
    if windy(wind):
        return {"gain": 1.0, "filter": "highpass=f=160,afftdn=nf=-28:tn=1,lowpass=f=9000", "why": "wind under speech: rumble cut, noise lowered", "tag": "w1"}
    return {"gain": 1.0, "filter": "highpass=f=70,afftdn=nf=-22", "why": "calm: rumble cut", "tag": "c"}


def apply_cleanup(src: Path, dest: Path, how: dict, video: bool = True) -> Path:
    """Write `src` with its sound through `how` (cleanup()); the picture is copied untouched. Kept when it exists."""
    if not dest.exists():
        cmd = [str(ffmpeg_bin()), "-y", "-v", "error", "-i", str(src)]
        cmd += ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"] if video else ["-vn", "-map", "0:a:0"]
        cmd += ["-af", f"{how['filter']},volume={how['gain']}", "-c:a", "aac", "-b:a", "192k", str(dest.with_name(dest.stem + ".part" + dest.suffix))]
        subprocess.run(cmd, check=True, capture_output=True, timeout=600)
        dest.with_name(dest.stem + ".part" + dest.suffix).replace(dest)
    return dest


def scan(items: list[dict] | None = None) -> dict:
    """Measure every picture and clip of the library (cached; a second run only measures new files)."""
    from studio.library import _base_items

    items = items if items is not None else [i for i, _ in _base_items()]
    todo = [i for i in items if _key(i["path"]) not in load()]
    for n, it in enumerate(todo, 1):
        measure(it)
        if n % 25 == 0:
            save()
            print(f"PROGRESS {n}/{len(todo)} measured", flush=True)
    save()
    fl = floors(items)
    verdicts = [why_not(i, fl) for i in items]
    return {"items": len(items), "measured": len(todo), "floors": fl,
            "blurry": verdicts.count("blurry"), "shaky": verdicts.count("shaky"),
            "windy": sum(1 for i in items if windy((load().get(_key(i["path"])) or {}).get("wind")))}


if __name__ == "__main__":
    import sys

    if sys.argv[1:2] == ["scan"]:
        print(json.dumps(scan(), indent=1))
    else:
        print("usage: python -m studio quality scan")
