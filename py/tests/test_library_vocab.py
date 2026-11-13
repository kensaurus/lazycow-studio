"""Each project tags its footage with fitting words: the ranch's own list, or a general one (studio.library)."""
import studio.library as lib


def test_other_projects_get_general_words():
    for ranch_only in ("pizza", "dog", "deck", "tent", "grill", "working", "parking", "shop", "desk", "sign"):
        assert ranch_only not in lib.ANY_VOCAB, ranch_only
    for word in ("animal", "bird", "water", "city", "people", "night", "sunset"):
        assert word in lib.ANY_VOCAB, word
    assert all(len(v) == 3 and v[1] for v in lib.ANY_VOCAB.values()), "every word has a prompt, a Japanese label and a group"


def test_the_list_in_use_follows_the_project():
    assert lib.VOCAB is (lib.RANCH_VOCAB if lib.RANCH else lib.ANY_VOCAB)


def test_an_original_replaces_its_google_photos_copy():
    rows = [{"path": "C:/p/imports/google-photos/20261111/MVI_0125.MP4", "kind": "video"},
            {"path": "D:/footage/trip/MVI_0125.MP4", "kind": "video"},
            {"path": "C:/p/imports/google-photos/20261111/IMG_20260913_064411.jpg", "kind": "photo"}]
    kept = [r["path"] for r in lib.prefer_originals(rows)]
    assert kept == [rows[1]["path"], rows[2]["path"]], "the camera file wins; a phone photo with no original stays"
