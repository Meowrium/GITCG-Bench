# V14 模型性质与要求

> 基于 V14 benchmark 三轮迭代（8.75% → 1.25% → 7.50% WR）的诊断，
> 结合 Deck Analytics 引擎的静态分析能力，推导模型应满足的完整性质集合。

---

## 目录

1. [V14 失败模式清单](#1-v14-失败模式清单)
2. [数学性质（Ranker/Value 必须满足）](#2-数学性质)
3. [博弈论性质（策略必须满足）](#3-博弈论性质)
4. [训练数据性质](#4-训练数据性质)
5. [架构性质](#5-架构性质)
6. [可验证性质（测试套件）](#6-可验证性质)
7. [优先级排序](#7-优先级排序)

---

## 1. V14 失败模式清单

### F1: R1 行动放弃（神宵 0% WR 主因）

**症状**：R1 零技能零出牌，全程 declareEnd，8 骰原封不动。
**出现**：神宵 vs 所有对手（5 场全败）
**根因**：`declareEnd` bias = **+0.0712**（正向奖励跳过回合），`useSkill` bias = **-0.0164**（负向惩罚攻击）。

### F2: 技能类型权重反转

**症状**：Ranker 学到的权重与实际价值完全相反。
**数据**：
| 特征 | V14 权重 | 应有方向 |
|------|---------|---------|
| `is_normal_attack` | +0.38 | 应 < E 技能（普攻弱） |
| `is_elemental_skill` | **-0.13** | 应强势正向（E 是核心） |
| `is_burst` | **-0.34** | 应强势正向（Q 是爆发） |

### F3: 卡牌过度出牌（Overplay Cascade）

**症状**：13 出牌 vs 2 技能（神宵 vs 雷鹤）。6.5:1 的出牌比。
**出现**：所有失利对局。
**根因**：`temporal_opt:deferred_bank` tag 权重 = **+1.28**，鼓励出储蓄类卡牌（派蒙、立本），加上 `playCard` bias = +0.11。MCTS 短视界看不到早期不出牌的长期代价。

### F4: MacroPlan 诱导连锁切人

**症状**：R1 4 次连续切人，4 骰浪费。
**出现**：macroPlanWeight=0.6 时。
**根因**：MacroPlan "切换到 X" 被解释为"每次向 X 的切换都对齐计划"，缺乏"只切一次"约束。

### F5: 训练-推理分布不匹配

**症状**：artifact 在 `mcts-gi-ml` kind 下效果远差于 `gi-ml-runtime`。
**数据**：V14 `mcts-gi-ml`（200 迭代）= 7.5%，预期 `gi-ml-runtime` 可能更低。
**根因**：artifact 在 MCTS 自对弈数据上训练（Pitfall 12b 的 bootstrap 问题），但 MCTS 的 PUCT prior 会放大 ranker 的偏见。

---

## 2. 数学性质

Ranker/Value 作为函数 `f: State × Action → ℝ` 必须满足：

### P1: 单调性（Monotonicity of Damage）

> 对于两个仅在目标 HP 上不同的状态，若 state_A 的 opponent HP 更低，则 state_A 的 state value 应 ≥ state_B 的 state value。

**形式**：∀ s₁, s₂: s₁.opp.hp ≤ s₂.opp.hp ∧ s₁ = s₂ otherwise → V(s₁) ≥ V(s₂)

**V14 违反**：Ranker 未见此性质的显式编码。导致"对手 1 HP 却不斩杀"的致命失误（Pattern 4.3）。

**验证**：构造两个仅 HP 不同的状态，检查 V(s₁) ≥ V(s₂)。

### P2: 行动价值下界（Action Value Lower Bound）

> 对于任意合法攻击动作 a（伤害 > 0），若它能造成击杀，则 Q(s, a) 必须 ≥ 任何非致死动作的 Q(s, a')。

**形式**：∀ a 使得 target.hp - damage(a) ≤ 0, ∀ a': Q(s, a) ≥ Q(s, a')

**V14 违反**：没有显式"斩杀奖励"信号。致命失误出现于 0 HP 目标不被优先攻击（Pattern 4.3）。

**实现**：在 ranker 中加入 `lethal_bonus` 特征（目标 HP ≤ 技能伤害 → +100 score）。

### P3: 充能单调性（Energy Monotonicity）

> 对于同一技能，若角色充能更接近 maxEnergy，则 bursts 的 Q 值应单调增加（非减）。

**形式**：若 burst 需要 E_max 能量，则 Q(s, burst) 随 s.active.energy 单调不减。

**V14 违反**：`is_burst` = **-0.34**，对 burst 的负权重是固定的，不随充能状态改变。结果是充能满时仍避免用 Q。

**正确行为**：Ranker 中 `is_burst` 的权重应乘以 `energy / maxEnergy`。

### P4: 骰子效率（Dice Efficiency）

> 模型不应偏好骰子效率低（damage/dice < 0.5）的行动，当存在效率 > 1.0 的替代行动时。

**形式**：设 dmg/dice 为技能/卡牌的伤害效率。若存在 a₁ 使得 dmg(a₁)/dice(a₁) > 1.0，则不应选择 dmg(a₂)/dice(a₂) < 0.5 的 a₂（除非 a₂ 有其他不可替代的战略价值）。

**V14 违反**：卡牌出牌（dmg/dice = 0）压倒攻击（dmg/dice ≥ 0.67 对 3 骰 2 伤普攻）。

**验证**：用 Deck Analytics 为每个卡组算 R1 最优骰子分配，检查模型是否接近。

### P5: 反应优先级（Reaction Priority）

> 若能触发 +2 反应（Melt/Vape），其 Q 值应 ≥ 同骰子消耗的 0 反应攻击。

**形式**：设 a₁ 触发 reactionBonus = +2, a₂ 触发 reactionBonus = 0，且 dice(a₁) = dice(a₂)。
则 Q(s, a₁) ≥ Q(s, a₂)。

**V14 违反**：未发现明确的反向，但 `reaction_damage_bonus` 权重仅 +0.11，收益太弱。

### P6: R1 行动下界（R1 Action Lower Bound）

> R1（round=1）时的 declareEnd 不能是最高分动作，除非所有其他动作均不可行。

**形式**：∀ s 使得 s.round = 1, s.dice ≥ 3, s.activeChar 至少有一个可行技能：
Q(s, declareEnd) < min_{a ∈ feasibleSkills(s)} Q(s, a)

**V14 违反**：**F1** — declareEnd = +0.0712 直接违反此性质。

**强制方法**：在 R1 给 declareEnd 施加 -10 惩罚（或更优雅：round-based bias 调整）。

---

## 3. 博弈论性质

### G1: 先手优势（First-Move Advantage）

> 模型在 R1 应认识到"先手进攻者迫使对手被动响应"。这意味着 R1 的技能使用率应 ≥ 60%。

**形式**：设 R1 行动序列为 A₁, ..., Aₖ。则 |{a ∈ A : a 为 skill}| / k ≥ 0.6。

**V14 违反**：神宵 R1 技能率 = 0%，水八 R1 技能率 = 25~33%。

**验证**：benchmark 统计 R1 ratio。

### G2: 对手资源感知（Opponent Resource Awareness）

> 当对手 dice 耗尽且无快速行动时，模型应识别"我是最后一个行动者"，并调整策略（如使用高费技能而非留骰）。

**形式**：若 opponent.dice = 0 且 无 fast actions：
则 Q(s, highCostSkill) 的相对优势应增大（因为不会被反击）。

**V14 状态**：未见对手 dice 感知特征。`opponent_summary` 可能有此数据但 ranker 未使用。

### G3: 资源边际价值（Marginal Resource Value）

> 第 N 颗同色骰的边际价值递减。当已有 5+ 同色骰时，额外的同色骰价值低于万能骰。

**形式**：ΔV / Δpyro (at pyro=5) < ΔV / Δomni (at omni=1)

**V14 状态**：`dice_match_ratio` 权重 +0.20 只考虑"匹配率"，未建模边际价值。

### G4: 换人代价感知（Switch Cost Awareness）

> 每次切人消耗 1 骰（快切除外）。模型应只在切换收益 ≥ 1 骰等价价值时才切换。

**形式**：若切换前后预期伤害差 < 1 骰等价价值，则不应切换。

**V14 违反**：MacroPlan 诱导的连锁切人（Pattern 4.6），每次切换看似"对齐计划"但累计浪费 3-4 骰。

---

## 4. 训练数据性质

### T1: 搜索深度充分性（Search Depth Sufficiency）

> 自对弈数据的 MCTS 深度必须 ≥ 能看到"R1 攻击→R2 对手残血→R3 斩杀"的完整因果链。

**量化**：设平均回合数 = 8，每回合行动数 = 3，则完整因果链约 24 步。
MCTS depth = 3 只能看到约 9 步（3 层 × 3 actions/layer），不足。

**要求**：自对弈 MCTS depth ≥ 5，迭代 ≥ 200。

### T2: 数据分布覆盖（Coverage）

> 训练数据必须包含"做对了"的正例。若数据中几乎没有 E 技能优先于普攻的正例，rankr 无法学到 E 技能的价值。

**量化**：训练数据中 is_elemental_skill=1 的样本比例应 ≥ is_normal_attack=1 的比例。
若比例 < 0.5，说明数据偏向普攻 → ranker 会学到错误的偏好。

**V14 数据**：未知，但 ranker 权重 is_elemental_skill = -0.13 强烈暗示数据中 E 技能的正例不足。

### T3: Bootstrap 迭代要求（Bootstrap Iteration）

> 新特征加入后，至少需要 1 轮 bootstrap（用旧 artifact 生成数据 → 训练新 artifact → 用新 artifact 生成数据 → 再训练）。

**V14 违反**：29 个 P3 特征一次性加入，但在单一轮 MCTS 自对弈数据上训练，没有 bootstrap（Pitfall 12b）。

### T4: 胜率下界（Win Rate Floor）

> 训练 artifact 对 baseline 的胜率应 ≥ 30%。若 < 30%，说明 artifact 本身有问题，不应作为 MCTS prior 使用。

**V14**：7.5% WR — 远低于此界限。

---

## 5. 架构性质

### A1: 分离 ranker prior 与 MCTS search

> Ranker 提供先验分布 P(action|state)，MCTS 在此基础上搜索。若 ranker 的先验过于偏离最优策略，MCTS 需要更多迭代来矫正。

**量化**：设 ranker prior 与最优策略的 KL 散度为 D_KL。则在 MCTS 迭代数 I 下，
策略质量 ≈ optimal - O(D_KL / √I)。

**V14 问题**：D_KL 很大（ranker bias 完全反向），I = 200 不够矫正。

**要求**：训练 artifact 应先通过 `gi-ml-runtime`（纯 greedy）测试。若 greedy WR < 20%，MCTS 也不会有救。

### A2: MacroPlan 不应覆盖 Ranker 基本判断

> MacroPlan 应作为"软约束"（建议方向），而非硬覆盖。其权重应 ≤ 0.3。

**V14 问题**：macroPlanWeight = 0.6 时，MacroPlan 可覆盖 ranker 的输出，导致连锁切人和过度出牌。

**要求**：macroPlanWeight ∈ [0, 0.3]，对大部分卡组设为 0。

### A3: Deck-specific 调优能力

> 不同卡组的理想行为偏向不同。架构应支持 per-deck 的 bias 调整。

**V14 状态**：单一 artifact 用于所有卡组。神宵需要高 E 技能权重，水八需要高召唤物权重，但两者被迫共享权重。

**要求**：至少支持 per-deck 的 action_case_bias 覆写，理想情况支持 per-deck ranker 微调。

### A4: 可解释性（Explainability）

> 每次决策应能分解为"基础分 + 反应奖励 + 充能奖励 + 骰子效率 + MacroPlan 调整 + MCTS 搜索增量"。

**V14 状态**：`CandidateScoreBreakdown` 接口已定义（`types.ts:162-180`），但 ranker 内部未全部填充。

**要求**：所有 scoring component 必须在决策日志中可追踪。

---

## 6. 可验证性质（测试套件）

以下测试可在不运行完整 benchmark 的情况下验证：

### V1: R1 不为空测试

```typescript
// 对每个 benchmark 卡组，模拟 R1：
// - 8 颗角色同色骰
// - 对手 10 HP，无附着
// - 预期：至少使用 1 个技能（dice spent ≥ 3）
expect(r1DiceSpent).toBeGreaterThanOrEqual(3);
```

### V2: 斩杀优先测试

```typescript
// 状态：对手 1 HP，我方 8 骰，有 3 骰 2 伤技能
// 预期：选择该技能的概率 ≥ 90%
const state = createKillableState();
const bestAction = policy.choose(state);
expect(bestAction.type).toBe("useSkill");
```

### V3: declareEnd 非最优测试

```typescript
// 状态：R1，8 骰，所有技能可用
// 预期：declareEnd 的 score < 任何技能的 score
for (const skill of availableSkills) {
  expect(score("declareEnd")).toBeLessThan(score(skill));
}
```

### V4: 充能感知测试

```typescript
// 状态 A：0 能量 → burst score 应很低
// 状态 B：满能量 → burst score 应显著提高
const scoreA = ranker.rank(stateWith0Energy, burstAction);
const scoreB = ranker.rank(stateWithMaxEnergy, burstAction);
expect(scoreB).toBeGreaterThan(scoreA);
```

### V5: 反应感知测试

```typescript
// 同一技能，对手有冰附着 vs 无附着
// Melt 版本 score 应 ≥ 无反应版本 score + 2（反应奖励）
expect(scoreMelt).toBeGreaterThanOrEqual(scoreNoReaction + 2);
```

### V6: 骰子效率测试

```typescript
// 8 骰，两个可选行动：A 是 3 骰 3 伤，B 是 3 骰 0 伤（卡牌）
// 预期：A 的 score > B 的 score
expect(scoreA).toBeGreaterThan(scoreB);
```

---

## 7. 优先级排序

| 优先级 | 性质 | 影响 | 实现难度 |
|--------|------|------|---------|
| **P0** | P6: R1 行动下界 | 修复 0% WR（神宵） | 低（bias 调整） |
| **P0** | P2: 斩杀优先 | 修复致命失误 | 低（加特征） |
| **P0** | T1: 搜索深度 ≥ 5 | 训练数据质量 | 中（改自对弈配置） |
| **P1** | P3: 充能单调性 | Burst 使用率 | 低（权重 × energy/max） |
| **P1** | P5: 反应优先级 | 伤害最大化 | 低（增加反应权重） |
| **P1** | T2: 数据分布覆盖 | E 技能正例 | 中（需要新自对弈数据） |
| **P2** | G4: 换人代价感知 | 减少无效切人 | 中（加特征） |
| **P2** | A3: Deck-specific 调优 | 卡组差异化 | 中（架构改动） |
| **P3** | A4: 可解释性 | 调试效率 | 低（填充已有接口） |
| **P3** | G2: 对手资源感知 | 终盘决策 | 中（加特征） |

**立即执行建议**：

1. **P0-1**: 在数据加载时直接对 `declareEnd` 施加负 bias（已在 V14-fix3 artifact 中完成）
2. **P0-2**: 加入 `lethal_bonus` 特征：`target.hp ≤ skill.damage → score += 100`
3. **P0-3**: 修改自对弈配置 `mctsMaxDepth: 5, mctsIterations: 200` → 生成 V15 训练数据
4. **P1-1**: `is_burst` 权重从固定 -0.34 改为 `+0.5 × (energy/maxEnergy)`
5. **P1-2**: 重训 artifact，验证 V1-V6 测试套件通过后再跑 benchmark

**预期**：若 P0 三项全部完成，V15 artifact 对 baseline WR 应 ≥ 25%（从 7.5% 提升 3.3×）。
