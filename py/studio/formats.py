"""
FILE: py/studio/formats.py
PURPOSE: Every kind of footage read the same way before any grade: one probe per file, one normalising filter at
         the head of every render (flat, long film, layer and 360 shots), a check on each finished shot, and a
         plain verdict on a file the studio cannot use.
OVERVIEW: probe() reads a file's picture stream once (cached by path, size and time): codec, pixel format, bit
          depth, range, primaries, transfer, matrix, interlacing, alpha, size, length, sound.
          head() turns that into the filter that brings it to plain 8-bit 4:2:0 BT.709 limited range, the form
          every later filter is known to handle: HDR (HLG, PQ) is tone-mapped, wide-gamut SDR (BT.2020) is
          converted, interlaced video is deinterlaced, full range is brought to limited, and anything deeper than
          8 bits or other than 4:2:0 (10/12-bit, 4:2:2, 4:4:4, RGB, grey, alpha) is converted. A plain 8-bit
          4:2:0 BT.709 file gets "" and its render is unchanged.
          problem() reads a finished shot back (its length and brightness, a few frames a second) and says what is
          wrong with it in plain words, or None. A dark result is only wrong when the source itself was lit.
          verdict() is why a source cannot be used at all (no picture, unreadable, too short), or None.
WHY: ffmpeg's colorlevels turns 10-bit planar RGB black (DJI Osmo 10-bit HEVC, Nov 2026, ffmpeg N-128532), and
     that was only found after 12 reels had rendered for two hours. Normalising first removes that class of fault;
     checking each shot right after it is made catches the next one in seconds, not after the long render.
USAGE: from studio.formats import prefix, problem, verdict
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)
EIGHT_BIT = "format=yuv420p"
DEINTERLACE = "bwdif=mode=send_frame"
HDR_TRANSFERS = ("arib-std-b67", "smpte2084")
INTERLACED = ("tt", "bb", "tb", "bt")

# problem(): a shot is black when most of it sits under BLACK while the source measured at least LIT;
# white the other way round. A night clip (source under LIT) may be as dark as it likes.
BLACK = 0.035
LIT = 0.08
WHITE = 0.97
DARK_SHARE = 0.3  # this share of a shot's sampled frames black (a glitch at one end) is enough
SAMPLE_FPS = 4


@dataclass(frozen=True)
class Source:
    ok: bool
    why: str = ""
    codec: str = ""
    pix_fmt: str = ""
    full_range: bool = False
    primaries: str = ""
    transfer: str = ""
    matrix: str = ""
    interlaced: bool = False
    width: int = 0
    height: int = 0
    duration: float = 0.0
    audio: bool = False


def bits(pix_fmt: str) -> int:
    """Bits a channel of an ffmpeg pixel format: yuv420p 8, yuv420p10le 10, p010le 10, rgb48le 16, gbrpf32le 32."""
    p = pix_fmt.lower()
    for n in ("f32", "f16"):
        if n in p:
            return int(n[1:])
    for n in (16, 14, 12, 10, 9):
        if f"p{n}" in p or f"{n}le" in p or f"{n}be" in p or p.startswith(f"p0{n}") or p.startswith(f"p{n}"):
            return n
    if p.startswith(("rgb48", "bgr48", "rgba64", "bgra64", "ya16")):
        return 16
    return 8


def deep(pix_fmt: str) -> bool:
    """A pixel format with more than 8 bits a channel (yuv420p10le, p010le, gbrp12le, rgb48le ...)."""
    return bits(pix_fmt) > 8


def parse(data: dict) -> Source:
    """A Source from ffprobe's JSON (-show_streams -show_format)."""
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    if not video:
        if not streams:  # nothing ffprobe could read inside: a cut-off copy, a Drive placeholder, not a video at all
            return Source(False, "could not be read (a damaged or unfinished copy?)")
        return Source(False, "has no picture (sound only, or not a video)")
    try:
        duration = float((data.get("format") or {}).get("duration") or video.get("duration") or 0)
    except ValueError:
        duration = 0.0
    pix = str(video.get("pix_fmt") or "")
    return Source(
        ok=bool(pix) or bool(video.get("codec_name")),
        why="" if pix or video.get("codec_name") else "could not be read (a damaged or unfinished copy?)",
        codec=str(video.get("codec_name") or ""),
        pix_fmt=pix,
        full_range=video.get("color_range") in ("pc", "jpeg") or pix.startswith("yuvj"),
        primaries=str(video.get("color_primaries") or ""),
        transfer=str(video.get("color_transfer") or ""),
        matrix=str(video.get("color_space") or ""),
        interlaced=str(video.get("field_order") or "") in INTERLACED,
        width=int(video.get("width") or 0),
        height=int(video.get("height") or 0),
        duration=duration,
        audio=any(s.get("codec_type") == "audio" for s in streams),
    )


_CACHE: dict[tuple, Source] = {}


def probe(src: Path) -> Source:
    """The picture stream of a file, read once per (path, size, time)."""
    from studio.config import ffprobe_bin

    try:
        st = src.stat()
    except OSError:
        return Source(False, "is missing (moved, renamed, or not synced from Drive yet)")
    key = (str(src), st.st_size, st.st_mtime)
    if key in _CACHE:
        return _CACHE[key]
    try:
        run = subprocess.run(
            [str(ffprobe_bin()), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(src)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
        )
        found = parse(json.loads(run.stdout or "{}")) if run.stdout.strip() else Source(
            False, "could not be read (a damaged or unfinished copy?)")
    except (OSError, ValueError, subprocess.SubprocessError):
        found = Source(False, "could not be read (a damaged or unfinished copy?)")
    if len(_CACHE) > 4096:
        _CACHE.clear()
    _CACHE[key] = found
    return found


def head(s: Source) -> str:
    """The filter that brings a source to plain 8-bit 4:2:0 BT.709 limited range; "" when it already is."""
    if not s.ok:
        return ""
    parts = [DEINTERLACE] if s.interlaced else []
    if s.transfer in HDR_TRANSFERS:
        return ",".join(parts + [TONEMAP])
    if s.primaries == "bt2020":
        matrix = "bt2020c" if s.matrix == "bt2020c" else "bt2020nc"
        rng = "pc" if s.full_range else "tv"
        parts.append(f"zscale=pin=bt2020:p=bt709:min={matrix}:m=bt709:tin=bt709:t=bt709:rin={rng}:r=tv,{EIGHT_BIT}")
    elif s.full_range:
        parts.append(f"scale=in_range=pc:out_range=tv,{EIGHT_BIT}")
    elif s.pix_fmt and s.pix_fmt != "yuv420p":
        parts.append(EIGHT_BIT)
    return ",".join(parts)


def prefix(src: Path) -> str:
    """head() of a file with its trailing comma, ready to lead a filter chain; "" for a plain source."""
    h = head(probe(src))
    return h + "," if h else ""


# Containers with no seek index (MPEG transport and program streams: AVCHD camcorders, DVD, broadcast). A fast seek
# before the input can land past the only keyframe and give no picture at all (seen on an interlaced .mts, Nov 2026),
# so these are sought PRE_ROLL seconds short, then exactly the rest on the decoded side.
SEEKLESS = {".mts", ".m2ts", ".m2t", ".ts", ".mpg", ".mpeg", ".vob"}
PRE_ROLL = 10.0


def seek_input(src: Path | str, start: float, length: float | None = None) -> list[str]:
    """ffmpeg arguments that open src at start (seconds), for length seconds when given: ["-ss", t, ("-t", n,) "-i", src]
    for an indexed file, the same as always; for a SEEKLESS one a short seek, the input, then the exact rest. Lay it
    as the last input of a command (what follows -i is read as output options)."""
    start = max(0.0, float(start))
    span = ["-t", f"{length:.3f}"] if length is not None else []
    if Path(src).suffix.lower() not in SEEKLESS:
        return ["-ss", f"{start:.3f}", *span, "-i", str(src)]
    coarse = max(0.0, start - PRE_ROLL)
    return [*(["-ss", f"{coarse:.3f}"] if coarse else []), "-i", str(src), "-ss", f"{start - coarse:.3f}", *span]


MIN_SECONDS = 0.5


def verdict(src: Path) -> str | None:
    """Why this file cannot be used as footage, in plain words; None when it can. Photos are not probed here."""
    from studio.media import STILL

    if src.suffix.lower() in STILL:
        return None if src.exists() else "is missing (moved, renamed, or not synced from Drive yet)"
    s = probe(src)
    if not s.ok:
        return s.why
    if s.duration and s.duration < MIN_SECONDS:
        return f"is only {s.duration:.1f} s long"
    return None


def _measure_out(path: Path) -> tuple[float, list[float]]:
    """(length in seconds, mean brightness 0..1 of each sampled frame) of a rendered shot."""
    from studio.config import ffmpeg_bin, ffprobe_bin

    length = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    ).stdout.strip()
    raw = subprocess.run(
        [str(ffmpeg_bin()), "-v", "error", "-i", str(path), "-vf", f"fps={SAMPLE_FPS},scale=48:48,format=gray",
         "-f", "rawvideo", "-"],
        capture_output=True, timeout=120,
    ).stdout
    size = 48 * 48  # squashed: only the mean counts
    frames = [sum(raw[i:i + size]) / size / 255.0 for i in range(0, len(raw) - size + 1, size)]
    try:
        seconds = float(length)
    except ValueError:
        seconds = 0.0
    return seconds, frames


def problem(out: Path, seconds: float, source_light: float | None) -> str | None:
    """What is wrong with a rendered shot, in plain words, or None. source_light is the source's own mean brightness
    (0..1, studio.shot.measure) at the shot; None judges the shot alone."""
    if not out.exists():
        return None  # nothing was written to judge (a dry run); a failed ffmpeg has already raised
    length, frames = _measure_out(out)
    if not frames:
        return "came out empty (no picture)"
    if seconds and length < min(seconds * 0.85, seconds - 0.25):
        return f"came out short ({length:.1f} s of {seconds:.1f} s)"
    lit = source_light is None or source_light >= LIT
    dark = sum(1 for f in frames if f < BLACK) / len(frames)
    if lit and (sum(frames) / len(frames) < BLACK or dark >= DARK_SHARE):
        return "came out black" if dark > 0.9 else f"came out black for part of it ({dark:.0%})"
    if (source_light is None or source_light <= 0.85) and sum(frames) / len(frames) > WHITE:
        return "came out white"
    return None
