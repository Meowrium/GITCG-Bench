# Watch the training pipeline and stop it after a specific iteration completes.
# Usage: pwsh -File watch-and-stop-at-iter.ps1 -TargetIteration 264 -MainProcessId 10508

param(
    [int]$TargetIteration = 264,
    [int]$MainProcessId = 10508,
    [int]$PollIntervalSec = 15
)

$IterDir = Join-Path $PSScriptRoot "..\packages\gi-agent\output\iter-training\iter-$TargetIteration"
$EvalResultFile = Join-Path $IterDir "eval-winrate-result.json"
$RankerArtifact = Join-Path $IterDir "artifacts\iter${TargetIteration}.ranker-artifact.json"

# Signals that the iteration is fully done:
# 1. eval-winrate-result.json appears (benchmark finished)
# 2. eval-winrate-result.json is then DELETED by the main script (it read and processed it)
# 3. OR: main process itself exits
# We detect completion by: eval result appears AND then gets cleaned up,
# OR by checking that artifacts are finalized and the main script moved on.

Write-Host "=== Watch-and-Stop ===" -ForegroundColor Cyan
Write-Host "  Target iteration: $TargetIteration"
Write-Host "  Main process PID: $MainProcessId"
Write-Host "  Iter dir:         $IterDir"
Write-Host "  Polling every ${PollIntervalSec}s"
Write-Host ""

$phase = "waiting_benchmark"
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($true) {
    $mainProc = Get-Process -Id $MainProcessId -ErrorAction SilentlyContinue
    if (-not $mainProc) {
        Write-Host "[$([math]::Round($sw.Elapsed.TotalMinutes,1))min] Main process ($MainProcessId) has exited." -ForegroundColor Green
        break
    }

    switch ($phase) {
        "waiting_benchmark" {
            # Phase 1: Wait for eval-winrate-result.json to appear
            if (Test-Path $EvalResultFile) {
                Write-Host "[$([math]::Round($sw.Elapsed.TotalMinutes,1))min] Eval result file appeared! Benchmark finished." -ForegroundColor Green
                $phase = "waiting_cleanup"
            } else {
                Write-Host "[$([math]::Round($sw.Elapsed.TotalMinutes,1))min] Waiting for benchmark to finish... (eval result not yet)"
            }
        }

        "waiting_cleanup" {
            # Phase 2: Wait for main script to process the result (it deletes the file after reading)
            if (-not (Test-Path $EvalResultFile)) {
                Write-Host "[$([math]::Round($sw.Elapsed.TotalMinutes,1))min] Eval result file cleaned up - iteration $TargetIteration completed!" -ForegroundColor Green
                $phase = "stopping"
            } else {
                Write-Host "[$([math]::Round($sw.Elapsed.TotalMinutes,1))min] Eval result exists, waiting for main script to process it..."
            }
        }

        "stopping" {
            # Phase 3: Stop the main process
            break
        }
    }

    if ($phase -eq "stopping") {
        break
    }

    Start-Sleep -Seconds $PollIntervalSec
}

# Stop the main process
$mainProc = Get-Process -Id $MainProcessId -ErrorAction SilentlyContinue
if ($mainProc) {
    Write-Host ""
    Write-Host "Stopping main process (PID $MainProcessId)..." -ForegroundColor Yellow
    # Send CTRL+C via taskkill to allow graceful shutdown
    taskkill /PID $MainProcessId /T
    Start-Sleep -Seconds 3
    $mainProc = Get-Process -Id $MainProcessId -ErrorAction SilentlyContinue
    if ($mainProc) {
        Write-Host "Process still running, force killing..." -ForegroundColor Red
        Stop-Process -Id $MainProcessId -Force
    }
    Write-Host "Main process stopped." -ForegroundColor Green
} else {
    Write-Host "Main process already exited." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
