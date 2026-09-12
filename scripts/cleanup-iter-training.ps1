<# 
  Cleanup iter-training output directory
  =======================================
  
  删除已完成迭代的中间/大文件，只保留推理必需的 artifact。
  
  保留:
    - artifacts/*.ranker-artifact.json   (推理必需)
    - artifacts/*.gbdt-value-artifact.json (推理必需)
    - artifacts/*.gbdt-q-value-artifact.json (推理必需)
    - artifacts/*.value-artifact.json    (线性 value fallback)
    - artifacts/*.bundle.json            (ranker warm-start)
    - artifacts/*.gbdt-value-eval.json   (评估指标, 小文件)
    - self-play-config.json, self-play-result.json (pipeline 日志)
    - pipeline-state.json                (pipeline 状态)
  
  删除 (每个 iter 约节省 2.5-2.7 GB):
    - rl-dataset.json                    (~650-830 MB, 训练后不再需要)
    - self-play-rl/                      (~900 MB, 原始 capture, 已导出)
    - artifacts/*.ranking-dataset.json   (~900 MB, ranker 训练中间数据)
    - artifacts/*.value-dataset.json     (~140 MB, value 训练中间数据)
    - artifacts/*.ranker-eval.json       (~12 MB, 评估详情)
    - artifacts/*.value-eval.json        (~9 MB, 评估详情)
    - replay-logs/                       (~25 MB, 调试用回放)
  
  安全保护:
    - 当前最佳模型所在 iter 目录的 artifact 不会被删除
    - 正在运行的 iter 目录 (有 self-play-rl 但无 rl-dataset) 不会被删除
    - -WhatIf 模式: 默认只显示将删除什么，加 -Execute 才真正执行
  
  Usage:
    cd packages/gi-agent
    pwsh -File ../../scripts/cleanup-iter-training.ps1           # 预览模式
    pwsh -File ../../scripts/cleanup-iter-training.ps1 -Execute  # 实际执行
#>

param(
    [string]$OutputRoot = "./output/iter-training",
    [switch]$Execute = $false
)

$StateFile = Join-Path $OutputRoot "pipeline-state.json"

if (-not (Test-Path $StateFile)) {
    Write-Host "ERROR: pipeline-state.json not found at $StateFile" -ForegroundColor Red
    exit 1
}

$state = Get-Content $StateFile -Raw | ConvertFrom-Json
$currentBestIter = $state.currentBestIteration

# Collect promoted iteration numbers
$promotedIters = @()
foreach ($it in $state.iterations) {
    if ($it.promoted) {
        $promotedIters += $it.iteration
    }
}

Write-Host ""
Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host "  ITER-TRAINING CLEANUP" -ForegroundColor Cyan
Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host ""
Write-Host "  Current best iteration: $currentBestIter"
Write-Host "  Promoted iterations: $($promotedIters -join ', ')"
Write-Host "  Mode: $(if ($Execute) { 'EXECUTE' } else { 'PREVIEW (use -Execute to apply)' })" -ForegroundColor $(if ($Execute) { 'Red' } else { 'Yellow' })
Write-Host ""

# Patterns to delete (relative to each iter dir)
$deleteFilePatterns = @(
    "rl-dataset.json"
    "artifacts\*.ranking-dataset.json"
    "artifacts\*.value-dataset.json"
    "artifacts\*.ranker-eval.json"
    "artifacts\*.value-eval.json"
)

$deleteDirPatterns = @(
    "self-play-rl"
    "replay-logs"
)

$totalFreed = 0
$iterDirs = Get-ChildItem -Path $OutputRoot -Directory -Filter "iter-*" | Sort-Object Name

foreach ($dir in $iterDirs) {
    $dirName = $dir.Name
    $iterNum = if ($dirName -match 'iter-(\d+)') { [int]$Matches[1] } else { continue }
    
    # Skip if this is the currently running iteration
    # (has self-play-rl dir with files but no rl-dataset.json yet)
    $rlDatasetFile = Join-Path $dir.FullName "rl-dataset.json"
    $selfPlayRlDir = Join-Path $dir.FullName "self-play-rl"
    $hasRunningCapture = (Test-Path $selfPlayRlDir) -and (Get-ChildItem $selfPlayRlDir -Recurse -File -Filter "*.rl.json" -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    $isCurrentlyRunning = $hasRunningCapture -and -not (Test-Path $rlDatasetFile)
    
    if ($isCurrentlyRunning) {
        Write-Host "  SKIP $dirName (currently running)" -ForegroundColor Magenta
        continue
    }
    
    $iterFreed = 0
    $isBest = ($iterNum -eq $currentBestIter)
    $isPromoted = $promotedIters -contains $iterNum
    $marker = if ($isBest) { "[BEST]" } elseif ($isPromoted) { "[promoted]" } else { "" }
    
    # Delete files by pattern
    foreach ($pattern in $deleteFilePatterns) {
        $fullPattern = Join-Path $dir.FullName $pattern
        $files = Get-Item -Path $fullPattern -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            $iterFreed += $file.Length
            if ($Execute) {
                Remove-Item $file.FullName -Force
            }
        }
    }
    
    # Delete directories
    foreach ($dirPattern in $deleteDirPatterns) {
        $targetDir = Join-Path $dir.FullName $dirPattern
        if (Test-Path $targetDir) {
            $dirSize = (Get-ChildItem $targetDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
            if ($dirSize) {
                $iterFreed += $dirSize
            }
            if ($Execute) {
                Remove-Item $targetDir -Recurse -Force
            }
        }
    }
    
    $freedMB = [math]::Round($iterFreed / 1MB, 1)
    $freedGB = [math]::Round($iterFreed / 1GB, 2)
    
    if ($iterFreed -gt 0) {
        Write-Host "  $dirName $marker -> ${freedMB} MB" -ForegroundColor $(if ($isBest) { 'Green' } elseif ($isPromoted) { 'DarkGreen' } else { 'Gray' })
    } else {
        Write-Host "  $dirName $marker -> already clean" -ForegroundColor DarkGray
    }
    
    $totalFreed += $iterFreed
}

$totalFreedGB = [math]::Round($totalFreed / 1GB, 2)

Write-Host ""
if ($Execute) {
    Write-Host "  Cleaned up! Freed: ${totalFreedGB} GB" -ForegroundColor Green
} else {
    Write-Host "  Preview: would free ${totalFreedGB} GB" -ForegroundColor Yellow
    Write-Host "  Run with -Execute to apply." -ForegroundColor Yellow
}
Write-Host ""
