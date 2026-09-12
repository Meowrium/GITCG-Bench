// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { GameState } from "@gi-tcg/core";
import { flip } from "@gi-tcg/utils";
import type {
  ComboEntry,
  ComboAction,
  ComboEvaluation,
  ComboPreconditions,
  ComboQuery,
  SearchResult,
  StateDelta,
} from "./types";

/**
 * Layer 3: Combo Registry
 *
 * Stores discovered high-quality combos, supports deduplication
 * and fast lookup by game state context.
 */
export class ComboRegistry {
  private combos: Map<string, ComboEntry> = new Map();

  /** Number of registered combos */
  get size(): number {
    return this.combos.size;
  }

  /**
   * Register a combo from a search result.
   * Automatically generates ID, extracts preconditions, and deduplicates.
   */
  registerFromSearch(
    result: SearchResult,
    state: GameState,
    who: 0 | 1,
    gameVersion: string,
  ): ComboEntry {
    const actionSeq = result.path.map(
      (desc, i): ComboAction => ({
        step: i + 1,
        type: desc.type,
        definitionId: desc.definitionId,
        isFast: desc.isFast,
      }),
    );

    const combinedDelta = combineDeltaSequence(result.deltas);
    const preconditions = extractPreconditions(state, who);
    const evaluation = buildEvaluation(combinedDelta, result);

    const id = computeComboId(actionSeq);

    // Deduplicate: if same combo already exists, merge
    const existing = this.combos.get(id);
    if (existing) {
      existing.sampleCount++;
      // Keep widest preconditions (least restrictive)
      if (
        preconditions.minDice !== undefined &&
        (existing.preconditions.minDice === undefined ||
          preconditions.minDice < existing.preconditions.minDice)
      ) {
        existing.preconditions.minDice = preconditions.minDice;
      }
      return existing;
    }

    const entry: ComboEntry = {
      id,
      deckContext: {
        characters: extractCharacters(state, who),
        requiredCards: extractRequiredCards(actionSeq, state, who),
      },
      preconditions,
      actionSequence: actionSeq,
      evaluation,
      discoveredBy: "beam-search",
      gameVersion,
      sampleCount: 1,
      avgWinrateContribution: 0,
    };

    this.combos.set(id, entry);
    return entry;
  }

  /**
   * Query combos matching the current game state.
   */
  query(query: ComboQuery): ComboEntry[] {
    const results: ComboEntry[] = [];
    const playerState = query.state.players[query.who];

    for (const combo of this.combos.values()) {
      // Filter by minimum score
      if (
        query.minScore !== undefined &&
        combo.evaluation.totalScore < query.minScore
      ) {
        continue;
      }

      // Filter by required cards
      if (query.mustIncludeCards && query.mustIncludeCards.length > 0) {
        const hasAll = query.mustIncludeCards.every((cardId) =>
          combo.deckContext.requiredCards.includes(cardId),
        );
        if (!hasAll) continue;
      }

      // Check preconditions match current state
      if (!matchesPreconditions(combo.preconditions, query.state, query.who)) {
        continue;
      }

      results.push(combo);
    }

    // Sort by score descending
    results.sort(
      (a, b) => b.evaluation.totalScore - a.evaluation.totalScore,
    );

    return results.slice(0, query.topK);
  }

  /** Get a combo by ID */
  get(id: string): ComboEntry | undefined {
    return this.combos.get(id);
  }

  /** Remove a combo */
  remove(id: string): boolean {
    return this.combos.delete(id);
  }

  /** Export all combos as JSON-serializable array */
  exportAll(): ComboEntry[] {
    return Array.from(this.combos.values());
  }

  /** Import combos from a JSON array */
  importAll(entries: ComboEntry[]): void {
    for (const entry of entries) {
      if (!this.combos.has(entry.id)) {
        this.combos.set(entry.id, entry);
      }
    }
  }

  /** Clear all combos */
  clear(): void {
    this.combos.clear();
  }
}

// ─── Helpers ───

/**
 * Compute a content-hash ID for a combo based on its action sequence.
 */
function computeComboId(actions: ComboAction[]): string {
  const key = actions
    .map((a) => `${a.type}:${a.definitionId}`)
    .join("|");

  // Simple FNV-1a-like hash
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Combine multiple step deltas into an aggregate delta.
 */
function combineDeltaSequence(deltas: StateDelta[]): StateDelta {
  const combined: StateDelta = {
    damageDealt: 0,
    reactions: [],
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
    diceFeasibility: 1.0,
    handDependencyTurns: 0,
  };

  for (const d of deltas) {
    combined.damageDealt += d.damageDealt;
    combined.reactions.push(...d.reactions);
    combined.defeatedCount += d.defeatedCount;
    combined.diceSpent += d.diceSpent;
    combined.diceGained += d.diceGained;
    combined.cardsDrawn += d.cardsDrawn;
    combined.energyDelta += d.energyDelta;
    combined.entitiesCreated += d.entitiesCreated;
    combined.entitiesRemoved += d.entitiesRemoved;
    combined.turnsConsumed += d.turnsConsumed;
    combined.opponentWindowsGiven += d.opponentWindowsGiven;
    combined.myActiveChanged = combined.myActiveChanged || d.myActiveChanged;
    combined.oppActiveForced = combined.oppActiveForced || d.oppActiveForced;
    combined.healingDone += d.healingDone;
    combined.myHealthLost += d.myHealthLost;
    combined.diceFeasibility *= d.diceFeasibility;
    combined.handDependencyTurns = Math.max(
      combined.handDependencyTurns,
      d.handDependencyTurns,
    );
  }

  return combined;
}

/**
 * Extract preconditions from current game state.
 */
function extractPreconditions(
  state: GameState,
  who: 0 | 1,
): ComboPreconditions {
  const player = state.players[who];
  const activeIdx = player.characters.findIndex(
    (c) => c.id === player.activeCharacterId,
  );
  const activeCh = activeIdx >= 0 ? player.characters[activeIdx] : null;

  // Determine phase
  let phase: "early" | "mid" | "late";
  if (state.roundNumber <= 2) {
    phase = "early";
  } else if (state.roundNumber <= 5) {
    phase = "mid";
  } else {
    phase = "late";
  }

  const pre: ComboPreconditions = { phase };

  if (activeCh) {
    pre.myActive = {
      definitionId: activeCh.definition.id,
      minEnergy: activeCh.variables.energy,
    };
  }

  pre.myStandby = player.characters
    .filter((c) => c.variables.alive && c.id !== player.activeCharacterId)
    .map((c) => ({ definitionId: c.definition.id }));

  pre.minDice = player.dice.length;

  // Opponent context
  const opp = state.players[flip(who)];
  const oppActiveIdx = opp.characters.findIndex(
    (c) => c.id === opp.activeCharacterId,
  );
  const oppActive =
    oppActiveIdx >= 0 ? opp.characters[oppActiveIdx] : null;
  if (oppActive) {
    pre.opponentActive = {
      maxHealth: oppActive.variables.health,
    };
  }

  return pre;
}

/**
 * Build evaluation data from combined delta and search result.
 */
function buildEvaluation(
  delta: StateDelta,
  result: SearchResult,
): ComboEvaluation {
  return {
    totalScore: result.score,
    delta,
    scoreBreakdown: {
      damage: delta.damageDealt * 2.0,
      kills: delta.defeatedCount * 15.0,
      reactions: delta.reactions.length * 3.0,
      diceCost: -(delta.diceSpent - delta.diceGained) * 1.5,
      energy: delta.energyDelta * 2.5,
      entities: delta.entitiesCreated * 2.0,
      tempo: -delta.turnsConsumed * 3.0,
      healing: delta.healingDone * 0.8,
    },
    riskFactors: {
      opponentResponseWindows: delta.opponentWindowsGiven,
      comboBreakProbability: estimateBreakProbability(delta),
      resourceOvercommit: delta.diceSpent > 12,
    },
  };
}

/**
 * Rough estimate of combo break probability based on windows given.
 */
function estimateBreakProbability(delta: StateDelta): number {
  // More opponent windows = higher break chance
  const base = delta.opponentWindowsGiven * 0.15;
  return Math.min(base, 0.9);
}

/**
 * Extract character definition IDs from player's team.
 */
function extractCharacters(state: GameState, who: 0 | 1): number[] {
  return state.players[who].characters.map((c) => c.definition.id);
}

/**
 * Extract required card definition IDs referenced in the combo actions.
 */
function extractRequiredCards(
  actions: ComboAction[],
  state: GameState,
  who: 0 | 1,
): number[] {
  const cardIds: number[] = [];
  for (const a of actions) {
    if (a.type === "playCard" || a.type === "elementalTuning") {
      cardIds.push(a.definitionId);
    }
  }
  return [...new Set(cardIds)];
}

/**
 * Check if a combo's preconditions match the current state.
 */
function matchesPreconditions(
  pre: ComboPreconditions,
  state: GameState,
  who: 0 | 1,
): boolean {
  const player = state.players[who];

  // Check active character
  if (pre.myActive) {
    const activeCh = player.characters.find(
      (c) => c.id === player.activeCharacterId,
    );
    if (!activeCh) return false;
    if (activeCh.definition.id !== pre.myActive.definitionId) return false;
    if (
      pre.myActive.minEnergy !== undefined &&
      activeCh.variables.energy < pre.myActive.minEnergy
    ) {
      return false;
    }
  }

  // Check enough dice
  if (pre.minDice !== undefined && player.dice.length < pre.minDice) {
    return false;
  }

  // Check required hand cards
  if (pre.requiredHandCards && pre.requiredHandCards.length > 0) {
    const handDefIds = player.hands.map((h) => h.definition.id);
    for (const required of pre.requiredHandCards) {
      if (!handDefIds.includes(required)) return false;
    }
  }

  return true;
}
