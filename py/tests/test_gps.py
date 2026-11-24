"""Positions: video ISO 6709 tags, DJI flight logs, and the time-based estimate for files with none (studio.gps)."""
import random
from pathlib import Path

from studio import footage, gps
from studio.db import connect

NINE = lambda lat, lon, when: 9.0  # noqa: E731 - every GPS file in these tests is in Japan (UTC+9)


def test_iso6709_as_phones_and_cameras_write_it():
    assert gps.parse_iso6709("+36.4778+138.5050/") == (36.4778, 138.505)
    assert gps.parse_iso6709("+36.4778+138.5050+012.345/") == (36.4778, 138.505)  # with altitude
    assert gps.parse_iso6709("-33.8688+151.2093/") == (-33.8688, 151.2093)
    assert gps.parse_iso6709("+40.7128-074.0060/") == (40.7128, -74.006)
    assert gps.parse_iso6709("+1.2345+3.4567/") == (1.2345, 3.4567)  # Android's short form
    lat, lon = gps.parse_iso6709("+3628.668+13830.300/")  # degrees and minutes
    assert abs(lat - 36.4778) < 1e-4 and abs(lon - 138.505) < 1e-4
    lat, lon = gps.parse_iso6709("+362840.08+1383018.0/")  # degrees, minutes, seconds
    assert abs(lat - 36.47780) < 1e-4 and abs(lon - 138.50500) < 1e-4
    assert gps.parse_iso6709("+36.4778+138.5050+12.3CRSWGS_84/") == (36.4778, 138.505)
    for bad in (None, "", "abc", "+0.0000+0.0000/", "+95.0+010.0/", "+36.4+190.0/", "36.4778,138.505"):
        assert gps.parse_iso6709(bad) is None, bad


def test_a_video_position_is_found_under_any_of_its_tag_names():
    assert gps.gps_from_tags({"com.apple.quicktime.location.ISO6709": "+35.6812+139.7671+040.000/"}) == (35.6812, 139.7671)
    assert gps.gps_from_tags({"location": "+35.6812+139.7671/", "creation_time": "2026-10-23T06:45:10Z"}) == (35.6812, 139.7671)
    assert gps.gps_from_tags({"location-eng": "+35.6812+139.7671/"}) == (35.6812, 139.7671)
    assert gps.gps_from_tags({"©xyz": "+35.6812+139.7671/"}) == (35.6812, 139.7671)
    assert gps.gps_from_tags({"LOCATION": "+35.6812+139.7671/"}) == (35.6812, 139.7671)
    assert gps.gps_from_tags({"creation_time": "2026-10-23T06:45:10Z"}) is None and gps.gps_from_tags(None) is None


MINI4 = """1
00:00:00,000 --> 00:00:00,033
<font size="36">SrtCnt : 1, DiffTime : 33ms
2025-08-09 16:38:48,958,725
[iso : 100] [shutter : 1/5000.0] [fnum : 280] [ev : 0] [ct : 5256] [color_md : default] [focal_len : 224] [latitude: 0.000000] [longitude: 0.000000] [altitude: 1.600000]
</font>

2
00:00:00,033 --> 00:00:00,066
<font size="36">SrtCnt : 2, DiffTime : 33ms
[iso : 100] [latitude: 36.663572] [longitude: 138.416946] [altitude: 1.600000]
</font>
"""
MINI3 = "[latitude: 36.589316] [longitude: 138.509589] [rel_alt: 1.200 abs_alt: 1234.5]\n[latitude: 36.5894] [longitude: 138.5097] [rel_alt: 2.0 abs_alt: 1235]"
MINI2 = "[latitude : 35.6812] [longtitude : 139.7671] [altitude: 40.1]"
PHANTOM = "HOME(139.7671,35.6812) 2017.08.05 14:11:51\nGPS(139.7672,35.6813,15) BAROMETER:48.3"


def test_every_dji_log_format_gives_its_points_and_the_first_real_fix():
    pts = gps.srt_points(MINI4)
    assert [(p["lat"], p["lon"], p["rel_alt"]) for p in pts] == [(0.0, 0.0, 1.6), (36.663572, 138.416946, 1.6)]
    assert gps.first_fix(pts) == (36.663572, 138.416946), "the 0,0 rows before the GPS locks are skipped"
    assert [p["rel_alt"] for p in gps.srt_points(MINI3)] == [1.2, 2.0]
    assert gps.first_fix(gps.srt_points(MINI2)) == (35.6812, 139.7671), "DJI's own spelling 'longtitude'"
    assert gps.first_fix(gps.srt_points(PHANTOM)) == (35.6813, 139.7672), "GPS(lon, lat, alt): longitude first"
    assert gps.srt_points("no positions here") == []


def _asset(con, path, kind, **cols):
    cols = {"path": path, "kind": kind, **cols}
    con.execute(f"INSERT INTO assets ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", tuple(cols.values()))
    return con.execute("SELECT id FROM assets WHERE path = ?", (path,)).fetchone()[0]


def test_a_drone_video_takes_its_own_logs_first_fix_and_nothing_else(tmp_path):
    a, b = tmp_path / "flight-a", tmp_path / "flight-b"
    with connect() as con:
        video = _asset(con, str(a / "DJI_0693.MP4"), "video", device="dji")
        _asset(con, str(a / "DJI_0693.SRT"), "telemetry", device="dji")
        other = _asset(con, str(b / "DJI_0693.MP4"), "video", device="dji")  # same name, another folder: not its log
        kept = _asset(con, str(a / "DJI_0700.MP4"), "video", device="dji", lat=35.0, lon=139.0)  # has a position already
        _asset(con, str(a / "DJI_0700.SRT"), "telemetry", device="dji")
        logs = {"DJI_0693.SRT": MINI4, "DJI_0700.SRT": MINI3}
        placed = gps.join_srt(con, read=lambda p: logs[Path(p).name])
        rows = {r["id"]: (r["lat"], r["lon"]) for r in con.execute("SELECT id, lat, lon FROM assets WHERE id IN (?, ?, ?)", (video, other, kept))}
        assert placed >= 1
        assert rows[video] == (36.663572, 138.416946)
        assert rows[other] == (None, None)
        assert rows[kept] == (35.0, 139.0), "a real position is never overwritten"
        assert con.execute("SELECT COUNT(*) FROM telemetry WHERE asset_id = ?", (video,)).fetchone()[0] == 2
        again = gps.join_srt(con, read=lambda p: logs[Path(p).name])  # a second run adds nothing twice
        assert con.execute("SELECT COUNT(*) FROM telemetry WHERE asset_id = ?", (video,)).fetchone()[0] == 2 and again == 0


def test_clock_kinds():
    assert gps.clock("2025-08-09T07:38:48.000000Z", "video")[0] == "utc"
    assert gps.clock("2025-08-09T16:38:46+00:00", "photo") == ("wall", gps.datetime(2025, 8, 9, 16, 38, 46))
    assert gps.clock("2026-10-23T06:45:10+00:00", "video")[0] == "utc", "a Google Photos file time on a video is UTC"
    assert gps.clock("2025-08-08T11:30:31", "photo")[0] == "wall"
    assert gps.clock("2025-08-08T20:30:31+09:00", "photo") == ("utc", gps.datetime(2025, 8, 8, 11, 30, 31, tzinfo=gps.timezone.utc))
    assert gps.clock("1970-01-01T00:00:00Z", "video") is None and gps.clock(None, "photo") is None and gps.clock("soon", "photo") is None


def test_the_zone_of_a_gps_file_is_the_studios_own_unless_it_was_filmed_far_away():
    when = gps.datetime(2025, 8, 9, 12, 0)
    assert gps.zone_hours(36.6, 138.5, when, home=lambda w: 9.0) == 9.0
    assert gps.zone_hours(-1.29, 36.82, when, home=lambda w: 9.0) == 2.0, "Nairobi from a Japanese studio: its nominal hour"
    assert gps.zone_hours(51.5, -0.12, when, home=lambda w: 1.0) == 1.0, "London in summer time from a London studio"


ANCHOR = {"id": 10, "kind": "photo", "captured_at": "2025-08-09T16:38:46+00:00", "lat": 36.663571, "lon": 138.416949}


def test_a_file_with_no_position_takes_the_nearest_gps_file_in_time():
    rows = [ANCHOR,
            {"id": 11, "kind": "photo", "captured_at": "2025-08-09T16:47:12+00:00", "lat": 36.663538, "lon": 138.416908},
            {"id": 1, "kind": "video", "captured_at": "2025-08-09T07:50:00.000000Z", "lat": None, "lon": None},  # 16:50 there
            {"id": 2, "kind": "photo", "captured_at": "2025-08-09T16:00:00+00:00", "lat": None, "lon": None},
            {"id": 3, "kind": "photo", "captured_at": "2025-08-09T16:30:00+00:00", "lat": 0.0, "lon": 0.0}]  # placeholder fix
    est = gps.estimate(rows, zone=NINE)
    assert est[1] == {"lat": 36.663538, "lon": 138.416908, "from": 11, "gap": -3}, "the video: a photo 3 min earlier"
    assert est[2] == {"lat": 36.663571, "lon": 138.416949, "from": 10, "gap": 39}, "a photo 39 min later"
    assert est[3]["from"] == 10 and est[3]["gap"] == 9
    assert 10 not in est and 11 not in est, "a file with its own position is never estimated"
    shuffled = rows[:]
    random.Random(4).shuffle(shuffled)
    assert gps.estimate(shuffled, zone=NINE) == est, "the answer never depends on row order"


def test_no_estimate_when_too_far_in_time_on_another_day_or_when_the_gps_files_disagree():
    far = [ANCHOR, {"id": 1, "kind": "photo", "captured_at": "2025-08-09T18:10:00+00:00", "lat": None, "lon": None}]  # 92 min
    assert gps.estimate(far, zone=NINE) == {}
    edge = [ANCHOR, {"id": 1, "kind": "photo", "captured_at": "2025-08-09T18:08:46+00:00", "lat": None, "lon": None}]  # 90 min
    assert gps.estimate(edge, zone=NINE)[1]["gap"] == -90
    night = [{**ANCHOR, "captured_at": "2025-08-09T23:50:00+00:00"},
             {"id": 1, "kind": "photo", "captured_at": "2025-08-10T00:20:00+00:00", "lat": None, "lon": None}]
    assert gps.estimate(night, zone=NINE) == {}, "30 minutes apart but another day"
    moving = [ANCHOR, {"id": 12, "kind": "photo", "captured_at": "2025-08-09T16:55:00+00:00", "lat": 36.70, "lon": 138.42},  # 4 km on
              {"id": 1, "kind": "photo", "captured_at": "2025-08-09T16:45:00+00:00", "lat": None, "lon": None}]
    assert gps.estimate(moving, zone=NINE) == {}, "the GPS files in the window are more than 2 km apart"
    close = [ANCHOR, {"id": 12, "kind": "photo", "captured_at": "2025-08-09T16:55:00+00:00", "lat": 36.672, "lon": 138.42},  # 1 km
             {"id": 1, "kind": "photo", "captured_at": "2025-08-09T16:45:00+00:00", "lat": None, "lon": None}]
    assert gps.estimate(close, zone=NINE)[1]["from"] == 10
    tie = [ANCHOR, {**ANCHOR, "id": 4, "captured_at": "2025-08-09T16:38:46+00:00"},
           {"id": 1, "kind": "photo", "captured_at": "2025-08-09T16:40:00+00:00", "lat": None, "lon": None}]
    assert gps.estimate(tie, zone=NINE)[1]["from"] == 4, "a tie goes to the lower id"
    assert gps.estimate([{"id": 1, "kind": "photo", "captured_at": "2025-08-09T16:40:00+00:00", "lat": None, "lon": None}]) == {}


def test_estimates_are_stored_apart_and_counted_per_device(tmp_path, monkeypatch):
    monkeypatch.setattr(gps, "home_offset_hours", lambda when: 9.0)  # a studio in Japan, whatever this computer's zone
    # The test catalogue is shared by the whole run: these rows use their own devices and a date nothing else has.
    with connect() as con:
        real = _asset(con, str(tmp_path / "insta" / "IMG_1.jpg"), "photo", device="t-insta", captured_at="2031-03-03T16:38:46+00:00",
                      lat=36.663571, lon=138.416949)
        phone = _asset(con, str(tmp_path / "phone" / "VID_1.mp4"), "video", device="t-phone", captured_at="2031-03-03T07:50:00Z")
        gp = _asset(con, str(tmp_path / "imports" / "google-photos" / "x" / "PXL_1.jpg"), "photo", device="t-phone",
                    captured_at="2031-01-01T10:00:00+00:00")
        canon = _asset(con, str(tmp_path / "canon" / "IMG_2.JPG"), "photo", device="t-canon")
        gps.estimate_all(con)
        row = dict(con.execute("SELECT lat, est_lat, est_lon, est_from, est_gap_min FROM assets WHERE id = ?", (phone,)).fetchone())
        assert row["lat"] is None and (row["est_lat"], row["est_lon"], row["est_from"]) == (36.663571, 138.416949, real)
        assert row["est_gap_min"] == -11, "the video (07:50 UTC = 16:50 there) and a photo 11 minutes earlier"
        rep = {d["device"]: d for d in gps.report(con)["devices"]}
        assert (rep["t-phone"]["files"], rep["t-phone"]["real"], rep["t-phone"]["estimated"], rep["t-phone"]["none"], rep["t-phone"]["googlePhotos"]) == (2, 0, 1, 1, 1)
        assert (rep["t-insta"]["real"], rep["t-canon"]["none"], rep["t-canon"]["googlePhotos"]) == (1, 1, 0)
        only = gps.report(con, {phone, canon})  # the map's own files: its line counts what its dots count
        assert (only["files"], only["real"], only["estimated"], only["none"], only["googlePhotos"]) == (2, 0, 1, 1, 0)
        assert only["files"] == only["real"] + only["estimated"] + only["none"], "the numbers add up"
        con.execute("UPDATE assets SET captured_at = NULL WHERE id = ?", (real,))
        gps.estimate_all(con)
        assert con.execute("SELECT est_lat FROM assets WHERE id = ?", (phone,)).fetchone()[0] is None, "estimates are recomputed every run"
        assert con.execute("SELECT est_lat FROM assets WHERE id = ?", (gp,)).fetchone()[0] is None
        con.execute("DELETE FROM assets WHERE id IN (?, ?, ?, ?)", (real, phone, gp, canon))


def test_the_map_shows_estimated_files_apart_from_real_ones():
    rows = [{"id": 1, "lat": 36.58934, "lon": 138.50962, "kind": "photo", "used": True, "captured": "2025-08-07T12:16:45"},
            {"id": 2, "lat": None, "lon": None, "est_lat": 36.58941, "est_lon": 138.50958, "est_gap": -12, "kind": "video",
             "used": False, "captured": "2025-08-09T07:50:00Z"},
            {"id": 3, "lat": None, "lon": None, "est_lat": 36.5894, "est_lon": 138.5096, "est_gap": 40, "kind": "video", "used": False},
            {"id": 4, "lat": None, "lon": None, "kind": "photo", "used": False}]
    p = footage.cluster_places(rows, {"lat": 36.5893, "lon": 138.5096, "radiusKm": 2})
    (c,) = p["clusters"]
    assert (c["clips"], c["real"], c["est"], c["gap"], c["first"], c["last"]) == (3, 1, 2, [12, 40], "2025-08-07", "2025-08-09")
    assert (p["placed"], p["estimated"], p["unplaced"]) == (1, 2, 1)
