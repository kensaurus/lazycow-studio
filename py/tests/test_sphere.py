"""360 footage: what counts as a sphere, how the lens circles are found, the camera moves
(eased, inside v360's range, written to a sendcmd file), seams and levelling, and the
moves a reel gives each shot, the 360 transitions between shots, and raw lens pairs."""
import hashlib
import json
import os

import numpy as np
import pytest

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


def test_each_shot_gets_a_varied_move_the_opening_unrolls_and_the_last_is_a_planet():
    for total in (3, 6, 9, 14, 25):
        moves = [sphere.move_for(i, "photo", total) for i in range(total)]
        names = [m for m, _ in moves]
        assert names[0] == "unroll" and names[-1] == "planet"
        assert all(a != b for a, b in zip(names, names[1:]))  # never the same move twice running
        assert set(names) <= set(sphere.MOVES)
        for i in range(total - 3):  # planets and rolls sparingly: at most one in any four shots
            window = names[i:i + 4]
            assert sum(m in sphere.PLANETS for m in window) <= 1, names
            assert sum(m in sphere.SPINS for m in window) <= 1, names
        assert {d for _, d in moves} == {1, -1}
        assert moves == [sphere.move_for(i, "video", total) for i in range(total)]  # deterministic
    many = {m for m, _ in (sphere.move_for(i, "video", 40) for i in range(40))}
    assert {"pan", "reveal", "drone", "lookaround"} <= many and len(many) >= 7  # a mix, not two moves
    assert sphere.move_for(0, "video", 1)[0] == "unroll"
    assert sphere.move_for(1, "video", 2)[0] not in sphere.PLANETS  # two shots: no planet after the unroll


# Hashes of chain()'s filters + sendcmd script for the four original moves, taken before
# keyframes became N-key: the generalisation must leave their output byte for byte the same.
GOLDEN = {
    ("pan", 2.0, (1080, 1920), -1, 170.0): "0fbdd8f1fa7235cb",
    ("pan", 3.3, (1920, 1080), 1, -12.5): "7b0c507975da674a",
    ("reveal", 2.0, (1080, 1920), -1, 170.0): "4ac962351a7d178a",
    ("reveal", 3.3, (1920, 1080), 1, -12.5): "77ca1900064f51a7",
    ("planet", 2.0, (1080, 1920), -1, 170.0): "506fa399879d5b93",
    ("planet", 3.3, (1920, 1080), 1, -12.5): "71d3ec0ba2c5dfb6",
    ("unroll", 2.0, (1080, 1920), -1, 170.0): "1a2083b740a48878",
    ("unroll", 3.3, (1920, 1080), 1, -12.5): "29caaa379d2055f2",
}


def test_the_original_four_moves_render_exactly_as_before(tmp_path):
    for (move, secs, size, d, yaw0), want in GOLDEN.items():
        p = tmp_path / "x.cmd"
        f = sphere.chain(move, secs, size, p, direction=d, yaw0=yaw0)
        blob = "\n".join(f).replace(sphere.filter_path(p), "SCRIPT") + "\n#\n" + p.read_text()
        assert hashlib.sha256(blob.encode()).hexdigest()[:16] == want, move


def _script(path):
    """(time, {command: value}) per line of a sendcmd file."""
    out = []
    for ln in path.read_text().splitlines():
        ln = ln.strip().rstrip(";")
        if not ln:
            continue
        t, rest = ln.split(" ", 1)
        cmds = {}
        for part in rest.split(","):
            _, name, value = part.split(" ")
            cmds[name] = float(value)
        out.append((float(t), cmds))
    return out


def test_the_rabbit_hole_looks_up_and_the_morph_turns_the_planet_inside_out(tmp_path):
    a, b = sphere.keyframes("rabbit", 3.0)
    assert a["pitch"] == b["pitch"] == 90 and 250 <= b["fov"] < a["fov"] <= 300 and b["yaw"] != a["yaw"]
    f = sphere.chain("rabbit", 1.0, (1080, 1920), tmp_path / "r.cmd")
    assert "output=sg" in f[3] and "pitch=90" in f[3]
    keys = sphere.keyframes("morph", 3.0)
    assert keys[0]["pitch"] == -90 and keys[-1]["pitch"] == 90
    assert abs(sphere.camera_at(keys, 0.5)["pitch"]) < 1e-9  # through the horizon half way
    assert all(260 <= sphere.camera_at(keys, x / 10)["fov"] <= 300 for x in range(11))  # wide all the way
    f = sphere.chain("morph", 2.0, (1080, 1920), tmp_path / "m.cmd")
    deltas = [c["pitch"] for _, c in _script(tmp_path / "m.cmd") if "pitch" in c]
    assert "output=sg" in f[3] and abs(sum(deltas) - 180) < 1e-3


def test_the_crystal_ball_pulls_back_from_a_normal_view_into_a_planet(tmp_path):
    a, b = sphere.keyframes("crystal", 3.0)
    assert (a["fov"], a["pitch"]) == (100, -5) and (b["fov"], b["pitch"]) == (280, -90)
    sphere.chain("crystal", 2.0, (1080, 1920), tmp_path / "c.cmd")
    rows = _script(tmp_path / "c.cmd")
    fovs = [c["h_fov"] for _, c in rows]
    assert fovs == sorted(fovs) and fovs[-1] > 2.5 * fovs[0]


def test_a_barrel_roll_turns_once_and_a_horizon_flip_turns_over_and_holds(tmp_path):
    f = sphere.chain("roll", 2.0, (1920, 1080), tmp_path / "roll.cmd", direction=-1)
    rolls = [c["roll"] for _, c in _script(tmp_path / "roll.cmd") if "roll" in c]
    assert "output=flat" in f[3] and "roll=0" in f[3]
    assert abs(sum(rolls) + 360) < 1e-3  # sent as changes, like pitch: v360 adds them up
    keys = sphere.keyframes("flip", 3.0)
    assert len(keys) == 3 and keys[1]["at"] == 0.4
    assert abs(sphere.camera_at(keys, 0.4)["roll"] - 180) < 1e-9
    assert all(abs(sphere.camera_at(keys, x)["roll"] - 180) < 1e-9 for x in (0.5, 0.75, 1.0))  # held over
    sphere.chain("flip", 3.0, (1920, 1080), tmp_path / "flip.cmd")
    rows = _script(tmp_path / "flip.cmd")
    assert all("roll" not in c for t, c in rows if t > 0.42 * 3)
    assert abs(sum(c.get("roll", 0) for _, c in rows) - 180) < 1e-3
    for move in ("pan", "reveal", "drone", "lookaround", "planet"):  # nothing else rolls
        sphere.chain(move, 2.0, (1080, 1920), tmp_path / f"{move}.cmd")
        assert "roll" not in (tmp_path / f"{move}.cmd").read_text()


def test_the_fake_drone_looks_down_and_pushes_in(tmp_path):
    a, b = sphere.keyframes("drone", 3.0)
    assert -60 <= a["pitch"] <= -35 and -60 <= b["pitch"] <= -35
    assert a["fov"] > b["fov"] and abs(b["yaw"] - a["yaw"]) <= 20
    assert "output=flat" in sphere.chain("drone", 2.0, (1080, 1920), tmp_path / "d.cmd")[3]


def test_a_look_around_turns_with_two_eased_holds():
    keys = sphere.keyframes("lookaround", 5.0, direction=1, yaw0=10)
    assert len(keys) > 2
    assert abs(keys[-1]["yaw"] - keys[0]["yaw"] - 200) < 1e-9
    holds = [(a["at"], b["at"]) for a, b in zip(keys, keys[1:]) if a["yaw"] == b["yaw"]]
    assert len(holds) == 2
    for lo, hi in holds:  # the camera is still through each hold
        vals = {round(sphere.camera_at(keys, lo + (hi - lo) * k / 4)["yaw"], 9) for k in range(5)}
        assert len(vals) == 1
    assert sphere.keyframes("lookaround", 2.0)[-1]["yaw"] == 100  # a short shot turns less


def test_n_keyframes_ease_each_segment_and_hit_every_key():
    keys = [
        {"yaw": 0, "pitch": 0, "roll": 0, "fov": 90, "at": 0.0},
        {"yaw": 60, "pitch": -30, "roll": 0, "fov": 80, "at": 0.25},
        {"yaw": 60, "pitch": -30, "roll": 0, "fov": 80, "at": 0.5},
        {"yaw": 0, "pitch": 10, "roll": 90, "fov": 100, "at": 1.0},
    ]
    for k in keys:
        cam = sphere.camera_at(keys, k["at"])
        assert all(abs(cam[c] - k[c]) < 1e-9 for c in sphere.CHANNELS)
    # smoothstep per segment: slow out of and into each key, half way at the segment's middle
    assert sphere.camera_at(keys, 0.125)["yaw"] == 30
    assert sphere.camera_at(keys, 0.01)["yaw"] < 60 * 0.04
    assert sphere.camera_at(keys, 0.75)["roll"] == 45
    # missing "at" spreads keys evenly; the curve into a key can be "in" (fast at the end) or "out"
    even = sphere.timed([{"yaw": 0, "pitch": 0, "roll": 0, "fov": 90}] * 3)
    assert [k["at"] for k in even] == [0.0, 0.5, 1.0] and {k["ease"] for k in even} == {"smooth"}
    fast_end = [{"yaw": 0, "pitch": 0, "roll": 0, "fov": 90}, {"yaw": 100, "pitch": 0, "roll": 0, "fov": 90, "ease": "in"}]
    assert sphere.camera_at(fast_end, 0.5)["yaw"] == 25
    fast_start = [fast_end[0], {**fast_end[1], "ease": "out"}]
    assert sphere.camera_at(fast_start, 0.5)["yaw"] == 75


def test_the_yaw_path_of_n_keys_is_one_eased_term_per_turning_segment():
    keys = sphere.keyframes("lookaround", 4.0)
    expr = sphere.yaw_expr(keys, 4.0)
    assert expr.count("clip(") == 2 * 3  # two turning segments, three uses of u each; holds add nothing
    assert "clip(t/1.5200,0,1)" in expr and "clip((t-2.0000)/1.5200,0,1)" in expr

    def ev(t):  # evaluate the ffmpeg expression in Python
        return eval(expr.replace("clip(", "_clip("), {"_clip": lambda v, a, b: max(a, min(b, v)), "t": t})

    for x in (0.0, 0.2, 0.38, 0.44, 0.6, 0.9, 1.0):
        assert abs(ev(x * 4.0) - sphere.camera_at(keys, x)["yaw"]) < 1e-2


def test_a_whip_ends_and_starts_a_shot_with_a_blurred_half_turn(tmp_path):
    seconds = 3.0
    keys = sphere.path_for("pan", seconds, 1, 0.0, tail="whip")
    body = sphere.keyframes("pan", seconds, 1, 0.0)
    whip = sphere.WHIP_FRAMES / 30
    assert keys[-1]["yaw"] == body[-1]["yaw"] + 180 and keys[-1]["ease"] == "in"
    assert abs(keys[-2]["at"] - (1 - whip / seconds)) < 1e-9  # the move finishes as the whip begins
    assert keys[-2]["yaw"] == body[-1]["yaw"]
    # fast at the cut: the last 10% of the whip turns more than the first 40%
    x0 = 1 - whip / seconds
    at = lambda f: sphere.camera_at(keys, x0 + f * whip / seconds)["yaw"]  # noqa: E731
    assert at(1.0) - at(0.9) > at(0.4) - at(0.0)
    head = sphere.path_for("reveal", seconds, -1, 50.0, head="whip")
    assert head[0]["yaw"] == 50.0 - 180 and head[1]["yaw"] == 50.0 and head[1]["ease"] == "out"
    f = sphere.chain("pan", seconds, (960, 540), tmp_path / "w.cmd", head="whip", tail="whip")
    blur = [s for s in f if s.startswith("avgblur")]
    assert len(blur) == 4 and all("sizeY=1" in s for s in blur)
    # light once the whip is fast (not its two slow frames), heavy on the three frames at the cut
    assert "enable='between(t,0.0000,0.1667)'" in blur[0] and "enable='between(t,0.0000,0.1000)'" in blur[1]
    assert "enable='between(t,2.8333," in blur[2] and "enable='between(t,2.9000," in blur[3]
    assert not [s for s in sphere.chain("pan", seconds, (960, 540), tmp_path / "n.cmd", tail="rollx") if s.startswith("avgblur")]


def test_a_roll_transition_rolls_out_of_a_and_into_b(tmp_path):
    sphere.chain("reveal", 3.0, (1920, 1080), tmp_path / "a.cmd", tail="rollx")
    rows = _script(tmp_path / "a.cmd")
    assert abs(sum(c.get("roll", 0) for _, c in rows) - 180) < 1e-3
    assert all("roll" not in c for t, c in rows if t < 3.0 - 0.6 - 1e-6)  # only in the last 0.6 s
    f = sphere.chain("pan", 3.0, (1920, 1080), tmp_path / "b.cmd", head="rollx")
    assert "roll=-180" in f[3]  # B starts upside down the other way round
    rows = _script(tmp_path / "b.cmd")
    assert abs(sum(c.get("roll", 0) for _, c in rows) - 180) < 1e-3
    assert all("roll" not in c for t, c in rows if t > 0.6 + 1 / 30)


def test_a_tilt_transition_meets_on_the_ground_and_a_planet_match_turns_the_shot_stereographic(tmp_path):
    a = sphere.path_for("pan", 3.0, 1, 0.0, tail="tilt")
    b = sphere.path_for("drone", 3.0, 1, 0.0, head="tilt")
    assert a[-1]["pitch"] == b[0]["pitch"] == sphere.TILT_GROUND < -70
    assert a[-1]["ease"] == "in" and b[1]["ease"] == "out"
    f = sphere.chain("pan", 3.0, (1080, 1920), tmp_path / "p.cmd", tail="planetx")
    assert "output=sg" in f[3]
    end = sphere.camera_at(sphere.path_for("pan", 3.0, tail="planetx"), 1.0)
    assert end["pitch"] == -90 and end["fov"] == 300
    start = sphere.path_for("reveal", 3.0, head="planetx")
    assert start[0]["pitch"] == -90 and start[0]["fov"] == 300 and start[1]["pitch"] == -40  # then unrolls into the move
    assert sphere.projection("pan") == "flat" and sphere.projection("pan", head="planetx") == "sg"
    # a transition never takes more than 40% of a short shot
    assert sphere.transition_seconds("planetx", 1.0) == 0.4 and sphere.transition_seconds(None, 3.0) == 0.0


def test_transitions_vary_and_join_neighbouring_shots():
    for total in (2, 5, 12, 30):
        joins = [sphere.transition_for(i, total) for i in range(total - 1)]
        assert all(a != b for a, b in zip(joins, joins[1:]))
        assert set(joins) <= set(sphere.TRANSITIONS) | {None}
        for i in range(len(joins) - 3):
            assert joins[i:i + 4].count("planetx") <= 1
        moves = sphere.move_plan(total)
        for i, t in enumerate(joins):
            if t == "rollx":
                assert not {moves[i], moves[i + 1]} & sphere.SPINS
        heads_tails = [sphere.transitions_for(i, total) for i in range(total)]
        assert heads_tails[0][0] is None and heads_tails[-1][1] is None
        assert all(heads_tails[i][0] == heads_tails[i - 1][1] for i in range(1, total))
    long = [sphere.transition_for(i, 30) for i in range(29)]
    assert {"whip", "tilt", "rollx"} <= set(long) and None in long  # varied, with some plain cuts
    assert sphere.transition_for(5, 3) is None and sphere.transition_for(-1, 3) is None


# ---------- raw pairs (one lens per file) ----------

def _pair(tmp_path, n="7", partner=True):
    a = tmp_path / f"VID_20250512_101500_00_{n}.insv"
    a.write_bytes(b"lens0")
    if partner:
        (tmp_path / f"VID_20250512_101500_10_{n}.insv").write_bytes(b"lens1")
    return a


def test_a_raw_pair_is_found_by_name_and_counts_as_360(tmp_path):
    a = _pair(tmp_path)
    assert sphere.pair_of(a) == tmp_path / "VID_20250512_101500_10_7.insv"
    assert sphere.pair_of(tmp_path / "VID_20250512_101500_10_7.insv") is None  # the second lens is not an item
    lone = _pair(tmp_path, n="8", partner=False)
    assert sphere.pair_of(lone) is None
    assert sphere.is_equirect(2944, 2880, a)  # one square-ish lens frame, but a 360 with its partner
    assert not sphere.is_equirect(2944, 2880, lone)
    assert sphere.pair_of(tmp_path / "VID_20250512_101500_00_7.mp4") is None
    assert sphere.is_lens_extra(tmp_path / "VID_20250512_101500_10_7.insv")
    assert sphere.is_lens_extra(tmp_path / "LRV_20250512_101500_11_7.insv")
    assert not sphere.is_lens_extra(a) and not sphere.is_lens_extra(tmp_path / "LRV_20250512_101500_11_7.mp4")


def test_the_pair_stitch_turns_both_lenses_over_side_by_side():
    f = sphere.pair_pre(196, (1024, 512))
    assert f.startswith("[0:v]hflip,vflip[s360p0];[1:v]hflip,vflip[s360p1];[s360p0][s360p1]hstack,")
    assert f.endswith("v360=input=dfisheye:output=e:ih_fov=196:iv_fov=196:w=1024:h=512")
    assert sphere.pair_pre().endswith("ih_fov=200:iv_fov=200")  # no size: v360 picks it
    assert sphere.pair_pre(204, inputs=("b1", "1:v")).startswith("[b1]hflip,vflip")  # after a face blur


def test_the_camera_serial_comes_from_the_file_trailer(tmp_path):
    info = b"\x0a\x0eSERIAL0000TEST\x12\x0eInsta360 Model\x1a\x05v1.0.0"
    blob = b"\x00" * 5000 + info + b"\x00" * 40 + sphere.TRAILER_MAGIC
    assert sphere.serial_from_trailer(blob) == "SERIAL0000TEST"
    assert sphere.serial_from_trailer(info) is None  # no trailer: not an Insta360 file
    f = tmp_path / "VID_20250512_101500_00_9.insv"
    f.write_bytes(b"\x00" * 300_000 + blob)
    assert sphere.camera_serial(f) == "SERIAL0000TEST"
    assert sphere.camera_serial(tmp_path / "missing.insv") is None


def test_the_stitch_fov_is_the_one_whose_seams_meet_and_is_kept_per_camera(tmp_path, monkeypatch):
    smooth = np.tile(np.linspace(0, 255, 1024), (512, 1))
    broken = smooth.copy()
    broken[:, 256:768] = 255 - broken[:, 256:768]
    monkeypatch.setattr(sphere, "_pair_still", lambda a, b, fov, at: smooth if fov == 204 else broken)
    assert sphere.best_pair_fov(tmp_path / "a", tmp_path / "b") == 204

    calls = []
    monkeypatch.setattr(sphere, "best_pair_fov", lambda a, b: calls.append(a) or 196)
    monkeypatch.setattr(sphere, "camera_serial", lambda p: "CAM1")
    a = _pair(tmp_path, n="11")
    b = _pair(tmp_path, n="12")
    assert sphere.pair_fov(a) == 196 and sphere.pair_fov(b) == 196
    assert len(calls) == 1  # measured once per camera
    cache = sphere._fov_cache()
    assert cache.name == "insv_fov.json" and cache.parent.name == "keyframes"
    assert json.loads(cache.read_text())["CAM1"] == 196
    assert sphere.pair_fov(_pair(tmp_path, n="13", partner=False)) == sphere.DFISHEYE_FOV  # nothing to stitch


def test_the_library_scan_takes_the_first_lens_and_skips_the_second_and_proxies(tmp_path):
    from studio.ingest import iter_media

    a = _pair(tmp_path)
    (tmp_path / "LRV_20250512_101500_11_7.insv").write_bytes(b"proxy")
    (tmp_path / "clip.mp4").write_bytes(b"x")
    assert sorted(p.name for p in iter_media(tmp_path)) == sorted([a.name, "clip.mp4"])


def test_a_pair_renders_through_the_stitch_before_the_camera_move(tmp_path, monkeypatch):
    from studio import shot

    a = _pair(tmp_path)
    ran = []
    monkeypatch.setattr(shot, "_run", lambda cmd, *k: ran.append(cmd))
    monkeypatch.setattr(shot, "hdr_prefix", lambda src: "")
    monkeypatch.setattr(sphere, "pair_fov", lambda p: 200)
    m = shot.Measure(2944, 2880, (0, 0, 0), (1, 1, 1), 0.5, 0.5)
    shot._render_360(a, 4.0, 3.0, tmp_path / "out.mp4", (1080, 1920), m, 1.0, True, False,
                     ("crystal", 1, "whip", "tilt"), False, pair=sphere.pair_of(a))
    cmd = ran[0]
    inputs = [cmd[i + 1] for i, x in enumerate(cmd) if x == "-i"]
    assert inputs == [str(a), str(tmp_path / "VID_20250512_101500_10_7.insv")]
    assert cmd[cmd.index(str(a)) - 5: cmd.index(str(a)) - 1] == ["-ss", "4.000", "-t", "3.000"]
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert graph.startswith("[0:v]hflip,vflip[s360p0];[1:v]hflip,vflip[s360p1];[s360p0][s360p1]hstack,v360=input=dfisheye")
    # A raw pair never renders as a planet (its uncalibrated seam runs through the middle): crystal becomes a drone shot.
    assert graph.index("input=dfisheye") < graph.index("split[s360y1]") < graph.index("v360@r=input=e:output=flat")
    assert "output=sg" not in graph
    assert "avgblur" in graph and graph.endswith("[v]") and "0:a?" in cmd


@pytest.mark.skipif(not os.environ.get("STUDIO_TEST_INSV"), reason="set STUDIO_TEST_INSV to a real _00_ .insv with its _10_ partner")
def test_a_real_pair_stitches_to_a_level_front_view(tmp_path):
    from pathlib import Path

    src = Path(os.environ["STUDIO_TEST_INSV"])
    if sphere.pair_of(src) is None:
        pytest.skip("no _10_ partner beside the sample")
    assert sphere.is_equirect(2944, 2880, src)
    fov = sphere.best_pair_fov(src, sphere.pair_of(src))
    assert fov in sphere.PAIR_FOVS
    out = sphere.front_view(src, tmp_path / "front.jpg", width=320, at=1.0)
    assert out.exists() and out.stat().st_size > 1000
