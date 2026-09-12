param(
  [switch]$Rotate,
  [switch]$SessionOnly
)

$ErrorActionPreference = "Stop"

function New-McpToken {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes)
}

$token = $null

if (-not $Rotate) {
  $token = [Environment]::GetEnvironmentVariable("MCP_HTTP_API_TOKEN", "User")
  if ([string]::IsNullOrWhiteSpace($token)) {
    $token = $env:MCP_HTTP_API_TOKEN
  }
}

if ([string]::IsNullOrWhiteSpace($token)) {
  $token = New-McpToken
}

$env:MCP_HTTP_API_TOKEN = $token

if (-not $SessionOnly) {
  [Environment]::SetEnvironmentVariable("MCP_HTTP_API_TOKEN", $token, "User")
}

Write-Host "MCP_HTTP_API_TOKEN is ready." -ForegroundColor Green
if ($SessionOnly) {
  Write-Host "Applied to current PowerShell session only." -ForegroundColor Yellow
} else {
  Write-Host "Saved to Windows user environment." -ForegroundColor Yellow
  Write-Host "Restart VS Code after rotating or creating the token." -ForegroundColor Yellow
}
