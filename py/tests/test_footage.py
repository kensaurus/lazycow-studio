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
