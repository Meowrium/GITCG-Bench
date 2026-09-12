# Standalone MCP Windows 启动方式

本文说明 Windows 下 standalone dev server 与 MCP server 的启动方式及配套脚本现状。

关于令牌的重要现状：

- **`MCP_HTTP_API_TOKEN` 目前没有任何代码读取**——HTTP 桥（`packages/standalone/src/mcpBridgePlugin.ts` → `@gi-tcg/mcp` 的 `src/bridge/httpHandler.ts`）不校验令牌。
- `.opencode/*.json` 配置仍会向 MCP 进程注入该变量，属**预留**；`scripts/ensure-gi-mcp-token.ps1` 仍可用于生成/轮换用户级令牌，为未来重新启用校验预留。

## 配套脚本现状（已全部改用 pnpm）

- `scripts/start-gi-standalone-dev.ps1`
  - 在 `packages/standalone` 下执行 `pnpm dev`。
  - 注意：脚本顶部仍会检查 `MCP_HTTP_API_TOKEN` 是否已设置，未设置则报错并提示先运行 `scripts/ensure-gi-mcp-token.ps1`（脚本级守卫；桥本身不校验）。
- `scripts/start-gi-standalone-mcp.ps1`
  - 执行 `pnpm exec tsx standalone-mcp.ts --tool-exposure-mode <mode> --url <baseUrl>`（工作目录 `packages/mcp`）。
  - 默认 `-ToolExposureMode direct-action`、`-BaseUrl http://localhost:3901`。
  - **不再强制检查 token**。
- `scripts/start-gi-standalone-oneclick.ps1`
  - 先调用 `ensure-gi-mcp-token.ps1` 准备（预留的）用户级令牌，再以固定端口启动：`pnpm exec vite --host <host> --strictPort --port <port>`（默认 3901）。
- `scripts/start-gi-standalone-oneclick.sh`
  - Git Bash 变体。⚠️ 其末行仍是 `bunx --bun vite ...`，未随本轮改造更新（本仓库已禁用 bun）。请改用 `.ps1` 版本，或直接 `cd packages/standalone && pnpm dev`。

## 推荐流程

### 1.（可选）准备令牌

仅在你想提前为未来校验做准备时需要：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ensure-gi-mcp-token.ps1
# 轮换：加 -Rotate
```

当前桥不校验令牌，跳过本步不影响使用。

### 2. 启动 standalone dev server

```powershell
cd packages/standalone
pnpm dev
```

或使用脚本：`scripts/start-gi-standalone-dev.ps1` / `scripts/start-gi-standalone-oneclick.ps1`。

注意：standalone dev 默认把 `@gi-tcg/mcp` 解析到 `dist`。**改动 `packages/mcp` 后需先 `cd packages/mcp && pnpm build`，再重启 dev server**。

### 3. 在浏览器中开局

打开 http://localhost:3901 → 「MCP模式」tab → 将需要 AI 控制的玩家设为 AI → 点「开始对局」。

### 4. 让编辑器拉起 MCP

工作区现有配置 `.opencode/mcp.json` 已指向：

```
pnpm exec tsx packages/mcp/standalone-mcp.ts --tool-exposure-mode direct-action --url http://localhost:3901
```

（旧文档中的 `--ensure-standalone` 参数已不存在；MCP server 不再自动拉起 standalone，需按第 2 步先启动 dev server。）

## 调试用手动启动

脱离编辑器手动调 MCP 时：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-gi-standalone-mcp.ps1
# 可选参数：
powershell -ExecutionPolicy Bypass -File .\scripts\start-gi-standalone-mcp.ps1 -BaseUrl http://localhost:3901 -ToolExposureMode fragmented-decision
```

## 常见问题

### 1. MCP 能启动，但一直连不上 standalone

- 确认 dev server 已在运行（`cd packages/standalone && pnpm dev`），端口与 MCP 的 `--url` 一致（默认 3901）。
- 确认浏览器中已在「MCP模式」tab 开局，且对应玩家设为 AI。
- `.opencode/start-both.ps1` 内置 `check-ready.ps1` 预检，会等待桥报告双方 AI 连接并就绪。

### 2. 令牌相关报错（`MCP_HTTP_API_TOKEN_REQUIRED` / `STANDALONE_AUTH_FAILED`）

桥端校验已移除，这些错误在当前代码中不存在。若看到，说明运行的是旧版本代码；仅 `start-gi-standalone-dev.ps1` / `start-gi-standalone-oneclick.ps1` 在脚本层仍要求该环境变量存在（运行 `ensure-gi-mcp-token.ps1` 即可满足）。

### 3. `.opencode` 和 `.claude` 现在应指向哪里

配置应统一指向：

- `packages/mcp/standalone-mcp.ts`（经 `pnpm exec tsx` 启动）
- `--tool-exposure-mode direct-action`（或按需 `fragmented-decision`）
- `--url http://localhost:3901`

当前工作区里 `.opencode/mcp.json`（`mcpServers` 结构）是生效配置；`.claude/` 目录下目前没有 `mcp.json`。任何仍指向 `3001` 端口的配置都是旧配置残留。

### 4. 为什么不把 token 写进 `.opencode/mcp.json`

因为工作区文件对当前代码代理是可读的。把 token 存进仓库或工作区配置，会重新给出一条可被模型读取的绕过路径。（当前无代码校验该 token，此条为重新启用校验时的预留防护。）
