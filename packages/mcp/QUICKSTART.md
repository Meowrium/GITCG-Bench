# 七圣召唤 MCP 快速开始指南

## 如何与 AI 开始对局

## 图片资源前置（必读）

本仓库不打包卡图文件，请先自行下载到：

`packages/standalone/public/card_images/`

可使用脚本：

- `packages/mcp/scripts/download-card-images.sh`
- `packages/mcp/scripts/download-card-images.ps1`

参数格式见：`packages/mcp/docs/ASSET_POLICY.md`

### 方法一：使用 Standalone 模拟器 + MCP（推荐）

#### 步骤 1：应用 Standalone 集成补丁

优先使用补丁方式接入（可审计、可回放）：

```bash
bash packages/mcp/scripts/apply-standalone-patch.sh packages/mcp/patches/<patch-file>.patch
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File packages/mcp/scripts/apply-standalone-patch.ps1 -PatchFile packages/mcp/patches/<patch-file>.patch
```

补丁版本与上游提交对应关系见 `packages/mcp/COMPATIBILITY.md`。
如果当前发布尚未附带补丁文件，请先按 `PATCHING.md` 自行生成补丁。

#### 步骤 1.5：手动方式（仅在无可用补丁时）

将 `packages/standalone/src/StandaloneParent.tsx` 替换为 MCP 集成版本：

```typescript
// 在文件顶部添加 MCP 导入
import {
  initMCP,
  setupGameIntegration,
} from "@gi-tcg/mcp";

// 在组件内部添加
const mcpServer = initMCP();

// 修改 createGame 函数
const createGame = (state?: GameState) => {
  if (!state) {
    const deck0 = DEFAULT_ASSETS_MANAGER.decode(props.deck0);
    const deck1 = DEFAULT_ASSETS_MANAGER.decode(props.deck1);
    state = Game.createInitialState({
      decks: [deck0, deck1],
      data: getData(props.version),
      versionBehavior: props.version,
    });
  }
  const game = new Game(state);
  game.onPause = pause;
  
  // MCP 集成：玩家 0 是 AI，玩家 1 是 UI
  const aiPlayerWho = 0;
  const integration = setupGameIntegration(game, aiPlayerWho);
  game.players[aiPlayerWho].io = integration.aiPlayerIO;
  game.players[1 - aiPlayerWho].io = uiIo;
  
  return game;
};
```

#### 步骤 2：启动模拟器

```bash
cd packages/standalone
bun run dev
```

#### 步骤 2.5：构建卡牌索引（建议）

在另一个终端窗口中执行：

```bash
cd packages/mcp
bun run build
bun run build:card-index
```

这样 AI 在调用卡牌相关工具时能拿到标准 `definitionId + 名称 + 效果 + contentHash`。

#### 步骤 3：在 Cherry Studio 中配置 MCP

1. 打开 Cherry Studio 设置 → MCP 服务器
2. 添加新配置：
   - **名称**: `genius-invokation`
   - **命令**: `bun`
   - **参数**: 
     ```
     run
     d:/AI/GTCG/genius-invokation/packages/mcp/cherry-studio-mcp.ts
     ```
   - **工作目录**: `d:/AI/GTCG/genius-invokation`
3. 保存并启用

#### 步骤 4：开始对局

1. 在浏览器中打开 Standalone 模拟器（通常是 `http://localhost:5173`）
2. 点击"开始对局"按钮
3. 在 Cherry Studio 中，AI 会自动连接到 MCP 服务器
4. 游戏开始后，AI 会收到游戏状态并开始决策

---

### 方法二：使用独立脚本

#### 步骤 1：启动 MCP 服务器

```bash
cd packages/mcp
bun run examples/start-game.ts
```

#### 步骤 2：在 Cherry Studio 中配置 MCP

同上，使用相同的配置。

#### 步骤 3：AI 自动开始游戏

脚本会自动创建游戏，AI 会立即收到初始化请求。

---

## AI 如何与游戏交互

### 游戏流程

1. **游戏初始化**
   - AI 收到 `initialize` 请求
   - MCP 服务器返回服务器信息和工具列表

2. **获取游戏状态**
   - AI 调用 `get_screen_state` 工具
   - 返回当前游戏状态（回合、骰子、手牌、角色状态等）

3. **AI 决策**
   - AI 分析游戏状态
   - 决定最佳行动

4. **执行操作**
   - AI 调用相应的工具（如 `choose_action`）
   - 游戏执行操作并更新状态

5. **循环**
   - 重复步骤 2-4 直到游戏结束

### 可用的 AI 工具

| 工具名 | 用途 |
|--------|------|
| `get_game_state` | 获取完整游戏状态 |
| `get_screen_state` | 获取简化游戏状态（推荐） |
| `get_available_commands` | 获取可用操作列表 |
| `list_cards` | 分页检索卡牌/角色索引 |
| `resolve_card` | 模糊解析卡牌候选 |
| `get_card_by_id` | 按 definitionId 获取标准卡牌内容 |
| `validate_card_mapping` | 批量校验 ID 与名称映射 |
| `choose_action` | 选择并执行动作 |
| `choose_active` | 选择首发角色 |
| `reroll_dice` | 重掷骰子 |
| `switch_hands` | 换初始手牌 |
| `select_card` | 选择卡牌 |

---

## 故障排除

### MCP 服务器无法启动
- 检查 Bun 是否已安装：`bun --version`
- 确保依赖已安装：`bun install`
- 检查路径是否正确

### AI 无法连接到 MCP
- 确认 MCP 配置中的路径正确
- 检查 Cherry Studio 的日志输出
- 确保没有其他程序占用 stdin/stdout

### 游戏没有响应
- 确认游戏已正确启动
- 检查浏览器控制台是否有错误
- 验证 MCP 服务器是否收到请求

---

## 示例对局流程

```
[用户] 启动 Standalone 模拟器
[系统] 游戏界面打开，显示"开始对局"按钮

[用户] 点击"开始对局"
[系统] 弹出子窗口，游戏开始初始化

[AI] 收到 initialize 请求
[AI] 调用 get_screen_state 获取初始状态
[AI] 分析：选择首发角色
[AI] 调用 choose_active 选择角色

[游戏] 进入掷骰阶段
[AI] 调用 reroll_dice 决定重掷哪些骰子

[游戏] 进入行动阶段
[AI] 调用 get_screen_state 获取当前状态
[AI] 分析可用操作
[AI] 调用 choose_action 执行最佳动作

... 循环直到游戏结束
```

祝您与 AI 对局愉快！
