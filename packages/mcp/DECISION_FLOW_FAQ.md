# MCP 决策流说明（FAQ）

本文基于当前 `packages/mcp/src/mcp/StandaloneMcpToolHandler.ts` 的实现，回答 4 个核心问题。

## 1. 系统的唯一决策入口是什么？

在默认模式 `MCP_TOOL_EXPOSURE_MODE=fragmented-decision` 下，面向 LLM 的唯一“动作决策入口”是：

- `submit_decision_fragment_v1`

完整链路是：

- `get_turn_digest_v1`：生成候选动作摘要（不让 LLM 直接给 `action_index`）
- `submit_decision_fragment_v1`：LLM 提交语义意图/约束
- `get_execution_feedback_v1`：读取本地执行反馈

说明：

- `choose_action` / `elemental_tuning` 等 direct-action 工具在默认模式对 LLM 不可见。
- 这些动作工具仍可能被 executor 内部调度（内部 dispatch token）。
- 若切到 `direct-action` 模式，则入口不再唯一，LLM 可直接调用动作工具。

## 2. 谁决定最终 action，LLM 还是 executor？

结论：默认模式下最终 action 由 executor 决定。

分工如下：

- LLM 负责：提供 `intent`、`must_do`、`avoid`、`preference_order`、`resource_policy`、`fallback_rule` 等语义约束。
- executor（本地 resolver）负责：
  - 根据 digest 候选集打分（策略匹配、收益、风险、资源惩罚）。
  - 选择候选并形成执行顺序（含 fallback）。
  - 实际调用底层动作工具并处理失败重试。

因此，LLM 是“策略约束提供者”，executor 是“最终动作选择与执行者”。

## 3. 什么时候 replan（HP 变化 / 角色倒下 / 骰子异常）？

当前实现里，显式 replan 信号来自 `critic_evaluate_v1` 的输出：

- `should_replan = true` 当且仅当：
  - `hard_violations.length > 0`，或
  - critic 评分 `score < 0.4`
- `replan_scope` 当前实现默认：
  - 触发时为 `micro`
  - 不触发时为 `none`

评分会使用：

- `state_delta.self_hp_delta`
- `state_delta.opp_hp_delta`
- `state_delta.dice_spent`
- `state_delta.cards_spent`

对应你关心的事件：

- HP 明显恶化：会拉低评分，可能触发 `score < 0.4`。
- 角色倒下（KO）：建议作为 `hard_violations` 上报，直接触发 replan。
- 骰子异常（过度消耗/关键资源断档）：会通过 `dice_spent` 拉低评分；严重情况建议也作为 `hard_violations`。

补充：

- `PlanV2.trigger_rules` 支持你定义更细触发规则（如 HP 阈值、角色倒下、骰子阈值），但是否触发取决于上层如何喂给 critic/调度器，不是当前 handler 自动全量推断。

## 4. shard 生命周期

当前 `DecisionShard` 的生命周期可分为 6 步：

1. 生成
- 通过 `create_decision_shard_v1` 或 `create_decision_shard_v2` 创建。
- 落盘到：`runtime-plans/{session_id}_shard_{ts}.json`。

2. 激活（进入一个 pending RPC 决策点）
- 调用 `get_turn_digest_v1` 生成当下候选动作摘要。
- 落盘到：`runtime-plans/{session_id}_digest_{ts}.json`。
- 同时写入内存态 `fragmentedStateBySession[session_id]`。

3. 执行
- 调用 `submit_decision_fragment_v1` 提交语义片段。
- 落盘 fragment：`runtime-plans/{session_id}_fragment_{ts}.json`。
- executor 本地选动作并执行。

4. 反馈
- 执行后生成 `ExecutionFeedbackV1`。
- 落盘到：`runtime-plans/{session_id}_feedback_{ts}.json`。
- 同时写入 `lastFeedbackBySession[session_id]`。

5. 评估
- 调用 `critic_evaluate_v1` 生成 `CriticResultV1`。
- 落盘到：`runtime-plans/{session_id}_critic_{ts}.json`。
- 若 `should_replan=true`，进入重规划分支。

6. 结束或滚动
- 满足 `exit_conditions` / 无 pending RPC / 回合阶段结束：本 shard 自然结束。
- 若需要重规划：通常新建 shard（必要时回到 `create_opening_plan_v2` 更新上层计划）。

---

## 一句话总结

默认架构是“LLM 给语义，executor 选并执行动作，critic 决定是否微重规划”，`submit_decision_fragment_v1` 是默认模式下的唯一动作决策入口。
