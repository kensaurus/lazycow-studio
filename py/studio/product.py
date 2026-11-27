"""
FILE: py/studio/product.py
PURPOSE: Product videos from an app's release kit (docs/product-kit.md): app screenshots before and after a release,
         short screen recordings, changelog lines and brand tokens, turned into an App Store app preview, a Google Play
         promo or a social cut by the ProductPreview composition (src/ProductPreview.tsx).
OVERVIEW: fetch: read a kit's manifest (an https URL, such as a release kit's signed link, or a folder on this computer),
          check it against the schema, download each file with a size cap, check what the bytes really are, and keep
          clean copies (images re-saved without their metadata, recordings re-encoded without sound or metadata) in
          <data>/product/<name>/. Nothing in a kit is ever run: no script, no SVG, no HTML.
          plan: the timeline for one preset (shared/product-presets.json): which screens fit, how long each one holds,
          the captions, checked against the preset's spec (length, fps, size) before anything renders.
          build: render that timeline, encode it to the preset's spec (H.264, its level and bit rate, stereo AAC), then
          check the file itself with ffprobe. Footage sources are not touched: kits live in their own folder.
          review / estimate: the studio's AI reviewer (studio.ai.review_file) on a rendered product video, priced first
          and inside the same AI limits; optional, never part of a render.
DEPENDENCIES: Pillow, ffmpeg + ffprobe (studio.config), npx remotion (studio.remotion)
USAGE: python -m studio.product <action> with the request JSON on stdin; prints one line:
         RESULT {"ok": true, "data": {...}} or RESULT {"ok": false, "error": "<one plain sentence>", "code": "...", "status": 4xx|5xx}
       actions: presets, fetch, kits, kit, plan, estimate, review, last-review.
       python -m studio product build <video id> renders one (the studio's render queue runs it, STAGE/PROGRESS lines).
NOTES: A video id is pv-<kit name>--<preset> (both lowercase, digits and single dashes), so it is a studio slug and a
       job key. A kit URL's query string (a signed link's token) is never written to disk.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import wave
from datetime import datetime, timezone
from pathlib import Path

from studio.config import DATA, ROOT, ffmpeg_bin, ffprobe_bin

PRESETS: dict = json.loads((ROOT / "shared" / "product-presets.json").read_text(encoding="utf-8"))["presets"]
HOME = DATA / "product"
SCHEMA = "lazycow.release-kit"
MAJOR = 1

NAME_RX = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ID_RX = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
VIDEO_RX = re.compile(r"^pv-([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$")
COLOR_RX = re.compile(r"^#[0-9a-fA-F]{6}$")
FAMILY_RX = re.compile(r"^[A-Za-z0-9 ]{1,60}$")
SHA_RX = re.compile(r"^[0-9a-f]{64}$")

MAX_MANIFEST = 1 * 1024 * 1024
MAX_IMAGE = 25 * 1024 * 1024
MAX_VIDEO = 250 * 1024 * 1024
MAX_FONT = 8 * 1024 * 1024
MAX_LOGO = 5 * 1024 * 1024
MAX_TOTAL = 1536 * 1024 * 1024
MAX_SCREENS, MAX_RECORDINGS, MAX_LINES = 24, 8, 30
MAX_SIDE, MAX_PIXELS = 12000, 40_000_000  # a long page capture is tall; Pillow refuses bigger (a decompression bomb)
MAX_CLIP_SEC, MAX_VIDEO_SIDE = 120.0, 4096
CAPTION_MAX, LINE_MAX = 120, 140
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime"}
FONT_TYPES = {"font/woff2", "font/woff", "font/ttf", "font/otf"}
DEVICES = ("phone", "tablet", "desktop")
STORES = {"app-store": "App Store", "google-play": "Google Play", "web": "the web"}
# Bundled faces (public/fonts, OFL) a kit may name by family instead of sending a file.
BUNDLED = {
    "DM Sans": [("DMSans.ttf", "100 1000", "normal")],
    "Jost": [("Jost.ttf", "100 900", "normal")],
    "Fraunces": [("Fraunces.ttf", "100 900", "normal")],
    "Playfair Display": [("PlayfairDisplay.ttf", "400 900", "normal")],
    "Bodoni Moda": [("BodoniModa.ttf", "400 900", "normal")],
    "Cinzel": [("Cinzel.ttf", "400 900", "normal")],
    "Anton": [("Anton-Regular.ttf", "400", "normal")],
    "Bebas Neue": [("BebasNeue-Regular.ttf", "400", "normal")],
    "Barlow Condensed": [("BarlowCondensed-SemiBold.ttf", "600", "normal")],
    "IBM Plex Mono": [("IBMPlexMono-Medium.ttf", "500", "normal")],
    "Zen Kaku Gothic New": [("ZenKakuGothicNew-Medium.ttf", "500", "normal"), ("ZenKakuGothicNew-Bold.ttf", "700", "normal")],
    "Zen Maru Gothic": [("ZenMaruGothic-Medium.ttf", "500", "normal"), ("ZenMaruGothic-Bold.ttf", "700", "normal")],
}
DEFAULT_FAMILY = "DM Sans"
CJK_FAMILY = "Zen Kaku Gothic New"
KIT_FAMILY = "KitBrand"  # a kit's own font file is loaded under this name; its family name never reaches CSS
DEFAULT_BRAND = {"background": "#0d0f14", "text": "#f5f6f8", "primary": "#7c9cff", "accent": "#7c9cff"}

# Seconds on screen (docs/product-kit.md › Timing).
SEC_COMPARE, SEC_SCREEN, SEC_INTRO, SEC_NEWS, SEC_END, SEC_HOLD = 4.6, 3.4, 2.0, 3.2, 2.6, 2.0
SEC_CLIP = (2.5, 10.0)
OVERLAP = 0.5  # scenes cross-fade over this much


class KitError(ValueError):
    def __init__(self, message: str, code: str = "bad_kit", status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


# ---------- names ----------

def video_id(name: str, preset: str) -> str:
    return f"pv-{name}--{preset}"


def parse_video_id(vid: str) -> tuple[str, str] | None:
    m = VIDEO_RX.match(str(vid or ""))
    if not m or m.group(2) not in PRESETS:
        return None
    return m.group(1), m.group(2)


def is_product(vid: str) -> bool:
    """A product video id whose kit is here (a reel could be called pv-… too)."""
    p = parse_video_id(vid)
    return bool(p) and (HOME / p[0] / "kit.json").is_file()


def kit_name(raw) -> str:
    name = str(raw or "").strip().lower()
    if not NAME_RX.match(name) or len(name) > 40:
        raise KitError("name: lowercase letters, digits and single dashes, at most 40 characters, e.g. \"my-app-1-4\".", "bad_input")
    return name


def _slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)[:40].strip("-")


def default_name(kit: dict) -> str:
    base = _slugify(kit["app"]["name"]) or "app"
    ver = _slugify(kit.get("release", {}).get("version", ""))
    name = f"{base[: 40 - len(ver) - 1]}-{ver}".strip("-") if ver else base
    return re.sub(r"-{2,}", "-", name).strip("-") or "app"


# ---------- the manifest (docs/product-kit.schema.json) ----------

def _text(v, limit: int) -> str:
    """Plain text: control characters become spaces, runs of space fold, cut at limit."""
    s = re.sub(r"[\u0000-\u001f\u007f​-‏ -‮]", " ", str(v if v is not None else ""))
    return re.sub(r"\s+", " ", s).strip()[:limit]


def validate_manifest(m) -> dict:
    """A release kit's manifest, checked and cleaned. Raises KitError listing what is wrong (each with its path).
    Unknown fields are ignored; an unknown major version is refused."""
    errs: list[str] = []
    warn: list[str] = []
    if not isinstance(m, dict):
        raise KitError("The kit is not a JSON object (docs/product-kit.md).")
    if m.get("schema") != SCHEMA:
        errs.append(f'schema: must be "{SCHEMA}"')
    ver = m.get("version")
    if not isinstance(ver, int) or isinstance(ver, bool):
        errs.append("version: a whole number (1)")
    elif ver != MAJOR:
        raise KitError(f"This kit is version {ver}; this studio reads version {MAJOR}. Update Lazycow Studio, or export the kit as version {MAJOR}.", "bad_version")

    app = m.get("app") if isinstance(m.get("app"), dict) else None
    if not app or not _text(app.get("name"), 60):
        errs.append("app.name: the app's name is required")
    app = app or {}
    stores = [s for s in (app.get("stores") or []) if s in STORES] if isinstance(app.get("stores"), list) else []
    url = str(app.get("url") or "")
    host = urllib.parse.urlsplit(url).hostname if url.startswith("https://") else None
    out = {"schema": SCHEMA, "version": MAJOR,
           "app": {"name": _text(app.get("name"), 60), "tagline": _text(app.get("tagline"), 90), "host": host or "", "stores": stores}}

    rel = m.get("release") if isinstance(m.get("release"), dict) else {}
    out["release"] = {"version": _text(rel.get("version"), 24), "date": _text(rel.get("date"), 10), "title": _text(rel.get("title"), 80)}

    brand = m.get("brand") if isinstance(m.get("brand"), dict) else {}
    colors = brand.get("colors") if isinstance(brand.get("colors"), dict) else {}
    pal = {}
    for k in ("background", "text", "primary", "accent"):
        v = colors.get(k)
        if v is None:
            continue
        if not isinstance(v, str) or not COLOR_RX.match(v):
            errs.append(f"brand.colors.{k}: a colour like #1a2b3c")
        else:
            pal[k] = v.lower()
    font = brand.get("font") if isinstance(brand.get("font"), dict) else {}
    family = font.get("family")
    if family is not None and (not isinstance(family, str) or not FAMILY_RX.match(family)):
        errs.append("brand.font.family: letters, digits and spaces only")
        family = None
    out["brand"] = {"colors": pal, "font": {"family": family or "", "file": _asset(font.get("file"), "brand.font.file", FONT_TYPES, errs)
                                            if font.get("file") is not None else None},
                    "logo": _asset(brand.get("logo"), "brand.logo", IMAGE_TYPES, errs) if brand.get("logo") is not None else None,
                    "cta": _text(brand.get("cta"), 40)}
    labels = m.get("labels") if isinstance(m.get("labels"), dict) else {}
    out["labels"] = {"before": _text(labels.get("before"), 20) or "Before", "after": _text(labels.get("after"), 20) or "Now",
                     "news": _text(labels.get("news"), 30) or "What's new"}

    seen: set[str] = set()

    def ident(v, where: str) -> str:
        if not isinstance(v, str) or not ID_RX.match(v):
            errs.append(f"{where}.id: lowercase letters, digits and dashes (at most 40)")
            return ""
        if v in seen:
            errs.append(f"{where}.id: \"{v}\" is used twice")
        seen.add(v)
        return v

    screens = m.get("screens") if m.get("screens") is not None else []
    recs = m.get("recordings") if m.get("recordings") is not None else []
    if not isinstance(screens, list):
        errs.append("screens: a list")
        screens = []
    if not isinstance(recs, list):
        errs.append("recordings: a list")
        recs = []
    if len(screens) > MAX_SCREENS:
        errs.append(f"screens: at most {MAX_SCREENS}")
    if len(recs) > MAX_RECORDINGS:
        errs.append(f"recordings: at most {MAX_RECORDINGS}")
    out["screens"] = []
    for i, s in enumerate(screens[:MAX_SCREENS]):
        where = f"screens[{i}]"
        if not isinstance(s, dict):
            errs.append(f"{where}: an object")
            continue
        sid = ident(s.get("id"), where)
        vp = _viewport(s.get("viewport"), where, errs)
        after = _asset(s.get("after"), f"{where}.after", IMAGE_TYPES, errs)
        before = _asset(s.get("before"), f"{where}.before", IMAGE_TYPES, errs) if s.get("before") is not None else None
        focus = s.get("focus") if isinstance(s.get("focus"), dict) else {}
        fx, fy = focus.get("x", 0.5), focus.get("y", 0.35)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1 for v in (fx, fy)):
            errs.append(f"{where}.focus: x and y from 0 to 1")
            fx, fy = 0.5, 0.35
        out["screens"].append({"id": sid, "surface": _text(s.get("surface"), 40), "viewport": vp, "after": after, "before": before,
                               "caption": _text(s.get("caption"), CAPTION_MAX), "focus": {"x": float(fx), "y": float(fy)}})
    out["recordings"] = []
    for i, r in enumerate(recs[:MAX_RECORDINGS]):
        where = f"recordings[{i}]"
        if not isinstance(r, dict):
            errs.append(f"{where}: an object")
            continue
        rid = ident(r.get("id"), where)
        vp = _viewport(r.get("viewport"), where, errs)
        f = _asset(r.get("file"), f"{where}.file", VIDEO_TYPES, errs)
        trim = r.get("trim") if isinstance(r.get("trim"), dict) else {}
        t0, t1 = trim.get("from", 0), trim.get("to")
        if not isinstance(t0, (int, float)) or isinstance(t0, bool) or t0 < 0 or (t1 is not None and (not isinstance(t1, (int, float)) or isinstance(t1, bool) or t1 <= t0)):
            errs.append(f"{where}.trim: from >= 0 and to after from, in seconds")
            t0, t1 = 0, None
        out["recordings"].append({"id": rid, "surface": _text(r.get("surface"), 40), "viewport": vp, "file": f,
                                  "caption": _text(r.get("caption"), CAPTION_MAX), "trim": {"from": float(t0), "to": float(t1) if t1 is not None else None}})
    if not out["screens"] and not out["recordings"] and not any(e.startswith(("screens", "recordings")) for e in errs):
        errs.append("screens or recordings: a kit needs at least one screenshot or recording")

    lines = m.get("changelog") if m.get("changelog") is not None else []
    if not isinstance(lines, list):
        errs.append("changelog: a list of lines")
        lines = []
    if len(lines) > MAX_LINES:
        warn.append(f"changelog: only the first {MAX_LINES} lines are used")
    out["changelog"] = []
    for i, ln in enumerate(lines[:MAX_LINES]):
        if isinstance(ln, str):
            text, surface = ln, ""
        elif isinstance(ln, dict):
            text, surface = ln.get("text"), ln.get("surface") or ""
        else:
            errs.append(f"changelog[{i}]: a line of text or {{text, surface}}")
            continue
        t = _text(text, LINE_MAX)
        if t:
            out["changelog"].append({"text": t, "surface": _text(surface, 40)})
    exp = m.get("expiresAt")
    if isinstance(exp, str):
        try:
            when = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            if when.tzinfo and when < datetime.now(timezone.utc):
                warn.append("expiresAt: the kit's links have expired; export a fresh kit if downloads fail")
        except ValueError:
            errs.append("expiresAt: an ISO 8601 time, e.g. 2026-11-28T00:00:00Z")
    if errs:
        more = f" (and {len(errs) - 8} more)" if len(errs) > 8 else ""
        raise KitError("The kit does not match docs/product-kit.md: " + "; ".join(errs[:8]) + more + ".")
    out["warnings"] = warn
    return out


def _asset(a, where: str, types: set[str], errs: list[str]) -> dict | None:
    if not isinstance(a, dict):
        errs.append(f"{where}: an object with a url")
        return None
    url = a.get("url")
    if not isinstance(url, str) or not url.strip() or len(url) > 4000:
        errs.append(f"{where}.url: required")
        return None
    t = a.get("type")
    if t is not None and t not in types:
        errs.append(f"{where}.type: one of {', '.join(sorted(types))}")
    b = a.get("bytes")
    if b is not None and (not isinstance(b, int) or isinstance(b, bool) or b <= 0):
        errs.append(f"{where}.bytes: a whole number of bytes")
        b = None
    sha = a.get("sha256")
    if sha is not None and (not isinstance(sha, str) or not SHA_RX.match(sha.lower())):
        errs.append(f"{where}.sha256: 64 hex characters")
        sha = None
    return {"url": url.strip(), "type": t, "bytes": b, "sha256": sha.lower() if isinstance(sha, str) else None}


def _viewport(v, where: str, errs: list[str]) -> dict:
    if not isinstance(v, dict):
        errs.append(f"{where}.viewport: an object with width and height")
        return {"width": 390, "height": 844, "device": "phone", "platform": ""}
    w, h = v.get("width"), v.get("height")
    if not all(isinstance(x, int) and not isinstance(x, bool) and 100 <= x <= 8000 for x in (w, h)):
        errs.append(f"{where}.viewport: width and height, whole pixels from 100 to 8000")
        w, h = 390, 844
    dev = v.get("device")
    if dev is not None and dev not in DEVICES:
        errs.append(f"{where}.viewport.device: one of {', '.join(DEVICES)}")
        dev = None
    plat = v.get("platform") if v.get("platform") in ("ios", "android", "web") else ""
    return {"width": w, "height": h, "device": dev or infer_device(w, h), "platform": plat}


def infer_device(w: int, h: int) -> str:
    if h >= w * 1.55:
        return "phone"
    if w >= h * 1.2 and w >= 960:
        return "desktop"
    return "tablet"


# ---------- spec checks (shared/product-presets.json) ----------

def preset(pid) -> dict:
    p = PRESETS.get(str(pid or ""))
    if not p:
        raise KitError(f"preset: one of {', '.join(PRESETS)}.", "bad_input")
    return p


def check_spec(pid: str, seconds: float, fps: float, width: int, height: int) -> list[str]:
    """What breaks the preset's spec, in plain words ([] when it fits)."""
    p = preset(pid)
    out = []
    if seconds < p["minSec"] - 1e-6 or seconds > p["maxSec"] + 1e-6:
        out.append(f"{p['label']} must be {p['minSec']}-{p['maxSec']} s long; this would be {seconds:.1f} s")
    if fps > 30 + 1e-6 or abs(fps - p["fps"]) > 1e-6:
        out.append(f"{p['label']} plays at {p['fps']} fps (at most 30); this would be {fps:g} fps")
    if (width, height) != (p["width"], p["height"]):
        out.append(f"{p['label']} is {p['width']}x{p['height']}; this would be {width}x{height}")
    return out


def verify_file(pid: str, probe: dict, size_bytes: int) -> list[str]:
    """The rendered file against the preset, from ffprobe's JSON (-show_streams -show_format)."""
    p = preset(pid)
    enc = p["encode"]
    streams = probe.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not v:
        return ["the file has no picture"]
    num, _, den = str(v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    try:  # the picture's own length: AAC priming can make the container a few milliseconds longer
        seconds = float(v.get("duration") or (probe.get("format") or {}).get("duration") or 0)
    except ValueError:
        seconds = 0.0
    out = check_spec(pid, round(seconds, 2), round(fps, 3), int(v.get("width") or 0), int(v.get("height") or 0))
    if v.get("codec_name") != "h264":
        out.append(f"the picture must be H.264 (it is {v.get('codec_name')})")
    if str(v.get("profile") or "").lower() not in ("high", "main", "constrained baseline", "baseline"):
        out.append(f"H.264 profile must be High or lower (it is {v.get('profile')})")
    want = int(round(float(enc["level"]) * 10))
    if int(v.get("level") or 0) > want:
        out.append(f"H.264 level must be {enc['level']} or lower (it is {int(v.get('level') or 0) / 10:g})")
    if v.get("pix_fmt") != "yuv420p":
        out.append(f"pixels must be yuv420p (they are {v.get('pix_fmt')})")
    if not a:
        out.append("the file needs a stereo sound track (a quiet one is fine)")
    else:
        if a.get("codec_name") != "aac" or int(a.get("channels") or 0) != 2:
            out.append(f"sound must be stereo AAC (it is {a.get('codec_name')}, {a.get('channels')} channels)")
        if int(a.get("sample_rate") or 0) not in (44100, 48000):
            out.append(f"sound must be 44.1 or 48 kHz (it is {a.get('sample_rate')} Hz)")
        # Apple lists 256 kbps AAC; a digitally silent track measures about 2 kbps. 90 % allows for the encoder's own
        # rate control (the quiet bed measures about 253 kbps).
        try:
            kbps = int(a.get("bit_rate") or 0) / 1000
        except ValueError:
            kbps = 0.0
        if kbps < enc["audioKbps"] * 0.9:
            out.append(f"sound must be about {enc['audioKbps']} kbps AAC (it is {kbps:.0f} kbps)")
    if size_bytes > enc["maxMb"] * 1024 * 1024:
        out.append(f"the file must be at most {enc['maxMb']} MB (it is {size_bytes / 1024 / 1024:.0f} MB)")
    return out


# ---------- fetching a kit ----------

class _Hop(urllib.request.HTTPRedirectHandler):
    """Every redirect is checked like the first address: https, public, at most 5."""
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _public_https(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _public_https(url: str) -> str:
    p = urllib.parse.urlsplit(url)
    if p.scheme != "https" or not p.hostname or len(url) > 4000:
        raise KitError("Kit links must start with https:// (or use a kit folder on this computer).", "bad_url")
    host = p.hostname.lower()
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        raise KitError("That link points at this computer or this network; a kit link must be a public https address.", "bad_url")
    try:
        infos = socket.getaddrinfo(host, p.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise KitError(f"Could not find {host}. Check the kit link, or your internet connection.", "unreachable", 502) from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise KitError("That link points at this computer or this network; a kit link must be a public https address.", "bad_url")
    return url


def _shown(url: str) -> str:
    """A link without its query or fragment (a signed link's token stays out of logs, errors and files)."""
    p = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, "", "")) if p.scheme else url


def _download(url: str, limit: int, what: str) -> bytes:
    from studio.providers.http import _tls, with_agent

    _public_https(url)
    opener = urllib.request.build_opener(_Hop, urllib.request.HTTPSHandler(context=_tls()))
    req = urllib.request.Request(url, headers=with_agent({"Accept": "*/*"}))
    try:
        with opener.open(req, timeout=60) as r:
            declared = r.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > limit:
                raise KitError(f"{what} is {int(declared) / 1024 / 1024:.0f} MB; at most {limit // 1024 // 1024} MB.", "too_big", 413)
            chunks, got = [], 0
            while True:
                c = r.read(1 << 16)
                if not c:
                    break
                got += len(c)
                if got > limit:
                    raise KitError(f"{what} is over {limit // 1024 // 1024} MB.", "too_big", 413)
                chunks.append(c)
            return b"".join(chunks)
    except urllib.error.HTTPError as err:
        hint = " The kit's links may have expired: export a fresh kit." if err.code in (400, 401, 403, 404, 410) else ""
        raise KitError(f"{what} could not be downloaded ({err.code} from {_shown(url)}).{hint}", "download", 502) from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as err:
        if isinstance(err, KitError):
            raise
        reason = getattr(err, "reason", err)
        raise KitError(f"{what} could not be downloaded from {_shown(url)} ({str(reason)[:120]}).", "download", 502) from None


class _Source:
    """Where a kit's files come from: https links (relative ones against the manifest's link) or one folder here."""

    def __init__(self, kit_url: str | None = None, folder: Path | None = None):
        self.url, self.folder = kit_url, folder

    def read(self, ref: str, limit: int, what: str) -> bytes:
        if self.folder is not None:
            if re.match(r"^[a-z][a-z0-9+.-]*:", ref, re.I) or ref.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", ref):
                raise KitError(f"{what}: in a kit folder, files are named by their path inside the folder (got {ref[:80]}).")
            path = (self.folder / ref).resolve()
            if not path.is_relative_to(self.folder):
                raise KitError(f"{what}: {ref[:80]} is outside the kit folder.")
            if not path.is_file():
                raise KitError(f"{what}: {ref[:80]} is not in the kit folder.", "missing", 404)
            if path.stat().st_size > limit:
                raise KitError(f"{what} is over {limit // 1024 // 1024} MB.", "too_big", 413)
            return path.read_bytes()
        absolute = urllib.parse.urljoin(self.url or "", ref)
        return _download(absolute, limit, what)


def sniff(raw: bytes) -> str | None:
    """What the bytes are, from their first bytes (never from a name or a claimed type)."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[4:8] == b"ftyp":
        return "video/quicktime" if raw[8:10] == b"qt" else "video/mp4"
    if raw.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if raw.startswith(b"wOF2"):
        return "font/woff2"
    if raw.startswith(b"wOFF"):
        return "font/woff"
    if raw.startswith((b"\x00\x01\x00\x00", b"true")):
        return "font/ttf"
    if raw.startswith(b"OTTO"):
        return "font/otf"
    return None


def _checked(raw: bytes, asset: dict, allowed: set[str], what: str) -> str:
    kind = sniff(raw)
    if kind not in allowed:
        raise KitError(f"{what} is not {' or '.join(sorted(t.split('/')[1].upper() for t in allowed))} (its bytes say {kind or 'something else'}).", "bad_file", 415)
    if asset.get("bytes") and asset["bytes"] != len(raw):
        raise KitError(f"{what} is {len(raw)} bytes; the kit says {asset['bytes']}. Export a fresh kit.", "bad_file", 422)
    if asset.get("sha256") and hashlib.sha256(raw).hexdigest() != asset["sha256"]:
        raise KitError(f"{what} does not match the kit's sha256. Export a fresh kit.", "bad_file", 422)
    return kind


def _clean_image(raw: bytes, dest: Path, what: str, max_side: int = MAX_SIDE) -> tuple[int, int]:
    """Re-save a picture as PNG: its pixels only (no metadata), the right way up."""
    from io import BytesIO

    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(BytesIO(raw)) as im:
            if im.format not in ("PNG", "JPEG", "WEBP"):
                raise KitError(f"{what} is not a PNG, JPEG or WebP picture.", "bad_file", 415)
            w, h = im.size
            if w > max_side or h > max_side or w * h > MAX_PIXELS or w < 16 or h < 16:
                raise KitError(f"{what} is {w}x{h}; pictures may be at most {max_side} px a side and {MAX_PIXELS // 1_000_000} megapixels.", "too_big", 413)
            im = ImageOps.exif_transpose(im)
            im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
            dest.parent.mkdir(parents=True, exist_ok=True)
            im.save(dest, "PNG", optimize=False)
            return im.size
    except KitError:
        raise
    except Exception as err:  # Pillow's own errors for a broken or bomb-sized file
        raise KitError(f"{what} could not be read as a picture ({type(err).__name__}).", "bad_file", 415) from None


def _thumb(src: Path, dest: Path, width: int = 360) -> None:
    from PIL import Image

    with Image.open(src) as im:
        top = im.crop((0, 0, im.width, min(im.height, round(im.width * 2.4))))  # a long page: its first screens
        h = max(1, round(top.height * width / top.width))
        top.convert("RGB").resize((width, h)).save(dest, "JPEG", quality=82)


def _probe(path: Path) -> dict:
    r = subprocess.run([str(ffprobe_bin()), "-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", str(path)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    try:
        return json.loads(r.stdout or "{}")
    except ValueError:
        return {}


def _clean_video(raw: bytes, dest: Path, poster: Path, trim: dict, what: str) -> dict:
    """A recording re-encoded for the composition: H.264 at 30 fps, even sizes, no sound, no metadata."""
    tmp = dest.with_suffix(".in")
    tmp.write_bytes(raw)
    try:
        info = _probe(tmp)
        v = next((s for s in info.get("streams") or [] if s.get("codec_type") == "video"), None)
        if not v:
            raise KitError(f"{what} has no picture ffprobe can read.", "bad_file", 415)
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        try:
            dur = float((info.get("format") or {}).get("duration") or v.get("duration") or 0)
        except ValueError:
            dur = 0.0
        if not (16 <= w <= MAX_VIDEO_SIDE and 16 <= h <= MAX_VIDEO_SIDE):
            raise KitError(f"{what} is {w}x{h}; recordings may be at most {MAX_VIDEO_SIDE} px a side.", "too_big", 413)
        if dur <= 0.3 or dur > MAX_CLIP_SEC:
            raise KitError(f"{what} is {dur:.1f} s; recordings may be up to {MAX_CLIP_SEC:.0f} s.", "too_big", 413)
        t0 = min(trim.get("from") or 0.0, max(0.0, dur - 0.5))
        t1 = min(trim.get("to") or dur, dur)
        ff = str(ffmpeg_bin())
        cmd = [ff, "-y", "-v", "error", "-protocol_whitelist", "file", "-ss", f"{t0:.3f}", "-i", str(tmp), "-t", f"{max(0.5, t1 - t0):.3f}",
               "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1",
               "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-movflags", "+faststart", str(dest)]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60 * 10)
        if r.returncode != 0 or not dest.exists():
            raise KitError(f"{what} could not be re-encoded: {(r.stderr or '').strip().splitlines()[-1:] or ['ffmpeg failed']}", "bad_file", 415)
        subprocess.run([ff, "-y", "-v", "error", "-i", str(dest), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", str(poster)],
                       capture_output=True, timeout=60)
        out = _probe(dest)
        ov = next((s for s in out.get("streams") or [] if s.get("codec_type") == "video"), {})
        try:
            seconds = float((out.get("format") or {}).get("duration") or 0)
        except ValueError:
            seconds = t1 - t0
        return {"width": int(ov.get("width") or w), "height": int(ov.get("height") or h), "seconds": round(seconds, 3)}
    finally:
        tmp.unlink(missing_ok=True)


def _locate(req: dict) -> tuple[_Source, dict, str]:
    """The manifest and where its files come from, from {kitUrl} (https or file:) or {kitPath} (a folder or a .json)."""
    url = req.get("kitUrl")
    path = req.get("kitPath")
    if isinstance(url, str) and url.startswith("file:"):
        path, url = urllib.request.url2pathname(urllib.parse.urlsplit(url).path), None
    if isinstance(path, str) and path.strip():
        p = Path(path.strip()).expanduser()
        if p.is_dir():
            p = p / "manifest.json"
        if not p.is_file():
            raise KitError(f"No kit at {p}: a kit folder holds manifest.json beside its files.", "missing", 404)
        if p.stat().st_size > MAX_MANIFEST:
            raise KitError("The kit's manifest is over 1 MB.", "too_big", 413)
        raw = p.read_bytes()
        source, shown = _Source(folder=p.parent.resolve()), str(p)
    elif isinstance(url, str) and url.strip():
        url = url.strip()
        raw = _download(url, MAX_MANIFEST, "The kit's manifest")
        source, shown = _Source(kit_url=url), _shown(url)
    else:
        raise KitError("kitUrl: the release kit's https link (or a kit folder on this computer).", "bad_input")
    try:
        manifest = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise KitError("The kit's manifest is not valid JSON.") from None
    return source, manifest, shown


def fetch(req: dict, say=print) -> dict:
    """Check and download a kit into <data>/product/<name>/ (a kit of the same name is replaced)."""
    source, manifest, shown = _locate(req)
    kit = validate_manifest(manifest)
    name = kit_name(req["name"]) if req.get("name") else default_name(kit)
    if name in (req.get("busy") or []):
        raise KitError(f"A video of the kit {name} is rendering now; add this kit when it is done, or under another name.", "busy", 409)
    home = HOME / name
    files = home / "files.new"
    shutil.rmtree(files, ignore_errors=True)
    files.mkdir(parents=True)
    total = 0

    def get(asset: dict, limit: int, allowed: set[str], what: str) -> tuple[bytes, str]:
        nonlocal total
        raw = source.read(asset["url"], limit, what)
        total += len(raw)
        if total > MAX_TOTAL:
            raise KitError(f"The kit is over {MAX_TOTAL // 1024 // 1024} MB in all.", "too_big", 413)
        return raw, _checked(raw, asset, allowed, what)

    steps = len(kit["screens"]) + len(kit["recordings"]) + 1
    n = 0
    try:
        for s in kit["screens"]:
            n += 1
            say(f"PROGRESS {n}/{steps} screen {s['id']}", flush=True)
            for side in ("before", "after"):
                if not s[side]:
                    continue
                raw, _ = get(s[side], MAX_IMAGE, IMAGE_TYPES, f"Screen {s['id']} ({side})")
                dest = files / f"s-{s['id']}-{side}.png"
                w, h = _clean_image(raw, dest, f"Screen {s['id']} ({side})")
                _thumb(dest, files / f"s-{s['id']}-{side}.thumb.jpg")
                s[side] = {"file": dest.name, "thumb": f"s-{s['id']}-{side}.thumb.jpg", "width": w, "height": h}
        for r in kit["recordings"]:
            n += 1
            say(f"PROGRESS {n}/{steps} recording {r['id']}", flush=True)
            raw, _ = get(r["file"], MAX_VIDEO, VIDEO_TYPES, f"Recording {r['id']}")
            meta = _clean_video(raw, files / f"r-{r['id']}.mp4", files / f"r-{r['id']}.thumb.jpg", r["trim"], f"Recording {r['id']}")
            r["file"] = {"file": f"r-{r['id']}.mp4", "thumb": f"r-{r['id']}.thumb.jpg", **meta}
        b = kit["brand"]
        if b["logo"]:
            raw, _ = get(b["logo"], MAX_LOGO, IMAGE_TYPES, "The logo")
            w, h = _clean_image(raw, files / "logo.png", "The logo", max_side=4096)
            b["logo"] = {"file": "logo.png", "width": w, "height": h}
        if b["font"]["file"]:
            raw, kind = get(b["font"]["file"], MAX_FONT, FONT_TYPES, "The brand font")
            ext = {"font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf"}[kind]
            (files / f"brand-font{ext}").write_bytes(raw)
            b["font"]["file"] = {"file": f"brand-font{ext}"}
    except Exception:
        shutil.rmtree(files, ignore_errors=True)
        raise
    old = home / "files"
    shutil.rmtree(old, ignore_errors=True)
    files.rename(old)
    shutil.rmtree(home / "renders", ignore_errors=True)  # made from the kit this one replaces: never shown as current
    kit["name"] = name
    kit["source"] = {"from": shown, "fetched": datetime.now().isoformat(timespec="seconds"), "bytes": total}
    (home / "kit.json").write_text(json.dumps(kit, ensure_ascii=False, indent=2), encoding="utf-8")
    say(f"PROGRESS {steps}/{steps} kit ready", flush=True)
    return kit_view(name)


# ---------- reading kits ----------

def load_kit(name: str) -> dict:
    name = kit_name(name)
    try:
        return json.loads((HOME / name / "kit.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise KitError(f"There is no product kit called {name}. Add it first (kitUrl).", "not_found", 404) from None


def kit_view(name: str) -> dict:
    kit = load_kit(name)
    renders = {}
    for pid in PRESETS:
        res = HOME / name / "renders" / f"{pid}.json"
        if res.is_file():
            try:
                renders[pid] = json.loads(res.read_text(encoding="utf-8"))
            except ValueError:
                pass
    fits = {}
    for pid in PRESETS:
        try:
            pl = plan(kit, pid)
            fits[pid] = {"ok": True, "seconds": pl["seconds"], "scenes": len(pl["scenes"]), "warnings": pl["warnings"]}
        except KitError as err:
            fits[pid] = {"ok": False, "why": str(err)}
    return {**kit, "renders": renders, "fits": fits}


def list_kits() -> list[dict]:
    out = []
    if not HOME.is_dir():
        return out
    for d in sorted(HOME.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            kit = json.loads((d / "kit.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rendered = sorted(p.stem for p in (d / "renders").glob("*.json")) if (d / "renders").is_dir() else []
        thumb = next((s["after"]["thumb"] for s in kit.get("screens", []) if s.get("after")), None) \
            or next((r["file"]["thumb"] for r in kit.get("recordings", [])), None)
        out.append({"name": d.name, "app": kit["app"]["name"], "version": kit.get("release", {}).get("version", ""), "screens": len(kit.get("screens", [])),
                    "recordings": len(kit.get("recordings", [])), "rendered": rendered, "thumb": thumb, "fetched": kit.get("source", {}).get("fetched")})
    return out


# ---------- the timeline ----------

def _lum(hex_color: str) -> float:
    rgb = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def palette(kit: dict) -> dict:
    """The kit's colours, with words that stay readable: text that is too close to the background turns white or ink."""
    c = {**DEFAULT_BRAND, **(kit.get("brand", {}).get("colors") or {})}
    if "accent" not in (kit.get("brand", {}).get("colors") or {}) and "primary" in (kit.get("brand", {}).get("colors") or {}):
        c["accent"] = c["primary"]
    if contrast(c["text"], c["background"]) < 4.5:
        c["text"] = "#ffffff" if contrast("#ffffff", c["background"]) >= contrast("#111111", c["background"]) else "#111111"
    # Words on the accent (the end card's call to action).
    c["onAccent"] = "#ffffff" if contrast("#ffffff", c["accent"]) >= contrast("#111111", c["accent"]) else "#111111"
    return c


def fonts(kit: dict, base: str) -> tuple[str, list[dict]]:
    """The family to set the words in, and the faces the composition loads first."""
    faces = [{"family": DEFAULT_FAMILY, "src": "fonts/DMSans.ttf", "weight": "100 1000", "style": "normal"}]
    faces += [{"family": CJK_FAMILY, "src": f"fonts/{f}", "weight": w, "style": s} for f, w, s in BUNDLED[CJK_FAMILY]]
    font = kit.get("brand", {}).get("font") or {}
    if isinstance(font.get("file"), dict) and font["file"].get("file"):
        faces.insert(0, {"family": KIT_FAMILY, "src": f"{base}/{font['file']['file']}", "weight": "100 900", "style": "normal"})
        return KIT_FAMILY, faces
    fam = font.get("family") or ""
    if fam in BUNDLED and fam not in (DEFAULT_FAMILY, CJK_FAMILY):
        faces[:0] = [{"family": fam, "src": f"fonts/{f}", "weight": w, "style": s} for f, w, s in BUNDLED[fam]]
        return fam, faces
    return (fam if fam in BUNDLED else DEFAULT_FAMILY), faces


def _aspect_ok(w: int, h: int, cw: int, ch: int) -> bool:
    """Close enough to fill the picture with a gentle crop (App Store: the app full screen)."""
    return abs((w / h) / (cw / ch) - 1) <= 0.18


def plan(kit: dict, pid: str) -> dict:
    """The timeline for one preset. Raises KitError when nothing in the kit fits or the result breaks the spec."""
    p = preset(pid)
    W, H, fps = p["width"], p["height"], p["fps"]
    full = p["frame"] == "none"
    warn: list[str] = []
    base = f"product-kits/{kit['name']}/files"
    lines = list(kit.get("changelog") or [])
    used: set[int] = set()

    def caption_for(item: dict) -> str:
        if item.get("caption"):
            return item["caption"]
        keys = {item["id"], (item.get("surface") or "").lower()}
        for i, ln in enumerate(lines):
            if i not in used and ln["surface"] and ln["surface"].lower() in keys:
                used.add(i)
                return ln["text"]
        for i, ln in enumerate(lines):
            if i not in used and not ln["surface"]:
                used.add(i)
                return ln["text"]
        return ""

    items: list[dict] = []
    skipped = []
    for s in kit.get("screens", []):
        if not s.get("after"):
            continue
        dev = s["viewport"]["device"]
        w, h = s["after"]["width"], s["after"]["height"]
        if dev not in p["screens"] or (full and not _aspect_ok(w, h, W, H)):
            skipped.append(s["id"])
            continue
        compare = bool(p["compare"] and s.get("before"))
        items.append({"kind": "compare" if compare else "screen", "id": s["id"], "surface": s.get("surface", ""), "device": dev,
                      "platform": s["viewport"].get("platform", ""), "src": f"{base}/{s['after']['file']}",
                      "before": f"{base}/{s['before']['file']}" if compare else None, "w": w, "h": h,
                      "vw": s["viewport"]["width"], "vh": s["viewport"]["height"], "focus": s.get("focus") or {"x": 0.5, "y": 0.35},
                      "sec": SEC_COMPARE if compare else SEC_SCREEN, "_item": s})
    recs = []
    for r in kit.get("recordings", []):
        dev = r["viewport"]["device"]
        w, h = r["file"]["width"], r["file"]["height"]
        if dev not in p["screens"] or (full and not _aspect_ok(w, h, W, H)):
            skipped.append(r["id"])
            continue
        clip = float(r["file"]["seconds"])
        recs.append({"kind": "recording", "id": r["id"], "surface": r.get("surface", ""), "device": dev, "platform": r["viewport"].get("platform", ""),
                     "src": f"{base}/{r['file']['file']}", "before": None, "w": w, "h": h, "focus": {"x": 0.5, "y": 0.5},
                     "clipSec": clip, "sec": min(max(clip, SEC_CLIP[0]), SEC_CLIP[1]), "_item": r})
    # A recording follows the screen of its surface; the rest come after the screens.
    for r in recs:
        at = next((i for i, it in enumerate(items) if it["surface"] and it["surface"] == r["surface"]), None)
        if at is None:
            items.append(r)
        else:
            items.insert(at + 1, r)
    if not items:
        need = {"app-store": f"captures from the {' or '.join(p['screens'])} app, close to {W}x{H} in shape"}.get(p["store"], "a screenshot or recording")
        raise KitError(f"Nothing in this kit fits {p['label']}: it needs {need}." + (f" Skipped: {', '.join(skipped)}." if skipped else ""), "no_fit", 422)
    if skipped:
        warn.append(f"Not used in this preset (wrong shape or device): {', '.join(skipped)}.")

    intro = 0.0 if full else SEC_INTRO
    def total(xs: list[dict], news: float) -> float:
        body = sum(x["sec"] for x in xs)
        n = len(xs) + (1 if intro else 0) + (1 if news else 0) + 1  # the end overlaps the last scene too
        return intro + body + news + (SEC_HOLD if full else SEC_END) - OVERLAP * max(0, n - 1)

    top = p["maxSec"] - 0.25  # a margin under the limit: the encoder may pad the sound by a few milliseconds
    # Too long: drop from the end (a store preview keeps its first screens, which carry the most).
    while len(items) > 1 and total(items, 0.0) > top:
        gone = items.pop()
        warn.append(f"{gone['id']} left out: {p['label']} is at most {p['maxSec']} s.")
    for it in items:
        it["caption"] = caption_for(it["_item"])
    rest = [ln["text"] for i, ln in enumerate(lines) if i not in used][:4]
    news = SEC_NEWS if rest and not full and total(items, SEC_NEWS) <= top else 0.0
    if rest and not news:
        warn.append(f"{len(rest)} changelog line{'s' if len(rest) != 1 else ''} not shown." + (" App Store previews show the app itself (Guideline 2.3.4), so lines without a screen stay out." if full else ""))
        rest = []
    # Too short: screens hold longer (up to 1.8x toward the target, then whatever reaching the minimum takes); a
    # recording holds its last frame.
    t = total(items, news)
    if t < p["targetSec"]:
        stretch = [x for x in items if x["kind"] != "recording"] or items
        room = sum(x["sec"] for x in stretch)
        k = min(1.8, 1 + (p["targetSec"] - t) / room)
        for x in stretch:
            x["sec"] *= k
        t = total(items, news)
    if t < p["minSec"]:
        stretch = [x for x in items if x["kind"] != "recording"] or items
        room = sum(x["sec"] for x in stretch)
        k = 1 + (p["minSec"] - t + 0.05) / room
        for x in stretch:
            x["sec"] *= k
        t = total(items, news)

    def frames(sec: float) -> int:
        return max(1, round(sec * fps))

    ov = frames(OVERLAP)
    at = 0
    scenes = []
    title = None
    if intro:
        title = {"from": 0, "dur": frames(intro)}
        at = title["dur"] - ov
    for it in items:
        d = frames(it["sec"])
        sc = {k: v for k, v in it.items() if k not in ("_item", "sec")}
        sc.update({"from": at, "dur": d})
        if it["kind"] == "recording":
            sc["clipFrames"] = max(1, math.floor(it["clipSec"] * fps))
        scenes.append(sc)
        at += d - ov
    news_scene = None
    if news:
        news_scene = {"from": at, "dur": frames(news), "lines": rest}
        at += news_scene["dur"] - ov
    end = {"from": at, "dur": frames(SEC_HOLD if full else SEC_END), "kind": "overlay" if full else "card"}
    duration = end["from"] + end["dur"]
    seconds = round(duration / fps, 3)
    problems = check_spec(pid, seconds, fps, W, H)
    if problems:
        raise KitError("The video would not fit the preset: " + "; ".join(problems) + ".", "spec", 422)
    family, faces = fonts(kit, base)
    stores = [STORES[s] for s in kit["app"].get("stores", []) if s in STORES]
    return {
        "preset": {"id": pid, "label": p["label"], "width": W, "height": H, "fps": fps, "frame": p["frame"], "orientation": p["orientation"], "store": p["store"]},
        "durationInFrames": duration, "seconds": seconds, "overlap": ov,
        "app": {"name": kit["app"]["name"], "tagline": kit["app"].get("tagline", ""), "host": kit["app"].get("host", ""),
                "version": kit.get("release", {}).get("version", ""), "cta": kit.get("brand", {}).get("cta") or f"Get {kit['app']['name']}"[:40],
                "stores": stores},
        "brand": {**palette(kit), "family": family}, "fonts": faces,
        "logo": f"{base}/{kit['brand']['logo']['file']}" if kit.get("brand", {}).get("logo") else None,
        "labels": kit.get("labels") or {"before": "Before", "after": "Now", "news": "What's new"},
        "title": title, "scenes": scenes, "news": news_scene, "end": end, "warnings": warn,
    }


# ---------- render ----------

def _stage(n: int, of: int, what: str) -> None:
    print(f"STAGE {n}/{of} {what}", flush=True)


def _link_kits() -> None:
    """<remotion public>/product-kits -> <data>/product, so staticFile() reaches the kit's files (the open project's)."""
    import os

    from studio.remotion import _link_dir, public_dir

    HOME.mkdir(parents=True, exist_ok=True)
    link = public_dir() / "product-kits"
    if link.is_symlink() or getattr(link, "is_junction", lambda: False)():
        try:
            if Path(os.readlink(link)).resolve() == HOME.resolve():
                return
        except OSError:
            pass
        link.unlink() if link.is_symlink() else os.rmdir(link)
    elif link.exists():
        raise KitError(f"{link} is in the way of the kit link; remove it and render again.", "bad_setup", 500)
    _link_dir(HOME.resolve(), link)


def _silence(path: Path, seconds: float, rate: int) -> None:
    """A quiet stereo bed (App Store previews need a 256 kbps AAC track), written here: no ffmpeg filter needed.

    Digital silence encodes to about 2 kbps whatever -b:a says (measured 27 Nov 2026, ffmpeg 9.0 aac), and Apple lists
    256 kbps AAC. So the bed is TPDF dither of one 16-bit step (about -90 dBFS: below hearing, what any 16-bit master
    carries), each channel its own: with intensity and mid/side stereo off (encode_args) the encoder then holds about
    253 kbps. Seeded, so the same plan gives the same bytes."""
    import random
    from array import array

    rnd = random.Random(0x1A2C0)
    steps = (-1, 0, 0, 1)  # two uniform +-0.5 step draws, summed and rounded: triangular (TPDF) dither

    def second() -> bytes:  # one second, both channels interleaved, 16-bit little-endian
        block = array("h", rnd.choices(steps, k=2 * rate))
        if sys.byteorder != "little":
            block.byteswap()
        return block.tobytes()

    frames = int(math.ceil(seconds * rate)) + rate
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        while frames > 0:
            n = min(frames, rate)
            w.writeframes(second()[: n * 4])
            frames -= n


def encode_args(pid: str, src: Path, wav: Path, dest: Path, seconds: float) -> list[str]:
    """ffmpeg arguments that make a file inside the preset's spec (shared/product-presets.json encode)."""
    p = preset(pid)
    e = p["encode"]
    return [str(ffmpeg_bin()), "-y", "-v", "error", "-i", str(src), "-i", str(wav), "-map", "0:v:0", "-map", "1:a:0", "-t", f"{seconds:.3f}",
            "-r", str(p["fps"]), "-vf", f"scale={p['width']}:{p['height']}:flags=lanczos,setsar=1,format=yuv420p",
            "-c:v", "libx264", "-profile:v", e["profile"], "-level:v", e["level"], "-preset", "medium",
            "-b:v", f"{e['videoKbps']}k", "-maxrate", f"{e['maxKbps']}k", "-bufsize", f"{e['maxKbps'] * 2}k", "-g", str(p["fps"] * 2),
            # Intensity and mid/side stereo off: they fold the quiet bed's two channels together and the track falls to
            # about 240 kbps (_silence).
            "-c:a", "aac", "-b:a", f"{e['audioKbps']}k", "-aac_is", "0", "-aac_ms", "0", "-ar", str(e["audioRate"]), "-ac", "2",
            "-map_metadata", "-1", "-movflags", "+faststart", str(dest)]


def build(vid: str) -> dict:
    """Render one product video: plan, Remotion, encode to spec, check the file. Prints STAGE/PROGRESS and RESULT."""
    from studio.remotion import _remotion

    parsed = parse_video_id(vid)
    if not parsed:
        raise KitError(f"Not a product video id: {vid} (pv-<kit name>--<preset>).", "bad_input")
    name, pid = parsed
    kit = load_kit(name)
    _stage(1, 4, "planning the product video")
    pl = plan(kit, pid)
    out = HOME / name / "renders"
    out.mkdir(parents=True, exist_ok=True)
    props = out / f"{pid}-props.json"
    props.write_text(json.dumps(pl, ensure_ascii=False), encoding="utf-8")
    raw = out / f"{pid}.raw.mp4"
    final = out / f"{pid}.mp4"
    _stage(2, 4, "rendering the product video")
    _link_kits()
    if not _remotion("ProductPreview", props, raw, "--crf=14", "--pixel-format=yuv420p"):
        log = raw.with_suffix(".log")
        tail = log.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-3:] if log.exists() else []
        raise KitError("The render failed: " + (" | ".join(tail)[-400:] or "see the render log"), "render", 500)
    _stage(3, 4, f"encoding to the {pl['preset']['label']} spec")
    wav = out / f"{pid}.silence.wav"
    _silence(wav, pl["seconds"], PRESETS[pid]["encode"]["audioRate"])
    r = subprocess.run(encode_args(pid, raw, wav, final, pl["seconds"]), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60 * 20)
    wav.unlink(missing_ok=True)
    if r.returncode != 0 or not final.exists():
        raise KitError("Encoding failed: " + ((r.stderr or "").strip().splitlines() or ["ffmpeg failed"])[-1][:300], "render", 500)
    raw.unlink(missing_ok=True)
    _stage(4, 4, "checking the file against the spec")
    probe = _probe(final)
    size = final.stat().st_size
    problems = verify_file(pid, probe, size)
    v = next((s for s in probe.get("streams") or [] if s.get("codec_type") == "video"), {})
    res = {"id": vid, "kit": name, "preset": pid, "label": pl["preset"]["label"], "file": str(final), "bytes": size,
           "seconds": round(float(v.get("duration") or (probe.get("format") or {}).get("duration") or 0), 3), "width": v.get("width"), "height": v.get("height"),
           "fps": v.get("avg_frame_rate"), "profile": v.get("profile"), "level": v.get("level"), "ok": not problems, "problems": problems,
           "warnings": pl["warnings"], "made": datetime.now().isoformat(timespec="seconds")}
    (out / f"{pid}.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    if problems:
        raise KitError("The file does not meet the spec: " + "; ".join(problems) + ".", "spec", 500)
    return res


# ---------- the AI reviewer (optional, inside the studio's AI limits) ----------

def _render_of(vid: str) -> tuple[str, str, Path, dict]:
    parsed = parse_video_id(vid)
    if not parsed:
        raise KitError(f"Not a product video id: {vid}.", "bad_input")
    name, pid = parsed
    mp4 = HOME / name / "renders" / f"{pid}.mp4"
    props = HOME / name / "renders" / f"{pid}-props.json"
    if not mp4.is_file() or not props.is_file():
        raise KitError(f"Render {vid} first: the reviewer watches the finished video.", "not_rendered", 409)
    return name, pid, mp4, json.loads(props.read_text(encoding="utf-8"))


def review_project(pl: dict) -> dict:
    """The timeline in the shape studio.ai's reviewer reads (shots with seconds, captions with times)."""
    fps = pl["preset"]["fps"]
    shots, beats = [], []
    if pl.get("title"):
        shots.append({"sec": pl["title"]["dur"] / fps, "src": "title.png", "role": "title card", "label": pl["app"]["name"]})
    for s in pl["scenes"]:
        shots.append({"sec": s["dur"] / fps, "src": Path(s["src"]).name, "role": s.get("surface") or s["id"], "label": s.get("caption") or None})
        if s.get("caption"):
            beats.append({"kind": "line", "en": s["caption"], "ja": "", "startSec": round(s["from"] / fps, 2), "endSec": round((s["from"] + s["dur"]) / fps, 2)})
    if pl.get("news"):
        shots.append({"sec": pl["news"]["dur"] / fps, "src": "news.png", "role": "what's new card", "label": None})
    shots.append({"sec": pl["end"]["dur"] / fps, "src": "end.png", "role": "end card", "label": pl["app"]["cta"]})
    return {"shots": shots, "beats": beats}


def estimate(req: dict) -> dict:
    """What one review of a rendered product video costs, against the AI limits. Spends nothing."""
    from studio import ai

    vid = str(req.get("slug") or "")
    _, _, mp4, pl = _render_of(vid)
    tools = req.get("tools") or ["review"]
    if any(t != "review" for t in tools):
        raise KitError("Product videos take only the review tool; the render itself uses no AI.", "bad_input")
    model = ai._review_model({})
    seconds = sum(s["sec"] for s in review_project(pl)["shots"])
    m = ai.model_prices(model)
    usd = 0.0 if ai.review_basis() == "frames" else round((seconds * 300 + 3500) * m["prompt"] + 1800 * m["completion"], 4)
    used = ai.spent(vid)
    why = ai.over_caps(vid, usd, used)
    return {"slug": vid, "tools": [{"tool": "review", "usd": usd, "model": model, "labelRequired": False, "items": [{"what": mp4.name}]}],
            "total": usd, "fits": why is None, "refusal": why, "caps": ai.caps(), "spent": used, "labelRequired": False,
            "summary": f"1 AI step for {vid}: ${usd:.4f}." + (f" Refused: {why}" if why else " Fits the limits.")}


def review(req: dict) -> dict:
    from studio import ai

    vid = str(req.get("slug") or "")
    _, _, mp4, pl = _render_of(vid)
    dest = HOME / parse_video_id(vid)[0] / "renders" / f"{parse_video_id(vid)[1]}.review.json"
    if req.get("fresh"):
        dest.unlink(missing_ok=True)
    return ai.review_file(vid, mp4, review_project(pl), dest)


def last_review(req: dict) -> dict:
    vid = str(req.get("slug") or "")
    parsed = parse_video_id(vid)
    if not parsed:
        raise KitError(f"Not a product video id: {vid}.", "bad_input")
    f = HOME / parsed[0] / "renders" / f"{parsed[1]}.review.json"
    try:
        r = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        r = None
    return {"slug": vid, "review": r}


# ---------- command line ----------

def presets_view() -> dict:
    return {"presets": PRESETS, "schema": SCHEMA, "version": MAJOR}


ACTIONS = {
    "presets": lambda req: presets_view(),
    "fetch": lambda req: fetch(req),
    "kits": lambda req: {"kits": list_kits()},
    "kit": lambda req: kit_view(str(req.get("name") or "")),
    "plan": lambda req: plan(load_kit(str(req.get("name") or "")), str(req.get("preset") or "")),
    "estimate": estimate,
    "review": review,
    "last-review": last_review,
}


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    action = argv[0] if argv else ""
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        try:
            req = json.loads(raw or "{}")
        except ValueError:
            raise KitError("The request was not valid JSON.", "bad_input") from None
        if action not in ACTIONS:
            raise KitError(f"unknown product action {action}", "bad_input")
        if not isinstance(req, dict):
            raise KitError("the request must be a JSON object", "bad_input")
        out = {"ok": True, "data": ACTIONS[action](req)}
    except KitError as err:
        out = {"ok": False, "error": str(err), "code": err.code, "status": err.status}
    except Exception as err:  # the AI reviewer's own refusals (studio.ai.AiError) keep their words and status
        status = getattr(err, "status", None)
        if isinstance(status, int):
            out = {"ok": False, "error": str(err), "code": getattr(err, "code", "error"), "status": status}
        else:
            import traceback

            where = traceback.extract_tb(err.__traceback__)[-1]
            out = {"ok": False, "error": f"Product videos stopped on a problem in the studio: {type(err).__name__}: {err} ({Path(where.filename).name}:{where.lineno})",
                   "code": "bug", "status": 500}
    sys.stdout.write("RESULT " + json.dumps(out, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
