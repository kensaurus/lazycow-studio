"""
FILE: py/studio/service.py
PURPOSE: A long-lived helper for the editor, so CLIP loads once and searches are instant.
OVERVIEW: Reads one JSON request per line on stdin, writes one JSON reply per line.
          Commands: library, asset, ids, themes, assemble, save_project, project,
          overview (dashboard), review, audio_list, audio_fetch, autopilot, connections
          (list / connect / disconnect / start + finish a one-click sign-in / setup).
DEPENDENCIES: studio.library, studio.assemble, studio.projects, studio.reels
USAGE: started by server/review.mjs as `python -m studio service`
NOTES: Local only (stdin/stdout of a child process). Each request carries `_rid` (echoed in
       the reply) so a command's own `id` (an asset id) is never overwritten. Errors come
       back as {"error": ..., with file:line}.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def _asset(asset_id: int) -> dict:
    from studio.db import connect
    from studio.library import VOCAB, _migrate, usage

    with connect() as con:
        _migrate(con)
        row = con.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if row is None:
            raise KeyError(f"no asset {asset_id}")
        a = dict(row)
        lib = con.execute("SELECT * FROM library WHERE asset_id = ?", (asset_id,)).fetchone()
    lib = dict(lib) if lib else {}
    tags = json.loads(lib.get("tags") or "[]") if lib else []
    return {
        "id": a["id"], "path": a["path"], "file": Path(a["path"]).name, "kind": a["kind"],
        "duration": a["duration"], "width": a["width"], "height": a["height"], "fps": a["fps"], "codec": a["codec"],
        "device": a["device"], "captured": a["captured_at"], "lat": a["lat"], "lon": a["lon"], "near": a["near_ranch"],
        "mb": round((a["size"] or 0) / 1e6, 1),
        "tags": [{"tag": t, "ja": VOCAB[t][1] if t in VOCAB else t, "score": round(s, 3)} for t, s in tags] if isinstance(tags, list) else [],
        "faces": lib.get("faces"), "sharp": lib.get("sharp"), "expo": lib.get("expo"), "orientation": lib.get("orientation"),
        "event": lib.get("event"), "season": lib.get("season"), "tod": lib.get("tod"),
        "thumbs": json.loads(lib.get("thumbs") or "[]"),
        "usedIn": usage().get(Path(a["path"]).name.lower(), []),
    }


def _subdirs(folder: Path) -> int:
    """How many folders `folder` holds (one per network a reel was packaged for), 0 when it does not exist.
    One directory listing: os.scandir knows each entry's type from the listing itself, where Path.is_dir() stats
    every entry again - about 0.5 ms each on a Google Drive folder, 2,500 of them on every page load."""
    import os

    try:
        with os.scandir(folder) as it:
            return sum(1 for e in it if e.is_dir())
    except OSError:
        return 0


def _overview() -> dict:
    """Every reel the studio knows, newest first, with where it stands in the review flow."""
    from studio.config import DATA
    from studio.reels import DRAFTS, all_reels
    try:  # the house reels; none without the ranch overlay
        from studio.reel_specs import REELS
    except ModuleNotFoundError:
        REELS = []
    from studio.review_actions import list_drafts

    house = {r["slug"] for r in REELS}
    status = {r["slug"][len("story-"):]: r for r in list_drafts() if r["slug"].startswith("story-")}
    rows = _library_rows()
    from collections import Counter

    from studio.levels import fixed_at
    from studio.versions import used_at
    from studio.wording import signature

    reels_all = all_reels()
    sigs = Counter(signature(r.get("beats") or []) for r in reels_all)
    hooks = Counter(next((b["ja"].replace("\n", "") for b in r.get("beats") or [] if b.get("kind") == "hook"), "") for r in reels_all)
    out = []
    for reel in reels_all:
        slug = reel["slug"]
        folder = DATA / "renders" / f"story-{slug}"
        manifest = folder / "manifest.json"
        audio_path = folder / "audio.json"
        audio = json.loads(audio_path.read_text(encoding="utf-8")) if audio_path.exists() else {}
        row = status.get(slug) or {}
        rendered = manifest.exists()
        man = json.loads(manifest.read_text(encoding="utf-8")) if rendered else {}
        stats = man.get("stats", {})
        faces_used = {s["file"].lower(): s.get("faces") or 0 for s in man.get("shots", [])}
        out.append({
            "slug": slug,
            "title": reel.get("title_ja", ""),
            "theme": reel.get("theme") or slug.split("-")[0],
            "house": slug in house,
            "seconds": round(sum(s["sec"] for s in reel["shots"]), 1),
            "clips": len(reel["shots"]),
            "rendered": rendered,
            "updated": manifest.stat().st_mtime if rendered else None,
            "hook": str(folder / "hook.jpg") if (folder / "hook.jpg").exists() else None,
            "end": str(folder / "end.jpg") if (folder / "end.jpg").exists() else None,
            "status": row.get("status") or ("rendered" if rendered else "draft"),
            "notes": row.get("notes") or "",
            "faces": stats.get("faces", 0) or 0,
            "consent": bool(row.get("consent")),
            "lufs": stats.get("lufs"),
            "music": (audio.get("music") or {}).get("title"),
            "sfx": len(audio.get("sfx") or []),
            "channels": _subdirs(DRAFTS / slug),
            "madeBy": reel.get("made_by", "house reel" if slug in house else ""),
            "style": reel.get("style", "column"),
            "look": reel.get("look"),
            "checks": shot_checks(reel, rows, faces_used),
            "bpm": reel.get("bpm"),
            "blurFaces": bool(reel.get("blurFaces")),
            # Words: other reels with exactly these words, other reels with this headline, and new words not rendered yet.
            "sameWords": sigs[signature(reel.get("beats") or [])] - 1,
            "sameHook": hooks[next((b["ja"].replace("\n", "") for b in reel.get("beats") or [] if b.get("kind") == "hook"), "")] - 1,
            "wordsPending": bool(rendered and man.get("beats") and signature(man["beats"]) != signature(reel.get("beats") or [])),
            # When this reel last got new words: a booking made before then holds the old words on its network.
            "wordsAt": (reel.get("words") or {}).get("redrawn"),
            # When its sound was last moved onto the level by a noticeable amount (studio.levels): the same rule.
            "soundAt": fixed_at(slug),
            # When a person made another version the reel (studio.versions): bookings made before hold the earlier one.
            "versionAt": used_at(slug),
            "hookText": next((b["ja"].replace("\n", " ") for b in reel.get("beats") or [] if b.get("kind") == "hook"), ""),
        })
    out.sort(key=lambda r: (r["house"], -(r["updated"] or 0)))
    return {"reels": out, "library": _library_counts(), "filmNext": _film_next()}


_COUNTS: dict = {"at": 0.0, "data": {}, "rows": {}}


def _library_rows() -> dict:
    """file name (lower) -> library row; refreshed at most once a minute."""
    import time

    if time.time() - _COUNTS["at"] > 60:
        from studio.library import items

        rows = items("", {}, limit=100000)
        ranch = [r for r in rows if r["place"].startswith("ranch")]
        _COUNTS["rows"] = {r["file"].lower(): r for r in rows}
        _COUNTS["data"] = {
            "ranch": len(ranch),
            "videos": sum(r["kind"] == "video" for r in ranch),
            "unused": sum(not r["usedIn"] for r in ranch),
            "newest": max((r["captured"] or "" for r in ranch), default=""),
        }
        _COUNTS["at"] = time.time()
    return _COUNTS["rows"]


_FILM = {"at": 0.0, "data": []}


def _film_next() -> list:
    import time

    if time.time() - _FILM["at"] > 600:
        from studio.assemble import film_next

        _FILM["data"] = film_next()
        _FILM["at"] = time.time()
    return _FILM["data"]


def _library_counts() -> dict:
    _library_rows()
    return _COUNTS["data"]


def shot_checks(reel: dict, rows: dict | None = None, rendered_faces: dict | None = None) -> list[dict]:
    """What a reviewer should look at first, per shot. Signals, not verdicts:
    someone may be in frame, a filler shot, a weak match to its story beat, a clip
    used in many reels already. rendered_faces: file -> faces found in the moment
    actually used (from the render manifest), which the library's keyframes can miss."""
    import re

    rows = rows if rows is not None else _library_rows()
    rendered_faces = rendered_faces or {}
    out = []
    for i, s in enumerate(reel["shots"]):
        name = Path(s["src"]).name
        r = rows.get(name.lower())
        flags = []
        if rendered_faces.get(name.lower()):
            flags.append("a face in the used moment (consent)")
        if r:
            if ((r.get("faces") or 0) > 0 or r.get("person", 0) > 0.3) and not flags:
                flags.append("someone may be in frame")
            if r.get("junk", 0) > 0.25:
                flags.append("may be a filler shot")
            if len(r.get("usedIn") or []) >= 3:
                flags.append(f"used in {len(r['usedIn'])} reels")
        m = re.search(r"match ([0-9.]+)", s.get("role", ""))
        if m and float(m.group(1)) < 0.22:
            flags.append("weak match to its line")
        if flags:
            out.append({"i": i, "file": Path(s["src"]).name, "flags": flags})
    return out


TEXT_STYLES = ("column", "centre", "lower", "split")  # shared/story-layout.mjs STYLES


def vary_look(project: dict, theme_style: str, rng, theme_look: str | None = None, night: bool = False, learned: bool = False) -> dict:
    """A different look for each new version of a theme: another text layout than the theme's own,
    a type pairing, colours, word motion and grade (studio.typekits),
    the effects (whooshes, riser, hit) on three times in four, and a picture look (shared/looks.json):
    a theme with its own look keeps it half the time, else any look or the plain house picture
    (firelight, `ember`, only for night and fire themes).
    Clips and words already differ by seed.
    learned (opt-in): the layout and look are drawn from what has worked (studio.learn.vary_draw) once
    enough posts are measured; until then, and on its explore turns, the random choice above stands."""
    from studio.staging import LOOKS

    project["style"] = rng.choice([s for s in TEXT_STYLES if s != theme_style])
    project["sfx"] = rng.random() < 0.75
    looks = [k for k in LOOKS if (night or k != "ember") and k != "mirror"]  # mirror folds people in two: chosen by hand, for landscapes
    project["look"] = theme_look if theme_look and rng.random() < 0.5 else rng.choice([None, *looks])
    # Type pairing, colours, word motion and grade (shared/type-kits.json): drawn per reel, avoiding the last few reels'
    # (owner, 2026-11-12: "make the reels more creative and randomized for styles"); the editor can change each.
    from studio.typekits import pick, recent

    project.update(pick(rng, recent()))
    if night:
        project["grade"] = "house"  # the house look keeps a night's dark; a tint would lift it
    if learned:
        from studio.learn import vary_draw

        pick = vary_draw(theme_style, rng, night=night, looks=looks)
        if pick:
            project.update(pick)
    return project


def _autopilot(themes: list[str], since: str | None, faces: bool, cut: str = "short", vary: bool = False, learned: bool = False) -> list[dict]:
    """Propose one reel per theme from the newest footage. Rendering is queued by the server.
    cut "long" makes the 40-60 s explainer for LinkedIn and Facebook instead of the short loop;
    vary gives each reel a different text layout and effects (vary_look)."""
    import random
    from datetime import date, timedelta

    from studio.assemble import THEMES, assemble
    from studio.projects import load, save

    since = since or (date.today() - timedelta(days=60)).isoformat()
    made = []
    if not THEMES:
        raise ValueError("This project has no themes yet. Add one in Reels › Make reels › New theme (a headline, a few lines "
                         "and what to film), or POST /api/themes, then make reels.")
    for key in themes or list(THEMES):
        if key not in THEMES:
            continue
        base = f"{key}-{date.today().strftime('%m%d')}" + ("-long" if cut == "long" else "")
        slug, n = base, 2
        while load(slug):
            slug, n = f"{base}-{n}", n + 1
        project = assemble(THEMES[key], slug, allow_faces=faces, since=since, variant="b-explainer" if cut == "long" else None)
        project.update({"theme": key, "music": "auto", "sfx": cut != "long", "made_by": project["made_by"].replace("assembler", "autopilot")})
        if vary:
            night = bool({"night", "fire"} & set(THEMES[key].get("boost", {}).get("tags", [])))
            vary_look(project, THEMES[key].get("style", "column"), random.Random(project["seed"]), THEMES[key].get("look"), night, learned)
            if cut == "long":
                project["sfx"] = False
        save(project)
        made.append({"slug": slug, "theme": key, "clips": len(project["shots"]), "style": project.get("style"), "sfx": project.get("sfx")})
    return made


_FOOTAGE: dict = {}


def handle(req: dict) -> object:
    cmd = req.get("cmd")
    if "studio.assemble" in sys.modules:  # a theme saved by another process (or by hand) is seen on the next request
        sys.modules["studio.assemble"].load_themes()
    if cmd == "library":
        from studio.library import items

        rows = items(req.get("query", ""), req.get("filters") or {}, req.get("limit", 300))
        events = sorted({r["event"] for r in rows if r["event"]})
        return {"items": rows, "events": events}
    if cmd == "asset":
        return _asset(int(req["id"]))
    if cmd == "ids":
        from studio.db import connect

        with connect() as con:
            out = {}
            for p in req.get("paths", []):
                row = con.execute("SELECT id FROM assets WHERE lower(path) = lower(?)", (p,)).fetchone()
                out[p] = row["id"] if row else None
        return out
    if cmd == "footage":
        import time as _t

        from studio import footage

        if req.get("fresh") or not _FOOTAGE.get("data") or _t.time() - _FOOTAGE.get("at", 0) > 600:  # ten minutes
            _FOOTAGE.update(data=footage.health(), at=_t.time())
        return _FOOTAGE["data"]
    if cmd == "themes":
        from studio.assemble import theme_list

        return theme_list()
    if cmd == "theme_save":
        from studio.assemble import save_theme

        return {"key": req.get("key"), "theme": save_theme(str(req.get("key") or ""), req.get("theme") or {})}
    if cmd == "theme_delete":
        from studio.assemble import delete_theme

        if not delete_theme(str(req.get("key") or "")):
            raise ValueError(f"no theme {req.get('key')} of this project to delete (built-in themes cannot be deleted)")
        return {"deleted": req.get("key")}
    if cmd == "perf_read":  # scores and predictions read the reel list: the warm one here, not a cold process
        from studio import perf

        if req.get("action") not in ("scores", "predictions", "get"):
            raise ValueError("action: scores, predictions or get")
        # get: one reel's posts and readings (Results › Latest posts asks for six; a cold process each took seconds).
        return perf.run(req["action"], {"slug": str(req.get("slug") or "")} if req["action"] == "get" else {})
    if cmd == "live":
        from studio import live

        return live.run(str(req.get("action") or ""), req)
    if cmd == "brand":
        from studio import brand

        return brand.view()
    if cmd == "brand_save":
        from studio import brand

        return brand.save_brand(req.get("brand") or {})
    if cmd == "assemble":
        from studio.assemble import THEMES, assemble

        if req.get("theme") not in THEMES:
            raise ValueError(f"no theme {req.get('theme')} in this project: GET /api/themes lists them, or add one in Reels › Make reels › New theme")
        project = assemble(THEMES[req["theme"]], req["slug"], allow_faces=bool(req.get("faces")), since=req.get("since"))
        if "look" in req:  # a picture look other than the theme's (shared/looks.json); None = the plain house picture
            from studio.projects import save
            from studio.staging import LOOKS

            if req["look"] not in (None, *LOOKS):
                raise ValueError("look: one of " + ", ".join(LOOKS) + " or null")
            project["look"] = req["look"]
            save(project)
        return project
    if cmd == "save_project":
        from studio.projects import save
        from studio.ingest import is_output
        from studio.reels import check_reel, off_site, resolve
        from studio.guard import problems as copy_problems

        from studio.projects import keep_ai

        project = keep_ai(req["project"])
        issues = check_reel(project)
        for s in project.get("shots", []) + project.get("layers", []):  # V2 layers pass the same gates as shots
            src = resolve(s["src"])
            if off_site(src):
                issues.append(f"{Path(s['src']).name}: nothing places it at the ranch (GPS, folder or event date)")
            if is_output(src):
                issues.append(f"{Path(s['src']).name} is a finished edit, not footage")
        for b in project.get("beats", []):
            for key in ("ja", "en"):
                for p in copy_problems(b.get(key, "")):
                    issues.append(f"caption '{b.get(key)}': {p}")
        save(project)
        return {"saved": project["slug"], "problems": issues}
    if cmd == "project":
        from studio.reels import get_reel

        return get_reel(req["slug"])
    if cmd == "overview":
        return _overview()
    if cmd == "review_list":
        # Every draft's review status, for the server's approval checks (read here, not by starting Python each time).
        from studio.review_actions import list_drafts

        return list_drafts()
    if cmd == "review":
        from studio.review_actions import list_drafts

        return next((r for r in list_drafts() if r["slug"] == f"story-{req['slug']}"), None)
    if cmd == "audio_list":
        from studio.sound import library

        return library()
    if cmd == "audio_fetch":
        from studio.sound import fetch

        kind = req.get("kind", "music")
        return fetch(kind, str(req.get("query", ""))[:120], n=int(req.get("n", 4)))
    if cmd == "veto":
        from studio.library import veto

        return veto(int(req["id"]), bool(req.get("on", True)), str(req.get("note", "")))
    if cmd == "alternate":
        from studio.assemble import alternate_opening

        return alternate_opening(req["slug"])
    if cmd == "posts":
        from studio import posting

        action = req.get("action", "list")
        if action == "plan":
            return {"id": posting.plan(req["slug"], req["network"], req["at"])}
        if action == "done":
            posting.done(int(req["id"]), req.get("url", ""), req.get("at"))
        elif action == "booked":
            posting.booked(int(req["id"]), req.get("url", ""), req.get("at"))
        elif action == "link":
            posting.link(int(req["id"]), req.get("url", ""))
        elif action == "drop":
            posting.drop(int(req["id"]))
        elif action == "replaced":
            posting.settle(int(req["id"]), "replaced", note="replaced by a new render")
        elif action == "skip":
            posting.skip(req["slug"], bool(req.get("on", True)))
        elif action == "move":
            posting.move(int(req["id"]), str(req["at"]))
        return posting.posts()
    if cmd == "connections":
        # Accounts page: which networks the studio can post to itself. Secrets go in, never come back out.
        from studio import publish

        action = req.get("action", "list")
        port = int(req.get("port") or 4317)
        if action == "start":  # one-click sign-in: the network's own page; the browser comes back to /oauth/<network>
            return publish.start(req["network"], req.get("fields") or {}, port)
        if action == "finish":
            publish.finish(req["network"], req.get("params") or {}, port)
        elif action == "setup":
            publish.setup(req["network"], req.get("fields") or {})
        elif action == "connect":
            publish.connect(req["network"], req.get("fields") or {})
        elif action == "disconnect":
            publish.disconnect(req["network"])
        return publish.connections(port)
    if cmd == "profiles":
        from studio.config import project_file

        kit = project_file("profiles.json")
        return json.loads(kit.read_text(encoding="utf-8")) if kit.is_file() else {}
    if cmd == "log":
        from studio.activity import summary

        return summary()
    if cmd == "yt_status":
        from studio.youtube import status

        return status()
    if cmd == "package":
        # Files for one or more networks of a reel that is already rendered (a network added later, new text).
        from studio.reels import CHANNELS, package

        only = [c for c in req.get("channels") or [] if c in CHANNELS]
        if not only:
            raise ValueError("channels: one or more of " + ", ".join(CHANNELS))
        return {"slug": req["slug"], "made": package(req["slug"], only)}
    if cmd == "cover":
        from studio.reels import set_cover

        return set_cover(req["slug"], float(req["t"]))
    if cmd == "autopilot":
        from studio.learn import steer_on

        return _autopilot(req.get("themes") or [], req.get("since"), bool(req.get("faces")), "long" if req.get("cut") == "long" else "short", bool(req.get("vary")),
                          bool(req.get("learned")) or steer_on())
    if cmd == "ping":
        return {"ok": True}
    raise ValueError(f"unknown command {cmd}")


def main() -> None:
    from studio.library import _model

    _model()
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            reply = {"_rid": req.get("_rid"), "ok": True, "data": handle(req)}
        except Exception as exc:  # reply with the error; the editor shows it
            import traceback

            where = traceback.extract_tb(exc.__traceback__)[-1]
            tech = f"{type(exc).__name__} ({Path(where.filename).name}:{where.lineno})"
            # ValueError / RuntimeError carry sentences written for people (a wrong ID, a network refusing):
            # show just that sentence. Anything else is a bug: keep the type and place so it can be fixed.
            plain = isinstance(exc, (ValueError, RuntimeError)) and str(exc)
            reply = {"_rid": (req.get("_rid") if isinstance(req, dict) else None), "ok": False,
                     "error": str(exc) if plain else f"{type(exc).__name__}: {exc} ({Path(where.filename).name}:{where.lineno})",
                     "input": isinstance(exc, ValueError), "detail": tech}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()
