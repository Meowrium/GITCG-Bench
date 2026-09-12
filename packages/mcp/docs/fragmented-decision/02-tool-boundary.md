# Tool Boundary Design

## 目标

通过工具权限分层，强制系统走“AI 输出片段，本地执行动作”的路线。

## 原则

1. 只要 AI 还能直接调用 `choose_action`，系统就会不断退化回“直接出招”模式。
2. 因此必须把动作工具从 AI 可见面中移除，改为由本地 resolver 独占。

## AI 可见工具

建议保留：

1. `get_turn_digest_v1`
   - 读取当前时点的摘要，而不是完整游戏状态
2. `submit_decision_fragment_v1`
   - 提交语义化决策片段
3. `get_execution_feedback_v1`
   - 获取本地执行结果与偏差信息
4. `auto_select_skills`
5. `create_opening_plan_v1`
6. `create_opening_plan_v2`
7. `create_decision_shard_v2`
8. `critic_evaluate_v1`

## 本地专属工具

以下工具不再直接暴露给 AI：

1. `choose_action`
2. `choose_active`
3. `reroll_dice`
4. `switch_hands`
5. `select_card`

这些工具仍然存在，但只允许：

- 本地 orchestrator 调用
- resolver 调用
- e2e harness 调用

## 状态读取策略

AI 侧默认不再读取完整 `get_game_state`。

建议：

1. 默认只提供 `get_turn_digest_v1`
2. `get_screen_state` 仅作为调试工具保留
3. `get_game_state` 仅作为开发排障工具保留，不进入常规策略流程

## 新的对话循环

AI 不再进入“读状态 -> 直接动作工具”的循环，而是进入：

1. `get_turn_digest_v1`
2. `submit_decision_fragment_v1`
3. 等待本地程序执行
4. `get_execution_feedback_v1`
5. 如有必要，调用 `critic_evaluate_v1`

## 对现有代码的影响

1. `prompt.txt` 需要改写，不再要求 AI 直接执行动作工具
2. MCP tool registry 需要支持按客户端模式裁剪工具暴露面
3. `tactic-e2e.ts` 需要从“chooseReasonedAction”切换为“submit fragment -> local resolve -> execute”

## 验收标准

满足以下条件才算真正完成工具边界切换：

1. AI 侧 prompt 中不再出现直接动作工具的调用要求
2. AI 客户端可见工具列表不再包含 `choose_action`
3. 对局仍能正常推进
4. 本地 resolver 能在常见时点稳定落到合法动作