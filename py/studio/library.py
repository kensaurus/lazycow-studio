"""
FILE: py/studio/library.py
PURPOSE: Tag every photo and video so it can be found, mixed and reused.
OVERVIEW: For each catalogued asset: three keyframes (or the photo), an OpenCLIP
          embedding, zero-shot tags from the project's vocabulary (the ranch's, or a general one; scene, subject, time
          of day, season), faces (YuNet), sharpness, exposure, orientation, the
          event (its folder), and where it was shot (`place_from`: own GPS, then
          folder, then event folder, then the event folder's name). Search is
          plain words (CLIP text) plus filters. Usage counts come from reel specs
          and projects, so unused footage shows up.
DEPENDENCIES: open_clip (CPU), opencv, Pillow, studio.db, studio.config
USAGE: python -m studio library --scan ; library.items("tent at dusk", filters)
NOTES: Local and free. No cloud call. Re-running only processes assets without a
       library row (or with --force). Google Photos arrives through a Takeout
       export delivered to Drive, which the ingest picks up like any folder.
"""
from __future__ import annotations

import contextlib
import functools
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from studio.aesthetic import score as aesthetic_score
from studio.config import DATA, RANCH, SOURCE, ffmpeg_bin
from studio.db import connect

THUMBS = DATA / "library"
from studio.media import STILL as PHOTO, VIDEO  # noqa: E402  (one list of formats)

# label: (CLIP prompt, Japanese label, group). The ranch's words: its buildings, deck, tents, pizza oven, dogs.
RANCH_VOCAB = {
    "mountains": ("a wide view of mountains and ridges", "山並み", "scene"),
    "field": ("an open grass field on a hill", "草原", "scene"),
    "forest": ("a forest of trees", "森", "scene"),
    "snow": ("snow covered ground in winter", "雪", "scene"),
    "sky": ("a dramatic sky with clouds", "空", "scene"),
    "sunset": ("a sunset or dusk sky", "夕方", "scene"),
    "night": ("a scene at night in the dark", "夜", "scene"),
    "building": ("the outside of a wooden building with a blue roof", "建物", "scene"),
    "deck": ("a wooden deck with tables and a railing", "デッキ", "scene"),
    "interior": ("the inside of a lounge room", "室内", "scene"),
    "kitchen": ("a kitchen counter with cooking", "キッチン", "scene"),
    "shop": ("shelves of a small shop with goods", "売店", "scene"),
    "desk": ("a laptop on a desk for remote work", "仕事", "scene"),
    "road": ("a road or path", "道", "scene"),
    "parking": ("cars in a parking lot", "駐車場", "scene"),
    "tent": ("a camping tent pitched on grass", "テント", "subject"),
    "fire": ("a campfire with flames", "焚き火", "subject"),
    "grill": ("food cooking on a barbecue grill", "グリル", "subject"),
    "food": ("a plate of food on a table", "料理", "subject"),
    "pizza": ("a pizza oven", "ピザ窯", "subject"),
    "car": ("a car or van parked on grass", "車", "subject"),
    "aerial": ("an aerial drone view from above", "空撮", "subject"),
    "people": ("a group of people", "人", "subject"),
    "working": ("a person working with tools outdoors", "作業", "subject"),
    "dog": ("a dog", "犬", "subject"),
    "sign": ("a sign with text", "看板", "subject"),
    "flowers": ("wild flowers close up", "花", "subject"),
    "autumn": ("autumn leaves in orange and red", "紅葉", "season"),
}
# Any other project (a trip, a shop, a city): general words, so a safari is not tagged "dog" and "pizza oven".
ANY_VOCAB = {
    "mountains": ("a wide view of mountains and ridges", "山並み", "scene"),
    "field": ("open grassland or plains", "草原", "scene"),
    "forest": ("a forest of trees", "森", "scene"),
    "water": ("a lake or a river", "水辺", "scene"),
    "beach": ("a sandy beach by the sea", "ビーチ", "scene"),
    "snow": ("snow covered ground in winter", "雪", "scene"),
    "sky": ("a dramatic sky with clouds", "空", "scene"),
    "sunset": ("a sunset or dusk sky", "夕方", "scene"),
    "night": ("a scene at night in the dark", "夜", "scene"),
    "city": ("a city street with buildings", "街", "scene"),
    "building": ("the outside of a building", "建物", "scene"),
    "interior": ("the inside of a room", "室内", "scene"),
    "market": ("a busy market or a shop", "市場", "scene"),
    "airport": ("an airport, an airplane or a terminal", "空港", "scene"),
    "road": ("a road or path", "道", "scene"),
    "animal": ("a wild animal in nature", "動物", "subject"),
    "bird": ("a bird", "鳥", "subject"),
    "car": ("a car or a jeep", "車", "subject"),
    "boat": ("a boat on the water", "ボート", "subject"),
    "food": ("a plate of food on a table", "料理", "subject"),
    "fire": ("a campfire with flames", "焚き火", "subject"),
    "aerial": ("an aerial drone view from above", "空撮", "subject"),
    "people": ("a group of people", "人", "subject"),
    "flowers": ("wild flowers close up", "花", "subject"),
    "autumn": ("autumn leaves in orange and red", "紅葉", "season"),
}
VOCAB = RANCH_VOCAB if RANCH else ANY_VOCAB
VOCAB_FILE = DATA / "library-vocab.json"  # which word list this project's tags were made with
SEASON_BY_MONTH = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring", 6: "summer", 7: "summer", 8: "summer", 9: "autumn", 10: "autumn", 11: "autumn"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS library (
  asset_id INTEGER PRIMARY KEY,
  thumbs TEXT,
  emb BLOB,
  tags TEXT,
  top TEXT,
  faces INTEGER,
  sharp REAL,
  expo REAL,
  orientation TEXT,
  event TEXT,
  event_date TEXT,
  season TEXT,
  tod TEXT,
  scanned_at TEXT,
  person REAL
);
"""


def _migrate(con) -> None:
    con.executescript(SCHEMA)
    con.execute("CREATE TABLE IF NOT EXISTS vetoes (path TEXT PRIMARY KEY, note TEXT, at TEXT)")
    cols = {r[1] for r in con.execute("PRAGMA table_info(library)")}
    if "person" not in cols:
        con.execute("ALTER TABLE library ADD COLUMN person REAL")
    if "junk" not in cols:
        con.execute("ALTER TABLE library ADD COLUMN junk REAL")


_MODEL = None


def _model():
    global _MODEL
    if _MODEL is None:
        import open_clip
        import torch

        # The OpenAI weights were trained with QuickGELU; plain "ViT-B-32" silently degrades them.
        model, _, preprocess = open_clip.create_model_and_transforms(CLIP_ARCH, pretrained="openai")
        model.eval()
        tok = open_clip.get_tokenizer(CLIP_ARCH)
        with torch.no_grad():
            text = model.encode_text(tok([v[0] for v in VOCAB.values()]))
            text = text / text.norm(dim=-1, keepdim=True)
            who = model.encode_text(tok(PERSON_PROMPTS + SCENE_PROMPTS))
            who = who / who.norm(dim=-1, keepdim=True)
        _MODEL = (model, preprocess, tok, text, torch, who.numpy().astype("float32"))
    return _MODEL


CLIP_ARCH = "ViT-B-32-quickgelu"
PERSON_PROMPTS = ["a photo of a person", "a photo of people", "a photo of a person seen from behind", "a photo of hands",
                  "a photo of feet, legs or shoes"]
SCENE_PROMPTS = [
    "a photo of a landscape", "a photo of mountains", "a photo of a building", "a photo of an empty room",
    "a photo of a grass field", "a photo of food", "a photo of a car", "a photo of a tent", "a photo of the sky", "a photo of a fire",
]


JUNK_PROMPTS = [
    "a close-up of the ground, weeds, grass or dirt", "a blurry out of focus photo", "a screenshot of a phone screen",
    "a document, a paper or a printed sign", "a close-up of a hand", "a photo of a ceiling or a plain wall",
]
_JUNK = None


def junk_score(emb: np.ndarray) -> float:
    """Zero-shot chance a frame is filler (ground close-up, blur, screenshot, paper, a hand) rather than a scene."""
    global _JUNK
    if _JUNK is None:
        model, _, tok, _, torch, _ = _model()
        with torch.no_grad():
            v = model.encode_text(tok(JUNK_PROMPTS + SCENE_PROMPTS))
            v = v / v.norm(dim=-1, keepdim=True)
        _JUNK = v.numpy().astype("float32")
    logits = 100.0 * _JUNK @ emb
    p = np.exp(logits - logits.max())
    p /= p.sum()
    return float(p[: len(JUNK_PROMPTS)].sum())


PERSON_MAX = 0.35  # "no faces" also means no one in frame. People from behind scored 0.58-0.79, drone views 0.01-0.18.


def person_score(emb: np.ndarray) -> float:
    """Zero-shot chance that a person (or hands) is in frame, for one image embedding."""
    who = _model()[5]
    logits = 100.0 * who @ emb
    p = np.exp(logits - logits.max())
    p /= p.sum()
    return float(p[: len(PERSON_PROMPTS)].sum())


@functools.lru_cache(maxsize=2048)
def text_embedding(query: str) -> np.ndarray:
    """CLIP's vector for a search phrase. Kept per phrase: themes ask the same ~35 searches on every footage check and
    every reel (about 30 ms of CPU each). Read-only, so no caller can change the shared copy."""
    model, _, tok, _, torch, _ = _model()
    with torch.no_grad():
        v = model.encode_text(tok([query]))
        v = v / v.norm(dim=-1, keepdim=True)
    out = v[0].numpy().astype("float32")
    out.setflags(write=False)
    return out


def event_of(path: Path) -> tuple[str, str | None]:
    """The event is the dated folder under media/<year>/; the date comes from its name."""
    try:
        rel = path.relative_to(SOURCE)
    except ValueError:
        return (path.parent.name, None)
    parts = rel.parts
    name = parts[1] if len(parts) > 2 else parts[0]
    m = re.search(r"(20\d{2})(\d{2})(\d{2})?", name)
    date = None
    if m:
        date = f"{m.group(1)}-{m.group(2)}-{m.group(3) or '01'}"
    return name, date


def event_dir(path: Path) -> str:
    """media/<year>/<event> as a lowercase key; the parent folder outside the media root."""
    return _event_dir(str(path))


@functools.lru_cache(maxsize=65536)
def _event_dir(path: str) -> str:
    # Pure in the path (SOURCE is fixed for the process); a footage check asks it ~170,000 times.
    p = Path(path)
    try:
        parts = p.relative_to(SOURCE).parts
    except ValueError:
        return str(p.parent).lower()
    return str(SOURCE.joinpath(*parts[:2])).lower() if len(parts) > 2 else str(p.parent).lower()


def place_from(
    near_ranch: int | None,
    folder: tuple[int, int],
    event: tuple[int, int],
    event_name: str,
    captured: str | None = None,
    event_date: str | None = None,
    home: dict | None | bool = False,
) -> str:
    """Where a file was shot. Own GPS, then its folder's, then its event's, then the event's name.

    "ranch…" means at the project's home place (the ranch in the main project; studio.brand.home_place).
    The name test reads only the event folder: the media root itself is called 20_tsumagoi-work-camp.
    A file without GPS taken more than a day before its event's date is the trip there, not the ranch.
    An event the owner has declared off-site (spec.json ranch.awayEvents) is away whatever its GPS says.
    A project with no home place uses every clip it has: "ranch (no home place)".
    `home` is the project's home place when the caller already has it (False = look it up).
    """
    if home is False:
        from studio.brand import home_place

        home = home_place()
    if home is None:
        return "ranch (no home place)"
    if event_name.lower() in {e.lower() for e in home.get("awayEvents", [])}:
        return "away (owner)"
    if near_ranch == 1:
        return "ranch"
    if near_ranch == 0:
        return "away"
    if captured and event_date and len(captured) >= 10:
        from datetime import date, timedelta

        try:
            if date.fromisoformat(captured[:10]) < date.fromisoformat(event_date[:10]) - timedelta(days=1):
                return "unknown (before the event)"
        except ValueError:
            pass
    for (near, far), label in ((folder, "folder"), (event, "event")):
        if far > 0:
            return f"away ({label})" if far >= near else f"ranch ({label})"
        if near > 0:
            return f"ranch ({label})"
    names = [re.escape(n) for n in home.get("names", []) if n]
    return "ranch (folder name)" if names and re.search("|".join(names), event_name, re.I) else "unknown"


def _wide(path: Path) -> bool:
    """A 2:1 (or stacked 1:2) still of 2000 px or more: worth checking as a 360."""
    from studio import sphere

    try:
        from PIL import Image

        with Image.open(path) as im:
            w, h = im.size
    except Exception:  # noqa: BLE001  (RAW and HEIC are sized elsewhere)
        return False
    return sphere.is_equirect(w, h) or sphere.is_tall_pair(w, h)


def _keyframes(path: Path, asset_id: int, duration: float | None) -> list[Path]:
    out = []
    THUMBS.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() in PHOTO:
        dest = THUMBS / f"{asset_id}_0.jpg"
        if not dest.exists():
            from studio import sphere
            from studio.shot import flat_photo, open_photo

            flat = flat_photo(path) if path.suffix.lower() in {".insp", ".dng"} or _wide(path) else None
            if flat is not None and flat.name.startswith(("sphere_", "stitch_")):
                # A 360 is tagged from a level, normal-lens look ahead, not the stretched sphere.
                sphere.front_view(flat, dest)
            else:
                im = open_photo(path)
                im.thumbnail((480, 480))
                im.save(dest, quality=82)
        return [dest]
    dur = duration or 0
    from studio import sphere
    from studio.shot import is_360

    globe = is_360(path)
    for k, frac in enumerate((0.15, 0.5, 0.85)):
        dest = THUMBS / f"{asset_id}_{k}.jpg"
        if not dest.exists() and globe:
            sphere.front_view(path, dest, at=max(0.0, dur * frac) if dur else k * 1.0)
        elif not dest.exists():
            t = max(0.0, dur * frac) if dur else k * 1.0
            subprocess.run(
                [str(ffmpeg_bin()), "-y", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),480,-2)':'if(gt(iw,ih),-2,480)'", "-update", "1", "-q:v", "4", str(dest)],
                capture_output=True, timeout=180,
            )
        if dest.exists():
            out.append(dest)
    return out


import threading

_LOCAL = threading.local()


def _faces(img: np.ndarray) -> int:
    model = DATA / "bin" / "face_detection_yunet_2023mar.onnx"
    if not model.exists():
        return 0
    if not hasattr(_LOCAL, "face"):
        _LOCAL.face = cv2.FaceDetectorYN.create(str(model), "", (320, 320), 0.75)
    _LOCAL.face.setInputSize((img.shape[1], img.shape[0]))
    _, found = _LOCAL.face.detect(img)
    return 0 if found is None else len(found)


def _analyse(row: dict) -> dict | None:
    path = Path(row["path"])
    if not path.exists() or path.suffix.lower() not in VIDEO | PHOTO:
        return None
    try:
        frames = _keyframes(path, row["id"], row["duration"])
    except Exception as exc:  # unreadable file: record, do not stop the scan
        return {"asset_id": row["id"], "error": str(exc)[:200]}
    if not frames:
        return {"asset_id": row["id"], "error": "no frame"}
    imgs = [cv2.imread(str(f)) for f in frames]
    imgs = [i for i in imgs if i is not None]
    if not imgs:
        return {"asset_id": row["id"], "error": "unreadable frame"}
    gray = [cv2.cvtColor(i, cv2.COLOR_BGR2GRAY) for i in imgs]
    h, w = imgs[0].shape[:2]
    return {
        "asset_id": row["id"],
        "frames": [str(f) for f in frames],
        "faces": max(_faces(i) for i in imgs),
        "sharp": float(np.mean([cv2.Laplacian(g, cv2.CV_64F).var() for g in gray])),
        "expo": float(np.mean([g.mean() / 255 for g in gray])),
        "orientation": "portrait" if h > w else "landscape" if w > h else "square",
    }


def _clip(frames: list[str]) -> tuple[np.ndarray, list[tuple[str, float]], float, float]:
    """Mean embedding, tag scores, and the highest per-frame person and junk scores
    (someone, or a weeds close-up, in one keyframe of three is still in the clip)."""
    model, preprocess, _, text, torch, _ = _model()
    from PIL import Image

    batch = torch.stack([preprocess(Image.open(f).convert("RGB")) for f in frames])
    with torch.no_grad():
        v = model.encode_image(batch)
        v = v / v.norm(dim=-1, keepdim=True)
        mean = v.mean(dim=0)
        mean = mean / mean.norm()
        sims = (100.0 * mean @ text.T).softmax(dim=-1).numpy()
    labels = list(VOCAB.keys())
    scored = sorted(((labels[i], float(sims[i])) for i in range(len(labels))), key=lambda x: -x[1])
    per_frame = v.numpy().astype("float32")
    person = max(person_score(f) for f in per_frame)
    junk = max(junk_score(f) for f in per_frame)
    return mean.numpy().astype("float32"), scored, person, junk


def _vocab_id() -> str:
    import hashlib

    return hashlib.sha1(json.dumps([[k, v[0]] for k, v in VOCAB.items()]).encode()).hexdigest()[:12]


def retag(force: bool = False) -> dict:
    """Tag every clip again from its saved embedding when this project's word list changed (seconds; no footage is
    read). A ranch library with no record yet was tagged with the ranch's list already: it is only recorded."""
    want = _vocab_id()
    try:
        have = json.loads(VOCAB_FILE.read_text(encoding="utf-8")).get("id")
    except (OSError, ValueError):
        have = None
    if not force and (have == want or (have is None and RANCH)):
        if have is None:
            VOCAB_FILE.write_text(json.dumps({"id": want}), encoding="utf-8")
        return {"retagged": 0, "vocab": want}
    text = _model()[3]
    t = (text.numpy() if hasattr(text, "numpy") else np.asarray(text)).astype("float32")
    labels = list(VOCAB.keys())
    done = 0
    with connect() as con:
        _migrate(con)
        for r in [dict(r) for r in con.execute("SELECT asset_id, emb, expo FROM library WHERE emb IS NOT NULL")]:
            logits = 100.0 * (t @ np.frombuffer(r["emb"], dtype="float32"))  # as _clip: softmax over the mean embedding
            p = np.exp(logits - logits.max())
            p /= p.sum()
            scored = sorted(((labels[i], float(p[i])) for i in range(len(labels))), key=lambda x: -x[1])
            top = [label for label, score in scored[:5] if score >= 0.06][:4] or [scored[0][0]]
            dark = (r["expo"] or 1) < 0.22 or "night" in top
            con.execute("UPDATE library SET tags = ?, top = ?, tod = ? WHERE asset_id = ?",
                        (json.dumps(scored[:8]), json.dumps(top), "night" if dark else "dusk" if "sunset" in top else "day", r["asset_id"]))
            done += 1
    VOCAB_FILE.write_text(json.dumps({"id": want}), encoding="utf-8")
    return {"retagged": done, "vocab": want}


def scan(force: bool = False, limit: int | None = None, workers: int = 8) -> dict:
    with contextlib.suppress(Exception):  # tags made with another word list are made again first (cheap)
        retag()
    with connect() as con:
        _migrate(con)
        done = {r[0] for r in con.execute("SELECT asset_id FROM library")} if not force else set()
        rows = [dict(r) for r in con.execute("SELECT id, path, kind, duration, captured_at FROM assets WHERE kind IN ('video', 'photo') ORDER BY id")]
    from studio.ingest import is_output

    todo = [r for r in rows if r["id"] not in done and Path(r["path"]).suffix.lower() in VIDEO | PHOTO and not is_output(Path(r["path"]))]
    if limit:
        todo = todo[:limit]
    tagged = errors = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(_analyse, todo):
            if not result:
                continue
            row = next(r for r in todo if r["id"] == result["asset_id"])
            if "error" in result:
                errors += 1
                with connect() as con:
                    con.execute("INSERT OR REPLACE INTO library (asset_id, tags, scanned_at) VALUES (?, ?, ?)", (row["id"], json.dumps({"error": result["error"]}), datetime.now().isoformat(timespec="seconds")))
                continue
            emb, scored, person, junk = _clip(result["frames"])
            top = [label for label, score in scored[:5] if score >= 0.06][:4] or [scored[0][0]]
            event, event_date = event_of(Path(row["path"]))
            when = row["captured_at"] or event_date
            month = int(when[5:7]) if when and len(when) >= 7 else None
            season = SEASON_BY_MONTH.get(month) if month else None
            hour = int(when[11:13]) if when and len(when) >= 13 else None
            dark = result["expo"] < 0.22 or "night" in top
            tod = "night" if dark else "dusk" if "sunset" in top else "day"
            with connect() as con:
                con.execute(
                    """INSERT OR REPLACE INTO library (asset_id, thumbs, emb, tags, top, faces, sharp, expo, orientation, event, event_date, season, tod, scanned_at, person, junk)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (row["id"], json.dumps(result["frames"]), emb.tobytes(), json.dumps(scored[:8]), json.dumps(top),
                     result["faces"], result["sharp"], result["expo"], result["orientation"], event, event_date, season, tod,
                     datetime.now().isoformat(timespec="seconds"), person, junk),
                )
            tagged += 1
    return {"tagged": tagged, "errors": errors, "skipped": len(rows) - len(todo)}


def reembed() -> dict:
    """Recompute embeddings and tags from the saved keyframes (no footage is re-read)."""
    with connect() as con:
        _migrate(con)
        rows = [dict(r) for r in con.execute("SELECT asset_id, thumbs, expo FROM library WHERE thumbs IS NOT NULL")]
    done = missing = 0
    for row in rows:
        frames = [f for f in json.loads(row["thumbs"] or "[]") if Path(f).exists()]
        if not frames:
            missing += 1
            continue
        emb, scored, person, junk = _clip(frames)
        top = [label for label, score in scored[:5] if score >= 0.06][:4] or [scored[0][0]]
        dark = (row["expo"] or 1) < 0.22 or "night" in top
        tod = "night" if dark else "dusk" if "sunset" in top else "day"
        with connect() as con:
            con.execute(
                "UPDATE library SET emb = ?, tags = ?, top = ?, tod = ?, person = ?, junk = ? WHERE asset_id = ?",
                (emb.tobytes(), json.dumps(scored[:8]), json.dumps(top), tod, person, junk, row["asset_id"]),
            )
        done += 1
    return {"reembedded": done, "noThumbs": missing, "model": CLIP_ARCH}


def veto(asset_id: int, on: bool, note: str = "") -> dict:
    """A person's "never auto-pick this" (feet, a stranger, a bad take). Still usable by hand."""
    with connect() as con:
        _migrate(con)
        row = con.execute("SELECT path FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            raise KeyError(asset_id)
        if on:
            con.execute("INSERT OR REPLACE INTO vetoes (path, note, at) VALUES (?, ?, ?)",
                        (row["path"], note[:200], datetime.now().isoformat(timespec="seconds")))
        else:
            con.execute("DELETE FROM vetoes WHERE path = ?", (row["path"],))
    return {"id": asset_id, "vetoed": on}


def prefer_originals(rows: list) -> list:
    """The same shot twice, once picked from Google Photos (a 1080p copy at a fraction of the bitrate, its location
    removed) and once as the camera's own file in a footage folder: only the original counts. Same file name and kind;
    a Google Photos pick with no original stays."""
    def gp(r) -> bool:
        return "google-photos" in Path(r["path"]).parts
    have = {(Path(r["path"]).name.lower(), r["kind"]) for r in rows if not gp(r)}
    return [r for r in rows if not (gp(r) and (Path(r["path"]).name.lower(), r["kind"]) in have)]


def vlog_usage() -> dict[str, list[int]]:
    """path (lower) -> the long-video parts (studio.vlog's plan) it is in. Kept apart from usage(): short reels may use
    the same moments again (they point to the long video), so it never counts against a clip when reels are picked."""
    try:
        plan_ = json.loads((DATA / "vlog-plan.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[str, list[int]] = {}
    for v in plan_.get("videos", []):
        for s in [*v.get("cold", []), *(x for c in v.get("chapters", []) for x in c.get("shots", []))]:
            parts = out.setdefault(str(s.get("path") or "").lower(), [])
            if v.get("n") not in parts:
                parts.append(v.get("n"))
    return out


def usage() -> dict[str, list[str]]:
    """path (lower) -> list of reel/project slugs that use it."""
    try:  # the house reels; none without the ranch overlay
        from studio.reel_specs import REELS
    except ModuleNotFoundError:
        REELS = []

    from studio.projects import all_projects

    used: dict[str, list[str]] = {}
    for reel in list(REELS) + all_projects():
        for shot in reel["shots"]:
            key = Path(shot["src"]).name.lower()
            used.setdefault(key, [])
            if reel["slug"] not in used[key]:
                used[key].append(reel["slug"])
    return used


def _is360_row(path: Path, width: int | None, height: int | None) -> bool:
    from studio import sphere

    return sphere.is_equirect(width, height, path) or bool(width and height and sphere.is_tall_pair(width, height))


def redo_360() -> int:
    """Forget the library rows of 360 assets so the next scan re-tags them from a level front
    view (they were first tagged from the raw, stretched sphere). Sources are not touched."""
    with connect() as con:
        rows = con.execute("SELECT a.id, a.path, a.width, a.height FROM assets a JOIN library l ON l.asset_id = a.id").fetchall()
        ids = [r["id"] for r in rows if _is360_row(Path(r["path"]), r["width"], r["height"])]
        for asset_id in ids:
            for thumb in THUMBS.glob(f"{asset_id}_*.jpg"):
                thumb.unlink(missing_ok=True)
            con.execute("DELETE FROM library WHERE asset_id = ?", (asset_id,))
        con.commit()
    return len(ids)


_BATCH: dict | None = None


@contextlib.contextmanager
def batch():
    """Inside it, items() builds the catalog rows (places, usage, scores) once and only searches and filters per call.
    A footage check or a run of Make reels asks items() dozens of times in a row; each built the whole library again
    (about 0.9 s apiece on 3,000 clips). Outside a batch nothing is kept, so every call sees the catalog as it is now."""
    global _BATCH
    outer = _BATCH is not None
    if not outer:
        _BATCH = {}
    try:
        yield
    finally:
        if not outer:
            _BATCH = None


def items(query: str = "", filters: dict | None = None, limit: int = 400) -> list[dict]:
    """Library rows for the editor: tags, usage, location, newest first, or by text match."""
    filters = filters or {}
    if _BATCH is not None and "base" in _BATCH:
        base = _BATCH["base"]
    else:
        base = _base_items()
        if _BATCH is not None:
            _BATCH["base"] = base
    q = text_embedding(query) if query.strip() else None
    out = []
    for item0, emb in base:
        item = dict(item0)  # callers may change their copy; the batch keeps the original
        for k in ("top", "tagsJa", "tags", "thumbs", "usedIn"):
            item[k] = list(item[k])
        if q is not None:
            item["match"] = round(float(emb @ q), 4)
        out.append(item)
    return _filtered(out, filters, q is not None, limit)


def _base_items() -> list[tuple[dict, "np.ndarray"]]:
    """Every catalog row as the editor sees it, before any search: (item, CLIP embedding)."""
    with connect() as con:
        _migrate(con)
        rows = [dict(r) for r in con.execute(
            """SELECT a.id, a.path, a.kind, a.duration, a.width, a.height, a.fps, a.device, a.captured_at, a.near_ranch,
                      l.thumbs, l.emb, l.tags, l.top, l.faces, l.sharp, l.expo, l.orientation, l.event, l.event_date, l.season, l.tod, l.person, l.junk
               FROM assets a JOIN library l ON l.asset_id = a.id WHERE l.emb IS NOT NULL"""
        )]
        vetoed = {r[0] for r in con.execute("SELECT path FROM vetoes")}
        folder_gps, event_gps = {}, {}
        for r in con.execute("SELECT path, near_ranch FROM assets"):
            p = Path(r["path"])
            for key, table in ((str(p.parent).lower(), folder_gps), (event_dir(p), event_gps)):
                near, far = table.get(key, (0, 0))
                table[key] = (near + (r["near_ranch"] == 1), far + (r["near_ranch"] == 0))
    from studio.ingest import is_output

    rows = [r for r in rows if not is_output(Path(r["path"]))]
    rows = prefer_originals(rows)
    used = usage()
    in_vlogs = vlog_usage()
    from studio.brand import home_place
    from studio.config import trusted_roots

    home = home_place()
    trusted = tuple(str(root).lower().rstrip("\\/") + os.sep for root in trusted_roots())  # read once, not per clip
    out = []
    for r in rows:
        name = Path(r["path"]).name
        p = Path(r["path"])
        place = place_from(
            r["near_ranch"],
            folder_gps.get(str(p.parent).lower(), (0, 0)),
            event_gps.get(event_dir(p), (0, 0)),
            Path(event_dir(p)).name,
            home=home,
            captured=r["captured_at"],
            event_date=r["event_date"],
        )
        if not place.startswith("ranch") and r["near_ranch"] != 0 and str(p).lower().startswith(trusted):
            place = "ranch (trusted folder)"
        item = {
            "id": r["id"],
            "path": r["path"],
            "file": name,
            "kind": r["kind"],
            "duration": r["duration"],
            "width": r["width"], "height": r["height"], "fps": r["fps"],
            "device": r["device"],
            "captured": r["captured_at"] or r["event_date"],
            "event": r["event"],
            "season": r["season"], "tod": r["tod"],
            "orientation": r["orientation"],
            "faces": r["faces"],
            "sharp": round(r["sharp"] or 0, 1),
            "top": json.loads(r["top"] or "[]"),
            "tagsJa": [VOCAB[t][1] for t in json.loads(r["top"] or "[]") if t in VOCAB],
            "tags": [t for t in json.loads(r["top"] or "[]") if t in VOCAB],  # the same tags as keys (tagsJa[i] is tags[i] in Japanese)
            "thumbs": json.loads(r["thumbs"] or "[]"),
            "place": place,
            "usedIn": used.get(name.lower(), []),
            "inVlogs": in_vlogs.get(str(r["path"]).lower(), []),
            "is360": _is360_row(p, r["width"], r["height"]),
        }
        emb = np.frombuffer(r["emb"], dtype="float32")
        item["person"] = round(r["person"] if r["person"] is not None else person_score(emb), 3)
        item["junk"] = round(r["junk"] if r["junk"] is not None else junk_score(emb), 3)
        aes = aesthetic_score(emb)
        item["aesthetic"] = round(aes, 2) if aes is not None else None
        item["vetoed"] = r["path"] in vetoed
        out.append((item, emb))
    return out


def _filtered(out: list[dict], f: dict, searched: bool, limit: int) -> list[dict]:
    if f.get("kind"):
        out = [i for i in out if i["kind"] == f["kind"]]
    if f.get("is360"):
        out = [i for i in out if i["is360"]]
    if f.get("ranch"):
        out = [i for i in out if i["place"].startswith("ranch")]
    if f.get("noFaces"):
        out = [i for i in out if not i["faces"] and i["person"] < PERSON_MAX]
    if f.get("unused"):
        out = [i for i in out if not i["usedIn"] and not i.get("inVlogs")]  # a clip in a long video is used too
    if f.get("season"):
        out = [i for i in out if i["season"] == f["season"]]
    if f.get("tag"):
        out = [i for i in out if f["tag"] in i["top"]]
    if f.get("event"):
        out = [i for i in out if i["event"] == f["event"]]
    if searched:
        out.sort(key=lambda i: -i["match"])
    else:
        out.sort(key=lambda i: (i["captured"] or ""), reverse=True)
    return out[:limit]
