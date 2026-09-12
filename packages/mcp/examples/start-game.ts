// Example: Starting a standalone MCP server
//
// This starts a StandaloneMCPServer that connects to a running
// game via the HTTP bridge API.
//
// Usage:
//   First start a standalone game, then run this server.

import { StandaloneMCPServer } from "@gi-tcg/mcp";

async function main() {
  const baseUrl = process.env.GAME_BASE_URL ?? "http://localhost:3901";
  const server = new StandaloneMCPServer(baseUrl, 0, "direct-action");

  console.error(`Starting MCP server, connecting to ${baseUrl}...`);
  await server.start();
}

main().catch(console.error);
