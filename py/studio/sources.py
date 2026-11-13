"""
FILE: py/studio/sources.py
PURPOSE: Where footage comes from: pick any folder on any drive, see what is in it before
         adding it, and notice new files on every source without being asked.
OVERVIEW:
  - roots(): the places to start browsing on this machine (Windows drive letters, macOS
    /Volumes, Linux /media and /mnt, home, Google Drive for desktop, the media root).
  - listdir(path): subfolders of one folder plus a count of media files directly in it.
  - discover(path): a report on a whole folder tree before it is added: photos, videos,
    RAW, 360, by format and by year, size, how many are already catalogued, how many are
    studio outputs that would be skipped, and the newest files.
  - add / remove / load: the registry, <data>/sources.json. A source is "trusted" (the owner
    vouches it is ranch footage) or "gps" (each file is placed by its GPS / folder / event).
  - diff(): a quick walk of every source against the catalog: which files are new. The
    server runs it on a timer and ingests + tags whatever it finds.
DEPENDENCIES: studio.config, studio.db, studio.ingest (is_output), studio.media (formats)
USAGE: python -m studio sources roots | ls PATH | discover PATH | add PATH --mode trusted|gps
       | remove PATH | list | diff
NOTES: Read-only on the folders it looks at: listing and stat only, no file is opened, so a
       Google Drive "stream files" folder is not downloaded by a discovery. 360 is guessed
       from the format (.insp / .insv / .360) and the Insta360 file name; the ingest
       confirms it from the picture size.
"""
from __future__ import annotations

import json
import os
import re
import string
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from studio.config import DATA, RANCH, SOURCE

REGISTRY = DATA / "sources.json"
STATE = DATA / "sources_state.json"
SKIP_DIRS = {"$recycle.bin", "system volume information", "node_modules", ".git", ".venv", "venv",
             "__pycache__", "appdata", ".trash", ".trashes", ".spotlight-v100", ".fseventsd",
             "windows", "program files", "program files (x86)", "programdata"}
INSTA_NAME = re.compile(r"^(IMG|VID|LRV)_\d{8}_\d{6}_\d{2}_\d{3}", re.I)
SPHERE_EXT = {".insp", ".insv", ".360"}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _formats() -> tuple[set[str], set[str], set[str]]:
    from studio.media import RAW, STILL, VIDEO

    return VIDEO | {".360"}, STILL, RAW


def kind_of(path: Path) -> str | None:
    video, still, raw = _formats()
    ext = path.suffix.lower()
    if ext in raw:
        return "raw"
    if ext in video:
        return "video"
    if ext in still:
        return "photo"
    return None


def looks_360(path: Path) -> bool:
    return path.suffix.lower() in SPHERE_EXT or bool(INSTA_NAME.match(path.name)) or "insta360" in str(path.parent).lower()


# ---------- registry ----------

def load() -> list[dict]:
    try:
        rows = json.loads(REGISTRY.read_text(encoding="utf-8"))
        return [r for r in rows if isinstance(r, dict) and r.get("path")]
    except (OSError, ValueError):
        return []


def _save(rows: list[dict]) -> None:
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")


def _same(a: str | Path, b: str | Path) -> bool:
    return os.path.normcase(os.path.abspath(str(a))).rstrip("\\/") == os.path.normcase(os.path.abspath(str(b))).rstrip("\\/")


def _inside(child: str | Path, parent: str | Path) -> bool:
    c = os.path.normcase(os.path.abspath(str(child))).rstrip("\\/") + os.sep
    p = os.path.normcase(os.path.abspath(str(parent))).rstrip("\\/") + os.sep
    return c.startswith(p)


def add(path: str, mode: str = "gps", label: str | None = None) -> dict:
    if mode not in ("trusted", "gps"):
        raise ValueError("mode is trusted or gps")
    folder = Path(path)
    if not folder.is_dir():
        raise ValueError(f"not a folder: {path}")
    if _inside(folder, DATA) and not _inside(folder, DATA / "imports"):
        raise ValueError("that is the studio's own data folder")
    rows = [r for r in load() if not _same(r["path"], folder)]
    row = {"path": str(folder), "mode": mode, "label": label or folder.name or str(folder), "added": _now()}
    rows.append(row)
    _save(rows)
    return row


def remove(path: str) -> dict:
    rows = load()
    kept = [r for r in rows if not _same(r["path"], path)]
    _save(kept)
    return {"removed": len(rows) - len(kept)}


def all_sources() -> list[dict]:
    """Every folder the studio reads, the media root first. Missing folders are reported, not dropped."""
    from studio.config import extra_sources

    seen, out = [], []
    (DATA / "imports").mkdir(parents=True, exist_ok=True)  # the studio's own; empty until a first pick

    def push(path, mode, label, origin, key=""):
        if any(_same(path, s) for s in seen):
            return
        seen.append(str(path))
        # labelKey: the page shows these two in its own language (and the ranch's names only in the ranch workspace).
        out.append({"path": str(path), "mode": mode, "label": label, "labelKey": key, "origin": origin, "exists": Path(path).is_dir()})

    push(SOURCE, "gps", "Ranch media (Drive)" if RANCH else "Footage folder", "root", "root")
    for p in extra_sources():
        trusted = p in _env_and_imports()
        reg = next((r for r in load() if _same(r["path"], p)), None)
        if reg:
            push(p, reg["mode"], reg.get("label") or Path(p).name, "added")
        elif trusted:
            imports = _same(p, DATA / "imports")
            push(p, "trusted", "Google Photos picks and collected footage" if imports else Path(p).name, "env", "imports" if imports else "")
    return out


def _env_and_imports() -> list[Path]:
    listed = [Path(p.strip()) for p in os.environ.get("STUDIO_EXTRA_SOURCES", "").split(";") if p.strip()]
    return listed + [DATA / "imports"]


# ---------- browsing ----------

def roots() -> list[dict]:
    """Starting points for the folder picker on this OS."""
    out: list[dict] = []
    home = Path.home()

    def push(path: Path, label: str, kind: str):
        try:
            if path.is_dir() and not any(_same(path, r["path"]) for r in out):
                out.append({"path": str(path), "label": label, "kind": kind})
        except OSError:
            pass

    push(SOURCE, "Ranch media" if RANCH else "Footage folder", "source")
    if sys.platform == "win32":
        for letter in string.ascii_uppercase:
            drive = Path(f"{letter}:\\")
            if drive.exists():
                push(drive, f"{letter}:  {_volume_label(drive)}".rstrip(), "drive")
                push(drive / "My Drive", f"Google Drive ({letter}:)", "cloud")
    elif sys.platform == "darwin":
        volumes = Path("/Volumes")
        if volumes.is_dir():
            for v in sorted(volumes.iterdir()):
                push(v, v.name, "drive")
        cloud = home / "Library" / "CloudStorage"
        if cloud.is_dir():
            for c in sorted(cloud.iterdir()):
                push(c, c.name.replace("GoogleDrive-", "Google Drive "), "cloud")
    else:
        for base in (Path("/media") / os.environ.get("USER", ""), Path("/media"), Path("/mnt"), Path("/run/media") / os.environ.get("USER", "")):
            if base.is_dir():
                for v in sorted(base.iterdir()):
                    push(v, v.name, "drive")
    for sub, label in (("Pictures", "Pictures"), ("Movies", "Movies"), ("Videos", "Videos"), ("Downloads", "Downloads"), ("DCIM", "DCIM")):
        push(home / sub, label, "home")
    push(home, "Home", "home")
    return out


def _volume_label(drive: Path) -> str:
    try:
        import ctypes

        buf = ctypes.create_unicode_buffer(261)
        ok = ctypes.windll.kernel32.GetVolumeInformationW(ctypes.c_wchar_p(str(drive)), buf, 261, None, None, None, None, 0)
        return buf.value if ok else ""
    except Exception:  # noqa: BLE001  (a label is a nicety)
        return ""


def listdir(path: str) -> dict:
    folder = Path(path)
    if not folder.is_dir():
        raise ValueError(f"not a folder: {path}")
    dirs, media = [], 0
    try:
        with os.scandir(folder) as it:
            for entry in it:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        if entry.name.lower() in SKIP_DIRS or entry.name.startswith((".", "$")):
                            continue
                        dirs.append({"name": entry.name, "path": entry.path})
                    elif kind_of(Path(entry.name)):
                        media += 1
                except OSError:
                    continue
    except PermissionError:
        raise ValueError("no permission to read that folder") from None
    dirs.sort(key=lambda d: d["name"].lower())
    parent = str(folder.parent) if folder.parent != folder else None
    included = next((s for s in all_sources() if _inside(folder, s["path"])), None)
    return {"path": str(folder), "parent": parent, "dirs": dirs, "media": media, "included": included}


# ---------- discovery ----------

def _walk(root: Path, limit: int = 300_000):
    """Media files under root, skipping system folders and studio outputs. Stat only."""
    from studio.ingest import is_output

    stack = [root]
    n = 0
    while stack:
        folder = stack.pop()
        try:
            with os.scandir(folder) as it:
                entries = list(it)
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if entry.name.lower() not in SKIP_DIRS and not entry.name.startswith((".", "$")):
                        stack.append(Path(entry.path))
                    continue
                path = Path(entry.path)
                kind = kind_of(path)
                if not kind:
                    continue
                yield path, kind, entry.stat(), is_output(path)
                n += 1
                if n >= limit:
                    return
            except OSError:
                continue


def _catalogued() -> set[str]:
    from studio.db import connect

    with connect() as con:
        return {os.path.normcase(r[0]) for r in con.execute("SELECT path FROM assets")}


def discover(path: str) -> dict:
    root = Path(path)
    if not root.is_dir():
        raise ValueError(f"not a folder: {path}")
    from studio.ingest import KEEP

    known = _catalogued()
    kinds, exts, years = Counter(), Counter(), Counter()
    size = sphere = outputs = already = graphics = 0
    newest: list[tuple[float, str, str]] = []
    folders = set()
    for i, (p, kind, st, output) in enumerate(_walk(root)):
        if i % 200 == 0:
            print(f"PROGRESS {i}/{i + 200} looking through {p.parent.name}", flush=True)
        if output:
            outputs += 1
            continue
        if p.suffix.lower() not in KEEP:
            # .png / .webp: website graphics and screenshots, shown but never auto-ingested.
            graphics += 1
            exts[p.suffix.lower()] += 1
            continue
        kinds[kind] += 1
        exts[p.suffix.lower()] += 1
        size += st.st_size
        folders.add(str(p.parent))
        if looks_360(p):
            sphere += 1
        if os.path.normcase(str(p)) in known:
            already += 1
        year = datetime.fromtimestamp(st.st_mtime).year
        m = re.search(r"(20\d{2})[01]\d[0-3]\d", p.name)
        years[int(m.group(1)) if m else year] += 1
        newest.append((st.st_mtime, str(p), kind))
        if len(newest) > 400:
            newest = sorted(newest, reverse=True)[:24]
    newest = sorted(newest, reverse=True)[:24]
    total = sum(kinds.values())
    included = next((s for s in all_sources() if _inside(root, s["path"])), None)
    return {
        "path": str(root), "total": total, "bytes": size, "folders": len(folders),
        "kinds": dict(kinds), "formats": dict(exts.most_common()), "years": dict(sorted(years.items())),
        "is360": sphere, "outputs": outputs, "graphics": graphics, "already": already, "new": total - already,
        "newest": [{"path": p, "kind": k, "modified": datetime.fromtimestamp(t).isoformat(timespec="minutes")} for t, p, k in newest[:12]],
        "included": included, "checked": _now(),
    }


# ---------- the watcher ----------

def diff() -> dict:
    """New files on every source since the last ingest (by path), without opening any file."""
    from studio.ingest import KEEP

    known = _catalogued()
    by_source, fresh = [], []
    for s in all_sources():
        if not s["exists"]:
            by_source.append({**s, "new": 0, "files": 0})
            continue
        n = files = 0
        for p, kind, _st, output in _walk(Path(s["path"])):
            # Only what the ingest takes: a logo .png would otherwise read as "new" forever.
            if output or kind is None or p.suffix.lower() not in KEEP:
                continue
            files += 1
            if os.path.normcase(str(p)) not in known:
                n += 1
                if len(fresh) < 50:
                    fresh.append(str(p))
        by_source.append({**s, "new": n, "files": files})
    state = {"checked": _now(), "new": sum(s["new"] for s in by_source), "sources": by_source, "sample": fresh[:12]}
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    return state


def last_diff() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"checked": None, "new": 0, "sources": [], "sample": []}
