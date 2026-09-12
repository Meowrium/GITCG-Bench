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

import getData from "@gi-tcg/data";
import {
  Game,
  GameState,
} from "@gi-tcg/core";
import type { Version } from "@gi-tcg/core";
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";
import {
  initMCP,
  setupGameIntegration,
  startMCPServer,
} from "../src";

export const INIT_DECK0 = "FZDByRUNGRCB0WoNFlGgWpEPE0AB9TAPFGCB9kgWGIERCoEQDLFADcQQDPFgacYWDJAA";
export const INIT_DECK1 = "FdHxNj8TAWDQxFkMFkAhyWIYCYDA45wOCUDQ5J0PGEAh9IIPGWDh9p4YC6FgirYRCxAA";

export async function setupMCPGame(
  deck0: string,
  deck1: string,
  version: Version,
  aiPlayerWho: 0 | 1 = 0
): Promise<{ game: Game; cleanup: () => void }> {
  const mcpServer = initMCP();

  const deck0Decoded = DEFAULT_ASSETS_MANAGER.decode(deck0);
  const deck1Decoded = DEFAULT_ASSETS_MANAGER.decode(deck1);

  const initialState = Game.createInitialState({
    decks: [deck0Decoded, deck1Decoded],
    data: getData(version),
    versionBehavior: version,
  });

  const game = new Game(initialState);

  const { aiPlayerIO, stateListener } = setupGameIntegration(game, aiPlayerWho);

  game.players[aiPlayerWho].io = aiPlayerIO;

  game.onPause = async (state: GameState, mutations: unknown[], canResume: boolean) => {
    stateListener.onPause(state, mutations as any, canResume);
  };

  const cleanup = () => {
    game.terminate();
  };

  return { game, cleanup };
}

export async function startMCPServerAndGame(
  deck0: string,
  deck1: string,
  version: Version,
  aiPlayerWho: 0 | 1 = 0
): Promise<void> {
  console.error("Starting MCP server...");
  await startMCPServer();

  console.error("Setting up game...");
  const { game, cleanup } = await setupMCPGame(deck0, deck1, version, aiPlayerWho);

  console.error("Starting game...");
  game.start().catch((e) => {
    console.error("Game error:", e);
    cleanup();
  });

  process.on("SIGINT", () => {
    console.error("\nShutting down...");
    cleanup();
    process.exit(0);
  });
}
