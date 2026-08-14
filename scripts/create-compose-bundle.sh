#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
VERSION=$(cd "$ROOT_DIR" && node -p "require('./package.json').version")
BUNDLE_NAME="ovirt-inventory-compose-v$VERSION"
OUTPUT_PATH=${1:-"$ROOT_DIR/$BUNDLE_NAME.tar.gz"}

case "$OUTPUT_PATH" in
  /*) ;;
  *) OUTPUT_PATH="$(pwd)/$OUTPUT_PATH" ;;
esac

if [ -e "$OUTPUT_PATH" ]; then
  printf '%s\n' "Refusing to overwrite existing bundle: $OUTPUT_PATH" >&2
  exit 1
fi

STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT HUP INT TERM
BUNDLE_DIR="$STAGING_DIR/$BUNDLE_NAME"

mkdir -p "$BUNDLE_DIR/inventory_data" "$BUNDLE_DIR/postgres_data"
cp "$ROOT_DIR/compose.yaml" "$ROOT_DIR/.env.example" "$ROOT_DIR/README.md" "$ROOT_DIR/setup.sh" "$BUNDLE_DIR/"
chmod 755 "$BUNDLE_DIR/setup.sh"

# Use the portable USTAR format so macOS extended attributes cannot become PAX headers in Linux bundles.
COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --format ustar --no-mac-metadata -C "$STAGING_DIR" -czf "$OUTPUT_PATH" "$BUNDLE_NAME"
printf '%s\n' "Created $OUTPUT_PATH"
