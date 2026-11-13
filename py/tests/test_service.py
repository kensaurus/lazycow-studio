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
