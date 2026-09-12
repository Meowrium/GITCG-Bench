<#
  Run all iterations of the training pipeline sequentially.
  
  Usage:
    cd packages/gi-agent
    pwsh -File ../../scripts/run-all-iterations.ps1
    pwsh -File ../../scripts/run-all-iterations.ps1 -MaxIterations 3
#>

param(
    [int]$MaxIterations = 5,
    [string]$BenchmarkPath = "./benchmark.training-v2.json",
    [string]$OutputRoot = "./output/iter-training"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  ITERATIVE SELF-PLAY TRAINING PIPELINE" -ForegroundColor Cyan
Write-Host "  Iterations: 0..$($MaxIterations - 1)" -ForegroundColor Cyan
Write-Host "  Benchmark:  $BenchmarkPath" -ForegroundColor Cyan
Write-Host "  Output:     $OutputRoot" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""

# Memory check
$mem = (Get-CimInstance Win32_OperatingSystem)
$freeGB = [math]::Round($mem.FreePhysicalMemory / 1MB, 1)
Write-Host "Available memory: ${freeGB} GB" -ForegroundColor DarkGray

if ($freeGB -lt 4) {
    Write-Host "WARNING: Less than 4 GB free. Consider closing other applications." -ForegroundColor Red
    Write-Host "Press Enter to continue or Ctrl+C to abort..."
    Read-Host
}

for ($i = 0; $i -lt $MaxIterations; $i++) {
    Write-Host "`n"
    & pwsh -File (Join-Path $ScriptDir "run-iterative-training.ps1") `
        -Iteration $i `
        -MaxIterations $MaxIterations `
        -BenchmarkPath $BenchmarkPath `
        -OutputRoot $OutputRoot
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`nIteration $i failed. Stopping pipeline." -ForegroundColor Red
        exit 1
    }
    
    # Brief pause + GC hint between iterations
    Write-Host "`nPausing 5s between iterations for memory cleanup..." -ForegroundColor DarkGray
    [System.GC]::Collect()
    Start-Sleep -Seconds 5
}

Write-Host "`n"
Write-Host ("=" * 70) -ForegroundColor Green
Write-Host "  ALL ITERATIONS COMPLETE" -ForegroundColor Green
Write-Host ("=" * 70) -ForegroundColor Green

# Final summary
$stateFile = Join-Path $OutputRoot "pipeline-state.json"
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    Write-Host "`nBest iteration: $($state.currentBestIteration ?? 'none (baseline)')"
    if ($state.currentBestRankerPath) {
        Write-Host "Best ranker:    $($state.currentBestRankerPath)"
    }
    if ($state.currentBestValuePath) {
        Write-Host "Best value:     $($state.currentBestValuePath)"
    }
    
    Write-Host "`nIteration History:"
    foreach ($iter in $state.iterations) {
        $flag = if ($iter.promoted) { "[PROMOTED]" } else { "          " }
        $mae = if ($iter.valueMetrics.mae) { $iter.valueMetrics.mae.ToString("F4") } else { "N/A" }
        $pw = if ($iter.rankerMetrics.pairwiseSupport) { $iter.rankerMetrics.pairwiseSupport.ToString("F4") } else { "N/A" }
        Write-Host "  $flag iter=$($iter.iteration)  MAE=$mae  pairwise=$pw"
    }
}
