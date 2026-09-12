# MCP 状态可见性与架构审计

本文记录 MCP 与 core 模拟器之间的状态可见性差异，以及后续修复和架构优化建议。

## 范围

本次审计覆盖：

- `packages/core/src/io.ts`
- `packages/core/src/preview.ts`
- `packages/core/src/game.ts`
- `packages/mcp/src/GameStateSerializer.ts`
- `packages/mcp/src/mcp/MCPToolHandler.ts`
- `packages/mcp/src/mcp/StandaloneMcpToolHandler.ts`
- `packages/standalone/src/StandaloneParentWithMCP.tsx`
- `packages/standalone/src/mcpBridgePlugin.ts`
- `packages/standalone/src/mcpCommandGuards.ts`

## 当前判断

MCP 的主状态读取路径基本遵守 core 的玩家视角：

- `get_game_state` 和 `get_screen_state` 最终使用 `exposeState(who, state)`。
- `exposeState` 会隐藏对手手牌、牌库定义、对手骰子内容和对手主动技能列表。
- standalone HTTP 桥也按每个 `who` 构造 `exposeState(who, latestState)` 快照。

但仍有两个需要修复的信息边界问题。

## P0: get_card_info 可绕过隐藏手牌边界

### 现象

内嵌式 MCP 的 `MCPToolHandler.executeGetCardInfo` 将原始 `GameState` 传入 `GameStateSerializer.getCardInfo`。

`GameStateSerializer.getCardInfo` 会直接遍历双方 `hands` 和 `pile`，支持通过 `definition_id` 或实体 `id` 反查卡牌详情。

core 的 `exposeEntity(state, card, hide=true)` 对隐藏牌会设置：

- `definitionId = 0`
- `type = UNSPECIFIED`
- 但仍保留实体 `id`

因此，如果 AI 从暴露状态中看到对手隐藏手牌实体 id，再调用 `get_card_info(opponent_hidden_card_entity_id)`，就可能拿到该隐藏牌的真实 `definition_id`、名称、效果和 zone。

### 影响

这与玩家合法信息不一致。隐藏手牌只应暴露数量和占位实体，不应允许通过辅助工具反查真实牌。

### 建议修复

优先方案：

1. 给 `GameStateSerializer.getCardInfo` 和 `getCharacterInfo` 增加 `viewer: 0 | 1` 参数。
2. 对局内实体查询只允许访问 `exposeState(viewer, state)` 中未隐藏的实体。
3. 当目标实体位于隐藏区时返回结构化错误，例如 `HIDDEN_INFORMATION`。
4. 通用资料查询继续允许按公开 `definition_id/share_id` 查询卡牌规则文本，但返回值不得附带隐藏实体的 `zone`、实体 id 或“这张牌当前在对手手牌中”之类的局面绑定信息。

可接受的短期补丁：

- `get_card_info` 如果命中 `state.players[1 - currentWho].hands` 或 `pile`，直接拒绝。
- 对 `definition_id=0` 的隐藏实体 id 不做原始状态反查。

### 回归测试建议

新增 MCP 单元测试：

- 己方手牌实体 id 调 `get_card_info` 可返回真实详情。
- 对手隐藏手牌实体 id 调 `get_card_info` 返回 `HIDDEN_INFORMATION`。
- 公开定义 id 调 `get_card_info` 可返回静态规则文本，但不声称该牌在对手手中。

## P0: preview 暴露视角硬编码为玩家 0

### 现象

`ActionPreviewer.getPreviewData()` 在整理预览 mutation 时调用 `exposeMutation(0, m)`。

这意味着玩家 1 的 action preview 也使用玩家 0 的可见性规则，而不是当前行动玩家 `this.who`。

### 影响

这会造成两个方向的不一致：

- 玩家 1 的 preview 可能缺少自己本应可见的信息。
- 如果 preview 涉及隐藏区移动、创建或移除，可能按玩家 0 的视角错误暴露信息。

MCP 的 `pendingRequest.action[].preview` 和 fragmented-decision digest 都来自 core 的 action 列表，因此会继承该问题。

### 建议修复

将 `ActionPreviewer.getPreviewData()` 改为使用当前预览持有者视角：

- `exposeMutation(this.who, m)`
- 或让 `PreviewContext` 持有 `viewerWho`，由 `ActionPreviewer` 构造时传入。

### 回归测试建议

新增 core 层测试：

- 对玩家 0 和玩家 1 分别生成同一类隐藏区相关 preview。
- 断言 preview 中隐藏实体的 `definitionId`、`type`、骰子等字段与对应玩家视角一致。

## 架构优化建议

### 1. 引入统一的信息边界层

当前状态可见性分散在：

- core `exposeState/exposeMutation`
- MCP `GameStateSerializer`
- standalone bridge snapshot
- digest builder
- card info 工具

建议抽出一个明确的 `PlayerPerspective` 或 `VisibilityService` 概念，所有面向 AI 的局面数据都必须从这里输出。

目标：

- 不允许 MCP 工具直接读取原始 `GameState` 后自行拼响应。
- 区分“公开卡牌资料”和“局内实体资料”。
- 对隐藏实体统一返回占位信息或结构化错误。

### 2. 拆分 `StandaloneMcpToolHandler`

`StandaloneMcpToolHandler.ts` 已经承担过多职责：

- MCP 工具注册
- HTTP client 调用
- 开局计划文件读写
- 牌组分析
- digest 构建
- candidate enrichment
- fragment resolver 调度
- 动作执行和反馈生成

建议拆成以下模块：

- `StandaloneToolRegistry`: 只负责工具定义和 exposure mode 过滤。
- `StandaloneActionExecutor`: 封装 pending method 校验、command context、动作提交。
- `TurnDigestBuilder`: 只负责从 screen/status 构造 `TurnDigestV1`。
- `OpeningPlanStore`: 负责 runtime plan 文件读写。
- `DeckAnalysisService`: 负责 `analyze_deck/analyze_matchup`。
- `ExecutionFeedbackBuilder`: 负责执行后反馈。

这样可以把单文件复杂度降下来，也便于针对信息边界单独写测试。

### 3. 合并重复的合法性校验逻辑

当前骰子费用和候选动作校验分散在：

- `MCPToolHandler.checkDiceRequirement`
- `StandaloneMcpToolHandler.checkDiceRequirement`
- `standalone/src/mcpBridgePlugin.ts`
- `standalone/src/mcpCommandGuards.ts`
- core `game.ts` 的最终校验

core 的最终校验仍应保留为权威防线，但 MCP/standalone 的前置校验建议共享同一个 helper，避免规则漂移。

建议新增一个轻量模块，例如：

- `packages/mcp/src/rpc-validation/actionPayload.ts`
- 或在 core 暴露只读校验工具，供 MCP 和 standalone 复用。

### 4. 合并 MCP stdio server 的重复实现

`MCPServer` 和 `StandaloneMCPServer` 的 JSON-RPC/stdin/stdout 处理几乎重复，差异主要是 tool handler。

建议抽出通用 `BaseMcpServer<THandler>`：

- 初始化流程
- `tools/list`
- `tools/call`
- `ping`
- 错误响应

两个 server 只提供不同的 handler、server name 和 session 初始化钩子。

### 5. 明确 direct-action 与 fragmented-decision 的权限模型

现有文档已经提出 fragmented-decision 模式下隐藏动作工具，但代码中仍同时存在 direct-action、fragmented-decision、pre-game fallback 等路径。

建议把工具权限模型写成可测试策略：

- `observation`: 只读观察，无动作工具。
- `direct-action`: 暴露底层动作工具，主要用于调试和 e2e。
- `fragmented-decision`: AI 只看 digest/fragment/feedback，本地 resolver 独占动作工具。

每个模式都应有工具列表快照测试，避免后续新增工具时误暴露。

### 6. 降低全局单例状态风险

`GameStateListener.getInstance()` 和 `initMCP()` 的全局单例适合单局单 AI，但不适合多会话、多游戏、双 AI 并行。

建议逐步改为 session-scoped state：

- 每个 MCP session 绑定独立 listener。
- 每个 game integration 明确注册 `gameId/sessionId/who`。
- 工具调用必须携带或解析到当前 session 上下文。

这也能降低“上一局残留状态”或“双 AI 状态互相覆盖”的风险。

### 7. 将 pendingRequest 视为敏感对象

`pendingRequest` 包含 core 生成的合法候选和 preview。它是玩家决策时可见的信息，但不应被任意工具原样复用为“全局状态”。

建议：

- digest builder 可以读取 pending action，但只能输出经过白名单字段筛选后的摘要。
- 调试工具可以返回原始 pendingRequest，但应只在 debug/direct-action 模式暴露。
- 对 pendingRequest 的 preview 添加玩家视角测试，覆盖上文 P0 preview 问题。

## 补充审计发现（2026-06 第二轮）

### 8. `@gi-tcg/tactic-mcp` 幽灵依赖

`scoring/types.ts` 和 `scoring/FragmentResolver.ts` 都 import 了 `@gi-tcg/tactic-mcp`，但 `package.json` 未声明该依赖。在严格依赖解析环境（如 pnpm strict、Yarn PnP）下会直接构建失败。

**修复**：在 `packages/mcp/package.json` 的 `dependencies` 中添加 `"@gi-tcg/tactic-mcp": "workspace:*"`。

### 9. CandidateEnricher 提取后残留重复代码

`CandidateEnricher.ts` 已经从 `StandaloneMcpToolHandler` 提取了 preview mutation helpers（`extractPreviewMutations`、`sumDamageFromPreview`、`ELEMENT_NAMES`、`REACTION_NAMES`），但原文件中的副本从未删除，形成双份维护。

**修复**：`StandaloneMcpToolHandler` 改为从 `CandidateEnricher` 或共享模块导入这些 helpers。

### 10. `GameStateSerializer` 内部 return-object 构造重复

`getCharacterInfo()` 的 4 个 lookup 分支和 `getCardInfo()` 的 5 个 lookup 分支各自重复构造相同的 return 对象（包括 `details` 子对象），导致单文件 522 行中约 40% 是重复代码。

**修复**：提取 `buildCharacterResult()` 和 `buildCardResult()` 私有 builder 方法。

### 11. `buildStructuredError` 在两个 handler 中各有一份

`MCPToolHandler.buildStructuredError()` 和 `StandaloneMcpToolHandler.buildStructuredError()` 实现完全相同。

**修复**：提取到 `mcp/shared-utils.ts`。

### 12. `card-index/` 模块无测试覆盖

`CardIndexStore`、`buildFromDataSource`、`buildCardIndex` 均无单元测试。

**修复**：补充基本测试用例。

### 13. ~~`FragmentResolver` deprecated stub 未清理~~ （误报）

经代码审查，`FragmentResolver.resolve()` 的 tag-based scoring 路径（712-1238 行）是**完整的工作代码**，作为 DSL rules 的 fallback 路径正常运行，测试覆盖完整。无需清理。

## 建议实施顺序

1. 修复 `@gi-tcg/tactic-mcp` 幽灵依赖。
2. 修复 `get_card_info/get_character_info` 的原始状态反查边界。
3. 修复 `ActionPreviewer` preview 视角硬编码。
4. 补齐 visibility 回归测试。
5. 抽出共享工具函数（`buildStructuredError`、`checkDiceRequirement`、`isOpponentDeckAllowed`）。
6. 清理 `StandaloneMcpToolHandler` 中与 `CandidateEnricher` 重复的 preview/reaction helpers。
7. 提取 `GameStateSerializer` 的 return-object builder。
8. 抽出共享 action payload 校验 helper。
9. 拆分 `StandaloneMcpToolHandler` 的 digest、executor、plan store。
10. 合并 MCP server 基类。
11. 将 tool exposure mode 做成可测试策略。
12. 清理 `FragmentResolver` deprecated stub。
13. 为 `card-index` 模块补充单元测试。

## 验收标准

- AI 无法通过隐藏手牌实体 id 查询真实牌。
- 玩家 0 和玩家 1 的 action preview 都按各自视角隐藏信息。
- `get_game_state/get_screen_state/get_turn_digest_v1` 均不包含对手隐藏手牌定义。
- direct-action 和 fragmented-decision 的可见工具列表有快照测试。
- core 仍保留最终动作合法性校验，MCP 只做前置体验校验。
- `package.json` 声明所有实际使用的依赖，无幽灵依赖。
- `StandaloneMcpToolHandler` 与 `CandidateEnricher` 之间无重复 helpers。
- `MCPServer` 与 `StandaloneMCPServer` 共享基类，无重复 JSON-RPC 处理代码。
- `GameStateSerializer` 的 return 对象通过 builder 方法构造，无重复代码块。
