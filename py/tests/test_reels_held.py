"""A draft file Drive is still syncing is tried again before packaging fails (studio.reels._held)."""
import pytest

from studio import reels


def test_a_file_held_for_a_moment_is_tried_again(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise PermissionError("held by another process")
        return "done"

    assert reels._held(flaky) == "done" and len(calls) == 3


def test_a_file_held_for_good_still_fails(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)

    def held():
        raise PermissionError("held")

    with pytest.raises(PermissionError):
        reels._held(held, tries=3)


def test_a_finished_file_a_player_holds_is_replaced_once_it_lets_go(monkeypatch, tmp_path):
    from pathlib import Path

    from studio import held

    monkeypatch.setattr("time.sleep", lambda s: None)
    src, dest = tmp_path / "new.mp4", tmp_path / "reel.mp4"
    src.write_bytes(b"new")
    dest.write_bytes(b"old")
    real, calls = Path.replace, []

    def busy(self, target):
        calls.append(1)
        if len(calls) < 3:
            raise PermissionError(5, "Access is denied")  # the Versions page was playing it
        return real(self, target)

    monkeypatch.setattr(Path, "replace", busy)
    held.replace(src, dest)
    assert dest.read_bytes() == b"new" and len(calls) == 3


def test_a_file_a_page_is_streaming_is_moved_aside_and_the_new_one_takes_its_name(monkeypatch, tmp_path):
    """Windows lets a file a reader holds be renamed but not deleted or replaced: waiting never helps (12 Nov)."""
    from pathlib import Path

    from studio import held

    monkeypatch.setattr("time.sleep", lambda s: None)
    src, dest = tmp_path / "new.mp4", tmp_path / "reel.mp4"
    src.write_bytes(b"new")
    dest.write_bytes(b"old")
    real = Path.replace

    def onto_open_file(self, target):
        if Path(target).exists():
            raise PermissionError(5, "Access is denied")  # dest is open in a page
        return real(self, target)

    monkeypatch.setattr(Path, "replace", onto_open_file)
    held.replace(src, dest)
    assert dest.read_bytes() == b"new"
    assert not list(tmp_path.glob("reel.mp4.old-*"))  # removed (nothing holds it in the test)


def test_a_draft_copy_that_cannot_be_deleted_is_moved_aside_so_the_new_one_can_be_made(monkeypatch, tmp_path):
    from pathlib import Path

    from studio import held

    monkeypatch.setattr("time.sleep", lambda s: None)
    old = tmp_path / "tsumagoi_x_1920x1080.mp4"
    old.write_bytes(b"old")
    monkeypatch.setattr(Path, "unlink", lambda self, missing_ok=False: (_ for _ in ()).throw(PermissionError(5, "Access is denied")))
    held.remove(old)
    assert not old.exists() and list(tmp_path.glob("*.mp4")) == []  # the folder's video list no longer sees it
    assert len(list(tmp_path.glob("tsumagoi_x_1920x1080.mp4.old-*"))) == 1


def test_one_network_whose_old_copy_is_locked_does_not_stop_the_others(monkeypatch, tmp_path, capsys):
    from pathlib import Path

    from studio import held, reels

    monkeypatch.setattr(reels, "DRAFTS", tmp_path / "drafts")
    out = tmp_path / "renders" / "story-r1"
    out.mkdir(parents=True)
    for a in ("9x16", "4x5", "16x9"):
        (out / f"r1_{a}.mp4").write_bytes(b"v")
    monkeypatch.setattr(reels, "DATA", tmp_path)
    monkeypatch.setattr(reels, "get_reel", lambda slug: {"slug": slug})
    monkeypatch.setattr(reels, "post_of", lambda reel: {})
    monkeypatch.setattr(reels, "CHANNELS", {"bluesky": {"files": [{"aspect": "16x9", "w": 1920, "h": 1080}], "cover": (1920, 1080)},
                                            "x": {"files": [{"aspect": "9x16", "w": 1080, "h": 1920}], "cover": (1080, 1920)}})
    monkeypatch.setattr(reels, "wants", lambda reel, spec: True)
    monkeypatch.setattr(reels, "_cover", lambda *a, **k: None)
    monkeypatch.setattr(reels, "_post_text", lambda reel, ch: "")
    (tmp_path / "drafts" / "r1" / "bluesky").mkdir(parents=True)
    stuck = tmp_path / "drafts" / "r1" / "bluesky" / "old.mp4"
    stuck.write_bytes(b"old")

    def locked(path):
        if Path(path).name == "old.mp4":
            raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(held, "remove", locked)
    assert reels.package("r1") == ["x"]
    assert "NOTE bluesky" in capsys.readouterr().out


def test_approval_leaves_out_a_draft_file_drive_has_locked(monkeypatch, tmp_path, capsys):
    import shutil

    from studio import review_actions

    real = shutil.copy2

    def copy(src, dst, **kw):
        if str(src).endswith("locked.mp4"):
            raise PermissionError(13, "Permission denied")
        return real(src, dst, **kw)

    monkeypatch.setattr(shutil, "copy2", copy)
    src = tmp_path / "drafts" / "r" / "bluesky"
    src.mkdir(parents=True)
    (src / "locked.mp4").write_bytes(b"x")
    (src / "post.txt").write_text("words")
    shutil.copytree(tmp_path / "drafts" / "r", tmp_path / "ready", copy_function=review_actions._copy_readable)
    assert (tmp_path / "ready" / "bluesky" / "post.txt").exists() and not (tmp_path / "ready" / "bluesky" / "locked.mp4").exists()
    assert "NOTE bluesky" in capsys.readouterr().out


def test_a_network_share_is_never_opened_as_footage(tmp_path, monkeypatch):
    """Review 13 Nov: only looking at \\host\share makes Windows sign in to that host with the owner's account."""
    import pytest

    from studio import reels

    monkeypatch.setattr(reels, "SOURCE", tmp_path)
    for rel in ("\\\\attacker.example\\s\\a.mp4", "//attacker.example/s/a.mp4"):
        with pytest.raises(FileNotFoundError):
            reels.resolve(rel)
    (tmp_path / "a.mp4").write_bytes(b"x")
    assert reels.resolve("a.mp4") == tmp_path / "a.mp4"


def test_a_pasted_key_with_a_line_break_cannot_add_another_setting(tmp_path, monkeypatch):
    from studio import ai

    monkeypatch.setattr(ai, "ENV_FILE", tmp_path / ".env")
    (tmp_path / ".env").write_text("A=1\n", encoding="utf-8")
    ai._upsert_env("FAL_KEY", "abc\nSTUDIO_PY=C:\\evil.exe\r\n")
    assert (tmp_path / ".env").read_text(encoding="utf-8").splitlines() == ["A=1", "FAL_KEY=abcSTUDIO_PY=C:\\evil.exe"]
