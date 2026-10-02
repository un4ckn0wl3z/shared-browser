#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CHROME_BIN=$("$SCRIPT_DIR/download-chrome.sh")

export CHROME_BIN
export HEADLESS=${HEADLESS:-1}
cd "$SCRIPT_DIR"
exec node src/server.mjs
