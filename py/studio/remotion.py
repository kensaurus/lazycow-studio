"""
FILE: py/studio/remotion.py
PURPOSE: Run a Remotion composition to a file (with frame progress for the studio's job board) and lay a loudness-
         normalised master's sound: the two steps every render needs. Kept from the first-cut renderer when the
         brief pipeline (briefs, deliver, edl, compare, render) was retired.
DEPENDENCIES: npx remotion (repo root), ffmpeg
USAGE: from studio.remotion import _remotion, _loud
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from studio.config import ROOT, SPEC, ffmpeg_bin, ffprobe_bin


def _remotion(composition: str, props: Path, out: Path) -> bool:
    npx = shutil.which("npx") or "npx"
    cmd = [
        npx, "remotion", "render", "src/index.ts", composition, str(out),
        f"--props={props}", "--concurrency=4",
    ]
    log = out.with_suffix(".log")
    log.parent.mkdir(parents=True, exist_ok=True)
    # Stream the log so the editor can show frames as they render, not one jump per stage.
    proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    try:
        with log.open("w", encoding="utf-8") as handle:
            for line in proc.stdout:
                handle.write(line)
                hit = re.search(r"Rendered (\d+)/(\d+)", line)
                if hit and (int(hit.group(1)) % 5 == 0 or hit.group(1) == hit.group(2)):
                    print(f"PROGRESS {hit.group(1)}/{hit.group(2)} rendering {composition}", flush=True)
        code = proc.wait(timeout=60 * 45)
    except (subprocess.SubprocessError, OSError):
        proc.kill()
        return False
    return code == 0 and out.exists()


def _has_audio(path: Path) -> bool:
    probe = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    return bool((probe.stdout or "").strip())


def _loud(src: Path, dest: Path, bed: Path | None) -> None:
    """Natural master keeps the take. Scored master lays the original bed under it.
    A clip with no audio gets silence, or the bed alone when one was asked for.
    """
    ff = str(ffmpeg_bin())
    level = SPEC["loudnessLufs"]
    tail = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-map_metadata", "-1", "-shortest", str(dest)]
    if not _has_audio(src):
        if bed:
            filt = f"[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I={level}:TP=-1.5:LRA=11[a]"
            cmd = [ff, "-y", "-i", str(src), "-i", str(bed), "-filter_complex", filt, "-map", "0:v", "-map", "[a]", *tail]
        else:
            cmd = [ff, "-y", "-i", str(src), "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v", "-map", "1:a", *tail]
    elif bed:
        filt = f"[0:a][1:a]amix=inputs=2:duration=first:weights='1 0.2':normalize=0,loudnorm=I={level}:TP=-1.5:LRA=11[a]"
        cmd = [ff, "-y", "-i", str(src), "-i", str(bed), "-filter_complex", filt, "-map", "0:v", "-map", "[a]", *tail]
    else:
        cmd = [ff, "-y", "-i", str(src), "-af", f"loudnorm=I={level}:TP=-1.5:LRA=11", "-map", "0:v", "-map", "0:a", *tail]
    subprocess.run(cmd, check=True, capture_output=True, timeout=60 * 15)
