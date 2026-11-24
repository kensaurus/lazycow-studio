"""
FILE: py/studio/places.py
PURPOSE: Place names for positions, offline, anywhere in the world: the nearest town or village and a notable
         feature nearby (a mountain, lake, park), from GeoNames files a person chose to download.
OVERVIEW: <data>/places/ holds cities1000.txt (towns of 1,000+ people worldwide), admin1CodesASCII.txt (state /
          prefecture names) and optional country files (JP.txt: every village, mountain and lake). Index: a 0.5 degree
          grid, loaded once per process and again when a file changes. reverse(lat, lon) -> the nearest place;
          label(lat, lon) adds a notable feature within 5 km; suggest_country(points) picks the country file worth
          offering; download(which) fetches one set (a job: python -m studio places download world|JP).
DEPENDENCIES: studio.config (DATA); the standard library only (urllib, zipfile)
USAGE: python -m studio places status | download world | download JP
NOTES: Nothing is downloaded unless a person presses the button (or runs the command). Without the files every
       function answers None / empty and the map shows distances instead. GeoNames data: CC BY 4.0, credited on the map.
"""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

GEONAMES = "https://download.geonames.org/export/dump/"
WORLD = "cities1000.txt"
ADMIN1 = "admin1CodesASCII.txt"
CELL = 0.5            # degrees per grid cell
FEATURE_KM = 5.0      # a notable feature this close is named beside the town
FEATURES = {"MT": "mountain", "PK": "mountain", "VLC": "mountain", "HLL": "hill", "LK": "lake", "RSV": "lake",
            "PRK": "park", "WTRF": "waterfall", "PASS": "pass", "BCH": "beach", "ISL": "island", "CAPE": "cape"}
# Sizes as GeoNames lists them (Nov 2026); a download smaller than a tenth of the expected size is refused.
EXPECTED = {"world": 11_100_000, "admin1": 150_000}
COUNTRY_RX = re.compile(r"^[A-Z]{2}$")
MAX_BYTES = 200_000_000  # the largest country file (US) is well under this; anything bigger is not what was asked for
# Download sizes the buttons name before anything starts (GeoNames' listing, Nov 2026); other countries say so once it runs.
KNOWN_MB = {"world": 11, "JP": 5}


def places_dir() -> Path:
    from studio.config import DATA

    return DATA / "places"


def user_agent() -> str:
    """Who is asking (GeoNames and the tile servers ask callers to say)."""
    try:
        from studio.config import ROOT

        version = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version", "0")
    except (OSError, ValueError):
        version = "0"
    return f"LazycowStudio/{version} (+https://github.com/kensaurus/lazycow-studio)"


# ---------- Japanese names: GeoNames keeps every spelling in one list without a language ----------
def _has(text: str, lo: int, hi: int) -> bool:
    return any(lo <= ord(ch) <= hi for ch in text)


def ja_name(name: str, alternates: str, country: str) -> str:
    """The name a Japanese reader would expect: in Japan the kanji name (軽井沢町, 富士山) before a kana reading; abroad
    the katakana name (ナイロビ). Falls back to the plain name."""
    best, rank = None, 9
    for alt in (alternates or "").split(","):
        alt = alt.strip()
        if not alt:
            continue
        kanji, kata, hira = _has(alt, 0x4E00, 0x9FFF), _has(alt, 0x30A0, 0x30FF), _has(alt, 0x3040, 0x309F)
        r = 0 if kanji and country == "JP" else 1 if kata and not kanji else 2 if hira and not kanji else 9
        if r < rank:
            best, rank = alt, r
    return best or name


# ---------- The index ----------
class Index:
    """Rows from every GeoNames file present, on a 0.5 degree grid."""

    def __init__(self) -> None:
        self.rows: list[tuple] = []        # (lat, lon, name, ja, fclass, fcode, cc, admin1, population)
        self.grid: dict[tuple[int, int], list[int]] = {}
        self.admin: dict[str, tuple[str, str]] = {}  # "JP.10" -> (Gunma, 群馬県)
        self.countries: list[str] = []
        self.world = False
        self._adm1_ja: dict[str, str] = {}  # an ADM1 row's geonameid -> its Japanese name (from a country file)

    def add_file(self, path: Path, all_features: bool) -> None:
        adm1_ja: dict[str, str] = {}
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                f = line.rstrip("\n").split("\t")
                if len(f) < 15:
                    continue
                fclass, fcode = f[6], f[7]
                if fcode == "ADM1":
                    adm1_ja[f[0]] = ja_name(f[1], f[3], f[8])
                if fclass != "P" and not (all_features and fcode in FEATURES):
                    continue
                try:
                    lat, lon, pop = float(f[4]), float(f[5]), int(f[14] or 0)
                except ValueError:
                    continue
                self.rows.append((lat, lon, f[1], ja_name(f[1], f[3], f[8]), fclass, fcode, f[8], f[10], pop))
                key = (math.floor(lat / CELL), math.floor(lon / CELL))
                self.grid.setdefault(key, []).append(len(self.rows) - 1)
        self._adm1_ja.update(adm1_ja)

    def nearest(self, lat: float, lon: float, want, max_km: float = 300.0) -> tuple[tuple, float] | None:
        """The nearest row passing `want(row)`, searching rings of grid cells outwards until no closer one can exist."""
        from studio.media import haversine_km

        ci, cj = math.floor(lat / CELL), math.floor(lon / CELL)
        cell_km = CELL * 111.0 * max(0.05, math.cos(math.radians(min(89.0, abs(lat) + CELL))))
        best, best_km = None, float("inf")
        rings = int(max_km / cell_km) + 2
        for r in range(0, min(rings, 120)):
            ring = [(ci, cj)] if r == 0 else (
                [(ci - r, j) for j in range(cj - r, cj + r + 1)] + [(ci + r, j) for j in range(cj - r, cj + r + 1)]
                + [(i, cj - r) for i in range(ci - r + 1, ci + r)] + [(i, cj + r) for i in range(ci - r + 1, ci + r)])
            for cell in ring:
                for k in self.grid.get(cell, ()):
                    row = self.rows[k]
                    if not want(row):
                        continue
                    d = haversine_km(lat, lon, (row[0], row[1]))
                    if d < best_km:
                        best, best_km = row, d
            if best is not None and best_km <= r * cell_km:
                break  # every cell further out is at least r cells away
        return (best, best_km) if best is not None and best_km <= max_km else None


_CACHE: dict = {"key": None, "index": None}


def _files() -> list[Path]:
    d = places_dir()
    if not d.is_dir():
        return []
    return sorted(p for p in d.glob("*.txt") if p.name == WORLD or COUNTRY_RX.match(p.stem))


def index() -> Index | None:
    """The loaded index, or None when no place file has been downloaded. Reloaded when a file changes."""
    files = _files()
    if not files:
        return None
    admin = places_dir() / ADMIN1
    key = tuple((p.name, p.stat().st_mtime, p.stat().st_size) for p in files + ([admin] if admin.exists() else []))
    if _CACHE["key"] == key:
        return _CACHE["index"]
    idx = Index()
    for p in files:
        idx.add_file(p, all_features=p.name != WORLD)
        if p.name == WORLD:
            idx.world = True
        else:
            idx.countries.append(p.stem)
    if admin.exists():
        for line in admin.read_text(encoding="utf-8", errors="replace").splitlines():
            f = line.split("\t")
            if len(f) >= 4:
                idx.admin[f[0]] = (f[1], idx._adm1_ja.get(f[3], f[1]))
    _CACHE.update(key=key, index=idx)
    return idx


def reverse(lat: float, lon: float, idx: Index | None = None) -> dict | None:
    """The nearest town or village: {name, nameJa, admin, adminJa, country, kind, km}, or None (no files)."""
    idx = idx or index()
    if idx is None:
        return None
    hit = idx.nearest(lat, lon, lambda r: r[4] == "P")
    if not hit:
        return None
    row, km = hit
    adm = idx.admin.get(f"{row[6]}.{row[7]}")
    return {"name": row[2], "nameJa": row[3], "admin": adm[0] if adm else None, "adminJa": adm[1] if adm else None,
            "country": row[6], "kind": row[5], "km": round(km, 1)}


def label(lat: float, lon: float, idx: Index | None = None) -> dict | None:
    """reverse() plus the nearest notable feature within FEATURE_KM: {..., feature: {name, nameJa, kind, km} | None}."""
    idx = idx or index()
    place = reverse(lat, lon, idx)
    if place is None:
        return None
    hit = idx.nearest(lat, lon, lambda r: r[5] in FEATURES, max_km=FEATURE_KM)
    place["feature"] = {"name": hit[0][2], "nameJa": hit[0][3], "kind": FEATURES[hit[0][5]], "km": round(hit[1], 1)} if hit else None
    return place


def country_of(lat: float, lon: float, idx: Index | None = None) -> str | None:
    p = reverse(lat, lon, idx)
    return p["country"] if p else None


def status() -> dict:
    """What is downloaded: {world, countries, admin, bytes, files}."""
    idx_files = _files()
    d = places_dir()
    return {"world": any(p.name == WORLD for p in idx_files), "countries": [p.stem for p in idx_files if p.name != WORLD],
            "admin": (d / ADMIN1).exists(), "bytes": sum(p.stat().st_size for p in idx_files)}


def suggest_country(points: list[tuple[float, float]], idx: Index | None = None) -> str | None:
    """The country most of these points are in (by the nearest world town), when its detail file is not here yet."""
    idx = idx or index()
    if idx is None or not idx.world:
        return None
    counts: dict[str, int] = {}
    for lat, lon in points[:50]:
        cc = country_of(lat, lon, idx)
        if cc:
            counts[cc] = counts.get(cc, 0) + 1
    if not counts:
        return None
    cc = max(sorted(counts), key=lambda c: counts[c])
    return None if cc in idx.countries else cc


# ---------- Download (a person pressed the button) ----------
def _fetch(url: str, dest: Path, minimum: int, progress, opener=urllib.request.urlopen) -> int:
    """Download url to dest (atomically), checking the length the server promised and a sane minimum size."""
    req = urllib.request.Request(url, headers={"User-Agent": user_agent()})
    tmp = dest.with_suffix(dest.suffix + ".part")
    got = 0
    with opener(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        if total > MAX_BYTES:
            raise OSError(f"{url} is {total // 1_000_000} MB, more than the {MAX_BYTES // 1_000_000} MB a place file should be")
        with tmp.open("wb") as out:
            while True:
                block = resp.read(256 * 1024)
                if not block:
                    break
                out.write(block)
                got += len(block)
                if total:
                    progress(f"PROGRESS {got // 1_000_000}/{max(1, total // 1_000_000)} MB from GeoNames", flush=True)
    if (total and got != total) or got < minimum:
        tmp.unlink(missing_ok=True)
        raise OSError(f"the download from {url} was cut short ({got:,} bytes)")
    os.replace(tmp, dest)
    return got


def download(which: str, progress=print, opener=urllib.request.urlopen) -> dict:
    """Fetch one set into <data>/places: "world" (cities1000 + admin1 names) or a two-letter country code."""
    which = str(which or "").strip()
    which = "world" if which.lower() == "world" else which.upper()
    if which != "world" and not COUNTRY_RX.match(which):
        raise ValueError("which: 'world' or a two-letter country code such as JP")
    d = places_dir()
    d.mkdir(parents=True, exist_ok=True)
    member = WORLD if which == "world" else f"{which}.txt"
    zip_name = "cities1000.zip" if which == "world" else f"{which}.zip"
    steps = 3 if which == "world" else 2
    progress(f"STAGE 1/{steps} downloading {zip_name} from GeoNames", flush=True)
    with tempfile.TemporaryDirectory(dir=d) as tmp:
        z = Path(tmp) / zip_name
        size = _fetch(GEONAMES + zip_name, z, EXPECTED["world"] // 10 if which == "world" else 1000, progress, opener)
        progress(f"STAGE 2/{steps} unpacking {member}", flush=True)
        try:
            with zipfile.ZipFile(z) as archive:
                info = archive.getinfo(member)
                if info.file_size < 1000:
                    raise OSError(f"{member} in {zip_name} is too small")
                out = Path(tmp) / member
                with archive.open(info) as src, out.open("wb") as dst:
                    while True:
                        block = src.read(1024 * 1024)
                        if not block:
                            break
                        dst.write(block)
        except (KeyError, zipfile.BadZipFile) as err:
            raise OSError(f"{zip_name} is not the GeoNames file expected ({err})") from err
        os.replace(out, d / member)
    if which == "world":
        progress(f"STAGE 3/{steps} downloading state and prefecture names", flush=True)
        _fetch(GEONAMES + ADMIN1, d / ADMIN1, EXPECTED["admin1"] // 10, progress, opener)
    log = d / "sources.json"
    try:
        seen = json.loads(log.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        seen = {}
    seen[member] = {"url": GEONAMES + zip_name, "zipBytes": size, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "licence": "CC BY 4.0 (GeoNames)"}
    log.write_text(json.dumps(seen, indent=1), encoding="utf-8")
    _CACHE.update(key=None, index=None)
    return {"which": which, "file": member, "zipBytes": size, **status()}
