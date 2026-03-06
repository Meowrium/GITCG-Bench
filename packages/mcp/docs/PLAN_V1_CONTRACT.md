# PlanV1 契约（任务包 D）

本文件定义 Standalone MCP 开局计划对象 `PlanV1` 的最小字段集合与落盘约定。

## 目标

- 在首回合动作前，确保存在与当前 `sessionId` 对应的计划文件。
- 计划对象仅承载开局 1~3 回合的目标、风险与转线规则。

## 文件落点

- 目录：`genius-invokation/packages/mcp/runtime-plans`
- 命名：`{sessionId}.json`

## PlanV1 字段（最小集）

- `plan_id: string`
- `session_id: string`
- `deck_fingerprint: string`
- `source_skills: string[]`
- `global_goal: string`
- `turn1_3_priorities: string[]`
- `risk_rules: string[]`
- `pivot_rules: string[]`
- `created_at: string`（ISO8601）
- `updated_at: string`（ISO8601）
- `version: string`（当前固定 `PlanV1`）

## 生成与一致性

- `source_skills` 优先读取 `create_opening_plan_v1` 入参；为空时回退读取 `.opencode/active-skills/selected_skills.json`。
- `deck_fingerprint` 优先使用入参；为空时基于 `get_player0_deck` 的三角色 `definition_id` 排序拼接。
- `choose_action` 执行前若计划文件不存在，系统会自动生成默认 `PlanV1` 并写入。

## 兼容说明

- 若无法读取 active-skills 或 deck 信息，允许降级写入默认值（如 `base-skill`、`unknown-deck`），不阻塞对局继续。
