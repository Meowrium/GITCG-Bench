# GI-TCG AI vs AI: one-click launch both players (Agent mode)
# Usage: .\.opencode\start-both.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$ProjectDir = Split-Path $ScriptDir -Parent
$P0Script = Join-Path $ScriptDir "start-p0.ps1"
$P1Script = Join-Path $ScriptDir "start-p1.ps1"

Write-Host "GI-TCG AI vs AI (Agent Mode) — launching both players..." -ForegroundColor Cyan
Write-Host ""

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue

if ($wt) {
    Write-Host "Using Windows Terminal (split pane)..." -ForegroundColor Green
    
    $wtArgs = @(
        "-w", "0",
        "nt", "--title", "P0 先手 (GLM-5)", "-d", $ProjectDir,
        "powershell", "-NoExit", "-File", $P0Script,
        ";",
        "sp", "-H", "--title", "P1 后手 (MiniMax-M2.5)", "-d", $ProjectDir,
        "powershell", "-NoExit", "-File", $P1Script
    )
    & wt.exe @wtArgs
}
else {
    Write-Host "Windows Terminal not found, using separate PowerShell windows..." -ForegroundColor Yellow
    
    Start-Process powershell -ArgumentList "-NoExit", "-File", $P0Script -WorkingDirectory $ProjectDir
    Start-Sleep -Seconds 2
    Start-Process powershell -ArgumentList "-NoExit", "-File", $P1Script -WorkingDirectory $ProjectDir
}

Write-Host ""
Write-Host "Both agents launched (MCP tools only)!" -ForegroundColor Green
