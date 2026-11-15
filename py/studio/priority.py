"""Renders run below the studio itself, so its pages stay quick while every core is busy.

A reel or a long video is a CPU-bound job that can hold all threads for many minutes; at normal priority it
starves the studio's own server and the helper that answers the pages (health took 13 s during a reel render,
Nov 2026). Every ffmpeg and Remotion a job starts inherits its priority class."""
import os


def background_priority() -> None:
    """Lower this process to BELOW_NORMAL (Windows) or nice 10 (elsewhere). Best effort: never stops a render."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            # typed: an untyped call passes the process pseudo-handle (-1) as a 32-bit int, which 64-bit Windows
            # reads as an invalid handle, and the call fails without a word (long videos never ran lower before)
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            k32.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
            k32.SetPriorityClass.restype = wintypes.BOOL
            k32.SetPriorityClass(k32.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
        else:
            os.nice(10)
    except Exception:
        pass
