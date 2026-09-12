# 方案 A+：行动级状态特征注入

> 状态：已实现（iter-015 待训练验证）
> 日期：2026-04-28
> 关联迭代：iter-013（pending_method 特征已上线）→ iter-015（本方案目标，特征已添加至代码）

---

## 1. 问题诊断

### 1.1 核心现象

iter-014 对 iter-013 的 benchmark replay 中观测到时序感知失效：

| 选手 | R1 操作 | 问题 |
|------|---------|------|
| 014 (红牛) | **交给我吧！**（速切，下一切人变为快速行动） | R1 无轮次争夺需求，无击杀可能，无防守压力。1 费完全浪费。 |
| 013 (雷鹤) | **自由的新风**（秘传，整局一次：本回合击杀后可再动一次） | R1 伤害输出不足以造成任何减员，打出后本局再无连杀机会。 |

这两手牌如果在 **R3-R4 高压轮次**打出，都是决定性优势牌。问题在于：模型在错误的时间把它们打出去了。

### 1.2 根因分析

当前价值模型（LightGBM）对同一张卡牌在不同时间点的评估趋同。具体来说：

**R1 状态（8 骰，0 伤害，满血）→ 模型给"自由的新风"评分：0.62**
**R3 状态（5 骰，敌方出战 3hp，我有充能）→ 模型给"自由的新风"评分：0.64**

差异只有 0.02——模型几乎看不出这两个状态的区别。

原因不在模型架构，而在**特征集无法描述这两个状态的关键差异**：

- 现有特征 `ko_pressure_now` 是一个聚合标量。R1 时它约 0.1，R3 时约 0.4——但这对模型来说只是"一个数字变了"，不够尖锐。
- 模型真正需要知道的是：**"敌方出战角色 3hp，我下一击打 4——我能杀。"** 这是一个需要两棵树联合才能发现的 AND 关系，但当前特征集把这两件事的信息分别压缩到了 `opponent.active_health` 和 `derived.self_damage_capacity_now` 两个标量中，中间没有任何结构信息提示模型把它们做交叉。

### 1.3 设计原则

> **不给模型预计算的结论，给它做计算所需的全部原料。让 LightGBM 通过树分裂自己发现组合规律。**

- ❌ `kill_threat = enemy_hp ≤ my_damage ? 1 : 0`（人造特征，规则可能错误或不完整）
- ✅ 同时提供 `enemy_active_hp=3`, `my_skill_damage_normal=4`, `my_dice_remaining=5`，让模型自己学出 "hp ≤ damage AND dice ≥ cost → high value"

---

## 2. 特征设计

### 2.1 粒度原则

七圣召唤一个回合内可能有 6-10+ 次行动。每次行动后骰子、血量、元素附着、角色存活都发生稠密变化。

**所有新增特征在每次行动后都重新计算**——天然是行动级粒度，不是回合级。

### 2.2 新增特征清单

#### 2.2.1 敌方精确 HP（绝对值）

**当前缺失：** 现有 `opponent_characters.c{i}_hp_ratio` 只有 HP 比例，没有绝对值。

| 特征名 | 类型 | 含义 |
|--------|------|------|
| `opponent_characters.c0_hp` | int | 0 号位绝对 HP |
| `opponent_characters.c1_hp` | int | 1 号位绝对 HP |
| `opponent_characters.c2_hp` | int | 2 号位绝对 HP |

**为什么需要：** 3/10hp 和 3/6hp 的 `hp_ratio` 都是 0.3，但前者（满血大肉）没有击杀威胁，后者（丝血角色）是斩杀窗口。绝对 HP 区分了这两种情况。

**数据来源：** `observation.opponent.characters[i].health`

#### 2.2.2 板凳最脆弱目标

**当前缺失：** 完全不知道对面板凳里谁最危险/最脆弱。

| 特征名 | 类型 | 含义 |
|--------|------|------|
| `opponent_bench.min_hp` | int | 板凳（非出战）角色中最低 HP |
| `opponent_bench.min_hp_index` | 0/1/2 | 该角色的槽位索引 |

**为什么需要：** "自由的新风"不只考虑出战角色。如果对面板凳有人 1hp，切过去补一刀也可触发连杀。这个特征告诉模型"对面有没有可以被收割的残血"。

**数据来源：** 从 `observation.opponent.characters` 排除 `active_character_index` 后计算。

#### 2.2.3 出战角色状态阻拦

**当前缺失：** 没有冻结、眩晕、护盾信息——这些直接改变斩杀线。

| 特征名 | 类型 | 含义 |
|--------|------|------|
| `opponent_active.is_frozen` | 0/1 | 敌方出战是否被冻结 |
| `opponent_active.is_stunned` | 0/1 | 敌方出战是否被眩晕 |
| `opponent_active.shield` | int | 敌方出战护盾量（改变斩杀线） |

**为什么需要：** 冻结 → 敌方不能动 → "交给我吧"抢轮次没有意义。护盾 3 点 → 本来 3hp 能杀变成了需要 6 伤 → 自由的新风的窗口是假的。模型必须在特征空间里能看到这些。

**数据来源：** `observation.opponent.characters[active_idx].entities` 中查找 `"Frozen"`, `"Stun"`, `"Shield"` 等状态。

#### 2.2.4 我方下一击预估伤害

**当前缺失：** `damage_capacity_now` 是聚合标量，不区分 N/E/Q 技能，也不清楚是对谁的伤害。

| 特征名 | 类型 | 含义 |
|--------|------|------|
| `self_active.skill_damage_normal` | int | 普攻预估伤害（含武器/ Buff） |
| `self_active.skill_damage_skill` | int | E 技能预估伤害 |
| `self_active.skill_damage_burst` | int | Q 大招预估伤害 |
| `self_active.energy_full` | 0/1 | 大招是否可用（energy ≥ max_energy） |

**为什么需要：** 模型需要比较 `enemy_active_hp ≤ damage`。这要求 damage 是具体的数字。
- 普攻打 3，敌 4hp → 杀不了
- E 技能打 5，敌 4hp → 能杀 → 自由的新风窗口打开

`damage_capacity_now` 是一个加权聚合值，丢失了"不同技能有不同伤害"的信息。

**数据来源：** 
- `skill_damage_*`：需从 `CharacterObservationV1` 的 `skills` 字段提取 base damage + 装备修正
- `energy_full`：`character.energy >= character.max_energy`

> **⚠️ 待确认：** `CharacterObservationV1` 当前是否暴露了技能伤害信息。如未暴露，需先在 `gi-agent` 的 observation builder 中添加。备选方案：用 `definition_id` + 本地查表计算近似伤害。

#### 2.2.5 骰子 — 攻击可行性

**当前缺失：** 有骰子总数 (`dice_count`) 和万能骰数 (`omni_count`)，但没有"够不够打出下一击"的直接特征。

| 特征名 | 类型 | 含义 |
|--------|------|------|
| `self.can_afford_normal` | 0/1 | 骰子够不够普攻（≥ 普攻所需骰子） |
| `self.can_afford_skill` | 0/1 | 骰子够不够 E 技能 |
| `self.can_afford_burst` | 0/1 | 骰子够不够 Q 大招 |

**为什么需要：** "知道能杀"和"杀得了"是两件事。如果只剩 1 骰，就算敌 1hp、我普攻打 3，这回合也杀不了——因为根本没骰子出招。`can_afford_*` 把这个硬约束明确写进特征空间。

**数据来源：** `observation.self.dice.total_count` + 每个 action candidate 的 `required_cost`。注意不同技能的骰子成本不同（Q 大招可能 4 骰，E 技能 3 骰）。

---

### 2.3 特征总结

| 类别 | 新特征数 | 累计（含已有） |
|------|:---:|:---:|
| 敌方精确 HP | 3 | 敌方状态 ~15 |
| 板凳脆弱目标 | 2 | |
| 出战状态阻拦 | 3 | |
| 我方攻击伤害 | 4 | 我方状态 ~18 |
| 骰子可行性 | 3 | |
| **合计新增** | **15** | 总特征约 45-50 |

全部新增特征 ≤ 15 个，不改变训练架构（仍是单模型 LightGBM），预计训练时间增量 < 5%。

---

## 3. 实现计划

### 3.1 修改文件

```
packages/gi-ml/src/datasets/rl-value.ts
  └─ buildObservationValueFeatureSlots()  [L85-L159]
     └─ 新增 5 组特征的提取逻辑

packages/gi-ml/python/gitcg_ml/train_lgbm_value.py
  └─ FORCE_RETAIN_FEATURES 白名单
     └─ 将新增特征加入白名单（确保不被方差筛选淘汰）
```

### 3.2 实现步骤

1. **确认 CharacterObservationV1 接口**：检查 `packages/gi-agent/dist/index.d.ts` 中是否已有 `skills` 字段暴露伤害信息。如无，需在 observation builder 中补上。

2. **实现 feature extraction**：在 `buildObservationValueFeatureSlots` 中添加 5 组新特征的提取逻辑（约 40-60 行代码）。

3. **更新白名单**：在 `train_lgbm_value.py` 中将新特征名加入 `FORCE_RETAIN_FEATURES`。

4. **单元测试**：`bun test packages/gi-ml` 验证特征提取正确性。

5. **上传 & 训练 iter-015**：SCP 到服务器，用 iter-014 的训练数据（或 iter-013 的数据）重新训练。

6. **benchmark iter-015 vs iter-013**：全交叉 640 局，看自由的新风和交给我吧的打出时机是否改善。

### 3.3 风险

| 风险 | 概率 | 缓解 |
|------|:---:|------|
| 技能伤害信息未在 observation 中暴露 | 中 | 用 `definition_id` + 本地卡牌数据库查表算近似伤害 |
| 新特征被方差筛选淘汰 | 低 | 已有白名单机制（`FORCE_RETAIN_FEATURES`） |
| 特征增加带来过拟合 | 低 | 15 个特征相对现有 ~35 个增量可控；可用 cross-validation 验证 |
| 训练数据本身噪声太大，新特征无效 | 中 | 需与方案 B（噪声重加权）配合；本方案仅解决信息缺失问题 |

---

## 4. 与其他方案的关系

### 4.1 方案 A+（本文）vs 方案 B（噪声重加权）

| 维度 | 方案 A+ | 方案 B |
|------|---------|--------|
| 解决什么 | 模型**看不见**关键信息 | 训练数据**标签有噪声** |
| 根因 | 特征工程不足 | 自对弈数据中 AI 自身会犯蠢 |
| 是否互斥 | ❌ 互不重叠 | ❌ 互不重叠 |

**推荐策略：A+ 先行 → 出结果后再叠 B**。如果 A+ 上完后 benchmark 仍然有"自由的新风 T1 打出"的情况，说明问题不在信息缺失而在数据质量，此时 B 的价值最大。

### 4.2 方案 A+ vs 方案 C（反事实遗憾）

方案 C 是根本性解法——它改变训练目标本身。但实现成本是 A+ 的 5-10 倍。

A+ 的目标是 **用最小代价把"低垂的果实"摘掉**。如果 A+ 已经能把"交给我吧 T1 打出"这类显而易见的错误消灭 80%，那方案 C 的优先级就可以降低。

### 4.3 方案 A+ vs 方案 D（分阶段建模）

方案 D（按行动状态分阶段训练多个模型）与 A+ 互补。A+ 的特征也可以用于 D 的阶段判定。

---

## 5. 成功标准

### 5.1 定量

- iter-015 vs iter-013 benchmark：**胜率 ≥ 55%**（现有 iter-014 vs iter-013 为 49.7%，无提升）
- 在 replay 审阅中：**自由的新风 / 交给我吧 T1 打出率下降 ≥ 50%**

### 5.2 定性

- 特征重要性排名中，新增的 `opponent_bench.min_hp` 和 `self_active.skill_damage_*` 进入 V 模型 top 20
- LightGBM 树结构中能观察到 `opponent_active.hp ≤ skill_damage_normal` 的交叉分裂

---

## 附录 A：当前特征集全貌（iter-013）

```
round, current_turn, action_count_in_round
self: hand_count, dice_count, omni_count, support_count, summon_count,
      alive_count, total_health, total_energy, active_health, active_energy
opponent: (同上)
self_characters: c{i}_alive, c{i}_hp_ratio, c{i}_energy_ratio, c{i}_equip_count, c{i}_definition_id
opponent_characters: (同上)
hand_composition: total, event_count, support_count, equipment_count, food_count, other_count,
                  card{i}_definition_id (×10)
public_state: self_declared_end, opponent_declared_end,
              self_support_count, opponent_support_count,
              self_summon_count, opponent_summon_count
derived: damage_capacity_now, ko_pressure_now, resource_score,
         reaction_ready_score, burst_online_count, role_integrity_score,
         window_score (self + opp, 共 14 个数)
pending_method: is_action, is_choose_active, is_reroll_dice, is_switch_hands, is_select_card
static_priors: effect_family_counts, meta_prior_slots
```

## 附录 B：自由的新风卡牌数据

- `definition_id`: 330004
- 类型：秘传（Arcane Legend），整局只能打 1 张
- 费用：0 费
- 效果：本回合内，我方击倒对方角色时，我方可以再执行一次行动。
- 触发条件：本回合必须造成角色击杀 + 还有骰子/动作可用

理想打出时机：
- 敌方有角色 HP ≤ 我方下次攻击伤害
- 击杀后还有剩余骰子可以连动
- 通常出现在 R3-R5 的执行/收尾阶段

等价反模式：
- R1 打出 = 完全丧失整局连杀机会（秘传只能用一次）
- 敌方无残血时打出 = 0 收益
- 打完后骰子不够出招 = 即使杀了也不能连动
