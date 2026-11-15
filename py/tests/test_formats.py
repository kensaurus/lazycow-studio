"""Every kind of footage read the same way (studio.formats) and every shot checked as soon as it is made (studio.shot).

The black reels of Nov 2026: the DJI Osmo films 10-bit HEVC, ffmpeg's colorlevels turns 10-bit planar RGB black, and
it was found only after 12 reels had rendered. These tests make each common camera format for real, run it through the
shot renderer, and check the picture came out right."""
import subprocess
from pathlib import Path

import pytest

from studio import formats, shot
from studio.config import ffmpeg_bin
from studio.media import VIDEO


def _src(**video):
    return {"streams": [{"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p", "width": 1920, "height": 1080, **video},
                        {"codec_type": "audio"}], "format": {"duration": "12.0"}}


@pytest.mark.parametrize("video, want", [
    ({}, ""),  # plain 8-bit 4:2:0 BT.709: the render is unchanged
    ({"pix_fmt": "yuv420p10le", "codec_name": "hevc"}, formats.EIGHT_BIT),  # DJI Osmo, iPhone, Sony 10-bit
    ({"pix_fmt": "yuv422p10le", "codec_name": "prores"}, formats.EIGHT_BIT),  # ProRes, DNxHR
    ({"pix_fmt": "yuva444p10le"}, formats.EIGHT_BIT),  # ProRes 4444 with alpha
    ({"pix_fmt": "yuv420p12le"}, formats.EIGHT_BIT),
    ({"pix_fmt": "p010le"}, formats.EIGHT_BIT),  # hardware-decoded 10-bit
    ({"pix_fmt": "gray"}, formats.EIGHT_BIT),
    ({"pix_fmt": "gbrp"}, formats.EIGHT_BIT),
    ({"pix_fmt": "yuvj420p"}, f"scale=in_range=pc:out_range=tv,{formats.EIGHT_BIT}"),  # full range (action cams, MJPEG)
    ({"color_range": "pc"}, f"scale=in_range=pc:out_range=tv,{formats.EIGHT_BIT}"),
    ({"color_transfer": "arib-std-b67", "pix_fmt": "yuv420p10le"}, formats.TONEMAP),  # HLG (DJI, iPhone HDR)
    ({"color_transfer": "smpte2084", "pix_fmt": "yuv420p10le"}, formats.TONEMAP),  # PQ / HDR10
    ({"field_order": "tt"}, formats.DEINTERLACE),  # a camcorder's interlaced AVCHD
    ({"field_order": "tt", "pix_fmt": "yuv422p10le"}, f"{formats.DEINTERLACE},{formats.EIGHT_BIT}"),
])
def test_every_source_is_brought_to_plain_8_bit_before_the_grade(video, want):
    assert formats.head(formats.parse(_src(**video))) == want


def test_wide_gamut_sdr_is_converted_to_bt709():
    h = formats.head(formats.parse(_src(color_primaries="bt2020", color_space="bt2020nc", pix_fmt="yuv420p10le")))
    assert h.startswith("zscale=pin=bt2020:p=bt709:min=bt2020nc:m=bt709") and h.endswith(formats.EIGHT_BIT)


@pytest.mark.parametrize("pix, n", [("yuv420p", 8), ("nv12", 8), ("bgr0", 8), ("yuv420p10le", 10), ("p010le", 10), ("p210le", 10),
                                    ("gray10le", 10), ("yuv444p12le", 12), ("yuv420p16le", 16), ("rgb48le", 16), ("gbrpf32le", 32)])
def test_bits(pix, n):
    assert formats.bits(pix) == n and formats.deep(pix) == (n > 8)


def test_a_file_without_a_picture_or_unreadable_is_not_footage():
    assert not formats.parse({"streams": [{"codec_type": "audio"}]}).ok
    assert "no picture" in formats.parse({"streams": [{"codec_type": "audio"}]}).why
    cover = {"streams": [{"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}]}
    assert not formats.parse(cover).ok  # a music file's cover art is not a picture stream


def test_hdr_prefix_is_the_normaliser(monkeypatch):
    monkeypatch.setattr(formats, "probe", lambda src: formats.parse(_src(pix_fmt="yuv420p10le")))
    assert shot.hdr_prefix(Path("C:/footage/DJI_1.MP4")) == formats.EIGHT_BIT + ","
    monkeypatch.setattr(formats, "probe", lambda src: formats.parse(_src()))
    assert shot.hdr_prefix(Path("C:/footage/IMG_1.MOV")) == ""


@pytest.mark.parametrize("ext", [".mp4", ".mov", ".m4v", ".insv", ".360", ".mts", ".m2ts", ".mkv", ".webm", ".avi", ".mxf", ".3gp", ".mpg"])
def test_the_studio_takes_every_common_video_container(ext):
    assert ext in VIDEO


# ---- real files ------------------------------------------------------------------------------------------------

def _ff(*args, timeout=120):
    return subprocess.run([str(ffmpeg_bin()), "-y", "-v", "error", *args], capture_output=True, text=True, timeout=timeout)


def _clip(path: Path, color="c=0x8090a0", seconds=2.0, extra=()):
    made = _ff("-f", "lavfi", "-i", f"color={color}:s=320x180:r=30:d={seconds}", *extra, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path))
    assert made.returncode == 0, made.stderr
    return path


def test_problem_reads_a_shot_back(tmp_path):
    lit = _clip(tmp_path / "lit.mp4")
    black = _clip(tmp_path / "black.mp4", "c=black")
    assert formats.problem(lit, 2.0, 0.5) is None
    assert formats.problem(black, 2.0, 0.5) == "came out black"
    assert formats.problem(black, 2.0, 0.03) is None  # a night clip may be dark
    assert formats.problem(black, 2.0, None) == "came out black"
    assert formats.problem(lit, 4.0, 0.5).startswith("came out short")
    assert formats.problem(_clip(tmp_path / "white.mp4", "c=white"), 2.0, 0.5) == "came out white"
    half = tmp_path / "half.mp4"
    assert _ff("-t", "1", "-i", str(black), "-t", "1", "-i", str(lit), "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-t", "2", str(half)).returncode == 0
    assert formats.problem(half, 2.0, 0.5).startswith("came out black for part of it")
    assert formats.problem(tmp_path / "never-made.mp4", 2.0, 0.5) is None


def test_verdict_names_files_that_cannot_be_footage(tmp_path):
    assert formats.verdict(_clip(tmp_path / "ok.mp4")) is None
    assert "only 0.2 s" in formats.verdict(_clip(tmp_path / "blink.mp4", seconds=0.2))
    sound = tmp_path / "sound.mp4"
    assert _ff("-f", "lavfi", "-i", "sine=d=2", "-c:a", "aac", str(sound)).returncode == 0
    assert "no picture" in formats.verdict(sound)
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    assert "could not be read" in formats.verdict(broken)
    assert "missing" in formats.verdict(tmp_path / "gone.mp4")


def test_a_shot_that_comes_out_black_is_made_again_the_plain_way(tmp_path, monkeypatch, capsys):
    calls = []

    def fake(src, start, seconds, out, size, safe=False, **kw):
        calls.append((safe, kw["lut"], kw["color"]))
        _clip(out, "c=0x8090a0" if safe else "c=black", seconds=seconds)
        return shot.Measure(320, 180, (0, 0, 0), (1, 1, 1), 0.5, 0.5)

    monkeypatch.setattr(shot, "_make_shot", fake)
    out = shot.render_shot(Path("C:/footage/DJI_0054.MP4"), 2.0, 1.5, tmp_path / "00_t.mp4", (180, 320), lut="savanna", color="eq=gamma=1.1")
    assert out.exists() and formats.problem(out, 1.5, 0.5) is None
    assert calls == [(False, "savanna", "eq=gamma=1.1"), (True, None, "")]  # the retry drops the preset and the colour match
    assert "SHOT DJI_0054.MP4 at 2.0 s came out black; made again the plain way" in capsys.readouterr().out


def test_a_shot_wrong_twice_fails_at_once_with_the_file_named(tmp_path, monkeypatch):
    def fake(src, start, seconds, out, size, safe=False, **kw):
        _clip(out, "c=black", seconds=seconds)
        return shot.Measure(320, 180, (0, 0, 0), (1, 1, 1), 0.5, 0.5)

    monkeypatch.setattr(shot, "_make_shot", fake)
    with pytest.raises(shot.ShotError, match="DJI_0054.MP4 at 2.0 s came out black, also when made the plain way"):
        shot.render_shot(Path("C:/footage/DJI_0054.MP4"), 2.0, 1.5, tmp_path / "00_t.mp4", (180, 320))
    assert not (tmp_path / "00_t.mp4").exists()  # no black clip left in the cache for the next build


def test_a_night_shot_stays_dark_and_is_not_made_again(tmp_path, monkeypatch):
    calls = []

    def fake(src, start, seconds, out, size, safe=False, **kw):
        calls.append(safe)
        _clip(out, "c=black", seconds=seconds)
        return shot.Measure(320, 180, (0, 0, 0), (0.1, 0.1, 0.1), 0.03, 0.5)

    monkeypatch.setattr(shot, "_make_shot", fake)
    shot.render_shot(Path("C:/footage/night.MP4"), 0.0, 1.5, tmp_path / "n.mp4", (180, 320))
    assert calls == [False]


def test_safe_look_is_the_look_without_its_levels_step():
    m = shot.Measure(1920, 1080, (0.02, 0.03, 0.05), (0.95, 0.93, 0.9), 0.45, 0.5)
    full, safe = shot.look_chain(m), shot.look_chain(m, safe=True)
    assert full.startswith("colorlevels=") and "colorlevels" not in safe and full.endswith(safe)
    assert "colorlevels" not in shot.look_chain(m, natural=True, safe=True)


# Each common camera format, made for real and run through the shot renderer: the picture comes out, the same colour
# as the plain 8-bit file. A format this machine's ffmpeg cannot write is skipped.
CAMERA_FORMATS = {
    "hevc_10bit (DJI Osmo, iPhone, Sony)": (".mp4", ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=none"]),
    "h264_10bit": (".mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p10le"]),
    "h264_422_10bit (Sony XAVC, Panasonic)": (".mov", ["-c:v", "libx264", "-pix_fmt", "yuv422p10le"]),
    "hevc_12bit": (".mp4", ["-c:v", "libx265", "-pix_fmt", "yuv420p12le", "-x265-params", "log-level=none"]),
    "prores_422hq": (".mov", ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]),
    "prores_4444_alpha": (".mov", ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"]),
    "dnxhr_hqx": (".mov", ["-c:v", "dnxhd", "-profile:v", "dnxhr_hqx", "-pix_fmt", "yuv422p10le"]),
    "full_range (action cams)": (".mp4", ["-c:v", "libx264", "-pix_fmt", "yuvj420p"]),
    "yuv444": (".mp4", ["-c:v", "libx264", "-pix_fmt", "yuv444p"]),
    "rgb": (".mp4", ["-c:v", "libx264rgb", "-pix_fmt", "bgr0"]),
    "interlaced (AVCHD camcorders)": (".mts", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-flags", "+ildct+ilme", "-x264opts", "tff=1", "-f", "mpegts"]),
    "mjpeg (old cameras)": (".avi", ["-c:v", "mjpeg", "-pix_fmt", "yuvj422p", "-q:v", "3"]),
    "vp9_10bit (webm)": (".webm", ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p10le", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8"]),
    "av1_10bit": (".mkv", ["-c:v", "libsvtav1", "-pix_fmt", "yuv420p10le", "-preset", "12"]),
    "hlg_10bit (HDR)": (".mp4", ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
                                 "-colorspace", "bt2020nc", "-x265-params", "log-level=none"]),
}
SAME_COLOUR = 0.06
CENTRE = (0.5, 0.5)  # the same crop for every file: colour is compared, not where the subject-finder looked


def _rgb(path: Path) -> tuple[float, float, float]:
    raw = subprocess.run([str(ffmpeg_bin()), "-v", "error", "-i", str(path), "-vf", "fps=4,scale=32:32,format=rgb24", "-f", "rawvideo", "-"],
                         capture_output=True, timeout=60).stdout
    n = len(raw) // 3
    return tuple(sum(raw[c::3]) / n / 255 for c in range(3))


@pytest.fixture(scope="module")
def reference(tmp_path_factory):
    d = tmp_path_factory.mktemp("formats")
    src = d / "plain.mp4"
    made = _ff("-f", "lavfi", "-i", "testsrc2=size=480x272:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src))
    assert made.returncode == 0, made.stderr
    out = shot.render_shot(src, 0.3, 1.0, d / "plain_out.mp4", (180, 320), pan=CENTRE)
    return d, _rgb(out)


@pytest.mark.parametrize("name", list(CAMERA_FORMATS))
def test_every_camera_format_renders_right(reference, name):
    d, ref = reference
    ext, enc = CAMERA_FORMATS[name]
    src = d / (name.split(" ")[0] + ext)
    made = _ff("-f", "lavfi", "-i", "testsrc2=size=480x272:rate=30:duration=2", *enc, str(src))
    if made.returncode:
        pytest.skip(f"this ffmpeg cannot write {name}: {made.stderr.strip()[-120:]}")
    out = shot.render_shot(src, 0.3, 1.0, d / f"{src.stem}_out.mp4", (180, 320), pan=CENTRE)
    assert formats.problem(out, 1.0, None) is None
    if "HDR" not in name:  # an HDR file is tone-mapped: its colours legitimately move
        got = _rgb(out)
        assert max(abs(a - b) for a, b in zip(got, ref)) < SAME_COLOUR, (name, got, ref)


def test_a_10_bit_long_film_shot_is_not_black(reference):
    """The long film's natural finish (studio.vlog) goes through the same normaliser."""
    d, _ = reference
    src = d / "osmo10.mp4"
    if _ff("-f", "lavfi", "-i", "testsrc2=size=480x272:rate=30:duration=2", "-c:v", "libx265", "-pix_fmt", "yuv420p10le",
           "-x265-params", "log-level=none", str(src)).returncode:
        pytest.skip("no libx265")
    out = shot.render_shot(src, 0.3, 1.0, d / "osmo10_nat.mp4", (320, 180), natural=True)
    assert formats.problem(out, 1.0, None) is None


def test_an_indexed_file_is_sought_as_always_and_a_transport_stream_short_then_exactly():
    assert formats.seek_input("C:/f/a.MP4", 25, 1.5) == ["-ss", "25.000", "-t", "1.500", "-i", "C:/f/a.MP4"]
    assert formats.seek_input("C:/f/a.MTS", 25, 1.5) == ["-ss", "15.000", "-i", "C:/f/a.MTS", "-ss", "10.000", "-t", "1.500"]
    assert formats.seek_input("C:/f/a.m2ts", 3) == ["-i", "C:/f/a.m2ts", "-ss", "3.000"]  # near the start: no seek before
