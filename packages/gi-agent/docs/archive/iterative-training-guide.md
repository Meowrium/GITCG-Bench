# 迭代自对弈训练流水线

> **⚠️ 状态：部分过时** — 核心训练流程（自对弈→导出→训练→评估）仍然正确，但训练配置已从 V3 升级到 V25。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)



## 概述

每次迭代执行以下步骤：

1. **自对弈** — 使用当前最佳模型（或 baseline）生成对局数据
2. **导出 RL 数据集** — 从对局记录中提取 observation-action 数据
3. **训练 Slot-Linear 排序器** — 快速训练动作排序模型
4. **训练 GBDT 价值模型** — GBDT 相比线性模型提升约 38%
5. **晋升决策** — 如果新模型优于旧模型，替换为下一轮的策略

迭代 0 使用 baseline 策略生成数据；后续迭代用训练好的 gi-ml-runtime 策略。

## 快速开始

### 主要方法：连续多轮迭代（推荐）

```powershell
cd packages/gi-agent
pwsh -File ../../scripts/run-multi-iteration-training.ps1
```

脚本默认从 `pipeline-state.json` 中记录的上一次迭代继续，从 `StartIteration` 运行到 `EndIteration`（默认范围见参数说明）。首次运行时若无历史模型，自动使用 baseline 策略冷启动。

指定迭代区间：

```powershell
cd packages/gi-agent
pwsh -File ../../scripts/run-multi-iteration-training.ps1 -StartIteration 150 -EndIteration 170
```

使用更大对局规模：

```powershell
pwsh -File ../../scripts/run-multi-iteration-training.ps1 -StartIteration 150 -EndIteration 170 -GamesMultiplier 3
```

### 手动逐步执行

如果脚本出错需要手动控制，可按以下步骤执行（以 iter-NNN 为例）：

```powershell
cd packages/gi-agent

# 1. 手动创建 self-play-config.json，然后运行自对弈
bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts \
  ./output/iter-training/iter-NNN/self-play-config.json

# 2. 训练排序器 + 线性价值模型
cd ../gi-ml
bun run ./src/cli/run-build-rl-warm-start-bundle.ts \
  --input ../gi-agent/output/iter-training/iter-NNN/rl-dataset.json \
  --output-dir ../gi-agent/output/iter-training/iter-NNN/artifacts \
  --prefix iterNNN \
  --top-tags 32 --top-candidate-slots 24 --top-features 32

# 3. 训练 LightGBM 价值模型（推荐）
bun run ./src/cli/run-build-lgbm-value.ts \
  --input ../gi-agent/output/iter-training/iter-NNN/rl-dataset.json \
  --output-dir ../gi-agent/output/iter-training/iter-NNN/artifacts \
  --prefix iterNNN \
  --estimators 120 --depth 5 --lr 0.06 --top-features 80

cd ../gi-agent
```

## 参数说明

以下为 `run-multi-iteration-training.ps1` 的参数（从 `packages/gi-agent/` 目录运行）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-StartIteration` | 18 | 起始迭代编号 |
| `-EndIteration` | 40 | 结束迭代编号（含） |
| `-GamesMultiplier` | 2 | 对局规模倍数（基础 108 局 × 倍数）|
| `-Concurrency` | 2 | 并行进程数（受 16GB RAM 限制，建议 ≤ 2）|
| `-BenchmarkPath` | `./benchmark.training-v2.json` | 对局配置（10 组 matchup，基础 108 局）|
| `-OutputRoot` | `./output/iter-training` | 输出根目录 |
| `-GbdtEstimators` | 120 | GBDT 树的数量 |
| `-GbdtDepth` | 5 | 每棵树最大深度 |
| `-GbdtLr` | 0.06 | GBDT 学习率 |
| `-GbdtTopFeatures` | 80 | 选取的 top 特征数（66 维向量，保留高 gain 特征）|
| `-ValueBackend` | `lgbm` | 价值模型后端：`lgbm`（LightGBM）或 `ts-gbdt`（内置 TS GBDT）|

## 输出目录结构

```
output/iter-training/
├── pipeline-state.json          # 全局状态（记录最佳模型、各迭代指标）
├── iter-000/
│   ├── self-play-config.json    # 自对弈配置
│   ├── self-play-rl/            # RL 捕获文件
│   ├── rl-dataset.json          # RL 数据集（约 200-400 MB）
│   ├── self-play-result.json    # 对局统计
│   └── artifacts/
│       ├── iter0.ranker-artifact.json
│       ├── iter0.value-artifact.json
│       ├── iter0.gbdt-value-artifact.json
│       ├── iter0.gbdt-value-eval.json
│       └── iter0.bundle.json
├── iter-001/
│   └── ...（同上，使用 iter-000 的模型为策略）
└── iter-002/
    └── ...
```

## 内存管理

- 自对弈使用 `--smol` 标志运行（bun 的低内存模式）
- 并行进程数由 `-Concurrency` 控制，默认 2（受 16GB RAM 限制）
- `pipeline-state.json` 记录了当前最佳模型和所有历史指标

### 对局数量 vs 内存估算

| GamesMultiplier | 总局数 | 预估时间/迭代 | 数据集大小 | 峰值内存 |
|:---:|--------|----------|-----------|----------|
| 1 | 108 | ~55 min | ~450 MB | ~3 GB |
| 2（默认） | 216 | ~100 min | ~900 MB | ~4 GB |
| 3 | 324 | ~150 min | ~1.3 GB | ~5 GB |

## 断点续传

脚本是**幂等的**：每一步在执行前都会检查输出文件是否已存在。如果中途中断：

1. 直接重新运行相同命令，已完成的步骤会自动跳过
2. `pipeline-state.json` 记录了当前最佳模型和所有历史指标

## 温度采样（Temperature Sampling）

自对弈时两侧策略均启用 **softmax 温度采样**（`temperature = 1.5`），而非贪婪地选择最高分动作（`temperature = 0`）。

### 实现位置

`packages/gi-agent/src/runtime/policy/baseline-policy.ts` — `BaselinePolicyOptions`:

```typescript
export interface BaselinePolicyOptions {
  // ...
  /**
   * Softmax temperature for stochastic action selection during self-play.
   * 0 (default) = argmax (greedy). Values around 1.0~2.0 promote exploration.
   */
  temperature?: number;
}
```

`choose()` 和 `GiMlPolicy.choose()` 均调用 `temperatureSample(ranked)`，使用数值稳定的 softmax：

```
P(action_i) ∝ exp((score_i - score_max) / T)
```

### 训练配置

脚本 `run-multi-iteration-training.ps1` 在生成 `self-play-config.json` 时，两种策略类型均设置：

```json
"options": { "endTurnPenalty": 5, "temperature": 1.5 }
```

**推理时**（线上对局）应保持 `temperature = 0`（默认值），以最优动作为准。

### 效果

| 指标 | T=0 (v2 best, iter-129) | T=1.5 (v3 best, iter-145) |
|------|:-----------------------:|:------------------------:|
| Value MAE | 0.2305 | **0.0827** (−64%) |
| Value RMSE | 0.2978 | **0.1588** (−47%) |
| Pairwise | 0.8395 | 0.7792 |

Pairwise 下降原因：T=1.5 产生的训练数据包含更多"次优动作"，使配对难度本身增加；数据集真实信息量更高。

## Benchmark v2

相比 v1 (68 局)，v2 (108 局/倍数) 增加了：
- 镜像对局：8 → 12 局/组
- 交叉对局：6 → 10 局/组
- 总计 108 局 × `GamesMultiplier`，默认配置产生 **216 局/迭代**

## 晋升判据

- **首轮（无前序模型）**：排序器 pairwise support ≥ 0.55 → 晋升
- **后续迭代**：Value MAE 改善 ≥ 0.005 **且** 排序器 pairwise support ≥ 0.55 → 晋升

> 注：晋升阈值已从早期的 0.01 放宽至 0.005，允许较小的改善也能推进最佳模型。

## FAQ

**Q: 一次迭代大约需要多久？**  
A: 在 i7-7700HQ 上，GamesMultiplier=2（216 局）自对弈约 90 分钟，训练约 10 分钟，总计约 **100 分钟/迭代**。

**Q: 可以跳过某些步骤吗？**  
A: 可以，手动创建对应的输出文件即可。脚本检测到文件存在会跳过该步骤。

**Q: LightGBM (lgbm) 与内置 ts-gbdt 有何区别？**  
A: `lgbm` 是推荐后端，速度更快、精度更高。`ts-gbdt` 为纯 TypeScript 实现，无需 Python 环境，但性能较弱。

**Q: GBDT 比线性模型好多少？**  
A: 在早期实验（v1）中，GBDT MAE=0.2765 vs 线性 MAE=0.4520（提升 38.8%）。v3 最佳 MAE 已降至 0.0827。

**Q: 如何查看当前训练状态？**
```powershell
Get-Content packages/gi-agent/output/iter-training/pipeline-state.json | ConvertFrom-Json | ConvertTo-Json -Depth 5
```

**Q: temperature 参数推理时应设多少？**  
A: 推理（线上对局）应使用默认值 `temperature = 0`（argmax 贪婪），训练自对弈设为 `1.5`。

## 特征向量（66 维）

`FeatureExtractor` 提取 66 维特征向量，涵盖动作类型、增益信号、血量/骰子/资源状态以及 HC 约束特征。

| 分组 | 维数 | 描述 |
|------|:---:|------|
| 动作类型（one-hot） | 11 | isUseSkill / isPlayCard / isSwitchActive / isDeclareEnd / isOtherAction / isEventCard / isSupportCard / isEquipmentCard / isWeaponCard / isArtifactCard / isTechniqueCard |
| 增益信号 | 16 | damageEstimate / healingEstimate / selfHealValue / teamHealValue / reactionValue / tempoValue / drawValue / diceFixValue / energyGainValue / createSupportValue / createSummonValue / createEquipmentValue / forcedSwitchValue / selfSwitchValue / targetCount / willBeEffectless |
| 费用 | 2 | totalCost / costRatio |
| 己方状态 | 5 | selfActiveHpRatio / selfTeamAvgHpRatio / selfAliveCount / selfActiveEnergyGap / selfNearBurstCount |
| 对手状态 | 4 | opponentActiveHpRatio / opponentTeamAvgHpRatio / opponentAliveCount / opponentBurstReady |
| 资源状态 | 8 | diceCount / omniCount / cardsInHand / supportCount / summonCount / supportRoom / summonRoom / round |
| 态势信号 | 7 | hpAdvantage / aliveAdvantage / energyUrgency / healUrgency / canKillTarget / hasReaction / isFastAction |
| HC-05 集中击杀 | 3 | opponentMinHp / selfMinHpRatio / damageToMinHpTarget |
| HC-07 元素反应链 | 3 | oppActiveHasAura / selfActiveHasAura / reactionChainReady |
| HC-06 骰子匹配 | 2 | diceSkillAlignment / diceColorEntropy |
| HC-02 先后手 | 2 | opponentDeclaredEnd / selfActionCountInRound |
| HC-10 阶段切换 | 3 | gamePhaseEstimate / setupCompletion / opponentThreatScore |

特征顺序由 `FeatureExtractor.featureNames()` 定义，排序器 artifact 中的权重与此顺序对齐。

## 奖励配置（reward.v2）

当前默认奖励配置 `DEFAULT_REWARD_CONFIG_V1`（`reward_version: "reward.v2"`）：

```typescript
shaping: {
  damage_coef:              0.02,
  ko_bonus:                 0.15,
  energy_coef:              0.015,
  hand_coef:                0.01,
  reaction_ready_bonus:     0.03,
  burst_online_bonus:       0.04,
  setup_window_bonus:       0.0125,
  reserve_value_bonus:      0.008,
  setup_realization_bonus:  0.025,
  element_application_bonus: 0.02,   // HC-07 新增：元素附着奖励
  focus_damage_bonus:        0.03,   // HC-05 新增：集中伤害奖励
  step_clip:                0.25,
}
```

启用的奖励事件包括 `damage`、`ko`、`energy`、`hand`、`reaction_ready`、`burst_online`、`setup_window`、`reserve_value`、`setup_realization`、`element_application`、`focus_damage`。

## 训练历史

| 阶段 | 迭代范围 | 特征维度 | Temperature | 最佳迭代 | Value MAE | Pairwise |
|------|---------|:-------:|:-----------:|:-------:|:---------:|:--------:|
| v1 | iter-000~032 | 54 | 0 | iter-032 | 0.2512 | 0.839 |
| v2 | iter-100~129 | 66 | 0 | iter-129 | 0.2305 | 0.840 |
| v3 | iter-131~150 | 66 | 1.5 | **iter-145** | **0.0827** | 0.779 |

v2 起对迭代编号重置为 100（含数据清理），v3 在 v2 best (iter-129) 基础上引入温度采样继续训练。

---

## 参见

- **[ai-improvement-plan](ai-improvement-plan.md)** — AI 改进计划：性能优化路线
- **[v5-code-quality-fixes](v5-code-quality-fixes.md)** — V5 代码质量修复
- **[v14-model-requirements](v14-model-requirements.md)** — V14 模型需求及特征设计
