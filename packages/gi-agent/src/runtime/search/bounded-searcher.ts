// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { GameState } from "@gi-tcg/core";
import { flip } from "@gi-tcg/utils";
import { SimAdapter } from "../adapters/sim-adapter.js";
import { StateEvaluator, type ScoreContext } from "../eval-baselines/state-evaluator.js";
import type { ActionInfoWithModification } from "../adapters/internal-types.js";
import type {
  ActionDescription,
  SearchConfig,
  SearchResult,
  StateDelta,
} from "./types.js";

export class BoundedSearcher {
  private readonly sim: SimAdapter;
  private readonly eval: StateEvaluator;
  private config: SearchConfig;

  constructor(sim: SimAdapter, evaluator: StateEvaluator, config: SearchConfig) {
    this.sim = sim;
    this.eval = evaluator;
    this.config = config;
  }

  setExpansionScorer(scorer: ((action: ActionInfoWithModification, actionIdx: number) => number) | undefined): void {
    this.config = { ...this.config, expansionScorer: scorer };
  }

  async search(state: GameState, topK?: number): Promise<SearchResult[]> {
    const k = topK ?? this.config.beamWidth;
    const maxFastActionDepth = this.config.maxFastActionDepth ?? 3;
    const feasibilityFloor = this.config.feasibilityFloor ?? 0.01;
    const maxOppDepth = this.config.maxOpponentDepth ?? 2;
    const crossRound = this.config.crossRoundSearch ?? (this.config.maxDepth >= 5);

    let beam: BeamNode[] = [{
      state,
      path: [],
      deltas: [],
      accScore: 0,
      feasibility: 1,
      fastActionDepth: 0,
      totalDepth: 0,
    }];

    for (let depth = 0; depth < this.config.maxDepth; depth++) {
      const candidates: BeamNode[] = [];

      for (const node of beam) {
        if (node.state.phase === "gameEnd") {
          candidates.push(node);
          continue;
        }

        // ── Opponent's turn ──
        if (node.state.phase === "action" && node.state.currentTurn !== this.config.perspective) {
          // Only do deep opponent simulation when we've declared end
          // (round boundary crossing — need to see what opponent does with remaining actions)
          const lastAction = node.path.length > 0 ? node.path[node.path.length - 1] : null;
          const justDeclaredEnd = lastAction?.type === "declareEnd";

          if (maxOppDepth > 0 && justDeclaredEnd && crossRound) {
            // Deep simulate opponent's remaining T1 + T2 first move
            const oppResults = await this.simulateOpponentTurn(node, maxOppDepth, feasibilityFloor);
            for (const r of oppResults) {
              r.totalDepth = node.totalDepth + 1;
              candidates.push(r);
            }
          } else if (maxOppDepth > 0) {
            // Light opponent simulation: just 1 step, no beam branching
            const oppResults = await this.simulateOpponentTurnLight(node, feasibilityFloor);
            for (const r of oppResults) {
              r.totalDepth = node.totalDepth + 1;
              candidates.push(r);
            }
          } else {
            candidates.push(node);
          }
          continue;
        }

        // ── Non-action phases: advance to action ──
        if (node.state.phase !== "action") {
          if (crossRound) {
            // Game is between rounds or in setup. Try to advance.
            // We can't directly step here; just pass through and hope
            // the next state is actionable.
            candidates.push(node);
          } else {
            candidates.push(node);
          }
          continue;
        }

        // ── My turn: expand actions normally ──
        const actions = await this.sim.legalActions(node.state);
        if (actions.length === 0) {
          candidates.push(node);
          continue;
        }

        const pruned = this.pruneActions(actions);
        const scoredActions = this.scoreActionsForExpansion(state, pruned);

        const expansionLimit = this.config.expansionPolicy === "policy_guided"
          ? Math.min(scoredActions.length, this.config.expansionTopK ?? 5)
          : scoredActions.length;

        for (const { action, actionIdx } of scoredActions.slice(0, expansionLimit)) {
          try {
            const result = await this.sim.step(node.state, actionIdx, actions);
            const isFast = action.fast ?? false;
            const delta = this.eval.extractDelta(
              result.exposedMutations,
              this.config.perspective,
              isFast,
            );
            delta.diceSpent = diceCount(action.cost);

            const ctx = this.buildScoreContext(node.state);
            const stepScore = this.eval.score(delta, ctx);

            // ── Minimax: simulate opponent's immediate response ──
            let minimaxPenalty = 0;
            const nextFastDepth = isFast ? node.fastActionDepth + 1 : 0;
            const shouldMinimax = !isFast
              && this.config.enableMinimax
              && this.config.minimaxDepth > 0;
            if (shouldMinimax) {
              minimaxPenalty = await this.minimaxResponse(result.newState, 1, feasibilityFloor);
            }

            const newFeasibility = node.feasibility * delta.diceFeasibility;
            if (newFeasibility < feasibilityFloor) continue;

            let leafValueBonus = 0;
            if (depth === this.config.maxDepth - 1 && this.config.valueFunction) {
              leafValueBonus = this.config.valueFunction(result.newState);
            }

            // ── Initiative-steal bonus for declareEnd + fast followup ──
            let initiativeBonus = 0;
            if (action.type === "declareEnd" && crossRound) {
              // Check if we have a fast-switch capable character (e.g., Mona)
              const myChars = result.newState.players[this.config.perspective].characters;
              const hasFastSwitch = myChars.some(c => {
                // Check for abilities that make switch fast
                const statuses = c.entities.filter(e => e.definition.tags?.some(t => String(t) === "fastSwitch"));
                return statuses.length > 0;
              });
              if (hasFastSwitch) {
                initiativeBonus = 2.0; // Reward ending turn when we can fast-switch next
              }
            }

            // ── Cross-round fast-action bonus ──
            let crossRoundBonus = 0;
            if (crossRound && isFast && node.totalDepth > 3) {
              // Fast actions deep in the search tree = likely initiative-steal
              crossRoundBonus = 1.5;
            }

            candidates.push({
              state: result.newState,
              path: [...node.path, actionToDescription(action)],
              deltas: [...node.deltas, delta],
              accScore: node.accScore + stepScore - minimaxPenalty + leafValueBonus + initiativeBonus + crossRoundBonus,
              feasibility: newFeasibility,
              fastActionDepth: nextFastDepth,
              totalDepth: node.totalDepth + 1,
            });
          } catch {
            // skip failed actions
          }
        }
      }

      candidates.sort((a, b) => b.accScore - a.accScore);
      beam = candidates.slice(0, this.config.beamWidth);
      if (beam.length === 0) break;

      // Fast-action extension at this depth
      const fastOnlyBeam = await this.extendFastActions(beam, maxFastActionDepth, feasibilityFloor);
      beam = fastOnlyBeam;
    }

    // ── Post-processing: cross-round initiative detection ──
    if (crossRound) {
      beam = await this.expandCrossRoundInitiative(beam, feasibilityFloor);
    }

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
   * Simulate opponent's turn: expand opponent actions using minimax-style evaluation.
   * Returns multiple possible futures (beam of opponent responses).
   */
  private async simulateOpponentTurn(
    node: BeamNode,
    maxSteps: number,
    feasibilityFloor: number,
  ): Promise<BeamNode[]> {
    let current = [node];
    const opp = flip(this.config.perspective);

    for (let step = 0; step < maxSteps; step++) {
      const next: BeamNode[] = [];

      for (const n of current) {
        if (n.state.phase !== "action" || n.state.currentTurn !== opp) {
          next.push(n);
          continue;
        }

        const actions = await this.sim.legalActions(n.state);
        if (actions.length === 0) { next.push(n); continue; }

        const pruned = this.pruneActions(actions);
        // Limit opponent branching
        const topActions = pruned.slice(0, Math.min(pruned.length, 3));

        for (const { action, actionIdx } of topActions) {
          try {
            const result = await this.sim.step(n.state, actionIdx, actions);
            const delta = this.eval.extractDelta(result.exposedMutations, opp, action.fast ?? false);
            delta.diceSpent = diceCount(action.cost);

            const ctx = this.buildScoreContext(n.state);
            const oppScore = this.eval.score(delta, ctx);
            // Opponent's gain = our penalty
            const pathDesc = actionToDescription(action);

            next.push({
              state: result.newState,
              path: [...n.path, pathDesc],
              deltas: [...n.deltas],
              accScore: n.accScore - oppScore * 0.5,
              feasibility: n.feasibility * delta.diceFeasibility,
              fastActionDepth: (action.fast ?? false) ? n.fastActionDepth + 1 : 0,
              totalDepth: n.totalDepth + 1,
            });
          } catch { /* skip */ }
        }

        // Always include "opponent stopped" as a possibility
        if (n.state.phase !== "action" || n.state.currentTurn !== opp) {
          next.push(n);
        }
      }

      current = next;
      if (current.length === 0) break;

      // Deduplicate + keep top
      current.sort((a, b) => b.accScore - a.accScore);
      current = current.slice(0, this.config.beamWidth);
    }

    return current;
  }

  /**
   * Light opponent simulation: single-step, single-action (no beam branching).
   * Used for non-declareEnd opponent turns.
   */
  private async simulateOpponentTurnLight(
    node: BeamNode,
    feasibilityFloor: number,
  ): Promise<BeamNode[]> {
    if (node.state.phase !== "action") return [node];
    const opp = flip(this.config.perspective);
    if (node.state.currentTurn !== opp) return [node];

    const actions = await this.sim.legalActions(node.state);
    if (actions.length === 0) return [node];

    const pruned = this.pruneActions(actions);
    const results: BeamNode[] = [];

    // Simulate top-2 opponent actions only
    for (const { action, actionIdx } of pruned.slice(0, 2)) {
      try {
        const result = await this.sim.step(node.state, actionIdx, actions);
        const delta = this.eval.extractDelta(result.exposedMutations, opp, action.fast ?? false);
        delta.diceSpent = diceCount(action.cost);

        const ctx = this.buildScoreContext(node.state);
        const oppScore = this.eval.score(delta, ctx);

        results.push({
          state: result.newState,
          path: [...node.path, actionToDescription(action)],
          deltas: [...node.deltas],
          accScore: node.accScore - oppScore * 0.3,
          feasibility: node.feasibility * delta.diceFeasibility,
          fastActionDepth: (action.fast ?? false) ? node.fastActionDepth + 1 : 0,
          totalDepth: node.totalDepth + 1,
        });
      } catch { /* skip */ }
    }

    // Always include the "opponent passed" option
    results.push(node);
    return results;
  }

  /**
   * Post-processing: for nodes where the opponent just moved, check if we have
   * fast-action initiative (e.g., Mona passive fast-switch → Wanderer E → diffusion).
   */
  private async expandCrossRoundInitiative(
    beam: BeamNode[],
    feasibilityFloor: number,
  ): Promise<BeamNode[]> {
    const extended: BeamNode[] = [...beam];

    for (const node of beam) {
      // Skip if not in action phase or not our turn
      if (node.state.phase !== "action") continue;
      if (node.state.currentTurn !== this.config.perspective) continue;

      const actions = await this.sim.legalActions(node.state);
      if (actions.length === 0) continue;

      // Only expand fast actions as initiative followup
      const fastActions = actions
        .map((a, idx) => ({ action: a, actionIdx: idx }))
        .filter(({ action }) => action.fast === true);

      for (const { action, actionIdx } of fastActions.slice(0, 2)) {
        try {
          const result = await this.sim.step(node.state, actionIdx, actions);
          const delta = this.eval.extractDelta(result.exposedMutations, this.config.perspective, true);
          delta.diceSpent = diceCount(action.cost);

          if (delta.diceFeasibility < feasibilityFloor) continue;

          const ctx = this.buildScoreContext(node.state);
          const stepScore = this.eval.score(delta, ctx);
          // Bonus for successful initiative steal
          const initiativeBonus = 3.0;

          extended.push({
            state: result.newState,
            path: [...node.path, actionToDescription(action)],
            deltas: [...node.deltas, delta],
            accScore: node.accScore + stepScore + initiativeBonus,
            feasibility: node.feasibility * delta.diceFeasibility,
            fastActionDepth: node.fastActionDepth + 1,
            totalDepth: node.totalDepth + 1,
          });
        } catch { /* skip */ }
      }
    }

    extended.sort((a, b) => b.accScore - a.accScore);
    return extended.slice(0, this.config.beamWidth);
  }

  private async extendFastActions(
    beam: BeamNode[],
    maxFastActionDepth: number,
    feasibilityFloor: number,
  ): Promise<BeamNode[]> {
    const extended: BeamNode[] = [];

    for (const node of beam) {
      if (node.fastActionDepth >= maxFastActionDepth) {
        extended.push(node);
        continue;
      }
      if (node.state.phase !== "action") {
        extended.push(node);
        continue;
      }
      if (node.state.currentTurn !== this.config.perspective) {
        extended.push(node);
        continue;
      }

      const actions = await this.sim.legalActions(node.state);
      if (actions.length === 0) {
        extended.push(node);
        continue;
      }

      const fastActions = actions
        .map((a, idx) => ({ action: a, actionIdx: idx }))
        .filter(({ action }) => action.fast === true);

      if (fastActions.length === 0) {
        extended.push(node);
        continue;
      }

      const pruned = this.pruneActions(fastActions.map(({ action }) => action) as ActionInfoWithModification[])
        .map((p) => ({
          action: p.action,
          actionIdx: (fastActions.find(f => f.action === p.action))?.actionIdx ?? p.actionIdx,
        }));

      for (const { action, actionIdx } of pruned) {
        try {
          const result = await this.sim.step(node.state, actionIdx, actions);
          const delta = this.eval.extractDelta(result.exposedMutations, this.config.perspective, true);
          delta.diceSpent = diceCount(action.cost);

          const ctx = this.buildScoreContext(node.state);
          const stepScore = this.eval.score(delta, ctx);
          const newFeasibility = node.feasibility * delta.diceFeasibility;
          if (newFeasibility < feasibilityFloor) continue;

          extended.push({
            state: result.newState,
            path: [...node.path, actionToDescription(action)],
            deltas: [...node.deltas, delta],
            accScore: node.accScore + stepScore,
            feasibility: newFeasibility,
            fastActionDepth: node.fastActionDepth + 1,
            totalDepth: node.totalDepth + 1,
          });
        } catch { /* skip */ }
      }

      extended.push(node);
    }

    extended.sort((a, b) => b.accScore - a.accScore);
    return extended.slice(0, this.config.beamWidth);
  }

  private scoreActionsForExpansion(
    _rootState: GameState,
    actions: PrunedAction[],
  ): PrunedAction[] {
    if (this.config.expansionPolicy !== "policy_guided") return actions;
    const scorer = this.config.expansionScorer ?? expansionActionHeuristicScore;
    return [...actions].sort((a, b) => {
      const aScore = scorer(a.action, a.actionIdx);
      const bScore = scorer(b.action, b.actionIdx);
      return bScore - aScore;
    });
  }

  private async minimaxResponse(
    state: GameState,
    depth: number,
    feasibilityFloor: number,
  ): Promise<number> {
    if (depth <= 0 || state.phase !== "action") return 0;
    const opp = flip(this.config.perspective);
    if (state.currentTurn !== opp) return 0;

    const actions = await this.sim.legalActions(state);
    if (actions.length === 0) return 0;

    const pruned = this.pruneActions(actions);
    let bestOppScore = -Infinity;

    for (const { action, actionIdx } of pruned.slice(0, Math.min(pruned.length, 5))) {
      try {
        const result = await this.sim.step(state, actionIdx, actions);
        const isFast = action.fast ?? false;
        const delta = this.eval.extractDelta(result.exposedMutations, opp, isFast);
        const ctx = this.buildScoreContext(state);
        const oppScore = this.eval.score(delta, ctx);

        if (delta.diceFeasibility < feasibilityFloor) continue;

        let deeperScore = 0;
        if (isFast && depth > 1) {
          deeperScore = await this.minimaxResponse(result.newState, depth - 1, feasibilityFloor);
        }

        bestOppScore = Math.max(bestOppScore, oppScore + deeperScore);
      } catch { /* skip failed actions */ }
    }

    return bestOppScore === -Infinity ? 0 : bestOppScore;
  }

  private pruneActions(actions: ActionInfoWithModification[]): PrunedAction[] {
    const result: PrunedAction[] = [];
    const seenSkills = new Set<number>();
    const seenSwitchTargets = new Set<number>();

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.type === "declareEnd") {
        result.push({ action: a, actionIdx: i });
        continue;
      }

      switch (a.type) {
        case "useSkill": {
          const skillId = a.skill.definition.id;
          if (seenSkills.has(skillId)) continue;
          seenSkills.add(skillId);
          result.push({ action: a, actionIdx: i });
          break;
        }
        case "playCard":
          result.push({ action: a, actionIdx: i });
          break;
        case "switchActive": {
          const targetId = a.to.definition.id;
          if (seenSwitchTargets.has(targetId)) continue;
          seenSwitchTargets.add(targetId);
          result.push({ action: a, actionIdx: i });
          break;
        }
        case "elementalTuning":
          if (!seenSkills.has(-1)) {
            seenSkills.add(-1);
            result.push({ action: a, actionIdx: i });
          }
          break;
      }
    }

    result.sort((a, b) => {
      const aFast = a.action.fast ? 0 : 1;
      const bFast = b.action.fast ? 0 : 1;
      if (aFast !== bFast) return aFast - bFast;
      return actionTypePriority(a.action.type) - actionTypePriority(b.action.type);
    });
    return result;
  }

  private buildScoreContext(state: GameState): ScoreContext {
    const opp = flip(this.config.perspective);
    const oppPlayer = state.players[opp];
    const oppActiveIdx = oppPlayer.characters.findIndex((c) => c.id === oppPlayer.activeCharacterId);
    const oppActive = oppActiveIdx >= 0 ? oppPlayer.characters[oppActiveIdx] : null;
    return {
      oppActiveHealth: oppActive?.variables.health,
      feasibilityAlpha: 1,
      handDepBeta: 0.7,
    };
  }
}

interface BeamNode {
  state: GameState;
  path: ActionDescription[];
  deltas: StateDelta[];
  accScore: number;
  feasibility: number;
  fastActionDepth: number;
  totalDepth: number;  // total steps simulated (across both sides)
}

interface PrunedAction {
  action: ActionInfoWithModification;
  actionIdx: number;
}

function actionTypePriority(type: string): number {
  switch (type) {
    case "playCard": return 0;
    case "useSkill": return 1;
    case "switchActive": return 2;
    case "elementalTuning": return 3;
    case "declareEnd": return 10;
    default: return 5;
  }
}

export function expansionActionHeuristicScore(action: ActionInfoWithModification, _actionIdx: number): number {
  let score = 0;
  if (action.fast) score += 5;
  switch (action.type) {
    case "useSkill": score += 4; break;
    case "playCard": score += 3; break;
    case "switchActive": score += 1; break;
    case "elementalTuning": score -= 2; break;
    case "declareEnd": score -= 10; break;
  }
  return score;
}

function diceCount(cost: ReadonlyMap<number, number>): number {
  let total = 0;
  for (const [type, count] of cost) {
    if (type >= 100) continue;
    total += count;
  }
  return total;
}

export function actionToDescription(action: ActionInfoWithModification): ActionDescription {
  switch (action.type) {
    case "useSkill":
      return { type: "useSkill", definitionId: action.skill.definition.id, isFast: action.fast ?? false };
    case "playCard":
      return { type: "playCard", definitionId: action.skill.caller.definition.id, isFast: action.fast ?? false };
    case "switchActive":
      return { type: "switchActive", definitionId: action.to.definition.id, isFast: action.fast ?? false };
    case "elementalTuning":
      return { type: "elementalTuning", definitionId: action.result ?? 0, tuningCardDefinitionId: action.card.definition.id, isFast: true };
    case "declareEnd":
      return { type: "declareEnd", definitionId: 0, isFast: false };
    default:
      return { type: (action as { type: ActionDescription["type"] }).type, definitionId: 0, isFast: false };
  }
}
