# lazycow-studio

A local reel studio. What it is and how to install it: [README.md](README.md). Day-to-day tasks: [docs/user-guide.md](docs/user-guide.md). It reads your footage folders and never writes back into a source file.

| Path | What |
|---|---|
| `py/studio` | Library and tags, assembler and themes, build and package, sound, review actions, the editor's helper |
| `server` | The studio server on 127.0.0.1:4317 and the editor page (home dashboard + CapCut-style editor) |
| `src` | Remotion compositions (`Story.tsx`; older first-cut recipes in `recipes/`) |
| `shared` | Sizes, safe zones, text layouts, channel specs, fact guard |
| `examples` | A made-up brand (Cafe Kumo) to try the studio with |
| `test`, `py/tests` | Layout and copy tests (`npm test`), pipeline tests (`pytest`) |
| `luts`, `scripts` | .cube colour looks; setup, launch and helper scripts |

Working files (catalog, proxies, renders, audio, reel project files) live in `STUDIO_DATA` (default `./data`, not in git). The Python venv is `STUDIO_DATA/venv`. ffmpeg, whisper.cpp and Real-ESRGAN live in `STUDIO_DATA/bin`, or ffmpeg on your PATH.

Approved reels are copied, one folder per network, to `STUDIO_READY` (default `STUDIO_DATA/ready`). Posting stays with a person.

The original Tsumagoi Work&Camp workspace keeps its own files (the "ranch overlay") in a private repository; see `py/studio/config.py` (`STUDIO_RANCH`).
