#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=$("$SCRIPT_DIR/download-node.sh")
CHROME_BIN=$(NODE_BIN="$NODE_BIN" "$SCRIPT_DIR/download-chrome.sh")

export CHROME_BIN
export HEADLESS=${HEADLESS:-1}
cd "$SCRIPT_DIR"
exec "$NODE_BIN" src/server.mjs
