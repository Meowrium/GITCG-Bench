// Diagnostic v4: FIXED — properly attach game context before starting
import { readFileSync } from "node:fs";
import getData from "@gi-tcg/data";
import { Game, CURRENT_VERSION } from "@gi-tcg/core";
import type { DeckConfig, GameState } from "@gi-tcg/core";
import { DEFAULT_ASSETS_MANAGER } from "../assets-manager/src/index";
import { GiMlMctsPolicy } from "./src/runtime/policy/gi-ml-mcts-policy.js";
import { PolicyPlayerIO } from "./src/runtime/io/policy-player-io.js";
import { BaselinePolicy } from "./src/runtime/policy/baseline-policy.js";

const ARTIFACT_DIR = "/app/v16-artifacts";
const data = getData(CURRENT_VERSION);
const benchConfig = JSON.parse(readFileSync("/app/bench-config.json", "utf8"));
const leiHeDeck = DEFAULT_ASSETS_MANAGER.decode(benchConfig.matchups[0].deck0) as DeckConfig;
const rankerArtifact = JSON.parse(readFileSync(`${ARTIFACT_DIR}/v16.ranker-artifact.json`, "utf8"));
const valueArtifact = JSON.parse(readFileSync(`${ARTIFACT_DIR}/v16.gbdt-value-artifact.json`, "utf8"));

const policy = new GiMlMctsPolicy(rankerArtifact, null, {
  endTurnPenalty: 5, temperature: 1.0, mctsIterations: 400, mctsTemperature: 0.5, valueArtifact,
} as any);

// Log choose() to confirm MCTS is active
const origChoose = (policy as any).choose.bind(policy);
let chooseCount = 0;
(policy as any).choose = function(digest: any, context: any) {
  chooseCount++;
  const state = context?.stateProvider?.() as any;
  const phase = state?.phase ?? state?.currentPhase ?? '?';
  if (chooseCount <= 5) {
    console.log(`  [choose #${chooseCount}] phase=${phase} stateKeys=${Object.keys(state||{}).slice(0,5)} turn=${state?.currentTurn}`);
  }
  return origChoose(digest, context);
};

// Log valueFn calls
let valueCalls = 0;
const origV = (policy as any)["valueFn"];
(policy as any)["valueFn"] = function(snap: any, oppSnap: any) {
  valueCalls++;
  const v = origV.call(policy, snap, oppSnap);
  if (valueCalls <= 5) {
    const sh = snap.chars.reduce((s: number,c: any)=>s+(c.alive?c.hp:0),0);
    const oh = oppSnap.chars.reduce((s: number,c: any)=>s+(c.alive?c.hp:0),0);
    console.log(`    [value #${valueCalls}] HP:${sh}/${oh} val=${v.toFixed(4)} who=${snap.who}`);
  }
  return v;
};

console.log("Starting LeiHe mirror: MCTS-GBDT(P1) vs baseline(P0)");
const state = Game.createInitialState({ decks: [leiHeDeck, leiHeDeck], data });
const game = new Game(state);
const io0 = new PolicyPlayerIO({ side: 0, policy: new BaselinePolicy() });
const io1 = new PolicyPlayerIO({ side: 1, policy, v2Enabled: true });

// CRITICAL: attach game context BEFORE assigning io
const gameContext = { data, stateProvider: () => game.state };
(io0 as any).attachGameContext?.(gameContext);
(io1 as any).attachGameContext?.(gameContext);
game.players[0].io = io0;
game.players[1].io = io1;

const start = Date.now();
const winner = await game.start();
console.log(`\nWinner: ${winner} (0=baseline, 1=MCTS-GBDT)`);
console.log(`Rounds: ${game.state.roundNumber}  Elapsed: ${Date.now()-start}ms`);
console.log(`choose() calls: ${chooseCount}  valueFn calls: ${valueCalls}`);
if (valueCalls > 0) console.log("✅ MCTS ACTIVE — GBDT value model being called!");
else console.log("❌ MCTS STILL NOT ACTIVE — valueFn never called");
console.log("Done.");
