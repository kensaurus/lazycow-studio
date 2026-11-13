"""
FILE: py/studio/connectors/__init__.py
PURPOSE: The networks the studio can post to by itself, one module each, behind one interface.
OVERVIEW: Every module has NAME, HOW, FIELDS, can_schedule, status(), connect(fields),
          disconnect() and post(video, text, at). Credentials are stored encrypted in
          <data>/secrets/<network>.bin with the same helpers as YouTube.
USAGE: from studio.connectors import REGISTRY, get; get("bluesky").status()
"""
from __future__ import annotations

from types import ModuleType

from studio.connectors import bluesky, facebook

REGISTRY: dict[str, ModuleType] = {"bluesky": bluesky, "facebook": facebook}


def get(net: str) -> ModuleType:
    try:
        return REGISTRY[net]
    except KeyError:
        raise ValueError(f"the studio cannot post to {net!r} by itself; known: {', '.join(REGISTRY)}") from None
