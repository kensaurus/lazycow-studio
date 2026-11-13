"""360 footage: what counts as a sphere, how the lens circles are found, the camera moves
(eased, inside v360's range, written to a sendcmd file), seams and levelling, and the
moves a reel gives each shot."""
import os
import numpy as np

from studio import sphere


def test_a_two_to_one_frame_or_an_insta360_photo_is_360():
    assert sphere.is_equirect(5760, 2880)
    assert sphere.is_equirect(6528, 3264)
    assert sphere.is_equirect(None, None, "IMG_20250807_124951_00_041.insp")
    assert not sphere.is_equirect(1920, 1080)
    assert not sphere.is_equirect(1600, 800)  # too small to be a sphere
    assert sphere.is_tall_pair(3264, 6528) and not sphere.is_tall_pair(3000, 4000)


def test_two_lens_circles_are_told_from_a_stitched_sphere():
    h, w = 128, 256
    yy, xx = np.mgrid[0:h, 0:w]
    circles = np.zeros((h, w))
    for cx in (64, 192):
        circles[(xx - cx) ** 2 + (yy - 64) ** 2 < 62 ** 2] = 140
    assert sphere.layout_of(circles) == "dfisheye"
    stitched = np.full((h, w), 120.0)
    stitched[: h // 2] = 200  # sky over ground: no black corners
    assert sphere.layout_of(stitched) == "equirect"


def test_the_camera_eases_and_stays_in_range(tmp_path):
    assert sphere._ease(0) == 0 and sphere._ease(1) == 1 and sphere._ease(0.5) == 0.5
    assert sphere._ease(0.1) < 0.1  # slow out of the first keyframe
    assert sphere.wrap(213) == -147 and sphere.wrap(-190) == 170 and sphere.wrap(90) == 90
    script = tmp_path / "reveal.cmd"
    filters = sphere.chain("reveal", 2.0, (1080, 1920), script, direction=-1, yaw0=170)
    lines = [ln for ln in script.read_text().splitlines() if ln.strip()]
    assert len(lines) == 60  # one keyframe per output frame at 30 fps
    # v360 adds pitch commands to its current turn, so the script sends changes that sum to the move.
    a, b = sphere.keyframes("reveal", 2.0, -1, 170)
    deltas = [float(ln.split("pitch ")[1].split(",")[0]) for ln in lines if "pitch " in ln]
    assert abs(sum(deltas) - (b["pitch"] - a["pitch"])) < 1e-3
    assert "yaw" not in script.read_text()  # yaw is a slide of the sphere, not a v360 command
    assert filters[0].endswith("hstack") and filters[1].startswith("crop=w=iw/2") and "clip(t/2.0000,0,1)" in filters[1]
    assert filters[2].startswith("sendcmd=f='")
    if os.name == "nt":
        assert "\\:" in filters[2]  # the drive colon is escaped (Linux paths have none)
    assert "output=flat" in filters[3] and "w=1080:h=1920" in filters[3] and "yaw=0" in filters[3]


def test_a_tiny_planet_looks_down_in_stereographic(tmp_path):
    a, b = sphere.keyframes("planet", 3.0)
    assert a["pitch"] == -90 and b["pitch"] == -90 and a["fov"] > b["fov"]
    filters = sphere.chain("planet", 1.0, (1080, 1920), tmp_path / "p.cmd")
    assert "output=sg" in filters[3] and "pitch=-90" in filters[3]
    assert "pitch" not in (tmp_path / "p.cmd").read_text()  # the planet only spins: no tilt commands


def test_a_pan_is_calm_and_a_rough_stitch_stays_inside_one_lens():
    assert sphere.pan_span(2.0) == 44 and sphere.pan_span(10) == 80
    start = sphere.lens_centre(1, 3.0)
    assert -90 < start and start + sphere.pan_span(3.0) < 90
    back = sphere.lens_centre(-1, 3.0)
    assert back - sphere.pan_span(3.0) > 90


def test_the_seam_cost_prefers_lenses_that_meet():
    smooth = np.tile(np.linspace(0, 255, 256), (128, 1))
    broken = smooth.copy()
    broken[:, 64:192] = 255 - broken[:, 64:192]
    assert sphere.seam_cost(smooth) < sphere.seam_cost(broken)


def test_levelling_wants_sky_on_top():
    sky, grass = [200, 210, 235], [60, 110, 50]
    level = np.zeros((128, 256, 3))
    level[:64], level[64:] = sky, grass
    flipped = level[::-1]
    assert sphere.sky_up(level) > 0.4 and sphere.sky_up(flipped) < -0.4
    floor = np.zeros((128, 256, 3))
    floor[:64], floor[64:] = [40, 40, 40], [210, 190, 160]  # a dark roof over a sunlit warm floor
    assert sphere.sky_up(floor) == 0  # warm light is not sky, so nothing gets turned over


def test_each_shot_gets_a_move_the_opening_unrolls_and_the_last_is_a_planet():
    moves = [sphere.move_for(i, "photo", 6) for i in range(6)]
    assert moves[0][0] == "unroll" and moves[-1][0] == "planet"
    assert {m for m, _ in moves[1:-1]} <= {"pan", "reveal"}
    assert {d for _, d in moves} == {1, -1}
