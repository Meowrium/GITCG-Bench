# Copyright (C) 2024-2025 Guyutongxue
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

param(
  [switch]$GenerateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$giAgentDir = Join-Path $repoRoot "packages/gi-agent"
$giMlDir = Join-Path $repoRoot "packages/gi-ml"

$benchmarkExamplePath = Join-Path $giAgentDir "benchmark.example.json"
$defaultBenchmarkVersion = if (Test-Path $benchmarkExamplePath) {
  ((Get-Content $benchmarkExamplePath -Raw | ConvertFrom-Json).version)
} else {
  "v6.3.0"
}

# =========================
# Adjustable Parameters
# Only edit this block.
# =========================
$BenchmarkVersion = $defaultBenchmarkVersion
$DeckFilePath = Join-Path $giAgentDir "trio_deck.txt"
$OutputRoot = Join-Path $giMlDir "output/trio-benchmark"

$PolicyKind = "baseline"        # "baseline" or "evaluator"
$WeightsPath = Join-Path $giAgentDir "prior-v2/prior-v2/output/weights.iteration.json"
$EndTurnPenalty = 5
$LearnedScoreScale = 10

$IncludeMirrors = $false
$IncludeReverse = $true
$GamesPerMatchup = 12
$BenchmarkConcurrency = 2
$SampleLogsPerMatchup = 4

$BranchEvalSampleCount = 6
$MinLegalActions = 3
$MaxBranchesPerPoint = 4
$ContinuationGamesPerBranch = 3

$TopTags = 32
$TopCandidateSlots = 24
# =========================
# End Adjustable Parameters
# =========================

$runBenchmark = -not $GenerateOnly
$runBranchEval = -not $GenerateOnly
$runMlPipeline = -not $GenerateOnly

function Parse-TrioDeckFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $result = @()
  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
      continue
    }
    if ($trimmed -notmatch '^(?<index>\d+)\s+(?<name>\S+)\s+(?<deckCode>\S+)$') {
      throw "Unsupported deck line format: $trimmed"
    }
    $result += [pscustomobject]@{
      index = [int]$Matches.index
      id = $Matches.name
      name = $Matches.name
      deckCode = $Matches.deckCode
    }
  }
  return $result
}

function Build-Matchups {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$Decks,
    [bool]$IncludeMirrors,
    [bool]$IncludeReverse
  )

  $result = @()
  for ($i = 0; $i -lt $Decks.Count; $i += 1) {
    $deck0 = $Decks[$i]
    $start = if ($IncludeMirrors) { $i } else { $i + 1 }
    for ($j = $start; $j -lt $Decks.Count; $j += 1) {
      $deck1 = $Decks[$j]
      $result += [pscustomobject]@{
        id = "$($deck0.id)-vs-$($deck1.id)"
        deck0 = $deck0
        deck1 = $deck1
      }
      if ($IncludeReverse -and $i -ne $j) {
        $result += [pscustomobject]@{
          id = "$($deck1.id)-vs-$($deck0.id)"
          deck0 = $deck1
          deck1 = $deck0
        }
      }
    }
  }
  return $result
}

function New-PolicyConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SideLabel
  )

  if ($PolicyKind -eq "evaluator") {
    return [ordered]@{
      name = "$SideLabel-evaluator"
      kind = "evaluator"
      weightsPath = $WeightsPath
      options = [ordered]@{
        learnedScoreScale = $LearnedScoreScale
      }
    }
  }

  return [ordered]@{
    name = "$SideLabel-baseline"
    kind = "baseline"
    options = [ordered]@{
      endTurnPenalty = $EndTurnPenalty
    }
  }
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [object]$Value
  )

  $parent = Split-Path $Path -Parent
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $json = $Value | ConvertTo-Json -Depth 100
  Set-Content -Path $Path -Value "$json`n" -Encoding UTF8
}

if (-not (Test-Path $DeckFilePath)) {
  throw "Deck file not found: $DeckFilePath"
}

if ($PolicyKind -eq "evaluator" -and -not (Test-Path $WeightsPath)) {
  throw "Evaluator weights not found: $WeightsPath"
}

$configDir = Join-Path $OutputRoot "configs"
$branchEvalConfigDir = Join-Path $configDir "branch-eval"
$benchmarkOutputDir = Join-Path $OutputRoot "benchmark"
$branchEvalOutputDir = Join-Path $OutputRoot "branch-eval"
$mlOutputDir = Join-Path $OutputRoot "ml"
$sampleReplayDir = Join-Path $OutputRoot "replay-samples"

foreach ($dir in @(
  $OutputRoot,
  $configDir,
  $branchEvalConfigDir,
  $benchmarkOutputDir,
  $branchEvalOutputDir,
  $mlOutputDir,
  $sampleReplayDir
)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$decks = Parse-TrioDeckFile -Path $DeckFilePath
if ($decks.Count -lt 2) {
  throw "Expected at least 2 decks in $DeckFilePath"
}

$matchups = Build-Matchups -Decks $decks -IncludeMirrors:$IncludeMirrors -IncludeReverse:$IncludeReverse

$benchmarkConfigPath = Join-Path $configDir "benchmark.trio.json"
$benchmarkResultPath = Join-Path $benchmarkOutputDir "benchmark-result.json"
$benchmarkMarkdownPath = Join-Path $benchmarkOutputDir "benchmark-result.md"

$benchmarkConfig = [ordered]@{
  version = $BenchmarkVersion
  matchups = @(
    foreach ($matchup in $matchups) {
      [ordered]@{
        id = $matchup.id
        deck0 = $matchup.deck0.deckCode
        deck1 = $matchup.deck1.deckCode
        deck0Name = $matchup.deck0.name
        deck1Name = $matchup.deck1.name
        games = $GamesPerMatchup
        sideA = New-PolicyConfig -SideLabel "side-a"
        sideB = New-PolicyConfig -SideLabel "side-b"
      }
    }
  )
}

Write-JsonFile -Path $benchmarkConfigPath -Value $benchmarkConfig

$branchEvalConfigs = @()
foreach ($matchup in $matchups) {
  $branchEvalConfigPath = Join-Path $branchEvalConfigDir "$($matchup.id).json"
  $branchEvalOutputPath = Join-Path $branchEvalOutputDir "$($matchup.id).json"

  $branchEvalConfig = [ordered]@{
    benchmarkPath = $benchmarkConfigPath
    matchupId = $matchup.id
    replayDir = Join-Path $sampleReplayDir $matchup.id
    sampleCount = $BranchEvalSampleCount
    minLegalActions = $MinLegalActions
    maxBranchesPerPoint = $MaxBranchesPerPoint
    continuationGamesPerBranch = $ContinuationGamesPerBranch
    sideA = New-PolicyConfig -SideLabel "candidate-a"
    sideB = New-PolicyConfig -SideLabel "candidate-b"
    outputPath = $branchEvalOutputPath
  }

  Write-JsonFile -Path $branchEvalConfigPath -Value $branchEvalConfig
  $branchEvalConfigs += [pscustomobject]@{
    id = $matchup.id
    configPath = $branchEvalConfigPath
    outputPath = $branchEvalOutputPath
  }
}

$manifestPath = Join-Path $OutputRoot "run-manifest.json"
$manifest = [ordered]@{
  generatedAt = (Get-Date).ToString("s")
  deckFilePath = $DeckFilePath
  benchmarkConfigPath = $benchmarkConfigPath
  benchmarkResultPath = $benchmarkResultPath
  benchmarkMarkdownPath = $benchmarkMarkdownPath
  sampleReplayDir = $sampleReplayDir
  policyKind = $PolicyKind
  parameters = [ordered]@{
    benchmarkVersion = $BenchmarkVersion
    includeMirrors = $IncludeMirrors
    includeReverse = $IncludeReverse
    gamesPerMatchup = $GamesPerMatchup
    benchmarkConcurrency = $BenchmarkConcurrency
    sampleLogsPerMatchup = $SampleLogsPerMatchup
    branchEvalSampleCount = $BranchEvalSampleCount
    minLegalActions = $MinLegalActions
    maxBranchesPerPoint = $MaxBranchesPerPoint
    continuationGamesPerBranch = $ContinuationGamesPerBranch
    topTags = $TopTags
    topCandidateSlots = $TopCandidateSlots
    endTurnPenalty = $EndTurnPenalty
    learnedScoreScale = $LearnedScoreScale
    weightsPath = if ($PolicyKind -eq "evaluator") { $WeightsPath } else { $null }
  }
  decks = $decks
  matchups = @(
    foreach ($matchup in $matchups) {
      [ordered]@{
        id = $matchup.id
        deck0 = $matchup.deck0.id
        deck1 = $matchup.deck1.id
        branchEvalConfigPath = (Join-Path $branchEvalConfigDir "$($matchup.id).json")
        branchEvalOutputPath = (Join-Path $branchEvalOutputDir "$($matchup.id).json")
        mlOutputDir = (Join-Path $mlOutputDir $matchup.id)
      }
    }
  )
}
Write-JsonFile -Path $manifestPath -Value $manifest

Write-Host "Generated trio benchmark pipeline config." -ForegroundColor Cyan
Write-Host "Benchmark config: $benchmarkConfigPath"
Write-Host "Manifest: $manifestPath"

if ($GenerateOnly) {
  Write-Host "GenerateOnly is set. No benchmark, branch-eval, or gi-ml commands were executed." -ForegroundColor Yellow
  exit 0
}

Push-Location $giAgentDir
try {
  Write-Host "[1/3] Benchmark with replay capture" -ForegroundColor Cyan
  & pnpm run benchmark $benchmarkConfigPath `
    --output $benchmarkResultPath `
    --markdown $benchmarkMarkdownPath `
    --concurrency $BenchmarkConcurrency `
    --sample-logs-dir $sampleReplayDir `
    --sample-logs-per-matchup $SampleLogsPerMatchup
  if ($LASTEXITCODE -ne 0) {
    throw "Benchmark failed with exit code $LASTEXITCODE"
  }

  Write-Host "[2/3] Branch eval per matchup" -ForegroundColor Cyan
  foreach ($branchEval in $branchEvalConfigs) {
    Write-Host "  branch-eval $($branchEval.id)"
    & pnpm run branch-eval $branchEval.configPath
    if ($LASTEXITCODE -ne 0) {
      throw "Branch eval failed for $($branchEval.id) with exit code $LASTEXITCODE"
    }
  }
}
finally {
  Pop-Location
}

Push-Location $giMlDir
try {
  Write-Host "[3/3] gi-ml baseline pipeline per matchup" -ForegroundColor Cyan
  foreach ($branchEval in $branchEvalConfigs) {
    $matchupMlDir = Join-Path $mlOutputDir $branchEval.id
    New-Item -ItemType Directory -Force -Path $matchupMlDir | Out-Null

    $datasetOutput = Join-Path $matchupMlDir "dataset.json"
    $artifactOutput = Join-Path $matchupMlDir "artifact.json"
    $evaluationOutput = Join-Path $matchupMlDir "evaluation.json"

    Write-Host "  gi-ml pipeline $($branchEval.id)"
    & pnpm exec gnx ./src/cli/pipeline/run-build-branch-eval-baseline-pipeline.ts `
      --input $branchEval.outputPath `
      --dataset-output $datasetOutput `
      --artifact-output $artifactOutput `
      --evaluation-output $evaluationOutput `
      --top-tags $TopTags `
      --top-candidate-slots $TopCandidateSlots
    if ($LASTEXITCODE -ne 0) {
      throw "gi-ml pipeline failed for $($branchEval.id) with exit code $LASTEXITCODE"
    }
  }
}
finally {
  Pop-Location
}

Write-Host "Done. Outputs are under: $OutputRoot" -ForegroundColor Green
