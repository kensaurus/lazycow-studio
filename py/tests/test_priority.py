"""A render runs below the studio's own pages (studio.priority): a reel build and a remix lower themselves first."""
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(os.name != "nt", reason="the Windows priority class")
def test_background_priority_lowers_this_process_to_below_normal():
    code = ("import ctypes; from ctypes import wintypes; from studio.priority import background_priority; background_priority(); "
            "k = ctypes.WinDLL('kernel32'); k.GetCurrentProcess.restype = wintypes.HANDLE; k.GetPriorityClass.argtypes = (wintypes.HANDLE,); "
            "print(k.GetPriorityClass(k.GetCurrentProcess()))")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=Path(__file__).parents[1], check=True)
    assert out.stdout.strip() == str(0x4000)  # BELOW_NORMAL_PRIORITY_CLASS


def test_a_reel_build_and_a_remix_lower_themselves_before_rendering():
    src = (Path(__file__).parents[1] / "studio" / "__main__.py").read_text(encoding="utf-8")
    at = src.index('elif args.cmd == "reels":')
    block = src[at:src.index("elif args.cmd", at + 10)]
    assert "if args.build or args.remix" in block and "background_priority()" in block
    assert block.index("background_priority()") < block.index("story_reels.remix(")
