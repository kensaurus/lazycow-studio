#!/bin/bash
# Lazycow Studio Setup for Linux (what `npx lazycow install` runs on Linux, or: bash scripts/bootstrap/linux.sh).
# Downloads one pinned copy of Node, uv (which brings Python 3.13) and, if you say yes, ffmpeg; checks each against the
# SHA-256 in versions.json; keeps them in ~/.local/share/Lazycow. No sudo, no system packages, nothing on the system PATH.
# x86_64 or arm64 with glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 or newer). Not musl (Alpine).
# Options (for scripted and test runs): --yes takes every suggestion, --data DIR, --footage DIR, --no-shortcuts, --no-open,
# --force (or LAZYCOW_FORCE=1) carries on when the step 1 check (doctor.sh) says BLOCKED.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LC="${XDG_DATA_HOME:-$HOME/.local/share}/Lazycow"
LOG="$LC/setup.log"
STEPS=8
YES=0; NO_SHORTCUTS=0; NO_OPEN=0; DATA=""; FOOTAGE=""; FORCE=0
[ "${LAZYCOW_FORCE:-}" = 1 ] && FORCE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --force) FORCE=1 ;;
    --no-shortcuts) NO_SHORTCUTS=1 ;;
    --no-open) NO_OPEN=1 ;;
    --data) DATA="${2:-}"; shift ;;
    --footage) FOOTAGE="${2:-}"; shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$LC/download"
: > "$LOG"
V="$ROOT/scripts/bootstrap/versions.json"
# versions.json without jq or python: a small JSON reader in awk (objects and strings, which is all versions.json has).
val() {
  awk -v want="$1" '{ buf = buf $0 "\n" } END {
    n = length(buf); d = 0; k = ""; iskey = 1
    for (i = 1; i <= n; i++) {
      c = substr(buf, i, 1)
      if (c == "\"") {
        s = ""
        for (i++; i <= n; i++) { c = substr(buf, i, 1); if (c == "\\") { i++; s = s substr(buf, i, 1) } else if (c == "\"") break; else s = s c }
        if (iskey) k = s
        else { p = ""; for (j = 2; j <= d; j++) p = p st[j] "."; if (p k == want) { print s; exit } }
      }
      else if (c == ":") iskey = 0
      else if (c == ",") iskey = 1
      else if (c == "{") { d++; st[d] = k; iskey = 1 }
      else if (c == "}") d--
    }
  }' "$V"
}

say() { printf '%b\n' "$1" | tee -a "$LOG"; }
step() { say ""; say "\033[33m[$1/$STEPS] $2\033[0m"; }
ok() { say "\033[32m      OK  $1\033[0m"; }
fail() {
  say ""; say "\033[31m  !!  $1\033[0m"
  [ -n "${2:-}" ] && say "\033[36m      What to do: $2\033[0m"
  say "      The whole story is in $LOG"
  [ "$YES" = 1 ] || [ ! -t 0 ] || read -r -p "Press Enter to close " _
  exit 1
}
ask() {
  local a=""
  [ "$YES" = 1 ] || [ ! -t 0 ] || read -r -p "      $1 [$2] " a
  printf '%s' "${a:-$2}"
}
sha() { sha256sum "$1" | cut -d' ' -f1; }
fetch() {  # url sha name
  local out="$LC/download/$3"
  if [ -f "$out" ] && [ "$(sha "$out")" = "$2" ]; then ok "$3 (already downloaded)"; return; fi
  say "      downloading $3 ..."
  curl -L --fail --retry 3 -# -o "$out" "$1" || fail "Could not download $3." "Check the internet connection, then run the setup again. It carries on where it stopped."
  if [ "$(sha "$out")" != "$2" ]; then rm -f "$out"; fail "$3 did not match its fingerprint (SHA-256), so it was deleted and not used." "Try again later; if it keeps happening, tell us on GitHub."; fi
  ok "$3 (fingerprint checked)"
}
# version_ge A B: is version A at least B (both like 2.35)?
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

say "\033[36m  +------------------------------------------------------------------+"
say "  |    L A Z Y C O W   S T U D I O          S E T U P                |"
say "  |    Your footage. Your Linux box. You just say yes.               |"
say "  +------------------------------------------------------------------+\033[0m"
say "   Did you read README.TXT first? Good. This takes 10 to 30 minutes (about 1.3 GB)."

step 1 "Looking at this computer"
# The check before anything is downloaded (doctor.sh, the same rules as `npx lazycow doctor`); skipped when
# npx lazycow install has already run it (LAZYCOW_CHECKED).
if [ -z "${LAZYCOW_CHECKED:-}" ]; then
  sh "$ROOT/scripts/bootstrap/doctor.sh" --dir "$LC" 2>&1 | tee -a "$LOG" | sed 's/^/      /'
  [ "${PIPESTATUS[0]}" = 2 ] && [ "$FORCE" != 1 ] && fail "This computer cannot run Lazycow Studio yet (BLOCKED, above). Nothing was downloaded." "Fix what it says, then run the setup again. To install anyway: bash scripts/bootstrap/linux.sh --force"
fi
[ "$(uname -s)" = "Linux" ] || fail "This is not Linux ($(uname -s))." "On a Mac, double-click \"Start Lazycow.command\"; on Windows, \"Start Lazycow.cmd\"."
case "$(uname -m)" in
  x86_64|amd64) ARCH=linux-x64; LOCK=requirements-linux.lock ;;
  aarch64|arm64) ARCH=linux-arm64; LOCK=requirements-linux-arm64.lock ;;
  *) fail "This processor ($(uname -m)) is not supported." "Lazycow Studio runs on 64-bit Intel/AMD (x86_64) or 64-bit ARM (aarch64)." ;;
esac
for tool in curl tar gzip sha256sum awk sort; do
  command -v "$tool" >/dev/null 2>&1 || fail "The command \"$tool\" is missing." "Install \"$tool\" with your system's package manager, then run the setup again."
done
GLIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
NEED_GLIBC=$(val "ffmpeg.$ARCH.glibc")
[ -n "$GLIBC" ] || fail "This Linux does not use glibc (Alpine and other musl systems are not supported)." "Use Ubuntu 22.04, Debian 12, Fedora 36 or newer."
version_ge "$GLIBC" "$NEED_GLIBC" || fail "glibc $GLIBC is too old (the studio's tools need $NEED_GLIBC or newer)." "Use Ubuntu 22.04, Debian 12, Fedora 36 or newer."
mkdir -p "$LC"
free_gb=$(df -Pk "$LC" | awk 'NR==2 {print int($4 / 1048576)}')
[ "${free_gb:-0}" -ge 6 ] || fail "Only ${free_gb} GB free in $LC." "Free at least 6 GB (20 GB is better for renders), then run the setup again."
ok "$ARCH, glibc $GLIBC, ${free_gb} GB free"

step 2 "Choosing folders"
[ -n "$DATA" ] || DATA=$(grep -E '^STUDIO_DATA=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"')
[ -n "$DATA" ] || DATA=$(ask "Data folder (what the studio makes)" "$HOME/Lazycow Studio")
if [ -z "$FOOTAGE" ] && [ ! -f "$ROOT/.env" ]; then
  videos=$(xdg-user-dir VIDEOS 2>/dev/null); [ -n "$videos" ] && [ "$videos" != "$HOME" ] || videos="$HOME/Videos"
  FOOTAGE=$(ask "Footage folder (only read, never changed)" "$videos")
fi
mkdir -p "$DATA" || fail "Could not make $DATA." "Choose a folder you can write to."
ok "data: $DATA"; [ -n "$FOOTAGE" ] && ok "footage: $FOOTAGE"

step 3 "Node $(val node.version)"
NODE="$LC/node"
if [ "$("$NODE/bin/node" --version 2>/dev/null)" != "v$(val node.version)" ]; then
  fetch "$(val "node.$ARCH.url")" "$(val "node.$ARCH.sha256")" "node-$ARCH.tar.gz"
  rm -rf "$NODE" "$LC/unpack"; mkdir -p "$LC/unpack"; tar -xzf "$LC/download/node-$ARCH.tar.gz" -C "$LC/unpack"
  mv "$LC/unpack/$(val "node.$ARCH.dir")" "$NODE"; rm -rf "$LC/unpack"
fi
export PATH="$NODE/bin:$PATH"; ok "node $(node --version)"

step 4 "Python $(val python), installed by uv $(val uv.version)"
UV="$LC/uv/uv"
if ! "$UV" --version 2>/dev/null | grep -q "$(val uv.version)"; then
  fetch "$(val "uv.$ARCH.url")" "$(val "uv.$ARCH.sha256")" "uv-$ARCH.tar.gz"
  rm -rf "$LC/uv" "$LC/unpack"; mkdir -p "$LC/unpack"; tar -xzf "$LC/download/uv-$ARCH.tar.gz" -C "$LC/unpack"
  mv "$LC/unpack/$(val "uv.$ARCH.dir")" "$LC/uv"; rm -rf "$LC/unpack"
fi
export UV_PYTHON_INSTALL_DIR="$LC/python" UV_CACHE_DIR="$LC/uv-cache" UV_NO_MODIFY_PATH=1 UV_PYTHON_PREFERENCE=only-managed
PY="$DATA/venv/bin/python"
if [ ! -x "$PY" ]; then
  "$UV" python install "$(val python)" >>"$LOG" 2>&1
  "$UV" venv "$DATA/venv" --python "$(val python)" >>"$LOG" 2>&1 || fail "Could not make the Python environment." "See the log."
fi
say "      installing the studio's Python packages (the search model alone is ~300 MB) ..."
"$UV" pip sync --python "$PY" --torch-backend cpu --require-hashes "$ROOT/py/$LOCK" >>"$LOG" 2>&1 || fail "The Python packages did not install." "Check the internet connection and run it again; it resumes. The log says which package failed."
ok "python $("$PY" --version | cut -d' ' -f2), packages checked against their hashes"

step 5 "ffmpeg"
BIN="$DATA/bin"; mkdir -p "$BIN"
if [ -x "$BIN/ffmpeg" ] && [ -x "$BIN/ffprobe" ]; then ok "ffmpeg already in $BIN"
else
  say "      ffmpeg is free software under the GPL (this build includes x264), built by Martin Riedl."
  a=$(ask "Download ffmpeg $(val ffmpeg.version)? (Y/n)" "Y")
  if [[ "$a" =~ ^[Nn] ]]; then say "      Skipped. Put ffmpeg and ffprobe in $BIN before making reels."
  else
    for t in ffmpeg ffprobe; do
      fetch "$(val "ffmpeg.$ARCH.$t.url")" "$(val "ffmpeg.$ARCH.$t.sha256")" "$t-$ARCH.zip"
      # The studio's own Python unzips, so the setup does not need the unzip package.
      "$PY" -m zipfile -e "$LC/download/$t-$ARCH.zip" "$BIN" >>"$LOG" 2>&1 || fail "Could not unpack $t." "See the log."
      chmod +x "$BIN/$t"
    done
    "$BIN/ffmpeg" -hide_banner -version >>"$LOG" 2>&1 || fail "The downloaded ffmpeg does not start on this system." "The log says why. You can put your own ffmpeg 6 or newer (and ffprobe) in $BIN instead."
    printf 'ffmpeg %s. %s\n' "$(val ffmpeg.version)" "$(val ffmpeg.licence)" > "$BIN/ffmpeg-SOURCE.txt"
    ok "ffmpeg $(val ffmpeg.version) in $BIN"
  fi
fi

step 6 "The studio's packages (npm)"
cd "$ROOT" || exit 1
npm ci --omit=dev --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1 || fail "npm could not install the studio's packages." "Check the internet connection and try again."
ok "packages installed"

step 7 "Settings, the picture-quality model and some free music"
args=(scripts/setup.mjs --data "$DATA"); [ -n "$FOOTAGE" ] && args+=(--footage "$FOOTAGE")
STUDIO_PY="$PY" STUDIO_TOOLS="$BIN" node "${args[@]}" 2>&1 | tee -a "$LOG" | sed 's/^/      /'

step 8 "A shortcut"
if [ "$NO_SHORTCUTS" = 1 ]; then ok "skipped (--no-shortcuts)"
else
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"; mkdir -p "$apps"
  # Desktop Entry Exec: quote each argument, escaping " ` $ and \ (freedesktop.org Desktop Entry spec).
  q() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g')"; }
  {
    printf '[Desktop Entry]\nType=Application\nName=Lazycow Studio\n'
    printf 'Comment=Your footage, made into short videos\n'
    printf 'Exec=%s %s\n' "$(q "$NODE/bin/node")" "$(q "$ROOT/scripts/app.mjs")"
    printf 'Path=%s\nIcon=%s\nTerminal=false\nCategories=AudioVideo;Video;\n' "$ROOT" "$ROOT/server/brand/icon-512.png"
  } > "$apps/lazycow-studio.desktop"
  chmod +x "$apps/lazycow-studio.desktop"
  ok "Lazycow Studio in your applications menu"
fi
printf '{"root":"%s","data":"%s","node":"%s","uv":"%s"}\n' "$ROOT" "$DATA" "$(val node.version)" "$(val uv.version)" > "$LC/installed.json"

say ""
say "\033[32m  SETUP COMPLETE. No serial number. No CD key. No crack. It is free. Really.\033[0m"
if [ "$NO_OPEN" = 1 ]; then say "   Open it later from the applications menu, or: $NODE/bin/node \"$ROOT/scripts/app.mjs\""
else
  say "   Opening the studio... Lazy Kenji will show you around."
  node "$ROOT/scripts/app.mjs"
fi
