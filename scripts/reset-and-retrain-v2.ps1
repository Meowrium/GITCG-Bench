<#
  Reset & Retrain Script (v2 — 67-dim features)
  ===============================================
  
  清除旧 54 维训练 artifact，从 baseline 重新开始训练。
  
  适用场景：feature-extractor 特征维度从 54→67 后，旧模型不兼容，需要全新迭代。
  
  Usage (从 packages/gi-agent/ 目录运行):
    cd packages/gi-agent
    pwsh -File ../../scripts/reset-and-retrain-v2.ps1
#>

$ErrorActionPreference = "Stop"
$OutputRoot = "./output/iter-training"
$StateFile  = Join-Path $OutputRoot "pipeline-state.json"
$BackupDir  = "./output/iter-training-v1-backup"
$Timestamp  = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  RESET TRAINING PIPELINE (v1 54-dim -> v2 67-dim)" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""

# ============================================================
# Step 1: 备份旧 pipeline-state.json
# ============================================================

if (Test-Path $StateFile) {
    $backupName = "pipeline-state.v1-backup-${Timestamp}.json"
    $backupPath = Join-Path $OutputRoot $backupName
    Copy-Item $StateFile $backupPath
    Write-Host "[1/3] Backed up pipeline-state.json -> $backupName" -ForegroundColor Green
} else {
    Write-Host "[1/3] No pipeline-state.json found, nothing to backup." -ForegroundColor Yellow
}

# ============================================================
# Step 2: 归档旧迭代目录 (移动到 backup 目录)
# ============================================================

Write-Host ""
Write-Host "[2/3] Archiving old iteration directories..." -ForegroundColor Yellow

if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

$oldIters = Get-ChildItem -Path $OutputRoot -Directory -Filter "iter-*" -ErrorAction SilentlyContinue
if ($oldIters.Count -gt 0) {
    foreach ($dir in $oldIters) {
        $dest = Join-Path $BackupDir $dir.Name
        if (Test-Path $dest) {
            Write-Host "  Skip (already archived): $($dir.Name)" -ForegroundColor DarkGray
        } else {
            Move-Item $dir.FullName $dest
            Write-Host "  Moved: $($dir.Name) -> $BackupDir/$($dir.Name)" -ForegroundColor Green
        }
    }
    Write-Host "  Archived $($oldIters.Count) iteration directories." -ForegroundColor Green
} else {
    Write-Host "  No iteration directories found to archive." -ForegroundColor Yellow
}

# ============================================================
# Step 3: 删除旧 pipeline-state.json (让训练从 baseline 开始)
# ============================================================

Write-Host ""
if (Test-Path $StateFile) {
    Remove-Item $StateFile -Force
    Write-Host "[3/3] Removed pipeline-state.json — next training starts from BASELINE." -ForegroundColor Green
} else {
    Write-Host "[3/3] pipeline-state.json already absent." -ForegroundColor Yellow
}

# ============================================================
# Summary
# ============================================================

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  RESET COMPLETE" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""
Write-Host "  Old data archived to: $BackupDir"
Write-Host "  pipeline-state.json:  REMOVED"
Write-Host ""
Write-Host "  Next step: run the training pipeline with new parameters:" -ForegroundColor Yellow
Write-Host ""
Write-Host '  pwsh -File ../../scripts/run-multi-iteration-training.ps1 `' -ForegroundColor White
Write-Host '    -StartIteration 100 `' -ForegroundColor White
Write-Host '    -EndIteration 130 `' -ForegroundColor White
Write-Host '    -GamesMultiplier 2 `' -ForegroundColor White
Write-Host '    -Concurrency 2 `' -ForegroundColor White
Write-Host '    -ValueBackend "lgbm"' -ForegroundColor White
Write-Host ""
Write-Host "  First iteration (100) will use BASELINE policy (no prior model)." -ForegroundColor Green
Write-Host "  Subsequent iterations auto-promote the best model." -ForegroundColor Green
Write-Host ""
