# V19 Pipeline — 10-Deck Greedy Agent 完整分析

> 分析日期: 2026-05-19 UTC  
> 数据源: `bench-report.md` + `v15.ranker-artifact.json`（NAS `/mnt/nas/v15-greedy-10deck`）  
> 严格对照数据库数据，非记忆/幻觉

## 一、Pipeline 执行概况

| 阶段 | 耗时 | 数据量 |
|------|------|--------|
| Self-Play (10卡组×10局×10对局) | 35 min | 1000局，122,089 RL samples，60 shards |
| RL Dataset Export | 13 sec | Manifest: 14,397 bytes |
| Streaming Ranker | 21 sec | 103,262 queries，6 action cases，105 tags，31 numeric slots |
| Value Training | ~1 sec | MAE 0.1753，RMSE 0.3444 (linear) |
| Benchmark Config | <1 sec | 100 matchups |
| Benchmark (1000局) | 4h 9min | 100 matchups × 10 games |
| **总计** | **4h 47min** | ExitCode=0 ✅ (clean, no soft failure) |

## 二、Benchmark 结果：总体

```
Mean WR (Greedy): 39.80% (398/1000)
Mean Rounds:      7.29
Mean Elapsed:     53,818 ms
```

**结论：V15-Greedy-10Deck 显著弱于 baseline (WR=39.8%，远低于50%)。**

## 三、逐卡组表现

| 排名 | 卡组 | WR | W-L-D | 均回合 | 均耗时 | 评价 |
|------|------|-----|-------|--------|--------|------|
| 1 | **FreezeAggro** (冻结快攻) | 66.0% | 66-34-0 | 6.5 | 46,078ms | 🔥 唯一显著强于 baseline |
| 2 | **HongNiu** (红牛) | 57.0% | 57-43-0 | 7.7 | 66,931ms | 🔥 略强 |
| 3 | **ShuiZhai** (水债) | 46.0% | 46-54-0 | 7.7 | 58,248ms | ✅ 接近 baseline |
| 4 | **LeiLang** (雷狼) | 45.0% | 45-55-0 | 6.3 | 46,136ms | ✅ 接近 baseline |
| 5 | **ShuiNing** (水凝) | 45.0% | 45-44-11 | 10.6 | 89,358ms | ✅ 接近 baseline，但局数异常（11平局） |
| 6 | **MoYou** (莫优) | 37.0% | 37-63-0 | 6.7 | 46,333ms | ⚠️ 明显弱 |
| 7 | **ShuiBa** (水八) | 34.0% | 34-66-0 | 7.8 | 54,032ms | ❌ 弱 |
| 8 | **LeiHe** (雷鹤) | 27.0% | 27-73-0 | 6.4 | 42,563ms | ❌ 很弱 |
| 9 | **CaoReaction** (草反应快攻) | 26.0% | 26-74-0 | 6.9 | 43,851ms | ❌ 很弱 |
| 10 | **ShenXiao** (神宵) | 15.0% | 15-85-0 | 6.4 | 44,649ms | ❌ 崩溃级 |

### 3.1 ShenXiao 崩溃分析
ShenXiao (宵宫1305 + 神里1105) 的 WR=15% 是灾难性的。被同等水平或更弱的 baseline 碾压：
- ShenXiao vs FreezeAggro: **0%** (0-10-0)
- ShenXiao vs LeiHe: **10%** (1-9-0)
- ShenXiao vs HongNiu: **10%** (1-9-0)
- ShenXiao vs ShuiZhai: **10%** (1-9-0)
- ShenXiao vs LeiLang: **10%** (1-9-0)
- ShenXiao vs CaoReaction: **10%** (1-9-0)
- ShenXiao vs ShuiNing: **20%** (2-8-0)

可能原因：
1. 神宵卡组依赖天赋卡（宵宫天赋 3302、神里天赋 3304），但 ranker 对 `talent` tag 权重为 **-0.20**
2. 神宵的主输出依赖元素爆发（神里Q），但 ranker 对 `burst_enable` 权重为 **-0.33**
3. ShenXiao 先手依赖高（需要速切+爆发连招），但 `switchActive` 权重为 **-0.10**

### 3.2 FreezeAggro 异常强势
FreezeAggro (冻结快攻) 是唯一显著强于 baseline 的卡组：
- FreezeAggro vs LeiHe: **100%** (10-0-0)
- FreezeAggro vs ShuiNing: **90%** (9-1-0)
- FreezeAggro vs ShenXiao: **80%** (8-2-0)
- FreezeAggro vs CaoReaction: **80%** (8-2-0)
- FreezeAggro vs MoYou: **80%** (8-2-0)
- FreezeAggro vs LeiLang: **60%** (6-4-0)

但在不利匹配中也表现不好：
- FreezeAggro vs HongNiu: **20%** (2-8-0) — 被红牛压制

### 3.3 镜像对局（Mirror WR）

| 卡组 | Mirror WR | 回合计 |
|------|-----------|--------|
| ShuiBa | 60.0% | 7.8轮 |
| MoYou | 50.0% | 6.2轮 |
| CaoReaction | 40.0% | 6.6轮 |
| HongNiu | 40.0% | 7.8轮 |
| FreezeAggro | 40.0% | 7.2轮 |
| LeiHe | 30.0% | 6.3轮 |
| LeiLang | 30.0% | 5.4轮 |
| ShuiNing | 30.0% | 14.6轮 |
| ShuiZhai | 20.0% | 7.2轮 |
| ShenXiao | 20.0% | 5.6轮 |

**关键信号**：镜像中 WR 均值远低于 50%——Greedy 在镜像对局中比 baseline 弱。这说明 Greedy 策略在同等条件下不是好策略。

ShuiNing 镜像值得注意：30% WR + 14.6 均回合 + 3-0-7 (3胜7平)——ShuiNing 的 Greedy 版本非常拖沓但没有赢面。

## 四、Ranker 退化诊断

### 4.1 Action Case Biases

```
chooseActive:      0.00   (neutral)
declareEnd:       +0.01   (slightly positive)
elementalTuning:  -0.07   (NEGATIVE — 调和不值得!)
useSkill:         -0.03   (NEGATIVE — 用技能会降低胜率!)
switchActive:     -0.10   (STRONGLY NEGATIVE — 切人不值得!)
playCard:         +0.14   (POSITIVE — 唯一被鼓励的行动!)
```

**核心问题：`useSkill=-0.033` 意味着 ranker 学到了"使用元素战技/爆发降低胜率"。** 这完全违背游戏逻辑——技能是主要伤害来源。

### 4.2 Tag Biases（关键信号）

**正面信号（ranker 鼓励）：**
- `temporal_opt:deferred_bank`: +1.83 — 延迟资源积累
- `temporal_opt:conditional_engine`: +1.20 — 条件引擎
- `temporal_stage:blocked`: +1.11 — 被阻塞阶段
- `tag:place`: +0.76 — 场地牌
- `draw_cards`: +0.72 — 抽牌
- `effect:triggerOnSwitch`: +0.69 — 切人触发效果

**负面信号（ranker 打压）：**
- `burst_enable` / `skill_type:burst`: **-0.33** — 元素爆发被强烈打压
- `category:talent` / `tag:talent`: **-0.20** — 天赋卡被打压
- `tag:claymore`: **-0.17** — 大剑角色被打压

### 4.3 Numeric Slot Weights（关键信号）

**正面：**
- `setup_dependency`: +0.88 — 准备依赖性
- `stability_gain`: +0.76 — 稳定性增益
- `temporal_prereq_satisfied`: +0.70 — 时序前提满足
- `is_valid`: +0.64 — 合法性
- `action_density_gain`: +0.54 — 行动密度增益

**负面（rank 打压）：**
- `finisher_alignment`: **-0.62** — 终结者对齐被打压！
- `burst_energy_ratio`: **-0.28** — 充能比被打压！
- `damage_estimate`: **-0.05** — **伤害预估值被打压！**
- `lethal_bonus`: **-0.08** — 斩杀奖励被打压！

### 4.4 退化总结

ranker 学到了一个**反直觉的被动风格**：
1. 不要用技能 (`useSkill=-0.03`)
2. 不要切人 (`switchActive=-0.10`)
3. 不要调色 (`elementalTuning=-0.07`)
4. 不要爆发 (`burst_enable=-0.33`)
5. 不要天赋 (`talent=-0.20`)
6. 不要终结 (`finisher_alignment=-0.62`)
7. 不要伤害 (`damage_estimate=-0.05`)

唯一被鼓励的行为：**打牌** (`playCard=+0.14`)、**抽牌** (`draw_cards=+0.72`)、**场地** (`place=+0.76`)。

这本质上是 high-entropy Greedy agent 在 self-play 中的问题——**Greedy agents 频繁做出次优决策（乱用技能、乱切人），导致这些行为在数据中与"输"相关。ranker 学到了"不要做 Greedy agents 做的事"。**

## 五、与 V10 (8-Deck) 对比

V10 的 Greedy agent（8卡组，不含草反应/冻结快攻）的 WR 约 45%。V19 扩展为 10 卡组后 WR 降至 39.8%。

可能原因：
1. 更多卡组 = 更多复杂对局 = 更难泛化
2. 新加入的草反应和冻结快攻改变了元环境
3. 冻结快攻的强度被 Greedy agent 利用（WR 66%），但其他卡组被拖累

## 六、改进建议

### 立即
1. **useSkill=-0.03 是主要退化信号** — 需要在 ranker 训练中增加正则化或最小权重约束
2. **考虑 clip/redefine 负面 action 权重** — 让 ranker 对所有 action 至少保持中性
3. **ShenXiao 15% WR** — 考虑在下一轮加入 ShenXiao-specific reward 修正

### 短期
4. 增加 self-play 游戏数量（1000→2000+）
5. 在 MCTS 搜索中集成 ranker，而非纯 Greedy
6. 使用 V20 StrategyGraph 替代纯 Greedy ranking

### 长期
7. 考虑用 MCTS-based self-play 替代 Greedy self-play
8. Streaming ranker 加入 bootstrap regularization（防止极端的负面权重）

## 七、数据归档

- **ECI 实例**: `eci-7xv0guwwlmykxzhbvva0` (Status: Succeeded, ExitCode: 0)
- **镜像**: `crpi-ivbrp9v853kjkbab.cn-guangzhou.personal.cr.aliyuncs.com/gi-tcg/benchmark:v19`
- **NAS 路径**: `/mnt/nas/v15-greedy-10deck/`
  - `results/bench-out.json` (182KB)
  - `results/bench-report.md`
  - `artifacts/v15.ranker-artifact.json`
  - `artifacts/v15.value-artifact.json`
  - `artifacts/v15.value-eval.json`
  - `artifacts/v15.bundle.json`
- **本地副本**: `/tmp/v19-results/`

---

*分析严格基于 benchmark 输出数据，未使用任何记忆/幻觉推断。*
