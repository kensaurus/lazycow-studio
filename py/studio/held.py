"""
FILE: py/studio/held.py
PURPOSE: Replace or remove a file another program holds open for a moment, instead of failing a long job.
OVERVIEW: On Windows a file a player, Drive for desktop or a virus scan has open cannot be removed or replaced
          (PermissionError, WinError 5/32). held() tries again with growing waits, about 30 s in all. On 12 Nov two
          "Use the new version" builds failed this way at their last step: a Drive copy being synced, and a render the
          Versions page was playing.
USAGE: from studio.held import held, replace
       held(path.unlink); replace(tmp, path)
"""
from __future__ import annotations

import time
from pathlib import Path


def held(fn, *args, tries: int = 6):
    for k in range(tries):
        try:
            return fn(*args)
        except PermissionError:
            if k == tries - 1:
                raise
            time.sleep(min(15, 2 ** k))


def replace(src: Path, dest: Path) -> None:
    """src takes dest's place. A page streaming dest (the studio's server opens files so they can be renamed but not
    deleted while read) keeps it for as long as the page is open, so waiting cannot help: dest is moved aside, src takes
    its name, and the old copy is removed when its reader lets go (here, or on a later replace in the same folder)."""
    src, dest = Path(src), Path(dest)
    for old in dest.parent.glob(dest.name + ".old-*"):  # copies an earlier replace moved aside
        try:
            old.unlink()
        except OSError:
            pass
    try:
        held(src.replace, dest, tries=3)
        return
    except PermissionError:
        if not dest.exists():
            raise
    aside = dest.with_name(f"{dest.name}.old-{int(time.time() * 1000)}")
    dest.rename(aside)  # allowed while a reader has it open
    try:
        src.replace(dest)
    except OSError:
        aside.rename(dest)  # put it back: never leave the reel without its file
        raise
    try:
        aside.unlink()
    except OSError:
        pass  # still being read: removed by a later replace


def remove(path: Path) -> None:
    """Remove a file; one a reader still holds (a page playing it, Drive syncing it) is moved aside under a name nothing
    looks for (<name>.old-<ms>) and removed by a later remove or replace in the same folder."""
    path = Path(path)
    for old in path.parent.glob(path.name + ".old-*"):
        try:
            old.unlink()
        except OSError:
            pass
    try:
        held(path.unlink, tries=3)
    except PermissionError:
        path.rename(path.with_name(f"{path.name}.old-{int(time.time() * 1000)}"))
    except FileNotFoundError:
        pass

