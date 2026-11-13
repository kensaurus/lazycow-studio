"""Fact guard: banned ranch inventions and prices do not pass."""
from studio.guard import assert_copy, problems


def test_clean_line():
    assert assert_copy("デッキに、夕方。") == "デッキに、夕方。"


def test_registered_name_ok():
    assert problems("嬬恋牧場Work&Camp") == []


def test_bare_bokujo():
    assert "bare-bokujo" in problems("牧場の入口")


def test_milky_way_and_price():
    assert "banned:天の川" in problems("夜の天の川")
    assert "banned:milky way" in problems("the Milky Way")
    assert "price" in problems("大人 ¥2600")
    assert "banned:キャンプ場" in problems("キャンプ場です")
    assert "banned:直火" in problems("直火は禁止ではなく")
