"""Scores and predictions (studio.predict): the score's parts and its partial flag, a prediction that follows what
the model learned, wide ranges with no data, 80 % ranges that hold about 80 % of new posts, the rank correlation,
and freeze/report: one frozen prediction per booking, late ones never counted, actual results set beside them."""
import math

import numpy as np
import pytest

from studio import learn, predict

LOOKS = ("punch", "film", "split", "whip")


def synthetic(n, lift=2.0, seed=7, nets=("tiktok", "youtube")):
    rng = np.random.default_rng(seed)
    units = []
    for i in range(n):
        look = LOOKS[i % 4]
        net = nets[(i // 4) % len(nets)]
        y = (math.log(lift) if look == "punch" else 0.0) + rng.normal(0, 0.3)
        feats = {"theme": "autumn", "style": "column", "look": look, "recipe": "none", "loop": "loop", "length": "12-16 s", "clips": "7-9",
                 "music": "auto", "sfx": "effects", "hook": f"h{i}", "cut": "short", "weekday": "Monday", "hour": "18-20"}
        units.append({"post_id": i, "slug": f"s{i}", "network": net, "metric": "views", "value": math.exp(y) * 100, "y": y, "features": feats})
    return {"units": units, "byPost": {}, "networks": {n_: {"metric": "views", "median": 100.0} for n_ in nets}, "tooNew": 0}


def features_as(look):
    def fake(project, post):
        return {"theme": "autumn", "style": "column", "look": look, "recipe": "none", "loop": "loop", "length": "12-16 s", "clips": "7-9",
                "music": "auto", "sfx": "effects", "hook": "new", "cut": "short", "weekday": "Monday", "hour": "18-20", "seconds": 14.0}
    return fake


def test_score_parts_partial_and_full():
    part = predict.score({"slug": "a", "sameHook": 0}, 20.0, review={})
    assert part["partial"] and set(part["missing"]) == {"hook", "look"} and part["score"] == 100  # fresh + fitting length, of what is known
    full = predict.score({"slug": "a", "sameHook": 3}, 70.0, review={"hook": {"score": 8, "notes": "x"}, "look": {"score": 6}})
    # hook 35*0.8 + look 25*0.6 + fresh 0 + length 0 = 43 of 100
    assert not full["partial"] and full["score"] == 43 and full["parts"]["fresh"]["points"] == 0
    assert predict.score({"slug": "a", "sameHook": 0})["parts"].keys() == {"fresh"}


def test_prediction_follows_the_model_and_is_wide_without_data(monkeypatch):
    data = synthetic(40, lift=2.0)
    model = learn.fit(data["units"])
    monkeypatch.setattr(learn, "reel_features", features_as("punch"))
    hi = predict.predict({}, "tiktok", model=model)
    monkeypatch.setattr(learn, "reel_features", features_as("film"))
    lo = predict.predict({}, "tiktok", model=model)
    assert hi["mid"] > 1.4 * lo["mid"] and hi["lo"] < hi["mid"] < hi["hi"] and hi["posts"] == 20
    none = predict.predict({}, "tiktok", model=None, data={"units": []})
    assert none["mid"] == 1.0 and none["lo"] < 0.35 and none["hi"] > 3 and none["posts"] == 0
    # a choice never posted widens the range (its effect is the prior)
    monkeypatch.setattr(learn, "reel_features", features_as("never-used"))
    new = predict.predict({}, "tiktok", model=model)
    assert new["hi"] / new["lo"] > lo["hi"] / lo["lo"]


def test_eighty_percent_ranges_hold_about_eighty_percent_of_new_posts(monkeypatch):
    model = learn.fit(synthetic(60, lift=2.0, seed=3)["units"])
    rng = np.random.default_rng(11)
    inside = total = 0
    for look in LOOKS:
        monkeypatch.setattr(learn, "reel_features", features_as(look))
        pr = predict.predict({}, "tiktok", model=model)
        for _ in range(150):
            y = (math.log(2.0) if look == "punch" else 0.0) + rng.normal(0, 0.3)
            inside += pr["lo"] <= math.exp(y) <= pr["hi"]
            total += 1
    assert 0.7 <= inside / total <= 0.99  # calibrated or a little wide (the prior noise guess is larger than 0.3), never narrow


def test_spearman():
    assert predict._spearman([1, 2, 3, 4], [1, 2, 3, 4]) is None  # fewer than 5: no claim
    assert predict._spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]) == 1.0
    assert predict._spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) == -1.0


def test_freeze_once_per_booking_and_report_counts_only_timely_predictions(monkeypatch):
    from studio import perf, projects
    from studio.db import connect

    with connect() as con:
        con.executescript(predict.SCHEMA)
        con.execute("DELETE FROM predictions")
    bookings = [{"id": 901, "slug": "a", "network": "tiktok", "status": "posted", "at": "2026-11-01T19:00+09:00"},
                {"id": 902, "slug": "b", "network": "tiktok", "status": "posted", "at": "2026-11-02T19:00+09:00"},
                {"id": 903, "slug": "c", "network": "youtube", "status": "scheduled", "at": "2026-12-01T19:00+09:00"}]
    monkeypatch.setattr(predict, "_bookings", lambda: bookings)
    monkeypatch.setattr(projects, "load", lambda slug: {"slug": slug})
    monkeypatch.setattr(learn, "reel_features", features_as("film"))
    monkeypatch.setattr(perf, "readings", lambda *a, **k: [{"post_id": 902}])  # 902 already had numbers
    monkeypatch.setattr(learn, "comparable", lambda *a, **k: {"units": [], "byPost": {}, "networks": {}, "tooNew": 0})
    assert predict.freeze() == {"made": 3, "late": 1}
    assert predict.freeze() == {"made": 0, "late": 0}  # frozen: never made again
    # numbers arrive: 901 lands inside its (wide) range, 902 is late and not counted
    f = features_as("film")(None, None)
    units = [{"post_id": 901, "network": "tiktok", "y": 0.1, "features": f}, {"post_id": 902, "network": "tiktok", "y": 0.0, "features": f}]
    monkeypatch.setattr(learn, "comparable", lambda *a, **k: {"units": units, "byPost": {}, "networks": {}, "tooNew": 0})
    rep = predict.report([{"slug": "a", "sameHook": 0}])
    by = {r["post"]: r for r in rep["rows"]}
    assert rep["measured"] == 1 and rep["inside"] == 1 and rep["coverage"] == 1.0
    assert by[901]["inside"] is True and by[902]["late"] and by[902]["inside"] is None and by[903]["actual"] is None
    assert "1 of 1 measured posts" in rep["summary"]
