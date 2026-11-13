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
