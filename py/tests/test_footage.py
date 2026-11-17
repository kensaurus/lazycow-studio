"""Footage health: cameras named from the file's own data, in the names people use."""
from studio import footage


def test_camera_names_use_the_market_name_and_drop_a_repeated_maker():
    assert footage._clean("Xiaomi", "2407FPN8EG") == "Xiaomi 14T Pro"  # the phone's video code = its photos' name
    assert footage._clean("DJI", "FC3411") == "DJI Air 2S"
    assert footage._clean("Arashi Vision", "Insta360 OneRS") == "Insta360 ONE RS"
    assert footage._clean("Canon", "Canon EOS R8") == "Canon EOS R8"
    assert footage._clean("", "") is None and footage._clean(None, None) is None


def test_the_family_follows_the_maker():
    assert footage.family_of("Xiaomi 14T Pro") == "phone"
    assert footage.family_of("DJI Air 2S") == "dji"
    assert footage.family_of("Insta360 ONE RS") == "insta360"
    assert footage.family_of("Canon EOS R8") == "canon"
    assert footage.family_of("") is None and footage.family_of(None) is None


def test_places_cluster_on_a_100_m_grid_and_never_give_a_file_its_own_position():
    home = {"lat": 36.5893, "lon": 138.5096, "radiusKm": 2}
    rows = [
        {"id": 1, "lat": 36.58934, "lon": 138.50962, "kind": "photo", "used": True},
        {"id": 2, "lat": 36.58941, "lon": 138.50958, "kind": "video", "used": False},  # same ~100 m square as 1
        {"id": 3, "lat": 35.4351, "lon": 140.3982, "kind": "photo", "used": False},    # far away
        {"id": 4, "lat": 0.0, "lon": 0.0, "kind": "photo", "used": False},             # a phone's placeholder fix
        {"id": 5, "lat": None, "lon": None, "kind": "video", "used": False},
    ]
    p = footage.cluster_places(rows, home)
    first, far = p["clusters"]
    assert (first["lat"], first["lon"], first["clips"], first["videos"], first["unused"]) == (36.589, 138.51, 2, 1, 1)
    assert first["home"] and sorted(first["ids"]) == [1, 2]
    assert not far["home"] and far["km"] > 200 and (far["lat"], far["lon"]) == (35.435, 140.398)
    assert p["placed"] == 3 and p["unplaced"] == 2 and p["home"] == home
    assert footage.cluster_places(rows, None)["clusters"][0]["home"] is False
