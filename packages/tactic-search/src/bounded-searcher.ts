// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { GameState } from "@gi-tcg/core";
import { flip } from "@gi-tcg/utils";
import { SimAdapter } from "./sim-adapter";
import { StateEvaluator, type ScoreContext } from "./state-evaluator";
import type { ActionInfoWithModification } from "./internal-types";
import type {
  SearchConfig,
  SearchResult,
  StateDelta,
  ActionDescription,
} from "./types";

/**
 * Layer 1: Bounded Searcher
 *
 * Beam search (width 8~15, depth 4~6) with heuristic pruning.
 * Optionally embeds minimax opponent response after combat actions.
 */
export class BoundedSearcher {
  private readonly sim: SimAdapter;
  private readonly eval: StateEvaluator;
  private readonly config: SearchConfig;

  constructor(sim: SimAdapter, evaluator: StateEvaluator, config: SearchConfig) {
    this.sim = sim;
    this.eval = evaluator;
    this.config = config;
  }

  /**
   * Search for the best action paths from the given state.
   * Returns top-K results sorted by score descending.
   */
  async search(
    state: GameState,
    topK?: number,
  ): Promise<SearchResult[]> {
    const k = topK ?? this.config.beamWidth;

    // Initialize beam with root node
    let beam: BeamNode[] = [
      {
        state,
        path: [],
        deltas: [],
        accScore: 0,
        feasibility: 1.0,
      },
    ];

    for (let depth = 0; depth < this.config.maxDepth; depth++) {
      const candidates: BeamNode[] = [];

      for (const node of beam) {
        // Skip terminal states
        if (
          node.state.phase === "gameEnd" ||
          node.state.phase !== "action"
        ) {
          candidates.push(node);
          continue;
        }

        // Only expand from perspective player's turn
        if (node.state.currentTurn !== this.config.perspective) {
          candidates.push(node);
          continue;
        }

        const actions = await this.sim.legalActions(node.state);
        if (actions.length === 0) {
          candidates.push(node);
          continue;
        }

        // Prune and score candidates
        const pruned = this.pruneActions(actions, node.state);

        for (const { action, actionIdx } of pruned) {
          try {
            const result = await this.sim.step(
              node.state,
              actionIdx,
              actions,
            );

            const isFast = action.fast ?? false;

            const delta = this.eval.extractDelta(
              result.exposedMutations,
              this.config.perspective,
              isFast,
              node.state,
            );

            // Add dice cost to delta
            delta.diceSpent = diceCount(action.cost);

            const ctx = this.buildScoreContext(node.state);
            const stepScore = this.eval.score(delta, ctx);

            // If combat action and minimax enabled, compute opponent response
            let minimaxPenalty = 0;
            if (
              !isFast &&
              this.config.enableMinimax &&
              this.config.minimaxDepth > 0
            ) {
              minimaxPenalty = await this.minimaxResponse(
                result.newState,
                1,
              );
            }

            const desc = actionToDescription(action);

            candidates.push({
              state: result.newState,
              path: [...node.path, desc],
              deltas: [...node.deltas, delta],
              accScore: node.accScore + stepScore - minimaxPenalty,
              feasibility: node.feasibility * delta.diceFeasibility,
            });
          } catch {
            // Action failed (e.g., engine error) — skip
          }
        }
      }

      // Keep top beamWidth candidates
      candidates.sort((a, b) => b.accScore - a.accScore);
      beam = candidates.slice(0, this.config.beamWidth);

      // Early termination if no expansion happened
      if (beam.length === 0) break;
    }

    // Return top-K results
    return beam
      .sort((a, b) => b.accScore - a.accScore)
      .slice(0, k)
      .map((node) => ({
        path: node.path,
        stateAfter: node.state,
        score: node.accScore,
        deltas: node.deltas,
        feasibility: node.feasibility,
      }));
  }

  /**
   * Minimax opponent response: search from opponent's perspective
   * and return the best opponent score (our penalty).
   */
  private async minimaxResponse(
    state: GameState,
    depth: number,
  ): Promise<number> {
    if (
      depth <= 0 ||
      state.phase !== "action"
    ) {
      return 0;
    }

    const opp = flip(this.config.perspective);
    if (state.currentTurn !== opp) return 0;

    const actions = await this.sim.legalActions(state);
    if (actions.length === 0) return 0;

    const pruned = this.pruneActions(actions, state);
    let bestOppScore = -Infinity;

    for (const { action, actionIdx } of pruned.slice(
      0,
      Math.min(pruned.length, 5),
    )) {
      try {
        const result = await this.sim.step(state, actionIdx, actions);
        const isFast = action.fast ?? false;
        const delta = this.eval.extractDelta(
          result.exposedMutations,
          opp,
          isFast,
          state,
        );
        const ctx = this.buildScoreContext(state);
        const oppScore = this.eval.score(delta, ctx);

        // Recursively check deeper opponent response
        let deeperScore = 0;
        if (isFast && depth > 1) {
          deeperScore = await this.minimaxResponse(
            result.newState,
            depth - 1,
          );
        }

        bestOppScore = Math.max(bestOppScore, oppScore + deeperScore);
      } catch {
        // Skip failed actions
      }
    }

    return bestOppScore === -Infinity ? 0 : bestOppScore;
  }

  /**
   * Heuristic pruning: filter out obviously bad actions and
   * merge equivalent ones.
   */
  private pruneActions(
    actions: ActionInfoWithModification[],
    state: GameState,
  ): PrunedAction[] {
    const result: PrunedAction[] = [];
    const seenSkills = new Set<number>();
    const seenSwitchTargets = new Set<number>();

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];

      // Skip declareEnd unless it's the only option
      if (a.type === "declareEnd") {
        result.push({ action: a, actionIdx: i });
        continue;
      }

      // Fast actions first (they don't consume turn)
      // Deduplicate equivalent skills
      switch (a.type) {
        case "useSkill": {
          const skillId = a.skill.definition.id;
          if (seenSkills.has(skillId)) continue;
          seenSkills.add(skillId);
          result.push({ action: a, actionIdx: i });
          break;
        }
        case "playCard": {
          // Keep all play card actions (different targets matter)
          result.push({ action: a, actionIdx: i });
          break;
        }
        case "switchActive": {
          const targetId = a.to.definition.id;
          if (seenSwitchTargets.has(targetId)) continue;
          seenSwitchTargets.add(targetId);
          result.push({ action: a, actionIdx: i });
          break;
        }
        case "elementalTuning": {
          // Keep at most one tuning action (first one)
          if (!seenSkills.has(-1)) {
            seenSkills.add(-1);
            result.push({ action: a, actionIdx: i });
          }
          break;
        }
      }
    }

    // Sort: fast actions first, then by estimated value
    result.sort((a, b) => {
      const aFast = a.action.fast ? 0 : 1;
      const bFast = b.action.fast ? 0 : 1;
      if (aFast !== bFast) return aFast - bFast;
      return actionTypePriority(a.action.type) -
        actionTypePriority(b.action.type);
    });

    return result;
  }

  private buildScoreContext(state: GameState): ScoreContext {
    const opp = flip(this.config.perspective);
    const oppPlayer = state.players[opp];
    const oppActiveIdx = oppPlayer.characters.findIndex(
      (c) => c.id === oppPlayer.activeCharacterId,
    );
    const oppActive =
      oppActiveIdx >= 0 ? oppPlayer.characters[oppActiveIdx] : null;

    return {
      oppActiveHealth: oppActive?.variables.health,
      feasibilityAlpha: 1.0,
      handDepBeta: 0.7,
    };
  }
}

// ─── Internal Types ───

interface BeamNode {
  state: GameState;
  path: ActionDescription[];
  deltas: StateDelta[];
  accScore: number;
  feasibility: number;
}

interface PrunedAction {
  action: ActionInfoWithModification;
  actionIdx: number;
}

// ─── Helpers ───

function actionTypePriority(type: string): number {
  switch (type) {
    case "playCard":
      return 0;
    case "useSkill":
      return 1;
    case "switchActive":
      return 2;
    case "elementalTuning":
      return 3;
    case "declareEnd":
      return 10;
    default:
      return 5;
  }
}

function diceCount(
  cost: ReadonlyMap<number, number>,
): number {
  let total = 0;
  for (const [type, count] of cost) {
    // Skip energy and legend costs
    if (type >= 100) continue; // energy/legend have high enum values
    total += count;
  }
  return total;
}

/**
 * Convert an internal ActionInfo to a serializable ActionDescription.
 */
export function actionToDescription(
  action: ActionInfoWithModification,
): ActionDescription {
  switch (action.type) {
    case "useSkill":
      return {
        type: "useSkill",
        definitionId: action.skill.definition.id,
        isFast: action.fast ?? false,
      };
    case "playCard":
      return {
        type: "playCard",
        definitionId: action.skill.caller.definition.id,
        isFast: action.fast ?? false,
      };
    case "switchActive":
      return {
        type: "switchActive",
        definitionId: action.to.definition.id,
        isFast: action.fast ?? false,
      };
    case "elementalTuning":
      return {
        type: "elementalTuning",
        definitionId: action.result ?? 0,
        tuningCardDefinitionId: action.card.definition.id,
        isFast: true,
      };
    case "declareEnd":
      return {
        type: "declareEnd",
        definitionId: 0,
        isFast: false,
      };
    default:
      return {
        type: (action as any).type,
        definitionId: 0,
        isFast: false,
      };
  }
}
