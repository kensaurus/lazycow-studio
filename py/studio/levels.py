"""
FILE: py/studio/levels.py
PURPOSE: The sound level of finished reels: find the ones off the loudness target or peaking over the limit, and fix
         them in place by gain alone (studio.sound.trim_loudness), so a reel already approved and booked gets the same
         sound at the right level without a new render, new words or a new approval.
OVERVIEW: - check(slugs): loudness (LUFS) and true peak of each reel's 9:16 master, and whether it is off.
          - booked(): reels with a booking still ahead (scheduled or queued), soonest first.
          - fix(slug): every copy of the reel (masters, one per network, the approved folder) moved onto the target;
            the masters are kept once as *.orig.mp4 next to them; recorded in sound-fixes.json.
          - fixed_at(slug): when a reel's sound was last fixed by a noticeable amount: a booking made before then holds
            the old sound on its network (the automatic swap re-uploads it, server/swap.mjs).
DEPENDENCIES: ffmpeg, studio.sound, studio.verify, studio.db
USAGE: python -m studio levels check [--booked | --slug a,b] ; python -m studio levels fix (--booked | --slug a,b)
NOTES: Only the sound track is re-encoded; the picture is copied. Words, post text and the review status are not
       touched. A clip-only copy (no music) is left as it is.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from studio.config import DATA, READY, SPEC, ffmpeg_bin

FIX_FILE = DATA / "sound-fixes.json"
OFF_LU = 1.0  # more than this off the loudness target is off
PEAK_MAX = -1.0  # the QA gate's true-peak limit (studio.verify)
NOTICEABLE_LU = 1.5  # a fix this big (or one that cures a peak over the limit) is worth re-uploading a booking for


def _measure(path: Path) -> dict:
    from studio.verify import parse_ebur128

    err = subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0?", "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600).stderr
    return parse_ebur128(err)


def master(slug: str) -> Path:
    return DATA / "renders" / f"story-{slug}" / f"{slug}_9x16.mp4"


def files_of(slug: str) -> list[Path]:
    """Every copy of a reel that carries its scored sound: the three masters, the copies cut for each network, and the
    approved folder(s)."""
    from studio.reels import DRAFTS

    out = DATA / "renders" / f"story-{slug}"
    found = [out / f"{slug}_{a}.mp4" for a in ("9x16", "4x5", "16x9")]
    found += [p for p in (DRAFTS / slug).glob("*/*.mp4") if "_no-music" not in p.name]
    for folder in READY.glob(f"*_{slug}"):
        if folder.is_dir():
            found += [p for p in folder.glob("*.mp4") if "_no-music" not in p.name]
    return [p for p in found if p.exists()]


def is_off(m: dict, target: float | None = None) -> bool:
    target = SPEC["loudnessLufs"] if target is None else target
    if m.get("lufs") is None:
        return False
    return abs(m["lufs"] - target) > OFF_LU or (m.get("truePeak") is not None and m["truePeak"] > PEAK_MAX)


def check(slugs: list[str], workers: int = 8) -> list[dict]:
    from concurrent.futures import ThreadPoolExecutor

    target = SPEC["loudnessLufs"]

    def one(slug: str) -> dict:
        f = master(slug)
        if not f.exists():
            return {"slug": slug, "lufs": None, "truePeak": None, "off": False, "missing": True}
        m = _measure(f)
        return {"slug": slug, "lufs": m.get("lufs"), "truePeak": m.get("truePeak"), "off": is_off(m, target), "target": target}

    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(one, slugs))


def booked(approved_only: bool = True) -> list[str]:
    """Reels with a booking still ahead, soonest first: approved ones, or (approved_only=False) any, e.g. a reel whose new
    version was chosen but not yet made live."""
    from studio.db import connect

    now = datetime.now().isoformat(timespec="minutes")
    with connect() as con:
        # A reel's review record is drafts.slug "story-<slug>" (studio.publish.review_status).
        rows = con.execute("SELECT p.slug, MIN(p.at) AS first FROM posts p JOIN drafts d ON d.slug = 'story-' || p.slug WHERE p.status IN ('scheduled', 'queued') "
                           "AND p.at >= ? " + ("AND d.status = 'approved' " if approved_only else "") + "GROUP BY p.slug ORDER BY first", (now,)).fetchall()
    return [r["slug"] for r in rows]


def _record() -> dict:
    try:
        return json.loads(FIX_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def fixed_at(slug: str) -> str | None:
    r = _record().get(slug) or {}
    return r.get("at") if r.get("noticeable") else None


def _restore(path: Path, orig: Path) -> bool:
    """Put the sound as it was rendered (the kept master) back into one copy, untouched (stream copy), so a fix is
    always one pass from the original and never an encode of an encode."""
    tmp = path.with_name(path.stem + "_orig" + path.suffix)
    proc = subprocess.run([str(ffmpeg_bin()), "-y", "-hide_banner", "-loglevel", "error", "-i", str(path), "-i", str(orig), "-map", "0:v:0", "-map", "1:a:0",
                           "-c", "copy", "-shortest", "-map_metadata", "-1", str(tmp)], capture_output=True, timeout=600)
    if proc.returncode:
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(path)
    return True


def fix(slug: str) -> dict:
    """Move every copy of `slug` onto the loudness target and under the peak limit, by gain alone. A reel already on
    target is left alone. Returns what was measured before and after, and how many files were changed."""
    from studio.sound import trim_loudness

    target = SPEC["loudnessLufs"]
    f = master(slug)
    if not f.exists():
        raise FileNotFoundError(f"{slug}: no rendered master")
    before = _measure(f)
    if not is_off(before, target):
        return {"slug": slug, "changed": 0, "before": before, "after": before}
    orig = f.with_name(f"{slug}_9x16.orig.mp4")
    if orig.exists():  # fixed before and still off: every copy starts again from the sound as rendered
        for p in files_of(slug):
            _restore(p, orig)
        before = _measure(f)
    for a in ("9x16", "4x5", "16x9"):  # the masters as they were, once, so the fix can be undone
        m = f.with_name(f"{slug}_{a}.mp4")
        keep = m.with_name(f"{slug}_{a}.orig.mp4")
        if m.exists() and not keep.exists():
            shutil.copy2(m, keep)
    changed = 0
    for p in files_of(slug):
        if trim_loudness(p, target, tolerance=0.3) != 0.0:
            changed += 1
    after = _measure(f)
    noticeable = abs((before.get("lufs") or target) - (after.get("lufs") or target)) >= NOTICEABLE_LU or (before.get("truePeak") or -99) > PEAK_MAX
    rec = _record()
    rec[slug] = {"at": datetime.now().astimezone().isoformat(timespec="seconds"), "before": before, "after": after, "files": changed,
                 "noticeable": noticeable}
    FIX_FILE.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"slug": slug, "changed": changed, "before": before, "after": after, "noticeable": noticeable}
