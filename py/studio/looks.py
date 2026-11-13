"""
FILE: py/studio/looks.py
PURPOSE: House 3D LUTs. Creative grade on Rec.709 footage, not a log convert.
OVERVIEW: Tsumagoi film, Asama dusk, Clean. colour-science does the Lab shift.
DEPENDENCIES: colour, numpy
USAGE: write_luts(dir) -> list of cube paths
NOTES: The owner picks from a still grid (studio looks --grid).
"""
from __future__ import annotations

from pathlib import Path

import colour
import numpy as np

SIZE = 17


def _map_lab(rgb: np.ndarray, shift_a: float, shift_b: float, lift: float, contrast: float) -> np.ndarray:
    rgb = np.clip(rgb, 0, 1)
    xyz = colour.sRGB_to_XYZ(rgb, apply_cctf_decoding=True)
    lab = colour.XYZ_to_Lab(xyz)
    lab = lab.copy()
    lab[..., 0] = (lab[..., 0] - 50) * contrast + 50 + lift
    lab[..., 1] = lab[..., 1] + shift_a
    lab[..., 2] = lab[..., 2] + shift_b
    out = colour.XYZ_to_sRGB(colour.Lab_to_XYZ(lab), apply_cctf_encoding=True)
    return np.clip(out, 0, 1)


LOOKS = {
    "tsumagoi-film": dict(shift_a=-4.0, shift_b=6.0, lift=3.0, contrast=1.06),
    "asama-dusk": dict(shift_a=2.0, shift_b=-3.0, lift=1.0, contrast=1.08),
    "clean": dict(shift_a=0.0, shift_b=1.0, lift=0.5, contrast=1.02),
}


def cube_text(name: str) -> str:
    params = LOOKS[name]
    axis = np.linspace(0, 1, SIZE)
    lines = [f'TITLE "{name}"', f"LUT_3D_SIZE {SIZE}", ""]
    for b in axis:
        for g in axis:
            for r in axis:
                mapped = _map_lab(np.array([r, g, b], dtype=np.float64), **params)
                lines.append(f"{mapped[0]:.6f} {mapped[1]:.6f} {mapped[2]:.6f}")
    return "\n".join(lines) + "\n"


def write_luts(directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for name in LOOKS:
        path = directory / f"{name}.cube"
        path.write_text(cube_text(name), encoding="utf-8")
        paths.append(path)
    return paths
