"""studio.levels: a booked reel's sound is moved onto the level in every copy, by gain alone, and only when it is off."""
import json
import subprocess

from studio.config import SPEC, ffmpeg_bin
from studio.verify import parse_ebur128


def _clip(path, amp):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30:duration=5", "-f", "lavfi", "-i", f"anoisesrc=d=5:c=pink:a={amp}",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)], check=True, capture_output=True, timeout=60)


def _lufs(path):
    err = subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True, timeout=60).stderr
    return parse_ebur128(err)


def test_booked_lists_approved_reels_with_a_booking_ahead(tmp_path, monkeypatch):
    """Review records are keyed story-<slug>, bookings by the plain slug: a join on the plain slug found none."""
    import sqlite3
    from contextlib import contextmanager

    from studio import db, levels

    path = tmp_path / "c.sqlite"
    con = sqlite3.connect(path)
    con.executescript(db.SCHEMA)
    con.execute("CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, slug TEXT, network TEXT, status TEXT, at TEXT, remote_id TEXT, url TEXT, note TEXT, created TEXT)")
    con.executemany("INSERT INTO drafts (slug, recipe, edl_json, status, created_at) VALUES (?, '', '{}', ?, '2026-11-01')",
                    [("story-a", "approved"), ("story-b", "rendered"), ("story-c", "approved")])
    con.executemany("INSERT INTO posts (slug, network, status, at, created) VALUES (?, 'x', ?, ?, '2026-11-01')",
                    [("a", "scheduled", "2099-01-02T19:00"), ("b", "scheduled", "2099-01-01T19:00"), ("c", "posted", "2099-01-01T19:00"),
                     ("c", "queued", "2099-01-01T12:00")])
    con.commit()
    con.close()

    @contextmanager
    def fake():
        c = sqlite3.connect(path)
        c.row_factory = sqlite3.Row
        yield c
        c.close()

    monkeypatch.setattr(db, "connect", fake)
    assert levels.booked() == ["c", "a"], "approved ones only, soonest first"
    # Versions lists unapproved ones too: a reel a failed "Use the new version" left unapproved must stay pressable (12 Nov)
    assert levels.booked(approved_only=False) == ["c", "b", "a"]  # c 12:00, b 19:00 on 1 Jan, a on 2 Jan


def test_a_quiet_booked_reel_is_levelled_in_every_copy(tmp_path, monkeypatch):
    from studio import levels, reels

    monkeypatch.setattr(levels, "DATA", tmp_path)
    monkeypatch.setattr(levels, "READY", tmp_path / "ready")
    monkeypatch.setattr(levels, "FIX_FILE", tmp_path / "sound-fixes.json")
    monkeypatch.setattr(reels, "DRAFTS", tmp_path / "drafts")
    slug = "quiet-1"
    out = tmp_path / "renders" / f"story-{slug}"
    for a in ("9x16", "4x5", "16x9"):
        _clip(out / f"{slug}_{a}.mp4", 0.6)
    _clip(tmp_path / "drafts" / slug / "x" / f"t_{slug}_1920x1080.mp4", 0.6)
    _clip(tmp_path / "drafts" / slug / "x" / f"t_{slug}_1080x1920_no-music.mp4", 0.6)
    _clip(tmp_path / "ready" / f"20261110_{slug}" / f"{slug}_9x16.mp4", 0.6)
    before = _lufs(out / f"{slug}_9x16.mp4")
    assert levels.check([slug])[0]["off"], before
    r = levels.fix(slug)
    target = SPEC["loudnessLufs"]
    for p in (out / f"{slug}_9x16.mp4", tmp_path / "drafts" / slug / "x" / f"t_{slug}_1920x1080.mp4", tmp_path / "ready" / f"20261110_{slug}" / f"{slug}_9x16.mp4"):
        got = _lufs(p)
        assert abs(got["lufs"] - target) <= 1.0 and got["truePeak"] <= -1.0, (p.name, got)
    assert abs(_lufs(tmp_path / "drafts" / slug / "x" / f"t_{slug}_1080x1920_no-music.mp4")["lufs"] - before["lufs"]) < 0.3, "the clip-only copy is left alone"
    assert (out / f"{slug}_9x16.orig.mp4").exists(), "the master as it was is kept"
    assert r["noticeable"] and levels.fixed_at(slug), "a big fix makes older bookings swap"
    assert json.loads((tmp_path / "sound-fixes.json").read_text(encoding="utf-8"))[slug]["files"] >= 5
    assert levels.fix(slug)["changed"] == 0, "on target now: left alone"
    # Made worse by hand (an encode of an encode): the next fix starts again from the sound as rendered.
    _clip(tmp_path / "loud.mp4", 0.9)
    m = out / f"{slug}_9x16.mp4"
    subprocess.run([str(ffmpeg_bin()), "-y", "-i", str(m), "-i", str(tmp_path / "loud.mp4"), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
                    "-shortest", str(tmp_path / "x.mp4")], check=True, capture_output=True, timeout=60)
    (tmp_path / "x.mp4").replace(m)
    assert levels.check([slug])[0]["off"]
    levels.fix(slug)
    got = _lufs(m)
    assert abs(got["lufs"] - target) <= 1.0 and got["truePeak"] <= -1.0, got
