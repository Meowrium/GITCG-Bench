#!/usr/bin/env bun
import getData from "@gi-tcg/data";
import { Game, type DeckConfig, type GameState } from "@gi-tcg/core";
import { staticDecode, getNameSync } from "@gi-tcg/assets-manager";

import { SimAdapter } from "./src/sim-adapter";
import { StateEvaluator } from "./src/state-evaluator";
import { BoundedSearcher } from "./src/bounded-searcher";
import { toRecommendations } from "./src/mcp-output";

const deckCode = "ATAw5BYOAUDA7U8OBNDw8ZAPCRBw9JcPC1Aw9cIPDGAg9sgPDNCQ/ckQDbEgC+MRDjAA";

console.log(`🔍 Decoding deck: ${deckCode.slice(0, 30)}...`);

const deck = staticDecode(deckCode);
console.log(`📋 Characters: ${deck.characters.map(id => getNameSync(id) ?? `ID:${id}`).join(", ")}`);
console.log(`🃏 Cards (${deck.cards.length}):`);
for (const cardId of deck.cards) {
  console.log(`   - ${getNameSync(cardId) ?? `ID:${cardId}`}`);
}

const gameData = getData();
const sim = new SimAdapter(gameData);
const evaluator = new StateEvaluator();

const searcher = new BoundedSearcher(sim, evaluator, {
  maxDepth: 6,
  beamWidth: 30,
  perspective: 0,
  enableMinimax: true,
  minimaxDepth: 1,
});

console.log(`\n🎮 Creating and initializing game...`);

const initialState = sim.createInitialState(deck, deck);
const game = new Game(initialState);

let actionState: GameState | null = null;

// Auto-play IO
const autoIo: any = {
  notify: () => {},
  rpc: async (req: any) => {
    const method = req.request?.$case;
    const value = (req.request?.value ?? {}) as any;
    switch (method) {
      case "rerollDice":
        return { response: { $case: "rerollDice", value: { diceToReroll: [] } } };
      case "chooseActive":
        return { response: { $case: "chooseActive", value: { activeCharacterId: value.candidateIds[0] } } };
      case "switchHands":
        return { response: { $case: "switchHands", value: { removedHandIds: [] } } };
      case "action":
        return { response: { $case: "action", value: { chosenActionIndex: 0, usedDice: [] } } };
      case "selectCard":
        return { response: { $case: "selectCard", value: { selectedDefinitionId: value.candidateDefinitionIds[0] } } };
      default:
        console.log(`   Unknown RPC: ${method}`);
        throw new Error(`Unknown RPC: ${method}`);
    }
  },
};

game.players[0].io = autoIo;
game.players[1].io = autoIo;

game.onPause = async (state) => {
  if (state.phase === "action") {
    actionState = state;
    game.terminate();
  }
};

try {
  await game.start();
} catch (e) {
  // Expected when terminated
}

if (!actionState) {
  console.log(`⚠️ Failed to reach action phase. Current phase: ${game.state.phase}`);
  // Fallback: manually create action state
  actionState = {
    ...initialState,
    phase: "action",
    roundNumber: 1,
  };
}

console.log(`✅ State created.`);
console.log(`   Phase: ${actionState.phase}`);
console.log(`   Current turn: ${actionState.currentTurn}`);
console.log(`   Player 0 active: ${actionState.players[0].activeCharacterId}`);
console.log(`   Player 0 characters: ${actionState.players[0].characters.map(c => c.id).join(", ")}`);

const actions = await sim.legalActions(actionState);
console.log(`   Available actions: ${actions.length}`);

// Run multiple samples to find high-value combos
const allResults: any[] = [];
const SAMPLES = 30;

console.log(`\n🔍 Running ${SAMPLES} beam search samples...`);

for (let i = 0; i < SAMPLES; i++) {
  // Vary random seed by creating new initial state
  const rawState = sim.createInitialState(deck, deck);
  const g = new Game(rawState);
  let as: GameState | null = null;
  
  g.players[0].io = autoIo;
  g.players[1].io = autoIo;
  g.onPause = async (s) => {
    if (s.phase === "action") {
      as = s;
      g.terminate();
    }
  };
  
  try {
    await g.start();
  } catch {}
  
  if (!as) continue;
  
  const results = await searcher.search(as, 10);
  allResults.push(...results);
  
  if (i % 5 === 0) {
    console.log(`   Progress: ${i + 1}/${SAMPLES}`);
  }
}

// Sort by score and deduplicate
allResults.sort((a, b) => b.score - a.score);
const uniqueResults = allResults.slice(0, 20);

console.log(`\n📊 Top ${uniqueResults.length} combos found:\n`);

for (let i = 0; i < uniqueResults.length; i++) {
  const r = uniqueResults[i];
  console.log(`--- Combo #${i + 1} (score: ${r.score.toFixed(2)}) ---`);
  console.log(`   Feasibility: ${(r.feasibility * 100).toFixed(1)}%`);
  
  for (let j = 0; j < r.path.length; j++) {
    const action = r.path[j];
    const delta = r.deltas[j];
    const name = getNameSync(action.definitionId) ?? `ID:${action.definitionId}`;
    console.log(`   Step ${j + 1}: ${action.type} - ${name} (id: ${action.definitionId})`);
    if (delta) {
      console.log(`     → damage: ${delta.damageDealt}, dice: ${delta.diceSpent}, turns: ${delta.turnsConsumed}`);
    }
  }
  console.log();
}

const registryEntries = uniqueResults.map((r, idx) => ({
  id: `combo-${idx + 1}`,
  deckContext: { characters: deck.characters, requiredCards: [] },
  preconditions: { phase: "early" as const },
  actionSequence: r.path.map((p, i) => ({
    step: i + 1,
    type: p.type,
    definitionId: p.definitionId,
    isFast: p.isFast,
  })),
  evaluation: {
    totalScore: r.score,
    delta: r.deltas.reduce((acc, d) => ({
      damageDealt: acc.damageDealt + (d?.damageDealt ?? 0),
      reactions: [],
      defeatedCount: acc.defeatedCount + (d?.defeatedCount ?? 0),
      diceSpent: acc.diceSpent + (d?.diceSpent ?? 0),
      diceGained: acc.diceGained + (d?.diceGained ?? 0),
      cardsDrawn: acc.cardsDrawn + (d?.cardsDrawn ?? 0),
      energyDelta: acc.energyDelta + (d?.energyDelta ?? 0),
      entitiesCreated: acc.entitiesCreated + (d?.entitiesCreated ?? 0),
      entitiesRemoved: acc.entitiesRemoved + (d?.entitiesRemoved ?? 0),
      turnsConsumed: acc.turnsConsumed + (d?.turnsConsumed ?? 0),
      opponentWindowsGiven: acc.opponentWindowsGiven + (d?.opponentWindowsGiven ?? 0),
      myActiveChanged: acc.myActiveChanged || (d?.myActiveChanged ?? false),
      oppActiveForced: acc.oppActiveForced || (d?.oppActiveForced ?? false),
      healingDone: acc.healingDone + (d?.healingDone ?? 0),
      myHealthLost: acc.myHealthLost + (d?.myHealthLost ?? 0),
      diceFeasibility: acc.diceFeasibility * (d?.diceFeasibility ?? 1),
      handDependencyTurns: Math.max(acc.handDependencyTurns, d?.handDependencyTurns ?? 0),
    }), {
      damageDealt: 0,
      reactions: [] as any[],
      defeatedCount: 0,
      diceSpent: 0,
      diceGained: 0,
      cardsDrawn: 0,
      energyDelta: 0,
      entitiesCreated: 0,
      entitiesRemoved: 0,
      turnsConsumed: 0,
      opponentWindowsGiven: 0,
      myActiveChanged: false,
      oppActiveForced: false,
      healingDone: 0,
      myHealthLost: 0,
      diceFeasibility: 1,
      handDependencyTurns: 0,
    }),
    scoreBreakdown: {},
    riskFactors: {
      opponentResponseWindows: r.deltas.filter(d => d && d.turnsConsumed > 0).length,
      comboBreakProbability: 0,
      resourceOvercommit: false,
    },
  },
  discoveredBy: "beam-search" as const,
  gameVersion: "6.4.0",
  sampleCount: 1,
  avgWinrateContribution: 0,
}));

const recs = toRecommendations(registryEntries);
console.log(`\n🏆 Recommendations (formatted):\n`);
for (const rec of recs) {
  console.log(`Combo: ${rec.combo_id}`);
  console.log(`  Priority: ${rec.priority}`);
  console.log(`  Total Score: ${rec.evaluation.total_score}`);
  console.log(`  Damage: ${rec.evaluation.damage_dealt}`);
  console.log(`  Dice Efficiency: ${rec.evaluation.dice_efficiency.toFixed(2)}`);
  console.log(`  Turns: ${rec.evaluation.turns_consumed}`);
  console.log(`  Feasibility: ${(rec.evaluation.dice_feasibility * 100).toFixed(1)}%`);
  console.log();
}
