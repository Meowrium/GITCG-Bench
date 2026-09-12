# V30 Stage 3 — KPI-B end-to-end runner
#
# Usage (from packages/gi-agent):
#   .\scripts\run_v30_stage3.ps1 -Profile 2k    # smoke (~1.5h self-play + ~30min train)
#   .\scripts\run_v30_stage3.ps1 -Profile 5k    # full  (~4h self-play + ~1h train)
#   .\scripts\run_v30_stage3.ps1 -Profile 2k -SkipSelfPlay        # reuse existing samples.sqlite
#   .\scripts\run_v30_stage3.ps1 -Profile 2k -RegularizeStrong    # use small model + strong dropout
#
# Idempotent: each step checks for its expected output and skips if present.

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet("2k","5k")] [string]$Profile,
  [switch]$SkipSelfPlay,
  [switch]$SkipExport,
  [switch]$SkipTrain,
  [switch]$RegularizeStrong,
  [ValidateSet("none","gi-v30")] [string]$Reweight = "none",
  [int]$Epochs = 30,
  [int]$BatchSize = 128
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path "."
$pyDir = Resolve-Path "..\gi-ml\python"
$outDir = "examples\output\v30-stage3-$Profile"
$dbPath = "$outDir\samples.sqlite"
$datasetDir = "$outDir\dataset"
$weightsPath = "$outDir\encoder-weights.json"
$reportPath = "$outDir\encoder-report.json"
$selfplayConfig = "examples/configs/self-play.v30-stage3-$Profile.json"

Write-Host "── V30 Stage 3 runner — profile=$Profile ──" -ForegroundColor Cyan
Write-Host "  outDir       : $outDir"
Write-Host "  selfplay cfg : $selfplayConfig"

# ── Step 1: self-play ────────────────────────────────────────────────────────
if (-not $SkipSelfPlay) {
  if (Test-Path $dbPath) {
    Write-Host "[step1] Removing existing $dbPath" -ForegroundColor Yellow
    Remove-Item -Force $dbPath
    Remove-Item -Force "$dbPath-wal" -ErrorAction SilentlyContinue
    Remove-Item -Force "$dbPath-shm" -ErrorAction SilentlyContinue
  }
  Write-Host "[step1] Running self-play (this can take 1.5-4 hours)..." -ForegroundColor Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()
  pnpm run self-play $selfplayConfig --enable-feature-extension --enable-state-observation
  if ($LASTEXITCODE -ne 0) { throw "self-play failed with exit $LASTEXITCODE" }
  $sw.Stop()
  Write-Host "[step1] done in $([math]::Round($sw.Elapsed.TotalMinutes, 1)) min" -ForegroundColor Green
} else {
  Write-Host "[step1] SKIPPED (--SkipSelfPlay)" -ForegroundColor Yellow
}

# Verify samples
$summary = node -e @"
const Database = require('better-sqlite3');
const db = new Database('$($dbPath -replace '\\','/')');
const r = db.prepare('SELECT COUNT(*) total, COUNT(state_observation) with_obs, COUNT(DISTINCT game_id) games FROM samples').get();
console.log(JSON.stringify(r));
db.close();
"@
$stats = $summary | ConvertFrom-Json
Write-Host "[verify] total=$($stats.total) with_state_obs=$($stats.with_obs) unique_games=$($stats.games)" -ForegroundColor Cyan
if ($stats.with_obs -lt 1) {
  throw "No state_observation samples present — re-run with --enable-state-observation"
}
if ($stats.games -lt 500) {
  Write-Host "⚠ Only $($stats.games) unique games — overfitting likely. Consider 5k profile." -ForegroundColor Yellow
}

# ── Step 2: export NDJSON ────────────────────────────────────────────────────
if (-not $SkipExport) {
  Write-Host "[step2] Exporting NDJSON dataset (reweight=$Reweight)..." -ForegroundColor Cyan
  pnpm run encoder:export-dataset $dbPath $datasetDir --test-fraction 0.2 --seed 17 --reweight $Reweight
  if ($LASTEXITCODE -ne 0) { throw "encoder:export-dataset failed" }
} else {
  Write-Host "[step2] SKIPPED (--SkipExport)" -ForegroundColor Yellow
}

# ── Step 3: train encoder ────────────────────────────────────────────────────
if (-not $SkipTrain) {
  $env:PYTHONPATH = $pyDir.Path
  Write-Host "[step3] Training encoder (epochs=$Epochs, batch=$BatchSize, regularize=$RegularizeStrong)..." -ForegroundColor Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()

  $args = @(
    "-m", "gitcg_ml.train_v30_encoder",
    "--train", "$datasetDir/train.ndjson",
    "--val",   "$datasetDir/test.ndjson",
    "--out",   $weightsPath,
    "--report", $reportPath,
    "--epochs", "$Epochs",
    "--batch-size", "$BatchSize",
    "--lr", "5e-4",
    "--cpu"
  )
  if ($RegularizeStrong) {
    $args += @(
      "--hidden-dim", "64",
      "--embed-dim", "16",
      "--dropout", "0.3",
      "--weight-decay", "1e-3",
      "--v-head-weight", "0.2"
    )
  } else {
    $args += @(
      "--hidden-dim", "128",
      "--embed-dim", "32",
      "--dropout", "0.1",
      "--weight-decay", "1e-4"
    )
  }

  python @args
  if ($LASTEXITCODE -ne 0) { throw "trainer failed with exit $LASTEXITCODE" }
  $sw.Stop()
  Write-Host "[step3] done in $([math]::Round($sw.Elapsed.TotalMinutes, 1)) min" -ForegroundColor Green
} else {
  Write-Host "[step3] SKIPPED (--SkipTrain)" -ForegroundColor Yellow
}

# ── Step 4: KPI-B verdict ────────────────────────────────────────────────────
Write-Host "`n[step4] KPI-B verdict ────────────────────────────────────" -ForegroundColor Cyan
pnpm exec gnx scripts/v30_kpib_verdict.ts $reportPath
