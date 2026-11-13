"""Point the catalog at a throwaway folder before studio.config is imported.

The tests' main project is the built-in reference workspace (Tsumagoi Work&Camp: its themes, place and copy rules are in
the code and shared/spec.json), so STUDIO_RANCH defaults to 1 here. Neutral projects are tested with the `neutral`
fixture (test_brand.py) and a neutral process (test_a_neutral_process_...)."""
import os
import tempfile

os.environ["STUDIO_DATA"] = tempfile.mkdtemp(prefix="tsumagoi-studio-test-")
os.environ["STUDIO_AESTHETIC_FETCH"] = "0"  # no download of the aesthetic head during tests
os.environ.setdefault("STUDIO_RANCH", "1")


def pytest_collection_modifyitems(config, items):
    """A test marked `ranch` reads the owner's own Tsumagoi files (the ranch overlay: shared/reels.json, words,
    house reels). A public clone has none, so it is skipped there with the reason; in the owner's checkout every one runs."""
    import pytest
    from studio.config import RANCH_MARKER

    if RANCH_MARKER.is_file():
        return
    skip = pytest.mark.skip(reason="needs the ranch overlay files (shared/reels.json); not in a public clone")
    for item in items:
        if item.get_closest_marker("ranch"):
            item.add_marker(skip)
