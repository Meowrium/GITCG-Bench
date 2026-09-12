#!/usr/bin/env bash
set -euo pipefail

PATCH_FILE="${1:-packages/mcp/patches/standalone-v1.patch}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not found in PATH"
  exit 1
fi

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "patch file not found: $PATCH_FILE"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "current directory is not inside a git repository"
  exit 1
fi

# Dry-run first so failures are surfaced before touching files.
git apply --check "$PATCH_FILE"
git apply "$PATCH_FILE"

echo "patch applied successfully: $PATCH_FILE"
