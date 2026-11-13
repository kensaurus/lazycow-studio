"""V2 layers: the render gate keeps them inside the reel, off the opening, apart from each other and from the reel's
own clips; the beat fit varies the rhythm per reel but stays on the grid and on the beat."""
import random

from studio.layers import check
from studio.sound import fit_cuts


def _reel(layers):
    shots = [{"src": f"2026/a/clip{i}.MP4", "sec": 2.0} for i in range(7)]
    return {"shots": shots, "layers": layers, "beats": []}


def test_good_layers_pass():
    ok = [{"kind": "cutaway", "src": "2026/b/detail.MP4", "at": 2.5, "sec": 1.0},
          {"kind": "inset", "src": "2026/b/print.MP4", "at": 6.5, "sec": 2.0, "rect": {"x": 0.06, "y": 0.13, "w": 0.46, "h": 0.3}}]
    assert check(_reel(ok)) == []
    assert check(_reel([])) == []


def test_bad_layers_are_refused():
    assert any("already in the reel" in p for p in check(_reel([{"kind": "cutaway", "src": "2026/x/clip3.MP4", "at": 2.5, "sec": 1.0}])))
    assert any("opening" in p for p in check(_reel([{"kind": "cutaway", "src": "2026/b/d.MP4", "at": 0.0, "sec": 1.0}])))
    assert any("outside" in p for p in check(_reel([{"kind": "cutaway", "src": "2026/b/d.MP4", "at": 13.5, "sec": 1.0}])))
    assert any("overlap" in p for p in check(_reel([{"kind": "cutaway", "src": "2026/b/d.MP4", "at": 2.5, "sec": 1.5},
                                                    {"kind": "inset", "src": "2026/b/e.MP4", "at": 3.5, "sec": 1.5}])))
    assert any("0.5-3" in p for p in check(_reel([{"kind": "inset", "src": "2026/b/d.MP4", "at": 2.5, "sec": 4.0}])))
    assert any("kind" in p for p in check(_reel([{"kind": "spin", "src": "2026/b/d.MP4", "at": 2.5, "sec": 1.0}])))


def test_the_beat_fit_varies_per_reel_but_stays_on_the_beat():
    beats = [k * 0.5 for k in range(1, 60)]  # 120 BPM: every grid point is a beat
    plain = fit_cuts(beats, 9)
    assert plain == fit_cuts(beats, 9)  # without a random source it is the same every time (old behaviour)
    seen = set()
    for seed in range(20):
        lengths = fit_cuts(beats, 9, rng=random.Random(seed))
        assert lengths and all(abs(x / 0.5 - round(x / 0.5)) < 1e-6 and 1.0 <= x <= 3.0 for x in lengths)
        assert 8 <= sum(lengths) <= 25 and max(lengths) >= 2.5  # one held shot
        seen.add(tuple(lengths))
    assert len(seen) >= 8
