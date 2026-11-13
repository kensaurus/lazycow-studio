"""9:16 window stays inside the source frame."""
from studio.grade import crop_window


def test_landscape_centers():
    w, h, x, y = crop_window(3840, 2160, 0.5)
    assert y == 0
    assert w % 2 == 0 and h % 2 == 0
    assert abs(w / h - 9 / 16) < 0.01
    assert 0 <= x <= 3840 - w


def test_subject_pulls_left():
    left = crop_window(3840, 2160, 0.1)[2]
    right = crop_window(3840, 2160, 0.9)[2]
    assert left < right


def test_portrait_keeps_width():
    w, h, x, y = crop_window(1080, 1920, 0.5)
    assert (w, h, x, y) == (1080, 1920, 0, 0)


def test_a_wide_frame_follows_the_subject_sideways():
    from studio.shot import Measure, crop_for

    wide = Measure(3840, 2160, (0, 0, 0), (1, 1, 1), 0.4, 0.5)
    left = crop_for(wide, 1080, 1920, 0.2)[2]
    right = crop_for(wide, 1080, 1920, 0.8)[2]
    assert left < right
    assert crop_for(wide, 1080, 1920, 0.2)[3] == 0


def test_a_tall_frame_follows_the_subject_down():
    from studio.shot import Measure, crop_for

    tall = Measure(1080, 2400, (0, 0, 0), (1, 1, 1), 0.4, 0.5, cy=0.82)
    mid = Measure(1080, 2400, (0, 0, 0), (1, 1, 1), 0.4, 0.5, cy=0.5)
    assert crop_for(tall, 1080, 1920, 0.5)[3] > crop_for(mid, 1080, 1920, 0.5)[3]
