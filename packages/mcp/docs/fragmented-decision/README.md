# Fragmented Decision Route

本目录将“AI 输出片段化决策指令 -> 本地程序分析执行”的改造方案拆分为多份低耦合文档。

## 文档索引

1. `01-overview.md`
   - 路线目标、当前偏差、改造原则
2. `02-tool-boundary.md`
   - AI 可见工具 / 本地专属工具 / 权限边界
3. `03-contracts.md`
   - `TurnDigestV1`、`DecisionFragmentV1`、`ExecutionFeedbackV1` 契约
4. `04-local-resolver.md`
   - 本地解析器的职责、评分规则、失败恢复
5. `05-migration-plan.md`
   - 按阶段迁移的实施清单与验收标准
6. `../STATE_VISIBILITY_AND_ARCHITECTURE_REVIEW.md`
   - MCP 状态可见性问题、隐藏信息修复点、架构优化建议

## 使用建议

- 讨论产品方向时，只带 `01-overview.md`
- 讨论工具开放范围时，只带 `02-tool-boundary.md`
- 讨论 JSON 结构与 artifact 时，只带 `03-contracts.md`
- 讨论本地执行逻辑时，只带 `04-local-resolver.md`
- 安排实际开发任务时，只带 `05-migration-plan.md`
- 安排信息边界修复或 MCP 架构拆分时，带 `../STATE_VISIBILITY_AND_ARCHITECTURE_REVIEW.md`

## 当前结论

- 当前链路中的 `decision shard` 还不是执行权威对象。
- AI 仍可直接调用动作工具，因此系统会自然退化成“读状态 -> 直接给具体动作”。
- 真正需要下沉到本地的不是长期战略，而是“最后一跳”的动作落地与合法性判断。
