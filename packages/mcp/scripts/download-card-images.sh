#!/usr/bin/env sh
set -eu

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <base_url> <id_file> <output_dir> [ext]" >&2
  echo "Example: $0 https://example.com/card_images ids.txt packages/standalone/public/card_images webp" >&2
  exit 1
fi

BASE_URL="$1"
ID_FILE="$2"
OUTPUT_DIR="$3"
EXT="${4:-webp}"

if [ ! -f "$ID_FILE" ]; then
  echo "ID file not found: $ID_FILE" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not found in PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

while IFS= read -r raw_id; do
  id="$(printf "%s" "$raw_id" | tr -d '\r' | xargs)"
  if [ -z "$id" ]; then
    continue
  fi
  case "$id" in
    \#*)
      continue
      ;;
  esac

  src="${BASE_URL%/}/$id.$EXT"
  dst="$OUTPUT_DIR/$id.$EXT"

  if [ -f "$dst" ]; then
    continue
  fi

  echo "Downloading $src"
  curl -fL "$src" -o "$dst"
done < "$ID_FILE"

echo "Done. Images saved to: $OUTPUT_DIR"
