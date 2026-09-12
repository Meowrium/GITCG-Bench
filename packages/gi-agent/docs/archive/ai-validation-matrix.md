# AI 验证矩阵 (AI Validation Matrix)

> 日期: 2026-05-17  
> 范围: GI-TCG AI 决策系统质量检验  
> 关联: `v14-model-requirements.md`, `v26-hidden-constraints-validation-plan.md`, `v27-transition-constraints-formalization.md`

## 1. 目的

除胜率外，用多维度定量指标检验 AI 策略质量。每个指标有：
- **阈值**：通过/失败标准
- **实现**：测试文件或脚本路径
- **依赖**：需要哪些基础设施

---

## 2. A 类 — 数学性质（合成单元测试）

不依赖 engine，纯 score 函数测试。每次修改策略代码后必须全部通过。

| # | 测试 | 断言 | 测试文件 | 状态 |
|:--:|------|------|------|:--:|
| V1 | R1 不为空 | R1 有骰有技能时不选 declareEnd | `model-requirements.test.ts` | ✅ |
| V2 | 斩杀优先 | 可斩杀时 top-1 = useSkill | 同上 | ✅ |
| V3 | declareEnd 非最优 | R1 时 end score < 任何技能 score | 同上 | ✅ |
| V4 | 充能感知 | 满能量 burst score > 0 能量 | 同上 | ✅ |
| V5 | 反应感知 | 有附着技能 score > 无附着 | 同上 | ✅ |
| V6 | 骰子效率 | 高伤技能 score > 零伤出牌 | 同上 | ✅ |

**运行**: `bun test src/evaluation/requirements-tests/model-requirements.test.ts`

---

## 3. B 类 — 行为计数器（Benchmark Replay）

从 benchmark 对局 replay 中统计行为频率。**不评分，只计数**。

### B1: declareEnd 与行动权

| 计数器 | 目标 | 阈值 |
|--------|:--:|------|
| `r1_p0_skill_rate` | ↑ | ≥ 60% |
| `declare_end_explicit` | ↓ | < 5% of turns |
| `declare_end_with_dice_remaining` | ↓ | < 5% of turns |
| `declare_end_with_opp_ended` | ↓ | < 2% of turns |

### B4: 支援/召唤位

| 计数器 | 目标 | 阈值 |
|--------|:--:|------|
| `support_played_total` | 中性 | 记录 |
| `support_replacement` | ↓ | < 1 per game |
| `support_before_first_skill_r1` | ↓ | < 1.5 per game |

### B7: 先后手节奏

| 计数器 | 目标 | 阈值 |
|--------|:--:|------|
| `r1_p0_skill_rate` | ↑ | ≥ 60% |
| `r1_p1_skill_rate` | 合理范围 | 40-70% |

**运行**: `python3 scripts/count-behaviors.py --batch <replay-dir>`

---

## 4. C 类 — Branch-Eval（待实现）

验证被 transition scorer 翻转的 top-1 是否真的更好。

| 指标 | 含义 | 阈值 |
|------|------|:--:|
| `branch_diff_mean` | 翻转动作的平均 lift | > 0 |
| `branch_negative_lift_rate` | 翻转后降低的比例 | < 20% |

**依赖**: engine continuation 基础设施（P0-2: MCTS adapter）

---

## 5. D 类 — 决策日志可解释性

验证策略输出的 ranking 和 reasons 是否可用于诊断。

| # | 测试 | 断言 | 测试文件 | 状态 |
|:--:|------|------|------|:--:|
| D1 | top-1 reasons 非空 | `reasons.length > 0` | `decision-explainability.test.ts` | ✅ |
| D2 | 全候选 reasons | 所有 ranked 都有 reasons | 同上 | ✅ |
| D3 | heuristicScore = finalScore | BaselinePolicy 一致性 | 同上 | ✅ |
| D4 | declareEnd reason | reasons 含 "end"/"penalty" | 同上 | ✅ |
| D5 | 降序排列 | finalScore 严格非增 | 同上 | ✅ |

**运行**: `bun test src/evaluation/requirements-tests/decision-explainability.test.ts`

**差距**: `CandidateScoreBreakdown` 接口已定义但尚未在 `RankedPolicyCandidate` 中填充。后续需补：
- `giMlScore`, `guardrail`, `macroPlanAdjustment` 等 17 个字段
- 每个 H 约束独立 reason 输出

---

## 6. E 类 — Per-Deck 诊断

从 benchmark 结果中拆解每套卡组的多维度表现。

### 全局指标

| 指标 | v9c 值 | 目标 |
|------|--------|------|
| Mean WR | 45.9% | ≥ 50% |
| Per-Deck StdDev | 16.9% | < 10% |
| Mirror WR StdDev | 17.3% | < 10% |
| Avg Asymmetry | 24.3% | < 10% |

### Per-Deck 分类

| 分类 | 卡组 | 特征 |
|:--:|---|------|
| 统治级 (>60%) | 水债(62.5%), 红牛(80.0%) | 快攻/反应策略理解优秀 |
| 挣扎级 (<35%) | 神宵(27.5%), 莫优(25.0%) | combo/多阶段卡组完全失败 |
| 波动级 (std>25) | 水八(33.2%), 水凝(26.0%) | 对特定对手极端分化 |

### 镜像对局不对称（最严重 5 对）

| sideA vs sideB | A→B | B→A | asym |
|:---|---:|---:|--:|
| 水八 vs 雷鹤 | 0% | 100% | 100% ⚠️ |
| 水八 vs 莫优 | 20% | 100% | 80% ⚠️ |
| 水八 vs 水凝 | 100% | 40% | 60% |
| 神宵 vs 莫优 | 40% | 80% | 40% |
| 神宵 vs 雷鹤 | 60% | 20% | 40% |

**解释**: 100% 不对称说明 P0/P1 先后手对某些 matchup 影响极大，当前策略对不同 side 的策略一致性差。

**运行**: `python3 scripts/per-deck-diagnostics.py`

---

## 7. 实现状态汇总

| 阶段 | 内容 | 文件 | 状态 |
|:--:|------|------|:--:|
| A | V1-V6 合成单元测试 | `src/evaluation/requirements-tests/model-requirements.test.ts` | ✅ 6/6 pass |
| B | B1+B4+B7 行为计数器 | `scripts/count-behaviors.py` | ✅ 可用 |
| C | Branch-Eval 验证 | 待实现 | 🔴 依赖 P0-2 |
| D | D1-D5 决策日志 | `src/evaluation/requirements-tests/decision-explainability.test.ts` | ✅ 5/5 pass |
| E | Per-Deck 诊断 | `scripts/per-deck-diagnostics.py` | ✅ 已出报告 |

---

## 8. 下一步

1. **补齐 B 类计数器**: 在 benchmark 结果中嵌入 `--counters` 标记，每次 benchmark 自动输出 B 类 report
2. **C 类 Branch-Eval**: 依赖 MCTS engine-continuation adapter (P0-2)
3. **D 类升级**: 将 `CandidateScoreBreakdown` 填充到 `RankedPolicyCandidate` 中
4. **B2-B8 全量计数器**: H2(骰子), H3(附着), H5(角色), H6(对手), H8(手牌), H9(隐藏) — 随 H 约束实现逐步加入
5. **CI gate**: `bun test src/evaluation/requirements-tests/` 作为 pre-push hook
