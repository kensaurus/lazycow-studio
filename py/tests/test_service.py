"""The editor helper's line protocol: the request number travels as `_rid`, so a command's own `id` survives."""
import io
import json
import sys

from pathlib import Path

import studio.library as library
from studio import service
from studio.db import connect


def test_a_commands_own_id_is_not_overwritten_by_the_request_number(monkeypatch):
    with connect() as con:
        con.execute("INSERT OR REPLACE INTO assets (id, path, kind) VALUES (4242, ?, 'video')", (str(Path("/x/clip_4242.mp4")),))
    monkeypatch.setattr(library, "_model", lambda: None)
    monkeypatch.setattr(library, "usage", lambda: {})
    lines = [json.dumps({"cmd": "asset", "id": 4242, "_rid": 7}), json.dumps({"cmd": "nope", "_rid": 8})]
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n".join(lines) + "\n"))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    service.main()
    replies = [json.loads(x) for x in out.getvalue().splitlines() if x.strip()]
    assert replies[0] == {"ready": True}
    assert replies[1]["_rid"] == 7 and replies[1]["ok"], replies[1]
    assert replies[1]["data"]["file"] == "clip_4242.mp4"
    assert replies[2]["_rid"] == 8 and not replies[2]["ok"]
    # People see a plain sentence; where it happened travels separately for the log.
    assert "service.py" in replies[2]["detail"] and "service.py" not in replies[2]["error"] and "Error:" not in replies[2]["error"]
    assert replies[2]["input"] is True


def test_perf_read_answers_one_reels_numbers_warm_and_refuses_other_actions(monkeypatch):
    """Results › Latest posts asks for six reels' numbers; a cold process each took seconds, so the warm service reads them."""
    from studio import perf
    seen = []
    monkeypatch.setattr(perf, "run", lambda action, req: seen.append((action, req)) or {"posts": []})
    assert service.handle({"cmd": "perf_read", "action": "get", "slug": "aerial-1108"}) == {"posts": []}
    assert seen == [("get", {"slug": "aerial-1108"})]
    try:
        service.handle({"cmd": "perf_read", "action": "collect"})
        raise AssertionError("collect posts nothing but reads the networks: never from the warm read path")
    except ValueError as err:
        assert "get" in str(err)


def test_clip_notes_count_only_what_is_worth_a_look():
    """A card says "N clips to look at" only for a likely filler shot or a poor match to its line.
    Reuse counts only other reels people see (approved or out), and is a note, not a look."""
    reel = {"slug": "me", "shots": [
        {"src": "/f/a.mp4", "role": "auto: a fire (match 0.31)"},    # in 5 drafts and itself: nobody sees those
        {"src": "/f/b.mp4", "role": "auto: a deck (match 0.19)"},    # weak match: a look
        {"src": "/f/c.mp4", "role": "auto: a field (match 0.21)"},   # fair: nothing
        {"src": "/f/d.mp4", "role": "auto: a sky (match 0.30)"},     # filler: a look
        {"src": "/f/e.mp4", "role": "auto: a cow (match 0.30)"},     # in 2 reels that went out: a note
    ]}
    rows = {
        "a.mp4": {"usedIn": ["me", "d1", "d2", "d3", "d4", "d5"]},
        "d.mp4": {"junk": 0.4, "usedIn": []},
        "e.mp4": {"usedIn": ["p1", "p2", "d1"]},
    }
    status = {"d1": {"status": "rendered"}, "d2": {"status": "rejected"}, "p1": {"status": "posted"}, "p2": {"status": "approved"}}
    out = {c["file"]: c for c in service.shot_checks(reel, rows, {}, status)}
    assert "a.mp4" not in out and "c.mp4" not in out, out
    assert out["b.mp4"]["look"] and out["b.mp4"]["flags"] == ["weak match to its line"]
    assert out["d.mp4"]["look"] and "may be a filler shot" in out["d.mp4"]["flags"]
    assert not out["e.mp4"]["look"] and out["e.mp4"]["flags"] == ["also in 2 reels that are approved or out"]
    # a face in the used moment is a note: the card's own consent line covers it
    faces = service.shot_checks({"slug": "x", "shots": [{"src": "/f/a.mp4", "role": ""}]}, {}, {"a.mp4": 2}, {})
    assert faces == [{"i": 0, "file": "a.mp4", "flags": ["a face in the used moment (consent)"], "look": False}]


def test_a_line_that_says_what_its_shots_do_not_show_is_a_look_on_those_shots():
    """reasons-1113: "no buildings outside the window" over a tent in front of the lodge."""
    reel = {"slug": "x", "shots": [{"src": "/f/a.mp4", "sec": 3.0, "role": ""}, {"src": "/f/b.mp4", "sec": 3.0, "role": ""}],
            "beats": [{"kind": "hook", "ja": "TITLE", "startSec": 0.1, "endSec": 2.8},
                      {"kind": "line", "ja": "NO_BUILDINGS", "startSec": 3.1, "endSec": 5.8}]}
    reel["beats"][0]["ja"] = "区画がない"
    reel["beats"][1]["ja"] = "窓の外も、建物は見えません"
    rows = {"a.mp4": {"top": ["field"], "season": "summer", "tod": "day", "usedIn": []},
            "b.mp4": {"top": ["tent", "building"], "season": "summer", "tod": "day", "usedIn": []}}
    out = {c["file"]: c for c in service.shot_checks(reel, rows, {}, {})}
    assert "a.mp4" not in out
    assert out["b.mp4"]["look"] and "does not show" in out["b.mp4"]["flags"][-1]
