"""
FILE: py/studio/verify.py
PURPOSE: Check a rendered master against the reel spec, and a quality gate on the finished picture and sound.
OVERVIEW: verify_master: 1080x1920, 30 fps, H.264, AAC 48 kHz (raises on a miss).
          qa(path): one ffmpeg pass with ebur128 + silencedetect on the sound and blackdetect + freezedetect
          on the picture, parsed from stderr, plus the format checks for that aspect. Never raises on what it
          finds: a "bad" check only flags the render for a person.
DEPENDENCIES: ffmpeg, ffprobe, shared/spec.json (loudnessLufs, formats)
USAGE: verify_master(path) -> dict
       qa(path, aspect="9x16", music=True) -> {"ok": bool, "checks": [{"id", "level", "found", "fix"}], "measured": {...}}
NOTES: Check ids and levels (level is "ok", "warn" or "bad"; ok is False when any check is "bad"):
         format    frame size / codec / fps / audio against spec.formats[aspect]       bad on a miss
         loudness  integrated loudness within +-1.5 LU of spec.loudnessLufs (-14)      warn to +-3 LU, then bad
         peak      true peak <= -1.0 dBTP                                              warn to 0 dBTP, then bad
         black     a black run longer than 0.4 s, not counting the last 1.5 s
                   (the end card fades out)                                            bad
         freeze    a frozen run longer than 2.5 s; photo shots are still on purpose   warn only
         silence   the whole reel silent                                               bad when music was expected,
                                                                                       else warn
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from studio.config import SPEC, ffmpeg_bin, ffprobe_bin

LOUDNESS_TOL = 1.5
LOUDNESS_WARN = 3.0
PEAK_MAX = -1.0
BLACK_MIN = 0.4
END_CARD = 1.5
FREEZE_MIN = 2.5
# Silence covering this share of the reel counts as a silent reel.
SILENT_SHARE = 0.95


def _probe(path: Path) -> dict:
    cmd = [
        str(ffprobe_bin()), "-v", "error",
        "-show_entries", "stream=codec_name,width,height,avg_frame_rate,sample_rate,codec_type:format=format_name",
        "-of", "json", str(path),
    ]
    raw = subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    data = json.loads(raw.stdout)
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), {})
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), {})
    num, _, den = (video.get("avg_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den) if den and float(den) else 0
    return {
        "width": video.get("width"),
        "height": video.get("height"),
        "codec": video.get("codec_name"),
        "fps": round(fps, 3),
        "audio": audio.get("codec_name"),
        "rate": int(audio.get("sample_rate") or 0),
    }


def format_problems(report: dict, width: int = 1080, height: int = 1920) -> list[str]:
    problems = []
    if report["width"] != width or report["height"] != height:
        problems.append("frame")
    if report["codec"] != "h264":
        problems.append("codec")
    if abs(report["fps"] - 30) > 0.2:
        problems.append("fps")
    if report["audio"] != "aac" or report["rate"] != 48000:
        problems.append("audio")
    return problems


def verify_master(path: Path) -> dict:
    report = _probe(path)
    problems = format_problems(report)
    if problems:
        raise SystemExit(f"{path} failed {problems}: {report}")
    return report


# ---- stderr parsers (ffmpeg prints detector results on stderr; these read them back) ----

_NUM = r"(-?(?:\d+(?:\.\d*)?|\.\d+)|-?inf|nan)"


def _num(text: str) -> float | None:
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value == value and abs(value) != float("inf") else None


def parse_duration(stderr: str) -> float | None:
    """The input's length from the 'Duration: 00:00:18.80' line."""
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr)
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def parse_ebur128(stderr: str) -> dict:
    """Integrated loudness (LUFS) and true peak (dBFS) from ebur128's summary. None when absent or -inf
    (a silent track reads I: -70.0 and Peak: -inf)."""
    out: dict = {"lufs": None, "truePeak": None}
    tail = stderr[stderr.rfind("Summary:"):] if "Summary:" in stderr else ""
    m = re.search(r"^\s*I:\s*" + _NUM + r"\s*LUFS", tail, re.M)
    if m:
        out["lufs"] = _num(m.group(1))
    m = re.search(r"True peak:\s*\n\s*Peak:\s*" + _NUM + r"\s*dBFS", tail)
    if m:
        out["truePeak"] = _num(m.group(1))
    return out


def parse_black(stderr: str) -> list[tuple[float, float]]:
    """blackdetect runs: [black_start:0 black_end:1 black_duration:1] -> [(0.0, 1.0)]."""
    runs = []
    for m in re.finditer(r"black_start:\s*" + _NUM + r"\s+black_end:\s*" + _NUM, stderr):
        a, b = _num(m.group(1)), _num(m.group(2))
        if a is not None and b is not None:
            runs.append((a, b))
    return runs


def _open_close(stderr: str, start_key: str, end_key: str, duration: float | None) -> list[tuple[float, float]]:
    """Runs printed as separate start / end lines. A run still open at the end of the file (ffmpeg prints
    no end line then) closes at the file's duration."""
    runs, opened = [], None
    for m in re.finditer(r"(" + re.escape(start_key) + "|" + re.escape(end_key) + r"):\s*" + _NUM, stderr):
        value = _num(m.group(2))
        if value is None:
            continue
        if m.group(1) == start_key:
            opened = value
        elif opened is not None:
            runs.append((opened, value))
            opened = None
    if opened is not None and duration is not None and duration > opened:
        runs.append((opened, duration))
    return runs


def parse_freeze(stderr: str, duration: float | None = None) -> list[tuple[float, float]]:
    return _open_close(stderr, "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end", duration)


def parse_silence(stderr: str, duration: float | None = None) -> list[tuple[float, float]]:
    return _open_close(stderr, "silence_start", "silence_end", duration)


# ---- the checks (pure: measured numbers in, check rows out) ----


def _row(cid: str, level: str, found: str, fix: str = "") -> dict:
    return {"id": cid, "level": level, "found": found, "fix": fix}


def _span(a: float, b: float) -> str:
    return f"{b - a:.1f} s at {a:.1f}-{b:.1f} s"


def loudness_check(lufs: float | None, target: float | None = None) -> dict:
    target = SPEC["loudnessLufs"] if target is None else target
    if lufs is None:
        return _row("loudness", "bad", "no loudness measured (no sound?)", "Re-mix the reel (Music > Remix).")
    off = lufs - target
    found = f"{lufs:.1f} LUFS (target {target:g}, {off:+.1f} LU)"
    if abs(off) <= LOUDNESS_TOL:
        return _row("loudness", "ok", found)
    level = "warn" if abs(off) <= LOUDNESS_WARN else "bad"
    return _row("loudness", level, found, f"Re-mix the reel; the mix should land within {LOUDNESS_TOL:g} LU of {target:g} LUFS.")


def peak_check(peak: float | None) -> dict:
    if peak is None:
        return _row("peak", "ok", "no peak (silent)")
    found = f"{peak:.1f} dBTP (limit {PEAK_MAX:g})"
    if peak <= PEAK_MAX:
        return _row("peak", "ok", found)
    return _row("peak", "warn" if peak <= 0.0 else "bad", found, "Lower the music or effects and re-mix; peaks above -1 dBTP clip after the networks re-encode.")


def black_check(runs: list[tuple[float, float]], duration: float | None) -> dict:
    """Black longer than 0.4 s anywhere but the last 1.5 s (the end card's fade)."""
    limit = (duration - END_CARD) if duration else None
    long = []
    for a, b in runs:
        if limit is not None:
            b = min(b, limit)
        if b - a > BLACK_MIN:
            long.append((a, b))
    if not long:
        return _row("black", "ok", "no black run over 0.4 s")
    return _row("black", "bad", "black " + "; ".join(_span(a, b) for a, b in long),
                "A shot is black there: check its window in the source (or its AI clip) and render again.")


def freeze_check(runs: list[tuple[float, float]]) -> dict:
    long = [(a, b) for a, b in runs if b - a > FREEZE_MIN]
    if not long:
        return _row("freeze", "ok", "no frozen run over 2.5 s")
    return _row("freeze", "warn", "still picture " + "; ".join(_span(a, b) for a, b in long),
                "Fine for a photo shot. For a video shot, check that the clip is not stuck on one frame.")


def silence_check(runs: list[tuple[float, float]], duration: float | None, music: bool, has_audio: bool = True) -> dict:
    if not has_audio:
        return _row("silence", "bad" if music else "warn", "no audio track", "Re-mix the reel (Music > Remix).")
    quiet = sum(b - a for a, b in runs)
    if duration and quiet >= SILENT_SHARE * duration:
        if music:
            return _row("silence", "bad", f"silent for {quiet:.1f} of {duration:.1f} s, though music was chosen",
                        "The music did not reach the mix: re-mix, or pick another track.")
        return _row("silence", "warn", f"silent for {quiet:.1f} of {duration:.1f} s (no music chosen)", "Add music or keep the clip sound.")
    return _row("silence", "ok", "sound present")


def _aspect_of(path: Path) -> str | None:
    for name in SPEC["formats"]:
        if path.stem.endswith("_" + name):
            return name
    return None


def qa(path: Path, aspect: str | None = None, music: bool = True) -> dict:
    """The quality gate for one finished master. One ffmpeg pass reads every detector; the format checks
    reuse verify_master's rules for the aspect's size (spec.formats). Never raises for what it finds."""
    import time

    path = Path(path)
    t0 = time.monotonic()
    aspect = aspect or _aspect_of(path)
    report = _probe(path)
    fmt = SPEC["formats"].get(aspect or "") or {"w": report["width"], "h": report["height"]}
    has_audio = bool(report["audio"])
    video = "[0:v]blackdetect=d=0.4:pic_th=0.98:pix_th=0.10,freezedetect=n=0.003:d=2.5[v]"
    audio = "[0:a]ebur128=peak=true:framelog=verbose,silencedetect=n=-50dB:d=1[a]"
    graph, maps = (video + ";" + audio, ["-map", "[v]", "-map", "[a]"]) if has_audio else (video, ["-map", "[v]"])
    proc = subprocess.run(
        [str(ffmpeg_bin()), "-hide_banner", "-nostats", "-i", str(path), "-filter_complex", graph, *maps, "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
    )
    err = proc.stderr or ""
    duration = parse_duration(err)
    loud = parse_ebur128(err) if has_audio else {"lufs": None, "truePeak": None}
    problems = format_problems(report, fmt["w"], fmt["h"])
    checks = [
        _row("format", "bad" if problems else "ok", f"{report['width']}x{report['height']} {report['codec']} {report['fps']:g} fps, {report['audio']} {report['rate']} Hz"
             + (f" (miss: {', '.join(problems)})" if problems else ""), "Render again; the encoder settings were overridden." if problems else ""),
    ]
    if proc.returncode:
        checks.append(_row("scan", "bad", "ffmpeg could not read the file: " + err.strip().splitlines()[-1][:200] if err.strip() else "ffmpeg failed", "Render again."))
    else:
        checks += [
            loudness_check(loud["lufs"]) if has_audio else silence_check([], duration, music, has_audio=False),
            peak_check(loud["truePeak"]),
            black_check(parse_black(err), duration),
            freeze_check(parse_freeze(err, duration)),
        ]
        if has_audio:
            checks.append(silence_check(parse_silence(err, duration), duration, music))
    return {
        "ok": not any(c["level"] == "bad" for c in checks),
        "checks": checks,
        "measured": {"aspect": aspect, "durationSec": duration, **loud, "sec": round(time.monotonic() - t0, 2)},
    }


def qa_all(masters: dict[str, Path], music: bool = True) -> dict[str, dict]:
    """qa for every aspect at once (the passes run side by side; each is about a second)."""
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=max(1, len(masters))) as pool:
        futures = {k: pool.submit(qa, Path(v), k, music) for k, v in masters.items()}
        out = {}
        for k, f in futures.items():
            try:
                out[k] = f.result()
            except Exception as exc:  # the gate never stops a render
                out[k] = {"ok": False, "checks": [_row("scan", "bad", f"qa failed: {exc}"[:300], "Render again.")], "measured": {"aspect": k}}
        return out
