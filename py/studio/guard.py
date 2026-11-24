"""
FILE: py/studio/guard.py
PURPOSE: The fact guard every line of reel and post copy passes.
OVERVIEW: The rules are the project's (studio.brand.copy_rules): in the ranch workspace, its overlay's banned
          phrases (shared/ranch/brand.json, the same list shared/guard.mjs reads) and no prices; in a project made in
          the studio, only the phrases and price rule its brand.json sets.
DEPENDENCIES: studio.config, studio.brand
USAGE: assert_copy(text)
NOTES: A brand with a registered name and a bare word (the ranch's overlay) allows that word only inside the name.
"""
from __future__ import annotations

import re

from studio.config import SPEC

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
    reg, bare = rules.get("registered"), rules.get("bare")
    if reg and bare and bare in text.replace(reg, ""):
        found.append("bare-bokujo")
    return found


def assert_copy(text: str) -> str:
    found = problems(text)
    if found:
        raise ValueError(f"fact guard: {', '.join(found)}")
    return text
