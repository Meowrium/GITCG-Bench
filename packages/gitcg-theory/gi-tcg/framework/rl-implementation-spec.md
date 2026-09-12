# RL Implementation Spec

这份文档不再讨论理论框架为什么成立，而是直接规定第一版可实现 RL baseline 的 4 个落地件：

1. `observation schema v1`
2. `candidate action schema v1`
3. `reward config v1`
4. `training protocol v1`

当前文档的定位是：

- 它不是最终代码实现。
- 它是开始实现前的接口规格。
- 它优先追求“能开工”，而不是“最优雅”。

补充说明：

- 关于“如何把静态卡牌效果转成元认知先验以加速 RL”，另见 [static-effect-meta-priors-for-rl.md](D:/AI/GTCG/gitcg-theory/static-effect-meta-priors-for-rl.md)。
- 该文档不是当前 v1 contract 的强制组成部分，而是后续增强候选方案。

- 它不是最终代码实现。
- 它是开始实现前的接口规格。
- 它优先追求“能开工”，而不是“最优雅”。

## 一、适用范围与默认前提

本规格默认承接 [framework.md](D:/AI/GTCG/gitcg-theory/framework.md) 中已经确定的口径，尤其是：

- 第一版先离线 warm start，再 online self-play。
- warm start 阶段采用行为克隆 / 排序学习，对策略头与价值头做多头联训。
- 系统层统一 action contract，并覆盖所有合法动作类型。
- 学习层允许采用“主头 + 回退头”。
- 第一版 reward 以终局奖励为锚，dense shaping 先只开通用项。
- 第一版先锁定固定版本、固定牌池、固定三套卡组，对应三个 archetype。
- 真正训练主线使用 `policy_public`；`debug_full` 只用于调试、对照和上界分析。

当前更具体的默认前提是：

- 目标不是第一版就做通用强策略，而是先做“结构正确、能稳定训练、能超过基础 baseline”的 RL baseline。
- 第一版先允许局部规则回退，不强求学习模型立刻覆盖所有稀有动作。
- 第一版先把可实现 contract 写死，再在后续迭代里加 `deck-specific` 和更复杂的隐藏信息建模。

## 二、四个落地件总览

### 2.1 `observation schema v1`

作用：

- 把理论里的状态 `s` 变成模型可读输入。
- 统一训练、评测、复盘所用的状态 contract。

第一版默认立场：

- observation 以 `GameStateSerializer` 暴露的完整状态为底。
- `policy_public` 只保留公开信息 + 我方私有信息 + 对手统计期望特征。
- 中间特征单独抽取，不把 candidate 明细直接混入 observation。

### 2.2 `candidate action schema v1`

作用：

- 把 `A(s)` 变成一个稳定的 `decision point -> candidate list` 结构。
- 让模型、回退策略、日志和回放共享同一动作接口。

第一版默认立场：

- 系统层统一编码所有合法动作。
- 学习模型先覆盖高频动作。
- 罕见动作与稀有 pending method 先由回退头或规则策略承接。

### 2.3 `reward config v1`

作用：

- 规定哪些事件会真正作为环境奖励进入训练。
- 把解释性评分、辅助监督标签和环境 reward 明确拆开。

第一版默认立场：

- 终局奖励是主信号。
- dense shaping 是弱信号。
- 通用 shaping 先上，`deck-specific` shaping 延后。

### 2.4 `training protocol v1`

作用：

- 把 warm start、self-play、更新、评测、晋级、回放分析串成完整制度。

第一版默认立场：

- 离线 warm start + 在线 self-play 微调。
- 一个训练样本以完整 `decision point` 为核心单位。
- policy/ranker 以 candidate list 为核心对象。
- value 以轨迹回传为主。

## 三、`observation schema v1`

### 3.1 设计目标

`observation schema v1` 的目标不是“把所有引擎状态无脑塞进模型”，而是：

- 让 observation 对训练足够完整。
- 让 observation 对复盘足够稳定。
- 让 `debug_full` 与 `policy_public` 能共享大部分字段结构。
- 让后续 action、reward、日志都能引用同一组字段名。

### 3.2 实现参照

当前 observation 可以直接参考：

- `genius-invokation/packages/mcp/src/GameStateSerializer.ts`
- `get_game_state`
- `get_screen_state`

当前实现立场：

- `get_game_state` 作为原始状态源。
- `get_screen_state` 只作为轻量交互参照，不作为训练输入规范。
- 训练 observation 在 `get_game_state` 基础上再做“规范化 + 中间特征抽取”。

### 3.3 顶层结构

第一版推荐的 observation 顶层结构如下：

```ts
interface ObservationV1 {
  schema_version: "obs.v1";
  source: {
    game_version: string;
    card_pool_version: string;
    ruleset_version: string;
    contract_version: string;
    view_kind: "debug_full" | "policy_public";
  };
  point: {
    game_id: string;
    episode_id: string;
    decision_point_id: string;
    round_number: number;
    phase: "initHands" | "initActives" | "roll" | "action" | "end";
    pending_method: "action" | "chooseActive" | "rerollDice" | "switchHands" | "selectCard" | null;
    actor_who: 0 | 1;
    current_turn: 0 | 1;
    action_count_in_round: number;
  };
  self: PlayerObservationV1;
  opponent: PlayerObservationV1;
  public_state: PublicBoardObservationV1;
  hidden_estimate: OpponentHiddenEstimateV1 | null;
  derived: DerivedObservationFeaturesV1;
}
```

### 3.4 玩家侧结构

```ts
interface PlayerObservationV1 {
  active_character_index: 0 | 1 | 2;
  characters: CharacterObservationV1[];
  summons: SummonObservationV1[];
  supports: SupportObservationV1[];
  combat_statuses: StatusObservationV1[];
  dice: DicePoolObservationV1;
  hand: HandObservationV1;
  pile_count: number;
  discard_count: number;
  declared_end: boolean;
  can_charged: boolean;
  can_plunging: boolean;
  has_defeated: boolean;
  legend_used: boolean;
}
```

```ts
interface CharacterObservationV1 {
  slot_index: 0 | 1 | 2;
  definition_id: number;
  alive: boolean;
  is_active: boolean;
  health: number;
  max_health: number;
  energy: number;
  max_energy: number;
  aura: number | null;
  equipment_ids: number[];
  status_ids: number[];
  usage_counters: Record<string, number>;
}
```

### 3.5 资源与手牌表示

第一版建议采用：

- 骰子按类型计数表示，不保留单颗身份。
- 手牌在 `policy_public` 下对我方保留逐张实体；对对方不暴露实体，只保留统计期望。
- 牌库、弃牌堆先只保留计数与可公开追踪的信息。

```ts
interface DicePoolObservationV1 {
  counts_by_type: Record<number, number>;
  total_count: number;
  omni_count: number;
}

interface HandObservationV1 {
  visible_cards: HandCardObservationV1[];
  card_count: number;
}

interface HandCardObservationV1 {
  entity_id: number;
  definition_id: number;
  tags: string[];
  cost_summary: Array<{ type: number; count: number }>;
}
```

### 3.6 对手隐藏信息的统计期望

第一版不做完整 belief system，而采用“轻量统计期望”。

```ts
interface OpponentHiddenEstimateV1 {
  hidden_hand_count: number;
  remaining_deck_count: number;
  known_revealed_definition_ids: number[];
  expected_type_counts: {
    event: number;
    equipment: number;
    support: number;
    food: number;
    resonance: number;
  };
  expected_response_buckets: {
    heal_like: number;
    dice_fix_like: number;
    swap_like: number;
    burst_enable_like: number;
  };
}
```

第一版的计算规则可以先简单化：

- 已知套牌列表固定。
- 从完整套牌中减去已知起始角色、已公开打出卡牌、已知弃牌、已知手牌暴露信息。
- 对剩余卡池按类型与功能标签做频数期望。

### 3.7 中间特征层

第一版建议把 `derived` 写成单独对象，不混在原始状态层中。

```ts
interface DerivedObservationFeaturesV1 {
  self_damage_capacity_now: number;
  opp_damage_capacity_now: number;
  self_ko_pressure_now: number;
  opp_ko_pressure_now: number;
  self_resource_score: number;
  opp_resource_score: number;
  self_reaction_ready_score: number;
  opp_reaction_ready_score: number;
  self_burst_online_count: number;
  opp_burst_online_count: number;
  self_role_integrity_score: number;
  opp_role_integrity_score: number;
  self_window_score: number;
  opp_window_score: number;
}
```

第一版这些值不要求物理精确，但要求：

- 同一取值规则跨训练和评测保持一致。
- 明确范围与归一化方式。
- 不混入 candidate-specific 信息。

### 3.8 编码规则

第一版建议使用以下默认规则：

- 角色槽位按固定队伍顺序编码，不按当前出战位重排。
- 另用 `is_active` 与 `active_character_index` 显式标出出战位。
- 状态、召唤物、支援先按 `definition_id` 排序后截断到固定最大长度。
- 超出长度的部分写入 `overflow_count`，而不是静默丢弃。
- 所有布尔值统一转成 `0/1` 数值特征。
- 所有计数特征保留原值与可选归一化值两种视图，训练默认读取归一化值，日志保留原值。

### 3.9 `debug_full` 与 `policy_public` 的差异

第一版推荐差异如下：

- `debug_full` 可读取对方真实手牌、真实牌库剩余、真实隐藏状态。
- `policy_public` 不读取任何对方私有实体，只读取 `hidden_estimate`。
- 两者共享同一个顶层 schema，但某些字段在 `policy_public` 中恒为 `null` 或空数组。

### 3.10 observation 的验收标准

只要满足下面四条，就认为 `observation schema v1` 可进入实现：

- 同一局面在训练、评测、回放中能生成相同字段结构。
- `debug_full` 与 `policy_public` 可自动互转或至少可稳定对照。
- derived 特征的提取逻辑可独立版本化。
- 单个 decision point 的 observation 能单独落盘与重放。
### 3.11 observation 字段到引擎字段的映射表

下面的映射表默认以上游 `exposeState(who, state)` 返回的 `PbGameState` 为主来源，必要时再补充原始 `GameState` 或离线派生字段。

#### 3.11.1 顶层字段映射

| ObservationV1 字段 | 主要来源 | 映射规则 |
|---|---|---|
| `source.game_version` | 运行时配置 | 由训练/运行环境注入，不直接来自 `PbGameState` |
| `source.card_pool_version` | 运行时配置 | 由卡池版本配置注入 |
| `source.ruleset_version` | 运行时配置 | 由规则版本配置注入 |
| `source.contract_version` | 本地常量 | 固定写为 `obs.v1` |
| `source.view_kind` | 调用上下文 | 由当前导出模式决定：`debug_full` 或 `policy_public` |
| `point.round_number` | `game_state.roundNumber` | 直接映射 |
| `point.phase` | `game_state.phase` | 直接映射；`gameEnd` 在 v1 中落到 `end` 或单独作为终局状态处理 |
| `point.actor_who` | 调用上下文 + `game_state.currentTurn` | 默认取当前视角下的 `currentTurn` |
| `point.current_turn` | `game_state.currentTurn` | 直接映射 |
| `point.pending_method` | `get_available_commands.pending_method` | 不来自 `game_state`，由 pending RPC 元数据补入 |
| `point.game_id` | 训练/对局运行时 | 外部注入 |
| `point.episode_id` | 训练/对局运行时 | 外部注入 |
| `point.decision_point_id` | 训练/对局运行时 | 推荐用 `episode_id + step_index + pending_method` 生成 |
| `point.action_count_in_round` | 训练日志计数器 | 不来自引擎状态，需在日志层累加 |

#### 3.11.2 玩家字段映射

上游 `PbGameState` 中玩家数组字段为：

- `game_state.player[0]`
- `game_state.player[1]`

当前推荐：

- `self = game_state.player[who]`
- `opponent = game_state.player[1 - who]`

| PlayerObservationV1 字段 | 主要来源 | 映射规则 |
|---|---|---|
| `active_character_index` | `player.activeCharacterId` + `player.character[]` | 在 `character[]` 中找到 `id === activeCharacterId` 的槽位索引 |
| `characters` | `player.character[]` | 逐项映射到 `CharacterObservationV1` |
| `summons` | `player.summon[]` | 直接映射后再做排序/截断 |
| `supports` | `player.support[]` | 直接映射后再做排序/截断 |
| `combat_statuses` | `player.combatStatus[]` | 直接映射后再做排序/截断 |
| `dice` | `player.dice[]` | 聚合成 `counts_by_type` 与 `total_count` |
| `hand.visible_cards` | `player.handCard[]` | 自己视角保留逐张；对手视角在 `policy_public` 中置空 |
| `hand.card_count` | `player.handCard.length` | 对自己和对手都可保留计数 |
| `pile_count` | `player.pileCard.length` | 直接取长度 |
| `discard_count` | 离线日志 / 原始状态派生 | `PbGameState` 当前不直接给弃牌堆，需要由日志或原始状态补充 |
| `declared_end` | `player.declaredEnd` | 直接映射 |
| `legend_used` | `player.legendUsed` | 直接映射 |
| `can_charged` | 原始 `GameState.players[who].canCharged` | `PbGameState` 默认未暴露，需从原始状态或扩展导出 |
| `can_plunging` | 原始 `GameState.players[who].canPlunging` | 同上 |
| `has_defeated` | 原始 `GameState.players[who].hasDefeated` | 同上，当前推荐作为扩展字段补入 |

说明：

- `canCharged` / `canPlunging` / `hasDefeated` 当前在原始状态层存在，但 `exposeState` 默认未输出，需要训练导出器直接读原始 `GameState`，或扩展序列化层。
- 这类字段不应因此从 observation schema 中删掉，因为它们确实影响合法动作与局部节奏。

#### 3.11.3 角色字段映射

上游 `player.character[]` 已经包含大部分所需字段，来自 `exposeCharacter(...)`。

| CharacterObservationV1 字段 | 主要来源 | 映射规则 |
|---|---|---|
| `slot_index` | `player.character[]` 的数组位置 | 直接取索引 |
| `definition_id` | `character.definitionId` | 直接映射 |
| `alive` | `!character.defeated` | 布尔翻转 |
| `is_active` | `character.id === player.activeCharacterId` | 比较实体 id |
| `health` | `character.health` | 直接映射 |
| `max_health` | `character.maxHealth` | 直接映射 |
| `energy` | `character.energy` | 直接映射 |
| `max_energy` | `character.maxEnergy` | 直接映射 |
| `aura` | `character.aura` | 直接映射 |
| `equipment_ids` | `character.entity[]` | 过滤装备类实体的 `definitionId` |
| `status_ids` | `character.entity[]` | 过滤状态类实体的 `definitionId` |
| `usage_counters` | `character.entity[]` | 从 `variableName / variableValue` 抽取为字典 |

当前推荐的实体过滤规则：

- 若实体标签或 area 语义明确属于装备，则记入 `equipment_ids`
- 其余附着在角色上的显式实体，优先记入 `status_ids`
- `variableName / variableValue` 不足以表达复杂状态时，先保留 `status_ids`，复杂细节后续另加扩展字段

#### 3.11.4 召唤物 / 支援 / 战斗状态映射

上游 `PbEntityState` 已经暴露：

- `id`
- `definitionId`
- `descriptionDictionary`
- `variableName`
- `variableValue`

第一版推荐统一映射成：

```ts
interface StatusObservationV1 {
  entity_id: number;
  definition_id: number;
  variable_name: string | null;
  variable_value: number | null;
}
```

并统一适用于：

- `summons`
- `supports`
- `combat_statuses`

排序规则：

- 先按 `definition_id`
- 再按 `entity_id`

#### 3.11.5 手牌与牌库映射

| ObservationV1 字段 | 主要来源 | 映射规则 |
|---|---|---|
| `self.hand.visible_cards[].entity_id` | `self_player.handCard[].id` | 直接映射 |
| `self.hand.visible_cards[].definition_id` | `self_player.handCard[].definitionId` | 直接映射 |
| `self.hand.visible_cards[].tags` | 资产索引 / 卡牌数据 | 不直接来自 `PbGameState`，需二次查卡牌元数据 |
| `self.hand.visible_cards[].cost_summary` | `initiativeSkill` / 资产索引 / 卡牌详情 | 推荐在导出阶段补查定义成本 |
| `self.hand.card_count` | `self_player.handCard.length` | 直接映射 |
| `opponent.hand.card_count` | `opp_player.handCard.length` | 直接映射 |
| `opponent.hand.visible_cards` | `opp_player.handCard[]` | `policy_public` 下固定为空；`debug_full` 可保留真实实体 |
| `self.pile_count` | `self_player.pileCard.length` | 直接映射 |
| `opponent.pile_count` | `opp_player.pileCard.length` | 直接映射 |

说明：

- 上游会对对手私有牌做隐藏处理，但长度仍然可见。
- 手牌标签、成本摘要等训练辅助字段，建议通过 `definitionId -> card metadata` 的二次查表补齐，而不是修改 `PbGameState` 结构。

#### 3.11.6 骰子映射

上游 `player.dice[]` 在自己视角是真实类型；对手视角会被替换成 `UNSPECIFIED`。

第一版推荐：

- 对自己：聚合成 `counts_by_type`
- 对对手：
  - `debug_full` 下可读取真实类型
  - `policy_public` 下只保留 `total_count` 与 `unspecified_count`

推荐结构扩展为：

```ts
interface DicePoolObservationV1 {
  counts_by_type: Record<number, number>;
  total_count: number;
  omni_count: number;
  unspecified_count: number;
}
```

### 3.12 训练导出器的 observation 实现顺序

为了把上面的映射尽快落到代码，当前推荐实现顺序是：

1. 先从 `PbGameState` 完成顶层、玩家、角色、召唤物、支援、战斗状态、基础骰子与基础手牌计数映射。
2. 再从原始 `GameState` 或额外上下文补 `canCharged / canPlunging / hasDefeated / discard_count`。
3. 再通过 `definitionId -> metadata` 查表补手牌标签、成本摘要等训练辅助字段。
4. 最后再接 `hidden_estimate` 与 `derived` 特征计算。

这样做的好处是：

- 先能产出一版结构完整的 observation。
- 先不被标签、belief、辅助元数据卡住。
- 先让训练日志和 candidate 日志有统一的 observation 引用。

### 3.13 observation 实现时的直接阻塞点

当前真正会卡实现的点只有这些：

- `discard_count` 在默认 `PbGameState` 中没有直接暴露，需要决定从原始状态还是日志补。
- `canCharged / canPlunging / hasDefeated` 需要走原始状态扩展读取。
- 手牌标签和成本摘要需要二次查元数据，不应指望从 `PbGameState` 原样得到。
- `hidden_estimate` 与 `derived` 不属于原始序列化结果，必须单独实现特征层。

但这些都已经是工程补线问题，不再是建模层的不确定性。


## 四、`candidate action schema v1`

### 4.1 设计目标

`candidate action schema v1` 的任务是把动态动作空间转成可稳定处理的候选列表，而不是强行构造全局大离散动作空间。

第一版的核心原则：

- 每个训练样本围绕一个 `decision point` 展开。
- 每个 `decision point` 都有一组 candidate。
- 模型对 candidate list 打分，而不是对全局动作字典打分。

### 4.2 实现参照

当前 action 层可直接参考：

- `get_available_commands`
- `pendingRequest.action`
- `choose_action(action_index, used_dice)`
- `choose_active(character_id)`
- `reroll_dice(dice_to_reroll)`
- `switch_hands(removed_hand_ids)`
- `select_card(card_id)`

从实现细节看，当前系统已经具备：

- `pending_method`
- `pendingRequest.action`
- `validity`
- `requiredCost`
- `used_dice` 校验
- 各 pending method 的候选 id 约束

因此第一版不应重新发明动作语义，而应在现有 pending RPC 语义之上做规范化包装。

### 4.3 顶层结构

```ts
interface DecisionPointV1 {
  schema_version: "action.v1";
  game_id: string;
  episode_id: string;
  decision_point_id: string;
  pending_method: "action" | "chooseActive" | "rerollDice" | "switchHands" | "selectCard";
  actor_who: 0 | 1;
  observation_ref: string;
  candidate_count: number;
  candidates: ActionCandidateV1[];
}
```

```ts
interface ActionCandidateV1 {
  candidate_id: string;
  candidate_index: number;
  engine_index: number | null;
  pending_method: string;
  family: "action" | "choose_active" | "reroll_dice" | "switch_hands" | "select_card";
  action_case: string;
  source_ref: EntityRefV1 | null;
  target_ref: EntityRefV1 | null;
  target_refs: EntityRefV1[];
  required_cost: Array<{ type: number; count: number }>;
  auto_selected_dice: number[];
  selectable_dice_types: number[];
  is_fast_action: boolean;
  is_valid: boolean;
  validity_code: number | null;
  is_model_selectable: boolean;
  is_fallback_only: boolean;
  rule_tags: string[];
}
```

### 4.4 candidate 的唯一标识规则

第一版推荐：

- `candidate_id = decision_point_id + ":" + pending_method + ":" + candidate_index`
- `candidate_index` 为当前 contract 层稳定顺序。
- `engine_index` 保留原始引擎顺序，方便映射回 `choose_action(action_index)`。

### 4.5 候选排序规则

第一版推荐采用“稳定规范化顺序”，不是完全依赖引擎自然顺序。

排序优先级：

1. `pending_method` 固定
2. `family`
3. `action_case`
4. `source_ref`
5. `target_ref`
6. `required_cost`
7. `engine_index`

这样做的原因是：

- 日志更稳定。
- 模型输入更稳定。
- 引擎内部顺序变化时，不会立刻破坏训练数据分布。

但必须同时保留 `engine_index`，以便执行时能准确回写到实际工具参数。

### 4.6 各 family 的默认编码

#### 4.6.1 `action`

覆盖：

- 技能
- 出牌
- 战斗切换
- 元素调和
- 结束回合

额外字段：

- `required_cost`
- `auto_selected_dice`
- `used_dice_spec`
- `skill_type`
- `card_definition_id`

#### 4.6.2 `choose_active`

额外字段：

- `candidate_character_ids`
- `target_ref`

#### 4.6.3 `reroll_dice`

第一版不枚举所有组合，而采用以下策略：

- 系统层保留统一编码。
- 学习层初版允许直接回退到规则策略。
- 若后续要学习，则单独定义组合候选裁剪规则。

#### 4.6.4 `switch_hands`

与 `reroll_dice` 同理：

- 系统层统一编码。
- 学习层初版允许回退。

#### 4.6.5 `select_card`

额外字段：

- `candidate_card_ids`
- `target_ref`

### 4.7 主头 / 回退头规则

第一版默认：

- 主头负责 `action` family 中的高频候选。
- 回退头负责低频候选或低置信度决策。
- `reroll_dice`、`switch_hands` 初版可直接走规则策略。

推荐字段：

```ts
interface CandidateRoutingV1 {
  route: "main_head" | "fallback_head" | "rule_policy";
  reason: "high_freq_family" | "rare_pending_method" | "low_confidence" | "disabled_in_v1";
}
```

### 4.8 模型输出默认语义

第一版推荐：

- policy / ranker 主输出采用 `listwise` 打分。
- `branch-eval` 数据可额外提供 `pairwise` 辅助损失。
- 真正执行时，从主头输出分数中选最高可执行 candidate；若不满足置信或 family 条件，则交给回退头或规则策略。

### 4.9 action 的验收标准

只要满足下面四条，就认为 `candidate action schema v1` 可进入实现：

- 任一 decision point 都能稳定导出 candidate list。
- candidate list 可以无歧义映射回引擎执行参数。
- 主头、回退头、规则策略的接管边界可落盘复盘。
- 同一局面重复导出时，candidate 排序与 id 稳定。

## 五、`reward config v1`

### 5.1 设计目标

`reward config v1` 的目标不是把所有价值判断塞进 reward，而是：

- 只保留对学习真正有帮助的通用信号。
- 控制量纲与重复计数。
- 让 reward 可以独立版本化和回放。

### 5.2 奖励分层

第一版严格拆成三层：

#### 5.2.1 环境奖励

真正进入 RL 训练目标：

- 终局奖励
- 通用 dense shaping

#### 5.2.2 分析评分

不直接进环境 reward：

- `Q_total(s, a)` 的解释性评分
- 高频复盘用的人工可读打分

#### 5.2.3 辅助监督标签

不直接进环境 reward：

- `branch-eval` 的偏好标签
- `combat-window` 的局部高价值标签
- 部分 `Q_total` 子项转化的监督目标

### 5.3 第一版奖励公式

第一版推荐：

```text
r_t = r_terminal
    + r_damage
    + r_ko
    + r_energy
    + r_hand
    + r_reaction_ready
    + r_burst_online
```

其中：

- `r_terminal` 是主信号。
- 其余项总和应远小于终局奖励。

### 5.4 终局奖励

```text
win  = +1.0
loss = -1.0
draw =  0.0
```

附加规则：

- 投降视作 `loss`。
- 异常中断和非法终止不进入训练样本池。

### 5.5 通用 shaping 白名单

第一版推荐白名单如下：

| 事件 | 记号 | 默认系数 | 说明 |
|---|---:|---:|---|
| 有效伤害净变化 | `r_damage` | `0.02 * hp_swing` | 只计算有效血量变化，不计溢出 |
| 击倒事件 | `r_ko` | `+0.15 / -0.15` | 作为结构跳变单独奖励 |
| 能量净变化 | `r_energy` | `0.015 * energy_swing` | 仅统计真实可兑现能量变化 |
| 手牌净变化 | `r_hand` | `0.01 * hand_swing` | 保持小权重 |
| 反应准备度进入 | `r_reaction_ready` | `+0.03` | 只在从未就绪到就绪时触发 |
| 爆发线进入可用 | `r_burst_online` | `+0.04` | 只在从不可用到可用时触发 |

说明：

- 以上系数是 v1 默认，不是理论真值。
- 单步 shaping 总额建议截断到 `[-0.25, +0.25]`。

### 5.6 黑名单

第一版不进入环境 reward：

- `deck-specific` 展开线收益，如 `L_plan` 细项
- 对手适应代价，如 `N_plan`
- 高层节奏解释项
- 功能层级坍缩的复杂风险项
- 需要跨多轮推断才稳定的策略概念

这些项可以进入：

- 分析评分
- 辅助监督标签
- 第二阶段 reward 实验

### 5.7 反双计规则

第一版默认采用以下规则：

- 有效伤害只统计血量变化，不额外包含击倒结构价值。
- 击倒单独发奖，因为它不是普通伤害的线性延伸。
- `reaction_ready` 与 `burst_online` 只在状态跃迁时奖励，不按维持时长持续发奖。
- 不对同一事件同时发“高层节奏奖励”和“展开解锁奖励”。
- 若某一步已经通过显式 shaping 体现，则对应 `Q_total` 子项只保留为解释，不再重复进环境 reward。

### 5.8 归一化与裁剪规则

第一版默认：

- 不按回合长度归一化。
- 按行动数和对局长度做训练时归一化统计，但 reward 本身保持事件尺度。
- 所有 dense shaping 做单步截断。
- 所有 reward breakdown 都写入日志。

### 5.9 配置结构

```ts
interface RewardConfigV1 {
  reward_version: "reward.v1";
  terminal: {
    win: 1.0;
    loss: -1.0;
    draw: 0.0;
  };
  shaping: {
    damage_coef: number;
    ko_bonus: number;
    energy_coef: number;
    hand_coef: number;
    reaction_ready_bonus: number;
    burst_online_bonus: number;
    step_clip: number;
  };
  enabled_events: string[];
  disabled_events: string[];
}
```

### 5.10 reward 的验收标准

只要满足下面五条，就认为 `reward config v1` 可进入实现：

- 所有事件都有明确触发条件。
- 所有系数与裁剪规则可配置。
- 同一轨迹可以完整回放 reward breakdown。
- 可独立比较“只用终局奖励”和“终局 + shaping”。
- `shaping` 的设计评估与模型最终验收指标明确分层。

## 六、`training protocol v1`

### 6.1 设计目标

`training protocol v1` 的目标不是写一堆训练脚本名称，而是规定一条可重复运行的训练制度。

它要回答：

- 数据从哪里来。
- 每种数据怎么用。
- 模型分几阶段训练。
- 在线 self-play 怎样组织。
- 新模型怎样晋级。
- 失败时怎样排障。

### 6.2 总体训练路线

第一版采用四阶段路线：

1. `Stage 0: Export & Normalize`
2. `Stage 1: Offline Warm Start`
3. `Stage 2: Online Self-Play Fine-Tune`
4. `Stage 3: Evaluation & Promotion`

### 6.3 Stage 0: Export & Normalize

目标：

- 把不同来源的数据转成统一 contract。

输入：

- `branch-eval`
- `combat-window`
- `replay`
- 历史 `self-play`

输出：

- 统一 observation record
- 统一 decision point record
- 统一 reward breakdown record
- 统一 trajectory record

### 6.4 Stage 1: Offline Warm Start

目标：

- 让模型先学会“在候选动作里大致选得像样”。

默认训练内容：

- 主 encoder
- policy / ranker head
- value head
- 必要的辅助监督头

默认数据使用：

- `branch-eval`：主力 candidate 排序监督
- `combat-window`：局部高价值窗口监督
- `replay`：value 预热与轨迹分布校准

默认损失组合：

- `listwise ranking loss` 作为主损失
- `pairwise preference loss` 作为辅助损失
- `value regression / value classification loss` 作为状态价值目标
- 必要的辅助监督损失

### 6.5 Stage 2: Online Self-Play Fine-Tune

目标：

- 把训练分布逐步拉向当前策略真实会遇到的局面。

第一版默认：

- 在线训练直接挂引擎。
- 同时强制导出统一离线数据。
- 一个训练样本的核心单位仍然是 `decision point`。
- value 继续通过轨迹回传更新。

对手池默认：

- 镜像策略：`40%`
- 历史 checkpoint：`40%`
- 固定 baseline：`20%`

### 6.6 Stage 3: Evaluation & Promotion

目标：

- 决定当前 checkpoint 是否能替换 best 模型。

第一版晋级规则默认：

- 关键固定 matchup 上总胜率相对当前 best 上升至少 `2%`
- 新模型总胜率达到至少 `54%`
- 对固定 baseline 不得显著退化
- 固定 matchup 回归集不得显著下滑

### 6.7 Data Protocol

```ts
interface DataProtocolV1 {
  protocol_version: "data.v1";
  warm_start_sources: Array<"branch-eval" | "combat-window" | "replay">;
  online_sources: Array<"self-play">;
  sample_mix_ratio: {
    new_data: number;
    old_data: number;
  };
  invalidation_rules: {
    on_reward_version_change: "drop_or_rebuild";
    on_contract_version_change: "drop_or_rebuild";
    on_card_pool_change: "filter_by_affected_decks";
  };
}
```

第一版默认：

- `new_data : old_data = 7 : 3`
- reward / contract 版本变化后，旧数据默认重建或剔除
- 卡池变动时，仅保留未受影响 deck 的旧数据

### 6.8 Sample Protocol

第一版规定三类样本同时存在：

#### 6.8.1 Decision Point Sample

用于：

- policy / ranker 学习
- 候选动作对比

```ts
interface DecisionPointSampleV1 {
  observation: ObservationV1;
  decision_point: DecisionPointV1;
  chosen_candidate_id: string | null;
  reward_breakdown: RewardBreakdownV1 | null;
  outcome_label: number | null;
}
```

#### 6.8.2 Window Sample

用于：

- `combat-window`
- 局部展开监督
- 辅助概念监督

#### 6.8.3 Trajectory Sample

用于：

- value 回传
- self-play 更新
- 终局结果学习

### 6.9 Model Protocol

第一版推荐模型组织：

```ts
Encoder(shared)
  -> MainPolicyHead(listwise)
  -> ValueHead
  -> AuxiliaryHeads(optional)
  -> FallbackHead(optional light head)
```

默认规则：

- 主 encoder 共享 observation 表征。
- `MainPolicyHead` 读取 candidate list 上下文。
- `ValueHead` 读取 state-level encoder 输出。
- `FallbackHead` 只处理低频 family 或低置信度 routing。
- 规则策略仍保留最终兜底能力。

### 6.10 Self-Play Protocol

第一版默认：

- 边打边学，但按微批次更新，不做每步即时更新。
- 推荐每 `64` 局或每 `4096` 个 decision points 进行一次训练更新。
- replay buffer 逻辑上全局保留，但训练采样按版本、时间和 deck 过滤。
- 保留难例池 / 高 regret 池，用于周期性回灌训练与回归测试。

### 6.11 Evaluation Protocol

第一版分三层指标：

#### 6.11.1 主指标

- 固定 matchup 套件上的胜率

#### 6.11.2 副指标

- 学习速度
- 稳定性
- 对 baseline 的不退化
- 平均回合数与局部资源效率

#### 6.11.3 解释性指标

- 决策解释是否与 `Q_total` 大致一致
- 关键错例上是否能复盘出错误归因

### 6.12 Diagnostics Protocol

第一版要求每个 decision point 至少记录：

```ts
interface DecisionPointLogV1 {
  game_id: string;
  episode_id: string;
  decision_point_id: string;
  observation_ref: string;
  candidate_ids: string[];
  candidate_scores: number[];
  selected_candidate_id: string | null;
  selected_route: "main_head" | "fallback_head" | "rule_policy";
  reward_breakdown: RewardBreakdownV1 | null;
  value_prediction: number | null;
  terminal_outcome: number | null;
  model_version: string;
  reward_version: string;
  obs_version: string;
  action_version: string;
}
```

第一版默认排障优先级：

1. reward
2. action contract / routing
3. observation / derived features
4. training schedule / opponent pool

### 6.13 当前仍可调但不阻塞实现的参数

下面这些项现在可以先按默认值实现，后续再调：

- `listwise` 与 `pairwise` 的损失权重
- 各 shaping 系数
- 更新批次大小
- 对手池比例
- 晋级阈值
- 难例池采样频率

### 6.14 training protocol 的验收标准

只要满足下面六条，就认为 `training protocol v1` 可进入实现：

- 可从统一 contract 数据源跑通 warm start。
- 可从 self-play 持续生成统一日志与训练样本。
- 可按固定协议训练出新 checkpoint。
- 可按固定 matchup 套件稳定评测。
- 可按固定规则决定 checkpoint 是否晋级。
- 任一关键失败样本都能从日志回放到 decision point 粒度。

## 七、当前已经定下来的默认值

为了避免实现时再次悬空，第一版直接采用以下默认值：

- observation 使用固定队伍顺序编码，不按出战位重排。
- candidate 使用稳定规范化排序，并保留 `engine_index`。
- policy 主输出采用 `listwise` 打分，`pairwise` 仅作辅助监督。
- reward 采用“终局 + 少量通用 shaping”。
- `deck-specific` shaping 不进入第一版主训练线。
- self-play 对手池比例固定为 `40 / 40 / 20`。
- 在线训练按微批次更新，默认 `64` 局或 `4096` 个 decision points 一次更新。
- 主验收指标是固定 matchup 胜率。

## 八、从这里到实现还差什么

到这一步，4 个落地件已经不再是“方向性提纲”，而是进入了“可实现默认规格”的状态。

现在距离真正开工，主要还差的是：

- 把 observation 字段映射到实际引擎字段。
- 把各 family 的 candidate 导出器写出来。
- 把 reward 事件计算器写出来。
- 把 decision point / trajectory 日志 schema 接入训练管线。

也就是说：

- 理论框架已经足够。
- 规格文档已经足够。
- 下一步就该进入接口实现，而不是继续扩概念。


## 九、`observation schema v1` 到现有引擎字段的映射

这一节的目的不是重复 schema，而是把 `ObservationV1` 中的字段和现有实现里的真实来源一一对齐，减少实现时的歧义。

当前默认把字段来源分成 4 类：

- `DIRECT_PB`：可直接从 `exposeState -> PbGameState` 读取
- `DERIVED_PB`：可由 `PbGameState` 直接计算得到
- `RAW_ONLY`：当前只能从原始 `GameState` 或额外适配层读取
- `ESTIMATED`：只能由牌表、公开信息和统计估计得到

### 9.1 顶层字段映射

| ObservationV1 字段 | 当前来源 | 实际字段 | 说明 |
|---|---|---|---|
| `source.view_kind` | adapter | adapter constant | 由导出器写入，不来自引擎 |
| `source.game_version` | adapter | runtime config | 由训练/运行环境注入 |
| `source.card_pool_version` | adapter | card pool metadata | 由牌池版本管理注入 |
| `source.ruleset_version` | adapter | ruleset metadata | 由规则版本管理注入 |
| `source.contract_version` | adapter | contract constant | 由 observation exporter 写入 |
| `point.round_number` | `DIRECT_PB` | `game_state.roundNumber` | `exposeState` 已直接暴露 |
| `point.phase` | `DIRECT_PB` | `game_state.phase` | 当前 phase 枚举已可直接映射 |
| `point.current_turn` | `DIRECT_PB` | `game_state.currentTurn` | 直接读取 |
| `point.actor_who` | `DERIVED_PB` | `currentTurn` + caller side | 第一版默认等于当前导出视角的行动方 |
| `point.pending_method` | adapter | MCP pending RPC | 不在 `PbGameState` 内，需要由 mcp/引擎调度层注入 |
| `point.game_id` | adapter | episode metadata | 由训练管线生成 |
| `point.episode_id` | adapter | episode metadata | 由训练管线生成 |
| `point.decision_point_id` | adapter | point metadata | 由 decision point exporter 生成 |
| `point.action_count_in_round` | `RAW_ONLY` | action trace / exporter counter | 当前 `PbGameState` 不直接提供，建议由导出器维护计数 |

### 9.2 玩家级字段映射

`ObservationV1.self` 与 `ObservationV1.opponent` 都映射到 `PbGameState.player[i]`，只是在 `policy_public` 下对对手信息做遮蔽。

| PlayerObservationV1 字段 | 当前来源 | 实际字段 | 说明 |
|---|---|---|---|
| `active_character_index` | `DERIVED_PB` | `player.activeCharacterId` + `player.character[].id` | 通过角色 id 反查槽位 |
| `characters` | `DIRECT_PB` | `player.character[]` | 直接暴露 |
| `summons` | `DIRECT_PB` | `player.summon[]` | 直接暴露 |
| `supports` | `DIRECT_PB` | `player.support[]` | 直接暴露 |
| `combat_statuses` | `DIRECT_PB` | `player.combatStatus[]` | 直接暴露 |
| `dice` | `DIRECT_PB` | `player.dice[]` | 对手在 `policy_public` 下为 `UNSPECIFIED` |
| `hand` | `DIRECT_PB` | `player.handCard[]` | 对手私有牌会被遮蔽定义信息 |
| `pile_count` | `DERIVED_PB` | `player.pileCard.length` | 当前先只读数量 |
| `discard_count` | gap | not directly exposed | 当前 `PbGameState` 不直接区分弃牌区，需要额外日志或扩展 exporter |
| `declared_end` | `DIRECT_PB` | `player.declaredEnd` | 直接暴露 |
| `can_charged` | `RAW_ONLY` | raw player flag | 不在 `PbGameState` 中；第一版若实现困难可暂时从 observation 去掉 |
| `can_plunging` | `RAW_ONLY` | raw player flag | 同上 |
| `has_defeated` | `RAW_ONLY` | raw player flag | 同上 |
| `legend_used` | `DIRECT_PB` | `player.legendUsed` | 直接暴露 |

第一版推荐处理：

- `declared_end`、`legend_used` 保留。
- `can_charged`、`can_plunging`、`has_defeated` 标记为 `optional raw-only fields`，若第一版 exporter 不走 raw state，可先移出主 observation，仅保留在 debug 日志中。
- `discard_count` 同样标记为 `optional raw-only field`。

### 9.3 角色级字段映射

| CharacterObservationV1 字段 | 当前来源 | 实际字段 | 说明 |
|---|---|---|---|
| `slot_index` | `DERIVED_PB` | `player.character[]` index | 由数组位置给出 |
| `definition_id` | `DIRECT_PB` | `character.definitionId` | 直接暴露 |
| `alive` | `DERIVED_PB` | `!character.defeated` | 当前 `PbCharacterState` 暴露的是 `defeated` |
| `is_active` | `DERIVED_PB` | `character.id === player.activeCharacterId` | 由角色实体 id 比对 |
| `health` | `DIRECT_PB` | `character.health` | 直接暴露 |
| `max_health` | `DIRECT_PB` | `character.maxHealth` | 直接暴露 |
| `energy` | `DIRECT_PB` | `character.energy` | 直接暴露 |
| `max_energy` | `DIRECT_PB` | `character.maxEnergy` | 直接暴露 |
| `aura` | `DIRECT_PB` | `character.aura` | 直接暴露 |
| `equipment_ids` | `DERIVED_PB` | `character.entity[]` filtered by type | 需要在 entity 列表中过滤装备类定义 |
| `status_ids` | `DERIVED_PB` | `character.entity[]` filtered by type | 同上 |
| `usage_counters` | `DERIVED_PB` | entity visible vars / descriptions | 需要从 entity 的 visible variable 中抽取 |

当前注意点：

- `PbCharacterState.entity[]` 混合了装备、状态等实体，第一版 observation exporter 需要先做 entity 分类。
- 角色 tags 当前可直接从 `PbCharacterState.tags` 读到，但如果不作为模型核心特征，可先只在日志保留。

### 9.4 实体级字段映射

`combat_statuses` / `summons` / `supports` / `character.entity[]` 都来自 `exposeEntity(...)` 结果，因此可以共享一个通用实体适配器。

推荐通用实体结构：

```ts
interface EntityObservationV1 {
  id: number;
  definition_id: number;
  variable_name?: string | null;
  variable_value?: number | null;
  description_dictionary?: Record<string, string>;
}
```

字段映射：

| EntityObservationV1 字段 | 当前来源 | 实际字段 |
|---|---|---|
| `id` | `DIRECT_PB` | `entity.id` |
| `definition_id` | `DIRECT_PB` | `entity.definitionId` |
| `variable_name` | `DIRECT_PB` | `entity.variableName` |
| `variable_value` | `DIRECT_PB` | `entity.variableValue` |
| `description_dictionary` | `DIRECT_PB` | `entity.descriptionDictionary` |

第一版建议：

- 训练输入只保留 `definition_id + variable_value` 等数值化字段。
- `description_dictionary` 主要用于日志和调试，不直接进主模型输入。

### 9.5 手牌与牌库映射

| 字段 | 当前来源 | 实际字段 | 说明 |
|---|---|---|---|
| `self.hand.visible_cards` | `DIRECT_PB` | `player.handCard[]` | 我方直接读取实体 |
| `self.hand.card_count` | `DERIVED_PB` | `player.handCard.length` | 直接计数 |
| `opponent.hand.visible_cards` | `DIRECT_PB` + mask | `player.handCard[]` | `policy_public` 下可能只有遮蔽实体 |
| `opponent.hand.card_count` | `DERIVED_PB` | `player.handCard.length` | 可直接计数 |
| `pile_count` | `DERIVED_PB` | `player.pileCard.length` | 当前先只读数量 |
| `remaining_deck_count` | `DERIVED_PB` | `pile_count` + known discard relation | 第一版可直接等于 `pile_count` |

第一版默认：

- 我方手牌保留逐张实体编码。
- 对手手牌在 `policy_public` 下不读取定义 id，只读数量；额外信息进入 `hidden_estimate`。
- 若 `PbEntityState` 对遮蔽手牌仍保留少量公共 tags，可放入 debug 日志，不直接进主输入。

### 9.6 骰子与资源映射

| 字段 | 当前来源 | 实际字段 | 说明 |
|---|---|---|---|
| `self.dice.counts_by_type` | `DERIVED_PB` | `player.dice[]` histogram | 直接统计 |
| `self.dice.total_count` | `DERIVED_PB` | `player.dice.length` | 直接统计 |
| `self.dice.omni_count` | `DERIVED_PB` | count(type == OMNI) | 直接统计 |
| `opponent.dice.*` | `DERIVED_PB` / masked | `player.dice[]` | `policy_public` 下只有 `UNSPECIFIED` 数量信息 |
| `self_resource_score` | `DERIVED_PB` | dice + hand + energy | 由 observation exporter 二次计算 |
| `opp_resource_score` | `DERIVED_PB` + `ESTIMATED` | masked dice + public state + estimate | 非直接字段 |

第一版默认：

- 我方骰子可以精确统计到类型。
- 对手骰子在 `policy_public` 中只保留总数与 `UNSPECIFIED` 数量，具体元素分布不推断。

### 9.7 derived 特征映射策略

下面这些字段都不是引擎直接给出的，而是 exporter 的稳定二次计算结果：

- `self_damage_capacity_now`
- `opp_damage_capacity_now`
- `self_ko_pressure_now`
- `opp_ko_pressure_now`
- `self_resource_score`
- `opp_resource_score`
- `self_reaction_ready_score`
- `opp_reaction_ready_score`
- `self_burst_online_count`
- `opp_burst_online_count`
- `self_role_integrity_score`
- `opp_role_integrity_score`
- `self_window_score`
- `opp_window_score`

第一版实现原则：

- 全部由 observation exporter 独立计算，不写在核心引擎逻辑里。
- 每个 derived 字段都必须有单独的计算函数与单元测试。
- 每个 derived 字段都必须写明输入依赖来自哪些原始字段。

### 9.8 当前必须补 adapter 的缺口

根据现有 `PbGameState` 结构，下面这些 observation 字段无法纯靠 `get_game_state` 完整得到：

- `point.pending_method`
- `point.action_count_in_round`
- `discard_count`
- `can_charged`
- `can_plunging`
- `has_defeated`

第一版推荐做法：

- `pending_method`：直接由 mcp pending RPC 注入。
- `action_count_in_round`：由 decision point exporter 自增维护。
- `discard_count`：如果当前日志管线拿不到，就先从主模型 observation 去掉，仅在增强日志中保留。
- `can_charged` / `can_plunging` / `has_defeated`：若 raw state adapter 成本低，则补进 debug 线；否则先不作为 v1 主输入字段。

也就是说，第一版 observation 并不要求所有理论字段都完全落到 `policy_public` 主输入中；只要求：

- 核心字段可稳定导出。
- 缺失字段被明确标注为 raw-only 或 optional。
- exporter 不悄悄伪造不存在的信息。

### 9.9 推荐的第一版实现顺序

基于这张映射表，`observation schema v1` 的实现顺序建议是：

1. 先做 `DIRECT_PB` 字段导出。
2. 再做 `DERIVED_PB` 字段导出。
3. 再做 `ESTIMATED` 的 `hidden_estimate`。
4. 最后决定哪些 `RAW_ONLY` 字段要进 v1 主输入，哪些仅放 debug 日志。

这样做的好处是：

- 可以先跑通最小 observation exporter。
- 不会因为少数 raw-only 字段阻塞主训练线。
- `policy_public` 与 `debug_full` 的差异也更容易独立验证。
