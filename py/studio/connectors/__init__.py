"""
FILE: py/studio/connectors/__init__.py
PURPOSE: The networks the studio can post to by itself, one module each, behind one interface.
OVERVIEW: Every module has NAME, HOW, FIELDS, can_schedule, status(), connect(fields),
          disconnect() and post(video, text, at). Credentials are stored encrypted in
          <data>/secrets/<network>.bin with the same helpers as YouTube. A module with LISTED_ONLY_CONNECTED = True (Instagram
          reels, which ride on the Facebook connection) is listed by studio.publish.connections() only while it is
          connected: until then that network stays the way it was (posted by hand).
USAGE: from studio.connectors import REGISTRY, get; get("bluesky").status()
"""
from __future__ import annotations

from types import ModuleType

from studio.connectors import bluesky, facebook, instagram_reel, instagram_story

# "instagram" is the Instagram Reels channel (shared/channels.json); Stories are their own network.
REGISTRY: dict[str, ModuleType] = {"bluesky": bluesky, "facebook": facebook, "instagram-story": instagram_story, "instagram": instagram_reel}


def get(net: str) -> ModuleType:
    try:
        return REGISTRY[net]
    except KeyError:
        raise ValueError(f"the studio cannot post to {net!r} by itself; known: {', '.join(REGISTRY)}") from None
