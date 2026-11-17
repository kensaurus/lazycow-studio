#!/bin/sh
# Lazycow Studio: can this Mac or Linux PC run it? The check before anything is downloaded. Needs only sh and curl.
#
# One line, in Terminal:
#   curl -fsSL https://raw.githubusercontent.com/kensaurus/lazycow-studio/main/scripts/bootstrap/doctor.sh | sh
# From the studio folder (mac.sh runs this as its step 1):
#   sh scripts/bootstrap/doctor.sh [--json] [--dir <folder>]
#
# The core of `npx lazycow doctor` (packages/lazycow/lib/doctor.mjs), same numbers: system and processor type (an Intel
# Mac is blocked: PyTorch has had no macOS x86 builds since 2.2), processor threads, memory, free disk where the studio
# goes, and whether each download host answers (HEAD, 5 s, all at once). Exit code 0 READY, 1 SLOW, 2 BLOCKED.
# Plain POSIX sh (dash, bash, zsh's sh) and ASCII.

JSON=0
DIR="$HOME"
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --dir) shift; DIR="${1:-$HOME}" ;;
  esac
  shift
done

# The studio's limits (server/health.mjs LIMITS) and the install's needs (doctor.mjs INSTALL).
THREADS_MIN=4; THREADS_SLOW=8
RAM_MIN=6; RAM_SLOW=12
INSTALL_GB=6; RENDERS_GB=20
DOWNLOAD_GB=1.3

TOP=0
LINES=""
JCHECKS=""
nl='
'
# check <id> <level ok|slow|blocked> <label> <found> [fix]
check() {
  case "$2" in ok) r=0; mark="[ok]" ;; slow) r=1; mark="[! ]" ;; *) r=2; mark="[XX]" ;; esac
  [ "$r" -gt "$TOP" ] && TOP=$r
  LINES="$LINES$mark $3: $4$nl"
  [ "$2" != ok ] && [ -n "${5:-}" ] && LINES="$LINES     -> $5$nl"
  if [ "$r" -gt 0 ]; then
    if [ "$r" -gt "${WORST_RANK:-0}" ]; then WORST_RANK=$r; REASON="$3: $4"; FIX="${5:-}"
    elif [ "$r" -eq "${WORST_RANK:-0}" ]; then REASON="$REASON; $3: $4"; FIX="$FIX ${5:-}"; fi
  fi
  esc_found=$(printf '%s' "$4" | sed 's/\\/\\\\/g; s/"/\\"/g')
  esc_fix=$(printf '%s' "${5:-}" | sed 's/\\/\\\\/g; s/"/\\"/g')
  JCHECKS="$JCHECKS${JCHECKS:+,}{\"id\":\"$1\",\"level\":\"$2\",\"label\":\"$3\",\"found\":\"$esc_found\",\"fix\":\"$esc_fix\"}"
}
lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }

OS=$(uname -s)
ARCH=$(uname -m)

# System
case "$OS" in
  Darwin)
    VER=$(sw_vers -productVersion 2>/dev/null)
    MAJOR=${VER%%.*}
    NAME="macOS $VER"
    if [ "$ARCH" != "arm64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" != "1" ]; then
      check system blocked "System" "$NAME: this Mac has an Intel processor" "Lazycow's footage search runs on PyTorch, which has had no builds for Intel Macs (macOS x86) since version 2.2 in January 2024. Use a Mac with Apple silicon (M1 or newer), or a Windows or Linux PC."
    elif [ -n "$MAJOR" ] && [ "$MAJOR" -lt 14 ]; then
      check system blocked "System" "$NAME" "Update to macOS 14 (Sonoma) or newer: the studio's Python packages are built for it."
    else
      check system ok "System" "$NAME, Apple silicon"
    fi
    THREADS=$(sysctl -n hw.ncpu 2>/dev/null)
    RAM_GB=$(awk -v b="$(sysctl -n hw.memsize 2>/dev/null)" 'BEGIN { printf "%.1f", b / 1073741824 }')
    ;;
  Linux)
    NAME=$( (. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME") )
    NAME=${NAME:-Linux}
    case "$ARCH" in
      x86_64|aarch64|arm64) check system ok "System" "$NAME, $ARCH" ;;
      *) check system blocked "System" "$NAME, $ARCH" "Lazycow needs a 64-bit x86 or ARM Linux." ;;
    esac
    THREADS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)
    RAM_GB=$(awk '/^MemTotal:/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo 2>/dev/null)
    ;;
  *)
    NAME="$OS"
    check system blocked "System" "$OS $ARCH" "Lazycow runs on Windows 10/11, macOS 14+ on Apple silicon, and 64-bit Linux. On Windows use doctor.ps1."
    THREADS=0; RAM_GB=0
    ;;
esac
THREADS=${THREADS:-0}
RAM_GB=${RAM_GB:-0}

# Processor
if [ "$THREADS" -lt "$THREADS_MIN" ]; then check cpu blocked "Processor" "$THREADS threads" "Rendering would take well over half an hour a reel. Use a computer with at least 4 cores / 8 threads."
elif [ "$THREADS" -lt "$THREADS_SLOW" ]; then check cpu slow "Processor" "$THREADS threads" "Reels render, slowly. Close other heavy apps while the studio renders."
else check cpu ok "Processor" "$THREADS threads"; fi

# Memory
RAM_TXT=$(awk -v g="$RAM_GB" 'BEGIN { printf "%.0f GB", g }')
if lt "$RAM_GB" "$RAM_MIN"; then check ram blocked "Memory" "$RAM_TXT" "The footage search and the renderer need about 4 GB together. Use a computer with 8 GB or more."
elif lt "$RAM_GB" "$RAM_SLOW"; then check ram slow "Memory" "$RAM_TXT" "Close browser tabs and other apps before making several reels at once."
else check ram ok "Memory" "$RAM_TXT"; fi

# Free disk where the studio goes (the nearest folder that exists)
D="$DIR"
while [ ! -d "$D" ] && [ "$D" != "/" ]; do D=$(dirname "$D"); done
FREE_GB=$(df -Pk "$D" 2>/dev/null | awk 'NR == 2 { printf "%.1f", $4 / 1048576 }')
NEEDS="(needs $INSTALL_GB GB to install, $RENDERS_GB GB for renders)"
if [ -z "$FREE_GB" ]; then check disk ok "Free space in $D" "unknown $NEEDS"
else
  FREE_TXT=$(awk -v g="$FREE_GB" 'BEGIN { printf "%.0f GB", g }')
  if lt "$FREE_GB" "$INSTALL_GB"; then check disk blocked "Free space in $D" "$FREE_TXT $NEEDS" "Free at least $INSTALL_GB GB there, or install to a bigger drive."
  elif lt "$FREE_GB" "$((INSTALL_GB + RENDERS_GB))"; then check disk slow "Free space in $D" "$FREE_TXT $NEEDS" "It installs, with room for only a few reels. Free up space, or put the studio's data on a bigger drive."
  else check disk ok "Free space in $D" "$FREE_TXT $NEEDS"; fi
fi

# Download hosts (doctor.mjs HOSTS): host url need(1 = the install needs it) what. One HEAD each, all at once, 5 s.
HOSTS="github.com https://github.com/ 1 the-studio,-uv,-Python
release-assets.githubusercontent.com https://release-assets.githubusercontent.com/ 1 GitHub-release-downloads
nodejs.org https://nodejs.org/dist/ 1 Node
pypi.org https://pypi.org/simple/ 1 Python-package-index
files.pythonhosted.org https://files.pythonhosted.org/ 1 Python-packages
download.pytorch.org https://download.pytorch.org/whl/cpu/ 1 PyTorch-(footage-search)
registry.npmjs.org https://registry.npmjs.org/ 1 the-studio's-npm-packages
ffmpeg.martin-riedl.de https://ffmpeg.martin-riedl.de/ 1 ffmpeg
huggingface.co https://huggingface.co/ 0 the-footage-search-model
raw.githubusercontent.com https://raw.githubusercontent.com/ 0 the-picture-quality-model
api.openverse.org https://api.openverse.org/v1/ 0 free-music"
if command -v curl >/dev/null 2>&1; then
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t lazycow)
  n=0
  # A here-document, not a pipe: the loop runs in this shell, so `wait` waits for every curl it started.
  while read -r host url need what; do
    n=$((n + 1))
    ( code=$(curl -s -I -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null); printf '%s %s %s %s\n' "$host" "${code:-000}" "$need" "$what" > "$TMP/$n" ) &
  done <<EOF
$HOSTS
EOF
  wait
  OK=0; ALL=0; DOWN=""; HARD=0
  for f in "$TMP"/*; do
    [ -f "$f" ] || continue
    read -r host code need what < "$f"
    ALL=$((ALL + 1))
    if [ "$code" != "000" ]; then OK=$((OK + 1))
    else DOWN="$DOWN${DOWN:+, }$host ($(printf '%s' "$what" | tr '-' ' '))"; [ "$need" = 1 ] && HARD=$((HARD + 1)); fi
  done
  rm -rf "$TMP"
  if [ -z "$DOWN" ]; then check net ok "Downloads reachable" "github.com, nodejs.org, pypi.org, ... ($OK of $ALL)"
  elif [ "$HARD" -gt 0 ]; then check net blocked "Downloads" "no answer from $DOWN" "The install cannot finish without these. Check the internet connection; on a work or school network, ask for these sites to be allowed, or set HTTPS_PROXY."
  else check net slow "Downloads" "no answer from $DOWN" "The install works; the features named wait until these answer. Check a firewall or proxy."; fi
else
  check net blocked "Downloads" "curl is missing" "Install curl (the setup downloads with it), then run this again."
fi

case "$TOP" in 0) VERDICT=READY ;; 1) VERDICT=SLOW ;; *) VERDICT=BLOCKED ;; esac
if [ "$JSON" = 1 ]; then
  printf '{"verdict":"%s","exitCode":%s,"threads":%s,"ramGb":%s,"freeGb":%s,"checks":[%s]}\n' "$VERDICT" "$TOP" "$THREADS" "$RAM_GB" "${FREE_GB:-null}" "$JCHECKS"
else
  printf 'Lazycow check - %s %s - %s threads - %s RAM\n' "$NAME" "$ARCH" "$THREADS" "$RAM_TXT"
  printf '%s' "$LINES"
  DL="Install downloads about $DOWNLOAD_GB GB and takes 10 to 30 minutes."
  case "$VERDICT" in
    READY) echo "Verdict: READY. $DL" ;;
    SLOW) echo "Verdict: SLOW. $REASON. Lazycow will run, slower or with less room. $DL" ;;
    *) echo "Verdict: BLOCKED. $REASON. What to do:$FIX" ;;
  esac
  echo "For the processor speed test and a time per reel, once Node is here: npx lazycow doctor"
fi
exit "$TOP"
