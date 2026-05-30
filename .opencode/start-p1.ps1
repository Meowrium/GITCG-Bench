# GI-TCG AI vs AI: Player 1 (后手) — Dedicated Agent
# Usage: .\.opencode\start-p1.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$ProjectDir = Split-Path $ScriptDir -Parent

Set-Location $ProjectDir

Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║  GI-TCG AI vs AI — Agent: gi-tcg-p1  ║" -ForegroundColor Magenta
Write-Host "║  Player 1 (后手) — MiniMax-M2.5      ║" -ForegroundColor Magenta
Write-Host "║  Tools: MCP only — no fs/terminal    ║" -ForegroundColor Magenta
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""

opencode --agent gi-tcg-p1 --prompt "开始对局"
