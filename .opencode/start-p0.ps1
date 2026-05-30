# GI-TCG AI vs AI: Player 0 (先手) — Dedicated Agent
# Usage: .\.opencode\start-p0.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$ProjectDir = Split-Path $ScriptDir -Parent

Set-Location $ProjectDir

Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  GI-TCG AI vs AI — Agent: gi-tcg-p0  ║" -ForegroundColor Cyan
Write-Host "║  Player 0 (先手) — GLM-5             ║" -ForegroundColor Cyan
Write-Host "║  Tools: MCP only — no fs/terminal    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

opencode --agent gi-tcg-p0 --prompt "开始对局"
