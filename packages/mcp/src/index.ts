// Copyright (C) 2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { MCPServer } from "./mcp/MCPServer";
import { AIClientPlayerIO } from "./AIClientPlayerIO";
import { GameStateListener } from "./GameStateListener";
import type { Game } from "@gi-tcg/core";

export { MCPServer } from "./mcp/MCPServer";
export { AIClientPlayerIO } from "./AIClientPlayerIO";
export { GameStateListener } from "./GameStateListener";
export { GameStateSerializer } from "./GameStateSerializer";
export { MCPToolHandler } from "./mcp/MCPToolHandler";

// Standalone MCP exports
export { StandaloneMCPServer } from "./mcp/StandaloneMCPServer";
export { StandaloneMcpToolHandler } from "./mcp/StandaloneMcpToolHandler";
export { StandaloneMcpClient, getStandaloneMcpClient } from "./StandaloneMcpClient";

let mcpServer: MCPServer | null = null;

export function initMCP(): MCPServer {
  if (mcpServer) {
    return mcpServer;
  }

  mcpServer = new MCPServer();
  console.error("MCPGTCG initialized");
  return mcpServer;
}

export function getMCPServer(): MCPServer | null {
  return mcpServer;
}

export function setupGameIntegration(
  game: Game,
  who: 0 | 1
): { aiPlayerIO: AIClientPlayerIO; stateListener: GameStateListener } {
  const server = initMCP();
  const aiPlayerIO = new AIClientPlayerIO();
  const stateListener = GameStateListener.getInstance();

  server.getToolHandler().setGame(game, aiPlayerIO, who);

  console.error(`Game integration set up for player ${who}`);

  return { aiPlayerIO, stateListener };
}

export async function startMCPServer(): Promise<void> {
  const server = initMCP();
  await server.start();
}

if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  startMCPServer().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
