"""
FILE: py/studio/config.py
PURPOSE: Paths, the ranch point, and secrets loaded without printing them.
OVERVIEW: Code lives in the repo. Catalog, proxies and renders live in STUDIO_DATA (default ./data).
          extra_sources(): footage folders outside the media root (STUDIO_EXTRA_SOURCES,
          <data>/imports, and folders added on the Footage page, <data>/sources.json).
          trusted_folder(): true under the ones that count as ranch footage without GPS.
DEPENDENCIES: shared/spec.json, optional .env files
USAGE: from studio.config import DATA, FFMPEG, spec
NOTES: OPENROUTER_API_KEY is never logged. A missing key disables paid calls.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def _from_file() -> None:
    """A clone sets paths in .env; the shell does not have to export them."""
    for path in (ROOT / ".env", ROOT / ".env.local"):
        for key, value in _parse_env(path).items():
            if key.startswith("STUDIO_") or key == "OPENROUTER_API_KEY":
                os.environ.setdefault(key, value)


_from_file()
SPEC = json.loads((ROOT / "shared" / "spec.json").read_text(encoding="utf-8"))
# Defaults keep everything beside the code in ./data (gitignored); a machine sets its own paths in .env.
DATA = Path(os.environ.get("STUDIO_DATA", str(ROOT / "data")))
SOURCE = Path(os.environ.get("STUDIO_SOURCE", str(DATA / "footage")))
# The ranch overlay: the original Tsumagoi Work&Camp workspace's own files (its reel plan, word bank, profile kit, reel
# projects and house reels). Its reel plan is the marker. The owner's private checkout has it; a public clone does not,
# so a clone starts brand-neutral.
RANCH_MARKER = ROOT / "shared" / "reels.json"


def ranch_overlay(root: Path = ROOT, flag: str | None = None) -> bool:
    """Is the ranch overlay here? STUDIO_RANCH=1 or 0 decides when set; otherwise the marker file does.
    Same rule as shared/ranch.mjs (the server)."""
    flag = (os.environ.get("STUDIO_RANCH", "") if flag is None else flag).strip().lower()
    if flag in ("1", "on", "true", "yes"):
        return True
    if flag in ("0", "off", "false", "no"):
        return False
    return (root / "shared" / "reels.json").is_file()


def channel_who(spec: dict, ranch: bool | None = None) -> str:
    """Whose account a network posts to, as shown to a person: the ranch's own accounts (ranchWho) only in the ranch
    workspace; every other project, and a public clone, sees the neutral `who` ("Your channel")."""
    ranch = RANCH if ranch is None else ranch
    return str((spec.get("ranchWho") if ranch else None) or spec.get("who") or "")


def is_ranch(projects: Path, root: Path = ROOT, overlay: bool | None = None) -> bool:
    """The ranch is the main project (reels in <root>/projects) of a checkout that has the overlay."""
    return (ranch_overlay(root) if overlay is None else overlay) and projects.resolve() == (root / "projects").resolve()


OVERLAY = ranch_overlay()
# A reel project file per reel. The ranch keeps them in ./projects (in its git); a clone without the overlay keeps them
# in its data folder, beside everything else it makes. A second studio project keeps its own folder.
PROJECTS = Path(os.environ.get("STUDIO_PROJECTS", str(ROOT / "projects" if OVERLAY else DATA / "projects")))
# The Tsumagoi Work&Camp workspace (the owner's own): its main project uses the ranch's place, themes, words and links.
# Any other project, and every project of a clone without the overlay, is its own brand (studio.brand).
RANCH = is_ranch(PROJECTS, ROOT, OVERLAY)
# Approved files: the ranch's Drive folder the Instagram poster opens; any other project, its own data folder.
# Every reel's words, written after each render: the ranch's in shared/ (in git), any other project's in its own folder,
# so one project never overwrites another's.
PLAN = ROOT / "shared" / "reels.json" if RANCH else DATA / "reels.json"
READY = Path(os.environ.get("STUDIO_READY", str(SOURCE / "tsumagoi-video-edit-sns" / "ready" if RANCH else DATA / "ready")))


def project_file(name: str) -> Path:
    """A project (workspace) may keep its own copy of a shared file (channels.json, profiles.json) in its data folder."""
    own = DATA / name
    if own.is_file() or (name == "profiles.json" and not RANCH):  # the shared profile kit is the ranch's own
        return own
    return ROOT / "shared" / ("profiles/" + name if name == "profiles.json" else name)
# Google Takeout's "Add to Drive" delivery lands in My Drive\Takeout; set STUDIO_TAKEOUT to that folder.
TAKEOUT_DRIVE = Path(os.environ.get("STUDIO_TAKEOUT") or str(DATA / "takeout"))  # blank (another project) = its own
# Optional: another project's .env to borrow an OpenRouter key from. None by default.
WEBSITE_ENV = Path(os.environ.get("STUDIO_WEBSITE_ENV") or str(ROOT / ".env.website"))


TOOLS = Path(os.environ.get("STUDIO_TOOLS", str(DATA / "bin")))


def _registry() -> list[dict]:
    """Folders added from the Footage page (<data>/sources.json), each trusted or GPS-placed."""
    try:
        rows = json.loads((DATA / "sources.json").read_text(encoding="utf-8"))
        return [r for r in rows if isinstance(r, dict) and r.get("path")]
    except (OSError, ValueError):
        return []


def extra_sources() -> list[Path]:
    """Footage folders besides the media root: STUDIO_EXTRA_SOURCES (semicolon-separated),
    <data>/imports (Google Photos picks) and every folder added from the Footage page."""
    listed = [Path(p.strip()) for p in os.environ.get("STUDIO_EXTRA_SOURCES", "").split(";") if p.strip()]
    return listed + [DATA / "imports"] + [Path(r["path"]) for r in _registry()]


def trusted_roots() -> list[Path]:
    """The extra folders vouched for as ranch footage. A folder added in "gps" mode is not:
    its files are placed by their own GPS, folder and event like the media root."""
    listed = [Path(p.strip()) for p in os.environ.get("STUDIO_EXTRA_SOURCES", "").split(";") if p.strip()]
    return listed + [DATA / "imports"] + [Path(r["path"]) for r in _registry() if r.get("mode") == "trusted"]


def trusted_folder(path: Path) -> bool:
    low = str(path).lower()
    return any(low.startswith(str(root).lower().rstrip("\\/") + os.sep) for root in trusted_roots())


def ffmpeg_bin() -> Path:
    """The studio's current ffmpeg. The 2021 build on PATH lacks flags the studio uses."""
    for local in (DATA / "bin" / "ffmpeg.exe", TOOLS / "ffmpeg.exe"):
        if local.exists():
            return local
    return Path("ffmpeg")


def ffprobe_bin() -> Path:
    for local in (DATA / "bin" / "ffprobe.exe", TOOLS / "ffprobe.exe"):
        if local.exists():
            return local
    return Path("ffprobe")


def load_env() -> None:
    """Studio .env wins. The website .env fills a missing OpenRouter key."""
    website = _parse_env(WEBSITE_ENV)
    studio = _parse_env(ROOT / ".env")
    for key, value in {**website, **studio}.items():
        if key in ("OPENROUTER_API_KEY", "STUDIO_DAILY_USD_BUDGET", "STUDIO_GAP_CONFIRM"):
            os.environ.setdefault(key, value)


def openrouter_key() -> str:
    """The key the old paid tagging (and research post angles) use. The AI reviewer's key, saved from
    Settings as OPENROUTER_API_KEY_PARKED (studio.ai), is used here only when the owner switches
    STUDIO_PAID_TAGGING=on: saving a reviewer key never turns paid tagging on by itself."""
    load_env()
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key and os.environ.get("STUDIO_PAID_TAGGING", "").strip().lower() in ("1", "on", "true", "yes"):
        key = _parse_env(ROOT / ".env").get("OPENROUTER_API_KEY_PARKED", "")
    return key


def daily_budget() -> float:
    load_env()
    try:
        return float(os.environ.get("STUDIO_DAILY_USD_BUDGET", "2"))
    except ValueError:
        return 2.0


def ensure_dirs() -> None:
    for name in ("bin", "proxies", "mezz", "renders", "keyframes", "catalog", "review", "masks", "upscaled"):
        (DATA / name).mkdir(parents=True, exist_ok=True)
    (ROOT / "public" / "mezz").mkdir(parents=True, exist_ok=True)
    (ROOT / "public" / "stills").mkdir(parents=True, exist_ok=True)
