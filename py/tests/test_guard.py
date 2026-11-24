"""Fact guard: a project's banned inventions, prices and a bare word outside its registered name do not pass."""
import pytest

from studio import brand
from studio.guard import assert_copy, problems


@pytest.fixture
def kumo_rules(monkeypatch):
    """The example business's own copy rules (Cafe Kumo), so the guard's logic is tested without any one project's words."""
    monkeypatch.setattr(brand, "copy_rules", lambda: {"banned": ["milky way", "天の川", "食べ放題"], "noPrices": True,
                                                      "registered": "Cafe Kumo Kitchen", "bare": "Kitchen"})


def test_clean_line():
    assert assert_copy("デッキに、夕方。") == "デッキに、夕方。"


def test_registered_name_ok(kumo_rules):
    assert problems("Cafe Kumo Kitchen") == []


def test_bare_word_outside_the_registered_name(kumo_rules):
    assert "bare-bokujo" in problems("Kitchen open")
    assert "bare-bokujo" not in problems("Cafe Kumo Kitchen open")


def test_milky_way_and_price(kumo_rules):
    assert "banned:天の川" in problems("夜の天の川")
    assert "banned:milky way" in problems("the Milky Way")
    assert "price" in problems("ランチ ¥1200")
    assert "banned:食べ放題" in problems("食べ放題です")
