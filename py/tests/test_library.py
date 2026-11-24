"""Studio outputs never come back as footage; events come from dated folders; place reads GPS before names."""
from pathlib import Path

from studio.config import SOURCE
from studio.ingest import is_output
from studio.library import event_dir, event_of, place_from

# A neutral project's home place (the example business, Cafe Kumo), passed to place_from so the rules, not one
# project's own names and away list, are what is tested.
HOME = {"lat": 0.0, "lon": 0.0, "radiusKm": 2, "awayEvents": ["20250621_Forest-Office", "20250807_cafe-kumo-summer-fair"],
        "names": ["kumo", "雲"]}


def test_outputs_are_not_footage():
    assert is_output(SOURCE / "cafe-kumo-edits" / "drafts" / "20261107" / "view" / "x" / "a.mp4")
    assert is_output(SOURCE / "ready" / "20261021_DJI_0814_autumn_lunch_tour_reel_9x16_v2.mp4")
    assert not is_output(SOURCE / "2026" / "202610- cafe-kumo-phone" / "VID_1.mp4")


def test_a_finished_edit_beside_footage_is_not_footage():
    assert is_output(SOURCE / "2026" / "202610- cafe-kumo-phone" / "DJI_0845_kite_reel_9x16_v3.mp4")
    assert not is_output(SOURCE / "2026" / "202610- cafe-kumo-phone" / "DJI_0845.MP4")


def test_event_from_folder():
    name, date = event_of(SOURCE / "2026" / "20260719_cafe-kumo-preopening_guest-crew" / "VID_1.mp4")
    assert name.startswith("20260719")
    assert date == "2026-07-19"
    assert event_of(Path(r"C:\elsewhere\x.jpg"))[1] is None


def test_the_media_root_name_does_not_make_footage_local():
    # The media root is often named after the place (20_cafe-kumo); only the event folder's own name counts.
    canon = SOURCE / "2025" / "20250621_Forest-Office" / "canon" / "IMG_8156.JPG"
    assert Path(event_dir(canon)).name == "20250621_forest-office"
    # A neutral event name, so the GPS rules (not the owner list) are what is tested.
    assert place_from(None, (0, 0), (0, 0), "20250621_some-other-trip", home=HOME) == "unknown"
    assert place_from(None, (0, 0), (0, 0), Path(event_dir(canon)).name, home=HOME) == "away (owner)"


def test_a_sibling_folder_with_far_gps_marks_the_event_away():
    # canon/ has no GPS; the same trip's dji/ folder has 23 fixes away from the home place.
    assert place_from(None, (0, 0), (0, 23), "20250621_some-other-trip", home=HOME) == "away (event)"
    assert place_from(None, (0, 0), (0, 0), "202610- cafe-kumo-phone", home=HOME) == "ranch (folder name)"
    assert place_from(None, (0, 0), (0, 3), "20260101_kumo-trip", home=HOME) == "away (event)"
    assert place_from(1, (0, 9), (0, 9), "x", home=HOME) == "ranch"


def test_an_event_the_owner_called_off_site_outranks_a_stray_gps_fix():
    # A summer-fair still carries a fix inside 2 km; the owner says the event was not at the cafe.
    assert place_from(1, (1, 0), (1, 282), "20250807_cafe-kumo-summer-fair", home=HOME) == "away (owner)"
    assert place_from(1, (1, 0), (1, 0), "20260719_cafe-kumo-preopening_guest-crew", home=HOME) == "ranch"


def test_footage_from_the_trip_there_is_not_the_ranch():
    # A pre-opening event folder holds a train window and a roadside station from 07-17.
    event = "20260719_cafe-kumo-preopening_guest-crew"
    assert place_from(None, (5, 0), (5, 0), event, captured="2026-07-17T11:18:56", event_date="2026-07-19", home=HOME) == "unknown (before the event)"
    assert place_from(None, (5, 0), (5, 0), event, captured="2026-07-18T20:00:00", event_date="2026-07-19", home=HOME) == "ranch (folder)"
    assert place_from(1, (0, 0), (0, 0), event, captured="2026-07-17T11:18:56", event_date="2026-07-19", home=HOME) == "ranch"
