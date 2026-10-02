#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_ROOT=${RUNTIME_DIR:-"$SCRIPT_DIR/.runtime"}
METADATA_URL=https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json

case "$(uname -m)" in
  x86_64|amd64)
    PLATFORM=linux64
    ARCHIVE_DIR=chrome-linux64
    ;;
  aarch64|arm64)
    PLATFORM=linux-arm64
    ARCHIVE_DIR=chrome-linux-arm64
    ;;
  *)
    echo "Unsupported CPU architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

for command_name in node wget unzip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 1
  fi
done

CHROME_BIN_PATH="$RUNTIME_ROOT/$ARCHIVE_DIR/chrome"
if [ -x "$CHROME_BIN_PATH" ] && [ "${1:-}" != "--force" ]; then
  printf '%s\n' "$CHROME_BIN_PATH"
  exit 0
fi

mkdir -p "$RUNTIME_ROOT"
METADATA_FILE="$RUNTIME_ROOT/chrome-versions.json"
ARCHIVE_FILE="$RUNTIME_ROOT/chrome.zip.part"
EXTRACT_DIR="$RUNTIME_ROOT/extract.tmp"

echo "Resolving the current Stable Chrome for Testing build…" >&2
wget -qO "$METADATA_FILE" "$METADATA_URL"

CHROME_URL=$(node -e '
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const platform = process.argv[2];
  const item = data.channels?.Stable?.downloads?.chrome?.find((entry) => entry.platform === platform);
  if (!item?.url) process.exit(2);
  process.stdout.write(item.url);
' "$METADATA_FILE" "$PLATFORM")

if [ -z "$CHROME_URL" ]; then
  echo "No Stable Chrome download was found for $PLATFORM" >&2
  exit 1
fi

echo "Downloading Chrome for Testing ($PLATFORM)…" >&2
wget -O "$ARCHIVE_FILE" "$CHROME_URL"

rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
unzip -q "$ARCHIVE_FILE" -d "$EXTRACT_DIR"

if [ ! -x "$EXTRACT_DIR/$ARCHIVE_DIR/chrome" ]; then
  echo "Downloaded archive did not contain the expected Chrome executable" >&2
  exit 1
fi

rm -rf "$RUNTIME_ROOT/$ARCHIVE_DIR"
mv "$EXTRACT_DIR/$ARCHIVE_DIR" "$RUNTIME_ROOT/$ARCHIVE_DIR"
rm -rf "$EXTRACT_DIR"
rm -f "$ARCHIVE_FILE"

printf '%s\n' "$CHROME_BIN_PATH"
