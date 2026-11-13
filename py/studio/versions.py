"""
FILE: py/studio/versions.py
PURPOSE: Versions of a reel: what went out, what was made better, and why. A reel that is approved (and maybe booked)
         keeps posting as it is while a better version is made beside it; a person compares the two and chooses.
OVERVIEW: - snapshot(slug): the reel as it is now becomes a version (v1 the first time), with its review and quality check.
          - recut_plan(slug): a new cut of the same reel where its AI review found a caption over the wrong picture
            (each such shot is searched again with the caption's own words, kept only when it matches clearly better)
            and, when the review scored the opening weak, a stronger first shot. Words, music and length stay.
          - make(slug): renders that cut as a candidate version (its own folder, not the live reel), checks it and has
            the AI reviewer look at it, so before and after can be compared.
          - use(slug, n): a person chose version n: it becomes the reel (files, words for each network, approval), the
            one before stays as a version, and bookings made before it swap to it (server/swap.mjs, versionAt).
          - discard(slug, n), listing(slug), todo(): what the page shows.
DEPENDENCIES: studio.reels (build, package, _register), studio.review_actions (approve), studio.ai (review), studio.library
USAGE: python -m studio versions recut --slug a,b | --booked ; python -m studio versions list --slug a
NOTES: Only a person makes a version the reel (use): the MCP server never calls it. A candidate never changes the live
       reel, its approval or its post files. Each version keeps its three masters, cover, manifest, reel definition and
       review (about 60 MB).
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

from studio.config import DATA

VERS = DATA / "versions"
ASPECTS = ("9x16", "4x5", "16x9")
BETTER = 0.04  # how much better a new shot must match its caption (CLIP cosine) to replace the old one
WEAK_HOOK = 4  # an opening the review scored this or lower gets a stronger first shot
SEASONS = ("spring", "summer", "autumn", "winter")  # a reel of one season keeps to it
_PICKED: dict = {}  # file -> how many re-cuts in this run took it (a clip in five new cuts would repeat in the feed)


def _rank(p: dict, opening: bool = False) -> float:
    """Matching the caption comes first (a re-cut exists to fix a mismatch): each reel already using the clip -0.015
    (at most four), each re-cut of this run that took it -0.03, how good it looks a small nudge (more for an opening).
    With the reel maker's -0.06 a reused 0.31 match lost to a fresh 0.23, and the reviewer found the new cut worse."""
    return (p.get("match", 0) - 0.015 * min(4, len(p.get("usedIn") or [])) - 0.03 * _PICKED.get(p["file"].lower(), 0)
            + (0.01 if opening else 0.004) * ((p.get("aesthetic") or 5) - 5))


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _dir(slug: str, n: int | None = None) -> Path:
    return VERS / slug if n is None else VERS / slug / f"v{n}"


def _meta(slug: str, n: int) -> dict:
    try:
        return json.loads((_dir(slug, n) / "version.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_meta(slug: str, n: int, meta: dict) -> None:
    p = _dir(slug, n) / "version.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


def listing(slug: str) -> list[dict]:
    """Every version of a reel, newest first: {n, status (live | candidate | earlier | discarded), made, why, changes,
    review, qa}."""
    d = _dir(slug)
    if not d.exists():
        return []
    out = [m for m in (_meta(slug, int(p.name[1:])) for p in d.glob("v*") if p.name[1:].isdigit()) if m]
    for m in out:  # its maker was closed mid-render (a session or the studio stopped): not "making" for ever
        if m.get("status") == "making" and _age(m.get("made")) > QUEUE_STALE:
            m.update(status="failed", error="interrupted: the run making it stopped; re-cut it again")
    return sorted(out, key=lambda m: -m["n"])


def _age(at: str | None) -> float:
    try:
        return (datetime.now().astimezone() - datetime.fromisoformat(at)).total_seconds()
    except (TypeError, ValueError):
        return float("inf")


def _next(slug: str) -> int:
    return max([m["n"] for m in listing(slug)] or [0]) + 1


SEARCH_KEEP = 14 * 86400  # a search that found nothing clearly better is tried again after this (the footage grows)


def _searched(slug: str) -> bool:
    """A re-cut search found no clearly better shot, and the review has not changed since."""
    from studio.ai import HOME

    f = _dir(slug) / "searched.json"
    try:
        at = f.stat().st_mtime
    except OSError:
        return False
    import time

    rv = HOME / "reviews" / f"{slug}.json"
    return time.time() - at < SEARCH_KEEP and (not rv.exists() or rv.stat().st_mtime <= at)


def _review_of(slug: str) -> dict | None:
    from studio.ai import HOME

    try:
        r = json.loads((HOME / "reviews" / f"{slug}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return _review_sum(r)


def _review_sum(r: dict | None) -> dict | None:
    if not r:
        return None
    return {"hook": (r.get("hook") or {}).get("score"), "look": (r.get("look") or {}).get("score"), "mismatches": r.get("mismatches") or [],
            "claims": r.get("claims") or [], "summary": r.get("summary") or "", "at": r.get("at")}


def _qa_sum(manifest: dict) -> dict:
    qa = manifest.get("qa") or {}
    bad = [f"{a}: {c['id']} {c['found']}" for a, res in qa.items() for c in res.get("checks", []) if c.get("level") != "ok"]
    return {"ok": not bad, "flags": bad, "lufs": (manifest.get("stats") or {}).get("lufs")}


def snapshot(slug: str, why: str = "the reel as approved") -> dict | None:
    """The reel as it is now, as a version (once: when it already has a live version, that one is returned)."""
    from studio.projects import load
    from studio.publish import review_status

    live = next((m for m in listing(slug) if m["status"] == "live"), None)
    if live:
        return live
    src = DATA / "renders" / f"story-{slug}"
    if not (src / f"{slug}_9x16.mp4").exists():
        return None
    n = _next(slug)
    d = _dir(slug, n)
    d.mkdir(parents=True, exist_ok=True)
    for a in ASPECTS:
        f = src / f"{slug}_{a}.mp4"
        if f.exists():
            shutil.copy2(f, d / f.name)
    for name in ("manifest.json", "hook.jpg", "end.jpg"):
        if (src / name).exists():
            shutil.copy2(src / name, d / name)
    reel = load(slug) or {}
    (d / "reel.json").write_text(json.dumps(reel, ensure_ascii=False, indent=1), encoding="utf-8")
    try:
        manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {}
    meta = {"n": n, "status": "live", "made": datetime.fromtimestamp((src / f"{slug}_9x16.mp4").stat().st_mtime).astimezone().isoformat(timespec="seconds"),
            "why": why, "changes": [], "review": _review_of(slug), "qa": _qa_sum(manifest), "approval": review_status(slug)}
    _write_meta(slug, n, meta)
    return meta


def _at(reel: dict, t: float) -> int:
    acc = 0.0
    for k, s in enumerate(reel["shots"]):
        acc += float(s["sec"])
        if t < acc:
            return k
    return len(reel["shots"]) - 1


def recut_plan(slug: str, review: dict | None = None) -> tuple[dict | None, list[dict]]:
    """A new cut of the reel and what changed in it, or (None, []) when nothing would clearly be better.
    For each caption the review found over the wrong picture, the shot under it is searched again with the caption's
    English words (the library's own search: ranch footage, no faces, not vetoed, not junk); a picture of the same kind
    and season, not already in the reel, that matches the caption clearly better (BETTER) takes its place. A weak
    opening (hook score WEAK_HOOK or lower) gets the clip that best matches the hook line among those that look best."""
    import numpy as np

    from studio.assemble import JUNK_MAX, _src
    from studio.library import _base_items, items, text_embedding
    from studio.projects import load
    from studio.reels import resolve

    reel = load(slug)
    if not reel:
        raise KeyError(slug)
    if review is None:
        from studio.ai import HOME

        try:
            review = json.loads((HOME / "reviews" / f"{slug}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            review = {}
    embs = {str(i["path"]).lower(): e for i, e in _base_items()}
    new = json.loads(json.dumps(reel))
    used = {resolve(s["src"]).name.lower() for s in new["shots"]}
    changes: list[dict] = []
    beats = reel.get("beats") or []

    def line_at(t: float) -> dict | None:
        return next((b for b in beats if b.get("kind") != "end" and float(b.get("startSec", 0)) <= t <= float(b.get("endSec", 0)) + 0.3), None)

    def match_of(path: Path, q: np.ndarray) -> float | None:
        e = embs.get(str(path).lower())
        return float(e @ q) if e is not None else None

    def replace(k: int, query: str, why: str, opening: bool = False) -> None:
        shot = new["shots"][k]
        old = resolve(shot["src"])
        q = text_embedding(query)
        season = str(reel.get("season") or "")  # "mixed" (or none): any season
        before = match_of(old, q)
        filters = {"ranch": True, "noFaces": not reel.get("allowFaces")}
        old_kind = "photo" if old.suffix.lower() in (".jpg", ".jpeg", ".png", ".heic", ".dng") else "video"
        if opening or old_kind == "video":
            filters["kind"] = "video"
        pool = [p for p in items(query, filters, limit=120)
                if p["file"].lower() not in used and "people" not in p["top"] and not p.get("vetoed") and p.get("junk", 0) < JUNK_MAX
                and (p["kind"] != "video" or (p.get("duration") or 0) >= float(shot["sec"]) + 0.8)
                and (season not in SEASONS or not p.get("season") or p.get("season") == season)]
        pool = [p for p in pool if before is None or p.get("match", 0) >= before + BETTER]  # clearly better words-to-picture only
        if not pool:
            return
        best = max(pool, key=lambda p: _rank(p, opening))
        _PICKED[best["file"].lower()] = _PICKED.get(best["file"].lower(), 0) + 1
        used.discard(old.name.lower())
        used.add(best["file"].lower())
        new["shots"][k] = {**{x: v for x, v in shot.items() if x not in ("ai_clip", "ai_foley", "ai_behind", "pan")},
                           "src": _src(best["path"]), "role": f"recut: {query[:80]} (match {best.get('match')})"}
        changes.append({"shot": k + 1, "why": why, "line": query, "from": old.name, "to": Path(best["path"]).name,
                        "matchBefore": round(before, 3) if before is not None else None, "matchAfter": best.get("match")})

    for m in review.get("mismatches") or []:
        try:
            t = float(m.get("at", 0))
        except (TypeError, ValueError):
            continue
        b = line_at(t)
        k = _at(reel, t)
        if b and b.get("en") and not any(c["shot"] == k + 1 for c in changes):
            replace(k, str(b["en"]).replace("\n", " "), f"caption over the wrong picture: {str(m.get('shows') or '')[:120]}")
    hook = (review.get("hook") or {}).get("score")
    first = next((b for b in beats if b.get("kind") == "hook"), None)
    if hook is not None and hook <= WEAK_HOOK and first and first.get("en") and not any(c["shot"] == 1 for c in changes):
        replace(0, str(first["en"]).replace("\n", " "), f"weak opening (hook {hook}/10)", opening=True)
    if not changes:
        return None, []
    new.pop("trace", None)
    new["recut"] = {"from": slug, "at": _now(), "changes": len(changes)}
    return new, changes


def make(slug: str, why: str | None = None, review_it: bool = True) -> dict | None:
    """Render a re-cut of `slug` as a candidate version. None when nothing would clearly be better."""
    from studio.reels import build

    snapshot(slug)
    reel, changes = recut_plan(slug)
    if not reel:  # remembered, so the page does not offer the same search again until the review or footage changes
        (_dir(slug) / "searched.json").write_text(json.dumps({"at": _now()}), encoding="utf-8")
        return None
    n = _next(slug)
    d = _dir(slug, n)
    d.mkdir(parents=True, exist_ok=True)
    (d / "reel.json").write_text(json.dumps(reel, ensure_ascii=False, indent=1), encoding="utf-8")
    meta = {"n": n, "status": "making", "made": _now(), "why": why or "captions matched to their pictures", "changes": changes}
    _write_meta(slug, n, meta)
    try:
        build(slug, reel=reel, out=d, candidate=True)
    except Exception as err:
        meta.update(status="failed", error=str(err)[:400])
        _write_meta(slug, n, meta)
        raise
    manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    meta.update(status="candidate", qa=_qa_sum(manifest))
    for extra in d.glob("raw_*.mp4"):  # the masters are kept; the raw Remotion renders are not needed
        extra.unlink(missing_ok=True)
    if adds_faces(reel, manifest, changes):
        # The library marks a whole clip free of faces; the build checks the moment it uses and found one. A reel that
        # does not allow faces would then need a consent tick it never needed: not offered (12 Nov, two such cuts).
        meta.update(status="notbetter", verdict="faces", why="a new shot shows a face; the live reel has none")
        _write_meta(slug, n, meta)
        return meta
    if review_it:
        try:
            from studio.ai import review_file

            meta["review"] = _review_sum(review_file(slug, d / f"{slug}_9x16.mp4", reel, d / "review.json"))
        except Exception as err:  # no key, over a limit: the version is still made, reviewed later by a person
            meta["reviewError"] = str(err)[:200]
    verdict = better_than(snapshot(slug).get("review") if snapshot(slug) else None, meta.get("review"))
    meta["verdict"] = verdict
    if verdict in ("worse", "same"):  # not offered: no gain is not worth a person's time or a re-upload; kept on record with why
        meta["status"] = "notbetter"
        for f in d.glob("*.mp4"):
            if not f.name.endswith("_9x16.mp4"):
                f.unlink(missing_ok=True)
    _write_meta(slug, n, meta)
    return meta


def adds_faces(reel: dict, manifest: dict, changes: list[dict]) -> bool:
    """A re-cut's swapped shot shows a face (as the build measured it) in a reel that keeps faces out."""
    if reel.get("allowFaces") or reel.get("blurFaces"):
        return False
    swapped = {int(c["shot"]) - 1 for c in changes if str(c.get("shot", "")).isdigit()}
    return any((sh.get("faces") or 0) > 0 for k, sh in enumerate(manifest.get("shots") or []) if k in swapped)


def better_than(before: dict | None, after: dict | None) -> str:
    """"better", "same" or "worse": what the reviewer found in a new cut against the live one. Fewer captions on the
    wrong picture is better; more is worse; as many, the hook and look scores decide (worse by 2 or more is worse).
    Without both reviews: "unknown" (a person decides)."""
    if not before or not after:
        return "unknown"
    a, b = len(before.get("mismatches") or []), len(after.get("mismatches") or [])
    if b < a:
        return "better"
    if b > a:
        return "worse"
    score = lambda r: (r.get("hook") or 0) + (r.get("look") or 0)  # noqa: E731
    d = score(after) - score(before)
    return "better" if d >= 1 else "worse" if d <= -2 else "same"


def use(slug: str, n: int) -> dict:
    """A person chose version n: it becomes the reel. Its files replace the live ones, the posts for each network are
    cut again from them, the reel is approved (the person's choice is the approval) and bookings made before now swap
    to it. The version that was live stays as an earlier version."""
    from studio.projects import save
    from studio.reels import DRAFTS
    from studio.review_actions import approve

    meta = _meta(slug, n)
    if not meta or meta.get("status") not in ("candidate", "earlier", "notbetter"):
        raise ValueError(f"{slug} v{n} is not a version that can be used ({meta.get('status') if meta else 'missing'})")
    live = snapshot(slug)
    d = _dir(slug, n)
    reel = json.loads((d / "reel.json").read_text(encoding="utf-8"))
    from studio.db import connect
    from studio.reels import build

    with connect() as con:  # the consent a person gave for the people on camera stays (the new shots have no faces)
        row = con.execute("SELECT consent FROM drafts WHERE slug = ?", (f"story-{slug}",)).fetchone()
    consent = int(row[0] or 0) if row else 0
    cut = d / "manifest.json"
    faces = json.loads(cut.read_text(encoding="utf-8")).get("stats", {}).get("faces", 0) if cut.exists() else 0
    if faces and not consent and not reel.get("blurFaces"):
        # Checked before anything is replaced: the approval below would refuse it after the build, leaving the new files
        # live and the reel unapproved, so its bookings stop (12 Nov, focus-1107).
        raise ValueError(f"{slug} v{n} shows people's faces and the reel has no consent yet: open the reel, press Consent OK, "
                         "then use this version again. The live reel is unchanged.")
    save(reel)
    build(slug)  # every size and a copy for every network, the normal way (its review sheet says "rendered" until below)
    if consent:
        with connect() as con:
            con.execute("UPDATE drafts SET consent = 1 WHERE slug = ?", (f"story-{slug}",))
    approve(f"story-{slug}")  # review records are the draft's (story-<slug>), as the page approves them
    if (d / "review.json").exists():  # the reviewer's notes now describe the live reel
        from studio.ai import HOME

        shutil.copy2(d / "review.json", HOME / "reviews" / f"{slug}.json")
    if live and live["n"] != n:
        live_meta = _meta(slug, live["n"])
        live_meta["status"] = "earlier"
        _write_meta(slug, live["n"], live_meta)
    meta.update(status="live", usedAt=_now())
    _write_meta(slug, n, meta)
    return {"slug": slug, "n": n, "drafts": str(DRAFTS / slug)}


def discard(slug: str, n: int) -> dict:
    meta = _meta(slug, n)
    if not meta or meta.get("status") != "candidate":
        raise ValueError(f"{slug} v{n} is not a candidate")
    d = _dir(slug, n)
    for f in d.glob("*.mp4"):
        f.unlink(missing_ok=True)
    meta.update(status="discarded", discardedAt=_now())
    _write_meta(slug, n, meta)
    return meta


def used_at(slug: str) -> str | None:
    """When a person last made another version the reel (bookings made before then hold the earlier one)."""
    times = [m.get("usedAt") for m in listing(slug) if m.get("usedAt")]
    return max(times) if times else None


def _first_booking(slug: str) -> str | None:
    from studio.db import connect

    with connect() as con:
        row = con.execute("SELECT MIN(at) FROM posts WHERE slug = ? AND status IN ('scheduled', 'queued') AND at >= ?",
                          (slug, datetime.now().isoformat(timespec="minutes"))).fetchone()
    return row[0] if row else None


QUEUE_STALE = 45 * 60  # a run that has not started a reel for this long is gone (closed, crashed)


def queue_note(slugs: list[str]) -> Path:
    """A re-cut run (from the page or the command line) says which reels it still has to do, refreshed at every reel, so
    the page shows them as in line instead of offering to start them again."""
    import os

    f = VERS / f"queue-{os.getpid()}.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"slugs": slugs, "at": _now()}), encoding="utf-8")
    return f


def queued() -> set[str]:
    import time

    out: set[str] = set()
    for f in VERS.glob("queue-*.json") if VERS.exists() else []:
        try:
            if time.time() - f.stat().st_mtime > QUEUE_STALE:
                f.unlink(missing_ok=True)
                continue
            out.update(json.loads(f.read_text(encoding="utf-8")).get("slugs") or [])
        except (OSError, ValueError):
            continue
    return out


def todo() -> dict:
    """For the Posting page: candidates waiting for a person, and booked reels whose review still finds captions over
    the wrong picture with no candidate made yet."""
    from studio.levels import booked

    slugs = booked(approved_only=False)  # a reel a failed "Use" left unapproved stays here, so it can be pressed again
    ready, open_, kept = [], [], []
    inline = queued()
    for slug in slugs:
        vs = listing(slug)
        cand = next((m for m in vs if m["status"] == "candidate"), None)
        live = next((m for m in vs if m["status"] == "live"), None)
        if cand:
            ready.append({"slug": slug, "n": cand["n"], "live": (live or {}).get("n"), "why": cand.get("why"), "changes": cand.get("changes") or [], "verdict": cand.get("verdict"),
                          "before": (live or {}).get("review") or _review_of(slug), "after": cand.get("review"), "qa": cand.get("qa"),
                          "first": _first_booking(slug)})
            continue
        if any(m["status"] == "making" for m in vs) or slug in inline:
            continue
        tried = next((m for m in vs if m["status"] in ("notbetter", "discarded")), None)
        if tried:  # a re-cut was made and was not better (or a person kept the live one): not offered again
            kept.append({"slug": slug, "n": tried["n"], "status": tried["status"], "after": tried.get("review")})
            continue
        if _searched(slug):  # the footage has no clearly better shot for its captions: it stays as it is
            kept.append({"slug": slug, "n": None, "status": "nocut", "after": None})
            continue
        r = _review_of(slug)
        if r and (r["mismatches"] or (r["hook"] is not None and r["hook"] <= WEAK_HOOK)):
            open_.append({"slug": slug, "mismatches": len(r["mismatches"]), "hook": r["hook"]})
    ready.sort(key=lambda x: x.get("first") or "9")  # the one going out soonest first
    return {"ready": ready, "open": open_, "kept": kept, "booked": len(slugs), "inline": len(inline & set(slugs))}
