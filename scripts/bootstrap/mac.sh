#!/bin/bash
# Lazycow Studio Setup for macOS (what "Start Lazycow.command" runs the first time).
# Downloads one pinned copy of Node, uv (which brings Python) and, if you say yes, ffmpeg; checks each against the
# SHA-256 in versions.json; keeps them in ~/Library/Application Support/Lazycow. No admin password, nothing system-wide.
# Apple silicon (M1 or newer) and macOS 14 or newer: torch has no builds for Intel Macs any more.
# Not yet tested on a real Mac (13 Nov 2026): if a step fails, the log says which, and please tell us on GitHub.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LC="$HOME/Library/Application Support/Lazycow"
LOG="$LC/setup.log"
STEPS=8
mkdir -p "$LC/download"
: > "$LOG"
V="$ROOT/scripts/bootstrap/versions.json"
# versions.json without jq: plutil reads JSON on every Mac.
val() { plutil -extract "$1" raw -o - "$V"; }

say() { printf '%b\n' "$1" | tee -a "$LOG"; }
step() { say ""; say "\033[33m[$1/$STEPS] $2\033[0m"; }
ok() { say "\033[32m      OK  $1\033[0m"; }
fail() {
  say ""; say "\033[31m  !!  $1\033[0m"
  [ -n "${2:-}" ] && say "\033[36m      What to do: $2\033[0m"
  say "      The whole story is in $LOG"; read -r -p "Press Enter to close this window " _; exit 1
}
ask() { local a; read -r -p "      $1 [$2] " a; printf '%s' "${a:-$2}"; }
fetch() {  # url sha name
  local out="$LC/download/$3"
  if [ -f "$out" ] && [ "$(shasum -a 256 "$out" | cut -d' ' -f1)" = "$2" ]; then ok "$3 (already downloaded)"; return; fi
  say "      downloading $3 ..."
  curl -L --fail --retry 3 -# -o "$out" "$1" || fail "Could not download $3." "Check the internet connection, then open Start Lazycow again. It carries on where it stopped."
  if [ "$(shasum -a 256 "$out" | cut -d' ' -f1)" != "$2" ]; then rm -f "$out"; fail "$3 did not match its fingerprint (SHA-256), so it was deleted and not used." "Try again later; if it keeps happening, tell us on GitHub."; fi
  ok "$3 (fingerprint checked)"
}

clear
say "\033[36m  +------------------------------------------------------------------+"
say "  |    L A Z Y C O W   S T U D I O          S E T U P                |"
say "  |    Your footage. Your Mac. You just say yes.                     |"
say "  +------------------------------------------------------------------+\033[0m"
say "   Did you read README.TXT first? Good. This takes 10 to 30 minutes (about 1.5 GB)."

step 1 "Looking at this Mac"
[ "$(uname -m)" = "arm64" ] || fail "This Mac has an Intel processor." "Lazycow Studio needs Apple silicon (M1 or newer) for its search model. Sorry!"
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 14 ] || fail "macOS $major is too old." "Update to macOS 14 (Sonoma) or newer."
ok "Apple silicon, macOS $(sw_vers -productVersion)"

step 2 "Choosing folders"
DATA=$(grep -E '^STUDIO_DATA=' "$ROOT/.env" 2>/dev/null | cut -d= -f2-)
[ -n "$DATA" ] || DATA=$(ask "Data folder (what the studio makes)" "$HOME/Lazycow Studio")
FOOTAGE=""
[ -f "$ROOT/.env" ] || FOOTAGE=$(ask "Footage folder (only read, never changed)" "$HOME/Movies")
mkdir -p "$DATA"; ok "data: $DATA"; [ -n "$FOOTAGE" ] && ok "footage: $FOOTAGE"

step 3 "Node $(val node.version)"
NODE="$LC/node"
if [ "$("$NODE/bin/node" --version 2>/dev/null)" != "v$(val node.version)" ]; then
  fetch "$(val node.darwin-arm64.url)" "$(val node.darwin-arm64.sha256)" "node.tar.gz"
  rm -rf "$NODE" "$LC/unpack"; mkdir -p "$LC/unpack"; tar -xzf "$LC/download/node.tar.gz" -C "$LC/unpack"
  mv "$LC/unpack/$(val node.darwin-arm64.dir)" "$NODE"; rm -rf "$LC/unpack"
fi
export PATH="$NODE/bin:$PATH"; ok "node $(node --version)"

step 4 "Python $(val python), installed by uv $(val uv.version)"
UV="$LC/uv/uv"
if ! "$UV" --version 2>/dev/null | grep -q "$(val uv.version)"; then
  fetch "$(val uv.darwin-arm64.url)" "$(val uv.darwin-arm64.sha256)" "uv.tar.gz"
  rm -rf "$LC/uv" "$LC/unpack"; mkdir -p "$LC/unpack"; tar -xzf "$LC/download/uv.tar.gz" -C "$LC/unpack"
  mv "$LC/unpack/$(val uv.darwin-arm64.dir)" "$LC/uv"; rm -rf "$LC/unpack"
fi
export UV_PYTHON_INSTALL_DIR="$LC/python" UV_CACHE_DIR="$LC/uv-cache" UV_NO_MODIFY_PATH=1
PY="$DATA/venv/bin/python"
if [ ! -x "$PY" ]; then
  "$UV" python install "$(val python)" >>"$LOG" 2>&1
  "$UV" venv "$DATA/venv" --python "$(val python)" >>"$LOG" 2>&1 || fail "Could not make the Python environment." "See the log."
fi
say "      installing the studio's Python packages ..."
"$UV" pip sync --python "$PY" --require-hashes "$ROOT/py/requirements-mac.lock" >>"$LOG" 2>&1 || fail "The Python packages did not install." "Check the internet connection and open it again; it resumes."
ok "python $("$PY" --version | cut -d' ' -f2), packages checked against their hashes"

step 5 "ffmpeg"
BIN="$DATA/bin"; mkdir -p "$BIN"
if [ -x "$BIN/ffmpeg" ]; then ok "ffmpeg already in $BIN"
else
  say "      ffmpeg is free software under the GPL (this build includes x264), built by Martin Riedl."
  a=$(ask "Download ffmpeg $(val ffmpeg.version)? (Y/n)" "Y")
  if [[ "$a" =~ ^[Nn] ]]; then say "      Skipped. Put ffmpeg and ffprobe in $BIN before making reels."
  else
    for t in ffmpeg ffprobe; do
      fetch "$(val ffmpeg.darwin-arm64.$t.url)" "$(val ffmpeg.darwin-arm64.$t.sha256)" "$t.zip"
      unzip -o -q "$LC/download/$t.zip" -d "$BIN"; chmod +x "$BIN/$t"; xattr -d com.apple.quarantine "$BIN/$t" 2>/dev/null
    done
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
ln -sf "$ROOT/Start Lazycow.command" "$HOME/Desktop/Lazycow Studio"
ok "Lazycow Studio on your Desktop"
printf '{"root":"%s","data":"%s","node":"%s","uv":"%s"}\n' "$ROOT" "$DATA" "$(val node.version)" "$(val uv.version)" > "$LC/installed.json"

say ""
say "\033[32m  SETUP COMPLETE. No serial number. No CD key. No crack. It is free. Really.\033[0m"
say "   Opening the studio... Lazy Kenji will show you around."
node "$ROOT/scripts/app.mjs"
