# MCTS 训练数据改进计划

> 目标：解决 self-play 数据对称性问题，使 GBDT value model 能学习非对称对抗位置。

## 背景

当前 pipeline (`scripts/local-train.sh`) 的 self-play 阶段使用：
```
sideA: baseline (temperature=1.5)
sideB: baseline (temperature=2.0)
```
双方策略相同，仅温度不同。导致 value model 学到的全是"对称博弈"位置——遇对手策略切换立即失效。

## 总体策略

三轮迭代，每轮改进一个维度：

```
Iter 1: 对手多样性     → bootstrap 模型
Iter 2: Agent 策略升级  → GiMlPolicy 做 sideA
Iter 3: 数据覆盖扩展   → 更多 matchup + 更长时间序列
```

---

## Iter 1: 对手多样性（最小有效改动）

### 1.1 定义三种 opponent archetype

在 `scripts/local-train.sh` 的 self-play 配置生成中，sideB 随机从 3 种变体抽取：

| 变体 | endTurnPenalty | temperature | 行为特征 |
|------|:---:|:---:|------|
| `aggressive` | 3 | 1.0 | 倾向于攻击而非结束回合，低温度=更确定 |
| `defensive` | 8 | 2.0 | 倾向于保留骰子/结束回合，高温度=更多样 |
| `neutral` | 5 | 1.5 | 当前 baseline 默认行为 |

### 1.2 生成 self-play 配置

统一生成脚本（Python 嵌入 bash），对每副 deck × 每种 opponent 生成 3 组 matchup：

```python
# 8 decks × 3 archetypes = 24 matchups, 每个 5-10 games
for deck_a in DECKS.values():
    for (arch_name, arch_opts) in ARCHETYPES:
        matchups.append({
            "deck0": deck_a,
            "deck1": pick_random(deck_a),  # 随机选对手 deck
            "games": games_per_matchup,
            "sideA": GiMlPolicy(artifact=iter3_ranker),  # bootstrap
            "sideB": BaselinePolicy(arch_opts),
        })
```

**bootstrap 策略**：首轮用现有 iter3 ranker/v5 model 做 sideA，避免从零开始。

### 1.3 运行

```bash
cd packages/gi-agent
GAMES_MULTIPLIER=1 bash ../../scripts/local-train.sh
```

预计：
- ~24 matchups × 13 games = ~312 games
- 自对弈 ~20 分钟
- 流式 ranker ~3 分钟
- GBDT value ~5 分钟
- 总计 ~30 分钟

### 1.4 验证

```bash
# 用新 value model 跑 MCTS benchmark
bun run --smol src/evaluation/benchmark/run-benchmark.ts \
  benchmark.mcts-v9.json \
  --output output/benchmark-mcts-iter1.json \
  --markdown output/benchmark-mcts-iter1.md
```

**成功标准**：MCTS v9 的 3 个侵略性对局 (HongNiu/ShuiZhai) WR 不再为 0%。

---

## Iter 2: Agent 策略升级

### 2.1 替换 sideA agent

Iter 1 用 bootstrap ranker。Iter 2 用 Iter 1 产出的新 ranker 重跑：

```
sideA: GiMlPolicy(artifact=iter1_ranker)
sideB: 3 种 opponent archetypes (同 Iter 1)
```

### 2.2 加入 plan-phase 引导

sideA 的 GiMlPolicy 配置中加入 deck-specific game plan（已有基础设施 `gi-tcg-gameplan` skill）：

```json
"sideA": {
    "kind": "gi-ml-runtime",
    "rankerArtifactPath": "...",
    "options": {
        "macroPlanWeight": 0.6,
        "tempoValueWeight": 0.3,
        "strategyPlanPath": "plan-phases/deck-4.101.json"
    }
}
```

### 2.3 验证

对比 Iter 1 和 Iter 2 的 MCTS benchmark WR。

---

## Iter 3: 数据覆盖扩展

### 3.1 增加 matchup 组合

8 decks → 8×8 = 64 matchups（而非当前的 24），覆盖所有 deck 组合。

### 3.2 增加每 matchup 游戏数

`GAMES_MULTIPLIER=3` → 64×13×3 ≈ 2500 games。

### 3.3 长时间序列采样

每个 matchup 的前/中/后期各采样 1/3 的数据点，确保 value model 见过：
- 早期部署 vs 早期压迫
- 中期爆发 vs 中期防守
- 残局斩杀 vs 残局拖延

### 3.4 验证

Full 28-matchup benchmark (like temporal-full model)。

---

## 实施文件

| 文件 | 改动 | 迭代 |
|------|------|:---:|
| `scripts/local-train.sh` | self-play 配置生成改为 3-opponent 随机 | 1 |
| `scripts/gen-diverse-config.py` | **新建**：生成带对手多样性的 self-play 配置 | 1 |
| `gi-ml/src/datasets/rl-value.ts` | 不变（特征提取相同） | — |
| `gi-agent/src/mcts/value-features.ts` | 不变（已实现） | — |
| benchmark 流程 | 不变（用新 artifact 替换旧路径） | 1-3 |

## 弃用的方向

以下方向在 Path B 实验中已证明无效，不纳入此计划：
- ❌ GBDT value model 单独使用（v10: 0% WR）
- ❌ 粗粒度 prior 温度搜索（v3-v6: 均 ≤35%）
- ❌ 增强 heuristicValueFn（v7: damageScore 反效果）
- ❌ 增加 MCTS 迭代数（v8-200: 无效）
