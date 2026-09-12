param(
  [string]$BaseUrl = "http://localhost:3901",
  [ValidateSet("fragmented-decision", "direct-action")]
  [string]$ToolExposureMode = "fragmented-decision"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:MCP_HTTP_API_TOKEN)) {
  Write-Error "MCP_HTTP_API_TOKEN is not set. Run scripts/ensure-gi-mcp-token.ps1 first, then restart VS Code or this shell."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$mcpDir = Join-Path $repoRoot "packages/mcp"

Set-Location $mcpDir
Write-Host "Starting standalone MCP server..." -ForegroundColor Cyan
bun run standalone-mcp.ts --tool-exposure-mode $ToolExposureMode --url $BaseUrl
