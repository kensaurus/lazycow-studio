#!/bin/bash
# Lazycow Studio: double-click me (the first time: right-click > Open, because macOS asks about downloaded files).
# The first time I install everything (scripts/bootstrap/mac.sh); after that I just open the studio.
cd "$(dirname "$0")" || exit 1
NODE="$HOME/Library/Application Support/Lazycow/node/bin/node"
if [ -x "$NODE" ] && [ -f .env ]; then exec "$NODE" scripts/app.mjs; fi
exec bash scripts/bootstrap/mac.sh
