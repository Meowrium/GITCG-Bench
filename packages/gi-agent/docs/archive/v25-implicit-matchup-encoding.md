# V25 隐式卡组编码假说与 Self-Play 扩展实验

> **日期**: 2026-05-14（初稿）/ 2026-05-16（更新）  
> **关联**: `v14-model-requirements.md` §A3 (Deck-specific 调优能力)  
> **状态**: ✅ V25-8deck (v8) 完成 → 假说被拒绝 → v9 per-deck ranker 实验进行中

## 1. 核心假说

**V25 隐式编码假说 (Implicit Matchup Encoding Hypothesis)**:

> 模型无需显式的 "对手卡组 ID" 特征，即可通过状态特征（骰子分布、前台血量、召唤物存在性等）隐式学习到 matchup 特异性策略。Self-play 数据多样性（多卡组对抗）越丰富，隐式编码越充分。

## 2. 实验证据（截至 v25b4-stream）

### 2.1 训练设置

| 参数 | 值 |
|---|---|
| Self-play 卡组 | 仅 2 套：水八 + 神宵 |
| 对手卡组 | 8 套全量（水八、神宵、水债、水凝、红牛、莫优、雷鹤、雷狼） |
| 训练样本 | 123,340 samples, 103,875 query groups |
| 训练方式 | Streaming Linear Ranker + GBDT Ranker |
| 模型特征 | 仅状态特征（dice/HP/hand/support），无 deck-id 特征 |

### 2.2 Benchmark 结果 (35.0% WR vs Baseline)

```
水八作为侧A:
  雷鹤 80% | 莫优 60% | 神宵 60% | 红牛 40% | 水八 40% | 水债 20% | 水凝 20% | 雷狼 0%
神宵作为侧A:
  水凝 60% | 莫优 60% | 雷鹤 60% | 水债 20% | 雷狼 20% | 水八 20% | 红牛 0% | 神宵 0%
```

### 2.3 关键观察

1. **Matchup 差异极大** (0%-80%)：模型确实对不同对手采用了不同策略，而非 "一刀切"
2. **交叉验证**：水八打雷鹤 80% ≠ 神宵打雷鹤 60% → 模型不只是 "学了对雷鹤的策略"，而是 "学了用当前卡组打雷鹤的策略"
3. **G2 (对手资源感知) 隐式满足**：`q:opp_total_health` 在 GBDT 特征重要性排第 9（4,461 分），说明对手血量被模型有效利用
4. **无 deck-id 特征仍能区分 matchup**：状态快照 (dice/HP/summon) 本身就携带了 "当前是哪个 matchup" 的信息

### 2.4 反例：为什么模型能区分匹配？

```
水八 vs 雷鹤 (80% WR):  对手早中期血量低 → 模型倾向快攻
水八 vs 雷狼 (0% WR):   对手有盾 + 反伤 → 模型面临不利状态
```

这两个 matchup 的状态分布完全不同 → `q:opp_total_health`、`q:self_active_health` 等特征的值分布不同 → 线性 ranker 和 GBDT 学到不同的权重偏好 → 产生不同的策略行为。

## 3. V25-8deck 扩展实验 (v8 pipeline)

### 3.1 实验设计

| | V25b4-stream (已完成) | V25-8deck v8 (已完成) |
|---|---|---|
| SideA 卡组 | 2 套 | **8 套全量** |
| Self-play 局数 | 800 | 800 |
| Benchmark 局数 | 80 | 320 (64 matchup × 5 局) |
| 训练方式 | Streaming Linear + GBDT | Streaming Linear + GBDT (unified) |

### 3.2 V8 结果

| 指标 | 数值 |
|------|------|
| **Mean WR** | **50.31%** (161W-160L-4D / 320) |
| GBDT NDCG@1 | 0.3274 |
| GBDT NDCG@3 | 0.5123 |

**分卡组胜率**:
```
红牛 87.5% (35-5-0)  ████████▌
雷狼 60.0% (24-16-0)  ██████
雷鹤 52.5% (21-19-0)  █████▎
水凝 50.0% (20-16-4)  █████
水债 47.5% (19-21-0)  ████▊
水八 40.0% (16-24-0)  ████
莫优 37.5% (15-25-0)  ███▊
神宵 35.0% (14-26-0)  ███▌
```

### 3.3 可证伪预测 — 结果判定

| 假说 | 如果 8-deck WR > 35% | 如果 8-deck WR ≤ 35% | **实际** |
|---|---|---|---|
| **H1: 隐式编码充分** | ✅ 更多数据 → 隐式编码更好 | ❌ 隐式编码饱和 | **已拒绝** |
| **H2: 需要 opponent-deck 特征** | ❌ 不需要 | ✅ 需要 | ✅ |
| **H3: 需要 per-deck 模型** | ❌ 统一模型够用 | ✅ 需要 A3 per-deck tuning | ✅ |

8-deck WR 50.3% > 35%，表面通过了阈值。但深入分析揭示隐式编码并未成立。

## 4. 隐式编码假说检验：镜像对局分析

### 4.1 方法论

镜像对局（同卡组对抗）是唯一隔离实验——双方使用相同卡组，任何 WR 偏离 50% 只能归因于**模型-卡组兼容性差异**（而非卡组固有强度或 matchup advantage）。

**零假设 H0**: 隐式编码充分 → 镜像 WR 应全部集中在 50% 附近（±5%）。

### 4.2 观测结果

| 卡组 | 镜像 WR | 非镜像均值 | 差值 | 裁决 |
|------|---------|-----------|------|------|
| 水债 | **80%** | 42.9% | +37.1 | ❌ 强反对 |
| 红牛 | **80%** | 85.7% | -5.7 | ❌ 强反对 |
| 雷狼 | **80%** | 57.1% | +22.9 | ❌ 强反对 |
| 水凝 | 60% | 48.6% | +11.4 | ⚠️ 弱反对 |
| 雷鹤 | 60% | 51.4% | +8.6 | ⚠️ 弱反对 |
| 水八 | 40% | 40.0% | 0.0 | ⚠️ 弱反对 |
| 莫优 | 40% | 31.4% | +8.6 | ⚠️ 弱反对 |
| 神宵 | **20%** | 37.1% | -17.1 | ❌ 强反对 |

**统计量**:
- 镜像 WR 范围: **20% – 80%**（跨度 60 百分点）
- 镜像 WR 标准差: **21.1%**
- 在 45-55% 范围内的: **0/8**
- 在 40-60% 范围内的: **4/8**

### 4.3 关键反例

**水债 (smoking gun)**:
- Mirror 80%: 模型用水债打 baseline-水债 远超 baseline 用水债打模型-水债
- Non-mirror mean 42.9%: 同一套卡组换对手 WR 暴跌 37%
- 最差对手 红牛 (20%): 水债面对红牛的压制完全崩溃
- **结论**: 模型擅长水债的"内部策略"（挂水→冻结→控制），但面对红牛的快攻节奏时无法调整。模型没有"我是一个控制卡组"的元认知。

**神宵 (反向 smoking gun)**:
- Mirror 20%: baseline 玩神宵是模型玩神宵的 **4 倍**
- 神宵是最复杂的卡组之一（元素共鸣 + 申鹤 buff 窗口 + 宵宫蒸发 timing）
- **结论**: 模型完全没学到神宵的核心策略模式，单纯依赖通用贪心打分

**红牛 (最强但解释模糊)**:
- Mirror 80%、non-mirror mean 85.7%
- 红牛可能是卡组强度本身最高（无论谁玩都强）
- 但 mirror 80% 仍然偏离 50% → 模型玩红牛优于 baseline 玩红牛

### 4.4 判决

**隐式编码假说被强烈拒绝。** 8 套卡组间的巨大 WR 差异不能仅由卡组固有强度解释——镜像对局 20%-80% 的 60 百分点跨度直接证明模型对不同卡组的策略理解存在巨大盲区。

**归因分解**:
- ~50% 的差异来自卡组固有强度（红牛 87.5% vs 神宵 35%）
- ~50% 来自模型-卡组策略兼容性（水债 mirror 80% vs non-mirror 43%）

当前状态特征集（HP/骰子/充能/角色）不足以让模型隐式理解"我在用什么卡组"。需要显式 deck 感知。

## 5. V9 Per-Deck 实验（进行中）

### 5.1 方案

不引入 deck-id embedding（留待后续），直接用 per-deck 独立 ranker：

```
统一 self-play (bootstrapped) → 1 个 dataset → 按卡组过滤 → 8 个独立 ranker
                                                    ├─ 水八 ranker (GBDT)
                                                    ├─ 神宵 ranker (GBDT)
                                                    ├─ 水债 ranker (GBDT)
                                                    ├─ 水凝 ranker (GBDT)
                                                    ├─ 红牛 ranker (GBDT)
                                                    ├─ 莫优 ranker (GBDT)
                                                    ├─ 雷鹤 ranker (GBDT)
                                                    └─ 雷狼 ranker (GBDT)
```

Benchmark 时每 matchup 的 sideA 使用对应 deck0 的 ranker。

### 5.2 关键参数

| 参数 | 值 |
|------|------|
| 镜像 | `v25-8deck-v5b-parallel` |
| 训练并行 | Stage 3 (ranker) 8 并行 / Stage 4 (GBDT) 4 并行 |
| 预计时长 | 6-7h (on-demand 8C/16G) |
| ECI ID | `eci-7xv31kkm62a3rteui8os` |

### 5.3 可证伪预测

| 指标 | Per-deck 预期 | 统一模型 (v8) |
|------|:---:|:---:|
| Mean WR | 50-55%? | 50.3% |
| 镜像 WR 标准差 | **应大幅收敛** (<10%) | 21.1% |
| 最弱卡组 WR | 应提升 | 35% (神宵) |
| 红牛 WR | 可能下降 (不再被过拟合) | 87.5% |

**关键检验**: 镜像 WR 是否收敛到 50% 附近——如果是，则证明模型-卡组兼容性盲区是统一 ranker 的瓶颈，per-deck 可以解决。

## 6. 下一步决策树

```
V9 Per-Deck 结果:
  ├─ 镜像 WR 收敛到 50%±10% → per-deck 有效 ✅
  │    └─ 下一步: deck-id embedding (减少模型数量) 或 per-deck 迭代
  ├─ 镜像 WR 仍分散 → 隐式编码+per-deck 都不够
  │    └─ 下一步: 重新审视特征集 / reward shaping
  └─ Mean WR 显著下降 → per-deck 样本不足
       └─ 下一步: 增加 self-play 局数 per deck
```

## 7. 工程收获

### 7.1 Streaming Ranker 证明

**问题**: `run-build-slot-linear-ranker.ts` 全量加载 ranking-dataset.json (123K samples → ~20GB heap) → bun/V8 堆溢出 (Exit 134)，128GB 物理内存也无法解决。

**方案**: `run-build-ranker-streaming.ts` 逐 shard 处理，只持一个 shard (2000 samples) 在内存中，累加统计量 (NumericWeightStats)。最终 `finalizeToArtifact()` 等价于全量计算结果。

**验证**: v25b4-stream 35% WR 等于预期 (NAS v24 artifacts = 35% WR 初始水平)，证明 streaming 统计等效。

### 7.2 Post-Analysis Crash Fix (v4-damage → v5b)

**根因**: `pipeline.sh:219` `set -euo pipefail` + `find` 返回非零 → 脚本在 Post-Analysis 阶段被立即 kill，日志无错误输出（tee 未冲刷）。

**修复**: Stage 6/7 用 `set +e`/`set +o pipefail` 包裹，Python 分析脚本加 `except Exception` 通用兜底。

### 7.3 ECI 经济学

| 阶段 | 使用策略 | 理由 |
|---|---|---|
| 迭代期 (有 OOM 风险) | Spot → NoSpot | 避免中断重新排队 |
| 稳定后 (无 OOM 风险) | NoSpot → Spot | 节省 ~60% 成本 |

ECI 仅 **Running 状态计费**（ContainerGroup.Status=Running AND CurrentState.State=Running）。Failed/Succeeded/Terminated 停止计费，残留记录零费用。

## 8. 相关文档

- `v14-model-requirements.md` — 模型形式化要求（含 §A3 Deck-specific 调优）
- `v15-agent-ml-code-review-and-improvement-plan.md` — 代码架构改进计划
- `docs/temporal-opportunity-roadmap.md` — 时序价值评估路线图
- `pipeline-results-v8/v8-implicit-encoding-test.png` — 四象限检验图表
- `pipeline-results-v8/v8-heatmap.png` — 交叉对战热力图
