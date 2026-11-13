"""
FILE: py/studio/posting.py
PURPOSE: The posting log: what is planned, what is scheduled, what went out, and where.
OVERVIEW: One `posts` table in the catalog. YouTube rows are written by studio.youtube
          when it uploads. Every other network is posted by a person: the studio keeps a
          planned time (the reminder), and "Mark posted" stores the live link.
          `skip(slug)` marks a reel "not to be posted" (network "all", status "skipped").
          `ics()` turns a plan into a calendar reminder file.
DEPENDENCIES: studio.db
USAGE: python -m studio posts list | plan SLUG NETWORK --at 2026-11-08T19:00 |
       done ID --url URL | drop ID | ics ID
NOTES: Times are local ISO strings (this PC's time zone). Only planned rows can be
       dropped; a posted or scheduled row stays as the record of what went out.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from studio.db import connect

NETWORKS = ("youtube", "instagram", "threads", "facebook", "tiktok", "x", "linkedin", "gbp", "line-voom", "line-oa", "pinterest", "bluesky", "xiaohongshu", "kensaurus", "zenn", "note")

POSTS_SQL = """
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL,          -- planned | scheduled | queued | posted | missing | failed | replaced | skipped
  at TEXT,                       -- planned or scheduled time (local ISO), or when it went out
  remote_id TEXT,
  url TEXT,
  note TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS posts_slug ON posts(slug, network);
"""


def _ready(con) -> None:
    con.executescript(POSTS_SQL)
    # seen_at: when the post was seen live on the network (studio.live); empty = not confirmed yet.
    if "seen_at" not in {r[1] for r in con.execute("PRAGMA table_info(posts)")}:
        con.execute("ALTER TABLE posts ADD COLUMN seen_at TEXT")


def with_offset(at: str | None) -> str | None:
    """A time with its UTC offset. A bare "2026-11-10T18:00" is this computer's local time (the page reads it so too);
    stored with the offset, every reader agrees whatever the computer's or the audience's time zone."""
    if not at:
        return at
    from datetime import datetime

    try:
        t = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return at
    return (t if t.tzinfo else t.astimezone()).isoformat(timespec="minutes")


def record(slug: str, network: str, status: str, at: str | None = None, remote_id: str | None = None, url: str | None = None, note: str = "") -> int:
    at = with_offset(at)
    with connect() as con:
        _ready(con)
        cur = con.execute("INSERT INTO posts (slug, network, status, at, remote_id, url, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                          (slug, network, status, at, remote_id, url, note))
        return int(cur.lastrowid)


def posts() -> list[dict]:
    with connect() as con:
        _ready(con)
        return [dict(r) for r in con.execute("SELECT * FROM posts ORDER BY COALESCE(at, created) DESC, id DESC")]


def _check_time(at: str) -> str:
    return datetime.fromisoformat(at).isoformat(timespec="minutes")


def plan(slug: str, network: str, at: str, note: str = "") -> int:
    if network not in NETWORKS:
        raise ValueError(f"network: one of {', '.join(NETWORKS)}")
    return record(slug, network, "planned", _check_time(at), note=note)


def _went_out_at(row_status: str, row_at: str | None, at: str | None) -> str:
    """When a post went out: the time given; else its scheduled time if that has passed (it went out by
    itself then, and "Mark posted" is pressed later); else now. Keeps the posting hour honest for learning."""
    if at:
        return _check_time(at)
    if row_status == "scheduled" and row_at:
        try:
            when = datetime.fromisoformat(row_at)
            now = datetime.now(when.tzinfo) if when.tzinfo else datetime.now()
            if when <= now:
                return row_at
        except ValueError:
            pass
    return datetime.now().isoformat(timespec="minutes")


def done(post_id: int, url: str = "", at: str | None = None) -> None:
    if url and not url.startswith("https://"):
        raise ValueError("the link must start with https://")
    with connect() as con:
        _ready(con)
        row = con.execute("SELECT status, at FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise KeyError(post_id)
        con.execute("UPDATE posts SET status = 'posted', url = COALESCE(NULLIF(?, ''), url), at = ? WHERE id = ?",
                    (url, _went_out_at(row["status"], row["at"], at), post_id))


def link(post_id: int, url: str) -> None:
    """Add or fix the link to a post that is out (or booked), without touching its time or state."""
    if not url.startswith("https://"):
        raise ValueError("the link must start with https://")
    with connect() as con:
        _ready(con)
        row = con.execute("SELECT status FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise KeyError(post_id)
        con.execute("UPDATE posts SET url = ? WHERE id = ?", (url, post_id))


def booked(post_id: int, url: str = "", at: str | None = None) -> None:
    """Scheduled in the network's own tool (Business Suite, TikTok, LinkedIn): it will go out by itself at `at`."""
    if url and not url.startswith("https://"):
        raise ValueError("the link must start with https://")
    with connect() as con:
        _ready(con)
        row = con.execute("SELECT status, at FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise KeyError(post_id)
        if row["status"] == "posted":
            raise ValueError("this one already went out")
        con.execute("UPDATE posts SET status = 'scheduled', url = COALESCE(NULLIF(?, ''), url), at = ? WHERE id = ?",
                    (url, _check_time(at) if at else row["at"], post_id))


def move(post_id: int, at: str) -> str:
    """Move a booking the studio holds itself (queued: the studio sends it; planned: a reminder) to another time.
    A booking already on a network is moved there, not here. One post per network per day still holds."""
    when = datetime.fromisoformat(with_offset(at))
    if when.timestamp() < datetime.now(timezone.utc).timestamp() + 15 * 60:
        raise ValueError("pick a time at least 15 minutes from now")
    with connect() as con:
        _ready(con)
        row = con.execute("SELECT status, network FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise KeyError(post_id)
        if row["status"] not in ("queued", "planned"):
            raise ValueError("this one is booked on the network itself: move it there (only posts the studio sends, and reminders, move here)")
        for other in con.execute("SELECT at FROM posts WHERE network = ? AND id != ? AND status IN ('scheduled', 'queued', 'planned') AND at IS NOT NULL",
                                 (row["network"], post_id)):
            try:
                o = datetime.fromisoformat(with_offset(other["at"]))
            except ValueError:
                continue
            if o.astimezone(when.tzinfo).date() == when.date():
                name = {"x": "X", "gbp": "Google Maps", "line-oa": "LINE", "youtube": "YouTube", "tiktok": "TikTok", "linkedin": "LinkedIn",
                        "facebook": "Facebook", "bluesky": "Bluesky", "threads": "Threads", "pinterest": "Pinterest"}.get(row["network"], row["network"])
                raise ValueError(f"{name} already has a post that day (one a day)")
        stored = when.isoformat(timespec="minutes")
        con.execute("UPDATE posts SET at = ? WHERE id = ?", (stored, post_id))
    return stored


def retire(post_id: int) -> None:
    """Make room for a new booking of the same reel: a planned, queued or failed row is removed (as drop); a missing
    one (studio.live: not seen after its time) stays as history, "replaced", so the log keeps what happened."""
    with connect() as con:
        _ready(con)
        row = con.execute("SELECT status, note FROM posts WHERE id = ?", (post_id,)).fetchone()
    if row and row["status"] == "missing":
        note = (row["note"] or "").strip()
        settle(post_id, "replaced", note=(note + " · " if note else "") + "booked again")
        return
    drop(post_id)


def drop(post_id: int) -> None:
    with connect() as con:
        _ready(con)
        row = con.execute("SELECT status FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise KeyError(post_id)
        if row["status"] not in ("planned", "queued", "failed"):
            raise ValueError("only a planned post can be removed; this one already went out")
        con.execute("DELETE FROM posts WHERE id = ? AND status IN ('planned', 'queued', 'failed')", (post_id,))


def queue(slug: str, network: str, at: str) -> int:
    """The studio itself posts this at `at` (a connected network that cannot hold a schedule, e.g. Bluesky)."""
    if network not in NETWORKS:
        raise ValueError(f"network: one of {', '.join(NETWORKS)}")
    return record(slug, network, "queued", _check_time(at))


def due(now: datetime | None = None) -> list[dict]:
    """Queued rows whose time has come. Times carry their offset; a naive one is this PC's zone."""
    now = now or datetime.now(timezone.utc).astimezone()
    out = []
    for r in posts():
        if r["status"] != "queued" or not r["at"]:
            continue
        at = datetime.fromisoformat(r["at"])
        if at.tzinfo is None:
            at = at.astimezone()
        if at <= now:
            out.append(r)
    return out


def settle(post_id: int, status: str, url: str = "", remote_id: str = "", note: str = "") -> None:
    """What happened to a post the studio sent: posted, scheduled (the network holds it) or failed (note says why)."""
    if status not in ("posted", "scheduled", "failed", "replaced", "missing"):
        raise ValueError("status: posted, scheduled, failed, replaced or missing")
    with connect() as con:
        _ready(con)
        con.execute("UPDATE posts SET status = ?, url = COALESCE(NULLIF(?, ''), url), remote_id = COALESCE(NULLIF(?, ''), remote_id), note = ? WHERE id = ?",
                    (status, url, remote_id, note, post_id))


def skip(slug: str, on: bool = True) -> None:
    """Not to be posted: one row (network "all", status "skipped"). Off removes it."""
    with connect() as con:
        _ready(con)
        con.execute("DELETE FROM posts WHERE slug = ? AND network = 'all' AND status = 'skipped'", (slug,))
        if on:
            con.execute("INSERT INTO posts (slug, network, status, at) VALUES (?, 'all', 'skipped', ?)",
                        (slug, datetime.now().isoformat(timespec="minutes")))


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def ics(post_id: int) -> str:
    """A calendar reminder for one planned post (Outlook, Google Calendar import, phone)."""
    row = next((p for p in posts() if p["id"] == post_id), None)
    if not row or not row["at"]:
        raise KeyError(post_id)
    start = datetime.fromisoformat(row["at"])
    if start.tzinfo is None:
        start = start.astimezone()
    start = start.astimezone(timezone.utc)
    end = start + timedelta(minutes=15)
    fmt = "%Y%m%dT%H%M%SZ"
    stamp = datetime.now(timezone.utc).strftime(fmt)
    title = f"Post {row['slug']} on {row['network']}"
    from studio.config import RANCH, READY

    where = "Drive tsumagoi-video-edit-sns › ready" if RANCH else str(READY)
    body = f"Files and post text: {where} › {row['slug']} › {row['network']}. Then press Mark posted in Lazycow Studio."
    return "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tsumagoi Studio//posting plan//EN", "BEGIN:VEVENT",
        f"UID:tsumagoi-post-{row['id']}@studio.local", f"DTSTAMP:{stamp}", f"DTSTART:{start.strftime(fmt)}", f"DTEND:{end.strftime(fmt)}",
        f"SUMMARY:{_esc(title)}", f"DESCRIPTION:{_esc(body)}",
        "BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_esc(title)}", "TRIGGER:-PT10M", "END:VALARM",
        "END:VEVENT", "END:VCALENDAR", "",
    ])
