## LLM Deck Analyzer V2 Feature Spec

### Goal

`@gi-tcg/llm-deck-analyzer` 的 V2 特征协议不再把卡组强行压成单一低维向量，而是同时保留：

- 可供传统 evaluator 使用的稠密统计特征
- 可供检索、规则分析、训练使用的稀疏结构特征
- 卡组内部完整图结构
- matchup 的交叉特征全集
- LLM 生成但不参与硬规则真值的辅助标签

目标是让七圣召唤中最重要的非线性来源可被显式表示：

- 三角色组合
- 行动牌包与阈值件
- 启动链、资源链、终结链
- matchup 中的节奏冲突、资源惩罚与克制关系

### Design Principles

- 图结构保留完整节点和边，不提前压缩为单一分数
- 行动牌单独建模，不再只做类别计数
- matchup 输出交叉特征全集，而不是仅拼接双方单 deck 特征
- LLM 仅生成辅助标签和说明，不覆盖基础结构事实
- 稀疏特征 key 必须稳定、可版本化、可人工审查

### Main Outputs

V2 定义三类输出：

1. `DeckFeaturesV2`
2. `MatchupFeaturesV2`
3. `FeatureVocabulary`

`DeckFeaturesV2` 负责单套卡组的结构化表达，`MatchupFeaturesV2` 负责双卡组交叉表达，`FeatureVocabulary` 负责统一稀疏特征命名空间。

### DeckFeaturesV2

#### Dense Layer

稠密特征用于：

- 传统数值模型
- 粗粒度召回
- 调试时的摘要视图

包含以下字段：

- 角色摘要：元素数、元素分布、国家分布、武器分布
- 行动牌摘要：装备/事件/支援计数，天赋/武器/圣遗物/伙伴/场地/道具/料理/共鸣/秘传计数
- 费用摘要：0/1/2/3+ 费数量、平均费用、低费启动件密度
- 节奏摘要：快启动、站场压制、后台消耗、召唤压制、反应联动、长局资源
- 依赖摘要：角色依赖、天赋依赖、支援依赖、终结窗口依赖

#### Sparse Layer

稀疏特征用于：

- 高维训练输入
- 解释性检索
- 规则系统命中统计

关键命名规则：

- `deck.char.<id>`
- `deck.char_pair.<id>_<id>`
- `deck.char_trio.<id>_<id>_<id>`
- `deck.card.<id>`
- `deck.card_count.<id>`
- `deck.action.function.<tag>`
- `deck.action.package.<tag>`
- `deck.synergy.<tag>`
- `deck.dependency.<tag>`
- `deck.curve.cost_<bucket>`

#### Graph Layer

图结构保留完整节点和边。

节点类型：

- `character`
- `action_card`
- `package`
- `reaction_route`
- `engine`
- `dependency`
- `plan_phase`
- `threat`

边类型：

- `includes`
- `enables`
- `requires`
- `amplifies`
- `converts_to`
- `stabilizes`
- `conflicts_with`
- `protects`
- `finishes`

图结构用于表达：

- 角色到专属行动牌的依附
- 行动牌包到节奏/资源引擎的使能
- 启动链到中期压制链再到终结链的阶段转换
- 关键点之间的放大、依赖和冲突关系

#### Action Card Features

行动牌是 V2 的重点建模对象。按以下五层表示：

1. `presence`
2. `function tagging`
3. `packages`
4. `dependencies`
5. `thresholds`

##### Functional Tagging

行动牌功能标签必须比官方标签更细。建议标准字段：

- `card_draw`
- `card_filter`
- `dice_fix`
- `dice_gain`
- `energy_gain`
- `fast_swap`
- `forced_swap`
- `cost_discount`
- `cost_conversion`
- `shield`
- `heal`
- `revive`
- `damage_boost`
- `burst_amplifier`
- `normal_attack_amplifier`
- `skill_reset`
- `talent_enable`
- `equipment_enable`
- `summon_create`
- `summon_scale`
- `support_engine`
- `hand_engine`
- `stall_tool`
- `tempo_push`
- `reaction_enable`
- `reaction_payoff`
- `anti_summon`
- `anti_support`
- `anti_greedy_setup`
- `finisher_setup`

每张行动牌允许命中多个功能标签。

##### Packages

行动牌包是高阶结构特征，至少包括：

- `universal_resource_package`
- `fast_start_package`
- `support_engine_package`
- `equipment_carry_package`
- `talent_core_package`
- `reaction_enable_package`
- `reaction_payoff_package`
- `summon_pressure_package`
- `control_stall_package`
- `long_game_value_package`
- `burst_finish_package`
- `anti_tempo_package`

##### Dependencies and Thresholds

要显式表示：

- 某张行动牌依赖特定角色
- 某张行动牌依赖特定元素/国家/武器组合
- 某个行动牌包要达到数量阈值才成立
- 某些牌只有与另一张牌或另一类牌同时出现时才显著增值

### MatchupFeaturesV2

#### Dense Layer

用于概括双方对局的大方向：

- A/B 启动速度对比
- A/B 长局能力对比
- A/B 主威胁兑现速度对比
- A/B 支援贪度对比
- A/B 资源惩罚能力对比
- A/B 防守工具对比

#### Sparse Cross Feature Layer

matchup 的关键是交叉特征全集，不使用“仅拼接双方特征”的简化方案。

核心命名规则：

- `matchup.a_char_trio__b_char_trio.<trio>__<trio>`
- `matchup.a_card__b_card.<id>__<id>`
- `matchup.a_package__b_package.<tag>__<tag>`
- `matchup.a_route__b_route.<tag>__<tag>`
- `matchup.a_engine__b_counter.<tag>__<tag>`
- `matchup.a_dependency__b_pressure.<tag>__<tag>`
- `matchup.a_phase__b_phase.<tag>__<tag>`

交叉全集至少覆盖：

- 角色三元组对角色三元组
- 关键行动牌对关键行动牌
- 行动牌包对行动牌包
- 反应路线对反应路线
- 资源引擎对反制能力
- 终结窗口对防守工具
- 贪资源构筑对快节奏惩罚
- 召唤体系对反召唤能力
- 支援引擎对拆支援能力
- 角色依赖对定点压制能力

#### Matchup Graph Layer

matchup 图结构包含双方 deck graph 的桥接边。

桥接边类型建议：

- `pressures`
- `punishes`
- `outraces`
- `denies`
- `mirrors`
- `invalidates`
- `checks`
- `is_soft_to`

这层不是为了给用户看，而是为了保留对局结构真值。

### LLM Auxiliary Labels

LLM 在 V2 中允许生成辅助标签，但不修改硬事实字段。

允许生成：

- `archetype labels`
- `plan labels`
- `risk labels`
- `matchup narrative labels`
- `uncertainty notes`
- `missing-context notes`

禁止由 LLM 单独决定：

- 角色/卡牌存在性
- 图节点和基础边
- 行动牌功能标签真值
- 关键交叉特征是否存在

LLM 辅助标签应单独放入 `auxiliary.llm` 域，并标记来源与置信度。

### Proposed Delivery Order

1. 固定 `types.ts`
2. 固定 `vocabulary.ts`
3. 固定 `schemas.ts`
4. 补一组 fixture 输出
5. 再实现 extractor

### Compatibility

V1 的平面 `DeckFeatureVector` 和 `MatchupFeatureVector` 后续可以作为 V2 dense 层的降维兼容视图，但不应继续作为主输出模型。
