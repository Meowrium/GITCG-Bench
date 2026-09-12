<# 
  Multi-Iteration Continuous Training Pipeline
  =============================================
  
  连续运行多轮迭代训练，每轮自动使用上一轮最佳模型。
  
  Hardware target: i7-7700HQ, GTX1050, 16GB RAM
  
  Usage (从 packages/gi-agent/ 目录运行):
    cd packages/gi-agent
    pwsh -File ../../scripts/run-multi-iteration-training.ps1

  ─────────────────────────────────────────────
  可调参数说明（在下面 param() 块中修改）:
  ─────────────────────────────────────────────

  -StartIteration   起始迭代编号（默认 3，从 iter-002 best 继续）
  -EndIteration     结束迭代编号（默认 7，共 5 轮）
  -GamesMultiplier  对局规模倍数（默认 1，即使用 benchmark 中的 games 数；
                     设为 2 则每个 matchup 对局翻倍，数据量翻倍但时间也翻倍）
  -Concurrency      并行对局数（默认 1，受限于 bun 单线程；
                     如需并行可改用多进程方式，见注释）
  -GbdtEstimators   GBDT 树数量（默认 120，更多=更强但更慢）
  -GbdtDepth        GBDT 树深度（默认 5）
  -GbdtLr           GBDT 学习率（默认 0.06）
  -GbdtTopFeatures  GBDT 特征数上限（默认 80，新增卡牌ID特征后需要更多）
  -BenchmarkPath    对局配置文件路径
  -OutputRoot       输出根目录
  -PlanStrategy     SPL (Strategic Plan Layer) 策略: "none" (默认), "compiled" (从 DeckAnalysis 编译阶段约束)
  -PlansDir         SPL 阶段计划文件目录 (PlanPhase[] JSON 文件，按 deckFingerprint 命名)
  -PlanExplorationEpsilon  SPL 引导自对弈的探索率 (默认 0.15，探索仅在 phase.primary 候选集内进行)
  
  注意: 每轮迭代完成后自动清理中间文件（self-play-rl/、replay-logs/、
        rl-dataset、*-dataset.json、*-eval.json 等），保留推理所需的
        ranker-artifact + gbdt-value-artifact + gbdt-q-value-artifact
        以及 promotion 评估报告（promotion-eval-result.json、promotion-eval-report.md）。
#>

param(
    # ════════════════════════════════════════════════════
    # ▼▼▼ 调整对局规模: 修改这两个参数 ▼▼▼
    # ════════════════════════════════════════════════════
    [int]$StartIteration = 1,
    [int]$EndIteration = 10,

    # ════════════════════════════════════════════════════
    # ▼▼▼ 调整对局规模: 倍数（1=108局, 2=216局, 3=324局...） ▼▼▼
    # ════════════════════════════════════════════════════
    [int]$GamesMultiplier = 3,

    # ════════════════════════════════════════════════════
    # ▼▼▼ 探索性对手配置 ▼▼▼
    # sideB 策略: "diverse" = 高温度自对弈 (temperature 2.5+)
    #             "baseline" = 使用启发式策略对手 (完全不依赖模型)
    #             "mixed"    = 50% 局数用 diverse, 50% 用 baseline
    # 引入非自身策略对手可打破"自我博弈"数据同质化瓶颈
    # ════════════════════════════════════════════════════
    [string]$SideBStrategy = "mixed",

    # ════════════════════════════════════════════════════
    # ▼▼▼ 调整并行数: bun 内部是单线程，此参数控制同时启动的进程数 ▼▼▼
    # 注意: 受限于 16GB RAM，建议最多 2
    # ════════════════════════════════════════════════════
    [int]$Concurrency = 2,

    [string]$BenchmarkPath = "./benchmark.training-v3.json",
    [string]$OutputRoot = "./output/iter-training",

    # GBDT hyperparameters
    [int]$GbdtEstimators = 120,
    [int]$GbdtDepth = 5,
    [double]$GbdtLr = 0.06,
    [int]$GbdtTopFeatures = 80,

    # Value model backend: "lgbm" (LightGBM, recommended) or "ts-gbdt" (built-in TS GBDT)
    [string]$ValueBackend = "lgbm",

    # Minimum sample count for data quality check (skip iteration if below)
    [int]$MinSamples = 500,

    # ════════════════════════════════════════════════════
    # ▼▼▼ Promotion 策略: "mae" (旧) 或 "winrate" (新) ▼▼▼
    # "mae":     基于 value MAE 下降幅度的旧逻辑（跨 benchmark 版本不可比）
    # "winrate": 新旧模型直接对弈，胜率超过阈值则 promote
    # ════════════════════════════════════════════════════
    [string]$PromotionStrategy = "winrate",

    # Win-rate promotion: 新模型 vs 旧模型对弈的胜率阈值 (0~1)
    # 0.55 = 需要至少 55% 胜率才算有效改善
    [double]$WinRateThreshold = 0.55,

    # Win-rate promotion: 评估对弈的 gamesMultiplier (默认 1x = ~416 局)
    [int]$EvalGamesMultiplier = 1,

    # ════════════════════════════════════════════════════
    # ▼▼▼ 内存优化: 分块 self-play ▼▼▼
    # 将 self-play 拆分为多个 chunk，每个 chunk 跑完即导出 shard 并释放内存
    # 设为 0 表示不分块（旧行为），设为 N 表示每 N 个 matchup 为一个 chunk
    # ════════════════════════════════════════════════════
    [int]$SelfPlayChunkSize = 0,

    # ════════════════════════════════════════════════════
    # ▼▼▼ SPL (Strategic Plan Layer) 配置 ▼▼▼
    # 引入 Skill 分析导出的阶段化策略约束，弥合声明式策略与过程式决策间的鸿沟
    # "none"     = 不使用 SPL（旧行为）
    # "compiled" = 从 DeckAnalysis 编译 PlanPhase[]，运行时由 StrategicPlanStateMachine 驱动
    # ════════════════════════════════════════════════════
    [string]$PlanStrategy = "none",

    # SPL 阶段计划文件目录（PlanPhase[] JSON）
    # 文件命名: {deckFingerprint}.plan.json
    # 如果为空，运行时从 DeckAnalysis 实时编译（需要 deck-analyzer 可用）
    [string]$PlansDir = "",

    # SPL 引导自对弈探索率（仅在 phase.primary 候选集内探索）
    [double]$PlanExplorationEpsilon = 0.15,

    # ════════════════════════════════════════════════════
    # ▼▼▼ LLM 增强卡组分析 ▼▼▼
    # 如果提供了 LLM 分析缓存目录，自对弈时将使用 LLM 增强的先验特征
    # 需要先用 packages/llm-deck-analyzer 的 precompute:llm 预先计算
    # ════════════════════════════════════════════════════
    [string]$LlmCacheDir = ""
)

$ErrorActionPreference = "Stop"

# ── Determine repo root and set working directory ──
# Compute absolute paths from $PSScriptRoot so the script works
# regardless of where it was invoked from.
$RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot "..")
$GiAgentDir = Join-Path $RepoRoot "packages\gi-agent"
$GiMlDir    = Join-Path $RepoRoot "packages\gi-ml"
Set-Location $GiAgentDir

$startTime = Get-Date

# ============================================================
# Validation
# ============================================================

if ($StartIteration -gt $EndIteration) {
    Write-Host "Error: StartIteration ($StartIteration) > EndIteration ($EndIteration)" -ForegroundColor Red
    exit 1
}

$StateFile = Join-Path $OutputRoot "pipeline-state.json"

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  MULTI-ITERATION TRAINING PIPELINE" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""
Write-Host "  ── Pipeline（每轮迭代训练 4 个模型）──"
Write-Host ""
Write-Host "    ① Slot-Linear Ranker     actionCase + candidateTag + numericSlot 线性权重"
Write-Host "    ② Linear Value Model      加权线性回归（扁平化特征 → 权重）"
Write-Host "    ③ LightGBM GBDT Value     Python LightGBM 回归树集成（GbdtValueArtifact）"
Write-Host "    ④ LightGBM GBDT Q-Value   Q(s,a) 回归（同样 LightGBM trainer）"
Write-Host ""
Write-Host "  ── Configuration ──"
Write-Host ""
Write-Host "  Iterations:        $StartIteration -> $EndIteration ($(($EndIteration - $StartIteration + 1)) rounds)"
Write-Host "  Games multiplier:  ${GamesMultiplier}x"
Write-Host "  SideB strategy:    $SideBStrategy"
if ($SideBStrategy -eq "mixed") {
    Write-Host "  Est. games/iter:   ~$(416 * $GamesMultiplier) (primary) + ~$(416 * 1) (baseline) = ~$(416 * ($GamesMultiplier + 1))"
} else {
    Write-Host "  Est. games/iter:   ~$(416 * $GamesMultiplier)"
}
Write-Host "  Concurrency:       $Concurrency"
Write-Host "  GBDT estimators:   $GbdtEstimators"
Write-Host "  GBDT depth:        $GbdtDepth"
Write-Host "  GBDT lr:           $GbdtLr"
Write-Host "  GBDT top features: $GbdtTopFeatures"
Write-Host "  Value backend:     $ValueBackend (LightGBM via Python .lgbm-venv)"
Write-Host "  Min samples:       $MinSamples"
$promoLabel = if ($PromotionStrategy -eq 'winrate') { " (threshold=$WinRateThreshold, evalGames=${EvalGamesMultiplier}x)" } else { '' }
Write-Host "  Promotion:         $PromotionStrategy$promoLabel"
if ($SelfPlayChunkSize -gt 0) {
    Write-Host "  Self-play chunks:  $SelfPlayChunkSize matchups/chunk"
}
if ($PlanStrategy -ne "none") {
    Write-Host "  SPL strategy:      $PlanStrategy (exploration=$PlanExplorationEpsilon)"
    if ($PlansDir) {
        Write-Host "  Plans directory:   $PlansDir"
    } else {
        Write-Host "  Plans:             auto-compiled from deck-analyzer"
    }
}
Write-Host ""

# ============================================================
# Helper functions
# ============================================================

function Ensure-Dir([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Get-BestArtifacts {
    if (-not (Test-Path $StateFile)) {
        return @{ ranker = $null; value = $null; qvalue = $null; iteration = $null }
    }
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    $ranker = $state.currentBestRankerPath
    $value  = $state.currentBestValuePath
    $qvalue = $state.currentBestQValuePath
    # 验证文件实际存在，否则降级为 baseline
    if ($ranker -and -not (Test-Path $ranker)) {
        Write-Host "  WARNING: Best ranker artifact not found on disk: $ranker" -ForegroundColor Yellow
        Write-Host "           Falling back to baseline policy." -ForegroundColor Yellow
        $ranker = $null
        $value  = $null
        $qvalue = $null
    }
    if ($value -and -not (Test-Path $value)) {
        Write-Host "  WARNING: Best value artifact not found on disk: $value" -ForegroundColor Yellow
        $value = $null
    }
    if ($qvalue -and -not (Test-Path $qvalue)) {
        Write-Host "  WARNING: Best Q-value artifact not found on disk: $qvalue" -ForegroundColor Yellow
        $qvalue = $null
    }
    return @{
        ranker    = $ranker
        value     = $value
        qvalue    = $qvalue
        iteration = if ($ranker) { $state.currentBestIteration } else { $null }
    }
}

function Read-DatasetSampleCount([string]$path) {
    if (-not (Test-Path $path)) {
        return 0
    }
    try {
        # Read only the first 4KB to extract sample_count.
        # RL dataset JSON files can be 600-800+ MB; loading the entire
        # file into PowerShell with ConvertFrom-Json would consume 5-10x
        # that in memory (3-8 GB) and take minutes.  The "sample_count"
        # field is always near the top of the file (rl_dataset.v1 schema),
        # so a small prefix read is sufficient.
        $stream = [System.IO.StreamReader]::new($path, [System.Text.Encoding]::UTF8)
        $prefix = $null
        try {
            $bufSize = 4096
            $charBuf = [char[]]::new($bufSize)
            $read = $stream.Read($charBuf, 0, $bufSize)
            $prefix = -join $charBuf[0..($read - 1)]
        }
        finally {
            $stream.Dispose()
        }

        if ($prefix -match '"sample_count"\s*:\s*(\d+)') {
            return [int]$Matches[1]
        }

        # Fallback for small files (< 50 MB) only
        $fileSize = (Get-Item $path).Length
        if ($fileSize -lt 50MB) {
            $data = Get-Content $path -Raw | ConvertFrom-Json
            if ($data.PSObject.Properties["sample_count"]) {
                return [int]$data.sample_count
            }
            if ($data.PSObject.Properties["samples"]) {
                return @($data.samples).Count
            }
        }

        Write-Host "  WARNING: Could not extract sample_count from prefix (file: $([math]::Round($fileSize/1MB,1)) MB)" -ForegroundColor Yellow
        return 0
    }
    catch {
        Write-Host "  WARNING: Could not parse dataset for sample count: $_" -ForegroundColor Yellow
        return 0
    }
}

function Format-Duration([TimeSpan]$ts) {
    if ($ts.TotalHours -ge 1) {
        return "{0:N1}h" -f $ts.TotalHours
    }
    return "{0:N0}min" -f $ts.TotalMinutes
}

# ============================================================
# Main loop
# ============================================================

$iterationResults = @()

for ($iter = $StartIteration; $iter -le $EndIteration; $iter++) {
    $iterStart = Get-Date
    $IterDir   = Join-Path $OutputRoot ("iter-{0:D3}" -f $iter)
    $RlDir     = Join-Path $IterDir "self-play-rl"
    $ArtDir    = Join-Path $IterDir "artifacts"
    
    $SelfPlayConfig  = Join-Path $IterDir "self-play-config.json"
    $RlDatasetFile   = Join-Path $IterDir "rl-dataset.manifest.json"
    $BundleFile      = Join-Path $ArtDir "iter${iter}.bundle.json"
    $GbdtValueFile   = Join-Path $ArtDir "iter${iter}.gbdt-value-artifact.json"
    $GbdtEvalFile    = Join-Path $ArtDir "iter${iter}.gbdt-value-eval.json"
    $GbdtQValueFile  = Join-Path $ArtDir "iter${iter}.gbdt-q-value-artifact.json"
    $RankerFile      = Join-Path $ArtDir "iter${iter}.ranker-artifact.json"
    $LinearValueFile = Join-Path $ArtDir "iter${iter}.value-artifact.json"
    
    Ensure-Dir $IterDir
    Ensure-Dir $RlDir
    Ensure-Dir $ArtDir
    
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Cyan
    Write-Host "  ITERATION $iter / $EndIteration" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor Cyan
    
    # ── Get best artifacts from previous iterations ──
    $best = Get-BestArtifacts
    $PrevRankerPath = $best.ranker
    $PrevValuePath  = $best.value
    $PrevQValuePath = $best.qvalue
    
    if ($PrevRankerPath) {
        Write-Host "  Using best model from iter $($best.iteration) (SlotLinearRanker + LightGBM GBDT Value + Q-Value)" -ForegroundColor Green
    } else {
        Write-Host "  Using baseline heuristic policy (no ML model yet)" -ForegroundColor Yellow
    }
    
    # ════════════════════════════════════════════════════
    # Step 1: Generate self-play config
    # ════════════════════════════════════════════════════
    
    Write-Host "`n[Step 1/$iter] Generating self-play config..." -ForegroundColor Yellow
    
    if (-not (Test-Path $SelfPlayConfig)) {
        # ── Build sideA config (always uses best trained model) ──
        if ($PrevRankerPath) {
            $sideAConfig = @{
                name    = "trained-iter$iter"
                kind    = "gi-ml-runtime"
                rankerArtifactPath = (Resolve-Path $PrevRankerPath).Path
                options = @{ endTurnPenalty = 5; temperature = 1.5; qValueWeight = 1.5 }
            }
            if ($PrevValuePath) {
                $sideAConfig.valueArtifactPath = (Resolve-Path $PrevValuePath).Path
            }
            # Use Q-value artifact from pipeline state if available
            if ($PrevQValuePath) {
                $sideAConfig.qValueArtifactPath = (Resolve-Path $PrevQValuePath).Path
            } else {
                # Fallback: infer from value artifact path
                $prevQValuePath = $PrevValuePath -replace '\.gbdt-value-artifact\.json$', '.gbdt-q-value-artifact.json'
                if ($prevQValuePath -ne $PrevValuePath -and (Test-Path $prevQValuePath)) {
                    $sideAConfig.qValueArtifactPath = (Resolve-Path $prevQValuePath).Path
                }
            }
        } else {
            $sideAConfig = @{
                name    = "baseline"
                kind    = "baseline"
                options = @{ endTurnPenalty = 5; temperature = 1.5 }
            }
        }

        # ── Build sideB config based on $SideBStrategy ──
        # "diverse"  : Same model as sideA but with very high temperature (2.5+)
        #              for broader action-space exploration.
        # "baseline" : Pure heuristic policy (no ML model) — completely different
        #              decision patterns, provides diverse training signal.
        # "mixed"    : Primary self-play uses diverse, secondary uses baseline.
        #              Datasets are merged after both complete.

        # Build sideB-diverse config (same model, high temperature, no Q-value)
        if ($PrevRankerPath) {
            $sideBDiverseConfig = @{
                name    = "opponent-diverse"
                kind    = "gi-ml-runtime"
                rankerArtifactPath = (Resolve-Path $PrevRankerPath).Path
                options = @{ endTurnPenalty = 5; temperature = 2.5 }
            }
            if ($PrevValuePath) {
                $sideBDiverseConfig.valueArtifactPath = (Resolve-Path $PrevValuePath).Path
                $sideBDiverseConfig.options.qValueWeight = 1.0
            }
            # Note: intentionally omit qValueArtifactPath for diverse opponent
            # to increase variance in action selection
        } else {
            # No trained model yet — fallback to baseline for diverse
            $sideBDiverseConfig = @{
                name    = "opponent-diverse"
                kind    = "baseline"
                options = @{ endTurnPenalty = 5; temperature = 2.0 }
            }
        }

        $sideBBaselineConfig = @{
            name    = "opponent-heuristic"
            kind    = "baseline"
            options = @{ endTurnPenalty = 5; temperature = 1.2; adaptiveProfile = $true }
        }

        if ($SideBStrategy -eq "baseline") {
            $sideBConfig = $sideBBaselineConfig
        } elseif ($SideBStrategy -eq "diverse") {
            $sideBConfig = $sideBDiverseConfig
        } else {
            # "mixed" — use diverse as primary, baseline as secondary
            $sideBConfig = $sideBDiverseConfig
        }

        $config = @{
            benchmarkPath = (Resolve-Path $BenchmarkPath).Path
            gamesMultiplier = $GamesMultiplier
            rlCapture = @{
                directory       = (Join-Path (Resolve-Path $IterDir).Path "self-play-rl")
                modelVersion    = "iter-$iter"
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
                manifestPath         = (Join-Path (Resolve-Path $IterDir).Path "rl-dataset.manifest.json")
                shardDir             = (Join-Path (Resolve-Path $IterDir).Path "rl-dataset.shards")
                maxSamplesPerShard   = 2000
                includeSides         = @(0, 1)
                requireChosenCandidate = $true
            }
            sideA = $sideAConfig
            sideB = $sideBConfig
            outputPath = (Join-Path (Resolve-Path $IterDir).Path "self-play-result.json")
            planStrategy = $PlanStrategy
            plansDir = if ($PlansDir) { [System.IO.Path]::GetFullPath($PlansDir) } else { $null }
            planExplorationEpsilon = $PlanExplorationEpsilon
            llmCacheDir = if ($LlmCacheDir) { (Resolve-Path $LlmCacheDir).Path } else { $null }
        }

        $config | ConvertTo-Json -Depth 10 | Set-Content $SelfPlayConfig -Encoding UTF8
        Write-Host "  Config written: $SelfPlayConfig"
        $sideADesc = if ($sideAConfig.kind -eq "gi-ml-runtime") { "ML policy (SlotLinearRanker + GBDT value)" } else { "heuristic baseline" }
        $sideBDesc = if ($sideBConfig.kind -eq "gi-ml-runtime") { "ML policy (high-temp diverse)" } else { "heuristic baseline" }
        Write-Host "  SideA: $($sideAConfig.name) — $sideADesc"
        Write-Host "  SideB: $($sideBConfig.name) — $sideBDesc (strategy=$SideBStrategy)"
        if ($LlmCacheDir) {
            Write-Host "  LLM analysis: enabled (cache=$LlmCacheDir)" -ForegroundColor Magenta
        }

        # ── For "mixed" strategy, also create a secondary baseline config ──
        if ($SideBStrategy -eq "mixed") {
            $secondaryConfigPath = Join-Path $IterDir "self-play-config-baseline.json"
            $secondaryConfig = @{
                benchmarkPath = (Resolve-Path $BenchmarkPath).Path
                gamesMultiplier = 1
                rlCapture = @{
                    directory       = (Join-Path (Resolve-Path $IterDir).Path "self-play-rl-baseline")
                    modelVersion    = "iter-$iter-baseline"
                    viewKind        = "policy_public"
                    gameVersion     = "v6.3.0"
                    cardPoolVersion = "v6.3.0"
                    rulesetVersion  = "default"
                    contractVersion = "obs.v1"
                }
                replayLogCapture = @{
                    directory          = (Join-Path (Resolve-Path $IterDir).Path "replay-logs-baseline")
                    maxGamesPerMatchup = 1
                }
                dataset = @{
                    manifestPath         = (Join-Path (Resolve-Path $IterDir).Path "rl-dataset-baseline.manifest.json")
                    shardDir             = (Join-Path (Resolve-Path $IterDir).Path "rl-dataset-baseline.shards")
                    maxSamplesPerShard   = 2000
                    includeSides         = @(0, 1)
                    requireChosenCandidate = $true
                }
                sideA = $sideAConfig
                sideB = $sideBBaselineConfig
                outputPath = (Join-Path (Resolve-Path $IterDir).Path "self-play-result-baseline.json")
                planStrategy = $PlanStrategy
                plansDir = if ($PlansDir) { [System.IO.Path]::GetFullPath($PlansDir) } else { $null }
                planExplorationEpsilon = $PlanExplorationEpsilon
                llmCacheDir = if ($LlmCacheDir) { (Resolve-Path $LlmCacheDir).Path } else { $null }
            }
            $secondaryConfig | ConvertTo-Json -Depth 10 | Set-Content $secondaryConfigPath -Encoding UTF8
            Write-Host "  Secondary config written: $secondaryConfigPath (baseline opponent)"
        }
    } else {
        Write-Host "  Config already exists, skipping."
    }
    
    # ════════════════════════════════════════════════════
    # Step 2: Run self-play
    # ════════════════════════════════════════════════════
    
    Write-Host "`n[Step 2/$iter] Running self-play (RL data collection)..." -ForegroundColor Yellow
    
    if (-not (Test-Path $RlDatasetFile)) {
        $gameCount = 416 * $GamesMultiplier
        Write-Host "  Starting self-play RL data collection (~${gameCount} games, est. $(Format-Duration ([TimeSpan]::FromMinutes($gameCount * 0.4))))..." -ForegroundColor Magenta
        Write-Host "  SideA policy: $(if ($PrevRankerPath) { 'gi-ml-runtime (SlotLinearRanker + GBDT value, iter ' + $best.iteration + ')' } else { 'baseline (heuristic)' })"
        Write-Host "  SideB policy: $SideBStrategy"
        Write-Host "  Output: RL captures → sharded RL Dataset (preference-labeled samples)"
        Write-Host "  NOTE: chooseActive is RANDOM during training for character diversity" -ForegroundColor DarkCyan
        
        # ── Memory optimization: split self-play into chunks ──
        # When $SelfPlayChunkSize > 0, we split the benchmark matchups into chunks,
        # run self-play for each chunk, and export shards incrementally.
        # This reduces peak memory from O(total_games) to O(chunk_games).
        
        if ($SelfPlayChunkSize -gt 0) {
            Write-Host ""
            Write-Host "  Running in CHUNKED mode ($SelfPlayChunkSize matchups/chunk) for memory efficiency" -ForegroundColor DarkCyan
        }
        
        # ── Primary self-play (diverse or single strategy) ──
        if ($SelfPlayChunkSize -gt 0) {
            # Chunked execution: generate a split config, run each chunk separately
            $chunkedScript = Join-Path $PSScriptRoot "run-self-play-chunked.ts"
            if (Test-Path $chunkedScript) {
                bun run $chunkedScript $SelfPlayConfig --chunk-size $SelfPlayChunkSize --cwd $GiAgentDir
            } else {
                # Fallback: run without chunking but with --smol flag for memory
                Write-Host "  WARNING: Chunked runner not found, falling back to standard mode" -ForegroundColor Yellow
                bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts $SelfPlayConfig
            }
        } else {
            bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts $SelfPlayConfig
        }
        
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Self-play failed with exit code $LASTEXITCODE" -ForegroundColor Red
            exit 1
        }
        
        if (-not (Test-Path $RlDatasetFile)) {
            Write-Host "  Warning: RL dataset not found after self-play." -ForegroundColor Red
            exit 1
        }
        Write-Host "  Primary self-play complete. Dataset: $RlDatasetFile"

        # ── Secondary self-play for "mixed" strategy (baseline opponent) ──
        if ($SideBStrategy -eq "mixed") {
            $secondaryConfigPath = Join-Path $IterDir "self-play-config-baseline.json"
            $secondaryDatasetPath = Join-Path $IterDir "rl-dataset-baseline.manifest.json"
            
            if ((Test-Path $secondaryConfigPath) -and -not (Test-Path $secondaryDatasetPath)) {
                $secondaryGameCount = 416 * 1
                Write-Host "`n  Starting secondary self-play vs baseline (~${secondaryGameCount} games)..." -ForegroundColor Magenta
                Write-Host "  SideB: baseline (heuristic opponent for data diversity)" -ForegroundColor Magenta
                
                bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts $secondaryConfigPath
                
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "  Secondary self-play failed (non-fatal, continuing with primary data)." -ForegroundColor Yellow
                } elseif (Test-Path $secondaryDatasetPath) {
                    Write-Host "  Secondary self-play complete. Merging shard datasets..."
                    
                    # Merge secondary manifest/shards into primary
                    # Strategy: copy secondary shard files into primary shard dir, then update primary manifest
                    $primaryShardDir = Join-Path $IterDir "rl-dataset.shards"
                    $secondaryShardDir = Join-Path $IterDir "rl-dataset-baseline.shards"
                    
                    $mergeScript = Join-Path $PSScriptRoot "merge-rl-manifests.ts"
                    if ((Test-Path $mergeScript) -and (Test-Path $primaryShardDir) -and (Test-Path $secondaryShardDir)) {
                        $absPrimaryManifest = (Resolve-Path $RlDatasetFile).Path
                        $absSecondaryManifest = (Resolve-Path $secondaryDatasetPath).Path
                        bun run $mergeScript $absPrimaryManifest $absSecondaryManifest
                        if ($LASTEXITCODE -eq 0) {
                            Write-Host "  Datasets merged successfully." -ForegroundColor Green
                        } else {
                            Write-Host "  Merge failed (non-fatal). Keeping primary dataset only." -ForegroundColor Yellow
                        }
                    } else {
                        Write-Host "  Merge script or shard dirs not found. Keeping primary dataset only." -ForegroundColor Yellow
                    }
                }
            }
        }
        
        Write-Host "  Self-play complete." -ForegroundColor Green
    } else {
        Write-Host "  RL dataset already exists, skipping."
    }
    
    # ── Data quality check ──
    Write-Host "`n  [Data Quality Check]" -ForegroundColor DarkYellow
    $sampleCount = Read-DatasetSampleCount $RlDatasetFile
    Write-Host "  Samples: $sampleCount (minimum: $MinSamples)"
    
    if ($sampleCount -lt $MinSamples) {
        Write-Host "  WARNING: Insufficient samples ($sampleCount < $MinSamples). Skipping this iteration." -ForegroundColor Red
        $iterDuration = (Get-Date) - $iterStart
        $iterationResults += @{
            iteration = $iter
            pairwise  = $null
            mae       = $null
            winRate   = $null
            promoted  = $false
            skipped   = $true
            samples   = $null
            duration  = $iterDuration
        }
        continue
    }
    
    if ($sampleCount -lt 1000) {
        Write-Host "  WARNING: Low sample count ($sampleCount). Training may be unreliable." -ForegroundColor Yellow
    } else {
        Write-Host "  Data quality: OK ($sampleCount samples)" -ForegroundColor Green
    }
    
    # ════════════════════════════════════════════════════
    # Step 3: Train ranker + linear value
    # ════════════════════════════════════════════════════
    
    Write-Host "`n[Step 3/$iter] Training slot-linear ranker + linear value model..." -ForegroundColor Yellow
    
    if (-not (Test-Path $BundleFile)) {
        $AbsRlDataset = (Resolve-Path $RlDatasetFile).Path
        $AbsArtDir    = (Resolve-Path $ArtDir).Path
        Push-Location $GiMlDir
        
        bun run ./src/cli/run-build-rl-warm-start-bundle.ts `
            --input $AbsRlDataset `
            --output-dir $AbsArtDir `
            --prefix "iter${iter}" `
            --top-tags 32 `
            --top-candidate-slots 24 `
            --top-features 32
        
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Warm-start bundle failed." -ForegroundColor Red
            Pop-Location
            exit 1
        }
        
        Pop-Location
        Write-Host "  Bundle complete (SlotLinearRanker + LinearValue)."
    } else {
        Write-Host "  Bundle already exists, skipping."
    }

    # ════════════════════════════════════════════════════
    # Step 4: Train LightGBM GBDT value model
    # ════════════════════════════════════════════════════
    
    Write-Host "`n[Step 4/$iter] Training LightGBM GBDT value model..." -ForegroundColor Yellow
    
    if (-not (Test-Path $GbdtValueFile)) {
        $AbsRlDataset = (Resolve-Path $RlDatasetFile).Path
        $AbsArtDir    = (Resolve-Path $ArtDir).Path
        Push-Location $GiMlDir
        
        if ($ValueBackend -eq "lgbm") {
            bun run ./src/cli/run-build-lgbm-value.ts `
                --input $AbsRlDataset `
                --output-dir $AbsArtDir `
                --prefix "iter${iter}" `
                --estimators $GbdtEstimators `
                --depth $GbdtDepth `
                --lr $GbdtLr `
                --top-features $GbdtTopFeatures
        } else {
            bun run ./src/cli/run-build-gbdt-value.ts `
                --input $AbsRlDataset `
                --output-dir $AbsArtDir `
                --prefix "iter${iter}" `
                --estimators $GbdtEstimators `
                --depth $GbdtDepth `
                --lr $GbdtLr `
                --top-features $GbdtTopFeatures
        }
        
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  GBDT training failed." -ForegroundColor Red
            Pop-Location
            exit 1
        }
        
        Pop-Location
        Write-Host "  LightGBM GBDT value training complete (Python LightGBM regressor → GbdtValueArtifact)."
    } else {
        Write-Host "  GBDT value artifact already exists, skipping."
    }

    # ════════════════════════════════════════════════════
    # Step 4.5: Train LightGBM GBDT Q-value model (Q(s,a))
    # ════════════════════════════════════════════════════

    Write-Host "`n[Step 4.5/$iter] Training LightGBM GBDT Q-value model..." -ForegroundColor Yellow

    if (-not (Test-Path $GbdtQValueFile)) {
        $AbsRlDataset = (Resolve-Path $RlDatasetFile).Path
        $AbsArtDir    = (Resolve-Path $ArtDir).Path
        Push-Location $GiMlDir

        bun run ./src/cli/run-build-lgbm-q-value.ts `
            --input $AbsRlDataset `
            --output-dir $AbsArtDir `
            --prefix "iter${iter}" `
            --estimators $GbdtEstimators `
            --depth $GbdtDepth `
            --lr $GbdtLr `
            --top-features $GbdtTopFeatures

        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Q-value training failed (non-fatal, continuing)." -ForegroundColor Yellow
        } else {
            Write-Host "  LightGBM GBDT Q-value training complete (Python LightGBM regressor → GbdtQValueArtifact)."
        }

        Pop-Location
    } else {
        Write-Host "  Q-value artifact already exists, skipping."
    }

    # ════════════════════════════════════════════════════
    # Step 5: Evaluate & update pipeline state + promotion
    # ════════════════════════════════════════════════════

    Write-Host "`n[Step 5/$iter] Evaluating model & updating pipeline state..." -ForegroundColor Yellow
    
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
    
    # Promotion logic
    $promoted = $false
    $minPairwise = 0.55
    $minMaeImprovement = 0.002  # 在 MAE ~0.08 量级，0.005 过严（≈6% 相对改善），降至 0.002（≈2.5%）

    if ($PromotionStrategy -eq "winrate") {
        # ════════════════════════════════════════════════════════════
        # Win-rate promotion: 新模型 vs 当前最佳模型直接对弈
        # 优势：不受 benchmark 版本切换导致的 MAE 量级变化影响
        # ════════════════════════════════════════════════════════════
        Write-Host "  Promotion strategy: WINRATE (new vs current best)" -ForegroundColor Cyan

        if ($null -eq $PrevRankerPath) {
            # No previous model — promote if ranker is reasonable
            if ($rankerPairwise -and $rankerPairwise -ge $minPairwise) {
                $promoted = $true
                Write-Host "  First model with pairwise $rankerPairwise >= $minPairwise -> PROMOTE" -ForegroundColor Green
            }
        } else {
            # Run evaluation: new model (sideA) vs current best (sideB)
            $evalConfigPath = Join-Path $IterDir "eval-winrate-config.json"
            $evalResultPath = Join-Path $IterDir "eval-winrate-result.json"

            # sideA = newly trained model (just built)
            $evalSideA = @{
                name = "candidate-iter$iter"
                kind = "gi-ml-runtime"
                rankerArtifactPath = (Resolve-Path $RankerFile).Path
                options = @{ endTurnPenalty = 5; temperature = 1.0; qValueWeight = 1.0 }
            }
            if (Test-Path $GbdtValueFile) {
                $evalSideA.valueArtifactPath = (Resolve-Path $GbdtValueFile).Path
            } elseif (Test-Path $LinearValueFile) {
                $evalSideA.valueArtifactPath = (Resolve-Path $LinearValueFile).Path
            }
            # Add Q-value if available
            if (Test-Path $GbdtQValueFile) {
                $evalSideA.qValueArtifactPath = (Resolve-Path $GbdtQValueFile).Path
            }

            # sideB = current best model
            $evalSideB = @{
                name = "previous-best"
                kind = "gi-ml-runtime"
                rankerArtifactPath = (Resolve-Path $PrevRankerPath).Path
                options = @{ endTurnPenalty = 5; temperature = 1.0; qValueWeight = 1.0 }
            }
            if ($PrevValuePath -and (Test-Path $PrevValuePath)) {
                $evalSideB.valueArtifactPath = (Resolve-Path $PrevValuePath).Path
            }
            if ($PrevQValuePath -and (Test-Path $PrevQValuePath)) {
                $evalSideB.qValueArtifactPath = (Resolve-Path $PrevQValuePath).Path
            }

            # Build eval config in benchmark-cli format (same as benchmark.training-v3.json)
            # Read the original benchmark to get deck pairs
            $benchmarkData = Get-Content (Resolve-Path $BenchmarkPath) -Raw | ConvertFrom-Json
            $evalMatchups = @()
            foreach ($mu in $benchmarkData.matchups) {
                $evalMatchups += @{
                    id    = $mu.id
                    deck0 = $mu.deck0
                    deck1 = $mu.deck1
                    games = [int]([math]::Round($mu.games * $EvalGamesMultiplier))
                    sideA = $evalSideA
                    sideB = $evalSideB
                }
            }
            $evalConfig = @{
                version   = $benchmarkData.version
                matchups  = $evalMatchups
            }

            $evalConfig | ConvertTo-Json -Depth 10 | Set-Content $evalConfigPath -Encoding UTF8

            $evalGameCount = ($evalMatchups | Measure-Object -Property games -Sum).Sum
            Write-Host "  Running win-rate evaluation (~${evalGameCount} games)..." -ForegroundColor Magenta
            Push-Location $GiAgentDir
            bun run --smol src/evaluation/benchmark/cli/run-benchmark.ts $evalConfigPath --output $evalResultPath
            Pop-Location

            $winRate = $null
            $perMatchupResults = @()

            if (Test-Path $evalResultPath) {
                $evalResult = Get-Content $evalResultPath -Raw | ConvertFrom-Json
                # Calculate sideA win rate from benchmark result format
                # run-benchmark outputs: { result: [{ matchupId, batch: { winsP0, winsP1, draws, total } }] }
                $totalEval = 0
                $winsEval = 0
                $perMatchupResults = foreach ($row in $evalResult.result.results) {
                    $muTotal = $row.batch.total
                    $muWins = $row.batch.winsP0
                    $totalEval += $muTotal
                    $winsEval += $muWins
                    [PSCustomObject]@{
                        matchupId = $row.matchupId
                        games     = $muTotal
                        wins      = $muWins
                        losses    = $row.batch.winsP1
                        draws     = $row.batch.draws
                        winRate   = if ($muTotal -gt 0) { [math]::Round($muWins / $muTotal * 100, 1) } else { 0 }
                    }
                }
                $winRate = if ($totalEval -gt 0) { $winsEval / $totalEval } else { 0 }
                Write-Host "  Win-rate: $([math]::Round($winRate * 100, 1))% ($winsEval / $totalEval games)" -ForegroundColor Cyan

                # ── Save per-matchup win-rate report to iteration directory ──
                $promotionResultPath = Join-Path $IterDir "promotion-eval-result.json"
                $evalResult | ConvertTo-Json -Depth 10 | Set-Content $promotionResultPath -Encoding UTF8

                # Generate Markdown report with red-green color coding
                $mdReportPath = Join-Path $IterDir "promotion-eval-report.md"
                $mdLines = @()
                $mdLines += "# Promotion Evaluation — Iter $iter"
                $mdLines += ""
                $mdLines += "Candidate (iter $iter) vs Current Best (iter $($best.iteration))"
                $mdLines += ""
                $mdLines += "**Aggregate**: $([math]::Round($winRate * 100, 1))% ($winsEval / $totalEval games)"
                $mdLines += ""
                $mdLines += "| Matchup | Games | Wins | Losses | Draws | Win Rate |"
                $mdLines += "|---------|-------|------|--------|-------|----------|"
                foreach ($r in $perMatchupResults) {
                    $pct = $r.winRate
                    # Map 0→100% to hue 0→120 (red→green)
                    $hue = [math]::Round($pct * 1.2)
                    $bg = "hsl($hue, 60%, 78%)"  # pastel red→green gradient
                    $mdLines += "| ``$($r.matchupId)`` | $($r.games) | $($r.wins) | $($r.losses) | $($r.draws) | <span style=`"background-color:$bg;padding:2px 6px`">$pct%</span> |"
                }
                $mdLines += ""
                if ($promoted) {
                    $mdLines += "**Result: PROMOTED** :green_circle: (threshold: $($WinRateThreshold * 100)%)"
                } else {
                    $reason = if ($winRate -lt $WinRateThreshold) { "win-rate $([math]::Round($winRate * 100, 1))% < $($WinRateThreshold * 100)%" } else { "pairwise $rankerPairwise < $minPairwise" }
                    $mdLines += "**Result: NOT PROMOTED** :red_circle: ($reason)"
                }
                $mdLines -join "`n" | Set-Content $mdReportPath -Encoding UTF8
                Write-Host "  Per-matchup report saved: $mdReportPath" -ForegroundColor DarkCyan

                if ($winRate -ge $WinRateThreshold -and $rankerPairwise -ge $minPairwise) {
                    $promoted = $true
                    Write-Host "  Win-rate $([math]::Round($winRate * 100, 1))% >= $($WinRateThreshold * 100)% -> PROMOTE" -ForegroundColor Green
                } else {
                    $reason = if ($winRate -lt $WinRateThreshold) { "win-rate $([math]::Round($winRate * 100, 1))% < $($WinRateThreshold * 100)%" } else { "pairwise $rankerPairwise < $minPairwise" }
                    Write-Host "  NOT promoted: $reason" -ForegroundColor Yellow
                }
            } else {
                Write-Host "  WARNING: Eval result not found, falling back to MAE comparison" -ForegroundColor Yellow
                # Fallback to MAE comparison
                if (Test-Path $StateFile) {
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
                }
            }
        }
        }
    } else {
        # ════════════════════════════════════════════════════════════
        # Legacy MAE-based promotion (旧逻辑，保留兼容)
        # ════════════════════════════════════════════════════════════
        Write-Host "  Promotion strategy: MAE comparison (legacy)" -ForegroundColor Cyan

        if ($null -eq $PrevRankerPath) {
            if ($rankerPairwise -and $rankerPairwise -ge $minPairwise) {
                $promoted = $true
            }
        } else {
            if (Test-Path $StateFile) {
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
    }
    
    $bestValuePath = $GbdtValueFile
    if (-not (Test-Path $GbdtValueFile)) {
        $bestValuePath = $LinearValueFile
    }
    # If neither value artifact exists in this iteration (cleaned up), keep the previous best value path
    if (-not (Test-Path $bestValuePath) -and $PrevValuePath -and (Test-Path $PrevValuePath)) {
        $bestValuePath = $PrevValuePath
    }
    
    # Also track Q-value artifact path for pipeline state
    $bestQValuePath = $null
    if (Test-Path $GbdtQValueFile) {
        $bestQValuePath = (Resolve-Path $GbdtQValueFile).Path
    }
    
    $iterResult = @{
        iteration     = $iter
        rankerMetrics = @{ pairwiseSupport = $rankerPairwise }
        valueMetrics  = @{ mae = $valueMae; rmse = $valueRmse }
        promoted      = $promoted
        artifactPaths = @{
            ranker = (Resolve-Path $RankerFile).Path
            value  = (Resolve-Path $bestValuePath).Path
            qvalue = $bestQValuePath
        }
        promotionStrategy = $PromotionStrategy
    }
    
    if (Test-Path $StateFile) {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    } else {
        $state = @{
            currentBestIteration  = $null
            currentBestRankerPath = $null
            currentBestValuePath  = $null
            currentBestQValuePath = $null
            iterations            = @()
            startedAt             = (Get-Date -Format o)
        }
    }
    
    $iterations = [System.Collections.ArrayList]@()
    if ($state.iterations) {
        foreach ($it in $state.iterations) {
            [void]$iterations.Add($it)
        }
    }
    [void]$iterations.Add($iterResult)
    $state.iterations = $iterations
    
    if ($promoted) {
        $state.currentBestIteration  = $iter
        $state.currentBestRankerPath = (Resolve-Path $RankerFile).Path
        $state.currentBestValuePath  = (Resolve-Path $bestValuePath).Path
        $state.currentBestQValuePath = $bestQValuePath
    }
    $state.lastUpdatedAt = (Get-Date -Format o)
    
    $state | ConvertTo-Json -Depth 10 | Set-Content $StateFile -Encoding UTF8
    
    # ── Iteration summary ──
    $iterDuration = (Get-Date) - $iterStart

    Write-Host ""
    Write-Host ("-" * 50)
    Write-Host "  Iter $iter complete in $(Format-Duration $iterDuration)"
    Write-Host "  ── Models trained this iteration ──"
    Write-Host "  Slot-Linear Ranker pairwise: $rankerPairwise"
    Write-Host "  Linear Value (warm-start)    (in bundle)"
    Write-Host "  LightGBM GBDT Value MAE:     $valueMae"
    Write-Host "  LightGBM GBDT Value RMSE:    $valueRmse"
    Write-Host "  LightGBM GBDT Q-Value        (artifact)"
    Write-Host "  ── Data ──"
    Write-Host "  RL Dataset samples:          $sampleCount"
    if ($winRate) {
        Write-Host "  Promotion win-rate:          $([math]::Round($winRate * 100, 1))%"
    }
    Write-Host "  Reports:                     $IterDir/promotion-eval-report.md"
    
    if ($promoted) {
        Write-Host "  Status: PROMOTED ✓" -ForegroundColor Green
    } else {
        Write-Host "  Status: NOT PROMOTED (keeping previous best)" -ForegroundColor Yellow
    }
    
    $iterationResults += @{
        iteration = $iter
        pairwise  = $rankerPairwise
        mae       = $valueMae
        winRate   = $winRate
        promoted  = $promoted
        skipped   = $false
        samples   = $sampleCount
        duration  = $iterDuration
    }

    # ════════════════════════════════════════════════════
    # Step 6: Cleanup intermediate files to save disk
    # ════════════════════════════════════════════════════

    Write-Host "`n[Step 6/$iter] Cleaning up intermediate files..." -ForegroundColor Yellow

    $cleanedMB = 0

    # Helper: remove a path (file or directory) and track freed space
    function Remove-TrackedItem {
        param([string]$Path)
        if (Test-Path $Path) {
            try {
                $size = 0
                $item = Get-Item $Path
                if ($item.PSIsContainer) {
                    $size = (Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue |
                             Measure-Object -Property Length -Sum).Sum
                    Remove-Item $Path -Recurse -Force
                } else {
                    $size = $item.Length
                    Remove-Item $Path -Force
                }
                $script:cleanedMB += [math]::Round($size / 1MB, 1)
            } catch {
                Write-Host "    Warning: could not remove $Path" -ForegroundColor DarkYellow
            }
        }
    }

    # Self-play raw captures (already exported to dataset)
    Remove-TrackedItem (Join-Path $IterDir "self-play-rl")
    Remove-TrackedItem (Join-Path $IterDir "self-play-rl-baseline")

    # Replay logs (debugging only)
    Remove-TrackedItem (Join-Path $IterDir "replay-logs")
    Remove-TrackedItem (Join-Path $IterDir "replay-logs-baseline")

    # RL dataset files (already consumed by training)
    Remove-TrackedItem (Join-Path $IterDir "rl-dataset.json")
    Remove-TrackedItem (Join-Path $IterDir "rl-dataset.manifest.json")
    Remove-TrackedItem (Join-Path $IterDir "rl-dataset.shards")
    Remove-TrackedItem (Join-Path $IterDir "rl-dataset-baseline.json")
    Remove-TrackedItem (Join-Path $IterDir "rl-dataset-baseline.manifest.json")
    Remove-TrackedItem (Join-Path $IterDir "rl-dataset-baseline.shards")

    # Artifact intermediate files (training datasets + eval summaries)
    $artifactDir = Join-Path $IterDir "artifacts"
    if (Test-Path $artifactDir) {
        Get-ChildItem $artifactDir -File | Where-Object {
            $_.Name -match '-dataset\.json$' -or
            $_.Name -match '-eval\.json$' -or
            $_.Name -match 'bundle\.json$' -or
            $_.Name -match 'value-artifact\.json$' -or  # linear value (superseded by gbdt-value)
            $_.Name -match 'ranking-dataset\.json$'  # large ranking dataset (GB scale)
        } | ForEach-Object {
            # Skip if this artifact is the current best (don't delete what's in use)
            if ($_.FullName -ne $state.currentBestRankerPath -and
                $_.FullName -ne $state.currentBestValuePath -and
                $_.FullName -ne $state.currentBestQValuePath) {
                Remove-TrackedItem $_.FullName
            }
        }
    }

    # Baseline config (already consumed)
    Remove-TrackedItem (Join-Path $IterDir "self-play-config-baseline.json")

    if ($cleanedMB -gt 0) {
        Write-Host "  Freed $cleanedMB MB of disk space." -ForegroundColor Green
    } else {
        Write-Host "  No intermediate files to clean."
    }
}

# ============================================================
# Final summary
# ============================================================

$totalDuration = (Get-Date) - $startTime

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  ALL ITERATIONS COMPLETE" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""
Write-Host "  Total time: $(Format-Duration $totalDuration)"

$totalPromoted = ($iterationResults | Where-Object { $_.promoted }).Count
$totalSkipped = ($iterationResults | Where-Object { $_.skipped }).Count
$totalValidIterations = $iterationResults.Count - $totalSkipped
Write-Host "  Promoted: $totalPromoted / $totalValidIterations"
if ($totalSkipped -gt 0) {
    Write-Host "  Skipped:  $totalSkipped (insufficient samples)"
}
Write-Host ""
Write-Host "  Results:"
Write-Host "  ┌──────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐"
Write-Host "  │ Iter │ Pairwise │ MAE      │ WinRate  │ Samples  │ Status   │ Duration │"
Write-Host "  ├──────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤"

$mdSummaryLines = @()
$mdSummaryLines += "# Training Summary"
$mdSummaryLines += ""
$mdSummaryLines += "Total time: $(Format-Duration $totalDuration) | Promoted: $totalPromoted / $totalValidIterations"
$mdSummaryLines += ""
$mdSummaryLines += "| Iter | Pairwise | MAE | WinRate | Samples | Status | Duration |"
$mdSummaryLines += "|------|----------|-----|---------|---------|--------|----------|"

foreach ($r in $iterationResults) {
    if ($r.skipped) {
        $status = "SKIP"
    } elseif ($r.promoted) {
        $status = "PROMOTE"
    } else {
        $status = "REJECT"
    }
    $pw = if ($r.pairwise) { "{0:P1}" -f $r.pairwise } else { "N/A" }
    $mae = if ($r.mae) { "{0:N4}" -f $r.mae } else { "N/A" }
    $wr = if ($r.winRate) { "{0:P1}" -f $r.winRate } else { "N/A   " }
    $samp = if ($r.samples) { "$($r.samples)" } else { "N/A" }
    $dur = Format-Duration $r.duration
    Write-Host ("  │ {0,-4} │ {1,-8} │ {2,-8} │ {3,-8} │ {4,-8} │ {5,-8} │ {6,-8} │" -f $r.iteration, $pw, $mae, $wr, $samp, $status, $dur)

    # Generate markdown row with red-green color on win rate
    $wrPct = if ($r.winRate) { [math]::Round($r.winRate * 100, 1) } else { $null }
    if ($null -ne $wrPct) {
        $hue = [math]::Round($wrPct * 1.2)
        $wrCell = "<span style=`"background-color:hsl($hue, 60%, 78%);padding:2px 6px`">$wrPct%</span>"
    } else {
        $wrCell = "—"
    }
    $pwCell = if ($r.pairwise) { "{0:P1}" -f $r.pairwise } else { "—" }
    $maeCell = if ($r.mae) { "{0:N4}" -f $r.mae } else { "—" }
    $mdSummaryLines += "| $($r.iteration) | $pwCell | $maeCell | $wrCell | $($r.samples) | $status | $dur |"
}

Write-Host "  └──────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘"
Write-Host ""

# Save summary as Markdown
$mdSummaryPath = Join-Path $OutputRoot "training-summary.md"
$mdSummaryLines -join "`n" | Set-Content $mdSummaryPath -Encoding UTF8
Write-Host "  Summary saved: $mdSummaryPath" -ForegroundColor DarkCyan
Write-Host ""

$finalBest = Get-BestArtifacts
if ($finalBest.ranker) {
    Write-Host "  Final best model: iter $($finalBest.iteration)" -ForegroundColor Green
    Write-Host "  Slot-Linear Ranker:     $($finalBest.ranker)"
    Write-Host "  LightGBM GBDT Value:    $($finalBest.value)"
    Write-Host "  LightGBM GBDT Q-Value:  $($finalBest.qvalue)"
} else {
    Write-Host "  No model was promoted." -ForegroundColor Yellow
}
Write-Host ""
