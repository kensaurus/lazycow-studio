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
            prepared.append({"src": rel, "w": w, "h": h, "asset": ph["id"], "file": ph["file"], "tagsJa": ph.get("tagsJa", [])[:3], "aes": ph.get("aesthetic")})
        if not prepared:
            continue
        if st["id"] in ("riso", "pixel", "typeclip", "contact"):  # duotone, pixels and letter-cuts turn a dark photo into a black block
            from PIL import Image, ImageStat

            def _light(ph: dict) -> float:
                with Image.open(PUB / ph["src"]) as im:
                    return ImageStat.Stat(im.convert("L").resize((64, 64))).mean[0] / 255

            prepared.sort(key=lambda ph: _light(ph) < 0.18)  # stable: bright ones first, dark ones only fill in
        prepared = cover_first(prepared)
        if st["id"] == "pixel":  # a real pixel look needs a tiny picture stretched without smoothing; CSS alone blurs it
            from PIL import Image

            for ph in prepared:
                small = ph["src"].replace(".jpg", "-px.png")
                with Image.open(PUB / ph["src"]) as im:
                    im.convert("RGB").resize((96, max(1, round(96 * im.height / im.width))), Image.BOX).quantize(colors=24).save(PUB / small)
                ph["src"] = small
        props = {"style": st["id"], "panels": st["panels"], "w": SLIDE_W, "h": SLIDE_H, "seed": seed + k,
                 "photos": [{"src": p["src"], "w": p["w"], "h": p["h"]} for p in prepared],
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
    return out


def file_path(set_id: str, name: str) -> Path | None:
    """The file of a set the server may send: only slides, the strip and the Story inside <data>/stills/<id>/."""
    if not ID_RX.match(set_id or "") or not re.match(r"^(slide-\d{2}|strip|story)\.jpg$", name or ""):
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
