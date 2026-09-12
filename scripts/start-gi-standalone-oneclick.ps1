param(
  [string]$BaseUrl = "http://localhost:3901"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$ensureScript = Join-Path $PSScriptRoot "ensure-gi-mcp-token.ps1"
$standaloneDir = Join-Path $repoRoot "packages/standalone"

if (-not (Test-Path $ensureScript)) {
  Write-Error "Missing token helper script: $ensureScript"
}

& $ensureScript | Out-Host

$token = $env:MCP_HTTP_API_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  $token = [Environment]::GetEnvironmentVariable("MCP_HTTP_API_TOKEN", "User")
  if (-not [string]::IsNullOrWhiteSpace($token)) {
    $env:MCP_HTTP_API_TOKEN = $token
  }
}

if ([string]::IsNullOrWhiteSpace($env:MCP_HTTP_API_TOKEN)) {
  Write-Error "MCP_HTTP_API_TOKEN is still unavailable after ensure-gi-mcp-token.ps1."
}

$uri = [System.Uri]$BaseUrl
$port = if ($uri.IsDefaultPort) { 3901 } else { $uri.Port }
$hostName = if ([string]::IsNullOrWhiteSpace($uri.Host)) { "localhost" } else { $uri.Host }
$finalUrl = "http://$hostName`:$port"

$env:PORT = [string]$port
$env:VITE_DEV_PORT = [string]$port

Set-Location $standaloneDir

Write-Host "Protected standalone dev server will start now." -ForegroundColor Cyan
Write-Host "Open this URL in your browser: $finalUrl" -ForegroundColor Green
Write-Host "If VS Code was opened before the token was created or rotated, restart VS Code before using MCP." -ForegroundColor Yellow

bunx --bun vite --host $hostName --strictPort --port $port
