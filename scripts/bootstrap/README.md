# The double-click setup (maintainers)

What a person does: download `Lazycow-Studio-<version>.zip`, unzip, read `README.TXT`, double-click **Start Lazycow**.
What happens: `Start Lazycow.cmd` runs `windows.ps1` (Mac: `Start Lazycow.command` runs `mac.sh`), which downloads the
pinned tools in [`versions.json`](versions.json), checks each SHA-256, keeps them in `%LOCALAPPDATA%\Lazycow`
(Mac: `~/Library/Application Support/Lazycow`), installs the locked Python packages with uv, runs `npm ci` and
`scripts/setup.mjs`, makes shortcuts and opens the studio. No admin rights, nothing on the system PATH.

## Update a pinned tool

1. Pick a release at least two weeks old.
2. Copy its official SHA-256 into `versions.json`:
   - Node: `https://nodejs.org/dist/v<version>/SHASUMS256.txt` (`win-x64.zip`, `darwin-arm64.tar.gz`).
   - uv: `https://github.com/astral-sh/uv/releases/download/<version>/<asset>.sha256`.
   - ffmpeg (Windows): the asset digest on `https://github.com/GyanD/codexffmpeg/releases/tag/<version>`
     (`gh api repos/GyanD/codexffmpeg/releases/tags/<version> --jq '.assets[]|.name+" "+.digest'`).
   - ffmpeg (Mac): `https://ffmpeg.martin-riedl.de/info/history/macos/arm64/release` → the build's `.zip.sha256`.
3. `npm test` (test/setup-kit.test.mjs checks the shape), then a real install (below).

## Re-lock the Python packages

`py/requirements-app.in` holds the versions the studio is tested with. After changing it:

```
uv pip compile py/requirements-app.in --python-version 3.13 --python-platform x86_64-pc-windows-msvc --torch-backend cpu --generate-hashes --no-header -o py/requirements-win.lock
MACOSX_DEPLOYMENT_TARGET=14.0 uv pip compile py/requirements-app.in --python-version 3.13 --python-platform aarch64-apple-darwin --generate-hashes --no-header -o py/requirements-mac.lock
```

Prove the Windows lock installs: `uv venv t --python 3.13 && uv pip sync --python t/Scripts/python.exe --torch-backend cpu --require-hashes py/requirements-win.lock`.

## Test a real install without touching this PC's own setup

```
node scripts/release-zip.mjs --out <scratch>          # from a commit: the zip a person downloads
# unzip it into <scratch>\x, then, from the unzipped folder:
set LOCALAPPDATA=<scratch>\lad
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap\windows.ps1 -Yes -NoShortcuts -NoOpen -Data <scratch>\data -Footage <scratch>\footage
```

`-Yes` takes every suggestion, `-NoShortcuts` leaves the desktop alone, `-NoOpen` does not open the studio. Before a
release, also run it once on a clean Windows 11 (Windows Sandbox is enough) with a non-admin account and a user name
with a space or Japanese characters, and on an Apple-silicon Mac (mac.sh is untested as of 13 Nov 2026).

## Release

Build the zip from the public export (`scripts/public-export.mjs --git`), never from the private repo:
`node scripts/release-zip.mjs --from <public export> --out dist`. Attach the zip and its SHA-256 to the GitHub release.
