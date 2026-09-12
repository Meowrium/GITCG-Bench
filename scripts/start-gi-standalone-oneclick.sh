#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
base_url="${1:-http://localhost:3901}"

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\r\n'
    return
  fi

  if command -v bun >/dev/null 2>&1; then
    bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
    return
  fi

  if command -v python >/dev/null 2>&1; then
    python - <<'PY'
import base64, os
print(base64.b64encode(os.urandom(32)).decode('ascii'))
PY
    return
  fi

  echo "Unable to generate MCP_HTTP_API_TOKEN automatically. Install openssl, bun, or python." >&2
  exit 1
}

load_user_token_from_powershell() {
  local shell_bin
  for shell_bin in powershell.exe pwsh.exe; do
    if command -v "$shell_bin" >/dev/null 2>&1; then
      MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$shell_bin" -NoProfile -Command "[Environment]::GetEnvironmentVariable('MCP_HTTP_API_TOKEN','User')" 2>/dev/null | tr -d '\r\n'
      return 0
    fi
  done
  return 1
}

save_user_token_to_powershell() {
  local token="$1"
  local shell_bin
  for shell_bin in powershell.exe pwsh.exe; do
    if command -v "$shell_bin" >/dev/null 2>&1; then
      MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$shell_bin" -NoProfile -Command "[Environment]::SetEnvironmentVariable('MCP_HTTP_API_TOKEN','$token','User')" >/dev/null 2>&1 || true
      return 0
    fi
  done
  return 1
}

if [[ -z "${MCP_HTTP_API_TOKEN:-}" ]]; then
  user_token="$(load_user_token_from_powershell || true)"
  if [[ -n "$user_token" ]]; then
    export MCP_HTTP_API_TOKEN="$user_token"
  fi
fi

if [[ -z "${MCP_HTTP_API_TOKEN:-}" ]]; then
  export MCP_HTTP_API_TOKEN="$(generate_token)"
  save_user_token_to_powershell "$MCP_HTTP_API_TOKEN" || true
  echo "MCP_HTTP_API_TOKEN was generated for this session." >&2
  echo "Restart VS Code if it was opened before this token was created." >&2
fi

host_part="localhost"
port_part="3901"
if [[ "$base_url" =~ ^https?://([^/:]+):([0-9]+)$ ]]; then
  host_part="${BASH_REMATCH[1]}"
  port_part="${BASH_REMATCH[2]}"
fi

export PORT="$port_part"
export VITE_DEV_PORT="$port_part"

echo "Protected standalone dev server will start now."
echo "Open this URL in your browser: http://$host_part:$port_part"

cd "$repo_root/packages/standalone"
exec bunx --bun vite --host "$host_part" --strictPort --port "$port_part"
