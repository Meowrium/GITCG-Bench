# MCPGTCG - 七圣召唤 MCP 实现

为七圣召唤模拟器提供的 MCP (Model Context Protocol) 实现，使 AI 能够通过 MCP 接口与游戏交互并实现自动打牌功能。

## 开源发布模型（推荐）

本项目采用分层发布，降低对模拟器深度魔改的维护成本：

- `core`：MCP 协议、工具、序列化、索引能力（本包的 `src/`）
- `adapter`：最小注入点（将 AI IO / state listener 接到模拟器）
- `patch`：对上游模拟器的显式补丁文件（`patches/*.patch`）

这样可以在公开 MCP 与 Skills 的同时，把对客户端改动保持为可审计、可回放、可替换。

## 发布文档

- 兼容矩阵：`COMPATIBILITY.md`
- 补丁指南：`PATCHING.md`
- 贡献指南：`CONTRIBUTING.md`
- 补丁目录说明：`patches/README.md`
- Skills 发布指南：`../../../.opencode/skills/README.md`
- 图片资源策略：`docs/ASSET_POLICY.md`

## 项目结构

```
MCPGTCG/
├── src/
│   ├── mcp/
│   │   ├── MCPProtocol.ts    # MCP 协议常量和消息构建器
│   │   ├── MCPServer.ts       # MCP 服务器实现
│   │   └── MCPToolHandler.ts  # MCP 工具处理器
│   ├── AIClientPlayerIO.ts    # AI 玩家 IO 实现
│   ├── GameStateListener.ts   # 游戏状态监听器
│   ├── GameStateSerializer.ts # 游戏状态序列化器
│   ├── card-index/            # 卡牌索引构建与查询
│   └── index.ts                # 主入口文件
├── examples/
│   └── integration.ts          # 集成示例
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## 核心组件

### 1. MCPProtocol
定义了 MCP 协议的常量、接口和消息构建函数，支持 JSON-RPC 2.0 通信。

### 2. MCPServer
MCP 服务器的核心实现，使用标准输入/输出进行通信，处理来自客户端的请求。

### 3. MCPToolHandler
定义并处理所有可用的 MCP 工具，包括：
- 状态查询：`get_game_state`, `get_screen_state`, `get_available_commands`
- 信息查询：`get_character_info`, `get_card_info`
- 游戏操作：`choose_action`, `elemental_tuning`, `choose_active`, `reroll_dice`, `switch_hands`, `select_card`

### 4. AIClientPlayerIO
实现了 `CancellablePlayerIO` 接口，用于与游戏进行交互，缓存通知和等待 RPC 请求响应。

### 5. GameStateListener
监听游戏状态变化，在游戏暂停时捕获当前状态和突变。

### 6. GameStateSerializer
将游戏状态序列化为可通过 MCP 传输的格式。

### 7. Card Index
从 `@gi-tcg/data` 源码注释构建卡牌索引（`definitionId/name/description/contentHash`），
并提供检索、解析、映射校验能力，降低 AI 在 ID 与卡牌效果之间错配的概率。

## 快速开始

### 图片资源说明（重要）

仓库默认不包含卡图二进制文件（`packages/standalone/public/card_images/`）。

- 目的：精简仓库体积与拉取时间。
- 方式：用户自行从模拟器项目图床/CDN 下载。
- 参考：`docs/ASSET_POLICY.md`
- 下载脚本：`scripts/download-card-images.sh`、`scripts/download-card-images.ps1`

### 1. 安装依赖

```bash
cd MCPGTCG
bun install
```

### 2. 构建项目

```bash
bun run build
```

### 3. 类型检查

```bash
bun run check
```

### 4. 构建卡牌索引

```bash
bun run build:card-index
```

索引输出到 `packages/mcp/.cache/card_index.latest.json`。

## 与七圣召唤集成

建议优先采用“补丁集成”方式（见 `PATCHING.md`），而不是长期维护完整 Fork。

示例命令：

```bash
bash packages/mcp/scripts/apply-standalone-patch.sh packages/mcp/patches/<patch-file>.patch
```

### 基本集成示例

```typescript
import { setupMCPGame, startMCPServerAndGame } from "@gi-tcg/mcp";
import { Version } from "@gi-tcg/core";

// 设置游戏
const { game, cleanup } = await setupMCPGame(
  deck0Code,  // 玩家0的牌组代码
  deck1Code,  // 玩家1的牌组代码
  Version.V6_3_0,  // 游戏版本
  0  // AI 玩家位置
);

// 或者同时启动 MCP 服务器和游戏
await startMCPServerAndGame(
  deck0Code,
  deck1Code,
  Version.V6_3_0,
  0
);
```

## 可用工具

### 状态查询工具

- `get_game_state` - 获取完整的游戏状态
- `get_screen_state` - 获取轻量级的屏幕状态（推荐用于大多数场景）
- `get_available_commands` - 获取当前状态下可用的命令列表

### 信息查询工具

- `get_character_info` - 获取角色详细信息
- `get_card_info` - 获取卡牌详细信息
- `list_cards` - 分页列出索引中的卡牌/角色（可按 type/tags/nameLike 过滤）
- `get_card_by_id` - 按 `definitionId` 获取标准名称、效果文本和 `contentHash`
- `resolve_card` - 按名称/ID/效果文本模糊解析并返回候选及分数
- `validate_card_mapping` - 批量校验 `definitionId` 与名称映射是否一致

### 游戏操作工具

- `choose_action` - 选择要执行的动作
- `elemental_tuning` - 显式执行元素调和（按条件匹配调和动作，可自动使用 `auto_selected_dice`）
- `choose_active` - 选择首发角色
- `reroll_dice` - 选择要重掷的骰子
- `switch_hands` - 选择要换的初始手牌
- `select_card` - 从候选卡牌中选择

## 技术栈

- TypeScript 5.x
- Bun 1.x
- tsup (构建工具)
- 七圣召唤核心库 (@gi-tcg/core)

## 架构参考

本项目参考了 [MCPTheSpire](https://github.com/example/MCPTheSpire) 项目的架构，并针对七圣召唤的特点进行了适配。

## 许可证

AGPL-3.0
