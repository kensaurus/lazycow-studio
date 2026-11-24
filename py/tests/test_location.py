"""Location rule: 0,0 is unknown, the ranch is near, 11 km away is not. The ranch's point is in its overlay
(shared/ranch/brand.json), so those two run only in the ranch workspace; test_brand.py checks any project's place."""
import pytest

from studio.media import near_ranch


def test_placeholder_is_unknown():
    assert near_ranch(0.0, 0.0) is None
    assert near_ranch(None, 138.5) is None


@pytest.mark.ranch
def test_ranch_is_near():
    assert near_ranch(36.5893, 138.5096) == 1


@pytest.mark.ranch
def test_eleven_km_is_not_the_ranch():
    assert near_ranch(36.66, 138.42) == 0
