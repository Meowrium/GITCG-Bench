import getData from "@gi-tcg/data";
import { Game, CURRENT_VERSION } from "@gi-tcg/core";
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

  const INIT_DECK0 = "FZDByRUNGRCB0WoNFlGgWpEPE0AB9TAPFGCB9kgWGIERCoEQDLFADcQQDPFgacYWDJAA";
  const INIT_DECK1 = "FdHxNj8TAWDQxFkMFkAhyWIYCYDA45wOCUDQ5J0PGEAh9IIPGWDh9p4YC6FgirYRCxAA";

  const deck0Code = INIT_DECK0;
  const deck1Code = INIT_DECK1;

  const deck0 = DEFAULT_ASSETS_MANAGER.decode(deck0Code);
  const deck1 = DEFAULT_ASSETS_MANAGER.decode(deck1Code);

  const initialState = Game.createInitialState({
    decks: [deck0, deck1],
    data: getData(CURRENT_VERSION),
    versionBehavior: CURRENT_VERSION,
  });

  const game = new Game(initialState);
  const { aiPlayerIO, stateListener } = setupGameIntegration(game, 0);

  game.players[0].io = aiPlayerIO;

  game.onPause = async (state, mutations, canResume) => {
    stateListener.onPause(state, mutations as any, canResume);
  };

  console.log("Starting game...");
  game.start().catch(console.error);
}

main().catch(console.error);
