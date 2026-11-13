"""
FILE: py/studio/guard.py
PURPOSE: The fact guard every line of reel and post copy passes.
OVERVIEW: The rules are the project's (studio.brand.copy_rules): in the Tsumagoi workspace, shared/spec.json's
          banned phrases and prices, the same list shared/guard.mjs reads; in a project made in the studio, only
          the phrases and price rule its brand.json sets.
DEPENDENCIES: studio.config, studio.brand
USAGE: assert_copy(text)
NOTES: In the ranch workspace 牧場 is allowed only inside the registered name 嬬恋牧場Work&Camp.
"""
from __future__ import annotations

import re

from studio.config import SPEC

REGISTERED = "嬬恋牧場Work&Camp"
PRICE = re.compile(SPEC["pricePattern"])


def problems(text: str) -> list[str]:
    from studio.brand import copy_rules

    rules = copy_rules()
    found: list[str] = []
    lower = text.lower()
    for phrase in rules["banned"]:
        if phrase.lower() in lower:
            found.append(f"banned:{phrase}")
    if rules["noPrices"] and PRICE.search(text):
        found.append("price")
    if rules["registered"] == REGISTERED and "牧場" in text.replace(REGISTERED, ""):
        found.append("bare-bokujo")
    return found


def assert_copy(text: str) -> str:
    found = problems(text)
    if found:
        raise ValueError(f"fact guard: {', '.join(found)}")
    return text
