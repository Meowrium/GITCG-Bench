#!/usr/bin/env bun
// Standalone MCP Server Entry Point
// This MCP server connects to a running standalone game via HTTP API
//
// Usage: bun standalone-mcp.ts [--url http://localhost:3001]

import { StandaloneMCPServer } from "./src/mcp/StandaloneMCPServer";

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let baseUrl = "http://localhost:3001";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--url":
      case "--base-url":
        baseUrl = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
Standalone MCP Server for Genius Invokation TCG
================================================

This MCP server connects to a running standalone game via HTTP API
and exposes tools for AI control.

Usage: bun standalone-mcp.ts [options]

Options:
  --url, --base-url <url>  Standalone game URL (default: http://localhost:3001)
  --help, -h              Show this help message

Prerequisites:
  1. Start the standalone game with MCP bridge enabled:
     cd packages/standalone && bun run dev
     
  2. In the standalone game, enable MCP mode (if available)
     or use the StandaloneParentWithMCP component

Available MCP Tools:
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
  bun standalone-mcp.ts
  bun standalone-mcp.ts --url http://localhost:3001
`);
        process.exit(0);
    }
  }

  console.error(`🃏 Standalone MCP Server starting...`);
  console.error(`   Target: ${baseUrl}`);
  console.error(`========================================`);

  const server = new StandaloneMCPServer(baseUrl);

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
