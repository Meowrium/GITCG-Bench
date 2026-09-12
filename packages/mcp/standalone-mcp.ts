#!/usr/bin/env -S npx tsx
// Standalone MCP Server Entry Point
// This MCP server connects to a running standalone game via HTTP API
//
// Usage: bun standalone-mcp.ts [--url http://localhost:3001]

import { StandaloneMCPServer } from "./src/mcp/StandaloneMCPServer";

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let baseUrl = "http://localhost:3901";
  let who: 0 | 1 = 0;
  let toolExposureMode: "direct-action" | "fragmented-decision" = "direct-action";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--url":
      case "--base-url":
        baseUrl = args[++i];
        break;
      case "--who":
      case "--player": {
        const raw = args[++i];
        const parsed = parseInt(raw, 10);
        if (parsed === 0 || parsed === 1) {
          who = parsed as 0 | 1;
        } else {
          console.error(`Invalid --who value: ${raw}. Must be 0 or 1.`);
          process.exit(1);
        }
        break;
      }
      case "--tool-exposure-mode": {
        const raw = args[++i];
        if (raw === "direct-action" || raw === "fragmented-decision") {
          toolExposureMode = raw;
        } else {
          console.error(`Invalid --tool-exposure-mode value: ${raw}. Must be direct-action or fragmented-decision.`);
          process.exit(1);
        }
        break;
      }
      case "--help":
      case "-h":
        console.log(`
Standalone MCP Server for Genius Invokation TCG
================================================

This MCP server connects to a running standalone game via HTTP API
and exposes tools for AI control.

Usage: bun standalone-mcp.ts [options]

Options:
  --url, --base-url <url>  Standalone game URL (default: http://localhost:3901)
  --who, --player <0|1>    Which player to control (default: 0)
  --tool-exposure-mode <direct-action|fragmented-decision>
                            Which MCP tool surface to expose (default: direct-action)
  --help, -h              Show this help message

Prerequisites:
  1. Start the standalone game with MCP bridge enabled:
     cd packages/standalone && bun run dev
     (or use the one-click PowerShell script)

  2. For AI vs AI: start two MCP servers:
     bun standalone-mcp.ts --who 0    # Controls Player 0 (first-player)
     bun standalone-mcp.ts --who 1    # Controls Player 1 (second-player)

Available MCP Tools:
  wait_for_my_turn     Wait (blocking) until it's your turn to act
  standalone_ping       Check connection to standalone game
  get_game_status       Get current game status
  get_game_state        Get complete game state
  get_screen_state      Get lightweight screen state
  get_available_commands Get available commands for current state
  choose_action         Choose an action
  choose_active         Choose active character
  reroll_dice           Reroll dice
  switch_hands          Switch initial hand cards
  select_card           Select a card

Examples:
  # Control Player 0
  bun standalone-mcp.ts --who 0

  # Control Player 1 on a custom port
  bun standalone-mcp.ts --url http://localhost:3001 --who 1

  # AI vs AI: start both servers in separate terminals
  # Terminal 1: bun standalone-mcp.ts --who 0
  # Terminal 2: bun standalone-mcp.ts --who 1
`);
        process.exit(0);
    }
  }

  console.error(`🃏 Standalone MCP Server starting...`);
  console.error(`   Target: ${baseUrl}`);
  console.error(`   Player: ${who} (${who === 0 ? "先手/First" : "后手/Second"})`);
  console.error(`   Tool mode: ${toolExposureMode}`);
  console.error(`========================================`);

  const server = new StandaloneMCPServer(baseUrl, who, toolExposureMode);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.error("\nShutting down MCP server...");
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.error("\nReceived SIGTERM, shutting down...");
    server.stop();
    process.exit(0);
  });

  // Start server
  try {
    await server.start();
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
