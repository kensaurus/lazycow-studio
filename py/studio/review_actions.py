"""
FILE: py/studio/review_actions.py
PURPOSE: Approve, reject, consent, and re-roll a draft.
OVERVIEW: Approve copies into the Drive ready folder: for a story reel, its whole
          set of channel folders (video, no-music copy, cover, post, credits); for
          older drafts, the 9:16 master, cover and caption. A face on camera needs
          consent first.
DEPENDENCIES: studio.db, studio.config
USAGE: approve(slug)
NOTES: The source tree is not modified. Ready is a new folder under the SNS edit dir.
"""
from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path

from studio.config import READY
from studio.db import connect


def _row(slug: str):
    with connect() as con:
        row = con.execute("SELECT * FROM drafts WHERE slug = ?", (slug,)).fetchone()
    if not row:
        raise SystemExit(f"no draft {slug}")
    return row


def list_drafts() -> list[dict]:
    with connect() as con:
        rows = con.execute("SELECT slug, recipe, status, faces, consent, notes, render_natural, render_scored FROM drafts ORDER BY id").fetchall()
    return [dict(row) for row in rows]


def set_note(slug: str, status: str, note: str) -> None:
    with connect() as con:
        con.execute("UPDATE drafts SET status = ?, notes = ? WHERE slug = ?", (status, note, slug))


def consent(slug: str) -> None:
    with connect() as con:
        con.execute("UPDATE drafts SET consent = 1 WHERE slug = ?", (slug,))


def _blurred(slug: str) -> bool:
    """A reel rendered with Blur faces needs no consent tick: the face is not recognisable."""
    from studio.projects import load

    name = slug[len("story-"):] if slug.startswith("story-") else slug
    project = load(name)
    return bool(project and project.get("blurFaces"))


def _copy_readable(src, dst):
    """Copy one file into the ready folder; one Google Drive has locked for good (12 Nov: not even readable) is left out
    with a note instead of failing the approval. That network's post then shows in Needs a look if it lacks the file."""
    try:
        return shutil.copy2(src, dst)
    except PermissionError as err:
        print(f"NOTE {Path(src).parent.name}: {Path(src).name} could not be read ({err.strerror or err}); left out of ready", flush=True)
        return dst


def approve(slug: str) -> Path:
    row = _row(slug)
    if row["faces"] and not row["consent"] and not _blurred(slug):
        raise SystemExit("faces on camera: tick consent before approve, or turn on Blur faces and render again")
    natural = Path(row["render_natural"] or "")
    if not natural.exists():
        raise SystemExit("natural master is not rendered yet")
    if slug.startswith("story-"):
        from studio.reels import DRAFTS

        drafts = DRAFTS / slug[len("story-"):]
        if drafts.is_dir():
            # One folder per network, ready to post: video(s), cover, post text, credits.
            folder = READY / f"{date.today().strftime('%Y%m%d')}_{slug[len('story-'):]}"
            shutil.copytree(drafts, folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns("desktop.ini", "*.old-*"), copy_function=_copy_readable)
            with connect() as con:
                con.execute("UPDATE drafts SET status = 'approved' WHERE slug = ?", (slug,))
            return folder
    folder = READY / f"{date.today().strftime('%Y%m%d')}_{slug}"
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copy2(natural, folder / f"{slug}_9x16.mp4")
    if row["render_scored"] and Path(row["render_scored"]).exists():
        shutil.copy2(row["render_scored"], folder / f"{slug}_9x16_scored.mp4")
    if row["cover"] and Path(row["cover"]).exists():
        shutil.copy2(row["cover"], folder / "cover.jpg")
    if row["caption_txt"] and Path(row["caption_txt"]).exists():
        shutil.copy2(row["caption_txt"], folder / "caption.txt")
    with connect() as con:
        con.execute("UPDATE drafts SET status = 'approved' WHERE slug = ?", (slug,))
    return folder


def attach_renders(slug: str, natural: Path, scored: Path, cover: Path) -> None:
    import sqlite3
    import time

    for _ in range(40):
        try:
            with connect() as con:
                con.execute(
                    "UPDATE drafts SET render_natural = ?, render_scored = ?, cover = ?, status = 'rendered' WHERE slug = ?",
                    (str(natural), str(scored), str(cover), slug),
                )
            return
        except sqlite3.OperationalError:
            time.sleep(3)
    raise SystemExit(f"catalog locked, could not attach {slug}")
