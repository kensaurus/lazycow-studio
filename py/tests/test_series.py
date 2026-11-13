"""A trip as a series of long videos (studio.vlog series): days in the trip's own time (photos keep their camera's
clock), the route and its pins, even episodes of the length the person sets with each day once and the story kept
together, the moments a long clip gives, the length check, the graphics' props and the YouTube text with its links."""
import json

import numpy as np
import pytest

import studio.vlog as vlog

DAYS = [f"2015-09-{d}" for d in range(13, 22)]
# A nine-day trip's material per day (seconds of usable footage, as vlog._capacity counts it).
TRIP_CAP = dict(zip(DAYS, [772.7, 1666.3, 764.5, 469.3, 1433.7, 330.3, 657.8, 268.2, 98.9]))
TRIP_COUNTRY = {**{d: "Kenya" for d in DAYS[:3]}, **{d: "Tanzania" for d in DAYS[3:8]}, "2015-09-21": "Qatar"}
TRIP_TRAVEL = {"2015-09-13", "2015-09-21"}  # a flight that day


def test_videos_keep_utc_and_photos_keep_their_cameras_clock():
    late = {"kind": "video", "captured": "2015-09-13T23:29:00+00:00"}
    assert vlog.local_time(late, "Africa/Nairobi") == "2015-09-14T02:29:00", "a clip's time is UTC: 02:29 the next day in Kenya"
    assert vlog.local_time(late, None) == "2015-09-13T23:29:00", "no zone in the notes: as before"
    canon = {"kind": "photo", "device": "canon", "captured": "2015-09-14T21:10:00+00:00"}  # EXIF wall time, stored as +00:00
    assert vlog.local_time(canon, "Africa/Nairobi", {"canon": "+09:00"}) == "2015-09-14T15:10:00", "the camera ran on UTC+9: 15:10 in Kenya"
    assert vlog.local_time(canon, "Africa/Nairobi", {}) == "2015-09-14T21:10:00", "a camera not listed showed local time"
    zoned = {"kind": "photo", "captured": "2015-09-14T09:00:00+09:00"}
    assert vlog.local_time(zoned, "Africa/Nairobi") == "2015-09-14T03:00:00", "a real zone in the file is exact"
    assert vlog._day({"captured": "2015-09-13T23:29:00+00:00", "_local": "2015-09-14T02:29:00"}) == "2015-09-14"
    assert vlog.zone_hours("Africa/Nairobi") == 3 and vlog.zone_hours("UTC+9") == 9 and vlog.zone_hours("-03:30") == -3.5
    assert vlog.zone_hours("Mars/Olympus") is None and vlog.zone_hours(True) is None


def test_a_cameras_clock_is_measured_from_photos_that_match_a_clip():
    rng = np.random.default_rng(3)
    rows = []
    for k in range(30):
        e = rng.normal(size=16).astype("float32")
        rows.append(({"kind": "video", "captured": f"2015-09-14T{4 + k % 10:02d}:{k:02d}:00+00:00"}, e))
        rows.append(({"kind": "photo", "device": "canon", "captured": f"2015-09-14T{13 + k % 10:02d}:{k:02d}:10+00:00"}, e + rng.normal(scale=0.01, size=16).astype("float32")))
    rows.append(({"kind": "photo", "device": "phone", "captured": "2015-09-14T10:00:00+00:00"}, rng.normal(size=16).astype("float32")))
    assert vlog.clock_offsets(rows) == {"canon": 9.0}, "30 pairs, all 9 h apart; the phone has no pair"


def test_the_route_takes_the_persons_positions_and_pins_the_rest(tmp_path, monkeypatch):
    monkeypatch.setattr(vlog, "TRIP_FILE", tmp_path / "trip.json")
    (tmp_path / "trip.json").write_text(json.dumps({
        "places": {"2015-09-14": "Masai Mara National Reserve", "2015-09-20": "Somewhere nobody knows"},
        "tz": "Africa/Nairobi", "clocks": {"canon": "+09:00", "bad": "soon"}, "target": 12,
        "route": {"2015-09-21": {"place": "Kilimanjaro → Dar es Salaam → Doha", "country": "Qatar", "stops": [
            {"place": "Kilimanjaro International Airport (JRO)", "by": "road"},
            {"place": "Dar es Salaam (DAR)", "by": "flight", "stop": True},
            {"place": "Doha (DOH)", "lat": 25.27, "lon": 51.61, "country": "Qatar", "by": "flight", "main": True}]}}}), encoding="utf-8")
    t = vlog.trip()
    assert t["tz"] == "Africa/Nairobi" and t["clocks"] == {"canon": "+09:00"} and t["target"] == 12
    mara = t["route"]["2015-09-14"]
    assert (mara["country"], round(mara["lat"], 1), round(mara["lon"], 1)) == ("Kenya", -1.5, 35.1), "a day with only words gets its pin"
    assert "2015-09-20" not in t["route"], "no pin for words the studio does not know: no map point, never a guess"
    fly = t["route"]["2015-09-21"]
    assert [s["by"] for s in fly["stops"][1:]] == ["flight", "flight"] and fly["stops"][0]["lat"] == -3.43, "JRO from its pin"
    assert (fly["lat"], fly["lon"], fly["country"]) == (25.27, 51.61, "Qatar"), "the main stop is where the day is pinned"
    (tmp_path / "trip.json").write_text(json.dumps({"target": 40}), encoding="utf-8")
    assert vlog.trip()["target"] == vlog.SERIES_TARGET, "a length out of 5-15 falls back to 10"


def test_a_nine_day_trip_becomes_four_even_episodes_with_the_story_kept_together():
    got = vlog.series_split(DAYS, TRIP_CAP, 10.0, moments={"2015-09-17"}, country=TRIP_COUNTRY, travel=TRIP_TRAVEL)
    assert got == [DAYS[:2], DAYS[2:3], DAYS[3:5], DAYS[5:]], got
    assert [d for g in got for d in g] == DAYS, "every day once, in order"
    plain = vlog.series_split(DAYS, TRIP_CAP, 10.0)
    assert len(plain) == 4 and plain != got, "evenness alone cuts the noted moment off from the border day: the story rules decide"
    assert all(sum(TRIP_CAP[d] for d in g) >= 1.25 * 600 for g in got), "each episode has material for an honest 10 minutes"


def test_the_episode_length_sets_how_many_episodes():
    longer = vlog.series_split(DAYS, TRIP_CAP, 15.0, moments={"2015-09-17"}, country=TRIP_COUNTRY, travel=TRIP_TRAVEL)
    shorter = vlog.series_split(DAYS, TRIP_CAP, 5.0, moments={"2015-09-17"}, country=TRIP_COUNTRY, travel=TRIP_TRAVEL)
    assert len(longer) < 4 < len(shorter)
    assert vlog.series_split(["d1"], {"d1": 60.0}, 10.0) == [["d1"]], "too little for even one: one, as long as it honestly gets"
    assert vlog.series_split([], {}, 10.0) == []


def test_a_long_clip_gives_several_moments_each_from_its_own_stretch():
    clip = {"kind": "video", "duration": 60.0, "path": "lion.mp4", "aesthetic": 7, "sharp": 40, "junk": 0, "captured": "2015-09-15T08:00:00"}
    assert vlog._moments(clip) == 3 and vlog._moments({"kind": "video", "duration": 20}) == 1 and vlog._moments({"kind": "photo"}) == 1
    assert vlog.shot_seconds(clip, "documentary") == 8.0 and vlog.shot_seconds(clip, "documentary", vlog.SERIES_HOLD) == 14.0, "a series holds longer"
    assert vlog.shot_seconds({**clip, "_part": [1, 3]}, "documentary", vlog.SERIES_HOLD) == 14.0
    assert vlog._part_span({**clip, "part": [1, 3]}) == (20.0, 40.0) and vlog._part_span(clip) is None
    e = np.ones(4, "float32")
    out = vlog._more_moments([(clip, e)], 40.0, "documentary", vlog.SERIES_HOLD)
    assert [c[0]["_part"] for c in out] == [[0, 3], [1, 3], [2, 3]], "three stretches, in order"
    assert vlog._more_moments([(clip, e)], 10.0, "documentary", vlog.SERIES_HOLD) == [(clip, e)], "a day already full keeps one moment"


def _rows(seed: int = 11):
    """Nine days of a trip: clips of 50 s (so each gives three moments) and photos, in East Africa time."""
    rng = np.random.default_rng(seed)
    names = [c[0] for c in vlog.CONCEPTS]
    rows = []
    for di, d in enumerate(DAYS):
        clips = 26 if d in ("2015-09-14", "2015-09-17") else 12
        for k in range(clips + 20):
            e = rng.normal(scale=0.15, size=len(names)).astype("float32")
            e[names.index(["Lions", "Elephants", "Zebras", "Wildebeest", "Giraffes"][k % 5])] += 1.0
            video = k < clips
            rows.append(({"path": f"{d}-{k}.{'mp4' if video else 'jpg'}", "kind": "video" if video else "photo", "duration": 50.0 if video else None,
                          "aesthetic": 5 + rng.random() * 2, "sharp": 40, "junk": 0, "captured": f"{d}T{6 + k % 12:02d}:{k:02d}:00+00:00"}, e))
    return rows


@pytest.fixture
def trip_notes(tmp_path, monkeypatch):
    monkeypatch.setattr(vlog, "TRIP_FILE", tmp_path / "trip.json")
    monkeypatch.setattr(vlog, "PLAN_FILE", tmp_path / "vlog-plan.json")
    monkeypatch.setattr(vlog, "private_paths", lambda rows=None: {})  # needs the search model; privacy has its own tests
    monkeypatch.setattr(vlog, "_concept_matrix", lambda: np.eye(len(vlog.CONCEPTS), dtype="float32"))
    route = {d: {"place": "Masai Mara National Reserve" if d < "2015-09-16" else "Serengeti National Park"} for d in DAYS}
    route["2015-09-21"] = {"place": "Doha", "country": "Qatar", "stops": [{"place": "JRO", "lat": -3.43, "lon": 37.07, "by": "road"},
                                                                          {"place": "Doha", "lat": 25.27, "lon": 51.61, "country": "Qatar", "by": "flight", "main": True}]}
    (tmp_path / "trip.json").write_text(json.dumps({"tz": "Africa/Nairobi", "moments": {"2015-09-17": "A birthday by the river"}, "route": route,
                                                    "places": {"2015-09-15": "A camp by the river"}}), encoding="utf-8")
    return tmp_path


def test_a_series_knows_its_place_in_the_story(trip_notes):
    p = vlog.series(target=5.0, name="Highlands & Coast", titles=["", "", "The River Crossing and a Birthday"], dry=True, _rows=_rows())
    vids, N = p["videos"], len(p["videos"])
    assert N >= 3 and p["series"] == {"target": 5.0, "band": vlog.SERIES_BAND, "of": N, "look": "documentary"}
    assert [d for v in vids for d in v["days"]] == DAYS, "each day in exactly one episode, in order"
    assert all(v["look"] == "documentary" for v in vids), "one look for the whole series"
    assert all(v["title"].startswith(f"Highlands & Coast · Part {v['n']} of {N}: ") for v in vids)
    third = vids[2]
    assert third["title"] == f"Highlands & Coast · Part 3 of {N}: The River Crossing and a Birthday" and third["fixedTitle"], "the person's own title stays"
    assert [(v["prev"], v["next"]) for v in vids][0] == (None, 2) and vids[-1]["next"] is None
    assert "recap" not in vids[0] and all(1 <= len(v["recap"]) <= vlog.SERIES_RECAP for v in vids[1:]), "previously, from part 2 on"
    assert {s["path"] for s in vids[1]["recap"]} <= {s["path"] for c in vids[0]["chapters"] for s in c["shots"]}, "the recap shows the part before"
    for v in vids:
        teaser = sum(s["sec"] for s in v["teaser"]) - vlog.fade_sec("documentary") * (len(v["teaser"]) - 1)
        assert vlog.SERIES_END - 0.1 <= teaser <= vlog.SERIES_END + 6, teaser
        assert abs(vlog._mix(v)["minutes"] - 5.0) <= vlog.SERIES_BAND, (v["n"], vlog._mix(v)["minutes"])
    assert {s["path"] for s in vids[-1]["teaser"]} & {s["path"] for s in vids[0]["cold"]}, "the last part's card points back to Part 1"
    moment = next(v for v in vids if "2015-09-17" in v["days"])
    assert moment["arc"] == "A birthday by the river" and "high point" in moment["moods"][0], "the person's note and the music of the peak"
    assert all(s["path"].startswith("2015-09-17") for s in moment["cold"]), "the cold open is the moment day"
    assert any(s.get("part") for v in vids for c in v["chapters"] for s in c["shots"]), "long clips give more than one moment"
    assert p["dayOf"] == 9 and vids[0]["chapters"][0]["dayNo"] == 1


def test_length_fit_trims_or_holds_to_the_target():
    shot = lambda score, sec=6.0, kind="video": {"kind": kind, "sec": sec, "score": score, "duration": 40.0, "path": f"{score}"}  # noqa: E731
    long = {"series": {"n": 1, "of": 2}, "cold": [], "chapters": [{"shots": [shot(s) for s in range(30)]}]}
    r = vlog.length_fit(long, "documentary", target=120, band=20)
    assert r["lengthOk"] and r["trimmed"] > 0 and long["chapters"][0]["shots"][0]["score"] == 0, "the first shot of a chapter stays"
    short = {"series": {"n": 1, "of": 2}, "cold": [], "chapters": [{"shots": [shot(s) for s in range(10)]}]}
    r = vlog.length_fit(short, "documentary", target=120, band=10)
    assert r["held"] > 0 and r["lengthOk"] and max(s["sec"] for s in short["chapters"][0]["shots"]) <= 20.0, "best clips hold longer, never past 20 s"


def test_the_place_tag_shows_the_border_when_the_country_changes():
    route = {"2015-09-15": {"place": "Masai Mara National Reserve", "country": "Kenya", "stops": [{"country": "Kenya"}]},
             "2015-09-16": {"place": "Lamai Gate, Northern Serengeti", "country": "Tanzania", "stops": [{"country": "Kenya"}, {"country": "Tanzania"}]},
             "2015-09-17": {"place": "Mara River, Northern Serengeti", "country": "Tanzania", "stops": [{"country": "Tanzania"}]}}
    chapters = [{"day": d, "place": "the person's words"} for d in ("2015-09-16", "2015-09-17")]
    lines = vlog._place_lines(chapters, route, True)
    assert lines[0] == {"place": "Lamai Gate, Northern Serengeti", "country": "Tanzania", "border": "KENYA → TANZANIA"}, "the day began in Kenya"
    assert lines[1]["border"] is None
    assert vlog._place_lines(chapters, route, False)[0]["place"] is None, "places switched off"


def test_series_props_and_youtube_text(trip_notes):
    plan = {"name": "Highlands & Coast", "dayOf": 10, "series": {"target": 10, "band": 1, "of": 2}, "videos": [
        {"n": 1, "title": "Highlands & Coast · Part 1 of 2: A Leopard in a Tree", "days": ["2015-09-13", "2015-09-14"], "series": {"n": 1, "of": 2},
         "chapters": [{"day": "2015-09-13", "dayNo": 1, "title": "Leopards", "shots": []}]},
        {"n": 2, "title": "Highlands & Coast · Part 2 of 2: The River Crossing and a Birthday", "episode": "The River Crossing and a Birthday",
         "days": ["2015-09-16", "2015-09-17"], "series": {"n": 2, "of": 2}, "summary": "Over the border to the river.",
         "chapters": [{"day": "2015-09-16", "dayNo": 4, "title": "Lamai Gate", "shots": []}, {"day": "2015-09-17", "dayNo": 5, "title": "Wildebeest Crossing", "shots": []}]}]}
    tp = vlog.trip()
    chapters = [{"title": "Lamai Gate", "sub": "Day 4 of 10 · Wed 16 Sep", "atSec": 20.0, "day": "2015-09-16", "dayNo": 4, "place": None},
                {"title": "Wildebeest Crossing", "sub": "Day 5 of 10 · Thu 17 Sep", "atSec": 300.0, "day": "2015-09-17", "dayNo": 5, "place": None}]
    props = vlog.series_props(plan["videos"][1], plan, tp, chapters, True, {"atSec": 12.0, "sec": 7.6}, 580.0)
    assert props["series"]["kicker"] == "Part 2 of 2 · Days 4–5 · 16–17 Sep 2015" and props["series"]["episode"] == "The River Crossing and a Birthday"
    assert props["next"] == {"atSec": 580.0, "n": 1, "of": 2, "first": True, "leg": ["2015-09-13", "2015-09-14"], "title": "A Leopard in a Tree"}
    assert props["recap"]["leg"] == ["2015-09-13", "2015-09-14"] and props["leg"] == ["2015-09-16", "2015-09-17"]
    assert props["chapters"][0]["place"] == "Serengeti National Park" and props["titleSec"] == vlog.SERIES_TITLE
    story = {"titles": {1: "A Leopard in a Tree", 2: "The River Crossing and a Birthday"}, "route": tp["route"], "cold": "Wildebeest Crossing", "endAt": 580.0}
    yt = vlog.youtube_text(plan["videos"][1], chapters, 600.0, "Highlands & Coast", story)
    marks = yt["chapters"]
    assert yt["chaptersValid"] and marks[0] == {"at": 0.0, "title": "Wildebeest Crossing, then the story so far"}, "0:00 says what it shows"
    assert marks[-1] == {"at": 580.0, "title": "Watch the series from Part 1"}
    assert "Day 4 · Serengeti National Park, Tanzania: Lamai Gate" in yt["description"]
    assert "Day 4 · Wed 16 Sep 2015 · Serengeti National Park, Tanzania" in yt["description"], "where and when"
    assert "{" not in yt["description"] and "Previous" not in yt["description"], "no link line before the links exist"
    assert "◀ Previous: Part 1 – A Leopard in a Tree  {prev}" in yt["template"] and "▶ Next" not in yt["template"], "the last part has no next"
    filled = vlog.fill_links(yt["template"], {"prev": "https://youtu.be/AAA", "playlist": "https://www.youtube.com/playlist?list=PL1"})
    assert "◀ Previous: Part 1 – A Leopard in a Tree  https://youtu.be/AAA" in filled and "list=PL1" in filled and "{" not in filled
    assert "Map data: Natural Earth." in yt["description"] and yt["description"].startswith("Over the border to the river.")


def test_building_an_episode_lays_out_its_film_and_text(trip_notes, monkeypatch):
    """build() with the rendering, mixing and checks faked: the order of the film (cold open, previously, chapters,
    the next part's teaser), which shots carry their own sound, where the title and the end card sit, the place tags
    and the YouTube text."""
    from studio import sound, verify

    root = trip_notes / "root"
    (root / "public").mkdir(parents=True)
    monkeypatch.setattr(vlog, "ROOT", root)
    monkeypatch.setattr(vlog, "OUT", trip_notes / "renders")
    monkeypatch.setattr(vlog, "WINDOWS_FILE", trip_notes / "windows.json")
    monkeypatch.setattr(vlog, "background_priority", lambda: None)
    monkeypatch.setattr(vlog, "_targets", lambda seq: None)
    monkeypatch.setattr(vlog, "_render_one", lambda job: {"k": job[0], "start": 1.0, "volume": 1.0, "out": job[2], "bridge": None, "avoid": job[5]})
    monkeypatch.setattr(vlog, "_subtitles", lambda *a, **k: {"cues": 0})
    monkeypatch.setattr(vlog, "_remotion", lambda props, out, log: None)
    monkeypatch.setattr(vlog, "thumbnail", lambda n: None)
    monkeypatch.setattr(sound, "mix", lambda *a, **k: {})
    monkeypatch.setattr(verify, "qa", lambda *a, **k: {"ok": True, "checks": []})
    p = vlog.series(target=5.0, name="Highlands & Coast", dry=False, _rows=_rows())
    two = p["videos"][1]
    out = vlog.build(2, music=False)
    props = json.loads((trip_notes / "renders" / "vlog-2" / "props.json").read_text(encoding="utf-8"))
    n_cold, n_recap, n_teaser = len(two["cold"]), len(two["recap"]), len(two["teaser"])
    shots = props["shots"]
    body = shots[n_cold + n_recap: len(shots) - n_teaser]
    assert all(s["volume"] == 0 for s in shots[: n_cold + n_recap] + shots[len(shots) - n_teaser:]), "cold open, recap and teaser are silent"
    assert all(s["volume"] == 1.0 for s, b in zip(body, [x for c in two["chapters"] for x in c["shots"]]) if b["kind"] == "video"), "the chapters keep their sound"
    fs = vlog.fade_sec("documentary")
    starts, t = [], 0.0
    for k, s in enumerate(shots):
        starts.append(max(0.0, t - fs) if k else 0.0)
        t = starts[-1] + s["durationSec"]
    assert props["titleAtSec"] == round(starts[n_cold + n_recap], 2), "the title card over the first chapter, after previously"
    assert props["recap"]["atSec"] == round(starts[n_cold], 2) and props["recap"]["leg"] == p["videos"][0]["days"]
    assert props["next"]["atSec"] == round(starts[len(shots) - n_teaser], 2) and props["next"]["n"] == 3
    assert round(out["seconds"] - props["next"]["atSec"], 1) >= vlog.SERIES_END - 0.2, "the end card has its 20 seconds"
    assert props["series"]["kicker"].startswith(f"Part 2 of {len(p['videos'])} · ") and props["leg"] == two["days"]
    assert props["chapters"][0]["sub"].startswith(f"Day {two['chapters'][0]['dayNo']} of {p['dayOf']} · ")
    assert all(o["atSec"] + o["sec"] <= props["next"]["atSec"] for o in props["overlays"]), "no words under the end card"
    assert out["target"] == 5.0 and "lengthOk" in out and out["series"] == {"n": 2, "of": len(p["videos"])}
    yt = out["youtube"]
    assert yt["chaptersValid"] and yt["chapters"][0]["title"].endswith("then the story so far") and "{prev}" in yt["template"]
    assert "Watch" not in yt["chapters"][-1]["title"] and yt["chapters"][-1]["title"] == "Next: Part 3"


def test_the_noted_moment_gets_its_own_chapter_from_the_days_pictures_of_people(trip_notes):
    """13 Nov: an episode named after a noted moment did not show it: its pictures were evening stills of people
    and clips came first and filled the day. Now a day the person noted ends on its moment, in their words."""
    rows = _rows()
    names = [n for n, _ in vlog.CONCEPTS]
    rng = np.random.default_rng(7)
    for k in range(12):  # the evening of the noted day: twelve photos of people, within half an hour
        e = rng.normal(scale=0.15, size=len(names)).astype("float32")
        e[names.index("Us")] += 1.0
        rows.append(({"path": f"2015-09-17-us-{k}.jpg", "kind": "photo", "aesthetic": 6.5, "sharp": 40, "junk": 0,
                      "captured": f"2015-09-17T14:{10 + k * 2:02d}:00+00:00"}, e))
    p = vlog.series(target=5.0, name="Highlands & Coast", dry=True, _rows=rows)
    ep = next(v for v in p["videos"] if "2015-09-17" in v["days"])
    moment = [c for c in ep["chapters"] if c.get("moment")]
    assert len(moment) == 1 and moment[0]["title"] == "A Birthday by the River", [c["title"] for c in ep["chapters"]]
    assert moment[0]["day"] == "2015-09-17" and len(moment[0]["shots"]) >= 3
    assert all("-us-" in s["path"] for s in moment[0]["shots"]), "the pictures of people from that evening"
    assert not any(c.get("moment") for v in p["videos"] for c in v["chapters"] if c["day"] != "2015-09-17"), "only the noted day"
    assert abs(vlog._mix(ep)["minutes"] - 5.0) <= vlog.SERIES_BAND, "still the episode's length"
    assert vlog._moment_title("birthday picnic at the river") == "Birthday Picnic at the River"


def test_a_first_chapter_inside_the_first_ten_seconds_names_the_opening_mark():
    """13 Nov: Part 1's Day 1 chapter started 4 s in; YouTube needs 10 s between marks, so it vanished and the cold open's
    name covered the lions. The opening mark now carries the first chapter's name."""
    video = {"n": 1, "title": "t", "span": "13-14 Sep", "series": {"n": 1, "of": 4}}
    chapters = [{"day": "2015-09-13", "dayNo": 1, "atSec": 4.0, "title": "Lions on Open Plains"},
                {"day": "2015-09-14", "dayNo": 2, "atSec": 178.0, "title": "Hot Air Balloon and Leopard"}]
    route = {"2015-09-13": {"place": "Masai Mara National Reserve", "country": "Kenya"}}
    out = vlog._series_text(video, chapters, 606.0, "Highlands & Coast", {"route": route, "cold": "Balloon", "endAt": 589.0, "titles": {2: "x"}})
    assert out["chapters"][0] == {"at": 0.0, "title": "Day 1 · Masai Mara National Reserve, Kenya: Lions on Open Plains"}
    assert [m["at"] for m in out["chapters"]] == [0.0, 178.0, 589.0] and out["chaptersValid"]
