"""Colour match and stabilisation between shots (studio.shot, studio.reels.shot_looks)."""
from pathlib import Path

import os
import numpy as np
import pytest

from studio import shot

STATS = {"L": 55.0, "a": 4.0, "b": 9.0, "aStd": 8.0, "bStd": 10.0, "luma": 0.45}


def test_correction_is_identity_at_the_target():
    corr = shot.color_correction(STATS, dict(STATS))
    assert corr == {"gains": [1.0, 1.0, 1.0], "luma": 1.0, "filter": ""}
    assert shot.color_correction(None, STATS)["filter"] == ""


def test_correction_is_clamped():
    far = {"L": 40.0, "a": 30.0, "b": 45.0, "aStd": 8.0, "bStd": 10.0, "luma": 0.20}
    corr = shot.color_correction(far, {**STATS, "a": -20.0, "b": -30.0, "luma": 0.60})
    assert all(0.92 - 1e-9 <= g <= 1.08 + 1e-9 for g in corr["gains"])
    assert 0.94 - 1e-9 <= corr["luma"] <= 1.06 + 1e-9
    assert corr["filter"].startswith("colorchannelmixer=rr=")
    assert corr["gains"][2] > corr["gains"][0]  # a warm cast is pulled toward blue


def test_correction_moves_the_cast_toward_the_target_and_keeps_luma():
    warm = {**STATS, "a": 6.0, "b": 14.0}
    corr = shot.color_correction(warm, STATS)
    r, g, b = corr["gains"]
    assert b > 1.0 > r  # less red/yellow, more blue
    assert abs(0.299 * r + 0.587 * g + 0.114 * b - 1.0) < 0.02  # colour only, no brightness change at equal luma


def test_target_is_the_median():
    rows = [{**STATS, "a": a, "luma": l} for a, l in ((1.0, 0.3), (5.0, 0.5), (9.0, 0.9))]
    target = shot.match_target(rows + [None])
    assert target["a"] == 5.0 and target["luma"] == 0.5
    assert shot.match_target([None]) is None


def test_colour_stats_read_lab_and_luma():
    grey = np.full((8, 8, 3), 128, np.uint8)
    s = shot.color_stats([grey])
    assert abs(s["a"]) < 0.5 and abs(s["b"]) < 0.5 and abs(s["luma"] - 128 / 255) < 0.01
    red = grey.copy()
    red[..., 0] = 200
    assert shot.color_stats([red])["a"] > 10


def test_shake_reads_jitter_not_a_steady_pan():
    rng = np.random.default_rng(1)
    base = (rng.random((96, 96, 3)) * 255).astype(np.uint8)
    base = np.kron(base, np.ones((4, 4, 1), np.uint8))[:320, :320]  # blocky texture phase correlation can lock on

    def frames(offsets):
        return [np.roll(base, (int(dy), int(dx)), axis=(0, 1)) for dx, dy in offsets]

    steady = frames([(0, 0)] * 30)
    pan = frames([(k, 0) for k in range(30)])
    jitter = frames([((k % 2) * 4, ((k // 2) % 2) * 4) for k in range(30)])
    assert shot.shake_of(steady) < 0.05
    assert shot.shake_of(pan) < 0.2  # a smooth move stays in the average
    assert shot.shake_of(jitter) > shot.SHAKE_AUTO
    assert shot.shake_of(steady[:5]) is None


def test_stab_decision():
    d = shot.stab_decision
    assert d("auto", 0.5) == (True, "shake 0.500 >= 0.2")
    assert d("auto", 0.1)[0] is False
    assert d("auto", None) == (False, "shake not measured")
    assert d("off", 5.0) == (False, "off")
    assert d("on", 0.0) == (True, "on")
    for flag in ("photo", "is360", "drone", "ai"):
        assert d("on", 5.0, **{flag: True})[0] is False
        assert d("auto", 5.0, **{flag: True})[0] is False
    assert d("auto", 5.0, vidstab=False) == (False, "this ffmpeg has no vidstab")
    assert d("bogus", 5.0)[0] is True  # an unknown mode reads as auto
    assert shot.is_drone(Path("DJI_0821.MP4")) and shot.is_drone(Path("x.mp4"), "dji")
    assert not shot.is_drone(Path("VID_20261101_150521.mp4"), "phone")


def test_window_key(tmp_path):
    clip = tmp_path / "a.mp4"
    clip.write_bytes(b"x" * 10)
    other = tmp_path / "b.mp4"
    other.write_bytes(b"x" * 10)
    k = shot.window_key(clip, 1.0, 3.2)
    assert k == shot.window_key(clip, 1.0, 3.2)
    assert k == shot.window_key(clip, 1.0004, 3.2)  # to the millisecond
    assert len({k, shot.window_key(clip, 1.5, 3.2), shot.window_key(clip, 1.0, 4.0), shot.window_key(other, 1.0, 3.2)}) == 4
    clip.write_bytes(b"y" * 20)  # a changed file is a new key
    assert shot.window_key(clip, 1.0, 3.2) != k


def test_stab_transforms_are_cached(tmp_path, monkeypatch):
    clip = tmp_path / "VID_1.mp4"
    clip.write_bytes(b"x")
    calls = []

    def fake_run(cmd, timeout=0):
        calls.append(cmd)
        part = cmd[cmd.index("-vf") + 1].split("result='")[1].rstrip("'").replace("\\:", ":")
        Path(part).write_text("VID.STAB 1", encoding="utf-8")

    monkeypatch.setattr(shot, "_run", fake_run)
    first = shot.stab_transforms(clip, 2.0, 3.0)
    again = shot.stab_transforms(clip, 2.0, 3.0)
    assert first == again and first.read_text(encoding="utf-8") == "VID.STAB 1"
    assert len(calls) == 1
    assert first.parent.name == "stab" and first.parent.parent.name == "mezz"
    assert shot.stab_filter(first).startswith("vidstabtransform=input='") and "smoothing=15:optzoom=1" in shot.stab_filter(first)


# render_shot's ffmpeg arguments before colour match and stabilise existed (captured from main, Nov 2026).
_LOOK = ("colorlevels=rimin=0.025:gimin=0.031:bimin=0.043:rimax=0.941:gimax=0.929:bimax=0.911,"
         "curves=master='0/0.03 0.25/0.215 0.5/0.5 0.75/0.79 1/0.99',"
         "colorbalance=rs=-0.02:bs=0.02:rm=0.012:bm=-0.008:rh=0.012:gh=0.004:bh=-0.006,eq=saturation=1.16:contrast=1.04")
_TAIL = "vignette=angle=PI/8:mode=forward,noise=alls=4:allf=t+u,fps=30,format=yuv420p"
_AAC = ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k"]
_ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "15"]
SRC, OUT = str(Path("C:/footage/VID_1.mp4")), str(Path("C:/out/00_t.mp4"))
WIDE = shot.Measure(3840, 2160, (0.02, 0.03, 0.05), (0.95, 0.93, 0.9), 0.45, 0.4, 0.5, [])
TALL = shot.Measure(1080, 1920, (0.02, 0.03, 0.05), (0.95, 0.93, 0.9), 0.45, 0.5, 0.4, [])
GOLDEN = {
    "wide_src_tall_out": (WIDE, dict(size=(1080, 1920)), [
        "-y", "-ss", "2.000", "-t", "3.200", "-i", SRC, "-vf",
        f"crop=1214:2160:x='929+(929-929)*t/3.200':y='0+(0-0)*t/3.200',scale=1080:1920:flags=lanczos,{_LOOK},{_TAIL}",
        *_AAC, "-t", "3.200", *_ENC, OUT]),
    "slow_pan": (WIDE, dict(size=(1080, 1920), pan=(0.3, 0.7), speed=0.5), [
        "-y", "-ss", "2.000", "-t", "1.600", "-i", SRC, "-vf",
        f"setpts=2.0000*PTS,crop=1214:2160:x='545+(2081-545)*t/3.200':y='0+(0-0)*t/3.200',scale=1080:1920:flags=lanczos,{_LOOK},{_TAIL}",
        "-an", "-t", "3.200", *_ENC, OUT]),
    "portrait_in_wide": (TALL, dict(size=(1920, 1080)), [
        "-y", "-ss", "2.000", "-t", "3.200", "-i", SRC, "-filter_complex",
        f"[0:v]{_LOOK},split[a][b];[a]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=28:2,"
        "eq=brightness=-0.12:saturation=0.8[bg];[b]scale=-2:1080:flags=lanczos[fg];"
        "[bg][fg]overlay=(W-w)/2:0,vignette=angle=PI/8:mode=forward,noise=alls=4:allf=t+u,fps=30,format=yuv420p[v]",
        "-map", "[v]", "-map", "0:a?", *_AAC, "-t", "3.200", *_ENC, OUT]),
}


def _cmd(monkeypatch, m, **kw):
    got = []
    monkeypatch.setattr(shot, "_run", lambda cmd, timeout=0: got.append(cmd))
    monkeypatch.setattr(shot, "hdr_prefix", lambda src: "")
    monkeypatch.setattr(shot, "measure", lambda src, t: m)
    shot.render_shot(Path("C:/footage/VID_1.mp4"), 2.0, 3.2, Path("C:/out/00_t.mp4"), **kw)
    return got[0][1:]


@pytest.mark.parametrize("name", sorted(GOLDEN))
def test_without_colour_match_or_stabilise_the_command_is_unchanged(monkeypatch, name):
    m, kw, want = GOLDEN[name]
    assert _cmd(monkeypatch, m, **kw) == want
    assert _cmd(monkeypatch, m, color="", stab=None, **kw) == want


def test_colour_and_stabilise_go_in_the_right_places(monkeypatch):
    stab = Path("C:/data/mezz/stab/k.trf").resolve()  # on Linux an absolute path with no drive
    cmd = _cmd(monkeypatch, WIDE, size=(1080, 1920), color="colorchannelmixer=rr=1.0300:gg=0.9900:bb=0.9600", stab=stab)
    vf = cmd[cmd.index("-vf") + 1]
    assert vf.startswith("vidstabtransform=input='" + stab.as_posix().replace(":", "\\:") + "'")
    if os.name == "nt":
        assert vf.startswith("vidstabtransform=input='C\\:/data/mezz/stab/k.trf'")  # the drive colon is escaped
    assert vf.index("vidstabtransform") < vf.index("crop=") < vf.index("colorchannelmixer") < vf.index("colorlevels")
    graph = _cmd(monkeypatch, TALL, size=(1920, 1080), color="colorchannelmixer=rr=1.0300:gg=0.9900:bb=0.9600")
    head = graph[graph.index("-filter_complex") + 1].split(",split")[0]
    assert head == "[0:v]colorchannelmixer=rr=1.0300:gg=0.9900:bb=0.9600," + _LOOK


def _plans(n=3):
    return [{"i": k, "shot": {"src": f"s{k}", "sec": 3.0}, "src": Path(f"VID_{k}.mp4"), "key": str(k), "pick": {"start": 1.0, "is360": False},
             "move": None, "enh": None, "photo": False} for k in range(n)]


def _probes(monkeypatch, rows):
    from studio import reels

    by_src = {f"VID_{k}.mp4": row for k, row in enumerate(rows)}  # probes run side by side: answer by source

    def probe(src, *a, **k):
        return by_src[src.name]

    monkeypatch.setattr(shot, "probe_window", probe)
    monkeypatch.setattr(shot, "stab_transforms", lambda src, start, length: Path(f"{src.stem}.trf"))
    monkeypatch.setattr(shot, "has_vidstab", lambda: True)
    monkeypatch.setattr(reels, "_device", lambda src: None)
    return reels


def test_shot_looks_matches_day_shots_and_stabilises_shaky_ones(monkeypatch):
    night = {**STATS, "luma": 0.1, "a": 20.0}
    rows = [{"color": {**STATS, "a": 10.0}, "shake": 0.5}, {"color": STATS, "shake": 0.05}, {"color": night, "shake": 0.05}]
    reels = _probes(monkeypatch, rows)
    looks = reels.shot_looks({"slug": "t"}, _plans())
    (f0, t0, c0, s0), (f1, t1, c1, s1), (f2, t2, c2, s2) = looks
    assert f0.startswith("colorchannelmixer") and c0["on"] and c0["target"]["a"] == 7.0  # median of the two day shots
    assert c2 == {"on": False, "reason": "night", "stats": night} and f2 == ""
    assert t0 == Path("VID_0.trf") and s0["on"] and s0["shake"] == 0.5
    assert t1 is None and not s1["on"] and s1["reason"].startswith("shake 0.050 <")


def test_shot_looks_off_changes_nothing(monkeypatch):
    reels = _probes(monkeypatch, [])  # nothing may be probed
    looks = reels.shot_looks({"slug": "t", "colorMatch": False, "stabilize": "off"}, _plans())
    assert [(f, t) for f, t, _, _ in looks] == [("", None)] * 3
    assert looks[0][2] == {"on": False, "reason": "colorMatch off"} and looks[0][3]["reason"] == "off"


def test_shot_looks_never_fails_on_vidstab(monkeypatch):
    reels = _probes(monkeypatch, [{"color": STATS, "shake": 0.9}])

    def boom(*a):
        raise RuntimeError("no vidstab here")

    monkeypatch.setattr(shot, "stab_transforms", boom)
    (_, trf, _, stab), = reels.shot_looks({"slug": "t"}, _plans(1))
    assert trf is None and not stab["on"] and "vidstab failed" in stab["reason"]
