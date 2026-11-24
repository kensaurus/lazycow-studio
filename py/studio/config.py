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
# The ranch overlay's own data: shared/ranch/*.json (its brand, home place, copy rules, themes, house posts and search
# words). Never exported (scripts/public-export.json), so a clone reads `default` and stays brand-neutral.
RANCH_DATA = ROOT / "shared" / "ranch"


def ranch_data(name: str, default=None):
    """One overlay file, shared/ranch/<name>.json, or `default` when it is not here or does not read."""
    try:
        return json.loads((RANCH_DATA / f"{name}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


RANCH_BRAND: dict = ranch_data("brand", {}) or {}
SPEC = json.loads((ROOT / "shared" / "spec.json").read_text(encoding="utf-8"))
# The ranch's point and banned phrases live in the overlay; a clone has a placeholder point no project uses
# (studio.brand.home_place answers None there) and no banned phrases but each project's own.
SPEC.setdefault("ranch", RANCH_BRAND.get("place") or {"lat": 0.0, "lon": 0.0, "radiusKm": 0, "awayEvents": []})
SPEC.setdefault("bannedSubstrings", list(RANCH_BRAND.get("bannedSubstrings") or []))
# Defaults keep everything beside the code in ./data (gitignored); a machine sets its own paths in .env.
DATA = Path(os.environ.get("STUDIO_DATA", str(ROOT / "data")))
SOURCE = Path(os.environ.get("STUDIO_SOURCE", str(DATA / "footage")))
# The ranch overlay: the owner's original workspace's own files (its reel plan, word bank, profile kit, reel
# projects, house reels and shared/ranch data). Its reel plan is the marker. The owner's private checkout has it; a public clone does not,
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
# The ranch workspace (the owner's own): its main project uses the ranch's place, themes, words and links.
# Any other project, and every project of a clone without the overlay, is its own brand (studio.brand).
RANCH = is_ranch(PROJECTS, ROOT, OVERLAY)
# Approved files: the ranch's Drive folder the Instagram poster opens; any other project, its own data folder.
# Every reel's words, written after each render: the ranch's in shared/ (in git), any other project's in its own folder,
# so one project never overwrites another's.
PLAN = ROOT / "shared" / "reels.json" if RANCH else DATA / "reels.json"
# The name the studio signs its own files with (calendar entries, synthesised effects): the ranch's own, else the app's.
STUDIO_NAME: str = (RANCH and RANCH_BRAND.get("studioName")) or "Lazycow Studio"
# The ranch's Drive folder for drafts and approved files (shared/ranch/brand.json driveFolder); None anywhere else.
RANCH_DRIVE = SOURCE / RANCH_BRAND["driveFolder"] if RANCH and RANCH_BRAND.get("driveFolder") else None
READY = Path(os.environ.get("STUDIO_READY", str(RANCH_DRIVE / "ready" if RANCH_DRIVE else DATA / "ready")))


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


# ffmpeg: the same rule as server/health.mjs resolveTool (the server, the System page and `npx lazycow doctor`).
# The oldest ffmpeg the studio runs on: -fps_mode (studio.pick) arrived in 5.1, and sidechaincompress fed two audio
# formats (studio.sound ducking) negotiates them only since 5.0. A 2021 build fails both.
MIN_FFMPEG = (5, 1)
# libavcodec (major, minor) of each release -> (ffmpeg major, minor), for git builds that print no release number.
_LAVC = [((62, 11), (8, 0)), ((61, 19), (7, 1)), ((61, 3), (7, 0)), ((60, 31), (6, 1)), ((60, 3), (6, 0)),
         ((59, 37), (5, 1)), ((59, 18), (5, 0)), ((58, 134), (4, 4)), ((58, 91), (4, 3)), ((58, 54), (4, 2)),
         ((58, 35), (4, 1)), ((58, 18), (4, 0))]


class FfmpegTooOld(FileNotFoundError):
    """The only ffmpeg found is one on PATH older than MIN_FFMPEG. A FileNotFoundError, so code that already copes
    with a missing ffmpeg copes with this one the same way, and says why."""


def parse_ffmpeg_version(text: str) -> tuple[int, int, str] | None:
    """(major, minor, text) from `ffmpeg -version` output, or None. Git builds ("2021-06-23-git-…", "N-1234-g…")
    are read from their libavcodec line."""
    import re

    head = re.search(r"\bff(?:mpeg|probe) version\s+(\S+)", text or "", re.I)
    rel = re.match(r"n?(\d{1,2})\.(\d+)(?:\.(\d+))?", head.group(1)) if head else None
    if rel:
        label = f"{rel.group(1)}.{rel.group(2)}" + (f".{rel.group(3)}" if rel.group(3) else "")
        return int(rel.group(1)), int(rel.group(2)), label
    lavc = re.search(r"libavcodec\s+(\d+)\.\s*(\d+)\.", text or "")
    if not lavc:
        return None
    have = (int(lavc.group(1)), int(lavc.group(2)))
    if have[0] > _LAVC[0][0][0]:
        return have[0] - 54, 0, f"{have[0] - 54}.x (git build)"
    for lav, (major, minor) in _LAVC:
        if have >= lav:
            return major, minor, f"{major}.{minor} (git build)"
    return 3, 0, "older than 4.0 (git build)"


def resolve_tool(name: str, env: dict | None = None, tools: Path | str | None = None, windows: bool | None = None,
                 exists=None, which=None, run=None, minimum: tuple[int, int] = MIN_FFMPEG) -> dict:
    """Where ffmpeg or ffprobe is. 1. STUDIO_FFMPEG / STUDIO_FFPROBE; 2. the tools folder (STUDIO_TOOLS, else
    <data>/bin), .exe on Windows; 3. PATH, but only at MIN_FFMPEG or newer (an older one comes back `too_old`).
    Everything that touches the machine is injectable, so the tests need no ffmpeg."""
    import shutil
    import subprocess

    env = os.environ if env is None else env
    tools = TOOLS if tools is None else Path(tools)
    windows = (os.name == "nt") if windows is None else windows
    exists = exists or (lambda p: Path(p).is_file())
    which = which or shutil.which

    def version_of(path: str) -> str:
        try:
            return subprocess.run([path, "-version"], capture_output=True, text=True, timeout=8).stdout or ""
        except (OSError, subprocess.SubprocessError):
            return ""

    run = run or version_of
    exe = f"{name}.exe" if windows else name
    out = {"name": name, "path": None, "source": None, "version": None, "too_old": False, "tools": str(tools)}
    chosen = str(env.get(f"STUDIO_{name.upper()}", "") or "").strip()
    if chosen:
        return {**out, "path": chosen, "source": "env"}
    local = str(tools / exe)
    if exists(local):
        return {**out, "path": local, "source": "tools"}
    found = which(exe) or which(name)
    if not found:
        return out
    parsed = parse_ffmpeg_version(run(found))
    too_old = parsed is None or parsed[:2] < tuple(minimum)
    return {**out, "path": found, "source": "path", "version": parsed[2] if parsed else None, "too_old": too_old}


_PATH_CHECKED: dict[tuple[str, float], dict] = {}


def _tool(name: str) -> Path:
    # A tools-folder or STUDIO_* hit costs one stat; a PATH hit runs `-version` once per file (cached by mtime).
    first = resolve_tool(name, run=lambda _p: "")
    if first["source"] != "path":
        if first["path"]:
            return Path(first["path"])
        return Path(name)  # nothing anywhere: the call fails with "not found", as it always did
    try:
        key = (first["path"], os.stat(first["path"]).st_mtime)
    except OSError:
        key = (first["path"], 0.0)
    if key not in _PATH_CHECKED:
        _PATH_CHECKED[key] = resolve_tool(name)
    r = _PATH_CHECKED[key]
    if r["too_old"]:
        raise FfmpegTooOld(
            f"The {name} on PATH ({r['path']}, version {r['version'] or 'unknown'}) is older than "
            f"{MIN_FFMPEG[0]}.{MIN_FFMPEG[1]}, which the studio needs (-fps_mode, sidechaincompress), so it is not used. "
            + _tool_fix(r["tools"]))
    return Path(r["path"])


def _tool_fix(tools: str) -> str:
    import sys

    if sys.platform == "win32":
        return f'Run the setup again (double-click "Start Lazycow"): it downloads a current ffmpeg into {tools}. Or set STUDIO_FFMPEG and STUDIO_FFPROBE.'
    if sys.platform == "darwin":
        return f"Install a current one (brew install ffmpeg), or run the setup again: it downloads ffmpeg into {tools}."
    return f"Install ffmpeg {MIN_FFMPEG[0]}.{MIN_FFMPEG[1]} or newer from your distribution, or put a static build in {tools}."


def ffmpeg_bin() -> Path:
    """The studio's ffmpeg: STUDIO_FFMPEG, else the tools folder, else a new enough one on PATH (FfmpegTooOld if not)."""
    return _tool("ffmpeg")


def ffprobe_bin() -> Path:
    """The studio's ffprobe, by the same rule as ffmpeg_bin."""
    return _tool("ffprobe")


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


def own_llm(vision: bool = False) -> dict | None:
    """Your own model server instead of OpenRouter: anything that speaks the OpenAI chat API (Ollama, LM Studio, vLLM,
    llama.cpp server). Set in .env:
      STUDIO_LLM_BASE_URL      e.g. http://127.0.0.1:11434/v1 (Ollama) or http://127.0.0.1:1234/v1 (LM Studio)
      STUDIO_LLM_MODEL         the model for writing jobs, e.g. qwen2.5:7b-instruct
      STUDIO_LLM_VISION_MODEL  optional: a model that reads pictures, e.g. qwen2.5vl:7b (long-video titles, chapters)
      STUDIO_LLM_API_KEY       optional: only if your server asks for one
    Returns {url, model, key} or None (not set; for vision, no vision model). Calls to it cost nothing in the ledger.
    The .env file is read fresh and wins (Settings › Keys & AI saves there while the studio runs), like ai._env."""
    fresh = _llm_file()
    get = lambda name: (fresh[name] if name in fresh else os.environ.get(name, "")).strip()  # noqa: E731
    base = get("STUDIO_LLM_BASE_URL").rstrip("/")
    model = get("STUDIO_LLM_VISION_MODEL" if vision else "STUDIO_LLM_MODEL")
    if not base or not model or not base.startswith(("http://", "https://")):
        return None
    return {"url": base + "/chat/completions", "model": model, "key": get("STUDIO_LLM_API_KEY")}


def _llm_file() -> dict:
    """The STUDIO_LLM_* lines of .env as they are now; a name that is absent falls back to the environment."""
    out = {}
    for path in (ROOT / ".env", ROOT / ".env.local"):
        out.update({k: v for k, v in _parse_env(path).items() if k.startswith("STUDIO_LLM_")})
    return out


def ensure_dirs() -> None:
    for name in ("bin", "proxies", "mezz", "renders", "keyframes", "catalog", "review", "masks", "upscaled"):
        (DATA / name).mkdir(parents=True, exist_ok=True)
    (ROOT / "public" / "mezz").mkdir(parents=True, exist_ok=True)
    (ROOT / "public" / "stills").mkdir(parents=True, exist_ok=True)
