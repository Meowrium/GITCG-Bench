## Plan: Tactic MCP Runtime Validation + Tool Stubs

在 `genius-invokation/packages/tactic-mcp` 先补齐最小可运行的 schema 校验层（请求与响应双向），再在 `genius-invokation/packages/mcp` 接入 3 个工具桩并调用该校验层，确保输出文件路径与现有 `runtime-plans` / `PlanV1` 机制兼容且不破坏 `create_opening_plan_v1` 行为。

**Steps**
1. Phase A - Baseline and contracts lock: 盘点并冻结现有契约字段与工具名，明确 `create_opening_plan_v2`、`create_decision_shard_v1`、`critic_evaluate_v1` 的 request/response schema 作为唯一真源；确认与 `PlanV1` 的兼容边界（保留现有 `runtime-plans/{sessionId}.json` 与 v1 自动兜底流程）。
2. Phase B - Build validator package in tactic-mcp (*blocks C/D*): 在 `packages/tactic-mcp` 新增最小 TS 运行时模块，加载 `schemas/mcp/tool-contracts.index.json` 并统一编译 schema；暴露按工具名校验 request/response 的 API，并输出统一错误结构（含 `error_code`、`message`、`recover_hint`、可选字段级错误详情）。
3. Phase C - Add tool stubs in mcp handler (*depends on B*): 在 `packages/mcp/src/mcp/StandaloneMcpToolHandler.ts` 的 `getToolDefinitions()` 与 `executeTool()` 中注册并分发 3 个新工具；每个工具实现“入参校验 -> 组装最小对象 -> 出参校验 -> 返回 MCP JSON 结果”链路。
4. Phase D - Runtime persistence alignment (*depends on C*): 对齐现有 `runtime-plans` 目录策略与 session 命名清理规则，新增 v2/shard/critic 文件命名规范但不改 v1 文件名；建议：PlanV2 继续写 `runtime-plans/{sanitized_sessionId}.json`（可由 `version` 区分），Shard 与 Critic 采用 `runtime-plans/{sanitized_sessionId}_shard_{ts}.json`、`runtime-plans/{sanitized_sessionId}_critic_{ts}.json`。
5. Phase E - Prompt and server discoverability (*parallel with D after C*): 更新工具列表可见性（list tools）和相关文档提示，确保代理可发现 3 个新工具，但不移除 `create_opening_plan_v1`。
6. Phase F - E2E orchestration script (*depends on C and D*): 新增一次端到端联调脚本，执行 `plan -> shard -> action -> critic -> optional replan`；其中 action 复用现有 `choose_action` 调度，不改原执行器。
7. Phase G - Tests (*parallel subparts after B/C*):
1. Schema tests: 对 `packages/tactic-mcp/schemas/examples/*.json` 与 `packages/tactic-mcp/schemas/examples/mcp/*.json` 做合法样例通过校验。
2. Negative tests: 构造非法样例验证失败路径及错误字段映射。
3. Tool handler tests: 断言 3 工具在输入错误时返回一致错误码与 hint；断言成功时返回 `ok: true` 且包含路径/实体字段。
4. Regression tests: 验证 `create_opening_plan_v1` 与 `ensurePlanV1BeforeAction()` 行为不回归。

**Relevant files**
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/README.md` - 同步运行时校验层与导出 API 说明。
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/schemas/mcp/tool-contracts.index.json` - 作为工具契约索引加载入口。
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/schemas/mcp/create-opening-plan-v2.request.schema.json` - `create_opening_plan_v2` 请求校验源。
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/schemas/mcp/create-opening-plan-v2.response.schema.json` - `create_opening_plan_v2` 响应校验源。
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/schemas/mcp/create-decision-shard-v1.request.schema.json` - `create_decision_shard_v1` 请求校验源。
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/schemas/mcp/create-decision-shard-v1.response.schema.json` - `create_decision_shard_v1` 响应校验源。
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/schemas/mcp/critic-evaluate-v1.request.schema.json` - `critic_evaluate_v1` 请求校验源。
- `d:/AI/GTCG/genius-invokation/packages/tactic-mcp/schemas/mcp/critic-evaluate-v1.response.schema.json` - `critic_evaluate_v1` 响应校验源。
- `d:/AI/GTCG/genius-invokation/packages/mcp/src/mcp/StandaloneMcpToolHandler.ts` - 新工具定义、dispatch、工具桩处理器、落盘路径对齐。
- `d:/AI/GTCG/genius-invokation/packages/mcp/src/mcp/StandaloneMCPServer.ts` - 工具调用链路保持兼容（通常无需改动，仅验证）。
- `d:/AI/GTCG/genius-invokation/packages/mcp/src/mcp/MCPProtocol.ts` - 复用 `buildToolCallResultJson` / error envelope（通常无需改动）。
- `d:/AI/GTCG/runtime-plans/` - 文件落盘兼容目录（验证路径规则）。
- `d:/AI/GTCG/genius-invokation/packages/mcp/prompt.txt` - 若需要，补充新工具调用时机提示并保持 v1 语义。

**Verification**
1. 在 `packages/tactic-mcp` 运行 schema validator 单测：合法样例全部通过、非法样例全部失败并产出一致错误码。
2. 在 `packages/mcp` 运行类型检查与测试：确认新增工具无 TS 报错且原工具回归通过。
3. 通过 MCP list tools 验证可发现 3 个新工具且 schema 入参声明存在。
4. 分别调用 3 个工具的最小请求样例，验证 request/response 双向校验生效。
5. 检查 `runtime-plans` 实际文件：v1 文件仍按原名，v2/shard/critic 文件按新增命名落盘且 JSON 结构合法。
6. 跑一次 E2E 流程：`create_opening_plan_v2 -> create_decision_shard_v1 -> choose_action -> critic_evaluate_v1`，在 `should_replan=true` 时验证可触发 replan 分支。

**Decisions**
- 目标仓库按你指定优先：`genius-invokation/packages/tactic-mcp`（校验层源头）+ `genius-invokation/packages/mcp`（工具桩接入点）。
- 校验范围采用你确认方案：请求与响应双向校验。
- 明确纳入范围：3 个工具桩 + 运行时校验 + 路径兼容 + E2E 脚本 + 测试。
- 明确排除范围：不替换现有 `create_opening_plan_v1`，不重写 `choose_action` 核心策略。

**Further Considerations**
1. PlanV2 与 PlanV1 共存策略建议：短期并存（v1 保底，v2 新增），中期再评估是否增加显式迁移工具。
2. 错误码命名建议统一前缀：`TACTIC_SCHEMA_*`（校验）、`TACTIC_TOOL_*`（工具执行）以降低跨工具歧义。
3. E2E 脚本建议支持 `--session-id` 透传，便于复现同一局链路与对比 artifact。
