"""
FILE: py/studio/stills.py
PURPOSE: Photo posts: carousels (and a Story to share them) made from the footage library's photos, in the looks of
         shared/post-templates.json, with words and captions per network. What the owner made by hand in Canva.
OVERVIEW: make() draws sets: for each, a look and a subject (theme), photos found by meaning (CLIP search on the theme's
          query) with no faces, no near-duplicate bursts and nothing another set of the same run uses; the photos are
          resized and written without their metadata (no GPS) into a small public folder; scripts/post-stills.mjs draws
          every set in one Remotion bundle (src/Post.tsx); each still is cut into exact 1080x1350 slides, and a 9:16
          Story that shares the first slide is laid out here. Every word on a slide and in a caption passes the brand's
          copy rules, or the set is not kept. Sets live in <data>/stills/<id>/ (meta.json, slide-01.jpg..., story.jpg).
          Nothing here posts: a set is something to review and post (by hand today, see docs/BACKLOG.md BL-048..BL-052).
DEPENDENCIES: studio.library (items), studio.brand, Pillow (+ pillow-heif for HEIC), node + @remotion/bundler/renderer
USAGE: python -m studio stills make [--n 10] [--style pano] [--theme autumn] [--seed 7] | list | delete <id>
"""
from __future__ import annotations

import json
import random
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

from studio.config import DATA, ROOT

TEMPLATES = ROOT / "shared" / "post-templates.json"
OUT = DATA / "stills"
PUB = OUT / "_pub"          # the small public folder the stills are drawn from (fonts + this run's photos)
BUNDLE = OUT / "_bundle"
SLIDE_W, SLIDE_H = 1080, 1350
STORY_W, STORY_H = 1080, 1920
PHOTO_EDGE = 2000           # long edge of a prepared photo: sharp on a 1080 slide, light to bundle
JST = timezone(timedelta(hours=9))
ID_RX = re.compile(r"^[a-z0-9][a-z0-9-]{2,80}$")
PRICE_RX = re.compile(r"[¥￥$€]\s*\d|\d[\d,]*\s*(円|yen)\b", re.I)


def table() -> dict:
    return json.loads(TEMPLATES.read_text(encoding="utf-8"))


def styles() -> list[dict]:
    return table()["styles"]


RANCH_TEMPLATES = ROOT / "shared" / "post-templates-ranch.json"  # the ranch workspace's own words (private overlay)


def _ranch() -> dict | None:
    """The ranch's themes, facts and place, when this is the ranch workspace and its overlay file is here."""
    from studio.brand import brand

    if not brand().get("ranch") or not RANCH_TEMPLATES.is_file():
        return None
    return json.loads(RANCH_TEMPLATES.read_text(encoding="utf-8"))


def themes() -> list[dict]:
    """The subjects: the ranch's own words in the ranch workspace, neutral ones (no place names) in any other."""
    own = _ranch()
    return own["themes"] if own else table()["themes"]


def facts() -> list[dict]:
    """True numbers about the place, for the number looks. Only the ranch has them; another brand gets none (a look
    then numbers its notes instead, and "In numbers" is not drawn) rather than numbers the studio would make up."""
    own = _ranch()
    return own.get("facts", []) if own else []


def place() -> dict:
    """What the place-printing looks (masthead, postmark, boarding pass) print: the ranch's, or the brand's own name."""
    from studio.brand import brand

    own = _ranch()
    if own and own.get("place"):
        return own["place"]
    b = brand()
    name = (b.get("nameEn") or b.get("name") or "").strip()
    return {"place": name, "placeJa": b.get("name") or name, "placeLong": name, "alt": "", "region": "", "origin": None}


# ---------------------------------------------------------------- words

def copy_problems(text: str) -> list[str]:
    """What breaks the brand's copy rules in this text: banned words, prices, 牧場 outside the registered name."""
    from studio.brand import copy_rules

    rules = copy_rules()
    low = text.lower()
    out = [f"banned word: {b}" for b in rules["banned"] if b and b.lower() in low]
    if rules["noPrices"] and PRICE_RX.search(text):
        out.append("a price")
    reg = rules.get("registered")
    if reg and "牧場" in text.replace(reg, ""):
        out.append("牧場 outside the registered name")
    return out


def x_length(text: str) -> int:
    """X's weighted length: URLs count 23, CJK and other wide characters 2, the rest 1 (X counts up to 280)."""
    n = 0
    for part in re.split(r"(https?://\S+)", text):
        if re.match(r"https?://", part):
            n += 23
            continue
        for ch in part:
            n += 2 if unicodedata.east_asian_width(ch) in ("W", "F") or ord(ch) > 0x10FF else 1
    return n


def graphemes(text: str) -> int:
    """Bluesky counts graphemes (300 a post); a close count: combining marks and variation selectors join the letter before."""
    return sum(1 for ch in text if not unicodedata.combining(ch) and not 0xFE00 <= ord(ch) <= 0xFE0F and ch != "‍")


SAVE_LINES = ["📌 保存して、次の週末の候補に。", "📌 一緒に行きたい人に送ってください。", "📌 あとで見返せるように保存を。"]
BOOK_LINES = ["空き状況・ご予約はプロフィールのリンクから。", "ご予約・お問い合わせはプロフィールのリンクから。", "到着は木〜月。火・水はLINEでご相談ください。"]
QUESTIONS = ["{n}枚のうち、どれが好きですか？番号で教えてください。", "いちばん行ってみたいのは何枚目？", "この景色、誰と見たいですか？"]


def with_hook(theme: dict, rng: random.Random) -> dict:
    """The theme with one of its hooks rolled for this set, so two sets of one subject open differently. The slides and
    the captions use the same hook."""
    choices = [[theme["hookJa"], theme["hookEn"]], *theme.get("hooks", [])]
    ja, en = choices[rng.randrange(len(choices))]
    return {**theme, "hookJa": ja, "hookEn": en}


def captions(theme: dict, style: dict, slides: int, rng: random.Random | None = None) -> dict:
    """The words that go with the post on each network. Japanese first (the audience), one English line. The body, the
    call to action and the question are picked per set (seeded), so a feed of photo posts does not repeat itself."""
    from studio.brand import brand

    rng = rng or random.Random(0)
    b = brand()
    own = list(b.get("tags") or [])[:1]
    tags = [t for t in theme["tags"] if t not in own][:7] + own
    listy = style["id"] in ("guide", "magazine", "newspaper", "numbers")
    notes = list(theme["notesJa"])
    rng.shuffle(notes)
    body = "\n".join(f"・{it['head']}" for it in theme["items"][: min(4, slides)]) if listy else "\n".join(notes[:3])
    link = b.get("link") or ""
    save, book = rng.choice(SAVE_LINES), rng.choice(BOOK_LINES)
    question = rng.choice(QUESTIONS).format(n=slides)
    ig = (f"{theme['hookJa']}\n{theme['hookEn']}\n\n{body}\n\n{question}\n\n"
          f"{save}\n{book}\n\n{' '.join(tags)}")
    fb = f"{theme['hookJa']}\n{theme['hookEn']}\n\n{body}\n\n{question}\n\n{b['name']}\n{link}\n\n{' '.join(tags[:3])}".strip()
    threads = f"{theme['hookJa']}\n\n{question}\n\n{tags[0] if tags else ''}".strip()
    x = f"{theme['hookJa']}\n{link} {' '.join(tags[:2])}".strip()
    while x_length(x) > 280 and " " in x:
        x = x.rsplit(" ", 1)[0]
    bsky = f"{theme['hookJa']}\n{theme['hookEn']}\n{link}\n#キャンプ {tags[0] if tags else ''}".strip()
    return {"instagram": ig, "facebook": fb, "threads": threads, "x": x, "bluesky": bsky,
            "_lengths": {"x": x_length(x), "bluesky": graphemes(bsky), "instagram": len(ig)}}


def slide_words(theme: dict) -> list[str]:
    """Every piece of text the look may put on a slide (checked against the copy rules before drawing)."""
    words = [theme[k] for k in ("title", "titleJa", "sub", "kicker", "hookJa", "hookEn")]
    words += [x for pair in theme.get("hooks", []) for x in pair]
    words += theme["notes"] + theme["notesJa"] + theme["poem"] + [f"{i['head']} {i['line']}" for i in theme["items"]]
    words += [f"{f['big']}{f['unit']} {f['ja']} {f['en']}" for f in facts()]  # the number looks print these
    return words


# ---------------------------------------------------------------- photos

def _when(item: dict) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(item.get("captured") or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)  # some files record a time with no zone: compare them as UTC


SAME_SCENE = 0.9  # CLIP cosine above which two photos read as one scene
# Measured 21 Nov on the ranch library: kitchen shelves scored 0.23-0.30 against this, views and tents 0.12-0.18.
CLUTTER = "a cluttered kitchen counter and shelf with bottles, appliances and packages"
CLUTTER_MAX = 0.215


def _embeddings(ids: list[int]) -> dict:
    """asset id -> normalised CLIP embedding, for the photos being considered."""
    import numpy as np

    from studio.db import connect

    if not ids:
        return {}
    out = {}
    with connect() as con:
        for aid, blob in con.execute(f"SELECT asset_id, emb FROM library WHERE asset_id IN ({','.join('?' * len(ids))})", ids):
            if blob:
                v = np.frombuffer(blob, dtype="float32")
                out[aid] = v / (np.linalg.norm(v) or 1)
    return out


def pick_photos(theme: dict, n: int, rng: random.Random, avoid: set[str] | None = None) -> list[dict]:
    """n photos for a theme: found by meaning, no faces, not junk, not vetoed; no two from the same burst (within 20 s);
    photos another set of this run uses only when nothing else is left. Seeded, so the same seed picks the same."""
    from studio import library
    from studio.brand import home_place

    avoid = avoid or set()
    filters = {"kind": "photo", "noFaces": True}
    if home_place() is not None:
        filters["ranch"] = True
    pool = [i for i in library.items(theme["query"], filters, limit=400) if not i.get("vetoed") and (i.get("junk") or 0) < 0.5]
    for key in ("season", "tod"):  # a night post shows night, an autumn post autumn, when there are enough of them
        want = theme.get(key)
        if want:
            same = [i for i in pool if i.get(key) in (want if isinstance(want, list) else [want])]
            if len(same) >= n * 2:
                pool = same
    pool = pool[:80]
    fine = [i for i in pool if (i.get("aesthetic") or 0) >= 5.8]  # about the library's median: no cluttered shelves
    if len(fine) >= n + 2:
        pool = fine
    for i in pool:
        i["_score"] = (i.get("match") or 0) * 10 + (i.get("aesthetic") or 5) * 0.35 + rng.random() * 0.8 - (2.0 if i["path"] in avoid else 0)
    pool.sort(key=lambda i: -i["_score"])
    embs = _embeddings([i["id"] for i in pool])
    if theme["id"] != "food":  # a shelf of bottles and a kettle is not a post; food is shot on counters on purpose
        clutter = library.text_embedding(CLUTTER)
        clutter = clutter / (float((clutter @ clutter) ** 0.5) or 1)
        tidy = [i for i in pool if (e := embs.get(i["id"])) is None or float(e @ clutter) < CLUTTER_MAX]
        if len(tidy) >= n:
            pool = tidy
    chosen: list[dict] = []
    for item in pool:
        t = _when(item)
        if t and any((u := _when(c)) and abs((u - t).total_seconds()) < 20 for c in chosen):
            continue
        e = embs.get(item["id"])
        if e is not None and any((f := embs.get(c["id"])) is not None and float(e @ f) > SAME_SCENE for c in chosen):
            continue  # the same scene from a few steps away (a drone orbit, three shots of one pizza)
        chosen.append(item)
        if len(chosen) == n:
            break
    for item in pool:  # not enough distinct moments: fill with what is left rather than fail
        if len(chosen) == n:
            break
        if item not in chosen:
            chosen.append(item)
    return chosen


def prepare(src: Path, dest: Path) -> tuple[int, int]:
    """The photo upright, sRGB JPEG, long edge PHOTO_EDGE, with no metadata at all (no GPS leaves the computer)."""
    from PIL import Image, ImageOps

    try:
        import pillow_heif  # noqa: F401 - HEIC from phones

        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((PHOTO_EDGE, PHOTO_EDGE), Image.LANCZOS)
        dest.parent.mkdir(parents=True, exist_ok=True)
        im.save(dest, "JPEG", quality=88, optimize=True)
        return im.size


def photo_palette(paths: list[Path], n: int = 5) -> list[str]:
    """The set's own colours, most vivid first: what a designer samples from the pictures before picking an accent.
    Near-greys and near-black/white are left out, so the accent is a real colour from the place."""
    import colorsys

    from PIL import Image

    seen: dict[tuple, int] = {}
    for p in paths[:4]:
        try:
            with Image.open(p) as im:
                q = im.convert("RGB").resize((80, 80)).quantize(colors=8, method=Image.Quantize.MEDIANCUT)
                pal = q.getpalette() or []
                for count, idx in q.getcolors() or []:
                    rgb = tuple(pal[idx * 3: idx * 3 + 3])
                    seen[rgb] = seen.get(rgb, 0) + count
        except OSError:
            continue
    scored = []
    for rgb, count in seen.items():
        h, l, s = colorsys.rgb_to_hls(*(c / 255 for c in rgb))
        if s < 0.18 or l < 0.12 or l > 0.9:
            continue
        # push it to a print-strength version of itself: same hue, richer saturation, mid lightness
        r, g, b = colorsys.hls_to_rgb(h, min(max(l, 0.38), 0.62), min(1.0, s * 1.35 + 0.1))
        scored.append((s * (count ** 0.5), "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))))
    scored.sort(reverse=True)
    out: list[str] = []
    for _, hexc in scored:
        if hexc not in out:
            out.append(hexc)
    return out[:n]


SUBJECT_PROMPTS = ["a photo of an animal", "a photo of a person", "a photo of people", "a photo of a tent",
                   "a photo of a car or a van", "a photo of a plate of food", "a photo of a campfire", "a photo of a building",
                   "a photo of a hot air balloon", "a photo of a laptop on a table"]
BACKGROUND_PROMPTS = ["a photo of empty sky", "a photo of leaves and branches", "a photo of grass", "a photo of the ground",
                      "a photo of a plain wall", "a blurry photo"]


def _clip_subject(path: Path) -> tuple[float, float, float] | None:
    """Where the subject is by meaning: CLIP scores nine overlapping crops for looking like a subject (an animal, a
    person, a tent, a car, food...) rather than background (sky, foliage, grass). Returns (x, y, confidence) or None.
    Saliency alone takes busy foliage for the subject (21 Nov: a leopard in a tree); meaning does not."""
    try:
        import numpy as np
        from PIL import Image

        from studio import library

        model, preprocess, tok, _, torch, _ = library._model()
        with Image.open(path) as im:
            im = im.convert("RGB")
            w, h = im.size
            centres, crops = [], []
            for cy in (0.25, 0.5, 0.75):
                for cx in (0.25, 0.5, 0.75):
                    cw, ch = w * 0.5, h * 0.5
                    x0, y0 = min(max(0, cx * w - cw / 2), w - cw), min(max(0, cy * h - ch / 2), h - ch)
                    crops.append(preprocess(im.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch)))))
                    centres.append(((x0 + cw / 2) / w, (y0 + ch / 2) / h))
        with torch.no_grad():
            img = model.encode_image(torch.stack(crops))
            img = img / img.norm(dim=-1, keepdim=True)
            txt = model.encode_text(tok(SUBJECT_PROMPTS + BACKGROUND_PROMPTS))
            txt = txt / txt.norm(dim=-1, keepdim=True)
        sim = (img @ txt.T).numpy()
        k = len(SUBJECT_PROMPTS)
        score = sim[:, :k].max(axis=1) - sim[:, k:].max(axis=1)
        weights = np.exp((score - score.max()) * 60)
        weights /= weights.sum()
        x = float(sum(wt * c[0] for wt, c in zip(weights, centres)))
        y = float(sum(wt * c[1] for wt, c in zip(weights, centres)))
        return x, y, float(score.max() - np.median(score))
    except Exception:  # noqa: BLE001 - no model, no torch: saliency alone still gives a point
        return None


def focal_point(path: Path) -> tuple[float, float]:
    """Where the subject is, as (x, y) in 0..1: the point a frame keeps in view when it crops the photo.

    What imgix crop=focalpoint and Cloudinary g_auto do, from parts this studio already has: faces from YuNet (the
    strongest pull), spectral-residual saliency (Hou & Zhang, CVPR 2007: what stands out from the photo's own texture),
    and smartcrop.js's edge and saturation cues, weighted away from the borders. The centroid of the strongest tenth of
    that map is the focal point; with nothing that stands out, the middle."""
    import cv2
    import numpy as np

    img = cv2.imread(str(path))
    if img is None:
        return 0.5, 0.5
    h0, w0 = img.shape[:2]
    small = cv2.resize(img, (128, max(1, round(128 * h0 / w0))), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    # spectral residual: the log amplitude minus its local average, taken back to the image plane
    f = np.fft.fft2(gray)
    log_amp, phase = np.log(np.abs(f) + 1e-8), np.angle(f)
    residual = log_amp - cv2.blur(log_amp.astype(np.float32), (3, 3))
    sal = (np.abs(np.fft.ifft2(np.exp(residual + 1j * phase))) ** 2).astype(np.float32)
    sal = cv2.GaussianBlur(sal, (9, 9), 2.5)
    edges = cv2.GaussianBlur(np.abs(cv2.Laplacian(gray, cv2.CV_32F)), (9, 9), 3)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV).astype(np.float32)
    satur = (hsv[..., 1] / 255) * (hsv[..., 2] / 255)

    def norm(a):
        return (a - a.min()) / (float(np.ptp(a)) or 1.0)

    score = norm(sal) * 0.55 + norm(edges) * 0.25 + norm(satur) * 0.2
    yy, xx = np.mgrid[0:score.shape[0], 0:score.shape[1]]
    cy, cx = (score.shape[0] - 1) / 2, (score.shape[1] - 1) / 2
    score = score * (1 - 0.45 * (((xx - cx) / (cx or 1)) ** 2 + ((yy - cy) / (cy or 1)) ** 2) / 2)  # borders count less
    face_found = False
    face_model = DATA / "bin" / "face_detection_yunet_2023mar.onnx"
    if face_model.exists():  # a face is the subject: it outweighs everything else in the frame
        try:
            det = cv2.FaceDetectorYN.create(str(face_model), "", (small.shape[1], small.shape[0]), 0.7)
            _, faces = det.detect(small)
            for row in faces if faces is not None else []:
                fx, fy, fw, fh = (int(v) for v in row[:4])
                score[max(0, fy):fy + fh, max(0, fx):fx + fw] += 3.0
                face_found = True
        except cv2.error:
            pass
    cut = np.quantile(score, 0.9)
    top = np.where(score >= cut, score, 0)
    total = float(top.sum())
    sx, sy = ((float((top * xx).sum() / total / max(1, score.shape[1] - 1)), float((top * yy).sum() / total / max(1, score.shape[0] - 1)))
              if total > 0 else (0.5, 0.5))
    if face_found:
        return round(sx, 3), round(sy, 3)  # the face boost already dominates the map
    meaning = _clip_subject(path)
    if meaning and meaning[2] > 0.015:  # CLIP sees a clear subject in one part of the photo: follow it, nudged by saliency
        mx, my, _ = meaning
        return round(0.7 * mx + 0.3 * sx, 3), round(0.7 * my + 0.3 * sy, 3)
    return round(sx, 3), round(sy, 3)


FOCAL_CACHE = OUT / "_focal.json"


def cached_focal(source: Path, prepared: Path) -> tuple[float, float]:
    """focal_point, kept per source photo (path, size and time), so a photo used again costs nothing."""
    try:
        st = source.stat()
        key = f"{source}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        return focal_point(prepared)
    try:
        cache = json.loads(FOCAL_CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    if key not in cache:
        cache[key] = list(focal_point(prepared))
        FOCAL_CACHE.parent.mkdir(parents=True, exist_ok=True)
        FOCAL_CACHE.write_text(json.dumps(cache), encoding="utf-8")
    return tuple(cache[key])


def cover_first(prepared: list[dict]) -> list[dict]:
    """The first slide is the one the feed and the profile grid show: put the photo that makes the best cover first,
    a well-scored one that is not near black (21 Nov: an "after dark" set opened on a black frame)."""
    from PIL import Image, ImageStat

    def light(ph: dict) -> float:
        try:
            with Image.open(PUB / ph["src"]) as im:
                return ImageStat.Stat(im.convert("L").resize((64, 64))).mean[0] / 255
        except OSError:
            return 0.0

    if len(prepared) < 2:
        return prepared
    score = [((ph.get("aes") or 5.0) + 6 * min(light(ph), 0.45), -i) for i, ph in enumerate(prepared)]
    best = max(range(len(prepared)), key=lambda i: score[i])
    return [prepared[best], *prepared[:best], *prepared[best + 1:]]


def _fonts() -> None:
    """Copy the studio's OFL fonts (with their licences) into the small public folder once."""
    dst = PUB / "fonts"
    dst.mkdir(parents=True, exist_ok=True)
    for f in (ROOT / "public" / "fonts").iterdir():
        t = dst / f.name
        if not t.exists() or t.stat().st_size != f.stat().st_size:
            shutil.copy2(f, t)


# ---------------------------------------------------------------- cutting and the Story

def slice_slides(still: Path, folder: Path, panels: int) -> list[str]:
    """Cut the wide still into exact 1080x1350 slides (JPEG, sRGB, quality 90, well under Instagram's 8 MB)."""
    from PIL import Image

    names = []
    with Image.open(still) as im:
        im = im.convert("RGB")
        if im.size != (SLIDE_W * panels, SLIDE_H):
            raise ValueError(f"still is {im.size}, expected {(SLIDE_W * panels, SLIDE_H)}")
        for i in range(panels):
            name = f"slide-{i + 1:02d}.jpg"
            im.crop((i * SLIDE_W, 0, (i + 1) * SLIDE_W, SLIDE_H)).save(folder / name, "JPEG", quality=90, optimize=True, subsampling=0)
            names.append(name)
        strip = im.copy()
        strip.thumbnail((2400, 2400), Image.LANCZOS)
        strip.save(folder / "strip.jpg", "JPEG", quality=85, optimize=True)
    return names


def _font(name: str, size: int):
    from PIL import ImageFont

    return ImageFont.truetype(str(ROOT / "public" / "fonts" / name), size)


def story(folder: Path, cover: Path, photo: Path, theme: dict, handle: str) -> str:
    """A 9:16 Story that shares the post: the first slide on a blurred photo, the theme's line above, the handle below."""
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

    with Image.open(photo) as p:
        bg = ImageOps.fit(p.convert("RGB"), (STORY_W, STORY_H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(38))
    bg = ImageEnhance.Brightness(bg).enhance(0.62)
    with Image.open(cover) as c:
        cw = 860
        card = c.convert("RGB").resize((cw, round(cw * SLIDE_H / SLIDE_W)), Image.LANCZOS)
    x, y = (STORY_W - card.width) // 2, 390
    shadow = Image.new("RGBA", (STORY_W, STORY_H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x + 6, y + 22, x + card.width + 6, y + card.height + 22), 30, fill=(0, 0, 0, 150))
    bg = Image.alpha_composite(bg.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(24)))
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, card.width, card.height), 30, fill=255)
    bg.paste(card, (x, y), mask)
    d = ImageDraw.Draw(bg)
    for text, font, top in ((theme["kicker"], _font("KleeOne-SemiBold.ttf", 46), 190), (theme["titleJa"], _font("ShipporiMincho-Bold.ttf", 74), 262)):
        w = d.textlength(text, font=font)
        d.text(((STORY_W - w) / 2, top), text, font=font, fill=(255, 255, 255))
    pill = "新しい投稿をみる →"
    f = _font("ZenKakuGothicNew-Bold.ttf", 40)
    w = d.textlength(pill, font=f)
    top = y + card.height + 90
    d.rounded_rectangle(((STORY_W - w) / 2 - 44, top, (STORY_W + w) / 2 + 44, top + 92), 46, fill=(255, 255, 255))
    d.text(((STORY_W - w) / 2, top + 20), pill, font=f, fill=(30, 30, 30))
    if handle:
        f2 = _font("ZenKakuGothicNew-Medium.ttf", 34)
        w2 = d.textlength(handle, font=f2)
        d.text(((STORY_W - w2) / 2, top + 140), handle, font=f2, fill=(255, 255, 255))
    bg.convert("RGB").save(folder / "story.jpg", "JPEG", quality=90, optimize=True)
    return "story.jpg"


# ---------------------------------------------------------------- the Story as a short video, and sending it

# An Instagram Story made through the API is a video sent by resumable upload (studio.connectors.instagram_story);
# an image Story would need the picture on a public URL first (BL-049). So the set's Story is a short 9:16 video that
# steps through its slides: each held STORY_HOLD_S, the next sliding in over STORY_SLIDE_S. Inside the safe area
# (Instagram draws its own bar over the top ~250 px and the reply box over the bottom ~300 px).
STORY_HOLD_S, STORY_SLIDE_S, STORY_FPS = 3.0, 0.45, 30


def _theme_of(meta: dict) -> dict:
    return next((t for t in themes() if t.get("id") == meta.get("theme")), {"kicker": meta.get("styleJa", ""), "titleJa": meta.get("themeJa", "")})


def _story_frame(bg, slide: Path, k: int, n: int, theme: dict, handle: str):
    from PIL import Image, ImageDraw

    # no title above the slide: every cover already carries it (21 Nov: the first Story said it twice); the slide
    # takes the room instead, inside Instagram's safe area
    frame = bg.copy()
    with Image.open(slide) as c:
        cw = 900
        card = c.convert("RGB").resize((cw, round(cw * SLIDE_H / SLIDE_W)), Image.LANCZOS)
    x, y = (STORY_W - card.width) // 2, 300
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, card.width, card.height), 26, fill=255)
    frame.paste(card, (x, y), mask)
    d = ImageDraw.Draw(frame)
    dots_y, gap = y + card.height + 44, 26
    left = (STORY_W - (n - 1) * gap) / 2
    for i in range(n):
        r = 7 if i == k else 5
        d.ellipse((left + i * gap - r, dots_y - r, left + i * gap + r, dots_y + r), fill=(255, 255, 255) if i == k else (160, 160, 160))
    if handle:
        f = _font("ZenKakuGothicNew-Medium.ttf", 32)
        w = d.textlength(handle, font=f)
        d.text(((STORY_W - w) / 2, dots_y + 34), handle, font=f, fill=(255, 255, 255))
    return frame


def story_video(set_id: str) -> Path:
    """<set>/story.mp4: the set's slides one after another in a 9:16 Story, 3 s each, sliding in from the right."""
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps

    from studio.brand import brand
    from studio.config import ffmpeg_bin

    if not ID_RX.match(set_id or ""):
        raise ValueError("id: a photo post's id")
    folder = OUT / set_id
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    slides = [folder / s for s in meta["slides"]]
    theme, handle = _theme_of(meta), (brand().get("handle") or "")
    with Image.open(slides[0]) as first:  # the cover, blurred and dimmed, behind every slide
        bg = ImageOps.fit(first.convert("RGB"), (STORY_W, STORY_H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
    bg = ImageEnhance.Brightness(bg).enhance(0.55)
    tmp = folder / "_story"
    tmp.mkdir(exist_ok=True)
    frames = []
    for k, s in enumerate(slides):
        f = tmp / f"f{k:02d}.jpg"
        _story_frame(bg, s, k, len(slides), theme, handle).convert("RGB").save(f, "JPEG", quality=94)
        frames.append(f)
    hold = [STORY_HOLD_S + (0.6 if k == 0 else 0) + (STORY_SLIDE_S if 0 < k < len(frames) - 1 else 0) for k in range(len(frames))]
    if len(frames) > 1:
        hold[-1] += STORY_SLIDE_S + 0.5
    cmd = [str(ffmpeg_bin()), "-y", "-v", "error"]
    for f, t in zip(frames, hold):
        cmd += ["-loop", "1", "-framerate", str(STORY_FPS), "-t", f"{t:.2f}", "-i", str(f)]
    cmd += ["-f", "lavfi", "-t", f"{sum(hold):.2f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    chain, last, offset = [], "0:v", 0.0
    for k in range(1, len(frames)):
        offset += hold[k - 1] - STORY_SLIDE_S
        out = f"v{k}"
        chain.append(f"[{last}][{k}:v]xfade=transition=slideleft:duration={STORY_SLIDE_S}:offset={offset:.2f}[{out}]")
        last = out
    chain.append(f"[{last}]format=yuv420p[v]")
    out_file = folder / "story.mp4"
    cmd += ["-filter_complex", ";".join(chain), "-map", "[v]", "-map", f"{len(frames)}:a", "-c:v", "libx264", "-preset", "medium",
            "-crf", "18", "-r", str(STORY_FPS), "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", str(out_file)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=300)
    shutil.rmtree(tmp, ignore_errors=True)
    return out_file


STORY_NET = "photo-story"       # its rows in the posting log: slug = the set's id
STORY_SLOT = (12, 15)           # lunchtime in the audience's zone; reels' Stories go with YouTube at 19:00
STORY_DAYS = 60                 # how far ahead a free day is looked for


class FacesFound(ValueError):
    """A slide shows someone's face: booking it needs the person's yes (force)."""


def faces_in(set_id: str) -> list[int]:
    """Slide numbers (1-based) where YuNet finds a face. The photos are picked with no faces, but small ones slip in
    (21 Nov: two guests by a tent); a Story goes out to everyone, so it is checked before it is booked."""
    import cv2
    import numpy as np
    from PIL import Image

    try:  # OpenCV 5 prints a warning per detector about targets; nothing a person can act on
        cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
    except AttributeError:
        pass
    model = DATA / "bin" / "face_detection_yunet_2023mar.onnx"
    meta = _meta(set_id)
    if not model.exists():
        return []
    found = []
    for k, name in enumerate(meta["slides"], 1):
        with Image.open(OUT / set_id / name) as im:
            arr = cv2.cvtColor(np.asarray(im.convert("RGB")), cv2.COLOR_RGB2BGR)
        det = cv2.FaceDetectorYN.create(str(model), "", (arr.shape[1], arr.shape[0]), 0.75)
        _, faces = det.detect(arr)
        if faces is not None and any(f[2] >= 14 and f[3] >= 14 for f in faces):
            found.append(k)
    return found


def _meta(set_id: str) -> dict:
    if not ID_RX.match(set_id or ""):
        raise ValueError("id: a photo post's id")
    f = OUT / set_id / "meta.json"
    if not f.exists():
        raise FileNotFoundError(f"no photo post {set_id}")
    return json.loads(f.read_text(encoding="utf-8"))


def _save_meta(meta: dict) -> None:
    (OUT / meta["id"] / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _tz():
    from studio.posting import audience_tz

    return audience_tz() or JST


def story_rows() -> list[dict]:
    """The photo Stories in the posting log that still count (booked, sent, failed): not taken back."""
    from studio import posting

    return [r for r in posting.posts() if r["network"] == STORY_NET and r["status"] not in ("replaced", "dropped")]


def next_story_slot(now: datetime | None = None) -> datetime:
    """The first day from today with no photo Story on it, at STORY_SLOT in the audience's zone (today only while the
    slot is more than 10 minutes away): one a day, so they do not pile up."""
    from studio import posting

    tz = _tz()
    now = (now or datetime.now(timezone.utc)).astimezone(tz)
    taken = {posting.aware(r["at"]).astimezone(tz).date() for r in story_rows() if posting.aware(r["at"])}
    for d in range(STORY_DAYS):
        day = (now + timedelta(days=d)).date()
        at = datetime(day.year, day.month, day.day, *STORY_SLOT, tzinfo=tz)
        if at - now > timedelta(minutes=10) and day not in taken:
            return at
    raise RuntimeError(f"every day of the next {STORY_DAYS} already has a photo Story")


def schedule_story(set_id: str, at: str | None = None, force: bool = False) -> dict:
    """Book the set as an Instagram Story: the studio sends it at its time (publish.run_due, every minute), as it does
    the reels' Stories. Next free lunchtime unless `at` is given. A set that shows a face needs force=True."""
    from studio import posting
    from studio.connectors import instagram_story

    meta = _meta(set_id)
    if meta.get("storyPosted"):
        raise ValueError(f"this set went to Instagram as a Story at {meta['storyPosted']['at']}")
    if any(r["slug"] == set_id and r["status"] == "queued" for r in story_rows()):
        raise ValueError("this set is already booked as a Story")
    if not instagram_story.status().get("connected"):
        raise ValueError("Instagram Stories are not connected: Accounts › Facebook › Connect")
    if not force:
        faces = faces_in(set_id)
        if faces:
            raise FacesFound(f"slide {', '.join(map(str, faces))} shows someone's face; a Story goes out to everyone. Book it anyway only if they agreed.")
    when = datetime.fromisoformat(at) if at else next_story_slot()
    if when.tzinfo is None:
        when = when.replace(tzinfo=_tz())
    if when - datetime.now(timezone.utc) < timedelta(minutes=10):
        raise ValueError("pick a time at least 10 minutes from now, or use Post to Instagram Story")
    if not (OUT / set_id / "story.mp4").exists():
        story_video(set_id)  # made now, so the booking cannot fail later for want of the file
    pid = posting.queue(set_id, STORY_NET, when.isoformat(timespec="minutes"))
    meta["storyQueued"] = {"id": pid, "at": when.isoformat(timespec="minutes")}
    _save_meta(meta)
    return {"queued": True, "id": pid, "at": meta["storyQueued"]["at"], "set": set_id}


def unschedule_story(set_id: str) -> dict:
    """Take a booked photo Story back before it goes (the row is removed: it never went out)."""
    from studio import posting

    meta = _meta(set_id)
    rows = [r for r in story_rows() if r["slug"] == set_id and r["status"] == "queued"]
    for r in rows:
        posting.drop(int(r["id"]))
    meta.pop("storyQueued", None)
    _save_meta(meta)
    return {"unbooked": len(rows), "set": set_id}


def post_story(set_id: str, post_id: int | None = None) -> dict:
    """Send the set to Instagram as a Story now (the video above), through the Facebook connection, and log it in the
    posting log (network "photo-story") so its numbers are read while it is up (studio.perf) and kept. Once per set:
    a second call says when it went. The meta remembers it ({at, url, id, post})."""
    from studio import posting
    from studio.connectors import instagram_story

    meta = _meta(set_id)
    if meta.get("storyPosted"):
        if post_id:
            posting.drop(int(post_id))
        raise RuntimeError(f"this set went to Instagram as a Story at {meta['storyPosted']['at']}")
    print("STAGE 1/2 making the Story video", flush=True)
    video = story_video(set_id)
    meta["storyVideo"] = "story.mp4"
    if not post_id:
        post_id = posting.record(set_id, STORY_NET, "queued", datetime.now(_tz()).isoformat(timespec="minutes"))
    print("STAGE 2/2 sending it to Instagram", flush=True)
    try:
        sent = instagram_story.post(video)
    except Exception as err:
        posting.settle(post_id, "failed", note=str(err)[:400])
        raise
    url, rid = sent.get("url") or "", str(sent.get("remote_id") or "")
    posting.settle(post_id, "posted", url, rid)
    posting.done(post_id, url)  # the time it actually went out
    meta["storyPosted"] = {"at": datetime.now(JST).isoformat(timespec="seconds"), "url": url, "id": rid, "post": int(post_id)}
    meta.pop("storyQueued", None)
    _save_meta(meta)
    return {"posted": True, **meta["storyPosted"]}


def send_due(row: dict) -> dict:
    """publish.run_due's hand-off for a booked photo Story whose time has come."""
    try:
        out = post_story(row["slug"], int(row["id"]))
    except FileNotFoundError as err:  # the set was deleted after it was booked: nothing to send
        from studio import posting

        posting.settle(int(row["id"]), "failed", note=str(err))
        raise
    return {"id": row["id"], "status": "posted", "url": out.get("url", ""), "network": STORY_NET, "slug": row["slug"]}


def story_results(rows: list[dict] | None = None) -> dict[str, dict]:
    """The latest numbers of each set's Story, read by studio.perf while it was up and kept in the catalog after it
    is gone: {set id: {views, reach, shares, follows, profile_visits, total_interactions, navigation, age_h, at}}."""
    from studio import perf

    rows = perf.readings() if rows is None else rows
    out: dict[str, dict] = {}
    for r in rows:
        if r.get("network") != STORY_NET:
            continue
        cur = out.get(r["slug"])
        if cur and str(cur["at"]) > str(r["fetched_at"]):
            continue
        extra = r.get("extra") or {}
        out[r["slug"]] = {**{k: r.get(k) for k in ("views", "reach", "shares", "follows") if r.get(k) is not None},
                          **{k: extra[k] for k in ("profile_visits", "total_interactions", "navigation") if k in extra},
                          "age_h": r.get("age_h"), "at": r["fetched_at"]}
    return out


def look_results(sets: list[dict]) -> list[dict]:
    """Which looks and subjects people watched: the Stories' final readings averaged by look, best first. What the
    next batches lean on as results come in (shown on the page; too few to steer the picks yet)."""
    by: dict[str, list[dict]] = {}
    for s in sets:
        res = s.get("storyResult")
        if res and isinstance(res.get("reach") or res.get("views"), int):
            by.setdefault(s["style"], []).append(res)
    out = []
    for style, rs in by.items():
        avg = lambda k: round(sum(r.get(k) or 0 for r in rs) / len(rs), 1)  # noqa: E731
        out.append({"style": style, "stories": len(rs), "reach": avg("reach"), "views": avg("views"), "profile_visits": avg("profile_visits")})
    return sorted(out, key=lambda x: -(x["reach"] or x["views"]))


# ---------------------------------------------------------------- make, list, delete

# Mean CLIP match of a subject's 8 best photos. Measured 21 Nov: on the ranch's library every subject scored 0.264-0.312;
# on a safari trip's library "First snow" scored 0.224 and "After dark" 0.240 (savanna photos) — words that would lie
# about the pictures. A subject under this is not drawn for that library.
MIN_FIT = 0.26


def fitting_themes() -> list[dict]:
    """The subjects this library has real photos of (best first); never empty: at least the best-fitting one."""
    from studio import library
    from studio.brand import home_place

    filters = {"kind": "photo", "noFaces": True, **({"ranch": True} if home_place() is not None else {})}
    scored = []
    with library.batch():
        for th in themes():
            top = [i.get("match") or 0 for i in library.items(th["query"], filters, limit=8)]
            scored.append((sum(top) / len(top) if top else 0.0, th))
    scored.sort(key=lambda s: -s[0])
    good = [th for fit, th in scored if fit >= MIN_FIT]
    return (good or [scored[0][1]]) if scored else []


def _plan(n: int, style: str | None, theme: str | None, rng: random.Random, ths: list[dict] | None = None) -> list[tuple[dict, dict]]:
    """Which look with which subject: every look once before any repeats, subjects rotated so neighbours differ."""
    sts, ths = styles(), (ths if ths is not None else themes())
    if not facts():  # "In numbers" prints true facts; a brand with none does not get made-up ones
        sts = [s for s in sts if s["id"] != "numbers"]
    if style:
        sts = [s for s in sts if s["id"] == style] or sts
    if theme:
        ths = [t for t in ths if t["id"] == theme] or ths
    order = sts[:]
    rng.shuffle(order)
    subj = ths[:]
    rng.shuffle(subj)
    return [(order[k % len(order)], subj[k % len(subj)]) for k in range(n)]


def make(n: int = 10, style: str | None = None, theme: str | None = None, seed: int | None = None) -> dict:
    from studio.brand import brand

    seed = seed if seed is not None else random.randrange(1, 10**6)
    rng = random.Random(seed)
    b = brand()
    now = datetime.now(JST)
    run = f"{now:%m%d-%H%M%S}"
    plan = _plan(max(1, min(int(n), 20)), style, theme, rng, None if theme else fitting_themes())
    print(f"STAGE 1/3 picking photos for {len(plan)} posts", flush=True)
    if (PUB / "sets").exists():
        shutil.rmtree(PUB / "sets", ignore_errors=True)
    _fonts()
    used: set[str] = set()
    sets, jobs, skipped = [], [], []
    for k, (st, th) in enumerate(plan):
        th = with_hook(th, random.Random(seed * 7 + k))
        caps = captions(th, st, st["panels"], random.Random(seed * 13 + k))
        bad = [p for w in slide_words(th) + [v for kk, v in caps.items() if not kk.startswith("_")] for p in copy_problems(str(w))]
        if bad:
            skipped.append({"style": st["id"], "theme": th["id"], "why": sorted(set(bad))})
            continue
        sid = f"{run}-{k + 1:02d}-{st['id']}-{th['id']}"
        print(f"PROGRESS {k}/{len(plan)} {st['en']} · {th['title']}", flush=True)
        photos = pick_photos(th, st["photos"], random.Random(seed * 31 + k), used)
        if len(photos) < max(2, st["photos"] // 2):
            skipped.append({"style": st["id"], "theme": th["id"], "why": [f"only {len(photos)} photos found"]})
            continue
        used.update(p["path"] for p in photos)
        prepared = []
        for j, ph in enumerate(photos):
            rel = f"sets/{sid}/p{j + 1:02d}.jpg"
            try:
                w, h = prepare(Path(ph["path"]), PUB / rel)
            except Exception as err:  # noqa: BLE001 - an unreadable photo is left out, not the whole set
                print(f"skipped {Path(ph['path']).name}: {err}", file=sys.stderr)
                continue
            fx, fy = cached_focal(Path(ph["path"]), PUB / rel)
            prepared.append({"src": rel, "w": w, "h": h, "fx": fx, "fy": fy, "asset": ph["id"], "file": ph["file"], "tagsJa": ph.get("tagsJa", [])[:3], "aes": ph.get("aesthetic")})
        if not prepared:
            continue
        if st["id"] in ("riso", "pixel", "typeclip", "contact"):  # duotone, pixels and letter-cuts turn a dark photo into a black block
            from PIL import Image, ImageStat

            def _light(ph: dict) -> float:
                with Image.open(PUB / ph["src"]) as im:
                    return ImageStat.Stat(im.convert("L").resize((64, 64))).mean[0] / 255

            prepared.sort(key=lambda ph: _light(ph) < 0.18)  # stable: bright ones first, dark ones only fill in
        prepared = cover_first(prepared)
        props = {"style": st["id"], "panels": st["panels"], "w": SLIDE_W, "h": SLIDE_H, "seed": seed + k,
                 "photos": [{"src": p["src"], "w": p["w"], "h": p["h"], "fx": p["fx"], "fy": p["fy"]} for p in prepared],
                 **{key: th[key] for key in ("title", "titleJa", "sub", "kicker", "notes", "notesJa", "poem", "items", "hookJa", "hookEn", "palette")},
                 "handle": b.get("handle") or b.get("name") or "", "brand": b.get("name") or "", "date": f"'{now:%y %m %d}",
                 "photoPalette": photo_palette([PUB / ph["src"] for ph in prepared]),
                 "facts": facts(), "variant": rng.randrange(0, 6), **{k: v for k, v in place().items() if v is not None}}
        folder = OUT / sid
        folder.mkdir(parents=True, exist_ok=True)
        jobs.append({"props": props, "out": str(folder / "still.png"), "label": f"{st['en']} · {th['title']}"})
        sets.append({"id": sid, "style": st["id"], "styleEn": st["en"], "styleJa": st["ja"], "theme": th["id"], "themeEn": th["title"], "themeJa": th["titleJa"],
                     "panels": st["panels"], "seed": seed + k, "created": now.isoformat(timespec="seconds"), "photos": prepared,
                     "captions": caps, "_theme": th, "_folder": folder})
    if not jobs:
        print("RESULT " + json.dumps({"made": [], "skipped": skipped, "seed": seed}, ensure_ascii=False), flush=True)
        return {"made": [], "skipped": skipped, "seed": seed}
    print(f"STAGE 2/3 drawing {len(jobs)} posts", flush=True)
    spec = OUT / "_jobs.json"
    spec.write_text(json.dumps({"publicDir": str(PUB), "bundleDir": str(BUNDLE), "jobs": jobs}, ensure_ascii=False), encoding="utf-8")
    node = shutil.which("node") or "node"
    proc = subprocess.Popen([node, str(ROOT / "scripts" / "post-stills.mjs"), str(spec)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    result = {"done": [], "failed": []}
    for line in proc.stdout:
        line = line.rstrip()
        if line.startswith("RESULT "):
            result = json.loads(line[7:])
        elif line.startswith("PROGRESS "):
            print(line, flush=True)
    err = proc.stderr.read()
    proc.wait()
    print("STAGE 3/3 cutting slides and writing captions", flush=True)
    made = []
    failed = {f["out"]: f["error"] for f in result.get("failed", [])}
    for s in sets:
        folder, th = s.pop("_folder"), s.pop("_theme")
        still = folder / "still.png"
        if not still.exists():
            skipped.append({"style": s["style"], "theme": s["theme"], "why": [failed.get(str(still)) or (err.strip().splitlines() or ["drawing failed"])[-1][:300]]})
            shutil.rmtree(folder, ignore_errors=True)
            continue
        s["slides"] = slice_slides(still, folder, s["panels"])
        still.unlink()
        s["story"] = story(folder, folder / s["slides"][0], PUB / s["photos"][0]["src"], th, b.get("handle") or "")
        s["alt"] = [f"{s['themeJa']} {i + 1}/{s['panels']}" for i in range(s["panels"])]
        (folder / "meta.json").write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
        try:  # the Story as a video, to watch here before it is sent (post_story makes it again if it is missing)
            story_video(s["id"])
            s["storyVideo"] = "story.mp4"
            (folder / "meta.json").write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as err:  # noqa: BLE001 - the carousel is still good without it
            print(f"note: no Story video for {s['id']}: {err}", flush=True)
        made.append(s["id"])
    out = {"made": made, "skipped": skipped, "seed": seed}
    print("RESULT " + json.dumps(out, ensure_ascii=False), flush=True)
    return out


def list_sets() -> list[dict]:
    """Every photo post made so far, newest first (meta.json of each)."""
    if not OUT.exists():
        return []
    out = []
    for f in OUT.glob("*/meta.json"):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    out.sort(key=lambda m: (m.get("created") or "", m.get("id") or ""), reverse=True)
    # The posting log and the Story readings are the record: a booking, a send and its numbers, kept after it expires.
    try:
        rows, results = story_rows(), story_results()
    except Exception:  # noqa: BLE001 - the sets still list without the catalog
        rows, results = [], {}
    for m in out:
        q = next((r for r in rows if r["slug"] == m.get("id") and r["status"] == "queued"), None)
        m.pop("storyQueued", None)
        if q:
            m["storyQueued"] = {"id": int(q["id"]), "at": q["at"]}
        failed = next((r for r in rows if r["slug"] == m.get("id") and r["status"] == "failed"), None)
        if failed and not m.get("storyPosted"):
            m["storyFailed"] = {"id": int(failed["id"]), "at": failed["at"], "why": failed.get("note") or ""}
        if m.get("id") in results:
            m["storyResult"] = results[m["id"]]
    return out


def file_path(set_id: str, name: str) -> Path | None:
    """The file of a set the server may send: only slides, the strip and the Story inside <data>/stills/<id>/."""
    if not ID_RX.match(set_id or "") or not re.match(r"^(slide-\d{2}|strip|story)\.jpg$|^story\.mp4$", name or ""):
        return None
    p = OUT / set_id / name
    return p if p.is_file() else None


def approve(set_id: str) -> dict:
    """Send a set to the ready folder the person who posts opens (the ranch's Drive; another project's data/ready):
    one folder per set with the slides in order, the Story, and one caption file per network. The meta remembers it."""
    from studio.config import READY

    if not ID_RX.match(set_id or ""):
        raise ValueError("id: a photo post's id")
    folder = OUT / set_id
    meta_file = folder / "meta.json"
    if not meta_file.exists():
        raise FileNotFoundError(f"no photo post {set_id}")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    dest = READY / f"{datetime.now(JST):%Y%m%d}_photo-{set_id}"
    dest.mkdir(parents=True, exist_ok=True)
    for name in meta["slides"] + [meta["story"]]:
        shutil.copy2(folder / name, dest / name)
    names = {"instagram": "instagram.txt", "facebook": "facebook.txt", "threads": "threads.txt", "x": "x.txt", "bluesky": "bluesky.txt"}
    for net, fname in names.items():
        (dest / fname).write_text(meta["captions"].get(net, "") + "\n", encoding="utf-8")
    (dest / "README.txt").write_text(
        f"{meta['styleJa']} · {meta['themeJa']} ({meta['styleEn']} · {meta['themeEn']})\n"
        f"Instagram: post slide-01.jpg … slide-{len(meta['slides']):02d}.jpg in order as one post, add music in the app, caption from instagram.txt.\n"
        f"Story: story.jpg, with a link sticker to the post.\n"
        f"インスタ：slide-01〜{len(meta['slides']):02d}を順番に1つの投稿に。アプリで音楽を追加し、キャプションは instagram.txt から。\n", encoding="utf-8")
    meta["approved"] = {"at": datetime.now(JST).isoformat(timespec="seconds"), "folder": str(dest)}
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"approved": True, "folder": str(dest), "files": len(meta["slides"]) + 1 + len(names) + 1}


def delete(set_id: str) -> bool:
    if not ID_RX.match(set_id or ""):
        raise ValueError("id: a photo post's id")
    folder = OUT / set_id
    if not (folder / "meta.json").exists():
        return False
    shutil.rmtree(folder)
    return True
