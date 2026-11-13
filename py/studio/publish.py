"""
FILE: py/studio/publish.py
PURPOSE: Post a reel from the studio itself to a network the person connected (Accounts page),
         instead of handing the file to that network's website.
OVERVIEW: `connections()` lists every connector with its status and the fields it asks for
          (never the stored secrets). `publish(slug, network, at, post_id)` picks the network's
          file and post text from the reel's drafts, then either posts now, lets the network
          hold the schedule (Facebook), or queues it for the studio to send at `at` (Bluesky).
          `run_due()` sends queued posts whose time has come; the server calls it every minute.
DEPENDENCIES: studio.connectors (one module per network), studio.posting, studio.reels
USAGE: python -m studio publish SLUG NETWORK [--at 2026-11-15T19:00+09:00] [--id 12]
       python -m studio publish --due
NOTES: A post the network refuses is kept as "failed" with the reason, so it shows in Posting.
       Each run prints "RESULT {json}" for the server's task runner.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from studio import posting

# A time closer than this is "now": networks refuse schedules a few minutes out.
SOON = timedelta(minutes=10)


def _now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def _registry() -> dict:
    from studio.connectors import REGISTRY
    return REGISTRY


def connections(port: int = 4317) -> dict:
    out = {}
    for net, mod in _registry().items():
        try:
            st = mod.status()
        except Exception as err:  # a broken token must not hide the other networks
            st = {"connected": False, "account": None, "error": str(err)}
        try:
            one = mod.signin(port) if hasattr(mod, "signin") else None
        except Exception:
            one = None
        out[net] = {"name": mod.NAME, "how": mod.HOW, "fields": mod.FIELDS, "links": getattr(mod, "LINKS", []), "canSchedule": bool(mod.can_schedule),
                    "signin": one, **st}
    return out


def start(net: str, fields: dict, port: int) -> dict:
    """One-click connect: {"url"} of the network's own sign-in page; it returns to /oauth/<net>."""
    mod = _module(net)
    if not hasattr(mod, "start_signin"):
        raise ValueError(f"{mod.NAME} has no sign-in button yet; use the other way")
    return mod.start_signin({k: str(v).strip() for k, v in (fields or {}).items()}, port)


def finish(net: str, params: dict, port: int) -> dict:
    return _module(net).finish_signin(params or {}, port)


def setup(net: str, fields: dict) -> dict:
    """One-time setup a sign-in button needs first (Facebook: the owner's Meta app)."""
    mod = _module(net)
    if not hasattr(mod, "setup"):
        raise ValueError(f"{mod.NAME} needs no setup")
    return mod.setup({k: str(v).strip() for k, v in (fields or {}).items()})


def connect(net: str, fields: dict) -> dict:
    mod = _module(net)
    return mod.connect({k: str(v).strip() for k, v in (fields or {}).items()})


def disconnect(net: str) -> None:
    _module(net).disconnect()


def _module(net: str):
    reg = _registry()
    if net not in reg:
        raise ValueError(f"{net} cannot be posted from the studio yet; use its upload page")
    return reg[net]


def file_for(slug: str, net: str) -> tuple[Path, str]:
    """The network's video (the first full-size one; a lighter "_web" copy only when nothing else fits) and post text."""
    from studio.reels import CHANNELS, _channel_info

    ch = next((c for c in _channel_info(slug) if c["name"] == net), None)
    if not ch or not ch["videos"]:
        raise ValueError(f"{slug} has no {net} file yet: open the reel's post panel and press Prepare files")
    cap = float((CHANNELS.get(net) or {}).get("maxMb") or 0)
    full = [v for v in ch["videos"] if not v["file"].endswith("_web.mp4")]
    fits = [v for v in full + [v for v in ch["videos"] if v not in full] if not cap or v["mb"] <= cap]
    pick = (fits or full or ch["videos"])[0]
    text = (ch["post"] or "").strip()
    if not text:
        raise ValueError(f"{slug} has no {net} post text: Prepare files makes it")
    return Path(ch["dir"]) / pick["file"], text


def _when(at: str | None) -> datetime | None:
    if not at:
        return None
    t = datetime.fromisoformat(at)
    return t if t.tzinfo else t.astimezone()


class NotApproved(ValueError):
    """The reel's review status is not "approved": nothing is sent."""


def review_status(slug: str) -> str | None:
    from studio.db import connect

    with connect() as con:
        row = con.execute("SELECT status FROM drafts WHERE slug = ?", (f"story-{slug}",)).fetchone()
    return row[0] if row else None


def assert_approved(slug: str) -> None:
    """Only approved reels go out, whoever asks (the page, the MCP server, a queued post). Same words as the
    Chrome helper's refusal (server/helper.mjs scheduleRefusal)."""
    status = review_status(slug)
    if status is None:
        raise NotApproved(f"There is no review record for {slug}, so it cannot be confirmed as approved. Only approved reels are posted.")
    if status != "approved":
        raise NotApproved(f'{slug} is "{status}", not approved. Approve it in the studio first; only approved reels are posted.')


def publish(slug: str, net: str, at: str | None = None, post_id: int | None = None) -> dict:
    assert_approved(slug)
    mod = _module(net)
    st = mod.status()
    if not st.get("connected"):
        raise ValueError(f"{mod.NAME} is not connected: Accounts › {mod.NAME} › Connect")
    when = _when(at)
    later = bool(when and when - _now() > SOON)
    video, text = file_for(slug, net)  # fail early, before anything is queued
    if later and not mod.can_schedule:
        if post_id:
            posting.retire(post_id)  # a missed post stays as history; a planned or failed one is replaced
        pid = posting.queue(slug, net, when.isoformat(timespec="minutes"))
        return {"id": pid, "status": "queued", "at": when.isoformat(timespec="minutes"), "network": net, "slug": slug}
    if not post_id:
        post_id = posting.record(slug, net, "queued", (when if later else _now()).isoformat(timespec="minutes"))
    try:
        out = mod.post(video, text, when if later else None)
    except Exception as err:
        posting.settle(post_id, "failed", note=str(err)[:400])
        raise RuntimeError(f"{mod.NAME} refused the post: {err}") from err
    status = "scheduled" if later and out.get("scheduled") else "posted"
    posting.settle(post_id, status, out.get("url", ""), str(out.get("remote_id", "")))
    if status == "posted":
        posting.done(post_id, out.get("url", ""))  # stamps the time it actually went out
    return {"id": post_id, "status": status, "url": out.get("url", ""), "network": net, "slug": slug}


# Networks the studio replaces itself; the others are booked in your Chrome (studio.helper, server/helper.mjs).
REPLACE_API = ("facebook", "youtube", "bluesky")


def replace(post_id: int) -> dict:
    """Swap one booking for the reel's current render, at the same time: delete it on the network, book the new
    file, and mark the old row "replaced". Only approved reels; only bookings that have not gone out yet."""
    row = next((p for p in posting.posts() if int(p["id"]) == int(post_id)), None)
    if not row:
        raise ValueError(f"no booking {post_id}")
    slug, net, at = row["slug"], row["network"], row["at"]
    assert_approved(slug)
    when = _when(at)
    if row["status"] not in ("scheduled", "queued") or not when or when - _now() < SOON:
        raise ValueError(f"booking {post_id} is {row['status']} at {at}: only a booking more than a few minutes away can be replaced")
    if net == "bluesky":
        # The studio sends Bluesky itself at the time, from the reel's current files: nothing to swap.
        return {"id": post_id, "status": row["status"], "network": net, "slug": slug, "note": "Bluesky sends the new render at its time"}
    if net == "facebook":
        from studio.connectors import facebook

        facebook.delete(row.get("remote_id") or "")
        posting.settle(post_id, "replaced", note="replaced by a new render")
        out = publish(slug, net, when.isoformat(timespec="minutes"))
        return {**out, "replaced": post_id}
    if net == "youtube":
        from studio import youtube

        youtube.delete_video(row.get("remote_id") or "")
        posting.settle(post_id, "replaced", note="replaced by a new render")
        out = youtube.upload(slug, at=when.astimezone().strftime("%Y-%m-%dT%H:%M"), force=True)
        return {**out, "network": net, "slug": slug, "replaced": post_id}
    raise ValueError(f"{net} is booked in your Chrome: use Replace on the Posting page (the helper swaps it there)")


def run_due() -> list[dict]:
    """Send every queued post whose time has come; one failure does not stop the rest. First, a post that came due
    while the studio was not running and is more than the catch-up grace late is marked missed instead of being
    sent days late by surprise (studio.live.catch_up)."""
    from studio import live

    results = []
    for pid in live.catch_up()["missed"]:
        results.append({"id": pid, "status": "missing", "error": "missed while the studio was not running"})
    for row in posting.due():
        try:
            results.append(publish(row["slug"], row["network"], None, int(row["id"])))
        except NotApproved as err:
            # A reel sent back to review (new words, a new render) waits in the queue instead of failing:
            # it goes out on the next run after a person approves it again.
            results.append({"id": row["id"], "status": "held", "error": str(err), "network": row["network"], "slug": row["slug"]})
        except Exception as err:
            results.append({"id": row["id"], "status": "failed", "error": str(err), "network": row["network"], "slug": row["slug"]})
    return results
