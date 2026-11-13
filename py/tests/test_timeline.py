"""studio.timeline: a Google Maps Timeline export becomes the trip's visits and legs, privately (only the trip's days,
no home or work, no raw signals), with countries found offline; footage lands in the right visit; the series route and
the YouTube description use it. All data here is made up, in the shapes of the real exports (research 13 Nov)."""
import json

import pytest

from studio import timeline, vlog

HOME = (-1.30, 36.80)


def _android(tmp_path):
    data = {
        "semanticSegments": [
            {"startTime": "2015-09-12T08:00:00.000+03:00", "endTime": "2015-09-12T09:00:00.000+03:00", "startTimeTimezoneUtcOffsetMinutes": 180,
             "visit": {"topCandidate": {"placeId": "before", "semanticType": "UNKNOWN", "probability": 0.9, "placeLocation": {"latLng": "-1.20°, 36.90°"}}}},
            {"startTime": "2015-09-13T07:00:00.000+03:00", "endTime": "2015-09-13T07:40:00.000+03:00", "startTimeTimezoneUtcOffsetMinutes": 180,
             "visit": {"topCandidate": {"placeId": "home", "semanticType": "INFERRED_HOME", "placeLocation": {"latLng": f"{HOME[0]}°, {HOME[1]}°"}}}},
            {"startTime": "2015-09-13T07:40:00.000+03:00", "endTime": "2015-09-13T12:00:00.000+03:00", "startTimeTimezoneUtcOffsetMinutes": 180,
             "activity": {"start": {"latLng": "-1.30°, 36.80°"}, "end": {"latLng": "-1.49°, 35.14°"}, "distanceMeters": 212400,
                          "topCandidate": {"type": "IN_PASSENGER_VEHICLE", "probability": 0.9}}},
            {"startTime": "2015-09-13T07:40:00.000+03:00", "endTime": "2015-09-13T12:00:00.000+03:00",
             "timelinePath": [{"point": "-1.3001°, 36.8001°", "time": "2015-09-13T07:41:00.000+03:00"},
                              {"point": "-1.10°, 36.40°", "time": "2015-09-13T09:00:00.000+03:00"},
                              {"point": "-1.40°, 35.60°", "time": "2015-09-13T11:00:00.000+03:00"}]},
            {"startTime": "2015-09-13T12:00:00.000+03:00", "endTime": "2015-09-15T08:00:00.000+03:00", "startTimeTimezoneUtcOffsetMinutes": 180,
             "visit": {"topCandidate": {"placeId": "camp", "semanticType": "UNKNOWN", "probability": 0.8, "placeLocation": {"latLng": "-1.49°, 35.14°"}}}},
            {"startTime": "2015-09-15T08:00:00.000+03:00", "endTime": "2015-09-15T08:05:00.000+03:00", "startTimeTimezoneUtcOffsetMinutes": 180,
             "visit": {"topCandidate": {"placeId": "blip", "semanticType": "UNKNOWN", "placeLocation": {"latLng": "-1.50°, 35.10°"}}}},
        ],
        "rawSignals": [{"position": {"LatLng": "-1.3°, 36.8°", "timestamp": "2015-09-13T07:00:00Z"}}, {"wifiScan": {"devicesRecords": [{"mac": 1}]}}],
        "userLocationProfile": {"frequentPlaces": [{"placeId": "home", "placeLocation": f"{HOME[0]}°, {HOME[1]}°", "label": "HOME"}]},
    }
    f = tmp_path / "Timeline.json"
    f.write_text(json.dumps(data), encoding="utf-8")
    return f


def test_android_export_keeps_the_trip_days_and_nothing_private(tmp_path):
    out = tmp_path / "vlog-timeline.json"
    s = timeline.import_file(_android(tmp_path), ("2015-09-13", "2015-09-22"), out=out)
    assert s["source"] == "android"
    kept = json.loads(out.read_text(encoding="utf-8"))
    text = out.read_text(encoding="utf-8")
    assert list(kept["days"]) == ["2015-09-13", "2015-09-15"], "12 Sep is outside the trip"
    assert "wifi" not in text.lower() and "rawSignals" not in text and "HOME" not in text and '"home"' not in text, "no raw signals, no home"
    assert kept["hidden"] == 1
    d = kept["days"]["2015-09-13"]
    camp = d["visits"][0]
    assert camp["country"] == "Kenya" and camp["min"] == 44 * 60 and camp["show"]
    assert kept["days"]["2015-09-15"]["visits"][0]["show"] is False, "a 5-minute stop is hidden by default"
    leg = d["legs"][0]
    assert leg["mode"] == "drive" and leg["km"] == 212.4 and leg["to"] == camp["id"]
    assert all(timeline.km_between((p[0], p[1]), HOME) >= timeline.HOME_TRIM_KM for p in leg["path"]), "the road does not start at the door"


def test_iphone_and_takeout_and_gpx_read_the_same_way(tmp_path):
    ios = [{"startTime": "2015-09-16T10:00:00.000+03:00", "endTime": "2015-09-16T12:00:00.000+03:00",
            "visit": {"hierarchyLevel": "0", "topCandidate": {"probability": "0.6", "semanticType": "Unknown", "placeID": "x", "placeLocation": "geo:-1.47,34.78"}}},
           {"startTime": "2015-09-16T12:00:00.000+03:00", "endTime": "2015-09-16T13:00:00.000+03:00",
            "activity": {"start": "geo:-1.47,34.78", "end": "geo:-1.56,34.89", "distanceMeters": "18000", "topCandidate": {"type": "in passenger vehicle"}}}]
    f = tmp_path / "location-history.json"
    f.write_text(json.dumps(ios), encoding="utf-8")
    fmt, segs, _ = timeline.sniff(f)
    assert fmt == "iphone" and segs[0]["lat"] == -1.47 and segs[1]["mode"] == "drive"
    sem = {"timelineObjects": [{"placeVisit": {"location": {"latitudeE7": 252700000, "longitudeE7": 516100000, "placeId": "p", "name": "Souq Waqif"},
                                               "duration": {"startTimestamp": "2015-09-21T17:00:00Z", "endTimestamp": "2015-09-21T20:00:00Z"}}},
                               {"activitySegment": {"duration": {"startTimestamp": "2015-09-21T06:10:00Z", "endTimestamp": "2015-09-21T14:25:00Z"},
                                                    "activityType": "FLYING", "distance": 3500000,
                                                    "startLocation": {"latitudeE7": -34300000, "longitudeE7": 370700000},
                                                    "endLocation": {"latitudeE7": 252700000, "longitudeE7": 516100000}}}]}
    g = tmp_path / "2015_SEPTEMBER.json"
    g.write_text(json.dumps(sem), encoding="utf-8")
    fmt, segs, _ = timeline.sniff(g)
    assert fmt == "takeout-semantic"
    tl = timeline.normalise(segs, [], None)
    day = tl["days"]["2015-09-21"]
    assert day["visits"][0]["country"] == "Qatar"
    assert day["legs"][0]["mode"] == "flight" and len(day["legs"][0]["path"]) == 2, "a flight is drawn as an arc, not a path"
    gpx = tmp_path / "walk.gpx"
    gpx.write_text('<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="-3.18" lon="35.58"><time>2015-09-19T08:00:00Z</time></trkpt>'
                   '<trkpt lat="-3.20" lon="35.60"><time>2015-09-19T09:00:00Z</time></trkpt></trkseg></trk></gpx>', encoding="utf-8")
    assert timeline.sniff(gpx)[0] == "gpx"
    bad = tmp_path / "x.json"
    bad.write_text('{"hello": 1}', encoding="utf-8")
    with pytest.raises(ValueError, match="not a Google Maps Timeline export"):
        timeline.sniff(bad)


def test_countries_offline():
    assert timeline.country(-1.49, 35.14) == "Kenya"
    assert timeline.country(-2.33, 34.83) == "Tanzania"
    assert timeline.country(25.27, 51.53) == "Qatar"
    assert timeline.country(35.68, 139.69) == "Japan", "outside East Africa: the world outlines"
    assert timeline.country(0.0, -30.0) is None, "the sea"


def test_footage_lands_in_its_visit_with_the_right_clock(tmp_path):
    out = tmp_path / "t.json"
    timeline.import_file(_android(tmp_path), ("2015-09-13", "2015-09-22"), out=out)
    tl = timeline.load(out)
    m = timeline.match([
        {"path": "video.mp4", "captured": "2015-09-13T10:00:00+00:00", "clock": "utc"},     # 13:00 local: at camp
        {"path": "photo.jpg", "captured": "2015-09-13T10:00:00+00:00", "clock": "wall"},    # 10:00 local: on the road
        {"path": "late.jpg", "captured": "2015-09-15T05:20:00+00:00", "clock": "utc"},      # 20 min after the camp: snapped
        {"path": "lost.jpg", "captured": "2015-09-20T10:00:00+00:00", "clock": "utc"},      # nowhere near
    ], tl)
    camp = tl["days"]["2015-09-13"]["visits"][0]["id"]
    assert m["video.mp4"] == {"visit": camp, "day": "2015-09-13", "approx": False}
    assert "leg" in m["photo.jpg"], "a photo's wall clock is local time"
    assert m["late.jpg"]["approx"] is True
    assert "lost.jpg" not in m, "never a made-up place"


def test_the_series_route_and_description_use_it(tmp_path):
    out = tmp_path / "t.json"
    timeline.import_file(_android(tmp_path), ("2015-09-13", "2015-09-22"), out=out)
    tl = timeline.load(out)
    day = tl["days"]["2015-09-13"]
    timeline.choose([{"day": "2015-09-13", "id": day["visits"][0]["id"], "name": "River Camp <b>"}], path=out)
    tl = timeline.load(out)
    assert tl["days"]["2015-09-13"]["visits"][0]["name"] == "River Camp b", "the person's words, cleaned"
    route = vlog.with_timeline({}, {}, {"2015-09-13": "Masai Mara"}, tl)
    r = route["2015-09-13"]
    assert r["timeline"] and r["country"] == "Kenya" and r["place"] == "Masai Mara"
    stop = r["stops"][0]
    assert stop["place"] == "River Camp b" and stop["by"] == "road" and stop["leg"].endswith("drive · 212 km") and stop["main"]
    assert stop["via"] and all(len(p) == 2 for p in stop["via"]), "the real road, as [lon, lat]"
    own = vlog.with_timeline({"2015-09-13": {"place": "x"}}, {"2015-09-13": {"stops": [{"place": "My own"}]}}, {}, tl)
    assert own["2015-09-13"] == {"place": "x"}, "a day whose stops the person wrote stays theirs"
    assert timeline.stay_words(44 * 60) == "2 nights" and timeline.stay_words(190) == "3 h 10 min" and timeline.stay_words(40) == "40 min"
    assert timeline.leg_words({"mode": "flight", "min": 495, "km": 3500}) == "Flight · 8 h 15 min"
    video = {"n": 1, "title": "t", "span": "13 Sep", "series": {"n": 1, "of": 2}}
    chapters = [{"day": "2015-09-13", "dayNo": 1, "atSec": 0, "title": "Leopard"}, {"day": "2015-09-13", "dayNo": 1, "atSec": 60, "title": "Camp"},
                {"day": "2015-09-13", "dayNo": 1, "atSec": 200, "title": "Night"}]
    text = vlog._series_text(video, chapters, 600, "Highlands & Coast", {"route": route, "titles": {2: "Next"}})["description"]
    assert "drive · 212 km → River Camp b · 2 nights" in text
    assert "35.14" not in text and "-1.49" not in text, "never coordinates in the description"
    assert timeline.forget(out) and not out.exists()
