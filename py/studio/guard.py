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
LATIN = re.compile(r"[a-z0-9 '\-]+")


def hit(phrase: str, lower: str) -> bool:
    """Is a banned phrase in the (lower-cased) text? A phrase in Latin letters counts only as whole words ("cow" is not in
    "coworking": the kotatsu coworking lounge, 27 Nov 2026); any other script (Japanese has no spaces) anywhere in the text.
    Same rule as shared/guard.mjs bannedHit."""
    p = phrase.lower().strip()
    if not p:
        return False
    if LATIN.fullmatch(p):
        return re.search(rf"(?<![a-z0-9]){re.escape(p)}(?![a-z0-9])", lower) is not None
    return p in lower


def problems(text: str) -> list[str]:
    from studio.brand import copy_rules

    rules = copy_rules()
    found: list[str] = []
    lower = text.lower()
    for phrase in rules["banned"]:
        if hit(phrase, lower):
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
