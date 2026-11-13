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
