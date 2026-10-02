#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=$("$SCRIPT_DIR/download-node.sh")
CHROME_BIN=$(NODE_BIN="$NODE_BIN" "$SCRIPT_DIR/download-chrome.sh")

if ! CHROME_VERSION_OUTPUT=$("$CHROME_BIN" --version 2>&1); then
  echo "Downloaded Chrome cannot run on this Linux host:" >&2
  echo "$CHROME_VERSION_OUTPUT" >&2
  if command -v ldd >/dev/null 2>&1; then
    echo "Shared-library check:" >&2
    ldd "$CHROME_BIN" 2>&1 | grep 'not found' >&2 || true
  fi
  echo "OS information:" >&2
  if [ -r /etc/os-release ]; then grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release >&2 || true; fi
  exit 127
fi
echo "Using $CHROME_VERSION_OUTPUT" >&2

export CHROME_BIN
export HEADLESS=${HEADLESS:-1}
cd "$SCRIPT_DIR"
exec "$NODE_BIN" src/server.mjs
