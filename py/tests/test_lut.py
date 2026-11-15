"""Colour presets (studio.lut): the .cube files, the maths each preset promises, and how a shot lays one."""
import colorsys
import os
from pathlib import Path

import numpy as np
import pytest

from studio import lut, shot, sphere

NAMES = [p["name"] for p in lut.presets()]
MONO = {"mono-warm", "mono-neutral"}
# Light to deep skin, as display RGB.
SKIN = [(0.95, 0.80, 0.70), (0.92, 0.72, 0.60), (0.85, 0.62, 0.48), (0.78, 0.55, 0.42), (0.62, 0.42, 0.30),
        (0.45, 0.30, 0.22), (0.30, 0.20, 0.15), (0.90, 0.74, 0.62)]


@pytest.fixture
def cache(monkeypatch, tmp_path):
    monkeypatch.setattr(lut, "CACHE", tmp_path / "luts")
    return tmp_path / "luts"


def test_a_dozen_plainly_named_presets():
    rows = lut.presets()
    assert len(rows) == 12 and len(set(NAMES)) == 12
    assert all(set(r) == {"name", "label", "description"} and r["label"] and r["description"] for r in rows)
    brands = ("kodak", "fuji", "velvia", "portra", "ektar", "cinestill", "agfa", "ilford", "provia", "eterna")
    assert not [r for r in rows for b in brands if b in (r["name"] + r["label"] + r["description"]).lower()]
    with pytest.raises(ValueError):
        lut.path("no-such-look")


def test_cube_file_format(cache):
    p = lut.path("warm-film")
    assert p.parent.parent == cache and p.suffix == ".cube"
    lines = p.read_text(encoding="ascii").splitlines()
    assert lines[0].startswith('TITLE "warm-film')
    assert lines[1:4] == ["LUT_3D_SIZE 33", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    rows = np.array([[float(v) for v in ln.split()] for ln in lines[4:]])
    assert rows.shape == (33 ** 3, 3) == (35937, 3)
    assert rows.min() >= 0.0 and rows.max() <= 1.0
    # Red runs fastest: the second row is one red step up from black.
    assert rows[1][0] > rows[0][0] and abs(rows[1][1] - rows[0][1]) < 0.02


def test_baked_once_then_reused(cache):
    first = lut.path("teal-amber", 0.6)
    stamp = first.stat().st_mtime_ns
    again = lut.path("teal-amber", 0.6)
    assert again == first and again.stat().st_mtime_ns == stamp
    assert first.name == "teal-amber-060.cube"
    assert lut.path("teal-amber") != first  # strength is baked into its own file
    assert not list(cache.rglob("*.tmp"))


def test_strength_zero_is_identity_and_half_is_halfway(cache):
    ident = lut.grid()
    for name in NAMES:
        assert np.array_equal(lut.table(name, 0.0), ident)
    full, half = lut.table("savanna", 1.0), lut.table("savanna", 0.5)
    assert np.allclose(half, (ident + full) / 2, atol=1e-9)
    rows = lut.path("savanna", 0.0).read_text(encoding="ascii").splitlines()[4:]
    assert np.allclose(np.array([[float(v) for v in r.split()] for r in rows]), ident, atol=1e-6)
    assert lut.filter("savanna", 0.0) == ""


@pytest.mark.parametrize("name", NAMES)
def test_grey_ramp_luminance_stays_in_order_and_in_range(name):
    ramp = np.repeat(np.linspace(0.0, 1.0, 1024)[:, None], 3, axis=1)
    out = lut.apply(lut.PRESETS[name], ramp)
    y = out @ np.array([0.2126, 0.7152, 0.0722])
    assert np.all(np.diff(y) >= -1e-9), "a brighter grey never comes out darker"
    assert y[-1] - y[0] > 0.8, "no preset crushes the range (soft-matte's milky blacks and lowered whites are the floor)"
    rng = np.random.default_rng(7)
    anything = lut.apply(lut.PRESETS[name], rng.random((20000, 3)))
    assert anything.min() >= 0.0 and anything.max() <= 1.0
    assert out.max() < 1.0 + 1e-12 and np.isfinite(anything).all()


@pytest.mark.parametrize("name", [n for n in NAMES if n not in MONO])
def test_skin_keeps_its_hue_and_most_of_its_colour(name):
    for rgb in SKIN:
        h0, s0, _ = colorsys.rgb_to_hsv(*rgb)
        h1, s1, _ = colorsys.rgb_to_hsv(*lut.apply(lut.PRESETS[name], np.array(rgb)))
        turn = ((h1 - h0) * 360 + 180) % 360 - 180
        assert abs(turn) <= 7.0, f"{name} turns skin {rgb} by {turn:.1f} degrees"
        assert 10 <= h1 * 360 <= 50, f"{name} makes skin {rgb} leave the orange hues"
        floor = 0.65 if name == "bleach" else 0.75  # a bleach bypass takes colour from everything, skin a little less
        assert floor <= s1 / s0 <= 1.2, f"{name} changes skin saturation by {s1 / s0:.2f}x"


def test_black_and_white_presets_have_no_colour_but_their_toning():
    rng = np.random.default_rng(3)
    neutral = lut.apply(lut.PRESETS["mono-neutral"], rng.random((5000, 3)))
    assert np.abs(neutral - neutral.mean(axis=1, keepdims=True)).max() < 1e-9
    warm = lut.apply(lut.PRESETS["mono-warm"], rng.random((5000, 3)))
    assert np.abs(warm - warm.mean(axis=1, keepdims=True)).max() < 0.04  # a tone, not a colour
    # Red-filter mix: a blue sky comes out darker than skin of the same Rec.709 luminance would.
    sky, skin = lut.apply(lut.PRESETS["mono-neutral"], np.array([[0.35, 0.55, 0.9], [0.85, 0.62, 0.48]]))
    assert sky[0] < skin[0]


def test_filter_path_escapes_the_drive_colon_like_sphere():
    p = Path("C:/data/luts/abc/warm-film-100.cube")
    assert lut.filter_path(p) == sphere.filter_path(p)
    if os.name == "nt":
        assert lut.filter_path(p) == "C\\:/data/luts/abc/warm-film-100.cube"
        assert lut.filter_path(Path("C:\\data\\x.cube")) == "C\\:/data/x.cube"


def test_filter_string(cache):
    f = lut.filter("teal-amber", 0.6)
    p = lut.path("teal-amber", 0.6)
    assert f == f"lut3d=file='{lut.filter_path(p)}':interp=tetrahedral"
    assert "\\" not in f.replace("\\:", "")  # only escaped colons, forward slashes
    assert lut.filter("teal-amber", 1.4) == lut.filter("teal-amber", 1.0)  # strength clamps to 0..1


# render_shot: the same golden command as test_look without a lut, the preset right after the look grade with one.
_LOOK = ("colorlevels=rimin=0.025:gimin=0.031:bimin=0.043:rimax=0.941:gimax=0.929:bimax=0.911,"
         "curves=master='0/0.03 0.25/0.215 0.5/0.5 0.75/0.79 1/0.99',"
         "colorbalance=rs=-0.02:bs=0.02:rm=0.012:bm=-0.008:rh=0.012:gh=0.004:bh=-0.006,eq=saturation=1.16:contrast=1.04")
_TAIL = "vignette=angle=PI/8:mode=forward,noise=alls=4:allf=t+u,fps=30,format=yuv420p"
WIDE = shot.Measure(3840, 2160, (0.02, 0.03, 0.05), (0.95, 0.93, 0.9), 0.45, 0.4, 0.5, [])
TALL = shot.Measure(1080, 1920, (0.02, 0.03, 0.05), (0.95, 0.93, 0.9), 0.45, 0.5, 0.4, [])


def _cmd(monkeypatch, m, **kw):
    got = []
    monkeypatch.setattr(shot, "_run", lambda cmd, timeout=0: got.append(cmd))
    monkeypatch.setattr(shot, "hdr_prefix", lambda src: "")
    monkeypatch.setattr(shot, "measure", lambda src, t: m)
    shot.render_shot(Path("C:/footage/VID_1.mp4"), 2.0, 3.2, Path("C:/out/00_t.mp4"), **kw)
    return got[0][1:]


def test_render_shot_without_a_lut_is_unchanged(monkeypatch, cache):
    plain = _cmd(monkeypatch, WIDE, size=(1080, 1920))
    vf = plain[plain.index("-vf") + 1]
    assert vf == f"crop=1214:2160:x='929+(929-929)*t/3.200':y='0+(0-0)*t/3.200',scale=1080:1920:flags=lanczos,{_LOOK},{_TAIL}"
    assert _cmd(monkeypatch, WIDE, size=(1080, 1920), lut=None) == plain
    assert _cmd(monkeypatch, WIDE, size=(1080, 1920), lut="warm-film", lut_strength=0.0) == plain
    assert "lut3d" not in " ".join(_cmd(monkeypatch, TALL, size=(1920, 1080)))
    assert not cache.exists(), "no lut asked for: nothing baked"


def test_render_shot_lays_the_lut_after_the_look(monkeypatch, cache):
    f = lut.filter("teal-amber", 0.6)
    cmd = _cmd(monkeypatch, WIDE, size=(1080, 1920), lut="teal-amber", lut_strength=0.6)
    vf = cmd[cmd.index("-vf") + 1]
    assert f"{_LOOK},{f},{_TAIL}" in vf
    natural = _cmd(monkeypatch, WIDE, size=(1080, 1920), natural=True, lut="mono-neutral")
    vf = natural[natural.index("-vf") + 1]
    assert vf.endswith(f",{lut.filter('mono-neutral')},fps=30,format=yuv420p") and "vignette" not in vf
    graph = _cmd(monkeypatch, TALL, size=(1920, 1080), lut="teal-amber", lut_strength=0.6)
    head = graph[graph.index("-filter_complex") + 1].split(",split")[0]
    assert head == f"[0:v]{_LOOK},{f}"


def test_preview_sheet_through_real_ffmpeg(cache, tmp_path):
    from PIL import Image

    from studio.config import ffmpeg_bin

    if not Path(str(ffmpeg_bin())).exists():
        pytest.skip("ffmpeg not installed here")
    src = tmp_path / "ramp.png"
    x = np.linspace(0, 255, 96, dtype=np.uint8)
    img = np.stack([np.tile(x, (64, 1)), np.tile(x[::-1], (64, 1)), np.full((64, 96), 128, np.uint8)], axis=-1)
    Image.fromarray(img).save(src)
    out = lut.preview(src, tmp_path / "sheet.jpg", width=96, names=["warm-film", "mono-neutral"])
    sheet = Image.open(out)
    assert sheet.size[0] > 96 * 3 and sheet.size[1] > 64
    mono = np.asarray(sheet.convert("RGB"), dtype=int)[6 + 10:6 + 50, 6 + 2 * (96 + 6) + 10:6 + 2 * (96 + 6) + 80]
    assert np.abs(mono - mono.mean(axis=-1, keepdims=True)).max() <= 6  # the black-and-white tile really is
