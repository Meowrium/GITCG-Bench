# 七圣召唤 MCP 使用指南

本指南将帮助您了解如何启动七圣召唤模拟器、MCP 服务器，以及如何将 MCP 功能提供给 AI 使用。

## 目录

1. [快速开始](#快速开始)
2. [启动顺序](#启动顺序)
3. [MCP 服务器配置](#mcp-服务器配置)
4. [AI 客户端集成](#ai-客户端集成)
5. [工作流程](#工作流程)

## 快速开始

### 前置要求

- Bun 1.3.x 或更高版本
- 已克隆七圣召唤项目并安装依赖

### 步骤

1. **确保项目已构建**
   ```bash
   cd genius-invokation
   bun install
   cd packages/mcp
   bun run build
  bun run build:card-index
   ```

2. **选择启动方式**
   - 方式一：集成到 standalone 模拟器（推荐）
   - 方式二：独立 MCP 服务器 + 自定义游戏集成

## 启动顺序

### 方式一：集成到 Standalone 模拟器

推荐使用 patch-first 方式集成，减少长期 fork 维护成本。

先应用补丁：

```bash
bash packages/mcp/scripts/apply-standalone-patch.sh packages/mcp/patches/standalone-v1.patch
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File packages/mcp/scripts/apply-standalone-patch.ps1 -PatchFile packages/mcp/patches/standalone-v1.patch
```

补丁与上游版本映射见 `packages/mcp/COMPATIBILITY.md`。

#### 1. 手动接入（仅在无可用补丁时）

在 `packages/standalone/src/StandaloneParent.tsx` 中，添加 MCP 集成：

```tsx
import {
  initMCP,
  setupGameIntegration,
} from "@gi-tcg/mcp";

// 在组件顶部添加
const mcpServer = initMCP();

// 在 createGame 函数中
const createGame = (state?: GameState) => {
  // ... 现有代码 ...
  
  const game = new Game(initialState);
  
  // 设置 MCP 集成（假设玩家 0 是 AI）
  const { aiPlayerIO, stateListener } = setupGameIntegration(game, 0);
  
  // 将 AI IO 分配给玩家 0
  game.players[0].io = aiPlayerIO;
  game.players[1].io = uiIo; // 保持玩家 1 为 UI 控制
  
  // 设置状态监听
  game.onPause = (state: GameState, mutations: Mutation[], canResume: boolean) => {
    stateListener.onPause(state, mutations as any, canResume);
    // ... 现有代码 ...
  };
  
  return game;
};
```

#### 2. 启动 Standalone 模拟器

```bash
cd packages/standalone
bun run dev
```

#### 3. 启动 MCP 服务器

在另一个终端窗口中：

```bash
cd packages/mcp
bun run dev
```

### 方式二：独立 MCP 服务器

如果您想使用自己的游戏集成，可以使用独立的 MCP 服务器。

#### 1. 创建集成脚本

创建一个新文件 `packages/mcp/examples/start-game.ts`：

```typescript
import getData from "@gi-tcg/data";
import { Game, Version } from "@gi-tcg/core";
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";
import {
  initMCP,
  setupGameIntegration,
  startMCPServer,
} from "@gi-tcg/mcp";

async function main() {
  console.log("Starting MCP server...");
  await startMCPServer();

  console.log("Setting up game...");
  const mcpServer = initMCP();

  // 示例牌组（您需要替换为真实的牌组代码）
  const deck0Code = "YOUR_DECK_CODE_HERE";
  const deck1Code = "YOUR_DECK_CODE_HERE";

  const deck0 = DEFAULT_ASSETS_MANAGER.decode(deck0Code);
  const deck1 = DEFAULT_ASSETS_MANAGER.decode(deck1Code);

  const initialState = Game.createInitialState({
    decks: [deck0, deck1],
    data: getData(Version.V6_3_0),
    versionBehavior: Version.V6_3_0,
  });

  const game = new Game(initialState);
  const { aiPlayerIO, stateListener } = setupGameIntegration(game, 0);

  game.players[0].io = aiPlayerIO;

  game.onPause = (state, mutations, canResume) => {
    stateListener.onPause(state, mutations as any, canResume);
  };

  console.log("Starting game...");
  game.start().catch(console.error);
}

main().catch(console.error);
```

#### 2. 运行集成脚本

```bash
cd packages/mcp
bun run examples/start-game.ts
```

## MCP 服务器配置

### MCP 客户端配置文件

为了让 AI 客户端（如 Claude Desktop、Cherry Studio）能够使用我们的 MCP 服务器，您需要创建一个配置文件。

#### Claude Desktop 配置

在 Claude Desktop 的配置文件中添加：

**Windows:**
```json
{
  "mcpServers": {
    "genius-invokation": {
      "command": "bun",
      "args": [
        "run",
        "d:/AI/GTCG/genius-invokation/packages/mcp/src/index.ts"
      ],
      "cwd": "d:/AI/GTCG/genius-invokation"
    }
  }
}
```

**macOS/Linux:**
```json
{
  "mcpServers": {
    "genius-invokation": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/genius-invokation/packages/mcp/src/index.ts"
      ],
      "cwd": "/path/to/genius-invokation"
    }
  }
}
```

#### Cherry Studio 配置

Cherry Studio 使用不同的配置格式。在 Cherry Studio 的 MCP 设置中添加：

**配置名称**: `genius-invokation`

**命令**: `bun`

**参数**:
```
run
d:/AI/GTCG/genius-invokation/packages/mcp/cherry-studio-mcp.ts
```

**工作目录**: `d:/AI/GTCG/genius-invokation`

**环境变量**: （留空）

> **注意**: Cherry Studio 的配置格式与 Claude Desktop 不同，需要使用专门的启动脚本 `cherry-studio-mcp.ts`。

#### Claude Code 配置

Claude Code 使用与 Claude Desktop 相同的配置格式，但配置文件位置不同。

**配置文件内容** (`claude_code_config.json`):
```json
{
  "mcpServers": {
    "genius-invokation": {
      "command": "bun",
      "args": [
        "run",
        "d:/AI/GTCG/genius-invokation/packages/mcp/claude-code-mcp.ts"
      ],
      "cwd": "d:/AI/GTCG/genius-invokation",
      "env": {}
    }
  }
}
```

**配置步骤**:
1. 在项目根目录创建 `.claude/mcp.json` 文件
2. 将上述配置复制到文件中
3. 重启 Claude Code

或使用全局配置：
- **Windows:** `%USERPROFILE%\.claude\mcp.json`
- **macOS/Linux:** `~/.claude/mcp.json`

> **注意**: Claude Code 需要使用专门的启动脚本 `claude-code-mcp.ts`，而不是直接运行 `src/index.ts`。

### 配置文件位置

- **Claude Desktop:**
  - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
  - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
  - **Linux:** `~/.config/Claude/claude_desktop_config.json`

- **Claude Code:**
  - **项目级:** `<project-root>/.claude/mcp.json`
  - **全局:** `~/.claude/mcp.json` (macOS/Linux) 或 `%USERPROFILE%\.claude\mcp.json` (Windows)

- **Cherry Studio:** 在应用内的 MCP 设置界面直接配置

## AI 客户端集成

### 可用的 MCP 工具

一旦 MCP 服务器连接成功，AI 将能够使用以下工具：

#### 状态查询工具

1. **`get_game_state`**
   - 描述：获取完整的游戏状态
   - 参数：无
   - 返回：完整的游戏状态 JSON

2. **`get_screen_state`**
   - 描述：获取轻量级的屏幕状态（推荐用于大多数场景）
   - 参数：无
   - 返回：简化的游戏状态

3. **`get_available_commands`**
   - 描述：获取当前状态下可用的命令列表
   - 参数：无
   - 返回：可用工具列表

#### 信息查询工具

4. **`get_character_info`**
   - 描述：获取角色详细信息
   - 参数：
     - `character_id` (number): 角色 ID（支持 definition_id / entity_id / share_id）
   - 返回：角色详细信息（基础状态 + `details.skills` 技能描述/费用等）

5. **`get_card_info`**
   - 描述：获取卡牌详细信息
   - 参数：
     - `card_id` (number): 卡牌 ID（支持 definition_id / entity_id / share_id）
   - 返回：卡牌详细信息（`details` 包含行动牌效果、费用、目标、关联角色、技能等）

6. **`list_cards`**
   - 描述：从本地索引分页列出卡牌/角色，用于检索与筛选
   - 参数：
     - `version` (string, 可选): 版本标签，默认 latest
     - `language` (string, 可选): `zh-CN` / `en-US`
     - `filter` (object, 可选):
       - `type` (string, 可选)
       - `tags` (string[], 可选)
       - `nameLike` (string, 可选)
     - `page` (number, 可选): 页码，从 1 开始
     - `pageSize` (number, 可选): 每页条数，最大 200
   - 返回：`total` + `items[]`（含 `definitionId/canonicalName/effectText/contentHash`）

7. **`get_card_by_id`**
   - 描述：按 `definitionId` 获取标准卡牌内容
   - 参数：
     - `definitionId` (number): 卡牌定义 ID
     - `version` (string, 可选)
     - `language` (string, 可选)
     - `include_source` (boolean, 可选): 是否附带源码路径与片段
   - 返回：`card`（标准名称、效果文本、类型、标签、`contentHash`）

8. **`resolve_card`**
   - 描述：按名称/ID/描述模糊解析卡牌候选
   - 参数：
     - `query` (string): 查询关键词
     - `topK` (number, 可选): 候选数量，最大 20
     - `version` (string, 可选)
     - `language` (string, 可选)
   - 返回：`candidates[]`（含 `definitionId/canonicalName/score/contentHash`）

9. **`validate_card_mapping`**
   - 描述：批量校验 `definitionId` 与卡牌名称是否匹配
   - 参数：
     - `items` (array): `[{ definitionId, name }]`
     - `version` (string, 可选)
     - `language` (string, 可选)
   - 返回：`results[]`（`matched/reason/canonicalName/contentHash`）

#### 游戏操作工具

10. **`choose_action`**
   - 描述：选择要执行的动作
   - 参数：
     - `action_index` (number): 1-indexed 的动作索引
     - `used_dice` (array, 可选): 要使用的骰子类型数组
   - 返回：操作结果

11. **`elemental_tuning`**
   - 描述：显式执行元素调和（弃置手牌并将 1 颗基础骰转为目标元素）
   - 参数：
     - `removed_card_id` (number, 可选): 指定要弃置的手牌实体 ID
     - `target_dice` (number, 可选): 指定调和目标骰类型
     - `used_dice` (array, 可选): 指定要消耗的骰子；不传时优先使用动作的 `auto_selected_dice`
   - 返回：操作结果

12. **`choose_active`**
   - 描述：选择首发角色
   - 参数：
     - `character_id` (number): 角色 ID
   - 返回：操作结果

13. **`reroll_dice`**
   - 描述：选择要重掷的骰子
   - 参数：
     - `dice_to_reroll` (array): 要重掷的骰子类型数组（DiceType 枚举值）
   - 返回：操作结果

14. **`switch_hands`**
   - 描述：选择要换的初始手牌
   - 参数：
     - `removed_hand_ids` (array): 要移除的卡牌 ID 数组
   - 返回：操作结果

15. **`select_card`**
    - 描述：从候选卡牌中选择
    - 参数：
      - `selected_definition_id` (number): 卡牌定义 ID
    - 返回：操作结果

## 工作流程

### 卡牌信息防错配推荐流程

1. 优先使用 `resolve_card` 获取候选 `definitionId`
2. 使用 `get_card_by_id` 拉取标准内容并记录 `contentHash`
3. 若模型持有外部名称列表，使用 `validate_card_mapping` 批量校验
4. 在策略推理中统一以 `definitionId` 为主键，名称/效果只作展示
5. 执行动作前再用 `get_card_by_id` 进行一次关键卡复核

### 完整的 AI 游戏流程

1. **启动游戏和 MCP 服务器**
   ```
   [Terminal 1] 启动 Standalone 模拟器
   [Terminal 2] 启动 MCP 服务器
   ```

2. **AI 连接到 MCP 服务器**
   - Claude Desktop 或其他 MCP 客户端启动时会自动连接

3. **AI 获取游戏状态**
   ```
   AI: 调用 get_game_state 或 get_screen_state
   MCP: 返回当前游戏状态
   ```

4. **AI 分析可用操作**
   ```
   AI: 调用 get_available_commands
  MCP: 返回当前可用工具 + has_pending_rpc/pending_method/wait_hint/retry_after_ms
   ```

5. **AI 执行操作**
   ```
   AI: 根据游戏状态选择并调用相应的工具
       (例如：choose_action, choose_active 等)
   MCP: 执行操作并更新游戏状态
   ```

  执行规则建议：
  - 当 `has_pending_rpc=false` 时进入等待态，不调用动作工具，仅按 `retry_after_ms` 低频轮询。
  - 当返回 `error_code/recover_hint` 时，按提示修正参数后最多重试 1-2 次。
  - 若同一决策点连续失败，切换到其他合法动作，避免 token 浪费。

6. **循环步骤 3-5**
   - 直到游戏结束

### AI 提示示例

您可以使用以下提示来指导 AI 如何玩七圣召唤：

```
你是一个七圣召唤（Genius Invokation TCG）的专业玩家。你的目标是通过 MCP 工具与游戏交互并赢得比赛。

游戏流程：
1. 首先使用 get_screen_state 了解当前游戏状态
2. 使用 get_available_commands 查看可用操作
3. 根据游戏状态和可用操作，选择最合适的工具执行
4. 重复上述步骤直到游戏结束

注意事项：
- 仔细分析当前游戏状态（回合、骰子、手牌、角色状态等）
- 优先考虑元素反应和角色技能配合
- 合理管理骰子资源
- 注意对手的行动和可能的反击
- 当有多个可用动作时，选择最优策略
- 严格遵循 get_available_commands 返回的 pending_method 与 available_tools
- 当 has_pending_rpc=false 时进入等待态，仅低频轮询
- 若返回 error_code/recover_hint，按 recover_hint 修正一次后再重试
- 单个决策点最多重试 2 次，避免无效 token 消耗

现在，让我们开始游戏！
```

## 故障排除

### 常见问题

1. **MCP 服务器无法启动**
   - 检查 Bun 版本是否为 1.3.x 或更高
   - 确保已运行 `bun install`
   - 检查端口是否被占用

2. **AI 无法连接到 MCP 服务器**
   - 验证配置文件路径是否正确
   - 检查命令路径是否正确
   - 查看 AI 客户端的日志输出

3. **游戏操作无响应**
   - 确保 MCP 服务器正在运行
   - 检查游戏状态监听器是否正确设置
   - 验证 AI PlayerIO 是否正确分配给游戏玩家

4. **类型错误**
   - 确保已运行 `bun run build`
   - 检查依赖是否正确安装

### 获取帮助

如果遇到问题：
1. 检查终端输出的错误信息
2. 查看游戏日志
3. 确保所有依赖都已正确安装

## 下一步

- 尝试不同的 AI 提示策略
- 探索更高级的游戏集成方式
- 为 MCP 工具添加更多功能
- 创建自定义的游戏模式和挑战

祝您玩得愉快！
