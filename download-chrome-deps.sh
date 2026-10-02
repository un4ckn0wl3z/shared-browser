#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_ROOT=${RUNTIME_DIR:-"$SCRIPT_DIR/.runtime"}
DEB_DIR="$RUNTIME_ROOT/chrome-deps-debs"
LIB_ROOT="$RUNTIME_ROOT/chrome-deps"
PATH_FILE="$RUNTIME_ROOT/chrome-deps-library-path"

if [ -s "$PATH_FILE" ] && [ "${1:-}" != "--force" ]; then
  cat "$PATH_FILE"
  exit 0
fi

for command_name in apt-get apt-cache dpkg-deb wget; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required Debian command is missing: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$RUNTIME_ROOT"
rm -rf "$DEB_DIR" "$LIB_ROOT"
mkdir -p "$DEB_DIR" "$LIB_ROOT"

echo "Downloading Chrome NSS/NSPR libraries without installing them…" >&2
if (
  cd "$DEB_DIR"
  apt-get download libnspr4 libnss3
); then
  :
else
  echo "The configured Debian mirror no longer has the cached package version; using Debian Snapshot…" >&2
  rm -f "$DEB_DIR"/*.deb

  download_snapshot_package() {
    package_name=$1
    source_name=$2
    package_version=$(apt-cache show "$package_name" 2>/dev/null | sed -n 's/^Version: //p' | head -n 1)

    if [ -z "$package_version" ]; then
      echo "Could not determine the cached version of $package_name" >&2
      return 1
    fi

    encoded_version=$(printf '%s' "$package_version" | sed 's/%/%25/g; s/:/%3A/g; s/+/%2B/g')
    index_file="$DEB_DIR/$package_name.snapshot.html"
    index_url="https://snapshot.debian.org/package/$source_name/$encoded_version/"

    echo "Downloading $package_name $package_version from Debian Snapshot…" >&2
    wget -qO "$index_file" "$index_url"
    package_href=$(sed -n 's|.*href="\([^"]*/'"$package_name"'_[^"]*_amd64\.deb\)".*|\1|p' "$index_file" | head -n 1)

    if [ -z "$package_href" ]; then
      echo "Could not locate the amd64 archive for $package_name $package_version" >&2
      return 1
    fi

    case "$package_href" in
      http://*|https://*) package_url=$package_href ;;
      *) package_url="https://snapshot.debian.org$package_href" ;;
    esac

    wget -qO "$DEB_DIR/$package_name.snapshot.deb" "$package_url"
    rm -f "$index_file"
  }

  download_snapshot_package libnspr4 nspr
  download_snapshot_package libnss3 nss
fi

FOUND_DEB=0
for archive in "$DEB_DIR"/*.deb; do
  if [ ! -f "$archive" ]; then continue; fi
  FOUND_DEB=1
  dpkg-deb -x "$archive" "$LIB_ROOT"
done

if [ "$FOUND_DEB" -ne 1 ]; then
  echo "No Debian dependency archives were downloaded" >&2
  exit 1
fi

LIBRARY_PATH=''
for directory in "$LIB_ROOT"/usr/lib/*-linux-gnu "$LIB_ROOT"/lib/*-linux-gnu "$LIB_ROOT"/usr/lib64 "$LIB_ROOT"/lib64; do
  if [ ! -d "$directory" ]; then continue; fi
  if [ -z "$LIBRARY_PATH" ]; then LIBRARY_PATH=$directory; else LIBRARY_PATH="$LIBRARY_PATH:$directory"; fi
done

if [ -z "$LIBRARY_PATH" ]; then
  echo "Could not locate the extracted library directory" >&2
  exit 1
fi

printf '%s\n' "$LIBRARY_PATH" > "$PATH_FILE"
printf '%s\n' "$LIBRARY_PATH"
