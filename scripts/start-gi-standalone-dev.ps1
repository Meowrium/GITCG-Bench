param()

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:MCP_HTTP_API_TOKEN)) {
  Write-Error "MCP_HTTP_API_TOKEN is not set. Run scripts/ensure-gi-mcp-token.ps1 first, then restart VS Code or this shell."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$standaloneDir = Join-Path $repoRoot "packages/standalone"

Set-Location $standaloneDir
Write-Host "Starting standalone dev server with protected MCP HTTP API..." -ForegroundColor Cyan
bun run dev
