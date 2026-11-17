"""
FILE: py/studio/providers/normalise.py
PURPOSE: Every provider's output turned into the one shape the studio builds with, per capability, whoever made it:
           voice     -> mp3, mono, 44.1 kHz
           music     -> wav, trimmed to the length asked for (a short fade, so the cut never clicks)
           sfx       -> m4a (AAC), from an audio file or from the sound track of a video
           upscale   -> H.264 picture with the clip's own sound put back (Topaz and others return picture only)
           img2video -> a 9:16 H.264 mp4 (1080x1920), no sound
           bg-cut    -> VP9 webm with alpha over the rendered shot: from a mask (BiRefNet) or a cut-out with alpha
OVERVIEW: Each function takes the ffmpeg runner as `ffmpeg(args)` (studio.ai._ffmpeg: the studio's own ffmpeg, an error
          in plain words), so tests swap it. A model marked "conforms" in the registry already gives the right shape and
          is used as it is (fal's defaults), so those files are exactly what they were before the registry.
DEPENDENCIES: ffmpeg (through the runner passed in).
"""
from __future__ import annotations

from pathlib import Path


def voice(src: Path, dest: Path, ffmpeg) -> Path:
    ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", str(dest)])
    return dest


def music(src: Path, dest: Path, seconds: float, ffmpeg) -> Path:
    fade = max(0.0, float(seconds) - 0.5)
    ffmpeg(["-i", str(src), "-vn", "-t", f"{float(seconds):.3f}", "-af", f"afade=t=out:st={fade:.3f}:d=0.5",
            "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(dest)])
    return dest


def sfx(src: Path, dest: Path, ffmpeg) -> Path:
    # The same arguments the foley tool always used to take the sound out of MMAudio's video.
    ffmpeg(["-i", str(src), "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "160k", "-ac", "2", str(dest)])
    return dest


def upscale(got: Path, original: Path, dest: Path, ffmpeg, *, h264: bool = True) -> Path:
    """The upscaled picture with the original window's own sound, so the mix is unchanged."""
    video = ["-c:v", "copy"] if h264 else ["-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p"]
    ffmpeg(["-i", str(got), "-i", str(original), "-map", "0:v:0", "-map", "1:a:0?", *video, "-c:a", "copy", "-shortest", str(dest)])
    return dest


def img2video(src: Path, dest: Path, ffmpeg) -> Path:
    ffmpeg(["-i", str(src), "-map", "0:v:0", "-an", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p",
            "-c:v", "libx264", "-preset", "fast", "-crf", "16", str(dest)])
    return dest


def bg_cut(got: Path, shot: Path, dest: Path, ffmpeg, *, kind: str = "mask") -> Path:
    """kind "mask": a black-and-white mask video becomes the rendered shot's alpha (softened by a pixel).
    kind "alpha": a cut-out that already has alpha is scaled onto the rendered shot's size."""
    if kind == "mask":
        ffmpeg(["-i", str(shot), "-i", str(got), "-filter_complex",
                "[1:v][0:v]scale2ref[m][v];[m]format=gray,gblur=sigma=1.2[a];[v][a]alphamerge,format=yuva420p[out]",
                "-map", "[out]", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-row-mt", "1",
                "-auto-alt-ref", "0", str(dest)])
    else:
        ffmpeg(["-i", str(got), "-i", str(shot), "-filter_complex", "[0:v][1:v]scale2ref[c][v];[c]format=yuva420p[out]",
                "-map", "[out]", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-row-mt", "1",
                "-auto-alt-ref", "0", str(dest)])
    return dest
