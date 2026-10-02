#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_ROOT=${RUNTIME_DIR:-"$SCRIPT_DIR/.runtime"}
NODE_INDEX_URL=https://nodejs.org/dist/index.tab

case "$(uname -m)" in
  x86_64|amd64) NODE_PLATFORM=linux-x64 ;;
  aarch64|arm64) NODE_PLATFORM=linux-arm64 ;;
  *)
    echo "Unsupported CPU architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

for command_name in wget tar awk; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 1
  fi
done

NODE_BIN_PATH="$RUNTIME_ROOT/node/bin/node"
if [ -x "$NODE_BIN_PATH" ] && [ "${1:-}" != "--force" ]; then
  printf '%s\n' "$NODE_BIN_PATH"
  exit 0
fi

mkdir -p "$RUNTIME_ROOT"
INDEX_FILE="$RUNTIME_ROOT/node-index.tab"
ARCHIVE_FILE="$RUNTIME_ROOT/node.tar.xz.part"
EXTRACT_DIR="$RUNTIME_ROOT/node-extract.tmp"

echo "Resolving the current Node.js LTS build…" >&2
wget -qO "$INDEX_FILE" "$NODE_INDEX_URL"
NODE_VERSION=$(awk -F '\t' 'NR > 1 && $10 != "-" && $10 != "" { print $1; exit }' "$INDEX_FILE")

if [ -z "$NODE_VERSION" ]; then
  echo "Could not determine the current Node.js LTS version" >&2
  exit 1
fi

ARCHIVE_NAME="node-$NODE_VERSION-$NODE_PLATFORM"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE_NAME.tar.xz"

echo "Downloading Node.js $NODE_VERSION ($NODE_PLATFORM)…" >&2
wget -O "$ARCHIVE_FILE" "$NODE_URL"

rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
if ! tar -xJf "$ARCHIVE_FILE" -C "$EXTRACT_DIR"; then
  echo "Unable to extract the Node.js .tar.xz archive. This host needs tar with xz support." >&2
  exit 1
fi

if [ ! -x "$EXTRACT_DIR/$ARCHIVE_NAME/bin/node" ]; then
  echo "Downloaded archive did not contain the expected Node.js executable" >&2
  exit 1
fi

rm -rf "$RUNTIME_ROOT/node"
mv "$EXTRACT_DIR/$ARCHIVE_NAME" "$RUNTIME_ROOT/node"
rm -rf "$EXTRACT_DIR"
rm -f "$ARCHIVE_FILE"

printf '%s\n' "$NODE_BIN_PATH"
