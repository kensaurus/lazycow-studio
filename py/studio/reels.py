"""
FILE: py/studio/reels.py
PURPOSE: The three house reels, from footage verified at the ranch, with words
         taken from the website's SSOT lines, and a package per social channel.
OVERVIEW: REELS lists shots (source, in point, length, pan, speed) and beats
          (hook / line / end). build(slug) grades each shot for 9:16 and 16:9,
          renders Remotion Story at 9:16, 4:5 and 16:9, then writes one folder
          per channel into Drive drafts/ with the right file, a cover and the post.
DEPENDENCIES: studio.shot, studio.remotion (_remotion, _loud), studio.verify, studio.guard
USAGE: python -m studio reels --plan | --build <slug> | --build all
NOTES: Sources come only from folders whose GPS is at the ranch (the house reels'
       own folders, in studio.reel_specs, part of the ranch overlay) or,
       for the pizza deck clip, the deck itself in frame. On-screen copy:
       REVERSAL_LINES 'view' and 'fire', CORE_LINE + SLEEP_LINE, POSITIONING_PILLARS.winter.
       Posts follow docs/marketing/SOCIAL_CHANNELS.md. Drafts are for a person to
       review; nothing here posts.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from studio.config import DATA, RANCH, ROOT, SOURCE, ffmpeg_bin
from studio.guard import assert_copy
from studio.ingest import is_output
from studio.remotion import _loud, _remotion
from studio.staging import mark_kind, number_lines, portrait_shots, shot_marks, staging
from studio.shot import is_360, render_shot
from studio.sphere import move_for
from studio.verify import verify_master

DRAFTS = Path(os.environ.get("STUDIO_DRAFTS", str(SOURCE / "tsumagoi-video-edit-sns" / "drafts" / "20261107" if RANCH else DATA / "drafts")))
# Apps where the poster usually adds trending audio: they also get the picture with clip sound only.
NO_MUSIC_COPY = ("instagram", "tiktok")
SITE = "https://tsumagoi.kensaur.us/"
POSTS = {
    "view": {
        "ja": "不便だからこそ、景色がいい。\n標高1,444m、いちばん近い民家まで道のりで約10km。デッキの前は草原、その先に山の尾根。",
        "en": "Hard to reach. That is why the view is this good.\n1,444 m up, about 10 km by road to the nearest homes.",
        "price_ja": "フィールドだけ：大人1人目 ¥5,200／泊・2人目から1名 ¥2,200。駐車込み。",
        "linkedin": "標高1,444m、いちばん近い民家まで道のりで約10km。\n山まるごとの貸切は一律料金です。〜30名で日帰り¥120,000／テント泊¥180,000、31〜50名で¥180,000／¥250,000。\n\n不便だからこそ、景色がいい。デッキの前は草原、その先に山の尾根。会社のオフサイトを、この景色の前で。\n\nイベントは50名まで — 山の水インフラに正直な上限です。",
        "path": "events",
    },
    "fire": {
        "ja": "お店がないからこそ、同じ火を囲む。\nレストランも店員もいません。共用キッチンで自分で作って、デッキの焚き火台へ。",
        "en": "No restaurant. So you sit around one fire.\nYou cook in the shared kitchen and bring it to the fire on the deck.",
        "price_ja": "ぜんぶ込みキャンプ：大人1人目 ¥7,200／泊・2人目から1名 ¥4,200。駐車込み。",
        "linkedin": "レストランも店員もいない会場です。\n貸切は〜30名で日帰り¥120,000／テント泊¥180,000、31〜50名で¥180,000／¥250,000。お食事は主催者手配（配達可能な2社をご紹介します）。\n\nお店がないからこそ、同じ火を囲む。共用キッチンで自分たちで作って、デッキの焚き火台へ。チームの夜は、そこで決まります。",
        "path": "events",
    },
    "winter": {
        "ja": "山で働く。冬でも、夜通しでも。\n外は氷点下。中は、こたつと光回線。寝るのは、自分の車かテント。",
        "en": "Work in the mountains. Even in winter. Even all night.\nBelow zero outside. A kotatsu and fibre inside. You sleep in your own car or a tent.",
        "price_ja": "ぜんぶ込みキャンプ：大人1人目 ¥7,200／泊・2人目から1名 ¥4,200。こたつラウンジは24時間、シャワー・ジムまで込み。",
        "linkedin": "標高1,444m、100Mbpsの光回線。\n冬の夜は氷点下です。中は、こたつと光回線。\n\n山で働く。冬でも、夜通しでも。寝るのは、自分の車かテント。\n\n貸切は〜30名で日帰り¥120,000／テント泊¥180,000、31〜50名で¥180,000／¥250,000。冬のオフサイトのご相談を受け付けています。",
        "path": "reserve",
    },
}

# X is short JA with a link. Xiaohongshu is a draft in Simplified Chinese: CORE_LINE.zh and
# SLEEP_LINE.zh are the site's own; every other zh line is a draft for a native speaker,
# and RED forbids links, QR codes and other-platform IDs, so none appear.
SHORT = {
    "view": {
        "x": "不便だからこそ、景色がいい。\n標高1,444m、いちばん近い民家まで道のりで約10km。",
        "zh": "正因为不方便，风景才这么好。\n海拔1,444米，沿路到最近的民居大约10公里。露台前是草原，再往前是连绵的山脊。\n群马县嬬恋村・嬬恋牧场Work&Camp",
    },
    "fire": {
        "x": "お店がないからこそ、同じ火を囲む。\n共用キッチンで自分で作って、デッキの焚き火台へ。",
        "zh": "正因为没有餐厅，大家才围着同一团火。\n这里没有餐厅，也没有店员。在共用厨房自己动手做，再端到露台的火盆边。\n群马县嬬恋村・嬬恋牧场Work&Camp",
    },
    "winter": {
        "x": "山で働く。冬でも、夜通しでも。\n寝るのは、自分の車かテント。",
        "zh": "在山上工作。冬天也行，通宵也行。\n外面零度以下，里面有被炉和光纤网络。\n睡在自己的车里或帐篷里。\n群马县嬬恋村・嬬恋牧场Work&Camp",
    },
}
ZH_TAGS = "#日本旅行 #群马 #嬬恋村 #日本自驾游 #日本露营"

POSTS["field"] = {
    "ja": "区画がないからこそ、好きな場所に張れる。\n区画のない、ひとつの草原。1日5組までだから、となりのテントが近すぎない。",
    "en": "No marked pitches. So you pitch wherever you like.\nOne open field, at most 5 groups a night, so the next tent is never too close.",
    "price_ja": "フィールドだけ：大人1人目 ¥5,200／泊・2人目から1名 ¥2,200。駐車込み。",
    "linkedin": "区画のない、ひとつの草原を、チームで。\n山まるごとの貸切は一律料金です。〜30名で日帰り¥120,000／テント泊¥180,000、31〜50名で¥180,000／¥250,000。\n\n一般開放日は1日5組まで。貸切の日は、この草原がまるごとチームのものになります。\n\nイベントは50名まで — 山の水インフラに正直な上限です。",
    "path": "reserve",
}
SHORT["field"] = {
    "x": "区画がないからこそ、好きな場所に張れる。\n1日5組までだから、となりのテントが近すぎない。",
    "zh": "正因为没有划分营位，可以在喜欢的地方搭帐篷。\n一整片没有分区的草原，每天最多5组，邻居的帐篷不会离得太近。\n群马县嬬恋村・嬬恋牧场Work&Camp",
}

GRID = 0.5  # every cut on a half-second grid (120 BPM)
try:  # the ranch's house reels: part of the ranch overlay, so a public clone has none
    from studio.reel_specs import REELS  # noqa: E402
except ModuleNotFoundError:
    REELS = []

from studio.config import channel_who, project_file  # noqa: E402  (a project may switch networks off in its own copy)

CHANNEL_SPEC = json.loads(project_file("channels.json").read_text(encoding="utf-8"))


def _own_networks(spec: dict) -> dict:
    """This project's switches over the shared list: networks.json {"off": [...], "on": [...], "accounts": {id: "@handle"}}."""
    own = DATA / "networks.json"
    if not own.is_file():
        return spec
    o = json.loads(own.read_text(encoding="utf-8"))
    for c in spec["channels"]:
        if c["id"] in o.get("off", []):
            c["off"] = True
        elif c["id"] in o.get("on", []):
            c.pop("off", None)
        if o.get("accounts", {}).get(c["id"]):
            c["account"] = str(o["accounts"][c["id"]])[:80]
    return spec


CHANNEL_SPEC = _own_networks(CHANNEL_SPEC)
CHANNELS = {c["id"]: c for c in CHANNEL_SPEC["channels"]}
from studio.shot import PHOTO_EXT  # noqa: E402  (every still the renderer can read)


def all_reels() -> list[dict]:
    """House reels, with any editor project of the same slug taking its place, plus new projects."""
    from studio.projects import all_projects

    projects = {p["slug"]: p for p in all_projects()}
    house = REELS if RANCH else []  # the house reels are the ranch's own; a project made in the studio has none
    merged = [projects.pop(r["slug"], r) for r in house]
    return merged + list(projects.values())


def get_reel(slug: str) -> dict:
    for reel in all_reels():
        if reel["slug"] == slug:
            return reel
    raise KeyError(slug)


def post_of(reel: dict) -> dict:
    """Post text: the project's own, else the house text for that slug."""
    base = dict(POSTS.get(reel["slug"], {}))
    base.update(SHORT.get(reel["slug"], {}))
    base.update(reel.get("posts") or {})
    return base


def plan_json() -> Path:
    reels = all_reels()
    data = [{"slug": r["slug"], "beats": r["beats"]} for r in reels]
    from studio.config import PLAN as dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    for reel in reels:
        for beat in reel["beats"]:
            assert_copy(beat["ja"])
            assert_copy(beat["en"])
    return dest


def off_site(src: Path) -> bool:
    """True unless the file's GPS, its folder's, its event's, or its event's name places it at the ranch."""
    from studio.db import connect
    from studio.library import event_dir, event_of, place_from

    def gps(prefix: str, direct: bool) -> tuple[int, int]:
        sql = "SELECT SUM(near_ranch = 1) AS near, SUM(near_ranch = 0) AS far FROM assets WHERE lower(path) LIKE ?"
        args = [prefix.lower() + "\\%"]
        if direct:
            sql += " AND lower(path) NOT LIKE ?"
            args.append(prefix.lower() + "\\%\\%")
        r = con.execute(sql, args).fetchone()
        return (r["near"] or 0), (r["far"] or 0)

    with connect() as con:
        row = con.execute("SELECT near_ranch, captured_at FROM assets WHERE path = ?", (str(src),)).fetchone()
        event = event_dir(src)
        place = place_from(
            row["near_ranch"] if row else None, gps(str(src.parent), True), gps(event, False), Path(event).name,
            captured=row["captured_at"] if row else None, event_date=event_of(src)[1],
        )
    if not place.startswith("ranch") and (row is None or row["near_ranch"] != 0):
        from studio.config import trusted_folder

        if trusted_folder(src):
            return False
    return not place.startswith("ranch")


from studio.media import VIDEO as VIDEO_EXT  # noqa: E402


def resolve(rel: str) -> Path:
    """A source path under the Drive media root; falls back to a search in its folder."""
    if str(rel).startswith(("\\\\", "//")):
        # A network share is never footage: only looking at \\host\share makes Windows sign in to that host with the
        # owner's account (security review 13 Nov; imported project files are filtered too, server/trust.mjs strayPath).
        raise FileNotFoundError(rel)
    path = SOURCE / rel
    if path.exists():
        return path
    folder = (SOURCE / rel).parent
    hits = list(folder.rglob(Path(rel).name)) if folder.exists() else []
    if not hits:
        raise FileNotFoundError(path)
    return hits[0]


# Length per cut (shared/spec.json "variants"): the short loop stays 8-25 s; the long explainer for
# LinkedIn and Facebook is 30-60 s.
LENGTH_RULE = {None: (8, 25), "b-explainer": (30, 60)}


def check_reel(reel: dict) -> list[str]:
    """Editorial rules the research set. Returns problems; empty means the reel may render."""
    problems = []
    names = [Path(s["src"]).name.lower() for s in reel["shots"]]
    if len(set(names)) != len(names):
        problems.append("a source file is used twice")
    photos = [s for s in reel["shots"] if Path(s["src"]).suffix.lower() in PHOTO_EXT]
    if len(photos) > 0.3 * len(reel["shots"]):
        problems.append(f"too many photos: {len(photos)} of {len(reel['shots'])} (keep video the main track)")
    for shot in reel["shots"]:
        ext = Path(shot["src"]).suffix.lower()
        if ext not in VIDEO_EXT | PHOTO_EXT:
            problems.append(f"not video or photo: {shot['src']}")
        if ext in PHOTO_EXT and shot["sec"] > 2.0:
            problems.append(f"photo held too long: {shot['src']} {shot['sec']}")
        if abs(shot["sec"] / GRID - round(shot["sec"] / GRID)) > 1e-6:
            problems.append(f"off the {GRID}s grid: {shot['src']} {shot['sec']}")
        if shot["sec"] > 4.0:
            problems.append(f"shot too long: {shot['src']} {shot['sec']}")
    total = sum(s["sec"] for s in reel["shots"])
    lo, hi = LENGTH_RULE.get(reel.get("variant"), LENGTH_RULE[None])
    if not lo <= total <= hi:
        problems.append(f"length {total}s outside {lo}-{hi} s")
    end = max(b["endSec"] for b in reel["beats"])
    if abs(end - total) > 0.05:
        problems.append(f"words end at {end}s but picture at {total}s")
    hook = next((b for b in reel["beats"] if b["kind"] == "hook"), None)
    if not hook or hook["startSec"] > 0.5:
        problems.append("no hook in the first half second")
    from studio.layers import check as check_layers

    return problems + check_layers(reel)


def _shots(reel: dict) -> tuple[list[dict], list[dict], list[dict]]:
    from studio.pick import best_window, faces_at

    problems = check_reel(reel)
    if problems:
        raise RuntimeError(f"{reel['slug']}: " + "; ".join(problems))
    tall, wide, meta, plans = [], [], [], []
    mezz = ROOT / "public" / "mezz" / reel["slug"]
    cache_path = mezz / "picks.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    for i, shot in enumerate(reel["shots"]):
        src = resolve(shot["src"])
        if off_site(src):
            raise RuntimeError(f"location gate: nothing places {src} at the ranch (GPS, folder or event)")
        if is_output(src):
            raise RuntimeError(f"source gate: {src} is a finished edit, not footage")
        key = f"{shot['src']}|{shot['sec']}|{shot.get('start')}"
        is_photo = src.suffix.lower() in PHOTO_EXT
        if key not in cache:
            if is_photo:
                pick = {"start": 0.0, "score": None, "method": "photo"}
            elif shot.get("start") is not None:
                pick = {"start": shot["start"], "score": None, "method": "pinned"}
            else:
                pick = best_window(src, shot["sec"], shot.get("speed", 1.0))
            pick["faces"] = faces_at(src, pick["start"], shot["sec"])
            cache[key] = pick
            mezz.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        pick = cache[key]
        if "is360" not in pick:
            pick["is360"] = is_360(src)
            cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        move = None
        if pick["is360"]:
            move = tuple(shot["move"]) if shot.get("move") else move_for(i, "photo" if is_photo else "video", len(reel["shots"]))
        # An AI-made clip of this shot (studio.ai: slow motion, sharpened, living photo) is graded in place of the
        # source window. The gates above still judge the original footage. Without one, nothing below changes.
        enh = shot.get("ai_clip") or None
        if enh and not Path(str(enh.get("file", ""))).exists():
            raise RuntimeError(f"{reel['slug']}: the AI clip for shot {i + 1} is missing ({enh.get('file')}); run the AI tool again or remove ai_clip from the project")
        plans.append({"i": i, "shot": shot, "src": src, "key": key, "pick": pick, "move": move, "enh": enh, "photo": is_photo})
    looks = shot_looks(reel, plans)
    from studio.typekits import grade_filter

    grade = grade_filter(reel.get("grade"))  # the reel's grade, laid with its colour match before the house look
    for plan, (color, trf, color_meta, stab_meta) in zip(plans, looks):
        color = ",".join(x for x in (color, grade) if x)
        i, shot, src, key, pick, move, enh, is_photo = (plan[k] for k in ("i", "shot", "src", "key", "pick", "move", "enh", "photo"))
        for size, bucket, tag in (((1080, 1920), tall, "t"), ((1920, 1080), wide, "w")):
            step = i * 2 + (0 if tag == "t" else 1) + 1
            print(f"PROGRESS {step}/{len(reel['shots']) * 2} grading {src.name}", flush=True)
            out = mezz / f"{i:02d}_{tag}.mp4"
            stale = not out.exists() or out.stat().st_mtime < Path(__file__).with_name("shot.py").stat().st_mtime
            stamp = out.with_suffix(".key")
            mark = f"{key}|{pick['start']}|blur={int(bool(reel.get('blurFaces')))}|move={move}"
            if enh:
                mark += f"|ai={enh.get('tool')}:{enh['file']}:{enh.get('start', 0.0)}:{enh.get('speed', 1.0)}"
            if color:
                mark += f"|color={color}"
            if trf:
                mark += f"|stab={trf.name}"
            if stale or not stamp.exists() or stamp.read_text(encoding="utf-8") != mark:
                if enh:
                    render_shot(Path(enh["file"]), float(enh.get("start", 0.0)), shot["sec"], out, size, pan=shot.get("pan"),
                                speed=float(enh.get("speed", 1.0)), blur=bool(reel.get("blurFaces")), move=None, color=color)
                else:
                    render_shot(src, pick["start"], shot["sec"], out, size, pan=shot.get("pan"), speed=shot.get("speed", 1.0), blur=bool(reel.get("blurFaces")), move=move,
                                color=color, stab=trf)
                stamp.write_text(mark, encoding="utf-8")
            # A 360 shot already moves its own camera; Remotion's push-in would fight it. A living photo moves too.
            push = 0.0 if move else (0.09 if is_photo and not enh else 0.04)
            bucket.append({"src": f"mezz/{reel['slug']}/{out.name}", "durationSec": shot["sec"], "push": push})
        meta.append({"i": i, "src": src, "rel": shot["src"], "sec": shot["sec"], "role": shot.get("role", ""), **pick, "color": color_meta, "stab": stab_meta})
    drop_stale_shots(mezz, len(reel["shots"]))
    return tall, wide, meta


def _device(src: Path) -> str | None:
    """The catalog's device for a source (dji, phone, insta360, ...), None when it is not catalogued."""
    from studio.db import connect

    try:
        with connect() as con:
            row = con.execute("SELECT device FROM assets WHERE path = ?", (str(src),)).fetchone()
        return row["device"] if row else None
    except Exception:
        return None


def shot_looks(reel: dict, plans: list[dict]) -> list[tuple[str, Path | None, dict, dict]]:
    """Colour match and stabilisation for every shot of a reel, decided before any shot is rendered.

    Project fields:
      colorMatch  true (default) | false. On: each shot's window is measured (Lab a*/b* mean and spread, luma, from
                  3 frames), the reel's target is the median over its day, non-360 shots, and each such shot gets a
                  colorchannelmixer step before the look grade that moves its cast half way to the target (each
                  channel gain within +-8 %, luma within +-6 %). Night and 360 shots are left alone. false: the
                  filter chain is exactly the one before colour match existed.
      stabilize   "auto" (default) | "off" | "on". auto: a handheld clip whose measured shake (shot.shake_of) reaches
                  shot.SHAKE_AUTO gets two-pass vidstab; on: every eligible clip; off: none. Drone (DJI), 360,
                  photo and AI clips are never stabilised.

    Returns per shot (colour filter or "", vidstab transforms or None, manifest "color", manifest "stab")."""
    from concurrent.futures import ThreadPoolExecutor

    from studio.shot import (NIGHT_LUMA, SHAKE_AUTO, color_correction, has_vidstab, is_drone, match_target, probe_window, stab_decision,
                             stab_transforms)

    color_on = reel.get("colorMatch", True) is not False
    mode = str(reel.get("stabilize") or "auto").lower()
    mode = mode if mode in ("auto", "off", "on") else "auto"

    def window(p: dict) -> tuple[Path, float, float]:
        shot, enh = p["shot"], p["enh"]
        if enh:
            return Path(enh["file"]), float(enh.get("start", 0.0)), shot["sec"] * float(enh.get("speed", 1.0))
        if p["photo"]:
            return p["src"], 0.0, shot["sec"]
        return p["src"], float(p["pick"]["start"]), shot["sec"] * float(shot.get("speed", 1.0))

    vidstab = has_vidstab() if mode != "off" else True

    def eligible(p: dict) -> tuple[bool, str]:
        return stab_decision(mode if mode == "off" else "on", None, photo=p["photo"], is360=bool(p["pick"].get("is360")),
                             drone=is_drone(p["src"], _device(p["src"])), ai=bool(p["enh"]), vidstab=vidstab)

    gates = [eligible(p) for p in plans]
    need = [color_on or (mode == "auto" and ok) for p, (ok, _) in zip(plans, gates)]

    def probe(k: int) -> dict:
        if not need[k]:
            return {}
        src, start, length = window(plans[k])
        return probe_window(src, start, length, photo=plans[k]["photo"] and not plans[k]["enh"])

    with ThreadPoolExecutor(max_workers=4) as pool:
        probes = list(pool.map(probe, range(len(plans))))
    stats = [(pr or {}).get("color") for pr in probes]
    night = [bool(s) and s["luma"] < NIGHT_LUMA for s in stats]
    part = [color_on and bool(s) and not n and not p["pick"].get("is360") for p, s, n in zip(plans, stats, night)]
    target = match_target([s for s, ok in zip(stats, part) if ok]) if color_on else None
    out = []
    for k, p in enumerate(plans):
        pr = probes[k] or {}
        if not color_on:
            color_meta = {"on": False, "reason": "colorMatch off"}
            filt = ""
        elif not stats[k]:
            color_meta = {"on": False, "reason": "not measured" + (f": {pr['error']}" if pr.get("error") else "")}
            filt = ""
        elif p["pick"].get("is360") or night[k]:
            color_meta = {"on": False, "reason": "360" if p["pick"].get("is360") else "night", "stats": stats[k]}
            filt = ""
        else:
            corr = color_correction(stats[k], target)
            filt = corr["filter"]
            color_meta = {"on": bool(filt), "reason": "matched" if filt else "already at the target", "stats": stats[k], "target": target,
                          "gains": corr["gains"], "luma": corr["luma"], "filter": filt}
        ok, why = gates[k]
        shake = pr.get("shake")
        if ok and mode == "auto":
            ok, why = stab_decision("auto", shake)
        stab_meta = {"mode": mode, "shake": shake, "threshold": SHAKE_AUTO, "on": False, "reason": why}
        trf = None
        if ok:
            import time

            t0 = time.monotonic()
            try:
                trf = stab_transforms(*window(p))
                stab_meta.update(on=True, detectSec=round(time.monotonic() - t0, 2))
            except Exception as exc:  # stabilising never fails a render: the shot goes out as shot
                stab_meta["reason"] = f"vidstab failed, left as shot: {str(exc)[-200:]}"
        print(f"LOOK shot {k + 1}: colour {color_meta['reason']}{' ' + filt if filt else ''}; stabilise {stab_meta['on']} ({stab_meta['reason']})", flush=True)
        out.append((filt, trf, color_meta, stab_meta))
    return out


def drop_stale_shots(mezz: Path, shots: int) -> list[str]:
    """Remove numbered shot clips (NN_t.mp4 / NN_w.mp4) past the reel's last shot, left by a longer earlier cut. Other
    files in the folder (the V2 layer clips L00_t.mp4 from studio.layers, picks.json, .key stamps) are not shots and
    stay; a layer clip's name used to stop every re-render of a layered reel ("invalid literal for int(): 'L0'")."""
    gone = []
    for f in mezz.glob("*_[tw].mp4"):
        head = f.name.split("_", 1)[0]
        if head.isdigit() and int(head) >= shots:
            f.unlink()
            gone.append(f.name)
    return gone


def _bed(reel: dict, seconds: float) -> dict | None:
    bed = reel.get("bed")
    if not bed:
        return None
    src = resolve(bed["src"])
    dest = ROOT / "public" / "mezz" / reel["slug"] / "bed.m4a"
    subprocess.run(
        [str(ffmpeg_bin()), "-y", "-ss", f"{bed['start']:.2f}", "-t", f"{seconds + 0.5:.2f}", "-i", str(src), "-vn",
         "-af", "afade=t=in:d=0.4,highpass=f=60,loudnorm=I=-24:TP=-3", "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "160k", str(dest)],
        check=True, capture_output=True, timeout=180,
    )
    return {"src": f"mezz/{reel['slug']}/bed.m4a", "volume": bed.get("volume", 0.5), "from": str(src)}


def _fit(text: str, limit: int) -> str:
    """Cut whole lines off the first part (never the link on the last line) until the text fits."""
    if len(text) <= limit:
        return text
    *body, tail = text.split("\n")
    head = "\n".join(body)
    room = limit - len(tail) - 2
    return (head[: max(0, room)].rstrip() + "…\n" + tail) if room > 0 else tail[:limit]


# Words people type into TikTok search for a place like this (TikTok reads the caption for search).
SEARCH_WORDS_JA = "群馬 キャンプ場・車中泊・嬬恋 絶景"


def _brand_handle() -> str:
    """The account handle under the name on the end card: @tsumagoicamp in the ranch workspace, else the project's own."""
    from studio.brand import brand

    return brand()["handle"]


def file_prefix() -> str:
    """Delivered files start with whose they are: tsumagoi_ in the ranch workspace, else the project's name."""
    if RANCH:
        return "tsumagoi"
    import re
    import unicodedata

    from studio.brand import brand

    name = unicodedata.normalize("NFKD", brand()["name"]).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", name).strip("-")[:30] or "reel"


def _own_post_text(reel: dict, channel: str) -> str:
    """Post text for a project made in the studio: its own words, its link and hashtags, each network's shape.
    Nothing from the ranch (no prices, no 「嬬恋牧場」で検索, no ranch link)."""
    from studio.brand import brand

    b = brand()
    post = dict(reel.get("posts") or {})
    ja = (post.get("ja") or reel.get("title_ja") or "").strip()
    en = (post.get("en") or "").strip()
    x = (post.get("x") or ja.split("\n")[0]).strip()
    link = f"{b['link']}{'&' if '?' in b['link'] else '?'}utm_source={channel}&utm_medium=social" if b["link"] else ""
    tags = reel.get("tags") or b["tags"]
    words = "\n\n".join(p for p in (ja, en) if p)

    def lines(*parts: str) -> str:
        return "\n\n".join(p for p in parts if p) + "\n"

    if channel == "xiaohongshu" and not post.get("zh"):
        return "【下書きなし】この動画の中国語の文はまだありません。ネイティブの方に書いてもらってください。\n"
    if channel in ("instagram", "facebook", "tiktok"):
        # Links in these captions do not open: the profile link or Book button carries it.
        return lines(words, " ".join(tags[:5]))
    if channel == "threads":
        return lines(ja, en, *(["――― 最初の返信に貼るリンク / first reply ―――\n" + link] if link else []))
    if channel in ("line-voom", "line-oa", "gbp"):
        return lines(ja, link)
    if channel == "pinterest":
        return lines(f"TITLE: {reel.get('yt_title') or x}", f"DESCRIPTION:\n{words}", *([f"LINK: {link}"] if link else []))
    if channel in ("bluesky", "x"):
        return _fit("\n".join(p for p in (x, link) if p), 300 if channel == "bluesky" else 280) + "\n"
    if channel in ("youtube-shorts", "youtube"):
        return lines(f"TITLE: {reel.get('yt_title') or x}", f"DESCRIPTION:\n{ja}", link, " ".join(tags[:3]))
    if channel == "linkedin":
        return lines(post.get("linkedin") or words, link, " ".join(tags[:3]))
    return lines(words, link, " ".join(tags[:5]))


def _post_text(reel: dict, channel: str) -> str:
    if not RANCH:
        return _own_post_text(reel, channel)
    post = post_of(reel)
    SHORT_ = {reel["slug"]: {"x": post.get("x", post["ja"].split("\n")[0]), "zh": post.get("zh", "")}}
    link = f"{SITE}{post['path']}?utm_source={channel}&utm_medium=social"
    tags = " ".join(reel["tags"])
    if channel == "xiaohongshu" and not SHORT_[reel["slug"]]["zh"]:
        return "【下書きなし】この動画の中国語の文はまだありません。ネイティブの方に書いてもらってください。\n"
    SHORT = SHORT_  # noqa: N806  (local view of this reel's short lines)
    # Each network gets its own text (docs/research/2026-11-08-networks-variants.md §3):
    if channel == "instagram":
        return f"{post['ja']}\n\n{post['en']}\n\n{post['price_ja']}\nプロフィールのリンクから。\n\n{tags}\n"
    if channel == "tiktok":
        # A TikTok business account shows no bio link until it is registered or verified: send people to search.
        # TikTok is search-led: plain search words in the caption, 3-5 tags (shared/playbooks.json "tiktok").
        return (f"{post['ja']}\n\n{post['en']}\n\n{post['price_ja']}\n「嬬恋牧場」で検索。\n"
                f"{SEARCH_WORDS_JA}\n\n{' '.join(reel['tags'][:5])}\n")
    if channel == "threads":
        # Threads ranks by replies: the text is the hook and ends on a question; the link goes in the first reply.
        # One topic tag per post is what Threads reads (shared/playbooks.json "threads").
        return (f"{post['ja']}\n\nこの景色のなかで、まず何をしますか？\n\n{post['en']}\n\n#キャンプ\n\n"
                f"――― 最初の返信に貼るリンク / first reply ―――\n{link}\n")
    if channel == "line-voom":
        # LINE VOOM: no other networks' IDs; the first URL in the text becomes one link card.
        return f"{post['ja']}\n\n{post['price_ja']}\n{link}\n"
    if channel == "line-oa":
        # A message to people who already follow the account: short, one link.
        return f"{post['ja']}\n\n{link}\n"
    if channel == "pinterest":
        # A Pin: a searchable title, a description, and the link the Pin opens.
        return f"TITLE: {reel['yt_title']}\n\nDESCRIPTION:\n{post['ja']}\n\n{post['en']}\n\nLINK: {link}\n"
    if channel == "bluesky":
        # Bluesky: 300 characters at most, link included.
        return _fit(f"{SHORT[reel['slug']]['x']}\n{link}", 300) + "\n"
    if channel == "gbp":
        # Google Business Profile post: short, the 予約 button carries the link.
        return f"{post['ja']}\n\n{post['price_ja']}\n\nボタン：予約 → {link}\n"
    if channel == "x":
        return f"{SHORT[reel['slug']]['x']}\n{link}\n#嬬恋 #tsumagoicamp\n"
    if channel == "xiaohongshu":
        zh_title = SHORT[reel["slug"]]["zh"].split("\n")[0]  # rednote titles hold 20 characters
        return (
            "【下書き・投稿前にネイティブの確認が必要】リンク・QRコード・LINE/WeChat ID は入れないこと。\n"
            "画面の文字は日本語・英語のまま。\n\n"
            + (f"【タイトルが{len(zh_title)}字です。20字以内に縮めてください】\n" if len(zh_title) > 20 else "")
            + "TITLE: " + zh_title + "\n\n"
            + SHORT[reel["slug"]]["zh"] + "\n\n" + ZH_TAGS + "\n"
        )
    if channel == "facebook":
        # Meta: captions with no link and at most five hashtags do best; the Page's Book button carries the link.
        return f"{post['ja']}\n\n{post['en']}\n\n{post['price_ja']}\nご予約は「嬬恋牧場」で検索、またはページのリンクから。\n\n{' '.join(reel['tags'][:5])}\n"
    if channel == "youtube-shorts":
        # YouTube shows the first three hashtags above the title; over 60 voids them all (playbook "youtube-shorts").
        return f"TITLE: {reel['yt_title']}\n\nDESCRIPTION:\n{post['ja']}\n\n{post['price_ja']}\n{link}\n\n{' '.join(reel['tags'][:3])}\n"
    if channel == "linkedin":
        return f"{post['linkedin']}\n\n{SITE}events?utm_source=linkedin&utm_medium=social\n\n#嬬恋 #オフサイト\n"
    if channel == "kensaurus":
        return (
            f"{post['en']}\n\nTsumagoi Work&Camp, Gunma. Cut on a local pipeline: ffmpeg grade, "
            f"Remotion type, footage only from the ranch.\n{SITE}?utm_source=kensaurus&utm_medium=social\n"
        )
    if channel == "zenn":
        return (
            f"# {reel['title_ja']}：牧場の素材だけで、ローカルでリールを作る\n\n"
            "下書きです。公開前に本人が確認します。\n\n"
            "- 素材はGoogleドライブの写真・動画。GPSで牧場から2km以内のものだけを使う（0,0の仮の位置は不明として扱う）\n"
            "- 色はffmpeg：クリップごとにレベルを測って揃え、Sカーブ・ハイライトをわずかに暖色に・ビネット・粒子\n"
            "- 文字はRemotion：縦書きの明朝（Shippori Mincho）と英語のイタリック（Cormorant）。セーフゾーンはテストで固定\n"
            "- 画面の言葉はサイトのSSOT（reversal-lines.ts / place-line.ts）からだけ。値段と事実の誤りはfact guardで止める\n"
            "- 9:16・4:5・16:9を同じ構成から書き出し、チャンネルごとにフォルダを分ける\n\n"
            f"{SITE}?utm_source=zenn&utm_medium=social\n"
        )
    if channel == "note":
        return f"# {reel['title_ja']}\n\n下書きです。公開前に本人が確認します。\n\n{post['ja']}\n\n{post['price_ja']}\n{SITE}{post['path']}?utm_source=note&utm_medium=social\n"
    raise KeyError(channel)


def _cover(video: Path, t: float, dest: Path, size: tuple[int, int] | None = None) -> Path:
    vf = ["-vf", f"scale={size[0]}:{size[1]}:force_original_aspect_ratio=increase,crop={size[0]}:{size[1]}"] if size else []
    subprocess.run([str(ffmpeg_bin()), "-y", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", *vf, "-update", "1", "-q:v", "2", str(dest)], check=True, capture_output=True, timeout=120)
    return dest


def set_cover(slug: str, t: float) -> dict:
    """Every network's cover from one moment of the reel, cut from that network's own master.
    The time is kept in the project, so the next render packages the same cover."""
    from studio.projects import load, save

    out = DATA / "renders" / f"story-{slug}"
    masters = {a: out / f"{slug}_{a}.mp4" for a in ("9x16", "4x5", "16x9")}
    length = float(json.loads((out / "manifest.json").read_text(encoding="utf-8")).get("durationSec", 0) or 0)
    if not 0 <= t <= max(0.0, length - 0.05):
        raise ValueError(f"cover time must be inside the reel (0 to {length:.1f} s)")
    made = []
    for channel, spec in CHANNELS.items():
        folder = DRAFTS / slug / channel
        src = masters.get(spec["files"][0]["aspect"])
        if not folder.is_dir() or src is None or not src.exists():
            continue
        cw, ch = spec["cover"]
        for old in folder.glob("cover*.jpg"):
            old.unlink()
        _cover(src, t, folder / f"cover_{cw}x{ch}.jpg", (cw, ch))
        made.append(channel)
    _cover(masters["9x16"], t, out / "cover.jpg")
    project = load(slug)
    if project is not None:
        project["coverAt"] = round(t, 2)
        save(project)
    return {"slug": slug, "at": round(t, 2), "channels": made, "preview": str(out / "cover.jpg")}


def side_for(cx: float) -> str | None:
    """Words go where the picture is quiet: detail on the right puts the line on the left."""
    if cx > 0.56:
        return "left"
    if cx < 0.44:
        return "right"
    return None


def place_words(reel: dict) -> list[dict]:
    """Beats with a `side` for each line, measured on the graded 9:16 shot it sits on."""
    from studio.shot import measure

    mezz = ROOT / "public" / "mezz" / reel["slug"]
    starts, t = [], 0.0
    for s in reel["shots"]:
        starts.append(t)
        t += s["sec"]
    out = []
    for b in reel["beats"]:
        b = dict(b)
        b.pop("side", None)
        if b["kind"] == "line":
            at = b["startSec"] + 0.4
            i = max(k for k, st in enumerate(starts) if st <= at)
            clip = mezz / f"{i:02d}_t.mp4"
            if clip.exists():
                try:
                    side = side_for(measure(clip, min(at - starts[i], reel["shots"][i]["sec"] - 0.1)).cx)
                except RuntimeError:
                    side = None
                if side:
                    b["side"] = side
        out.append(b)
    return out


def stage(n: int, label: str) -> None:
    """Progress line the editor's dashboard reads: STAGE n/STAGES label."""
    print(f"STAGE {n}/{STAGES} {label}", flush=True)


STAGES = 7



def behind_layer(reel: dict, look: str | None) -> str | None:
    """The opening shot's cut-out (shots[0].ai_behind), copied into public/mezz for the render, when it still belongs to
    that shot (same source and length) and the look moves the shot the plain way. Otherwise None: no stale cut-out."""
    shots = reel.get("shots") or []
    b = (shots[0].get("ai_behind") if shots else None) or {}
    if not b.get("file") or look not in (None, "ember") or b.get("src") != shots[0].get("src") or float(b.get("sec", 0)) != float(shots[0]["sec"]):
        return None
    src = Path(b["file"])
    if not src.exists():
        return None
    shot = ROOT / "public" / "mezz" / reel["slug"] / "00_t.mp4"
    if b.get("stamp"):
        try:
            now = f"{shot.stat().st_size}-{int(shot.stat().st_mtime)}"
        except OSError:
            now = "none"
        if now != b["stamp"]:
            return None  # the opening shot was rendered again differently: the cut-out would sit off the subject
    dest = ROOT / "public" / "mezz" / reel["slug"] / "00_fg.webm"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists() or dest.stat().st_size != src.stat().st_size:
        shutil.copyfile(src, dest)
    return f"mezz/{reel['slug']}/00_fg.webm"


def foley_track(reel: dict, gain: float = 0.8) -> list[dict]:
    """The natural sound made for silent shots (shots[i].ai_foley), placed where each shot starts on the timeline."""
    out, at = [], 0.0
    for s in reel.get("shots", []):
        f = s.get("ai_foley")
        if f and f.get("file"):
            out.append({"file": f["file"], "at": round(at, 3), "seconds": float(min(float(f.get("seconds") or s["sec"]), float(s["sec"]))), "gain": gain})
        at += float(s["sec"])
    return out


def spoken_spans(beats: list[dict], voice: dict | None, on: bool = True) -> list[dict]:
    """Word-by-word captions: each hook or line the voice reads gets `spoken` {from, to} in seconds, the span its
    clip plays (src/Story.tsx lights the words up across it, shared/spoken.mjs). The voice reads the line as shown,
    so it is matched by its words; a line the voice does not read, or `on` False (the reel's "spokenWords"), has none."""
    lines = [v for v in ((voice or {}).get("lines") or []) if v.get("text")]
    if not on or not lines:
        return beats
    said = {str(v["text"]): v for v in lines}
    out = []
    for b in beats:
        v = said.get(str(b.get("ja", "")).replace("\n", "")) if b.get("kind") in ("hook", "line") else None
        if v:
            tempo = float(v.get("tempo") or 1.0) or 1.0
            start = float(v.get("at", b.get("startSec", 0.0)))
            b = {**b, "spoken": {"from": round(start, 3), "to": round(start + float(v.get("seconds") or 0.0) / tempo, 3)}}
        out.append(b)
    return out


def build(slug: str, reel: dict | None = None, out: Path | None = None, candidate: bool = False) -> dict:
    """Render a reel. candidate (studio.versions): `reel` is a new cut of it, rendered into `out`, at 9:16 only (the size
    that is compared and reviewed; the others are made when a person chooses it); the live reel, its approval and its
    files for each network are not touched."""
    sizes = ("9x16",) if candidate else ("9x16", "4x5", "16x9")
    reel = reel or get_reel(slug)
    plan_json()
    stage(1, "grading the best moment of each clip")
    tall, wide, meta = _shots(reel)
    from studio.layers import render as render_layers

    # The second picture track (V2): cutaways and insets over the running shots (studio.layers).
    ltall, lwide, lmeta = render_layers(reel, ROOT / "public" / "mezz" / reel["slug"], bool(reel.get("blurFaces")))
    total = sum(s["sec"] for s in reel["shots"])
    bed = _bed(reel, total)
    beats = spoken_spans(place_words(reel), reel.get("voice"), reel.get("spokenWords", True))
    stage_ = staging(reel)  # look, recipe, kicker, loop (src/looks.tsx); the theme's when the project has none
    if stage_["recipe"] == "countdown" and not any(b.get("n") for b in beats):
        beats = number_lines(beats)
    for k, mark in enumerate(shot_marks(reel, mark_kind(stage_))):
        if mark:
            for bucket in (tall, wide):
                bucket[k]["label"], bucket[k]["labelEn"] = mark
    if stage_["look"] == "split":
        for k, upright in enumerate(portrait_shots(reel)):
            if upright:
                tall[k]["portrait"] = wide[k]["portrait"] = True
    fg = behind_layer(reel, stage_.get("look"))
    if fg and tall:
        tall[0]["fg"] = fg  # the headline goes behind the opening shot's subject (src/Story.tsx Behind; tall sizes only)
    props = {"shots9x16": tall, "shots16x9": wide, "layers9x16": ltall, "layers16x9": lwide, "beats": beats, "handle": _brand_handle(), "bed": bed, "style": reel.get("style", "column"), **stage_,
             **{k: reel[k] for k in ("typeKit", "palette", "motion") if reel.get(k)}}
    out = out or DATA / "renders" / f"story-{slug}"
    out.mkdir(parents=True, exist_ok=True)
    props_path = out / "props.json"
    props_path.write_text(json.dumps(props, ensure_ascii=False, indent=2), encoding="utf-8")
    for k, aspect in enumerate(sizes):
        stage(2 + k, f"rendering words and picture at {aspect.replace('x', ':')}")
        raw = out / f"raw_{aspect}.mp4"
        if not _remotion(f"Story-{aspect}", props_path, raw):
            raise RuntimeError(f"remotion failed for {slug} {aspect}; see {raw.with_suffix('.log')}")
        _loud(raw, out / f"{slug}_{aspect}_clean.mp4", None)
    stage(5, "mixing music and sound effects")
    masters, audio = _score(reel, out, total, sizes)
    report = verify_master(masters["9x16"])
    gate = _qa(masters, audio)
    if not candidate:
        stage(6, "cutting a copy for every network")
        package(slug)
    stage(7, "writing the review sheet")
    end_t = next(b for b in reel["beats"] if b["kind"] == "end")["startSec"] + 1.2
    _cover(masters["9x16"], end_t, out / "end.jpg")
    _cover(masters["9x16"], 2.4, out / "hook.jpg")
    manifest = write_manifest({**reel, "beats": beats}, meta, masters, bed, report, audio, lmeta, qa=gate, out=out)
    if not candidate:
        _register(reel, masters, out, manifest)
    return {"slug": slug, **report, "faces": manifest["stats"]["faces"], "lufs": manifest["stats"]["lufs"], "drafts": str(DRAFTS / slug),
            "qa": {k: v["ok"] for k, v in gate.items()}}


def _qa(masters: dict[str, Path], audio: dict | None) -> dict:
    """The quality gate (studio.verify.qa) on every aspect's master. It only flags: a "bad" check never stops or
    removes a render, and a failure of the gate itself is recorded, not raised."""
    from studio.verify import qa_all

    gate = qa_all(masters, music=bool((audio or {}).get("music")))
    for aspect, res in gate.items():
        flagged = [f"{c['id']} {c['level']}: {c['found']}" for c in res["checks"] if c["level"] != "ok"]
        print(f"QA {aspect} {'ok' if res['ok'] else 'BAD'}" + (" | " + " | ".join(flagged) if flagged else ""), flush=True)
    return gate


def _score(reel: dict, out: Path, total: float, sizes: tuple = ("9x16", "4x5", "16x9")) -> tuple[dict[str, Path], dict]:
    """Scored masters (clip sound + music + effects) from the clean ones; records what was used."""
    from studio.sound import choose_music, mix, sfx_plan

    music = choose_music(reel, total)
    sfx = sfx_plan(reel)
    masters, audio = {}, {}
    for aspect in sizes:
        clean = out / f"{reel['slug']}_{aspect}_clean.mp4"
        final = out / f"{reel['slug']}_{aspect}.mp4"
        audio = mix(clean, final, total, music, sfx, voice=reel.get("voice"), foley=foley_track(reel))
        masters[aspect] = final
    audio["clean"] = {a: str(out / f"{reel['slug']}_{a}_clean.mp4") for a in sizes}
    (out / "audio.json").write_text(json.dumps(audio, ensure_ascii=False, indent=2), encoding="utf-8")
    return masters, audio


def remix(slug: str) -> dict:
    """New music or effects only: re-mix the rendered picture, re-package, refresh the manifest.
    Seconds, not minutes. A changed reel goes back to 'rendered' for a fresh approval."""
    reel = get_reel(slug)
    out = DATA / "renders" / f"story-{slug}"
    total = sum(s["sec"] for s in reel["shots"])
    stage(5, "mixing music and sound effects")
    for aspect in ("9x16", "4x5", "16x9"):
        clean = out / f"{slug}_{aspect}_clean.mp4"
        if not clean.exists():
            raw = out / f"raw_{aspect}.mp4"
            if not raw.exists():
                raise FileNotFoundError(f"render {slug} first")
            _loud(raw, clean, None)
    masters, audio = _score(reel, out, total)
    stage(6, "cutting a copy for every network")
    package(slug)
    stage(7, "writing the review sheet")
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["audio"] = {"bed": manifest.get("audio", {}).get("bed"), "wave": str(_wave(masters["9x16"], out)), **audio}
    manifest["stats"]["lufs"] = _lufs(masters["9x16"])
    manifest["qa"] = _qa(masters, audio)
    manifest["channels"] = _channel_info(slug)
    manifest["outputs"] = {k: str(v) for k, v in masters.items()}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    _register(reel, masters, out, manifest)
    return {"slug": slug, "music": (audio.get("music") or {}).get("title"), "sfx": len(audio.get("sfx", [])), "lufs": manifest["stats"]["lufs"]}


def _register(reel: dict, masters: dict[str, Path], out: Path, manifest: dict) -> None:
    """A fresh render goes back to 'rendered': a person approves it again."""
    from datetime import datetime

    from studio.db import connect

    with connect() as con:
        con.execute(
            """INSERT INTO drafts (slug, recipe, edl_json, status, notes, cost, faces, consent, render_natural, render_scored, cover, caption_txt, created_at)
               VALUES (?, 'story', '{}', 'rendered', '', 0, ?, 0, ?, ?, ?, ?, ?)
               ON CONFLICT(slug) DO UPDATE SET status='rendered', faces=excluded.faces, consent=0,
                 render_natural=excluded.render_natural, render_scored=excluded.render_scored,
                 cover=excluded.cover, caption_txt=excluded.caption_txt""",
            (
                f"story-{reel['slug']}",
                int(manifest["stats"]["faces"] > 0 and not reel.get("blurFaces")),
                str(masters["9x16"]),
                str(masters["16x9"]),
                str(out / "hook.jpg"),
                str(DRAFTS / reel["slug"] / "instagram" / "post.txt"),
                datetime.now().isoformat(timespec="seconds"),
            ),
        )


def _probe(src: Path) -> dict:
    from studio.config import ffprobe_bin

    raw = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height,avg_frame_rate,color_transfer,pix_fmt:format=duration,size:format_tags=creation_time",
         "-of", "json", str(src)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    ).stdout
    data = json.loads(raw or "{}")
    s = (data.get("streams") or [{}])[0]
    f = data.get("format") or {}
    num, _, den = (s.get("avg_frame_rate") or "0/1").partition("/")
    return {
        "codec": s.get("codec_name"),
        "width": s.get("width"),
        "height": s.get("height"),
        "fps": round(float(num) / float(den), 2) if den and float(den) else None,
        "hdr": s.get("color_transfer") in ("arib-std-b67", "smpte2084"),
        "bitDepth": 10 if "10" in (s.get("pix_fmt") or "") else 8,
        "duration": round(float(f.get("duration") or 0), 2),
        "mb": round(int(f.get("size") or 0) / 1_000_000, 1),
        "created": (f.get("tags") or {}).get("creation_time"),
    }


def _lufs(video: Path) -> float | None:
    proc = subprocess.run([str(ffmpeg_bin()), "-i", str(video), "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    for line in reversed((proc.stderr or "").splitlines()):
        line = line.strip()
        if line.startswith("I:") and "LUFS" in line:
            return float(line.split()[1])
    return None


def _wave(master: Path, out: Path) -> Path:
    wave = out / "wave.png"
    subprocess.run(
        [str(ffmpeg_bin()), "-y", "-i", str(master), "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1600x90:colors=#9cb89f",
         "-frames:v", "1", "-update", "1", str(wave)],
        capture_output=True, timeout=120,
    )
    return wave


def _channel_info(slug: str) -> list[dict]:
    channels = []
    for cid, spec in CHANNELS.items():
        ch = DRAFTS / slug / cid
        if not ch.is_dir():
            continue
        files = [p.name for p in sorted(ch.iterdir()) if p.name != "desktop.ini"]
        videos = []
        for p in sorted(ch.glob("*.mp4")):
            info = _probe(p)
            videos.append({"file": p.name, "w": info["width"], "h": info["height"], "fps": info["fps"], "sec": info["duration"], "mb": info["mb"]})
        post = next((p for p in ch.iterdir() if p.name in ("post.txt", "post.md")), None)
        channels.append({
            "name": cid, "label": spec["name"], "who": channel_who(spec), "note": spec["note"], "maxSec": spec["maxSec"],
            "dir": str(ch), "files": files, "videos": videos,
            "post": post.read_text(encoding="utf-8") if post else "",
        })
    return channels


def write_manifest(reel: dict, meta: list[dict], masters: dict[str, Path], bed: dict | None, report: dict, audio: dict | None = None,
                   layers_meta: list[dict] | None = None, qa: dict | None = None, out: Path | None = None) -> dict:
    """Everything the editor page shows: sources, windows, grade proof, words, audio, outputs.

    Quality fields:
      qa                {aspect: {"ok": bool, "checks": [{"id", "level": "ok"|"warn"|"bad", "found", "fix"}], "measured": {...}}}
                        from studio.verify.qa, one entry per aspect ("9x16", "4x5", "16x9"). "bad" only flags the render.
      colorMatch        {"on": bool, "target": {L, a, b, aStd, bStd, luma} | None}
      stabilize         "auto" | "off" | "on" (the project's setting)
      shots[].color     {"on", "reason", "stats", "target", "gains": [r, g, b], "luma", "filter"} (shot_looks)
      shots[].stab      {"mode", "shake", "threshold", "on", "reason", "detectSec"?}"""
    import statistics

    from studio.db import connect
    from studio.media import haversine_km
    from studio.shot import before_after

    out = out or DATA / "renders" / f"story-{reel['slug']}"
    frames = out / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    shots = []
    t = 0.0
    for m in meta:
        src: Path = m["src"]
        with connect() as con:
            row = con.execute("SELECT device, captured_at, lat, lon, near_ranch FROM assets WHERE path = ?", (str(src),)).fetchone()
            folder = con.execute(
                "SELECT SUM(near_ranch = 1) AS near, SUM(near_ranch = 0) AS far, COUNT(*) AS n FROM assets WHERE path LIKE ?",
                (str(src.parent) + "%",),
            ).fetchone()
        info = _probe(src)
        mid = m["start"] + m["sec"] / 2
        thumb = frames / f"{m['i']:02d}_thumb.jpg"
        _cover(ROOT / "public" / "mezz" / reel["slug"] / f"{m['i']:02d}_t.mp4", m["sec"] / 2, thumb, (180, 320))
        proof = frames / f"{m['i']:02d}_grade.jpg"
        try:
            before_after(src, mid, proof, (540, 960))
        except RuntimeError:
            proof = None
        lat = row["lat"] if row else None
        lon = row["lon"] if row else None
        shots.append({
            "i": m["i"],
            "file": src.name,
            "folder": str(src.parent.relative_to(SOURCE)) if src.is_relative_to(SOURCE) else str(src.parent),
            "path": str(src),
            "role": m["role"],
            "device": (row["device"] if row else None) or "unknown",
            "captured": (row["captured_at"] if row else None) or info["created"],
            "gps": {
                "lat": lat, "lon": lon,
                "km": round(haversine_km(lat, lon), 2) if lat is not None and lon is not None and abs(lat) > 0.01 else None,
                "file": {1: "at the ranch", 0: "away"}.get(row["near_ranch"] if row else None, "no GPS in file"),
                "folder": f"{folder['near'] or 0} at the ranch / {folder['far'] or 0} away / {folder['n']} files",
            },
            "source": info,
            "in": round(m["start"], 2),
            "out": round(m["start"] + m["sec"], 2),
            "sec": m["sec"],
            "timelineStart": round(t, 2),
            "pick": {"method": m.get("method"), "score": m.get("score")},
            "faces": m.get("faces"),
            "thumb": str(thumb),
            "grade": str(proof) if proof else None,
            "color": m.get("color"),
            "stab": m.get("stab"),
        })
        t += m["sec"]
    lengths = [s["sec"] for s in shots]
    wave = _wave(masters["9x16"], out)
    channels = _channel_info(reel["slug"])
    manifest = {
        "slug": reel["slug"],
        "title": reel["title_ja"],
        "style": reel.get("style", "column"),
        **{k: v for k, v in staging(reel).items() if k in ("look", "recipe")},
        "season": reel.get("season"),
        "durationSec": round(t, 2),
        "outputs": {k: str(v) for k, v in masters.items()},
        "verify": report,
        "qa": qa,
        "colorMatch": {"on": reel.get("colorMatch", True) is not False,
                       "target": next((m["color"].get("target") for m in meta if (m.get("color") or {}).get("target")), None)},
        "stabilize": str(reel.get("stabilize") or "auto").lower(),
        "stats": {
            "shots": len(shots),
            "videoOnly": True,
            "uniqueSources": len({s["file"] for s in shots}) == len(shots),
            "avgShot": round(statistics.mean(lengths), 2),
            "shortest": min(lengths),
            "longest": max(lengths),
            "rhythmCv": round(statistics.pstdev(lengths) / statistics.mean(lengths), 2),
            "grid": f"{GRID}s (120 BPM)",
            "faces": max([(s["faces"] or 0) for s in shots] + [(x.get("faces") or 0) for x in layers_meta or []]),
            "layers": len(layers_meta or []),
            "blurFaces": bool(reel.get("blurFaces")),
            "lufs": _lufs(masters["9x16"]),
        },
        "beats": reel["beats"],
        "audio": {"bed": bed, "wave": str(wave), **(audio or {})},
        "shots": shots,
        "layers": [{"file": x["src"].name, "path": str(x["src"]), "kind": (reel.get("layers") or [])[k]["kind"], "at": (reel.get("layers") or [])[k]["at"],
                    "sec": x["sec"], "in": round(x["start"], 2), "faces": x.get("faces"), "role": x.get("role")} for k, x in enumerate(layers_meta or [])],
        "channels": channels,
        "rules": check_reel(reel),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def wants(reel: dict, spec: dict) -> bool:
    """Does this channel get files from this reel? Not when the owner switched it off, not for a channel
    that is filled by hand (stills, the long-form tour), and a long explainer only goes to the channels
    whose family is the explainer (LinkedIn, Facebook)."""
    if spec.get("off") or spec.get("manual") or spec.get("stillsOnly"):
        return False
    if reel.get("variant") == "b-explainer":
        return spec.get("variant") == "b-explainer"
    if spec.get("maxSec") and sum(s.get("sec", 0) for s in reel.get("shots", [])) > spec["maxSec"]:
        return False
    return True


def _held(fn, *args, tries: int = 6):
    """Drive for desktop (or a player showing the file) can hold a draft file for a few seconds while it syncs or reads
    it, and Windows then refuses to remove or replace it: try again, about 30 s in all (studio.held)."""
    from studio.held import held

    return held(fn, *args, tries=tries)


def _place(src: Path, dest: Path) -> None:
    """The same file for several networks: a hard link (no extra disk), a copy where links are not possible."""
    def put():
        try:
            os.link(src, dest)
        except PermissionError:
            raise
        except OSError:
            shutil.copy2(src, dest)

    _held(put)


def package(slug: str, only: list[str] | None = None) -> list[str]:
    """Copy the rendered masters into one Drive draft folder per channel, with cover and post."""
    reel = get_reel(slug)
    out = DATA / "renders" / f"story-{slug}"
    masters = {a: out / f"{slug}_{a}.mp4" for a in ("9x16", "4x5", "16x9")}
    missing = [str(p) for p in masters.values() if not p.exists()]
    if missing:
        raise FileNotFoundError(f"render first: {missing}")
    post = post_of(reel)
    for key in ("ja", "en", "x", "zh"):
        if post.get(key):
            assert_copy(post[key])
    audio_path = out / "audio.json"
    audio = json.loads(audio_path.read_text(encoding="utf-8")) if audio_path.exists() else {}
    hook_t = float(reel.get("coverAt", 2.4))
    made = []
    master_size = {"9x16": (1080, 1920), "4x5": (1080, 1350), "16x9": (1920, 1080)}
    for channel, spec in CHANNELS.items():
        if only and channel not in only:
            continue
        if not wants(reel, spec):
            continue
        folder = DRAFTS / slug / channel
        folder.mkdir(parents=True, exist_ok=True)
        from studio.held import remove

        try:
            for old in [*folder.glob("*.mp4"), *folder.glob("cover*.jpg")]:
                remove(old)  # a copy a page plays or Drive syncs is moved aside, never fails the build
        except PermissionError as err:
            # Drive for desktop can lock one file for good (12 Nov: not even readable). That network keeps its earlier
            # copy and the others are made; its post then shows in Needs a look if it cannot read the file.
            print(f"NOTE {channel}: the earlier copy could not be replaced ({err.strerror or err}); the other networks were made", flush=True)
            continue
        for f in spec["files"]:
            src = masters[f["aspect"]]
            dest = folder / f"{file_prefix()}_{slug}_{f['w']}x{f['h']}.mp4"
            if (f["w"], f["h"]) == master_size[f["aspect"]]:
                _place(src, dest)
            else:
                subprocess.run(
                    [str(ffmpeg_bin()), "-y", "-i", str(src), "-vf", f"scale={f['w']}:{f['h']}:flags=lanczos,setsar=1",
                     "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-r", str(CHANNEL_SPEC["fps"]), "-c:a", "copy", "-map_metadata", "-1", str(dest)],
                    check=True, capture_output=True, timeout=600,
                )
        clean = out / f"{slug}_9x16_clean.mp4"
        if channel in NO_MUSIC_COPY and clean.exists() and audio.get("music"):
            _place(clean, folder / f"{file_prefix()}_{slug}_1080x1920_no-music.mp4")
        cw, ch = spec["cover"]
        first = masters[spec["files"][0]["aspect"]]
        _cover(first, hook_t, folder / f"cover_{cw}x{ch}.jpg", (cw, ch))
        name = "post.md" if channel in ("zenn", "note") else "post.txt"
        (folder / name).write_text(_post_text(reel, channel), encoding="utf-8")
        if audio:
            from studio.sound import credits

            (folder / "credits.txt").write_text(credits(audio), encoding="utf-8")
        made.append(channel)
    # The studio shows files and post text from the manifest: keep it in step with what was just packaged.
    manifest_path = out / "manifest.json"
    if made and manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["channels"] = _channel_info(slug)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return made
