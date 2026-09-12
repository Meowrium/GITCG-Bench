# Contracts For Fragmented Decision

## 目标

定义 AI 与本地执行层之间的最小数据契约，避免 AI 直接返回具体动作细节。

## TurnDigestV1

由本地程序生成，提供当前决策点的压缩摘要。

### 最小字段

- `version: "TurnDigestV1"`
- `session_id: string`
- `round: number`
- `turn: number`
- `pending_method: "action" | "chooseActive" | "rerollDice" | "switchHands" | "selectCard"`
- `strategic_profile_ref: string`
- `self_summary: object`
- `opponent_summary: object`
- `resource_summary: object`
- `candidate_actions: object[]`
- `hard_constraints: string[]`
- `generated_at: string`

### self_summary 建议字段

- `active_character_id`
- `bench_character_ids`
- `hp_snapshot`
- `energy_snapshot`
- `aura_snapshot`
- `hand_count`

### opponent_summary 建议字段

- `active_character_id`
- `bench_character_ids`
- `hp_snapshot`
- `known_aura_snapshot`
- `threat_flags`

### resource_summary 建议字段

- `dice`
- `dice_count`
- `omni_count`
- `cards_in_hand`
- `round_phase`

### candidate_actions 建议字段

- `candidate_id: string`
- `action_case: string`
- `cost: object`
- `damage_estimate: number`
- `reaction_value: number`
- `tempo_value: number`
- `survival_risk: number`
- `tags: string[]`
- `notes: string[]`

## DecisionFragmentV1

由 AI 生成，禁止包含具体动作索引。

### 最小字段

- `version: "DecisionFragmentV1"`
- `session_id: string`
- `digest_ref: string`
- `intent: string`
- `must_do: string[]`
- `avoid: string[]`
- `preference_order: string[]`
- `resource_policy: "strict" | "balanced" | "aggressive"`
- `decision_mode?: "plan_first" | "evidence_first" | "hybrid"`
- `local_eval_requests?: LocalEvalRequestV1[]`
- `evidence_policy?: EvidencePolicyV1`
- `target_policy: string`
- `fallback_rule: string`
- `explanation: string`
- `created_at: string`

### 新增建议字段

`local_eval_requests` 用于告诉本地工具层“先算什么再决策”，避免 LLM 直接臆测数值。

建议格式：

- `metric: "opponent_damage_upper_bound" | "opponent_damage_bayes" | "opponent_buff_probability_upper_bound" | "opponent_dice_color_inference" | "deck_tracker_remaining_outs" | "candidate_damage_exact" | "candidate_reaction_exact" | "stall_risk_score" | "other"`
- `target?: string`
- `estimate_kind: "exact" | "upper_bound" | "bayes_mean" | "heuristic"`
- `priority: 1 | 2 | 3`
- `notes?: string`

`evidence_policy` 用于约束 LLM 何时允许启发式判断：

- `require_local_eval_first: boolean`
- `separate_verified_from_inferred: boolean`
- `allow_heuristic_when_unavailable: boolean`

### 约束

- 不得包含 `action_index`
- 不得包含 `used_dice`
- 不得直接引用原始 RPC 参数结构
- 只允许表达偏好、约束、排序、兜底规则
- 需要概率/伤害/推断值时，应优先放入 `local_eval_requests`
- 若数值未被本地计算验证，必须视为 inference，而不是事实

## ExecutionFeedbackV1

由本地程序生成，反馈“片段 -> 执行结果”的映射。

### 最小字段

- `version: "ExecutionFeedbackV1"`
- `session_id: string`
- `digest_ref: string`
- `fragment_ref: string`
- `selected_candidate_id: string | null`
- `executed_tool: string | null`
- `execution_ok: boolean`
- `resolver_reason: string`
- `score_breakdown: object`
- `fallback_used: boolean`
- `notes: string[]`
- `created_at: string`

## Critic 输入变化

`critic_evaluate_v1` 建议从“评估直接动作”扩展为“评估片段导致的执行结果”。

新增建议字段：

- `fragment_ref`
- `digest_ref`
- `selected_candidate_id`
- `resolver_reason`
- `score_breakdown`

## Artifact 落盘建议

建议统一落在：

- `runtime-plans/{sessionId}_digest_{ts}.json`
- `runtime-plans/{sessionId}_fragment_{ts}.json`
- `runtime-plans/{sessionId}_feedback_{ts}.json`

便于单次对话只带某一层 artifact 进入上下文。
