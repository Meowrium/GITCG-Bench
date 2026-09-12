<# 
  Iterative Self-Play Training Pipeline
  ======================================
  
  Hardware target: i7-7700HQ, GTX1050, 16GB RAM
  
  Each iteration runs:
    Step 1: Self-play → RL capture files
    Step 2: Export RL dataset
    Step 3: Train slot-linear ranker + linear value (warm-start bundle)
    Step 4: Train GBDT value model (better accuracy)
    Step 5: (Optional) Evaluate trained model vs baseline
  
  Usage:
    cd packages/gi-agent
    pwsh -File ../../scripts/run-iterative-training.ps1 -Iteration 0
    pwsh -File ../../scripts/run-iterative-training.ps1 -Iteration 1
    ...
  
  The script is designed to be re-entrant: if a step already produced
  its output file, it will be skipped.
#>

param(
    [Parameter(Mandatory=$true)]
    [int]$Iteration,

    [int]$MaxIterations = 5,

    [string]$BenchmarkPath = "./benchmark.training-v2.json",

    [string]$OutputRoot = "./output/iter-training",

    # GBDT hyperparameters (tuned for limited hardware)
    [int]$GbdtEstimators = 100,
    [int]$GbdtDepth = 5,
    [double]$GbdtLr = 0.06,
    [int]$GbdtTopFeatures = 48
)

$ErrorActionPreference = "Stop"

# ============================================================
# Derived paths
# ============================================================

$IterDir   = Join-Path $OutputRoot ("iter-{0:D3}" -f $Iteration)
$RlDir     = Join-Path $IterDir "self-play-rl"
$ArtDir    = Join-Path $IterDir "artifacts"
$ConfigDir = $IterDir

# Output files we check to skip completed steps
$SelfPlayConfig   = Join-Path $IterDir "self-play-config.json"
$RlDatasetFile    = Join-Path $IterDir "rl-dataset.json"
$BundleFile       = Join-Path $ArtDir "iter${Iteration}.bundle.json"
$GbdtValueFile    = Join-Path $ArtDir "iter${Iteration}.gbdt-value-artifact.json"
$GbdtEvalFile     = Join-Path $ArtDir "iter${Iteration}.gbdt-value-eval.json"
$RankerFile       = Join-Path $ArtDir "iter${Iteration}.ranker-artifact.json"
$LinearValueFile  = Join-Path $ArtDir "iter${Iteration}.value-artifact.json"
$StateFile        = Join-Path $OutputRoot "pipeline-state.json"

# Resolve previous iteration's best artifacts (if any)
$PrevRankerPath  = $null
$PrevValuePath   = $null

if ($Iteration -gt 0 -and (Test-Path $StateFile)) {
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    if ($state.currentBestRankerPath) {
        $PrevRankerPath = $state.currentBestRankerPath
    }
    if ($state.currentBestValuePath) {
        $PrevValuePath = $state.currentBestValuePath
    }
}

# ============================================================
# Helper: ensure directory exists
# ============================================================
function Ensure-Dir([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

Ensure-Dir $IterDir
Ensure-Dir $RlDir
Ensure-Dir $ArtDir

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  ITERATION $Iteration" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan

# ============================================================
# Step 1: Generate self-play config
# ============================================================

Write-Host "`n[Step 1] Generating self-play config..." -ForegroundColor Yellow

if (-not (Test-Path $SelfPlayConfig)) {
    # Build the policy config – baseline or gi-ml-runtime
    if ($PrevRankerPath) {
        $sideConfig = @{
            name    = "trained-iter$Iteration"
            kind    = "gi-ml-runtime"
            rankerArtifactPath = (Resolve-Path $PrevRankerPath).Path
            options = @{ endTurnPenalty = 5 }
        }
        if ($PrevValuePath) {
            $sideConfig.valueArtifactPath = (Resolve-Path $PrevValuePath).Path
        }
    } else {
        $sideConfig = @{
            name    = "baseline"
            kind    = "baseline"
            options = @{ endTurnPenalty = 5 }
        }
    }

    $config = @{
        benchmarkPath = (Resolve-Path $BenchmarkPath).Path
        gamesMultiplier = 1
        rlCapture = @{
            directory       = (Join-Path (Resolve-Path $IterDir).Path "self-play-rl")
            modelVersion    = "iter-$Iteration"
            viewKind        = "policy_public"
            gameVersion     = "v6.3.0"
            cardPoolVersion = "v6.3.0"
            rulesetVersion  = "default"
            contractVersion = "obs.v1"
        }
        replayLogCapture = @{
            directory          = (Join-Path (Resolve-Path $IterDir).Path "replay-logs")
            maxGamesPerMatchup = 2
        }
        dataset = @{
            outputPath           = (Join-Path (Resolve-Path $IterDir).Path "rl-dataset.json")
            includeSides         = @(0, 1)
            requireChosenCandidate = $true
        }
        sideA = $sideConfig
        sideB = $sideConfig
        outputPath = (Join-Path (Resolve-Path $IterDir).Path "self-play-result.json")
    }

    $config | ConvertTo-Json -Depth 10 | Set-Content $SelfPlayConfig -Encoding UTF8
    Write-Host "  Config written: $SelfPlayConfig"
} else {
    Write-Host "  Config already exists, skipping."
}

# ============================================================
# Step 2: Run self-play (this is the long step)
# ============================================================

Write-Host "`n[Step 2] Running self-play..." -ForegroundColor Yellow

if (-not (Test-Path $RlDatasetFile)) {
    Write-Host "  Starting self-play... (this may take 30-60 min per 100 games)" -ForegroundColor Magenta
    Write-Host "  Policy: $(if ($PrevRankerPath) { 'gi-ml-runtime (iter ' + ($Iteration - 1) + ')' } else { 'baseline' })"
    Write-Host ""
    
    # Run with --expose-gc so we can GC between games
    bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts $SelfPlayConfig
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Self-play failed with exit code $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
    
    if (-not (Test-Path $RlDatasetFile)) {
        Write-Host "  Warning: RL dataset not found after self-play. Check output." -ForegroundColor Red
        exit 1
    }
    Write-Host "  Self-play complete. Dataset: $RlDatasetFile"
} else {
    Write-Host "  RL dataset already exists, skipping."
}

# ============================================================
# Step 3: Train ranker + linear value (warm-start bundle)
# ============================================================

Write-Host "`n[Step 3] Training ranker + linear value..." -ForegroundColor Yellow

if (-not (Test-Path $BundleFile)) {
    $AbsRlDataset = (Resolve-Path $RlDatasetFile).Path
    $AbsArtDir    = (Resolve-Path $ArtDir).Path
    Push-Location ../gi-ml
    
    bun run ./src/cli/run-build-rl-warm-start-bundle.ts `
        --input $AbsRlDataset `
        --output-dir $AbsArtDir `
        --prefix "iter${Iteration}" `
        --top-tags 32 `
        --top-candidate-slots 24 `
        --top-features 32
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Warm-start bundle failed." -ForegroundColor Red
        Pop-Location
        exit 1
    }
    
    Pop-Location
    Write-Host "  Bundle complete."
} else {
    Write-Host "  Bundle already exists, skipping."
}

# ============================================================
# Step 4: Train GBDT value model
# ============================================================

Write-Host "`n[Step 4] Training GBDT value model..." -ForegroundColor Yellow

if (-not (Test-Path $GbdtValueFile)) {
    $AbsRlDataset = (Resolve-Path $RlDatasetFile).Path
    $AbsArtDir    = (Resolve-Path $ArtDir).Path
    Push-Location ../gi-ml
    
    bun run ./src/cli/run-build-gbdt-value.ts `
        --input $AbsRlDataset `
        --output-dir $AbsArtDir `
        --prefix "iter${Iteration}" `
        --estimators $GbdtEstimators `
        --depth $GbdtDepth `
        --lr $GbdtLr `
        --top-features $GbdtTopFeatures
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  GBDT training failed." -ForegroundColor Red
        Pop-Location
        exit 1
    }
    
    Pop-Location
    Write-Host "  GBDT value training complete."
} else {
    Write-Host "  GBDT value artifact already exists, skipping."
}

# ============================================================
# Step 5: Update pipeline state
# ============================================================

Write-Host "`n[Step 5] Updating pipeline state..." -ForegroundColor Yellow

# Read evaluation metrics
$rankerPairwise = $null
$valueMae = $null
$valueRmse = $null

if (Test-Path $BundleFile) {
    $bundle = Get-Content $BundleFile -Raw | ConvertFrom-Json
    $rankerPairwise = $bundle.metrics.ranking.pairwise_support_rate
}

if (Test-Path $GbdtEvalFile) {
    $gbdtEval = Get-Content $GbdtEvalFile -Raw | ConvertFrom-Json
    $valueMae  = $gbdtEval.mae
    $valueRmse = $gbdtEval.rmse
}

# Decide promotion
$promoted = $false
$minPairwise = 0.55
$minMaeImprovement = 0.01

if ($null -eq $PrevRankerPath) {
    # First iteration: promote if ranker is reasonable
    if ($rankerPairwise -and $rankerPairwise -ge $minPairwise) {
        $promoted = $true
    }
} else {
    # Check improvement over previous best
    if ((Test-Path $StateFile)) {
        $prevState = Get-Content $StateFile -Raw | ConvertFrom-Json
        $prevBest = $prevState.iterations | Where-Object { $_.promoted -eq $true } | Select-Object -Last 1
        if ($prevBest -and $prevBest.valueMetrics.mae) {
            $improvement = $prevBest.valueMetrics.mae - $valueMae
            if ($improvement -ge $minMaeImprovement -and $rankerPairwise -ge $minPairwise) {
                $promoted = $true
            }
        } else {
            $promoted = $true
        }
    } else {
        $promoted = $true
    }
}

# Prefer GBDT value artifact, fall back to linear
$bestValuePath = $GbdtValueFile
if (-not (Test-Path $GbdtValueFile)) {
    $bestValuePath = $LinearValueFile
}

# Update state file
$iterResult = @{
    iteration     = $Iteration
    rankerMetrics = @{ pairwiseSupport = $rankerPairwise }
    valueMetrics  = @{ mae = $valueMae; rmse = $valueRmse }
    promoted      = $promoted
    artifactPaths = @{
        ranker = (Resolve-Path $RankerFile).Path
        value  = (Resolve-Path $bestValuePath).Path
    }
}

if (Test-Path $StateFile) {
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
} else {
    $state = @{
        currentBestIteration  = $null
        currentBestRankerPath = $null
        currentBestValuePath  = $null
        iterations            = @()
        startedAt             = (Get-Date -Format o)
    }
}

# Convert iterations to mutable array if needed
$iterations = [System.Collections.ArrayList]@()
if ($state.iterations) {
    foreach ($it in $state.iterations) {
        [void]$iterations.Add($it)
    }
}
[void]$iterations.Add($iterResult)
$state.iterations = $iterations

if ($promoted) {
    $state.currentBestIteration  = $Iteration
    $state.currentBestRankerPath = (Resolve-Path $RankerFile).Path
    $state.currentBestValuePath  = (Resolve-Path $bestValuePath).Path
}
$state.lastUpdatedAt = (Get-Date -Format o)

$state | ConvertTo-Json -Depth 10 | Set-Content $StateFile -Encoding UTF8

# ============================================================
# Summary
# ============================================================

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  ITERATION $Iteration COMPLETE" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""
Write-Host "  Ranker pairwise support: $rankerPairwise"
Write-Host "  Value MAE (GBDT):        $valueMae"
Write-Host "  Value RMSE (GBDT):       $valueRmse"

if ($promoted) {
    Write-Host "  Status: PROMOTED" -ForegroundColor Green
    Write-Host "  Best ranker: $(Resolve-Path $RankerFile)"
    Write-Host "  Best value:  $(Resolve-Path $bestValuePath)"
} else {
    Write-Host "  Status: NOT PROMOTED (keeping previous best)" -ForegroundColor Yellow
}

Write-Host ""
if ($Iteration -lt ($MaxIterations - 1)) {
    $nextIter = $Iteration + 1
    Write-Host "Next iteration:" -ForegroundColor Cyan
    Write-Host "  pwsh -File ../../scripts/run-iterative-training.ps1 -Iteration $nextIter"
} else {
    Write-Host "All iterations complete!" -ForegroundColor Green
}
