"""Approve refuses a face without consent, and a draft with no master."""
import os

import pytest

os.environ.setdefault("STUDIO_DATA", os.environ.get("STUDIO_DATA", str(__import__("pathlib").Path(__import__("tempfile").gettempdir()) / "studio-test-data")))

from studio.db import connect
from studio.review_actions import approve, consent


def test_approve_blocks_faces():
    with connect() as con:
        con.execute("DELETE FROM drafts WHERE slug = 'unit-face'")
        con.execute(
            """INSERT INTO drafts (slug, recipe, edl_json, status, faces, consent, render_natural, created_at)
               VALUES ('unit-face', 'day', '{}', 'rendered', 1, 0, 'missing.mp4', '2026-11-07')"""
        )
    with pytest.raises(SystemExit):
        approve("unit-face")
    consent("unit-face")
    with pytest.raises(SystemExit, match="not rendered"):
        approve("unit-face")


def test_reject_keeps_reason_and_counts_it():
    """Reject in the review queue keeps a one-tap reason with the reel's look; reasons() counts the last 30 days."""
    from datetime import datetime, timedelta

    from studio.review_actions import REASONS, reasons, reject

    with connect() as con:
        con.execute("DELETE FROM rejections")
        con.execute("DELETE FROM drafts WHERE slug LIKE 'unit-rej-%'")
        for s in ("unit-rej-a", "unit-rej-b", "unit-rej-c"):
            con.execute("INSERT INTO drafts (slug, status, created_at) VALUES (?, 'rendered', '2026-11-24')", (s,))
    out = reject("unit-rej-a", "  the opening says nothing  ", "weak-hook", "film")
    assert out["reason"] == "weak-hook" and out["note"] == "the opening says nothing"
    reject("unit-rej-b", "", "wrong-clip", "iris")
    reject("unit-rej-c", "too dark")  # a note with no reason still counts, as "note"
    with connect() as con:
        row = con.execute("SELECT status, notes FROM drafts WHERE slug = 'unit-rej-a'").fetchone()
        # an old rejection, outside the window
        con.execute("INSERT INTO rejections (slug, reason, note, look, at) VALUES ('unit-rej-old', 'repeats', '', 'film', ?)",
                    ((datetime.now().astimezone() - timedelta(days=45)).isoformat(timespec="seconds"),))
    assert row["status"] == "rejected" and row["notes"] == "the opening says nothing"
    r = reasons(30)
    assert r["total"] == 3
    assert r["by"] == {"weak-hook": 1, "wrong-clip": 1, "repeats": 0, "note": 1}
    assert r["looks"] == {"film": 1, "iris": 1}
    assert [x["slug"] for x in r["recent"]][0] == "unit-rej-c"  # newest first
    assert reasons(60)["by"]["repeats"] == 1
    assert set(REASONS) == {"weak-hook", "wrong-clip", "repeats"}


def test_reject_refuses_an_unknown_reason():
    from studio.review_actions import reject

    with pytest.raises(ValueError, match="reason"):
        reject("unit-rej-a", "", "ugly")


def test_overview_made_view_is_short_and_safe():
    """The overview row carries who made a reel and why it looks that way (Review's chip), never the whole steer."""
    from studio.service import _made_view

    made = {"by": "auto", "at": "2026-11-24T09:00:00+09:00",
            "steer": {"mode": "learned", "why": "Film look did best.", "whyJa": "フィルムが一番。", "picks": [{"look": "film"}]}}
    assert _made_view(made) == {"by": "auto", "at": "2026-11-24T09:00:00+09:00", "mode": "learned", "why": "Film look did best.", "whyJa": "フィルムが一番。"}
    assert _made_view(None) is None and _made_view("auto") is None
    assert _made_view({"by": "person", "steer": "odd"})["mode"] is None
