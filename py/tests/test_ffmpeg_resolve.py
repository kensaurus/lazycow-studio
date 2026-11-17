"""The one ffmpeg rule in Python (studio.config, same as server/health.mjs resolveTool): STUDIO_FFMPEG, then the tools
folder, then PATH only when new enough. A 2021 ffmpeg on PATH is refused with the reason, never used silently.
No real ffmpeg: the file system, PATH and `ffmpeg -version` are injected."""
from pathlib import Path

import pytest

from studio import config
from studio.config import MIN_FFMPEG, FfmpegTooOld, parse_ffmpeg_version, resolve_tool

GIT_2021 = ("ffmpeg version 2021-06-23-git-947122f111-full_build-www.gyan.dev Copyright (c) 2000-2021\n"
            "libavcodec     59.  0.100 / 59.  0.100\n")
BREW = "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\n"
UBUNTU_2204 = "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021\nlibavcodec     58.134.100 / 58.134.100\n"


def test_versions_from_release_and_git_builds():
    assert parse_ffmpeg_version("ffmpeg version 9.0.2-essentials_build-www.gyan.dev")[:2] == (9, 0)
    assert parse_ffmpeg_version(BREW)[2] == "7.1.1"
    assert parse_ffmpeg_version(UBUNTU_2204)[:2] == (4, 4)
    assert parse_ffmpeg_version("ffmpeg version n7.1-2-gabc")[:2] == (7, 1)
    assert parse_ffmpeg_version(GIT_2021)[:2] == (4, 4)  # libavcodec 59.0: after 4.4, before 5.0
    assert parse_ffmpeg_version("ffmpeg version N-1-gabc\nlibavcodec     59. 37.100 /")[:2] == (5, 1)
    assert parse_ffmpeg_version("ffmpeg version N-1-gabc\nlibavcodec     63.  9.100 /")[0] == 9
    assert parse_ffmpeg_version("nothing") is None
    assert MIN_FFMPEG == (5, 1)


def _machine(files=(), on_path=None, versions=None):
    ran = []

    def run(p):
        ran.append(p)
        return (versions or {}).get(p, "")

    return {"exists": lambda p: p in files, "which": lambda exe: (on_path or {}).get(exe), "run": run}, ran


def test_order_env_then_tools_then_path():
    m, ran = _machine(files={"/env/ffmpeg", str(Path("/tools") / "ffmpeg")}, on_path={"ffmpeg": "/usr/bin/ffmpeg"},
                      versions={"/usr/bin/ffmpeg": BREW})
    r = resolve_tool("ffmpeg", env={"STUDIO_FFMPEG": "/env/ffmpeg"}, tools="/tools", windows=False, **m)
    assert (r["source"], r["path"]) == ("env", "/env/ffmpeg")
    r = resolve_tool("ffmpeg", env={}, tools="/tools", windows=False, **m)
    assert (r["source"], r["path"]) == ("tools", str(Path("/tools") / "ffmpeg"))
    r = resolve_tool("ffmpeg", env={}, tools="/empty", windows=False, **m)
    assert (r["source"], r["path"], r["version"], r["too_old"]) == ("path", "/usr/bin/ffmpeg", "7.1.1", False)
    assert ran == ["/usr/bin/ffmpeg"], "only a PATH ffmpeg is run to read its version"


def test_tools_folder_uses_exe_only_on_windows():
    m, _ = _machine(files={str(Path("D:/data/bin") / "ffmpeg.exe")})
    assert resolve_tool("ffmpeg", env={}, tools="D:/data/bin", windows=True, **m)["source"] == "tools"
    assert resolve_tool("ffmpeg", env={}, tools="D:/data/bin", windows=False, **m)["path"] is None
    m, _ = _machine(files={str(Path("/home/a/bin") / "ffprobe")})
    assert resolve_tool("ffprobe", env={}, tools="/home/a/bin", windows=False, **m)["source"] == "tools"


def test_old_path_ffmpeg_is_too_old_and_unreadable_is_not_trusted():
    m, _ = _machine(on_path={"ffmpeg.exe": r"C:\ffmpeg\bin\ffmpeg.exe"}, versions={r"C:\ffmpeg\bin\ffmpeg.exe": GIT_2021})
    r = resolve_tool("ffmpeg", env={}, tools="D:/none", windows=True, **m)
    assert (r["source"], r["too_old"]) == ("path", True)
    m, _ = _machine(on_path={"ffmpeg": "/usr/bin/ffmpeg"})  # prints nothing we can read
    assert resolve_tool("ffmpeg", env={}, tools="/none", windows=False, **m)["too_old"] is True


def test_ffmpeg_bin_refuses_an_old_path_ffmpeg_with_the_reason(monkeypatch, tmp_path):
    old = tmp_path / "old" / "ffmpeg"
    old.parent.mkdir()
    old.write_text("")
    real = config.resolve_tool

    def fake(name, **kw):  # this PC, minus its tools folder: only an Ubuntu 22.04 ffmpeg on PATH
        kw.update(tools=tmp_path / "empty-tools", env={}, windows=False,
                  which=lambda exe: str(old) if exe == name else None, run=lambda _p: UBUNTU_2204)
        return real(name, **kw)

    monkeypatch.setattr(config, "resolve_tool", fake)
    config._PATH_CHECKED.clear()
    with pytest.raises(FfmpegTooOld) as err:
        config.ffmpeg_bin()
    assert "older than 5.1" in str(err.value) and "4.4.2" in str(err.value)
    assert isinstance(err.value, FileNotFoundError), "code that copes with a missing ffmpeg copes with this one"
    config._PATH_CHECKED.clear()


def test_ffmpeg_bin_prefers_the_tools_folder_over_any_path_ffmpeg(monkeypatch, tmp_path):
    exe = "ffmpeg.exe" if config.os.name == "nt" else "ffmpeg"
    (tmp_path / exe).write_text("")
    monkeypatch.setattr(config, "TOOLS", tmp_path)
    monkeypatch.delenv("STUDIO_FFMPEG", raising=False)
    assert config.ffmpeg_bin() == tmp_path / exe
    monkeypatch.setenv("STUDIO_FFMPEG", str(tmp_path / "mine"))
    assert config.ffmpeg_bin() == tmp_path / "mine"
