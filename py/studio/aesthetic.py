"""
FILE: py/studio/aesthetic.py
PURPOSE: How good a frame looks, 1-10, from the CLIP embedding the library already stores.
OVERVIEW: The LAION aesthetic predictor (v1, MIT): one linear layer on an L2-normalised
          OpenAI CLIP ViT-B/32 image embedding, trained on human ratings of photos (SAC,
          LAION-Logos, AVA). The library uses the same CLIP weights, so scoring a clip is one
          dot product: no new model run, no network call once the 3 KB head is on disk.
DEPENDENCIES: numpy, torch (to read the .pth once), <data>/bin/sa_0_4_vit_b_32_linear.pth
              from github.com/LAION-AI/aesthetic-predictor
USAGE: score(emb) -> float | None. studio.library puts it on each item as "aesthetic";
       studio.assemble nudges the pick by at most +-0.02 (the size of the "recent" nudge).
NOTES: A nudge, never a gate: the predictor was trained on photos people liked online, so it
       favours tidy, saturated pictures and can undervalue a raw ranch moment. Missing head:
       score() returns None and nothing changes.
"""
from __future__ import annotations

import os

import numpy as np

from studio.config import DATA

HEAD = DATA / "bin" / "sa_0_4_vit_b_32_linear.pth"
URL = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_b_32_linear.pth"
WEIGHT = 0.01  # rank nudge per point away from 5, capped at 2 points
_W: tuple[np.ndarray, float] | None = None
_MISSING = False


def _head() -> tuple[np.ndarray, float] | None:
    global _W, _MISSING
    if _W is not None or _MISSING:
        return _W
    from studio.config import TOOLS

    # A project made in the studio has its own data folder and never had the head (a trip project scored every picture
    # a flat 4.5, 13 Nov). Look beside the shared tools too, then fetch it once (3 KB).
    found = next((p for p in (HEAD, TOOLS / HEAD.name) if p.exists()), None)
    if found is None and os.environ.get("STUDIO_AESTHETIC_FETCH", "1") != "0":  # tests switch the download off
        try:
            fetch()
            found = HEAD if HEAD.exists() else None
        except Exception:  # noqa: BLE001 - offline: no aesthetic score, nothing else changes
            found = None
    if found is None:
        _MISSING = True
        return None
    import torch

    state = torch.load(str(found), map_location="cpu", weights_only=True)
    _W = (state["weight"].numpy().reshape(-1).astype("float32"), float(state["bias"].numpy().reshape(-1)[0]))
    return _W


def score(emb: np.ndarray | None) -> float | None:
    head = _head()
    if head is None or emb is None or emb.shape[-1] != head[0].shape[0]:
        return None
    v = emb / (np.linalg.norm(emb) + 1e-8)
    return float(v @ head[0] + head[1])


def nudge(aes: float | None) -> float:
    """Rank change for a clip: +-0.01 per point from a middling 5, at most +-0.02."""
    if aes is None:
        return 0.0
    return WEIGHT * max(-2.0, min(2.0, aes - 5.0))


def fetch() -> bool:
    """Download the head once (3 KB). Kept beside the other local models in <data>/bin."""
    import ssl
    import urllib.request

    import certifi

    HEAD.parent.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(URL, context=ctx, timeout=60) as r:  # noqa: S310  (fixed https URL)
        HEAD.write_bytes(r.read())
    return HEAD.exists()
