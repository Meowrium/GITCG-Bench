# Static Effect Meta Priors

## 1. Purpose

本文档记录一个未来可选增强方向：

- 将 `packages/data/src` 中已有的静态卡牌 / 技能效果
- 编译为 `gi-ml` 可消费的跨牌共享先验
- 用于提高 warm start、self-play、concept discovery 和在线 rerank 的样本效率与泛化

它要解决的问题不是规则正确性，而是学习效率。

当前系统已经具备：

- simulator 负责规则执行
- RL / ranker / value 消费 observation 和 candidate 摘要
- concept bank 提供更高层概念接口

但当前还缺一层：

- 将静态效果整理成稳定的 meta features / concept seeds
- 让模型更早学会“效果类别”的价值，而不是只能慢慢记住 `definition_id`

## 2. Design Principles

该方向应遵守以下原则：

- 规则正确性仍由模拟器保证
- 不要求在线模型直接解析 DSL
- 不把 description 文本作为第一版主输入
- static priors 只做抽象与压缩，不接管 legality
- 所有新增特征都必须可版本化、可重建、可回放

## 3. Proposed Layers

### 3.1 Layer A: Effect Family

第一层是静态效果族。

目标：

- 让不同 card / skill / status 在训练中共享“功能语义”
- 降低对单独 `definition_id` 经验的依赖

推荐从以下标签开始：

- `direct_damage`
- `damage_buff_once`
- `damage_buff_window`
- `damage_reduction_once`
- `damage_reduction_window`
- `heal_now`
- `heal_over_time`
- `energy_gain`
- `cost_reduce_skill`
- `cost_reduce_switch`
- `dice_fix`
- `draw_cards`
- `summon_create`
- `support_create`
- `reaction_enable`
- `burst_enable`
- `revive`
- `force_switch`
- `future_random_value`
- `card_generation`

### 3.2 Layer B: Meta Effect Slots

第二层是数值化元插槽。

目标：

- 把静态效果进一步折算成策略层更容易消费的中间变量
- 与现有 `derived` observation features 并列，而不是替代它们

推荐优先尝试：

- `tempo_gain_now`
- `tempo_gain_next_window`
- `burst_window_enable`
- `reaction_window_enable`
- `survival_swing`
- `resource_conversion_score`
- `action_density_gain`
- `stability_gain`
- `finisher_alignment`
- `setup_dependency`

### 3.3 Layer C: Concept Seeds

第三层是将 static priors 转为 concept hypothesis seeds。

目标：

- 不只从行为数据倒推概念
- 还从规则语义正向提出候选，再由离线数据验证

示例：

- `concept:buff-window:normal-attack-once`
- `concept:burst-window:enabled`
- `concept:healing-bridge:two-turn`
- `concept:dice-tempo:skill-cost-reduced`
- `concept:delayed-value:random-choice-card`

## 4. Integration Points

### 4.1 Observation Builder

在 state-level observation 中新增聚合 static prior slots：

- 手牌 effect family 计数
- 当前可行动作的 effect family 分布
- 当前 active 与手牌 / 支援 / 召唤物的协同计数
- tempo / sustain / burst / reaction 的聚合 meta slots

建议：

- 先做聚合统计，不做大规模 card-id one-hot
- 保持 `policy_public` 和 `debug_full` 可分别导出

### 4.2 RL Value Dataset

在 `buildObservationValueFeatureSlots(...)` 的后续版本中可追加：

- `self.effect_family_counts.*`
- `self.meta_prior_slots.*`
- `opponent_public_effect_family_counts.*`
- `cross_side_window_alignment.*`

目标：

- 帮 value head 更早识别 setup / burst / sustain 的结构价值

### 4.3 RL Ranking Dataset

在 candidate runtime slots 中新增：

- `static_effect_tags`
- `meta_effect_slots`
- `synergy_slots`

例如：

- 是否即时治疗
- 是否立即减费
- 是否提升后续动作密度
- 是否属于 setup 动作
- 是否与 active / next finisher 对齐

### 4.4 Concept Pipeline

在 concept discovery 中加入一条新来源：

- `static-effect-seed`

流程建议：

1. 从 card / skill / status 静态元数据导出 seed
2. 生成标准 `concept hypothesis`
3. 用 branch-eval / self-play 数据计算 predictability 与 ranking gain
4. 进入 `draft -> validated -> deprecated` 生命周期

## 5. Suggested Data Contract Additions

如后续接入，建议新增以下候选字段。

### 5.1 Candidate Runtime Slots

```ts
{
  static_effect_tags?: string[]
  meta_effect_slots?: Record<string, number>
  synergy_slots?: Record<string, number>
}
```

### 5.2 Observation Feature Slots

```ts
{
  self: {
    effect_family_counts?: Record<string, number>
    meta_prior_slots?: Record<string, number>
  }
  opponent: {
    public_effect_family_counts?: Record<string, number>
  }
  cross_side: {
    window_alignment?: Record<string, number>
  }
}
```

### 5.3 Concept Source Metadata

```ts
{
  source_kind: "static-effect-seed"
  seed_family?: string
  seed_meta_slot_paths?: string[]
}
```

## 6. Minimal Viable Rollout

推荐按以下顺序推进。

### Step 1: Effect Family Table

最小交付：

- 维护一份 `definition_id -> effect family tags` 映射
- 覆盖 card / skill / summon / status 中最常见高价值对象

验收：

- 能稳定离线导出
- 不影响现有 runtime

### Step 2: Candidate Static Effect Tags

最小交付：

- 在 ranking dataset builder 中把 effect family 标签挂到 candidate runtime slots

验收：

- ranker ablation 可以比较“有 / 无 static_effect_tags”

### Step 3: Observation Meta Prior Slots

最小交付：

- 在 value dataset / runtime value bridge 中增加少量聚合 meta slots

验收：

- value ablation 可以比较收敛速度和稳定性

### Step 4: Static Seed Concepts

最小交付：

- 让 concept bank 接受 static-effect-seed 来源

验收：

- 至少一组 seed concepts 能通过 concept validation

## 7. Evaluation Plan

该方向建议看四类指标。

### 7.1 Sample Efficiency

- warm start 收敛更快
- self-play 早期 checkpoint 波动更小

### 7.2 Generalization

- 新卡或变体卡加入时迁移更稳
- 跨 matchup 方差下降

### 7.3 Interpretability

- ranker 高分动作是否能由 static priors 解释
- value 错例是否更容易归因为 setup/window 误判

### 7.4 Overfitting Reduction

- 是否减少对 `definition_id` 的单卡记忆依赖
- 是否提升同类效果跨卡共享学习

## 8. Risks

需要明确规避以下问题：

- 与 reward shaping 双重记账
- 手写 meta slots 过多导致 brittle
- 过度依赖 card-id 映射而假装是元认知
- 在 `policy_public` 下引入不该存在的隐藏信息
- 版本切换后无法回放重建

## 9. Recommendation

作为未来候选方案，推荐优先级如下：

1. 先做 `effect family table`
2. 再做 `candidate static_effect_tags`
3. 然后做少量 `observation meta prior slots`
4. 最后再把它们并入 concept seed pipeline

这个顺序的原因是：

- 风险最低
- 最容易做 ablation
- 最容易和现有 `gi-ml` 数据契约兼容
- 能尽快验证它到底是在提升“元认知泛化”，还是只是在增加特征噪声
