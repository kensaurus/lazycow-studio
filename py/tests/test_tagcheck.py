"""Footage tags checked against the picture, and the corrections kept through a re-tag (studio.tagcheck)."""
import json

from studio import tagcheck


def test_a_no_drops_a_tag_and_a_clear_yes_adds_one_the_rules_need():
    # 15 Nov: a camp chair the library called "car"; a table of bowls called "grill"
    j = tagcheck.judge(["car", "working", "tent"], {"car": False, "tent": True, "desk": False})
    assert j == {"drop": ["car"], "add": []}
    j = tagcheck.judge(["grill"], {"grill": False, "food": True, "interior": True})
    assert j == {"drop": ["grill"], "add": ["food", "interior"]}
    assert tagcheck.judge(["working"], {})["drop"] == []  # a tag the check does not cover stays


def test_corrections_apply_wherever_tags_are_written(tmp_path, monkeypatch):
    monkeypatch.setattr(tagcheck, "FIXES", tmp_path / "tag-fixes.json")
    tagcheck.FIXES.write_text(json.dumps({"7": {"drop": ["car"], "add": ["desk"]}}), encoding="utf-8")
    assert tagcheck.apply(7, ["car", "working"]) == ["working", "desk"]
    assert tagcheck.apply(8, ["car"]) == ["car"]  # a clip nobody checked keeps its tags
