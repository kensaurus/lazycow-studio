"""Renders read from a folder of links, so Remotion never copies the long videos' working files (15 Nov: 104 GB a reel)."""
import os
import time

from studio import remotion


def test_public_dir_links_each_folder_and_copies_small_files(tmp_path, monkeypatch):
    (tmp_path / "public" / "mezz" / "vlog-1").mkdir(parents=True)
    (tmp_path / "public" / "mezz" / "vlog-1" / "big.mp4").write_bytes(b"x" * 10)
    (tmp_path / "public" / "fonts").mkdir()
    (tmp_path / "public" / "logo.png").write_bytes(b"png")
    monkeypatch.setattr(remotion, "ROOT", tmp_path)
    out = remotion.public_dir()
    mezz = out / "mezz"
    assert mezz.is_symlink() or getattr(mezz, "is_junction", lambda: False)() or os.path.realpath(mezz) != str(mezz)
    assert (mezz / "vlog-1" / "big.mp4").read_bytes() == b"x" * 10  # the same file, reached through the link
    assert (out / "logo.png").read_bytes() == b"png"
    assert remotion.public_dir() == out  # a second call leaves the links alone


def test_render_cmd_points_remotion_at_the_linked_folder(tmp_path, monkeypatch):
    (tmp_path / "public").mkdir()
    monkeypatch.setattr(remotion, "ROOT", tmp_path)
    monkeypatch.setattr(remotion, "tidy_bundles", lambda: 0)
    cmd = remotion.render_cmd("Story-9x16", tmp_path / "p.json", tmp_path / "o.mp4", "--concurrency=4")
    assert f"--public-dir={tmp_path / '.remotion-public'}" in cmd and cmd[-1] == "--concurrency=4"


def test_only_stale_bundles_are_tidied(tmp_path, monkeypatch):
    monkeypatch.setattr(remotion.tempfile, "gettempdir", lambda: str(tmp_path))
    old, new, other = tmp_path / "remotion-webpack-bundle-old", tmp_path / "remotion-webpack-bundle-new", tmp_path / "keep-me"
    for d in (old, new, other):
        d.mkdir()
    long_ago = time.time() - remotion.STALE_BUNDLE_S - 60
    os.utime(old, (long_ago, long_ago))
    os.utime(other, (long_ago, long_ago))
    assert remotion.tidy_bundles() == 1
    assert not old.exists() and new.exists() and other.exists()
