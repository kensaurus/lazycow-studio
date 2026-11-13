"""
FILE: py/studio/__main__.py
PURPOSE: Command line for the studio.
OVERVIEW: ingest, shots, tag, luts, reels (build / package / remix), vlog, review, extras, verify,
          youtube (connect / upload / schedule / list), posts (posting log and reminders),
          gphotos (pick and import footage from Google Photos).
DEPENDENCIES: the studio package
USAGE: python -m studio <command>
NOTES: Paid calls stay inside the daily budget. Gap-fill stays dry without --confirm.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from studio.config import ROOT, SOURCE, TAKEOUT_DRIVE, ensure_dirs
from studio.extras import beat_track, gap_fill, import_takeout, parallax, ridge_mask, upscale
from studio.ingest import ingest
from studio.looks import write_luts
from studio.review_actions import approve, consent, list_drafts, set_note
from studio.shots import log_matching
from studio.tag import tag_shots
from studio.verify import verify_master


def main() -> None:
    # Results carry text like "▶ Next: Part 2" and Japanese: in a Windows terminal (cp1252/cp932) printing them crashed
    # the command after its work was done (13 Nov, `vlog build`). The studio's server already asks for UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog="studio")
    sub = parser.add_subparsers(dest="cmd", required=True)

    ing = sub.add_parser("ingest")
    ing.add_argument("--proxy", action="store_true")
    ing.add_argument("--no-hash", action="store_true")
    ing.add_argument("--only", default=None)
    ing.add_argument("--limit", type=int, default=None)

    shots = sub.add_parser("shots")
    shots.add_argument("--like", required=True)
    shots.add_argument("--embed", action="store_true")
    shots.add_argument("--limit", type=int, default=None)

    tag = sub.add_parser("tag")
    tag.add_argument("--limit", type=int, default=12)
    tag.add_argument("--like", default=None)

    sub.add_parser("luts")

    sub.add_parser("review-list")
    ok = sub.add_parser("approve")
    ok.add_argument("slug")
    no = sub.add_parser("reject")
    no.add_argument("slug")
    no.add_argument("note")
    yes = sub.add_parser("consent")
    yes.add_argument("slug")
    again = sub.add_parser("reroll")
    again.add_argument("slug")
    again.add_argument("note")


    sub.add_parser("service")
    vs = sub.add_parser("versions", help="versions of a reel: recut (a better cut beside the live one), list, use, discard, todo")
    vs.add_argument("action", choices=["recut", "list", "use", "discard", "todo"])
    vs.add_argument("--slug", help="comma-separated reels (use and discard: one)")
    vs.add_argument("--booked", action="store_true", help="recut: every approved reel with a booking still ahead whose review found problems")
    vs.add_argument("--n", type=int, help="use / discard: the version number")
    lv = sub.add_parser("levels", help="sound level of finished reels: check, or fix in place by gain alone")
    lv.add_argument("action", choices=["check", "fix"])
    lv.add_argument("--slug", help="comma-separated reels")
    lv.add_argument("--booked", action="store_true", help="every approved reel with a booking still ahead")
    tlp = sub.add_parser("timeline", help="Google Maps Timeline: import an export, show it, name places, forget it")
    tlp.add_argument("action", choices=["import", "show", "choose", "forget"])
    tlp.add_argument("--file", help="import: the export (Timeline.json, location-history.json, a Takeout month file or a GPX)")
    tlp.add_argument("--from", dest="date_from", help="import: first day to keep (default: the footage's first day - 1)")
    tlp.add_argument("--to", dest="date_to", help="import: last day to keep (default: the footage's last day + 1)")
    tlp.add_argument("--json", help='choose: [{"day": "2025-04-03", "id": "v3", "name": "River Camp", "show": true}]')
    vl = sub.add_parser("vlog", help="long YouTube vlogs from a trip: plan, build <n>, all")
    vl.add_argument("action", choices=["plan", "build", "all", "suggest", "places", "extend", "clocks"])
    vl.add_argument("n", nargs="?", type=int)
    vl.add_argument("--parts", type=int, default=4)
    vl.add_argument("--minutes", type=float, default=8.0)
    vl.add_argument("--name")
    vl.add_argument("--no-music", action="store_true")
    vl.add_argument("--style", choices=["calm", "lively", "photos", "documentary", "cinematic", "energetic", "journal", "retro", "fieldguide", "monochrome", "slow", "roadmovie"])
    vl.add_argument("--fresh", action="store_true", help="extend: videos from footage no video shows yet (as many as it holds) instead of new looks")
    vl.add_argument("--count", type=int, help="extend --fresh: how many videos (default: what the footage holds)")
    vl.add_argument("--more", action="store_true", help="plan: also add one film per extra look (extend) before naming")
    vl.add_argument("--looks", help='JSON: a look per part, e.g. ["energetic", "cinematic"]')
    vl.add_argument("--groups", help='JSON: [["2025-04-03", "2025-04-04"], ["2025-04-05"]] (a suggested plan\'s days)')
    vl.add_argument("--lengths", help="JSON: minutes per part, e.g. [12, 9.5]")
    vl.add_argument("--series", action="store_true", help="plan: a series of even episodes in story order, each day once, one look")
    vl.add_argument("--target", type=float, help="plan --series / suggest: minutes per episode, 5 to 15 (default: the trip notes' length, else 10)")
    vl.add_argument("--titles", help='plan --series: JSON, your own episode titles in order, e.g. ["A Leopard in a Tree", ...]')
    sp = sub.add_parser("speech", help="what people say in the footage (local, free): scan")
    sp.add_argument("action", choices=["scan"])
    qu = sub.add_parser("quality", help="blurry pictures, shaky clips and wind, measured once per file: scan")
    qu.add_argument("action", choices=["scan"])
    lv = sub.add_parser("live", help="did booked posts go out: check, catch-up, tidy, health, settings, waiting")
    lv.add_argument("action", choices=["check", "catch-up", "tidy", "health", "settings", "waiting"])
    asm = sub.add_parser("assemble")
    asm.add_argument("theme")
    asm.add_argument("--slug", required=True)
    asm.add_argument("--faces", action="store_true")
    asm.add_argument("--since", default=None)

    lib = sub.add_parser("library")
    lib.add_argument("--scan", action="store_true")
    lib.add_argument("--reembed", action="store_true", help="recompute CLIP embeddings and tags from saved keyframes")
    lib.add_argument("--retag", action="store_true", help="tag again from saved embeddings with this project's word list")
    lib.add_argument("--force", action="store_true")
    lib.add_argument("--limit", type=int, default=None)
    lib.add_argument("--ingest", action="store_true", help="look for new files on Drive first")
    lib.add_argument("--search", default=None)
    lib.add_argument("--redo-360", action="store_true", help="re-tag 360 files from a level front view (then --scan)")

    story = sub.add_parser("reels")
    story.add_argument("--plan", action="store_true")
    story.add_argument("--build", default=None)
    story.add_argument("--package", default=None, help="slug or all; re-copies masters into Drive drafts")
    story.add_argument("--channels", default=None, help="comma list, e.g. x,tiktok,threads,xiaohongshu")
    story.add_argument("--remix", default=None, help="slug: re-mix music and effects only (no re-render)")

    snd = sub.add_parser("audio", help="free music and sound effects")
    snd.add_argument("--synth", action="store_true", help="make the house whoosh / riser / hit")
    snd.add_argument("--fetch", nargs=2, metavar=("KIND", "QUERY"), help="music|sfx and search words (CC0 / public domain)")
    snd.add_argument("--seed", action="store_true", help="fetch music for every theme mood")
    snd.add_argument("--list", action="store_true")

    check = sub.add_parser("verify")
    check.add_argument("path")

    yt = sub.add_parser("youtube", help="connect the channel, upload or schedule a Short, list the channel")
    yt.add_argument("action", choices=["status", "auth-url", "exchange", "upload", "list", "meta", "playlists", "sort",
                                       "app", "set-app", "forget-app", "disconnect", "accounts", "upload-vlog", "share-app", "unshare-app",
                                       "link-series", "series-comments"])
    yt.add_argument("--account", default=None, help="which of the project's YouTube accounts: main, a2, ...; auth-url also takes new")
    yt.add_argument("--part", type=int, default=None, help="upload-vlog: the long video's part number")
    yt.add_argument("--playlist-title", default=None, help="link-series: the series playlist's name (default: <trip> · the series)")
    yt.add_argument("--port", default=None, help="auth-url: the studio's port (Google returns there)")
    yt.add_argument("--hint", default=None, help="auth-url: the Google account (email) to preselect")
    yt.add_argument("--dry-run", action="store_true", help="sort, link-series, series-comments: show what would be done, change nothing")
    yt.add_argument("slug", nargs="?", default=None)
    yt.add_argument("--code", default=None)
    yt.add_argument("--state", default=None)
    yt.add_argument("--at", default=None, help="local time to go public, e.g. 2026-11-08T19:00")
    yt.add_argument("--privacy", default="private", choices=["private", "unlisted", "public"])
    yt.add_argument("--force", action="store_true", help="upload even if this reel is already on YouTube")

    src = sub.add_parser("sources", help="footage folders: browse, discover, add, watch for new files")
    src.add_argument("action", choices=["roots", "ls", "discover", "add", "remove", "list", "diff", "watch"])
    src.add_argument("path", nargs="?", default=None)
    src.add_argument("--mode", default="gps", choices=["gps", "trusted"])
    src.add_argument("--label", default=None)

    fo = sub.add_parser("footage", help="footage left, cameras, reuse and what to film next")
    fo.add_argument("action", choices=["health", "cameras"])
    fo.add_argument("--limit", type=int, default=5000)
    gp = sub.add_parser("gphotos", help="bring footage in from Google Photos (Picker API)")
    gp.add_argument("action", choices=["status", "auth-url", "exchange", "session", "poll", "import"])
    gp.add_argument("--id", default=None)
    gp.add_argument("--code", default=None)
    gp.add_argument("--state", default=None)

    pst = sub.add_parser("posts", help="the posting log: plans, reminders, what went out")
    pst.add_argument("action", choices=["list", "plan", "done", "drop", "ics", "skip", "unskip"])
    pst.add_argument("target", nargs="?", default=None, help="slug for plan, post id for done / drop / ics")
    pst.add_argument("network", nargs="?", default=None)
    pst.add_argument("--at", default=None)
    pst.add_argument("--url", default="")

    pub = sub.add_parser("publish", help="post a reel to a connected network (Accounts page), or send queued posts that are due")
    pub.add_argument("slug", nargs="?", default=None)
    pub.add_argument("network", nargs="?", default=None)
    pub.add_argument("--at", default=None)
    pub.add_argument("--id", type=int, default=None)
    pub.add_argument("--due", action="store_true")
    pub.add_argument("--replace", type=int, default=None, help="swap this booking for the reel's current render")

    extra = sub.add_parser("extras")
    extra.add_argument("name", choices=["mask", "parallax", "takeout", "upscale", "beats", "gap"])
    extra.add_argument("--src", default=None)
    extra.add_argument("--dest", default=None)
    extra.add_argument("--prompt", default="")
    extra.add_argument("--confirm", action="store_true")

    args = parser.parse_args()
    ensure_dirs()
    if args.cmd == "ingest":
        print(json.dumps(ingest(SOURCE, do_hash=not args.no_hash, do_proxy=args.proxy, only=args.only, limit=args.limit)))
    elif args.cmd == "shots":
        print(json.dumps({"shots": log_matching(args.like, embed=args.embed, limit=args.limit)}))
    elif args.cmd == "tag":
        print(json.dumps(tag_shots(limit=args.limit, like=args.like)))
    elif args.cmd == "luts":
        print(json.dumps([str(p) for p in write_luts(ROOT / "luts")]))
    elif args.cmd == "review-list":
        print(json.dumps(list_drafts(), ensure_ascii=False))
    elif args.cmd == "approve":
        print(approve(args.slug))
    elif args.cmd == "reject":
        set_note(args.slug, "rejected", args.note)
        print("rejected")
    elif args.cmd == "consent":
        consent(args.slug)
        print("consent")
    elif args.cmd == "reroll":
        set_note(args.slug, "reroll", args.note)
        print(f"noted for {args.slug}; change the reel in the editor (or its project file) and build it again")
    elif args.cmd == "reels":
        from studio import reels as story_reels

        if args.package:
            only = args.channels.split(",") if args.channels else None
            slugs = [r["slug"] for r in story_reels.REELS] if args.package == "all" else [args.package]
            for slug in slugs:
                print(slug, story_reels.package(slug, only))
        elif args.remix:
            print(json.dumps(story_reels.remix(args.remix), ensure_ascii=False))
        elif args.plan or not args.build:
            print(story_reels.plan_json())
        if args.build:
            slugs = [r["slug"] for r in story_reels.REELS] if args.build == "all" else [args.build]
            for slug in slugs:
                print(json.dumps(story_reels.build(slug), ensure_ascii=False))
    elif args.cmd == "audio":
        import time

        from studio import sound

        if args.synth:
            print(json.dumps(sound.synth()))
        if args.fetch:
            print(json.dumps(sound.fetch(args.fetch[0], args.fetch[1]), ensure_ascii=False))
        if args.seed:
            for q in sound.SEED_QUERIES["music"]:
                print(q, len(sound.fetch("music", q, n=4)))
                time.sleep(3.5)  # Openverse anonymous: 20 requests a minute
        if args.list or not (args.synth or args.fetch or args.seed):
            for t in sound.library():
                print(f"{t['kind']:5} {t.get('license', ''):5} {t.get('duration', 0):6.1f}s {t.get('title', '')[:40]:40} {t.get('creator', '')}")
    elif args.cmd == "versions":
        from studio import versions

        if args.action == "todo":
            print("RESULT " + json.dumps(versions.todo(), ensure_ascii=False), flush=True)
        elif args.action == "list":
            print("RESULT " + json.dumps({"versions": versions.listing(args.slug or "")}, ensure_ascii=False), flush=True)
        elif args.action in ("use", "discard"):
            fn = versions.use if args.action == "use" else versions.discard
            print("RESULT " + json.dumps(fn(args.slug or "", int(args.n or 0)), ensure_ascii=False, default=str), flush=True)
        else:
            slugs = [x["slug"] for x in versions.todo()["open"]] if args.booked else [s for s in (args.slug or "").split(",") if s]
            made, skipped, failed = [], [], []
            note = None
            for k, slug in enumerate(slugs, 1):
                print(f"PROGRESS {k}/{len(slugs)} {slug}", flush=True)
                note = versions.queue_note(slugs[k - 1:])
                try:
                    m = versions.make(slug)
                    (made if m else skipped).append({"slug": slug, **({"n": m["n"], "changes": len(m["changes"])} if m else {})})
                except Exception as err:  # one reel's failure never stops the others
                    failed.append({"slug": slug, "error": str(err)[:300]})
            if note:
                note.unlink(missing_ok=True)
            print("RESULT " + json.dumps({"made": made, "skipped": skipped, "failed": failed}, ensure_ascii=False), flush=True)
    elif args.cmd == "levels":
        from studio import levels

        slugs = levels.booked() if args.booked else [s for s in (args.slug or "").split(",") if s]
        if args.action == "check":
            print("RESULT " + json.dumps({"reels": levels.check(slugs)}, ensure_ascii=False), flush=True)
        else:
            todo = [r["slug"] for r in levels.check(slugs) if r["off"]]
            done = []
            for k, slug in enumerate(todo, 1):
                print(f"PROGRESS {k}/{len(todo)} {slug}", flush=True)
                done.append(levels.fix(slug))
            print("RESULT " + json.dumps({"checked": len(slugs), "fixed": done}, ensure_ascii=False), flush=True)
    elif args.cmd == "timeline":
        from studio import timeline

        if args.action == "import":
            window = (args.date_from, args.date_to) if args.date_from and args.date_to else timeline.footage_window()
            print("RESULT " + json.dumps(timeline.import_file(Path(args.file), window), ensure_ascii=False), flush=True)
        elif args.action == "show":
            print("RESULT " + json.dumps(timeline.summary(timeline.load()), ensure_ascii=False), flush=True)
        elif args.action == "choose":
            print("RESULT " + json.dumps(timeline.choose(json.loads(args.json or "[]")), ensure_ascii=False), flush=True)
        else:
            print("RESULT " + json.dumps({"forgot": timeline.forget()}), flush=True)
    elif args.cmd == "vlog":
        from studio import vlog

        if args.action == "places":
            print("RESULT " + json.dumps(vlog.place_hints(), ensure_ascii=False), flush=True)
        if args.action == "extend":  # more videos (one per extra look) on the plan there is; the built ones stay
            p = vlog.fresh(count=args.count) if args.fresh else vlog.extend(looks=json.loads(args.looks) if args.looks else None)
            if p["added"]:
                p = vlog.name_with_eyes(p, only=p["added"])
            print("RESULT " + json.dumps({"parts": p["parts"], "added": p.get("added", []), "videos": [{"n": v["n"], "title": v["title"], "look": v.get("look")} for v in p["videos"]]}, ensure_ascii=False), flush=True)
        if args.action == "suggest":
            print("RESULT " + json.dumps(vlog.suggest(args.style or "calm", name=args.name, target=args.target), ensure_ascii=False), flush=True)
        if args.action == "clocks":  # what each camera's clock was set to, measured from photos that match a video moment
            from studio.library import _base_items

            print("RESULT " + json.dumps({"clocks": vlog.clock_offsets(list(_base_items())), "set": vlog.trip()["clocks"]}), flush=True)
        if args.action in ("plan", "all"):
            if args.series:
                p = vlog.series(target=args.target, name=args.name, titles=json.loads(args.titles) if args.titles else None)
            else:
                p = vlog.plan(parts=args.parts, minutes=args.minutes, name=args.name, style=args.style,
                              groups=json.loads(args.groups) if args.groups else None, lengths=json.loads(args.lengths) if args.lengths else None,
                              looks=json.loads(args.looks) if args.looks else None)
            if args.more and not args.series:  # a series is one look: the extra looks stay separate films
                p = vlog.extend()
            p = vlog.name_with_eyes(p)
            print("RESULT " + json.dumps({"parts": p["parts"], "items": p["items"], "days": p["days"], "videos": [{"n": v["n"], "title": v["title"], "days": v["days"], "chapters": [[c["day"], c["title"], len(c["shots"])] for c in v["chapters"]]} for v in p["videos"]]}, ensure_ascii=False), flush=True)
        if args.action == "build":
            print("RESULT " + json.dumps(vlog.build(args.n, music=not args.no_music), ensure_ascii=False, default=str), flush=True)
        if args.action == "all":
            for v in json.loads(vlog.PLAN_FILE.read_text(encoding="utf-8"))["videos"]:
                print("RESULT " + json.dumps(vlog.build(v["n"], music=not args.no_music), ensure_ascii=False, default=str), flush=True)
    elif args.cmd == "quality":
        from studio import quality

        print(json.dumps(quality.scan(), indent=1))
    elif args.cmd == "speech":
        from studio import speech
        from studio.library import _base_items

        vids = [(Path(i["path"]), i.get("duration")) for i, _ in _base_items() if i.get("kind") == "video"]
        from studio.vlog import speech_hint

        print("RESULT " + json.dumps(speech.scan(vids, speech_hint())), flush=True)
    elif args.cmd == "live":
        from studio import live

        # RESULT line: the server reads it like a render's (server/review.mjs startTask).
        print("RESULT " + json.dumps(live.run(args.action), ensure_ascii=False, default=str))
    elif args.cmd == "service":
        from studio.service import main as service_main

        service_main()
    elif args.cmd == "assemble":
        from studio.assemble import THEMES, assemble

        project = assemble(THEMES[args.theme], args.slug, allow_faces=args.faces, since=args.since)
        print(json.dumps([(s["src"], s["sec"]) for s in project["shots"]], ensure_ascii=False, indent=1))
    elif args.cmd == "library":
        from studio import library as lib_mod

        if args.ingest:
            from studio.config import extra_sources

            print("STAGE 1/2 looking for new footage on Drive", flush=True)
            print(json.dumps(ingest(SOURCE, do_hash=False, do_proxy=False)), flush=True)
            for extra in extra_sources():
                if extra.exists():
                    print(json.dumps({"extra": str(extra), **ingest(extra, do_hash=False, do_proxy=False)}), flush=True)
            print("STAGE 2/2 tagging new footage (CLIP, faces, keyframes)", flush=True)
        if args.redo_360:
            print(json.dumps({"redo360": lib_mod.redo_360()}), flush=True)
        if args.reembed:
            print(json.dumps(lib_mod.reembed()))
        if args.retag:
            print(json.dumps(lib_mod.retag(force=True)))
        if args.scan:
            print(json.dumps(lib_mod.scan(force=args.force, limit=args.limit)))
        if args.search is not None:
            for item in lib_mod.items(args.search, limit=12):
                print(item.get("match"), item["kind"], item["file"], item["top"], item["place"], item["usedIn"])
    elif args.cmd == "verify":
        print(json.dumps(verify_master(Path(args.path))))
    elif args.cmd == "youtube":
        from studio import youtube

        if args.account and args.action != "auth-url":
            youtube.use(args.account)
        if args.action == "accounts":
            out = {"accounts": youtube.accounts()}
        elif args.action == "upload-vlog":
            out = youtube.upload_vlog(int(args.part or 0), privacy=args.privacy, at=args.at, force=args.force)
        elif args.action == "link-series":  # after every part is up: the series playlist, then each description's links
            out = youtube.link_series(title=args.playlist_title, dry_run=args.dry_run)
        elif args.action == "series-comments":  # "Part n of N. Next: ..." on each part, for the person to pin in Studio
            out = youtube.series_comments(dry_run=args.dry_run)
        elif args.action == "status":
            out = youtube.status()
        elif args.action == "auth-url":
            out = {"url": youtube.auth_url(args.port, args.hint, args.account or "main")}
        elif args.action == "exchange":
            out = youtube.exchange(args.code or "", args.state or "")
        elif args.action == "app":
            out = youtube.app_info()
        elif args.action == "set-app":
            out = youtube.set_app(sys.stdin.read())  # the app file comes on stdin, never on the command line
        elif args.action in ("share-app", "unshare-app"):
            out = youtube.share_app(args.action == "share-app")
        elif args.action == "forget-app":
            out = youtube.forget_app()
        elif args.action == "disconnect":
            youtube.disconnect()
            out = youtube.status()
        elif args.action == "upload":
            out = youtube.upload(args.slug, at=args.at, privacy=args.privacy, force=args.force)
        elif args.action == "meta":
            meta = youtube.metadata(args.slug)
            out = {**meta, "video": str(meta["video"]) if meta["video"] else None}
        elif args.action == "playlists":
            out = youtube.playlists()
        elif args.action == "sort":
            out = youtube.sort_into_playlists(dry_run=args.dry_run)
        else:
            out = youtube.list_videos()
        print("RESULT " + json.dumps(out, ensure_ascii=False))
    elif args.cmd == "sources":
        from studio import sources

        if args.action in ("ls", "discover", "add", "remove") and not args.path:
            raise SystemExit(f"sources {args.action} needs a folder")
        if args.action == "watch":
            # Diff every source; when something is new, catalog and tag just those sources.
            print("STAGE 1/3 checking every footage folder for new files", flush=True)
            state = sources.diff()
            if state["new"]:
                print(f"STAGE 2/3 adding {state['new']} new files to the catalog", flush=True)
                for s in state["sources"]:
                    if s["new"] and s["exists"]:
                        ingest(Path(s["path"]), do_hash=False, do_proxy=False)
                print("STAGE 3/3 tagging new footage (CLIP, faces, keyframes)", flush=True)
                from studio import library as lib_mod

                state["tagged"] = lib_mod.scan()
                state = {**sources.diff(), "added": state["new"], "tagged": state.get("tagged")}
            out = state
        else:
            out = {
                "roots": lambda: sources.roots(),
                "ls": lambda: sources.listdir(args.path),
                "discover": lambda: sources.discover(args.path),
                "add": lambda: sources.add(args.path, args.mode, args.label),
                "remove": lambda: sources.remove(args.path),
                "list": lambda: {"sources": sources.all_sources(), "last": sources.last_diff()},
                "diff": lambda: sources.diff(),
            }[args.action]()
        print("RESULT " + json.dumps(out, ensure_ascii=False, default=str))
    elif args.cmd == "footage":
        from studio import footage

        out = footage.health() if args.action == "health" else footage.backfill_cameras(args.limit)
        print("RESULT " + json.dumps(out, ensure_ascii=False, default=str))
    elif args.cmd == "gphotos":
        from studio import gphotos

        out = {
            "status": lambda: gphotos.status(),
            "auth-url": lambda: {"url": gphotos.auth_url()},
            "exchange": lambda: gphotos.exchange(args.code or "", args.state or ""),
            "session": lambda: gphotos.session(),
            "poll": lambda: gphotos.poll(args.id),
            "import": lambda: gphotos.import_session(args.id),
        }[args.action]()
        print("RESULT " + json.dumps(out, ensure_ascii=False))
    elif args.cmd == "posts":
        from studio import posting

        if args.action == "plan":
            out = {"id": posting.plan(args.target, args.network, args.at)}
        elif args.action == "done":
            posting.done(int(args.target), args.url)
            out = {"ok": True}
        elif args.action == "drop":
            posting.drop(int(args.target))
            out = {"ok": True}
        elif args.action == "ics":
            print(posting.ics(int(args.target)), end="")
            return
        elif args.action in ("skip", "unskip"):
            posting.skip(args.target, args.action == "skip")
            out = {"ok": True}
        else:
            out = posting.posts()
        print("RESULT " + json.dumps(out, ensure_ascii=False))
    elif args.cmd == "publish":
        from studio import publish

        if args.due:
            out = publish.run_due()
        elif args.replace:
            print(f"STAGE 1/2 replacing booking {args.replace}", flush=True)
            out = publish.replace(args.replace)
        else:
            if not (args.slug and args.network):
                raise SystemExit("publish SLUG NETWORK [--at TIME] [--id POST_ID], or publish --due")
            print(f"STAGE 1/2 posting to {args.network}", flush=True)
            out = publish.publish(args.slug, args.network, args.at, args.id)
        print("RESULT " + json.dumps(out, ensure_ascii=False), flush=True)
    elif args.cmd == "extras":
        src = Path(args.src) if args.src else None
        dest = Path(args.dest) if args.dest else Path("out")
        if args.name == "mask":
            print(json.dumps(ridge_mask(src, dest)))
        elif args.name == "parallax":
            print(json.dumps(parallax(src, dest)))
        elif args.name == "takeout":
            print(json.dumps(import_takeout(src or TAKEOUT_DRIVE)))
        elif args.name == "upscale":
            print(json.dumps(upscale(src, dest)))
        elif args.name == "beats":
            print(json.dumps(beat_track(src)))
        elif args.name == "gap":
            print(json.dumps(gap_fill(args.prompt, args.confirm)))


if __name__ == "__main__":
    main()
