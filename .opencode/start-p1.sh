#!/bin/bash
# GI-TCG AI vs AI: Player 1 (后手) - MiniMax-M2.5
# Usage: bash .opencode/start-p1.sh
#
# Concurrency-safe: uses flock to serialize access to opencode.json
# so simultaneous P0+P1 launches don't race on config file writes.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$PROJECT_DIR/.opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
LOCK_FILE="$CONFIG_DIR/opencode.json.lock"
BACKUP="$CONFIG_DIR/opencode.json.p1backup"
PROMPT_FILE="$SCRIPT_DIR/prompts/p1-start.md"

cd "$PROJECT_DIR"

# Acquire exclusive lock on the config file before touching it
exec 200>"$LOCK_FILE"
if ! flock -w 30 200; then
  echo "[P1] ERROR: Failed to acquire config lock after 30s" >&2
  exit 1
fi
echo "[P1] Config lock acquired."

# Backup original (first writer wins the backup)
if [ ! -f "$BACKUP" ] && [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$BACKUP"
fi

# Activate p1 config
cp "$CONFIG_DIR/opencode-p1.json" "$CONFIG_FILE"
echo "[P1] Agent config activated."

# Release lock — config is written, OpenCode only reads now
flock -u 200

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  GI-TCG AI vs AI                    ║"
echo "║  Player 1 (後手) — MiniMax-M2.5     ║"
echo "║  MCP: /api/mcp/1/*                  ║"
echo "╚══════════════════════════════════════╝"
echo ""

opencode --prompt "$(cat "$PROMPT_FILE")"

# Re-acquire lock to safely restore config
echo "[P1] Acquiring lock for config restore..."
if flock -w 10 200; then
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$CONFIG_FILE"
    rm -f "$BACKUP"
    echo "[P1] Config restored."
  else
    echo "[P1] Config already restored by other player."
  fi
  flock -u 200
else
  echo "[P1] WARNING: Could not acquire restore lock (timeout)." >&2
fi
